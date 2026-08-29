// ============================================================
//  tile-forge.host.js
//  SD WebUI Forge 的后端处理器
//  通过 HostAPI.registerAction 注册到路由表
// ============================================================

var HostAPI = require('../host/host-api.js');
var evidenceLog = require('../host/evidence-log.js');   // 证据日志: 指纹+签章链
var serverConfig = require('../core/server-config.js');
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;
var uxpModule = require('uxp');
var storage = uxpModule.storage;
var fs = storage.localFileSystem;

// 当前文档信息(建两级缓存文件夹用); 拿不到(无文档/未保存)各字段留空
function readActiveDocInfo() {
    var info = { docId: null, docName: '', docPath: '' };
    try {
        var d = app.activeDocument;
        if (d) {
            info.docId = d.id;
            info.docName = d.name || '';
            try { info.docPath = d.path ? String(d.path) : ''; } catch(_p) {}
        }
    } catch(_e) {}
    return info;
}

function _findForgeDocById(docId) {
    for (var i = 0; i < app.documents.length; i++) {
        if (String(app.documents[i].id) === String(docId)) return app.documents[i];
    }
    return null;
}

async function _withForgeDocLock(ctx, taskId, docId, fn) {
    if (docId == null) {
        var noDocErr = new Error('PS 里没有打开的文档');
        noDocErr.code = 'PS_DOCUMENT_UNAVAILABLE';
        throw noDocErr;
    }
    if (!ctx || typeof ctx.acquirePSLock !== 'function') {
        var noLockErr = new Error('Photoshop 全局操作锁不可用');
        noLockErr.code = 'PS_LOCK_UNAVAILABLE';
        throw noLockErr;
    }
    return await ctx.acquirePSLock(async function() {
        var doc = _findForgeDocById(docId);
        if (!doc) {
            var closedErr = new Error('请求发起时的 PS 文档已关闭');
            closedErr.code = 'PS_DOCUMENT_CLOSED';
            throw closedErr;
        }
        if (!app.activeDocument || String(app.activeDocument.id) !== String(docId)) {
            await core.executeAsModal(async function() {
                await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: doc.id }] }], {});
            }, { commandName: '切换到 Forge 目标文档' });
        }
        return await fn(doc);
    }, taskId);
}

// 云服务(用于 source='cloud' 时解密 URL);若不可用则云源自动失效
var cloudService = null;
try { cloudService = require('../login-service.js'); } catch(e) { /* 未装云服务也不影响本地 */ }

// 统一的 URL 解析:前端传 {url} 或 {encrypted}
// 若传 encrypted 且有 cloudService → 解密
// 否则直接用 url
function resolveForgeUrl(data) {
    if (data && data.encrypted && cloudService && cloudService.decryptUrl) {
        try {
            var u = cloudService.decryptUrl(data.encrypted);
            if (u) return u.replace(/\/$/, '');
        } catch(e) {}
        return null;  // 解密失败
    }
    return data && data.url ? data.url : '';
}

// === 模块内私有状态 ===
var g_forgeAbortController = null;
var FORGE_QUERY_TIMEOUT_MS = 15000;
var FORGE_PROGRESS_TIMEOUT_MS = 5000;
var FORGE_MODEL_SWITCH_TIMEOUT_MS = 3600000;
var FORGE_GENERATE_TIMEOUT_MS = 3600 * 1000;

var FORGE_PRESETS_SUBFOLDER = "forge_presets";
var FACTORY_FORGE_PRESETS_SUBFOLDER = "factory_forge_presets";

// === 模块内私有 helper ===
function normalizeUrl(url) {
    if (!url) return '';
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

function resolveForgeTargetSize(params, savedSelection) {
    // resolution 参数控制宽边目标尺寸，窄边等比缩放
    var targetLong = parseInt(params && params.resolution, 10);
    if (!(targetLong > 0)) {
        // 兼容旧调用：如果没有 resolution 字段，从 width/height 取较大值
        var fw = parseInt(params && params.width, 10) || 0;
        var fh = parseInt(params && params.height, 10) || 0;
        targetLong = Math.max(fw, fh);
    }
    if (!(targetLong > 0)) targetLong = 768;

    if (savedSelection && savedSelection.width > 0 && savedSelection.height > 0) {
        var w = Math.max(1, Math.round(savedSelection.width));
        var h = Math.max(1, Math.round(savedSelection.height));
        var longEdge = Math.max(w, h);
        var scale = targetLong / longEdge;
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        return { width: w, height: h };
    }

    // 无选区：用前端传来的 width/height 做兜底，或者用 targetLong 正方形
    var fallbackW = parseInt(params && params.width, 10);
    var fallbackH = parseInt(params && params.height, 10);
    if (!(fallbackW > 0)) fallbackW = targetLong;
    if (!(fallbackH > 0)) fallbackH = targetLong;
    return { width: fallbackW, height: fallbackH };
}

// ============================================================
//  连接 & 拉取类 action
// ============================================================

HostAPI.registerAction('forgeTestConnection', async function(data, ctx) {
    var url = normalizeUrl(resolveForgeUrl(data));
    if (!url) { ctx.sendToPanel('forgeTestResult', { success: false, error: '云服务 URL 解密失败' }); return; }
    var fullUrl = url + '/sdapi/v1/options';
    try {
        var resp = await serverConfig.fetchWithTimeout(fullUrl, { method: 'GET' }, FORGE_QUERY_TIMEOUT_MS);
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + resp.statusText);
        var text = await resp.text();
        var parsed = JSON.parse(text);
        var model = parsed.sd_model_checkpoint || '未知';
        ctx.sendToPanel('forgeTestResult', { success: true, model: model });
    } catch(e) {
        var errType = e.name || 'Error';
        var errMsg = e.message || String(e);
        if (errMsg.indexOf('fetch') !== -1 || errMsg.indexOf('network') !== -1 || errMsg.indexOf('Failed') !== -1) {
            ctx.logToPanel("[Forge诊断] 网络层失败 - SD WebUI可能未启动, 或端口/地址错误, 或UXP不允许访问此地址", "error");
            ctx.logToPanel("[Forge诊断] 请确认: 1.SD WebUI已启动 2.API已启用(--api) 3.地址正确(默认http://127.0.0.1:7860) 4.尝试http://localhost:7860", "warn");
        } else if (errMsg.indexOf('HTTP') !== -1) {
            ctx.logToPanel("[Forge诊断] 服务器有响应但返回错误状态码", "error");
        } else if (errMsg.indexOf('JSON') !== -1) {
            ctx.logToPanel("[Forge诊断] 服务器有响应但返回非JSON数据", "error");
        }
        ctx.sendToPanel('forgeTestResult', { success: false, error: errType + ': ' + errMsg });
    }
}, { tileId: 'forge' });

