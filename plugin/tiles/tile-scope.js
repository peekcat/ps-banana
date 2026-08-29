// ============================================================
//  tile-scope.js — 示波器磁贴 (Waveform / RGB Parade / Vectorscope / Histogram)
//
//  设计:
//    - 默认 1x1, 正面显示图标 + 标签 (纯入口, 不在小磁贴里画波形)
//    - 就地展开: 2x2 网格 4 个波形, 每个画布缩小版
//    - 全屏展开: 同 2x2 网格但每个画布更大, 标签更显眼
//    - 触发: 仅 PS historyStateChanged + 300ms debounce
//      面板未展开时不抓取 (节能), 展开时拉一次初始抓取
//    - 抓取: 整张文档合成, 降采样到 512x256 (展开后) / 256x128 (就地)
//
//  纯监看, 无任何调色能力.
// ============================================================
(function() {
'use strict';

// ----- 抓取参数 -----
var DEBOUNCE_MS = 300;

// 分辨率档位 (最长边 px, host 按文档比例缩放)
var QUALITY_OPTS = [
    { v: 128,  label: '128' },
    { v: 256,  label: '256' },
    { v: 512,  label: '512' },
    { v: 1024, label: '1K' },
    { v: 2048, label: '2K' }
];
var DEFAULT_QUALITY = 512;

// 亮度范围档位 (Luma / RGB Parade 共用)
//   broadcast: 16-235 (BT.601/709 广播合规)
//   full:      0-255  (PC/sRGB 全幅)
//   extended:  0-110% IRE (含 super white)
var RANGE_OPTS = [
    { v: 'broadcast', label: '16-235', loBits: 16,  hiBits: 235 },
    { v: 'full',      label: '0-255',  loBits: 0,   hiBits: 255 },
    { v: 'extended',  label: '0-110',  loBits: 0,   hiBits: 281 } // 110% of 255 ≈ 281, 截到 255
];

// 矢量示波器倍率 (1× / 2× / 4× / 8×)
//   2× 是肤色线检查的常用倍率, 8× 用于细微色偏
var VEC_GAIN_OPTS = [1, 2, 4, 8];

// 直方图纵向缩放
//   log: 对数 (默认, 暗部细节)
//   lin: 线性 (实际像素比例)
var HIST_SCALE_OPTS = [
    { v: 'log', label: 'LOG' },
    { v: 'lin', label: 'LIN' }
];

// ----- 用户设置 (持久化) -----
function _loadPref(key, def, validValues) {
    try {
        var v = TileAPI.storage.get('scope.' + key);
        if (v == null) return def;
        if (validValues && validValues.indexOf(v) < 0 && validValues.indexOf(+v) < 0) return def;
        return v;
    } catch (e) { return def; }
}
function _savePref(key, v) {
    try { TileAPI.storage.set('scope.' + key, v); } catch (e) {}
}

var _quality   = +_loadPref('quality', DEFAULT_QUALITY, QUALITY_OPTS.map(function(o) { return o.v; }));
var _range     = _loadPref('range', 'full', RANGE_OPTS.map(function(o) { return o.v; }));
var _vecGain   = +_loadPref('vecGain', 1, VEC_GAIN_OPTS);
var _histScale = _loadPref('histScale', 'log', HIST_SCALE_OPTS.map(function(o) { return o.v; }));
var _showR = true, _showG = true, _showB = true;
var _showSkinLine = true;  // 矢量示波器的肤色线 (I-line, 约 123°)
var _showTargets = true;   // 矢量示波器的 6 个目标点

// ----- panel state -----
var _activeContainer = null;
var _activeMode = null;          // 'inline' | 'full'
var _lastFrame = null;           // { w, h, comp, u8 } 最近一次抓取的解码后数据 (供 resize 时重画)
var _grabInflight = false;       // 抓取中标志, 防并发
var _grabWatchdog = null;        // 抓取无回包看门狗(防永久卡死)
var _debounceTimer = null;

// ============================================================
//  base64 → Uint8Array
// ============================================================
function _b64ToU8(b64) {
    var bin = atob(b64);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
}

// ============================================================
//  抓取一次 (节流 + 防并发)
// ============================================================
function _requestGrab() {
    if (_grabInflight) return;
    if (!_activeContainer) return;
    _grabInflight = true;
    TileAPI.sendToHost('scopeGrabPixels', { targetW: _quality, targetH: _quality });
    // bug: 若 host 抓取无回包(消息丢失/host 忙), _grabInflight 会永久 true → 示波器从此不再刷新。
    //   加 8 秒看门狗: 到点仍在飞行就复位, 允许下一次抓取。回包正常时 result 会先复位, 看门狗无害。
    if (_grabWatchdog) clearTimeout(_grabWatchdog);
    _grabWatchdog = setTimeout(function() {
        _grabWatchdog = null;
        _grabInflight = false;
    }, 8000);
}

function _scheduleGrab() {
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(function() {
        _debounceTimer = null;
        _requestGrab();
    }, DEBOUNCE_MS);
}

// ============================================================
//  收到 host 抓取结果
// ============================================================
TileAPI.onHostMessage('scopeGrabPixels.result', function(data) {
    _grabInflight = false;
    if (_grabWatchdog) { clearTimeout(_grabWatchdog); _grabWatchdog = null; }
    if (!data || !data.ok) {
        _drawAllError(data && data.error);
        return;
    }
    var u8 = _b64ToU8(data.rgba);
    _lastFrame = { w: data.w, h: data.h, comp: data.comp, u8: u8, costMs: data.costMs };
    _drawAll();
});

TileAPI.onHostMessage('scope:psHistoryChanged', function(data) {
    if (!_activeContainer) return;  // 没展开就不抓
    _scheduleGrab();
});

// ============================================================
//  绘制: 把 4 个 canvas 填上
// ============================================================
function _drawAll() {
    if (!_activeContainer || !_lastFrame) return;
    var fr = _lastFrame;
    var lumaCv = _activeContainer.querySelector('canvas[data-scope="luma"]');
    var rgbCv  = _activeContainer.querySelector('canvas[data-scope="rgb"]');
    var vecCv  = _activeContainer.querySelector('canvas[data-scope="vec"]');
    var histCv = _activeContainer.querySelector('canvas[data-scope="hist"]');
    if (lumaCv) _drawLuma(lumaCv, fr);
    if (rgbCv)  _drawRGBParade(rgbCv, fr);
    if (vecCv)  _drawVectorscope(vecCv, fr);
    if (histCv) _drawHistogram(histCv, fr);

    // 状态条
    var st = _activeContainer.querySelector('.scope-status');
    if (st) {
        st.textContent = '✓ ' + fr.w + '×' + fr.h +
            (fr.costMs != null ? ' · ' + fr.costMs + 'ms' : '') +
            ' · ' + new Date().toLocaleTimeString();
    }
}

function _drawAllError(err) {
    if (!_activeContainer) return;
    var st = _activeContainer.querySelector('.scope-status');
    if (st) st.textContent = '× ' + (err || '无文档 / 抓取失败');
    // 清画布
    ['luma','rgb','vec','hist'].forEach(function(k) {
        var cv = _activeContainer.querySelector('canvas[data-scope="' + k + '"]');
        if (!cv) return;
        var ctx = cv.getContext('2d');
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.fillStyle = '#666';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('无数据', cv.width / 2, cv.height / 2);
    });
}

// ============================================================
//  Canvas 工具
// ============================================================
function _setupCanvas(cv) {
    var dpr = window.devicePixelRatio || 1;
    var rect = cv.getBoundingClientRect();
    var W = Math.max(1, Math.round(rect.width * dpr));
    var H = Math.max(1, Math.round(rect.height * dpr));
    if (cv.width !== W || cv.height !== H) {
        cv.width = W;
        cv.height = H;
    }
    return { ctx: cv.getContext('2d'), W: W, H: H, dpr: dpr };
}

function _clearGrid(ctx, w, h, dpr) {
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, w, h);
    // 横线 (0, 25, 50, 75, 100% IRE)
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = dpr;
    for (var i = 1; i < 4; i++) {
        var y = Math.round(h * i / 4) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
    }
}

// ============================================================
//  范围映射: 把 0-255 亮度值映射到 canvas Y 坐标
//  range='broadcast': 16 在底, 235 在顶
//  range='full':       0 在底, 255 在顶
//  range='extended':   0 在底, ~281 在顶 (超白区可见)
// ============================================================
function _rangeLoHi(range) {
    var opt = null;
    for (var i = 0; i < RANGE_OPTS.length; i++) {
        if (RANGE_OPTS[i].v === range) { opt = RANGE_OPTS[i]; break; }
    }
    if (!opt) opt = RANGE_OPTS[1]; // 默认 full
    return { lo: opt.loBits, hi: opt.hiBits };
}

function _valueToY(v, lo, hi, H) {
    // v 在 [lo, hi] 映射到 [H-1, 0] (上为高)
    var t = (v - lo) / (hi - lo);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return ((H - 1) * (1 - t)) | 0;
}

// 在 canvas 上画 IRE 刻度线 + 数字标签
function _drawIREGrid(ctx, W, H, dpr, range) {
    var lh = _rangeLoHi(range);
    var lo = lh.lo, hi = lh.hi;
    // 关键刻度: 0, 16(黑电平), 50, 100, 128, 200, 235(白电平), 255
    var marks;
    if (range === 'broadcast') {
        marks = [{v:16,l:'0',k:1},{v:75,l:'25'},{v:126,l:'50',k:1},{v:177,l:'75'},{v:235,l:'100',k:1}];
    } else if (range === 'extended') {
        marks = [{v:0,l:'0',k:1},{v:64,l:'25'},{v:128,l:'50',k:1},{v:192,l:'75'},{v:255,l:'100',k:1},{v:281,l:'110'}];
    } else {
        marks = [{v:0,l:'0',k:1},{v:64,l:'64'},{v:128,l:'128',k:1},{v:192,l:'192'},{v:255,l:'255',k:1}];
    }
    ctx.lineWidth = dpr;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = (9 * dpr) + 'px monospace';
    for (var i = 0; i < marks.length; i++) {
        var m = marks[i];
        var y = _valueToY(m.v, lo, hi, H);
        ctx.strokeStyle = m.k ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.07)';
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(W, y + 0.5);
        ctx.stroke();
        // 右侧标签
        ctx.fillStyle = m.k ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.3)';
        ctx.fillText(m.l, W - 3 * dpr, y);
    }
}

