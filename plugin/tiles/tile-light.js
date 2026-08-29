(function() {
'use strict';

// ============================================================
//  tile-light.js — 灯光磁贴 (合并版)
//
//  顶部 Tab:
//    - 2D 调整(默认):手绘灯光附件 + 色温/强度 + "发送到 PS" + 已添加列表
//    - 3D 调整:WebGL 立体灯光编辑器(原 tile-light 全部能力)
//
//  共用区:API 引擎选择 + 模型 + 分辨率 + 宽高比 + 数量 + 超时 + "🚀 开始生成"
//
//  2D 提示词内置在 tile-light.prompt-2d.js 中(window._lightHand2DPrompt)
//
//  修复:_shouldRender3D 旧版按 layout 类别判定 → 全屏窄面板被误判,改用 width 像素判定
// ============================================================

// ===== 共享常量 =====
var LH_MANIFEST_URL = 'icons/light-handdrawn/manifest.json';
var LH_IMG_BASE = 'icons/light-handdrawn/';
var LH_IMG_W = 1446, LH_IMG_H = 1446;
var LH_DOT_RADIUS_RATIO = 0.06;
var LH_DOT_OFFSET_RATIO = 0.135;
var LH_DEFAULT_COLOR = '#FFFFFF';
var LH_DEFAULT_INTENSITY = 0.7;

// ===== 模块状态(整个磁贴生命周期共享) =====
var _activeContainer = null;
var _currentTab = '2d';                // '2d' / '3d'
var _3dCleanup = null;                 // 3D 当前实例的 cleanup 函数
var _3dGetPromptFn = null;             // 3D 实例暴露的"取当前提示词"函数

// 2D 状态
var _lhManifest = null;
var _lhSelectedFile = null;
var _lhEditsCache = null;
var _lhPreviewImg = null;
var _lights2D = [];                    // 已发送到 PS 的 2D 灯光列表 [{file, name, color, intensity}] — 持久化到 lighthand.lights2d
var _lights2DLoaded = false;
var _lhPlaceSeq = 0;
var _lhPendingPlaces = Object.create(null);

// 3D 状态 (从函数作用域提到模块作用域, 否则 Tab 切换 / 重渲就清零)
var _lights = [];                      // 3D WebGL 灯光列表 — 持久化到 light3d.lights
var _lights3DLoaded = false;

// 共享引擎区状态
var _curProvider = null;

// ============================================================
//  小工具
// ============================================================
function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _shouldRender3D(sizeHint) {
  // 旧逻辑用 sizeHint.layout(narrow/tall/...)误把全屏窄面板归为 narrow
  // 改用容器实际宽度像素判定
  var w = (sizeHint && sizeHint.width) || 0;
  return w >= 240;
}

// hex ↔ RGB ↔ HSL
function _hexToRgb(hex) {
  hex = String(hex || '').replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map(function(c) { return c + c; }).join('');
  if (hex.length !== 6) return { r: 255, g: 255, b: 255 };
  return { r: parseInt(hex.slice(0,2),16), g: parseInt(hex.slice(2,4),16), b: parseInt(hex.slice(4,6),16) };
}
function _rgbToHex(r, g, b) {
  function p(v) { v = Math.max(0, Math.min(255, Math.round(v))); var s = v.toString(16); return s.length < 2 ? '0' + s : s; }
  return '#' + p(r) + p(g) + p(b);
}
function _rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}
function _hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  }
  var r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return { r: r * 255, g: g * 255, b: b * 255 };
}

function _lhGetEdit(file) {
  if (!_lhEditsCache) _lhEditsCache = TileAPI.storage.get('lighthand.lastEdits') || {};
  var e = _lhEditsCache[file];
  if (!e) return { color: LH_DEFAULT_COLOR, intensity: LH_DEFAULT_INTENSITY, rotation: 0 };
  return {
    color: e.color || LH_DEFAULT_COLOR,
    intensity: (e.intensity != null ? e.intensity : LH_DEFAULT_INTENSITY),
    rotation: (typeof e.rotation === 'number' && isFinite(e.rotation)) ? e.rotation : 0
  };
}
function _lhSetEdit(file, color, intensity, rotation) {
  if (!_lhEditsCache) _lhEditsCache = TileAPI.storage.get('lighthand.lastEdits') || {};
  var prev = _lhEditsCache[file] || {};
  _lhEditsCache[file] = {
    color: color,
    intensity: intensity,
    rotation: (typeof rotation === 'number' && isFinite(rotation)) ? rotation : (prev.rotation || 0)
  };
  TileAPI.storage.set('lighthand.lastEdits', _lhEditsCache);
}

// === 灯光列表持久化 (lighthand.lights2d / light3d.lights) ===
// Why: 用户加的灯光要全局保留, 关掉重开磁贴 / Tab 切换都不该丢, 让用户自己删
function _lh2DEnsureLoaded() {
  if (_lights2DLoaded) return;
  _lights2D = TileAPI.storage.get('lighthand.lights2d') || [];
  _lights2DLoaded = true;
}
function _lh2DSave() {
  TileAPI.storage.set('lighthand.lights2d', _lights2D);
}
function _lh3DEnsureLoaded() {
  if (_lights3DLoaded) return;
  _lights = TileAPI.storage.get('light3d.lights') || [];
  _lights3DLoaded = true;
}
function _lh3DSave() {
  TileAPI.storage.set('light3d.lights', _lights);
}

function _loadLhManifest() {
  if (_lhManifest) return Promise.resolve(_lhManifest);
  return fetch(LH_MANIFEST_URL).then(function(r) { return r.json(); }).then(function(j) {
    _lhManifest = j;
    return j;
  }).catch(function(err) {
    TileAPI.log('[手绘灯光] 加载 manifest 失败: ' + (err && err.message || err), 'error');
    _lhManifest = { items: [], colorPresets: [] };
    return _lhManifest;
  });
}

// ============================================================
//  注册磁贴
// ============================================================
TileAPI.registerTile({
  id: 'light',
  group: 'main',
  icon: '💡',
  label: '💡 灯光',
  desc: '灯光编辑 + AI 重构',
  live: false,
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderFront: function(container, w, h) {
    if (w >= 2) {
      container.innerHTML =
        '<div class="tile-icon">💡</div>' +
        '<div class="tile-label">💡 灯光</div>' +
        '<div class="tile-desc">2D / 3D 灯光编辑</div>';
    } else {
      container.innerHTML =
        '<div class="tile-icon">💡</div>' +
        '<div class="tile-label">灯光</div>';
    }
  },

  renderBack: function(container) {
    container.textContent = '灯光编辑器';
  },

  onExpand: function(container, sizeHint) {
    _activeContainer = container;
    _lh2DEnsureLoaded();
    _lh3DEnsureLoaded();
    // 极窄宽度退化提示(给 3D 留的;2D 网格其实窄一点也能用,但统一拒绝过窄场景)
    if (!container._isInline && !_shouldRender3D(sizeHint)) {
      container.innerHTML =
        '<div class="w10-panel">' +
          '<div class="panel-placeholder" style="min-height:180px;flex-direction:column;gap:10px;">' +
            '<div class="panel-placeholder-icon">💡</div>' +
            '<div class="panel-placeholder-text">灯光编辑器</div>' +
            '<div style="font-size:10px;color:var(--text-sub);text-align:center;line-height:1.6;max-width:200px;">请加宽 PS 插件面板(至少 240px)以查看完整功能</div>' +
          '</div>' +
        '</div>';
      return;
    }
    return _renderShell(container);
  },

  onCollapse: function() {
    if (_3dCleanup) { try { _3dCleanup(); } catch(e) {} _3dCleanup = null; }
    _3dGetPromptFn = null;
    _activeContainer = null;
  },

  onMessage: function(action, data) {
    if (action !== 'lightHandPlaceResult') return;
    var reqId = data && data.reqId != null ? String(data.reqId) : '';
    var pending = reqId && _lhPendingPlaces[reqId];
    if (!pending) return;
    delete _lhPendingPlaces[reqId];
    if (pending.timer) clearTimeout(pending.timer);
    if (data && data.success) {
      for (var i = 0; i < _lights2D.length; i++) {
        if (_lights2D[i].id === pending.itemId) { _lights2D[i].layerId = data.layerId; break; }
      }
      _lh2DSave();
      TileAPI.toast('灯光示意已置入 PS', 'success');
      return;
    }
    _lights2D = _lights2D.filter(function(it) { return it.id !== pending.itemId; });
    _lh2DSave();
    _renderLh2DList();
    TileAPI.toast('灯光置入失败: ' + ((data && data.error) || 'Photoshop 未完成操作'), 'error');
  }
});

// ============================================================
//  外壳:Tab 栏 + Tab 内容容器 + 共用引擎区 + 开始生成
// ============================================================
function _renderShell(container) {
  container.innerHTML =
    '<div class="w10-panel light-shell">' +
      // Tab 栏
      '<div class="light-tabs">' +
        '<button class="light-tab' + (_currentTab === '2d' ? ' light-tab-active' : '') + '" data-light-tab="2d">2D 调整</button>' +
        '<button class="light-tab' + (_currentTab === '3d' ? ' light-tab-active' : '') + '" data-light-tab="3d">3D 调整</button>' +
      '</div>' +
      // 当前 Tab 的内容容器
      '<div class="light-tab-body" id="lightTabBody"></div>' +
      // 共用引擎区
      _renderEngineAreaHtml() +
      '<button class="w10-btn w10-btn-accent light3d-btn-go" id="btnLightGenerate">🚀 开始生成</button>' +
      '<div class="light3d-hint" id="lightHint">' + _engineHintForTab(_currentTab) + '</div>' +
    '</div>';

  _bindTabEvents(container);
  _bindEngineArea(container);
  _bindGenerateButton(container);
  _renderCurrentTab(container);
}

function _engineHintForTab(tab) {
  if (tab === '2d') return '编辑灯光附件并发送到 PS,然后点开始生成。AI 会按图层位置打光。';
  return '保持画面整体曝光不变,添加新的灯光源并生成';
}

function _bindTabEvents(container) {
  var tabs = container.querySelectorAll('[data-light-tab]');
  tabs.forEach(function(t) {
    t.addEventListener('click', function() {
      var newTab = t.dataset.lightTab;
      if (newTab === _currentTab) return;
      _switchTab(container, newTab);
    });
  });
}

function _switchTab(container, newTab) {
  // 切走时清理旧 Tab(尤其 3D 的 GL/事件资源)
  if (_currentTab === '3d' && _3dCleanup) {
    try { _3dCleanup(); } catch(e) {}
    _3dCleanup = null;
    _3dGetPromptFn = null;
  }
  _currentTab = newTab;

  // 更新 Tab 高亮
  var tabs = container.querySelectorAll('[data-light-tab]');
  tabs.forEach(function(t) {
    t.classList.toggle('light-tab-active', t.dataset.lightTab === newTab);
  });

  // 更新提示文字
  var hint = container.querySelector('#lightHint');
  if (hint) hint.textContent = _engineHintForTab(newTab);

  _renderCurrentTab(container);
}

function _renderCurrentTab(container) {
  var body = container.querySelector('#lightTabBody');
  if (!body) return;
  body.innerHTML = '';
  if (_currentTab === '3d') {
    _renderLight3D(body);
  } else {
    _renderLight2D(body);
  }
}

// ============================================================
//  共用引擎区
//  所有控件都从 storage 读初始值,改动也写回 storage
// ============================================================
function _engineGet(key, def) {
  var v = TileAPI.storage.get(key);
  return (v === null || v === undefined) ? def : v;
}

