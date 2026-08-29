// ============================================================
//  sound.js
//  音效系统（扫描、查找、播放）
//
//  从 index.js 抽出，行为完全一致。
//  使用工厂函数 createSoundModule 注入外部依赖。
// ============================================================

function createSoundModule(deps) {
    var fs = deps.fs;
    var storage = deps.storage;
    // _hostStorage 在 index.js 里是会被整体重新赋值的变量（loadHostStorage 读 JSON 后替换整个对象），
    // 所以这里必须用 getter 每次读最新引用，不能直接 var _hostStorage = deps._hostStorage 拿快照
    var getHostStorage = typeof deps.getHostStorage === 'function'
        ? deps.getHostStorage
        : function() { return deps._hostStorage || {}; };
    var arrayBufferToBase64 = deps.arrayBufferToBase64;
    var sendToPanel = deps.sendToPanel;

// === 扫描音效文件：内置audios/ + 用户自定义dataFolder/sounds/ ===
async function scanSoundFiles() {
    var files = [];
    try {
        var pluginFolder = await fs.getPluginFolder();
        var audiosFolder = await pluginFolder.getEntry("audios");
        var entries = await audiosFolder.getEntries();
        for (var i = 0; i < entries.length; i++) {
            if (!entries[i].isFolder && entries[i].name.toLowerCase().endsWith('.mp3')) {
                var name = entries[i].name.replace(/\.mp3$/i, '');
                files.push({ name: name, source: 'builtin' });
            }
        }
    } catch (e) { console.warn("[音效] 扫描内置audios/失败:", e); }
    try {
        var dataFolder = await fs.getDataFolder();
        var soundsFolder;
        try { soundsFolder = await dataFolder.getEntry("sounds"); } catch(e) {
            soundsFolder = await dataFolder.createFolder("sounds");
        }
        var userEntries = await soundsFolder.getEntries();
        for (var j = 0; j < userEntries.length; j++) {
            if (!userEntries[j].isFolder && userEntries[j].name.toLowerCase().endsWith('.mp3')) {
                var uname = userEntries[j].name.replace(/\.mp3$/i, '');
                // 避免与内置重名
                var isDup = false;
                for (var k = 0; k < files.length; k++) { if (files[k].name === uname) { isDup = true; break; } }
                if (!isDup) files.push({ name: uname, source: 'custom' });
            }
        }
    } catch (e) { console.warn("[音效] 扫描用户sounds/失败:", e); }
    return files;
}

// 查找音效文件：先找内置audios/，再找用户sounds/
async function findSoundFileEntry(fileName) {
    try {
        var pluginFolder = await fs.getPluginFolder();
        return await pluginFolder.getEntry("audios/" + fileName + ".mp3");
    } catch(e) {}
    try {
        var dataFolder = await fs.getDataFolder();
        return await dataFolder.getEntry("sounds/" + fileName + ".mp3");
    } catch(e) {}
    return null;
}

// === 音效播放：支持自定义音效文件 ===
// soundType: 'success' | 'allFail' | 'singleFail'
async function playSoundByType(soundType) {
    try {
        // 检查音效总开关(sound.enabled storage 字段是布尔类型,JSON 化后可能是字符串)
        var hs = getHostStorage() || {};
        var enabledRaw = hs['sound.enabled'];
        if (typeof enabledRaw === 'string') {
            try { enabledRaw = JSON.parse(enabledRaw); } catch(_) {}
        }
        if (enabledRaw !== true) return;

        // v6 用嵌套 key sound.success / sound.allFail / sound.singleFail
        // 兼容 v5 老 key sound_success_file / sound_all_fail_file / sound_single_fail_file
        var v6KeyMap = { success: 'sound.success', allFail: 'sound.allFail', singleFail: 'sound.singleFail' };
        var v5KeyMap = { success: 'sound_success_file', allFail: 'sound_all_fail_file', singleFail: 'sound_single_fail_file' };
        var v6Key = v6KeyMap[soundType] || v6KeyMap.success;
        var v5Key = v5KeyMap[soundType] || v5KeyMap.success;
        var fileName = hs[v6Key];
        // storage 里值可能是 JSON.stringify('xxx') 形式 → 反序列化
        if (typeof fileName === 'string') {
            try {
                var maybeJson = JSON.parse(fileName);
                if (typeof maybeJson === 'string') fileName = maybeJson;
            } catch(_) {}
        }
        if (!fileName) fileName = hs[v5Key];
        if (typeof fileName === 'string') {
            try {
                var maybeJson2 = JSON.parse(fileName);
                if (typeof maybeJson2 === 'string') fileName = maybeJson2;
            } catch(_) {}
        }
        if (!fileName) fileName = (soundType === 'success') ? '三七唐笑' : 'none';
        if (fileName === 'none' || fileName === '"none"') return; // 用户选择了"无"
        var audioEntry = await findSoundFileEntry(fileName);
        if (!audioEntry) { console.warn("[音效] 找不到文件: " + fileName); return; }
        var data = await audioEntry.read({ format: storage.formats.binary });
        var base64 = arrayBufferToBase64(data);
        sendToPanel('playSound', { base64: base64 });
    } catch (e) { console.warn("[音效] 播放失败 (" + soundType + "):", e); }
}
async function playSuccessSound() { await playSoundByType('success'); }
async function playAllFailSound() { await playSoundByType('allFail'); }

// 单个报错音效加2秒节流，防止同一波超时多个失败时重叠
var _singleFailLastTime = 0;
var SINGLE_FAIL_THROTTLE_MS = 2000;
async function playSingleFailSound() {
    var now = Date.now();
    if (now - _singleFailLastTime < SINGLE_FAIL_THROTTLE_MS) return;
    _singleFailLastTime = now;
    await playSoundByType('singleFail');
}

    return {
        scanSoundFiles: scanSoundFiles,
        findSoundFileEntry: findSoundFileEntry,
        playSoundByType: playSoundByType,
        playSuccessSound: playSuccessSound,
        playAllFailSound: playAllFailSound,
        playSingleFailSound: playSingleFailSound
    };
}

module.exports = { createSoundModule: createSoundModule };
