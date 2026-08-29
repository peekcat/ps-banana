// ============================================================
//  tile-comfyui.host.js
//  ComfyUI 工作流后端处理器
//  通过 HostAPI.registerAction 注册到路由表
// ============================================================

var HostAPI = require('../host/host-api.js');
var evidenceLog = require('../host/evidence-log.js');   // 证据日志: 指纹+签章链
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;
var uxpModule = require('uxp');
var storage = uxpModule.storage;
var fs = storage.localFileSystem;

// workflow-engine 在 index.js 同目录下
var comfyEngine = require('../workflow-engine.js');

// === 模块内私有状态 ===
var g_comfyCachedObjectInfo = null;
var g_comfyRun = null; // { taskId, interrupted, controllers, settled }

var COMFY_REQUEST_TIMEOUT_MS = 30000;
var COMFY_POLL_TIMEOUT_MS = 10000;
var COMFY_DOWNLOAD_TIMEOUT_MS = 60000;
var COMFY_INTERRUPT_TIMEOUT_MS = 8000;

// === 辅助函数 ===
function normalizeUrl(url) {
    return (url || 'http://127.0.0.1:8188').replace(/\/$/, '');
}

function base64ToArrayBuffer(base64) {
    var binaryStr = atob(base64);
    var len = binaryStr.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);
    return bytes.buffer;
}

function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function _abortError() {
    var e = new Error('已中断');
    e.name = 'AbortError';
    return e;
}

function _throwIfInterrupted(run) {
    if (run && run.interrupted) throw _abortError();
}

function _removeController(run, controller) {
    if (!run || !run.controllers) return;
    var idx = run.controllers.indexOf(controller);
    if (idx !== -1) run.controllers.splice(idx, 1);
}

// bodyMode: json / jsonOrText / arrayBuffer / null。计时覆盖读取响应体，避免 fetch
// 已返回响应头但 json()/arrayBuffer() 永久不结束。
async function _fetchWithTimeout(url, options, timeoutMs, run, label, bodyMode) {
    _throwIfInterrupted(run);
    var controller = new AbortController();
    var timedOut = false;
    var timer = setTimeout(function() {
        timedOut = true;
        try { controller.abort(); } catch (_) {}
    }, Math.max(1000, Number(timeoutMs) || COMFY_REQUEST_TIMEOUT_MS));
    if (run) run.controllers.push(controller);
    var requestOptions = {};
    var srcOptions = options || {};
    for (var key in srcOptions) requestOptions[key] = srcOptions[key];
    requestOptions.signal = controller.signal;
    try {
        var response = await fetch(url, requestOptions);
        var body = null;
        if (bodyMode === 'json' && response.ok) {
            body = await response.json();
        } else if (bodyMode === 'jsonOrText') {
            body = response.ok
                ? { json: await response.json(), text: '' }
                : { json: null, text: await response.text() };
        } else if (bodyMode === 'arrayBuffer' && response.ok) {
            body = await response.arrayBuffer();
        }
        _throwIfInterrupted(run);
        return { response: response, body: body };
    } catch (e) {
        if (run && run.interrupted) throw _abortError();
        if (timedOut) throw new Error((label || 'ComfyUI 请求') + '超时');
        throw e;
    } finally {
        clearTimeout(timer);
        _removeController(run, controller);
    }
}

function _sendTaskComplete(ctx, taskId, data) {
    data = data || {};
    data.taskId = taskId;
    if (ctx && typeof ctx.sendTaskCompleteOnce === 'function') {
        try {
            ctx.sendTaskCompleteOnce(taskId, data);
        } catch (e) {
            // 极端环境下 helper 不可用时仍要让任务卡收口。
            ctx.sendToPanel('taskComplete', data);
        }
    } else {
        ctx.sendToPanel('taskComplete', data);
    }
}

async function _withPSLock(ctx, taskId, fn) {
    if (!ctx || typeof ctx.acquirePSLock !== 'function') {
        throw new Error('Photoshop 全局操作锁不可用');
    }
    return await ctx.acquirePSLock(fn, taskId);
}

// ============================================================
//  1. comfyConnect - 连接测试
// ============================================================

