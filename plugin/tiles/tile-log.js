(function() {
'use strict';

// ============================================================
//  tile-log.js —— 实时日志磁贴
//  监听 TileAPI.on('log') 和后端 onHostMessage('log'),500 条环形缓冲
// ============================================================

var MAX_LOG_ENTRIES = 500;
var LOG_BUFFER = [];          // [{time, message, type}, ...]
var LOG_UNREAD = 0;           // 未读计数(1x1 面前显示)
var LOG_DEDUP_LAST = null;    // 连续相同消息折叠

// 所有展开中的日志容器(支持多处同时打开同步刷新)
var _liveContainers = [];

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _fmtTime(t) {
  var d = new Date(t);
  var h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function _pushEntry(message, type) {
  type = type || 'info';
  var text = String(message == null ? '' : message);

  // 折叠连续相同消息
  var last = LOG_BUFFER[LOG_BUFFER.length - 1];
  if (last && last.message === text && last.type === type) {
    last.count = (last.count || 1) + 1;
    last.time = Date.now();
    _liveContainers.forEach(function(c) { _updateLastEntry(c, last); });
    return;
  }

  var entry = { time: Date.now(), message: text, type: type, count: 1 };
  LOG_BUFFER.push(entry);
  if (LOG_BUFFER.length > MAX_LOG_ENTRIES) LOG_BUFFER.shift();

  LOG_UNREAD++;
  _refreshFront();
  _liveContainers.forEach(function(c) { _appendEntry(c, entry); });
}

function _appendEntry(container, entry) {
  var list = container.querySelector('#logList');
  if (!list) return;
  var filterType = container._logFilter || '';
  if (filterType && filterType !== entry.type) return;
  var filterText = (container._logSearch || '').toLowerCase();
  if (filterText && entry.message.toLowerCase().indexOf(filterText) < 0) return;

  var nearBottom = (list.scrollHeight - list.scrollTop - list.clientHeight) < 30;

  var el = document.createElement('div');
  el.className = 'log-entry log-' + entry.type;
  el.dataset.idx = LOG_BUFFER.length - 1;
  el.innerHTML =
    '<span class="log-time">[' + _fmtTime(entry.time) + ']</span>' +
    '<span class="log-msg">' + _esc(entry.message) + '</span>' +
    (entry.count > 1 ? ('<span class="log-count">\u00d7' + entry.count + '</span>') : '');
  list.appendChild(el);

  // 限制 DOM 条数(不超过 MAX)
  while (list.childNodes.length > MAX_LOG_ENTRIES) list.removeChild(list.firstChild);

  if (nearBottom) list.scrollTop = list.scrollHeight;
  _updateCounter(container);
}

function _updateLastEntry(container, entry) {
  var list = container.querySelector('#logList');
  if (!list) return;
  var last = list.lastChild;
  if (!last) return;
  var countEl = last.querySelector('.log-count');
  if (!countEl) {
    countEl = document.createElement('span');
    countEl.className = 'log-count';
    last.appendChild(countEl);
  }
  countEl.textContent = '\u00d7' + entry.count;
  var timeEl = last.querySelector('.log-time');
  if (timeEl) timeEl.textContent = '[' + _fmtTime(entry.time) + ']';
  _updateCounter(container);
}

function _renderAllEntries(container) {
  var list = container.querySelector('#logList');
  if (!list) return;
  list.innerHTML = '';
  var filterType = container._logFilter || '';
  var filterText = (container._logSearch || '').toLowerCase();

  LOG_BUFFER.forEach(function(entry) {
    if (filterType && filterType !== entry.type) return;
    if (filterText && entry.message.toLowerCase().indexOf(filterText) < 0) return;
    var el = document.createElement('div');
    el.className = 'log-entry log-' + entry.type;
    el.innerHTML =
      '<span class="log-time">[' + _fmtTime(entry.time) + ']</span>' +
      '<span class="log-msg">' + _esc(entry.message) + '</span>' +
      (entry.count > 1 ? ('<span class="log-count">\u00d7' + entry.count + '</span>') : '');
    list.appendChild(el);
  });
  list.scrollTop = list.scrollHeight;
  // 容器刚 render 完, scrollHeight 可能还没算定 (font/icon 还在 layout),
  // 下一帧再兜底滚一次, 保证打开就看到最新一条
  requestAnimationFrame(function() {
    list.scrollTop = list.scrollHeight;
  });
  _updateCounter(container);
}

function _updateCounter(container) {
  var counterEl = container.querySelector('#logCounter');
  if (counterEl) counterEl.textContent = LOG_BUFFER.length + ' 条';
}

function _clearBuffer() {
  LOG_BUFFER.length = 0;
  LOG_UNREAD = 0;
  LOG_DEDUP_LAST = null;
  _liveContainers.forEach(function(c) {
    var list = c.querySelector('#logList');
    if (list) list.innerHTML = '';
    _updateCounter(c);
  });
  _refreshFront();
}

function _refreshFront() {
  var el = (typeof TileEngine !== 'undefined' && TileEngine.getTileElement)
    ? TileEngine.getTileElement('log') : null;
  if (!el) return;
  var inner = el.querySelector('.tile-inner') || el.querySelector('.tile-flip-front');
  if (inner) renderFront(inner, +el.dataset.w || 1, +el.dataset.h || 1);
}

// ========== 磁贴注册 ==========

function renderFront(container, w, h) {
  var lastEntry = LOG_BUFFER[LOG_BUFFER.length - 1];
  var lastMsg = lastEntry ? _truncate(lastEntry.message, 24) : '等待日志…';
  var badge = LOG_UNREAD > 0 ? ('<span class="log-tile-badge">' + (LOG_UNREAD > 99 ? '99+' : LOG_UNREAD) + '</span>') : '';
  if (w >= 2) {
    container.innerHTML =
      '<div class="tile-icon">\uD83D\uDCDD</div>' +
      '<div class="tile-label">日志' + badge + '</div>' +
      '<div class="tile-desc" style="max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + _esc(lastMsg) + '</div>';
  } else {
    container.innerHTML =
      '<div class="tile-icon">\uD83D\uDCDD</div>' +
      '<div class="tile-label">日志' + badge + '</div>';
  }
}

function _truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.substr(0, n) + '…' : s;
}

TileAPI.registerTile({
  id: 'log',
  group: 'main',
  icon: '\uD83D\uDCDD',
  label: '日志',
  desc: '运行日志',
  live: true,               // 磁贴正面会随最新日志实时更新
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderFront: renderFront,

  renderBack: function(container) {
    container.textContent = '共 ' + LOG_BUFFER.length + ' 条';
  },

  onExpand: function(container, sizeHint) {
    var layout = (sizeHint && sizeHint.layout) || 'wide';
    _renderPanel(container, layout);

    // 清零未读(面板打开后就算已读)
    LOG_UNREAD = 0;
    _refreshFront();

    // 注册到 live 容器列表,以便实时追加
    _liveContainers.push(container);

    // 返回清理函数
    return function() {
      var idx = _liveContainers.indexOf(container);
      if (idx >= 0) _liveContainers.splice(idx, 1);
    };
  },

  onResize: function(w, h) {
    _refreshFront();
  }
});

// ========== 面板渲染 ==========

function _renderPanel(container, layout) {
  container._logFilter = '';
  container._logSearch = '';

  container.innerHTML =
    '<div class="w10-panel log-panel">' +
      '<div class="log-toolbar">' +
        '<div class="log-filter-group">' +
          '<button class="w10-btn log-filter-btn w10-btn-accent" data-filter="">全部</button>' +
          '<button class="w10-btn log-filter-btn" data-filter="info">信息</button>' +
          '<button class="w10-btn log-filter-btn" data-filter="success">成功</button>' +
          '<button class="w10-btn log-filter-btn" data-filter="warn">警告</button>' +
          '<button class="w10-btn log-filter-btn" data-filter="error">错误</button>' +
        '</div>' +
        '<div class="log-toolbar-right">' +
          '<input class="w10-input log-search" id="logSearch" placeholder="搜索…" />' +
          '<button class="w10-btn log-clear-btn" id="logClear">清空</button>' +
        '</div>' +
      '</div>' +
      '<div class="log-meta"><span id="logCounter">0 条</span><span class="log-meta-hint">最多保留 ' + MAX_LOG_ENTRIES + ' 条</span></div>' +
      '<div id="logList" class="log-list"></div>' +
    '</div>';

  _renderAllEntries(container);

  // 过滤按钮
  container.querySelectorAll('.log-filter-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      container._logFilter = btn.dataset.filter || '';
      container.querySelectorAll('.log-filter-btn').forEach(function(b) { b.classList.remove('w10-btn-accent'); });
      btn.classList.add('w10-btn-accent');
      _renderAllEntries(container);
    });
  });

  // 搜索(防抖 200ms)
  var searchInput = container.querySelector('#logSearch');
  var searchTimer = null;
  if (searchInput) searchInput.addEventListener('input', function() {
    var val = this.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function() {
      container._logSearch = val;
      _renderAllEntries(container);
    }, 200);
  });

  // 清空
  var clearBtn = container.querySelector('#logClear');
  if (clearBtn) clearBtn.addEventListener('click', function() {
    TileAPI.confirm('确定清空所有日志?').then(function(ok) {
      if (ok) _clearBuffer();
    });
  });
}

// ========== 日志源监听 ==========

// 前端 TileAPI.log 会 emit 'log' 事件
TileAPI.on('log', function(data) {
  if (!data) return;
  _pushEntry(data.message || data.msg || '', data.type);
});

// 后端通过 sendToPanel('log', {message, type}) 发来的日志
// app.js 会转发给所有磁贴的 onMessage,但我们直接监听 host 消息更稳
TileAPI.onHostMessage('log', function(data) {
  if (!data) return;
  _pushEntry(data.message || data.msg || '', data.type);
});

// 启动时补一条"日志系统就绪"
setTimeout(function() { _pushEntry('日志系统就绪', 'success'); }, 0);

})();