HostAPI.registerAction('forgeFetchModels', async function(data, ctx) {
    var url = normalizeUrl(resolveForgeUrl(data));
    if (!url) { ctx.sendToPanel('forgeModelsResult', { success: false, error: '云服务 URL 解密失败' }); return; }
    try {
        var resp = await serverConfig.fetchWithTimeout(url + '/sdapi/v1/sd-models', { method: 'GET' }, FORGE_QUERY_TIMEOUT_MS);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var models = await resp.json();
        ctx.sendToPanel('forgeModelsResult', { success: true, models: models });
    } catch(e) {
        ctx.sendToPanel('forgeModelsResult', { success: false, error: e.message });
    }
}, { tileId: 'forge' });

HostAPI.registerAction('forgeFetchSamplers', async function(data, ctx) {
    var url = normalizeUrl(resolveForgeUrl(data));
    if (!url) { ctx.sendToPanel('forgeSamplersResult', { success: false, error: '云服务 URL 解密失败' }); return; }
    try {
        var resp = await serverConfig.fetchWithTimeout(url + '/sdapi/v1/samplers', { method: 'GET' }, FORGE_QUERY_TIMEOUT_MS);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var samplers = await resp.json();
        ctx.sendToPanel('forgeSamplersResult', { success: true, samplers: samplers });
    } catch(e) {
        ctx.sendToPanel('forgeSamplersResult', { success: false, error: e.message });
    }
}, { tileId: 'forge' });

HostAPI.registerAction('forgeFetchControlNetModules', async function(data, ctx) {
    var url = normalizeUrl(resolveForgeUrl(data));
    if (!url) { ctx.sendToPanel('forgeCnModulesResult', { success: false, error: '云服务 URL 解密失败' }); return; }
    try {
        var resp = await serverConfig.fetchWithTimeout(url + '/controlnet/module_list', { method: 'GET' }, FORGE_QUERY_TIMEOUT_MS);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var parsed = await resp.json();
        var modules = parsed.module_list || [];
        ctx.sendToPanel('forgeCnModulesResult', { success: true, modules: modules });
    } catch(e) {
        ctx.sendToPanel('forgeCnModulesResult', { success: false, error: e.message });
    }
}, { tileId: 'forge' });

HostAPI.registerAction('forgeFetchControlNetModels', async function(data, ctx) {
    var url = normalizeUrl(resolveForgeUrl(data));
    if (!url) { ctx.sendToPanel('forgeCnModelsResult', { success: false, error: '云服务 URL 解密失败' }); return; }
    try {
        var resp = await serverConfig.fetchWithTimeout(url + '/controlnet/model_list', { method: 'GET' }, FORGE_QUERY_TIMEOUT_MS);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var parsed = await resp.json();
        var models = parsed.model_list || [];
        ctx.sendToPanel('forgeCnModelsResult', { success: true, models: models });
    } catch(e) {
        ctx.sendToPanel('forgeCnModelsResult', { success: false, error: e.message });
    }
}, { tileId: 'forge' });

HostAPI.registerAction('forgeFetchLoras', async function(data, ctx) {
    var url = normalizeUrl(resolveForgeUrl(data));
    if (!url) { ctx.sendToPanel('forgeLorasResult', { success: false, error: '云服务 URL 解密失败' }); return; }
    try {
        var resp = await serverConfig.fetchWithTimeout(url + '/sdapi/v1/loras', { method: 'GET' }, FORGE_QUERY_TIMEOUT_MS);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var loras = await resp.json();
        ctx.sendToPanel('forgeLorasResult', { success: true, loras: loras });
    } catch(e) {
        ctx.sendToPanel('forgeLorasResult', { success: false, error: e.message });
    }
}, { tileId: 'forge' });

// 统一时间线(v6.4.8): Forge 也归档回收站(带参数快照, 供[载入提示词]还原)
// snapshot 从前端 payload 取(与老历史 forgeSnapshot 字段对齐)
function buildForgeArchMeta(taskId, params, docInfo, kind) {
    return {
        id: taskId + '_' + Date.now(),
        batchId: taskId,
        workflow: 'forge',
        prompt: params.prompt || '',
        model: params.model || '',
        provider: 'forge',
        size: (params.width && params.height) ? (params.width + 'x' + params.height) : String(params.resolution || ''),
        aspectRatio: '',
        presetTitle: params.presetTitle || '',
        presetKind: 'forge',
        forgeSnapshot: {
            positivePrompt: params.prompt || '',
            negativePrompt: params.negPrompt || '',
            steps: params.steps || 20,
            cfg: params.cfg || 7,
            denoise: params.denoise || 0.75,
            resolution: params.resolution || 768,
            sampler: params.sampler || 'Euler a',
            model: params.model || '',
            batchSize: params.batchSize || 1,
            seed: (params.seed !== undefined && params.seed !== null) ? params.seed : -1
        },
        context: {
            docId: docInfo && docInfo.docId,
            docName: (docInfo && docInfo.docName) || '',
            docPath: (docInfo && docInfo.docPath) || '',
            selection: null,   // 贴回用的选区由调用处补
            antiMode: 0,
            layerType: 'smartObject',
            groupName: kind === 'txt2img' ? 'Forge文生图' : 'Forge'
        },
        extras: { forgeKind: kind }
    };
}

// v6.5.0 生成中心: Forge 也发对话气泡事件(request 不带大图 — forge 输入图大, 只发文本)
function convEmitForge(ctx, payload) {
    try { ctx.sendToPanel('conversationEvent', payload); } catch(_) {}
}

// ============================================================
//  img2img
// ============================================================

