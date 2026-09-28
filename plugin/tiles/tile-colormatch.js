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

// outData 被就地改写成校色结果。只在内容区(crop)内改色, 白边区(crop外)原样不动。
// 统计也只用内容区 —— 白边不参与均值/标准差, 不污染基准。
function _reinhardRect(outData, inData, w, h, crop) {
  var n = w * h;
  var o = _toLab(outData, n), s = _toLab(inData, n);
  var keys = ['L', 'a', 'b'];
  for (var c = 0; c < 3; c++) {
    var oc = o[keys[c]], sc = s[keys[c]];
    var os = _meanStdRect(oc, w, h, crop), ss = _meanStdRect(sc, w, h, crop);
    var k = ss.std / os.std;
    var mean = os.mean, shift = ss.mean;
    for (var i = 0; i < n; i++) oc[i] = (oc[i] - mean) * k + shift;   // 先对整图做变换(供后续只写回内容区)
  }
  // 只把内容区写回, 白边区(补白)保持 outData 原样。
  var outLab = { L: o.L, a: o.a, b: o.b };
  _lab2rgbWriteRect(outLab, outData, w, h, crop);
}

// 只在 crop 矩形内把 Lab 写回 RGB, 其余像素不动
function _lab2rgbWriteRect(o, data, w, h, crop) {
  var l = 0, t = 0, r = w, b = h;
  if (crop) {
    l = Math.max(0, Math.round(crop.left)); t = Math.max(0, Math.round(crop.top));
    r = Math.min(w, Math.round(crop.left + crop.width)); b = Math.min(h, Math.round(crop.top + crop.height));
  }
  for (var y = t; y < b; y++) {
    for (var x = l; x < r; x++) {
      var i = y * w + x;
      var p = (y * w + x) * 4;
      var fy = (o.L[i] + 16) / 116;
      var fx = fy + o.a[i] / 500;
      var fz = fy - o.b[i] / 200;
      var xx = _finv(fx) * 0.95047, yy = _finv(fy), zz = _finv(fz) * 1.08883;
      data[p]     = _lin2srgb(3.2406 * xx - 1.5372 * yy - 0.4986 * zz);
      data[p + 1] = _lin2srgb(-0.9689 * xx + 1.8758 * yy + 0.0415 * zz);
      data[p + 2] = _lin2srgb(0.0557 * xx - 0.2040 * yy + 1.0570 * zz);
    }
  }
}