function _renderEngineAreaHtml() {
  // 从 storage 读初始值(全部 key 都用 light.engine.* 命名空间)
  var savedSize = String(_engineGet('light.engine.size', '2K'));
  var savedAspect = String(_engineGet('light.engine.aspectRatio', '1:1'));
  var savedBatch = String(_engineGet('light.engine.batchSize', 1));
  var savedTimeout = String(_engineGet('light.engine.timeout', 3600));

  function _opt(val, label, cur) {
    return '<option value="' + val + '"' + (val === cur ? ' selected' : '') + '>' + label + '</option>';
  }
  var sizeOpts = ['1K','2K','4K'].map(function(s) { return _opt(s, s, savedSize); }).join('');
  var aspects = ['1:1','Auto','9:16','16:9','2:3','3:2','3:4','4:3','4:5','5:4'];
  var aspectOpts = aspects.map(function(a) { return _opt(a, a, savedAspect); }).join('');

  return '' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">API 引擎</div></div>' +
      '<div class="w10-row-right">' +
        TileAPI.slotOrder().map(function(eng) {
          var def = eng === 'aji' ? 'AJI' : eng === 'grs' ? TileAPI.computeBrand() : '其他';
          var id = 'lightProv' + eng.charAt(0).toUpperCase() + eng.slice(1);
          return '<button class="w10-btn" id="' + id + '" data-prov="' + eng + '">' + TileAPI.slotLabel(eng, def) + '</button>';
        }).join('') +
      '</div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">模型</div></div>' +
      '<div class="w10-row-right"><select class="w10-select" id="lightModelInput"></select></div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">分辨率</div></div>' +
      '<div class="w10-row-right">' +
        '<select class="w10-select" id="lightSizeInput">' + sizeOpts + '</select>' +
      '</div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">宽高比</div></div>' +
      '<div class="w10-row-right">' +
        '<select class="w10-select" id="lightAspectRatioInput">' + aspectOpts + '</select>' +
      '</div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">数量</div></div>' +
      '<div class="w10-row-right"><input type="number" class="w10-input" id="lightBatchInput" value="' + _esc(savedBatch) + '" min="1" max="5" style="max-width:60px"/></div>' +
    '</div>' +
    '<input type="hidden" id="lightTimeoutInput" value="3600"/>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">无损模式</div><div class="w10-row-desc">输出中性灰柔光校正层(柔光混合),不毁原图、不丢分辨率</div></div>' +
      '<div class="w10-row-right"><div class="w10-toggle' + (TileAPI.storage.get('light.losslessMode') === true ? ' on' : '') + '" id="lightLosslessToggle"></div></div>' +
    '</div>';
}

function _bindEngineArea(container) {
  function _updateProvBtns(prov) {
    TileAPI.slotOrder().forEach(function(p) {
      var btn = container.querySelector('#lightProv' + (p.charAt(0).toUpperCase() + p.slice(1)));
      if (btn) btn.classList.toggle('w10-btn-accent', p === prov);
    });
    _updateModelOptions(prov);
  }
  function _updateModelOptions(prov) {
    var sel = container.querySelector('#lightModelInput');
    if (!sel) return;
    var cfg = TileAPI.state.get('models.' + prov) || {};
    var keys = Object.keys(cfg);
    var savedModel = TileAPI.storage.get('light.engine.model.' + prov) || '';
    sel.innerHTML = keys.map(function(k) {
      var label = (cfg[k] && cfg[k].name) ? cfg[k].name : k;
      var sel = (k === savedModel) ? ' selected' : '';
      return '<option value="' + _esc(k) + '"' + sel + '>' + _esc(label) + '</option>';
    }).join('') || '<option value="">(未配置)</option>';
  }
  // 优先用 light.engine.provider,fallback 到 params.provider state(老用户)
  _curProvider = TileAPI.storage.get('light.engine.provider') || TileAPI.state.get('params.provider') || 'aji';
  _updateProvBtns(_curProvider);
  TileAPI.slotOrder().forEach(function(p) {
    var btn = container.querySelector('#lightProv' + (p.charAt(0).toUpperCase() + p.slice(1)));
    if (btn) btn.addEventListener('click', function() {
      _curProvider = p;
      TileAPI.storage.set('light.engine.provider', p);
      _updateProvBtns(p);
    });
  });

  // 持久化各下拉/输入框的更改
  var modelSel = container.querySelector('#lightModelInput');
  if (modelSel) modelSel.addEventListener('change', function() {
    TileAPI.storage.set('light.engine.model.' + _curProvider, this.value);
  });
  var sizeSel = container.querySelector('#lightSizeInput');
  if (sizeSel) sizeSel.addEventListener('change', function() {
    TileAPI.storage.set('light.engine.size', this.value);
  });
  var aspectSel = container.querySelector('#lightAspectRatioInput');
  if (aspectSel) aspectSel.addEventListener('change', function() {
    TileAPI.storage.set('light.engine.aspectRatio', this.value);
  });
  var batchInp = container.querySelector('#lightBatchInput');
  if (batchInp) batchInp.addEventListener('change', function() {
    var n = parseInt(this.value, 10);
    if (isFinite(n) && n >= 1) TileAPI.storage.set('light.engine.batchSize', n);
  });
  var timeoutInp = container.querySelector('#lightTimeoutInput');
  if (timeoutInp) timeoutInp.addEventListener('change', function() {
    var n = parseInt(this.value, 10);
    if (isFinite(n) && n >= 5) TileAPI.storage.set('light.engine.timeout', n);
  });
  var llTog = container.querySelector('#lightLosslessToggle');
  if (llTog) llTog.addEventListener('click', function() {
    var now = !(TileAPI.storage.get('light.losslessMode') === true);
    TileAPI.storage.set('light.losslessMode', now);
    llTog.classList.toggle('on', now);
  });
}

function _bindGenerateButton(container) {
  var btn = container.querySelector('#btnLightGenerate');
  if (!btn) return;
  btn.addEventListener('click', function() { _doStartGenerate(container); });
}

// ============================================================
//  无损模式「打光柔光层」提示词已独立到 tiles/tile-light.prompt-relight.js
//  (window._lightRelightPrompt)，在 _doStartGenerate 里按需拼到用户布光方案前面。
// ============================================================


function _doStartGenerate(container) {
  // 决定提示词来源
  var lossless = TileAPI.storage.get('light.losslessMode') === true;
  var prompt = '';
  if (lossless) {
    // 无损模式 = 纯灯光 AOV 通道: 直接解析图上的灯具标注, 自成一体, 不拼 3D/2D 文字布光描述。
    prompt = window._lightRelightPrompt || '';
    if (!prompt) {
      TileAPI.toast('无损打光 AOV 提示词未加载,请重启插件', 'error');
      return;
    }
  } else if (_currentTab === '3d') {
    if (typeof _3dGetPromptFn === 'function') prompt = _3dGetPromptFn();
    if (!prompt || prompt.indexOf('尚未添加灯光') !== -1) {
      TileAPI.toast('请先添加至少一盏 3D 灯光', 'error');
      return;
    }
  } else {
    // 2D 用内嵌的硬编码提示词
    prompt = window._lightHand2DPrompt || '';
    if (!prompt) {
      TileAPI.toast('2D 灯光提示词模板未加载,请重启插件', 'error');
      return;
    }
    // 警告:用户可能没发送过任何 2D 灯具到 PS → 异步确认后再续(原生 confirm 在 webview 不可靠)
    if (_lights2D.length === 0) {
      TileAPI.confirm('还没把任何 2D 灯具发送到 PS,直接生成的话 AI 看不到灯光指引。继续吗?').then(function(ok) {
        if (ok) _submitLightGenerate(container, prompt, lossless);
      });
      return;
    }
  }

  _submitLightGenerate(container, prompt, lossless);
}

// 灯光生成提交(从 _doStartGenerate 抽出, 让"2D 无灯具"的异步确认能接续执行)
function _submitLightGenerate(container, prompt, lossless) {
  var model = container.querySelector('#lightModelInput').value;
  var size = container.querySelector('#lightSizeInput').value;
  var aspect = container.querySelector('#lightAspectRatioInput').value;
  var batch = Number(container.querySelector('#lightBatchInput').value) || 1;
  var timeout = Number(container.querySelector('#lightTimeoutInput').value) || 3600;

  var apiKey = '';
  var apiBaseUrl = '';
  if (window._settingsGetActiveConnection) {
    var conn = window._settingsGetActiveConnection(_curProvider);
    apiKey = conn.key;
    apiBaseUrl = conn.url;
    if (!apiKey || !apiBaseUrl) {
      if (conn._grsKeyPending) TileAPI.toast('正在准备夏算力, 请稍后再试', 'info');
      else if (conn._grsNeedLogin) TileAPI.toast('夏算力托管需要登录 (顶栏账号区), 或切回「自带 Key」', 'error');
      else TileAPI.toast('请先在顶栏配置 ' + _curProvider.toUpperCase() + ' 的 URL 和 Key', 'error');
      return;
    }
  } else {
    apiKey = TileAPI.storage.get('connection.' + _curProvider + '.key') || '';
    apiBaseUrl = TileAPI.storage.get('connection.' + _curProvider + '.url') || '';
    if (!apiKey || !apiBaseUrl) {
      TileAPI.toast('请先在顶栏配置 ' + _curProvider.toUpperCase() + ' 的 URL 和 Key', 'error');
      return;
    }
  }

  var taskId = 'light_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  var autoReturn = TileAPI.storage.get('output.autoReturn') !== false;

  var running = TileAPI.state.get('tasks.running') || {};
  running[taskId] = { batchSize: batch, startTime: Date.now(), success: 0, fail: 0, total: 0, model: '💡 ' + model, provider: _curProvider };
  TileAPI.state.set('tasks.running', running);
  var meta = TileAPI.state.get('tasks.meta') || {};
  meta[taskId] = { countdown: timeout, timeoutSec: timeout, autoReturn: autoReturn, batchSize: batch };
  TileAPI.state.set('tasks.meta', meta);
  TileAPI.emit('tasks:updated');
  TileAPI.emit('task:started', { taskId: taskId, timeoutSec: timeout, batchSize: batch });

  TileAPI.sendToHost('recordableRunSingle', {
    engine: 'api',
    taskId: taskId,
    prompt: prompt,
    apiKey: apiKey,
    apiBaseUrl: apiBaseUrl,
    model: model,
    size: size,
    aspectRatio: aspect,
    batchSize: batch,
    timeout: timeout,
    refImages: [],
    provider: _curProvider,
    autoReturn: autoReturn,
    layerType: lossless ? (TileAPI.storage.get('output.layerType') || 'smartObject') : 'smartObject',
    antiMode: 0
  });
  TileAPI.toast('灯光生成任务已提交', 'success');
}

// ============================================================
//  2D Tab 内容
// ============================================================
function _renderLight2D(body) {
  body.innerHTML = '<div class="lh-loading">正在加载...</div>';
  _loadLhManifest().then(function(m) {
    if (_currentTab !== '2d') return;
    if (!m.items || !m.items.length) {
      body.innerHTML = '<div class="lh-loading">未找到手绘图(检查 icons/light-handdrawn/)</div>';
      return;
    }
    _renderLight2DShell(body);
  });
}

function _renderLight2DShell(body) {
  var items = _lhManifest.items;
  var gridHtml = '<div class="lh-grid">';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    gridHtml +=
      '<div class="lh-grid-item" data-lh-file="' + _esc(it.file) + '">' +
        '<div class="lh-grid-thumb-wrap">' +
          '<img class="lh-grid-thumb" src="' + LH_IMG_BASE + _esc(it.file) + '" alt="' + _esc(it.name) + '">' +
        '</div>' +
        '<div class="lh-grid-name">' + _esc(it.name) + '</div>' +
        '<div class="lh-grid-check">✓</div>' +
      '</div>';
  }
  gridHtml += '</div>';

  body.innerHTML =
    '<div class="lh-2d-root">' +
      '<div class="lh-tip">点击附件选择并编辑 · 编辑完后点"发送到 PS"</div>' +
      gridHtml +
      '<div class="lh-panel" id="lhPanel"></div>' +
      '<div class="lh-list-wrap" id="lhListWrap"></div>' +
    '</div>';

  _bindLh2DGrid(body);
  _renderLh2DList(body);
  if (_lhSelectedFile) _lhOpenPanel(body, _lhSelectedFile, true);
}

function _bindLh2DGrid(body) {
  var items = body.querySelectorAll('.lh-grid-item');
  items.forEach(function(el) {
    el.addEventListener('click', function() {
      var f = el.dataset.lhFile;
      if (f === _lhSelectedFile) {
        _lhClosePanel(body);
      } else {
        _lhOpenPanel(body, f, false);
      }
    });
  });
}

