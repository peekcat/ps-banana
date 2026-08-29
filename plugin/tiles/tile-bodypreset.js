// ============================================================
//  tile-bodypreset.js — 人体剪影分类选择器 v6.0
//  Canvas 颜色分区点击检测 + 缩放动画 + 二级子分类
//  参考老版本 preset-body.js (5.4.6),适配 TileAPI v6
//
//  交互:
//  - 点击 PNG 剪影上的部位 → 缩放聚焦 → 发 bodypreset:select {category, sub:null}
//  - 若该部位有子分类,底部弹出子按钮 → 点击发 bodypreset:select {category, sub}
//  - 点击 × 或空白处 → 退回根层,发 bodypreset:select {category:null, sub:null}
// ============================================================
(function() {
'use strict';

var IMG_BASE = 'icons/body/';

// === 分类定义(只保留一级,不再有 subs) ===
var CATS = [
  { id:'head',   name:'头部面部' },
  { id:'hair',   name:'头发' },
  { id:'neck',   name:'颈部' },
  { id:'torso',  name:'躯干腰腹' },
  { id:'arms',   name:'手臂' },
  { id:'hands',  name:'手部' },
  { id:'legs',   name:'腿部' },
  { id:'feet',   name:'脚部' },
  { id:'clothing',   name:'服装' },
  { id:'accessory',  name:'配饰' },
  { id:'fullbody',   name:'全身' },
  { id:'lighting',   name:'光影' },
  { id:'background', name:'背景' },
  { id:'weapon',     name:'武器' },
  { id:'cleanup',    name:'去杂物' },
  { id:'effects',    name:'特效' },
  { id:'other',      name:'其他' }
];

// 暴露分类列表供 tile-presets 的保存对话框使用(下拉选项)
window._bodyCategories = CATS;

function catById(id) {
  for (var i = 0; i < CATS.length; i++) if (CATS[i].id === id) return CATS[i];
  return null;
}

// === 颜色 → 部位映射(与 body_full_map.png 颜色对应) ===
var COLOR_MAP = {
  '255,0,0':     'head',
  '0,255,0':     'hair',
  '0,0,255':     'neck',
  '255,255,0':   'torso',
  '0,255,255':   'arms',
  '255,0,255':   'hands',
  '255,128,0':   'legs',
  '128,0,255':   'feet',
  '255,0,128':   'clothing',
  '128,64,0':    'accessory',
  '128,128,128': 'fullbody',
  '192,192,192': 'lighting',
  '0,128,0':     'background',
  '0,0,128':     'weapon',
  '128,128,0':   'cleanup',
  '255,128,255': 'effects',
  '64,64,64':    'other'
};

// === 缩放中心点(归一化 0~1) ===
var ZOOM_CENTERS = {
  head:       {x:0.50, y:0.16, scale:2.5},
  hair:       {x:0.43, y:0.17, scale:2.5},
  neck:       {x:0.50, y:0.22, scale:3.0},
  torso:      {x:0.50, y:0.31, scale:2.0},
  arms:       {x:0.50, y:0.35, scale:1.8},
  hands:      {x:0.40, y:0.52, scale:2.2},
  legs:       {x:0.50, y:0.76, scale:1.8},
  feet:       {x:0.50, y:0.93, scale:2.5},
  clothing:   {x:0.50, y:0.54, scale:2.0},
  accessory:  {x:0.25, y:0.47, scale:2.5},
  fullbody:   {x:0.08, y:0.08, scale:3.5},
  lighting:   {x:0.91, y:0.08, scale:3.5},
  background: {x:0.58, y:0.66, scale:1.5},
  weapon:     {x:0.84, y:0.67, scale:2.5},
  cleanup:    {x:0.08, y:0.95, scale:3.5},
  effects:    {x:0.93, y:0.95, scale:3.5},
  other:      {x:0.08, y:0.51, scale:3.5}
};

// === 标签位置(归一化 0~1) ===
var LABEL_POS = {
  head:       {x:0.65, y:0.16},
  hair:       {x:0.58, y:0.17},
  neck:       {x:0.65, y:0.22},
  torso:      {x:0.65, y:0.31},
  arms:       {x:0.65, y:0.35},
  hands:      {x:0.55, y:0.52},
  legs:       {x:0.65, y:0.76},
  feet:       {x:0.65, y:0.93},
  clothing:   {x:0.65, y:0.54},
  accessory:  {x:0.35, y:0.47},
  fullbody:   {x:0.23, y:0.08},
  lighting:   {x:0.95, y:0.08},
  background: {x:0.73, y:0.66},
  weapon:     {x:0.95, y:0.67},
  cleanup:    {x:0.23, y:0.95},
  effects:    {x:0.95, y:0.95},
  other:      {x:0.23, y:0.51}
};

// === 每个实例的状态 ===
function _newState() {
  return {
    level: 0,                      // 0=根, 1=部位聚焦
    cat: null,                     // 当前聚焦的部位 id
    hoveredPart: null,
    bodyImg: null,
    mapImg: null,
    mapCanvas: null,               // 离屏 canvas,用于读颜色
    mapCtx: null,
    mapImageData: null,
    bodyCanvas: null,
    bodyCtx: null,
    hlCanvas: null,
    hlCtx: null,
    currentTransform: { x:0, y:0, scale:1 },
    targetTransform:  { x:0, y:0, scale:1 },
    animating: false,
    mouseMoveHandler: null,
    clickHandler: null,
    mouseLeaveHandler: null
  };
}

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderFront(container, w, h) {
  var icon = '🧍';
  if (w >= 2) {
    container.innerHTML =
      '<div class="tile-icon">' + icon + '</div>' +
      '<div class="tile-label">人体剪影</div>' +
      '<div class="tile-desc">按部位筛选预设</div>';
  } else {
    container.innerHTML =
      '<div class="tile-icon">' + icon + '</div>' +
      '<div class="tile-label">剪影</div>';
  }
}

TileAPI.registerTile({
  id: 'bodypreset',
  group: 'main',
  icon: '🧍',
  label: '人体剪影',
  desc: '按部位选预设',
  live: false,
  defaultSize: { w: 2, h: 3 },
  minSize: { w: 1, h: 2 },
  maxSize: { w: 4, h: 8 },

  renderFront: renderFront,

  renderBack: function(container) {
    container.textContent = '点击部位筛选预设';
  },

  onExpand: function(container, sizeHint) {
    var layout = (sizeHint && sizeHint.layout) || 'wide';
    var s = _newState();
    _renderSilhouette(container, s, layout);

    return function() {
      // 标记已关闭,prebuild 的 next() 开头检查后会自然退出;_animateTransform 的 token 也会作废
      s._killed = true;
      s._animToken = (s._animToken || 0) + 1;
      // 清理监听
      if (s.mouseMoveHandler && s.viewport) s.viewport.removeEventListener('mousemove', s.mouseMoveHandler);
      if (s.clickHandler && s.viewport) s.viewport.removeEventListener('click', s.clickHandler);
      if (s.mouseLeaveHandler && s.viewport) s.viewport.removeEventListener('mouseleave', s.mouseLeaveHandler);
      // 断开 ResizeObserver
      if (s._resizeObserver) { try { s._resizeObserver.disconnect(); } catch(e) {} }
      // 取消引擎/窗口事件监听
      if (s._onTileCollapsed && TileAPI && typeof TileAPI.off === 'function') {
        try { TileAPI.off('tile:collapsed', s._onTileCollapsed); } catch(e) {}
      }
      if (s._onWindowResize) {
        try { window.removeEventListener('resize', s._onWindowResize); } catch(e) {}
      }
      if (s._onEngineResize && TileAPI && typeof TileAPI.off === 'function') {
        try { TileAPI.off('engine:resize', s._onEngineResize); } catch(e) {}
      }
      if (s._sizePollTimer) {
        try { clearInterval(s._sizePollTimer); } catch(e) {}
        s._sizePollTimer = null;
      }
      // 清掉 bodypreset:select 过滤状态
      TileAPI.state.set('bodypreset.currentCategory', null);
      TileAPI.state.set('bodypreset.currentSub', null);
      TileAPI.emit('bodypreset:select', { category: null, sub: null });
    };
  },

  onResize: renderFront
});

// ============================================================
// 面板渲染
// ============================================================

function _renderSilhouette(container, s, layout) {
  // 所有展开布局(narrow / tall / square / wideshort / wide)都显示底部操作栏
  // CSS 针对 narrow 窄宽度自动收紧字号 / 改三按钮等比挤压
  var showActions = true;
  var actionsHtml = showActions ?
    '<div class="bp-actions-bar">' +
      '<button class="w10-btn w10-btn-accent bp-action-btn" id="bpActSave" title="把当前提示词保存为预设">+ 保存当前</button>' +
      '<button class="w10-btn bp-action-btn" id="bpActImport" title="从 JSON 文件导入预设">↓ 导入</button>' +
      '<button class="w10-btn bp-action-btn" id="bpActExport" title="导出全部预设到 JSON">↑ 导出</button>' +
    '</div>' : '';

  container.innerHTML =
    '<div class="w10-panel panel-sz-' + layout + '" style="padding:0;">' +
      '<div class="body-preset-silhouette">' +
        '<div class="bp-top-bar">' +
          '<button class="w10-btn bp-back-btn" id="bpBackBtn" style="display:none;" title="返回">×</button>' +
          '<div class="bp-crumb-line" id="bpCrumbLine"></div>' +
        '</div>' +
        '<div class="bp-png-viewport" id="bpViewport">' +
          '<canvas class="bp-body-canvas" id="bpBodyCanvas"></canvas>' +
          '<canvas class="bp-highlight-canvas" id="bpHighlightCanvas"></canvas>' +
          '<div class="bp-label-layer" id="bpLabelLayer"></div>' +
        '</div>' +
        actionsHtml +
      '</div>' +
    '</div>';

  // 底部预设操作按钮事件 — 只在大磁贴时绑定
  if (showActions) {
    var saveBtn = container.querySelector('#bpActSave');
    if (saveBtn) saveBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      // 触发 tile-presets 监听的事件,复用其 _showSaveDialog
      TileAPI.emit('presets:requestSaveDialog');
    });
    var importBtn = container.querySelector('#bpActImport');
    if (importBtn) importBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      TileAPI.sendToHost('importPreset');
    });
    var exportBtn = container.querySelector('#bpActExport');
    if (exportBtn) exportBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      // 只导出"当前选中的预设"
      var selectedId = TileAPI.state.get('prompt.lastPresetId') || '';
      var selectedTitle = TileAPI.state.get('prompt.lastPresetTitle') || '';
      if (!selectedId && !selectedTitle) {
        TileAPI.toast('请先点选一个预设再导出', 'error');
        return;
      }
      var all = TileAPI.state.get('presets.list') || [];
      // 优先按 id 反查,id 没匹配再退到 title
      var match = null;
      if (selectedId) {
        for (var i = 0; i < all.length; i++) {
          if (all[i].id === selectedId) { match = all[i]; break; }
        }
      }
      if (!match && selectedTitle) {
        for (var j = 0; j < all.length; j++) {
          if (all[j].title === selectedTitle) { match = all[j]; break; }
        }
      }
      if (!match) {
        TileAPI.toast('找不到当前选中的预设(可能已被删除)', 'error');
        return;
      }
      // 不导出 forge 预设(它在 forge 磁贴自己的体系里)
      if (match._isForge) {
        TileAPI.toast('Forge 预设请在 Forge 磁贴里导出', 'error');
        return;
      }
      // 用文件名 = 预设标题,方便用户识别
      var safeName = String(match.title || 'preset').replace(/[\\\/:*?"<>|\r\n\t]/g, '_').slice(0, 60);
      TileAPI.sendToHost('exportPreset', { preset: [match], fileName: safeName + '.json' });
      TileAPI.toast('正在导出: ' + (match.title || ''), 'info');
    });
  }

  s.viewport = container.querySelector('#bpViewport');
  s.bodyCanvas = container.querySelector('#bpBodyCanvas');
  s.hlCanvas = container.querySelector('#bpHighlightCanvas');
  s.labelLayer = container.querySelector('#bpLabelLayer');
  s.crumbLine = container.querySelector('#bpCrumbLine');
  s.backBtn = container.querySelector('#bpBackBtn');

  s.bodyCtx = s.bodyCanvas.getContext('2d');
  s.hlCtx = s.hlCanvas.getContext('2d');

  // 加载两张图片
  s.bodyImg = new Image();
  s.mapImg = new Image();
  var loaded = 0;
  function onLoad() {
    if (s._killed) return;  // 图片加载回来时磁贴已关闭,什么都别做
    loaded++;
    if (loaded >= 2) {
      _initMapCanvas(s);
      // 关键:等 layout 稳定再 resize/draw
      // 场景:浏览器缓存命中 → onLoad 几乎同步触发 → 但 onExpand 动画还没让 viewport
      //       拿到最终尺寸 → 此刻 getBoundingClientRect 读到的是过渡值
      // 用双层 rAF 让浏览器先跑完 layout,再做 canvas 尺寸计算
      // 同时再延后 350ms 兜一次,匹配 onExpand 动画时长
      var doResize = function() {
        if (s._killed) return;
        _resizeCanvases(s);
        _drawBody(s);
        _updateCrumb(s);
      };
      requestAnimationFrame(function() {
        requestAnimationFrame(doResize);
      });
      // 兜底:expand 动画 ~300-480ms,这之后再补一次 resize 保证最终态正确
      setTimeout(function() { if (!s._killed) { _resizeCanvases(s); _drawBody(s); } }, 500);
      // 预构建所有分类的 mask 缓存(空闲时),避免首次点击时卡一帧
      _prebuildCatMasks(s);
    }
  }
  s.bodyImg.onload = onLoad;
  s.mapImg.onload = onLoad;
  s.bodyImg.onerror = function() { TileAPI.log('[剪影] body_full.png 加载失败', 'error'); };
  s.mapImg.onerror = function() { TileAPI.log('[剪影] body_full_map.png 加载失败', 'error'); };
  s.bodyImg.src = IMG_BASE + 'body_full.png';
  s.mapImg.src = IMG_BASE + 'body_full_map.png';

  // 事件绑定
  s.mouseMoveHandler = function(e) { _onMouseMove(s, e); };
  s.clickHandler = function(e) { _onClick(s, e); };
  s.mouseLeaveHandler = function() { _clearHighlight(s); s.hoveredPart = null; _renderLabels(s); };
  s.viewport.addEventListener('mousemove', s.mouseMoveHandler);
  s.viewport.addEventListener('click', s.clickHandler);
  s.viewport.addEventListener('mouseleave', s.mouseLeaveHandler);

  // 返回按钮
  if (s.backBtn) s.backBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    _goBack(s);
  });

  // 视口尺寸变化时重新布局
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function() {
      if (s._killed) return;
      if (s.bodyImg && s.bodyImg.complete) {
        _resizeCanvases(s);
        _drawBody(s);
        // v6.5.5c: 视口尺寸变了(顶栏出现/磁贴改大小), 已聚焦的部位重新对中
        if (s.level === 1 && s.cat) _zoomToCategory(s, s.cat);
      }
    });
    ro.observe(s.viewport);
    s._resizeObserver = ro;
  }

  // 兜底: 其他磁贴全屏展开 → 关闭 后, ResizeObserver 有时不触发 (viewport 在隐藏期间无变化),
  // 主动监听引擎的 tile:collapsed 事件 + window resize, 强制重绘一次.
  // 关键改动: 不只重绘一帧, 而是启动 ~500ms 的 rAF 循环, 整段 collapse 动画期间每帧都重绘 —
  //         否则用户视觉上会感觉"动画播完才看到剪影刷新", 因为 canvas 在被遮罩盖住时
  //         可能丢了纹理, 单次 rAF 重绘虽然立刻执行, 但动画结束才显得"刚刚更新".
  s._onTileCollapsed = function() {
    if (s._killed) return;
    if (!s.bodyImg || !s.bodyImg.complete) return;
    if (s._collapseRedrawUntil) {
      // 已有循环在跑, 把结束时间延后即可, 不重复启动
      s._collapseRedrawUntil = performance.now() + 500;
      return;
    }
    s._collapseRedrawUntil = performance.now() + 500;
    var loop = function() {
      if (s._killed) { s._collapseRedrawUntil = 0; return; }
      _resizeCanvases(s);
      _drawBody(s);
      if (performance.now() < s._collapseRedrawUntil) {
        requestAnimationFrame(loop);
      } else {
        s._collapseRedrawUntil = 0;
      }
    };
    requestAnimationFrame(loop);
  };
  s._onWindowResize = s._onTileCollapsed;
  if (TileAPI && typeof TileAPI.on === 'function') TileAPI.on('tile:collapsed', s._onTileCollapsed);
  window.addEventListener('resize', s._onWindowResize);

  // 关键兜底: UXP 里单个元素的 ResizeObserver / window.resize 都不稳定。
  // 引擎对 _vp 挂了一个稳定 RO + 自己的 window.resize 处理, 统一广播 engine:resize。
  // 这里订阅它, 缩放 UXP 外框时强制重排 canvas。
  s._onEngineResize = function() {
    if (s._killed) return;
    if (!s.bodyImg || !s.bodyImg.complete) return;
    requestAnimationFrame(function() {
      if (s._killed) return;
      _resizeCanvases(s);
      _drawBody(s);
    });
  };
  if (TileAPI && typeof TileAPI.on === 'function') TileAPI.on('engine:resize', s._onEngineResize);

  // 终极兜底: UXP 里 ResizeObserver + window.resize + engine:resize 都可能漏报。
  // 250ms 轮询 viewport 真实尺寸,变化超过 1px 就重绘。代价极低,胜在 100% 不丢帧。
  s._sizePollLast = { w: 0, h: 0 };
  s._sizePollTimer = setInterval(function() {
    if (s._killed) { clearInterval(s._sizePollTimer); s._sizePollTimer = null; return; }
    if (!s.viewport || !s.viewport.isConnected) return;
    if (!s.bodyImg || !s.bodyImg.complete) return;
    var r = s.viewport.getBoundingClientRect();
    if (Math.abs(r.width - s._sizePollLast.w) > 1 || Math.abs(r.height - s._sizePollLast.h) > 1) {
      s._sizePollLast.w = r.width;
      s._sizePollLast.h = r.height;
      _resizeCanvases(s);
      _drawBody(s);
    }
  }, 250);
}