// 只在 crop 矩形内统计数组的均值/标准差(crop 为空则全图)
function _meanStdRect(arr, w, h, crop) {
  var l = 0, t = 0, r = w, b = h;
  if (crop) {
    l = Math.max(0, Math.round(crop.left)); t = Math.max(0, Math.round(crop.top));
    r = Math.min(w, Math.round(crop.left + crop.width)); b = Math.min(h, Math.round(crop.top + crop.height));
  }
  var sum = 0, sq = 0, cnt = 0;
  for (var y = t; y < b; y++) {
    var base = y * w;
    for (var x = l; x < r; x++) { var v = arr[base + x]; sum += v; sq += v * v; cnt++; }
  }
  if (!cnt) cnt = 1;
  var mean = sum / cnt;
  var std = Math.sqrt(Math.max(0, sq / cnt - mean * mean));
  return { mean: mean, std: (std > 1e-6 ? std : 1e-6) };
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

// 只在内容区(crop)内做的 box blur(3次)。每次 blur 后把内容区外的像素重置为内容区均值,
// 这样 blur 的低频基准只来自内容区自己 —— 白边混不进来, 校色不会因白边边界糊入而变暗。
function _boxBlur3Crop(buf, tmp, w, h, r, crop) {
  _blurH(buf, tmp, w, h, r); _blurV(tmp, buf, w, h, r);
  _resetOutsideToMean(buf, w, h, crop);
  _blurH(buf, tmp, w, h, r); _blurV(tmp, buf, w, h, r);
  _resetOutsideToMean(buf, w, h, crop);
  _blurH(buf, tmp, w, h, r); _blurV(tmp, buf, w, h, r);
  _resetOutsideToMean(buf, w, h, crop);
}

// 把内容区外的像素置为内容区均值(隔离白边对 blur 窗口的影响)
function _resetOutsideToMean(buf, w, h, crop) {
  var l = Math.max(0, Math.round(crop.left)), t = Math.max(0, Math.round(crop.top));
  var rr = Math.min(w, Math.round(crop.left + crop.width)), bb = Math.min(h, Math.round(crop.top + crop.height));
  if (rr <= l || bb <= t) return;
  // 内容区均值
  var sum = 0, cnt = 0;
  for (var y = t; y < bb; y++) {
    var base = y * w;
    for (var x = l; x < rr; x++) { sum += buf[base + x]; cnt++; }
  }
  var mean = cnt ? sum / cnt : 0;
  // 内容区外(含白边)置为均值
  for (var yy = 0; yy < h; yy++) {
    var b2 = yy * w;
    // 左带 / 右带 / 上带 / 下带
    for (var xx = 0; xx < l; xx++) buf[b2 + xx] = mean;
    for (var xx2 = rr; xx2 < w; xx2++) buf[b2 + xx2] = mean;
  }
  for (var yy2 = 0; yy2 < t; yy2++) for (var xx3 = l; xx3 < rr; xx3++) buf[yy2 * w + xx3] = mean;
  for (var yy3 = bb; yy3 < h; yy3++) for (var xx4 = l; xx4 < rr; xx4++) buf[yy3 * w + xx4] = mean;
}

function _waveletRect(outData, inData, w, h, crop) {
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
    // 有白边(补白成1:1)时: blur 只在内容区内部做, 白边混不进低频基准 — 不会因边界糊入而变暗。
    // 无 crop(正常选区)走原整图 blur, 行为和原来完全一致。
    if (crop) { _boxBlur3Crop(blurA, tmp, w, h, r, crop); _boxBlur3Crop(blurB, tmp, w, h, r, crop); }
    else { _boxBlur3(blurA, tmp, w, h, r); _boxBlur3(blurB, tmp, w, h, r); }
    for (i = 0, p = c; i < n; i++, p += 4) {
      // 只在内容区内写回, 白边区不动
      if (crop && !_inCrop(i, w, h, crop)) continue;
      var v = Math.round(chA[i] - blurA[i] + blurB[i]);
      outData[p] = v < 0 ? 0 : (v > 255 ? 255 : v);
    }
  }
}

function _inCrop(i, w, h, crop) {
  var x = i % w, y = Math.floor(i / w);
  return x >= crop.left && x < crop.left + crop.width && y >= crop.top && y < crop.top + crop.height;
}

// ---------- 几何对位辅助: 灰度降采样 ----------
// 灰度降采样: RGB(RGBA) → 2x2 平均灰度 float, 用于特征匹配前缩小
function _grayDownsample(data, width, height, step, sw, sh) {
  var out = new Float32Array(sw * sh);
  for (var y = 0; y < sh; y++) {
    for (var x = 0; x < sw; x++) {
      var s = 0, cnt = 0;
      for (var dy = 0; dy < step; dy++) for (var dx = 0; dx < step; dx++) {
        var sy = y * step + dy, sx = x * step + dx;
        if (sy < height && sx < width) {
          var p = (sy * width + sx) * 4;
          s += 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
          cnt++;
        }
      }
      out[y * sw + x] = cnt ? (s / cnt) : 0;
    }
  }
  return out;
}

// 块内梯度(平均绝对亮度差), 判断这块是否平滑(平滑块匹配无意义)
function _patchGradient(gray, sw, sh, px, py, patch) {
  var sum = 0, cnt = 0;
  for (var y = py; y < py + patch; y++) {
    for (var x = px; x < px + patch; x++) {
      var v = gray[y * sw + x];
      if (x > px) { sum += Math.abs(v - gray[y * sw + x - 1]); cnt++; }
      if (y > py) { sum += Math.abs(v - gray[(y - 1) * sw + x]); cnt++; }
    }
  }
  return cnt ? (sum / cnt) : 0;
}