HostAPI.registerAction('comfyConnect', async function(data, ctx) {
    var url = normalizeUrl(data.url);
    var silent = !!data.silent;
    // 连接新服务器前清除旧的节点信息缓存
    g_comfyCachedObjectInfo = null;
    comfyEngine.clearObjectInfoCache();
    if (!silent) ctx.logToPanel("[ComfyUI] 正在连接 " + url + "...", "info");
    try {
        var req = await _fetchWithTimeout(url + '/system_stats', { method: 'GET' }, COMFY_REQUEST_TIMEOUT_MS, null, '连接 ComfyUI', 'json');
        var resp = req.response;
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var stats = req.body;
        if (!silent) ctx.logToPanel("[ComfyUI] 连接成功!", "success");
        ctx.sendToPanel('comfyConnectResult', { success: true, stats: stats });
    } catch(e) {
        if (!silent) ctx.logToPanel("[ComfyUI] 连接失败: " + e.message, "error");
        ctx.sendToPanel('comfyConnectResult', { success: false, error: e.message });
    }
}, { tileId: 'comfyui' });

// ============================================================
//  2. comfyFetchWorkflows - 拉取工作流列表
// ============================================================

HostAPI.registerAction('comfyFetchWorkflows', async function(data, ctx) {
    var url = normalizeUrl(data.url);
    try {
        // 1. 获取并缓存 objectInfo（节点类型定义，后续解析工作流需要）
        ctx.logToPanel("[ComfyUI] 正在获取节点信息...", "info");
        var objectReq = await _fetchWithTimeout(url + '/object_info', { method: 'GET' }, COMFY_REQUEST_TIMEOUT_MS, null, '获取节点信息', 'json');
        var resp = objectReq.response;
        if (!resp.ok) throw new Error('获取节点信息失败 HTTP ' + resp.status);
        g_comfyCachedObjectInfo = objectReq.body;
        ctx.logToPanel("[ComfyUI] 节点信息已缓存 (" + Object.keys(g_comfyCachedObjectInfo).length + " 种节点)", "success");

        // 2. 尝试从 ComfyUI 用户数据目录列出已保存的工作流
        var workflows = [];
        try {
            var wfReq = await _fetchWithTimeout(url + '/userdata?dir=workflows', { method: 'GET' }, COMFY_REQUEST_TIMEOUT_MS, null, '获取工作流列表', 'json');
            var wfResp = wfReq.response;
            if (wfResp.ok) {
                var wfList = wfReq.body;
                if (Array.isArray(wfList)) {
                    workflows = wfList.map(function(f) {
                        var name = typeof f === 'string' ? f : (f.path || f.name || String(f));
                        return { name: name.replace(/\.json$/i, ''), path: name };
                    });
                }
            }
        } catch(wfErr) {
            ctx.logToPanel("[ComfyUI] 未能列出已保存工作流（可通过导入JSON加载）", "warn");
        }

        ctx.sendToPanel('comfyWorkflowsResult', { success: true, workflows: workflows });
    } catch(e) {
        ctx.sendToPanel('comfyWorkflowsResult', { success: false, error: e.message });
    }
}, { tileId: 'comfyui' });

// ============================================================
//  3. comfyLoadWorkflow - 加载工作流并解析参数
// ============================================================

