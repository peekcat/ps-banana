/**
 * message-bridge.js — 传话系统
 * 前端和后端之间互相发消息的通道，格式兼容旧版
 */
(function() {
'use strict';

var _handlers = {}; // action -> [handler, handler, ...]

var MessageBridge = {
  /**
   * 发消息给后端
   */
  sendToHost: function(action, data) {
    var msg = { source: 'panel', action: action, data: data || {} };
    try {
      if (window.uxpHost && window.uxpHost.postMessage) {
        window.uxpHost.postMessage(msg);
      } else if (window.parent && window.parent !== window) {
        window.parent.postMessage(msg, '*');
      } else {
        window.postMessage(msg, '*');
      }
    } catch(e) {
      console.error('[MessageBridge] sendToHost failed:', e);
    }
  },

  /**
   * 注册一个后端消息的处理函数
   */
  onHostMessage: function(action, handler) {
    if (!_handlers[action]) _handlers[action] = [];
    _handlers[action].push(handler);
  },

  /**
   * 取消注册
   */
  offHostMessage: function(action, handler) {
    if (!_handlers[action]) return;
    var idx = _handlers[action].indexOf(handler);
    if (idx >= 0) _handlers[action].splice(idx, 1);
  },

  /**
   * 分发一条后端发来的消息
   */
  _dispatch: function(msg) {
    if (!msg || msg.source !== 'host') return;
    var action = msg.action;
    var data = msg.data;
    if (_handlers[action]) {
      var list = _handlers[action].slice(); // 复制一份避免修改
      for (var i = 0; i < list.length; i++) {
        try { list[i](data); } catch(e) { console.error('[MessageBridge] handler error for ' + action + ':', e); }
      }
    }
  },

  /**
   * 初始化：开始监听后端消息
   */
  init: function() {
    var self = this;
    window.addEventListener('message', function(e) {
      var msg = e.data;
      if (msg && msg.source === 'host') {
        self._dispatch(msg);
      }
    });
  },
};

window._messageBridge = MessageBridge;
})();
