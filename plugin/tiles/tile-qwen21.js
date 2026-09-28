// ============================================================
//  tile-qwen21.js — 「Qwen2.1 大家一起研究」磁贴
//
//  这是一个研究项目，不是免费改图工具。所以：
//    · 打开磁贴第一件事是弹协议，不同意就不给用
//    · 面板上只有两个可操作项：抓选区、写提示词
//    · 参数全部锁死（resolution=0 / 25步 / cfg=1.0），用户改不了也不用知道
//
//  后端：tiles/tile-qwen21.host.js
//  服务：作者本机的云改图网关（局域网调试时是 127.0.0.1:8196）
// ============================================================
(function () {
'use strict';

var POLICY_VERSION = '2026-09-22';

// 网关地址。局域网调试 = 本机；正式走 cpolar 隧道。
// cpolar.yml 里那条隧道：test11 → 子域名 qwentest → 本地 8196 → 线路 cn_vip_top
// ⚠️ 别给 8199（控制口）建隧道，那是重启开关。
var DEFAULT_GATEWAY = 'https://qwentest.vip.cpolar.top';

// ---- 状态 ----
var _activeContainer = null;
var _busy = false;
var _watchdog = null;
var _BUSY_MAX_MS = 10 * 60 * 1000;

var _status = null;      // 网关返回的状态
var _capture = null;     // { width, height, kb, raw(原始PNG base64) }
var _prompt = '';
var _quality = '2k';
var _job = null;         // { id, state, step, steps, ahead }
var _pollTimer = null;
var _placed = false;
var _history = null;
var _lastError = '';

function _esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _gw() {
    return TileAPI.storage.get('qwen21.gateway') || DEFAULT_GATEWAY;
}

function _agreed() {
    return TileAPI.storage.get('qwen21.policy') === POLICY_VERSION;
}

function _armWatchdog(what) {
    _clearWatchdog();
    _watchdog = setTimeout(function () {
        _watchdog = null;
        if (!_busy) return;
        _busy = false;
        _stopPoll();
        try { TileAPI.toast(what + '超时未返回，已解除锁定', 'warn'); } catch (e) {}
        _render(_activeContainer);
    }, _BUSY_MAX_MS);
}
function _clearWatchdog() { if (_watchdog) { clearTimeout(_watchdog); _watchdog = null; } }
function _stopPoll() { if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; } }

// ============================================================
//  协议弹窗 —— 打开磁贴第一件事
// ============================================================
var POLICY_HTML = [
    '<div class="q21-policy">',
    '<h3>🧪 参加前请读完</h3>',
    '<p class="q21-p-lead">这是我和大家一起做的<b>提示词研究</b>，不是免费改图工具。',
    '一起试 <b>Qwen-Image-2.1</b> 这个新模型，看看什么提示词管用、什么不管用，把经验攒起来。</p>',

    '<div class="q21-p-block">',
    '<h4>参与条件</h4>',
    '<ul><li>必须登录</li><li>积分 ≥ 1000（有 AI 使用基础，不浪费算力）</li></ul>',
    '</div>',

    '<div class="q21-p-block">',
    '<h4>你会得到</h4>',
    '<ul>',
    '<li><b>2K 画质：10 张</b>（长边 2048 以内）</li>',
    '<li><b>1K 画质：不限额</b>，每分钟 1 张</li>',
    '<li>有专属称号的同学，1K 不限速</li>',
    '<li>实验环境，别人也在用，<b>需要排队</b></li>',
    '</ul>',
    '</div>',

    '<div class="q21-p-block q21-p-warn">',
    '<h4>⚠️ 最重要：生成的图不能商用</h4>',
    '<p>Qwen-Image-2.1 的许可证原文写得很死：</p>',
    '<p class="q21-quote">"Non-Commercial" shall mean <b>for research or evaluation purposes only</b>.<br>（"非商业" = 只用于研究或评估目的）</p>',
    '<p><b>可以：</b></p>',
    '<ul><li>✅ 自己的照片，自己修着玩</li><li>✅ 配合研究做测试、做对比</li><li>✅ 学习了解这个模型</li></ul>',
    '<p><b>不可以：</b></p>',
    '<ul><li>❌ 接单、帮客户修图收钱</li><li>❌ 把生成的图拿去卖</li><li>❌ 用在任何能换钱的用途上</li></ul>',
    '<p class="q21-p-foot">这条是模型作者定的，不是我定的。你违反了，责任在你身上。</p>',
    '</div>',

    '<div class="q21-p-block">',
    '<h4>你的图和提示词</h4>',
    '<ul>',
    '<li>会被保存下来<b>用于分析</b> —— 我们只看不同提示词产生了什么不同结果</li>',
    '<li><b>绝对不会</b>拿去训练、微调模型，或喂给任何模型</li>',
    '<li>保存 <b>7 天</b>，之后自动删除</li>',
    '</ul>',
    '</div>',

    '<div class="q21-p-block">',
    '<h4>结果你自己负责</h4>',
    '<p>模型是 SFW 的，正常使用没问题。但生成什么、拿去干什么，<b>责任在你</b>。',
    '做了违法的事，那是你的事，不是这个研究项目的事。</p>',
    '</div>',

    '<div class="q21-p-block">',
    '<h4>实验环境，随时可能出问题</h4>',
    '<ul>',
    '<li>用的是我自己的机器 —— <b>我关机、跑别的任务、玩游戏，服务就会慢或停</b></li>',
    '<li>可能排队很久、可能失败、可能中断</li>',
    '<li><b>我可以随时结束这个研究，不另行通知</b></li>',
    '</ul>',
    '<p class="q21-p-foot">要稳定，请装本地版。</p>',
    '</div>',

    '<div class="q21-p-block q21-p-legal">',
    '<p>完整协议（引用自 Qwen Research License Agreement，2026-09-20 发布）：</p>',
    '<p>本模型著作权归杭州通义实验室科技有限公司所有，依 Qwen Research License Agreement 授权。',
    '该协议第 1 条 i 款定义 "Non-Commercial" 为仅用于研究或评估目的；第 2 条 a 款规定材料只能用于非商业目的。<br>',
    'Qwen is licensed under the Qwen RESEARCH LICENSE AGREEMENT, Copyright (c) 2026 Hangzhou Tongyi Laboratory Technology Co., Ltd. All Rights Reserved.</p>',
    '</div>',

    '</div>'
].join('');

function _showPolicy(container, onAgree) {
    var old = document.getElementById('q21PolicyOverlay');
    if (old) old.parentNode.removeChild(old);

    var ov = document.createElement('div');
    ov.id = 'q21PolicyOverlay';
    ov.className = 'q21-overlay';
    ov.innerHTML =
        '<div class="q21-modal">' +
        '<div class="q21-modal-head"><span>🧪 Qwen2.1 大家一起研究</span>' +
        '<span class="q21-modal-x" id="q21PolicyClose">✕</span></div>' +
        '<div class="q21-modal-body">' + POLICY_HTML + '</div>' +
        '<div class="q21-modal-foot">' +
        '<div class="q21-btn q21-btn-ghost" id="q21PolicyNo">不参加</div>' +
        '<div class="q21-btn q21-btn-primary" id="q21PolicyYes">我已阅读并同意，参加研究</div>' +
        '</div></div>';

    document.body.appendChild(ov);

    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }

    ov.querySelector('#q21PolicyYes').addEventListener('click', function () {
        TileAPI.storage.set('qwen21.policy', POLICY_VERSION);
        TileAPI.storage.set('qwen21.policyAt', new Date().toISOString());
        close();
        try { TileAPI.toast('已加入研究，谢谢参与', 'success'); } catch (e) {}
        if (onAgree) onAgree();
    });
    ov.querySelector('#q21PolicyNo').addEventListener('click', close);
    ov.querySelector('#q21PolicyClose').addEventListener('click', close);
}

