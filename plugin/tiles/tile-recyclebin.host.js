// ============================================================
//  tile-recyclebin.host.js — 回收站磁贴 host 端
//
//  5 个 actions:
//    recycleListItems    — 拉列表 (分页 / 过滤 / 搜索)
//    recycleGetImage     — 拉单张大图 base64 (双击预览用)
//    recyclePlaceToPS    — 智能贴回原文档原选区 (原文档关了 → 拒绝)
//    recycleDelete       — 删单条 (图文件 + 索引)
//    recycleClear        — 批量清 (全清 / 仅失败 / N 天前)
// ============================================================

var HostAPI = require('../host/host-api.js');
var projThumb = require('../host/proj-thumb.js');   // 项目(整画布)封面
var placementLedger = require('../host/placement-ledger.js');   // v6.5.10: ⏸贴回补校色台账
var PsPixels = require('../host/ps-pixels.js');                 // v6.5.10: 读缓存原图用
var uxpFormats = require('uxp').storage.formats;
var photoshop = require('photoshop');
var app = photoshop.app;

// ============================================================
//  1. 列表
// ============================================================
HostAPI.registerAction('recycleListItems', async function(data, ctx) {
    try {
        if (!ctx.recycleBin) {
            ctx.sendToPanel('recycleListResult', { success: false, error: '回收站模块未加载' });
            return;
        }
        var res = await ctx.recycleBin.listItems({
            limit: data.limit || 50,
            offset: data.offset || 0,
            filterStatus: data.filterStatus || null,
            filterWorkflow: data.filterWorkflow || null,
            searchPrompt: data.searchPrompt || null
        });
        ctx.sendToPanel('recycleListResult', {
            success: true,
            total: res.total,
            items: res.items,
            offset: res.offset,
            limit: res.limit
        });
    } catch(e) {
        ctx.logToPanel('[回收站] 列表失败: ' + e.message, 'error');
        ctx.sendToPanel('recycleListResult', { success: false, error: e.message || String(e) });
    }
}, { tileId: 'recyclebin' });

// ============================================================
//  2. 取单张图 base64
// ============================================================
HostAPI.registerAction('recycleGetImage', async function(data, ctx) {
    try {
        var taskId = data.taskId;
        if (!taskId) {
            ctx.sendToPanel('recycleGetImageResult', { success: false, error: '缺少 taskId' });
            return;
        }
        var b64 = await ctx.recycleBin.getImageBase64(taskId);
        if (!b64) {
            ctx.sendToPanel('recycleGetImageResult', { success: false, taskId: taskId, error: '图像未保存 (失败任务) 或文件已损坏' });
            return;
        }
        ctx.sendToPanel('recycleGetImageResult', { success: true, taskId: taskId, base64: b64 });
    } catch(e) {
        ctx.sendToPanel('recycleGetImageResult', { success: false, taskId: data.taskId, error: e.message || String(e) });
    }
}, { tileId: 'recyclebin' });

// ============================================================
//  2b. 取缩略图 (v6.4.9) — 列表/封面专用, 有小图给小图, 没有退回原图
//  isThumb=false 时前端会补压一张回传(老数据自愈)
// ============================================================
HostAPI.registerAction('recycleGetThumb', async function(data, ctx) {
    try {
        var taskId = data.taskId;
        if (!taskId) {
            ctx.sendToPanel('recycleGetThumbResult', { success: false, error: '缺少 taskId' });
            return;
        }
        var res = await ctx.recycleBin.getThumbBase64(taskId);
        if (!res) {
            ctx.sendToPanel('recycleGetThumbResult', { success: false, taskId: taskId, error: '图像未保存或文件已损坏' });
            return;
        }
        ctx.sendToPanel('recycleGetThumbResult', { success: true, taskId: taskId, base64: res.base64, isThumb: res.isThumb });
    } catch(e) {
        ctx.sendToPanel('recycleGetThumbResult', { success: false, taskId: data.taskId, error: e.message || String(e) });
    }
}, { tileId: 'recyclebin' });

// ============================================================
//  2c. 存前端压缩好的缩略图 (v6.4.9) — 静默, 不回执(失败下次照样退回原图)
// ============================================================
HostAPI.registerAction('recycleSaveThumb', async function(data, ctx) {
    try {
        if (data && data.taskId && data.base64) {
            await ctx.recycleBin.saveThumb(data.taskId, data.base64);
        }
    } catch(_) {}
}, { tileId: 'recyclebin' });

