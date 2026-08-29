// ============================================================
//  firstrun-welcome.js — 首次打开欢迎弹窗 (功能导览)
//
//  做的事:
//   - 仅"第一次"打开插件时弹一次, 介绍所有核心功能
//   - 关闭后 emit 'firstrun:welcomeClosed' 事件, 让卫星推荐弹窗接力
//
//  存储 key:
//   - firstrun.welcomeShown  (boolean)
//
//  触发时机:
//   - 监听 TileAPI 的 'app:ready' 事件 — 此时主界面已渲染, 入场动画大致开始
//   - 已看过则不弹, 直接由 tile-firstrun-satellite.js 自己判断要不要弹卫星窗
// ============================================================
(function() {
'use strict';

if (!window.TileAPI) return;

var SHOWN_KEY = 'firstrun.welcomeShown';
var _opened = false;

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _buildHTML() {
  var features = [
    { icon: '📝', title: '提示词', desc: '写生成指令, 支持预设/优化器' },
    { icon: '🖼', title: '参考图', desc: '在 PS 里框选区域 → 一键抓为参考' },
    { icon: '⚙️', title: '参数', desc: '选服务商 / 模型 / 比例 / 张数' },
    { icon: '▶️', title: '开始生成', desc: '一键发起任务, 多次点 = 并发' },
    { icon: '💬', title: '对话', desc: '一问一答时间线, 点缩略图回 PS' },
    { icon: '🗂', title: '生成记录', desc: '图和提示词按任务分组归档, 一键装回复用' },
    { icon: '🎨', title: '布景/分区/海报', desc: '场景包/多文档分区/海报排版各司其职' },
    { icon: '🌐', title: '卫星遥控器', desc: '独立小窗口, 高频按钮 + 任务进度 (稍后会推荐安装)' }
  ];

  var featHtml = '';
  for (var i = 0; i < features.length; i++) {
    var f = features[i];
    featHtml += '<div class="fr-feat">' +
      '<div class="fr-feat-icon">' + _esc(f.icon) + '</div>' +
      '<div class="fr-feat-body">' +
        '<div class="fr-feat-title">' + _esc(f.title) + '</div>' +
        '<div class="fr-feat-desc">' + _esc(f.desc) + '</div>' +
      '</div>' +
    '</div>';
  }

  return '<div class="fr-overlay" id="frOverlay">' +
    '<div class="fr-card" id="frCard">' +

      '<div class="fr-head">' +
        '<div class="fr-head-icon">👋</div>' +
        '<div>' +
          '<div class="fr-head-title">第一次打开?带你 30 秒看完</div>' +
          '<div class="fr-head-sub">这些是修图轮椅的主要功能, 都是磁贴, 可以拖动 / 调大小</div>' +
        '</div>' +
      '</div>' +

      '<div class="fr-section-title">📦 核心功能</div>' +
      '<div class="fr-feats">' + featHtml + '</div>' +

      '<div class="fr-tips">' +
        '<b>小贴士</b>:' +
        '<ul>' +
          '<li>每个磁贴 <b>单击展开</b> 看详细设置, <b>长按 0.4 秒</b> 进入编辑模式(拖动 / 调大小 / 换颜色 / 收纳)</li>' +
          '<li>底栏「📐 自动排序」「📁 新建文件夹」「🗄️ 全部收纳」可重排桌面</li>' +
          '<li>第一步: 在 <b>顶部账号栏</b> 登录并填好你的 API Key(AJI/夏算力/...), 然后才能生成</li>' +
        '</ul>' +
      '</div>' +

      '<div class="fr-actions">' +
        '<button class="w10-btn" id="frBtnSkip">跳过</button>' +
        '<button class="w10-btn w10-btn-accent" id="frBtnStart">开始使用 →</button>' +
      '</div>' +

    '</div>' +
  '</div>';
}

function _close() {
  var ov = document.getElementById('frOverlay');
  if (!ov) return;
  ov.classList.add('fr-exit');
  setTimeout(function() {
    if (ov.parentNode) ov.parentNode.removeChild(ov);
    // 关闭 → 通知卫星推荐弹窗可以接力了 (它自己判断要不要弹)
    try { TileAPI.emit('firstrun:welcomeClosed'); } catch (e) {}
  }, 240);
}

function _markShown() {
  try { TileAPI.storage.set(SHOWN_KEY, true); } catch (e) {}
}

function _bindEvents() {
  var btnStart = document.getElementById('frBtnStart');
  var btnSkip = document.getElementById('frBtnSkip');

  if (btnStart) btnStart.addEventListener('click', function() {
    _markShown();
    _close();
    if (TileAPI.toast) TileAPI.toast('欢迎使用修图轮椅!记得先在顶部账号栏登录并填 API Key', 'info');
  });
  if (btnSkip) btnSkip.addEventListener('click', function() {
    _markShown();
    _close();
  });
}

function _maybeShow() {
  if (_opened) return;
  try {
    if (TileAPI.storage.get(SHOWN_KEY) === true) {
      // 没弹欢迎窗 → 也要让卫星弹窗自己判断要不要弹 (老用户场景)
      try { TileAPI.emit('firstrun:welcomeClosed'); } catch (e) {}
      return;
    }
  } catch (e) {}
  _opened = true;
  var wrap = document.createElement('div');
  wrap.innerHTML = _buildHTML();
  while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
  _bindEvents();
}

// app:ready 时尝试弹一次
TileAPI.on('app:ready', function() {
  setTimeout(_maybeShow, 1500);
});

// 调试用: 重置 welcome flag 并立刻重弹 (供 tile-satellite 的"重置弹窗记录"按钮调用)
window._firstrunResetWelcome = function() {
  try { TileAPI.storage.remove(SHOWN_KEY); } catch (e) {}
  _opened = false;
  setTimeout(_maybeShow, 100);
};

})();
