// ============================================================
//  ai-api.js
//  AI API 客户端（调用、错误处理、中断控制）
//
//  从 index.js 抽出，行为完全一致。
//  使用工厂函数 createAiApiModule 注入外部依赖。
// ============================================================

var serverConfig = require('../core/server-config.js');

function createAiApiModule(deps) {
    var logToPanel = deps.logToPanel;
    var base64ToArrayBuffer = deps.base64ToArrayBuffer;
    // 返回当前值的 getter 函数（引用可变全局）
    var getActiveControllers = deps.getActiveControllers;
    var setActiveControllers = deps.setActiveControllers;
    var getTaskControllers = deps.getTaskControllers;
    var getEarlyStop = deps.getEarlyStop;
    var getTaskEarlyStop = deps.getTaskEarlyStop;
    var getHostStorage = deps.getHostStorage || function() { return {}; };
    var sendToPanel = deps.sendToPanel || function() {};

    // 只在真正准备提交“生成请求”时触发一次。提示词校验、URL 校验、
    // multipart 构造等联网前错误不会触发，供上层精确区分是否需要按失败请求计费。
    function _notifyRequestAttempt(options) {
        if (!options || options.__wcRequestAttemptNotified) return;
        options.__wcRequestAttemptNotified = true;
        if (typeof options.onRequestAttempt === 'function') {
            try { options.onRequestAttempt(); } catch (_) {}
        }
    }

    // 从 URL 取域名(不含路径/查询, 不泄漏 key)
    function _hostOf(url) { var m = /^https?:\/\/([^\/?#]+)/i.exec(String(url || '')); return m ? m[1] : '(未知域名)'; }

    // 据"原始报错 + 失败用时 + 域名"推断最可能诱因, 帮人判断到底哪儿出问题
    function _diagnoseNet(msg, elapsedMs, host) {
        var hints = [];
        var isTunnel = /cpolar|ngrok|natapp|frp/i.test(host || '');
        if (/Network request failed|Failed to fetch|NetworkError/i.test(msg)) {
            if (elapsedMs < 800) hints.push('几乎瞬间就失败 → 多半是 DNS 解析不到 / 代理拒绝连接 / 域名根本没连上(Clash 等代理同时开多条连接时尤其常见)');
            else hints.push('连到一半断了 → 可能网络不稳 / 代理抽风 / TLS 握手被打断');
        } else if (/ETIMEDOUT|timed?\s*out|超时/i.test(msg)) {
            hints.push('连接超时 → 服务器响应太慢或网络拥塞');
        } else if (/ECONNREFUSED/i.test(msg)) {
            hints.push('连接被拒绝 → 目标端口不通 / 服务没在跑');
        } else if (/ECONNRESET|socket hang up/i.test(msg)) {
            hints.push('连接被重置 → 代理或中间网络设备掐断了连接');
        } else if (/certificate|SSL|TLS|cert/i.test(msg)) {
            hints.push('证书/TLS 问题 → 该域名证书不被信任(隧道/自签常见)');
        }
        if (isTunnel) hints.push('目标是内网穿透隧道(' + host + '), 隧道本身可能不稳/会变地址');
        return hints.join('; ');
    }

    // 瞬时连接错(Network request failed / Failed to fetch 等)自动退避重试 + 失败时给出诊断。
    // 并发首批同时建连/解析 DNS 容易有几条失败(尤其代理/Clash 环境), 重试一两次基本就成。
    // 只重试"建连阶段抛错"; 不碰: 已 abort(用户停/超时)、HTTP 错误响应(那是 resp 不是 throw)。
    async function _fetchWithRetry(doFetch, opts) {
        opts = opts || {};
        var max = (opts.retries != null) ? opts.retries : 2;
        var baseDelay = opts.delay || 400;
        var connectGuard = opts.connectGuard || 3000;   // 失败超过这个用时就不重试(防重复递交/扣费)
        var host = _hostOf(opts.url);
        var attempt = 0;
        while (true) {
            var t0 = Date.now();
            try {
                return await doFetch();
            } catch (e) {
                attempt++;
                var elapsed = Date.now() - t0;
                var isAbort = (e && e.name === 'AbortError');
                var msg = String((e && e.message) || e);
                // 尽量把错误对象里"藏着的"细节抠出来(UXP fetch 通常只有 TypeError+message,
                // 但个别版本可能挂 .code/.cause/.errno —— 抓出来才知道有没有)
                var extra = [];
                try {
                    if (e && e.name && e.name !== 'Error') extra.push('name=' + e.name);
                    if (e && e.code != null) extra.push('code=' + e.code);
                    if (e && e.errno != null) extra.push('errno=' + e.errno);
                    if (e && e.cause != null) extra.push('cause=' + String((e.cause && e.cause.message) || e.cause).slice(0, 120));
                    var ks = Object.keys(e || {}).filter(function(k) { return ['name', 'message', 'code', 'cause', 'errno', 'stack', 'solution', '_netDiag'].indexOf(k) < 0; });
                    if (ks.length) extra.push('额外字段=' + ks.join(','));
                } catch (_) {}
                var extraStr = extra.length ? (' [' + extra.join(' ') + ']') : '';
                var netErr = /Network request failed|Failed to fetch|networkerror|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|\bfetch\b/i.test(msg);
                // 只重试"建连阶段(用时短)"的失败 —— 那时请求还没送到服务器, 重试不会重复生成。
                // 失败用时较长 = 连接早建好、请求多半已送达, 重试可能重复扣费 → 不重试。
                var safeToRetry = !isAbort && netErr && elapsed < connectGuard;
                if (opts.shouldStop && opts.shouldStop()) throw e;     // 用户停 / 超时 → 不重试
                if (!safeToRetry || attempt > max) {
                    if (isAbort) throw e;   // 超时/中断保持原样, 由上层区分
                    var slowNote = (netErr && elapsed >= connectGuard) ? ' (失败发生在连接建立之后, 为避免重复生成/扣费未自动重试)' : '';
                    var diag = _diagnoseNet(msg, elapsed, host);
                    var e2 = new Error('网络请求失败 [' + host + ' · 试了 ' + attempt + ' 次 · 末次用时 ' + elapsed + 'ms]' + slowNote +
                        (diag ? ' — 诱因推断: ' + diag : '') + ' — 原始报错: ' + msg + extraStr);
                    e2._netDiag = true;
                    // 连续快速建连失败通常代表请求尚未到达服务端；慢失败则按可能已提交处理。
                    e2.requestAttempted = !(safeToRetry && attempt > max);
                    e2.solution = '①先关/换代理(Clash)再试 ②确认这个域名能正常上网 ③若是隧道地址不稳, 联系作者换地址 ④稍后重试';
                    throw e2;
                }
                var wait = baseDelay * attempt + Math.floor(Math.random() * 200);   // 退避 + 抖动错峰
                if (logToPanel) logToPanel('[网络] ' + host + ' 第 ' + attempt + ' 次失败(用时 ' + elapsed + 'ms): ' + msg + extraStr + ' → ' + wait + 'ms 后重试', 'warn');
                await new Promise(function(r) { setTimeout(r, wait); });
            }
        }
    }

// ============================================================
//  AI 服务可用度上报 (开源, 用户可监管)
//
//  ★ 严格关卡: 用户在 "服务器状态" 磁贴里没勾"启用上报",
//    reportAiUsage() 立刻 return, 不发任何网络请求
//
//  会上报的 7 个字段:
//    1. provider:  aji | grs | others
//    2. modelType: banana | gpt-image
//    3. size:      1K | 2K | 4K
//    4. success:   true | false
//    5. elapsed:   秒数
//    6. endReason: success | timeout | userStop | apiError
//    7. errMsg:    报错文字 (经 _sanitizeAiErrMsg 脱敏后)
//
//  绝对不上报: 提示词 / 图片 / API URL / API Key / 任何身份信息
// ============================================================

var AI_USAGE_REPORT_PATH = '/api/aiusage';

// 脱敏: 抹掉报错中的网址 / API Key / IP / Bearer token
function _sanitizeAiErrMsg(s) {
    if (!s) return '';
    s = String(s);
    s = s.replace(/https?:\/\/[^\s,)\]"']+/g, '<URL>');
    s = s.replace(/sk-[a-zA-Z0-9_\-]{8,}/g, '<KEY>');
    s = s.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<IP>');
    s = s.replace(/Bearer\s+[a-zA-Z0-9_\-\.]{8,}/gi, 'Bearer <TOKEN>');
    return s.slice(0, 200);
}

// 把 modelName 归类成大类 (不上报具体模型名, 只大类)
//   AJI 侧细分: banana-pro / banana-2 / banana-old (香蕉1=gemini)
//   GRS 侧不细分: 都归 banana
//   gpt-image 系列: gpt-image (不分 vip/vt/cl)
function _classifyModel(modelName, provider) {
    var m = String(modelName || '').toLowerCase();
    if (m.indexOf('gpt-image') !== -1) return 'gpt-image';
    // AJI 侧细分
    if (provider === 'aji') {
        if (m.indexOf('ajbanana3') !== -1) return 'banana-pro';
        if (m.indexOf('banana-pro-d') !== -1) return 'banana-pro';   // Banana-pro-D 归 pro 系
        if (m.indexOf('ajbanana2') !== -1) return 'banana-2';
        if (m.indexOf('gemini') !== -1) return 'banana-old';
        return 'banana-other';
    }
    // GRS / Others 侧统一归 banana
    return 'banana';
}

// 从错误推断 endReason
//   safetyFilter    — 内容被 AI 安全审查拦截 (提示词或图片有问题, 不是服务器坏)
//   timeout         — 网络超时
//   userStop        — 用户主动中断
//   auth_failed     — API Key 无效 / 过期 / 未授权 (401/403)
//   quota_exhausted — 余额不足 / 限流 / 额度耗尽 (402/429)
//   server_error    — 服务端 5xx / 网关错误 / 服务不可用 (500/502/503)
//   apiError        — 其他未归类的服务端错误
function _deduceEndReason(err) {
    if (!err) return 'success';
    var msg = String(err.message || err);
    // 用户主动中断
    if (msg.indexOf('已被提前结束') !== -1) return 'userStop';
    // 网络超时
    if (msg.indexOf('请求超时') !== -1 || msg.indexOf('网关超时') !== -1) return 'timeout';
    // 内容安全审查相关 (这些是用户的图/词触发了 AI 审查, 不是服务器问题)
    var safetyKeywords = [
        '安全过滤', '安全审查', '内容策略', '内容审查',
        'blockReason', 'PROHIBITED_CONTENT', 'RECITATION', 'IMAGE_SAFETY',
        'safety_violations', 'content_policy', 'moderation', 'safety system',
        '仅返回文本', '未返回图片', '未返回任何数据', 'candidates为空', 'candidates 为空'
    ];
    for (var i = 0; i < safetyKeywords.length; i++) {
        if (msg.indexOf(safetyKeywords[i]) !== -1) return 'safetyFilter';
    }
    // 422 也常常是内容审查
    if (msg.indexOf('422') !== -1 || msg.indexOf('内容不合法') !== -1) return 'safetyFilter';
    // 鉴权失败 — 401 / 403 / Key 无效或过期
    if (msg.indexOf('401') !== -1 || msg.indexOf('403') !== -1 ||
        msg.indexOf('API Key 无效') !== -1 || msg.indexOf('已过期') !== -1 ||
        msg.indexOf('权限不足') !== -1 || msg.indexOf('未授权') !== -1) return 'auth_failed';
    // 余额/限流 — 402 / 429 / 余额不足 / 额度耗尽
    if (msg.indexOf('402') !== -1 || msg.indexOf('429') !== -1 ||
        msg.indexOf('余额不足') !== -1 || msg.indexOf('额度耗尽') !== -1 ||
        msg.indexOf('限流') !== -1 || msg.indexOf('TPM超限') !== -1) return 'quota_exhausted';
    // 服务端 5xx
    if (msg.indexOf('500') !== -1 || msg.indexOf('502') !== -1 || msg.indexOf('503') !== -1 ||
        msg.indexOf('服务器内部错误') !== -1 || msg.indexOf('网关错误') !== -1 ||
        msg.indexOf('服务暂时不可用') !== -1) return 'server_error';
    return 'apiError';
}

// 把任务耗时分桶 (用于 telemetry, 防止具体秒数变成时间指纹)
function _bucketElapsed(sec) {
    if (sec == null) return null;
    if (sec < 5) return '0-5s';
    if (sec < 10) return '5-10s';
    if (sec < 20) return '10-20s';
    if (sec < 40) return '20-40s';
    if (sec < 80) return '40-80s';
    if (sec < 180) return '80-180s';
    return '180s+';
}

function reportAiUsage(args) {
    // 关卡 1: 用户没启用 → 立刻退出
    var hs = getHostStorage() || {};
    var enabledRaw = hs['aistatus.enabled'];
    // hostStorage 里值是 JSON 字符串
    var enabled = enabledRaw === true || enabledRaw === 'true';
    if (!enabled) return;
    // 关卡 2: 字段白名单, 防止外部传脏数据进来
    var providers = ['aji','grs','momo','others'];
    var sizes = ['1K','2K','4K','Auto'];
    var reasons = ['success','timeout','userStop','apiError','safetyFilter'];
    var payload = {
        provider: providers.indexOf(args.provider) !== -1 ? args.provider : 'others',
        modelType: _classifyModel(args.modelName, args.provider),
        size: sizes.indexOf(args.size) !== -1 ? args.size : '?',
        success: !!args.success,
        elapsed: Math.min(3600, Math.max(0, +args.elapsed || 0)),
        endReason: reasons.indexOf(args.endReason) !== -1 ? args.endReason : 'apiError',
        errMsg: args.success ? '' : _sanitizeAiErrMsg(args.errMsg || '')
    };
    // 异步发送, 失败静默 (绝不影响主流程)
    try {
        serverConfig.fetchApi(AI_USAGE_REPORT_PATH, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).catch(function() {});
    } catch (_) {}
}

// ============================================================
//  对话式生成磁贴 — 事件 emit
//  所有走 callAiApi / callGptImageNewApi / callGrsGptImageApi 的请求和响应都广播
//  失败也广播 → 磁贴显示错误气泡
// ============================================================
function _convEmit(payload) {
    // 任务已被提前结束后才回来的图 = "迟到图": 打上 late 标,
    // 气泡靠它判断该图走 ⏸ 传回(不会被正常流程贴回), 与运行中的图区分开
    try {
        if (payload && payload.type === 'response' && payload.taskId) {
            var _tes = getTaskEarlyStop();
            if (_tes && _tes[payload.taskId]) payload.late = true;
        }
    } catch(_) {}
    try { sendToPanel('conversationEvent', payload); } catch(_) {}
}

// v6.5.10: 从 options 里取归档号包成数组 (气泡"后台完成·未贴回 ⏸ 点击传回"要靠它对上回收站记录)
// 调用方(tile-run.host 等)把每张图的归档 meta.id 放进 options.archiveId
function _convArchiveIds(options) {
    return (options && options.archiveId) ? [options.archiveId] : [];
}

// ============================================================
//  从 text 里抽出 base64 markdown / URL(参考 banana2 节点 extract_content)
//  返回 { base64s: [...], urls: [...], cleanText: '剩余文本(去掉了上面那些)' }
// ============================================================
function _extractFromText(text) {
    var out = { base64s: [], urls: [], cleanText: text || '' };
    if (!text) return out;
    var residual = text;

    // 1. data:image/...;base64,xxx (含 markdown 包装版本) — 抽出 base64
    var b64Re = /data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/g;
    var m;
    while ((m = b64Re.exec(text)) !== null) {
        if (m[1] && m[1].length > 100) out.base64s.push(m[1]);
    }
    // 把 base64 块从 cleanText 里去掉(整段 data:image..base64, 都去掉)
    residual = residual.replace(/!\[[^\]]*\]\(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+\)/g, '');
    residual = residual.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '');

    // 2. URL 形式 — markdown ![](url) / 裸 https URL
    var urlSet = {};
    var mdReg = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
    while ((m = mdReg.exec(text)) !== null) {
        if (m[1]) urlSet[m[1]] = true;
    }
    var bareReg = /(https?:\/\/[^\s)<>"']+\.(?:png|jpg|jpeg|webp|gif)(?:\?[^\s)<>"']*)?)/gi;
    while ((m = bareReg.exec(text)) !== null) {
        if (m[1]) urlSet[m[1]] = true;
    }
    out.urls = Object.keys(urlSet);
    // 把这些 URL 也从 cleanText 里去掉
    residual = residual.replace(/!\[[^\]]*\]\(https?:\/\/[^\s)]+\)/g, '');
    out.urls.forEach(function(u) {
        residual = residual.split(u).join('');
    });

    out.cleanText = residual.replace(/\n{3,}/g, '\n\n').trim();
    return out;
}

// 给 banana 用的图片 URL 下载器(简单 fetch + base64 编码)
async function _downloadImageToBase64(url, signal) {
    try {
        var r = await fetch(url, { signal: signal });
        if (!r.ok) return null;
        var buf = await r.arrayBuffer();
        var bytes = new Uint8Array(buf);
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    } catch(_) { return null; }
}

// ============================================================
//  GPT-Image 工具:从 storage 读用户设置(无值用默认)
// ============================================================
function _gptCfg(key, def) {
    var v;
    try {
        var s = getHostStorage() || {};
        v = s[key];
        // hostStorage 里值是 JSON.stringify 之后的字符串
        if (typeof v === 'string') {
            try { v = JSON.parse(v); } catch(_) {}
        }
    } catch(_) {}
    return (v === undefined || v === null || v === '') ? def : v;
}

// base64 → ArrayBuffer
function _b64ToBuf(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var buf = new ArrayBuffer(len);
    var view = new Uint8Array(buf);
    for (var i = 0; i < len; i++) view[i] = bin.charCodeAt(i);
    return buf;
}

// ============================================================
//  GPT-Image:把 (sizeKey, aspectRatio) 映射成节点支持的像素串
//  返回 { size: '1024x1024', warning: '' or '...' }
//  4K 没有 1:1 → 选了会被收敛到 4K 横屏并 warning
// ============================================================
function _mapGptSizeToPixels(sizeKey, aspectRatio) {
    var ar = (aspectRatio || 'Auto').toLowerCase();
    // 横向比例(宽 > 高)
    var WIDE = ['16:9', '3:2', '4:3', '5:4'];
    var TALL = ['9:16', '2:3', '3:4', '4:5'];
    var isWide = WIDE.indexOf(ar) !== -1;
    var isTall = TALL.indexOf(ar) !== -1;
    var isSquare = (ar === '1:1');
    var isAuto = (ar === 'auto');

    if (sizeKey === '4K') {
        if (isTall) return { size: '2160x3840', warning: '' };
        if (isWide) return { size: '3840x2160', warning: '' };
        if (isSquare) return { size: '3840x2160', warning: '4K 不支持 1:1，已使用 4K 横屏 (3840x2160)' };
        return { size: '3840x2160', warning: '' }; // Auto / 未识别
    }
    if (sizeKey === '2K') {
        if (isSquare) return { size: '2048x2048', warning: '' };
        if (isTall) return { size: '1152x2048', warning: '' };
        if (isWide) return { size: '2048x1152', warning: '' };
        return { size: '2048x2048', warning: '' };
    }
    // 默认 1K
    if (isSquare) return { size: '1024x1024', warning: '' };
    if (isTall) return { size: '1024x1536', warning: '' };
    if (isWide) return { size: '1536x1024', warning: '' };
    return { size: '1024x1024', warning: '' };
}

// ============================================================
//  GPT-Image:手写 multipart/form-data,UXP fetch 兼容
//  fields: { name: stringValue }
//  files: [{ name, filename, contentType, buffer (ArrayBuffer) }]
//  返回 { body: ArrayBuffer, contentType: 'multipart/form-data; boundary=...' }
// ============================================================
function _strToUtf8Bytes(s) {
    // UXP 不一定有 TextEncoder,手工把字符串编成 UTF-8 字节
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
            // surrogate pair
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
        } else {
            bytes.push(0xe0 | (c >> 12));
            bytes.push(0x80 | ((c >> 6) & 0x3f));
            bytes.push(0x80 | (c & 0x3f));
        }
    }
    return new Uint8Array(bytes);
}

