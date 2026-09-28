// ============================================================
//  tile-qwen21.host.js
//  「Qwen2.1 大家一起研究」后端处理器
//
//  连的是作者本机的云改图网关(QwenGateway), 不是用户的本地 ComfyUI。
//  网关地址由前端传进来(默认 http://127.0.0.1:8196 本机调试用;
//  正式走 cpolar 隧道时前端会传隧道地址)。
//
//  注册的 action:
//    qwen21Status    — 查额度/准入状态
//    qwen21Capture   — 抓当前 PS 选区 → JPEG base64
//    qwen21Submit    — 上传图 + 提示词 → 拿 job_id
//    qwen21Poll      — 查任务进度
//    qwen21PlaceBack — 把结果贴回 PS 新图层
//    qwen21History   — 我的历史记录
//    qwen21Cancel    — 取消排队
//
//  ⚠️ 上传不走 base64 塞进 JSON —— 大图会把 JS 字符串撑爆(插件里踩过这个坑)。
//     走 multipart/form-data 二进制直传。
// ============================================================

var HostAPI = require('../host/host-api.js');

var photoshop = require('photoshop');
var app = photoshop.app;

var uxpModule = require('uxp');
var storage = uxpModule.storage;
var fs = storage.localFileSystem;

var psPixels = require('../host/ps-pixels.js');
var encodePNGFromRGB = psPixels.encodePNGFromRGB;
var arrayBufferToBase64 = psPixels.arrayBufferToBase64;

var cloudService = null;
try { cloudService = require('../login-service.js'); } catch (e) { cloudService = null; }

// ============================================================
//  常量
// ============================================================
// 兜底值，必须跟前端 tile-qwen21.js 的 DEFAULT_GATEWAY 保持一致，
// 否则前端没传地址时会静默连到本机死端口。
var DEFAULT_GATEWAY = 'https://qwentest.vip.cpolar.top';

// 上传前在 PS 侧压缩：长边上限 + JPEG 质量。
// 用户说"压缩在插件内进行"，就是这个 —— 传出去的已经是压好的。
var UPLOAD_MAX_2K = 2048;
var UPLOAD_MAX_1K = 1024;
var UPLOAD_QUALITY = 92;

// 抓图分块上限（老代码教训：一次抓超大选区会 RangeError）
var CAPTURE_BLOCK = 2048;

var POLL_TIMEOUT_MS = 20000;
var SUBMIT_TIMEOUT_MS = 180000;   // 上传 + 排队提交，给足
var RESULT_TIMEOUT_MS = 120000;

// host 内存：最近一次抓取
var _lastCapture = null;   // { base64, selection, docId, docName, w, h }
// 最近一次结果（供贴回）
var _lastResult = null;    // { filePath, w, h, jobId }

// ============================================================
//  helper
// ============================================================
function _sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function _trimSlash(s) { return String(s || '').replace(/\/+$/, ''); }

function _gwUrl(gateway, path) {
    return _trimSlash(gateway || DEFAULT_GATEWAY) + path;
}

function _token() {
    // 复用云服务登录态。没登录 = 空串，网关会 404。
    try {
        if (cloudService && typeof cloudService.getAuthToken === 'function') {
            return cloudService.getAuthToken() || '';
        }
    } catch (e) {}
    return '';
}

function _email() {
    try {
        if (cloudService && typeof cloudService.getAuthEmail === 'function') {
            return cloudService.getAuthEmail() || '';
        }
    } catch (e) {}
    return '';
}

function abToBase64(buffer) { return arrayBufferToBase64(buffer); }

function base64ToU8(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var u8 = new Uint8Array(len);
    for (var i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
    return u8;
}

// 带超时的 fetch
async function _fetchTimeout(url, options, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { try { controller.abort(); } catch (_) {} }, Math.max(1000, timeoutMs || 30000));
    var opts = {};
    var src = options || {};
    for (var k in src) opts[k] = src[k];
    opts.signal = controller.signal;
    try {
        return await fetch(url, opts);
    } finally {
        clearTimeout(timer);
    }
}

