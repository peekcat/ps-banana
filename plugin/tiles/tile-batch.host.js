// ============================================================
//  tile-batch.host.js
//  批处理后端处理器（addToBatch / recordableAddToBatch / runBatch）
//  从 index.js 迁移 handleAddToBatch / handleRunBatch
//  通过 HostAPI.registerAction 注册到路由表
// ============================================================

var HostAPI = require('../host/host-api.js');
var evidenceLog = require('../host/evidence-log.js');   // 证据日志: 指纹+签章链
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;

function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

// ============================================================
//  addToBatch — 添加到批处理（原 handleAddToBatch）
// ============================================================

HostAPI.registerAction('addToBatch', async function(params, ctx) {
    try {
        params = params || {};
        if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop global lock unavailable');
        await ctx.acquirePSLock(async function() {
            var doc = app.activeDocument;
            if (!doc) { ctx.logToPanel("[错误] 没有打开的文档", "error"); return; }
            // 自动扩充+裁切: 与单图生成同款(1:1 且非方形选区 → 补白凑方, 回图贴回时裁白)
            var _padOpts = (ctx.g_autoPadCropRef && ctx.g_autoPadCropRef.value && params.aspectRatio === '1:1')
                ? { padToSquare: true } : undefined;
            var captureResult = await ctx.getSelectionAndImage(undefined, _padOpts);
            if (!captureResult) { ctx.logToPanel("[错误] 抓取失败，请确保有选区", "error"); return; }
            var _docPath = null;
            try { _docPath = doc.path || null; } catch(_dpErr) {}   // 未保存文档取 path 会抛/为空
            var task = {
                id: Date.now(), docId: doc.id, docName: doc.name, docPath: _docPath ? String(_docPath) : '', prompt: params.prompt,
                base64: captureResult.base64, selection: captureResult.selection,
                refImages: params.refImages || [],
                refSelections: params.refSelections || [],
                settings: { size: params.size, aspectRatio: params.aspectRatio, model: params.model, count: params.batchSize, timeout: params.timeout, antiMode: params.antiMode, layerType: params.layerType }
            };
            ctx.sendToPanel('batchTaskAdded', { task: task });
        }, 'add-to-batch');
    } catch (e) { ctx.logToPanel("[错误] 添加失败: " + e.message, "error"); }
}, { tileId: 'batch' });

// recordableAddToBatch 已删 (PS 动作录制走 host/recordable-actions.js 全局函数, 不走此 registerAction; 前端 0 调用)

// ============================================================
//  runBatch — 运行批处理（原 handleRunBatch）
// ============================================================