// ---------- 几何对位: 特征点 + RANSAC 单应矩阵 ----------
// 把回图(output)按原图(input)内容区的特征变形到原图位置。返回变形后的 RGB 数据(Float32 3ch),
// 特征太少 / 匹配太差 / 差距太大 → 返回 null, 由调用方保持原样只做校色(绝不强扭)。
// 基于模板匹配的轻量多尺度对位, 纯 JS, 不用 SIFT。策略: 密集网格采样 → 按块梯度排序取最可靠的 N 个
// → 每块去对侧缩略图唯一性匹配 → RANSAC 滤误配 → 单应变形。
function _alignWarpBack(src, dst, crop, w, h, log) {
  function _L(msg) { if (log) { try { log(msg); } catch (_) {} } }
  try {
    var step = Math.max(2, Math.round(Math.min(w, h) / 240));   // 处理尺寸控制(240 左右采样密度)
    var sw = Math.floor(w / step), sh = Math.floor(h / step);
    _L('[对齐] 尺寸 ' + w + 'x' + h + ' → 小图 ' + sw + 'x' + sh + ' (step=' + step + ')');
    if (sw < 8 || sh < 8) { _L('[对齐] 图太小放弃'); return null; }

    // 缩小的灰度图, 用于特征匹配
    var sg = _grayDownsample(src.data, src.width, src.height, step, sw, sh);
    var dg = _grayDownsample(dst.data, dst.width, dst.height, step, sw, sh);

    // ---------- 1. 内容区网格采样 ----------
    var cl = 0, ct = 0, cr = sw, cb = sh;
    if (crop) {
      cl = Math.max(0, Math.round(crop.left / step));
      ct = Math.max(0, Math.round(crop.top / step));
      cr = Math.min(sw, Math.round((crop.left + crop.width) / step));
      cb = Math.min(sh, Math.round((crop.top + crop.height) / step));
    }
    var patch = Math.max(10, Math.min(24, Math.round(Math.min(sw, sh) / 8)));
    var gx = Math.max(6, Math.min(12, Math.round((cr - cl) / (patch * 1.2))));
    var gy = Math.max(6, Math.min(12, Math.round((cb - ct) / (patch * 1.2))));
    var cells = [];
    for (var ci = 0; ci < gx; ci++) for (var cj = 0; cj < gy; cj++) {
      var cxc = Math.round(cl + (cr - cl) * (ci + 0.5) / gx);
      var cyc = Math.round(ct + (cb - ct) * (cj + 0.5) / gy);
      var px = Math.round(cxc - patch / 2), py = Math.round(cyc - patch / 2);
      if (px < 0 || py < 0 || px + patch > sw || py + patch > sh) continue;
      var grader = _patchGradient(sg, sw, sh, px, py, patch);
      cells.push({ x: cxc, y: cyc, px: px, py: py, grad: grader });
    }
    _L('[对齐] 网格 ' + gx + 'x' + gy + ', 有效块 ' + cells.length + ', patch=' + patch);
    if (cells.length < 6) { _L('[对齐] 块太少放弃'); return null; }

    // ---------- 2. 按梯度排序, 取最可靠的 N 个块 ----------
    cells.sort(function(a, b) { return b.grad - a.grad; });   // 梯度高的在前
    var MAX_CAND = 40;   // 多取一些块: 真实照片低梯度, 可靠点本就少, 靠数量凑够
    var selected = cells.slice(0, Math.min(MAX_CAND, cells.length));
    if (selected.length < 4) { _L('[对齐] 候选不足4放弃'); return null; }

    // ---------- 3. 每块去对侧缩略图唯一性匹配(双向验证) ----------
    var srcPts = [], dstPts = [];
    var radius = Math.round(Math.min(sw, sh) * 0.30);   // 搜索半径(小图)≈原图30%, 覆盖常见位移
    var statScoreOk = 0, statUnique = 0, statBidi = 0;
    for (var si = 0; si < selected.length; si++) {
      var cell = selected[si];
      var m = _templateMatch(dg, sg, sw, sh, cell.px, cell.py, patch, Math.round(radius));
      if (!m) continue;
      var distinct = m.score > 0.5 ? (m.second - m.score) / m.score : 1;   // score接近0视为唯一, 避免除零
      if (m.score > 40) continue;          // 绝对差太大 → 匹配不可信
      statScoreOk++;
      if (!(distinct > 0.10)) continue;    // 次佳和最佳太接近 → 匹配不唯一, 弃
      statUnique++;
      var rev = _templateMatch(sg, dg, sw, sh, m.x, m.y, patch, Math.round(radius));
      if (!rev) continue;
      var revDist = Math.abs(rev.x - cell.px) + Math.abs(rev.y - cell.py);
      if (revDist > patch * 0.8) continue;   // 反向没回到原块 → 错配, 弃
      statBidi++;
      var tx = m.x + patch / 2, ty = m.y + patch / 2;
      srcPts.push({ x: cell.x * step, y: cell.y * step });
      dstPts.push({ x: tx * step, y: ty * step });
    }
    _L('[对齐] 匹配: 分数通过 ' + statScoreOk + ', 唯一性 +' + statUnique + ', 双向验证 +' + statBidi + ' → 保留 ' + srcPts.length + ' 点');
    if (srcPts.length < 4) { _L('[对齐] 匹配点不足4放弃'); return null; }

    // ---------- 4. RANSAC 估单应(整体位移/缩放/轻微拉伸) ----------
    var H = _homographyRansac(srcPts, dstPts, 1500, 4.0);
    if (!H) { _L('[对齐] RANSAC 没找到可靠变换 → 放弃(内容可能重绘过大, 宁可不动)'); return null; }

    // ---------- 5. 用单应矩阵对回图做逆变换采样 → 变形到原图位置 ----------
    var out = _warpImage(src, H, w, h);
    // 输出变换参数, 便于判断"成功却没变化"是否为恒等变换(未真正位移)
    try {
      var _scaleHint = Math.sqrt((H[0] * H[0] + H[1] * H[1]) + (H[3] * H[3] + H[4] * H[4]));
      _L(out ? ('[对齐] 成功! 已变形 (仿射: 缩放≈' + _scaleHint.toFixed(3) + ', 平移x=' + H[2].toFixed(1) + ' y=' + H[5].toFixed(1) + ')') : '[对齐] 变形采样失败');
    } catch (eHint) { _L(out ? '[对齐] 成功! 已变形' : '[对齐] 变形采样失败'); }
    return out;
  } catch (eA) {
    _L('[对齐] 异常: ' + ((eA && eA.message) || eA));
    return null;
  }
}

