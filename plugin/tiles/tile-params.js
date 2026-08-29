(function() {
'use strict';

var _netConfig = window.WheelchairServerConfig;

// ============================================================
// Model configs (migrated from old project)
// ============================================================
var MODEL_CONFIG = {
  'AJbanana3': { name: '香蕉Pro', sizes: ['1K','2K','4K'], default: '2K', suffixMode: 'append', prices: {'1K':0.15,'2K':0.16,'4K':0.18} },
  'Banana-pro-D': { name: '香蕉Pro-D', sizes: ['1K','2K','4K'], default: '2K', suffixMode: 'append', prices: {'1K':0.1,'2K':0.1,'4K':0.1} },
  'AJbanana2': { name: '香蕉2', sizes: ['1K','2K','4K'], default: '2K', suffixMode: 'append', prices: {'1K':0.1,'2K':0.1,'4K':0.1} },
  'gemini-2.5-flash-image': { name: '香蕉1', sizes: ['1K'], default: '1K', suffixMode: 'none', prices: {'1K':0.04} },
  'gpt-image-2': { name: '🟢 GPT-Image-2', sizes: ['1K','2K','4K'], default: '1K', suffixMode: 'none', prices: {'1K':0.04,'2K':0.08,'4K':0.16} },
};
var GRS_MODEL_CONFIG = {
  'nano-banana-2':         { name: '🔹 nano-banana-2',         sizes: ['1K','2K','4K'], default: '1K', suffixMode: 'none', prices: {'1K':1, '2K':2, '4K':4} },
  'nano-banana-fast':      { name: '⚡ nano-banana-fast',       sizes: ['1K'],           default: '1K', suffixMode: 'none', prices: {'1K':1} },
  'nano-banana':           { name: '🍌 nano-banana',            sizes: ['1K'],           default: '1K', suffixMode: 'none', prices: {'1K':1} },
  'nano-banana-pro':       { name: '🍌 nano-banana-pro',        sizes: ['1K','2K','4K'], default: '1K', suffixMode: 'none', prices: {'1K':2, '2K':3, '4K':5} },
  'nano-banana-pro-vt':    { name: '🍌 nano-banana-pro-vt',     sizes: ['1K','2K','4K'], default: '1K', suffixMode: 'none', prices: {'1K':2, '2K':3, '4K':5} },
  'nano-banana-pro-cl':    { name: '🍌 nano-banana-pro-cl',     sizes: ['1K','2K','4K'], default: '1K', suffixMode: 'none', prices: {'1K':2, '2K':3, '4K':5} },
  'nano-banana-pro-vip':   { name: '👑 nano-banana-pro-vip',    sizes: ['1K','2K'],      default: '1K', suffixMode: 'none', prices: {'1K':3, '2K':5} },
  'nano-banana-pro-4k-vip':{ name: '👑 nano-banana-pro-4k-vip', sizes: ['4K'],           default: '4K', suffixMode: 'none', prices: {'4K':8} },
  // GRS GPT-Image: 走 callGrsGptImageApi (host/ai-api.js), 调用前需先把所有图上传到临时图床换 URL
  // (tile-run.host.js 在 callAiApi 之前预上传, 详见 _uploadRefsToTempServer)
  'gpt-image-2':           { name: '🟢 GPT-Image-2',             sizes: ['1K','2K'],      default: '1K', suffixMode: 'none', prices: {'1K':2, '2K':4} },
  'gpt-image-2-vip':       { name: '🟢 GPT-Image-2 VIP (支持 4K)', sizes: ['1K','2K','4K'], default: '1K', suffixMode: 'none', prices: {'1K':3, '2K':5, '4K':10} }
};

// ============================================================
// 【算力槽位自定义 · 地基】
// 上面的 MODEL_CONFIG / GRS_MODEL_CONFIG 与 Others 拉取缓存 = 「完整目录 FULL」,勿改取值。
// 槽位自定义只在其上做:精简(子集) + 改名(全名/缩略名) + 排序。
// 不破坏原则:真实模型 id 与 prices/sizes/default/suffixMode 一律原样保留;
//            大家都读的 state['models.aji/grs/others'] 永远是「视图」,由 rebuildModelViews() 生成。
//            无任何自定义时,视图 = 完整目录 + 内置名(与改造前完全一致)。
// ============================================================
// 全部算力引擎(含第4个 momo)。顶栏/参数只显示前3个(slotOrder),但模型视图要给全部4个都建。
var DEFAULT_ENGINES = ['aji', 'grs', 'momo', 'others'];

function _fullCatalog(engine) {
  if (engine === 'grs') return GRS_MODEL_CONFIG;
  if (engine === 'others') return TileAPI.storage.get('models.others.cache') || {};
  if (engine === 'momo') return TileAPI.storage.get('models.momo.cache') || {};
  return MODEL_CONFIG;
}

// 复制一个模型条目,套上自定义全名/缩略名(空则回退内置)。其余字段(prices/sizes/default/suffixMode)原样保留。
function _cloneModelWithNames(src, fullName, shortName) {
  var o = {};
  for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) o[k] = src[k]; }
  if (fullName && String(fullName).trim()) o.name = String(fullName).trim();
  o.short = (shortName && String(shortName).trim()) ? String(shortName).trim() : (o.short || o.name);
  return o;
}

// 载入槽位配置(持久化)。slots=算力格子(默认4个: aji/grs/momo/others, 顶栏只显示前3);models=每引擎的精简+改名列表。无则给默认。
function _loadComputeConfig() {
  var slots = TileAPI.storage.get('compute.slots');
  if (!slots || !slots.length) {
    // 全新用户: 默认 aji/grs/momo 可见 + others 退居第4(隐藏)
    slots = DEFAULT_ENGINES.map(function(e) { return { engine: e, name: '' }; });
  } else {
    // 老用户升级迁移: 原来只有 aji/grs/others 三格 → 把 momo 插到 others 之前,
    // 这样 momo 进可见前3、others 被挤到第4格(隐藏)。已含 momo 的(再次升级)不动。
    var hasMomo = false;
    for (var i = 0; i < slots.length; i++) { if (slots[i] && slots[i].engine === 'momo') { hasMomo = true; break; } }
    if (!hasMomo) {
      var oi = -1;
      for (var j = 0; j < slots.length; j++) { if (slots[j] && slots[j].engine === 'others') { oi = j; break; } }
      var momoSlot = { engine: 'momo', name: '' };
      if (oi === -1) slots.push(momoSlot); else slots.splice(oi, 0, momoSlot);
      TileAPI.storage.set('compute.slots', slots); // 落盘, 下次不再迁移
    }
  }
  var models = TileAPI.storage.get('compute.models') || {};
  // 隐藏小联动(6.4.3): 自定义过 AJI 模型清单的老用户, 自动把新模型 Banana-pro-D 勾进去
  // (没自定义过的用户走全量视图天然可见, 不用动)。插到 AJbanana3 后面, 显示顺序自然。
  if (Array.isArray(models.aji)) {
    var hasProD = models.aji.some(function(it) { return it && it.id === 'Banana-pro-D'; });
    if (!hasProD) {
      var a3i = -1;
      for (var mi = 0; mi < models.aji.length; mi++) { if (models.aji[mi] && models.aji[mi].id === 'AJbanana3') { a3i = mi; break; } }
      var proD = { id: 'Banana-pro-D' };   // 不带 full/short = 用内置名「香蕉Pro-D」
      if (a3i === -1) models.aji.push(proD); else models.aji.splice(a3i + 1, 0, proD);
      TileAPI.storage.set('compute.models', models);   // 落盘, 下次不再迁移
    }
  }
  TileAPI.state.set('compute.slots', slots);
  TileAPI.state.set('compute.models', models);
}

// 据 compute.models 把 state['models.<engine>'] 重建成「视图」。无自定义 = 全量+内置名。
function rebuildModelViews() {
  var models = TileAPI.state.get('compute.models') || {};
  DEFAULT_ENGINES.forEach(function(engine) {
    var full = _fullCatalog(engine);
    var curated = models[engine];
    var view = {};
    if (!Array.isArray(curated)) {
      // 没配过(undefined) = 全量 + 内置名
      Object.keys(full).forEach(function(id) { view[id] = _cloneModelWithNames(full[id], null, null); });
    } else {
      curated.forEach(function(item) {
        if (item && item.id && full[item.id]) view[item.id] = _cloneModelWithNames(full[item.id], item.full, item.short);
      });
    }
    TileAPI.state.set('models.' + engine, view);
  });
}

// 初始化:载入槽位配置 + 生成视图(替代原来直接 state.set models.*)
_loadComputeConfig();
rebuildModelViews();
// 暴露给配置面板/其它磁贴(阶段1 顶栏保存配置后调用)
TileAPI.rebuildModelViews = rebuildModelViews;
// 暴露完整目录(顶栏槽位编辑器要列全部模型,好让用户勾回隐藏的)
TileAPI.getFullCatalog = function(engine) { return _fullCatalog(engine) || {}; };

// 追踪当前展开面板容器和 tier（provider 切换后用于重绘）
var _activePanelContainer = null;
var _activePanelTier = null;

// ============================================================
// Helpers
// ============================================================
function _getActiveConfig() {
  var provider = TileAPI.state.get('params.provider') || 'aji';
  // 统一读「视图」(由 rebuildModelViews 生成);无自定义时 = 完整目录,行为不变
  return TileAPI.state.get('models.' + provider) || {};
}

// 取某算力槽位的自定义格子名: 用户改过返回该名, 没改返回 null(调用处保留各自原默认: AJI / 品牌名 / 其他)。
// (阶段2: 主参数三处 provider 按钮标签都走这里)
function _slotLabel(engine) {
  var slots = TileAPI.state.get('compute.slots') || [];
  for (var i = 0; i < slots.length; i++) {
    if (slots[i] && slots[i].engine === engine) {
      var n = (slots[i].name || '').trim();
      return n || null;
    }
  }
  return null;
}

// 槽位名是用户输入, 进 HTML 前转义 (按钮文字 / title 都用)
function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 算某 provider 按钮该显示的文字 (区分迷你单字按钮 / 完整按钮 / inline 段按钮的各自默认)。
function _slotBtnText(eng, btn) {
  var name = _slotLabel(eng);
  if (btn.classList.contains('params-mini-btn')) {
    if (name) return name.charAt(0);
    if (eng === 'aji') return 'A';
    if (eng === 'grs') { var gs = TileAPI.computeBrand({ short: true }); return gs === 'GRS' ? 'G' : gs; }
    return '+';
  }
  if (name) return name;
  if (eng === 'aji') return 'AJI';
  if (eng === 'grs') return TileAPI.computeBrand();
  return btn.classList.contains('params-inline-seg') ? 'Others' : '其他'; // others 两布局默认不同
}

