// ============================================================
//  tile-canvas.host.js — 创意幕布 后端
//  职责: 给前端画布提供"会用到 PS / 联网 / 文件系统"的能力。
//    canvasCaptureSelection  抓 PS 选区图 → base64
//    canvasDownloadUrl       下载网址图片 → base64 (host fetch 无 CORS 限制)
//    canvasGenerate          连线后调插件已有模型生成 → base64
//    canvasPlaceToPS         把某节点的图贴回当前 PS 文档
//    canvasSaveImage         把图 base64 存到 dataFolder/canvas_images/ (原子写)
//    canvasLoadImage         按文件名读回 base64 (重开幕布时恢复图片)
// ============================================================

var HostAPI = require('../host/host-api.js');
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;
var uxpModule = require('uxp');
var fs = uxpModule.storage.localFileSystem;

var psPixels = require('../host/ps-pixels.js');
var base64ToArrayBuffer = psPixels.base64ToArrayBuffer;
var arrayBufferToBase64 = psPixels.arrayBufferToBase64;

var CANVAS_IMG_SUBFOLDER = 'canvas_images';

function _activeDocId() {
    try { return app.activeDocument ? app.activeDocument.id : null; } catch (_) { return null; }
}

function _findDocById(docId) {
    for (var i = 0; i < app.documents.length; i++) {
        if (String(app.documents[i].id) === String(docId)) return app.documents[i];
    }
    return null;
}

async function _withDocumentLock(ctx, lockId, docId, fn) {
    if (docId == null) throw new Error('PS 里没有打开的文档');
    if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop 全局操作锁不可用');
    return await ctx.acquirePSLock(async function() {
        var doc = _findDocById(docId);
        if (!doc) throw new Error('请求发起时的 PS 文档已关闭');
        if (!app.activeDocument || String(app.activeDocument.id) !== String(docId)) {
            await core.executeAsModal(async function() {
                await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: doc.id }] }], {});
            }, { commandName: '切换到幕布目标文档' });
        }
        return await fn(doc);
    }, lockId);
}

// 原子写(写 .writing → 删旧 → 改名), 跟预设一致, 防写一半崩留空文件
async function _atomicWrite(folder, fileName, arrayBuffer) {
    var tmpName = fileName + '.writing';
    var tmp = await folder.createFile(tmpName, { overwrite: true });
    await tmp.write(arrayBuffer);
    try { var old = await folder.getEntry(fileName); await old.delete(); } catch (_) {}
    await tmp.rename(fileName);
}

async function _getImgFolder() {
    var dataFolder = await fs.getDataFolder();
    try { return await dataFolder.getEntry(CANVAS_IMG_SUBFOLDER); }
    catch (_) { return await dataFolder.createFolder(CANVAS_IMG_SUBFOLDER); }
}

// ── 抓 PS 选区图 ──
HostAPI.registerAction('canvasCaptureSelection', async function(data, ctx) {
    var docId = _activeDocId();
    try {
        var res = await _withDocumentLock(ctx, 'canvas-capture:' + ((data && data.reqId) || Date.now()), docId, function() {
            return ctx.getSelectionAndImage();
        });
        if (!res || !res.base64) {
            ctx.sendToPanel('canvasCaptureResult', { reqId: data.reqId, success: false, error: '没抓到选区图(先在 PS 里建个选区)' });
            return;
        }
        ctx.sendToPanel('canvasCaptureResult', { reqId: data.reqId, success: true, base64: res.base64, docId: docId });
    } catch (e) {
        ctx.sendToPanel('canvasCaptureResult', { reqId: data.reqId, success: false, error: (e && e.message) || String(e) });
    }
}, { tileId: 'canvas' });