HostAPI.registerAction('runBatch', async function(msgData, ctx) {
    msgData = msgData || {};
    var params = msgData.params || {}, queue = Array.isArray(msgData.queue) ? msgData.queue : [];
    try {
    var apiBaseUrl = params.apiBaseUrl;
    if (apiBaseUrl && apiBaseUrl.endsWith('/')) apiBaseUrl = apiBaseUrl.slice(0, -1);
    var batchTaskId = 'batch_' + Date.now();
    ctx.g_taskEarlyStop[batchTaskId] = false;
    ctx.sendToPanel('batchStarted', { taskId: batchTaskId });
    var MAX_CONCURRENCY = 20;
    var pool = ctx.createConcurrencyPool(MAX_CONCURRENCY);

    // 统计总任务数
    var totalJobs = 0;
    for (var q = 0; q < queue.length; q++) { totalJobs += (queue[q].settings.count || 1); }
    ctx.logToPanel("[批处理] 共 " + queue.length + " 个任务组, " + totalJobs + " 个请求, 最大并行: " + MAX_CONCURRENCY, "info");

    // 为每个任务组创建并发任务，所有任务组同时开始
    var completedJobs = 0;   // 已完成请求数(成功+失败), 用于进度条 index
    var taskGroupPromises = [];
    for (var i = 0; i < queue.length; i++) {
        var groupPromise = (async function(taskIndex, task) {
            var count = task.settings.count || 1;
            var timeout = task.settings.timeout || 3600;
            var groupLabel = "[组" + (taskIndex + 1) + "/" + queue.length + " " + task.docName + "]";
            var subTaskId = task.taskId || (batchTaskId + '_g' + taskIndex);  // #6.1: 该队列项的任务列表条目ID
            var _groupStartTs = Date.now();   // 证据日志: 该子任务开始时间
            var billingResults = null;
            try {
            // 缓存重构: 每个子任务一个叶子文件夹, 跟着自己的文档进对应项目文件夹
            // (input/output 编号也从每组 1 开始, 治了老版"整批混一个文件夹编号对不上"的毛病)
            var runFolder = null, runPath = '';
            try {
                runFolder = await ctx.createImageCacheRunFolder({
                    engine: 'api', taskId: subTaskId,
                    label: task.presetTitle || '批处理',
                    docName: task.docName || '',
                    docPath: task.docPath || '',
                    docId: task.docId
                });
                runPath = (runFolder && (runFolder.wcRunPath || runFolder.name)) || '';
            } catch (rfErr) {
                // 单组建文件夹失败(如磁盘满)只废这一组, 不拖垮整批
                ctx.logToPanel(groupLabel + " 创建缓存文件夹失败: " + (rfErr.message || rfErr), "error");
                ctx.sendTaskCompleteOnce(subTaskId, { taskId: subTaskId, successCount: 0, generatedCount: 0, returnedCount: 0, pendingCount: 0, failCount: 0, size: task.settings.size, model: task.settings.model, provider: params.provider || '', engine: 'batch', docName: task.docName || '', docPath: task.docPath || '', error_category: 'batch.cache.create_fail' });
                return;
            }
            await ctx.saveImageToRunFolder(runFolder, 'input', task.base64, 1);
            // 保存任务的文档ID和选区（与单图逻辑一致）
            var targetDocId = task.docId;
            var targetSelection = task.selection;
            var targetAntiMode = task.settings.antiMode;
            var targetLayerType = task.settings.layerType;
            ctx.logToPanel(groupLabel + " 开始生成 " + count + " 张...", "info");

            // 为该组的每张图创建并发请求（纯网络，不涉及PS操作）
            var jobPromises = [];
            for (var j = 0; j < count; j++) {
                var jobPromise = (async function(idx) {
                    return pool.add(async function() {
                        try {
                            try { ctx.logToPanel(groupLabel + " [第" + idx + "张] 发送请求...", "info"); } catch (_) {}
                            var _batchJobStart = Date.now();
                            var _bArch = {
                                id: batchTaskId + '_g' + taskIndex + '_' + idx + '_' + Date.now(),
                                batchId: batchTaskId + '_g' + taskIndex,   // 同一组队列任务共用 batchId
                                workflow: 'batch',
                                prompt: task.prompt,
                                model: task.settings.model,
                                provider: params.provider,
                                size: task.settings.size,
                                aspectRatio: task.settings.aspectRatio,
                                presetTitle: task.presetTitle || '',
                                context: {
                                    docId: targetDocId,
                                    docName: task.docName || '',
                                    docPath: task.docPath || '',
                                    selection: targetSelection,
                                    antiMode: targetAntiMode,
                                    layerType: targetLayerType,
                                    groupName: '队列批处理'
                                },
                                extras: { groupIdx: taskIndex, idxInGroup: idx, groupCount: count }
                            };
                            var resultBase64 = await ctx.callAiApi(params.apiKey, task.prompt, task.base64, task.settings.size, timeout, apiBaseUrl, task.refImages, task.settings.model, params.provider, subTaskId, task.settings.aspectRatio, {
                                archiveCallback: function(b64, st, err) { return ctx.archiveToRecycleBin(_bArch, b64, st, err); }
                            });
                            var successResult = { success: true, attempted: true, index: idx, data: resultBase64 };
                            completedJobs++;
                            try {
                                ctx.logToPanel(groupLabel + " [第" + idx + "张] 完成 (" + ((Date.now() - _batchJobStart) / 1000).toFixed(1) + "s)", "success");
                                ctx.sendToPanel('batchProgress', { total: totalJobs, index: completedJobs, status: 'success' });
                                ctx.sendToPanel('taskProgress', { taskId: subTaskId, total: count, status: 'success' });
                            } catch (_) {}
                            return successResult;
                        } catch (err) {
                            var failedResult = { success: false, attempted: !(err && err.requestAttempted === false), index: idx };
                            completedJobs++;
                            try {
                                ctx.logToPanel(groupLabel + " [第" + idx + "张] " + err.message, "error");
                                if (err.solution) ctx.logToPanel(groupLabel + " [解决] " + err.solution, "warn");
                                ctx.sendToPanel('batchProgress', { total: totalJobs, index: completedJobs, status: 'fail' });
                                ctx.sendToPanel('taskProgress', { taskId: subTaskId, total: count, status: 'fail' });
                            } catch (_) {}
                            try { await ctx.playSingleFailSound(); } catch (_) {}
                            return failedResult;
                        }
                    });
                })(j + 1);
                jobPromises.push(jobPromise);
            }

            // 等待该组所有请求完成
            var results = await Promise.all(jobPromises);
            billingResults = results;
            var successResults = results.filter(function(r) { return r.success; });
            var requestFailCount = results.filter(function(r) { return !r.success && r.attempted !== false; }).length;
            successResults.sort(function(a, b) { return a.index - b.index; });
            // 该组缓存三件套先落盘(中断/贴回失败也保得住): output 编号组内从 1 起, 与本组 input_001 对应
            for (var svk = 0; svk < successResults.length; svk++) {
                await ctx.saveImageToRunFolder(runFolder, 'output', successResults[svk].data, svk + 1);
            }
            await ctx.savePromptTxtToRunFolder(runFolder, task.prompt || '');
            // 证据日志(成功 0 张也记, 失败也是证据); 异步不挡贴回
            evidenceLog.appendEvidence({
                runFolder: runFolder,
                runPath: runPath,
                taskId: subTaskId,
                startTs: _groupStartTs,
                endTs: Date.now(),
                engine: 'api',
                model: task.settings.model || '',
                source: params.provider || '',
                docName: task.docName || '',
                prompt: task.prompt || '',
                inputs: task.base64 ? [task.base64] : [],
                outputs: successResults.map(function(r) { return r.data; })
            }).then(function(evRes) {
                if (evRes && evRes.ok) ctx.logToPanel(groupLabel + ' [证据日志] 链号#' + evRes.seq, 'info');
                else ctx.logToPanel(groupLabel + ' [证据日志] 写入失败(不影响生成): ' + ((evRes && evRes.error) || '?'), 'warn');
            });
            if (successResults.length === 0) {
                ctx.logToPanel(groupLabel + " 全部失败", "error");
                ctx.sendTaskCompleteOnce(subTaskId, { taskId: subTaskId, successCount: 0, generatedCount: 0, returnedCount: 0, pendingCount: 0, failCount: requestFailCount, size: task.settings.size, model: task.settings.model, provider: params.provider || '', engine: 'batch', docName: task.docName || '', docPath: task.docPath || '' });
                await ctx.playAllFailSound();
                return;
            }
            // #6.1: 该队列项被中断 → 跳过贴回, 直接结算条目
            if (ctx.g_taskEarlyStop[subTaskId]) {
                var stoppedPayloads = successResults.map(function(r) { return r.data; });
                if (stoppedPayloads.length > 0) {
                    ctx.g_taskResultCache[subTaskId] = {
                        originDocId: targetDocId || null,
                        savedSelection: targetSelection || null,
                        antiMode: targetAntiMode || 0,
                        layerType: targetLayerType || 'smartObject',
                        payloads: stoppedPayloads.slice(),
                        groupName: task.presetTitle || '批处理',
                        presetName: task.presetTitle || '',
                        returnWorkflowKey: 'bananaBatch',
                        runFolderName: runPath || (runFolder && runFolder.name),
                        docName: task.docName || '', engine: 'api'
                    };
                }
                ctx.logToPanel(groupLabel + " 已中断，保留 " + stoppedPayloads.length + " 张已生成结果待手动传回", "warn");
                ctx.sendTaskCompleteOnce(subTaskId, {
                    taskId: subTaskId,
                    successCount: successResults.length,
                    generatedCount: successResults.length,
                    returnedCount: 0,
                    pendingCount: stoppedPayloads.length,
                    failCount: requestFailCount,
                    size: task.settings.size, model: task.settings.model,
                    provider: params.provider || '', engine: 'batch',
                    docName: task.docName || '', docPath: task.docPath || ''
                });
                return;
            }

            // 通过PS操作锁串行贴回（防止多组同时操作PS冲突）
            var batchPlacedCount = 0;
            var batchUnplacedPayloads = successResults.map(function(r) { return r.data; });
            if (params.autoReturn !== false) {
                try {
                    await ctx.acquirePSLock(async function() {
                        ctx.logToPanel(groupLabel + " 正在贴回 " + successResults.length + " 张...", "info");
                        var createdLayerIds = [];
                        // v6.5.8: 统一走 placeImagesAuto(急速回图开关在里面判: 开=批量单权限, 关=老逐张)
                        var _bIds = await ctx.placeImagesAuto(targetDocId, successResults.map(function(r) {
                            return { base64: r.data, selection: targetSelection, antiMode: targetAntiMode, layerType: targetLayerType };
                        }));
                        batchUnplacedPayloads = [];
                        for (var k = 0; k < _bIds.length; k++) {
                            if (!_bIds[k]) { batchUnplacedPayloads.push(successResults[k].data); continue; }
                            createdLayerIds.push(_bIds[k]);
                            try {
                                await ctx.applyReturnFeatherMaskToLayer(targetDocId, _bIds[k], targetSelection, 'bananaBatch');
                            } catch (featherErr) {
                                ctx.logToPanel(groupLabel + " 图已贴回，但羽化蒙版失败: " + ((featherErr && featherErr.message) || featherErr), "warn");
                            }
                        }
                        batchPlacedCount = createdLayerIds.length;
                        if (createdLayerIds.length > 0 && ctx.g_autoGroupRef.value) {
                    try {
                        await core.executeAsModal(async function() {
                            // 确保切回目标文档（与单图逻辑一致）
                            await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: targetDocId }] }], {});
                            await sleep(100);
                            await ctx.createGroupAndMask(createdLayerIds, "批处理", (task.presetTitle ? { presetName: task.presetTitle } : undefined));
                            // 4K偏色自动矫正: 四阀门 = 开关开 + banana/gemini 模型 + 4K + 自动编组(本分支即是)
                            if (ctx.g_fix4kMagentaRef && ctx.g_fix4kMagentaRef.value
                                && task.settings.size === '4K'
                                && /banana|gemini/i.test(String(task.settings.model || ''))
                                && ctx.applyMagentaFixCurveToGroup) {
                                try { await ctx.applyMagentaFixCurveToGroup("批处理"); }
                                catch (eMg) { ctx.logToPanel("[4K偏色矫正] 曲线创建失败(图已正常编组): " + (eMg.message || eMg), "warn"); }
                            }
                        }, { commandName: "批处理打组" });
                    } catch (e) { ctx.logToPanel(groupLabel + " [警告] 打组失败: " + e.message, "warn"); }
                    // 教学模式
                    if (ctx.g_teachModeRef && ctx.g_teachModeRef.value) {
                        var refB64s = [];
                        if (task.base64) refB64s.push(task.base64);
                        if (task.refImages && task.refImages.length) {
                            for (var rri = 0; rri < task.refImages.length; rri++) refB64s.push(task.refImages[rri]);
                        }
                        var rfApplied = ctx.shouldApplyReturnFeather && ctx.shouldApplyReturnFeather('bananaBatch');
                        var rfCfg = rfApplied ? {
                            enabled: true,
                            shrink: ctx.g_returnFeatherShrinkPercentRef && ctx.g_returnFeatherShrinkPercentRef.value,
                            blur: ctx.g_returnFeatherBlurPercentRef && ctx.g_returnFeatherBlurPercentRef.value
                        } : { enabled: false };
                        await ctx.createTeachingMaterials({
                            docId: targetDocId,
                            prompt: task.prompt,
                            model: task.settings && task.settings.model,
                            provider: params.provider,
                            size: task.settings && task.settings.size,
                            aspectRatio: task.settings && task.settings.aspectRatio,
                            batch: successResults.length,
                            selection: targetSelection,
                            antiMode: targetAntiMode,
                            returnFeather: rfCfg,
                            promptPresetName: task.presetTitle || '',
                            refImageBase64s: refB64s,
                            taskId: batchTaskId
                        });
                    }
                        }
                        // 通知对话气泡:把刚创建的 layerIDs 绑到对应 item 上
                        if (createdLayerIds.length > 0) {
                            ctx.sendToPanel('conversationEvent', {
                                type: 'attach-layers',
                                taskId: batchTaskId,
                                layerIDs: createdLayerIds,
                                docId: targetDocId
                            });
                        }
                        ctx.logToPanel(groupLabel + " 完成! 贴回 " + batchPlacedCount + "/" + successResults.length + " 张", batchPlacedCount === successResults.length ? "success" : "warn");
                        try { await require('../host/proj-thumb.js').updateProjThumb(targetDocId, task.docName || '', task.docPath || '', ctx.sendToPanel); } catch(_pt) {}
                    }, subTaskId);
                } catch (pasteErr) {
                    ctx.logToPanel(groupLabel + " 贴回出错: " + ((pasteErr && pasteErr.message) || pasteErr), "error");
                }
            }

            // 自动传回关闭时也必须缓存并结算；这段不能放在上面的条件式 try/finally 里。
            if (batchUnplacedPayloads.length > 0) {
                ctx.g_taskResultCache[subTaskId] = {
                    originDocId: targetDocId || null,
                    savedSelection: targetSelection || null,
                    antiMode: targetAntiMode || 0,
                    layerType: targetLayerType || 'smartObject',
                    payloads: batchUnplacedPayloads.slice(),
                    groupName: task.presetTitle || '批处理',
                    presetName: task.presetTitle || '',
                    returnWorkflowKey: 'bananaBatch',
                    runFolderName: runPath || (runFolder && runFolder.name),
                    docName: task.docName || '', engine: 'api'
                };
                if (params.autoReturn !== false) ctx.sendToPanel('taskAutoReturnFailed', { taskId: subTaskId, count: batchUnplacedPayloads.length, returnedCount: batchPlacedCount });
            }
            // 生成数与实际贴回数分开；待返回只包含未贴成功的图片。
            ctx.sendTaskCompleteOnce(subTaskId, {
                taskId: subTaskId,
                successCount: successResults.length,
                generatedCount: successResults.length,
                returnedCount: batchPlacedCount,
                pendingCount: batchUnplacedPayloads.length,
                failCount: requestFailCount,
                size: task.settings.size, model: task.settings.model,
                provider: params.provider || '', engine: 'batch',
                docName: task.docName || '', docPath: task.docPath || ''
            });
            } catch (groupErr) {
                // API 已返回后即使落盘/贴回又抛错，也要按真实请求结果结算，不能整组记成 0。
                var recovered = (billingResults || []).filter(function(r) { return r && r.success; });
                var requestFails = (billingResults || []).filter(function(r) { return (!r || !r.success) && (!r || r.attempted !== false); }).length;
                ctx.sendTaskCompleteOnce(subTaskId, {
                    taskId: subTaskId,
                    successCount: recovered.length, generatedCount: recovered.length,
                    returnedCount: 0, pendingCount: recovered.length,
                    failCount: requestFails,
                    size: (task.settings && task.settings.size) || '',
                    model: (task.settings && task.settings.model) || '',
                    provider: params.provider || '', engine: 'batch',
                    docName: task.docName || '', docPath: task.docPath || '',
                    error_category: 'batch.group_fatal'
                });
                if (recovered.length > 0) {
                    var recoveredPayloads = recovered.map(function(r) { return r.data; }).filter(Boolean);
                    try {
                        ctx.g_taskResultCache[subTaskId] = {
                            originDocId: task.docId || null,
                            savedSelection: task.selection || null,
                            antiMode: (task.settings && task.settings.antiMode) || 0,
                            layerType: (task.settings && task.settings.layerType) || 'smartObject',
                            payloads: recoveredPayloads,
                            groupName: task.presetTitle || '批处理',
                            presetName: task.presetTitle || '',
                            returnWorkflowKey: 'bananaBatch',
                            runFolderName: runPath || (runFolder && runFolder.name),
                            docName: task.docName || '', engine: 'api'
                        };
                    } catch (_) {}
                }
                try { ctx.logToPanel(groupLabel + ' 组内致命错误: ' + ((groupErr && groupErr.message) || groupErr), 'error'); } catch (_) {}
            }
        })(i, queue[i]);
        taskGroupPromises.push(groupPromise);
    }

    // 等待所有任务组完成
    await Promise.all(taskGroupPromises);
    // (缓存重构后 prompt.txt 已按组写进各自叶子文件夹, 不再写整批混合版)
    await ctx.deselectAll();
    ctx.sendToPanel('batchComplete', { ok: true });
    ctx.logToPanel("[完成] 批处理全部结束", "success");
    await ctx.playSuccessSound();
    } catch (e) {
        // #2 兜底: 进分组循环前就抛(如 createImageCacheRunFolder 磁盘满)时, 前端已注册的子任务卡片
        // 没人结算 → 会永久残留 + 卡在"批处理中"。这里把每个子卡片补结算 + 发 ok:false(前端据此不清队列)。
        for (var _ei = 0; _ei < queue.length; _ei++) {
            var _it = queue[_ei] || {};
            if (_it.taskId) ctx.sendTaskCompleteOnce(_it.taskId, {
                taskId: _it.taskId, successCount: 0, generatedCount: 0,
                returnedCount: 0, pendingCount: 0, failCount: 0,
                size: (_it.settings && _it.settings.size) || '',
                model: (_it.settings && _it.settings.model) || '',
                provider: params.provider || '', engine: 'batch',
                docName: _it.docName || '', docPath: _it.docPath || '',
                error_category: 'batch.fatal'
            });
        }
        try { ctx.logToPanel("[批处理] 致命错误: " + ((e && e.message) || e), "error"); } catch (_) {}
        try { ctx.sendToPanel('batchComplete', { ok: false }); } catch (_) {}
    }
}, { tileId: 'batch' });

module.exports = {};