// 把容器内所有 provider 按钮文字/title 同步成当前槽位名 (smart 刷新时调用, 不重建面板)
function _syncProviderBtnLabels(container) {
  if (!container) return;
  container.querySelectorAll('[data-prov]').forEach(function(b) {
    var eng = b.dataset.prov;
    if (!eng) return;
    var txt = _slotBtnText(eng, b);
    if (b.textContent !== txt) b.textContent = txt;
    if (b.hasAttribute('title')) {
      var full = _slotLabel(eng) || (eng === 'aji' ? 'AJI' : eng === 'grs' ? TileAPI.computeBrand() : '其他');
      b.setAttribute('title', full);
    }
  });
}

function _getModelDisplayName(modelKey) {
  var cfg = _getActiveConfig();
  return (cfg[modelKey] && cfg[modelKey].name) || modelKey || '未选模型';
}

// 窄处用: 模型短名(用户没填短名时 .short 已回退成全名, 所以默认=全名, 安全)。
function _getModelShortName(modelKey) {
  var cfg = _getActiveConfig();
  var mc = cfg[modelKey];
  return (mc && (mc.short || mc.name)) || modelKey || '未选模型';
}

function _getSummary() {
  var model = TileAPI.state.get('params.model') || '';
  var size = TileAPI.state.get('params.size') || '2K';
  var batch = TileAPI.state.get('params.batch') || 1;
  return _getModelShortName(model) + ' \u00b7 ' + size + ' \u00b7 x' + batch;
}

function _ensureDefaults() {
  if (!TileAPI.state.get('params.provider')) TileAPI.state.set('params.provider', 'aji');
  var provider = TileAPI.state.get('params.provider') || 'aji';
  var config = _getActiveConfig();
  var keys = Object.keys(config);
  var cur = TileAPI.state.get('params.model');
  // 兜底: cur 是真实模型(在完整目录里)但被精简掉了 → 保留(老预设/历史可回放); 只有完全不存在才回退第一个
  var full = _fullCatalog(provider) || {};
  if (!cur || (!config[cur] && !full[cur])) {
    cur = keys[0] || '';
    TileAPI.state.set('params.model', cur);
  }
  if (!TileAPI.state.get('params.size') && config[cur]) {
    TileAPI.state.set('params.size', config[cur].default);
  }
  if (!TileAPI.state.get('params.batch')) TileAPI.state.set('params.batch', 1);
  // v6.5.0: 超时 UI 全部隐藏, 值统一拉满 3600 秒(API 层保留兜底防僵尸请求)。老用户存的小值也强制升。
  var _t0 = +TileAPI.state.get('params.timeout') || 0;
  if (_t0 < 3600) { TileAPI.state.set('params.timeout', 3600); TileAPI.storage.set('params.timeout', 3600); }
  if (!TileAPI.state.get('params.aspectRatio')) {
    TileAPI.state.set('params.aspectRatio', TileAPI.storage.get('params.aspectRatio') || '1:1');
  }
}

// ============================================================
// Build option HTML helpers
// ============================================================
function _modelOptions(config, currentModel) {
  var html = Object.keys(config).map(function(k) {
    return '<option value="' + k + '"' + (k === currentModel ? ' selected' : '') + '>' + config[k].name + '</option>';
  }).join('');
  // 兜底: 当前模型被精简掉但仍是真实模型(老预设/历史回放) → 仍列出, 用真实名/ID 显示, 不丢选中
  if (currentModel && !config[currentModel]) {
    var prov = TileAPI.state.get('params.provider') || 'aji';
    var full = _fullCatalog(prov) || {};
    if (full[currentModel]) {
      html = '<option value="' + currentModel + '" selected>' + (full[currentModel].name || currentModel) + '</option>' + html;
    }
  }
  return html;
}

function _sizeOptions(config, modelKey, currentSize) {
  var mc = config[modelKey];
  if (!mc) { // 兜底: 被精简但真实的模型(回放)→ 从完整目录取尺寸, 下拉不空
    var prov = TileAPI.state.get('params.provider') || 'aji';
    mc = (_fullCatalog(prov) || {})[modelKey];
  }
  if (!mc || !mc.sizes) return '';
  return mc.sizes.map(function(s) {
    return '<option value="' + s + '"' + (s === currentSize ? ' selected' : '') + '>' + s + '</option>';
  }).join('');
}

// ============================================================
// Front face
// ============================================================
function renderFront(container, w, h) {
  if (w >= 2) {
    container.innerHTML =
      '<div class="tile-icon">\uD83C\uDFDB\uFE0F</div>' +
      '<div class="tile-label">生成参数</div>' +
      '<div class="tile-desc">' + _getSummary() + '</div>';
  } else {
    container.innerHTML =
      '<div class="tile-icon">\uD83C\uDFDB\uFE0F</div>' +
      '<div class="tile-label">参数</div>';
  }
}

// ============================================================
// Responsive layout renderers
// ============================================================

