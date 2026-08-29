// ============================================================
//  tile-scene.host.js — 场景包磁贴 host 端
//
//  做的事:
//    1. sceneListPacks      — 启动时把 factory_scenes/*.json 全部读出来回给前端
//    2. sceneCaptureRef     — 抓 PS 当前选区作为人物参考图
//    3. sceneGenerate       — 调 callAiApi 生成场景图, 贴回 PS 当前文档
// ============================================================

var HostAPI = require('../host/host-api.js');
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;
var concurrencyPool = require('../host/concurrency-pool.js');
var uxpFs = require('uxp').storage.localFileSystem;

function _sceneDocById(docId) {
    for (var i = 0; i < app.documents.length; i++) {
        if (String(app.documents[i].id) === String(docId)) return app.documents[i];
    }
    return null;
}

async function _withSceneDocLock(ctx, lockId, docId, fn) {
    if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop 全局操作锁不可用');
    return await ctx.acquirePSLock(async function() {
        var doc = _sceneDocById(docId);
        if (!doc) throw new Error('请求发起时的 PS 文档已关闭');
        if (!app.activeDocument || String(app.activeDocument.id) !== String(docId)) {
            await core.executeAsModal(async function() {
                await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: doc.id }] }], {});
            }, { commandName: '切换到场景目标文档' });
        }
        return await fn(doc);
    }, lockId);
}

// ============================================================
//  1. 列出所有可用场景包
// ============================================================
HostAPI.registerAction('sceneListPacks', async function(data, ctx) {
    var packs = [];
    try {
        var pluginFolder = await uxpFs.getPluginFolder();
        var scenesFolder = null;
        try { scenesFolder = await pluginFolder.getEntry('factory_scenes'); } catch(_) {}
        if (scenesFolder) {
            var entries = await scenesFolder.getEntries();
            for (var i = 0; i < entries.length; i++) {
                var ent = entries[i];
                if (!ent.isFile || !/\.json$/i.test(ent.name)) continue;
                try {
                    var content = await ent.read();
                    var pack = JSON.parse(content);
                    if (pack && pack.id && pack.name) packs.push(pack);
                } catch(parseErr) {
                    ctx.logToPanel('[场景包] 解析失败: ' + ent.name + ' - ' + parseErr.message, 'warn');
                }
            }
        }
    } catch(e) {
        ctx.logToPanel('[场景包] 加载失败: ' + e.message, 'error');
    }
    ctx.sendToPanel('sceneListPacksResult', { packs: packs });
}, { tileId: 'scene' });

// ============================================================
//  2. 抓 PS 选区作为参考图
// ============================================================
HostAPI.registerAction('sceneCaptureRef', async function(data, ctx) {
    var docId = null;
    try { docId = app.activeDocument && app.activeDocument.id; } catch (_) {}
    try {
        if (docId == null) {
            ctx.sendToPanel('sceneCaptureRefResult', { success: false, error: '没有打开的文档' });
            return;
        }
        // 临时关闭抗截断 (参考图不该被反色)
        var savedAnti = ctx.g_antiTruncationModeRef ? ctx.g_antiTruncationModeRef.value : 0;
        var capture = await _withSceneDocLock(ctx, 'scene-capture:' + Date.now(), docId, async function() {
            try {
                if (ctx.g_antiTruncationModeRef) ctx.g_antiTruncationModeRef.value = 0;
                return await ctx.getSelectionAndImage();
            } finally {
                if (ctx.g_antiTruncationModeRef) ctx.g_antiTruncationModeRef.value = savedAnti;
            }
        });

        if (!capture) {
            ctx.sendToPanel('sceneCaptureRefResult', { success: false, error: '未检测到选区, 请先在 PS 里框选要参考的人物' });
            return;
        }
        ctx.sendToPanel('sceneCaptureRefResult', {
            success: true,
            base64: capture.base64,
            selection: capture.selection,
            docId: docId
        });
    } catch(e) {
        ctx.sendToPanel('sceneCaptureRefResult', { success: false, error: e.message || String(e) });
    }
}, { tileId: 'scene' });

