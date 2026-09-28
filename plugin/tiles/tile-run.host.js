// ============================================================
//  tile-run.host.js
//  单图生成后端处理器（runSingle / recordableRunSingle）
//  从 index.js 迁移 handleRunSingle
//  通过 HostAPI.registerAction 注册到路由表
// ============================================================

var HostAPI = require('../host/host-api.js');
var serverConfig = require('../core/server-config.js');
var automationSecurity = require('./tile-automation.host.js');
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;
var imaging = photoshop.imaging;
var uxpModule = require('uxp');
var storage = uxpModule.storage;
var fs = storage.localFileSystem;

var cloudService = require('../login-service.js');
var comfyEngine = require('../workflow-engine.js');
var placementLedger = require('../host/placement-ledger.js');   // 校色台账: 记录 图层↔缓存 对应关系
var evidenceLog = require('../host/evidence-log.js');           // 证据日志: 指纹+签章链
var psPixels = require('../host/ps-pixels.js');
var base64ToArrayBuffer = psPixels.base64ToArrayBuffer;
var arrayBufferToBase64 = psPixels.arrayBufferToBase64;

function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

function _sameSelectionBounds(a, b) {
    if (!a || !b) return false;
    var aw = Number(a.width), ah = Number(a.height), bw = Number(b.width), bh = Number(b.height);
    if (!(aw > 0 && ah > 0 && bw > 0 && bh > 0)) return false;
    var tolerance = Math.max(1, Math.round(Math.max(aw, ah, bw, bh) * 0.002));
    var keys = ['left', 'top', 'right', 'bottom', 'width', 'height'];
    for (var i = 0; i < keys.length; i++) {
        var av = Number(a[keys[i]]), bv = Number(b[keys[i]]);
        if (!isFinite(av) || !isFinite(bv) || Math.abs(av - bv) > tolerance) return false;
    }
    return true;
}

// ============================================================
//  GRS 流: 把 base64 参考图上传到临时图床换公网 URL
//  从 tile-poster.host.js 原样复制 (海报那边以后改不影响这里)
//  入参 refs: [{ name?, base64 }, ...]   出参: ['https://...', ...]
// ============================================================
var POSTER_TEMP_UPLOAD_PATH = '/api/poster/upload-temp';
var _WC_SECRET = 'wc-v6-public-default-secret-2026';

function _sha256(str) {
    function utf8Encode(s) {
        var bytes = [];
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            if (c < 0x80) bytes.push(c);
            else if (c < 0x800) bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
            else if (c >= 0xD800 && c <= 0xDBFF) {
                var hi = c, lo = s.charCodeAt(++i);
                var cp = ((hi - 0xD800) << 10) + (lo - 0xDC00) + 0x10000;
                bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
            } else bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
        }
        return bytes;
    }
    var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    function rr(v, n) { return ((v >>> n) | (v << (32 - n))) >>> 0; }
    var msg = utf8Encode(str);
    var bitLen = msg.length * 8;
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    for (var bi = 56; bi >= 0; bi -= 8) msg.push((bitLen / Math.pow(2, bi)) & 0xFF);
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    for (var off = 0; off < msg.length; off += 64) {
        var W = new Array(64);
        for (var t = 0; t < 16; t++) W[t] = (msg[off+t*4]<<24)|(msg[off+t*4+1]<<16)|(msg[off+t*4+2]<<8)|msg[off+t*4+3];
        for (var t2 = 16; t2 < 64; t2++) {
            var s0 = rr(W[t2-15],7) ^ rr(W[t2-15],18) ^ (W[t2-15]>>>3);
            var s1 = rr(W[t2-2],17) ^ rr(W[t2-2],19) ^ (W[t2-2]>>>10);
            W[t2] = (W[t2-16] + s0 + W[t2-7] + s1) >>> 0;
        }
        var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
        for (var j = 0; j < 64; j++) {
            var S1 = rr(e,6) ^ rr(e,11) ^ rr(e,25);
            var ch = (e & f) ^ ((~e) & g);
            var temp1 = (h + S1 + ch + K[j] + W[j]) >>> 0;
            var S0 = rr(a,2) ^ rr(a,13) ^ rr(a,22);
            var maj = (a & b) ^ (a & c) ^ (b & c);
            var temp2 = (S0 + maj) >>> 0;
            h=g; g=f; f=e; e=(d+temp1)>>>0; d=c; c=b; b=a; a=(temp1+temp2)>>>0;
        }
        H[0]=(H[0]+a)>>>0; H[1]=(H[1]+b)>>>0; H[2]=(H[2]+c)>>>0; H[3]=(H[3]+d)>>>0;
        H[4]=(H[4]+e)>>>0; H[5]=(H[5]+f)>>>0; H[6]=(H[6]+g)>>>0; H[7]=(H[7]+h)>>>0;
    }
    var hex = '';
    for (var hi2 = 0; hi2 < 8; hi2++) hex += ('00000000' + H[hi2].toString(16)).slice(-8);
    return hex;
}

function _signBody(bodyStr) {
    var ts = Math.floor(Date.now() / 1000).toString();
    var sig = _sha256(ts + bodyStr + _WC_SECRET);
    return { ts: ts, sig: sig };
}
function _readDeviceId(ctx) {
    try {
        var hs = (ctx.hostStorageRef && ctx.hostStorageRef.value) || {};
        var v = hs['support.deviceId'];
        if (typeof v === 'string') {
            try { v = JSON.parse(v); } catch(_) {}
        }
        if (typeof v === 'string' && /^[a-zA-Z0-9_-]{4,64}$/.test(v)) return v;
    } catch(_) {}
    return '';
}

// 把参考图 base64 上传到 preset-server 临时图床, 换成外网 URL
//   refs: [{ base64 }, ...]
//   onProgress(i, total) 每张上传成功后回调
//   返回 ['https://...']  失败抛错
async function _uploadRefsToTempServer(refs, ctx, onProgress) {
    if (!refs || !refs.length) return [];
    var deviceId = _readDeviceId(ctx);
    if (!deviceId) throw new Error('未找到设备 ID, 请先打开过客服磁贴(用于上传参考图鉴权)');
    var urls = new Array(refs.length);
    for (var i = 0; i < refs.length; i++) {
        var r = refs[i];
        if (!r || !r.base64) {
            throw new Error('第 ' + (i + 1) + ' 张参考图无内容');
        }
        var bodyObj = { deviceId: deviceId, base64: r.base64, mime: 'image/jpeg' };
        var bodyStr = JSON.stringify(bodyObj);
        var sigInfo = _signBody(bodyStr);
        var ctrl = new AbortController();
        var to = setTimeout(function() { try { ctrl.abort(); } catch(_){} }, 60 * 1000);
        var resp;
        try {
            resp = await serverConfig.fetchApi(POSTER_TEMP_UPLOAD_PATH, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-WC-Ts': sigInfo.ts,
                    'X-WC-Sig': sigInfo.sig
                },
                body: bodyStr,
                signal: ctrl.signal
            });
        } catch (e) {
            clearTimeout(to);
            throw new Error('第 ' + (i + 1) + ' 张上传失败(网络): ' + (e.message || e));
        }
        clearTimeout(to);
        var raw = '';
        try { raw = await resp.text(); } catch(_) {}
        var json = null;
        try { json = JSON.parse(raw); } catch(_) {}
        if (!resp.ok || !json || !json.success || !json.url) {
            var errMsg = (json && json.error) || ('HTTP ' + resp.status);
            throw new Error('第 ' + (i + 1) + ' 张上传失败: ' + errMsg);
        }
        urls[i] = json.url;
        try { ctx.logToPanel('[GRS] 上传参考图 ' + (i + 1) + '/' + refs.length, 'info'); } catch(_) {}
        if (typeof onProgress === 'function') {
            try { onProgress(i + 1, refs.length); } catch(_) {}
        }
    }
    return urls;
}

// 算 targetSize: 保持原比例, 长边 = longSide
function _calcTargetSize(origW, origH, longSide) {
    if (origW <= 0 || origH <= 0) return null;
    if (origW >= origH) {
        if (origW <= longSide) return null;
        return { width: longSide, height: Math.round(origH * longSide / origW) };
    } else {
        if (origH <= longSide) return null;
        return { width: Math.round(origW * longSide / origH), height: longSide };
    }
}

