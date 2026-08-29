// ============================================================
//  tile-poster.host.js — 海报排版磁贴 host 端
//
//  注册的 action:
//    posterCaptureFromPS    - 从 PS 当前文档活动选区抓取一张图(必须有选区)
//    posterGenerate         - 调 GPT-Image 生成海报,把结果放进新建项目
//    posterAutofill         - 调代理服务器让 deepseek 解析文案/设定自动填表
//
//  抓图说明:
//    入口只剩"从 PS 抓取" — 必须有活动选区,否则失败。返回的 base64 是已经
//    压缩到 1024 长边的 jpeg q78,直接用作 GPT 参考图,也用作前端缩略图。
// ============================================================

var HostAPI = require('../host/host-api.js');
var serverConfig = require('../core/server-config.js');
var evidenceLog = require('../host/evidence-log.js');   // 证据日志: 指纹+签章链
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;
var imaging = photoshop.imaging;
var uxpModule = require('uxp');
var storage = uxpModule.storage;
var fs = storage.localFileSystem;

var POSTER_THUMB_LONG_SIDE = 1024;   // 缩略图(给 GPT 看的参考图)长边
var POSTER_PREVIEW_LONG_SIDE = 200;  // 给前端图片池显示的小缩略图
var POSTER_LOCAL_MAX_LONG = 1024;    // 本地上传的图也压到这个长边

function _findPosterDocById(docId) {
    for (var i = 0; i < app.documents.length; i++) {
        if (String(app.documents[i].id) === String(docId)) return app.documents[i];
    }
    return null;
}

async function _withPosterDocLock(ctx, taskId, docId, fn) {
    if (docId == null) throw new Error('PS 里没有打开的文档');
    if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop 全局操作锁不可用');
    return await ctx.acquirePSLock(async function() {
        var doc = _findPosterDocById(docId);
        if (!doc) throw new Error('请求发起时的 PS 文档已关闭');
        if (!app.activeDocument || String(app.activeDocument.id) !== String(docId)) {
            await core.executeAsModal(async function() {
                await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: doc.id }] }], {});
            }, { commandName: '切换到海报抓图目标文档' });
        }
        return await fn(doc);
    }, taskId);
}

// 自动填写代理服务器
var POSTER_AUTOFILL_PROXY_PATH = '/api/poster-autofill';
// 调用统计上报(选了哪个选项)
var POSTER_USAGE_PROXY_PATH = '/api/usage';
// 海报参考图临时图床(给 GRS 流用,base64 转外网 URL)
var POSTER_TEMP_UPLOAD_PATH = '/api/poster/upload-temp';

// 跟服务端默认密钥保持一致(server.js 里 WC_SHARED_SECRET_DEFAULT)
var _WC_SECRET = 'wc-v6-public-default-secret-2026';

// 纯 JS SHA-256(UXP 不支持 require('crypto'),抄自 tile-translate.host.js)
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

// 把参考图 base64 上传到 preset-server 临时图床,换成外网 URL(给 GRS 流用)
//   refs: [{name, base64}, ...]
//   返回: ['https://...', 'https://...', ...] 跟入参顺序对齐
//   失败抛错(任意一张失败就整组失败,触发本页跳过)
async function _uploadRefsToTempServer(refs, ctx) {
    if (!refs || !refs.length) return [];
    var deviceId = _readDeviceId(ctx);
    if (!deviceId) throw new Error('未找到设备 ID,请先打开过客服磁贴');
    var urls = new Array(refs.length);
    // 串行上传:并发会让 cpolar 限流,串行更稳;每张几百 KB,16 张大概 5-10 秒
    for (var i = 0; i < refs.length; i++) {
        var r = refs[i];
        if (!r || !r.base64) {
            throw new Error('第 ' + (i + 1) + ' 张参考图无内容');
        }
        var bodyObj = { deviceId: deviceId, base64: r.base64, mime: 'image/jpeg' };
        var bodyStr = JSON.stringify(bodyObj);
        var sigInfo = _signBody(bodyStr);
        try { ctx.logToPanel('[海报·GRS] 第 ' + (i + 1) + '/' + refs.length + ' 张:body ' + (bodyStr.length / 1024).toFixed(1) + ' KB,base64 ' + (r.base64.length / 1024).toFixed(1) + ' KB', 'info'); } catch(_) {}
        var ctrl = new AbortController();
        var to = setTimeout(function() { try { ctrl.abort(); } catch(_){} }, 60 * 1000);
        var resp;
        var raw = '';
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
            raw = await resp.text();
        } catch (e) {
            throw new Error('第 ' + (i + 1) + ' 张上传失败(网络): ' + (e.message || e));
        } finally {
            clearTimeout(to);
        }
        var json = null;
        try { json = JSON.parse(raw); } catch(_) {}
        if (!resp.ok || !json || !json.success || !json.url) {
            var errMsg = (json && json.error) || ('HTTP ' + resp.status);
            throw new Error('第 ' + (i + 1) + ' 张上传失败: ' + errMsg);
        }
        urls[i] = json.url;
        try { ctx.logToPanel('[海报·GRS] 上传参考图 ' + (i + 1) + '/' + refs.length, 'info'); } catch(_) {}
    }
    return urls;
}

function _b64ToArrayBuffer(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var buf = new ArrayBuffer(len);
    var view = new Uint8Array(buf);
    for (var i = 0; i < len; i++) view[i] = bin.charCodeAt(i);
    return buf;
}

function _arrayBufferToBase64(buf) {
    var bytes = new Uint8Array(buf);
    var chunks = [];
    var chunkSize = 8192;
    for (var bi = 0; bi < bytes.length; bi += chunkSize) {
        chunks.push(String.fromCharCode.apply(null, bytes.subarray(bi, bi + chunkSize)));
    }
    return btoa(chunks.join(''));
}

// 算 targetSize:保持原比例,长边 = longSide
function _calcTargetSize(origW, origH, longSide) {
    if (origW <= 0 || origH <= 0) return null;
    if (origW >= origH) {
        if (origW <= longSide) return null;   // 已经够小,不缩
        return { width: longSide, height: Math.round(origH * longSide / origW) };
    } else {
        if (origH <= longSide) return null;
        return { width: Math.round(origW * longSide / origH), height: longSide };
    }
}

