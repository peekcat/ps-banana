// ============================================================
//  tile-hemisynth.js — 半合成 (现场布景化 / 手办地台 / 垂悬环绕物)
//  三个 Tab 共用一套流程: 内置提示词(【填空】标记) + 输入框写回
//  → 抓 PS 选区当输入图 → 走总体配置渠道 callAiApi → 贴回 PS
//  生成自动进 任务队列/历史/回收站/对话式生成预览 (callAiApi 内置广播)。
//  自动模式: 调 AI 助手的语言模型(chat.url/key/model)识别选区角色, 填所有框。
//  UI 遵循 _dev/UI_SPEC.md: 单层 .w10-panel + 标准 .w10-* 组件。
// ============================================================
(function() {
'use strict';

// ========== Private state ==========
var _runningCount = 0;
var _taskIds = [];
var _activeContainer = null;
var _autoDetecting = false;

var TABS = [
  { id: 'semi',     label: '半合成' },
  { id: 'diorama',  label: '手办地台' },
  { id: 'hangonly', label: '垂悬环绕物' }
];

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _prompts() { return window._hemisynthPrompts || {}; }

// 当前 tab ('semi' | 'diorama' | 'hangonly')
function _getTab() {
  var t = TileAPI.storage.get('hemisynth.tab') || 'semi';
  for (var i = 0; i < TABS.length; i++) if (TABS[i].id === t) return t;
  return 'semi';
}

// 半合成 tab 的垂悬开关
function _getHangOn() { return !!TileAPI.storage.get('hemisynth.hangOn'); }

// 半合成 tab 的半身像兼容模式开关（开启 = 用 semiBust 词：不做地面，四类悬浮/前景元素）
function _getBustMode() { return !!TileAPI.storage.get('hemisynth.bustMode'); }

// 体块/标注控制模式开关 (混入半合成/手办地台等布景任务)
function _getBodyblockOn() { return !!TileAPI.storage.get('hemisynth.bodyblockOn'); }

// tab + 开关 → 提示词模板 key
function _templateKey() {
  var tab = _getTab();
  if (tab === 'semi') {
    // 体块/标注控制模式优先：开启后直接用体块融合版半合成(忽略半身/垂悬开关)
    if (_getBodyblockOn()) return 'semiBodyblock';
    // 半身模式优先：开启后直接走 semiBust，忽略垂悬开关
    if (_getBustMode()) return 'semiBust';
    return _getHangOn() ? 'semiHang' : 'semiPlain';
  }
  if (tab === 'diorama') return 'diorama';
  return 'hangonly';
}

// 从模板文本解析【填空:名=默认】字段列表 (与 tile-prompt.js 同一正则, 同名只取第一个)
function _parseFields(text) {
  var fields = [];
  var seen = {};
  var r = /【填空:([^=】]+?)(?:=([^】]*))?】/g;
  var m;
  while ((m = r.exec(text || '')) !== null) {
    if (seen[m[1]]) continue;
    seen[m[1]] = true;
    fields.push({ name: m[1], def: (m[2] != null ? m[2] : '') });
  }
  return fields;
}

// 用户填的值: 按模板 key 分开存, 切 tab / 切开关不串
function _getValues(tplKey) {
  var all = TileAPI.storage.get('hemisynth.fields') || {};
  return all[tplKey] || {};
}
function _setValue(tplKey, name, value) {
  var all = TileAPI.storage.get('hemisynth.fields') || {};
  if (!all[tplKey]) all[tplKey] = {};
  all[tplKey][name] = value;
  TileAPI.storage.set('hemisynth.fields', all);
}
function _setValues(tplKey, obj) {
  var all = TileAPI.storage.get('hemisynth.fields') || {};
  if (!all[tplKey]) all[tplKey] = {};
  for (var k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) all[tplKey][k] = obj[k]; }
  TileAPI.storage.set('hemisynth.fields', all);
}

// 丰富度 (1=极简 ... 5=极繁, 默认 3=适中) — 全局共用, 影响 AI 自动识别的产出饱满度
var RICHNESS_LABELS = { 1: '极简', 2: '简洁', 3: '适中', 4: '丰富', 5: '极繁' };
function _getRichness() {
  var v = parseInt(TileAPI.storage.get('hemisynth.richness'), 10);
  return (v >= 1 && v <= 5) ? v : 3;
}
function _setRichness(v) {
  var n = Math.max(1, Math.min(5, parseInt(v, 10) || 3));
  TileAPI.storage.set('hemisynth.richness', n);
}

// 角色补充信息 (辅助自动识别) — 全局共用, 三个 Tab 通用
function _getCharHint() { return TileAPI.storage.get('hemisynth.charHint') || ''; }
function _setCharHint(v) { TileAPI.storage.set('hemisynth.charHint', String(v == null ? '' : v)); }

// 切换 tab / 开关前, 主动把当前面板里所有输入框的值抓回 storage —
// 不依赖 textarea 的 input 事件时机 (UXP webview 里输入法合成/快速切换可能漏触发),
// 保证重建 DOM 后能原样读回, 修复"切换时输入框内容被刷新掉"。
function _harvestFields(container) {
  if (!container) return;
  var tplKey = _templateKey();
  var els = container.querySelectorAll('.hs-field');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (el && el.dataset && el.dataset.field) _setValue(tplKey, el.dataset.field, el.value);
  }
  var densSel = container.querySelector('#hsField_密度');
  if (densSel) _setValue(tplKey, '道具密度', densSel.value);
  // 全局项(角色补充信息): 切 Tab 也保住, 防 input 漏触发
  var charHintEl = container.querySelector('#hsCharHint');
  if (charHintEl) _setCharHint(charHintEl.value);
}

