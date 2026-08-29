// ============================================================
//  tile-layout.js — 布局快照磁贴
//  保存/切换/删除界面布局(磁贴位置/颜色/外观/文件夹/抽屉/主题)
// ============================================================
(function() {
'use strict';

// 一套布局包含的 storage key(跟 layout-migration.js 保持一致)
var LAYOUT_KEYS = [
  '__tile_layout_v6',
  '__tile_expand_modes',
  '__tile_colors',
  '__tile_folders_v6',
  '__tile_drawer_stash_v6',
  'appearance.themeColor',
  'appearance.blur',
  'appearance.opacity',
  'appearance.tileColorOpacity',
  // v6.5.8: Dock 配置也随布局走(钉了哪些按钮/位置/大小/透明度)
  // 老快照没这些键 → apply 时跳过不动(保持现状, 不清默认)
  'dock.items',
  'dock.side',
  'dock.scale',
  'dock.iconScale',
  'dock.opacity',
  'dock.blur'
];

var _factoryLayouts = [];
var _userLayouts = [];
var _activeContainer = null;
var _pendingReload = false;  // 应用布局后等 host 同步落盘,收到 storageFlushDone 才 reload

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 抓取当前界面状态
function _captureCurrentLayout() {
  var data = {};
  LAYOUT_KEYS.forEach(function(key) {
    var v = TileAPI.storage.get(key);
    if (v !== null && v !== undefined) data[key] = v;
  });
  return data;
}

// 把布局数据写入 storage
function _applyLayout(data) {
  if (!data) return;
  LAYOUT_KEYS.forEach(function(key) {
    if (data[key] !== undefined) {
      TileAPI.storage.set(key, data[key]);
    } else if (key.indexOf('dock.') === 0) {
      // v6.5.8: dock 键缺失 = 老版本快照(当年没存 Dock) → 保持用户现状, 不清
      // (磁贴类键仍清除 — 工厂布局没文件夹就该清文件夹, 语义不同)
    } else {
      // 布局数据里没这个 key → 清除当前用户的对应值,避免脏数据残留
      // (例如:工厂布局没有 __tile_folders_v6,应用后用户的文件夹也清掉)
      TileAPI.storage.remove(key);
    }
  });
}

// 写入布局 + 请求宿主落盘 + reload (工厂/用户/恢复快照 都复用这一条)
//   必须等宿主把 storageSet 落盘 (storageFlushDone) 才 reload, 否则磁盘上是旧文件, API key 会丢
function _applyDataAndReload(data) {
  _applyLayout(data || {});
  _pendingReload = true;
  _showReloadCurtain();
  TileAPI.sendToHost('storageFlush', {});
  setTimeout(function() {
    if (_pendingReload) {
      _pendingReload = false;
      try { location.reload(); } catch(e) {}
    }
  }, 8000);
}

// reload 前盖一层淡入遮罩: 把"整个插件黑屏重启"变成有预期的转场。
// reload 后启动遮罩会自然接管, 用户看到的是 遮罩→启动loading→新布局, 没有裸黑屏。
function _showReloadCurtain() {
  try {
    if (document.getElementById('layoutReloadCurtain')) return;
    var cur = document.createElement('div');
    cur.id = 'layoutReloadCurtain';
    cur.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999999;' +
      'background:rgba(18,18,18,0.96);display:flex;align-items:center;justify-content:center;' +
      'color:rgba(255,255,255,0.75);font-size:13px;opacity:0;transition:opacity 0.25s ease;';
    cur.textContent = '正在切换布局...';
    document.body.appendChild(cur);
    requestAnimationFrame(function() { cur.style.opacity = '1'; });
  } catch (_) {}
}

// 主动刷新列表
function _requestScan() {
  TileAPI.sendToHost('layoutScan', {});
}

function _renderPanel(container) {
  container.innerHTML =
    '<div class="w10-panel">' +
      '<div class="layout-section-bar">' +
        '<div class="w10-section-title" style="margin:0;">📐 布局快照</div>' +
        '<div style="display:flex;gap:4px;">' +
          '<button class="w10-btn w10-btn-accent" id="layoutSaveBtn" title="把当前界面保存为新布局">+ 保存当前</button>' +
          '<button class="w10-btn" id="layoutRefreshBtn" title="刷新列表">🔄</button>' +
          '<button class="w10-btn" id="layoutFolderBtn" title="打开用户布局文件夹">📁</button>' +
        '</div>' +
      '</div>' +
      '<div class="w10-row-desc" style="padding:4px 0 8px;color:var(--text-sub);font-size:11px;line-height:1.5;">' +
        '点击布局 → 应用; 包含磁贴位置/颜色/展开模式/文件夹/抽屉/主题/外观。' +
      '</div>' +
      '<div id="layoutUndoArea"></div>' +
      '<div id="layoutFactoryArea"></div>' +
      '<div id="layoutUserArea" style="margin-top:8px;"></div>' +
    '</div>';

  _bindButtons(container);
  _renderLists(container);
  _requestScan();
}

function _renderLists(container) {
  var fa = container.querySelector('#layoutFactoryArea');
  var ua = container.querySelector('#layoutUserArea');
  if (!fa || !ua) return;

  // 恢复行: 应用过布局才有快照, 放在最上面
  var undoArea = container.querySelector('#layoutUndoArea');
  if (undoArea) {
    var snap = TileAPI.storage.get('__layout_undo_snapshot');
    if (snap) {
      undoArea.innerHTML =
        '<div class="layout-row layout-row-undo" id="layoutUndoRow">' +
          '<div class="layout-row-info">' +
            '<div class="layout-row-name">↶ 恢复我之前的布局</div>' +
            '<div class="layout-row-desc">切换布局前的样子</div>' +
          '</div>' +
          '<div class="layout-row-actions">' +
            '<button class="w10-btn w10-btn-accent" id="layoutUndoBtn" style="padding:2px 10px;">恢复</button>' +
          '</div>' +
        '</div>';
      var undoBtn = container.querySelector('#layoutUndoBtn');
      if (undoBtn) undoBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var s = TileAPI.storage.get('__layout_undo_snapshot');
        if (!s) { TileAPI.toast('没有可恢复的布局', 'warn'); return; }
        // 恢复前再快照当前 (允许链式来回切)
        TileAPI.storage.set('__layout_undo_snapshot', _captureCurrentLayout());
        TileAPI.toast('正在恢复之前的布局,即将刷新...', 'success');
        _applyDataAndReload(s);
      });
    } else {
      undoArea.innerHTML = '';
    }
  }

  // 工厂区
  if (_factoryLayouts.length === 0) {
    fa.innerHTML = '<div class="w10-section-title" style="opacity:0.6;font-size:10px;">⭐ 内置布局</div>' +
      '<div style="color:var(--text-sub);font-size:11px;padding:4px 8px;">未发现工厂布局</div>';
  } else {
    var fhtml = '<div class="w10-section-title" style="opacity:0.8;font-size:10px;">⭐ 内置布局 (' + _factoryLayouts.length + ')</div>';
    _factoryLayouts.forEach(function(l) { fhtml += _renderLayoutRow(l, false); });
    fa.innerHTML = fhtml;
  }

  // 用户区
  if (_userLayouts.length === 0) {
    ua.innerHTML = '<div class="w10-section-title" style="opacity:0.8;font-size:10px;">👤 我保存的</div>' +
      '<div style="color:var(--text-sub);font-size:11px;padding:4px 8px;">还没有保存的布局。先排好界面,再点上方"+保存当前"。</div>';
  } else {
    var uhtml = '<div class="w10-section-title" style="opacity:0.8;font-size:10px;">👤 我保存的 (' + _userLayouts.length + ')</div>';
    _userLayouts.forEach(function(l) { uhtml += _renderLayoutRow(l, true); });
    ua.innerHTML = uhtml;
  }

  _bindRowActions(container);
}

