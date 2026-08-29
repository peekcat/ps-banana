// ============================================================
//  tile-support.js — 在线客服磁贴
//  与 preset-server 的客服后台双向沟通(短轮询)
//  - 文本/图片/信息面板快照
//  - 折叠时 30s 后台轮询拿未读
//  - 展开时 3s 实时拉消息
// ============================================================
(function() {
'use strict';

var _serverConfig = window.WheelchairServerConfig;
var DEFAULT_SERVER = _serverConfig.OFFICIAL_BASE;
var POLL_FAST_MS = 3000;
var POLL_SLOW_MS = 30000;
var MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// ── 持久状态 ──
var _deviceId = '';
var _serverUrl = DEFAULT_SERVER;
var _lastSeenMsgId = 0;

// ── 运行时 ──
var _messages = [];
var _unread = 0;
var _pollTimer = null;
var _timeTickTimer = null;
var _pollFast = false;
var _activeContainer = null;
var _pendingImg = null;        // {base64, mime, name}
var _sending = false;
var _firstLoad = true;
var _historyLoaded = false;
var _bgPollPrimed = false;

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _genDeviceId() {
  var rnd;
  try { rnd = crypto.randomUUID().replace(/-/g, '').slice(0, 12); }
  catch(e) { rnd = Math.random().toString(36).slice(2, 14); }
  return 'device-' + rnd;
}

function _ensureDeviceId() {
  var id = TileAPI.storage.get('support.deviceId');
  if (!id || !/^[a-zA-Z0-9_-]{4,64}$/.test(id)) {
    id = _genDeviceId();
    TileAPI.storage.set('support.deviceId', id);
  }
  _deviceId = id;
}

function _api(path) { return _serverUrl.replace(/\/+$/, '') + path; }

// ── 登录态/令牌 ──
function _isLoggedIn() {
  return !!TileAPI.state.get('cloud.loggedIn') && !!TileAPI.storage.get('cloud.token');
}
function _authHeaders(extra) {
  var h = extra || {};
  var tok = TileAPI.storage.get('cloud.token');
  if (tok) h['Authorization'] = 'Bearer ' + tok;
  return h;
}
// 当前登录用户标识 (后台 admin 按这个查客服历史)
function _getUserId() {
  var u = TileAPI.storage.get('cloud.user') || {};
  return u.id || u.userId || u.uid || u.email || u.username || '';
}

// ── 拉取消息(轮询主入口) ──
function _pollOnce(silent) {
  if (!_deviceId) return Promise.resolve();
  // 未登录不轮询 (客服需登录, 401 也没意义)
  if (!_isLoggedIn()) return Promise.resolve();
  var uid = _getUserId();
  var url = _api('/api/support/poll?deviceId=' + encodeURIComponent(_deviceId) +
    (uid ? '&userId=' + encodeURIComponent(uid) : '') +
    '&since=' + _lastSeenMsgId);
  return _serverConfig.fetchApi(url.substring(_serverUrl.length), { headers: _authHeaders() })
    .then(function(r) {
      if (r.status === 401) { _onAuthLost(); throw new Error('未登录'); }
      return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status));
    })
    .then(function(d) {
      if (!d || !Array.isArray(d.messages)) return;
      var hadAdminNew = false;
      d.messages.forEach(function(m) {
        if (m.id <= _lastSeenMsgId) return;
        _messages.push(m);
        _lastSeenMsgId = m.id;
        if (m.from === 'admin') hadAdminNew = true;
      });
      TileAPI.storage.set('support.lastSeenMsgId', _lastSeenMsgId);

      // 同步未读数(服务端权威)
      var newUnread = d.userUnread || 0;
      if (newUnread !== _unread) {
        _unread = newUnread;
        TileAPI.state.set('support.unread', _unread);
        _refreshFront();
      }

      if (!silent && d.messages.length > 0 && _activeContainer) {
        _appendMessagesToDom(d.messages);
      }

      // 首次轮询不响铃,避免开机时一次性补播历史消息的声音
      if (hadAdminNew && !_firstLoad) _playNotify();
      _firstLoad = false;
    })
    .catch(function(err) {
      if (!silent && _firstLoad) {
        TileAPI.toast('客服服务连接失败: ' + (err && err.message || err), 'error');
      }
      // 失败不阻塞下一轮轮询
    });
}

