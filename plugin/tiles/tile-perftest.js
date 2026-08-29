// ============================================================
//  tile-perftest.js — 回图性能测试(开发工具, 前端)
//
//  流程: ① 框选区点"抓取" ② 选方式(A/B/C)与张数 ③ 点"开跑"
//        前端把抓到的图打上大号编号(1,2,3...), 逐张发 host 贴回,
//        每张记录 host 端置入耗时, 面板出成绩单。
//  A=现行链路(智能对象)  B=精简placeEvent(智能对象)  C=putPixels直写像素(非智能对象)
//  编号画在图中央, 看错位一眼便知; 耗时对比看卡顿来源。
// ============================================================
(function() {
'use strict';

var _cap = null;          // { base64, selection, docId }
var _running = false;
var _results = [];        // [{idx, method, ms, ok, error}]
var _queue = [];
var _activeContainer = null;
var _startTs = 0;
var _tickTimer = null;   // 实时秒表(100ms 刷新)

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 给 base64 图打编号: canvas 画原图 + 中央大号数字 + 角落方式标
// 输出 { png: base64(PNG, 给A/B用), raw: base64(RGBA字节, 给C用), w, h }
function _stampNumber(base64, num, method, cb) {
  var img = new Image();
  img.onload = function() {
    try {
      var w = img.naturalWidth, h = img.naturalHeight;
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      // 中央大数字(高度的 40%), 白字黑描边, 任何底图都看得清
      var fontPx = Math.max(24, Math.round(h * 0.4));
      ctx.font = 'bold ' + fontPx + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(2, Math.round(fontPx / 12));
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.strokeText(String(num), w / 2, h / 2);
      ctx.fillText(String(num), w / 2, h / 2);
      // 左上角方式标(高度 10%)
      var tagPx = Math.max(12, Math.round(h * 0.1));
      ctx.font = 'bold ' + tagPx + 'px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.strokeText(method, 8, 8);
      ctx.fillText(method, 8, 8);

      var png = canvas.toDataURL('image/png').split(',')[1];
      var raw = null;
      if (method === 'C') {
        // C 需要选区尺寸的 RGBA 原始字节(putPixels 不做缩放, 前端先缩到位)
        var sel = _cap.selection;
        var sw = Math.max(1, Math.round(sel.width)), sh = Math.max(1, Math.round(sel.height));
        var c2 = document.createElement('canvas');
        c2.width = sw; c2.height = sh;
        c2.getContext('2d').drawImage(canvas, 0, 0, sw, sh);
        var id = c2.getContext('2d').getImageData(0, 0, sw, sh);
        // Uint8ClampedArray → base64(分块避免栈溢出)
        var u8 = id.data;
        var bin = '';
        var CHUNK = 0x8000;
        for (var i = 0; i < u8.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CHUNK, u8.length)));
        }
        raw = { b64: btoa(bin), w: sw, h: sh };
      }
      cb({ png: png, raw: raw });
    } catch (e) { cb(null, e); }
  };
  img.onerror = function() { cb(null, new Error('图片解码失败')); };
  img.src = 'data:image/png;base64,' + base64;
}

function _log(line) {
  if (!_activeContainer) return;
  var el = _activeContainer.querySelector('#ptLog');
  if (!el) return;
  el.insertAdjacentHTML('beforeend', '<div>' + line + '</div>');
  el.scrollTop = el.scrollHeight;
}

function _startRun(container) {
  if (_running) { TileAPI.toast('正在测试中', 'info'); return; }
  if (!_cap) { TileAPI.toast('先框选区点「抓取选区」', 'error'); return; }
  var method = (container.querySelector('#ptMethod') || {}).value || 'A';
  var count = Math.max(1, Math.min(20, parseInt((container.querySelector('#ptCount') || {}).value, 10) || 3));
  _running = true;
  _results = [];
  _queue = [];
  for (var i = 1; i <= count; i++) _queue.push(i);
  _startTs = Date.now();
  _log('—— 开跑: 方式' + method + ' × ' + count + ' 张 ——');
  _startTicker(count);
  if (method === 'D') {
    // 批量: 先全部打号(前端准备不占PS时间), 再一次性发 host
    var images = [];
    var pending = count;
    var doGroup = !!(container.querySelector('#ptGroupTog') && container.querySelector('#ptGroupTog').classList.contains('on'));
    for (var di = 1; di <= count; di++) {
      (function(n) {
        _stampNumber(_cap.base64, n, 'D', function(out) {
          if (out) images.push({ idx: n, base64: out.png });
          pending--;
          if (pending === 0) {
            images.sort(function(a, b) { return a.idx - b.idx; });
            _log('打号完成, 一次性发送 ' + images.length + ' 张…');
            TileAPI.sendToHost('perftestPlaceBatch', {
              docId: _cap.docId, selection: _cap.selection,
              images: images, group: doGroup
            });
          }
        });
      })(di);
    }
    return;
  }
  _sendNext(method);
}

