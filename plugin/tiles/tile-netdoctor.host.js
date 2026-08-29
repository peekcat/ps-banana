// ============================================================
//  tile-netdoctor.host.js — 网络医生 (宿主层主体) 2026-07-11
//
//  报错时的网络故障定位: 分层体检 + 双栈对照, 输出大白话结论。
//  为什么在宿主层: 出图请求就是宿主(PS网络栈)发的, 同路径诊断结果才可信;
//  且宿主 fetch 免 CORS。webview 只当"第二网络栈"对照组(面板端探,结果送进来汇总)。
//
//  动作: netDiagnose { webviewProbe: {ok:bool,detail} | null }
//  探测层级:
//    L1 公网基准(baidu/qq)          → 整机断网?
//    L2 DNS对照(DoH权威 vs 本机解析) → DNS劫持/污染?
//    L3 目标服务(AJI三线/夏三七服务器) → 哪家服务挂?
//    L4 错误指纹归类                → 超时/重置/证书/握手
//  输出: 逐层结果 + 大白话结论, 发回面板(进日志+可复制)
// ============================================================

var HostAPI = require('../host/host-api.js');
var serverConfig = require('../core/server-config.js');

var TIMEOUT_MS = 6000;

// 带超时的探测: 返回 { ok, ms, status, err }
async function _probe(url, opts) {
    var ctrl = new AbortController();
    var t0 = Date.now();
    var timer = setTimeout(function() { try { ctrl.abort(); } catch (e) {} }, TIMEOUT_MS);
    try {
        var r = await fetch(url, Object.assign({ method: 'GET', cache: 'no-cache', signal: ctrl.signal }, opts || {}));
        clearTimeout(timer);
        return { ok: true, ms: Date.now() - t0, status: r.status };
    } catch (e) {
        clearTimeout(timer);
        return { ok: false, ms: Date.now() - t0, err: String((e && e.message) || e) };
    }
}

// 错误指纹归类 → 人话
function _classifyErr(err) {
    var m = String(err || '').toLowerCase();
    if (!m) return '';
    if (m.indexOf('abort') !== -1) return '超时(6秒无响应)';
    if (m.indexOf('cert') !== -1 || m.indexOf('ssl') !== -1 || m.indexOf('tls') !== -1) return '证书/TLS异常(疑似被代理或防火墙拦截解密)';
    if (m.indexOf('reset') !== -1) return '连接被重置(疑似防火墙/运营商干预)';
    if (m.indexOf('refused') !== -1) return '连接被拒绝(目标端口未开或被拦)';
    if (m.indexOf('enotfound') !== -1 || m.indexOf('resolve') !== -1 || m.indexOf('name') !== -1) return '域名解析失败(DNS问题)';
    return '网络请求失败(' + m.slice(0, 60) + ')';
}

// DoH 权威解析(阿里公共DNS的HTTP接口, 本身走IP直连不依赖本机DNS)
async function _dohResolve(domain) {
    try {
        var r = await _probe('https://223.5.5.5/resolve?name=' + encodeURIComponent(domain) + '&type=A', {});
        if (!r.ok) return { ok: false, err: r.err };
        // _probe 不读 body; 这里重新请求一次读内容(上一跳已验证通)
        var ctrl = new AbortController();
        var timer = setTimeout(function() { try { ctrl.abort(); } catch (e) {} }, TIMEOUT_MS);
        var j;
        try {
            var resp = await fetch('https://223.5.5.5/resolve?name=' + encodeURIComponent(domain) + '&type=A', { signal: ctrl.signal });
            j = await resp.json();
        } finally {
            clearTimeout(timer);
        }
        var ips = (j && j.Answer ? j.Answer : []).filter(function(a) { return a.type === 1; }).map(function(a) { return a.data; });
        return { ok: true, ips: ips };
    } catch (e) {
        return { ok: false, err: String((e && e.message) || e) };
    }
}

