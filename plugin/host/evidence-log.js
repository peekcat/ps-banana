// ============================================================
//  evidence-log.js —— 证据日志(生成日志_勿改.txt + _链账本.json)
//
//  每次生成完成后调 appendEvidence(), 它会:
//  1. 给每张 input/output 图算 SHA-256 指纹(图改一个像素指纹就变)
//  2. 把「任务/环境/提示词/指纹」拼成人能直接读的纯文本
//  3. 整篇盖 HMAC-SHA256 签章(改一个字签章就对不上)
//  4. 签章咬住上一条的签章(链号连续), 全局链存 image_cache/_链账本.json
//     想删掉或伪造中间任何一次, 后面所有日志链全断, 一验就穿帮
//
//  诚实边界: 这是"改了必露馅"级别, 不是数学上不可破解——
//  密钥内置在插件里, 拆插件的内行能拿到。司法场景建议配合公证/时间戳。
//
//  纯 JS 实现, 不 require 任何 Node 内置模块(UXP host 不支持)。
//  哈希 4K 多张图约几百毫秒~1秒, 调用方放在回图完成后异步做, 不挡生成。
// ============================================================

var _uxp = require('uxp');
var _lfs = _uxp.storage.localFileSystem;

var LEDGER_FILE = '_链账本.json';
var LOG_FILE = '生成日志_勿改.txt';
// 签章密钥(内置)。改这个值 = 之前所有日志验不过, 别动。
var HMAC_KEY = 'wc-evidence-hmac-v1-xiasanqi-2026';

// ---------- SHA-256 (纯 JS, 输入 Uint8Array, 输出 hex) ----------

var _K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];

function _rr(v, n) { return ((v >>> n) | (v << (32 - n))) >>> 0; }

// 核心块处理: 对 msg[offStart, offEnd) 的完整 64 字节块跑压缩函数, 就地更新 H
// (同步版/分片异步版共用, 保证摘要结果一致)
function _shaProcess(H, W, msg, offStart, offEnd) {
    for (var off = offStart; off < offEnd; off += 64) {
        for (var t = 0; t < 16; t++) {
            W[t] = (msg[off+t*4]<<24) | (msg[off+t*4+1]<<16) | (msg[off+t*4+2]<<8) | msg[off+t*4+3];
        }
        for (var t2 = 16; t2 < 64; t2++) {
            var s0 = _rr(W[t2-15],7) ^ _rr(W[t2-15],18) ^ (W[t2-15]>>>3);
            var s1 = _rr(W[t2-2],17) ^ _rr(W[t2-2],19) ^ (W[t2-2]>>>10);
            W[t2] = (W[t2-16] + s0 + W[t2-7] + s1) >>> 0;
        }
        var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
        for (var j = 0; j < 64; j++) {
            var S1 = _rr(e,6) ^ _rr(e,11) ^ _rr(e,25);
            var ch = (e & f) ^ ((~e) & g);
            var temp1 = (h + S1 + ch + _K[j] + W[j]) >>> 0;
            var S0 = _rr(a,2) ^ _rr(a,13) ^ _rr(a,22);
            var maj = (a & b) ^ (a & c) ^ (b & c);
            var temp2 = (S0 + maj) >>> 0;
            h=g; g=f; f=e; e=(d+temp1)>>>0; d=c; c=b; b=a; a=(temp1+temp2)>>>0;
        }
        H[0]=(H[0]+a)>>>0; H[1]=(H[1]+b)>>>0; H[2]=(H[2]+c)>>>0; H[3]=(H[3]+d)>>>0;
        H[4]=(H[4]+e)>>>0; H[5]=(H[5]+f)>>>0; H[6]=(H[6]+g)>>>0; H[7]=(H[7]+h)>>>0;
    }
}

