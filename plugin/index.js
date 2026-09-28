// ============================================================
//  index.js - 宿主端脚本 (UXP 环境)
//  负责：Photoshop API 调用、文件系统操作、网络请求
//  通过 postMessage 与 WebView (panel.js) 通信
//
//  Copyright (C) 2026 xiasanqi (夏三七)
//  This program is free software: you can redistribute it and/or
//  modify it under the terms of the GNU General Public License as
//  published by the Free Software Foundation, either version 3 of
//  the License, or (at your option) any later version.
//
//  This program is distributed in the hope that it will be useful,
//  but WITHOUT ANY WARRANTY; without even the implied warranty of
//  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
//  GNU General Public License for more details.
//
//  You should have received a copy of the GNU General Public License
//  along with this program. If not, see <https://www.gnu.org/licenses/>.
// ============================================================

const { app, core } = require("photoshop");
const imaging = require("photoshop").imaging;
const uxpModule = require("uxp");
const { storage } = uxpModule;
const fs = storage.localFileSystem;

// cloudService / comfyEngine 已迁移到各 tile host.js 中直接 require

// === Host 路由模块（拆解过渡） ===
const hostRouter = require("./host/router.js");
const hostApi = require("./host/host-api.js");
const hostContextBuilder = require("./host/context-builder.js");
const recordableActions = require("./host/recordable-actions.js");
const concurrencyPool = require("./host/concurrency-pool.js");

// === 磁贴后端插件系统 ===
const tileHostLoader = require("./host/tile-host-loader.js");

// === 宿主共享工具 ===
const psPixels = require("./host/ps-pixels.js");
const arrayBufferToBase64 = psPixels.arrayBufferToBase64;
const base64ToArrayBuffer = psPixels.base64ToArrayBuffer;
const pixelsHueShift180 = psPixels.pixelsHueShift180;
const pixelsFlipVertical = psPixels.pixelsFlipVertical;
const encodeJPEGFromRGB = psPixels.encodeJPEGFromRGB;
const encodePNGFromRGB = psPixels.encodePNGFromRGB;
const injectSRGBChunkIntoPNG = psPixels.injectSRGBChunkIntoPNG;

// 启动时立刻开始扫描并 require 所有 tiles/*.host.js
// 这是个 Promise，handleMessage 里会 await 它，保证所有 action 注册完再分发
var g_hostPluginsReady = tileHostLoader.loadTileHosts(uxpModule)
    .then(function(result) {
        if (result.failed && result.failed.length) {
            console.warn('[宿主] 部分 tile host 加载失败:', result.failed);
        }
        return result;
    })
    .catch(function(err) {
        console.error('[宿主] tile host 扫描异常:', err && err.message);
        return { discovered: 0, loaded: [], failed: [] };
    });

// === 全局变量 ===
var g_antiTruncationMode = 0;
var g_autoPadCrop = false;   // 自动扩充+裁切: 1:1 生图且选区非方形时, 补白凑方/回图裁白
var g_fix4kMagenta = false;   // v6.6.0: 4K偏色自动矫正已停用(设置开关删除), 恒 false; 曲线代码保留未删
var g_layerType = 'smartObject';
var g_maxResolution = 2048;
var g_autoGroup = true;
var g_autoSelectFullCanvasNoSelection = false;
var g_teachMode = false;
var g_earlyStop = false;
var g_activeControllers = []; // 所有活跃请求的 {controller, timeoutId, startTime} 数组
var g_taskControllers = {}; // 按taskId分组的控制器: { taskId: [{controller, timeoutId}] }
var g_taskEarlyStop = {}; // 按taskId的提前结束标志: { taskId: true/false }
var g_lastSelection = null; // 保存最后一次选区坐标 {left, top, right, bottom, width, height}
var g_lastSelectionDocId = null; // 保存选区所属文档ID
var g_lastCaptureBase64 = null; // 保存最近一次抓取到的主图base64，供ComfyUI同批次任务复用
var g_colorStable = false; // 色彩稳定模式总开关:开则抓图转sRGB+回传标记sRGB+位深gamma修正+自检日志
var g_returnFeatherEnabled = false;
var g_returnFeatherWorkflows = {
    bananaSingle: false,
    bananaBatch: false,
    tiledUpscale: false,
    forge: false,
    comfyui: false
};
var g_returnFeatherShrinkPercent = 10;
var g_returnFeatherBlurPercent = 8;
var g_taskAutoReturn = {}; // taskId -> bool
var g_taskResultCache = {}; // taskId -> { originDocId, savedSelection, antiMode, layerType, payloads, groupName }
var g_taskCompleteSent = {}; // taskId -> bool，避免重复发送 taskComplete

// === WebView 持久化存储 ===
// 防 PS 闪退/掉电时丢数据 (bug ①):
//   1. 原子写: 先写 .writing 临时文件, 写完才删旧/rename, 中间崩不会让主文件留空
//   2. 关键 key (API key, 布局, 主题等) 立即写盘, 不走 debounce
//   3. 普通 key debounce 200ms (从 500ms 砍半, 再缩小普通 key 的丢失窗口)
//   4. 启动时如果主文件没了, 优先用 .writing 临时文件 → .bak 冷备份恢复
//   5. 全局互斥锁: 所有读/写串行化, 避免并发覆盖导致空文件 (panel 多条 storageSet 一齐到的情况)
//   6. 启动时立刻 loadHostStorage, ready 消息只是 await 已有 Promise, 避免 storageSet 抢跑写空盘
// ============================================================
var STORAGE_FILE = "webview_storage.json";
var STORAGE_FILE_TMP = "webview_storage.json.writing";
var STORAGE_FILE_BAK = "webview_storage.json.bak";
var _hostStorage = {};

