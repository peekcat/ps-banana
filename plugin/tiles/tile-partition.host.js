// ============================================================
//  tile-partition.host.js
//  全局分区计算的后端处理器
//  通过 HostAPI.registerAction 注册到路由表
// ============================================================

var HostAPI = require('../host/host-api.js');
var concurrencyPool = require('../host/concurrency-pool.js');
var evidenceLog = require('../host/evidence-log.js');   // 证据日志: 指纹+签章链
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;

function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

// ============================================================
//  startGlobalPartition — 计算分区信息，弹确认框
// ============================================================

HostAPI.registerAction('startGlobalPartition', async function(params, ctx) {
    params = params || {};
    var apiBaseUrl = params.apiBaseUrl;
    if (apiBaseUrl && apiBaseUrl.endsWith('/')) apiBaseUrl = apiBaseUrl.slice(0, -1);
    var docs = app.documents;
    if (docs.length === 0) { ctx.logToPanel("[错误] 没有打开的文档", "error"); return; }
    var selectedIds = params.selectedDocIds;
    var totalSelections = 0, docInfos = [];
    for (var d = 0; d < docs.length; d++) {
        var doc = docs[d];
        if (selectedIds && selectedIds.length > 0 && selectedIds.indexOf(doc.id) === -1) continue;
        var selections = ctx.calculatePartitionSelections(doc.width, doc.height);
        totalSelections += selections.length * params.batchSize;
        var _docPath = null;
        try { _docPath = doc.path || null; } catch(_dpErr) {}   // 未保存文档取 path 会抛/为空
        docInfos.push({ id: doc.id, name: doc.name, path: _docPath ? String(_docPath) : '', width: doc.width, height: doc.height, selections: selections });
    }
    var confirmMsg = "即将处理 " + docInfos.length + " 个文档，共 " + totalSelections + " 个任务。确定继续吗？";
    ctx.sendToPanel('confirmGlobalPartition', { message: confirmMsg, params: {
        prompt: params.prompt, apiKey: params.apiKey, apiBaseUrl: apiBaseUrl,
        size: params.size, batchSize: params.batchSize, timeout: params.timeout,
        model: params.model, provider: params.provider,
        maskInsetPx: Math.max(0, (isNaN(parseInt(params.maskInsetPx, 10)) ? 400 : parseInt(params.maskInsetPx, 10))),
        maskBlurPx: Math.max(0, (isNaN(parseInt(params.maskBlurPx, 10)) ? 200 : parseInt(params.maskBlurPx, 10))),
        antiMode: params.antiMode, layerType: params.layerType, maxResolution: params.maxResolution,
        aspectRatio: params.aspectRatio, docInfos: docInfos,
        autoReturn: params.autoReturn !== false
    }});
}, { tileId: 'partition' });

// ============================================================
//  confirmGlobalPartitionYes — 执行全局分区
// ============================================================