// 用 webview 端解码缩放再编码 base64 — 仅用于本地图(host 端没有 canvas API)
// 如果需要在 host 端缩放本地图,得绕个弯 → 直接发原文件,让前端在 webview canvas 缩
// 当前简单方案:本地图也限 1024 长边,但靠"读取后用一个轻量 PNG decoder + 重采样"做不到
// 实际可行:host 把原文件直接读 base64 发给前端,前端 canvas 缩放后再发回 host,但这绕
//
// 折中方案:host 用 imaging.encodeImageData 配合临时载入 PS — 把图打开成临时文档再 getPixels(带 targetSize)再关闭
async function _resizeLocalImageViaPS(arrBuf, origName, longSide, format) {
    longSide = longSide || POSTER_LOCAL_MAX_LONG;
    format = format || 'jpeg';
    // 写临时文件
    var tmp = await fs.getTemporaryFolder();
    var ts = Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    var safeName = (origName || 'img').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
    var ext = '.png';
    var lower = (origName || '').toLowerCase();
    if (/\.(jpe?g)$/i.test(lower)) ext = '.jpg';
    else if (/\.webp$/i.test(lower)) ext = '.webp';
    else if (/\.gif$/i.test(lower)) ext = '.gif';
    var tmpFile = await tmp.createFile('poster_local_' + ts + ext, { overwrite: true });
    await tmpFile.write(arrBuf, { format: storage.formats.binary });

    var resultBase64 = null;
    var openedDocId = null;
    await core.executeAsModal(async function() {
        var token = await fs.createSessionToken(tmpFile);
        // 用 batchPlay open
        var openResult = await app.batchPlay([{
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
        // 关闭临时文档(不保存)
        try {
            await app.batchPlay([{
                _obj: 'close',
                _target: [{ _ref: 'document', _id: openedDocId }],
                saving: { _enum: 'yesNo', _value: 'no' }
            }], {});
        } catch (_) {}
    }, { commandName: '海报·压缩本地图' });

    // 删临时文件
    try { await tmpFile.delete(); } catch (_) {}
    return resultBase64;
}

// ============================================================
//  导出当前活动文档到 base64(按长边缩放)
// ============================================================
async function _exportDocAsBase64(doc, longSide, format) {
    longSide = longSide || POSTER_THUMB_LONG_SIDE;
    format = format || 'jpeg';
    var origW = Math.round(doc.width);
    var origH = Math.round(doc.height);
    var ts = _calcTargetSize(origW, origH, longSide);
    var getOpts = { documentID: doc.id, applyAlpha: true, componentSize: 8 };
    if (ts) getOpts.targetSize = ts;
    var imgObj = await imaging.getPixels(getOpts);
    var encoded;
    try {
        encoded = await imaging.encodeImageData({
            imageData: imgObj.imageData,
            base64: true,
            format: format === 'jpeg' ? 'jpg' : 'png',
            quality: 78
        });
    } finally {
        try { imgObj.imageData.dispose(); } catch (_) {}
    }
    return { base64: encoded, width: imgObj.imageData.width, height: imgObj.imageData.height };
}

// ============================================================
//  导出指定图层为 base64
//  做法:复制图层到临时新文档 → 裁切到图层范围 → 导出 → 关临时文档
// ============================================================
async function _exportLayerAsBase64(srcDoc, layerId, longSide) {
    longSide = longSide || POSTER_THUMB_LONG_SIDE;
    var resultBase64 = null;
    var resultW = 0, resultH = 0;
    await core.executeAsModal(async function() {
        // 切到源文档,选中该图层
        await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: srcDoc.id }] }], {});
        await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: layerId }], makeVisible: true }], {});
        // 复制图层到新文档(autocrop 会裁到图层 bbox)
        await app.batchPlay([{ _obj: 'duplicate', _target: [{ _ref: 'layer', _id: layerId }], name: 'poster_export_temp' }], {});
        // 上面 duplicate 是在原文档复制,我们要的是新文档 — 改用 make document from layer
        // 实际更稳:直接用 layer.export 之类 API,但 UXP 没有
        // 改方案:用 trim 命令裁掉透明区,然后 imaging.getPixels(doc) 取整文档
        // 更简单:直接取 layer 的 bounds,然后 cropTo 到这个范围,再 imaging.getPixels
        // ↑ 但这样会破坏原文档。所以还是:复制图层到新文档
        // batchPlay duplicate 的目标 document 字段是 'name' 不是 _ref,这里我们手动新建
        // 实际最稳:把整个文档导出(不区分图层),让用户提前选好图层位置
    }, { commandName: '导出图层(临时方案)' });
    return { base64: resultBase64, width: resultW, height: resultH };
}

// 上面那段比较复杂,简化版:导出整个文档(因为图层多选时,实际逻辑是
// "用户希望每个图层各导出一张") — 我们用 imaging.getPixels 配合 layerID 筛选
async function _exportLayerSimple(srcDoc, layerInfo, longSide) {
    longSide = longSide || POSTER_THUMB_LONG_SIDE;
    var resultBase64 = null;
    var w = 0, h = 0;

    await core.executeAsModal(async function() {
        await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: srcDoc.id }] }], {});

        // 先读图层 bounds 算原始 W/H,再按比例算 targetSize
        // 不能直接传 {width:N,height:N} 给 getPixels — PS 不保比例,会 stretch 成方图
        var bRes;
        try {
            bRes = await app.batchPlay([{
                _obj: 'get',
                _target: [{ _property: 'bounds' }, { _ref: 'layer', _id: layerInfo.id }]
            }], { synchronousExecution: true });
        } catch (be) {
            bRes = null;
        }
        var origW = 0, origH = 0;
        if (bRes && bRes[0] && bRes[0].bounds) {
            var b = bRes[0].bounds;
            var bL = (b.left._value !== undefined ? b.left._value : b.left) || 0;
            var bT = (b.top._value !== undefined ? b.top._value : b.top) || 0;
            var bR = (b.right._value !== undefined ? b.right._value : b.right) || 0;
            var bB = (b.bottom._value !== undefined ? b.bottom._value : b.bottom) || 0;
            origW = Math.round(bR - bL);
            origH = Math.round(bB - bT);
        }

        var getOpts = {
            documentID: srcDoc.id,
            layerID: layerInfo.id,
            applyAlpha: true,
            componentSize: 8
        };
        // 只在有效尺寸下设 targetSize,且按比例算
        if (origW > 0 && origH > 0) {
            var ts = _calcTargetSize(origW, origH, longSide);
            if (ts) getOpts.targetSize = ts;
        }
        var imgObj = await imaging.getPixels(getOpts);
        try {
            var enc = await imaging.encodeImageData({
                imageData: imgObj.imageData,
                base64: true,
                format: 'jpg',
                quality: 78
            });
            resultBase64 = enc;
            w = imgObj.imageData.width;
            h = imgObj.imageData.height;
        } finally {
            try { imgObj.imageData.dispose(); } catch (_) {}
        }
    }, { commandName: '导出图层' });
    return { base64: resultBase64, width: w, height: h };
}