function _buildMultipart(fields, files) {
    // boundary 全 ASCII 小写数字字母,避免 UXP fetch 把 Blob.type 转小写时
    // 与原 boundary 不一致
    var boundary = '----wcformboundary' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    var chunks = []; // Array<Uint8Array>

    // 文本字段
    var fkeys = Object.keys(fields || {});
    for (var i = 0; i < fkeys.length; i++) {
        var k = fkeys[i];
        var v = fields[k];
        if (v === undefined || v === null) continue;
        var head = '--' + boundary + '\r\n' +
                   'Content-Disposition: form-data; name="' + k + '"\r\n\r\n' +
                   String(v) + '\r\n';
        chunks.push(_strToUtf8Bytes(head));
    }

    // 文件字段(可同名重复:image)
    for (var fi = 0; fi < (files || []).length; fi++) {
        var f = files[fi];
        var fhead = '--' + boundary + '\r\n' +
                    'Content-Disposition: form-data; name="' + f.name + '"; filename="' + (f.filename || 'file.bin') + '"\r\n' +
                    'Content-Type: ' + (f.contentType || 'application/octet-stream') + '\r\n\r\n';
        chunks.push(_strToUtf8Bytes(fhead));
        chunks.push(new Uint8Array(f.buffer));
        chunks.push(_strToUtf8Bytes('\r\n'));
    }

    chunks.push(_strToUtf8Bytes('--' + boundary + '--\r\n'));

    // 合并所有 chunk
    var totalLen = 0;
    for (var ci = 0; ci < chunks.length; ci++) totalLen += chunks[ci].length;
    var out = new Uint8Array(totalLen);
    var off = 0;
    for (var cj = 0; cj < chunks.length; cj++) {
        out.set(chunks[cj], off);
        off += chunks[cj].length;
    }
    return { body: out.buffer, contentType: 'multipart/form-data; boundary=' + boundary };
}

