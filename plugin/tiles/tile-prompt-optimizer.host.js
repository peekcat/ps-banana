// ============================================================
//  tile-prompt-optimizer.host.js
//  调用作者部署的代理服务器(无需用户配置 key)
//  端点由 core/server-config.js 统一管理
//  body: { messages, deviceId? }
//  返回: { success, content, model, remaining }
//
//  deviceId 从 host storage 的 support.deviceId 读(跟客服功能共用同一个 ID)
//  接口签名:X-WC-Ts + X-WC-Sig(sha256(ts + body + secret))
// ============================================================

var HostAPI = require('../host/host-api.js');
var serverConfig = require('../core/server-config.js');
var OPTIMIZER_PROXY_PATH = '/api/optimize';

// 跟服务端默认密钥保持一致;若服务端通过 wc_secret.txt 改了,这里也得改
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

HostAPI.registerAction('promptOptimize', async function(data, ctx) {
    var messages = data && Array.isArray(data.messages) ? data.messages : null;
    if (!messages || messages.length === 0) {
        ctx.sendToPanel('promptOptimizeResult', { success: false, error: 'messages 为空' });
        return;
    }

    ctx.logToPanel('[提示词优化] 调用代理服务... (' + messages.length + ' 条上下文)', 'info');

    var controller = new AbortController();
    // 思考模式 max_tokens=8192 在 v4-pro 上可能跑 2-4 分钟,留 5 分钟空间
    var timeoutId = setTimeout(function() { try { controller.abort(); } catch(_){} }, 320 * 1000);

    try {
        var deviceId = _readDeviceId(ctx);
        var bodyObj = { messages: messages, deviceId: deviceId };
        var bodyStr = JSON.stringify(bodyObj);
        var sigInfo = _signBody(bodyStr);
        var resp = await serverConfig.fetchApi(OPTIMIZER_PROXY_PATH, {
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

        if (!resp.ok) {
            var serverErr = (json && json.error) || ('HTTP ' + resp.status);
            // 限速错误特殊提示
            if (resp.status === 429) {
                ctx.sendToPanel('promptOptimizeResult', { success: false, error: serverErr });
            } else if (resp.status === 503) {
                ctx.sendToPanel('promptOptimizeResult', { success: false, error: '服务暂不可用: ' + serverErr });
            } else {
                ctx.sendToPanel('promptOptimizeResult', { success: false, error: serverErr });
            }
            ctx.logToPanel('[提示词优化] 失败 HTTP ' + resp.status + ': ' + serverErr, 'error');
            return;
        }

        if (!json || !json.success || !json.content) {
            ctx.sendToPanel('promptOptimizeResult', { success: false, error: (json && json.error) || '返回格式异常' });
            return;
        }

        ctx.logToPanel('[提示词优化] 完成 (' + json.content.length + ' 字, 模型 ' + (json.model || '?') +
            (typeof json.remaining === 'number' ? ', 本小时剩余 ' + json.remaining + ' 次' : '') + ')', 'success');
        ctx.sendToPanel('promptOptimizeResult', {
            success: true,
            content: json.content,
            model: json.model,
            remaining: json.remaining
        });

    } catch (e) {
        var msg = (e && e.name === 'AbortError') ? '请求超时' : (e && e.message || String(e));
        ctx.logToPanel('[提示词优化] 网络错误: ' + msg, 'error');
        ctx.sendToPanel('promptOptimizeResult', { success: false, error: '网络错误: ' + msg });
    } finally {
        clearTimeout(timeoutId);
    }
}, { tileId: 'prompt-optimizer' });

module.exports = {};
