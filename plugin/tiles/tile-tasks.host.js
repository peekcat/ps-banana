// ============================================================
//  tile-tasks.host.js
//  任务管理后端处理器
//  从 index.js 迁移: handleReturnTaskResult, handleGrsCheckCredits,
//    handleCheckQuota, handleCalibrateBalance
//  从 high-risk-task-handlers.js 迁移内联 case:
//    setTaskAutoReturn, clearTaskCache
//  通过 HostAPI.registerAction 注册到路由表
// ============================================================

var HostAPI = require('../host/host-api.js');
var serverConfig = require('../core/server-config.js');
var placementLedger = require('../host/placement-ledger.js');   // 校色台账
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;

function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

// ============================================================
//  setTaskAutoReturn — 设置任务自动传回标志
// ============================================================

HostAPI.registerAction('setTaskAutoReturn', async function(data, ctx) {
    if (data && data.taskId) {
        ctx.g_taskAutoReturn[data.taskId] = !!data.autoReturn;
    }
}, { tileId: 'tasks' });

// ============================================================
//  clearTaskCache — 清除任务结果缓存
// ============================================================

HostAPI.registerAction('clearTaskCache', async function(data, ctx) {
    if (data && data.taskId) {
        delete ctx.g_taskAutoReturn[data.taskId];
        delete ctx.g_taskResultCache[data.taskId];
    }
}, { tileId: 'tasks' });

// ============================================================
//  returnTaskResult — 手动传回任务结果（原 handleReturnTaskResult）
// ============================================================