// ============================================================
//  posterCaptureFromPS — 海报磁贴的统一抓图入口
//  直接复用 host 端通用的 getSelectionAndImage(deps 注入,refimages 也在用),
//  它已经搞定了选区检测多版本降级、位深降级、JPEG/PNG 编码 fallback、
//  alpha 通道等所有边角情况 — 不要再自己写一份。
//
//  data: { slot?: 'pool' | 'upload', uploadKey?: string }
//      slot='pool' (默认):加到素材图片池
//      slot='upload':作为某个 file-upload section(LOGO/头像/二维码) 的图
//  回 panel: posterCaptureFromPSResult { success, slot, uploadKey?, base64?, name?, error? }
// ============================================================
HostAPI.registerAction('posterCaptureFromPS', async function(data, ctx) {
    var slot = (data && data.slot) || 'pool';
    var uploadKey = data && data.uploadKey;
    try {
        var doc = app.activeDocument;
        if (!doc) throw new Error('PS 没有打开的活动文档');
        var docId = doc.id;
        var docName = doc.name || '未命名';

        // 直接调通用工具,内部已做好所有兼容
        var posterCaptureTaskId = (data && data.taskId) || ('poster-capture-' + Date.now());
        var cap = await _withPosterDocLock(ctx, posterCaptureTaskId, docId, async function() {
            return await ctx.getSelectionAndImage();
        });
        if (!cap || !cap.base64) {
            throw new Error('未检测到活动选区 — 请先用矩形选框工具(M)框选要抓取的区域');
        }

        var sel = cap.selection || {};
        var w = sel.width || 0, h = sel.height || 0;
        var longestEdge = Math.max(w, h);
        var b64Size = cap.base64.length;
        var finalBase64 = cap.base64;
        // 强制压缩条件:任一满足就重压到 1024 长边 jpeg q78
        //   1) 选区长边 > 1024(避免大尺寸 PNG)
        //   2) base64 > 1.2 MB(cpolar/JSON body 上限保险)
        // 这一步独立于用户 maxResolution 设置,海报场景对图质要求不严,优先保上传成功
        if (longestEdge > 1024 || b64Size > 1.2 * 1024 * 1024) {
            try {
                ctx.logToPanel('[海报] 选区 ' + w + 'x' + h + ' 较大,重压到 1024 长边 JPEG…', 'info');
                var arrBuf = _b64ToArrayBuffer(cap.base64);
                if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop 全局操作锁不可用');
                var compressed = await ctx.acquirePSLock(function() {
                    return _resizeLocalImageViaPS(arrBuf, docName + '.png', 1024, 'jpeg');
                }, posterCaptureTaskId);
                if (compressed && compressed.length > 0) {
                    finalBase64 = compressed;
                    ctx.logToPanel('[海报] 重压完成: ' + (b64Size / 1024).toFixed(0) + ' KB → ' + (finalBase64.length / 1024).toFixed(0) + ' KB', 'success');
                }
            } catch (rzErr) {
                ctx.logToPanel('[海报] 重压失败,使用原图(可能无法上传到 GRS): ' + (rzErr.message || rzErr), 'warn');
            }
        }

        var name = docName + (w && h ? (' [' + w + '×' + h + ']') : '');
        // thumbBase64 直接复用同一份 base64 — 前端 <img> 用 CSS 把它显示成 56×56 缩略图,
        // 浏览器原生处理 down-scaling。即使 base64 是几百 KB 也只是占内存,渲染秒出。
        ctx.sendToPanel('posterCaptureFromPSResult', {
            success: true,
            slot: slot,
            uploadKey: uploadKey || null,
            name: name,
            base64: finalBase64,
            thumbBase64: finalBase64
        });
        ctx.logToPanel('[海报] 已抓取选区: ' + name, 'success');
    } catch (e) {
        ctx.sendToPanel('posterCaptureFromPSResult', {
            success: false,
            slot: slot,
            uploadKey: uploadKey || null,
            error: e.message || String(e)
        });
        ctx.logToPanel('[海报] 抓取失败: ' + (e.message || e), 'error');
    }
}, { tileId: 'poster' });