// ============================================================
//  GPT-Image:同步 / 异步轮询解析
//  result: API 返回的 JSON 对象
//  返回 base64 字符串(成功) 或 null(需要继续轮询) 或 throw
// ============================================================
function _extractGptImageBase64(result) {
    if (!result) return null;
    // 同步形式:{ data: [{ b64_json | url }] }
    var dataArr = result.data;
    var inner = null;
    if (dataArr && typeof dataArr === 'object' && !Array.isArray(dataArr)) {
        // 异步轮询返回:{ data: { status, data: [...] } }
        inner = dataArr;
        var st = inner.status;
        if (st === 'FAILURE' || st === 'failed' || st === 'error') {
            var reason = inner.fail_reason || inner.error || inner.message || '未知错误';
            var eFail = new Error('任务后台失败: ' + reason);
            throw eFail;
        }
        if (st === 'SUCCESS' || st === 'completed' || st === 'done' || st === 'finished') {
            var inn = inner.data;
            if (Array.isArray(inn) && inn.length > 0) dataArr = inn;
            else if (inn && Array.isArray(inn.data)) dataArr = inn.data;
            else throw new Error('任务成功但未返回图片数据');
        } else {
            return null; // 还在跑,继续轮询
        }
    }
    if (!Array.isArray(dataArr) || dataArr.length === 0) return null;
    var first = dataArr[0];
    if (!first || typeof first !== 'object') return null;
    if (first.b64_json) return first.b64_json;
    if (first.url) return { _url: first.url }; // 标记走下载分支
    return null;
}