HostAPI.registerAction('forgeImg2Img', async function(params, ctx) {
    var forgeTaskId = params.taskId || ('forge_img2img_' + Date.now());
    var _evStartTs = Date.now();
    var _docInfo = readActiveDocInfo();
    // 缓存文件夹建失败(如磁盘满)不挡生成: runFolder 置空, 各 save* 函数自带空值保护
    var runFolder = null;
    try {
        runFolder = await ctx.createImageCacheRunFolder({
            engine: 'forge', taskId: forgeTaskId,
            label: params.presetTitle || 'Forge',
            docName: _docInfo.docName, docPath: _docInfo.docPath, docId: _docInfo.docId
        });
    } catch (rfErr) {
        ctx.logToPanel('[Forge] 创建缓存文件夹失败(生成继续, 本次不落缓存): ' + (rfErr.message || rfErr), 'warn');
    }
    var runPath = (runFolder && (runFolder.wcRunPath || runFolder.name)) || '';
    var url = normalizeUrl(resolveForgeUrl(params));
    if (!url) {
        ctx.sendToPanel('forgeComplete', { taskId: forgeTaskId, success: false, error: '云服务 URL 解密失败', error_category: 'forge.crypto.url_decrypt_fail' });
        ctx.sendToPanel('taskComplete', { taskId: forgeTaskId, successCount: 0, failCount: 1, engine: 'forge', error: '云服务 URL 解密失败', error_category: 'forge.crypto.url_decrypt_fail' });
        return;
    }
    var _progressTimer;
    var _progressRequestBusy = false;
    try {
        // 1. 抓取当前选区
        ctx.logToPanel("[Forge] 正在抓取选区...", "info");
        var originDocId = _docInfo.docId;
        var capture = await _withForgeDocLock(ctx, forgeTaskId, originDocId, async function() {
            var savedAntiMode = ctx.g_antiTruncationModeRef.value;
            try {
                ctx.g_antiTruncationModeRef.value = 0;
                var lockedCapture = await ctx.getSelectionAndImage();
                if (lockedCapture) await ctx.deselectAll();
                return lockedCapture;
            } finally {
                ctx.g_antiTruncationModeRef.value = savedAntiMode;
            }
        });
        if (!capture) {
            ctx.logToPanel("[Forge] 未检测到选区", "error");
            ctx.sendToPanel('forgeComplete', { taskId: forgeTaskId, success: false, error: "未检测到选区", error_category: 'forge.input.no_selection' });
            ctx.sendToPanel('taskComplete', { taskId: forgeTaskId, successCount: 0, failCount: 1, engine: 'forge', error: '未检测到选区', error_category: 'forge.input.no_selection' });
            return;
        }
        var savedSelection = capture.selection;
        await ctx.saveImageToRunFolder(runFolder, 'input', capture.base64, 1);

        // Forge 任务选区缩略图: 主动发一次 previewImage 让任务磁贴/历史磁贴挂上图
        try {
            ctx.sendToPanel('previewImage', { taskId: forgeTaskId, base64: capture.base64, docId: originDocId, docName: _docInfo.docName, docPath: _docInfo.docPath, selection: savedSelection });
        } catch(_e0) {}

        // 生成中心气泡: request (不带图 — 缩略图已走 previewImage 通道)
        convEmitForge(ctx, {
            type: 'request', taskId: forgeTaskId,
            provider: 'forge', model: params.model || '',
            size: (params.width && params.height) ? (params.width + 'x' + params.height) : String(params.resolution || ''),
            aspectRatio: '', prompt: params.prompt || '',
            mainBase64: '', refBase64s: [], ts: Date.now()
        });

        // 2. 可选：切换模型
        if (params.model) {
            try {
                ctx.logToPanel("[Forge] 切换模型: " + params.model, "info");
                var switchResp = await serverConfig.fetchWithTimeout(url + '/sdapi/v1/options', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sd_model_checkpoint: params.model })
                }, FORGE_MODEL_SWITCH_TIMEOUT_MS);
                if (!switchResp.ok) throw new Error('HTTP ' + switchResp.status);
                try { await switchResp.text(); } catch (_) {}
            } catch(e) { ctx.logToPanel("[Forge] 模型切换请求失败(继续使用当前模型): " + e.message, "warn"); }
        }

        // 3. 调用 img2img API（带进度轮询）
        ctx.logToPanel("[Forge] 发送 img2img 请求...", "info");
        g_forgeAbortController = new AbortController();
        _progressTimer = setInterval(async function() {
            if (_progressRequestBusy) return;
            _progressRequestBusy = true;
            try {
                var pr = await serverConfig.fetchWithTimeout(url + '/sdapi/v1/progress', { method: 'GET' }, FORGE_PROGRESS_TIMEOUT_MS);
                if (pr.ok) {
                    var pd = await pr.json();
                    ctx.sendToPanel('forgeProgress', { taskId: forgeTaskId, progress: pd.progress || 0, eta: pd.eta_relative || 0, textinfo: pd.textinfo || '' });
                }
            } catch(pe) {
            } finally {
                _progressRequestBusy = false;
            }
        }, 1000);
        var forgeTargetSize2 = resolveForgeTargetSize(params, savedSelection);
        var payload = {
            init_images: ["data:image/png;base64," + capture.base64],
            prompt: params.prompt || "",
            negative_prompt: params.negPrompt || "",
            steps: params.steps || 20,
            cfg_scale: params.cfg || 7,
            denoising_strength: params.denoise || 0.75,
            width: forgeTargetSize2.width,
            height: forgeTargetSize2.height,
            sampler_name: params.sampler || "Euler a",
            batch_size: params.batchSize || 1,
            seed: (params.seed !== undefined && params.seed !== null) ? params.seed : -1
        };
        // ControlNet
        if (params.cnEnabled) {
            var cnUnit = {
                enabled: true,
                module: params.cnModule || undefined,
                model: params.cnModel || undefined,
                weight: (typeof params.cnWeight === 'number') ? params.cnWeight : 1,
                guidance_start: 0,
                guidance_end: 1,
                pixel_perfect: true,
                control_mode: 0,
                resize_mode: 1
            };
            payload.controlnet_units = [cnUnit];
            payload.alwayson_scripts = { ControlNet: { args: [cnUnit] } };
            ctx.logToPanel("[Forge] ControlNet: " + (params.cnModel || 'none') + ", weight=" + cnUnit.weight, "info");
        }
        var response = await serverConfig.fetchWithTimeout(url + '/sdapi/v1/img2img', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: g_forgeAbortController.signal
        }, FORGE_GENERATE_TIMEOUT_MS);
        clearInterval(_progressTimer);
        ctx.sendToPanel('forgeProgress', { taskId: forgeTaskId, progress: 1, done: true });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var data = await response.json();
        g_forgeAbortController = null;
        if (!data.images || data.images.length === 0) throw new Error("API 未返回图片");

        // 4. 贴回PS（支持多张）
        var imgCount = data.images.length;
        ctx.logToPanel("[Forge] 正在贴回 " + imgCount + " 张图片...", "info");

        var forgePayloads = [];
        for (var fi = 0; fi < imgCount; fi++) {
            var resultBase64 = data.images[fi];
            if (resultBase64.indexOf(',') !== -1) resultBase64 = resultBase64.split(',')[1];
            await ctx.saveImageToRunFolder(runFolder, 'output', resultBase64, fi + 1);
            forgePayloads.push(resultBase64);
        }
        await ctx.savePromptTxtToRunFolder(runFolder, params.prompt || '');
        // 回收站归档(统一时间线): 每张一条, 共享 batchId; 带选区供智能贴回
        var archiveIds = [];
        for (var fa = 0; fa < forgePayloads.length; fa++) {
            var _fArch = buildForgeArchMeta(forgeTaskId, params, _docInfo, 'img2img');
            _fArch.id = forgeTaskId + '_' + fa + '_' + Date.now();
            _fArch.context.selection = savedSelection;
            archiveIds.push(_fArch.id);
            try { await ctx.archiveToRecycleBin(_fArch, forgePayloads[fa], 'success'); } catch(_ae) {}
        }
        // 生成中心气泡: 结果图 + 归档号(供后台完成图传回用)
        convEmitForge(ctx, { type: 'response', taskId: forgeTaskId, success: true, base64s: forgePayloads.slice(), archiveIds: archiveIds, text: '', ts: Date.now() });
        // 证据日志(指纹+签章链): 异步写, 不挡贴回
        evidenceLog.appendEvidence({
            runFolder: runFolder, runPath: runPath,
            taskId: forgeTaskId, startTs: _evStartTs, endTs: Date.now(),
            engine: 'forge', model: params.model || '',
            source: params.encrypted ? 'cloud' : 'local',
            docName: _docInfo.docName, prompt: params.prompt || '',
            inputs: capture && capture.base64 ? [capture.base64] : [],
            outputs: forgePayloads.slice()
        }).then(function(evRes) {
            if (evRes && evRes.ok) ctx.logToPanel('[证据日志] 已记录 链号#' + evRes.seq, 'info');
            else ctx.logToPanel('[证据日志] 写入失败(不影响生成): ' + ((evRes && evRes.error) || '?'), 'warn');
        });

        try {
            var forgeReturn = await _withForgeDocLock(ctx, forgeTaskId, originDocId, async function() {
                var createdIds = [];
                var pendingForgePayloads = [];
                var _fIds = await ctx.placeImagesAuto(originDocId, forgePayloads.map(function(p) {
                    return { base64: p, selection: savedSelection, antiMode: 0, layerType: ctx.g_layerTypeRef.value };
                }));
                for (var fi2 = 0; fi2 < forgePayloads.length; fi2++) {
                    var placedForgeId = _fIds && _fIds[fi2];
                    if (!placedForgeId) {
                        pendingForgePayloads.push(forgePayloads[fi2]);
                        continue;
                    }
                    createdIds.push(placedForgeId);
                    try {
                        await ctx.applyReturnFeatherMaskToLayer(originDocId, placedForgeId, savedSelection, 'forge');
                    } catch (featherErr) {
                        ctx.logToPanel('[Forge] 图已贴回，但羽化蒙版失败: ' + ((featherErr && featherErr.message) || featherErr), 'warn');
                    }
                }
                if (createdIds.length > 1 && ctx.g_autoGroupRef.value) {
                    try {
                        await core.executeAsModal(async function() {
                            await ctx.createGroupAndMask(createdIds, "Forge");
                        }, { commandName: "Forge打组" });
                    } catch (groupErr) {
                        ctx.logToPanel('[Forge] 图已贴回，但自动分组失败: ' + ((groupErr && groupErr.message) || groupErr), 'warn');
                    }
                }
                return { createdIds: createdIds, pendingPayloads: pendingForgePayloads };
            });
            var createdIds = forgeReturn.createdIds;
            var pendingForgePayloads = forgeReturn.pendingPayloads;
            if (pendingForgePayloads.length > 0) {
                ctx.g_taskResultCache[forgeTaskId] = {
                    originDocId: originDocId, savedSelection: savedSelection,
                    antiMode: 0, layerType: ctx.g_layerTypeRef.value,
                    payloads: pendingForgePayloads.slice(), groupName: 'Forge', returnWorkflowKey: 'forge',
                    runFolderName: runPath, docName: _docInfo.docName, engine: 'forge'
                };
                ctx.logToPanel('[Forge] img2img 已贴回 ' + createdIds.length + ' 张，' + pendingForgePayloads.length + ' 张等待手动传回', 'warn');
                ctx.sendToPanel('forgeComplete', { taskId: forgeTaskId, success: true, pendingReturn: true });
                ctx.sendToPanel('forgeReturnFailed', { taskId: forgeTaskId, count: pendingForgePayloads.length, error: '部分图片未能贴回' });
                ctx.sendToPanel('taskComplete', {
                    taskId: forgeTaskId, successCount: forgePayloads.length, generatedCount: forgePayloads.length,
                    returnedCount: createdIds.length, pendingCount: pendingForgePayloads.length,
                    failCount: 0, engine: 'forge', pendingReturn: true
                });
                try { await ctx.playSuccessSound(); } catch (_) {}
            } else if (createdIds.length > 0) {
                ctx.logToPanel("[Forge] img2img 完成! 共贴回 " + createdIds.length + " 张", "success");
                ctx.sendToPanel('forgeComplete', { taskId: forgeTaskId, success: true });
                // 发 taskComplete 让 tile-tasks/history 按 banana 规则消费
                ctx.sendToPanel('taskComplete', { taskId: forgeTaskId, successCount: createdIds.length, generatedCount: createdIds.length, returnedCount: createdIds.length, pendingCount: 0, failCount: 0, engine: 'forge' });
                try { await ctx.playSuccessSound(); } catch (_) {}
            } else {
                throw new Error("贴回失败");
            }
        } catch(placeErr) {
            ctx.logToPanel("[Forge] 贴回失败（PS可能正忙）: " + placeErr.message + "，图片已保存，请完成PS操作后手动传回", "warn");
            ctx.g_taskResultCache[forgeTaskId] = {
                originDocId: originDocId, savedSelection: savedSelection,
                antiMode: 0, layerType: ctx.g_layerTypeRef.value,
                payloads: forgePayloads, groupName: 'Forge', returnWorkflowKey: 'forge',
                // 校色台账所需(手动传回时登记)
                runFolderName: runPath, docName: _docInfo.docName, engine: 'forge'
            };
            ctx.sendToPanel('forgeComplete', { taskId: forgeTaskId, success: true });
            ctx.sendToPanel('forgeReturnFailed', { taskId: forgeTaskId, count: forgePayloads.length, error: placeErr.message });
            ctx.sendToPanel('taskComplete', { taskId: forgeTaskId, successCount: forgePayloads.length, failCount: 0, engine: 'forge', pendingReturn: true });
            try { await ctx.playSuccessSound(); } catch (_) {}
        }
    } catch(e) {
        try { clearInterval(_progressTimer); } catch(x) {}
        ctx.sendToPanel('forgeProgress', { taskId: forgeTaskId, progress: 0, done: true });
        g_forgeAbortController = null;
        if (e.name === 'AbortError') {
            ctx.logToPanel("[Forge] 已中断", "warn");
            ctx.sendToPanel('forgeComplete', { taskId: forgeTaskId, success: false, error: "已中断", error_category: 'forge.user.aborted' });
            ctx.sendToPanel('taskComplete', { taskId: forgeTaskId, successCount: 0, failCount: 1, engine: 'forge', error: '已中断', error_category: 'forge.user.aborted' });
        } else {
            ctx.logToPanel("[Forge] img2img 失败: " + e.message, "error");
            // 失败也归档(统一时间线里显示红卡, 用户能回看报错和参数)
            try {
                var _fFailArch = buildForgeArchMeta(forgeTaskId, params, _docInfo, 'img2img');
                await ctx.archiveToRecycleBin(_fFailArch, null, 'failed', e.message || String(e));
            } catch(_afe) {}
            // 生成中心气泡: 失败
            convEmitForge(ctx, { type: 'response', taskId: forgeTaskId, success: false, error: String(e.message || e), ts: Date.now() });
            var _ec = 'forge.api.unknown';
            var _em = String(e.message || '');
            if (/^HTTP\s*5\d\d/.test(_em)) _ec = 'forge.api.http_5xx';
            else if (/^HTTP\s*4\d\d/.test(_em)) _ec = 'forge.api.http_4xx';
            else if (/timeout|timed out/i.test(_em)) _ec = 'forge.api.timeout';
            else if (/Failed to fetch|NetworkError|ENOTFOUND|ECONNREFUSED/i.test(_em)) _ec = 'forge.api.network_fail';
            ctx.sendToPanel('forgeComplete', { taskId: forgeTaskId, success: false, error: e.message, error_category: _ec });
            ctx.sendToPanel('taskComplete', { taskId: forgeTaskId, successCount: 0, failCount: 1, engine: 'forge', error: e.message, error_category: _ec });
        }
    }
}, { tileId: 'forge' });

