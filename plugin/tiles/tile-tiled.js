// ============================================================
//  tile-tiled.js - 分块放大 (Tiled Upscale)
//  将大尺寸文档分割成多块，逐块调用 AI API 放大后贴回
// ============================================================
(function() {
'use strict';

// ========== Private state ==========
var _tiledRunning = false;
var _tiledTaskId = null;
var _tiledPendingTaskId = null;  // _doStart 提前占位的卡片 id; 用户取消确认时据此清卡
var _progressData = { success: 0, fail: 0, total: 0 };
var _activeContainer = null;
var _pendingConfirmParams = null;

// ⑨ 修复: wide/square 布局下右侧控件统一宽度, 保证下拉/数字框右边对齐.
// 注入一次即可, 用 panel 上的 .tiled-panel 作用域避免污染其他磁贴.
function _injectTiledPanelCss() {
  if (document.getElementById('tiled-panel-css')) return;
  var st = document.createElement('style');
  st.id = 'tiled-panel-css';
  st.textContent = [
    '.tiled-panel .w10-row-right{',
      'width:160px;max-width:none;flex-shrink:0;',
    '}',
    '.tiled-panel .w10-row-right > .w10-select,',
    '.tiled-panel .w10-row-right > .w10-input{',
      'width:100%;min-width:0;box-sizing:border-box;',
    '}'
  ].join('');
  document.head.appendChild(st);
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ========== Model helpers ==========
// tiled 有自己独立的 provider 选择(tiled.provider),跟生成参数磁贴的 params.provider 解耦
function _getTiledProvider() {
  return TileAPI.storage.get('tiled.provider') || TileAPI.state.get('params.provider') || 'aji';
}

function _getActiveConfig(providerOverride) {
  var provider = providerOverride || _getTiledProvider();
  // 统一读视图(rebuildModelViews 已给 aji/grs/momo/others 全建好), 自动覆盖 momo
  return TileAPI.state.get('models.' + (provider || 'aji')) || {};
}

function _populateModelSelect(sel, providerOverride) {
  if (!sel) return;
  var cfg = _getActiveConfig(providerOverride);
  sel.innerHTML = '';
  for (var mid in cfg) {
    var opt = document.createElement('option');
    opt.value = mid;
    opt.textContent = cfg[mid].name || mid;
    sel.appendChild(opt);
  }
  // Restore saved (only if it exists in current provider's config)
  var saved = TileAPI.storage.get('tiled.model');
  if (saved && cfg[saved]) {
    sel.value = saved;
  } else {
    // Saved model not in current provider — pick first and persist
    var firstKey = Object.keys(cfg)[0];
    if (firstKey) {
      sel.value = firstKey;
      TileAPI.storage.set('tiled.model', firstKey);
    }
  }
}

function _populateSizeSelect(sel, modelKey, providerOverride) {
  if (!sel) return;
  var cfg = _getActiveConfig(providerOverride);
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
  var modelSel = container.querySelector('#tiledModelInput');
  var sizeSel = container.querySelector('#tiledSizeInput');
  if (modelSel) {
    _populateSizeSelect(sizeSel, modelSel.value);
    TileAPI.storage.set('tiled.model', modelSel.value);
  }
}

// ========== Progress bar ==========
function _resetProgress() {
  _progressData = { success: 0, fail: 0, total: 0 };
}

function _applyProgressGradient(btn, pd) {
  if (!btn || pd.total <= 0) return;
  var successPct = (pd.success / pd.total) * 100;
  var failPct = (pd.fail / pd.total) * 100;
  var pendingPct = 100 - successPct - failPct;
  var stops = [];
  var pos = 0;
  if (successPct > 0) { stops.push('#4caf50 ' + pos + '%'); pos += successPct; stops.push('#4caf50 ' + pos + '%'); }
  if (failPct > 0) { stops.push('#ff9800 ' + pos + '%'); pos += failPct; stops.push('#ff9800 ' + pos + '%'); }
  if (pendingPct > 0) { stops.push('var(--accent-dark) ' + pos + '%'); stops.push('var(--accent-dark) 100%'); }
  btn.style.background = 'linear-gradient(90deg, ' + stops.join(', ') + ')';
  var completed = pd.success + pd.fail;
  btn.textContent = completed + '/' + pd.total + ' 提前结束';
}

function _setRunningUI(container, running) {
  _tiledRunning = running;
  var btn = container ? container.querySelector('#tiledStartBtn') : null;
  if (!btn) return;
  if (running) {
    _resetProgress();
    btn.textContent = '提前结束';
    btn.classList.remove('w10-btn-accent');
    btn.style.color = '#ff6b6b';
    btn.style.borderColor = 'rgba(255,100,100,0.3)';
  } else {
    _resetProgress();
    btn.textContent = '开始分块放大';
    btn.classList.add('w10-btn-accent');
    btn.style.color = '';
    btn.style.borderColor = '';
    btn.style.background = '';
  }
}

// ========== Layouts ==========

function _renderPromptRow() {
  var prompt = TileAPI.storage.get('tiled.prompt') || '';
  return '<div class="w10-section-title">提示词</div>' +
    '<div class="w10-row" style="flex-direction:column;align-items:stretch;">' +
      '<div style="display:flex;gap:4px;margin-bottom:4px;">' +
        '<textarea class="w10-input" id="tiledPromptInput" placeholder="分块放大提示词..." rows="2" style="flex:1;">' + _esc(prompt) + '</textarea>' +
        '<button class="w10-btn" id="tiledPresetSearch" title="搜索预设" style="align-self:flex-start;padding:4px 8px;font-size:14px;">🔍</button>' +
      '</div>' +
    '</div>';
}

function _renderEngineRow() {
  var provider = _getTiledProvider();
  return '<div class="w10-row">' +
    '<div class="w10-row-left"><div class="w10-row-label">API 引擎</div></div>' +
    '<div class="w10-row-right" style="flex:1;max-width:160px;">' +
      '<select class="w10-select" id="tiledProviderInput">' +
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
      '<select class="w10-select" id="tiledModelInput"></select>' +
    '</div>' +
  '</div>';
}

function _renderSizeRow() {
  return '<div class="w10-row">' +
    '<div class="w10-row-left"><div class="w10-row-label">分辨率</div></div>' +
    '<div class="w10-row-right" style="flex:1;max-width:120px;">' +
      '<select class="w10-select" id="tiledSizeInput"></select>' +
    '</div>' +
  '</div>';
}

function _renderAspectRow() {
  var ar = TileAPI.storage.get('tiled.aspectRatio') || 'Auto';
  return '<div class="w10-row">' +
    '<div class="w10-row-left"><div class="w10-row-label">宽高比</div></div>' +
    '<div class="w10-row-right" style="flex:1;max-width:120px;">' +
      '<select class="w10-select" id="tiledAspectRatioInput">' +
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

function _renderBatchRow() {
  var batch = TileAPI.storage.get('tiled.batchSize') || 1;
  return '<div class="w10-row">' +
    '<div class="w10-row-left"><div class="w10-row-label">每块数量</div></div>' +
    '<div class="w10-row-right" style="max-width:80px;">' +
      '<input class="w10-input" id="tiledBatchSizeInput" type="number" min="1" max="8" value="' + batch + '">' +
    '</div>' +
  '</div>';
}

function _renderTimeoutRow() {
  // v6.5.1: 超时 UI 隐藏, 值拉满
  return '<input type="hidden" id="tiledTimeoutInput" value="3600">';
}

function _renderOverlapRow() {
  var overlap = TileAPI.storage.get('tiled.overlap') || 256;
  return '<div class="w10-row">' +
    '<div class="w10-row-left">' +
      '<div class="w10-row-label">重叠量</div>' +
      '<div class="w10-row-desc">相邻分块重叠像素</div>' +
    '</div>' +
    '<div class="w10-row-right" style="max-width:100px;">' +
      '<input class="w10-input" id="tiledOverlapInput" type="number" min="0" max="1024" step="32" value="' + overlap + '">' +
    '</div>' +
  '</div>';
}

function _renderTileSizeRow() {
  var ts = TileAPI.storage.get('tiled.tileSize') || 2048;
  return '<div class="w10-row">' +
    '<div class="w10-row-left">' +
      '<div class="w10-row-label">块大小</div>' +
      '<div class="w10-row-desc">每块边长(像素)</div>' +
    '</div>' +
    '<div class="w10-row-right" style="max-width:100px;">' +
      '<input class="w10-input" id="tiledTileSizeInput" type="number" min="256" max="8192" step="128" value="' + ts + '">' +
    '</div>' +
  '</div>';
}

function _renderActionButtons() {
  return '<div class="w10-row" style="justify-content:flex-end;gap:8px;border-bottom:none;">' +
    '<button class="w10-btn" id="tiledTestBtn">可视化测试</button>' +
    '<button class="w10-btn w10-btn-accent" id="tiledStartBtn">开始分块放大</button>' +
  '</div>';
}

// --- Wide layout (default) ---
function _renderWide(container) {
  _injectTiledPanelCss();
  container.innerHTML =
    '<div class="w10-panel tiled-panel">' +
      _renderPromptRow() +
      '<div class="w10-section-title">参数</div>' +
      _renderEngineRow() +
      _renderModelRow() +
      _renderSizeRow() +
      _renderAspectRow() +
      _renderBatchRow() +
      _renderTimeoutRow() +
      '<div class="w10-section-title">分块设置</div>' +
      _renderOverlapRow() +
      _renderTileSizeRow() +
      _renderActionButtons() +
    '</div>';
}

// --- WideShort layout ---
function _renderWideShort(container) {
  container.innerHTML =
    '<div class="w10-panel">' +
      _renderPromptRow() +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:120px;">' + _renderEngineRow() + '</div>' +
        '<div style="flex:1;min-width:120px;">' + _renderModelRow() + '</div>' +
        '<div style="flex:1;min-width:100px;">' + _renderSizeRow() + '</div>' +
      '</div>' +
      _renderActionButtons() +
    '</div>';
}

// --- Square layout ---
function _renderSquare(container) {
  _injectTiledPanelCss();
  container.innerHTML =
    '<div class="w10-panel tiled-panel">' +
      _renderPromptRow() +
      '<div class="w10-section-title">参数</div>' +
      _renderEngineRow() +
      _renderModelRow() +
      _renderSizeRow() +
      _renderBatchRow() +
      '<div class="w10-section-title">分块设置</div>' +
      _renderOverlapRow() +
      _renderTileSizeRow() +
      _renderActionButtons() +
    '</div>';
}

// --- Narrow/Tall layout ---
function _renderNarrow(container) {
  container.innerHTML =
    '<div class="w10-panel">' +
      _renderPromptRow() +
      '<div class="w10-section-title">参数</div>' +
      _renderEngineRow() +
      _renderModelRow() +
      _renderSizeRow() +
      '<div class="w10-row" style="justify-content:flex-end;border-bottom:none;">' +
        '<button class="w10-btn w10-btn-accent" id="tiledStartBtn">开始分块放大</button>' +
      '</div>' +
    '</div>';
}

// ========== Event binding ==========
function _bindEvents(container) {
  // Provider change
  var providerSel = container.querySelector('#tiledProviderInput');
  if (providerSel) providerSel.addEventListener('change', function() {
    var newProvider = this.value;
    TileAPI.storage.set('tiled.provider', newProvider);
    // 用新 provider 重填模型(直接传 override 避免函数内部读旧值)
    _populateModelSelect(container.querySelector('#tiledModelInput'), newProvider);
    // 用新 model 重填尺寸
    var modelSel = container.querySelector('#tiledModelInput');
    var sizeSel = container.querySelector('#tiledSizeInput');
    if (modelSel && sizeSel) {
      _populateSizeSelect(sizeSel, modelSel.value, newProvider);
      TileAPI.storage.set('tiled.model', modelSel.value);
      // 持久化 size
      TileAPI.storage.set('tiled.size', sizeSel.value);
    }
  });

  // Model change
  var modelSel = container.querySelector('#tiledModelInput');
  if (modelSel) modelSel.addEventListener('change', function() {
    _onModelChange(container);
  });

  // Persist fields
  var fields = [
    { id: 'tiledPromptInput', key: 'tiled.prompt' },
    { id: 'tiledBatchSizeInput', key: 'tiled.batchSize' },
    { id: 'tiledTimeoutInput', key: 'tiled.timeout' },
    { id: 'tiledOverlapInput', key: 'tiled.overlap' },
    { id: 'tiledTileSizeInput', key: 'tiled.tileSize' },
    { id: 'tiledAspectRatioInput', key: 'tiled.aspectRatio' },
    { id: 'tiledSizeInput', key: 'tiled.size' }
  ];
  fields.forEach(function(f) {
    var el = container.querySelector('#' + f.id);
    if (el) el.addEventListener('change', function() {
      TileAPI.storage.set(f.key, el.value);
    });
  });

  // Preset search button
  var psBtn = container.querySelector('#tiledPresetSearch');
  if (psBtn) {
    psBtn.addEventListener('click', function() {
      var ta = container.querySelector('#tiledPromptInput');
      _openPresetPicker(function(text) {
        if (ta) {
          ta.value = text;
          TileAPI.storage.set('tiled.prompt', text);
        }
      });
    });
  }

  // Start button
  var startBtn = container.querySelector('#tiledStartBtn');
  if (startBtn) startBtn.addEventListener('click', function() {
    if (_tiledRunning) {
      // Early stop
      if (_tiledTaskId) {
        TileAPI.sendToHost('earlyStopTask', { taskId: _tiledTaskId });
      } else {
        TileAPI.sendToHost('earlyStop', {});
      }
      TileAPI.toast('分块放大将在当前任务完成后结束', 'info');
      startBtn.textContent = '正在结束...';
      return;
    }
    _doStart(container);
  });

  // Test button
  var testBtn = container.querySelector('#tiledTestBtn');
  if (testBtn) testBtn.addEventListener('click', function() {
    var overlap = parseInt((container.querySelector('#tiledOverlapInput') || {}).value) || 256;
    var tileSize = parseInt((container.querySelector('#tiledTileSizeInput') || {}).value) || 2048;
    TileAPI.toast('开始分块可视化测试...', 'info');
    testBtn.textContent = '正在填充...';
    testBtn.style.pointerEvents = 'none';
    TileAPI.sendToHost('tiledFillTest', { overlap: overlap, tileSize: tileSize });
    setTimeout(function() {
      testBtn.textContent = '可视化测试';
      testBtn.style.pointerEvents = '';
    }, 5000);
  });
}

function _doStart(container) {
  var promptEl = container.querySelector('#tiledPromptInput');
  var prompt = promptEl ? promptEl.value.trim() : '';
  if (!prompt) { TileAPI.toast('分块放大提示词未填写', 'error'); return; }

  // bug #66: 走统一入口 _settingsGetActiveConnection(provider), 按 tiled 自己选的 provider 取 Key/URL,
  //   并处理 GRS "夏算力托管" 路径(代理用户 connection.grs.key 为空也能拿到 sub-key)。
  //   原来直接读 connection.<provider>.key, 代理用户那里是空的 → 误报"未填 Key"。
  var provider = (container.querySelector('#tiledProviderInput') || {}).value || _getTiledProvider();
  var apiKey = '', apiBaseUrl = '';
  if (typeof window._settingsGetActiveConnection === 'function') {
    var conn = window._settingsGetActiveConnection(provider) || {};
    apiKey = conn.key || '';
    apiBaseUrl = conn.url || '';
    if (!apiKey && conn._grsKeyPending) { TileAPI.toast('正在准备夏算力, 请稍后再试', 'info'); return; }
    if (!apiKey && conn._grsNeedLogin) { TileAPI.toast('夏算力托管需要登录 (顶栏账号区), 或切回「自带 Key」', 'error'); return; }
  } else {
    apiKey = TileAPI.storage.get('connection.' + provider + '.key') || '';
    apiBaseUrl = TileAPI.storage.get('connection.' + provider + '.url') || '';
  }
  if (!apiKey) { TileAPI.toast(provider.toUpperCase() + ' Key 未填写,请到顶栏配置', 'error'); return; }
  if (!apiBaseUrl) {
    if (provider === 'aji') TileAPI.toast('AJI 服务器未校验, 请到顶栏粘贴 Key 或点"校验 Key"按钮', 'error');
    else TileAPI.toast(provider.toUpperCase() + ' 地址未填写,请到顶栏配置', 'error');
    return;
  }

  var model = (container.querySelector('#tiledModelInput') || {}).value || '';
  var size = (container.querySelector('#tiledSizeInput') || {}).value || '2K';
  var aspectRatio = (container.querySelector('#tiledAspectRatioInput') || {}).value || 'Auto';
  var batchSize = parseInt((container.querySelector('#tiledBatchSizeInput') || {}).value) || 1;
  var timeout = parseInt((container.querySelector('#tiledTimeoutInput') || {}).value) || 3600;
  var overlap = parseInt((container.querySelector('#tiledOverlapInput') || {}).value) || 256;
  var tileSize = parseInt((container.querySelector('#tiledTileSizeInput') || {}).value) || 2048;

  // 自己生成 taskId,提前在 tasks.running 占位 + 传给 host(host 返回 taskStartedResult 时直接用这个 id)
  var taskId = 'tiled_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

  TileAPI.sendToHost('startTiledUpscale', {
    provider: provider,
    prompt: prompt,
    apiKey: apiKey,
    apiBaseUrl: apiBaseUrl,
    model: model,
    size: size,
    aspectRatio: aspectRatio,
    batchSize: batchSize,
    timeout: timeout,
    overlap: overlap,
    tileSize: tileSize,
    layerType: TileAPI.storage.get('output.layerType') || 'smartObject',
    maxResolution: tileSize,
    autoReturn: TileAPI.storage.get('output.autoReturn') !== false,
    taskId: taskId
  });

  // 接入统一任务池(让任务磁贴显示分块放大的运行状态)
  var running = TileAPI.state.get('tasks.running') || {};
  running[taskId] = { batchSize: 1, startTime: Date.now(), success: 0, fail: 0, total: 0, model: '🧩 分块放大', provider: provider };
  TileAPI.state.set('tasks.running', running);
  var taskMeta = TileAPI.state.get('tasks.meta') || {};
  taskMeta[taskId] = { countdown: timeout, timeoutSec: timeout, autoReturn: TileAPI.storage.get('output.autoReturn') !== false, batchSize: 1, engine: 'tiled' };
  TileAPI.state.set('tasks.meta', taskMeta);
  TileAPI.emit('tasks:updated');
  TileAPI.emit('task:started', { taskId: taskId, timeoutSec: timeout, batchSize: 1 });
  _tiledPendingTaskId = taskId;  // #5: 记下占位卡片, 取消确认时清掉
}

// ========== Preset search ==========
// 紧凑模糊匹配: 子串优先; 跨字符仅当字符间隔 ≤ 2 时才命中, 防止"两字命中所有预设"的噪声
function _tiledFuzzy(text, q) {
  if (!text || !q) return false;
  text = String(text).toLowerCase();
  if (text.indexOf(q) >= 0) return true;
  if (q.length < 2) return false;
  var ti = 0, qi = 0, lastTi = -1;
  while (ti < text.length && qi < q.length) {
    if (text.charAt(ti) === q.charAt(qi)) {
      if (lastTi < 0 || (ti - lastTi - 1) <= 2) {
        lastTi = ti;
        qi++;
      }
      // 间距超限不立刻判负, 让 ti 继续扫
    }
    ti++;
  }
  return qi === q.length;
}

function _openPresetPicker(callback) {
  // 预设列表在 state 里 (host 从文件加载, storage 不再持有 — 之前用 storage 永远空)
  var presets = TileAPI.state.get('presets.list') || [];
  var bananaPresets = presets.filter(function(p) { return !p._isForge; });
  if (!bananaPresets.length) { TileAPI.toast('没有可用的 Banana 预设', 'error'); return; }

  function _renderSearchList(q) {
    var ql = (q || '').toLowerCase().trim();
    var filtered = ql
      ? bananaPresets.filter(function(p) {
          // title 用紧凑模糊; content 只用纯子串 (长正文跨字符噪声大)
          if (_tiledFuzzy(p.title, ql)) return true;
          if (p.content && String(p.content).toLowerCase().indexOf(ql) >= 0) return true;
          return false;
        })
      : bananaPresets;
    return filtered.map(function(p, i) {
      var label = _esc(p.title || '未命名');
      var preview = _esc((p.content || '').substring(0, 40));
      return '<div class="w10-row" style="cursor:pointer;padding:4px 8px;border-radius:4px;display:flex;flex-direction:column;align-items:flex-start;" data-psi="' + i + '" onmouseover="this.style.background=\'rgba(128,128,128,0.15)\'" onmouseout="this.style.background=\'\'">' +
        '<div style="font-weight:bold;font-size:13px;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + label + '</div>' +
        '<div style="font-size:10px;color:var(--text-sub);width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;">' + preview + '</div>' +
      '</div>';
    }).join('');
  }

  var filterId = 'psiFilter';
  var listId = 'psiList';
  var html =
    '<input class="w10-input" id="' + filterId + '" placeholder="搜索预设名称..." style="width:100%;margin-bottom:8px;" autofocus>' +
    '<div id="' + listId + '" style="max-height:300px;overflow-y:auto;">' + _renderSearchList('') + '</div>';

  TileAPI.dialog({
    title: '搜索预设',
    html: html,
    buttons: ['取消'],
    accent: 0
  }).then(function() {});

  setTimeout(function() {
    var inp = document.getElementById(filterId);
    var list = document.getElementById(listId);
    if (!inp || !list) return;
    inp.addEventListener('input', function() {
      list.innerHTML = _renderSearchList(inp.value);
    });
    list.addEventListener('click', function(e) {
      var row = e.target.closest('[data-psi]');
      if (!row) return;
      var idx = parseInt(row.getAttribute('data-psi'), 10);
      var ql = (inp.value || '').toLowerCase().trim();
      var filtered = ql
        ? bananaPresets.filter(function(p) {
            if (_tiledFuzzy(p.title, ql)) return true;
            if (p.content && String(p.content).toLowerCase().indexOf(ql) >= 0) return true;
            return false;
          })
        : bananaPresets;
      var picked = filtered[idx];
      if (picked && picked.content) {
        callback(picked.content);
        // 关闭 UIKit dialog:点击它的 [data-idx] 按钮(取消按钮 idx=0)触发 finish/cleanup
        var overlay = list.closest('.uik-dlg-overlay');
        var closeBtn = overlay && overlay.querySelector('button[data-idx]');
        if (closeBtn) closeBtn.click();
      }
    });
  }, 100);
}

// ========== Tile Registration ==========
TileAPI.registerTile({
  id: 'tiled',
  group: 'main',
  icon: '\uD83D\uDD32',
  label: '分块放大',
  desc: 'Tiled Upscale',
  live: false,
  defaultSize: { w: 2, h: 2 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  onExpand: function(container, sizeHint) {
    var layout = (sizeHint && sizeHint.layout) || 'wide';
    _activeContainer = container;

    // 窄/高布局一律用 square 渲染(单列竖排,内容全),避免精简版藏掉「重叠/分块大小」等核心设置
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

    // Populate model/size selects
    _populateModelSelect(container.querySelector('#tiledModelInput'));
    _onModelChange(container);

    // Restore saved size
    var savedSize = TileAPI.storage.get('tiled.size');
    var sizeSel = container.querySelector('#tiledSizeInput');
    if (savedSize && sizeSel) {
      for (var i = 0; i < sizeSel.options.length; i++) {
        if (sizeSel.options[i].value === savedSize) { sizeSel.value = savedSize; break; }
      }
    }

    _bindEvents(container);

    // Restore running state
    if (_tiledRunning) _setRunningUI(container, true);

    return function() { _activeContainer = null; };
  },

  onMessage: function(action, data) {
    var container = _activeContainer;

    if (action === 'confirmTiledUpscale' && data) {
      _pendingConfirmParams = data.params;
      TileAPI.confirm(data.message).then(function(ok) {
        if (ok && _pendingConfirmParams) {
          TileAPI.sendToHost('confirmTiledUpscaleYes', _pendingConfirmParams);
          TileAPI.toast('分块放大已开始', 'info');
        } else {
          // #5: 取消 → 清掉 _doStart 提前占位的任务卡片, 否则永久残留
          if (_tiledPendingTaskId) {
            var rn = TileAPI.state.get('tasks.running') || {};
            var mt = TileAPI.state.get('tasks.meta') || {};
            if (rn[_tiledPendingTaskId]) { delete rn[_tiledPendingTaskId]; TileAPI.state.set('tasks.running', rn); }
            if (mt[_tiledPendingTaskId]) { delete mt[_tiledPendingTaskId]; TileAPI.state.set('tasks.meta', mt); }
            TileAPI.emit('tasks:updated');
          }
        }
        _pendingConfirmParams = null;
        _tiledPendingTaskId = null;
      });
    }

    if (action === 'tiledUpscaleStarted' && data) {
      _tiledTaskId = data.taskId || null;
      if (container) _setRunningUI(container, true);
    }

    if (action === 'tiledUpscaleComplete') {
      // Host 同时发送正式 taskComplete，tasks-service 统一移除并记账。
      var doneTid = (data && data.taskId) || _tiledTaskId;
      _tiledTaskId = null;
      if (container) _setRunningUI(container, false);
    }

    if (action === 'tiledUpscaleProgress' && data) {
      _progressData.total = data.total || _progressData.total;
      if (data.status === 'success') _progressData.success++;
      else if (data.status === 'fail') _progressData.fail++;
      if (container) {
        var btn = container.querySelector('#tiledStartBtn');
        _applyProgressGradient(btn, _progressData);
      }
      // 同步进度到统一任务池(让任务磁贴的进度条联动)
      var progTid = (data && data.taskId) || _tiledTaskId;
      if (progTid) {
        var rng = TileAPI.state.get('tasks.running') || {};
        if (rng[progTid]) {
          rng[progTid].success = _progressData.success;
          rng[progTid].fail = _progressData.fail;
          rng[progTid].total = _progressData.total;
          TileAPI.state.set('tasks.running', rng);
          TileAPI.emit('tasks:updated');
        }
      }
    }

    if (action === 'tiledFillTestComplete' && data) {
      if (data.success) {
        TileAPI.toast('分块可视化测试完成! ' + (data.count || '') + ' 块已填充', 'success');
      } else {
        TileAPI.toast('分块测试失败: ' + (data.error || ''), 'error');
      }
      if (container) {
        var testBtn = container.querySelector('#tiledTestBtn');
        if (testBtn) {
          testBtn.textContent = '可视化测试';
          testBtn.style.pointerEvents = '';
        }
      }
    }
  },

  onStorageLoaded: function(storage) {
    // Nothing to restore at startup
  },
});

})();
