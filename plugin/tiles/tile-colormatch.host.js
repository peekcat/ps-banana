// ============================================================
//  tile-colormatch.host.js —— Dock 校色按钮后端 (v2)
//  Gemini 回图偏色的本地补救: 选中 AI 回图图层 → 点 Dock 校色按钮 →
//  查回传台账找到原图缓存 → 发给前端(webview)算 → 结果作为新图层贴回。
//
//  v2 流程(用户拍板):
//  · 校色 = 任务磁贴里的一条任务(colormatchTaskStarted → taskProgress → taskComplete)
//  · 先把所有张全部算完, 再一次性贴回
//  · 跟随自动传回开关(Dock 按钮把 output.autoReturn 传进来):
//      开 → 算完直接贴回; 关/贴回失败 → 存 g_taskResultCache 转"待返回"卡片,
//      任务磁贴点 ✓ 走 returnTaskResult(tile-tasks.host.js 里有 colormatch 分支)
//  · 贴回 = 贴到对应 AI 图层正上方 + 改名 + 剪贴蒙版(向下嵌入) + 补羽化
//
//  算法本体在 tiles/tile-colormatch.js(webview 侧), Dock 按钮在 core/dock.js。
//  抗截断说明: 缓存里 input/output 同为色相偏移态(抓图时就偏移了),
//  比对一致; 贴回按台账里的 antiMode 走原通道, 自动转回正常色。
// ============================================================

var HostAPI = require('../host/host-api.js');
var PlacementLedger = require('../host/placement-ledger.js');
var PsPixels = require('../host/ps-pixels.js');
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;
var constants = photoshop.constants;
var uxpFormats = require('uxp').storage.formats;

var COMPUTE_TIMEOUT_MS = 120000;   // 前端计算超时(4K 实测 1~3 秒, 留足余量)

var _running = false;
var _pending = {};   // jobId -> {resolve, reject, timer}
var _jobSeq = 0;

// quiet=true 只进日志面板不弹 toast(避免多张图刷屏)
function _status(ctx, text, level, quiet) {
    ctx.logToPanel('[校色] ' + text, (level === 'error' || level === 'warn') ? level : 'info');
    if (!quiet) ctx.sendToPanel('colormatchStatus', { text: text, level: level || 'info' });
}

function _pad3(n) { return ('000' + (Number(n) || 1)).slice(-3); }

async function _readCacheImage(ctx, runFolderName, kind, idx) {
    var cacheFolder = await ctx.getOrCreateImageCacheFolder();
    // runFolderName 老平铺是一段名, 新结构是 "项目/叶子" 两级路径 — 按段行走两种都认
    var runFolder = await PlacementLedger.getRunFolderByPath(cacheFolder, runFolderName);
    var file = await runFolder.getEntry(kind + '_' + _pad3(idx) + '.png');
    var buf = await file.read({ format: uxpFormats.binary });
    return PsPixels.arrayBufferToBase64(buf);
}

// 发给 webview 计算, 等 colormatchResult 回来
function _computeInPanel(ctx, method, inputB64, outputB64) {
    return new Promise(function(resolve, reject) {
        var jobId = 'cmjob_' + (++_jobSeq) + '_' + Date.now();
        _pending[jobId] = {
            resolve: resolve,
            reject: reject,
            timer: setTimeout(function() {
                if (_pending[jobId]) {
                    delete _pending[jobId];
                    reject(new Error('前端计算超时(120秒)'));
                }
            }, COMPUTE_TIMEOUT_MS)
        };
        ctx.sendToPanel('colormatchCompute', { jobId: jobId, method: method, inputB64: inputB64, outputB64: outputB64 });
    });
}

// webview 算完回传
HostAPI.registerAction('colormatchResult', async function(data) {
    var jobId = data && data.jobId;
    var p = jobId && _pending[jobId];
    if (!p) return;   // 超时已清理/重复回传, 忽略
    delete _pending[jobId];
    clearTimeout(p.timer);
    if (data.ok && data.base64) p.resolve(data.base64);
    else p.reject(new Error(data.error || '前端计算失败'));
});

// 递归按 id 找图层(组内也找)
function _findLayerById(container, id) {
    var layers = container.layers || [];
    for (var i = 0; i < layers.length; i++) {
        if (layers[i].id === id) return layers[i];
        if (layers[i].layers && layers[i].layers.length) {
            var hit = _findLayerById(layers[i], id);
            if (hit) return hit;
        }
    }
    return null;
}