// ── 下载网址图片 (host fetch 不受 CORS 限制) ──
HostAPI.registerAction('canvasDownloadUrl', async function(data, ctx) {
    try {
        var url = data && data.url;
        if (!url) { ctx.sendToPanel('canvasDownloadResult', { reqId: data.reqId, success: false, error: '没有 URL' }); return; }
        var controller = new AbortController();
        var timeoutId = setTimeout(function() { try { controller.abort(); } catch (_) {} }, 60 * 1000);
        try {
            var r = await fetch(url, { signal: controller.signal });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            var ct = (r.headers.get('content-type') || '').toLowerCase();
            // content-type 明确不是图片 → 多半拖来的是网页地址(如 pin 页), 抓回来是 HTML, 别当图片
            if (ct && ct.indexOf('image/') === -1) {
                ctx.sendToPanel('canvasDownloadResult', { reqId: data.reqId, success: false, error: '不是图片直链(' + ct.split(';')[0] + '),请拖图片本身或用图片地址' });
                return;
            }
            var mime = (ct && ct.indexOf('image/') === 0) ? ct.split(';')[0] : 'image/png';
            var buf = await r.arrayBuffer();
            var b64 = arrayBufferToBase64(buf);
            ctx.sendToPanel('canvasDownloadResult', { reqId: data.reqId, success: true, base64: b64, mime: mime });
        } finally {
            clearTimeout(timeoutId);
        }
    } catch (e) {
        var error = e && e.name === 'AbortError' ? '图片下载超时（60 秒）' : ((e && e.message) || String(e));
        ctx.sendToPanel('canvasDownloadResult', { reqId: data.reqId, success: false, error: error });
    }
}, { tileId: 'canvas' });

// ── 生成: 连进来的图 + 提示词 → 调插件已有模型 ──
// 复用 ctx.callAiApi, 不走 runSingle 的 PS 截图/打组/自动贴回。
HostAPI.registerAction('canvasGenerate', async function(data, ctx) {
    data = data || {};
    var taskId = (data && data.taskId) || ('canvas_' + (data && data.reqId));
    var docId = null;
    var docName = '';
    var docPath = '';
    try {
        var activeDoc = app.activeDocument;
        if (activeDoc) {
            docId = activeDoc.id;
            docName = activeDoc.name || '';
            try { docPath = activeDoc.path ? String(activeDoc.path) : ''; } catch (_) {}
        }
    } catch (_) {}
    var archiveMeta = {
        id: taskId,
        batchId: data.batchId || taskId,
        workflow: 'canvas',
        prompt: data.prompt || '',
        model: data.model || '',
        provider: data.provider || '',
        size: data.size || '',
        aspectRatio: data.aspectRatio || '',
        presetTitle: '创意幕布',
        context: {
            docId: docId,
            docName: docName,
            docPath: docPath,
            selection: null,
            antiMode: 0,
            layerType: 'smartObject',
            groupName: '创意幕布'
        }
    };
    var response;
    try {
        var images = (data.images || []).filter(Boolean);
        var mainImg = images.length ? images[0] : null;
        var extraImgs = images.length > 1 ? images.slice(1) : [];
        var result = await ctx.callAiApi(
            data.apiKey, data.prompt, mainImg, data.size,
            data.timeout || 3600, data.apiBaseUrl, extraImgs,
            data.model, data.provider, taskId, data.aspectRatio,
            {
                feature: 'canvas',
                archiveCallback: function(b64, status, err) {
                    return ctx.archiveToRecycleBin(archiveMeta, b64, status, err);
                }
            }
        );
        response = {
            reqId: data.reqId, taskId: taskId, success: true, base64: result,
            requestAttempted: true,
            docId: docId, docName: docName, docPath: docPath
        };
    } catch (e) {
        response = {
            reqId: data.reqId, taskId: taskId, success: false,
            error: (e && e.message) || String(e),
            requestAttempted: !(e && e.requestAttempted === false),
            docId: docId, docName: docName, docPath: docPath
        };
    }
    try {
        ctx.sendToPanel('canvasGenerateResult', response);
    } catch (sendErr) {
        try { ctx.logToPanel('[创意幕布] 生成结果回包失败: ' + ((sendErr && sendErr.message) || sendErr), 'error'); } catch (_) {}
        try { ctx.sendToPanel('canvasGenerateResult', response); } catch (_) {}
    }
}, { tileId: 'canvas' });