// ---- UTF-8 编码 ----
// ⚠️ UXP 宿主环境没有 TextEncoder（项目里踩过这个坑，见 tile-translate.host.js）。
//    手写一份，跟 host/ai-api.js 同款。
function _strToUtf8Bytes(s) {
    s = String(s == null ? '' : s);
    var bytes = [];
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c < 0x80) {
            bytes.push(c);
        } else if (c < 0x800) {
            bytes.push(0xc0 | (c >> 6));
            bytes.push(0x80 | (c & 0x3f));
        } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
            var c2 = s.charCodeAt(i + 1);
            if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
                var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
                bytes.push(0xf0 | (cp >> 18));
                bytes.push(0x80 | ((cp >> 12) & 0x3f));
                bytes.push(0x80 | ((cp >> 6) & 0x3f));
                bytes.push(0x80 | (cp & 0x3f));
                i++;
                continue;
            }
            bytes.push(0xe0 | (c >> 12));
            bytes.push(0x80 | ((c >> 6) & 0x3f));
            bytes.push(0x80 | (c & 0x3f));
        } else {
            bytes.push(0xe0 | (c >> 12));
            bytes.push(0x80 | ((c >> 6) & 0x3f));
            bytes.push(0x80 | (c & 0x3f));
        }
    }
    return new Uint8Array(bytes);
}

// 手写 multipart（跟 host/ai-api.js 同款，UXP fetch 兼容）
// fields: { name: stringValue }
// files:  [{ name, filename, contentType, buffer(ArrayBuffer) }]
function _buildMultipart(fields, files) {
    // boundary 全 ASCII 小写数字字母，避免 UXP fetch 把 Blob.type 转小写后跟原 boundary 不一致
    var boundary = '----wcformboundary' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    var chunks = [];

    var fkeys = Object.keys(fields || {});
    for (var i = 0; i < fkeys.length; i++) {
        var k = fkeys[i], v = fields[k];
        if (v === undefined || v === null) continue;
        chunks.push(_strToUtf8Bytes(
            '--' + boundary + '\r\n' +
            'Content-Disposition: form-data; name="' + k + '"\r\n\r\n' +
            String(v) + '\r\n'));
    }

    for (var fi = 0; fi < (files || []).length; fi++) {
        var f = files[fi];
        chunks.push(_strToUtf8Bytes(
            '--' + boundary + '\r\n' +
            'Content-Disposition: form-data; name="' + f.name + '"; filename="' + (f.filename || 'file.bin') + '"\r\n' +
            'Content-Type: ' + (f.contentType || 'application/octet-stream') + '\r\n\r\n'));
        chunks.push(new Uint8Array(f.buffer));
        chunks.push(_strToUtf8Bytes('\r\n'));
    }

    chunks.push(_strToUtf8Bytes('--' + boundary + '--\r\n'));

    var totalLen = 0;
    for (var ci = 0; ci < chunks.length; ci++) totalLen += chunks[ci].length;
    var out = new Uint8Array(totalLen);
    var off = 0;
    for (var cj = 0; cj < chunks.length; cj++) { out.set(chunks[cj], off); off += chunks[cj].length; }
    return { body: out.buffer, contentType: 'multipart/form-data; boundary=' + boundary };
}

