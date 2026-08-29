// ============================================================
//  tile-hemisynth.host.js — 半合成 后端处理器
//  ① hemisynthTask: 抓 PS 选区 → ctx.callAiApi (走总体配置渠道) → 结果贴回文档
//     流程照抄 tile-kao.host.js 的成熟链路 (含回收站归档 / 对话磁贴 attach-layers)。
//  ② hemisynthAutoDetect: 抓 PS 选区 → 调 AI 助手语言模型 (chat/completions, 带图)
//     识别画面角色, 返回各输入框建议值 JSON。识别时不取消选区 (用户接着要用它生成)。
// ============================================================

var HostAPI = require('../host/host-api.js');
var evidenceLog = require('../host/evidence-log.js');   // 证据日志: 指纹+签章链
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;

function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

// ============================================================
//  生成任务
// ============================================================
// 提示词保护: 对话气泡 / 回收站只显示占位, 真实提示词只发给 AI (上游可见, 已知)
HostAPI.registerAction('hemisynthTask', async function(params, ctx) {
  params = params || {};
  var taskId = params.taskId || ('hemi_' + Date.now());
  var groupName = params.groupName || '半合成';
  // 占位文案带上具体玩法名 (groupName = 半合成 / 手办地台 / 垂悬环绕物), 让用户能区分是哪个功能, 但看不到正文
  var maskPrompt = '【' + groupName + '·受保护提示词】内容不予展示';
  var _evStartTs = Date.now();   // 证据日志: 任务开始时间
  ctx.sendToPanel('hemisynthStarted', { taskId: taskId });
  ctx.logToPanel("[半合成] 开始处理...", "info");

  try {
    var doc = app.activeDocument;
    if (!doc) {
      ctx.logToPanel("[半合成] 没有打开的文档", "error");
      ctx.sendTaskCompleteOnce(taskId, { taskId: taskId, successCount: 0, generatedCount: 0, returnedCount: 0, pendingCount: 0, failCount: 0, provider: params.provider || '', engine: 'hemisynth', model: params.model || '', size: params.size || '', docName: '', docPath: '' });
      ctx.sendToPanel('hemisynthComplete', { success: false, error: '没有打开的文档' });
      return;
    }

    var originDocId = doc.id;
    var docName = '';
    try { docName = doc.name || ''; } catch (_) {}
    var docPath = '';
    try { docPath = doc.path ? String(doc.path) : ''; } catch (_) {}   // 未保存文档取 path 会抛/为空

    // ── 抓取选区 (输入图) ──
    var captureBase64 = null;
    var savedSelection = null;
    await ctx.acquirePSLock(async function() {
      // 自动扩充+裁切: 开关开 + 比例 1:1 → 抓图时非方形选区补白凑方
      // (getSelectionAndImage 会把 selection 变成虚拟方形框, 并把原选区存进 selection.cropRect,
      //  贴回时 applyReturnFeatherMaskToLayer 按 cropRect 加蒙版裁掉白边)
      var _padOpts = (ctx.g_autoPadCropRef && ctx.g_autoPadCropRef.value && params.aspectRatio === '1:1')
        ? { padToSquare: true } : undefined;
      var cap = await ctx.getSelectionAndImage(undefined, _padOpts);
      if (cap && cap.base64) {
        captureBase64 = cap.base64;
        savedSelection = cap.selection || null;
      }
      try { await ctx.deselectAll(); } catch (_) {}
    }, taskId);

    if (!captureBase64) {
      ctx.logToPanel("[半合成] 抓取选区/画布失败 (请先框选或确认有打开的文档)", "error");
      ctx.sendTaskCompleteOnce(taskId, { taskId: taskId, successCount: 0, generatedCount: 0, returnedCount: 0, pendingCount: 0, failCount: 0, provider: params.provider || '', engine: 'hemisynth', model: params.model || '', size: params.size || '', docName: docName, docPath: docPath });
      ctx.sendToPanel('hemisynthComplete', { success: false, error: '未能抓取选区/画布' });
      await ctx.playSingleFailSound();
      return;
    }

    // 无选区时, 用整张画布作为贴回区域
    if (!savedSelection) {
      var W = Math.round(Number(doc.width) || 0);
      var H = Math.round(Number(doc.height) || 0);
      savedSelection = { left: 0, top: 0, right: W, bottom: H, width: W, height: H };
    }

    // ── 标准缓存: 两级结构 文档名_短码/玩法名_日期_时间_随机 (与单图生成同一套) ──
    // 提示词保护: prompt.txt / 证据日志 都只落占位文案, 真实提示词不落盘
    var refImages = Array.isArray(params.refImages) ? params.refImages.filter(Boolean) : [];
    var runFolder = null, runPath = '';
    try {
      runFolder = await ctx.createImageCacheRunFolder({
        engine: 'api', taskId: taskId,
        label: groupName,
        docName: docName, docPath: docPath, docId: originDocId
      });
      runPath = (runFolder && (runFolder.wcRunPath || runFolder.name)) || '';
      await ctx.saveImageToRunFolder(runFolder, 'input', captureBase64, 1);
      // 参考图跟着存 input_002 起 (input_001 = 选区主图)
      for (var _ri = 0; _ri < refImages.length; _ri++) {
        await ctx.saveImageToRunFolder(runFolder, 'input', refImages[_ri], _ri + 2);
      }
      await ctx.savePromptTxtToRunFolder(runFolder, maskPrompt);
    } catch (rfErr) {
      ctx.logToPanel("[半合成] 创建缓存文件夹失败(生成继续, 本次不落缓存): " + (rfErr.message || rfErr), "warn");
      runFolder = null;
    }

    // 给任务队列 / 历史磁贴发缩略图 + 选区信息
    ctx.sendToPanel('previewImage', { base64: captureBase64, selection: savedSelection, docId: originDocId, docName: docName, docPath: docPath, taskId: taskId });

    ctx.logToPanel("[半合成] 选区已抓取" + (refImages.length ? " (含 " + refImages.length + " 张参考图)" : "") + "，发送 API...", "info");

    // ── API 调用 (走总体配置渠道, callAiApi 内自动广播对话式生成气泡) ──
    var pool = ctx.createConcurrencyPool(20);
    var batchSize = parseInt(params.batchSize) || 1;
    var imageSize = params.size || '2K';
    var apiBaseUrl = params.apiBaseUrl;
    if (apiBaseUrl && apiBaseUrl.endsWith('/')) apiBaseUrl = apiBaseUrl.slice(0, -1);

    var jobPromises = [];
    // API 结果与 Photoshop 后处理分开记。后处理报错时，已经发生的调用仍必须结算。
    var billingPayloads = [];
    var billingFailCount = 0;
    var billingReturnedCount = 0;
    var billingPendingPayloads = [];
    for (var ji = 0; ji < batchSize; ji++) {
      (function(idx) {
        var _arch = {
          id: taskId + '_' + idx + '_' + Date.now(),
          batchId: taskId,
          workflow: 'hemisynth',
          prompt: maskPrompt,   // 回收站归档只存占位, 不落真实提示词
          model: params.model,
          provider: params.provider,
          size: imageSize,
          aspectRatio: params.aspectRatio,
          presetTitle: groupName,
          promptProtected: true,   // 统一时间线: [载入提示词] 按钮禁用(真词从未落盘)
          context: {
            docId: originDocId,
            docName: docName,
            docPath: docPath,
            selection: savedSelection,
            antiMode: 0,
            layerType: 'smartObject',
            groupName: groupName
          },
          extras: { idxInBatch: idx, batchTotal: batchSize }
        };
        var p = pool.add(function() {
          return ctx.callAiApi(params.apiKey, params.prompt, captureBase64, imageSize,
            parseInt(params.timeout) || 3600, apiBaseUrl, refImages,
            params.model, params.provider, taskId, params.aspectRatio, {
              displayPrompt: maskPrompt,   // 对话气泡只显示占位, 真实 prompt 仍照常发 AI
              archiveCallback: function(b64, st, err) { return ctx.archiveToRecycleBin(_arch, b64, st, err); }
            })
          .then(function(resultBase64) {
            var result = { success: true, payload: resultBase64, archiveId: _arch.id };
            try { ctx.sendToPanel('taskProgress', { taskId: taskId, total: batchSize, index: idx + 1, status: 'success' }); } catch (_) {}
            return result;
          }).catch(function(err) {
            try {
              ctx.sendToPanel('taskProgress', { taskId: taskId, total: batchSize, index: idx + 1, status: 'fail' });
              ctx.logToPanel("[半合成] 第" + (idx + 1) + "张失败: " + (err.message || err), "error");
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
        ctx.logToPanel("[半合成] 所有API请求失败，无结果返回", "error");
        ctx.sendTaskCompleteOnce(taskId, { taskId: taskId, successCount: 0, generatedCount: 0, returnedCount: 0, pendingCount: 0, failCount: billingFailCount, provider: params.provider || '', engine: 'hemisynth', model: params.model || '', size: imageSize, batchSize: batchSize, docName: docName, docPath: docPath });
        ctx.sendToPanel('hemisynthComplete', { success: false, error: '所有API请求失败' });
        await ctx.playSingleFailSound();
        return;
      }

      // ── 回图先落缓存 + 证据日志 (贴回失败/手动传回也保得住) ──
      if (runFolder) {
        for (var _oi = 0; _oi < allPayloads.length; _oi++) {
          await ctx.saveImageToRunFolder(runFolder, 'output', allPayloads[_oi], _oi + 1);
        }
        // 证据日志(指纹+签章链): 异步写不挡贴回; 提示词只记占位
        evidenceLog.appendEvidence({
          runFolder: runFolder, runPath: runPath,
          taskId: taskId, startTs: _evStartTs, endTs: Date.now(),
          engine: 'api', model: params.model || '',
          source: params.provider || '',
          docName: docName, prompt: maskPrompt,
          inputs: [captureBase64].concat(refImages),
          outputs: allPayloads.slice()
        }).then(function(evRes) {
          if (evRes && evRes.ok) ctx.logToPanel('[证据日志] 已记录 链号#' + evRes.seq, 'info');
          else ctx.logToPanel('[证据日志] 写入失败(不影响生成): ' + ((evRes && evRes.error) || '?'), 'warn');
        });
      }

      // ── 贴回文档 (尊重自动传回开关: 任务磁贴的 setTaskAutoReturn 写进 g_taskAutoReturn) ──
      var autoReturn = (ctx.g_taskAutoReturn[taskId] !== false);
      var placementSuccess = false;
      if (autoReturn) {
        try {
          await ctx.acquirePSLock(async function() {
            ctx.logToPanel("[半合成] 正在传回 " + allPayloads.length + " 张结果...", "info");

            await core.executeAsModal(async function() {
              await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: originDocId }] }], {});
            }, { commandName: "半合成-切回文档" });

            var createdLayerIds = [];
            var _hIds = await ctx.placeImagesAuto(originDocId, allPayloads.map(function(p) {
                return { base64: p, selection: savedSelection, antiMode: 0, layerType: 'smartObject' };
            }));
            billingPendingPayloads = [];
            for (var pi = 0; pi < allPayloads.length; pi++) {
              var newLayerId = _hIds[pi];
              if (newLayerId) {
                createdLayerIds.push(newLayerId);
                // 自动扩充+裁切: savedSelection.cropRect 存在(1:1 补过白) → 按原选区加蒙版裁掉白边;
                // 同时接上回图羽化(与主生成链路一致, 由 workflowKey 决定是否叠加羽化)
                try { await ctx.applyReturnFeatherMaskToLayer(originDocId, newLayerId, savedSelection, 'hemisynth'); } catch (_mErr) {}
              } else billingPendingPayloads.push(allPayloads[pi]);
            }
            billingReturnedCount = createdLayerIds.length;

            if (createdLayerIds.length > 0 && ctx.g_autoGroupRef && ctx.g_autoGroupRef.value) {
              await core.executeAsModal(async function() {
                await ctx.createGroupAndMask(createdLayerIds, groupName);
              }, { commandName: "半合成-打组" });
            }

            if (createdLayerIds.length > 0) {
              ctx.sendToPanel('conversationEvent', {
                type: 'attach-layers',
                taskId: taskId,
                layerIDs: createdLayerIds,
                docId: originDocId
              });
            }

            placementSuccess = billingReturnedCount === allPayloads.length;
          }, taskId);
        } catch (placeErr) {
          ctx.logToPanel("[半合成] 传回失败: " + (placeErr.message || placeErr), "warn");
        }
      }

      // 自动传回关闭 或 自动传回失败 → 缓存结果供任务卡片手动传回(与单图生成同一条链路)
      if (!autoReturn || !placementSuccess) {
        ctx.g_taskResultCache[taskId] = {
          originDocId: originDocId,
          savedSelection: savedSelection,
          antiMode: 0,
          layerType: 'smartObject',
          payloads: billingPendingPayloads.slice(),
          groupName: groupName,
          presetName: '',
          returnWorkflowKey: 'hemisynth',
          // 校色台账所需(手动传回时登记):
          runFolderName: runPath,
          docName: docName,
          engine: 'api'
        };
        var cachedCount = billingPendingPayloads.length;
        if (autoReturn) {
          // 自动传回开着但失败了 → 通知任务卡片显示手动传回按钮
          ctx.sendToPanel('taskAutoReturnFailed', { taskId: taskId, count: cachedCount });
          ctx.sendTaskCompleteOnce(taskId, { taskId: taskId, successCount: allPayloads.length, generatedCount: allPayloads.length, returnedCount: billingReturnedCount, pendingCount: cachedCount, failCount: billingFailCount, provider: params.provider || '', engine: 'hemisynth', size: imageSize, model: params.model, batchSize: batchSize, docName: docName, docPath: docPath, docId: originDocId, cached: cachedCount > 0 });
          ctx.sendToPanel('hemisynthComplete', { success: true, count: allPayloads.length, returnedCount: billingReturnedCount, pendingCount: cachedCount });
        } else {
          ctx.logToPanel("[半合成] 自动传回已关, " + cachedCount + " 张已缓存, 在任务卡片点 ✓ 手动传回", "info");
          ctx.sendTaskCompleteOnce(taskId, { taskId: taskId, successCount: allPayloads.length, generatedCount: allPayloads.length, returnedCount: 0, pendingCount: cachedCount, failCount: billingFailCount, provider: params.provider || '', engine: 'hemisynth', size: imageSize, model: params.model, batchSize: batchSize, docName: docName, docPath: docPath, docId: originDocId });
          ctx.sendToPanel('hemisynthComplete', { success: true, count: allPayloads.length, returnedCount: 0, pendingCount: cachedCount });
        }
        await ctx.playSuccessSound();
        return;
      }

      var totalSuccess = allPayloads.length;
      ctx.sendTaskCompleteOnce(taskId, { taskId: taskId, successCount: totalSuccess, generatedCount: totalSuccess, returnedCount: billingReturnedCount, pendingCount: 0, failCount: billingFailCount, provider: params.provider || '', engine: 'hemisynth', size: imageSize, model: params.model, batchSize: batchSize, docName: docName, docPath: docPath, docId: originDocId });
      ctx.logToPanel("[半合成] 完成！" + totalSuccess + " 张已传回", "success");
      ctx.sendToPanel('hemisynthComplete', { success: true, count: totalSuccess });
      await ctx.playSuccessSound();
    }).catch(async function(err) {
      ctx.sendTaskCompleteOnce(taskId, { taskId: taskId, successCount: billingPayloads.length, generatedCount: billingPayloads.length, returnedCount: billingReturnedCount, pendingCount: billingPendingPayloads.length, failCount: billingFailCount, provider: params.provider || '', engine: 'hemisynth', model: params.model || '', size: imageSize, batchSize: batchSize, docName: docName, docPath: docPath, cached: billingPendingPayloads.length > 0 });
      if (billingPendingPayloads.length > 0) {
        try {
          ctx.g_taskResultCache[taskId] = {
            originDocId: originDocId, savedSelection: savedSelection,
            antiMode: 0, layerType: 'smartObject', payloads: billingPendingPayloads.slice(),
            groupName: groupName, presetName: '', returnWorkflowKey: 'hemisynth',
            runFolderName: runPath, docName: docName, engine: 'api'
          };
        } catch (_) {}
      }
      try { ctx.logToPanel("[半合成] 致命错误: " + (err.message || err), "error"); } catch (_) {}
      try { ctx.sendToPanel('hemisynthComplete', { success: false, error: err.message || String(err) }); } catch (_) {}
      try { await ctx.playSingleFailSound(); } catch (_) {}
    });

  } catch (e) {
    ctx.sendTaskCompleteOnce(taskId, { taskId: taskId, successCount: 0, generatedCount: 0, returnedCount: 0, pendingCount: 0, failCount: 0, provider: params.provider || '', engine: 'hemisynth', model: params.model || '', size: params.size || '', docName: docName || '', docPath: docPath || '' });
    try { ctx.logToPanel("[半合成] 流程出错: " + e.message, "error"); } catch (_) {}
    try { ctx.sendToPanel('hemisynthComplete', { success: false, error: e.message }); } catch (_) {}
    try { await ctx.playSingleFailSound(); } catch (_) {}
  }
}, { tileId: 'hemisynth' });