// 互斥锁: 任意时刻只有一个 load/save 在跑.
// 用 Promise 链做"串行队列" — 简单可靠, 不需要外部依赖.
// 注意: catch 兜底是关键 — 一次失败也不能锁死后面的请求.
var _storageBusy = Promise.resolve();
function _withStorageLock(fn) {
    var next = _storageBusy.then(function() { return fn(); }, function() { return fn(); });
    _storageBusy = next.catch(function() {});
    return next;
}

// 关键 key 白名单 — 命中立刻写盘, 绝不容忍丢失
// 修这里时要谨慎: 加得太多 = IO 频繁; 漏掉真正关键的 = 用户掉数据
var CRITICAL_KEY_EXACT = {
    '__tile_layout_v6': 1,
    '__tile_groups_v6': 1,
    '__v6_migrated': 1
};
var CRITICAL_KEY_PREFIXES = [
    'connection.',   // API URL / Key (最最关键)
    'appearance.',   // 主题/背景/缩放
    'params.',       // 生成参数
    'forge.',        // Forge 配置
    'comfyui.',      // ComfyUI 配置
    'chat.api',      // 聊天 API URL/Key
    'presets.',      // 预设 (data + 元数据)
    'grs.',          // GRS 配置/积分
    'aji.',          // AJI 缓存 URL 列表等
    'balance.',      // 余额阈值
    'auth.',         // 登录信息
    'others.',       // others provider 多配置
    'satellite.',    // 卫星设置
    'firstrun.'      // 首次启动标记
];
function isCriticalKey(key) {
    if (!key || typeof key !== 'string') return false;
    if (CRITICAL_KEY_EXACT[key]) return true;
    for (var i = 0; i < CRITICAL_KEY_PREFIXES.length; i++) {
        if (key.indexOf(CRITICAL_KEY_PREFIXES[i]) === 0) return true;
    }
    return false;
}

async function _loadHostStorageImpl() {
    var dataFolder;
    try {
        dataFolder = await fs.getDataFolder();
    } catch(e) {
        console.warn("[存储] 拿不到 dataFolder:", e.message);
        if (!_hostStorage) _hostStorage = {};
        return;
    }

    // 三级降级: 主文件 → .writing (上次写到一半崩了) → .bak (主文件被损坏时的冷备份)
    async function _tryRead(name) {
        var file;
        try { file = await dataFolder.getEntry(name); } catch(e) { return null; }
        var text;
        try { text = await file.read(); } catch(e) {
            console.warn("[存储] 读取 " + name + " 失败:", e.message);
            return null;
        }
        if (!text || !text.trim()) return null;
        try {
            var parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object') return { entry: file, data: parsed };
        } catch(e) {
            console.warn("[存储] 解析 " + name + " 失败:", e.message);
        }
        return null;
    }

    var main = await _tryRead(STORAGE_FILE);
    if (main) {
        _hostStorage = main.data;
        console.log("[存储] 已加载持久化数据, keys:", Object.keys(_hostStorage).length);
        // 顺手清掉残留的 .writing 临时文件 (上次正常保存后没清干净的情况)
        try {
            var tmpEntry = await dataFolder.getEntry(STORAGE_FILE_TMP);
            await tmpEntry.delete();
        } catch(_) {}
        return;
    }

    // 主文件不可用 → 尝试 .writing 临时文件恢复
    var tmp = await _tryRead(STORAGE_FILE_TMP);
    if (tmp) {
        console.warn("[存储] 主文件不可用, 用 .writing 临时文件恢复, keys:", Object.keys(tmp.data).length);
        _hostStorage = tmp.data;
        // 临时文件升级为主文件
        try { await tmp.entry.rename(STORAGE_FILE); } catch(e) {
            console.warn("[存储] rename .writing → 主文件失败:", e.message);
        }
        return;
    }

    // 主文件 + .writing 都不行 → 最后救命稻草: .bak 冷备份
    var bak = await _tryRead(STORAGE_FILE_BAK);
    if (bak) {
        console.warn("[存储] 主+临时都丢了, 从 .bak 冷备份恢复, keys:", Object.keys(bak.data).length);
        _hostStorage = bak.data;
        return;
    }

    console.log("[存储] 无已有数据(首次启动或全部损坏)");
    if (!_hostStorage) _hostStorage = {};
}

// 原子写: 先写 .writing, 再删旧主文件, 再 rename 临时为主文件, 最后顺手刷一份 .bak 冷备份
// 中途崩在任何步骤, loadHostStorage 都能从三个文件之一恢复
async function _saveHostStorageImpl() {
    try {
        var dataFolder = await fs.getDataFolder();
        var json = JSON.stringify(_hostStorage);

        // 【不再用 .writing+rename】UXP entry.rename 在本环境频繁失败(目标已存在时尤甚),
        //   会让主文件卡在 .writing / 丢失。改为: 先写 .bak 冷备份, 再 overwrite 直接写主文件。
        //   主文件写崩时, 启动 loadHostStorage 仍能从 .bak 恢复(三级降级里已含)。
        // 1. 先写 .bak 冷备份 (主文件写崩时的救命稻草)
        try {
            var bakFile = await dataFolder.createFile(STORAGE_FILE_BAK, { overwrite: true });
            await bakFile.write(json);
        } catch(bakErr) {
            console.warn("[存储] 写 .bak 备份失败 (不致命):", bakErr.message);
        }

        // 2. 直接覆盖写主文件 (不依赖 rename)
        var mainFile = await dataFolder.createFile(STORAGE_FILE, { overwrite: true });
        await mainFile.write(json);

        // 3. 顺手清掉历史遗留的 .writing 临时文件 (旧版本可能留下的)
        try { var staleTmp = await dataFolder.getEntry(STORAGE_FILE_TMP); await staleTmp.delete(); } catch(_) {}
    } catch(e) {
        console.warn("[存储] 保存失败:", e.message);
    }
}