// 输入框值写回提示词: 把模板里所有【填空:名=...】换成【填空:名=用户值】
// (标记保留原样, 发送时由 host 的 sanitizePrompt 统一替换 — 与提示词磁贴规则一致)
function _buildPrompt() {
  var tplKey = _templateKey();
  var tpl = _prompts()[tplKey];
  if (!tpl || !tpl.text) return '';
  var values = _getValues(tplKey);

  // 体块/标注控制模式: 把「体块编辑框」+「角色补充信息」一起填进「体块描述」,
  // 让 AI 结合两者理解并编辑成精准的体块替换指令
  if (_getBodyblockOn() && tplKey === 'semiBodyblock') {
    var bbNote = TileAPI.storage.get('hemisynth.bodyblockNote') || '';
    var bbHint = _getCharHint();
    var combined = [];
    if (bbNote.trim()) combined.push('用户要替换的体块: ' + bbNote.trim());
    if (bbHint.trim()) combined.push('角色/场景补充(替换方向以此为准): ' + bbHint.trim());
    if (combined.length) values['体块描述'] = combined.join('。');
  }

  var prompt = tpl.text.replace(/【填空:([^=】]+?)(?:=([^】]*))?】/g, function(_m, name, def) {
    var v = (values[name] != null) ? values[name] : (def || '');
    v = String(v).replace(/[【】]/g, '');   // 防止破坏标记外壳 (同 tile-prompt._updateFieldInPrompt)
    return '【填空:' + name + '=' + v + '】';
  });
  return prompt;
}

// ========== 渠道 / 模型 / 尺寸 (读全局视图, 同 tile-kao) ==========
function _getConfigFor(provider) {
  return TileAPI.state.get('models.' + (provider || 'aji')) || {};
}
function _populateModelSelect(sel, provider) {
  if (!sel) return;
  var cfg = _getConfigFor(provider);
  sel.innerHTML = '';
  for (var mid in cfg) {
    var opt = document.createElement('option');
    opt.value = mid;
    opt.textContent = (cfg[mid] && cfg[mid].name) || mid;
    sel.appendChild(opt);
  }
  var saved = TileAPI.storage.get('hemisynth.model');
  if (saved && cfg[saved]) sel.value = saved;
}
function _populateSizeSelect(sel, provider, modelKey) {
  if (!sel) return;
  var cfg = _getConfigFor(provider);
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
  var providerSel = container.querySelector('#hsProvider');
  var modelSel = container.querySelector('#hsModel');
  var sizeSel = container.querySelector('#hsSize');
  var provider = (providerSel && providerSel.value) || 'aji';
  if (modelSel) {
    _populateSizeSelect(sizeSel, provider, modelSel.value);
    TileAPI.storage.set('hemisynth.model', modelSel.value);
  }
}

// ========== 渲染 ==========
function _selectRow(label, selId, innerHtml) {
  return '<div class="w10-row">' +
    '<div class="w10-row-left"><div class="w10-row-label">' + label + '</div></div>' +
    '<div class="w10-row-right"><select class="w10-select" id="' + selId + '" style="width:150px;max-width:55%;">' + innerHtml + '</select></div>' +
  '</div>';
}

var DENSITY_OPTS = ['', '极简', '简洁', '适中', '丰富', '极繁'];
var HEIGHT_OPTS = ['', '头顶', '肩部', '胸部', '腰部'];

