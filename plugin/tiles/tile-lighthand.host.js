// ============================================================
//  tile-lighthand.host.js
//  手绘灯光磁贴 — host 端
//
//  注册的 action:
//    lightHandPlace  - 把合成图(base64) 置入 PS 当前文档,作为智能对象图层,
//                      并按"灯光-XX-XX-XX"重命名;不做栅格化/抗截断/缩放
//
//  生成由用户回到主面板的"开始计算"按钮触发,本磁贴不参与生成。
// ============================================================

var HostAPI = require('../host/host-api.js');
var uxpModule = require('uxp');
var storage = uxpModule.storage;
var fs = storage.localFileSystem;
var photoshop = require('photoshop');
var psApp = photoshop.app;
var psCore = photoshop.core;

// base64 → ArrayBuffer
function _b64ToArrayBuffer(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var buf = new ArrayBuffer(len);
    var view = new Uint8Array(buf);
    for (var i = 0; i < len; i++) view[i] = bin.charCodeAt(i);
    return buf;
}

// ============================================================
//  lightHandPlace — 置入合成图作为智能对象图层 + 重命名
//  data: { reqId, base64, layerName, docId? }
// ============================================================
HostAPI.registerAction('lightHandPlace', async function(data, ctx) {
    var reqId = data && data.reqId;
    if (!data || !data.base64) {
        ctx.sendToPanel('lightHandPlaceResult', { reqId: reqId, success: false, error: '缺少 base64 数据' });
        return true;
    }

    // 必须在第一次 await 之前固定目标文档。否则请求排队等 PS 锁期间用户切换
    // 文档，灯光会被错误地放进后来切到的文档。
    var targetDocId = data.docId != null ? data.docId : null;
    if (targetDocId == null) {
        try { targetDocId = psApp.activeDocument && psApp.activeDocument.id; } catch (_) {}
    }
    if (targetDocId == null) {
        ctx.sendToPanel('lightHandPlaceResult', { reqId: reqId, success: false, error: '没有打开的 PS 文档' });
        return true;
    }

    var rawFile = null;
    try {
        // 写临时 PNG 文件
        var tempFolder = await fs.getTemporaryFolder();
        var ts = Date.now() + '_' + Math.random().toString(36).substr(2, 4);
        rawFile = await tempFolder.createFile('lighthand_' + ts + '.png', { overwrite: true });
        await rawFile.write(_b64ToArrayBuffer(data.base64), { format: storage.formats.binary });

        var layerId = null;
        if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop 全局操作锁不可用');
        await ctx.acquirePSLock(function() { return psCore.executeAsModal(async function() {
            var targetDoc = null;
            for (var di = 0; di < psApp.documents.length; di++) {
                if (String(psApp.documents[di].id) === String(targetDocId)) {
                    targetDoc = psApp.documents[di];
                    break;
                }
            }
            if (!targetDoc) throw new Error('请求发起时的 PS 文档已关闭');
            await psApp.batchPlay([{
                _obj: 'select',
                _target: [{ _ref: 'document', _id: targetDoc.id }]
            }], {});

            // 确保选中最顶层图层(避免被嵌套组里)
            await psApp.batchPlay([{
                _obj: 'select',
                _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'front' }],
                makeVisible: false
            }], {});

            // placeEvent 置入 — 默认居中、保持原尺寸、智能对象
            var placeToken = await fs.createSessionToken(rawFile);
            await psApp.batchPlay([{
                _obj: 'placeEvent',
                null: { _path: placeToken, _kind: 'local' },
                freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
                offset: {
                    _obj: 'offset',
                    horizontal: { _unit: 'pixelsUnit', _value: 0 },
                    vertical: { _unit: 'pixelsUnit', _value: 0 }
                }
            }], {});

            // 拿新图层 id
            try {
                layerId = targetDoc.activeLayers[0].id;
            } catch (_e) { layerId = null; }

            // 重命名图层
            var layerName = String(data.layerName || '灯光示意').slice(0, 80);
            if (layerId != null) {
                await psApp.batchPlay([{
                    _obj: 'set',
                    _target: [{ _ref: 'layer', _id: layerId }],
                    to: { _obj: 'layer', name: layerName }
                }], {});
            } else {
                // id 拿不到时退回到 targetEnum
                await psApp.batchPlay([{
                    _obj: 'set',
                    _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                    to: { _obj: 'layer', name: layerName }
                }], {});
            }
        }, { commandName: '置入灯光示意' }); }, 'lighthand-place:' + (reqId || ts));

        ctx.logToPanel('[手绘灯光] 已置入图层: ' + (data.layerName || ''), 'success');
        ctx.sendToPanel('lightHandPlaceResult', { reqId: reqId, success: true, layerId: layerId, layerName: data.layerName, docId: targetDocId });
    } catch (e) {
        ctx.logToPanel('[手绘灯光] 置入失败: ' + e.message, 'error');
        ctx.sendToPanel('lightHandPlaceResult', { reqId: reqId, success: false, error: e.message });
    } finally {
        if (rawFile) { try { await rawFile.delete(); } catch (_) {} }
    }
    return true;
});