// ============================================================
//  GPT-Image:核心调用(/v1/images/edits)
//  支持同步/异步轮询、提前结束、超时延长
// ============================================================
async function callGptImageNewApi(apiKey, prompt, inputImageBase64, imageSize, timeoutSeconds, apiBaseUrl, extraImages, modelName, taskId, aspectRatio, options) {
    options = options || {};
    var softMode = !!options.softMode;          // 回收站软中断: earlyStop 不杀本任务, 后台继续轮询
    var g_activeControllers = getActiveControllers();
    var g_taskControllers = getTaskControllers();

    if (apiBaseUrl && apiBaseUrl.endsWith('/')) apiBaseUrl = apiBaseUrl.slice(0, -1);
    var endpoint = _gptCfg('gptImage.endpoint', '/v1/images/edits');
    var url = apiBaseUrl + endpoint;

    // 尺寸映射
    var sizeRes = _mapGptSizeToPixels(imageSize, aspectRatio);
    if (sizeRes.warning) logToPanel('[GPT-Image] ' + sizeRes.warning, 'warn');

    // 用户高级设置
    var quality = _gptCfg('gptImage.quality', 'auto');
    var background = _gptCfg('gptImage.background', 'auto');
    var outputFormat = _gptCfg('gptImage.outputFormat', 'png');
    var inputFidelity = _gptCfg('gptImage.inputFidelity', 'auto');
    var maxPollAttempts = parseInt(_gptCfg('gptImage.maxPollAttempts', 1200), 10);
    var pollIntervalSec = parseInt(_gptCfg('gptImage.pollIntervalSec', 3), 10);
    var maxPollSeconds = parseInt(_gptCfg('gptImage.maxPollSeconds', 3600), 10);

    // 透明背景 + jpeg 不兼容,自动改 png
    if (background === 'transparent' && outputFormat === 'jpeg') {
        logToPanel('[GPT-Image] 透明背景不支持 JPEG,已改为 PNG', 'warn');
        outputFormat = 'png';
    }
    // gpt-image-2 不支持 transparent 背景(API 限制),自动降级成 auto
    if (background === 'transparent' && /gpt-image-2(?!.*-pro)/i.test(modelName)) {
        logToPanel('[GPT-Image] gpt-image-2 不支持透明背景,已自动改为 auto', 'warn');
        background = 'auto';
    }

    // 收集所有参考图(主图 + extraImages)
    var allImages = [];
    if (inputImageBase64) allImages.push(inputImageBase64);
    if (extraImages && extraImages.length) {
        for (var ei = 0; ei < extraImages.length; ei++) {
            if (extraImages[ei]) allImages.push(extraImages[ei]);
        }
    }
    var hasImages = allImages.length > 0;

    // form fields(空值/auto 不传,避免覆盖服务端默认)
    var fields = {
        prompt: prompt,
        model: modelName,
        n: '1',
        response_format: 'b64_json'
    };
    if (quality !== 'auto') fields.quality = quality;
    if (sizeRes.size) fields.size = sizeRes.size;
    if (background !== 'auto') fields.background = background;
    if (outputFormat !== 'png') fields.output_format = outputFormat;
    if (inputFidelity !== 'auto' && hasImages) fields.input_fidelity = inputFidelity;

    // 文件字段（抓图导出固定 PNG）
    var imgMime = 'image/png';
    var imgExt = 'png';
    var files = [];
    if (hasImages) {
        for (var fi = 0; fi < allImages.length; fi++) {
            files.push({
                name: 'image',
                filename: 'image_' + fi + '.' + imgExt,
                contentType: imgMime,
                buffer: _b64ToBuf(allImages[fi])
            });
        }
    } else {
        // 节点要求至少 1 张图,送 1×1 透明 PNG
        var blankPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
        files.push({
            name: 'image',
            filename: 'blank.png',
            contentType: 'image/png',
            buffer: _b64ToBuf(blankPng)
        });
    }

    var multi;
    try {
        multi = _buildMultipart(fields, files);
    } catch(mErr) {
        var eMulti = new Error('构造请求体失败: ' + (mErr && mErr.message || mErr));
        throw eMulti;
    }

    logToPanel('[GPT-Image请求] ' + modelName + ' ' + sizeRes.size + ' (图片数:' + files.length + ', body=' + multi.body.byteLength + 'B)', 'info');

    // controller(只控当次 fetch;poll 阶段每次另起 controller,并通过 earlyStop 标志退出)
    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, timeoutSeconds * 1000);
    var controllerEntry = { controller: controller, timeoutId: timeoutId, startTime: Date.now(), timeoutSeconds: timeoutSeconds, softMode: softMode };
    g_activeControllers.push(controllerEntry);
    if (taskId) {
        if (!g_taskControllers[taskId]) g_taskControllers[taskId] = [];
        g_taskControllers[taskId].push(controllerEntry);
    }

    function unregister(entry) {
        clearTimeout(entry.timeoutId);
        var idx = g_activeControllers.indexOf(entry);
        if (idx !== -1) g_activeControllers.splice(idx, 1);
        if (taskId && g_taskControllers[taskId]) {
            var tidx = g_taskControllers[taskId].indexOf(entry);
            if (tidx !== -1) g_taskControllers[taskId].splice(tidx, 1);
        }
    }

    function checkEarlyStop() {
        // 软中断模式: UI 已退出但任务继续, 不抛错
        if (softMode) return;
        if (getEarlyStop() || (taskId && getTaskEarlyStop()[taskId])) {
            var e = new Error('已被提前结束'); throw e;
        }
    }

    async function doFetch(reqUrl, init) {
        try {
            return await _fetchWithRetry(function() { return fetch(reqUrl, init); }, { retries: 2, delay: 400, url: reqUrl, shouldStop: function() { return !softMode && (getEarlyStop() || (taskId && getTaskEarlyStop()[taskId])); } });
        } catch(e) {
            if (e.name === 'AbortError') {
                checkEarlyStop();
                var eTO = new Error('请求超时 (已等待 ' + controllerEntry.timeoutSeconds + ' 秒)');
                eTO.requestAttempted = e && e.requestAttempted !== undefined ? e.requestAttempted : true;
                eTO.solution = '请检查网络连接,或增加超时时间';
                throw eTO;
            }
            if (e.message && e.message.indexOf('fetch') !== -1) {
                var eNet = new Error('网络连接失败');
                eNet.requestAttempted = e && e.requestAttempted !== undefined ? e.requestAttempted : true;
                eNet.solution = '请检查网络连接';
                throw eNet;
            }
            throw e;
        }
    }

    async function downloadImage(imgUrl) {
        var dlController = new AbortController();
        var dlEntry = { controller: dlController, timeoutId: setTimeout(function() { dlController.abort(); }, timeoutSeconds * 1000), startTime: Date.now(), timeoutSeconds: timeoutSeconds, softMode: softMode };
        g_activeControllers.push(dlEntry);
        if (taskId) g_taskControllers[taskId].push(dlEntry);
        try {
            var r = await fetch(imgUrl, { signal: dlController.signal });
            if (!r.ok) {
                var eDl = new Error('图片下载失败: HTTP ' + r.status);
                eDl.solution = '图片URL可能已过期,请重试';
                throw eDl;
            }
            var buf = await r.arrayBuffer();
            // ArrayBuffer → base64（分片 apply,避免大图 O(n²) 字符串拼接）
            var bytes = new Uint8Array(buf);
            var chunks = [];
            var chunkSize = 8192;
            for (var bi = 0; bi < bytes.length; bi += chunkSize) {
                chunks.push(String.fromCharCode.apply(null, bytes.subarray(bi, bi + chunkSize)));
            }
            return btoa(chunks.join(''));
        } finally {
            unregister(dlEntry);
        }
    }

    try {
        // body 用 Uint8Array,Content-Type 显式带 boundary
        // (Blob 路径在 UXP 里 Blob.type 中的 boundary 参数会丢/被规范化掉
        //  导致服务端拿不到分隔符 → "model name not specified")
        var bodyBytes = new Uint8Array(multi.body);
        logToPanel('[GPT-Image调试] CT=' + multi.contentType + ' bodyLen=' + bodyBytes.length + ' fields=' + Object.keys(fields).join(','), 'info');
        _notifyRequestAttempt(options);
        var resp = await doFetch(url, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                'Content-Type': multi.contentType
            },
            body: bodyBytes,
            signal: controller.signal
        });

        if (!resp.ok) {
            var errDetail = '';
            try {
                var contentType = resp.headers.get('content-type') || '';
                if (contentType.indexOf('application/json') !== -1) {
                    var errBody = await resp.json();
                    if (errBody && errBody.error) errDetail = errBody.error.message || errBody.error.type || JSON.stringify(errBody.error).substring(0, 200);
                    else if (errBody && errBody.message) errDetail = errBody.message;
                } else {
                    var errText = await resp.text();
                    if (errText) errDetail = errText.substring(0, 300);
                }
            } catch(_) {}
            // 内容审查类错误 — 单独识别,给清晰报错
            if (errDetail && (errDetail.indexOf('safety_violations') !== -1 || errDetail.indexOf('safety system') !== -1 || errDetail.indexOf('content_policy') !== -1 || errDetail.indexOf('moderation') !== -1)) {
                var violationMatch = errDetail.match(/safety_violations=\[([^\]]+)\]/);
                var category = violationMatch ? violationMatch[1] : '内容审查';
                var catMap = { 'sexual': '涉性', 'violence': '暴力', 'self-harm': '自残', 'hate': '仇恨', 'minors': '未成年' };
                var catCN = catMap[category] || category;
                var eSafety = new Error('OpenAI 安全审查拒绝 (' + catCN + ') — 提示词或图像被判定为' + catCN + '内容');
                eSafety.solution = '建议:1. 修改提示词,避免敏感词汇 2. 检查 PS 截图是否含敏感内容 3. 切换 GRS/Aji 的 banana 系列(审查更宽松)';
                throw eSafety;
            }
            var error = new Error(getErrorMessage(resp.status) + (errDetail ? ' — ' + errDetail : ''));
            error.solution = getErrorSolution(resp.status);
            throw error;
        }

        var data = await resp.json();

        // 同步成功直接返回
        var direct = _extractGptImageBase64(data);
        if (direct) {
            if (typeof direct === 'string') {
                logToPanel('[GPT-Image] 同步返回成功', 'info');
                _convEmit({ type: 'response', taskId: taskId, success: true, base64s: [direct], archiveIds: _convArchiveIds(options), text: '', ts: Date.now() });
                return direct;
            }
            if (direct._url) {
                logToPanel('[GPT-Image] 同步返回 URL,下载: ' + direct._url, 'info');
                var dl = await downloadImage(direct._url);
                _convEmit({ type: 'response', taskId: taskId, success: true, base64s: [dl], archiveIds: _convArchiveIds(options), text: '', ts: Date.now() });
                return dl;
            }
        }

        // 异步:从顶层或 data.task_id 拿
        var asyncTaskId = data.task_id || (data.data && data.data.task_id);
        if (!asyncTaskId) {
            throw new Error('API 响应缺少图片数据且无 task_id: ' + JSON.stringify(data).substring(0, 300));
        }

        // 注销提交阶段 controller(不再 abort 它),进入轮询
        unregister(controllerEntry);
        clearTimeout(timeoutId);

        logToPanel('[GPT-Image] 进入异步轮询: task_id=' + asyncTaskId + ' (最长 ' + maxPollSeconds + 's)', 'info');

        var pollUrl = apiBaseUrl + '/v1/images/tasks/' + asyncTaskId;
        var pollStart = Date.now();
        var consecutiveErr = 0;

        for (var attempt = 1; attempt <= maxPollAttempts; attempt++) {
            checkEarlyStop();
            // 总体超时检查
            if ((Date.now() - pollStart) / 1000 > maxPollSeconds) {
                throw new Error('GPT-Image 轮询超时 (' + maxPollSeconds + 's)');
            }

            // sleep,但每秒检查一次 earlyStop,响应停止按钮
            for (var w = 0; w < pollIntervalSec; w++) {
                checkEarlyStop();
                await new Promise(function(r) { setTimeout(r, 1000); });
            }

            var pollController = new AbortController();
            var pollEntry = { controller: pollController, timeoutId: setTimeout(function() { pollController.abort(); }, timeoutSeconds * 1000), startTime: Date.now(), timeoutSeconds: timeoutSeconds, softMode: softMode };
            g_activeControllers.push(pollEntry);
            if (taskId) g_taskControllers[taskId].push(pollEntry);

            var pollResp;
            try {
                pollResp = await fetch(pollUrl, {
                    method: 'GET',
                    headers: { 'Authorization': 'Bearer ' + apiKey },
                    signal: pollController.signal
                });
            } catch(pe) {
                unregister(pollEntry);
                if (pe.name === 'AbortError') { checkEarlyStop(); }
                consecutiveErr++;
                if (consecutiveErr >= 5) throw new Error('轮询连续异常: ' + (pe.message || pe));
                continue;
            }
            unregister(pollEntry);

            if (!pollResp.ok) {
                consecutiveErr++;
                if (consecutiveErr >= 5) throw new Error('轮询连续报错 HTTP ' + pollResp.status);
                continue;
            }
            consecutiveErr = 0;

            var pollData;
            try { pollData = await pollResp.json(); } catch(_) { continue; }

            var got = _extractGptImageBase64(pollData);
            if (got) {
                if (typeof got === 'string') {
                    _convEmit({ type: 'response', taskId: taskId, success: true, base64s: [got], archiveIds: _convArchiveIds(options), text: '', ts: Date.now() });
                    return got;
                }
                if (got._url) {
                    var dl2 = await downloadImage(got._url);
                    _convEmit({ type: 'response', taskId: taskId, success: true, base64s: [dl2], archiveIds: _convArchiveIds(options), text: '', ts: Date.now() });
                    return dl2;
                }
            }
            // 还在跑,继续
        }

        throw new Error('GPT-Image 轮询达到最大次数 (' + maxPollAttempts + ')');
    } finally {
        // 提交阶段 controller 可能已经在异步分支提前 unregister;再保险一遍
        clearTimeout(timeoutId);
        var idx2 = g_activeControllers.indexOf(controllerEntry);
        if (idx2 !== -1) g_activeControllers.splice(idx2, 1);
        if (taskId && g_taskControllers[taskId]) {
            var tidx2 = g_taskControllers[taskId].indexOf(controllerEntry);
            if (tidx2 !== -1) g_taskControllers[taskId].splice(tidx2, 1);
        }
    }
}

// ============================================================
//  GRS GPT-Image-2 协议:JSON POST + 轮询
//  端点:POST {grs}/v1/draw/completions  → { code:0, data:{ id } }
//  轮询:POST {grs}/v1/draw/result body { id }
//        → { code:0, data:{ status, progress, results:[{url}], failure_reason, error } }
//  注意:与 AJI 路径完全不同 — JSON body、参考图走 urls(公网 URL)、不支持 base64 参考图
// ============================================================
function _grsFailureReasonText(reason) {
    var map = {
        'output_moderation': '输出违规(模型生成的图片被审核拦截)',
        'input_moderation': '输入违规(提示词或参考图被拦截)',
        'error': '其他错误(建议重新提交)'
    };
    return map[reason] || reason || '未知失败原因';
}