// ============================================================
//  posterGenerate — 真正调 GPT 生成多页海报,然后建新文档贴回
//
//  data: {
//    jobs: [{ pageNum, refs:[{name,base64}], prompt }, ...],
//    multiplier: 1.5 / 2 / 3,
//    posterW: 3840, posterH: 2160,
//    category: 'commission' | 'portfolio'
//  }
// ============================================================
HostAPI.registerAction('posterGenerate', async function(data, ctx) {
    data = data || {};
    var jobs = [];
    var gptModel = 'gpt-image-2';
    var gptSize = '4K';
    var provider = 'aji';
    var _posterDocName = '';
    var _posterDocPath = '';
    var _posterDocId = null;
    var posterJobStates = [];
    var activeRollPromises = [];

    function getPosterTaskCardId(job) {
        return job && (job.taskCardId || job.convTaskId) || '';
    }

    function getPosterJobState(job) {
        var taskCardId = getPosterTaskCardId(job);
        if (!taskCardId) return null;
        for (var i = 0; i < posterJobStates.length; i++) {
            if (posterJobStates[i].taskCardId === taskCardId) return posterJobStates[i];
        }
        var state = {
            job: job,
            taskCardId: taskCardId,
            apiDispatched: false,
            apiOutcome: 'not_dispatched',
            receiptSent: false,
            base64: null,
            error: '',
            errorCategory: ''
        };
        posterJobStates.push(state);
        return state;
    }

    function completePosterJob(job, extra) {
        var taskCardId = getPosterTaskCardId(job);
        if (!taskCardId) return;
        var state = getPosterJobState(job);
        ctx.sendTaskCompleteOnce(taskCardId, Object.assign({
            taskId: taskCardId,
            successCount: 0,
            generatedCount: 0,
            returnedCount: 0,
            pendingCount: 0,
            failCount: 0,
            batchSize: 1,
            provider: provider,
            engine: 'poster',
            model: gptModel,
            size: gptSize,
            docName: _posterDocName,
            docPath: _posterDocPath,
            docId: _posterDocId,
            error_category: null
        }, extra || {}));
        if (state) state.receiptSent = true;
    }

    function tryCompletePosterJob(job, extra) {
        try {
            completePosterJob(job, extra);
            return true;
        } catch (receiptErr) {
            try { ctx.logToPanel('[海报] 任务卡收口失败: ' + ((receiptErr && receiptErr.message) || receiptErr), 'error'); } catch (_) {}
            return false;
        }
    }

    function closeUnfinishedPosterJobs(error, errorCategory) {
        for (var i = 0; i < posterJobStates.length; i++) {
            var state = posterJobStates[i];
            if (!state || state.receiptSent) continue;
            var extra;
            if (state.apiOutcome === 'success') {
                extra = {
                    successCount: 1,
                    generatedCount: 1,
                    failCount: 0,
                    error_category: null
                };
            } else if (state.apiOutcome === 'failure') {
                extra = {
                    failCount: 1,
                    error: state.error || error,
                    error_category: state.errorCategory || 'poster.api.request_fail'
                };
            } else {
                // 尚未调用图像 API 的预检/缓存/上传/主流程异常只关闭卡片，不记消费。
                extra = {
                    failCount: 0,
                    error: state.error || error,
                    error_category: state.errorCategory || errorCategory || 'poster.flow.fatal'
                };
            }
            tryCompletePosterJob(state.job, extra);
        }
    }

    try {
        jobs = Array.isArray(data && data.jobs) ? data.jobs : [];
        var multiplier = (data && data.multiplier) || 1.5;
        var posterW = (data && data.posterW) || 3840;
        var posterH = (data && data.posterH) || 2160;
        gptModel = (data && data.gptModel) || 'gpt-image-2';
        gptSize = (data && data.gptSize) || '4K';
        var gptAspect = (data && data.gptAspect) || '16:9';
        // 服务通道:'aji'(默认) 或 'grs';GRS 流要先把参考图上传换 URL
        provider = (data && data.provider) || 'aji';
        if (provider !== 'aji' && provider !== 'grs') provider = 'aji';

        jobs.forEach(function(job) { getPosterJobState(job); });

        // 当前文档信息: 页文件夹挂到当前文档的项目文件夹下(没开文档 → 退回老平铺)
        try {
            var _pdoc = app.activeDocument;
            if (_pdoc) {
                _posterDocId = _pdoc.id;
                _posterDocName = _pdoc.name || '';
                try { _posterDocPath = _pdoc.path ? String(_pdoc.path) : ''; } catch(_pp) {}
            }
        } catch(_pe) {}

        // API 配置由前端传入
        var apiKey = data && data.apiKey;
        var apiUrl = data && data.apiUrl;
        if (!apiKey || !apiUrl) {
            jobs.forEach(function(job) {
                tryCompletePosterJob(job, {
                    error: '前端未传入 API Key/URL',
                    error_category: 'poster.config.missing_connection'
                });
            });
            ctx.sendToPanel('posterGenerateResult', { success: false, error: '前端未传入 API Key/URL' });
            return;
        }
        if (!jobs.length) {
            ctx.sendToPanel('posterGenerateResult', { success: false, error: '没有可生成的页' });
            return;
        }

        var newCanvasW = Math.round(posterW * multiplier);
        var newCanvasH = Math.round(posterH * multiplier);

        var completedPages = 0;
        var failedPages = [];
        var firstErr = null;

        // 按 pageNum 分组(每个 page 内可能有多个 roll)
        var pageGroups = {};
        var pageOrder = [];
        for (var ji = 0; ji < jobs.length; ji++) {
            var pn = jobs[ji].pageNum;
            if (!pageGroups[pn]) { pageGroups[pn] = []; pageOrder.push(pn); }
            pageGroups[pn].push(jobs[ji]);
        }

        var totalPages = pageOrder.length;
        for (var pgi = 0; pgi < pageOrder.length; pgi++) {
            var pageNum = pageOrder[pgi];
            var rollJobs = pageGroups[pageNum];
            rollJobs.sort(function(a, b) { return (a.rollIdx || 1) - (b.rollIdx || 1); });

            // 该页的 run folder — 走标准 image_cache 缓存(和单图生成一致)
            // 一个文件夹收纳:该页所有参考图(input_NNN.png) + 该页所有 roll 输出(output_NNN.png) + 提示词(prompt.txt)
            // 缓存重构: 挂到当前文档的项目文件夹下, 叶子名 "海报_P页码_..."
            var pageRunFolder = null;
            var pageRunPath = '';
            var _pageStartTs = Date.now();
            try {
                pageRunFolder = await ctx.createImageCacheRunFolder({
                    engine: 'poster',
                    taskId: rollJobs[0].convTaskId || ('p' + pageNum),
                    label: '海报_P' + pageNum,
                    docName: _posterDocName, docPath: _posterDocPath, docId: _posterDocId
                });
                pageRunPath = (pageRunFolder && (pageRunFolder.wcRunPath || pageRunFolder.name)) || '';
            } catch (rfErr) {
                ctx.logToPanel('[海报] 创建缓存文件夹失败(不致命): ' + (rfErr.message || rfErr), 'warn');
            }

            // 该页的所有参考图存为 input_001..input_NNN(同页所有 roll 共享同一份输入)
            if (pageRunFolder) {
                var refsForCache = rollJobs[0].refs || [];
                for (var rci = 0; rci < refsForCache.length; rci++) {
                    var rcRef = refsForCache[rci];
                    if (rcRef && rcRef.base64) {
                        try { await ctx.saveImageToRunFolder(pageRunFolder, 'input', rcRef.base64, rci + 1); } catch (_) {}
                    }
                }
                // prompt 也存上(用第一个 job 的 prompt,所有 roll 同 prompt)
                try { await ctx.savePromptTxtToRunFolder(pageRunFolder, rollJobs[0].prompt || ''); } catch (_) {}
            }

            // GRS 流:把该页所有参考图上传到临时图床换 URL(同页所有 roll 共享同一组 URL,只传一次)
            var pageRefUrls = null;   // 仅 GRS 流用
            if (provider === 'grs') {
                ctx.sendToPanel('posterGenerateProgress', {
                    msg: '第 ' + (pgi + 1) + '/' + totalPages + ' 页:正在上传 ' + (rollJobs[0].refs || []).length + ' 张参考图…',
                    kind: 'info'
                });
                try {
                    pageRefUrls = await _uploadRefsToTempServer(rollJobs[0].refs || [], ctx);
                } catch (upErr) {
                    var upMsg = '参考图上传失败: ' + (upErr.message || upErr);
                    ctx.logToPanel('[海报] ' + upMsg, 'error');
                    failedPages.push({ pageNum: pageNum, error: upMsg });
                    if (!firstErr) firstErr = upMsg;
                    // 参考图上传失败时尚未发出图像请求，只结束已登记的任务卡，不计消费。
                    rollJobs.forEach(function(job) {
                        tryCompletePosterJob(job, { error: upMsg, error_category: 'poster.input.reference_upload_fail' });
                    });
                    continue;   // 跳过本页
                }
            }

            ctx.sendToPanel('posterGenerateProgress', {
                msg: '第 ' + (pgi + 1) + '/' + totalPages + ' 页:并发调用 ' + rollJobs.length + ' 个 GPT-Image 请求…',
                kind: 'info'
            });

            // 同页 N 个 roll 并发跑(共享 convTaskId 让对话气泡自动合并)
            // 每 roll 各自 callAiApi,Promise.allSettled 等齐
            var pageRefUrlsForClosure = pageRefUrls;   // 闭包捕获
            var rollPromises = rollJobs.map(function(job) {
                var state = getPosterJobState(job);
                var convTaskId = '';
                var taskCardId = getPosterTaskCardId(job);
                return Promise.resolve().then(function() {
                    if (!job) throw new Error('海报 roll 参数为空');
                    convTaskId = job.convTaskId || taskCardId;
                    if (!convTaskId) throw new Error('海报 roll 缺少任务 ID');
                    ctx.g_taskEarlyStop[convTaskId] = false;
                    // 海报不贴回 PS，但仍记录发起它的原文档，生成记录和项目金额才能正确归组。
                    var _posterArch = {
                        id: convTaskId + '_' + Date.now(),
                        batchId: convTaskId,
                        workflow: 'poster',
                        prompt: job.prompt,
                        model: gptModel,
                        provider: provider,
                        size: gptSize,
                        aspectRatio: gptAspect,
                        context: { docId: _posterDocId, docName: _posterDocName, docPath: _posterDocPath, selection: null, antiMode: 0, layerType: 'smartObject', groupName: null },
                        extras: { pageNum: job.pageNum, rollIdx: job.rollIdx }
                    };
                    var _posterCb = function(b64, st, err) { return ctx.archiveToRecycleBin(_posterArch, b64, st, err); };
                    var apiPromise;
                    if (provider === 'grs') {
                        // GRS 流:走 URL 数组,base64 不传
                        // 第 0 个 URL 当 mainImage,其他当 extras(逻辑跟 AJI 一样,只是载体从 base64 换成 URL)
                        apiPromise = ctx.callAiApi(
                            apiKey, job.prompt, null, gptSize,
                            3600, apiUrl, null,
                            gptModel, 'grs', convTaskId, gptAspect,
                            // 第 13 个参数:GRS 流的 URL 数组(挂在 options 里) + archiveCallback
                            { grsUrls: pageRefUrlsForClosure || [], archiveCallback: _posterCb }
                        );
                    } else {
                        // AJI 流:走 base64
                        var inputBase64 = job.refs && job.refs[0] && job.refs[0].base64;
                        var extras = (job.refs || []).slice(1).map(function(r) { return r.base64; }).filter(Boolean);
                        apiPromise = ctx.callAiApi(
                            apiKey, job.prompt, inputBase64, gptSize,
                            3600, apiUrl, extras,
                            gptModel, 'aji', convTaskId, gptAspect,
                            { archiveCallback: _posterCb }
                        );
                    }
                    if (state) state.apiDispatched = true;
                    return apiPromise;
                }).then(function(b64) {
                    if (!b64) throw new Error('GPT 返回空内容');
                    if (state) {
                        state.apiOutcome = 'success';
                        state.base64 = b64;
                    }
                    // 上报任务卡:这一卡成功
                    tryCompletePosterJob(job, {
                        successCount: 1,
                        generatedCount: 1,
                        failCount: 0,
                        error_category: null
                    });
                    return { ok: true, base64: b64, rollIdx: job.rollIdx, taskCardId: taskCardId };
                }).catch(function(err) {
                    var emsg = (err && err.message) ? err.message : String(err);
                    if (state && state.apiOutcome === 'success') {
                        // API 结果已经拿到后，后续本地回执异常不能倒改成一次 API 失败。
                        tryCompletePosterJob(job, {
                            successCount: 1,
                            generatedCount: 1,
                            failCount: 0,
                            error_category: null
                        });
                        return { ok: true, base64: state.base64, rollIdx: job && job.rollIdx, taskCardId: taskCardId };
                    }
                    // callAiApi 内部仍有少量联网前守门错误，不能把它们记成一次付费 API 失败。
                    var failedBeforeApi = (err && err.requestAttempted === false) || !state || !state.apiDispatched || /提示词为空|构造请求体失败|服务器未校验/.test(emsg);
                    if (state) {
                        state.apiOutcome = failedBeforeApi ? 'not_dispatched' : 'failure';
                        state.error = emsg;
                        state.errorCategory = failedBeforeApi ? 'poster.preflight.roll_setup_fail' : 'poster.api.request_fail';
                    }
                    try { ctx.logToPanel('[海报] P' + (job && job.pageNum) + ' R' + (job && job.rollIdx) + ' 失败: ' + emsg, 'error'); } catch (_) {}
                    tryCompletePosterJob(job, {
                        failCount: failedBeforeApi ? 0 : 1,
                        error: emsg,
                        error_category: failedBeforeApi ? 'poster.preflight.roll_setup_fail' : 'poster.api.request_fail'
                    });
                    return { ok: false, error: emsg, rollIdx: job && job.rollIdx, taskCardId: taskCardId };
                });
            });

            activeRollPromises = rollPromises.slice();
            var settled = await Promise.all(rollPromises);   // 全部 settled(已用 catch 转换)
            activeRollPromises = [];
            var rollResults = [];
            for (var si = 0; si < settled.length; si++) {
                var s = settled[si];
                if (s.ok) {
                    rollResults.push({ base64: s.base64, rollIdx: s.rollIdx });
                } else {
                    failedPages.push({ pageNum: pageNum, rollIdx: s.rollIdx, error: s.error });
                    if (!firstErr) firstErr = s.error;
                }
            }

            // 把每张 GPT 输出存进该页的 run folder(output_001.png ~ output_NNN.png)
            if (pageRunFolder) {
                for (var oi = 0; oi < rollResults.length; oi++) {
                    try {
                        await ctx.saveImageToRunFolder(pageRunFolder, 'output', rollResults[oi].base64, oi + 1);
                    } catch (_) {}
                }
                // 证据日志(指纹+签章链): 异步写, 不挡建文档
                evidenceLog.appendEvidence({
                    runFolder: pageRunFolder, runPath: pageRunPath,
                    taskId: rollJobs[0].convTaskId || ('p' + pageNum),
                    startTs: _pageStartTs, endTs: Date.now(),
                    engine: 'poster', model: gptModel, source: provider,
                    docName: _posterDocName,
                    prompt: rollJobs[0].prompt || '',
                    inputs: (rollJobs[0].refs || []).map(function(r) { return r && r.base64; }).filter(Boolean),
                    outputs: rollResults.map(function(r) { return r.base64; })
                }).then((function(pn) { return function(evRes) {
                    if (evRes && evRes.ok) ctx.logToPanel('[证据日志] P' + pn + ' 链号#' + evRes.seq, 'info');
                    else ctx.logToPanel('[证据日志] P' + pn + ' 写入失败(不影响生成): ' + ((evRes && evRes.error) || '?'), 'warn');
                }; })(pageNum));
            }

            if (rollResults.length === 0) {
                ctx.sendToPanel('posterGenerateProgress', {
                    msg: '第 ' + (pgi + 1) + '/' + totalPages + ' 页:全部 roll 失败,跳过',
                    kind: 'err'
                });
                continue;
            }

            ctx.sendToPanel('posterGenerateProgress', {
                msg: '第 ' + (pgi + 1) + '/' + totalPages + ' 页:' + rollResults.length + '/' + rollJobs.length + ' 张就绪,正在创建 PS 文档…',
                kind: 'info'
            });

            try {
                await _createPosterDoc({
                    rolls: rollResults,
                    refs: rollJobs[0].refs,
                    pageNum: pageNum,
                    canvasW: newCanvasW,
                    canvasH: newCanvasH,
                    category: data.category
                }, ctx, rollJobs[0].convTaskId || ('poster-page-' + pageNum));
                completedPages++;
            } catch (docErr) {
                var docMsg = (docErr && docErr.message) ? docErr.message : String(docErr);
                ctx.logToPanel('[海报] 第 ' + pageNum + ' 页贴文档失败: ' + docMsg, 'error');
                failedPages.push({ pageNum: pageNum, error: '贴文档失败: ' + docMsg });
                if (!firstErr) firstErr = docMsg;
            }
        }

        // 正常流程也做一次兜底扫描，任何遗漏的 roll 都必须结束任务卡。
        closeUnfinishedPosterJobs(firstErr || '海报任务未执行', 'poster.flow.unfinished');
        ctx.sendToPanel('posterGenerateResult', {
            success: completedPages > 0,
            completedPages: completedPages,
            failedPages: failedPages,
            error: completedPages === 0 ? (firstErr || '所有页生成失败') : undefined
        });
    } catch (outerErr) {
        var emsg = (outerErr && outerErr.message) ? outerErr.message : (outerErr ? String(outerErr) : '未知错误');
        // 极端情况下 Promise.all 自身被打断，先等已经启动的请求各自结算，避免零消费兜底抢先锁死任务卡。
        if (activeRollPromises.length) {
            try {
                await Promise.all(activeRollPromises.map(function(p) {
                    return Promise.resolve(p).catch(function() { return null; });
                }));
            } catch (_) {}
            activeRollPromises = [];
        }
        closeUnfinishedPosterJobs(emsg, 'poster.flow.fatal');
        try { ctx.logToPanel('[海报] 生成主流程异常: ' + emsg, 'error'); } catch (_) {}
        try { ctx.sendToPanel('posterGenerateResult', { success: false, error: emsg }); } catch (_) {}
    }
}, { tileId: 'poster' });