// --- 公共:步进器绑定(批次 + 超时) ---
function _bindBatchStepper(container) {
  var hid = container.querySelector('#paramBatch');
  var val = container.querySelector('#paramBatchVal');
  if (!hid || !val) return;
  function apply(n) {
    n = Math.max(1, Math.min(18, n));
    hid.value = n; val.textContent = n;
    TileAPI.state.set('params.batch', n);
    TileAPI.storage.set('params.batch', n);
  }
  var steps = container.querySelectorAll('[data-batch-step]');
  for (var i = 0; i < steps.length; i++) {
    steps[i].addEventListener('click', (function(dir) {
      return function(e) { e.stopPropagation(); apply((+hid.value || 1) + dir); };
    })(+steps[i].dataset.batchStep));
  }
  var wrap = container.querySelector('.params-strip-batch');
  if (wrap) wrap.addEventListener('wheel', function(e) {
    if (window.UIKit && !UIKit.wheelEnabled()) return;   // 滚轮调参开关(默认关)
    e.preventDefault();
    apply((+hid.value || 1) + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });
}

function _bindTimeoutStepper(container) {
  var hid = container.querySelector('#paramTimeout');
  var val = container.querySelector('#paramTimeoutVal');
  if (!hid || !val) return;
  function apply(n) {
    n = Math.max(30, Math.min(3600, n));
    hid.value = n; val.textContent = n + 's';
    TileAPI.state.set('params.timeout', n);
    TileAPI.storage.set('params.timeout', n);
  }
  var steps = container.querySelectorAll('[data-timeout-step]');
  for (var i = 0; i < steps.length; i++) {
    steps[i].addEventListener('click', (function(dir) {
      return function(e) { e.stopPropagation(); apply((+hid.value || 3600) + dir); };
    })(+steps[i].dataset.timeoutStep));
  }
  var wrap = container.querySelector('.params-strip-timeout');
  if (wrap) wrap.addEventListener('wheel', function(e) {
    if (window.UIKit && !UIKit.wheelEnabled()) return;   // 滚轮调参开关(默认关)
    e.preventDefault();
    apply((+hid.value || 3600) + (e.deltaY < 0 ? 10 : -10));
  }, { passive: false });
}

// --- 极小布局 (1xN 或 Nx1) —— 按 tier 逐级加控件 ---
// tier = 'strip-2' (1x2/2x1 → 模型+宽高比+批次)
// tier = 'strip-3' (1x3/3x1 → +尺寸)
// tier = 'strip-4' (1x4+/4x1+ → +超时)
function _renderStrip(container, tier) {
  _ensureDefaults();
  var config = _getActiveConfig();
  var provider = TileAPI.state.get('params.provider') || 'aji';
  if ((provider === 'others' || provider === 'momo') && !Object.keys(config).length) {
    _renderOthersEmpty(container, provider);
    return;
  }

  var w = container.clientWidth || 60;
  var h = container.clientHeight || 60;
  var vertical = h >= w;

  var currentModel = TileAPI.state.get('params.model') || '';
  var currentAspect = TileAPI.state.get('params.aspectRatio') || '1:1';
  var currentSize = TileAPI.state.get('params.size') || '2K';
  var currentBatch = TileAPI.state.get('params.batch') || 1;

  // v6.5.5: 所有条形档一律渲染全部 6 件(1x2 也显示全参数), 密排交给 CSS
  // v6.5.5 件序(用户定): 行1 = 算力 / 分辨率 / 比例; 行2 = 模型 / 张数 / 抗截断
  // 算力与模型上下对齐同宽(第1列, 稍宽); 其余四件等宽稍窄
  var parts = [];
  parts.push(_providerMiniBtns(provider));
  parts.push('<select class="w10-select params-strip-select" id="paramSize" title="尺寸">' + _sizeOptions(config, currentModel, currentSize) + '</select>');
  parts.push('<select class="w10-select params-strip-select" id="paramAspect" title="宽高比">' + _aspectOptions(currentAspect) + '</select>');
  parts.push('<select class="w10-select params-strip-select" id="paramModel" title="模型">' + _modelOptions(config, currentModel) + '</select>');
  parts.push(
    '<div class="params-strip-batch" title="批次">' +
      '<button class="params-strip-stepbtn" data-batch-step="-1">−</button>' +
      '<span class="params-strip-batch-val" id="paramBatchVal">' + currentBatch + '</span>' +
      '<button class="params-strip-stepbtn" data-batch-step="1">+</button>' +
      '<input type="hidden" id="paramBatch" value="' + currentBatch + '">' +
    '</div>'
  );
  parts.push(_antiMiniBtns());

  container.innerHTML =
    '<div class="w10-panel params-strip ' + (vertical ? 'params-strip-v' : 'params-strip-h') + ' params-strip-6">' +
      parts.join('') +
    '</div>';

  _bindProviderButtons(container);
  _bindModelSelect(container);
  _bindAspectSelect(container);
  _bindSizeSelect(container);
  _bindBatchStepper(container);
  _bindAntiCycle(container);
}

// --- [v6.5.5c 起弃用: 2x2 走 strip-6] 2x2 mini-box: 全部 7 件控件,4 行紧凑布局 ---
//   行 1: provider mini + anti mini
//   行 2: 模型 (全宽)
//   行 3: 比例 + 尺寸
//   行 4: 批次 + 超时
function _renderMiniBox(container) {
  _ensureDefaults();
  var config = _getActiveConfig();
  var provider = TileAPI.state.get('params.provider') || 'aji';
  if ((provider === 'others' || provider === 'momo') && !Object.keys(config).length) {
    _renderOthersEmpty(container, provider);
    return;
  }

  var currentModel = TileAPI.state.get('params.model') || '';
  var currentAspect = TileAPI.state.get('params.aspectRatio') || '1:1';
  var currentSize = TileAPI.state.get('params.size') || '2K';
  var currentBatch = TileAPI.state.get('params.batch') || 1;
  var currentTimeout = TileAPI.state.get('params.timeout') || 3600;

  container.innerHTML =
    '<div class="w10-panel params-minibox params-minibox-7">' +
      '<div class="params-minibox-row params-minibox-row-split">' +
        _providerMiniBtns(provider) +
        _antiMiniBtns() +
      '</div>' +
      '<div class="params-minibox-row">' +
        '<select class="w10-select params-strip-select" id="paramModel" title="模型">' + _modelOptions(config, currentModel) + '</select>' +
      '</div>' +
      '<div class="params-minibox-row params-minibox-row-split">' +
        '<select class="w10-select params-strip-select" id="paramAspect" title="宽高比">' + _aspectOptions(currentAspect) + '</select>' +
        '<select class="w10-select params-strip-select" id="paramSize" title="尺寸">' + _sizeOptions(config, currentModel, currentSize) + '</select>' +
      '</div>' +
      '<div class="params-minibox-row params-minibox-row-split">' +
        '<div class="params-strip-batch" title="批次">' +
          '<button class="params-strip-stepbtn" data-batch-step="-1">−</button>' +
          '<span class="params-strip-batch-val" id="paramBatchVal">' + currentBatch + '</span>' +
          '<button class="params-strip-stepbtn" data-batch-step="1">+</button>' +
          '<input type="hidden" id="paramBatch" value="' + currentBatch + '">' +
        '</div>' +
      '</div>' +
    '</div>';

  _bindProviderButtons(container);
  _bindModelSelect(container);
  _bindAspectSelect(container);
  _bindSizeSelect(container);
  _bindBatchStepper(container);

  _bindAntiCycle(container);
}

// --- [v6.5.5c 起弃用: 2x3/3x2 走 strip-6] compact-grid ---
function _renderCompactGrid(container) {
  _ensureDefaults();
  var config = _getActiveConfig();
  var provider = TileAPI.state.get('params.provider') || 'aji';
  if ((provider === 'others' || provider === 'momo') && !Object.keys(config).length) {
    _renderOthersEmpty(container, provider);
    return;
  }

  var w = container.clientWidth || 124;
  var h = container.clientHeight || 188;
  var portrait = h >= w;

  var currentModel = TileAPI.state.get('params.model') || '';
  var currentAspect = TileAPI.state.get('params.aspectRatio') || '1:1';
  var currentSize = TileAPI.state.get('params.size') || '2K';
  var currentBatch = TileAPI.state.get('params.batch') || 1;
  var currentTimeout = TileAPI.state.get('params.timeout') || 3600;
  var currentAnti = _currentAntiMode();

  var antiBtns = _antiMiniBtns();

  container.innerHTML =
    '<div class="params-cgrid-wrap">' +
      '<div class="params-cgrid-provstrip">' + _providerMiniBtns(provider) + '</div>' +
    '<div class="w10-panel params-cgrid ' + (portrait ? 'params-cgrid-portrait' : 'params-cgrid-landscape') + '">' +
      '<div class="params-cg-cell">' +
        '<div class="params-cg-label">模型</div>' +
        '<select class="w10-select params-strip-select" id="paramModel">' + _modelOptions(config, currentModel) + '</select>' +
      '</div>' +
      '<div class="params-cg-cell">' +
        '<div class="params-cg-label">比例</div>' +
        '<select class="w10-select params-strip-select" id="paramAspect">' + _aspectOptions(currentAspect) + '</select>' +
      '</div>' +
      '<div class="params-cg-cell">' +
        '<div class="params-cg-label">尺寸</div>' +
        '<select class="w10-select params-strip-select" id="paramSize">' + _sizeOptions(config, currentModel, currentSize) + '</select>' +
      '</div>' +
      '<div class="params-cg-cell">' +
        '<div class="params-cg-label">批次</div>' +
        '<div class="params-strip-batch">' +
          '<button class="params-strip-stepbtn" data-batch-step="-1">\u2212</button>' +
          '<span class="params-strip-batch-val" id="paramBatchVal">' + currentBatch + '</span>' +
          '<button class="params-strip-stepbtn" data-batch-step="1">+</button>' +
          '<input type="hidden" id="paramBatch" value="' + currentBatch + '">' +
        '</div>' +
      '</div>' +
      '<div class="params-cg-cell">' +
        '<div class="params-cg-label">抗截断</div>' +
        antiBtns +
      '</div>' +
    '</div>' +
    '</div>';

  _bindProviderButtons(container);
  _bindModelSelect(container);
  _bindAspectSelect(container);
  _bindSizeSelect(container);
  _bindAntiCycle(container);
  _bindBatchStepper(container);

}

// --- square: compact form, model + size + batch; timeout & more hidden ---
// opts.expanded=true 让「更多设置」默认展开(用于 compact-big:2x4/4x2/3x3)
function _renderSquare(container, opts) {
  opts = opts || {};
  _ensureDefaults();
  var config = _getActiveConfig();
  var provider = TileAPI.state.get('params.provider') || 'aji';
  var currentModel = TileAPI.state.get('params.model') || '';
  var currentSize = TileAPI.state.get('params.size') || '2K';
  var currentAspect = TileAPI.state.get('params.aspectRatio') || '1:1';
  var currentBatch = TileAPI.state.get('params.batch') || 1;
  var currentTimeout = TileAPI.state.get('params.timeout') || 3600;
  var keys = Object.keys(config);

  // Others empty state
  if ((provider === 'others' || provider === 'momo') && !keys.length) {
    _renderOthersEmpty(container, provider);
    return;
  }

  var moreVisible = !!opts.expanded;

  container.innerHTML =
    '<div class="w10-panel">' +
      _providerRow(provider) +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">模型</div></div>' +
        '<div class="w10-row-right"><select class="w10-select" id="paramModel">' + _modelOptions(config, currentModel) + '</select></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">尺寸</div></div>' +
        '<div class="w10-row-right"><select class="w10-select" id="paramSize">' + _sizeOptions(config, currentModel, currentSize) + '</select></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">宽高比</div></div>' +
        '<div class="w10-row-right"><select class="w10-select" id="paramAspect">' + _aspectOptions(currentAspect) + '</select></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">批次</div></div>' +
        '<div class="w10-row-right"><div class="w10-slider"><input type="range" id="paramBatch" min="1" max="18" value="' + currentBatch + '"><span class="w10-slider-val" id="paramBatchVal">' + currentBatch + '</span></div></div>' +
      '</div>' +
      // "More" expandable section
      '<div class="params-more-toggle" id="paramsMoreToggle" style="padding:6px 0;cursor:pointer;color:var(--text-sub);font-size:11px;text-align:center;user-select:none;">' + (moreVisible ? '收起 \u25B2' : '更多设置 \u25BC') + '</div>' +
      '<div class="params-more-section" id="paramsMoreSection" style="' + (moreVisible ? '' : 'display:none;') + '">' +
        _antiRow(false) +
      '</div>' +
    '</div>';

  _bindProviderButtons(container);
  _bindModelSelect(container);
  _bindSizeSelect(container);
  _bindAspectSelect(container);
  _bindBatchSlider(container);

  _bindAntiButtons(container);

  // Toggle "more" section
  var toggle = container.querySelector('#paramsMoreToggle');
  var section = container.querySelector('#paramsMoreSection');
  if (toggle && section) {
    toggle.addEventListener('click', function() {
      var open = section.style.display !== 'none';
      section.style.display = open ? 'none' : '';
      toggle.textContent = open ? '更多设置 \u25BC' : '收起 \u25B2';
    });
  }
}

// --- wideshort: two-column layout ---
function _renderWideshort(container) {
  _ensureDefaults();
  var config = _getActiveConfig();
  var provider = TileAPI.state.get('params.provider') || 'aji';
  var currentModel = TileAPI.state.get('params.model') || '';
  var currentSize = TileAPI.state.get('params.size') || '2K';
  var currentAspect = TileAPI.state.get('params.aspectRatio') || '1:1';
  var currentBatch = TileAPI.state.get('params.batch') || 1;
  var currentTimeout = TileAPI.state.get('params.timeout') || 3600;
  var keys = Object.keys(config);

  if ((provider === 'others' || provider === 'momo') && !keys.length) {
    _renderOthersEmpty(container, provider);
    return;
  }

  container.innerHTML =
    '<div class="w10-panel">' +
      _providerRow(provider) +
      '<div class="params-columns">' +
        // Left column
        '<div class="params-col">' +
          '<div class="w10-row">' +
            '<div class="w10-row-left"><div class="w10-row-label">模型</div></div>' +
            '<div class="w10-row-right"><select class="w10-select" id="paramModel">' + _modelOptions(config, currentModel) + '</select></div>' +
          '</div>' +
          '<div class="w10-row">' +
            '<div class="w10-row-left"><div class="w10-row-label">尺寸</div></div>' +
            '<div class="w10-row-right"><select class="w10-select" id="paramSize">' + _sizeOptions(config, currentModel, currentSize) + '</select></div>' +
          '</div>' +
          '<div class="w10-row">' +
            '<div class="w10-row-left"><div class="w10-row-label">宽高比</div></div>' +
            '<div class="w10-row-right"><select class="w10-select" id="paramAspect">' + _aspectOptions(currentAspect) + '</select></div>' +
          '</div>' +
        '</div>' +
        // Right column
        '<div class="params-col">' +
          '<div class="w10-row">' +
            '<div class="w10-row-left"><div class="w10-row-label">批次</div><div class="w10-row-desc">同时生成几张</div></div>' +
            '<div class="w10-row-right"><div class="w10-slider"><input type="range" id="paramBatch" min="1" max="18" value="' + currentBatch + '"><span class="w10-slider-val" id="paramBatchVal">' + currentBatch + '</span></div></div>' +
          '</div>' +
          _antiRow(false) +
        '</div>' +
      '</div>' +
    '</div>';

  _bindProviderButtons(container);
  _bindModelSelect(container);
  _bindSizeSelect(container);
  _bindAspectSelect(container);
  _bindBatchSlider(container);

  _bindAntiButtons(container);
}

// --- compact-wide (4x2/5x2): 工具栏式 2 行 3 列 ---
// 顶行:模型 / 尺寸 / 宽高比; 底行:批次 / 超时 / 抗截断
function _renderCompactWide(container) {
  _ensureDefaults();
  var config = _getActiveConfig();
  var provider = TileAPI.state.get('params.provider') || 'aji';
  var currentModel = TileAPI.state.get('params.model') || '';
  var currentSize = TileAPI.state.get('params.size') || '2K';
  var currentAspect = TileAPI.state.get('params.aspectRatio') || '1:1';
  var currentBatch = TileAPI.state.get('params.batch') || 1;
  var currentTimeout = TileAPI.state.get('params.timeout') || 3600;
  var currentAnti = _currentAntiMode();
  var keys = Object.keys(config);

  if ((provider === 'others' || provider === 'momo') && !keys.length) {
    _renderOthersEmpty(container, provider);
    return;
  }

  var antiBtns = _antiMiniBtns();

  container.innerHTML =
    '<div class="w10-panel params-toolbar">' +
      '<div class="params-toolbar-cell">' +
        '<div class="params-toolbar-label">模型</div>' +
        '<select class="w10-select params-strip-select" id="paramModel">' + _modelOptions(config, currentModel) + '</select>' +
      '</div>' +
      '<div class="params-toolbar-cell">' +
        '<div class="params-toolbar-label">尺寸</div>' +
        '<select class="w10-select params-strip-select" id="paramSize">' + _sizeOptions(config, currentModel, currentSize) + '</select>' +
      '</div>' +
      '<div class="params-toolbar-cell">' +
        '<div class="params-toolbar-label">宽高比</div>' +
        '<select class="w10-select params-strip-select" id="paramAspect">' + _aspectOptions(currentAspect) + '</select>' +
      '</div>' +

      '<div class="params-toolbar-cell">' +
        '<div class="params-toolbar-label">批次</div>' +
        '<div class="params-strip-batch">' +
          '<button class="params-strip-stepbtn" data-batch-step="-1">\u2212</button>' +
          '<span class="params-strip-batch-val" id="paramBatchVal">' + currentBatch + '</span>' +
          '<button class="params-strip-stepbtn" data-batch-step="1">+</button>' +
          '<input type="hidden" id="paramBatch" value="' + currentBatch + '">' +
        '</div>' +
      '</div>' +
      '<div class="params-toolbar-cell">' +
        '<div class="params-toolbar-label">抗截断</div>' +
        antiBtns +
      '</div>' +
    '</div>';

  _bindModelSelect(container);
  _bindSizeSelect(container);
  _bindAspectSelect(container);
  _bindAntiCycle(container);
  _bindBatchStepper(container);

}

// --- wide: full form with all sections ---
function _renderWide(container) {
  _ensureDefaults();
  var config = _getActiveConfig();
  var provider = TileAPI.state.get('params.provider') || 'aji';
  var currentModel = TileAPI.state.get('params.model') || '';
  var currentSize = TileAPI.state.get('params.size') || '2K';
  var currentBatch = TileAPI.state.get('params.batch') || 1;
  var currentTimeout = TileAPI.state.get('params.timeout') || 3600;
  var keys = Object.keys(config);

  if ((provider === 'others' || provider === 'momo') && !keys.length) {
    _renderOthersEmpty(container, provider);
    return;
  }

  container.innerHTML =
    '<div class="w10-panel">' +
      '<div class="w10-section-title">API 引擎</div>' +
      _providerRow(provider) +

      '<div class="w10-section-title">参数</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">模型</div></div>' +
        '<div class="w10-row-right"><select class="w10-select" id="paramModel">' + _modelOptions(config, currentModel) + '</select></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">尺寸</div></div>' +
        '<div class="w10-row-right"><select class="w10-select" id="paramSize">' + _sizeOptions(config, currentModel, currentSize) + '</select></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">宽高比</div><div class="w10-row-desc">Auto = 跟随选区</div></div>' +
        '<div class="w10-row-right"><select class="w10-select" id="paramAspect">' + _aspectOptions(TileAPI.state.get('params.aspectRatio') || '1:1') + '</select></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">批次</div><div class="w10-row-desc">同时生成几张</div></div>' +
        '<div class="w10-row-right"><div class="w10-slider"><input type="range" id="paramBatch" min="1" max="18" value="' + currentBatch + '"><span class="w10-slider-val" id="paramBatchVal">' + currentBatch + '</span></div></div>' +
      '</div>' +

      '<div class="w10-section-title">抗截断</div>' +
      _antiRow(true) +
    '</div>';

  _bindProviderButtons(container);
  _bindModelSelect(container);
  _bindSizeSelect(container);
  _bindAspectSelect(container);
  _bindBatchSlider(container);

  _bindAntiButtons(container);
}

// --- inline: 就地展开专用布局 (Win10 行式,紧凑,覆盖所有关键参数) ---
// 用户就地展开 1x1 参数磁贴时走这个,密度高但风格对齐 w10-panel
function _renderInlineRows(container) {
  _ensureDefaults();
  var config = _getActiveConfig();
  var provider = TileAPI.state.get('params.provider') || 'aji';
  var currentModel = TileAPI.state.get('params.model') || '';
  var currentSize = TileAPI.state.get('params.size') || '2K';
  var currentAspect = TileAPI.state.get('params.aspectRatio') || '1:1';
  var currentBatch = TileAPI.state.get('params.batch') || 1;
  var currentTimeout = TileAPI.state.get('params.timeout') || 3600;
  var currentAnti = _currentAntiMode();

  var providerBtns =
    TileAPI.slotOrder().map(function(eng) {
      var def = eng === 'aji' ? 'AJI' : eng === 'grs' ? TileAPI.computeBrand() : 'Others';
      return '<button class="w10-btn params-inline-seg' + (provider === eng ? ' w10-btn-accent' : '') + '" data-prov="' + eng + '">' + _esc(_slotLabel(eng) || def) + '</button>';
    }).join('');

  var antiBtns = '';
  for (var i = 0; i < 3; i++) {
    antiBtns += '<button class="w10-btn params-inline-seg' + (i === currentAnti ? ' w10-btn-accent' : '') +
      '" data-anti-mode="' + i + '">' + ANTI_LABELS[i] + '</button>';
  }

  var modelSelect = (provider === 'others' && !Object.keys(config).length)
    ? '<span class="params-inline-hint">未拉取模型</span>'
    : '<select class="w10-select" id="paramModel">' + _modelOptions(config, currentModel) + '</select>';

  container.innerHTML =
    '<div class="w10-panel params-inline">' +
      '<div class="w10-row params-inline-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">引擎</div></div>' +
        '<div class="w10-row-right"><div class="params-inline-segs">' + providerBtns + '</div></div>' +
      '</div>' +
      '<div class="w10-row params-inline-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">模型</div></div>' +
        '<div class="w10-row-right">' + modelSelect + '</div>' +
      '</div>' +
      '<div class="w10-row params-inline-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">尺寸</div></div>' +
        '<div class="w10-row-right"><select class="w10-select" id="paramSize">' + _sizeOptions(config, currentModel, currentSize) + '</select></div>' +
      '</div>' +
      '<div class="w10-row params-inline-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">比例</div></div>' +
        '<div class="w10-row-right"><select class="w10-select" id="paramAspect">' + _aspectOptions(currentAspect) + '</select></div>' +
      '</div>' +
      '<div class="w10-row params-inline-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">批次</div></div>' +
        '<div class="w10-row-right"><div class="params-strip-batch">' +
          '<button class="params-strip-stepbtn" data-batch-step="-1">\u2212</button>' +
          '<span class="params-strip-batch-val" id="paramBatchVal">' + currentBatch + '</span>' +
          '<button class="params-strip-stepbtn" data-batch-step="1">+</button>' +
          '<input type="hidden" id="paramBatch" value="' + currentBatch + '">' +
        '</div></div>' +
      '</div>' +
      '<div class="w10-row params-inline-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">抗截断</div></div>' +
        '<div class="w10-row-right"><div class="params-inline-segs">' + antiBtns + '</div></div>' +
      '</div>' +
    '</div>';

  _bindProviderButtons(container);
  _bindModelSelect(container);
  _bindSizeSelect(container);
  _bindAspectSelect(container);
  _bindAntiButtons(container);
  _bindBatchStepper(container);

}

// ============================================================
var ANTI_LABELS = ['关', '抗截断', '抗截断+'];
var ANTI_DESCS = [
  '正常模式，不做预处理',
  '色相偏移180°，绕过AI安全过滤',
  '色相偏移 + 垂直翻转，更强的抗截断'
];

function _currentAntiMode() {
  return +(TileAPI.state.get('params.antiMode') || 0);
}

function _antiRow(showDesc) {
  var m = _currentAntiMode();
  var btns = '';
  for (var i = 0; i < 3; i++) {
    btns += '<button class="w10-btn' + (i === m ? ' w10-btn-accent' : '') + '" data-anti-mode="' + i + '">' + ANTI_LABELS[i] + '</button>';
  }
  return '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">抗截断</div>' +
        (showDesc ? '<div class="w10-row-desc" data-anti-desc>' + ANTI_DESCS[m] + '</div>' : '') +
      '</div>' +
      '<div class="w10-row-right"><div class="anti-btns-row">' + btns + '</div></div>' +
    '</div>';
}

function _bindAntiButtons(container) {
  var btns = container.querySelectorAll('[data-anti-mode]');
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function(e) {
      // inline 就地展开时, 点击必须 stopPropagation, 否则冒泡到 document 被
      // outside-click 逻辑干扰, 看着像没反应/不灵敏
      if (e && e.stopPropagation) e.stopPropagation();
      var newMode = +this.dataset.antiMode;

      // 实际应用某个抗截断模式 (state/storage/同步后端/视觉)
      function _applyAnti(mode) {
        TileAPI.state.set('params.antiMode', mode);
        TileAPI.storage.set('params.antiMode', mode);
        // 同步到后端：抗截断在截图阶段读的是后端全局 g_antiTruncationMode
        // 不 sync 会导致截图/回图两端状态不一致（色相翻转 bug）
        TileAPI.sendToHost('updateSettings', { antiMode: mode });
        TileAPI.emit('params:antiModeChanged', { mode: mode });  // 通知 Dock 刷新高亮
        // 视觉:切换按钮激活态. 两套按钮: 普通版用 w10-btn-accent, mini 版用 is-active
        var all = container.querySelectorAll('[data-anti-mode]');
        for (var k = 0; k < all.length; k++) {
          var on = +all[k].dataset.antiMode === mode;
          all[k].classList.toggle('w10-btn-accent', on);
          all[k].classList.toggle('is-active', on);
        }
        // 更新描述
        var desc = container.querySelector('[data-anti-desc]');
        if (desc) desc.textContent = ANTI_DESCS[mode];
      }

      // 开启抗截断(mode>0)时弹防呆警告; 关闭(mode=0)直接应用. 点过「不再显示」则跳过弹窗
      if (newMode > 0 && TileAPI.storage.get('anti.warnDismissed') !== true) {
        TileAPI.dialog({
          title: '⚠️ 抗截断警告',
          html: '<div class="uik-dlg-message">开启「抗截断」可能导致<b>颜色偏移</b>。<br><br>提示词里<b>不能出现任何描述颜色的词</b>(如红 / 蓝 / 金色 等),否则会出现<b>色相偏移、画质劣化</b>。<br><br>确定要开启吗?</div>',
          buttons: ['取消', '不再显示', '知道了'],
          accent: 2,
          escIndex: 0
        }).then(function(res) {
          if (res.index === 0) return; // 取消: 不开启
          if (res.index === 1) TileAPI.storage.set('anti.warnDismissed', true); // 不再显示: 永久关弹窗并开启
          _applyAnti(newMode);
        });
      } else {
        _applyAnti(newMode);
      }
    });
  }
}

