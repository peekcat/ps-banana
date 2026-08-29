/**
 * ui-kit.js — UIKit 组件库
 * 替代 UXP webview 里样式割裂的原生 <select> / confirm / alert / prompt
 *
 * 全部组件满足:
 * - 暗色 + 毛玻璃,与磁贴面板视觉统一
 * - 响应主题色 var(--accent)
 * - Portal 到 document.body,不被磁贴的 overflow:hidden 裁剪
 * - 与 tile-engine 的 ESC/collapse 逻辑协调
 *
 * 对外 API:
 *   UIKit.select(config)     → 自定义下拉
 *   UIKit.bindSelect(el, opt) → 把原生 <select> 升级成自定义(兼容适配器)
 *   UIKit.enhance(container) → 扫描容器内所有 <select> 并自动 bindSelect
 *   UIKit.dialog(config)     → 通用对话框
 *   UIKit.confirm(msg)       → 二选一
 *   UIKit.alert(msg)         → 单按钮
 *   UIKit.prompt(msg, opts)  → 带输入框
 *   UIKit.closeAllPopups()   → 关闭所有弹出层(磁贴收起时调用)
 */
(function() {
'use strict';

// ========== 内部状态 ==========

var _activePopups = [];   // 当前打开的 select 面板
var _dialogStack = [];    // 当前打开的对话框(支持堆叠)
var _enhancedSelects = new WeakMap();  // 原生 select → UIKit 实例

// 模态对话框必须永远在最上层(高于欢迎页 100500 / 回收站 999999 / 功能导览·卫星 9999990~9999992 等所有遮罩),
// 否则弹窗会被这些遮罩盖住、点击被吃掉(表现为"弹窗无响应、点不动")。
var Z_DIALOG_BASE = 10000000;
// 下拉浮层再压对话框一层 —— 保证对话框内的 <select> 下拉能正常展开在对话框之上。
var Z_POPUP = 10001000;

// ========== 工具函数 ==========

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _uid() {
  return 'uik_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
}

function _nextFrame(fn) {
  requestAnimationFrame(function() { requestAnimationFrame(fn); });
}

// ============================================================
//  UIKit.select
// ============================================================

/**
 * config:
 *   anchor      : DOM 元素(必需,点击弹出面板的锚点)
 *   value       : 初始值
 *   options     : [{value, label, disabled?}] 或
 *   groups      : [{label, options: [...]}] (有 groups 则忽略 options)
 *   placeholder : 无选中时显示
 *   searchable  : bool,面板顶部加搜索
 *   onChange    : function(value, option)
 */
function createSelect(config) {
  config = config || {};
  var anchor = config.anchor;
  if (!anchor || !anchor.nodeType) {
    console.error('[UIKit.select] anchor 缺失');
    return null;
  }

  var state = {
    value: config.value == null ? '' : String(config.value),
    options: config.options || [],
    groups: config.groups || null,
    placeholder: config.placeholder || '-- 选择 --',
    searchable: !!config.searchable,
    onChange: config.onChange || function() {},
    _filter: '',
    _highlight: -1,
    _flatOptions: []     // 扁平化缓存,键盘导航用
  };

  // --- 构建触发器 ---
  anchor.classList.add('uik-sel');
  anchor.setAttribute('role', 'combobox');
  anchor.setAttribute('tabindex', '0');
  anchor.innerHTML =
    '<span class="uik-sel-label"></span>' +
    '<span class="uik-sel-arrow">\u25be</span>';
  var labelEl = anchor.querySelector('.uik-sel-label');

  var popupEl = null;
  var isOpen = false;

  function _flatten() {
    var flat = [];
    if (state.groups) {
      state.groups.forEach(function(g) {
        (g.options || []).forEach(function(o) { flat.push(o); });
      });
    } else {
      state.options.forEach(function(o) { flat.push(o); });
    }
    return flat;
  }

  function _findOption(val) {
    var flat = _flatten();
    for (var i = 0; i < flat.length; i++) {
      if (String(flat[i].value) === String(val)) return flat[i];
    }
    return null;
  }

  function _renderLabel() {
    var opt = _findOption(state.value);
    if (opt) {
      labelEl.textContent = opt.label;
      labelEl.classList.remove('uik-sel-placeholder');
    } else {
      labelEl.textContent = state.placeholder;
      labelEl.classList.add('uik-sel-placeholder');
    }
  }

  function _matchFilter(opt) {
    if (!state._filter) return true;
    return String(opt.label).toLowerCase().indexOf(state._filter.toLowerCase()) >= 0;
  }

  function _renderList() {
    var html = '';
    state._flatOptions = [];
    if (state.groups) {
      state.groups.forEach(function(g) {
        var visibleOpts = (g.options || []).filter(_matchFilter);
        if (visibleOpts.length === 0) return;
        html += '<div class="uik-sel-group">' +
                '<div class="uik-sel-group-label">' + _esc(g.label) + '</div>';
        visibleOpts.forEach(function(o) {
          var idx = state._flatOptions.length;
          state._flatOptions.push(o);
          html += _renderOption(o, idx);
        });
        html += '</div>';
      });
    } else {
      state.options.filter(_matchFilter).forEach(function(o) {
        var idx = state._flatOptions.length;
        state._flatOptions.push(o);
        html += _renderOption(o, idx);
      });
    }
    if (!html) html = '<div class="uik-sel-empty">无匹配项</div>';
    return html;
  }

  function _renderOption(o, flatIdx) {
    var selected = (String(o.value) === String(state.value)) ? ' selected' : '';
    var highlight = (flatIdx === state._highlight) ? ' highlight' : '';
    var disabled = o.disabled ? ' disabled' : '';
    return '<div class="uik-sel-opt' + selected + highlight + disabled +
           '" data-val="' + _esc(o.value) + '" data-idx="' + flatIdx + '">' +
           _esc(o.label) + '</div>';
  }

  function _position() {
    if (!popupEl) return;
    var r = anchor.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    var w = Math.max(r.width, 140);
    popupEl.style.width = w + 'px';
    popupEl.style.left = Math.min(r.left, vw - w - 8) + 'px';
    // 先放下方,测量后若越界翻到上方
    popupEl.style.top = (r.bottom + 4) + 'px';
    popupEl.style.maxHeight = (vh - r.bottom - 16) + 'px';
    var ph = popupEl.offsetHeight;
    if (r.bottom + ph + 8 > vh && r.top > vh - r.bottom) {
      // 翻到上方
      popupEl.style.top = (r.top - ph - 4) + 'px';
      popupEl.style.maxHeight = (r.top - 16) + 'px';
    }
  }

  function _closeOnOutsideClick(e) {
    if (!popupEl) return;
    if (popupEl.contains(e.target)) return;
    if (anchor.contains(e.target)) return;
    close();
  }

  function _closeOnScroll(e) {
    // 忽略弹出面板自身内部的滚动(列表滚动、搜索框滚动)
    if (popupEl && e && e.target && popupEl.contains(e.target)) return;
    close();
  }
  function _closeOnResize() { close(); }

  function _onKeydown(e) {
    if (!isOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      var max = state._flatOptions.length;
      if (max === 0) return;
      var cur = state._highlight;
      if (e.key === 'ArrowDown') cur = (cur + 1) % max;
      else cur = (cur - 1 + max) % max;
      state._highlight = cur;
      _refreshHighlight();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (state._highlight >= 0 && state._flatOptions[state._highlight]) {
        _select(state._flatOptions[state._highlight]);
      }
      return;
    }
  }

  function _refreshHighlight() {
    if (!popupEl) return;
    popupEl.querySelectorAll('.uik-sel-opt').forEach(function(el) {
      var idx = +el.dataset.idx;
      el.classList.toggle('highlight', idx === state._highlight);
    });
    var hl = popupEl.querySelector('.uik-sel-opt.highlight');
    if (hl) hl.scrollIntoView({ block: 'nearest' });
  }

  function _select(opt) {
    if (!opt || opt.disabled) return;
    state.value = String(opt.value);
    _renderLabel();
    close();
    try { state.onChange(state.value, opt); } catch(e) { console.error('[UIKit.select] onChange error:', e); }
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    popupEl = document.createElement('div');
    popupEl.className = 'uik-sel-pop';
    popupEl.style.zIndex = Z_POPUP;
    popupEl.innerHTML =
      (state.searchable ? '<input class="uik-sel-search" placeholder="\u641c\u7d22...">' : '') +
      '<div class="uik-sel-list">' + _renderList() + '</div>';
    document.body.appendChild(popupEl);

    // 初始高亮:当前选中项
    var flat = state._flatOptions;
    state._highlight = -1;
    for (var i = 0; i < flat.length; i++) {
      if (String(flat[i].value) === String(state.value)) { state._highlight = i; break; }
    }

    _position();

    // 搜索框
    var searchEl = popupEl.querySelector('.uik-sel-search');
    if (searchEl) {
      searchEl.addEventListener('input', function() {
        state._filter = this.value;
        state._highlight = state._flatOptions.length > 0 ? 0 : -1;
        popupEl.querySelector('.uik-sel-list').innerHTML = _renderList();
        _position();
      });
      searchEl.addEventListener('keydown', _onKeydown);
      setTimeout(function() { searchEl.focus(); }, 0);
    }

    // 列表点击
    popupEl.addEventListener('click', function(e) {
      var item = e.target.closest('.uik-sel-opt');
      if (!item) return;
      if (item.classList.contains('disabled')) return;
      var val = item.dataset.val;
      var flat = state._flatOptions;
      for (var i = 0; i < flat.length; i++) {
        if (String(flat[i].value) === String(val)) { _select(flat[i]); break; }
      }
    });
    popupEl.addEventListener('mousemove', function(e) {
      var item = e.target.closest('.uik-sel-opt');
      if (!item) return;
      var idx = +item.dataset.idx;
      if (idx !== state._highlight) {
        state._highlight = idx;
        _refreshHighlight();
      }
    });

    // 外部点击/滚动/resize 关闭
    document.addEventListener('mousedown', _closeOnOutsideClick, true);
    window.addEventListener('scroll', _closeOnScroll, true);
    window.addEventListener('resize', _closeOnResize);
    // 键盘 capture 优先级高于 tile-engine ESC
    document.addEventListener('keydown', _onKeydown, true);

    _activePopups.push(instance);
    anchor.classList.add('uik-sel-open');

    // 出场动画
    popupEl.classList.add('uik-sel-pop-enter');
    _nextFrame(function() {
      if (popupEl) popupEl.classList.add('uik-sel-pop-enter-active');
    });
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    anchor.classList.remove('uik-sel-open');
    document.removeEventListener('mousedown', _closeOnOutsideClick, true);
    window.removeEventListener('scroll', _closeOnScroll, true);
    window.removeEventListener('resize', _closeOnResize);
    document.removeEventListener('keydown', _onKeydown, true);
    var idx = _activePopups.indexOf(instance);
    if (idx >= 0) _activePopups.splice(idx, 1);
    if (popupEl) {
      var el = popupEl;
      popupEl = null;
      el.classList.add('uik-sel-pop-leave');
      setTimeout(function() {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }, 110);
    }
    state._filter = '';
    state._highlight = -1;
  }

  function toggle() { isOpen ? close() : open(); }

  // --- 锚点交互 ---
  anchor.addEventListener('mousedown', function(e) {
    // 阻止触发磁贴长按检测
    e.stopPropagation();
  });
  anchor.addEventListener('click', function(e) {
    e.stopPropagation();
    toggle();
  });
  anchor.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });

  // --- 实例 API ---
  var instance = {
    _anchor: anchor,
    open: open,
    close: close,
    toggle: toggle,
    getValue: function() { return state.value; },
    setValue: function(v) {
      state.value = v == null ? '' : String(v);
      _renderLabel();
    },
    setOptions: function(opts) {
      state.options = opts || [];
      state.groups = null;
      _renderLabel();
      if (isOpen && popupEl) {
        popupEl.querySelector('.uik-sel-list').innerHTML = _renderList();
      }
    },
    setGroups: function(groups) {
      state.groups = groups || null;
      _renderLabel();
      if (isOpen && popupEl) {
        popupEl.querySelector('.uik-sel-list').innerHTML = _renderList();
      }
    },
    destroy: function() {
      close();
      anchor.classList.remove('uik-sel');
      anchor.removeAttribute('role');
      anchor.removeAttribute('tabindex');
      anchor.innerHTML = '';
    }
  };

  _renderLabel();
  return instance;
}