// ============================================================
//  统一贴回一批校色结果 —— 自动传回和手动传回(returnTaskResult)共用
//  items: [{b64, targetLayerId, targetName, selection, antiMode,
//           layerType, featherKey, outputIdx}]
//  返回 { placed, leftovers: [没贴成功的 item] }
// ============================================================
async function placeColormatchItems(ctx, docId, methodName, items) {
    var placed = 0, leftovers = [];
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        try {
            await (function(item) {
                return ctx.acquirePSLock(async function() {
                    var newLayerId = await ctx.placeImageToSpecificDoc(
                        item.b64, docId, item.selection || null, item.antiMode || 0, item.layerType || 'smartObject');
                    if (!newLayerId) throw new Error('贴回失败');
                    await core.executeAsModal(async function() {
                        var doc = app.documents.find(function(d) { return d.id === docId; }) || app.activeDocument;
                        var newLayer = _findLayerById(doc, newLayerId);
                        var target = item.targetLayerId ? _findLayerById(doc, item.targetLayerId) : null;
                        if (!newLayer) return;
                        try { newLayer.name = methodName + '·' + (item.targetName || ('输出' + (item.outputIdx || 1))); } catch (eN) {}
                        // 挪到目标图层正上方(目标在组内就跟着进组)
                        var moved = false;
                        if (target) {
                            try { newLayer.move(target, constants.ElementPlacement.PLACEBEFORE); moved = true; } catch (eM) {}
                        }
                        // 向下嵌入(剪贴蒙版): 只在确实贴在目标正上方时做, 防止嵌错对象
                        if (moved) {
                            try {
                                await app.batchPlay([
                                    { _obj: "select", _target: [{ _ref: "layer", _id: newLayerId }], makeVisible: false },
                                    { _obj: "groupEvent", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }
                                ], {});
                            } catch (eClip) {}
                        }
                    }, { commandName: '校色图层就位' });
                    // 补上和原贴回一致的边缘羽化(函数内部自己判断该工作流开没开羽化)
                    if (item.selection && item.featherKey) {
                        try { await ctx.applyReturnFeatherMaskToLayer(docId, newLayerId, item.selection, item.featherKey); } catch (eF) {}
                    }
                }, 'colormatch');
            })(it);
            placed++;
        } catch (ePlace) {
            leftovers.push(it);
            _status(ctx, '贴回失败(' + (it.targetName || ('第' + (i + 1) + '张')) + '): ' + ((ePlace && ePlace.message) || ePlace), 'warn', true);
        }
    }
    return { placed: placed, leftovers: leftovers };
}

// 转"待返回": 存进任务结果缓存, 任务磁贴的 ✓ 按钮会来取
function _stashForManualReturn(ctx, taskId, docId, methodName, items) {
    ctx.g_taskResultCache[taskId] = {
        colormatch: { methodName: methodName, items: items },
        originDocId: docId,
        // payloads 仅作"缓存非空"的兼容字段, 实际贴回走 returnTaskResult 的 colormatch 分支
        payloads: items.map(function(it) { return it.b64; })
    };
}