// ============================================================
// Aspect ratio options (shared)
// ============================================================
var ASPECT_RATIOS = ['1:1', 'Auto', '9:16', '16:9', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '21:9', '9:21', '2:1', '1:2', '3:1', '1:3'];
// GPT-Image 4K 档只支持横/竖,自动收敛
var ASPECT_RATIOS_GPT_4K = ['16:9', '9:16'];
function _isGptImageModel(model) {
  return model && String(model).toLowerCase().indexOf('gpt-image') !== -1;
}
function _aspectOptionsFor(current, model, size) {
  var list = ASPECT_RATIOS;
  if (_isGptImageModel(model) && size === '4K') {
    list = ASPECT_RATIOS_GPT_4K;
    // 当前 ratio 不在白名单 → 默认 16:9
    if (list.indexOf(current) === -1) current = '16:9';
  }
  return list.map(function(r) {
    var label = r;
    if (_isGptImageModel(model) && size === '4K') {
      label = (r === '16:9') ? '4K横屏 (16:9)' : '4K竖屏 (9:16)';
    }
    return '<option value="' + r + '"' + (r === current ? ' selected' : '') + '>' + label + '</option>';
  }).join('');
}
function _aspectOptions(current) {
  // 兼容老调用:推断当前 model/size
  var model = TileAPI.state.get('params.model') || '';
  var size = TileAPI.state.get('params.size') || '';
  return _aspectOptionsFor(current, model, size);
}
function _bindAspectSelect(container) {
  var sel = container.querySelector('#paramAspect');
  if (!sel) return;
  sel.addEventListener('change', function() {
    TileAPI.state.set('params.aspectRatio', this.value);
    TileAPI.storage.set('params.aspectRatio', this.value);
    _syncMarqueeToPS(this.value);
  });
}

