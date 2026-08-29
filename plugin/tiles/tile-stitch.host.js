// ============================================================
//  tile-stitch.host.js — 多区拼接 后端处理器 (2026-07-06)
//
//  功能: 把 PS 里的多个选区拼成一张竖排大图(区域间夹白色分隔带),
//        一次 API 调用处理全部区域, 回图按布局账切块、各归各位贴回。
//  省钱逻辑: N 个小区域拼一张 = 1 次调用费。
//
//  动作:
//    stitchCaptureRegion  — 抓当前选区(纯净抓取, 无抗截断/无补白), 返回 base64+选区
//    stitchGenerate       — 面板送来 N 个区域 → host 解码/缩放/拼接/(抗截断)/编码 →
//                           callAiApi → 回图连同布局账发回面板(面板 canvas 切块)
//    stitchPlaceParts     — 面板切好的 N 块 → 逐块贴回原选区(+蒙版/羽化) → 编组
//
//  设计要点:
//    · 拼接/色相处理全在 host 端做 — 直接复用 ps-pixels 的精确算法,
//      与贴回时 PS 侧的反向还原严格互逆(面板 canvas 滤镜是近似值, 不能用)
//    · 自动扩充+裁切天然不参与(不经过 getSelectionAndImage 的 padToSquare 分支)
//    · 抗截断可共存: 对整张拼接图统一做, 贴回走 placeImageToSpecificDoc 现有还原
// ============================================================

var HostAPI = require('../host/host-api.js');
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;

function _findStitchDocById(docId) {
    for (var i = 0; i < app.documents.length; i++) {
        if (String(app.documents[i].id) === String(docId)) return app.documents[i];
    }
    return null;
}

async function _withStitchDocLock(ctx, taskId, docId, fn) {
    if (docId == null) throw new Error('PS 里没有打开的文档');
    if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop 全局操作锁不可用');
    return await ctx.acquirePSLock(async function() {
        var doc = _findStitchDocById(docId);
        if (!doc) throw new Error('请求发起时的 PS 文档已关闭');
        if (!app.activeDocument || String(app.activeDocument.id) !== String(docId)) {
            await core.executeAsModal(async function() {
                await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: doc.id }] }], {});
            }, { commandName: '切换到多区拼接目标文档' });
        }
        return await fn(doc);
    }, taskId);
}

// 拼接参数(GAP/上限)在面板端 tile-stitch.js 定义 — host 只收成品拼接图


HostAPI.registerAction('stitchCaptureRegion', async function(data, ctx) {
    try {
        var doc = app.activeDocument;
        if (!doc) { ctx.sendToPanel('stitchCaptureResult', { success: false, error: '没有打开的文档' }); return; }
        var docId = doc.id;
        var docName = doc.name;
        var docPath = '';
        try { docPath = doc.path ? String(doc.path) : ''; } catch (_pathErr) {}
        // 纯净抓取: 临时关抗截断(拼接后统一做), 复用现有管线拿 base64+选区
        var capture = await _withStitchDocLock(ctx, (data && data.taskId) || 'stitch-capture', docId, async function() {
            var savedAntiMode = null;
            try { savedAntiMode = ctx.g_antiTruncationModeRef.value; ctx.g_antiTruncationModeRef.value = 0; } catch (e) {}
            try {
                var lockedCapture = await ctx.getSelectionAndImage();
                if (lockedCapture) await ctx.deselectAll();
                return lockedCapture;
            } finally {
                try { if (savedAntiMode !== null) ctx.g_antiTruncationModeRef.value = savedAntiMode; } catch (e) {}
            }
        });
        if (!capture) { ctx.sendToPanel('stitchCaptureResult', { success: false, error: '未检测到选区 — 请先用选框工具框住一个区域' }); return; }
        ctx.sendToPanel('stitchCaptureResult', {
            success: true,
            base64: capture.base64,
            selection: capture.selection,
            docId: docId,
            docName: docName,
            docPath: docPath
        });
    } catch (e) {
        ctx.sendToPanel('stitchCaptureResult', { success: false, error: e.message || String(e) });
    }
}, { tileId: 'stitch' });

