// ============================================================
//  轮椅遥控器 v2 — host 端 (index.js)
//  跟主插件 v6 (com.xiasanqi.ps.wheelchair.v4) 通过文件 IPC 通信
//
//  通道 (跟主插件 host/ipc.js 协议一致):
//    state.json    — 主→卫星, 任务列表 + UI 配置 + 缩略图引用, 200ms 轮询
//    command.json  — 卫星→主, 按钮命令, 主插件 500ms 轮询
//    thumbs/       — 缩略图目录, 卫星按需 fetch (阶段 2)
//
//  IPC 目录定位:
//    主插件 ID: com.xiasanqi.ps.wheelchair.v4 (v6 仍用 v4 id)
//    卫星 ID:   com.xiasanqi.ps.wheelchair.v6.satellite
//    路径推算: 卫星 temp 路径里 satellite ID → 主插件 ID
// ============================================================
var uxpStorage = require('uxp').storage;
var uxpFS = uxpStorage.localFileSystem;

var MAIN_PLUGIN_ID = 'com.xiasanqi.ps.wheelchair.v4';
var SATELLITE_PLUGIN_ID = 'com.xiasanqi.ps.wheelchair.v6.satellite';

var _ipcDir = null;
var _ipcDirLocal = null;
var _webview = null;
var _lastStateTs = 0;
var _lastThemeTs = 0;
var _statePollTimer = null;

function _log(msg) {
    console.log('[satellite] ' + msg);
    sendToPanel('log', { msg: msg });
}

function sendToPanel(action, data) {
    try {
        if (!_webview) _webview = document.getElementById('satelliteWebView');
        if (_webview && _webview.postMessage) {
            _webview.postMessage({ source: 'host', action: action, data: data || {} });
        }
    } catch (e) { console.error('[satellite] sendToPanel fail:', e); }
}

// ---------- IPC 目录定位 ----------
async function getIPCDir() {
    if (_ipcDir) return _ipcDir;
    try {
        var tempFolder = await uxpFS.getTemporaryFolder();
        var satPath = tempFolder.nativePath || '';
        console.log('[satellite] sat temp path:', satPath);

        // 卫星自己的目录 (备用 + 写命令时可能用)
        try { _ipcDirLocal = await tempFolder.getEntry('wheelchair_ipc'); }
        catch (e) { _ipcDirLocal = await tempFolder.createFolder('wheelchair_ipc'); }

        // 推算主插件目录
        var mainPath = satPath.replace(SATELLITE_PLUGIN_ID, MAIN_PLUGIN_ID);
        console.log('[satellite] main path guess:', mainPath);

        if (mainPath === satPath) {
            // 路径里没找到 satellite ID, 推算失败 → 降级
            _log('IPC 推算失败(路径里没找到自己的 ID), 用本地目录');
            _ipcDir = _ipcDirLocal;
            return _ipcDir;
        }

        try {
            var mainPathUrl = 'file:' + mainPath.replace(/\\/g, '/');
            var mainFolder = await uxpFS.getEntryWithUrl(mainPathUrl);
            try { _ipcDir = await mainFolder.getEntry('wheelchair_ipc'); }
            catch (e2) { _ipcDir = await mainFolder.createFolder('wheelchair_ipc'); }
            _log('IPC(主): ' + (_ipcDir.nativePath || '?'));
            return _ipcDir;
        } catch (e3) {
            _log('无法访问主插件目录, 降级到本地: ' + e3.message);
            _ipcDir = _ipcDirLocal;
            return _ipcDir;
        }
    } catch (e) {
        _log('getIPCDir 失败: ' + e.message);
        return null;
    }
}

// ---------- 文件读写 ----------
async function readJsonFile(name) {
    try {
        var dir = await getIPCDir();
        if (!dir) return null;
        var file = await dir.getEntry(name);
        var text = await file.read();
        if (!text || text.length < 3) return null;
        return JSON.parse(text);
    } catch (e) { return null; }
}