// ============================================================
//  UIKit.bindSelect —— 把原生 <select> 升级
// ============================================================

function _readNativeOptions(selectEl) {
  var children = selectEl.children;
  var hasGroup = false;
  for (var i = 0; i < children.length; i++) {
    if (children[i].tagName === 'OPTGROUP') { hasGroup = true; break; }
  }
  if (hasGroup) {
    var groups = [];
    for (var gi = 0; gi < children.length; gi++) {
      var c = children[gi];
      if (c.tagName === 'OPTGROUP') {
        var opts = [];
        for (var oi = 0; oi < c.children.length; oi++) {
          var o = c.children[oi];
          if (o.tagName !== 'OPTION') continue;
          opts.push({ value: o.value, label: o.textContent, disabled: o.disabled });
        }
        groups.push({ label: c.label || '', options: opts });
      } else if (c.tagName === 'OPTION') {
        // 混在顶层的 option,归到无名组
        if (!groups.length || groups[0].label !== '') groups.unshift({ label: '', options: [] });
        groups[0].options.push({ value: c.value, label: c.textContent, disabled: c.disabled });
      }
    }
    return { groups: groups };
  }
  var options = [];
  for (var k = 0; k < children.length; k++) {
    var oc = children[k];
    if (oc.tagName !== 'OPTION') continue;
    options.push({ value: oc.value, label: oc.textContent, disabled: oc.disabled });
  }
  return { options: options };
}