HostAPI.registerAction('returnTaskResult', async function(data, ctx) {
    var taskId = data && data.taskId;
    if (!taskId) return;

    var cache = ctx.g_taskResultCache[taskId];
    if (!cache || !cache.payloads || cache.payloads.length === 0) {
        ctx.sendToPanel('taskReturned', { taskId: taskId });
        delete ctx.g_taskResultCache[taskId];
        delete ctx.g_taskAutoReturn[taskId];
        return;
    }

    // --- 校色任务: 走专用贴回(改名/挪到目标图层上方/剪贴蒙版), 不走下面的通用流程 ---
    if (cache.colormatch) {
        try {
            var cmHost = require('./tile-colormatch.host.js');
            var cmRes = await cmHost.placeColormatchItems(ctx, cache.originDocId, cache.colormatch.methodName, cache.colormatch.items);
            if (cmRes.leftovers.length) {
                // 部分没贴上(PS 正忙): 缓存里只留剩下的, 卡片保留, 用户可再点 ✓ 重试
                cache.colormatch.items = cmRes.leftovers;
                cache.payloads = cmRes.leftovers.map(function(it) { return it.b64; });
                ctx.logToPanel('[校色] ' + cmRes.placed + ' 张已传回, ' + cmRes.leftovers.length + ' 张失败(PS 可能正忙), 可再点一次 ✓', 'warn');
                return;
            }
            delete ctx.g_taskResultCache[taskId];
            delete ctx.g_taskAutoReturn[taskId];
            ctx.sendToPanel('taskReturned', { taskId: taskId });
            ctx.logToPanel('[校色] ' + cmRes.placed + ' 张校色结果已传回', 'success');
        } catch (eCm) {
            ctx.logToPanel('[校色] 手动传回失败: ' + ((eCm && eCm.message) || eCm) + ', 可再点一次 ✓', 'warn');
        }
        return;
    }

    var originDocId = cache.originDocId;
    var payloads = cache.payloads;
    var savedSelection = cache.savedSelection;
    var antiMode = cache.antiMode || 0;
    var layerType = cache.layerType || 'smartObject';
    var groupName = cache.groupName || '单图生成';
    var returnWorkflowKey = cache.returnWorkflowKey || 'bananaSingle';
    var workItems = (cache.items && cache.items.length)
        ? cache.items.slice()
        : payloads.map(function(b64) {
            return { base64: b64, docId: originDocId, selection: savedSelection, antiMode: antiMode, layerType: layerType, returnWorkflowKey: returnWorkflowKey };
        });
    var leftovers = [];
    var createdLayerIds = [];

    try {
        await ctx.acquirePSLock(async function() {
            ctx.logToPanel("[任务 " + taskId.slice(-4) + "] 正在手动传回...", "info");
            var _cmLedgerEntries = [];   // 校色台账: 手动传回的 图层↔缓存 对应关系
            for (var pi = 0; pi < workItems.length; pi++) {
                var wi = workItems[pi] || {};
                var wiDocId = wi.docId || originDocId || (app.activeDocument && app.activeDocument.id);
                var wiSelection = wi.selection !== undefined ? wi.selection : savedSelection;
                var wiAntiMode = wi.antiMode !== undefined ? wi.antiMode : antiMode;
                var wiLayerType = wi.layerType || layerType;
                var wiWorkflow = wi.returnWorkflowKey || returnWorkflowKey;
                var newLayerId = null;
                try {
                    newLayerId = await ctx.placeImageToSpecificDoc(wi.base64, wiDocId, wiSelection, wiAntiMode, wiLayerType);
                } catch (oneErr) {
                    ctx.logToPanel('[手动传回] 第 ' + (pi + 1) + ' 张失败: ' + ((oneErr && oneErr.message) || oneErr), 'warn');
                }
                if (newLayerId) {
                    createdLayerIds.push(newLayerId);
                    if (cache.runFolderName) {
                        _cmLedgerEntries.push({
                            docId: wiDocId,
                            docName: cache.docName || '',
                            layerId: newLayerId,
                            runFolderName: cache.runFolderName,
                            inputIdx: 1,
                            outputIdx: pi + 1,
                            selection: wiSelection,
                            antiMode: wiAntiMode,
                            layerType: wiLayerType,
                            featherKey: wiWorkflow,
                            engine: cache.engine || 'api',
                            ts: Date.now()
                        });
                    }
                    try { await ctx.applyReturnFeatherMaskToLayer(wiDocId, newLayerId, wiSelection, wiWorkflow); } catch (featherErr) {
                        ctx.logToPanel('[手动传回] 图已贴回，但羽化蒙版失败: ' + ((featherErr && featherErr.message) || featherErr), 'warn');
                    }
                } else leftovers.push(wi);
                await sleep(60);
            }
            // 校色台账登记(内存 + meta.json)
            if (_cmLedgerEntries.length) {
                for (var _li = 0; _li < _cmLedgerEntries.length; _li++) placementLedger.record(_cmLedgerEntries[_li]);
                try {
                    var _cmCacheFolder = await ctx.getOrCreateImageCacheFolder();
                    // runFolderName 可能是老平铺一段名或新结构 "项目/叶子" 两级路径
                    var _cmRunFolder = await placementLedger.getRunFolderByPath(_cmCacheFolder, cache.runFolderName);
                    await placementLedger.writeMetaJson(_cmRunFolder, _cmLedgerEntries);
                } catch (eLedger) { console.warn('[校色台账] meta.json 写入失败:', eLedger && eLedger.message); }
                ctx.logToPanel('[校色台账] 已登记 ' + _cmLedgerEntries.length + ' 条 (手动传回)', 'info');
            }
            if (!ctx.g_earlyStopRef.value && createdLayerIds.length > 0 && ctx.g_autoGroupRef.value) {
                try {
                    await core.executeAsModal(async function() {
                        var groupDocId = (workItems[0] && workItems[0].docId) || originDocId || app.activeDocument.id;
                        await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: groupDocId }] }], {});
                        await ctx.createGroupAndMask(createdLayerIds, groupName, (cache.presetName ? { presetName: cache.presetName } : undefined));
                    }, { commandName: "手动传回打组" });
                } catch (groupErr) {
                    // 图已经贴成功，打组失败不能让下一次重试重复贴图。
                    ctx.logToPanel('[手动传回] 图已贴回，但打组失败: ' + ((groupErr && groupErr.message) || groupErr), 'warn');
                }
                // 教学模式
                if (ctx.g_teachModeRef && ctx.g_teachModeRef.value && cache.teachParams) {
                    var tp = cache.teachParams;
                    var refB64s = [];
                    if (tp.captureBase64) refB64s.push(tp.captureBase64);
                    if (tp.refImages && tp.refImages.length) {
                        for (var rri = 0; rri < tp.refImages.length; rri++) refB64s.push(tp.refImages[rri]);
                    }
                    var rfApplied = ctx.shouldApplyReturnFeather && ctx.shouldApplyReturnFeather(returnWorkflowKey);
                    var rfCfg = rfApplied ? {
                        enabled: true,
                        shrink: ctx.g_returnFeatherShrinkPercentRef && ctx.g_returnFeatherShrinkPercentRef.value,
                        blur: ctx.g_returnFeatherBlurPercentRef && ctx.g_returnFeatherBlurPercentRef.value
                    } : { enabled: false };
                    try { await ctx.createTeachingMaterials({
                        docId: originDocId || app.activeDocument.id,
                        prompt: tp.prompt,
                        model: tp.model,
                        provider: tp.provider,
                        size: tp.size,
                        aspectRatio: tp.aspectRatio,
                        batch: tp.batch,
                        selection: savedSelection,
                        antiMode: antiMode,
                        returnFeather: rfCfg,
                        promptPresetName: tp.promptPresetName,
                        refImageBase64s: refB64s,
                        taskId: taskId
                    }); } catch (teachErr) { ctx.logToPanel('[手动传回] 教学材料创建失败: ' + ((teachErr && teachErr.message) || teachErr), 'warn'); }
                }
            }
            if (createdLayerIds.length > 0) {
                ctx.sendToPanel('conversationEvent', {
                    type: 'attach-layers',
                    taskId: taskId,
                    layerIDs: createdLayerIds,
                    docId: originDocId || app.activeDocument.id
                });
            }
        }, taskId);

        if (leftovers.length > 0) {
            cache.items = leftovers;
            cache.payloads = leftovers.map(function(it) { return it.base64; });
            ctx.g_taskResultCache[taskId] = cache;
            ctx.logToPanel('[手动传回] ' + createdLayerIds.length + ' 张成功，' + leftovers.length + ' 张仍待返回', 'warn');
            ctx.sendToPanel('taskManualReturnFailed', { taskId: taskId, placed: createdLayerIds.length, remaining: leftovers.length, error: '仍有 ' + leftovers.length + ' 张未能返回，可再次点击重试' });
            return;
        }
        delete ctx.g_taskResultCache[taskId];
        delete ctx.g_taskAutoReturn[taskId];
        delete ctx.g_taskCompleteSentRef.value[taskId];
        ctx.sendToPanel('taskReturned', { taskId: taskId });
    } catch (retErr) {
        ctx.logToPanel("[手动传回失败] PS 可能正在操作中: " + (retErr.message || retErr) + "，请完成PS操作后再次点击传回", "warn");
        ctx.sendToPanel('taskManualReturnFailed', { taskId: taskId, error: retErr.message || String(retErr) });
    }
}, { tileId: 'tasks' });

