// ============================================================
//  tile-light-splitter.js — 自动拆光 前端磁贴
//  流程: 分析光源(LLM vision) → 用户确认/编辑/增删 → 批量分离(banana) → PS多图层输出
//  UI遵循 _dev/UI_SPEC.md: 单层 .w10-panel + 标准 .w10-* 组件
// ============================================================
(function() {
'use strict';

// ========== Private state ==========
var _activeContainer = null;
var _analyzing = false;
var _sources = [];      // 分析结果列表 [{type, direction, color, area, intensity, description, enabled}]
var _splitting = false;
var _splitProgress = { done: 0, total: 0, results: [] };
var _taskIdToIdx = {};   // taskId → _splitProgress.results 下标 (runSingle任务归属映射)
var _taskIdToLabel = {}; // taskId → 光源标签 (attach-layers后处理用; 不随结算删除, 防时序竞争)
var _sharedCapture = null;  // 首个任务抓到的 {base64, selection, docId} — 后续任务reuseCapture共用
var _firstTaskId = null;    // 首个任务的taskId — previewImage按它回填_sharedCapture

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ========== 存储 ==========
function _getConcurrency() { return parseInt(TileAPI.storage.get('lightSplitter.concurrency'), 10) || 2; }
function _setConcurrency(v) { TileAPI.storage.set('lightSplitter.concurrency', Math.max(1, Math.min(4, parseInt(v, 10) || 2))); }

// ========== 渲染 ==========
function _renderLayout(container) {
  var concurrency = _getConcurrency();
  var provider = TileAPI.storage.get('lightSplitter.provider') || TileAPI.state.get('params.provider') || 'aji';

  var html = '<div class="w10-panel">';

  // —— 标题 ——
  html += '<div class="w10-section-title" style="display:flex;align-items:center;justify-content:space-between;">' +
    '<span>🔦 自动拆光</span>' +
    '<button class="w10-btn" id="lsAnalyzeBtn" style="padding:2px 10px;font-size:11px;flex-shrink:0;">' +
      (_analyzing ? '分析中...' : '🤖 分析光源') + '</button>' +
  '</div>';

  if (_analyzing) {
    html += '<div class="w10-row-desc" style="text-align:center;">正在抓取选区并调用语言模型分析光源...</div>';
  }

  // —— 分析结果列表 ——
  if (_sources.length > 0) {
    html += '<div class="w10-section-title" style="font-size:11px;">分析结果 (' + _sources.filter(function(s) { return s.enabled; }).length + '/' + _sources.length + ' 束)</div>';

    for (var i = 0; i < _sources.length; i++) {
      var s = _sources[i];
      // 全block布局+按钮绝对定位: UXP的flex宽度分配不可靠(标题被压零宽/按钮被推出面板),
      // 干脆一点flex不用: 容器relative, 按钮absolute钉右上, 标题block+padding-right给按钮留位
      html += '<div style="display:block;position:relative;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.03);">' +
        '<div style="position:absolute;top:6px;right:0;">' +
          '<button class="w10-btn ls-edit" data-idx="' + i + '" style="padding:2px 6px;font-size:10px;">编辑</button>' +
          '<button class="w10-btn ls-del" data-idx="' + i + '" style="padding:2px 6px;font-size:10px;color:var(--w10-danger,#e74c3c);margin-left:4px;">删除</button>' +
        '</div>' +
        '<div style="display:block;padding-right:96px;font-size:12px;font-weight:600;white-space:normal;word-break:break-word;">' +
          '<input type="checkbox" ' + (s.enabled ? 'checked' : '') + ' data-idx="' + i + '" class="ls-cb" style="margin:0 6px 0 0;vertical-align:middle;">' +
          '#' + (i + 1) + ' ' + _esc(s.type) + ' · ' + _esc(s.direction) + '</div>' +
        '<div style="display:block;font-size:10px;color:var(--text-sub,#999);margin-top:2px;padding-left:22px;white-space:normal;word-break:break-word;">' +
          _esc(s.color) + ' · ' + _esc(s.intensity) + ' · ' + _esc(s.area) + '</div>' +
        (s.description ? '<div style="display:block;font-size:10px;color:var(--text-sub,#888);margin-top:1px;padding-left:22px;white-space:normal;word-break:break-word;">' + _esc(s.description) + '</div>' : '') +
      '</div>';
    }

    // 手动添加
    html += '<div class="w10-row" style="justify-content:center;padding:4px 0;">' +
      '<button class="w10-btn" id="lsAddBtn" style="padding:2px 10px;font-size:11px;">+ 手动添加光源</button>' +
    '</div>';

    // 并发数
    html += '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">并发数</div></div>' +
      '<div class="w10-row-right"><select class="w10-select" id="lsConcurrency" style="width:80px;">' +
        '<option value="1"' + (concurrency === 1 ? ' selected' : '') + '>1</option>' +
        '<option value="2"' + (concurrency === 2 ? ' selected' : '') + '>2</option>' +
        '<option value="3"' + (concurrency === 3 ? ' selected' : '') + '>3</option>' +
        '<option value="4"' + (concurrency === 4 ? ' selected' : '') + '>4</option>' +
      '</select></div>' +
    '</div>';

    // 分离进度
    if (_splitting) {
      html += '<div style="padding:6px 0;">';
      html += '<div class="w10-row-desc" style="text-align:center;">分离进度: ' + _splitProgress.done + '/' + _splitProgress.total + '</div>';
      for (var j = 0; j < _splitProgress.results.length; j++) {
        var r = _splitProgress.results[j];
        var icon = r.status === 'success' ? '✓' : r.status === 'fail' ? '❌' : r.status === 'running' ? '⏳' : '…';
        html += '<div style="font-size:10px;text-align:center;">' + icon + ' ' + _esc(r.label) + (r.error ? ' (' + _esc(r.error) + ')' : '') + '</div>';
      }
      html += '</div>';
    }
  } else if (!_analyzing) {
    html += '<div class="w10-row-desc ls-placeholder">在 PS 里框选人物后点击「分析光源」</div>';
  }

  // —— 生成参数 ——
  if (_sources.length > 0 && !_splitting) {
    html += '<div class="w10-section-title">生成</div>';
    var slotOrder = TileAPI.slotOrder ? TileAPI.slotOrder() : ['aji'];
    html += '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">API 引擎</div></div>' +
      '<div class="w10-row-right"><select class="w10-select" id="lsProvider" style="width:150px;">';
    for (var pi = 0; pi < slotOrder.length; pi++) {
      var eng = slotOrder[pi];
      var def = eng === 'aji' ? 'AJI' : eng === 'grs' ? (TileAPI.computeBrand ? TileAPI.computeBrand() : 'GRS') : 'Others';
      html += '<option value="' + eng + '"' + (provider === eng ? ' selected' : '') + '>' + (TileAPI.slotLabel ? TileAPI.slotLabel(eng, def) : def) + '</option>';
    }
    html += '</select></div></div>';

    html += '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">模型</div></div>' +
      '<div class="w10-row-right"><select class="w10-select" id="lsModel" style="width:150px;"></select></div></div>';

    html += '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">分辨率</div></div>' +
      '<div class="w10-row-right"><select class="w10-select" id="lsSize" style="width:150px;"></select></div></div>';

    // 开始分离按钮
    html += '<div class="w10-row" style="border-bottom:none;flex-direction:column;align-items:stretch;gap:8px;">' +
      '<button class="w10-btn w10-btn-accent" id="lsStartBtn">✨ 开始分离 (' +
        _sources.filter(function(s) { return s.enabled; }).length + ' 束)</button>' +
    '</div>';
  }

  // —— 状态栏 ——
  if (_splitting) {
    html += '<div class="w10-row" style="border-bottom:none;flex-direction:column;align-items:stretch;">' +
      '<button class="w10-btn" id="lsCancelBtn">取消后续任务</button>' +
    '</div>';
  }

  html += '</div>';
  container.innerHTML = html;
}

function _afterRender(container) {
  // 填充模型/分辨率下拉
  _populateModelSelect(container);
  _bindEvents(container);
}

function _populateModelSelect(container) {
  var providerSel = container.querySelector('#lsProvider');
  if (!providerSel) return;
  var provider = providerSel.value || 'aji';
  var cfg = TileAPI.state.get('models.' + provider) || {};
  var modelSel = container.querySelector('#lsModel');
  var sizeSel = container.querySelector('#lsSize');
  if (modelSel) {
    modelSel.innerHTML = '';
    for (var mid in cfg) {
      var opt = document.createElement('option');
      opt.value = mid;
      opt.textContent = (cfg[mid] && cfg[mid].name) || mid;
      modelSel.appendChild(opt);
    }
    var saved = TileAPI.storage.get('lightSplitter.model');
    if (saved && cfg[saved]) modelSel.value = saved;
  }
  if (sizeSel && modelSel) {
    var mc = cfg[modelSel.value];
    sizeSel.innerHTML = '';
    if (mc && mc.sizes) {
      mc.sizes.forEach(function(s) {
        var opt = document.createElement('option');
        opt.value = s; opt.textContent = s;
        sizeSel.appendChild(opt);
      });
      var savedSize = TileAPI.storage.get('lightSplitter.size');
      if (savedSize && mc.sizes.indexOf(savedSize) !== -1) sizeSel.value = savedSize;
      else sizeSel.value = mc.default || mc.sizes[0] || '';
    }
  }
}

// ========== 事件绑定 ==========
function _bindEvents(container) {
  // 分析光源
  var analyzeBtn = container.querySelector('#lsAnalyzeBtn');
  if (analyzeBtn) analyzeBtn.addEventListener('click', function() { _doAnalyze(container); });

  // 勾选框
  var cbs = container.querySelectorAll('.ls-cb');
  for (var i = 0; i < cbs.length; i++) {
    cbs[i].addEventListener('change', function() {
      var idx = parseInt(this.dataset.idx, 10);
      if (_sources[idx]) _sources[idx].enabled = this.checked;
    });
  }

  // 编辑按钮
  var edits = container.querySelectorAll('.ls-edit');
  for (var j = 0; j < edits.length; j++) {
    edits[j].addEventListener('click', function() {
      var idx = parseInt(this.dataset.idx, 10);
      _editSource(container, idx);
    });
  }

  // 删除按钮
  var dels = container.querySelectorAll('.ls-del');
  for (var k = 0; k < dels.length; k++) {
    dels[k].addEventListener('click', function() {
      var idx = parseInt(this.dataset.idx, 10);
      _sources.splice(idx, 1);
      _rerender(container);
    });
  }

  // 手动添加
  var addBtn = container.querySelector('#lsAddBtn');
  if (addBtn) addBtn.addEventListener('click', function() {
    _sources.push({ type: '主光', direction: '', color: '', area: '', intensity: '中', description: '', enabled: true });
    _editSource(container, _sources.length - 1);
  });

  // 并发数
  var concSel = container.querySelector('#lsConcurrency');
  if (concSel) concSel.addEventListener('change', function() { _setConcurrency(this.value); });

  // Provider/Model 联动
  var providerSel = container.querySelector('#lsProvider');
  if (providerSel) providerSel.addEventListener('change', function() {
    TileAPI.storage.set('lightSplitter.provider', this.value);
    _populateModelSelect(container);
  });
  var modelSel = container.querySelector('#lsModel');
  if (modelSel) modelSel.addEventListener('change', function() {
    TileAPI.storage.set('lightSplitter.model', this.value);
    _populateModelSelect(container);
  });
  var sizeSel = container.querySelector('#lsSize');
  if (sizeSel) sizeSel.addEventListener('change', function() {
    TileAPI.storage.set('lightSplitter.size', this.value);
  });

  // 开始分离
  var startBtn = container.querySelector('#lsStartBtn');
  if (startBtn) startBtn.addEventListener('click', function() { _doStartSplit(container); });

  // 取消
  var cancelBtn = container.querySelector('#lsCancelBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', function() {
    _splitting = false;
    _lsQueue = [];   // 清空队列, 在途任务继续跑完(软中断, 同批次工场)
    TileAPI.toast('已取消后续任务, 进行中的任务将继续完成', 'info');
    _rerender(container);
  });
}

function _rerender(container) {
  if (!container) return;
  _renderLayout(container);
  _afterRender(container);
}

// ========== 编辑光源 ==========
function _editSource(container, idx) {
  var s = _sources[idx];
  if (!s) return;

  var types = ['主光', '补光', '轮廓光', '逆光', '顶光', '底光', '天光', '实际光源', '特效光'];
  var intensities = ['强', '中', '弱'];

  // 简易prompt编辑: 用浏览器prompt (UXP webview支持)
  var newType = prompt('光源类型', s.type);
  if (newType === null) return; // 取消
  if (types.indexOf(newType) === -1 && newType.trim()) {
    // 不在预设列表但用户填了,保留
  } else if (!newType.trim()) {
    newType = s.type;
  }
  s.type = newType;

  var newDir = prompt('照射方向', s.direction);
  if (newDir !== null) s.direction = newDir;

  var newColor = prompt('实际颜色(从画面取色)', s.color);
  if (newColor !== null) s.color = newColor;

  var newArea = prompt('照射区域', s.area);
  if (newArea !== null) s.area = newArea;

  var newIntensity = prompt('强度(强/中/弱)', s.intensity);
  if (newIntensity !== null && intensities.indexOf(newIntensity) !== -1) s.intensity = newIntensity;

  var newDesc = prompt('描述(辅助定位)', s.description);
  if (newDesc !== null) s.description = newDesc;

  _rerender(container);
}

// ========== LLM分析 ==========
function _doAnalyze(container) {
  if (_analyzing) { TileAPI.toast('正在分析中, 请稍候', 'info'); return; }

  var chatUrl = TileAPI.storage.get('chat.url') || '';
  var chatKey = TileAPI.storage.get('chat.key') || '';
  var chatModel = TileAPI.storage.get('chat.model') || '';
  if (!chatKey || !chatUrl || !chatModel) {
    TileAPI.toast('需要 AI 助手的语言模型, 请先到「AI 助手」磁贴设置里配置 URL/Key/模型', 'error');
    return;
  }

  _analyzing = true;
  var btn = container.querySelector('#lsAnalyzeBtn');
  if (btn) { btn.textContent = '分析中...'; btn.disabled = true; }
  _renderLayout(container);
  _afterRender(container);

  TileAPI.sendToHost('lightSplitAnalyze', {
    chatUrl: chatUrl, chatKey: chatKey, chatModel: chatModel
  });
}

function _onAnalyzeResult(data) {
  _analyzing = false;
  if (!data || !data.success) {
    TileAPI.toast('光源分析失败: ' + ((data && data.error) || '未知错误'), 'error');
    if (_activeContainer) _rerender(_activeContainer);
    return;
  }
  _sources = data.sources || [];
  TileAPI.toast('识别到 ' + _sources.length + ' 束光源', 'success');
  if (_activeContainer) _rerender(_activeContainer);
}

// ========== 批量分离 ==========
function _doStartSplit(container) {
  if (_splitting) return;

  var enabled = _sources.filter(function(s) { return s.enabled; });
  if (enabled.length === 0) { TileAPI.toast('没有勾选要分离的光源', 'error'); return; }

  var provider = (container.querySelector('#lsProvider') || {}).value || TileAPI.state.get('params.provider') || 'aji';
  var conn = window._settingsGetActiveConnection ? window._settingsGetActiveConnection(provider) : { provider: provider, url: '', key: '' };
  if (!conn || !conn.key) {
    TileAPI.toast('当前渠道未配置 API Key', 'error');
    return;
  }
  if (!conn.url) {
    TileAPI.toast('当前渠道未配置 API 地址', 'error');
    return;
  }

  var model = (container.querySelector('#lsModel') || {}).value || '';
  var size = (container.querySelector('#lsSize') || {}).value || '2K';
  var concurrency = _getConcurrency();

  _splitting = true;
  _sharedCapture = null;   // 每次开始分离重新抓 (选区可能变了)
  _firstTaskId = null;
  _splitProgress = { done: 0, total: enabled.length, results: [] };
  for (var i = 0; i < enabled.length; i++) {
    _splitProgress.results.push({ label: enabled[i].type + '·' + enabled[i].direction, status: 'pending', error: null });
  }
  _rerender(container);

  // 读取光照分离提示词模板
  var tpl = window._lightSplitterPrompt || '';
  if (!tpl) {
    TileAPI.toast('提示词数据未加载', 'error');
    _splitting = false;
    _rerender(container);
    return;
  }

  // 构建每个光源的prompt: 填入【填空:目标光源=...】
  var tasks = [];
  for (var j = 0; j < enabled.length; j++) {
    var src = enabled[j];
    var lightDesc = src.type;
    if (src.direction) lightDesc += '(' + src.direction;
    if (src.color) lightDesc += ', ' + src.color;
    if (src.direction || src.color) lightDesc += ')';
    if (src.description) lightDesc += ' ' + src.description;

    var prompt = tpl.replace(/【填空:目标光源=[^】]*】/g, '【填空:目标光源=' + lightDesc + '】');
    tasks.push({ prompt: prompt, label: src.type + '·' + src.direction, idx: j });
  }

  // 滑动窗口并发池: 队列+在途计数, 完成一个补一个, 严格尊重并发数
  _lsQueue = tasks.slice();
  _lsInflight = 0;
  _lsApiParams = {
    apiKey: conn.key, apiBaseUrl: conn.url, provider: conn.provider || provider,
    model: model, size: size, timeout: 3600, aspectRatio: 'Auto'
  };
  _lsConcurrency = concurrency;
  _pumpQueue();
}

// ========== 滑动窗口调度 ==========
var _lsQueue = [];
var _lsInflight = 0;
var _lsApiParams = null;
var _lsConcurrency = 2;

// 从队列取任务填满并发槽。首个任务(无_sharedCapture时)单独跑: 它负责抓选区,
// 拿到previewImage回传后其余任务才放行(reuseCapture复用, 防止抓选区互抢/deselect竞争)。
function _pumpQueue() {
  if (!_splitting) return;
  while (_lsQueue.length > 0 && _lsInflight < _lsConcurrency) {
    // 还没有共享capture: 只放行1个(抓选区的先锋), 其余等previewImage回传后再pump
    if (!_sharedCapture && _lsInflight >= 1) return;
    var task = _lsQueue.shift();
    _lsInflight++;
    _submitOne(task, !_sharedCapture);
  }
}

function _submitOne(task, isCaptureLeader) {
  _splitProgress.results[task.idx].status = 'running';

  var taskId = 'litsplit_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  _taskIdToIdx[taskId] = task.idx;
  _taskIdToLabel[taskId] = task.label;

  var apiParams = _lsApiParams;
  var payload = {
    taskId: taskId, engine: 'api', batchSize: 1, timeout: apiParams.timeout,
    apiKey: apiParams.apiKey, apiBaseUrl: apiParams.apiBaseUrl,
    prompt: task.prompt, size: apiParams.size, model: apiParams.model, provider: apiParams.provider,
    aspectRatio: apiParams.aspectRatio, antiMode: 0, layerType: 'smartObject',
    refImages: [], autoReturn: true,
    presetTitle: '拆光 · ' + task.label,
    autoColormatch: false
  };
  if (isCaptureLeader) {
    _firstTaskId = taskId;   // previewImage按这个taskId回填_sharedCapture → 回填后pump放行其余
  } else if (_sharedCapture) {
    payload.reuseCapture = { base64: _sharedCapture.base64, selection: _sharedCapture.selection, docId: _sharedCapture.docId };
  }

  TileAPI.sendToHost('runSingle', payload);

  // 写入共享任务状态 (同 tile-run._doRunSingle)
  var running = TileAPI.state.get('tasks.running') || {};
  running[taskId] = {
    engine: 'banana', provider: apiParams.provider,
    batchSize: 1, startTime: Date.now(), success: 0, fail: 0, total: 0, model: apiParams.model,
    size: apiParams.size,
    presetTitle: '拆光 · ' + task.label,
    promptSnippet: '拆光 · ' + task.label,
    thumbnail: _sharedCapture ? ('data:image/png;base64,' + _sharedCapture.base64) : null,
    docId: _sharedCapture ? _sharedCapture.docId : null,
    selection: _sharedCapture ? _sharedCapture.selection : null
  };
  TileAPI.state.set('tasks.running', running);
  var meta = TileAPI.state.get('tasks.meta') || {};
  meta[taskId] = { countdown: apiParams.timeout, timeoutSec: apiParams.timeout, autoReturn: true, batchSize: 1 };
  TileAPI.state.set('tasks.meta', meta);
  TileAPI.emit('tasks:updated');
  TileAPI.emit('task:started', { taskId: taskId, timeoutSec: apiParams.timeout, batchSize: 1 });
  TileAPI.emit('generate:started', { taskId: taskId, engine: 'banana', model: apiParams.model, batch: 1 });
  if (_activeContainer) _rerender(_activeContainer);
}

// previewImage: 抓选区先锋回传capture → 存共享 → 放行队列里等着的任务
function _onPreviewImage(data) {
  if (!data || !data.taskId || data.taskId !== _firstTaskId) return;
  if (!data.base64 || !data.selection || data.docId == null) return;
  _sharedCapture = { base64: data.base64, selection: data.selection, docId: data.docId };
  _pumpQueue();   // capture就位, 立即填满剩余并发槽
}

// generate:complete 结算 (tasks-service 处理完 taskComplete 回执后发出; 按 taskId 过滤本磁贴任务)
function _onGenComplete(data) {
  if (!data || !data.taskId) return;
  var idx = _taskIdToIdx[data.taskId];
  if (idx === undefined) return;   // 不是拆光的任务
  delete _taskIdToIdx[data.taskId];

  var ok = (data.success || data.generatedSuccess || 0) > 0;
  if (_splitProgress.results[idx]) {
    _splitProgress.results[idx].status = ok ? 'success' : 'fail';
    if (!ok) _splitProgress.results[idx].error = '生成失败';
  }
  _splitProgress.done++;
  _lsInflight = Math.max(0, _lsInflight - 1);

  if (_activeContainer) _rerender(_activeContainer);

  if (_splitProgress.done >= _splitProgress.total) {
    _splitting = false;
    var successCount = _splitProgress.results.filter(function(r) { return r.status === 'success'; }).length;
    TileAPI.toast('分离完成: ' + successCount + '/' + _splitProgress.total + ' 成功', successCount > 0 ? 'success' : 'error');
    if (_activeContainer) _rerender(_activeContainer);
    return;
  }

  // 补位: 空出一个并发槽, 从队列取下一个
  _pumpQueue();
}

// attach-layers: 贴回完成, 拿到图层ID → 让host做后处理(设screen混合模式+重命名+设不可见)
function _onConversationEvent(data) {
  if (!data || data.type !== 'attach-layers' || !data.taskId) return;
  var label = _taskIdToLabel[data.taskId];
  if (label === undefined) return;   // 不是拆光的任务
  if (!data.layerIDs || !data.layerIDs.length) return;
  TileAPI.sendToHost('lightSplitPostProcess', {
    docId: data.docId, layerIDs: data.layerIDs, layerName: label
  });
}

// ========== Tile Registration ==========
TileAPI.registerTile({
  id: 'lightSplitter',
  group: 'main',
  icon: '🔦',
  label: '自动拆光',
  desc: '分析/分离光源通道',
  live: false,
  defaultSize: { w: 1, h: 2 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 2, h: 8 },

  onExpand: function(container, sizeHint) {
    _activeContainer = container;
    _renderLayout(container);
    _afterRender(container);
    return function() { _activeContainer = null; };
  },

  onMessage: function(action, data) {
    if (action === 'lightSplitAnalyzeResult') { _onAnalyzeResult(data); return; }
  }
});

// 模块级常驻监听 (面板关闭后完成的任务也要结算, 同 tile-hemisynth #14)
TileAPI.on('generate:complete', _onGenComplete);
// attach-layers 是 host 消息(conversationEvent), 不是 TileAPI 事件 → 用 onHostMessage
TileAPI.onHostMessage('conversationEvent', _onConversationEvent);
// previewImage: 首个任务的选区抓取结果 → 共享给后续任务reuseCapture
TileAPI.onHostMessage('previewImage', _onPreviewImage);

})();