// 同步 PS 矩形选框工具的"样式/宽/高" — 走工具预设方案
//   PS 27.5+ 已禁用 set currentToolOptions, 只能用 select toolPreset 间接达成
//   预设需用户首次安装时手动建一次 (设置磁贴里有"重建预设"按钮兜底)
//   storage key: params.syncMarqueeAspect (默认 true, 用户可关)
function _syncMarqueeToPS(aspect) {
  // 用户没开就跳过, 不打扰
  if (TileAPI.storage.get('params.syncMarqueeAspect') === false) return;
  if (!aspect) return;
  TileAPI.sendToHost('syncMarqueeAspect', { aspect: aspect });
  // 失败回调 (预设不存在等) 在 _onSyncResult 里处理, 不在这里阻塞
}

// 监听 host 返回的同步结果
//   失败的话 toast 提示用户去设置磁贴重建预设, 但只 toast 一次, 不烦人
var _syncFailWarned = false;
TileAPI.onHostMessage('syncMarqueeAspectResult', function(data) {
  if (!data || data.success) {
    _syncFailWarned = false;   // 成功后允许下次失败再提示一次
    return;
  }
  if (_syncFailWarned) return;
  _syncFailWarned = true;
  // 把 host 的具体错误展开,方便排查 — 包含 select 错误 + 自动导入错误两段
  var msg = 'PS 选框比例同步失败';
  if (data.preset) msg += ' (预设 ' + data.preset + ')';
  if (data.error) msg += ': ' + data.error;
  if (data.importError) msg += ' | 自动导入失败: ' + data.importError;
  TileAPI.toast(msg, 'warn');
  TileAPI.log('[syncMarqueeAspect] ' + JSON.stringify(data), 'warn');
});

// ============================================================
// Others empty-state renderer
// ============================================================
function _renderOthersEmpty(container, provider) {
  var isMomo = (provider === 'momo');
  var label = isMomo ? '墨墨' : 'Others';
  var hint = isMomo
    ? '请到 <b>顶栏 ⚡算力配置 → 墨墨</b> 填入 Key 并点击"拉取模型"'
    : '请到 <b>设置 → API 设置 → Others</b> 填入 URL/Key 并点击"拉取模型"';
  container.innerHTML =
    '<div class="w10-panel">' +
      _providerRow(provider) +
      '<div style="padding:24px 12px;text-align:center;">' +
        '<div style="color:var(--text-sub);font-size:12px;margin-bottom:6px;">未配置 ' + label + ' 模型</div>' +
        '<div style="color:var(--text-sub);font-size:11px;margin-bottom:12px;line-height:1.6;">' + hint + '</div>' +
        '<button class="w10-btn w10-btn-accent" id="paramsOpenSettings">' + (isMomo ? '打开算力配置' : '打开设置') + '</button>' +
      '</div>' +
    '</div>';

  _bindProviderButtons(container);

  var settingsBtn = container.querySelector('#paramsOpenSettings');
  if (settingsBtn) settingsBtn.addEventListener('click', function() {
    if (isMomo) {
      TileAPI.toast('请点顶栏的 ⚡ 算力配置 → 墨墨, 填 Key 后拉取模型', 'info');
      return;
    }
    TileAPI.expandTile('settings');
  });
}

function _fetchOthersModels(container) {
  var url = TileAPI.storage.get('connection.others.url') || '';
  var key = TileAPI.storage.get('connection.others.key') || '';
  if (!url || !key) {
    TileAPI.toast('请先在设置里填写 Others URL 和 Key', 'error');
    return;
  }
  if (url.endsWith('/')) url = url.slice(0, -1);
  var status = container.querySelector('#paramsFetchStatus');
  if (status) status.textContent = '拉取中...';
  _netConfig.fetchWithTimeout(url + '/v1/models', { method: 'GET', headers: { 'Authorization': 'Bearer ' + key } }, 15000)
    .then(function(resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    })
    .then(function(data) {
      var models = [];
      if (data && data.data && Array.isArray(data.data)) {
        models = data.data.map(function(m) { return m.id || m.name; }).filter(Boolean);
      } else if (data && Array.isArray(data.models)) {
        models = data.models.map(function(m) { return typeof m === 'string' ? m : (m.id || m.name); }).filter(Boolean);
      } else if (Array.isArray(data)) {
        models = data.map(function(m) { return typeof m === 'string' ? m : (m.id || m.name); }).filter(Boolean);
      }
      // 关键词过滤(对齐 v5):banana直接保留;gemini需含image;gpt-image系列保留
      models = models.filter(function(m) {
        var l = String(m).toLowerCase();
        if (l.indexOf('banana') !== -1) return true;
        if (l.indexOf('gemini') !== -1 && l.indexOf('image') !== -1) return true;
        if (l.indexOf('gpt-image') !== -1) return true;
        return false;
      });
      models.sort();
      if (!models.length) throw new Error('返回为空(过滤后没有图像类模型)');
      // 组装成统一 config 结构:{modelName: {name, sizes, default, suffixMode, prices}}
      // 字段名跟 MODEL_CONFIG / GRS_MODEL_CONFIG 一致
      var cfg = {};
      models.forEach(function(m) {
        cfg[m] = {
          name: m,
          sizes: ['1K', '2K', '4K'],
          default: '2K',
          suffixMode: 'none',
          prices: { '1K': 0, '2K': 0, '4K': 0 }
        };
      });
      TileAPI.storage.set('models.others.cache', cfg);
      // 经视图重建写入 state(默认无自定义 = 全量;阶段1 起若有自定义,这里需把新拉取的模型并入)
      if (TileAPI.rebuildModelViews) TileAPI.rebuildModelViews(); else TileAPI.state.set('models.others', cfg);
      TileAPI.toast('拉取成功: ' + models.length + ' 个模型', 'success');
      var curProvider = TileAPI.state.get('params.provider') || 'others';
      if (curProvider === 'others') {
        TileAPI.state.set('params.model', models[0]);
        TileAPI.emit('params:modelsFetched', { provider: 'others', count: models.length });
      }
    })
    .catch(function(err) {
      if (status) status.textContent = '失败: ' + err.message;
      TileAPI.toast('拉取失败: ' + err.message, 'error');
    });
}

// ============================================================
// Shared HTML fragments
// ============================================================
function _providerRow(provider) {
  return '<div class="w10-row">' +
    '<div class="w10-row-left"><div class="w10-row-label">提供商</div></div>' +
    '<div class="w10-row-right" style="gap:3px;">' +
      TileAPI.slotOrder().map(function(eng) {
        var def = eng === 'aji' ? 'AJI' : eng === 'grs' ? TileAPI.computeBrand() : eng === 'momo' ? '墨墨' : '其他';
        return '<button class="w10-btn' + (provider === eng ? ' w10-btn-accent' : '') + '" data-prov="' + eng + '">' + _esc(_slotLabel(eng) || def) + '</button>';
      }).join('') +
    '</div>' +
  '</div>';
}

// 紧凑版 provider 三按钮(单字 A/G/+),用于 strip-4 / mini-box 等窄面板; 按槽位顺序排
function _providerMiniBtns(provider) {
  var grsShort = TileAPI.computeBrand({ short: true });
  var defChar = { aji: 'A', grs: (grsShort === 'GRS' ? 'G' : grsShort), others: '+', momo: '墨' };
  var defFull = { aji: 'AJI', grs: TileAPI.computeBrand(), others: '其他', momo: '墨墨' };
  var order = TileAPI.slotOrder();
  var title = '提供商: ' + order.map(function(e) { return _esc(_slotLabel(e) || defFull[e]); }).join(' / ');
  return '<div class="params-mini-btns" data-mini="prov" title="' + title + '">' +
    order.map(function(eng) {
      var name = _slotLabel(eng);
      var ch = name ? name.charAt(0) : defChar[eng];
      var full = name || defFull[eng];
      return '<button class="params-mini-btn' + (provider === eng ? ' is-active' : '') + '" data-prov="' + eng + '" title="' + _esc(full) + '">' + _esc(ch) + '</button>';
    }).join('') +
  '</div>';
}

// 紧凑版 anti 三按钮 (关/17/17+),配合 strip / mini-box
function _antiMiniBtns() {
  // v6.5.5: 单按钮循环切换(关→17→17+), 省 2/3 宽度
  var m = _currentAntiMode();
  return '<button class="w10-btn params-anti-cycle' + (m > 0 ? ' w10-btn-accent' : '') +
    '" data-anti-cycle="1" title="抗截断(点按循环): 关 / R17色相偏移 / R17+翻转">' + ANTI_LABELS_SHORT[m] + '</button>';
}
var ANTI_LABELS_SHORT = ['抗:关', '抗:17', '抗:17+'];
function _bindAntiCycle(container) {
  var btn = container.querySelector('[data-anti-cycle]');
  if (!btn) return;
  btn.addEventListener('click', function(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    var mode = (_currentAntiMode() + 1) % 3;
    TileAPI.state.set('params.antiMode', mode);
    TileAPI.storage.set('params.antiMode', mode);
    TileAPI.sendToHost('updateSettings', { antiMode: mode });
    TileAPI.emit('params:antiModeChanged', { mode: mode });
    btn.textContent = ANTI_LABELS_SHORT[mode];
    btn.classList.toggle('w10-btn-accent', mode > 0);
    TileAPI.toast('抗截断: ' + ANTI_LABELS[mode], 'info');
  });
}


