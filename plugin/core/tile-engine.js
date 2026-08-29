/**
 * tile-engine.js — 磁贴引擎
 * 负责磁贴的渲染、网格布局、展开/收缩、编辑模式(拖拽+缩放)、碰撞推挤、翻转、交互效果
 * 核心代码从验证原型 wheelchair-ui-redesign/panel.html 提取并重构
 */
(function() {
'use strict';

var COLS = 4, GAP = 4, _rows = 8, _cell = 60;
var _expanded = null, _editMode = false, _longPress = null, _lx = 0, _ly = 0;
var _dragTile = null, _dragClone = null, _dragOffX = 0, _dragOffY = 0;
var _resizing = null, _rsX = 0, _rsY = 0, _rsW = 0, _rsH = 0;
var _expandTimer = null; // 展开/收缩动画的timeout，用于打断
var _dragOrigCol = 0, _dragOrigRow = 0, _dragLastCol = 0, _dragLastRow = 0;
var _preDragPositions = [];
var _resizePrePositions = [];
var _dragDebounce = null;
var _pushTimer = null;         // 挤压停留判定
var _prevDragX = 0, _prevDragY = 0;  // 拖拽方向追踪
var _lastDragDx = 0, _lastDragDy = 0; // 最近拖拽方向

// 文件夹拖入高亮
var _groupTarget = null;

// DOM引用 (init时设置)
var _vp = null, _expBg = null;

// 磁贴DOM元素缓存: tileId -> DOM element
var _tileElements = {};

// ========== 工具函数 ==========

function $(id) { return document.getElementById(id); }

function updCell() {
  if (!_vp) return;
  var w = _vp.clientWidth - 16;
  _cell = Math.floor((w - GAP * (COLS - 1)) / COLS);
  document.documentElement.style.setProperty('--cell', _cell + 'px');
}

// Dock 开启时, 全屏展开要让出右侧 Dock 那条(不被覆盖); 高度不受影响(Dock 在右侧)。
function _dockW() {
  if (!document.body.classList.contains('dock-on')) return 0;
  var s = getComputedStyle(document.documentElement).getPropertyValue('--dock-w');
  return parseInt(s, 10) || 0;
}
function _fullExpandW() { return window.innerWidth - 8 - _dockW(); }
// Dock 在左侧时, 全屏展开要从 Dock 右边开始(否则会被 Dock 盖住左半)
function _expandLeftPx() {
  var leftDock = document.body.classList.contains('dock-on') && document.body.classList.contains('dock-left');
  return 4 + (leftDock ? _dockW() : 0);
}

function setRows(n) {
  _rows = Math.max(n, 6);
  document.documentElement.style.setProperty('--rows', _rows);
}

function applyPos(t) {
  var c = +t.dataset.col || 1, r = +t.dataset.row || 1, w = +t.dataset.w || 1, h = +t.dataset.h || 1;
  t.style.gridColumn = c + '/span ' + w;
  t.style.gridRow = r + '/span ' + h;
}

/** 获取某个分组grid内的所有磁贴 */
function tilesInGrid(gridEl) {
  return Array.from(gridEl.querySelectorAll('.tile'));
}

/** 获取所有磁贴 */
function allTiles() {
  return Array.from(document.querySelectorAll('.tile'));
}

function overlaps(c1, r1, w1, h1, c2, r2, w2, h2) {
  return c1 < c2 + w2 && c1 + w1 > c2 && r1 < r2 + h2 && r1 + h1 > r2;
}

function gCoord(ex, ey, gridEl) {
  var gr = gridEl.getBoundingClientRect();
  return {
    col: Math.max(1, Math.min(COLS, Math.floor((ex - gr.left) / (_cell + GAP)) + 1)),
    row: Math.max(1, Math.floor((ey - gr.top) / (_cell + GAP)) + 1)
  };
}

function cellPx(col, row, w, h, gridEl) {
  var gr = gridEl.getBoundingClientRect();
  return {
    x: gr.left + (col - 1) * (_cell + GAP),
    y: gr.top + (row - 1) * (_cell + GAP),
    w: w * _cell + (w - 1) * GAP,
    h: h * _cell + (h - 1) * GAP
  };
}

// ========== 碰撞解决 ==========

/**
 * 逐个放置法碰撞解决器
 * mover 已在目标位置，把被挤的磁贴逐个安全放置
 */
function pushDown(mover, gridEl) {
  if (!gridEl) return;
  var allT = tilesInGrid(gridEl);
  var dragDx = _lastDragDx || 0;
  var dragDy = _lastDragDy || 0;

  function buildOccupied(exclude) {
    var map = {};
    for (var i = 0; i < allT.length; i++) {
      if (allT[i] === exclude) continue;
      var c = +allT[i].dataset.col, r = +allT[i].dataset.row;
      var w = +allT[i].dataset.w || 1, h = +allT[i].dataset.h || 1;
      for (var dr = 0; dr < h; dr++) for (var dc = 0; dc < w; dc++) map[(r + dr) + ',' + (c + dc)] = true;
    }
    return map;
  }

  function isFree(occ, col, row, w, h) {
    for (var dr = 0; dr < h; dr++) for (var dc = 0; dc < w; dc++) {
      if (col + dc < 1 || col + dc > COLS || row + dr < 1) return false;
      if (occ[(row + dr) + ',' + (col + dc)]) return false;
    }
    return true;
  }

  function findSafeSpot(occ, pw, ph, sc, sr) {
    var horiz = Math.abs(dragDx) > Math.abs(dragDy);
    var right = dragDx >= 0;
    for (var d = 1; d < 50; d++) {
      if (horiz) {
        var tc = right ? sc + d : sc - d;
        if (tc >= 1 && tc + pw - 1 <= COLS && isFree(occ, tc, sr, pw, ph)) return { col: tc, row: sr };
        if (isFree(occ, sc, sr + d, pw, ph)) return { col: sc, row: sr + d };
      } else {
        var tr = sr + d;
        if (isFree(occ, sc, tr, pw, ph)) return { col: sc, row: tr };
        var tc2 = right ? sc + d : sc - d;
        if (tc2 >= 1 && tc2 + pw - 1 <= COLS && isFree(occ, tc2, sr, pw, ph)) return { col: tc2, row: sr };
      }
    }
    for (var row = 1; row < 100; row++) for (var col = 1; col <= COLS - pw + 1; col++) {
      if (isFree(occ, col, row, pw, ph)) return { col: col, row: row };
    }
    return { col: 1, row: sr + 1 };
  }

  // 收集和 mover 重叠的磁贴 (pinTop 锁定磁贴永不参与重排)
  var queue = [];
  if (mover) {
    var mc = +mover.dataset.col, mr = +mover.dataset.row;
    var mw = +mover.dataset.w || 1, mh = +mover.dataset.h || 1;
    for (var i = 0; i < allT.length; i++) {
      if (allT[i] === mover) continue;
      if (allT[i].dataset.pinTop === '1') continue;
      var tc = +allT[i].dataset.col, tr = +allT[i].dataset.row;
      var tw = +allT[i].dataset.w || 1, th = +allT[i].dataset.h || 1;
      if (overlaps(mc, mr, mw, mh, tc, tr, tw, th)) queue.push(allT[i]);
    }
  }

  var processed = [];
  var maxIter = allT.length * 3;
  var iter = 0;
  while (queue.length > 0 && iter++ < maxIter) {
    var tile = queue.shift();
    if (processed.indexOf(tile) >= 0) continue;
    processed.push(tile);
    var pw = +tile.dataset.w || 1, ph = +tile.dataset.h || 1;
    var oc = +tile.dataset.col, or2 = +tile.dataset.row;
    var occ = buildOccupied(tile);
    if (isFree(occ, oc, or2, pw, ph)) continue;
    var spot = findSafeSpot(occ, pw, ph, oc, or2);
    tile.dataset.col = spot.col; tile.dataset.row = spot.row;
    applyPos(tile);
    for (var j = 0; j < allT.length; j++) {
      if (allT[j] === tile) continue;
      if (allT[j].dataset.pinTop === '1') continue;
      var bc = +allT[j].dataset.col, br = +allT[j].dataset.row;
      var bw = +allT[j].dataset.w || 1, bh = +allT[j].dataset.h || 1;
      if (overlaps(spot.col, spot.row, pw, ph, bc, br, bw, bh)) {
        if (processed.indexOf(allT[j]) < 0) queue.push(allT[j]);
      }
    }
  }

  var maxR = 0;
  allT.forEach(function(t) { var r = +t.dataset.row || 1, h = +t.dataset.h || 1; if (r + h - 1 > maxR) maxR = r + h - 1; });
  if (gridEl) gridEl.style.gridTemplateRows = 'repeat(' + Math.max(maxR + 1, 3) + ', var(--cell))';
}

/** FLIP动画：所有发生位移的磁贴从旧位置平滑滑到新位置 */
function animateTiles(oldRects, exclude) {
  var slidingTiles = [];
  allTiles().forEach(function(t) {
    if (t === exclude) return;
    var oldR = oldRects[t.dataset.id];
    if (!oldR) return;
    var newRect = t.getBoundingClientRect();
    var dx = oldR.left - newRect.left, dy = oldR.top - newRect.top;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      t.classList.add('tile-sliding');
      t.style.transition = 'none';
      t.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(0.96)';
      slidingTiles.push(t);
    }
  });
  if (slidingTiles.length) {
    requestAnimationFrame(function() { requestAnimationFrame(function() {
      slidingTiles.forEach(function(tile) {
        tile.style.transition = 'transform 0.4s cubic-bezier(.22,1.15,.36,1)';
        tile.style.transform = 'translate(0,0) scale(1)';
        var onEnd = function() {
          tile.classList.remove('tile-sliding');
          tile.style.transition = ''; tile.style.transform = '';
          tile.removeEventListener('transitionend', onEnd);
        };
        tile.addEventListener('transitionend', onEnd);
      });
    }); });
  }
}

function placeTile(t, col, row, gridEl) {
  t.dataset.col = col; t.dataset.row = row;
  applyPos(t);
  pushDown(t, gridEl);
}

/** 自动排列：在grid中找到第一个能放下w*h磁贴的空位
 *  options.reservedLayout: 保存布局对象 { tileId: {col,row,w,h,group}, ... }
 *    新加载磁贴时,把保存布局里的位置也视为"已占用",避免新磁贴落到老磁贴即将复位的格子
 *  options.skipTileId: 不要把保存布局里这个 id 算入占用(给已知磁贴自己留位时用)
 *  options.groupId: 限制只考虑同组保存位置
 */
function autoPlace(gridEl, w, h, options) {
  options = options || {};
  var existing = tilesInGrid(gridEl);
  // 构建占用表
  var occupied = {};
  existing.forEach(function(t) {
    var tc = +t.dataset.col, tr = +t.dataset.row, tw = +t.dataset.w || 1, th = +t.dataset.h || 1;
    for (var r = tr; r < tr + th; r++) {
      for (var c = tc; c < tc + tw; c++) {
        occupied[r + ',' + c] = true;
      }
    }
  });
  // 加入保存布局里"将来要复位"的格子
  if (options.reservedLayout) {
    var rkeys = Object.keys(options.reservedLayout);
    for (var ri = 0; ri < rkeys.length; ri++) {
      var rid = rkeys[ri];
      if (rid === options.skipTileId) continue;
      var rp = options.reservedLayout[rid];
      if (!rp) continue;
      if (options.groupId && rp.group && rp.group !== options.groupId) continue;
      var rw = +rp.w || 1, rh = +rp.h || 1;
      var rc = +rp.col || 1, rr = +rp.row || 1;
      for (var rr2 = rr; rr2 < rr + rh; rr2++) {
        for (var rc2 = rc; rc2 < rc + rw; rc2++) {
          occupied[rr2 + ',' + rc2] = true;
        }
      }
    }
  }
  // 逐行逐列扫描
  for (var row = 1; row < 100; row++) {
    for (var col = 1; col <= COLS - w + 1; col++) {
      var fits = true;
      for (var dr = 0; dr < h && fits; dr++) {
        for (var dc = 0; dc < w && fits; dc++) {
          if (occupied[(row + dr) + ',' + (col + dc)]) fits = false;
        }
      }
      if (fits) return { col: col, row: row };
    }
  }
  return { col: 1, row: 1 }; // fallback
}

// ========== 磁贴DOM创建 ==========

/** 根据TileAPI注册信息创建一个磁贴DOM元素 */
function createTileDOM(tileDef) {
  var el = document.createElement('div');
  el.className = 'tile' + (tileDef.live ? ' live' : '') + (tileDef.pinTop ? ' locked-tile' : '');
  el.dataset.id = tileDef.id;
  if (tileDef.pinTop) el.dataset.pinTop = '1';

  // 默认位置和大小. pinTop 磁贴强制 4x1 横条, 钉在 (1,1)
  var sz = tileDef.defaultSize || { w: 1, h: 1 };
  if (tileDef.pinTop) {
    sz = { w: 4, h: 1 };
    el.dataset.col = '1'; el.dataset.row = '1';
  } else {
    el.dataset.col = '1'; el.dataset.row = '1';
  }
  el.dataset.w = sz.w; el.dataset.h = sz.h;

  // 光照追踪层
  var reveal = document.createElement('div');
  reveal.className = 'tile-reveal';
  el.appendChild(reveal);

  // 内容区 (翻转支持)
  if (tileDef.live && (tileDef.renderBack || tileDef.liveBack)) {
    var flipBox = document.createElement('div');
    flipBox.className = 'tile-flip-box';

    var front = document.createElement('div');
    front.className = 'tile-flip-front tile-inner';
    _renderFrontContent(front, tileDef, sz.w, sz.h);

    var back = document.createElement('div');
    back.className = 'tile-flip-back';
    if (tileDef.renderBack) {
      tileDef.renderBack(back);
    } else if (tileDef.liveBack) {
      back.textContent = tileDef.liveBack;
    }

    flipBox.appendChild(front);
    flipBox.appendChild(back);
    el.appendChild(flipBox);
  } else {
    var inner = document.createElement('div');
    inner.className = 'tile-inner';
    _renderFrontContent(inner, tileDef, sz.w, sz.h);
    el.appendChild(inner);
  }

  // 角标
  if (tileDef.badge) {
    var badge = document.createElement('span');
    badge.className = 'tile-badge';
    badge.textContent = tileDef.badge;
    el.appendChild(badge);
  }

  // 关闭按钮(展开用)
  var closeBtn = document.createElement('span');
  closeBtn.className = 'tile-expand-close';
  closeBtn.innerHTML = '×';
  el.appendChild(closeBtn);

  // 展开内容区
  var expandContent = document.createElement('div');
  expandContent.className = 'tile-expand-content';
  el.appendChild(expandContent);

  // 缩放手柄 (pinTop 锁定磁贴无缩放手柄)
  if (!tileDef.pinTop) {
    var resizeHandle = document.createElement('div');
    resizeHandle.className = 'resize-handle';
    el.appendChild(resizeHandle);
  }

  // 注册交互
  _initTileInteractions(el, tileDef);

  _tileElements[tileDef.id] = el;
  return el;
}

/** 渲染磁贴正面内容 */
function _renderFrontContent(container, tileDef, w, h) {
  if (tileDef.renderFront) {
    tileDef.renderFront(container, w, h);
  } else {
    // 默认渲染: 图标 + 标签 + 描述
    container.innerHTML = '';
    if (tileDef.icon) {
      var icon = document.createElement('div');
      icon.className = 'tile-icon';
      icon.textContent = tileDef.icon;
      container.appendChild(icon);
    }
    if (tileDef.label) {
      var label = document.createElement('div');
      label.className = 'tile-label';
      label.textContent = tileDef.label;
      container.appendChild(label);
    }
    if (tileDef.desc && w >= 2) {
      var desc = document.createElement('div');
      desc.className = 'tile-desc';
      desc.textContent = tileDef.desc;
      container.appendChild(desc);
    }
  }
}

// ========== 展开/收缩 ==========

function expand(t) {
  // 互斥:如果有就地展开面板先收起,避免两种展开态同时存在导致内容被清空
  if (_inlinePanel) inlineCollapse();
  if (_expanded) collapse();
  // collapse() 会设一个新的 _expandTimer 做收起动画; 这里紧接着要展开,
  // 清掉它,避免孤儿定时器在展开途中把磁贴又拉回网格位置
  if (_expandTimer) { clearTimeout(_expandTimer); _expandTimer = null; }
  _cleanAllStates();
  var tileDef = TileAPI.getTileDef(t.dataset.id);

  var rect = t.getBoundingClientRect();
  t.style.position = 'fixed'; t.style.top = rect.top + 'px'; t.style.left = rect.left + 'px';
  t.style.width = rect.width + 'px'; t.style.height = rect.height + 'px';
  t.style.transform = '';

  // FLIP: 捕获图标位置
  var inner = t.querySelector('.tile-inner');
  var icon = t.querySelector('.tile-icon');
  var oldIconRect = icon ? icon.getBoundingClientRect() : null;

  t.classList.add('expanding');

  // 根据"原始尺寸 → 全屏尺寸"的比例算自适应动画时长
  // 小磁贴位移大 → duration 长(看清飞过去)
  // 大磁贴位移小 → duration 短(不拖泥带水)
  var fullW = _fullExpandW();
  var fullH = window.innerHeight - 8;
  var animMs = _calcExpandDuration(rect.width, rect.height, fullW, fullH);
  var animS = (animMs / 1000).toFixed(3) + 's';
  t.style.transition = 'top ' + animS + ' cubic-bezier(.4,0,.2,1),' +
                       'left ' + animS + ' cubic-bezier(.4,0,.2,1),' +
                       'width ' + animS + ' cubic-bezier(.4,0,.2,1),' +
                       'height ' + animS + ' cubic-bezier(.4,0,.2,1),' +
                       'box-shadow ' + animS;

  if (icon && oldIconRect) {
    var newIconRect = icon.getBoundingClientRect();
    var dx = oldIconRect.left - newIconRect.left, dy = oldIconRect.top - newIconRect.top;
    inner.style.transition = 'none';
    inner.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  }

  _expBg.classList.add('show');

  // 推开其他磁贴
  _pushAwayOthers(t, rect);

  requestAnimationFrame(function() { requestAnimationFrame(function() {
    t.style.top = '4px'; t.style.left = _expandLeftPx() + 'px';
    t.style.width = fullW + 'px';
    t.style.height = fullH + 'px';
    if (inner) {
      inner.style.transition = 'transform ' + animS + ' cubic-bezier(.4,0,.2,1)';
      inner.style.transform = 'translate(0,0)';
    }
  }); });

  _expandTimer = setTimeout(function() {
    _expandTimer = null;
    t.classList.remove('expanding'); t.classList.add('expanded');
    if (inner) { inner.style.transition = ''; inner.style.transform = ''; }
    t.style.transition = '';   // 让 css 接管

    // 获取所有需要淡入的元素:关闭按钮、面板内容
    var closeBtn = t.querySelector('.tile-expand-close');
    var ec = t.querySelector('.tile-expand-content');

    // 先渲染面板内容(此时全部opacity:0)
    if (ec && tileDef && tileDef.onExpand) {
      // 先清旧 cleanup(避免 listener 重复注册);面板/就地模式遗留的 cleanup 也一并清,
      // 否则它们的 ResizeObserver/监听器会残留并触发重复渲染 → 面板内容叠加
      if (tileDef._expandCleanup) { try { tileDef._expandCleanup(); } catch(e) {} tileDef._expandCleanup = null; }
      if (tileDef._panelCleanup) { try { tileDef._panelCleanup(); } catch(e) {} tileDef._panelCleanup = null; }
      if (tileDef._inlineCleanup) { try { tileDef._inlineCleanup(); } catch(e) {} tileDef._inlineCleanup = null; }
      ec.innerHTML = '';   // 清掉上一次渲染的残留内容, 防止重复
      // 全屏展开也要传 sizeHint:某些磁贴(tile-light 等)依赖 sizeHint.layout 决定渲染分支,
      // 不传 sizeHint 会导致 _shouldRender3D 等函数得 undefined → 误进入空状态/占位符分支
      var _ecW = ec.clientWidth || _fullExpandW() || 800;
      var _ecH = ec.clientHeight || (window.innerHeight - 8) || 600;
      var _ecLayout = _calcLayout(_ecW, _ecH);
      try { tileDef._expandCleanup = tileDef.onExpand(ec, { width: _ecW, height: _ecH, layout: _ecLayout, expandMode: 'full' }); } catch(e) { console.error('[TileEngine] onExpand error:', e); }
      // 用户改进计划: 上报哪个磁贴被展开
      if (window._telemetry) try { window._telemetry.trackTileExpand(tileDef.id); } catch(_) {}
    }

    // 统一设为隐藏
    var fadeEls = [closeBtn, ec].filter(function(e) { return !!e; });
    fadeEls.forEach(function(el) {
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      el.style.transition = 'none';
    });

    // 下一帧统一淡入
    requestAnimationFrame(function() { requestAnimationFrame(function() {
      fadeEls.forEach(function(el) {
        el.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
      });
    }); });
  }, animMs + 20);

  _expanded = t;
  TileAPI.emit('tile:expanded', { tileId: t.dataset.id });
}

// 自适应展开动画时长(ms): 比例越大 → duration 越长
//   1x1 → 全屏 ≈ 480ms (上限)
//   3x3 → 全屏 ≈ 400ms
//   5x5 → 全屏 ≈ 340ms
//   接近全屏 ≈ 240ms
function _calcExpandDuration(origW, origH, fullW, fullH) {
  origW = Math.max(1, origW);
  origH = Math.max(1, origH);
  var ratio = Math.max(fullW / origW, fullH / origH);
  if (ratio < 1.1) return 200;
  var ms = 200 + 80 * (Math.log(ratio) / Math.log(2));
  if (ms < 200) ms = 200;
  if (ms > 480) ms = 480;
  return Math.round(ms);
}

function collapse() {
  // 关闭所有 UIKit 弹出层,避免磁贴收起后残留孤儿 popup
  if (window.UIKit && window.UIKit.closeAllPopups) window.UIKit.closeAllPopups();

  // 取消进行中的展开/收缩动画
  if (_expandTimer) { clearTimeout(_expandTimer); _expandTimer = null; }

  if (!_expanded) {
    // 没有展开的磁贴，但可能有残留的expanding状态，强制清理
    _forceCleanAll();
    return;
  }
  var t = _expanded; _expanded = null;
  var tileDef = TileAPI.getTileDef(t.dataset.id);

  // 调用模块的onCollapse
  if (tileDef) {
    if (tileDef._expandCleanup) { try { tileDef._expandCleanup(); } catch(e) {} tileDef._expandCleanup = null; }
    if (tileDef.onCollapse) { try { tileDef.onCollapse(); } catch(e) {} }
  }

  var ec = t.querySelector('.tile-expand-content');
  if (ec) { ec.style.opacity = '0'; ec.innerHTML = ''; }

  var inner = t.querySelector('.tile-inner');
  var icon = t.querySelector('.tile-icon');
  var c = +t.dataset.col || 1, r = +t.dataset.row || 1, w = +t.dataset.w || 1, h = +t.dataset.h || 1;
  var gridEl = t.parentElement;
  var target = cellPx(c, r, w, h, gridEl);
  // pinTop 顶栏是半高 sticky (#topbarHost 30px), cellPx 按标准格 h=1 算成 ~60px (一个标准磁贴高).
  // 收回动画会缩到 60px, 然后 line 586 清 height 让 CSS 接管 → 瞬跳回 30px (可见瞬移).
  // 用 host 真实尺寸纠正, 让动画终点 == CSS 最终态, 跟 expand 起点 (也是 host rect) 对称.
  if (tileDef && tileDef.pinTop) {
    var _host = document.getElementById('topbarHost');
    if (_host) {
      var _hr = _host.getBoundingClientRect();
      target = { x: _hr.left, y: _hr.top, w: _hr.width, h: _hr.height };
    }
  }

  // 测量时禁用transition
  var origTransition = t.style.transition;
  t.style.transition = 'none';
  t.classList.remove('expanded'); t.classList.add('expanding');

  // 测量收缩后图标位置
  t.classList.remove('expanding');
  t.style.top = target.y + 'px'; t.style.left = target.x + 'px';
  t.style.width = target.w + 'px'; t.style.height = target.h + 'px';
  var finalIconRect = icon ? icon.getBoundingClientRect() : null;

  t.classList.add('expanding');
  var endNaturalRect = icon ? icon.getBoundingClientRect() : null;
  var endDx = 0, endDy = 0;
  if (finalIconRect && endNaturalRect) {
    endDx = finalIconRect.left - endNaturalRect.left;
    endDy = finalIconRect.top - endNaturalRect.top;
  }

  // 恢复全屏
  t.style.top = '4px'; t.style.left = _expandLeftPx() + 'px';
  t.style.width = _fullExpandW() + 'px'; t.style.height = (window.innerHeight - 8) + 'px';
  if (inner) { inner.style.transition = 'none'; inner.style.transform = 'translate(0,0)'; }
  _expBg.classList.remove('show');

  // 拉回其他磁贴
  _pullBackOthers();

  t.offsetHeight; // 强制回流

  // 自适应 collapse 时长:目标尺寸 vs 全屏的比例(同 expand 用同一公式,保证视觉一致)
  var animMsCol = _calcExpandDuration(target.w, target.h, window.innerWidth - 8, window.innerHeight - 8);
  var animSCol = (animMsCol / 1000).toFixed(3) + 's';
  t.style.transition = 'top ' + animSCol + ' cubic-bezier(.4,0,.2,1),' +
                       'left ' + animSCol + ' cubic-bezier(.4,0,.2,1),' +
                       'width ' + animSCol + ' cubic-bezier(.4,0,.2,1),' +
                       'height ' + animSCol + ' cubic-bezier(.4,0,.2,1),' +
                       'box-shadow ' + animSCol;

  requestAnimationFrame(function() { requestAnimationFrame(function() {
    t.style.top = target.y + 'px'; t.style.left = target.x + 'px';
    t.style.width = target.w + 'px'; t.style.height = target.h + 'px';
    if (inner) {
      inner.style.transition = 'transform ' + animSCol + ' cubic-bezier(.4,0,.2,1)';
      inner.style.transform = 'translate(' + endDx + 'px,' + endDy + 'px)';
    }
  }); });

  _expandTimer = setTimeout(function() {
    _expandTimer = null;

    // FLIP: 测量 expanding(flex-start) → 正常(center) 的 inner 位移
    var innerRect1 = inner ? inner.getBoundingClientRect() : null;

    t.classList.remove('expanding');
    t.style.position = ''; t.style.top = ''; t.style.left = '';
    t.style.width = ''; t.style.height = '';
    t.style.transform = ''; t.style.transformOrigin = '';
    t.style.background = ''; t.style.borderColor = '';
    t.style.transition = '';   // 清掉 inline transition,让 css 接管
    applyPos(t);

    // 收起的若是大磁贴(>1x1, 非 pinTop), 还原回面板模式 —— Dock 可对大磁贴强制全屏展开,
    // 收起后要恢复其常驻面板, 否则会变成空的大按钮。
    var _cw = +t.dataset.w || 1, _ch = +t.dataset.h || 1;
    if ((_cw > 1 || _ch > 1) && !t.classList.contains('panel-mode')) {
      var _cdef = TileAPI.getTileDef(t.dataset.id);
      if (_cdef && !_cdef.pinTop && typeof _switchToPanelMode === 'function') _switchToPanelMode(t, _cdef);
    }

    // 补偿 inner 位移（从 flex-start 回到 center 的跳动）
    if (inner && innerRect1) {
      var innerRect2 = inner.getBoundingClientRect();
      var idx = innerRect1.left - innerRect2.left;
      var idy = innerRect1.top - innerRect2.top;
      if (Math.abs(idx) > 1 || Math.abs(idy) > 1) {
        inner.style.transition = 'none';
        inner.style.transform = 'translate(' + idx + 'px,' + idy + 'px)';
        requestAnimationFrame(function() { requestAnimationFrame(function() {
          inner.style.transition = 'transform 0.2s cubic-bezier(.22,1,.36,1)';
          inner.style.transform = 'translate(0,0)';
          var done = function() { inner.style.transition = ''; inner.style.transform = ''; inner.removeEventListener('transitionend', done); };
          inner.addEventListener('transitionend', done);
        }); });
      } else {
        inner.style.transition = ''; inner.style.transform = '';
      }
    }

    _restoreSingleTileColor(t);
  }, animMsCol + 20);

  TileAPI.emit('tile:collapsed', { tileId: t.dataset.id });
}

function _cleanAllStates() {
  allTiles().forEach(function(t) {
    t.classList.remove('expanding', 'expanded', 'drag-ph', 'edit-mode');
    t.style.position = ''; t.style.top = ''; t.style.left = '';
    t.style.width = ''; t.style.height = ''; t.style.transformOrigin = '';
    if (!_editMode) t.style.transform = '';
  });
  if (_expBg) _expBg.classList.remove('show');
}

/** 强制清理所有残留（ESC打断用） */
function _forceCleanAll() {
  if (_expandTimer) { clearTimeout(_expandTimer); _expandTimer = null; }
  allTiles().forEach(function(t) {
    // 跳过面板模式的磁贴，不清理它们的内容
    if (t.classList.contains('panel-mode')) return;
    // 只清理真正有残留状态的磁贴,否则动一个磁贴会把其他磁贴的 expand-content 一起清空
    var hasExpandState = t.classList.contains('expanding') || t.classList.contains('expanded') ||
                         t.classList.contains('drag-ph') || t.classList.contains('tile-pushed') ||
                         t.classList.contains('frozen') || t.classList.contains('inline-source');
    if (!hasExpandState && !t.style.position && !t.style.transform && !t.style.opacity) return;
    t.classList.remove('expanding', 'expanded', 'drag-ph', 'tile-pushed', 'frozen', 'inline-source');
    t.style.position = ''; t.style.top = ''; t.style.left = '';
    t.style.width = ''; t.style.height = '';
    t.style.transform = ''; t.style.transformOrigin = '';
    t.style.background = ''; t.style.borderColor = '';
    t.style.opacity = '';
    // 清理inner
    var inner = t.querySelector('.tile-inner');
    if (inner) { inner.style.transition = ''; inner.style.transform = ''; }
    // 清理展开内容(只在真的曾经展开过的磁贴上清)
    var ec = t.querySelector('.tile-expand-content');
    if (ec) { ec.style.opacity = ''; ec.innerHTML = ''; }
    applyPos(t);
  });
  if (_expBg) _expBg.classList.remove('show');
  _expanded = null;
  // 恢复颜色
  _restoreTileColors();
}

// ========== 编辑模式 ==========

function enterEdit() {
  if (_editMode) return;
  _editMode = true;
  allTiles().forEach(function(t) { t.classList.add('edit-mode'); t.style.transform = ''; });
  document.querySelectorAll('.grid').forEach(function(g) { g.classList.add('editing'); });
  var tb = document.getElementById('editToolbar');
  if (tb) tb.classList.add('show');
  TileAPI.emit('editMode:enter', {});
}

function exitEdit() {
  _editMode = false;
  _cleanAllStates();
  allTiles().forEach(function(t) { t.style.transform = ''; applyPos(t); });
  document.querySelectorAll('.grid').forEach(function(g) { g.classList.remove('editing'); });
  _endDrag(); _endResize();
  var tb = document.getElementById('editToolbar');
  if (tb) tb.classList.remove('show');
  TileEngine.saveLayout();
  TileAPI.emit('editMode:exit', {});
}

// ========== 拖拽 ==========

function _savePositions(gridEl) {
  _preDragPositions = tilesInGrid(gridEl).map(function(t) {
    return { tile: t, col: +t.dataset.col, row: +t.dataset.row, w: +t.dataset.w || 1, h: +t.dataset.h || 1 };
  });
}

function _restorePositions() {
  _preDragPositions.forEach(function(p) {
    p.tile.dataset.col = p.col; p.tile.dataset.row = p.row;
    p.tile.dataset.w = p.w; p.tile.dataset.h = p.h;
    applyPos(p.tile);
  });
}

function _beginDrag(t, e) {
  _dragTile = t;
  var r = t.getBoundingClientRect();
  _dragOffX = e.clientX - r.left; _dragOffY = e.clientY - r.top;
  _dragOrigCol = +t.dataset.col; _dragOrigRow = +t.dataset.row;
  _dragLastCol = _dragOrigCol; _dragLastRow = _dragOrigRow;
  _prevDragX = e.clientX; _prevDragY = e.clientY;
  _lastDragDx = 0; _lastDragDy = 0;

  var gridEl = t.parentElement;
  _savePositions(gridEl);

  _dragClone = t.cloneNode(true);
  _dragClone.className = 'drag-clone';
  _dragClone.style.width = r.width + 'px'; _dragClone.style.height = r.height + 'px';
  _dragClone.style.left = (e.clientX - _dragOffX) + 'px'; _dragClone.style.top = (e.clientY - _dragOffY) + 'px';
  document.body.appendChild(_dragClone);
  t.classList.add('drag-ph');

  document.addEventListener('mousemove', _onDragMove);
  document.addEventListener('mouseup', _onDragEnd);
}

function _onDragMove(e) {
  if (!_dragClone) return;
  _dragClone.style.left = (e.clientX - _dragOffX) + 'px';
  _dragClone.style.top = (e.clientY - _dragOffY) + 'px';

  // 追踪拖拽方向
  var moveDx = e.clientX - _prevDragX;
  var moveDy = e.clientY - _prevDragY;
  if (Math.abs(moveDx) > 2 || Math.abs(moveDy) > 2) {
    _lastDragDx = moveDx; _lastDragDy = moveDy;
  }
  _prevDragX = e.clientX; _prevDragY = e.clientY;

  var targetGrid = _findGridUnderPoint(e.clientX, e.clientY);
  if (!targetGrid) return;

  var g = gCoord(e.clientX, e.clientY, targetGrid);
  var w = +_dragTile.dataset.w || 1, h = +_dragTile.dataset.h || 1;
  var col = Math.min(g.col, COLS - w + 1), row = Math.max(1, g.row);

  // 拖到文件夹上方时高亮提示
  var overlappingFolder = _findFolderAt(targetGrid, col, row, _dragTile);
  if (overlappingFolder && w === 1 && h === 1) {
    if (_groupTarget !== overlappingFolder) {
      _cancelGroupHover();
      _groupTarget = overlappingFolder;
      overlappingFolder.classList.add('group-hover');
    }
  } else {
    _cancelGroupHover();
  }

  // 如果在文件夹上方，不执行挤压
  if (_groupTarget) return;

  // 正常移动：格子变化时即时响应
  if (col !== _dragLastCol || row !== _dragLastRow || targetGrid !== _dragTile.parentElement) {
    _dragLastCol = col; _dragLastRow = row;
    _lastDragDx = moveDx; _lastDragDy = moveDy;

    requestAnimationFrame(function() {
      if (!_dragTile) return;
      var oldRects = {};
      allTiles().forEach(function(t) { if (t !== _dragTile) oldRects[t.dataset.id] = t.getBoundingClientRect(); });

      if (targetGrid !== _dragTile.parentElement) {
        _dragTile.parentElement.removeChild(_dragTile);
        targetGrid.appendChild(_dragTile);
        _savePositions(targetGrid);
        var groupId = targetGrid.dataset.groupId;
        if (groupId) TileAPI.emit('tile:movedToGroup', { tileId: _dragTile.dataset.id, groupId: groupId });
      } else {
        _restorePositions();
      }

      placeTile(_dragTile, col, row, targetGrid);
      _dragTile.classList.add('drag-ph');
      animateTiles(oldRects, _dragTile);
    });
  }
}

/** 找到指定格子上的磁贴（排除自己） */
function _findTileAt(gridEl, col, row, exclude) {
  var tiles = tilesInGrid(gridEl);
  for (var i = 0; i < tiles.length; i++) {
    var t = tiles[i];
    if (t === exclude) continue;
    var tc = +t.dataset.col, tr = +t.dataset.row;
    var tw = +t.dataset.w || 1, th = +t.dataset.h || 1;
    if (col >= tc && col < tc + tw && row >= tr && row < tr + th) return t;
  }
  return null;
}

function _cancelGroupHover() {
  if (_groupTarget) { _groupTarget.classList.remove('group-hover'); _groupTarget = null; }
}

/** 找指定格子上的文件夹磁贴 或 抽屉磁贴 */
function _findFolderAt(gridEl, col, row, exclude) {
  var tiles = tilesInGrid(gridEl);
  for (var i = 0; i < tiles.length; i++) {
    var t = tiles[i];
    if (t === exclude) continue;
    var isFolder = !!t.dataset.folderId;
    var isDrawer = t.dataset.id === 'drawer';
    if (!isFolder && !isDrawer) continue;
    // 拖的是抽屉本身或被保护磁贴 → 跳过抽屉
    if (isDrawer && exclude) {
      var eid = exclude.dataset.id;
      if (window.TileDrawer && TileDrawer.isProtected && TileDrawer.isProtected(eid)) continue;
    }
    var tc = +t.dataset.col, tr = +t.dataset.row;
    if (col === tc && row === tr) return t;
  }
  return null;
}

function _findGridUnderPoint(x, y) {
  var grids = document.querySelectorAll('.grid');
  for (var i = 0; i < grids.length; i++) {
    var rect = grids[i].getBoundingClientRect();
    if (x >= rect.left - 20 && x <= rect.right + 20 && y >= rect.top - 30 && y <= rect.bottom + 30) {
      return grids[i];
    }
  }
  return null;
}

function _onDragEnd() {
  if (_groupTarget && _dragTile && _groupTarget.dataset.folderId) {
    // 松手在文件夹上 → 加入文件夹
    var dragId = _dragTile.dataset.id;
    var folderId = _groupTarget.dataset.folderId;
    _dragTile.classList.remove('drag-ph');
    _cancelGroupHover();

    // 先恢复所有磁贴到拖拽前位置（磁贴要被移除了，不需要让路）
    _restorePositions();

    _endDrag();
    var folder = GroupManager.getFolder(folderId);
    if (folder && folder.tileIds.length < 9) {
      var el = _tileElements[dragId];
      if (el && el.parentElement) el.parentElement.removeChild(el);
      GroupManager.addTileToFolder(dragId, folderId);
      TileAPI.toast('已加入文件夹', 'success');
    } else {
      TileAPI.toast('文件夹已满（最多9个）', 'error');
    }
  } else if (_groupTarget && _dragTile && _groupTarget.dataset.id === 'drawer') {
    // 松手在抽屉上 → 移入抽屉
    var stashId = _dragTile.dataset.id;
    _dragTile.classList.remove('drag-ph');
    _cancelGroupHover();
    _restorePositions();
    _endDrag();
    if (window.TileDrawer && !TileDrawer.isProtected(stashId)) {
      TileDrawer.stash(stashId);
      TileAPI.toast('已移入抽屉', 'success');
    } else {
      TileAPI.toast('该磁贴不能收纳', 'warn');
    }
  } else {
    // 正常放置
    if (_dragTile) _dragTile.classList.remove('drag-ph');
    _cancelGroupHover();
    _endDrag();
  }
  if (_editMode) TileEngine.saveLayout();
}

function _endDrag() {
  _cancelGroupHover();
  if (_pushTimer) { clearTimeout(_pushTimer); _pushTimer = null; }
  if (_dragClone) { _dragClone.remove(); _dragClone = null; }
  _dragTile = null; _preDragPositions = [];
  _lastDragDx = 0; _lastDragDy = 0;
  document.removeEventListener('mousemove', _onDragMove);
  document.removeEventListener('mouseup', _onDragEnd);
}

// ========== 缩放 ==========

function _beginResize(t, e) {
  var gridEl = t.parentElement;
  _resizing = t; _rsX = e.clientX; _rsY = e.clientY;
  _rsW = +t.dataset.w || 1; _rsH = +t.dataset.h || 1;
  _resizePrePositions = tilesInGrid(gridEl).map(function(tt) {
    return { tile: tt, col: +tt.dataset.col, row: +tt.dataset.row, w: +tt.dataset.w || 1, h: +tt.dataset.h || 1 };
  });
  document.addEventListener('mousemove', _onResizeMove);
  document.addEventListener('mouseup', _onResizeEnd);
}

function _onResizeMove(e) {
  if (!_resizing) return;
  var tileDef = TileAPI.getTileDef(_resizing.dataset.id);
  var minW = tileDef ? tileDef.minSize.w : 1;
  var minH = tileDef ? tileDef.minSize.h : 1;
  var maxW = tileDef ? tileDef.maxSize.w : 4;
  var maxH = tileDef ? tileDef.maxSize.h : 4;

  var dx = e.clientX - _rsX, dy = e.clientY - _rsY;
  var nw = Math.max(minW, Math.min(maxW, Math.round(_rsW + dx / (_cell + GAP))));
  var nh = Math.max(minH, Math.min(maxH, Math.round(_rsH + dy / (_cell + GAP))));
  var col = +_resizing.dataset.col || 1;
  if (col + nw - 1 > COLS) nw = COLS - col + 1;

  var gridEl = _resizing.parentElement;
  var oldRects = {};
  allTiles().forEach(function(t) { if (t !== _resizing) oldRects[t.dataset.id] = t.getBoundingClientRect(); });

  _resizePrePositions.forEach(function(p) {
    p.tile.dataset.col = p.col; p.tile.dataset.row = p.row;
    p.tile.dataset.w = p.w; p.tile.dataset.h = p.h;
    applyPos(p.tile);
  });

  _resizing.dataset.w = nw; _resizing.dataset.h = nh;
  applyPos(_resizing);
  pushDown(_resizing, gridEl);
  animateTiles(oldRects, _resizing);

  // 检测模式切换（1x1 图标 ↔ >1x1 面板）
  var currentlyPanel = _resizing.classList.contains('panel-mode');
  var shouldBePanel = (nw > 1 || nh > 1);
  var isIcon = !shouldBePanel;

  if (!currentlyPanel && shouldBePanel) {
    _switchToPanelMode(_resizing, tileDef);
  } else if (currentlyPanel && !shouldBePanel) {
    _switchToIconMode(_resizing, tileDef);
  }

  // 通知模块尺寸变了
  if (tileDef && tileDef.onResize) {
    try { tileDef.onResize(nw, nh); } catch(e2) {}
  }

  // 图标模式下重新渲染正面
  if (isIcon) {
    var inner = _resizing.querySelector('.tile-inner') || _resizing.querySelector('.tile-flip-front');
    if (inner && tileDef) _renderFrontContent(inner, tileDef, nw, nh);
  }
}

function _onResizeEnd() {
  if (_editMode) TileEngine.saveLayout();
  _resizing = null; _resizePrePositions = [];
  document.removeEventListener('mousemove', _onResizeMove);
  document.removeEventListener('mouseup', _onResizeEnd);
}

function _endResize() {
  _resizing = null; _resizePrePositions = [];
  document.removeEventListener('mousemove', _onResizeMove);
  document.removeEventListener('mouseup', _onResizeEnd);
}

// ========== 磁贴交互绑定 ==========

function _initTileInteractions(t, tileDef) {
  // 悬停倾斜 + 光照
  // mousemove 每帧最多走一次,避免高刷屏/慢机连发 60+ 次重算
  var _hoverPendingX = 0, _hoverPendingY = 0, _hoverPendingRect = null, _hoverRaf = 0;
  function _applyHoverTilt() {
    _hoverRaf = 0;
    if (!_hoverPendingRect) return;
    var r = _hoverPendingRect, x = _hoverPendingX, y = _hoverPendingY;
    // 只做轻微放大, 不再偏转 (偏转会让大磁贴边缘按钮点不准, 也容易晕)
    t.style.transform = 'scale(1.02)';
    var rv = t.querySelector('.tile-reveal');
    if (rv) { rv.style.setProperty('--mx', x + 'px'); rv.style.setProperty('--my', y + 'px'); }
  }
  t.addEventListener('mousemove', function(e) {
    if (t.classList.contains('expanded') || t.classList.contains('expanding') || _editMode) return;
    // panel-mode (就地展开) 时不偏转 — 用户已经在跟内容互动, 偏转会让点击偏移
    if (t.classList.contains('panel-mode')) return;
    // frozen(就地展开时被推挤/冻结的磁贴)保留 inline-source 或 translateY,不能被 hover transform 覆盖
    if (t.classList.contains('frozen') || t.classList.contains('inline-source')) return;
    var r = t.getBoundingClientRect();
    _hoverPendingRect = r;
    _hoverPendingX = e.clientX - r.left;
    _hoverPendingY = e.clientY - r.top;
    if (!_hoverRaf) _hoverRaf = requestAnimationFrame(_applyHoverTilt);
  });
  t.addEventListener('mouseleave', function() {
    if (_hoverRaf) { cancelAnimationFrame(_hoverRaf); _hoverRaf = 0; }
    _hoverPendingRect = null;
    if (t.classList.contains('frozen') || t.classList.contains('inline-source')) return;
    if (!t.classList.contains('expanded') && !t.classList.contains('expanding') && !_editMode) t.style.transform = '';
  });

  // 涟漪
  t.addEventListener('mousedown', function(e) {
    if (_editMode || t.classList.contains('expanded') || t.classList.contains('expanding')) return;
    if (t.classList.contains('panel-mode')) return;
    if (e.target.closest('input,button,select,textarea,.tile-expand-content')) return;
    var r = t.getBoundingClientRect();
    var rp = document.createElement('div'); rp.className = 'tile-ripple';
    var sz = Math.max(r.width, r.height);
    rp.style.width = rp.style.height = sz + 'px';
    rp.style.left = (e.clientX - r.left - sz / 2) + 'px'; rp.style.top = (e.clientY - r.top - sz / 2) + 'px';
    t.appendChild(rp); rp.addEventListener('animationend', function() { rp.remove(); });
  });

  // 长按进入编辑模式
  t.addEventListener('mousedown', function(e) {
    if (e.button !== 0 || t.classList.contains('expanded') || t.classList.contains('expanding')) return;
    // 就地展开态下禁止进入编辑模式
    if (_inlinePanel) return;
    // pinTop 锁定磁贴: 不能拖拽, 不能进编辑模式
    if (tileDef && tileDef.pinTop) return;
    // 排除表单元素；面板模式下不排除整个 expand-content（它是整个可见区）
    if (e.target.closest('input,button,select,textarea')) return;
    if (!t.classList.contains('panel-mode') && e.target.closest('.tile-expand-content')) return;
    _lx = e.clientX; _ly = e.clientY;
    _longPress = setTimeout(function() { enterEdit(); _beginDrag(t, e); }, 400);
  });
  t.addEventListener('mousemove', function(e) { if (_longPress && (Math.abs(e.clientX - _lx) > 4 || Math.abs(e.clientY - _ly) > 4)) { clearTimeout(_longPress); _longPress = null; } });
  t.addEventListener('mouseup', function() { clearTimeout(_longPress); _longPress = null; });
  t.addEventListener('mouseleave', function() { clearTimeout(_longPress); _longPress = null; });

  // 点击展开
  t.addEventListener('click', function(e) {
    // 顶栏 ☰ 布局按钮: 不触发顶栏展开 (它有自己的 document 委托打开布局面板)
    if (e.target && e.target.closest && e.target.closest('.topbar-layout-btn')) return;
    if (e.target.classList.contains('tile-expand-close')) { e.stopPropagation(); collapse(); return; }
    if (e.target.classList.contains('resize-handle')) return;
    if (_editMode) return;
    if (t.classList.contains('expanded') || t.classList.contains('expanding')) return;
    if (t.classList.contains('panel-mode')) return; // 面板模式不展开
    var tw = +t.dataset.w || 1, th = +t.dataset.h || 1;
    // pinTop 锁定磁贴: 即便宽度 >1 也允许点击展开 (因为它永远不进 panel-mode)
    if (!(tileDef && tileDef.pinTop) && (tw > 1 || th > 1)) return;
    // pinTop 强制走 full 全屏模式 (永远悬浮在最顶层, 展开时全屏覆盖主网格)
    var expandMode = (tileDef && tileDef.pinTop) ? 'full' : (t.dataset.expandMode || 'inline');
    if (expandMode === 'full') {
      expand(t);
    } else {
      // 如果当前已经是就地展开的源磁贴，再次点击收起
      if (_inlinePanel && _inlineSourceTile === t) {
        inlineCollapse();
      } else {
        inlineExpand(t);
      }
    }
  });

  // 关闭按钮
  var cl = t.querySelector('.tile-expand-close');
  if (cl) cl.addEventListener('click', function(e) { e.stopPropagation(); collapse(); });

  // 缩放手柄
  var rh = t.querySelector('.resize-handle');
  if (rh) rh.addEventListener('mousedown', function(e) {
    e.stopPropagation(); e.preventDefault();
    clearTimeout(_longPress);
    _beginResize(t, e);
  });
}

// ========== 推开/拉回其他磁贴 ==========

function _pushAwayOthers(expandingTile, expandRect) {
  var cx = expandRect.left + expandRect.width / 2;
  var cy = expandRect.top + expandRect.height / 2;
  var pushDist = Math.max(window.innerWidth, window.innerHeight) * 0.7;

  allTiles().forEach(function(t) {
    if (t === expandingTile) return;
    var r = t.getBoundingClientRect();
    var tx = r.left + r.width / 2;
    var ty = r.top + r.height / 2;
    // 方向向量
    var dx = tx - cx, dy = ty - cy;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len; dy /= len;
    // 推出距离
    var moveX = dx * pushDist;
    var moveY = dy * pushDist;

    t.style.transition = 'transform 0.35s cubic-bezier(.4,0,.2,1), opacity 0.3s';
    t.style.transform = 'translate(' + moveX + 'px,' + moveY + 'px) scale(0.6)';
    t.style.opacity = '0';
    t.classList.add('tile-pushed');
  });
}

function _pullBackOthers() {
  allTiles().forEach(function(t) {
    if (!t.classList.contains('tile-pushed')) return;
    t.style.transition = 'transform 0.35s cubic-bezier(.22,1,.36,1), opacity 0.3s';
    t.style.transform = 'translate(0,0) scale(1)';
    t.style.opacity = '1';
    var onEnd = function() {
      t.classList.remove('tile-pushed');
      t.style.transition = '';
      t.style.transform = '';
      t.style.opacity = '';
      t.removeEventListener('transitionend', onEnd);
    };
    t.addEventListener('transitionend', onEnd);
  });
}

// ========== 就地展开 ==========

var _inlinePanel = null;     // 当前就地展开的面板DOM
var _inlineSourceTile = null; // 展开源磁贴
var _inlineShiftedTiles = []; // 被下移的磁贴列表
var _inlineListenerTimer = null; // 延迟注册 outside-click listener 的 timer
var _inlineListenersOn = false;  // listener 是否已挂上

function inlineExpand(t) {
  if (_inlinePanel) inlineCollapse(); // 先收起已有的
  if (_expanded) collapse(); // 先收起全屏展开

  var tileDef = TileAPI.getTileDef(t.dataset.id);
  if (!tileDef) return;

  var gridEl = t.parentElement;
  if (!gridEl) return;

  _inlineSourceTile = t;
  var tileRow = +t.dataset.row || 1;
  var tileH = +t.dataset.h || 1;

  // 创建面板DOM
  var panel = document.createElement('div');
  panel.className = 'inline-panel';

  // 收起按钮
  var closeBtn = document.createElement('div');
  closeBtn.className = 'inline-panel-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', function(e) { e.stopPropagation(); inlineCollapse(); });
  panel.appendChild(closeBtn);

  // 内容区
  var content = document.createElement('div');
  content.className = 'inline-panel-content';
  panel.appendChild(content);

  // 先放入DOM,再调用onExpand
  _vp.appendChild(panel);

  // 计算横向位置(对齐 grid,上下展开共用)
  var gridRect = gridEl.getBoundingClientRect();
  var vpRect = _vp.getBoundingClientRect();
  var gridLeft = gridRect.left - vpRect.left;
  var gridWidth = gridRect.width;
  panel.style.left = gridLeft + 'px';
  panel.style.width = gridWidth + 'px';
  panel.style.right = 'auto';

  // 先临时贴在磁贴下方测量(top 任选,先绑定 left/width 让内容有正确宽度)
  // 用 tile 自己的 boundingClientRect 拿真实位置, 兼容 pinTop 半高首行 (row 1 高 30px) 这类异形布局
  var tileRect = t.getBoundingClientRect();
  var tileTopInVp = tileRect.top - vpRect.top + _vp.scrollTop;
  var tileBottomInVp = tileRect.bottom - vpRect.top + _vp.scrollTop;
  panel.style.top = tileBottomInVp + 'px';

  // 渲染面板内容
  content._isInline = true;
  // 先清旧 cleanup(避免 listener 重复注册)
  if (tileDef._inlineCleanup) { try { tileDef._inlineCleanup(); } catch(e) {} tileDef._inlineCleanup = null; }
  if (tileDef._panelCleanup) { try { tileDef._panelCleanup(); } catch(e) {} tileDef._panelCleanup = null; }
  if (tileDef.onExpand) {
    var _w0 = content.clientWidth, _h0 = content.clientHeight;
    var _layout0 = _calcLayout(_w0, _h0);
    try { tileDef._inlineCleanup = tileDef.onExpand(content, { width: _w0, height: _h0, layout: _layout0 }); } catch(err) { console.error('[TileEngine] inline onExpand error:', err); }
  }
  // 关键: 同步升级所有 <select> 为 UIKit 自定义触发器。
  // 否则 app.js 的全局 MutationObserver 会异步升级, 升级后插入的 wrap/trigger
  // 改变了内容真实高度, 此时我们已经测过 panelHeight 并启动了高度动画 →
  // 展开动画中段会出现一次"抖动位移"(panel 高度突然加上几像素)。
  // 主动同步 enhance, 让下面 offsetHeight 一次读到稳定的最终高度。
  if (window.UIKit && typeof window.UIKit.enhance === 'function') {
    try { window.UIKit.enhance(content); } catch(e) {}
  }

  // 响应式尺寸监听
  _applyPanelLayout(content, tileDef, tileDef && tileDef.onExpand);
  _observePanelSize(content, tileDef, tileDef && tileDef.onExpand);

  // 测量面板内容高度
  panel.style.height = 'auto';
  panel.style.opacity = '0';
  var panelHeight = panel.offsetHeight;
  if (panelHeight < 40) panelHeight = 200;
  panel.style.height = '0px';

  // ============================================================
  //  方向判断:若下方空间不足且上方更宽裕 → 向上展开
  // ============================================================
  var tileRectNow = t.getBoundingClientRect();
  var vpRectNow = _vp.getBoundingClientRect();
  var downSpace = (vpRectNow.bottom - tileRectNow.bottom);   // 视口内磁贴下方剩余
  var upSpace = (tileRectNow.top - vpRectNow.top);           // 视口内磁贴上方剩余
  var MARGIN = 20;  // 留一点边距
  var needDown = panelHeight + MARGIN;
  var goUp = false;
  if (downSpace < needDown && upSpace > downSpace) {
    goUp = true;
  }

  // 如果任一方向都放不下完整内容,把面板高度钳制到可用空间,让内容自身滚动
  // (forge 等复杂面板的 .w10-panel / .forge-panel 带 overflow-y:auto,能自己滚)
  var availableSpace = goUp ? upSpace : downSpace;
  var maxPanelH = Math.max(240, availableSpace - MARGIN);  // 至少给 240,别太小
  if (panelHeight > maxPanelH) panelHeight = maxPanelH;

  // ============================================================
  //  定位 + 推挤
  // ============================================================
  var allT = tilesInGrid(gridEl);
  _inlineShiftedTiles = [];
  var shiftPx = panelHeight + GAP;

  if (goUp) {
    // 向上展开:面板 top 固定在磁贴顶上方,height 和 left 都是静态的
    // 动画改为 opacity + translateY 滑入,避免 bottom 定位和 vp padding 冲突导致的内容裁切
    panel.classList.add('up-direction');
    var panelTopUp = tileTopInVp - panelHeight;
    panel.style.top = panelTopUp + 'px';
    panel.style.bottom = 'auto';
    panel.style.height = panelHeight + 'px';   // 固定高度
    panel.style.transform = 'translateY(' + panelHeight + 'px)';  // 起点:隐藏在磁贴顶部

    // 推挤:上方磁贴整体上移 shiftPx
    allT.forEach(function(tile) {
      if (tile === t) { tile.classList.add('inline-source'); return; }
      var tr = +tile.dataset.row || 1;
      if (tr < tileRow) {
        tile.style.transform = 'translateY(-' + shiftPx + 'px)';
        tile.classList.add('frozen');
        _inlineShiftedTiles.push({ tile: tile, shiftPx: -shiftPx });
      } else {
        tile.classList.add('frozen');
      }
    });
  } else {
    // 向下展开(原行为,height 0→N 动画)
    panel.classList.remove('up-direction');
    panel.style.bottom = 'auto';
    panel.style.top = tileBottomInVp + 'px';
    panel.style.transform = '';

    var panelStartRow = tileRow + tileH;
    allT.forEach(function(tile) {
      if (tile === t) { tile.classList.add('inline-source'); return; }
      var tr = +tile.dataset.row || 1;
      if (tr >= panelStartRow) {
        tile.style.transform = 'translateY(' + shiftPx + 'px)';
        tile.classList.add('frozen');
        _inlineShiftedTiles.push({ tile: tile, shiftPx: shiftPx });
      } else {
        tile.classList.add('frozen');
      }
    });
  }

  // 动画展开面板
  _inlinePanel = panel;
  requestAnimationFrame(function() { requestAnimationFrame(function() {
    if (goUp) {
      // 向上:高度固定,滑动 + 淡入
      panel.style.transform = 'translateY(0)';
      panel.style.opacity = '1';
    } else {
      // 向下:高度从 0 动画到 N,淡入
      panel.style.height = panelHeight + 'px';
      panel.style.opacity = '1';
    }
    panel.classList.add('open');
  }); });

  // 点击面板外收起
  // 用两阶段事件:capture 阶段记录 click target 在面板/源磁贴/portal 内,
  //              bubble 阶段读取记录决定是否 collapse
  // 这样能解决"按钮 click handler 同步 innerHTML 替换 → e.target 脱落 →
  // bubble 阶段 contains() 误判为外部点击"的问题
  // setTimeout 改写:跟踪 timer + listener 状态,防止快速展开收缩导致 listener 残留
  if (_inlineListenerTimer) { clearTimeout(_inlineListenerTimer); _inlineListenerTimer = null; }
  _inlineListenerTimer = setTimeout(function() {
    _inlineListenerTimer = null;
    if (!_inlinePanel) return;
    document.addEventListener('click', _inlineClickCapture, true);
    document.addEventListener('click', _inlineOutsideClick, false);
    _inlineListenersOn = true;
  }, 100);

  TileAPI.emit('tile:inlineExpanded', { tileId: t.dataset.id, direction: goUp ? 'up' : 'down' });
}

