// ============================================================
//  tile-conversation.host.js — 对话式生成磁贴的文件 I/O
//  注册的 action:
//    conversationSaveImage  - 把 base64 图保存到 dataFolder/conversations/
//    conversationCleanup    - 清空 conversations 文件夹
// ============================================================

var HostAPI = require('../host/host-api.js');
var uxpModule = require('uxp');
var storage = uxpModule.storage;
var fs = storage.localFileSystem;

var FOLDER_NAME = 'conversations';

function _b64ToArrayBuffer(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var buf = new ArrayBuffer(len);
    var view = new Uint8Array(buf);
    for (var i = 0; i < len; i++) view[i] = bin.charCodeAt(i);
    return buf;
}

async function _ensureFolder() {
    var dataFolder = await fs.getDataFolder();
    var folder;
    try { folder = await dataFolder.getEntry(FOLDER_NAME); }
    catch (_) { folder = await dataFolder.createFolder(FOLDER_NAME); }
    return folder;
}

// ============================================================
//  conversationSaveImage
//  data: { id (会话内 msg id), kind ('req'|'res'), idx (图片在该消息里的序号), base64 }
//  返回: { success, nativePath, fileName }
// ============================================================
HostAPI.registerAction('conversationSaveImage', async function(data, ctx) {
    if (!data || !data.base64) {
        ctx.sendToPanel('conversationSaveImageResult', { success: false, error: 'no base64', reqId: data && data.reqId });
        return true;
    }
    try {
        var folder = await _ensureFolder();
        var safeId = String(data.id || ('m_' + Date.now())).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        var kind = (data.kind === 'req' || data.kind === 'res') ? data.kind : 'img';
        var idx = parseInt(data.idx || 0, 10) || 0;
        var fileName = safeId + '_' + kind + '_' + idx + '.png';

        var file = await folder.createFile(fileName, { overwrite: true });
        await file.write(_b64ToArrayBuffer(data.base64), { format: storage.formats.binary });

        ctx.sendToPanel('conversationSaveImageResult', {
            success: true,
            reqId: data.reqId,
            id: data.id,
            kind: kind,
            idx: idx,
            nativePath: file.nativePath,
            fileName: fileName
        });
    } catch (e) {
        ctx.sendToPanel('conversationSaveImageResult', { success: false, reqId: data && data.reqId, error: e.message });
    }
    return true;
});

// ============================================================
//  conversationCleanup
//  data: { keepIds?: [str] } — 不传则全删
// ============================================================
HostAPI.registerAction('conversationCleanup', async function(data, ctx) {
    try {
        var dataFolder = await fs.getDataFolder();
        var folder;
        try { folder = await dataFolder.getEntry(FOLDER_NAME); }
        catch (_) {
            ctx.sendToPanel('conversationCleanupResult', { success: true, deleted: 0 });
            return true;
        }
        var keepIds = (data && Array.isArray(data.keepIds)) ? data.keepIds : null;
        var entries = await folder.getEntries();
        var deleted = 0;
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (!e.isFile) continue;
            // 文件名格式 <id>_<kind>_<idx>.png
            if (keepIds) {
                var idMatch = e.name.match(/^(.+?)_(req|res|img)_\d+\.png$/);
                if (idMatch && keepIds.indexOf(idMatch[1]) !== -1) continue;
            }
            try { await e.delete(); deleted++; } catch (_) {}
        }
        ctx.sendToPanel('conversationCleanupResult', { success: true, deleted: deleted });
    } catch (e) {
        ctx.sendToPanel('conversationCleanupResult', { success: false, error: e.message });
    }
    return true;
});

// ============================================================
//  conversationOpenFolder — 让用户能在文件管理器里查看历史图
// ============================================================
HostAPI.registerAction('conversationOpenFolder', async function(data, ctx) {
    try {
        var folder = await _ensureFolder();
        var shell = uxpModule.shell;
        if (shell && shell.openPath) await shell.openPath(folder.nativePath);
        ctx.sendToPanel('conversationOpenFolderResult', { success: true, path: folder.nativePath });
    } catch (e) {
        ctx.sendToPanel('conversationOpenFolderResult', { success: false, error: e.message });
    }
    return true;
});

// satelliteValidateLayers 已删 (旧的主动 batchPlay 验证机制已被 host/satellite-events.js 的被动事件侦听取代; 前端 0 调用)