HostAPI.registerAction('netDiagnose', async function(data, ctx) {
    var L = [];   // 报告行
    var t0 = Date.now();
    ctx.logToPanel('[网络医生] 开始体检(约10秒)…', 'info');

    // ── L1: 公网基准(两个大站, 任一通即算通) ──
    var base1 = await _probe('https://www.baidu.com/favicon.ico');
    var base2 = base1.ok ? null : await _probe('https://www.qq.com/favicon.ico');
    var internetOk = base1.ok || (base2 && base2.ok);
    L.push('① 公网基准: ' + (internetOk ? ('✓ 通 (' + (base1.ok ? base1.ms : base2.ms) + 'ms)') : ('✗ 不通 — ' + _classifyErr(base1.err))));

    // ── L2: DNS 对照(用 DoH 权威查 AJI 主域, 与本机解析行为对照) ──
    var dohRes = internetOk ? await _dohResolve('ai.ajiai.top') : { ok: false, err: '跳过(公网不通)' };
    L.push('② 权威DNS(阿里DoH): ' + (dohRes.ok ? ('✓ ai.ajiai.top → ' + (dohRes.ips.join(', ') || '无A记录')) : ('✗ ' + (dohRes.err || '失败'))));

    // ── L3: 目标服务逐个探 ──
    var targets = [
        { name: 'AJI 主线', url: 'https://ai.ajiai.top/favicon.ico' },
        { name: 'AJI 备线1', url: 'https://cn.ajiai.top/favicon.ico' },
        { name: 'AJI 备线2', url: 'https://ai.ajiapi.top/favicon.ico' },
        { name: '夏三七正式服务器', url: serverConfig.url('/api/presets/manifest') },
        { name: 'GRS', url: 'https://grsai.dakka.com.cn/favicon.ico' },
        { name: '墨墨(momo)', url: 'https://api.momoapi.icu/favicon.ico' }
    ];
    var svcResults = [];
    for (var i = 0; i < targets.length; i++) {
        var r = await _probe(targets[i].url);
        svcResults.push({ name: targets[i].name, ok: r.ok, ms: r.ms, err: r.err });
        L.push('③ ' + targets[i].name + ': ' + (r.ok ? ('✓ 通 (' + r.ms + 'ms)') : ('✗ ' + _classifyErr(r.err))));
    }
    var anyAji = svcResults[0].ok || svcResults[1].ok || svcResults[2].ok;
    var allSvcDown = svcResults.every(function(s) { return !s.ok; });

    // ── L4: 双栈对照(面板 webview 的探测结果由调用方带进来) ──
    var wv = data && data.webviewProbe;
    if (wv) {
        L.push('④ 浏览器栈对照: ' + (wv.ok ? '✓ 通' : '✗ 不通') + (wv.detail ? ' (' + wv.detail + ')' : ''));
    }

    // ── 结论(按优先级给一条人话) ──
    var verdict;
    if (!internetOk && wv && wv.ok) {
        verdict = 'PS 的网络被单独拦了: 浏览器能上网, 但 PS 连不出去 — 高度怀疑代理软件/防火墙只劫持了 PS。试试: 关掉代理/加速器, 或把 Photoshop 加进防火墙白名单。';
    } else if (!internetOk) {
        verdict = '整机断网: 公网都连不上。检查网线/WiFi/路由器, 和插件无关。';
    } else if (allSvcDown) {
        verdict = '你的网络正常, 但所有出图服务都连不上 — 疑似区域性网络管制或服务大面积故障, 等一等再试, 或打开「AI状态」磁贴看全网情况。';
    } else if (!anyAji && svcResults[3].ok) {
        var altUp = [];
        if (svcResults[4] && svcResults[4].ok) altUp.push('GRS');
        if (svcResults[5] && svcResults[5].ok) altUp.push('墨墨');
        verdict = 'AJI 三条线路全部不通(夏三七服务器是通的) — AJI 在维护或被你的网络屏蔽。'
            + (altUp.length ? '可临时切到 ' + altUp.join(' / ') + ' 渠道出图。' : '其他渠道也不通, 建议等恢复。');
    } else if (!dohRes.ok && internetOk) {
        verdict = '公网通但权威 DNS 查询失败 — 你的网络对 DNS 有限制(部分路由器/代理会封外部 DNS), 域名解析可能被劫持。插件大部分功能仍可用, 若出图报"域名解析失败"就是它。';
    } else if (anyAji) {
        var okLine = svcResults.filter(function(s) { return s.ok; }).length;
        verdict = '网络健康(' + okLine + '/' + svcResults.length + ' 个服务可达)。若仍出图失败, 问题不在网络 — 看任务卡上的具体报错(余额/审核/超时), 或把本报告+报错发给客服。';
    } else {
        verdict = '网络部分异常, 详见上面逐项结果。把本报告复制发给客服可加速定位。';
    }
    L.push('');
    L.push('🩺 结论: ' + verdict);
    L.push('(体检用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's · ' + new Date().toLocaleString() + ')');

    var report = L.join('\n');
    ctx.logToPanel('[网络医生]\n' + report, allSvcDown || !internetOk ? 'warn' : 'info');
    ctx.sendToPanel('netDiagnoseResult', { report: report, verdict: verdict });
}, { tileId: 'netdoctor' });