// ============================================================
//  ① Luma 波形 (亮度波形)
// ============================================================
function _drawLuma(cv, fr) {
    var s = _setupCanvas(cv);
    var ctx = s.ctx, W = s.W, H = s.H, dpr = s.dpr;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, W, H);
    _drawIREGrid(ctx, W, H, dpr, _range);

    var img = ctx.createImageData(W, H);
    var d = img.data;
    var u8 = fr.u8;
    var sw = fr.w, sh = fr.h, comp = fr.comp;
    var lh = _rangeLoHi(_range);
    var lo = lh.lo, hi = lh.hi;

    // 累加密度图: density[x*H + y] = count (直接按 canvas Y 累)
    var density = new Uint32Array(W * H);
    var maxC = 0;

    for (var sy = 0; sy < sh; sy++) {
        for (var sx = 0; sx < sw; sx++) {
            var idx = (sy * sw + sx) * comp;
            var r = u8[idx], g = u8[idx + 1], b = u8[idx + 2];
            var lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0;
            if (lum < 0) lum = 0; else if (lum > 255) lum = 255;
            // 映射到 canvas Y (考虑 range 缩放, 越界裁切)
            var t = (lum - lo) / (hi - lo);
            if (t < 0 || t > 1) continue;
            var cy = ((H - 1) * (1 - t)) | 0;
            var cx = (sx * W / sw) | 0;
            if (cx >= W) cx = W - 1;
            var di = cx * H + cy;
            density[di]++;
            if (density[di] > maxC) maxC = density[di];
        }
    }

    if (maxC > 0) {
        var logMax = Math.log(maxC + 1);
        for (var x = 0; x < W; x++) {
            for (var y = 0; y < H; y++) {
                var c = density[x * H + y];
                if (!c) continue;
                var a = Math.log(c + 1) / logMax;
                var pi = (y * W + x) * 4;
                var alpha = (a * 255) | 0;
                d[pi]     = Math.min(255, d[pi]     + alpha * 0.3);
                d[pi + 1] = Math.min(255, d[pi + 1] + alpha);
                d[pi + 2] = Math.min(255, d[pi + 2] + alpha * 0.3);
                d[pi + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = (11 * dpr) + 'px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('LUMA · ' + _range.toUpperCase(), 6 * dpr, 4 * dpr);
}

// ============================================================
//  ② RGB Parade — R/G/B 三通道并排
// ============================================================
function _drawRGBParade(cv, fr) {
    var s = _setupCanvas(cv);
    var ctx = s.ctx, W = s.W, H = s.H, dpr = s.dpr;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, W, H);
    _drawIREGrid(ctx, W, H, dpr, _range);

    var img = ctx.createImageData(W, H);
    var d = img.data;
    var u8 = fr.u8;
    var sw = fr.w, sh = fr.h, comp = fr.comp;

    // 根据启用的通道数动态分带
    var enabled = [];
    if (_showR) enabled.push(0);
    if (_showG) enabled.push(1);
    if (_showB) enabled.push(2);
    var nBands = enabled.length;
    if (nBands === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = (12 * dpr) + 'px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('全部通道已隐藏', W / 2, H / 2);
        return;
    }
    var bandW = (W / nBands) | 0;
    var lh = _rangeLoHi(_range);
    var lo = lh.lo, hi = lh.hi;

    var dens = [];
    var maxV = [];
    for (var k = 0; k < nBands; k++) {
        dens.push(new Uint32Array(bandW * H));
        maxV.push(0);
    }

    for (var sy = 0; sy < sh; sy++) {
        for (var sx = 0; sx < sw; sx++) {
            var idx = (sy * sw + sx) * comp;
            var bx = (sx * bandW / sw) | 0;
            if (bx >= bandW) bx = bandW - 1;
            for (var ei = 0; ei < nBands; ei++) {
                var ch = enabled[ei];
                var val = u8[idx + ch];
                var t = (val - lo) / (hi - lo);
                if (t < 0 || t > 1) continue;
                var cy = ((H - 1) * (1 - t)) | 0;
                var di = bx * H + cy;
                dens[ei][di]++;
                if (dens[ei][di] > maxV[ei]) maxV[ei] = dens[ei][di];
            }
        }
    }

    function _paint(densArr, maxC, offX, ch) {
        if (!maxC) return;
        var logMax = Math.log(maxC + 1);
        for (var x = 0; x < bandW; x++) {
            for (var y = 0; y < H; y++) {
                var c = densArr[x * H + y];
                if (!c) continue;
                var pi = (y * W + (offX + x)) * 4;
                var a = (Math.log(c + 1) / logMax * 255) | 0;
                if (ch === 0) { d[pi]     = Math.min(255, d[pi]     + a); d[pi+1] = Math.min(255, d[pi+1] + a*0.1); d[pi+2] = Math.min(255, d[pi+2] + a*0.1); }
                if (ch === 1) { d[pi]     = Math.min(255, d[pi]     + a*0.1); d[pi+1] = Math.min(255, d[pi+1] + a);     d[pi+2] = Math.min(255, d[pi+2] + a*0.1); }
                if (ch === 2) { d[pi]     = Math.min(255, d[pi]     + a*0.1); d[pi+1] = Math.min(255, d[pi+1] + a*0.1); d[pi+2] = Math.min(255, d[pi+2] + a); }
                d[pi + 3] = 255;
            }
        }
    }
    for (var ei2 = 0; ei2 < nBands; ei2++) {
        _paint(dens[ei2], maxV[ei2], bandW * ei2, enabled[ei2]);
    }
    ctx.putImageData(img, 0, 0);

    // 分隔线
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = dpr;
    ctx.beginPath();
    for (var bi = 1; bi < nBands; bi++) {
        ctx.moveTo(bandW * bi + 0.5, 0);
        ctx.lineTo(bandW * bi + 0.5, H);
    }
    ctx.stroke();

    // 通道标签
    var chLabels = ['R', 'G', 'B'];
    var chColors = ['rgba(255,80,80,0.95)', 'rgba(80,255,80,0.95)', 'rgba(80,140,255,0.95)'];
    ctx.font = (11 * dpr) + 'px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (var ei3 = 0; ei3 < nBands; ei3++) {
        ctx.fillStyle = chColors[enabled[ei3]];
        ctx.fillText(chLabels[enabled[ei3]], bandW * ei3 + 6 * dpr, 4 * dpr);
    }
}

// ============================================================
//  ③ Vectorscope — 矢量示波器 (UV / CbCr 极坐标)
//  支持 1×/2×/4×/8× 缩放, 肤色线 (I-line, ~123° = 紫红→偏黄绿)
// ============================================================
function _drawVectorscope(cv, fr) {
    var s = _setupCanvas(cv);
    var ctx = s.ctx, W = s.W, H = s.H, dpr = s.dpr;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, W, H);

    var cx = W / 2, cy = H / 2;
    var radius = Math.min(W, H) / 2 - 8 * dpr;
    // 倍率: 100% 饱和点在 radius/gain 处, 即 gain=2 时 50% 饱和已经画到边缘
    var gain = _vecGain || 1;
    var radPx = radius;

    // 背景圆环刻度 (按倍率显示, 25% 50% 75% 100%)
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = dpr;
    for (var rr = 1; rr <= 4; rr++) {
        ctx.beginPath();
        ctx.arc(cx, cy, radius * rr / 4, 0, Math.PI * 2);
        ctx.stroke();
    }
    // 十字线
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    // 肤色线 (I-line): 经典上下两段, 角度约 123° (从 +Cb 轴逆时针)
    // 实际肤色聚集在 R-Yl 之间偏向中心的方向
    if (_showSkinLine) {
        ctx.strokeStyle = 'rgba(255,180,140,0.45)';
        ctx.lineWidth = dpr * 1.2;
        ctx.setLineDash([dpr * 4, dpr * 3]);
        var angle = -123 * Math.PI / 180;  // 屏幕坐标 Y 向下, 取负
        var dx = Math.cos(angle), dy = Math.sin(angle);
        ctx.beginPath();
        ctx.moveTo(cx - dx * radius, cy - dy * radius);
        ctx.lineTo(cx + dx * radius, cy + dy * radius);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // 标记位置 — BT.709 100% 饱和原色
    var targets = [
        ['R',  -0.228, -0.996, '#ff5050'],
        ['Yl', -0.996, -0.091, '#ffff60'],
        ['G',  -0.768,  0.905, '#60ff60'],
        ['Cy',  0.228,  0.996, '#60ffff'],
        ['B',   0.996,  0.091, '#6080ff'],
        ['Mg',  0.768, -0.905, '#ff60ff']
    ];
    if (_showTargets) {
        var markSz = 5 * dpr;
        ctx.font = (10 * dpr) + 'px monospace';
        ctx.textBaseline = 'middle';
        // 倍率会让目标点超出画布; 若超出就靠边并淡化
        for (var ti = 0; ti < targets.length; ti++) {
            var t = targets[ti];
            var mxRel = t[1] * gain;
            var myRel = t[2] * gain;
            var inside = (Math.abs(mxRel) <= 1 && Math.abs(myRel) <= 1);
            if (!inside) continue;
            var mx = cx + mxRel * radius;
            var my = cy + myRel * radius;
            ctx.fillStyle = t[3];
            ctx.fillRect(mx - markSz / 2, my - markSz / 2, markSz, markSz);
            var labelOffX = (t[1] >= 0 ? 1 : -1) * 8 * dpr;
            var labelOffY = (t[2] >= 0 ? 1 : -1) * 8 * dpr;
            ctx.textAlign = (t[1] >= 0 ? 'left' : 'right');
            ctx.fillText(t[0], mx + labelOffX, my + labelOffY);
        }
    }

    // 像素点
    var u8 = fr.u8;
    var sw = fr.w, sh = fr.h, comp = fr.comp;
    var img = ctx.getImageData(0, 0, W, H);
    var d = img.data;

    var dens = new Uint32Array(W * H);
    var maxC = 0;

    for (var sy = 0; sy < sh; sy++) {
        for (var sx = 0; sx < sw; sx++) {
            var idx = (sy * sw + sx) * comp;
            var r = u8[idx], g = u8[idx + 1], b = u8[idx + 2];
            var Cb = -0.1146 * r - 0.3854 * g + 0.5000 * b;
            var Cr =  0.5000 * r - 0.4542 * g - 0.0458 * b;
            // 倍率: 半径放大 gain 倍 (相当于 1/gain 满量程)
            var px = (cx + (Cb / 128) * radPx * gain) | 0;
            var py = (cy - (Cr / 128) * radPx * gain) | 0;
            if (px < 0 || px >= W || py < 0 || py >= H) continue;
            var di = py * W + px;
            dens[di]++;
            if (dens[di] > maxC) maxC = dens[di];
        }
    }

    if (maxC > 0) {
        var logMax = Math.log(maxC + 1);
        for (var i = 0; i < dens.length; i++) {
            var c = dens[i];
            if (!c) continue;
            var a = Math.log(c + 1) / logMax;
            var pi = i * 4;
            var aa = (a * 200) | 0;
            d[pi]     = Math.min(255, d[pi]     + aa * 0.5);
            d[pi + 1] = Math.min(255, d[pi + 1] + aa);
            d[pi + 2] = Math.min(255, d[pi + 2] + aa * 0.4);
            d[pi + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = (11 * dpr) + 'px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('VECTOR · ' + gain + '×', 6 * dpr, 4 * dpr);
}

// ============================================================
//  ④ Histogram — RGB 直方图 (三通道叠加, 支持 LIN/LOG 切换)
// ============================================================
function _drawHistogram(cv, fr) {
    var s = _setupCanvas(cv);
    var ctx = s.ctx, W = s.W, H = s.H, dpr = s.dpr;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, W, H);

    // 横向 IRE 网格
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = dpr;
    for (var i = 1; i < 4; i++) {
        var gx = Math.round(W * i / 4) + 0.5;
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, H);
        ctx.stroke();
    }

    var u8 = fr.u8;
    var sw = fr.w, sh = fr.h, comp = fr.comp;
    var histR = new Uint32Array(256);
    var histG = new Uint32Array(256);
    var histB = new Uint32Array(256);
    var maxV = 0;

    for (var k0 = 0, n = sw * sh; k0 < n; k0++) {
        var idx = k0 * comp;
        histR[u8[idx]]++;
        histG[u8[idx + 1]]++;
        histB[u8[idx + 2]]++;
    }
    for (var k = 0; k < 256; k++) {
        if (_showR && histR[k] > maxV) maxV = histR[k];
        if (_showG && histG[k] > maxV) maxV = histG[k];
        if (_showB && histB[k] > maxV) maxV = histB[k];
    }
    if (!maxV) {
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = (12 * dpr) + 'px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('全部通道已隐藏', W / 2, H / 2);
        return;
    }

    var useLog = (_histScale === 'log');
    var logMax = Math.log(maxV + 1);

    function _bar(hist, color) {
        ctx.fillStyle = color;
        for (var x = 0; x < 256; x++) {
            var v = hist[x];
            var h = useLog
                ? Math.log(v + 1) / logMax * (H - 4 * dpr)
                : v / maxV * (H - 4 * dpr);
            var px = (x * W / 256);
            var pw = (W / 256);
            ctx.fillRect(px, H - h, Math.max(1, pw), h);
        }
    }
    ctx.globalCompositeOperation = 'lighter';
    if (_showR) _bar(histR, 'rgba(255,60,60,0.55)');
    if (_showG) _bar(histG, 'rgba(60,255,60,0.55)');
    if (_showB) _bar(histB, 'rgba(60,140,255,0.65)');
    ctx.globalCompositeOperation = 'source-over';

    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = (11 * dpr) + 'px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('HIST · ' + _histScale.toUpperCase(), 6 * dpr, 4 * dpr);
}

// ============================================================
//  渲染面板内容 (展开时调用)
// ============================================================
function _btnGroup(opts) {
    // opts: { name, items:[{v,label,title}], current, dataAct }
    var html = '<div class="scope-btng" data-act="' + opts.dataAct + '">';
    for (var i = 0; i < opts.items.length; i++) {
        var it = opts.items[i];
        var active = (String(it.v) === String(opts.current)) ? ' is-on' : '';
        html += '<button class="scope-btng-btn' + active + '"' +
            ' data-val="' + it.v + '"' +
            (it.title ? ' title="' + it.title + '"' : '') +
            '>' + it.label + '</button>';
    }
    html += '</div>';
    return html;
}

function _toggleBtn(label, active, dataAct, title) {
    return '<button class="scope-tbtn' + (active ? ' is-on' : '') + '"' +
        ' data-act="' + dataAct + '"' +
        (title ? ' title="' + title + '"' : '') +
        '>' + label + '</button>';
}

function _renderPanel(container, isFull) {
    var rangeItems = RANGE_OPTS.map(function(o) {
        return { v: o.v, label: o.label, title: o.label + ' 范围' };
    });
    var qualityItems = QUALITY_OPTS.map(function(o) {
        return { v: o.v, label: o.label, title: '抓取最长边 ' + o.v + 'px' };
    });
    var gainItems = VEC_GAIN_OPTS.map(function(g) {
        return { v: g, label: g + '×', title: g + ' 倍放大' };
    });
    var histItems = HIST_SCALE_OPTS.map(function(o) {
        return { v: o.v, label: o.label, title: o.v === 'log' ? '对数刻度 (暗部细节)' : '线性刻度' };
    });

    container.innerHTML =
        '<div class="scope-panel">' +
            '<div class="scope-grid">' +
                // ─── Luma ───
                '<div class="scope-cell" data-cell="luma">' +
                    '<canvas data-scope="luma"></canvas>' +
                    '<div class="scope-celltool">' +
                        '<span class="scope-toollabel">范围</span>' +
                        _btnGroup({ dataAct: 'range', items: rangeItems, current: _range }) +
                    '</div>' +
                '</div>' +
                // ─── RGB Parade ───
                '<div class="scope-cell" data-cell="rgb">' +
                    '<canvas data-scope="rgb"></canvas>' +
                    '<div class="scope-celltool">' +
                        _toggleBtn('R', _showR, 'toggleR', '显示/隐藏 R 通道') +
                        _toggleBtn('G', _showG, 'toggleG', '显示/隐藏 G 通道') +
                        _toggleBtn('B', _showB, 'toggleB', '显示/隐藏 B 通道') +
                    '</div>' +
                '</div>' +
                // ─── Vectorscope ───
                '<div class="scope-cell" data-cell="vec">' +
                    '<canvas data-scope="vec"></canvas>' +
                    '<div class="scope-celltool">' +
                        '<span class="scope-toollabel">放大</span>' +
                        _btnGroup({ dataAct: 'vecGain', items: gainItems, current: _vecGain }) +
                        _toggleBtn('肤', _showSkinLine, 'toggleSkin', '显示肤色参考线 (I-line)') +
                        _toggleBtn('标', _showTargets, 'toggleTargets', '显示 RYGCBM 目标点') +
                    '</div>' +
                '</div>' +
                // ─── Histogram ───
                '<div class="scope-cell" data-cell="hist">' +
                    '<canvas data-scope="hist"></canvas>' +
                    '<div class="scope-celltool">' +
                        '<span class="scope-toollabel">纵向</span>' +
                        _btnGroup({ dataAct: 'histScale', items: histItems, current: _histScale }) +
                    '</div>' +
                '</div>' +
            '</div>' +
            // ─── 底部状态栏 ───
            '<div class="scope-bar">' +
                '<button class="w10-btn" data-act="grab" title="手动重新抓取">📸 抓取</button>' +
                '<span class="scope-toollabel">采样</span>' +
                _btnGroup({ dataAct: 'quality', items: qualityItems, current: _quality }) +
                '<span class="scope-status">就绪</span>' +
            '</div>' +
        '</div>';

    // ─── 事件绑定 ───
    // 所有按钮: stopPropagation 避免触发 tile 折叠/拖拽
    container.querySelectorAll('button').forEach(function(btn) {
        btn.addEventListener('mousedown', function(e) { e.stopPropagation(); });
    });

    // 抓取按钮
    var grabBtn = container.querySelector('[data-act="grab"]');
    if (grabBtn) grabBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        _forceGrab();
    });

    // 按钮组通用 (单选)
    container.querySelectorAll('.scope-btng').forEach(function(group) {
        var act = group.getAttribute('data-act');
        group.querySelectorAll('.scope-btng-btn').forEach(function(b) {
            b.addEventListener('click', function(e) {
                e.stopPropagation();
                var v = b.getAttribute('data-val');
                _setOption(act, v);
                // 更新选中态
                group.querySelectorAll('.scope-btng-btn').forEach(function(x) {
                    x.classList.toggle('is-on', x === b);
                });
            });
        });
    });

    // 开关按钮 (toggle)
    container.querySelectorAll('.scope-tbtn').forEach(function(b) {
        b.addEventListener('click', function(e) {
            e.stopPropagation();
            var act = b.getAttribute('data-act');
            var newState = _toggleOption(act);
            b.classList.toggle('is-on', newState);
        });
    });

    _activeContainer = container;
    _activeMode = isFull ? 'full' : 'inline';

    // 让 host 注册 historyStateChanged 监听 (幂等)
    TileAPI.sendToHost('scopeInit', {});

    // 强制 1:1 + 纵向布局, 并监听后续尺寸变化
    _applyScopeLayout(container);
    _observeResize(container);

    // 首次拉取
    if (_lastFrame) _drawAll();
    _scheduleGrab();
}

