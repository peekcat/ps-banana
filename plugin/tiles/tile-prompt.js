(function() {
'use strict';

// 用户在参数模式顶栏点了"📝 原文"按钮的偏好(本会话内有效)
// 切换到原文 → true(强制 textarea)
// 切换回参数 / 切换预设 / 关闭面板 → false(回到自动判断)
var _forceTextView = false;
// 记住上一帧文本是否含参数: 用于判断"参数从无到有"(新的参数提示词)→ 解除强制原文
var _lastTextHadParams = false;

// ========== 背面概要 ==========
// 优先级:刚载入的预设名 > 注释章节/scene_type > JSON description/role > 纯文本截断
function _renderBackSummary(container) {
  var text = TileAPI.state.get('prompt.text') || '';
  if (!text) {
    container.innerHTML = '<div class="prompt-back-empty">未输入</div>';
    return;
  }

  var title = _extractSummaryTitle(text);
  var paramCount = _countParams(text);

  container.innerHTML =
    '<div class="prompt-back">' +
      '<div class="prompt-back-title">' + _escHtml(title) + '</div>' +
      (paramCount > 0
        ? '<div class="prompt-back-meta">🎚 ' + paramCount + ' 个参数</div>'
        : '<div class="prompt-back-meta">' + text.length + ' 字</div>') +
    '</div>';
}

function _extractSummaryTitle(text) {
  // 1. 最近载入的预设名(由 preset:loaded 事件存入)
  var presetTitle = TileAPI.state.get('prompt.lastPresetTitle');
  if (presetTitle) return '🎯 ' + presetTitle;

  // 2. 注释风格:第一行 // scene_type: / // system_role: / // 概要:... 之类
  var commentMatch = text.match(/^\s*\/\/\s*(?:scene_type|system_role|description|concept|概要|主题)\s*[:：]\s*(.{2,30})/im);
  if (commentMatch) return commentMatch[1].trim().replace(/[·•]/g, '·');

  // 3. JSON 风格:尝试解析,取 description 或 role
  if (text.charAt(0) === '{' || /"role"\s*:/.test(text.substring(0, 100))) {
    try {
      var obj = JSON.parse(text);
      if (obj.description) return '📝 ' + String(obj.description).substring(0, 24);
      if (obj.role) return '🎭 ' + String(obj.role).substring(0, 24);
    } catch(e) {}
    // 解析失败,字符串级匹配
    var descM = text.match(/"description"\s*:\s*"([^"]{2,30})"/);
    if (descM) return '📝 ' + descM[1];
    var roleM = text.match(/"role"\s*:\s*"([^"]{2,30})"/);
    if (roleM) return '🎭 ' + roleM[1];
  }

  // 4. 纯文本截断前 16 字
  return text.substring(0, 16).replace(/\s+/g, ' ').trim() + (text.length > 16 ? '…' : '');
}

function _countParams(text) {
  if (!text) return 0;
  var r = /"?@param:([^"\s:]+?)"\s*:\s*("[^"]*"|[-\d.]+)/g;
  var count = 0, m;
  while ((m = r.exec(text)) !== null) {
    var name = m[1];
    if (name.slice(-5) === '_desc' || name.slice(-6) === '_label') continue;
    count++;
  }
  return count;
}

function _refreshBack() {
  if (!window.TileEngine) return;
  var el = TileEngine.getTileElement('prompt');
  if (!el) return;
  var back = el.querySelector('.tile-flip-back');
  if (back) _renderBackSummary(back);
}


function renderFront(container, w, h) {
  var text = TileAPI.state.get('prompt.text') || '';
  if (w >= 2) {
    var charCount = text.length;
    container.innerHTML =
      '<div class="tile-icon">✏️</div>' +
      '<div class="tile-label">提示词</div>' +
      '<div class="tile-desc">' + (charCount > 0 ? charCount + '字' : '未输入') + '</div>';
  } else {
    container.innerHTML =
      '<div class="tile-icon">✏️</div>' +
      '<div class="tile-label">提示词</div>';
  }
}