// ============================================================
//  grsCheckCredits — GRS 积分查询 + 模型状态
// ============================================================

HostAPI.registerAction('grsCheckCredits', async function(params, ctx) {
    var baseUrl = params.baseUrl;
    if (baseUrl && baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
    var result = { success: false, credits: 0, modelStatuses: {} };
    try {
        // 1. 查询积分余额
        var creditsResp = await serverConfig.fetchWithTimeout(baseUrl + "/client/openapi/getAPIKeyCredits", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey: params.apiKey })
        }, 12000);
        if (creditsResp.ok) {
            var creditsData = await creditsResp.json();
            if (creditsData.code === 0 && creditsData.data) {
                result.credits = creditsData.data.credits;
                result.success = true;
                ctx.logToPanel("[GRS] 积分余额: " + result.credits, "success");
            } else {
                ctx.logToPanel("[GRS] 积分查询返回异常: " + (creditsData.msg || '未知'), "error");
            }
        } else {
            ctx.logToPanel("[GRS] 积分查询HTTP错误: " + creditsResp.status, "error");
        }

        // 2. 查询各模型状态
        var grsModels = ['nano-banana-2','nano-banana-fast','nano-banana','nano-banana-pro','nano-banana-pro-vt','nano-banana-pro-cl','nano-banana-pro-vip','nano-banana-pro-4k-vip'];
        for (var i = 0; i < grsModels.length; i++) {
            try {
                var statusResp = await serverConfig.fetchWithTimeout(baseUrl + "/client/common/getModelStatus?model=" + grsModels[i], { method: 'GET' }, 8000);
                if (statusResp.ok) {
                    var statusData = await statusResp.json();
                    if (statusData.code === 0 && statusData.data) {
                        result.modelStatuses[grsModels[i]] = { status: statusData.data.status, error: statusData.data.error || '' };
                        var statusIcon = statusData.data.status ? '🟢' : '🔴';
                        ctx.logToPanel("[GRS] " + statusIcon + " " + grsModels[i] + (statusData.data.error ? ' - ' + statusData.data.error : ''), statusData.data.status ? "info" : "warn");
                    }
                }
            } catch(se) { /* 单个模型查询失败不影响整体 */ }
        }
    } catch (e) {
        ctx.logToPanel("[GRS] 网络连接失败: " + e.message, "error");
    }
    ctx.sendToPanel('grsCreditsResult', result);
}, { tileId: 'tasks' });

