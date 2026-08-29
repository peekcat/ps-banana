// ============================================================
//  tile-scene.js — 场景包磁贴
//
//  流程:
//    1. 选模式 (文字/图片, 当前只有文字模式)
//    2. 选场景包 (网格)
//    3. 配置: 灯光 / 焦段滑块 / 俯仰角 / 区域 / 三层物品篮子
//    4. 可选传入 PS 选区作为人物参考图 (image-to-image)
//    5. 调 callAiApi → 贴回 PS
//
//  数据源: factory_scenes/<id>.json 随插件发布
// ============================================================
(function() {
'use strict';

var _activeContainer = null;
var _scenePacks = [];          // 已加载的场景包数组
var _packsLoaded = false;
var _state = {
  mode: 'text',                // text / image
  packId: null,                // 选中的场景包 id
  pack: null,                  // 选中场景包的完整数据
  lighting: null,              // 灯光选 id
  focalLength: 35,
  tilt: 'level',
  areaText: '',
  items: { front: {}, middle: {}, back: {} },  // 每层 {itemId: count}
  useRef: false,               // 是否使用 PS 选区作为人物参考
  refBase64: null,             // 抓到的参考图 base64
  refSelection: null,
  // 生成参数 — 默认从主插件 storage 读 (用户在主参数磁贴里设过的)
  provider: null,              // aji / grs / others
  model: null,                 // 模型 id
  size: null,                  // 1K / 2K / 4K / Auto
  aspectRatio: null,           // 1:1 / 4:3 / 16:9 等
  batchCount: 1                // 一次生成几张 (Roll 几次), 1-8
};

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
//  场景包加载 (host 端 sendToHost('sceneListPacks') 返回所有 JSON)
// ============================================================
// bug #10 同款: 原来每次未加载时展开都 onHostMessage 注册一个新 listener(不注销) → 反复叠加。
//   改为进程内只注册一次(_packsListenerBound), 用 _pendingPackCbs 收集等待回调, 回来时一次性触发。
var _packsListenerBound = false;
var _pendingPackCbs = [];
function _ensurePacksLoaded(callback) {
  if (_packsLoaded) { if (callback) callback(); return; }
  if (callback) _pendingPackCbs.push(callback);
  if (!_packsListenerBound) {
    _packsListenerBound = true;
    TileAPI.onHostMessage('sceneListPacksResult', function(data) {
      _packsLoaded = true;
      _scenePacks = (data && Array.isArray(data.packs)) ? data.packs : [];
      var cbs = _pendingPackCbs.slice();
      _pendingPackCbs = [];
      cbs.forEach(function(cb) { try { cb(); } catch (e) {} });
    });
  }
  TileAPI.sendToHost('sceneListPacks', {});
}

// ============================================================
//  正面磁贴
// ============================================================
function renderFront(container, w, h) {
  if (w >= 2) {
    container.innerHTML =
      '<div class="tile-icon">🎬</div>' +
      '<div class="tile-label">场景包</div>' +
      '<div class="tile-desc">合成场景图</div>';
  } else {
    container.innerHTML =
      '<div class="tile-icon">🎬</div>' +
      '<div class="tile-label">场景</div>';
  }
}

// ============================================================
//  展开
// ============================================================
function onExpand(container, sizeHint) {
  _activeContainer = container;
  _ensurePacksLoaded(function() {
    _renderCurrent(container);
  });
  return function cleanup() {
    _activeContainer = null;
  };
}

function _renderCurrent(container) {
  // 三屏: 模式 / 场景包网格 / 配置面板
  if (!_state.packId) {
    if (_state.mode === null) _renderModePicker(container);
    else _renderPackGrid(container);
  } else {
    _renderConfig(container);
  }
}

// ============================================================
//  屏 1: 模式选择 (因为只有文字模式, 暂时直接进场景包网格)
//  保留这个函数, 未来加图片模式时启用
// ============================================================
function _renderModePicker(container) {
  container.innerHTML =
    '<div class="w10-panel scene-panel">' +
      '<div class="scene-title">🎬 场景包 — 选择模式</div>' +
      '<div class="scene-mode-grid">' +
        '<div class="scene-mode-card" data-mode="text">' +
          '<div class="scene-mode-icon">📝</div>' +
          '<div class="scene-mode-name">文字模式</div>' +
          '<div class="scene-mode-desc">通过选项配置 提交给 AI</div>' +
        '</div>' +
        '<div class="scene-mode-card scene-mode-card-disabled">' +
          '<div class="scene-mode-icon">🖼</div>' +
          '<div class="scene-mode-name">图片模式</div>' +
          '<div class="scene-mode-desc">拼贴素材让 AI 优化 (开发中)</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  container.querySelectorAll('[data-mode]').forEach(function(card) {
    card.onclick = function() {
      _state.mode = card.dataset.mode;
      _renderCurrent(container);
    };
  });
}