TileAPI.registerTile({
  id: 'prompt',
  group: 'main',
  icon: '✏️',
  label: '提示词',
  desc: '输入修图指令',
  live: true,
  defaultSize: { w: 4, h: 2 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderFront: renderFront,

  renderBack: function(container) { _renderBackSummary(container); },

  onExpand: function(container, sizeHint) {
    try {
      var currentLayout = (sizeHint && sizeHint.layout) || 'wide';
      container.dataset.layout = currentLayout;
      _renderMode(container, TileAPI.state.get('prompt.text') || '');
      var unbindKeys = _bindGlobalEvents(container);
      return function() {
        if (typeof unbindKeys === 'function') unbindKeys();
      };
    } catch(err) {
      console.error('[tile-prompt] onExpand error:', err);
      container.innerHTML = '<div style="color:red;padding:12px;">错误: ' + err.message + '</div>';
    }
  },

  onResize: function(w, h) {
    var el = TileEngine.getTileElement('prompt');
    if (!el) return;
    var inner = el.querySelector('.tile-inner') || el.querySelector('.tile-flip-front');
    if (inner) renderFront(inner, w, h);
  },

  onStorageLoaded: function(storage) {
    var saved = storage.get('prompt.lastText');
    if (saved) TileAPI.state.set('prompt.text', saved);
    // v6.5.0: 预设名跟着落盘 — 修复重启后生成的缓存文件夹/生成记录只显示提示词内容不显示预设名
    var savedTitle = storage.get('prompt.lastPresetTitle');
    if (savedTitle) TileAPI.state.set('prompt.lastPresetTitle', savedTitle);
    var savedKind = storage.get('prompt.lastPresetKind');
    if (savedKind) TileAPI.state.set('prompt.lastPresetKind', savedKind);
  },

  onMessage: function(action, data) {
    if (action !== 'youdaoTranslateResult') return;
    if (!data || !data.translateId) return;
    var pending = _pendingTranslates[data.translateId];
    if (!pending) return;  // 不是我们的请求,忽略
    clearTimeout(pending.timer);
    delete _pendingTranslates[data.translateId];

    var target = pending.target;

    // 恢复按钮
    _restoreTranslateButtons();

    if (!data.success) {
      TileAPI.toast('翻译失败: ' + (data.error || '未知'), 'error');
      return;
    }
    var translated = (data.translated || data.text || '').trim();
    if (!translated) { TileAPI.toast('翻译结果为空', 'error'); return; }

    if (target === 'negative') {
      var curNeg = TileAPI.storage.get('forge.negativePrompt') || '';
      var nextNeg = curNeg ? (curNeg + ', ' + translated) : translated;
      TileAPI.storage.set('forge.negativePrompt', nextNeg);
      TileAPI.emit('forge:syncFromPrompt', { negativePrompt: nextNeg });
      var meta = TileAPI.state.get('prompt.lastPresetMeta') || {};
      meta.negativePrompt = nextNeg;
      TileAPI.state.set('prompt.lastPresetMeta', meta);
      TileAPI.toast('已追加到反向', 'success');
    } else {
      var curPos = TileAPI.storage.get('forge.positivePrompt') || '';
      var nextPos = curPos ? (curPos + ', ' + translated) : translated;
      TileAPI.storage.set('forge.positivePrompt', nextPos);
      TileAPI.state.set('prompt.text', nextPos);
      TileAPI.storage.set('prompt.lastText', nextPos);
      TileAPI.emit('forge:syncFromPrompt', { positivePrompt: nextPos });
      TileAPI.toast('已追加到正向', 'success');
    }

    // 清空输入框
    var container = _findPanelContainer();
    if (container) {
      var srcEl = container.querySelector('#ftrSrc');
      if (srcEl) srcEl.value = '';
    }
  },
});

// ========== 预设顶栏(显示当前载入的预设名/类型/简介) ==========
// opts.inParamsMode: 参数模式下,右侧 × 改为清空提示词(退出参数模式),而不是只解绑预设名
function _renderPresetHeadHTML(opts) {
  opts = opts || {};
  var title = TileAPI.state.get('prompt.lastPresetTitle') || '';
  var kind = TileAPI.state.get('prompt.lastPresetKind') || '';
  var meta = TileAPI.state.get('prompt.lastPresetMeta') || null;

  // 三种"强制渲染"场景:有预设 / 参数模式 / 输入框模式
  if (!title && !opts.inParamsMode && !opts.inTextareaMode) return '';

  var badge, tagClass, descHtml = '';
  if (opts.inTextareaMode && !title) {
    // 输入框模式 + 没有预设:展示通用"提示词"标识
    badge = '<span class="prompt-preset-badge prompt-preset-badge-params">✎</span>';
    tagClass = 'prompt-preset-head-params';
    title = '提示词';
  } else if (opts.inParamsMode && !title) {
    // 参数模式 + 没有预设来源:展示通用"参数调节"标识
    badge = '<span class="prompt-preset-badge prompt-preset-badge-params">🎚</span>';
    tagClass = 'prompt-preset-head-params';
    var paramCountGeneric = _countParams(TileAPI.state.get('prompt.text') || '');
    descHtml = paramCountGeneric > 0
      ? '<div class="prompt-preset-meta">' + paramCountGeneric + ' 个参数</div>'
      : '';
    title = '参数调节';
  } else if (kind === 'forge') {
    badge = '<span class="prompt-preset-badge prompt-preset-badge-forge" title="Forge预设">F</span>';
    tagClass = 'prompt-preset-head-forge';
    if (meta) {
      var bits = [];
      if (meta.model) bits.push(_shortModel(meta.model));
      if (meta.sampler) bits.push(meta.sampler);
      if (meta.steps) bits.push(meta.steps + '步');
      if (meta.denoise) bits.push('降噪' + meta.denoise);
      if (meta.resolution) bits.push(meta.resolution + 'px');
      if (meta.batch) bits.push(meta.batch + '张');
      if (bits.length) {
        descHtml = '<div class="prompt-preset-meta">' + _escHtml(bits.join(' · ')) + '</div>';
      }
    }
  } else {
    badge = '<span class="prompt-preset-badge prompt-preset-badge-banana" title="Banana预设">B</span>';
    tagClass = 'prompt-preset-head-banana';
    var paramCount = _countParams(TileAPI.state.get('prompt.text') || '');
    if (paramCount > 0) {
      descHtml = '<div class="prompt-preset-meta">🎚 ' + paramCount + ' 个参数</div>';
    }
  }

  // ▶ 开始计算: 只要顶栏能呈现就显示
  var runBtn = '<button class="prompt-preset-run" data-preset-action="run-params" title="使用当前参数开始计算">▶</button>';

  // 切换"原文 ↔ 参数"按钮 — 只在 textarea/params 模式下且文本有参数时显示
  // forge 模式不显示(forge 没有 @param 参数概念)
  var toggleBtn = '';
  if (kind !== 'forge') {
    var curText = TileAPI.state.get('prompt.text') || '';
    if (_hasParams(curText) || _hasFields(curText)) {
      if (opts.inParamsMode) {
        toggleBtn = '<button class="prompt-preset-toggle" data-preset-action="toggle-view" title="切到原文(可编辑/复制原始正则)">📝</button>';
      } else if (opts.inTextareaMode) {
        toggleBtn = '<button class="prompt-preset-toggle" data-preset-action="toggle-view" title="切到参数滑块">🎚</button>';
      }
    }
  }

  var rightBtn;
  if (opts.inTextareaMode && !TileAPI.state.get('prompt.lastPresetTitle')) {
    // 输入框模式无预设: × = 清空提示词文本
    rightBtn = toggleBtn + runBtn + '<button class="prompt-preset-unload" data-preset-action="clear-text" title="清空提示词">×</button>';
  } else if (opts.inParamsMode) {
    // 参数模式: × = 清空提示词回输入模式
    rightBtn = toggleBtn + runBtn + '<button class="prompt-preset-unload" data-preset-action="clear-params" title="清空并回到输入框">×</button>';
  } else {
    // 其他模式(有预设): × = 解除预设绑定 + 清空提示词
    rightBtn = toggleBtn + runBtn + '<button class="prompt-preset-unload" data-preset-action="unbind" title="解除预设绑定并清空">×</button>';
  }

  return '<div class="prompt-preset-head ' + tagClass + '">' +
    badge +
    '<div class="prompt-preset-info">' +
      '<div class="prompt-preset-title">' + _escHtml(title) + '</div>' +
      descHtml +
    '</div>' +
    rightBtn +
  '</div>';
}

function _shortModel(m) {
  // "majicmixRealistic_v4.safetensors [f954946633]" -> "majicmixRealistic_v4"
  if (!m) return '';
  return String(m).split('.')[0].split(' ')[0];
}

function _refreshPresetHead(container) {
  if (!container) return;
  var panel = container.querySelector('.w10-panel');
  if (!panel) return;
  var inParams = panel.classList.contains('params-mode');
  var inTextarea = panel.classList.contains('prompt-ta-panel');
  var existing = panel.querySelector('.prompt-preset-head');
  var html = _renderPresetHeadHTML({ inParamsMode: inParams, inTextareaMode: inTextarea });
  if (!html) {
    if (existing) existing.remove();
    return;
  }
  if (existing) {
    existing.outerHTML = html;
  } else {
    panel.insertAdjacentHTML('afterbegin', html);
  }
  _bindPresetHeadActions(container);
}

function _bindPresetHeadActions(container) {
  var btn = container.querySelector('.prompt-preset-unload');
  if (btn) {
    var action = btn.getAttribute('data-preset-action');
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (action === 'clear-params') {
        _clearToTextareaMode(container);
      } else if (action === 'clear-text') {
        // 输入框模式无预设: 清 textarea 文本(保留模式,不切视图)
        TileAPI.state.set('prompt.text', '');
        TileAPI.storage.set('prompt.lastText', '');
        var ta = container.querySelector('#promptTextarea');
        if (ta) ta.value = '';
        _refreshFront();
        _refreshBack();
      } else {
        // unbind: 解绑预设并彻底清空当前提示词
        // 之前的设计是"保留文本只切视图",但用户反馈需要按两次才能清干净
        // 现在统一一次到位:清标记 + 清 prompt.text + (Forge 时也清 forge.positivePrompt)
        var isForge = TileAPI.state.get('prompt.lastPresetKind') === 'forge';
        TileAPI.state.set('prompt.lastPresetTitle', ''); TileAPI.storage.set('prompt.lastPresetTitle', '');
        TileAPI.state.set('prompt.lastPresetKind', ''); TileAPI.storage.set('prompt.lastPresetKind', '');
        TileAPI.state.set('prompt.lastPresetId', '');
        TileAPI.state.set('prompt.lastPresetMeta', null);
        TileAPI.state.set('prompt.text', '');
        TileAPI.storage.set('prompt.lastText', '');
        if (isForge) {
          TileAPI.storage.set('forge.positivePrompt', '');
        }
        _renderMode(container, '');
        _refreshFront();
        _refreshBack();
      }
    });
  }

  // ▶ 开始计算 (仅参数模式渲染,使用 tile-run 的统一入口)
  var runBtn = container.querySelector('.prompt-preset-run');
  if (runBtn) {
    runBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      // 视觉反馈: 按钮脉冲动画 + toast, 让用户确认点到了
      runBtn.classList.remove('is-firing');
      // reflow 强制重启动画 (连点也能每次都触发)
      void runBtn.offsetWidth;
      runBtn.classList.add('is-firing');
      setTimeout(function() { runBtn.classList.remove('is-firing'); }, 280);
      // 不在这里 toast "已开始生成" — 真正提交在 run:start → AspectWarn 确认之后
      // 若比例不匹配会先弹确认框, 提交成功后 tile-run 会 toast「生成任务已提交」
      TileAPI.emit('run:start');
    });
  }

  // 📝/🎚 切换"原文 ↔ 参数"
  var toggleBtn = container.querySelector('.prompt-preset-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      _forceTextView = !_forceTextView;
      _renderMode(container, TileAPI.state.get('prompt.text') || '');
    });
  }
}