// 单个填空输入框行 (道具密度、物体高度特殊: 下拉)
function _fieldRow(tplKey, f, value) {
  if (f.name === '道具密度') {
    var h = '';
    for (var i = 0; i < DENSITY_OPTS.length; i++) {
      var v = DENSITY_OPTS[i];
      h += '<option value="' + v + '"' + (value === v ? ' selected' : '') + '>' + (v === '' ? '自动 (默认适中)' : v) + '</option>';
    }
    return _selectRow('道具密度', 'hsField_密度', h);
  }
  if (f.name === '物体高度') {
    var h = '';
    for (var i = 0; i < HEIGHT_OPTS.length; i++) {
      var v = HEIGHT_OPTS[i];
      h += '<option value="' + v + '"' + (value === v ? ' selected' : '') + '>' + (v === '' ? '自动 (默认头顶齐平)' : v) + '</option>';
    }
    return _selectRow('物体高度', 'hsField_高度', h);
  }
  return '<div class="w10-row" style="flex-direction:column;align-items:stretch;gap:4px;padding:6px 0;">' +
    '<div class="w10-row-label" style="font-size:11px;">' + _esc(f.name) + '</div>' +
    '<textarea class="w10-input hs-field" data-field="' + _esc(f.name) + '" rows="1" ' +
      'placeholder="留空 = AI 按角色属性/看图自动判定">' + _esc(value || '') + '</textarea>' +
  '</div>';
}