// ============================================================
// Event-binding helpers (operate on container scope)
// ============================================================
function _bindProviderButtons(container) {
  container.querySelectorAll('[data-prov]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var p = btn.dataset.prov;
      // 先持久化新 provider
      if (TileAPI.setProvider) TileAPI.setProvider(p, { source: 'params' });
      else { TileAPI.state.set('params.provider', p); TileAPI.storage.set('params.provider', p); TileAPI.emit('params:providerChanged', { provider: p }); }

      if (container._isInline) {
        // inline 模式精准更新 DOM,避免 innerHTML 替换 → 按钮节点脱落 → outside-click 误判 → 面板自动收起
        _refreshInlineProviderUI(container, p);
      } else {
        // 非 inline (大面板): 精准更新, 不整体重渲 (避免切供应商时面板闪一下/控件状态丢失)
        _refreshProviderUISmart(container, p);
      }
    });
  });
}

// 非 inline (大面板) provider 切换的精准更新: 只改 provider 按钮高亮 + model/size 下拉选项,
// 不重建面板 (避免闪烁 / 控件状态丢失). 各 tier 统一用 #paramModel / #paramSize / [data-prov].
// 关键: 保留 <select> 元素本身 (已被 UIKit 包进 .uik-sel-wrap), 只改 .innerHTML,
// UIKit 内部 MutationObserver 会自动同步显示; change 绑定挂在 select 上, 不会丢失.
function _refreshProviderUISmart(container, provider) {
  // 1. provider 按钮激活态
  container.querySelectorAll('[data-prov]').forEach(function(b) {
    var on = b.dataset.prov === provider;
    // provider 按钮在不同布局用不同激活类: w10 行 / inline 段用 w10-btn-accent,
    // 迷你三按钮(strip-4 / mini-box / compact-grid)用 is-active. 两个都切,
    // 才能保证任何布局(尤其 1×4 strip)切算力来源后高亮都同步。
    b.classList.toggle('w10-btn-accent', on);
    b.classList.toggle('is-active', on);
  });
  _syncProviderBtnLabels(container); // 同步槽位名(改名后即时生效)

  var config = _getActiveConfig();
  var keys = Object.keys(config);

  // 2. 选出该 provider 下的目标模型 (沿用已保存的, 否则取第一个)
  // 兜底: savedModel 被精简掉但仍是该 provider 的真实模型(回放) → 保留; 切到别的 provider 时旧模型不在其完整目录 → 自然回退
  var savedModel = TileAPI.storage.get('params.model') || '';
  var _fullSP = _fullCatalog(provider) || {};
  var targetModel = (savedModel && (config[savedModel] || _fullSP[savedModel])) ? savedModel : (keys[0] || '');

  var modelSel = container.querySelector('#paramModel');
  var modelHint = container.querySelector('.params-inline-hint');

  if ((provider === 'others' || provider === 'momo') && !keys.length) {
    // 切到 others 且未拉取模型 → 若当前有 select, 不强行删 (大面板各 tier 结构不一), 仅清空选项
    if (modelSel) modelSel.innerHTML = '<option value="">未拉取模型</option>';
    return;
  }

  if (modelSel) {
    modelSel.innerHTML = _modelOptions(config, targetModel);
    if (modelSel.value !== targetModel) modelSel.value = targetModel;
  }

  // 3. 模型变了 → 持久化 + 同步尺寸下拉
  if (targetModel) {
    TileAPI.state.set('params.model', targetModel);
    TileAPI.storage.set('params.model', targetModel);
    var sizeSel = container.querySelector('#paramSize');
    if (sizeSel && config[targetModel]) {
      var curSize = TileAPI.storage.get('params.size') || '';
      var sizes = config[targetModel].sizes || [];
      var targetSize = (curSize && sizes.indexOf(curSize) >= 0) ? curSize : (config[targetModel].default || sizes[0]);
      sizeSel.innerHTML = _sizeOptions(config, targetModel, targetSize);
      if (targetSize) {
        sizeSel.value = targetSize;
        TileAPI.state.set('params.size', targetSize);
        TileAPI.storage.set('params.size', targetSize);
      }
    }
  }
  _refreshFront();
}

// inline 模式 provider 切换的精准 DOM 更新:
// 1. 三个 provider 按钮的激活态
// 2. 模型下拉框选项(不同 provider 的模型列表不同)
// 3. 尺寸下拉框选项(模型变了,支持的尺寸跟着变)
// 不动其它 DOM,目的是不让 click target 节点脱落,从而不触发 outside-click 误关
//
// 关键约束: 不能用 outerHTML 替换 <select> 本身,因为它已经被 UIKit 包进 .uik-sel-wrap
// 老 wrap 不会被清理,导致每切一次 provider 就累积一组重复的视觉残留(用户可见的"重叠框"bug)
// 正确做法: 保留 <select> 元素,只改 .innerHTML + .value,UIKit 内部 MutationObserver 会自动同步 trigger
function _refreshInlineProviderUI(container, provider) {
  // 1. 按钮激活态
  container.querySelectorAll('[data-prov]').forEach(function(b) {
    var on = b.dataset.prov === provider;
    // provider 按钮在不同布局用不同激活类: w10 行 / inline 段用 w10-btn-accent,
    // 迷你三按钮(strip-4 / mini-box / compact-grid)用 is-active. 两个都切,
    // 才能保证任何布局(尤其 1×4 strip)切算力来源后高亮都同步。
    b.classList.toggle('w10-btn-accent', on);
    b.classList.toggle('is-active', on);
  });
  _syncProviderBtnLabels(container); // 同步槽位名(改名后即时生效)

  var config = _getActiveConfig();
  var keys = Object.keys(config);

  // 2. 模型下拉框 / 空状态切换
  // 模型行可能有两种状态:正常 select 或"未拉取模型"提示;切换 provider 时两种状态可能互转
  var modelRow = null;
  var labels = container.querySelectorAll('.w10-row-label');
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].textContent === '模型') { modelRow = labels[i].closest('.w10-row'); break; }
  }
  var rowRight = modelRow && modelRow.querySelector('.w10-row-right');

  if (rowRight) {
    var existingSel = rowRight.querySelector('#paramModel');
    var existingHint = rowRight.querySelector('.params-inline-hint');

    if ((provider === 'others' || provider === 'momo') && !keys.length) {
      // 切到 others 且未拉取 → 显示"未拉取"提示
      // 如果当前是 select,先彻底清掉(连带 UIKit 包装)再换成提示
      if (existingSel) {
        var wrap = existingSel.closest('.uik-sel-wrap');
        var toRemove = wrap || existingSel;
        if (toRemove.parentNode) toRemove.parentNode.removeChild(toRemove);
      }
      if (!existingHint) {
        rowRight.innerHTML = '<span class="params-inline-hint">未拉取模型</span>';
      }
    } else {
      // 选个新 model:优先保留当前 model(新 provider 支持, 或仍是其真实模型→回放), 否则取第一个
      var _curM = TileAPI.state.get('params.model');
      var _fullIP = _fullCatalog(provider) || {};
      var newModel = (_curM && (config[_curM] || _fullIP[_curM])) ? _curM : (keys[0] || '');
      TileAPI.state.set('params.model', newModel);
      TileAPI.storage.set('params.model', newModel);

      if (existingSel) {
        // ★ 关键:仅改 select 的 options + value,不动 select 元素本身
        // UIKit 的 MutationObserver 会自动 rebuild trigger
        existingSel.innerHTML = _modelOptions(config, newModel);
        existingSel.value = newModel;
      } else {
        // 之前是"未拉取"提示,需要换回 select(此时 UIKit 还没包过它,可以直接 innerHTML 替换)
        rowRight.innerHTML = '<select class="w10-select" id="paramModel">' + _modelOptions(config, newModel) + '</select>';
        _bindModelSelect(container);
        if (window.UIKit && window.UIKit.enhance) {
          try { window.UIKit.enhance(rowRight); } catch(e) {}
        }
      }
    }
  }

  // 3. 尺寸下拉框 - 同样只改 innerHTML + value,不动 select 元素
  var sizeSel = container.querySelector('#paramSize');
  if (sizeSel) {
    var curModel = TileAPI.state.get('params.model') || '';
    var curSize = TileAPI.state.get('params.size') || '2K';
    sizeSel.innerHTML = _sizeOptions(config, curModel, curSize);
    // _sizeOptions 通常已经把 selected 标记加到匹配项上,但 select.value 显式设一下更稳
    var sizeKeys = config[curModel] && config[curModel].sizes;
    if (sizeKeys && sizeKeys.indexOf(curSize) >= 0) {
      sizeSel.value = curSize;
    } else if (sizeKeys && sizeKeys.length) {
      sizeSel.value = sizeKeys[0];
      TileAPI.state.set('params.size', sizeKeys[0]);
      TileAPI.storage.set('params.size', sizeKeys[0]);
    }
  }
}

// 4K + GPT-Image 时,如果当前 aspect 不在 [16:9, 9:16] 内,自动收敛
// 同时刷新 paramAspect 下拉的可选项
function _enforceGptAspectIfNeeded(container) {
  var model = TileAPI.state.get('params.model') || '';
  var size = TileAPI.state.get('params.size') || '';
  var curAspect = TileAPI.state.get('params.aspectRatio') || '1:1';
  if (_isGptImageModel(model) && size === '4K') {
    if (curAspect !== '16:9' && curAspect !== '9:16') {
      curAspect = '16:9';
      TileAPI.state.set('params.aspectRatio', curAspect);
      TileAPI.storage.set('params.aspectRatio', curAspect);
    }
  }
  if (container) {
    var aspSel = container.querySelector('#paramAspect');
    if (aspSel) {
      aspSel.innerHTML = _aspectOptionsFor(curAspect, model, size);
      aspSel.value = curAspect;
    }
  }
}