// ========== 根据文本有无 @param 决定模式 ==========
function _hasParams(text) {
  if (!text) return false;
  // 必须用 /g,否则 exec 总从 0 开始,含 _desc/_label 的文本会死循环
  var r = /"?@param:([^"\s:]+?)"\s*:\s*("[^"]*"|[-\d.]+)/g;
  var m;
  while ((m = r.exec(text)) !== null) {
    if (m[1].slice(-5) !== '_desc' && m[1].slice(-6) !== '_label') return true;
  }
  return false;
}

// 文本里有没有填空字段 【填空:名=默认】
function _hasFields(text) {
  if (!text) return false;
  return /【填空:[^=】]+?(?:=[^】]*)?】/.test(text);
}

function _renderMode(container, text) {
  var layout = container.dataset.layout || 'wide';
  var kind = TileAPI.state.get('prompt.lastPresetKind') || '';

  // Forge 预设:显示 forge 参数面板(张数/重绘/步数/分辨率等),不显示正向提示词
  if (kind === 'forge') {
    _renderForgeParamsMode(container, layout);
    return;
  }

  var asParams = _hasParams(text) || _hasFields(text);

  // 用户在顶栏点了"切到原文"按钮 → 即便有参数也强制显示 textarea
  // 该偏好仅本次会话有效,刷新提示词或重启后回到自动判断
  if (asParams && _forceTextView) {
    asParams = false;
  }

  if (asParams) {
    // 参数模式:全是滑块,隐藏 textarea
    _renderParamsOnly(container, text);
  } else {
    // 输入模式:显示 textarea
    _renderTextareaMode(container, text, layout);
  }
}

// ========== Forge 参数模式 ==========
// 选中 forgeUI 预设时:textarea 区域改为显示 forge 参数控件
// 只暴露 3 个核心参数(张数 / 分辨率 / 重绘幅度) + 翻译输入框 + 两个追加按钮
function _renderForgeParamsMode(container, layout) {
  var batch = +(TileAPI.storage.get('forge.batchSize') || 1);
  var denoise = parseFloat(TileAPI.storage.get('forge.denoise') || 0.75);
  var res = +(TileAPI.storage.get('forge.resolution') || 768);

  var rows = [
    _forgeParamRow('张数', 'promptForgeBatch', 'number', batch, { min:1, max:8, step:1 }),
    _forgeParamRow('分辨率', 'promptForgeRes', 'number', res, { min:256, max:2048, step:64 }),
    _forgeParamRow('重绘幅度', 'promptForgeDenoise', 'range', denoise, { min:0, max:1, step:0.01, fmt: function(v){ return v.toFixed(2); } }),
  ];

  container.innerHTML =
    '<div class="w10-panel forge-params-mode">' +
      _renderPresetHeadHTML({ inParamsMode: false }) +
      '<div class="forge-params-body">' +
        rows.join('') +
        _renderForgeTranslateHTML(layout) +
      '</div>' +
    '</div>';

  _bindPresetHeadActions(container);
  _bindForgeParams(container);
  _bindForgeTranslate(container);
}

// ========== Forge 翻译区(选中 forge 预设后内嵌在提示词磁贴) ==========
// 简化版:只有一个输入框 + "添加到正向/反向"两个按钮
// 点按钮时自动翻译后追加到 forge.positivePrompt / forge.negativePrompt
function _renderForgeTranslateHTML(layout) {
  var isNarrow = (layout === 'narrow' || layout === 'tall');
  return '<div class="forge-translate-section">' +
    '<div class="forge-translate-title">翻译追加</div>' +
    '<textarea class="w10-input forge-translate-src" id="ftrSrc" rows="' + (isNarrow ? 2 : 3) + '" placeholder="输入中文,点下方按钮自动翻译并追加"></textarea>' +
    '<div class="forge-translate-actions">' +
      '<button class="w10-btn forge-translate-append" data-target="positive" id="ftrAppendPos">＋ 正向</button>' +
      '<button class="w10-btn forge-translate-append" data-target="negative" id="ftrAppendNeg">＋ 反向</button>' +
    '</div>' +
  '</div>';
}

// 翻译请求追踪(按 translateId 路由结果,避免并发串台)
// { [id]: { target: 'positive'|'negative', timer: <timeoutId> } }
var _pendingTranslates = {};
var _TRANSLATE_TIMEOUT_MS = 15000;