function _renderLayout(container) {
  var tab = _getTab();
  var tplKey = _templateKey();
  var tpl = _prompts()[tplKey];
  var provider = TileAPI.storage.get('hemisynth.provider') || TileAPI.state.get('params.provider') || 'aji';
  var aspect = TileAPI.storage.get('hemisynth.aspectRatio') || 'Auto';
  var batch = TileAPI.storage.get('hemisynth.batch') || 1;

  var html = '<div class="w10-panel">';

  // —— 顶部 Tab (分段选择器) ——
  html += '<div class="sf-pill" id="hsTabs" style="display:flex;margin-bottom:8px;">';
  TABS.forEach(function(t) {
    html += '<div class="sf-pill-opt' + (t.id === tab ? ' active' : '') + '" data-tab="' + t.id + '" style="flex:1;text-align:center;">' + t.label + '</div>';
  });
  html += '</div>';

  if (!tpl) {
    html += '<div class="w10-row-desc">提示词数据未加载 (tile-hemisynth.prompts.js 缺失或报错), 请重启插件。</div></div>';
    container.innerHTML = html;
    return;
  }

  // —— 半合成 tab: 两个开关 (体块控制 tab 不显示这些) ——
  if (tab === 'semi') {
    var bustMode = _getBustMode();
    var hangOn = _getHangOn();

    // 半身像兼容模式开关
    html += '<div class="w10-row">' +
      '<div class="w10-row-left">' +
        '<div class="w10-row-label">半身像兼容模式</div>' +
        '<div class="w10-row-desc">' + (bustMode ? '开启: 不做地面, 用四类悬浮/前景元素' : '关闭: 标准全身布景(地面+道具)') + '</div>' +
      '</div>' +
      '<div class="w10-row-right"><div class="w10-toggle' + (bustMode ? ' on' : '') + '" id="hsBustTog"></div></div>' +
    '</div>';

    // 垂悬环绕物开关（半身模式开启时置灰）
    html += '<div class="w10-row">' +
      '<div class="w10-row-left">' +
        '<div class="w10-row-label">垂悬环绕物' + (bustMode ? ' (半身模式下不可用)' : '') + '</div>' +
        '<div class="w10-row-desc">' +
          (bustMode
            ? '半身像兼容模式开启时, 自动用半身专属元素(垂悬功能已内含), 此开关暂时不生效'
            : (hangOn ? '开启: 布景含带状环绕悬空系统' : '关闭: 只做地面布景+少量浮空点缀')) +
        '</div>' +
      '</div>' +
      '<div class="w10-row-right"><div class="w10-toggle' + (hangOn ? ' on' : '') + (bustMode ? ' disabled' : '') + '" id="hsHangTog"></div></div>' +
    '</div>';
  }

  // —— 体块/标注控制模式开关 (半合成标签显示; 手办地台/垂悬环绕物不显示) ——
  if (tab === 'semi') {
    var bodyblockOn = _getBodyblockOn();
    html += '<div class="w10-row">' +
      '<div class="w10-row-left">' +
        '<div class="w10-row-label">体块/标注控制模式</div>' +
        '<div class="w10-row-desc">' + (bodyblockOn ? '开启: 用体块融合版半合成(先替换画面中的体块, 再做布景)' : '关闭: 只做布景, 不动画面里的体块') + '</div>' +
      '</div>' +
      '<div class="w10-row-right"><div class="w10-toggle' + (bodyblockOn ? ' on' : '') + '" id="hsBodyblockTog"></div></div>' +
    '</div>';

    // 开启时: 显示单个体块编辑框 (用户描述要替换的体块, AI 负责编辑成精准替换指令)
    if (bodyblockOn) {
      var bbNote = TileAPI.storage.get('hemisynth.bodyblockNote') || '';
      html += '<div class="w10-row" style="flex-direction:column;align-items:stretch;gap:4px;padding:6px 0;">' +
        '<div class="w10-row-label" style="font-size:11px;">体块编辑 (要替换哪些体块, 告诉 AI)</div>' +
        '<textarea class="w10-input" id="hsBbNote" rows="2" placeholder="如: 把画面左下角的白色方块替换成花束, 右上角写着灯笼的方块替换成灯笼">' + _esc(bbNote) + '</textarea>' +
        '<div class="w10-row-desc" style="font-size:10px;">描述要替换的体块在哪/长什么样/替换成什么; 可在体块上写字, 描述里注明, AI 按字定位。生成时会连同「角色补充信息」一起交给 AI 编辑成精准替换指令。</div>' +
      '</div>';
    }
  }

  // —— 输入框 (从模板解析, 顺序与提示词一致) ——
  html += '<div class="w10-section-title" style="display:flex;align-items:center;justify-content:space-between;">' +
    '<span>参数 (留空则 AI 自动判定)</span>' +
    '<button class="w10-btn" id="hsAutoBtn" style="padding:2px 10px;font-size:11px;flex-shrink:0;">' +
      (_autoDetecting ? '识别中...' : '🤖 自动识别') + '</button>' +
  '</div>';

  // —— 自动识别丰富度 (滑块, 影响 AI 产出的布景饱满度) ——
  var rich = _getRichness();
  html += '<div class="w10-row" style="flex-direction:column;align-items:stretch;gap:4px;padding:6px 0;">' +
    '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;">' +
      '<div class="w10-row-label" style="font-size:11px;">自动识别丰富度</div>' +
      '<span class="w10-ps-val" id="hsRichVal">' + rich + ' · ' + RICHNESS_LABELS[rich] + '</span>' +
    '</div>' +
    '<div class="w10-ps-slider">' +
      '<input type="range" id="hsRich" min="1" max="5" step="1" value="' + rich + '" style="--fill:' + ((rich - 1) / 4 * 100).toFixed(1) + '%">' +
    '</div>' +
    '<div class="w10-row-desc" style="font-size:10px;">越往右, AI 自动识别时给出的道具/悬空元素越多、场景越饱满</div>' +
  '</div>';

  // —— 角色补充信息 (辅助自动识别: 角色名/出处/其它提示; AI 认不准时用它兜底) ——
  var hint = _getCharHint();
  html += '<div class="w10-row" style="flex-direction:column;align-items:stretch;gap:4px;padding:6px 0;">' +
    '<div class="w10-row-label" style="font-size:11px;">角色补充信息 (辅助识别 · 选填)</div>' +
    '<textarea class="w10-input" id="hsCharHint" rows="1" ' +
      'placeholder="填角色名/出处/其它提示, 帮 AI 识别更准。如: 明日方舟 陈, 红色军装">' + _esc(hint || '') + '</textarea>' +
    '<div class="w10-row-desc" style="font-size:10px;">AI 看图认不出角色时以此为准; 留空则纯靠看图</div>' +
  '</div>';

  var fields = _parseFields(tpl.text);
  var values = _getValues(tplKey);
  fields.forEach(function(f) {
    html += _fieldRow(tplKey, f, values[f.name] != null ? values[f.name] : '');
  });

  // —— 生成参数 ——
  html += '<div class="w10-section-title">生成</div>';
  // 参考图 (读参考图磁贴的全局列表, 与单图生成同源)
  var refCount = (TileAPI.state.get('refimages.list') || []).length;
  html += '<div class="w10-row">' +
    '<div class="w10-row-left"><div class="w10-row-label">参考图</div>' +
      '<div class="w10-row-desc" id="hsRefDesc">' + (refCount ? '已带 ' + refCount + ' 张 (随生成一起发给 AI)' : '无 · 到「参考图」磁贴用 PS 选区抓取') + '</div></div>' +
    '<div class="w10-row-right">' +
      '<div class="w10-toggle' + (TileAPI.storage.get('hemisynth.useRefs') === true ? ' on' : '') + '" id="hsRefTog"></div>' +
    '</div>' +
  '</div>';
  html += _selectRow('API 引擎', 'hsProvider',
    TileAPI.slotOrder().map(function(eng) {
      var def = eng === 'aji' ? 'AJI' : eng === 'grs' ? (TileAPI.computeBrand ? TileAPI.computeBrand() : 'GRS') : 'Others';
      return '<option value="' + eng + '"' + (provider === eng ? ' selected' : '') + '>' + TileAPI.slotLabel(eng, def) + '</option>';
    }).join(''));
  html += _selectRow('模型', 'hsModel', '');
  html += _selectRow('分辨率', 'hsSize', '');
  var aspOpts = ['Auto', '1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4'];
  var aspHtml = '';
  for (var ai = 0; ai < aspOpts.length; ai++) aspHtml += '<option' + (aspect === aspOpts[ai] ? ' selected' : '') + '>' + aspOpts[ai] + '</option>';
  html += _selectRow('宽高比', 'hsAspect', aspHtml);
  html += '<div class="w10-row">' +
    '<div class="w10-row-left"><div class="w10-row-label">生成数量</div></div>' +
    '<div class="w10-row-right"><input type="number" class="w10-input" id="hsBatch" min="1" max="8" step="1" value="' + batch + '" style="width:80px;text-align:center;"></div>' +
  '</div>';

  html += '<div class="w10-row" style="border-bottom:none;flex-direction:column;align-items:stretch;gap:8px;">' +
    '<button class="w10-btn w10-btn-accent" id="hsStartBtn">✨ 生成 (框选人物区域后点这里)</button>' +
    '<div class="w10-row-desc" id="hsStatus" style="text-align:center;">' +
      (_runningCount > 0 ? '进行中 ' + _runningCount + ' 个任务, 详见任务磁贴' : '先在 PS 里框选人物画面, 无选区则用整张画布') +
    '</div>' +
  '</div>';

  html += '</div>';
  container.innerHTML = html;
}