// ── 拼接生成 ──
// 面板端已完成: 解码/缩放/拼接/抗截断色相(同款精确算法) — host 只管调 API
// data: { taskId, stitchedBase64, stitchW, stitchH, layout:[{x,y,w,h,selection}], docId,
//         prompt, apiKey, apiBaseUrl, model, provider, size, timeout, antiMode, layerType, presetTitle }
HostAPI.registerAction('stitchGenerate', async function(data, ctx) {
    var taskId = data.taskId;
    var apiSuccessCount = 0;
    var apiFailCount = 0;
    var commonReceipt = function(extra) {
        extra = extra || {};
        return Object.assign({
            taskId: taskId,
            generatedCount: apiSuccessCount,
            successCount: apiSuccessCount,
            returnedCount: 0,
            pendingCount: apiSuccessCount,
            failCount: apiFailCount,
            provider: data.provider || '',
            engine: 'stitch',
            model: data.model || '',
            size: data.size || '',
            docName: data.docName || '',
            docPath: data.docPath || ''
        }, extra);
    };
    function fail(msg) {
        ctx.sendTaskCompleteOnce(taskId, commonReceipt());
        try { ctx.logToPanel('[多区拼接] ' + msg, 'error'); } catch (_) {}
        try { ctx.sendToPanel('stitchGenerateResult', { success: false, taskId: taskId, error: msg }); } catch (_) {}
    }
    try {
        if (!data.stitchedBase64) { fail('没有拼接图'); return; }
        var batch = Math.max(1, Math.min(4, parseInt(data.batch, 10) || 1));
        ctx.logToPanel('[多区拼接] 拼接图 ' + data.stitchW + 'x' + data.stitchH + ' (' + (data.layout || []).length + ' 区)' + (batch > 1 ? ' × ' + batch + ' 张' : '') + ', 开始生成…', 'info');
        // batch 张并发抽卡(同一拼接图), 部分成功也继续
        var jobs = [];
        for (var bi = 0; bi < batch; bi++) {
            jobs.push(ctx.callAiApi(
                data.apiKey, data.prompt, data.stitchedBase64, data.size, data.timeout || 3600,
                data.apiBaseUrl, [], data.model, data.provider, taskId + (bi > 0 ? '_b' + bi : ''),
                'Auto', {}
            ).then(function(result) {
                return { success: !!result, attempted: true, data: result };
            }).catch(function(e) {
                try { ctx.logToPanel('[多区拼接] 一张失败: ' + (e.message || e), 'warn'); } catch (_) {}
                return { success: false, attempted: !(e && e.requestAttempted === false), data: null };
            }));
        }
        var settled = await Promise.all(jobs);
        var oks = settled.filter(function(r) { return r && r.success && r.data; }).map(function(r) { return r.data; });
        apiSuccessCount = oks.length;
        apiFailCount = settled.filter(function(r) { return r && !r.success && r.attempted !== false; }).length;
        if (!oks.length) { fail('生成失败(全部无返回)'); return; }
        if (oks.length < batch) ctx.logToPanel('[多区拼接] ' + oks.length + '/' + batch + ' 张成功, 继续贴回', 'warn');
        ctx.sendToPanel('stitchGenerateResult', {
            success: true, taskId: taskId,
            resultBase64s: oks,
            stitchW: data.stitchW, stitchH: data.stitchH,
            layout: data.layout,
            docId: data.docId,
            antiMode: data.antiMode || 0,
            layerType: data.layerType || 'smartObject',
            presetTitle: data.presetTitle || '',
            model: data.model || '', size: data.size || '',
            provider: data.provider || '',
            docName: data.docName || '', docPath: data.docPath || '',
            apiSuccessCount: apiSuccessCount, apiFailCount: apiFailCount
        });
    } catch (e) {
        fail(e.message || String(e));
    }
}, { tileId: 'stitch' });