// ============================================================
//  面板渲染
// ============================================================
function _render(container) {
    if (!container || !container.isConnected) return;

    if (!_agreed()) {
        container.innerHTML =
            '<div class="q21-wrap q21-wrap-center">' +
            '<div class="q21-big">🧪</div>' +
            '<div class="q21-title">Qwen2.1 大家一起研究</div>' +
            '<div class="q21-sub">提示词研究项目 · 需要先同意参与须知</div>' +
            '<div class="q21-btn q21-btn-primary" id="q21ReadPolicy">阅读参与须知</div>' +
            '</div>';
        container.querySelector('#q21ReadPolicy').addEventListener('click', function () {
            _showPolicy(container, function () { _render(container); _refresh(); });
        });
        return;
    }

    var s = _status;
    if (!s) {
        container.innerHTML =
            '<div class="q21-wrap q21-wrap-center">' +
            '<div class="q21-big">⏳</div><div class="q21-sub">正在连接研究服务器…</div>' +
            '<div class="q21-btn q21-btn-ghost" id="q21Retry">重试</div></div>';
        container.querySelector('#q21Retry').addEventListener('click', function () { _refresh(); });
        return;
    }

    if (!s.ok) {
        var needLogin = s.need_login;
        container.innerHTML =
            '<div class="q21-wrap q21-wrap-center">' +
            '<div class="q21-big">' + (needLogin ? '🔒' : '⚠️') + '</div>' +
            '<div class="q21-sub">' + _esc(s.error || '连不上研究服务器') + '</div>' +
            (s.errno === 7
                ? '<div class="q21-hint">积分到 1000 就能参加，继续加油 💪</div>'
                : '') +
            (s.errno === 6
                ? '<div class="q21-hint">这一批名额满了，等下一批开放</div>'
                : '') +
            '<div class="q21-btn q21-btn-ghost" id="q21Retry">重试</div></div>';
        container.querySelector('#q21Retry').addEventListener('click', function () { _refresh(); });
        return;
    }

    // 已通过 → 正常面板
    var off = s.enabled === false;
    var q = s.quota || {};
    var g = s.global || {};
    var k2Left = Math.max(0, (q.k2_max || 0) - (q.k2_used || 0));

    var html = [];
    html.push('<div class="q21-wrap">');

    // 顶部状态条
    html.push('<div class="q21-bar">');
    html.push('<span class="q21-badge ' + (off ? 'q21-bad' : 'q21-good') + '">' +
        (off ? '⛔ 研究暂停' : (g.busy ? '🟡 机器忙' : '🟢 服务正常')) + '</span>');
    if (s.student) html.push('<span class="q21-badge q21-ok">🎓 称号用户 · 1K 不限速</span>');
    html.push('<span class="q21-bar-sp"></span>');
    html.push('<span class="q21-meta">今日全站 ' + (g.today || 0) + '/' + (g.cap || 0) +
        (g.queue ? ' · 排队 ' + g.queue : '') + '</span>');
    html.push('<span class="q21-x" id="q21PolicyView" title="查看参与须知">📄</span>');
    html.push('</div>');

    if (off) {
        html.push('<div class="q21-hint q21-hint-warn">' + _esc(s.notice || '研究暂时停止，稍后再来。') + '</div>');
    }

    // 1. 抓图
    html.push('<div class="q21-sec">');
    html.push('<div class="q21-sec-h">1 · 选择要改的图</div>');
    if (_capture) {
        html.push('<div class="q21-cap">');
        html.push('<img class="q21-thumb" src="data:image/png;base64,' + _capture.raw + '" />');
        html.push('<div class="q21-cap-info"><b>' + _capture.width + ' × ' + _capture.height + '</b>' +
            '<span>' + _capture.kb + ' KB</span></div>');
        html.push('<div class="q21-btn q21-btn-ghost q21-btn-sm" id="q21Recapture">重抓</div>');
        html.push('</div>');
    } else {
        html.push('<div class="q21-btn q21-btn-primary' + (_busy ? ' q21-dis' : '') + '" id="q21Capture">📎 抓取 PS 选区</div>');
        html.push('<div class="q21-tip">先在 Photoshop 里框选你要改的区域，再点这里</div>');
    }
    html.push('</div>');

    // 2. 画质
    html.push('<div class="q21-sec">');
    html.push('<div class="q21-sec-h">2 · 画质</div>');
    html.push('<div class="q21-seg">');
    html.push('<div class="q21-seg-i' + (_quality === '2k' ? ' on' : '') + '" data-q="2k">2K <span class="q21-seg-n">剩 ' + k2Left + ' 张</span></div>');
    html.push('<div class="q21-seg-i' + (_quality === '1k' ? ' on' : '') + '" data-q="1k">1K <span class="q21-seg-n">' + (s.student ? '不限' : '每分钟1张') + '</span></div>');
    html.push('</div>');
    if (_quality === '2k' && k2Left <= 0) {
        html.push('<div class="q21-tip q21-tip-warn">2K 额度用完了，改用 1K 吧</div>');
    }
    html.push('</div>');

    // 3. 提示词
    html.push('<div class="q21-sec">');
    html.push('<div class="q21-sec-h">3 · 告诉它怎么改</div>');
    html.push('<textarea class="q21-ta" id="q21Prompt" maxlength="2000" ' +
        'placeholder="例：把背景换成傍晚的海边，保留人物不变">' + _esc(_prompt) + '</textarea>');
    html.push('<div class="q21-tip"><span id="q21Count">' + _prompt.length + '</span>/2000 字</div>');
    html.push('</div>');

    // 4. 进度 / 结果
    if (_job) {
        html.push('<div class="q21-sec q21-sec-job">');
        html.push('<div class="q21-sec-h">4 · 进度</div>');
        html.push(_renderJob());
        html.push('</div>');
    }

    // 提交按钮
    //
    // ⚠️ 这里原来写成 canSubmit = ... && !_job，导致任务跑完 _job 一直挂着、
    //    "开始改图"就永久灰掉，用户点不了任何东西 —— 就是这个卡死。
    //    正确逻辑：只有"正在跑"才锁按钮；跑完/失败/取消就解锁，让用户接着改下一张。
    var running = _job && (_job.state === 'queued' || _job.state === 'running');
    var canSubmit = !_busy && !off && _capture && !running;

    html.push('<div class="q21-actions">');
    if (running) {
        html.push('<div class="q21-btn q21-btn-primary q21-btn-big q21-dis">处理中…</div>');
    } else {
        var label = _job && _job.state === 'done' ? '再改一张' : '开始改图';
        html.push('<div class="q21-btn q21-btn-primary q21-btn-big' + (canSubmit ? '' : ' q21-dis') + '" id="q21Run">' +
            label + '</div>');
    }
    if (_job && _job.state === 'queued') {
        html.push('<div class="q21-btn q21-btn-ghost" id="q21Cancel">取消排队</div>');
    }
    html.push('</div>');

    if (_lastError) html.push('<div class="q21-hint q21-hint-warn">' + _esc(_lastError) + '</div>');

    // 底部：历史 + 服务器设置
    html.push('<div class="q21-foot">');
    html.push('<span class="q21-link" id="q21History">我的研究记录</span>');
    html.push('<span class="q21-foot-sep">·</span>');
    html.push('<span class="q21-link" id="q21GatewayBtn">服务器</span>');
    html.push('</div>');

    html.push('</div>');

    container.innerHTML = html.join('');
    _bind(container);

    // 底部显示当前连的是哪个服务器（不自定过就显示默认）
    var gwEl = container.querySelector('#q21GatewayBtn');
    if (gwEl && TileAPI.storage.get('qwen21.gateway')) {
        gwEl.textContent = '服务器(自定义)';
    }
}