// 登录失效兜底: 重置未读、停轮询、面板回到登录引导
function _onAuthLost() {
  _unread = 0;
  TileAPI.state.set('support.unread', 0);
  _refreshFront();
  if (_activeContainer) _renderPanel(_activeContainer);
}

function _startPolling(fast) {
  _stopPolling();
  _pollFast = !!fast;
  var interval = fast ? POLL_FAST_MS : POLL_SLOW_MS;
  _pollTimer = setInterval(function() { _pollOnce(!fast); }, interval);
}

function _stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function _playNotify() {
  var soundFile = TileAPI.storage.get('support.notifyFile') || '三七唐笑';
  if (soundFile === 'none') return;
  TileAPI.sendToHost('playSoundByName', { fileName: soundFile });
}

// ── 渲染正面 / 背面 ──
function _refreshFront() {
  if (typeof TileEngine === 'undefined' || !TileEngine.getTileElement) return;
  var el = TileEngine.getTileElement('support');
  if (!el) return;
  var inner = el.querySelector('.tile-inner') || el.querySelector('.tile-flip-front');
  if (inner) renderFront(inner, +el.dataset.w || 1, +el.dataset.h || 1);
  var back = el.querySelector('.tile-flip-back');
  if (back) renderBack(back);
}

function renderFront(container, w, h) {
  var badge = _unread > 0 ? '<span class="support-tile-badge">' + (_unread > 99 ? '99+' : _unread) + '</span>' : '';
  if (w >= 2) {
    container.innerHTML =
      '<div class="tile-icon">💬</div>' +
      '<div class="tile-label">在线客服' + badge + '</div>' +
      '<div class="tile-desc">联系作者反馈问题</div>';
  } else {
    container.innerHTML =
      '<div class="tile-icon">💬</div>' +
      '<div class="tile-label">客服' + badge + '</div>';
  }
}

function renderBack(container) {
  if (_unread > 0) {
    container.innerHTML = '<div class="support-tile-back-active">' + _unread + ' 条新回复</div>';
  } else {
    container.textContent = '暂无新消息';
  }
}

// ── 展开面板 ──
function _renderPanel(container) {
  // 未登录: 显示登录引导, 不渲染聊天 UI
  if (!_isLoggedIn()) {
    container.innerHTML =
      '<div class="support-panel">' +
        '<div class="support-header">' +
          '<span class="support-title">💬 在线客服</span>' +
        '</div>' +
        '<div class="support-empty" style="padding:24px;text-align:center;line-height:1.8">' +
          '🔐 客服功能需要 <b>登录</b> 后才能使用<br>' +
          '<span style="font-size:12px;color:var(--text-sub,#888)">这样作者才能在后台关联你的账号, 帮你查问题更快</span><br><br>' +
          '<button class="support-send-btn" id="supGotoLoginBtn">去登录</button>' +
        '</div>' +
      '</div>';
    var loginBtn = container.querySelector('#supGotoLoginBtn');
    if (loginBtn) {
      loginBtn.addEventListener('click', function() {
        // 跳到顶栏 (登录入口已整合在顶栏面板里, cloud 磁贴已不存在)
        if (TileAPI && typeof TileAPI.expandTile === 'function') {
          TileAPI.expandTile('topbar');
        } else {
          TileAPI.toast('请打开顶部账号面板登录', 'info');
        }
      });
    }
    return;
  }

  container.innerHTML =
    '<div class="support-panel">' +
      '<div class="support-header">' +
        '<span class="support-title">💬 在线客服</span>' +
        '<span class="support-id" title="设备ID(后台用此识别你)">#' + _esc(_deviceId.slice(-8)) + '</span>' +
        '<span class="support-spacer"></span>' +
        '<button class="support-cfg-btn" id="supCfgBtn" title="设置">⚙</button>' +
      '</div>' +
      '<div class="support-settings" id="supSettings" style="display:none">' +
        '<div class="support-set-row">' +
          '<label>新回复提示音</label>' +
          '<select class="support-set-input" id="supSoundSel"></select>' +
          '<button class="support-set-btn" id="supSoundTestBtn" title="试听">▶</button>' +
        '</div>' +
      '</div>' +
      '<div class="support-msg-list" id="supMsgList"></div>' +
      '<div class="support-img-preview" id="supImgPreview" style="display:none"></div>' +
      '<div class="support-input-row">' +
        '<button class="support-icon-btn" id="supBtnImg" title="发送图片">📎</button>' +
        '<button class="support-icon-btn" id="supBtnInfo" title="发送信息面板快照">ℹ️</button>' +
        '<input type="file" id="supFileInput" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">' +
        '<textarea class="support-textarea" id="supTextInput" placeholder="输入消息... (Enter发送，Shift+Enter换行，Ctrl+V 粘贴图片)"></textarea>' +
        '<button class="support-send-btn" id="supSendBtn">发送</button>' +
      '</div>' +
    '</div>';

  _bindPanelEvents(container);
  _renderAllMessages();
  _scrollToBottom();
  // 请求音效列表(异步,到货后填充下拉框)
  TileAPI.sendToHost('scanSoundFiles', {});
}