function _initMapCanvas(s) {
  s.mapCanvas = document.createElement('canvas');
  s.mapCanvas.width = s.mapImg.naturalWidth;
  s.mapCanvas.height = s.mapImg.naturalHeight;
  s.mapCtx = s.mapCanvas.getContext('2d', { willReadFrequently: true });
  s.mapCtx.drawImage(s.mapImg, 0, 0);
  s.mapImageData = s.mapCtx.getImageData(0, 0, s.mapCanvas.width, s.mapCanvas.height);
}

function _resizeCanvases(s) {
  if (!s.viewport) return;
  var rect = s.viewport.getBoundingClientRect();
  var dpr = window.devicePixelRatio || 1;
  [s.bodyCanvas, s.hlCanvas].forEach(function(c) {
    c.width = rect.width * dpr;
    c.height = rect.height * dpr;
    c.style.width = rect.width + 'px';
    c.style.height = rect.height + 'px';
    c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  });
}

function _drawBody(s) {
  if (!s.bodyImg || !s.bodyCtx) return;
  var rect = s.viewport.getBoundingClientRect();
  var cw = rect.width, ch = rect.height;
  // object-fit: contain
  var imgW = s.bodyImg.naturalWidth, imgH = s.bodyImg.naturalHeight;
  var scale = Math.min(cw / imgW, ch / imgH);
  var drawW = imgW * scale * s.currentTransform.scale;
  var drawH = imgH * scale * s.currentTransform.scale;
  var drawX = (cw - drawW) / 2 + s.currentTransform.x;
  var drawY = (ch - drawH) / 2 + s.currentTransform.y;

  s.bodyCtx.clearRect(0, 0, cw, ch);

  if (s.level > 0 && s.cat) {
    // 进入分类:整张图变暗,只有当前分类保持亮
    s.bodyCtx.save();
    s.bodyCtx.globalAlpha = 0.18;
    s.bodyCtx.drawImage(s.bodyImg, drawX, drawY, drawW, drawH);
    s.bodyCtx.globalAlpha = 1.0;
    _drawActiveCategory(s, drawX, drawY, drawW, drawH);
    s.bodyCtx.restore();
  } else {
    s.bodyCtx.drawImage(s.bodyImg, drawX, drawY, drawW, drawH);
  }

  // 保存用于击中检测
  s._imgPlacement = { x: drawX, y: drawY, w: drawW, h: drawH };
}

