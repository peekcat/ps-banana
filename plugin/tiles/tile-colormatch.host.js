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

async function _readCacheImage(ctx, runFolderName, kind, idx, isAlign) {
    var cacheFolder = await ctx.getOrCreateImageCacheFolder();
    // runFolderName 老平铺是一段名, 新结构是 "项目/叶子" 两级路径 — 按段行走两种都认
    var runFolder = await PlacementLedger.getRunFolderByPath(cacheFolder, runFolderName);
    // isAlign: 读 output_align_NNN(对齐后图)而非 output_NNN
    var fileKind = (kind === 'output' && isAlign) ? 'output_align' : kind;
    var file = await runFolder.getEntry(fileKind + '_' + _pad3(idx) + '.png');
    var buf = await file.read({ format: uxpFormats.binary });
    return PsPixels.arrayBufferToBase64(buf);
}

// 把"对齐/校色后的图"另存为 output_align_NNN.png(不覆盖原始 output), 返回 runFolderName。
// 供后续校色把对齐后图当新的 output 基准, 跟原图 input 做颜色校准。
async function _saveAlignResult(ctx, runFolderName, outputIdx, b64) {
    try {
        var cacheFolder = await ctx.getOrCreateImageCacheFolder();
        var runFolder = await PlacementLedger.getRunFolderByPath(cacheFolder, runFolderName);
        var num = Number(outputIdx) || 1;
        if (num < 1) num = 1;
        var fileName = 'output_align_' + ('000' + num).slice(-3) + '.png';
        var file = await runFolder.createFile(fileName, { overwrite: true });
        await file.write(PsPixels.base64ToArrayBuffer(b64), { format: uxpFormats.binary });
        return runFolderName;
    } catch (eSave) {
        console.warn('[校色] 保存对齐后图缓存失败:', eSave && eSave.message);
        return null;
    }
}

// 给"对齐后图"贴回的图层登记台账: 下次在 PS 选中它点校色, findByLayer 能查到 → 读 output_align_NNN。
// 同时写内存台账(_entries)和 meta.json 持久化, 内存和磁盘保持一致。
async function _registerAlignLedger(ctx, docId, docName, layerId, item) {
    if (!item || !item.alignIdx || item.alignIdx <= 0 || !item.runFolderName || layerId == null) return;
    var entry = {
        docId: docId,
        docName: docName || '',
        layerId: layerId,
        runFolderName: item.runFolderName,
        inputIdx: 1,
        outputIdx: item.alignIdx,          // 指向 output_align_NNN
        alignOutput: true,                 // 标志: 校色读缓存时读 output_align_ 而非 output_
        selection: item.selection || null,
        antiMode: item.antiMode || 0,
        layerType: item.layerType || 'smartObject',
        featherKey: item.featherKey || '',
        engine: 'colormatch',
        ts: Date.now()
    };
    PlacementLedger.record(entry);
    try {
        var runFolder = await PlacementLedger.getRunFolderByPath(await ctx.getOrCreateImageCacheFolder(), item.runFolderName);
        if (runFolder) await PlacementLedger.writeMetaJson(runFolder, [entry]);
    } catch (eWrite) {
        console.warn('[校色台账] 对齐后图 meta.json 写入失败:', eWrite && eWrite.message);
    }
}

// 发给 webview 计算, 等 colormatchResult 回来
// selection: 台账里的贴回选区(可能带 cropRect = 补白前的真内容区)。
//   · 把 cropRect 换算成"内容区占方图的归一化比例"(0~1), 前端按实际尺寸换算像素矩形。
//     校色只在内容区做, 白边区(补白)不进统计、不保留 —— 修"扩1:1后校色被白边洗白"的 bug。
// align: Dock「对齐校色」→ 前端先跑几何对位(特征点+RANSAC)再把回图变形到原图位置, 之后才校色。
// align: 'align+color'(默认, 先对位再校色) / 'only'(只对位, 不碰色) / falsy(只校色)
function _computeInPanel(ctx, method, inputB64, outputB64, selection, align) {
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
        // cropRect(文档坐标, 补白前的真内容区) → 占方图(selBounds)的归一化比例
        // 方图画幅 = selection 的 width/height(padToSquare 时 = 补白后的边长), cropRect 是补白前原选区。
        var cropIn = null;
        try {
            var _sel = selection || null;
            var _cr = _sel && _sel.cropRect;
            if (_cr && _sel && _sel.width > 0 && _sel.height > 0) {
                var _nLeft = (Number(_cr.left) - Number(_sel.left)) / Number(_sel.width);
                var _nTop  = (Number(_cr.top) - Number(_sel.top)) / Number(_sel.height);
                var _nW = Number(_cr.width) / Number(_sel.width);
                var _nH = Number(_cr.height) / Number(_sel.height);
                if (isFinite(_nLeft) && isFinite(_nTop) && isFinite(_nW) && isFinite(_nH)
                    && _nW > 0.02 && _nH > 0.02) {
                    cropIn = { left: _nLeft, top: _nTop, width: _nW, height: _nH };
                }
            }
        } catch (eCrop) { cropIn = null; }
        ctx.sendToPanel('colormatchCompute', { jobId: jobId, method: method, inputB64: inputB64, outputB64: outputB64, cropRect: cropIn, align: align === 'only' ? 'only' : !!align });
    });
}

