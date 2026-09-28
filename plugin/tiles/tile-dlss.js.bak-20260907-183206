// ============================================================
//  tile-dlss.js — DLSS 画质增强磁贴 (GUI 在磁贴内, 引擎静默后台跑)
//
//  前端: 磁贴展开后显示参数面板 + 预览对比 + 状态灯。
//  后端: tile-dlss.host.js 负责连引擎/抓选区/渲染/贴回。
//
//  DLSS 引擎是独立 Python 进程 (dlss_server.py, pythonw 静默跑,
//  监听 127.0.0.1:7879)。磁贴通过 host 层 fetch 连它, 不弹任何窗口。
//
//  工作流:
//    1. 探测引擎状态 (状态灯)
//    2. 点「抓选区」→ host 抓当前 PS 选区 → 存 _capture
//    3. 调参数滑块
//    4. 点「渲染」→ 推选区给引擎 → 拿增强图 → 预览对比
//    5. 点「贴回」→ 增强结果贴回 PS 新图层
// ============================================================
(function() {
'use strict';

// ---- 引擎端点 (host 层同款, 探测状态用) ----
var ENGINE_BASE = 'http://127.0.0.1:7879';
var STATUS_TIMEOUT_MS = 3000;

// ---- 磁贴状态 ----
var _activeContainer = null;
var _busy = false;
// 忙碌看门狗: 兜底防按钮锁死。任何原因(消息丢失/host 异常/引擎无响应)导致
// 收不到回执时, 到点自动释放按钮并提示, 用户不会被卡住。
var _busyWatchdog = null;
var _BUSY_MAX_MS = 20 * 60 * 1000;   // 20 分钟(超大图渲染可能很久, 给足余量)
function _armBusyWatchdog(what) {
    _clearBusyWatchdog();
    _busyWatchdog = setTimeout(function() {
        _busyWatchdog = null;
        if (!_busy) return;
        _busy = false;
        _autoRun = false;   // 中断一键流程, 避免状态残留
        _clearRenderTicker();
        try { TileAPI.toast(what + '超时未返回, 已解除按钮锁定(引擎可能仍在跑, 可查看日志)', 'warn'); } catch (e) {}
        if (_activeContainer && _activeContainer.isConnected) _renderPanel(_activeContainer);
    }, _BUSY_MAX_MS);
}
function _clearBusyWatchdog() {
    if (_busyWatchdog) { clearTimeout(_busyWatchdog); _busyWatchdog = null; }
}
// 渲染计时器: 大图渲染+写盘可能 1 分钟以上, 按钮上显示秒数, 让用户知道在跑而非卡死
var _renderTicker = null;
function _clearRenderTicker() {
    if (_renderTicker) { clearInterval(_renderTicker); _renderTicker = null; }
}
var _status = { reachable: false, data: { engineReady: false, gpu: {}, runtime: '', lastRenderMs: 0, renderCount: 0 }, error: '' };
var _capture = null;          // { base64, selection, docId, docName, docPath }
var _result = null;           // { base64, isFile, diff, w, h, ms }
var _placed = false;          // 当前 _result 是否已贴回(防重复贴, 面板显示已完成)
var _autoRun = false;         // 一键流程中: 抓取完自动渲染, 渲染完自动贴回
var _stageName = '';          // 当前阶段名(按钮上显示)
var _stageT0 = 0;             // 当前阶段开始时间
// 只保留基础、不占性能的参数。放大类功能(倍率/SR预设/超分算法)与自动遮罩已移除:
// 放大对服务器开销大且用户端不开放; 遮罩实测收益低。scale 固定 1(原生尺寸增强, 不放大)。
var _params = {
    style: 0,        // 渲染风格: 默认/自然/电影
    scale: 1,        // 固定 1x —— 不放大(用户端已砍掉放大功能)
    intensity: 1.0,  // 处理强度
    localTone: 1.0,  // 本地色调
    localStruct: 1.0,// 本地结构
    skin: 1.0,       // 皮肤质感
    smoothProtect: 0.6, // 平滑区保护
    uiCorrection: 0, // 文字/UI 矫正
    colorMatch: 0    // 精准校色: 回图自动嵌入校色图层(本机计算, 不额外扣分)
};

function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ---- 参数显示辅助 ----
var STYLE_LABELS = { 0: '默认', 1: '自然', 2: '电影' };
function _scaleLabel(s) { return s + 'x'; }

// 从磁盘读回记忆的参数 (存储 key 统一前缀 dlss.)
function _loadParams() {
    var saved = TileAPI.storage.get('dlss.params');
    if (saved && typeof saved === 'object') {
        for (var k in _params) {
            if (Object.prototype.hasOwnProperty.call(saved, k) && saved[k] != null) _params[k] = saved[k];
        }
    }
    // 放大功能已下线: 老用户存储里可能残留 scale=2/3, 强制锁回 1x, 防止偷偷启用放大。
    _params.scale = 1;
}
function _saveParams() {
    TileAPI.storage.set('dlss.params', JSON.parse(JSON.stringify(_params)));
}

// ============================================================
//  引擎状态探测 (轮询给前端面板)
// ============================================================
function _engBase() {
    // 引擎地址: 可存储覆盖, 默认本机 7879 (与 host 端一致)
    try {
        var b = TileAPI.storage.get('dlss.engineBase');
        return b || 'http://127.0.0.1:7879';
    } catch (e) { return 'http://127.0.0.1:7879'; }
}

function _pollStatus() {
    // host 层用 fetch 连引擎; 前端不直接 fetch (UXP 前端跨域受限), 走 host
    TileAPI.sendToHost('dlssStatus', { engineBase: _engBase() });
}

function _applyStatus(s) {
    _status = s || { reachable: false, data: {}, error: '' };
    if (_activeContainer && _activeContainer.isConnected) {
        var dot = _activeContainer.querySelector('#dlssGpuDot');
        var gpuEl = _activeContainer.querySelector('#dlssGpuName');
        var rtEl = _activeContainer.querySelector('#dlssRtName');
        var errEl = _activeContainer.querySelector('#dlssErr');
        if (dot) dot.className = 'w10-toggle ' + (_status.reachable && _status.data.engineReady ? 'on' : '');
        if (gpuEl) gpuEl.textContent = (_status.data && _status.data.gpu && _status.data.gpu.name) || '未检测到 GPU';
        if (rtEl) rtEl.textContent = _status.data.runtime ? ('RTX ' + _status.data.runtime) : '—';
        if (errEl) {
            var err = _status.error || (_status.data && _status.data.engineError) || '';
            errEl.textContent = err ? ('⚠ ' + err.slice(0, 80)) : '';
            errEl.style.display = err ? '' : 'none';
        }
        // 状态栏信息
        var infoEl = _activeContainer.querySelector('#dlssStatInfo');
        if (infoEl) {
            var msInfo = _status.data && _status.data.lastRenderMs ? (' · 上次渲染 ' + _status.data.lastRenderMs + 'ms · 已渲染 ' + _status.data.renderCount + ' 次') : '';
            infoEl.textContent = (_status.reachable ? '引擎在线' : '引擎离线') + (msInfo || '');
        }
    }
    // 同步磁贴正面图标状态 (未展开也能看到灯)
    _refreshFront();
}

// ============================================================
//  正面渲染 (磁贴收起状态: 图标 + 状态)
//  展开时用 onExpand 重绘, 收起/保持时磁贴框架会调 renderFront,
//  这里只需要在状态变化时主动触发一次重绘 (通过 TileEngine.rerenderTile)。
// ============================================================
function _refreshFront() {
    // 状态变化 → 让磁贴框架重绘正面 (若已挂载)
    try {
        if (window.TileEngine && typeof window.TileEngine.rerenderTile === 'function') {
            window.TileEngine.rerenderTile('dlss');
        }
    } catch (e) {}
}

// ============================================================
//  展开面板渲染
// ============================================================
function _renderPanel(container) {
    container.innerHTML =
        '<div class="w10-panel dlss-panel">' +
          '<div class="w10-section-title">🖥 DLSS 画质增强 <span style="color:#9a9aad;font-size:11px;font-weight:400">· 神经渲染</span></div>' +
          // 引擎状态: 一行搞定(状态灯 + GPU), 不占版面
          '<div class="w10-row">' +
            '<div class="w10-row-left"><div class="w10-row-label">引擎</div>' +
              '<div class="w10-row-desc" id="dlssStatInfo">探测中…</div></div>' +
            '<div class="w10-row-right"><div class="w10-toggle" id="dlssGpuDot"></div></div>' +
          '</div>' +
          '<div class="w10-row-desc" id="dlssErr" style="color:#ff6b6b;display:none;margin-top:2px"></div>' +

          // 参数
          '<div class="w10-section-title" style="margin-top:14px">增强参数</div>' +
          _sliderRow('dlssIntensity', '处理强度', 'DLSS 效果整体权重', 0, 1, 0.01, _params.intensity, function(v) { return v.toFixed(2); }) +
          _sliderRow('dlssTone', '本地色调', '保留局部明暗与色彩变化', 0, 1, 0.01, _params.localTone, function(v) { return v.toFixed(2); }) +
          _sliderRow('dlssStruct', '本地结构', '保留局部边缘与纹理细节', 0, 1, 0.01, _params.localStruct, function(v) { return v.toFixed(2); }) +
          _sliderRow('dlssSkin', '皮肤质感', '面部/皮肤细节强化', 0, 2, 0.01, _params.skin, function(v) { return v.toFixed(2); }) +
          _sliderRow('dlssSmooth', '平滑区保护', '抑制平坦渐变区的颗粒杂色(0 关闭)', 0, 1, 0.05, _params.smoothProtect, function(v) { return v.toFixed(2); }) +

          // 渲染风格
          '<div class="w10-row">' +
            '<div class="w10-row-left"><div class="w10-row-label">渲染风格</div></div>' +
            '<div class="w10-row-right"><select class="w10-select" id="dlssStyle" style="width:110px">' +
              '<option value="0"' + (_params.style === 0 ? ' selected' : '') + '>默认</option>' +
              '<option value="1"' + (_params.style === 1 ? ' selected' : '') + '>自然</option>' +
              '<option value="2"' + (_params.style === 2 ? ' selected' : '') + '>电影</option>' +
            '</select></div>' +
          '</div>' +

          // 开关
          '<div class="w10-row">' +
            '<div class="w10-row-left"><div class="w10-row-label">文字/UI 矫正</div><div class="w10-row-desc">处理截图时防糊字</div></div>' +
            '<div class="w10-row-right"><div class="w10-toggle' + (_params.uiCorrection ? ' on' : '') + '" id="dlssUiFix"></div></div>' +
          '</div>' +
          '<div class="w10-row">' +
            '<div class="w10-row-left"><div class="w10-row-label">🎯 精准校色</div><div class="w10-row-desc">回图自动嵌入校色图层, 避免过度改 HSL(本机计算, 不额外扣分)</div></div>' +
            '<div class="w10-row-right"><div class="w10-toggle' + (_params.colorMatch ? ' on' : '') + '" id="dlssColorMatch"></div></div>' +
          '</div>' +

          // 一键处理: 抓选区 → 增强 → 自动贴回(每次扣 1 积分)
          '<div class="dlss-actions" style="display:flex;gap:8px;margin-top:16px">' +
            '<button class="w10-btn w10-btn-accent" id="dlssRunBtn" style="flex:1"' + (_busy ? ' disabled' : '') + '>' +
              (_busy ? '处理中…' : '✨ 一键增强 (选区 → 自动贴回)') + '</button>' +
          '</div>' +
          '<div class="w10-row-desc" style="margin-top:6px;text-align:center">在 PS 里框选区域后点击, 每次消耗 <b>1 积分</b></div>' +
          '<div class="w10-row-desc" style="margin-top:4px;text-align:center;color:#9a9aad;font-size:10px;line-height:1.5">' +
            '慢不是 DLSS 慢, 也不是服务器慢 —— 是夏三七太穷了没钱买高速宽带, 传输慢。V7 版本会租好服务器的！' +
          '</div>' +

          // 传输进度条: 上传/计算/下载三阶段, 由 host 的 dlssProgress 消息驱动
          '<div id="dlssProg" style="display:none;margin-top:10px">' +
            '<div style="height:6px;border-radius:3px;background:rgba(255,255,255,0.08);overflow:hidden">' +
              '<div id="dlssProgBar" style="height:100%;width:0%;background:var(--accent);transition:width .2s linear"></div>' +
            '</div>' +
            '<div id="dlssProgTxt" class="w10-row-desc" style="margin-top:4px;text-align:center;font-size:10px"></div>' +
          '</div>' +

          // 结果信息
          '<div class="w10-row-desc" id="dlssPrevInfo" style="margin-top:10px;text-align:center"></div>' +
        '</div>';
    _bind(container);
    _renderPreview(container);
}

function _sliderRow(id, label, desc, min, max, step, val, fmt) {
    var pct = ((val - min) / (max - min) * 100).toFixed(1);
    var shown = fmt ? fmt(val) : val;
    return '<div class="w10-row" style="flex-direction:column;align-items:stretch;gap:4px;padding:6px 0;">' +
        '<div class="w10-row-label" style="font-size:11px;">' + _esc(label) + '</div>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '" style="flex:1">' +
          '<span class="w10-ps-val" id="' + id + 'Val" style="min-width:38px;text-align:right">' + shown + '</span>' +
        '</div>' +
        '<div class="w10-row-desc" style="font-size:10px;">' + _esc(desc) + '</div>' +
    '</div>';
}

// ---- 事件绑定 ----
function _bind(container) {
    // 滑块绑定
    _bindSlider(container, 'dlssIntensity', 'intensity', 0, 1);
    _bindSlider(container, 'dlssTone', 'localTone', 0, 1);
    _bindSlider(container, 'dlssStruct', 'localStruct', 0, 1);
    _bindSlider(container, 'dlssSkin', 'skin', 0, 2);
    _bindSlider(container, 'dlssSmooth', 'smoothProtect', 0, 1);

    // 下拉绑定(只剩渲染风格)
    var style = container.querySelector('#dlssStyle');
    if (style) style.addEventListener('change', function() { _params.style = +this.value || 0; _saveParams(); });

    // 开关绑定
    var uf = container.querySelector('#dlssUiFix');
    if (uf) uf.addEventListener('click', function() { _params.uiCorrection = _params.uiCorrection ? 0 : 1; uf.classList.toggle('on', !!_params.uiCorrection); _saveParams(); });
    var cm = container.querySelector('#dlssColorMatch');
    if (cm) cm.addEventListener('click', function() { _params.colorMatch = _params.colorMatch ? 0 : 1; cm.classList.toggle('on', !!_params.colorMatch); _saveParams(); });

    // ---- 一键增强: 抓选区 → 渲染 → 自动贴回 ----
    var runBtn = container.querySelector('#dlssRunBtn');
    if (runBtn) runBtn.addEventListener('click', function() {
        if (_busy) return;
        _busy = true;
        _autoRun = true;            // 标记自动流程: 抓取完自动渲染, 渲染完自动贴回
        _placed = false;
        _result = null;
        _startStageTicker('抓取选区');
        _armBusyWatchdog('处理');
        TileAPI.sendToHost('dlssCapture', {});
    });
}

// 阶段计时器: 按钮显示「抓取选区… 3s」, 让用户知道在跑哪一步(大图各步都可能几十秒)
function _startStageTicker(stage) {
    _stageName = stage;
    _stageT0 = Date.now();
    _clearRenderTicker();
    _renderTicker = setInterval(function() {
        if (!_busy) { _clearRenderTicker(); return; }
        var el = _activeContainer && _activeContainer.querySelector('#dlssRunBtn');
        if (el) el.textContent = _stageName + '… ' + Math.round((Date.now() - _stageT0) / 1000) + 's';
    }, 1000);
    var el0 = _activeContainer && _activeContainer.querySelector('#dlssRunBtn');
    if (el0) { el0.textContent = _stageName + '…'; el0.disabled = true; }
}

function _bindSlider(container, id, key, min, max, fmt) {
    var sl = container.querySelector('#' + id);
    var val = container.querySelector('#' + id + 'Val');
    if (!sl) return;
    sl.addEventListener('input', function() {
        var v = parseFloat(this.value);
        _params[key] = v;
        if (val) val.textContent = fmt ? fmt(v) : v.toFixed(2);
        this.style.setProperty('--fill', ((v - min) / (max - min) * 100).toFixed(1) + '%');
    });
    sl.addEventListener('change', function() { _saveParams(); });
    // 初始化进度条
    sl.style.setProperty('--fill', ((parseFloat(sl.value) - min) / (max - min) * 100).toFixed(1) + '%');
}

// ---- 预览渲染 ----
// 抓取阶段 host 已拼出「原图缩略」previewB64, 直接显示; 渲染后再显示增强图。
function _renderPreview(container) {
    // 一键流程不做中间预览(图在服务端算, 且大图 base64 前端扛不住), 只更新结果信息文字。
    var info = container.querySelector('#dlssPrevInfo');
    if (!info) return;
    if (_result) {
        info.innerHTML = '✅ ' + _result.w + '×' + _result.h +
            (_result.ms ? ' · 耗时 ' + _result.ms + 'ms' : '') +
            (_placed ? '<br><span style="color:#76b900">已贴回 PS 图层</span>' : '');
    } else {
        info.textContent = '';
    }
}

// ============================================================
//  host 消息处理
// ============================================================
// ---- 传输进度条 ----
function _fmtMB(b) { return ((b || 0) / 1048576).toFixed(1) + ' MB'; }

function _updateProg(d) {
    if (!_activeContainer || !_activeContainer.isConnected) return;
    var box = _activeContainer.querySelector('#dlssProg');
    var bar = _activeContainer.querySelector('#dlssProgBar');
    var txt = _activeContainer.querySelector('#dlssProgTxt');
    if (!box || !bar || !txt) return;
    box.style.display = '';
    if (d.phase === 'process') {
        // 服务器算图, 没有可量化的进度 —— 条走满并说明在等什么
        bar.style.width = '100%';
        txt.textContent = '服务器计算中… 已等 ' + (d.elapsed || 0) + 's';
        return;
    }
    var pct = Math.round((d.ratio || 0) * 100);
    bar.style.width = pct + '%';
    var name = (d.phase === 'upload') ? '上传' : '下载';
    var spd = d.speed ? (' · ' + _fmtMB(d.speed) + '/s') : '';
    txt.textContent = name + ' ' + _fmtMB(d.done) + ' / ' + _fmtMB(d.total) + spd + ' · ' + pct + '%';
}

function _hideProg() {
    if (!_activeContainer || !_activeContainer.isConnected) return;
    var box = _activeContainer.querySelector('#dlssProg');
    if (box) box.style.display = 'none';
}

function _onHostMessage(action, data) {
    if (action === 'dlssStatusResult') {
        _applyStatus(data);
        return;
    }
    if (action === 'dlssProgress') {
        _updateProg(data || {});
        // 有进度就说明链路活着 —— 把看门狗重新计时, 改成「20 分钟没动静才算卡死」
        if (_busy) _armBusyWatchdog('增强');
        return;
    }
    // 收到任何「结果类」回执 → 链路通, 撤掉看门狗(各分支自己管 _busy)
    if (action === 'dlssCaptureResult' || action === 'dlssRenderResult' ||
        action === 'dlssPlaceBackResult' || action === 'dlssColorMatchDone' ||
        action === 'dlssStartResult') {
        _clearBusyWatchdog();
        _clearRenderTicker();
        if (action === 'dlssRenderResult') _hideProg();   // 传输结束, 收起进度条
    }
    if (action === 'dlssStartResult') {
        _busy = false;
        if (data && data.ok) TileAPI.toast('DLSS 引擎已拉起, 等待就绪…', 'success');
        else TileAPI.toast('启动失败: ' + ((data && data.error) || ''), 'error');
        _pollStatus();
        return;
    }
    if (action === 'dlssCaptureResult') {
        if (data && data.success) {
            _capture = data;
            _result = null;   // 新选区, 清掉旧结果
            _placed = false;
            var capSize = (data.capturedW && data.capturedH) ? (' · ' + data.capturedW + '×' + data.capturedH) : '';
            TileAPI.toast('选区已抓取' + capSize, 'success');
            if (_autoRun) {
                // 一键流程: 抓完直接送去增强(保持 busy, 不放开按钮)
                _startStageTicker('增强中');
                _armBusyWatchdog('增强');
                TileAPI.sendToHost('dlssRender', {
                    base64: _capture.base64,
                    settings: JSON.parse(JSON.stringify(_params)),
                    engineBase: _engBase()
                });
                return;   // 不重绘面板(避免打断计时器), 等渲染结果
            }
            _busy = false;
        } else {
            _busy = false; _autoRun = false;
            TileAPI.toast('抓取失败: ' + ((data && data.error) || ''), 'error');
        }
        if (_activeContainer && _activeContainer.isConnected) _renderPanel(_activeContainer);
        return;
    }
    if (action === 'dlssRenderResult') {
        _busy = false;
        if (data && data.success) {
            // isFile=true: 大图结果在 host 内存(前端拿不到 base64 —— 超大图 base64 会撑爆
            // JS 字符串)。贴回时 host 会用内存里的完整结果。
            _result = { base64: data.base64 || '', isFile: !!data.isFile, w: data.w, h: data.h, ms: data.ms };
            _placed = false;   // 新结果, 可以贴回
            // 云端计费: 显示扣分后的余额
            var balTxt = (typeof data.balance === 'number')
                ? (' · 已扣 ' + (data.consumed || 1) + ' 积分, 余额 ' + data.balance) : '';
            var doneMsg = '✅ 增强完成 ' + data.w + '×' + data.h + balTxt;
            TileAPI.toast(doneMsg, 'success');
            if (_autoRun) {
                // 一键流程: 增强完直接贴回(保持 busy)
                _startStageTicker('贴回图层');
                _armBusyWatchdog('贴回');
                TileAPI.sendToHost('dlssPlaceBack', {
                    base64: _result.base64,
                    docId: _capture ? _capture.docId : null,
                    selection: _capture ? _capture.selection : null,
                    antiMode: 0,
                    layerType: 'smartObject',
                    taskId: 'dlss',
                    colorMatch: !!_params.colorMatch
                });
                return;   // 等贴回结果
            }
        } else {
            _autoRun = false;
            TileAPI.toast('增强失败: ' + ((data && data.error) || ''), 'error');
        }
        if (_activeContainer && _activeContainer.isConnected) _renderPanel(_activeContainer);
        return;
    }
    if (action === 'dlssPlaceBackResult') {
        if (data && data.success) {
            _placed = true;          // 已贴回
            // 开了校色: 校色图层随后异步贴, 保持 busy 等 dlssColorMatchDone
            if (_params && _params.colorMatch) {
                TileAPI.toast('已贴回, 正在算校色图层…', 'success');
                _startStageTicker('校色中');
                _armBusyWatchdog('校色');
                if (_activeContainer && _activeContainer.isConnected) _renderPanel(_activeContainer);
                return;
            }
            TileAPI.toast('✅ 完成: 已增强并贴回 PS 图层', 'success');
        } else {
            TileAPI.toast('贴回失败: ' + ((data && data.error) || ''), 'error');
        }
        _busy = false; _autoRun = false;
        if (_activeContainer && _activeContainer.isConnected) _renderPanel(_activeContainer);
        return;
    }
    if (action === 'dlssColorMatchDone') {
        _busy = false; _autoRun = false;
        if (data && data.ok) TileAPI.toast('✅ 完成: 已增强 + 嵌入校色图层', 'success');
        else TileAPI.toast('已贴回, 但校色图层嵌入失败', 'warn');
        if (_activeContainer && _activeContainer.isConnected) _renderPanel(_activeContainer);
        return;
    }
}


// ============================================================
//  注册磁贴
// ============================================================
_loadParams();

TileAPI.registerTile({
    id: 'dlss',
    group: 'main',
    icon: '🟩',         // DLSS 画质增强
    label: 'DLSS 增强',
    desc: '5090 神经网络画质增强 + 超分',
    live: false,
    defaultSize: { w: 2, h: 2 },
    minSize: { w: 1, h: 1 },
    maxSize: { w: 4, h: 6 },

    renderFront: function(container, w) {
        var online = _status.reachable && _status.data.engineReady;
        var dotCls = online ? (w >= 2 ? ' dlss-front-on' : '') : '';
        var icon = online ? '🟩' : '🟨';
        if (w >= 2) {
            container.innerHTML = '<div class="tile-icon">' + icon + '</div><div class="tile-label">DLSS 增强</div><div class="tile-desc">' + (online ? '引擎在线' : '引擎待启动') + '</div>';
        } else {
            container.innerHTML = '<div class="tile-icon">' + icon + '</div><div class="tile-label">DLSS</div>';
        }
    },

    onExpand: function(container) {
        _activeContainer = container;
        _renderPanel(container);
        _pollStatus();
        // 每 6 秒轮询引擎状态
        var timer = setInterval(_pollStatus, 6000);
        var prev = _onHostMessage;
        return function() {
            _activeContainer = null;
            clearInterval(timer);
            // 退避: 展开时通过 onHostMessage 处理; 收起后通知 host 不再轮询
        };
    },

    onMessage: function(action, data) {
        _onHostMessage(action, data);
    },

    onStorageLoaded: function(storage) {
        _loadParams();
    }
});

// 注意: 磁贴消息通过 tileDef.onMessage 统一分发 (app.js 会遍历所有磁贴调用 onMessage),
// 不要再额外 TileAPI.onHostMessage 注册——否则同一条消息会被处理两次。

// 启动时主动探测一次引擎状态 (让磁贴正面灯就有状态)
window.addEventListener('load', function() {
    setTimeout(function() { _pollStatus(); }, 500);
});

})();