function _newTranslateId() {
  return 'trp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

function _restoreTranslateButtons() {
  var container = _findPanelContainer();
  if (!container) return;
  var btns = container.querySelectorAll('.forge-translate-append');
  for (var i = 0; i < btns.length; i++) {
    btns[i].disabled = false;
    if (btns[i].dataset.origText) btns[i].textContent = btns[i].dataset.origText;
  }
}

function _bindForgeTranslate(container) {
  var srcEl = container.querySelector('#ftrSrc');
  if (!srcEl) return;

  function submit(target) {
    var text = srcEl.value.trim();
    if (!text) { TileAPI.toast('请输入要翻译的文本', 'error'); return; }

    var id = _newTranslateId();
    var timer = setTimeout(function() {
      if (_pendingTranslates[id]) {
        delete _pendingTranslates[id];
        _restoreTranslateButtons();
        TileAPI.toast('翻译超时,请重试', 'error');
      }
    }, _TRANSLATE_TIMEOUT_MS);
    _pendingTranslates[id] = { target: target, timer: timer };

    // 禁用两个按钮避免双击
    var btns = container.querySelectorAll('.forge-translate-append');
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = true;
      btns[i].dataset.origText = btns[i].textContent;
      btns[i].textContent = '...';
    }

    TileAPI.sendToHost('youdaoTranslate', { text: text, fromLang: 'auto', toLang: 'en', translateId: id });
  }

  var pos = container.querySelector('#ftrAppendPos');
  var neg = container.querySelector('#ftrAppendNeg');
  if (pos) pos.addEventListener('click', function() { submit('positive'); });
  if (neg) neg.addEventListener('click', function() { submit('negative'); });
}

function _forgeParamRow(label, id, type, value, opts) {
  opts = opts || {};
  if (type === 'range') {
    var fill = Math.round(((value - opts.min) / (opts.max - opts.min)) * 100);
    var valText = opts.fmt ? opts.fmt(value) : String(value);
    return '<div class="forge-param-row">' +
      '<div class="forge-param-label">' + _escHtml(label) +
        '<span class="forge-param-val" id="' + id + 'Val">' + valText + '</span>' +
      '</div>' +
      '<input type="range" class="forge-param-slider" id="' + id + '" min="' + opts.min + '" max="' + opts.max + '" step="' + opts.step + '" value="' + value + '" style="--fill:' + fill + '%">' +
    '</div>';
  }
  // number
  return '<div class="forge-param-row forge-param-row-num">' +
    '<div class="forge-param-label">' + _escHtml(label) + '</div>' +
    '<input type="number" class="w10-input forge-param-num" id="' + id + '" min="' + opts.min + '" max="' + opts.max + '" step="' + opts.step + '" value="' + value + '">' +
  '</div>';
}

function _forgeParamReadonly(label, value) {
  return '<div class="forge-param-row forge-param-row-ro">' +
    '<div class="forge-param-label">' + _escHtml(label) + '</div>' +
    '<div class="forge-param-ro-val" title="' + _escHtml(value) + '">' + _escHtml(value) + '</div>' +
  '</div>';
}

function _bindForgeParams(container) {
  // 通用绑定:每个 input 变化 → 写 storage + state.meta + 发 forge:paramsChanged
  function bindNum(id, storageKey, metaKey, fallback) {
    var el = container.querySelector('#' + id);
    if (!el) return;
    el.addEventListener('change', function() {
      var v = parseFloat(this.value);
      if (isNaN(v)) v = fallback;
      TileAPI.storage.set(storageKey, v);
      _updateForgeMetaKey(metaKey, String(v));
      _emitForgeParamsChanged();
    });
  }
  function bindRange(id, valId, storageKey, metaKey, fmt) {
    var el = container.querySelector('#' + id);
    var valEl = container.querySelector('#' + valId);
    if (!el) return;
    el.addEventListener('input', function() {
      var v = parseFloat(this.value);
      var fill = Math.round(((v - +this.min) / (+this.max - +this.min)) * 100);
      this.style.setProperty('--fill', fill + '%');
      if (valEl) valEl.textContent = fmt(v);
      TileAPI.storage.set(storageKey, v);
      _updateForgeMetaKey(metaKey, fmt(v));
      _emitForgeParamsChanged();
    });
  }

  bindNum('promptForgeBatch', 'forge.batchSize', 'batch', 1);
  bindRange('promptForgeDenoise', 'promptForgeDenoiseVal', 'forge.denoise', 'denoise', function(v){ return v.toFixed(2); });
  bindNum('promptForgeSteps', 'forge.steps', 'steps', 20);
  bindNum('promptForgeRes', 'forge.resolution', 'resolution', 768);
  bindRange('promptForgeCfg', 'promptForgeCfgVal', 'forge.cfg', 'cfg', function(v){ return v.toFixed(1); });
}

function _updateForgeMetaKey(key, value) {
  var meta = TileAPI.state.get('prompt.lastPresetMeta') || {};
  meta[key] = value;
  TileAPI.state.set('prompt.lastPresetMeta', meta);
}

function _emitForgeParamsChanged() {
  TileAPI.emit('forge:paramsChanged', {
    batch: TileAPI.storage.get('forge.batchSize'),
    denoise: TileAPI.storage.get('forge.denoise'),
    steps: TileAPI.storage.get('forge.steps'),
    resolution: TileAPI.storage.get('forge.resolution'),
    cfg: TileAPI.storage.get('forge.cfg'),
  });
}

// ========== 参数模式 ==========
function _renderParamsOnly(container, text) {
  // 参数模式下统一用 prompt-preset-head 承担顶栏(含预设名 或 "参数调节" 兜底标题)
  container.innerHTML =
    '<div class="w10-panel params-mode">' +
      _renderPresetHeadHTML({ inParamsMode: true }) +
      '<div id="paramSlidersArea" class="params-slider-area"></div>' +
    '</div>';

  _bindPresetHeadActions(container);
  _parseAndRenderParams(text, container);
}