// ============================================================
//  屏 2: 场景包网格
// ============================================================
function _renderPackGrid(container) {
  if (_scenePacks.length === 0) {
    container.innerHTML =
      '<div class="w10-panel scene-panel">' +
        '<div class="scene-title">🎬 场景包</div>' +
        '<div class="scene-empty">没有可用的场景包<br><span class="scene-empty-sub">factory_scenes 目录为空, 请联系作者</span></div>' +
      '</div>';
    return;
  }
  var cards = _scenePacks.map(function(p) {
    return '<div class="scene-pack-card" data-pack-id="' + _esc(p.id) + '">' +
             '<div class="scene-pack-icon">' + _esc(p.icon || '🎬') + '</div>' +
             '<div class="scene-pack-name">' + _esc(p.name) + '</div>' +
             '<div class="scene-pack-desc">' + _esc(p.description || '') + '</div>' +
           '</div>';
  }).join('');
  container.innerHTML =
    '<div class="w10-panel scene-panel">' +
      '<div class="scene-title">🎬 选择场景包</div>' +
      '<div class="scene-tip">每个场景包有自己的灯光 / 物品 / 风格预设</div>' +
      '<div class="scene-pack-grid">' + cards + '</div>' +
    '</div>';

  container.querySelectorAll('[data-pack-id]').forEach(function(card) {
    card.onclick = function() {
      var id = card.getAttribute('data-pack-id');
      var pack = _scenePacks.filter(function(p) { return p.id === id; })[0];
      if (!pack) return;
      _selectPack(pack);
      _renderCurrent(container);
    };
  });
}

function _selectPack(pack) {
  _state.packId = pack.id;
  _state.pack = pack;
  // 重置配置 (按场景包默认值)
  _state.lighting = (pack.shooting && pack.shooting.lighting && pack.shooting.lighting[0]) ? pack.shooting.lighting[0].id : null;
  _state.focalLength = (pack.shooting && pack.shooting.focalLength && pack.shooting.focalLength.default) || 35;
  _state.tilt = 'level';
  _state.areaText = '';
  _state.items = { front: {}, middle: {}, back: {} };
  // 生成参数: 从主插件 state/storage 拿用户在「参数」磁贴里已经选好的值, 减少重复配置
  _state.provider = TileAPI.state.get('params.provider') || TileAPI.storage.get('connection.provider') || 'aji';
  _state.model = TileAPI.state.get('params.model') || TileAPI.storage.get('params.model') || 'AJbanana3';
  _state.size = TileAPI.state.get('params.size') || TileAPI.storage.get('params.size') || '2K';
  _state.aspectRatio = TileAPI.state.get('params.aspectRatio') || TileAPI.storage.get('params.aspectRatio') || '1:1';
  _state.batchCount = +TileAPI.state.get('params.batch') || +TileAPI.storage.get('params.batch') || 1;
  if (_state.batchCount < 1 || _state.batchCount > 8) _state.batchCount = 1;
}