// ============================================================
//  抓选区
//
//  写法对齐项目里的成熟磁贴（tile-comfyui.host.js / tile-batch.host.js）：
//    · 调用不传参数 —— getSelectionAndImage 内部自带三档选区检测降级，
//      自己传选区反而容易传错格式
//    · 必须包在 acquirePSLock 里 —— 抓像素是 PS 全局操作
//    · 抓完 deselectAll()，否则选区虚线框会一直留在用户图上
//    · 关掉抗截断模式再抓（那是给回图用的，抓图时会污染像素）
//
//  ⚠️ 踩过的坑：ctx.g_lastSelectionRef 是**带 .value 取值器的对象**，
//     不是函数。写成 ctx.g_lastSelectionRef() 会直接抛
//     "ctx.g_lastSelectionRef is not a function"。
// ============================================================
HostAPI.registerAction('qwen21Capture', async function (data, ctx) {
    try {
        var doc = app.activeDocument;
        if (!doc) { ctx.sendToPanel('qwen21CaptureResult', { ok: false, error: '没有打开的文档' }); return; }

        ctx.logToPanel('[云Qwen] 正在抓取选区...', 'info');

        if (typeof ctx.acquirePSLock !== 'function') {
            ctx.sendToPanel('qwen21CaptureResult', { ok: false, error: 'PS 操作锁不可用，重启一下 PS' });
            return;
        }

        var bundle = await ctx.acquirePSLock(async function () {
            var savedAnti = null;
            try { savedAnti = ctx.g_antiTruncationModeRef.value; } catch (_a) {}
            var capturedDocId = null;
            var capture = null;
            try {
                // 抓图不要抗截断处理 —— 那是回图阶段的事
                try { ctx.g_antiTruncationModeRef.value = 0; } catch (_b) {}
                capture = await ctx.getSelectionAndImage();
                try { capturedDocId = app.activeDocument.id; } catch (_c) {}
                if (capture) { try { await ctx.deselectAll(); } catch (_d) {} }
            } finally {
                try { ctx.g_antiTruncationModeRef.value = savedAnti; } catch (_e) {}
            }
            return { capture: capture, docId: capturedDocId };
        }, 'qwen21-capture');

        var res = bundle && bundle.capture;

        if (!res || !res.base64) {
            // 失败原因挂在函数属性上（ps-io.js 里就是这么写的）
            var le = null;
            try {
                var fn = ctx.getSelectionAndImage;
                le = fn && fn.lastError;
            } catch (_f) {}
            ctx.sendToPanel('qwen21CaptureResult', {
                ok: false,
                error: (le && le.message) || '没抓到内容 —— 先在 PS 里用选框工具框一块区域，再点这个按钮'
            });
            return;
        }

        var b64 = res.base64;
        var s = res.selection || {};
        var w = Math.round(s.width || 0);
        var h = Math.round(s.height || 0);

        _lastCapture = {
            base64: b64,
            selection: s,
            docId: bundle.docId || (doc && doc.id) || null,
            docName: (doc && doc.name) || '',
            width: w, height: h
        };

        var kb = Math.round((b64.length * 3 / 4) / 1024);
        ctx.logToPanel('[云Qwen] 抓到 ' + w + 'x' + h + ' 约 ' + kb + ' KB', 'success');
        // 只发一份 b64。缩略图和压缩源都由前端从它派生 ——
        // 同时发 preview(data URL) 等于把同一张大图传两遍，大选区会明显卡。
        ctx.sendToPanel('qwen21CaptureResult', {
            ok: true, width: w, height: h, kb: kb, b64: b64
        });
    } catch (e) {
        ctx.logToPanel('[云Qwen] 抓取失败: ' + (e && e.message), 'error');
        ctx.sendToPanel('qwen21CaptureResult', { ok: false, error: (e && e.message) || '抓取失败' });
    }
});

// ============================================================
//  查状态
// ============================================================
HostAPI.registerAction('qwen21Status', async function (data, ctx) {
    var gateway = (data && data.gateway) || DEFAULT_GATEWAY;
    var tok = _token();
    if (!tok) {
        ctx.sendToPanel('qwen21StatusResult', { ok: false, need_login: true, error: '请先在「云服务登录」里登录' });
        return;
    }
    try {
        var resp = await _fetchTimeout(_gwUrl(gateway, '/api/status'), {
            method: 'GET',
            headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + tok }
        }, 15000);

        if (resp.status === 404) {
            ctx.sendToPanel('qwen21StatusResult', { ok: false, error: '登录态失效或不在研究名单里，请重新登录' });
            return;
        }

        var j = await resp.json();

        // ⚠️ 网关的拒绝格式是 { errno, info }，不是 { error }。
        //    这里必须把 info 映射成前端认识的 error，否则「积分不足」「名额满了」
        //    这类提示会显示成空白 —— 用户只看到"连不上"，完全不知道原因。
        if (typeof j.errno === 'number' && j.errno !== 0) {
            ctx.sendToPanel('qwen21StatusResult', {
                ok: false,
                errno: j.errno,
                need_login: j.errno === 1,
                error: j.info || '暂时不能参加'
            });
            return;
        }
        ctx.sendToPanel('qwen21StatusResult', Object.assign({ ok: true, gateway: gateway }, j));
    } catch (e) {
        ctx.sendToPanel('qwen21StatusResult', {
            ok: false,
            error: '连不上研究服务器（' + ((e && e.message) || '网络错误') + '）'
        });
    }
});

