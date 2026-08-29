// ============================================================
//  cv-shim.js — 轮椅幕布 的 TileAPI 薄替身
//  让主插件里的 tile-canvas.js 原封不动地在这个独立插件里跑。
//  做的事:
//    - 提供 window.TileAPI (registerTile / sendToHost / state / storage / toast / confirm / prompt / 算力目录)
//    - registerTile 后, 等持久化加载完, 把画布挂到全窗口 #cvMount
//    - sendToHost 路由到 window.CV_HOST 本地处理表, 结果带回原 reqId 喂给画布的 onMessage
//    - 提供 window._settingsGetActiveConnection 占位 (生成走 IPC 委托主插件, 不在本地解析 key)
// ============================================================
(function () {
'use strict';

var _uxpFs = null;
try { _uxpFs = require('uxp').storage.localFileSystem; } catch (e) { /* 非 UXP 环境(纯语法检查时) */ }

var STORE_FILE = 'canvas_shim_storage.json';

// ── 持久化存储 (启动异步读一次到内存, get/set 同步走内存, 写盘 debounce) ──
var _store = {};
var _storeReady = false;
var _writeTimer = null;

async function _loadStore() {
    try {
        if (_uxpFs) {
            var df = await _uxpFs.getDataFolder();
            var f = null;
            try { f = await df.getEntry(STORE_FILE); } catch (e) { f = null; }
            if (f) { var txt = await f.read(); if (txt) { try { _store = JSON.parse(txt) || {}; } catch (_) { _store = {}; } } }
        }
    } catch (e) { console.warn('[幕布] 读存档失败:', e && e.message); }
    _storeReady = true;
    _tryMount();
}
function _scheduleWrite() {
    if (_writeTimer) clearTimeout(_writeTimer);
    _writeTimer = setTimeout(_flushStore, 400);
}
async function _flushStore() {
    try {
        if (!_uxpFs) return;
        var df = await _uxpFs.getDataFolder();
        var f;
        try { f = await df.getEntry(STORE_FILE); } catch (e) { f = await df.createFile(STORE_FILE, { overwrite: true }); }
        await f.write(JSON.stringify(_store));
    } catch (e) { console.warn('[幕布] 写存档失败:', e && e.message); }
}

var storage = {
    get: function (k) { return _store[k]; },
    set: function (k, v) { _store[k] = v; _scheduleWrite(); },
    remove: function (k) { delete _store[k]; _scheduleWrite(); }
};

// ── 运行时 state (内存 + 合理默认, 模型/provider 后续可由 IPC 从主插件同步) ──
var _state = {
    'params.provider': 'aji',
    'params.size': '2K',
    'params.aspectRatio': 'Auto',
    'params.timeout': 3600,
    'presets.list': [],
    // 占位模型目录, 让生成节点 UI 能显示; 阶段4 再从主插件同步真实目录
    'models.aji': {
        'nano-banana': { name: 'Nano Banana', sizes: ['1K', '2K', '4K'] },
        'gpt-image-1': { name: 'GPT-Image', sizes: ['1K', '2K', '4K'] }
    }
};
var state = {
    get: function (k) { return _state[k]; },
    set: function (k, v) { _state[k] = v; }
};

// ── 画布挂载 ──
var _tileDef = null;
var _mounted = false;
var _cleanup = null;

function _tryMount() {
    if (_mounted || !_storeReady || !_tileDef) return;
    _mounted = true;
    var mountEl = document.getElementById('cvMount');
    if (!mountEl) { console.error('[幕布] 找不到 #cvMount'); return; }
    try { if (_tileDef.onStorageLoaded) _tileDef.onStorageLoaded(storage); } catch (e) { console.warn('[幕布] onStorageLoaded:', e && e.message); }
    try { _cleanup = _tileDef.onExpand(mountEl, { expandMode: 'full' }); }
    catch (e) { console.error('[幕布] onExpand 失败:', e); }
}

function registerTile(def) { _tileDef = def; _tryMount(); }

// ── 消息桥: sendToHost → 本地 CV_HOST 处理 → 结果带回 reqId 喂 onMessage ──
function _deliver(reqData, result) {
    if (!_tileDef || !_tileDef.onMessage) return;
    var payload = Object.assign({}, result || {});
    if (reqData && reqData.reqId != null) payload.reqId = reqData.reqId;
    try { _tileDef.onMessage('hostResult', payload); } catch (e) { console.error('[幕布] onMessage:', e); }
}
function sendToHost(action, data) {
    var handlers = window.CV_HOST || {};
    var fn = handlers[action];
    if (typeof fn !== 'function') {
        console.warn('[幕布] 未实现的 host 动作:', action);
        _deliver(data, { success: false, error: '未实现: ' + action });
        return;
    }
    Promise.resolve().then(function () { return fn(data || {}); })
        .then(function (result) { _deliver(data, result || { success: true }); })
        .catch(function (e) { _deliver(data, { success: false, error: (e && e.message) || String(e) }); });
}

// ── 轻量 UI: toast / confirm / prompt ──
function _toast(msg, level) {
    try {
        var el = document.createElement('div');
        var bg = level === 'error' ? '#b3261e' : level === 'warn' ? '#8a6d00' : level === 'success' ? '#1e6b3a' : '#2a2a36';
        el.textContent = String(msg == null ? '' : msg);
        el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99999;' +
            'background:' + bg + ';color:#fff;font-size:13px;padding:9px 16px;border-radius:8px;' +
            'box-shadow:0 6px 20px rgba(0,0,0,.45);max-width:80%;text-align:center;pointer-events:none;opacity:0;transition:opacity .15s';
        document.body.appendChild(el);
        requestAnimationFrame(function () { el.style.opacity = '1'; });
        setTimeout(function () { el.style.opacity = '0'; setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200); }, 2600);
    } catch (e) { console.log('[toast]', msg); }
}

function _modal(opts) {
    // opts: { message, defaultValue(若有则是输入框), okText, cancelText }
    return new Promise(function (resolve) {
        var mask = document.createElement('div');
        mask.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:99998;' +
            'background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center';
        var hasInput = (opts.defaultValue !== undefined && opts.defaultValue !== null);
        var box = document.createElement('div');
        box.style.cssText = 'background:#1e1e27;border:1px solid rgba(255,255,255,.14);border-radius:12px;' +
            'padding:18px;min-width:300px;max-width:80%;color:#ecedf2;font-size:13px;box-shadow:0 12px 44px rgba(0,0,0,.6)';
        var msg = document.createElement('div');
        msg.textContent = String(opts.message || '');
        msg.style.cssText = 'white-space:pre-wrap;line-height:1.6;margin-bottom:14px';
        box.appendChild(msg);
        var input = null;
        if (hasInput) {
            input = document.createElement('input');
            input.type = 'text';
            input.value = String(opts.defaultValue || '');
            input.style.cssText = 'width:100%;background:#0e0e15;color:#ecedf2;border:1px solid rgba(255,255,255,.14);' +
                'border-radius:6px;padding:8px;font-size:13px;margin-bottom:14px;box-sizing:border-box';
            box.appendChild(input);
        }
        var bar = document.createElement('div');
        bar.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
        var cancel = document.createElement('button');
        cancel.textContent = opts.cancelText || '取消';
        cancel.style.cssText = 'padding:7px 14px;border-radius:6px;border:1px solid rgba(255,255,255,.16);background:#30303d;color:#ecedf2;cursor:pointer';
        var ok = document.createElement('button');
        ok.textContent = opts.okText || '确定';
        ok.style.cssText = 'padding:7px 14px;border-radius:6px;border:none;background:#4a9eff;color:#fff;font-weight:600;cursor:pointer';
        bar.appendChild(cancel); bar.appendChild(ok);
        box.appendChild(bar); mask.appendChild(box); document.body.appendChild(mask);
        function close(v) { if (mask.parentNode) mask.parentNode.removeChild(mask); resolve(v); }
        cancel.addEventListener('click', function () { close(hasInput ? null : false); });
        ok.addEventListener('click', function () { close(hasInput ? (input ? input.value : '') : true); });
        mask.addEventListener('click', function (e) { if (e.target === mask) close(hasInput ? null : false); });
        if (input) { input.focus(); input.select(); input.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok.click(); else if (e.key === 'Escape') cancel.click(); }); }
    });
}

