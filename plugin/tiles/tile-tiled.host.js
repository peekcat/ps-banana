// ============================================================
//  tile-tiled.host.js
//  分块放大 (Tiled Upscale) 后端处理器
//  从 index.js 迁移 handleStartTiledUpscale / executeTiledUpscale / handleTiledFillTest
//  通过 HostAPI.registerAction 注册到路由表
// ============================================================

var HostAPI = require('../host/host-api.js');
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;

function _findTiledDocById(docId) {
    for (var i = 0; i < app.documents.length; i++) {
        if (String(app.documents[i].id) === String(docId)) return app.documents[i];
    }
    return null;
}

async function _withTiledDocLock(ctx, taskId, docId, fn) {
    if (docId == null) throw new Error('PS 里没有打开的文档');
    if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop 全局操作锁不可用');
    return await ctx.acquirePSLock(async function() {
        var doc = _findTiledDocById(docId);
        if (!doc) {
            var closedErr = new Error('请求发起时的 PS 文档已关闭');
            closedErr.code = 'PS_DOCUMENT_CLOSED';
            throw closedErr;
        }
        if (!app.activeDocument || String(app.activeDocument.id) !== String(docId)) {
            await core.executeAsModal(async function() {
                await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: doc.id }] }], {});
            }, { commandName: '切换到分块放大目标文档' });
        }
        return await fn(doc);
    }, taskId);
}

// ============================================================
//  1. startTiledUpscale - 计算分块信息，回传确认弹窗
// ============================================================

HostAPI.registerAction('startTiledUpscale', async function(params, ctx) {
    params = params || {};
    var apiBaseUrl = params.apiBaseUrl;
    if (apiBaseUrl && apiBaseUrl.endsWith('/')) apiBaseUrl = apiBaseUrl.slice(0, -1);
    var doc = app.activeDocument;
    if (!doc) { ctx.logToPanel("[错误] 没有打开的文档", "error"); return; }
    var W = doc.width, H = doc.height;
    var tileSize = params.tileSize || 2048;
    var overlap = params.overlap || 256;

    function calcTilesForUpscale(total, tile, ov) {
        var tiles = [];
        if (total <= tile) { tiles.push({ start: 0, end: total }); return tiles; }
        var step = tile - ov;
        var pos = 0;
        while (pos + tile <= total) {
            tiles.push({ start: pos, end: pos + tile });
            pos += step;
        }
        if (tiles.length === 0 || tiles[tiles.length - 1].end < total) {
            tiles.push({ start: total - tile, end: total });
        }
        return tiles;
    }

    var xTiles = calcTilesForUpscale(W, tileSize, overlap);
    var yTiles = calcTilesForUpscale(H, tileSize, overlap);
    var totalTiles = xTiles.length * yTiles.length;
    var totalJobs = totalTiles * (params.batchSize || 1);

    // 构建分块信息
    var tileInfos = [];
    for (var yi = 0; yi < yTiles.length; yi++) {
        for (var xi = 0; xi < xTiles.length; xi++) {
            tileInfos.push({
                xi: xi, yi: yi,
                left: xTiles[xi].start, top: yTiles[yi].start,
                right: xTiles[xi].end, bottom: yTiles[yi].end,
                width: xTiles[xi].end - xTiles[xi].start,
                height: yTiles[yi].end - yTiles[yi].start
            });
        }
    }

    var confirmMsg = "文档 " + doc.name + " (" + W + "x" + H + ")\n"
        + "分块: " + xTiles.length + "列 × " + yTiles.length + "行 = " + totalTiles + " 块\n"
        + "每块计算 " + (params.batchSize || 1) + " 次，共 " + totalJobs + " 个API请求\n"
        + "确定开始分块放大？";

    var docPath = '';
    try { docPath = doc.path ? String(doc.path) : ''; } catch (_) {}
    ctx.sendToPanel('confirmTiledUpscale', {
        message: confirmMsg,
        params: {
            prompt: params.prompt, apiKey: params.apiKey, apiBaseUrl: apiBaseUrl,
            model: params.model, size: params.size, provider: params.provider,
            batchSize: params.batchSize || 1, timeout: params.timeout,
            layerType: params.layerType, maxResolution: params.maxResolution,
            tileSize: tileSize, overlap: overlap,
            docId: doc.id, docName: doc.name, docPath: docPath, docWidth: W, docHeight: H,
            tileInfos: tileInfos,
            taskId: params.taskId,   // #1: 透传前端的 taskId, 确认后沿用同一个 id(否则卡片残留)
            autoReturn: params.autoReturn !== false
        }
    });
}, { tileId: 'tiled' });

