// ============================================================
//  fs-utils.js
//  文件/文件夹工具函数
//
//  从 index.js 抽出，行为完全一致。
//  使用工厂函数 createFsUtilsModule 注入外部依赖。
// ============================================================

function createFsUtilsModule(deps) {
    var fs = deps.fs;
    var storage = deps.storage;
    var uxpModule = deps.uxpModule;
    var logToPanel = deps.logToPanel;
    var sendToPanel = deps.sendToPanel;
    var base64ToArrayBuffer = deps.base64ToArrayBuffer;
    var g_returnFeatherEnabled_ref = deps.getReturnFeatherEnabled;   // function returning current value
    var g_returnFeatherWorkflows_ref = deps.getReturnFeatherWorkflows; // function returning current value

    var PRESETS_SUBFOLDER = "presets";
    var FORGE_PRESETS_SUBFOLDER = "forge_presets";
    var IMAGE_CACHE_SUBFOLDER = "image_cache";
    var CHAT_DATA_SUBFOLDER = "chat_data";
    var _imageCacheClearing = false;
    var _imageCacheWriters = 0;

function _beginImageCacheWrite() {
    if (_imageCacheClearing) throw new Error('图片缓存正在清理，请稍后再开始生成');
    _imageCacheWriters++;
}

function _endImageCacheWrite() {
    _imageCacheWriters = Math.max(0, _imageCacheWriters - 1);
}

function beginImageCacheClear() {
    if (_imageCacheClearing) return { ok: false, error: '图片缓存已经在清理中' };
    if (_imageCacheWriters > 0) return { ok: false, error: '当前仍有图片缓存正在写入，请稍后重试' };
    _imageCacheClearing = true;
    return { ok: true };
}

function endImageCacheClear() {
    _imageCacheClearing = false;
}

// === 通用打开文件夹函数 ===
async function openFolderWithMultipleMethods(folderPath, logPrefix) {
    logPrefix = logPrefix || '[文件夹]';
    if (!folderPath) { logToPanel(logPrefix + ' 路径为空', 'error'); return false; }
    logToPanel(logPrefix + ' 正在打开: ' + folderPath, 'info');

    // 方法1: shell.openPath（UXP 推荐方式，带授权提示）
    try {
        var shell = uxpModule.shell;
        if (shell && typeof shell.openPath === 'function') {
            var result = await shell.openPath(folderPath, 'Opening plugin folder, please allow');
            if (!result) {
                logToPanel(logPrefix + ' 已打开', 'success');
                return true;
            }
            console.log(logPrefix + ' shell.openPath 返回: ' + result);
        }
    } catch(e1) { console.log(logPrefix + ' shell.openPath 异常: ' + e1.message); }

    // 方法2: shell.openExternal('file:///...')
    try {
        var shell2 = uxpModule.shell;
        if (shell2 && typeof shell2.openExternal === 'function') {
            var fileUrl = 'file:///' + folderPath.replace(/\\/g, '/').replace(/^\/+/, '');
            await shell2.openExternal(fileUrl, 'Opening plugin folder, please allow');
            logToPanel(logPrefix + ' 已打开', 'success');
            return true;
        }
    } catch(e2) { console.log(logPrefix + ' shell.openExternal(file:///) 异常: ' + e2.message); }

    // 方法3: shell.openExternal(原始路径)
    try {
        var shell3 = uxpModule.shell;
        if (shell3 && typeof shell3.openExternal === 'function') {
            await shell3.openExternal(folderPath, 'Opening plugin folder, please allow');
            logToPanel(logPrefix + ' 已打开', 'success');
            return true;
        }
    } catch(e3) { console.log(logPrefix + ' shell.openExternal(path) 异常: ' + e3.message); }

    // 全部失败
    logToPanel(logPrefix + ' 无法自动打开，请手动前往: ' + folderPath, 'warn');
    sendToPanel('showFolderPath', { path: folderPath });
    return false;
}

// --- 工具函数 ---
function sanitizeFileName(title) {
    // 移除文件名非法字符，空格→下划线
    var safe = (title || 'preset').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, '_').trim();
    if (!safe) safe = 'preset_' + Date.now();
    // 限制长度（避免路径过长）
    if (safe.length > 80) safe = safe.substring(0, 80);
    return safe;
}

async function getOrCreatePresetsFolder(dataFolder) {
    try {
        return await dataFolder.getEntry(PRESETS_SUBFOLDER);
    } catch(e) {
        return await dataFolder.createFolder(PRESETS_SUBFOLDER);
    }
}

