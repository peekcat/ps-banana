/**
 * group-manager.js — 文件夹系统
 * 文件夹是一个1x1磁贴，内部切割为2x2或3x3显示小图标
 * 点击小图标直接展开对应磁贴
 * 编辑模式下可从文件夹拖出磁贴
 * 最多9个磁贴，≤4个显示2x2，5-9个显示3x3
 */
(function() {
'use strict';

var _folders = {};  // folderId -> { label, tileIds[] }
var FOLDERS_KEY = '__tile_folders_v6';

var GroupManager = {
  init: function(containerEl) {
    this._container = containerEl;
    this._loadFolders();
  },

  /** 渲染主grid */
  render: function() {
    this._container.innerHTML = '';

    // 顶栏 host: sticky 钉在 vp 顶部, 跟主网格平级.
    // pinTop 磁贴 (tile-topbar) 渲染到这里, 不参与 grid 布局.
    var topbarHost = document.createElement('div');
    topbarHost.id = 'topbarHost';
    this._container.appendChild(topbarHost);

    // ☰ 布局按钮: 作为 #topbarHost 的独立子元素 (跟顶栏 tile 平级, 不是它的后代).
    // 这样点击不会冒泡到顶栏 tile (避免误触发顶栏展开), 也不受顶栏 live flip 重建 DOM 影响.
    var layoutBtn = document.createElement('div');
    layoutBtn.className = 'topbar-layout-btn';
    layoutBtn.id = 'topbarLayoutBtn';
    layoutBtn.title = '布局快照';
    layoutBtn.textContent = '☰';   // ☰
    topbarHost.appendChild(layoutBtn);
    layoutBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (typeof window._topbarToggleLayoutPanel === 'function') window._topbarToggleLayoutPanel();
    });

    // 布局面板就地展开容器: 夹在 #topbarHost (sticky) 和 #mainGrid 之间.
    // 在文档流里, 展开时把主网格往下推 (跟磁贴 inline-expand 同款体验). 默认收起.
    var layoutPanel = document.createElement('div');
    layoutPanel.id = 'topbarLayoutPanel';
    layoutPanel.style.display = 'none';
    this._container.appendChild(layoutPanel);

    var grid = document.createElement('div');
    grid.className = 'grid';
    grid.id = 'mainGrid';
    grid.dataset.groupId = 'main';
    this._container.appendChild(grid);

    var dropInd = document.createElement('div');
    dropInd.className = 'drop-ind';
    dropInd.id = 'dropInd';
    dropInd.style.display = 'none';
    grid.appendChild(dropInd);
  },

  /** 渲染所有磁贴到主grid */
  renderTiles: function() {
    var grid = document.getElementById('mainGrid');
    if (!grid) return;

    // 收集在文件夹里的磁贴ID
    var inFolder = {};
    var folderIds = Object.keys(_folders);
    folderIds.forEach(function(fid) {
      (_folders[fid].tileIds || []).forEach(function(tid) { inFolder[tid] = fid; });
    });

    // 渲染文件夹磁贴
    folderIds.forEach(function(fid) {
      _renderFolderTile(_folders[fid], fid, grid);
    });

    // 渲染不在文件夹里 / 不在抽屉里的普通磁贴
    var stashed = (window.TileDrawer && TileDrawer.list) ? TileDrawer.list() : [];
    var inDrawer = {};
    stashed.forEach(function(tid) { inDrawer[tid] = true; });

    var tiles = TileAPI.getAllTiles();
    tiles.forEach(function(tileDef) {
      if (tileDef.noGrid) return;          // noGrid 磁贴 (如 layout, 入口已挪到顶栏 ☰) 不进主网格
      if (inFolder[tileDef.id]) return;
      if (inDrawer[tileDef.id]) return;
      TileEngine.renderTile(tileDef, grid);
    });

    TileEngine.restoreLayout();
  },

  /** 创建文件夹 */
  createFolder: function(label) {
    var fid = 'folder_' + Date.now();
    _folders[fid] = { label: label || '文件夹', tileIds: [] };
    this._saveFolders();

    var grid = document.getElementById('mainGrid');
    if (grid) _renderFolderTile(_folders[fid], fid, grid);
    return fid;
  },

  /** 把磁贴加入文件夹 */
  addTileToFolder: function(tileId, folderId) {
    var folder = _folders[folderId];
    if (!folder) return;
    if (folder.tileIds.length >= 9) return; // 最多9个
    this.removeTileFromAllFolders(tileId);
    folder.tileIds.push(tileId);
    this._saveFolders();

    // 从主grid移除磁贴DOM
    var el = TileEngine.getTileElement(tileId);
    if (el && el.parentElement) el.parentElement.removeChild(el);

    _refreshFolderDisplay(folderId);
  },

  /** 从文件夹移出磁贴 */
  removeTileFromFolder: function(tileId, folderId) {
    var folder = _folders[folderId];
    if (!folder) return;
    var idx = folder.tileIds.indexOf(tileId);
    if (idx >= 0) folder.tileIds.splice(idx, 1);
    this._saveFolders();

    // 把磁贴渲染回主grid
    var tileDef = TileAPI.getTileDef(tileId);
    var grid = document.getElementById('mainGrid');
    if (tileDef && grid) {
      var el = TileEngine.renderTile(tileDef, grid);
      el.dataset.w = '1'; el.dataset.h = '1';
      TileEngine.applyPos(el);
    }

    // 自动解散：如果只剩0-1个磁贴
    if (folder.tileIds.length <= 1) {
      this._dissolveFolder(folderId);
    } else {
      _refreshFolderDisplay(folderId);
    }
  },

  /** 从所有文件夹移除 */
  removeTileFromAllFolders: function(tileId) {
    Object.keys(_folders).forEach(function(fid) {
      var idx = _folders[fid].tileIds.indexOf(tileId);
      if (idx >= 0) _folders[fid].tileIds.splice(idx, 1);
    });
  },

  /** 删除文件夹 */
  deleteFolder: function(folderId) {
    this._dissolveFolder(folderId);
  },

  /** 查询 */
  getFolder: function(folderId) { return _folders[folderId] || null; },
  getAllFolders: function() { return _folders; },
  getFolderForTile: function(tileId) {
    var fids = Object.keys(_folders);
    for (var i = 0; i < fids.length; i++) {
      if (_folders[fids[i]].tileIds.indexOf(tileId) >= 0) return fids[i];
    }
    return null;
  },

  /** 自动解散文件夹 */
  _dissolveFolder: function(folderId) {
    var folder = _folders[folderId];
    if (!folder) return;
    var grid = document.getElementById('mainGrid');
    var folderEl = document.querySelector('.tile-folder[data-folder-id="' + folderId + '"]');
    var col = folderEl ? (+folderEl.dataset.col || 1) : 1;
    var row = folderEl ? (+folderEl.dataset.row || 1) : 1;

    // 把剩余磁贴放回grid
    (folder.tileIds || []).forEach(function(tid) {
      var tileDef = TileAPI.getTileDef(tid);
      if (tileDef && grid) {
        var el = TileEngine.renderTile(tileDef, grid);
        el.dataset.col = col; el.dataset.row = row;
        el.dataset.w = '1'; el.dataset.h = '1';
        TileEngine.applyPos(el);
      }
    });

    // 移除文件夹DOM
    if (folderEl) folderEl.remove();
    delete _folders[folderId];
    this._saveFolders();

    // 解决碰撞
    if (grid) TileEngine.pushDown(null, grid);
  },

  _loadFolders: function() {
    var saved = window._storageManager ? window._storageManager.get(FOLDERS_KEY) : null;
    if (saved) _folders = saved;
  },

  _saveFolders: function() {
    if (window._storageManager) window._storageManager.set(FOLDERS_KEY, _folders);
  },
};

