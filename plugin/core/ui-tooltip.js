/**
 * ui-tooltip.js — 全局轻量解释浮层 (暗色毛玻璃 tooltip)
 *
 * 用途: 给参数名等元素提供「指针指向 → 短延迟弹出解释」的浮层,
 *       视觉与磁贴一致(暗色 + blur), 替代原生 title 小黄条。
 *
 * 用法(声明式, 推荐):
 *   <span class="xxx" data-tip="静态解释文本">参数名</span>
 *   绑定一次容器即可: TileTip.bind(container)
 *   —— 容器内所有带 data-tip 的元素自动获得 hover 浮层。
 *
 * 用法(动态文本, 拖滑块时解释跟着变):
 *   el.dataset.tip = '';                       // 占位, 让 bind 认得它
 *   TileTip.attach(el, function() { return 当前解释字符串; });
 *   —— attach 的 getter 每次 hover 时调用, 返回最新文本。
 *
 * 关闭: 移开元素即关; 滚动 / 点击其它处也关。
 */
(function() {
'use strict';

var SHOW_DELAY = 350;   // 悬停多少毫秒后弹出
var _tipEl = null;      // 浮层 DOM (全局单例)
var _showTimer = null;
var _curTarget = null;
var _getters = new WeakMap();  // el -> function(): string  (动态文本)

function _ensureTipEl() {
  if (_tipEl) return _tipEl;
  _tipEl = document.createElement('div');
  _tipEl.className = 'tile-tip';
  _tipEl.style.display = 'none';
  document.body.appendChild(_tipEl);
  return _tipEl;
}

function _textFor(el) {
  var getter = _getters.get(el);
  if (getter) { try { return String(getter() || ''); } catch (e) { return ''; } }
  return el.getAttribute('data-tip') || '';
}

function _position(el) {
  var tip = _tipEl;
  var r = el.getBoundingClientRect();
  // 先显示以便量尺寸
  tip.style.left = '0px';
  tip.style.top = '0px';
  var tr = tip.getBoundingClientRect();
  var margin = 6;
  // 默认锚定在元素上方; 上方放不下则放下方
  var top = r.top - tr.height - margin;
  var placeBelow = false;
  if (top < 4) { top = r.bottom + margin; placeBelow = true; }
  // 水平: 左缘对齐元素, 但不超出视口
  var left = r.left;
  var maxLeft = window.innerWidth - tr.width - 4;
  if (left > maxLeft) left = maxLeft;
  if (left < 4) left = 4;
  tip.style.left = Math.round(left) + 'px';
  tip.style.top = Math.round(top) + 'px';
  tip.classList.toggle('tile-tip-below', placeBelow);
}

function _show(el) {
  var text = _textFor(el);
  if (!text) return;
  var tip = _ensureTipEl();
  tip.textContent = text;
  tip.style.display = 'block';
  _position(el);
  // 触发淡入
  tip.classList.remove('tile-tip-in');
  void tip.offsetWidth;
  tip.classList.add('tile-tip-in');
}

function _hide() {
  if (_showTimer) { clearTimeout(_showTimer); _showTimer = null; }
  _curTarget = null;
  if (_tipEl) { _tipEl.style.display = 'none'; _tipEl.classList.remove('tile-tip-in'); }
}

function _onEnter(e) {
  var el = e.currentTarget;
  _curTarget = el;
  if (_showTimer) clearTimeout(_showTimer);
  _showTimer = setTimeout(function() {
    _showTimer = null;
    if (_curTarget === el && document.body.contains(el)) _show(el);
  }, SHOW_DELAY);
}
function _onLeave() { _hide(); }

function _wire(el) {
  if (el._tileTipWired) return;
  el._tileTipWired = true;
  el.addEventListener('mouseenter', _onEnter);
  el.addEventListener('mouseleave', _onLeave);
  // 点击该元素(比如拖滑块前点参数名)也先收掉, 避免挡手
  el.addEventListener('mousedown', _onLeave);
}

var TileTip = {
  // 绑定容器内所有 [data-tip] 元素(声明式)
  bind: function(container) {
    if (!container) return;
    var els = container.querySelectorAll('[data-tip]');
    for (var i = 0; i < els.length; i++) _wire(els[i]);
  },
  // 给单个元素挂动态文本 getter
  attach: function(el, getter) {
    if (!el) return;
    if (typeof getter === 'function') _getters.set(el, getter);
    if (!el.hasAttribute('data-tip')) el.setAttribute('data-tip', '');
    _wire(el);
  },
  hide: _hide
};

// 滚动 / 全局点击时收起(避免浮层悬空)
window.addEventListener('scroll', _hide, true);
window.addEventListener('resize', _hide);

window.TileTip = TileTip;
})();