// ============================================================
//  创建一个新 PS 文档,放入 N 张 GPT 海报(多 roll) + 用户原图
//
//  opts.rolls = [{ base64, rollIdx }, ...]  N 张 GPT 输出
//  opts.refs  = [{ base64, name }, ...]     该页用到的所有原图
// ============================================================
async function _createPosterDoc(opts, ctx, taskId) {
    var rolls = opts.rolls || [];
    if (!rolls.length && opts.gptBase64) {
        // 兼容旧调用(单张)
        rolls = [{ base64: opts.gptBase64, rollIdx: 1 }];
    }
    if (!rolls.length) throw new Error('没有可贴的 GPT 海报');

    var refs = opts.refs || [];
    var canvasW = opts.canvasW;
    var canvasH = opts.canvasH;
    var pageNum = opts.pageNum || 1;
    var docName = '海报排版_P' + pageNum + '_' + Date.now().toString(36).slice(-6);

    // ============================================================
    // 1. 临时文件落盘 — 把每张 GPT roll 和每张原图写到 tmp 目录
    //    注意:base64 解码不在 modal scope 内,可能很慢,放在 modal 之外
    // ============================================================
    var tmp = await fs.getTemporaryFolder();
    var ts = Date.now();

    var rollFiles = [];
    for (var ri = 0; ri < rolls.length; ri++) {
        var r = rolls[ri];
        var rollFile = await tmp.createFile('poster_gpt_' + ts + '_r' + r.rollIdx + '.png', { overwrite: true });
        await rollFile.write(_b64ToArrayBuffer(r.base64), { format: storage.formats.binary });
        rollFiles.push({ file: rollFile, rollIdx: r.rollIdx });
    }

    var refFiles = [];
    for (var rfi2 = 0; rfi2 < refs.length; rfi2++) {
        var rf2 = refs[rfi2];
        if (!rf2 || !rf2.base64) continue;
        try {
            var rfFile = await tmp.createFile('poster_ref_' + ts + '_' + rfi2 + '.png', { overwrite: true });
            await rfFile.write(_b64ToArrayBuffer(rf2.base64), { format: storage.formats.binary });
            refFiles.push({ file: rfFile, name: rf2.name || ('原图_' + (rfi2 + 1)) });
        } catch (_) {}
    }

    // ============================================================
    // 2. modal scope 内:造文档 + 置入所有图层
    //    app.createDocument 需要 modal scope(实际报错验证),所以整个流程
    //    包在一个 executeAsModal 里。每张图独立 try/catch — 单张失败不影响其他。
    //    避免 batchPlay make document 的原因:它依赖机器上的自定义预设名,
    //    大多数用户没有 'PSCustomPreset' → 失败。
    // ============================================================
    var newDocId = null;
    var createErr = null;

    if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop 全局操作锁不可用');
    await ctx.acquirePSLock(async function() {
    await core.executeAsModal(async function() {
        // --- 造新文档 ---
        try {
            var newDoc = await app.createDocument({
                width: canvasW,
                height: canvasH,
                resolution: 72,
                mode: 'RGBColorMode',
                fill: 'white',
                name: docName
            });
            if (!newDoc) {
                createErr = 'app.createDocument 返回空';
                return;
            }
            newDocId = newDoc.id;
        } catch (e) {
            createErr = e.message || String(e);
            return;
        }

        // --- 显式切到新文档(防止后续 placeEvent 落到错误文档上) ---
        try {
            await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: newDocId }] }], {});
        } catch (_) {}

        // --- 置入 GPT 海报 roll(只有 R1 默认可见,多 roll 时其他隐藏) ---
        for (var gi = 0; gi < rollFiles.length; gi++) {
            var rfEntryGpt = rollFiles[gi];
            try {
                var gptToken = await fs.createSessionToken(rfEntryGpt.file);
                await app.batchPlay([{
                    _obj: 'placeEvent',
                    null: { _path: gptToken, _kind: 'local' },
                    freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' }
                }], {});

                // 拉伸到画布:读 layer bounds → 1) 用百分比缩放(中心锚点) 2) 平移到画布原点
                // (placeEvent 默认居中放置图层,中心锚点放大后图仍居中,但若 GPT 出图比例
                //  和画布略不同,边缘会有微差 → 再平移一次让 left/top 精确归零)
                var bRes = await app.batchPlay([{
                    _obj: 'get',
                    _target: [{ _property: 'bounds' }, { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
                }], {});
                var b = bRes && bRes[0] && bRes[0].bounds;
                if (b) {
                    var bL = b.left && b.left._value !== undefined ? b.left._value : b.left;
                    var bR = b.right && b.right._value !== undefined ? b.right._value : b.right;
                    var bT = b.top && b.top._value !== undefined ? b.top._value : b.top;
                    var bB = b.bottom && b.bottom._value !== undefined ? b.bottom._value : b.bottom;
                    var curW = bR - bL;
                    var curH = bB - bT;
                    if (curW > 0 && curH > 0) {
                        // 步骤 1:中心锚点缩放(图当前在画布中心,中心放大后还是居中)
                        await app.batchPlay([{
                            _obj: 'transform',
                            _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                            freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
                            width:  { _unit: 'percentUnit', _value: (canvasW / curW) * 100 },
                            height: { _unit: 'percentUnit', _value: (canvasH / curH) * 100 },
                            interfaceIconFrameDimmed: { _enum: 'interpolationType', _value: 'bicubicAutomatic' }
                        }], {});

                        // 步骤 2:重新读 bounds → 平移让左上对齐画布原点(消除小数偏差)
                        var bRes2 = await app.batchPlay([{
                            _obj: 'get',
                            _target: [{ _property: 'bounds' }, { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
                        }], {});
                        var b2 = bRes2 && bRes2[0] && bRes2[0].bounds;
                        if (b2) {
                            var b2L = b2.left && b2.left._value !== undefined ? b2.left._value : b2.left;
                            var b2T = b2.top && b2.top._value !== undefined ? b2.top._value : b2.top;
                            var dx = -b2L;
                            var dy = -b2T;
                            if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
                                try {
                                    await app.batchPlay([{
                                        _obj: 'move',
                                        _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                                        to: {
                                            _obj: 'offset',
                                            horizontal: { _unit: 'pixelsUnit', _value: dx },
                                            vertical:   { _unit: 'pixelsUnit', _value: dy }
                                        }
                                    }], {});
                                } catch (_) {}
                            }
                        }
                    }
                }

                // 重命名
                var gptLayerName = rollFiles.length > 1 ? ('GPT 海报 R' + rfEntryGpt.rollIdx) : 'GPT 海报底图';
                try {
                    await app.batchPlay([{
                        _obj: 'set',
                        _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                        to: { _obj: 'layer', name: gptLayerName }
                    }], {});
                } catch (_) {}

                // 多 roll 时除 R1 外默认隐藏
                if (rollFiles.length > 1 && gi > 0) {
                    try {
                        await app.batchPlay([{ _obj: 'hide', null: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }] }], {});
                    } catch (_) {}
                }
            } catch (geGpt) {
                // 这一张失败不影响其他 — 但要日志,否则前端无法诊断
                try {
                    if (typeof logToPanel === 'function') {
                        logToPanel('[海报] 置入 GPT roll R' + rfEntryGpt.rollIdx + ' 失败: ' + (geGpt.message || geGpt), 'warn');
                    }
                } catch (_) {}
            }
        }

        // --- 置入原图(都默认隐藏,用户按需点开手动对齐参考) ---
        for (var rj = 0; rj < refFiles.length; rj++) {
            var rfEntryRef = refFiles[rj];
            try {
                var refToken = await fs.createSessionToken(rfEntryRef.file);
                await app.batchPlay([{
                    _obj: 'placeEvent',
                    null: { _path: refToken, _kind: 'local' },
                    freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' }
                }], {});
                try {
                    await app.batchPlay([{
                        _obj: 'set',
                        _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                        to: { _obj: 'layer', name: rfEntryRef.name }
                    }], {});
                } catch (_) {}
                try {
                    await app.batchPlay([{ _obj: 'hide', null: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }] }], {});
                } catch (_) {}
            } catch (geRef) {
                try {
                    if (typeof logToPanel === 'function') {
                        logToPanel('[海报] 置入原图 ' + rfEntryRef.name + ' 失败: ' + (geRef.message || geRef), 'warn');
                    }
                } catch (_) {}
            }
        }
    }, { commandName: '海报排版·新建项目' });
    }, taskId);

    // 造文档阶段失败 → 抛出来让外层 posterGenerate 上报到前端
    if (createErr) {
        throw new Error('创建 PS 文档失败: ' + createErr);
    }
}