// 对外暴露的 load/save 全部走互斥锁 — 调用方不用关心并发
function loadHostStorage() { return _withStorageLock(_loadHostStorageImpl); }
function saveHostStorage() { return _withStorageLock(_saveHostStorageImpl); }

// 启动时立刻启动加载 — 不等 panel 的 'ready' 消息.
// 这样 panel 端的 storageSet 即使早到了, 也会先 await 这个 Promise 才动 _hostStorage.
// 防 bug: 之前 panel 多发几个 storageSet 时, 第一个 storageSet 在 loadHostStorage 进 await 时切进来,
//        给空 _hostStorage 写了一个 key, 然后立即触发关键 key 写盘, 主文件被覆盖成"只有一个 key"的版本.
var g_storageReady = loadHostStorage();

// 防抖保存 (普通 key) — 200ms, 比原 500ms 短, 缩小丢失窗口
var _saveTimer = null;
function debounceSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(function() { saveHostStorage(); }, 200);
}

// 立即落盘 (关键 key) — 取消 debounce + await 写完
async function saveImmediate() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    await saveHostStorage();
}

// 统一入口: bootstrap-handlers 在 storageSet/Remove 后调这个
//   关键 key 命中 → 立即 await 写盘 (返回 Promise)
//   普通 key → 走 debounce (返回 undefined)
function saveAfterChange(key) {
    if (isCriticalKey(key)) return saveImmediate();
    debounceSave();
}

var sleep = function(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); };

// === 获取 WebView 引用 ===
var _hasDOM = (typeof document !== 'undefined');
var wv = _hasDOM ? document.getElementById('panelWebView') : null;

function getWebView() {
    if (typeof document === 'undefined') return null;
    return document.getElementById("panelWebView");
}

// === 向 WebView 发送消息 ===
function sendToPanel(action, data) {
    var w = getWebView();
    if (w) {
        w.postMessage({ source: 'host', action: action, data: data }, '*');
    }
}

function logToPanel(message, type) {
    sendToPanel('log', { message: message, type: type || 'info' });
}

function sendTaskCompleteOnce(taskId, data) {
    if (!taskId) {
        sendToPanel('taskComplete', data || {});
        return;
    }
    if (g_taskCompleteSent[taskId]) return;
    g_taskCompleteSent[taskId] = true;
    sendToPanel('taskComplete', data || {});
    // 任务完成后清理 earlyStop 标志, 防字典只增不删。
    // ★只清"正常完成"(标志为 false)的: 被停止的任务(true)必须留碑 —
    //   软中断的图几分钟后才回来, 靠这个标志判"迟到"打 ⏸; 删早了图就成孤儿(用户实测三连踩)。
    //   被停任务的碑很少, 字典不会失控; 全局 earlyStop 遍历把碑设 true 也无害(任务早结束了)。
    // 注意: g_taskCompleteSent 是防重复完成的锁, 不能删; g_taskAutoReturn/g_taskResultCache 与手动取回相关, 也不在此删。
    try { if (!g_taskEarlyStop[taskId]) delete g_taskEarlyStop[taskId]; } catch (_) {}
}

// === 工具函数 ===
// arrayBufferToBase64 / base64ToArrayBuffer 已迁移到 host/ps-pixels.js

// === 音效模块 ===
var _soundMod = require("./host/sound.js").createSoundModule({
    fs: fs, storage: storage,
    getHostStorage: function() { return _hostStorage; },
    arrayBufferToBase64: arrayBufferToBase64, sendToPanel: sendToPanel
});
var scanSoundFiles = _soundMod.scanSoundFiles;
var findSoundFileEntry = _soundMod.findSoundFileEntry;
var playSoundByType = _soundMod.playSoundByType;
var playSuccessSound = _soundMod.playSuccessSound;
var playAllFailSound = _soundMod.playAllFailSound;
var playSingleFailSound = _soundMod.playSingleFailSound;

// === 文件/文件夹工具模块 ===
var _fsUtilsMod = require("./host/fs-utils.js").createFsUtilsModule({
    fs: fs, storage: storage, uxpModule: uxpModule,
    logToPanel: logToPanel, sendToPanel: sendToPanel,
    base64ToArrayBuffer: base64ToArrayBuffer,
    getReturnFeatherEnabled: function() { return g_returnFeatherEnabled; },
    getReturnFeatherWorkflows: function() { return g_returnFeatherWorkflows; }
});
var openFolderWithMultipleMethods = _fsUtilsMod.openFolderWithMultipleMethods;
var sanitizeFileName = _fsUtilsMod.sanitizeFileName;
var getUniqueFileName = _fsUtilsMod.getUniqueFileName;
var getOrCreateImageCacheFolder = _fsUtilsMod.getOrCreateImageCacheFolder;
var beginImageCacheClear = _fsUtilsMod.beginImageCacheClear;
var endImageCacheClear = _fsUtilsMod.endImageCacheClear;
var _sanitizeRunFolderPart = _fsUtilsMod._sanitizeRunFolderPart;
var createImageCacheRunFolder = _fsUtilsMod.createImageCacheRunFolder;
var saveImageToRunFolder = _fsUtilsMod.saveImageToRunFolder;
var savePromptTxtToRunFolder = _fsUtilsMod.savePromptTxtToRunFolder;
var deleteFolderContents = _fsUtilsMod.deleteFolderContents;
var getOrCreateChatDataFolder = _fsUtilsMod.getOrCreateChatDataFolder;
var getOrCreatePresetsFolder = _fsUtilsMod.getOrCreatePresetsFolder;
var getOrCreateForgePresetsFolder = _fsUtilsMod.getOrCreateForgePresetsFolder;
var normalizeReturnFeatherWorkflows = _fsUtilsMod.normalizeReturnFeatherWorkflows;
var shouldApplyReturnFeather = _fsUtilsMod.shouldApplyReturnFeather;

