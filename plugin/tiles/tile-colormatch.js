// ============================================================
//  tile-colormatch.js —— 校色前端计算模块(webview 侧)
//  不注册磁贴, 只干算术活。Dock 按钮在 core/dock.js,
//  后端(查台账/读缓存/贴回)在 tile-colormatch.host.js。
//
//  收 host 的 colormatchCompute {jobId, method, inputB64, outputB64}
//    → canvas 解码(原图缩放到回图尺寸)
//    → method='wavelet'  精准校色: 回图细节 + 原图低频颜色
//      method='reinhard' 整体校色: Lab 空间均值/标准差拉齐
//    → PNG 编码 → sendToHost('colormatchResult', {jobId, ok, base64})
//  另收 colormatchStatus → 弹 toast(host 想让用户看见的进度/结果)
// ============================================================
(function() {
'use strict';

function _loadImage(b64) {
  return new Promise(function(resolve, reject) {
    var img = new Image();
    img.onload = function() { resolve(img); };
    img.onerror = function() { reject(new Error('图片解码失败')); };
    img.src = 'data:image/png;base64,' + b64;
  });
}

// ---------- 整体校色: Lab 均值/标准差匹配 (Reinhard) ----------
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

// RGBA 像素 → Lab 三通道 Float32
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

// outData 被就地改写成校色结果
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

// ---------- 精准校色: 小波低频替换 ----------
// 结果 = 回图 − blur(回图) + blur(原图);  blur = 3 次 box blur ≈ 高斯
// 边缘用"实际窗口计数"归一, 不会发暗
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
  var chA = new Float32Array(n);    // 回图原值(细节来源)
  var blurA = new Float32Array(n);  // blur(回图)
  var blurB = new Float32Array(n);  // blur(原图)
  var tmp = new Float32Array(n);
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

// ---------- 主流程 ----------
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
    cx.drawImage(inImg, 0, 0, w, h);   // 原图缩放到回图尺寸(本来就是同一选区, 只是分辨率不同)
    var inID = cx.getImageData(0, 0, w, h);

    if (msg.method === 'reinhard') _reinhard(outID.data, inID.data, w * h);
    else _wavelet(outID.data, inID.data, w, h);

    cx.putImageData(outID, 0, 0);
    var dataUrl = cv.toDataURL('image/png');
    var b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    TileAPI.sendToHost('colormatchResult', { jobId: jobId, ok: true, base64: b64 });
  }).catch(function(err) {
    TileAPI.sendToHost('colormatchResult', { jobId: jobId, ok: false, error: (err && err.message) || String(err) });
  });
}

// ---------- 任务磁贴卡片 ----------
// host 开始校色时来一条 colormatchTaskStarted → 在任务磁贴里建一张运行中卡片。
// 之后的 taskProgress / taskComplete / 待返回 全走任务磁贴现成机制。
function _registerTaskCard(d) {
  try {
    var running = TileAPI.state.get('tasks.running') || {};
    running[d.taskId] = {
      engine: 'colormatch',
      provider: '',            // 留空 → 账单磁贴不会把校色记成生成流水
      batchSize: d.count || 1, startTime: Date.now(), success: 0, fail: 0, total: d.count || 1,
      model: d.methodName || '校色',
      size: '',
      presetTitle: '',
      promptSnippet: d.methodName || '校色',
      thumbnail: null, docId: null, selection: null
    };
    TileAPI.state.set('tasks.running', running);
    // meta 先写好(带上任务自己的 autoReturn), 任务磁贴的 task:started 处理器见已有 meta 不会覆盖
    var meta = TileAPI.state.get('tasks.meta') || {};
    meta[d.taskId] = { countdown: 600, timeoutSec: 600, autoReturn: d.autoReturn !== false, batchSize: d.count || 1 };
    TileAPI.state.set('tasks.meta', meta);
    TileAPI.emit('task:started', { taskId: d.taskId, timeoutSec: 600, batchSize: d.count || 1 });
    TileAPI.emit('tasks:updated');
  } catch (e) {}
}

// ---------- 接线 ----------
window.addEventListener('message', function(e) {
  var msg = e.data;
  if (!msg || msg.source !== 'host' || !msg.action) return;
  if (msg.action === 'colormatchCompute' && msg.data) _compute(msg.data);
  if (msg.action === 'colormatchTaskStarted' && msg.data && window.TileAPI) _registerTaskCard(msg.data);
  if (msg.action === 'colormatchStatus' && msg.data && window.TileAPI && TileAPI.toast) {
    var lv = msg.data.level;
    TileAPI.toast(msg.data.text, (lv === 'success' || lv === 'error' || lv === 'warn') ? lv : 'info');
  }
});

})();
