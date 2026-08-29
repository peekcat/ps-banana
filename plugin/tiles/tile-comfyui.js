// ============================================================
//  tile-comfyui.js - ComfyUI 工作流磁贴
//  连接 ComfyUI 服务器，加载工作流，动态渲染参数，执行生成
// ============================================================
(function() {
'use strict';

// ========== 私有状态 ==========
var _activeContainer = null;
var _comfyConnecting = false;
var _comfyAutoConnectDone = false;

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _getUrl() {
  return (TileAPI.state.get('comfyui.url') || 'http://127.0.0.1:8188').replace(/\/$/, '');
}

// ========== 磁贴注册 ==========

TileAPI.registerTile({
  id: 'comfyui',
  group: 'main',
  icon: '\uD83C\uDFAF',
  label: 'ComfyUI',
  desc: 'ComfyUI \u5DE5\u4F5C\u6D41',
  live: false,
  defaultSize: { w: 2, h: 2 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 999 },   // 纵向不限高: 999 行 ≈ 无限 (纵向网格可无限延伸)

  onExpand: function(container, sizeHint) {
    var layout = (sizeHint && sizeHint.layout) || 'wide';

    // 窄/高布局一律用 square 渲染(单列竖排,内容全),避免 URL 框变成 hidden 改不了
    if (layout === 'narrow' || layout === 'tall') layout = 'square';
    // (上一行已把 narrow/tall 归一成 square, 故不再有单独的 narrow 分支 —— 原来那个分支永远走不到)
    if (layout === 'wideshort') {
      _renderWideShort(container);
    } else if (layout === 'square') {
      _renderSquare(container);
    } else {
      _renderWide(container);
    }

    _activeContainer = container;
    _bindCoreEvents(container);
    _loadSavedValues(container);

    // 自动连接
    var savedUrl = TileAPI.storage.get('comfyui.url');
    if (savedUrl && !_comfyAutoConnectDone) {
      _comfyAutoConnectDone = true;
      TileAPI.state.set('comfyui.url', savedUrl);
      var urlInp = container.querySelector('#comfyUrl');
      if (urlInp) urlInp.value = savedUrl;
      _comfyConnecting = true;
      var statusEl = container.querySelector('#comfyStatus');
      if (statusEl) { statusEl.textContent = '\u8FDE\u63A5\u4E2D...'; statusEl.style.color = 'var(--text-sub)'; }
      TileAPI.sendToHost('comfyConnect', { url: savedUrl.replace(/\/$/, ''), silent: true });
    }

    return function() { _activeContainer = null; };
  },

  onMessage: function(action, data) {
    _handleHostMessage(action, data);
  },

  onStorageLoaded: function(storage) {
    var url = storage.get('comfyui.url');
    if (url) TileAPI.state.set('comfyui.url', url);
    TileAPI.state.set('comfyui.connected', false);
    TileAPI.state.set('comfyui.running', false);
  },
});

// ========== 布局渲染 ==========

function _renderConnectionBar() {
  var url = TileAPI.storage.get('comfyui.url') || 'http://127.0.0.1:8188';
  return '' +
    '<div class="comfy-connection-bar">' +
      '<input class="w10-input comfy-url-input" id="comfyUrl" placeholder="http://127.0.0.1:8188" value="' + _esc(url) + '">' +
      '<button class="w10-btn w10-btn-accent" id="comfyConnectBtn">\u8FDE\u63A5</button>' +
      '<span class="comfy-status" id="comfyStatus">--</span>' +
    '</div>';
}

function _renderWorkflowSection() {
  return '' +
    '<div class="w10-section-title">\u5DE5\u4F5C\u6D41</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">\u5F53\u524D</div></div>' +
      '<div class="w10-row-right" style="flex:1;display:flex;gap:4px;align-items:center;">' +
        '<select class="w10-select" id="comfyWorkflowSelect" style="flex:1;"><option value="">-- \u5DE5\u4F5C\u6D41 --</option></select>' +
        '<button class="w10-btn" id="comfyRefreshBtn" title="\u5237\u65B0\u5DE5\u4F5C\u6D41\u5217\u8868">\u5237\u65B0</button>' +
      '</div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-right" style="display:flex;gap:4px;">' +
        '<button class="w10-btn" id="comfyLoadParamsBtn">\u52A0\u8F7D\u53C2\u6570</button>' +
        '<button class="w10-btn" id="comfyShowAllBtn" title="\u663E\u793A\u6240\u6709\u8282\u70B9\u53C2\u6570">\u5168\u90E8\u8282\u70B9</button>' +
        '<button class="w10-btn" id="comfyOpenFolderBtn">\u6253\u5F00\u6587\u4EF6\u5939</button>' +
      '</div>' +
    '</div>';
}

function _renderParamsSection() {
  return '' +
    '<div class="w10-section-title">\u53C2\u6570</div>' +
    '<div id="comfyParamsContainer" class="comfy-params-container">' +
      '<div style="font-size:10px;color:#888;text-align:center;padding:12px;">\u8BF7\u5148\u52A0\u8F7D\u5DE5\u4F5C\u6D41</div>' +
    '</div>';
}

function _renderActionBar() {
  var timeout = TileAPI.storage.get('comfyui.timeout') || 3600;
  return '' +
    '<div class="w10-section-title">\u64CD\u4F5C</div>' +
    '<input type="hidden" id="comfyTimeout" value="3600">' +
    '<div class="comfy-action-bar">' +
      '<div class="comfy-progress" id="comfyProgress" style="display:none;">' +
        '<div class="comfy-progress-bar" id="comfyProgressBar" style="width:0%;"></div>' +
        '<span class="comfy-progress-text" id="comfyProgressText">0%</span>' +
      '</div>' +
      '<button class="w10-btn w10-btn-accent comfy-generate-btn" id="comfyGenerateBtn">\u25B6 ComfyUI \u751F\u6210</button>' +
    '</div>';
}

// --- Wide \u5E03\u5C40 (w>=2, h>=2) ---
function _renderWide(container) {
  container.innerHTML =
    '<div class="w10-panel comfy-panel comfy-layout-wide">' +
      '<div class="w10-section-title">\u8FDE\u63A5</div>' +
      _renderConnectionBar() +
      _renderWorkflowSection() +
      _renderParamsSection() +
      _renderActionBar() +
    '</div>';
}

// --- Narrow/Tall \u5E03\u5C40 (w=1) ---
function _renderNarrow(container) {
  var url = TileAPI.storage.get('comfyui.url') || 'http://127.0.0.1:8188';
  container.innerHTML =
    '<div class="w10-panel comfy-panel comfy-layout-narrow">' +
      '<div class="comfy-connection-bar">' +
        '<span class="comfy-status" id="comfyStatus">--</span>' +
      '</div>' +
      '<input type="hidden" id="comfyUrl" value="' + _esc(url) + '">' +
      '<select class="w10-select" id="comfyWorkflowSelect" style="width:100%;margin-bottom:4px;"><option value="">-- \u5DE5\u4F5C\u6D41 --</option></select>' +
      '<div id="comfyParamsContainer" class="comfy-params-container"></div>' +
      '<div class="comfy-progress" id="comfyProgress" style="display:none;">' +
        '<div class="comfy-progress-bar" id="comfyProgressBar" style="width:0%;"></div>' +
        '<span class="comfy-progress-text" id="comfyProgressText">0%</span>' +
      '</div>' +
      '<button class="w10-btn w10-btn-accent comfy-generate-btn" id="comfyGenerateBtn">\u25B6 \u751F\u6210</button>' +
      '<button class="w10-btn" id="comfyConnectBtn" style="margin-top:4px;">\u8FDE\u63A5</button>' +
      '<button class="w10-btn" id="comfyRefreshBtn" style="display:none;">\u5237\u65B0</button>' +
      '<button class="w10-btn" id="comfyLoadParamsBtn" style="display:none;">\u52A0\u8F7D\u53C2\u6570</button>' +
      '<button class="w10-btn" id="comfyShowAllBtn" style="display:none;">\u5168\u90E8\u8282\u70B9</button>' +
      '<button class="w10-btn" id="comfyOpenFolderBtn" style="display:none;">\u6253\u5F00\u6587\u4EF6\u5939</button>' +
      '<input type="hidden" id="comfyTimeout" value="3600">' +
    '</div>';
}

// --- Square \u5E03\u5C40 ---
function _renderSquare(container) {
  var url = TileAPI.storage.get('comfyui.url') || 'http://127.0.0.1:8188';
  container.innerHTML =
    '<div class="w10-panel comfy-panel comfy-layout-square">' +
      '<div class="comfy-connection-bar">' +
        '<input class="w10-input comfy-url-input" id="comfyUrl" placeholder="http://127.0.0.1:8188" value="' + _esc(url) + '" style="max-width:160px;">' +
        '<button class="w10-btn w10-btn-accent" id="comfyConnectBtn">\u8FDE\u63A5</button>' +
        '<span class="comfy-status" id="comfyStatus">--</span>' +
      '</div>' +
      '<div class="comfy-square-grid">' +
        '<div class="comfy-square-left">' +
          '<select class="w10-select" id="comfyWorkflowSelect" style="width:100%;"><option value="">-- \u5DE5\u4F5C\u6D41 --</option></select>' +
          '<div style="display:flex;gap:4px;margin-top:4px;">' +
            '<button class="w10-btn" id="comfyRefreshBtn">\u5237\u65B0</button>' +
            '<button class="w10-btn" id="comfyLoadParamsBtn">\u52A0\u8F7D</button>' +
          '</div>' +
        '</div>' +
        '<div class="comfy-square-right">' +
          '<button class="w10-btn w10-btn-accent comfy-generate-btn" id="comfyGenerateBtn">\u25B6 \u751F\u6210</button>' +
        '</div>' +
      '</div>' +
      '<div id="comfyParamsContainer" class="comfy-params-container"></div>' +
      '<div class="comfy-progress" id="comfyProgress" style="display:none;">' +
        '<div class="comfy-progress-bar" id="comfyProgressBar" style="width:0%;"></div>' +
        '<span class="comfy-progress-text" id="comfyProgressText">0%</span>' +
      '</div>' +
      '<button class="w10-btn" id="comfyShowAllBtn" style="display:none;">\u5168\u90E8\u8282\u70B9</button>' +
      '<button class="w10-btn" id="comfyOpenFolderBtn" style="display:none;">\u6253\u5F00\u6587\u4EF6\u5939</button>' +
      '<input type="hidden" id="comfyTimeout" value="3600">' +
    '</div>';
}

// --- WideShort \u5E03\u5C40 (w>=3, h=1) ---
function _renderWideShort(container) {
  var url = TileAPI.storage.get('comfyui.url') || 'http://127.0.0.1:8188';
  container.innerHTML =
    '<div class="w10-panel comfy-panel comfy-layout-wideshort">' +
      '<div class="comfy-wideshort-strip">' +
        '<input class="w10-input comfy-url-input" id="comfyUrl" placeholder="http://127.0.0.1:8188" value="' + _esc(url) + '" style="max-width:200px;">' +
        '<button class="w10-btn w10-btn-accent" id="comfyConnectBtn">\u8FDE\u63A5</button>' +
        '<span class="comfy-status" id="comfyStatus">--</span>' +
        '<select class="w10-select" id="comfyWorkflowSelect" style="max-width:180px;"><option value="">-- \u5DE5\u4F5C\u6D41 --</option></select>' +
        '<button class="w10-btn w10-btn-accent comfy-generate-btn" id="comfyGenerateBtn">\u25B6 \u751F\u6210</button>' +
      '</div>' +
      '<div id="comfyParamsContainer" class="comfy-params-container" style="display:none;"></div>' +
      '<div class="comfy-progress" id="comfyProgress" style="display:none;">' +
        '<div class="comfy-progress-bar" id="comfyProgressBar" style="width:0%;"></div>' +
        '<span class="comfy-progress-text" id="comfyProgressText">0%</span>' +
      '</div>' +
      '<button class="w10-btn" id="comfyRefreshBtn" style="display:none;">\u5237\u65B0</button>' +
      '<button class="w10-btn" id="comfyLoadParamsBtn" style="display:none;">\u52A0\u8F7D\u53C2\u6570</button>' +
      '<button class="w10-btn" id="comfyShowAllBtn" style="display:none;">\u5168\u90E8\u8282\u70B9</button>' +
      '<button class="w10-btn" id="comfyOpenFolderBtn" style="display:none;">\u6253\u5F00\u6587\u4EF6\u5939</button>' +
      '<input type="hidden" id="comfyTimeout" value="3600">' +
    '</div>';
}

// ========== \u4E8B\u4EF6\u7ED1\u5B9A ==========

function _bindCoreEvents(container) {
  // --- \u8FDE\u63A5 ---
  var connectBtn = container.querySelector('#comfyConnectBtn');
  if (connectBtn) connectBtn.addEventListener('click', function() {
    if (_comfyConnecting) { TileAPI.toast('\u6B63\u5728\u8FDE\u63A5\u4E2D\uFF0C\u8BF7\u7A0D\u5019...', 'warn'); return; }
    var urlInp = container.querySelector('#comfyUrl');
    var url = urlInp ? urlInp.value.trim().replace(/\/$/, '') : '';
    if (!url) { TileAPI.toast('\u8BF7\u8F93\u5165 ComfyUI \u5730\u5740', 'error'); return; }
    TileAPI.state.set('comfyui.url', url);
    TileAPI.storage.set('comfyui.url', url);
    _comfyConnecting = true;
    var statusEl = container.querySelector('#comfyStatus');
    if (statusEl) { statusEl.textContent = '\u8FDE\u63A5\u4E2D...'; statusEl.style.color = 'var(--text-sub)'; }
    TileAPI.sendToHost('comfyConnect', { url: url });
  });

  // --- URL \u6301\u4E45\u5316 ---
  var urlInp = container.querySelector('#comfyUrl');
  if (urlInp) urlInp.addEventListener('change', function() {
    TileAPI.storage.set('comfyui.url', urlInp.value.trim());
    TileAPI.state.set('comfyui.url', urlInp.value.trim());
  });

  // --- \u5237\u65B0\u5DE5\u4F5C\u6D41 ---
  var refreshBtn = container.querySelector('#comfyRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', function() {
    TileAPI.sendToHost('comfyFetchWorkflows', { url: _getUrl() });
    TileAPI.toast('\u6B63\u5728\u5237\u65B0\u5DE5\u4F5C\u6D41\u5217\u8868...', 'info');
  });

  // --- \u5DE5\u4F5C\u6D41\u9009\u62E9 ---
  var wfSelect = container.querySelector('#comfyWorkflowSelect');
  if (wfSelect) wfSelect.addEventListener('change', function() {
    var wfName = wfSelect.value;
    if (!wfName) return;
    TileAPI.storage.set('comfyui.lastWorkflow', wfName);
    TileAPI.sendToHost('comfyLoadWorkflow', {
      url: _getUrl(),
      name: wfName,
      showAll: !!TileAPI.state.get('comfyui.showAll'),
      source: 'comfyTab'
    });
  });

  // --- \u52A0\u8F7D\u53C2\u6570 ---
  var loadBtn = container.querySelector('#comfyLoadParamsBtn');
  if (loadBtn) loadBtn.addEventListener('click', function() {
    var wfSelect2 = container.querySelector('#comfyWorkflowSelect');
    var wfName = wfSelect2 ? wfSelect2.value : '';
    if (!wfName && !TileAPI.state.get('comfyui.currentWorkflow')) {
      TileAPI.toast('\u8BF7\u5148\u9009\u62E9\u5DE5\u4F5C\u6D41', 'error');
      return;
    }
    TileAPI.sendToHost('comfyLoadWorkflow', {
      url: _getUrl(),
      name: wfName,
      workflow: TileAPI.state.get('comfyui.currentWorkflow'),
      showAll: !!TileAPI.state.get('comfyui.showAll'),
      source: 'comfyTab'
    });
  });

  // --- \u5168\u90E8\u8282\u70B9\u5207\u6362 ---
  var showAllBtn = container.querySelector('#comfyShowAllBtn');
  if (showAllBtn) showAllBtn.addEventListener('click', function() {
    var current = !!TileAPI.state.get('comfyui.showAll');
    TileAPI.state.set('comfyui.showAll', !current);
    showAllBtn.classList.toggle('on', !current);
    showAllBtn.textContent = !current ? '\u4EC5 @37 \u8282\u70B9' : '\u5168\u90E8\u8282\u70B9';
    var wfSelect3 = container.querySelector('#comfyWorkflowSelect');
    var wfName = wfSelect3 ? wfSelect3.value : '';
    if (TileAPI.state.get('comfyui.currentWorkflow') || wfName) {
      TileAPI.sendToHost('comfyLoadWorkflow', {
        url: _getUrl(),
        name: wfName,
        workflow: TileAPI.state.get('comfyui.currentWorkflow'),
        showAll: !current,
        source: 'comfyTab'
      });
    }
  });

  // --- \u6253\u5F00\u6587\u4EF6\u5939 ---
  var openFolderBtn = container.querySelector('#comfyOpenFolderBtn');
  if (openFolderBtn) openFolderBtn.addEventListener('click', function() {
    TileAPI.sendToHost('comfyOpenFolder', {});
  });

  // --- \u8D85\u65F6\u6ED1\u5757 ---
  _bindSlider(container, 'comfyTimeout', 'comfyTimeoutVal', 'comfyui.timeout');

  // --- \u751F\u6210 / \u4E2D\u65AD ---
  var genBtn = container.querySelector('#comfyGenerateBtn');
  if (genBtn) genBtn.addEventListener('click', function() {
    if (TileAPI.state.get('comfyui.running')) {
      TileAPI.sendToHost('comfyInterrupt', {
        url: _getUrl(),
        taskId: TileAPI.state.get('comfyui.currentTaskId') || ''
      });
      genBtn.textContent = '\u2573 \u4E2D\u65AD\u4E2D...';
      return;
    }
    var currentWorkflow = TileAPI.state.get('comfyui.currentWorkflow');
    if (!currentWorkflow) {
      TileAPI.toast('\u8BF7\u5148\u9009\u62E9\u5E76\u52A0\u8F7D\u5DE5\u4F5C\u6D41', 'error');
      return;
    }
    // \u6536\u96C6\u53C2\u6570
    var params = {};
    var paramEls = container.querySelectorAll('#comfyParamsContainer [data-comfy-param]');
    for (var i = 0; i < paramEls.length; i++) {
      var el = paramEls[i];
      params[el.dataset.comfyParam] = el.value;
    }
    var timeoutEl = container.querySelector('#comfyTimeout');
    var timeout = timeoutEl ? parseInt(timeoutEl.value, 10) || 3600 : 3600;

    TileAPI.state.set('comfyui.running', true);
    TileAPI.state.set('comfyui.nodeValues', params);
    _updateRunningUI(container, true);

    // 接入统一任务池(让任务磁贴显示 ComfyUI 运行状态)
    var taskId = 'comfy_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    var autoReturn = TileAPI.storage.get('output.autoReturn') !== false;
    TileAPI.state.set('comfyui.currentTaskId', taskId);
    var running = TileAPI.state.get('tasks.running') || {};
    running[taskId] = { batchSize: 1, startTime: Date.now(), success: 0, fail: 0, total: 1, model: '🎛 ComfyUI' };
    TileAPI.state.set('tasks.running', running);
    var tmeta = TileAPI.state.get('tasks.meta') || {};
    tmeta[taskId] = { countdown: timeout, timeoutSec: timeout, autoReturn: autoReturn, batchSize: 1, engine: 'comfyui' };
    TileAPI.state.set('tasks.meta', tmeta);
    TileAPI.emit('tasks:updated');
    TileAPI.emit('task:started', { taskId: taskId, timeoutSec: timeout, batchSize: 1 });

    TileAPI.sendToHost('comfyGenerate', {
      url: _getUrl(),
      workflow: currentWorkflow,
      params: params,
      timeout: timeout,
      autoReturn: autoReturn,
      taskId: taskId
    });
  });
}

function _bindSlider(container, sliderId, valId, storageKey) {
  var slider = container.querySelector('#' + sliderId);
  var valEl = container.querySelector('#' + valId);
  if (!slider) return;
  slider.addEventListener('input', function() {
    if (valEl) valEl.textContent = slider.value;
    if (storageKey) TileAPI.storage.set(storageKey, slider.value);
  });
}

// ========== \u52A0\u8F7D\u4FDD\u5B58\u503C ==========

function _loadSavedValues(container) {
  var lastWf = TileAPI.storage.get('comfyui.lastWorkflow');
  if (lastWf) {
    var wfSelect = container.querySelector('#comfyWorkflowSelect');
    if (wfSelect) {
      // \u5C06\u5728\u5DE5\u4F5C\u6D41\u5217\u8868\u52A0\u8F7D\u540E\u9009\u4E2D
      TileAPI.state.set('comfyui._pendingSelectWf', lastWf);
    }
  }
}

// ========== \u8FD0\u884C\u72B6\u6001 UI ==========

function _updateRunningUI(container, running) {
  var btn = container.querySelector('#comfyGenerateBtn');
  var prog = container.querySelector('#comfyProgress');
  if (!btn) return;
  if (running) {
    btn.textContent = '\u25A0 \u4E2D\u65AD';
    btn.classList.remove('w10-btn-accent');
    btn.style.color = '#ff6b6b';
    btn.style.borderColor = 'rgba(255,100,100,0.3)';
    if (prog) prog.style.display = 'block';
  } else {
    btn.textContent = '\u25B6 ComfyUI \u751F\u6210';
    btn.classList.add('w10-btn-accent');
    btn.style.color = '';
    btn.style.borderColor = '';
    if (prog) prog.style.display = 'none';
  }
}

// ========== \u52A8\u6001\u53C2\u6570\u6E32\u67D3 ==========

function _renderComfyParams(container, paramsDef) {
  var paramsEl = container.querySelector('#comfyParamsContainer');
  if (!paramsEl) return;
  paramsEl.innerHTML = '';

  if (!paramsDef || paramsDef.length === 0) {
    paramsEl.innerHTML = '<div style="font-size:10px;color:#888;text-align:center;padding:12px;">\u6B64\u5DE5\u4F5C\u6D41\u65E0\u53EF\u8C03\u53C2\u6570</div>';
    return;
  }

  // \u8BD5\u56FE\u6062\u590D\u4E0A\u6B21\u4FDD\u5B58\u7684\u503C
  var savedValues = TileAPI.state.get('comfyui.nodeValues') || {};

  for (var i = 0; i < paramsDef.length; i++) {
    var p = paramsDef[i];
    var row = document.createElement('div');
    row.className = 'w10-row comfy-param-row';

    var label = document.createElement('div');
    label.className = 'w10-row-left';
    label.innerHTML = '<div class="w10-row-label" title="' + _esc(p.name) + '">' + _esc(p.label || p.name) + '</div>';
    row.appendChild(label);

    var right = document.createElement('div');
    right.className = 'w10-row-right';
    right.style.flex = '1';

    var input;
    var savedVal = savedValues[p.name];
    var defaultVal = savedVal !== undefined ? savedVal : p.default;

    if (p.type === 'select' && p.options) {
      input = document.createElement('select');
      input.className = 'w10-select';
      for (var oi = 0; oi < p.options.length; oi++) {
        var o = document.createElement('option');
        o.value = p.options[oi];
        o.textContent = p.options[oi];
        input.appendChild(o);
      }
      if (defaultVal !== undefined) input.value = String(defaultVal);
    } else if (p.type === 'textarea') {
      input = document.createElement('textarea');
      input.className = 'w10-input comfy-param-textarea';
      input.rows = 3;
      input.value = defaultVal !== undefined ? String(defaultVal) : '';
    } else if (p.type === 'number') {
      input = document.createElement('input');
      input.type = 'number';
      input.className = 'w10-input';
      input.value = defaultVal !== undefined ? defaultVal : '';
      if (p.min !== undefined) input.min = p.min;
      if (p.max !== undefined) input.max = p.max;
      if (p.step !== undefined) input.step = p.step;
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'w10-input';
      input.value = defaultVal !== undefined ? String(defaultVal) : '';
    }

    input.dataset.comfyParam = p.name;
    if (p.disabled) { input.disabled = true; input.style.opacity = '0.5'; }

    right.appendChild(input);
    row.appendChild(right);
    paramsEl.appendChild(row);
  }
}

// ========== \u540E\u7AEF\u6D88\u606F\u5904\u7406 ==========

function _handleHostMessage(action, data) {
  var container = _activeContainer;

  // --- \u8FDE\u63A5\u7ED3\u679C ---
  if (action === 'comfyConnectResult') {
    _comfyConnecting = false;
    var statusEl = container ? container.querySelector('#comfyStatus') : null;
    if (data && data.success) {
      if (statusEl) { statusEl.textContent = '\u2705 \u5DF2\u8FDE\u63A5'; statusEl.style.color = 'var(--accent)'; }
      TileAPI.state.set('comfyui.connected', true);
      // \u81EA\u52A8\u62C9\u53D6\u5DE5\u4F5C\u6D41
      TileAPI.sendToHost('comfyFetchWorkflows', { url: _getUrl() });
    } else {
      if (statusEl) { statusEl.textContent = '\u274C \u5931\u8D25: ' + (data ? data.error : ''); statusEl.style.color = '#ff6b6b'; }
      TileAPI.state.set('comfyui.connected', false);
      TileAPI.toast('ComfyUI \u8FDE\u63A5\u5931\u8D25: ' + (data ? data.error : ''), 'error');
    }
  }

  // --- \u5DE5\u4F5C\u6D41\u5217\u8868 ---
  if (action === 'comfyWorkflowsResult') {
    if (data && data.success) {
      var workflows = data.workflows || [];
      TileAPI.state.set('comfyui.workflows', workflows);
      if (container) {
        var sel = container.querySelector('#comfyWorkflowSelect');
        if (sel) {
          sel.innerHTML = '<option value="">-- \u5DE5\u4F5C\u6D41 (' + workflows.length + ') --</option>';
          for (var wi = 0; wi < workflows.length; wi++) {
            var wf = workflows[wi];
            var opt = document.createElement('option');
            opt.value = wf.name || wf;
            opt.textContent = wf.name || wf;
            sel.appendChild(opt);
          }
          // \u6062\u590D\u4E0A\u6B21\u9009\u62E9
          var pending = TileAPI.state.get('comfyui._pendingSelectWf');
          if (pending) {
            sel.value = pending;
            TileAPI.state.set('comfyui._pendingSelectWf', null);
          }
        }
      }
      TileAPI.log('[ComfyUI] \u5DF2\u62C9\u53D6 ' + workflows.length + ' \u4E2A\u5DE5\u4F5C\u6D41', 'info');
    }
  }

  // --- \u5DE5\u4F5C\u6D41\u5DF2\u52A0\u8F7D ---
  if (action === 'comfyWorkflowLoaded') {
    if (data && data.success) {
      TileAPI.state.set('comfyui.currentWorkflow', data.workflow);
      TileAPI.state.set('comfyui.currentNodes', data.params || []);
      if (container) {
        _renderComfyParams(container, data.params || []);
      }
      TileAPI.toast('\u5DE5\u4F5C\u6D41\u5DF2\u52A0\u8F7D: ' + (data.name || ''), 'success');

      // \u5982\u679C\u662F\u5176\u4ED6\u78C1\u8D34\u53D1\u8D77\u7684\u52A0\u8F7D\uFF0C\u5206\u53D1\u7ED9\u6865\u63A5\u51FD\u6570
      if (data.source !== 'comfyTab') {
        if (window._bp_selectComfyUIPreset) {
          window._bp_selectComfyUIPreset(data.name, data.params, data.workflow);
        }
      }
    } else {
      TileAPI.toast('\u5DE5\u4F5C\u6D41\u52A0\u8F7D\u5931\u8D25: ' + (data ? data.error : ''), 'error');
    }
  }

  // --- \u8FDB\u5EA6 ---
  if (action === 'comfyProgress') {
    var progressTaskId = TileAPI.state.get('comfyui.currentTaskId');
    if (!data || !progressTaskId || String(data.taskId || '') !== String(progressTaskId)) return;
    if (container) {
      var pct = 0;
      if (data.progress !== undefined) {
        pct = Math.round((data.progress || 0) * 100);
      } else if (data.elapsed !== undefined && data.maxWait > 0) {
        pct = Math.min(99, Math.round((data.elapsed / data.maxWait) * 100));
      }
      var bar = container.querySelector('#comfyProgressBar');
      var text = container.querySelector('#comfyProgressText');
      if (bar) bar.style.width = pct + '%';
      if (text) text.textContent = pct + '% (' + (data.elapsed || 0) + 's)';
      var genBtn = container.querySelector('#comfyGenerateBtn');
      if (genBtn && TileAPI.state.get('comfyui.running')) {
        genBtn.textContent = '\u25A0 ' + pct + '% \u4E2D\u65AD';
      }
    }
  }

  // --- \u751F\u6210\u7ED3\u679C ---
  if (action === 'comfyGenerateResult') {
    var currentTaskId = TileAPI.state.get('comfyui.currentTaskId');
    if (!data || !currentTaskId || String(data.taskId || '') !== String(currentTaskId)) return;
    TileAPI.state.set('comfyui.running', false);
    if (container) _updateRunningUI(container, false);
    // 统一任务池由 Host 的 taskComplete 交给 tasks-service 收口，避免绕过账单/统计。
    TileAPI.state.set('comfyui.currentTaskId', null);
    if (data && data.success) {
      TileAPI.toast('ComfyUI \u751F\u6210\u5B8C\u6210!', 'success');
    } else {
      var errMsg = (data && data.error) ? data.error : '\u672A\u77E5\u9519\u8BEF';
      if (errMsg !== '\u5DF2\u4E2D\u65AD') {
        TileAPI.toast('ComfyUI \u751F\u6210\u5931\u8D25: ' + errMsg, 'error');
      }
    }
  }

  // --- \u9519\u8BEF ---
  if (action === 'comfyError') {
    TileAPI.state.set('comfyui.running', false);
    if (container) _updateRunningUI(container, false);
    // taskComplete 会负责移除任务卡并记账。
    var errTid = (data && data.taskId) || TileAPI.state.get('comfyui.currentTaskId');
    if (errTid) {
      TileAPI.state.set('comfyui.currentTaskId', null);
    }
    TileAPI.toast('ComfyUI \u9519\u8BEF: ' + (data ? data.error : ''), 'error');
  }
}

// ========== \u6865\u63A5\u51FD\u6570 ==========

window._bp_getComfyWorkflows = function() {
  var workflows = TileAPI.state.get('comfyui.workflows') || [];
  return workflows.map(function(wf) {
    var name = wf.name || wf;
    var catId = 'other';
    var displayName = name;

    var baseName = name;
    if (baseName.indexOf('/') !== -1) baseName = baseName.split('/').pop();
    else if (baseName.indexOf('\\') !== -1) baseName = baseName.split('\\').pop();

    var match = baseName.match(/^@37_([^_]+)_(.+)$/);
    if (match) {
      var folderName = match[1].trim();
      displayName = match[2].trim();
      if (/\u9762\u90E8|\u8138|\u5934|\u773C|\u5507|\u9F3B|\u7709/.test(folderName)) catId = 'head';
      else if (/\u53D1|\u6BDB\u53D1/.test(folderName)) catId = 'hair';
      else if (/\u80F8|\u8EAF\u5E72|\u8170|\u8179|\u8EAB\u4F53/.test(folderName)) catId = 'torso';
      else if (/\u624B\u81C2/.test(folderName)) catId = 'arms';
      else if (/\u624B/.test(folderName)) catId = 'hands';
      else if (/\u817F|\u4E1D\u889C|\u7F51\u889C/.test(folderName)) catId = 'legs';
      else if (/\u811A/.test(folderName)) catId = 'feet';
      else if (/\u670D\u88C5|\u8863\u670D|\u88D9/.test(folderName)) catId = 'clothing';
      else if (/\u80CC\u666F|\u573A\u666F/.test(folderName)) catId = 'background';
      else if (/\u5149\u5F71|\u5149\u6655|\u706F\u5149|\u9713\u8679/.test(folderName)) catId = 'lighting';
      else if (/\u7279\u6548|\u7C98\u6DB2|\u6C34\u6D41|\u706B\u7130|\u51B0\u971C|\u96F7\u7535/.test(folderName)) catId = 'effects';
      else if (/\u914D\u9970|\u9053\u5177|\u9996\u9970/.test(folderName)) catId = 'accessory';
      else if (/\u53BB\u6742\u7269|\u4FEE\u8865|\u53BB\u6C34\u5370|\u6E05\u7406/.test(folderName)) catId = 'cleanup';
      else if (/\u5168\u8EAB/.test(folderName)) catId = 'fullbody';
      else if (/\u6B66\u5668/.test(folderName)) catId = 'weapon';
      else if (/\u9888\u90E8/.test(folderName)) catId = 'neck';
    } else {
      displayName = baseName;
    }

    return {
      name: name,
      displayName: displayName,
      category: catId,
      data: wf
    };
  });
};

window._bp_loadComfyUIWorkflow = function(wfName) {
  TileAPI.sendToHost('comfyLoadWorkflow', { url: _getUrl(), name: wfName, showAll: false });
  TileAPI.log('[ComfyUI] \u6B63\u5728\u8BF7\u6C42\u5DE5\u4F5C\u6D41\u53C2\u6570: ' + wfName, 'info');
};

})();