function _lhOpenPanel(body, file, immediate) {
  _lhSelectedFile = file;
  var items = body.querySelectorAll('.lh-grid-item');
  items.forEach(function(el) {
    el.classList.toggle('lh-grid-item-active', el.dataset.lhFile === file);
  });
  var panel = body.querySelector('#lhPanel');
  if (!panel) return;
  _lhRenderPanelInner(panel);
  if (!panel.classList.contains('lh-panel-open')) {
    if (immediate) {
      panel.classList.add('lh-panel-open');
    } else {
      requestAnimationFrame(function() {
        panel.classList.add('lh-panel-open');
        setTimeout(function() {
          if (panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 350);
      });
    }
  }
}

function _lhClosePanel(body) {
  _lhSelectedFile = null;
  var items = body.querySelectorAll('.lh-grid-item');
  items.forEach(function(el) { el.classList.remove('lh-grid-item-active'); });
  var panel = body.querySelector('#lhPanel');
  if (panel) {
    panel.classList.remove('lh-panel-open');
    setTimeout(function() {
      if (!panel.classList.contains('lh-panel-open')) panel.innerHTML = '';
    }, 350);
  }
}

function _lhRenderPanelInner(panel) {
  var items = _lhManifest.items;
  var presets = _lhManifest.colorPresets || [];
  var item = null;
  for (var i = 0; i < items.length; i++) if (items[i].file === _lhSelectedFile) { item = items[i]; break; }
  if (!item) return;

  var ed = _lhGetEdit(_lhSelectedFile);
  var rgb = _hexToRgb(ed.color);
  var hsl = _rgbToHsl(rgb.r, rgb.g, rgb.b);

  var presetsHtml = '<div class="lh-presets">';
  for (var p = 0; p < presets.length; p++) {
    var pr = presets[p];
    var actSel = (pr.hex.toUpperCase() === ed.color.toUpperCase()) ? ' lh-preset-active' : '';
    presetsHtml +=
      '<button class="lh-preset' + actSel + '" data-lh-color="' + _esc(pr.hex) + '" title="' + _esc(pr.label) + '">' +
        '<span class="lh-preset-swatch" style="background:' + _esc(pr.hex) + ';"></span>' +
        '<span class="lh-preset-label">' + _esc(pr.label) + '</span>' +
      '</button>';
  }
  presetsHtml += '</div>';

  panel.innerHTML =
    '<div class="lh-panel-inner">' +
      '<div class="lh-panel-head">' +
        '<div class="lh-panel-title">编辑: ' + _esc(item.name) + '</div>' +
        '<button class="w10-btn lh-panel-close" id="lhPanelClose" title="收起">×</button>' +
      '</div>' +
      '<div class="lh-panel-body">' +
        '<div class="lh-stage">' +
          '<canvas class="lh-preview" id="lhPreview" width="' + LH_IMG_W + '" height="' + LH_IMG_H + '"></canvas>' +
        '</div>' +
        '<div class="lh-controls">' +
          '<div class="lh-section-title">色温</div>' +
          presetsHtml +
          '<div class="lh-section-title" style="margin-top:10px;">HSL 自定义</div>' +
          '<div class="lh-hsl-row"><label>H</label><input type="range" id="lhHslH" min="0" max="360" value="' + hsl.h + '"><span class="lh-hsl-val" id="lhHslHVal">' + hsl.h + '</span></div>' +
          '<div class="lh-hsl-row"><label>S</label><input type="range" id="lhHslS" min="0" max="100" value="' + hsl.s + '"><span class="lh-hsl-val" id="lhHslSVal">' + hsl.s + '</span></div>' +
          '<div class="lh-hsl-row"><label>L</label><input type="range" id="lhHslL" min="0" max="100" value="' + hsl.l + '"><span class="lh-hsl-val" id="lhHslLVal">' + hsl.l + '</span></div>' +
          '<div class="lh-section-title" style="margin-top:10px;">强度</div>' +
          '<div class="lh-intensity-row">' +
            '<input type="range" id="lhIntensity" min="0" max="1" step="0.05" value="' + ed.intensity + '">' +
            '<input type="number" class="w10-input lh-intensity-num" id="lhIntensityNum" min="0" max="1" step="0.05" value="' + ed.intensity.toFixed(2) + '">' +
          '</div>' +
          '<button class="w10-btn w10-btn-accent lh-send-btn" id="lhSendBtn">📤 发送到 PS</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  _bindLh2DPanel(panel);
  _lhDrawPreview(panel);
}

function _bindLh2DPanel(panel) {
  var closeBtn = panel.querySelector('#lhPanelClose');
  if (closeBtn) closeBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    if (_activeContainer) {
      var body = _activeContainer.querySelector('#lightTabBody');
      if (body) _lhClosePanel(body);
    }
  });

  panel.querySelectorAll('.lh-preset').forEach(function(btn) {
    btn.addEventListener('click', function() {
      _lhSetColor(panel, btn.dataset.lhColor, true);
    });
  });

  function _onHslChange() {
    var h = +panel.querySelector('#lhHslH').value;
    var s = +panel.querySelector('#lhHslS').value;
    var l = +panel.querySelector('#lhHslL').value;
    panel.querySelector('#lhHslHVal').textContent = h;
    panel.querySelector('#lhHslSVal').textContent = s;
    panel.querySelector('#lhHslLVal').textContent = l;
    var rgb = _hslToRgb(h, s, l);
    _lhSetColor(panel, _rgbToHex(rgb.r, rgb.g, rgb.b), false);
  }
  ['lhHslH','lhHslS','lhHslL'].forEach(function(id) {
    var el = panel.querySelector('#' + id);
    if (el) el.addEventListener('input', _onHslChange);
  });

  var intInp = panel.querySelector('#lhIntensity');
  var intNum = panel.querySelector('#lhIntensityNum');
  function _commitIntensity(v) {
    v = parseFloat(v);
    if (!isFinite(v)) v = LH_DEFAULT_INTENSITY;
    if (v < 0) v = 0;
    if (v > 1) v = 1;
    if (intInp) intInp.value = v;
    if (intNum) intNum.value = v.toFixed(2);
    var ed = _lhGetEdit(_lhSelectedFile);
    _lhSetEdit(_lhSelectedFile, ed.color, v);
    _lhDrawPreview(panel);
  }
  if (intInp) {
    intInp.addEventListener('input', function() { if (intNum) intNum.value = parseFloat(this.value).toFixed(2); });
    intInp.addEventListener('change', function() { _commitIntensity(this.value); });
  }
  if (intNum) {
    intNum.addEventListener('change', function() { _commitIntensity(this.value); });
    intNum.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); _commitIntensity(this.value); this.blur(); }
    });
  }

  var sendBtn = panel.querySelector('#lhSendBtn');
  if (sendBtn) sendBtn.addEventListener('click', function() { _lhDoSendToPS(); });

  // === 旋转把手拖拽 ===
  var canvas = panel.querySelector('#lhPreview');
  if (canvas) _bindRotateHandle(canvas, panel);
}

function _bindRotateHandle(canvas, panel) {
  var dragging = false;
  var dragStartAngle = 0;     // 鼠标按下时的角度(画布坐标系)
  var dragStartRotation = 0;  // 灯具按下时的初始旋转

  function _canvasPoint(ev) {
    // 把鼠标坐标映射回 canvas 内部坐标(canvas 在 DOM 中可能被缩放显示)
    var rect = canvas.getBoundingClientRect();
    var sx = canvas.width / rect.width;
    var sy = canvas.height / rect.height;
    var cx = (ev.clientX - rect.left) * sx;
    var cy = (ev.clientY - rect.top) * sy;
    return { x: cx, y: cy };
  }

  function _hitHandle(p) {
    var hp = panel._lhHandlePos;
    if (!hp) return false;
    var dx = p.x - hp.cx, dy = p.y - hp.cy;
    return (dx * dx + dy * dy) <= (hp.r * hp.r * 1.4);   // 1.4 倍宽容
  }

  function _angleFromCenter(p) {
    var hp = panel._lhHandlePos;
    if (!hp) return 0;
    // 用切片中心做参考(不是画布中心),用户拖把手就是绕切片中心旋转
    return Math.atan2(p.y - hp.sliceCy, p.x - hp.sliceCx) * 180 / Math.PI;
  }

  canvas.addEventListener('pointerdown', function(ev) {
    if (!_lhSelectedFile) return;
    var p = _canvasPoint(ev);
    if (!_hitHandle(p)) return;
    dragging = true;
    dragStartAngle = _angleFromCenter(p);
    var ed = _lhGetEdit(_lhSelectedFile);
    dragStartRotation = ed.rotation || 0;
    canvas.style.cursor = 'grabbing';
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) {}
    ev.preventDefault();
  });

  canvas.addEventListener('pointermove', function(ev) {
    if (!dragging) return;
    var p = _canvasPoint(ev);
    var nowAngle = _angleFromCenter(p);
    var deltaAngle = nowAngle - dragStartAngle;
    var newRot = dragStartRotation + deltaAngle;
    // 规整到 0-360
    newRot = ((newRot % 360) + 360) % 360;
    var ed = _lhGetEdit(_lhSelectedFile);
    _lhSetEdit(_lhSelectedFile, ed.color, ed.intensity, newRot);
    _lhDrawPreview(panel);
  });

  function _endDrag(ev) {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = '';
    try { canvas.releasePointerCapture(ev.pointerId); } catch (_) {}
  }
  canvas.addEventListener('pointerup', _endDrag);
  canvas.addEventListener('pointercancel', _endDrag);
  canvas.addEventListener('pointerleave', _endDrag);
}

function _lhSetColor(panel, hex, updateHslSliders) {
  var ed = _lhGetEdit(_lhSelectedFile);
  _lhSetEdit(_lhSelectedFile, hex, ed.intensity);

  panel.querySelectorAll('.lh-preset').forEach(function(btn) {
    btn.classList.toggle('lh-preset-active', btn.dataset.lhColor.toUpperCase() === hex.toUpperCase());
  });

  if (updateHslSliders) {
    var rgb = _hexToRgb(hex);
    var hsl = _rgbToHsl(rgb.r, rgb.g, rgb.b);
    var hH = panel.querySelector('#lhHslH'), hS = panel.querySelector('#lhHslS'), hL = panel.querySelector('#lhHslL');
    if (hH) { hH.value = hsl.h; panel.querySelector('#lhHslHVal').textContent = hsl.h; }
    if (hS) { hS.value = hsl.s; panel.querySelector('#lhHslSVal').textContent = hsl.s; }
    if (hL) { hL.value = hsl.l; panel.querySelector('#lhHslLVal').textContent = hsl.l; }
  }

  _lhDrawPreview(panel);
}

// ============================================================
//  画"无把手版本"到任意 canvas:用于导出到 PS
//  跟 _lhDrawPreview 共享逻辑,但只画切片+颜色点+强度+灯具名
// ============================================================
function _lhDrawSlicePure(canvas, ed, item) {
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, LH_IMG_W, LH_IMG_H);
  if (!_lhPreviewImg || !_lhPreviewImg.complete) return;

  var shortSide = Math.min(LH_IMG_W, LH_IMG_H);
  var bottomReserve = Math.round(shortSide * 0.12);
  var sliceArea = shortSide - bottomReserve;
  var sliceCx = LH_IMG_W / 2;
  var sliceCy = sliceArea / 2;

  // 切片(旋转)
  ctx.save();
  ctx.translate(sliceCx, sliceCy);
  ctx.rotate((ed.rotation || 0) * Math.PI / 180);
  ctx.translate(-sliceCx, -sliceCy);
  var sliceDrawSize = sliceArea;
  var sliceDrawX = (LH_IMG_W - sliceDrawSize) / 2;
  ctx.drawImage(_lhPreviewImg, sliceDrawX, 0, sliceDrawSize, sliceDrawSize);
  ctx.restore();

  // 颜色点
  var radius = shortSide * LH_DOT_RADIUS_RATIO;
  var cx = LH_IMG_W - shortSide * LH_DOT_OFFSET_RATIO;
  var cy = shortSide * LH_DOT_OFFSET_RATIO;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = ed.color;
  ctx.fill();
  ctx.lineWidth = Math.max(2, Math.round(radius * 0.05));
  ctx.strokeStyle = '#000000';
  ctx.stroke();

  // 强度数字
  var fontSize = Math.round(shortSide * 0.045);
  ctx.font = 'bold ' + fontSize + 'px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  var txt = ed.intensity.toFixed(2);
  var tx = cx - radius - shortSide * 0.012;
  var ty = cy;
  ctx.lineWidth = Math.max(4, Math.round(fontSize * 0.18));
  ctx.strokeStyle = '#000000';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.strokeText(txt, tx, ty);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(txt, tx, ty);

  // 灯具名字(底部)
  var nameStr = item ? item.name : '';
  if (nameStr) {
    var nameFont = Math.round(shortSide * 0.07);
    ctx.font = 'bold ' + nameFont + 'px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    var nameY = LH_IMG_H - Math.round(shortSide * 0.025);
    var nameX = LH_IMG_W / 2;
    ctx.lineWidth = Math.max(6, Math.round(nameFont * 0.18));
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeText(nameStr, nameX, nameY);
    ctx.fillStyle = '#000000';
    ctx.fillText(nameStr, nameX, nameY);
  }
}

