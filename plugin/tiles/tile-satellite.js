// ============================================================
//  tile-satellite.js — 卫星插件控制磁贴
//  作用: 让用户能装/升级卫星插件, 切换主题同步开关, 看连接状态
// ============================================================
(function() {
'use strict';

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 简易版本对比 (语义化版本: 2.0.0 vs 2.1.0)
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

// 缓存最近一次状态查询结果
var _lastStatus = null;

// ============================================================
//  卫星安装引导弹窗 — 仿更新磁贴的 _renderInstallOverlay 风格
//  入口:
//    · tile-satellite 内的「安装/升级/重装」按钮
//    · tile-firstrun-satellite 内的「立即安装」按钮
//
//  显示编号步骤 + 一个醒目的"📦 开始安装"按钮; 点击后真正调 host
// ============================================================
var _guideOverlay = null;

function _hideInstallGuide() {
    if (_guideOverlay && _guideOverlay.parentNode) {
        _guideOverlay.parentNode.removeChild(_guideOverlay);
    }
    _guideOverlay = null;
}

function _showInstallGuide(opts) {
    opts = opts || {};
    var isReinstall = !!opts.reinstall;
    // 没传 version 就用 _lastStatus 里的; 都没有则先发一次查询, 再异步刷
    var ver = opts.version || (_lastStatus && _lastStatus.latestVersion) || '';
    var needQuery = !ver;

    _hideInstallGuide();

    var ov = document.createElement('div');
    ov.className = 'sat-guide-mask';
    ov.innerHTML =
        '<div class="sat-guide-card">' +
            '<div class="sat-guide-head">' +
                '<div class="sat-guide-title">📦 ' + (isReinstall ? '重新安装' : '安装') + '卫星插件' +
                    '<span class="sat-guide-ver" id="satGuideVer">' + (ver ? ' v' + _esc(ver) : '') + '</span>' +
                '</div>' +
                '<button class="sat-guide-close" id="satGuideClose" title="取消">×</button>' +
            '</div>' +

            '<div class="sat-guide-body">' +
                '<div class="sat-guide-sub">按下面步骤一步一步操作, 不要跳过</div>' +

                '<ol class="sat-guide-steps">' +
                    '<li>点击下方的 <b>「📦 开始安装」</b> 按钮</li>' +
                    '<li>UXP 会弹「是否运行此插件」 → 点 <b>「允许」</b></li>' +
                    '<li><span class="sat-guide-warn">关闭 Photoshop</span> (不要关黑色的命令窗口)</li>' +
                    '<li>系统弹「管理员权限 (UAC)」 → 点 <b>「是」</b></li>' +
                    '<li>等待自动安装完成 (约 30–60 秒)</li>' +
                    '<li>重新打开 Photoshop, 卫星插件会自动启动</li>' +
                '</ol>' +

                '<div class="sat-guide-note">' +
                    '安装目录: <code>' + _esc((_lastStatus && _lastStatus.targetDir) || 'PS Plug-ins\\轮椅遥控器') + '</code>' +
                '</div>' +

                '<div class="sat-guide-status" id="satGuideStatus"></div>' +
            '</div>' +

            '<div class="sat-guide-actions">' +
                '<button class="w10-btn" id="satGuideCancel">取消</button>' +
                '<button class="w10-btn w10-btn-accent sat-guide-go" id="satGuideGo">📦 开始安装</button>' +
            '</div>' +
        '</div>';
    document.body.appendChild(ov);
    _guideOverlay = ov;

    var goBtn = ov.querySelector('#satGuideGo');
    var status = ov.querySelector('#satGuideStatus');

    ov.querySelector('#satGuideClose').onclick = _hideInstallGuide;
    ov.querySelector('#satGuideCancel').onclick = _hideInstallGuide;
    ov.addEventListener('click', function(e) { if (e.target === ov) _hideInstallGuide(); });

    goBtn.onclick = function() {
        goBtn.disabled = true;
        goBtn.textContent = '⏳ 启动中...';
        if (status) status.innerHTML = '<span class="sat-guide-status-info">已发起安装请求, 请按上方步骤继续操作...</span>';
        try {
            TileAPI.sendToHost('installSatellite', {});
        } catch (e) {
            if (status) status.innerHTML = '<span class="sat-guide-status-err">❌ 启动失败: ' + _esc(e && e.message || e) + '</span>';
            goBtn.disabled = false;
            goBtn.textContent = '🔄 重试';
        }
    };

    // 没版本 → 查一下, 拿到后写进 .sat-guide-ver
    if (needQuery) {
        try { TileAPI.sendToHost('checkSatelliteStatus', {}); } catch(_) {}
    }
}

// 安装/失败 host 消息 — 反馈到引导弹窗(如果在开)
TileAPI.onHostMessage('satelliteInstallStarted', function() {
    if (!_guideOverlay) return;
    var status = _guideOverlay.querySelector('#satGuideStatus');
    if (status) status.innerHTML = '<span class="sat-guide-status-ok">✓ 安装脚本已启动, 请关闭 PS 并在 UAC 弹窗点「是」</span>';
});

TileAPI.onHostMessage('satelliteInstallError', function(data) {
    if (!_guideOverlay) return;
    var status = _guideOverlay.querySelector('#satGuideStatus');
    if (status) status.innerHTML = '<span class="sat-guide-status-err">❌ 启动失败: ' + _esc((data && data.error) || '未知') + '</span>';
    var goBtn = _guideOverlay.querySelector('#satGuideGo');
    if (goBtn) { goBtn.disabled = false; goBtn.textContent = '🔄 重试'; }
});

// 公开给 firstrun-satellite 或其他模块
window._showSatelliteInstallGuide = _showInstallGuide;
window._hideSatelliteInstallGuide = _hideInstallGuide;

// 顶层 satelliteStatus 监听 — 不依赖 tile 展开. 主要给 guide 弹窗用 (拉到最新版本号填上去)
TileAPI.onHostMessage('satelliteStatus', function(data) {
    _lastStatus = data || _lastStatus;
    if (!_guideOverlay) return;
    var verEl = _guideOverlay.querySelector('#satGuideVer');
    if (verEl && _lastStatus && _lastStatus.latestVersion) {
        verEl.textContent = ' v' + _lastStatus.latestVersion;
    }
});

function renderFront(container, w, h) {
  var online = !!window.__satelliteSeenOnce;
  var dot = online ? '🟢' : '⚪';
  if (w >= 2) {
    container.innerHTML =
      '<div class="tile-icon">📡</div>' +
      '<div class="tile-label">轮椅遥控器</div>' +
      '<div class="tile-desc">' + dot + ' 卫星插件</div>';
  } else {
    container.innerHTML =
      '<div class="tile-icon">📡</div>' +
      '<div class="tile-label">遥控</div>';
  }
}

function onExpand(container, sizeHint) {
  var online = !!window.__satelliteSeenOnce;

  // 拉一次状态
  TileAPI.sendToHost('checkSatelliteStatus', {});

  function _renderStatusBlock() {
    var s = _lastStatus || {};
    var statusHtml;
    if (!s.installed) {
      statusHtml =
        '<div class="sat-row sat-row-status">' +
          '<span>📦 未安装</span>' +
          '<button class="w10-btn w10-btn-accent" id="satInstall">安装卫星 v' + (s.latestVersion || '?') + '</button>' +
        '</div>';
    } else if (_verCmp(s.installedVersion, s.latestVersion) < 0) {
      statusHtml =
        '<div class="sat-row sat-row-status">' +
          '<span>📦 已装 v' + s.installedVersion + ' → 有新版 v' + s.latestVersion + '</span>' +
          '<button class="w10-btn w10-btn-accent" id="satInstall">升级到 v' + s.latestVersion + '</button>' +
        '</div>';
    } else {
      statusHtml =
        '<div class="sat-row sat-row-status">' +
          '<span>✓ 已安装 v' + s.installedVersion + ' (最新)</span>' +
          '<button class="w10-btn" id="satReinstall" title="重新安装">重装</button>' +
        '</div>';
    }
    return statusHtml;
  }

  function _renderAll() {
    container.innerHTML =
      '<div class="w10-panel sat-panel">' +
        '<div class="sat-section-title">安装状态</div>' +
        _renderStatusBlock() +
        '<div class="sat-row sat-row-status">' +
          '<span>连接状态</span>' +
          '<span class="sat-status ' + (online ? 'is-on' : 'is-off') + '" id="satStatus">' +
            (online ? '🟢 已连接 (运行中)' : '⚪ 未检测到 (panel 未打开)') +
          '</span>' +
        '</div>' +

        '<div class="sat-section-title">外观同步</div>' +
        '<div class="sat-row sat-row-toggle">' +
          '<span style="flex:1">把主插件背景/主题色推到卫星</span>' +
          '<button class="w10-btn w10-btn-accent" id="satSyncTheme">立即同步</button>' +
        '</div>' +

        '<div class="sat-section-title">操作</div>' +
        '<div class="sat-row sat-row-toggle" style="gap:6px;flex-wrap:wrap;">' +
          '<button class="w10-btn" id="satOpenFolder" title="打开 PS Plug-ins\\轮椅遥控器 目录">📂 打开安装目录</button>' +
          '<button class="w10-btn" id="satRefresh" title="重新检查安装状态">🔄 刷新状态</button>' +
          '<button class="w10-btn sat-debug-btn" id="satResetPopups" title="清除「主欢迎窗」和「卫星推荐窗」的已看过标记, 然后立刻重新弹出, 方便调试">🐛 重置弹窗记录</button>' +
        '</div>' +

        '<div class="sat-info" style="margin-top:8px;">' +
          '轮椅遥控器是个独立 PS 浮动 panel, 提供高频按钮 + 任务进度 + 已传回缩略图. ' +
          '安装/升级需要关闭 PS, 安装时会请求管理员权限。<br>' +
          '<br><span style="color:var(--text-sub)">目标目录: <code>' + _esc(_lastStatus && _lastStatus.targetDir || 'PS Plug-ins\\轮椅遥控器') + '</code></span>' +
        '</div>' +
      '</div>';
    _bindButtons();
  }

  function _bindButtons() {
    // 安装/升级 — 走新引导弹窗 (替代以前的 confirm)
    var instBtn = container.querySelector('#satInstall');
    if (instBtn) instBtn.onclick = function() {
      _showInstallGuide({
        version: _lastStatus && _lastStatus.latestVersion,
        reinstall: false
      });
    };
    // 重装
    var reinstBtn = container.querySelector('#satReinstall');
    if (reinstBtn) reinstBtn.onclick = function() {
      _showInstallGuide({
        version: _lastStatus && _lastStatus.installedVersion,
        reinstall: true
      });
    };
    // 同步外观
    var syncBtn = container.querySelector('#satSyncTheme');
    if (syncBtn) syncBtn.onclick = function() {
      if (typeof window._pushSatelliteTheme === 'function') {
        var ok = window._pushSatelliteTheme();
        TileAPI.toast(ok ? '✓ 外观已同步到卫星' : '同步失败', ok ? 'success' : 'error');
      } else {
        TileAPI.toast('卫星未就绪', 'warn');
      }
    };
    // 打开目录
    var folderBtn = container.querySelector('#satOpenFolder');
    if (folderBtn) folderBtn.onclick = function() {
      TileAPI.sendToHost('openSatelliteFolder', {});
    };
    // 刷新状态
    var refreshBtn = container.querySelector('#satRefresh');
    if (refreshBtn) refreshBtn.onclick = function() {
      refreshBtn.textContent = '⏳ 检查中...';
      TileAPI.sendToHost('checkSatelliteStatus', {});
    };

    // 调试: 重置弹窗记录 → 清掉两个 flag, 立刻按顺序重弹 (welcome → satellite)
    var resetBtn = container.querySelector('#satResetPopups');
    if (resetBtn) resetBtn.onclick = function() {
      var hasWelcome = (typeof window._firstrunResetWelcome === 'function');
      var hasSat     = (typeof window._firstrunResetSatellite === 'function');
      if (!hasWelcome && !hasSat) {
        TileAPI.toast('两个弹窗模块都没加载, 无法重置', 'error');
        return;
      }
      // 先清两个 flag (这样 welcome 关闭时 emit 的 welcomeClosed 会触发 satellite 自然接力)
      if (hasWelcome) window._firstrunResetWelcome();
      // satellite 自己的 _waited 也清掉, 不然 emit 来了不响应
      if (hasSat) {
        try { TileAPI.storage.remove('firstrun.satelliteShown'); } catch(_) {}
      }
      TileAPI.toast('✓ 已重置, 主欢迎窗马上弹, 关掉后 2s 弹卫星推荐', 'success', 4500);
    };
  }

  _renderAll();

  // 监听 host 推过来的状态
  var statusHandler = function(data) {
    _lastStatus = data || {};
    _renderAll();
  };
  TileAPI.onHostMessage('satelliteStatus', statusHandler);

  // 监听安装相关消息, 给用户反馈
  var startedHandler = function() {
    var btn = container.querySelector('#satInstall, #satReinstall');
    if (btn) {
      btn.textContent = '✓ 已启动安装脚本, 请按提示操作';
    }
    TileAPI.toast('安装脚本已启动, 请关闭 PS 并在 UAC 弹窗时点"是"', 'info', 6000);
  };
  TileAPI.onHostMessage('satelliteInstallStarted', startedHandler);

  var errHandler = function(data) {
    var btn = container.querySelector('#satInstall, #satReinstall');
    if (btn) { btn.disabled = false; btn.textContent = '重试安装'; }
    TileAPI.toast('安装失败: ' + ((data && data.error) || '未知'), 'error');
  };
  TileAPI.onHostMessage('satelliteInstallError', errHandler);

  // cleanup (展开收起时用)
  return function() {
    TileAPI.offHostMessage('satelliteStatus', statusHandler);
    TileAPI.offHostMessage('satelliteInstallStarted', startedHandler);
    TileAPI.offHostMessage('satelliteInstallError', errHandler);
  };
}

// 监听 IPC 命令, 标记卫星上线 (任何卫星命令都说明它活着)
TileAPI.onHostMessage('ipcCommand', function(data) {
  if (data && data.action) {
    window.__satelliteSeenOnce = true;
  }
});

TileAPI.registerTile({
  id: 'satellite',
  icon: '📡',
  label: '轮椅遥控器',
  desc: '卫星插件控制',
  group: 'main',
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 2, h: 2 },
  renderFront: renderFront,
  onExpand: onExpand
});

})();
