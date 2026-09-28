// ============================================================
//  tile-layercm.host.js —— 双选区互相调色 后端
//  全新磁贴(与 AI 调色 tile-colorgrade 无关):
//    用户手动在 PS 框两个选区: A=颜色参照, B=要改的
//    → 抓 A/B 像素(和生图抓画布同一套 getSelectionAndImage)
//    → 前端 tile-layercm.js 用 dock 同款算法(wavelet 精准 / reinhard 整体)
//      以 A 为参照把 B 调成 A 的颜色
//    → 结果作为新图层贴回, 置顶(始终生成在最顶)
//    → 独立任务卡走 colormatch 链路 → 生成中心出独立进度
//    → 自动传回: 开=算完直接贴回; 关=进"待返回"点 ✓ 再贴
//
//  抓取端(给面板当截图用)和计算/贴回端(真正任务)分开:
//    layerCmCapture — 只抓 A/B 选区缩略图 + 文档信息, 不建任务
//    layerCmRun      — 正式任务(建任务卡 → 抓全尺寸 → 算 → 贴回)
//  复用: 算法走 tile-colormatch.js 的 wavelet/reinhard;
//        任务链路走 colormatchTaskStarted/taskProgress/taskComplete;
//        贴回走 placeImageToSpecificDoc; 待返回走 g_taskResultCache + returnTaskResult。
// ============================================================

var HostAPI = require('../host/host-api.js');
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;

function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

// ============================================================
//  通用: 抓一个选区的像素(与生图同套), 可选 opts.getMeta 只返回信息不返回图
//  opts: { scaleMeta: {w,h}, getMeta: bool, passThru }
// ============================================================
async function _grabSelection(ctx, sel, opts) {
    opts = opts || {};
    try {
        var res = await ctx.getSelectionAndImage(sel, {});
        if (!res) throw new Error('抓取选区失败(未检测到选区)');
        if (opts.getMeta) {
            return { ok: true, meta: { left: res.selection.left, top: res.selection.top, right: res.selection.right, bottom: res.selection.bottom, width: res.selection.width, height: res.selection.height }, passThru: opts.passThru };
        }
        if (!res.base64) throw new Error('抓取选区失败(无图像数据)');
        return { ok: true, base64: res.base64, meta: { left: res.selection.left, top: res.selection.top, right: res.selection.right, bottom: res.selection.bottom, width: res.selection.width, height: res.selection.height }, passThru: opts.passThru };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e), passThru: opts.passThru };
    }
}

// 把一次抓取结果广播给面板(layerCmSlot 由前端回填)
function _broadcast(ctx, kind, res) {
    var payload = { kind: kind };
    if (res && res.ok) {
        payload.ok = true;
        payload.meta = res.meta || null;
        payload.passThru = res.passThru || null;
        // 缩略图: 计算端不带图, 只透传信息
        if (res.base64) payload.base64 = res.base64;
    } else {
        payload.ok = false;
        payload.error = (res && res.error) || '未知错误';
        payload.passThru = (res && res.passThru) || null;
    }
    try { ctx.sendToPanel('layerCmCaptured', payload); } catch (_) {}
}