// 模块级 flag,在 capture 和 bubble 阶段之间传递信息
var _inlineClickInside = false;

function _inlineClickCapture(e) {
  if (!_inlinePanel) { _inlineClickInside = false; return; }
  // 此时 e.target 还没经过任何 click handler,尚未被业务代码重渲剔除
  _inlineClickInside =
    _inlinePanel.contains(e.target) ||
    (_inlineSourceTile && _inlineSourceTile.contains(e.target)) ||
    // portal 到 body 的 UIKit 浮层、对话框、toast、对话大图预览层 也算"面板内"
    // (.conv-preview-overlay 全屏预览 append 到 body, 不加白名单会被判成"点击面板外"→ 关大图时误折叠对话面板)
    (e.target.closest && !!e.target.closest('.uik-sel-pop, .uik-dlg-overlay, #toast, .conv-preview-overlay'));
}

function _inlineOutsideClick(e) {
  if (!_inlinePanel) return;
  // 用 capture 阶段记录的 flag,而不是当下重新判断,避免 DOM 重渲带来的误判
  if (_inlineClickInside) return;
  inlineCollapse();
}

function _resyncInlinePanel() {
  if (!_inlinePanel || !_inlineSourceTile) return;
  // UXP 外框 / vp 尺寸变化时, 重新算 inline-panel 的横向位置和宽度,
  // 否则面板还停在旧位置导致和源磁贴错位 (问题 9/11)
  var t = _inlineSourceTile;
  var gridEl = t.parentElement;
  if (!gridEl || !_vp) return;
  var gridRect = gridEl.getBoundingClientRect();
  var vpRect = _vp.getBoundingClientRect();
  var gridLeft = gridRect.left - vpRect.left;
  var gridWidth = gridRect.width;
  _inlinePanel.style.left = gridLeft + 'px';
  _inlinePanel.style.width = gridWidth + 'px';
  // top 也跟着真实位置重算 (向下展开时面板紧贴磁贴底部) — getBoundingClientRect 兼容半高首行
  var tileRect2 = t.getBoundingClientRect();
  var tileTopInVp = tileRect2.top - vpRect.top + _vp.scrollTop;
  var tileBottomInVp = tileRect2.bottom - vpRect.top + _vp.scrollTop;
  if (_inlinePanel.classList.contains('up-direction')) {
    _inlinePanel.style.top = (tileTopInVp - _inlinePanel.offsetHeight) + 'px';
  } else {
    _inlinePanel.style.top = tileBottomInVp + 'px';
  }
}