// ============================================================
//  3. 智能贴回 — 原文档关了拒绝
// ============================================================
HostAPI.registerAction('recyclePlaceToPS', async function(data, ctx) {
    try {
        var taskId = data.taskId;
        var meta = await ctx.recycleBin.getMeta(taskId);
        if (!meta) {
            ctx.sendToPanel('recyclePlaceResult', { success: false, error: '回收站找不到该任务' });
            return;
        }
        if (!meta.imagePath) {
            ctx.sendToPanel('recyclePlaceResult', { success: false, error: '该任务没有保存图像 (失败 / aborted)' });
            return;
        }
        var c = meta.context || {};
        var docId = c.docId;
        if (!docId) {
            ctx.sendToPanel('recyclePlaceResult', { success: false, error: '该任务无文档上下文, 不能智能贴回' });
            return;
        }
        // 校验原文档是否还在
        var doc = null;
        try {
            var docs = app.documents;
            for (var i = 0; i < docs.length; i++) {
                if (docs[i].id === docId) { doc = docs[i]; break; }
            }
        } catch(_) {}
        if (!doc) {
            ctx.sendToPanel('recyclePlaceResult', {
                success: false,
                error: '原文档 "' + (c.docName || '未知') + '" 已关闭, 拒绝贴回 (请打开原文档后再试)'
            });
            return;
        }
        // 拿图 base64
        var b64 = await ctx.recycleBin.getImageBase64(taskId);
        if (!b64) {
            ctx.sendToPanel('recyclePlaceResult', { success: false, error: '图像读取失败' });
            return;
        }
        // 选区: 用归档时保存的, 没有就铺满整个文档
        var selection = c.selection || { left: 0, top: 0, right: doc.width, bottom: doc.height, width: doc.width, height: doc.height };
        var antiMode = (c.antiMode !== undefined) ? c.antiMode : (ctx.g_antiTruncationModeRef ? ctx.g_antiTruncationModeRef.value : 0);
        var layerType = c.layerType || (ctx.g_layerTypeRef ? ctx.g_layerTypeRef.value : 'smartObject');

        // ── v6.5.10: ⏸(后台完成图)贴回不再"裸贴" — 补齐正常传回的校色配套 ──
        // 归档 context 带 runFolderName(缓存文件夹)时:
        //   1. 原图存进缓存 output_XXX.png(后台完成的图没走统一回图, 缓存里缺它;
        //      手动校色按台账 outputIdx 找这个文件, 不存就永远"查不到原图缓存")
        //   2. 开了自动校色开关 → 贴回前先按抓图原图校色(贴校色版, 缓存留原版, 与主流程一致)
        //   3. 贴回成功后补记校色台账(内存 + meta.json)
        // runFolderName 缺失(老记录/其他玩法) → 全部跳过, 行为与从前一样
        var _rbRunFolder = null;
        var _rbOutputIdx = 0;
        var _rbInputB64 = null;
        var placeB64 = b64;
        if (c.runFolderName) {
            try {
                var _rbCacheFolder = await ctx.getOrCreateImageCacheFolder();
                _rbRunFolder = await placementLedger.getRunFolderByPath(_rbCacheFolder, c.runFolderName);
                // 下一个空闲 output 序号(已有 output_001..N 就接着排)
                var _rbEntries = await _rbRunFolder.getEntries();
                var _rbMax = 0;
                for (var _rbi = 0; _rbi < _rbEntries.length; _rbi++) {
                    var _rbm = _rbEntries[_rbi].name.match(/^output_(\d+)\.png$/);
                    if (_rbm && +_rbm[1] > _rbMax) _rbMax = +_rbm[1];
                }
                _rbOutputIdx = _rbMax + 1;
                await ctx.saveImageToRunFolder(_rbRunFolder, 'output', b64, _rbOutputIdx);
                // 读抓图原图(自动校色的比对基准)
                try {
                    var _rbInFile = await _rbRunFolder.getEntry('input_001.png');
                    var _rbInBuf = await _rbInFile.read({ format: uxpFormats.binary });
                    _rbInputB64 = PsPixels.arrayBufferToBase64(_rbInBuf);
                } catch (_eIn) { /* 没抓图(无选区场景), 跳过校色 */ }
            } catch (eCache) {
                _rbRunFolder = null;
                _rbOutputIdx = 0;
                ctx.logToPanel('[回收站] 缓存目录不可用, 本次裸贴(不校色/不记台账): ' + ((eCache && eCache.message) || eCache), 'warn');
            }
            // v6.6.0: 自动校色功能整体停用(设置开关已删), ⏸贴回不再校色, 恒 false;
            // 台账照记 — 贴回后选中图层用 Dock 手动校色仍可用
            var _rbCmOn = false;
            if (_rbCmOn && _rbInputB64) {
                try {
                    var _rbCmMod = require('./tile-colormatch.host.js');
                    // genTaskId = 归档的 batchId(就是生成任务号) → 气泡缩略图有"校色中"呼吸动画
                    var _rbCmRes = await _rbCmMod.autoColormatchAll(ctx, { inputB64: _rbInputB64, payloads: [b64], genTaskId: meta.batchId });
                    if (_rbCmRes && _rbCmRes.payloads && _rbCmRes.payloads[0]) placeB64 = _rbCmRes.payloads[0];
                    ctx.logToPanel('[回收站] 贴回前自动校色' + (_rbCmRes.correctedCount ? '完成' : '失败(传原图)'), _rbCmRes.correctedCount ? 'info' : 'warn');
                } catch (eCm) {
                    ctx.logToPanel('[回收站] 自动校色出错, 本次传原图: ' + ((eCm && eCm.message) || eCm), 'warn');
                }
            }
        }

        if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop 全局操作锁不可用');
        var placedLayerId = await ctx.acquirePSLock(async function() {
            var targetDoc = null;
            for (var di = 0; di < app.documents.length; di++) {
                if (String(app.documents[di].id) === String(docId)) { targetDoc = app.documents[di]; break; }
            }
            if (!targetDoc) throw new Error('原文档已关闭，拒绝贴回');
            var layerId = await ctx.placeImageToSpecificDoc(placeB64, docId, selection, antiMode, layerType);
            // 自动扩充+裁切的任务: 归档选区带 cropRect(发送前补过白边) → 贴回后按原选区加蒙版裁白
            if (layerId && selection && selection.cropRect && ctx.applyReturnFeatherMaskToLayer) {
                try { await ctx.applyReturnFeatherMaskToLayer(docId, layerId, selection, '__recycleCrop'); }
                catch (eCrop) { ctx.logToPanel('[回收站] 裁白蒙版失败(图已贴回, 白边需手动裁): ' + (eCrop.message || eCrop), 'warn'); }
            }
            return layerId;
        }, 'recycle-place:' + taskId);
        // 补记校色台账(图层↔缓存对应) — 之后选中这个图层就能手动校色了
        if (placedLayerId && _rbRunFolder && _rbOutputIdx) {
            try {
                var _rbLedgerEntry = {
                    docId: docId,
                    docName: c.docName || '',
                    layerId: placedLayerId,
                    runFolderName: c.runFolderName,
                    inputIdx: 1,
                    outputIdx: _rbOutputIdx,
                    selection: c.selection || null,
                    antiMode: antiMode,
                    layerType: layerType,
                    featherKey: 'bananaSingle',
                    engine: 'api',
                    ts: Date.now()
                };
                placementLedger.record(_rbLedgerEntry);
                await placementLedger.writeMetaJson(_rbRunFolder, [_rbLedgerEntry]);
            } catch (eLedger) {
                ctx.logToPanel('[回收站] 校色台账登记失败(图已贴回, 该图层不能手动校色): ' + ((eLedger && eLedger.message) || eLedger), 'warn');
            }
        }
        ctx.logToPanel('[回收站] 已贴回 ' + taskId + ' → ' + (c.docName || ('doc#' + docId)), 'success');
        ctx.sendToPanel('recyclePlaceResult', { success: true, taskId: taskId, layerId: placedLayerId });
    } catch(e) {
        ctx.logToPanel('[回收站] 贴回失败: ' + e.message, 'error');
        ctx.sendToPanel('recyclePlaceResult', { success: false, error: e.message || String(e) });
    }
}, { tileId: 'recyclebin' });

