async function handleLowRiskAction(action, data, ctx) {
    switch (action) {
        case 'fetchOpenDocs':
            ctx.handleFetchOpenDocs();
            return true;

        case 'collapseAllGroups':
            // Dock 按钮: 折叠当前文档所有图层组(用户拍板: 所有组, 不区分是否AI建的)
            try {
                var _psC = require('photoshop');
                var _appC = _psC.app;
                var _coreC = _psC.core;
                var collapseDocId = null;
                try { collapseDocId = _appC.activeDocument && _appC.activeDocument.id; } catch (_) {}
                if (collapseDocId == null) { ctx.logToPanel('[折叠组] 没有打开的文档', 'warn'); return true; }
                if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop 全局操作锁不可用');
                await ctx.acquirePSLock(function() { return _coreC.executeAsModal(async function() {
                    var collapseDoc = null;
                    for (var cdi = 0; cdi < _appC.documents.length; cdi++) {
                        if (String(_appC.documents[cdi].id) === String(collapseDocId)) { collapseDoc = _appC.documents[cdi]; break; }
                    }
                    if (!collapseDoc) throw new Error('请求发起时的文档已关闭');
                    await _appC.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: collapseDoc.id }] }], {});
                    // collapseAllGroupsEvent: PS 原生"折叠所有组"(等同图层面板右键菜单项), 一次到位
                    await _appC.batchPlay([{ _obj: 'collapseAllGroupsEvent' }], {});
                }, { commandName: '折叠所有图层组' }); }, 'collapse-groups:' + collapseDocId);
                ctx.logToPanel('[折叠组] 已折叠当前文档所有图层组', 'success');
            } catch (eCg) {
                ctx.logToPanel('[折叠组] 失败: ' + ((eCg && eCg.message) || eCg), 'error');
            }
            return true;

        case 'previewSound':
            try {
                var fn = data.fileName;
                if (fn && fn !== 'none') {
                    var soundEntry = await ctx.findSoundFileEntry(fn);
                    if (soundEntry) {
                        var ad = await soundEntry.read({ format: ctx.storage.formats.binary });
                        ctx.sendToPanel('forcePlaySound', { base64: ctx.arrayBufferToBase64(ad) });
                    } else {
                        console.warn('[预览音效] 找不到文件:', fn);
                    }
                }
            } catch (e) {
                console.warn('[预览音效] 播放失败:', e);
            }
            return true;

        case 'playSoundByName':
            // 按名查找并以 'playSound' 通道回传(受 sound.enabled 控制,用于任务完成音效)
            try {
                var pfn = data.fileName;
                if (pfn && pfn !== 'none') {
                    var psEntry = await ctx.findSoundFileEntry(pfn);
                    if (psEntry) {
                        var pad = await psEntry.read({ format: ctx.storage.formats.binary });
                        ctx.sendToPanel('playSound', { base64: ctx.arrayBufferToBase64(pad) });
                    } else {
                        console.warn('[音效] 找不到文件:', pfn);
                    }
                }
            } catch (pse) {
                console.warn('[音效] 播放失败:', pse);
            }
            return true;

        case 'scanSoundFiles':
            try {
                var soundFiles = await ctx.scanSoundFiles();
                ctx.sendToPanel('soundFilesResult', { files: soundFiles });
            } catch (e) {
                ctx.sendToPanel('soundFilesResult', { files: [] });
            }
            return true;

        // openChatDataFolder 已删 (前端 0 调用)

        case 'openImageCacheFolder':
            try {
                var cacheFolder = await ctx.getOrCreateImageCacheFolder();
                var cacheFolderPath = cacheFolder.nativePath;
                ctx.sendToPanel('imageCacheFolderPath', { path: cacheFolderPath });
                await ctx.openFolderWithMultipleMethods(cacheFolderPath, '[图片缓存]');
            } catch (e) {
                ctx.logToPanel('[图片缓存] 打开文件夹失败: ' + e.message, 'error');
            }
            return true;

        case 'clearImageCache':
            var clearCacheReqId = data && data.reqId;
            var clearGuardStarted = false;
            try {
                if (!ctx || typeof ctx.beginImageCacheClear !== 'function' || typeof ctx.endImageCacheClear !== 'function') {
                    throw new Error('图片缓存互斥锁不可用');
                }
                var clearGuard = ctx.beginImageCacheClear();
                if (!clearGuard || !clearGuard.ok) {
                    throw new Error((clearGuard && clearGuard.error) || '图片缓存当前不可清理');
                }
                clearGuardStarted = true;
                var clearImageFolder = await ctx.getOrCreateImageCacheFolder();
                await ctx.deleteFolderContents(clearImageFolder);
                ctx.logToPanel('[图片缓存] 已清空图片缓存', 'success');
                ctx.sendToPanel('imageCacheCleared', { reqId: clearCacheReqId, success: true });
            } catch (e) {
                ctx.logToPanel('[图片缓存] 清空失败: ' + e.message, 'error');
                ctx.sendToPanel('imageCacheCleared', { reqId: clearCacheReqId, success: false, error: e.message || String(e) });
            } finally {
                if (clearGuardStarted) ctx.endImageCacheClear();
            }
            return true;

        // case 'openPresetFolder' / 'refreshPresets' 已迁移到 tiles/tile-presets.host.js
        // case 'saveChatData' / 'loadChatData' 已迁移到 tiles/tile-chat.host.js
    }

    // IPC 卫星插件通信
    if (action === 'ipcWriteState') {
        ctx.ipcWriteState(data);
        return true;
    }
    if (action === 'ipcReadCommand') {
        ctx.ipcReadCommand();
        return true;
    }
    // 手动同步外观: 写到 wheelchair_ipc/theme.json (跟 state 分开, 避免每帧推大背景图)
    if (action === 'ipcWriteThemeFile') {
        (async function() {
            try {
                var uxpStorage = require('uxp').storage;
                var fsLfs = uxpStorage.localFileSystem;
                var tempFolder = await fsLfs.getTemporaryFolder();
                var ipcFolder;
                try { ipcFolder = await tempFolder.getEntry('wheelchair_ipc'); }
                catch (e) { ipcFolder = await tempFolder.createFolder('wheelchair_ipc'); }
                var file;
                try { file = await ipcFolder.getEntry('theme.json'); }
                catch (e) { file = await ipcFolder.createFile('theme.json'); }
                await file.write(JSON.stringify({ ts: Date.now(), theme: (data && data.theme) || {} }));
                try { ctx.logToPanel('[卫星·主题] 已同步外观', 'info'); } catch (_) {}
            } catch (e) {
                try { ctx.logToPanel('[卫星·主题] 同步失败: ' + e.message, 'warn'); } catch (_) {}
            }
        })();
        return true;
    }
    // 同步缩略图到 wheelchair_ipc/thumbs/, 卫星插件读这里展示
    // data: { items: [{ thumbName, sourcePath }, ...] }
    // 按 items 列表保留对应文件; 不在列表的旧缩略图删除 (保持目录跟主插件状态一致)
    if (action === 'satelliteSyncThumbs') {
        (async function() {
            var copied = 0, skipped = 0, failed = 0, deleted = 0;
            var items = (data && data.items) || [];
            try {
                var uxpStorage = require('uxp').storage;
                var fsLfs = uxpStorage.localFileSystem;
                var formats = uxpStorage.formats;
                var tempFolder = await fsLfs.getTemporaryFolder();
                var ipcFolder;
                try { ipcFolder = await tempFolder.getEntry('wheelchair_ipc'); }
                catch (e) { ipcFolder = await tempFolder.createFolder('wheelchair_ipc'); }
                var thumbsFolder;
                try { thumbsFolder = await ipcFolder.getEntry('thumbs'); }
                catch (e) { thumbsFolder = await ipcFolder.createFolder('thumbs'); }

                var keepNames = {};
                items.forEach(function(it) { if (it && it.thumbName) keepNames[it.thumbName] = true; });

                try {
                    var existingEntries = await thumbsFolder.getEntries();
                    for (var i = 0; i < existingEntries.length; i++) {
                        var ent = existingEntries[i];
                        if (!keepNames[ent.name]) {
                            try { await ent.delete(); deleted++; } catch (delErr) {}
                        }
                    }
                } catch (lsErr) {}

                for (var k = 0; k < items.length; k++) {
                    var item = items[k];
                    if (!item || !item.thumbName || !item.sourcePath) { failed++; continue; }
                    var existsAlready = false;
                    try { await thumbsFolder.getEntry(item.thumbName); existsAlready = true; } catch (e) {}
                    if (existsAlready) { skipped++; continue; }
                    try {
                        var srcUrl = 'file:' + item.sourcePath.replace(/\\/g, '/');
                        var srcFile = await fsLfs.getEntryWithUrl(srcUrl);
                        var srcBuf = await srcFile.read({ format: formats.binary });
                        var dstFile = await thumbsFolder.createFile(item.thumbName, { overwrite: true });
                        await dstFile.write(srcBuf, { format: formats.binary });
                        copied++;
                    } catch (cpErr) {
                        failed++;
                        try { ctx.logToPanel('[卫星·缩略图] 复制失败 ' + item.thumbName + ': ' + cpErr.message + ' (源: ' + item.sourcePath + ')', 'warn'); } catch (_) {}
                    }
                }
                if (copied > 0 || failed > 0 || deleted > 0) {
                    try { ctx.logToPanel('[卫星·缩略图] 同步完成 入参=' + items.length + ' 新复制=' + copied + ' 已存在跳过=' + skipped + ' 失败=' + failed + ' 删除旧=' + deleted + ' IPC路径=' + (thumbsFolder.nativePath || '?'), 'info'); } catch (_) {}
                }
            } catch (e) {
                try { ctx.logToPanel('[卫星·缩略图] 同步整体失败: ' + e.message + ' (items=' + items.length + ')', 'error'); } catch (_) {}
            }
        })();
        return true;
    }

    return false;
}

module.exports = {
    handleLowRiskAction: handleLowRiskAction
};