function _renderLayoutRow(layout, isUser) {
  var info = layout.desc ? layout.desc : (isUser ? ('保存于 ' + (layout.createdAt || '').slice(0, 10)) : '');
  var deleteBtn = isUser
    ? '<button class="w10-btn layout-row-del" data-fn="' + _esc(layout.fileName) + '" title="删除" style="padding:2px 8px;color:#ff6b6b;">×</button>'
    : '';
  return '<div class="layout-row" data-fn="' + _esc(layout.fileName) + '" data-isfactory="' + (isUser ? '0' : '1') + '">' +
    '<div class="layout-row-info">' +
      '<div class="layout-row-name">' + _esc(layout.name) + '</div>' +
      (info ? '<div class="layout-row-desc">' + _esc(info) + '</div>' : '') +
    '</div>' +
    '<div class="layout-row-actions">' +
      '<button class="w10-btn w10-btn-accent layout-row-apply" data-fn="' + _esc(layout.fileName) + '" data-isfactory="' + (isUser ? '0' : '1') + '" style="padding:2px 10px;">应用</button>' +
      deleteBtn +
    '</div>' +
  '</div>';
}

function _bindButtons(container) {
  var saveBtn = container.querySelector('#layoutSaveBtn');
  if (saveBtn) saveBtn.addEventListener('click', function() {
    TileAPI.prompt('给当前布局起个名字:', { defaultValue: '我的布局 ' + new Date().toLocaleDateString() }).then(function(name) {
      if (!name) return;
      name = String(name).trim();
      if (!name) return;
      var data = _captureCurrentLayout();
      TileAPI.sendToHost('layoutSaveUser', { name: name, desc: '', data: data });
    });
  });

  var refreshBtn = container.querySelector('#layoutRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', function() {
    _requestScan();
    TileAPI.toast('正在刷新...', 'info');
  });

  var folderBtn = container.querySelector('#layoutFolderBtn');
  if (folderBtn) folderBtn.addEventListener('click', function() {
    TileAPI.sendToHost('layoutOpenUserFolder', {});
  });
}

