(function() {
'use strict';

function _generateTaskId() {
  return 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

function _countRunning() { return Object.keys(TileAPI.state.get('tasks.running') || {}).length; }
function _countPending() { return Object.keys(TileAPI.state.get('tasks.pending') || {}).length; }

// 当前提示词磁贴载入的预设类型 (空 / 'banana' / 'forge')
function _currentEngine() {
  var kind = TileAPI.state.get('prompt.lastPresetKind') || '';
  if (kind === 'forge') return 'forge';
  return 'banana';  // 默认 / banana 预设都走 banana 流
}

function renderFront(container, w, h) {
  var running = _countRunning();
  var eng = _currentEngine();
  var icon = eng === 'forge' ? '🎨' : '▶️';
  var label = eng === 'forge' ? 'Forge 生成' : '开始生成';
  if (running > 0) {
    container.innerHTML = '<div class="tile-icon">⏳</div><div class="tile-label">生成中 ' + running + '</div>';
  } else if (w >= 2) {
    container.innerHTML = '<div class="tile-icon">' + icon + '</div><div class="tile-label">' + label + '</div><div class="tile-desc">点击展开</div>';
  } else {
    container.innerHTML = '<div class="tile-icon">' + icon + '</div><div class="tile-label">' + (eng === 'forge' ? 'Forge' : '生成') + '</div>';
  }
}

TileAPI.registerTile({
  id: 'run',
  group: 'main',
  icon: '▶️',
  label: '生成',
  desc: '开始AI修图',
  live: true,
  defaultSize: { w: 2, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderFront: renderFront,

  renderBack: function(container) {
    var n = _countRunning();
    if (n > 0) container.textContent = n + ' 个任务运行中';
    else container.textContent = '点击开始生成';
  },

  onExpand: function(container, sizeHint) {
    var layout = (sizeHint && sizeHint.layout) || 'wide';
    _renderRunPanel(container, layout);

    // 监听任务状态变化，刷新磁贴正面
    var sub = function() {
      var el = TileEngine.getTileElement('run');
      if (el) {
        var inner = el.querySelector('.tile-inner') || el.querySelector('.tile-flip-front');
        if (inner) renderFront(inner, +el.dataset.w || 2, +el.dataset.h || 1);
      }
    };
    // 预设类型切换时刷新展开面板按钮文字 + 正面
    var subPreset = function() {
      sub();
      _updateStartBtnLabel(container);
    };
    TileAPI.on('tasks:updated', sub);
    TileAPI.on('preset:loaded', subPreset);
    // preset:unloaded 监听已删 (该事件从未被 emit, 监听永远不触发)
    return function() {
      TileAPI.off('tasks:updated', sub);
      TileAPI.off('preset:loaded', subPreset);
    };
  },

  onResize: renderFront,
});

// === 布局渲染 ===

function _renderRunPanel(container, layout) {
  if (layout === 'narrow' || layout === 'tall') {
    // 极窄:测量容器宽高决定横排还是竖排,保证 3 按钮一定显示全
    var w = container.clientWidth || 60;
    var h = container.clientHeight || 60;
    var horiz = w >= h;   // 宽>=高走横排,否则竖排
    container.innerHTML =
      '<div class="w10-panel">' +
        '<div class="' + (horiz ? 'run-btns-row run-btns-tiny' : 'run-stack-narrow') + '">' +
          '<button class="w10-btn w10-btn-accent run-btn-big" id="runStartBtn" title="开始生成">▶</button>' +
          '<button class="w10-btn run-btn-big" id="runBatchBtn" title="加入批处理">+</button>' +
          '<button class="w10-btn run-btn-big" id="runRefBtn" title="添加为参考图">🖼️</button>' +
        '</div>' +
      '</div>';
  } else if (layout === 'square' || layout === 'wideshort') {
    // 紧凑/横长:三按钮横排
    container.innerHTML =
      '<div class="w10-panel">' +
        '<div class="run-btns-row">' +
          '<button class="w10-btn w10-btn-accent run-btn-main" id="runStartBtn">▶ 开始</button>' +
          '<button class="w10-btn run-btn-main" id="runBatchBtn">+ 批处理</button>' +
          '<button class="w10-btn run-btn-main" id="runRefBtn">🖼️ 参考图</button>' +
        '</div>' +
      '</div>';
  } else {
    // 宽:完整布局带说明
    container.innerHTML =
      '<div class="w10-panel">' +
        '<div class="w10-section-title">生成控制</div>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">开始生成</div><div class="w10-row-desc">使用当前提示词和参数立即开始 AI 修图</div></div>' +
          '<div class="w10-row-right"><button class="w10-btn w10-btn-accent" id="runStartBtn" style="padding:8px 24px;font-size:12px;">▶ 开始</button></div>' +
        '</div>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">加入批处理</div><div class="w10-row-desc">把当前选区+参数加入批处理队列,稍后统一运行</div></div>' +
          '<div class="w10-row-right"><button class="w10-btn" id="runBatchBtn" style="padding:8px 24px;font-size:12px;">+ 加入队列</button></div>' +
        '</div>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">添加为参考图</div><div class="w10-row-desc">把当前选区截图作为参考图(最多 4 张)</div></div>' +
          '<div class="w10-row-right"><button class="w10-btn" id="runRefBtn" style="padding:8px 24px;font-size:12px;">🖼️ 添加参考图</button></div>' +
        '</div>' +
      '</div>';
  }

  var startBtn = container.querySelector('#runStartBtn');
  if (startBtn) startBtn.addEventListener('click', _startGenerate);
  var batchBtn = container.querySelector('#runBatchBtn');
  if (batchBtn) batchBtn.addEventListener('click', _addToBatch);
  var refBtn = container.querySelector('#runRefBtn');
  if (refBtn) refBtn.addEventListener('click', _addAsRefImage);

  _updateStartBtnLabel(container);
}

// 按当前引擎刷新开始按钮文字
function _updateStartBtnLabel(container) {
  var btn = container.querySelector('#runStartBtn');
  if (!btn) return;
  var eng = _currentEngine();
  // 根据按钮原来的样式尺寸判断是 tiny 还是正常
  var isTiny = btn.classList.contains('run-btn-big');
  var isMain = btn.classList.contains('run-btn-main');
  if (isTiny) {
    btn.textContent = eng === 'forge' ? '🎨' : '▶';
    btn.title = eng === 'forge' ? 'Forge 生成' : '开始生成';
  } else if (isMain) {
    btn.textContent = eng === 'forge' ? '🎨 Forge' : '▶ 开始';
  } else {
    btn.textContent = eng === 'forge' ? '🎨 Forge 生成' : '▶ 开始';
  }
}

function _addToBatch() {
  // 以 textarea 当前 DOM value 为唯一真相, 跟 _startBananaGenerate 一致
  var taElB = document.getElementById('promptTextarea');
  if (taElB) {
    var domValB = taElB.value;
    var stateValB = TileAPI.state.get('prompt.text');
    if (domValB !== stateValB) {
      TileAPI.state.set('prompt.text', domValB);
      TileAPI.storage.set('prompt.lastText', domValB);
    }
  }
  var prompt = TileAPI.state.get('prompt.text');
  if (!prompt || !prompt.trim()) {
    TileAPI.toast('请先输入提示词', 'error');
    return;
  }
  var model = TileAPI.state.get('params.model') || 'AJbanana3';
  var size = TileAPI.state.get('params.size') || '2K';
  var batch = TileAPI.state.get('params.batch') || 1;
  var timeout = TileAPI.state.get('params.timeout') || 3600;
  var antiMode = TileAPI.state.get('params.antiMode') || 0;
  var refImages = TileAPI.state.get('refimages.list') || [];
  var refSelections = TileAPI.state.get('refimages.listSelections') || [];
  var layerType = TileAPI.storage.get('output.layerType') || 'smartObject';
  TileAPI.sendToHost('addToBatch', {
    prompt: prompt, size: size, model: model,
    aspectRatio: TileAPI.state.get('params.aspectRatio') || '1:1',
    batchSize: batch, timeout: timeout, antiMode: antiMode, layerType: layerType,
    refImages: refImages,
    refSelections: refSelections,
  });
  TileAPI.toast('正在加入批处理...', 'info');
}

function _addAsRefImage() {
  TileAPI.sendToHost('captureRefImage');
  TileAPI.toast('正在捕获参考图...', 'info');
}

function _startGenerate(runContext) {
  var eng = _currentEngine();
  if (eng === 'forge') { _startForgeGenerate(); return; }
  _startBananaGenerate(runContext || {});
}

function _startBananaGenerate(runContext) {
  runContext = runContext || {};
  // 以 prompt 磁贴里 textarea 的当前 DOM value 为唯一真相 (如果它存在于视图)
  // 防止 state.prompt.text 因为某些异常路径残留旧值, 而 textarea 实际是空的
  // 用户的真实意图永远以他眼睛看到的为准
  var taEl = document.getElementById('promptTextarea');
  if (taEl) {
    var domVal = taEl.value;
    var stateVal = TileAPI.state.get('prompt.text');
    if (domVal !== stateVal) {
      // 视图与 state 脱节, 强制以 DOM 为准 (这本身就是 bug 的兜底)
      console.warn('[run] prompt.text 与 textarea 不同步, 以 textarea 为准. dom=' + JSON.stringify(domVal.slice(0,50)) + ' state=' + JSON.stringify((stateVal||'').slice(0,50)));
      TileAPI.state.set('prompt.text', domVal);
      TileAPI.storage.set('prompt.lastText', domVal);
    }
  }
  var prompt = TileAPI.state.get('prompt.text');
  if (!prompt || !prompt.trim()) {
    TileAPI.toast('请先输入提示词', 'error');
    return;
  }

  var conn = window._settingsGetActiveConnection ? window._settingsGetActiveConnection() : { provider: 'aji', url: '', key: '' };
  if (!conn.key) {
    if (conn._grsKeyPending) TileAPI.toast('正在准备夏算力, 请稍后再试', 'info');
    else if (conn._grsNeedLogin) TileAPI.toast('夏算力托管需要登录 (顶栏账号区), 或切回「自带 Key」', 'error');
    else TileAPI.toast('请先在设置中配置 ' + conn.provider.toUpperCase() + ' API Key', 'error');
    return;
  }
  if (!conn.url) { TileAPI.toast('请先在设置中配置 ' + conn.provider.toUpperCase() + ' URL', 'error'); return; }

  var model = TileAPI.state.get('params.model') || 'AJbanana3';
  var size = TileAPI.state.get('params.size') || '2K';
  var batch = TileAPI.state.get('params.batch') || 1;
  var timeout = TileAPI.state.get('params.timeout') || 3600;
  var antiMode = TileAPI.state.get('params.antiMode') || 0;
  var refImages = TileAPI.state.get('refimages.list') || [];
  var layerType = TileAPI.storage.get('output.layerType') || 'smartObject';
  var autoReturn = TileAPI.storage.get('output.autoReturn');
  if (autoReturn === null || autoReturn === undefined) autoReturn = true;
  var aspectRatio = TileAPI.state.get('params.aspectRatio') || '1:1';

  // === 比例预警: 选区比例和生图比例对不上, 出来的图会被 AI 拉伸变形 ===
  if (window.AspectWarn) {
    window.AspectWarn.probeSelection().then(function(probe) {
      if (!probe || !probe.hasSelection) {
        // 没选区: 走"全图"路径, 此时按文档比例对比
        var docW = probe && probe.docWidth, docH = probe && probe.docHeight;
        if (docW && docH) {
          var verdictD = window.AspectWarn.checkSelVsAspect(docW, docH, aspectRatio);
          if (verdictD === 'mismatch') {
            window.AspectWarn.confirmBeforeGenerate({
              selW: docW, selH: docH, aspect: aspectRatio, kind: 'gen'
            }).then(function(yes) { if (yes) _doRunSingle(); });
            return;
          }
        }
        _doRunSingle();
        return;
      }
      var verdict = window.AspectWarn.checkSelVsAspect(probe.selWidth, probe.selHeight, aspectRatio);
      if (verdict === 'mismatch') {
        window.AspectWarn.confirmBeforeGenerate({
          selW: probe.selWidth, selH: probe.selHeight, aspect: aspectRatio, kind: 'gen'
        }).then(function(yes) { if (yes) _doRunSingle(); });
      } else {
        _doRunSingle();
      }
    });
  } else {
    _doRunSingle();
  }

  // 真·提交 (闭包捕获上面准备好的所有变量)
  function _doRunSingle() {
    var taskId = runContext.taskId != null ? String(runContext.taskId) : _generateTaskId();
    var presetTitle = TileAPI.state.get('prompt.lastPresetTitle') || '';
    TileAPI.sendToHost('runSingle', {
      taskId: taskId, engine: 'api', batchSize: batch, timeout: timeout,
      apiKey: conn.key, apiBaseUrl: conn.url,
      prompt: prompt, size: size, model: model, provider: conn.provider,
      aspectRatio: aspectRatio, antiMode: antiMode, layerType: layerType,
      refImages: refImages, autoReturn: autoReturn,
      presetTitle: presetTitle,
      autoColormatch: false,   // v6.6.0: 自动校色停用(设置开关已删)
      automationRequest: runContext.source === 'automation',
      automationAuthorizationId: runContext.automationAuthorizationId || null,
      automationDocId: runContext.automationDocId != null ? runContext.automationDocId : null,
      automationContinueNextRegion: runContext.continueNextRegion === true,
    });

    if (!autoReturn) {
      TileAPI.sendToHost('setTaskAutoReturn', { taskId: taskId, autoReturn: false });
    }

    // 写入共享任务状态
    var running = TileAPI.state.get('tasks.running') || {};
    var promptSnippet = (prompt || '').replace(/\s+/g, ' ').trim().substring(0, 30);
    running[taskId] = {
      engine: 'banana',
      provider: conn.provider,
      batchSize: batch, startTime: Date.now(), success: 0, fail: 0, total: 0, model: model,
      size: size,
      presetTitle: presetTitle,
      promptSnippet: promptSnippet,
      thumbnail: null,
      docId: null,
      selection: null,
    };
    TileAPI.state.set('tasks.running', running);

    var meta = TileAPI.state.get('tasks.meta') || {};
    meta[taskId] = {
      countdown: timeout,
      timeoutSec: timeout,
      autoReturn: (TileAPI.storage.get('output.autoReturn') !== false),
      batchSize: batch
    };
    TileAPI.state.set('tasks.meta', meta);

    TileAPI.emit('tasks:updated');
    TileAPI.emit('task:started', { taskId: taskId, timeoutSec: timeout, batchSize: batch });
    TileAPI.emit('generate:started', { taskId: taskId, engine: 'banana', model: model, batch: batch });
    // F: 记录本次单图快照, 供 Dock「一键重跑」复用。
    //   提示词原样记下; 选区+截图不在这里存(前端拿不到), 等 host 抓完经 previewImage 回传(下方监听按 taskId 回填 capture)。
    //   重跑只复用 prompt + capture(上次的选区/图), 其余参数一律读"当前"面板值。
    _lastSingle = { prompt: prompt, presetTitle: presetTitle, taskId: taskId, capture: null };
    TileAPI.toast('生成任务已提交', 'success');
  }
}

// F: 上一次单图快照 + 一键重跑
var _lastSingle = null;
var _lastRepeatAt = 0;   // 🔁 连点冷却时间戳
function _repeatLastSingle() {
  // 连点 1 秒冷却: 上一发还没提交完就先别重复, 避免一串重复任务、重复扣额度
  var nowTs = Date.now();
  if (nowTs - _lastRepeatAt < 1000) return;
  _lastRepeatAt = nowTs;

  // 防贴错文档: 必须有上次的截图, 且 docId 非空(后端靠它定位原文档贴回; 空了会贴到当前文档上)
  if (!_lastSingle || !_lastSingle.capture || !_lastSingle.capture.base64 || _lastSingle.capture.docId == null) {
    TileAPI.toast('还没有可重跑的单图(或上次的选区图还没就绪)', 'info');
    return;
  }
  var cap = _lastSingle.capture;

  var conn = window._settingsGetActiveConnection ? window._settingsGetActiveConnection() : { provider: 'aji', url: '', key: '' };
  if (!conn.key) { TileAPI.toast('请先在设置中配置 API Key', 'error'); return; }
  if (!conn.url) { TileAPI.toast('请先在设置中配置 API URL', 'error'); return; }

  // 提示词 = 上次的; 其余参数一律读"当前"面板值
  var prompt = _lastSingle.prompt;
  if (!prompt || !prompt.trim()) { TileAPI.toast('上次的提示词为空, 无法重跑', 'error'); return; }
  var model = TileAPI.state.get('params.model') || 'AJbanana3';
  var size = TileAPI.state.get('params.size') || '2K';
  var batch = TileAPI.state.get('params.batch') || 1;
  var timeout = TileAPI.state.get('params.timeout') || 3600;
  var antiMode = TileAPI.state.get('params.antiMode') || 0;
  var refImages = TileAPI.state.get('refimages.list') || [];
  var layerType = TileAPI.storage.get('output.layerType') || 'smartObject';
  var autoReturn = TileAPI.storage.get('output.autoReturn');
  if (autoReturn === null || autoReturn === undefined) autoReturn = true;
  var aspectRatio = TileAPI.state.get('params.aspectRatio') || '1:1';

  // 比例预警: 重跑复用的是"上次那个框", 不能去探当前 PS 实时选区 —— 用快照里选区的宽高跟当前出图比例比
  var sel = cap.selection || {};
  if (window.AspectWarn && sel.width > 0 && sel.height > 0) {
    var verdict = window.AspectWarn.checkSelVsAspect(sel.width, sel.height, aspectRatio);
    if (verdict === 'mismatch') {
      window.AspectWarn.confirmBeforeGenerate({ selW: sel.width, selH: sel.height, aspect: aspectRatio, kind: 'gen' })
        .then(function(yes) { if (yes) _submitRepeat(); });
      return;
    }
  }
  _submitRepeat();

  // 真·提交(闭包捕获上面准备好的参数 + 上次的图)
  function _submitRepeat() {
    var taskId = _generateTaskId();
    _lastSingle.taskId = taskId;   // 让后续 previewImage / 任务卡片绑到这次重跑(capture 不动, 仍是同一张图)
    TileAPI.sendToHost('runSingle', {
      taskId: taskId, engine: 'api', batchSize: batch, timeout: timeout,
      apiKey: conn.key, apiBaseUrl: conn.url,
      prompt: prompt, size: size, model: model, provider: conn.provider,
      aspectRatio: aspectRatio, antiMode: antiMode, layerType: layerType,
      refImages: refImages, autoReturn: autoReturn,
      autoColormatch: false,   // v6.6.0: 自动校色停用(设置开关已删)
      // 🔁 把上次那张图+选区原样回传, 后端据此跳过实时抓取
      reuseCapture: { base64: cap.base64, selection: cap.selection, docId: cap.docId }
    });
    if (!autoReturn) TileAPI.sendToHost('setTaskAutoReturn', { taskId: taskId, autoReturn: false });

    var running = TileAPI.state.get('tasks.running') || {};
    running[taskId] = {
      engine: 'banana', provider: conn.provider, batchSize: batch, startTime: Date.now(),
      success: 0, fail: 0, total: 0, model: model,
      presetTitle: _lastSingle.presetTitle || '',
      promptSnippet: (prompt || '').replace(/\s+/g, ' ').trim().substring(0, 30),
      // 图是现成的, 直接挂缩略图/选区, 不用等后端 previewImage
      thumbnail: 'data:image/png;base64,' + cap.base64, docId: cap.docId, selection: cap.selection
    };
    TileAPI.state.set('tasks.running', running);
    var meta = TileAPI.state.get('tasks.meta') || {};
    meta[taskId] = { countdown: timeout, timeoutSec: timeout, autoReturn: (TileAPI.storage.get('output.autoReturn') !== false), batchSize: batch };
    TileAPI.state.set('tasks.meta', meta);
    TileAPI.emit('tasks:updated');
    TileAPI.emit('task:started', { taskId: taskId, timeoutSec: timeout, batchSize: batch });
    TileAPI.emit('generate:started', { taskId: taskId, engine: 'banana', model: model, batch: batch });
    TileAPI.toast('已重跑上一次单图(用当前参数)', 'success');
  }
}

function _startForgeGenerate() {
  if (!window._forgeStartGenerateViaRun) {
    TileAPI.toast('Forge 磁贴未加载,无法生成', 'error');
    return;
  }

  var taskId = _generateTaskId();
  var res = window._forgeStartGenerateViaRun({ taskId: taskId });
  if (!res || !res.ok) {
    TileAPI.toast((res && res.error) || 'Forge 启动失败', 'error');
    return;
  }

  var presetTitle = TileAPI.state.get('prompt.lastPresetTitle') || '';
  var prompt = TileAPI.state.get('prompt.text') || '';
  var promptSnippet = prompt.replace(/\s+/g, ' ').trim().substring(0, 30);

  var running = TileAPI.state.get('tasks.running') || {};
  running[taskId] = {
    engine: 'forge',
    batchSize: res.batchSize,
    resolution: res.resolution,
    width: res.width,
    height: res.height,
    startTime: Date.now(),
    success: 0, fail: 0, total: 0,
    model: res.model,         // forge 任务磁贴不显示,但存着方便调试
    presetTitle: presetTitle,
    promptSnippet: promptSnippet,
    thumbnail: null,
    docId: null,
    selection: null,
  };
  TileAPI.state.set('tasks.running', running);

  // Forge 无统一超时,写个大一点的 value 占位让 tile-tasks 的 ticker 不会立刻超时
  var meta = TileAPI.state.get('tasks.meta') || {};
  meta[taskId] = {
    countdown: 3600,
    timeoutSec: 3600,
    autoReturn: (TileAPI.storage.get('output.autoReturn') !== false),
    batchSize: res.batchSize,
    engine: 'forge'
  };
  TileAPI.state.set('tasks.meta', meta);

  TileAPI.emit('tasks:updated');
  TileAPI.emit('task:started', { taskId: taskId, timeoutSec: 3600, batchSize: res.batchSize });
  TileAPI.emit('generate:started', { taskId: taskId, engine: 'forge', model: res.model, batch: res.batchSize });
  TileAPI.toast('Forge 任务已提交', 'success');
}

// 给"开始"事件加一个视觉反馈: 任务磁贴整块描边发光闪一下,
// 让用户看到提示词那边按下的动作流到了任务磁贴 (任务列表是真正显示进度的地方)
function _flashTasksTile() {
  var el = document.querySelector('.tile[data-id="center"]');
  if (!el) return;
  el.classList.remove('tile-run-flash');
  void el.offsetWidth;
  el.classList.add('tile-run-flash');
  setTimeout(function() { el.classList.remove('tile-run-flash'); }, 450);
}

// 外部触发开始生成(目前用于参数面板的"开始计算"按钮)
TileAPI.on('run:start', function(runContext) { _flashTasksTile(); _startGenerate(runContext || {}); });
// Photoshop 快捷键/动作回放与面板按钮走同一个生成入口。
TileAPI.onHostMessage('psRunSingleCommand', function() { TileAPI.emit('run:start'); });
// 外部触发加入批次(给卫星插件用)
TileAPI.on('run:addToBatch', function() { _flashTasksTile(); _addToBatch(); });
// F: Dock「一键重跑」: 上次的选区+提示词, 配当前参数再跑一次
TileAPI.on('run:repeatLast', function() { _flashTasksTile(); _repeatLastSingle(); });

// F: host 抓完选区会回传预览图; 按 taskId 把"上次那张图+选区"回填进快照, 供「一键重跑」复用上次的选区。
//    模块级监听 — 不依赖 run 磁贴是否展开, 任何时候都能收到。
TileAPI.onHostMessage('previewImage', function(data) {
  if (!data || !data.base64 || !_lastSingle || data.taskId !== _lastSingle.taskId) return;
  _lastSingle.capture = {
    base64: data.base64,
    selection: data.selection || null,
    docId: (data.docId !== undefined ? data.docId : null)
  };
});

})();