function _b64ToArrayBuffer(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var buf = new ArrayBuffer(len);
    var view = new Uint8Array(buf);
    for (var i = 0; i < len; i++) view[i] = bin.charCodeAt(i);
    return buf;
}

// 把 base64 PNG/JPEG 重压到 1024 长边的 JPEG q78
//   做法: 写临时文件 → batchPlay open → imaging.getPixels(targetSize) + encodeImageData(jpg q78) → close
//   原样复制自 tile-poster.host.js (海报场景的本地图压缩)
async function _resizeLocalImageViaPS(arrBuf, origName, longSide, format) {
    longSide = longSide || 1024;
    format = format || 'jpeg';
    var tmp = await fs.getTemporaryFolder();
    var ts = Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    var ext = '.png';
    var lower = (origName || '').toLowerCase();
    if (/\.(jpe?g)$/i.test(lower)) ext = '.jpg';
    else if (/\.webp$/i.test(lower)) ext = '.webp';
    var tmpFile = await tmp.createFile('runresize_' + ts + ext, { overwrite: true });
    await tmpFile.write(arrBuf, { format: storage.formats.binary });

    var resultBase64 = null;
    var openedDocId = null;
    await core.executeAsModal(async function() {
        var token = await fs.createSessionToken(tmpFile);
        await app.batchPlay([{
            _obj: 'open',
            null: { _path: token, _kind: 'local' }
        }], {});
        var doc = app.activeDocument;
        if (!doc) throw new Error('打开临时文件失败');
        openedDocId = doc.id;
        var origW = Math.round(doc.width);
        var origH = Math.round(doc.height);
        var ts2 = _calcTargetSize(origW, origH, longSide);
        var getOpts = {
            documentID: doc.id,
            applyAlpha: true,
            componentSize: 8
        };
        if (ts2) getOpts.targetSize = ts2;
        var imgObj = await imaging.getPixels(getOpts);
        try {
            var enc = await imaging.encodeImageData({
                imageData: imgObj.imageData,
                base64: true,
                format: format === 'jpeg' ? 'jpg' : 'png',
                quality: 78
            });
            resultBase64 = enc;
        } finally {
            try { imgObj.imageData.dispose(); } catch (_) {}
        }
        try {
            await app.batchPlay([{
                _obj: 'close',
                _target: [{ _ref: 'document', _id: openedDocId }],
                saving: { _enum: 'yesNo', _value: 'no' }
            }], {});
        } catch (_) {}
    }, { commandName: 'shotchair·压缩本地图' });

    try { await tmpFile.delete(); } catch (_) {}
    return resultBase64;
}

// 上传前确保 base64 不会太大: 长边 > 1024 或 base64 > 1.2 MB 就重压
async function _ensureSmallEnough(b64, ctx, idx) {
    if (!b64) return b64;
    var sizeBytes = b64.length;
    // 简单粗略判断: base64 长度 > 1.2 MB 就压. 不再用 Image 解码看尺寸 (host 没 Image 对象), 直接看体积
    if (sizeBytes <= 1.2 * 1024 * 1024) return b64;
    try {
        ctx.logToPanel('[GRS] 第 ' + (idx + 1) + ' 张过大 (' + (sizeBytes / 1024).toFixed(0) + ' KB), 重压到 1024 长边 JPEG…', 'info');
        var arrBuf = _b64ToArrayBuffer(b64);
        var compressed = await _resizeLocalImageViaPS(arrBuf, 'tile_run_' + idx + '.png', 1024, 'jpeg');
        if (compressed && compressed.length > 0) {
            ctx.logToPanel('[GRS] 重压完成: ' + (sizeBytes / 1024).toFixed(0) + ' KB → ' + (compressed.length / 1024).toFixed(0) + ' KB', 'success');
            return compressed;
        }
    } catch (e) {
        ctx.logToPanel('[GRS] 第 ' + (idx + 1) + ' 张重压失败, 用原图试试: ' + (e.message || e), 'warn');
    }
    return b64;
}

// 把所有 pending 占位转 failed — 用在 jobPromises 启动前的前置步骤失败时
// (比如 GRS-GPT 临时图床上传挂了 / 参考图缺失 / cpolar 抽风 ...).
// 没这个的话, 前置失败会让任务"静默消失", 用户既看不到回收站红卡也看不到对话式生成记录.
async function _failAllPending(ctx, archMetas, errMsg) {
    if (!Array.isArray(archMetas) || archMetas.length === 0) return;
    for (var i = 0; i < archMetas.length; i++) {
        try {
            await ctx.archiveToRecycleBin(archMetas[i], null, 'failed', errMsg || '前置步骤失败');
        } catch(_) {}
    }
}