// ============================================================
//  提交任务
//  ⚠️ 压缩不在 host 做 —— host 这边拿到的只有"已经编码好的 PNG 字节"，
//     而 UXP 的 imaging.encodeImageData 要的是**原始像素数据**，喂 PNG 字节是错的。
//     项目里的成熟做法是走前端 canvas（见 tiles/tile-chat.js 的 attach 压缩）。
//     所以流程是：host 抓图 → 丢给前端压 → 前端把 JPEG base64 回传 → host 上传。
// ============================================================
HostAPI.registerAction('qwen21Submit', async function (data, ctx) {
    var gateway = (data && data.gateway) || DEFAULT_GATEWAY;
    var prompt = String((data && data.prompt) || '').trim();
    var quality = (data && data.quality) === '1k' ? '1k' : '2k';
    var jpegB64 = (data && data.jpeg_b64) || '';   // 前端压好的

    if (!prompt) { ctx.sendToPanel('qwen21SubmitResult', { ok: false, error: '提示词不能空' }); return; }
    if (!jpegB64) { ctx.sendToPanel('qwen21SubmitResult', { ok: false, error: '图片没准备好，重新抓一次' }); return; }
    var tok = _token();
    if (!tok) { ctx.sendToPanel('qwen21SubmitResult', { ok: false, need_login: true, error: '请先登录' }); return; }

    try {
        var bytes = base64ToU8(jpegB64);
        var mb = bytes.length / 1048576;

        // 网关有 15MB 上限
        if (mb > 14.5) {
            ctx.sendToPanel('qwen21SubmitResult', {
                ok: false,
                error: '压缩后还有 ' + mb.toFixed(1) + ' MB，太大了。试着选小一点的区域'
            });
            return;
        }

        ctx.logToPanel('[云Qwen] 上传中（' + mb.toFixed(1) + ' MB）...', 'info');
        ctx.sendToPanel('qwen21Progress', { phase: 'upload', mb: mb });

        // multipart 手工拼（UXP fetch 对 FormData+二进制不稳，跟项目里 GPT-Image 走同一条路）
        // 图是前端 canvas 压好的 JPEG，这里直接用它那两个字节数组。
        var form = _buildMultipart(
            { prompt: prompt, quality: quality },
            [{ name: 'image', filename: 'up.jpg', contentType: 'image/jpeg', buffer: bytes.buffer }]
        );

        var t0 = Date.now();
        var resp = await _fetchTimeout(_gwUrl(gateway, '/api/edit'), {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + tok,
                'Content-Type': form.contentType               // 含 boundary，必须用这里返回的
            },
            body: form.body
        }, SUBMIT_TIMEOUT_MS);

        if (resp.status === 404) {
            ctx.sendToPanel('qwen21SubmitResult', { ok: false, error: '登录态失效，请重新登录' });
            return;
        }
        var j = await resp.json();
        if (j.errno !== 0) {
            ctx.sendToPanel('qwen21SubmitResult', { ok: false, error: j.info || '提交被拒' });
            return;
        }

        ctx.logToPanel('[云Qwen] 已提交，上传耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒', 'success');
        ctx.sendToPanel('qwen21SubmitResult', { ok: true, job_id: j.job_id, quality: quality });
    } catch (e) {
        ctx.sendToPanel('qwen21SubmitResult', { ok: false, error: (e && e.message) || '提交失败' });
    }
});

// ============================================================
//  查进度
// ============================================================
HostAPI.registerAction('qwen21Poll', async function (data, ctx) {
    var gateway = (data && data.gateway) || DEFAULT_GATEWAY;
    var jobId = (data && data.job_id) || '';
    if (!jobId) { ctx.sendToPanel('qwen21PollResult', { ok: false, error: '缺任务号' }); return; }

    try {
        var resp = await _fetchTimeout(
            _gwUrl(gateway, '/api/job?id=' + encodeURIComponent(jobId)),
            { method: 'GET', headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + _token() } },
            POLL_TIMEOUT_MS);

        if (resp.status === 404) { ctx.sendToPanel('qwen21PollResult', { ok: false, error: '任务不存在' }); return; }
        var j = await resp.json();
        ctx.sendToPanel('qwen21PollResult', Object.assign({ ok: true, job_id: jobId }, j));
    } catch (e) {
        // 单次轮询失败不致命，前端会继续轮
        ctx.sendToPanel('qwen21PollResult', { ok: false, job_id: jobId, soft: true, error: (e && e.message) || '网络抖动' });
    }
});