// ============================================================
//  conversationLayerVisibility
//  data: { reqId, mode:'solo'|'restore', docId?, ownedLayerIDs:[..], soloLayerID? }
//    mode='solo':    只显示 soloLayerID,把 ownedLayerIDs 中其他的全部 hide
//    mode='restore': 把 ownedLayerIDs 全部 show
//  返回: { success, reqId, mode, applied:[id], failed:[id] }  failed = 找不到的图层
// ============================================================
HostAPI.registerAction('conversationLayerVisibility', async function(data, ctx) {
    var photoshop = require('photoshop');
    var app = photoshop.app;
    var core = photoshop.core;
    var mode = data && data.mode;
    var owned = (data && Array.isArray(data.ownedLayerIDs)) ? data.ownedLayerIDs.slice() : [];
    var soloId = data && data.soloLayerID;
    var docId = data && data.docId;
    var reqId = data && data.reqId;

    if (mode !== 'solo' && mode !== 'restore') {
        ctx.sendToPanel('conversationLayerVisibilityResult', { success: false, reqId: reqId, error: 'invalid mode' });
        return true;
    }
    if (docId == null) {
        ctx.sendToPanel('conversationLayerVisibilityResult', { success: false, reqId: reqId, mode: mode, error: 'missing docId' });
        return true;
    }
    var targetDoc = null;
    try {
        for (var di = 0; di < app.documents.length; di++) {
            if (String(app.documents[di].id) === String(docId)) { targetDoc = app.documents[di]; break; }
        }
    } catch (_) {}
    if (!targetDoc) {
        ctx.sendToPanel('conversationLayerVisibilityResult', { success: false, reqId: reqId, mode: mode, error: 'document not found: ' + docId });
        return true;
    }
    var normalizedOwned = [];
    for (var ni = 0; ni < owned.length; ni++) {
        var normalizedId = Number(owned[ni]);
        if (!isFinite(normalizedId)) continue;
        if (normalizedOwned.indexOf(normalizedId) === -1) normalizedOwned.push(normalizedId);
    }
    owned = normalizedOwned;
    var normalizedSolo = soloId == null ? null : Number(soloId);
    if (mode === 'solo' && (!isFinite(normalizedSolo) || owned.indexOf(normalizedSolo) === -1)) {
        ctx.sendToPanel('conversationLayerVisibilityResult', { success: false, reqId: reqId, mode: mode, error: 'solo layer is not in ownedLayerIDs' });
        return true;
    }
    soloId = normalizedSolo;
    if (!owned.length) {
        ctx.sendToPanel('conversationLayerVisibilityResult', { success: true, reqId: reqId, mode: mode, applied: [], failed: [] });
        return true;
    }

    var applied = [];
    var failed = [];

    try {
        if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop global lock unavailable');
        await ctx.acquirePSLock(function() {
          return core.executeAsModal(async function() {
            await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: targetDoc.id }] }], {});
            if (!app.activeDocument || String(app.activeDocument.id) !== String(targetDoc.id)) throw new Error('failed to activate target document: ' + docId);

            // 通过 batchPlay 单个 get layerID 验证是否存在(可靠,不依赖 doc.layers 遍历)
            // PS 对不存在的 layer _id 会抛错;存在则返回属性
            async function _layerExists(lid) {
                try {
                    await app.batchPlay([{
                        _obj: 'get',
                        _target: [{ _property: 'layerID' }, { _ref: 'layer', _id: lid }]
                    }], { synchronousExecution: true });
                    return true;
                } catch (_) {
                    return false;
                }
            }

            var ownedExisting = [];
            for (var oi = 0; oi < owned.length; oi++) {
                var lidNum = +owned[oi];
                if (await _layerExists(lidNum)) ownedExisting.push(lidNum);
                else failed.push(owned[oi]);
            }

            if (mode === 'solo') {
                // 先 show 目标(若它在 owned 里),再 hide 其他 owned
                var ops = [];
                var soloNum = (soloId != null) ? +soloId : null;
                if (soloNum == null || ownedExisting.indexOf(soloNum) === -1) throw new Error('solo layer not found: ' + soloId);
                ops.push({ _obj: 'show', null: [{ _ref: 'layer', _id: soloNum }] });
                for (var ei = 0; ei < ownedExisting.length; ei++) {
                    var lid2 = ownedExisting[ei];
                    if (lid2 === soloNum) continue;
                    ops.push({ _obj: 'hide', null: [{ _ref: 'layer', _id: lid2 }] });
                }
                if (ops.length) await app.batchPlay(ops, {});
                // 图层面板里选中这张图的图层(定位)
                await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: soloNum }], makeVisible: false }], {});
                var _actDoc = app.activeDocument;
                var soloLayer = _actDoc && _actDoc.activeLayers && _actDoc.activeLayers[0];
                if (!soloLayer || String(soloLayer.id) !== String(soloNum)) throw new Error('failed to select solo layer: ' + soloNum);
                var hops = 0;
                var p = soloLayer.parent;
                while (p && p !== _actDoc && hops < 10) {
                    try { if (p.visible === false) p.visible = true; } catch(_pv) {}
                    p = p.parent;
                    hops++;
                }
                applied = ownedExisting.slice();
            } else {
                // restore: show 所有 owned
                var ops2 = [];
                for (var ri = 0; ri < ownedExisting.length; ri++) {
                    ops2.push({ _obj: 'show', null: [{ _ref: 'layer', _id: ownedExisting[ri] }] });
                }
                if (ops2.length) await app.batchPlay(ops2, {});
                applied = ownedExisting.slice();
            }
          }, { commandName: '对话气泡 · 图层联动' });
        }, 'conversation-visibility:' + (reqId || Date.now()));

        ctx.sendToPanel('conversationLayerVisibilityResult', {
            success: true, reqId: reqId, mode: mode, applied: applied, failed: failed
        });
    } catch (e) {
        ctx.sendToPanel('conversationLayerVisibilityResult', {
            success: false, reqId: reqId, mode: mode, error: e.message || String(e),
            applied: applied, failed: failed
        });
    }
    return true;
});

