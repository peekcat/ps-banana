// ============================================================
//  core/aspect-warn.js
//
//  比例不匹配预警 — 给"下沉用户"用的护栏
//
//  3 个场景:
//    1. 生图前: PS 选区比例 != 生图比例 (1:1/16:9 等)
//    2. 批处理加入队列前: 同上
//    3. 新加参考图: 跟已有参考图比例不一致
//
//  入口:
//    AspectWarn.probeSelection()                — Promise<{hasDoc, hasSelection, selWidth/Height, docWidth/Height}>
//    AspectWarn.checkSelVsAspect(selW, selH, aspectStr)  → 'match' | 'mismatch' | 'skip'
//    AspectWarn.checkRefVsRefs(newW, newH, existingRefs) → 'match' | 'mismatch'
//    AspectWarn.confirmBeforeGenerate({selW, selH, aspect, kind})  Promise<bool>   true=继续 false=取消
//    AspectWarn.confirmBeforeAddRef({newW, newH, refs})            Promise<bool>
//
//  挂在 window 上 (panel 端无模块系统, 跟 UIKit 一致)
// ============================================================

(function() {
'use strict';

// 比例容差: 选区和目标差 >15% 才算"不匹配"
//   实测: 1024x1080 vs 1:1 大约差 5%, 用户不会察觉拉伸, 不弹
//         1920x1080 vs 1:1 差 78%, 必弹
var TOLERANCE = 0.15;

// 常见标准比例 (用于推荐"最接近"的比例)
var STANDARD_ASPECTS = [
    { label: '1:1', ratio: 1.0 },
    { label: '16:9', ratio: 16/9 },
    { label: '9:16', ratio: 9/16 },
    { label: '4:3', ratio: 4/3 },
    { label: '3:4', ratio: 3/4 },
    { label: '3:2', ratio: 3/2 },
    { label: '2:3', ratio: 2/3 },
    { label: '21:9', ratio: 21/9 },
    { label: '9:21', ratio: 9/21 }
];

function _parseAspect(s) {
    if (!s) return null;
    s = String(s).trim();
    if (!s || s === 'Auto' || s === 'auto') return null;
    var m = s.split(':');
    if (m.length !== 2) return null;
    var w = parseFloat(m[0]), h = parseFloat(m[1]);
    if (!w || !h) return null;
    return w / h;
}

function _recommendNearest(ratio) {
    if (!ratio || !isFinite(ratio)) return '1:1';
    var best = STANDARD_ASPECTS[0];
    var bestDiff = Math.abs(STANDARD_ASPECTS[0].ratio - ratio) / STANDARD_ASPECTS[0].ratio;
    for (var i = 1; i < STANDARD_ASPECTS.length; i++) {
        var d = Math.abs(STANDARD_ASPECTS[i].ratio - ratio) / STANDARD_ASPECTS[i].ratio;
        if (d < bestDiff) { best = STANDARD_ASPECTS[i]; bestDiff = d; }
    }
    return best.label;
}

function _esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _fmtRatio(w, h) {
    if (!w || !h) return '?';
    var r = w / h;
    // 用最简整数比 (gcd)
    function gcd(a, b) { return b ? gcd(b, a % b) : a; }
    var aW = Math.round(w), aH = Math.round(h);
    var g = gcd(aW, aH);
    if (g > 0 && aW/g <= 50 && aH/g <= 50) {
        return (aW/g) + ':' + (aH/g);
    }
    return r.toFixed(2);
}

// ============================================================
//  探测当前 PS 选区 (panel 侧封装, 一次性 Promise)
//    不抓像素, 只要矩形
//
//  TileAPI 没有 offHostMessage, 所以用单一持久 listener + 队列模式
//  (并发调用很少, 队列基本就 1 个 pending)
// ============================================================
var _probeQueue = [];
var _probeListenerInited = false;

function _ensureProbeListener() {
    if (_probeListenerInited) return;
    _probeListenerInited = true;
    try {
        window.TileAPI.onHostMessage('probeSelectionRectResult', function(data) {
            var pending = _probeQueue.shift();
            if (pending) {
                clearTimeout(pending.timer);
                pending.resolve(data || { hasDoc: false, hasSelection: false });
            }
        });
    } catch(_) {}
}

function probeSelection() {
    _ensureProbeListener();
    return new Promise(function(resolve) {
        var entry = { resolve: resolve, timer: null };
        entry.timer = setTimeout(function() {
            // 兜底: 1.5s 没回就当作没选区, 把自己从队列里拿掉
            var idx = _probeQueue.indexOf(entry);
            if (idx !== -1) _probeQueue.splice(idx, 1);
            resolve({ hasDoc: false, hasSelection: false, timeout: true });
        }, 1500);
        _probeQueue.push(entry);
        try { window.TileAPI.sendToHost('probeSelectionRect', {}); }
        catch(e) {
            clearTimeout(entry.timer);
            var i = _probeQueue.indexOf(entry);
            if (i !== -1) _probeQueue.splice(i, 1);
            resolve({ hasDoc: false, hasSelection: false, error: e.message });
        }
    });
}

// ============================================================
//  纯函数: 检查"选区 vs 生图比例"
//    'skip'     — Auto / 无法判断, 不弹
//    'match'    — 差距在容差内, 不弹
//    'mismatch' — 必弹
// ============================================================
function checkSelVsAspect(selW, selH, aspectStr) {
    if (!selW || !selH) return 'skip';
    // 「自动扩充+裁切」开着且目标比例 1:1 时, 非方形选区本来就是该功能的正常用法
    // (发送前自动补白凑方) — 此时比例不匹配不是错误, 预警必须闭嘴
    try {
        if (String(aspectStr).trim() === '1:1'
            && window.TileAPI && TileAPI.storage
            && TileAPI.storage.get('output.autoPadCrop') === true) return 'skip';
    } catch (e) {}
    var target = _parseAspect(aspectStr);
    if (target === null) return 'skip';   // Auto
    var actual = selW / selH;
    var diff = Math.abs(actual - target) / target;
    return diff > TOLERANCE ? 'mismatch' : 'match';
}

// ============================================================
//  纯函数: 检查"新参考图 vs 已有参考图"
//    existingRefs: [{ width, height }, ...]  任何一个超出容差 → mismatch
// ============================================================
function checkRefVsRefs(newW, newH, existingRefs) {
    if (!newW || !newH) return 'skip';
    if (!existingRefs || !existingRefs.length) return 'match';
    var newRatio = newW / newH;
    for (var i = 0; i < existingRefs.length; i++) {
        var r = existingRefs[i];
        if (!r || !r.width || !r.height) continue;
        var ratio = r.width / r.height;
        var diff = Math.abs(newRatio - ratio) / ratio;
        if (diff > TOLERANCE) return 'mismatch';
    }
    return 'match';
}

// ============================================================
//  弹窗 1: 生图/批处理前的"选区 vs 比例"预警
//    kind: 'gen' (单图生成) / 'batch' (加入批处理) / 'addref' (此函数不用)
//    返回 true=继续, false=取消
// ============================================================
function confirmBeforeGenerate(args) {
    if (!window.UIKit || !window.UIKit.dialog) return Promise.resolve(true);
    var selW = args.selW, selH = args.selH;
    var aspectStr = args.aspect || '';
    var kind = args.kind || 'gen';

    var selRatioStr = _fmtRatio(selW, selH);
    var targetRatio = _parseAspect(aspectStr);
    var nearest = (selW && selH) ? _recommendNearest(selW / selH) : '1:1';
    var actionVerb = (kind === 'batch') ? '仍要加入队列' : '仍要生成';

    var html =
        '<div class="aspect-warn-body" style="font-size:13px;line-height:1.7">' +
            '<div style="display:flex;align-items:center;gap:14px;padding:10px 12px;background:rgba(255,160,80,0.12);border-radius:6px;margin-bottom:12px">' +
                '<img src="icons/nonono.jpg" alt="" style="width:64px;height:64px;border-radius:6px;flex:0 0 64px;object-fit:cover">' +
                '<div style="flex:1">' +
                    '<div>你框选的: <b style="color:#ffd28a">' + selW + ' × ' + selH + '</b> (约 <b>' + _esc(selRatioStr) + '</b>)</div>' +
                    '<div style="margin-top:4px">当前生图比例: <b style="color:#ffd28a">' + _esc(aspectStr) + '</b></div>' +
                '</div>' +
            '</div>' +
            '<div style="color:#ff9d4a;font-weight:600;margin-bottom:10px">⚠ 出的图会被 AI 拉伸变形</div>' +
            '<div style="color:#ccc">建议:</div>' +
            '<ul style="color:#ccc;padding-left:20px;margin:4px 0">' +
                '<li>把生图比例改成 <b style="color:#7ad8ff">' + _esc(nearest) + '</b>, 或 <b style="color:#7ad8ff">1:1</b> / <b style="color:#7ad8ff">Auto</b></li>' +
                '<li>或在 PS 里 <b style="color:#7ad8ff">按住 Shift 重新框选</b> = 正方形</li>' +
            '</ul>' +
            '<div style="color:#888;font-size:11px;margin-top:10px;line-height:1.5">' +
                '小贴士: Auto 跟着框选走, 大多数时候没问题; 但 4K 模式下 Auto 偶尔会降到 1080p, 想稳定出 4K 就用 1:1。' +
            '</div>' +
        '</div>';

    return window.UIKit.dialog({
        title: '⚠ 框选比例 ≠ 生图比例',
        html: html,
        buttons: ['取消, 我去改', actionVerb],
        accent: 0,
        danger: 1,
        escIndex: 0
    }).then(function(r) {
        return r && r.index === 1;
    });
}

// ============================================================
//  弹窗 2: 添加参考图时的"参考图比例不一致"预警
// ============================================================
function confirmBeforeAddRef(args) {
    if (!window.UIKit || !window.UIKit.dialog) return Promise.resolve(true);
    var newW = args.newW, newH = args.newH;
    var refs = args.refs || [];
    var newRatio = _fmtRatio(newW, newH);
    var refList = refs.map(function(r, i) {
        return '<li>参考图 ' + (i + 1) + ': ' + r.width + ' × ' + r.height + ' (' + _esc(_fmtRatio(r.width, r.height)) + ')</li>';
    }).join('');

    var html =
        '<div class="aspect-warn-body" style="font-size:13px;line-height:1.7">' +
            '<div style="display:flex;align-items:flex-start;gap:14px;padding:10px 12px;background:rgba(255,160,80,0.12);border-radius:6px;margin-bottom:12px">' +
                '<img src="icons/nonono.jpg" alt="" style="width:64px;height:64px;border-radius:6px;flex:0 0 64px;object-fit:cover">' +
                '<div style="flex:1">' +
                    '<div>这张新参考图: <b style="color:#ffd28a">' + newW + ' × ' + newH + '</b> (约 <b>' + _esc(newRatio) + '</b>)</div>' +
                    '<div style="margin-top:4px;color:#ccc">已有参考图:</div>' +
                    '<ul style="color:#ccc;padding-left:20px;margin:4px 0">' + refList + '</ul>' +
                '</div>' +
            '</div>' +
            '<div style="color:#ff9d4a;font-weight:600;margin-bottom:10px">⚠ 参考图比例不一致, AI 容易混淆</div>' +
            '<div style="color:#ccc;margin-bottom:4px">建议:</div>' +
            '<ul style="color:#ccc;padding-left:20px;margin:4px 0">' +
                '<li>让所有参考图都用 <b style="color:#7ad8ff">同一个比例</b> 框选</li>' +
                '<li>最稳的是 <b style="color:#7ad8ff">按住 Shift 拖</b> 都框正方形</li>' +
            '</ul>' +
        '</div>';

    return window.UIKit.dialog({
        title: '⚠ 参考图比例不一致',
        html: html,
        buttons: ['取消, 重新框', '仍要加入'],
        accent: 0,
        danger: 1,
        escIndex: 0
    }).then(function(r) {
        return r && r.index === 1;
    });
}

window.AspectWarn = {
    probeSelection: probeSelection,
    checkSelVsAspect: checkSelVsAspect,
    checkRefVsRefs: checkRefVsRefs,
    confirmBeforeGenerate: confirmBeforeGenerate,
    confirmBeforeAddRef: confirmBeforeAddRef,
    TOLERANCE: TOLERANCE
};

})();