// 模板匹配: 在搜索半径内找 patch 使误差最小。返回 {x, y, score, second}(x/y 为匹配块左上角)。
// score = 模板块与候选块的平均绝对差(越小越像); second = 次佳分数, 用于唯一性校验。
function _templateMatch(host, tmpl, sw, sh, px, py, patch, radius) {
  var best = null, second = Infinity, bestScore = Infinity;
  var x0 = Math.max(0, px - radius), x1 = Math.min(sw - patch, px + radius);
  var y0 = Math.max(0, py - radius), y1 = Math.min(sh - patch, py + radius);
  if (x1 < x0 || y1 < y0) return null;
  for (var y = y0; y <= y1; y++) {
    for (var x = x0; x <= x1; x++) {
      var sum = 0;
      for (var dy = 0; dy < patch; dy++) {
        var rowBase = (y + dy) * sw;
        var tRowBase = (py + dy) * sw;
        for (var dx = 0; dx < patch; dx++) {
          sum += Math.abs(tmpl[tRowBase + px + dx] - host[rowBase + x + dx]);
        }
      }
      var score = (sum / (patch * patch));   // 平均绝对差
      if (score < bestScore) {
        second = bestScore;
        bestScore = score;
        best = { x: x, y: y, score: score, second: second };
      } else if (score < second) {
        second = score;
      }
    }
  }
  return best;
}

