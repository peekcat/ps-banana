(function() {
'use strict';

var MAX_REFS = 4;

function _getRefs() { return TileAPI.state.get('refimages.list') || []; }
function _getRefSels() { return TileAPI.state.get('refimages.listSelections') || []; }

// --- Front face ---
function renderFront(container, w, h) {
  var refs = _getRefs();
  var text = refs.length ? refs.length + '/' + MAX_REFS : '无参考';

  // 用第一张参考图当背景
  if (refs.length) {
    container.innerHTML =
      '<div style="position:absolute;inset:0;overflow:hidden;border-radius:var(--tile-radius);">' +
        '<img src="data:image/png;base64,' + refs[0] + '" style="width:100%;height:100%;object-fit:cover;opacity:0.35;">' +
      '</div>' +
      '<div class="tile-icon" style="position:relative;">🖼️</div>' +
      '<div class="tile-label" style="position:relative;">参考图 ' + text + '</div>';
  } else if (w >= 2) {
    container.innerHTML = '<div class="tile-icon">🖼️</div><div class="tile-label">参考图</div><div class="tile-desc">' + text + '</div>';
  } else {
    container.innerHTML = '<div class="tile-icon">🖼️</div><div class="tile-label">参考图</div>';
  }
}

TileAPI.registerTile({
  id: 'refimages',
  group: 'main',
  icon: '🖼️',
  label: '参考图',
  desc: '附加参考',
  live: true,
  defaultSize: { w: 2, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderFront: renderFront,

  renderBack: function(container) {
    var refs = _getRefs();
    container.textContent = refs.length ? refs.length + ' 张参考' : '无参考图';
  },

  onExpand: function(container, sizeHint) {
    var layout = (sizeHint && sizeHint.layout) || 'wide';
    _renderPanel(container, layout);

    var sub = function() {
      _renderPanel(container, layout);
    };
    TileAPI.on('refimages:updated', sub);
    return function() { TileAPI.off('refimages:updated', sub); };
  },

  onResize: renderFront,

  onMessage: function(action, data) {
    if (action === 'captureRefResult' && data && data.base64) {
      var list = _getRefs();
      var sels = _getRefSels();
      if (list.length >= MAX_REFS) return;

      var newBounds = (data.selection && data.selection.bounds) || data.selection || null;
      var commitRef = function() {
        list.push(data.base64);
        sels.push({ docId: data.docId || null, bounds: newBounds });
        TileAPI.state.set('refimages.list', list);
        TileAPI.state.set('refimages.listSelections', sels);
        TileAPI.emit('refimages:updated');
        TileAPI.toast('参考图已添加', 'success');
      };

      // 第一张参考图直接加, 不用比较
      // 第二张起: 跟已有的比, 比例不一致弹窗
      if (sels.length > 0 && window.AspectWarn && newBounds && newBounds.width && newBounds.height) {
        var existing = sels.map(function(s) {
          var b = s && s.bounds;
          return b && b.width ? { width: b.width, height: b.height } : null;
        }).filter(Boolean);
        var verdict = window.AspectWarn.checkRefVsRefs(newBounds.width, newBounds.height, existing);
        if (verdict === 'mismatch') {
          window.AspectWarn.confirmBeforeAddRef({
            newW: newBounds.width, newH: newBounds.height, refs: existing
          }).then(function(yes) { if (yes) commitRef(); });
          return;
        }
      }
      commitRef();
    }

    if (action === 'recaptureRefResult' && data && data.base64 != null && data.index != null) {
      var rlist = _getRefs();
      var rsels = _getRefSels();
      var idx = data.index;
      if (idx >= 0 && idx < rlist.length) {
        rlist[idx] = data.base64;
        rsels[idx] = {
          docId: data.docId || null,
          bounds: (data.selection && data.selection.bounds) || data.selection || null
        };
        TileAPI.state.set('refimages.list', rlist);
        TileAPI.state.set('refimages.listSelections', rsels);
        TileAPI.emit('refimages:updated');
        TileAPI.toast('参考图已重新捕获', 'success');
      }
    }
  },
});

// =============================================================
// Panel rendering — layout-aware
// =============================================================

function _renderPanel(container, layout) {
  // v6.5.10: 用户拍板 — 不管面板宽窄, 一律用紧凑版(缩略图网格+抓选区格)。
  // 宽版/方版/横条版的"参考图 N/4"大标题卡片布局全部弃用, 分支保留在下面备查不再进入。
  _renderCompactStrip(container);
}

// (弃用) 旧的按宽度分家的入口, 留档备查
function _renderPanelByLayout_unused(container, layout) {
  // v6.5.6: 窄/高(1x2等条形)走专用紧凑版 — 缩略图网格+图上角标按钮, 不再塞卡片
  if (layout === 'narrow' || layout === 'tall') {
    _renderCompactStrip(container);
  } else if (layout === 'square') {
    _renderSquare(container);
  } else if (layout === 'wideshort') {
    _renderWideshort(container);
  } else {
    _renderWide(container);
  }
}

// 1xN/Nx1 紧凑版: 2列缩略图网格, 删除=图右上×, 重捕/恢复选区收进图的点击菜单
function _renderCompactStrip(container) {
  var refs = _getRefs();
  var refSels = _getRefSels();
  var full = refs.length >= MAX_REFS;

  var html = '<div class="w10-panel refimg-strip">';
  html += '<div class="refimg-strip-grid">';
  for (var i = 0; i < refs.length; i++) {
    var hasSel = refSels[i] && refSels[i].docId;
    html += '<div class="refimg-strip-cell" style="position:relative;">' +
      '<img src="data:image/png;base64,' + refs[i] + '" ' +
        (hasSel ? 'data-jump-ref="' + i + '" title="参考图 ' + (i + 1) + ' · 点击跳转选区" style="cursor:pointer;"' : 'title="参考图 ' + (i + 1) + '"') + '>' +
      _deleteBtn(i) +
      '<div class="refimg-strip-recap" data-recaptureidx="' + i + '" title="重新捕获">🔄</div>' +
    '</div>';
  }
  // 加号格(与缩略图同尺寸, 占一格; v6.5.6b: 提示文字进框内, 不再框外单独一行)
  if (!full) {
    html += '<div class="refimg-strip-cell refimg-strip-add" data-action="addRef" title="从 PS 选区抓取参考图">' +
      '<span class="refimg-strip-add-plus">＋</span>' +
      (refs.length ? '' : '<span class="refimg-strip-add-txt">抓选区</span>') +
    '</div>';
  }
  html += '</div>';
  html += '</div>';
  container.innerHTML = html;
  _bindAll(container);
  _bindJumpThumbs(container);
}

// ----- Helpers -----

function _thumbSize(layout) {
  if (layout === 'narrow' || layout === 'tall') return 40;
  if (layout === 'square') return 60;
  return 80;
}

function _imgTag(b64, size) {
  return '<img src="data:image/png;base64,' + b64 + '" ' +
    'style="width:' + size + 'px;height:' + size + 'px;object-fit:cover;border-radius:4px;border:1px solid rgba(255,255,255,0.1);display:block;">';
}

function _deleteBtn(idx) {
  return '<div class="refimg-del" data-refdelidx="' + idx + '" ' +
    'style="position:absolute;top:2px;right:2px;width:16px;height:16px;background:rgba(0,0,0,0.65);' +
    'border-radius:3px;display:flex;align-items:center;justify-content:center;cursor:pointer;' +
    'font-size:9px;color:#ff6b6b;line-height:1;z-index:2;">×</div>';
}

function _bindDelete(container) {
  var btns = container.querySelectorAll('[data-refdelidx]');
  for (var i = 0; i < btns.length; i++) {
    (function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = +btn.getAttribute('data-refdelidx');
        var list = _getRefs();
        var sels = _getRefSels();
        list.splice(idx, 1);
        sels.splice(idx, 1);
        TileAPI.state.set('refimages.list', list);
        TileAPI.state.set('refimages.listSelections', sels);
        TileAPI.emit('refimages:updated');
      });
    })(btns[i]);
  }
}