async function getUniqueFileName(folder, baseName) {
    // baseName: "xxx.json" → 如果已存在，变为 "xxx_2.json", "xxx_3.json" ...
    var name = baseName.replace(/\.json$/i, '');
    var ext = '.json';
    var candidate = name + ext;
    var counter = 2;
    while (true) {
        try {
            await folder.getEntry(candidate);
            // 文件已存在，加后缀
            candidate = name + '_' + counter + ext;
            counter++;
            if (counter > 999) { candidate = name + '_' + Date.now() + ext; break; }
        } catch(e) {
            // 文件不存在，可以使用
            break;
        }
    }
    return candidate;
}

async function getOrCreateForgePresetsFolder(dataFolder) {
    try {
        return await dataFolder.getEntry(FORGE_PRESETS_SUBFOLDER);
    } catch(e) {
        return await dataFolder.createFolder(FORGE_PRESETS_SUBFOLDER);
    }
}

async function getOrCreateImageCacheFolder() {
    var dataFolder = await fs.getDataFolder();
    try {
        return await dataFolder.getEntry(IMAGE_CACHE_SUBFOLDER);
    } catch(e) {
        return await dataFolder.createFolder(IMAGE_CACHE_SUBFOLDER);
    }
}

function _sanitizeRunFolderPart(v, fallback) {
    var s = (v === undefined || v === null) ? '' : String(v);
    s = s.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!s) s = fallback || 'x';
    if (s.length > 48) s = s.slice(0, 48);
    return s;
}