// ============================================================
//  layerCmCapture —— 抓取缩略图(预览用, 不动文档状态, 不建任务)
//  面板上点「抓取 A」/「抓取 B」/「刷新全部」时调用
//  抓小图(512)当缩略图, 同时带回选区坐标, 供正式任务按坐标重抓全尺寸。
// ============================================================
HostAPI.registerAction('layerCmCapture', async function(data, ctx) {
    var doc = app.activeDocument;
    if (!doc) { try { ctx.sendToPanel('layerCmCaptured', { ok: false, kind: data && data.kind, error: '没有打开的文档' }); } catch (_) {} return; }

    var kind = (data && data.kind) || '';

    // 临时把抓图分辨率压到 512 当缩略图(避免全尺寸 base64 卡面板), 抓完恢复
    var savedMaxRes = ctx.g_maxResolutionRef ? ctx.g_maxResolutionRef.value : null;
    var savedAntiMode = ctx.g_antiTruncationModeRef ? ctx.g_antiTruncationModeRef.value : null;
    var res = null;
    try {
        if (ctx.g_maxResolutionRef) ctx.g_maxResolutionRef.value = 512;
        if (ctx.g_antiTruncationModeRef) ctx.g_antiTruncationModeRef.value = 0;   // 缩略图不做抗截断反色
        await ctx.acquirePSLock(async function() {
            var cap = await ctx.getSelectionAndImage(null, {});
            if (cap && cap.base64) {
                res = {
                    ok: true,
                    base64: cap.base64,
                    meta: cap.selection ? {
                        left: cap.selection.left, top: cap.selection.top,
                        right: cap.selection.right, bottom: cap.selection.bottom,
                        width: cap.selection.width, height: cap.selection.height
                    } : null,
                    passThru: { kind: kind, docId: doc.id }
                };
            }
        }, 'lcmcap_' + Date.now());
    } catch (e) {
        res = { ok: false, error: (e && e.message) || String(e), passThru: { kind: kind, docId: doc.id } };
    } finally {
        if (ctx.g_maxResolutionRef && savedMaxRes !== null) ctx.g_maxResolutionRef.value = savedMaxRes;
        if (ctx.g_antiTruncationModeRef && savedAntiMode !== null) ctx.g_antiTruncationModeRef.value = savedAntiMode;
    }
    if (!res) res = { ok: false, error: '抓取选区失败(未检测到选区)', passThru: { kind: kind, docId: doc.id } };
    _broadcast(ctx, kind, res);
}, { tileId: 'layercm' });