async function writeCommand(action, data) {
    try {
        var dir = await getIPCDir();
        if (!dir) { _log('writeCommand 失败: 无 IPC 目录'); return; }
        var cmd = JSON.stringify({ ts: Date.now(), action: action, data: data || {} });
        var file;
        try { file = await dir.getEntry('command.json'); }
        catch (e) { file = await dir.createFile('command.json'); }
        await file.write(cmd);
        console.log('[satellite] cmd:', action);
    } catch (e) {
        _log('writeCommand 失败: ' + e.message);
    }
}

// ---------- 缩略图按需读取 ----------
async function readThumbBase64(thumbName) {
    try {
        var dir = await getIPCDir();
        if (!dir) return null;
        var thumbsFolder;
        try { thumbsFolder = await dir.getEntry('thumbs'); }
        catch (e) { return null; }
        var file = await thumbsFolder.getEntry(thumbName);
        if (!file) return null;
        // jpeg 文件 → 读为 binary → 转 base64
        var buf = await file.read({ format: uxpStorage.formats.binary });
        var bytes = new Uint8Array(buf);
        var bin = '';
        var chunk = 8192;
        for (var i = 0; i < bytes.length; i += chunk) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(bin);
    } catch (e) {
        console.warn('[satellite] readThumb fail', thumbName, e.message);
        return null;
    }
}

// ---------- 轮询 ----------
async function pollState() {
    var s = await readJsonFile('state.json');
    if (s && s.ts > _lastStateTs) {
        _lastStateTs = s.ts;
        sendToPanel('stateUpdate', s);
    }
    // 顺便低频查 theme.json (轻, JSON 几 KB)
    var t = await readJsonFile('theme.json');
    if (t && t.ts > _lastThemeTs) {
        _lastThemeTs = t.ts;
        sendToPanel('themeUpdate', t.theme || {});
    }
}

function startPolling() {
    if (_statePollTimer) return;
    _statePollTimer = setInterval(pollState, 100);
    _log('轮询已启动 (state 100ms)');
}

function stopPolling() {
    if (_statePollTimer) { clearInterval(_statePollTimer); _statePollTimer = null; }
}

// ---------- 接收 panel 消息 ----------
window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.source !== 'panel') return;

    if (msg.action === 'ready') {
        console.log('[satellite] panel ready');
        getIPCDir().then(function (dir) {
            var dirPath = dir ? (dir.nativePath || '?') : 'FAIL';
            sendToPanel('initInfo', {
                ipcDir: dirPath,
                version: '2.0.0',
                mainId: MAIN_PLUGIN_ID,
                satId: SATELLITE_PLUGIN_ID
            });
            // 立刻拉一次现有 state, 不用等 300ms
            pollState();
            startPolling();
        });
        return;
    }

    if (msg.action === 'sendCommand') {
        writeCommand(msg.data.action, msg.data.data);
        return;
    }

    if (msg.action === 'fetchThumb') {
        // panel 请求一张缩略图: { reqId, thumbName }
        readThumbBase64(msg.data.thumbName).then(function (b64) {
            sendToPanel('thumbResult', {
                reqId: msg.data.reqId,
                thumbName: msg.data.thumbName,
                base64: b64,
                success: !!b64
            });
        });
        return;
    }

    if (msg.action === 'pollNow') {
        // 强制立即轮询一次 (按钮按下后催一次)
        pollState();
        return;
    }
});

// ---------- entrypoints ----------
try {
    var ep = require('uxp').entrypoints;
    if (ep && ep.setup) {
        ep.setup({
            panels: {
                satellitePanel: {
                    create: function () { console.log('[satellite] create'); },
                    show: function () { console.log('[satellite] show'); },
                    hide: function () { console.log('[satellite] hide'); },
                    destroy: function () {
                        console.log('[satellite] destroy');
                        stopPolling();
                    }
                }
            }
        });
    }
} catch (e) { console.error('[satellite] entrypoints fail:', e); }

console.log('[satellite] index.js loaded, version 2.0.0');