// === IPC 模块 ===
var _ipcMod = require("./host/ipc.js").createIPCModule({
    fs: fs, sendToPanel: sendToPanel
});
var initIPC = _ipcMod.initIPC;
var ipcWriteState = _ipcMod.ipcWriteState;
var ipcPollCommand = _ipcMod.ipcPollCommand;
var ipcReadCommand = _ipcMod.ipcReadCommand;

// === PS锁模块 ===
var _psLockMod = require("./host/ps-lock.js").createPSLock({ sleep: sleep });
var acquirePSLock = _psLockMod.acquirePSLock;
var _processPSLock = _psLockMod._processPSLock;
var clearPSLockQueue = _psLockMod.clearPSLockQueue;

// === 卫星事件侦听 (PS 图层失效检测, 不调 executeAsModal, 不会闪烁) ===
try { require('./host/satellite-events.js').init(sendToPanel); } catch (e) { console.warn('[satellite-events] init fail:', e); }

// === 清理 dataFolder 里的更新残留, 防止用户翻出旧 bat 双击导致误操作 ===
// (新版 ps1 已经会拒绝陈年 config, 但提前清掉更稳, 让用户根本找不到 bat)
(async function _cleanupUpdateLeftovers() {
    try {
        var dataFolder = await fs.getDataFolder();
        var leftovers = ['update_plugin.bat', 'update_plugin.ps1', 'update_config.json', 'update.zip'];
        for (var i = 0; i < leftovers.length; i++) {
            try {
                var entry = await dataFolder.getEntry(leftovers[i]);
                if (entry) await entry.delete();
            } catch(_) { /* 不存在就跳过, 正常情况 */ }
        }
    } catch(e) {
        console.warn('[更新清理] 跳过:', e.message);
    }
})();

// === AI API 模块 ===
var _aiApiMod = require("./host/ai-api.js").createAiApiModule({
    logToPanel: logToPanel, base64ToArrayBuffer: base64ToArrayBuffer,
    getActiveControllers: function() { return g_activeControllers; },
    setActiveControllers: function(v) { g_activeControllers = v; },
    getTaskControllers: function() { return g_taskControllers; },
    getEarlyStop: function() { return g_earlyStop; },
    getTaskEarlyStop: function() { return g_taskEarlyStop; },
    getHostStorage: function() { return _hostStorage; },
    sendToPanel: sendToPanel
});
var getErrorMessage = _aiApiMod.getErrorMessage;
var getErrorSolution = _aiApiMod.getErrorSolution;
var sanitizePrompt = _aiApiMod.sanitizePrompt;
var callAiApi = _aiApiMod.callAiApi;
var abortAllActiveRequests = _aiApiMod.abortAllActiveRequests;
var extendAllTimeouts = _aiApiMod.extendAllTimeouts;

// === 回收站模块 ===
var _recycleBin = require("./host/recycle-bin.js").createRecycleBinModule({
    fs: fs,
    storage: storage,
    base64ToArrayBuffer: base64ToArrayBuffer,
    arrayBufferToBase64: arrayBufferToBase64,
    encodeJPEGFromRGB: encodeJPEGFromRGB,
    logToPanel: logToPanel
});
// 给磁贴的归档入口: 统一签名 (meta, base64, status, errMsg)
// ★ update-or-insert: 先 update (任务启动时已 beginBatchPending 占过位), 找不到才 insert (旧调用兼容)
async function archiveToRecycleBin(meta, base64, status, errMsg) {
    var item = await _recycleBin.updateItem(meta && meta.id, status, base64, errMsg);
    if (!item) {
        item = await _recycleBin.archiveTask(meta, base64, status, errMsg);
    }
    try { sendToPanel('recycleNewArchived', { id: item && item.id, status: status }); } catch(_) {}
    return item;
}

// 任务启动时调一次, 把 N 个 _archMeta 一次性插成 pending 占位
async function beginBatchPendingArchive(metas) {
    var n = await _recycleBin.beginBatchPending(metas);
    try { sendToPanel('recycleNewArchived', { count: n, pending: true }); } catch(_) {}
    return n;
}

// 启动时清理孤儿 pending (PS 上次没跑完就退出的) — 不阻塞启动, 失败下次重试
_recycleBin.cleanupOrphanPending().then(function(n) {
    if (n > 0) logToPanel('[回收站] 清理 ' + n + ' 条 PS 重启未完成的占位', 'info');
}).catch(function() {});