function _renderJob() {
    var j = _job;
    var pct = 0, label = '';

    if (j.state === 'queued') {
        label = j.ahead ? ('排队中，前面还有 ' + j.ahead + ' 个') : '排队中…';
        pct = 8;
    } else if (j.state === 'running') {
        if (j.steps) {
            pct = Math.max(10, Math.round(j.step / j.steps * 100));
            label = '生成中 第 ' + j.step + '/' + j.steps + ' 步';
        } else {
            pct = 20;
            label = '生成中…（大图会慢一些）';
        }
    } else if (j.state === 'done') {
        pct = 100;
        label = '✅ 完成' + (j.elapsed ? '（' + j.elapsed + ' 秒）' : '') +
            (j.size ? ' · ' + j.size : '');
    } else if (j.state === 'failed') {
        pct = 100;
        label = '❌ ' + (j.error || '失败');
    } else if (j.state === 'cancelled') {
        pct = 100;
        label = '已取消';
    }

    var out = [];
    // 这两个 id 是给 _updateProgressInPlace() 用的 —— 轮询时只改这两个元素，
    // 不整块重画面板（否则会打飞用户的输入焦点和点击）
    out.push('<div class="q21-prog"><div class="q21-prog-bar" id="q21ProgBar" style="width:' + pct + '%"></div></div>');
    out.push('<div class="q21-prog-t" id="q21ProgText">' + _esc(label) + '</div>');
    if (j.state === 'done') {
        if (_placed) {
            out.push('<div class="q21-tip q21-ok-tip">已贴回 PS 新图层</div>');
        } else {
            out.push('<div class="q21-btn q21-btn-primary' + (_busy ? ' q21-dis' : '') + '" id="q21Place">📥 存入文档</div>');
        }
        out.push('<div class="q21-tip">结果在服务器上保留 7 天，之后自动删除</div>');
    }
    if (j.state === 'failed') {
        out.push('<div class="q21-btn q21-btn-ghost" id="q21Again">重新来过</div>');
    }
    return out.join('');
}

