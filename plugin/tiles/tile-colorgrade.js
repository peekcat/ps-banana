// ============================================================
//  tile-colorgrade.js - AI 调色
//  参考图 + 提示词 → AI 生成 → 颜色混合模式图层贴回
// ============================================================
(function() {
'use strict';

// ========== Private state ==========
var _running = false;
var _taskId = null;
var _activeContainer = null;

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ========== Model helpers (same pattern as tile-tiled) ==========
function _getActiveConfig() {
  var provider = TileAPI.state.get('params.provider') || 'aji';
  // 统一读视图(rebuildModelViews 已给 aji/grs/momo/others 全建好), 自动覆盖 momo
  return TileAPI.state.get('models.' + provider) || {};
}

function _populateModelSelect(sel) {
  if (!sel) return;
  var cfg = _getActiveConfig();
  sel.innerHTML = '';
  for (var mid in cfg) {
    var opt = document.createElement('option');
    opt.value = mid;
    opt.textContent = cfg[mid].name || mid;
    sel.appendChild(opt);
  }
  var saved = TileAPI.storage.get('colorgrade.model');
  if (saved && cfg[saved]) sel.value = saved;
}

function _populateSizeSelect(sel, modelKey) {
  if (!sel) return;
  var cfg = _getActiveConfig();
  var mc = cfg[modelKey];
  var curSize = sel.value;
  sel.innerHTML = '';
  if (mc && mc.sizes) {
    mc.sizes.forEach(function(s) {
      var opt = document.createElement('option');
      opt.value = s; opt.textContent = s;
      sel.appendChild(opt);
    });
    if (mc.sizes.indexOf(curSize) !== -1) sel.value = curSize;
    else sel.value = mc.default || mc.sizes[0] || '';
  }
}

function _onModelChange(container) {
  var modelSel = container.querySelector('#cgModelInput');
  var sizeSel = container.querySelector('#cgSizeInput');
  if (modelSel) {
    _populateSizeSelect(sizeSel, modelSel.value);
    TileAPI.storage.set('colorgrade.model', modelSel.value);
  }
}

// ========== Ref image slot ==========
function _getRefImage() { return TileAPI.state.get('colorgrade.refImage') || ''; }

function _renderRefSlot() {
  var ref = _getRefImage();
  if (ref) {
    return '<div class="w10-row" style="flex-direction:column;align-items:stretch;">' +
      '<div class="w10-section-title">参考图</div>' +
      '<div style="position:relative;width:100%;max-height:120px;overflow:hidden;border-radius:4px;margin-bottom:4px;">' +
        '<img src="data:image/png;base64,' + ref + '" style="width:100%;max-height:120px;object-fit:contain;display:block;">' +
        '<div style="position:absolute;top:2px;right:2px;display:flex;gap:4px;">' +
          '<button class="w10-btn" id="cgRecaptureRef" style="padding:2px 6px;font-size:11px;">重新捕获</button>' +
          '<button class="w10-btn" id="cgClearRef" style="padding:2px 6px;font-size:11px;color:#ff6b6b;">清除</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  return '<div class="w10-row" style="flex-direction:column;align-items:stretch;">' +
    '<div class="w10-section-title">参考图</div>' +
    '<div style="display:flex;gap:8px;align-items:center;">' +
      '<button class="w10-btn w10-btn-accent" id="cgCaptureRef">捕获参考图</button>' +
      '<span style="color:var(--text-sub);font-size:12px;">从当前选区捕获颜色参考</span>' +
    '</div>' +
  '</div>';
}

// ========== Running UI ==========
function _setRunningUI(container, running) {
  _running = running;
  var btn = container ? container.querySelector('#cgStartBtn') : null;
  if (!btn) return;
  if (running) {
    btn.textContent = '中断';
    btn.classList.remove('w10-btn-accent');
    btn.style.color = '#ff6b6b';
    btn.style.borderColor = 'rgba(255,100,100,0.3)';
  } else {
    btn.textContent = '开始调色';
    btn.classList.add('w10-btn-accent');
    btn.style.color = '';
    btn.style.borderColor = '';
    btn.style.background = '';
  }
}

// ========== Render helpers ==========
function _renderPromptRow() {
  var prompt = TileAPI.storage.get('colorgrade.prompt') || '';
  return '<div class="w10-section-title">提示词</div>' +
    '<div class="w10-row" style="flex-direction:column;align-items:stretch;">' +
      '<textarea class="w10-input" id="cgPromptInput" placeholder="描述想要的色调风格..." rows="2">' + _esc(prompt) + '</textarea>' +
    '</div>';
}

function _renderEngineRow() {
  var provider = TileAPI.state.get('params.provider') || 'aji';
  return '<div class="w10-row">' +
    '<div class="w10-row-left"><div class="w10-row-label">API 引擎</div></div>' +
    '<div class="w10-row-right" style="flex:1;max-width:160px;">' +
      '<select class="w10-select" id="cgProviderInput">' +
        TileAPI.slotOrder().map(function(eng) {
          var def = eng === 'aji' ? 'AJI' : eng === 'grs' ? TileAPI.computeBrand() : 'Others';
          return '<option value="' + eng + '"' + (provider === eng ? ' selected' : '') + '>' + TileAPI.slotLabel(eng, def) + '</option>';
        }).join('') +
      '</select>' +
    '</div>' +
  '</div>';
}

function _renderModelRow() {
  return '<div class="w10-row">' +
    '<div class="w10-row-left"><div class="w10-row-label">模型</div></div>' +
    '<div class="w10-row-right" style="flex:1;max-width:200px;">' +
      '<select class="w10-select" id="cgModelInput"></select>' +
    '</div>' +
  '</div>';
}

function _renderSizeRow() {
  return '<div class="w10-row">' +
    '<div class="w10-row-left"><div class="w10-row-label">分辨率</div></div>' +
    '<div class="w10-row-right" style="flex:1;max-width:120px;">' +
      '<select class="w10-select" id="cgSizeInput"></select>' +
    '</div>' +
  '</div>';
}

function _renderAspectRow() {
  var ar = TileAPI.storage.get('colorgrade.aspectRatio') || 'Auto';
  return '<div class="w10-row">' +
    '<div class="w10-row-left"><div class="w10-row-label">宽高比</div></div>' +
    '<div class="w10-row-right" style="flex:1;max-width:120px;">' +
      '<select class="w10-select" id="cgAspectRatioInput">' +
        '<option' + (ar === 'Auto' ? ' selected' : '') + '>Auto</option>' +
        '<option' + (ar === '1:1' ? ' selected' : '') + '>1:1</option>' +
        '<option' + (ar === '3:2' ? ' selected' : '') + '>3:2</option>' +
        '<option' + (ar === '2:3' ? ' selected' : '') + '>2:3</option>' +
        '<option' + (ar === '16:9' ? ' selected' : '') + '>16:9</option>' +
        '<option' + (ar === '9:16' ? ' selected' : '') + '>9:16</option>' +
      '</select>' +
    '</div>' +
  '</div>';
}

function _renderBlendModeRow() {
  var bm = TileAPI.storage.get('colorgrade.blendMode') || 'color';
  return '<div class="w10-row">' +
    '<div class="w10-row-left"><div class="w10-row-label">混合模式</div></div>' +
    '<div class="w10-row-right" style="flex:1;max-width:160px;">' +
      '<select class="w10-select" id="cgBlendModeInput">' +
        '<option value="color"' + (bm === 'color' ? ' selected' : '') + '>颜色 (Color)</option>' +
        '<option value="softLight"' + (bm === 'softLight' ? ' selected' : '') + '>柔光 (Soft Light)</option>' +
        '<option value="overlay"' + (bm === 'overlay' ? ' selected' : '') + '>叠加 (Overlay)</option>' +
        '<option value="multiply"' + (bm === 'multiply' ? ' selected' : '') + '>正片叠底 (Multiply)</option>' +
        '<option value="screen"' + (bm === 'screen' ? ' selected' : '') + '>滤色 (Screen)</option>' +
        '<option value="normal"' + (bm === 'normal' ? ' selected' : '') + '>正常 (Normal)</option>' +
      '</select>' +
    '</div>' +
  '</div>';
}

function _renderActionButtons() {
  return '<div class="w10-row" style="justify-content:flex-end;gap:8px;border-bottom:none;">' +
    '<button class="w10-btn w10-btn-accent" id="cgStartBtn">开始调色</button>' +
  '</div>';
}

// ========== Layouts ==========

// --- Wide (default) ---
function _renderWide(container) {
  container.innerHTML =
    '<div class="w10-panel">' +
      _renderRefSlot() +
      _renderPromptRow() +
      '<div class="w10-section-title">参数</div>' +
      _renderEngineRow() +
      _renderModelRow() +
      _renderSizeRow() +
      _renderAspectRow() +
      _renderBlendModeRow() +
      _renderActionButtons() +
    '</div>';
}

// --- WideShort ---
function _renderWideShort(container) {
  container.innerHTML =
    '<div class="w10-panel">' +
      '<div style="display:flex;gap:12px;">' +
        '<div style="flex:0 0 auto;max-width:160px;">' + _renderRefSlot() + '</div>' +
        '<div style="flex:1;min-width:0;">' +
          _renderPromptRow() +
          '<div class="w10-section-title">参数</div>' +
          _renderEngineRow() +
          _renderModelRow() +
          _renderSizeRow() +
        '</div>' +
      '</div>' +
      _renderActionButtons() +
    '</div>';
}

// --- Square ---
function _renderSquare(container) {
  container.innerHTML =
    '<div class="w10-panel">' +
      _renderRefSlot() +
      _renderPromptRow() +
      '<div class="w10-section-title">参数</div>' +
      _renderEngineRow() +
      _renderModelRow() +
      _renderSizeRow() +
      _renderBlendModeRow() +
      _renderActionButtons() +
    '</div>';
}

// --- Narrow/Tall ---
function _renderNarrow(container) {
  container.innerHTML =
    '<div class="w10-panel">' +
      _renderRefSlot() +
      '<div class="w10-row" style="justify-content:flex-end;border-bottom:none;">' +
        '<button class="w10-btn w10-btn-accent" id="cgStartBtn">开始调色</button>' +
      '</div>' +
    '</div>';
}

// ========== Event binding ==========
function _bindEvents(container) {
  // Provider change
  var providerSel = container.querySelector('#cgProviderInput');
  if (providerSel) providerSel.addEventListener('change', function() {
    _populateModelSelect(container.querySelector('#cgModelInput'));
    _onModelChange(container);
  });

  // Model change
  var modelSel = container.querySelector('#cgModelInput');
  if (modelSel) modelSel.addEventListener('change', function() {
    _onModelChange(container);
  });

  // Persist fields
  var fields = [
    { id: 'cgPromptInput', key: 'colorgrade.prompt' },
    { id: 'cgAspectRatioInput', key: 'colorgrade.aspectRatio' },
    { id: 'cgSizeInput', key: 'colorgrade.size' },
    { id: 'cgBlendModeInput', key: 'colorgrade.blendMode' }
  ];
  fields.forEach(function(f) {
    var el = container.querySelector('#' + f.id);
    if (el) el.addEventListener('change', function() {
      TileAPI.storage.set(f.key, el.value);
    });
  });

  // Ref image buttons
  var captureBtn = container.querySelector('#cgCaptureRef');
  if (captureBtn) captureBtn.addEventListener('click', function() {
    TileAPI.sendToHost('captureRefImageForColorgrade', {});
    TileAPI.toast('正在捕获参考图...', 'info');
  });

  var recaptureBtn = container.querySelector('#cgRecaptureRef');
  if (recaptureBtn) recaptureBtn.addEventListener('click', function() {
    TileAPI.sendToHost('captureRefImageForColorgrade', {});
    TileAPI.toast('正在重新捕获参考图...', 'info');
  });

  var clearBtn = container.querySelector('#cgClearRef');
  if (clearBtn) clearBtn.addEventListener('click', function() {
    TileAPI.state.set('colorgrade.refImage', '');
    TileAPI.state.set('colorgrade.refImageFromDoc', '');
    _rerender(container);
    TileAPI.toast('参考图已清除', 'info');
  });

  // Start / abort button
  var startBtn = container.querySelector('#cgStartBtn');
  if (startBtn) startBtn.addEventListener('click', function() {
    if (_running) {
      if (_taskId) {
        TileAPI.sendToHost('earlyStopTask', { taskId: _taskId });
      } else {
        TileAPI.sendToHost('earlyStop', {});
      }
      TileAPI.toast('正在中断调色任务...', 'info');
      startBtn.textContent = '正在中断...';
      return;
    }
    _doStart(container);
  });
}

function _rerender(container) {
  if (!container) return;
  var layout = container._cgLayout || 'wide';
  _renderLayout(container, layout);
  _afterRender(container);
}

function _renderLayout(container, layout) {
  // 窄/高布局一律用 square 渲染(单列竖排,内容全),避免精简版只剩一个「开始」按钮
  if (layout === 'narrow' || layout === 'tall') layout = 'square';
  if (layout === 'narrow' || layout === 'tall') {
    _renderNarrow(container);
  } else if (layout === 'wideshort') {
    _renderWideShort(container);
  } else if (layout === 'square') {
    _renderSquare(container);
  } else {
    _renderWide(container);
  }
}

function _afterRender(container) {
  _populateModelSelect(container.querySelector('#cgModelInput'));
  _onModelChange(container);
  // Restore saved size
  var savedSize = TileAPI.storage.get('colorgrade.size');
  var sizeSel = container.querySelector('#cgSizeInput');
  if (savedSize && sizeSel) {
    for (var i = 0; i < sizeSel.options.length; i++) {
      if (sizeSel.options[i].value === savedSize) { sizeSel.value = savedSize; break; }
    }
  }
  _bindEvents(container);
  if (_running) _setRunningUI(container, true);
  // 施工中: 渲染完成后, 加 banner + 禁所有交互. 实装后删掉这行即可.
  _applyConstructionFreeze(container);
}

// ========== 施工中冻结 (bug ② 用户决定: 磁贴正常显示, 顶部 banner + 全部禁用) ==========
function _applyConstructionFreeze(container) {
  if (!container) return;
  var root = container.querySelector('.w10-panel') || container;
  // 顶部加 banner (重复调不重加)
  if (root && !root.querySelector('.cg-construction-banner')) {
    var banner = document.createElement('div');
    banner.className = 'cg-construction-banner';
    banner.innerHTML = '🚧 <b>AI 调色功能尚未实装</b>, 所有操作已临时禁用。功能完成后会自动启用。';
    root.insertBefore(banner, root.firstChild);
  }
  // 所有可交互元素 disabled
  var els = container.querySelectorAll('button, input, select, textarea');
  for (var i = 0; i < els.length; i++) {
    els[i].disabled = true;
    els[i].setAttribute('title', '功能施工中, 暂时不可用');
  }
  container.classList.add('cg-frozen');
}

// ========== Start task ==========
function _doStart(container) {
  // 施工中: AI 调色功能尚未实装, 直接拦截不发任务
  // 等正式实装后删掉这两行 + 删掉 _applyConstructionFreeze 调用即可恢复
  TileAPI.toast('AI 调色功能尚未实装, 敬请期待', 'warn');
  return;
  /* eslint-disable no-unreachable */
  var promptEl = container.querySelector('#cgPromptInput');
  var prompt = promptEl ? promptEl.value.trim() : '';
  if (!prompt) { TileAPI.toast('请先输入提示词', 'error'); return; }

  var provider = (container.querySelector('#cgProviderInput') || {}).value || TileAPI.state.get('params.provider') || 'aji';

  // 走统一入口取连接(原来读的 connection.apiKey 是早已废弃的全局字段, 解冻直接上线会全员取不到 key)
  var conn = window._settingsGetActiveConnection ? window._settingsGetActiveConnection(provider) : { provider: provider, url: '', key: '' };
  var apiKey = conn.key || '';
  var apiBaseUrl = conn.url || '';
  if (!apiKey) {
    if (conn._grsKeyPending) TileAPI.toast('正在准备夏算力, 请稍后再试', 'info');
    else if (conn._grsNeedLogin) TileAPI.toast('夏算力托管需要登录 (顶栏账号区), 或切回「自带 Key」', 'error');
    else TileAPI.toast('API Key 未填写', 'error');
    return;
  }
  if (!apiBaseUrl) { TileAPI.toast('API 地址未填写', 'error'); return; }

  var model = (container.querySelector('#cgModelInput') || {}).value || '';
  var size = (container.querySelector('#cgSizeInput') || {}).value || '2K';
  var aspectRatio = (container.querySelector('#cgAspectRatioInput') || {}).value || 'Auto';
  var blendMode = (container.querySelector('#cgBlendModeInput') || {}).value || 'color';

  TileAPI.toast('调色已开始', 'info');
  TileAPI.sendToHost('colorGradeTask', {
    prompt: prompt,
    apiKey: apiKey,
    apiBaseUrl: apiBaseUrl,
    provider: provider,
    model: model,
    size: size,
    aspectRatio: aspectRatio,
    blendMode: blendMode,
    batchSize: 1,
    timeout: 3600
  });
}

// ========== Tile Registration ==========
TileAPI.registerTile({
  id: 'colorgrade',
  group: 'main',
  icon: '\uD83C\uDFA8',
  label: 'AI 调色',
  desc: '基于参考图调色',
  live: false,
  defaultSize: { w: 2, h: 2 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  onExpand: function(container, sizeHint) {
    var layout = (sizeHint && sizeHint.layout) || 'wide';
    _activeContainer = container;
    container._cgLayout = layout;

    _renderLayout(container, layout);
    _afterRender(container);

    return function() { _activeContainer = null; };
  },

  onMessage: function(action, data) {
    var container = _activeContainer;

    if (action === 'colorgradeRefCaptured' && data) {
      if (data.base64) {
        TileAPI.state.set('colorgrade.refImage', data.base64);
        if (data.docId) TileAPI.state.set('colorgrade.refImageFromDoc', data.docId);
        TileAPI.toast('参考图已捕获', 'success');
        if (container) _rerender(container);
      } else {
        TileAPI.toast('捕获参考图失败', 'error');
      }
    }

    if (action === 'colorgradeStarted' && data) {
      _taskId = data.taskId || null;
      if (container) _setRunningUI(container, true);
    }

    if (action === 'colorgradeComplete') {
      _taskId = null;
      if (container) _setRunningUI(container, false);
      if (data && data.success) {
        TileAPI.toast('调色完成', 'success');
      } else if (data && data.error) {
        TileAPI.toast('调色失败: ' + data.error, 'error');
      }
    }

    if (action === 'colorgradeProgress' && data) {
      // Future: could show progress bar
    }
  },

  onStorageLoaded: function() {
    // Nothing to restore at startup
  }
});

})();
