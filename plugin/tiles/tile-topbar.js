/**
 * tile-topbar.js — 顶栏锁定磁贴 (4x1, pinTop)
 *
 * 整合: 余额 (老 tile-balance) + 连接设置 (老 tile-settings 内)
 *
 * 收纳态 (4x1 一行):
 *   AJI $1.23  ·  GRS 1.2k
 *
 * 展开态 (inline-expand 向下挤压):
 *   - 算力配置 (Provider: AJI/GRS/Others/墨墨 + 各家 Key/地址配置)
 *   - 算力槽位自定义
 *
 * 原版的账号 / 积分 / 卡密充值 / 云 Forge / 公告 / 客服 / 找回密码 / 登录态已整块删除
 * (见 docs/去云化评估.md §3.1)。现在只有「自带 Key 直连」一种模式, 不需要登录。
 */
(function() {
'use strict';

var _netConfig = window.WheelchairServerConfig;

// ============================================================
//  内部状态
// ============================================================
var _activeContainer = null;     // 当前展开的 panel container
var _queryingAji = false;
var _queryingGrs = false;
var _grsRefreshLastTs = 0;       // GRS BYOK 自动刷新节流时间戳

// 算力槽位内置标签 (移到文件顶部,避免 hoisting 导致 _computeAjiStat 等函数访问时为 undefined)
var _SLOT_ENG_LABEL = { aji: 'AJI', grs: 'GRS', others: '自定义渠道', momo: '墨墨' };
var _slotsExpanded = false;   // 算力槽位自定义区域默认折叠,点标题展开

// GRS 模型显示名
var GRS_MODEL_NAMES = {
  'nano-banana-2': 'Banana-2',
  'nano-banana-fast': 'Banana-Fast',
  'nano-banana': 'Banana',
  'nano-banana-pro': 'Pro',
  'nano-banana-pro-vt': 'Pro-VT',
  'nano-banana-pro-cl': 'Pro-CL',
  'nano-banana-pro-vip': 'Pro-VIP',
  'nano-banana-pro-4k-vip': 'Pro-4K-VIP',
  'gpt-image-2': 'GPT-Image-2'
};

// ============================================================
//  工具函数
// ============================================================
function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _currentProvider() {
  return TileAPI.getProvider ? TileAPI.getProvider() : (TileAPI.state.get('params.provider') || TileAPI.storage.get('params.provider') || TileAPI.storage.get('connection.provider') || 'aji');
}

function _getBal() {
  var v = TileAPI.state.get('balance.current');
  return (v === null || v === undefined) ? -1 : v;
}
function _getCredits() {
  // 只有自带 Key 模式: 直查用户自己的 GRS 账户
  var v = TileAPI.state.get('grs.credits');
  return (v === null || v === undefined) ? -1 : v;
}
function _shortBal(v) {
  if (v === null || v === undefined || v < 0) return '--';
  return '$' + v.toFixed(2);
}
function _shortCredits(v) {
  if (v === null || v === undefined || v < 0) return '--';
  if (v >= 10000) return (v / 1000).toFixed(1) + 'k';
  return String(v);
}
function _getThresholdAji() {
  var v = TileAPI.storage.get('balance.threshold.aji');
  if (v === null || v === undefined || v === '') v = TileAPI.storage.get('balance.threshold');
  if (v === null || v === undefined || v === '') return 0.5;
  return parseFloat(v) || 0.5;
}
function _getThresholdGrs() {
  var v = TileAPI.storage.get('balance.threshold.grs');
  if (v === null || v === undefined || v === '') return 100;
  return parseFloat(v) || 100;
}
function _isLowAji(bal) {
  if (bal < 0) return false;
  return bal < _getThresholdAji();
}
function _isLowGrs(c) {
  if (c < 0) return false;
  return c < _getThresholdGrs();
}

function _ajiConfigured() {
  return !!(TileAPI.storage.get('connection.aji.url') && TileAPI.storage.get('connection.aji.key'));
}
function _grsConfigured() {
  return !!(TileAPI.storage.get('connection.grs.url') && TileAPI.storage.get('connection.grs.key'));
}

// ============================================================
//  通用 helpers (异步按钮兜底 / 眼睛切换 / 跳转闪烁)
// ============================================================

// 异步按钮 30s timeout 兜底: 调用方在 sendToHost 前调一次, 拿 done 函数;
// 收到 result 后调 done() 主动恢复; 30s 内 result 没回, 自动恢复 + toast 提示
function _asyncBtnGuard(btn, loadingText, timeoutMs) {
  if (!btn) return function() {};
  var orig = btn.textContent;
  var origDisabled = btn.disabled;
  btn.disabled = true;
  btn.classList.add('w10-btn-loading');
  btn.textContent = loadingText || '处理中...';
  var done = false;
  var timer = setTimeout(function() {
    if (done) return;
    done = true;
    btn.disabled = origDisabled;
    btn.classList.remove('w10-btn-loading');
    btn.textContent = orig;
    try { TileAPI.toast('请求超时, 请重试', 'warn'); } catch(_) {}
  }, timeoutMs || 30000);
  return function finishGuard() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    btn.disabled = origDisabled;
    btn.classList.remove('w10-btn-loading');
    btn.textContent = orig;
  };
}

// 眼睛 icon 切换 (password ↔ text + icon 切 👁/🙈) — 全局统一实现
function _setupEyeToggle(eyeBtn, inputEl) {
  if (!eyeBtn || !inputEl || eyeBtn._eyeBound) return;
  eyeBtn._eyeBound = true;
  _on(eyeBtn, 'click', function() {
    var isPw = inputEl.type === 'password';
    inputEl.type = isPw ? 'text' : 'password';
    eyeBtn.textContent = isPw ? '🙈' : '👁';
  });
}

// 滚动到元素 + 闪烁高亮 + 可选 focus — 用于"收纳态点 ⚙ 跳到对应输入框"
function _scrollAndFlash(el, focus) {
  if (!el) return;
  try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  catch(_) { try { el.scrollIntoView(); } catch(__) {} }
  setTimeout(function() {
    el.classList.add('topbar-jump-highlight');
    setTimeout(function() { el.classList.remove('topbar-jump-highlight'); }, 1300);
    if (focus && typeof el.focus === 'function') {
      try { el.focus(); } catch(_) {}
    }
  }, 250);
}

// ============================================================
//  数据查询 (从老 tile-balance 搬过来)
// ============================================================
function _autoQueryAll(silent) {
  if (_ajiConfigured() && !_queryingAji) {
    _queryingAji = true;
    TileAPI.sendToHost('calibrateBalance', {
      apiKey: TileAPI.storage.get('connection.aji.key'),
      apiBaseUrl: TileAPI.storage.get('connection.aji.url'),
      silent: !!silent
    });
  }
  if (_grsConfigured() && !_queryingGrs) {
    _queryingGrs = true;
    TileAPI.sendToHost('grsCheckCredits', {
      apiKey: TileAPI.storage.get('connection.grs.key'),
      baseUrl: TileAPI.storage.get('connection.grs.url')
    });
  }
  if (!silent) TileAPI.toast('正在查询余额...', 'info');
}

// ============================================================
//  收纳态 (一行横排)
// ============================================================
// ============================================================
//  收纳态状态机 — 每个槽位根据 (loggedIn, configured, hasData, low) 自适应
// ============================================================

// 计算单个 stat 的展示信息: { html, classNames, jumpTo }
// jumpTo: 'aji' | 'grs' | null
// #1: AJI 剩余张数预估 = 余额 ÷ 当前模型当前分辨率单价, 向下取整. 无价格公式则退回显示金额
function _ajiSheetsText(bal) {
  try {
    var model = TileAPI.state.get('params.model');
    var size = TileAPI.state.get('params.size');
    var cfg = TileAPI.state.get('models.aji') || {};
    var mc = model && cfg[model];
    var price = mc && mc.prices && mc.prices[size];
    if (price && price > 0 && bal > 0) return Math.floor(bal / price) + '张';
  } catch (_) {}
  return _shortBal(bal);
}

function _computeAjiStat() {
  // AJI 只需用户自己的 Key
  var configured = _ajiConfigured();
  var bal = _getBal();
  if (!configured) {
    return { html: '<span class="topbar-stat-label">' + _esc(_slotName('aji')) + '</span> <span class="topbar-stat-val">⚙</span>',
             cls: 'is-clickable is-warn', jumpTo: 'aji' };
  }
  if (bal < 0) {
    return { html: '<span class="topbar-stat-label">' + _esc(_slotName('aji')) + '</span> <span class="topbar-stat-val">!</span>',
             cls: 'is-clickable is-warn', jumpTo: 'aji' };
  }
  var lowCls = _isLowAji(bal) ? ' is-low' : '';
  return { html: '<span class="topbar-stat-label">' + _esc(_slotName('aji')) + '</span> <span class="topbar-stat-val">' + _ajiSheetsText(bal) + '</span>',
           cls: 'is-clickable' + lowCls, jumpTo: 'aji' };
}

function _computeGrsStat() {
  var credits = _getCredits();
  var custom = _slotName('grs');
  var customized = custom !== (_SLOT_ENG_LABEL.grs || 'grs');
  var label = customized ? custom : 'GRS';

  // 只有自带 Key 模式: 直连用户自己的 GRS 账户
  if (!_grsConfigured()) {
    return { html: '<span class="topbar-stat-label">' + _esc(label) + '</span> <span class="topbar-stat-val">⚙</span>',
             cls: 'is-clickable is-warn', jumpTo: 'grs' };
  }
  if (credits < 0) {
    return { html: '<span class="topbar-stat-label">' + _esc(label) + '</span> <span class="topbar-stat-val">!</span>',
             cls: 'is-clickable is-warn', jumpTo: 'grs' };
  }
  var lowCls = _isLowGrs(credits) ? ' is-low' : '';
  return { html: '<span class="topbar-stat-label">' + _esc(label) + '</span> <span class="topbar-stat-val">' + _shortCredits(credits) + '</span>',
           cls: 'is-clickable' + lowCls, jumpTo: 'grs' };
}

function _renderFront(container) {
  var aji = _computeAjiStat();
  var grs = _computeGrsStat();

  // AJI / GRS 两格按槽位顺序排 (others 不在收纳条)
  var statSpan = {
    aji: '<span class="topbar-stat ' + aji.cls + '" data-jump="' + aji.jumpTo + '">' + aji.html + '</span>',
    grs: '<span class="topbar-stat ' + grs.cls + '" data-jump="' + grs.jumpTo + '">' + grs.html + '</span>'
  };
  // 兜底: TileAPI.slotOrder 可能在初始化早期不可用,用默认顺序
  var slotOrderFn = (TileAPI && TileAPI.slotOrder) || function() { return ['aji', 'grs', 'others']; };
  var orderedStats = slotOrderFn().filter(function(e) { return e === 'aji' || e === 'grs'; })
    .map(function(e) { return statSpan[e]; }).join('');

  var newHtml =
    '<div class="topbar-summary">' +
      '<span class="topbar-summary-inner">' +
        orderedStats +
      '</span>' +
    '</div>';
  // 注意: ☰ 布局按钮不在这里渲染 — 它由 group-manager 作为 #topbarHost 的独立子元素创建,
  // 跟顶栏 tile 平级, 点击不会冒泡到顶栏 tile (否则会触发顶栏展开), 也不受 live flip 重建影响.

  // 内容没变 → 不动 DOM (避免折叠动画结束时无意义重绘 → transition 抖动)
  if (container._lastFrontHtml === newHtml && container.firstChild) return;
  var hadOld = !!container._lastFrontHtml;   // 首渲不脉冲, 只有"数字变了"才脉冲
  container._lastFrontHtml = newHtml;
  container.innerHTML = newHtml;

  // 数字更新脉冲: 让用户看见"刚刚刷新了"(动画完自动摘类)
  if (hadOld) {
    container.querySelectorAll('.topbar-stat').forEach(function(st) {
      st.classList.add('w10-value-pulse');
      setTimeout(function() { st.classList.remove('w10-value-pulse'); }, 400);
    });
  }

  // 给可点击元素绑跳转 (在收纳行点击 → 展开 + 跳到对应 section/输入框)
  container.querySelectorAll('[data-jump]').forEach(function(el) {
    var jumpTo = el.dataset.jump;
    if (!jumpTo) return;
    _on(el, 'click', function(e) {
      e.stopPropagation();
      _onFrontClick(jumpTo);
    });
  });

  // 窄屏自适应: 内容溢出就切紧凑态; 面板尺寸变化时重新判断 (观察器只装一次)
  if (typeof ResizeObserver !== 'undefined' && !container._topbarFitObserved) {
    container._topbarFitObserved = true;
    try {
      var ro = new ResizeObserver(function() { _applyTopbarFit(container); });
      ro.observe(container);
    } catch (e) {}
  }
  _applyTopbarFit(container);
}

// 铺满布局: 内容均分撑满整行. 仅当面板极窄、连均分都放不下(内容真溢出)时,
// 才把整排等比缩小 (左缘为锚), 避免糊到 ☰ 按钮.
function _applyTopbarFit(container) {
  if (!container) return;
  var inner = container.querySelector('.topbar-summary-inner');
  if (!inner) return;
  inner.style.transform = 'none';           // 先复位再量, 否则 scrollWidth 受上次缩放影响
  var box = inner.clientWidth;              // 可用宽 (= summary 内容宽)
  var content = inner.scrollWidth;          // 子项均分后仍需的真实内容宽
  if (box > 0 && content > box + 1) {
    inner.style.transform = 'scale(' + (box / content).toFixed(4) + ')';
  }
}

// ============================================================
//  布局面板 (☰ 按钮就地展开, 复用 window._layoutModule)
// ============================================================
function _toggleLayoutPanel(btnEl) {
  var panel = document.getElementById('topbarLayoutPanel');
  if (!panel) return;
  var isOpen = panel.classList.contains('is-open');
  if (isOpen) {
    _closeLayoutPanel();
    return;
  }
  if (!window._layoutModule || typeof window._layoutModule.openInto !== 'function') {
    TileAPI.toast('布局模块未就绪', 'warn');
    return;
  }
  panel.style.display = 'block';
  // 强制 reflow 再加 class, 保证 max-height transition 生效
  void panel.offsetHeight;
  panel.classList.add('is-open');
  window._layoutModule.openInto(panel);
  if (btnEl) btnEl.classList.add('is-active');
  else {
    var b = document.getElementById('topbarLayoutBtn');
    if (b) b.classList.add('is-active');
  }
}

function _closeLayoutPanel() {
  var panel = document.getElementById('topbarLayoutPanel');
  if (!panel) return;
  panel.classList.remove('is-open');
  if (window._layoutModule && window._layoutModule.close) window._layoutModule.close();
  var b = document.getElementById('topbarLayoutBtn');
  if (b) b.classList.remove('is-active');
  // 等收起动画结束再 display:none, 不打断 transition
  setTimeout(function() {
    if (!panel.classList.contains('is-open')) {
      panel.style.display = 'none';
      panel.innerHTML = '';
    }
  }, 280);
}

// 收纳行点击 → 触发 expand + 滚动到目标
function _onFrontClick(target) {
  // 已展开 → 直接跳; 否则先 expand, 再延迟跳 (等 panel render)
  function jumpNow() {
    var c = _activeContainer;
    if (!c || !c.isConnected) return;
    if (target === 'aji') {
      _switchPwrTab(c, 'aji');
      var inp = c.querySelector('#topbarInpAjiKey');
      if (inp) _scrollAndFlash(inp, !TileAPI.storage.get('connection.aji.key'));
      return;
    }
    if (target === 'grs') {
      _switchPwrTab(c, 'grs');
      // 缺 Key → 聚焦 Key 输入框
      if (!TileAPI.storage.get('connection.grs.key')) {
        var k = c.querySelector('#topbarInpGrsKey');
        if (k) _scrollAndFlash(k, true);
      } else {
        var pwrSec = c.querySelector('[data-section="power"]');
        if (pwrSec) _scrollAndFlash(pwrSec);
      }
      return;
    }
  }
  if (_activeContainer && _activeContainer.isConnected) {
    jumpNow();
  } else {
    if (TileAPI.expandTile) {
      try { TileAPI.expandTile('topbar'); } catch(_) {}
    }
    setTimeout(jumpNow, 200);
  }
}

function _refreshFront() {
  if (!window.TileEngine) return;
  var el = TileEngine.getTileElement('topbar');
  if (!el) return;
  if (el.classList.contains('panel-mode')) return;
  var inner = el.querySelector('.tile-inner:not(.folder-grid-inner)') || el.querySelector('.tile-flip-front');
  if (inner) _renderFront(inner);
}

// ============================================================
//  展开面板各小节 HTML
// ============================================================
// ============================================================
//  🎛 算力槽位自定义 (阶段1a 编辑面板)
//  读 compute.slots / compute.models(由 tile-params 维护), 列每个引擎的「完整目录」,
//  让用户勾选要显示的模型 + 改全名/短名 + 改格子名 + 隐藏格子。
//  保存 → 写 storage+state + TileAPI.rebuildModelViews() → 主参数磁贴的模型下拉随之精简/改名。
//  注:真实模型 id 与计费/调用无关,改名只是显示。
// ============================================================

// 取某算力槽位的显示名: 用户改过用自定义名, 否则回退内置名。(1b: 顶栏标签/配置标签都走这里)
function _slotName(engine) {
  var slots = TileAPI.state.get('compute.slots') || [];
  for (var i = 0; i < slots.length; i++) {
    if (slots[i] && slots[i].engine === engine) {
      var n = (slots[i].name || '').trim();
      if (n) return n;
      break;
    }
  }
  return _SLOT_ENG_LABEL[engine] || engine;
}

function _slotModelRowsHtml(engine) {
  var full = (TileAPI.getFullCatalog ? TileAPI.getFullCatalog(engine) : {}) || {};
  var models = TileAPI.state.get('compute.models') || {};
  var curated = models[engine];
  var curMap = {}, order = [];
  if (Array.isArray(curated)) {
    curated.forEach(function(it) { if (it && it.id) { curMap[it.id] = it; order.push(it.id); } });
  }
  Object.keys(full).forEach(function(id) { if (order.indexOf(id) === -1) order.push(id); });
  if (!order.length) {
    return '<div style="font-size:11px;color:var(--text-sub);padding:2px 0">（暂无模型；自定义渠道请先在下方「⚡ 算力配置」里拉取模型）</div>';
  }
  var noCuration = !Array.isArray(curated); // 没配过 = 默认全选
  var head = '<div class="slot-row slot-row-head">' +
    '<span></span>' +
    '<span>全名（下拉显示）</span>' +
    '<span>短名（窄处）</span>' +
    '<span>真实ID</span>' +
    '</div>';
  var rows = order.map(function(id) {
    if (!full[id]) return '';
    var it = curMap[id] || {};
    var on = noCuration ? true : !!curMap[id];
    var builtin = full[id].name || id;
    return '<div class="slot-row">' +
      '<input class="slot-chk" type="checkbox" data-slot-model="' + engine + '" data-mid="' + _esc(id) + '"' + (on ? ' checked' : '') + '>' +
      '<input class="w10-input" data-slotfull="' + engine + '" data-mid="' + _esc(id) + '" value="' + _esc(it.full || '') + '" placeholder="' + _esc(builtin) + '" title="全名（模型下拉里显示）">' +
      '<input class="w10-input" data-slotshort="' + engine + '" data-mid="' + _esc(id) + '" value="' + _esc(it.short || '') + '" placeholder="短名" title="缩略名（窄处显示）">' +
      '<span class="slot-row-id" title="真实ID（不可改）：' + _esc(id) + '">' + _esc(id) + '</span>' +
    '</div>';
  }).join('');
  return head + rows;
}

function _sectionSlots() {
  var slots = TileAPI.state.get('compute.slots') || [];
  var cards = slots.map(function(s, idx) {
    var engine = s.engine;
    // 第 4 格(idx>=3)默认不显示在顶栏/参数里, 加一条分隔提示
    var divider = (idx === 3)
      ? '<div class="slot-hidden-divider">— 以下不显示在顶栏/参数(用 ▲ 移上去即可启用)—</div>'
      : '';
    return divider + '<div class="slot-card' + (idx >= 3 ? ' slot-card-hidden' : '') + '" data-slot-engine="' + engine + '">' +
      '<div class="slot-card-head">' +
        '<span class="slot-card-eng">' + _esc(_SLOT_ENG_LABEL[engine] || engine) + (idx >= 3 ? ' <span style="color:var(--text-sub);font-weight:normal">(隐藏)</span>' : '') + '</span>' +
        '<input class="w10-input slot-card-name" data-slotname="' + engine + '" value="' + _esc(s.name || '') + '" placeholder="' + _esc(_SLOT_ENG_LABEL[engine] || engine) + '（格子显示名）" title="顶栏格子显示名">' +
        '<span class="slot-card-move">' +
          '<button class="slot-move-btn" data-slot-up="' + engine + '" title="上移（排前面）">▲</button>' +
          '<button class="slot-move-btn" data-slot-down="' + engine + '" title="下移（排后面）">▼</button>' +
        '</span>' +
      '</div>' +
      '<div class="slot-models">' + _slotModelRowsHtml(engine) + '</div>' +
    '</div>';
  }).join('');
  return '' +
    '<div data-section="slots">' +
    '<div class="w10-section-title slot-section-toggle" id="topbarSlotsToggle" style="cursor:pointer;user-select:none;">' +
      '<span class="slot-toggle-arrow">' + (_slotsExpanded ? '▾' : '▸') + '</span> 🎛 算力槽位自定义' +
    '</div>' +
    '<div class="slot-body"' + (_slotsExpanded ? '' : ' style="display:none"') + '>' +
      '<div class="slot-intro">顶栏/参数只显示<b>前 3 个</b>算力格子;用 ▲▼ 调顺序,排进前 3 就显示,第 4 个自动隐藏。勾选要在模型下拉里显示的模型;可改「全名 / 短名」与格子显示名。真实ID 与计费、出图都不受影响。</div>' +
      cards +
      '<div class="slot-actions">' +
        '<button class="w10-btn" id="topbarBtnSlotsReset">恢复默认</button>' +
        '<button class="w10-btn w10-btn-accent" id="topbarBtnSlotsSave">保存</button>' +
      '</div>' +
    '</div>' +
    '</div>';
}

// 当前选中模型若因精简而消失 → 回退到该引擎第一个可用模型
function _ensureSelectedModelValid() {
  var prov = _currentProvider();
  var view = TileAPI.state.get('models.' + prov) || {};
  var cur = TileAPI.state.get('params.model');
  if (!cur || !view[cur]) {
    var first = Object.keys(view)[0] || '';
    TileAPI.state.set('params.model', first);
    TileAPI.storage.set('params.model', first);
  }
}

function _bindSlotsEditor(container) {
  // 折叠/展开切换 (默认折叠)
  var toggle = container.querySelector('#topbarSlotsToggle');
  if (toggle) _on(toggle, 'click', function() {
    _slotsExpanded = !_slotsExpanded;
    _renderSection('slots', container);
  });
  var saveBtn = container.querySelector('#topbarBtnSlotsSave');
  if (saveBtn) _on(saveBtn, 'click', function() {
    // 按卡片在 DOM 里的当前顺序读 → ▲▼ 调的序生效;同时读各格显示名
    var slots = [];
    container.querySelectorAll('.slot-card[data-slot-engine]').forEach(function(card) {
      var engine = card.getAttribute('data-slot-engine');
      var nameEl = card.querySelector('[data-slotname="' + engine + '"]');
      slots.push({ engine: engine, name: (nameEl && nameEl.value || '').trim().replace(/[<>]/g, '') }); // 去尖括号: 名字会进 HTML 文本
    });
    // 读每引擎模型勾选+改名(按 DOM 顺序)
    var models = {};
    ['aji', 'grs', 'momo', 'others'].forEach(function(engine) {
      var full = (TileAPI.getFullCatalog ? TileAPI.getFullCatalog(engine) : {}) || {};
      var list = [];
      container.querySelectorAll('[data-slot-model="' + engine + '"]').forEach(function(chk) {
        if (!chk.checked) return;
        var id = chk.getAttribute('data-mid');
        if (!full[id]) return;
        var fEl = container.querySelector('[data-slotfull="' + engine + '"][data-mid="' + id + '"]');
        var sEl = container.querySelector('[data-slotshort="' + engine + '"][data-mid="' + id + '"]');
        list.push({ id: id, full: (fEl && fEl.value || '').trim().replace(/[<>]/g, ''), short: (sEl && sEl.value || '').trim().replace(/[<>]/g, '') });
      });
      models[engine] = list;
    });
    // 校验:只对「有完整目录」的算力要求至少勾 1 个模型;
    // 自定义渠道(others)没拉过模型时完整目录为空 → 跳过,不强制(否则只想改 aji/grs 也会被卡住)
    var bad = slots.filter(function(s) {
      var full = (TileAPI.getFullCatalog ? TileAPI.getFullCatalog(s.engine) : {}) || {};
      if (!Object.keys(full).length) return false; // 该算力本就没模型可勾,放行
      return !models[s.engine] || !models[s.engine].length;
    });
    if (bad.length) { TileAPI.toast('「' + (_SLOT_ENG_LABEL[bad[0].engine] || bad[0].engine) + '」一个模型都没勾,至少留 1 个', 'error'); return; }
    TileAPI.storage.set('compute.slots', slots);
    TileAPI.storage.set('compute.models', models);
    TileAPI.state.set('compute.slots', slots);
    TileAPI.state.set('compute.models', models);
    if (TileAPI.rebuildModelViews) TileAPI.rebuildModelViews();
    _ensureSelectedModelValid();
    TileAPI.toast('算力槽位已保存', 'success');
    _refreshFront();
    _renderSection('slots', container);
    _renderSection('power', container);
    TileAPI.emit('params:providerChanged', { provider: _currentProvider() });
    // 即时刷新所有带算力选择的磁贴(顺序/改名/精简立刻生效,不用手动调大小)
    if (window.TileEngine && window.TileEngine.rerenderTiles) {
      window.TileEngine.rerenderTiles(['params', 'camera', 'light', 'colorgrade', 'kao', 'tiled', 'scene', 'poster']);
    }
  });
  var resetBtn = container.querySelector('#topbarBtnSlotsReset');
  if (resetBtn) _on(resetBtn, 'click', function() {
    TileAPI.confirm('恢复到默认(全部模型显示、用内置名、格子名复原)?').then(function(ok) {
      if (!ok) return;
      var slots = ['aji', 'grs', 'momo', 'others'].map(function(e) { return { engine: e, name: '' }; });
      TileAPI.storage.set('compute.slots', slots);
      TileAPI.storage.set('compute.models', {});
      TileAPI.state.set('compute.slots', slots);
      TileAPI.state.set('compute.models', {});
      if (TileAPI.rebuildModelViews) TileAPI.rebuildModelViews();
      _ensureSelectedModelValid();
      TileAPI.toast('已恢复默认', 'success');
      _refreshFront();
      _renderSection('slots', container);
      _renderSection('power', container);
      TileAPI.emit('params:providerChanged', { provider: _currentProvider() });
      if (window.TileEngine && window.TileEngine.rerenderTiles) {
        window.TileEngine.rerenderTiles(['params', 'camera', 'light', 'colorgrade', 'kao', 'tiled', 'scene', 'poster']);
      }
    });
  });
  // ▲▼ 调整算力顺序: 直接移动卡片 DOM 节点(保留已输入但未保存的名字/勾选), 保存时按卡片顺序落盘
  function _moveCard(engine, dir) {
    var card = container.querySelector('.slot-card[data-slot-engine="' + engine + '"]');
    if (!card) return;
    // 跳过中间的「不显示」分隔条, 只在算力卡片之间移动
    function _prevCard(el) { var p = el.previousElementSibling; while (p && !p.classList.contains('slot-card')) p = p.previousElementSibling; return p; }
    function _nextCard(el) { var n = el.nextElementSibling; while (n && !n.classList.contains('slot-card')) n = n.nextElementSibling; return n; }
    if (dir < 0) {
      var prev = _prevCard(card);
      if (prev) card.parentNode.insertBefore(card, prev);
    } else {
      var next = _nextCard(card);
      if (next) card.parentNode.insertBefore(next, card);
    }
  }
  container.querySelectorAll('[data-slot-up]').forEach(function(b) {
    _on(b, 'click', function() { _moveCard(b.getAttribute('data-slot-up'), -1); });
  });
  container.querySelectorAll('[data-slot-down]').forEach(function(b) {
    _on(b, 'click', function() { _moveCard(b.getAttribute('data-slot-down'), 1); });
  });
}

function _sectionPower() {
  // 算力配置只需要用户自己的 Key (AJI / GRS / Others / 墨墨), 不需要登录
  var provider = _currentProvider();

  // 同步 Others 多配置 (老 tile-settings 的迁移逻辑, 保留)
  var _othersConfigs = TileAPI.storage.get('connection.others.configs');
  if (!Array.isArray(_othersConfigs) || _othersConfigs.length === 0) {
    var _oldUrl = TileAPI.storage.get('connection.others.url') || '';
    var _oldKey = TileAPI.storage.get('connection.others.key') || '';
    _othersConfigs = [{
      name: '默认', url: _oldUrl, key: _oldKey, isActive: true,
      models: TileAPI.storage.get('models.others.cache') || {}
    }];
    TileAPI.storage.set('connection.others.configs', _othersConfigs);
  }
  var _activeOthersCfg = null;
  for (var _ci = 0; _ci < _othersConfigs.length; _ci++) {
    if (_othersConfigs[_ci].isActive) { _activeOthersCfg = _othersConfigs[_ci]; break; }
  }
  if (!_activeOthersCfg && _othersConfigs.length) _activeOthersCfg = _othersConfigs[0];

  var bal = _getBal();
  var credits = _getCredits();
  var ajiBalText = bal >= 0 ? ('余额 $' + bal.toFixed(2)) : '(尚未查询)';
  var grsByokBalText = (credits >= 0) ? ('余额 ' + _shortCredits(credits)) : '(尚未查询)';

  return '' +
    '<div data-section="power">' +
    '<div class="w10-section-title">⚡ 算力配置</div>' +

    '<div class="topbar-pwr-tabs">' +
      ((TileAPI && TileAPI.slotOrderAll) || function() { return ['aji', 'grs', 'momo', 'others']; })().map(function(eng) {
        return '<span class="topbar-pwr-tab' + (provider === eng ? ' is-active' : '') + '" data-pwr="' + eng + '">' + _esc(_slotName(eng)) + '</span>';
      }).join('') +
    '</div>' +

    // ===== AJI panel =====
    '<div class="topbar-pwr-panel" data-panel="aji"' + (provider === 'aji' ? '' : ' style="display:none"') + '>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">AJI Key</div></div>' +
        '<div class="w10-row-right" style="display:flex;align-items:center;gap:4px;">' +
          '<input class="w10-input" id="topbarInpAjiKey" type="password" value="' + _esc(TileAPI.storage.get('connection.aji.key') || '') + '" style="width:170px" placeholder="粘贴 Key 自动校验">' +
          '<span class="key-eye-btn" data-target="topbarInpAjiKey" style="cursor:pointer;user-select:none;">👁</span>' +
        '</div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left" style="flex:1"><div class="w10-row-desc" id="topbarAjiValidateStatus" style="font-size:11px;line-height:1.6;">' +
          (function() {
            var key = TileAPI.storage.get('connection.aji.key') || '';
            var url = TileAPI.storage.get('connection.aji.url') || '';
            if (!key) return '<span style="color:var(--text-sub)">请先填入 AJI Key</span>';
            if (key && url) return '<span style="color:#69f0ae">✓ 已校验 → ' + _esc(url) + ' · ' + _esc(ajiBalText) + '</span>';
            return '<span style="color:#ff9800">⚠ 未校验, 点击右侧按钮触发</span>';
          })() +
        '</div></div>' +
        '<div class="w10-row-right"><button class="w10-btn" id="topbarBtnAjiValidate">校验 Key</button></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left" style="flex:1"><div class="w10-row-desc" style="font-size:11px;color:var(--text-sub);line-height:1.6;">' +
          '📮 购买渠道: <span style="color:var(--text);user-select:text;">QQ770466704</span><br>' +
          '🔒 AJI 服务器地址由系统自动选择, 无需手动填写' +
        '</div></div>' +
      '</div>' +
    '</div>' +

    // ===== GRS panel (自带 Key 直连 + 余额) =====
    '<div class="topbar-pwr-panel" data-panel="grs"' + (provider === 'grs' ? '' : ' style="display:none"') + '>' +
      '<div id="topbarGrsByokBlock">' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">GRS 地址</div></div>' +
          '<div class="w10-row-right">' +
            (function() {
              var savedUrl = TileAPI.storage.get('connection.grs.url') || '';
              var preset1 = 'https://grsai.dakka.com.cn';
              var preset2 = 'https://grsaiapi.com';
              var sel = '__preset1';
              if (savedUrl === preset2) sel = '__preset2';
              else if (savedUrl && savedUrl !== preset1) sel = '__custom';
              return '<select class="w10-select" id="topbarSelGrsUrl" style="width:200px">' +
                '<option value="' + preset1 + '"' + (sel === '__preset1' ? ' selected' : '') + '>🇨🇳 国内直连</option>' +
                '<option value="' + preset2 + '"' + (sel === '__preset2' ? ' selected' : '') + '>🌐 海外</option>' +
                '<option value="__custom"' + (sel === '__custom' ? ' selected' : '') + '>自定义...</option>' +
                '</select>';
            })() +
          '</div>' +
        '</div>' +
        '<div class="w10-row" id="topbarGrsCustomRow"' + ((TileAPI.storage.get('connection.grs.url') && TileAPI.storage.get('connection.grs.url') !== 'https://grsai.dakka.com.cn' && TileAPI.storage.get('connection.grs.url') !== 'https://grsaiapi.com') ? '' : ' style="display:none"') + '>' +
          '<div class="w10-row-left"><div class="w10-row-label">自定义 URL</div></div>' +
          '<div class="w10-row-right"><input class="w10-input" id="topbarInpGrsUrl" type="text" value="' + _esc(TileAPI.storage.get('connection.grs.url') || '') + '" style="width:200px"></div>' +
        '</div>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">GRS Key</div></div>' +
          '<div class="w10-row-right" style="display:flex;align-items:center;gap:4px;">' +
            '<input class="w10-input" id="topbarInpGrsKey" type="password" value="' + _esc(TileAPI.storage.get('connection.grs.key') || '') + '" style="width:170px" placeholder="粘贴 Key 自动查询">' +
            '<span class="key-eye-btn" data-target="topbarInpGrsKey" style="cursor:pointer;user-select:none;">👁</span>' +
          '</div>' +
        '</div>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">余额</div></div>' +
          '<div class="w10-row-right" style="display:flex;align-items:center;gap:6px;">' +
            '<span id="topbarGrsCreditsStatus" style="font-size:11px;color:' + (_isLowGrs(credits) ? '#ff7a7a' : 'var(--text-sub)') + '">' + _esc(grsByokBalText) + '</span>' +
            '<button class="w10-btn" id="topbarBtnGrsCheck">🔄 重新查询</button>' +
          '</div>' +
        '</div>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left" style="flex:1"><div class="w10-row-desc" style="font-size:11px;color:var(--text-sub);line-height:1.6;">📮 购买渠道:需要使用魔法访问 <b style="color:var(--text)">https://grsai.ai/zh</b></div></div>' +
        '</div>' +
      '</div>' +
    '</div>' +

    // ===== 自定义渠道 panel =====
    '<div class="topbar-pwr-panel" data-panel="others"' + (provider === 'others' ? '' : ' style="display:none"') + '>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">配置方案</div></div>' +
        '<div class="w10-row-right" style="display:flex;gap:4px;flex-wrap:wrap;">' +
          '<select class="w10-select" id="topbarOthersConfigSelect" style="flex:1;min-width:100px;"></select>' +
          '<button class="w10-btn" id="topbarBtnOthersConfigAdd" title="新建">+</button>' +
          '<button class="w10-btn" id="topbarBtnOthersConfigDel" title="删除当前" style="color:#ff6b6b;">×</button>' +
        '</div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">URL</div></div>' +
        '<div class="w10-row-right"><input class="w10-input" id="topbarInpOthersUrl" type="text" value="' + _esc(_activeOthersCfg ? _activeOthersCfg.url : '') + '" style="width:200px"></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">Key</div></div>' +
        '<div class="w10-row-right" style="display:flex;align-items:center;gap:4px;">' +
          '<input class="w10-input" id="topbarInpOthersKey" type="password" value="' + _esc(_activeOthersCfg ? _activeOthersCfg.key : '') + '" style="width:200px">' +
          '<span class="key-eye-btn" data-target="topbarInpOthersKey" style="cursor:pointer;user-select:none;">👁</span>' +
        '</div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">模型列表</div><div class="w10-row-desc">从此 URL 拉取可用模型(过滤为图像类)</div></div>' +
        '<div class="w10-row-right">' +
          '<button class="w10-btn w10-btn-accent" id="topbarBtnOthersFetchModels">拉取模型</button>' +
          '<span id="topbarOthersFetchStatus" style="font-size:10px;color:var(--text-sub);margin-left:6px"></span>' +
        '</div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">额度查询</div></div>' +
        '<div class="w10-row-right">' +
          '<button class="w10-btn" id="topbarBtnOthersQuota">查询</button>' +
          '<span id="topbarOthersQuotaStatus" style="font-size:10px;color:var(--text-sub)"></span>' +
        '</div>' +
      '</div>' +
    '</div>' +

    // ===== 墨墨(momo) panel — 同款中转站, URL 嵌死, 只填 Key =====
    '<div class="topbar-pwr-panel" data-panel="momo"' + (provider === 'momo' ? '' : ' style="display:none"') + '>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">墨墨 Key</div></div>' +
        '<div class="w10-row-right" style="display:flex;align-items:center;gap:4px;">' +
          '<input class="w10-input" id="topbarInpMomoKey" type="password" value="' + _esc(TileAPI.storage.get('connection.momo.key') || '') + '" style="width:200px" placeholder="粘贴墨墨 Key (sk-...)">' +
          '<span class="key-eye-btn" data-target="topbarInpMomoKey" style="cursor:pointer;user-select:none;">👁</span>' +
        '</div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">模型列表</div><div class="w10-row-desc">从墨墨拉取可用模型(过滤为图像类)</div></div>' +
        '<div class="w10-row-right">' +
          '<button class="w10-btn w10-btn-accent" id="topbarBtnMomoFetchModels">拉取模型</button>' +
          '<span id="topbarMomoFetchStatus" style="font-size:10px;color:var(--text-sub);margin-left:6px"></span>' +
        '</div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">额度查询</div></div>' +
        '<div class="w10-row-right">' +
          '<button class="w10-btn" id="topbarBtnMomoQuota">查询</button>' +
          '<span id="topbarMomoQuotaStatus" style="font-size:10px;color:var(--text-sub);margin-left:6px"></span>' +
        '</div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">购买额度</div><div class="w10-row-desc">在浏览器/淘宝中打开购买页</div></div>' +
        '<div class="w10-row-right">' +
          '<a class="topbar-link" id="topbarMomoBuyLink" style="cursor:pointer;">🛒 ' + _esc(_momoBuyTitle()) + ' →</a>' +
        '</div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">联系方式</div></div>' +
        '<div class="w10-row-right"><span style="user-select:text;color:var(--text)">QQ: 2998690071</span></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left" style="flex:1"><div class="w10-row-desc" style="font-size:11px;color:var(--text-sub);line-height:1.6;">' +
          '🔒 墨墨服务器地址已内置 (https://api.momoapi.icu), 无需填写<br>' +
          '🧾 消费/账单请到「算力账单」磁贴查看' +
        '</div></div>' +
      '</div>' +
    '</div>' +
    '</div>';
}

// ============================================================
//  展开面板组装
// ============================================================
function _renderPanel(container) {
  _activeContainer = container;
  container.innerHTML =
    '<div class="w10-panel topbar-panel">' +
      _sectionPower() +       // ⚡算力配置 (只需用户自己的 Key)
      _sectionSlots() +       // 🎛 算力槽位自定义
    '</div>';
  _bindEvents(container);
}

function _refreshPanel() {
  if (_activeContainer && _activeContainer.isConnected) _renderPanel(_activeContainer);
}

// ============================================================
//  局部刷新: 只重渲指定 section, 不动其他 (保留输入焦点/滚动位置)
// ============================================================
var _sectionRenderers = {
  power: _sectionPower,
  slots: _sectionSlots
};

function _renderSection(name, container) {
  container = container || _activeContainer;
  if (!container || !container.isConnected) return;
  var oldEl = container.querySelector('[data-section="' + name + '"]');
  var html = _sectionRenderers[name] ? _sectionRenderers[name]() : '';
  if (!oldEl || !html) return;
  var wrap = document.createElement('div');
  wrap.innerHTML = html;
  var newEl = wrap.querySelector('[data-section="' + name + '"]');
  if (newEl) {
    oldEl.parentNode.replaceChild(newEl, oldEl);
    _bindEvents(container);
  }
}

// ============================================================
//  事件绑定
// ============================================================
// 事件去重绑定: 同一元素+同一事件类型, 先拆掉上一次绑的再绑新的, 防止 _bindEvents 反复调用导致监听器叠加
function _on(el, type, fn) {
  if (!el) return;
  var k = '__tbh_' + type;
  if (el[k]) el.removeEventListener(type, el[k]);
  el[k] = fn;
  el.addEventListener(type, fn);
}

function _bindEvents(container) {
  // 🎛 算力槽位自定义 (阶段1a)
  _bindSlotsEditor(container);
  // ===== 算力配置 tabs (替代老的 [data-provider] 按钮组) =====
  container.querySelectorAll('.topbar-pwr-tab').forEach(function(tab) {
    _on(tab, 'click', function() {
      _switchPwrTab(container, tab.dataset.pwr);
    });
  });

  // ===== AJI Key =====
  _bindAjiKeyInput(container);
  var ajiValidate = container.querySelector('#topbarBtnAjiValidate');
  if (ajiValidate) _on(ajiValidate, 'click', function() {
    _validateAjiKey(container, false);
  });

  // ===== GRS URL 下拉 + Key 输入 + 查询 =====
  _bindGrsUrlSelect(container);
  _bindInput(container, 'topbarInpGrsUrl', 'connection.grs.url');
  _bindGrsKeyInput(container);  // S2: 失焦/粘贴自动查询
  var grsCheck = container.querySelector('#topbarBtnGrsCheck');
  if (grsCheck) _on(grsCheck, 'click', function() {
    var url = TileAPI.storage.get('connection.grs.url') || '';
    var key = TileAPI.storage.get('connection.grs.key') || '';
    if (!url || !key) { TileAPI.toast('请先填写 GRS URL 和 Key', 'error'); return; }
    _grsCheckBtnDone = _asyncBtnGuard(grsCheck, '查询中...');
    _queryingGrs = true;
    TileAPI.sendToHost('grsCheckCredits', { apiKey: key, baseUrl: url });
  });

  // ===== Others 配置管理 =====
  _bindOthersInput(container, 'topbarInpOthersUrl', 'connection.others.url', 'url');
  _bindOthersInput(container, 'topbarInpOthersKey', 'connection.others.key', 'key');
  _rebuildOthersConfigSelect(container);

  var sel = container.querySelector('#topbarOthersConfigSelect');
  if (sel) _on(sel, 'change', function() {
    var name = this.value;
    var configs = TileAPI.storage.get('connection.others.configs') || [];
    var found = null;
    for (var i = 0; i < configs.length; i++) {
      configs[i].isActive = configs[i].name === name;
      if (configs[i].isActive) found = configs[i];
    }
    if (found) {
      TileAPI.storage.set('connection.others.configs', configs);
      TileAPI.storage.set('connection.others.url', found.url || '');
      TileAPI.storage.set('connection.others.key', found.key || '');
      var sm = found.models || {};
      TileAPI.state.set('models.others', sm);
      TileAPI.storage.set('models.others.cache', sm);
      TileAPI.emit('params:modelsFetched', { provider: 'others', count: Object.keys(sm).length });
      var urlInp = container.querySelector('#topbarInpOthersUrl');
      var keyInp = container.querySelector('#topbarInpOthersKey');
      if (urlInp) urlInp.value = found.url || '';
      if (keyInp) keyInp.value = found.key || '';
      _refreshOthersFetchStatus(container);
      TileAPI.toast('已切换到: ' + name, 'info');
    }
  });

  var addBtn = container.querySelector('#topbarBtnOthersConfigAdd');
  if (addBtn) _on(addBtn, 'click', function() {
    TileAPI.prompt('输入新配置名称:', '').then(function(name) {
      if (!name) return;
      var configs = TileAPI.storage.get('connection.others.configs') || [];
      for (var i = 0; i < configs.length; i++) {
        if (configs[i].name === name) { TileAPI.toast('配置名已存在', 'error'); return; }
      }
      for (var j = 0; j < configs.length; j++) configs[j].isActive = false;
      configs.push({ name: name, url: '', key: '', isActive: true, models: {} });
      TileAPI.storage.set('connection.others.configs', configs);
      TileAPI.storage.set('connection.others.url', '');
      TileAPI.storage.set('connection.others.key', '');
      TileAPI.state.set('models.others', {});
      TileAPI.storage.set('models.others.cache', {});
      _rebuildOthersConfigSelect(container);
      var urlInp = container.querySelector('#topbarInpOthersUrl');
      var keyInp = container.querySelector('#topbarInpOthersKey');
      if (urlInp) urlInp.value = '';
      if (keyInp) keyInp.value = '';
      _refreshOthersFetchStatus(container);
      TileAPI.toast('已创建配置: ' + name, 'success');
    });
  });

  var delBtn = container.querySelector('#topbarBtnOthersConfigDel');
  if (delBtn) _on(delBtn, 'click', function() {
    var configs = TileAPI.storage.get('connection.others.configs') || [];
    if (configs.length <= 1) { TileAPI.toast('至少保留一个配置', 'error'); return; }
    var activeName = '';
    for (var i = 0; i < configs.length; i++) {
      if (configs[i].isActive) { activeName = configs[i].name; break; }
    }
    TileAPI.confirm('删除配置「' + activeName + '」?').then(function(ok) {
      if (!ok) return;
      var newC = [];
      for (var k = 0; k < configs.length; k++) {
        if (configs[k].name !== activeName) newC.push(configs[k]);
      }
      if (newC.length) newC[0].isActive = true;
      TileAPI.storage.set('connection.others.configs', newC);
      TileAPI.storage.set('connection.others.url', newC[0].url || '');
      TileAPI.storage.set('connection.others.key', newC[0].key || '');
      var nm = newC[0].models || {};
      TileAPI.state.set('models.others', nm);
      TileAPI.storage.set('models.others.cache', nm);
      _rebuildOthersConfigSelect(container);
      var urlInp = container.querySelector('#topbarInpOthersUrl');
      var keyInp = container.querySelector('#topbarInpOthersKey');
      if (urlInp) urlInp.value = newC[0].url || '';
      if (keyInp) keyInp.value = newC[0].key || '';
      _refreshOthersFetchStatus(container);
      TileAPI.toast('已删除: ' + activeName, 'info');
    });
  });

  var fetchBtn = container.querySelector('#topbarBtnOthersFetchModels');
  if (fetchBtn) {
    _refreshOthersFetchStatus(container);
    _on(fetchBtn, 'click', function() {
      _doFetchOthersModels(container, fetchBtn);
    });
  }

  var quotaBtn = container.querySelector('#topbarBtnOthersQuota');
  if (quotaBtn) _on(quotaBtn, 'click', function() {
    var url = TileAPI.storage.get('connection.others.url') || '';
    var key = TileAPI.storage.get('connection.others.key') || '';
    if (!url || !key) { TileAPI.toast('请先填写 URL 和 Key', 'error'); return; }
    var st = container.querySelector('#topbarOthersQuotaStatus');
    if (st) st.textContent = '查询中...';
    TileAPI.sendToHost('checkQuota', { apiKey: key, apiBaseUrl: url });
  });

  // ===== 墨墨(momo) 配置 =====
  var momoKeyInp = container.querySelector('#topbarInpMomoKey');
  if (momoKeyInp) {
    var _saveMomoKey = function() {
      var v = (momoKeyInp.value || '').replace(/\s+/g, '');
      if (momoKeyInp.value !== v) momoKeyInp.value = v;
      TileAPI.storage.set('connection.momo.key', v);
    };
    _on(momoKeyInp, 'change', _saveMomoKey);
    _on(momoKeyInp, 'blur', _saveMomoKey);
  }
  var momoFetchBtn = container.querySelector('#topbarBtnMomoFetchModels');
  if (momoFetchBtn) {
    _refreshMomoFetchStatus(container);
    _on(momoFetchBtn, 'click', function() {
      _doFetchMomoModels(container, momoFetchBtn);
    });
  }
  var momoQuotaBtn = container.querySelector('#topbarBtnMomoQuota');
  if (momoQuotaBtn) _on(momoQuotaBtn, 'click', function() {
    var key = ((container.querySelector('#topbarInpMomoKey') || {}).value || '').replace(/\s+/g, '');
    if (!key) { TileAPI.toast('请先填写墨墨 Key', 'error'); return; }
    TileAPI.storage.set('connection.momo.key', key);
    var st = container.querySelector('#topbarMomoQuotaStatus');
    if (st) st.textContent = '查询中...';
    var rid = 'momoquota_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    _momoQuotaPending[rid] = { container: container };
    TileAPI.sendToHost('checkMomoQuota', { requestId: rid, apiKey: key, apiBaseUrl: MOMO_BASE_URL });
    setTimeout(function() {
      if (_momoQuotaPending[rid]) { delete _momoQuotaPending[rid]; if (st) st.textContent = '查询超时'; }
    }, 15000);
  });
  var momoBuyLink = container.querySelector('#topbarMomoBuyLink');
  if (momoBuyLink) {
    _on(momoBuyLink, 'click', function() {
      TileAPI.sendToHost('openUrl', { url: _momoBuyUrl() });
    });
  }

  // ===== Eye toggles for password inputs =====
  _bindKeyEyeToggles(container);


}

// ============================================================
//  算力配置 tab 切换 — 只切 display, 不重渲, 保留输入状态
// ============================================================
function _switchPwrTab(container, p) {
  if (!p) return;
  container.querySelectorAll('.topbar-pwr-tab').forEach(function(t) {
    t.classList.toggle('is-active', t.dataset.pwr === p);
  });
  container.querySelectorAll('.topbar-pwr-panel').forEach(function(panel) {
    panel.style.display = panel.dataset.panel === p ? '' : 'none';
  });
  if (_currentProvider() === p) return;
  if (TileAPI.setProvider) TileAPI.setProvider(p, { source: 'topbar' });
  else {
    TileAPI.storage.set('params.provider', p);
    TileAPI.storage.set('connection.provider', p);
    TileAPI.state.set('params.provider', p);
    TileAPI.emit('settings:providerChanged', { provider: p });
    TileAPI.emit('params:providerChanged', { provider: p });
  }
}

// ============================================================
//  收纳行: 切换中加 spinner / 切换完成移除
// ============================================================
function _markStatSwitching(on) {
  if (!window.TileEngine) return;
  var el = TileEngine.getTileElement('topbar');
  if (!el) return;
  el.querySelectorAll('.topbar-stat').forEach(function(stat) {
    stat.classList.toggle('is-switching', !!on);
  });
}

// 异步按钮 done 句柄 (在 onMessage 收到对应 result 时调用以恢复)
var _grsCheckBtnDone = null;

// ============================================================
//  绑定辅助函数
// ============================================================
function _bindInput(container, id, key) {
  var inp = container.querySelector('#' + id);
  if (!inp) return;
  function save() { var v = (this.value || '').trim(); if (this.value !== v) this.value = v; TileAPI.storage.set(key, v); }
  _on(inp, 'change', save);
  _on(inp, 'blur', save);
}

function _bindAjiKeyInput(container) {
  var inp = container.querySelector('#topbarInpAjiKey');
  if (!inp) return;
  // Key 不可能含空白, 存入时去掉所有空白(防粘贴带空格/换行导致鉴权失败)
  function saveKey() {
    var v = (inp.value || '').replace(/\s+/g, '');
    if (inp.value !== v) inp.value = v;
    TileAPI.storage.set('connection.aji.key', v);
  }
  _on(inp, 'change', saveKey);
  _on(inp, 'blur', saveKey);
  _on(inp, 'paste', function() {
    setTimeout(function() {
      var v = (inp.value || '').replace(/\s+/g, '');
      if (inp.value !== v) inp.value = v;
      if (v.length >= 16) {
        TileAPI.storage.set('connection.aji.key', v);
        _validateAjiKey(container, true);
      }
    }, 50);
  });
}

// S2: GRS Key 失焦/粘贴后自动查询积分 (复用 AJI 自动校验模式)
function _bindGrsKeyInput(container) {
  var inp = container.querySelector('#topbarInpGrsKey');
  if (!inp) return;
  function autoQueryIfReady() {
    var key = (inp.value || '').replace(/\s+/g, '');
    if (inp.value !== key) inp.value = key;
    var url = (TileAPI.storage.get('connection.grs.url') || '').trim();
    if (key.length >= 8 && url && !_queryingGrs) {
      var prevKey = TileAPI.storage.get('connection.grs.key') || '';
      var isNewKey = (key !== prevKey);
      TileAPI.storage.set('connection.grs.key', key);
      _queryingGrs = true;
      var st = container.querySelector('#topbarGrsCreditsStatus');
      if (st) st.textContent = '查询中...';
      TileAPI.sendToHost('grsCheckCredits', { apiKey: key, baseUrl: url });
      // #13: 每次输入"新"的 GRS Key 时, 必然提醒一次去平台设使用上限
      // (后台供 key 模式下用户不会在此字段输入, 自然不会触发)
      if (isNewKey) {
        TileAPI.dialog({
          title: 'GRS Key 提醒',
          message: '已保存新的 GRS Key。\n\n请记得到 GRS 平台为这个 Key 设置「使用额度上限」, 否则积分 / 余额可能一直显示为 0。',
          buttons: ['知道了'],
          escIndex: 0
        });
      }
    }
  }
  _on(inp, 'change', function() {
    var v = (this.value || '').replace(/\s+/g, '');
    if (this.value !== v) this.value = v;
    TileAPI.storage.set('connection.grs.key', v);
  });
  _on(inp, 'blur', autoQueryIfReady);
  _on(inp, 'paste', function() { setTimeout(autoQueryIfReady, 50); });
}

function _validateAjiKey(container, silent) {
  var key = (TileAPI.storage.get('connection.aji.key') || '').trim();
  if (!key) { TileAPI.toast('请先填入 AJI Key', 'error'); return; }
  var statusEl = container.querySelector('#topbarAjiValidateStatus');
  var btnEl = container.querySelector('#topbarBtnAjiValidate');
  if (statusEl) statusEl.innerHTML = '<span style="color:#4fc3f7">⏳ 校验中, 正在赛马选最快服务器...</span>';
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = '校验中...'; }
  TileAPI.sendToHost('validateAjiKey', {
    key: key,
    cachedUrlList: TileAPI.storage.get('connection.aji.urlList') || null
  });
}