// ============================================================
//  事件绑定
// ============================================================
function _bind(container) {
    function $(id) { return container.querySelector('#' + id); }
    function on(id, ev, fn) { var e = $(id); if (e) e.addEventListener(ev, fn); }

    // 查看协议
    on('q21PolicyView', 'click', function () { _showPolicy(container, null); });

    // 抓图
    on('q21Capture', 'click', function () { _doCapture(container); });
    on('q21Recapture', 'click', function () { _capture = null; _render(container); });

    // 画质切换
    // ⚠️ 原来写的是 if (_busy || _job) return —— 任务跑完后 _job 还挂着，
    //    画质就永远切不动了。只有"正在跑"和"正在忙"时才该锁。
    var segs = container.querySelectorAll('.q21-seg-i');
    for (var i = 0; i < segs.length; i++) {
        segs[i].addEventListener('click', function () {
            if (_busy) return;
            if (_job && (_job.state === 'queued' || _job.state === 'running')) {
                try { TileAPI.toast('等这张出完再切', 'info'); } catch (e) {}
                return;
            }
            _quality = this.getAttribute('data-q');
            _render(container);
        });
    }

    // 提示词
    var ta = $('q21Prompt');
    if (ta) {
        ta.addEventListener('input', function () {
            _prompt = this.value;
            var c = $('q21Count');
            if (c) c.textContent = this.value.length;
        });
    }

    // 提交
    on('q21Run', 'click', function () {
        if (_busy) return;
        // ⚠️ 这里原来写的是 if (_busy || _job) return —— 任务跑完后 _job 还挂着，
        //    按钮看着能点、点了直接 return，什么都不发生。
        //    （§同款 bug 在画质切换和按钮禁用逻辑里各有一处，一起改了）
        if (_job && (_job.state === 'queued' || _job.state === 'running')) {
            try { TileAPI.toast('上一张还在跑，等它出图', 'info'); } catch (e) {}
            return;
        }
        if (!_capture) { TileAPI.toast('先抓取选区', 'warn'); return; }
        if (!_prompt.trim()) { TileAPI.toast('写点什么告诉它怎么改', 'warn'); return; }
        // 开新任务前清掉上一次的进度区，否则会跟新进度混在一起
        _job = null;
        _placed = false;
        _doRun(container);
    });

    on('q21Cancel', 'click', function () {
        if (!_job) return;
        TileAPI.sendToHost('qwen21Cancel', { gateway: _gw(), job_id: _job.id });
    });

    on('q21Place', 'click', function () {
        if (_busy || !_job || _job.state !== 'done') return;
        _busy = true; _armWatchdog('贴回');
        _render(container);
        TileAPI.sendToHost('qwen21PlaceBack', { gateway: _gw(), job_id: _job.id });
    });

    on('q21Again', 'click', function () {
        _job = null; _placed = false; _lastError = '';
        _stopPoll();
        _render(container);
    });

    on('q21History', 'click', function () {
        TileAPI.sendToHost('qwen21History', { gateway: _gw() });
    });

    on('q21GatewayBtn', 'click', function () { _showGatewayDialog(); });
}