// ========== 事件绑定 ==========
function _bindEvents(container) {
  // Tab 切换
  var tabsEl = container.querySelector('#hsTabs');
  if (tabsEl) tabsEl.addEventListener('click', function(ev) {
    var opt = ev.target.closest ? ev.target.closest('.sf-pill-opt') : null;
    if (!opt || !opt.dataset.tab) return;
    if (opt.dataset.tab === _getTab()) return;   // 点当前 tab 不重建
    _harvestFields(container);                   // 切换前先存住当前输入, 防丢
    TileAPI.storage.set('hemisynth.tab', opt.dataset.tab);
    _rerender(container);
  });

  // 半身像兼容模式开关
  var bustTog = container.querySelector('#hsBustTog');
  if (bustTog) bustTog.addEventListener('click', function() {
    _harvestFields(container);
    TileAPI.storage.set('hemisynth.bustMode', !_getBustMode());
    _rerender(container);
  });

  // 垂悬开关（半身模式开启时不响应点击）
  var hangTog = container.querySelector('#hsHangTog');
  if (hangTog) hangTog.addEventListener('click', function() {
    if (_getBustMode()) return;  // 半身模式下置灰不生效
    _harvestFields(container);
    TileAPI.storage.set('hemisynth.hangOn', !_getHangOn());
    _rerender(container);
  });

  // 体块/标注控制模式开关
  var bodyblockTog = container.querySelector('#hsBodyblockTog');
  if (bodyblockTog) bodyblockTog.addEventListener('click', function() {
    _harvestFields(container);
    TileAPI.storage.set('hemisynth.bodyblockOn', !_getBodyblockOn());
    _rerender(container);
  });

  // 体块编辑框 → 写回存储
  var bbNoteEl = container.querySelector('#hsBbNote');
  if (bbNoteEl) {
    bbNoteEl.addEventListener('input', function() {
      TileAPI.storage.set('hemisynth.bodyblockNote', this.value);
      if (this.scrollHeight > this.clientHeight + 2) {
        this.style.height = Math.min(this.scrollHeight + 2, 300) + 'px';
      }
    });
    try { if (bbNoteEl.scrollHeight > bbNoteEl.clientHeight + 2) bbNoteEl.style.height = Math.min(bbNoteEl.scrollHeight + 2, 300) + 'px'; } catch (e) {}
  }

  // 填空输入框 → 写回存储
  var tplKey = _templateKey();
  var fieldEls = container.querySelectorAll('.hs-field');
  for (var i = 0; i < fieldEls.length; i++) {
    (function(el) {
      el.addEventListener('input', function() {
        _setValue(tplKey, el.dataset.field, el.value);
        if (el.scrollHeight > el.clientHeight + 2) {
          el.style.height = Math.min(el.scrollHeight + 2, 300) + 'px';
        }
      });
      // 初始高度贴合内容
      try {
        if (el.scrollHeight > el.clientHeight + 2) el.style.height = Math.min(el.scrollHeight + 2, 300) + 'px';
      } catch (e) {}
    })(fieldEls[i]);
  }

  // 道具密度下拉
  var densSel = container.querySelector('#hsField_密度');
  if (densSel) densSel.addEventListener('change', function() {
    _setValue(tplKey, '道具密度', densSel.value);
  });

  // 物体高度下拉
  var heightSel = container.querySelector('#hsField_高度');
  if (heightSel) heightSel.addEventListener('change', function() {
    _setValue(tplKey, '物体高度', heightSel.value);
  });

  // 自动识别丰富度滑块
  var richSl = container.querySelector('#hsRich');
  var richVal = container.querySelector('#hsRichVal');
  if (richSl) richSl.addEventListener('input', function() {
    var v = Math.max(1, Math.min(5, parseInt(this.value, 10) || 3));
    _setRichness(v);
    if (richVal) richVal.textContent = v + ' · ' + RICHNESS_LABELS[v];
    this.style.setProperty('--fill', ((v - 1) / 4 * 100).toFixed(1) + '%');
  });

  // 角色补充信息 → 写回存储 (辅助自动识别)
  var charHintEl = container.querySelector('#hsCharHint');
  if (charHintEl) {
    charHintEl.addEventListener('input', function() {
      _setCharHint(this.value);
      if (this.scrollHeight > this.clientHeight + 2) this.style.height = Math.min(this.scrollHeight + 2, 200) + 'px';
    });
    try { if (charHintEl.scrollHeight > charHintEl.clientHeight + 2) charHintEl.style.height = Math.min(charHintEl.scrollHeight + 2, 200) + 'px'; } catch (e) {}
  }

  // 自动识别
  var autoBtn = container.querySelector('#hsAutoBtn');
  if (autoBtn) autoBtn.addEventListener('click', function() { _doAutoDetect(container); });

  // 参考图开关 (开 = 生成时把参考图磁贴的列表一起发给 AI)
  var refTog = container.querySelector('#hsRefTog');
  if (refTog) refTog.addEventListener('click', function() {
    var now = !(TileAPI.storage.get('hemisynth.useRefs') === true);
    TileAPI.storage.set('hemisynth.useRefs', now);
    refTog.classList.toggle('on', now);
  });

  // Provider / Model 联动
  var providerSel = container.querySelector('#hsProvider');
  if (providerSel) providerSel.addEventListener('change', function() {
    TileAPI.storage.set('hemisynth.provider', providerSel.value);
    _populateModelSelect(container.querySelector('#hsModel'), providerSel.value);
    _onModelChange(container);
  });
  var modelSel = container.querySelector('#hsModel');
  if (modelSel) modelSel.addEventListener('change', function() { _onModelChange(container); });

  // 其余参数持久化
  var persist = [
    { id: 'hsSize', key: 'hemisynth.size' },
    { id: 'hsAspect', key: 'hemisynth.aspectRatio' },
    { id: 'hsBatch', key: 'hemisynth.batch' }
  ];
  persist.forEach(function(p) {
    var el = container.querySelector('#' + p.id);
    if (el) el.addEventListener('change', function() { TileAPI.storage.set(p.key, el.value); });
  });

  // 生成 (可连续点, 并发提交 — 同 tile-kao, 中断走任务磁贴)
  var startBtn = container.querySelector('#hsStartBtn');
  if (startBtn) startBtn.addEventListener('click', function() { _doStart(container); });
}