async function callGrsGptImageApi(apiKey, prompt, imageSize, timeoutSeconds, apiBaseUrl, modelName, taskId, aspectRatio, refUrls, options) {
    options = options || {};
    var softMode = !!options.softMode;          // 回收站软中断
    var g_activeControllers = getActiveControllers();
    var g_taskControllers = getTaskControllers();

    if (apiBaseUrl && apiBaseUrl.endsWith('/')) apiBaseUrl = apiBaseUrl.slice(0, -1);

    var maxPollAttempts = parseInt(_gptCfg('grsGpt.maxPollAttempts', 1200), 10);
    var pollIntervalSec = parseInt(_gptCfg('grsGpt.pollIntervalSec', 3), 10);
    var maxPollSeconds = parseInt(_gptCfg('grsGpt.maxPollSeconds', 3600), 10);
    var shutProgress = (_gptCfg('grsGpt.shutProgress', true) !== false);

    // GRS 文档:aspectRatio 字段同时支持比例字符串("16:9")或像素值("3840x2160")
    //   传比例 → GRS 默认按 1K 出图
    //   传像素值 → GRS 按指定分辨率出图(海报场景需要 4K,所以这里把 sizeKey+aspect 转成像素值)
    var pxRes = _mapGptSizeToPixels(imageSize, aspectRatio);
    var ar = pxRes && pxRes.size ? pxRes.size : (aspectRatio || '1:1');
    if (ar === 'Auto' || ar === 'auto') ar = 'auto';
    if (pxRes && pxRes.warning) logToPanel('[GRS-GPT] ' + pxRes.warning, 'warn');

    // 提交体
    var payload = {
        model: modelName,
        prompt: prompt,
        aspectRatio: ar,
        webHook: '-1',         // 立即返回 id,我们用轮询拿结果
        shutProgress: shutProgress
    };
    // 海报磁贴的参考图 URL 数组(先上传到 preset-server 临时图床换的 URL)
    if (refUrls && refUrls.length) {
        payload.urls = refUrls;
        logToPanel('[GRS-GPT] 带 ' + refUrls.length + ' 张参考图 URL', 'info');
    }

    logToPanel('[GRS-GPT请求] ' + modelName + ' aspectRatio=' + ar + ' (sizeKey=' + imageSize + ')', 'info');

    // 提交阶段 controller(只控这次 fetch)
    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, timeoutSeconds * 1000);
    var controllerEntry = { controller: controller, timeoutId: timeoutId, startTime: Date.now(), timeoutSeconds: timeoutSeconds, softMode: softMode };
    g_activeControllers.push(controllerEntry);
    if (taskId) {
        if (!g_taskControllers[taskId]) g_taskControllers[taskId] = [];
        g_taskControllers[taskId].push(controllerEntry);
    }

    function unregister(entry) {
        clearTimeout(entry.timeoutId);
        var idx = g_activeControllers.indexOf(entry);
        if (idx !== -1) g_activeControllers.splice(idx, 1);
        if (taskId && g_taskControllers[taskId]) {
            var tidx = g_taskControllers[taskId].indexOf(entry);
            if (tidx !== -1) g_taskControllers[taskId].splice(tidx, 1);
        }
    }

    function checkEarlyStop() {
        // 软中断模式: UI 已退出但任务继续, 不抛错
        if (softMode) return;
        if (getEarlyStop() || (taskId && getTaskEarlyStop()[taskId])) {
            var e = new Error('已被提前结束'); throw e;
        }
    }

    async function downloadImage(imgUrl) {
        var dlController = new AbortController();
        var dlEntry = { controller: dlController, timeoutId: setTimeout(function() { dlController.abort(); }, timeoutSeconds * 1000), startTime: Date.now(), timeoutSeconds: timeoutSeconds, softMode: softMode };
        g_activeControllers.push(dlEntry);
        if (taskId) g_taskControllers[taskId].push(dlEntry);
        try {
            var r = await fetch(imgUrl, { signal: dlController.signal });
            if (!r.ok) {
                var eDl = new Error('图片下载失败: HTTP ' + r.status);
                eDl.solution = '图片URL可能已过期(2 小时),请重试';
                throw eDl;
            }
            var buf = await r.arrayBuffer();
            var bytes = new Uint8Array(buf);
            var chunks = [];
            var chunkSize = 8192;
            for (var bi = 0; bi < bytes.length; bi += chunkSize) {
                chunks.push(String.fromCharCode.apply(null, bytes.subarray(bi, bi + chunkSize)));
            }
            return btoa(chunks.join(''));
        } finally {
            unregister(dlEntry);
        }
    }

    var taskApiId;
    try {
        var resp;
        try {
            _notifyRequestAttempt(options);
            resp = await _fetchWithRetry(function() {
                return fetch(apiBaseUrl + '/v1/draw/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + apiKey,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });
            }, { retries: 2, delay: 400, url: apiBaseUrl + '/v1/draw/completions', shouldStop: function() { return !softMode && (getEarlyStop() || (taskId && getTaskEarlyStop()[taskId])); } });
        } catch(e) {
            if (e.name === 'AbortError') {
                checkEarlyStop();
                var eTO = new Error('请求超时 (已等待 ' + controllerEntry.timeoutSeconds + ' 秒)');
                eTO.requestAttempted = e && e.requestAttempted !== undefined ? e.requestAttempted : true;
                eTO.solution = '请检查网络连接,或增加超时时间';
                throw eTO;
            }
            if (e.message && e.message.indexOf('fetch') !== -1) {
                var eNet = new Error('网络连接失败');
                eNet.requestAttempted = e && e.requestAttempted !== undefined ? e.requestAttempted : true;
                eNet.solution = '请检查网络连接';
                throw eNet;
            }
            throw e;
        }

        if (!resp.ok) {
            var errText = '';
            try { errText = (await resp.text()).substring(0, 300); } catch(_) {}
            var eHttp = new Error(getErrorMessage(resp.status) + (errText ? ' — ' + errText : ''));
            eHttp.solution = getErrorSolution(resp.status);
            throw eHttp;
        }

        var subData = await resp.json();
        if (!subData || subData.code !== 0) {
            var msg = (subData && subData.msg) || 'GRS 提交失败';
            throw new Error('GRS 提交失败 (code=' + (subData && subData.code) + '): ' + msg);
        }
        taskApiId = subData.data && subData.data.id;
        if (!taskApiId) {
            throw new Error('GRS 提交成功但未返回 task id: ' + JSON.stringify(subData).substring(0, 300));
        }
    } finally {
        unregister(controllerEntry);
    }

    // 轮询
    logToPanel('[GRS-GPT] 进入轮询: id=' + taskApiId + ' (最长 ' + maxPollSeconds + 's)', 'info');
    var pollStart = Date.now();
    var consecutiveErr = 0;
    var lastProgress = -1;

    for (var attempt = 1; attempt <= maxPollAttempts; attempt++) {
        checkEarlyStop();
        if ((Date.now() - pollStart) / 1000 > maxPollSeconds) {
            throw new Error('GRS-GPT 轮询超时 (' + maxPollSeconds + 's)');
        }

        // 间隔 sleep,每秒检查 earlyStop
        for (var w = 0; w < pollIntervalSec; w++) {
            checkEarlyStop();
            await new Promise(function(r) { setTimeout(r, 1000); });
        }

        var pollController = new AbortController();
        var pollEntry = { controller: pollController, timeoutId: setTimeout(function() { pollController.abort(); }, timeoutSeconds * 1000), startTime: Date.now(), timeoutSeconds: timeoutSeconds, softMode: softMode };
        g_activeControllers.push(pollEntry);
        if (taskId) g_taskControllers[taskId].push(pollEntry);

        var pollResp;
        try {
            pollResp = await fetch(apiBaseUrl + '/v1/draw/result', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ id: taskApiId }),
                signal: pollController.signal
            });
        } catch(pe) {
            unregister(pollEntry);
            if (pe.name === 'AbortError') checkEarlyStop();
            consecutiveErr++;
            if (consecutiveErr >= 5) throw new Error('GRS 轮询连续异常: ' + (pe.message || pe));
            continue;
        }
        unregister(pollEntry);

        if (!pollResp.ok) {
            consecutiveErr++;
            if (consecutiveErr >= 5) throw new Error('GRS 轮询连续报错 HTTP ' + pollResp.status);
            continue;
        }
        consecutiveErr = 0;

        var pollData;
        try { pollData = await pollResp.json(); } catch(_) { continue; }

        // code=-22 任务不存在
        if (pollData.code === -22) {
            throw new Error('GRS 任务不存在 (id=' + taskApiId + ',可能已过期)');
        }
        if (pollData.code !== 0) {
            // 偶发的非 0 code,继续轮询;连续 5 次累计才报错
            consecutiveErr++;
            if (consecutiveErr >= 5) throw new Error('GRS 轮询连续返回非 0 code: ' + pollData.msg);
            continue;
        }

        var inner = pollData.data || {};
        var status = inner.status;
        var progress = inner.progress;

        // progress 变化才打日志,避免刷屏
        if (typeof progress === 'number' && progress !== lastProgress) {
            lastProgress = progress;
            logToPanel('[GRS-GPT] 进度 ' + progress + '%', 'info');
        }

        if (status === 'failed') {
            var reasonText = _grsFailureReasonText(inner.failure_reason);
            var detail = inner.error ? ' (' + inner.error + ')' : '';
            var eFail = new Error('GRS 任务失败: ' + reasonText + detail);
            eFail.solution = (inner.failure_reason === 'error') ? '建议重新提交' : '检查提示词或参考图,确保不含违规内容';
            throw eFail;
        }

        if (status === 'succeeded') {
            var results = inner.results || [];
            var firstUrl = (results[0] && results[0].url) || inner.url;
            if (!firstUrl) throw new Error('GRS 任务成功但无图片 URL');
            logToPanel('[GRS-GPT] 任务完成,下载图片: ' + firstUrl, 'info');
            var grsDl = await downloadImage(firstUrl);
            _convEmit({ type: 'response', taskId: taskId, success: true, base64s: [grsDl], archiveIds: _convArchiveIds(options), text: '', ts: Date.now() });
            return grsDl;
        }
        // 其他状态(running 等)继续轮询
    }

    throw new Error('GRS-GPT 轮询达到最大次数 (' + maxPollAttempts + ')');
}

