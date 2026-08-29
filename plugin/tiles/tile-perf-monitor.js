// ============================================================
//  tile-perf-monitor.js — UXP 性能监测磁贴 (测试用)
//
//  做的事:
//    - 实时 FPS (1秒滑动均值, requestAnimationFrame 数帧)
//    - 内存占用 (performance.memory.usedJSHeapSize, UXP 可能没有 → 显示 N/A)
//    - 监听全局 'perf:mark' 自定义事件, 显示最近 5 次重大渲染耗时
//
//  跟社区 mock 磁贴 (tile-community-mock) 配合使用. 测完可以删.
// ============================================================
(function() {
'use strict';

var _fps = 0;
var _frames = 0;
var _lastFpsTs = 0;
var _memMB = -1;          // -1 表示 UXP 不支持
var _memSupported = null;  // null=未检测, true/false=结果
var _memHistory = [];      // 近 60 秒 (每秒 1 个)
var _marks = [];           // 最近 5 次 {label, ms, ts}
var _activeContainer = null;
var _tickTimer = null;
var _rafId = null;       // requestAnimationFrame 句柄 (只在面板展开时存在)
var _ticking = false;    // FPS 循环是否在跑

// 检测 performance.memory 是否可用 (Chromium 私有 API, 标准浏览器/UXP 不一定有)
function _detectMemory() {
    if (_memSupported !== null) return _memSupported;
    try {
        if (window.performance && window.performance.memory && typeof window.performance.memory.usedJSHeapSize === 'number') {
            _memSupported = true;
        } else {
            _memSupported = false;
        }
    } catch (e) {
        _memSupported = false;
    }
    return _memSupported;
}

function _sampleMem() {
    if (!_detectMemory()) { _memMB = -1; return; }
    try {
        var bytes = window.performance.memory.usedJSHeapSize;
        _memMB = Math.round(bytes / 1048576 * 10) / 10;   // 1 位小数 MB
        _memHistory.push(_memMB);
        if (_memHistory.length > 60) _memHistory.shift();
    } catch (e) {
        _memSupported = false;
        _memMB = -1;
    }
}

// FPS 计数: 每帧 +1, 每秒结算一次
function _fpsTick() {
    _frames++;
    var now = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
    if (!_lastFpsTs) _lastFpsTs = now;
    var dt = now - _lastFpsTs;
    if (dt >= 1000) {
        _fps = Math.round(_frames * 1000 / dt);
        _frames = 0;
        _lastFpsTs = now;
        _sampleMem();
        _refreshFront();
        _refreshPanel();
    }
    if (_ticking) _rafId = requestAnimationFrame(_fpsTick);
}
// FPS 循环只在面板展开时跑 (收起就停, 不再整个会话每帧空转)
function _startTick() {
    if (_ticking) return;
    _ticking = true;
    _frames = 0; _lastFpsTs = 0;
    _rafId = requestAnimationFrame(_fpsTick);
}
function _stopTick() {
    _ticking = false;
    if (_rafId != null) { try { cancelAnimationFrame(_rafId); } catch (e) {} _rafId = null; }
}

// 监听其他磁贴上报的重大渲染耗时
window.addEventListener('perf:mark', function(e) {
    var d = e.detail || {};
    var label = String(d.label || 'mark');
    var ms = +d.ms || 0;
    _marks.unshift({ label: label, ms: ms, ts: Date.now() });
    if (_marks.length > 5) _marks.length = 5;
    _refreshPanel();
});

function _fmtMem() {
    if (!_detectMemory()) return 'N/A';
    if (_memMB < 0) return '...';
    return _memMB.toFixed(1) + ' MB';
}

function _fpsColor(fps) {
    if (fps >= 50) return '#5be37b';
    if (fps >= 30) return '#ffcc66';
    return '#ff7a7a';
}

// ========== 正面 ==========
function renderFront(container, w, h) {
    var fpsColor = _fpsColor(_fps);
    var mem = _fmtMem();
    if (w >= 2) {
        container.innerHTML =
            '<div class="tile-icon">📈</div>' +
            '<div class="tile-label">性能监测</div>' +
            '<div class="tile-desc"><span style="color:' + fpsColor + '">FPS ' + _fps + '</span> · ' + _esc(mem) + '</div>';
    } else {
        container.innerHTML =
            '<div class="tile-icon" style="color:' + fpsColor + ';">📈</div>' +
            '<div class="tile-label">' + _fps + '</div>';
    }
}

function _refreshFront() {
    if (!window.TileEngine) return;
    var el = TileEngine.getTileElement('perf-monitor');
    if (!el) return;
    if (el.classList.contains('panel-mode')) return;
    var inner = el.querySelector('.tile-inner:not(.folder-grid-inner)') || el.querySelector('.tile-flip-front');
    if (inner) renderFront(inner, +el.dataset.w || 1, +el.dataset.h || 1);
}

function _esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ========== 展开面板 ==========
function _renderPanel(container) {
    var fpsColor = _fpsColor(_fps);
    var memSupp = _detectMemory();

    // 内存折线 (简易 ASCII / SVG)
    var memChart = '';
    if (memSupp && _memHistory.length > 1) {
        var maxM = 0;
        for (var i = 0; i < _memHistory.length; i++) if (_memHistory[i] > maxM) maxM = _memHistory[i];
        if (maxM > 0) {
            var points = '';
            var W = 280, H = 60;
            for (var j = 0; j < _memHistory.length; j++) {
                var x = (j / Math.max(1, _memHistory.length - 1)) * W;
                var y = H - (_memHistory[j] / maxM) * H;
                points += (points ? ' ' : '') + x.toFixed(1) + ',' + y.toFixed(1);
            }
            memChart =
                '<svg width="' + W + '" height="' + H + '" style="background:rgba(255,255,255,0.04);border-radius:4px;display:block;margin-top:4px;">' +
                '<polyline fill="none" stroke="#4a9eff" stroke-width="1.5" points="' + points + '"/>' +
                '</svg>' +
                '<div style="font-size:10px;color:var(--text-sub);margin-top:2px">峰值 ' + maxM.toFixed(1) + ' MB · 近 ' + _memHistory.length + ' 秒</div>';
        }
    } else if (!memSupp) {
        memChart = '<div style="font-size:11px;color:var(--text-sub);font-style:italic;">UXP 不暴露 performance.memory, 内存数据 N/A</div>';
    }

    // 重大渲染耗时表
    var marksHtml = '';
    if (_marks.length === 0) {
        marksHtml = '<div style="font-size:11px;color:var(--text-sub);font-style:italic;">等待其他磁贴上报 perf:mark 事件...</div>';
    } else {
        marksHtml = '<table style="width:100%;font-size:11px;border-collapse:collapse;">' +
            '<thead><tr><th style="text-align:left;padding:3px;color:var(--text-sub);">标签</th><th style="text-align:right;padding:3px;color:var(--text-sub);">耗时</th><th style="text-align:right;padding:3px;color:var(--text-sub);">时间</th></tr></thead>' +
            '<tbody>';
        for (var k = 0; k < _marks.length; k++) {
            var m = _marks[k];
            var msColor = m.ms > 100 ? '#ff7a7a' : (m.ms > 30 ? '#ffcc66' : '#5be37b');
            var dt = new Date(m.ts);
            var hh = ('0' + dt.getHours()).slice(-2), mm = ('0' + dt.getMinutes()).slice(-2), ss = ('0' + dt.getSeconds()).slice(-2);
            marksHtml += '<tr>' +
                '<td style="padding:3px;border-top:1px solid rgba(255,255,255,0.05);">' + _esc(m.label) + '</td>' +
                '<td style="padding:3px;text-align:right;color:' + msColor + ';border-top:1px solid rgba(255,255,255,0.05);">' + m.ms.toFixed(0) + ' ms</td>' +
                '<td style="padding:3px;text-align:right;color:var(--text-sub);border-top:1px solid rgba(255,255,255,0.05);">' + hh + ':' + mm + ':' + ss + '</td>' +
                '</tr>';
        }
        marksHtml += '</tbody></table>';
    }

    container.innerHTML =
        '<div class="w10-panel" style="padding:8px;">' +
            '<div style="display:flex;gap:14px;margin-bottom:10px;">' +
                '<div style="flex:1;text-align:center;background:rgba(255,255,255,0.04);border-radius:6px;padding:8px;">' +
                    '<div style="font-size:10px;color:var(--text-sub);">FPS</div>' +
                    '<div style="font-size:28px;font-weight:700;color:' + fpsColor + ';line-height:1.1;">' + _fps + '</div>' +
                '</div>' +
                '<div style="flex:1;text-align:center;background:rgba(255,255,255,0.04);border-radius:6px;padding:8px;">' +
                    '<div style="font-size:10px;color:var(--text-sub);">内存</div>' +
                    '<div style="font-size:22px;font-weight:700;color:var(--text);line-height:1.1;margin-top:2px;">' + _esc(_fmtMem()) + '</div>' +
                '</div>' +
            '</div>' +
            '<div style="font-size:12px;color:var(--text-sub);margin-bottom:2px;">内存趋势</div>' +
            memChart +
            '<div style="font-size:12px;color:var(--text-sub);margin:10px 0 4px;">最近 5 次渲染耗时</div>' +
            marksHtml +
            '<div style="margin-top:10px;padding:6px;background:rgba(74,158,255,0.06);border-left:2px solid rgba(74,158,255,0.4);border-radius:3px;font-size:10px;color:var(--text-sub);line-height:1.5">' +
                '💡 配合「🧪 社区性能测试」磁贴使用. 滑动那边的瀑布流, 这里看实时数据.<br>' +
                'FPS &lt; 30 = 卡顿 · 30-50 = 一般 · &gt; 50 = 流畅' +
            '</div>' +
        '</div>';
}

function _refreshPanel() {
    if (_activeContainer && _activeContainer.isConnected) {
        _renderPanel(_activeContainer);
    }
}

// ========== 注册磁贴 ==========
TileAPI.registerTile({
    id: 'perf-monitor',
    group: 'main',
    icon: '📈',
    label: '性能监测',
    desc: 'FPS / 内存 / 渲染耗时',
    live: true,
    defaultSize: { w: 1, h: 1 },
    minSize: { w: 1, h: 1 },
    maxSize: { w: 3, h: 4 },

    renderFront: renderFront,

    onExpand: function(container) {
        _activeContainer = container;
        _startTick();
        _renderPanel(container);
        return function() { _stopTick(); _activeContainer = null; };
    },

    onCollapse: function() { _stopTick(); _activeContainer = null; }
});

})();
