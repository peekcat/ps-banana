// ============================================================
//  host/satellite-events.js
//  PS 事件侦听: 检测图层删除/盖印/拼平等动作, 通知 panel 失效缩略图
//
//  原理: 用 photoshop.action.addNotificationListener (被动接收事件, 不调用 executeAsModal)
//  对比之前 _validateSatelliteLayers 主动 batchPlay 验证 → 文档闪烁
//  这种方式零副作用, 只在用户实际操作时才触发
//
//  监听事件:
//    delete         — 图层删除 (descriptor 里能拿到具体 layerID)
//    mergeVisible   — 盖印 (Ctrl+Alt+Shift+E) — 全部图层变化, 标整 doc 失效
//    flattenImage   — 拼合所有可见图层 — 同上
//    mergeLayersNew — 合并选中图层为新图层 — 同上
//
//  用法:
//    var sat = require('./satellite-events.js');
//    sat.init(sendToPanel);
// ============================================================

var _photoshop = null;
try { _photoshop = require('photoshop'); } catch (e) {}

var _initialized = false;

function init(sendToPanel) {
    if (_initialized) return;
    _initialized = true;
    if (!_photoshop || !_photoshop.action || !_photoshop.action.addNotificationListener) {
        console.warn('[satellite-events] photoshop.action.addNotificationListener 不可用, 跳过');
        return;
    }

    var listener = function(event, descriptor) {
        try {
            // delete 事件: 提取 layerID (可能是单个或多个 _target)
            if (event === 'delete') {
                var layerIds = _extractLayerIDs(descriptor);
                if (layerIds.length) {
                    sendToPanel('psLayerInvalidated', {
                        reason: 'delete',
                        layerIDs: layerIds,
                        ts: Date.now()
                    });
                }
                return;
            }
            // mergeVisible / flattenImage / mergeLayersNew: 文档结构剧变, 标全部 owned 失效
            if (event === 'mergeVisible' || event === 'flattenImage' || event === 'mergeLayersNew') {
                sendToPanel('psLayerInvalidated', {
                    reason: event,
                    layerIDs: 'all',
                    ts: Date.now()
                });
                return;
            }
        } catch (e) {
            console.warn('[satellite-events] listener fail:', e);
        }
    };

    _photoshop.action.addNotificationListener([
        { event: 'delete' },
        { event: 'mergeVisible' },
        { event: 'flattenImage' },
        { event: 'mergeLayersNew' }
    ], listener).then(function() {
        console.log('[satellite-events] 已注册 PS 事件侦听 (delete/mergeVisible/flattenImage/mergeLayersNew)');
    }).catch(function(e) {
        console.warn('[satellite-events] 注册失败:', e);
    });
}

// 从 descriptor.null._target 里抠出 layerID (delete 事件)
//   descriptor 形如: { null: { _ref: [{ _ref:'layer', _id: 123 }, ...] } }
//   或: { null: [{ _ref:'layer', _id: 123 }] }
function _extractLayerIDs(descriptor) {
    if (!descriptor) return [];
    var ids = [];
    var target = descriptor.null || descriptor._target || descriptor;
    function walk(node) {
        if (!node) return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (typeof node !== 'object') return;
        if (node._ref === 'layer' && node._id != null) {
            var n = +node._id;
            if (!isNaN(n) && ids.indexOf(n) === -1) ids.push(n);
        }
        // 递归子对象 (有时嵌套 _ref 数组)
        Object.keys(node).forEach(function(k) {
            if (k !== '_id' && k !== '_ref') walk(node[k]);
        });
    }
    walk(target);
    return ids;
}

module.exports = { init: init };