// 按钮组的单选操作
function _setOption(act, v) {
    if (act === 'range') {
        _range = v; _savePref('range', v);
        _redrawOrRegrab(false);
    } else if (act === 'vecGain') {
        _vecGain = +v; _savePref('vecGain', +v);
        _redrawOrRegrab(false);
    } else if (act === 'histScale') {
        _histScale = v; _savePref('histScale', v);
        _redrawOrRegrab(false);
    } else if (act === 'quality') {
        _quality = +v; _savePref('quality', +v);
        _redrawOrRegrab(true);
    }
}

// 开关按钮
function _toggleOption(act) {
    if (act === 'toggleR') { _showR = !_showR; _redrawOrRegrab(false); return _showR; }
    if (act === 'toggleG') { _showG = !_showG; _redrawOrRegrab(false); return _showG; }
    if (act === 'toggleB') { _showB = !_showB; _redrawOrRegrab(false); return _showB; }
    if (act === 'toggleSkin') { _showSkinLine = !_showSkinLine; _redrawOrRegrab(false); return _showSkinLine; }
    if (act === 'toggleTargets') { _showTargets = !_showTargets; _redrawOrRegrab(false); return _showTargets; }
    return false;
}

// 视觉选项变化 → 仅重画; 抓取参数变化 → 重抓
function _redrawOrRegrab(needRegrab) {
    if (needRegrab) {
        if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
        _grabInflight = false;
        _requestGrab();
    } else if (_lastFrame) {
        _drawAll();
    }
}

