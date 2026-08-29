// ============================================================
//  tile-dock.js —— 「Dock」设置磁贴
//  集中管理右侧快捷栏(Dock)的全部设置:开关 / 不透明度 / 模糊 / 左右位置。
//  (编辑排序、增删动作在后续批次接入。)
//  运行时容器与渲染在 core/dock.js, 这里只负责改 storage + 调 window.Dock 即时生效。
// ============================================================
(function() {
'use strict';

function _opacity() { var v = TileAPI.storage.get('dock.opacity'); return (v == null) ? 0.92 : v; }
function _blur()    { var v = TileAPI.storage.get('dock.blur');    return (v == null) ? 6    : v; }
function _scale()   { var v = parseFloat(TileAPI.storage.get('dock.scale')); return (isFinite(v) && v > 0) ? v : 1; }
function _iconScale() { var v = parseFloat(TileAPI.storage.get('dock.iconScale')); return (isFinite(v) && v > 0) ? v : 1; }
function _side()    { return TileAPI.storage.get('dock.side') || 'right'; }
function _enabled() { return TileAPI.storage.get('appearance.dockEnabled') !== false; }

function renderFront(container) {
  container.innerHTML =
    '<div class="tile-icon">🧰</div>' +
    '<div class="tile-label">Dock</div>';
}

function _renderPanel(container) {
  var en = _enabled();
  var op = _opacity();
  var bl = _blur();
  var sc = _scale();
  var ic = _iconScale();
  var side = _side();
  container.innerHTML =
    '<div class="w10-panel">' +
      '<div class="w10-section-title">右侧快捷栏 (Dock)</div>' +

      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">启用 Dock</div><div class="w10-row-desc">右侧固定图标栏,一键访问常用动作;关闭时界面保持不变</div></div>' +
        '<div class="w10-row-right"><div class="w10-toggle' + (en ? ' on' : '') + '" id="togDockEnable"></div></div>' +
      '</div>' +

      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">位置</div></div>' +
        '<div class="w10-row-right">' +
          '<button class="w10-btn' + (side === 'left' ? ' w10-btn-accent' : '') + '" data-dock-side="left">左侧</button>' +
          '<button class="w10-btn' + (side === 'right' ? ' w10-btn-accent' : '') + '" data-dock-side="right">右侧</button>' +
        '</div>' +
      '</div>' +

      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">Dock 大小</div><div class="w10-row-desc">调整 Dock 图标 / 宽度(默认为半个标准磁贴)</div></div>' +
        '<div class="w10-row-right"><div class="w10-slider">' +
          '<input type="range" id="inpDockScale" min="0.5" max="2" step="0.05" value="' + sc + '">' +
          '<span class="w10-slider-val" id="inpDockScaleVal">' + Math.round(sc * 100) + '%</span>' +
        '</div></div>' +
      '</div>' +

      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">图标大小</div><div class="w10-row-desc">单独调 Dock 内图标大小(不改 Dock 宽度)</div></div>' +
        '<div class="w10-row-right"><div class="w10-slider">' +
          '<input type="range" id="inpDockIconScale" min="0.5" max="1.5" step="0.05" value="' + ic + '">' +
          '<span class="w10-slider-val" id="inpDockIconScaleVal">' + Math.round(ic * 100) + '%</span>' +
        '</div></div>' +
      '</div>' +

      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">不透明度</div></div>' +
        '<div class="w10-row-right"><div class="w10-slider">' +
          '<input type="range" id="inpDockOpacity" min="0" max="1" step="0.05" value="' + op + '">' +
          '<span class="w10-slider-val" id="inpDockOpacityVal">' + Math.round(op * 100) + '%</span>' +
        '</div></div>' +
      '</div>' +

      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">模糊</div></div>' +
        '<div class="w10-row-right"><div class="w10-slider">' +
          '<input type="range" id="inpDockBlur" min="0" max="20" step="1" value="' + bl + '">' +
          '<span class="w10-slider-val" id="inpDockBlurVal">' + bl + 'px</span>' +
        '</div></div>' +
      '</div>' +
    '</div>';
  _bind(container);
}

function _bind(container) {
  // 开关
  var tog = container.querySelector('#togDockEnable');
  if (tog) tog.addEventListener('click', function() {
    var now = !_enabled();
    TileAPI.storage.set('appearance.dockEnabled', now);
    tog.classList.toggle('on', now);
    TileAPI.emit('dock:toggle', { enabled: now });   // dock.js 负责建/显隐容器
  });

  // 左右位置
  container.querySelectorAll('[data-dock-side]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var s = btn.dataset.dockSide;
      TileAPI.storage.set('dock.side', s);
      container.querySelectorAll('[data-dock-side]').forEach(function(b) {
        b.classList.toggle('w10-btn-accent', b.dataset.dockSide === s);
      });
      if (window.Dock) window.Dock.applyDisplay();
    });
  });

  // 不透明度
  var op = container.querySelector('#inpDockOpacity');
  var opVal = container.querySelector('#inpDockOpacityVal');
  if (op) op.addEventListener('input', function() {
    var v = parseFloat(this.value);
    if (opVal) opVal.textContent = Math.round(v * 100) + '%';
    TileAPI.storage.set('dock.opacity', v);
    if (window.Dock) window.Dock.applyDisplay();
  });

  // 模糊
  var bl = container.querySelector('#inpDockBlur');
  var blVal = container.querySelector('#inpDockBlurVal');
  if (bl) bl.addEventListener('input', function() {
    var v = parseInt(this.value, 10) || 0;
    if (blVal) blVal.textContent = v + 'px';
    TileAPI.storage.set('dock.blur', v);
    if (window.Dock) window.Dock.applyDisplay();
  });

  // Dock 大小(缩放)
  var sc = container.querySelector('#inpDockScale');
  var scVal = container.querySelector('#inpDockScaleVal');
  if (sc) sc.addEventListener('input', function() {
    var v = parseFloat(this.value) || 1;
    if (scVal) scVal.textContent = Math.round(v * 100) + '%';
    TileAPI.storage.set('dock.scale', v);
    if (window.Dock) window.Dock.applyWidth();
  });

  // 图标大小(独立缩放)
  var ic = container.querySelector('#inpDockIconScale');
  var icVal = container.querySelector('#inpDockIconScaleVal');
  if (ic) ic.addEventListener('input', function() {
    var v = parseFloat(this.value) || 1;
    if (icVal) icVal.textContent = Math.round(v * 100) + '%';
    TileAPI.storage.set('dock.iconScale', v);
    if (window.Dock) window.Dock.applyDisplay();
  });
}

TileAPI.registerTile({
  id: 'dock',
  group: 'main',
  icon: '🧰',
  label: 'Dock',
  desc: '右侧快捷栏设置',
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 4 },
  renderFront: renderFront,
  onExpand: function(container) { _renderPanel(container); }
});

})();
