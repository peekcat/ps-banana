// ============================================================
//  tile-layercm.js —— 🎯 双选区互相调色 (全新磁贴, 与 AI 调色无关)
//
//  用法(和生图完全一致的手抓选区):
//    1. 在 PS 框一个选区 → 点「抓取参照 A」
//    2. 再框另一个选区 → 点「抓取要改的 B」
//    3. 选方式(精准/整体)+ 方向(A→B 默认), 点「开始调色」
//  抓取后缩略图会显示在面板上; 点缩略图 → 在 PS 里重新载入那个选区(便于微调/换选区)
//  结果: 以 A 的颜色为参照, 把 B 调成 A 的颜色, 生成一张新图层, 置顶
//  进度: 独立任务走 colormatch 链路 → 生成中心出独立活气泡
//  自动传回: 开 = 算完直接贴回; 关 = 算完进「待返回」, 在生成中心点 ✓ 再贴
//
//  算法本体(webview 侧)在 tile-colormatch.js(与 dock 校色同一套):
//    wavelet  = 精准校色(细节保留)  reinhard = 整体校色(Lab 均值/标准差拉齐)
// ============================================================
(function() {
'use strict';

var _running = false;
var _activeContainer = null;

// 捕获结果: A={ok,meta,base64(缩略图)}, B 同
var _capA = null;
var _capB = null;

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
//  算法复用: 从 tile-colormatch.js 里挑出 wavelet/reinhard 两个
//  纯函数(它们不碰任何模块级状态, 直接内联一份, 避免跨文件耦合)
// ============================================================
var _srgb2lin = null;
function _initLut() {
  if (_srgb2lin) return;
  _srgb2lin = new Float32Array(256);
  for (var i = 0; i < 256; i++) {
    var c = i / 255;
    _srgb2lin[i] = (c <= 0.04045) ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
}
function _f(t) { return (t > 0.008856) ? Math.cbrt(t) : (7.787 * t + 16 / 116); }
function _finv(t) { var t3 = t * t * t; return (t3 > 0.008856) ? t3 : (t - 16 / 116) / 7.787; }
function _lin2srgb(c) {
  if (c <= 0) return 0;
  var s = (c <= 0.0031308) ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  var v = Math.round(s * 255);
  return v < 0 ? 0 : (v > 255 ? 255 : v);
}
function _toLab(data, n) {
  _initLut();
  var L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  for (var i = 0, p = 0; i < n; i++, p += 4) {
    var r = _srgb2lin[data[p]], g = _srgb2lin[data[p + 1]], b = _srgb2lin[data[p + 2]];
    var x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    var y = (0.2126 * r + 0.7152 * g + 0.0722 * b);
    var z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    var fx = _f(x), fy = _f(y), fz = _f(z);
    L[i] = 116 * fy - 16;
    A[i] = 500 * (fx - fy);
    B[i] = 200 * (fy - fz);
  }
  return { L: L, a: A, b: B };
}
function _meanStd(arr, n) {
  var sum = 0, i, d;
  for (i = 0; i < n; i++) sum += arr[i];
  var mean = sum / n;
  var sq = 0;
  for (i = 0; i < n; i++) { d = arr[i] - mean; sq += d * d; }
  var std = Math.sqrt(sq / n);
  return { mean: mean, std: (std > 1e-6 ? std : 1e-6) };
}
function _lab2rgbWrite(L, A, B, data, n) {
  for (var i = 0, p = 0; i < n; i++, p += 4) {
    var fy = (L[i] + 16) / 116;
    var fx = fy + A[i] / 500;
    var fz = fy - B[i] / 200;
    var x = _finv(fx) * 0.95047, y = _finv(fy), z = _finv(fz) * 1.08883;
    data[p]     = _lin2srgb(3.2406 * x - 1.5372 * y - 0.4986 * z);
    data[p + 1] = _lin2srgb(-0.9689 * x + 1.8758 * y + 0.0415 * z);
    data[p + 2] = _lin2srgb(0.0557 * x - 0.2040 * y + 1.0570 * z);
  }
}
// 整体校色: Lab 均值/标准差拉齐 (输出=要改的 B, 输入=参照 A)
function _reinhard(outData, inData, n) {
  var o = _toLab(outData, n), s = _toLab(inData, n);
  var keys = ['L', 'a', 'b'];
  for (var c = 0; c < 3; c++) {
    var oc = o[keys[c]], sc = s[keys[c]];
    var os = _meanStd(oc, n), ss = _meanStd(sc, n);
    var k = ss.std / os.std;
    for (var i = 0; i < n; i++) oc[i] = (oc[i] - os.mean) * k + ss.mean;
  }
  _lab2rgbWrite(o.L, o.a, o.b, outData, n);
}
// 精准校色: 低频替换 (结果 = B − blur(B) + blur(A))
function _blurH(src, dst, w, h, r) {
  for (var y = 0; y < h; y++) {
    var base = y * w, sum = 0, count = 0, x;
    var lead = Math.min(r + 1, w);
    for (x = 0; x < lead; x++) { sum += src[base + x]; count++; }
    dst[base] = sum / count;
    for (x = 1; x < w; x++) {
      var add = x + r, rem = x - r - 1;
      if (add < w) { sum += src[base + add]; count++; }
      if (rem >= 0) { sum -= src[base + rem]; count--; }
      dst[base + x] = sum / count;
    }
  }
}
function _blurV(src, dst, w, h, r) {
  for (var x = 0; x < w; x++) {
    var sum = 0, count = 0, y;
    var lead = Math.min(r + 1, h);
    for (y = 0; y < lead; y++) { sum += src[y * w + x]; count++; }
    dst[x] = sum / count;
    for (y = 1; y < h; y++) {
      var add = y + r, rem = y - r - 1;
      if (add < h) { sum += src[add * w + x]; count++; }
      if (rem >= 0) { sum -= src[rem * w + x]; count--; }
      dst[y * w + x] = sum / count;
    }
  }
}
function _boxBlur3(buf, tmp, w, h, r) {
  _blurH(buf, tmp, w, h, r); _blurV(tmp, buf, w, h, r);
  _blurH(buf, tmp, w, h, r); _blurV(tmp, buf, w, h, r);
  _blurH(buf, tmp, w, h, r); _blurV(tmp, buf, w, h, r);
}
function _wavelet(outData, inData, w, h) {
  var n = w * h;
  var r = Math.max(4, Math.round(Math.min(w, h) / 16));
  var chA = new Float32Array(n), blurA = new Float32Array(n), blurB = new Float32Array(n), tmp = new Float32Array(n);
  for (var c = 0; c < 3; c++) {
    var i, p;
    for (i = 0, p = c; i < n; i++, p += 4) {
      chA[i] = outData[p];
      blurA[i] = outData[p];
      blurB[i] = inData[p];
    }
    _boxBlur3(blurA, tmp, w, h, r);
    _boxBlur3(blurB, tmp, w, h, r);
    for (i = 0, p = c; i < n; i++, p += 4) {
      var v = Math.round(chA[i] - blurA[i] + blurB[i]);
      outData[p] = v < 0 ? 0 : (v > 255 ? 255 : v);
    }
  }
}

// ============================================================
//  计算入口(host 发来 layerCmCompute)
// ============================================================
function _loadImage(b64) {
  return new Promise(function(resolve, reject) {
    var img = new Image();
    img.onload = function() { resolve(img); };
    img.onerror = function() { reject(new Error('图片解码失败')); };
    img.src = 'data:image/png;base64,' + b64;
  });
}
function _compute(msg) {
  var jobId = msg.jobId;
  Promise.all([_loadImage(msg.outputB64), _loadImage(msg.inputB64)]).then(function(imgs) {
    var outImg = imgs[0], inImg = imgs[1];
    var w = outImg.width, h = outImg.height;
    if (!w || !h) throw new Error('图片尺寸异常');
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(outImg, 0, 0);
    var outID = cx.getImageData(0, 0, w, h);
    cx.clearRect(0, 0, w, h);
    cx.drawImage(inImg, 0, 0, w, h);   // 参照 A 缩放到 B 的尺寸(两区本来同画布像素, 只差分辨率)
    var inID = cx.getImageData(0, 0, w, h);
    if (msg.method === 'reinhard') _reinhard(outID.data, inID.data, w * h);
    else _wavelet(outID.data, inID.data, w, h);
    cx.putImageData(outID, 0, 0);
    var dataUrl = cv.toDataURL('image/png');
    var b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    TileAPI.sendToHost('layerCmComputeResult', { jobId: jobId, ok: true, base64: b64 });
  }).catch(function(err) {
    TileAPI.sendToHost('layerCmComputeResult', { jobId: jobId, ok: false, error: (err && err.message) || String(err) });
  });
}

// ============================================================
//  渲染
// ============================================================
function _metaLabel(meta) {
  if (!meta) return '';
  return Math.round(meta.width) + '×' + Math.round(meta.height);
}

function _slotHtml(slotKey, label, tag, cap) {
  var has = cap && cap.ok && cap.meta;
  var inner;
  if (has) {
    inner =
      '<div class="lcm-slot-imgwrap">' +
        (cap.base64
          ? '<img class="lcm-slot-img" src="data:image/png;base64,' + cap.base64 + '" alt="">'
          : '<div class="lcm-slot-ph"></div>') +
        '<div class="lcm-slot-tag">' + tag + '</div>' +
      '</div>' +
      '<div class="lcm-slot-dims">' + _metaLabel(cap.meta) + '</div>' +
      '<div class="lcm-slot-actions">' +
        '<button class="w10-btn lcm-slot-btn" data-lcm-reload="' + slotKey + '" title="在 PS 里重新载入这个选区(可微调后重抓)">↺ 载入选区</button>' +
        '<button class="w10-btn lcm-slot-btn lcm-slot-btn-danger" data-lcm-clear="' + slotKey + '" title="清除这个选区">✕</button>' +
      '</div>';
  } else {
    inner =
      '<div class="lcm-slot-ph lcm-slot-ph-empty">' +
        '<div class="lcm-slot-empty-icon">⊞</div>' +
        '<div class="lcm-slot-empty-text">' + label + '</div>' +
      '</div>' +
      '<button class="w10-btn w10-btn-accent lcm-slot-btn lcm-slot-capture" data-lcm-capture="' + slotKey + '" title="用当前 PS 选区抓取">抓取 ' + tag + '</button>';
  }
  return '<div class="w10-row" style="flex-direction:column;align-items:stretch;border-bottom:none;">' +
    '<div class="w10-section-title">' + label + '</div>' +
    '<div class="lcm-slot">' + inner + '</div>' +
  '</div>';
}

function _render(container) {
  var method = TileAPI.storage.get('layercm.method') || 'wavelet';
  var dir = TileAPI.storage.get('layercm.direction') || 'ab';   // ab = A→B(默认), ba = B→A
  var autoReturn = TileAPI.storage.get('output.autoReturn') !== false;
  container.innerHTML =
    '<div class="w10-panel lcm-root">' +
      '<div class="lcm-hint">' +
        '在 PS 里框一个选区作为<b>参照色</b>, 再框另一个选区作为<b>要改的区域</b>。' +
        '抓取后点缩略图可重新载入该选区。' +
      '</div>' +

      _slotHtml('A', '① 参照色', 'A', _capA) +
      _slotHtml('B', '② 要改的', 'B', _capB) +

      '<div class="w10-section-title">校色方式</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">方式</div><div class="w10-row-desc">精准=保留细节(画面变化不大时); 整体=整体色调拉齐(特效/大变时)</div></div>' +
        '<div class="w10-row-right" style="flex:1;max-width:200px;">' +
          '<select class="w10-select" id="lcmMethod">' +
            '<option value="wavelet"' + (method === 'wavelet' ? ' selected' : '') + '>精准调色</option>' +
            '<option value="reinhard"' + (method === 'reinhard' ? ' selected' : '') + '>整体调色</option>' +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">方向</div><div class="w10-row-desc">默认: 把 B 调成 A 的颜色</div></div>' +
        '<div class="w10-row-right" style="flex:1;max-width:200px;">' +
          '<select class="w10-select" id="lcmDir">' +
            '<option value="ab"' + (dir === 'ab' ? ' selected' : '') + '>A 的颜色 → 给 B</option>' +
            '<option value="ba"' + (dir === 'ba' ? ' selected' : '') + '>B 的颜色 → 给 A</option>' +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div class="w10-row" style="justify-content:flex-end;gap:8px;border-bottom:none;">' +
        '<span class="lcm-ar-hint">' + (autoReturn ? '自动传回: 开(算完直接贴回)' : '自动传回: 关(算完转待返回)') + '</span>' +
        '<button class="w10-btn" id="lcmVerifyBtn" title="把结果图贴回 B 选区并验证尺寸对齐(调试用)">验证贴回</button>' +
        '<button class="w10-btn w10-btn-accent" id="lcmStartBtn">' + (_running ? '中断' : '开始调色') + '</button>' +
      '</div>' +
    '</div>';
  _bind(container);
}

function _bind(container) {
  var methodSel = container.querySelector('#lcmMethod');
  if (methodSel) methodSel.addEventListener('change', function() { TileAPI.storage.set('layercm.method', methodSel.value); });
  var dirSel = container.querySelector('#lcmDir');
  if (dirSel) dirSel.addEventListener('change', function() { TileAPI.storage.set('layercm.direction', dirSel.value); });

  // 抓取
  container.querySelectorAll('[data-lcm-capture]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      TileAPI.sendToHost('layerCmCapture', { kind: btn.dataset.lcmCapture });
      TileAPI.toast('正在抓取选区…', 'info');
    });
  });
  // 载入选区(缩略图点击)
  container.querySelectorAll('[data-lcm-reload]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var cap = (btn.dataset.lcmReload === 'A') ? _capA : _capB;
      if (!cap || !cap.meta) { TileAPI.toast('还没抓到选区', 'warn'); return; }
      TileAPI.sendToHost('restoreSelectionFromHistory', { selection: cap.meta, docId: cap.passThru ? cap.passThru.docId : null });
      TileAPI.toast('已载入选区, 可微调后重抓', 'info');
    });
  });
  // 清除
  container.querySelectorAll('[data-lcm-clear]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (btn.dataset.lcmClear === 'A') _capA = null; else _capB = null;
      _render(container);
    });
  });

  // 开始 / 中断
  var startBtn = container.querySelector('#lcmStartBtn');
  if (startBtn) startBtn.addEventListener('click', function() {
    if (_running) {
      TileAPI.toast('正在中断调色任务…', 'info');
      TileAPI.sendToHost('earlyStopTask', { taskId: _running });
      startBtn.textContent = '正在中断…';
      return;
    }
    _doStart(container);
  });

  // 验证贴回(调试): 把 B 的缩略图贴回 B 选区, 看是否精确对齐
  var verifyBtn = container.querySelector('#lcmVerifyBtn');
  if (verifyBtn) verifyBtn.addEventListener('click', function() {
    if (!_capB || !_capB.ok || !_capB.meta) { TileAPI.toast('请先抓取 B 选区', 'warn'); return; }
    // 用 B 的缩略图(或全尺寸, 这里用缩略图做轻量验证)贴回 B 选区
    var b64 = _capB.base64 || '';
    if (!b64) { TileAPI.toast('B 没有抓取到图像数据, 无法验证', 'warn'); return; }
    var docId = _capB.passThru ? _capB.passThru.docId : null;
    TileAPI.toast('正在验证贴回尺寸…', 'info');
    TileAPI.sendToHost('layerCmPlaceVerify', { base64: b64, docId: docId, selection: _capB.meta });
  });
}

