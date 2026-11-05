// ============================================================
//  aux-llm.js — 「AI 助手」那套 OpenAI 兼容接口的公用调用
//
//  翻译 / 提示词优化 / 海报自动填充 三处共用这一份，不要再各写一遍。
//
//  配置不新加设置项：复用 AI 助手磁贴的 chat.url / chat.key / chat.model。
//  host 存储 (PluginData/webview_storage.json) 与面板是同一份文件——面板每次
//  storage.set 都发 storageSet 给 host (core/storage-manager.js:93)，host 落盘
//  到同一个 json，所以这里读 ctx.hostStorageRef.value 拿到的就是用户在 AI 助手里填的值。
//  读取规则与 tile-chat.js 的 _getUrl / _getKey / _getModel 一致：
//    URL、模型有默认值，只有 Key 必填。
//
//  本项目自行编写，GPL v3。
// ============================================================

var DEFAULT_URL = 'https://api.openai.com/v1/chat/completions';
var DEFAULT_MODEL = 'gpt-4o-mini';
var DEFAULT_TIMEOUT_MS = 120 * 1000;

// 没配 Key 时三处统一用这一句
var MSG_NO_KEY = '请先在「AI 助手」磁贴里配置语言模型';

// 存储里存的是 JSON.stringify 过的值("https://..." 连引号), 兼容没包装过的旧数据
function _decode(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (_) { return v; }
}

function _readStr(hs, key) {
    var v = _decode(hs[key]);
    return (typeof v === 'string') ? v.trim() : '';
}

// 规范化 chat URL — 与 tile-light-splitter.host.js 原来那份同一套规则
function normalizeChatUrl(url) {
    var u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return null;
    u = u.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(u)) { /* 已完整 */ }
    else if (/\/completions$/i.test(u)) { /* 老接口保留 */ }
    else if (/\/v\d+$/i.test(u)) u += '/chat/completions';
    else u += '/v1/chat/completions';
    return u;
}

// 读配置。返回 { ok, url, key, model, error }
// error 只有「没配 Key」一种, URL 非法在 callChat 里报(那时才知道确实要发请求)
function readConfig(ctx) {
    var hs = (ctx && ctx.hostStorageRef && ctx.hostStorageRef.value) || {};
    var url = _readStr(hs, 'chat.url') || DEFAULT_URL;
    var model = _readStr(hs, 'chat.model') || DEFAULT_MODEL;
    var key = _readStr(hs, 'chat.key');
    if (!key) return { ok: false, error: MSG_NO_KEY, url: url, model: model, key: '' };
    return { ok: true, url: url, model: model, key: key };
}

// 去掉整段被引号包起来的情况(模型偶尔会给译文加引号)
function stripWrappingQuotes(s) {
    var t = String(s == null ? '' : s).trim();
    if (t.length > 2) {
        var a = t.charAt(0), b = t.charAt(t.length - 1);
        if ((a === '"' && b === '"') || (a === '“' && b === '”') || (a === '「' && b === '」')) {
            var inner = t.slice(1, -1);
            if (inner.indexOf(a) === -1 && inner.indexOf('\n') === -1) return inner.trim();
        }
    }
    return t;
}

function _httpHint(status) {
    var map = {
        401: '语言模型 Key 无效或已过期 (HTTP 401)',
        402: '语言模型余额不足 (HTTP 402)',
        404: '接口地址或模型不存在 (HTTP 404)',
        429: '语言模型请求太频繁 (HTTP 429)'
    };
    return map[status] || ('语言模型请求失败 (HTTP ' + status + ')');
}

function _log(ctx, msg, level) {
    try { if (ctx && ctx.logToPanel) ctx.logToPanel(msg, level || 'info'); } catch (_) {}
}

// 调一次 /v1/chat/completions（非流式），返回正文文本。
//   cfg: readConfig() 的返回值
//   opts: { system, messages:[{role,content}], temperature, timeoutMs }
//   ctx: 可选，用来写面板日志
// 失败一律 throw Error，message 可以直接显示给用户。
async function callChat(cfg, opts, ctx) {
    opts = opts || {};
    if (!cfg || !cfg.key) throw new Error(MSG_NO_KEY);

    var url = normalizeChatUrl(cfg && cfg.url);
    if (!url) throw new Error('AI 助手里的 URL 无效（要以 http:// 或 https:// 开头）');

    var messages = [];
    if (opts.system) messages.push({ role: 'system', content: String(opts.system) });
    var inMsgs = opts.messages || [];
    for (var i = 0; i < inMsgs.length; i++) {
        var m = inMsgs[i];
        if (!m || typeof m.content !== 'string' || !m.content.trim()) continue;
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        messages.push({ role: m.role, content: m.content });
    }
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
        throw new Error('没有要发给语言模型的内容');
    }

    var body = JSON.stringify({
        model: cfg.model,
        stream: false,
        temperature: (typeof opts.temperature === 'number') ? opts.temperature : 0.7,
        messages: messages
    });

    var timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    var controller = new AbortController();
    var timer = setTimeout(function() { try { controller.abort(); } catch (_) {} }, timeoutMs);

    var resp;
    var raw = '';
    try {
        resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + cfg.key
            },
            body: body,
            signal: controller.signal
        });
        raw = await resp.text();
    } catch (e) {
        if (e && e.name === 'AbortError') {
            throw new Error('语言模型请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）');
        }
        var nm = (e && e.message) || String(e);
        var host = url.replace(/^https?:\/\//i, '').split('/')[0];
        throw new Error('语言模型网络连接失败（' + host + '）: ' + nm);
    } finally {
        clearTimeout(timer);
    }

    if (!resp.ok) {
        throw new Error(_httpHint(resp.status) + (raw ? ' — ' + String(raw).slice(0, 200) : ''));
    }

    var json = null;
    try { json = JSON.parse(raw); } catch (_) {}
    var choice0 = json && json.choices && json.choices[0];
    var content = choice0 && choice0.message && choice0.message.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw new Error('语言模型返回格式异常（没有 content）' + (raw ? ' — ' + String(raw).slice(0, 200) : ''));
    }

    var usage = json && json.usage;
    if (usage && typeof usage.total_tokens === 'number') {
        _log(ctx, '[LLM] ' + cfg.model + ' tokens 输入 ' + (usage.prompt_tokens || 0) + ' / 输出 ' + (usage.completion_tokens || 0), 'info');
    }
    return content.trim();
}

module.exports = {
    DEFAULT_URL: DEFAULT_URL,
    DEFAULT_MODEL: DEFAULT_MODEL,
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    MSG_NO_KEY: MSG_NO_KEY,
    readConfig: readConfig,
    normalizeChatUrl: normalizeChatUrl,
    stripWrappingQuotes: stripWrappingQuotes,
    callChat: callChat
};