function bindSelect(selectEl, opts) {
  if (!selectEl || selectEl.tagName !== 'SELECT') return null;
  if (_enhancedSelects.has(selectEl)) return _enhancedSelects.get(selectEl);
  // 防止 MutationObserver 循环:标记为已处理
  selectEl.setAttribute('data-uik-bound', '1');

  opts = opts || {};

  // 创建触发器 div 包裹原生 select
  var wrap = document.createElement('div');
  wrap.className = 'uik-sel-wrap';
  // 复制原生 select 的 class(如 w10-select),让现有样式/布局兼容
  if (selectEl.className) wrap.className += ' ' + selectEl.className;
  selectEl.parentNode.insertBefore(wrap, selectEl);
  wrap.appendChild(selectEl);
  selectEl.style.display = 'none';

  var trigger = document.createElement('div');
  trigger.className = 'uik-sel-trigger';
  wrap.appendChild(trigger);

  function _buildInstance() {
    var data = _readNativeOptions(selectEl);
    var cfg = {
      anchor: trigger,
      value: selectEl.value,
      placeholder: opts.placeholder || selectEl.getAttribute('data-placeholder') || '-- 选择 --',
      searchable: opts.searchable || !!selectEl.getAttribute('data-searchable'),
      onChange: function(value, option) {
        // 写回原生 select 并 dispatch change
        if (selectEl.value !== value) {
          selectEl.value = value;
          try { selectEl.dispatchEvent(new Event('change', { bubbles: true })); } catch(e) {}
        }
        if (typeof opts.onChange === 'function') opts.onChange(value, option);
      }
    };
    if (data.groups) cfg.groups = data.groups;
    else cfg.options = data.options;
    return createSelect(cfg);
  }

  var inst = _buildInstance();

  // 监听原生 select 的 DOM 变化(代码动态 innerHTML = '...')
  var _rebuildTimer = null;
  var observer = new MutationObserver(function() {
    if (_rebuildTimer) clearTimeout(_rebuildTimer);
    _rebuildTimer = setTimeout(function() {
      if (!inst) return;
      var data = _readNativeOptions(selectEl);
      if (data.groups) inst.setGroups(data.groups);
      else inst.setOptions(data.options);
      inst.setValue(selectEl.value);
    }, 50);
  });
  observer.observe(selectEl, { childList: true, subtree: true, characterData: true });

  // 代码显式改 .value 时也要同步
  var _lastVal = selectEl.value;
  var syncTimer = setInterval(function() {
    if (!selectEl.isConnected) {
      // 原生 select 被移除了,清理
      clearInterval(syncTimer);
      observer.disconnect();
      if (inst) inst.destroy();
      _enhancedSelects.delete(selectEl);
      return;
    }
    if (selectEl.value !== _lastVal) {
      _lastVal = selectEl.value;
      if (inst) inst.setValue(selectEl.value);
    }
  }, 200);

  var wrapped = {
    _native: selectEl,
    _inst: inst,
    destroy: function() {
      clearInterval(syncTimer);
      observer.disconnect();
      if (inst) inst.destroy();
      if (selectEl.parentNode === wrap) {
        wrap.parentNode.insertBefore(selectEl, wrap);
        selectEl.style.display = '';
        wrap.parentNode.removeChild(wrap);
      }
      _enhancedSelects.delete(selectEl);
    }
  };
  _enhancedSelects.set(selectEl, wrapped);
  return wrapped;
}