function _rerender(container) {
  if (!container) return;
  _renderLayout(container);
  _afterRender(container);
}

function _afterRender(container) {
  var providerSel = container.querySelector('#hsProvider');
  _populateModelSelect(container.querySelector('#hsModel'), providerSel ? providerSel.value : 'aji');
  _onModelChange(container);
  var savedSize = TileAPI.storage.get('hemisynth.size');
  var sizeSel = container.querySelector('#hsSize');
  if (savedSize && sizeSel) {
    for (var i = 0; i < sizeSel.options.length; i++) {
      if (sizeSel.options[i].value === savedSize) { sizeSel.value = savedSize; break; }
    }
  }
  _bindEvents(container);
}

// ========== 自动模式: AI 助手语言模型识别选区角色, 填所有框 ==========
function _doAutoDetect(container) {
  if (_autoDetecting) { TileAPI.toast('正在识别中, 请稍候', 'info'); return; }

  // AI 助手独立配置 (chat.url/key/model 在 panel storage, host 读不到 → 前端读了传过去)
  var chatUrl = TileAPI.storage.get('chat.url') || '';
  var chatKey = TileAPI.storage.get('chat.key') || '';
  var chatModel = TileAPI.storage.get('chat.model') || '';
  if (!chatKey || !chatUrl || !chatModel) {
    TileAPI.toast('自动识别需要 AI 助手的语言模型, 请先到「AI 助手」磁贴的 ⚙ 设置里配置 URL / Key / 模型', 'error');
    return;
  }

  var tplKey = _templateKey();
  var tpl = _prompts()[tplKey];
  if (!tpl) return;
  var fields = _parseFields(tpl.text);
  var fieldNames = fields.map(function(f) { return f.name; });

  // 半身模式标识（host 需要用它来调整 system prompt）
  var bustMode = _getBustMode();

  _autoDetecting = true;
  var btn = container.querySelector('#hsAutoBtn');
  if (btn) { btn.textContent = '识别中...'; btn.disabled = true; }
  var st = container.querySelector('#hsStatus');
  if (st) st.textContent = '正在抓取选区并识别角色...';

  var richness = _getRichness();
  TileAPI.sendToHost('hemisynthAutoDetect', {
    chatUrl: chatUrl, chatKey: chatKey, chatModel: chatModel,
    tplKey: tplKey, tabLabel: tpl.label, fieldNames: fieldNames,
    richness: richness, richnessLabel: RICHNESS_LABELS[richness],
    charHint: _getCharHint(),
    bustMode: bustMode  // 半身模式标识，host 用它调整 system prompt
  });
}