// ============================================================
//  gotoLayerMask — 卫星点白方块: 跳到 PS, 选中 layer 的父组, 激活组的白蒙版,
//  以 layer 的 bbox 扩 N 像素为活动选区, PS 窗口拍到前面
//  data: { layerID, docId?, expandPx?:2, reqId? }
// ============================================================
HostAPI.registerAction('gotoLayerMask', async function(data, ctx) {
    var photoshop = require('photoshop');
    var app = photoshop.app;
    var core = photoshop.core;
    var layerID = data && data.layerID;
    var docId = data && data.docId;
    var expandPx = (data && data.expandPx != null) ? +data.expandPx : 2;
    var reqId = data && data.reqId;

    if (layerID == null) {
        ctx.sendToPanel('gotoLayerMaskResult', { success: false, reqId: reqId, error: 'no layerID' });
        return true;
    }

    try {
        if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop global lock unavailable');
        await ctx.acquirePSLock(function() {
          return core.executeAsModal(async function() {
            // 1. 切到目标文档
            if (docId != null) {
                try {
                    await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: docId }] }], {});
                } catch (_) {}
            }
            var doc = app.activeDocument;
            if (!doc) throw new Error('no active document');

            // 2. 选中 layer 本身 (后续找 parent group)
            await app.batchPlay([{
                _obj: 'select',
                _target: [{ _ref: 'layer', _id: +layerID }],
                makeVisible: false
            }], {});
            var lyr = doc.activeLayers && doc.activeLayers[0];
            if (!lyr) throw new Error('layer not found: ' + layerID);

            // 3. 找父组 (如果存在), 选中父组
            var parent = lyr.parent;
            var targetForMask = lyr;   // 用于激活蒙版的目标
            if (parent && typeof parent.kind !== 'undefined' && parent !== doc) {
                // parent 是 group, 选中它
                try {
                    await app.batchPlay([{
                        _obj: 'select',
                        _target: [{ _ref: 'layer', _id: parent.id }],
                        makeVisible: false
                    }], {});
                    targetForMask = parent;
                } catch (_) {}
            }

            // 4. 选中该图层/组的蒙版 (不进入 mask channel, 只让 mask 成为活动绘画目标)
            //    跟 PS 里点蒙版缩略图行为一致 — layer 选中 + mask 高亮 + 画笔默认画在蒙版上
            //    底层 batchPlay: select layerEffectsMaskChannel (kind='maskFromImage')
            //    实际只需要 selectionModifier 模式让 mask 成为活动 channel
            try {
                await app.batchPlay([{
                    _obj: 'select',
                    _target: [{ _ref: 'channel', _enum: 'channel', _value: 'mask' }],
                    makeVisible: false   // 关键: false = 不切到 mask 视图, 只是让它成为活动 channel
                }], {});
            } catch (maskErr) {
                // 没蒙版就跳过, 继续设选区
                ctx.logToPanel('[卫星·跳转] 没找到蒙版, 仅设置选区: ' + (maskErr.message || maskErr), 'info');
            }

            // 5. 算 layer 的 bbox + 扩 expandPx
            //    lyr.bounds = { left, top, right, bottom }
            var b = lyr.bounds;
            if (!b) throw new Error('no layer bounds');
            var sel = {
                left: Math.max(0, Math.round(b.left) - expandPx),
                top: Math.max(0, Math.round(b.top) - expandPx),
                right: Math.min(Math.round(doc.width), Math.round(b.right) + expandPx),
                bottom: Math.min(Math.round(doc.height), Math.round(b.bottom) + expandPx)
            };
            await app.batchPlay([{
                _obj: 'set',
                _target: [{ _ref: 'channel', _property: 'selection' }],
                to: {
                    _obj: 'rectangle',
                    top: { _unit: 'pixelsUnit', _value: sel.top },
                    left: { _unit: 'pixelsUnit', _value: sel.left },
                    bottom: { _unit: 'pixelsUnit', _value: sel.bottom },
                    right: { _unit: 'pixelsUnit', _value: sel.right }
                }
            }], {});

            // 6. PS 窗口拍到前面 (UXP shell.openPath/window.focus 不可用, 用 bringToFront)
            try {
                if (app.bringToFront) app.bringToFront();
            } catch (_) {}
          }, { commandName: '卫星 · 跳转图层蒙版' });
        }, 'goto-layer-mask:' + (reqId || Date.now()));

        ctx.sendToPanel('gotoLayerMaskResult', { success: true, reqId: reqId });
    } catch (e) {
        ctx.logToPanel('[卫星·跳转] 失败: ' + (e.message || e), 'warn');
        ctx.sendToPanel('gotoLayerMaskResult', { success: false, reqId: reqId, error: String(e.message || e) });
    }
    return true;
});