// ── 把某节点的图贴回当前 PS 文档 ──
HostAPI.registerAction('canvasPlaceToPS', async function(data, ctx) {
    var docId = data && data.docId != null ? data.docId : _activeDocId();
    try {
        if (!data || !data.base64) { ctx.sendToPanel('canvasPlaceResult', { reqId: data.reqId, success: false, error: '没有图片' }); return; }
        await _withDocumentLock(ctx, 'canvas-place:' + ((data && data.reqId) || Date.now()), docId, function() {
            return ctx.placeImageToSpecificDoc(data.base64, docId, null, 0, 'smartObject');
        });
        ctx.sendToPanel('canvasPlaceResult', { reqId: data.reqId, success: true, docId: docId });
    } catch (e) {
        ctx.sendToPanel('canvasPlaceResult', { reqId: data.reqId, success: false, error: (e && e.message) || String(e) });
    }
}, { tileId: 'canvas' });

// ── 存图到文件 (结构里只记文件名, 不把大 base64 塞进 storage) ──
HostAPI.registerAction('canvasSaveImage', async function(data, ctx) {
    try {
        if (!data || !data.fileName || !data.base64) { ctx.sendToPanel('canvasSaveImageResult', { reqId: data.reqId, success: false }); return; }
        var folder = await _getImgFolder();
        await _atomicWrite(folder, data.fileName, base64ToArrayBuffer(data.base64));
        ctx.sendToPanel('canvasSaveImageResult', { reqId: data.reqId, success: true, fileName: data.fileName });
    } catch (e) {
        ctx.sendToPanel('canvasSaveImageResult', { reqId: data.reqId, success: false, error: (e && e.message) || String(e) });
    }
}, { tileId: 'canvas' });

// ── 按文件名读回 base64 (重开幕布恢复图片) ──
HostAPI.registerAction('canvasLoadImage', async function(data, ctx) {
    try {
        var folder = await _getImgFolder();
        var entry = await folder.getEntry(data.fileName);
        var buf = await entry.read({ format: uxpModule.storage.formats.binary });
        ctx.sendToPanel('canvasLoadImageResult', { reqId: data.reqId, success: true, fileName: data.fileName, base64: arrayBufferToBase64(buf) });
    } catch (e) {
        ctx.sendToPanel('canvasLoadImageResult', { reqId: data.reqId, success: false, fileName: data.fileName, error: (e && e.message) || String(e) });
    }
}, { tileId: 'canvas' });

// ── 保存节点: 把图存到 dataFolder/canvas_exports/(时间戳命名) ──
HostAPI.registerAction('canvasSaveExport', async function(data, ctx) {
    try {
        if (!data || !data.base64) { ctx.sendToPanel('canvasSaveExportResult', { reqId: data.reqId, success: false, error: '没有图片' }); return; }
        var dataFolder = await fs.getDataFolder();
        var folder;
        try { folder = await dataFolder.getEntry('canvas_exports'); }
        catch (_) { folder = await dataFolder.createFolder('canvas_exports'); }
        var name = 'canvas_' + Date.now() + '.png';
        await _atomicWrite(folder, name, base64ToArrayBuffer(data.base64));
        ctx.sendToPanel('canvasSaveExportResult', { reqId: data.reqId, success: true, fileName: name });
        ctx.logToPanel('[创意幕布] 已保存到 canvas_exports/' + name, 'success');
    } catch (e) {
        ctx.sendToPanel('canvasSaveExportResult', { reqId: data.reqId, success: false, error: (e && e.message) || String(e) });
    }
}, { tileId: 'canvas' });

// ── 工作流导出: 弹"另存为"对话框, 写 JSON 文本(含内置图 base64) ──
HostAPI.registerAction('canvasExportWorkflow', async function(data, ctx) {
    try {
        var file = await fs.getFileForSaving('幕布工作流.json', { types: ['json'] });
        if (!file) { ctx.sendToPanel('canvasExportWorkflowResult', { reqId: data.reqId, success: false, canceled: true }); return; }
        await file.write(data.json || '{}');
        ctx.sendToPanel('canvasExportWorkflowResult', { reqId: data.reqId, success: true });
    } catch (e) {
        ctx.sendToPanel('canvasExportWorkflowResult', { reqId: data.reqId, success: false, error: (e && e.message) || String(e) });
    }
}, { tileId: 'canvas' });