function _bindAddRef(container) {
  var btn = container.querySelector('[data-action="addRef"]');
  if (btn) btn.addEventListener('click', function() {
    var list = _getRefs();
    if (list.length >= MAX_REFS) {
      TileAPI.toast('最多' + MAX_REFS + '张参考图', 'error');
      return;
    }
    TileAPI.sendToHost('captureRefImage');
    TileAPI.toast('正在捕获参考图...', 'info');
  });
}

function _bindRecaptureRef(container) {
  var btns = container.querySelectorAll('[data-recaptureidx]');
  for (var i = 0; i < btns.length; i++) {
    (function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = +btn.getAttribute('data-recaptureidx');
        TileAPI.sendToHost('recaptureRefImage', { index: idx });
        TileAPI.toast('正在重新捕获...', 'info');
      });
    })(btns[i]);
  }
}

function _bindRestoreRefSel(container) {
  var btns = container.querySelectorAll('[data-restoreselidx]');
  for (var i = 0; i < btns.length; i++) {
    (function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = +btn.getAttribute('data-restoreselidx');
        var sels = _getRefSels();
        var sel = sels[idx];
        if (sel && sel.docId) {
          TileAPI.sendToHost('restoreSelectionFromHistory', { docId: sel.docId, selection: sel.bounds || sel });
          TileAPI.toast('正在恢复选区...', 'info');
        } else {
          TileAPI.toast('无保存的选区信息', 'error');
        }
      });
    })(btns[i]);
  }
}