function _bindRowActions(container) {
  // 应用按钮
  container.querySelectorAll('.layout-row-apply').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var fn = btn.dataset.fn;
      var isFactory = btn.dataset.isfactory === '1';
      _applyByFile(fn, isFactory);
    });
  });
  // 删除按钮(仅用户布局)
  container.querySelectorAll('.layout-row-del').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var fn = btn.dataset.fn;
      TileAPI.confirm('确定删除这个布局?').then(function(ok) {
        if (!ok) return;
        TileAPI.sendToHost('layoutDeleteUser', { fileName: fn });
      });
    });
  });
}

function _applyByFile(fileName, isFactory) {
  TileAPI.confirm('应用这个布局会覆盖当前的磁贴位置、颜色、文件夹、外观等设置(API Key/历史/预设不会丢)。继续?').then(function(ok) {
    if (!ok) return;
    // 应用前先快照当前布局, 让用户能"↶ 恢复我之前的布局"
    TileAPI.storage.set('__layout_undo_snapshot', _captureCurrentLayout());
    TileAPI.sendToHost('layoutLoad', { fileName: fileName, isFactory: isFactory });
  });
}

// ========== 磁贴注册 ==========

function renderFront(container, w, h) {
  if (w >= 2) {
    container.innerHTML =
      '<div class="tile-icon">📐</div>' +
      '<div class="tile-label">布局快照</div>' +
      '<div class="tile-desc">保存/切换界面排布</div>';
  } else {
    container.innerHTML =
      '<div class="tile-icon">📐</div>' +
      '<div class="tile-label">布局</div>';
  }
}

TileAPI.registerTile({
  id: 'layout',
  noGrid: true,          // 入口已挪到顶栏 ☰ 按钮, 不在主网格显示 (但保留注册, onMessage 继续收广播)
  group: 'main',
  icon: '📐',
  label: '布局快照',
  desc: '保存/切换界面排布',
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderFront: renderFront,

  onExpand: function(container) {
    _activeContainer = container;
    _renderPanel(container);
    return function() { if (_activeContainer === container) _activeContainer = null; };
  },

  onCollapse: function() { _activeContainer = null; },

  onMessage: function(action, data) {
    if (action === 'layoutScanResult') {
      _factoryLayouts = (data && data.factoryLayouts) || [];
      _userLayouts = (data && data.userLayouts) || [];
      if (_activeContainer) _renderLists(_activeContainer);
    }

    if (action === 'layoutLoadResult') {
      if (!data || !data.success) {
        TileAPI.toast('加载布局失败: ' + ((data && data.error) || '未知错误'), 'error');
        return;
      }
      var layout = data.layout || {};
      TileAPI.toast('已应用布局: ' + (layout.name || '?') + ',即将刷新...', 'success');
      _applyDataAndReload(layout.data || {});
    }

    if (action === 'storageFlushDone') {
      if (_pendingReload) {
        _pendingReload = false;
        // 给后端一个短暂的呼吸时间,确保 sendToPanel 之后没有挂着的微任务
        setTimeout(function() {
          try { location.reload(); } catch(e) {}
        }, 50);
      }
    }

    if (action === 'layoutSaveResult') {
      if (data && data.success) {
        TileAPI.toast('布局已保存', 'success');
        _requestScan();
      } else {
        TileAPI.toast('保存失败: ' + ((data && data.error) || '未知错误'), 'error');
      }
    }

    if (action === 'layoutDeleteResult') {
      if (data && data.success) {
        TileAPI.toast('已删除', 'info');
        _requestScan();
      } else {
        TileAPI.toast('删除失败: ' + ((data && data.error) || '未知错误'), 'error');
      }
    }
  },

  onStorageLoaded: function() {
    // 启动时不主动 scan,等用户展开磁贴再扫
  }
});

// ========== 公开 API: 供顶栏 ☰ 按钮调用 (布局磁贴已 noGrid, 入口挪到顶栏) ==========
window._layoutModule = {
  openInto: function(container) {
    if (!container) return;
    _activeContainer = container;
    _renderPanel(container);   // 内部已 _bindButtons + _renderLists + _requestScan
  },
  close: function() {
    _activeContainer = null;
  },
  isOpen: function() {
    return !!_activeContainer;
  },
  requestScan: function() {
    _requestScan();
  }
};

})();