function _bindModelSelect(container) {
  var sel = container.querySelector('#paramModel');
  if (!sel) return;
  sel.addEventListener('change', function() {
    TileAPI.state.set('params.model', this.value);
    TileAPI.storage.set('params.model', this.value);
    var cfg = _getActiveConfig();
    var sizeSel = container.querySelector('#paramSize');
    if (sizeSel && cfg[this.value]) {
      var cur = sizeSel.value;
      sizeSel.innerHTML = _sizeOptions(cfg, this.value, cur);
      if (cfg[this.value].sizes.indexOf(cur) < 0) {
        sizeSel.value = cfg[this.value].default || cfg[this.value].sizes[0];
      }
      sizeSel.dispatchEvent(new Event('change'));
    }
    // GPT-Image 4K 收敛 aspect 候选
    _enforceGptAspectIfNeeded(container);
  });
}

function _bindSizeSelect(container) {
  var sel = container.querySelector('#paramSize');
  if (!sel) return;
  sel.addEventListener('change', function() {
    TileAPI.state.set('params.size', this.value);
    TileAPI.storage.set('params.size', this.value);
    _enforceGptAspectIfNeeded(container);
  });
}

function _bindBatchSlider(container) {
  var input = container.querySelector('#paramBatch');
  var valSpan = container.querySelector('#paramBatchVal');
  if (!input) return;
  input.addEventListener('input', function() {
    if (valSpan) valSpan.textContent = this.value;
    TileAPI.state.set('params.batch', +this.value);
  });
  // 松手时立即落盘一次, 不等防抖, 避免拖完马上重载丢值
  input.addEventListener('change', function() {
    TileAPI.storage.set('params.batch', +this.value);
  });
  _bindWheelStep(input, 1, function(v) {
    if (valSpan) valSpan.textContent = v;
    TileAPI.state.set('params.batch', +v);
    TileAPI.storage.set('params.batch', +v);
  });
}

function _bindTimeoutSlider(container) {
  var input = container.querySelector('#paramTimeout');
  var valSpan = container.querySelector('#paramTimeoutVal');
  if (!input) return;
  input.addEventListener('input', function() {
    if (valSpan) valSpan.textContent = this.value + 's';
    TileAPI.state.set('params.timeout', +this.value);
  });
  input.addEventListener('change', function() {
    TileAPI.storage.set('params.timeout', +this.value);
  });
  _bindWheelStep(input, 10, function(v) {
    if (valSpan) valSpan.textContent = v + 's';
    TileAPI.state.set('params.timeout', +v);
    TileAPI.storage.set('params.timeout', +v);
  });
}

// 滚轮微调滑块:向上滚 +step,向下滚 -step
function _bindWheelStep(input, step, onChange) {
  if (input) input.__wheelBound = true;   // 标记: 防止 UIKit.enhance 再挂一个滚轮(重复步进)
  input.addEventListener('wheel', function(e) {
    if (window.UIKit && !UIKit.wheelEnabled()) return;   // 滚轮调参开关(默认关)
    e.preventDefault();
    var dir = e.deltaY < 0 ? 1 : -1;
    var min = +input.min || 0;
    var max = +input.max || 100;
    var next = Math.max(min, Math.min(max, (+input.value) + dir * step));
    if (next !== +input.value) {
      input.value = next;
      if (onChange) onChange(next);
    }
  }, { passive: false });
}

// ============================================================
// 本地细分档器 —— 按 grid cells 逐级显示更多控件
// ============================================================
function _classifyParamsTier(w, h) {
  // UXP 面板会动态重算 --cell,硬编码 60/64 会让拉宽面板时误判 tier
  // 改用实时的 --cell 值(等于 _cell = (vpW - GAP*(COLS-1)) / COLS)
  var cs = getComputedStyle(document.documentElement).getPropertyValue('--cell');
  var cell = parseFloat(cs);
  if (!cell || isNaN(cell)) cell = 60;
  var gap = 4;
  var unit = cell + gap;
  var cellsW = Math.max(1, Math.round((w + gap) / unit));
  var cellsH = Math.max(1, Math.round((h + gap) / unit));
  var cells = cellsW * cellsH;
  var isStrip = (cellsW === 1 || cellsH === 1);
  var flat = cellsW >= 4 && cellsH <= 2;   // 很扁:4x2 / 5x2 这种

  if (isStrip) {
    if (cells <= 2) return 'strip-2';   // 1x2 / 2x1
    if (cells === 3) return 'strip-3';  // 1x3 / 3x1
    return 'strip-4';                    // 1x4+ / 4x1+
  }
  if (cells === 4) return 'mini-box';       // 2x2
  if (cells <= 6) return 'compact';         // 2x3 / 3x2
  if (flat) return 'compact-wide';          // 4x2 / 5x2:工具栏式
  if (cells <= 9) return 'compact-big';     // 2x4 / 3x3
  if (w >= 400 && w > h * 1.8) return 'wideshort';
  return 'wide';                             // 3x4 / 4x3 / 4x4+
}

function _renderByTier(container, tier) {
  container._paramsTier = tier;
  if (tier === 'strip-2' || tier === 'strip-3' || tier === 'strip-4') {
    _renderStrip(container, tier);
  } else if (tier === 'mini-box' || tier === 'compact') {
    // v6.5.5c: 2x2/2x3/3x2 复用条形 6 件布局(横竖自适应), 不再维护独立档
    _renderStrip(container, 'strip-6');
  } else if (tier === 'compact-wide') {
    _renderCompactWide(container);
  } else if (tier === 'compact-big') {
    // v6.5.6: 2x4/3x3 也走统一 6 件布局(与 2x2/2x3 同风格, 不再突变成表单)
    _renderStrip(container, 'strip-6');
  } else if (tier === 'wideshort') {
    _renderWideshort(container);
  } else {
    _renderWide(container);
  }
}

// ============================================================
// G: Dock 参数快调 —— 改 state+storage, 并 emit params:remoteChanged 让展开面板精准同步
// ============================================================
function _adjBatch(d) {
  var v = Math.max(1, Math.min(18, (+(TileAPI.state.get('params.batch')) || 1) + d));
  TileAPI.state.set('params.batch', v); TileAPI.storage.set('params.batch', v);
  TileAPI.emit('params:remoteChanged', { key: 'batch', value: v });
  if (TileAPI.toast) TileAPI.toast('张数: ' + v, 'info');
}
function _adjTimeout(d) {
  var v = Math.max(30, Math.min(3600, (+(TileAPI.state.get('params.timeout')) || 3600) + d));
  TileAPI.state.set('params.timeout', v); TileAPI.storage.set('params.timeout', v);
  TileAPI.emit('params:remoteChanged', { key: 'timeout', value: v });
  if (TileAPI.toast) TileAPI.toast('超时: ' + v + 's', 'info');
}
function _cycleSize(d) {
  var cfg = _getActiveConfig(); var model = TileAPI.state.get('params.model');
  var sizes = (cfg[model] && cfg[model].sizes) || ['1K', '2K', '4K'];
  var i = sizes.indexOf(TileAPI.state.get('params.size')); if (i < 0) i = 0;
  var v = sizes[(i + d + sizes.length) % sizes.length];
  TileAPI.state.set('params.size', v); TileAPI.storage.set('params.size', v);
  TileAPI.emit('params:remoteChanged', { key: 'size', value: v });
  if (TileAPI.toast) TileAPI.toast('分辨率: ' + v, 'info');
}
function _cycleModel(d) {
  var cfg = _getActiveConfig(); var keys = Object.keys(cfg); if (!keys.length) return;
  var i = keys.indexOf(TileAPI.state.get('params.model')); if (i < 0) i = 0;
  var v = keys[(i + d + keys.length) % keys.length];
  TileAPI.state.set('params.model', v); TileAPI.storage.set('params.model', v);
  TileAPI.emit('params:remoteChanged', { key: 'model', value: v });
  // 模型变了, 校正分辨率到该模型支持的值
  var sizes = (cfg[v] && cfg[v].sizes) || [];
  if (sizes.length && sizes.indexOf(TileAPI.state.get('params.size')) < 0) {
    var ns = cfg[v].default || sizes[0];
    TileAPI.state.set('params.size', ns); TileAPI.storage.set('params.size', ns);
    TileAPI.emit('params:remoteChanged', { key: 'size', value: ns });
  }
  if (TileAPI.toast) TileAPI.toast('模型: ' + ((cfg[v] && cfg[v].name) || v), 'info');
}
function _cycleAspect(d) {
  var i = ASPECT_RATIOS.indexOf(TileAPI.state.get('params.aspectRatio') || '1:1'); if (i < 0) i = 0;
  var v = ASPECT_RATIOS[(i + d + ASPECT_RATIOS.length) % ASPECT_RATIOS.length];
  TileAPI.state.set('params.aspectRatio', v); TileAPI.storage.set('params.aspectRatio', v);
  TileAPI.emit('params:remoteChanged', { key: 'aspectRatio', value: v });
  if (TileAPI.toast) TileAPI.toast('宽高比: ' + v, 'info');
}

