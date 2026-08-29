// ============================================================
//  cv-host.js — 轮椅幕布 的本地 host 处理表 (同文档直连 PS / 文件系统)
//  对应主插件 tile-canvas.host.js 的各 action, 但:
//    - 不碰账号/key 的本地能力 → 自己做 (存读图/导入导出/下载/建图层/抓选区/贴回)
//    - 唯一需要账号的「生成」→ 走 IPC 委托主插件 (阶段4)
//  每个处理函数返回结果对象 (不含 reqId), 由 cv-shim 带回 reqId 喂 onMessage。
// ============================================================
(function () {
'use strict';

var photoshop = null, app = null, core = null, uxpModule = null, fs = null;
try {
    photoshop = require('photoshop');
    app = photoshop.app; core = photoshop.core;
    uxpModule = require('uxp');
    fs = uxpModule.storage.localFileSystem;
} catch (e) { /* 非 UXP 环境 (纯语法检查) */ }

var IMG_SUBFOLDER = 'canvas_images';
var EXPORT_SUBFOLDER = 'canvas_exports';

// ── base64 ↔ ArrayBuffer ──
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

// ── 原子写 (先写 .writing → 删旧 → 改名), 防写一半崩留空文件 ──
async function _atomicWrite(folder, fileName, arrayBuffer) {
    var tmpName = fileName + '.writing';
    var tmp = await folder.createFile(tmpName, { overwrite: true });
    await tmp.write(arrayBuffer);
    try { var old = await folder.getEntry(fileName); await old.delete(); } catch (_) {}
    await tmp.rename(fileName);
}
async function _subFolder(name) {
    var df = await fs.getDataFolder();
    try { return await df.getEntry(name); }
    catch (_) { return await df.createFolder(name); }
}

// ── 抓选区 / 贴回 (阶段3 由 cv-psio.js 提供; 这里软引用, 没接好就给清晰报错) ──
function _psio() { return window.CV_PSIO || null; }

var CV_HOST = {

    // 抓 PS 选区图 → base64
    canvasCaptureSelection: async function (data) {
        var io = _psio();
        if (!io || !io.getSelectionAndImage) return { success: false, error: '抓选区能力未接入 (cv-psio.js)' };
        var res = await io.getSelectionAndImage();
        if (!res || !res.base64) return { success: false, error: '没抓到选区图(先在 PS 里建个选区)' };
        return { success: true, base64: res.base64 };
    },

    // PS区域: 记录当前选区 (顺带抓一张当预览)
    canvasRegionRecord: async function (data) {
        var io = _psio();
        if (!io || !io.getSelectionAndImage) return { success: false, error: '抓选区能力未接入 (cv-psio.js)' };
        var r = await io.getSelectionAndImage();
        if (!r || !r.selection) return { success: false, error: '没读到选区(先在 PS 里框个选区)' };
        return { success: true, selection: r.selection, base64: r.base64 };
    },

    // PS区域: 运行时按记录的选区, 重新抓当前画布
    canvasRegionGrab: async function (data) {
        var io = _psio();
        if (!io || !io.getSelectionAndImage) return { success: false, error: '抓选区能力未接入 (cv-psio.js)' };
        if (!data || !data.selection) return { success: false, error: '没有记录的选区' };
        var r = await io.getSelectionAndImage(data.selection);
        if (!r || !r.base64) return { success: false, error: '抓取失败' };
        return { success: true, base64: r.base64 };
    },

    // 把某节点的图贴回当前 PS 文档 (智能对象)
    canvasPlaceToPS: async function (data) {
        var io = _psio();
        if (!io || !io.placeImageToSpecificDoc) return { success: false, error: '贴回 PS 能力未接入 (cv-psio.js)' };
        if (!data || !data.base64) return { success: false, error: '没有图片' };
        var doc = null;
        try { doc = app.activeDocument; } catch (_) {}
        if (!doc) return { success: false, error: 'PS 里没有打开的文档' };
        await io.placeImageToSpecificDoc(data.base64, doc.id, null, 0, 'smartObject');
        return { success: true };
    },

    // PS区域: 建一个空白图层 (自包含, 不依赖 cv-psio)
    canvasRegionMakeLayer: async function (data) {
        var name = (data && data.name) || 'PS区域';
        await core.executeAsModal(async function () {
            await photoshop.action.batchPlay([{ _obj: 'make', _target: [{ _ref: 'layer' }], using: { _obj: 'layer', name: name } }], {});
        }, { commandName: '新建空白图层' });
        return { success: true };
    },

    // 下载网址图片 (host fetch 不受 CORS 限制)
    canvasDownloadUrl: async function (data) {
        var url = data && data.url;
        if (!url) return { success: false, error: '没有 URL' };
        var controller = new AbortController();
        var timeoutId = setTimeout(function () { try { controller.abort(); } catch (_) {} }, 60 * 1000);
        try {
            var r = await fetch(url, { signal: controller.signal });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            var ct = (r.headers.get('content-type') || '').toLowerCase();
            if (ct && ct.indexOf('image/') === -1) {
                return { success: false, error: '不是图片直链(' + ct.split(';')[0] + '),请拖图片本身或用图片地址' };
            }
            var mime = (ct && ct.indexOf('image/') === 0) ? ct.split(';')[0] : 'image/png';
            var buf = await r.arrayBuffer();
            return { success: true, base64: _bufToB64(buf), mime: mime };
        } catch (e) {
            if (e && e.name === 'AbortError') return { success: false, error: '图片下载超时（60 秒）' };
            throw e;
        } finally {
            clearTimeout(timeoutId);
        }
    },

    // 存图到文件 (结构里只记文件名, 不把大 base64 塞进存档)
    canvasSaveImage: async function (data) {
        if (!data || !data.fileName || !data.base64) return { success: false };
        var folder = await _subFolder(IMG_SUBFOLDER);
        await _atomicWrite(folder, data.fileName, _b64ToBuf(data.base64));
        return { success: true, fileName: data.fileName };
    },

    // 按文件名读回 base64 (重开幕布恢复图片)
    canvasLoadImage: async function (data) {
        var folder = await _subFolder(IMG_SUBFOLDER);
        var entry = await folder.getEntry(data.fileName);
        var buf = await entry.read({ format: uxpModule.storage.formats.binary });
        return { success: true, fileName: data.fileName, base64: _bufToB64(buf) };
    },

    // 保存节点的图到 canvas_exports/ (时间戳命名)
    canvasSaveExport: async function (data) {
        if (!data || !data.base64) return { success: false, error: '没有图片' };
        var folder = await _subFolder(EXPORT_SUBFOLDER);
        var name = 'canvas_' + Date.now() + '.png';
        await _atomicWrite(folder, name, _b64ToBuf(data.base64));
        return { success: true, fileName: name };
    },

    // 工作流导出: 弹"另存为", 写 JSON 文本
    canvasExportWorkflow: async function (data) {
        var file = await fs.getFileForSaving('幕布工作流.json', { types: ['json'] });
        if (!file) return { success: false, canceled: true };
        await file.write(data.json || '{}');
        return { success: true };
    },

    // 工作流导入: 弹"打开", 读回 JSON 文本
    canvasImportWorkflow: async function (data) {
        var file = await fs.getFileForOpening({ types: ['json'] });
        if (!file || (Array.isArray(file) && !file.length)) return { success: false, canceled: true };
        var f = Array.isArray(file) ? file[0] : file;
        var text = await f.read();
        return { success: true, json: text };
    },

    // 生成: 委托主插件 (阶段4 接 IPC); 现在先明确报错, 不静默
    canvasGenerate: async function (data) {
        if (window.CV_GEN && typeof window.CV_GEN.generate === 'function') {
            return await window.CV_GEN.generate(data);
        }
        return { success: false, error: '生成通道尚未接入 (阶段4: IPC 委托主插件)' };
    }
};

window.CV_HOST = CV_HOST;
// 给阶段3/4 复用的小工具
window.CV_HOST_UTIL = { b64ToBuf: _b64ToBuf, bufToB64: _bufToB64, atomicWrite: _atomicWrite, subFolder: _subFolder };

})();