function _sendNext(method) {
  if (!_queue.length) { _finish(); return; }
  var idx = _queue.shift();
  _stampNumber(_cap.base64, idx, method, function(out, err) {
    if (!out) {
      _results.push({ idx: idx, method: method, ok: false, error: (err && err.message) || '打号失败' });
      _log('#' + idx + ' ✗ 打号失败');
      _sendNext(method);
      return;
    }
    var payload = {
      method: method, idx: idx,
      docId: _cap.docId, selection: _cap.selection,
      base64: out.png
    };
    if (method === 'C' && out.raw) {
      payload.rawB64 = out.raw.b64;
      payload.rawW = out.raw.w;
      payload.rawH = out.raw.h;
    }
    payload._method = method;   // 回包核对
    window.__ptWaiting = method;
    TileAPI.sendToHost('perftestPlace', payload);
    // 回包驱动下一张(见 onMessage)
  });
}

// 实时秒表: 跑动期间面板顶部显示 已用时 + 进度(第几张)
function _startTicker(total) {
  _stopTicker();
  var el = _activeContainer && _activeContainer.querySelector('#ptTimer');
  if (!el) return;
  el.style.display = '';
  _tickTimer = setInterval(function() {
    var el2 = _activeContainer && _activeContainer.querySelector('#ptTimer');
    if (!el2) { _stopTicker(); return; }
    var sec = (Date.now() - _startTs) / 1000;
    el2.textContent = '⏱ ' + sec.toFixed(1) + 's · ' + _results.length + '/' + total + ' 张';
  }, 100);
}
function _stopTicker() {
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}

function _finish() {
  _stopTicker();
  var elT = _activeContainer && _activeContainer.querySelector('#ptTimer');
  if (elT) elT.textContent = '⏱ 完成 · 全程 ' + ((Date.now() - _startTs) / 1000).toFixed(1) + 's';
  _running = false;
  var total = Date.now() - _startTs;
  var okList = _results.filter(function(r) { return r.ok; });
  var sum = 0;
  okList.forEach(function(r) { sum += r.ms; });
  var avg = okList.length ? Math.round(sum / okList.length) : 0;
  _log('—— 完成: 成功 ' + okList.length + '/' + _results.length +
    ' · 置入均值 <b>' + avg + 'ms/张</b> · 全程 ' + (total / 1000).toFixed(1) + 's ——');
  TileAPI.toast('测试完成: 均值 ' + avg + 'ms/张', 'success');
}