HostAPI.registerAction('comfyLoadWorkflow', async function(params, ctx) {
    try {
        var url = normalizeUrl(params.url);
        var wfName = params.name;
        var workflow = params.workflow; // 可能直接传入工作流JSON

        // 如果没有直接传工作流JSON，从ComfyUI的userdata获取
        if (!workflow && wfName) {
            ctx.logToPanel("[ComfyUI] 正在加载工作流: " + wfName, "info");
            var wfPath = wfName;
            if (!wfPath.endsWith('.json')) wfPath = wfPath + '.json';
            var wfReq = await _fetchWithTimeout(url + '/userdata/' + encodeURIComponent('workflows/' + wfPath), { method: 'GET' }, COMFY_REQUEST_TIMEOUT_MS, null, '加载工作流', 'json');
            var wfResp = wfReq.response;
            if (!wfResp.ok) throw new Error('获取工作流失败 HTTP ' + wfResp.status);
            workflow = wfReq.body;
        }
        if (!workflow) throw new Error("未提供工作流数据");

        // 确保有 objectInfo 缓存
        if (!g_comfyCachedObjectInfo) {
            ctx.logToPanel("[ComfyUI] objectInfo未缓存，正在获取...", "info");
            var oiReq = await _fetchWithTimeout(url + '/object_info', { method: 'GET' }, COMFY_REQUEST_TIMEOUT_MS, null, '获取节点信息', 'json');
            var oiResp = oiReq.response;
            if (oiResp.ok) g_comfyCachedObjectInfo = oiReq.body;
        }

        // 使用 workflow-engine 解析工作流并提取可调参数
        var parsed = comfyEngine.parseWorkflowWidgets(workflow, g_comfyCachedObjectInfo);

        // === @37 过滤机制 ===
        var AT37_PREFIX = /^@37\s*/;
        var LEADING_NUM = /^(\d+)/;

        var paramsList = [];
        if (Array.isArray(parsed)) {
            var showAll = !!params.showAll;
            var at37Nodes = [];
            for (var ni = 0; ni < parsed.length; ni++) {
                var node = parsed[ni];
                var title = node.title || '';
                if (showAll || AT37_PREFIX.test(title)) {
                    var displayTitle = AT37_PREFIX.test(title) ? title.replace(AT37_PREFIX, '') : (title || node.type || ('Node ' + node.nodeId));
                    var numMatch = displayTitle.match(LEADING_NUM);
                    var sortOrder = numMatch ? parseInt(numMatch[1]) : 9999;
                    at37Nodes.push({ node: node, displayTitle: displayTitle, sortOrder: sortOrder });
                }
            }

            at37Nodes.sort(function(a, b) { return a.sortOrder - b.sortOrder; });

            for (var ai = 0; ai < at37Nodes.length; ai++) {
                var entry = at37Nodes[ai];
                var nd = entry.node;
                var widgets = nd.widgets || [];
                for (var wi = 0; wi < widgets.length; wi++) {
                    var w = widgets[wi];
                    var cfg = w.config || {};
                    var flatParam = {
                        name: nd.nodeId + '.' + w.name,
                        label: entry.displayTitle + ' / ' + w.name,
                        default: w.value !== undefined ? w.value : cfg.default,
                        disabled: !!w.isConnected
                    };
                    if (w.isConnected) {
                        flatParam.label += ' \uD83D\uDD17';
                    }
                    if (w.widgetType === 'COMBO') {
                        flatParam.type = 'select';
                        flatParam.options = cfg.options || [];
                    } else if (w.widgetType === 'STRING') {
                        flatParam.type = (cfg.multiline) ? 'textarea' : 'text';
                    } else if (w.widgetType === 'INT') {
                        flatParam.type = 'number';
                        flatParam.min = cfg.min;
                        flatParam.max = cfg.max;
                        flatParam.step = cfg.step || 1;
                    } else if (w.widgetType === 'FLOAT') {
                        flatParam.type = 'number';
                        flatParam.min = cfg.min;
                        flatParam.max = cfg.max;
                        flatParam.step = cfg.step || 0.01;
                    } else if (w.widgetType === 'BOOL') {
                        flatParam.type = 'select';
                        flatParam.options = ['true', 'false'];
                        flatParam.default = w.value !== undefined ? String(w.value) : String(cfg.default || false);
                    } else {
                        flatParam.type = 'text';
                    }
                    paramsList.push(flatParam);
                }
            }

            if (at37Nodes.length === 0 && parsed.length > 0) {
                ctx.logToPanel("[ComfyUI] 工作流中未找到 @37 标记的节点，请在ComfyUI中为需要调参的节点标题添加 @37 前缀", "warn");
            }
        }

        ctx.sendToPanel('comfyWorkflowLoaded', {
            success: true,
            workflow: workflow,
            params: paramsList,
            name: wfName || '导入的工作流',
            source: params.source || ''
        });
        var at37Msg = at37Nodes ? (' (@37节点: ' + at37Nodes.length + ')') : '';
        ctx.logToPanel("[ComfyUI] 工作流已加载, " + paramsList.length + " 个可调参数" + at37Msg, "success");
    } catch(e) {
        ctx.sendToPanel('comfyWorkflowLoaded', { success: false, error: e.message });
    }
}, { tileId: 'comfyui' });

// ============================================================
//  4. comfyGenerate - 生成
// ============================================================