// ============================================================
//  checkQuota — 查询额度（AJI）
// ============================================================

HostAPI.registerAction('checkQuota', async function(params, ctx) {
    var apiBaseUrl = params.apiBaseUrl;
    if (apiBaseUrl && apiBaseUrl.endsWith('/')) apiBaseUrl = apiBaseUrl.slice(0, -1);
    try {
        var response = await serverConfig.fetchWithTimeout(apiBaseUrl + "/api/usage/token", { method: "GET", headers: { "Authorization": "Bearer " + params.apiKey } }, 12000);
        if (response.status === 200) {
            var data = await response.json();
            if (data && data.data && data.data.total_available !== undefined) {
                var availableUSD = data.data.total_available / 500000;
                ctx.logToPanel("[成功] 查询完成!", "success");
                ctx.logToPanel("[余额] $" + availableUSD.toFixed(4), "success");
                ctx.sendToPanel('checkQuotaResult', { success: true, balanceUSD: availableUSD });
                // 列举所有模型的剩余张数
                var ALL_MODELS = {
                    'AJbanana3': { name: '♿香蕉Pro', prices: { '1K': 0.15, '2K': 0.16, '4K': 0.18 } },
                    'Banana-pro-D': { name: '♿香蕉Pro-D', prices: { '1K': 0.1, '2K': 0.1, '4K': 0.1 } },
                    'AJbanana2': { name: '♿香蕉2', prices: { '1K': 0.05, '2K': 0.06, '4K': 0.06 } },
                    'gemini-2.5-flash-image': { name: '♿香蕉1', prices: { '1K': 0.04 } }
                };
                for (var mk in ALL_MODELS) {
                    var m = ALL_MODELS[mk];
                    var parts = [];
                    for (var sz in m.prices) { parts.push(sz + ":" + Math.floor(availableUSD / m.prices[sz]).toLocaleString() + "张"); }
                    ctx.logToPanel("[" + m.name + "] " + parts.join(" | "), "info");
                }
            } else {
                ctx.logToPanel("[错误] 无法解析额度数据", "error");
                ctx.sendToPanel('checkQuotaResult', { success: false, error: '该中转未返回可识别的额度数据' });
            }
        } else {
            var quotaErr = ctx.getErrorMessage(response.status);
            ctx.logToPanel("[错误] " + quotaErr, "error");
            ctx.logToPanel("[解决] " + ctx.getErrorSolution(response.status), "warn");
            ctx.sendToPanel('checkQuotaResult', { success: false, error: quotaErr });
        }
    } catch (e) {
        ctx.logToPanel("[错误] 网络连接失败", "error");
        ctx.sendToPanel('checkQuotaResult', { success: false, error: (e && e.message) || '网络连接失败' });
    }
    return true;
}, { tileId: 'tasks' });

// ============================================================
//  calibrateBalance — 余额校准（AJI）
// ============================================================

HostAPI.registerAction('calibrateBalance', async function(params, ctx) {
    var apiBaseUrl = params.apiBaseUrl;
    if (apiBaseUrl && apiBaseUrl.endsWith('/')) apiBaseUrl = apiBaseUrl.slice(0, -1);
    try {
        var response = await serverConfig.fetchWithTimeout(apiBaseUrl + "/api/usage/token", { method: "GET", headers: { "Authorization": "Bearer " + params.apiKey } }, 12000);
        if (response.status === 200) {
            var data = await response.json();
            if (data && data.data && data.data.total_available !== undefined) {
                var balanceUSD = data.data.total_available / 500000;
                ctx.sendToPanel('calibrateResult', { success: true, balanceUSD: balanceUSD, silent: !!params.silent });
            } else {
                ctx.sendToPanel('calibrateResult', { success: false, error: "无法解析余额数据", silent: !!params.silent });
            }
        } else {
            ctx.sendToPanel('calibrateResult', { success: false, error: ctx.getErrorMessage(response.status), silent: !!params.silent });
        }
    } catch (e) {
        ctx.sendToPanel('calibrateResult', { success: false, error: "网络连接失败", silent: !!params.silent });
    }
}, { tileId: 'tasks' });

// ============================================================
//  墨墨(momo) 相关 — 统一走 host 转发, 避免 UXP 前端 fetch 的 failed to fetch
//  余额接口: GET /api/usage/token/  (注意尾斜杠), 返回 owner_balance_usd 等(已是美元)
// ============================================================

