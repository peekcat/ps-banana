// ============================================================
//  tile-colorgrade.host.js
//  AI 调色后端处理器
//  从 index.js 迁移 handleColorGradeTask
//  通过 HostAPI.registerAction 注册到路由表
// ============================================================

var HostAPI = require('../host/host-api.js');
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;

function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

// ============================================================
//  1. captureRefImageForColorgrade - 捕获参考图
// ============================================================

HostAPI.registerAction('captureRefImageForColorgrade', async function(data, ctx) {
    try {
        var doc = app.activeDocument;
        if (!doc) { ctx.logToPanel("[调色] 没有打开的文档", "error"); return; }
        var result = await ctx.getSelectionAndImage();
        if (!result || !result.base64) {
            ctx.logToPanel("[调色] 捕获参考图失败", "error");
            ctx.sendToPanel('colorgradeRefCaptured', { base64: null });
            return;
        }
        ctx.sendToPanel('colorgradeRefCaptured', {
            base64: result.base64,
            docId: doc.id
        });
        ctx.logToPanel("[调色] 参考图已捕获", "info");
    } catch (err) {
        ctx.logToPanel("[调色] 捕获参考图异常: " + err.message, "error");
        ctx.sendToPanel('colorgradeRefCaptured', { base64: null });
    }
}, { tileId: 'colorgrade' });

// ============================================================
//  2. colorGradeTask - 调色主流程（原 handleColorGradeTask）
// ============================================================

