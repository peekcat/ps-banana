// ============================================================
//  tile-translate.host.js
//  翻译后端处理器
//
//  翻译只走 preset-server 转发通道 /api/translate。
//  有道 AppSecret 不得进入客户端安装包；服务端补丁见 _dev/翻译代理_服务端补丁.md。
// ============================================================

var HostAPI = require('../host/host-api.js');
var serverConfig = require('../core/server-config.js');
var TRANSLATE_PROXY_PATH = '/api/translate';
var _WC_SECRET = 'wc-v6-public-default-secret-2026';   // 与服务端 wc_secret.txt 保持一致(签名用, 非机密)
var _proxyUnavailable = false;   // 服务端明确没有该路由时，本次会话不再反复探测

// 纯JS SHA-256（UXP宿主环境无TextEncoder/crypto.subtle）
function sha256(str) {
    function utf8Encode(s) {
        var bytes = [];
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            if (c < 0x80) { bytes.push(c); }
            else if (c < 0x800) { bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
            else if (c >= 0xD800 && c <= 0xDBFF) {
                var hi = c, lo = s.charCodeAt(++i);
                var cp = ((hi - 0xD800) << 10) + (lo - 0xDC00) + 0x10000;
                bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
            } else { bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)); }
        }
        return bytes;
    }
    var K = [
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];
    function rr(v,n){return((v>>>n)|(v<<(32-n)))>>>0;}
    var msg = utf8Encode(str);
    var bitLen = msg.length * 8;
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    // 64-bit big-endian bit length
    for (var bi = 56; bi >= 0; bi -= 8) msg.push((bitLen / Math.pow(2, bi)) & 0xFF);
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    for (var off = 0; off < msg.length; off += 64) {
        var W = new Array(64);
        for (var t = 0; t < 16; t++) W[t] = (msg[off+t*4]<<24)|(msg[off+t*4+1]<<16)|(msg[off+t*4+2]<<8)|msg[off+t*4+3];
        for (var t2 = 16; t2 < 64; t2++) {
            var s0 = rr(W[t2-15],7)^rr(W[t2-15],18)^(W[t2-15]>>>3);
            var s1 = rr(W[t2-2],17)^rr(W[t2-2],19)^(W[t2-2]>>>10);
            W[t2] = (W[t2-16]+s0+W[t2-7]+s1)>>>0;
        }
        var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
        for (var j = 0; j < 64; j++) {
            var S1=rr(e,6)^rr(e,11)^rr(e,25);
            var ch=(e&f)^((~e)&g);
            var temp1=(h+S1+ch+K[j]+W[j])>>>0;
            var S0=rr(a,2)^rr(a,13)^rr(a,22);
            var maj=(a&b)^(a&c)^(b&c);
            var temp2=(S0+maj)>>>0;
            h=g;g=f;f=e;e=(d+temp1)>>>0;d=c;c=b;b=a;a=(temp1+temp2)>>>0;
        }
        H[0]=(H[0]+a)>>>0;H[1]=(H[1]+b)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d)>>>0;
        H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+h)>>>0;
    }
    var hex = '';
    for (var hi = 0; hi < 8; hi++) hex += ('00000000' + H[hi].toString(16)).slice(-8);
    return hex;
}

// 超时覆盖 JSON 响应体读取；只等到响应头不算请求完成。
async function _fetchJsonWithTimeout(url, opts, timeoutMs) {
    var ctrl = new AbortController();
    var timer = setTimeout(function() { try { ctrl.abort(); } catch(_) {} }, timeoutMs || 15000);
    try {
        opts = opts ? Object.assign({}, opts) : {};
        opts.signal = ctrl.signal;
        var resp = /^https?:\/\//i.test(url)
            ? await fetch(url, opts)
            : await serverConfig.fetchApi(url, opts);
        var json = null;
        if (resp.ok) json = await resp.json();
        return { response: resp, json: json };
    } finally {
        clearTimeout(timer);
    }
}

// 走 preset-server 转发通道；成功返回译文字符串，不可用返回 null。
async function _tryProxyTranslate(text, fromLang, toLang, ctx) {
    if (_proxyUnavailable) return null;
    try {
        var bodyStr = JSON.stringify({ text: text, fromLang: fromLang, toLang: toLang });
        var ts = Math.floor(Date.now() / 1000).toString();
        var sig = sha256(ts + bodyStr + _WC_SECRET);
        var result = await _fetchJsonWithTimeout(TRANSLATE_PROXY_PATH, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-WC-Ts': ts, 'X-WC-Sig': sig },
            body: bodyStr
        }, 12000);
        var resp = result.response;
        if (resp.status === 404 || resp.status === 405) {
            // 服务端还没部署该接口 → 本会话不再反复探测
            _proxyUnavailable = true;
            return null;
        }
        if (!resp.ok) return null;
        var json = result.json;
        if (json && json.success && typeof json.text === 'string' && json.text) return json.text;
        return null;
    } catch (e) {
        // 网络异常不永久禁用，下一次仍可重试。
        return null;
    }
}

HostAPI.registerAction('youdaoTranslate', async function(data, ctx) {
    var text = data.text;
    var fromLang = data.fromLang || 'auto';
    var toLang = data.toLang || 'en';
    var translateId = data.translateId || '';  // 透传给结果,让前端按 id 路由

    // ── 通道 1: preset-server 转发(密钥在服务器) ──
    var proxied = await _tryProxyTranslate(text, fromLang, toLang, ctx);
    if (proxied) {
        ctx.sendToPanel('youdaoTranslateResult', { success: true, text: proxied, translateId: translateId });
        return;
    }
    ctx.sendToPanel('youdaoTranslateResult', {
        success: false,
        error: '翻译代理暂时不可用，请检查服务器 /api/translate 接口',
        translateId: translateId
    });
}, { tileId: 'translate' });
