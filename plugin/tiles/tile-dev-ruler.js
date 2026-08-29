// ============================================================
//  tile-dev-ruler.js — 开发用宽度尺子磁贴
//
//  用途: 让用户在拖动 UXP 面板宽度时, 实时看到当前各种关键宽度数字,
//        以便了解自己实际使用的分辨率范围, 后续磁贴宽度自适应优化照此调.
//
//  显示内容:
//   - UXP 面板总宽度 (window.innerWidth)
//   - UXP 面板总高度 (window.innerHeight)
//   - 当前磁贴 (本磁贴) 在面板里的展开宽度
//   - 全屏展开时的可视宽度 (估算)
//   - 当前 layout 分类名 (narrow / tall / square / wideshort / wide)
//   - 一个阈值参考条, 标出 200 / 300 / 400 三道分界线
// ============================================================
(function() {
'use strict';

if (!window.TileAPI) return;

// 跟引擎里 _calcLayout 同步 (定义在 core/tile-engine.js:1445)
function _calcLayout(w, h) {
  if (w < 200) return 'narrow';
  if (w < 300 && h > w * 1.3) return 'tall';
  if (w >= 400 && w > h * 1.8) return 'wideshort';
  if (w < 400) return 'square';
  return 'wide';
}

function renderFront(container, w, h) {
  var dpr = window.devicePixelRatio || 1;
  var pw = window.innerWidth || 0;
  var pwPhys = Math.round(pw * dpr);
  if (w >= 2) {
    container.innerHTML =
      '<div class="tile-icon">📏</div>' +
      '<div class="tile-label">尺子</div>' +
      '<div class="tile-desc" style="font-size:11px;opacity:0.7;">' + pwPhys + '物理 · ' + pw + 'css</div>';
  } else {
    container.innerHTML =
      '<div class="tile-icon">📏</div>' +
      '<div class="tile-label">' + pwPhys + '</div>';
  }
}

function _refreshFront() {
  if (!window.TileEngine) return;
  var el = TileEngine.getTileElement('dev-ruler');
  if (!el) return;
  if (el.classList.contains('panel-mode')) return;
  var inner = el.querySelector('.tile-inner:not(.folder-grid-inner)') || el.querySelector('.tile-flip-front');
  if (inner) renderFront(inner, +el.dataset.w || 1, +el.dataset.h || 1);
}

function _renderPanel(container, sizeHint) {
  var dpr = window.devicePixelRatio || 1;
  var panelW = window.innerWidth || 0;
  var panelH = window.innerHeight || 0;
  var contentW = (sizeHint && sizeHint.width) || 0;
  var contentH = (sizeHint && sizeHint.height) || 0;
  // 物理像素 = CSS 像素 × DPR (跟截图尺子对齐)
  var panelW_phys = Math.round(panelW * dpr);
  var panelH_phys = Math.round(panelH * dpr);
  var contentW_phys = Math.round(contentW * dpr);
  var contentH_phys = Math.round(contentH * dpr);
  // 屏幕本身的物理分辨率参考(给你确认 DPR 算对了)
  var scrW = window.screen ? window.screen.width : 0;
  var scrH = window.screen ? window.screen.height : 0;
  var scrW_phys = Math.round(scrW * dpr);
  var scrH_phys = Math.round(scrH * dpr);

  var layout = _calcLayout(contentW, contentH);

  // 阈值参考条: 0 - 200 - 300 - 400 - 800 (基于 CSS 像素, 跟引擎 _calcLayout 一致)
  var maxScale = 800;
  var pos = Math.min(100, Math.round((contentW / maxScale) * 100));

  container.innerHTML =
    '<div class="w10-panel dvr-panel">' +
      '<div class="dvr-section">📐 UXP 面板 (跟截图尺子对齐看物理像素)</div>' +
      '<div class="dvr-row">' +
        '<span class="dvr-label">总宽度 (物理 px)</span>' +
        '<span class="dvr-value dvr-value-big">' + panelW_phys + '</span>' +
      '</div>' +
      '<div class="dvr-row">' +
        '<span class="dvr-label">总宽度 (CSS px)</span>' +
        '<span class="dvr-value">' + panelW + '</span>' +
      '</div>' +
      '<div class="dvr-row">' +
        '<span class="dvr-label">总高度 (物理 / CSS)</span>' +
        '<span class="dvr-value">' + panelH_phys + ' / ' + panelH + '</span>' +
      '</div>' +
      '<div class="dvr-row">' +
        '<span class="dvr-label">系统缩放 (DPR)</span>' +
        '<span class="dvr-value">' + dpr + 'x</span>' +
      '</div>' +

      '<div class="dvr-section">📦 当前磁贴展开区</div>' +
      '<div class="dvr-row">' +
        '<span class="dvr-label">内容宽度 (物理 px)</span>' +
        '<span class="dvr-value dvr-value-big">' + contentW_phys + '</span>' +
      '</div>' +
      '<div class="dvr-row">' +
        '<span class="dvr-label">内容宽度 (CSS px)</span>' +
        '<span class="dvr-value">' + contentW + '</span>' +
      '</div>' +
      '<div class="dvr-row">' +
        '<span class="dvr-label">内容高度 (物理 / CSS)</span>' +
        '<span class="dvr-value">' + contentH_phys + ' / ' + contentH + '</span>' +
      '</div>' +
      '<div class="dvr-row">' +
        '<span class="dvr-label">布局类型 (按 CSS 算)</span>' +
        '<span class="dvr-value dvr-layout dvr-layout-' + layout + '">' + layout + '</span>' +
      '</div>' +

      '<div class="dvr-section">📊 宽度参考条 (CSS 像素阈值)</div>' +
      '<div class="dvr-bar-wrap">' +
        '<div class="dvr-bar">' +
          '<div class="dvr-bar-seg dvr-seg-narrow"   style="left:0%;width:25%;"   title="narrow (&lt;200)"></div>' +
          '<div class="dvr-bar-seg dvr-seg-square"   style="left:25%;width:12.5%;" title="square (200-300)"></div>' +
          '<div class="dvr-bar-seg dvr-seg-square2"  style="left:37.5%;width:12.5%;" title="square (300-400)"></div>' +
          '<div class="dvr-bar-seg dvr-seg-wide"     style="left:50%;width:50%;"  title="wide (≥400)"></div>' +
          '<div class="dvr-bar-marker" style="left:' + pos + '%;"></div>' +
        '</div>' +
        '<div class="dvr-bar-scale">' +
          '<span>0</span><span>200</span><span>300</span><span>400</span><span>800+</span>' +
        '</div>' +
      '</div>' +

      '<div class="dvr-section">🖥 屏幕参考</div>' +
      '<div class="dvr-row">' +
        '<span class="dvr-label">屏幕物理 (CSS)</span>' +
        '<span class="dvr-value">' + scrW_phys + '×' + scrH_phys + ' (' + scrW + '×' + scrH + ')</span>' +
      '</div>' +

      '<div class="dvr-hint">' +
        '<b>物理像素</b> = 你截图尺子量的数字 (要看就看这个)<br>' +
        '<b>CSS 像素</b> = 浏览器/UXP 给的数字 = 物理 ÷ DPR<br>' +
        '布局类型按 <b>CSS 像素</b>算 (DPR 不影响阈值判定)<br>' +
        '<br>' +
        '<span style="opacity:0.65;">阈值: &lt;200=narrow, 200-400=square, &gt;=400=wide</span>' +
      '</div>' +
    '</div>';
}

// 注册磁贴
TileAPI.registerTile({
  id: 'dev-ruler',
  group: 'main',
  icon: '📏',
  label: '宽度尺子',
  desc: '开发用 · 测量 UXP 面板和磁贴展开宽度',
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 4 },

  renderFront: renderFront,

  onExpand: function(container, sizeHint) {
    _renderPanel(container, sizeHint);

    // 实时刷新: 监听窗口 resize, 重绘
    var _ro = null;
    var _winResize = function() {
      // 用 sizeHint 的 width/height 是初始值, 重绘时要用 container 的实际尺寸
      var w = container.clientWidth || (sizeHint && sizeHint.width) || 0;
      var h = container.clientHeight || (sizeHint && sizeHint.height) || 0;
      _renderPanel(container, { width: w, height: h });
      _refreshFront();
    };
    window.addEventListener('resize', _winResize);

    // 用 ResizeObserver 监听 container 自己的尺寸变化 (磁贴本身缩放时也要刷新)
    if (typeof ResizeObserver !== 'undefined') {
      try {
        _ro = new ResizeObserver(function() {
          var w = container.clientWidth || 0;
          var h = container.clientHeight || 0;
          _renderPanel(container, { width: w, height: h });
        });
        _ro.observe(container);
      } catch (e) {}
    }

    return function() {
      window.removeEventListener('resize', _winResize);
      if (_ro) try { _ro.disconnect(); } catch (e) {}
    };
  }
});

// 窗口尺寸变化时, 也刷一下磁贴正面的数字
window.addEventListener('resize', function() {
  _refreshFront();
});

})();