function inlineCollapse() {
  if (!_inlinePanel) return;

  // 关闭所有 UIKit 弹出层
  if (window.UIKit && window.UIKit.closeAllPopups) window.UIKit.closeAllPopups();

  // 取消挂起中的 listener 注册(展开 100ms 内被收起的情况)
  if (_inlineListenerTimer) { clearTimeout(_inlineListenerTimer); _inlineListenerTimer = null; }
  // 只在已挂时移除,否则 noop
  if (_inlineListenersOn) {
    document.removeEventListener('click', _inlineOutsideClick, false);
    document.removeEventListener('click', _inlineClickCapture, true);
    _inlineListenersOn = false;
  }
  _inlineClickInside = false;

  var panel = _inlinePanel;
  var tileDef = _inlineSourceTile ? TileAPI.getTileDef(_inlineSourceTile.dataset.id) : null;

  // 调用清理
  if (tileDef) {
    if (tileDef._inlineCleanup) { try { tileDef._inlineCleanup(); } catch(e) {} tileDef._inlineCleanup = null; }
    if (tileDef.onCollapse) { try { tileDef.onCollapse(); } catch(e) {} }
  }

  // 收起面板动画:根据方向使用不同属性
  if (panel.classList.contains('up-direction')) {
    // 上展开:滑回磁贴顶部方向(transform 动画)
    panel.style.transform = 'translateY(' + (panel.offsetHeight) + 'px)';
    panel.style.opacity = '0';
  } else {
    // 下展开:height 动画
    panel.style.height = '0px';
    panel.style.opacity = '0';
  }
  panel.classList.remove('open');

  // 恢复所有磁贴 — 但源磁贴的 inline-source 不立刻去, 留到面板动画结束才移除.
  // 原因: inline-source 的 CSS (border-bottom:none / 不圆角底部 / ::after 1px 接缝盖板 /
  //       box-shadow 主题色描边) 一旦撤掉, 源磁贴的底边会"瞬间长出来", 但面板还在那
  //       0.35s 慢慢收, 接缝处就会闪烁一下底边. 留 350ms 让两者同步消失, 接缝平稳收掉.
  var sourceTile = _inlineSourceTile;
  var allT = sourceTile ? tilesInGrid(sourceTile.parentElement) : [];
  allT.forEach(function(tile) {
    tile.style.transform = '';
    if (tile === sourceTile) {
      tile.classList.remove('frozen');
      // inline-source 留给下面 setTimeout 一起去
    } else {
      tile.classList.remove('frozen', 'inline-source');
    }
  });
  _inlineShiftedTiles = [];

  // 延迟移除面板DOM + 源磁贴 inline-source (一起收, 避免边框闪烁)
  setTimeout(function() {
    if (panel.parentElement) panel.parentElement.removeChild(panel);
    if (sourceTile) sourceTile.classList.remove('inline-source');
  }, 350);

  _inlinePanel = null;
  _inlineSourceTile = null;

  TileAPI.emit('tile:inlineCollapsed', {});
}