// === PS IO 模块 ===
var _psIoMod = require("./host/ps-io.js").createPSIOModule({
    app: app, core: core, imaging: imaging, fs: fs, storage: storage,
    logToPanel: logToPanel, sendToPanel: sendToPanel,
    base64ToArrayBuffer: base64ToArrayBuffer, arrayBufferToBase64: arrayBufferToBase64,
    pixelsHueShift180: pixelsHueShift180, pixelsFlipVertical: pixelsFlipVertical,
    encodeJPEGFromRGB: encodeJPEGFromRGB, encodePNGFromRGB: encodePNGFromRGB,
    injectSRGBChunkIntoPNG: injectSRGBChunkIntoPNG,
    shouldApplyReturnFeather: shouldApplyReturnFeather,
    state: {
        getAntiTruncationMode: function() { return g_antiTruncationMode; },
        setAntiTruncationMode: function(v) { g_antiTruncationMode = v; },
        getMaxResolution: function() { return g_maxResolution; },
        setMaxResolution: function(v) { g_maxResolution = v; },
        getAutoSelectFullCanvasNoSelection: function() { return g_autoSelectFullCanvasNoSelection; },
        getTeachMode: function() { return g_teachMode; },
        getColorStable: function() { return g_colorStable; },
        getLastSelection: function() { return g_lastSelection; },
        getLastSelectionDocId: function() { return g_lastSelectionDocId; },
        getReturnFeatherShrinkPercent: function() { return g_returnFeatherShrinkPercent; },
        getReturnFeatherBlurPercent: function() { return g_returnFeatherBlurPercent; },
        getHostStorage: function() { return _hostStorage; }
    }
});
var deselectAll = _psIoMod.deselectAll;
var getSelectionAndImage = _psIoMod.getSelectionAndImage;
var placeImageToSpecificDoc = _psIoMod.placeImageToSpecificDoc;
var placeImageFileToSpecificDoc = _psIoMod.placeImageFileToSpecificDoc;   // 大图: 从磁盘文件置入(不走base64)
var placeImagesBatch = _psIoMod.placeImagesBatch;

// ── 急速回图统一入口(v6.5.8): 所有批量贴回都走这里, 开关二选一 ──
//   开(output.fastReturn=true): placeImagesBatch 单次修改权+历史合并(快3~4倍)
//   关(默认): 老的逐张 placeImageToSpecificDoc + 60ms 间隔(与历史行为完全一致)
//   items: [{base64, selection, antiMode, layerType}]  返回 [layerId|null]
async function placeImagesAuto(targetDocId, items, onEach) {
    var fast = false;
    try {
        var _fv = _hostStorage && _hostStorage['output.fastReturn'];
        fast = (_fv === true || _fv === 'true');   // panel storageSet 发的是 JSON 字符串
    } catch(_) {}
    if (fast && placeImagesBatch) {
        logToPanel('[急速回图] 批量贴回 ' + items.length + ' 张(单次修改权)…', 'info');
        return await placeImagesBatch(targetDocId, items, onEach);
    }
    var out = [];
    for (var i = 0; i < items.length; i++) {
        var lid = null;
        try {
            lid = await placeImageToSpecificDoc(items[i].base64, targetDocId, items[i].selection, items[i].antiMode || 0, items[i].layerType || 'smartObject');
        } catch(e) {
            logToPanel('[回图] 第 ' + (i + 1) + ' 张失败(跳过): ' + ((e && e.message) || e), 'warn');
        }
        out.push(lid);
        if (onEach) { try { onEach(i, lid); } catch(_) {} }
        if (i < items.length - 1) await new Promise(function(r) { setTimeout(r, 60); });
    }
    return out;
}
var createGroupAndMask = _psIoMod.createGroupAndMask;
var applyMagentaFixCurveToGroup = _psIoMod.applyMagentaFixCurveToGroup;
var createTeachingMaterials = _psIoMod.createTeachingMaterials;
var getSelectionRectSafe = _psIoMod.getSelectionRectSafe;
var applyReturnFeatherMaskToLayer = _psIoMod.applyReturnFeatherMaskToLayer;
var calculatePartitionSelections = _psIoMod.calculatePartitionSelections;
var handleCaptureRefImage = _psIoMod.handleCaptureRefImage;
var handleRecaptureMainImage = _psIoMod.handleRecaptureMainImage;
var handleRecaptureRefImage = _psIoMod.handleRecaptureRefImage;
var handleRestoreSelection = _psIoMod.handleRestoreSelection;
var handleRestoreSelectionFromHistory = _psIoMod.handleRestoreSelectionFromHistory;
var handleCaptureForChat = _psIoMod.handleCaptureForChat;
var probeSelectionRect = _psIoMod.probeSelectionRect;
var setMarqueeAspectPreset = _psIoMod.setMarqueeAspectPreset;
var importMarqueePresets = _psIoMod.importMarqueePresets;

// deselectAll 已迁移到 host/ps-io.js

// openFolderWithMultipleMethods 已迁移到 host/fs-utils.js

// getErrorMessage / getErrorSolution 已迁移到 host/ai-api.js

// ============================================================
//  像素处理工具函数（纯内存，零闪烁）
//  pixelsHueShift180 / pixelsFlipVertical / encodeJPEGFromRGB / encodePNGFromRGB
//  已迁移到 host/ps-pixels.js
// ============================================================

// getSelectionAndImage / placeImageToSpecificDoc / createGroupAndMask / getSelectionRectSafe / applyReturnFeatherMaskToLayer / calculatePartitionSelections 已迁移到 host/ps-io.js

// scanSoundFiles / findSoundFileEntry / playSoundByType / playSuccessSound / playAllFailSound / playSingleFailSound 已迁移到 host/sound.js

// exportPreset / importPreset 已迁移到 tiles/tile-presets.host.js