// ============================================================
//  txt2img
// ============================================================

HostAPI.registerAction('forgeTxt2Img', async function(params, ctx) {
    params = params || {};
    var _evStartTs2 = Date.now();
    var forgeTxtTaskId = params.taskId || ('forge_txt2img_' + Date.now());
    var _forgeTxtCompleteSent = false;
    var _forgeTxtTaskCompleteSent = false;
    function _sendForgeTxtComplete(data) {
        if (_forgeTxtCompleteSent) return;
        _forgeTxtCompleteSent = true;
        data = data || {};
        data.taskId = forgeTxtTaskId;
        ctx.sendToPanel('forgeComplete', data);
    }
    function _sendForgeTxtTaskComplete(data) {
        if (_forgeTxtTaskCompleteSent) return;
        _forgeTxtTaskCompleteSent = true;
        data = data || {};
        data.taskId = forgeTxtTaskId;
        if (ctx.sendTaskCompleteOnce) ctx.sendTaskCompleteOnce(forgeTxtTaskId, data);
        else ctx.sendToPanel('taskComplete', data);
    }
    var _docInfo2 = readActiveDocInfo();
    // 缓存文件夹建失败不挡生成(同 img2img)
    var runFolder = null;
    try {
        runFolder = await ctx.createImageCacheRunFolder({
            engine: 'forge', taskId: forgeTxtTaskId,
            label: params.presetTitle || 'Forge文生图',
            docName: _docInfo2.docName, docPath: _docInfo2.docPath, docId: _docInfo2.docId
        });
    } catch (rfErr2) {
        ctx.logToPanel('[Forge] 创建缓存文件夹失败(生成继续, 本次不落缓存): ' + (rfErr2.message || rfErr2), 'warn');
    }
    var runPath = (runFolder && (runFolder.wcRunPath || runFolder.name)) || '';
    var url = normalizeUrl(resolveForgeUrl(params));
    if (!url) {
        _sendForgeTxtComplete({ success: false, error: '云服务 URL 解密失败', error_category: 'forge.crypto.url_decrypt_fail' });
        _sendForgeTxtTaskComplete({ successCount: 0, failCount: 1, engine: 'forge', error: '云服务 URL 解密失败', error_category: 'forge.crypto.url_decrypt_fail' });
        return;
    }
    var _progressTimer2;
    var _progressRequestBusy2 = false;
    try {
        var originDocId = _docInfo2.docId;
        var savedSelection = null;
        var _txtInputB64 = null;
        try {
            var capture = await _withForgeDocLock(ctx, forgeTxtTaskId, originDocId, async function() {
                var savedAntiMode = ctx.g_antiTruncationModeRef.value;
                try {
                    ctx.g_antiTruncationModeRef.value = 0;
                    var lockedCapture = await ctx.getSelectionAndImage();
                    if (lockedCapture) await ctx.deselectAll();
                    return lockedCapture;
                } finally {
                    ctx.g_antiTruncationModeRef.value = savedAntiMode;
                }
            });
            if (capture) {
                savedSelection = capture.selection;
                _txtInputB64 = capture.base64;
                await ctx.saveImageToRunFolder(runFolder, 'input', capture.base64, 1);
            }
        } catch(e) {
            if (e && (e.code === 'PS_DOCUMENT_CLOSED' || e.code === 'PS_DOCUMENT_UNAVAILABLE' || e.code === 'PS_LOCK_UNAVAILABLE')) throw e;
            ctx.logToPanel('[Forge 文生图] 可选抓图失败，继续纯文生图: ' + ((e && e.message) || e), 'warn');
        }

        // 可选：切换模型
        if (params.model) {
            try {
                ctx.logToPanel("[Forge] 切换模型: " + params.model, "info");
                var switchResp2 = await serverConfig.fetchWithTimeout(url + '/sdapi/v1/options', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sd_model_checkpoint: params.model })
                }, FORGE_MODEL_SWITCH_TIMEOUT_MS);
                if (!switchResp2.ok) throw new Error('HTTP ' + switchResp2.status);
                try { await switchResp2.text(); } catch (_) {}
            } catch(e) { ctx.logToPanel("[Forge] 模型切换请求失败: " + e.message, "warn"); }
        }

        ctx.logToPanel("[Forge] 发送 txt2img 请求...", "info");
        g_forgeAbortController = new AbortController();
        _progressTimer2 = setInterval(async function() {
            if (_progressRequestBusy2) return;
            _progressRequestBusy2 = true;
            try {
                var pr = await serverConfig.fetchWithTimeout(url + '/sdapi/v1/progress', { method: 'GET' }, FORGE_PROGRESS_TIMEOUT_MS);
                if (pr.ok) {
                    var pd = await pr.json();
                    ctx.sendToPanel('forgeProgress', { taskId: forgeTxtTaskId, progress: pd.progress || 0, eta: pd.eta_relative || 0, textinfo: pd.textinfo || '' });
                }
            } catch(pe) {
            } finally {
                _progressRequestBusy2 = false;
            }
        }, 1000);
        var payload = {
            prompt: params.prompt || "",
            negative_prompt: params.negPrompt || "",
            steps: params.steps || 20,
            cfg_scale: params.cfg || 7,
            width: params.width || 512,
            height: params.height || 512,
            sampler_name: params.sampler || "Euler a",
            batch_size: params.batchSize || 1,
            seed: (params.seed !== undefined && params.seed !== null) ? params.seed : -1
        };
        // ControlNet
        if (params.cnEnabled) {
            var cnUnit2 = {
                enabled: true,
                module: params.cnModule || undefined,
                model: params.cnModel || undefined,
                weight: (typeof params.cnWeight === 'number') ? params.cnWeight : 1,
                guidance_start: 0,
                guidance_end: 1,
                pixel_perfect: true,
                control_mode: 0,
                resize_mode: 1
            };
            payload.controlnet_units = [cnUnit2];
            payload.alwayson_scripts = { ControlNet: { args: [cnUnit2] } };
            ctx.logToPanel("[Forge] ControlNet: " + (params.cnModel || 'none') + ", weight=" + cnUnit2.weight, "info");
        }
        var response = await serverConfig.fetchWithTimeout(url + '/sdapi/v1/txt2img', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: g_forgeAbortController.signal
        }, FORGE_GENERATE_TIMEOUT_MS);
        clearInterval(_progressTimer2);
        ctx.sendToPanel('forgeProgress', { taskId: forgeTxtTaskId, progress: 1, done: true });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var data = await response.json();
        g_forgeAbortController = null;
        if (!data.images || data.images.length === 0) throw new Error("API 未返回图片");

        // 贴回PS（支持多张）
        var imgCount2 = data.images.length;
        ctx.logToPanel("[Forge] 正在贴回 " + imgCount2 + " 张图片...", "info");

        var forgePayloads2 = [];
        for (var ti = 0; ti < imgCount2; ti++) {
            var resultBase64 = data.images[ti];
            if (resultBase64.indexOf(',') !== -1) resultBase64 = resultBase64.split(',')[1];
            await ctx.saveImageToRunFolder(runFolder, 'output', resultBase64, ti + 1);
            forgePayloads2.push(resultBase64);
        }
        await ctx.savePromptTxtToRunFolder(runFolder, params.prompt || '');
        // 回收站归档(统一时间线)
        for (var ta = 0; ta < forgePayloads2.length; ta++) {
            var _tArch = buildForgeArchMeta(forgeTxtTaskId, params, _docInfo2, 'txt2img');
            _tArch.id = forgeTxtTaskId + '_' + ta + '_' + Date.now();
            _tArch.context.selection = savedSelection;
            try { await ctx.archiveToRecycleBin(_tArch, forgePayloads2[ta], 'success'); } catch(_ae2) {}
        }
        // 生成中心气泡: txt2img 的 request(此时才发 — 前面没有固定发送点) + 结果
        convEmitForge(ctx, {
            type: 'request', taskId: forgeTxtTaskId,
            provider: 'forge', model: params.model || '',
            size: (params.width || 512) + 'x' + (params.height || 512),
            aspectRatio: '', prompt: params.prompt || '',
            mainBase64: '', refBase64s: [], ts: Date.now()
        });
        convEmitForge(ctx, { type: 'response', taskId: forgeTxtTaskId, success: true, base64s: forgePayloads2.slice(), text: '', ts: Date.now() });
        // 证据日志(指纹+签章链): 异步写, 不挡贴回
        evidenceLog.appendEvidence({
            runFolder: runFolder, runPath: runPath,
            taskId: forgeTxtTaskId, startTs: _evStartTs2, endTs: Date.now(),
            engine: 'forge', model: params.model || '',
            source: params.encrypted ? 'cloud' : 'local',
            docName: _docInfo2.docName, prompt: params.prompt || '',
            inputs: _txtInputB64 ? [_txtInputB64] : [],
            outputs: forgePayloads2.slice()
        }).then(function(evRes) {
            if (evRes && evRes.ok) ctx.logToPanel('[证据日志] 已记录 链号#' + evRes.seq, 'info');
            else ctx.logToPanel('[证据日志] 写入失败(不影响生成): ' + ((evRes && evRes.error) || '?'), 'warn');
        });

        try {
            var forgeTxtReturn = await _withForgeDocLock(ctx, forgeTxtTaskId, originDocId, async function() {
                var createdIds2 = [];
                var _tIds = await ctx.placeImagesAuto(originDocId, forgePayloads2.map(function(p) {
                    return { base64: p, selection: savedSelection, antiMode: 0, layerType: ctx.g_layerTypeRef.value };
                }));
                var pendingPayloads2 = [];
                for (var ti2 = 0; ti2 < forgePayloads2.length; ti2++) {
                    var placedId2 = _tIds && _tIds[ti2];
                    if (!placedId2) {
                        pendingPayloads2.push(forgePayloads2[ti2]);
                        continue;
                    }
                    createdIds2.push(placedId2);
                    try {
                        await ctx.applyReturnFeatherMaskToLayer(originDocId, placedId2, savedSelection, 'forge');
                    } catch (featherErr2) {
                        // 图已经贴回，羽化失败不能把它重新放进手动缓存，否则会重复贴图。
                        ctx.logToPanel('[Forge] 图已贴回，但羽化蒙版失败: ' + ((featherErr2 && featherErr2.message) || featherErr2), 'warn');
                    }
                }
                if (createdIds2.length > 1 && ctx.g_autoGroupRef.value) {
                    try {
                        await core.executeAsModal(async function() {
                            await ctx.createGroupAndMask(createdIds2, "Forge");
                        }, { commandName: "Forge打组" });
                    } catch (groupErr2) {
                        // 分组失败不改变每张图已贴回的事实，也不能触发重复手动贴回。
                        ctx.logToPanel('[Forge] 图已贴回，但自动分组失败: ' + ((groupErr2 && groupErr2.message) || groupErr2), 'warn');
                    }
                }
                return { createdIds: createdIds2, pendingPayloads: pendingPayloads2 };
            });
            var createdIds2 = forgeTxtReturn.createdIds;
            var pendingPayloads2 = forgeTxtReturn.pendingPayloads;

            if (pendingPayloads2.length > 0) {
                ctx.g_taskResultCache[forgeTxtTaskId] = {
                    originDocId: originDocId, savedSelection: savedSelection,
                    antiMode: 0, layerType: ctx.g_layerTypeRef.value,
                    payloads: pendingPayloads2,
                    items: pendingPayloads2.map(function(b64) {
                        return { base64: b64, docId: originDocId, selection: savedSelection,
                            antiMode: 0, layerType: ctx.g_layerTypeRef.value, returnWorkflowKey: 'forge' };
                    }),
                    groupName: 'Forge', returnWorkflowKey: 'forge',
                    runFolderName: runPath, docName: _docInfo2.docName, engine: 'forge'
                };
                ctx.logToPanel('[Forge] txt2img 已贴回 ' + createdIds2.length + ' 张，' + pendingPayloads2.length + ' 张等待手动传回', 'warn');
                _sendForgeTxtComplete({ success: true, pendingReturn: true });
                _sendForgeTxtTaskComplete({ successCount: forgePayloads2.length, returnedCount: createdIds2.length,
                    pendingCount: pendingPayloads2.length, failCount: 0, engine: 'forge', pendingReturn: true });
                ctx.sendToPanel('forgeReturnFailed', { taskId: forgeTxtTaskId, count: pendingPayloads2.length, error: '部分图片未能贴回' });
            } else if (createdIds2.length > 0) {
                ctx.logToPanel("[Forge] txt2img 完成! 共贴回 " + createdIds2.length + " 张", "success");
                _sendForgeTxtComplete({ success: true });
                _sendForgeTxtTaskComplete({ successCount: createdIds2.length, returnedCount: createdIds2.length,
                    failCount: 0, engine: 'forge' });
            } else {
                throw new Error("贴回失败");
            }
            try { await ctx.playSuccessSound(); } catch (soundErr2) {}
        } catch(placeErr2) {
            ctx.logToPanel("[Forge] 贴回失败（PS可能正忙）: " + placeErr2.message + "，图片已保存，请完成PS操作后手动传回", "warn");
            ctx.g_taskResultCache[forgeTxtTaskId] = {
                originDocId: originDocId, savedSelection: savedSelection,
                antiMode: 0, layerType: ctx.g_layerTypeRef.value,
                payloads: forgePayloads2,
                items: forgePayloads2.map(function(b64) {
                    return { base64: b64, docId: originDocId, selection: savedSelection,
                        antiMode: 0, layerType: ctx.g_layerTypeRef.value, returnWorkflowKey: 'forge' };
                }),
                groupName: 'Forge', returnWorkflowKey: 'forge',
                runFolderName: runPath, docName: _docInfo2.docName, engine: 'forge'
            };
            _sendForgeTxtComplete({ success: true, pendingReturn: true });
            _sendForgeTxtTaskComplete({ successCount: forgePayloads2.length, returnedCount: 0,
                pendingCount: forgePayloads2.length, failCount: 0, engine: 'forge', pendingReturn: true });
            ctx.sendToPanel('forgeReturnFailed', { taskId: forgeTxtTaskId, count: forgePayloads2.length, error: placeErr2.message });
        }
    } catch(e) {
        try { clearInterval(_progressTimer2); } catch(x) {}
        ctx.sendToPanel('forgeProgress', { taskId: forgeTxtTaskId, progress: 0, done: true });
        g_forgeAbortController = null;
        // 贴回分支已经完成并发出回执时，后续非关键清理异常不能再结算一次。
        if (_forgeTxtCompleteSent) return;
        if (e.name === 'AbortError') {
            ctx.logToPanel("[Forge] 已中断", "warn");
            _sendForgeTxtComplete({ success: false, error: "已中断", error_category: 'forge.user.aborted' });
            _sendForgeTxtTaskComplete({ successCount: 0, failCount: 1, engine: 'forge', error: '已中断', error_category: 'forge.user.aborted' });
        } else {
            ctx.logToPanel("[Forge] txt2img 失败: " + e.message, "error");
            try {
                var _tFailArch = buildForgeArchMeta(forgeTxtTaskId, params, _docInfo2, 'txt2img');
                await ctx.archiveToRecycleBin(_tFailArch, null, 'failed', e.message || String(e));
            } catch(_tArchiveErr) {}
            convEmitForge(ctx, { type: 'response', taskId: forgeTxtTaskId, success: false, error: String(e.message || e), ts: Date.now() });
            var txtErrorCategory = /timeout|timed out|请求超时/i.test(String(e.message || '')) ? 'forge.api.timeout' : 'forge.api.unknown';
            _sendForgeTxtComplete({ success: false, error: e.message, error_category: txtErrorCategory });
            _sendForgeTxtTaskComplete({ successCount: 0, failCount: 1, engine: 'forge', error: e.message, error_category: txtErrorCategory });
        }
    }
}, { tileId: 'forge' });