// 用 map 图颜色蒙板,只在当前 cat 区域叠画一次原图(全不透明)
// 优化:把 mask 结果缓存在 s._catMaskCache[catId] 上,动画每帧直接 drawImage,不再逐像素
function _drawActiveCategory(s, ox, oy, sw, sh) {
  if (!s.mapImageData || !s.cat) return;
  var cached = s._catMaskCache && s._catMaskCache[s.cat];
  if (!cached) cached = _buildCatMaskCache(s, s.cat);
  if (!cached) return;
  s.bodyCtx.drawImage(cached, ox, oy, sw, sh);
}

function _buildCatMaskCache(s, catId) {
  if (!s.mapImageData || !catId) return null;
  var colorKey = null;
  for (var k in COLOR_MAP) if (COLOR_MAP[k] === catId) { colorKey = k; break; }
  if (!colorKey) return null;
  var parts = colorKey.split(',');
  var tr = +parts[0], tg = +parts[1], tb = +parts[2];

  var mw = s.mapCanvas.width, mh = s.mapCanvas.height;
  var tmp = document.createElement('canvas');
  tmp.width = mw; tmp.height = mh;
  var tctx = tmp.getContext('2d');
  tctx.drawImage(s.bodyImg, 0, 0, mw, mh);
  var tData = tctx.getImageData(0, 0, mw, mh);
  var td = tData.data;
  var src = s.mapImageData.data;
  for (var i = 0; i < src.length; i += 4) {
    var r = src[i], g = src[i+1], b = src[i+2], a = src[i+3];
    if (a < 128 || Math.abs(r - tr) > 30 || Math.abs(g - tg) > 30 || Math.abs(b - tb) > 30) {
      td[i+3] = 0;
    }
  }
  tctx.putImageData(tData, 0, 0);
  if (!s._catMaskCache) s._catMaskCache = {};
  s._catMaskCache[catId] = tmp;
  return tmp;
}

