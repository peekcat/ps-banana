// ============================================================
//  tile-netdoctor.js — 网络体检磁贴 (2026-07-11)
//  一键分层体检: 公网基准 → DNS对照 → 目标服务 → 双栈对照,
//  结论大白话, 报告面板内直读+一键复制发客服。
//  主体逻辑在宿主端 tile-netdoctor.host.js(与真实出图请求同网络栈, 结果才可信);
//  本磁贴出 UI + webview 浏览器栈对照探测。
// ============================================================
(function() {
'use strict';

var _busy = false;
var _lastReport = '';   // 最近一次报告(会话内)
var _lastVerdict = '';
var _lastTime = 0;
var _activeContainer = null;

function _esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// webview(浏览器栈)对照探测: no-cors 只测通断 — 与宿主(PS网络栈)结果对照,
// 「浏览器通/PS断」= 代理或防火墙单独劫持了 PS
function _webviewProbe() {
  return new Promise(function(resolve) {
    var t0 = Date.now();
    var ctrl = new AbortController();
    var timer = setTimeout(function() { try { ctrl.abort(); } catch (e) {} }, 6000);
    fetch('https://www.baidu.com/favicon.ico', { mode: 'no-cors', cache: 'no-cache', signal: ctrl.signal })
      .then(function() { clearTimeout(timer); resolve({ ok: true, detail: (Date.now() - t0) + 'ms' }); })
      .catch(function(e) { clearTimeout(timer); resolve({ ok: false, detail: String((e && e.message) || e).slice(0, 60) }); });
  });
}

function _timeAgo(ts) {
  if (!ts) return '';
  var d = Date.now() - ts;
  if (d < 60000) return Math.floor(d / 1000) + ' 秒前';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  return Math.floor(d / 3600000) + ' 小时前';
}

function _renderPanel(container) {
  _activeContainer = container;
  container.innerHTML =
    '<div class="w10-panel nd-panel">' +
      '<div class="w10-section-title">🩺 网络体检</div>' +
      '<div class="w10-row-desc nd-desc">出图连不上、报网络错误时点下面按钮:\n约 10 秒定位断在哪一层(整机断网 / DNS 被劫持 / 某家服务挂了 /\nPS 被代理单独拦截), 结论大白话, 报告可直接发客服。</div>' +
      '<div class="nd-actions">' +
        '<button class="w10-btn w10-btn-accent" id="ndRunBtn"' + (_busy ? ' disabled' : '') + '>' + (_busy ? '体检中…(约10秒)' : '▶ 开始体检') + '</button>' +
        (_lastReport ? '<button class="w10-btn" id="ndCopyBtn">📋 复制报告</button>' : '') +
      '</div>' +
      (_lastVerdict
        ? '<div class="nd-verdict' + (_lastVerdict.indexOf('健康') !== -1 ? ' nd-ok' : ' nd-warn') + '">🩺 ' + _esc(_lastVerdict) + '<div class="nd-time">' + _timeAgo(_lastTime) + '</div></div>'
        : '') +
      (_lastReport
        ? '<pre class="nd-report">' + _esc(_lastReport) + '</pre>'
        : '<div class="nd-empty">还没体检过 — 网络正常时也可以先跑一次留个"健康基线"</div>') +
    '</div>';

  var run = container.querySelector('#ndRunBtn');
  if (run) run.addEventListener('click', function() {
    if (_busy) return;
    _busy = true;
    _renderPanel(container);
    _webviewProbe().then(function(wv) {
      TileAPI.sendToHost('netDiagnose', { webviewProbe: wv });
    });
    // 兜底解锁(正常结果回来会先解)
    setTimeout(function() {
      if (_busy) { _busy = false; if (_activeContainer) _renderPanel(_activeContainer); }
    }, 30000);
  });
  var copy = container.querySelector('#ndCopyBtn');
  if (copy) copy.addEventListener('click', function() {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(_lastReport).then(function() { TileAPI.toast('报告已复制, 可直接粘给客服', 'success'); })
        .catch(function() { TileAPI.toast('复制失败, 请手动框选报告文字复制', 'warn'); });
    } else {
      TileAPI.toast('请手动框选报告文字复制', 'info');
    }
  });
}

TileAPI.registerTile({
  id: 'netdoctor',
  group: 'main',
  icon: '🩺',
  label: '网络体检',
  desc: '一键定位网络故障',
  live: false,
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 6 },

  renderFront: function(container, w) {
    var stateTxt = _busy ? '体检中…' : (_lastVerdict ? (_lastVerdict.indexOf('健康') !== -1 ? '上次: 健康 ✓' : '上次: 有异常 ⚠') : '');
    if (w >= 2) {
      container.innerHTML = '<div class="tile-icon">🩺</div><div class="tile-label">网络体检</div><div class="tile-desc">' + (stateTxt || '一键定位网络故障') + '</div>';
    } else {
      container.innerHTML = '<div class="tile-icon">🩺</div><div class="tile-label">' + (_busy ? '体检中' : '网络体检') + '</div>';
    }
  },

  onExpand: function(container) {
    _renderPanel(container);
    return function() { _activeContainer = null; };
  },

  onMessage: function(action, data) {
    if (action === 'netDiagnoseResult' && data) {
      _busy = false;
      _lastReport = data.report || '';
      _lastVerdict = data.verdict || '';
      _lastTime = Date.now();
      if (_activeContainer) _renderPanel(_activeContainer);
      TileAPI.toast('网络体检完成', _lastVerdict.indexOf('健康') !== -1 ? 'success' : 'warn');
    }
  }
});

})();