function _lhDrawPreview(panel, opts) {
  opts = opts || {};
  if (!_lhSelectedFile) return;
  var canvas = panel.querySelector('#lhPreview');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var ed = _lhGetEdit(_lhSelectedFile);
  ctx.clearRect(0, 0, LH_IMG_W, LH_IMG_H);

  if (!_lhPreviewImg || _lhPreviewImg._file !== _lhSelectedFile || !_lhPreviewImg.complete) {
    _lhPreviewImg = new Image();
    _lhPreviewImg._file = _lhSelectedFile;
    _lhPreviewImg.onload = function() { _lhDrawPreview(panel); };
    _lhPreviewImg.onerror = function() { TileAPI.log('[手绘灯光] 图片加载失败: ' + _lhSelectedFile, 'error'); };
    _lhPreviewImg.src = LH_IMG_BASE + _lhSelectedFile;
    return;
  }

  var shortSide = Math.min(LH_IMG_W, LH_IMG_H);
  // 留出底部 ~12% 给文字标签
  var bottomReserve = Math.round(shortSide * 0.12);
  var sliceArea = shortSide - bottomReserve;     // 切片绘制区域是个正方形,高度被压缩
  var sliceCx = LH_IMG_W / 2;
  var sliceCy = sliceArea / 2;                    // 切片旋转中心:画布上半部分中心(避开底部文字)

  // === 1. 切片本体(旋转) ===
  ctx.save();
  ctx.translate(sliceCx, sliceCy);
  ctx.rotate((ed.rotation || 0) * Math.PI / 180);
  ctx.translate(-sliceCx, -sliceCy);
  // 把切片画到上半部分的正方形区域内,保持等比缩放
  var sliceDrawSize = sliceArea;
  var sliceDrawX = (LH_IMG_W - sliceDrawSize) / 2;
  var sliceDrawY = 0;
  ctx.drawImage(_lhPreviewImg, sliceDrawX, sliceDrawY, sliceDrawSize, sliceDrawSize);
  ctx.restore();

  // === 2. 颜色点(不旋转,固定右上角) ===
  var radius = shortSide * LH_DOT_RADIUS_RATIO;
  var cx = LH_IMG_W - shortSide * LH_DOT_OFFSET_RATIO;
  var cy = shortSide * LH_DOT_OFFSET_RATIO;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = ed.color;
  ctx.fill();
  // 颜色点描黑边,在浅切片上更醒目
  ctx.lineWidth = Math.max(2, Math.round(radius * 0.05));
  ctx.strokeStyle = '#000000';
  ctx.stroke();

  // === 3. 强度数字(跟颜色点关联,不旋转) ===
  var fontSize = Math.round(shortSide * 0.045);
  ctx.font = 'bold ' + fontSize + 'px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  var txt = ed.intensity.toFixed(2);
  var tx = cx - radius - shortSide * 0.012;
  var ty = cy;
  ctx.lineWidth = Math.max(4, Math.round(fontSize * 0.18));
  ctx.strokeStyle = '#000000';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.strokeText(txt, tx, ty);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(txt, tx, ty);

  // === 4. 灯具名字(画布正下方,水平,不旋转) ===
  var item = null;
  for (var ii = 0; ii < _lhManifest.items.length; ii++) {
    if (_lhManifest.items[ii].file === _lhSelectedFile) { item = _lhManifest.items[ii]; break; }
  }
  var nameStr = item ? item.name : '';
  if (nameStr) {
    var nameFont = Math.round(shortSide * 0.07);
    ctx.font = 'bold ' + nameFont + 'px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    var nameY = LH_IMG_H - Math.round(shortSide * 0.025);   // 离底部 ~2.5%
    var nameX = LH_IMG_W / 2;
    ctx.lineWidth = Math.max(6, Math.round(nameFont * 0.18));
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeText(nameStr, nameX, nameY);
    ctx.fillStyle = '#000000';
    ctx.fillText(nameStr, nameX, nameY);
  }

  // === 5. 旋转把手(画布左上角,不旋转) ===
  // 视觉:一个圆盘 + 内部 ↻ 图标,表示"可拖动旋转"
  // 注意:导出 (skipHandle:true) 时不画,避免烘焙进 PS 图层
  var handleSize = shortSide * 0.07;
  var hx = shortSide * LH_DOT_OFFSET_RATIO;
  var hy = shortSide * LH_DOT_OFFSET_RATIO;
  if (!opts.skipHandle) {
    // 阴影背板
    ctx.beginPath();
    ctx.arc(hx, hy, handleSize, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(170, 120, 255, 0.85)';
    ctx.fill();
    ctx.lineWidth = Math.max(2, Math.round(handleSize * 0.05));
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();
    // ↻ 符号(用 unicode)
    var hFontSize = Math.round(handleSize * 1.2);
    ctx.font = 'bold ' + hFontSize + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('↻', hx, hy + Math.round(handleSize * 0.05));

    // 旋转角度文字(在把手下方)
    var angFont = Math.round(shortSide * 0.032);
    ctx.font = 'bold ' + angFont + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var angTxt = Math.round(((ed.rotation || 0) % 360 + 360) % 360) + '°';
    var angX = hx;
    var angY = hy + handleSize + Math.round(shortSide * 0.012);
    ctx.lineWidth = Math.max(3, Math.round(angFont * 0.18));
    ctx.strokeStyle = '#000000';
    ctx.lineJoin = 'round';
    ctx.strokeText(angTxt, angX, angY);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(angTxt, angX, angY);
  }

  // 把手坐标缓存到 panel 上,给交互用(无论是否绘制把手都要缓存,因为 hit-test 需要)
  panel._lhHandlePos = { cx: hx, cy: hy, r: handleSize, sliceCx: sliceCx, sliceCy: sliceCy };
}

function _lhDoSendToPS() {
  if (!_lhSelectedFile || !_activeContainer) return;
  var canvas = _activeContainer.querySelector('#lhPreview');
  if (!canvas) return;
  var panel = _activeContainer.querySelector('#lhPanel');
  if (!panel) return;

  var ed = _lhGetEdit(_lhSelectedFile);
  var item = null;
  for (var i = 0; i < _lhManifest.items.length; i++) {
    if (_lhManifest.items[i].file === _lhSelectedFile) { item = _lhManifest.items[i]; break; }
  }
  if (!item) return;

  // 导出前:用临时 canvas 重新画一次"无把手版"(避免触碰预览 canvas,杜绝时序竞态)
  var dataUrl;
  if (_lhPreviewImg && _lhPreviewImg.complete) {
    var tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = LH_IMG_W;
    tmpCanvas.height = LH_IMG_H;
    _lhDrawSlicePure(tmpCanvas, ed, item);
    dataUrl = tmpCanvas.toDataURL('image/png');
  } else {
    // 兜底:图片没加载好,只能用主 canvas
    _lhDrawPreview(panel, { skipHandle: true });
    dataUrl = canvas.toDataURL('image/png');
    _lhDrawPreview(panel);
  }
  var base64 = dataUrl.split(',')[1];
  var rotPart = (ed.rotation && Math.round(ed.rotation) !== 0) ? '-' + Math.round(ed.rotation) + '°' : '';
  var layerName = '灯光-' + item.name + '-' + ed.color + '-' + ed.intensity.toFixed(2) + rotPart;

  var itemId = 'lh_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
  var reqId = 'lh_place_' + Date.now() + '_' + (++_lhPlaceSeq);
  TileAPI.toast('正在置入 PS...', 'info');
  var pending = { itemId: itemId, createdAt: Date.now(), timer: null };
  pending.timer = setTimeout(function() {
    if (!_lhPendingPlaces[reqId]) return;
    delete _lhPendingPlaces[reqId];
    _lights2D = _lights2D.filter(function(it) { return it.id !== itemId; });
    _lh2DSave();
    _renderLh2DList();
    TileAPI.toast('灯光置入超时，已从列表撤回', 'error');
  }, 190000);
  _lhPendingPlaces[reqId] = pending;
  TileAPI.sendToHost('lightHandPlace', { reqId: reqId, base64: base64, layerName: layerName });

  // 先显示在列表里；Host 明确失败时按 reqId 精确回滚这一条。
  _lights2D.push({
    id: itemId,
    file: _lhSelectedFile,
    name: item.name,
    color: ed.color,
    intensity: ed.intensity,
    rotation: ed.rotation || 0
  });
  _renderLh2DList();
}

function _renderLh2DList(body) {
  if (!body && _activeContainer) body = _activeContainer.querySelector('#lightTabBody');
  if (!body) return;
  var wrap = body.querySelector('#lhListWrap');
  if (!wrap) return;
  if (_lights2D.length === 0) {
    wrap.innerHTML = '<div class="lh-list-empty">尚未发送任何灯光示意到 PS</div>';
    return;
  }
  var html = '<div class="lh-list-title">已发送的灯光示意 (' + _lights2D.length + ')</div><div class="lh-list">';
  for (var i = 0; i < _lights2D.length; i++) {
    var lt = _lights2D[i];
    html +=
      '<div class="lh-list-item" data-lh-id="' + _esc(lt.id) + '">' +
        '<span class="lh-list-dot" style="background:' + _esc(lt.color) + ';"></span>' +
        '<span class="lh-list-text">' + (i + 1) + '. ' + _esc(lt.name) + ' · ' + _esc(lt.color) + ' · ' + lt.intensity.toFixed(2) + '</span>' +
        '<span class="lh-list-del" data-lh-id="' + _esc(lt.id) + '" title="从列表移除(不删 PS 图层)">✕</span>' +
      '</div>';
  }
  html += '</div>';
  wrap.innerHTML = html;
  wrap.querySelectorAll('.lh-list-del').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var id = btn.dataset.lhId;
      _lights2D = _lights2D.filter(function(x) { return x.id !== id; });
      _lh2DSave();
      _renderLh2DList();
    });
  });
}