HostAPI.registerAction('colorGradeTask', async function(params, ctx) {
    params = params || {};
    var taskId = params.taskId || ('cg_' + Date.now());
    ctx.sendToPanel('colorgradeStarted', { taskId: taskId });
    ctx.logToPanel("[调色] 开始处理...", "info");

    try {
        var doc = app.activeDocument;
        if (!doc) {
            ctx.logToPanel("[调色] 没有打开的文档", "error");
            ctx.sendTaskCompleteOnce(taskId, { taskId: taskId, successCount: 0, generatedCount: 0, returnedCount: 0, pendingCount: 0, failCount: 0, provider: params.provider || '', engine: 'colorgrade', model: params.model || '', size: params.size || '', docName: '', docPath: '' });
            ctx.sendToPanel('colorgradeComplete', { success: false, error: '没有打开的文档' });
            return;
        }

        var originDocId = doc.id;
        var docName = '';
        try { docName = doc.name || ''; } catch(_) {}
        var docPath = '';
        try { docPath = doc.path ? String(doc.path) : ''; } catch(_) {}
        var origW, origH;

        // ── 前置 PS 动作：扩 1:1 + 去色 + 截取 + 恢复 ──
        var captureBase64 = null;
        var squareSize = 0;
        var padLeft = 0, padTop = 0;

        await ctx.acquirePSLock(async function() {
            await core.executeAsModal(async function() {
                var d = app.activeDocument;
                origW = Math.round(Number(d.width) || 0);
                origH = Math.round(Number(d.height) || 0);
                squareSize = Math.max(origW, origH);
                padLeft = Math.round((squareSize - origW) / 2);
                padTop = Math.round((squareSize - origH) / 2);
                ctx.logToPanel("[调色] 文档 " + origW + "x" + origH + " → 扩展为 " + squareSize + "x" + squareSize + " (pad: " + padLeft + "," + padTop + ")", "info");

                // 1. 扩展画布为 1:1 正方形（居中）
                if (origW !== origH) {
                    await app.batchPlay([{
                        _obj: "canvasSize",
                        width: { _unit: "pixelsUnit", _value: squareSize },
                        height: { _unit: "pixelsUnit", _value: squareSize },
                        horizontal: { _enum: "horizontalLocation", _value: "center" },
                        vertical: { _enum: "verticalLocation", _value: "center" },
                        canvasExtensionColorType: { _enum: "canvasExtensionColorType", _value: "black" }
                    }], {});
                }

                // 2. 全选画布作为选区
                await app.batchPlay([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "allEnum" } }], {});
            }, { commandName: "调色-扩画布" });

            // 3. 截取当前画布（1:1 完整画布）
            var fullSelection = { left: 0, top: 0, right: squareSize, bottom: squareSize, width: squareSize, height: squareSize };
            var capture = await ctx.getSelectionAndImage(fullSelection);
            if (!capture || !capture.base64) {
                ctx.logToPanel("[调色] 截取画布失败", "error");
                return;
            }
            captureBase64 = capture.base64;

            // 4. 添加去色调整层 → 重新截取（去色版） → 删除调整层
            await core.executeAsModal(async function() {
                // 添加黑白调整层
                await app.batchPlay([{
                    _obj: "make",
                    _target: [{ _ref: "adjustmentLayer" }],
                    using: { _obj: "adjustmentLayer", type: { _obj: "blackAndWhite" } }
                }], {});
            }, { commandName: "调色-去色层" });

            // 重新截取（带去色效果的全画布）
            var desatCapture = await ctx.getSelectionAndImage(fullSelection);
            if (desatCapture && desatCapture.base64) {
                captureBase64 = desatCapture.base64;
            }

            // 删除去色调整层 + 恢复画布尺寸
            await core.executeAsModal(async function() {
                // 删除最顶层（刚创建的调整层）
                await app.batchPlay([{ _obj: "delete", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }], {});
                // 恢复原始画布尺寸（裁切掉 padding）
                if (origW !== origH) {
                    await app.batchPlay([{
                        _obj: "crop",
                        to: {
                            _obj: "rectangle",
                            top: { _unit: "pixelsUnit", _value: padTop },
                            left: { _unit: "pixelsUnit", _value: padLeft },
                            bottom: { _unit: "pixelsUnit", _value: padTop + origH },
                            right: { _unit: "pixelsUnit", _value: padLeft + origW }
                        }
                    }], {});
                }
                // 取消选区
                await app.batchPlay([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } }], {});
            }, { commandName: "调色-恢复" });
        }, taskId);

        if (!captureBase64) {
            ctx.sendTaskCompleteOnce(taskId, { taskId: taskId, successCount: 0, generatedCount: 0, returnedCount: 0, pendingCount: 0, failCount: 0, provider: params.provider || '', engine: 'colorgrade', model: params.model || '', size: params.size || '', docName: docName, docPath: docPath });
            ctx.sendToPanel('colorgradeComplete', { success: false, error: '截取画布失败' });
            return;
        }

        ctx.logToPanel("[调色] 画布截取完成，发送API...", "info");

        // ── API 调用 ──
        var pool = ctx.createConcurrencyPool(20);
        var batchSize = parseInt(params.batchSize) || 1;
        var imageSize = params.size || '2K';
        var apiBaseUrl = params.apiBaseUrl;
        if (apiBaseUrl && apiBaseUrl.endsWith('/')) apiBaseUrl = apiBaseUrl.slice(0, -1);
        var blendModeValue = params.blendMode || 'color';

        var jobPromises = [];
        // 网络结果先单独留底；保存、贴回或打组失败不能抹掉已经发生的消费。
        var billingPayloads = [];
        var billingFailCount = 0;
        var billingReturnedCount = 0;
        var billingPendingPayloads = [];
        for (var ji = 0; ji < batchSize; ji++) {
            (function(idx) {
                var _cgArch = {
                    id: taskId + '_' + idx + '_' + Date.now(),
                    batchId: taskId,
                    workflow: 'colorgrade',
                    prompt: params.prompt,
                    model: params.model,
                    provider: params.provider,
                    size: imageSize,
                    aspectRatio: params.aspectRatio,
                    context: {
                        docId: originDocId,
                        docName: docName,
                        docPath: docPath,
                        selection: null,                 // 调色贴的是整个画布矩形, 选区由 host 重新计算
                        antiMode: 0,
                        layerType: 'smartObject',
                        groupName: '调色'
                    },
                    extras: { idxInBatch: idx, batchTotal: batchSize, blendMode: blendModeValue }
                };
                var p = pool.add(function() {
                    return ctx.callAiApi(params.apiKey, params.prompt, captureBase64, imageSize,
                        parseInt(params.timeout) || 3600, apiBaseUrl, [],
                        params.model, params.provider, taskId, params.aspectRatio, {
                            archiveCallback: function(b64, st, err) { return ctx.archiveToRecycleBin(_cgArch, b64, st, err); }
                        })
                    .then(function(resultBase64) {
                        var result = { success: true, payload: resultBase64 };
                        try { ctx.sendToPanel('colorgradeProgress', { total: batchSize, index: idx + 1, status: 'success' }); } catch (_) {}
                        return result;
                    }).catch(function(err) {
                        try {
                            ctx.sendToPanel('colorgradeProgress', { total: batchSize, index: idx + 1, status: 'fail' });
                            ctx.logToPanel("[调色] 第" + (idx + 1) + "张失败: " + (err.message || err), "error");
                        } catch (_) {}
                        throw err;
                    });
                });
                jobPromises.push(p);
            })(ji);
        }

        Promise.allSettled(jobPromises).then(async function(results) {
            var allPayloads = [];
            for (var ri = 0; ri < results.length; ri++) {
                if (results[ri].status === 'fulfilled' && results[ri].value && results[ri].value.success) {
                    if (results[ri].value.payload) {
                        if (Array.isArray(results[ri].value.payload)) allPayloads = allPayloads.concat(results[ri].value.payload);
                        else allPayloads.push(results[ri].value.payload);
                    }
                }
            }
            billingPayloads = allPayloads.slice();
            billingPendingPayloads = allPayloads.slice();
            billingFailCount = results.filter(function(r) {
                return r.status === 'rejected' && (!r.reason || r.reason.requestAttempted !== false);
            }).length;

            if (allPayloads.length === 0) {
                ctx.logToPanel("[调色] 所有API请求失败，无结果返回", "error");
                ctx.sendTaskCompleteOnce(taskId, { taskId: taskId, successCount: 0, generatedCount: 0, returnedCount: 0, pendingCount: 0, failCount: billingFailCount, provider: params.provider || '', engine: 'colorgrade', model: params.model || '', size: imageSize, batchSize: batchSize, docName: docName, docPath: docPath });
                ctx.sendToPanel('colorgradeComplete', { success: false, error: '所有API请求失败' });
                await ctx.playSingleFailSound();
                return;
            }

            // ── 后置 PS 动作：扩 1:1 → 放置所有图（Color模式） → 裁切回原始 ──
            var placementSuccess = false;
            try {
                await ctx.acquirePSLock(async function() {
                    ctx.logToPanel("[调色] 正在传回 " + allPayloads.length + " 张结果...", "info");

                    await core.executeAsModal(async function() {
                        // 切回原文档
                        await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: originDocId }] }], {});
                        // 扩展为 1:1（和截取时相同的尺寸）
                        var d = app.activeDocument;
                        if (d.width !== squareSize || d.height !== squareSize) {
                            await app.batchPlay([{
                                _obj: "canvasSize",
                                width: { _unit: "pixelsUnit", _value: squareSize },
                                height: { _unit: "pixelsUnit", _value: squareSize },
                                horizontal: { _enum: "horizontalLocation", _value: "center" },
                                vertical: { _enum: "verticalLocation", _value: "center" },
                                canvasExtensionColorType: { _enum: "canvasExtensionColorType", _value: "black" }
                            }], {});
                        }
                    }, { commandName: "调色-扩画布回传" });

                    // 放置所有结果图层（1:1 对齐）
                    var squareSel = { left: 0, top: 0, right: squareSize, bottom: squareSize, width: squareSize, height: squareSize };
                    var createdLayerIds = [];
                    for (var pi = 0; pi < allPayloads.length; pi++) {
                        var newLayerId = await ctx.placeImageToSpecificDoc(allPayloads[pi], originDocId, squareSel, 0, 'smartObject');
                        if (newLayerId) {
                            createdLayerIds.push(newLayerId);
                            billingReturnedCount = createdLayerIds.length;
                            billingPendingPayloads[pi] = null;
                            // 设置混合模式
                            try {
                                await core.executeAsModal(async function() {
                                    await app.batchPlay([{
                                        _obj: "set",
                                        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                                        to: { _obj: "layer", mode: { _enum: "blendMode", _value: blendModeValue } }
                                    }], {});
                                }, { commandName: "调色-混合模式" });
                            } catch (blendErr) {
                                ctx.logToPanel("[调色] 图已贴回，但混合模式设置失败: " + ((blendErr && blendErr.message) || blendErr), "warn");
                            }
                        }
                        if (pi < allPayloads.length - 1) await sleep(60);
                    }

                    // 打组
                    if (createdLayerIds.length > 0 && ctx.g_autoGroupRef.value) {
                        await core.executeAsModal(async function() {
                            await ctx.createGroupAndMask(createdLayerIds, "AI调色");
                        }, { commandName: "调色-打组" });
                        // 教学模式
                        if (ctx.g_teachModeRef && ctx.g_teachModeRef.value) {
                            var refB64s = [];
                            if (captureBase64) refB64s.push(captureBase64);
                            // colorgrade 工作流不应用传回羽化
                            var rfCfg = { enabled: false };
                            await ctx.createTeachingMaterials({
                                docId: originDocId,
                                prompt: params.prompt,
                                model: params.model,
                                provider: params.provider,
                                size: params.size,
                                aspectRatio: params.aspectRatio,
                                batch: createdLayerIds.length,
                                selection: squareSel,
                                antiMode: 0,
                                returnFeather: rfCfg,
                                promptPresetName: params.presetTitle || '',
                                refImageBase64s: refB64s,
                                taskId: taskId
                            });
                        }
                    }
                    if (createdLayerIds.length > 0) {
                        ctx.sendToPanel('conversationEvent', {
                            type: 'attach-layers',
                            taskId: taskId,
                            layerIDs: createdLayerIds,
                            docId: originDocId
                        });
                    }

                    // 裁切回原始尺寸（仅当画布被扩展过时）
                    if (origW !== origH) {
                        await core.executeAsModal(async function() {
                            await app.batchPlay([{
                                _obj: "crop",
                                to: {
                                    _obj: "rectangle",
                                    top: { _unit: "pixelsUnit", _value: padTop },
                                    left: { _unit: "pixelsUnit", _value: padLeft },
                                    bottom: { _unit: "pixelsUnit", _value: padTop + origH },
                                    right: { _unit: "pixelsUnit", _value: padLeft + origW }
                                }
                            }], {});
                            ctx.logToPanel("[调色] 已裁切回 " + origW + "x" + origH, "info");
                        }, { commandName: "调色-裁切" });
                    }

                    billingPendingPayloads = billingPendingPayloads.filter(Boolean);
                    placementSuccess = billingReturnedCount === allPayloads.length;
                }, taskId);
            } catch (placeErr) {
                billingPendingPayloads = billingPendingPayloads.filter(Boolean);
                ctx.logToPanel("[调色] 传回失败: " + (placeErr.message || placeErr), "warn");
            }

            // API 成功就已经产生费用；PS 贴回失败不能把生成数改成 0。
            var totalSuccess = allPayloads.length;
            if (billingPendingPayloads.length > 0) {
                ctx.g_taskResultCache[taskId] = {
                    originDocId: originDocId,
                    savedSelection: { left: 0, top: 0, right: origW, bottom: origH, width: origW, height: origH },
                    antiMode: 0, layerType: 'smartObject', payloads: billingPendingPayloads.slice(),
                    groupName: 'AI调色', presetName: '', returnWorkflowKey: 'colorgrade',
                    docName: docName, engine: 'colorgrade'
                };
                ctx.sendToPanel('taskAutoReturnFailed', { taskId: taskId, count: billingPendingPayloads.length, returnedCount: billingReturnedCount });
            }
            ctx.sendTaskCompleteOnce(taskId, {
                taskId: taskId, successCount: totalSuccess, generatedCount: totalSuccess,
                returnedCount: billingReturnedCount,
                pendingCount: billingPendingPayloads.length, failCount: billingFailCount,
                provider: params.provider || '', engine: 'colorgrade', model: params.model || '',
                size: imageSize, batchSize: batchSize, docName: docName, docPath: docPath, docId: originDocId,
                cached: billingPendingPayloads.length > 0
            });
            if (totalSuccess > 0) {
                ctx.logToPanel("[调色] 生成 " + totalSuccess + " 张，已传回 " + billingReturnedCount + " 张，待返回 " + billingPendingPayloads.length + " 张", billingPendingPayloads.length ? "warn" : "success");
                ctx.sendToPanel('colorgradeComplete', { success: true, count: totalSuccess, returnedCount: billingReturnedCount, pendingCount: billingPendingPayloads.length });
                if (billingPendingPayloads.length) await ctx.playSingleFailSound(); else await ctx.playSuccessSound();
            } else {
                ctx.sendToPanel('colorgradeComplete', { success: false, error: '传回失败' });
                await ctx.playSingleFailSound();
            }
        }).catch(async function(err) {
            billingPendingPayloads = billingPendingPayloads.filter(Boolean);
            ctx.sendTaskCompleteOnce(taskId, { taskId: taskId, successCount: billingPayloads.length, generatedCount: billingPayloads.length, returnedCount: billingReturnedCount, pendingCount: billingPendingPayloads.length, failCount: billingFailCount, provider: params.provider || '', engine: 'colorgrade', model: params.model || '', size: imageSize, batchSize: batchSize, docName: docName, docPath: docPath, cached: billingPendingPayloads.length > 0 });
            if (billingPendingPayloads.length > 0) {
                try {
                    ctx.g_taskResultCache[taskId] = {
                        originDocId: originDocId,
                        savedSelection: { left: 0, top: 0, right: origW, bottom: origH, width: origW, height: origH },
                        antiMode: 0, layerType: 'smartObject', payloads: billingPendingPayloads.slice(),
                        groupName: 'AI调色', presetName: '', returnWorkflowKey: 'colorgrade',
                        docName: docName, engine: 'colorgrade'
                    };
                } catch (_) {}
            }
            try { ctx.logToPanel("[调色] 致命错误: " + (err.message || err), "error"); } catch (_) {}
            try { ctx.sendToPanel('colorgradeComplete', { success: false, error: err.message || String(err) }); } catch (_) {}
            try { await ctx.playSingleFailSound(); } catch (_) {}
        });

    } catch (e) {
        ctx.sendTaskCompleteOnce(taskId, { taskId: taskId, successCount: 0, generatedCount: 0, returnedCount: 0, pendingCount: 0, failCount: 0, provider: params.provider || '', engine: 'colorgrade', model: params.model || '', size: params.size || '', docName: docName || '', docPath: docPath || '' });
        try { ctx.logToPanel("[调色] 流程出错: " + e.message, "error"); } catch (_) {}
        try { ctx.sendToPanel('colorgradeComplete', { success: false, error: e.message }); } catch (_) {}
        try { await ctx.playSingleFailSound(); } catch (_) {}
    }
}, { tileId: 'colorgrade' });

module.exports = {};
