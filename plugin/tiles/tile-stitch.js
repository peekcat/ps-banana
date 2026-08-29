// ============================================================
//  tile-stitch.js — 多区拼接磁贴 (2026-07-06, v2: 1:1智能排布+跨文档+预览)
//
//  把 PS 里的多个选区(最多6个, 可跨文档)拼成一张 1:1 大图,
//  一次 API 调用处理全部区域, 回图按布局账切块、按文档分组贴回。
//  省钱逻辑: N 个小区域拼一张 = 1 次调用费; 1:1 是 nano banana 最稳比例。
//
//  排布算法(列式贪心, 目标正方形):
//    面积降序(手动排序=放置优先级) → 逐列堆叠, 每步选"最接近正方形"的落点
//    → 外接矩形短边补白到 1:1(内容居中) → 布局账记 1:1 画布绝对坐标
//
//  约束: 提示词用提示词磁贴当前内容(全区共用) / 宽高比强制Auto /
//        自动扩充+裁切不参与 / 抗截断可共存(拼好后统一色相处理)
// ============================================================
(function() {
'use strict';

var MAX_REGIONS = 6;
var GAP = 16;               // 区域间白色分隔带(px, 拼接原始坐标系)
var _regions = [];          // [{base64, selection, docId, docName, w, h}]
var _activeContainer = null;
var _busy = false;
var _batch = 1;             // 张数(同一拼接图抽几张, 每张各自切块贴回)
// 手动布局: null=自动排布; 非null=[{x,y,scale}](与 _regions 平行, 坐标为布局原始坐标系)
var _manualLayout = null;
var _drag = null;           // 预览编辑中的拖拽状态
var _thumbCache = {};       // base64前50字符hash -> HTMLImage(预览用, 避免每帧解码)

function _thumbKey(b64) { return b64.length + ':' + b64.slice(0, 40); }
function _ensureThumb(region) {
  var key = _thumbKey(region.base64);
  if (_thumbCache[key]) return _thumbCache[key].complete ? _thumbCache[key] : null;
  var img = new Image();
  img.onload = function() { if (_activeContainer) _renderPreview(_activeContainer); };
  img.src = 'data:image/png;base64,' + region.base64;
  _thumbCache[key] = img;
  return img.complete ? img : null;
}

// ── 精确色相偏移180° (与 host/ps-pixels.js 同款, 必须与 PS 贴回反向还原互逆) ──
function hueShift180(data, pixelCount) {   // RGBA
  for (var i = 0; i < pixelCount; i++) {
    var off = i * 4;
    var r = data[off], g = data[off + 1], b = data[off + 2];
    var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    var s = mx + mn;
    data[off] = s - r; data[off + 1] = s - g; data[off + 2] = s - b;
  }
}

function _loadImg(base64) {
  return new Promise(function(resolve, reject) {
    var img = new Image();
    img.onload = function() { resolve(img); };
    img.onerror = function() { reject(new Error('图像解码失败')); };
    img.src = 'data:image/png;base64,' + base64;
  });
}

// ============================================================
//  1:1 排布算法(纯函数, 预览和真拼共用)
//  输入: sizes [{w,h}](按用户列表顺序=优先级) → 输出 { side, rects:[{x,y,w,h,idx}] }
//  列式贪心: 逐个放, 每张试"接到现有每列底部"或"开新列", 选整体外接矩形
//  最接近正方形的方案; 最后短边补白成 side×side。
// ============================================================
function computeLayout(sizes) {
  if (!sizes.length) return { side: 0, rects: [] };
  // 单区: 直接补白成方形
  var cols = [];   // 每列 {x, w, bottom} ; rects 累积
  var rects = [];
  function currentExtent() {
    var maxR = 0, maxB = 0;
    for (var i = 0; i < rects.length; i++) {
      maxR = Math.max(maxR, rects[i].x + rects[i].w);
      maxB = Math.max(maxB, rects[i].y + rects[i].h);
    }
    return { w: maxR, h: maxB };
  }
  for (var i = 0; i < sizes.length; i++) {
    var s = sizes[i];
    var best = null;
    // 候选1: 接到每个现有列的底部
    for (var c = 0; c < cols.length; c++) {
      var col = cols[c];
      var trialW = Math.max(currentExtent().w, col.x + s.w);
      var trialH = Math.max(currentExtent().h, col.bottom + GAP + s.h);
      var sq = Math.max(trialW, trialH) / Math.max(1, Math.min(trialW, trialH));   // 越接近1越方
      var cand = { kind: 'col', c: c, x: col.x, y: col.bottom + GAP, score: sq, areaSide: Math.max(trialW, trialH) };
      if (!best || cand.score < best.score || (cand.score === best.score && cand.areaSide < best.areaSide)) best = cand;
    }
    // 候选2: 开新列(贴在当前最右)
    var ext = currentExtent();
    var nx = ext.w > 0 ? ext.w + GAP : 0;
    var trialW2 = nx + s.w;
    var trialH2 = Math.max(ext.h, s.h);
    var sq2 = Math.max(trialW2, trialH2) / Math.max(1, Math.min(trialW2, trialH2));
    var cand2 = { kind: 'new', x: nx, y: 0, score: sq2, areaSide: Math.max(trialW2, trialH2) };
    if (!best || cand2.score < best.score || (cand2.score === best.score && cand2.areaSide < best.areaSide)) best = cand2;

    rects.push({ x: best.x, y: best.y, w: s.w, h: s.h, idx: i });
    if (best.kind === 'new') {
      cols.push({ x: best.x, w: s.w, bottom: best.y + s.h });
    } else {
      var col2 = cols[best.c];
      col2.bottom = best.y + s.h;
      col2.w = Math.max(col2.w, s.w);
    }
  }
  // 外接矩形 → 补白成正方形, 内容整体居中
  var fin = currentExtent();
  var side = Math.max(fin.w, fin.h);
  var padX = Math.floor((side - fin.w) / 2);
  var padY = Math.floor((side - fin.h) / 2);
  rects.forEach(function(r) { r.x += padX; r.y += padY; });
  return { side: side, rects: rects };
}

// ── 布局账统一出口: 自动=computeLayout; 手动=按 _manualLayout 的 x/y/scale 算 rect, 画布=能装下所有块的正方形 ──
function resolveLayout(sizes) {
  if (!_manualLayout || _manualLayout.length !== sizes.length) return computeLayout(sizes);
  var rects = [];
  var maxR = 0, maxB = 0;
  for (var i = 0; i < sizes.length; i++) {
    var m = _manualLayout[i];
    var w = Math.max(1, Math.round(sizes[i].w * (m.scale || 1)));
    var h = Math.max(1, Math.round(sizes[i].h * (m.scale || 1)));
    rects.push({ x: Math.max(0, Math.round(m.x)), y: Math.max(0, Math.round(m.y)), w: w, h: h, idx: i });
    maxR = Math.max(maxR, rects[i].x + w);
    maxB = Math.max(maxB, rects[i].y + h);
  }
  var side = Math.max(maxR, maxB);
  return { side: side, rects: rects };
}

// 从自动排布初始化手动布局(进入手动模式的起点)
function _initManualFromAuto() {
  var sizes = _regions.map(function(r) { return { w: r.w || 100, h: r.h || 100 }; });
  var lay = computeLayout(sizes);
  _manualLayout = lay.rects.slice().sort(function(a, b) { return a.idx - b.idx; })
    .map(function(r) { return { x: r.x, y: r.y, scale: 1 }; });
}

// ── 真拼: 解码全部区域 → resolveLayout → 画到 1:1 canvas(超限整体缩) ──
function _buildStitched(antiMode) {
  return Promise.all(_regions.map(function(r) { return _loadImg(r.base64); })).then(function(imgs) {
    // 布局用选区尺寸算(预览编辑的坐标系), 绘制时各块内部再map到解码图
    var sizes = _regions.map(function(r) { return { w: r.w || 100, h: r.h || 100 }; });
    var lay = resolveLayout(sizes);
    var maxEdge = parseInt(TileAPI.storage.get('output.maxResolution'), 10) || 2048;
    var scale = Math.min(1, maxEdge / lay.side);
    var S = Math.max(1, Math.round(lay.side * scale));

    var cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    var cx = cv.getContext('2d');
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, S, S);
    cx.imageSmoothingQuality = 'high';

    var layout = [];   // 1:1 画布坐标系(缩放后)
    lay.rects.forEach(function(r) {
      var x = Math.round(r.x * scale), y = Math.round(r.y * scale);
      var w = Math.max(1, Math.round(r.w * scale)), h = Math.max(1, Math.round(r.h * scale));
      cx.drawImage(imgs[r.idx], x, y, w, h);
      layout.push({
        x: x, y: y, w: w, h: h,
        selection: _regions[r.idx].selection,
        docId: _regions[r.idx].docId,
        docName: _regions[r.idx].docName || '',
        docPath: _regions[r.idx].docPath || ''
      });
    });

    if (antiMode > 0) {
      var id = cx.getImageData(0, 0, S, S);
      hueShift180(id.data, S * S);
      cx.putImageData(id, 0, 0);
      if (antiMode === 2) {
        var cv2 = document.createElement('canvas');
        cv2.width = S; cv2.height = S;
        var cx2 = cv2.getContext('2d');
        cx2.translate(0, S); cx2.scale(1, -1);
        cx2.drawImage(cv, 0, 0);
        cv = cv2;
        layout.forEach(function(L) { L.y = S - L.y - L.h; });
      }
    }
    var out = cv.toDataURL('image/png');
    return { base64: out.slice(out.indexOf(',') + 1), w: S, h: S, layout: layout, scaledPct: Math.round(scale * 100) };
  });
}

// ── 切块(带docId透传) ──
function _sliceResult(resultBase64, stitchW, stitchH, layout) {
  return _loadImg(resultBase64).then(function(img) {
    var sx = img.naturalWidth / stitchW;
    var sy = img.naturalHeight / stitchH;
    return layout.map(function(L) {
      var cv = document.createElement('canvas');
      var w = Math.max(1, Math.round(L.w * sx));
      var h = Math.max(1, Math.round(L.h * sy));
      cv.width = w; cv.height = h;
      var cx = cv.getContext('2d');
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(img, L.x * sx, L.y * sy, L.w * sx, L.h * sy, 0, 0, w, h);
      var out = cv.toDataURL('image/png');
      return {
        base64: out.slice(out.indexOf(',') + 1),
        selection: L.selection,
        docId: L.docId,
        docName: L.docName || '',
        docPath: L.docPath || ''
      };
    });
  });
}

// ── 排布预览编辑器: 拖块移动 / 拖右下角等比缩放 / ↺自动排布 ──
var PREVIEW_COLORS = ['#4a9eff', '#7ee081', '#ffb44d', '#e58cff', '#5fd4d0', '#ff8a8a'];
var PV = 220;               // 预览画布边长(px)
var _pvSelected = -1;       // 选中的区域下标

function _pvLayout() {
  var sizes = _regions.map(function(r) { return { w: r.w || 100, h: r.h || 100 }; });
  return resolveLayout(sizes);
}

function _renderPreview(container) {
  var box = container.querySelector('#stitchPreview');
  if (!box) return;
  if (_regions.length < 1) { box.innerHTML = ''; box.style.display = 'none'; return; }
  var lay = _pvLayout();
  var k = lay.side > 0 ? PV / lay.side : 1;
  var cv = box.querySelector('canvas');
  if (!cv) {
    box.innerHTML = '';
    cv = document.createElement('canvas');
    cv.width = PV; cv.height = PV;
    cv.className = 'stitch-preview-cv';
    box.appendChild(cv);
    var lbl = document.createElement('div');
    lbl.className = 'stitch-preview-lbl';
    lbl.id = 'stitchPvLbl';
    box.appendChild(lbl);
    var tip = document.createElement('div');
    tip.className = 'stitch-preview-tip';
    tip.textContent = '拖块移动 · 拖右下角缩放 (比例锁定不变形)';
    box.appendChild(tip);
    _bindPreviewEvents(cv);
  }
  var cx = cv.getContext('2d');
  cx.clearRect(0, 0, PV, PV);
  cx.fillStyle = 'rgba(255,255,255,0.92)';
  cx.fillRect(0, 0, PV, PV);
  // 重叠检测(黄字提醒)
  var overlap = false;
  for (var a = 0; a < lay.rects.length; a++) {
    for (var b = a + 1; b < lay.rects.length; b++) {
      var A = lay.rects[a], B = lay.rects[b];
      if (A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h) overlap = true;
    }
  }
  cx.imageSmoothingQuality = 'high';
  lay.rects.forEach(function(r) {
    var x = r.x * k, y = r.y * k, w = Math.max(3, r.w * k), h = Math.max(3, r.h * k);
    var sel = (r.idx === _pvSelected);
    var img = _ensureThumb(_regions[r.idx]);
    if (img) {
      cx.drawImage(img, x, y, w, h);   // 真图(块比例=选区比例, 无变形)
      if (!sel) { cx.fillStyle = 'rgba(0,0,0,0.12)'; cx.fillRect(x, y, w, h); }  // 未选中稍压暗, 突出选中块
    } else {
      // 图还没解码好: 先用色块占位, onload 会自动重绘
      cx.fillStyle = PREVIEW_COLORS[r.idx % PREVIEW_COLORS.length];
      cx.globalAlpha = 0.7; cx.fillRect(x, y, w, h); cx.globalAlpha = 1;
    }
    cx.strokeStyle = sel ? '#ffffff' : PREVIEW_COLORS[r.idx % PREVIEW_COLORS.length];
    cx.lineWidth = sel ? 2 : 1;
    cx.strokeRect(x, y, w, h);
    // 编号角标(左上角小圆, 跟列表徽章同色)
    var br = Math.max(7, Math.min(11, w / 6));
    cx.fillStyle = PREVIEW_COLORS[r.idx % PREVIEW_COLORS.length];
    cx.beginPath(); cx.arc(x + br + 2, y + br + 2, br, 0, Math.PI * 2); cx.fill();
    cx.fillStyle = '#1a1a2e';
    cx.font = 'bold ' + Math.max(9, br + 1) + 'px sans-serif';
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.fillText(String(r.idx + 1), x + br + 2, y + br + 3);
    // 右下角缩放手柄
    cx.fillStyle = sel ? '#ffffff' : 'rgba(255,255,255,0.75)';
    cx.strokeStyle = 'rgba(0,0,0,0.5)';
    cx.fillRect(x + w - 8, y + h - 8, 8, 8);
    cx.strokeRect(x + w - 8, y + h - 8, 8, 8);
  });
  var lbl2 = box.querySelector('#stitchPvLbl');
  if (lbl2) {
    var maxEdge = parseInt(TileAPI.storage.get('output.maxResolution'), 10) || 2048;
    var scale = Math.min(1, maxEdge / lay.side);
    lbl2.textContent = (_manualLayout ? '手动布局' : '自动排布') + ' · 成图 1:1 '
      + Math.round(lay.side * scale) + '×' + Math.round(lay.side * scale)
      + (scale < 1 ? ' (压缩' + Math.round(scale * 100) + '%)' : '')
      + (overlap ? ' · ⚠有重叠' : '');
    lbl2.style.color = overlap ? '#ffb44d' : '';
  }
  box.style.display = '';
}

// 命中测试: 返回 {idx, corner} corner=是否点在右下角手柄
function _pvHit(px, py) {
  var lay = _pvLayout();
  var k = lay.side > 0 ? PV / lay.side : 1;
  // 从上往下(后画的先命中) — rects按放置序, 倒序遍历
  for (var i = lay.rects.length - 1; i >= 0; i--) {
    var r = lay.rects[i];
    var x = r.x * k, y = r.y * k, w = Math.max(3, r.w * k), h = Math.max(3, r.h * k);
    if (px >= x + w - 12 && px <= x + w + 4 && py >= y + h - 12 && py <= y + h + 4) return { idx: r.idx, corner: true, rect: r, k: k };
    if (px >= x && px <= x + w && py >= y && py <= y + h) return { idx: r.idx, corner: false, rect: r, k: k };
  }
  return null;
}

function _bindPreviewEvents(cv) {
  function toLocal(e) {
    var b = cv.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }
  cv.addEventListener('pointerdown', function(e) {
    var p = toLocal(e);
    var hit = _pvHit(p.x, p.y);
    if (!hit) { _pvSelected = -1; if (_activeContainer) _renderPreview(_activeContainer); return; }
    // 第一次编辑 → 从自动排布切到手动模式
    if (!_manualLayout || _manualLayout.length !== _regions.length) _initManualFromAuto();
    _pvSelected = hit.idx;
    var m = _manualLayout[hit.idx];
    _drag = {
      idx: hit.idx, corner: hit.corner,
      startPx: p.x, startPy: p.y,
      startX: m.x, startY: m.y, startScale: m.scale || 1,
      k: hit.k,
      baseW: _regions[hit.idx].w || 100, baseH: _regions[hit.idx].h || 100
    };
    try { cv.setPointerCapture(e.pointerId); } catch (err) {}
    if (_activeContainer) _renderPreview(_activeContainer);
    e.preventDefault();
  });
  cv.addEventListener('pointermove', function(e) {
    if (!_drag) return;
    var p = toLocal(e);
    var m = _manualLayout[_drag.idx];
    if (!m) { _drag = null; return; }
    var lay = _pvLayout();
    var k = lay.side > 0 ? PV / lay.side : _drag.k;   // 画布尺度可能随编辑变化, 实时取
    if (_drag.corner) {
      // 等比缩放: 以拖动的横向位移为准
      var dw = (p.x - _drag.startPx) / k;
      var newW = Math.max(40, _drag.baseW * _drag.startScale + dw);
      m.scale = Math.max(0.15, Math.min(4, newW / _drag.baseW));
    } else {
      m.x = Math.max(0, _drag.startX + (p.x - _drag.startPx) / k);
      m.y = Math.max(0, _drag.startY + (p.y - _drag.startPy) / k);
    }
    if (_activeContainer) _renderPreview(_activeContainer);
  });
  function endDrag() { _drag = null; }
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
}

// ── UI ──
function _renderPanel(container) {
  _activeContainer = container;
  var rows = '';
  for (var i = 0; i < _regions.length; i++) {
    var r = _regions[i];
    rows +=
      '<div class="stitch-row" data-i="' + i + '">' +
        '<span class="stitch-badge" style="background:' + PREVIEW_COLORS[i % PREVIEW_COLORS.length] + '">' + (i + 1) + '</span>' +
        '<img class="stitch-thumb" src="data:image/png;base64,' + r.base64 + '">' +
        '<div class="stitch-info">' +
          '<div class="stitch-name">区域 ' + (i + 1) + '</div>' +
          '<div class="stitch-dim">' + r.w + '×' + r.h + ' · ' + _esc(r.docName || '') + '</div>' +
        '</div>' +
        '<div class="stitch-btns">' +
          '<button class="w10-btn stitch-up" title="提高放置优先级" ' + (i === 0 ? 'disabled' : '') + '>▲</button>' +
          '<button class="w10-btn stitch-down" title="降低优先级" ' + (i === _regions.length - 1 ? 'disabled' : '') + '>▼</button>' +
          '<button class="w10-btn stitch-del" title="移除">×</button>' +
        '</div>' +
      '</div>';
  }
  var docCount = {};
  _regions.forEach(function(r) { docCount[r.docId] = 1; });
  var multiDoc = Object.keys(docCount).length > 1;
  container.innerHTML =
    '<div class="w10-panel stitch-panel">' +
      '<div class="w10-section-title">🧩 多区拼接 <span class="stitch-count">' + _regions.length + '/' + MAX_REGIONS + '</span></div>' +
      '<div class="w10-row-desc stitch-desc">多个选区拼成一张 1:1 的图, 一次调用全处理 — 省算力。\n提示词用「提示词磁贴」当前内容; 各区做同一种修改效果最好。' + (multiDoc ? '\n⚠ 区域来自多个文档: 会分文档各自贴回编组。' : '') + '</div>' +
      '<div class="stitch-list">' + (rows || '<div class="stitch-empty">还没有区域 — 在 PS 里框选后点下面「+」</div>') + '</div>' +
      '<div class="stitch-preview" id="stitchPreview" style="display:none"></div>' +
      '<div class="stitch-opts">' +
        '<span class="stitch-opt-lbl">张数</span>' +
        '<div class="stitch-batch-group">' + [1,2,3,4].map(function(n) {
          return '<button class="w10-btn stitch-batch-btn' + (_batch === n ? ' w10-btn-accent' : '') + '" data-n="' + n + '">' + n + '</button>';
        }).join('') + '</div>' +
        '<button class="w10-btn" id="stitchAutoBtn" title="放弃手动摆放, 回到算法自动排布"' + (_manualLayout ? '' : ' disabled') + '>↺ 自动排布</button>' +
      '</div>' +
      '<div class="stitch-actions">' +
        '<button class="w10-btn" id="stitchAddBtn"' + (_regions.length >= MAX_REGIONS ? ' disabled' : '') + '>+ 从当前选区添加</button>' +
        '<button class="w10-btn w10-btn-accent" id="stitchRunBtn"' + ((_regions.length < 2 || _busy) ? ' disabled' : '') + '>' + (_busy ? '生成中…' : '▶ 拼接生成') + '</button>' +
        '<button class="w10-btn" id="stitchClearBtn"' + (_regions.length ? '' : ' disabled') + '>清空</button>' +
      '</div>' +
    '</div>';
  _bind(container);
  _renderPreview(container);
}

function _esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function _refresh() { if (_activeContainer && _activeContainer.isConnected) _renderPanel(_activeContainer); }

function _bind(container) {
  var add = container.querySelector('#stitchAddBtn');
  if (add) add.addEventListener('click', function() {
    if (_regions.length >= MAX_REGIONS) return;
    TileAPI.sendToHost('stitchCaptureRegion', {});
  });
  var clear = container.querySelector('#stitchClearBtn');
  if (clear) clear.addEventListener('click', function() { _regions = []; _manualLayout = null; _pvSelected = -1; _thumbCache = {}; _refresh(); });
  var run = container.querySelector('#stitchRunBtn');
  if (run) run.addEventListener('click', _startGenerate);
  container.querySelectorAll('.stitch-batch-btn').forEach(function(b) {
    b.addEventListener('click', function() { _batch = +this.getAttribute('data-n') || 1; _refresh(); });
  });
  var autoBtn = container.querySelector('#stitchAutoBtn');
  if (autoBtn) autoBtn.addEventListener('click', function() { _manualLayout = null; _pvSelected = -1; _refresh(); });

  container.querySelectorAll('.stitch-row').forEach(function(row) {
    var i = +row.getAttribute('data-i');
    var up = row.querySelector('.stitch-up');
    var down = row.querySelector('.stitch-down');
    var del = row.querySelector('.stitch-del');
    if (up) up.addEventListener('click', function() {
      if (i > 0) {
        var t = _regions[i - 1]; _regions[i - 1] = _regions[i]; _regions[i] = t;
        if (_manualLayout) { var mt = _manualLayout[i - 1]; _manualLayout[i - 1] = _manualLayout[i]; _manualLayout[i] = mt; }
        _refresh();
      }
    });
    if (down) down.addEventListener('click', function() {
      if (i < _regions.length - 1) {
        var t2 = _regions[i + 1]; _regions[i + 1] = _regions[i]; _regions[i] = t2;
        if (_manualLayout) { var mt2 = _manualLayout[i + 1]; _manualLayout[i + 1] = _manualLayout[i]; _manualLayout[i] = mt2; }
        _refresh();
      }
    });
    if (del) del.addEventListener('click', function() {
      _regions.splice(i, 1);
      if (_manualLayout) { _manualLayout.splice(i, 1); if (!_regions.length) _manualLayout = null; }
      _pvSelected = -1;
      _refresh();
    });
  });
}

// ── 生成 ──
function _startGenerate() {
  if (_busy || _regions.length < 2) return;
  var prompt = TileAPI.state.get('prompt.text') || '';
  if (!prompt.trim()) { TileAPI.toast('提示词是空的 — 先在提示词磁贴里写上要做什么', 'error'); return; }
  var conn = window._settingsGetActiveConnection ? window._settingsGetActiveConnection() : null;
  if (!conn || !conn.key) {
    if (conn && conn._grsKeyPending) TileAPI.toast('正在准备夏算力, 请稍后再试', 'info');
    else if (conn && conn._grsNeedLogin) TileAPI.toast('夏算力托管需要登录 (顶栏账号区), 或切回「自带 Key」', 'error');
    else TileAPI.toast('请先在顶栏配置 API Key', 'error');
    return;
  }

  var model = TileAPI.state.get('params.model') || 'AJbanana3';
  var size = TileAPI.state.get('params.size') || '2K';
  var timeout = TileAPI.state.get('params.timeout') || 3600;
  var antiMode = +(TileAPI.state.get('params.antiMode') || 0);
  var layerType = TileAPI.storage.get('output.layerType') || 'smartObject';
  var presetTitle = TileAPI.state.get('prompt.lastPresetTitle') || '';
  var taskId = 'stitch_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);

  _busy = true;
  _refresh();
  _buildStitched(antiMode).then(function(st) {
    var running = TileAPI.state.get('tasks.running') || {};
    running[taskId] = {
      engine: 'banana', provider: conn.provider,
      batchSize: _batch, startTime: Date.now(), success: 0, fail: 0, total: _batch,
      model: model, size: size,
      presetTitle: presetTitle || '多区拼接',
      promptSnippet: '🧩' + _regions.length + '区: ' + prompt.replace(/\s+/g, ' ').substring(0, 24),
      thumbnail: null,
      docId: _regions[0].docId,
      docName: _regions[0].docName || '',
      docPath: _regions[0].docPath || '',
      selection: null
    };
    TileAPI.state.set('tasks.running', running);
    var meta = TileAPI.state.get('tasks.meta') || {};
    meta[taskId] = { countdown: timeout, timeoutSec: timeout, autoReturn: true, batchSize: _batch };
    TileAPI.state.set('tasks.meta', meta);
    TileAPI.emit('tasks:updated');
    TileAPI.emit('task:started', { taskId: taskId, timeoutSec: timeout, batchSize: _batch });

    TileAPI.sendToHost('stitchGenerate', {
      taskId: taskId,
      stitchedBase64: st.base64, stitchW: st.w, stitchH: st.h, layout: st.layout,
      docId: _regions[0].docId,
      prompt: prompt, apiKey: conn.key, apiBaseUrl: conn.url,
      model: model, provider: conn.provider, size: size, timeout: timeout,
      docName: _regions[0].docName || '',
      docPath: _regions[0].docPath || '',
      antiMode: antiMode, layerType: layerType, presetTitle: presetTitle,
      batch: _batch
    });
    TileAPI.toast('已发送: ' + _regions.length + ' 区拼成 1:1 (' + st.w + '×' + st.h + ')' + (_batch > 1 ? ' × ' + _batch + ' 张' : ''), 'success');
  }).catch(function(e) {
    _busy = false;
    _refresh();
    TileAPI.toast('拼接失败: ' + (e.message || e), 'error');
  });
}

// ── 磁贴注册 + host 消息 ──
TileAPI.registerTile({
  id: 'stitch',
  group: 'main',
  icon: '🧩',
  label: '多区拼接',
  desc: '多个选区拼一张图生成, 省算力',
  live: false,
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 6 },

  renderFront: function(container, w) {
    var n = _regions.length;
    if (w >= 2) {
      container.innerHTML = '<div class="tile-icon">🧩</div><div class="tile-label">多区拼接</div><div class="tile-desc">' + (n ? n + ' 个区域待拼' : '省算力的拼图生成') + '</div>';
    } else {
      container.innerHTML = '<div class="tile-icon">🧩</div><div class="tile-label">' + (n ? '拼接 ' + n : '多区拼接') + '</div>';
    }
  },

  onExpand: function(container) {
    _renderPanel(container);
    return function() { _activeContainer = null; };
  },

  onMessage: function(action, data) {
    if (action === 'stitchCaptureResult') {
      if (!data.success) { TileAPI.toast(data.error || '抓取失败', 'error'); return; }
      _regions.push({
        base64: data.base64, selection: data.selection,
        docId: data.docId, docName: data.docName, docPath: data.docPath || '',
        w: data.selection ? data.selection.width : 0,
        h: data.selection ? data.selection.height : 0
      });
      if (_manualLayout) {
        // 手动模式: 新块放到现有内容右侧, 不打乱已摆好的
        var ext = 0;
        var sizesNow = _regions.slice(0, -1).map(function(rr) { return { w: rr.w || 100, h: rr.h || 100 }; });
        var layNow = resolveLayout(sizesNow);
        _manualLayout.push({ x: layNow.side > 0 ? layNow.side + 16 : 0, y: 0, scale: 1 });
      }
      TileAPI.toast('区域 ' + _regions.length + ' 已添加 (' + (data.docName || '') + ')', 'success');
      _refresh();
    }
    if (action === 'stitchGenerateResult') {
      if (!data.success) {
        _busy = false;
        _refresh();
        return;
      }
      // 多张: 逐张切块, 块上带 batchIdx, host 按张各编一组
      var results = data.resultBase64s || [data.resultBase64];
      Promise.all(results.map(function(rb, bi) {
        return _sliceResult(rb, data.stitchW, data.stitchH, data.layout).then(function(parts) {
          parts.forEach(function(p) { p.batchIdx = bi; });
          return parts;
        });
      })).then(function(all) {
        var flat = [];
        all.forEach(function(ps) { flat = flat.concat(ps); });
        TileAPI.sendToHost('stitchPlaceParts', {
          taskId: data.taskId, docId: data.docId, parts: flat,
          antiMode: data.antiMode, layerType: data.layerType,
          presetTitle: data.presetTitle,
          model: data.model, provider: data.provider || '',
          sizeLabel: data.size, size: data.size,
          docName: data.docName || '', docPath: data.docPath || '',
          apiSuccessCount: data.apiSuccessCount || 0,
          apiFailCount: data.apiFailCount || 0,
          size4k: data.size === '4K'
        });
      }).catch(function(e) {
        _busy = false;
        _refresh();
        // 切块失败也要通知 Host 结算已成功的 API 图片，否则会留下永远运行中的任务卡。
        TileAPI.sendToHost('stitchPlaceParts', {
          taskId: data.taskId, docId: data.docId, parts: [],
          model: data.model, provider: data.provider || '',
          sizeLabel: data.size, size: data.size,
          docName: data.docName || '', docPath: data.docPath || '',
          apiSuccessCount: data.apiSuccessCount || 0,
          apiFailCount: data.apiFailCount || 0
        });
        TileAPI.toast('切块失败: ' + (e.message || e), 'error');
      });
    }
    if (action === 'stitchPlaceResult') {
      _busy = false;
      if (data.success) TileAPI.toast('多区拼接完成: ' + data.placed + ' 块已各归各位', 'success');
      _refresh();
    }
  }
});

})();