// 强制立即抓 (绕过 debounce)
function _forceGrab() {
    if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
    _grabInflight = false;
    _requestGrab();
}

// ============================================================
//  强制 1:1 + 纵向排列布局
//  四个示波器纵向堆叠, 每个强制正方形。
//  边长 = min(整宽, (整高 - 间距) / 4):
//    - 一般(高瘦面板): 受高度限制, 4 个正好铺满, 不滚动
//    - 极窄面板: 受宽度限制, 总高超出 → CSS overflow-y 兜底滚动
// ============================================================
var _scopeRO = null;

function _applyScopeLayout(container) {
    if (!container) return;
    var grid = container.querySelector('.scope-grid');
    if (!grid) return;
    var cells = grid.querySelectorAll('.scope-cell');
    if (!cells.length) return;
    var gw = grid.clientWidth;
    var gh = grid.clientHeight;
    if (gw <= 0 || gh <= 0) return;
    // gap 跟 CSS 对齐: 全屏/展开态 12px, 否则 6px
    var gap = 6;
    var tileEl = container.closest ? container.closest('.tile') : null;
    if (tileEl && (tileEl.classList.contains('expanded') || tileEl.classList.contains('expanding'))) gap = 12;
    var n = cells.length;
    var side = Math.min(gw, (gh - gap * (n - 1)) / n);
    side = Math.max(40, Math.floor(side));
    for (var i = 0; i < cells.length; i++) {
        cells[i].style.width = side + 'px';
        cells[i].style.height = side + 'px';
    }
}

