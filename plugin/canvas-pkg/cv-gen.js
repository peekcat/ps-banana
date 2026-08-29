// ============================================================
//  cv-gen.js — 轮椅幕布 生成委托 (幕布侧)
//  幕布自己不出图: 把生成请求写进主插件的 IPC 目录, 由主插件用它的账号+key+计费跑,
//  再把结果图写回, 幕布轮询读回。账号/key/计费全留主插件。
//
//  通道 (都在 主插件 temp/wheelchair_ipc/ 下, per-reqId 文件, 避免并发覆盖):
//    canvas_gen_cmd/<genId>.json        — 幕布写请求
//    canvas_gen_in/<genId>_imgN.png     — 幕布写输入图(二进制)
//    canvas_gen_out/<genId>_K.png       — 主插件写结果图
//    canvas_gen_out/<genId>.result.json — 主插件写结果状态
//
//  前提: 生成时主插件(轮椅)必须开着(它是大脑)。抓选区/贴回这些幕布能自己干。
// ============================================================
(function () {
'use strict';

var MAIN_PLUGIN_ID = 'com.xiasanqi.ps.wheelchair.v4';   // 主插件 ID (历史 v4 id, 跟遥控器一致)
var SELF_PLUGIN_ID = 'com.xiasanqi.ps.wheelchair.canvas';

var uxpFs = null, uxpStorage = null;
try { uxpStorage = require('uxp').storage; uxpFs = uxpStorage.localFileSystem; } catch (e) { /* 纯语法检查 */ }

var _ipcDir = null;
var _genSeq = 0;

function _b64ToBuf(b64) {
    var bin = atob(b64); var len = bin.length; var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}
function _bufToB64(buf) {
    var bytes = new Uint8Array(buf); var bin = ''; var chunk = 8192;
    for (var i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
}

// 定位主插件的 wheelchair_ipc 目录: 自己 temp 路径里的插件 ID 换成主插件 ID (跟遥控器同款)
async function _getMainIpcDir() {
    if (_ipcDir) return _ipcDir;
    if (!uxpFs) return null;
    var tempFolder = await uxpFs.getTemporaryFolder();
    var selfPath = tempFolder.nativePath || '';
    var mainPath = selfPath.replace(SELF_PLUGIN_ID, MAIN_PLUGIN_ID);
    if (mainPath === selfPath) throw new Error('定位主插件目录失败(路径里没找到自己的 ID)');
    var mainUrl = 'file:' + mainPath.replace(/\\/g, '/');
    var mainFolder = await uxpFs.getEntryWithUrl(mainUrl);
    try { _ipcDir = await mainFolder.getEntry('wheelchair_ipc'); }
    catch (e) { _ipcDir = await mainFolder.createFolder('wheelchair_ipc'); }
    return _ipcDir;
}
async function _sub(dir, name) {
    try { return await dir.getEntry(name); }
    catch (e) { return await dir.createFolder(name); }
}
async function _atomicWriteBin(folder, fileName, arrayBuffer) {
    var tmp = await folder.createFile(fileName + '.writing', { overwrite: true });
    await tmp.write(arrayBuffer, { format: uxpStorage.formats.binary });
    try { var old = await folder.getEntry(fileName); await old.delete(); } catch (_) {}
    await tmp.rename(fileName);
}
async function _atomicWriteText(folder, fileName, text) {
    var tmp = await folder.createFile(fileName + '.writing', { overwrite: true });
    await tmp.write(text);
    try { var old = await folder.getEntry(fileName); await old.delete(); } catch (_) {}
    await tmp.rename(fileName);
}
function _sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// 主入口: cv-host.canvasGenerate 调这个
async function generate(data) {
    if (!uxpFs) return { success: false, error: 'UXP 文件系统不可用' };
    var dir;
    try { dir = await _getMainIpcDir(); }
    catch (e) { return { success: false, error: '找不到主插件目录, 请先打开「轮椅」主插件: ' + (e && e.message || e) }; }
    if (!dir) return { success: false, error: '请先打开「轮椅」主插件(生成需要主插件在运行)' };

    var genId = 'cvg_' + Date.now() + '_' + (++_genSeq);
    var cmdDir = await _sub(dir, 'canvas_gen_cmd');
    var inDir = await _sub(dir, 'canvas_gen_in');
    var outDir = await _sub(dir, 'canvas_gen_out');

    // 1. 输入图写成独立二进制文件 (不内联 base64 进 JSON)
    var images = (data.images || []).filter(Boolean);
    var refImages = [];
    for (var i = 0; i < images.length; i++) {
        var fn = genId + '_img' + i + '.png';
        await _atomicWriteBin(inDir, fn, _b64ToBuf(images[i]));
        refImages.push(fn);
    }

    // 2. 写请求
    var req = {
        ts: Date.now(), reqId: genId, action: 'generate',
        data: {
            prompt: data.prompt || '',
            provider: data.provider || '',
            model: data.model || '',
            size: data.size || '2K',
            aspectRatio: data.aspectRatio || 'Auto',
            timeout: data.timeout || 3600,
            refImages: refImages
        }
    };
    await _atomicWriteText(cmdDir, genId + '.json', JSON.stringify(req));

    // 3. 轮询结果 (per-reqId 文件, 不会被别的请求覆盖)
    var resultName = genId + '.result.json';
    var timeoutMs = (data.timeout || 3600) * 1000 + 60000;   // 比生成超时多留 60s
    var deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await _sleep(400);
        var resFile = null;
        try { resFile = await outDir.getEntry(resultName); } catch (_) { resFile = null; }
        if (!resFile) continue;
        var txt;
        try { txt = await resFile.read(); } catch (_) { continue; }
        if (!txt || txt.length < 3) continue;
        var res;
        try { res = JSON.parse(txt); } catch (_) { continue; }
        if (!res || res.reqId !== genId) continue;

        // 读到结果, 清理请求/输入/结果文件 (best-effort)
        _cleanup(cmdDir, genId + '.json');
        for (var ri = 0; ri < refImages.length; ri++) _cleanup(inDir, refImages[ri]);
        if (!res.success) { _cleanup(outDir, resultName); return { success: false, error: res.error || '主插件生成失败' }; }

        // 读第一张结果图
        var files = (res.data && res.data.results) || [];
        if (!files.length) { _cleanup(outDir, resultName); return { success: false, error: '主插件没回结果图' }; }
        var b64;
        try {
            var imgEntry = await outDir.getEntry(files[0]);
            var buf = await imgEntry.read({ format: uxpStorage.formats.binary });
            b64 = _bufToB64(buf);
        } catch (e) { _cleanup(outDir, resultName); return { success: false, error: '读结果图失败: ' + (e && e.message || e) }; }
        // 清理结果图 + 状态文件
        for (var fi = 0; fi < files.length; fi++) _cleanup(outDir, files[fi]);
        _cleanup(outDir, resultName);
        return { success: true, base64: b64 };
    }
    // 超时: 清掉请求
    _cleanup(cmdDir, genId + '.json');
    for (var ci = 0; ci < refImages.length; ci++) _cleanup(inDir, refImages[ci]);
    return { success: false, error: '生成超时(主插件没在限时内回结果, 确认主插件开着且已登录/有 key)' };
}

async function _cleanup(folder, name) {
    try { var e = await folder.getEntry(name); await e.delete(); } catch (_) {}
}

window.CV_GEN = { generate: generate };

})();