function _bindGrsUrlSelect(container) {
  var sel = container.querySelector('#topbarSelGrsUrl');
  var customRow = container.querySelector('#topbarGrsCustomRow');
  var customInp = container.querySelector('#topbarInpGrsUrl');
  if (!sel) return;
  _on(sel, 'change', function() {
    var v = this.value;
    if (v === '__custom') {
      if (customRow) customRow.style.display = '';
      if (customInp) customInp.focus();
    } else {
      if (customRow) customRow.style.display = 'none';
      TileAPI.storage.set('connection.grs.url', v);
      if (customInp) customInp.value = v;
    }
  });
}

function _bindOthersInput(container, id, flatKey, fieldName) {
  var inp = container.querySelector('#' + id);
  if (!inp) return;
  function save() {
    // key 去掉所有空白; url 去首尾空白
    var v = (fieldName === 'key') ? (inp.value || '').replace(/\s+/g, '') : (inp.value || '').trim();
    if (inp.value !== v) inp.value = v;
    TileAPI.storage.set(flatKey, v);
    var configs = TileAPI.storage.get('connection.others.configs') || [];
    for (var i = 0; i < configs.length; i++) {
      if (configs[i].isActive) { configs[i][fieldName] = v; break; }
    }
    TileAPI.storage.set('connection.others.configs', configs);
  }
  _on(inp, 'change', save);
  _on(inp, 'blur', save);
}