function _bindPanelEvents(container) {
  var cfgBtn = container.querySelector('#supCfgBtn');
  var btnImg = container.querySelector('#supBtnImg');
  var btnInfo = container.querySelector('#supBtnInfo');
  var fileInput = container.querySelector('#supFileInput');
  var textInput = container.querySelector('#supTextInput');
  var sendBtn = container.querySelector('#supSendBtn');
  var soundSel = container.querySelector('#supSoundSel');
  var soundTestBtn = container.querySelector('#supSoundTestBtn');

  cfgBtn.addEventListener('click', _toggleSettings);
  btnImg.addEventListener('click', function() { fileInput.click(); });
  btnInfo.addEventListener('click', _sendInfoSnapshot);
  fileInput.addEventListener('change', _onPickImage);
  textInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendText(); }
  });
  textInput.addEventListener('paste', _onPaste);
  sendBtn.addEventListener('click', _sendText);

  if (soundSel) soundSel.addEventListener('change', function() {
    var v = soundSel.value;
    TileAPI.storage.set('support.notifyFile', v);
    if (v && v !== 'none') {
      TileAPI.sendToHost('previewSound', { fileName: v });
    }
  });
  if (soundTestBtn) soundTestBtn.addEventListener('click', function() {
    var v = soundSel && soundSel.value;
    if (!v || v === 'none') { TileAPI.toast('已设为静音', 'info'); return; }
    TileAPI.sendToHost('previewSound', { fileName: v });
  });
}

function _toggleSettings() {
  if (!_activeContainer) return;
  var box = _activeContainer.querySelector('#supSettings');
  if (!box) return;
  box.style.display = (box.style.display === 'none' || !box.style.display) ? 'flex' : 'none';
}

function _populateSoundSelect(files) {
  if (!_activeContainer) return;
  var sel = _activeContainer.querySelector('#supSoundSel');
  if (!sel) return;
  var current = TileAPI.storage.get('support.notifyFile') || '三七唐笑';
  sel.innerHTML = '';
  var noneOpt = document.createElement('option');
  noneOpt.value = 'none';
  noneOpt.textContent = '静音';
  sel.appendChild(noneOpt);
  (files || []).forEach(function(f) {
    var opt = document.createElement('option');
    opt.value = f.name;
    opt.textContent = f.name + (f.source === 'custom' ? ' (自定义)' : '');
    sel.appendChild(opt);
  });
  sel.value = current;
  // 如果存的值不在列表里(文件被删了),回落到默认
  if (sel.value !== current) {
    sel.value = '三七唐笑';
    TileAPI.storage.set('support.notifyFile', '三七唐笑');
  }
}