// ========== 输入框模式 ==========
// textarea 充满整个面板,直角,不固定行数/高度
function _renderTextareaMode(container, text, layout) {
  _lastTextHadParams = _hasParams(text || '') || _hasFields(text || '');   // 同步基线: 进文本模式时记下当前是否已含参数/填空
  var placeholder = (layout === 'narrow' || layout === 'tall') ? '提示词...' : '输入修图提示词...';
  container.innerHTML =
    '<div class="w10-panel prompt-ta-panel">' +
      _renderPresetHeadHTML({ inTextareaMode: true }) +
      _textareaBlock(text, { placeholder: placeholder, fullFill: true, saveBtn: true }) +
    '</div>';

  _bindPresetHeadActions(container);
  // 提示词框右下角:常驻"保存预设"图标(仅文字输入模式),复用预设磁贴的保存弹窗
  var savePresetBtn = container.querySelector('#promptSavePresetBtn');
  if (savePresetBtn) savePresetBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    TileAPI.emit('presets:requestSaveDialog');
  });
  var ta = container.querySelector('#promptTextarea');
  if (ta) {
    ta.addEventListener('input', function() {
      var val = this.value;
      var hasNow = _hasParams(val) || _hasFields(val);
      // 参数从无到有 → 这是一段新的参数提示词, 解除"强制原文"偏好;
      // 否则之前点过"切到原文"会一直挡着, 导致新参数提示词偶发不刷新成滑块。
      // (在已有参数的原文基础上继续编辑时 hasNow 与上帧都为 true, 不会触发 → 保持 #8 的"编辑原文不被甩回滑块")
      if (hasNow && !_lastTextHadParams) _forceTextView = false;
      _lastTextHadParams = hasNow;
      TileAPI.state.set('prompt.text', val);
      // 同步 storage.lastText: 否则用户清空 textarea 后, 重启 PS 时
      // onStorageLoaded 会从 storage 读回旧值, 造成"输入框看着空但 state 有残留"的幽灵 prompt
      TileAPI.storage.set('prompt.lastText', val);
      var kind = TileAPI.state.get('prompt.lastPresetKind');
      var needHeadRefresh = false;       // 仅当顶栏内容会变化时才 refresh,避免每输入一字闪烁
      if (kind === 'forge') {
        // Forge 预设:改 textarea = 改 forge 正向提示词 → 同步回 forge storage + meta
        TileAPI.storage.set('forge.positivePrompt', val);
        var meta = TileAPI.state.get('prompt.lastPresetMeta') || {};
        meta.positivePrompt = val;
        TileAPI.state.set('prompt.lastPresetMeta', meta);
        // 通知 forge 磁贴更新其 textarea(如果展开中)
        TileAPI.emit('forge:syncFromPrompt', { positivePrompt: val });
      } else if (kind || TileAPI.state.get('prompt.lastPresetTitle')) {
        // 非 forge 但有预设(banana): 手动改 = 解绑预设,需要刷顶栏让 title 变回"提示词"
        // 幽灵预设名修复: 老记录[载入提示词]会造出 kind空+title有值 的畸形态,
        // 只看 kind 会漏解绑 → 自己打的词挂着上次的预设名; 所以 title 有值也解绑
        TileAPI.state.set('prompt.lastPresetTitle', ''); TileAPI.storage.set('prompt.lastPresetTitle', '');
        TileAPI.state.set('prompt.lastPresetKind', ''); TileAPI.storage.set('prompt.lastPresetKind', '');
        TileAPI.state.set('prompt.lastPresetId', '');
        TileAPI.state.set('prompt.lastPresetMeta', null);
        needHeadRefresh = true;
      }
      _refreshFront();
      _refreshBack();
      if (needHeadRefresh) _refreshPresetHead(container);
      // 仅当真要切换到参数模式时才重建面板; 否则(普通文本/强制原文视图)不重建,
      // 避免每输入一字就重建 textarea 导致光标和滚动位置弹回顶部
      if (hasNow && !_forceTextView) {
        _renderMode(container, val);
      }
    });
    _bindClearBtn(container);
  }
}

function _textareaBlock(text, opts) {
  opts = opts || {};
  var placeholder = opts.placeholder || '输入修图提示词...';
  var cls = 'prompt-ta-wrap' + (opts.fullFill ? ' prompt-ta-fill' : '');
  // 注意:不再渲染 textarea 内嵌的 × 清空按钮
  // 顶栏已经统一提供 × (clear-text/clear-params/unbind),避免位置/样式不一致
  return '<div class="' + cls + '">' +
    '<textarea class="w10-input prompt-ta" id="promptTextarea" placeholder="' + placeholder + '">' + _escHtml(text) + '</textarea>' +
    (opts.saveBtn ? '<button class="prompt-save-preset-btn" id="promptSavePresetBtn" title="保存为预设">💾</button>' : '') +
  '</div>';
}

function _bindClearBtn(container) {
  var clearBtn = container.querySelector('#promptClearBtn');
  if (!clearBtn) return;
  clearBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    var ta = container.querySelector('#promptTextarea');
    if (!ta || !ta.value) return;
    _clearToTextareaMode(container);
  });
}

// 清空并切回输入框模式
function _clearToTextareaMode(container) {
  TileAPI.state.set('prompt.text', '');
  TileAPI.storage.set('prompt.lastText', '');
  // 关键:同时清除预设绑定,否则 _renderMode 看到 kind==='forge' 还会回到 forge 面板
  TileAPI.state.set('prompt.lastPresetTitle', ''); TileAPI.storage.set('prompt.lastPresetTitle', '');
  TileAPI.state.set('prompt.lastPresetKind', ''); TileAPI.storage.set('prompt.lastPresetKind', '');
  TileAPI.state.set('prompt.lastPresetId', '');
  TileAPI.state.set('prompt.lastPresetMeta', null);
  _renderMode(container, '');
  _refreshFront();
  _refreshBack();
}

// ========== 全局按键 (Del/Backspace 在参数模式下清空回输入模式) ==========
function _bindGlobalEvents(container) {
  // 容器级键盘:只在参数模式下响应 Del/Backspace
  var handler = function(e) {
    var panel = container.querySelector('.params-mode');
    if (!panel) return;   // 非参数模式不处理
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    // 若焦点在滑块或可编辑元素上,忽略
    var ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    _clearToTextareaMode(container);
  };
  container.addEventListener('keydown', handler);
  // 让 container 可接收 key 事件
  if (!container.hasAttribute('tabindex')) container.tabIndex = 0;
  return function() {
    container.removeEventListener('keydown', handler);
  };
}

