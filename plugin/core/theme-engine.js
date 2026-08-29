/**
 * theme-engine.js — 主题引擎
 * 控制界面外观：主题色、背景图、透明度、模糊度
 */
(function() {
'use strict';

var ThemeEngine = {
  _bgImgNatW: 0,
  _bgImgNatH: 0,
  _bgZoomCache: 100,
  _bgResizeBound: false,

  init: function() {
    // settings:changed 监听已删 (该事件全代码 0 次 emit, 监听永不触发)
    // 主题变化的实际刷新走 ThemeEngine.applyThemeColor/applyBgImage/... 等方法直接调用
  },

  /** 从存储恢复主题 */
  restore: function() {
    var color = TileAPI.storage.get('appearance.themeColor');
    if (color) this.applyThemeColor(color);

    var bg = TileAPI.storage.get('appearance.bgImage');
    if (bg) this.applyBgImage(bg);

    var posX = TileAPI.storage.get('appearance.bgPosX');
    var posY = TileAPI.storage.get('appearance.bgPosY');
    if (posX != null || posY != null) this.applyBgPosition(posX != null ? posX : 50, posY != null ? posY : 50);

    var zoom = TileAPI.storage.get('appearance.bgZoom');
    if (zoom != null) this.applyBgZoom(zoom);

    var opa = TileAPI.storage.get('appearance.opacity');
    if (opa !== null && opa !== undefined) this.applyOpacity(opa);

    var blur = TileAPI.storage.get('appearance.blur');
    if (blur !== null && blur !== undefined) this.applyBlur(blur);

    var tco = TileAPI.storage.get('appearance.tileColorOpacity');
    if (tco !== null && tco !== undefined) this.applyTileColorOpacity(tco);

    var scale = TileAPI.storage.get('appearance.scale');
    if (scale) this.applyScale(scale);

    var iconScale = TileAPI.storage.get('appearance.tileIconScale');
    if (iconScale) this.applyTileIconScale(iconScale);

    var textMode = TileAPI.storage.get('appearance.textMode');
    if (textMode) this.applyTextMode(textMode);
  },

  applyTileIconScale: function(scale) {
    var n = parseFloat(scale);
    if (!isFinite(n) || n <= 0) n = 1;
    n = Math.max(0.5, Math.min(2.5, n));
    document.documentElement.style.setProperty('--tile-icon-scale', String(n));
  },

  applyThemeColor: function(hex) {
    if (!hex) return;
    var r = document.documentElement;
    // 变色"晕开": 短暂给 body 挂过渡类, 让所有用到主题色的元素一起 0.25s 渐变过去,
    // 而不是全界面瞬间跳变。窗口期后立刻摘掉, 不影响磁贴展开等其他动画。
    try {
      var b = document.body;
      if (b) {
        b.classList.add('theme-color-transition');
        clearTimeout(this._themeTransTimer);
        this._themeTransTimer = setTimeout(function() { b.classList.remove('theme-color-transition'); }, 320);
      }
    } catch (_) {}
    r.style.setProperty('--accent', hex);
    // 计算亮暗变体
    var hsl = this._hexToHSL(hex);
    if (hsl) {
      r.style.setProperty('--accent-hover', 'hsl(' + hsl.h + ',' + hsl.s + '%,' + Math.min(100, hsl.l + 10) + '%)');
      r.style.setProperty('--accent-dark', 'hsl(' + hsl.h + ',' + hsl.s + '%,' + Math.max(0, hsl.l - 15) + '%)');
      r.style.setProperty('--accent-glow', 'hsla(' + hsl.h + ',' + hsl.s + '%,' + hsl.l + '%,0.35)');
    }
  },

  applyBgImage: function(dataUrl) {
    var el = document.getElementById('bgLayer');
    if (!el) return;
    if (!dataUrl) {
      el.style.backgroundImage = '';
      this._bgImgNatW = 0;
      this._bgImgNatH = 0;
      el.style.backgroundSize = 'cover';
      return;
    }
    el.style.backgroundImage = 'url(' + dataUrl + ')';
    // 测自然尺寸, 100% = cover 基线
    var self = this;
    var img = new Image();
    img.onload = function() {
      self._bgImgNatW = img.naturalWidth;
      self._bgImgNatH = img.naturalHeight;
      // 拿到尺寸后按当前 zoom 重新算
      self.applyBgZoom(self._bgZoomCache != null ? self._bgZoomCache : 100);
    };
    img.src = dataUrl;
  },

  applyBgPosition: function(x, y) {
    var el = document.getElementById('bgLayer');
    if (el) el.style.backgroundPosition = x + '% ' + y + '%';
  },

  applyBgZoom: function(zoom) {
    var el = document.getElementById('bgLayer');
    if (!el) return;
    zoom = (zoom != null ? +zoom : 100);
    this._bgZoomCache = zoom;
    // 没有图或图自然尺寸还没拿到 → 直接 cover (= 100% 基线)
    if (!this._bgImgNatW || !this._bgImgNatH) {
      el.style.backgroundSize = 'cover';
      return;
    }
    var layerW = el.offsetWidth || (window.innerWidth + 40);
    var layerH = el.offsetHeight || (window.innerHeight + 40);
    var coverScale = Math.max(layerW / this._bgImgNatW, layerH / this._bgImgNatH);
    var finalScale = coverScale * (zoom / 100);
    var w = Math.round(this._bgImgNatW * finalScale);
    var h = Math.round(this._bgImgNatH * finalScale);
    el.style.backgroundSize = w + 'px ' + h + 'px';
    // 窗口大小变了要重算
    if (!this._bgResizeBound) {
      this._bgResizeBound = true;
      var self = this;
      var rt = null;
      window.addEventListener('resize', function() {
        if (rt) clearTimeout(rt);
        rt = setTimeout(function() { self.applyBgZoom(self._bgZoomCache); }, 120);
      });
    }
  },

  applyOpacity: function(val) {
    document.documentElement.style.setProperty('--bg-opacity', (val / 100).toFixed(2));
  },

  applyBlur: function(val) {
    document.documentElement.style.setProperty('--tile-blur', val + 'px');
  },

  applyTileColorOpacity: function(val) {
    var alpha = (val / 100).toFixed(3);
    document.documentElement.style.setProperty('--tile-color-opacity', alpha);
    if (window.TileEngine && TileEngine.restoreTileColors) TileEngine.restoreTileColors();
  },

  applyScale: function(val) {
    if (val === null || val === undefined) val = 100;
    if (val < 80) val = 80;
    if (val > 180) val = 180;
    var z = val / 100;

    document.body.style.fontSize = (12 * z) + 'px';
    document.documentElement.style.setProperty('--ui-scale', z);

    // 只缩放展开面板内容（预设/参数/设置/下拉等），不碰 grid 布局
    var styleEl = document.getElementById('ui-scale-style');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'ui-scale-style';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent =
      // 磁贴未展开时的基础文字
      '.tile-label{font-size:' + (9 * z) + 'px}' +
      // 图标字号必须保留 --tile-icon-scale 因子: 这张表比 tiles.css 后加载,
      // 写死 px 会把"磁贴图标大小"设置整个盖掉(v6.4.7 修复)
      '.tile-icon{font-size:calc(' + (18 * z) + 'px * var(--tile-icon-scale, 1))}' +
      '.tile-desc{font-size:' + (7 * z) + 'px}' +
      '.tile-badge{font-size:' + (6 * z) + 'px}' +
      '.tile-flip-back{font-size:' + (8 * z) + 'px}' +
      // 展开面板内容整体 zoom（容器自带 overflow-y:auto，不怕溢出）
      '.tile-expand-content{zoom:' + z + ';overflow-x:auto}' +
      // 就地展开面板 zoom（不放在 flex container 上，避免 Chromium flex+zoom 折行 bug）
      '.inline-panel-content .w10-panel{zoom:' + z + '}' +
      // 人体剪影用 Canvas 自算坐标，CSS zoom 会破坏坐标系 -> 排除
      '.tile[data-id="bodypreset"] .tile-expand-content{zoom:1!important}' +
      // 示波器同理: Canvas 按 getBoundingClientRect 自算尺寸, zoom 会双重放大坐标 -> 排除
      '.tile[data-id="scope"] .tile-expand-content{zoom:1!important}' +
      // 人体剪影内文本单独缩放（因为 zoom 被排除）
      '.bp-hint{font-size:' + (9 * z) + 'px}' +
      '.bp-crumb-line{font-size:' + (10 * z) + 'px}' +
      '.bp-hover-label{font-size:' + (10 * z) + 'px}' +
      '.bp-back-btn{font-size:' + (12 * z) + 'px}' +
      // UIKit 下拉框选项
      '.uik-sel-opt{font-size:' + (11 * z) + 'px}' +
      '.uik-sel-label{font-size:' + (11 * z) + 'px}' +
      '.uik-sel-arrow{font-size:' + (10 * z) + 'px}' +
      '.uik-sel-group-label{font-size:' + (9 * z) + 'px}' +
      '.uik-sel-search{font-size:' + (11 * z) + 'px}';
  },

  applyTextMode: function(mode) {
    var r = document.documentElement;
    if (mode === 'light') {
      r.style.setProperty('--text', '#ffffff');
      r.style.setProperty('--text-main', '#ffffff');
      r.style.setProperty('--text-sub', 'rgba(255,255,255,0.65)');
    } else if (mode === 'dark') {
      r.style.setProperty('--text', '#111111');
      r.style.setProperty('--text-main', '#111111');
      r.style.setProperty('--text-sub', '#555555');
    } else {
      // auto / fallback — 清除覆盖，恢复 CSS 默认
      r.style.removeProperty('--text');
      r.style.removeProperty('--text-main');
      r.style.removeProperty('--text-sub');
    }
  },

  _hexToHSL: function(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var r = parseInt(hex.substr(0, 2), 16) / 255;
    var g = parseInt(hex.substr(2, 2), 16) / 255;
    var b = parseInt(hex.substr(4, 2), 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h, s, l = (max + min) / 2;
    if (max === min) { h = s = 0; }
    else {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
  },
};

window.ThemeEngine = ThemeEngine;
})();
