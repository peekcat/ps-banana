// ============================================================
//  tile-perftest.host.js — 回图性能测试(开发工具)
//
//  三种回图方式同台对比, 每张打上编号看对齐, host 端计时看速度:
//    A = 现行链路 placeImageToSpecificDoc(placeEvent + 多次 batchPlay 往返, 智能对象)
//    B = 精简 placeEvent(合并 batchPlay 调用, 一次 transform 同时缩放+定位)
//    C = imaging.putPixels 直写像素层(前端已按选区尺寸出好 RGBA, 零变换)
//
//  计时只包住"置入 PS"的部分, 不含消息传输(三种方式载荷大小不同, 传输不公平)。
// ============================================================

var HostAPI = require('../host/host-api.js');
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;
var imaging = photoshop.imaging;
var uxpModule = require('uxp');
var storage = uxpModule.storage;
var fs = storage.localFileSystem;

function _b64ToArrayBuffer(b64) {
    var bin = atob(b64);
    var buf = new ArrayBuffer(bin.length);
    var view = new Uint8Array(buf);
    for (var i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
    return buf;
}

// ── 抓取: 复用现有选区抓取链路 ──
HostAPI.registerAction('perftestCapture', async function(data, ctx) {
    try {
        var doc = app.activeDocument;
        if (!doc) { ctx.sendToPanel('perftestCaptureResult', { success: false, error: '没有打开的文档' }); return; }
        var cap = null;
        await ctx.acquirePSLock(async function() {
            cap = await ctx.getSelectionAndImage();
        }, 'perftest_' + Date.now());
        if (!cap || !cap.base64) {
            ctx.sendToPanel('perftestCaptureResult', { success: false, error: '未检测到选区' });
            return;
        }
        ctx.sendToPanel('perftestCaptureResult', {
            success: true,
            base64: cap.base64,
            selection: cap.selection,
            docId: doc.id
        });
    } catch (e) {
        ctx.sendToPanel('perftestCaptureResult', { success: false, error: e.message || String(e) });
    }
}, { tileId: 'perftest' });

// ── 方式 A: 现行链路原样(基准) ──
async function _placeA(ctx, d) {
    return await ctx.placeImageToSpecificDoc(d.base64, d.docId, d.selection, 0, 'smartObject');
}

// ── 方式 B: 精简 placeEvent — 合并调用, 单次 transform 缩放+定位一起做 ──
async function _placeB(ctx, d) {
    var tempFolder = await fs.getTemporaryFolder();
    var ts = Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    var rawFile = await tempFolder.createFile('perfb_' + ts + '.png', { overwrite: true });
    await rawFile.write(_b64ToArrayBuffer(d.base64), { format: storage.formats.binary });
    var sel = d.selection;
    await core.executeAsModal(async function() {
        var token = await fs.createSessionToken(rawFile);
        // 一次 batchPlay 数组: 切文档 + 置入(减少往返)
        await app.batchPlay([
            { _obj: 'select', _target: [{ _ref: 'document', _id: d.docId }] },
            { _obj: 'placeEvent', null: { _path: token, _kind: 'local' },
              freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
              offset: { _obj: 'offset', horizontal: { _unit: 'pixelsUnit', _value: 0 }, vertical: { _unit: 'pixelsUnit', _value: 0 } } }
        ], {});
        // 读一次 bounds
        var br = await app.batchPlay([{
            _obj: 'get',
            _target: [{ _property: 'boundsNoEffects' }, { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
        }], {});
        var b = br[0].boundsNoEffects;
        var bw = b.right._value - b.left._value;
        var bh = b.bottom._value - b.top._value;
        if (bw <= 0 || bh <= 0) throw new Error('置入图层尺寸异常');
        var scaleX = (sel.width / bw) * 100;
        var scaleY = (sel.height / bh) * 100;
        // 目标中心 - 当前中心 = 偏移; transform 一次完成缩放+平移
        var curCX = (b.left._value + b.right._value) / 2;
        var curCY = (b.top._value + b.bottom._value) / 2;
        var tgtCX = (sel.left + sel.right) / 2;
        var tgtCY = (sel.top + sel.bottom) / 2;
        await app.batchPlay([{
            _obj: 'transform',
            _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
            freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
            offset: { _obj: 'offset',
                horizontal: { _unit: 'pixelsUnit', _value: tgtCX - curCX },
                vertical: { _unit: 'pixelsUnit', _value: tgtCY - curCY } },
            width: { _unit: 'percentUnit', _value: scaleX },
            height: { _unit: 'percentUnit', _value: scaleY },
            interfaceIconFrameDimmed: { _enum: 'interpolationType', _value: 'bicubic' }
        }], {});
    }, { commandName: '性能测试B·精简置入' });
    try { await rawFile.delete(); } catch(_) {}
    return true;
}

// ── 方式 C: imaging.putPixels 直写像素层(前端已出好选区尺寸的 RGBA) ──
async function _placeC(ctx, d) {
    // d.rawB64 = RGBA 原始字节的 base64; d.rawW/rawH = 尺寸(应等于选区宽高)
    var buf = _b64ToArrayBuffer(d.rawB64);
    var imgData = await imaging.createImageDataFromBuffer(new Uint8Array(buf), {
        width: d.rawW, height: d.rawH,
        components: 4, chunky: true,
        colorSpace: 'RGB', colorProfile: 'sRGB IEC61966-2.1'
    });
    var sel = d.selection;
    try {
        await core.executeAsModal(async function() {
            await app.batchPlay([
                { _obj: 'select', _target: [{ _ref: 'document', _id: d.docId }] },
                { _obj: 'make', _target: [{ _ref: 'layer' }] }   // 新建空像素层
            ], {});
            var lyr = app.activeDocument.activeLayers[0];
            await imaging.putPixels({
                documentID: d.docId,
                layerID: lyr.id,
                imageData: imgData,
                targetBounds: { left: Math.round(sel.left), top: Math.round(sel.top) }
            });
        }, { commandName: '性能测试C·putPixels' });
    } finally {
        try { imgData.dispose(); } catch(_) {}
    }
    return true;
}

// ── 方式 D: 批量单权限 — 一次 executeAsModal 贴完全部 N 张(+可选打组) ──
// 用户的思路: "全部一次性传回来再统一处理", 省 N-1 次修改权申请 + 历史合并。
// 每张的缩放/定位参数依赖读它自己的 bounds, 所以是"置入完立刻定位这张但不出修改权"。
// data: { docId, selection, images: [{idx, base64}], group: bool }
// 逐张回报: perftestPlaceResult(idx/ms 为该张在批内的耗时); 结束再发 perftestBatchDone(总耗时)
async function _placeD(ctx, d, sendToPanel) {
    var tempFolder = await fs.getTemporaryFolder();
    var sel = d.selection;
    // 温备: 先把全部临时文件写好(不占修改权时间)
    var files = [];
    for (var i = 0; i < d.images.length; i++) {
        var ts = Date.now() + '_' + i + '_' + Math.random().toString(36).substr(2, 4);
        var f = await tempFolder.createFile('perfd_' + ts + '.png', { overwrite: true });
        await f.write(_b64ToArrayBuffer(d.images[i].base64), { format: storage.formats.binary });
        files.push(f);
    }
    var t0 = Date.now();
    var createdIds = [];
    await core.executeAsModal(async function(executionContext) {
        // 历史合并: 整批算一步(撤销一次撤整批, PS 内部开销也更小)
        var hostControl = executionContext.hostControl;
        var docIdForHistory = d.docId;
        var suspensionID = null;
        try {
            suspensionID = await hostControl.suspendHistory({
                documentID: docIdForHistory,
                name: '性能测试D·批量贴回 ' + d.images.length + ' 张'
            });
        } catch(_h) {}

        await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: d.docId }] }], {});

        for (var k = 0; k < d.images.length; k++) {
            var tk0 = Date.now();
            try {
                var token = await fs.createSessionToken(files[k]);
                await app.batchPlay([{
                    _obj: 'placeEvent', null: { _path: token, _kind: 'local' },
                    freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
                    offset: { _obj: 'offset', horizontal: { _unit: 'pixelsUnit', _value: 0 }, vertical: { _unit: 'pixelsUnit', _value: 0 } }
                }], {});
                var br = await app.batchPlay([{
                    _obj: 'get',
                    _target: [{ _property: 'boundsNoEffects' }, { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
                }], {});
                var b = br[0].boundsNoEffects;
                var bw = b.right._value - b.left._value;
                var bh = b.bottom._value - b.top._value;
                if (bw > 0 && bh > 0) {
                    await app.batchPlay([{
                        _obj: 'transform',
                        _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                        freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
                        offset: { _obj: 'offset',
                            horizontal: { _unit: 'pixelsUnit', _value: (sel.left + sel.right) / 2 - (b.left._value + b.right._value) / 2 },
                            vertical: { _unit: 'pixelsUnit', _value: (sel.top + sel.bottom) / 2 - (b.top._value + b.bottom._value) / 2 } },
                        width: { _unit: 'percentUnit', _value: (sel.width / bw) * 100 },
                        height: { _unit: 'percentUnit', _value: (sel.height / bh) * 100 },
                        interfaceIconFrameDimmed: { _enum: 'interpolationType', _value: 'bicubic' }
                    }], {});
                }
                try { createdIds.push(app.activeDocument.activeLayers[0].id); } catch(_) {}
                sendToPanel('perftestPlaceResult', { success: true, idx: d.images[k].idx, method: 'D', ms: Date.now() - tk0 });
            } catch (ePlace) {
                sendToPanel('perftestPlaceResult', { success: false, idx: d.images[k].idx, method: 'D', error: (ePlace && ePlace.message) || String(ePlace) });
            }
        }

        // 可选: 同一修改权内顺带打组(现行链路这是第二次独立修改权 — 合并掉)
        if (d.group && createdIds.length > 1) {
            try {
                var selTargets = createdIds.map(function(id) { return { _ref: 'layer', _id: id }; });
                await app.batchPlay([
                    { _obj: 'select', _target: selTargets, makeVisible: false },
                    { _obj: 'make', _target: [{ _ref: 'layerSection' }], from: { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }, using: { _obj: 'layerSection', name: '性能测试D' } }
                ], {});
            } catch(_g) {}
        }

        if (suspensionID != null) {
            try { await hostControl.resumeHistory(suspensionID); } catch(_r) {}
        }
    }, { commandName: '性能测试D·批量贴回' });

    // 清临时文件
    for (var c = 0; c < files.length; c++) { try { await files[c].delete(); } catch(_) {} }
    return Date.now() - t0;
}

HostAPI.registerAction('perftestPlaceBatch', async function(data, ctx) {
    try {
        var totalMs = await _placeD(ctx, data, ctx.sendToPanel);
        ctx.sendToPanel('perftestBatchDone', { success: true, totalMs: totalMs, count: (data.images || []).length });
    } catch (e) {
        ctx.sendToPanel('perftestBatchDone', { success: false, error: e.message || String(e) });
    }
}, { tileId: 'perftest' });

HostAPI.registerAction('perftestPlace', async function(data, ctx) {
    var idx = data.idx || 0;
    try {
        var t0 = Date.now();
        if (data.method === 'A') await _placeA(ctx, data);
        else if (data.method === 'B') await _placeB(ctx, data);
        else if (data.method === 'C') await _placeC(ctx, data);
        else throw new Error('未知方式: ' + data.method);
        var ms = Date.now() - t0;
        ctx.sendToPanel('perftestPlaceResult', { success: true, idx: idx, method: data.method, ms: ms });
    } catch (e) {
        ctx.sendToPanel('perftestPlaceResult', { success: false, idx: idx, method: data.method, error: e.message || String(e) });
    }
}, { tileId: 'perftest' });

module.exports = {};