// ============================================================
//  2. confirmTiledUpscaleYes - 用户确认后执行分块放大
// ============================================================

HostAPI.registerAction('confirmTiledUpscaleYes', async function(params, ctx) {
    params = params || {};
    var tiledTaskId = params.taskId || ('tiled_' + Date.now());   // #1: 沿用前端 id, 保证卡片能被正确移除

    // Keep billing state outside the main try block so a fatal Photoshop/post-process
    // error can still settle the API calls that actually ran.
    var apiAttemptCount = 0;
    var apiSuccessCount = 0;
    var apiFailCount = 0;
    var completedCount = 0;
    var returnFailedCount = 0;
    var tileInfos = [];
    var tileResults = {}; // tileIdx -> [{ success, attempted, data, batchIdx, returned, pending }]
    var tiledPendingItems = [];
    var allGroupLayerIds = [];
    var taskCompletionSent = false;
    var tiledCompletionSent = false;

    function _tiledSelection(tileInfo) {
        if (!tileInfo) return null;
        return {
            left: tileInfo.left, top: tileInfo.top,
            right: tileInfo.right, bottom: tileInfo.bottom,
            width: tileInfo.width, height: tileInfo.height
        };
    }

    function _collectUnreturnedApiResults() {
        for (var resultKey in tileResults) {
            if (!Object.prototype.hasOwnProperty.call(tileResults, resultKey)) continue;
            var rows = tileResults[resultKey] || [];
            var resultTile = tileInfos[parseInt(resultKey, 10)];
            for (var resultIdx = 0; resultIdx < rows.length; resultIdx++) {
                var row = rows[resultIdx];
                if (!row || !row.success || !row.data || row.returned || row.pending) continue;
                tiledPendingItems.push({
                    base64: row.data,
                    docId: params.docId,
                    selection: _tiledSelection(resultTile),
                    antiMode: 0,
                    layerType: params.layerType,
                    returnWorkflowKey: 'tiledUpscale'
                });
                row.pending = true;
            }
        }
    }

    function _cacheTiledPendingItems() {
        if (tiledPendingItems.length === 0) return;
        ctx.g_taskResultCache[tiledTaskId] = {
            originDocId: params.docId,
            items: tiledPendingItems.slice(),
            payloads: tiledPendingItems.map(function(it) { return it.base64; }),
            groupName: '分块放大',
            returnWorkflowKey: 'tiledUpscale',
            docName: params.docName || '',
            engine: 'tiled'
        };
    }

    function _sendTiledCompleteOnce(extra) {
        if (tiledCompletionSent) return;
        ctx.sendToPanel('tiledUpscaleComplete', Object.assign({
            taskId: tiledTaskId,
            successCount: apiSuccessCount,
            generatedCount: apiSuccessCount,
            returnedCount: completedCount,
            pendingCount: tiledPendingItems.length,
            failCount: apiFailCount
        }, extra || {}));
        tiledCompletionSent = true;
    }

    function _sendTaskCompleteOnce(extra) {
        if (taskCompletionSent) return;
        var receipt = Object.assign({
            taskId: tiledTaskId,
            successCount: apiSuccessCount,
            generatedCount: apiSuccessCount,
            returnedCount: completedCount,
            pendingCount: tiledPendingItems.length,
            failCount: apiFailCount,
            provider: params.provider || '',
            engine: 'tiled',
            model: params.model || '',
            size: params.size || '',
            docName: params.docName || '',
            docPath: params.docPath || ''
        }, extra || {});
        if (typeof ctx.sendTaskCompleteOnce === 'function') {
            ctx.sendTaskCompleteOnce(tiledTaskId, receipt);
        } else {
            ctx.sendToPanel('taskComplete', receipt);
        }
        taskCompletionSent = true;
    }

    try {
    ctx.g_layerTypeRef.value = params.layerType;
    ctx.g_maxResolutionRef.value = params.maxResolution;
    ctx.g_taskEarlyStop[tiledTaskId] = false;
    ctx.g_taskAutoReturn[tiledTaskId] = params.autoReturn !== false;
    ctx.sendToPanel('tiledUpscaleStarted', { taskId: tiledTaskId });
    if (!params.prompt || !String(params.prompt).trim()) {
        var emptyPromptError = new Error('提示词为空，未发送 API 请求');
        emptyPromptError.error_category = 'tiled.preflight.empty_prompt';
        throw emptyPromptError;
    }
    if (params.provider === 'aji' && (!params.apiBaseUrl || !String(params.apiBaseUrl).trim())) {
        var missingUrlError = new Error('AJI 服务地址缺失，未发送 API 请求');
        missingUrlError.error_category = 'tiled.preflight.missing_url';
        throw missingUrlError;
    }
    ctx.logToPanel("========================================", "info");
    ctx.logToPanel("[分块放大] 开始处理 - " + params.docName, "info");
    ctx.logToPanel("[分块放大] 分块数: " + params.tileInfos.length + ", 每块batch: " + params.batchSize + ", 总请求: " + (params.tileInfos.length * params.batchSize), "info");

    // === 第一阶段：串行抓取每个分块的base64 ===
    var allJobs = []; // { tileIdx, batchIdx, base64, tileInfo, label }
    tileInfos = params.tileInfos || [];

    for (var ti = 0; ti < tileInfos.length; ti++) {
        if (ctx.g_earlyStopRef.value || ctx.g_taskEarlyStop[tiledTaskId]) { ctx.logToPanel("[提前结束] 抓取阶段已中止", "warn"); break; }
        var tile = tileInfos[ti];
        var tileLabel = "Tile_" + tile.xi + "_" + tile.yi;
        ctx.logToPanel("[分块放大] 抓取 " + tileLabel + " [" + tile.left + "," + tile.top + " ~ " + tile.right + "," + tile.bottom + "]...", "info");

        try {
            var selectionObj = {
                left: tile.left, top: tile.top,
                right: tile.right, bottom: tile.bottom,
                width: tile.width, height: tile.height
            };
            var result = await _withTiledDocLock(ctx, tiledTaskId, params.docId, async function() {
                return await ctx.getSelectionAndImage(selectionObj);
            });
            if (!result || !result.base64) {
                ctx.logToPanel("[错误] 抓取 " + tileLabel + " 失败", "error");
                continue;
            }

            // 为每个batch生成一个job
            for (var bi = 0; bi < params.batchSize; bi++) {
                allJobs.push({
                    tileIdx: ti, batchIdx: bi,
                    base64: result.base64,
                    tileInfo: tile,
                    label: "[" + tileLabel + " #" + (bi + 1) + "]"
                });
            }
        } catch (err) {
            if (err && err.code === 'PS_DOCUMENT_CLOSED') throw err;
            ctx.logToPanel("[错误] 抓取 " + tileLabel + " 异常: " + err.message, "error");
        }
    }

    if (allJobs.length === 0) {
        ctx.logToPanel("[错误] 没有可处理的分块", "error");
        _sendTiledCompleteOnce({ error_category: 'tiled.no_jobs' });
        _sendTaskCompleteOnce({ error_category: 'tiled.no_jobs' });
        return;
    }

    var totalJobs = allJobs.length;
    ctx.logToPanel("[分块放大] 共 " + totalJobs + " 个请求，开始全部并发...", "info");

    // === 第二阶段：全部并发API请求 ===
    var MAX_CONCURRENCY = 20;
    var pool = ctx.createConcurrencyPool(MAX_CONCURRENCY);
    // 按 tileIdx 分组
    var jobPromises = allJobs.map(function(job) {
        var tKey = String(job.tileIdx);
        if (!tileResults[tKey]) tileResults[tKey] = [];

        return pool.add(async function() {
            if (ctx.g_earlyStopRef.value || ctx.g_taskEarlyStop[tiledTaskId]) {
                ctx.sendToPanel('tiledUpscaleProgress', { total: totalJobs, status: 'fail' });
                // Stopped while still queued: no API request was made, so this is not billable.
                tileResults[tKey].push({ success: false, attempted: false, batchIdx: job.batchIdx });
                return;
            }
            var requestAttempted = false;
            var requestOutcomeRecorded = false;
            try {
                ctx.logToPanel(job.label + " 发送请求...", "info");
                var _tiledJobStart = Date.now();
                var _tArch = {
                    id: tiledTaskId + '_t' + job.tileIdx + '_b' + job.batchIdx + '_' + Date.now(),
                    batchId: tiledTaskId,    // 分块大图: 整张图所有 tile 共一个 batchId
                    workflow: 'tiled',
                    prompt: params.prompt,
                    model: params.model,
                    provider: params.provider,
                    size: params.size,
                    aspectRatio: params.aspectRatio,
                    context: {
                        docId: params.docId,
                        docName: params.docName || '',
                        docPath: (function(){ try { var _d = app.documents.find(function(dd){ return dd.id === params.docId; }); return (_d && _d.path) ? String(_d.path) : ''; } catch(_) { return ''; } })(),
                        selection: (job.tileInfo && job.tileInfo.selection) || null,
                        antiMode: 0,
                        layerType: params.layerType || 'smartObject',
                        groupName: '分块放大'
                    },
                    extras: { tileIdx: job.tileIdx, batchIdx: job.batchIdx }
                };
                var requestPromise = ctx.callAiApi(params.apiKey, params.prompt, job.base64, params.size, params.timeout, params.apiBaseUrl, null, params.model, params.provider, tiledTaskId, params.aspectRatio, {
                    archiveCallback: function(b64, st, err) { return ctx.archiveToRecycleBin(_tArch, b64, st, err); }
                });
                requestAttempted = true;
                apiAttemptCount++;
                var resultBase64 = await requestPromise;
                if (!resultBase64) throw new Error('AI did not return an image');
                tileResults[tKey].push({ success: true, attempted: true, data: resultBase64, batchIdx: job.batchIdx, returned: false, pending: false });
                apiSuccessCount++;
                requestOutcomeRecorded = true;
                ctx.logToPanel(job.label + " 完成 (" + ((Date.now() - _tiledJobStart) / 1000).toFixed(1) + "s)", "success");
                ctx.sendToPanel('tiledUpscaleProgress', { total: totalJobs, status: 'success' });
            } catch (err) {
                if (!requestOutcomeRecorded) {
                    var billableAttempt = requestAttempted && (!err || err.requestAttempted !== false);
                    if (billableAttempt) apiFailCount++;
                    tileResults[tKey].push({ success: false, attempted: billableAttempt, batchIdx: job.batchIdx });
                }
                ctx.logToPanel(job.label + " " + err.message, "error");
                ctx.sendToPanel('tiledUpscaleProgress', { total: totalJobs, status: 'fail' });
            }
        });
    });

    // Wait for every queued job even if an incidental reporting/logging callback throws.
    await Promise.allSettled(jobPromises);

    // 内存治理: API 已全部完成, 输入图块 base64 不再需要 → 立即释放, 避免和结果图一起堆在内存
    for (var _kj = 0; _kj < allJobs.length; _kj++) allJobs[_kj].base64 = null;

    // === 第三阶段：串行贴回 + 打组 + 白色蒙版 ===
    ctx.logToPanel("[分块放大] 开始贴回结果...", "info");
    completedCount = 0;
    var failedCount = apiFailCount;
    returnFailedCount = 0;
    allGroupLayerIds = []; // 所有创建的图层id，最后打成一个组
    tiledPendingItems = [];

    await _withTiledDocLock(ctx, tiledTaskId, params.docId, async function() {
    for (var tKey in tileResults) {
        var ti2 = parseInt(tKey);
        var tInfo = tileInfos[ti2];
        var results = tileResults[tKey];
        var successResults = results.filter(function(r) { return r.success; });
        if (successResults.length === 0) continue;
        successResults.sort(function(a, b) { return a.batchIdx - b.batchIdx; });

        var tileLabel2 = "Tile_" + tInfo.xi + "_" + tInfo.yi;

        var tileLayerIds = [];
        for (var si = 0; si < successResults.length; si++) {
            var sr = successResults[si];
            ctx.logToPanel("[分块放大] 贴回 " + tileLabel2 + " #" + (sr.batchIdx + 1), "info");
            var selObj = {
                left: tInfo.left, top: tInfo.top,
                right: tInfo.right, bottom: tInfo.bottom,
                width: tInfo.width, height: tInfo.height
            };
            try {
                var layerId = null;
                if (params.autoReturn !== false) layerId = await ctx.placeImageToSpecificDoc(sr.data, params.docId, selObj, 0, params.layerType);
                if (layerId) {
                    tileLayerIds.push(layerId);
                    completedCount++;
                    sr.returned = true;
                    sr.data = null;
                    try {
                        await ctx.applyReturnFeatherMaskToLayer(params.docId, layerId, selObj, 'tiledUpscale');
                    } catch (featherErr) {
                        ctx.logToPanel("[分块放大] 图已贴回，但羽化蒙版失败: " + ((featherErr && featherErr.message) || featherErr), "warn");
                    }
                } else {
                    if (params.autoReturn !== false) returnFailedCount++;
                    tiledPendingItems.push({ base64: sr.data, docId: params.docId, selection: selObj, antiMode: 0, layerType: params.layerType, returnWorkflowKey: 'tiledUpscale' });
                    sr.pending = true;
                }
            } catch (err) {
                ctx.logToPanel("[错误] 贴回 " + tileLabel2 + " 失败: " + err.message, "error");
                returnFailedCount++;
                tiledPendingItems.push({ base64: sr.data, docId: params.docId, selection: selObj, antiMode: 0, layerType: params.layerType, returnWorkflowKey: 'tiledUpscale' });
                sr.pending = true;
            }
        }

        // 收集所有图层id用于最终统一打组
        for (var lid = 0; lid < tileLayerIds.length; lid++) {
            allGroupLayerIds.push(tileLayerIds[lid]);
        }
    }

    // 把所有生成图层打成一个组
    if (allGroupLayerIds.length > 0) {
        try {
            await core.executeAsModal(async function() {
                await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: params.docId }] }], {});
                await ctx.createGroupAndMask(allGroupLayerIds, "分块放大 " + params.docName + " " + tileInfos.length + "块");
            }, { commandName: "分块打组" });
        } catch (err) {
            ctx.logToPanel("[错误] 创建组失败: " + err.message, "error");
        }
        // 教学模式
        if (ctx.g_teachModeRef && ctx.g_teachModeRef.value) {
            var rfApplied = ctx.shouldApplyReturnFeather && ctx.shouldApplyReturnFeather('tiledUpscale');
            var rfCfg = rfApplied ? {
                enabled: true,
                shrink: ctx.g_returnFeatherShrinkPercentRef && ctx.g_returnFeatherShrinkPercentRef.value,
                blur: ctx.g_returnFeatherBlurPercentRef && ctx.g_returnFeatherBlurPercentRef.value
            } : { enabled: false };
            try {
                await ctx.createTeachingMaterials({
                    docId: params.docId,
                    prompt: params.prompt,
                    model: params.model,
                    provider: params.provider,
                    size: params.size,
                    aspectRatio: params.aspectRatio,
                    batch: allGroupLayerIds.length,
                    antiMode: 0,
                    returnFeather: rfCfg,
                    promptPresetName: params.presetTitle || '',
                    refImageBase64s: [],
                    taskId: tiledTaskId
                });
            } catch (teachErr) {
                ctx.logToPanel("[分块放大] 图已贴回，但教学材料创建失败: " + ((teachErr && teachErr.message) || teachErr), "warn");
            }
        }
    }
    });
    if (tiledPendingItems.length > 0) {
        _cacheTiledPendingItems();
        if (params.autoReturn !== false) ctx.sendToPanel('taskAutoReturnFailed', { taskId: tiledTaskId, count: tiledPendingItems.length, returnedCount: completedCount });
    }
    if (allGroupLayerIds.length > 0) {
        ctx.sendToPanel('conversationEvent', {
            type: 'attach-layers',
            taskId: tiledTaskId,
            layerIDs: allGroupLayerIds,
            docId: params.docId
        });
    }

    ctx.logToPanel("========================================", "info");
    ctx.logToPanel("[分块放大] 完成！生成: " + (completedCount + tiledPendingItems.length)
        + ", 已贴回: " + completedCount + ", 待返回: " + tiledPendingItems.length
        + ", 生成失败: " + failedCount + (returnFailedCount ? ", 贴回异常: " + returnFailedCount : ""),
        completedCount > 0 && tiledPendingItems.length === 0 ? "success" : "warn");
    _sendTaskCompleteOnce();
    _sendTiledCompleteOnce();
    } catch (e) {
        // #2 兜底: 注册卡片后任何阶段抛异常, 都发完成(带 taskId 移除卡片) + 复位, 防永久残留
        try { ctx.logToPanel("[分块放大] 致命错误: " + ((e && e.message) || e), "error"); } catch (_) {}
        // Preserve every successful API result that was not already returned to Photoshop.
        try { _collectUnreturnedApiResults(); } catch (_) {}
        var fatalCategory = (e && e.error_category) || 'tiled.fatal';
        _sendTaskCompleteOnce({ error: (e && e.message) || String(e), error_category: fatalCategory });
        try {
            _cacheTiledPendingItems();
            if (tiledPendingItems.length > 0 && params.autoReturn !== false) {
                ctx.sendToPanel('taskAutoReturnFailed', { taskId: tiledTaskId, count: tiledPendingItems.length, returnedCount: completedCount });
            }
        } catch (cacheErr) {
            try { ctx.logToPanel('[tiled] Failed to cache pending API results: ' + ((cacheErr && cacheErr.message) || cacheErr), 'error'); } catch (_) {}
        }
        _sendTiledCompleteOnce({ error: (e && e.message) || String(e), error_category: fatalCategory });
        // bug #18: 不再无条件清全局 g_earlyStop(会误擦别的任务的停止); 本任务用 per-task 标志
    }
}, { tileId: 'tiled' });

