/**
 * tile-drawer.js — 抽屉磁贴
 * 桌面上的一个 1x1 大卡片,用来收纳不常用磁贴
 * - 任何磁贴都可以通过编辑栏「移入抽屉」或拖拽到抽屉上收纳
 * - 展开抽屉后显示已收纳磁贴,点击其中一个即放回桌面
 * - 抽屉里的磁贴保留原始颜色/大小/设置
 * - 抽屉本身和 settings 不允许被收纳
 */
(function() {
'use strict';

var STASH_KEY = '__tile_drawer_stash_v6';

// 不允许被收纳的磁贴(核心/自身)
var PROTECTED = { drawer: true, settings: true };

function _load() {
  var arr = window._storageManager ? window._storageManager.get(STASH_KEY) : null;
  return Array.isArray(arr) ? arr : [];
}

function _save(list) {
  if (window._storageManager) window._storageManager.set(STASH_KEY, list);
}

function _updateBadge() {
  var list = _load();
  TileAPI.emit('drawer:changed', { count: list.length, list: list.slice() });
  if (window.TileEngine && TileEngine.updateBadge) {
    TileEngine.updateBadge('drawer', list.length > 0 ? String(list.length) : '');
  }
  // 更新磁贴背面计数
  if (window.TileEngine && TileEngine.updateBack) {
    TileEngine.updateBack('drawer', '共 ' + list.length + ' 项');
  }
}

var TileDrawer = {
  /** 查询抽屉列表 */
  list: function() { return _load(); },
  has: function(tileId) { return _load().indexOf(tileId) >= 0; },
  isProtected: function(tileId) {
    if (PROTECTED[tileId]) return true;
    // pinTop 锁定磁贴一律不能收纳
    var def = TileAPI.getTileDef && TileAPI.getTileDef(tileId);
    if (def && def.pinTop) return true;
    return false;
  },
  count: function() { return _load().length; },

  /** 把磁贴放入抽屉 */
  stash: function(tileId) {
    if (this.isProtected(tileId)) { TileAPI.toast('该磁贴不能收纳', 'warn'); return false; }
    var list = _load();
    if (list.indexOf(tileId) < 0) list.push(tileId);
    _save(list);

    // 从桌面移除 DOM — 先播缩小淡出再摘, 别凭空消失
    var el = TileEngine.getTileElement(tileId);
    if (el) {
      var parent = el.parentElement;
      if (parent) {
        el.style.transition = 'transform 0.18s ease, opacity 0.18s ease';
        el.style.transform = 'scale(0.6)';
        el.style.opacity = '0';
        setTimeout(function() {
          if (el.parentElement) el.parentElement.removeChild(el);
          el.style.transition = ''; el.style.transform = ''; el.style.opacity = '';
        }, 190);
      }
    }
    // 如果磁贴此刻在某个文件夹里,同步把它从文件夹里剔除
    if (window.GroupManager && GroupManager.removeTileFromAllFolders) {
      GroupManager.removeTileFromAllFolders(tileId);
    }

    _updateBadge();
    _refreshPanel();
    return true;
  },

  /** 从抽屉取回到桌面 */
  restore: function(tileId) {
    var list = _load();
    var idx = list.indexOf(tileId);
    if (idx < 0) return false;
    list.splice(idx, 1);
    _save(list);

    var tileDef = TileAPI.getTileDef(tileId);
    var grid = document.getElementById('mainGrid');
    var el = null;
    if (tileDef && grid) {
      el = TileEngine.getTileElement(tileId);
      if (!el) {
        // 重新渲染
        el = TileEngine.renderTile(tileDef, grid);
      } else if (!el.parentElement) {
        grid.appendChild(el);
        TileEngine.applyPos(el);
      }
    }
    // 落位 pop 动画: 从小到大弹出来, 和收纳的缩小淡出对称。
    // Dock 拉起走"restore→立即全屏展开"链路, 展开中不能碰 transition(会打断展开动画)
    if (el && !el.classList.contains('expanding') && !el.classList.contains('expanded')) {
      el.style.transition = 'none';
      el.style.transform = 'scale(0.6)';
      el.style.opacity = '0';
      requestAnimationFrame(function() {
        if (el.classList.contains('expanding') || el.classList.contains('expanded')) {
          // 已被展开流程接管 → 立即还原, 别留半截样式
          el.style.transition = ''; el.style.transform = ''; el.style.opacity = '';
          return;
        }
        el.style.transition = 'transform 0.22s cubic-bezier(.34,1.4,.5,1), opacity 0.18s ease';
        el.style.transform = '';
        el.style.opacity = '';
        setTimeout(function() {
          if (!el.classList.contains('expanding') && !el.classList.contains('expanded')) el.style.transition = '';
        }, 240);
      });
    }
    // 保存新布局
    if (window.TileEngine && TileEngine.saveLayout) TileEngine.saveLayout();
    _updateBadge();
    _refreshPanel();
    return true;
  },
};

// ========== 抽屉展开面板渲染 ==========

var _panelContainer = null;   // 当前展开面板的 DOM 容器(onExpand 收到的 container)

function _renderPanel(container) {
  _panelContainer = container;
  var list = _load();

  container.innerHTML =
    '<div class="drawer-panel">' +
      '<div class="drawer-panel-head">' +
        '<div class="drawer-title">\u6536\u7eb3\u62bd\u5c49</div>' +
        '<div class="drawer-hint">\u70b9\u51fb\u78c1\u8d34\u5c06\u5176\u653e\u56de\u684c\u9762</div>' +
      '</div>' +
      '<div class="drawer-grid" id="drawerGrid"></div>' +
    '</div>';

  var gridEl = container.querySelector('#drawerGrid');
  if (!gridEl) return;

  if (!list.length) {
    gridEl.innerHTML = '<div class="drawer-empty">\u62bd\u5c49\u4e3a\u7a7a<br><span class="drawer-empty-sub">\u5728\u7f16\u8f91\u6a21\u5f0f\u4e0b\u9009\u4e2d\u78c1\u8d34\uff0c\u70b9\u5e95\u680f\u300c\u79fb\u5165\u62bd\u5c49\u300d\u6216\u76f4\u63a5\u62d6\u5230\u672c\u78c1\u8d34\u4e0a</span></div>';
    return;
  }

  list.forEach(function(tileId) {
    var tileDef = TileAPI.getTileDef(tileId);
    if (!tileDef) return;
    var card = document.createElement('div');
    card.className = 'drawer-card';
    card.dataset.tileId = tileId;

    // 读取保存的颜色还原外观
    var colors = window._storageManager ? window._storageManager.get('__tile_colors') || {} : {};
    var hsl = colors[tileId];
    if (hsl && hsl.h !== undefined) {
      var cs = getComputedStyle(document.documentElement).getPropertyValue('--tile-color-opacity');
      var a = parseFloat(cs); if (isNaN(a)) a = 0.1;
      var b = Math.min(1, a * 2.5).toFixed(3);
      card.style.background = 'hsla(' + hsl.h + ',' + hsl.s + '%,' + hsl.l + '%,' + a + ')';
      card.style.borderColor = 'hsla(' + hsl.h + ',' + hsl.s + '%,' + hsl.l + '%,' + b + ')';
    }

    card.innerHTML =
      '<div class="drawer-card-icon">' + (tileDef.icon || '?') + '</div>' +
      '<div class="drawer-card-label">' + (tileDef.label || tileId) + '</div>';

    card.addEventListener('click', function(e) {
      e.stopPropagation();
      TileDrawer.restore(tileId);
      TileAPI.toast('\u5df2\u653e\u56de\u684c\u9762', 'success');
    });

    gridEl.appendChild(card);
  });
}

function _refreshPanel() {
  if (_panelContainer && _panelContainer.isConnected) {
    _renderPanel(_panelContainer);
  }
}

// ========== 磁贴注册 ==========

TileAPI.registerTile({
  id: 'drawer',
  group: 'main',
  icon: '\uD83D\uDDC4\uFE0F',  // 🗄️
  label: '\u62bd\u5c49',
  desc: '\u6536\u7eb3\u4e0d\u5e38\u7528',
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderBack: function(container) {
    container.textContent = '\u5171 ' + TileDrawer.count() + ' \u9879';
  },

  onExpand: function(container) {
    _renderPanel(container);
  },

  onCollapse: function() {
    _panelContainer = null;
  },

  onStorageLoaded: function() {
    // 磁贴 DOM 稍后才渲染好,延迟刷 badge
    setTimeout(_updateBadge, 300);
  },
});

window.TileDrawer = TileDrawer;
})();