// ============================================================
//  layerCmRun —— 正式校色任务
//  输入: captureA / captureB(都是 layerCmCapture 的结果, 含 meta 选区 + docId)
//  流程: 建任务卡 → 抓 A/B 全尺寸 → 发前端计算 → 按自动传回开关贴回/转待返回
// ============================================================
HostAPI.registerAction('layerCmRun', async function(data, ctx) {
    var captureA = (data && data.captureA) || null;
    var captureB = (data && data.captureB) || null;
    var method = ((data && data.method) === 'reinhard') ? 'reinhard' : 'wavelet';
    var methodName = (method === 'wavelet') ? '精准调色' : '整体调色';
    // 跟随全局自动传回: 前端把开关值捎过来(和 dock 校色按钮同一来源), host 再与任务级覆盖合并
    var autoReturn = !(data && data.autoReturn === false);
    var taskId = 'lc_' + Date.now();

    // ── 输入校验 ──
    if (!captureA || !captureA.ok || !captureA.meta) {
        try { ctx.sendToPanel('layerCmStatus', { text: '请先抓取参照区 A', level: 'error' }); } catch (_) {}
        return;
    }
    if (!captureB || !captureB.ok || !captureB.meta) {
        try { ctx.sendToPanel('layerCmStatus', { text: '请先抓取要改的区 B', level: 'error' }); } catch (_) {}
        return;
    }
    if (!captureA.meta.width || !captureA.meta.height || !captureB.meta.width || !captureB.meta.height) {
        try { ctx.sendToPanel('layerCmStatus', { text: '选区尺寸无效(全空选区无法校色)', level: 'error' }); } catch (_) {}
        return;
    }

    var doc = app.activeDocument;
    if (!doc) { try { ctx.sendToPanel('layerCmStatus', { text: '没有打开的文档', level: 'error' }); } catch (_) {} return; }
    var originDocId = doc.id;
    var docName = '';
    try { docName = doc.name || ''; } catch (_) {}
    var docPath = '';
    try { docPath = doc.path ? String(doc.path) : ''; } catch (_) {}
    // B 里带着"抓取时的 docId"(layerCmCapture 记的), 若用户在抓完后切了文档, 贴回要贴回抓取时的文档
    if (captureB.passThru && captureB.passThru.docId) originDocId = captureB.passThru.docId;

    ctx.logToPanel('[双区调色] 开始: ' + methodName + ' (参照区 ' + captureA.meta.width + 'x' + captureA.meta.height + ' → 目标区 ' + captureB.meta.width + 'x' + captureB.meta.height + ')', 'info');
    try { ctx.sendToPanel('colormatchTaskStarted', { taskId: taskId, count: 1, methodName: methodName, autoReturn: autoReturn }); } catch (_) {}
    try { ctx.sendToPanel('colormatchPhase', { taskId: taskId, phase: 'start', total: 1 }); } catch (_) {}

    try {
        // ── 1. 抓 A/B 全尺寸(和生图同一套抓画布, 连自动扩方都一致) ──
        var grabA = await _grabSelection(ctx, captureA.meta, {});
        if (!grabA.ok) throw new Error('抓取参照区 A 失败: ' + grabA.error);
        var grabB = await _grabSelection(ctx, captureB.meta, {});
        if (!grabB.ok) throw new Error('抓取目标区 B 失败: ' + grabB.error);

        // ── 2. 发前端计算(wavelet/reinhard, 与 dock 校色同一套代码) ──
        var correctedB64 = await _computeInPanel(ctx, method, grabA.base64, grabB.base64, taskId);

        // ── 3. 按自动传回: 开=直接贴回(置顶+精确尺寸), 关=转待返回 ──
        var cached = false, placedLayerId = null, placed = false;
        if (autoReturn) {
            try {
                var placeRes = await placeLayerAtSelection(ctx, correctedB64, originDocId, captureB.meta);
                placedLayerId = placeRes.layerId;
                if (placedLayerId) {
                    placed = true;
                    // 置顶: 新贴的图若不在最顶(用户中途动过图层), 挪到最顶
                    try {
                        await core.executeAsModal(async function() {
                            var targetDoc = app.documents.find(function(d) { return d.id === originDocId; }) || app.activeDocument;
                            var placedLayer = _findLayerById(targetDoc, placedLayerId);
                            if (placedLayer) placedLayer.move(placedLayer, photoshop.constants.ElementPlacement.PLACEATBEGINNING);
                        }, { commandName: '双区调色-置顶' });
                    } catch (eTop) { ctx.logToPanel('[双区调色] 置顶失败(图层仍在): ' + ((eTop && eTop.message) || eTop), 'warn'); }
                    try {
                        await core.executeAsModal(async function() {
                            var d2 = app.documents.find(function(d) { return d.id === originDocId; }) || app.activeDocument;
                            var nl = _findLayerById(d2, placedLayerId);
                            if (nl) nl.name = '调色·' + methodName;
                        }, { commandName: '双区调色-命名' });
                    } catch (eN) {}
                    // 验证日志: 贴回前后像素矩形对比(用户说"不生效/变糊"时能远程定位)
                    try {
                        var _pt = placeRes.target || captureB.meta;
                        ctx.logToPanel('[双区调色] 贴回验证: 目标 ' + _pt.width + 'x' + _pt.height
                            + ' @(' + _pt.left + ',' + _pt.top + ')'
                            + (placeRes.before ? ' | 结果原尺寸 ' + placeRes.before.width + 'x' + placeRes.before.height : '')
                            + (placeRes.after ? ' | 贴后 ' + placeRes.after.width + 'x' + placeRes.after.height : ''), 'info');
                    } catch (eV2) {}
                }
            } catch (ePlace) {
                ctx.logToPanel('[双区调色] 贴回失败, 已转待返回: ' + ((ePlace && ePlace.message) || ePlace), 'warn');
            }
            if (!placed) {
                _stashManualReturn(ctx, taskId, originDocId, docName, methodName, correctedB64, captureB.meta);
                cached = true;
            }
        } else {
            _stashManualReturn(ctx, taskId, originDocId, docName, methodName, correctedB64, captureB.meta);
            cached = true;
        }

        // ── 4. 收卡 + 汇总 ──
        try { ctx.sendToPanel('colormatchPhase', { taskId: taskId, phase: 'done', done: 1, total: 1 }); } catch (_) {}
        try { ctx.sendToPanel('taskComplete', { taskId: taskId, successCount: 1, failCount: 0, cached: cached }); } catch (_) {}
        if (cached) {
            ctx.logToPanel('[双区调色] ' + methodName + ' 完成, 已转待返回(点 ✓ 传回)', 'warn');
            try { ctx.sendToPanel('layerCmStatus', { text: methodName + ' 完成, 已转待返回(点 ✓ 传回)', level: 'warn' }); } catch (_) {}
        } else {
            ctx.logToPanel('[双区调色] ' + methodName + ' 完成, 已置顶贴回', 'success');
            try { ctx.sendToPanel('layerCmStatus', { text: methodName + ' 完成, 已置顶贴回', level: 'success' }); } catch (_) {}
        }
        try { await ctx.playSuccessSound(); } catch (_) {}
    } catch (eRun) {
        try { ctx.sendToPanel('colormatchPhase', { taskId: taskId, phase: 'done', done: 0, total: 1 }); } catch (_) {}
        try { ctx.sendToPanel('taskComplete', { taskId: taskId, successCount: 0, failCount: 1, cached: false }); } catch (_) {}
        try { ctx.sendToPanel('layerCmStatus', { text: '调色失败: ' + ((eRun && eRun.message) || eRun), level: 'error' }); } catch (_) {}
        try { ctx.logToPanel('[双区调色] 失败: ' + ((eRun && eRun.message) || eRun), 'error'); } catch (_) {}
        try { await ctx.playSingleFailSound(); } catch (_) {}
    }
}, { tileId: 'layercm' });

