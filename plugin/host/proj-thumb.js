// ============================================================
//  host/proj-thumb.js — 项目(PS文档)画布缩略图
//
//  每次生成贴回完成后, 把当前文档**整个画布**截一张小图(320px JPEG),
//  存到 recycle_bin/proj_<projKey>.jpg, 越新越覆盖 —— 生成记录的
//  项目层封面显示"这个 psd 现在长什么样", 不是某次生成的局部选区。
//
//  projKey 与前端 tile-records._projKeyOf 完全同算法:
//    有路径: 文档名(去后缀)_路径哈希4位   无路径: 文档名_noPath
// ============================================================

var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;
var imaging = photoshop.imaging;
var uxpModule = require('uxp');
var storage = uxpModule.storage;
var fs = storage.localFileSystem;

function _hash4(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
    return ('0000' + (h % 65536).toString(16)).slice(-4);
}

function projKeyOf(docName, docPath) {
    var name = String(docName || '').replace(/\.(psd|psb|tif|tiff|png|jpe?g|webp|bmp|gif|nef|cr[23]|arw|dng|raf|orf)$/i, '');
    if (!name) return '__none';
    if (docPath) return name + '_' + _hash4(String(docPath));
    return name + '_noPath';
}

// 文件名安全化(projKey 含中文, 文件系统 OK, 但斜杠等要洗)
function _safeFileName(projKey) {
    return 'proj_' + String(projKey).replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').slice(0, 100) + '.jpg';
}

async function _getBinFolder() {
    var dataFolder = await fs.getDataFolder();
    try { return await dataFolder.getEntry('recycle_bin'); }
    catch(_) { return await dataFolder.createFolder('recycle_bin'); }
}

function _b64ToArrayBuffer(b64) {
    var bin = atob(b64);
    var buf = new ArrayBuffer(bin.length);
    var view = new Uint8Array(buf);
    for (var i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
    return buf;
}

// 截当前文档整画布 → 320px 长边 JPEG base64。找不到文档/失败返回 null, 绝不抛。
async function captureDocCanvas(docId) {
    var result = null;
    try {
        var doc = null;
        try {
            var docs = app.documents;
            for (var i = 0; i < docs.length; i++) {
                if (docs[i].id === docId) { doc = docs[i]; break; }
            }
        } catch(_) {}
        if (!doc) return null;

        await core.executeAsModal(async function() {
            var w = Math.round(Number(doc.width) || 0);
            var h = Math.round(Number(doc.height) || 0);
            if (!w || !h) return;
            var scale = 320 / Math.max(w, h);
            var ts = (scale < 1) ? { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) } : undefined;
            var opts = { documentID: docId, componentSize: 8, applyAlpha: true };
            if (ts) opts.targetSize = ts;
            var imgObj = await imaging.getPixels(opts);
            try {
                result = await imaging.encodeImageData({
                    imageData: imgObj.imageData,
                    base64: true,
                    format: 'jpg',
                    quality: 70
                });
            } finally {
                try { imgObj.imageData.dispose(); } catch(_) {}
            }
        }, { commandName: '生成记录·项目封面' });
    } catch(e) {
        console.warn('[项目封面] 截取失败:', e && e.message);
    }
    return result;
}

// 生成完成后调: 截画布 → 存盘 → 通知前端刷新封面。全程静默兜错。
// 串行队列: 并发任务同时完成时不重复截同一文档。
var _busy = {};
async function updateProjThumb(docId, docName, docPath, sendToPanel) {
    var key = projKeyOf(docName, docPath);
    if (key === '__none' || _busy[key]) return;
    _busy[key] = true;
    try {
        var b64 = await captureDocCanvas(docId);
        if (!b64) return;
        var folder = await _getBinFolder();
        var file = await folder.createFile(_safeFileName(key), { overwrite: true });
        await file.write(_b64ToArrayBuffer(b64), { format: storage.formats.binary });
        if (sendToPanel) {
            try { sendToPanel('recycleProjThumbUpdated', { projKey: key }); } catch(_) {}
        }
    } catch(e) {
        console.warn('[项目封面] 保存失败:', e && e.message);
    } finally {
        delete _busy[key];
    }
}

// 读项目封面 base64 (没有返回 null)
async function getProjThumb(projKey) {
    try {
        var folder = await _getBinFolder();
        var f = await folder.getEntry(_safeFileName(projKey));
        var buf = await f.read({ format: storage.formats.binary });
        var bytes = new Uint8Array(buf);
        var bin = '';
        var CHUNK = 0x8000;
        for (var i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(bin);
    } catch(_) {
        return null;
    }
}

module.exports = {
    projKeyOf: projKeyOf,
    captureDocCanvas: captureDocCanvas,
    updateProjThumb: updateProjThumb,
    getProjThumb: getProjThumb
};