function _rebuildOthersConfigSelect(container) {
  var sel = container.querySelector('#topbarOthersConfigSelect');
  if (!sel) return;
  var configs = TileAPI.storage.get('connection.others.configs') || [];
  var active = '';
  for (var i = 0; i < configs.length; i++) {
    if (configs[i].isActive) { active = configs[i].name; break; }
  }
  sel.innerHTML = '';
  for (var j = 0; j < configs.length; j++) {
    var opt = document.createElement('option');
    opt.value = configs[j].name;
    opt.textContent = configs[j].name;
    if (configs[j].name === active) opt.selected = true;
    sel.appendChild(opt);
  }
}

function _refreshOthersFetchStatus(container) {
  var st = container.querySelector('#topbarOthersFetchStatus');
  if (!st) return;
  var configs = TileAPI.storage.get('connection.others.configs') || [];
  var active = null;
  for (var i = 0; i < configs.length; i++) {
    if (configs[i].isActive) { active = configs[i]; break; }
  }
  var count = active && active.models ? Object.keys(active.models).length : 0;
  st.textContent = count > 0 ? ('已缓存 ' + count + ' 个模型') : '尚未拉取';
}

function _doFetchOthersModels(container, btn) {
  var url = (container.querySelector('#topbarInpOthersUrl') || {}).value || '';
  var key = (container.querySelector('#topbarInpOthersKey') || {}).value || '';
  url = String(url).trim();
  key = String(key).replace(/\s+/g, '');
  if (!url) { TileAPI.toast('请先填写 URL', 'error'); return; }
  if (!key) { TileAPI.toast('请先填写 Key', 'error'); return; }
  if (url.endsWith('/')) url = url.slice(0, -1);
  var st = container.querySelector('#topbarOthersFetchStatus');
  var orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '拉取中...';
  if (st) st.textContent = '请求中...';

  _netConfig.fetchWithTimeout(url + '/v1/models', { method: 'GET', headers: { 'Authorization': 'Bearer ' + key } }, 15000)
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      var models = [];
      if (data && data.data && Array.isArray(data.data)) {
        models = data.data.map(function(m) { return m.id || m.name; }).filter(Boolean);
      } else if (data && Array.isArray(data.models)) {
        models = data.models.map(function(m) { return typeof m === 'string' ? m : (m.id || m.name); }).filter(Boolean);
      } else if (Array.isArray(data)) {
        models = data.map(function(m) { return typeof m === 'string' ? m : (m.id || m.name); }).filter(Boolean);
      }
      models = models.filter(function(m) {
        var l = String(m).toLowerCase();
        if (l.indexOf('banana') !== -1) return true;
        if (l.indexOf('gemini') !== -1 && l.indexOf('image') !== -1) return true;
        if (l.indexOf('gpt-image') !== -1) return true;
        return false;
      });
      models.sort();
      if (!models.length) throw new Error('过滤后无图像类模型');
      var cfg = {};
      models.forEach(function(m) {
        cfg[m] = { name: m, sizes: ['1K', '2K', '4K'], default: '2K', suffixMode: 'none', prices: { '1K': 0, '2K': 0, '4K': 0 } };
      });
      TileAPI.state.set('models.others', cfg);
      TileAPI.storage.set('models.others.cache', cfg);
      var configs = TileAPI.storage.get('connection.others.configs') || [];
      for (var i = 0; i < configs.length; i++) {
        if (configs[i].isActive) { configs[i].models = cfg; break; }
      }
      TileAPI.storage.set('connection.others.configs', configs);
      TileAPI.emit('params:modelsFetched', { provider: 'others', count: models.length });
      btn.disabled = false;
      btn.textContent = orig;
      if (st) st.textContent = '已拉取 ' + models.length + ' 个模型';
      TileAPI.toast('Others 拉取成功: ' + models.length + ' 个模型', 'success');
    })
    .catch(function(err) {
      btn.disabled = false;
      btn.textContent = orig;
      if (st) st.textContent = '失败: ' + err.message;
      TileAPI.toast('Others 拉取失败: ' + err.message, 'error');
    });
}