// ========== 面板模式切换 ==========

/** 图标模式 → 面板模式：隐藏图标内容，显示面板内容 */
function _switchToPanelMode(tileEl, tileDef) {
  // 隐藏翻转/图标内容
  var flipBox = tileEl.querySelector('.tile-flip-box');
  var inner = tileEl.querySelector('.tile-inner:not(.folder-grid-inner)');
  if (flipBox) flipBox.style.display = 'none';
  if (inner && !flipBox) inner.style.display = 'none';

  // 停止入场/翻转动画
  tileEl.classList.remove('live');

  // 显示面板内容区
  var ec = tileEl.querySelector('.tile-expand-content');
  if (ec) {
    // 用 flex column,让 panel-mode 下子面板的 flex 链通畅(避免 textarea 内容多时撑大父级、把顶栏挤出)
    ec.style.display = 'flex';
    ec.style.flexDirection = 'column';
    ec.style.opacity = '1';
    ec.style.transform = '';
    ec.style.position = 'relative';
    ec.style.zIndex = '5';
    ec.style.pointerEvents = 'auto';
    ec.style.userSelect = 'auto';
    ec.style.cursor = 'auto';
    ec.style.height = '100%';
    ec.style.marginTop = '0';
    // 渲染面板内容
    ec._isInline = false;
    // 先清旧 cleanup(避免 listener 重复注册)
    if (tileDef && tileDef._panelCleanup) { try { tileDef._panelCleanup(); } catch(e) {} tileDef._panelCleanup = null; }
    if (tileDef && tileDef._inlineCleanup) { try { tileDef._inlineCleanup(); } catch(e) {} tileDef._inlineCleanup = null; }
    if (tileDef && tileDef.onExpand) {
      var _pw = ec.clientWidth, _ph = ec.clientHeight;
      var _playout = _calcLayout(_pw, _ph);
      try { tileDef._panelCleanup = tileDef.onExpand(ec, { width: _pw, height: _ph, layout: _playout }); } catch(err) { console.error('[TileEngine] panel onExpand error:', err); }
    }
    // 响应式尺寸监听
    _applyPanelLayout(ec, tileDef, tileDef && tileDef.onExpand);
    _observePanelSize(ec, tileDef, tileDef && tileDef.onExpand);
  }

  // 隐藏角标
  var badge = tileEl.querySelector('.tile-badge');
  if (badge) badge.style.display = 'none';

  tileEl.classList.add('panel-mode');
}