function _onAutoResult(data) {
  _autoDetecting = false;
  var container = _activeContainer;
  if (container) {
    var btn = container.querySelector('#hsAutoBtn');
    if (btn) { btn.textContent = '🤖 自动识别'; btn.disabled = false; }
  }
  if (!data || !data.success) {
    // 识别失败不清空已填内容
    TileAPI.toast('自动识别失败: ' + ((data && data.error) || '未知错误'), 'error');
    if (container) {
      var st = container.querySelector('#hsStatus');
      if (st) st.textContent = '识别失败: ' + ((data && data.error) || '未知错误');
    }
    return;
  }
  var tplKey = data.tplKey || _templateKey();
  var values = data.values || {};
  _setValues(tplKey, values);
  TileAPI.toast('已识别并填入建议值' + (data.character ? ' (' + data.character + ')' : '') + ', 可手动修改', 'success');
  if (container && tplKey === _templateKey()) _rerender(container);
}

// ========== 生成 ==========
function _doStart(container) {
  var prompt = _buildPrompt();
  if (!prompt) { TileAPI.toast('提示词数据未加载, 请重启插件', 'error'); return; }

  var provider = (container.querySelector('#hsProvider') || {}).value || TileAPI.state.get('params.provider') || 'aji';
  var conn = window._settingsGetActiveConnection ? window._settingsGetActiveConnection(provider) : { provider: provider, url: '', key: '' };
  if (!conn || !conn.key) {
    if (conn && conn._grsKeyPending) TileAPI.toast('正在准备夏算力, 请稍后再试', 'info');
    else if (conn && conn._grsNeedLogin) TileAPI.toast('夏算力托管需要登录 (顶栏账号区), 或切回「自带 Key」', 'error');
    else TileAPI.toast('当前渠道未配置 API Key，请到设置里填写', 'error');
    return;
  }
  if (!conn.url) { TileAPI.toast('当前渠道未配置 API 地址', 'error'); return; }

  var tplKey = _templateKey();
  var tpl = _prompts()[tplKey];
  var model = (container.querySelector('#hsModel') || {}).value || '';
  var size = (container.querySelector('#hsSize') || {}).value || '2K';
  var aspectRatio = (container.querySelector('#hsAspect') || {}).value || 'Auto';
  var batch = parseInt((container.querySelector('#hsBatch') || {}).value, 10) || 1;
  var timeout = 3600;
  var taskId = 'hemi_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  var realProvider = conn.provider || provider;

  // 参考图: 开关开着才带 (与单图生成同源, 读参考图磁贴的全局列表)
  var refImages = (TileAPI.storage.get('hemisynth.useRefs') === true)
    ? (TileAPI.state.get('refimages.list') || []) : [];

  // 自动传回: 尊重设置里的全局开关(与单图生成同一把)
  var autoReturn = TileAPI.storage.get('output.autoReturn');
  if (autoReturn === null || autoReturn === undefined) autoReturn = true;

  TileAPI.sendToHost('hemisynthTask', {
    taskId: taskId, apiKey: conn.key, apiBaseUrl: conn.url, provider: realProvider,
    model: model, size: size, aspectRatio: aspectRatio, prompt: prompt,
    batchSize: batch, timeout: timeout, groupName: tpl.groupName || '半合成',
    refImages: refImages
  });
  if (!autoReturn) {
    TileAPI.sendToHost('setTaskAutoReturn', { taskId: taskId, autoReturn: false });
  }

  // 接入任务队列 (同 tile-kao)
  var running = TileAPI.state.get('tasks.running') || {};
  running[taskId] = {
    engine: 'hemisynth', provider: realProvider, batchSize: batch, startTime: Date.now(),
    success: 0, fail: 0, total: batch, model: model,
    presetTitle: tpl.label, promptSnippet: '半合成 · ' + tpl.label,
    thumbnail: null, docId: null, selection: null, resolution: size
  };
  TileAPI.state.set('tasks.running', running);
  var meta = TileAPI.state.get('tasks.meta') || {};
  meta[taskId] = { countdown: timeout, timeoutSec: timeout, autoReturn: !!autoReturn, batchSize: batch };
  TileAPI.state.set('tasks.meta', meta);
  TileAPI.emit('tasks:updated');
  TileAPI.emit('task:started', { taskId: taskId, timeoutSec: timeout, batchSize: batch });
  TileAPI.emit('generate:started', { taskId: taskId, engine: 'hemisynth', model: model, batch: batch, text: '半合成 · ' + tpl.label });

  _taskIds.push(taskId);
  _runningCount++;
  TileAPI.toast(tpl.label + ' 已提交', 'success');
  var st = container.querySelector('#hsStatus');
  if (st) st.textContent = '已提交 (' + tpl.label + '), 详见任务磁贴 / 对话式生成';
}