// 服务器地址设置。给作者调试用，也给"隧道换了地址"时救急 ——
// 不用改代码重发版，用户自己改一行就能继续用。
function _showGatewayDialog() {
    var old = document.getElementById('q21GwOverlay');
    if (old) old.parentNode.removeChild(old);

    var cur = TileAPI.storage.get('qwen21.gateway') || DEFAULT_GATEWAY;
    var ov = document.createElement('div');
    ov.id = 'q21GwOverlay';
    ov.className = 'q21-overlay';
    ov.innerHTML =
        '<div class="q21-modal" style="width:min(420px,92vw);">' +
        '<div class="q21-modal-head"><span>⚙️ 研究服务器地址</span>' +
        '<span class="q21-modal-x" id="q21GwClose">✕</span></div>' +
        '<div class="q21-modal-body">' +
        '<p class="q21-p-lead">一般不用改。如果提示连不上，可能是服务器地址变了 —— 从作者那里拿到新地址填进来。</p>' +
        '<input class="q21-ta" id="q21GwInput" style="min-height:auto;padding:8px;" value="' + _esc(cur) + '" />' +
        '<div class="q21-tip" style="margin-top:6px;">默认：' + _esc(DEFAULT_GATEWAY) + '</div>' +
        '</div>' +
        '<div class="q21-modal-foot">' +
        '<div class="q21-btn q21-btn-ghost" id="q21GwReset">恢复默认</div>' +
        '<div class="q21-btn q21-btn-primary" id="q21GwSave">保存并重连</div>' +
        '</div></div>';
    document.body.appendChild(ov);

    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }

    ov.querySelector('#q21GwClose').addEventListener('click', close);
    ov.querySelector('#q21GwReset').addEventListener('click', function () {
        TileAPI.storage.remove('qwen21.gateway');
        close();
        _status = null;
        if (_activeContainer) { _render(_activeContainer); _refresh(); }
    });
    ov.querySelector('#q21GwSave').addEventListener('click', function () {
        var v = String(ov.querySelector('#q21GwInput').value || '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(v)) {
            try { TileAPI.toast('地址要以 http:// 或 https:// 开头', 'warn'); } catch (e) {}
            return;
        }
        TileAPI.storage.set('qwen21.gateway', v);
        close();
        _status = null;
        _job = null;
        _stopPoll();
        if (_activeContainer) { _render(_activeContainer); _refresh(); }
    });
}