// ============================================================
//  中断
// ============================================================

HostAPI.registerAction('forgeInterrupt', async function(params, ctx) {
    // 1. 中断本地 fetch 请求
    if (g_forgeAbortController) {
        g_forgeAbortController.abort();
        g_forgeAbortController = null;
    }
    // 2. 发送中断请求到 SD WebUI
    try {
        // bug: 原来只从 hostStorage['forge_url'] 取(该键不存在, 永远拿不到)。
        //   现在优先用前端传来的算力源参数(resolveForgeUrl 解析 {url} 或 {encrypted}),
        //   兜底再读 hostStorage, 保证服务器端也能收到 /interrupt。
        var url = normalizeUrl(resolveForgeUrl(params));
        if (!url) {
            var hs = (ctx.hostStorageRef && ctx.hostStorageRef.value) || {};
            url = normalizeUrl(hs['forge_url'] || '');
        }
        if (url) {
            var interruptResp = await serverConfig.fetchWithTimeout(url + '/sdapi/v1/interrupt', { method: 'POST' }, FORGE_PROGRESS_TIMEOUT_MS);
            try { await interruptResp.text(); } catch (_) {}
            ctx.logToPanel("[Forge] 已发送中断请求", "warn");
        }
    } catch(e) {
        ctx.logToPanel("[Forge] 中断请求失败: " + e.message, "warn");
    }
    // 这里只通知面板立即复位；真正的 forgeComplete/taskComplete 由被 abort 的任务 catch
    // 统一发送，避免一次中断被结算两遍。
    ctx.sendToPanel('forgeInterrupted', { taskId: params && params.taskId ? params.taskId : null });
}, { tileId: 'forge' });