/** 渲染文件夹磁贴 */
function _renderFolderTile(folder, folderId, gridEl) {
  var el = document.createElement('div');
  el.className = 'tile tile-folder';
  el.dataset.id = 'folder_' + folderId;
  el.dataset.folderId = folderId;
  el.dataset.col = '1'; el.dataset.row = '1';
  el.dataset.w = '1'; el.dataset.h = '1';

  // 光照追踪
  var reveal = document.createElement('div');
  reveal.className = 'tile-reveal';
  el.appendChild(reveal);

  // 内容区：小图标网格
  var inner = document.createElement('div');
  inner.className = 'tile-inner folder-grid-inner';
  el.appendChild(inner);

  // 删除按钮（编辑模式下可见）
  var delBtn = document.createElement('div');
  delBtn.className = 'folder-delete-btn';
  delBtn.textContent = '×';
  delBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    GroupManager.deleteFolder(folderId);
    TileAPI.toast('文件夹已删除', 'info');
  });
  el.appendChild(delBtn);

  // 关闭按钮（展开用）
  var closeBtn = document.createElement('span');
  closeBtn.className = 'tile-expand-close';
  closeBtn.innerHTML = '×';
  el.appendChild(closeBtn);

  // 展开内容区（组内磁贴展开时用）
  var expandContent = document.createElement('div');
  expandContent.className = 'tile-expand-content';
  el.appendChild(expandContent);

  gridEl.appendChild(el);

  // 文件夹也是布局项。优先恢复保存位置，首次创建时才自动排列。
  var savedLayout = window._storageManager ? window._storageManager.getLayout() : null;
  var savedPos = savedLayout && savedLayout[el.dataset.id];
  var pos = savedPos
    ? { col: +savedPos.col || 1, row: +savedPos.row || 1 }
    : TileEngine.autoPlace(gridEl, 1, 1);
  el.dataset.col = pos.col; el.dataset.row = pos.row;
  TileEngine.applyPos(el);

  // === 注册长按进入编辑模式 + 拖拽 ===
  var _lp = null, _lx2 = 0, _ly2 = 0;
  el.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    if (e.target.closest('.folder-cell-filled')) return;
    if (e.target.closest('.tile-expand-close')) return;
    if (e.target.closest('.folder-delete-btn')) return;
    _lx2 = e.clientX; _ly2 = e.clientY;
    _lp = setTimeout(function() {
      TileEngine.enterEdit();
      TileEngine.beginDrag(el, e);
    }, 400);
  });
  el.addEventListener('mousemove', function(e) { if (_lp && (Math.abs(e.clientX - _lx2) > 4 || Math.abs(e.clientY - _ly2) > 4)) { clearTimeout(_lp); _lp = null; } });
  el.addEventListener('mouseup', function() { if (_lp) { clearTimeout(_lp); _lp = null; } });
  el.addEventListener('mouseleave', function() { if (_lp) { clearTimeout(_lp); _lp = null; } });

  // 关闭按钮
  closeBtn.addEventListener('click', function(e) { e.stopPropagation(); TileEngine.collapse(); });

  // 悬停轻微放大(与普通磁贴一致, 不偏转)
  el.addEventListener('mousemove', function(e) {
    if (el.classList.contains('expanded') || el.classList.contains('expanding') || el.classList.contains('edit-mode')) return;
    var r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    el.style.transform = 'scale(1.02)';
    var rv = el.querySelector('.tile-reveal');
    if (rv) { rv.style.setProperty('--mx', x + 'px'); rv.style.setProperty('--my', y + 'px'); }
  });
  el.addEventListener('mouseleave', function() {
    if (!el.classList.contains('expanded') && !el.classList.contains('expanding') && !el.classList.contains('edit-mode')) el.style.transform = '';
  });

  _refreshFolderDisplay(folderId);
}