function _doStart(container) {
  if (!_capA || !_capA.ok || !_capA.meta) { TileAPI.toast('请先抓取参照色 A', 'warn'); return; }
  if (!_capB || !_capB.ok || !_capB.meta) { TileAPI.toast('请先抓取要改的 B', 'warn'); return; }
  if (!_capA.meta.width || !_capA.meta.height || !_capB.meta.width || !_capB.meta.height) {
    TileAPI.toast('选区为空(可能是全选空白), 请重新框选', 'warn'); return;
  }
  var method = (container.querySelector('#lcmMethod') || {}).value || 'wavelet';
  var dir = (container.querySelector('#lcmDir') || {}).value || 'ab';
  // 方向: ba 时 A、B 对调(把 A 调成 B 的颜色) — 计算端 input=参照, output=要改的
  var ref = (dir === 'ba') ? _capB : _capA;
  var tgt = (dir === 'ba') ? _capA : _capB;
  var autoReturn = TileAPI.storage.get('output.autoReturn') !== false;
  _running = true;
  if (container.querySelector('#lcmStartBtn')) {
    container.querySelector('#lcmStartBtn').textContent = '中断';
    container.querySelector('#lcmStartBtn').classList.remove('w10-btn-accent');
  }
  TileAPI.sendToHost('layerCmRun', {
    captureA: ref,
    captureB: tgt,
    method: method,
    autoReturn: autoReturn
  });
  TileAPI.toast('调色任务已提交, 进度见生成中心', 'info');
}

