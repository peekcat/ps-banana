// ============================================================
//  core/emoji-pack.js — Emoji 图片化(Fluent Emoji)
//  把界面里的 emoji 文字替换成 icons/emoji/<style>/<码点>.svg 的 <img>。
//  - 风格: 'off'(原生) | 'flat' | 'color', 用户在设置里切, 存 appearance.emojiStyle
//  - 只替换 manifest 里有的码点(116 个), 没有的保持原生
//  - 跳过 <input>/<textarea>/<select>/<option>/contenteditable, 不破坏打字
//  - MutationObserver 跟随动态重渲(防抖 + 处理时断开监听, 避免自激)
//  对外: window.EmojiPack.{ init, setStyle, getStyle }
// ============================================================
(function() {
'use strict';

// 注入 .emoji-img 样式(随字号缩放, 像文字一样排版)
(function() {
  try {
    var st = document.createElement('style');
    st.textContent = '.emoji-img{width:1em;height:1em;vertical-align:-0.15em;display:inline-block;object-fit:contain;user-select:none;}';
    (document.head || document.documentElement).appendChild(st);
  } catch (e) {}
})();

var STYLE_KEY = 'appearance.emojiStyle';
var BASE = 'icons/emoji/';
var SKIP_TAGS = { INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, SCRIPT: 1, STYLE: 1 };

var _style = 'off';
var _set = null;
var _observer = null;
var _queue = [];
var _timer = null;

var _picRe = /\p{Extended_Pictographic}/u;
var _picReG = /(\p{Extended_Pictographic}️?)/gu;

function _avail() {
  if (!_set) _set = new Set(window._emojiPackCodepoints || []);
  return _set;
}

// 与抽图脚本一致的归一化: 去 fe0f, 每段去前导零
function _keyOf(str) {
  var parts = [];
  for (var i = 0; i < str.length; i++) {
    var cp = str.codePointAt(i);
    if (cp > 0xffff) i++; // surrogate pair
    var h = cp.toString(16);
    if (h === 'fe0f') continue;
    parts.push(h.replace(/^0+/, '') || '0');
  }
  return parts.join('-');
}

function _skipAncestor(el) {
  while (el && el.nodeType === 1) {
    if (SKIP_TAGS[el.tagName]) return true;
    if (el.isContentEditable) return true;
    if (el.classList && el.classList.contains('emoji-img')) return true;
    el = el.parentNode;
  }
  return false;
}

function _processTextNode(node) {
  var text = node.nodeValue;
  if (!text || !_picRe.test(text)) return;
  if (_skipAncestor(node.parentNode)) return;
  var avail = _avail();
  var frag = null, last = 0, m, changed = false;
  _picReG.lastIndex = 0;
  while ((m = _picReG.exec(text))) {
    var emoji = m[1];
    var key = _keyOf(emoji);
    if (!avail.has(key)) continue;            // 不在包里 → 保持原生
    if (!frag) frag = document.createDocumentFragment();
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    var img = document.createElement('img');
    img.className = 'emoji-img';
    img.src = BASE + _style + '/' + key + '.svg';
    img.alt = emoji;
    img.setAttribute('data-emoji', emoji);
    img.setAttribute('draggable', 'false');
    frag.appendChild(img);
    last = m.index + emoji.length;
    changed = true;
  }
  if (!changed) return;
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  if (node.parentNode) node.parentNode.replaceChild(frag, node);
}

function _walk(root) {
  if (!root || _style === 'off') return;
  if (root.nodeType === 3) { _processTextNode(root); return; }
  if (root.nodeType !== 1) return;
  if (SKIP_TAGS[root.tagName] || root.isContentEditable) return;
  if (root.classList && root.classList.contains('emoji-img')) return;
  var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function(n) {
      if (!n.nodeValue || !_picRe.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
      var p = n.parentNode;
      if (p && (SKIP_TAGS[p.tagName] || p.isContentEditable ||
                (p.classList && p.classList.contains('emoji-img')))) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  var nodes = [];
  while (tw.nextNode()) nodes.push(tw.currentNode);
  for (var i = 0; i < nodes.length; i++) _processTextNode(nodes[i]);
}

function _connect() {
  if (_observer) return;
  _observer = new MutationObserver(function(muts) {
    if (_style === 'off') return;
    for (var i = 0; i < muts.length; i++) {
      var added = muts[i].addedNodes;
      for (var j = 0; j < added.length; j++) _queue.push(added[j]);
    }
    if (_queue.length && !_timer) _timer = setTimeout(_flush, 80);
  });
  _observer.observe(document.body, { childList: true, subtree: true });
}
function _disconnect() { if (_observer) { _observer.disconnect(); _observer = null; } }

function _flush() {
  _timer = null;
  var q = _queue; _queue = [];
  if (_style === 'off' || !q.length) return;
  _disconnect();                 // 处理期间断开, 避免自己插入的 <img> 触发自激
  for (var i = 0; i < q.length; i++) { try { _walk(q[i]); } catch (e) {} }
  _connect();
}

function _restyleAll() {
  var imgs = document.querySelectorAll('img.emoji-img');
  for (var i = 0; i < imgs.length; i++) {
    var file = imgs[i].getAttribute('src');
    file = file.substring(file.lastIndexOf('/') + 1);
    imgs[i].src = BASE + _style + '/' + file;
  }
}
function _revertAll() {
  var imgs = document.querySelectorAll('img.emoji-img');
  for (var i = 0; i < imgs.length; i++) {
    var img = imgs[i];
    var e = img.getAttribute('data-emoji') || '';
    if (img.parentNode) img.parentNode.replaceChild(document.createTextNode(e), img);
  }
}

function setStyle(style) {
  style = (style === 'flat' || style === 'color') ? style : 'off';
  if (style === _style) return;
  var prev = _style;
  _style = style;
  try { if (window._storageManager) window._storageManager.set(STYLE_KEY, style); } catch (e) {}

  if (style === 'off') {
    _disconnect();
    _revertAll();
  } else if (prev === 'off') {
    _connect();
    _disconnect();                 // 首次全量扫描期间不监听
    try { _walk(document.body); } catch (e) {}
    _connect();
  } else {
    _restyleAll();                 // flat<->color 只换 src 文件夹
  }
}

function init() {
  var saved = 'off';
  try { saved = (window._storageManager && window._storageManager.get(STYLE_KEY)) || 'off'; } catch (e) {}
  _style = 'off';
  setStyle(saved);                 // saved==='off' 时为 no-op
}

window.EmojiPack = { init: init, setStyle: setStyle, getStyle: function() { return _style; } };

})();