HostAPI.registerAction('comfyGenerate', async function(params, ctx) {
    params = params || {};
    var _evStartTs = Date.now();
    var comfyTaskId = params.taskId || ('comfy_' + Date.now());
    var autoReturn = params.autoReturn !== false;
    if (ctx.g_taskCompleteSentRef && ctx.g_taskCompleteSentRef.value) {
        ctx.g_taskCompleteSentRef.value[comfyTaskId] = false;
    }

    // 在第一次 await 之前登记本次任务。这样用户刚点开始就点停止时，停止消息
    // 也能准确命中这次任务，而不会被建缓存目录等前置异步步骤吞掉。
    if (g_comfyRun) {
        var busyMsg = '已有 ComfyUI 任务正在运行，请先停止或等待完成';
        ctx.sendToPanel('comfyGenerateResult', { success: false, error: busyMsg, taskId: comfyTaskId });
        _sendTaskComplete(ctx, comfyTaskId, {
            successCount: 0, failCount: 1, provider: 'comfyui', engine: 'comfyui',
            model: params.workflowName || '', error_category: 'comfyui.busy'
        });
        return true;
    }
    var runState = { taskId: comfyTaskId, interrupted: false, controllers: [], settled: false, interruptPromise: null };
    g_comfyRun = runState;
    ctx.g_taskAutoReturn[comfyTaskId] = autoReturn;
    // 当前文档信息(建两级缓存文件夹用); 无文档 → fs-utils 自动退回老平铺
    var _docName = '', _docPath = '', _docIdForCache = null;
    try {
        var _adoc = app.activeDocument;
        if (_adoc) {
            _docIdForCache = _adoc.id;
            _docName = _adoc.name || '';
            try { _docPath = _adoc.path ? String(_adoc.path) : ''; } catch(_p) {}
        }
    } catch(_e) {}
    var runFolder = null;
    var runPath = '';
    var url = normalizeUrl(params.url);
    // 生成中心气泡: request (v6.5.0)
    try {
        ctx.sendToPanel('conversationEvent', {
            type: 'request', taskId: comfyTaskId,
            provider: 'comfyui', model: params.workflowName || 'ComfyUI',
            size: '', aspectRatio: '',
            prompt: '(ComfyUI 工作流: ' + (params.workflowName || '未命名') + ')',
            mainBase64: '', refBase64s: [], ts: Date.now()
        });
    } catch(_ce0) {}
    try {
        runFolder = await ctx.createImageCacheRunFolder({
            engine: 'comfyui', taskId: comfyTaskId,
            label: params.workflowName || 'ComfyUI',
            docName: _docName, docPath: _docPath, docId: _docIdForCache
        });
        runPath = (runFolder && (runFolder.wcRunPath || runFolder.name)) || '';
        _throwIfInterrupted(runState);

        // 1. 检测工作流中是否有 LoadImage 节点，自动抓取PS选区
        var captureBase64 = null;
        var originDocId = _docIdForCache;
        var savedSelection = null;

        var hasLoadImageNode = false;
        var workflow = params.workflow;
        if (workflow && workflow.nodes) {
            for (var ni = 0; ni < workflow.nodes.length; ni++) {
                var nt = workflow.nodes[ni].type;
                if (nt === 'LoadImage' || nt === 'PS Bridge Load Image') {
                    hasLoadImageNode = true;
                    break;
                }
            }
        }
        var shouldCapture = params.needCapture || hasLoadImageNode;
        if (shouldCapture) {
            ctx.logToPanel("[ComfyUI] 检测到LoadImage节点，正在抓取PS选区...", "info");
            var savedAntiMode = ctx.g_antiTruncationModeRef.value;
            var captureBundle = await _withPSLock(ctx, comfyTaskId, async function() {
                var capture = null;
                var capturedDocId = null;
                try {
                    _throwIfInterrupted(runState);
                    ctx.g_antiTruncationModeRef.value = 0;
                    capture = await ctx.getSelectionAndImage();
                    try { capturedDocId = app.activeDocument.id; } catch (_) {}
                    if (capture) await ctx.deselectAll();
                    return { capture: capture, docId: capturedDocId };
                } finally {
                    ctx.g_antiTruncationModeRef.value = savedAntiMode;
                }
            });
            _throwIfInterrupted(runState);
            var capture = captureBundle && captureBundle.capture;
            if (!capture) {
                ctx.logToPanel("[ComfyUI] 未检测到选区，将使用工作流默认图像", "warn");
            } else {
                captureBase64 = capture.base64;
                await ctx.saveImageToRunFolder(runFolder, 'input', captureBase64, 1);
                originDocId = captureBundle.docId;
                savedSelection = capture.selection;
            }
        }

        // 2. 使用 workflow-engine 构建最终 prompt
        var inputValues = params.params || {};
        // 确保有objectInfo缓存
        if (!g_comfyCachedObjectInfo) {
            var oiRunReq = await _fetchWithTimeout(url + '/object_info', { method: 'GET' }, COMFY_REQUEST_TIMEOUT_MS, runState, '获取节点信息', 'json');
            if (!oiRunReq.response.ok) throw new Error('获取节点信息失败 HTTP ' + oiRunReq.response.status);
            g_comfyCachedObjectInfo = oiRunReq.body;
        }
        _throwIfInterrupted(runState);
        var prompt = comfyEngine.convertToAPIPrompt(workflow, g_comfyCachedObjectInfo, inputValues);

        // 3. 如果有图片需要上传到 ComfyUI
        if (captureBase64) {
            ctx.logToPanel("[ComfyUI] 正在上传图片到ComfyUI...", "info");
            var imgBuf = base64ToArrayBuffer(captureBase64);
            var boundary = '----FormBoundary' + Date.now();
            var bodyParts = [];
            bodyParts.push('--' + boundary + '\r\n');
            bodyParts.push('Content-Disposition: form-data; name="image"; filename="ps_capture.png"\r\n');
            bodyParts.push('Content-Type: image/png\r\n\r\n');
            var headerStr = bodyParts.join('');
            var footerStr = '\r\n--' + boundary + '--\r\n';
            var headerBytes = new Uint8Array(headerStr.length);
            for (var hi = 0; hi < headerStr.length; hi++) headerBytes[hi] = headerStr.charCodeAt(hi);
            var footerBytes = new Uint8Array(footerStr.length);
            for (var fi = 0; fi < footerStr.length; fi++) footerBytes[fi] = footerStr.charCodeAt(fi);
            var imgBytes = new Uint8Array(imgBuf);
            var fullBody = new Uint8Array(headerBytes.length + imgBytes.length + footerBytes.length);
            fullBody.set(headerBytes, 0);
            fullBody.set(imgBytes, headerBytes.length);
            fullBody.set(footerBytes, headerBytes.length + imgBytes.length);
            var uploadReq = await _fetchWithTimeout(url + '/upload/image', {
                method: 'POST',
                headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
                body: fullBody.buffer
            }, COMFY_REQUEST_TIMEOUT_MS, runState, '上传输入图片', 'json');
            var uploadResp = uploadReq.response;
            if (uploadResp.ok) {
                var uploadData = uploadReq.body;
                var uploadedName = uploadData.name || 'ps_capture.png';
                ctx.logToPanel("[ComfyUI] 图片已上传: " + uploadedName, "success");
                for (var nk in prompt) {
                    if (prompt[nk] && prompt[nk].inputs) {
                        if (prompt[nk].class_type === 'LoadImage') {
                            prompt[nk].inputs.image = uploadedName;
                            ctx.logToPanel("[ComfyUI] 已注入图像到节点 [" + nk + "] LoadImage", "info");
                        } else if (prompt[nk].class_type === 'PS Bridge Load Image') {
                            prompt[nk].class_type = 'LoadImage';
                            prompt[nk].inputs = { image: uploadedName };
                            ctx.logToPanel("[ComfyUI] 已将 PS Bridge Load Image [" + nk + "] 替换为 LoadImage", "info");
                        }
                    }
                }
            } else {
                ctx.logToPanel("[ComfyUI] 图片上传失败: HTTP " + uploadResp.status, "warn");
            }
        }

        // 4. 提交工作流到 ComfyUI
        ctx.logToPanel("[ComfyUI] 提交工作流...", "info");
        var queueReq = await _fetchWithTimeout(url + '/prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: prompt })
        }, COMFY_REQUEST_TIMEOUT_MS, runState, '提交工作流', 'jsonOrText');
        var queueResp = queueReq.response;
        if (!queueResp.ok) {
            var errBody = (queueReq.body && queueReq.body.text) || '';
            ctx.logToPanel("[ComfyUI] 提交错误详情: " + errBody.substring(0, 500), "error");
            throw new Error('提交失败 HTTP ' + queueResp.status);
        }
        var queueData = queueReq.body && queueReq.body.json;
        if (!queueData || !queueData.prompt_id) throw new Error('提交成功但未返回 prompt_id');
        var promptId = queueData.prompt_id;
        ctx.logToPanel("[ComfyUI] 已加入队列, prompt_id=" + promptId, "info");

        // 5. 轮询进度
        var maxWait = Math.max(1, Number(params.timeout) || 3600) * 1000;
        var startTime = Date.now();
        var resultImages = null;
        while (Date.now() - startTime < maxWait) {
            _throwIfInterrupted(runState);
            await sleep(1000);
            _throwIfInterrupted(runState);
            try {
                var remainingMs = Math.max(1000, maxWait - (Date.now() - startTime));
                var histReq = await _fetchWithTimeout(url + '/history/' + promptId, { method: 'GET' }, Math.min(COMFY_POLL_TIMEOUT_MS, remainingMs), runState, '查询生成进度', 'json');
                var histResp = histReq.response;
                if (histResp.ok) {
                    var histData = histReq.body;
                    if (histData[promptId] && histData[promptId].outputs) {
                        var outputs = histData[promptId].outputs;
                        resultImages = [];
                        for (var nodeId in outputs) {
                            var nodeOut = outputs[nodeId];
                            if (nodeOut.images) {
                                for (var ii = 0; ii < nodeOut.images.length; ii++) {
                                    resultImages.push(nodeOut.images[ii]);
                                }
                            }
                        }
                        break;
                    }
                }
                var elapsed = Math.round((Date.now() - startTime) / 1000);
                ctx.sendToPanel('comfyProgress', { elapsed: elapsed, maxWait: Math.round(maxWait/1000), taskId: comfyTaskId });
            } catch(pe) {
                if (runState.interrupted || (pe && pe.name === 'AbortError')) throw pe;
                ctx.logToPanel('[ComfyUI] 本次进度查询失败，将继续重试: ' + ((pe && pe.message) || pe), 'warn');
            }
        }

        _throwIfInterrupted(runState);
        if (!resultImages || resultImages.length === 0) {
            throw new Error("未获取到生成结果(超时或无输出)");
        }

        // 6. 下载结果图片并贴回 PS
        ctx.logToPanel("[ComfyUI] 正在下载 " + resultImages.length + " 张结果...", "info");
        var createdIds = [];
        var _outB64s = [];   // 证据日志用: 本次全部回图
        var pendingB64s = [];
        var archiveIds = [];  // v6.5.9: 收集归档号供后台完成图传回用
        for (var ri = 0; ri < resultImages.length; ri++) {
            _throwIfInterrupted(runState);
            var imgInfo = resultImages[ri];
            var imgUrl = url + '/view?filename=' + encodeURIComponent(imgInfo.filename) + '&subfolder=' + encodeURIComponent(imgInfo.subfolder || '') + '&type=' + encodeURIComponent(imgInfo.type || 'output');
            var imgReq;
            try {
                imgReq = await _fetchWithTimeout(imgUrl, { method: 'GET' }, COMFY_DOWNLOAD_TIMEOUT_MS, runState, '下载第' + (ri + 1) + '张结果', 'arrayBuffer');
            } catch (downloadErr) {
                if (runState.interrupted || (downloadErr && downloadErr.name === 'AbortError')) throw downloadErr;
                ctx.logToPanel('[ComfyUI] 第' + (ri + 1) + '张下载失败: ' + ((downloadErr && downloadErr.message) || downloadErr), 'warn');
                continue;
            }
            var imgResp = imgReq.response;
            if (!imgResp.ok) { ctx.logToPanel("[ComfyUI] 下载图片失败: HTTP " + imgResp.status, "warn"); continue; }
            var imgArrayBuf = imgReq.body;
            var imgBase64 = ctx.arrayBufferToBase64(imgArrayBuf);
            await ctx.saveImageToRunFolder(runFolder, 'output', imgBase64, ri + 1);
            _outB64s.push(imgBase64);
            // 回收站归档(统一时间线 v6.4.8): ComfyUI 结果也进生成记录
            var archiveId = comfyTaskId + '_' + ri + '_' + Date.now();
            try {
                await ctx.archiveToRecycleBin({
                    id: archiveId,
                    batchId: comfyTaskId,
                    workflow: 'comfyui',
                    prompt: '(ComfyUI 工作流: ' + (params.workflowName || '未命名') + ')',
                    model: params.workflowName || '',
                    provider: 'comfyui',
                    size: '', aspectRatio: '',
                    presetTitle: params.workflowName || 'ComfyUI',
                    context: {
                        docId: originDocId, docName: _docName, docPath: _docPath,
                        selection: savedSelection, antiMode: 0,
                        layerType: 'smartObject', groupName: 'ComfyUI'
                    },
                    extras: null
                }, imgBase64, 'success');
                archiveIds.push(archiveId);  // 收集归档号
            } catch(_ae) {}
            if (autoReturn) {
                var lid = null;
                try {
                    lid = await _withPSLock(ctx, comfyTaskId, async function() {
                        _throwIfInterrupted(runState);
                        var placedId = await ctx.placeImageToSpecificDoc(imgBase64, originDocId, savedSelection, 0, ctx.g_layerTypeRef.value);
                        if (placedId) {
                            try {
                                await ctx.applyReturnFeatherMaskToLayer(originDocId, placedId, savedSelection, 'comfyui');
                            } catch (featherErr) {
                                ctx.logToPanel('[ComfyUI] 图已贴回，但羽化蒙版失败: ' + ((featherErr && featherErr.message) || featherErr), 'warn');
                            }
                        }
                        return placedId;
                    });
                } catch (placeOneErr) {
                    if (runState.interrupted) throw _abortError();
                    ctx.logToPanel('[ComfyUI] 第' + (ri + 1) + '张贴回失败: ' + ((placeOneErr && placeOneErr.message) || placeOneErr), 'warn');
                }
                if (lid) {
                    createdIds.push(lid);
                } else pendingB64s.push(imgBase64);
            } else {
                pendingB64s.push(imgBase64);
            }
        }
        // 证据日志(指纹+签章链): 异步写, 不挡打组
        try {
            evidenceLog.appendEvidence({
                runFolder: runFolder, runPath: runPath,
                taskId: comfyTaskId, startTs: _evStartTs, endTs: Date.now(),
                engine: 'comfyui', model: params.workflowName || '',
                source: url,
                docName: _docName, prompt: '(ComfyUI 工作流)',
                inputs: captureBase64 ? [captureBase64] : [],
                outputs: _outB64s
            }).then(function(evRes) {
                if (evRes && evRes.ok) ctx.logToPanel('[证据日志] 已记录 链号#' + evRes.seq, 'info');
                else ctx.logToPanel('[证据日志] 写入失败(不影响生成): ' + ((evRes && evRes.error) || '?'), 'warn');
            }).catch(function(evErr) {
                ctx.logToPanel('[证据日志] 写入失败(不影响生成): ' + ((evErr && evErr.message) || evErr), 'warn');
            });
        } catch (evStartErr) {
            ctx.logToPanel('[证据日志] 启动写入失败(不影响生成): ' + ((evStartErr && evStartErr.message) || evStartErr), 'warn');
        }
        if (createdIds.length > 1 && ctx.g_autoGroupRef.value) {
            try {
                await _withPSLock(ctx, comfyTaskId, function() {
                    return core.executeAsModal(async function() {
                        await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: originDocId }] }], {});
                        await ctx.createGroupAndMask(createdIds, "ComfyUI");
                    }, { commandName: "ComfyUI打组" });
                });
            } catch (groupErr) {
                if (runState.interrupted) throw _abortError();
                ctx.logToPanel('[ComfyUI] 图已贴回，但自动分组失败: ' + ((groupErr && groupErr.message) || groupErr), 'warn');
            }
        }
        if (pendingB64s.length > 0) {
            ctx.g_taskResultCache[comfyTaskId] = {
                originDocId: originDocId || null, savedSelection: savedSelection || null,
                antiMode: 0, layerType: ctx.g_layerTypeRef.value || 'smartObject',
                payloads: pendingB64s.slice(), groupName: 'ComfyUI',
                presetName: params.workflowName || 'ComfyUI', returnWorkflowKey: 'comfyui',
                runFolderName: runPath || (runFolder && runFolder.name),
                docName: _docName, engine: 'comfyui'
            };
            if (autoReturn) ctx.sendToPanel('taskAutoReturnFailed', { taskId: comfyTaskId, count: pendingB64s.length, returnedCount: createdIds.length });
        }
        if (_outB64s.length > 0) {
            runState.settled = true;
            ctx.logToPanel("[ComfyUI] 完成! 生成 " + _outB64s.length + " 张，贴回 " + createdIds.length + " 张", pendingB64s.length ? "warn" : "success");
            ctx.sendToPanel('comfyGenerateResult', { success: true, taskId: comfyTaskId, successCount: _outB64s.length, returnedCount: createdIds.length, pendingCount: pendingB64s.length, failCount: Math.max(0, resultImages.length - _outB64s.length) });
            _sendTaskComplete(ctx, comfyTaskId, {
                successCount: _outB64s.length, generatedCount: _outB64s.length,
                returnedCount: createdIds.length, pendingCount: pendingB64s.length,
                failCount: Math.max(0, resultImages.length - _outB64s.length),
                provider: 'comfyui', engine: 'comfyui', model: params.workflowName || '',
                docName: _docName, docPath: _docPath
            });
            // 生成中心气泡: 结果图 + 归档号(供后台完成图传回用)
            try { ctx.sendToPanel('conversationEvent', { type: 'response', taskId: comfyTaskId, success: true, base64s: _outB64s.slice(), archiveIds: archiveIds, text: '', ts: Date.now() }); } catch(_cr) {}
            try {
                if (pendingB64s.length) await ctx.playSingleFailSound(); else await ctx.playSuccessSound();
            } catch (_) {}
        } else {
            throw new Error("未能下载任何生成结果");
        }
    } catch(e) {
        if (runState.settled) {
            ctx.logToPanel('[ComfyUI] 任务已结算，忽略迟到的后处理错误: ' + ((e && e.message) || e), 'warn');
        } else if (runState.interrupted || (e && (e.name === 'AbortError' || e.message === '已中断'))) {
            if (runState.interruptPromise) {
                try { await runState.interruptPromise; } catch (_) {}
            }
            runState.settled = true;
            ctx.logToPanel("[ComfyUI] 已中断", "warn");
            ctx.sendToPanel('comfyGenerateResult', { success: false, error: "已中断", taskId: comfyTaskId });
            _sendTaskComplete(ctx, comfyTaskId, { successCount: 0, failCount: 1, provider: 'comfyui', engine: 'comfyui', model: params.workflowName || '', error_category: 'aborted' });
            try { ctx.sendToPanel('conversationEvent', { type: 'response', taskId: comfyTaskId, success: false, error: '已中断', ts: Date.now() }); } catch(_cr2) {}
        } else {
            runState.settled = true;
            var generateError = (e && e.message) || String(e);
            ctx.logToPanel("[ComfyUI] 生成失败: " + generateError, "error");
            ctx.sendToPanel('comfyGenerateResult', { success: false, error: generateError, taskId: comfyTaskId });
            _sendTaskComplete(ctx, comfyTaskId, { successCount: 0, failCount: 1, provider: 'comfyui', engine: 'comfyui', model: params.workflowName || '', error_category: 'comfyui.generate' });
            try { ctx.sendToPanel('conversationEvent', { type: 'response', taskId: comfyTaskId, success: false, error: generateError, ts: Date.now() }); } catch(_cr3) {}
        }
    } finally {
        for (var ci = 0; ci < runState.controllers.length; ci++) {
            try { runState.controllers[ci].abort(); } catch (_) {}
        }
        runState.controllers = [];
        if (g_comfyRun === runState) g_comfyRun = null;
    }
}, { tileId: 'comfyui' });