// ── 切块贴回 + 编组(支持跨文档: 按 part.docId 分组, 逐文档贴回各编一组) ──
// data: { taskId, docId, parts: [{base64, selection, docId}], antiMode, layerType, presetTitle, model, sizeLabel, size4k }
HostAPI.registerAction('stitchPlaceParts', async function(data, ctx) {
    var taskId = data.taskId;
    try {
        var parts = data.parts || [];
        // 切块或回图阶段失败时也要结算已成功的 API 请求，不能因为没有切块就把账单吃掉。
        if (!parts.length) throw new Error('没有可贴回的切块');
        // 分组键 = 文档 + 第几张(batchIdx): 跨文档各归各, 多张各编各组
        var byDoc = {};
        for (var i = 0; i < parts.length; i++) {
            var did = (parts[i].docId || data.docId) + '|' + (parts[i].batchIdx || 0);
            (byDoc[did] = byDoc[did] || []).push(parts[i]);
        }
        var totalPlaced = 0, totalFail = 0;
        var expectedPartsByBatch = {};
        var placedPartsByBatch = {};
        for (var ep = 0; ep < parts.length; ep++) {
            var epBatch = String(parts[ep].batchIdx || 0);
            expectedPartsByBatch[epBatch] = (expectedPartsByBatch[epBatch] || 0) + 1;
        }
        var docIds = Object.keys(byDoc);
        for (var d = 0; d < docIds.length; d++) {
            var docId = +docIds[d].split('|')[0];
            var docParts = byDoc[docIds[d]];
            try {
                var docReturn = await _withStitchDocLock(ctx, taskId, docId, async function() {
                    var createdIds = [];
                    var placeFail = 0;
                    for (var p = 0; p < docParts.length; p++) {
                        try {
                            var lid = await ctx.placeImageToSpecificDoc(docParts[p].base64, docId, docParts[p].selection, data.antiMode || 0, data.layerType || 'smartObject');
                            if (lid) {
                                createdIds.push(lid);
                                var placedBatch = String(docParts[p].batchIdx || 0);
                                placedPartsByBatch[placedBatch] = (placedPartsByBatch[placedBatch] || 0) + 1;
                                try {
                                    await ctx.applyReturnFeatherMaskToLayer(docId, lid, docParts[p].selection, 'bananaSingle');
                                } catch (featherErr) {
                                    ctx.logToPanel('[多区拼接] 图已贴回，但羽化蒙版失败: ' + ((featherErr && featherErr.message) || featherErr), 'warn');
                                }
                            } else {
                                placeFail++;
                            }
                        } catch (ePlace) {
                            placeFail++;
                            ctx.logToPanel('[多区拼接] 一块贴回失败: ' + (ePlace.message || ePlace), 'warn');
                        }
                    }
                    if (createdIds.length > 0 && ctx.g_autoGroupRef.value) {
                        try {
                            await core.executeAsModal(async function() {
                                await ctx.createGroupAndMask(createdIds, "多区拼接", (data.presetTitle ? { presetName: data.presetTitle } : undefined));
                                if (ctx.g_fix4kMagentaRef && ctx.g_fix4kMagentaRef.value
                                    && data.size4k === true
                                    && /banana|gemini/i.test(String(data.model || ''))
                                    && ctx.applyMagentaFixCurveToGroup) {
                                    try { await ctx.applyMagentaFixCurveToGroup("多区拼接"); } catch (eMg) {}
                                }
                            }, { commandName: "多区拼接打组" });
                        } catch (groupErr) {
                            ctx.logToPanel('[多区拼接] 图已贴回，但自动分组失败: ' + ((groupErr && groupErr.message) || groupErr), 'warn');
                        }
                    }
                    return { placed: createdIds.length, failed: placeFail };
                });
                totalPlaced += docReturn.placed;
                totalFail += docReturn.failed;
            } catch (docErr) {
                totalFail += docParts.length;
                ctx.logToPanel('[多区拼接] 文档(id ' + docId + ') 无法继续贴回: ' + (docErr.message || docErr), 'warn');
            }
        }
        var generatedCount = Number(data.apiSuccessCount);
        if (!isFinite(generatedCount) || generatedCount < 0) generatedCount = totalPlaced > 0 ? 1 : 0;
        generatedCount = Math.floor(generatedCount);
        var returnedCount = Number(data.returnedCount);
        if (!isFinite(returnedCount) || returnedCount < 0) {
            returnedCount = 0;
            Object.keys(expectedPartsByBatch).forEach(function(batchKey) {
                if (placedPartsByBatch[batchKey] >= expectedPartsByBatch[batchKey]) returnedCount++;
            });
        }
        returnedCount = Math.min(generatedCount, Math.floor(returnedCount));
        ctx.sendTaskCompleteOnce(taskId, {
            taskId: taskId,
            generatedCount: generatedCount,
            successCount: generatedCount,
            returnedCount: returnedCount,
            pendingCount: Math.max(0, generatedCount - returnedCount),
            failCount: Number(data.apiFailCount) >= 0 ? Math.floor(Number(data.apiFailCount)) : 0,
            provider: data.provider || '', engine: 'stitch',
            model: data.model || '', size: data.sizeLabel || data.size || '',
            docName: data.docName || '', docPath: data.docPath || ''
        });
        try { ctx.logToPanel('[多区拼接] ' + totalPlaced + '/' + parts.length + ' 块已贴回' + (docIds.length > 1 ? ' (跨 ' + docIds.length + ' 个文档)' : ''), totalFail ? 'warn' : 'success'); } catch (_) {}
        try { ctx.sendToPanel('stitchPlaceResult', { success: totalPlaced > 0, taskId: taskId, placed: totalPlaced, failed: totalFail }); } catch (_) {}
    } catch (e) {
        var failedGenerated = Number(data.apiSuccessCount);
        if (!isFinite(failedGenerated) || failedGenerated < 0) failedGenerated = 0;
        var failedApi = Number(data.apiFailCount);
        if (!isFinite(failedApi) || failedApi < 0) failedApi = 0;
        ctx.sendTaskCompleteOnce(taskId, {
            taskId: taskId,
            generatedCount: Math.floor(failedGenerated),
            successCount: Math.floor(failedGenerated),
            returnedCount: 0,
            pendingCount: Math.floor(failedGenerated),
            failCount: Math.floor(failedApi),
            provider: data.provider || '', engine: 'stitch',
            model: data.model || '', size: data.sizeLabel || data.size || '',
            docName: data.docName || '', docPath: data.docPath || ''
        });
        try { ctx.logToPanel('[多区拼接] 贴回失败: ' + (e.message || e), 'error'); } catch (_) {}
        try { ctx.sendToPanel('stitchPlaceResult', { success: false, taskId: taskId, error: e.message || String(e) }); } catch (_) {}
    }
}, { tileId: 'stitch' });