// RANSAC 估单应矩阵: 从 src(回图)→dst(原图) 的点对里, 随机采样4对解出 H, 统计内点, 取内点最多的。
// 返回 3x3 数组 H 或 null。
function _homographyRansac(srcPts, dstPts, iters, threshold) {
  var n = srcPts.length;
  if (n < 4) return null;
  var bestH = null, bestInliers = 0;
  for (var it = 0; it < iters; it++) {
    // 随机取 4 个不重复点
    var idx = [], used = {};
    while (idx.length < 4) {
      var r = Math.floor(Math.random() * n);
      if (!used[r]) { used[r] = true; idx.push(r); }
    }
    var H = _solveAffineFrom4(srcPts, dstPts, idx);
    if (!H) continue;
    // 统计内点(投影误差 < threshold)
    var inl = 0;
    for (var i = 0; i < n; i++) {
      var q = _applyHomography(H, srcPts[i].x, srcPts[i].y);
      var dx = q.x - dstPts[i].x, dy = q.y - dstPts[i].y;
      if (dx * dx + dy * dy < threshold * threshold) inl++;
    }
    if (inl > bestInliers) { bestInliers = inl; bestH = H; }
  }
  // 内点占得太少 → 匹配可疑, 放弃对齐(宁可不动也不强扭)。真实图重绘导致部分点错配,
  // 用"绝对内点数≥5 且 占比≥0.35"双门槛: 既允许低比例(重绘场景), 又要有足够多共识点。
  if (!bestH || bestInliers < 5 || bestInliers < n * 0.35) return null;
  // 一致性检查: 变换后整体位移不能太夸张(超过图片 1/3 视为误配, 可能毁了画面)
  var cx = 0, cy = 0;
  for (var i2 = 0; i2 < n; i2++) {
    var q2 = _applyHomography(bestH, srcPts[i2].x, srcPts[i2].y);
    cx += q2.x - dstPts[i2].x; cy += q2.y - dstPts[i2].y;
  }
  cx /= n; cy /= n;
  if (Math.abs(cx) > threshold * 25 || Math.abs(cy) > threshold * 25) return null;   // 平均位移异常, 疑误配
  return bestH;
}

function _applyHomography(H, x, y) {
  var d = H[6] * x + H[7] * y + H[8];
  d = d === 0 ? 1e-6 : d;
  return {
    x: (H[0] * x + H[1] * y + H[2]) / d,
    y: (H[3] * x + H[4] * y + H[5]) / d
  };
}

// 从 4 个点对解 仿射矩阵(src→dst): x' = a0*x + a1*y + a2; y' = a3*x + a4*y + a5。
// 用最小二乘(4点)解 6 个未知数。这覆盖"整体位移 + 缩放 + 轻微旋转/剪切", 对轻度对位足够。
function _solveAffineFrom4(srcPts, dstPts, idx) {
  // x 方向: phi(x,y) = [x, y, 1], 目标 qx。正规方程: sum(phi^T phi) a = sum(phi^T qx)
  // 对 x 和 y 两套独立解, 共用同样的 S = sum(phi^T phi)(3x3)。
  var S = [0, 0, 0, 0, 0, 0, 0, 0, 0];   // 3x3
  var bx = [0, 0, 0], by = [0, 0, 0];
  for (var k = 0; k < idx.length; k++) {
    var p = srcPts[idx[k]], q = dstPts[idx[k]];
    var phi = [p.x, p.y, 1];
    for (var i = 0; i < 3; i++) {
      for (var j = 0; j < 3; j++) S[i * 3 + j] += phi[i] * phi[j];
      bx[i] += phi[i] * q.x;
      by[i] += phi[i] * q.y;
    }
  }
  var ax = _solve3x3(S, bx);
  var ay = _solve3x3(S, by);
  if (!ax || !ay) return null;
  return [ax[0], ax[1], ax[2], ay[0], ay[1], ay[2], 0, 0, 1];
}

function _solve3x3(A, b) {
  var det = A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
  if (Math.abs(det) < 1e-9) return null;
  var ai = [
    (A[4] * A[8] - A[5] * A[7]) / det,
    (A[2] * A[7] - A[1] * A[8]) / det,
    (A[1] * A[5] - A[2] * A[4]) / det,
    (A[5] * A[6] - A[3] * A[8]) / det,
    (A[0] * A[8] - A[2] * A[6]) / det,
    (A[2] * A[3] - A[0] * A[5]) / det,
    (A[3] * A[7] - A[4] * A[6]) / det,
    (A[1] * A[6] - A[0] * A[7]) / det,
    (A[0] * A[4] - A[1] * A[3]) / det
  ];
  return [ai[0] * b[0] + ai[1] * b[1] + ai[2] * b[2],
          ai[3] * b[0] + ai[4] * b[1] + ai[5] * b[2],
          ai[6] * b[0] + ai[7] * b[1] + ai[8] * b[2]];
}