// ── 算力目录 (独立幕布先用静态/占位, 生成完全委托主插件) ──
function slotOrder() { return ['aji']; }
function slotLabel(engine, fallback) { return fallback || engine; }
function computeBrand() { return 'GRS'; }
function rebuildModelViews() { /* 独立幕布无动态目录, no-op */ }
function getFullCatalog(provider) { return _state['models.' + provider] || {}; }

// ── 暴露 ──
window.TileAPI = {
    registerTile: registerTile,
    sendToHost: sendToHost,
    state: state,
    storage: storage,
    toast: _toast,
    confirm: function (msg) { return _modal({ message: msg }); },
    prompt: function (msg, opts) { return _modal({ message: msg, defaultValue: (opts && opts.defaultValue) || '' }); },
    slotOrder: slotOrder,
    slotLabel: slotLabel,
    computeBrand: computeBrand,
    rebuildModelViews: rebuildModelViews,
    getFullCatalog: getFullCatalog
};

// 生成委托用: 返回占位连接, 让 tile-canvas 的 key 校验通过; 真正的 key/账号在主插件侧 (走 IPC)
window._settingsGetActiveConnection = function (provider) {
    return { provider: provider || (state.get('params.provider') || 'aji'), url: '', key: '__DELEGATE__', _grsKeyPending: false };
};

// 启动: 异步读存档, 读完 + registerTile 都就绪后挂载画布
_loadStore();

})();