// 后台分帧预构建所有分类的 mask,不阻塞主线程
function _prebuildCatMasks(s) {
  var i = 0;
  function next() {
    if (s._killed) return;  // 磁贴已收起,放弃剩余工作
    if (i >= CATS.length) return;
    var id = CATS[i++].id;
    if (!s._catMaskCache || !s._catMaskCache[id]) _buildCatMaskCache(s, id);
    if (!s._hoverMaskCache || !s._hoverMaskCache[id]) _buildHoverMaskCache(s, id);
    if (window.requestIdleCallback) {
      requestIdleCallback(next, { timeout: 500 });
    } else {
      setTimeout(next, 50);
    }
  }
  next();
}

function _viewportToImagePixel(s, vx, vy) {
  var p = s._imgPlacement;
  if (!p) return null;
  if (vx < p.x || vx > p.x + p.w || vy < p.y || vy > p.y + p.h) return null;
  var u = (vx - p.x) / p.w;
  var v = (vy - p.y) / p.h;
  return {
    x: Math.floor(u * s.mapImg.naturalWidth),
    y: Math.floor(v * s.mapImg.naturalHeight)
  };
}

function _pickPart(s, vx, vy) {
  var pt = _viewportToImagePixel(s, vx, vy);
  if (!pt) return null;
  if (!s.mapImageData) return null;
  var idx = (pt.y * s.mapImageData.width + pt.x) * 4;
  var r = s.mapImageData.data[idx];
  var g = s.mapImageData.data[idx + 1];
  var b = s.mapImageData.data[idx + 2];
  var a = s.mapImageData.data[idx + 3];
  if (a < 10) return null;
  var key = r + ',' + g + ',' + b;
  return COLOR_MAP[key] || null;
}