// ============================================================
//  计算往返: 发前端(webview)算, 等 layerCmComputeResult 回
// ============================================================
var _pending = {};   // jobId -> {resolve, reject, timer}
var _jobSeq = 0;
var COMPUTE_TIMEOUT_MS = 120000;

function _computeInPanel(ctx, method, inputB64, outputB64, taskId) {
    return new Promise(function(resolve, reject) {
        var jobId = 'lcmjob_' + (++_jobSeq) + '_' + Date.now();
        _pending[jobId] = {
            resolve: resolve,
            reject: reject,
            timer: setTimeout(function() {
                if (_pending[jobId]) { delete _pending[jobId]; reject(new Error('前端计算超时(120秒)')); }
            }, COMPUTE_TIMEOUT_MS)
        };
        try { ctx.sendToPanel('layerCmCompute', { jobId: jobId, method: method, inputB64: inputB64, outputB64: outputB64, taskId: taskId }); } catch (_) {
            reject(new Error('发送计算请求失败'));
        }
    });
}

HostAPI.registerAction('layerCmComputeResult', async function(data) {
    var jobId = data && data.jobId;
    var p = jobId && _pending[jobId];
    if (!p) return;
    delete _pending[jobId];
    clearTimeout(p.timer);
    if (data && data.ok && data.base64) p.resolve(data.base64);
    else p.reject(new Error((data && data.error) || '前端计算失败'));
});