var _momoQuotaPerUnitValue = 500000;
var _momoQuotaPerUnitFetchedAt = 0;
var _momoQuotaPerUnitPromise = null;

// new-api 管理员可以修改 quota_per_unit。公开状态接口短缓存一次，失败才退回默认 500000。
function _getMomoQuotaPerUnit(apiBaseUrl) {
    if (_momoQuotaPerUnitFetchedAt && Date.now() - _momoQuotaPerUnitFetchedAt < 10 * 60 * 1000) {
        return Promise.resolve(_momoQuotaPerUnitValue);
    }
    if (_momoQuotaPerUnitPromise) return _momoQuotaPerUnitPromise;
    _momoQuotaPerUnitPromise = (async function() {
        try {
            var statusResp = await serverConfig.fetchWithTimeout(apiBaseUrl + '/api/status', { method: 'GET', cache: 'no-cache' }, 4000);
            if (!statusResp.ok) return _momoQuotaPerUnitValue;
            var statusJson = await statusResp.json();
            var raw = statusJson && statusJson.data && statusJson.data.quota_per_unit;
            var parsed = Number(raw);
            if (isFinite(parsed) && parsed > 0) {
                _momoQuotaPerUnitValue = parsed;
                _momoQuotaPerUnitFetchedAt = Date.now();
            }
        } catch (_) {}
        return _momoQuotaPerUnitValue;
    })().then(function(value) {
        _momoQuotaPerUnitPromise = null;
        return value;
    }, function() {
        _momoQuotaPerUnitPromise = null;
        return _momoQuotaPerUnitValue;
    });
    return _momoQuotaPerUnitPromise;
}

HostAPI.registerAction('checkMomoQuota', async function(params, ctx) {
    var apiBaseUrl = String(params.apiBaseUrl || '').replace(/\/+$/, '');
    var rid = params.requestId;
    try {
        var resp = await serverConfig.fetchWithTimeout(apiBaseUrl + '/api/usage/token/', { method: 'GET', headers: { 'Authorization': 'Bearer ' + params.apiKey }, cache: 'no-cache' }, 12000);
        if (resp.status === 401 || resp.status === 403) {
            ctx.sendToPanel('momoQuotaResult', { requestId: rid, success: false, error: 'Key 无效 (HTTP ' + resp.status + ')' });
            return true;
        }
        if (!resp.ok) {
            ctx.sendToPanel('momoQuotaResult', { requestId: rid, success: false, error: 'HTTP ' + resp.status });
            return true;
        }
        var json = await resp.json();
        var d = (json && json.data) ? json.data : (json || {});
        ctx.sendToPanel('momoQuotaResult', {
            requestId: rid, success: true,
            balance_usd: d.balance_usd,
            balance_cny: d.balance_cny,
            owner_balance_usd: d.owner_balance_usd,
            owner_balance_cny: d.owner_balance_cny,
            remain_quota: d.remain_quota,
            unlimited_quota: d.unlimited_quota,
            expires_at: d.expires_at
        });
    } catch (e) {
        ctx.sendToPanel('momoQuotaResult', { requestId: rid, success: false, error: (e && e.message) || '网络连接失败' });
    }
    return true;
}, { tileId: 'tasks' });

// 墨墨消费明细: GET /api/billing/token?period=daily|weekly|monthly
HostAPI.registerAction('momoBilling', async function(params, ctx) {
    var apiBaseUrl = String(params.apiBaseUrl || '').replace(/\/+$/, '');
    var rid = params.requestId;
    var period = params.period || 'daily';
    try {
        // 与账单并行查询，避免首次读取状态值增加整体等待时间。
        var quotaPerUnitPromise = _getMomoQuotaPerUnit(apiBaseUrl);
        var resp = await serverConfig.fetchWithTimeout(apiBaseUrl + '/api/billing/token?period=' + encodeURIComponent(period), { method: 'GET', headers: { 'Authorization': 'Bearer ' + params.apiKey }, cache: 'no-cache' }, 12000);
        if (!resp.ok) {
            ctx.sendToPanel('momoBillingResult', { requestId: rid, success: false, error: 'HTTP ' + resp.status });
            return true;
        }
        var json = await resp.json();
        var billingData = (json && json.data) || null;
        if (json && json.success && billingData) {
            billingData = Object.assign({}, billingData, { quota_per_unit: await quotaPerUnitPromise });
        }
        ctx.sendToPanel('momoBillingResult', { requestId: rid, success: !!(json && json.success), data: billingData, error: (json && json.message) || '' });
    } catch (e) {
        ctx.sendToPanel('momoBillingResult', { requestId: rid, success: false, error: (e && e.message) || '网络连接失败' });
    }
    return true;
}, { tileId: 'tasks' });