// ============================================================
//  内部:从 host storage 读字段(兼容 JSON 字符串包装)
// ============================================================
function _readStorageValue(storage, key) {
    var v = storage[key];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch (_) {}
    }
    return v;
}

// ============================================================
//  posterAutofill — 调用作者部署的 deepseek 代理,根据用户文案自动生成填表 JSON
//  data: { mode: 'commission'|'portfolio', userText: '...' }
//  返回: posterAutofillResult { success, parsed?: {selections,inputs}, error? }
// ============================================================
HostAPI.registerAction('posterAutofill', async function(data, ctx) {
    var mode = data && data.mode;
    var userText = data && data.userText;
    if (mode !== 'commission' && mode !== 'portfolio') {
        ctx.sendToPanel('posterAutofillResult', { success: false, error: 'mode 不合法' });
        return;
    }
    if (!userText || !userText.trim()) {
        ctx.sendToPanel('posterAutofillResult', { success: false, error: '请先输入待解析的文本' });
        return;
    }

    var controller = new AbortController();
    var timeoutId = setTimeout(function() { try { controller.abort(); } catch(_){} }, 200 * 1000);

    try {
        var deviceId = _readDeviceId(ctx);
        var bodyObj = { mode: mode, userText: userText, deviceId: deviceId };
        var bodyStr = JSON.stringify(bodyObj);
        var sigInfo = _signBody(bodyStr);
        var resp = await serverConfig.fetchApi(POSTER_AUTOFILL_PROXY_PATH, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-WC-Ts': sigInfo.ts,
                'X-WC-Sig': sigInfo.sig
            },
            body: bodyStr,
            signal: controller.signal
        });
        var raw = await resp.text();
        var json = null;
        try { json = JSON.parse(raw); } catch(_){}
        if (!resp.ok || !json) {
            var errMsg = (json && json.error) || ('HTTP ' + resp.status);
            ctx.sendToPanel('posterAutofillResult', { success: false, error: errMsg });
            return;
        }
        if (!json.success || !json.content) {
            ctx.sendToPanel('posterAutofillResult', { success: false, error: json.error || '返回格式异常' });
            return;
        }
        // 解析模型返回的 JSON 字符串(模型理论上只返回 JSON,但有时会带 markdown 围栏)
        var contentStr = String(json.content || '').trim();
        // 去掉可能的 ```json ... ``` 围栏
        if (contentStr.indexOf('```') === 0) {
            contentStr = contentStr.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        }
        // 提取第一个 { 到最后一个 }
        var lo = contentStr.indexOf('{'), hi = contentStr.lastIndexOf('}');
        if (lo >= 0 && hi > lo) contentStr = contentStr.slice(lo, hi + 1);

        var parsed = null;
        try { parsed = JSON.parse(contentStr); }
        catch (pe) {
            ctx.sendToPanel('posterAutofillResult', { success: false, error: '模型返回的 JSON 解析失败: ' + pe.message + '\n原文: ' + contentStr.slice(0, 300) });
            return;
        }

        ctx.logToPanel('[海报·自动] 完成 (' + mode + ', 剩余 ' + (json.remaining || 0) + ' 次)', 'success');
        ctx.sendToPanel('posterAutofillResult', { success: true, parsed: parsed });
    } catch (e) {
        var msg = (e && e.name === 'AbortError') ? '请求超时' : (e && e.message || String(e));
        ctx.logToPanel('[海报·自动] 失败: ' + msg, 'error');
        ctx.sendToPanel('posterAutofillResult', { success: false, error: msg });
    } finally {
        clearTimeout(timeoutId);
    }
}, { tileId: 'poster' });

