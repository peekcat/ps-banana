// ============================================================
//  tile-update.js - 版本检查更新磁贴
//  检查更新、显示changelog、下载更新、进度条
// ============================================================
(function() {
'use strict';

// ========== Private state ==========
var VERSION = '6.6.4';
// 服务器基地址(不含 ?branch=...);分支由 _getBranch() 动态拼上去
var _serverConfig = window.WheelchairServerConfig;
var DEFAULT_SERVER_BASE = _serverConfig.OFFICIAL_BASE;
var _activeContainer = null;
var _latestInfo = null;   // { version, changelog, downloadUrl } or null
var _downloading = false;
var _readyBatPath = null; // bat path returned by host on updateReady

// ========== 工具 ==========
function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 登录态检查 (跟客服磁贴口径一致: state.cloud.loggedIn + storage.cloud.token 都有才算登录)
function _isLoggedIn() {
  return !!TileAPI.state.get('cloud.loggedIn') && !!TileAPI.storage.get('cloud.token');
}

// 未登录冻结面板 — 跟 tile-support 一样的"去登录"风格
function _renderLoginGate(container) {
  container.innerHTML =
    '<div class="w10-panel update-panel">' +
      '<div class="w10-section-title">🔄 版本检查</div>' +
      '<div class="support-empty" style="padding:24px;text-align:center;line-height:1.8">' +
        '🔐 检查更新需要 <b>登录</b> 后才能使用<br>' +
        '<span style="font-size:12px;color:var(--text-sub,#888)">登录后才能拉取版本信息、下载新版安装包</span><br><br>' +
        '<button class="support-send-btn" id="updGotoLoginBtn">去登录</button>' +
      '</div>' +
    '</div>';
  var loginBtn = container.querySelector('#updGotoLoginBtn');
  if (loginBtn) loginBtn.addEventListener('click', function() {
    if (TileAPI && typeof TileAPI.expandTile === 'function') {
      TileAPI.expandTile('topbar');
    } else {
      TileAPI.toast('请打开顶部账号面板登录', 'info');
    }
  });
}

// 解析 changelog 里的颜色标记 {red}xx{/red} → 跟 admin 后台 parseColorTags 一致
// 安全:先 esc 整段(防 XSS),再用 esc 后的 \{tag\} 替换成 span(因为 esc 会把 & < > 但保留 { } )
var _CHANGELOG_COLORS = {
  red:    '#ff5252',
  green:  '#69f0ae',
  blue:   '#64b5f6',
  orange: '#ff9800',
  yellow: '#fff176'
};
function _parseColorTags(text) {
  if (!text) return '';
  var safe = _esc(text);
  return safe.replace(/\{(\w+)\}([\s\S]*?)\{\/\1\}/g, function(m, color, content) {
    var c = _CHANGELOG_COLORS[color];
    return c ? '<span style="color:' + c + '">' + content + '</span>' : content;
  });
}

// 灰度测试版 (alpha) 解锁状态 — 仅本次会话有效, 不持久化, 关 PS 自动锁回
//   入口隐藏: 用户在 dev pill 上 3 秒内连点 5 下才解锁
var _alphaUnlocked = false;
var _alphaClickStamps = [];

function _getBranch() {
  var b = TileAPI.storage.get('update.branch');
  // alpha 必须解锁了才生效, 否则 fallback 到 stable (防 storage 残留)
  if (b === 'alpha') {
    if (_alphaUnlocked) return 'alpha';
    // 上次会话解锁过留下的残留 — 主动清掉, 让普通用户的 storage 干净
    try { TileAPI.storage.set('update.branch', 'stable'); } catch(_) {}
    return 'stable';
  }
  if (b === 'dev') return 'dev';
  return 'stable';
}

function _setBranch(b) {
  if (b === 'alpha' && _alphaUnlocked) { TileAPI.storage.set('update.branch', 'alpha'); return; }
  TileAPI.storage.set('update.branch', (b === 'dev') ? 'dev' : 'stable');
}

function _getServerBase() {
  // 用户可在 storage 自定义服务器地址(e.g. 测试环境)
  var custom = TileAPI.storage.get('update.serverBase');
  if (custom) return custom.replace(/\/+$/, '');
  return DEFAULT_SERVER_BASE;
}

function _getCheckUrl() {
  return _getServerBase() + '/api/update/check?branch=' + _getBranch();
}

function _getDownloadUrl() {
  return _getServerBase() + '/api/update/download?branch=' + _getBranch();
}

function _fetchUpdateUrl(url, init) {
  var base = _getServerBase();
  if ((base === _serverConfig.OFFICIAL_BASE || base === _serverConfig.FALLBACK_BASE) && url.indexOf(base) === 0) {
    return _serverConfig.fetchApi(url.substring(base.length), init);
  }
  return _serverConfig.fetchWithTimeout(url, init, 12000);
}

function _hasNewVersion() {
  return _latestInfo && _latestInfo.version && _isNewer(_latestInfo.version, VERSION);
}

// Simple semver compare: returns true if remote > local
// 兼容预发布后缀(如 '6.0.1-dev'):用 parseInt 取每段开头的数字,忽略 '-dev' '-beta' 等
function _isNewer(remote, local) {
  var r = String(remote).replace(/^v/, '').split('.').map(function(s) { return parseInt(s, 10) || 0; });
  var l = String(local).replace(/^v/, '').split('.').map(function(s) { return parseInt(s, 10) || 0; });
  for (var i = 0; i < Math.max(r.length, l.length); i++) {
    var rv = r[i] || 0;
    var lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

// ========== Tile Registration ==========

TileAPI.registerTile({
  id: 'update',
  group: 'main',
  icon: '\uD83D\uDD04',
  label: '更新',
  desc: '版本检查',
  live: false,
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  onExpand: function(container, sizeHint) {
    _activeContainer = container;

    // 未登录冻结: 显示去登录引导, 跟客服磁贴一致
    if (!_isLoggedIn()) {
      _renderLoginGate(container);
      return function() { _activeContainer = null; };
    }

    var layout = (sizeHint && sizeHint.layout) || 'wide';

    // 窄/高布局一律用 wide 渲染(没有 square 分支,wide 是全内容)
    if (layout === 'narrow' || layout === 'tall') layout = 'wide';
    if (layout === 'narrow' || layout === 'tall') {
      _renderNarrow(container);
    } else if (layout === 'wideshort') {
      _renderWideShort(container);
    } else {
      _renderWide(container);
    }

    _bindEvents(container);

    // 若展开前已有下载完成的 bat 路径(用户切走又切回)，立即渲染覆盖层
    if (_readyBatPath) _renderInstallOverlay(container);

    return function() { _activeContainer = null; };
  },

  onCollapse: function() {
    _activeContainer = null;
  },

  onMessage: function(action, data) {
    _handleMessage(action, data);
  },
});

// ========== Layouts ==========

function _renderVersionCard() {
  return '' +
    '<div class="w10-row">' +
      '<div class="w10-row-left">' +
        '<div class="w10-row-label">当前版本</div>' +
        '<div class="w10-row-desc">轮椅 v' + VERSION + '</div>' +
      '</div>' +
      '<div class="w10-row-right">' +
        '<button class="w10-btn w10-btn-accent" id="updateCheckBtn">检查更新</button>' +
      '</div>' +
    '</div>';
}

function _renderLatestInfo() {
  if (!_latestInfo) return '';
  if (!_hasNewVersion() && !_isNewer(_latestInfo.version, VERSION)) {
    return '' +
      '<div class="w10-row">' +
        '<div class="w10-row-left">' +
          '<div class="w10-row-label" style="color:var(--accent);">已是最新版本</div>' +
          '<div class="w10-row-desc">v' + _esc(VERSION) + ' 是最新的</div>' +
        '</div>' +
      '</div>';
  }
  var html = '' +
    '<div class="w10-section-title">发现新版</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left">' +
        '<div class="w10-row-label">最新版本</div>' +
        '<div class="w10-row-desc">v' + _esc(_latestInfo.version) + '</div>' +
      '</div>' +
      '<div class="w10-row-right">' +
        '<button class="w10-btn w10-btn-accent" id="updateDownloadBtn"' +
          (_downloading ? ' style="opacity:0.4;pointer-events:none;"' : '') +
        '>' + (_downloading ? '下载中...' : '下载更新') + '</button>' +
      '</div>' +
    '</div>';

  // Changelog — 整页显示(不限高度,字号加大,跟随面板自然滚动)
  if (_latestInfo.changelog) {
    html += '' +
      '<div class="w10-row" style="flex-direction:column;align-items:stretch;">' +
        '<div class="w10-row-label" style="margin-bottom:8px;font-size:12px;">更新日志</div>' +
        '<div id="updateChangelog" style="white-space:pre-wrap;line-height:1.7;font-size:13px;color:var(--text);padding:10px 12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:6px;">' +
          _parseColorTags(_latestInfo.changelog) +
        '</div>' +
      '</div>';
  }

  // Progress bar area
  html += '<div id="updateProgressArea"></div>';

  return html;
}

function _renderProgressBar(percent, speed, downloaded, total) {
  percent = Math.min(100, Math.max(0, percent || 0));
  var info = '';
  if (downloaded && total) info = _esc(downloaded) + ' / ' + _esc(total);
  if (speed) info += (info ? '  \u00B7  ' : '') + _esc(speed);

  return '' +
    '<div class="w10-row" style="flex-direction:column;align-items:stretch;gap:4px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<div class="w10-row-label">下载进度</div>' +
        '<div class="w10-row-desc">' + percent + '%</div>' +
      '</div>' +
      '<div style="height:4px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden;">' +
        '<div id="updateProgressFill" style="height:100%;width:' + percent + '%;background:var(--accent);transition:width 0.3s ease;border-radius:2px;"></div>' +
      '</div>' +
      (info ? '<div class="w10-row-desc" style="text-align:right;">' + info + '</div>' : '') +
    '</div>';
}

// --- Branch pill (shared across layouts) ---
function _renderBranchPill() {
  var b = _getBranch();
  var html = '' +
    '<div class="update-branch-pill" id="updateBranchPill">' +
      '<span class="update-branch-opt' + (b === 'stable' ? ' active' : '') + '" data-branch="stable">稳定版</span>' +
      '<span class="update-branch-opt' + (b === 'dev' ? ' active' : '') + '" data-branch="dev">开发版</span>';
  if (_alphaUnlocked) {
    html += '<span class="update-branch-opt update-branch-alpha' + (b === 'alpha' ? ' active' : '') + '" data-branch="alpha" title="灰度测试版 (本次会话有效)">🔬 灰度</span>';
  }
  html += '</div>';
  return html;
}

// --- Wide layout ---
function _renderWide(container) {
  container.innerHTML =
    '<div class="w10-panel update-panel">' +
      '<div class="w10-section-title">版本信息</div>' +
      _renderBranchPill() +
      _renderVersionCard() +
      _renderLatestInfo() +
      _renderAutoCheckRow() +
    '</div>';
}

// --- 启动时自动检查开关 (公用) ---
function _renderAutoCheckRow() {
  var enabled = TileAPI.storage.get('update.autoCheck') !== false;
  return '' +
    '<div class="w10-row update-auto-row">' +
      '<div class="w10-row-left">' +
        '<div class="w10-row-label">启动时检查更新</div>' +
        '<div class="w10-row-desc">每次打开 PS 自动检查一次, 有新版会弹窗</div>' +
      '</div>' +
      '<div class="w10-row-right">' +
        '<label class="update-auto-switch">' +
          '<input type="checkbox" id="updateAutoToggle"' + (enabled ? ' checked' : '') + '>' +
          '<span>' + (enabled ? '已开启' : '已关闭') + '</span>' +
        '</label>' +
      '</div>' +
    '</div>';
}

// --- Narrow/Tall layout ---
function _renderNarrow(container) {
  container.innerHTML =
    '<div class="w10-panel update-panel">' +
      '<div class="w10-section-title">更新</div>' +
      _renderBranchPill() +
      '<div class="w10-row">' +
        '<div class="w10-row-left">' +
          '<div class="w10-row-label">v' + VERSION + '</div>' +
        '</div>' +
        '<div class="w10-row-right">' +
          '<button class="w10-btn w10-btn-accent" id="updateCheckBtn">检查</button>' +
        '</div>' +
      '</div>' +
      (_hasNewVersion() ?
        '<div class="w10-row">' +
          '<div class="w10-row-left">' +
            '<div class="w10-row-label" style="color:var(--accent);">新版 v' + _esc(_latestInfo.version) + '</div>' +
          '</div>' +
          '<div class="w10-row-right">' +
            '<button class="w10-btn w10-btn-accent" id="updateDownloadBtn">下载</button>' +
          '</div>' +
        '</div>' +
        '<div id="updateProgressArea"></div>'
      : '') +
    '</div>';
}

// --- WideShort layout ---
function _renderWideShort(container) {
  container.innerHTML =
    '<div class="w10-panel update-panel">' +
      _renderBranchPill() +
      '<div class="w10-row">' +
        '<div class="w10-row-left">' +
          '<div class="w10-row-label">轮椅 v' + VERSION + '</div>' +
          '<div class="w10-row-desc" id="updateWideShortStatus">' +
            (_hasNewVersion() ? '发现新版 v' + _esc(_latestInfo.version) : '') +
          '</div>' +
        '</div>' +
        '<div class="w10-row-right" style="display:flex;gap:6px;">' +
          '<button class="w10-btn w10-btn-accent" id="updateCheckBtn">检查更新</button>' +
          (_hasNewVersion() ?
            '<button class="w10-btn" id="updateDownloadBtn">下载</button>' : '') +
        '</div>' +
      '</div>' +
      '<div id="updateProgressArea"></div>' +
    '</div>';
}

// ========== Event Binding ==========

function _bindEvents(container) {
  // --- Branch pill ---
  var pill = container.querySelector('#updateBranchPill');
  if (pill) {
    pill.querySelectorAll('.update-branch-opt').forEach(function(opt) {
      opt.addEventListener('click', function() {
        var newBranch = opt.dataset.branch || 'stable';

        // ★ 灰度测试版隐藏入口: 在 dev pill 上 3 秒内连点 5 下 → 解锁 alpha 选项
        //   仅本次会话有效, 关 PS 重开后自动失效
        //   解锁后不自动切到 alpha, 只是让 [🔬 灰度] pill 出现, 用户自己点才切
        //   (避免普通用户好奇连点也被拉去拉 alpha 版)
        if (newBranch === 'dev' && !_alphaUnlocked) {
          var now = Date.now();
          // 只保留近 3 秒内的点击
          _alphaClickStamps = _alphaClickStamps.filter(function(t) { return now - t < 3000; });
          _alphaClickStamps.push(now);
          if (_alphaClickStamps.length >= 5) {
            _alphaUnlocked = true;
            _alphaClickStamps = [];
            TileAPI.toast('🔬 已解锁灰度测试版选项 (仅本次会话有效)', 'info');
            // 重渲面板让 [🔬 灰度] pill 出现, 但不切到 alpha
            _refreshUI();
            return;
          }
        }

        if (_getBranch() === newBranch) return;
        _setBranch(newBranch);
        _latestInfo = null;
        _refreshUI();
      });
    });
  }

  // --- Check update ---
  var checkBtn = container.querySelector('#updateCheckBtn');
  if (checkBtn) checkBtn.addEventListener('click', function() {
    checkBtn.textContent = '检查中...';
    checkBtn.style.pointerEvents = 'none';
    _checkUpdate(function() {
      checkBtn.textContent = '检查更新';
      checkBtn.style.pointerEvents = '';
    });
  });

  // --- Download update ---
  var dlBtn = container.querySelector('#updateDownloadBtn');
  if (dlBtn) dlBtn.addEventListener('click', function() {
    if (!_latestInfo || !_latestInfo.downloadUrl) {
      TileAPI.toast('无可用的下载地址', 'error');
      return;
    }
    _downloading = true;
    dlBtn.textContent = '下载中...';
    dlBtn.style.pointerEvents = 'none';
    // Show initial progress
    var area = container.querySelector('#updateProgressArea');
    if (area) area.innerHTML = _renderProgressBar(0, '', '', '');
    TileAPI.sendToHost('downloadUpdate', { url: _latestInfo.downloadUrl, expectedSha256: _latestInfo.sha256 || '' });
  });

  // --- 启动时自动检查开关 ---
  var autoToggle = container.querySelector('#updateAutoToggle');
  if (autoToggle) autoToggle.addEventListener('change', function() {
    var on = autoToggle.checked;
    TileAPI.storage.set('update.autoCheck', on);
    TileAPI.toast(on ? '已开启启动检查' : '已关闭启动检查', 'info');
    // 关掉时一并清掉跳过/snooze, 用户重新开启时是干净状态
    if (!on) {
      TileAPI.storage.set('update.skipVersions', []);
      TileAPI.storage.set('update.snoozeUntil', 0);
    }
    var span = autoToggle.parentNode && autoToggle.parentNode.querySelector('span');
    if (span) span.textContent = on ? '已开启' : '已关闭';
  });
}

// ========== Check update via fetch ==========

function _checkUpdate(callback) {
  var url = _getCheckUrl();
  try {
    _fetchUpdateUrl(url, { method: 'GET', cache: 'no-cache' })
      .then(function(resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function(json) {
        _latestInfo = {
          version: json.version || json.latest || '',
          changelog: json.changelog || json.changes || json.description || '',
          downloadUrl: json.downloadUrl || json.download || json.url || _getDownloadUrl(),
          sha256: (json.sha256 || '').toLowerCase()
        };
        if (_isNewer(_latestInfo.version, VERSION)) {
          TileAPI.toast('发现新版本 v' + _latestInfo.version, 'info');
        } else {
          TileAPI.toast('已是最新版本', 'success');
        }
        _refreshUI();
        if (callback) callback();
      })
      .catch(function(err) {
        TileAPI.toast('检查更新失败: ' + (err.message || err), 'error');
        _latestInfo = null;
        if (callback) callback();
      });
  } catch(e) {
    TileAPI.toast('检查更新失败: ' + (e.message || e), 'error');
    _latestInfo = null;
    if (callback) callback();
  }
}

// ========== Host Message Handling ==========

function _handleMessage(action, data) {
  var container = _activeContainer;

  if (action === 'updateDownloadProgress') {
    if (!container) return;
    var area = container.querySelector('#updateProgressArea');
    if (!area) return;

    var percent = (data && data.percent) || 0;
    var speed = (data && data.speed) || '';
    var downloaded = (data && data.downloaded) || '';
    var total = (data && data.total) || '';

    area.innerHTML = _renderProgressBar(percent, speed, downloaded, total);
    // 不再在这里改按钮文字 / 显示"重启"提示 —— 等待 updateReady
  }

  if (action === 'updateReady') {
    _downloading = false;
    _readyBatPath = (data && data.batPath) || null;
    if (container) _renderInstallOverlay(container);
  }

  if (action === 'updateError') {
    _downloading = false;
    var errMsg = (data && data.error) || '未知错误';
    TileAPI.toast('更新失败: ' + errMsg, 'error');
    if (container) {
      var dlBtn = container.querySelector('#updateDownloadBtn');
      if (dlBtn) {
        dlBtn.textContent = '重新下载';
        dlBtn.style.pointerEvents = '';
      }
      var area2 = container.querySelector('#updateProgressArea');
      if (area2) area2.innerHTML = '<div class="w10-row-desc" style="color:var(--err,#ff5252);">' + _esc(errMsg) + '</div>';
    }
  }
}

function _renderInstallOverlay(container) {
  var area = container.querySelector('#updateProgressArea');
  if (!area) return;
  area.innerHTML =
    '<div class="update-install-box">' +
      '<div class="update-install-title">✔ 下载完成</div>' +
      '<ol class="update-install-steps">' +
        '<li>点击下方<b>"开始安装"</b></li>' +
        '<li>在弹出窗口点<b>"允许"</b></li>' +
        '<li><span class="warn">关闭 Photoshop</span>（不要关黑色命令窗口）</li>' +
        '<li>等待自动更新完成</li>' +
        '<li>重新打开 Photoshop</li>' +
      '</ol>' +
      '<button class="w10-btn w10-btn-accent update-install-btn" id="updateInstallBtn">📦 开始安装</button>' +
      '<div class="update-install-note">脚本路径: <code>' + _esc(_readyBatPath || '(未知)') + '</code></div>' +
    '</div>';

  var btn = container.querySelector('#updateInstallBtn');
  if (btn) btn.addEventListener('click', function() {
    if (!_readyBatPath) { TileAPI.toast('安装脚本路径无效，请重新下载', 'error'); return; }
    btn.textContent = '⏳ 启动中...';
    btn.disabled = true;
    TileAPI.sendToHost('launchUpdateBat', { path: _readyBatPath });
    setTimeout(function() {
      btn.textContent = '📦 重新启动安装';
      btn.disabled = false;
    }, 3000);
  });

  // 隐藏下载按钮(已下完)
  var dlBtn = container.querySelector('#updateDownloadBtn');
  if (dlBtn) dlBtn.style.display = 'none';
}

// ========== UI Refresh ==========

function _refreshUI() {
  var container = _activeContainer;
  if (!container) return;
  var panel = container.querySelector('.update-panel');
  var isNarrow = false;
  var isWideShort = false;
  if (panel) {
    var rect = panel.getBoundingClientRect();
    if (rect.width < 200) isNarrow = true;
    else if (rect.height < 120) isWideShort = true;
  }
  if (isWideShort) _renderWideShort(container);
  else if (isNarrow) _renderNarrow(container);
  else _renderWide(container);
  _bindEvents(container);
}

// ============================================================
//  启动时自动检查更新 + 弹窗提示
//  在 app.js 的 continueBoot 末尾延迟 6 秒被调用
// ============================================================

function _isAutoCheckEnabled() {
  // 默认开启, 用户可在更新磁贴里关掉
  var v = TileAPI.storage.get('update.autoCheck');
  return v !== false;
}

function _isVersionSkipped(version) {
  var skipped = TileAPI.storage.get('update.skipVersions') || [];
  return Array.isArray(skipped) && skipped.indexOf(version) !== -1;
}

function _addSkippedVersion(version) {
  var skipped = TileAPI.storage.get('update.skipVersions') || [];
  if (!Array.isArray(skipped)) skipped = [];
  if (skipped.indexOf(version) === -1) skipped.push(version);
  // 只保留最近 5 个, 防止无限增长
  if (skipped.length > 5) skipped = skipped.slice(-5);
  TileAPI.storage.set('update.skipVersions', skipped);
}

function _isSnoozed() {
  var until = TileAPI.storage.get('update.snoozeUntil') || 0;
  return until > Date.now();
}

function _setSnooze(days) {
  TileAPI.storage.set('update.snoozeUntil', Date.now() + days * 24 * 60 * 60 * 1000);
}

// 静默检查 (不弹 toast, 不刷 UI), 仅返回结果给回调
function _checkUpdateSilent(callback) {
  var url = _getCheckUrl();
  try {
    _fetchUpdateUrl(url, { method: 'GET', cache: 'no-cache' })
      .then(function(resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function(json) {
        var info = {
          version: json.version || json.latest || '',
          changelog: json.changelog || json.changes || json.description || '',
          downloadUrl: json.downloadUrl || json.download || json.url || _getDownloadUrl(),
          sha256: (json.sha256 || '').toLowerCase()
        };
        // 缓存到模块, 让用户点"查看详情"时磁贴自动展开就能看到
        if (info.version && _isNewer(info.version, VERSION)) {
          _latestInfo = info;
        }
        callback(null, info);
      })
      .catch(function(err) { callback(err); });
  } catch(e) { callback(e); }
}

// 启动时检查 — 从 app.js 调
window._updateAutoCheck = function _updateAutoCheck() {
  if (!_isLoggedIn()) return;                       // 未登录不检查 (跟磁贴冻结策略一致)
  if (!_isAutoCheckEnabled()) return;
  if (_isSnoozed()) return;

  _checkUpdateSilent(function(err, info) {
    if (err || !info || !info.version) return;        // 网络失败静默
    if (!_isNewer(info.version, VERSION)) return;     // 已是最新 (含服务器版本号低于或等于本地的情况)
    if (_isVersionSkipped(info.version)) return;      // 用户拒绝过这版
    _showUpdateDialog(info);
  });
};

// ============================================================
//  弹窗 UI
// ============================================================
function _showUpdateDialog(info) {
  // 复用项目的对话框样式 (.uikit-modal-mask + .uikit-modal-card)
  // 防止重复弹
  if (document.getElementById('updateAutoDialog')) return;

  var changelogHtml = info.changelog
    ? _parseColorTags(info.changelog)
    : '(本次更新没有详细说明)';

  var mask = document.createElement('div');
  mask.id = 'updateAutoDialog';
  mask.className = 'uikit-modal-mask update-auto-dialog-mask';
  mask.innerHTML =
    '<div class="uikit-modal-card update-auto-dialog">' +
      '<div class="update-auto-dialog-head">' +
        '<div class="update-auto-dialog-title">🎉 发现新版本</div>' +
        '<div class="update-auto-dialog-version">v' + _esc(VERSION) + ' → v' + _esc(info.version) + '</div>' +
      '</div>' +
      '<div class="update-auto-dialog-body">' +
        '<div class="update-auto-dialog-clog">' + changelogHtml + '</div>' +
      '</div>' +
      '<div class="update-auto-dialog-actions">' +
        '<button class="w10-btn w10-btn-accent" id="updAutoBtnGo">查看详情 / 立即更新</button>' +
        '<button class="w10-btn" id="updAutoBtnSnooze">7 天后再提醒</button>' +
        '<button class="w10-btn" id="updAutoBtnSkip">跳过此版本</button>' +
        '<button class="w10-btn update-auto-dialog-close" id="updAutoBtnLater">这次先不更新</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(mask);

  function _close() {
    if (mask.parentNode) mask.parentNode.removeChild(mask);
  }

  document.getElementById('updAutoBtnGo').onclick = function() {
    _close();
    // 直接打开更新磁贴让用户看到下载按钮
    if (window.TileAPI && TileAPI.expandTile) {
      TileAPI.expandTile('update');
    } else {
      TileAPI.toast('请打开 "更新" 磁贴下载新版', 'info');
    }
  };
  document.getElementById('updAutoBtnSnooze').onclick = function() {
    _setSnooze(7);
    TileAPI.toast('好, 7 天后再提醒', 'info');
    _close();
  };
  document.getElementById('updAutoBtnSkip').onclick = function() {
    _addSkippedVersion(info.version);
    TileAPI.toast('已跳过 v' + info.version + ', 出更新版才会再提醒', 'info');
    _close();
  };
  document.getElementById('updAutoBtnLater').onclick = function() {
    // 不写 storage, 下次开 PS 还会弹
    _close();
  };
}

// 登录态变化 → 展开中的面板自动刷新 (登录后从冻结切到正常 / 退出后切回冻结)
if (TileAPI && typeof TileAPI.on === 'function') {
  TileAPI.on('auth:loggedIn', function() {
    if (!_activeContainer) return;
    _refreshUI();
  });
  TileAPI.on('auth:loggedOut', function() {
    if (!_activeContainer) return;
    _renderLoginGate(_activeContainer);
  });
}

})();