// ── 加载历史 ──
function _loadHistory() {
  if (!_isLoggedIn()) {
    // 未登录: 不拉历史, 直接走登录引导界面 (renderPanel 已处理)
    _messages = [];
    _historyLoaded = false;
    return Promise.resolve();
  }
  // 用 since=0 拉全部 + markRead=1 清未读
  var url = _api('/api/support/poll?deviceId=' + encodeURIComponent(_deviceId) + '&since=0&markRead=1');
  return _serverConfig.fetchApi(url.substring(_serverUrl.length), { headers: _authHeaders() })
    .then(function(r) {
      if (r.status === 401) { _onAuthLost(); throw new Error('未登录'); }
      if (r.status === 403) {
        _stopPolling();
        TileAPI.toast('当前设备的客服会话已绑定其他账号', 'warn');
        throw new Error('Not your conversation');
      }
      return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status));
    })
    .then(function(d) {
      if (!d) return;
      _messages = (d.messages || []).slice();
      _lastSeenMsgId = d.lastMsgId || 0;
      TileAPI.storage.set('support.lastSeenMsgId', _lastSeenMsgId);
      _unread = 0;
      TileAPI.state.set('support.unread', 0);
      _historyLoaded = true;
      _renderAllMessages();
      _scrollToBottom();
      _refreshFront();
    })
    .catch(function(err) {
      var listEl = _activeContainer && _activeContainer.querySelector('#supMsgList');
      if (listEl) {
        listEl.innerHTML = '<div class="support-empty">连接服务器失败: ' + _esc(err.message || err) + '<br>点击右上角 ⚙ 检查服务器地址</div>';
      }
    });
}

// ── 渲染消息 ──
function _renderAllMessages() {
  var list = _activeContainer && _activeContainer.querySelector('#supMsgList');
  if (!list) return;
  if (_messages.length === 0) {
    list.innerHTML = '<div class="support-empty">还没有消息。在下方输入要反馈的内容，作者会尽快回复。</div>';
    return;
  }
  list.innerHTML = '';
  _messages.forEach(function(m) { _renderOneMessage(list, m); });
}

function _appendMessagesToDom(msgs) {
  var list = _activeContainer && _activeContainer.querySelector('#supMsgList');
  if (!list) return;
  // 第一次有消息时清空 empty 提示
  if (list.querySelector('.support-empty')) list.innerHTML = '';
  msgs.forEach(function(m) {
    if (list.querySelector('[data-msg-id="' + m.id + '"]')) return;
    _renderOneMessage(list, m);
  });
  _scrollToBottom();
}