// webview 算完回传
HostAPI.registerAction('colormatchResult', async function(data, ctx) {
    // 前端回传的 diag(对齐过程状态)打到面板日志 — 实测时能直接看到对齐各阶段结果
    if (data && data.diag && Array.isArray(data.diag) && data.diag.length) {
        try {
            for (var di = 0; di < data.diag.length; di++) {
                if (ctx && ctx.logToPanel) ctx.logToPanel(data.diag[di], 'info');
            }
        } catch (eDiag) { try { console.log('[对齐诊断]', data.diag.join(' | ')); } catch (_) {} }
    }
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
//           layerType, featherKey, outputIdx, runFolderName, alignIdx}]
//  返回 { placed, leftovers, placedIds: [{layerId, item}] }
//  · 「只对齐」的 item(alignIdx>0)贴回成功会在内部登记台账 → 下次校色能找到它
// ============================================================
async function placeColormatchItems(ctx, docId, methodName, items) {
    var placed = 0, leftovers = [], placedIds = [];
    var docName = '';
    try { docName = (app.documents.find(function(d) { return d.id === docId; }) || app.activeDocument || {}).name || ''; } catch (eDN) {}
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
                    // 记录"新贴图层 ↔ item"对应(供调用方查看)
                    placedIds.push({ layerId: newLayerId, item: item });
                    // 「只对齐」图: 贴回即登记台账, 下次选中它校色时 findByLayer 能查到 → 读 output_align_NNN
                    // 自动传回 / 手动传回(✓)两条路都走这里, 一次收口
                    if (item.alignIdx > 0 && item.runFolderName) {
                        try {
                            await _registerAlignLedger(ctx, docId, docName, newLayerId, item);
                        } catch (eReg) {
                            console.warn('[校色台账] 对齐后图登记失败:', eReg && eReg.message);
                        }
                    }
                }, 'colormatch');
            })(it);
            placed++;
        } catch (ePlace) {
            leftovers.push(it);
            _status(ctx, '贴回失败(' + (it.targetName || ('第' + (i + 1) + '张')) + '): ' + ((ePlace && ePlace.message) || ePlace), 'warn', true);
        }
    }
    return { placed: placed, leftovers: leftovers, placedIds: placedIds };
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
    var alignOnly = !!(data && data.alignOnly);   // Dock「只对齐」→ 只做几何对位, 不碰颜色
    var doAlign = !!(data && data.align) || alignOnly;   // 平时对齐校色; alignOnly 时纯对位
    if (alignOnly) methodName = '只对齐';
    else if (doAlign) methodName = '对齐校色';
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
                var outputB64 = await _readCacheImage(ctx, e.runFolderName, 'output', e.outputIdx || 1, e.alignOutput);
                _status(ctx, tag + ': 计算中...', 'info', true);
                var correctedB64 = await _computeInPanel(ctx, method, inputB64, outputB64, e.selection, alignOnly ? 'only' : (doAlign ? true : false));
                var alignIdx = 0;
                // 只在「只对齐」时另存为 output_align_NNN.png: 那是对齐后但还没校色的图, 下次校色拿它作基准跟原图校色。
                // 「对齐校色」结果已是最终产物, 不存, 避免下次对已校色图再校一次(颜色过浓)。
                if (alignOnly) {
                    alignIdx = (e.outputIdx || 1);
                    var saved = await _saveAlignResult(ctx, e.runFolderName, alignIdx, correctedB64);
                    if (saved) {
                        _status(ctx, tag + ': 已存对位后图缓存 output_align_' + _pad3(alignIdx) + '.png', 'info', true);
                    }
                }
                items.push({
                    b64: correctedB64,
                    targetLayerId: job.layer.id,
                    targetName: job.layer.name || '',
                    selection: e.selection || null,
                    antiMode: e.antiMode || 0,
                    layerType: e.layerType || 'smartObject',
                    featherKey: e.featherKey || '',
                    outputIdx: e.outputIdx || 1,
                    alignIdx: alignIdx,                 // 0=非对齐, >0=只对齐后图已存 output_align_这一张
                    runFolderName: e.runFolderName
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
        // (对齐后图登记台账已收口在 placeColormatchItems 内部: 贴回即登记, 自动/手动都管)
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
            out[i] = await _computeInPanel(ctx, 'wavelet', inputB64, payloads[i], opts.selection);
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
    autoColormatchAll: autoColormatchAll,
    _computeInPanel: _computeInPanel   // 供 DLSS 磁贴做「嵌入校色图层」用(用户端校色)
};