// ===== 墨墨(momo) 模型拉取 — URL 嵌死; 走 host 转发(UXP 前端 fetch /api 会失败) =====
var MOMO_BASE_URL = 'https://api.momoapi.icu';
// 墨墨「购买额度」跳转链接: 写死 (原版由作者后台下发 momo_link, 已删)
var MOMO_BUY_URL_DEFAULT = 'https://m.tb.cn/h.R8OOWcr?tk=lh24gYBEMGx';
var MOMO_BUY_TITLE_DEFAULT = '购买墨墨额度';
function _momoBuyUrl() { return TileAPI.storage.get('momo.buyUrl') || MOMO_BUY_URL_DEFAULT; }
function _momoBuyTitle() { return TileAPI.storage.get('momo.buyTitle') || MOMO_BUY_TITLE_DEFAULT; }
var _momoFetchPending = {};   // requestId -> {container, btn, orig}
var _momoQuotaPending = {};   // requestId -> {container}
function _refreshMomoFetchStatus(container) {
  var st = container.querySelector('#topbarMomoFetchStatus');
  if (!st) return;
  var cache = TileAPI.storage.get('models.momo.cache') || {};
  var count = Object.keys(cache).length;
  st.textContent = count > 0 ? ('已缓存 ' + count + ' 个模型') : '尚未拉取';
}
function _doFetchMomoModels(container, btn) {
  var key = ((container.querySelector('#topbarInpMomoKey') || {}).value || '').replace(/\s+/g, '');
  if (!key) { TileAPI.toast('请先填写墨墨 Key', 'error'); return; }
  TileAPI.storage.set('connection.momo.key', key);
  var st = container.querySelector('#topbarMomoFetchStatus');
  var orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '拉取中...';
  if (st) st.textContent = '请求中...';
  var rid = 'momofetch_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  _momoFetchPending[rid] = { container: container, btn: btn, orig: orig };
  TileAPI.sendToHost('momoFetchModels', { requestId: rid, apiKey: key, apiBaseUrl: MOMO_BASE_URL });
  setTimeout(function() {
    if (_momoFetchPending[rid]) {
      delete _momoFetchPending[rid];
      btn.disabled = false; btn.textContent = orig;
      if (st) st.textContent = '失败: 超时';
      TileAPI.toast('墨墨拉取超时', 'error');
    }
  }, 15000);
}
// host 回包: 过滤图像类 → 写 models.momo.cache → 重建视图
TileAPI.onHostMessage('momoModelsResult', function(d) {
  if (!d || !d.requestId) return;
  var p = _momoFetchPending[d.requestId];
  if (!p) return;
  delete _momoFetchPending[d.requestId];
  var btn = p.btn, container = p.container;
  var st = container.querySelector('#topbarMomoFetchStatus');
  if (btn) { btn.disabled = false; btn.textContent = p.orig; }
  if (!d.success) {
    if (st) st.textContent = '失败: ' + (d.error || '');
    TileAPI.toast('墨墨拉取失败: ' + (d.error || ''), 'error');
    return;
  }
  var models = (d.ids || []).filter(function(m) {
    var l = String(m).toLowerCase();
    if (l.indexOf('banana') !== -1) return true;
    if (l.indexOf('gemini') !== -1 && l.indexOf('image') !== -1) return true;
    if (l.indexOf('gpt-image') !== -1) return true;
    return false;
  });
  models.sort();
  if (!models.length) {
    if (st) st.textContent = '失败: 过滤后无图像类模型';
    TileAPI.toast('墨墨拉取失败: 过滤后无图像类模型', 'error');
    return;
  }
  var cfg = {};
  models.forEach(function(m) {
    cfg[m] = { name: m, sizes: ['1K', '2K', '4K'], default: '2K', suffixMode: 'none', prices: { '1K': 0, '2K': 0, '4K': 0 } };
  });
  TileAPI.storage.set('models.momo.cache', cfg);
  if (TileAPI.rebuildModelViews) TileAPI.rebuildModelViews(); else TileAPI.state.set('models.momo', cfg);
  TileAPI.emit('params:modelsFetched', { provider: 'momo', count: models.length });
  if (st) st.textContent = '已拉取 ' + models.length + ' 个模型';
  TileAPI.toast('墨墨拉取成功: ' + models.length + ' 个模型', 'success');
});