// 递归按 id 找图层(组内也找)
function _findLayerById(container, id) {
    var layers = (container && container.layers) || [];
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
//  placeLayerAtSelection —— 像素级精确贴回
//  问题: placeImageToSpecificDoc 用"读置入后图层当前 bounds + 缩放百分比"摆位,
//  但置入的智能对象原始像素尺寸 ≠ 目标选区像素尺寸时, 它算出的缩放是错的:
//  结果被缩小/放大到错误尺寸 → 虚/糊/对不齐。
//  修复: 先读目标选区真实像素尺寸(batchPlay get 选区矩形 + getSelectionRectSafe),
//  再读结果智能对象原始像素尺寸(不读显示 bounds), 算出精确缩放百分比, 一次缩到位。
//  必须在 executeAsModal 内调用(不自己申请修改权)。
// ============================================================
async function _getTrueRectByBatchPlay(docId) {
    // 读当前活动选区的矩形(单位像素)。返回 null 表示读不到(没有活动选区/文档不是目标文档)
    try {
        var r = await app.batchPlay([{
            _obj: "get",
            _target: [{ _property: "selection" }, { _ref: "document", _id: docId }]
        }], {});
        if (r && r[0] && r[0].selection && r[0].selection.bounds) {
            var rb = r[0].selection.bounds;
            var toNum = function(v) {
                if (v == null) return 0;
                if (v._value !== undefined) return Number(v._value);
                return Number(v);
            };
            var rect = {
                left: toNum(rb.left),
                top: toNum(rb.top),
                right: toNum(rb.right),
                bottom: toNum(rb.bottom)
            };
            return getSelectionRectSafe(rect);
        }
        return null;
    } catch (e) { return null; }
}

// 读图层(boundsNoEffects)当前显示尺寸(像素)
async function _getLayerPixelRect(docId, layerId) {
    try {
        var g = await app.batchPlay([{
            _obj: "get",
            _target: [{ _property: "boundsNoEffects" }, { _ref: "layer", _id: layerId }]
        }], {});
        if (g && g[0] && g[0].boundsNoEffects) {
            var b = g[0].boundsNoEffects;
            var toNum = function(v) {
                if (v == null) return 0;
                if (v._value !== undefined) return Number(v._value);
                return Number(v);
            };
            var rect = {
                left: toNum(b.left), top: toNum(b.top),
                right: toNum(b.right), bottom: toNum(b.bottom)
            };
            var sr = getSelectionRectSafe(rect);
            if (sr) {
                return { left: sr.left, top: sr.top, width: sr.width, height: sr.height, right: sr.right, bottom: sr.bottom };
            }
        }
        return null;
    } catch (e) { return null; }
}

// 读图层原始像素尺寸(智能对象: 读其内部资源像素尺寸, 而非显示 bounds)
async function _getLayerSourcePixelSize(docId, layerId) {
    // 1. 尝试 readPixels: 直接把图层原始像素读出来(不经显示缩放)
    try {
        var res = await app.batchPlay([{
            _obj: "get",
            _target: [{ _property: "pixels" }, { _ref: "layer", _id: layerId }]
        }], {});
        if (res && res[0] && res[0].pixels) {
            var px = res[0].pixels;
            var w = px.width, h = px.height;
            if (w > 0 && h > 0) {
                if (px.data && px.data.dispose) { try { px.data.dispose(); } catch (_) {} }
                return { width: w, height: h };
            }
            if (px.data && px.data.dispose) { try { px.data.dispose(); } catch (_) {} }
        }
    } catch (e) {}
    // 2. 降级: 用显示 bounds(不是原始尺寸, 但至少能算出一个缩放)
    try {
        var gr = _getLayerPixelRect(docId, layerId);
        if (gr) return { width: gr.width, height: gr.height };
    } catch (e2) {}
    return null;
}

// 把 b64 贴回 docId 的选区位置, 尺寸精确等于目标选区像素
// 返回: { layerId, before, after } — before/after 是贴回前后图层/选区的像素矩形(供对比/验证)
async function placeLayerAtSelection(ctx, b64, docId, targetSelection) {
    var doc = app.documents.find(function(d) { return d.id === docId; }) || app.activeDocument;

    // 目标选区真实像素矩形
    var trueTarget = null;
    try {
        await core.executeAsModal(async function() {
            // 先切到目标文档, 再读活动选区
            await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: docId }] }], {});
            var r = await app.batchPlay([{
                _obj: "get",
                _target: [{ _property: "selection" }, { _ref: "document", _id: docId }]
            }], {});
            if (r && r[0] && r[0].selection) {
                var rb = r[0].selection.bounds;
                var toNum = function(v) {
                    if (v == null) return 0;
                    if (v._value !== undefined) return Number(v._value);
                    return Number(v);
                };
                var rect = {
                    left: toNum(rb.left), top: toNum(rb.top),
                    right: toNum(rb.right), bottom: toNum(rb.bottom)
                };
                trueTarget = getSelectionRectSafe(rect);
            }
        }, { commandName: '双区调色-读选区' });
    } catch (eSel) { /* 读不到就退回调用方给的 selection */ }
    if (!trueTarget && targetSelection) trueTarget = getSelectionRectSafe(targetSelection);
    if (!trueTarget) throw new Error('无法确定目标选区(文档里没有活动选区)');

    // 用目标选区像素尺寸去置入 — 必须用选区矩形显式置入, 否则 PS 会把智能对象放到 1:1 位置
    var placedLayerId = null;
    try {
        placedLayerId = await ctx.placeImageToSpecificDoc(b64, docId, trueTarget, 0, 'smartObject');
    } catch (ePlace) {
        throw ePlace;
    }
    if (!placedLayerId) throw new Error('贴回失败(PS 未创建图层)');

    // 现在精确缩放: 读结果图层原始像素, 缩放到目标选区像素
    var srcSize = await _getLayerSourcePixelSize(docId, placedLayerId);
    var after = null;
    if (srcSize && srcSize.width > 0 && srcSize.height > 0) {
        var targetW = trueTarget.width, targetH = trueTarget.height;
        var scaleX = (targetW / srcSize.width) * 100;
        var scaleY = (targetH / srcSize.height) * 100;
        // 1% 以内不折腾(浮点误差)
        if (Math.abs(scaleX - 100) > 0.5 || Math.abs(scaleY - 100) > 0.5) {
            await core.executeAsModal(async function() {
                await app.batchPlay([{
                    _obj: "select",
                    _target: [{ _ref: "layer", _id: placedLayerId }],
                    makeVisible: false
                }], {});
                await app.batchPlay([{
                    _obj: "transform",
                    _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                    freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSCorner0" },
                    width: { _unit: "percentUnit", _value: scaleX },
                    height: { _unit: "percentUnit", _value: scaleY },
                    interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "bicubicAutomatic" }
                }], {});
            }, { commandName: '双区调色-精确缩放' });
        }
        // 读缩放后的实际像素矩形(验证)
        try {
            await core.executeAsModal(async function() {
                var g = await app.batchPlay([{
                    _obj: "get",
                    _target: [{ _property: "boundsNoEffects" }, { _ref: "layer", _id: placedLayerId }]
                }], {});
                if (g && g[0] && g[0].boundsNoEffects) {
                    var b = g[0].boundsNoEffects;
                    var toNum = function(v) {
                        if (v == null) return 0;
                        if (v._value !== undefined) return Number(v._value);
                        return Number(v);
                    };
                    var rect = {
                        left: toNum(b.left), top: toNum(b.top),
                        right: toNum(b.right), bottom: toNum(b.bottom)
                    };
                    after = getSelectionRectSafe(rect);
                }
            }, { commandName: '双区调色-读缩放后' });
        } catch (eAfter) {}
    }

    // 若读不到原始像素(降级), 直接信任选区置入; after 置为目标选区
    if (!after && trueTarget) after = { left: trueTarget.left, top: trueTarget.top, right: trueTarget.right, bottom: trueTarget.bottom, width: trueTarget.width, height: trueTarget.height };

    return { layerId: placedLayerId, before: srcSize ? { width: srcSize.width, height: srcSize.height } : null, after: after, target: trueTarget };
}