// ============================================================
//  消息
// ============================================================
function _onMessage(action, data) {
  if (action === 'layerCmCaptured') {
    if (!data) return;
    if (data.ok && data.meta) {
      var cap = { ok: true, meta: data.meta, base64: data.base64 || null, passThru: data.passThru || null };
      if (data.kind === 'A') _capA = cap;
      else if (data.kind === 'B') _capB = cap;
      if (_activeContainer) _render(_activeContainer);
      TileAPI.toast((data.kind === 'A' ? '参照色 A' : '要改的 B') + ' 已抓取: ' + _metaLabel(data.meta), 'success');
    } else {
      TileAPI.toast('抓取失败: ' + (data.error || '未知错误'), 'error');
    }
    return;
  }
  if (action === 'layerCmCompute' && data) {
    _compute(data);
    return;
  }
  if (action === 'layerCmStatus' && data && TileAPI.toast) {
    var lv = data.level;
    TileAPI.toast(data.text, (lv === 'success' || lv === 'error' || lv === 'warn') ? lv : 'info');
    if (data.level === 'success' || data.level === 'error') {
      _running = false;
      if (_activeContainer) _render(_activeContainer);
    }
  }
  if (action === 'layerCmPlaceVerifyResult') {
    if (!data) return;
    if (!data.ok) { TileAPI.toast('验证失败: ' + (data.error || '未知错误'), 'error'); return; }
    var t = data.target || {};
    var a = data.after || {};
    var b = data.before || {};
    var msg = '贴回验证: 目标 ' + (t.width || '?') + '×' + (t.height || '?')
      + ', 贴后 ' + (a.width || '?') + '×' + (a.height || '?')
      + (b && b.width ? ', 结果原尺寸 ' + b.width + '×' + b.height : '');
    var ok = a && t && Math.abs((a.width || 0) - (t.width || 0)) <= 2 && Math.abs((a.height || 0) - (t.height || 0)) <= 2;
    TileAPI.toast(msg + (ok ? ' ✓ 精确对齐' : ' ⚠ 尺寸不符(需排查)'), ok ? 'success' : 'warn');
    return;
  }
}

// ============================================================
//  注册
// ============================================================
TileAPI.registerTile({
  id: 'layercm',
  group: 'main',
  icon: '🎯',
  label: '双区调色',
  desc: '两个选区互相调色',
  live: false,
  defaultSize: { w: 2, h: 3 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  onExpand: function(container) {
    _activeContainer = container;
    _render(container);
    return function() { _activeContainer = null; };
  },
  onCollapse: function() { _activeContainer = null; },
  onMessage: _onMessage
});

})();
