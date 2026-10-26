(function() {
'use strict';

var VERSION = '6.6.4';

// 全局接口 —— 由 app.js 启动流程调用
window._welcomeOverlay = {
  /**
   * 在启动 loading 遮罩上原地替换成欢迎页, 等用户点"开始使用"
   * 返回 Promise,resolve 代表用户已经点了按钮(遮罩淡出后 resolve)
   *
   * 原版这里还会向作者服务器拉公告和"联系与资源"链接; 去云化后全部删除,
   * 欢迎页只剩版本信息和三步上手提示 (见 docs/去云化评估.md 阶段 A 的文案要求)。
   */
  showAndWait: function() { return _showAndWait(); }
};

// ============================================================
//  欢迎页构建
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
        '<span class="welcome-badge welcome-badge-accent">不连作者服务器</span>' +
      '</div>' +

      '<div class="welcome-steps">' +
        '<div class="welcome-section-title">三步开始</div>' +
        '<ol class="welcome-step-list">' +
          '<li>在顶部 <b>⚡ 算力</b> 里选一个服务商, 填上你自己的 API Key (AJI / GRS / 墨墨 / 自定义渠道)</li>' +
          '<li>在 Photoshop 里框选一块区域 (作为这次生成的参考图)</li>' +
          '<li>写好提示词, 点 <b>生成</b></li>' +
        '</ol>' +
        '<div class="welcome-note">所有出图请求都直接发给你自己配置的服务商, 不需要登录, 也不经过作者的任何服务器。</div>' +
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

    _bindInteractions(stage, resolve);

    // 下一帧触发欢迎页入场动画
    requestAnimationFrame(function() {
      if (card) card.classList.add('welcome-visible');
    });
  });
}

// ============================================================
//  事件绑定
// ============================================================

function _bindInteractions(root, resolvePromise) {
  var btn = root.querySelector('#welcomeBtnStart');
  if (btn) btn.addEventListener('click', function() {
    _closeAndResolve(resolvePromise);
  });

  // ESC = 直接进入
  var escHandler = function(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      _closeAndResolve(resolvePromise);
    }
  };
  document.addEventListener('keydown', escHandler, true);
  root._welcomeEscHandler = escHandler;
}

function _closeAndResolve(resolvePromise) {
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

})();