/** 刷新文件夹内小图标 */
function _refreshFolderDisplay(folderId) {
  var folder = _folders[folderId];
  if (!folder) return;
  var el = document.querySelector('.tile-folder[data-folder-id="' + folderId + '"]');
  if (!el) return;
  var inner = el.querySelector('.folder-grid-inner');
  if (!inner) return;

  var ids = folder.tileIds || [];
  var gridSize = ids.length > 4 ? 3 : 2; // 2x2 or 3x3

  inner.innerHTML = '';
  inner.className = 'tile-inner folder-grid-inner folder-grid-' + gridSize;

  for (var i = 0; i < gridSize * gridSize; i++) {
    var cell = document.createElement('div');
    cell.className = 'folder-cell';

    if (i < ids.length) {
      var tileDef = TileAPI.getTileDef(ids[i]);
      cell.dataset.tileId = ids[i];
      cell.innerHTML = '<span class="folder-cell-icon">' + (tileDef ? tileDef.icon || '?' : '?') + '</span>';
      cell.classList.add('folder-cell-filled');

      // 点击小图标 → 展开对应磁贴（非编辑模式）
      // 长按小图标 → 拖出文件夹（编辑模式）
      (function(tid, cellEl) {
        var _pressTimer = null;
        cellEl.addEventListener('click', function(e) {
          e.stopPropagation();
          if (el.classList.contains('edit-mode')) return;
          // 用文件夹磁贴作为宿主展开，渲染目标磁贴的内容
          _expandFolderChildTile(el, folderId, tid);
        });
        cellEl.addEventListener('mousedown', function(e) {
          e.stopPropagation(); // 始终阻止冒泡到文件夹的长按
          if (!el.classList.contains('edit-mode')) return;
          _pressTimer = setTimeout(function() {
            _pressTimer = null;
            // 拖出文件夹
            GroupManager.removeTileFromFolder(tid, folderId);
            TileAPI.toast('已从文件夹移出', 'info');
          }, 400);
        });
        cellEl.addEventListener('mouseup', function() { if (_pressTimer) { clearTimeout(_pressTimer); _pressTimer = null; } });
        cellEl.addEventListener('mouseleave', function() { if (_pressTimer) { clearTimeout(_pressTimer); _pressTimer = null; } });
      })(ids[i], cell);
    }

    inner.appendChild(cell);
  }
}