function _bindJumpThumbs(container) {
  var refEls = container.querySelectorAll('[data-jump-ref]');
  for (var i = 0; i < refEls.length; i++) {
    (function(el) {
      el.addEventListener('click', function(e) {
        if (e.target.closest('[data-refdelidx]')) return;
        var idx = +el.getAttribute('data-jump-ref');
        var sels = _getRefSels();
        var sel = sels[idx];
        if (sel && sel.docId) {
          TileAPI.sendToHost('restoreSelectionFromHistory', { docId: sel.docId, selection: sel.bounds || sel });
          TileAPI.toast('正在跳转...', 'info');
        }
      });
    })(refEls[i]);
  }
}

function _bindAll(container) {
  _bindAddRef(container);
  _bindRecaptureRef(container);
  _bindRestoreRefSel(container);
  _bindDelete(container);
}

// ----- narrow / tall -----
function _renderNarrow(container, layout) {
  var refs = _getRefs();
  var refSels = _getRefSels();
  var sz = _thumbSize(layout);
  var full = refs.length >= MAX_REFS;

  var html = '<div class="w10-panel panel-sz-' + layout + '">';

  // Thumbnail grid (只有参考图)
  html += '<div class="refimg-grid-narrow">';
  for (var i = 0; i < refs.length; i++) {
    var hasSel = refSels[i] && refSels[i].docId;
    html += '<div class="refimg-thumb-wrap"' +
      (hasSel ? ' data-jump-ref="' + i + '" title="点击跳转 PS 对应选区"' : '') +
      ' style="position:relative;' + (hasSel ? 'cursor:pointer;' : '') + '">' +
      _imgTag(refs[i], sz) +
      _deleteBtn(i) +
    '</div>';
  }
  html += '</div>'; // grid

  // Bottom button — 只剩"加参考图"
  html += '<div class="refimg-btns-narrow">';
  html += '<button class="w10-btn' + (full ? '' : ' w10-btn-accent') + '"' +
    (full ? ' disabled style="opacity:0.4;cursor:not-allowed;"' : '') +
    ' data-action="addRef" title="添加参考图">+</button>';
  html += '</div>';

  html += '</div>';
  container.innerHTML = html;
  _bindAll(container);
  _bindJumpThumbs(container);
}

// ----- square -----
function _renderSquare(container) {
  var refs = _getRefs();
  var refSels = _getRefSels();
  var sz = _thumbSize('square');
  var full = refs.length >= MAX_REFS;

  var html = '<div class="w10-panel">';
  html += '<div class="w10-section-title">参考图 ' + refs.length + '/' + MAX_REFS + '</div>';
  html += '<div class="refimg-grid">';

  for (var i = 0; i < refs.length; i++) {
    var hasSel = refSels[i] && refSels[i].docId;
    html += '<div class="refimg-thumb-wrap"' +
      (hasSel ? ' data-jump-ref="' + i + '" title="点击跳转 PS 对应选区"' : '') +
      ' style="position:relative;' + (hasSel ? 'cursor:pointer;' : '') + '">' +
      _imgTag(refs[i], sz) +
      _deleteBtn(i) +
    '</div>';
  }
  if (!full) {
    html += '<div class="refimg-add-cell" data-action="addRef" style="width:' + sz + 'px;height:' + sz + 'px;" title="添加参考图">' +
      '<span style="font-size:18px;color:var(--text-sub);">+</span>' +
    '</div>';
  }
  html += '</div></div>';
  container.innerHTML = html;
  _bindAll(container);
  _bindJumpThumbs(container);
}