// 墨墨额度查询回包(顶栏「查询」按钮)
TileAPI.onHostMessage('momoQuotaResult', function(d) {
  if (!d || !d.requestId) return;
  var p = _momoQuotaPending[d.requestId];
  if (!p) return;
  delete _momoQuotaPending[d.requestId];
  var st = p.container.querySelector('#topbarMomoQuotaStatus');
  if (!st) return;
  if (!d.success) { st.textContent = '失败: ' + (d.error || ''); return; }
  if (d.unlimited_quota) { st.textContent = '余额: 无限'; return; }
  var usd = d.balance_usd;   // 只看令牌自身额度
  st.textContent = (usd == null) ? '余额: —' : ('余额: $' + (+usd).toFixed(4));
});

function _bindKeyEyeToggles(container) {
  container.querySelectorAll('.key-eye-btn').forEach(function(btn) {
    var target = btn.dataset.target;
    if (!target) return;
    var inp = container.querySelector('#' + target);
    if (!inp) return;
    _setupEyeToggle(btn, inp);
  });
}

// ============================================================
//  Host 消息处理
// ============================================================
function _handleMessage(action, data) {
  var container = _activeContainer;

  // ----- 跑完任务: 用服务端真实余额校准，避免前端估算重复扣减 -----
  if (action === 'taskComplete') {
    var completedProvider = (data && data.provider) || _currentProvider();
    if (completedProvider === 'aji' && _ajiConfigured()) {
      _autoQueryAll(true);
    }
    if (completedProvider === 'grs' && _grsConfigured()) {
      var now = Date.now();
      if (now - _grsRefreshLastTs > 15000 && !_queryingGrs) {
        _grsRefreshLastTs = now;
        _queryingGrs = true;
        TileAPI.sendToHost('grsCheckCredits', {
          apiKey: TileAPI.storage.get('connection.grs.key'),
          baseUrl: TileAPI.storage.get('connection.grs.url')
        });
      }
    }
  }

  // ----- 余额 -----
  if (action === 'balanceResult' || action === 'calibrateResult') {
    _queryingAji = false;
    if (data && data.balanceUSD !== undefined && !data.error) {
      TileAPI.state.set('balance.current', data.balanceUSD);
      TileAPI.emit('balance:updated');
      _refreshFront();
      if (!data.silent && _isLowAji(data.balanceUSD)) {
        TileAPI.toast('⚠️ AJI 余额低于 $' + _getThresholdAji() + ', 请及时充值', 'error');
      }
    } else if (data && data.error) {
      if (!data.silent) TileAPI.toast('AJI 余额查询失败: ' + data.error, 'error');
    }
  }

  if (action === 'grsCreditsResult') {
    _queryingGrs = false;
    if (_grsCheckBtnDone) { _grsCheckBtnDone(); _grsCheckBtnDone = null; }
    if (data && data.success) {
      TileAPI.state.set('grs.credits', data.credits);
      TileAPI.state.set('grs.modelStatuses', data.modelStatuses || {});
      TileAPI.emit('grs:creditsUpdated');
      _refreshFront();
      // 同步面板上余额展示行 (局部更新, 不重渲整 section)
      if (container) {
        var stByok = container.querySelector('#topbarGrsCreditsStatus');
        if (stByok) {
          stByok.textContent = '余额 ' + _shortCredits(data.credits);
          stByok.style.color = _isLowGrs(data.credits) ? '#ff7a7a' : 'var(--text-sub)';
        }
      }
      // #13: 旧的"余额=0 自动弹窗"已移除, 改为仅在输入新 Key 时提醒一次 (见 _bindGrsKeyInput)
      var offline = Object.keys(data.modelStatuses || {}).filter(function(k) {
        return data.modelStatuses[k] && !data.modelStatuses[k].status;
      });
      if (offline.length) {
        TileAPI.toast('GRS 积分: ' + data.credits + ' · ' + offline.length + ' 个模型离线', 'warn');
      } else if (data.credits > 0 && _isLowGrs(data.credits)) {
        TileAPI.toast('⚠️ GRS 积分低于 ' + _getThresholdGrs() + ', 请及时充值', 'error');
      }
    } else {
      TileAPI.toast('GRS 查询失败: ' + ((data && data.error) || '未知原因'), 'error');
    }
  }

  if (action === 'checkQuotaResult') {
    var quotaStatus = container && container.querySelector('#topbarOthersQuotaStatus');
    if (data && data.success) {
      var quotaText = (typeof data.balanceUSD === 'number')
        ? ('余额 $' + data.balanceUSD.toFixed(4))
        : (data.remaining !== undefined ? ('剩余 ' + data.remaining) : '查询成功');
      if (quotaStatus) quotaStatus.textContent = quotaText;
    } else if (quotaStatus) {
      quotaStatus.textContent = '查询失败: ' + ((data && data.error) || '该中转没有通用额度接口');
    }
  }

  // ----- AJI 校验 (从老 tile-settings 搬过来) -----
  if (action === 'ajiValidateResult') {
    var statusEl = container && container.querySelector('#topbarAjiValidateStatus');
    var btnEl = container && container.querySelector('#topbarBtnAjiValidate');
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = '校验 Key'; }
    if (data && data.success && data.url) {
      TileAPI.storage.set('connection.aji.url', data.url);
      if (data.urlList && data.urlList.length > 0) {
        TileAPI.storage.set('connection.aji.urlList', data.urlList);
      }
      if (data.unverified) {
        if (statusEl) statusEl.innerHTML = '<span style="color:#ffa726">⚠ 未校验,已用应急地址放行 → ' + _esc(data.url) + '</span><div style="color:#ffa726;font-size:11px">' + _esc(data.info || '若生成报网络错,请改用自定义') + '</div>';
        TileAPI.toast('AJI 未能校验余额,已用应急地址放行', 'warn');
      } else {
        var balText = (typeof data.balanceUSD === 'number') ? ' · 余额 $' + data.balanceUSD.toFixed(2) : '';
        var srcWarn = '';
        if (data.urlSource === 'cache') srcWarn = ' <span style="color:#ffa726">(用了本地缓存,作者服务器可能挂了)</span>';
        else if (data.urlSource === 'fallback') srcWarn = ' <span style="color:#ff9d4a">(用了应急 URL,作者服务器挂了)</span>';
        if (statusEl) statusEl.innerHTML = '<span style="color:#69f0ae">✓ 已校验 → ' + _esc(data.url) + (data.latency ? ' (' + data.latency + 'ms)' : '') + balText + '</span>' + srcWarn;
        TileAPI.toast('AJI 校验成功' + (data.latency ? ' · ' + data.latency + 'ms' : '') + balText, 'success');
      }
    } else {
      var err = (data && data.error) || '未知错误';
      if (statusEl) statusEl.innerHTML = '<span style="color:#ff5252">✗ 校验失败: ' + _esc(err) + '</span>';
      TileAPI.toast('AJI 校验失败: ' + err, 'error');
    }
  }

}