// ============================================================
//  压缩 —— 在 webview 的 canvas 里做
//  host 那边拿不到原始像素，只有编码好的 PNG 字节，
//  而 UXP 的 imaging.encodeImageData 要的是原始像素（喂 PNG 字节是错的）。
//  项目里的成熟做法就是走 canvas，见 tiles/tile-chat.js。
// ============================================================
function _compressToJpeg(b64, maxSide, quality, cb) {
    var done = false;
    function finish(r) { if (!done) { done = true; cb(r); } }
    try {
        var img = new Image();
        img.onload = function () {
            try {
                var w = img.naturalWidth, h = img.naturalHeight;
                if (!w || !h) { finish(null); return; }
                var scale = Math.min(1, maxSide / Math.max(w, h));
                var cw = Math.max(1, Math.round(w * scale));
                var ch = Math.max(1, Math.round(h * scale));
                var cv = document.createElement('canvas');
                cv.width = cw; cv.height = ch;
                var cx = cv.getContext('2d');
                // JPEG 没有透明通道，必须垫白底，否则透明区域会变黑
                cx.fillStyle = '#ffffff';
                cx.fillRect(0, 0, cw, ch);
                cx.drawImage(img, 0, 0, cw, ch);
                var out = cv.toDataURL('image/jpeg', quality);
                var comma = out.indexOf(',');
                finish(comma > 0 ? out.slice(comma + 1) : null);
            } catch (e) { finish(null); }
        };
        img.onerror = function () { finish(null); };
        img.src = 'data:image/png;base64,' + b64;
    } catch (e) { finish(null); }
}

// ============================================================
//  动作
// ============================================================
function _refresh() {
    if (!_activeContainer) return;
    TileAPI.sendToHost('qwen21Status', { gateway: _gw() });
}

function _doCapture(container) {
    _busy = true; _armWatchdog('抓取');
    _lastError = '';
    _render(container);
    TileAPI.sendToHost('qwen21Capture', {});
}

function _doRun(container) {
    if (!_capture || !_capture.raw) { TileAPI.toast('重新抓一次图', 'warn'); return; }
    _busy = true; _armWatchdog('提交');
    _lastError = '';
    _placed = false;
    _render(container);

    // 先压缩，再提交。压缩是异步的，进度条由 _busy 表现为"处理中"。
    var maxSide = _quality === '2k' ? 2048 : 1024;
    _compressToJpeg(_capture.raw, maxSide, 0.92, function (jpegB64) {
        if (!jpegB64) {
            _busy = false; _clearWatchdog();
            _lastError = '图片压缩失败，重新抓一次试试';
            try { TileAPI.toast(_lastError, 'error'); } catch (e) {}
            _render(container);
            return;
        }
        var kb = Math.round(jpegB64.length * 3 / 4 / 1024);
        try { TileAPI.toast('已压缩到 ' + kb + ' KB，正在上传…', 'info'); } catch (e) {}

        TileAPI.sendToHost('qwen21Submit', {
            gateway: _gw(),
            prompt: _prompt.trim(),
            quality: _quality,
            jpeg_b64: jpegB64
        });
    });
}

function _startPoll() {
    _stopPoll();
    function tick() {
        if (!_job || !_activeContainer) return;
        if (_job.state === 'done' || _job.state === 'failed' || _job.state === 'cancelled') return;
        TileAPI.sendToHost('qwen21Poll', { gateway: _gw(), job_id: _job.id });
        _pollTimer = setTimeout(tick, 2000);
    }
    tick();
}

// 只更新进度条和文字，不碰面板其它部分。
// 存在的意义：轮询每 2 秒来一次，整块重画会把用户的输入焦点和点击都打飞。
function _updateProgressInPlace() {
    var c = _activeContainer;
    if (!c || !c.isConnected || !_job) return;

    var bar = c.querySelector('#q21ProgBar');
    var txt = c.querySelector('#q21ProgText');
    if (!bar || !txt) {
        // 进度区还没渲染出来（比如刚提交），退回整块重画一次
        _render(c);
        return;
    }

    var j = _job, pct = 0, label = '';
    if (j.state === 'queued') {
        label = j.ahead ? ('排队中，前面还有 ' + j.ahead + ' 个') : '排队中…';
        pct = 8;
    } else if (j.state === 'running') {
        if (j.steps) {
            pct = Math.max(10, Math.round(j.step / j.steps * 100));
            label = '生成中 第 ' + j.step + '/' + j.steps + ' 步';
        } else {
            pct = 20;
            label = '生成中…（大图会慢一些）';
        }
    }
    bar.style.width = pct + '%';
    txt.textContent = label;
}