// ============================================================
//  预设文件操作
// ============================================================

HostAPI.registerAction('loadForgePresetsFile', async function(data, ctx) {
    var dataFolder = await fs.getDataFolder();
    var pluginFolder = await fs.getPluginFolder();
    var presetsFolder;
    var isNewFolder = false;

    // 1. 获取或创建 dataFolder/forge_presets/
    try {
        presetsFolder = await dataFolder.getEntry(FORGE_PRESETS_SUBFOLDER);
    } catch(e) {
        try {
            presetsFolder = await dataFolder.createFolder(FORGE_PRESETS_SUBFOLDER);
        } catch(e2) {
            ctx.logToPanel("[Forge预设] 创建预设文件夹失败: " + e2.message, "error");
            ctx.sendToPanel('forgePresetsFileLoaded', { presets: [], factoryCount: 0, userCount: 0 });
            return;
        }
        isNewFolder = true;
    }

    // 2. 首次运行：从 pluginFolder/factory_forge_presets/ 复制所有预设
    if (isNewFolder) {
        try {
            var factoryFolder = await pluginFolder.getEntry(FACTORY_FORGE_PRESETS_SUBFOLDER);
            var factoryEntries = await factoryFolder.getEntries();
            var copyCount = 0;
            for (var fi = 0; fi < factoryEntries.length; fi++) {
                var fe = factoryEntries[fi];
                if (fe.isFile && fe.name.endsWith('.json')) {
                    try {
                        var content = await fe.read();
                        var newFile = await presetsFolder.createFile(fe.name, { overwrite: true });
                        await newFile.write(content);
                        copyCount++;
                    } catch(ce) { console.warn("[Forge预设] 复制失败: " + fe.name, ce); }
                }
            }
            ctx.logToPanel("[Forge预设] 首次运行，已复制 " + copyCount + " 个工厂预设", "info");
        } catch(e) {
            ctx.logToPanel("[Forge预设] 工厂预设目录不存在: " + e.message, "warn");
        }
    }

    // 3. 扫描 dataFolder/forge_presets/ 中所有 .json 文件
    var allPresets = [];
    try {
        var allEntries = await presetsFolder.getEntries();
        for (var ai = 0; ai < allEntries.length; ai++) {
            var ae = allEntries[ai];
            if (!ae.isFile || !ae.name.endsWith('.json')) continue;
            try {
                var presetText = await ae.read();
                var preset = JSON.parse(presetText);
                preset._fileName = ae.name;
                if (!preset.id) preset.id = 'fp_' + ae.name.replace(/\.json$/, '');
                if (!preset.name) preset.name = preset.displayName || ae.name.replace(/\.json$/, '');
                if (!preset.displayName) preset.displayName = (preset.name || '').replace(/^[0-9]+/, '');
                if (!preset.category) preset.category = 'fullbody';
                allPresets.push(preset);
            } catch(pe) {
                console.warn("[Forge预设] 解析失败，跳过: " + ae.name, pe.message);
            }
        }
    } catch(e) {
        ctx.logToPanel("[Forge预设] 扫描预设文件夹失败: " + e.message, "error");
    }

    // 4. 排序
    allPresets.sort(function(a, b) {
        var aFactory = !!a._isFactory;
        var bFactory = !!b._isFactory;
        if (!aFactory && bFactory) return -1;
        if (aFactory && !bFactory) return 1;
        return (a._fileName || '').localeCompare(b._fileName || '');
    });

    var factoryCount = allPresets.filter(function(p) { return p._isFactory; }).length;
    var userCount = allPresets.length - factoryCount;

    // 5. 发送给面板
    ctx.sendToPanel('forgePresetsFileLoaded', { presets: allPresets, factoryCount: factoryCount, userCount: userCount });
    ctx.logToPanel("[Forge预设] 已加载 " + allPresets.length + " 个预设 (工厂:" + factoryCount + " 用户:" + userCount + ")", "info");
}, { tileId: 'forge' });