// 扫描容器,自动把所有原生 select 升级
function enhance(container) {
  if (!container) return 0;
  // 跳过 UIKit 自己产生的容器(uik-sel-wrap 里的 select 已经 bound)
  if (container.classList && container.classList.contains('uik-sel-wrap')) return 0;
  var list = container.querySelectorAll('select');
  var count = 0;
  for (var i = 0; i < list.length; i++) {
    var el = list[i];
    if (el.hasAttribute('data-uik-skip')) continue;
    if (el.hasAttribute('data-uik-bound')) continue;
    if (!_enhancedSelects.has(el)) {
      bindSelect(el);
      count++;
    }
  }
  // 给所有数值输入(滑块/数字框)挂统一的滚轮微调 —— 受设置开关 params.wheelEnabled 控制, 默认关。
  // 这是"所有卡片都能滚轮调参"的统一入口: app.js 的 MutationObserver 会对新出现的展开内容调 enhance,
  // 所以各磁贴无需各自实现, 在这里一处覆盖。
  var nums = container.querySelectorAll('input[type="range"], input[type="number"]');
  for (var j = 0; j < nums.length; j++) _bindWheelInput(nums[j]);
  return count;
}

// 设置开关: 默认禁止(读不到值 = 禁止), 用户在设置里打开才生效
function _wheelParamEnabled() {
  try {
    return !!(window.TileAPI && TileAPI.storage && TileAPI.storage.get('params.wheelEnabled') === true);
  } catch (_) { return false; }
}