// ============================================================
//  4. 删
// ============================================================
HostAPI.registerAction('recycleDelete', async function(data, ctx) {
    try {
        var ok = await ctx.recycleBin.deleteItem(data.taskId);
        ctx.sendToPanel('recycleDeleteResult', { success: ok, taskId: data.taskId });
    } catch(e) {
        ctx.sendToPanel('recycleDeleteResult', { success: false, taskId: data.taskId, error: e.message || String(e) });
    }
}, { tileId: 'recyclebin' });

// ============================================================
//  5. 清 (批量)
//    data.all                 — 全清
//    data.failedOnly          — 仅删失败/aborted
//    data.olderThanDays       — 删 N 天之前的
// ============================================================
HostAPI.registerAction('recycleClear', async function(data, ctx) {
    try {
        var res = await ctx.recycleBin.clearItems({
            all: !!data.all,
            failedOnly: !!data.failedOnly,
            olderThanDays: data.olderThanDays || 0
        });
        ctx.logToPanel('[回收站] 已清理 ' + res.deleted + ' 条, 剩余 ' + res.remaining + ' 条', 'info');
        ctx.sendToPanel('recycleClearResult', { success: true, deleted: res.deleted, remaining: res.remaining });
    } catch(e) {
        ctx.sendToPanel('recycleClearResult', { success: false, error: e.message || String(e) });
    }
}, { tileId: 'recyclebin' });

// ============================================================
//  2d. 项目封面 (v6.5.0) — 整画布缩略图, 每次生成后由 host 主动更新
// ============================================================
HostAPI.registerAction('recycleGetProjThumb', async function(data, ctx) {
    try {
        var key = data && data.projKey;
        if (!key) return;
        var b64 = await projThumb.getProjThumb(key);
        ctx.sendToPanel('recycleProjThumbResult', { projKey: key, base64: b64 || null });
    } catch(e) {
        ctx.sendToPanel('recycleProjThumbResult', { projKey: data && data.projKey, base64: null });
    }
}, { tileId: 'recyclebin' });

module.exports = {};
