// ============================================================
//  tile-forge.js - SD WebUI Forge Tile
//  Connects to a local Forge server for img2img/txt2img generation
//  with LoRA, ControlNet, presets, and translation support.
// ============================================================
(function() {
'use strict';

// ========== 可折叠分组 (section 标题点击折叠/展开, 状态记忆 storage) ==========
// 折叠状态存 forge.collapsed = { 提示词:true, ... }; 默认: 高级/LoRA/ControlNet 折叠.
var _FORGE_COLLAPSE_DEFAULT = { '高级': true, 'LoRA': true, 'ControlNet': true };
function _forgeCollapsed(name) {
  var c = TileAPI.storage.get('forge.collapsed');
  if (c && Object.prototype.hasOwnProperty.call(c, name)) return !!c[name];
  return !!_FORGE_COLLAPSE_DEFAULT[name];
}
function _setForgeCollapsed(name, val) {
  var c = TileAPI.storage.get('forge.collapsed') || {};
  c[name] = !!val;
  TileAPI.storage.set('forge.collapsed', c);
}
// 包一组: 标题(可点折叠) + 内容容器. innerHtml 是该组的所有行.
function _forgeGroup(name, innerHtml) {
  var collapsed = _forgeCollapsed(name);
  return '' +
    '<div class="forge-group' + (collapsed ? ' is-collapsed' : '') + '" data-forge-group="' + name + '">' +
      '<div class="w10-section-title forge-group-head" data-forge-group-head="' + name + '">' +
        '<span class="forge-group-arrow">▾</span>' + name +
      '</div>' +
      '<div class="forge-group-body">' + innerHtml + '</div>' +
    '</div>';
}
// 绑定折叠交互 (renderXxx 之后调一次, 容器作用域)
function _bindForgeGroups(container) {
  var heads = container.querySelectorAll('[data-forge-group-head]');
  for (var i = 0; i < heads.length; i++) {
    heads[i].addEventListener('click', function() {
      var name = this.getAttribute('data-forge-group-head');
      var group = this.closest('.forge-group');
      if (!group) return;
      var nowCollapsed = !group.classList.contains('is-collapsed');
      group.classList.toggle('is-collapsed', nowCollapsed);
      _setForgeCollapsed(name, nowCollapsed);
    });
  }
}

// ========== Private helpers ==========

var _forgePresetsCache = [];
// 最后一次载入的 forge 预设 data,用于在 models/loras/controlnet 异步返回后重新应用 LoRA/CN 选择
// (_applyPreset 第一次跑时 select 还没填完,之前这些预设选择会被静默丢失)
var _lastAppliedPresetData = null;
var _translateResolve = null;
var _translateReject = null;

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _getUrl() {
  var url = TileAPI.state.get('forge.url') || '';
  if (url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

function _getTargetSize(fallbackResolution) {
  var targetLong = parseInt(fallbackResolution, 10) || 768;
  var sel = TileAPI.state.get('forge.selection');
  if (sel && sel.width > 0 && sel.height > 0) {
    var w = Math.max(1, Math.round(sel.width));
    var h = Math.max(1, Math.round(sel.height));
    var longEdge = Math.max(w, h);
    var scale = targetLong / longEdge;
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    return { width: w, height: h };
  }
  return { width: targetLong, height: targetLong };
}

function _selectOption(selectEl, targetVal) {
  if (!selectEl || !targetVal) return false;
  for (var i = 0; i < selectEl.options.length; i++) {
    if (selectEl.options[i].value === targetVal || selectEl.options[i].text === targetVal) {
      selectEl.selectedIndex = i;
      return true;
    }
  }
  var key = targetVal.split('.')[0];
  for (var j = 0; j < selectEl.options.length; j++) {
    if (selectEl.options[j].value.indexOf(key) !== -1 || selectEl.options[j].text.indexOf(key) !== -1) {
      selectEl.selectedIndex = j;
      return true;
    }
  }
  return false;
}

// 剥掉模型名末尾的 ` [xxx]` 哈希后缀,用于跨版本匹配老预设(bug ⑥)
function _stripModelHash(name) {
  if (!name) return '';
  return String(name).replace(/\s*\[[^\]]*\]\s*$/, '').trim();
}

// 模型专用 selectOption:支持忽略 ` [hash]` 后缀的匹配
function _selectModelOption(selectEl, targetVal) {
  if (!selectEl || !targetVal) return false;
  if (_selectOption(selectEl, targetVal)) return true;
  var base = _stripModelHash(targetVal);
  if (!base) return false;
  for (var i = 0; i < selectEl.options.length; i++) {
    var optBase = _stripModelHash(selectEl.options[i].value);
    if (optBase === base) { selectEl.selectedIndex = i; return true; }
    var txtBase = _stripModelHash(selectEl.options[i].text);
    if (txtBase === base) { selectEl.selectedIndex = i; return true; }
  }
  return false;
}

function _populateSelect(selectEl, items, labelFn, valueFn, placeholder) {
  if (!selectEl) return;
  selectEl.innerHTML = '';
  if (placeholder) {
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = placeholder;
    selectEl.appendChild(ph);
  }
  for (var i = 0; i < items.length; i++) {
    var opt = document.createElement('option');
    opt.value = valueFn(items[i]);
    opt.textContent = labelFn(items[i]);
    selectEl.appendChild(opt);
  }
}

// Preset categories
var FORGE_CATS = [
  {id:'head',name:'头部/面部'},{id:'hair',name:'头发'},{id:'neck',name:'颈部'},
  {id:'torso',name:'躯干/腰腹'},{id:'arms',name:'手臂'},{id:'hands',name:'手部'},
  {id:'legs',name:'腿部'},{id:'feet',name:'脚部'},{id:'clothing',name:'服装'},
  {id:'accessory',name:'配饰'},{id:'fullbody',name:'全身'},{id:'lighting',name:'光影'},
  {id:'background',name:'背景'},{id:'weapon',name:'武器'},{id:'cleanup',name:'去杂物'},
  {id:'effects',name:'特效'},{id:'other',name:'其他'}
];

var FORGE_CAT_LABELS = {};
FORGE_CATS.forEach(function(c) { FORGE_CAT_LABELS[c.id] = c.name; });

function _findPresetByName(name) {
  for (var i = 0; i < _forgePresetsCache.length; i++) {
    if (_forgePresetsCache[i].name === name) return _forgePresetsCache[i];
  }
  return null;
}

// ========== Tile Registration ==========

// Forge 专用 layout 分类(不复用 core 的 _calcLayout 通用分类):
// - 318×986 这种瘦高形态在通用分类里被归为 'square' 但 forge 的 square 布局只适合接近正方形
// - 改进:只要高 > 宽 * 1.3,直接用 narrow(单列纵向布局,含完整提示词/参数/LoRA/CN)
function _recalcForgeLayout(w, h) {
  if (w < 200) return 'narrow';
  if (w < 400 && h > w * 1.3) return 'narrow';   // 瘦高一律走 narrow,不走 square
  if (w >= 400 && w > h * 1.8) return 'wideshort';
  if (w < 400) return 'square';
  return 'wide';
}

TileAPI.registerTile({
  id: 'forge',
  group: 'main',
  icon: '\uD83C\uDFA8',
  label: 'Forge',
  desc: 'SD WebUI Forge',
  live: false,
  defaultSize: { w: 2, h: 2 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 999 },   // 纵向不限高: 999 行 ≈ 无限 (纵向网格可无限延伸)

  onExpand: function(container, sizeHint) {
    // Forge 用自己的 layout 分类(_recalcForgeLayout),不信任 sizeHint.layout
    // 原因:core/_calcLayout 把 200-400 宽的瘦高形态归为 square,但 forge 的 square 布局
    //      是为接近正方形设计的精简版,瘦高情况下应走 narrow 完整单列布局
    var hintW = (sizeHint && sizeHint.width) || 0;
    var hintH = (sizeHint && sizeHint.height) || 0;
    var realW = container.clientWidth || 0;
    var realH = container.clientHeight || 0;
    // 优先用 sizeHint 给的尺寸(已被引擎测量过),否则用容器实测,都没有时退化为 wide
    var w = hintW || realW;
    var h = hintH || realH;
    var layout = w > 0 ? _recalcForgeLayout(w, h) : 'wide';

    var cleanups = [];

    // ---------- Render ----------
    if (layout === 'narrow' || layout === 'tall') {
      _renderNarrow(container);
    } else if (layout === 'wideshort') {
      _renderWideShort(container);
    } else if (layout === 'square') {
      _renderSquare(container);
    } else {
      _renderWide(container);
    }

    // 首次打开容器还在 layout pending 时尺寸为 0 — 设个延迟二次校正
    setTimeout(function() {
      if (!_activeContainer || _activeContainer !== container) return;
      var w2 = container.clientWidth || 0;
      var h2 = container.clientHeight || 0;
      if (w2 === 0) return;
      var correctLayout = _recalcForgeLayout(w2, h2);
      if (correctLayout !== layout) {
        _triggerReRender(container, correctLayout);
      }
    }, 100);

    // ---------- Bind events ----------
    _bindCoreEvents(container);

    // ---------- Load saved values ----------
    _loadSavedValues(container);

    // ---------- Subscribe to host messages ----------
    var handlers = _subscribeHostMessages(container);
    cleanups.push(function() {
      for (var key in handlers) {
        // TileAPI.onHostMessage doesn't have off, we track via onMessage
      }
    });

    // ---------- Request presets ----------
    TileAPI.sendToHost('loadForgePresetsFile', {});

    // ---------- Auto-connect ----------
    var savedUrl = TileAPI.storage.get('forge.url');
    if (savedUrl && TileAPI.storage.get('forge.autoConnect') !== false) {
      TileAPI.state.set('forge.url', savedUrl);
      var urlInp = container.querySelector('#forgeUrl');
      if (urlInp) urlInp.value = savedUrl;
      TileAPI.sendToHost('forgeTestConnection', { url: savedUrl.replace(/\/$/, '') });
      var statusEl = container.querySelector('#forgeStatus');
      if (statusEl) {
        statusEl.textContent = '连接中...';
        statusEl.style.color = 'var(--text-sub)';
      }
    }

    // ---------- Cleanup ----------
    return function() {
      for (var i = 0; i < cleanups.length; i++) cleanups[i]();
      _activeContainer = null;
    };
  },

  onMessage: function(action, data) {
    _handleHostMessage(action, data);
  },

  onStorageLoaded: function(storage) {
    var url = storage.get('forge.url');
    if (url) TileAPI.state.set('forge.url', url);
    TileAPI.state.set('forge.connected', false);
    TileAPI.state.set('forge.running', false);
    // 恢复算力源选择(默认本地)
    var src = storage.get('forge.activeSource') || 'local';
    TileAPI.state.set('forge.activeSource', src);
  },
});

// ========== Layouts ==========

// ===== 算力源 helpers =====
function _getActiveSource() {
  return TileAPI.storage.get('forge.activeSource') || 'local';
}
function _isCloudReady() {
  return !!(window._cloudIsReady && window._cloudIsReady());
}
function _getCloudEncrypted() {
  return (window._cloudGetForgeEncrypted && window._cloudGetForgeEncrypted()) || '';
}
// 生成中禁止切源;读共享 state
function _isGenerating() {
  return !!TileAPI.state.get('forge.running');
}
// 统一拿当前源对应的 fetch 参数 (用于传给 host)
function _getSourceFetchParams() {
  if (_getActiveSource() === 'cloud') {
    var enc = _getCloudEncrypted();
    return enc ? { encrypted: enc } : null;
  }
  var u = (TileAPI.storage.get('forge.url') || '').replace(/\/$/, '');
  return u ? { url: u } : null;
}

// 切换算力源:清状态 + 重拉资源 + 广播
function _switchSource(newSrc) {
  if (newSrc !== 'local' && newSrc !== 'cloud') return;
  TileAPI.storage.set('forge.activeSource', newSrc);
  TileAPI.state.set('forge.activeSource', newSrc);

  // 切源 → 清掉旧的资源缓存(决策:不缓存,每次重拉)
  TileAPI.state.set('forge.models', []);
  TileAPI.state.set('forge.samplers', []);
  TileAPI.state.set('forge.cnModules', []);
  TileAPI.state.set('forge.cnModels', []);
  TileAPI.state.set('forge.loras', []);

  TileAPI.emit('forge:sourceChanged', { source: newSrc });

  // 重绘面板(包括源开关状态 + 隐藏/显示 URL 输入栏)
  if (_activeContainer) {
    // 用容器实际尺寸 + forge 自己的分类算 layout,不读 _layoutType
    // (_layoutType 被 core 引擎覆盖,可能是 core _calcLayout 给的不准确分类)
    var w = _activeContainer.clientWidth || 0;
    var h = _activeContainer.clientHeight || 0;
    var layout = w > 0 ? _recalcForgeLayout(w, h) : 'wide';
    _triggerReRender(_activeContainer, layout);
  }

  // 拉取新源的资源
  _fetchResourcesForCurrentSource();
}

// 根据当前源拉 models/samplers/lora/cn
function _fetchResourcesForCurrentSource() {
  var params = _getSourceFetchParams();
  if (!params) {
    // 云源但未登录/未查积分 → 不发请求,toast 警告
    if (_getActiveSource() === 'cloud') {
      TileAPI.toast('云 Forge 不可用:请先登录并等待积分查询', 'error');
    } else {
      TileAPI.toast('本地 Forge 未设置 URL', 'error');
    }
    return;
  }
  TileAPI.sendToHost('forgeFetchModels', params);
  TileAPI.sendToHost('forgeFetchSamplers', params);
  TileAPI.sendToHost('forgeFetchControlNetModules', params);
  TileAPI.sendToHost('forgeFetchControlNetModels', params);
  TileAPI.sendToHost('forgeFetchLoras', params);
}

function _triggerReRender(container, layout) {
  if (!container) return;
  // 清旧 cleanup
  var def = TileAPI.getTileDef && TileAPI.getTileDef('forge');
  if (def && def._inlineCleanup) { try { def._inlineCleanup(); } catch(e) {} def._inlineCleanup = null; }
  if (def && def._panelCleanup) { try { def._panelCleanup(); } catch(e) {} def._panelCleanup = null; }
  if (layout === 'narrow' || layout === 'tall') _renderNarrow(container);
  else if (layout === 'wideshort') _renderWideShort(container);
  else if (layout === 'square') _renderSquare(container);
  else _renderWide(container);
  _bindCoreEvents(container);
  _loadSavedValues(container);
  _subscribeHostMessages(container);
}

function _renderSourceBar() {
  var src = _getActiveSource();
  var cloudReady = _isCloudReady();
  var cloudPoints = (window._cloudGetPoints && window._cloudGetPoints()) || 0;
  var cloudStatusHtml = '';
  if (src === 'cloud') {
    if (cloudReady) {
      cloudStatusHtml = '<span class="forge-source-status forge-source-status-ok">✓ 云 Forge · ' + cloudPoints + ' 积分</span>';
    } else if (window._cloudIsLoggedIn && window._cloudIsLoggedIn()) {
      cloudStatusHtml = '<span class="forge-source-status forge-source-status-warn">⚠ 云服务积分查询中</span>';
    } else {
      cloudStatusHtml = '<span class="forge-source-status forge-source-status-warn">⚠ 未登录云服务</span>';
    }
  }
  var disabled = _isGenerating() ? ' disabled' : '';
  return '' +
    '<div class="forge-source-bar">' +
      '<span class="forge-source-label">算力源</span>' +
      '<div class="forge-source-toggle">' +
        '<button class="forge-source-btn' + (src === 'local' ? ' active' : '') + '" data-source="local"' + disabled + '>本地</button>' +
        '<button class="forge-source-btn' + (src === 'cloud' ? ' active' : '') + '" data-source="cloud"' + disabled + '>云</button>' +
      '</div>' +
      cloudStatusHtml +
    '</div>';
}

function _renderConnectionBar() {
  var url = TileAPI.storage.get('forge.url') || 'http://127.0.0.1:7860';
  // 云源模式:隐藏本地连接栏(URL 用户看不到,按钮无意义)
  if (_getActiveSource() === 'cloud') {
    return '';
  }
  return '' +
    '<div class="forge-connection-bar">' +
      '<input class="w10-input forge-url-input" id="forgeUrl" placeholder="http://127.0.0.1:7860" value="' + _esc(url) + '">' +
      '<button class="w10-btn w10-btn-accent" id="forgeConnectBtn">连接</button>' +
      '<span class="forge-status" id="forgeStatus">--</span>' +
    '</div>';
}

function _renderPromptSection() {
  var posPrompt = TileAPI.storage.get('forge.positivePrompt') || '';
  var negPrompt = TileAPI.storage.get('forge.negativePrompt') || '';
  return _forgeGroup('提示词', '' +
    '<div class="w10-row" style="flex-direction:column;align-items:stretch;">' +
      '<textarea class="w10-input forge-textarea" id="forgePositivePrompt" placeholder="输入正向提示词..." rows="3">' + _esc(posPrompt) + '</textarea>' +
    '</div>' +
    '<div class="w10-row" style="flex-direction:column;align-items:stretch;">' +
      '<textarea class="w10-input forge-textarea" id="forgeNegativePrompt" placeholder="输入负向提示词..." rows="2">' + _esc(negPrompt) + '</textarea>' +
    '</div>');
}

function _renderParamsSection() {
  var steps = TileAPI.storage.get('forge.steps') || 20;
  var cfg = TileAPI.storage.get('forge.cfg') || 7;
  var denoise = TileAPI.storage.get('forge.denoise') || 0.75;
  var resolution = TileAPI.storage.get('forge.resolution') || 768;
  var seed = TileAPI.storage.get('forge.seed') || -1;
  var batchSize = TileAPI.storage.get('forge.batchSize') || 1;
  // 参数组(核心): 模型/步数/降噪/分辨率
  var core = '' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">模型</div></div>' +
      '<div class="w10-row-right" style="flex:1;max-width:260px;"><select class="w10-select" id="forgeModel"><option value="">-- 选择模型 --</option></select></div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">步数</div></div>' +
      '<div class="w10-row-right"><div class="w10-slider"><input type="range" id="forgeSteps" min="1" max="100" value="' + steps + '"><span class="w10-slider-val" id="forgeStepsVal">' + steps + '</span></div></div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">降噪强度</div></div>' +
      '<div class="w10-row-right"><div class="w10-slider"><input type="range" id="forgeDenoise" min="0" max="1" step="0.01" value="' + denoise + '"><span class="w10-slider-val" id="forgeDenoiseVal">' + denoise + '</span></div></div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">分辨率</div></div>' +
      '<div class="w10-row-right"><div class="w10-slider"><input type="range" id="forgeResolution" min="256" max="2048" step="64" value="' + resolution + '"><span class="w10-slider-val" id="forgeResolutionVal">' + resolution + '</span></div></div>' +
    '</div>';
  // 高级组: 采样器/CFG/种子/批次
  var adv = '' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">采样器</div></div>' +
      '<div class="w10-row-right" style="flex:1;max-width:200px;"><select class="w10-select" id="forgeSampler"><option>Euler a</option></select></div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">CFG 系数</div></div>' +
      '<div class="w10-row-right"><div class="w10-slider"><input type="range" id="forgeCfg" min="1" max="30" step="0.5" value="' + cfg + '"><span class="w10-slider-val" id="forgeCfgVal">' + cfg + '</span></div></div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">种子</div></div>' +
      '<div class="w10-row-right" style="max-width:120px;"><input class="w10-input" id="forgeSeed" type="number" value="' + seed + '"></div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">批次数量</div></div>' +
      '<div class="w10-row-right" style="max-width:80px;"><input class="w10-input" id="forgeBatchSize" type="number" min="1" max="8" value="' + batchSize + '"></div>' +
    '</div>';
  return _forgeGroup('参数', core) + _forgeGroup('高级', adv);
}

function _renderLoraSection() {
  var html = '';
  for (var i = 0; i < 5; i++) {
    var display = i === 0 ? '' : ' style="display:none;"';
    html +=
      '<div class="forge-lora-row" id="forgeLoraRow' + i + '"' + display + '>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">LoRA ' + (i + 1) + '</div></div>' +
          '<div class="w10-row-right" style="flex:1;display:flex;gap:6px;align-items:center;">' +
            '<select class="w10-select" id="forgeLora' + i + '" style="flex:1;"><option value="">无</option></select>' +
            '<div class="w10-slider" style="min-width:100px;" title="权重"><input type="range" id="forgeLoraWeight' + i + '" min="0" max="2" step="0.05" value="1"><span class="w10-slider-val" id="forgeLoraWeightVal' + i + '">1</span></div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }
  html += '<div class="w10-row"><div class="w10-row-right"><button class="w10-btn" id="forgeAddLora">+ LoRA</button><button class="w10-btn" id="forgeFetchLorasBtn">刷新 LoRA</button></div></div>';
  return _forgeGroup('LoRA', html);
}

function _renderControlNetSection() {
  var html = '';
  for (var i = 0; i < 3; i++) {
    var display = i === 0 ? '' : ' style="display:none;"';
    html +=
      '<div class="forge-cn-card" id="forgeCnCard' + i + '"' + display + '>' +
        '<div class="forge-cn-card-title">ControlNet ' + (i + 1) + '</div>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">预处理器</div></div>' +
          '<div class="w10-row-right" style="flex:1;max-width:200px;"><select class="w10-select" id="forgeCnModule' + i + '"><option value="none">无</option></select></div>' +
        '</div>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">模型</div></div>' +
          '<div class="w10-row-right" style="flex:1;max-width:200px;"><select class="w10-select" id="forgeCnModel' + i + '"><option value="None">无</option></select></div>' +
        '</div>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">权重</div></div>' +
          '<div class="w10-row-right"><div class="w10-slider"><input type="range" id="forgeCnWeight' + i + '" min="0" max="2" step="0.05" value="1"><span class="w10-slider-val" id="forgeCnWeightVal' + i + '">1</span></div></div>' +
        '</div>' +
      '</div>';
  }
  html += '<div class="w10-row"><div class="w10-row-right"><button class="w10-btn" id="forgeAddCn">+ ControlNet</button></div></div>';
  return _forgeGroup('ControlNet', html);
}

function _renderTranslateSection() {
  return '' +
    '<div class="forge-translate-bar">' +
      '<input class="w10-input" id="forgeTranslateInput" placeholder="输入要翻译的中文...">' +
      '<button class="w10-btn" id="forgeTranslateBtn" title="翻译（有道）">翻译</button>' +
      '<button class="w10-btn" id="forgeAddPosBtn" title="追加到正向提示词">+正向</button>' +
      '<button class="w10-btn" id="forgeAddNegBtn" title="追加到负向提示词">+负向</button>' +
    '</div>';
}

function _renderPresetBar() {
  return '' +
    '<div class="forge-preset-bar">' +
      '<select class="w10-select" id="forgePresetSelect" style="flex:1;"><option value="">预设 (0)</option></select>' +
      '<button class="w10-btn" id="forgeSavePresetBtn" title="保存当前参数为预设">保存</button>' +
      '<button class="w10-btn" id="forgeRefreshPresetsBtn" title="刷新预设列表">刷新</button>' +
      '<button class="w10-btn" id="forgeOpenFolderBtn" title="打开预设文件夹">打开文件夹</button>' +
    '</div>';
}

function _renderActionBar() {
  return '' +
    '<div class="forge-action-bar">' +
      '<button class="w10-btn w10-btn-accent forge-generate-btn" id="forgeGenerateBtn">Forge img2img 生成</button>' +
    '</div>';
}

// --- Wide layout (default, w>=2 h>=2) ---
function _renderWide(container) {
  container.innerHTML =
    '<div class="w10-panel forge-panel forge-layout-wide">' +
      _renderSourceBar() +
      _renderConnectionBar() +
      _renderPresetBar() +
      _renderPromptSection() +
      _renderTranslateSection() +
      _renderParamsSection() +
      _renderLoraSection() +
      _renderControlNetSection() +
      _renderActionBar() +
    '</div>';
}

// --- Narrow/Tall layout (w=1) ---
function _renderNarrow(container) {
  container.innerHTML =
    '<div class="w10-panel forge-panel forge-layout-narrow">' +
      _renderSourceBar() +
      _renderConnectionBar() +
      _renderPresetBar() +
      _renderPromptSection() +
      _renderParamsSection() +
      _renderLoraSection() +
      _renderControlNetSection() +
      _renderTranslateSection() +
      _renderActionBar() +
    '</div>';
}

// --- Square layout ---
function _renderSquare(container) {
  container.innerHTML =
    '<div class="w10-panel forge-panel forge-layout-square">' +
      _renderSourceBar() +
      _renderConnectionBar() +
      _renderPresetBar() +
      '<div class="forge-square-grid">' +
        '<div class="forge-square-left">' +
          '<textarea class="w10-input forge-textarea" id="forgePositivePrompt" placeholder="输入正向提示词..." rows="2">' + _esc(TileAPI.storage.get('forge.positivePrompt') || '') + '</textarea>' +
          '<textarea class="w10-input forge-textarea" id="forgeNegativePrompt" placeholder="输入负向提示词..." rows="1">' + _esc(TileAPI.storage.get('forge.negativePrompt') || '') + '</textarea>' +
        '</div>' +
        '<div class="forge-square-right">' +
          '<select class="w10-select" id="forgeModel"><option value="">-- 选择模型 --</option></select>' +
          '<select class="w10-select" id="forgeSampler"><option>Euler a</option></select>' +
          '<div class="w10-slider"><input type="range" id="forgeSteps" min="1" max="100" value="' + (TileAPI.storage.get('forge.steps') || 20) + '"><span class="w10-slider-val" id="forgeStepsVal">' + (TileAPI.storage.get('forge.steps') || 20) + '</span></div>' +
          '<div class="w10-slider"><input type="range" id="forgeDenoise" min="0" max="1" step="0.01" value="' + (TileAPI.storage.get('forge.denoise') || 0.75) + '"><span class="w10-slider-val" id="forgeDenoiseVal">' + (TileAPI.storage.get('forge.denoise') || 0.75) + '</span></div>' +
        '</div>' +
      '</div>' +
      // 展示 square 原本隐藏的 4 个参数,放一行小输入框
      '<div class="forge-extra-row">' +
        '<label>分辨率<input class="w10-input forge-extra-num" id="forgeResolution" type="number" min="256" max="2048" step="64" value="' + (TileAPI.storage.get('forge.resolution') || 768) + '"></label>' +
        '<label>批次<input class="w10-input forge-extra-num" id="forgeBatchSize" type="number" min="1" max="8" value="' + (TileAPI.storage.get('forge.batchSize') || 1) + '"></label>' +
        '<label>CFG<input class="w10-input forge-extra-num" id="forgeCfg" type="number" min="1" max="20" step="0.5" value="' + (TileAPI.storage.get('forge.cfg') || 7) + '"></label>' +
        '<label>种子<input class="w10-input forge-extra-num" id="forgeSeed" type="number" value="' + (TileAPI.storage.get('forge.seed') || -1) + '"></label>' +
      '</div>' +
      // square 布局精简掉了 LoRA/ControlNet/翻译等。给个"显示更多设置"按钮切到完整 narrow 布局
      '<div class="w10-row" style="margin-top:6px;">' +
        '<div class="w10-row-right" style="width:100%;">' +
          '<button class="w10-btn" id="forgeShowMoreBtn" style="width:100%;">显示更多设置 (LoRA / ControlNet / 翻译)</button>' +
        '</div>' +
      '</div>' +
      _renderActionBar() +
    '</div>';
}

// --- WideShort layout (w>=3, h=1) ---
function _renderWideShort(container) {
  var src = _getActiveSource();
  var urlInputHtml = (src === 'local')
    ? '<input class="w10-input forge-url-input" id="forgeUrl" placeholder="http://127.0.0.1:7860" value="' + _esc(TileAPI.storage.get('forge.url') || 'http://127.0.0.1:7860') + '" style="max-width:200px;">' +
      '<button class="w10-btn w10-btn-accent" id="forgeConnectBtn">连接</button>'
    : '';
  var disabled = _isGenerating() ? ' disabled' : '';
  container.innerHTML =
    '<div class="w10-panel forge-panel forge-layout-wideshort">' +
      '<div class="forge-wideshort-strip">' +
        '<div class="forge-source-toggle forge-source-toggle-mini">' +
          '<button class="forge-source-btn' + (src === 'local' ? ' active' : '') + '" data-source="local"' + disabled + '>本地</button>' +
          '<button class="forge-source-btn' + (src === 'cloud' ? ' active' : '') + '" data-source="cloud"' + disabled + '>云</button>' +
        '</div>' +
        urlInputHtml +
        '<span class="forge-status" id="forgeStatus">--</span>' +
        '<select class="w10-select" id="forgePresetSelect" style="max-width:180px;"><option value="">预设</option></select>' +
        '<button class="w10-btn w10-btn-accent forge-generate-btn" id="forgeGenerateBtn">生成</button>' +
      '</div>' +
      // Hidden fields for params (use saved values)
      '<input id="forgePositivePrompt" type="hidden" value="' + _esc(TileAPI.storage.get('forge.positivePrompt') || '') + '">' +
      '<input id="forgeNegativePrompt" type="hidden" value="' + _esc(TileAPI.storage.get('forge.negativePrompt') || '') + '">' +
      '<input id="forgeModel" type="hidden" value="">' +
      '<input id="forgeSampler" type="hidden" value="">' +
      '<input id="forgeSteps" type="hidden" value="' + (TileAPI.storage.get('forge.steps') || 20) + '">' +
      '<input id="forgeCfg" type="hidden" value="' + (TileAPI.storage.get('forge.cfg') || 7) + '">' +
      '<input id="forgeDenoise" type="hidden" value="' + (TileAPI.storage.get('forge.denoise') || 0.75) + '">' +
      '<input id="forgeResolution" type="hidden" value="' + (TileAPI.storage.get('forge.resolution') || 768) + '">' +
      '<input id="forgeSeed" type="hidden" value="' + (TileAPI.storage.get('forge.seed') || -1) + '">' +
      '<input id="forgeBatchSize" type="hidden" value="' + (TileAPI.storage.get('forge.batchSize') || 1) + '">' +
    '</div>';
}

// ========== Event Binding ==========

function _bindCoreEvents(container) {
  // 可折叠分组: 标题点击折叠/展开
  _bindForgeGroups(container);
  // --- 算力源切换 ---
  var srcBtns = container.querySelectorAll('.forge-source-btn');
  for (var si = 0; si < srcBtns.length; si++) {
    srcBtns[si].addEventListener('click', function(e) {
      e.stopPropagation();
      var target = this.getAttribute('data-source');
      if (_isGenerating()) {
        TileAPI.toast('生成中不可切换算力源', 'info');
        return;
      }
      if (target === _getActiveSource()) return;  // 已是当前源
      _switchSource(target);
    });
  }

  // --- Connection ---
  var connectBtn = container.querySelector('#forgeConnectBtn');
  if (connectBtn) connectBtn.addEventListener('click', function() {
    var urlInp = container.querySelector('#forgeUrl');
    var url = urlInp ? urlInp.value.trim().replace(/\/$/, '') : '';
    if (!url) { TileAPI.toast('请输入 Forge 地址', 'error'); return; }
    TileAPI.state.set('forge.url', url);
    TileAPI.storage.set('forge.url', url);
    var statusEl = container.querySelector('#forgeStatus');
    if (statusEl) { statusEl.textContent = '连接中...'; statusEl.style.color = 'var(--text-sub)'; }
    TileAPI.state.set('forge.userInitiatedConnect', true);
    TileAPI.sendToHost('forgeTestConnection', { url: url });
  });

  // --- URL persistence ---
  var urlInp = container.querySelector('#forgeUrl');
  if (urlInp) urlInp.addEventListener('change', function() {
    TileAPI.storage.set('forge.url', urlInp.value.trim());
    TileAPI.state.set('forge.url', urlInp.value.trim());
  });

  // --- Generate / Interrupt ---
  var genBtn = container.querySelector('#forgeGenerateBtn');
  if (genBtn) genBtn.addEventListener('click', function() {
    if (TileAPI.state.get('forge.running')) {
      // bug: host 侧原来从 hostStorage['forge_url'] 取地址(该键不存在), 服务器端采样中断不了。
      //   这里把当前算力源的路由参数({url} 或 {encrypted})一起传给 host, 让它能命中正确的服务器。
      TileAPI.sendToHost('forgeInterrupt', _getSourceFetchParams() || {});
      genBtn.textContent = '中断中...';
      return;
    }

    // 算力源路由 + 前置检查
    var sourceParams = _getSourceFetchParams();
    if (!sourceParams) {
      if (_getActiveSource() === 'cloud') {
        TileAPI.toast('云 Forge 不可用:请先登录并等待积分查询', 'error');
      } else {
        TileAPI.toast('请先在本地栏输入 Forge URL 并连接', 'error');
      }
      return;
    }
    // 云源额外检查:积分必须 > 0
    if (_getActiveSource() === 'cloud') {
      var pts = (window._cloudGetPoints && window._cloudGetPoints()) || 0;
      if (pts <= 0) {
        TileAPI.toast('云服务积分为 0,无法生成,请充值', 'error');
        return;
      }
    }

    // Gather LoRA string
    var posPromptEl = container.querySelector('#forgePositivePrompt');
    var effectivePrompt = posPromptEl ? (posPromptEl.value || posPromptEl.textContent || '') : (TileAPI.storage.get('forge.positivePrompt') || '');

    // Append LoRAs to prompt
    for (var li = 0; li < 5; li++) {
      var loraEl = container.querySelector('#forgeLora' + li);
      var loraWEl = container.querySelector('#forgeLoraWeight' + li);
      if (loraEl && loraEl.value) {
        var lw = loraWEl ? parseFloat(loraWEl.value) || 1 : 1;
        effectivePrompt += ' <lora:' + loraEl.value + ':' + lw + '>';
      }
    }

    // ControlNet units
    var cnUnits = [];
    for (var ci = 0; ci < 3; ci++) {
      var cnModuleEl = container.querySelector('#forgeCnModule' + ci);
      var cnModelEl = container.querySelector('#forgeCnModel' + ci);
      var cnWeightEl = container.querySelector('#forgeCnWeight' + ci);
      if (cnModelEl && cnModelEl.value && cnModelEl.value.toLowerCase() !== 'none') {
        cnUnits.push({
          module: cnModuleEl ? cnModuleEl.value : 'none',
          model: cnModelEl.value,
          weight: cnWeightEl ? parseFloat(cnWeightEl.value) || 1 : 1
        });
      }
    }

    var negPromptEl = container.querySelector('#forgeNegativePrompt');
    var stepsEl = container.querySelector('#forgeSteps');
    var cfgEl = container.querySelector('#forgeCfg');
    var denoiseEl = container.querySelector('#forgeDenoise');
    var resEl = container.querySelector('#forgeResolution');
    var samplerEl = container.querySelector('#forgeSampler');
    var modelEl = container.querySelector('#forgeModel');
    var batchEl = container.querySelector('#forgeBatchSize');
    var seedEl = container.querySelector('#forgeSeed');

    var forgeRes = resEl ? resEl.value : (TileAPI.storage.get('forge.resolution') || 768);
    var targetSize = _getTargetSize(forgeRes);

    var cnEnabled = cnUnits.length > 0;
    var cnModule = cnUnits.length > 0 ? cnUnits[0].module : 'none';
    var cnModel = cnUnits.length > 0 ? cnUnits[0].model : 'None';
    var cnWeight = cnUnits.length > 0 ? cnUnits[0].weight : 1;

    TileAPI.state.set('forge.running', true);
    _updateRunningUI(container, true);

    var taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

    // 把 {url:...} 或 {encrypted:...} 注入 payload(host 会用 resolveForgeUrl 解析)
    var payload = {
      taskId: taskId,
      prompt: effectivePrompt,
      negPrompt: negPromptEl ? negPromptEl.value : (TileAPI.storage.get('forge.negativePrompt') || ''),
      steps: parseInt(stepsEl ? stepsEl.value : TileAPI.storage.get('forge.steps')) || 20,
      cfg: parseFloat(cfgEl ? cfgEl.value : TileAPI.storage.get('forge.cfg')) || 7,
      denoise: parseFloat(denoiseEl ? denoiseEl.value : TileAPI.storage.get('forge.denoise')) || 0.75,
      resolution: forgeRes,
      width: targetSize.width,
      height: targetSize.height,
      sampler: samplerEl ? samplerEl.value : 'Euler a',
      model: modelEl ? modelEl.value : '',
      batchSize: parseInt(batchEl ? batchEl.value : TileAPI.storage.get('forge.batchSize')) || 1,
      seed: parseInt(seedEl ? seedEl.value : TileAPI.storage.get('forge.seed')) || -1,
      cnEnabled: cnEnabled,
      cnModule: cnModule,
      cnModel: cnModel,
      cnWeight: cnWeight,
      presetTitle: TileAPI.state.get('prompt.lastPresetTitle') || ''   // 缓存文件夹命名用
    };
    // 注入源路由参数
    if (sourceParams.encrypted) payload.encrypted = sourceParams.encrypted;
    if (sourceParams.url) payload.url = sourceParams.url;
    payload.source = _getActiveSource();
    // 云端走扣分通道(cloudForgeImg2Img 先扣分再生成,errno:4 时拦死 0 积分)
    // 本地直发 forgeImg2Img(不扣分)
    if (payload.source === 'cloud') {
      TileAPI.sendToHost('cloudForgeImg2Img', payload);
    } else {
      TileAPI.sendToHost('forgeImg2Img', payload);
    }

    // 写入统一任务池 (engine:'forge' 让任务磁贴/历史磁贴识别)
    var presetTitle = TileAPI.state.get('prompt.lastPresetTitle') || '';
    var promptSnippet = (effectivePrompt || '').replace(/\s+/g, ' ').trim().substring(0, 30);
    var running = TileAPI.state.get('tasks.running') || {};
    running[taskId] = {
      engine: 'forge',
      batchSize: payload.batchSize,
      resolution: forgeRes,
      width: payload.width,
      height: payload.height,
      startTime: Date.now(),
      success: 0, fail: 0, total: 0,
      model: payload.model,
      presetTitle: presetTitle,
      promptSnippet: promptSnippet,
      thumbnail: null,
      docId: null,
      selection: null,
    };
    TileAPI.state.set('tasks.running', running);

    var meta = TileAPI.state.get('tasks.meta') || {};
    meta[taskId] = {
      countdown: 3600, timeoutSec: 3600,
      autoReturn: (TileAPI.storage.get('output.autoReturn') !== false),
      batchSize: payload.batchSize,
      engine: 'forge'
    };
    TileAPI.state.set('tasks.meta', meta);

    TileAPI.emit('tasks:updated');
    TileAPI.emit('task:started', { taskId: taskId, timeoutSec: 3600, batchSize: payload.batchSize });
    TileAPI.emit('generate:started', { taskId: taskId, engine: 'forge', model: payload.model, batch: payload.batchSize });
  });

  // --- Slider binding ---
  _bindSlider(container, 'forgeSteps', 'forgeStepsVal', 'forge.steps');
  _bindSlider(container, 'forgeCfg', 'forgeCfgVal', 'forge.cfg');
  _bindSlider(container, 'forgeDenoise', 'forgeDenoiseVal', 'forge.denoise');
  _bindSlider(container, 'forgeResolution', 'forgeResolutionVal', 'forge.resolution');

  // LoRA weight sliders
  for (var i = 0; i < 5; i++) {
    _bindSlider(container, 'forgeLoraWeight' + i, 'forgeLoraWeightVal' + i, null);
  }
  // CN weight sliders
  for (var ci = 0; ci < 3; ci++) {
    _bindSlider(container, 'forgeCnWeight' + ci, 'forgeCnWeightVal' + ci, null);
  }

  // --- Prompt persistence ---
  var posEl = container.querySelector('#forgePositivePrompt');
  if (posEl) posEl.addEventListener('input', function() {
    TileAPI.storage.set('forge.positivePrompt', posEl.value);
    TileAPI.state.set('forge.positivePrompt', posEl.value);
    // 若当前正在用的是 forge 预设,同步到提示词磁贴
    if (TileAPI.state.get('prompt.lastPresetKind') === 'forge') {
      TileAPI.state.set('prompt.text', posEl.value);
      TileAPI.storage.set('prompt.lastText', posEl.value);
      TileAPI.emit('forge:syncToPrompt', { positivePrompt: posEl.value });
    }
  });
  var negEl = container.querySelector('#forgeNegativePrompt');
  if (negEl) negEl.addEventListener('input', function() {
    TileAPI.storage.set('forge.negativePrompt', negEl.value);
    TileAPI.state.set('forge.negativePrompt', negEl.value);
    // 负向也同步到 meta,顶栏副文会跟着更新
    if (TileAPI.state.get('prompt.lastPresetKind') === 'forge') {
      var meta = TileAPI.state.get('prompt.lastPresetMeta') || {};
      meta.negativePrompt = negEl.value;
      TileAPI.state.set('prompt.lastPresetMeta', meta);
    }
  });

  // --- Other field persistence ---
  _bindFieldPersist(container, 'forgeModel', 'forge.model');
  _bindFieldPersist(container, 'forgeSampler', 'forge.sampler');
  _bindFieldPersist(container, 'forgeSeed', 'forge.seed');
  _bindFieldPersist(container, 'forgeBatchSize', 'forge.batchSize');

  // --- Show more (square) → 切到完整 narrow 布局,显示 LoRA/ControlNet/翻译 ---
  var showMoreBtn = container.querySelector('#forgeShowMoreBtn');
  if (showMoreBtn) showMoreBtn.addEventListener('click', function() {
    _triggerReRender(container, 'narrow');
  });

  // --- Add LoRA / ControlNet rows ---
  var addLoraBtn = container.querySelector('#forgeAddLora');
  if (addLoraBtn) addLoraBtn.addEventListener('click', function() {
    for (var i = 1; i < 5; i++) {
      var row = container.querySelector('#forgeLoraRow' + i);
      if (row && row.style.display === 'none') { row.style.display = ''; break; }
    }
  });
  var addCnBtn = container.querySelector('#forgeAddCn');
  if (addCnBtn) addCnBtn.addEventListener('click', function() {
    for (var i = 1; i < 3; i++) {
      var card = container.querySelector('#forgeCnCard' + i);
      if (card && card.style.display === 'none') { card.style.display = ''; break; }
    }
  });

  // --- Fetch LoRAs ---
  var fetchLorasBtn = container.querySelector('#forgeFetchLorasBtn');
  if (fetchLorasBtn) fetchLorasBtn.addEventListener('click', function() {
    var url = _getUrl();
    if (!url) { TileAPI.toast('请先连接 Forge', 'error'); return; }
    TileAPI.sendToHost('forgeFetchLoras', { url: url });
  });

  // --- Translate ---
  var translateBtn = container.querySelector('#forgeTranslateBtn');
  if (translateBtn) translateBtn.addEventListener('click', function() {
    _doTranslate(container, null);
  });
  var addPosBtn = container.querySelector('#forgeAddPosBtn');
  if (addPosBtn) addPosBtn.addEventListener('click', function() {
    _doTranslate(container, 'positive');
  });
  var addNegBtn = container.querySelector('#forgeAddNegBtn');
  if (addNegBtn) addNegBtn.addEventListener('click', function() {
    _doTranslate(container, 'negative');
  });

  // --- Preset selector ---
  var presetSel = container.querySelector('#forgePresetSelect');
  if (presetSel) presetSel.addEventListener('change', function() {
    var name = presetSel.value;
    if (!name) return;
    var fp = _findPresetByName(name);
    if (!fp || !fp.data) return;
    _applyPreset(container, fp);
  });

  // --- Save Preset ---
  var savePresetBtn = container.querySelector('#forgeSavePresetBtn');
  if (savePresetBtn) savePresetBtn.addEventListener('click', function() {
    _showSavePresetDialog(container);
  });

  // --- Refresh presets ---
  var refreshPresetsBtn = container.querySelector('#forgeRefreshPresetsBtn');
  if (refreshPresetsBtn) refreshPresetsBtn.addEventListener('click', function() {
    TileAPI.sendToHost('refreshForgePresets', {});
    TileAPI.toast('正在刷新预设...', 'info');
  });

  // --- Open preset folder ---
  var openFolderBtn = container.querySelector('#forgeOpenFolderBtn');
  if (openFolderBtn) openFolderBtn.addEventListener('click', function() {
    TileAPI.sendToHost('openForgePresetFolder', {});
  });
}

function _bindSlider(container, sliderId, valId, storageKey) {
  var slider = container.querySelector('#' + sliderId);
  var valEl = container.querySelector('#' + valId);
  if (!slider) return;
  slider.addEventListener('input', function() {
    if (valEl) valEl.textContent = slider.value;
    if (storageKey) {
      TileAPI.storage.set(storageKey, slider.value);
      _notifyPromptIfForge(storageKey, slider.value);
    }
  });
}

function _bindFieldPersist(container, id, storageKey) {
  var el = container.querySelector('#' + id);
  if (!el) return;
  el.addEventListener('change', function() {
    TileAPI.storage.set(storageKey, el.value);
    _notifyPromptIfForge(storageKey, el.value);
  });
}

// 若当前提示词磁贴用着 forge 预设,通知它同步 meta + 重绘 forge 参数面板
function _notifyPromptIfForge(storageKey, value) {
  if (TileAPI.state.get('prompt.lastPresetKind') !== 'forge') return;
  var metaKeyMap = {
    'forge.batchSize': 'batch',
    'forge.denoise': 'denoise',
    'forge.steps': 'steps',
    'forge.resolution': 'resolution',
    'forge.cfg': 'cfg',
    'forge.model': 'model',
    'forge.sampler': 'sampler',
  };
  var mk = metaKeyMap[storageKey];
  if (!mk) return;
  var meta = TileAPI.state.get('prompt.lastPresetMeta') || {};
  meta[mk] = value;
  TileAPI.state.set('prompt.lastPresetMeta', meta);
  TileAPI.emit('forge:tileChanged', { key: mk, value: value });
}

// ========== Load Saved Values ==========

function _loadSavedValues(container) {
  // 预设 cache:重渲后 select 是初始 HTML "预设 (0)",必须从缓存重填
  // (host 的 forgePresetsFileLoaded 消息只在初次发,后续 layout/source 切换不会再发)
  if (_forgePresetsCache && _forgePresetsCache.length) {
    _populatePresetSelect(container);
  }

  // 从缓存 state 补齐 models/samplers/cn/loras(如果之前已经请求过)
  // 没有这个的话,用户收起 forge 磁贴再展开就会看到空白下拉,必须重连
  var cachedModels = TileAPI.state.get('forge.models');
  if (cachedModels && cachedModels.length) {
    var modelSel = container.querySelector('#forgeModel');
    if (modelSel && modelSel.tagName === 'SELECT' && modelSel.options.length <= 1) {
      _populateSelect(modelSel, cachedModels,
        function(m) { return m.model_name || m.title || ''; },
        function(m) { return m.title || m.model_name || ''; },
        '-- 模型 (' + cachedModels.length + ') --'
      );
    }
  }
  var cachedSamplers = TileAPI.state.get('forge.samplers');
  if (cachedSamplers && cachedSamplers.length) {
    var samplerSel2 = container.querySelector('#forgeSampler');
    if (samplerSel2 && samplerSel2.tagName === 'SELECT' && samplerSel2.options.length <= 1) {
      _populateSelect(samplerSel2, cachedSamplers,
        function(s) { return s.name || s; },
        function(s) { return s.name || s; },
        null
      );
    }
  }
  var cachedCnModules = TileAPI.state.get('forge.cnModules');
  if (cachedCnModules && cachedCnModules.length) {
    for (var ci = 0; ci < 3; ci++) {
      var cnMod = container.querySelector('#forgeCnModule' + ci);
      if (cnMod && cnMod.options.length <= 1) {
        cnMod.innerHTML = '<option value="none">无</option>';
        cachedCnModules.forEach(function(m) {
          var opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          cnMod.appendChild(opt);
        });
      }
    }
  }
  var cachedCnModels = TileAPI.state.get('forge.cnModels');
  if (cachedCnModels && cachedCnModels.length) {
    for (var cmi = 0; cmi < 3; cmi++) {
      var cnModel = container.querySelector('#forgeCnModel' + cmi);
      if (cnModel && cnModel.options.length <= 1) {
        cnModel.innerHTML = '<option value="None">无</option>';
        cachedCnModels.forEach(function(m) {
          var opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          cnModel.appendChild(opt);
        });
      }
    }
  }
  var cachedLoras = TileAPI.state.get('forge.loras');
  if (cachedLoras && cachedLoras.length) {
    for (var li = 0; li < 5; li++) {
      var loraSel = container.querySelector('#forgeLora' + li);
      if (loraSel && loraSel.options.length <= 1) {
        _populateSelect(loraSel, cachedLoras,
          function(l) { return l.name || l.alias || ''; },
          function(l) { return l.name || l.alias || ''; },
          '无'
        );
      }
    }
  }

  var modelSel = container.querySelector('#forgeModel');
  var samplerSel = container.querySelector('#forgeSampler');
  var savedModel = TileAPI.storage.get('forge.model');
  if (savedModel && modelSel) modelSel.value = savedModel;
  var savedSampler = TileAPI.storage.get('forge.sampler');
  if (savedSampler && samplerSel) samplerSel.value = savedSampler;

  // 若连接状态是 connected,恢复状态文本
  if (TileAPI.state.get('forge.connected')) {
    var statusEl = container.querySelector('#forgeStatus');
    if (statusEl) {
      statusEl.textContent = '已连接';
      statusEl.style.color = 'var(--accent)';
    }
  }
}

// ========== Running UI ==========

function _updateRunningUI(container, running) {
  var btn = container.querySelector('#forgeGenerateBtn');
  if (!btn) return;
  if (running) {
    btn.textContent = '中断';
    btn.classList.remove('w10-btn-accent');
    btn.style.color = '#ff6b6b';
    btn.style.borderColor = 'rgba(255,100,100,0.3)';
  } else {
    btn.textContent = 'Forge img2img 生成';
    btn.classList.add('w10-btn-accent');
    btn.style.color = '';
    btn.style.borderColor = '';
  }
}

// ========== Translation ==========
// 按 translateId 路由,多个请求并发也不会串
var _forgePendingTranslates = {};  // { [id]: { target, timer } }
var _FORGE_TRANSLATE_TIMEOUT_MS = 15000;

function _forgeRestoreTrBtn(container) {
  var btn = container ? container.querySelector('#forgeTranslateBtn') : null;
  if (btn) { btn.textContent = '翻译'; btn.style.pointerEvents = ''; }
}

function _doTranslate(container, target) {
  var inputEl = container.querySelector('#forgeTranslateInput');
  var posEl = container.querySelector('#forgePositivePrompt');

  // If no translate input, use positive prompt directly
  var text = inputEl ? inputEl.value.trim() : '';
  if (!text && target === null && posEl) {
    text = posEl.value.trim();
  }
  if (!text) { TileAPI.toast('请输入要翻译的内容', 'error'); return; }

  var id = 'trf_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  var timer = setTimeout(function() {
    if (_forgePendingTranslates[id]) {
      delete _forgePendingTranslates[id];
      _forgeRestoreTrBtn(_activeContainer);
      TileAPI.toast('翻译超时,请重试', 'error');
    }
  }, _FORGE_TRANSLATE_TIMEOUT_MS);
  _forgePendingTranslates[id] = { target: target, timer: timer };

  var btn = container.querySelector('#forgeTranslateBtn');
  if (btn) { btn.textContent = '...'; btn.style.pointerEvents = 'none'; }

  TileAPI.sendToHost('youdaoTranslate', { text: text, fromLang: 'auto', toLang: 'en', translateId: id });
}

// ========== Apply Preset ==========

/** 把预设数据持久化到 storage(不依赖 DOM,forge 磁贴未展开时也能用) */
function _persistPresetToStorage(p) {
  if (!p) return;
  if (typeof p.positivePrompt === 'string') TileAPI.storage.set('forge.positivePrompt', p.positivePrompt);
  if (typeof p.negativePrompt === 'string') TileAPI.storage.set('forge.negativePrompt', p.negativePrompt);
  if (p.step) TileAPI.storage.set('forge.steps', p.step);
  if (p.redrawAmount) TileAPI.storage.set('forge.denoise', p.redrawAmount);
  if (p.resolution) TileAPI.storage.set('forge.resolution', p.resolution);
  if (p.imageCount) TileAPI.storage.set('forge.batchSize', p.imageCount);
  if (p.model) TileAPI.storage.set('forge.model', p.model);
  if (p.selectedName) TileAPI.storage.set('forge.sampler', p.selectedName);
  // LoRA / ControlNet —— 两条路一致的关键。之前漏写, 导致"从预设列表→提示词框生成"
  // 丢了 LoRA/ControlNet, 结果和"在 Forge 磁贴里选同一预设生成"完全不一样。
  // 这里补齐(镜像 _applyPreset 对 DOM 的设置, 写到生成路读取的 forge.* 存储键)。
  // 无条件写 index 0, 避免上一个预设的 LoRA/CN 残留串到下一个。cfg/seed 预设里没有, 不写。
  TileAPI.storage.set('forge.lora0', p.lora || '');
  TileAPI.storage.set('forge.loraWeight0', p.loraWeight || '1');
  var _cnMod = p.selectedControlNetModule;
  if (_cnMod === 'None' || _cnMod === '' || _cnMod == null) _cnMod = 'none';
  TileAPI.storage.set('forge.cnModule0', _cnMod);
  TileAPI.storage.set('forge.cnModel0', p.controlNetModel || '');
  TileAPI.storage.set('forge.cnWeight0', p.controlNetWeight || '1');
}

function _applyPreset(container, fp) {
  var p = fp.data;

  // 决策 B:预设模型在当前源的列表里不存在 → 拒绝载入整个预设
  // (避免载入后生成时用的是错误或空模型)
  // bug ⑥ A:剥掉 ` [hash]` 后缀比较,让老预设在哈希变了之后也能匹配
  if (p && p.model) {
    var currentModels = TileAPI.state.get('forge.models') || [];
    if (currentModels.length > 0) {
      // 只在模型列表已加载完成时校验;列表还空说明刚切源在拉,暂不拒绝(会在资源回来后补选)
      var found = false;
      var presetBase = _stripModelHash(p.model);
      for (var mi = 0; mi < currentModels.length; mi++) {
        var m = currentModels[mi];
        var mName = m.title || m.model_name || '';
        var mBase = _stripModelHash(mName);
        if (mName === p.model || mBase === presetBase) { found = true; break; }
      }
      if (!found) {
        TileAPI.toast('当前 Forge 源无模型 "' + (presetBase || p.model) + '",无法载入预设', 'error');
        return;
      }
    }
  }

  // 缓存完整 preset data,之后 models/loras/controlnet 异步回来时用它再补一次
  _lastAppliedPresetData = p;
  // 先写 storage,保证 forge 磁贴下次渲染能读到
  _persistPresetToStorage(p);

  var posEl = container.querySelector('#forgePositivePrompt');
  var negEl = container.querySelector('#forgeNegativePrompt');
  if (posEl) posEl.value = p.positivePrompt || '';
  if (negEl) negEl.value = p.negativePrompt || '';

  _setSliderVal(container, 'forgeSteps', 'forgeStepsVal', p.step || '20', 'forge.steps');
  _setSliderVal(container, 'forgeDenoise', 'forgeDenoiseVal', p.redrawAmount || '0.35', 'forge.denoise');
  _setSliderVal(container, 'forgeResolution', 'forgeResolutionVal', p.resolution || '768', 'forge.resolution');

  var batchEl = container.querySelector('#forgeBatchSize');
  if (batchEl) batchEl.value = p.imageCount || '1';

  var cfgEl = container.querySelector('#forgeCfg');
  if (cfgEl) {
    // Preset may not have CFG, keep current
  }

  var modelSel = container.querySelector('#forgeModel');
  if (modelSel && p.model) _selectModelOption(modelSel, p.model);

  var samplerSel = container.querySelector('#forgeSampler');
  if (samplerSel && p.selectedName) _selectOption(samplerSel, p.selectedName);

  // LoRA
  var loraSel = container.querySelector('#forgeLora0');
  if (loraSel && p.lora) {
    _selectOption(loraSel, p.lora);
    var loraRow = container.querySelector('#forgeLoraRow0');
    if (loraRow) loraRow.style.display = '';
  }
  _setSliderVal(container, 'forgeLoraWeight0', 'forgeLoraWeightVal0', p.loraWeight || '1', null);

  // ControlNet
  var cnModSel = container.querySelector('#forgeCnModule0');
  if (cnModSel && p.selectedControlNetModule) {
    var cnVal = p.selectedControlNetModule;
    if (cnVal === 'None' || cnVal === '') cnVal = 'none';
    _selectOption(cnModSel, cnVal);
  }
  var cnModelSel = container.querySelector('#forgeCnModel0');
  if (cnModelSel && p.controlNetModel) {
    if (p.controlNetModel === 'None' || p.controlNetModel === '') {
      cnModelSel.selectedIndex = 0;
    } else {
      _selectOption(cnModelSel, p.controlNetModel);
    }
  }
  _setSliderVal(container, 'forgeCnWeight0', 'forgeCnWeightVal0', p.controlNetWeight || '1', null);

  // Persist prompts
  if (posEl) TileAPI.storage.set('forge.positivePrompt', posEl.value);
  if (negEl) TileAPI.storage.set('forge.negativePrompt', negEl.value);

  TileAPI.toast('预设已加载: ' + (fp.displayName || fp.name || ''), 'success');
}

function _setSliderVal(container, sliderId, valId, val, storageKey) {
  var slider = container.querySelector('#' + sliderId);
  var valEl = container.querySelector('#' + valId);
  if (slider) slider.value = val;
  if (valEl) valEl.textContent = val;
  if (storageKey) TileAPI.storage.set(storageKey, val);
}

// ========== Populate Preset Select ==========

function _populatePresetSelect(container) {
  var sel = container ? container.querySelector('#forgePresetSelect') : document.querySelector('#forgePresetSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">预设 (' + _forgePresetsCache.length + ')</option>';
  var groups = {};
  for (var i = 0; i < _forgePresetsCache.length; i++) {
    var fp = _forgePresetsCache[i];
    var cat = fp.category || 'fullbody';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(fp);
  }
  for (var catId in groups) {
    var grp = document.createElement('optgroup');
    grp.label = FORGE_CAT_LABELS[catId] || catId;
    for (var j = 0; j < groups[catId].length; j++) {
      var fp2 = groups[catId][j];
      var opt = document.createElement('option');
      opt.value = fp2.name || fp2.displayName || '';
      opt.textContent = (fp2._isFactory ? '' : '* ') + (fp2.displayName || fp2.name || '');
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  }
}

// ========== Save Preset Dialog ==========

function _showSavePresetDialog(container) {
  var overlay = document.createElement('div');
  overlay.className = 'forge-save-overlay';
  overlay.innerHTML =
    '<div class="forge-save-dialog">' +
      '<div class="forge-save-title">保存 Forge 预设</div>' +
      '<div class="w10-row"><div class="w10-row-left"><div class="w10-row-label">名称</div></div><div class="w10-row-right" style="flex:1;"><input class="w10-input" id="forgeSaveName" placeholder="预设名称..."></div></div>' +
      '<div class="w10-row"><div class="w10-row-left"><div class="w10-row-label">分类</div></div><div class="w10-row-right" style="flex:1;"><select class="w10-select" id="forgeSaveCat"></select></div></div>' +
      '<div class="forge-save-btns">' +
        '<button class="w10-btn" id="forgeSaveCancel">取消</button>' +
        '<button class="w10-btn w10-btn-accent" id="forgeSaveOk">保存</button>' +
      '</div>' +
    '</div>';
  container.appendChild(overlay);

  // Populate categories
  var catSel = overlay.querySelector('#forgeSaveCat');
  FORGE_CATS.forEach(function(c) {
    var opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    if (c.id === 'fullbody') opt.selected = true;
    catSel.appendChild(opt);
  });

  var nameInp = overlay.querySelector('#forgeSaveName');
  if (nameInp) setTimeout(function() { nameInp.focus(); }, 50);

  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  var cancelBtn = overlay.querySelector('#forgeSaveCancel');
  if (cancelBtn) cancelBtn.addEventListener('click', function() { overlay.remove(); });

  var okBtn = overlay.querySelector('#forgeSaveOk');
  if (okBtn) okBtn.addEventListener('click', function() {
    var name = nameInp ? nameInp.value.trim() : '';
    if (!name) { TileAPI.toast('请输入预设名称', 'error'); return; }
    var cat = catSel ? catSel.value : 'fullbody';

    var posEl = container.querySelector('#forgePositivePrompt');
    var negEl = container.querySelector('#forgeNegativePrompt');
    var modelEl = container.querySelector('#forgeModel');
    var samplerEl = container.querySelector('#forgeSampler');
    var stepsEl = container.querySelector('#forgeSteps');
    var denoiseEl = container.querySelector('#forgeDenoise');
    var resEl = container.querySelector('#forgeResolution');
    var batchEl = container.querySelector('#forgeBatchSize');
    var loraEl = container.querySelector('#forgeLora0');
    var loraWEl = container.querySelector('#forgeLoraWeight0');
    var cnModEl = container.querySelector('#forgeCnModule0');
    var cnModelEl = container.querySelector('#forgeCnModel0');
    var cnWEl = container.querySelector('#forgeCnWeight0');

    var newPreset = {
      id: 'uf_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      name: name,
      displayName: name,
      category: cat,
      _isFactory: false,
      data: {
        model: modelEl ? _stripModelHash(modelEl.value) : '',
        lora: loraEl ? loraEl.value : '',
        loraWeight: loraWEl ? loraWEl.value : '1',
        redrawAmount: denoiseEl ? denoiseEl.value : '0.35',
        imageCount: batchEl ? batchEl.value : '1',
        resolution: resEl ? resEl.value : '768',
        positivePrompt: posEl ? posEl.value : '',
        negativePrompt: negEl ? negEl.value : '',
        selectedControlNetModule: cnModEl ? cnModEl.value : 'None',
        controlNetModel: cnModelEl ? cnModelEl.value : 'None',
        controlNetWeight: cnWEl ? cnWEl.value : '',
        step: stepsEl ? stepsEl.value : '20',
        selectedName: samplerEl ? samplerEl.value : 'DPM++ 2M'
      }
    };
    TileAPI.sendToHost('saveForgePresetsFile', { action: 'save', preset: newPreset });
    TileAPI.toast('正在保存预设: ' + name, 'info');
    overlay.remove();
  });
}

// ========== Host Message Handling ==========

// Global container reference for onMessage (since onMessage doesn't receive container)
var _activeContainer = null;

function _subscribeHostMessages(container) {
  _activeContainer = container;
  return {};
}

function _handleHostMessage(action, data) {
  try {
    _handleHostMessageImpl(action, data);
  } catch (e) {
    // forge 磁贴收起时 host 消息到达,个别分支若访问 DOM 会爆;统一捕获防止级联崩溃
    console.error('[tile-forge] _handleHostMessage error', action, e);
  }
}

function _handleHostMessageImpl(action, data) {
  var container = _activeContainer;

  if (action === 'forgeTestResult') {
    var statusEl = container ? container.querySelector('#forgeStatus') : null;
    if (data && data.success) {
      if (statusEl) {
        statusEl.textContent = '已连接 | 模型: ' + (data.model || '未知');
        statusEl.style.color = 'var(--accent)';
      }
      TileAPI.state.set('forge.connected', true);
      var url = _getUrl();
      if (url) {
        TileAPI.sendToHost('forgeFetchModels', { url: url });
        TileAPI.sendToHost('forgeFetchSamplers', { url: url });
        TileAPI.sendToHost('forgeFetchControlNetModules', { url: url });
        TileAPI.sendToHost('forgeFetchControlNetModels', { url: url });
        TileAPI.sendToHost('forgeFetchLoras', { url: url });
      }
    } else {
      if (statusEl) {
        statusEl.textContent = '连接失败: ' + (data ? data.error : '未知');
        statusEl.style.color = '#ff6b6b';
      }
      TileAPI.state.set('forge.connected', false);
      if (TileAPI.state.get('forge.userInitiatedConnect')) {
        TileAPI.toast('Forge 连接失败: ' + (data ? data.error : ''), 'error');
      }
    }
    TileAPI.state.set('forge.userInitiatedConnect', false);
  }

  if (action === 'forgeModelsResult' && data && data.success) {
    var models = data.models || [];
    TileAPI.state.set('forge.models', models);
    if (container) {
      var modelSel = container.querySelector('#forgeModel');
      if (modelSel && modelSel.tagName === 'SELECT') {
        _populateSelect(modelSel, models,
          function(m) { return m.model_name || m.title || ''; },
          function(m) { return m.title || m.model_name || ''; },
          '-- 模型 (' + models.length + ') --'
        );
        var saved = TileAPI.storage.get('forge.model');
        if (saved) {
          // bug ⑥ A:saved 可能带过期 [hash],用基名匹配补救
          if (!_selectModelOption(modelSel, saved)) {
            // 没匹配上就不动 default(populateSelect 已设头条),避免静默错配
          }
        }
      }
    }
  }

  if (action === 'forgeSamplersResult' && data && data.success) {
    var samplers = data.samplers || [];
    TileAPI.state.set('forge.samplers', samplers);
    if (container) {
      var samplerSel = container.querySelector('#forgeSampler');
      if (samplerSel && samplerSel.tagName === 'SELECT') {
        _populateSelect(samplerSel, samplers,
          function(s) { return s.name; },
          function(s) { return s.name; },
          null
        );
        var saved = TileAPI.storage.get('forge.sampler');
        if (saved) samplerSel.value = saved;
      }
    }
  }

  if (action === 'forgeCnModulesResult' && data && data.success) {
    var modules = data.modules || [];
    TileAPI.state.set('forge.cnModules', modules);
    if (container) {
      for (var i = 0; i < 3; i++) {
        var cnPre = container.querySelector('#forgeCnModule' + i);
        if (cnPre) {
          cnPre.innerHTML = '<option value="none">无</option>';
          modules.forEach(function(m) {
            var opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            cnPre.appendChild(opt);
          });
        }
      }
      // 补齐预设中的 CN module 选择
      if (_lastAppliedPresetData && _lastAppliedPresetData.selectedControlNetModule) {
        var cnMod0 = container.querySelector('#forgeCnModule0');
        if (cnMod0) {
          var cnVal = _lastAppliedPresetData.selectedControlNetModule;
          if (cnVal === 'None' || cnVal === '') cnVal = 'none';
          _selectOption(cnMod0, cnVal);
        }
      }
    }
  }

  if (action === 'forgeCnModelsResult' && data && data.success) {
    var cnModels = data.models || [];
    TileAPI.state.set('forge.cnModels', cnModels);
    if (container) {
      for (var i = 0; i < 3; i++) {
        var cnSel = container.querySelector('#forgeCnModel' + i);
        if (cnSel) {
          cnSel.innerHTML = '<option value="None">无</option>';
          cnModels.forEach(function(m) {
            var opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            cnSel.appendChild(opt);
          });
        }
      }
      // 补齐预设中的 CN model 选择
      if (_lastAppliedPresetData && _lastAppliedPresetData.controlNetModel) {
        var cnM0 = container.querySelector('#forgeCnModel0');
        if (cnM0) {
          var cnMv = _lastAppliedPresetData.controlNetModel;
          if (cnMv !== 'None' && cnMv !== '') _selectOption(cnM0, cnMv);
        }
      }
    }
  }

  if (action === 'forgeLorasResult' && data && data.success) {
    var loras = data.loras || [];
    TileAPI.state.set('forge.loras', loras);
    if (container) {
      for (var i = 0; i < 5; i++) {
        var loraSel = container.querySelector('#forgeLora' + i);
        if (loraSel) {
          _populateSelect(loraSel, loras,
            function(l) { return l.name || l.alias || ''; },
            function(l) { return l.name || l.alias || ''; },
            '无'
          );
        }
      }
      // 补齐预设中的 LoRA 选择
      if (_lastAppliedPresetData && _lastAppliedPresetData.lora) {
        var lora0 = container.querySelector('#forgeLora0');
        if (lora0) {
          _selectOption(lora0, _lastAppliedPresetData.lora);
          var loraRow = container.querySelector('#forgeLoraRow0');
          if (loraRow) loraRow.style.display = '';
        }
      }
    }
  }

  if (action === 'forgeComplete') {
    TileAPI.state.set('forge.running', false);
    if (container) _updateRunningUI(container, false);
    // 失败(含云扣分失败/积分不足)时把原因吐给用户,否则只闷头复位 UI 用户不知道为啥停了
    if (data && data.success === false && data.error) {
      TileAPI.toast(data.error, 'error');
      try {
        if (window._telemetry) {
          var _fc = data.error_category || 'forge.api.generic_fail';
          window._telemetry.trackError(_fc, 'forge_generate', data.error);
        }
      } catch(_) {}
    }
  }

  if (action === 'forgeProgress' && data) {
    var pct = Math.round((data.progress || 0) * 100);
    if (container) {
      var genBtn = container.querySelector('#forgeGenerateBtn');
      if (genBtn && TileAPI.state.get('forge.running')) {
        genBtn.textContent = pct + '% 中断';
      }
    }
  }

  if (action === 'forgeError' && data) {
    TileAPI.state.set('forge.running', false);
    if (container) _updateRunningUI(container, false);
    TileAPI.toast('Forge 错误: ' + (data.error || '未知错误'), 'error');
    try {
      if (window._telemetry) {
        var _ec = data.error_category || 'forge.api.unknown';
        window._telemetry.trackError(_ec, 'forge_generate', data.error || '');
      }
    } catch(_) {}
  }

  if (action === 'forgeImageResult') {
    // Image placed back in PS by backend. Nothing else needed here.
    TileAPI.state.set('forge.running', false);
    if (container) _updateRunningUI(container, false);
  }

  if (action === 'forgeInterrupted') {
    TileAPI.state.set('forge.running', false);
    if (container) _updateRunningUI(container, false);
    TileAPI.toast('生成已中断', 'info');
    try { if (window._telemetry) window._telemetry.trackError('forge.user.aborted', 'forge_generate', ''); } catch(_) {}
  }

  // Presets
  if (action === 'forgePresetsFileLoaded' || action === 'forgePresetsLoaded' || action === 'forgePresetsUpdated') {
    if (data && Array.isArray(data.presets)) {
      _forgePresetsCache = data.presets;
      TileAPI.state.set('forge.presets', _forgePresetsCache);
      if (container) _populatePresetSelect(container);
      TileAPI.log('[Forge] Presets loaded: ' + _forgePresetsCache.length, 'info');
    }
  }

  if (action === 'forgePresetFolderPath' && data && data.path) {
    TileAPI.toast('预设文件夹: ' + data.path, 'info');
  }

  // Translation
  if (action === 'youdaoTranslateResult') {
    if (!data || !data.translateId) return;
    var pending = _forgePendingTranslates[data.translateId];
    if (!pending) return;  // 不是我们的请求(可能是提示词磁贴的),忽略
    clearTimeout(pending.timer);
    delete _forgePendingTranslates[data.translateId];

    // Restore button
    _forgeRestoreTrBtn(container);

    if (data.success && (data.translated || data.text)) {
      var translated = data.translated || data.text;
      var target = pending.target;
      if (container) {
        if (target === 'positive') {
          var posEl = container.querySelector('#forgePositivePrompt');
          if (posEl) {
            posEl.value = posEl.value ? posEl.value + ', ' + translated : translated;
            TileAPI.storage.set('forge.positivePrompt', posEl.value);
          }
        } else if (target === 'negative') {
          var negEl = container.querySelector('#forgeNegativePrompt');
          if (negEl) {
            negEl.value = negEl.value ? negEl.value + ', ' + translated : translated;
            TileAPI.storage.set('forge.negativePrompt', negEl.value);
          }
        } else {
          // Replace in translate input
          var inputEl = container.querySelector('#forgeTranslateInput');
          if (inputEl) inputEl.value = translated;
        }
      }
      TileAPI.toast('翻译结果: ' + translated.substring(0, 60), 'success');
    } else {
      TileAPI.toast('翻译失败: ' + (data ? data.error : ''), 'error');
    }
  }
}

// ========== Bridge functions (for other tiles) ==========
window._forgeIsConnected = function() {
  return !!TileAPI.state.get('forge.connected');
};
window._forgeGetPresets = function() {
  return _forgePresetsCache.map(function(fp) {
    return {
      name: fp.name || fp.displayName || '',
      displayName: fp.displayName || (fp.name || '').replace(/^[0-9]+/, ''),
      category: fp.category || 'fullbody',
      data: fp.data || {},
      _isFactory: !!fp._isFactory,
      _fileName: fp._fileName || ''
    };
  });
};

// 不依赖 DOM 的 Forge 生成入口 — 从 storage/state 读完整参数, 给 tile-run 用
// opts: { taskId(必需), presetTitle? }
// 返回 { ok: true } 或 { ok: false, error: '...' }
window._forgeStartGenerateViaRun = function(opts) {
  opts = opts || {};
  var taskId = opts.taskId;
  if (!taskId) return { ok: false, error: '缺 taskId' };

  // 前置: 连接 + 云积分检查 (同独立按钮)
  if (_getActiveSource() === 'cloud') {
    var pts = (window._cloudGetPoints && window._cloudGetPoints()) || 0;
    if (pts <= 0) return { ok: false, error: '云服务积分为 0,请充值' };
  }
  var sourceParams = _getSourceFetchParams();
  if (!sourceParams) {
    return { ok: false, error: _getActiveSource() === 'cloud' ? '云 Forge 不可用,请登录并等积分查询' : '请先连接本地 Forge URL' };
  }

  var effectivePrompt = TileAPI.storage.get('forge.positivePrompt') || '';
  // 追加 LoRA (从 storage 读)
  for (var li = 0; li < 5; li++) {
    var lname = TileAPI.storage.get('forge.lora' + li);
    var lw = TileAPI.storage.get('forge.loraWeight' + li);
    if (lname) effectivePrompt += ' <lora:' + lname + ':' + (parseFloat(lw) || 1) + '>';
  }

  // ControlNet units
  var cnUnits = [];
  for (var ci = 0; ci < 3; ci++) {
    var cnMod = TileAPI.storage.get('forge.cnModule' + ci);
    var cnMdl = TileAPI.storage.get('forge.cnModel' + ci);
    var cnWt  = TileAPI.storage.get('forge.cnWeight' + ci);
    if (cnMdl && String(cnMdl).toLowerCase() !== 'none') {
      cnUnits.push({ module: cnMod || 'none', model: cnMdl, weight: parseFloat(cnWt) || 1 });
    }
  }

  var forgeRes = TileAPI.storage.get('forge.resolution') || 768;
  var targetSize = _getTargetSize(forgeRes);
  var cnEnabled = cnUnits.length > 0;

  var payload = {
    taskId: taskId,
    prompt: effectivePrompt,
    negPrompt: TileAPI.storage.get('forge.negativePrompt') || '',
    steps: parseInt(TileAPI.storage.get('forge.steps')) || 20,
    cfg: parseFloat(TileAPI.storage.get('forge.cfg')) || 7,
    denoise: parseFloat(TileAPI.storage.get('forge.denoise')) || 0.75,
    resolution: forgeRes,
    width: targetSize.width,
    height: targetSize.height,
    sampler: TileAPI.storage.get('forge.sampler') || 'Euler a',
    model: TileAPI.storage.get('forge.model') || '',
    batchSize: parseInt(TileAPI.storage.get('forge.batchSize')) || 1,
    seed: parseInt(TileAPI.storage.get('forge.seed')) || -1,
    cnEnabled: cnEnabled,
    cnModule: cnEnabled ? cnUnits[0].module : 'none',
    cnModel: cnEnabled ? cnUnits[0].model : 'None',
    cnWeight: cnEnabled ? cnUnits[0].weight : 1,
    presetTitle: TileAPI.state.get('prompt.lastPresetTitle') || ''   // 缓存文件夹命名用
  };
  if (sourceParams.encrypted) payload.encrypted = sourceParams.encrypted;
  if (sourceParams.url) payload.url = sourceParams.url;
  payload.source = _getActiveSource();

  TileAPI.state.set('forge.running', true);
  // 云端走扣分通道, 本地直发(同独立按钮路径)
  if (payload.source === 'cloud') {
    TileAPI.sendToHost('cloudForgeImg2Img', payload);
  } else {
    TileAPI.sendToHost('forgeImg2Img', payload);
  }
  return {
    ok: true,
    batchSize: payload.batchSize,
    resolution: forgeRes,
    width: payload.width,
    height: payload.height,
    model: payload.model
  };
};

// 给 tile-run 判断当前是否 Forge 语境
window._forgeGetActiveSource = _getActiveSource;

// ========== 监听 tile-presets 广播的 forge:applyPreset ==========
// 可能 tile-forge 磁贴还没展开 → 只写 storage;展开了就同时写 DOM
TileAPI.on('forge:applyPreset', function(data) {
  if (!data || !data.data) return;
  // 校验模型 — 若当前源的 models 已加载且不存在 → 拒绝
  var p = data.data;
  if (p && p.model) {
    var currentModels = TileAPI.state.get('forge.models') || [];
    if (currentModels.length > 0) {
      var found = false;
      for (var mi = 0; mi < currentModels.length; mi++) {
        var m = currentModels[mi];
        var mName = m.title || m.model_name || '';
        if (mName === p.model || mName.indexOf(p.model) >= 0) { found = true; break; }
      }
      if (!found) {
        TileAPI.toast('当前 Forge 源无模型 "' + p.model + '",无法载入预设', 'error');
        return;
      }
    }
  }
  _persistPresetToStorage(p);
  if (_activeContainer) {
    _applyPreset(_activeContainer, { data: p, displayName: data.title, name: data.title });
  } else {
    TileAPI.toast('已载入 Forge 预设,展开 Forge 磁贴查看参数', 'info');
  }
});

// ========== 监听 提示词磁贴 对 forge 正向/反向提示词的编辑 ==========
// 用户在提示词磁贴里改动时,把修改同步进 forge storage + DOM
// 云服务积分就绪时:若当前是云源,自动补刷资源 + 重绘源栏
TileAPI.on('cloud:pointsReady', function() {
  if (_getActiveSource() !== 'cloud') {
    // 非云源:仅当下一次 render 时更新源栏上显示的积分
    if (_activeContainer) _refreshSourceBarOnly(_activeContainer);
    return;
  }
  _fetchResourcesForCurrentSource();
  if (_activeContainer) _refreshSourceBarOnly(_activeContainer);
});

// 更新源栏(显示积分变化/状态变化),不重建整个面板
function _refreshSourceBarOnly(container) {
  if (!container) return;
  var old = container.querySelector('.forge-source-bar');
  if (!old) return;
  var tmp = document.createElement('div');
  tmp.innerHTML = _renderSourceBar().trim();
  var newEl = tmp.firstChild;
  if (newEl) {
    old.parentNode.replaceChild(newEl, old);
    // 重新绑源按钮
    var btns = newEl.querySelectorAll('.forge-source-btn');
    for (var si = 0; si < btns.length; si++) {
      btns[si].addEventListener('click', function(e) {
        e.stopPropagation();
        var target = this.getAttribute('data-source');
        if (_isGenerating()) { TileAPI.toast('生成中不可切换算力源', 'info'); return; }
        if (target === _getActiveSource()) return;
        _switchSource(target);
      });
    }
  }
}

// 多 forge 服务器列表/选中变更 (顶栏切了服务器): 清缓存 + 重拉资源, 同时刷新源栏状态文字
TileAPI.on('cloud:forgeUrlListChanged', function() {
  // 首次拿到云 forge 服务器列表 → 自动切到云模式 (只触发一次, 之后用户手动切回本地不再被打扰)
  var list = (window._cloudGetForgeUrlList && window._cloudGetForgeUrlList()) || [];
  if (list.length > 0 && !TileAPI.storage.get('forge.autoSwitchedOnce')) {
    TileAPI.storage.set('forge.autoSwitchedOnce', true);
    if (_getActiveSource() === 'local' && !_isGenerating()) {
      _switchSource('cloud');
      return;  // _switchSource 已经清缓存+重拉+刷新 UI
    }
  }
  if (_getActiveSource() !== 'cloud') return;
  TileAPI.state.set('forge.models', []);
  TileAPI.state.set('forge.samplers', []);
  TileAPI.state.set('forge.cnModules', []);
  TileAPI.state.set('forge.cnModels', []);
  TileAPI.state.set('forge.loras', []);
  _fetchResourcesForCurrentSource();
  if (_activeContainer) _refreshSourceBarOnly(_activeContainer);
});

TileAPI.on('forge:syncFromPrompt', function(data) {
  if (!data) return;
  if (typeof data.positivePrompt === 'string') {
    TileAPI.storage.set('forge.positivePrompt', data.positivePrompt);
    if (_activeContainer) {
      var posEl = _activeContainer.querySelector('#forgePositivePrompt');
      if (posEl && posEl.value !== data.positivePrompt) posEl.value = data.positivePrompt;
    }
  }
  if (typeof data.negativePrompt === 'string') {
    TileAPI.storage.set('forge.negativePrompt', data.negativePrompt);
    if (_activeContainer) {
      var negEl = _activeContainer.querySelector('#forgeNegativePrompt');
      if (negEl && negEl.value !== data.negativePrompt) negEl.value = data.negativePrompt;
    }
  }
});

// ========== 监听 提示词磁贴 对 forge 参数(非提示词)的编辑 ==========
// 用户在提示词磁贴的 forge 参数面板里改 张数/重绘/步数/分辨率/CFG 时,同步到 forge 磁贴
TileAPI.on('forge:paramsChanged', function(data) {
  if (!data || !_activeContainer) return;
  var c = _activeContainer;
  function setValIfExists(id, val, valElId) {
    if (val === undefined || val === null) return;
    var el = c.querySelector('#' + id);
    if (!el) return;
    if (String(el.value) !== String(val)) el.value = val;
    if (valElId) {
      var vEl = c.querySelector('#' + valElId);
      if (vEl) vEl.textContent = val;
    }
    // range 需要刷新 --fill
    if (el.type === 'range') {
      var min = +el.min || 0;
      var max = +el.max || 1;
      var fill = Math.round(((+val - min) / (max - min)) * 100);
      el.style.setProperty('--fill', fill + '%');
    }
  }
  setValIfExists('forgeBatchSize', data.batch);
  setValIfExists('forgeDenoise', data.denoise, 'forgeDenoiseVal');
  setValIfExists('forgeSteps', data.steps, 'forgeStepsVal');
  setValIfExists('forgeResolution', data.resolution, 'forgeResolutionVal');
  setValIfExists('forgeCfg', data.cfg);
});

})();
