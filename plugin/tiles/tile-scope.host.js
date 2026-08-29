// ============================================================
//  tile-scope.host.js — 示波器后端
//  职责:
//    1. scopeGrabPixels: 抓取当前活动文档合成像素 → 降采样 → 回传 panel
//    2. 监听 historyStateChanged: 用户每次产生历史动作就发 scope:psHistoryChanged
//       panel 端自己 debounce + 看磁贴是否展开决定要不要触发抓取
// ============================================================

var HostAPI = require('../host/host-api.js');
var photoshop = require('photoshop');
var imaging = require('photoshop').imaging;

var _historyHooked = false;

// ----- historyStateChanged 监听 (一次性, 全局) -----
function _hookHistoryEvents(ctx) {
    if (_historyHooked) return;
    if (!photoshop.action || !photoshop.action.addNotificationListener) return;
    try {
        var ret = photoshop.action.addNotificationListener([
            { event: 'historyStateChanged' }
        ], function(event, descriptor) {
            try {
                if (ctx && ctx.sendToPanel) {
                    ctx.sendToPanel('scope:psHistoryChanged', { ts: Date.now() });
                }
            } catch (e) {
                console.warn('[scope] history listener fail:', e);
            }
        });
        _historyHooked = true;
        // 部分 UXP 版本 addNotificationListener 返回 undefined 而不是 Promise
        if (ret && typeof ret.then === 'function') {
            ret.then(function() {
                console.log('[scope] 已注册 historyStateChanged 监听 (异步)');
            }).catch(function(e) {
                console.warn('[scope] 注册 historyStateChanged 失败:', e);
                _historyHooked = false;
            });
        } else {
            console.log('[scope] 已注册 historyStateChanged 监听 (同步)');
        }
    } catch (e) {
        console.warn('[scope] 注册 historyStateChanged 失败:', e);
        _historyHooked = false;
    }
}

// ============================================================
//  scopeInit — panel 第一次出现时调用, 触发 historyStateChanged 注册
// ============================================================
HostAPI.registerAction('scopeInit', async function(data, ctx) {
    _hookHistoryEvents(ctx);
    return { ok: true };
}, { tileId: 'scope' });

// ============================================================
//  scopeGrabPixels — 抓取活动文档合成像素 (整张, 降采样)
//
//  入参: { targetW, targetH }  // 想要的降采样尺寸 (默认 512x256)
//  出参: { ok, w, h, comp, rgba: ArrayBuffer (base64 编码), docW, docH, costMs }
//
//  说明:
//    - sourceBounds 用整个文档
//    - componentSize: 8 强制 8bit 输出
//    - applyAlpha: true 让透明背景按合成结果算 (空白文档显示黑)
//    - 16/32bit 文档自动降级
// ============================================================
HostAPI.registerAction('scopeGrabPixels', async function(data, ctx) {
    var t0 = Date.now();
    data = data || {};
    var targetW = +data.targetW || 512;
    var targetH = +data.targetH || 256;

    function _reply(payload) {
        if (ctx && ctx.sendToPanel) ctx.sendToPanel('scopeGrabPixels.result', payload);
    }

    var doc = photoshop.app.activeDocument;
    if (!doc) {
        _reply({ ok: false, error: 'no_document' });
        return;
    }
    var docW = doc.width;
    var docH = doc.height;
    var docId = doc.id;

    // 等比缩放到 targetW x targetH 内 (保持比例)
    var ratio = Math.min(targetW / docW, targetH / docH);
    var tw = Math.max(1, Math.round(docW * ratio));
    var th = Math.max(1, Math.round(docH * ratio));

    // 探测位深
    var bitDepth = 8;
    try { bitDepth = doc.bitsPerChannel || 8; } catch (e) {}
    var is16or32 = (bitDepth === 16 || bitDepth === 32);

    // getPixels 必须在 executeAsModal 内
    var pixelData;
    try {
        if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop 全局操作锁不可用');
        pixelData = await ctx.acquirePSLock(function() {
            var targetDoc = null;
            for (var di = 0; di < photoshop.app.documents.length; di++) {
                if (String(photoshop.app.documents[di].id) === String(docId)) { targetDoc = photoshop.app.documents[di]; break; }
            }
            if (!targetDoc) throw new Error('请求发起时的 PS 文档已关闭');
            return photoshop.core.executeAsModal(async function() {
                try {
                    return await imaging.getPixels({
                        documentID: docId,
                        sourceBounds: { left: 0, top: 0, right: docW, bottom: docH },
                        targetSize: { width: tw, height: th },
                        componentSize: 8,
                        colorSpace: 'RGB',
                        applyAlpha: true
                    });
                } catch (gpErr) {
                    if (is16or32) {
                        return await imaging.getPixels({
                            documentID: docId,
                            sourceBounds: { left: 0, top: 0, right: docW, bottom: docH },
                            targetSize: { width: tw, height: th },
                            colorSpace: 'RGB',
                            applyAlpha: true
                        });
                    }
                    throw gpErr;
                }
            }, { commandName: '示波器抓取像素' });
        }, 'scope-grab:' + docId);
    } catch (e) {
        _reply({ ok: false, error: 'getPixels: ' + (e && e.message || e) });
        return;
    }

    var imgObj = pixelData.imageData || pixelData;
    var comp = imgObj.components || 3;
    var pw = imgObj.width, ph = imgObj.height;
    var actualBits = imgObj.componentSize || 8;

    var rawBuf;
    if (typeof imgObj.getData === 'function') {
        rawBuf = await imgObj.getData();
    } else if (imgObj.data) {
        rawBuf = imgObj.data;
    } else {
        _reply({ ok: false, error: 'no pixel data' });
        return;
    }

    // 转 Uint8Array, 处理 16/32bit 数据
    var u8;
    if (actualBits === 16) {
        var u16 = new Uint16Array(rawBuf.buffer || rawBuf);
        u8 = new Uint8Array(u16.length);
        for (var i = 0; i < u16.length; i++) u8[i] = u16[i] >> 8;
    } else if (actualBits === 32) {
        var f32 = new Float32Array(rawBuf.buffer || rawBuf);
        u8 = new Uint8Array(f32.length);
        for (var j = 0; j < f32.length; j++) {
            var v = f32[j];
            if (v < 0) v = 0; else if (v > 1) v = 1;
            u8[j] = (v * 255) | 0;
        }
    } else {
        u8 = new Uint8Array(rawBuf.buffer || rawBuf);
    }

    // dispose ImageData
    try { if (typeof imgObj.dispose === 'function') imgObj.dispose(); } catch (e) {}

    // base64 编码 (UXP 消息通道传 ArrayBuffer 麻烦, base64 简单可靠)
    var b64 = _u8ToBase64(u8);

    _reply({
        ok: true,
        w: pw,
        h: ph,
        comp: comp,
        rgba: b64,
        docW: docW,
        docH: docH,
        costMs: Date.now() - t0
    });
}, { tileId: 'scope' });

// Uint8 → base64 (避免一次 String.fromCharCode 爆栈, 分块)
function _u8ToBase64(u8) {
    var CHUNK = 0x8000;
    var parts = [];
    for (var i = 0; i < u8.length; i += CHUNK) {
        var slice = u8.subarray(i, Math.min(i + CHUNK, u8.length));
        parts.push(String.fromCharCode.apply(null, slice));
    }
    return btoa(parts.join(''));
}