// ========== @param 解析 + 渲染 ==========
// 支持字段: @param:NAME, @param:NAME_label, @param:NAME_desc
// label 优先级: _label → 英文 key 美化(underscore→空格 + 首字母大写) → 原 key
function _parseAndRenderParams(text, container) {
  var area = (container ? container.querySelector('#paramSlidersArea') : null);
  if (!area) area = document.getElementById('paramSlidersArea');
  if (!area) return;

  var params = [];
  var labelMap = {};         // name -> 中文 label
  var descMap = {};          // name -> 描述
  var seen = {};

  // 统一 @param 正则: 带/不带前引号都支持
  var rUnified = /"?@param:([^"\s:]+?)"\s*:\s*("[^"]*"|[-\d.]+)/g;
  var m;
  while ((m = rUnified.exec(text)) !== null) {
    var rawName = m[1];
    var raw = m[2];
    var valStr = (raw.charAt(0) === '"') ? raw.slice(1, -1) : raw;

    if (rawName.slice(-5) === '_desc') {
      descMap[rawName.slice(0, -5)] = valStr;
      continue;
    }
    if (rawName.slice(-6) === '_label') {
      labelMap[rawName.slice(0, -6)] = valStr;
      continue;
    }
    var v = parseFloat(raw);
    if (isNaN(v)) continue;
    if (seen[rawName]) continue;
    seen[rawName] = true;
    params.push({ name: rawName, value: v, fmt: 'new' });
  }

  // 老简化格式: @NAME:VALUE
  var rOld = /@([A-Za-z_][\w]*)(?:\s*["“]([^"“”]*)["”])?\s*[:：]\s*([\d.]+)/g;
  while ((m = rOld.exec(text)) !== null) {
    var n = m[1];
    if (seen[n]) continue;
    var before = text.charAt(m.index - 1);
    if (before === ':' || before === '"') continue;
    seen[n] = true;
    params.push({ name: n, label: m[2] || n, value: parseFloat(m[3]), fmt: 'old' });
  }

  // 填空字段解析: 【填空:名=默认】(同名只取第一个,默认值用第一次出现的)
  var fields = [];
  var seenF = {};
  var rField = /【填空:([^=】]+?)(?:=([^】]*))?】/g;
  var fm;
  while ((fm = rField.exec(text)) !== null) {
    var fName = fm[1];
    if (seenF[fName]) continue;
    seenF[fName] = true;
    fields.push({ name: fName, value: (fm[2] != null ? fm[2] : '') });
  }

  // 同名归一:同名填空必须同值,一律以"第一个出现的值"为准,把原文里所有同名标记拉平
  if (fields.length) {
    var canonF = {};
    fields.forEach(function(f) { canonF[f.name] = f.value; });
    var normF = text.replace(/【填空:([^=】]+?)(?:=([^】]*))?】/g, function(_m, nm) {
      return (nm in canonF) ? ('【填空:' + nm + '=' + canonF[nm] + '】') : _m;
    });
    if (normF !== text) {
      text = normF;
      TileAPI.state.set('prompt.text', normF);
      TileAPI.storage.set('prompt.lastText', normF);
    }
  }

  if (params.length === 0 && fields.length === 0) {
    area.innerHTML = '';
    area.classList.remove('params-cols-2');
    area.classList.remove('params-compact');
    area.classList.remove('params-compact-tight');
    return;
  }

  // 单/双列 + 紧凑等级自适应:目标是全部参数不滚动就显示完
  // 三档:
  //   宽松(默认): label 一行 + slider 一行,行高 ~40px
  //   紧凑(compact): label 和 slider 同一行,行高 ~22px
  //   极紧(compact-tight): 同上 + 字号 9px + 更小 padding,行高 ~18px
  var hostW = area.clientWidth || (area.parentElement ? area.parentElement.clientWidth : 0);
  var hostH = area.clientHeight || (area.parentElement ? area.parentElement.clientHeight : 0);
  var N = params.length;

  // 根据"能放下"的原则选模式,先试最舒展的,逐级降级
  var useTwoCols = (hostW >= 260 && N >= 4);
  var cols = useTwoCols ? 2 : 1;
  var rowsNeeded = Math.ceil(N / cols);

  // 估算三档各自需要的总高度
  var hLoose = rowsNeeded * 40 + 8;       // 宽松
  var hCompact = rowsNeeded * 24 + 8;     // 紧凑(同行)
  var hTight = rowsNeeded * 18 + 8;       // 极紧

  area.classList.toggle('params-cols-2', useTwoCols);
  area.classList.remove('params-compact');
  area.classList.remove('params-compact-tight');

  if (hostH > 0) {
    if (hLoose > hostH) area.classList.add('params-compact');
    if (hCompact > hostH && !useTwoCols && hostW >= 200) {
      // 单列放不下 → 尝试强制双列 compact
      area.classList.add('params-cols-2');
      useTwoCols = true;
      cols = 2;
      rowsNeeded = Math.ceil(N / cols);
      hCompact = rowsNeeded * 24 + 8;
    }
    if (hCompact > hostH) area.classList.add('params-compact-tight');
  }
  area.style.display = 'block';
  area.innerHTML = (fields.length ? '<div class="params-field-area"></div>' : '') + '<div class="params-slider-grid"></div>';
  var grid = area.querySelector('.params-slider-grid');

  // 渲染填空输入框(在滑块上方)
  var fieldArea = area.querySelector('.params-field-area');
  if (fieldArea) {
    fields.forEach(function(f) {
      var row = document.createElement('div');
      row.className = 'params-field-row';
      // 2026-07-04: input → textarea, 长内容能看全; 右下角可拖拽调高(CSS resize:vertical)
      row.innerHTML =
        '<div class="params-field-label">' + _escHtml(f.name) + '</div>' +
        '<textarea class="params-field-input" rows="1" placeholder="在此输入' + _escHtml(f.name) + '">' + _escHtml(f.value) + '</textarea>';
      var inp = row.querySelector('textarea');
      inp.addEventListener('input', function() {
        _updateFieldInPrompt(f.name, this.value);
        // 打字时内容装不下就自动长高(只长不缩, 用户手动拖出来的高度不会被抢走)
        if (this.scrollHeight > this.clientHeight + 2) {
          this.style.height = Math.min(this.scrollHeight + 2, 300) + 'px';
        }
      });
      fieldArea.appendChild(row);
      // 初始高度贴合内容: 超过一行的默认值直接展开显示, 不用拖就能看全
      try {
        if (inp.scrollHeight > inp.clientHeight + 2) {
          inp.style.height = Math.min(inp.scrollHeight + 2, 300) + 'px';
        }
      } catch (e) {}
    });
  }

  params.forEach(function(p) {
    // Label 优先级:_label(中文) > 老格式 label > 英文 key 美化 > 原 name
    var displayLabel;
    if (labelMap[p.name]) {
      displayLabel = labelMap[p.name];
    } else if (p.label) {
      displayLabel = p.label;
    } else if (/^[A-Za-z_][\w]*$/.test(p.name)) {
      displayLabel = _beautifyEnglishKey(p.name);
    } else {
      displayLabel = p.name;
    }
    var desc = descMap[p.name] || '';

    var row = document.createElement('div');
    row.className = 'params-slider-row';
    row.innerHTML =
      '<div class="params-slider-label' + (desc ? ' w10-tip-label' : '') + '"' + (desc ? ' data-tip="' + _escHtml(desc) + '"' : '') + '>' +
        '<span class="params-slider-label-text">' + _escHtml(displayLabel) + '</span>' +
        '<span class="params-slider-val">' + p.value.toFixed(2) + '</span>' +
      '</div>' +
      '<div class="params-slider-ctrl">' +
        '<input type="range" min="0" max="1" step="0.01" value="' + p.value + '" data-param="' + _escHtml(p.name) + '" data-fmt="' + p.fmt + '" style="--fill:' + (p.value * 100).toFixed(1) + '%">' +
      '</div>';
    var slider = row.querySelector('input[type=range]');
    var valSpan = row.querySelector('.params-slider-val');
    function sync(v) {
      var nv = Math.max(0, Math.min(1, parseFloat(v)));
      valSpan.textContent = nv.toFixed(2);
      slider.style.setProperty('--fill', (nv * 100).toFixed(1) + '%');
      _updateParamInPrompt(p.name, nv, p.fmt);
      // bump 数值提示
      valSpan.classList.remove('bump');
      void valSpan.offsetWidth;
      valSpan.classList.add('bump');
    }
    slider.addEventListener('input', function() { sync(this.value); });
    grid.appendChild(row);
  });
  // 参数名解释: 用全局 tooltip 浮层替代原生 title (与尻特效统一视觉)
  if (window.TileTip) window.TileTip.bind(grid);

  // 参数记忆: 这个预设有记忆时给一个「还原默认」出口(记忆只存本机, 预设文件从未被改)
  if (_pmHasMemory()) {
    var pmBar = document.createElement('div');
    pmBar.className = 'params-memory-bar';
    pmBar.innerHTML = '<button class="w10-btn params-memory-restore" title="放弃已记住的调整, 回到预设自带的默认值">↺ 还原预设默认值</button>';
    pmBar.querySelector('button').addEventListener('click', function() { _pmRestoreDefaults(); });
    area.appendChild(pmBar);
  }
}