/** 展开文件夹内的子磁贴：隐藏文件夹，从原位1x1直接展开 */
function _expandFolderChildTile(folderEl, folderId, tileId) {
  var folder = _folders[folderId];
  if (!folder) return;

  var grid = document.getElementById('mainGrid');
  if (!grid) return;

  var tileDef = TileAPI.getTileDef(tileId);
  if (!tileDef) return;

  var col = +folderEl.dataset.col || 1;
  var row = +folderEl.dataset.row || 1;

  // 瞬间隐藏文件夹
  folderEl.style.opacity = '0';
  folderEl.style.pointerEvents = 'none';

  // 渲染目标磁贴到grid，强制1x1放在文件夹位置
  var el = TileEngine.renderTile(tileDef, grid);
  el.dataset.col = col; el.dataset.row = row;
  el.dataset.w = '1'; el.dataset.h = '1';
  TileEngine.applyPos(el);

  // 包装onCollapse：收缩后清理
  var origCollapse = tileDef.onCollapse;
  tileDef.onCollapse = function() {
    if (origCollapse) origCollapse();
    setTimeout(function() {
      // 移除临时磁贴
      if (el.parentElement) el.parentElement.removeChild(el);
      // 恢复文件夹显示
      folderEl.style.opacity = '';
      folderEl.style.pointerEvents = '';
      // 确保tileId还在folder里
      if (folder.tileIds.indexOf(tileId) < 0) folder.tileIds.push(tileId);
      GroupManager._saveFolders();
      _refreshFolderDisplay(folderId);
      tileDef.onCollapse = origCollapse;
    }, 350);
  };

  // 直接展开（从1x1位置开始）
  TileEngine.expand(el);
}

// 监听编辑模式 — 刷新文件夹显示（编辑模式下cell显示不同样式）
TileAPI.on('editMode:enter', function() {});
TileAPI.on('editMode:exit', function() {});

window.GroupManager = GroupManager;
})();