// ============================================================
//  主入口 —— Dock 按钮
// ============================================================
HostAPI.registerAction('colorMatchRun', async function(data, ctx) {
    var method = (data && data.method) === 'reinhard' ? 'reinhard' : 'wavelet';
    var methodName = (method === 'wavelet') ? '精准校色' : '整体校色';
    var autoReturn = !(data && data.autoReturn === false);   // Dock 把自动传回开关值捎过来

    if (_running) { _status(ctx, '上一次校色还没跑完, 稍等再点', 'warn'); return; }
    _running = true;
    try {
        var doc = app.activeDocument;
        if (!doc) { _status(ctx, '没有打开的文档', 'error'); return; }

        // --- 1. 选中图层, 组展开一层 ---
        var selected = doc.activeLayers || [];
        var candidates = [];
        for (var i = 0; i < selected.length; i++) {
            var l = selected[i];
            if (l.layers && l.layers.length) {
                for (var c = 0; c < l.layers.length; c++) candidates.push(l.layers[c]);
            } else {
                candidates.push(l);
            }
        }
        if (!candidates.length) {
            _status(ctx, '请先在图层面板选中 AI 回图图层(或它所在的组)', 'error');
            return;
        }

        // --- 2. 查台账 ---
        var jobs = [], skipped = 0;
        for (var j = 0; j < candidates.length; j++) {
            var entry = null;
            try { entry = await PlacementLedger.findByLayer(doc.id, doc.name, candidates[j].id); } catch (eFind) {}
            if (entry && entry.runFolderName) jobs.push({ layer: candidates[j], entry: entry });
            else skipped++;
        }
        if (!jobs.length) {
            // 排障日志: 到底选了哪些图层、账本里现在有什么 —— 用户报错时让作者能远程定位
            try {
                var _ids = [];
                for (var _d = 0; _d < candidates.length; _d++) _ids.push(candidates[_d].id + '(' + (candidates[_d].name || '?') + ')');
                var _st = PlacementLedger.debugStats();
                ctx.logToPanel('[校色排障] 当前文档 doc' + doc.id + ' | 选中图层: ' + _ids.join(', ')
                    + ' | 账本共 ' + _st.count + ' 条, 最近: ' + (_st.tail.join(' | ') || '(空)'), 'warn');
            } catch (eDbg) {}
            _status(ctx, '选中的图层查不到原图缓存(目前支持主生成的回图)。请选中 AI 回图图层或它所在的组再点', 'error');
            return;
        }

        // --- 3. 任务磁贴出卡片(前端 tile-colormatch.js 收到后建卡) ---
        var taskId = 'cm_' + Date.now();
        ctx.sendToPanel('colormatchTaskStarted', {
            taskId: taskId, count: jobs.length, methodName: methodName, autoReturn: autoReturn
        });
        // 生成中心: 手动校色没有 genTaskId, 但知道图层 id → 气泡按 layerID 定位加呼吸动画
        var _cmLayerIds = jobs.map(function(jb) { return jb.layer.id; });
        ctx.sendToPanel('colormatchPhase', { taskId: taskId, layerIDs: _cmLayerIds, phase: 'start', total: jobs.length });
        _status(ctx, methodName + ': 共 ' + jobs.length + ' 张开始计算' + (skipped ? ' (跳过 ' + skipped + ' 个非生成图层)' : ''), 'info', true);

        // --- 4. 先把所有张全部算完 ---
        var items = [], failCount = 0;
        for (var k = 0; k < jobs.length; k++) {
            var job = jobs[k];
            var e = job.entry;
            var tag = '第 ' + (k + 1) + '/' + jobs.length + ' 张';
            try {
                _status(ctx, tag + ': 读取缓存 ' + e.runFolderName, 'info', true);
                var inputB64 = await _readCacheImage(ctx, e.runFolderName, 'input', e.inputIdx || 1);
                var outputB64 = await _readCacheImage(ctx, e.runFolderName, 'output', e.outputIdx || 1);
                _status(ctx, tag + ': 计算中...', 'info', true);
                var correctedB64 = await _computeInPanel(ctx, method, inputB64, outputB64);
                items.push({
                    b64: correctedB64,
                    targetLayerId: job.layer.id,
                    targetName: job.layer.name || '',
                    selection: e.selection || null,
                    antiMode: e.antiMode || 0,
                    layerType: e.layerType || 'smartObject',
                    featherKey: e.featherKey || '',
                    outputIdx: e.outputIdx || 1
                });
                ctx.sendToPanel('taskProgress', { taskId: taskId, total: jobs.length, status: 'success' });
            } catch (eJob) {
                failCount++;
                ctx.sendToPanel('taskProgress', { taskId: taskId, total: jobs.length, status: 'fail' });
                _status(ctx, tag + ' 计算失败: ' + ((eJob && eJob.message) || eJob), 'warn');
            }
            ctx.sendToPanel('colormatchPhase', { taskId: taskId, layerIDs: _cmLayerIds, phase: 'progress', done: k + 1, total: jobs.length });
        }
        ctx.sendToPanel('colormatchPhase', { taskId: taskId, layerIDs: _cmLayerIds, phase: 'done' });

        // --- 5. 一次性传回 / 转待返回 ---
        var cached = false, placedCount = 0;
        if (items.length) {
            if (autoReturn) {
                var res = await placeColormatchItems(ctx, doc.id, methodName, items);
                placedCount = res.placed;
                if (res.leftovers.length) {
                    _stashForManualReturn(ctx, taskId, doc.id, methodName, res.leftovers);
                    cached = true;
                }
            } else {
                _stashForManualReturn(ctx, taskId, doc.id, methodName, items);
            }
        }

        // --- 6. 收卡 + 汇总 ---
        ctx.sendToPanel('taskComplete', { taskId: taskId, successCount: items.length, failCount: failCount, cached: cached });
        var summary;
        if (!items.length) {
            summary = methodName + '失败: ' + failCount + ' 张全部计算失败';
        } else if (!autoReturn) {
            summary = methodName + '完成: ' + items.length + ' 张已算好, 在任务磁贴点 ✓ 传回';
        } else if (cached) {
            summary = methodName + ': 已传回 ' + placedCount + ' 张, ' + (items.length - placedCount) + ' 张 PS 正忙没贴上, 在任务磁贴点 ✓ 重试';
        } else {
            summary = methodName + '完成: ' + placedCount + ' 张已传回'
                + (failCount ? ', ' + failCount + ' 张计算失败' : '')
                + (skipped ? ', 跳过 ' + skipped + ' 个' : '');
        }
        _status(ctx, summary, items.length ? 'success' : 'error');
    } catch (eTop) {
        _status(ctx, '校色出错: ' + ((eTop && eTop.message) || eTop), 'error');
    } finally {
        _running = false;
    }
});