// ========== 完成结算 (同 tile-kao 双保险: 全局事件按 taskId 过滤) ==========
function _finishOne(taskId) {
  if (taskId) {
    var idx = _taskIds.indexOf(taskId);
    if (idx === -1) return;   // 不是本磁贴的任务
    _taskIds.splice(idx, 1);
  }
  _runningCount--;
  if (_runningCount < 0) _runningCount = 0;
  if (_activeContainer) {
    var st = _activeContainer.querySelector('#hsStatus');
    if (st) st.textContent = _runningCount > 0 ? ('进行中 ' + _runningCount + ' 个任务') : '任务完成, 详见对话式生成 / 历史';
  }
}
function _onGenComplete(data) {
  if (!data || !data.taskId) return;
  _finishOne(data.taskId);
}

// ========== Tile Registration ==========
TileAPI.registerTile({
  id: 'hemisynth',
  group: 'main',
  icon: '🎪',
  label: '半合成',
  desc: '布景/地台/垂悬环绕',
  live: false,
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  onExpand: function(container, sizeHint) {
    _activeContainer = container;
    _renderLayout(container);
    _afterRender(container);
    // 参考图磁贴增删图 → 刷新"已带 N 张"提示
    var _onRefsChanged = function() {
      var descEl = container.querySelector('#hsRefDesc');
      if (!descEl) return;
      var n = (TileAPI.state.get('refimages.list') || []).length;
      descEl.textContent = n ? '已带 ' + n + ' 张 (随生成一起发给 AI)' : '无 · 到「参考图」磁贴用 PS 选区抓取';
    };
    TileAPI.on('refimages:updated', _onRefsChanged);
    return function() { _activeContainer = null; TileAPI.off('refimages:updated', _onRefsChanged); };
  },

  onMessage: function(action, data) {
    if (action === 'hemisynthAutoResult') { _onAutoResult(data); return; }
    if (action === 'hemisynthComplete' && data) {
      if (data.error) TileAPI.toast('半合成失败: ' + data.error, 'error');
      // 计数由 generate:complete 按 taskId 结算, 这里只报错误
    }
  },

  onStorageLoaded: function(storage) {
    // 默认 expandMode = full (本磁贴默认全屏展开, 同 tile-kao)
    var modes = storage.get('__tile_expand_modes') || {};
    if (!modes['hemisynth']) {
      modes['hemisynth'] = 'full';
      storage.set('__tile_expand_modes', modes);
    }
  }
});

// generate:complete 模块级常驻监听 (关闭面板后完成的任务也要结算, 同 tile-kao #14)
TileAPI.on('generate:complete', _onGenComplete);

})();