// 保留中文的文件名清洗: 黑名单洗掉 Windows 非法字符 / 控制符 / emoji 代理对, 首尾点和空格也去掉
function _sanitizeCacheNamePart(v, fallback, maxLen) {
    var s = (v === undefined || v === null) ? '' : String(v);
    s = s.replace(/[\\/:*?"<>|\x00-\x1F]/g, '');
    s = s.split('').filter(function(ch){ var c = ch.charCodeAt(0); return !(c >= 0xD800 && c <= 0xDFFF) && !(c >= 0xFE00 && c <= 0xFE0F) && c !== 0x200D; }).join('');
    s = s.replace(/\s+/g, ' ');
    s = s.replace(/^[\s.]+|[\s.]+$/g, '');
    if (!s) s = fallback || '未命名';
    var cap = maxLen || 32;
    if (s.length > cap) s = s.slice(0, cap);
    return s;
}

// 文件完整路径 → 4位十六进制短码 (同一个文件永远同一个码, 重名不同路径自动分开)
function _hash4(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
    return ('0000' + (h % 65536).toString(16)).slice(-4);
}

// meta 传了 label + 文档信息(docName/docPath/docId 任一) → 两级结构:
//   文档名_短码/label_月日_时分秒_随机/
// 没传 → 老平铺结构原样(兜底兼容: 老调用方 & 抓不到文档的场景)
// 返回的文件夹对象上挂 wcRunPath = "一级/二级" (老平铺没有, 用 .name 即可)
async function createImageCacheRunFolder(meta) {
    _beginImageCacheWrite();
    try {
    var cacheFolder = await getOrCreateImageCacheFolder();
    var now = new Date();
    var dateStr = now.getFullYear() + '' + ('0'+(now.getMonth()+1)).slice(-2) + '' + ('0'+now.getDate()).slice(-2);
    var timeStr = ('0'+now.getHours()).slice(-2) + '' + ('0'+now.getMinutes()).slice(-2) + '' + ('0'+now.getSeconds()).slice(-2);

    var useProjectLayout = !!(meta && meta.label && (meta.docName || meta.docPath || (meta.docId !== undefined && meta.docId !== null)));
    if (!useProjectLayout) {
        var enginePart = _sanitizeRunFolderPart(meta && meta.engine, 'api');
        var taskPart = _sanitizeRunFolderPart(meta && meta.taskId, 'task');
        var rand = Math.random().toString(36).substr(2, 4);
        var folderName = dateStr + '_' + timeStr + '_' + enginePart + '_' + taskPart.slice(-10) + '_' + rand;
        return await cacheFolder.createFolder(folderName);
    }

    // 一级: 文档名(去后缀) + 短码
    var rawDocName = String(meta.docName || '未命名').replace(/\.(psd|psb|tif|tiff|png|jpe?g|webp|bmp|gif)$/i, '');
    var docPart = _sanitizeCacheNamePart(rawDocName, '未命名', 32);
    var shortCode = meta.docPath
        ? _hash4(String(meta.docPath))
        : ('u' + String(meta.docId !== undefined && meta.docId !== null ? meta.docId : 0));
    var projName = docPart + '_' + shortCode;
    var projFolder;
    try { projFolder = await cacheFolder.getEntry(projName); }
    catch(eP) { projFolder = await cacheFolder.createFolder(projName); }

    // 二级: 预设名/头文字 + 月日_时分秒 + 2位随机
    var labelPart = _sanitizeCacheNamePart(meta.label, '生成', 24);
    var mmdd = ('0'+(now.getMonth()+1)).slice(-2) + '' + ('0'+now.getDate()).slice(-2);
    var leafFolder = null, leafName = '';
    for (var att = 0; att < 3 && !leafFolder; att++) {
        leafName = labelPart + '_' + mmdd + '_' + timeStr + '_' + Math.random().toString(36).substr(2, 2);
        try { leafFolder = await projFolder.createFolder(leafName); }
        catch(eL) { if (att === 2) throw eL; }
    }
    try { leafFolder.wcRunPath = projName + '/' + leafName; } catch(_) {}
    return leafFolder;
    } finally {
        _endImageCacheWrite();
    }
}

async function saveImageToRunFolder(runFolder, kind, base64Str, idx) {
    if (!runFolder || !base64Str) return;
    var guardStarted = false;
    try {
        _beginImageCacheWrite();
        guardStarted = true;
        var imageKind = (kind === 'input') ? 'input' : 'output';
        var num = Number(idx) || 1;
        if (num < 1) num = 1;
        var fileName = imageKind + '_' + ('000' + num).slice(-3) + '.png';
        var file = await runFolder.createFile(fileName, { overwrite: true });
        await file.write(base64ToArrayBuffer(base64Str), { format: storage.formats.binary });
    } catch(e) {
        console.warn("[图片缓存] 保存" + kind + "失败:", e.message);
    } finally {
        if (guardStarted) _endImageCacheWrite();
    }
}

async function savePromptTxtToRunFolder(runFolder, prompt) {
    if (!runFolder) return;
    var guardStarted = false;
    try {
        _beginImageCacheWrite();
        guardStarted = true;
        var file = await runFolder.createFile('prompt.txt', { overwrite: true });
        await file.write(String(prompt || ''));
    } catch(e) {
        console.warn("[图片缓存] 保存 prompt.txt 失败:", e.message);
    } finally {
        if (guardStarted) _endImageCacheWrite();
    }
}

// 递归删除文件夹内所有条目
async function deleteFolderContents(folder) {
    var entries = await folder.getEntries();
    for (var i = 0; i < entries.length; i++) {
        try {
            if (entries[i].isFolder) {
                await deleteFolderContents(entries[i]);
                await entries[i].delete();
            } else {
                await entries[i].delete();
            }
        } catch(e) { console.warn("[清理] 删除失败:", e.message); }
    }
}

async function getOrCreateChatDataFolder() {
    var dataFolder = await fs.getDataFolder();
    try {
        return await dataFolder.getEntry(CHAT_DATA_SUBFOLDER);
    } catch(e) {
        return await dataFolder.createFolder(CHAT_DATA_SUBFOLDER);
    }
}

function normalizeReturnFeatherWorkflows(v) {
    var src = v || {};
    return {
        bananaSingle: !!src.bananaSingle,
        bananaBatch: !!src.bananaBatch,
        tiledUpscale: !!src.tiledUpscale,
        forge: !!src.forge,
        comfyui: !!src.comfyui
    };
}

function shouldApplyReturnFeather(workflowKey) {
    if (!g_returnFeatherEnabled_ref()) return false;
    var wf = normalizeReturnFeatherWorkflows(g_returnFeatherWorkflows_ref());
    return !!wf[workflowKey];
}

    return {
        openFolderWithMultipleMethods: openFolderWithMultipleMethods,
        sanitizeFileName: sanitizeFileName,
        getUniqueFileName: getUniqueFileName,
        getOrCreateImageCacheFolder: getOrCreateImageCacheFolder,
        beginImageCacheClear: beginImageCacheClear,
        endImageCacheClear: endImageCacheClear,
        _sanitizeRunFolderPart: _sanitizeRunFolderPart,
        createImageCacheRunFolder: createImageCacheRunFolder,
        saveImageToRunFolder: saveImageToRunFolder,
        savePromptTxtToRunFolder: savePromptTxtToRunFolder,
        deleteFolderContents: deleteFolderContents,
        getOrCreateChatDataFolder: getOrCreateChatDataFolder,
        getOrCreatePresetsFolder: getOrCreatePresetsFolder,
        getOrCreateForgePresetsFolder: getOrCreateForgePresetsFolder,
        normalizeReturnFeatherWorkflows: normalizeReturnFeatherWorkflows,
        shouldApplyReturnFeather: shouldApplyReturnFeather
    };
}

module.exports = { createFsUtilsModule: createFsUtilsModule };