// ============================================================
//  屏 3: 配置面板
// ============================================================
function _renderConfig(container) {
  var pack = _state.pack;
  if (!pack) { _state.packId = null; _renderCurrent(container); return; }

  var lightings = (pack.shooting && pack.shooting.lighting) || [];
  var focalCfg = (pack.shooting && pack.shooting.focalLength) || { min: 10, max: 135, default: 35 };
  var tilts = (pack.shooting && pack.shooting.tilt) || [];

  var lightChips = lightings.map(function(L) {
    return '<span class="scene-chip' + (_state.lighting === L.id ? ' scene-chip-active' : '') + '" data-lighting="' + _esc(L.id) + '">' + _esc(L.label) + '</span>';
  }).join('');

  var tiltSeg = tilts.map(function(T) {
    return '<span class="scene-seg' + (_state.tilt === T.id ? ' scene-seg-active' : '') + '" data-tilt="' + _esc(T.id) + '">' + _esc(T.label) + '</span>';
  }).join('');

  container.innerHTML =
    '<div class="w10-panel scene-panel">' +
      '<div class="scene-config-head">' +
        '<button class="scene-back-btn" id="sceneBack">‹</button>' +
        '<span class="scene-title-line">' + _esc(pack.icon || '🎬') + ' ' + _esc(pack.name) + '</span>' +
      '</div>' +

      // === 拍摄要素 ===
      '<div class="scene-section-title">💡 灯光与氛围</div>' +
      '<div class="scene-chip-row" id="sceneLightChips">' + lightChips + '</div>' +

      '<div class="scene-section-title">📷 镜头焦段 <span class="scene-section-val" id="sceneFocalVal">' + _state.focalLength + 'mm</span></div>' +
      '<input type="range" class="scene-slider" id="sceneFocal" min="' + focalCfg.min + '" max="' + focalCfg.max + '" value="' + _state.focalLength + '" step="1">' +
      '<div class="scene-slider-hint"><span>' + focalCfg.min + 'mm 广角</span><span>' + focalCfg.max + 'mm 长焦</span></div>' +

      '<div class="scene-section-title">📐 镜头俯仰</div>' +
      '<div class="scene-seg-row" id="sceneTiltSeg">' + tiltSeg + '</div>' +

      '<div class="scene-section-title">📍 拍摄位置</div>' +
      '<input type="text" class="scene-input" id="sceneArea" placeholder="' + _esc((pack.shooting && pack.shooting.areaPlaceholder) || '可选 例如: 从屋顶') + '" value="' + _esc(_state.areaText) + '">' +

      // === 物品篮子 ===
      _renderBucketsHtml(pack) +

      // === 人物参考 (PS 选区) ===
      '<div class="scene-section-title">🧑‍🦰 人物参考 (可选)</div>' +
      '<div class="scene-ref-row">' +
        '<label class="scene-ref-toggle"><input type="checkbox" id="sceneUseRef"' + (_state.useRef ? ' checked' : '') + '> 使用 PS 选区作为人物参考</label>' +
        '<button class="w10-btn" id="sceneCaptureRef" style="display:' + (_state.useRef ? 'inline-block' : 'none') + '">' +
          (_state.refBase64 ? '✓ 已抓取 重新抓取' : '🎯 从 PS 抓取选区') +
        '</button>' +
      '</div>' +
      '<div class="scene-ref-hint">勾选后会把 PS 当前选区抓回来作为人物参考, AI 会按角度和位置把这个人融入场景</div>' +

      // === 生成参数 ===
      '<div class="scene-section-title">⚙️ 生成参数</div>' +
      _renderGenParamsHtml() +

      // === 生成按钮 ===
      '<div class="scene-actions">' +
        '<button class="w10-btn w10-btn-accent scene-go-btn" id="sceneGo">🚀 生成场景图</button>' +
      '</div>' +
    '</div>';

  _bindConfigEvents(container, pack);
}