// === 错误消息 ===
function getErrorMessage(status) {
    var messages = {
        400: "请求参数错误（格式/上下文过长/参数越界）",
        401: "API Key 无效或已过期",
        402: "余额不足（中转站/套餐额度耗尽）",
        403: "访问被拒绝（权限不足/模型不可用/IP受限/安全策略）",
        404: "模型或接口地址不存在（检查模型名和API路径）",
        408: "请求超时（网络慢或服务响应慢）",
        413: "请求体过大（历史消息太长/图片太大）",
        422: "请求内容不合法（参数语义错误/图片审核不通过）",
        429: "请求过于频繁或额度耗尽（限流/并发超限/TPM超限）",
        500: "服务器内部错误（中转站或上游异常）",
        502: "网关错误（中转站连不上上游/DNS/代理异常）",
        503: "服务暂时不可用（过载/无可用渠道/维护中）",
        504: "网关超时（模型响应慢/长文本生成超时）"
    };
    return messages[status] || ("API 错误 (HTTP " + status + ")");
}
function getErrorSolution(status) {
    var solutions = {
        400: "检查提示词长度、messages结构、model/temperature/max_tokens参数",
        401: "检查 Authorization: Bearer 头和 API Key 是否正确",
        402: "去中转站后台查看余额和套餐额度",
        403: "检查账户权限、模型可用性、IP白名单、安全策略",
        404: "核对模型名称拼写和API地址路径",
        408: "重试，或增加超时时间",
        413: "裁剪历史消息、压缩图片、减少请求体大小",
        422: "检查参数结构和图片内容是否合规",
        429: "降低请求频率、等待后重试、使用指数退避、检查额度",
        500: "稍后重试，如持续出现请联系中转站",
        502: "检查网络连通性和代理设置",
        503: "稍后重试，或切换其他渠道/模型",
        504: "减少输出长度、改用流式输出、延长超时设置"
    };
    return solutions[status] || "请稍后重试";
}