// handleCalibrateBalance 已迁移到 tiles/tile-tasks.host.js

// ============================================================
//  处理来自 WebView 的消息
// ============================================================

console.log("[宿主] wv 元素:", wv, "tagName:", wv ? wv.tagName : "null");

// 高频消息日志开关: 默认关 (每条消息都 JSON.stringify 很贵, 调试时改成 true)
var DEBUG_MSG_LOG = false;
function setupMessageListener() {
    if (wv && typeof wv.addEventListener === 'function') {
        wv.addEventListener("message", function(event) {
            if (DEBUG_MSG_LOG) console.log("[宿主] wv.message:", (JSON.stringify(event.data) || "(undefined)").substring(0, 200));
            handleMessage(event.data);
        });
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener("message", function(event) {
            if (DEBUG_MSG_LOG) console.log("[宿主] window.message:", (JSON.stringify(event.data) || "(undefined)").substring(0, 200));
            handleMessage(event.data);
        });
    }
}


// handleStartTiledUpscale / executeTiledUpscale / handleTiledFillTest 已迁移到 tiles/tile-tiled.host.js


function buildHostContext() {
    return hostContextBuilder.createHostContext({
        storage: storage,
        uxpModule: uxpModule,
        psAppVersion: '', // PS版本通过 batchPlay 在 ready 阶段异步获取
        sendToPanel: sendToPanel,
        logToPanel: logToPanel,
        arrayBufferToBase64: arrayBufferToBase64,
        findSoundFileEntry: findSoundFileEntry,
        scanSoundFiles: scanSoundFiles,
        getOrCreateChatDataFolder: getOrCreateChatDataFolder,
        getOrCreateImageCacheFolder: getOrCreateImageCacheFolder,
        beginImageCacheClear: beginImageCacheClear,
        endImageCacheClear: endImageCacheClear,
        deleteFolderContents: deleteFolderContents,

        loadHostStorage: loadHostStorage,
        storageReady: g_storageReady,
        debounceSave: debounceSave,
        cancelDebounce: function() { if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; } },
        saveHostStorage: saveHostStorage,
        saveImmediate: saveImmediate,
        saveAfterChange: saveAfterChange,
        isCriticalKey: isCriticalKey,
        hostStorageRef: {
            get value() { return _hostStorage; },
            set value(v) { _hostStorage = v || {}; }
        },
        g_antiTruncationModeRef: {
            get value() { return g_antiTruncationMode; },
            set value(v) { g_antiTruncationMode = v; }
        },
        g_autoPadCropRef: {
            get value() { return g_autoPadCrop; },
            set value(v) { g_autoPadCrop = !!v; }
        },
        g_fix4kMagentaRef: {
            get value() { return g_fix4kMagenta; },
            set value(v) { g_fix4kMagenta = !!v; }
        },
        g_colorStableRef: {
            get value() { return g_colorStable; },
            set value(v) { g_colorStable = !!v; }
        },
        g_layerTypeRef: {
            get value() { return g_layerType; },
            set value(v) { g_layerType = v; }
        },
        g_maxResolutionRef: {
            get value() { return g_maxResolution; },
            set value(v) { g_maxResolution = v; }
        },
        g_autoGroupRef: {
            get value() { return g_autoGroup; },
            set value(v) { g_autoGroup = !!v; }
        },
        g_autoSelectFullCanvasNoSelectionRef: {
            get value() { return g_autoSelectFullCanvasNoSelection; },
            set value(v) { g_autoSelectFullCanvasNoSelection = !!v; }
        },
        g_teachModeRef: {
            get value() { return g_teachMode; },
            set value(v) { g_teachMode = !!v; }
        },
        g_returnFeatherEnabledRef: {
            get value() { return g_returnFeatherEnabled; },
            set value(v) { g_returnFeatherEnabled = !!v; }
        },
        g_returnFeatherWorkflowsRef: {
            get value() { return g_returnFeatherWorkflows; },
            set value(v) { g_returnFeatherWorkflows = normalizeReturnFeatherWorkflows(v); }
        },
        g_returnFeatherShrinkPercentRef: {
            get value() { return g_returnFeatherShrinkPercent; },
            set value(v) {
                var n = Number(v);
                if (!isFinite(n)) n = 10;
                if (n < 0) n = 0;
                if (n > 50) n = 50;
                g_returnFeatherShrinkPercent = n;
            }
        },
        g_returnFeatherBlurPercentRef: {
            get value() { return g_returnFeatherBlurPercent; },
            set value(v) {
                var n = Number(v);
                if (!isFinite(n)) n = 8;
                if (n < 0) n = 0;
                if (n > 50) n = 50;
                g_returnFeatherBlurPercent = n;
            }
        },

        handleCaptureRefImage: handleCaptureRefImage,
        handleRecaptureMainImage: handleRecaptureMainImage,
        handleRestoreSelection: handleRestoreSelection,
        handleRestoreSelectionFromHistory: handleRestoreSelectionFromHistory,
        handleRecaptureRefImage: handleRecaptureRefImage,
        probeSelectionRect: probeSelectionRect,
        setMarqueeAspectPreset: setMarqueeAspectPreset,
        importMarqueePresets: importMarqueePresets,

        markRecordableStart: function() { return recordableActions.markRecordableStart(buildHostContext()); },
        markRecordableAddToBatch: function(info) { return recordableActions.markRecordableAddToBatch(info, buildHostContext()); },
        markRecordableCaptureRefImage: function() { return recordableActions.markRecordableCaptureRefImage(buildHostContext()); },
        // handleRunSingle / handleReturnTaskResult / handleAddToBatch / handleRunBatch 已迁移到 tiles/tile-run.host.js / tile-tasks.host.js / tile-batch.host.js
        // handleColorGradeTask 已迁移到 tiles/tile-colorgrade.host.js
        g_taskAutoReturn: g_taskAutoReturn,
        g_taskResultCache: g_taskResultCache,
        // handleStartTiledUpscale / executeTiledUpscale / handleTiledFillTest 已迁移到 tiles/tile-tiled.host.js
        callAiApi: callAiApi,
        sanitizePrompt: sanitizePrompt,
        createConcurrencyPool: createConcurrencyPool,
        handleFetchOpenDocs: function() {
            try {
                var docs = app.documents;
                var docList = [];
                for (var di = 0; di < docs.length; di++) {
                    var d = docs[di];
                    docList.push({ id: d.id, name: d.name, width: d.width, height: d.height });
                }
                sendToPanel('openDocsResult', { docs: docList });
            } catch (e) {
                sendToPanel('openDocsResult', { docs: [] });
            }
        },
        // handleStartGlobalPartition / executeGlobalPartition 已迁移到 tiles/tile-partition.host.js
        acquirePSLock: acquirePSLock,
        playSingleFailSound: playSingleFailSound,
        playAllFailSound: playAllFailSound,
        savePromptTxtToRunFolder: savePromptTxtToRunFolder,
        calculatePartitionSelections: calculatePartitionSelections,
        // handleGrsCheckCredits / handleCheckQuota 已迁移到 tiles/tile-tasks.host.js
        getErrorMessage: getErrorMessage,
        getErrorSolution: getErrorSolution,
        // --- Forge PS 辅助函数（供 tile-forge.host.js 使用） ---
        getSelectionAndImage: getSelectionAndImage,
        createImageCacheRunFolder: createImageCacheRunFolder,
        saveImageToRunFolder: saveImageToRunFolder,
        deselectAll: deselectAll,
        placeImageToSpecificDoc: placeImageToSpecificDoc,
        placeImageFileToSpecificDoc: placeImageFileToSpecificDoc,   // 大图: 从磁盘文件置入
        placeImagesBatch: placeImagesBatch,
        placeImagesAuto: placeImagesAuto,
        applyReturnFeatherMaskToLayer: applyReturnFeatherMaskToLayer,
        shouldApplyReturnFeather: shouldApplyReturnFeather,
        createGroupAndMask: createGroupAndMask,
        applyMagentaFixCurveToGroup: applyMagentaFixCurveToGroup,
        createTeachingMaterials: createTeachingMaterials,
        playSuccessSound: playSuccessSound,
        sanitizeFileName: sanitizeFileName,
        getUniqueFileName: getUniqueFileName,
        getOrCreateForgePresetsFolder: getOrCreateForgePresetsFolder,
        getOrCreatePresetsFolder: getOrCreatePresetsFolder,

        // handleComfy* 已迁移到 tiles/tile-comfyui.host.js

        g_taskCompleteSentRef: {
            get value() { return g_taskCompleteSent; },
            set value(v) { g_taskCompleteSent = v || {}; }
        },
        g_lastSelectionRef: {
            get value() { return g_lastSelection; },
            set value(v) { g_lastSelection = v; }
        },
        g_lastSelectionDocIdRef: {
            get value() { return g_lastSelectionDocId; },
            set value(v) { g_lastSelectionDocId = v; }
        },
        g_lastCaptureBase64Ref: {
            get value() { return g_lastCaptureBase64; },
            set value(v) { g_lastCaptureBase64 = v; }
        },
        g_activeControllersRef: {
            get value() { return g_activeControllers; },
            set value(v) { g_activeControllers = v; }
        },
        g_earlyStopRef: {
            get value() { return g_earlyStop; },
            set value(v) { g_earlyStop = !!v; }
        },
        abortAllActiveRequests: abortAllActiveRequests,
        clearPSLockQueue: clearPSLockQueue,
        g_taskControllers: g_taskControllers,
        g_taskEarlyStop: g_taskEarlyStop,
        sendTaskCompleteOnce: sendTaskCompleteOnce,
        extendAllTimeouts: extendAllTimeouts,

        // handleOpenPresetFolder / handleRefreshPresets / exportPreset / importPreset / handleLoadPresetsFile / handleSavePresetsFile 已迁移到 tiles/tile-presets.host.js
        // handleSaveChatData / handleLoadChatData 已迁移到 tiles/tile-chat.host.js

        // handleCalibrateBalance 已迁移到 tiles/tile-tasks.host.js
        handleCaptureForChat: handleCaptureForChat,
        // handleYoudaoTranslate 已迁移到 tiles/tile-translate.host.js
        // handleCloud* 已迁移到 tiles/tile-cloud.host.js
        ipcWriteState: ipcWriteState,
        ipcReadCommand: ipcReadCommand,
        openFolderWithMultipleMethods: openFolderWithMultipleMethods,

        archiveToRecycleBin: archiveToRecycleBin,
        beginBatchPendingArchive: beginBatchPendingArchive,
        recycleBin: _recycleBin
    });
}