// 验证用: 把结果图贴回目标选区, 并返回贴回前后的精确像素矩形(供面板显示"是否对齐")
HostAPI.registerAction('layerCmPlaceVerify', async function(data, ctx) {
    var b64 = data && data.base64;
    var docId = data && data.docId;
    var selection = (data && data.selection) || null;
    if (!b64 || !docId) {
        try { ctx.sendToPanel('layerCmStatus', { text: '验证参数缺失', level: 'error' }); } catch (_) {}
        return;
    }
    try {
        var res = await placeLayerAtSelection(ctx, b64, docId, selection);
        try { ctx.sendToPanel('layerCmPlaceVerifyResult', { ok: true, layerId: res.layerId, before: res.before, after: res.after, target: res.target }); } catch (_) {}
    } catch (eV) {
        try { ctx.sendToPanel('layerCmPlaceVerifyResult', { ok: false, error: (eV && eV.message) || String(eV) }); } catch (_) {}
    }
}, { tileId: 'layercm' });



// 转"待返回": 存进任务结果缓存, 任务磁贴/生成中心的 ✓ 按钮会来取
function _stashManualReturn(ctx, taskId, originDocId, docName, methodName, b64, selection) {
    try {
        ctx.g_taskResultCache[taskId] = {
            colormatch: {
                methodName: methodName,
                items: [{
                    b64: b64,
                    targetLayerId: null,
                    targetName: '',
                    selection: selection || null,
                    antiMode: 0,
                    layerType: 'smartObject',
                    featherKey: '',
                    outputIdx: 1
                }]
            },
            originDocId: originDocId,
            docName: docName,
            payloads: [b64]
        };
    } catch (eStash) {
        ctx.logToPanel('[双区调色] 待返回缓存写入失败: ' + ((eStash && eStash.message) || eStash), 'warn');
    }
}

module.exports = {};