// ============================================================
//  净化提示词：仅删除参数为0的MODULE块，其余内容原样保留
// ============================================================
function sanitizePrompt(rawPrompt) {
    var text = rawPrompt || '';
    // 填空字段替换:【填空:名=值】 → 值 (发送前把占位换成填的内容,标记本身消失)
    // 永远执行(JSON / MODULE / 纯文本都适用);同名一律用"第一个出现的值",保证同名同值
    var _fillFirst = {};
    text.replace(/【填空:([^=】]+?)(?:=([^】]*))?】/g, function(_m, name, val) {
        if (!(name in _fillFirst)) _fillFirst[name] = (val != null ? val : '');
        return _m;
    });
    text = text.replace(/【填空:([^=】]+?)(?:=([^】]*))?】/g, function(_m, name, val) {
        return (name in _fillFirst) ? _fillFirst[name] : (val != null ? val : '');
    });
    // 只对含 MODULE_START 结构的提示词处理，否则原样返回
    if (text.indexOf('// MODULE_START:') === -1) return text;
    // 扫描所有MODULE块，若块内任意数值@param为0则删除整块
    text = text.replace(/\/\/ MODULE_START:(\w+)[\s\S]*?\/\/ MODULE_END:\1/g, function(block) {
        var paramReg = /@param:([^"]+)"\s*:\s*([\d.]+)/g;
        var m;
        while ((m = paramReg.exec(block)) !== null) {
            var pName = m[1];
            if (/_(?:desc|label|note|range)$/.test(pName)) continue;
            if (parseFloat(m[2]) === 0) return '';
        }
        return block;
    });
    return text;
}

async function callAiApi(apiKey, prompt, inputImageBase64, imageSize, timeoutSeconds, apiBaseUrl, extraImages, modelName, provider, taskId, aspectRatio, options) {
    options = options || {};
    var archiveCallback = options.archiveCallback;
    var requestAttempted = false;
    var callerOnRequestAttempt = options.onRequestAttempt;
    var trackedOptions = Object.assign({}, options, {
        onRequestAttempt: function() {
            requestAttempted = true;
            if (typeof callerOnRequestAttempt === 'function') {
                try { callerOnRequestAttempt(); } catch (_) {}
            }
        }
    });
    var softMode = !!archiveCallback;             // 有归档回调 → 软中断双轨
    // 软中断模式: 真正干活的 promise 跑在后台, 前台 race 一个 earlyStop watchdog
    // (这样 UI 点"提前结束"立刻返回, 后台 fetch/轮询继续, 到结果再归档)
    try {
        if (softMode) {
            return await _runWithArchive(apiKey, prompt, inputImageBase64, imageSize, timeoutSeconds, apiBaseUrl, extraImages, modelName, provider, taskId, aspectRatio, trackedOptions);
        }
        return await _callAiApiInner(apiKey, prompt, inputImageBase64, imageSize, timeoutSeconds, apiBaseUrl, extraImages, modelName, provider, taskId, aspectRatio, trackedOptions);
    } catch(e) {
        if (e && typeof e === 'object' && e.requestAttempted === undefined) {
            e.requestAttempted = requestAttempted;
        }
        try {
            var _mod = (provider === 'grs') ? 'grs' : (provider === 'aji' ? 'aji' : 'others');
            var _em = String((e && e.message) || '');
            var _cat = _mod + '.api.unknown';
            if (/已被提前结束|AbortError/.test(_em)) _cat = _mod + '.user.aborted';
            else if (/safety|content_policy|moderation|安全审查/i.test(_em)) _cat = _mod + '.api.safety_blocked';
            else if (/HTTP\s*5\d\d/i.test(_em) || /轮询.*5\d\d/.test(_em)) _cat = _mod + '.api.http_5xx';
            else if (/HTTP\s*4\d\d/i.test(_em)) _cat = _mod + '.api.http_4xx';
            else if (/超时|timeout|timed out/i.test(_em)) _cat = _mod + '.api.timeout';
            else if (/网络连接|fetch|ENOTFOUND|ECONNREFUSED|NetworkError/i.test(_em)) _cat = _mod + '.network.fail';
            else if (/卡密|无效|余额|积分|余額/.test(_em)) _cat = _mod + '.account.invalid_or_low';
            else if (/提示词为空/.test(_em)) _cat = _mod + '.input.empty_prompt';
            else if (/轮询.*超时/.test(_em)) _cat = _mod + '.poll.timeout';
            else if (/任务失败|任务不存在/.test(_em)) _cat = _mod + '.api.task_failed';
            if (typeof sendToPanel === 'function') {
                sendToPanel('telemetryError', { category: _cat, step: 'callAiApi', msg: _em });
            }
        } catch(_) {}
        throw e;
    }
}

async function _runWithArchive(apiKey, prompt, inputImageBase64, imageSize, timeoutSeconds, apiBaseUrl, extraImages, modelName, provider, taskId, aspectRatio, options) {
    var archiveCallback = options.archiveCallback;
    var innerOptions = Object.assign({}, options, { softMode: true });
    delete innerOptions.archiveCallback;        // 内层不需要再看到回调

    // 确保 taskId 在 g_taskEarlyStop 里有 key
    //   1. watchdog 用 per-task 标志判断 (避免全局 g_earlyStop 残留态误触)
    //   2. 注册了 key 后, 全局 earlyStop 的 Object.keys 遍历能 propagate 到本任务
    if (taskId) {
        var tes = getTaskEarlyStop();
        if (tes[taskId] === undefined || tes[taskId] === true) tes[taskId] = false;
    }

    var workPromise = _callAiApiInner(apiKey, prompt, inputImageBase64, imageSize, timeoutSeconds, apiBaseUrl, extraImages, modelName, provider, taskId, aspectRatio, innerOptions);

    // 后台归档轨: 不管前台是否 throw, 真正完成时一定 fire 一次
    var archived = false;
    function fire(b64, status, err) {
        if (archived) return;
        archived = true;
        try { archiveCallback(b64, status, err); } catch(_) {}
    }
    workPromise.then(function(b64) {
        var late = taskId ? !!getTaskEarlyStop()[taskId] : !!getEarlyStop();
        fire(b64, late ? 'late' : 'success', null);
    }, function(err) {
        var msg = (err && err.message) || String(err);
        if (msg.indexOf('已被提前结束') !== -1) fire(null, 'aborted', msg);
        else fire(null, 'failed', msg);
    });

    // 前台 watchdog: earlyStop 一来立即抛, 让磁贴释放
    //   只看 per-task 标志, 全局 g_earlyStop 残留态不影响新任务
    //   (全局 earlyStop 会把所有已注册 task 的标志置 true, 见 stop-control-handlers.js)
    var watchdog = new Promise(function(_resolve, _reject) {
        var settled = false;
        function tick() {
            if (settled) return;
            var stopped = taskId ? !!getTaskEarlyStop()[taskId] : !!getEarlyStop();
            if (stopped) {
                settled = true;
                _reject(new Error('已被提前结束'));
                return;
            }
            setTimeout(tick, 200);
        }
        tick();
        // 内层结束就停 tick
        workPromise.then(function() { settled = true; }, function() { settled = true; });
    });

    return await Promise.race([workPromise, watchdog]);
}

async function _callAiApiInner(apiKey, prompt, inputImageBase64, imageSize, timeoutSeconds, apiBaseUrl, extraImages, modelName, provider, taskId, aspectRatio, options) {
    options = options || {};
    var softMode = !!options.softMode;
    // ★ 上报: 记录开始时间, 用于算 elapsed
    var __aistatusStartTs = Date.now();
    // 统一入口净化:参数=0 的 MODULE 块整块删除(所有调用入口自动受益,无需各自 sanitize)
    prompt = sanitizePrompt(prompt);
    // 守门人:净化后若提示词为空,直接拒绝调用 AI
    //   覆盖所有 callAiApi 入口(tile-run / batch / colorgrade / tiled / partition / 录制版 等),
    //   防止"输入框空也能算"的残留请求。Forge / ComfyUI 不走这里, 不受影响。
    if (!prompt || !prompt.trim()) {
        var eEmpty = new Error('提示词为空,已拒绝调用 AI(请检查提示词输入框,或重新加载预设)');
        eEmpty.solution = '在「提示词」磁贴里输入提示词后再点开始;若刚清空过,确保 textarea 已重新填充';
        throw eEmpty;
    }
    // AJI URL 守门: 6.2.5 起 URL 由服务端下发, 用户没校验 Key 时 url 为空, 直接报友好错
    if (provider === 'aji' && (!apiBaseUrl || !apiBaseUrl.trim())) {
        var eNoUrl = new Error('AJI 服务器未校验, 请到设置磁贴粘贴 Key 或点"校验 Key"按钮');
        eNoUrl.solution = '设置磁贴 → AJI Key → 粘贴 Key 后会自动校验, 或手动点"校验 Key"按钮';
        throw eNoUrl;
    }
    var g_activeControllers = getActiveControllers();
    var g_taskControllers = getTaskControllers();
    var isAji = (provider === 'aji');
    var isGrs = (provider === 'grs');
    var requestModelName = modelName || "AJbanana3";

    // 对话磁贴 — 广播请求(无论走哪个分支,都从这里发一次)
    // options.displayPrompt: 提示词保护 — 调用方(如半合成)传占位文案时, 对话气泡只显示占位,
    //   真实 prompt 仍照常发给 AI(上游可见, 已知)。不传则显示真实 prompt(默认, 兼容所有旧入口)。
    _convEmit({
        type: 'request',
        taskId: taskId || ('t_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
        provider: provider,
        model: requestModelName,
        size: imageSize,
        aspectRatio: aspectRatio,
        prompt: (options && options.displayPrompt != null) ? options.displayPrompt : prompt,
        mainBase64: inputImageBase64 || '',
        refBase64s: (extraImages || []).filter(Boolean),
        ts: Date.now()
    });

    // GPT-Image 系列分支
    // 子串匹配,任何叫 gpt-image-* 的模型自动走 GPT 路径
    if (requestModelName.toLowerCase().indexOf('gpt-image') !== -1) {
        try {
            if (provider === 'grs') {
                // GRS 协议:JSON POST /v1/draw/completions + 轮询 /v1/draw/result
                // 参考图必须是公网 URL(海报磁贴会先把 base64 上传到自己的临时图床换 URL)
                var grsUrls = (options.grsUrls && options.grsUrls.length) ? options.grsUrls : null;
                if (!grsUrls && (inputImageBase64 || (extraImages && extraImages.length))) {
                    logToPanel('[GRS-GPT] 调用方传了 base64 但没传 URL,GRS 流要求 URL,本次将忽略参考图', 'warn');
                }
                return await callGrsGptImageApi(apiKey, prompt, imageSize, timeoutSeconds, apiBaseUrl, requestModelName, taskId, aspectRatio, grsUrls, { softMode: softMode, onRequestAttempt: options.onRequestAttempt, archiveId: options.archiveId });
            }
            // AJI / others 走 multipart /v1/images/edits
            return await callGptImageNewApi(apiKey, prompt, inputImageBase64, imageSize, timeoutSeconds, apiBaseUrl, extraImages, requestModelName, taskId, aspectRatio, { softMode: softMode, onRequestAttempt: options.onRequestAttempt, archiveId: options.archiveId });
        } catch(gptErr) {
            // GPT 路径失败统一广播一次(成功响应已在内部分别广播)
            _convEmit({ type: 'response', taskId: taskId, success: false, error: String(gptErr.message || gptErr), ts: Date.now() });
            throw gptErr;
        }
    }

    // gemini系列模型不加分辨率后缀，其他模型加 -1k/-2k/-4k 后缀
    // momo 与 others 同款中转: 模型名按原样发, 不加后缀
    if (requestModelName.indexOf('gemini') === -1 && provider !== 'grs' && provider !== 'others' && provider !== 'momo') {
        var suffix = "-" + imageSize.toLowerCase();
        if (!requestModelName.endsWith(suffix)) requestModelName = requestModelName + suffix;
    }
    if (apiBaseUrl && apiBaseUrl.endsWith('/')) apiBaseUrl = apiBaseUrl.slice(0, -1);
    var endpoint = ':generateContent';
    var urlSuffix = (isAji || provider === 'grs' || provider === 'others' || provider === 'momo') ? '' : '?key=' + apiKey;
    var url = apiBaseUrl + "/v1beta/models/" + requestModelName + endpoint + urlSuffix;
    // 构建 parts: 提示词 → 图1(主图) → 图2..图N(参考图)（抓图导出固定 PNG）
    var imgMime = 'image/png';
    var parts = [{ text: prompt }, { inlineData: { mimeType: imgMime, data: inputImageBase64 } }];
    if (extraImages && extraImages.length > 0) {
        for (var ei = 0; ei < extraImages.length; ei++) {
            parts.push({ inlineData: { mimeType: imgMime, data: extraImages[ei] } });
        }
    }
    var generationConfig = { responseModalities: ["IMAGE", "TEXT"], temperature: 0.8, topP: 0.95, maxOutputTokens: 8192 };
    var imageConfig = {};
    if (imageSize && imageSize !== 'Auto') imageConfig.imageSize = imageSize;
    if (aspectRatio && aspectRatio !== 'Auto') imageConfig.aspectRatio = aspectRatio;
    if (Object.keys(imageConfig).length > 0) generationConfig.imageConfig = imageConfig;
    var payload = {
        contents: [{ role: "user", parts: parts }],
        generationConfig: generationConfig
    };
    logToPanel("[API请求] " + requestModelName + " " + imageSize + " " + (aspectRatio || 'Auto'), "info");
    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, timeoutSeconds * 1000);
    // 注册到全局活跃控制器列表，支持提前结束和动态延时
    // softMode 标记: earlyStop 不杀本任务, 让回收站后台续跑
    var controllerEntry = { controller: controller, timeoutId: timeoutId, startTime: Date.now(), timeoutSeconds: timeoutSeconds, softMode: softMode };
    g_activeControllers.push(controllerEntry);
    // 按taskId分组注册（支持 earlyStopTask 按任务中断）
    if (taskId) {
        if (!g_taskControllers[taskId]) g_taskControllers[taskId] = [];
        g_taskControllers[taskId].push(controllerEntry);
    }
    // ★ 上报: 用一个闭包标志记录最终结果, finally 里上报一次
    var __aiOutcome = { success: false, err: null };
    try {
        var fetchHeaders = { "Content-Type": "application/json" };
        if (isAji || isGrs || provider === 'others' || provider === 'momo') { fetchHeaders["Authorization"] = "Bearer " + apiKey; }
        _notifyRequestAttempt(options);
        var response = await _fetchWithRetry(function() {
            return fetch(url, { method: "POST", headers: fetchHeaders, body: JSON.stringify(payload), signal: controller.signal });
        }, { retries: 2, delay: 400, url: url, shouldStop: function() { return !softMode && (getEarlyStop() || (taskId && getTaskEarlyStop()[taskId])); } });
        if (!response.ok) {
            // 尝试读取 response body 中的详细错误信息
            var errDetail = '';
            try {
                var errBody = await response.json();
                if (errBody && errBody.error) {
                    errDetail = errBody.error.message || errBody.error.type || JSON.stringify(errBody.error).substring(0, 200);
                } else if (errBody && errBody.message) {
                    errDetail = errBody.message;
                }
            } catch(bodyErr) {}
            var error = new Error(getErrorMessage(response.status) + (errDetail ? ' — ' + errDetail : ''));
            error.solution = getErrorSolution(response.status);
            throw error;
        }
        var data = await response.json();

        // ── 检查 Gemini 风格的安全拦截（输入阶段） ──
        if (data.promptFeedback && data.promptFeedback.blockReason) {
            var blockReason = data.promptFeedback.blockReason;
            var blockMap = {
                'SAFETY': '输入内容触发安全审查',
                'IMAGE_SAFETY': '图片触发图像安全审核（可能含敏感内容）',
                'PROHIBITED_CONTENT': '输入命中禁止内容类别',
                'BLOCK_REASON_UNSPECIFIED': '输入被拦截（原因未指定）'
            };
            var blockMsg = blockMap[blockReason] || ('输入被拦截: ' + blockReason);
            var eBlock = new Error("安全过滤: " + blockMsg);
            eBlock.solution = "建议：1. 修改提示词避免敏感表述 2. 对原图敏感区域打码后重试 3. 开启抗截断模式";
            throw eBlock;
        }

        // ── 检查输出阶段的安全拦截 ──
        var candidate = data.candidates && data.candidates[0];
        if (candidate) {
            var finishReason = candidate.finishReason;
            if (finishReason === 'SAFETY') {
                var eSafety = new Error("安全过滤: 输出内容触发安全策略，生成被中断");
                eSafety.solution = "建议：1. 开启抗截断模式 2. 对原图敏感区域打码 3. 修改提示词减少敏感引导";
                throw eSafety;
            }
            if (finishReason === 'RECITATION') {
                var eRecite = new Error("内容策略: 输出被判定为重复/引用内容，已拦截");
                eRecite.solution = "修改提示词，增加创作引导";
                throw eRecite;
            }
        }

        // ── 提取图片(对齐 banana2 节点 extract_content) ──
        // 1. 先收集所有 inlineData base64 + 所有 text
        var allParts = (candidate && candidate.content && candidate.content.parts) || [];
        var collectedB64s = [];
        var rawText = '';
        for (var pi = 0; pi < allParts.length; pi++) {
            var pp = allParts[pi];
            if (pp.inlineData && pp.inlineData.data) collectedB64s.push(pp.inlineData.data);
            if (pp.text) rawText += pp.text;
        }

        // 1b. 重复回图修复(v6.5.0): 上游偶发在同一响应里把同一张图给两份
        // (inlineData 两份全等 / inlineData + text 里的 markdown base64 重复)。
        // base64 全等 = 字节级同一张图, 去重绝不会误伤 batch 的相似图。
        if (collectedB64s.length > 1) {
            var seen = {};
            var deduped = [];
            for (var di = 0; di < collectedB64s.length; di++) {
                var dKey = collectedB64s[di].length + ':' + collectedB64s[di].slice(0, 64) + collectedB64s[di].slice(-64);
                if (seen[dKey]) {
                    // 粗指纹撞了再全等确认(防哈希碰撞误删)
                    if (seen[dKey] === collectedB64s[di]) {
                        logToPanel('[API返回] 检测到重复图片(上游返回了两份同一张), 已去重', 'warn');
                        continue;
                    }
                }
                seen[dKey] = collectedB64s[di];
                deduped.push(collectedB64s[di]);
            }
            collectedB64s = deduped;
        }

        // 2. 没图但有文本 → 从文本里 regex 抽 base64 markdown
        var textExtract = _extractFromText(rawText);
        if (collectedB64s.length === 0 && textExtract.base64s.length > 0) {
            collectedB64s = collectedB64s.concat(textExtract.base64s);
        }

        // 3. 仍然没图但有 URL → 下载得到 base64
        if (collectedB64s.length === 0 && textExtract.urls.length > 0) {
            logToPanel('[API返回] 检测到 ' + textExtract.urls.length + ' 个图片 URL,下载中...', 'info');
            for (var ui = 0; ui < textExtract.urls.length; ui++) {
                var dlB64 = await _downloadImageToBase64(textExtract.urls[ui], controller.signal);
                if (dlB64) collectedB64s.push(dlB64);
            }
        }

        // 4. 拿到了图 → 返回首张(保持上游契约不变)
        if (collectedB64s.length > 0) {
            // 检测首图分辨率(只检测第一张,保持原日志行为)
            try {
                var b64 = collectedB64s[0];
                var raw = base64ToArrayBuffer(b64);
                var bytes = new Uint8Array(raw);
                var imgW = 0, imgH = 0;
                if (bytes[0] === 0x89 && bytes[1] === 0x50) {
                    imgW = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
                    imgH = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
                } else if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
                    for (var si = 2; si < bytes.length - 9; si++) {
                        if (bytes[si] === 0xFF && (bytes[si+1] === 0xC0 || bytes[si+1] === 0xC2)) {
                            imgH = (bytes[si+5] << 8) | bytes[si+6];
                            imgW = (bytes[si+7] << 8) | bytes[si+8];
                            break;
                        }
                    }
                }
                if (imgW > 0 && imgH > 0) {
                    logToPanel("[API返回] 图片实际分辨率: " + imgW + "x" + imgH + " (请求:" + imageSize + ")", "info");
                }
            } catch(_re) {}
            // 对话磁贴 — 广播完整图片数组 + cleanText(剥掉了 markdown / URL 后的真实评论)
            try {
                _convEmit({
                    type: 'response',
                    taskId: taskId,
                    success: true,
                    base64s: collectedB64s,
                    archiveIds: _convArchiveIds(options),
                    text: textExtract.cleanText || '',
                    ts: Date.now()
                });
            } catch(_) {}
            __aiOutcome.success = true;
            return collectedB64s[0];
        }

        // ── 完全没图(纯文本响应) → 抛"被拦截"错误,但把文本带在错误信息里 ──
        if (rawText) {
            var preview = rawText.slice(0, 300).replace(/\s+/g, ' ');
            var e2 = new Error("API 仅返回文本,未返回图片 — " + preview);
            e2.solution = "建议:1. 开启抗截断模式 2. 对原图敏感区域打码后重试 3. 检查中转站是否正常返图";
            throw e2;
        }

        // ── 200 但完全空响应 ──
        var e3 = new Error("API 未返回任何数据" + (data.candidates ? "（candidates为空）" : ""));
        e3.solution = "建议：1. 检查模型是否支持图片生成 2. 开启抗截断模式 3. 稍后重试";
        throw e3;
    } catch (e) {
        __aiOutcome.err = e;
        clearTimeout(timeoutId);
        // 对话磁贴 — 广播失败(只在最外层捕获时发一次)
        var convErrSent = false;
        function _convFail(msg) {
            if (convErrSent) return;
            convErrSent = true;
            _convEmit({ type: 'response', taskId: taskId, success: false, error: String(msg || e.message || 'unknown'), ts: Date.now() });
        }
        if (e.name === 'AbortError') {
            // 区分是提前结束还是超时
            // softMode: earlyStop 不参与 abort, AbortError 一定是真超时
            if (!softMode && (getEarlyStop() || (taskId && getTaskEarlyStop()[taskId]))) {
                _convFail('已被提前结束');
                var e4 = new Error("已被提前结束"); throw e4;
            } else {
                _convFail('请求超时');
                var e4b = new Error("请求超时 (已等待 " + controllerEntry.timeoutSeconds + " 秒)");
                e4b.requestAttempted = e && e.requestAttempted !== undefined ? e.requestAttempted : true;
                e4b.solution = "请检查网络连接，或增加超时时间";
                throw e4b;
            }
        }
        if (e.message && e.message.includes('fetch')) {
            _convFail('网络连接失败');
            var e5 = new Error("网络连接失败");
            e5.requestAttempted = e && e.requestAttempted !== undefined ? e.requestAttempted : true;
            e5.solution = "请检查网络连接";
            throw e5;
        }
        _convFail(e.message || e);
        throw e;
    } finally {
        clearTimeout(timeoutId);
        // 从全局列表中移除
        var idx = g_activeControllers.indexOf(controllerEntry);
        if (idx !== -1) g_activeControllers.splice(idx, 1);
        // 从任务分组中移除
        if (taskId && g_taskControllers[taskId]) {
            var tidx = g_taskControllers[taskId].indexOf(controllerEntry);
            if (tidx !== -1) g_taskControllers[taskId].splice(tidx, 1);
        }
        // ★ 上报 AI 服务可用度 (用户没启用时函数会立刻退出)
        try {
            var _elapsed = (Date.now() - __aistatusStartTs) / 1000;
            var _endReason = __aiOutcome.success ? 'success' : _deduceEndReason(__aiOutcome.err);
            reportAiUsage({
                provider: provider,
                modelName: requestModelName,
                size: imageSize,
                success: __aiOutcome.success,
                elapsed: _elapsed,
                endReason: _endReason,
                errMsg: __aiOutcome.err ? (__aiOutcome.err.message || String(__aiOutcome.err)) : ''
            });
            // 用户改进计划: panel 端 telemetry 同时上报任务事件
            // host 没法直接访问 window._telemetry, 通过 sendToPanel 转发
            try {
                if (typeof sendToPanel === 'function') {
                    sendToPanel('telemetryTask', {
                        feature: (options && options.feature) || 'single',
                        provider: provider,
                        model_type: _classifyModel(requestModelName, provider),
                        size: imageSize,
                        aspect_ratio: aspectRatio || null,
                        batch_size: (options && options.batchSize) || 1,
                        result: __aiOutcome.success ? 'success' : (_endReason === 'safetyFilter' ? 'safety' : (_endReason === 'userStop' ? 'cancel' : 'fail')),
                        elapsed_bucket: _bucketElapsed(_elapsed),
                        error_category: __aiOutcome.success ? null : _endReason
                    });
                }
            } catch(_) {}
        } catch (_) {}
    }
}

// === 中断所有活跃请求 ===
// opts.force: true → 真·全部 abort (供 PS 关闭等真·关闭场景, 当前未接入)
//   false (默认) → 跳过 softMode 控制器, 这样"提前结束"不杀回收站任务
// Forge / ComfyUI 自己注册的 controller 没有 softMode 标志, 还是会被 abort, 行为不变
function abortAllActiveRequests(opts) {
    var force = !!(opts && opts.force);
    var g_activeControllers = getActiveControllers();
    var count = 0;
    var remaining = [];
    for (var i = 0; i < g_activeControllers.length; i++) {
        var entry = g_activeControllers[i];
        if (!force && entry.softMode) {
            // 软中断 controller: 保留, 让后台继续跑
            remaining.push(entry);
            continue;
        }
        clearTimeout(entry.timeoutId);
        try { entry.controller.abort(); } catch(e) {}
        count++;
    }
    setActiveControllers(remaining);
    return count;
}

// === 为所有活跃请求延长超时 ===
function extendAllTimeouts(extraSeconds) {
    var g_activeControllers = getActiveControllers();
    for (var i = 0; i < g_activeControllers.length; i++) {
        var entry = g_activeControllers[i];
        // 清除旧定时器
        clearTimeout(entry.timeoutId);
        // 计算已经过的时间
        var elapsed = (Date.now() - entry.startTime) / 1000;
        // 新的总超时 = 原超时 + 额外秒数
        entry.timeoutSeconds += extraSeconds;
        // 剩余时间
        var remaining = entry.timeoutSeconds - elapsed;
        if (remaining < 1) remaining = 1;
        // 创建新定时器
        entry.timeoutId = (function(ctrl) {
            return setTimeout(function() { ctrl.abort(); }, remaining * 1000);
        })(entry.controller);
    }
    return g_activeControllers.length;
}

    return {
        getErrorMessage: getErrorMessage,
        getErrorSolution: getErrorSolution,
        sanitizePrompt: sanitizePrompt,
        callAiApi: callAiApi,
        abortAllActiveRequests: abortAllActiveRequests,
        extendAllTimeouts: extendAllTimeouts
    };
}

module.exports = { createAiApiModule: createAiApiModule };