// ============================================================
//  自动识别 (调 AI 助手的语言模型, 带图 vision)
//  data: { chatUrl, chatKey, chatModel, tplKey, tabLabel, fieldNames: [...] }
//  回: hemisynthAutoResult { success, tplKey, character?, values?, error? }
// ============================================================

// 规范化 chat URL — 与 tile-chat.js 的 _sendToApi 同一套补全规则
function _normalizeChatUrl(url) {
  var u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return null;
  u = u.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(u)) { /* 已完整 */ }
  else if (/\/completions$/i.test(u)) { /* 老接口保留 */ }
  else if (/\/v\d+$/i.test(u)) u += '/chat/completions';
  else u += '/v1/chat/completions';
  return u;
}

// 尝试修复被截断的 JSON: 补全未闭合的字符串引号 + 缺失的右花括号, 再 parse。
// 覆盖最常见的截断形态: 模型输出到一半被 max_tokens 掐断, 末尾停在某个值中间。
function _repairTruncatedJson(s) {
  var str = String(s || '');
  // 去掉末尾不完整的残片(最后一个逗号之后如果没有完整 "key":"value" 就砍掉)
  // 统计是否处在字符串内部(奇数个未转义引号 = 字符串没闭合)
  var inStr = false, esc = false, quotes = 0;
  for (var i = 0; i < str.length; i++) {
    var c = str[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { quotes++; inStr = !inStr; }
  }
  var fixed = str;
  // 1) 字符串未闭合 → 先补一个引号
  if (inStr) fixed += '"';
  // 2) 砍掉结尾悬空的逗号(如 ..."值",  或  ..."值" ,)
  fixed = fixed.replace(/,\s*$/, '');
  // 3) 补齐缺失的右花括号(按左右花括号数量差)
  var open = (fixed.match(/\{/g) || []).length;
  var close = (fixed.match(/\}/g) || []).length;
  for (var k = 0; k < open - close; k++) fixed += '}';
  try { return JSON.parse(fixed); } catch (_) { return null; }
}

// 不依赖整体结构, 用正则从文本里逐个抢救 "键":"值" 对(值取到下一个未转义引号)。
// 即使 JSON 严重残缺, 只要某个字段已经写完整就能捞回来 —— 截断场景的最后兜底。
function _salvagePairs(text) {
  var t = String(text || '');
  var out = {};
  var re = /"((?:[^"\\]|\\.)*?)"\s*:\s*"((?:[^"\\]|\\.)*?)"/g;
  var m;
  while ((m = re.exec(t)) !== null) {
    var key = m[1];
    var val = m[2];
    try { key = JSON.parse('"' + key + '"'); } catch (_) {}
    try { val = JSON.parse('"' + val + '"'); } catch (_) {}
    if (key && out[key] === undefined) out[key] = val;
  }
  return Object.keys(out).length ? out : null;
}

// 从模型回复文本里挖 JSON 对象 (容忍 ```json 围栏 / 前后废话 / 截断 / 残缺)
function _extractJson(text) {
  var t = String(text || '');
  var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1];
  var start = t.indexOf('{');
  if (start === -1) return _salvagePairs(t);   // 连 { 都没有, 直接逐字段抢救
  var end = t.lastIndexOf('}');
  // 1) 标准: 有完整 { ... }
  if (end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (_) {}
  }
  // 2) 截断修复: 从第一个 { 到结尾, 补引号/括号
  var repaired = _repairTruncatedJson(t.slice(start));
  if (repaired && typeof repaired === 'object') return repaired;
  // 3) 最后兜底: 正则逐字段抢救(能捞几个是几个)
  return _salvagePairs(t.slice(start));
}

HostAPI.registerAction('hemisynthAutoDetect', async function(data, ctx) {
  var tplKey = (data && data.tplKey) || '';
  function fail(msg) {
    ctx.logToPanel('[半合成·自动] ' + msg, 'error');
    ctx.sendToPanel('hemisynthAutoResult', { success: false, tplKey: tplKey, error: msg });
  }

  try {
    var chatUrl = _normalizeChatUrl(data && data.chatUrl);
    var chatKey = (data && data.chatKey) || '';
    var chatModel = (data && data.chatModel) || '';
    var fieldNames = (data && data.fieldNames) || [];
    if (!chatUrl) { fail('AI 助手 URL 无效 (必须以 http:// 或 https:// 开头)'); return; }
    if (!chatKey || !chatModel || !fieldNames.length) { fail('AI 助手配置或字段列表缺失'); return; }

    var doc = app.activeDocument;
    if (!doc) { fail('没有打开的文档'); return; }

    // ── 抓选区当识别输入 (不取消选区: 用户识别完还要用同一选区点生成) ──
    // 识别图临时压到 1024 (照抄 handleCaptureForChat 的做法): 识别不需要主生成的
    // 2K/4K 全质量图, 全尺寸 base64 会超上游 vision 接口 5MB 图片上限 → HTTP 400。
    // 同时临时关抗截断: 抗截断的反色/翻转会毁掉角色识别。抓完全部恢复原值。
    var captureBase64 = null;
    var savedMaxRes = ctx.g_maxResolutionRef ? ctx.g_maxResolutionRef.value : null;
    var savedAntiMode = ctx.g_antiTruncationModeRef ? ctx.g_antiTruncationModeRef.value : null;
    try {
      if (ctx.g_maxResolutionRef) ctx.g_maxResolutionRef.value = 1024;
      if (ctx.g_antiTruncationModeRef) ctx.g_antiTruncationModeRef.value = 0;
      await ctx.acquirePSLock(async function() {
        var cap = await ctx.getSelectionAndImage();
        if (cap && cap.base64) captureBase64 = cap.base64;
      }, 'hemiauto_' + Date.now());
    } finally {
      if (ctx.g_maxResolutionRef && savedMaxRes !== null) ctx.g_maxResolutionRef.value = savedMaxRes;
      if (ctx.g_antiTruncationModeRef && savedAntiMode !== null) ctx.g_antiTruncationModeRef.value = savedAntiMode;
    }
    if (!captureBase64) { fail('未能抓取选区/画布'); return; }

    ctx.logToPanel('[半合成·自动] 选区已抓取, 调用语言模型识别...', 'info');

    // 丰富度 1-5 → 对每个字段值饱满度的要求
    var richness = parseInt(data && data.richness, 10);
    if (!(richness >= 1 && richness <= 5)) richness = 3;
    var richLabel = (data && data.richnessLabel) || ['', '极简', '简洁', '适中', '丰富', '极繁'][richness];
    // 每个字段值大约要列几种元素 + 字数上限, 随丰富度递增
    var RICH_GUIDE = {
      1: { items: '1 种最核心的元素', chars: 15, tail: '克制留白, 只点题, 不堆砌。' },
      2: { items: '1-2 种元素', chars: 20, tail: '简洁干净。' },
      3: { items: '2-3 种呼应主题的元素', chars: 30, tail: '内容完整但不喧宾夺主。' },
      4: { items: '3-4 种元素, 有主次层次', chars: 45, tail: '饱满, 主道具+配景兼备, 用顿号分隔多个物件。' },
      5: { items: '4-6 种元素, 分主体/中景/点缀多层次', chars: 60, tail: '剧场级堆场, 尽量丰富具体, 用顿号列出多种物件, 但仍须写实、不遮主体。' }
    };
    var rg = RICH_GUIDE[richness];

    // 半身模式标识（前端传来）
    var bustMode = !!(data && data.bustMode);

    // ── 组装 vision 请求 (OpenAI chat/completions 兼容, 图走 base64 data URL) ──
    var sysPrompt;
    if (bustMode) {
      // 半身像兼容模式专用 system prompt
      sysPrompt =
        '你是二次元/Cosplay 摄影领域的角色识别与布景顾问。用户会给你一张【半身/胸像构图】的 Cosplay 实拍图（腰部或膝部以上、看不到脚部或地面）, ' +
        '你要识别画面中 coser 扮演的角色(哪部作品的谁; 认不出具体角色就描述其气质与风格), ' +
        '然后为「半身像空间布景」功能的各输入框给出建议值。' +
        '\n【关键差异】半身像模式与全身布景的根本区别：' +
        '\n- 全身布景：在地面铺设效果、摆落地道具、加地面悬浮物。' +
        '\n- 半身布景：图里没有地面，完全不涉及地面元素。改为四类悬浮/前景形态：①从画面下缘探入的前景道具、②身周悬浮小物、③带状环绕物、④飘落点缀。' +
        '\n【本次丰富度档位: ' + richLabel + ' (' + richness + '/5)】' +
        '\n要求:' +
        '\n1. 只输出一个 JSON 对象, 不要输出任何其他文字。' +
        '\n2. JSON 必须包含 "character" 键(识别出的角色, 如"作品名的角色名"; 认不出写气质描述), ' +
        '以及以下每个键: ' + fieldNames.map(function(n) { return '"' + n + '"'; }).join(', ') + '。' +
        '\n3. 除 "角色属性" 与 "道具密度" 外, 每个键的值都要按【' + richLabel + '】档位给出 ' + rg.items +
        ', 每个值约 ' + rg.chars + ' 字以内; ' + rg.tail +
        '\n4. 【特别注意】因为这是半身像模式，各字段的建议值必须符合半身空间布景的四类元素特性：' +
        '\n   - "布景主题"：整体空间氛围主题（如"甜美梦境茶会"、"古典书房"、"星夜幻想"）。' +
        '\n   - "前景道具"：从画面下缘探入的实体物件（如"花丛上半部"、"书堆顶端"、"桌沿与茶杯"），不能是完整落地的物品。' +
        '\n   - "悬浮元素"：小型实体悬停在身周空间（如"花朵、铃铛、书本"），不能是地面道具。' +
        '\n   - 所有元素都是现实存在的实体，完全写实画风，严禁发光/魔法/CG 元素。' +
        '\n5. "角色属性" 值简述角色气质与风格即可(20 字以内)。' +
        '\n6. 值里不要出现【】这两个符号。' +
        (fieldNames.indexOf('道具密度') !== -1
          ? '\n7. "道具密度" 直接填: ' + richLabel + ' (与本次丰富度档位一致)。'
          : '');
    } else {
      // 标准全身布景 system prompt（原有逻辑）
      sysPrompt =
        '你是二次元/Cosplay 摄影领域的角色识别与布景顾问。用户会给你一张 Cosplay 实拍图, ' +
        '你要识别画面中 coser 扮演的角色(哪部作品的谁; 认不出具体角色就描述其气质与风格), ' +
        '然后为「' + ((data && data.tabLabel) || '布景') + '」功能的各输入框给出建议值。' +
        '\n【本次丰富度档位: ' + richLabel + ' (' + richness + '/5)】' +
        '\n要求:' +
        '\n1. 只输出一个 JSON 对象, 不要输出任何其他文字。' +
        '\n2. JSON 必须包含 "character" 键(识别出的角色, 如"作品名的角色名"; 认不出写气质描述), ' +
        '以及以下每个键: ' + fieldNames.map(function(n) { return '"' + n + '"'; }).join(', ') + '。' +
        '\n3. 除 "角色属性" 与 "道具密度" 外, 每个键的值都要按【' + richLabel + '】档位给出 ' + rg.items +
        ', 每个值约 ' + rg.chars + ' 字以内; ' + rg.tail +
        ' 内容要与角色主题呼应、且是现实中存在的实体(本功能成图要求完全写实画风, 严禁发光/魔法/CG 元素)。' +
        '\n4. "角色属性" 值简述角色气质与风格即可(20 字以内)。' +
        '\n5. 值里不要出现【】这两个符号。' +
        (fieldNames.indexOf('道具密度') !== -1
          ? '\n6. "道具密度" 直接填: ' + richLabel + ' (与本次丰富度档位一致)。'
          : '');
    }

    // 用户补充信息(角色名/出处/其它提示) — 作为强提示, 优先于纯看图猜测
    var charHint = (data && data.charHint) ? String(data.charHint).trim() : '';
    if (charHint) {
      sysPrompt += '\n【用户补充信息(高优先级)】用户已明确告知画面角色/主题的相关信息: "' + charHint + '"。' +
        '请以此为准来确定角色与布景方向(即使看图不完全确定也要采信用户补充), 据此给出各字段建议值。';
    }

    var body = JSON.stringify({
      model: chatModel,
      stream: false,
      temperature: 0.3,
      max_tokens: 2048,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: [
          { type: 'text', text: '识别这张图里的角色, 并按要求输出 JSON。' +
            (charHint ? ('\n用户补充(以此为准): ' + charHint) : '') },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + captureBase64 } }
        ] }
      ]
    });

    var controller = new AbortController();
    var timeoutId = setTimeout(function() { try { controller.abort(); } catch (_) {} }, 120 * 1000);
    var resp;
    var raw = '';
    try {
      resp = await fetch(chatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + chatKey },
        body: body,
        signal: controller.signal
      });
      raw = await resp.text();
    } finally {
      clearTimeout(timeoutId);
    }

    if (!resp.ok) {
      var hints = { 401: 'Key 无效', 402: '余额不足', 404: '模型不存在或 URL 路径错误', 422: '模型可能不支持图片输入', 429: '请求太频繁' };
      fail('语言模型 HTTP ' + resp.status + (hints[resp.status] ? ' (' + hints[resp.status] + ')' : '') + (raw ? ' — ' + raw.substring(0, 200) : ''));
      return;
    }

    var json = null;
    try { json = JSON.parse(raw); } catch (_) {}
    var choice0 = json && json.choices && json.choices[0];
    var content = choice0 && choice0.message && choice0.message.content;
    var wasTruncated = choice0 && (choice0.finish_reason === 'length' || choice0.finish_reason === 'max_tokens');
    if (!content) { fail('语言模型返回格式异常 (无 choices[0].message.content)'); return; }

    var parsed = _extractJson(content);
    if (!parsed) {
      // 三层解析全失败: 给出可操作的建议(多半是被截断)
      var tip = wasTruncated
        ? '模型回复被截断(输出过长)。建议: 调低"自动识别丰富度"档位后重试。'
        : '未能从模型回复中解析出结构化内容。建议: 换一个更稳定的语言模型, 或调低丰富度重试。';
      fail(tip + ' 原始片段: ' + String(content).substring(0, 120));
      return;
    }
    if (wasTruncated) ctx.logToPanel('[半合成·自动] ⚠ 模型回复被截断, 已尽力抢救出可用字段(可能不全); 如缺字段建议调低丰富度重试', 'warn');

    // 只收模板里实际存在的字段; 值净化【】; 道具密度校验档位
    var values = {};
    var densityOk = ['极简', '简洁', '适中', '丰富', '极繁'];
    for (var i = 0; i < fieldNames.length; i++) {
      var name = fieldNames[i];
      var v = parsed[name];
      if (v == null) continue;
      v = String(v).replace(/[【】]/g, '').trim();
      if (name === '道具密度' && densityOk.indexOf(v) === -1) v = '适中';
      values[name] = v;
    }

    var character = parsed.character ? String(parsed.character).replace(/[【】]/g, '').trim() : '';
    ctx.logToPanel('[半合成·自动] 识别完成: ' + (character || '(未识别出具体角色)'), 'success');
    ctx.sendToPanel('hemisynthAutoResult', { success: true, tplKey: tplKey, character: character, values: values });

  } catch (e) {
    var msg = (e && e.name === 'AbortError') ? '识别请求超时 (120秒)' : ((e && e.message) || String(e));
    fail(msg);
  }
}, { tileId: 'hemisynth' });

module.exports = {};