// ============================================================
//  posterPromptsLoad / Save / ResetCategory
//
//  数据文件:dataFolder/poster_prompts.json
//  备份文件:dataFolder/poster_prompts.bak.json
//
//  设计:
//    - 出厂默认在 prompts.js 的 _posterPromptsFactory(只读),由前端持有
//    - 用户改的存到 poster_prompts.json
//    - 加载时:用户文件存在 → 读用户文件;不存在 → 把前端传过来的 factory 写入,再读
//    - systemPrompt 永远不存到用户文件,前端合并时用 factory 的 systemPrompt
// ============================================================

var POSTER_PROMPTS_FILE = 'poster_prompts.json';
var POSTER_PROMPTS_BAK = 'poster_prompts.bak.json';

async function _readJsonFile(folder, fileName) {
    try {
        var entry = await folder.getEntry(fileName);
        if (!entry || !entry.isFile) return null;
        var text = await entry.read({ format: storage.formats.utf8 });
        if (!text) return null;
        return JSON.parse(text);
    } catch (_) {
        return null;
    }
}

async function _writeJsonFile(folder, fileName, obj) {
    var file;
    try { file = await folder.getEntry(fileName); }
    catch (_) { file = null; }
    if (!file || !file.isFile) {
        file = await folder.createFile(fileName, { overwrite: true });
    }
    await file.write(JSON.stringify(obj, null, 2), { format: storage.formats.utf8 });
}