async function handleMessage(msg) {
    if (!msg || msg.source !== 'panel') return;
    // 启动诊断: 标记"宿主确实收到了面板消息 / 收到了 ready"(给 index.html 看门狗判读用)
    try {
        if (typeof window !== 'undefined' && window.__wcDiag) {
            window.__wcDiag.markMessage();
            if (msg.action === 'ready') window.__wcDiag.markReady();
        }
    } catch(_) {}
    console.log("[宿主] 处理消息:", msg.action);

    // 门控：确保所有 tile host 插件已加载后再分发
    await g_hostPluginsReady;

    var __routed = await hostRouter.routeHostMessage(msg.action, msg.data, buildHostContext());
    if (__routed) return;

    switch (msg.action) {
    }
}

// ============================================================
//  并发控制器：限制最大并行数
// ============================================================
var createConcurrencyPool = concurrencyPool.createConcurrencyPool;

recordableActions.bindRecordableActionSteps(buildHostContext());

// handleRunSingle / handleReturnTaskResult 已迁移到 tiles/tile-run.host.js 和 tiles/tile-tasks.host.js
// handleColorGradeTask 已迁移到 tiles/tile-colorgrade.host.js
// handleAddToBatch / handleRunBatch 已迁移到 tiles/tile-batch.host.js
// acquirePSLock / _processPSLock 已迁移到 host/ps-lock.js
// handleGrsCheckCredits / handleCheckQuota / handleCalibrateBalance / setTaskAutoReturn / clearTaskCache 已迁移到 tiles/tile-tasks.host.js