/** 根据容器尺寸计算 layout 类型 */
function _calcLayout(w, h) {
  // 5 种 layout:
  // narrow   - 宽<200: 极窄，单列紧凑
  // tall     - 宽<300 高>宽*1.5: 瘦高
  // square   - 200<=宽<400: 紧凑正方
  // wideshort - 宽>=400 且 宽>高*1.8: 横长条
  // wide     - 宽>=400: 宽大
  if (w < 200) return 'narrow';
  if (w < 300 && h > w * 1.3) return 'tall';
  if (w >= 400 && w > h * 1.8) return 'wideshort';
  if (w < 400) return 'square';
  return 'wide';
}

/** 根据容器尺寸应用响应式 class 并调用 onExpand 重新布局 */
function _applyPanelLayout(container, tileDef, onExpandFn) {
  var panel = container.querySelector('.w10-panel');
  var w = container.clientWidth;
  var h = container.clientHeight;
  var layout = _calcLayout(w, h);
  if (panel) {
    panel.classList.remove('panel-sz-narrow', 'panel-sz-tall', 'panel-sz-square', 'panel-sz-wideshort', 'panel-sz-wide');
    panel.classList.add('panel-sz-' + layout);
  }
  // 如果 layout 变了，重新调用 onExpand
  var prev = container._layoutType;
  if (prev && prev !== layout && tileDef && typeof onExpandFn === 'function') {
    try {
      // 清理旧内容
      if (tileDef._panelCleanup) { try { tileDef._panelCleanup(); } catch(e) {} tileDef._panelCleanup = null; }
      if (tileDef._inlineCleanup) { try { tileDef._inlineCleanup(); } catch(e) {} tileDef._inlineCleanup = null; }
      container.innerHTML = '';
      var cleanup = onExpandFn(container, { width: w, height: h, layout: layout });
      // 保持 cleanup 引用
      if (container._isInline) tileDef._inlineCleanup = cleanup;
      else tileDef._panelCleanup = cleanup;
    } catch(err) { console.error('[TileEngine] re-render on layout change error:', err); }
  }
  container._layoutType = layout;
}

/** 监听容器尺寸变化 */
function _observePanelSize(container, tileDef, onExpandFn) {
  if (!window.ResizeObserver) return;
  if (container._sizeObserver) return;
  var ro = new ResizeObserver(function() { _applyPanelLayout(container, tileDef, onExpandFn); });
  ro.observe(container);
  container._sizeObserver = ro;
}

/** 清理尺寸观察器 */
function _unobservePanelSize(container) {
  if (container._sizeObserver) {
    try { container._sizeObserver.disconnect(); } catch(e) {}
    container._sizeObserver = null;
  }
  container._layoutType = null;
}