// Forge 目标尺寸计算（与 index.js / tile-forge.host.js 保持一致）
function resolveForgeTargetSize(params, savedSelection) {
    var targetLong = parseInt(params && params.resolution, 10);
    if (!(targetLong > 0)) {
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

    var fallbackW = parseInt(params && params.width, 10);
    var fallbackH = parseInt(params && params.height, 10);
    if (!(fallbackW > 0)) fallbackW = targetLong;
    if (!(fallbackH > 0)) fallbackH = targetLong;
    return { width: fallbackW, height: fallbackH };
}

// 模块级状态（原 index.js 全局变量，仅 handleRunSingle 使用的并发池）
var _unifiedConcurrencyPool = null;
// ComfyUI object_info 缓存（原 g_comfyCachedObjectInfo，仅在 runSingle comfyui 路径使用）
var g_comfyCachedObjectInfo = null;

// ============================================================
//  runSingle — 单图生成主流程（原 handleRunSingle，~457 行原样搬）
// ============================================================

HostAPI.registerAction('runSingle', async function(params, ctx) {
    var taskId = params.taskId || ('t_' + Date.now());
    var batchSize = params.batchSize || 1;
    var engine = params.engine || 'api'; // 'api' | 'forge' | 'comfyui'
    var automationAuthorizationAcked = false;

    // 文档归属和真实生成请求结果放在主作用域，授权/前置/异步致命异常都能拿到完整结算数据。
    var _reuseCapture = params.reuseCapture || {};
    var originDocId = _reuseCapture.docId != null ? _reuseCapture.docId
        : (params.automationDocId != null ? params.automationDocId : (params.docId != null ? params.docId : null));
    var originDocName = params.docName || _reuseCapture.docName || '';
    var originDocPath = params.docPath || _reuseCapture.docPath || '';
    try {
        var _initialDoc = null;
        if (originDocId != null && app.documents && typeof app.documents.find === 'function') {
            _initialDoc = app.documents.find(function(d) { return String(d.id) === String(originDocId); });
        }
        if (!_initialDoc && originDocId == null) _initialDoc = app.activeDocument;
        if (_initialDoc) {
            originDocId = _initialDoc.id;
            if (!originDocName) originDocName = _initialDoc.name || '';
            if (!originDocPath) {
                try { originDocPath = _initialDoc.path ? String(_initialDoc.path) : ''; } catch (_) {}
            }
        }
    } catch (_) {}

    var _requestStats = {
        sentRequests: 0,
        succeededRequests: 0,
        failedRequests: 0,
        generatedImages: 0
    };
    var _fatalPendingPayloads = [];
    var _fatalReturnedCount = 0;

    function _isUnsentGenerationError(err) {
        if (err && err.requestAttempted === false) return true;
        var msg = String((err && err.message) || err || '');
        return /提示词为空|AJI 服务器未校验|构造请求体失败|Invalid URL|Failed to parse URL/i.test(msg);
    }

    function _runCompletion(extra) {
        var receipt = {
            taskId: taskId,
            size: params.size || '',
            model: params.model || '',
            successCount: _requestStats.generatedImages,
            generatedCount: _requestStats.generatedImages,
            returnedCount: 0,
            pendingCount: 0,
            failCount: _requestStats.failedRequests,
            provider: params.provider || '',
            engine: engine,
            docName: originDocName || '',
            docPath: originDocPath ? String(originDocPath) : '',
            batchSize: Number(batchSize) || 1
        };
        extra = extra || {};
        for (var key in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, key)) receipt[key] = extra[key];
        }
        ctx.sendTaskCompleteOnce(taskId, receipt);
    }

    if (params.automationRequest === true) {
        var authResult;
        try {
            if (!automationSecurity || typeof automationSecurity.consumeRunAuthorization !== 'function') throw new Error('自动化授权模块未就绪');
            authResult = await automationSecurity.consumeRunAuthorization({
                authorizationId: params.automationAuthorizationId,
                taskId: taskId,
                docId: params.automationDocId,
                engine: engine,
                provider: params.provider,
                model: params.model,
                size: params.size,
                aspectRatio: params.aspectRatio,
                batch: batchSize,
                autoReturn: params.autoReturn === true,
                continueNextRegion: params.automationContinueNextRegion === true
            });
        } catch (authErr) {
            authResult = { success: false, error: { code: 'RUN_AUTHORIZATION_FAILED', message: (authErr && authErr.message) || String(authErr) } };
        }
        if (!authResult || !authResult.success) {
            var authMessage = (authResult && authResult.error && authResult.error.message) || '自动化生成授权校验失败';
            ctx.logToPanel('[自动化] 已在联网出图前拒绝任务: ' + authMessage, 'error');
            ctx.sendToPanel('automationRunAuthorizationResult', {
                authorizationId: params.automationAuthorizationId || null,
                taskId: taskId,
                success: false,
                error: (authResult && authResult.error) || { code: 'RUN_AUTHORIZATION_FAILED', message: authMessage }
            });
            _runCompletion({
                successCount: 0, generatedCount: 0, failCount: 0,
                error: authMessage, error_category: 'automation.authorization'
            });
            return true;
        }
        if (automationSecurity && typeof automationSecurity.isRunCancelled === 'function' && automationSecurity.isRunCancelled(taskId)) {
            if (typeof automationSecurity.revokeTrustedTask === 'function') automationSecurity.revokeTrustedTask(taskId);
            ctx.sendToPanel('automationRunAuthorizationResult', {
                authorizationId: params.automationAuthorizationId || null,
                taskId: taskId,
                success: false,
                error: { code: 'RUN_AUTHORIZATION_CANCELLED', message: '这次自动化生成已经取消' }
            });
            _runCompletion({
                successCount: 0, generatedCount: 0, failCount: 0,
                error: '这次自动化生成已经取消',
                error_category: 'automation.authorization_cancelled'
            });
            return true;
        }
    }
    // 懒加载初始化全局统一并发池
    if (!_unifiedConcurrencyPool) {
        _unifiedConcurrencyPool = ctx.createConcurrencyPool(20);
    }

    var timeout = params.timeout || 3600;
    var _evStartTs = Date.now();   // 证据日志: 任务开始时间

    ctx.g_taskEarlyStop[taskId] = false;
    ctx.g_taskCompleteSentRef.value[taskId] = false;
    if (params.autoReturn !== undefined) ctx.g_taskAutoReturn[taskId] = !!params.autoReturn;

    // comfyui和forge单任务模式下不走并发分发，直接视为1批次
    if (engine === 'comfyui' || engine === 'forge') {
        batchSize = 1;
    }

    try {
        ctx.logToPanel("[" + engine.toUpperCase() + " 任务 " + taskId.slice(-4) + "] 开始准备选区...", "info");

        // --- 获取目标选区并准备图片（所有批次共享同一次选区抓取） ---
        var savedSelection = null;
        var captureBase64 = null;

        if (engine === 'api' || engine === 'forge' || (engine === 'comfyui' && params.needCapture)) {
          if (params.reuseCapture && params.reuseCapture.base64 && params.reuseCapture.selection && params.reuseCapture.docId != null) {
            // 🔁 一键重跑: 直接复用前端回传的「上一次单图」截图+选区, 不抓实时选区、不读 activeDocument、不进 PS 锁、不 deselect。
            //  · docId 必须非空 —— 贴回阶段靠它定位原文档; 若为空, placeImageToSpecificDoc 会 fallback 到当前 activeDocument, 把图贴错文档(破坏性)。
            //  · 原文档若已关闭: 贴回阶段 placeImageToSpecificDoc 找不到该 id 会 throw, 走现有失败兜底转缓存, 不会误贴当前文档。
            //  · 不更新 g_lastSelection* 全局缓存 —— 那组缓存语义是"最近一次实时抓取", 复用回传不应改写它。
            originDocId = params.reuseCapture.docId;
            savedSelection = params.reuseCapture.selection;
            captureBase64 = params.reuseCapture.base64;
            originDocName = params.reuseCapture.docName || originDocName || '';
            try {
                var _reuseDoc = app.documents.find(function(d) { return String(d.id) === String(originDocId); });
                if (_reuseDoc) {
                    if (!originDocName) originDocName = _reuseDoc.name;
                    try { if (_reuseDoc.path) originDocPath = String(_reuseDoc.path); } catch (_reusePathErr) {}
                }
            } catch (_reuseErr) {}
            ctx.logToPanel("[一键重跑] 复用上一次的选区与截图, 跳过实时抓取", "info");
            ctx.sendToPanel('previewImage', { base64: captureBase64, selection: savedSelection, docId: originDocId, docName: originDocName || '', docPath: originDocPath ? String(originDocPath) : '', taskId: taskId });
          } else {
            var captureResult = await ctx.acquirePSLock(async function() {
                var _doc = app.activeDocument;
                if (!_doc) return null;
                if (params.automationRequest === true && String(_doc.id) !== String(params.automationDocId)) {
                    throw new Error('自动化生成前 Photoshop 当前文档已变化，请重新发起');
                }
                var _docId = _doc.id;
                var _docName = _doc.name;
                var _docPath = null;
                try { _docPath = _doc.path || null; } catch (_dpErr) {}   // 没保存过的文档取 path 会抛/为空
                // 自动扩充+裁切: 开关开 + 比例 1:1 → 抓图时非方形选区补白凑方(回图贴回时按 cropRect 裁白)
                var _padOpts = (ctx.g_autoPadCropRef && ctx.g_autoPadCropRef.value && params.aspectRatio === '1:1')
                    ? { padToSquare: true } : undefined;
                var _capture = await ctx.getSelectionAndImage(undefined, _padOpts);
                if (!_capture) {
                    if (engine === 'comfyui' && params.needCapture && ctx.g_lastCaptureBase64Ref.value && ctx.g_lastSelectionRef.value && ctx.g_lastSelectionDocIdRef.value !== null) {
                        var _cachedDocName = _docName;
                        var _cachedDocPath = _docPath;
                        try {
                            var _cachedDoc = app.documents.find(function(d) { return d.id === ctx.g_lastSelectionDocIdRef.value; });
                            if (_cachedDoc) {
                                _cachedDocName = _cachedDoc.name;
                                try { _cachedDocPath = _cachedDoc.path || null; } catch (_cpErr) {}
                            }
                        } catch(_ce) {}
                        ctx.logToPanel("[ComfyUI] 未检测到实时选区，复用最近一次框选缓存", "warn");
                        return { originDocId: ctx.g_lastSelectionDocIdRef.value, originDocName: _cachedDocName, originDocPath: _cachedDocPath, capture: { base64: ctx.g_lastCaptureBase64Ref.value, selection: ctx.g_lastSelectionRef.value }, savedSelection: ctx.g_lastSelectionRef.value };
                    }
                    return null;
                }
                if (params.automationRequest === true && authResult && authResult.data && authResult.data.selectionBounds &&
                    !_sameSelectionBounds(authResult.data.selectionBounds, _capture.selection)) {
                    throw new Error('自动化授权要求使用刚刚验证的选区，但生成前选区已经移动或改变');
                }
                var _savedSel = _capture.selection;
                ctx.g_lastSelectionRef.value = _savedSel;
                ctx.g_lastSelectionDocIdRef.value = _docId;
                ctx.g_lastCaptureBase64Ref.value = _capture.base64;
                ctx.sendToPanel('previewImage', { base64: _capture.base64, selection: _savedSel, docId: _docId, docName: _docName || '', docPath: _docPath ? String(_docPath) : '', taskId: taskId });
                await ctx.deselectAll();
                return { originDocId: _docId, originDocName: _docName, originDocPath: _docPath, capture: _capture, savedSelection: _savedSel };
            }, taskId);

            if (!captureResult) {
                var captureFailure = ctx.getSelectionAndImage && ctx.getSelectionAndImage.lastError;
                if (captureFailure && captureFailure.code !== 'NO_SELECTION') {
                    throw new Error(captureFailure.message || '选区抓取失败');
                }
                throw new Error("未检测到选区");
            }
            if (params.automationRequest === true && authResult && authResult.data && authResult.data.requiresSquare === true) {
                var authSel = captureResult.savedSelection || (captureResult.capture && captureResult.capture.selection);
                var authW = authSel && Number(authSel.width), authH = authSel && Number(authSel.height);
                var authTolerance = Math.max(1, Math.round(Math.max(authW || 0, authH || 0) * 0.002));
                if (!(authW > 0 && authH > 0) || Math.abs(authW - authH) > authTolerance) {
                    throw new Error('自动化授权要求正方形选区，但生成前选区已经变化');
                }
            }
            if (params.automationRequest === true && automationSecurity && typeof automationSecurity.isRunCancelled === 'function' && automationSecurity.isRunCancelled(taskId)) {
                throw new Error('这次自动化生成已经取消');
            }
            if (params.automationRequest === true) {
                ctx.sendToPanel('automationRunAuthorizationResult', {
                    authorizationId: params.automationAuthorizationId,
                    taskId: taskId,
                    docId: authResult.data && authResult.data.docId,
                    success: true,
                    error: null
                });
                automationAuthorizationAcked = true;
            }
            originDocId = captureResult.originDocId;
            originDocName = captureResult.originDocName;
            originDocPath = captureResult.originDocPath || null;
            savedSelection = captureResult.savedSelection || (captureResult.capture && captureResult.capture.selection) || null;
            captureBase64 = captureResult.capture && captureResult.capture.base64;
          }
        }

        // 建缓存文件夹(两级: 文档名_短码/预设名_日期_时间_随机) — 抓完选区才知道文档信息。
        // 没抓到文档信息(如 ComfyUI 无选区) → fs-utils 自动退回老平铺结构
        var runFolder = await ctx.createImageCacheRunFolder({
            engine: engine, taskId: taskId,
            label: params.presetTitle || '单图生成',
            docName: originDocName || '',
            docPath: originDocPath ? String(originDocPath) : '',
            docId: originDocId
        });
        var runPath = (runFolder && (runFolder.wcRunPath || runFolder.name)) || '';
        if (captureBase64) {
            await ctx.saveImageToRunFolder(runFolder, 'input', captureBase64, 1);
        }

        // --- GRS+GPT-Image 预上传 ---
        // 如果是 GRS 流且模型是 gpt-image 系列, 这里把主图+参考图全部上传换成 URL,
        // 后续 batchSize 次 job 共享同一组 URL (避免每次重复上传)
        var _grsPreUrls = null;   // 不为 null = 走 GRS+gptImage 路径
        // --- 预占 N 个 pending 槽位 — 必须在所有可能 throw 的步骤 (GRS 预上传/参考图处理) 之前 ---
        // 否则: GRS+GPT 预上传到临时图床失败时, 任务直接抛, 回收站一片空白, 对话式生成也没记录, 用户感觉"静默失败".
        // 现在: 占位先建好, 任何前置步骤失败都能转 failed 反馈给用户.
        var _archMetas = [];
        if (engine === 'api') {
            var _archMetasNow = Date.now();
            for (var _mi = 0; _mi < batchSize; _mi++) {
                _archMetas.push({
                    id: taskId + '_' + _mi + '_' + _archMetasNow,
                    batchId: taskId,
                    workflow: 'run',
                    prompt: params.prompt,
                    model: params.model,
                    provider: params.provider,
                    size: params.size,
                    aspectRatio: params.aspectRatio,
                    presetTitle: params.presetTitle || '',
                    context: {
                        docId: originDocId,
                        docName: originDocName || '',
                        docPath: originDocPath ? String(originDocPath) : '',   // v6.4.9: 生成记录按项目分组用
                        selection: savedSelection,
                        antiMode: params.antiMode || 0,
                        layerType: params.layerType || 'smartObject',
                        groupName: '单图生成',
                        // v6.5.10: 缓存文件夹路径 — ⏸(后台完成图)从回收站贴回时靠它
                        // 补记校色台账 + 走自动校色(没有它只能"裸贴", 校色功能全断)
                        runFolderName: runPath
                    },
                    extras: { idxInBatch: _mi, batchTotal: batchSize }
                });
            }
            try { await ctx.beginBatchPendingArchive(_archMetas); } catch(_) {}
        }

        // --- GRS+GPT-Image 路径: 参考图预上传到临时图床 ---
        var _isGrsGpt = (params.engine === 'api' || !params.engine)
                     && params.provider === 'grs'
                     && typeof params.model === 'string'
                     && params.model.toLowerCase().indexOf('gpt-image') !== -1;
        if (_isGrsGpt) {
            // 不区分主图/参考图, 全部按顺序打包发出去
            var _allRefs = [];
            if (captureBase64) _allRefs.push({ base64: captureBase64 });
            if (Array.isArray(params.refImages)) {
                for (var _ri = 0; _ri < params.refImages.length; _ri++) {
                    if (params.refImages[_ri]) _allRefs.push({ base64: params.refImages[_ri] });
                }
            }
            if (_allRefs.length === 0) {
                // 占位转 failed, 让用户能在回收站看到 + 提示客观原因
                await _failAllPending(ctx, _archMetas, 'GRS+GPT-Image 模式需要至少一张图作为参考');
                throw new Error('GRS+GPT-Image 模式需要至少一张图作为参考');
            }
            // 强制压缩: 任何 > 1.2 MB 的图都重压, 避免 cpolar 转发时 502 / server 端 413 (上限 2 MB)
            ctx.logToPanel('[GRS] 检查 ' + _allRefs.length + ' 张图体积...', 'info');
            for (var _ci = 0; _ci < _allRefs.length; _ci++) {
                _allRefs[_ci].base64 = await _ensureSmallEnough(_allRefs[_ci].base64, ctx, _ci);
            }
            ctx.logToPanel('[GRS] 预上传 ' + _allRefs.length + ' 张图到临时图床...', 'info');
            ctx.sendToPanel('taskProgress', {
                taskId: taskId, total: _allRefs.length, index: 0,
                status: '上传图床 0/' + _allRefs.length
            });
            try {
                _grsPreUrls = await _uploadRefsToTempServer(_allRefs, ctx, function(done, total) {
                    ctx.sendToPanel('taskProgress', {
                        taskId: taskId, total: total, index: done,
                        status: '上传图床 ' + done + '/' + total
                    });
                });
                ctx.logToPanel('[GRS] 全部上传完成, 开始提交 GRS 任务', 'success');
            } catch (upErr) {
                var upMsg = '[GRS] 上传图床失败: ' + (upErr.message || upErr);
                ctx.logToPanel(upMsg, 'error');
                // 占位转 failed, 让回收站显示红色 ✗ 卡 + 错误信息, 用户能看到
                await _failAllPending(ctx, _archMetas, upMsg);
                throw upErr;
            }
        }

        // --- 构建并发请求队列 ---
        var jobPromises = [];
        for (var jobIdx = 0; jobIdx < batchSize; jobIdx++) {
            var jobPromise = (async function(currentIndex) {
                var _generationRequestSent = false;
                var _generationRequestSettled = false;
                return _unifiedConcurrencyPool.add(async function() {
                    if (ctx.g_taskEarlyStop[taskId]) {
                        throw new Error("已被提前结束");
                    }

                    ctx.logToPanel("[" + engine.toUpperCase() + " 任务 " + taskId.slice(-4) + "] 开始调度 (" + (currentIndex + 1) + "/" + batchSize + ")...", "info");

                    var _jobStartTime = Date.now();
                    var resultPayload = null;

                    if (engine === 'api') {
                        // 回收站归档元数据 — 用循环外预构造好的 pending 占位 meta
                        // (callAiApi 的 taskId 仍是共享, earlyStop 一起停)
                        var _archMeta = _archMetas[currentIndex];
                        var _archCb = function(b64, status, err) {
                            return ctx.archiveToRecycleBin(_archMeta, b64, status, err);
                        };
                        _generationRequestSent = true;
                        _requestStats.sentRequests += 1;
                        if (_grsPreUrls) {
                            // GRS+GPT-Image 路径: 不传 base64, 用预上传的 URL 数组
                            // (callAiApi 内部 grs+gpt-image 分支会走 callGrsGptImageApi)
                            resultPayload = await ctx.callAiApi(
                                params.apiKey, params.prompt, '', params.size,
                                timeout, params.apiBaseUrl, [],
                                params.model, params.provider, taskId, params.aspectRatio,
                                { grsUrls: _grsPreUrls, archiveCallback: _archCb, archiveId: _archMeta.id }
                            );
                        } else {
                            resultPayload = await ctx.callAiApi(
                                params.apiKey, params.prompt, captureBase64, params.size,
                                timeout, params.apiBaseUrl, params.refImages,
                                params.model, params.provider, taskId, params.aspectRatio,
                                { archiveCallback: _archCb, archiveId: _archMeta.id }
                            );
                        }
                        var _jobElapsed = ((Date.now() - _jobStartTime) / 1000).toFixed(1);
                        ctx.logToPanel("[API 任务 " + taskId.slice(-4) + "] 第" + (currentIndex + 1) + "张完成 (" + _jobElapsed + "s)", "success");
                    }
                    else if (engine === 'forge') {
                    // Forge 生成（走统一任务队列）
                    var forgeUrl = params.url;
                    if ((!forgeUrl || !String(forgeUrl).trim()) && params.encrypted && cloudService && typeof cloudService.decryptUrl === 'function') {
                        forgeUrl = cloudService.decryptUrl(params.encrypted);
                        if (forgeUrl) {
                            forgeUrl = forgeUrl.replace(/\/$/, '');
                            // 云Forge：与原流程一致，先扣积分再生成
                            try {
                                var _modelName = params.model || 'unknown';
                                var _resSize = resolveForgeTargetSize(params, savedSelection);
                                var _resMax = Math.max(_resSize.width, _resSize.height);
                                var _consumeRes = await cloudService.apiConsumePoints({ model: _modelName, resolution: _resMax });
                                if (!(_consumeRes && (_consumeRes.code === 0 || _consumeRes.errno === 0) && _consumeRes.data)) {
                                    var _errMsg = (_consumeRes && _consumeRes.message) || (_consumeRes && _consumeRes.msg) || '积分扣除失败';
                                    throw new Error(_errMsg);
                                }
                            } catch(_ce) {
                                throw new Error('云Forge积分扣除失败: ' + _ce.message);
                            }
                        }
                    }
                    if (!forgeUrl) throw new Error('Forge URL 未配置');
                    forgeUrl = String(forgeUrl).replace(/\/$/, '');

                    if (params.model) {
                        try {
                            await fetch(forgeUrl + '/sdapi/v1/options', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ sd_model_checkpoint: params.model })
                            });
                        } catch(_me) {}
                    }

                    var controllerF = new AbortController();
                    var timeoutIdF = setTimeout(function() { controllerF.abort(); }, timeout * 1000);
                    var controllerEntryF = { controller: controllerF, timeoutId: timeoutIdF, startTime: Date.now(), timeoutSeconds: timeout };
                    ctx.g_activeControllersRef.value.push(controllerEntryF);
                    if (!ctx.g_taskControllers[taskId]) ctx.g_taskControllers[taskId] = [];
                    ctx.g_taskControllers[taskId].push(controllerEntryF);

                    var progressTimerF = setInterval(async function() {
                        try {
                            var prF = await fetch(forgeUrl + '/sdapi/v1/progress', { method: 'GET' });
                            if (prF.ok) {
                                var pdF = await prF.json();
                                ctx.sendToPanel('forgeProgress', { progress: pdF.progress || 0, eta: pdF.eta_relative || 0, textinfo: pdF.textinfo || '', taskId: taskId });
                            }
                        } catch(_pe) {}
                    }, 1000);

                    try {
                        var forgeTargetSize = resolveForgeTargetSize(params, savedSelection);
                        var payloadF = {
                            init_images: ["data:image/png;base64," + captureBase64],
                            prompt: params.prompt || "",
                            negative_prompt: params.negPrompt || "",
                            steps: params.steps || 20,
                            cfg_scale: params.cfg || 7,
                            denoising_strength: params.denoise || 0.75,
                            width: forgeTargetSize.width,
                            height: forgeTargetSize.height,
                            sampler_name: params.sampler || "Euler a",
                            batch_size: params.batchSize || 1,
                            seed: (params.seed !== undefined && params.seed !== null) ? params.seed : -1
                        };
                        if (params.cnEnabled) {
                            var cnUnitF = {
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
                            payloadF.controlnet_units = [cnUnitF];
                            payloadF.alwayson_scripts = { ControlNet: { args: [cnUnitF] } };
                        }

                        _generationRequestSent = true;
                        _requestStats.sentRequests += 1;
                        var respF = await fetch(forgeUrl + '/sdapi/v1/img2img', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payloadF),
                            signal: controllerF.signal
                        });
                        if (!respF.ok) throw new Error('Forge HTTP ' + respF.status);
                        var dataF = await respF.json();
                        if (!dataF.images || dataF.images.length === 0) throw new Error('Forge 未返回图片');

                        resultPayload = [];
                        for (var fbi = 0; fbi < dataF.images.length; fbi++) {
                            var b64 = dataF.images[fbi] || '';
                            if (b64.indexOf(',') !== -1) b64 = b64.split(',')[1];
                            resultPayload.push(b64);
                        }
                        ctx.sendToPanel('forgeProgress', { progress: 1, done: true, taskId: taskId });
                    } finally {
                        try { clearInterval(progressTimerF); } catch(_ct) {}
                        clearTimeout(timeoutIdF);
                        var idxF = ctx.g_activeControllersRef.value.indexOf(controllerEntryF);
                        if (idxF !== -1) ctx.g_activeControllersRef.value.splice(idxF, 1);
                        if (ctx.g_taskControllers[taskId]) {
                            var tidxF = ctx.g_taskControllers[taskId].indexOf(controllerEntryF);
                            if (tidxF !== -1) ctx.g_taskControllers[taskId].splice(tidxF, 1);
                        }
                    }
                    }
                    else if (engine === 'comfyui') {
                    // ComfyUI 生成
                    var workflow = params.workflow;
                    var inputValues = params.params || {};
                    var url = params.url;

                    // 构建 prompt
                    if (!g_comfyCachedObjectInfo) {
                        var oiR = await fetch(url + '/object_info', { method: 'GET' });
                        if (oiR.ok) g_comfyCachedObjectInfo = await oiR.json();
                    }
                    var comfyPrompt = comfyEngine.convertToAPIPrompt(workflow, g_comfyCachedObjectInfo, inputValues);

                    // 如果有图片需要上传
                    if (captureBase64) {
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
                        var uploadResp = await fetch(url + '/upload/image', {
                            method: 'POST',
                            headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
                            body: fullBody.buffer
                        });
                        if (uploadResp.ok) {
                            var uploadData = await uploadResp.json();
                            var uploadedName = uploadData.name || 'ps_capture.png';
                            for (var nk in comfyPrompt) {
                                if (comfyPrompt[nk] && comfyPrompt[nk].inputs) {
                                    if (comfyPrompt[nk].class_type === 'LoadImage') {
                                        comfyPrompt[nk].inputs.image = uploadedName;
                                    } else if (comfyPrompt[nk].class_type === 'PS Bridge Load Image') {
                                        comfyPrompt[nk].class_type = 'LoadImage';
                                        comfyPrompt[nk].inputs = { image: uploadedName };
                                    }
                                }
                            }
                        }
                    }

                    // 提交队列
                    var controller = new AbortController();
                    var timeoutId = setTimeout(function() { controller.abort(); }, timeout * 1000);
                    var controllerEntry = { controller: controller, timeoutId: timeoutId, startTime: Date.now(), timeoutSeconds: timeout };
                    ctx.g_activeControllersRef.value.push(controllerEntry);
                    if (!ctx.g_taskControllers[taskId]) ctx.g_taskControllers[taskId] = [];
                    ctx.g_taskControllers[taskId].push(controllerEntry);

                    try {
                        _generationRequestSent = true;
                        _requestStats.sentRequests += 1;
                        var queueResp = await fetch(url + '/prompt', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ prompt: comfyPrompt }),
                            signal: controller.signal
                        });
                        if (!queueResp.ok) throw new Error('提交ComfyUI失败 HTTP ' + queueResp.status);
                        var queueData = await queueResp.json();
                        var comfyPromptId = queueData.prompt_id;

                        // 轮询
                        var maxWait = timeout * 1000;
                        var startTime = Date.now();
                        var resultImages = null;
                        while (Date.now() - startTime < maxWait) {
                            if (ctx.g_taskEarlyStop[taskId]) {
                                await fetch(url + '/interrupt', { method: 'POST' }); // 尝试去中断
                                throw new Error("已被提前结束");
                            }
                            await sleep(1000);
                            try {
                                var histResp = await fetch(url + '/history/' + comfyPromptId, { method: 'GET' });
                                if (histResp.ok) {
                                    var histData = await histResp.json();
                                    if (histData[comfyPromptId] && histData[comfyPromptId].outputs) {
                                        var outputs = histData[comfyPromptId].outputs;
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
                                // 推送 comfyProgress 进度，让面板能够显示
                                var elapsed = Math.round((Date.now() - startTime) / 1000);
                                ctx.sendToPanel('comfyProgress', { elapsed: elapsed, maxWait: Math.round(maxWait/1000), taskId: taskId });
                            } catch(pe) {}
                        }

                        if (!resultImages || resultImages.length === 0) {
                            throw new Error("未获取到生成结果(超时或无输出)");
                        }

                        // 下载全部图片（ComfyUI 工作流内部的 batch_size / 多输出节点决定数量）
                        resultPayload = [];
                        for (var ri = 0; ri < resultImages.length; ri++) {
                            var imgInfo = resultImages[ri];
                            var imgUrl = url + '/view?filename=' + encodeURIComponent(imgInfo.filename) + '&subfolder=' + encodeURIComponent(imgInfo.subfolder || '') + '&type=' + encodeURIComponent(imgInfo.type || 'output');
                            var imgResp = await fetch(imgUrl, { method: 'GET' });
                            if (!imgResp.ok) throw new Error("下载ComfyUI图片失败");
                            var imgArrayBuf = await imgResp.arrayBuffer();
                            resultPayload.push(arrayBufferToBase64(imgArrayBuf));
                        }

                    } finally {
                        clearTimeout(timeoutId);
                        var idx = ctx.g_activeControllersRef.value.indexOf(controllerEntry);
                        if (idx !== -1) ctx.g_activeControllersRef.value.splice(idx, 1);
                        if (ctx.g_taskControllers[taskId]) {
                            var tidx = ctx.g_taskControllers[taskId].indexOf(controllerEntry);
                            if (tidx !== -1) ctx.g_taskControllers[taskId].splice(tidx, 1);
                        }
                    }
                }

                    var _generatedByRequest = Array.isArray(resultPayload) ? resultPayload.length : (resultPayload ? 1 : 0);
                    if (_generationRequestSent && !_generationRequestSettled) {
                        _generationRequestSettled = true;
                        if (_generatedByRequest > 0) {
                            _requestStats.succeededRequests += 1;
                            _requestStats.generatedImages += _generatedByRequest;
                        } else {
                            _requestStats.failedRequests += 1;
                        }
                    }
                    ctx.sendToPanel('taskProgress', { total: batchSize, index: currentIndex + 1, status: _generatedByRequest > 0 ? 'success' : 'fail', taskId: taskId });
                    return {
                        success: _generatedByRequest > 0,
                        payload: resultPayload,
                        successCount: _generatedByRequest,
                        requestSent: _generationRequestSent
                    };
                }).catch(function(err) {
                    if (_generationRequestSent && !_generationRequestSettled) {
                        _generationRequestSettled = true;
                        if (_isUnsentGenerationError(err)) {
                            _generationRequestSent = false;
                            _requestStats.sentRequests = Math.max(0, _requestStats.sentRequests - 1);
                        } else {
                            _requestStats.failedRequests += 1;
                        }
                    }
                    // 子任务失败时立即实时推送 fail 状态，不等 allSettled
                    ctx.sendToPanel('taskProgress', { total: batchSize, index: currentIndex + 1, status: 'fail', taskId: taskId });
                    ctx.logToPanel("[错误] " + (err ? err.message : "未知错误"), "error");
                    throw err; // 继续向 allSettled 传递 rejected，让它知道该任务失败
                });
            })(jobIdx);
            jobPromises.push(jobPromise);
        }

        // 等待所有并发作业完成
        Promise.allSettled(jobPromises).then(async function(results) {
            var wasStopped = !!ctx.g_taskEarlyStop[taskId];
            var allPayloads = [];
            for (var ri = 0; ri < results.length; ri++) {
                if (results[ri].status === 'fulfilled' && results[ri].value && results[ri].value.success) {
                    if (results[ri].value.payload) {
                        if (Array.isArray(results[ri].value.payload)) allPayloads = allPayloads.concat(results[ri].value.payload);
                        else allPayloads.push(results[ri].value.payload);
                    }
                }
                // fail 已在子任务 catch 里实时推送，这里不再重复处理
            }
            // 重复回图兜底(v6.5.0): 字节级全等去重(API 层已去过一道, 这里防多 job 间的重复)
            if (allPayloads.length > 1) {
                var _seenP = {};
                allPayloads = allPayloads.filter(function(p) {
                    if (_seenP[p]) { ctx.logToPanel('[回图] 跳过一张重复图片(与已回图完全相同)', 'warn'); return false; }
                    _seenP[p] = true;
                    return true;
                });
            }
            // 后续落盘、贴回或编组再抛错时，仍可按这里已经拿到的真实结果结算并缓存。
            _fatalPendingPayloads = allPayloads.slice();

            // API/ComfyUI 都在所有网络请求结束后统一回图，避免一张一张贴回
            var autoReturn = (ctx.g_taskAutoReturn[taskId] !== false);
            var returnWorkflowKey = (engine === 'api') ? 'bananaSingle' : (engine === 'forge' ? 'forge' : (engine === 'comfyui' ? 'comfyui' : 'bananaSingle'));
            var placementSuccess = false;
            var returnedCount = 0;
            var pendingPayloads = allPayloads.slice();
            if (allPayloads.length > 0) {
                for (var opi = 0; opi < allPayloads.length; opi++) {
                    await ctx.saveImageToRunFolder(runFolder, 'output', allPayloads[opi], opi + 1);
                }
                if (engine === 'api') {
                    await ctx.savePromptTxtToRunFolder(runFolder, params.prompt || '');
                }
                // 证据日志(指纹+签章链): 异步写, 不 await, 不挡回图; 失败只打日志
                evidenceLog.appendEvidence({
                    runFolder: runFolder,
                    runPath: runPath,
                    taskId: taskId,
                    startTs: _evStartTs,
                    endTs: Date.now(),
                    engine: engine,
                    model: params.model || '',
                    source: params.provider || '',
                    docName: originDocName || '',
                    prompt: params.prompt || '',
                    inputs: captureBase64 ? [captureBase64] : [],
                    outputs: allPayloads.slice()
                }).then(function(evRes) {
                    if (evRes && evRes.ok) ctx.logToPanel('[证据日志] 已记录 链号#' + evRes.seq, 'info');
                    else ctx.logToPanel('[证据日志] 写入失败(不影响生成): ' + ((evRes && evRes.error) || '?'), 'warn');
                });
                // 自动校色(设置开关): 传回前先把全部回图按抓图原图校色(独立任务卡),
                // 校完换掉 payload → 后面自动/手动传回贴的都是校色版; 缓存里保留的是原始回图。
                // 没抓图的场景(如 ComfyUI 无选区)自动跳过。
                if (params.autoColormatch && captureBase64 && allPayloads.length > 0) {
                    try {
                        var _cmMod = require('./tile-colormatch.host.js');
                        var _cmAuto = await _cmMod.autoColormatchAll(ctx, { inputB64: captureBase64, payloads: allPayloads, genTaskId: taskId, selection: savedSelection });
                        allPayloads = _cmAuto.payloads;
                        ctx.logToPanel('[自动校色] 完成: ' + _cmAuto.correctedCount + '/' + allPayloads.length + ' 张已校色'
                            + (_cmAuto.failCount ? (', ' + _cmAuto.failCount + ' 张失败传原图') : ''), _cmAuto.failCount ? 'warn' : 'info');
                    } catch (eCmAuto) {
                        ctx.logToPanel('[自动校色] 出错, 本次全部传原图: ' + ((eCmAuto && eCmAuto.message) || eCmAuto), 'warn');
                    }
                }
                _fatalPendingPayloads = allPayloads.slice();
                if (autoReturn) {
                    try {
                        await ctx.acquirePSLock(async function() {
                            ctx.logToPanel("[" + engine.toUpperCase() + "] API序列已结束，正在统一回图...", "info");
                            if (originDocId) {
                                await core.executeAsModal(async function() {
                                    await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: originDocId }] }], {});
                                }, { commandName: "切回文档" });
                            }

                            var createdLayerIds = [];
                            var _cmLedgerEntries = [];   // 校色台账: 本次贴回的 图层↔缓存 对应关系
                            // ── 急速回图开关(v6.5.8): 开 = 批量单权限(快3~4倍); 关 = 老的逐张(默认) ──
                            var _fastOn = false;
                            try {
                                var _fv = ctx.hostStorageRef && ctx.hostStorageRef.value && ctx.hostStorageRef.value['output.fastReturn'];
                                _fastOn = (_fv === true || _fv === 'true');
                            } catch(_) {}
                            if (_fastOn && ctx.placeImagesBatch && allPayloads.length > 0) {
                                ctx.logToPanel('[急速回图] 批量贴回 ' + allPayloads.length + ' 张(单次修改权)…', 'info');
                                var _batchItems = allPayloads.map(function(p) {
                                    return { base64: p, selection: savedSelection, antiMode: params.antiMode || 0, layerType: params.layerType || 'smartObject' };
                                });
                                var _ids = await ctx.placeImagesBatch(originDocId || app.activeDocument.id, _batchItems);
                                pendingPayloads = [];
                                for (var bi = 0; bi < _ids.length; bi++) {
                                    if (!_ids[bi]) { pendingPayloads.push(allPayloads[bi]); continue; }
                                    createdLayerIds.push(_ids[bi]);
                                    _cmLedgerEntries.push({
                                        docId: originDocId || app.activeDocument.id,
                                        docName: originDocName || '',
                                        layerId: _ids[bi],
                                        runFolderName: runPath || (runFolder && runFolder.name),
                                        inputIdx: 1,
                                        outputIdx: bi + 1,
                                        selection: savedSelection,
                                        antiMode: params.antiMode || 0,
                                        layerType: params.layerType || 'smartObject',
                                        featherKey: returnWorkflowKey,
                                        engine: engine,
                                        ts: Date.now()
                                    });
                                    // 羽化蒙版仍逐张(其内部自带 modal, 在批量权限外补挂 — 蒙版慢不在置入热路径)
                                    try {
                                        await ctx.applyReturnFeatherMaskToLayer(originDocId || app.activeDocument.id, _ids[bi], savedSelection, returnWorkflowKey);
                                    } catch (featherErr) {
                                        ctx.logToPanel('[回图] 图已贴回，但羽化蒙版失败: ' + ((featherErr && featherErr.message) || featherErr), 'warn');
                                    }
                                }
                            } else {
                            pendingPayloads = [];
                            for (var pi = 0; pi < allPayloads.length; pi++) {
                                var newLayerId = null;
                                try {
                                    newLayerId = await ctx.placeImageToSpecificDoc(allPayloads[pi], originDocId || app.activeDocument.id, savedSelection, params.antiMode || 0, params.layerType || 'smartObject');
                                } catch (singlePlaceErr) {
                                    ctx.logToPanel('[回图失败] 第 ' + (pi + 1) + ' 张未贴回: ' + ((singlePlaceErr && singlePlaceErr.message) || singlePlaceErr), 'warn');
                                }
                                if (newLayerId) {
                                    createdLayerIds.push(newLayerId);
                                    _cmLedgerEntries.push({
                                        docId: originDocId || app.activeDocument.id,
                                        docName: originDocName || '',
                                        layerId: newLayerId,
                                        runFolderName: runPath || (runFolder && runFolder.name),
                                        inputIdx: 1,               // 主生成: 一张 input 对 N 张 output
                                        outputIdx: pi + 1,
                                        selection: savedSelection,
                                        antiMode: params.antiMode || 0,
                                        layerType: params.layerType || 'smartObject',
                                        featherKey: returnWorkflowKey,
                                        engine: engine,
                                        ts: Date.now()
                                    });
                                    try {
                                        await ctx.applyReturnFeatherMaskToLayer(originDocId || app.activeDocument.id, newLayerId, savedSelection, returnWorkflowKey);
                                    } catch (featherErr2) {
                                        ctx.logToPanel('[回图] 图已贴回，但羽化蒙版失败: ' + ((featherErr2 && featherErr2.message) || featherErr2), 'warn');
                                    }
                                } else pendingPayloads.push(allPayloads[pi]);
                                await sleep(60);
                            }
                            }
                            returnedCount = createdLayerIds.length;
                            placementSuccess = returnedCount === allPayloads.length;
                            _fatalReturnedCount = returnedCount;
                            _fatalPendingPayloads = pendingPayloads.slice();
                            // 校色台账登记(内存 + runFolder/meta.json): Dock 校色按钮靠它反查原图
                            if (_cmLedgerEntries.length) {
                                for (var _li = 0; _li < _cmLedgerEntries.length; _li++) placementLedger.record(_cmLedgerEntries[_li]);
                                try { await placementLedger.writeMetaJson(runFolder, _cmLedgerEntries); }
                                catch (eLedger) { console.warn('[校色台账] meta.json 写入失败:', eLedger && eLedger.message); }
                                ctx.logToPanel('[校色台账] 已登记 ' + _cmLedgerEntries.length + ' 条 (自动传回)', 'info');
                            }
                            if (!ctx.g_earlyStopRef.value && createdLayerIds.length > 0 && ctx.g_autoGroupRef.value) {
                                await core.executeAsModal(async function() {
                                    await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: originDocId || app.activeDocument.id }] }], {});
                                    await ctx.createGroupAndMask(createdLayerIds, "单图生成", (params.presetTitle ? { presetName: params.presetTitle } : undefined));
                                    // 4K偏色自动矫正: 四阀门 = 开关开 + banana/gemini 模型 + 4K + 自动编组(本分支即是)
                                    if (ctx.g_fix4kMagentaRef && ctx.g_fix4kMagentaRef.value
                                        && params.size === '4K'
                                        && /banana|gemini/i.test(String(params.model || ''))
                                        && ctx.applyMagentaFixCurveToGroup) {
                                        try { await ctx.applyMagentaFixCurveToGroup("单图生成"); }
                                        catch (eMg) { ctx.logToPanel("[4K偏色矫正] 曲线创建失败(图已正常编组): " + (eMg.message || eMg), "warn"); }
                                    }
                                }, { commandName: "打组" });
                                // 教学模式:把参数和参考图作为隐藏子组附加到主组
                                if (ctx.g_teachModeRef && ctx.g_teachModeRef.value) {
                                    var refB64s = [];
                                    if (captureBase64) refB64s.push(captureBase64);
                                    if (params.refImages && params.refImages.length) {
                                        for (var rri = 0; rri < params.refImages.length; rri++) refB64s.push(params.refImages[rri]);
                                    }
                                    var rfApplied = ctx.shouldApplyReturnFeather && ctx.shouldApplyReturnFeather(returnWorkflowKey);
                                    var rfCfg = rfApplied ? {
                                        enabled: true,
                                        shrink: ctx.g_returnFeatherShrinkPercentRef && ctx.g_returnFeatherShrinkPercentRef.value,
                                        blur: ctx.g_returnFeatherBlurPercentRef && ctx.g_returnFeatherBlurPercentRef.value
                                    } : { enabled: false };
                                    await ctx.createTeachingMaterials({
                                        docId: originDocId || app.activeDocument.id,
                                        prompt: params.prompt,
                                        model: params.model,
                                        provider: params.provider,
                                        size: params.size,
                                        aspectRatio: params.aspectRatio,
                                        batch: batchSize,
                                        selection: savedSelection,
                                        docW: savedSelection && savedSelection._docW,
                                        docH: savedSelection && savedSelection._docH,
                                        antiMode: params.antiMode || 0,
                                        returnFeather: rfCfg,
                                        promptPresetName: params.presetTitle || '',
                                        refImageBase64s: refB64s,
                                        taskId: taskId
                                    });
                                }
                            }
                            // 通知对话气泡:把刚创建的 layerIDs 绑到对应 item 上
                            if (createdLayerIds.length > 0) {
                                ctx.sendToPanel('conversationEvent', {
                                    type: 'attach-layers',
                                    taskId: taskId,
                                    layerIDs: createdLayerIds,
                                    docId: originDocId || app.activeDocument.id
                                });
                            }
                            returnedCount = createdLayerIds.length;
                            placementSuccess = returnedCount === allPayloads.length;
                            _fatalReturnedCount = returnedCount;
                            _fatalPendingPayloads = pendingPayloads.slice();
                            if (placementSuccess) {
                                try {
                                    await require('../host/proj-thumb.js').updateProjThumb(
                                        originDocId, originDocName || '', originDocPath ? String(originDocPath) : '', ctx.sendToPanel);
                                } catch(_pt) {}
                            }
                        }, taskId);
                    } catch (placeErr) {
                        // 自动传回失败（PS 可能正忙），回退到缓存等待手动传回
                        ctx.logToPanel("[回图失败] PS 可能正在操作中: " + (placeErr.message || placeErr) + "，已缓存等待手动传回", "warn");
                        // 打组/教学等后处理失败时，已经创建的图层不能被当成“未贴回”再次传一遍。
                        placementSuccess = allPayloads.length > 0 && returnedCount === allPayloads.length;
                        _fatalReturnedCount = returnedCount;
                        _fatalPendingPayloads = pendingPayloads.slice();
                    }
                }
                // 自动传回关闭 或 自动传回失败 → 缓存结果供手动传回
                if (!autoReturn || !placementSuccess) {
                    ctx.g_taskResultCache[taskId] = {
                        originDocId: originDocId || null,
                        savedSelection: savedSelection || null,
                        antiMode: params.antiMode || 0,
                        layerType: params.layerType || 'smartObject',
                        // 部分贴回时只缓存失败的图片，重试不会复制已贴成功的图层。
                        payloads: (autoReturn ? pendingPayloads : allPayloads).slice(),
                        groupName: '单图生成',
                        presetName: params.presetTitle || '',
                        returnWorkflowKey: returnWorkflowKey,
                        // 校色台账所需(手动传回时登记):
                        runFolderName: runPath || (runFolder && runFolder.name),
                        docName: originDocName || '',
                        engine: engine,
                        // 教学模式所需:
                        teachParams: {
                            prompt: params.prompt,
                            model: params.model,
                            provider: params.provider,
                            size: params.size,
                            aspectRatio: params.aspectRatio,
                            batch: batchSize,
                            promptPresetName: params.presetTitle || '',
                            captureBase64: captureBase64,
                            refImages: params.refImages || []
                        }
                    };
                    if (placementSuccess === false && autoReturn) {
                        // 自动传回失败，通知面板显示手动传回按钮
                        ctx.sendToPanel('taskAutoReturnFailed', { taskId: taskId, count: pendingPayloads.length, returnedCount: returnedCount });
                    } else {
                        if (wasStopped) ctx.logToPanel("[提前结束] 任务 " + taskId.slice(-4) + " 已截断，保留 " + allPayloads.length + " 张可传回结果", "warn");
                        else ctx.logToPanel("[任务 " + taskId.slice(-4) + "] 生成完成，等待手动传回", "info");
                    }
                }
            } else if (wasStopped) {
                ctx.logToPanel("[提前结束] 任务 " + taskId.slice(-4) + " 已截断，无可传回结果", "warn");
            }

            var generatedCount = _requestStats.generatedImages;
            if (params.automationRequest === true && generatedCount === 0 && automationSecurity && typeof automationSecurity.revokeTrustedTask === 'function') {
                automationSecurity.revokeTrustedTask(taskId);
            }
            var pendingCount = autoReturn ? pendingPayloads.length : allPayloads.length;
            _runCompletion({
                returnedCount: autoReturn ? returnedCount : 0,
                pendingCount: pendingCount,
                stopped: wasStopped, cached: pendingCount > 0
            });
            // 音效三分支(对齐 v5.4.6 的 allFail/singleFail 定义):
            //   全部成功 → playSuccess
            //   全部失败 → playAllFail
            //   部分失败 → playSingleFail (至少一张成功但不到总数)
            if (generatedCount > 0 && _requestStats.failedRequests === 0 && !wasStopped && pendingCount === 0) {
                await ctx.playSuccessSound();
            } else if (generatedCount === 0) {
                await ctx.playAllFailSound();
            } else {
                await ctx.playSingleFailSound();
            }
        }).catch(async function(fatalErr) {
            try { ctx.logToPanel("[致命错误] 任务完成处理失败: " + (fatalErr.message || fatalErr), "error"); } catch (_) {}
            var fatalCached = false;
            if (_fatalPendingPayloads.length > 0) {
                try {
                    if (!ctx.g_taskResultCache[taskId]) {
                        ctx.g_taskResultCache[taskId] = {
                            originDocId: originDocId || null,
                            savedSelection: savedSelection || null,
                            antiMode: params.antiMode || 0,
                            layerType: params.layerType || 'smartObject',
                            payloads: _fatalPendingPayloads.slice(),
                            groupName: '单图生成',
                            presetName: params.presetTitle || '',
                            returnWorkflowKey: engine === 'api' ? 'bananaSingle' : engine,
                            runFolderName: (runFolder && (runFolder.wcRunPath || runFolder.name)) || '',
                            docName: originDocName || '',
                            engine: engine
                        };
                    }
                    fatalCached = !!ctx.g_taskResultCache[taskId];
                } catch (_) {}
            }
            _runCompletion({
                returnedCount: _fatalReturnedCount,
                pendingCount: fatalCached ? _fatalPendingPayloads.length : 0,
                cached: fatalCached,
                error: (fatalErr && fatalErr.message) || String(fatalErr),
                error_category: 'run.postprocess.fatal'
            });
            if (_requestStats.generatedImages > 0) await ctx.playSingleFailSound();
            else await ctx.playAllFailSound();
        });

    } catch (e) {
        _runCompletion({
            returnedCount: _fatalReturnedCount,
            pendingCount: 0,
            cached: false,
            error: (e && e.message) || String(e),
            error_category: 'run.preflight.fatal'
        });
        try { ctx.logToPanel("[错误] 主流程出错: " + e.message, "error"); } catch (_) {}
        if (params.automationRequest === true && !automationAuthorizationAcked && automationSecurity && typeof automationSecurity.revokeTrustedTask === 'function') {
            automationSecurity.revokeTrustedTask(taskId);
        }
        if (params.automationRequest === true && !automationAuthorizationAcked) {
            ctx.sendToPanel('automationRunAuthorizationResult', {
                authorizationId: params.automationAuthorizationId || null,
                taskId: taskId,
                success: false,
                error: { code: 'AUTOMATION_PREFLIGHT_FAILED', message: (e && e.message) || String(e) }
            });
        }
        try { await ctx.playAllFailSound(); } catch (_) {}
    }
}, { tileId: 'run' });

// ============================================================
//  recordableRunSingle — PS 动作录制版
// ============================================================

HostAPI.registerAction('recordableRunSingle', async function(data, ctx) {
    await ctx.markRecordableStart();
    // 复用 runSingle 逻辑（通过 HostAPI dispatch）
    var HostAPILocal = require('../host/host-api.js');
    await HostAPILocal.dispatchAction('runSingle', data || {}, ctx);
}, { tileId: 'run' });

module.exports = {};