// ============================================================
//  host 回信
// ============================================================
function _onHostMessage(action, data) {
    var c = _activeContainer;

    switch (action) {
        case 'qwen21StatusResult':
            _busy = false; _clearWatchdog();
            _status = data && data.ok
                ? data
                : { ok: false, need_login: !!(data && data.need_login), error: (data && data.error) || '连不上', errno: data && data.errno };
            if (c) _render(c);
            break;

        case 'qwen21CaptureResult':
            _busy = false; _clearWatchdog();
            if (data && data.ok) {
                _capture = {
                    width: data.width || 0, height: data.height || 0,
                    // raw 是抓来的原图 PNG base64；提交时用它做压缩源，不进 DOM
                    raw: data.b64 || '',
                    kb: data.kb || 0,
                    preview: data.preview || ''
                };
                try { TileAPI.toast('已抓到 ' + _capture.width + '×' + _capture.height, 'success'); } catch (e) {}
            } else {
                _lastError = (data && data.error) || '抓取失败';
                try { TileAPI.toast(_lastError, 'error'); } catch (e) {}
            }
            if (c) _render(c);
            break;

        case 'qwen21SubmitResult':
            _busy = false; _clearWatchdog();
            if (data && data.ok) {
                _job = { id: data.job_id, state: 'queued', step: 0, steps: 0, ahead: 0 };
                _startPoll();
            } else {
                _lastError = (data && data.error) || '提交失败';
                try { TileAPI.toast(_lastError, 'error'); } catch (e) {}
            }
            if (c) _render(c);
            break;

        case 'qwen21PollResult':
            if (!_job || !data) break;
            if (data.job_id && data.job_id !== _job.id) break;
            if (data.soft) break;   // 网络抖动，保持上一次状态，继续轮
            if (!data.ok) { _job.state = 'failed'; _job.error = data.error; _stopPoll(); if (c) _render(c); break; }
            _job.state = data.state || _job.state;
            _job.step = data.step || 0;
            _job.steps = data.steps || 0;
            _job.ahead = data.ahead || 0;

            if (data.state === 'done') {
                _job.elapsed = data.elapsed; _job.size = data.size;
                _stopPoll();
                // ⚠️ 跑完必须回查一次状态 —— 否则"2K 剩 N 张"停在旧数字上，
                //    用户会以为额度没扣（其实是前端没刷新）。
                _refresh();
                // 跑完要换掉按钮（"开始改图"→"再改一张"）和加"存入文档"，
                // 结构变了，这次必须整块重画。
                if (c) _render(c);
                break;
            }

            if (data.state === 'failed') {
                _job.error = data.error; _stopPoll();
                try { TileAPI.toast(data.error || '生成失败', 'error'); } catch (e) {}
                if (c) _render(c);
                break;
            }

            // ⚠️ 排队中/生成中：**绝不整块重画**。
            //    原来这里调 _render() → innerHTML 整块重建 → 每 2 秒把面板推倒一次。
            //    后果：用户在提示词框里打字，焦点被夺走、光标跳回开头；
            //    刚要点按钮，元素已经被换成新的了 —— 表现就是"点不了别的按钮、卡住"。
            //    进度只需要更新那一小块，这里就地改 DOM。
            _updateProgressInPlace();
            break;

        case 'qwen21PlaceBackResult':
            _busy = false; _clearWatchdog();
            if (data && data.ok) {
                _placed = true;
                try { TileAPI.toast('✅ 已存入文档', 'success'); } catch (e) {}
            } else {
                _lastError = (data && data.error) || '贴回失败';
                try { TileAPI.toast(_lastError, 'error'); } catch (e) {}
            }
            if (c) _render(c);
            break;

        case 'qwen21CancelResult':
            if (data && data.ok && _job) {
                _job.state = 'cancelled';
                _stopPoll();
                try { TileAPI.toast('已取消', 'info'); } catch (e) {}
                if (c) _render(c);
            }
            break;

        case 'qwen21HistoryResult':
            if (!data || !data.ok) {
                try { TileAPI.toast((data && data.error) || '取历史失败', 'error'); } catch (e) {}
                break;
            }
            _history = data.jobs || [];
            _showHistory();
            break;

        case 'qwen21Progress':
            // host 侧阶段提示（上传/下载），进度条由 _job.state 驱动，这里只做提示
            if (data && data.phase === 'upload') {
                try { TileAPI.toast('上传中…', 'info'); } catch (e) {}
            }
            break;
    }
}