/** 面板模式 → 图标模式：恢复图标显示，隐藏面板内容 */
function _switchToIconMode(tileEl, tileDef) {
  // 调用清理
  if (tileDef && tileDef._panelCleanup) { try { tileDef._panelCleanup(); } catch(e) {} tileDef._panelCleanup = null; }
  if (tileDef && tileDef.onCollapse) { try { tileDef.onCollapse(); } catch(e) {} }

  // 隐藏面板内容 + 清 panel-mode 时注入的所有 style
  // display 必须清空(''),不能设 'none':否则全屏展开时 .tile.expanded 的 css 规则被 inline 样式压过
  var ec = tileEl.querySelector('.tile-expand-content');
  if (ec) {
    _unobservePanelSize(ec);
    ec.style.display = '';          // 让 .tile-expand-content 的默认 display:none / .tile.expanded 的 display:block 接管
    ec.style.flexDirection = '';
    ec.style.opacity = '';
    ec.style.height = '';
    ec.style.marginTop = '';
    ec.style.position = '';
    ec.style.zIndex = '';
    ec.style.pointerEvents = '';
    ec.style.userSelect = '';
    ec.style.cursor = '';
    ec.style.transform = '';
    ec._isInline = undefined;
    ec.innerHTML = '';
  }

  // 恢复图标/翻转内容
  var flipBox = tileEl.querySelector('.tile-flip-box');
  var inner = tileEl.querySelector('.tile-inner:not(.folder-grid-inner)');
  if (flipBox) flipBox.style.display = '';
  if (inner && !flipBox) inner.style.display = '';

  // 恢复翻转动画
  if (tileDef && tileDef.live) tileEl.classList.add('live');

  // 恢复角标
  var badge = tileEl.querySelector('.tile-badge');
  if (badge) badge.style.display = '';

  tileEl.classList.remove('panel-mode');
}

// ========== 颜色选择器 (HSL) ==========

function _hslToHex(h, s, l) {
  s /= 100; l /= 100;
  var c = (1 - Math.abs(2 * l - 1)) * s;
  var x = c * (1 - Math.abs((h / 60) % 2 - 1));
  var m = l - c / 2;
  var r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  r = Math.round((r + m) * 255); g = Math.round((g + m) * 255); b = Math.round((b + m) * 255);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

// ============================================================
//  磁贴颜色选择器(编辑栏调用)
//  picker 挂到 body 顶层,定位在 anchorEl(编辑工具栏按钮)上方
//  同一时间只能打开一个,再次调用会关闭旧的
// ============================================================

var _activeColorPicker = null;

function _openTileColorPicker(tileEl, anchorEl) {
  // 如果已打开且目标一致 → 关闭(toggle 行为)
  if (_activeColorPicker && _activeColorPicker._tileEl === tileEl) {
    _closeTileColorPicker();
    return;
  }
  _closeTileColorPicker();

  var tileId = tileEl.dataset.id;

  // 读取保存的 HSL 值
  var saved = (window._storageManager ? window._storageManager.get('__tile_colors') || {} : {})[tileId];
  var hsl = saved && saved.h !== undefined ? saved : { h: 210, s: 50, l: 15 };

  // HSL 选色面板(portal 到 body 顶层)
  var picker = document.createElement('div');
  picker.className = 'tile-color-picker tile-color-picker-portal open';
  picker._tileEl = tileEl;

  function makeRow(label, id, min, max, val, bgStyle) {
    var row = document.createElement('div');
    row.className = 'tile-hsl-row';
    row.innerHTML =
      '<span class="tile-hsl-label">' + label + '</span>' +
      '<input type="range" class="tile-hsl-slider" data-hsl="' + id + '" min="' + min + '" max="' + max + '" value="' + val + '" style="' + (bgStyle || '') + '">' +
      '<span class="tile-hsl-val" data-hsl-val="' + id + '">' + val + '</span>';
    return row;
  }

  picker.appendChild(makeRow('H', 'h', 0, 360, hsl.h,
    'background:linear-gradient(to right,hsl(0,80%,50%),hsl(60,80%,50%),hsl(120,80%,50%),hsl(180,80%,50%),hsl(240,80%,50%),hsl(300,80%,50%),hsl(360,80%,50%))'));
  picker.appendChild(makeRow('S', 's', 0, 100, hsl.s,
    'background:linear-gradient(to right,hsl(' + hsl.h + ',0%,' + hsl.l + '%),hsl(' + hsl.h + ',100%,' + hsl.l + '%))'));
  picker.appendChild(makeRow('L', 'l', 0, 100, hsl.l,
    'background:linear-gradient(to right,hsl(' + hsl.h + ',' + hsl.s + '%,0%),hsl(' + hsl.h + ',' + hsl.s + '%,50%),hsl(' + hsl.h + ',' + hsl.s + '%,100%))'));

  var resetBtn = document.createElement('div');
  resetBtn.className = 'tile-color-reset';
  resetBtn.textContent = '重置';
  picker.appendChild(resetBtn);

  function updateColor() {
    var h = +picker.querySelector('[data-hsl="h"]').value;
    var s = +picker.querySelector('[data-hsl="s"]').value;
    var l = +picker.querySelector('[data-hsl="l"]').value;
    picker.querySelector('[data-hsl-val="h"]').textContent = h;
    picker.querySelector('[data-hsl-val="s"]').textContent = s;
    picker.querySelector('[data-hsl-val="l"]').textContent = l;
    var _tcoA = _getTileColorAlpha();
    tileEl.style.background = 'hsla(' + h + ',' + s + '%,' + l + '%,' + _tcoA + ')';
    tileEl.style.borderColor = 'hsla(' + h + ',' + s + '%,' + l + '%,' + Math.min(1, _tcoA * 2.5).toFixed(3) + ')';
    // 更新 S 和 L 滑块背景
    var sSlider = picker.querySelector('[data-hsl="s"]');
    var lSlider = picker.querySelector('[data-hsl="l"]');
    if (sSlider) sSlider.style.background = 'linear-gradient(to right,hsl(' + h + ',0%,' + l + '%),hsl(' + h + ',100%,' + l + '%))';
    if (lSlider) lSlider.style.background = 'linear-gradient(to right,hsl(' + h + ',' + s + '%,0%),hsl(' + h + ',' + s + '%,50%),hsl(' + h + ',' + s + '%,100%))';
    _saveTileColor(tileId, { h: h, s: s, l: l });
    // 编辑栏按钮预览色
    if (anchorEl) {
      var dot = anchorEl.querySelector('.tb-color-dot');
      if (dot) dot.style.background = _hslToHex(h, s, l);
    }
  }

  picker.querySelectorAll('[data-hsl]').forEach(function(el) {
    el.addEventListener('input', updateColor);
  });

  resetBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    tileEl.style.background = ''; tileEl.style.borderColor = '';
    _saveTileColor(tileId, null);
    if (anchorEl) {
      var dot = anchorEl.querySelector('.tb-color-dot');
      if (dot) dot.style.background = '';
    }
  });

  // 挂到 body,定位在 anchorEl 上方
  document.body.appendChild(picker);
  _positionColorPicker(picker, anchorEl);

  // 面板内部的所有事件都不要冒泡到 document 层(避免触发编辑栏选中清除等逻辑)
  ['mousedown', 'mouseup', 'click'].forEach(function(evt) {
    picker.addEventListener(evt, function(e) { e.stopPropagation(); }, false);
  });

  // 点击面板外关闭
  var outsideClick = function(e) {
    if (picker.contains(e.target)) return;
    if (anchorEl && anchorEl.contains(e.target)) return;   // 点按钮自己不算外部
    _closeTileColorPicker();
  };
  setTimeout(function() { document.addEventListener('mousedown', outsideClick, true); }, 0);

  // 窗口变化时重新定位
  var onResize = function() { _positionColorPicker(picker, anchorEl); };
  window.addEventListener('resize', onResize);

  picker._cleanup = function() {
    document.removeEventListener('mousedown', outsideClick, true);
    window.removeEventListener('resize', onResize);
  };

  _activeColorPicker = picker;
}

function _closeTileColorPicker() {
  if (!_activeColorPicker) return;
  if (_activeColorPicker._cleanup) _activeColorPicker._cleanup();
  if (_activeColorPicker.parentNode) _activeColorPicker.parentNode.removeChild(_activeColorPicker);
  _activeColorPicker = null;
}

function _positionColorPicker(picker, anchorEl) {
  if (!anchorEl) return;
  var ar = anchorEl.getBoundingClientRect();
  // 先放一次,拿到真实尺寸
  picker.style.left = '0px';
  picker.style.top = '0px';
  var pr = picker.getBoundingClientRect();
  var vw = window.innerWidth, vh = window.innerHeight;
  // 水平:以按钮为中心
  var left = ar.left + ar.width / 2 - pr.width / 2;
  left = Math.max(8, Math.min(vw - pr.width - 8, left));
  // 垂直:放在按钮上方 8px
  var top = ar.top - pr.height - 8;
  if (top < 8) top = ar.bottom + 8;   // 上方不够就放下方
  picker.style.left = left + 'px';
  picker.style.top = top + 'px';
}


function _saveTileColor(tileId, hslOrNull) {
  var colors = window._storageManager ? window._storageManager.get('__tile_colors') || {} : {};
  if (hslOrNull) colors[tileId] = hslOrNull;
  else delete colors[tileId];
  if (window._storageManager) window._storageManager.set('__tile_colors', colors);
}

function _getTileColorAlpha() {
  var cs = getComputedStyle(document.documentElement).getPropertyValue('--tile-color-opacity');
  var a = parseFloat(cs);
  if (isNaN(a)) a = 0.1;
  return a;
}

function _restoreTileColors() {
  var colors = window._storageManager ? window._storageManager.get('__tile_colors') || {} : {};
  var keys = Object.keys(colors);
  var a = _getTileColorAlpha();
  var b = Math.min(1, a * 2.5).toFixed(3);
  for (var i = 0; i < keys.length; i++) {
    var el = _tileElements[keys[i]];
    var hsl = colors[keys[i]];
    if (el && hsl && hsl.h !== undefined) {
      el.style.background = 'hsla(' + hsl.h + ',' + hsl.s + '%,' + hsl.l + '%,' + a + ')';
      el.style.borderColor = 'hsla(' + hsl.h + ',' + hsl.s + '%,' + hsl.l + '%,' + b + ')';
    }
  }
}

function _restoreSingleTileColor(el) {
  var tileId = el.dataset.id;
  var colors = window._storageManager ? window._storageManager.get('__tile_colors') || {} : {};
  var hsl = colors[tileId];
  if (hsl && hsl.h !== undefined) {
    var a = _getTileColorAlpha();
    var b = Math.min(1, a * 2.5).toFixed(3);
    el.style.background = 'hsla(' + hsl.h + ',' + hsl.s + '%,' + hsl.l + '%,' + a + ')';
    el.style.borderColor = 'hsla(' + hsl.h + ',' + hsl.s + '%,' + hsl.l + '%,' + b + ')';
  }
}

// ========== TileEngine 公共接口 ==========