// 给单个数值输入挂滚轮微调(幂等)。监听器常驻, 但每次滚动实时读开关,
// 这样在设置里切换开关立即生效, 无需重新绑定。
// 已被磁贴自己挂过滚轮的输入(标了 __wheelBound)会跳过, 避免重复步进。
function _bindWheelInput(input) {
  if (!input || input.__wheelBound) return;
  if (input.hasAttribute('data-uik-skip-wheel')) return;
  input.__wheelBound = true;
  input.addEventListener('wheel', function(e) {
    if (!_wheelParamEnabled()) return;        // 默认禁止: 不拦截滚动, 让面板正常滚
    if (input.disabled || input.readOnly) return;
    e.preventDefault();
    var step = parseFloat(input.getAttribute('step'));
    if (!isFinite(step) || step <= 0) step = 1;
    var min = parseFloat(input.getAttribute('min')); if (!isFinite(min)) min = -Infinity;
    var max = parseFloat(input.getAttribute('max')); if (!isFinite(max)) max = Infinity;
    var cur = parseFloat(input.value); if (!isFinite(cur)) cur = 0;
    var dir = e.deltaY < 0 ? 1 : -1;          // 上滚 +, 下滚 -
    var next = cur + dir * step;
    next = Math.round(next / step) * step;     // 对齐步进, 修浮点毛刺
    next = parseFloat(next.toFixed(6));
    if (next < min) next = min;
    if (next > max) next = max;
    if (next === cur) return;
    input.value = next;
    // 派发原生事件 → 各磁贴已有的 input/change 监听照常持久化, 无需另写逻辑
    try { input.dispatchEvent(new Event('input',  { bubbles: true })); } catch (_) {}
    try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
  }, { passive: false });
}

// ============================================================
//  UIKit.dialog
// ============================================================

/**
 * config:
 *   title    : 标题(可选)
 *   message  : 消息文本(可选)
 *   html     : 自定义 HTML 内容(优先于 message)
 *   input    : { placeholder, value, type } 则是 prompt 模式
 *   buttons  : ['取消','确认'] 默认
 *   danger   : number,把第 N 个按钮标红
 *   accent   : number,默认最后一个按钮为 accent
 *   escIndex : ESC 键等价于按哪个按钮,默认 0
 *
 * 返回 Promise<{index, value}>
 */