// ============================================================
//  自动校色 —— 生成流程(tile-run.host.js)在传回前调用
//  输入: 抓图原图 + 全部回图payload; 输出: 校色后的payload数组(等长)。
//  · 自己在任务磁贴开一张"自动校色"任务卡(colormatchTaskStarted → 进度 → 完成)
//  · 固定精准算法(wavelet); 某张失败 → 该张原样返回(传原图), 不拖累别人
//  · 不做剪贴蒙版/挪位 —— 校色版就是要贴的图本身, 走生成的正常贴回流程
// ============================================================
var _autoSeq = 0;
async function autoColormatchAll(ctx, opts) {
    var inputB64 = opts && opts.inputB64;
    var payloads = (opts && opts.payloads) || [];
    var out = payloads.slice();   // 兜底: 默认原图, 校成一张换一张
    var correctedCount = 0, failCount = 0;
    if (!inputB64 || !payloads.length) return { payloads: out, correctedCount: 0, failCount: 0 };

    var cmTaskId = 'cmauto_' + Date.now() + '_' + (++_autoSeq);
    // autoReturn:true → 任务卡完成后不会生成"待返回"卡(贴回由生成流程接着做)
    ctx.sendToPanel('colormatchTaskStarted', {
        taskId: cmTaskId, count: payloads.length, methodName: '自动校色', autoReturn: true
    });
    // 生成中心: 通知气泡进入"校色中"状态(缩略图加呼吸动画), 带主任务id供气泡定位
    if (opts && opts.genTaskId) {
        ctx.sendToPanel('colormatchPhase', { taskId: cmTaskId, genTaskId: opts.genTaskId, phase: 'start', total: payloads.length });
    }
    ctx.logToPanel('[自动校色] 开始, 共 ' + payloads.length + ' 张 (精准算法)', 'info');

    for (var i = 0; i < payloads.length; i++) {
        try {
            out[i] = await _computeInPanel(ctx, 'wavelet', inputB64, payloads[i]);
            correctedCount++;
            ctx.sendToPanel('taskProgress', { taskId: cmTaskId, total: payloads.length, status: 'success' });
        } catch (eAuto) {
            failCount++;   // out[i] 保持原图
            ctx.sendToPanel('taskProgress', { taskId: cmTaskId, total: payloads.length, status: 'fail' });
            ctx.logToPanel('[自动校色] 第 ' + (i + 1) + ' 张失败, 该张传原图: ' + ((eAuto && eAuto.message) || eAuto), 'warn');
        }
        if (opts && opts.genTaskId) {
            ctx.sendToPanel('colormatchPhase', { taskId: cmTaskId, genTaskId: opts.genTaskId, phase: 'progress', done: i + 1, total: payloads.length });
        }
    }
    if (opts && opts.genTaskId) {
        ctx.sendToPanel('colormatchPhase', { taskId: cmTaskId, genTaskId: opts.genTaskId, phase: 'done' });
    }
    ctx.sendToPanel('taskComplete', { taskId: cmTaskId, successCount: correctedCount, failCount: failCount, cached: false });
    return { payloads: out, correctedCount: correctedCount, failCount: failCount };
}

// 给 tile-tasks.host.js(手动传回校色任务) / tile-run.host.js(自动校色) 用
module.exports = {
    placeColormatchItems: placeColormatchItems,
    autoColormatchAll: autoColormatchAll
};