// 尾块: 剩余字节 + 0x80 + 长度, 拼进小缓冲跑 _shaProcess
function _shaTail(H, W, input, totalLen) {
    var fullBlocks = totalLen >> 6;
    var rem = totalLen - (fullBlocks << 6);
    var bitLenHi = Math.floor(totalLen / 0x20000000);
    var bitLenLo = (totalLen << 3) >>> 0;
    var padded = ((rem + 8) >> 6 << 6) + 64;
    var tail = new Uint8Array(padded);
    tail.set(input.subarray(fullBlocks << 6));
    tail[rem] = 0x80;
    tail[padded-8] = (bitLenHi >>> 24) & 0xFF;
    tail[padded-7] = (bitLenHi >>> 16) & 0xFF;
    tail[padded-6] = (bitLenHi >>> 8) & 0xFF;
    tail[padded-5] = bitLenHi & 0xFF;
    tail[padded-4] = (bitLenLo >>> 24) & 0xFF;
    tail[padded-3] = (bitLenLo >>> 16) & 0xFF;
    tail[padded-2] = (bitLenLo >>> 8) & 0xFF;
    tail[padded-1] = bitLenLo & 0xFF;
    _shaProcess(H, W, tail, 0, padded);
}

function _shaInitH() {
    return [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
}

function _shaHexFromH(H) {
    var out = new Uint8Array(32);
    for (var k = 0; k < 8; k++) {
        out[k*4]   = (H[k] >>> 24) & 0xFF;
        out[k*4+1] = (H[k] >>> 16) & 0xFF;
        out[k*4+2] = (H[k] >>> 8) & 0xFF;
        out[k*4+3] = H[k] & 0xFF;
    }
    return out;
}

// 同步版(小输入用: HMAC 的日志正文等)
function _sha256Bytes(input) {
    var H = _shaInitH();
    var W = new Array(64);
    _shaProcess(H, W, input, 0, (input.length >> 6) << 6);
    _shaTail(H, W, input, input.length);
    return _shaHexFromH(H);
}

function _bytesToHex(bytes) {
    var hex = '';
    for (var i = 0; i < bytes.length; i++) hex += ('0' + bytes[i].toString(16)).slice(-2);
    return hex;
}

function _utf8Bytes(str) {
    var s = String(str);
    var bytes = [];
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c < 0x80) bytes.push(c);
        else if (c < 0x800) bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
        else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
            var lo = s.charCodeAt(++i);
            var cp = ((c - 0xD800) << 10) + (lo - 0xDC00) + 0x10000;
            bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
        } else bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return new Uint8Array(bytes);
}

// base64 → Uint8Array (不走 ArrayBuffer 中转, 图大时省一次拷贝)
function _b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// 字符串或 Uint8Array → SHA-256 hex (同步, 小输入用)
function sha256Hex(input) {
    var bytes = (input instanceof Uint8Array) ? input : _utf8Bytes(input);
    return _bytesToHex(_sha256Bytes(bytes));
}

// base64 图 → SHA-256 hex (同步版, 保留给外部小图调用)
function sha256HexOfBase64(b64) {
    return _bytesToHex(_sha256Bytes(_b64ToBytes(b64)));
}

// ★分片异步版: 大图指纹用这个 — 每处理 CHUNK 字节让出一次事件循环,
// 修复 v6.4.7 的卡顿: 4K 图一次性同步算 SHA 会把 UXP 单线程堵住几百毫秒~1秒,
// 生成完成瞬间面板/PS交互全冻。分片后单次占用 <20ms, 肉眼无感。
var _SHA_CHUNK = 512 * 1024;   // 每片 512KB(约 8000 个块, ~10-15ms)
function sha256HexOfBase64Async(b64) {
    return new Promise(function(resolve, reject) {
        var input;
        try { input = _b64ToBytes(b64); } catch (e) { reject(e); return; }
        var H = _shaInitH();
        var W = new Array(64);
        var fullEnd = (input.length >> 6) << 6;   // 完整块边界
        var pos = 0;
        function step() {
            try {
                var end = Math.min(pos + _SHA_CHUNK, fullEnd);
                _shaProcess(H, W, input, pos, end);
                pos = end;
                if (pos < fullEnd) { setTimeout(step, 0); return; }
                _shaTail(H, W, input, input.length);
                resolve(_bytesToHex(_shaHexFromH(H)));
            } catch (e2) { reject(e2); }
        }
        setTimeout(step, 0);
    });
}