function dialog(config) {
  config = config || {};
  var title = config.title || '';
  var message = config.message || '';
  var html = config.html || '';
  var input = config.input || null;
  var buttons = config.buttons || ['取消', '确认'];
  var dangerIdx = (config.danger == null) ? -1 : config.danger;
  var accentIdx = (config.accent == null) ? (buttons.length - 1) : config.accent;
  var escIndex = (config.escIndex == null) ? 0 : config.escIndex;

  return new Promise(function(resolve) {
    var z = Z_DIALOG_BASE + _dialogStack.length * 2;
    var overlay = document.createElement('div');
    overlay.className = 'uik-dlg-overlay';
    overlay.style.zIndex = z;

    var btnsHtml = buttons.map(function(label, i) {
      var cls = 'w10-btn';
      if (i === accentIdx) cls += ' w10-btn-accent';
      var extra = '';
      if (i === dangerIdx) extra = ' style="color:#ff6b6b;border-color:rgba(255,100,100,0.3)"';
      return '<button class="' + cls + '" data-idx="' + i + '"' + extra + '>' + _esc(label) + '</button>';
    }).join('');

    overlay.innerHTML =
      '<div class="uik-dlg" style="z-index:' + (z + 1) + '">' +
        (title ? '<div class="uik-dlg-title">' + _esc(title) + '</div>' : '') +
        '<div class="uik-dlg-body">' +
          (html ? html : (message ? '<div class="uik-dlg-message">' + _esc(message) + '</div>' : '')) +
          (input ? '<input class="uik-dlg-input w10-input" placeholder="' + _esc(input.placeholder || '') + '" value="' + _esc(input.value || '') + '" type="' + _esc(input.type || 'text') + '">' : '') +
        '</div>' +
        '<div class="uik-dlg-btns">' + btnsHtml + '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    var inputEl = overlay.querySelector('.uik-dlg-input');

    function cleanup() {
      document.removeEventListener('keydown', _onKey, true);
      var i = _dialogStack.indexOf(instance);
      if (i >= 0) _dialogStack.splice(i, 1);
      overlay.classList.add('uik-dlg-leave');
      setTimeout(function() {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 120);
    }

    function finish(idx) {
      cleanup();
      resolve({ index: idx, value: inputEl ? inputEl.value : undefined });
    }

    function _onKey(e) {
      // 只有最顶层 dialog 响应
      if (_dialogStack[_dialogStack.length - 1] !== instance) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(escIndex);
      } else if (e.key === 'Enter' && !(e.target && e.target.tagName === 'TEXTAREA')) {
        // Enter 默认确认(accent 按钮)
        e.preventDefault();
        e.stopPropagation();
        finish(accentIdx);
      }
    }

    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) {
        // 点遮罩关闭(等价 ESC)
        finish(escIndex);
      }
      var btn = e.target.closest('button[data-idx]');
      if (btn) finish(+btn.dataset.idx);
    });
    document.addEventListener('keydown', _onKey, true);

    var instance = { _overlay: overlay, resolve: finish };
    _dialogStack.push(instance);

    // 出场动画
    overlay.classList.add('uik-dlg-enter');
    _nextFrame(function() { overlay.classList.add('uik-dlg-enter-active'); });

    // 自动聚焦 input 或 accent 按钮
    setTimeout(function() {
      if (inputEl) inputEl.focus();
      else {
        var def = overlay.querySelector('button.w10-btn-accent') || overlay.querySelector('button');
        if (def) def.focus();
      }
    }, 60);
  });
}

function confirm(message, opts) {
  opts = opts || {};
  return dialog({
    title: opts.title || '',
    message: message,
    buttons: opts.buttons || ['取消', '确认'],
    danger: opts.danger,
    escIndex: 0
  }).then(function(res) {
    return res.index === 1;
  });
}

function alert(message, opts) {
  opts = opts || {};
  return dialog({
    title: opts.title || '',
    message: message,
    buttons: ['确定'],
    escIndex: 0
  }).then(function() { return undefined; });
}

function prompt(message, opts) {
  opts = opts || {};
  return dialog({
    title: opts.title || '',
    message: message,
    input: {
      placeholder: opts.placeholder || '',
      value: opts.defaultValue || '',
      type: opts.type || 'text'
    },
    buttons: opts.buttons || ['取消', '确认'],
    escIndex: 0
  }).then(function(res) {
    return res.index === 1 ? res.value : null;
  });
}

// ============================================================
//  全局控制
// ============================================================

function closeAllPopups() {
  // 关闭所有 select 面板
  var list = _activePopups.slice();
  for (var i = 0; i < list.length; i++) {
    try { list[i].close(); } catch(e) {}
  }
  // 关闭所有 dialog(极端情况,一般不触发)
  var dlgs = _dialogStack.slice();
  for (var j = 0; j < dlgs.length; j++) {
    try { dlgs[j].resolve(-1); } catch(e) {}
  }
}

// ============================================================
//  导出
// ============================================================

window.UIKit = {
  select: createSelect,
  bindSelect: bindSelect,
  enhance: enhance,
  wheelEnabled: _wheelParamEnabled,   // 滚轮调参总开关(默认关), 供各磁贴自己的滚轮处理复用
  dialog: dialog,
  confirm: confirm,
  alert: alert,
  prompt: prompt,
  closeAllPopups: closeAllPopups
};

})();
