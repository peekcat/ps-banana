// ============================================================
//  tile-community-mock.js — 社区瀑布流性能测试 (mock, 无服务器)
//
//  目的: 在 UXP 里测出"插件内做社区"的真实性能边界. 用 Canvas 色块占位
//  填出真实数量级的卡片, 用户亲手滑一遍, 配合 tile-perf-monitor 看 FPS.
//
//  3 种渲染模式:
//    - naive: 朴素全渲 (一次 innerHTML 全拼) — 性能下限
//    - lazy:  懒加载 (首屏 30 + 滚到底加 30) — 主流方案
//    - virtual: 虚拟滚动 (只渲可视区±缓冲) — 最优解
//
//  关键: Canvas 缩略图缓存 (避免重复生成), 事件委托 (1 个 click handler),
//  不用 IntersectionObserver (UXP 兼容性未知, 走 scroll + offsetTop).
// ============================================================
(function() {
'use strict';

// ========== 配置 ==========
var _config = {
    cardCount: 100,     // 50 / 100 / 500 / 1000 / 2000
    thumbSize: 200,     // 200 / 400 / 600 (Canvas 边长)
    columns: 3,         // 2 / 3 / 4
    mode: 'lazy'        // naive / lazy / virtual
};

// ========== 状态 ==========
var _activeContainer = null;
var _gridEl = null;            // 滚动容器
var _cards = [];               // 假数据: { id, title, likes, comments, tips, calls, color1, color2 }
var _thumbCache = {};          // id -> dataURL (Canvas 生成的缩略图, 避免重复 toDataURL)
var _renderedTo = 0;           // lazy 模式当前已渲到第几张
var _lazyPageSize = 30;
var _virtualScrollHandler = null;
var _virtualLastFirstIdx = -1;
var _virtualLastLastIdx = -1;
var _modalEl = null;

// 列宽算式 (panel 内 padding + 列间距估算)
function _estCardWidth() {
    if (!_gridEl) return 180;
    var gw = _gridEl.clientWidth || 600;
    var gap = 8, padding = 16;
    return Math.floor((gw - padding - (_config.columns - 1) * gap) / _config.columns);
}

function _estCardHeight() {
    // 卡 = 缩略图 (cardWidth × cardWidth 正方形) + 文字区 ~70px
    return _estCardWidth() + 70;
}

function _esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ========== 假数据生成 ==========
function _genTitle(i) {
    var w1 = ['赛博', '修脸', '人物', '光影', '场景', '动漫', '写实', '幻想', '黑白', '柔光'];
    var w2 = ['细节', '提示词', '工作流', '风格', '调色', '布光', '渲染', '后期', '合成'];
    var w3 = ['v1', 'v2', 'pro', '增强', '极致', '精修', '快速'];
    return w1[i % w1.length] + w2[(i * 7) % w2.length] + ' ' + w3[(i * 13) % w3.length] + ' #' + i;
}

function _randColor(seed) {
    var h = (seed * 47 + 31) % 360;
    return 'hsl(' + h + ',60%,55%)';
}

function _initCards(n) {
    _cards = [];
    _thumbCache = {};   // 清缓存 (避免老 thumb 尺寸不匹配)
    for (var i = 0; i < n; i++) {
        _cards.push({
            id: 'p_' + i,
            idx: i,
            title: _genTitle(i),
            likes: ((i * 17) % 9000) + 12,
            comments: (i * 3) % 200,
            tips: (i * 7) % 50,
            calls: ((i * 11) % 3000) + 5,
            seed1: i,
            seed2: i + 100
        });
    }
}

// 生成 Canvas 缩略图 (带缓存)
function _genThumb(card) {
    var key = card.id + '_' + _config.thumbSize;
    if (_thumbCache[key]) return _thumbCache[key];
    var sz = _config.thumbSize;
    var canvas = document.createElement('canvas');
    canvas.width = sz; canvas.height = sz;
    var ctx = canvas.getContext('2d');
    var grad = ctx.createLinearGradient(0, 0, sz, sz);
    grad.addColorStop(0, _randColor(card.seed1));
    grad.addColorStop(1, _randColor(card.seed2));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, sz, sz);
    // 索引水印
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = 'bold ' + Math.round(sz / 4) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('#' + card.idx, sz / 2, sz / 2);
    var dataUrl = canvas.toDataURL('image/jpeg', 0.7);
    _thumbCache[key] = dataUrl;
    return dataUrl;
}

// 渲染单张卡片 HTML (不立即生成 thumb, 用 data-need-thumb 占位等批量生成)
function _renderCardHtml(card, w) {
    var thumbW = w || _estCardWidth();
    return '' +
        '<div class="cm-card" data-cid="' + card.id + '" style="width:' + thumbW + 'px;">' +
            '<div class="cm-card-thumb" data-cid-thumb="' + card.id + '" style="width:' + thumbW + 'px;height:' + thumbW + 'px;background:#333;"></div>' +
            '<div class="cm-card-body">' +
                '<div class="cm-card-title">' + _esc(card.title) + '</div>' +
                '<div class="cm-card-stats">' +
                    '<span>👍 ' + card.likes + '</span>' +
                    '<span>💬 ' + card.comments + '</span>' +
                    '<span>🪙 ' + card.tips + '</span>' +
                    '<span>↓ ' + card.calls + '</span>' +
                '</div>' +
                '<div class="cm-card-actions">' +
                    '<button class="cm-btn-call" data-act="call" data-cid="' + card.id + '">↓ 调用</button>' +
                    '<button class="cm-btn-tip" data-act="tip" data-cid="' + card.id + '">🪙 打赏</button>' +
                '</div>' +
            '</div>' +
        '</div>';
}

// 批量给卡片填 thumb (生成后写 background)
function _fillThumbs(scope) {
    var thumbs = (scope || _gridEl).querySelectorAll('.cm-card-thumb[data-cid-thumb]');
    for (var i = 0; i < thumbs.length; i++) {
        var cid = thumbs[i].getAttribute('data-cid-thumb');
        var card = _cards[parseInt(cid.slice(2), 10)];
        if (!card) continue;
        var url = _genThumb(card);
        thumbs[i].style.background = 'center/cover no-repeat url("' + url + '")';
        thumbs[i].removeAttribute('data-cid-thumb');
    }
}

// 上报渲染耗时给 perf-monitor (用全局 CustomEvent)
function _perfMark(label, ms) {
    try {
        window.dispatchEvent(new CustomEvent('perf:mark', { detail: { label: label, ms: ms } }));
    } catch (e) {}
}

// ========== 3 种渲染模式 ==========

// 模式 1: 朴素全渲 (一次性把 N 张卡全 innerHTML)
function _renderNaive() {
    var t0 = performance.now();
    var w = _estCardWidth();
    var html = '<div class="cm-list">';
    for (var i = 0; i < _cards.length; i++) html += _renderCardHtml(_cards[i], w);
    html += '</div>';
    _gridEl.innerHTML = html;
    var t1 = performance.now();
    _fillThumbs();
    var t2 = performance.now();
    _perfMark('naive 渲染 ' + _cards.length + ' 张', t2 - t0);
    _updateStatusBar('naive', _cards.length, t1 - t0, t2 - t1);
    _resetVirtualScroll();
}

// 模式 2: 懒加载 (首屏 30 张, 滚到底加 30)
function _renderLazy() {
    var t0 = performance.now();
    _renderedTo = 0;
    _gridEl.innerHTML = '<div class="cm-list" id="cmLazyList"></div><div class="cm-load-more" id="cmLoadMore" style="display:none;text-align:center;padding:10px;color:var(--text-sub);font-size:11px;">滚到底自动加载...</div>';
    _lazyAppendNext();
    var t1 = performance.now();
    _perfMark('lazy 首屏 ' + _renderedTo + ' 张', t1 - t0);
    _attachLazyScroll();
}
function _lazyAppendNext() {
    var listEl = _gridEl.querySelector('#cmLazyList');
    if (!listEl) return;
    var end = Math.min(_renderedTo + _lazyPageSize, _cards.length);
    if (end <= _renderedTo) {
        var more = _gridEl.querySelector('#cmLoadMore');
        if (more) more.textContent = '— 到底了 (共 ' + _cards.length + ' 张) —';
        return;
    }
    var t0 = performance.now();
    var w = _estCardWidth();
    var html = '';
    for (var i = _renderedTo; i < end; i++) html += _renderCardHtml(_cards[i], w);
    listEl.insertAdjacentHTML('beforeend', html);
    _fillThumbs(listEl);
    _renderedTo = end;
    var t1 = performance.now();
    _perfMark('lazy +' + (end - (_renderedTo - _lazyPageSize)) + ' 张', t1 - t0);
    _updateStatusBar('lazy', _renderedTo, t1 - t0, 0);
}
function _attachLazyScroll() {
    if (!_gridEl) return;
    _gridEl.onscroll = function() {
        var nearBottom = _gridEl.scrollTop + _gridEl.clientHeight >= _gridEl.scrollHeight - 200;
        if (nearBottom && _renderedTo < _cards.length) _lazyAppendNext();
    };
}

// 模式 3: 虚拟滚动 (只渲可视区 + 上下缓冲 5 行)
function _renderVirtual() {
    var t0 = performance.now();
    var cardH = _estCardHeight() + 12;  // 包含 gap
    var rows = Math.ceil(_cards.length / _config.columns);
    var totalHeight = rows * cardH;
    _gridEl.innerHTML =
        '<div id="cmVirtualSpacer" style="height:' + totalHeight + 'px;position:relative;">' +
            '<div id="cmVirtualWindow" class="cm-list" style="position:absolute;top:0;left:0;right:0;"></div>' +
        '</div>';
    _virtualLastFirstIdx = -1;
    _virtualLastLastIdx = -1;
    _virtualScroll();
    var t1 = performance.now();
    _perfMark('virtual 初始化', t1 - t0);
    _attachVirtualScroll();
}
function _virtualScroll() {
    var win = _gridEl.querySelector('#cmVirtualWindow');
    if (!win) return;
    var cardH = _estCardHeight() + 12;
    var st = _gridEl.scrollTop;
    var vh = _gridEl.clientHeight;
    var firstRow = Math.max(0, Math.floor(st / cardH) - 5);
    var lastRow = Math.min(Math.ceil(_cards.length / _config.columns), Math.ceil((st + vh) / cardH) + 5);
    var firstIdx = firstRow * _config.columns;
    var lastIdx = Math.min(_cards.length, lastRow * _config.columns);
    if (firstIdx === _virtualLastFirstIdx && lastIdx === _virtualLastLastIdx) return;
    _virtualLastFirstIdx = firstIdx;
    _virtualLastLastIdx = lastIdx;
    var t0 = performance.now();
    var w = _estCardWidth();
    var html = '';
    for (var i = firstIdx; i < lastIdx; i++) html += _renderCardHtml(_cards[i], w);
    win.style.transform = 'translateY(' + (firstRow * cardH) + 'px)';
    win.innerHTML = html;
    _fillThumbs(win);
    var t1 = performance.now();
    _updateStatusBar('virtual', lastIdx - firstIdx, t1 - t0, 0);
}
function _attachVirtualScroll() {
    if (!_gridEl) return;
    var raf = 0;
    _gridEl.onscroll = function() {
        if (raf) return;
        raf = requestAnimationFrame(function() {
            raf = 0;
            _virtualScroll();
        });
    };
}

function _resetVirtualScroll() {
    if (_gridEl) _gridEl.onscroll = null;
}

// ========== 状态条 ==========
function _updateStatusBar(mode, count, renderMs, fillMs) {
    if (!_activeContainer) return;
    var el = _activeContainer.querySelector('#cmStatus');
    if (!el) return;
    var fillStr = fillMs > 0 ? (' · 缩略图 ' + fillMs.toFixed(0) + 'ms') : '';
    el.innerHTML = '模式: <b>' + mode + '</b> · 已渲 <b>' + count + '</b> / ' + _cards.length + ' · 渲染 ' + renderMs.toFixed(0) + 'ms' + fillStr;
}

// ========== 详情模态 ==========
function _openModal(cid) {
    var card = null;
    for (var i = 0; i < _cards.length; i++) if (_cards[i].id === cid) { card = _cards[i]; break; }
    if (!card) return;
    if (_modalEl) _closeModal();
    var t0 = performance.now();
    var big = _genThumb({ id: card.id + '_big', idx: card.idx, seed1: card.seed1, seed2: card.seed2 });
    var commentsHtml = '';
    for (var k = 0; k < 20; k++) {
        commentsHtml += '<div class="cm-comment"><b>用户' + ((card.idx + k) % 50) + ':</b> 这个提示词第 ' + (k + 1) + ' 条假评论, 用来填测试数据看是否卡.</div>';
    }
    _modalEl = document.createElement('div');
    _modalEl.className = 'cm-modal-mask';
    _modalEl.innerHTML =
        '<div class="cm-modal-card">' +
            '<button class="cm-modal-close" id="cmModalClose">×</button>' +
            '<img class="cm-modal-img" src="' + big + '" alt="">' +
            '<div class="cm-modal-info">' +
                '<div class="cm-modal-title">' + _esc(card.title) + '</div>' +
                '<div class="cm-modal-stats">👍 ' + card.likes + ' · 💬 ' + card.comments + ' · 🪙 ' + card.tips + ' · ↓ ' + card.calls + '</div>' +
                '<div class="cm-modal-prompt"><b>提示词 (假数据):</b><br>masterpiece, best quality, photo of ' + _esc(card.title) + ', cinematic lighting, detailed face, 8k</div>' +
                '<div class="cm-modal-actions">' +
                    '<button class="cm-btn-call">↓ 调用到插件 (-' + (card.idx % 10) + ' 积分)</button>' +
                    '<button class="cm-btn-tip">🪙 打赏 5 积分</button>' +
                '</div>' +
                '<div class="cm-modal-comments-title">评论 (20 条假数据)</div>' +
                '<div class="cm-modal-comments">' + commentsHtml + '</div>' +
            '</div>' +
        '</div>';
    document.body.appendChild(_modalEl);
    _modalEl.querySelector('#cmModalClose').onclick = _closeModal;
    _modalEl.onclick = function(e) { if (e.target === _modalEl) _closeModal(); };
    var t1 = performance.now();
    _perfMark('详情模态打开', t1 - t0);
}

function _closeModal() {
    if (_modalEl && _modalEl.parentNode) _modalEl.parentNode.removeChild(_modalEl);
    _modalEl = null;
}

// ========== 点击委托 ==========
function _onGridClick(e) {
    var t = e.target;
    // 按钮 (优先)
    var actBtn = t.closest && t.closest('[data-act]');
    if (actBtn) {
        e.stopPropagation();
        var act = actBtn.getAttribute('data-act');
        if (act === 'call') TileAPI.toast('模拟调用 (不实际操作)', 'info');
        else if (act === 'tip') TileAPI.toast('模拟打赏 (不实际操作)', 'info');
        return;
    }
    // 卡片
    var card = t.closest && t.closest('.cm-card');
    if (card) {
        _openModal(card.getAttribute('data-cid'));
    }
}

// ========== 指令栏 ==========
function _renderControls() {
    var c = _config;
    function pillGroup(items, current, attr) {
        var h = '';
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var active = String(it) === String(current);
            h += '<button class="cm-pill' + (active ? ' is-active' : '') + '" data-' + attr + '="' + it + '">' + it + '</button>';
        }
        return h;
    }
    return '<div class="cm-controls">' +
        '<div class="cm-control-row"><span class="cm-ctl-label">卡片数</span>' + pillGroup([50, 100, 500, 1000, 2000], c.cardCount, 'count') + '</div>' +
        '<div class="cm-control-row"><span class="cm-ctl-label">缩略图</span>' + pillGroup([200, 400, 600], c.thumbSize, 'thumb') + '<span style="margin-left:14px"></span><span class="cm-ctl-label">列数</span>' + pillGroup([2, 3, 4], c.columns, 'col') + '</div>' +
        '<div class="cm-control-row"><span class="cm-ctl-label">模式</span>' +
            '<button class="cm-pill' + (c.mode === 'naive' ? ' is-active' : '') + '" data-mode="naive">朴素全渲</button>' +
            '<button class="cm-pill' + (c.mode === 'lazy' ? ' is-active' : '') + '" data-mode="lazy">懒加载</button>' +
            '<button class="cm-pill' + (c.mode === 'virtual' ? ' is-active' : '') + '" data-mode="virtual">虚拟滚动</button>' +
            '<button class="cm-pill cm-pill-rerun" id="cmRerun">↻ 重新渲染</button>' +
        '</div>' +
        '<div class="cm-status" id="cmStatus">就绪...</div>' +
    '</div>';
}