function _beautifyEnglishKey(key) {
  // underscore→space,首字母大写
  return key.replace(/_/g, ' ').replace(/\b[a-z]/g, function(c) { return c.toUpperCase(); });
}

// ============================================================
//  参数记忆 (2026-07-04): 按预设记住用户调过的滑块/填空值
//  · 预设文件永不改写 —— 记忆存本机 storage(prompt.paramMemory), 导出/分享的预设永远是作者默认值
//  · 载入预设后自动套回上次调整(toast 明示), 参数面板有「还原预设默认值」按钮一键退回
//  · 预设改版后已不存在的参数名 → 对应记忆自动剪掉; 最多记 100 个预设, 最久没用的先淘汰
// ============================================================
var PARAM_MEMORY_KEY = 'prompt.paramMemory';
var PARAM_MEMORY_MAX = 100;

function _pmKey() {
  var id = TileAPI.state.get('prompt.lastPresetId') || '';
  var title = TileAPI.state.get('prompt.lastPresetTitle') || '';
  if (id) return 'id:' + id;
  if (title) return 't:' + title;
  return '';
}
function _pmLoadAll() { return TileAPI.storage.get(PARAM_MEMORY_KEY) || {}; }
function _pmEsc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 从文本里抠出某名字当前的值(记「默认值快照」用); 不存在返回 null
function _pmExtractField(text, name) {
  var m = new RegExp('【填空:' + _pmEsc(name) + '(?:=([^】]*))?】').exec(text);
  return m ? (m[1] || '') : null;
}
function _pmExtractParam(text, name, fmt) {
  var m = (fmt === 'new')
    ? new RegExp('"?@param:' + _pmEsc(name) + '"?\\s*:\\s*([-\\d.]+)').exec(text)
    : new RegExp('@' + _pmEsc(name) + '(?:\\s*["“][^"“”]*["”])?\\s*[:：]\\s*([\\d.]+)').exec(text);
  return m ? m[1] : null;
}

// 用户调整时记一笔; 首次调整前的值存进 orig 快照(供「还原默认」)
function _pmRemember(type, name, value, fmt, origValue) {
  var key = _pmKey(); if (!key) return;
  var all = _pmLoadAll();
  var rec = all[key] || (all[key] = {});
  rec.f = rec.f || {}; rec.p = rec.p || {};
  rec.orig = rec.orig || { f: {}, p: {} };
  var bucket = (type === 'f') ? 'f' : 'p';
  if (origValue !== null && origValue !== undefined && !(name in rec.orig[bucket])) {
    rec.orig[bucket][name] = origValue;
  }
  if (type === 'f') rec.f[name] = value;
  else rec.p[name] = { v: value, fmt: fmt || 'old' };
  rec.ts = Date.now();
  var keys = Object.keys(all);
  if (keys.length > PARAM_MEMORY_MAX) {
    keys.sort(function(a, b) { return (all[a].ts || 0) - (all[b].ts || 0); });
    for (var i = 0; i < keys.length - PARAM_MEMORY_MAX; i++) delete all[keys[i]];
  }
  TileAPI.storage.set(PARAM_MEMORY_KEY, all);
}

function _pmHasMemory() {
  var key = _pmKey(); if (!key) return false;
  var rec = _pmLoadAll()[key];
  return !!(rec && ((rec.f && Object.keys(rec.f).length) || (rec.p && Object.keys(rec.p).length)));
}

// 载入预设后套用记忆; 同时用预设当前默认值重建 orig 快照(预设改版后还原目标跟新版走), 剪掉已消失的名字
function _pmApplyAfterPresetLoad() {
  var key = _pmKey(); if (!key) return;
  var all = _pmLoadAll(); var rec = all[key];
  if (!rec) return;
  var text = TileAPI.state.get('prompt.text') || '';
  var changed = false;
  rec.orig = { f: {}, p: {} };
  Object.keys(rec.f || {}).forEach(function(name) {
    var cur = _pmExtractField(text, name);
    if (cur === null) { delete rec.f[name]; return; }   // 预设已没有这个填空 → 剪掉记忆
    rec.orig.f[name] = cur;
    var safe = String(rec.f[name]).replace(/[【】]/g, '');
    if (safe === cur) return;
    text = text.replace(new RegExp('【填空:' + _pmEsc(name) + '(?:=[^】]*)?】', 'g'),
      function() { return '【填空:' + name + '=' + safe + '】'; });
    changed = true;
  });
  Object.keys(rec.p || {}).forEach(function(name) {
    var o = rec.p[name] || {};
    var v = parseFloat(o.v);
    var cur = _pmExtractParam(text, name, o.fmt);
    if (cur === null || isNaN(v)) { delete rec.p[name]; return; }
    v = Math.max(0, Math.min(1, v));   // 滑块值域 0~1, 越界记忆按边界收
    rec.orig.p[name] = cur;
    if (String(v) === cur) return;
    if (o.fmt === 'new') {
      text = text.replace(new RegExp('("?@param:' + _pmEsc(name) + '"\\s*:\\s*)[-\\d.]+', 'g'),
        function(_m, g1) { return g1 + v; });
    } else {
      text = text.replace(new RegExp('(@' + _pmEsc(name) + '(?:\\s*["“][^"“”]*["”])?\\s*[:：]\\s*)[\\d.]+'),
        function(_m, g1) { return g1 + v; });
    }
    changed = true;
  });
  if (!Object.keys(rec.f).length && !Object.keys(rec.p).length) delete all[key];
  TileAPI.storage.set(PARAM_MEMORY_KEY, all);
  if (changed) {
    TileAPI.state.set('prompt.text', text);
    TileAPI.storage.set('prompt.lastText', text);
    var c = _findPanelContainer();
    if (c) _renderMode(c, text);
    _refreshFront(); _refreshBack();
    TileAPI.toast('已恢复上次的参数调整(预设本体未改动)', 'info');
  }
}