function _onMouseMove(s, e) {
  var rect = s.viewport.getBoundingClientRect();
  var x = e.clientX - rect.left;
  var y = e.clientY - rect.top;

  var part = _pickPart(s, x, y);
  if (part !== s.hoveredPart) {
    s.hoveredPart = part;
    // level 0: 全部可 hover
    // level 1: 只给"非当前分类"加 hover 高亮(提示可切换),当前分类本身已高亮
    if (s.level === 0) {
      _drawHighlight(s, part);
    } else {
      _drawHighlight(s, (part && part !== s.cat) ? part : null);
    }
    _renderLabels(s);
  }
  // 光标提示:在 level 1 下,hover 到其他分类变 pointer,当前分类或空白为 default
  if (s.level === 0) {
    s.viewport.style.cursor = part ? 'pointer' : 'default';
  } else {
    s.viewport.style.cursor = (part && part !== s.cat) ? 'pointer' : 'default';
  }
}

function _onClick(s, e) {
  var rect = s.viewport.getBoundingClientRect();
  var x = e.clientX - rect.left;
  var y = e.clientY - rect.top;

  if (s.level === 0) {
    var part = _pickPart(s, x, y);
    if (part) {
      _selectCategory(s, part);
    }
  } else {
    var part2 = _pickPart(s, x, y);
    if (part2 && part2 !== s.cat) {
      // 同级直接切换到别的分类,不需要先返回
      _selectCategory(s, part2);
    } else if (!part2) {
      // 点到空白处才返回根层
      _goBack(s);
    }
    // 点当前分类本身不做任何事
  }
}