// ---------- HMAC-SHA256 (RFC 2104, blocksize 64) ----------

function hmacSha256Hex(keyStr, msgStr) {
    var key = _utf8Bytes(keyStr);
    if (key.length > 64) key = _sha256Bytes(key);
    var ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for (var i = 0; i < 64; i++) {
        var kb = i < key.length ? key[i] : 0;
        ipad[i] = kb ^ 0x36;
        opad[i] = kb ^ 0x5C;
    }
    var msg = _utf8Bytes(msgStr);
    var inner = new Uint8Array(64 + msg.length);
    inner.set(ipad); inner.set(msg, 64);
    var innerHash = _sha256Bytes(inner);
    var outer = new Uint8Array(64 + 32);
    outer.set(opad); outer.set(innerHash, 64);
    return _bytesToHex(_sha256Bytes(outer));
}

// ---------- 链账本 ----------

async function _getCacheFolder() {
    var dataFolder = await _lfs.getDataFolder();
    try { return await dataFolder.getEntry('image_cache'); }
    catch(e) { return await dataFolder.createFolder('image_cache'); }
}

async function _readLedger(cacheFolder) {
    try {
        var f = await cacheFolder.getEntry(LEDGER_FILE);
        var parsed = JSON.parse(await f.read());
        if (parsed && Array.isArray(parsed.chain)) return parsed;
    } catch(e) { /* 首次/被清空, 链从头开始 */ }
    return { chain: [] };
}

async function _writeLedger(cacheFolder, ledger) {
    var f = await cacheFolder.createFile(LEDGER_FILE, { overwrite: true });
    await f.write(JSON.stringify(ledger));
}