// posterPromptsLoad
//   data: { factory: {...}  ← 前端传过来的 _posterPromptsFactory(只在没有用户文件时用作初始)
//   返回: posterPromptsLoadResult { success, data: {...用户版本... } | null, error? }
HostAPI.registerAction('posterPromptsLoad', async function(data, ctx) {
    try {
        var dataFolder = await fs.getDataFolder();
        var existing = await _readJsonFile(dataFolder, POSTER_PROMPTS_FILE);
        if (existing && typeof existing === 'object') {
            ctx.sendToPanel('posterPromptsLoadResult', { success: true, data: existing });
            return;
        }
        // 用户文件不存在 — 用前端传过来的 factory 初始化一份
        var factory = data && data.factory;
        if (!factory) {
            ctx.sendToPanel('posterPromptsLoadResult', { success: false, error: '用户预设不存在,且前端未传 factory' });
            return;
        }
        await _writeJsonFile(dataFolder, POSTER_PROMPTS_FILE, factory);
        ctx.sendToPanel('posterPromptsLoadResult', { success: true, data: factory, initialized: true });
        ctx.logToPanel('[海报·预设] 首次启动,已初始化用户预设文件', 'info');
    } catch (e) {
        ctx.sendToPanel('posterPromptsLoadResult', { success: false, error: e.message || String(e) });
    }
}, { tileId: 'poster' });

// posterPromptsSave
//   data: { data: {...完整新预设...} }
//   保存前自动备份现有文件到 poster_prompts.bak.json
//   返回: posterPromptsSaveResult { success, error? }
HostAPI.registerAction('posterPromptsSave', async function(data, ctx) {
    try {
        if (!data || !data.data || typeof data.data !== 'object') {
            ctx.sendToPanel('posterPromptsSaveResult', { success: false, error: '数据格式错误' });
            return;
        }
        var dataFolder = await fs.getDataFolder();

        // 备份现有
        var existing = await _readJsonFile(dataFolder, POSTER_PROMPTS_FILE);
        if (existing) {
            try { await _writeJsonFile(dataFolder, POSTER_PROMPTS_BAK, existing); } catch (_) {}
        }

        await _writeJsonFile(dataFolder, POSTER_PROMPTS_FILE, data.data);
        ctx.sendToPanel('posterPromptsSaveResult', { success: true });
        ctx.logToPanel('[海报·预设] 已保存(备份在 poster_prompts.bak.json)', 'success');
    } catch (e) {
        ctx.sendToPanel('posterPromptsSaveResult', { success: false, error: e.message || String(e) });
    }
}, { tileId: 'poster' });

// posterPromptsResetCategory
//   data: { category: 'commission' | 'portfolio', factoryCategory: {...} }
//     factoryCategory 是前端传的出厂某个 category 的副本
//   做法:读用户文件 → 用 factoryCategory 替换该 category → 写回
//   返回: posterPromptsResetCategoryResult { success, data?, error? }
HostAPI.registerAction('posterPromptsResetCategory', async function(data, ctx) {
    try {
        var category = data && data.category;
        var factoryCategory = data && data.factoryCategory;
        if ((category !== 'commission' && category !== 'portfolio') || !factoryCategory) {
            ctx.sendToPanel('posterPromptsResetCategoryResult', { success: false, error: '参数错误' });
            return;
        }
        var dataFolder = await fs.getDataFolder();
        var current = await _readJsonFile(dataFolder, POSTER_PROMPTS_FILE);
        if (!current || typeof current !== 'object') current = {};

        // 备份再写入
        try { await _writeJsonFile(dataFolder, POSTER_PROMPTS_BAK, current); } catch (_) {}
        current[category] = factoryCategory;
        await _writeJsonFile(dataFolder, POSTER_PROMPTS_FILE, current);

        ctx.sendToPanel('posterPromptsResetCategoryResult', { success: true, data: current });
        ctx.logToPanel('[海报·预设] 已恢复出厂: ' + category, 'success');
    } catch (e) {
        ctx.sendToPanel('posterPromptsResetCategoryResult', { success: false, error: e.message || String(e) });
    }
}, { tileId: 'poster' });

// ============================================================
//  posterReportUsage — 用户选了/取消了某个选项,前端上报到服务端做使用统计
//  data: { category, sectionId, buttonId, action: 'select'|'deselect' }
//  后端记到 usage_stats.jsonl,admin 仪表盘里看预设使用排行
//
//  失败静默(埋点不该打扰用户),所以不返回 result
// ============================================================
HostAPI.registerAction('posterReportUsage', async function(data, ctx) {
    try {
        if (!data) return;
        var deviceId = _readDeviceId(ctx);
        var bodyObj = {
            deviceId: deviceId,
            category: data.category || '',
            sectionId: data.sectionId || '',
            buttonId: data.buttonId || '',
            action: data.action || 'select'
        };
        var bodyStr = JSON.stringify(bodyObj);
        var sigInfo = _signBody(bodyStr);
        var ctrl = new AbortController();
        var to = setTimeout(function() { try { ctrl.abort(); } catch(_){} }, 5 * 1000);
        try {
            await serverConfig.fetchApi(POSTER_USAGE_PROXY_PATH, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-WC-Ts': sigInfo.ts,
                    'X-WC-Sig': sigInfo.sig
                },
                body: bodyStr,
                signal: ctrl.signal
            });
        } catch(_) {}
        clearTimeout(to);
    } catch(_) {}
}, { tileId: 'poster' });

module.exports = {};