function _selectCategory(s, catId) {
  var cat = catById(catId);
  if (!cat) return;
  s.level = 1;
  s.cat = catId;
  s.hoveredPart = null;
  _clearHighlight(s);
  _renderLabels(s);
  // v6.5.5c: 先更新顶栏(显示出来会压缩视口高度), 再算聚焦 —
  // 原顺序先聚焦后出顶栏, 视口高度变了导致聚焦点不在正中
  _updateCrumb(s);
  _zoomToCategory(s, catId);
  TileAPI.state.set('bodypreset.currentCategory', catId);
  TileAPI.state.set('bodypreset.currentSub', null);
  TileAPI.emit('bodypreset:select', { category: catId, sub: null });
}

function _goBack(s) {
  s.level = 0;
  s.cat = null;
  s.targetTransform = { x:0, y:0, scale:1 };
  _animateTransform(s);
  _updateCrumb(s);
  TileAPI.state.set('bodypreset.currentCategory', null);
  TileAPI.state.set('bodypreset.currentSub', null);
  TileAPI.emit('bodypreset:select', { category: null, sub: null });
}

function _zoomToCategory(s, catId) {
  var z = ZOOM_CENTERS[catId];
  if (!z) return;
  var rect = s.viewport.getBoundingClientRect();
  var cw = rect.width, ch = rect.height;
  var imgW = s.bodyImg.naturalWidth, imgH = s.bodyImg.naturalHeight;
  var baseScale = Math.min(cw / imgW, ch / imgH);
  var drawW = imgW * baseScale;
  var drawH = imgH * baseScale;
  // 希望 (z.x, z.y) 的像素处移动到视口中心
  var targetImgPxX = imgW * z.x;
  var targetImgPxY = imgH * z.y;
  var targetInViewX = targetImgPxX * baseScale + (cw - drawW) / 2;
  var targetInViewY = targetImgPxY * baseScale + (ch - drawH) / 2;
  // 缩放后需要的偏移,使得原本 targetInView 移到 cw/2, ch/2
  s.targetTransform = {
    x: (cw/2 - targetInViewX) * z.scale,
    y: (ch/2 - targetInViewY) * z.scale,
    scale: z.scale
  };
  _animateTransform(s);
}