var TileEngine = {
  init: function() {
    _vp = $('vp');
    _expBg = $('expBg');
    updCell();
    window.addEventListener('resize', updCell);
    // 展开磁贴跟随面板缩放
    window.addEventListener('resize', function() {
      if (_expanded) {
        _expanded.style.top = '4px'; _expanded.style.left = _expandLeftPx() + 'px';
        _expanded.style.width = _fullExpandW() + 'px';
        _expanded.style.height = (window.innerHeight - 8) + 'px';
      }
      _resyncInlinePanel();
      // 广播给磁贴: 外框/视口尺寸变了, 需要重绘的磁贴(如剪影 canvas)自行响应
      try { TileAPI.emit('engine:resize'); } catch (e) {}
    });
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function() {
        updCell();
        if (_expanded) {
          _expanded.style.top = '4px'; _expanded.style.left = _expandLeftPx() + 'px';
          _expanded.style.width = _fullExpandW() + 'px';
          _expanded.style.height = (window.innerHeight - 8) + 'px';
        }
        _resyncInlinePanel();
        try { TileAPI.emit('engine:resize'); } catch (e) {}
      });
      ro.observe(_vp);
    }

    // 全局事件
    _expBg.addEventListener('click', collapse);
    document.addEventListener('click', function(e) {
      if (!e.target.closest('.tile') && !e.target.closest('.edit-toolbar') && !e.target.closest('.add-group-btn')) {
        if (_editMode) exitEdit();
      }
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        if (_inlinePanel) { inlineCollapse(); return; }
        if (_expanded) { collapse(); return; }
        if (_editMode) exitEdit();
      }
    });

    // Dock / expandTile 调用: 一律"全屏(全局)展开", 不管磁贴大小或当前是否面板模式。
    // 已展开/动画中则忽略(防重复)。面板模式(大磁贴)先干净拆掉面板渲染再全屏展开,
    // 收起时 collapse() 会自动把大磁贴还原回面板模式。
    TileAPI.on('tile:requestExpand', function(data) {
      if (!data || !data.tileId) return;
      var el = _tileElements[data.tileId];
      // v6.5.6b: 磁贴在抽屉里 → 先放回桌面再展开。
      // 两种形态都要接住: ①收纳后元素还挂在 _tileElements 但已脱离 DOM(isConnected=false)
      // ②启动时就在抽屉 → 从未渲染, el 是 undefined (上一版漏了这种, 导致 Dock 拉不起)
      var inDrawer = window.TileDrawer && TileDrawer.has && TileDrawer.has(data.tileId);
      if (inDrawer && (!el || !el.isConnected)) {
        try { TileDrawer.restore(data.tileId); } catch(_) {}
        // 等一帧让 restore 渲染/布局落定再展开
        requestAnimationFrame(function() {
          var el2 = _tileElements[data.tileId];
          if (el2 && el2.isConnected && !el2.classList.contains('expanded')) expand(el2);
        });
        return;
      }
      if (!el || !el.isConnected) return;
      if (el.classList.contains('expanded') || el.classList.contains('expanding')) return;
      var def = TileAPI.getTileDef(el.dataset.id);
      if (el.classList.contains('panel-mode') && typeof _switchToIconMode === 'function') {
        _switchToIconMode(el, def);   // 清面板内容 + 解除 ResizeObserver, 避免残留叠加
      }
      expand(el);
    });
    TileAPI.on('tile:requestCollapse', function() { collapse(); });

    // 覆盖TileAPI.getTileState
    TileAPI.getTileState = function(tileId) {
      var el = _tileElements[tileId];
      if (!el) return null;
      return {
        expanded: el.classList.contains('expanded'),
        position: { col: +el.dataset.col, row: +el.dataset.row, w: +el.dataset.w || 1, h: +el.dataset.h || 1 }
      };
    };

    // 恢复保存的磁贴颜色
    setTimeout(_restoreTileColors, 100);

    // 底栏编辑菜单按钮
    var tbAutoSort = document.getElementById('tbAutoSort');
    if (tbAutoSort) tbAutoSort.addEventListener('click', function() { TileEngine.autoSort(); });

    // 全部收纳:把当前桌面所有可收纳磁贴一次性塞进抽屉
    var tbStashAll = document.getElementById('tbStashAll');
    if (tbStashAll) tbStashAll.addEventListener('click', function() {
      if (!window.TileDrawer) { TileAPI.toast('抽屉未加载', 'warn'); return; }
      // 收集桌面上所有非保护磁贴
      var ids = [];
      allTiles().forEach(function(t) {
        var tid = t.dataset.id;
        if (tid && !TileDrawer.isProtected(tid)) ids.push(tid);
      });
      if (!ids.length) { TileAPI.toast('桌面上没有可收纳的磁贴', 'info'); return; }
      TileAPI.confirm('确定把桌面上 ' + ids.length + ' 个磁贴全部收入抽屉吗?\n抽屉内的磁贴不会被删除,可以随时取回。').then(function(ok) {
        if (!ok) return;
        var done = 0;
        ids.forEach(function(id) { if (TileDrawer.stash(id)) done++; });
        TileAPI.toast('已收纳 ' + done + ' 个磁贴到抽屉', 'success');
      });
    });

    // 清除所有磁贴颜色: 一次性把 __tile_colors 清空, 并重置所有磁贴的 inline 背景/边框
    var tbClearColors = document.getElementById('tbClearColors');
    if (tbClearColors) tbClearColors.addEventListener('click', function() {
      var colors = window._storageManager ? window._storageManager.get('__tile_colors') || {} : {};
      var n = Object.keys(colors).length;
      if (!n) { TileAPI.toast('当前没有设置颜色的磁贴', 'info'); return; }
      TileAPI.confirm('确定清除全部 ' + n + ' 个磁贴的颜色吗?\n(只清颜色, 不影响排布/内容)').then(function(ok) {
        if (!ok) return;
        if (window._storageManager) window._storageManager.set('__tile_colors', {});
        // 重置所有磁贴的 inline 颜色样式
        allTiles().forEach(function(t) {
          t.style.background = '';
          t.style.borderColor = '';
        });
        // 同步编辑栏颜色按钮的预览点 (若当前选中磁贴)
        if (_selectedEditTile) { var d = document.querySelector('#tbColorPick .tb-color-dot'); if (d) d.style.background = ''; }
        TileAPI.toast('已清除所有磁贴颜色', 'success');
      });
    });

    var tbNewFolder = document.getElementById('tbNewFolder');
    var tbFolderInput = document.getElementById('tbFolderInput');
    var tbFolderName = document.getElementById('tbFolderName');
    var tbFolderConfirm = document.getElementById('tbFolderConfirm');
    var tbFolderCancel = document.getElementById('tbFolderCancel');
    if (tbNewFolder) tbNewFolder.addEventListener('click', function() {
      tbNewFolder.style.display = 'none';
      tbFolderInput.style.display = 'flex';
      tbFolderName.value = '';
      tbFolderName.focus();
    });
    if (tbFolderConfirm) tbFolderConfirm.addEventListener('click', function() {
      var name = tbFolderName.value.trim();
      if (name) {
        GroupManager.createFolder(name);
        TileAPI.toast('文件夹已创建', 'success');
      }
      tbFolderInput.style.display = 'none';
      tbNewFolder.style.display = 'flex';
    });
    if (tbFolderCancel) tbFolderCancel.addEventListener('click', function() {
      tbFolderInput.style.display = 'none';
      tbNewFolder.style.display = 'flex';
    });
    if (tbFolderName) tbFolderName.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') tbFolderConfirm.click();
      if (e.key === 'Escape') tbFolderCancel.click();
    });

    // 展开模式切换按钮
    var tbExpandMode = document.getElementById('tbExpandMode');
    var tbExpandModeLabel = document.getElementById('tbExpandModeLabel');
    var _selectedEditTile = null;

    if (tbExpandMode) tbExpandMode.addEventListener('click', function() {
      if (!_selectedEditTile) return;
      var current = _selectedEditTile.dataset.expandMode || 'inline';
      var next = (current === 'inline') ? 'full' : 'inline';
      _selectedEditTile.dataset.expandMode = next;
      tbExpandModeLabel.textContent = next === 'full' ? '全屏展开' : '就地展开';
      // 保存到存储
      var modes = window._storageManager ? window._storageManager.get('__tile_expand_modes') || {} : {};
      modes[_selectedEditTile.dataset.id] = next;
      if (window._storageManager) window._storageManager.set('__tile_expand_modes', modes);
    });

    // 颜色选择按钮
    var tbColorPick = document.getElementById('tbColorPick');
    if (tbColorPick) tbColorPick.addEventListener('click', function(e) {
      e.stopPropagation();
      if (!_selectedEditTile) return;
      _openTileColorPicker(_selectedEditTile, tbColorPick);
    });

    // 移入抽屉按钮
    var tbStash = document.getElementById('tbStash');
    if (tbStash) tbStash.addEventListener('click', function(e) {
      e.stopPropagation();
      if (!_selectedEditTile) return;
      var tid = _selectedEditTile.dataset.id;
      if (!window.TileDrawer) { TileAPI.toast('抽屉未加载', 'warn'); return; }
      if (TileDrawer.isProtected(tid)) { TileAPI.toast('该磁贴不能收纳', 'warn'); return; }
      TileDrawer.stash(tid);
      TileAPI.toast('已移入抽屉', 'success');
      _selectedEditTile = null;
      if (tbExpandMode) tbExpandMode.style.display = 'none';
      if (tbColorPick) tbColorPick.style.display = 'none';
      tbStash.style.display = 'none';
      _closeTileColorPicker();
    });

    // 更新编辑栏颜色按钮的预览色(根据已保存的磁贴颜色)
    function _updateTbColorDot(tile) {
      if (!tbColorPick) return;
      var dot = tbColorPick.querySelector('.tb-color-dot');
      if (!dot) return;
      var colors = window._storageManager ? window._storageManager.get('__tile_colors') || {} : {};
      var hsl = colors[tile && tile.dataset.id];
      if (hsl && hsl.h !== undefined) dot.style.background = _hslToHex(hsl.h, hsl.s, hsl.l);
      else dot.style.background = '';
    }

    // 编辑模式下点击磁贴 → 显示展开模式 + 颜色按钮 + 移入抽屉按钮
    // 用 capture 阶段,因为面板模式下的控件(UIKit select / step button 等)会 stopPropagation
    document.addEventListener('click', function(e) {
      if (!_editMode) {
        if (tbExpandMode) tbExpandMode.style.display = 'none';
        if (tbColorPick) tbColorPick.style.display = 'none';
        if (tbStash) tbStash.style.display = 'none';
        _closeTileColorPicker();
        _selectedEditTile = null;
        return;
      }
      if (e.target.closest('.edit-toolbar')) return; // 点击工具栏不影响选择状态
      if (e.target.closest('.tile-color-picker-portal')) return; // 点取色器面板不影响
      var tile = e.target.closest('.tile');
      if (tile && !tile.dataset.folderId && tile.dataset.pinTop !== '1') {
        var w = +tile.dataset.w || 1, h = +tile.dataset.h || 1;
        // 如果换了选中对象,关掉旧的取色器
        if (_selectedEditTile !== tile) _closeTileColorPicker();
        _selectedEditTile = tile;

        // 展开方式:只有 1x1 有意义(大磁贴始终是面板模式)
        if (w === 1 && h === 1) {
          var mode = tile.dataset.expandMode || 'inline';
          tbExpandModeLabel.textContent = mode === 'full' ? '全屏展开' : '就地展开';
          tbExpandMode.style.display = 'flex';
        } else if (tbExpandMode) {
          tbExpandMode.style.display = 'none';
        }
        // 颜色:所有非文件夹磁贴都能改
        if (tbColorPick) { tbColorPick.style.display = 'flex'; _updateTbColorDot(tile); }
        // 移入抽屉:非核心/非保护磁贴都行
        if (tbStash) {
          var tid = tile.dataset.id;
          var canStash = window.TileDrawer && !TileDrawer.isProtected(tid);
          tbStash.style.display = canStash ? 'flex' : 'none';
        }
        return;
      }
      if (tbExpandMode) tbExpandMode.style.display = 'none';
      if (tbColorPick) tbColorPick.style.display = 'none';
      if (tbStash) tbStash.style.display = 'none';
      _closeTileColorPicker();
      _selectedEditTile = null;
    }, true);   // capture:先于子元素的 stopPropagation 运行

  },

  /** 渲染一个磁贴到指定分组grid */
  renderTile: function(tileDef, gridEl) {
    var el = createTileDOM(tileDef);
    gridEl.appendChild(el);
    // pinTop 锁定磁贴: 不进主网格, 改挂到独立的 #topbarHost (sticky 钉顶).
    // 不参与 grid 布局, 不设 col/row, 不调 applyPos, 不改 gridTemplateRows.
    // 这样主网格回归"每行等高 _cell"的纯净假设, 拖拽公式 (cellPx/gCoord) 自动正确.
    if (tileDef.pinTop) {
      var host = document.getElementById('topbarHost');
      if (host) {
        if (el.parentElement !== host) host.appendChild(el);
        // pinTop 不占网格行/列, 清掉无意义的 dataset (createTileDOM 默认设了 1,1)
        delete el.dataset.col;
        delete el.dataset.row;
      }
      return el;
    }
    // 自动排列：找到空位放置
    var sz = tileDef.defaultSize || { w: 1, h: 1 };
    // 读保存布局,让 autoPlace 避开"老磁贴稍后会复位的格子" — 否则 restoreLayout
    // 把老磁贴搬回来时会和这里随机落下的新磁贴重叠
    var savedLayout = window._storageManager ? window._storageManager.getLayout() : null;
    var groupId = gridEl ? gridEl.dataset.groupId : null;
    var pos;
    // 如果当前磁贴在保存布局里有记录 → 直接用保存位置(restoreLayout 之后也会用同一位置,不会动)
    if (savedLayout && savedLayout[tileDef.id]) {
      var sp = savedLayout[tileDef.id];
      var spCol = +sp.col || 1, spRow = +sp.row || 1;
      var spW = +sp.w || 1, spH = +sp.h || 1;
      // 1) 跟已有的 pinTop 磁贴重叠? (现已脱出主网格, 这里几乎不会命中)
      // 2) 跟主网格里其他已渲染磁贴重叠? (兜底破损数据, 见 restoreLayout 同款逻辑)
      var posConflict = false;
      tilesInGrid(gridEl).forEach(function(tt) {
        if (posConflict) return;
        if (tt === el) return;                       // 跳过自己 — gridEl.appendChild(el) 已经把自己加进去了, 自己的 dataset 还是 createTileDOM 默认值 (1,1,defW,defH), 不能拿来跟自己的 savedLayout 比, 否则保存位置在 (1,1,...) 的磁贴会被自己"挤走"
        var pc = +tt.dataset.col, pr = +tt.dataset.row, pw = +tt.dataset.w || 1, ph = +tt.dataset.h || 1;
        if (!isFinite(pc) || !isFinite(pr)) return; // pinTop 已 delete col/row, 跳过
        if (overlaps(spCol, spRow, spW, spH, pc, pr, pw, ph)) posConflict = true;
      });
      if (posConflict) {
        pos = autoPlace(gridEl, spW, spH, {
          reservedLayout: savedLayout,
          skipTileId: tileDef.id,
          groupId: groupId
        });
        el.dataset.w = spW; el.dataset.h = spH;
      } else {
        pos = { col: spCol, row: spRow };
        if (sp.w) el.dataset.w = sp.w;
        if (sp.h) el.dataset.h = sp.h;
      }
    } else {
      // 新磁贴(保存布局里没有)→ 找一个既没被现有磁贴占,也不在保存布局任何老磁贴目标位置上的格子
      pos = autoPlace(gridEl, +el.dataset.w || sz.w, +el.dataset.h || sz.h, {
        reservedLayout: savedLayout,
        skipTileId: tileDef.id,
        groupId: groupId
      });
    }
    el.dataset.col = pos.col; el.dataset.row = pos.row;
    applyPos(el);
    // 磁贴最终尺寸 >1x1 → 直接进面板模式。
    // restoreLayout 只覆盖"保存布局里有记录"的磁贴;新磁贴(刚拖出/首次安装的大默认磁贴)
    // 不在保存布局里, 会被 restoreLayout 跳过, 导致大尺寸却卡在按钮模式。这里兜底。
    var _fw = +el.dataset.w || 1, _fh = +el.dataset.h || 1;
    if ((_fw > 1 || _fh > 1) && !el.classList.contains('panel-mode')) {
      _switchToPanelMode(el, tileDef);
    }
    // 更新grid行数
    var maxR = 0;
    tilesInGrid(gridEl).forEach(function(t) {
      var r = +t.dataset.row || 1, h = +t.dataset.h || 1;
      if (r + h - 1 > maxR) maxR = r + h - 1;
    });
    gridEl.style.gridTemplateRows = 'repeat(' + Math.max(maxR + 1, 3) + ', var(--cell))';
    return el;
  },

  /** 获取磁贴DOM */
  getTileElement: function(tileId) { return _tileElements[tileId] || null; },

  /** 重渲指定磁贴的当前可见内容(面板模式走 onExpand, 小卡走 renderFront)。
   *  用于配置变更后(如算力槽位顺序/改名)让磁贴即时反映, 不用手动调大小。 */
  rerenderTile: function(tileId) {
    var el = _tileElements[tileId];
    if (!el || !el.isConnected) return;
    var tileDef = TileAPI.getTileDef && TileAPI.getTileDef(tileId);
    if (!tileDef) return;
    if (el.classList.contains('panel-mode')) {
      var ec = el.querySelector('.tile-expand-content');
      if (ec && tileDef.onExpand) {
        if (tileDef._panelCleanup) { try { tileDef._panelCleanup(); } catch(e) {} tileDef._panelCleanup = null; }
        var _pw = ec.clientWidth, _ph = ec.clientHeight;
        var _pl = _calcLayout(_pw, _ph);
        try { tileDef._panelCleanup = tileDef.onExpand(ec, { width: _pw, height: _ph, layout: _pl }); } catch(err) {}
      }
    } else {
      var inner = el.querySelector('.tile-inner:not(.folder-grid-inner)') || el.querySelector('.tile-flip-front');
      if (inner) {
        var w = +el.dataset.w || 1, h = +el.dataset.h || 1;
        _renderFrontContent(inner, tileDef, w, h);
      }
    }
  },

  /** 批量重渲一组磁贴(只渲已渲染且在场的);传入 id 数组限定范围, 避免误动无关磁贴。 */
  rerenderTiles: function(idList) {
    if (!idList || !idList.length) return;
    for (var i = 0; i < idList.length; i++) {
      try { this.rerenderTile(idList[i]); } catch(e) {}
    }
  },

  /** 更新角标 */
  updateBadge: function(tileId, text) {
    var el = _tileElements[tileId];
    if (!el) return;
    var badge = el.querySelector('.tile-badge');
    if (text) {
      if (!badge) { badge = document.createElement('span'); badge.className = 'tile-badge'; el.appendChild(badge); }
      badge.textContent = text;
    } else {
      if (badge) badge.remove();
    }
  },

  /** 更新翻转背面 */
  updateBack: function(tileId, contentOrFn) {
    var el = _tileElements[tileId];
    if (!el) return;
    var back = el.querySelector('.tile-flip-back');
    if (!back) return;
    if (typeof contentOrFn === 'function') { contentOrFn(back); }
    else { back.textContent = contentOrFn; }
  },

  /** 保存当前布局到存储 */
  saveLayout: function() {
    var layout = {};
    allTiles().forEach(function(t) {
      // pinTop 锁定磁贴不持久化位置 (永远 (1,1,4,1))
      if (t.dataset.pinTop === '1') return;
      var groupBody = t.parentElement;
      var groupId = groupBody ? groupBody.dataset.groupId : 'ungrouped';
      layout[t.dataset.id] = {
        col: +t.dataset.col, row: +t.dataset.row,
        w: +t.dataset.w || 1, h: +t.dataset.h || 1,
        group: groupId
      };
    });
    if (window._storageManager) window._storageManager.setLayout(layout);
  },

  /** 从存储恢复布局 */
  restoreLayout: function() {
    var layout = window._storageManager ? window._storageManager.getLayout() : null;
    if (!layout) return false;

    // v6 → v7 迁移: balance/cloud 已合并进 topbar, 静默剔除老布局里的残留键
    var _OBSOLETE = { balance: 1, cloud: 1 };
    var _dirty = false;
    Object.keys(layout).forEach(function(k) {
      if (_OBSOLETE[k]) { delete layout[k]; _dirty = true; }
    });

    // v6.4.8 迁移: history+recyclebin 合并成 records。
    // records 落在 recyclebin 的旧位(没有就用 history 的位), 两个老键删除。
    // 迁移前把原布局备份一份(只备份一次), 出问题可人工恢复。
    if ((layout.recyclebin || layout.history) && !layout.records) {
      try {
        if (window._storageManager && !window._storageManager.get('__layout_backup_pre648')) {
          window._storageManager.set('__layout_backup_pre648', JSON.stringify(layout));
        }
      } catch(_) {}
      var _recSrc = layout.recyclebin || layout.history;
      layout.records = { col: _recSrc.col, row: _recSrc.row, w: _recSrc.w, h: _recSrc.h, group: _recSrc.group };
      _dirty = true;
    }
    if (layout.recyclebin) { delete layout.recyclebin; _dirty = true; }
    if (layout.history) { delete layout.history; _dirty = true; }

    // v6.5.0 迁移: tasks+conversation 合并成 center(生成中心)。
    // center 落在 tasks 的旧位(没有就用 conversation 的位)。备份键复用同一个(已含全量老布局)。
    if ((layout.tasks || layout.conversation) && !layout.center) {
      try {
        if (window._storageManager && !window._storageManager.get('__layout_backup_pre648')) {
          window._storageManager.set('__layout_backup_pre648', JSON.stringify(layout));
        }
      } catch(_) {}
      var _cenSrc = layout.tasks || layout.conversation;
      layout.center = { col: _cenSrc.col, row: _cenSrc.row, w: _cenSrc.w, h: _cenSrc.h, group: _cenSrc.group };
      _dirty = true;
    }
    if (layout.tasks) { delete layout.tasks; _dirty = true; }
    if (layout.conversation) { delete layout.conversation; _dirty = true; }

    // v6.5.0 迁移(三期): batch+partition+tiled 合并成 batchworks(批量工场)。
    // batchworks 落在 batch 的旧位; 三个老磁贴保留注册(可从商店拖回), 但布局键清掉。
    if ((layout.batch || layout.partition || layout.tiled) && !layout.batchworks) {
      try {
        if (window._storageManager && !window._storageManager.get('__layout_backup_pre648')) {
          window._storageManager.set('__layout_backup_pre648', JSON.stringify(layout));
        }
      } catch(_) {}
      var _bwSrc = layout.batch || layout.partition || layout.tiled;
      layout.batchworks = { col: _bwSrc.col, row: _bwSrc.row, w: _bwSrc.w, h: _bwSrc.h, group: _bwSrc.group };
      _dirty = true;
    }
    if (layout.batch) { delete layout.batch; _dirty = true; }
    if (layout.partition) { delete layout.partition; _dirty = true; }
    if (layout.tiled) { delete layout.tiled; _dirty = true; }

    // v7 → v8 迁移: 顶栏脱出 #mainGrid 后, row=1 开放给普通磁贴. 老布局所有磁贴
    // 最低 row=2 (因为旧版顶栏强占 row=1, 拖拽必避开). 全部 row 减 1 紧贴顶栏,
    // 真正吃到半高省下的 30px 空间. 用 storage flag 标记, 只跑一次.
    var _v8MigKey = '__layout_v8_topbar_detach_done';
    var _v8Done = window._storageManager && window._storageManager.get
      ? window._storageManager.get(_v8MigKey) : null;
    if (!_v8Done) {
      Object.keys(layout).forEach(function(k) {
        if (layout[k] && +layout[k].row > 1) {
          layout[k].row = +layout[k].row - 1;
          _dirty = true;
        }
      });
      if (window._storageManager && window._storageManager.set) {
        window._storageManager.set(_v8MigKey, 1);
      }
    }

    if (_dirty && window._storageManager && window._storageManager.setLayout) {
      window._storageManager.setLayout(layout);
    }

    // 先收集 pinTop 磁贴的矩形, 用于检测保存位置的重叠
    // 注意: pinTop 已脱出 #mainGrid (在 #topbarHost 内), 不再占主网格格子,
    // 因此这里返回空数组 — 否则 dataset.col/row 被 delete 后会被 fallback 成 (1,1,4,1),
    // 误把所有保存在 row=1 的磁贴判为冲突, 触发 autoPlace 把它们扔到底部 (越搬越远).
    var pinRects = [];

    var keys = Object.keys(layout);
    // 已恢复磁贴的占位记录 (按 group 分桶), 用来检测保存数据里的重叠 —
    // v7→v8 行号迁移后, 若旧数据本身有破损, 两块磁贴可能算到同一格. 这里兜底.
    var placedByGroup = {};
    for (var i = 0; i < keys.length; i++) {
      var tileId = keys[i];
      var pos = layout[tileId];
      var el = _tileElements[tileId];
      if (!el) continue;
      // pinTop 磁贴永远是 (1,1,4,1), 跳过保存数据
      if (el.dataset.pinTop === '1') continue;

      var posCol = +pos.col, posRow = +pos.row, posW = +pos.w || 1, posH = +pos.h || 1;
      var groupKey = pos.group || (el.parentElement && el.parentElement.dataset.groupId) || 'main';
      if (!placedByGroup[groupKey]) placedByGroup[groupKey] = [];

      // 1) 跟 pinTop (已弃用, 空数组) 重叠? 2) 跟同 group 已恢复的磁贴重叠?
      var conflict = false;
      for (var pi = 0; pi < pinRects.length; pi++) {
        var pr = pinRects[pi];
        if (overlaps(posCol, posRow, posW, posH, pr.col, pr.row, pr.w, pr.h)) { conflict = true; break; }
      }
      if (!conflict) {
        var placed = placedByGroup[groupKey];
        for (var pj = 0; pj < placed.length; pj++) {
          var pp = placed[pj];
          if (overlaps(posCol, posRow, posW, posH, pp.col, pp.row, pp.w, pp.h)) { conflict = true; break; }
        }
      }

      if (conflict) {
        var targetGridForPlace = el.parentElement;
        if (pos.group) {
          var g = document.querySelector('.grid[data-group-id="' + pos.group + '"]');
          if (g) targetGridForPlace = g;
        }
        var newPos = autoPlace(targetGridForPlace, posW, posH, { skipTileId: tileId, groupId: pos.group });
        el.dataset.col = newPos.col; el.dataset.row = newPos.row;
        posCol = newPos.col; posRow = newPos.row;
      } else {
        el.dataset.col = posCol; el.dataset.row = posRow;
      }
      el.dataset.w = posW; el.dataset.h = posH;
      applyPos(el);
      placedByGroup[groupKey].push({ col: posCol, row: posRow, w: posW, h: posH });

      // 如果分组不同，移动到正确的分组
      var currentGroup = el.parentElement ? el.parentElement.dataset.groupId : null;
      if (pos.group && pos.group !== currentGroup) {
        var targetGrid = document.querySelector('.grid[data-group-id="' + pos.group + '"]');
        if (targetGrid) {
          el.parentElement.removeChild(el);
          targetGrid.appendChild(el);
          applyPos(el);
        }
      }

      // 触发onResize让模块更新内容
      var tileDef = TileAPI.getTileDef(tileId);
      if (tileDef && tileDef.onResize) {
        try { tileDef.onResize(posW, posH); } catch(e) {}
      }
      // >1x1 自动进入面板模式
      if (posW > 1 || posH > 1) {
        if (!el.classList.contains('panel-mode')) _switchToPanelMode(el, tileDef);
      } else {
        var inner = el.querySelector('.tile-inner') || el.querySelector('.tile-flip-front');
        if (inner && tileDef) _renderFrontContent(inner, tileDef, posW, posH);
      }
    }

    // 恢复展开模式设置
    var modes = window._storageManager ? window._storageManager.get('__tile_expand_modes') || {} : {};
    var modeKeys = Object.keys(modes);
    for (var mi = 0; mi < modeKeys.length; mi++) {
      var mEl = _tileElements[modeKeys[mi]];
      if (mEl) mEl.dataset.expandMode = modes[modeKeys[mi]];
    }

    _restoreTileColors();
    return true;
  },

  /** 自动排序：按注册顺序重新排列所有磁贴填满空位 */
  autoSort: function() {
    var grid = document.getElementById('mainGrid');
    if (!grid) return;
    var allTilesInMain = tilesInGrid(grid);
    // pinTop 磁贴占用的格子构建 occupied 表(不参与排序)
    var occupied = {};
    var tiles = [];
    allTilesInMain.forEach(function(t) {
      if (t.dataset.pinTop === '1') {
        var pc = +t.dataset.col || 1, pr = +t.dataset.row || 1;
        var pw = +t.dataset.w || 1, ph = +t.dataset.h || 1;
        for (var dr = 0; dr < ph; dr++) for (var dc = 0; dc < pw; dc++) {
          occupied[(pr + dr) + ',' + (pc + dc)] = true;
        }
      } else {
        tiles.push(t);
      }
    });
    // 按当前位置排序（上到下，左到右）
    tiles.sort(function(a, b) {
      var ar = +a.dataset.row || 1, br2 = +b.dataset.row || 1;
      if (ar !== br2) return ar - br2;
      return (+a.dataset.col || 1) - (+b.dataset.col || 1);
    });
    // 重新逐个放置
    tiles.forEach(function(t) {
      var w = +t.dataset.w || 1, h = +t.dataset.h || 1;
      // 找第一个空位
      for (var row = 1; row < 100; row++) {
        for (var col = 1; col <= COLS - w + 1; col++) {
          var fits = true;
          for (var dr = 0; dr < h && fits; dr++) for (var dc = 0; dc < w && fits; dc++) {
            if (occupied[(row + dr) + ',' + (col + dc)]) fits = false;
          }
          if (fits) {
            t.dataset.col = col; t.dataset.row = row;
            applyPos(t);
            for (var dr2 = 0; dr2 < h; dr2++) for (var dc2 = 0; dc2 < w; dc2++) {
              occupied[(row + dr2) + ',' + (col + dc2)] = true;
            }
            return;
          }
        }
      }
    });
    // 更新grid行数 (包含 pinTop 磁贴的高度)
    var maxR = 0;
    allTilesInMain.forEach(function(t) { var r = +t.dataset.row || 1, h2 = +t.dataset.h || 1; if (r + h2 - 1 > maxR) maxR = r + h2 - 1; });
    grid.style.gridTemplateRows = 'repeat(' + Math.max(maxR + 1, 3) + ', var(--cell))';
    TileEngine.saveLayout();
    TileAPI.toast('已自动排序', 'success');
  },

  expand: expand,
  collapse: collapse,
  inlineExpand: inlineExpand,
  inlineCollapse: inlineCollapse,
  enterEdit: enterEdit,
  exitEdit: exitEdit,

  // 让主题引擎在改变 --tile-color-opacity 后重新上色
  restoreTileColors: _restoreTileColors,

  // 暴露给 group-manager 使用
  COLS: COLS,
  autoPlace: autoPlace,
  applyPos: applyPos,
  pushDown: pushDown,
  beginDrag: _beginDrag,
};

window.TileEngine = TileEngine;
})();