// 全屏看大图(原内联 onclick + window.open 在 webview 不可用 → 改成自带预览)
// 点任意处 / ESC 关闭, 关闭即彻底移除浮层(不留遮罩挡点击)
function _showSupportImage(url) {
  if (!url) return;
  var ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:10001500;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:24px;cursor:zoom-out;';
  var img = document.createElement('img');
  img.src = url;
  img.setAttribute('draggable', 'false');
  img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;box-shadow:0 8px 40px rgba(0,0,0,0.6);';
  ov.appendChild(img);
  function close() {
    if (ov.parentNode) ov.parentNode.removeChild(ov);
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  ov.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(ov);
}

function _renderOneMessage(list, m) {
  var who = m.from === 'admin' ? 'admin' : 'user';
  var typeCls = m.type === 'info' ? ' info' : '';
  var el = document.createElement('div');
  el.className = 'support-msg ' + who + typeCls;
  el.dataset.msgId = String(m.id);

  var meta = (m.from === 'admin' ? '作者' : '我') + (m.type === 'info' ? ' · 信息面板' : '');
  var inner;
  if (m.type === 'image' && m.imagePath) {
    var url = _api('/api/support/image/' + m.imagePath);
    inner = '<div class="support-bubble"><img class="support-img" src="' + _esc(url) + '" title="点击查看大图" style="cursor:zoom-in"></div>';
  } else {
    inner = '<div class="support-bubble">' + _esc(m.text || '') + '</div>';
  }
  el.innerHTML = '<div class="support-meta">' + _esc(meta) + ' · <span class="ts-rel" data-ts="' + _esc(m.ts || '') + '">' + _esc(_fmtTime(m.ts)) + '</span></div>' + inner;
  list.appendChild(el);
  // 点图 → 全屏预览(替代失效的内联 onclick）
  var _supImg = el.querySelector('.support-img');
  if (_supImg) _supImg.addEventListener('click', function() { _showSupportImage(_supImg.src); });
}

function _refreshRelTimes() {
  if (!_activeContainer) return;
  var nodes = _activeContainer.querySelectorAll('.ts-rel[data-ts]');
  for (var i = 0; i < nodes.length; i++) {
    nodes[i].textContent = _fmtTime(nodes[i].getAttribute('data-ts'));
  }
}

function _scrollToBottom() {
  var list = _activeContainer && _activeContainer.querySelector('#supMsgList');
  if (list) list.scrollTop = list.scrollHeight;
}

function _fmtTime(iso) {
  if (!iso) return '';
  try {
    var d = new Date(iso);
    var now = new Date();
    var diff = (now - d) / 1000;
    if (diff < 60) return Math.max(1, Math.floor(diff)) + '秒前';
    if (diff < 3600) return Math.floor(diff / 60) + '分前';
    if (diff < 86400) return Math.floor(diff / 3600) + '时前';
    return d.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
  } catch(e) { return iso; }
}

// ── 选图 ──
function _onPickImage(e) {
  var input = e.target;
  if (!input.files || !input.files[0]) return;
  _loadImageFile(input.files[0]);
  input.value = '';
}

function _loadImageFile(f) {
  if (!f) return;
  if (f.size > MAX_IMAGE_BYTES) {
    TileAPI.toast('图片不能超过 5MB', 'error');
    return;
  }
  var reader = new FileReader();
  reader.onload = function() {
    var dataUrl = reader.result;
    var comma = dataUrl.indexOf(',');
    var label = f.name || ('粘贴的图片 (' + (f.type || 'image') + ')');
    _pendingImg = { base64: dataUrl.slice(comma + 1), mime: f.type, name: label };
    var prev = _activeContainer && _activeContainer.querySelector('#supImgPreview');
    if (!prev) return;
    prev.style.display = 'flex';
    prev.innerHTML = '<img src="' + dataUrl + '"><span class="name">' + _esc(label) + '</span><span class="x">✕ 移除</span>';
    var x = prev.querySelector('.x');
    if (x) x.addEventListener('click', _clearPendingImg);
  };
  reader.readAsDataURL(f);
}

function _onPaste(e) {
  var items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (var i = 0; i < items.length; i++) {
    if (items[i].kind === 'file' && items[i].type.indexOf('image/') === 0) {
      var f = items[i].getAsFile();
      if (f) {
        e.preventDefault();
        _loadImageFile(f);
        return;
      }
    }
  }
}

function _clearPendingImg() {
  _pendingImg = null;
  var prev = _activeContainer && _activeContainer.querySelector('#supImgPreview');
  if (prev) { prev.style.display = 'none'; prev.innerHTML = ''; }
}

// ── 发送 ──
function _setSending(b) {
  _sending = b;
  var btn = _activeContainer && _activeContainer.querySelector('#supSendBtn');
  if (btn) btn.disabled = b;
}

function _postSend(payload) {
  if (!_isLoggedIn()) {
    return Promise.reject(new Error('请先登录后再使用客服'));
  }
  return _serverConfig.fetchApi('/api/support/send', {
    method: 'POST',
    headers: _authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload)
  }).then(function(r) {
    if (r.status === 401) { _onAuthLost(); throw new Error('登录已过期, 请重新登录'); }
    if (r.status === 403) {
      _stopPolling();
      throw new Error('当前设备的客服会话已绑定其他账号, 无法发送');
    }
    return r.json().then(function(d) {
      if (!r.ok || !d || !d.success) throw new Error((d && d.error) || ('HTTP ' + r.status));
      return d;
    });
  }).then(function(d) {
    if (d.message) {
      _messages.push(d.message);
      _lastSeenMsgId = Math.max(_lastSeenMsgId, d.message.id);
      TileAPI.storage.set('support.lastSeenMsgId', _lastSeenMsgId);
      var list = _activeContainer && _activeContainer.querySelector('#supMsgList');
      if (list) _appendMessagesToDom([d.message]);
    }
  });
}

function _sendText() {
  if (_sending) return;
  var ta = _activeContainer && _activeContainer.querySelector('#supTextInput');
  if (!ta) return;
  var text = ta.value.trim();
  if (!text && !_pendingImg) return;
  _setSending(true);

  var img = _pendingImg;
  var jobs = [];
  var uid = _getUserId();
  if (img) {
    jobs.push(function() { return _postSend({ deviceId: _deviceId, userId: uid, type: 'image', imageBase64: img.base64, mime: img.mime }); });
  }
  if (text) {
    jobs.push(function() { return _postSend({ deviceId: _deviceId, userId: uid, type: 'text', text: text }); });
  }

  var chain = Promise.resolve();
  jobs.forEach(function(j) { chain = chain.then(j); });
  chain.then(function() {
    ta.value = '';
    _clearPendingImg();
    _scrollToBottom();
  }).catch(function(err) {
    TileAPI.toast('发送失败: ' + (err.message || err), 'error');
  }).then(function() {
    _setSending(false);
    if (ta) ta.focus();
  });
}

