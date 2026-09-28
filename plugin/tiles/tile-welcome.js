(function() {
'use strict';

var VERSION = '6.6.4';
var ANNOUNCEMENT_TIMEOUT_MS = 5000;

// 全局接口 —— 由 app.js 启动流程调用
window._welcomeOverlay = {
  /**
   * 在启动 loading 遮罩上原地替换成欢迎页,发公告请求,等用户点"开始使用"
   * 返回 Promise,resolve 代表用户已经点了按钮(遮罩淡出后 resolve)
   */
  showAndWait: function() { return _showAndWait(); }
};

// ============================================================
//  欢迎页构建 + 公告请求
// ============================================================

function _buildWelcomeHTML() {
  return '' +
    '<div class="welcome-card" id="welcomeCard">' +

      '<div class="welcome-head">' +
        '<div class="welcome-logo">♿</div>' +
        '<div class="welcome-titles">' +
          '<div class="welcome-title">夏三七的修图轮椅</div>' +
          '<div class="welcome-subtitle">版本 v' + VERSION + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="welcome-badges">' +
        '<span class="welcome-badge welcome-badge-green">免费开源</span>' +
        '<span class="welcome-badge welcome-badge-blue">GPL v3</span>' +
        '<span class="welcome-badge welcome-badge-accent">磁贴化</span>' +
      '</div>' +

      '<div class="welcome-announce" id="welcomeAnnounce">' +
        '<div class="welcome-announce-head">公告</div>' +
        '<div class="welcome-announce-loading" id="welcomeAnnounceLoading">' +
          '<span class="boot-spinner boot-spinner-sm"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></span>' +
          '<span>正在加载公告…</span>' +
        '</div>' +
        '<div class="welcome-announce-body is-hidden" id="welcomeAnnounceBody"></div>' +
      '</div>' +

      '<div class="welcome-section-title">联系与资源</div>' +
      '<div class="welcome-contacts" id="welcomeContacts">' +
        '<div class="welcome-contacts-empty">加载中…</div>' +
      '</div>' +

      '<div class="welcome-disclaimer">' +
        '<strong>免责声明</strong>:本插件仅供合法图像后期处理使用。作者不对用户生成内容承担任何法律责任。使用即表示同意此条款。' +
      '</div>' +

      // 吸底操作区:按钮始终固定在视口底部
      '<div class="welcome-actions-sticky">' +
        '<div class="welcome-actions">' +
          '<button class="w10-btn w10-btn-accent welcome-btn-primary" id="welcomeBtnStart">开始使用</button>' +
        '</div>' +
        '<div class="welcome-foot">' +
          '<span>夏三七 · ' + new Date().getFullYear() + '</span>' +
        '</div>' +
      '</div>' +

      // 窗口过窄时的引导提示(CSS 媒体查询控制显隐)
      '<div class="welcome-hint-resize">看不到「开始使用」按钮?请下拉内容或扩大面板</div>' +

    '</div>';
}

function _showAndWait() {
  return new Promise(function(resolve) {
    var stage = document.getElementById('bootStage');
    if (!stage) { resolve(); return; }

    // 原地替换:遮罩保留,内容从"启动 loading"换成"欢迎页"
    stage.innerHTML = _buildWelcomeHTML();
    var card = stage.querySelector('#welcomeCard');

    // 绑定事件
    _bindInteractions(stage, resolve);

    // 公告请求 + 5 秒超时
    _requestAnnouncement(stage);

    // 下一帧触发欢迎页入场动画
    requestAnimationFrame(function() {
      if (card) card.classList.add('welcome-visible');
    });
  });
}

// ============================================================
//  事件绑定
// ============================================================

var _announcementReceived = false;
var _announcementTimer = null;

function _bindInteractions(root, resolvePromise) {
  // 开始使用按钮
  var btn = root.querySelector('#welcomeBtnStart');
  if (btn) btn.addEventListener('click', function() {
    _tryProceed(resolvePromise);
  });

  // ESC = 尝试进入
  var escHandler = function(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      _tryProceed(resolvePromise);
    }
  };
  document.addEventListener('keydown', escHandler, true);
  root._welcomeEscHandler = escHandler;
}

function _tryProceed(resolvePromise) {
  if (_announcementReceived) {
    _closeAndResolve(resolvePromise);
    return;
  }
  // 公告还没回来 → 二次确认
  var msg = '公告正在加载,要跳过吗?';
  if (window.TileAPI && TileAPI.confirm) {
    TileAPI.confirm(msg).then(function(ok) {
      if (ok) _closeAndResolve(resolvePromise);
    });
  } else {
    // UIKit 没加载?兜底直接跳过
    _closeAndResolve(resolvePromise);
  }
}

function _closeAndResolve(resolvePromise) {
  if (_announcementTimer) { clearTimeout(_announcementTimer); _announcementTimer = null; }
  var overlay = document.getElementById('bootOverlay');
  if (!overlay) { resolvePromise(); return; }

  // 清理 ESC 监听
  var stage = document.getElementById('bootStage');
  if (stage && stage._welcomeEscHandler) {
    document.removeEventListener('keydown', stage._welcomeEscHandler, true);
    stage._welcomeEscHandler = null;
  }

  overlay.classList.add('boot-exit');
  setTimeout(function() {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    resolvePromise();
  }, 380);
}

// ============================================================
//  公告请求
// ============================================================

function _requestAnnouncement(root) {
  _announcementReceived = false;
  if (_announcementTimer) clearTimeout(_announcementTimer);

  // 5 秒超时
  _announcementTimer = setTimeout(function() {
    if (_announcementReceived) return;
    _renderAnnouncementError('公告加载失败(超时)');
    _renderLinksFallback();
    _announcementTimer = null;
  }, ANNOUNCEMENT_TIMEOUT_MS);

  // 发请求
  if (window.TileAPI) {
    TileAPI.sendToHost('cloudGetAnnouncement');
  }
}

function _renderAnnouncementContent(html) {
  _announcementReceived = true;
  if (_announcementTimer) { clearTimeout(_announcementTimer); _announcementTimer = null; }
  var loading = document.getElementById('welcomeAnnounceLoading');
  var body = document.getElementById('welcomeAnnounceBody');
  if (loading) loading.classList.add('is-hidden');
  if (body) {
    body.classList.remove('is-hidden', 'is-error');
    // bug #3: 公告来自服务器, 清洗后再 innerHTML(去 script/on*/危险协议)
    body.innerHTML = (window.TileAPI && TileAPI.sanitizeHtml) ? TileAPI.sanitizeHtml(html || '') : _escapeHTML(html || '');
  }
}

function _renderAnnouncementError(text) {
  _announcementReceived = true; // 标记为"已结束等待",让按钮直接通过
  var loading = document.getElementById('welcomeAnnounceLoading');
  var body = document.getElementById('welcomeAnnounceBody');
  if (loading) loading.classList.add('is-hidden');
  if (body) {
    body.classList.remove('is-hidden');
    body.classList.add('is-error');
    body.textContent = text;
  }
}

// ============================================================
//  联系与资源链接 (后端可配, 走 PS 系统弹窗 openUrl)
// ============================================================

function _escapeHTML(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _renderLinks(links) {
  var wrap = document.getElementById('welcomeContacts');
  if (!wrap) return;
  var valid = (links || []).filter(function(lk) {
    return lk && lk.url && String(lk.url).trim();
  });
  if (!valid.length) {
    wrap.innerHTML = '<div class="welcome-contacts-empty">暂无可用链接</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < valid.length; i++) {
    var lk = valid[i];
    var title = _escapeHTML(lk.title || '链接');
    var url = String(lk.url).trim();
    html += '<div class="welcome-contact">' +
      '<span class="welcome-contact-label">' + title + '</span>' +
      '<a class="welcome-contact-val welcome-link" data-link-url="' + _escapeHTML(url) + '">打开 →</a>' +
    '</div>';
  }
  wrap.innerHTML = html;

  // 绑定点击 → PS 系统弹窗
  wrap.querySelectorAll('[data-link-url]').forEach(function(el) {
    el.addEventListener('click', function() {
      var u = el.getAttribute('data-link-url');
      if (u && window.TileAPI) TileAPI.sendToHost('openUrl', { url: u });
    });
  });
}

function _renderLinksFallback() {
  var wrap = document.getElementById('welcomeContacts');
  if (!wrap) return;
  wrap.innerHTML = '<div class="welcome-contacts-empty">链接暂时不可用</div>';
}

// 监听后端公告结果
if (window.TileAPI) {
  TileAPI.onHostMessage('cloudAnnouncementResult', function(data) {
    // 后端可能返回:
    //   {success:true, content:"...", links:[...], data:{...}}  ← 实际格式
    //   {success:false, message:"..."}                          ← 失败
    if (!data) {
      _renderAnnouncementError('公告无返回数据');
      _renderLinksFallback();
      return;
    }
    if (data.success === false) {
      _renderAnnouncementError('公告加载失败: ' + (data.message || '未知错误'));
      _renderLinksFallback();
      return;
    }
    // 渲染公告正文
    var html = data.content || data.html || (data.data && (data.data.content || data.data.html)) || '';
    if (!html) {
      _renderAnnouncementError('暂无公告');
    } else {
      _renderAnnouncementContent(html);
    }
    // 渲染联系与资源链接 (独立于公告正文)
    var links = (data.links && data.links.length) ? data.links
              : (data.data && data.data.links) ? data.data.links
              : [];
    _renderLinks(links);
  });
}

})();