function _animateTransform(s) {
  // 新的缩放目标来了 → 取消上一个动画,从当前(中间)位置平滑过渡到新目标
  s.animating = true;
  s._animToken = (s._animToken || 0) + 1;
  var myToken = s._animToken;
  var start = performance.now();
  var from = { x: s.currentTransform.x, y: s.currentTransform.y, scale: s.currentTransform.scale };
  var to = s.targetTransform;
  // 同级切换时用短一点的时长(跟 5.4.6 的体感一致:450ms 回根层 / 550ms 去分类)
  var isFullReset = (to.scale === 1 && to.x === 0 && to.y === 0);
  var dur = isFullReset ? 450 : 550;
  // easeOutExpo(和 5.4.6 一致,收尾更柔)
  function ease(t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); }
  function step(now) {
    if (s._killed) return;  // 磁贴已收起
    if (myToken !== s._animToken) return;  // 被新动画抢占了
    var t = Math.min(1, (now - start) / dur);
    var k = ease(t);
    s.currentTransform.x = from.x + (to.x - from.x) * k;
    s.currentTransform.y = from.y + (to.y - from.y) * k;
    s.currentTransform.scale = from.scale + (to.scale - from.scale) * k;
    _drawBody(s);
    // 每帧同步重绘 hover 高亮,让蓝色发光跟着身体一起移动/缩放
    _paintHover(s);
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      s.animating = false;
    }
  }
  requestAnimationFrame(step);
}