// ============================================================
//  3D Tab 内容
// ============================================================
function _renderLight3D(body) {
  body.innerHTML =
    '<div class="light3d-panel">' +
      '<div class="light3d-canvas-wrap">' +
        '<canvas id="lightCanvas" class="light3d-canvas" width="400" height="300"></canvas>' +
        '<input type="range" id="lightZoomSlider" class="light3d-zoom-slider" min="0.3" max="3.5" step="0.05" value="1.0" title="缩放(滚轮也可)"/>' +
        '<div id="btnLightCapture" class="light3d-capture-btn" title="从 PS 选区截取图像">📷 加载图像</div>' +
      '</div>' +
      '<div class="light3d-controls">' +
        '<div class="light3d-row">' +
          '<span class="light3d-dot light3d-dot-az"></span>' +
          '<label class="light3d-label">方位</label>' +
          '<input type="range" id="lightAzimuth" class="light3d-slider light3d-slider-az" min="0" max="315" step="1" value="45"/>' +
          '<span id="lightAzVal" class="light3d-val light3d-val-az">45°</span>' +
          '<span id="lightAzReset" class="light3d-reset" title="重置">↺</span>' +
        '</div>' +
        '<div class="light3d-row">' +
          '<span class="light3d-dot light3d-dot-el"></span>' +
          '<label class="light3d-label">仰角</label>' +
          '<input type="range" id="lightElevation" class="light3d-slider light3d-slider-el" min="-90" max="90" step="1" value="30"/>' +
          '<span id="lightElVal" class="light3d-val light3d-val-el">30°</span>' +
          '<span id="lightElReset" class="light3d-reset" title="重置">↺</span>' +
        '</div>' +
        '<div class="light3d-row">' +
          '<span class="light3d-dot light3d-dot-ds"></span>' +
          '<label class="light3d-label">距离</label>' +
          '<input type="range" id="lightDistance" class="light3d-slider light3d-slider-ds" min="0.6" max="4.0" step="0.1" value="1.0"/>' +
          '<span id="lightDsVal" class="light3d-val light3d-val-ds">1.0</span>' +
          '<span id="lightDsReset" class="light3d-reset" title="重置">↺</span>' +
        '</div>' +
      '</div>' +
      '<div class="light3d-attrs">' +
        '<div class="light3d-attr-row">' +
          '<label class="light3d-attr-label">光源类型</label>' +
          '<div class="sf-pill" id="lightTypePill"><span class="sf-pill-opt active" data-val="spot light">聚光</span><span class="sf-pill-opt" data-val="point light">点光</span><span class="sf-pill-opt" data-val="area light">面光</span><span class="sf-pill-opt" data-val="directional light">平行光</span><span class="sf-pill-opt" data-val="ambient light">环境光</span></div>' +
          '<div class="sf-pill" id="lightNaturalPill" style="margin-top:3px;"><span class="sf-pill-opt" data-val="sunlight">日照</span><span class="sf-pill-opt" data-val="daylight">自然光</span><span class="sf-pill-opt" data-val="moonlight">月光</span><span class="sf-pill-opt" data-val="golden hour light">黄昏光</span><span class="sf-pill-opt" data-val="overcast light">阴天光</span></div>' +
        '</div>' +
        '<div class="light3d-attr-row">' +
          '<label class="light3d-attr-label">布光角色</label>' +
          '<div class="sf-pill" id="lightRolePill"><span class="sf-pill-opt active" data-val="key light">主光</span><span class="sf-pill-opt" data-val="fill light">补光</span><span class="sf-pill-opt" data-val="rim light">轮廓光</span><span class="sf-pill-opt" data-val="back light">背光</span><span class="sf-pill-opt" data-val="side light">侧光</span></div>' +
        '</div>' +
        '<div class="light3d-attr-row">' +
          '<label class="light3d-attr-label">光强</label>' +
          '<div class="sf-pill" id="lightIntensityPill"><span class="sf-pill-opt" data-val="low-intensity">弱</span><span class="sf-pill-opt active" data-val="medium-intensity">中</span><span class="sf-pill-opt" data-val="high-intensity">强</span></div>' +
          '<div class="sf-pill" id="lightExposurePill" style="margin-top:3px;"><span class="sf-pill-opt active" data-val="">无特效</span><span class="sf-pill-opt" data-val=", with blown highlights">高光溢出</span><span class="sf-pill-opt" data-val=", overexposed">过曝</span></div>' +
        '</div>' +
        '<div class="light3d-attr-row">' +
          '<label class="light3d-attr-label">色温 / 颜色</label>' +
          '<div class="light3d-color-row"><div class="sf-pill" id="lightColorModePill"><span class="sf-pill-opt active" data-val="kelvin">色温K</span><span class="sf-pill-opt" data-val="hsl">取色器</span></div></div>' +
          '<div id="lightKelvinRow" class="light3d-kelvin" style="display:flex;"><input type="range" id="lightKelvin" min="2000" max="10000" step="100" value="5500" style="flex:1;accent-color:#ffa500;"/><span id="lightKelvinVal" class="light3d-kelvin-val">5500K</span></div>' +
          '<div id="lightHslRow" class="light3d-hsl-row" style="display:none;"><input type="color" id="lightColorPicker" class="light3d-color-picker" value="#ffffff"/><span id="lightColorVal" class="light3d-color-val">#ffffff</span></div>' +
        '</div>' +
      '</div>' +
      '<div id="btnAddLight" class="light3d-btn-add">➕ 添加灯光</div>' +
      '<div id="lightList"></div>' +
      '<div id="lightPromptPreview" class="light3d-preview">尚未添加灯光</div>' +
    '</div>';

  // 启动 3D 实例;返回的对象包含 cleanup + getPrompt
  var inst = _initLightWebGL(body);
  if (inst) {
    _3dCleanup = inst.cleanup;
    _3dGetPromptFn = inst.getPrompt;
  }
}

