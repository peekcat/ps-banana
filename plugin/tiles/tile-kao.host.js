// ============================================================
//  tile-kao.host.js  —  尻特效 (VFX 粒子特效) 后端处理器
//  流程: 抓 PS 选区 → ctx.callAiApi (走总体配置渠道) → 结果贴回文档
//  参考 tile-colorgrade.host.js 的成熟流程, 去掉其扩画布/去色步骤。
// ============================================================

var HostAPI = require('../host/host-api.js');
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;

function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

HostAPI.registerAction('kaoVfxTask', async function(params, ctx) {
  params = params || {};
  var taskId = params.taskId || ('kao_' + Date.now());
  if (params.autoReturn !== undefined) ctx.g_taskAutoReturn[taskId] = !!params.autoReturn;
  ctx.sendToPanel('kaoStarted', { taskId: taskId });
  ctx.logToPanel("[尻特效] 开始处理...", "info");

  try {
    var doc = app.activeDocument;
    if (!doc) {
      ctx.logToPanel("[尻特效] 没有打开的文档", "error");
      ctx.sendTaskCompleteOnce(taskId, { taskId: taskId, successCount: 0, generatedCount: 0, returnedCount: 0, pendingCount: 0, failCount: 0, provider: params.provider || '', engine: 'kao', model: params.model || '', size: params.size || '', docName: '', docPath: '' });
      ctx.sendToPanel('kaoComplete', { success: false, error: '没有打开的文档' });
      return;
    }

    var originDocId = doc.id;
    var docName = '';
    try { docName = doc.name || ''; } catch (_) {}
    var docPath = '';
    try { docPath = doc.path ? String(doc.path) : ''; } catch (_) {}

    // ── 抓取选区 (输入图) ──
    var captureBase64 = null;
    var savedSelection = null;
    await ctx.acquirePSLock(async function() {
      var cap = await ctx.getSelectionAndImage();
      if (cap && cap.base64) {
        captureBase64 = cap.base64;
        savedSelection = cap.selection || null;
      }
      try { await ctx.deselectAll(); } catch (_) {}
    }, taskId);

    if (!captureBase64) {
      ctx.logToPanel("[尻特效] 抓取选区/画布失败 (请先框选或确认有打开的文档)", "error");
      ctx.sendTaskCompleteOnce(taskId, { taskId: taskId, successCount: 0, generatedCount: 0, returnedCount: 0, pendingCount: 0, failCount: 0, provider: params.provider || '', engine: 'kao', model: params.model || '', size: params.size || '', docName: docName, docPath: docPath });
      ctx.sendToPanel('kaoComplete', { success: false, error: '未能抓取选区/画布' });
      await ctx.playSingleFailSound();
      return;
    }

    // 无选区时, 用整张画布作为贴回区域
    if (!savedSelection) {
      var W = Math.round(Number(doc.width) || 0);
      var H = Math.round(Number(doc.height) || 0);
      savedSelection = { left: 0, top: 0, right: W, bottom: H, width: W, height: H };
    }

    // 给任务队列 / 历史磁贴发缩略图 + 选区信息
    ctx.sendToPanel('previewImage', { base64: captureBase64, selection: savedSelection, docId: originDocId, docName: docName, docPath: docPath, taskId: taskId });

    ctx.logToPanel("[尻特效] 选区已抓取，发送 API...", "info");

    // ── API 调用 (走总体配置渠道) ──
    var pool = ctx.createConcurrencyPool(20);
    var batchSize = parseInt(params.batchSize) || 1;
    var imageSize = params.size || '2K';
    var apiBaseUrl = params.apiBaseUrl;
    if (apiBaseUrl && apiBaseUrl.endsWith('/')) apiBaseUrl = apiBaseUrl.slice(0, -1);

    var jobPromises = [];
    // API 结果独立保存，防止后续 Photoshop 操作失败时把已发生的消费归零。
    var billingPayloads = [];
    var billingFailCount = 0;
    var billingReturnedCount = 0;
    var billingPendingPayloads = [];
    for (var ji = 0; ji < batchSize; ji++) {
      (function(idx) {
        var _arch = {
          id: taskId + '_' + idx + '_' + Date.now(),
          batchId: taskId,
          workflow: 'kao',
          prompt: params.prompt,
          model: params.model,
          provider: params.provider,
          size: imageSize,
          aspectRatio: params.aspectRatio,
          presetTitle: '尻特效',
          context: {
            docId: originDocId,
            docName: docName,
            docPath: docPath,
            selection: savedSelection,
            antiMode: 0,
            layerType: 'smartObject',
            groupName: '尻特效'
          },
          extras: { idxInBatch: idx, batchTotal: batchSize }
        };
        var p = pool.add(function() {
          return ctx.callAiApi(params.apiKey, params.prompt, captureBase64, imageSize,
            parseInt(params.timeout) || 3600, apiBaseUrl, [],
            params.model, params.provider, taskId, params.aspectRatio, {
              archiveCallback: function(b64, st, err) { return ctx.archiveToRecycleBin(_arch, b64, st, err); }
            })
          .then(function(resultBase64) {
            var result = { success: true, payload: resultBase64, archiveId: _arch.id };
            try {
              ctx.sendToPanel('taskProgress', { taskId: taskId, total: batchSize, index: idx + 1, status: 'success' });
              ctx.sendToPanel('kaoProgress', { total: batchSize, index: idx + 1, status: 'success' });
            } catch (_) {}
            return result;
          }).catch(function(err) {
            try {
              ctx.sendToPanel('taskProgress', { taskId: taskId, total: batchSize, index: idx + 1, status: 'fail' });
              ctx.sendToPanel('kaoProgress', { total: batchSize, index: idx + 1, status: 'fail' });
              ctx.logToPanel("[尻特效] 第" + (idx + 1) + "张失败: " + (err.message || err), "error");
            } catch (_) {}
            throw err;
          });
        });
        jobPromises.push(p);
      })(ji);
    }

    Promise.allSettled(jobPromises).then(async function(results) {
      var allPayloads = [];
      var archiveIds = [];  // v6.5.9: 收集归档号供后台完成图传回用
      for (var ri = 0; ri < results.length; ri++) {
        if (results[ri].status === 'fulfilled' && results[ri].value && results[ri].value.success) {
          if (results[ri].value.payload) {
            if (Array.isArray(results[ri].value.payload)) allPayloads = allPayloads.concat(results[ri].value.payload);
            else allPayloads.push(results[ri].value.payload);
            // 收集对应的 archiveId
            if (results[ri].value.archiveId) archiveIds.push(results[ri].value.archiveId);
          }
        }
      }
      billingPayloads = allPayloads.slice();
      billingPendingPayloads = allPayloads.slice();
      billingFailCount = results.filter(function(r) {
        return r.status === 'rejected' && (!r.reason || r.reason.requestAttempted !== false);
      }).length;

      if (allPayloads.length === 0) {
        ctx.logToPanel("[尻特效] 所有API请求失败，无结果返回", "error");
        ctx.sendTaskCompleteOnce(taskId, { taskId: taskId, successCount: 0, generatedCount: 0, returnedCount: 0, pendingCount: 0, failCount: billingFailCount, provider: params.provider || '', engine: 'kao', model: params.model || '', size: imageSize, batchSize: batchSize, docName: docName, docPath: docPath });
        ctx.sendToPanel('kaoComplete', { success: false, error: '所有API请求失败' });
        await ctx.playSingleFailSound();
        return;
      }

      // ── 贴回文档（尊重全局自动返回，失败项单独缓存） ──
      var autoReturn = (ctx.g_taskAutoReturn[taskId] !== false) && params.autoReturn !== false;
      var createdLayerIds = [];
      var pendingPayloads = allPayloads.slice();
      if (autoReturn) try {
        await ctx.acquirePSLock(async function() {
          ctx.logToPanel("[尻特效] 正在传回 " + allPayloads.length + " 张结果...", "info");

          await core.executeAsModal(async function() {
            await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: originDocId }] }], {});
          }, { commandName: "尻特效-切回文档" });

          pendingPayloads = [];
          billingPendingPayloads = [];
          for (var pi = 0; pi < allPayloads.length; pi++) {
            var newLayerId = null;
            try { newLayerId = await ctx.placeImageToSpecificDoc(allPayloads[pi], originDocId, savedSelection, 0, 'smartObject'); }
            catch (singleErr) { ctx.logToPanel('[尻特效] 第' + (pi + 1) + '张传回失败: ' + ((singleErr && singleErr.message) || singleErr), 'warn'); }
            if (newLayerId) {
              createdLayerIds.push(newLayerId);
              billingReturnedCount = createdLayerIds.length;
            } else {
              pendingPayloads.push(allPayloads[pi]);
              billingPendingPayloads.push(allPayloads[pi]);
            }
            if (pi < allPayloads.length - 1) await sleep(60);
          }

          if (createdLayerIds.length > 0 && ctx.g_autoGroupRef && ctx.g_autoGroupRef.value) {
            await core.executeAsModal(async function() {
              await ctx.createGroupAndMask(createdLayerIds, "尻特效");
            }, { commandName: "尻特效-打组" });
          }

          if (createdLayerIds.length > 0) {
            ctx.sendToPanel('conversationEvent', {
              type: 'attach-layers',
              taskId: taskId,
              layerIDs: createdLayerIds,
              docId: originDocId
            });
          }
        }, taskId);
      } catch (placeErr) {
        ctx.logToPanel("[尻特效] 传回失败: " + (placeErr.message || placeErr), "warn");
      }
      pendingPayloads = billingPendingPayloads.slice();

      if (pendingPayloads.length > 0) {
        ctx.g_taskResultCache[taskId] = {
          originDocId: originDocId, savedSelection: savedSelection,
          antiMode: 0, layerType: 'smartObject', payloads: pendingPayloads.slice(),
          groupName: '尻特效', presetName: '尻特效', returnWorkflowKey: 'kao',
          docName: docName, engine: 'kao'
        };
        if (autoReturn) ctx.sendToPanel('taskAutoReturnFailed', { taskId: taskId, count: pendingPayloads.length, returnedCount: createdLayerIds.length });
      }

      var totalSuccess = allPayloads.length;
      ctx.sendTaskCompleteOnce(taskId, {
        taskId: taskId, successCount: totalSuccess, generatedCount: totalSuccess,
        returnedCount: billingReturnedCount, pendingCount: pendingPayloads.length,
        failCount: billingFailCount, size: imageSize, model: params.model,
        provider: params.provider || '', engine: 'kao', docName: docName, docPath: docPath
      });
      if (totalSuccess > 0) {
        ctx.logToPanel("[尻特效] 生成 " + totalSuccess + " 张，已传回 " + createdLayerIds.length + " 张，待返回 " + pendingPayloads.length + " 张", pendingPayloads.length ? "warn" : "success");
        ctx.sendToPanel('kaoComplete', { success: true, count: totalSuccess, returnedCount: createdLayerIds.length, pendingCount: pendingPayloads.length });
        if (pendingPayloads.length) await ctx.playSingleFailSound(); else await ctx.playSuccessSound();
      } else {
        ctx.sendToPanel('kaoComplete', { success: false, error: '传回失败' });
        await ctx.playSingleFailSound();
      }
    }).catch(async function(err) {
      ctx.sendTaskCompleteOnce(taskId, { taskId: taskId, successCount: billingPayloads.length, generatedCount: billingPayloads.length, returnedCount: billingReturnedCount, pendingCount: billingPendingPayloads.length, failCount: billingFailCount, provider: params.provider || '', engine: 'kao', model: params.model || '', size: imageSize, batchSize: batchSize, docName: docName, docPath: docPath, cached: billingPendingPayloads.length > 0 });
      if (billingPendingPayloads.length > 0) {
        try {
          ctx.g_taskResultCache[taskId] = {
            originDocId: originDocId, savedSelection: savedSelection,
            antiMode: 0, layerType: 'smartObject', payloads: billingPendingPayloads.slice(),
            groupName: '尻特效', presetName: '尻特效', returnWorkflowKey: 'kao',
            docName: docName, engine: 'kao'
          };
        } catch (_) {}
      }
      try { ctx.logToPanel("[尻特效] 致命错误: " + (err.message || err), "error"); } catch (_) {}
      try { ctx.sendToPanel('kaoComplete', { success: false, error: err.message || String(err) }); } catch (_) {}
      try { await ctx.playSingleFailSound(); } catch (_) {}
    });

  } catch (e) {
    ctx.sendTaskCompleteOnce(taskId, { taskId: taskId, successCount: 0, generatedCount: 0, returnedCount: 0, pendingCount: 0, failCount: 0, provider: params.provider || '', engine: 'kao', model: params.model || '', size: params.size || '', docName: docName || '', docPath: docPath || '' });
    try { ctx.logToPanel("[尻特效] 流程出错: " + e.message, "error"); } catch (_) {}
    try { ctx.sendToPanel('kaoComplete', { success: false, error: e.message }); } catch (_) {}
    try { await ctx.playSingleFailSound(); } catch (_) {}
  }
}, { tileId: 'kao' });

module.exports = {};