// Hover 发光蒙板: 颜色跟随主题色(--accent); 同 _catMaskCache 缓存, 避免每帧重算
// 主题色变了缓存要作废 → 缓存键带上当前色值
function _accentRGB() {
  try {
    var hex = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    var m = hex.match(/^#([0-9a-f]{6})$/i);
    if (m) {
      var n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
  } catch(_) {}
  return [100, 180, 255];   // 兜底: 原来的蓝
}
function _buildHoverMaskCache(s, catId) {
  if (!s.mapImageData || !catId) return null;
  var colorKey = null;
  for (var k in COLOR_MAP) if (COLOR_MAP[k] === catId) { colorKey = k; break; }
  if (!colorKey) return null;
  var parts = colorKey.split(',');
  var tr = +parts[0], tg = +parts[1], tb = +parts[2];
  var ac = _accentRGB();
  var cacheKey = catId + '|' + ac.join(',');

  if (s._hoverMaskCache && s._hoverMaskCache[cacheKey]) return s._hoverMaskCache[cacheKey];

  var mw = s.mapCanvas.width, mh = s.mapCanvas.height;
  var tmp = document.createElement('canvas');
  tmp.width = mw; tmp.height = mh;
  var tctx = tmp.getContext('2d');
  var imgData = tctx.createImageData(mw, mh);
  var src = s.mapImageData.data;
  var dst = imgData.data;
  // 和 _buildCatMaskCache 一样,用容差 30 匹配(保证 hover 高亮覆盖范围 = 击中/实色范围)
  for (var i = 0; i < src.length; i += 4) {
    var r = src[i], g = src[i+1], b = src[i+2], a = src[i+3];
    if (a >= 128 && Math.abs(r - tr) <= 30 && Math.abs(g - tg) <= 30 && Math.abs(b - tb) <= 30) {
      dst[i] = ac[0];
      dst[i+1] = ac[1];
      dst[i+2] = ac[2];
      dst[i+3] = 120;
    }
  }
  tctx.putImageData(imgData, 0, 0);
  if (!s._hoverMaskCache) s._hoverMaskCache = {};
  s._hoverMaskCache[cacheKey] = tmp;
  return tmp;
}

// 每帧跟随 body canvas 的当前 transform 绘制 hover 高亮
function _paintHover(s) {
  if (!s.hlCtx) return;
  var rect = s.viewport.getBoundingClientRect();
  s.hlCtx.clearRect(0, 0, rect.width, rect.height);
  var catId = s.hoveredCat;
  if (!catId) return;
  var p = s._imgPlacement;
  if (!p) return;
  var cached = _buildHoverMaskCache(s, catId);   // 内部带缓存(键含主题色, 换色自动重建)
  if (!cached) return;
  s.hlCtx.drawImage(cached, p.x, p.y, p.w, p.h);
}

// 接口保持兼容:调用者设置 hoveredCat,重绘一次
// 动画期间 _animateTransform 的 step 会自动调 _paintHover(s),不需要再手动调
function _drawHighlight(s, catId) {
  s.hoveredCat = catId || null;
  _paintHover(s);
}

function _clearHighlight(s) {
  s.hoveredCat = null;
  if (!s.hlCtx) return;
  var rect = s.viewport.getBoundingClientRect();
  s.hlCtx.clearRect(0, 0, rect.width, rect.height);
}

function _renderLabels(s) {
  if (!s.labelLayer) return;
  s.labelLayer.innerHTML = '';
  if (!s.hoveredPart) return;
  // level 1 时不给"当前分类自己"显示 hover 标签
  if (s.level > 0 && s.hoveredPart === s.cat) return;
  var cat = catById(s.hoveredPart);
  if (!cat) return;
  var pos = LABEL_POS[s.hoveredPart];
  if (!pos) return;
  var rect = s.viewport.getBoundingClientRect();
  var lbl = document.createElement('div');
  lbl.className = 'bp-hover-label';
  lbl.textContent = cat.name;
  lbl.style.left = (pos.x * rect.width) + 'px';
  lbl.style.top = (pos.y * rect.height) + 'px';
  s.labelLayer.appendChild(lbl);
}

function _updateCrumb(s) {
  if (!s.crumbLine) return;
  var topBar = s.crumbLine.parentNode;   // .bp-top-bar
  var html = '';
  if (s.level === 0) {
    // v6.5.5b: 顶层整条顶栏隐藏(min-height 也不占), 剪影到边框距离与左右一致
    if (topBar && topBar.classList && topBar.classList.contains('bp-top-bar')) topBar.style.display = 'none';
    if (s.backBtn) s.backBtn.style.display = 'none';
  } else {
    if (topBar && topBar.classList && topBar.classList.contains('bp-top-bar')) topBar.style.display = '';
    var cat = catById(s.cat);
    if (!cat) return;
    html = '<span class="bp-crumb" data-bp-crumb="root">全部</span>' +
           '<span class="bp-crumb-sep">›</span>' +
           '<span class="bp-crumb current">' + _esc(cat.name) + '</span>';
    if (s.backBtn) s.backBtn.style.display = '';
  }
  s.crumbLine.innerHTML = html;
  var rootEl = s.crumbLine.querySelector('[data-bp-crumb="root"]');
  if (rootEl) rootEl.addEventListener('click', function(e) {
    e.stopPropagation();
    _goBack(s);
  });
}

})();