// ----- wideshort -----
function _renderWideshort(container) {
  var refs = _getRefs();
  var refSels = _getRefSels();
  var sz = _thumbSize('wideshort');
  var full = refs.length >= MAX_REFS;

  var html = '<div class="w10-panel">';
  html += '<div class="w10-section-title" style="margin-top:0;">参考图 ' + refs.length + '/' + MAX_REFS + '</div>';
  html += '<div class="refimg-grid">';

  for (var i = 0; i < refs.length; i++) {
    var hasSel = refSels[i] && refSels[i].docId;
    html += '<div class="refimg-thumb-wrap"' +
      (hasSel ? ' data-jump-ref="' + i + '" title="点击跳转 PS 对应选区"' : '') +
      ' style="position:relative;' + (hasSel ? 'cursor:pointer;' : '') + '">' +
      _imgTag(refs[i], sz) +
      _deleteBtn(i) +
    '</div>';
  }
  if (!full) {
    html += '<div class="refimg-add-cell" data-action="addRef" style="width:' + sz + 'px;height:' + sz + 'px;" title="添加参考图">' +
      '<span style="font-size:18px;color:var(--text-sub);">+</span>' +
    '</div>';
  }
  html += '</div></div>';
  container.innerHTML = html;
  _bindAll(container);
  _bindJumpThumbs(container);
}

// ----- wide (full layout) -----
function _renderWide(container) {
  var refs = _getRefs();
  var refSels = _getRefSels();
  var sz = _thumbSize('wide');
  var full = refs.length >= MAX_REFS;

  var html = '<div class="w10-panel">';
  html += '<div class="w10-section-title">参考图 (' + refs.length + '/' + MAX_REFS + ')</div>';

  if (refs.length === 0) {
    html += '<div class="refimg-empty">暂无参考图</div>';
  }

  for (var i = 0; i < refs.length; i++) {
    var hasSel = refSels[i] && refSels[i].docId;
    html += '<div class="refimg-card">' +
      '<div class="refimg-card-thumb"' +
        (hasSel ? ' data-jump-ref="' + i + '" title="点击跳转 PS 对应选区" style="position:relative;cursor:pointer;"' : ' style="position:relative;"') +
        '>' +
        _imgTag(refs[i], sz) +
        _deleteBtn(i) +
      '</div>' +
      '<div class="refimg-card-info">' +
        '<div class="refimg-card-label">参考图 ' + (i + 1) + '</div>' +
      '</div>' +
      '<div class="refimg-card-actions">' +
        '<button class="w10-btn" data-recaptureidx="' + i + '">🔄 重新捕获</button>' +
        (hasSel ? '<button class="w10-btn" data-restoreselidx="' + i + '">📐 恢复选区</button>' : '') +
      '</div>' +
    '</div>';
  }

  // v6.5.6: 加号做成与缩略图同尺寸的占位框(不再是下面一条按钮)
  if (!full) {
    html += '<div class="refimg-card refimg-card-add" data-action="addRef" title="从 PS 选区抓取参考图">' +
      '<div class="refimg-add-cell" style="width:' + sz + 'px;height:' + sz + 'px;">＋</div>' +
      '<div class="refimg-card-info"><div class="refimg-card-label" style="color:var(--text-sub);">添加参考图</div></div>' +
    '</div>';
  }

  html += '</div>';
  container.innerHTML = html;
  _bindAll(container);
  _bindJumpThumbs(container);
}

// ============================================================
//  有参考图时高亮磁贴 (提醒用户上一张可能残留, 该删则删)
//  直接给 [data-id="refimages"] 切 class, 不依赖 renderFront 重绘
// ============================================================
function _syncRefHighlight() {
  var has = _getRefs().length > 0;
  var els = document.querySelectorAll('.tile[data-id="refimages"]');
  for (var i = 0; i < els.length; i++) {
    els[i].classList.toggle('refimg-has-refs', has);
  }
}

// 参考图增删时实时刷新高亮
TileAPI.on('refimages:updated', _syncRefHighlight);
// 预设载入会改写参考图列表, 也要跟着刷新
TileAPI.on('preset:loaded', function() { setTimeout(_syncRefHighlight, 0); });
// 启动/磁贴重建后补一次 (磁贴可能晚于本脚本渲染)
setTimeout(_syncRefHighlight, 300);
setTimeout(_syncRefHighlight, 1200);

})();