// 监听容器尺寸变化(拖大磁贴 / 面板缩放 / UI 缩放), 重算方形并重画。
// 观察 container 而非 grid: 设置格子尺寸不会改变 container, 不会自激循环。
function _observeResize(container) {
    if (_scopeRO) { try { _scopeRO.disconnect(); } catch (_) {} _scopeRO = null; }
    if (!container || typeof ResizeObserver === 'undefined') return;
    var raf = null;
    _scopeRO = new ResizeObserver(function() {
        if (raf) return;
        raf = requestAnimationFrame(function() {
            raf = null;
            _applyScopeLayout(container);
            if (_lastFrame) _drawAll();   // canvas 尺寸变了, 按新尺寸重画
        });
    });
    try { _scopeRO.observe(container); } catch (_) {}
}

function _onClose() {
    _activeContainer = null;
    _activeMode = null;
    if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
    if (_scopeRO) { try { _scopeRO.disconnect(); } catch (_) {} _scopeRO = null; }
}

// ============================================================
//  注册磁贴
// ============================================================
TileAPI.registerTile({
    id: 'scope',
    icon: '📊',
    label: '示波器',
    desc: 'Waveform / RGB / Vec / Hist',
    group: 'main',
    defaultSize: { w: 1, h: 1 },
    minSize: { w: 1, h: 1 },
    maxSize: { w: 4, h: 4 },

    renderFront: function(container, w, h) {
        container.innerHTML =
            '<div class="tile-icon">📊</div>' +
            '<div class="tile-label">示波器</div>' +
            (w >= 2 ? '<div class="tile-desc">Wave/RGB/Vec/Hist</div>' : '');
    },

    onExpand: function(container, sizeHint) {
        // sizeHint 由引擎传入, 'full' 表示全屏展开, 否则就地展开
        // 注: 引擎给的字段是 expandMode(老代码误写成 mode, 一直失效); 两个都兼容
        var isFull = !!(sizeHint && (sizeHint.expandMode === 'full' || sizeHint.mode === 'full'));
        _renderPanel(container, isFull);
        return _onClose;
    }
});

})();