// ============================================================
//  3. 生成场景图 → 贴回 PS
// ============================================================
HostAPI.registerAction('sceneGenerate', async function(data, ctx) {
    data = data || {};
    var taskId = data.taskId || ('scene_' + Date.now());
    var provider = data.provider || 'aji';
    var modelName = data.model || 'AJbanana3';
    var size = data.size || '2K';
    var aspectRatio = data.aspectRatio || 'Auto';
    var batchCount = +data.batchCount || 1;
    if (batchCount < 1) batchCount = 1;
    if (batchCount > 8) batchCount = 8;
    var docName = '';
    var docPath = '';
    var targetDocId = null;
    var apiSuccessCount = 0;
    var apiFailCount = 0;
    var returnedCount = 0;

    function completeTask(extra) {
        ctx.sendTaskCompleteOnce(taskId, Object.assign({
            taskId: taskId,
            successCount: apiSuccessCount,
            generatedCount: apiSuccessCount,
            returnedCount: returnedCount,
            pendingCount: 0,
            failCount: apiFailCount,
            provider: provider,
            engine: 'scene',
            model: modelName,
            size: size,
            batchSize: batchCount,
            docName: docName,
            docPath: docPath,
            docId: targetDocId
        }, extra || {}));
    }

    try {
        // 前端把 url/key 直接传过来 (主插件其他磁贴如 partition/balance 都是这种模式).
        // 不用 ctx.hostStorageRef — 那是 host 自己的存储, 跟 panel storage 不互通.
        var apiKey = data.apiKey || '';
        var apiUrl = data.apiUrl || '';
        if (!apiKey || !apiUrl) {
            completeTask({ successCount: 0, generatedCount: 0, returnedCount: 0, failCount: 0, error_category: 'scene.config.missing_connection' });
            ctx.sendToPanel('sceneGenerateResult', { success: false, error: provider.toUpperCase() + ' Key 或 URL 缺失 (前端没传过来)' });
            return;
        }

        var prompt = data.prompt || '';
        if (!prompt.trim()) {
            completeTask({ successCount: 0, generatedCount: 0, returnedCount: 0, failCount: 0, error_category: 'scene.input.empty_prompt' });
            ctx.sendToPanel('sceneGenerateResult', { success: false, error: 'Prompt 为空' });
            return;
        }

        var timeout = 3600;
        ctx.logToPanel('[场景包] 开始生成 ' + (data.packId || '?') + ' | ' + provider + ' / ' + modelName + ' / ' + size + ' / ' + aspectRatio + ' x ' + batchCount + '张', 'info');

        // 参考图作为 inputImageBase64 (有就 image-to-image, 没有就纯文生图)
        var inputBase64 = data.refBase64 || null;

        // 贴回前先校验 PS 文档存在
        var doc = app.activeDocument;
        if (!doc) {
            completeTask({ successCount: 0, generatedCount: 0, returnedCount: 0, failCount: 0, error_category: 'scene.input.no_document' });
            ctx.sendToPanel('sceneGenerateResult', { success: false, error: '没有打开的文档可贴回' });
            return;
        }
        var antiMode = ctx.g_antiTruncationModeRef ? ctx.g_antiTruncationModeRef.value : 0;
        var layerType = ctx.g_layerTypeRef ? ctx.g_layerTypeRef.value : 'smartObject';
        targetDocId = doc.id;
        var targetSelection = data.refSelection || null;
        if (!targetSelection) {
            targetSelection = { left: 0, top: 0, right: doc.width, bottom: doc.height, width: doc.width, height: doc.height };
        }

        // === 并发 callAiApi (跟 partition / batch 一致) ===
        // PS 贴图层是 executeAsModal, 不能并发, 所以"调 AI"并发, "贴 PS"串行 (用锁排队)
        // 最大并发数取 batchCount, 不超过 4 (跟 batch 默认上限一致, 避免一次太重)
        var MAX_CONCURRENCY = Math.min(batchCount, 4);
        var pool = concurrencyPool.createConcurrencyPool(MAX_CONCURRENCY);

        var firstErr = null;
        var generatedResults = [];   // { idx, base64 } 顺序无关, 拿到就推

        // 归档元数据 (整个 batch 共用上下文, id/extras 按子任务填)
        try { docName = doc.name || ''; } catch(_) {}
        try { docPath = doc.path ? String(doc.path) : ''; } catch(_) {}
        var baseArchiveMeta = {
            batchId: taskId,    // 整个场景包共一个 batchId
            workflow: 'scene',
            prompt: prompt,
            model: modelName,
            provider: provider,
            size: size,
            aspectRatio: aspectRatio,
            context: {
                docId: doc.id,
                docName: docName,
                docPath: docPath,
                selection: targetSelection,
                antiMode: antiMode,
                layerType: layerType,
                groupName: null
            },
            extras: { packId: data.packId || null, idxInBatch: 0, batchTotal: batchCount }
        };

        var jobPromises = [];
        for (var i = 0; i < batchCount; i++) {
            (function(idx) {
                var subTaskId = taskId + '_' + idx;
                var subMeta = Object.assign({}, baseArchiveMeta, {
                    id: subTaskId,
                    extras: Object.assign({}, baseArchiveMeta.extras, { idxInBatch: idx })
                });
                jobPromises.push(pool.add(async function() {
                    try {
                        try { ctx.logToPanel('[场景包] 第 ' + (idx + 1) + '/' + batchCount + ' 张 · 请求中...', 'info'); } catch (_) {}
                        var resultBase64 = await ctx.callAiApi(
                            apiKey,
                            prompt,
                            inputBase64,
                            size,
                            timeout,
                            apiUrl,
                            null,
                            modelName,
                            provider,
                            subTaskId,
                            aspectRatio,
                            {
                                archiveCallback: function(b64, status, err) {
                                    return ctx.archiveToRecycleBin(subMeta, b64, status, err);
                                }
                            }
                        );
                        if (!resultBase64) throw new Error('AI 没返回图像');
                        generatedResults.push({ idx: idx, base64: resultBase64 });
                        apiSuccessCount++;
                        try { ctx.logToPanel('[场景包] 第 ' + (idx + 1) + '/' + batchCount + ' 张 · API 完成 ✓', 'success'); } catch (_) {}
                    } catch(loopErr) {
                        if (!loopErr || loopErr.requestAttempted !== false) apiFailCount++;
                        if (!firstErr) firstErr = loopErr;
                        try { ctx.logToPanel('[场景包] 第 ' + (idx + 1) + '/' + batchCount + ' 张失败: ' + loopErr.message, 'error'); } catch (_) {}
                    }
                }));
            })(i);
        }

        // 等所有 API 都返回
        await Promise.all(jobPromises);

        if (generatedResults.length === 0) {
            completeTask();
            ctx.sendToPanel('sceneGenerateResult', {
                success: false,
                taskId: taskId,
                error: '全部失败: ' + (firstErr ? firstErr.message : '未知错误')
            });
            return;
        }

        // 贴 PS 串行 (并发会让 executeAsModal 互相挤)
        ctx.logToPanel('[场景包] 开始把 ' + generatedResults.length + ' 张贴到 PS...', 'info');
        // 按生成时的 idx 排序, 保证图层顺序跟用户期望一致
        generatedResults.sort(function(a, b) { return a.idx - b.idx; });
        var unplacedPayloads = [];
        try {
            await _withSceneDocLock(ctx, taskId, targetDocId, async function() {
                for (var ri = 0; ri < generatedResults.length; ri++) {
                    try {
                        await ctx.placeImageToSpecificDoc(generatedResults[ri].base64, targetDocId, targetSelection, antiMode, layerType);
                        returnedCount++;
                    } catch(placeErr) {
                        unplacedPayloads.push(generatedResults[ri].base64);
                        if (!firstErr) firstErr = placeErr;
                        ctx.logToPanel('[场景包] 贴第 ' + (generatedResults[ri].idx + 1) + ' 张失败: ' + placeErr.message, 'error');
                    }
                }
            });
        } catch (lockErr) {
            unplacedPayloads = generatedResults.map(function(r) { return r.base64; });
            returnedCount = 0;
            if (!firstErr) firstErr = lockErr;
            ctx.logToPanel('[场景包] 传回失败，结果已转为待返回: ' + ((lockErr && lockErr.message) || lockErr), 'warn');
        }

        if (unplacedPayloads.length > 0) {
            ctx.g_taskResultCache[taskId] = {
                payloads: unplacedPayloads,
                originDocId: targetDocId,
                savedSelection: targetSelection,
                antiMode: antiMode,
                layerType: layerType,
                groupName: (data.packId || '场景包'),
                returnWorkflowKey: 'bananaSingle',
                docName: docName,
                engine: 'scene'
            };
            ctx.sendToPanel('taskAutoReturnFailed', { taskId: taskId, count: unplacedPayloads.length, returnedCount: returnedCount });
        }
        completeTask({ pendingCount: unplacedPayloads.length });
        ctx.logToPanel('[场景包] 完成 — 生成 ' + apiSuccessCount + ' 张, 贴回 ' + returnedCount + ' 张, API失败 ' + apiFailCount + ' 张', unplacedPayloads.length ? 'warn' : 'success');
        ctx.sendToPanel('sceneGenerateResult', {
            success: true,
            taskId: taskId,
            successCount: returnedCount,
            generatedCount: apiSuccessCount,
            pendingCount: unplacedPayloads.length,
            failCount: apiFailCount
        });
    } catch(e) {
        completeTask({ pendingCount: 0, error_category: 'scene.fatal' });
        try { ctx.logToPanel('[场景包] 生成失败: ' + e.message, 'error'); } catch (_) {}
        try { ctx.sendToPanel('sceneGenerateResult', { success: false, taskId: taskId, error: e.message || String(e) }); } catch (_) {}
    }
}, { tileId: 'scene' });

module.exports = {};