// ============================================================
//  WebGL 初始化(原 tile-light 的 3D 核心,完整保留)
// ============================================================
function _initLightWebGL(container) {
  function $id(id) { return container.querySelector('#' + id); }

  var lCanvas = $id('lightCanvas');
  if (!lCanvas) return null;
  var gl = lCanvas.getContext('webgl', {alpha:false, antialias:true, preserveDrawingBuffer:false})
        || lCanvas.getContext('experimental-webgl', {alpha:false, antialias:true});
  if (!gl) { console.error('[灯光] WebGL not supported'); return null; }

  var lSlAz = $id('lightAzimuth'), lSlEl = $id('lightElevation'), lSlDs = $id('lightDistance');
  var lLbAz = $id('lightAzVal'), lLbEl = $id('lightElVal'), lLbDs = $id('lightDsVal');
  var _lightImage = null;
  // _lights 用模块级变量 (持久化到 storage); 不再在函数内部 var 遮蔽

  var AZ_MAP_L = [[0,'front view'],[45,'three-quarter front-right view'],[90,'right-side view'],[135,'three-quarter back-right view'],[180,'back view'],[225,'three-quarter back-left view'],[270,'left-side view'],[315,'three-quarter front-left view']];
  var EL_MAP_L = [[-90,"worm's-eye view"],[-60,'extreme low-angle shot'],[-30,'low-angle shot'],[0,'eye-level'],[30,'slightly high-angle'],[60,'high-angle'],[90,'top-down']];
  var DS_MAP_L = [[0.6,'very close'],[0.8,'close'],[1.0,'near'],[1.4,'medium distance'],[2.0,'far'],[3.0,'distant'],[4.0,'very distant']];
  var L_AZ_CN = {0:'正面',45:'右前',90:'右侧',135:'右后',180:'背面',225:'左后',270:'左侧',315:'左前'};
  var L_EL_CN = {'-90':'仰拍','-60':'强仰','-30':'微仰','0':'平视','30':'微俯','60':'高俯','90':'鸟瞰'};
  var L_DS_CN = {'0.6':'极近','0.8':'近','1':'中近','1.4':'中','2':'远','3':'很远','4':'极远'};

  function nearestL(map, val) { var best=map[0],bd=Math.abs(val-map[0][0]); for(var i=1;i<map.length;i++){var d=Math.abs(val-map[i][0]);if(d<bd){bd=d;best=map[i];}} return best[1]; }
  function nearestCN(map, val) { var bk=Object.keys(map)[0],bd=Math.abs(val-Number(bk)); for(var k in map){var d=Math.abs(val-Number(k));if(d<bd){bd=d;bk=k;}} return map[bk]; }

  var LIGHT_PREFIX = 'Do not change the overall exposure, brightness or gamma of the scene. Only add new light sources on top of the existing lighting. ';
  var LIGHT_SUFFIX = ' Strictly preserve the subject\'s pose, gesture, facial expression and body posture. Keep the background composition, subject position and existing color grading completely unchanged.';

  // mat4 工具
  function m4() { return new Float32Array(16); }
  function m4_perspective(o, fovY, aspect, near, far) {
      for(var i=0;i<16;i++) o[i]=0;
      var f = 1.0 / Math.tan(fovY / 2);
      o[0] = f / aspect; o[5] = f;
      o[10] = (far + near) / (near - far);
      o[11] = -1;
      o[14] = (2 * far * near) / (near - far);
      return o;
  }
  function m4_lookAt(o, ex,ey,ez, cx,cy,cz, ux,uy,uz) {
      var fx=cx-ex, fy=cy-ey, fz=cz-ez;
      var fl=Math.sqrt(fx*fx+fy*fy+fz*fz)||1; fx/=fl;fy/=fl;fz/=fl;
      var sx=fy*uz-fz*uy, sy=fz*ux-fx*uz, sz=fx*uy-fy*ux;
      var sl=Math.sqrt(sx*sx+sy*sy+sz*sz)||1; sx/=sl;sy/=sl;sz/=sl;
      var ux2=sy*fz-sz*fy, uy2=sz*fx-sx*fz, uz2=sx*fy-sy*fx;
      o[0]=sx; o[1]=ux2; o[2]=-fx; o[3]=0;
      o[4]=sy; o[5]=uy2; o[6]=-fy; o[7]=0;
      o[8]=sz; o[9]=uz2; o[10]=-fz; o[11]=0;
      o[12]=-(sx*ex+sy*ey+sz*ez);
      o[13]=-(ux2*ex+uy2*ey+uz2*ez);
      o[14]=(fx*ex+fy*ey+fz*ez);
      o[15]=1;
      return o;
  }
  function m4_mul(o, a, b) {
      var t = m4();
      for(var i=0;i<4;i++) for(var j=0;j<4;j++) {
          t[j*4+i] = a[i]*b[j*4] + a[4+i]*b[j*4+1] + a[8+i]*b[j*4+2] + a[12+i]*b[j*4+3];
      }
      for(var k=0;k<16;k++) o[k]=t[k];
      return o;
  }

  // Shaders
  var LINE_VS = 'attribute vec3 aPos; attribute vec4 aCol; uniform mat4 uMVP; varying vec4 vCol; void main(){ gl_Position = uMVP * vec4(aPos, 1.0); vCol = aCol; }';
  var LINE_FS = 'precision mediump float; varying vec4 vCol; void main(){ gl_FragColor = vCol; }';
  var POINT_VS = 'attribute vec3 aPos; attribute vec4 aCol; attribute float aSize; uniform mat4 uMVP; varying vec4 vCol; void main(){ gl_Position = uMVP * vec4(aPos, 1.0); gl_PointSize = aSize; vCol = aCol; }';
  var POINT_FS = 'precision mediump float; varying vec4 vCol; void main(){ float d = distance(gl_PointCoord, vec2(0.5)); if(d > 0.5) discard; float glow = smoothstep(0.5, 0.15, d); gl_FragColor = vec4(vCol.rgb, vCol.a * glow); }';
  var TEX_VS = 'attribute vec3 aPos; attribute vec2 aUV; uniform mat4 uMVP; varying vec2 vUV; void main(){ gl_Position = uMVP * vec4(aPos, 1.0); vUV = aUV; }';
  var TEX_FS = 'precision mediump float; varying vec2 vUV; uniform sampler2D uTex; uniform float uAlpha; void main(){ vec4 c = texture2D(uTex, vUV); gl_FragColor = vec4(c.rgb, c.a * uAlpha); }';

  function compileShader(src, type) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error('[灯光GL]', gl.getShaderInfoLog(s)); gl.deleteShader(s); return null; }
      return s;
  }
  function createProgram(vs, fs, attribs) {
      var v = compileShader(vs, gl.VERTEX_SHADER), f = compileShader(fs, gl.FRAGMENT_SHADER);
      if (!v || !f) return null;
      var p = gl.createProgram(); gl.attachShader(p, v); gl.attachShader(p, f);
      if (attribs) attribs.forEach(function(a, i) { gl.bindAttribLocation(p, i, a); });
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error('[灯光GL] link:', gl.getProgramInfoLog(p)); return null; }
      return p;
  }

  var progLine, progPoint, progTex;
  var uMVP_line, uMVP_point, uMVP_tex, uTex_tex, uAlpha_tex;
  var aPos_line, aCol_line, aPos_point, aCol_point, aSize_point, aPos_tex, aUV_tex;

  function initShaders() {
      progLine = createProgram(LINE_VS, LINE_FS, ['aPos','aCol']);
      uMVP_line = gl.getUniformLocation(progLine, 'uMVP');
      aPos_line = 0; aCol_line = 1;
      progPoint = createProgram(POINT_VS, POINT_FS, ['aPos','aCol','aSize']);
      uMVP_point = gl.getUniformLocation(progPoint, 'uMVP');
      aPos_point = 0; aCol_point = 1; aSize_point = 2;
      progTex = createProgram(TEX_VS, TEX_FS, ['aPos','aUV']);
      uMVP_tex = gl.getUniformLocation(progTex, 'uMVP');
      uTex_tex = gl.getUniformLocation(progTex, 'uTex');
      uAlpha_tex = gl.getUniformLocation(progTex, 'uAlpha');
      aPos_tex = 0; aUV_tex = 1;
  }

  var bufLine, bufPoint, bufTex, bufTexIdx;
  function initBuffers() {
      bufLine = gl.createBuffer(); bufPoint = gl.createBuffer();
      bufTex = gl.createBuffer(); bufTexIdx = gl.createBuffer();
      var idx = new Uint16Array([0,1,2, 0,2,3]);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufTexIdx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  }

  var hudCanvas, hudCtx;
  function initHud() {
      hudCanvas = document.createElement('canvas');
      hudCanvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';
      lCanvas.parentNode.appendChild(hudCanvas);
  }
  function resizeHud() {
      var rect = lCanvas.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      hudCanvas.width = Math.round(rect.width * dpr);
      hudCanvas.height = Math.round(rect.height * dpr);
      hudCtx = hudCanvas.getContext('2d');
      hudCtx.scale(dpr, dpr);
  }

  var _camAz = 180 + 25, _camEl = 25, _camDist = 6.5;
  var _lightZoom = 1.0;
  var LCW, LCH;
  var mvpMat = m4(), viewMat = m4(), projMat = m4();

  function updateMVP() {
      var ar = LCW / LCH;
      var fov = (45 / _lightZoom) * Math.PI / 180;
      m4_perspective(projMat, fov, ar, 0.1, 100);
      var azR = _camAz * Math.PI / 180, elR = _camEl * Math.PI / 180;
      var ex = _camDist * Math.cos(elR) * Math.sin(azR);
      var ey = _camDist * Math.cos(elR) * Math.cos(azR);
      var ez = _camDist * Math.sin(elR);
      m4_lookAt(viewMat, ex, ey, ez, 0, 0, 0, 0, 0, 1);
      m4_mul(mvpMat, projMat, viewMat);
  }

  function project3dToScreen(x3, y3, z3) {
      var m = mvpMat;
      var cx = m[0]*x3 + m[4]*y3 + m[8]*z3 + m[12];
      var cy = m[1]*x3 + m[5]*y3 + m[9]*z3 + m[13];
      var cw = m[3]*x3 + m[7]*y3 + m[11]*z3 + m[15];
      if (Math.abs(cw) < 0.0001) cw = 0.0001;
      var ndcX = cx / cw, ndcY = cy / cw;
      var rect = lCanvas.getBoundingClientRect();
      return { x: (ndcX * 0.5 + 0.5) * rect.width, y: (1.0 - (ndcY * 0.5 + 0.5)) * rect.height };
  }
  function unprojectToGround(sx, sy) {
      var rect = lCanvas.getBoundingClientRect();
      var nx = (sx / rect.width) * 2.0 - 1.0;
      var ny = 1.0 - (sy / rect.height) * 2.0;
      var azR = _camAz * Math.PI / 180, elR = _camEl * Math.PI / 180;
      var ex = _camDist * Math.cos(elR) * Math.sin(azR);
      var ey = _camDist * Math.cos(elR) * Math.cos(azR);
      var ez = _camDist * Math.sin(elR);
      var fx = -ex, fy = -ey, fz = -ez;
      var fl = Math.sqrt(fx*fx+fy*fy+fz*fz)||1; fx/=fl;fy/=fl;fz/=fl;
      var rx = fy*1-fz*0, ry = fz*0-fx*1, rz = fx*0-fy*0;
      var rl = Math.sqrt(rx*rx+ry*ry+rz*rz)||1; rx/=rl;ry/=rl;rz/=rl;
      var ux = ry*fz-rz*fy, uy = rz*fx-rx*fz, uz = rx*fy-ry*fx;
      var fov = (45 / _lightZoom) * Math.PI / 180;
      var halfH = Math.tan(fov / 2);
      var ar = LCW / LCH;
      var halfW = halfH * ar;
      var dx = fx + rx * nx * halfW + ux * ny * halfH;
      var dy = fy + ry * nx * halfW + uy * ny * halfH;
      var dz = fz + rz * nx * halfW + uz * ny * halfH;
      if (Math.abs(dz) < 0.0001) return {x:ex, y:ey};
      var t = -ez / dz;
      return { x: ex + dx*t, y: ey + dy*t };
  }

  function lSpherical(azDeg, elDeg, ds) {
      var a = azDeg * Math.PI / 180, e = elDeg * Math.PI / 180;
      var r = 0.5 + ((ds - 0.6) / 3.4) * 0.9;
      return { x: r * Math.cos(e) * Math.sin(a), y: -r * Math.cos(e) * Math.cos(a), z: r * Math.sin(e) };
  }
  function kelvinToColor(k) {
      var t = k / 100; var r, g, b;
      if (t <= 66) { r = 255; g = 99.4708 * Math.log(t) - 161.12; b = t <= 19 ? 0 : 138.5177 * Math.log(t - 10) - 305.0448; }
      else { r = 329.698 * Math.pow(t - 60, -0.1332); g = 288.122 * Math.pow(t - 60, -0.0755); b = 255; }
      r = Math.max(0, Math.min(255, Math.round(r)));
      g = Math.max(0, Math.min(255, Math.round(g)));
      b = Math.max(0, Math.min(255, Math.round(b)));
      return [r/255, g/255, b/255];
  }
  function hexToRGB(hex) {
      return [parseInt(hex.substr(1,2),16)/255, parseInt(hex.substr(3,2),16)/255, parseInt(hex.substr(5,2),16)/255];
  }

  function drawLines(verts, mode) {
      if (!verts.length) return;
      gl.useProgram(progLine);
      gl.uniformMatrix4fv(uMVP_line, false, mvpMat);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufLine);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(aPos_line);
      gl.enableVertexAttribArray(aCol_line);
      gl.vertexAttribPointer(aPos_line, 3, gl.FLOAT, false, 28, 0);
      gl.vertexAttribPointer(aCol_line, 4, gl.FLOAT, false, 28, 12);
      gl.drawArrays(mode || gl.LINES, 0, verts.length / 7);
      gl.disableVertexAttribArray(aPos_line);
      gl.disableVertexAttribArray(aCol_line);
  }
  function drawPoints(verts) {
      if (!verts.length) return;
      gl.useProgram(progPoint);
      gl.uniformMatrix4fv(uMVP_point, false, mvpMat);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufPoint);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(aPos_point);
      gl.enableVertexAttribArray(aCol_point);
      gl.enableVertexAttribArray(aSize_point);
      gl.vertexAttribPointer(aPos_point, 3, gl.FLOAT, false, 32, 0);
      gl.vertexAttribPointer(aCol_point, 4, gl.FLOAT, false, 32, 12);
      gl.vertexAttribPointer(aSize_point, 1, gl.FLOAT, false, 32, 28);
      gl.drawArrays(gl.POINTS, 0, verts.length / 8);
      gl.disableVertexAttribArray(aPos_point);
      gl.disableVertexAttribArray(aCol_point);
      gl.disableVertexAttribArray(aSize_point);
  }
  var _imgTexture = null;
  function updateImageTexture() {
      if (!_lightImage || !_lightImage.complete || _lightImage.naturalWidth === 0) return;
      if (!_imgTexture) _imgTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, _imgTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, _lightImage);
  }
  function drawTexturedQuad(corners, alpha) {
      var verts = new Float32Array([
          corners[0][0],corners[0][1],corners[0][2], 0,0,
          corners[1][0],corners[1][1],corners[1][2], 1,0,
          corners[2][0],corners[2][1],corners[2][2], 1,1,
          corners[3][0],corners[3][1],corners[3][2], 0,1
      ]);
      gl.useProgram(progTex);
      gl.uniformMatrix4fv(uMVP_tex, false, mvpMat);
      gl.uniform1i(uTex_tex, 0);
      gl.uniform1f(uAlpha_tex, alpha);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, _imgTexture);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufTex);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(aPos_tex);
      gl.enableVertexAttribArray(aUV_tex);
      gl.vertexAttribPointer(aPos_tex, 3, gl.FLOAT, false, 20, 0);
      gl.vertexAttribPointer(aUV_tex, 2, gl.FLOAT, false, 20, 12);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufTexIdx);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      gl.disableVertexAttribArray(aPos_tex);
      gl.disableVertexAttribArray(aUV_tex);
  }
  function drawSolidQuad(corners, r, g, b, a) {
      var c = corners;
      var verts = new Float32Array([
          c[0][0],c[0][1],c[0][2], r,g,b,a,
          c[1][0],c[1][1],c[1][2], r,g,b,a,
          c[2][0],c[2][1],c[2][2], r,g,b,a,
          c[0][0],c[0][1],c[0][2], r,g,b,a,
          c[2][0],c[2][1],c[2][2], r,g,b,a,
          c[3][0],c[3][1],c[3][2], r,g,b,a
      ]);
      gl.useProgram(progLine);
      gl.uniformMatrix4fv(uMVP_line, false, mvpMat);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufLine);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(aPos_line);
      gl.enableVertexAttribArray(aCol_line);
      gl.vertexAttribPointer(aPos_line, 3, gl.FLOAT, false, 28, 0);
      gl.vertexAttribPointer(aCol_line, 4, gl.FLOAT, false, 28, 12);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.disableVertexAttribArray(aPos_line);
      gl.disableVertexAttribArray(aCol_line);
  }

  function buildGridVerts() {
      var v = [], gridR = 1.5, gridN = 6;
      for (var gi = -gridN; gi <= gridN; gi++) {
          var gv = gi / gridN * gridR;
          v.push(-gridR,gv,0, 1,1,1,0.05,  gridR,gv,0, 1,1,1,0.05);
          v.push(gv,-gridR,0, 1,1,1,0.05,  gv,gridR,0, 1,1,1,0.05);
      }
      return new Float32Array(v);
  }
  function buildRingVerts(radius, axis, r, g, b, a, segments) {
      var v = [], n = segments || 64;
      for (var i = 0; i <= n; i++) {
          var t = i / n * Math.PI * 2; var px, py, pz;
          if (axis === 'z') { px = radius*Math.cos(t); py = radius*Math.sin(t); pz = 0; }
          else if (axis === 'x') { px = 0; py = radius*Math.cos(t); pz = radius*Math.sin(t); }
          else { px = radius*Math.cos(t); py = 0; pz = radius*Math.sin(t); }
          v.push(px, py, pz, r, g, b, a);
      }
      return new Float32Array(v);
  }
  function buildElevArcVerts(azDeg, radius, r, g, b, a) {
      var v = [], azRad = azDeg * Math.PI / 180;
      var dir = { x: Math.sin(azRad), y: -Math.cos(azRad) };
      for (var i = 0; i <= 32; i++) {
          var angle = (-90 + 180 * i / 32) * Math.PI / 180;
          v.push(dir.x * radius * Math.cos(angle), dir.y * radius * Math.cos(angle), radius * Math.sin(angle), r, g, b, a);
      }
      return new Float32Array(v);
  }

  var COL_AZ = [0.33, 0.76, 1.0];
  var COL_EL = [0.73, 0.45, 1.0];
  var COL_DS = [1.0,  0.58, 0.22];

  function drawLightCanvas() {
      if (!gl) return;
      updateMVP();
      gl.viewport(0, 0, LCW, LCH);
      gl.clearColor(0.14, 0.14, 0.14, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);

      var curAz = Number(lSlAz.value), curEl = Number(lSlEl.value), curDs = Number(lSlDs.value);
      var lightPos = lSpherical(curAz, curEl, curDs);
      var lightR = 0.5 + ((curDs - 0.6) / 3.4) * 0.9;

      gl.depthMask(true);
      gl.disable(gl.BLEND);

      var cardW3 = 0.32, cardH3 = 0.44;
      var hasImg = _lightImage && _lightImage.complete && _lightImage.naturalWidth > 0;
      if (hasImg) {
          var asp = _lightImage.naturalWidth / _lightImage.naturalHeight;
          if (asp > 1) cardH3 = cardW3 / asp; else cardW3 = cardH3 * asp;
      }
      var corners = [
          [-cardW3, 0, cardH3], [cardW3, 0, cardH3],
          [cardW3, 0, -cardH3], [-cardW3, 0, -cardH3]
      ];
      if (hasImg && _imgTexture) drawTexturedQuad(corners, 1.0);
      else drawSolidQuad(corners, 0.18, 0.18, 0.18, 0.9);

      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      drawLines(buildGridVerts(), gl.LINES);
      var oxLen = 0.06;
      drawLines(new Float32Array([
          -oxLen,0,0, 1,1,1,0.2,  oxLen,0,0, 1,1,1,0.2,
          0,-oxLen,0, 1,1,1,0.2,  0,oxLen,0, 1,1,1,0.2,
          0,0,-oxLen, 1,1,1,0.2,  0,0,oxLen, 1,1,1,0.2
      ]), gl.LINES);

      var azAct = _lightActiveHandle === 'azimuth';
      drawLines(buildRingVerts(lightR, 'z', COL_AZ[0], COL_AZ[1], COL_AZ[2], azAct ? 0.8 : 0.3, 64), gl.LINE_STRIP);
      var elAct = _lightActiveHandle === 'elevation';
      drawLines(buildElevArcVerts(curAz, lightR, COL_EL[0], COL_EL[1], COL_EL[2], elAct ? 0.8 : 0.3), gl.LINE_STRIP);

      if (!hasImg || !_imgTexture) {
          var fv = [];
          for (var ci = 0; ci < 4; ci++) {
              var c1 = corners[ci], c2 = corners[(ci+1)%4];
              fv.push(c1[0],c1[1],c1[2], 1,1,1,0.15, c2[0],c2[1],c2[2], 1,1,1,0.15);
          }
          drawLines(new Float32Array(fv), gl.LINES);
      }

      var ptData = [], lnData = [];
      _lights.forEach(function(lt) {
          var pos = lSpherical(lt.az, lt.el, lt.ds || 1.0);
          var col = lt.colorMode === 'kelvin' ? kelvinToColor(lt.kelvin) : hexToRGB(lt.hex);
          ptData.push(pos.x, pos.y, pos.z, col[0], col[1], col[2], 0.9, 18.0);
          lnData.push(0,0,0, col[0],col[1],col[2],0.15, pos.x,pos.y,pos.z, col[0],col[1],col[2],0.15);
      });
      if (lnData.length) drawLines(new Float32Array(lnData), gl.LINES);

      gl.disable(gl.DEPTH_TEST);
      if (ptData.length) drawPoints(new Float32Array(ptData));

      var groundX = lightPos.x, groundY = lightPos.y;
      var dsAct = _lightActiveHandle === 'distance';
      drawLines(new Float32Array([
          0,0,0, COL_AZ[0],COL_AZ[1],COL_AZ[2], azAct?0.6:0.25,
          groundX,groundY,0, COL_AZ[0],COL_AZ[1],COL_AZ[2], azAct?0.6:0.25,
          groundX,groundY,0, COL_EL[0],COL_EL[1],COL_EL[2], elAct?0.6:0.25,
          lightPos.x,lightPos.y,lightPos.z, COL_EL[0],COL_EL[1],COL_EL[2], elAct?0.6:0.25,
          0,0,0, COL_DS[0],COL_DS[1],COL_DS[2], dsAct?0.5:0.15,
          lightPos.x,lightPos.y,lightPos.z, COL_DS[0],COL_DS[1],COL_DS[2], dsAct?0.5:0.15
      ]), gl.LINES);
      drawPoints(new Float32Array([groundX,groundY,0, 1,1,1,0.25, 7]));
      drawPoints(new Float32Array([lightPos.x,lightPos.y,lightPos.z, COL_DS[0],COL_DS[1],COL_DS[2], 1.0, dsAct ? 26 : 20]));

      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
      drawHud(curAz, curEl, curDs);
  }

  function drawHud(curAz, curEl, curDs) {
      if (!hudCtx) return;
      var rect = lCanvas.getBoundingClientRect();
      var w = rect.width, h = rect.height;
      hudCtx.clearRect(0, 0, w, h);

      var legY = 14;
      hudCtx.fillStyle = 'rgba(0,0,0,0.4)';
      hudCtx.fillRect(w*0.2, 2, w*0.6, 20);
      hudCtx.font = 'bold ' + Math.max(10, w * 0.026) + 'px sans-serif';
      hudCtx.textAlign = 'center';
      hudCtx.globalAlpha = 0.9;
      hudCtx.fillStyle = '#54c2ff'; hudCtx.fillText('● 方位', w*0.35, legY);
      hudCtx.fillStyle = '#bb73ff'; hudCtx.fillText('● 仰角', w*0.5, legY);
      hudCtx.fillStyle = '#ff9438'; hudCtx.fillText('● 灯光', w*0.65, legY);
      hudCtx.globalAlpha = 1.0;

      _lights.forEach(function(lt, idx) {
          var pos = lSpherical(lt.az, lt.el, lt.ds || 1.0);
          var sp = project3dToScreen(pos.x, pos.y, pos.z);
          hudCtx.font = 'bold ' + (w * 0.02) + 'px sans-serif';
          hudCtx.fillStyle = '#fff'; hudCtx.textAlign = 'center';
          hudCtx.fillText(idx + 1, sp.x, sp.y - 14);
          hudCtx.font = (w * 0.03) + 'px sans-serif';
          var col = lt.colorMode === 'kelvin' ? kelvinToColor(lt.kelvin) : hexToRGB(lt.hex);
          hudCtx.fillStyle = 'rgb('+Math.round(col[0]*255)+','+Math.round(col[1]*255)+','+Math.round(col[2]*255)+')';
          hudCtx.fillText('💡', sp.x, sp.y + 5);
      });

      var azCn = nearestCN(L_AZ_CN, curAz), elCn = nearestCN(L_EL_CN, curEl), dsCn = nearestCN(L_DS_CN, curDs);
      var lb = azCn + ' | ' + elCn + ' | ' + dsCn + '  (' + _lights.length + '盏灯)';
      hudCtx.font = 'bold ' + Math.max(10, w * 0.026) + 'px sans-serif';
      var tw = hudCtx.measureText(lb).width + 28;
      var barH = 22, barY = h - barH - 4;
      hudCtx.fillStyle = 'rgba(0,0,0,0.5)';
      hudCtx.fillRect(w/2 - tw/2, barY, tw, barH);
      hudCtx.fillStyle = '#e0e0e0'; hudCtx.textAlign = 'center';
      hudCtx.fillText(lb, w/2, barY + barH - 6);

      if (!_lightImage || !_lightImage.complete || _lightImage.naturalWidth === 0) {
          var cp = project3dToScreen(0, 0, 0);
          hudCtx.font = (w * 0.04) + 'px sans-serif';
          hudCtx.fillStyle = 'rgba(255,255,255,0.25)'; hudCtx.textAlign = 'center';
          hudCtx.fillText('📷', cp.x, cp.y + 5);
      }
  }

  var _lightActiveHandle = null;
  var _lightSnapAnimId = null;

  function updateLightUI() {
      lLbAz.innerText = lSlAz.value + '°';
      lLbEl.innerText = lSlEl.value + '°';
      if (lLbDs) lLbDs.innerText = Number(lSlDs.value).toFixed(1);
      updateLightPreview();
      drawLightCanvas();
  }

  function initLightCanvas() {
      var rect = lCanvas.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      if (rect.width <= 0) { setTimeout(initLightCanvas, 50); return; }
      // bug #67: 同镜头磁贴 —— 画布高给"不超过面板可视高 55%"的上限, 矮屏笔记本不再把控件顶出可视区。
      var idealH = rect.width * 0.75;
      var panel = lCanvas.closest('.w10-panel') || lCanvas.parentNode;
      var availH = (panel && panel.clientHeight) ? panel.clientHeight : window.innerHeight;
      var maxH = Math.max(140, Math.round(availH * 0.55));
      var dispH = Math.min(idealH, maxH);
      lCanvas.width = Math.round(rect.width * dpr);
      lCanvas.height = Math.round(dispH * dpr);
      lCanvas.style.height = Math.round(dispH) + 'px';
      LCW = lCanvas.width; LCH = lCanvas.height;
      gl.viewport(0, 0, LCW, LCH);
      resizeHud();
      updateMVP();
  }

  function setupPillGroup(containerId) {
      var pillContainer = $id(containerId);
      if (!pillContainer) return;
      var opts = pillContainer.querySelectorAll('.sf-pill-opt');
      opts.forEach(function(opt) {
          opt.addEventListener('click', function() {
              if (containerId === 'lightTypePill' || containerId === 'lightNaturalPill') {
                  var otherContainer = $id(containerId === 'lightTypePill' ? 'lightNaturalPill' : 'lightTypePill');
                  if (otherContainer) otherContainer.querySelectorAll('.sf-pill-opt').forEach(function(o) { o.classList.remove('active'); });
              }
              opts.forEach(function(o) { o.classList.remove('active'); });
              opt.classList.add('active');
          });
      });
  }
  function getPillVal(containerId, fallbackContainerId) {
      var c = $id(containerId);
      if (c) { var a = c.querySelector('.sf-pill-opt.active'); if (a) return a.dataset.val || ''; }
      if (fallbackContainerId) { var c2 = $id(fallbackContainerId); if (c2) { var a2 = c2.querySelector('.sf-pill-opt.active'); if (a2) return a2.dataset.val || ''; } }
      return '';
  }

  setupPillGroup('lightTypePill');
  setupPillGroup('lightNaturalPill');
  setupPillGroup('lightRolePill');
  setupPillGroup('lightIntensityPill');
  setupPillGroup('lightExposurePill');
  setupPillGroup('lightColorModePill');

  $id('lightColorModePill').querySelectorAll('.sf-pill-opt').forEach(function(opt) {
      opt.addEventListener('click', function() {
          var mode = opt.dataset.val;
          $id('lightKelvinRow').style.display = mode === 'kelvin' ? 'flex' : 'none';
          $id('lightHslRow').style.display = mode === 'hsl' ? 'flex' : 'none';
      });
  });
  $id('lightKelvin').addEventListener('input', function() { $id('lightKelvinVal').innerText = this.value + 'K'; updateLightPreview(); });
  $id('lightColorPicker').addEventListener('input', function() { $id('lightColorVal').innerText = this.value; updateLightPreview(); });

  var lightZoomSlider = $id('lightZoomSlider');
  if (lightZoomSlider) {
      lightZoomSlider.addEventListener('input', function() {
          _lightZoom = parseFloat(this.value) || 1.0;
          updateMVP();
          updateLightUI();
      });
  }

  function buildSingleLightPrompt(lt) {
      var dir = nearestL(AZ_MAP_L, lt.az);
      var elv = nearestL(EL_MAP_L, lt.el);
      var dist = nearestL(DS_MAP_L, lt.ds || 1.0);
      var colorStr = lt.colorMode === 'kelvin' ? (', color temperature ' + lt.kelvin + 'K') : (', ' + lt.hex + ' colored light');
      return 'Add a ' + lt.intensity + ' ' + lt.type + ' as ' + lt.role + ' from ' + dir + ' at ' + elv + ', ' + dist + colorStr + lt.exposure;
  }
  function buildFullPrompt() {
      if (_lights.length === 0) return '尚未添加灯光';
      var parts = _lights.map(function(lt) { return buildSingleLightPrompt(lt); });
      return LIGHT_PREFIX + parts.join('. ') + '.' + LIGHT_SUFFIX;
  }
  function updateLightPreview() {
      var preview = $id('lightPromptPreview');
      if (preview) preview.innerText = buildFullPrompt();
  }

  function renderLightList() {
      var listContainer = $id('lightList');
      listContainer.innerHTML = '';
      _lights.forEach(function(lt, idx) {
          var item = document.createElement('div');
          item.className = 'light3d-list-item';
          var colDot = document.createElement('span');
          colDot.className = 'light3d-list-dot';
          var col = lt.colorMode === 'kelvin' ? kelvinToColor(lt.kelvin) : hexToRGB(lt.hex);
          colDot.style.background = 'rgb('+Math.round(col[0]*255)+','+Math.round(col[1]*255)+','+Math.round(col[2]*255)+')';
          var text = document.createElement('span');
          text.className = 'light3d-list-text';
          text.innerText = (idx + 1) + '. ' + lt.typeCn + ' · ' + lt.roleCn + ' · ' + lt.intensityCn + ' · ' + (lt.colorMode === 'kelvin' ? lt.kelvin + 'K' : lt.hex);
          var del = document.createElement('span');
          del.className = 'light3d-list-del';
          del.innerText = '✕';
          del.onclick = (function(i) { return function() { _lights.splice(i, 1); _lh3DSave(); renderLightList(); updateLightPreview(); drawLightCanvas(); }; })(idx);
          item.appendChild(colDot); item.appendChild(text); item.appendChild(del);
          listContainer.appendChild(item);
      });
      updateLightPreview();
  }

  lSlAz.addEventListener('input', updateLightUI);
  lSlEl.addEventListener('input', updateLightUI);
  if (lSlDs) lSlDs.addEventListener('input', updateLightUI);
  $id('lightAzReset').addEventListener('click', function() { lSlAz.value = 45; updateLightUI(); });
  $id('lightElReset').addEventListener('click', function() { lSlEl.value = 30; updateLightUI(); });
  if ($id('lightDsReset')) $id('lightDsReset').addEventListener('click', function() { lSlDs.value = 1.0; updateLightUI(); });

  $id('btnAddLight').addEventListener('click', function() {
      var type = getPillVal('lightTypePill', 'lightNaturalPill');
      if (!type) { TileAPI.toast('请选择光源类型', 'error'); return; }
      var role = getPillVal('lightRolePill');
      var intensity = getPillVal('lightIntensityPill');
      var exposure = getPillVal('lightExposurePill');
      var colorMode = getPillVal('lightColorModePill');
      var typeCnEl = ($id('lightTypePill') && $id('lightTypePill').querySelector('.active')) || ($id('lightNaturalPill') && $id('lightNaturalPill').querySelector('.active'));
      var roleCnEl = $id('lightRolePill') && $id('lightRolePill').querySelector('.active');
      var intCnEl = $id('lightIntensityPill') && $id('lightIntensityPill').querySelector('.active');
      _lights.push({
          az: Number(lSlAz.value), el: Number(lSlEl.value), ds: Number(lSlDs.value),
          type: type, role: role || 'key light', intensity: intensity || 'medium-intensity', exposure: exposure || '',
          colorMode: colorMode,
          kelvin: Number($id('lightKelvin').value),
          hex: $id('lightColorPicker').value,
          typeCn: typeCnEl ? typeCnEl.innerText : type,
          roleCn: roleCnEl ? roleCnEl.innerText : role,
          intensityCn: intCnEl ? intCnEl.innerText : intensity
      });
      _lh3DSave();
      renderLightList();
      drawLightCanvas();
      TileAPI.toast('已添加第 ' + _lights.length + ' 盏灯', 'success');
  });

  var _captureActive = false;
  $id('btnLightCapture').addEventListener('click', function() {
      _captureActive = true;
      TileAPI.sendToHost('captureForChat', {});
  });
  var _captureHandler = function(data) {
      if (!_captureActive) return;
      _captureActive = false;
      if (!data || !data.success || !data.base64) { TileAPI.toast('图像捕获失败', 'error'); return; }
      _lightImage = new Image();
      _lightImage.onload = function() { updateImageTexture(); drawLightCanvas(); };
      _lightImage.src = 'data:image/png;base64,' + data.base64;
      TileAPI.toast('图像已加载', 'success');
  };
  TileAPI.onHostMessage('captureForChatResult', _captureHandler);

  // 鼠标交互(原版完整保留)
  var _lightDrag = null, _orbitDrag = false;
  var _orbitLastX = 0, _orbitLastY = 0;
  var _dragStartDs = 1.0, _dragStartMx = 0, _dragStartMy = 0;

  function getHandleScreenPos() {
      var curAz = Number(lSlAz.value), curEl = Number(lSlEl.value), curDs = Number(lSlDs.value);
      var lightPos = lSpherical(curAz, curEl, curDs);
      var finalH = project3dToScreen(lightPos.x, lightPos.y, lightPos.z);
      var lightR = 0.5 + ((curDs - 0.6) / 3.4) * 0.9;
      return { final: finalH, lightR: lightR, curAz: curAz, curEl: curEl };
  }
  function distToRingScreen(mx, my, radius, n) {
      var minD = Infinity;
      for (var i = 0; i <= n; i++) {
          var t = i / n * Math.PI * 2;
          var p = project3dToScreen(radius*Math.cos(t), radius*Math.sin(t), 0);
          var d = Math.hypot(mx - p.x, my - p.y);
          if (d < minD) minD = d;
      }
      return minD;
  }
  function distToArcScreen(mx, my, azDeg, radius, n) {
      var minD = Infinity;
      var azRad = azDeg * Math.PI / 180;
      var dir = { x: Math.sin(azRad), y: -Math.cos(azRad) };
      for (var i = 0; i <= n; i++) {
          var angle = (-90 + 180 * i / n) * Math.PI / 180;
          var p = project3dToScreen(dir.x*radius*Math.cos(angle), dir.y*radius*Math.cos(angle), radius*Math.sin(angle));
          var d = Math.hypot(mx - p.x, my - p.y);
          if (d < minD) minD = d;
      }
      return minD;
  }
  function distToLineScreen(mx, my, x0,y0,z0, x1,y1,z1, n) {
      var minD = Infinity;
      for (var i = 0; i <= n; i++) {
          var t = i / n;
          var p = project3dToScreen(x0+(x1-x0)*t, y0+(y1-y0)*t, z0+(z1-z0)*t);
          var d = Math.hypot(mx - p.x, my - p.y);
          if (d < minD) minD = d;
      }
      return minD;
  }
  function hitTestHandles(mx, my) {
      var info = getHandleScreenPos();
      if (Math.hypot(mx - info.final.x, my - info.final.y) < 20) return 'distance';
      var lp = lSpherical(info.curAz, info.curEl, Number(lSlDs.value));
      if (distToLineScreen(mx, my, 0,0,0, lp.x,lp.y,lp.z, 20) < 12) return 'distance';
      if (distToRingScreen(mx, my, info.lightR, 48) < 12) return 'azimuth';
      if (distToArcScreen(mx, my, info.curAz, info.lightR, 24) < 12) return 'elevation';
      return null;
  }
  function lightSnapAnimate(startAz, startEl, startDs, targetAz, targetEl, targetDs) {
      if (_lightSnapAnimId) cancelAnimationFrame(_lightSnapAnimId);
      var startTime = Date.now(), duration = 200;
      var azDiff = targetAz - startAz;
      if (azDiff > 180) azDiff -= 360;
      if (azDiff < -180) azDiff += 360;
      function tick() {
          var t = Math.min((Date.now() - startTime) / duration, 1);
          var ease = 1 - Math.pow(1 - t, 3);
          var curAz = startAz + azDiff * ease;
          if (curAz < 0) curAz += 360; if (curAz >= 360) curAz -= 360;
          lSlAz.value = curAz;
          lSlEl.value = startEl + (targetEl - startEl) * ease;
          lSlDs.value = startDs + (targetDs - startDs) * ease;
          updateLightUI();
          if (t < 1) _lightSnapAnimId = requestAnimationFrame(tick);
          else _lightSnapAnimId = null;
      }
      tick();
  }

  lCanvas.addEventListener('contextmenu', function(e) { e.preventDefault(); });
  lCanvas.addEventListener('mousedown', function(e) {
      var rect = lCanvas.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (e.button === 2 || e.button === 1) {
          _orbitDrag = true; _orbitLastX = e.clientX; _orbitLastY = e.clientY;
          lCanvas.style.cursor = 'move'; return;
      }
      var hit = hitTestHandles(mx, my);
      if (hit) {
          _lightDrag = hit; _lightActiveHandle = hit; lCanvas.style.cursor = 'grabbing';
          if (hit === 'distance') {
              _dragStartDs = Number(lSlDs.value);
              _dragStartMx = mx; _dragStartMy = my;
          }
      } else {
          _orbitDrag = true; _orbitLastX = e.clientX; _orbitLastY = e.clientY;
          lCanvas.style.cursor = 'move';
      }
      drawLightCanvas();
  });
  lCanvas.addEventListener('mousemove', function(e) {
      if (_lightDrag || _orbitDrag) return;
      var rect = lCanvas.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var oldActive = _lightActiveHandle;
      var hover = hitTestHandles(mx, my);
      if (hover) { _lightActiveHandle = hover; lCanvas.style.cursor = 'grab'; }
      else { _lightActiveHandle = null; lCanvas.style.cursor = 'crosshair'; }
      if (_lightActiveHandle !== oldActive) drawLightCanvas();
  });
  var _docMoveHandler = function(e) {
      if (_orbitDrag) {
          var dx = e.clientX - _orbitLastX, dy = e.clientY - _orbitLastY;
          _camAz += dx * 0.5;
          _camEl = Math.max(-89, Math.min(89, _camEl + dy * 0.5));
          _orbitLastX = e.clientX; _orbitLastY = e.clientY;
          updateMVP(); drawLightCanvas();
          return;
      }
      if (!_lightDrag) return;
      var rect = lCanvas.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (_lightDrag === 'azimuth') {
          var gp = unprojectToGround(mx, my);
          var az = Math.atan2(gp.x, -gp.y) * 180 / Math.PI; if (az < 0) az += 360;
          if (az >= 360) az = 0;
          lSlAz.value = az;
      }
      if (_lightDrag === 'elevation') {
          var curAzR = Number(lSlAz.value) * Math.PI / 180;
          var curDsV = Number(lSlDs.value);
          var elR = 0.5 + ((curDsV - 0.6) / 3.4) * 0.9;
          var dir = { x: Math.sin(curAzR), y: -Math.cos(curAzR) };
          var arcC = project3dToScreen(0, 0, 0);
          var hPt = project3dToScreen(dir.x * elR, dir.y * elR, 0);
          var tPt = project3dToScreen(0, 0, elR);
          var hDx = hPt.x - arcC.x, hDy = hPt.y - arcC.y;
          var uDx = tPt.x - arcC.x, uDy = tPt.y - arcC.y;
          var hLen = Math.sqrt(hDx * hDx + hDy * hDy) || 1;
          var uLen = Math.sqrt(uDx * uDx + uDy * uDy) || 1;
          var mDx = mx - arcC.x, mDy = my - arcC.y;
          var pH = (mDx * hDx + mDy * hDy) / hLen;
          var pU = (mDx * uDx + mDy * uDy) / uLen;
          var elA = Math.atan2(pU, Math.max(pH, 0.01)) * 180 / Math.PI;
          lSlEl.value = Math.round(Math.max(-90, Math.min(90, elA)));
      }
      if (_lightDrag === 'distance') {
          var origin2d = project3dToScreen(0, 0, 0);
          var lp2d = lSpherical(Number(lSlAz.value), Number(lSlEl.value), _dragStartDs);
          var lightPos2d = project3dToScreen(lp2d.x, lp2d.y, lp2d.z);
          var rdx = lightPos2d.x - origin2d.x, rdy = lightPos2d.y - origin2d.y;
          var rdLen = Math.sqrt(rdx*rdx + rdy*rdy) || 1;
          rdx /= rdLen; rdy /= rdLen;
          var mdx = mx - _dragStartMx, mdy = my - _dragStartMy;
          var proj = mdx * rdx + mdy * rdy;
          var sensitivity = 3.4 / (rect.width * 0.3);
          var newDs = _dragStartDs + proj * sensitivity;
          lSlDs.value = Math.max(0.6, Math.min(4.0, newDs));
      }
      updateLightUI();
  };
  var _docUpHandler = function() {
      if (_orbitDrag) { _orbitDrag = false; lCanvas.style.cursor = 'crosshair'; return; }
      if (_lightDrag) {
          var curAz = Number(lSlAz.value), curEl = Number(lSlEl.value), curDs = Number(lSlDs.value);
          var targetAz = Math.round(curAz / 45) * 45; if (targetAz >= 360) targetAz = 0;
          var targetEl = Math.round(curEl / 15) * 15; targetEl = Math.max(-90, Math.min(90, targetEl));
          var dsSteps = [0.6, 0.8, 1.0, 1.4, 2.0, 3.0, 4.0];
          var targetDs = dsSteps.reduce(function(prev, curr) { return Math.abs(curr - curDs) < Math.abs(prev - curDs) ? curr : prev; });
          lightSnapAnimate(curAz, curEl, curDs, targetAz, targetEl, targetDs);
          _lightDrag = null; _lightActiveHandle = null; lCanvas.style.cursor = 'crosshair';
      }
  };
  document.addEventListener('mousemove', _docMoveHandler);
  document.addEventListener('mouseup', _docUpHandler);

  lCanvas.addEventListener('wheel', function(e) {
      e.preventDefault();
      _lightZoom = Math.max(0.3, Math.min(3.5, _lightZoom + (e.deltaY > 0 ? -0.05 : 0.05)));
      if (lightZoomSlider) lightZoomSlider.value = _lightZoom;
      updateMVP(); drawLightCanvas();
  });
  lCanvas.addEventListener('dblclick', function(e) {
      if (e.button !== 0) return;
      var rect = lCanvas.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (hitTestHandles(mx, my)) return;
      _camAz = 205; _camEl = 25; _lightZoom = 1.0;
      if (lightZoomSlider) lightZoomSlider.value = 1.0;
      updateMVP(); drawLightCanvas();
  });

  initShaders();
  initBuffers();
  initHud();
  initLightCanvas();
  updateLightUI();
  renderLightList();    // 把持久化恢复的 _lights 渲染到列表 UI

  var _resizeHandler = function() { initLightCanvas(); drawLightCanvas(); };
  window.addEventListener('resize', _resizeHandler);

  return {
    cleanup: function() {
      document.removeEventListener('mousemove', _docMoveHandler);
      document.removeEventListener('mouseup', _docUpHandler);
      window.removeEventListener('resize', _resizeHandler);
      if (_lightSnapAnimId) cancelAnimationFrame(_lightSnapAnimId);
      // 注销 host 消息监听, 避免每次进 3D Tab 叠加(#10 同款泄漏)
      TileAPI.offHostMessage('captureForChatResult', _captureHandler);
    },
    getPrompt: function() { return buildFullPrompt(); }
  };
}

})();