HostAPI.registerAction('confirmGlobalPartitionYes', async function(params, ctx) {
    ctx.g_antiTruncationModeRef.value = params.antiMode;
    ctx.g_layerTypeRef.value = params.layerType;
    ctx.g_maxResolutionRef.value = params.maxResolution;
    var partitionTaskId = 'global_' + Date.now();
    ctx.g_taskEarlyStop[partitionTaskId] = false;
    var docInfos = params.docInfos;
    ctx.sendToPanel('globalStarted', { taskId: partitionTaskId });
    var _partStartTs = Date.now();   // 证据日志: 任务开始时间
    // 缓存重构: 每个 [文档×分区] 一个叶子文件夹(名字带选区名), 跟着自己的文档进对应项目文件夹
    // groupFolders[groupKey] = { folder, runPath, inputHash }
    var groupFolders = {};
    var groupReturnState = {};

    // #4: 为每个 [文档 × 分区] 注册一条任务列表条目, 之后按子任务ID路由进度/完成/中断
    var registeredTasks = [];
    for (var rdi = 0; rdi < docInfos.length; rdi++) {
        var rdInfo = docInfos[rdi];
        for (var rsj = 0; rsj < rdInfo.selections.length; rsj++) {
            var rsName = rdInfo.selections[rsj].name;
            var rSubId = partitionTaskId + '_' + rdInfo.id + '_' + rsName;
            ctx.g_taskEarlyStop[rSubId] = false;
            registeredTasks.push({
                taskId: rSubId, docId: rdInfo.id, docName: rdInfo.name,
                selName: rsName, docPath: rdInfo.path || '', batchSize: params.batchSize, timeout: params.timeout,
                model: params.model, provider: params.provider, size: params.size
            });
        }
    }
    ctx.sendToPanel('partitionTasksRegistered', { tasks: registeredTasks, autoReturn: params.autoReturn !== false });

    function _completeAllPartitionTasks() {
        // 逐个结算所有已注册的条目(含被中断/无结果的), 保证任务列表里的卡片都能被移除
        for (var fci = 0; fci < registeredTasks.length; fci++) {
            var frt = registeredTasks[fci];
            var fgk = frt.docId + '_' + frt.selName;
            var fres = (typeof groupResults !== 'undefined' && groupResults[fgk]) ? groupResults[fgk] : [];
            var fsucc = 0;
            for (var fi = 0; fi < fres.length; fi++) { if (fres[fi].success) fsucc++; }
            var fstate = groupReturnState[fgk] || { returned: 0, pending: 0 };
            ctx.sendTaskCompleteOnce(frt.taskId, {
                taskId: frt.taskId,
                successCount: fsucc, generatedCount: fsucc,
                returnedCount: fstate.returned || 0,
                pendingCount: fstate.pending || 0,
                failCount: fres.length ? fres.filter(function(r) { return !r.success && r.attempted !== false; }).length : 0,
                size: params.size, model: params.model,
                provider: params.provider || '', engine: 'partition', docName: frt.docName || '', docPath: frt.docPath || ''
            });
        }
    }
    ctx.logToPanel("========================================", "info");
    ctx.logToPanel("[全局] 开始分区计算，文档数: " + docInfos.length, "info");

    try {

    // === 第一阶段：串行抓取所有文档的所有分区选区 ===
    var allJobs = [];
    for (var docIndex = 0; docIndex < docInfos.length; docIndex++) {
        var docInfo = docInfos[docIndex];
        ctx.logToPanel("[文档 " + (docIndex+1) + "/" + docInfos.length + "] " + docInfo.name + " 抓取选区...", "info");
        try {
            await core.executeAsModal(async function() {
                await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: docInfo.id }] }], {});
            }, { commandName: "切换文档" });
        } catch (e) { ctx.logToPanel("  [错误] 无法切换文档: " + e.message, "error"); continue; }
        for (var si = 0; si < docInfo.selections.length; si++) {
            try {
                var capture = await ctx.getSelectionAndImage(docInfo.selections[si]);
                if (capture) {
                    // #4: 给该 [文档×分区] 的任务卡片发缩略图
                    ctx.sendToPanel('previewImage', { taskId: partitionTaskId + '_' + docInfo.id + '_' + docInfo.selections[si].name, base64: capture.base64, selection: docInfo.selections[si], docId: docInfo.id });
                    // 该 [文档×分区] 的叶子文件夹: 同一分区 batchSize 张共用一张 input, 只存一次
                    var _gk = docInfo.id + '_' + docInfo.selections[si].name;
                    try {
                        var _gFolder = await ctx.createImageCacheRunFolder({
                            engine: 'api', taskId: partitionTaskId + '_' + _gk,
                            label: '分区' + (docInfo.selections[si].name || ''),
                            docName: docInfo.name || '',
                            docPath: docInfo.path || '',
                            docId: docInfo.id
                        });
                        groupFolders[_gk] = { folder: _gFolder, runPath: (_gFolder && (_gFolder.wcRunPath || _gFolder.name)) || '' };
                        await ctx.saveImageToRunFolder(_gFolder, 'input', capture.base64, 1);
                    } catch (gfErr) {
                        ctx.logToPanel("  [分区缓存] 创建文件夹失败(生成继续, 该分区不落缓存): " + (gfErr.message || gfErr), "warn");
                    }
                    for (var bj = 0; bj < params.batchSize; bj++) {
                        allJobs.push({
                            docId: docInfo.id, docName: docInfo.name, docPath: docInfo.path || '',
                            docWidth: docInfo.width, docHeight: docInfo.height,
                            selection: docInfo.selections[si], base64: capture.base64,
                            antiMode: params.antiMode, layerType: params.layerType,
                            selName: docInfo.selections[si].name, jobIdx: bj + 1
                        });
                    }
                    ctx.logToPanel("  [分区 " + docInfo.selections[si].name + "] 抓取完成", "success");
                }
            } catch (e) { ctx.logToPanel("  [分区抓取失败] " + e.message, "error"); }
            await sleep(100);
        }
        await ctx.deselectAll();
    }

    var totalJobs = allJobs.length;
    if (totalJobs === 0) {
        ctx.logToPanel("[错误] 没有可处理的分区", "error");
        _completeAllPartitionTasks();
        ctx.sendToPanel('globalComplete', {});
        return;
    }
    ctx.logToPanel("[全局] 共 " + totalJobs + " 个请求，开始全部并发...", "info");

    // === 第二阶段：全部并发API请求 ===
    var MAX_CONCURRENCY = 20;
    var pool = concurrencyPool.createConcurrencyPool(MAX_CONCURRENCY);
    var groupResults = {};
    var groupMeta = {};

    var jobPromises = allJobs.map(function(job) {
        var groupKey = job.docId + '_' + job.selName;
        if (!groupResults[groupKey]) {
            groupResults[groupKey] = [];
            groupMeta[groupKey] = {
                docId: job.docId,
                selection: job.selection,
                antiMode: job.antiMode,
                layerType: job.layerType,
                selName: job.selName,
                docName: job.docName,
                docPath: job.docPath || '',
                docWidth: job.docWidth,
                docHeight: job.docHeight
            };
        }
        var label = "[" + job.docName + "/" + job.selName + " #" + job.jobIdx + "]";
        var subTaskId = partitionTaskId + '_' + groupKey;  // #4: 该 [文档×分区] 的任务列表条目ID
        return pool.add(async function() {
            try {
                if (ctx.g_taskEarlyStop[partitionTaskId + '_' + groupKey] || ctx.g_taskEarlyStop[partitionTaskId]) {
                    groupResults[groupKey].push({ success: false, attempted: false, jobIdx: job.jobIdx });
                    try {
                        ctx.sendToPanel('globalProgress', { total: totalJobs, status: 'fail' });
                        ctx.sendToPanel('taskProgress', { taskId: subTaskId, total: params.batchSize, status: 'fail' });
                    } catch (_) {}
                    return;
                }
                try { ctx.logToPanel(label + " 发送请求...", "info"); } catch (_) {}
                var _partJobStart = Date.now();
                var _pArch = {
                    id: partitionTaskId + '_' + groupKey + '_' + job.jobIdx + '_' + Date.now(),
                    batchId: partitionTaskId + '_' + groupKey,
                    workflow: 'partition',
                    prompt: params.prompt,
                    model: params.model,
                    provider: params.provider,
                    size: params.size,
                    aspectRatio: params.aspectRatio,
                    presetTitle: params.presetTitle || '',
                    context: {
                        docId: job.docId,
                        docName: job.docName || '',
                        docPath: job.docPath || '',
                        selection: job.selection,
                        antiMode: job.antiMode,
                        layerType: job.layerType,
                        groupName: '全局分区: ' + (job.selName || '')
                    },
                    extras: { selName: job.selName, jobIdx: job.jobIdx }
                };
                var resultBase64 = await ctx.callAiApi(params.apiKey, params.prompt, job.base64, params.size, params.timeout, params.apiBaseUrl, null, params.model, params.provider, subTaskId, params.aspectRatio, {
                    archiveCallback: function(b64, st, err) { return ctx.archiveToRecycleBin(_pArch, b64, st, err); }
                });
                groupResults[groupKey].push({ success: true, attempted: true, data: resultBase64, jobIdx: job.jobIdx });
                try {
                    ctx.logToPanel(label + " 完成 (" + ((Date.now() - _partJobStart) / 1000).toFixed(1) + "s)", "success");
                    ctx.sendToPanel('globalProgress', { total: totalJobs, status: 'success' });
                    ctx.sendToPanel('taskProgress', { taskId: subTaskId, total: params.batchSize, status: 'success' });
                } catch (_) {}
            } catch (err) {
                groupResults[groupKey].push({ success: false, attempted: !(err && err.requestAttempted === false), jobIdx: job.jobIdx });
                try {
                    ctx.logToPanel(label + " " + err.message, "error");
                    ctx.sendToPanel('globalProgress', { total: totalJobs, status: 'fail' });
                    ctx.sendToPanel('taskProgress', { taskId: subTaskId, total: params.batchSize, status: 'fail' });
                } catch (_) {}
                try { await ctx.playSingleFailSound(); } catch (_) {}
            }
        });
    });

    await Promise.all(jobPromises);
    // 内存治理: API 已全部完成, 输入图 base64 不再需要 → 立即释放, 避免和结果图一起堆在内存
    // (证据日志要的 input 指纹在释放前按组算好存下, 一组一次; 用分片异步版不堵事件循环)
    var _groupInputHash = {};
    for (var _kj = 0; _kj < allJobs.length; _kj++) {
        var _hk = allJobs[_kj].docId + '_' + allJobs[_kj].selName;
        if (allJobs[_kj].base64 && !_groupInputHash[_hk]) {
            try { _groupInputHash[_hk] = await evidenceLog.sha256HexOfBase64Async(allJobs[_kj].base64); } catch(_he) {}
        }
        allJobs[_kj].base64 = null;
    }

    // 每组落缓存: output 组内编号从 1 起(与本组 input_001 对应) + prompt.txt + 证据日志
    // 贴回前先落盘 — 中断/贴回失败缓存也保得住
    var _gkList = Object.keys(groupResults);
    for (var _gi2 = 0; _gi2 < _gkList.length; _gi2++) {
        var _gk2 = _gkList[_gi2];
        var _gf = groupFolders[_gk2];
        if (!_gf || !_gf.folder) continue;
        var _gres = groupResults[_gk2].filter(function(r) { return r.success; });
        _gres.sort(function(a, b) { return a.jobIdx - b.jobIdx; });
        for (var _oi = 0; _oi < _gres.length; _oi++) {
            await ctx.saveImageToRunFolder(_gf.folder, 'output', _gres[_oi].data, _oi + 1);
        }
        await ctx.savePromptTxtToRunFolder(_gf.folder, params.prompt || '');
        var _gm = groupMeta[_gk2] || {};
        evidenceLog.appendEvidence({
            runFolder: _gf.folder,
            runPath: _gf.runPath,
            taskId: partitionTaskId + '_' + _gk2,
            startTs: _partStartTs,
            endTs: Date.now(),
            engine: 'api',
            model: params.model || '',
            source: params.provider || '',
            docName: _gm.docName || '',
            prompt: params.prompt || '',
            inputHashes: _groupInputHash[_gk2] ? [_groupInputHash[_gk2]] : [],
            outputs: _gres.map(function(r) { return r.data; })
        }).then((function(gkLabel) { return function(evRes) {
            if (evRes && evRes.ok) ctx.logToPanel('[证据日志] ' + gkLabel + ' 链号#' + evRes.seq, 'info');
            else ctx.logToPanel('[证据日志] ' + gkLabel + ' 写入失败(不影响生成): ' + ((evRes && evRes.error) || '?'), 'warn');
        }; })(_gk2));
    }

    // === 第三阶段：串行贴回所有成功结果并打组 ===
    var completedCount = 0, failedCount = 0;
    var maskInsetPx = Math.max(0, (isNaN(parseInt(params.maskInsetPx, 10)) ? 400 : parseInt(params.maskInsetPx, 10)));
    var maskBlurPx = Math.max(0, (isNaN(parseInt(params.maskBlurPx, 10)) ? 200 : parseInt(params.maskBlurPx, 10)));

    function getGlobalSelectionOrder(meta) {
        if (!meta) return 99;
        var name = meta.selName || '';
        var w = meta.docWidth || 0;
        var h = meta.docHeight || 0;
        if (w > h) {
            if (name === '左上') return 0;
            if (name === '右上') return 1;
            return 9;
        }
        if (h > w) {
            if (name === '左上') return 0;
            if (name === '左下') return 1;
            return 9;
        }
        if (name === '全图') return 0;
        return 9;
    }

    function getGlobalSeamMaskOptions(meta) {
        if (!meta || !meta.selection) return null;
        var w = meta.docWidth || 0;
        var h = meta.docHeight || 0;
        if (w > h && meta.selName === '右上') {
            return { direction: 'left', selection: meta.selection, insetPx: maskInsetPx, blurPx: maskBlurPx };
        }
        if (h > w && meta.selName === '左下') {
            return { direction: 'top', selection: meta.selection, insetPx: maskInsetPx, blurPx: maskBlurPx };
        }
        return null;
    }

    var orderedGroupKeys = Object.keys(groupResults).sort(function(a, b) {
        var ma = groupMeta[a] || {};
        var mb = groupMeta[b] || {};
        if (ma.docId !== mb.docId) return (Number(ma.docId) || 0) - (Number(mb.docId) || 0);
        return getGlobalSelectionOrder(ma) - getGlobalSelectionOrder(mb);
    });

    for (var gi = 0; gi < orderedGroupKeys.length; gi++) {
        var gk = orderedGroupKeys[gi];
        var meta = groupMeta[gk];
        var results = groupResults[gk];
        var successResults = results.filter(function(r) { return r.success; });
        failedCount += results.filter(function(r) { return !r.success && r.attempted !== false; }).length;
        if (successResults.length === 0) continue;
        // #4: 该分区子任务被中断 → 跳过贴回 (已生成结果走归档, 不自动贴回)
        if (ctx.g_taskEarlyStop[partitionTaskId + '_' + gk] || ctx.g_taskEarlyStop[partitionTaskId]) {
            ctx.logToPanel("[跳过贴回] " + gk + " 已中断", "warn");
            var stoppedSubTaskId = partitionTaskId + '_' + gk;
            var stoppedPayloads = successResults.map(function(r) { return r.data; });
            groupReturnState[gk] = { returned: 0, pending: stoppedPayloads.length };
            if (stoppedPayloads.length > 0) {
                var stoppedFolder = groupFolders[gk] || {};
                ctx.g_taskResultCache[stoppedSubTaskId] = {
                    originDocId: meta.docId, savedSelection: meta.selection || null,
                    antiMode: meta.antiMode || 0, layerType: meta.layerType || 'smartObject',
                    payloads: stoppedPayloads, groupName: meta.selName || '全局分区',
                    presetName: params.presetTitle || '', returnWorkflowKey: 'partition',
                    runFolderName: stoppedFolder.runPath || (stoppedFolder.folder && stoppedFolder.folder.name),
                    docName: meta.docName || '', engine: 'api'
                };
                ctx.sendToPanel('taskAutoReturnFailed', { taskId: stoppedSubTaskId, count: stoppedPayloads.length, returnedCount: 0 });
            }
            continue;
        }
        successResults.sort(function(a, b) { return a.jobIdx - b.jobIdx; });
        var partitionSubTaskId = partitionTaskId + '_' + gk;
        var partitionPlacedCount = 0;
        var partitionPendingPayloads = successResults.map(function(r) { return r.data; });

        if (params.autoReturn !== false) try {
        await ctx.acquirePSLock(async function() {
            ctx.logToPanel("[贴回 " + meta.docName + "/" + meta.selName + "] " + successResults.length + " 张...", "info");
            var createdLayerIds = [];
            // v6.5.8: 统一走 placeImagesAuto(急速回图开关在里面判)
            var _pIds = await ctx.placeImagesAuto(meta.docId, successResults.map(function(r) {
                return { base64: r.data, selection: meta.selection, antiMode: meta.antiMode, layerType: meta.layerType };
            }));
            partitionPendingPayloads = [];
            for (var ri = 0; ri < _pIds.length; ri++) {
                if (_pIds[ri]) {
                    createdLayerIds.push(_pIds[ri]); completedCount++;
                    successResults[ri].data = null;   // 贴成功才释放；失败项要保留供手动重试
                } else {
                    failedCount++;
                    partitionPendingPayloads.push(successResults[ri].data);
                }
            }
            partitionPlacedCount = createdLayerIds.length;
            if (createdLayerIds.length > 0 && ctx.g_autoGroupRef.value) {
                try {
                    await core.executeAsModal(async function() {
                        await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: meta.docId }] }], {});
                        await ctx.createGroupAndMask(createdLayerIds, meta.selName, getGlobalSeamMaskOptions(meta));
                    }, { commandName: "全局分区打组" });
                } catch (e) { ctx.logToPanel("  [警告] 打组失败", "warn"); }
                // 教学模式
                if (ctx.g_teachModeRef && ctx.g_teachModeRef.value) {
                    // partition 工作流不应用传回羽化
                    var rfCfg = { enabled: false };
                    await ctx.createTeachingMaterials({
                        docId: meta.docId,
                        prompt: params.prompt,
                        model: params.model,
                        provider: params.provider,
                        size: params.size,
                        aspectRatio: params.aspectRatio,
                        batch: createdLayerIds.length,
                        selection: meta.selection,
                        antiMode: meta.antiMode || 0,
                        returnFeather: rfCfg,
                        promptPresetName: params.presetTitle || '',
                        refImageBase64s: [],
                        taskId: partitionTaskId
                    });
                }
            }
            if (createdLayerIds.length > 0) {
                ctx.sendToPanel('conversationEvent', {
                    type: 'attach-layers',
                    taskId: partitionTaskId,
                    layerIDs: createdLayerIds,
                    docId: meta.docId
                });
            }
            try { await require('../host/proj-thumb.js').updateProjThumb(meta.docId, meta.docName || '', (meta.docPath || ''), ctx.sendToPanel); } catch(_pt) {}
        }, partitionTaskId + '_' + gk);
        } catch (pasteErr) {
            // #4: 单组贴回异常不应中断整个循环, 否则末尾的 _completeAllPartitionTasks 跑不到 → 孤儿卡片
            ctx.logToPanel("[贴回出错] " + gk + ": " + ((pasteErr && pasteErr.message) || pasteErr), "error");
        }
        groupReturnState[gk] = { returned: partitionPlacedCount, pending: partitionPendingPayloads.length };
        if (partitionPendingPayloads.length > 0) {
            var _partFolder = groupFolders[gk] || {};
            ctx.g_taskResultCache[partitionSubTaskId] = {
                originDocId: meta.docId,
                savedSelection: meta.selection || null,
                antiMode: meta.antiMode || 0,
                layerType: meta.layerType || 'smartObject',
                payloads: partitionPendingPayloads.slice(),
                groupName: meta.selName || '全局分区',
                presetName: params.presetTitle || '',
                returnWorkflowKey: 'partition',
                runFolderName: _partFolder.runPath || (_partFolder.folder && _partFolder.folder.name),
                docName: meta.docName || '', engine: 'api'
            };
            if (params.autoReturn !== false) ctx.sendToPanel('taskAutoReturnFailed', { taskId: partitionSubTaskId, count: partitionPendingPayloads.length, returnedCount: partitionPlacedCount });
        }
    }

    _completeAllPartitionTasks();   // #4: 逐条结算任务列表条目, 移除所有卡片
    try { ctx.logToPanel("========================================", "info"); } catch (_) {}
    // (prompt.txt 已按分区写进各自叶子文件夹)
    try { ctx.logToPanel("[完成] 成功: " + completedCount + " | 失败: " + failedCount, completedCount > 0 ? "success" : "warn"); } catch (_) {}
    try { ctx.sendToPanel('globalComplete', {}); } catch (_) {}
    // bug #18: 不再无条件清全局 g_earlyStop —— 本任务用 per-task 标志停止, 清全局会误擦别的任务的"停止"。
    //   (带 taskId 的任务不看全局标志, 注册时各自重置 per-task, 见 ai-api._runWithArchive)
    try { await ctx.playSuccessSound(); } catch (_) {}
    } catch (e) {
        // #2 兜底: 注册卡片后任何阶段抛异常, 都把已注册的卡片全部结算掉 + 复位前端, 防永久残留
        _completeAllPartitionTasks();
        try { ctx.logToPanel("[全局分区] 致命错误: " + ((e && e.message) || e), "error"); } catch (_) {}
        try { ctx.sendToPanel('globalComplete', {}); } catch (_) {}
    }
}, { tileId: 'partition' });

module.exports = {};