// ============================================================
//  取结果 → 直接贴回 PS（照抄生成中心的回图逻辑）
// ============================================================
HostAPI.registerAction('qwen21PlaceBack', async function (data, ctx) {
    var gateway = (data && data.gateway) || DEFAULT_GATEWAY;
    var jobId = (data && data.job_id) || '';
    if (!jobId) { ctx.sendToPanel('qwen21PlaceBackResult', { ok: false, error: '缺任务号' }); return; }

    try {
        ctx.logToPanel('[云Qwen] 正在取回结果...', 'info');
        ctx.sendToPanel('qwen21Progress', { phase: 'download' });

        var resp = await _fetchTimeout(
            _gwUrl(gateway, '/api/result?id=' + encodeURIComponent(jobId)),
            { method: 'GET', headers: { 'Authorization': 'Bearer ' + _token() } },
            RESULT_TIMEOUT_MS);

        if (resp.status === 404) { ctx.sendToPanel('qwen21PlaceBackResult', { ok: false, error: '结果已过期（只留 7 天）' }); return; }
        if (!resp.ok) { ctx.sendToPanel('qwen21PlaceBackResult', { ok: false, error: '取图失败 HTTP ' + resp.status }); return; }

        var ab = await resp.arrayBuffer();
        var b64 = abToBase64(ab);
        var mb = ab.byteLength / 1048576;
        ctx.logToPanel('[云Qwen] 取回 ' + mb.toFixed(1) + ' MB，正在贴回 PS...', 'info');

        // 贴回。目标文档 = 抓图时那个文档；没记录就用当前活动文档。
        var targetDocId = _lastCapture && _lastCapture.docId;
        var targetSel = _lastCapture && _lastCapture.selection;

        if (!targetDocId) {
            var d = app.activeDocument;
            targetDocId = d ? d.id : null;
        }
        if (!targetDocId) {
            ctx.sendToPanel('qwen21PlaceBackResult', { ok: false, error: '找不到目标文档' });
            return;
        }

        // ⚠️ 必须传 'smartObject'，不能传 'normal'。
        //    ps-io.js 里非 smartObject 会走【栅格化输出】分支：
        //    先 rasterizeLayer 把图烤成像素，再缩放 —— 会被烤成低分辨率。
        //    智能对象分支则保留完整原生像素、只做非破坏性缩放，显示上一样。
        //    项目里其它磁贴（comfyui / kao / canvas / colorgrade）清一色用 smartObject。
        //    antiMode 传 0：研究项目不做抗截断，原样贴回最直观。
        await ctx.placeImageToSpecificDoc(b64, targetDocId, targetSel, 0, 'smartObject');

        _lastResult = { jobId: jobId, mb: mb };
        ctx.logToPanel('[云Qwen] 已贴回', 'success');
        if (typeof ctx.playSuccessSound === 'function') { try { ctx.playSuccessSound(); } catch (_) {} }
        ctx.sendToPanel('qwen21PlaceBackResult', { ok: true, mb: mb });
    } catch (e) {
        ctx.logToPanel('[云Qwen] 贴回失败: ' + (e && e.message), 'error');
        ctx.sendToPanel('qwen21PlaceBackResult', { ok: false, error: (e && e.message) || '贴回失败' });
    }
});

// ============================================================
//  历史 / 取消
// ============================================================
HostAPI.registerAction('qwen21History', async function (data, ctx) {
    var gateway = (data && data.gateway) || DEFAULT_GATEWAY;
    try {
        var resp = await _fetchTimeout(_gwUrl(gateway, '/api/history'), {
            method: 'GET', headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + _token() }
        }, POLL_TIMEOUT_MS);
        if (resp.status === 404) { ctx.sendToPanel('qwen21HistoryResult', { ok: false, error: '登录态失效' }); return; }
        var j = await resp.json();
        ctx.sendToPanel('qwen21HistoryResult', Object.assign({ ok: true, gateway: gateway }, j));
    } catch (e) {
        ctx.sendToPanel('qwen21HistoryResult', { ok: false, error: (e && e.message) || '取历史失败' });
    }
});

HostAPI.registerAction('qwen21Cancel', async function (data, ctx) {
    var gateway = (data && data.gateway) || DEFAULT_GATEWAY;
    var jobId = (data && data.job_id) || '';
    try {
        var resp = await _fetchTimeout(
            _gwUrl(gateway, '/api/cancel?id=' + encodeURIComponent(jobId)),
            { method: 'POST', headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + _token() } },
            POLL_TIMEOUT_MS);
        var j = resp.status === 404 ? { errno: 404, info: '任务不存在' } : await resp.json();
        ctx.sendToPanel('qwen21CancelResult', Object.assign({ ok: j.errno === 0, job_id: jobId }, j));
    } catch (e) {
        ctx.sendToPanel('qwen21CancelResult', { ok: false, error: (e && e.message) || '取消失败' });
    }
});

module.exports = {};