// ============================================================
//  3. tiledFillTest - 颜色填充可视化测试
// ============================================================

HostAPI.registerAction('tiledFillTest', async function(data, ctx) {
    try {
        var overlap = data.overlap;
        var tileSize = data.tileSize;
        var doc = app.activeDocument;
        if (!doc) throw new Error('PS 里没有打开的文档');
        var docId = doc.id;
        var W = doc.width;
        var H = doc.height;
        ctx.logToPanel('[TiledTest] 文档尺寸: ' + W + 'x' + H + ', tileSize=' + tileSize + ', overlap=' + overlap);

        // 计算分块 - 保证每块都是 tile x tile 正方形
        function calcTiles(total, tile, ov) {
            var tiles = [];
            if (total <= tile) { tiles.push({ start: 0, end: total }); return tiles; }
            var step = tile - ov;
            var pos = 0;
            while (pos + tile <= total) {
                tiles.push({ start: pos, end: pos + tile });
                pos += step;
            }
            if (tiles.length === 0 || tiles[tiles.length - 1].end < total) {
                tiles.push({ start: total - tile, end: total });
            }
            return tiles;
        }

        var xTiles = calcTiles(W, tileSize, overlap);
        var yTiles = calcTiles(H, tileSize, overlap);
        var totalTiles = xTiles.length * yTiles.length;
        ctx.logToPanel('[TiledTest] 分块网格: ' + xTiles.length + 'x' + yTiles.length + ' = ' + totalTiles + ' 块');

        // 颜色列表
        var colors = [
            {r:255,g:0,b:0},{r:0,g:255,b:0},{r:0,g:0,b:255},
            {r:255,g:255,b:0},{r:255,g:0,b:255},{r:0,g:255,b:255},
            {r:255,g:128,b:0},{r:128,g:0,b:255},{r:0,g:128,b:255},
            {r:255,g:0,b:128},{r:128,g:255,b:0},{r:0,g:255,b:128},
            {r:200,g:100,b:50},{r:50,g:100,b:200},{r:200,g:50,b:150},
            {r:100,g:200,b:100},{r:150,g:50,b:200},{r:50,g:200,b:150}
        ];

        var tileIdx = 0;
        await _withTiledDocLock(ctx, (data && data.taskId) || 'tiled-fill-test', docId, async function() {
            await core.executeAsModal(async function() {
                var batchPlay = require('photoshop').action.batchPlay;

                // 创建编组
                await batchPlay([{ _obj: 'make', _target: [{ _ref: 'layerSection' }], name: 'TiledTest ' + xTiles.length + 'x' + yTiles.length }], { synchronousExecution: true });

                for (var yi = 0; yi < yTiles.length; yi++) {
                    for (var xi = 0; xi < xTiles.length; xi++) {
                        var x1 = xTiles[xi].start;
                        var y1 = yTiles[yi].start;
                        var x2 = xTiles[xi].end;
                        var y2 = yTiles[yi].end;
                        var color = colors[tileIdx % colors.length];

                        // 创建新图层
                        await batchPlay([{ _obj: 'make', _target: [{ _ref: 'layer' }], using: { _obj: 'layer', name: 'Tile_' + xi + '_' + yi + ' [' + x1 + ',' + y1 + '-' + x2 + ',' + y2 + ']', opacity: { _unit: 'percentUnit', _value: 40 } } }], { synchronousExecution: true });

                        // 设置选区
                        await batchPlay([{ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _obj: 'rectangle', top: { _unit: 'pixelsUnit', _value: y1 }, left: { _unit: 'pixelsUnit', _value: x1 }, bottom: { _unit: 'pixelsUnit', _value: y2 }, right: { _unit: 'pixelsUnit', _value: x2 } } }], { synchronousExecution: true });

                        // 设置前景色
                        await batchPlay([{ _obj: 'set', _target: [{ _ref: 'color', _property: 'foregroundColor' }], to: { _obj: 'RGBColor', red: color.r, grain: color.g, blue: color.b } }], { synchronousExecution: true });

                        // 填充
                        await batchPlay([{ _obj: 'fill', using: { _enum: 'fillContents', _value: 'foregroundColor' }, opacity: { _unit: 'percentUnit', _value: 100 } }], { synchronousExecution: true });

                        // 取消选区
                        await batchPlay([{ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _enum: 'ordinal', _value: 'none' } }], { synchronousExecution: true });

                        tileIdx++;
                        ctx.logToPanel('[TiledTest] 已填充 Tile ' + tileIdx + '/' + totalTiles + ' (' + x1 + ',' + y1 + ' - ' + x2 + ',' + y2 + ')');
                    }
                }
            }, { commandName: 'TiledFillTest' });
        });

        ctx.logToPanel('[TiledTest] 完成! 共 ' + totalTiles + ' 块', 'success');
        ctx.sendToPanel('tiledFillTestComplete', { success: true, count: totalTiles });
    } catch (err) {
        ctx.logToPanel('[TiledTest] ' + err.message, 'error');
        ctx.sendToPanel('tiledFillTestComplete', { success: false, error: err.message });
    }
}, { tileId: 'tiled' });

module.exports = {};