function _sendInfoSnapshot() {
  if (_sending) return;
  if (typeof window._buildInfoSnapshot !== 'function') {
    TileAPI.toast('信息面板模块未就绪，请稍后再试', 'error');
    return;
  }
  // 先请求一次 doc 信息刷新,等 250ms 再构建
  TileAPI.sendToHost('getDocInfo', {});
  setTimeout(function() {
    var snap;
    try { snap = window._buildInfoSnapshot(); }
    catch(e) { TileAPI.toast('生成信息面板失败: ' + e.message, 'error'); return; }
    if (!snap || !snap.trim()) { TileAPI.toast('信息面板为空', 'warn'); return; }

    TileAPI.confirm('确定要发送当前信息面板给作者吗？\n\n包含 PS版本/连接状态/参数/统计等信息。').then(function(ok) {
      if (!ok) return;
      _setSending(true);
      _postSend({ deviceId: _deviceId, userId: _getUserId(), type: 'info', text: snap })
        .then(function() { _scrollToBottom(); })
        .catch(function(err) { TileAPI.toast('发送失败: ' + (err.message || err), 'error'); })
        .then(function() { _setSending(false); });
    });
  }, 250);
}

// ── 全局登录态联动 ──
// 登录/登出时让面板和未读数立刻跟随, 不用等下一次轮询
if (TileAPI && typeof TileAPI.on === 'function') {
  TileAPI.on('auth:loggedIn', function() {
    _firstLoad = true; // 别在刚登录瞬间补播一堆历史消息的提示音
    if (_activeContainer) {
      _renderPanel(_activeContainer);
      _loadHistory().then(function() {
        _stopPolling();
        _startPolling(true);
      });
    } else {
      _pollOnce(true);
    }
  });

  TileAPI.on('auth:loggedOut', function() {
    _messages = [];
    _lastSeenMsgId = 0;
    _historyLoaded = false;
    _firstLoad = true;
    _onAuthLost(); // 重置未读 + 面板回到登录引导
  });
}

// ── 磁贴注册 ──
TileAPI.registerTile({
  id: 'support',
  group: 'main',
  icon: '💬',
  label: '在线客服',
  desc: '联系作者反馈问题',
  live: true,
  liveBack: true,
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 6 },

  renderFront: renderFront,
  renderBack: renderBack,

  onStorageLoaded: function(storage) {
    _ensureDeviceId();
    // 服务器地址硬编码为 DEFAULT_SERVER,不读 storage
    // (历史遗留的 support.serverUrl 例如本地调试时留下的 localhost,直接忽略)
    _serverUrl = DEFAULT_SERVER;
    _lastSeenMsgId = +(storage.get('support.lastSeenMsgId') || 0);
    TileAPI.state.set('support.unread', 0);
    // 启动慢速后台轮询
    if (!_bgPollPrimed) {
      _bgPollPrimed = true;
      _pollOnce(true);
      _startPolling(false);
    }
  },

  onExpand: function(container) {
    _activeContainer = container;
    _renderPanel(container);
    _stopPolling();
    _loadHistory().then(function() {
      _startPolling(true); // 3s 快速轮询
    });
    if (_timeTickTimer) clearInterval(_timeTickTimer);
    _timeTickTimer = setInterval(_refreshRelTimes, 30000);
    return function() {
      _activeContainer = null;
      _stopPolling();
      _startPolling(false); // 切回 30s
      if (_timeTickTimer) { clearInterval(_timeTickTimer); _timeTickTimer = null; }
    };
  },

  onCollapse: function() {
    _activeContainer = null;
  },

  onMessage: function(action, data) {
    if (action === 'soundFilesResult' && _activeContainer) {
      _populateSoundSelect((data && data.files) || []);
    }
  }
});

})();