// 用单应矩阵 H 逆变换回图 src → w x h 的目标画布。返回 Uint8ClampedArray(RGBA) 或 null。
// 边界 clamp(不用透明): 变形采样越界处取最近边界像素, 避免贴回后出现透明边/黑边。
function _warpImage(src, H, w, h) {
  try {
    var out = new Uint8ClampedArray(w * h * 4);
    // 计算逆矩阵(用伴随/克莱姆法则 3x3)
    var inv = _invert3x3(H);
    if (!inv) return null;
    var srcD = src.data;
    var maxX = src.width - 1, maxY = src.height - 1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var q = _applyHomography(inv, x, y);
        var sx = Math.round(q.x), sy = Math.round(q.y);
        // 越界 clamp 到边界(不是透明), 防止贴回后透底
        if (sx < 0) sx = 0; else if (sx > maxX) sx = maxX;
        if (sy < 0) sy = 0; else if (sy > maxY) sy = maxY;
        var sp = (sy * src.width + sx) * 4;
        var dp = (y * w + x) * 4;
        out[dp] = srcD[sp]; out[dp + 1] = srcD[sp + 1]; out[dp + 2] = srcD[sp + 2]; out[dp + 3] = 255;
      }
    }
    return out;
  } catch (eW) { return null; }
}

function _invert3x3(m) {
  var det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (Math.abs(det) < 1e-9) return null;
  var inv = [
    (m[4] * m[8] - m[5] * m[7]) / det,
    (m[2] * m[7] - m[1] * m[8]) / det,
    (m[1] * m[5] - m[2] * m[4]) / det,
    (m[5] * m[6] - m[3] * m[8]) / det,
    (m[0] * m[8] - m[2] * m[6]) / det,
    (m[2] * m[3] - m[0] * m[5]) / det,
    (m[3] * m[7] - m[4] * m[6]) / det,
    (m[1] * m[6] - m[0] * m[7]) / det,
    (m[0] * m[4] - m[1] * m[3]) / det
  ];
  return inv;
}

// ---------- 主流程 ----------
function _compute(msg) {
  var jobId = msg.jobId;
  var alignOnly = msg.align === 'only';   // 只对齐: 不碰颜色
  var align = alignOnly || !!msg.align;   // 任何对齐(对齐+校色 或 只对齐)
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

    // cropRect 是归一化比例(0~1), 换算成当前图幅(w×h)的像素矩形。原图/回图都缩放到了 w×h, 所以共用一份。
    // 校色只在内容区做, 白边区不进统计、不保留 —— 修"扩1:1后校色被白边洗白"的 bug。
    var crop = null;
    if (msg.cropRect) {
      crop = {
        left: msg.cropRect.left * w,
        top: msg.cropRect.top * h,
        width: msg.cropRect.width * w,
        height: msg.cropRect.height * h
      };
    }

    // 几何对位: 在内容区内找特征点估算单应矩阵, 把回图变形贴回原图位置。
    // 特征太少或误差太大(如 AI 无中生有大改) → 原样保留, 只走校色, 绝不强扭。
    var srce = { data: outID.data, width: w, height: h };
    var dstc = { data: inID.data, width: w, height: h };
    // 对齐诊断收集: _alignWarpBack 的 log 回调把每步状态写进 _diag, 随结果回传 host 打日志
    var _diag = [];
    var _dlog = function(msg) { _diag.push(msg); };
    if (msg.align === 'only') {
      // 「只对齐」: 只做几何对位, 颜色不动(校色是独立步骤, 之后可再跑)。
      var warpedOnly = _alignWarpBack(srce, dstc, crop, w, h, _dlog);
      if (warpedOnly) outID.data.set(warpedOnly);
      // 不校色, 直接输出对位后的回图
    } else if (align) {
      var warped = _alignWarpBack(srce, dstc, crop, w, h, _dlog);
      if (warped) {
        // 用变形后的回图替换 outID.data, 再做颜色校色
        outID.data.set(warped);
      }
      if (msg.method === 'reinhard') _reinhardRect(outID.data, inID.data, w, h, crop);
      else _waveletRect(outID.data, inID.data, w, h, crop);
    } else {
      if (msg.method === 'reinhard') _reinhardRect(outID.data, inID.data, w, h, crop);
      else _waveletRect(outID.data, inID.data, w, h, crop);
    }

    cx.putImageData(outID, 0, 0);
    var dataUrl = cv.toDataURL('image/png');
    var b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    TileAPI.sendToHost('colormatchResult', { jobId: jobId, ok: true, base64: b64, diag: _diag });
  }).catch(function(err) {
    TileAPI.sendToHost('colormatchResult', { jobId: jobId, ok: false, error: (err && err.message) || String(err), diag: _diag });
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