// 一键还原预设默认值: 把 orig 快照写回文本 + 删掉这条记忆
function _pmRestoreDefaults() {
  var key = _pmKey(); if (!key) return;
  var all = _pmLoadAll(); var rec = all[key];
  if (!rec) return;
  var text = TileAPI.state.get('prompt.text') || '';
  var orig = rec.orig || { f: {}, p: {} };
  Object.keys(orig.f || {}).forEach(function(name) {
    text = text.replace(new RegExp('【填空:' + _pmEsc(name) + '(?:=[^】]*)?】', 'g'),
      function() { return '【填空:' + name + '=' + orig.f[name] + '】'; });
  });
  Object.keys(orig.p || {}).forEach(function(name) {
    var fmt = (rec.p && rec.p[name] && rec.p[name].fmt) || 'old';
    if (fmt === 'new') {
      text = text.replace(new RegExp('("?@param:' + _pmEsc(name) + '"\\s*:\\s*)[-\\d.]+', 'g'),
        function(_m, g1) { return g1 + orig.p[name]; });
    } else {
      text = text.replace(new RegExp('(@' + _pmEsc(name) + '(?:\\s*["“][^"“”]*["”])?\\s*[:：]\\s*)[\\d.]+'),
        function(_m, g1) { return g1 + orig.p[name]; });
    }
  });
  delete all[key];
  TileAPI.storage.set(PARAM_MEMORY_KEY, all);
  TileAPI.state.set('prompt.text', text);
  TileAPI.storage.set('prompt.lastText', text);
  var c = _findPanelContainer();
  if (c) _renderMode(c, text);
  _refreshFront(); _refreshBack();
  TileAPI.toast('已还原预设默认值', 'success');
}

function _updateParamInPrompt(paramName, newValue, fmt) {
  var src = TileAPI.state.get('prompt.text') || '';
  var origVal = _pmExtractParam(src, paramName, fmt);   // 首次调整前的默认值(参数记忆用)
  var updated;
  if (fmt === 'new') {
    var escName = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var rN = new RegExp('("?@param:' + escName + '"\\s*:\\s*)[-\\d.]+', 'g');
    updated = src.replace(rN, '$1' + newValue);
  } else {
    var escOld = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var rO = new RegExp('(@' + escOld + '(?:\\s*["“][^"“”]*["”])?\\s*[:：]\\s*)[\\d.]+');
    updated = src.replace(rO, '$1' + newValue);
  }
  TileAPI.state.set('prompt.text', updated);
  TileAPI.storage.set('prompt.lastText', updated);
  _pmRemember('p', paramName, newValue, fmt, origVal);   // 参数记忆
  _refreshFront();
}

// 填空字段写回:把【填空:名=...】里的值换成输入框内容(同名全部一起换)
// 跟滑块一样只刷前脸、不重渲面板,所以输入框不会丢光标
function _updateFieldInPrompt(fieldName, newValue) {
  var src = TileAPI.state.get('prompt.text') || '';
  var origVal = _pmExtractField(src, fieldName);   // 首次调整前的默认值(参数记忆用)
  var safe = String(newValue).replace(/[【】]/g, ''); // 防止破坏标记外壳
  var escName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var r = new RegExp('【填空:' + escName + '(?:=[^】]*)?】', 'g');
  var updated = src.replace(r, function() { return '【填空:' + fieldName + '=' + safe + '】'; });
  TileAPI.state.set('prompt.text', updated);
  TileAPI.storage.set('prompt.lastText', updated);
  _pmRemember('f', fieldName, safe, null, origVal);   // 参数记忆
  _refreshFront();
}
function _escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _refreshFront() {
  var el = TileEngine.getTileElement('prompt');
  if (!el) return;
  var inner = el.querySelector('.tile-inner') || el.querySelector('.tile-flip-front');
  if (inner) renderFront(inner, +el.dataset.w || 4, +el.dataset.h || 2);
}

function _findPanelContainer() {
  var el = TileEngine.getTileElement('prompt');
  if (!el) return null;
  return el.querySelector('.tile-expand-content');
}

// ========== 全局 prompt:changed ==========
TileAPI.on('prompt:changed', function(data) {
  if (!data || typeof data.text !== 'string') return;
  TileAPI.state.set('prompt.text', data.text);
  TileAPI.storage.set('prompt.lastText', data.text);
  // 非预设来源的修改要清掉缓存的预设名(比如手动打字)
  if (data.source !== 'preset') {
    TileAPI.state.set('prompt.lastPresetTitle', ''); TileAPI.storage.set('prompt.lastPresetTitle', '');
    TileAPI.state.set('prompt.lastPresetKind', ''); TileAPI.storage.set('prompt.lastPresetKind', '');
    TileAPI.state.set('prompt.lastPresetId', '');
    TileAPI.state.set('prompt.lastPresetMeta', null);
  }
  // 文本变化(包括加载新预设) → 重置"强制原文"偏好
  if (data.source === 'preset') _forceTextView = false;
  var container = _findPanelContainer();
  if (container) _renderMode(container, data.text);
  _refreshFront();
  _refreshBack();
});

// ========== Codex 自动化钩子: 强制切普通文本输入模式 ==========
// 解除预设/滑块绑定 + 强制 textarea 视图, 让 Codex 写的提示词一定被当普通文本用。
// 纯新增监听, 不改现有行为。
TileAPI.on('prompt:forceText', function() {
  _forceTextView = true;
  TileAPI.state.set('prompt.lastPresetTitle', ''); TileAPI.storage.set('prompt.lastPresetTitle', '');
  TileAPI.state.set('prompt.lastPresetKind', ''); TileAPI.storage.set('prompt.lastPresetKind', '');
  TileAPI.state.set('prompt.lastPresetId', '');
  TileAPI.state.set('prompt.lastPresetMeta', null);
  try {
    var c = _findPanelContainer();
    if (c) _renderMode(c, TileAPI.state.get('prompt.text') || '');
    _refreshFront(); _refreshBack();
  } catch (e) {}
});

// 预设载入 → 记录标题(由 tile-presets 触发)
TileAPI.on('preset:loaded', function(data) {
  // 切到新预设也要重置"强制原文"偏好
  _forceTextView = false;
  if (data && data.title) {
    TileAPI.state.set('prompt.lastPresetTitle', data.title); TileAPI.storage.set('prompt.lastPresetTitle', data.title);
    _refreshBack();
  }
  // 参数记忆: 这个预设上次调过的滑块/填空值, 自动套回去(预设文件不动)
  try { _pmApplyAfterPresetLoad(); } catch (e) {}
});

// Forge 磁贴正向提示词变化 → 同步到提示词磁贴 textarea(如果打开中)
TileAPI.on('forge:syncToPrompt', function(data) {
  if (!data || typeof data.positivePrompt !== 'string') return;
  var container = _findPanelContainer();
  if (!container) return;
  var ta = container.querySelector('#promptTextarea');
  if (ta && ta.value !== data.positivePrompt) {
    // 避免触发 input 反复派发
    ta.value = data.positivePrompt;
  }
  _refreshFront();
  _refreshBack();
});

// Forge 磁贴参数(张数/重绘/步数/分辨率/CFG/采样器/模型)变化 → 同步到提示词磁贴 forge 参数面板
TileAPI.on('forge:tileChanged', function(data) {
  if (!data || !data.key) return;
  var container = _findPanelContainer();
  if (!container) return;
  // 最省事:直接重绘(forge 参数面板是 forge 预设时 _renderMode 的产物)
  if (TileAPI.state.get('prompt.lastPresetKind') === 'forge') {
    _renderMode(container, TileAPI.state.get('prompt.text') || '');
  }
  _refreshBack();
});

})();