function _fmtTime(ts) {
    if (!ts) return '?';
    var d = new Date(ts);
    function p(n) { return ('0' + n).slice(-2); }
    return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' '
         + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// 追加写串行化: 多任务同时完成时排队进链, 防止链号/账本互相覆盖
var _appendQueue = Promise.resolve();

// 插件版本懒读 manifest.json(只读一次), 避免又多一处硬编码版本号
var _pluginVersionCache = null;
async function _getPluginVersion() {
    if (_pluginVersionCache) return _pluginVersionCache;
    try {
        var pluginFolder = await _lfs.getPluginFolder();
        var mf = await pluginFolder.getEntry('manifest.json');
        var parsed = JSON.parse(await mf.read());
        if (parsed && parsed.version) _pluginVersionCache = String(parsed.version);
    } catch(e) {}
    if (!_pluginVersionCache) _pluginVersionCache = '?';
    return _pluginVersionCache;
}

// ============================================================
//  appendEvidence(opts) —— 生成完成后调用(异步, 不要 await 在主流程里)
//  opts: {
//    runFolder,                 必填: 本次生成的叶子文件夹(日志写在这里)
//    runPath,                   可选: "项目/叶子" 两级路径(账本里记这个); 不传用 runFolder.name
//    taskId, startTs, endTs,    任务段
//    pluginVersion, engine, model, source, docName,   环境段
//    prompt,                    提示词全文
//    inputs:  [base64, ...],    传入原图(与 input_001.png 顺序一致)
//    outputs: [base64, ...],    传出回图(与 output_001.png 顺序一致)
//    inputHashes/outputHashes:  可选: 已算好的 SHA-256 hex(内存治理场景图已释放时用, 排在 base64 前)
//  }
//  返回 Promise<{ok, seq, sig} | {ok:false, error}>; 内部全兜错, 绝不向外抛。
// ============================================================
function appendEvidence(opts) {
    var job = _appendQueue.then(function() { return _appendEvidenceInner(opts); })
        .catch(function(e) { return { ok: false, error: (e && e.message) || String(e) }; });
    _appendQueue = job.then(function(){}, function(){});
    return job;
}

async function _appendEvidenceInner(opts) {
    if (!opts || !opts.runFolder) return { ok: false, error: 'runFolder 为空' };

    // 1. 图像指纹(base64 用分片异步算, 不堵事件循环; 也接受调用方提前算好的指纹 hex)
    var fpLines = [];
    var inputs = opts.inputs || [];
    var outputs = opts.outputs || [];
    var inputHashes = opts.inputHashes || [];
    var outputHashes = opts.outputHashes || [];
    var i;
    for (i = 0; i < inputHashes.length; i++) {
        if (inputHashes[i]) fpLines.push('input_' + ('000'+(i+1)).slice(-3) + ' = ' + inputHashes[i]);
    }
    for (i = 0; i < inputs.length; i++) {
        if (!inputs[i]) continue;
        fpLines.push('input_' + ('000'+(inputHashes.length+i+1)).slice(-3) + ' = ' + (await sha256HexOfBase64Async(inputs[i])));
    }
    for (i = 0; i < outputHashes.length; i++) {
        if (outputHashes[i]) fpLines.push('output_' + ('000'+(i+1)).slice(-3) + ' = ' + outputHashes[i]);
    }
    for (i = 0; i < outputs.length; i++) {
        if (!outputs[i]) continue;
        fpLines.push('output_' + ('000'+(outputHashes.length+i+1)).slice(-3) + ' = ' + (await sha256HexOfBase64Async(outputs[i])));
    }

    // 2. 链账本: 取上一条签章 + 本条链号
    var cacheFolder = await _getCacheFolder();
    var ledger = await _readLedger(cacheFolder);
    var prevSig = ledger.chain.length ? ledger.chain[ledger.chain.length - 1].sig : 'GENESIS';
    var seq = ledger.chain.length + 1;

    // 3. 拼正文(签章段之前的全部内容参与签章)
    var pluginVersion = opts.pluginVersion || await _getPluginVersion();
    var elapsed = (opts.endTs && opts.startTs) ? (opts.endTs - opts.startTs) : '';
    var body = ''
        + '【任务】\n'
        + '任务ID: ' + (opts.taskId || '?') + '\n'
        + '开始时间: ' + _fmtTime(opts.startTs) + '\n'
        + '结束时间: ' + _fmtTime(opts.endTs) + '\n'
        + '耗时(毫秒): ' + elapsed + '\n'
        + '\n【环境】\n'
        + '插件版本: ' + pluginVersion + '\n'
        + '引擎: ' + (opts.engine || '?') + '\n'
        + '模型名: ' + (opts.model || '?') + '\n'
        + '算力来源: ' + (opts.source || '?') + '\n'
        + 'PS文档名: ' + (opts.docName || '?') + '\n'
        + '\n【提示词】\n'
        + (opts.prompt || '(无)') + '\n'
        + '\n【图像指纹】\n'
        + (fpLines.length ? fpLines.join('\n') : '(无图)') + '\n';

    // 4. 签章 = HMAC(正文 + 上一条签章 + 链号)
    var sig = hmacSha256Hex(HMAC_KEY, body + '\n#' + seq + '\n' + prevSig);
    var logText = body
        + '\n【签章】\n'
        + '本条签章 = ' + sig + '\n'
        + '上一条签章 = ' + prevSig + ' (链号 #' + seq + ')\n'
        + '\n(本文件由插件自动生成, 用于证明生成记录未被改动。修改本文件任何内容都会导致签章验不过, 请勿改动。)\n';

    // 5. 落盘: 先写日志再记账(账本写失败时日志还在, 下次追加会重号→验链能发现, 不隐匿)
    var logFile = await opts.runFolder.createFile(LOG_FILE, { overwrite: true });
    await logFile.write(logText);

    ledger.chain.push({
        n: seq,
        sig: sig,
        runPath: opts.runPath || (opts.runFolder && opts.runFolder.name) || '',
        taskId: opts.taskId || '',
        ts: opts.endTs || Date.now()
    });
    await _writeLedger(cacheFolder, ledger);
    return { ok: true, seq: seq, sig: sig };
}

module.exports = {
    sha256Hex: sha256Hex,
    sha256HexOfBase64: sha256HexOfBase64,
    sha256HexOfBase64Async: sha256HexOfBase64Async,
    hmacSha256Hex: hmacSha256Hex,
    appendEvidence: appendEvidence,
    LEDGER_FILE: LEDGER_FILE,
    LOG_FILE: LOG_FILE
};