TileAPI.registerTile({
  id: 'perftest',
  group: 'main',
  icon: '⏱️',
  label: '回图测试',
  desc: '开发工具·置入速度对比',
  defaultSize: { w: 2, h: 2 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderBack: function(c) { c.textContent = '回图方式 A/B/C 对比'; },

  onExpand: function(container) {
    _activeContainer = container;
    container.innerHTML =
      '<div class="w10-panel">' +
        '<div class="w10-section-title">回图性能测试</div>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">第一步</div><div class="w10-row-desc">PS 里框好选区再点</div></div>' +
          '<div class="w10-row-right"><button class="w10-btn" id="ptCapBtn">📷 抓取选区</button></div>' +
        '</div>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">方式</div><div class="w10-row-desc">A=现行 B=精简置入 C=直写像素</div></div>' +
          '<div class="w10-row-right"><select class="w10-select" id="ptMethod">' +
            '<option value="A">A · 现行链路(智能对象)</option>' +
            '<option value="B">B · 精简placeEvent(智能对象)</option>' +
            '<option value="C">C · putPixels直写(普通图层)</option>' +
            '<option value="D">D · 批量单权限(智能对象)</option>' +
          '</select></div>' +
        '</div>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">张数</div><div class="w10-row-desc">每张打编号 1,2,3…</div></div>' +
          '<div class="w10-row-right"><input type="number" class="w10-input" id="ptCount" value="3" min="1" max="20" style="width:60px;text-align:center;"></div>' +
        '</div>' +
        '<div class="w10-row" id="ptGroupRow" style="display:none;">' +
          '<div class="w10-row-left"><div class="w10-row-label">顺带打组</div><div class="w10-row-desc">D专属: 同一次修改权内编组</div></div>' +
          '<div class="w10-row-right"><div class="w10-toggle on" id="ptGroupTog"></div></div>' +
        '</div>' +
        '<div class="w10-row" style="border-bottom:none;">' +
          '<button class="w10-btn w10-btn-accent" id="ptRunBtn" style="width:100%;">▶ 开跑</button>' +
        '</div>' +
        '<div id="ptTimer" style="display:none;text-align:center;font-size:13px;font-weight:600;color:var(--accent);padding:4px 0;font-variant-numeric:tabular-nums;"></div>' +
        '<div class="w10-section-title">成绩单</div>' +
        '<div id="ptLog" style="font-size:10px;line-height:1.8;max-height:220px;overflow-y:auto;color:var(--text-sub);user-select:text;"></div>' +
      '</div>';

    var capBtn = container.querySelector('#ptCapBtn');
    if (capBtn) capBtn.addEventListener('click', function() {
      capBtn.textContent = '抓取中…';
      TileAPI.sendToHost('perftestCapture', {});
    });
    var methodSel = container.querySelector('#ptMethod');
    if (methodSel) methodSel.addEventListener('change', function() {
      var gr = container.querySelector('#ptGroupRow');
      if (gr) gr.style.display = (this.value === 'D') ? '' : 'none';
    });
    var groupTog = container.querySelector('#ptGroupTog');
    if (groupTog) groupTog.addEventListener('click', function() { this.classList.toggle('on'); });
    var runBtn = container.querySelector('#ptRunBtn');
    if (runBtn) runBtn.addEventListener('click', function() { _startRun(container); });

    return function() { _stopTicker(); _activeContainer = null; };
  },

  onMessage: function(action, data) {
    if (action === 'perftestCaptureResult') {
      var capBtn = _activeContainer && _activeContainer.querySelector('#ptCapBtn');
      if (capBtn) capBtn.textContent = '📷 抓取选区';
      if (!data || !data.success) {
        TileAPI.toast('抓取失败: ' + ((data && data.error) || '?'), 'error');
        return;
      }
      _cap = { base64: data.base64, selection: data.selection, docId: data.docId };
      var s = data.selection;
      _log('✓ 已抓取: ' + Math.round(s.width) + '×' + Math.round(s.height) + ' @(' + Math.round(s.left) + ',' + Math.round(s.top) + ')');
      TileAPI.toast('选区已抓取', 'success');
      return;
    }
    if (action === 'perftestBatchDone') {
      if (data && data.success) {
        _log('批量置入总耗时(单次修改权内): <b>' + data.totalMs + 'ms</b> / ' + data.count + ' 张 = ' + Math.round(data.totalMs / Math.max(1, data.count)) + 'ms/张');
      } else {
        _log('✗ 批量失败: ' + _esc((data && data.error) || '?'));
      }
      _finish();
      return;
    }
    if (action === 'perftestPlaceResult') {
      if (!data) return;
      if (data.success) {
        _results.push({ idx: data.idx, method: data.method, ok: true, ms: data.ms });
        _log('#' + data.idx + ' [' + data.method + '] ✓ 置入 ' + data.ms + 'ms');
      } else {
        _results.push({ idx: data.idx, method: data.method, ok: false, error: data.error });
        _log('#' + data.idx + ' [' + data.method + '] ✗ ' + _esc(data.error || '失败'));
      }
      if (_running && data.method !== 'D') _sendNext(data.method);
    }
  }
});

})();