// ============================================================
//  历史弹窗
// ============================================================
function _showHistory() {
    var old = document.getElementById('q21HistoryOverlay');
    if (old) old.parentNode.removeChild(old);

    var list = _history || [];
    var rows = [];
    if (!list.length) {
        rows.push('<div class="q21-h-empty">还没有记录。完成第一张之后，这里会显示你试过的提示词和结果。</div>');
    } else {
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            var badge = it.state === 'done' ? '✅' : (it.state === 'failed' ? '❌' : '⏳');
            rows.push('<div class="q21-h-row">');
            rows.push('<div class="q21-h-b">' + badge + ' <span class="q21-h-q">' + _esc(it.quality || '') + '</span></div>');
            rows.push('<div class="q21-h-p">' + _esc(it.prompt || '') + '</div>');
            rows.push('<div class="q21-h-t">' + _esc(String(it.createdAt || '').replace('T', ' ').slice(0, 16)) + '</div>');
            rows.push('</div>');
        }
    }

    var ov = document.createElement('div');
    ov.id = 'q21HistoryOverlay';
    ov.className = 'q21-overlay';
    ov.innerHTML =
        '<div class="q21-modal">' +
        '<div class="q21-modal-head"><span>📋 我的研究记录</span>' +
        '<span class="q21-modal-x" id="q21HClose">✕</span></div>' +
        '<div class="q21-modal-body">' +
        '<p class="q21-p-lead">这是你在这个研究项目里试过的提示词。' +
        '记录保留 7 天，图也一样 —— 目的是回过头看哪种写法更管用。</p>' +
        rows.join('') +
        '</div>' +
        '<div class="q21-modal-foot"><div class="q21-btn q21-btn-primary" id="q21HOk">知道了</div></div>' +
        '</div>';
    document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.querySelector('#q21HClose').addEventListener('click', close);
    ov.querySelector('#q21HOk').addEventListener('click', close);
}

// ============================================================
//  注册磁贴
// ============================================================
TileAPI.registerTile({
    id: 'qwen21',
    group: 'main',
    icon: '🧪',
    label: '云Qwen研究',
    desc: '提示词研究 · 云端改图',
    live: false,
    // 默认 1x1 小格子；用户拖大了正面还能多显示一行状态
    defaultSize: { w: 1, h: 1 },
    minSize: { w: 1, h: 1 },
    maxSize: { w: 4, h: 999 },

    renderFront: function (container, w) {
        var on = _status && _status.ok;
        if (w >= 2) {
            container.innerHTML =
                '<div class="tile-icon">🧪</div>' +
                '<div class="tile-label">云Qwen研究</div>' +
                '<div class="tile-desc">' + (on ? '服务正常' : '提示词研究') + '</div>';
        } else {
            container.innerHTML = '<div class="tile-icon">🧪</div><div class="tile-label">云Qwen</div>';
        }
    },

    onExpand: function (container) {
        _activeContainer = container;

        // 首次打开：先弹协议
        if (!_agreed()) {
            _render(container);
            _showPolicy(container, function () { _render(container); _refresh(); });
            return function () { _activeContainer = null; _stopPoll(); };
        }

        _render(container);
        _refresh();

        // ⚠️ 接着上次的进度往下走。
        //    收起磁贴时会 _stopPoll()，但 _job 还留着。
        //    原来这里不恢复轮询 —— 生成中收起来再打开，进度就永远冻住，
        //    看起来就是"卡死"。必须按状态补一次。
        if (_job && (_job.state === 'queued' || _job.state === 'running')) {
            _startPoll();
        } else if (_job && _job.state === 'done' && !_placed) {
            // 跑完了但还没存入文档 —— 不需要轮询，界面已经是对的
        }

        return function () {
            _activeContainer = null;
            _stopPoll();
        };
    },

    onMessage: function (action, data) {
        _onHostMessage(action, data);
    },

    onStorageLoaded: function (storage) {
        // 默认全屏展开（跟 canvas 磁贴同款做法，见 canvas-pkg/tile-canvas.js:2079）。
        // 只用 if (!modes['qwen21']) 这个条件 —— 用户自己改成"就地展开"之后
        // 不要再覆盖回去，尊重用户的选择。
        try {
            var modes = storage.get('__tile_expand_modes') || {};
            if (!modes['qwen21']) {
                modes['qwen21'] = 'full';
                storage.set('__tile_expand_modes', modes);
            }
        } catch (_) {}
    }
});

})();