// ============================================================
//  5. comfyInterrupt - 中断生成
// ============================================================

HostAPI.registerAction('comfyInterrupt', async function(params, ctx) {
    params = params || {};
    var requestedTaskId = params.taskId != null ? String(params.taskId) : '';
    var activeRun = g_comfyRun;
    var matches = !!activeRun && (!requestedTaskId || String(activeRun.taskId) === requestedTaskId);

    if (matches) {
        activeRun.interrupted = true;
        var controllers = activeRun.controllers.slice();
        for (var i = 0; i < controllers.length; i++) {
            try { controllers[i].abort(); } catch (_) {}
        }
        if (ctx && typeof ctx.clearPSLockQueue === 'function') {
            try { ctx.clearPSLockQueue(activeRun.taskId); } catch (_) {}
        }
    }

    // 远端中断也有独立超时。生成处理器会等它收口后再复位 UI，防止用户
    // 立刻开新任务时被上一单迟到的 /interrupt 误杀。
    if (matches) {
        var url = normalizeUrl(params.url || (ctx.hostStorageRef && ctx.hostStorageRef.value && ctx.hostStorageRef.value['comfy_url']) || '');
        activeRun.interruptPromise = _fetchWithTimeout(url + '/interrupt', { method: 'POST' }, COMFY_INTERRUPT_TIMEOUT_MS, null, '发送中断请求', null).then(function() {
            ctx.logToPanel("[ComfyUI] 已发送中断请求", "warn");
        }).catch(function(e) {
            ctx.logToPanel("[ComfyUI] 中断请求失败: " + e.message, "warn");
        });
        await activeRun.interruptPromise;
    }

    // 有匹配任务时由生成处理器统一发唯一结果。没有匹配任务则按请求编号复位
    // 那张旧卡；前端会忽略不属于当前任务的迟到回执。
    if (!matches && requestedTaskId) {
        ctx.sendToPanel('comfyGenerateResult', { success: false, error: "已中断", taskId: requestedTaskId });
        _sendTaskComplete(ctx, requestedTaskId, {
            successCount: 0, failCount: 1, provider: 'comfyui', engine: 'comfyui',
            error_category: 'aborted'
        });
    }
    return true;
}, { tileId: 'comfyui' });

// ============================================================
//  comfyOpenFolder - 打开工作流文件夹（可选功能）
// ============================================================

HostAPI.registerAction('comfyOpenFolder', async function(data, ctx) {
    try {
        var dataFolder = await fs.getDataFolder();
        var comfyFolder;
        try {
            comfyFolder = await dataFolder.getEntry('comfyui_workflows');
        } catch(e) {
            comfyFolder = await dataFolder.createFolder('comfyui_workflows');
        }
        var folderPath = comfyFolder.nativePath;
        ctx.logToPanel("[ComfyUI] 工作流文件夹: " + folderPath, "info");
        if (ctx.openFolderWithMultipleMethods) {
            await ctx.openFolderWithMultipleMethods(folderPath, '[ComfyUI]');
        }
    } catch(e) {
        ctx.logToPanel("[ComfyUI] 打开文件夹失败: " + e.message, "error");
    }
}, { tileId: 'comfyui' });

module.exports = {};
