// ============================================================
//  tile-browser.js — 轮椅浏览器控制磁贴
//  作用: 装/升级「轮椅浏览器」独立插件 (跟轮椅遥控器同款自动安装),
//        配置浏览器书签 + 寸止开关 (没任务时是否锁定浏览器), 经 IPC 同步给浏览器。
//  注: 不做首次运行推荐弹窗。
// ============================================================
(function() {
'use strict';

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 语义化版本对比 (1.0.0 vs 1.0.1)
function _verCmp(a, b) {
  if (!a) return -1;
  if (!b) return 1;
  var pa = String(a).split('.').map(function(x) { return parseInt(x, 10) || 0; });
  var pb = String(b).split('.').map(function(x) { return parseInt(x, 10) || 0; });
  for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// 默认书签 (跟浏览器内置一致)
var DEFAULT_BOOKMARKS = [
  { name: 'Pinterest', url: 'https://www.pinterest.com/' },
  { name: '抖音搜索', url: 'https://www.douyin.com/search/' },
  { name: 'ArtStation', url: 'https://www.artstation.com/' },
  { name: 'Civitai', url: 'https://civitai.com' },
  { name: 'HuggingFace', url: 'https://huggingface.co' },
  { name: '百度', url: 'https://www.baidu.com' },
  { name: 'Google', url: 'https://www.google.com' }
];

function _getBookmarks() {
  var bm = TileAPI.storage.get('browser.bookmarks');
  if (!Array.isArray(bm)) return DEFAULT_BOOKMARKS.slice();
  return bm;
}
function _getIdleLock() {
  return TileAPI.storage.get('browser.idleLock') !== false; // 默认 true
}

var _lastStatus = null;

// ============================================================
//  安装引导弹窗 (仿卫星, 走 installBrowser)
// ============================================================
var _guideOverlay = null;
function _hideInstallGuide() {
  if (_guideOverlay && _guideOverlay.parentNode) _guideOverlay.parentNode.removeChild(_guideOverlay);
  _guideOverlay = null;
}
function _showInstallGuide(opts) {
  opts = opts || {};
  var isReinstall = !!opts.reinstall;
  var ver = opts.version || (_lastStatus && _lastStatus.latestVersion) || '';
  _hideInstallGuide();
  var ov = document.createElement('div');
  ov.className = 'br-guide-mask';
  ov.innerHTML =
    '<div class="br-guide-card">' +
      '<div class="br-guide-head">' +
        '<div class="br-guide-title">🌐 ' + (isReinstall ? '重新安装' : '安装') + '轮椅浏览器' +
          '<span class="br-guide-ver" id="brGuideVer">' + (ver ? ' v' + _esc(ver) : '') + '</span>' +
        '</div>' +
        '<button class="br-guide-close" id="brGuideClose" title="取消">×</button>' +
      '</div>' +
      '<div class="br-guide-body">' +
        '<div class="br-guide-sub">按下面步骤一步一步操作, 不要跳过</div>' +
        '<ol class="br-guide-steps">' +
          '<li>点击下方的 <b>「🌐 开始安装」</b> 按钮</li>' +
          '<li>UXP 弹「是否运行此插件」 → 点 <b>「允许」</b></li>' +
          '<li><span class="br-guide-warn">关闭 Photoshop</span> (不要关黑色命令窗口)</li>' +
          '<li>系统弹「管理员权限 (UAC)」 → 点 <b>「是」</b></li>' +
          '<li>等待自动安装完成 (约 30–60 秒)</li>' +
          '<li>重新打开 Photoshop, 在 增效工具 菜单里找「轮椅浏览器」</li>' +
        '</ol>' +
        '<div class="br-guide-note">安装目录: <code>' + _esc((_lastStatus && _lastStatus.targetDir) || 'PS Plug-ins\\轮椅浏览器') + '</code></div>' +
        '<div class="br-guide-status" id="brGuideStatus"></div>' +
      '</div>' +
      '<div class="br-guide-actions">' +
        '<button class="w10-btn" id="brGuideCancel">取消</button>' +
        '<button class="w10-btn w10-btn-accent br-guide-go" id="brGuideGo">🌐 开始安装</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  _guideOverlay = ov;
  var goBtn = ov.querySelector('#brGuideGo');
  var status = ov.querySelector('#brGuideStatus');
  ov.querySelector('#brGuideClose').onclick = _hideInstallGuide;
  ov.querySelector('#brGuideCancel').onclick = _hideInstallGuide;
  ov.addEventListener('click', function(e) { if (e.target === ov) _hideInstallGuide(); });
  goBtn.onclick = function() {
    goBtn.disabled = true;
    goBtn.textContent = '⏳ 启动中...';
    if (status) status.innerHTML = '<span class="br-guide-status-info">已发起安装请求, 请按上方步骤继续操作...</span>';
    try { TileAPI.sendToHost('installBrowser', {}); }
    catch (e) {
      if (status) status.innerHTML = '<span class="br-guide-status-err">❌ 启动失败: ' + _esc(e && e.message || e) + '</span>';
      goBtn.disabled = false; goBtn.textContent = '🔄 重试';
    }
  };
  if (!ver) { try { TileAPI.sendToHost('checkBrowserStatus', {}); } catch(_) {} }
}

TileAPI.onHostMessage('browserInstallStarted', function() {
  if (!_guideOverlay) return;
  var status = _guideOverlay.querySelector('#brGuideStatus');
  if (status) status.innerHTML = '<span class="br-guide-status-ok">✓ 安装脚本已启动, 请关闭 PS 并在 UAC 弹窗点「是」</span>';
});
TileAPI.onHostMessage('browserInstallError', function(data) {
  if (!_guideOverlay) return;
  var status = _guideOverlay.querySelector('#brGuideStatus');
  if (status) status.innerHTML = '<span class="br-guide-status-err">❌ 启动失败: ' + _esc((data && data.error) || '未知') + '</span>';
  var goBtn = _guideOverlay.querySelector('#brGuideGo');
  if (goBtn) { goBtn.disabled = false; goBtn.textContent = '🔄 重试'; }
});
TileAPI.onHostMessage('browserStatus', function(data) {
  _lastStatus = data || _lastStatus;
  if (!_guideOverlay) return;
  var verEl = _guideOverlay.querySelector('#brGuideVer');
  if (verEl && _lastStatus && _lastStatus.latestVersion) verEl.textContent = ' v' + _lastStatus.latestVersion;
});

// ============================================================
//  推配置给浏览器 (IPC)
// ============================================================
function _pushConfig() {
  TileAPI.sendToHost('ipcWriteBrowserConfig', {
    bookmarks: _getBookmarks(),
    idleLock: _getIdleLock()
  });
}
window._pushBrowserConfig = _pushConfig; // 给 app.js 启动时调

// ============================================================
//  磁贴渲染
// ============================================================
function renderFront(container, w, h) {
  if (w >= 2) {
    container.innerHTML =
      '<div class="tile-icon">🌐</div>' +
      '<div class="tile-label">轮椅浏览器</div>' +
      '<div class="tile-desc">装/配书签/寸止</div>';
  } else {
    container.innerHTML =
      '<div class="tile-icon">🌐</div>' +
      '<div class="tile-label">浏览器</div>';
  }
}

function onExpand(container, sizeHint) {
  TileAPI.sendToHost('checkBrowserStatus', {});

  // 编辑中的书签草稿 (从 storage 拷一份)
  var _draft = _getBookmarks().map(function(b) { return { name: b.name || '', url: b.url || '' }; });

  function _statusBlock() {
    var s = _lastStatus || {};
    if (!s.installed) {
      return '<div class="br-row br-row-status"><span>📦 未安装</span>' +
        '<button class="w10-btn w10-btn-accent" id="brInstall">安装浏览器 v' + (s.latestVersion || '?') + '</button></div>';
    }
    if (_verCmp(s.installedVersion, s.latestVersion) < 0) {
      return '<div class="br-row br-row-status"><span>📦 已装 v' + _esc(s.installedVersion) + ' → 有新版 v' + _esc(s.latestVersion) + '</span>' +
        '<button class="w10-btn w10-btn-accent" id="brInstall">升级到 v' + _esc(s.latestVersion) + '</button></div>';
    }
    return '<div class="br-row br-row-status"><span>✓ 已安装 v' + _esc(s.installedVersion) + ' (最新)</span>' +
      '<button class="w10-btn" id="brReinstall" title="重新安装">重装</button></div>';
  }

  function _bookmarkRows() {
    if (!_draft.length) return '<div class="br-bm-empty">还没有书签，点下面「+ 添加书签」</div>';
    return _draft.map(function(b, i) {
      return '<div class="br-bm-row" data-bm="' + i + '">' +
        '<input class="w10-input br-bm-name" data-bm-name="' + i + '" value="' + _esc(b.name) + '" placeholder="名称" title="书签名">' +
        '<input class="w10-input br-bm-url" data-bm-url="' + i + '" value="' + _esc(b.url) + '" placeholder="https://..." title="网址">' +
        '<button class="br-bm-mini" data-bm-up="' + i + '" title="上移">▲</button>' +
        '<button class="br-bm-mini" data-bm-down="' + i + '" title="下移">▼</button>' +
        '<button class="br-bm-mini br-bm-del" data-bm-del="' + i + '" title="删除">×</button>' +
      '</div>';
    }).join('');
  }

  function _renderAll() {
    var idleOn = _getIdleLock();
    container.innerHTML =
      '<div class="w10-panel br-panel">' +
        '<div class="br-section-title">安装状态</div>' +
        _statusBlock() +
        '<div class="br-row br-row-status" style="gap:6px;flex-wrap:wrap;">' +
          '<button class="w10-btn" id="brOpenFolder" title="打开 PS Plug-ins\\轮椅浏览器 目录">📂 打开安装目录</button>' +
          '<button class="w10-btn" id="brRefresh" title="重新检查安装状态">🔄 刷新状态</button>' +
        '</div>' +

        '<div class="br-section-title">书签 (浏览器顶栏常驻网址)</div>' +
        '<div class="br-bm-list" id="brBmList">' + _bookmarkRows() + '</div>' +
        '<div class="br-row"><button class="w10-btn" id="brBmAdd">+ 添加书签</button></div>' +

        '<div class="br-section-title">寸止</div>' +
        '<div class="br-row br-row-toggle">' +
          '<div style="flex:1"><div>没任务时锁定浏览器</div>' +
            '<div class="br-row-desc">开:主插件没在跑任务时浏览器显示🔒、暂停使用。关:没任务也能自由浏览。</div></div>' +
          '<div class="w10-toggle' + (idleOn ? ' on' : '') + '" id="brIdleLock"></div>' +
        '</div>' +

        '<div class="br-actions">' +
          '<button class="w10-btn" id="brResetBm">恢复默认书签</button>' +
          '<button class="w10-btn w10-btn-accent" id="brSave">保存并同步</button>' +
        '</div>' +

        '<div class="br-info">轮椅浏览器是独立 PS 浮动面板, 边等出图边找参考图, 还能把网页图片一键导入 PS。' +
          '安装/升级需关闭 PS 并授予管理员权限。<br>' +
          '<span style="color:var(--text-sub)">目标目录: <code>' + _esc((_lastStatus && _lastStatus.targetDir) || 'PS Plug-ins\\轮椅浏览器') + '</code></span></div>' +
      '</div>';
    _bind();
  }

  // 把当前 DOM 里的书签输入读回草稿 (改顺序/删除前先同步, 防丢未保存的输入)
  function _syncDraftFromDom() {
    _draft.forEach(function(b, i) {
      var nEl = container.querySelector('[data-bm-name="' + i + '"]');
      var uEl = container.querySelector('[data-bm-url="' + i + '"]');
      if (nEl) b.name = nEl.value;
      if (uEl) b.url = uEl.value;
    });
  }
  function _rerenderBm() {
    var list = container.querySelector('#brBmList');
    if (list) { list.innerHTML = _bookmarkRows(); _bindBmRows(); }
  }

  function _bindBmRows() {
    container.querySelectorAll('[data-bm-del]').forEach(function(btn) {
      btn.onclick = function() { _syncDraftFromDom(); _draft.splice(+btn.getAttribute('data-bm-del'), 1); _rerenderBm(); };
    });
    container.querySelectorAll('[data-bm-up]').forEach(function(btn) {
      btn.onclick = function() {
        var i = +btn.getAttribute('data-bm-up'); if (i <= 0) return;
        _syncDraftFromDom();
        var t = _draft[i - 1]; _draft[i - 1] = _draft[i]; _draft[i] = t; _rerenderBm();
      };
    });
    container.querySelectorAll('[data-bm-down]').forEach(function(btn) {
      btn.onclick = function() {
        var i = +btn.getAttribute('data-bm-down'); if (i >= _draft.length - 1) return;
        _syncDraftFromDom();
        var t = _draft[i + 1]; _draft[i + 1] = _draft[i]; _draft[i] = t; _rerenderBm();
      };
    });
  }

  function _bind() {
    var instBtn = container.querySelector('#brInstall');
    if (instBtn) instBtn.onclick = function() { _showInstallGuide({ version: _lastStatus && _lastStatus.latestVersion, reinstall: false }); };
    var reinstBtn = container.querySelector('#brReinstall');
    if (reinstBtn) reinstBtn.onclick = function() { _showInstallGuide({ version: _lastStatus && _lastStatus.installedVersion, reinstall: true }); };
    var folderBtn = container.querySelector('#brOpenFolder');
    if (folderBtn) folderBtn.onclick = function() { TileAPI.sendToHost('openBrowserFolder', {}); };
    var refreshBtn = container.querySelector('#brRefresh');
    if (refreshBtn) refreshBtn.onclick = function() { refreshBtn.textContent = '⏳ 检查中...'; TileAPI.sendToHost('checkBrowserStatus', {}); };

    _bindBmRows();
    var addBtn = container.querySelector('#brBmAdd');
    if (addBtn) addBtn.onclick = function() { _syncDraftFromDom(); _draft.push({ name: '', url: '' }); _rerenderBm(); };

    var idleTog = container.querySelector('#brIdleLock');
    if (idleTog) idleTog.onclick = function() { idleTog.classList.toggle('on'); };

    var resetBtn = container.querySelector('#brResetBm');
    if (resetBtn) resetBtn.onclick = function() {
      _draft = DEFAULT_BOOKMARKS.map(function(b) { return { name: b.name, url: b.url }; });
      _rerenderBm();
      TileAPI.toast('已填回默认书签, 记得点保存', 'info');
    };

    var saveBtn = container.querySelector('#brSave');
    if (saveBtn) saveBtn.onclick = function() {
      _syncDraftFromDom();
      // 清洗: 去掉空网址行 + trim
      var clean = _draft
        .map(function(b) { return { name: (b.name || '').trim(), url: (b.url || '').trim() }; })
        .filter(function(b) { return b.url; });
      var idleOn = !!(container.querySelector('#brIdleLock') && container.querySelector('#brIdleLock').classList.contains('on'));
      TileAPI.storage.set('browser.bookmarks', clean);
      TileAPI.storage.set('browser.idleLock', idleOn);
      _pushConfig();
      _draft = clean.map(function(b) { return { name: b.name, url: b.url }; });
      _rerenderBm();
      TileAPI.toast('✓ 已保存并同步到浏览器 (浏览器面板约 1 秒内刷新)', 'success');
    };
  }

  _renderAll();

  var statusHandler = function(data) { _lastStatus = data || {}; _renderAll(); };
  TileAPI.onHostMessage('browserStatus', statusHandler);
  var startedHandler = function() {
    var btn = container.querySelector('#brInstall, #brReinstall');
    if (btn) btn.textContent = '✓ 已启动安装脚本, 请按提示操作';
    TileAPI.toast('安装脚本已启动, 请关闭 PS 并在 UAC 弹窗时点"是"', 'info', 6000);
  };
  TileAPI.onHostMessage('browserInstallStarted', startedHandler);
  var errorHandler = function(data) {
    var btn = container.querySelector('#brInstall, #brReinstall');
    if (btn) { btn.disabled = false; btn.textContent = '重试安装'; }
    TileAPI.toast('安装失败: ' + ((data && data.error) || '未知'), 'error');
  };
  TileAPI.onHostMessage('browserInstallError', errorHandler);

  return function() {
    TileAPI.offHostMessage('browserStatus', statusHandler);
    TileAPI.offHostMessage('browserInstallStarted', startedHandler);
    TileAPI.offHostMessage('browserInstallError', errorHandler);
  };
}

TileAPI.registerTile({
  id: 'browser',
  icon: '🌐',
  label: '轮椅浏览器',
  desc: '浏览器安装/书签/寸止',
  group: 'main',
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 2, h: 2 },
  renderFront: renderFront,
  onExpand: onExpand
});

})();