function _bindControls(container) {
    container.querySelectorAll('[data-count]').forEach(function(b) {
        b.onclick = function() { _config.cardCount = +b.dataset.count; _doRerun(container); };
    });
    container.querySelectorAll('[data-thumb]').forEach(function(b) {
        b.onclick = function() { _config.thumbSize = +b.dataset.thumb; _thumbCache = {}; _doRerun(container); };
    });
    container.querySelectorAll('[data-col]').forEach(function(b) {
        b.onclick = function() { _config.columns = +b.dataset.col; _doRerun(container); };
    });
    container.querySelectorAll('[data-mode]').forEach(function(b) {
        b.onclick = function() { _config.mode = b.dataset.mode; _doRerun(container); };
    });
    var rerunBtn = container.querySelector('#cmRerun');
    if (rerunBtn) rerunBtn.onclick = function() { _doRerun(container); };
}

function _doRerun(container) {
    _initCards(_config.cardCount);
    _renderPanel(container);
}

// ========== 主面板 ==========
function _renderPanel(container) {
    _activeContainer = container;
    container.innerHTML =
        '<div class="cm-panel">' +
            _renderControls() +
            '<div class="cm-grid" id="cmGrid" style="--cm-cols:' + _config.columns + ';"></div>' +
        '</div>';
    _gridEl = container.querySelector('#cmGrid');
    _gridEl.addEventListener('click', _onGridClick);
    _bindControls(container);

    if (_cards.length !== _config.cardCount) _initCards(_config.cardCount);

    if (_config.mode === 'naive') _renderNaive();
    else if (_config.mode === 'lazy') _renderLazy();
    else if (_config.mode === 'virtual') _renderVirtual();
}

// ========== 正面 ==========
function renderFront(container, w, h) {
    if (w >= 2) {
        container.innerHTML =
            '<div class="tile-icon">🧪</div>' +
            '<div class="tile-label">社区性能测试</div>' +
            '<div class="tile-desc">瀑布流 mock</div>';
    } else {
        container.innerHTML =
            '<div class="tile-icon">🧪</div>' +
            '<div class="tile-label">测试</div>';
    }
}

// ========== 注册磁贴 ==========
TileAPI.registerTile({
    id: 'community-mock',
    group: 'main',
    icon: '🧪',
    label: '社区性能测试',
    desc: '瀑布流 mock (测完可删)',
    defaultSize: { w: 2, h: 3 },
    minSize: { w: 1, h: 1 },
    maxSize: { w: 4, h: 8 },

    renderFront: renderFront,

    onExpand: function(container) {
        _renderPanel(container);
        return function() {
            _activeContainer = null;
            _gridEl = null;
            _closeModal();
        };
    },

    onCollapse: function() {
        _activeContainer = null;
        _gridEl = null;
        _closeModal();
    }
});

})();