HostAPI.registerAction('saveForgePresetsFile', async function(data, ctx) {
    try {
        var dataFolder = await fs.getDataFolder();
        var presetsFolder = await ctx.getOrCreateForgePresetsFolder(dataFolder);

        if (data.action === 'save') {
            var preset = data.preset;
            if (!preset) return;

            var fileName;
            if (preset._fileName) {
                fileName = preset._fileName;
            } else {
                fileName = ctx.sanitizeFileName(preset.name || preset.displayName || 'forge_preset') + '.json';
                fileName = await ctx.getUniqueFileName(presetsFolder, fileName);
            }

            var clone = JSON.parse(JSON.stringify(preset));
            delete clone._fileName;

            var file = await presetsFolder.createFile(fileName, { overwrite: true });
            await file.write(JSON.stringify(clone, null, 2));
            ctx.logToPanel("[Forge预设] 已保存: " + (preset.displayName || preset.name || fileName), "success");
            // 刷新预设列表
            await HostAPI.dispatchAction('loadForgePresetsFile', {}, ctx);

        } else if (data.action === 'delete') {
            var delPreset = data.preset;
            if (delPreset && delPreset._fileName) {
                try {
                    var delFile = await presetsFolder.getEntry(delPreset._fileName);
                    await delFile.delete();
                    ctx.logToPanel("[Forge预设] 已删除: " + (delPreset.displayName || delPreset.name || delPreset._fileName), "success");
                } catch(de) {
                    ctx.logToPanel("[Forge预设] 删除失败: " + de.message, "error");
                }
            }
            await HostAPI.dispatchAction('loadForgePresetsFile', {}, ctx);

        } else if (data.action === 'import') {
            var importPresets = data.presets;
            if (!Array.isArray(importPresets)) return;
            var importCount = 0;
            for (var ii = 0; ii < importPresets.length; ii++) {
                var ip = importPresets[ii];
                if (!ip.name && !ip.displayName) continue;
                var ipClone = JSON.parse(JSON.stringify(ip));
                delete ipClone._fileName;
                if (!ipClone._isFactory) ipClone._isFactory = false;
                if (!ipClone.id) ipClone.id = 'uf_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);

                var ipFileName = ctx.sanitizeFileName(ip.name || ip.displayName || 'forge_preset') + '.json';
                ipFileName = await ctx.getUniqueFileName(presetsFolder, ipFileName);
                var ipFile = await presetsFolder.createFile(ipFileName, { overwrite: true });
                await ipFile.write(JSON.stringify(ipClone, null, 2));
                importCount++;
            }
            ctx.logToPanel("[Forge预设] 已导入 " + importCount + " 个预设", "success");
            await HostAPI.dispatchAction('loadForgePresetsFile', {}, ctx);
        }
    } catch(e) {
        ctx.logToPanel("[Forge预设] 保存操作失败: " + e.message, "error");
        console.error("[Forge预设] 保存操作失败:", e);
    }
}, { tileId: 'forge' });

HostAPI.registerAction('openForgePresetFolder', async function(data, ctx) {
    try {
        var dataFolder = await fs.getDataFolder();
        var presetsFolder = await ctx.getOrCreateForgePresetsFolder(dataFolder);
        var folderPath = presetsFolder.nativePath;
        ctx.sendToPanel('forgePresetFolderPath', { path: folderPath });
        await ctx.openFolderWithMultipleMethods(folderPath, '[Forge预设]');
    } catch(e) {
        ctx.logToPanel("[Forge预设] 打开文件夹失败: " + e.message, "error");
    }
}, { tileId: 'forge' });

HostAPI.registerAction('refreshForgePresets', async function(data, ctx) {
    ctx.logToPanel("[Forge预设] 正在刷新...", "info");
    await HostAPI.dispatchAction('loadForgePresetsFile', {}, ctx);
}, { tileId: 'forge' });

module.exports = {};