// 墨墨模型价目表: GET /api/models/price
// 该接口是公开只读接口，不携带 API Key；统一由 Host 请求以避开 UXP 的 CORS 限制。
HostAPI.registerAction('momoFetchPrices', async function(params, ctx) {
    var apiBaseUrl = 'https://api.momoapi.icu';
    var rid = params && params.requestId;
    try {
        var resp = await serverConfig.fetchWithTimeout(apiBaseUrl + '/api/models/price', { method: 'GET', cache: 'no-cache' }, 12000);
        var json = null;
        try { json = await resp.json(); } catch (_) {}
        if (!resp.ok) {
            ctx.sendToPanel('momoPricesResult', {
                requestId: rid,
                success: false,
                error: (json && json.message) || ('HTTP ' + resp.status)
            });
            return true;
        }
        if (!json || json.success !== true || !Array.isArray(json.data)) {
            ctx.sendToPanel('momoPricesResult', {
                requestId: rid,
                success: false,
                error: (json && json.message) || '价目表响应格式不正确'
            });
            return true;
        }
        var prices = json.data.map(function(m) {
            return {
                model_name: m && m.model_name,
                quota_type: m && m.quota_type,
                model_price: m && m.model_price,
                model_ratio: m && m.model_ratio,
                completion_ratio: m && m.completion_ratio,
                cache_ratio: m && m.cache_ratio,
                image_ratio: m && m.image_ratio,
                audio_ratio: m && m.audio_ratio,
                audio_completion_ratio: m && m.audio_completion_ratio
            };
        }).filter(function(m) { return !!m.model_name; });
        ctx.sendToPanel('momoPricesResult', { requestId: rid, success: true, data: prices });
    } catch (e) {
        ctx.sendToPanel('momoPricesResult', { requestId: rid, success: false, error: (e && e.message) || '网络连接失败' });
    }
    return true;
}, { tileId: 'tasks' });

// 墨墨模型列表: GET /v1/models, 返回原始 id 列表给前端过滤
HostAPI.registerAction('momoFetchModels', async function(params, ctx) {
    var apiBaseUrl = String(params.apiBaseUrl || '').replace(/\/+$/, '');
    var rid = params.requestId;
    try {
        var resp = await serverConfig.fetchWithTimeout(apiBaseUrl + '/v1/models', { method: 'GET', headers: { 'Authorization': 'Bearer ' + params.apiKey }, cache: 'no-cache' }, 12000);
        if (!resp.ok) {
            ctx.sendToPanel('momoModelsResult', { requestId: rid, success: false, error: 'HTTP ' + resp.status });
            return true;
        }
        var json = await resp.json();
        var ids = [];
        if (json && json.data && Array.isArray(json.data)) ids = json.data.map(function(m) { return m.id || m.name; }).filter(Boolean);
        else if (json && Array.isArray(json.models)) ids = json.models.map(function(m) { return typeof m === 'string' ? m : (m.id || m.name); }).filter(Boolean);
        else if (Array.isArray(json)) ids = json.map(function(m) { return typeof m === 'string' ? m : (m.id || m.name); }).filter(Boolean);
        ctx.sendToPanel('momoModelsResult', { requestId: rid, success: true, ids: ids });
    } catch (e) {
        ctx.sendToPanel('momoModelsResult', { requestId: rid, success: false, error: (e && e.message) || '网络连接失败' });
    }
    return true;
}, { tileId: 'tasks' });

// 墨墨「购买额度」链接: 从统一服务器配置拉后台 URL/文案
HostAPI.registerAction('getMomoLink', async function(params, ctx) {
    var rid = params.requestId;
    try {
        var resp = await serverConfig.fetchApi('/api/momo-link', { method: 'GET', cache: 'no-cache' });
        if (!resp.ok) { ctx.sendToPanel('momoLinkResult', { requestId: rid, success: false, error: 'HTTP ' + resp.status }); return true; }
        var j = await resp.json();
        ctx.sendToPanel('momoLinkResult', { requestId: rid, success: true, url: (j && j.url) || '', title: (j && j.title) || '' });
    } catch (e) {
        ctx.sendToPanel('momoLinkResult', { requestId: rid, success: false, error: (e && e.message) || '网络连接失败' });
    }
    return true;
}, { tileId: 'tasks' });

module.exports = {};