// handleStartGlobalPartition / executeGlobalPartition 已迁移到 tiles/tile-partition.host.js

// handleCaptureRefImage / handleRecaptureMainImage / handleRecaptureRefImage / handleRestoreSelection / handleRestoreSelectionFromHistory / handleCaptureForChat 已迁移到 host/ps-io.js

// handleLoadPresetsFile / handleSavePresetsFile / handleOpenPresetFolder / handleRefreshPresets 已迁移到 tiles/tile-presets.host.js

// resolveForgeTargetSize 已迁移到 tiles/tile-run.host.js / tile-forge.host.js / tile-cloud.host.js（各自持有副本）


// handleYoudaoTranslate 已迁移到 tiles/tile-translate.host.js

// handleCloud* 已迁移到 tiles/tile-cloud.host.js

// handleComfyConnect / handleComfyFetchWorkflows / handleComfyLoadWorkflow / handleComfyGenerate / handleComfyInterrupt
// 已迁移到 tiles/tile-comfyui.host.js

// ============================================================
//  图片缓存（dataFolder/image_cache/，按任务子目录）
// ============================================================
// IMAGE_CACHE_SUBFOLDER / CHAT_DATA_SUBFOLDER / getOrCreateImageCacheFolder / _sanitizeRunFolderPart / createImageCacheRunFolder / saveImageToRunFolder / savePromptTxtToRunFolder / deleteFolderContents / getOrCreateChatDataFolder 已迁移到 host/fs-utils.js

// handleSaveChatData / handleLoadChatData 已迁移到 tiles/tile-chat.host.js

// 内部校验模块 - 运行时完整性检查

setupMessageListener();

try {
    const entrypoints = require('uxp').entrypoints;
    if (entrypoints && typeof entrypoints.setup === 'function') {
        entrypoints.setup({
            panels: {
                mainPanel: {
                    create: function() {},
                    show: function() {},
                    hide: function() {},
                    destroy: function() {},
                    // 面板右上角 ••• 飞出菜单的 5 个菜单项
                    menuItems: [
                        { id: 'flyout-update', label: '检查更新' },
                        { id: 'flyout-log',    label: '运行日志' },
                        { id: 'flyout-info',   label: '关于插件' },
                        { id: 'flyout-reset',  label: '重置布局' },
                        { id: 'flyout-reload', label: '重新加载' }
                    ],
                    // 点菜单 → 转成消息发给 webview, 由 core/app.js 的 flyoutAction 处理
                    invokeMenu: function(id) {
                        sendToPanel('flyoutAction', { action: id });
                    }
                }
            },
            commands: {
                runSingleCommand: async function() {
                    await recordableActions.markRecordableStart(buildHostContext());
                    sendToPanel('psRunSingleCommand', {});
                    logToPanel('[快捷键] 已触发 Photoshop 全局命令：开始生成', 'info');
                }
            }
        });
    }
} catch (e) {
    console.warn('[快捷键] 注册 Photoshop 命令失败:', e && e.message ? e.message : e);
}


// initIPC / ipcWriteState / ipcPollCommand / ipcReadCommand 已迁移到 host/ipc.js
// 初始化 IPC
try { initIPC(); } catch(e) {}

console.log("[宿主] index.js 已加载");

// 启动诊断: 喂宿主侧事实给 index.html 的看门狗。
// 这行能跑到 = index.js 顶层 require 链没挂; 诊断里出现 "host_index_js: 已完整加载到底"
// 就说明问题不在宿主, 而在 webview / panel 那层。
try {
    if (typeof window !== 'undefined' && window.__wcDiag) {
        window.__wcDiag.set('host_index_js', '已完整加载到底');
        try {
            var _psDiag = require('photoshop');
            if (_psDiag && _psDiag.app && _psDiag.app.version) window.__wcDiag.setPsVersion(_psDiag.app.version);
        } catch(_) {}
        if (typeof g_hostPluginsReady !== 'undefined' && g_hostPluginsReady && g_hostPluginsReady.then) {
            g_hostPluginsReady.then(function(r) {
                try {
                    var ld = (r && r.loaded && r.loaded.length) || 0;
                    var fl = (r && r.failed && r.failed.length) || 0;
                    window.__wcDiag.set('tile_hosts', '已加载 ' + ld + ' 个, 失败 ' + fl + ' 个');
                } catch(_) {}
            });
        }
    }
} catch(_) {}