// ============================================================
// Tile registration
// ============================================================
TileAPI.registerTile({
  id: 'params',
  group: 'main',
  icon: '\uD83C\uDFDB\uFE0F',
  label: '生成参数',
  desc: '模型\u00b7尺寸\u00b7批次',
  // G: 暴露给 Dock 的"参数步进器组"(糖葫芦: 名+值 / ＋ / －, 整组添加)
  steppers: [
    { id: 'batch', name: '张数', getValue: function() { return String(TileAPI.state.get('params.batch') || 1); }, inc: function() { _adjBatch(1); }, dec: function() { _adjBatch(-1); } },
    { id: 'size', name: '分辨率', getValue: function() { return TileAPI.state.get('params.size') || '2K'; }, inc: function() { _cycleSize(1); }, dec: function() { _cycleSize(-1); } },
    { id: 'model', name: '模型', getValue: function() { var c = _getActiveConfig(), m = TileAPI.state.get('params.model'); var n = (c[m] && c[m].name) || m || '-'; return String(n).replace(/^[^\w一-鿿]+/, '').trim(); }, inc: function() { _cycleModel(1); }, dec: function() { _cycleModel(-1); } },
    { id: 'aspect', name: '宽高比', getValue: function() { return TileAPI.state.get('params.aspectRatio') || '1:1'; }, inc: function() { _cycleAspect(1); }, dec: function() { _cycleAspect(-1); } }
  ],
  live: true,
  defaultSize: { w: 2, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderFront: renderFront,

  renderBack: function(container) {
    container.textContent = _getSummary();
  },

  onExpand: function(container, sizeHint) {
    try {
      // 追踪当前展开的面板容器，用于 provider 切换后重绘
      _activePanelContainer = container;
      _activePanelTier = null;

      // 就地展开(inline) → 走专用紧凑行布局,不受容器宽度影响
      if (container._isInline) {
        _activePanelTier = 'inline';
        _renderInlineRows(container);
        return function() { if (_activePanelContainer === container) { _activePanelContainer = null; _activePanelTier = null; } };
      }

      var w0 = (sizeHint && sizeHint.width) || container.clientWidth || 0;
      var h0 = (sizeHint && sizeHint.height) || container.clientHeight || 0;
      var tier = _classifyParamsTier(w0, h0);
      _activePanelTier = tier;
      _renderByTier(container, tier);

      // 本地 ResizeObserver:跨档位时重新渲染(引擎 layout 不变时不会触发)
      var lastTier = tier;
      var ro = null;
      if (window.ResizeObserver) {
        ro = new ResizeObserver(function() {
          var nt = _classifyParamsTier(container.clientWidth, container.clientHeight);
          if (nt !== lastTier) {
            lastTier = nt;
            _activePanelTier = nt;
            _renderByTier(container, nt);
          }
        });
        try { ro.observe(container); } catch(e) {}
      }
      return function() {
        if (ro) try { ro.disconnect(); } catch(e) {}
        if (_activePanelContainer === container) { _activePanelContainer = null; _activePanelTier = null; }
      };
    } catch (err) {
      console.error('[tile-params] onExpand error:', err);
      container.innerHTML = '<div style="color:red;padding:12px;">错误: ' + err.message + '</div>';
    }
  },

  onResize: function() { _refreshFront(); },

  onStorageLoaded: function(storage) {
    var restoredProvider = storage.get('params.provider') || storage.get('connection.provider') || 'aji';
    if (TileAPI.setProvider) TileAPI.setProvider(restoredProvider, { source: 'storage', silent: true });
    else TileAPI.state.set('params.provider', restoredProvider);
    TileAPI.state.set('params.model', storage.get('params.model') || storage.get('generate.model') || 'AJbanana3');
    TileAPI.state.set('params.size', storage.get('params.size') || storage.get('generate.size') || '2K');
    TileAPI.state.set('params.batch', storage.get('params.batch') || storage.get('generate.batchSize') || 1);
    TileAPI.state.set('params.timeout', storage.get('params.timeout') || storage.get('generate.timeout') || 3600);
    // #3: aspectRatio 必须在此显式无条件恢复 — 否则若正面在 storage 载入前渲染过,
    // _ensureDefaults 会先把它设成默认 '1:1', 这里不覆盖就会丢用户存的比例。
    TileAPI.state.set('params.aspectRatio', storage.get('params.aspectRatio') || storage.get('generate.aspectRatio') || '1:1');
    TileAPI.state.set('params.antiMode', storage.get('params.antiMode') || 0);

    // 校正默认(若存档里的 model 在 config 中不存在,回退到第一个可用项)
    _ensureDefaults();
    _refreshFront();

    // #3: 大磁贴(panel-mode)常驻展开, 可能在 storage 载入前就渲染过, 控件停留在默认值,
    // 而 _refreshFront 在 panel-mode 直接 return 不刷新展开内容。这里用恢复后的 state
    // 重渲一次当前展开的大磁贴面板, 让界面控件(模型/比例/分辨率/张数/超时/算力来源)回填成已存的值。
    if (_activePanelContainer && _activePanelTier && _activePanelTier !== 'inline') {
      try { _renderByTier(_activePanelContainer, _activePanelTier); } catch (_) {}
    }

    // 同步抗截断到后端（截图阶段靠后端全局 g_antiTruncationMode，否则会与回图不一致）
    TileAPI.sendToHost('updateSettings', { antiMode: storage.get('params.antiMode') || 0 });
  },
});

// 磁贴正面 / 背面与 state 保持同步
function _refreshFront() {
  if (!window.TileEngine) return;
  var el = TileEngine.getTileElement('params');
  if (!el) return;
  if (el.classList.contains('panel-mode')) return;   // 面板模式下正面被覆盖,不碰
  var inner = el.querySelector('.tile-inner:not(.folder-grid-inner)') || el.querySelector('.tile-flip-front');
  if (inner) renderFront(inner, +el.dataset.w || 1, +el.dataset.h || 1);
  var back = el.querySelector('.tile-flip-back');
  if (back) back.textContent = _getSummary();
}

['params.model', 'params.size', 'params.batch', 'params.aspectRatio', 'params.provider', 'params.timeout', 'params.antiMode'].forEach(function(path) {
  TileAPI.state.subscribe(path, _refreshFront);
});

// 持久化 算力来源/模型/比例/分辨率/张数/超时 全部 6 项 — set 时回写 storage, 重启后由 onStorageLoaded 读回。
// 之前 timeout/aspectRatio/provider 有的不在列表(改了重启即丢)。这里统一兜底, 任何一处 state.set 都会落盘。
// 滑块拖动是高频事件, 防抖 300ms 落盘, 避免高频写盘 + IPC 把后端淹没(IPC 洪泛可能丢掉最后一次写)。
var _paramPersistTimers = {};
['params.provider', 'params.model', 'params.aspectRatio', 'params.size', 'params.batch', 'params.timeout'].forEach(function(path) {
  TileAPI.state.subscribe(path, function(v) {
    if (_paramPersistTimers[path]) clearTimeout(_paramPersistTimers[path]);
    _paramPersistTimers[path] = setTimeout(function() {
      try { TileAPI.storage.set(path, v); } catch (_) {}
      _paramPersistTimers[path] = null;
    }, 300);
  });
});

// #I 双向同步: 外部(Dock / 卫星)改了 抗截断 / 渠道 时, 刷新本磁贴当前展开面板里对应控件,
// 让 Dock 与参数磁贴(各布局/就地展开/大磁贴)实时一致。仅在面板展开时(有 _activePanelContainer)生效。
function _syncAntiUI(mode) {
  var c = _activePanelContainer;
  if (!c) return;
  var all = c.querySelectorAll('[data-anti-mode]');
  for (var k = 0; k < all.length; k++) {
    var on = +all[k].dataset.antiMode === mode;
    all[k].classList.toggle('w10-btn-accent', on);
    all[k].classList.toggle('is-active', on);
  }
  var desc = c.querySelector('[data-anti-desc]');
  if (desc) desc.textContent = ANTI_DESCS[mode];
}
function _syncProviderUI(provider) {
  var c = _activePanelContainer;
  if (!c) return;
  if (c._isInline) {
    if (typeof _refreshInlineProviderUI === 'function') _refreshInlineProviderUI(c, provider);
  } else if (typeof _refreshProviderUISmart === 'function') {
    _refreshProviderUISmart(c, provider);
  }
}
TileAPI.on('params:antiModeChanged', function(d) {
  _syncAntiUI(d && typeof d.mode === 'number' ? d.mode : _currentAntiMode());
});
TileAPI.on('params:providerChanged', function(d) {
  _syncProviderUI((d && d.provider) ? d.provider : (TileAPI.state.get('params.provider') || 'aji'));
});

// 切「自带Key ↔ 夏三七托管」时, GRS 未改名的按钮标签(GRS/夏三七)要即时跟着换 (修 2026-07-04)
// byokPrefChanged = 本地开关瞬间; keyUpdated = 登录/登出/服务端确认后
function _syncLabelsOnComputeChange() {
  if (typeof _activePanelContainer !== 'undefined' && _activePanelContainer) {
    try { _syncProviderBtnLabels(_activePanelContainer); } catch (e) {}
  }
}
TileAPI.on('compute:byokPrefChanged', _syncLabelsOnComputeChange);
TileAPI.on('compute:keyUpdated', _syncLabelsOnComputeChange);

// 卫星插件改完参数后, 主插件展开面板里对应控件的视觉也要跟着更新.
// 之前用 _renderByTier 整段重渲会闪烁, 改用精准 patch — 只改对应控件的状态/选中值.
TileAPI.on('params:remoteChanged', function(data) {
  if (typeof _activePanelContainer === 'undefined' || !_activePanelContainer) return;
  if (!data || !data.key) return;
  var c = _activePanelContainer;
  var k = data.key;
  var v = data.value;
  try {
    // 1. select 类 (model/size/aspectRatio): 改 .value, UIKit 内部 MutationObserver 同步 trigger
    if (k === 'model') {
      var sel = c.querySelector('#paramModel');
      if (sel && sel.value !== v) sel.value = v;
    } else if (k === 'size') {
      var sel2 = c.querySelector('#paramSize');
      if (sel2 && sel2.value !== v) sel2.value = v;
    } else if (k === 'aspectRatio') {
      var sel3 = c.querySelector('#paramAspect');
      if (sel3 && sel3.value !== v) sel3.value = v;
    }
    // 2. batch / timeout 是 hidden input + 显示 span
    else if (k === 'batch') {
      var bIn = c.querySelector('#paramBatch');
      if (bIn) bIn.value = v;
      var bV = c.querySelector('#paramBatchVal');
      if (bV) bV.textContent = v;
    } else if (k === 'timeout') {
      var tIn = c.querySelector('#paramTimeout');
      if (tIn) tIn.value = v;
      var tV = c.querySelector('#paramTimeoutVal');
      if (tV) tV.textContent = v + 's';
    }
    // 3. provider / antiMode 是 button 高亮组
    else if (k === 'provider') {
      c.querySelectorAll('[data-prov]').forEach(function(btn) {
        var on = btn.dataset.prov === v;
        btn.classList.toggle('w10-btn-accent', on);
        btn.classList.toggle('is-active', on);
      });
      // provider 切了模型列表/尺寸都得换, 走主插件原有 inline 精准刷新
      try {
        if (c._isInline && typeof _refreshInlineProviderUI === 'function') _refreshInlineProviderUI(c, v);
      } catch (_) {}
    } else if (k === 'antiMode') {
      c.querySelectorAll('[data-anti-mode]').forEach(function(btn) {
        var on = +btn.dataset.antiMode === +v;
        btn.classList.toggle('w10-btn-accent', on);
        btn.classList.toggle('is-active', on);
      });
    }
  } catch (e) {}
});

// 设置里拉取/切换 Others 配置后,如果 params 磁贴展开着,重绘看到新模型
TileAPI.on('params:modelsFetched', function(data) {
  var curProvider = TileAPI.state.get('params.provider');
  if (curProvider !== 'others') return;
  // 选第一个模型作为默认
  var cfg = TileAPI.state.get('models.others') || {};
  var keys = Object.keys(cfg);
  if (keys.length) {
    var saved = TileAPI.storage.get('params.model');
    var target = (saved && cfg[saved]) ? saved : keys[0];
    TileAPI.state.set('params.model', target);
    TileAPI.storage.set('params.model', target);
    var defaultSize = cfg[target].default || cfg[target].sizes[0];
    TileAPI.state.set('params.size', defaultSize);
    TileAPI.storage.set('params.size', defaultSize);
  }
  _refreshFront();
  if (_activePanelContainer && _activePanelContainer.isConnected) {
    if (_activePanelTier === 'inline') {
      _renderInlineRows(_activePanelContainer);
    } else if (_activePanelTier) {
      _renderByTier(_activePanelContainer, _activePanelTier);
    }
  }
});

})();