// 生成参数 UI: provider / model / size / aspectRatio 4 个下拉
//   provider 列表: aji / grs / others (跟主插件一致)
//   model 列表: 根据 provider 从 state.models.<provider> 拿
//   size 列表: 该 model 支持的尺寸
//   aspectRatio: 复用主插件的常用比例
function _renderGenParamsHtml() {
  var modelsCfg = TileAPI.state.get('models.' + _state.provider) || {};
  var modelKeys = Object.keys(modelsCfg);
  // 模型选项
  var modelOpts = modelKeys.map(function(k) {
    var mc = modelsCfg[k];
    return '<option value="' + _esc(k) + '"' + (k === _state.model ? ' selected' : '') + '>' + _esc((mc && mc.name) || k) + '</option>';
  }).join('');
  if (modelKeys.length === 0) {
    modelOpts = '<option value="' + _esc(_state.model || '') + '">' + _esc(_state.model || '?') + '</option>';
  }
  // 尺寸选项 (跟随当前 model)
  var sizes = (modelsCfg[_state.model] && modelsCfg[_state.model].sizes) || ['1K', '2K', '4K'];
  var sizeOpts = sizes.map(function(s) {
    return '<option value="' + _esc(s) + '"' + (s === _state.size ? ' selected' : '') + '>' + _esc(s) + '</option>';
  }).join('');
  // 比例选项 (常用 9 种)
  var aspects = ['Auto', '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];
  var aspectOpts = aspects.map(function(a) {
    return '<option value="' + _esc(a) + '"' + (a === _state.aspectRatio ? ' selected' : '') + '>' + _esc(a) + '</option>';
  }).join('');
  // provider 选项 (按槽位顺序)
  var providers = TileAPI.slotOrder().map(function(eng) {
    var def = eng === 'aji' ? 'AJI' : eng === 'grs' ? TileAPI.computeBrand() : '其他';
    return { v: eng, label: TileAPI.slotLabel(eng, def) };
  });
  var provOpts = providers.map(function(p) {
    return '<option value="' + p.v + '"' + (p.v === _state.provider ? ' selected' : '') + '>' + p.label + '</option>';
  }).join('');

  return '<div class="scene-gen-params">' +
    '<div class="scene-gen-row">' +
      '<label class="scene-gen-label">服务商</label>' +
      '<select class="scene-gen-select" id="sceneGenProvider">' + provOpts + '</select>' +
    '</div>' +
    '<div class="scene-gen-row">' +
      '<label class="scene-gen-label">模型</label>' +
      '<select class="scene-gen-select" id="sceneGenModel">' + modelOpts + '</select>' +
    '</div>' +
    '<div class="scene-gen-row">' +
      '<label class="scene-gen-label">分辨率</label>' +
      '<select class="scene-gen-select" id="sceneGenSize">' + sizeOpts + '</select>' +
      '<label class="scene-gen-label" style="margin-left:8px">比例</label>' +
      '<select class="scene-gen-select" id="sceneGenAspect">' + aspectOpts + '</select>' +
    '</div>' +
    '<div class="scene-gen-row">' +
      '<label class="scene-gen-label">张数</label>' +
      '<div class="scene-batch-stepper">' +
        '<button class="scene-batch-btn" data-batch-act="minus" type="button">−</button>' +
        '<span class="scene-batch-val" id="sceneGenBatchVal">' + _state.batchCount + '</span>' +
        '<button class="scene-batch-btn" data-batch-act="plus" type="button">+</button>' +
      '</div>' +
      '<span class="scene-batch-hint">一次 Roll ' + _state.batchCount + ' 张, 1-8</span>' +
    '</div>' +
  '</div>';
}

function _renderBucketsHtml(pack) {
  return ['front', 'middle', 'back'].map(function(layer) {
    var labelMap = { front: '🌆 前景', middle: '🌃 中景', back: '🌌 后景' };
    var subcats = (pack.items && pack.items[layer] && pack.items[layer].subcategories) || [];
    if (subcats.length === 0) return '';
    var basket = _renderBasketChips(layer);
    var picker = _renderItemPicker(layer, subcats);
    return '<div class="scene-section-title">' + labelMap[layer] + '</div>' +
           basket +
           picker;
  }).join('');
}

function _renderBasketChips(layer) {
  var bucket = _state.items[layer] || {};
  var ids = Object.keys(bucket).filter(function(k) { return bucket[k] > 0; });
  if (ids.length === 0) {
    return '<div class="scene-basket scene-basket-empty">还没添加, 点下面物品加进去</div>';
  }
  // 找回每个 item 的元数据 (从场景包里)
  var pack = _state.pack;
  var allItems = {};
  (pack.items[layer].subcategories || []).forEach(function(sc) {
    sc.items.forEach(function(it) { allItems[it.id] = it; });
  });
  var html = ids.map(function(id) {
    var meta = allItems[id];
    if (!meta) return '';
    var n = bucket[id];
    return '<span class="scene-basket-item" data-layer="' + layer + '" data-item-id="' + _esc(id) + '">' +
             '<span class="scene-basket-icon">' + _esc(meta.icon || '') + '</span>' +
             '<span class="scene-basket-label">' + _esc(meta.label) + '</span>' +
             '<span class="scene-basket-count">×' + n + '</span>' +
             '<span class="scene-basket-btn scene-basket-minus" data-action="minus">−</span>' +
             '<span class="scene-basket-btn scene-basket-plus"  data-action="plus">+</span>' +
             '<span class="scene-basket-btn scene-basket-remove" data-action="remove">×</span>' +
           '</span>';
  }).join('');
  return '<div class="scene-basket">' + html + '</div>';
}

function _renderItemPicker(layer, subcats) {
  if (!subcats.length) return '';
  var tabs = subcats.map(function(sc, i) {
    return '<span class="scene-subtab' + (i === 0 ? ' scene-subtab-active' : '') + '" data-layer="' + layer + '" data-sub="' + _esc(sc.id) + '">' + _esc(sc.name) + '</span>';
  }).join('');
  // 默认显示第 0 个子分类
  var firstSub = subcats[0];
  var grid = firstSub.items.map(function(it) {
    return '<div class="scene-item-card" data-layer="' + layer + '" data-item-id="' + _esc(it.id) + '">' +
             '<div class="scene-item-icon">' + _esc(it.icon || '') + '</div>' +
             '<div class="scene-item-label">' + _esc(it.label) + '</div>' +
           '</div>';
  }).join('');
  return '<div class="scene-subtabs">' + tabs + '</div>' +
         '<div class="scene-item-grid" data-layer="' + layer + '">' + grid + '</div>';
}

// ============================================================
//  事件绑定
// ============================================================
function _bindConfigEvents(container, pack) {
  // 返回
  container.querySelector('#sceneBack').onclick = function() {
    _state.packId = null;
    _state.pack = null;
    _renderCurrent(container);
  };

  // 灯光 chip
  container.querySelectorAll('[data-lighting]').forEach(function(el) {
    el.onclick = function() {
      _state.lighting = el.dataset.lighting;
      container.querySelectorAll('[data-lighting]').forEach(function(o) { o.classList.remove('scene-chip-active'); });
      el.classList.add('scene-chip-active');
    };
  });

  // 焦段滑块
  var focal = container.querySelector('#sceneFocal');
  var focalVal = container.querySelector('#sceneFocalVal');
  if (focal) focal.oninput = function() {
    _state.focalLength = +this.value;
    if (focalVal) focalVal.textContent = _state.focalLength + 'mm';
  };

  // 俯仰
  container.querySelectorAll('[data-tilt]').forEach(function(el) {
    el.onclick = function() {
      _state.tilt = el.dataset.tilt;
      container.querySelectorAll('[data-tilt]').forEach(function(o) { o.classList.remove('scene-seg-active'); });
      el.classList.add('scene-seg-active');
    };
  });

  // 区域文字
  var areaInp = container.querySelector('#sceneArea');
  if (areaInp) areaInp.oninput = function() { _state.areaText = this.value; };

  // 物品 picker (子分类切换)
  container.querySelectorAll('.scene-subtab').forEach(function(tab) {
    tab.onclick = function() {
      var layer = tab.dataset.layer;
      var subId = tab.dataset.sub;
      // 切换 active
      var siblings = container.querySelectorAll('.scene-subtab[data-layer="' + layer + '"]');
      siblings.forEach(function(o) { o.classList.remove('scene-subtab-active'); });
      tab.classList.add('scene-subtab-active');
      // 重渲对应 grid
      var sc = pack.items[layer].subcategories.filter(function(s) { return s.id === subId; })[0];
      if (!sc) return;
      var grid = container.querySelector('.scene-item-grid[data-layer="' + layer + '"]');
      if (grid) {
        grid.innerHTML = sc.items.map(function(it) {
          return '<div class="scene-item-card" data-layer="' + layer + '" data-item-id="' + _esc(it.id) + '">' +
                   '<div class="scene-item-icon">' + _esc(it.icon || '') + '</div>' +
                   '<div class="scene-item-label">' + _esc(it.label) + '</div>' +
                 '</div>';
        }).join('');
        // 重新绑定点击
        _bindItemCards(container, pack);
      }
    };
  });

  _bindItemCards(container, pack);
  _bindBasket(container, pack);

  // 人物参考开关
  var useRef = container.querySelector('#sceneUseRef');
  var captureBtn = container.querySelector('#sceneCaptureRef');
  if (useRef) useRef.onchange = function() {
    _state.useRef = useRef.checked;
    if (captureBtn) captureBtn.style.display = _state.useRef ? 'inline-block' : 'none';
    if (!_state.useRef) {
      _state.refBase64 = null;
      _state.refSelection = null;
    }
  };
  if (captureBtn) captureBtn.onclick = function() {
    captureBtn.disabled = true;
    captureBtn.textContent = '抓取中...';
    TileAPI.sendToHost('sceneCaptureRef', {});
  };

  // 生成参数: 4 个下拉
  var provSel = container.querySelector('#sceneGenProvider');
  var modelSel = container.querySelector('#sceneGenModel');
  var sizeSel = container.querySelector('#sceneGenSize');
  var aspectSel = container.querySelector('#sceneGenAspect');
  if (provSel) provSel.onchange = function() {
    _state.provider = provSel.value;
    // provider 切换 → 重置 model 到该 provider 的第一个
    var modelsCfg = TileAPI.state.get('models.' + _state.provider) || {};
    var keys = Object.keys(modelsCfg);
    _state.model = keys[0] || _state.model;
    var firstSizes = (modelsCfg[_state.model] && modelsCfg[_state.model].sizes) || ['2K'];
    _state.size = firstSizes[0];
    _renderConfig(container);   // 重渲让 model/size 选项跟着变
  };
  if (modelSel) modelSel.onchange = function() {
    _state.model = modelSel.value;
    var modelsCfg = TileAPI.state.get('models.' + _state.provider) || {};
    var newSizes = (modelsCfg[_state.model] && modelsCfg[_state.model].sizes) || ['2K'];
    if (newSizes.indexOf(_state.size) < 0) _state.size = newSizes[0];
    _renderConfig(container);
  };
  if (sizeSel) sizeSel.onchange = function() { _state.size = sizeSel.value; };
  if (aspectSel) aspectSel.onchange = function() { _state.aspectRatio = aspectSel.value; };

  // 张数 +/-
  var batchVal = container.querySelector('#sceneGenBatchVal');
  var batchHint = container.querySelector('.scene-batch-hint');
  container.querySelectorAll('[data-batch-act]').forEach(function(btn) {
    btn.onclick = function() {
      var act = btn.getAttribute('data-batch-act');
      if (act === 'plus' && _state.batchCount < 8) _state.batchCount++;
      else if (act === 'minus' && _state.batchCount > 1) _state.batchCount--;
      if (batchVal) batchVal.textContent = _state.batchCount;
      if (batchHint) batchHint.textContent = '一次 Roll ' + _state.batchCount + ' 张, 1-8';
    };
  });

  // 生成
  var goBtn = container.querySelector('#sceneGo');
  if (goBtn) goBtn.onclick = function() { _generate(container); };
}

function _bindItemCards(container, pack) {
  container.querySelectorAll('.scene-item-card').forEach(function(card) {
    card.onclick = function() {
      var layer = card.dataset.layer;
      var itemId = card.dataset.itemId;
      var meta = _findItemMeta(pack, layer, itemId);
      if (!meta) return;
      var bucket = _state.items[layer];
      var cur = bucket[itemId] || 0;
      var max = meta.maxCount || 5;
      if (cur >= max) {
        TileAPI.toast('已达到该物品的最大数量 (' + max + ')', 'warn');
        return;
      }
      bucket[itemId] = cur + 1;
      _refreshBaskets(container);
    };
  });
}

function _bindBasket(container, pack) {
  container.querySelectorAll('.scene-basket-btn').forEach(function(btn) {
    btn.onclick = function(e) {
      e.stopPropagation();
      var item = btn.closest('.scene-basket-item');
      if (!item) return;
      var layer = item.dataset.layer;
      var itemId = item.dataset.itemId;
      var action = btn.dataset.action;
      var bucket = _state.items[layer];
      var cur = bucket[itemId] || 0;
      var meta = _findItemMeta(pack, layer, itemId);
      var max = (meta && meta.maxCount) || 5;
      if (action === 'plus') {
        if (cur >= max) { TileAPI.toast('已达到最大数量', 'warn'); return; }
        bucket[itemId] = cur + 1;
      } else if (action === 'minus') {
        if (cur <= 1) { delete bucket[itemId]; }
        else bucket[itemId] = cur - 1;
      } else if (action === 'remove') {
        delete bucket[itemId];
      }
      _refreshBaskets(container);
    };
  });
}

function _refreshBaskets(container) {
  // 重渲所有 basket + item cards 重新绑事件
  // 简单做法: 整个 config 屏重渲 (focal 滑块和 area 输入框值在 _state 里, 重渲不丢)
  _renderConfig(container);
}

function _findItemMeta(pack, layer, itemId) {
  var subcats = (pack.items && pack.items[layer] && pack.items[layer].subcategories) || [];
  for (var i = 0; i < subcats.length; i++) {
    for (var j = 0; j < subcats[i].items.length; j++) {
      if (subcats[i].items[j].id === itemId) return subcats[i].items[j];
    }
  }
  return null;
}

// ============================================================
//  Prompt 拼接
// ============================================================
function _buildPrompt() {
  var pack = _state.pack;
  if (!pack) return '';
  var tpl = pack.promptTemplate || '';

  // 解析 lighting
  var lightObj = (pack.shooting.lighting || []).filter(function(L) { return L.id === _state.lighting; })[0];
  var lightingTxt = lightObj ? lightObj.promptEn : '';

  // tilt
  var tiltObj = (pack.shooting.tilt || []).filter(function(T) { return T.id === _state.tilt; })[0];
  var tiltTxt = tiltObj ? tiltObj.promptEn : 'eye-level shot';

  // 物品 → 英文短语 (按 layer 拼接)
  function _itemsToText(layer) {
    var bucket = _state.items[layer];
    var ids = Object.keys(bucket).filter(function(k) { return bucket[k] > 0; });
    if (ids.length === 0) return 'minimal, mostly empty';
    return ids.map(function(id) {
      var meta = _findItemMeta(pack, layer, id);
      if (!meta) return '';
      var n = bucket[id];
      var qty = (n === 1 ? 'a' : (n === 2 ? 'two' : (n <= 5 ? 'several' : 'many')));
      return qty + ' ' + meta.promptEn;
    }).filter(Boolean).join(', ');
  }

  // 区域片段
  var areaSeg = (_state.areaText || '').trim();
  areaSeg = areaSeg ? (', ' + areaSeg) : '';

  // 参考图引导
  var refHint = '';
  if (_state.useRef && _state.refBase64) {
    refHint = (pack.refImageHints && pack.refImageHints.withRef) || '';
  } else {
    refHint = (pack.refImageHints && pack.refImageHints.withoutRef) || '';
  }

  return tpl
    .replace('{refImageHint}', refHint)
    .replace('{tilt}', tiltTxt)
    .replace('{focalLength}', String(_state.focalLength))
    .replace('{areaSegment}', areaSeg)
    .replace('{area}', areaSeg ? areaSeg.replace(/^,\s*/, '') : '')
    .replace('{lighting}', lightingTxt)
    .replace('{front}', _itemsToText('front'))
    .replace('{middle}', _itemsToText('middle'))
    .replace('{back}', _itemsToText('back'));
}

// ============================================================
//  生成
// ============================================================
function _generate(container) {
  var prompt = _buildPrompt();
  if (!prompt) { TileAPI.toast('Prompt 构建失败', 'error'); return; }

  // bug #66 同款: 走统一入口 _settingsGetActiveConnection(provider), 处理 GRS 托管路径(代理用户 key 为空也能拿到 sub-key)
  var apiKey = '', apiUrl = '';
  if (typeof window._settingsGetActiveConnection === 'function') {
    var _conn = window._settingsGetActiveConnection(_state.provider) || {};
    apiKey = _conn.key || '';
    apiUrl = _conn.url || '';
    if (!apiKey && _conn._grsKeyPending) { TileAPI.toast('正在准备夏算力, 请稍后再试', 'info'); return; }
    if (!apiKey && _conn._grsNeedLogin) { TileAPI.toast('夏算力托管需要登录 (顶栏账号区), 或切回「自带 Key」', 'error'); return; }
  } else {
    apiKey = TileAPI.storage.get('connection.' + _state.provider + '.key') || '';
    apiUrl = TileAPI.storage.get('connection.' + _state.provider + '.url') || '';
  }
  if (!apiKey) {
    TileAPI.toast(_state.provider.toUpperCase() + ' Key 未填写, 请到顶栏配置', 'error');
    return;
  }
  if (!apiUrl) {
    if (_state.provider === 'aji') {
      TileAPI.toast('AJI 服务器未校验, 请到顶栏粘贴 Key 或点"校验 Key"按钮', 'error');
    } else {
      TileAPI.toast(_state.provider.toUpperCase() + ' 地址未填写', 'error');
    }
    return;
  }

  var goBtn = container.querySelector('#sceneGo');
  if (goBtn) { goBtn.disabled = true; goBtn.textContent = '生成中...'; }

  var taskId = 'scene_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
  var timeout = 3600;
  var running = TileAPI.state.get('tasks.running') || {};
  running[taskId] = {
    engine: 'scene', provider: _state.provider,
    batchSize: _state.batchCount, startTime: Date.now(),
    success: 0, fail: 0, total: _state.batchCount,
    model: _state.model, size: _state.size, resolution: _state.size,
    presetTitle: (_state.pack && _state.pack.name) || '场景包',
    promptSnippet: '场景包 · ' + ((_state.pack && _state.pack.name) || ''),
    thumbnail: null, docId: null, selection: _state.refSelection || null
  };
  TileAPI.state.set('tasks.running', running);
  var meta = TileAPI.state.get('tasks.meta') || {};
  meta[taskId] = { countdown: timeout, timeoutSec: timeout, autoReturn: true, batchSize: _state.batchCount };
  TileAPI.state.set('tasks.meta', meta);
  TileAPI.emit('tasks:updated');
  TileAPI.emit('task:started', { taskId: taskId, timeoutSec: timeout, batchSize: _state.batchCount });
  TileAPI.emit('generate:started', { taskId: taskId, engine: 'scene', model: _state.model, batch: _state.batchCount, text: '场景包' });

  TileAPI.sendToHost('sceneGenerate', {
    taskId: taskId,
    prompt: prompt,
    negativePrompt: (_state.pack && _state.pack.negativePrompt) || '',
    refBase64: _state.useRef ? _state.refBase64 : null,
    refSelection: _state.useRef ? _state.refSelection : null,
    packId: _state.packId,
    provider: _state.provider,
    model: _state.model,
    size: _state.size,
    aspectRatio: _state.aspectRatio,
    batchCount: _state.batchCount,
    apiKey: apiKey,
    apiUrl: apiUrl
  });
}

// ============================================================
//  Host 消息回调
// ============================================================
TileAPI.onHostMessage('sceneCaptureRefResult', function(data) {
  if (!_activeContainer) return;
  var btn = _activeContainer.querySelector('#sceneCaptureRef');
  if (btn) btn.disabled = false;
  if (data && data.success) {
    _state.refBase64 = data.base64;
    _state.refSelection = data.selection;
    if (btn) btn.textContent = '✓ 已抓取 重新抓取';
    TileAPI.toast('参考图已抓取', 'success');
  } else {
    if (btn) btn.textContent = '🎯 从 PS 抓取选区';
    TileAPI.toast('抓取失败: ' + ((data && data.error) || '未知错误'), 'error');
  }
});

TileAPI.onHostMessage('sceneGenerateResult', function(data) {
  if (!_activeContainer) return;
  var btn = _activeContainer.querySelector('#sceneGo');
  if (btn) { btn.disabled = false; btn.textContent = '🚀 生成场景图'; }
  if (data && data.success) {
    var s = data.successCount || 1, f = data.failCount || 0;
    var msg = '场景图已生成 ' + s + ' 张, 已贴到 PS';
    if (f > 0) msg += ' (' + f + ' 张失败)';
    TileAPI.toast(msg, 'success');
  } else {
    TileAPI.toast('生成失败: ' + ((data && data.error) || '未知错误'), 'error');
  }
});

// ============================================================
//  注册
// ============================================================
TileAPI.registerTile({
  id: 'scene',
  group: 'main',
  icon: '🎬',
  label: '场景包',
  desc: '合成场景图',
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },
  renderFront: renderFront,
  onExpand: onExpand
});

})();
