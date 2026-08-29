// ============================================================
//  tile-firstrun-satellite.js — 卫星插件推荐弹窗 (独立于功能导览)
//
//  做的事:
//   - 首次启动场景: 在主欢迎导览关闭后 2 秒弹这个小窗
//   - 老用户场景: 主欢迎已看过但卫星推荐没弹过 → 启动后直接弹
//   - 三种关闭方式, flag 处理方式不同:
//       · 「立即安装」 → 触发 host 安装 + 标记已弹过
//       · 「稍后再说」 → 不标记, 下次启动还会弹 (温柔的不断提醒)
//       · 「不再提示」 → 标记已弹过, 永不再弹
//
//  存储 key:
//   - firstrun.satelliteShown   (boolean)
//
//  以后想再推一波 (出新版本想让老用户也看到): 清掉这个 flag 即可,
//  不会重弹主功能导览.
// ============================================================
(function() {
'use strict';

if (!window.TileAPI) return;

var SHOWN_KEY = 'firstrun.satelliteShown';
var _opened = false;
var _waited = false;   // 已经响应过一次 welcomeClosed, 避免重复

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _buildHTML() {
  return '<div class="frs-overlay" id="frsOverlay">' +
    '<div class="frs-card">' +

      '<div class="frs-head">' +
        '<div class="frs-head-icon">🌐</div>' +
        '<div class="frs-head-text">' +
          '<div class="frs-head-title">强烈推荐: 装一下「轮椅遥控器」</div>' +
          '<div class="frs-head-sub">独立浮动小窗, 操作 AI 修图快很多</div>' +
        '</div>' +
      '</div>' +

      '<div class="frs-bullets">' +
        '<div class="frs-bullet"><span class="frs-bullet-icon">▶</span><span>高频按钮 — 开始 / 加批次 / 抓参考 / 提前结束 全在一个浮窗</span></div>' +
        '<div class="frs-bullet"><span class="frs-bullet-icon">⏱</span><span>实时任务进度 + 倒计时 + 延长按钮</span></div>' +
        '<div class="frs-bullet"><span class="frs-bullet-icon">🖼</span><span>已生成缩略图, 点一下 PS 就跳到对应图层</span></div>' +
        '<div class="frs-bullet"><span class="frs-bullet-icon">🪟</span><span>跟主插件并存, 摆在画布旁边不抢空间</span></div>' +
      '</div>' +

      '<div class="frs-hint">' +
        '不装也能用主插件, 主功能完全一样。安装会下载并需要关闭 PS 一次。' +
      '</div>' +

      '<div class="frs-status" id="frsStatus"></div>' +

      '<div class="frs-actions">' +
        '<button class="w10-btn frs-btn-never" id="frsBtnNever">不再提示</button>' +
        '<button class="w10-btn" id="frsBtnLater">稍后再说</button>' +
        '<button class="w10-btn w10-btn-accent" id="frsBtnInstall">📥 立即安装</button>' +
      '</div>' +

    '</div>' +
  '</div>';
}

function _close() {
  var ov = document.getElementById('frsOverlay');
  if (!ov) return;
  ov.classList.add('frs-exit');
  setTimeout(function() {
    if (ov.parentNode) ov.parentNode.removeChild(ov);
  }, 240);
}

function _markShown() {
  try { TileAPI.storage.set(SHOWN_KEY, true); } catch (e) {}
}

function _bindEvents() {
  var btnInst = document.getElementById('frsBtnInstall');
  var btnLater = document.getElementById('frsBtnLater');
  var btnNever = document.getElementById('frsBtnNever');
  var status = document.getElementById('frsStatus');

  if (btnInst) btnInst.addEventListener('click', function() {
    // 用户已经做出"想装"的决定 → 标记不再弹这个推荐窗, 关掉推荐, 打开安装引导
    _markShown();
    _close();
    if (typeof window._showSatelliteInstallGuide === 'function') {
      // 稍微延后避开关闭动画, 让引导弹窗清爽出场
      setTimeout(function() {
        window._showSatelliteInstallGuide({ reinstall: false });
      }, 260);
    } else {
      // 兜底: 万一卫星磁贴没加载 (理论不会), 直接走 host
      if (status) status.textContent = '⏳ 已请求安装, 请关注后续提示 (可能需要关闭 PS)...';
      try { TileAPI.sendToHost('installSatellite', {}); } catch (e) {
        if (status) status.textContent = '❌ 安装请求失败: ' + (e && e.message || e);
      }
    }
  });

  if (btnLater) btnLater.addEventListener('click', function() {
    // 不标记, 下次启动还会再弹
    _close();
  });

  if (btnNever) btnNever.addEventListener('click', function() {
    _markShown();
    _close();
    if (TileAPI.toast) TileAPI.toast('好的, 不会再提醒。要装的话去「卫星」磁贴里手动装。', 'info');
  });
}

function _maybeShow() {
  if (_opened) return;
  try {
    if (TileAPI.storage.get(SHOWN_KEY) === true) return;   // 已经决定过了
  } catch (e) {}
  _opened = true;
  var wrap = document.createElement('div');
  wrap.innerHTML = _buildHTML();
  while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
  _bindEvents();
}

// 触发链:
//   welcome 关闭 (或老用户场景 welcome 已看过) → emit 'firstrun:welcomeClosed' → 这里延迟 2s 弹卫星
TileAPI.on('firstrun:welcomeClosed', function() {
  if (_waited) return;
  _waited = true;
  setTimeout(_maybeShow, 2000);
});

// 调试用: 重置 satellite 状态. 只清 flag + 内部锁, 不主动 _maybeShow —
// 让 welcome 关闭后的 'firstrun:welcomeClosed' 事件链来触发, 保证顺序正确
window._firstrunResetSatellite = function() {
  try { TileAPI.storage.remove(SHOWN_KEY); } catch (e) {}
  _opened = false;
  _waited = false;
};

})();