// ============================================================
//  注册磁贴
// ============================================================
TileAPI.registerTile({
  id: 'topbar',
  group: 'main',
  icon: '⚙',
  label: '顶栏',
  desc: '算力 · 连接',
  live: true,
  pinTop: true,
  defaultSize: { w: 4, h: 1 },
  minSize: { w: 4, h: 1 },
  maxSize: { w: 4, h: 1 },

  renderFront: function(container) {
    _renderFront(container);
  },

  renderBack: function(container) {
    container.textContent = '算力';
  },

  onExpand: function(container) {
    _closeLayoutPanel();   // 顶栏自己展开时, 收起布局面板, 避免两个展开叠一起
    _renderPanel(container);
    return function() { _activeContainer = null; };
  },

  onCollapse: function() {
    _activeContainer = null;
  },

  onStorageLoaded: function(storage) {
    // 启动时按已保存的 Key 查一次余额 (AJI / GRS), 不需要登录
    setTimeout(function() { _autoQueryAll(true); }, 1500);
  },

  onMessage: function(action, data) {
    _handleMessage(action, data);
  }
});

// ============================================================
//  全局事件监听 (provider 切换)
// ============================================================
function _onProviderSwitched() {
  _refreshFront();
  _autoQueryAll(true);
}
TileAPI.on('params:providerChanged', _onProviderSwitched);
// #1: 切换模型 / 分辨率时, AJI 顶栏的"剩余张数"要跟着重算
if (TileAPI.state && TileAPI.state.subscribe) {
  TileAPI.state.subscribe('params.model', _refreshFront);
  TileAPI.state.subscribe('params.size', _refreshFront);
}
// ☰ 布局按钮的开关 — 暴露给 group-manager (按钮在 #topbarHost 里, 由它绑 click 调这个)
window._topbarToggleLayoutPanel = function() { _toggleLayoutPanel(); };

})();