// ── 工作流导入: 弹"打开"对话框, 读回 JSON 文本 ──
HostAPI.registerAction('canvasImportWorkflow', async function(data, ctx) {
    try {
        var file = await fs.getFileForOpening({ types: ['json'] });
        if (!file || (Array.isArray(file) && !file.length)) { ctx.sendToPanel('canvasImportWorkflowResult', { reqId: data.reqId, success: false, canceled: true }); return; }
        var f = Array.isArray(file) ? file[0] : file;
        var text = await f.read();
        ctx.sendToPanel('canvasImportWorkflowResult', { reqId: data.reqId, success: true, json: text });
    } catch (e) {
        ctx.sendToPanel('canvasImportWorkflowResult', { reqId: data.reqId, success: false, error: (e && e.message) || String(e) });
    }
}, { tileId: 'canvas' });

// ── PS区域: 记录当前选区(顺带抓一张当预览) ──
HostAPI.registerAction('canvasRegionRecord', async function(data, ctx) {
    var docId = _activeDocId();
    try {
        var r = await _withDocumentLock(ctx, 'canvas-region-record:' + ((data && data.reqId) || Date.now()), docId, function() {
            return ctx.getSelectionAndImage();
        });
        if (!r || !r.selection) { ctx.sendToPanel('canvasRegionRecordResult', { reqId: data.reqId, success: false, error: '没读到选区(先在 PS 里框个选区)' }); return; }
        r.selection.docId = docId;
        ctx.sendToPanel('canvasRegionRecordResult', { reqId: data.reqId, success: true, selection: r.selection, base64: r.base64, docId: docId });
    } catch (e) {
        ctx.sendToPanel('canvasRegionRecordResult', { reqId: data.reqId, success: false, error: (e && e.message) || String(e) });
    }
}, { tileId: 'canvas' });

// ── PS区域: 运行时按记录的选区, 重新抓当前画布 ──
HostAPI.registerAction('canvasRegionGrab', async function(data, ctx) {
    var docId = data && data.selection && data.selection.docId != null ? data.selection.docId : _activeDocId();
    try {
        if (!data || !data.selection) { ctx.sendToPanel('canvasRegionGrabResult', { reqId: data.reqId, success: false, error: '没有记录的选区' }); return; }
        var r = await _withDocumentLock(ctx, 'canvas-region-grab:' + ((data && data.reqId) || Date.now()), docId, function() {
            return ctx.getSelectionAndImage(data.selection);
        });
        if (!r || !r.base64) { ctx.sendToPanel('canvasRegionGrabResult', { reqId: data.reqId, success: false, error: '抓取失败' }); return; }
        ctx.sendToPanel('canvasRegionGrabResult', { reqId: data.reqId, success: true, base64: r.base64 });
    } catch (e) {
        ctx.sendToPanel('canvasRegionGrabResult', { reqId: data.reqId, success: false, error: (e && e.message) || String(e) });
    }
}, { tileId: 'canvas' });

// ── PS区域: 建一个空白图层(尽力而为, 失败不影响其它) ──
HostAPI.registerAction('canvasRegionMakeLayer', async function(data, ctx) {
    var docId = _activeDocId();
    try {
        var name = (data && data.name) || 'PS区域';
        await _withDocumentLock(ctx, 'canvas-region-layer:' + ((data && data.reqId) || Date.now()), docId, function() {
            return core.executeAsModal(async function() {
                await photoshop.action.batchPlay([{ _obj: 'make', _target: [{ _ref: 'layer' }], using: { _obj: 'layer', name: name } }], {});
            }, { commandName: '新建空白图层' });
        });
        ctx.sendToPanel('canvasRegionMakeLayerResult', { reqId: data.reqId, success: true });
        ctx.logToPanel('[创意幕布] 已建空白图层: ' + name, 'success');
    } catch (e) {
        ctx.sendToPanel('canvasRegionMakeLayerResult', { reqId: data.reqId, success: false, error: (e && e.message) || String(e) });
    }
}, { tileId: 'canvas' });
