// ============================================================
//  tile-partition.js - 全局分区生成磁贴
//  多文档批量分区生成：横图=左上+右上，竖图=左上+左下，方图=全图
// ============================================================
(function() {
'use strict';

// ========== 私有状态 ==========
var _activeContainer = null;
var _running = false;
var _taskId = null;
var _subTaskIds = []; // #4: 本次分区注册到任务列表的所有子任务ID
var _openDocs = []; // [{id, name, width, height}]
var _progressData = { success: 0, fail: 0, total: 0 };

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _resetProgress() {
  _progressData = { success: 0, fail: 0, total: 0 };
}

// ========== 磁贴注册 ==========

TileAPI.registerTile({
  id: 'partition',
  group: 'main',
  icon: '🗺️',
  label: '全局分区',
  desc: '多文档分区生成',
  live: false,
  defaultSize: { w: 2, h: 2 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  onExpand: function(container, sizeHint) {
    var layout = (sizeHint && sizeHint.layout) || 'wide';

    // 窄/高布局一律用 square 渲染(单列竖排,内容全),避免精简版改不了蒙版/批次/超时
    if (layout === 'narrow' || layout === 'tall') layout = 'square';

    if (layout === 'narrow' || layout === 'tall') {
      _renderNarrow(container);
    } else if (layout === 'wideshort') {
      _renderWideShort(container, layout);
    } else if (layout === 'square') {
      _renderSquare(container, layout);
    } else {
      _renderWide(container, layout);
    }

    _activeContainer = container;
    _bindEvents(container);
    _loadSavedValues(container);

    return function() { _activeContainer = null; };
  },

  onMessage: function(action, data) {
    _handleHostMessage(action, data);
  },

  onStorageLoaded: function(storage) {
    _running = false;
    _taskId = null;
  }
});

// ========== 布局渲染 ==========

function _renderPromptSection(layout) {
  var prompt = TileAPI.storage.get('partition.prompt') || '';
  var isNarrow = (layout === 'narrow' || layout === 'tall');
  var btnStyle = isNarrow ? 'padding:2px 6px;font-size:12px;' : 'padding:4px 8px;font-size:14px;';
  return '' +
    '<div class="w10-section-title">提示词（用于所有分区）</div>' +
    '<div class="w10-row" style="flex-direction:column;align-items:stretch;">' +
      '<div style="display:flex;gap:4px;margin-bottom:4px;">' +
        '<textarea class="w10-input" id="partPromptInput" rows="' + (isNarrow ? 2 : 3) + '" placeholder="输入提示词..." style="flex:1;resize:vertical;">' + _esc(prompt) + '</textarea>' +
        '<button class="w10-btn" id="partPresetSearch" title="搜索预设" style="align-self:flex-start;' + btnStyle + '">🔍</button>' +
      '</div>' +
    '</div>';
}

function _renderDocListSection() {
  return '' +
    '<div class="w10-section-title">处理文档</div>' +
    '<div class="w10-row" style="align-items:center;">' +
      '<div class="w10-row-left"><div class="w10-row-label">打开的文档</div>' +
        '<div class="w10-row-desc">横图用左上+右上，竖图用左上+左下，方图用全图</div>' +
      '</div>' +
      '<div class="w10-row-right">' +
        '<button class="w10-btn" id="partRefreshDocsBtn">刷新</button>' +
      '</div>' +
    '</div>' +
    '<div id="partDocList" style="max-height:120px;overflow-y:auto;padding:4px 0;">' +
      '<span style="color:var(--text-sub);font-style:italic;font-size:10px;">点击“刷新”加载文档列表</span>' +
    '</div>';
}

function _renderParamsSection() {
  var provider = TileAPI.storage.get('partition.provider') || 'aji';
  var model = TileAPI.storage.get('partition.model') || '';
  var size = TileAPI.storage.get('partition.size') || '2K';
  var ratio = TileAPI.storage.get('partition.ratio') || 'Auto';
  var batch = TileAPI.storage.get('partition.batch') || 1;
  var timeout = TileAPI.storage.get('partition.timeout') || 3600;
  return '' +
    '<div class="w10-section-title">参数</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">API 引擎</div></div>' +
      '<div class="w10-row-right">' +
        '<select class="w10-select" id="partProviderInput" style="min-width:80px;">' +
          (TileAPI.slotOrder ? TileAPI.slotOrder() : ['aji', 'grs', 'others']).map(function(eng) {
            var def = eng === 'aji' ? 'Aji' : eng === 'grs' ? 'Grs' : eng === 'momo' ? '墨墨' : 'Others';
            var label = (TileAPI.slotLabel ? TileAPI.slotLabel(eng, def) : def);
            return '<option value="' + eng + '"' + (provider === eng ? ' selected' : '') + '>' + label + '</option>';
          }).join('') +
        '</select>' +
      '</div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">模型</div></div>' +
      '<div class="w10-row-right">' +
        '<select class="w10-select" id="partModelInput" style="min-width:100px;"></select>' +
      '</div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">分辨率</div></div>' +
      '<div class="w10-row-right">' +
        '<select class="w10-select" id="partSizeInput" style="min-width:80px;"></select>' +
      '</div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">比例</div></div>' +
      '<div class="w10-row-right">' +
        '<select class="w10-select" id="partRatioInput" style="min-width:80px;">' +
          '<option value="Auto">Auto</option>' +
          '<option value="1:1">1:1</option>' +
          '<option value="16:9">16:9</option>' +
          '<option value="9:16">9:16</option>' +
          '<option value="4:3">4:3</option>' +
          '<option value="3:4">3:4</option>' +
        '</select>' +
      '</div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">每区数量</div></div>' +
      '<div class="w10-row-right">' +
        '<input type="number" class="w10-input" id="partBatchInput" min="1" max="20" value="' + batch + '" style="width:50px;">' +
      '</div>' +
    '</div>' +
    '<input type="hidden" id="partTimeoutInput" value="3600">';   // v6.5.1: 超时 UI 隐藏, 值拉满
}

function _renderMaskSection() {
  var inset = TileAPI.storage.get('partition.maskInset');
  if (inset === undefined || inset === null) inset = 400;
  var blur = TileAPI.storage.get('partition.maskBlur');
  if (blur === undefined || blur === null) blur = 200;
  return '' +
    '<div class="w10-section-title">蓬罩参数</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">蓬罩内收</div>' +
        '<div class="w10-row-desc">px，分区接缝处内收量</div>' +
      '</div>' +
      '<div class="w10-row-right">' +
        '<input type="number" class="w10-input" id="partMaskInsetInput" min="0" max="2000" value="' + inset + '" style="width:60px;">' +
      '</div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">蓬罩模糊</div>' +
        '<div class="w10-row-desc">px，分区接缝处模糊量</div>' +
      '</div>' +
      '<div class="w10-row-right">' +
        '<input type="number" class="w10-input" id="partMaskBlurInput" min="0" max="2000" value="' + blur + '" style="width:60px;">' +
      '</div>' +
    '</div>';
}

function _renderActionSection() {
  return '' +
    '<div style="margin-top:8px;">' +
      '<button class="w10-btn w10-btn-accent" id="partStartBtn" style="width:100%;">▶ 开始全局分区计算</button>' +
    '</div>';
}

// --- Wide 布局 (w>=2, h>=2) ---
function _renderWide(container, layout) {
  container.innerHTML =
    '<div class="w10-panel">' +
      _renderPromptSection(layout) +
      _renderParamsSection() +
      _renderDocListSection() +
      _renderMaskSection() +
      _renderActionSection() +
    '</div>';
}

// --- WideShort 布局 (w>=3, h=1) ---
function _renderWideShort(container, layout) {
  container.innerHTML =
    '<div class="w10-panel" style="display:flex;gap:12px;">' +
      '<div style="flex:1;min-width:0;">' +
        _renderPromptSection(layout) +
        _renderParamsSection() +
        _renderMaskSection() +
        _renderActionSection() +
      '</div>' +
      '<div style="flex:1;min-width:0;">' +
        _renderDocListSection() +
      '</div>' +
    '</div>';
}

// --- Square 布局 ---
function _renderSquare(container, layout) {
  container.innerHTML =
    '<div class="w10-panel">' +
      _renderPromptSection(layout) +
      _renderParamsSection() +
      _renderDocListSection() +
      _renderMaskSection() +
      _renderActionSection() +
    '</div>';
}

// --- Narrow/Tall 布局 (w=1) ---
function _renderNarrow(container) {
  var prompt = TileAPI.storage.get('partition.prompt') || '';
  container.innerHTML =
    '<div class="w10-panel">' +
      '<div class="w10-row">' +
        '<textarea class="w10-input" id="partPromptInput" rows="2" placeholder="提示词..." style="width:100%;resize:vertical;">' + _esc(prompt) + '</textarea>' +
      '</div>' +
      '<div style="display:flex;gap:4px;margin:4px 0;">' +
        '<button class="w10-btn" id="partRefreshDocsBtn" style="flex:1;">刷新文档</button>' +
      '</div>' +
      '<div id="partDocList" style="max-height:80px;overflow-y:auto;padding:2px 0;">' +
        '<span style="color:var(--text-sub);font-style:italic;font-size:10px;">点击刷新</span>' +
      '</div>' +
      '<input type="hidden" id="partProviderInput" value="' + (TileAPI.storage.get('partition.provider') || 'aji') + '">' +
      '<select class="w10-select" id="partModelInput" style="width:100%;margin:4px 0;"></select>' +
      '<select class="w10-select" id="partSizeInput" style="width:100%;margin:4px 0;"></select>' +
      '<input type="hidden" id="partRatioInput" value="Auto">' +
      '<input type="hidden" id="partBatchInput" value="1">' +
      '<input type="hidden" id="partTimeoutInput" value="3600">' +
      '<input type="hidden" id="partMaskInsetInput" value="' + (TileAPI.storage.get('partition.maskInset') !== undefined ? TileAPI.storage.get('partition.maskInset') : 400) + '">' +
      '<input type="hidden" id="partMaskBlurInput" value="' + (TileAPI.storage.get('partition.maskBlur') !== undefined ? TileAPI.storage.get('partition.maskBlur') : 200) + '">' +
      '<button class="w10-btn w10-btn-accent" id="partStartBtn" style="width:100%;margin-top:4px;">▶ 开始分区</button>' +
    '</div>';
}

// ========== 文档列表渲染 ==========

function _renderDocList(docs) {
  _openDocs = docs || [];
  var container = document.getElementById('partDocList');
  if (!container) return;
  if (_openDocs.length === 0) {
    container.innerHTML = '<span style="color:var(--text-sub);font-style:italic;font-size:10px;">没有打开的文档</span>';
    return;
  }
  var cols = container.offsetWidth < 200 ? '1fr' : '1fr 1fr';
  container.style.display = 'grid';
  container.style.gridTemplateColumns = cols;
  container.style.gap = '2px 8px';
  container.innerHTML = '';
  _openDocs.forEach(function(doc) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:5px;padding:2px;cursor:pointer;border-radius:3px;min-width:0;';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.docId = doc.id;
    cb.style.cssText = 'accent-color:var(--accent);margin:0;width:13px;min-width:13px;height:13px;flex-shrink:0;';
    var text = document.createElement('span');
    text.textContent = doc.name;
    text.title = doc.name + ' (' + doc.width + '×' + doc.height + ')';
    text.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-main);font-size:10px;line-height:1.3;';
    row.addEventListener('click', function(e) { if (e.target !== cb) cb.checked = !cb.checked; });
    row.appendChild(cb);
    row.appendChild(text);
    container.appendChild(row);
  });
  TileAPI.toast('已加载 ' + _openDocs.length + ' 个文档', 'info');
}

function _getSelectedDocIds() {
  var container = document.getElementById('partDocList');
  if (!container) return [];
  var cbs = container.querySelectorAll('input[type="checkbox"]:checked');
  var ids = [];
  for (var i = 0; i < cbs.length; i++) { ids.push(Number(cbs[i].dataset.docId)); }
  return ids;
}

// ========== 模型/尺寸联动 ==========

// 读取当前 provider 对应的 model config
// 注意:tile-params.js 启动时把 MODEL_CONFIG / GRS_MODEL_CONFIG 写到 TileAPI.state['models.aji'] / 'models.grs'
function _getActiveModelCfg() {
  var provider = TileAPI.storage.get('partition.provider') || 'aji';
  var key = 'models.' + provider;
  return TileAPI.state.get(key) || {};
}

function _populateModels(container) {
  var sel = container.querySelector('#partModelInput');
  if (!sel) return;
  var cfg = _getActiveModelCfg();
  sel.innerHTML = '';
  var ids = Object.keys(cfg);
  if (ids.length === 0) {
    var opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = '(无可用模型)';
    sel.appendChild(opt0);
    return;
  }
  ids.forEach(function(mid) {
    var opt = document.createElement('option');
    opt.value = mid;
    // 字段名是 name 不是 displayName
    opt.textContent = (cfg[mid] && cfg[mid].name) || mid;
    sel.appendChild(opt);
  });
  var saved = TileAPI.storage.get('partition.model');
  if (saved && sel.querySelector('option[value="' + saved + '"]')) {
    sel.value = saved;
  } else {
    // 保存的模型不在当前 provider 下,选第一个并写回 storage
    sel.value = ids[0];
    TileAPI.storage.set('partition.model', sel.value);
  }
  _onModelChange(container);
}

function _onModelChange(container) {
  var modelSel = container.querySelector('#partModelInput');
  var sizeSel = container.querySelector('#partSizeInput');
  if (!modelSel || !sizeSel) return;
  var modelId = modelSel.value;
  var cfg = _getActiveModelCfg();
  if (!cfg[modelId]) return;
  var mc = cfg[modelId];
  var curSize = sizeSel.value;
  sizeSel.innerHTML = '';
  if (mc.sizes && mc.sizes.length) {
    mc.sizes.forEach(function(s) {
      var opt = document.createElement('option');
      opt.value = s; opt.textContent = s;
      sizeSel.appendChild(opt);
    });
  }
  // 优先保留用户选过的 size,否则用模型默认 size,字段名是 default 不是 defaultSize
  var savedSize = TileAPI.storage.get('partition.size');
  var preferred = savedSize && mc.sizes && mc.sizes.indexOf(savedSize) !== -1 ? savedSize :
                  (curSize && mc.sizes && mc.sizes.indexOf(curSize) !== -1 ? curSize : null);
  if (preferred) {
    sizeSel.value = preferred;
  } else if (mc.default) {
    sizeSel.value = mc.default;
  }
  if (sizeSel.value) TileAPI.storage.set('partition.size', sizeSel.value);
}

// ========== 事件绑定 ==========

function _bindEvents(container) {
  // 刷新文档
  var refreshBtn = container.querySelector('#partRefreshDocsBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', function() {
    TileAPI.sendToHost('fetchOpenDocs', {});
    TileAPI.toast('正在刷新文档列表...', 'info');
  });

  // 模型选择变化
  var modelSel = container.querySelector('#partModelInput');
  if (modelSel) modelSel.addEventListener('change', function() {
    _onModelChange(container);
    TileAPI.storage.set('partition.model', modelSel.value);
  });

  // Provider 变化
  var providerSel = container.querySelector('#partProviderInput');
  if (providerSel && providerSel.type !== 'hidden') {
    providerSel.addEventListener('change', function() {
      TileAPI.storage.set('partition.provider', providerSel.value || 'aji');
      // 切换 provider 后需要重新填模型(不同 provider 的模型列表不同)
      _populateModels(container);
    });
  }

  // 超时滑块
  var timeoutSlider = container.querySelector('#partTimeoutInput');
  var timeoutVal = container.querySelector('#partTimeoutVal');
  if (timeoutSlider && timeoutSlider.type === 'range') {
    timeoutSlider.addEventListener('input', function() {
      if (timeoutVal) timeoutVal.textContent = timeoutSlider.value;
      TileAPI.storage.set('partition.timeout', timeoutSlider.value);
    });
  }

  // 持久化
  var promptEl = container.querySelector('#partPromptInput');
  if (promptEl) promptEl.addEventListener('change', function() {
    TileAPI.storage.set('partition.prompt', promptEl.value);
  });

  var batchEl = container.querySelector('#partBatchInput');
  if (batchEl) batchEl.addEventListener('change', function() {
    TileAPI.storage.set('partition.batch', batchEl.value);
  });

  var maskInsetEl = container.querySelector('#partMaskInsetInput');
  if (maskInsetEl) maskInsetEl.addEventListener('change', function() {
    TileAPI.storage.set('partition.maskInset', maskInsetEl.value);
  });

  var maskBlurEl = container.querySelector('#partMaskBlurInput');
  if (maskBlurEl) maskBlurEl.addEventListener('change', function() {
    TileAPI.storage.set('partition.maskBlur', maskBlurEl.value);
  });

  var sizeEl = container.querySelector('#partSizeInput');
  if (sizeEl) sizeEl.addEventListener('change', function() {
    TileAPI.storage.set('partition.size', sizeEl.value);
  });

  var ratioEl = container.querySelector('#partRatioInput');
  if (ratioEl && ratioEl.type !== 'hidden') {
    ratioEl.addEventListener('change', function() {
      TileAPI.storage.set('partition.ratio', ratioEl.value);
    });
  }

  // 开始按钮
  var startBtn = container.querySelector('#partStartBtn');
  if (startBtn) startBtn.addEventListener('click', function() {
    if (_running) {
      // 提前结束 (停掉本次分区注册的所有子任务, 等价任务列表逐个停)
      if (_subTaskIds && _subTaskIds.length) {
        _subTaskIds.forEach(function(tid) { TileAPI.sendToHost('earlyStopTask', { taskId: tid }); });
      } else if (_taskId) {
        TileAPI.sendToHost('earlyStopTask', { taskId: _taskId });
      } else {
        TileAPI.sendToHost('earlyStop', {});
      }
      TileAPI.toast('正在结束...', 'warn');
      startBtn.textContent = '⏳ 正在结束...';
      return;
    }
    _doStart(container);
  });

  // 填充模型列表
  _populateModels(container);

  // Preset search button
  _bindPartPresetSearch(container);
}

function _doStart(container) {
  var promptEl = container.querySelector('#partPromptInput');
  var prompt = promptEl ? promptEl.value.trim() : '';
  if (!prompt) {
    TileAPI.toast('请填写提示词', 'error');
    return;
  }

  // bug #45/#66: provider 以面板下拉为准(退回 partition.provider);
  //   Key/URL 走统一入口 _settingsGetActiveConnection(provider) —— 按分区自己选的 provider 取,
  //   并处理 GRS "夏算力托管" 路径(代理用户 connection.grs.key 为空也能拿到 sub-key)。
  //   原来先读 connection.<provider>.key 再被 getActiveApiKey(全局引擎)无条件覆盖, 会跨家错配。
  var providerEl0 = container.querySelector('#partProviderInput');
  var provider = (providerEl0 && providerEl0.value) || TileAPI.storage.get('partition.provider') || 'aji';
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
  if (!apiKey) { TileAPI.toast(provider.toUpperCase() + ' Key 未填写', 'error'); return; }
  if (!apiBaseUrl) {
    if (provider === 'aji') TileAPI.toast('AJI 服务器未校验, 请到顶栏粘贴 Key 或点"校验 Key"按钮', 'error');
    else TileAPI.toast(provider.toUpperCase() + ' 地址未填写', 'error');
    return;
  }

  var selectedIds = _getSelectedDocIds();
  if (selectedIds.length === 0 && _openDocs.length > 0) {
    TileAPI.toast('请至少勾选一个文档', 'error');
    return;
  }

  var modelEl = container.querySelector('#partModelInput');
  var sizeEl = container.querySelector('#partSizeInput');
  var ratioEl = container.querySelector('#partRatioInput');
  var batchEl = container.querySelector('#partBatchInput');
  var timeoutEl = container.querySelector('#partTimeoutInput');
  var maskInsetEl = container.querySelector('#partMaskInsetInput');
  var maskBlurEl = container.querySelector('#partMaskBlurInput');

  TileAPI.sendToHost('startGlobalPartition', {
    provider: provider,
    prompt: prompt,
    apiKey: apiKey,
    apiBaseUrl: apiBaseUrl,
    model: modelEl ? modelEl.value : '',
    size: sizeEl ? sizeEl.value : '2K',
    aspectRatio: ratioEl ? ratioEl.value : 'Auto',
    batchSize: parseInt(batchEl ? batchEl.value : '1') || 1,
    timeout: parseInt(timeoutEl ? timeoutEl.value : '3600') || 3600,
    maskInsetPx: parseInt(maskInsetEl ? maskInsetEl.value : '400') || 400,
    maskBlurPx: parseInt(maskBlurEl ? maskBlurEl.value : '200') || 200,
    antiMode: TileAPI.storage.get('params.antiMode') || 0,
    layerType: TileAPI.storage.get('output.layerType') || 'smartObject',
    maxResolution: TileAPI.storage.get('output.maxResolution') || 2048,
    autoReturn: TileAPI.storage.get('output.autoReturn') !== false,
    selectedDocIds: selectedIds
  });
  TileAPI.toast('开始全局分区', 'info');
}

// ========== 加载保存值 ==========

function _loadSavedValues(container) {
  var ratioEl = container.querySelector('#partRatioInput');
  if (ratioEl && ratioEl.type !== 'hidden') {
    var savedRatio = TileAPI.storage.get('partition.ratio');
    if (savedRatio) ratioEl.value = savedRatio;
  }
  // bug #65: provider 下拉恢复"分区自己记的引擎"(partition.provider), 不再用全局 connection.provider 覆盖,
  //   否则每次打开磁贴都把上次选的引擎(如 GRS)冲回全局引擎。
  var providerEl = container.querySelector('#partProviderInput');
  if (providerEl && providerEl.type !== 'hidden') {
    var savedProvider = TileAPI.storage.get('partition.provider') || 'aji';
    providerEl.value = savedProvider;
  }
}

// ========== 运行状态 UI ==========

function _setRunning(running) {
  _running = running;
  var container = _activeContainer;
  if (!container) return;
  var btn = container.querySelector('#partStartBtn');
  if (!btn) return;
  if (running) {
    _resetProgress();
    btn.textContent = '⏹ 提前结束';
    btn.classList.remove('w10-btn-accent');
    btn.style.color = '#ff6b6b';
    btn.style.borderColor = 'rgba(255,100,100,0.3)';
  } else {
    _resetProgress();
    btn.textContent = '▶ 开始全局分区计算';
    btn.classList.add('w10-btn-accent');
    btn.style.color = '';
    btn.style.borderColor = '';
  }
}

function _updateProgressButton(total, status) {
  _progressData.total = total;
  if (status === 'success') _progressData.success++;
  else if (status === 'fail') _progressData.fail++;
  var container = _activeContainer;
  if (!container) return;
  var btn = container.querySelector('#partStartBtn');
  if (!btn || !_running) return;
  var pd = _progressData;
  if (pd.total <= 0) return;
  var successPct = (pd.success / pd.total) * 100;
  var failPct = (pd.fail / pd.total) * 100;
  var pendingPct = 100 - successPct - failPct;
  var stops = [];
  var pos = 0;
  if (successPct > 0) { stops.push('#4caf50 ' + pos + '%'); pos += successPct; stops.push('#4caf50 ' + pos + '%'); }
  if (failPct > 0) { stops.push('#ff9800 ' + pos + '%'); pos += failPct; stops.push('#ff9800 ' + pos + '%'); }
  if (pendingPct > 0) { stops.push('#d32f2f ' + pos + '%'); stops.push('#d32f2f 100%'); }
  btn.style.background = 'linear-gradient(90deg, ' + stops.join(', ') + ')';
  btn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
  var completed = pd.success + pd.fail;
  btn.textContent = '⏹ ' + completed + '/' + pd.total + ' 提前结束';
}

// ========== 后端消息处理 ==========

function _handleHostMessage(action, data) {
  // 文档列表
  if (action === 'openDocsResult') {
    _renderDocList(data && data.docs ? data.docs : []);
  }

  // 确认对话框
  if (action === 'confirmGlobalPartition') {
    var msg = (data && data.message) ? data.message : '确定开始全局分区？';
    TileAPI.confirm(msg).then(function(ok) {
      if (ok) {
        TileAPI.sendToHost('confirmGlobalPartitionYes', data.params);
      }
    });
  }

  // 开始
  if (action === 'globalStarted') {
    _taskId = (data && data.taskId) || null;
    _setRunning(true);
  }

  // #4: host 通知注册任务列表条目 (每个 [文档×分区] 一条)
  if (action === 'partitionTasksRegistered') {
    var tasks = (data && data.tasks) || [];
    var running = TileAPI.state.get('tasks.running') || {};
    var meta = TileAPI.state.get('tasks.meta') || {};
    _subTaskIds = [];
    tasks.forEach(function(t) {
      _subTaskIds.push(t.taskId);
      running[t.taskId] = {
        engine: 'banana', provider: t.provider, batchSize: t.batchSize,
        startTime: Date.now(), success: 0, fail: 0, total: t.batchSize, model: t.model,
        presetTitle: '全局分区',
        promptSnippet: '分区 · ' + (t.docName || '') + ' / ' + (t.selName || ''),
        thumbnail: null, docId: t.docId, selection: null, resolution: t.size
      };
      meta[t.taskId] = { countdown: t.timeout, timeoutSec: t.timeout, autoReturn: data.autoReturn !== false, batchSize: t.batchSize };
    });
    TileAPI.state.set('tasks.running', running);
    TileAPI.state.set('tasks.meta', meta);
    TileAPI.emit('tasks:updated');
    tasks.forEach(function(t) {
      TileAPI.emit('task:started', { taskId: t.taskId, timeoutSec: t.timeout, batchSize: t.batchSize });
    });
  }

  // 进度
  if (action === 'globalProgress') {
    if (data) _updateProgressButton(data.total, data.status);
  }

  // 完成
  if (action === 'globalComplete') {
    _taskId = null;
    _subTaskIds = [];
    _setRunning(false);
    TileAPI.toast('全局分区完成', 'success');
  }
}


// ========== Preset search helper ==========
// 紧凑模糊匹配: 子串优先; 跨字符仅当字符间隔 ≤ 2 时才命中, 防止"两字命中所有预设"的噪声
function _partFuzzy(text, q) {
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

  function _renderList(q) {
    var ql = (q || '').toLowerCase().trim();
    var filtered = ql
      ? bananaPresets.filter(function(p) {
          // title 用紧凑模糊; content 只用纯子串 (长正文跨字符噪声大)
          if (_partFuzzy(p.title, ql)) return true;
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

  TileAPI.dialog({
    title: '搜索预设',
    html: '<input class="w10-input" id="psiFilter" placeholder="搜索预设名称..." style="width:100%;margin-bottom:8px;" autofocus><div id="psiList" style="max-height:300px;overflow-y:auto;">' + _renderList('') + '</div>',
    buttons: ['取消'],
    accent: 0
  }).then(function() {});

  setTimeout(function() {
    var inp = document.getElementById('psiFilter');
    var list = document.getElementById('psiList');
    if (!inp || !list) return;
    inp.addEventListener('input', function() { list.innerHTML = _renderList(inp.value); });
    list.addEventListener('click', function(e) {
      var row = e.target.closest('[data-psi]');
      if (!row) return;
      var idx = parseInt(row.getAttribute('data-psi'), 10);
      var ql = (inp.value || '').toLowerCase().trim();
      var filtered = ql
        ? bananaPresets.filter(function(p) {
            if (_partFuzzy(p.title, ql)) return true;
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

// Bind preset search button
var _bindPartPresetSearch = function(container) {
  var psBtn = container.querySelector('#partPresetSearch');
  if (psBtn) {
    psBtn.addEventListener('click', function() {
      var ta = container.querySelector('#partPromptInput');
      _openPresetPicker(function(text) {
        if (ta) { ta.value = text; TileAPI.storage.set('partition.prompt', text); }
      });
    });
  }
};
})();
