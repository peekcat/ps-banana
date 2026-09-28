// ============================================================
//  tile-info.js — 信息磁贴
//  两大板块:
//    1. 实时运行信息 (PS/文档/连接/设置)
//    2. 关于 (版本/作者/联系方式/免责)
//  4 种布局响应式
// ============================================================
(function() {
'use strict';

var VERSION = '6.6.4';

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ========== 数据源:从各磁贴 state/storage 汇聚当前信息 ==========

function _getDocInfo() {
  // 由 onExpand 时发 getDocInfo 请求,结果写回 state.info.doc
  return TileAPI.state.get('info.doc') || {};
}

function _getComfyStatus() {
  // bug: 键名统一为 comfyui.*(tile-comfyui 写的是 comfyui.connected / comfyui.url);
  //   原来读 comfy.* 永远拿不到 → ComfyUI 状态一直显示"未启用"
  var connected = TileAPI.state.get('comfyui.connected');
  var url = TileAPI.storage.get('comfyui.url') || TileAPI.state.get('comfyui.url') || '';
  if (connected) return { text: '已连接', url: url, cls: 'ok' };
  if (url) return { text: '未连接', url: url, cls: 'err' };
  return { text: '未启用', url: '', cls: '' };
}

function _getForgeStatus() {
  var src = TileAPI.storage.get('forge.activeSource') || 'local';
  if (src === 'cloud') {
    if (window._cloudIsReady && window._cloudIsReady()) {
      var pts = (window._cloudGetPoints && window._cloudGetPoints()) || 0;
      return { text: '云 · ' + pts + ' 积分', cls: 'ok' };
    }
    if (window._cloudIsLoggedIn && window._cloudIsLoggedIn()) {
      return { text: '云 · 查询中', cls: 'warn' };
    }
    return { text: '云 · 未登录', cls: 'err' };
  }
  var connected = TileAPI.state.get('forge.connected');
  var url = TileAPI.storage.get('forge.url') || '';
  if (connected) return { text: '本地 · ' + url, cls: 'ok' };
  if (url) return { text: '本地 · 未连接', cls: 'err' };
  return { text: '本地 · 未设置', cls: '' };
}

function _getApiStatus() {
  // 走统一入口拿"当前真正生效"的连接(params.provider 优先; GRS 托管时用云端子 key 判断),
  // 否则夏算力托管用户会被误显示成红色"未填写"(修 2026-07-04)
  var conn = (typeof window._settingsGetActiveConnection === 'function')
    ? window._settingsGetActiveConnection() : null;
  var provider = (conn && conn.provider)
    || TileAPI.state.get('params.provider')
    || TileAPI.storage.get('connection.provider') || 'aji';
  var key = conn ? (conn.key || '') : (TileAPI.storage.get('connection.' + provider + '.key') || '');
  var url = conn ? (conn.url || '') : (TileAPI.storage.get('connection.' + provider + '.url') || '');
  // 显示名接槽位自定义名; 没改名时 grs 按模式显示 GRS/夏三七, 其余用引擎名大写
  var defName = (provider === 'grs' && TileAPI.computeBrand) ? TileAPI.computeBrand() : provider.toUpperCase();
  var dispName = TileAPI.slotLabel ? TileAPI.slotLabel(provider, defName) : defName;
  var keyText = key ? '已填写' : '未填写';
  var keyCls = key ? 'ok' : 'err';
  if (provider === 'grs' && TileAPI.compute && TileAPI.compute.isUserByokActive && !TileAPI.compute.isUserByokActive()) {
    // 托管(夏算力)模式: 本地 key 本来就该是空的, 按托管状态显示
    if (key) { keyText = '托管中'; keyCls = 'ok'; }
    else if (conn && conn._grsKeyPending) { keyText = '托管准备中'; keyCls = ''; }
    else { keyText = '未登录'; keyCls = 'err'; }
  }
  return {
    provider: dispName,
    key: keyText,
    keyCls: keyCls,
    url: url || '未填写',
    urlCls: url ? 'ok' : 'err'
  };
}

function _getBalances() {
  var bal = TileAPI.state.get('balance.current');
  var credits = TileAPI.state.get('grs.credits');
  var balText = (bal === null || bal === undefined || bal < 0) ? '未查询' : '$' + (+bal).toFixed(4);
  var credText = (credits === null || credits === undefined || credits < 0) ? '未查询' : credits.toLocaleString() + ' pts';
  return { aji: balText, grs: credText };
}

function _getOutputSettings() {
  var layer = TileAPI.storage.get('output.layerType') || 'smartObject';
  var layerText = (layer === 'rasterized') ? '栅格化图层' : '智能对象';
  var autoGroup = TileAPI.storage.get('output.autoGroup');
  var autoReturn = TileAPI.storage.get('output.autoReturn');
  return {
    layer: layerText,
    autoGroup: (autoGroup !== false) ? '开启' : '关闭',
    autoReturn: (autoReturn !== false) ? '开启' : '关闭'
  };
}

function _getGenParams() {
  var model = TileAPI.state.get('params.model') || TileAPI.storage.get('params.model') || 'AJbanana3';
  var size = TileAPI.state.get('params.size') || TileAPI.storage.get('params.size') || '2K';
  var antiMode = TileAPI.state.get('params.antiMode') || 0;
  var antiText = antiMode === 2 ? '抗截断+' : antiMode === 1 ? '抗截断' : '关闭';
  var antiCls = antiMode > 0 ? 'warn' : '';
  var refs = TileAPI.state.get('refimages.list') || [];
  var MAX = 4;
  return {
    model: model,
    size: size,
    anti: antiText, antiCls: antiCls,
    refs: refs.length + '/' + MAX
  };
}

// ========== 诊断数据 ==========

// 把毫秒时间戳转成"N 秒/分/小时前"
function _timeAgo(ts) {
  if (!ts) return '从未';
  var d = Date.now() - ts;
  if (d < 1000) return '刚刚';
  if (d < 60000) return Math.floor(d / 1000) + ' 秒前';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  return Math.floor(d / 86400000) + ' 天前';
}

// 把毫秒 duration 转成"3.2s / 2m 15s"
function _fmtDur(ms) {
  if (!ms || ms < 0) return '--';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  var m = Math.floor(ms / 60000);
  var s = Math.floor((ms % 60000) / 1000);
  return m + 'm ' + s + 's';
}

function _getUptime() {
  var start = (TileAPI.getStartTime && TileAPI.getStartTime()) || Date.now();
  return _fmtDur(Date.now() - start);
}

function _getLastError() {
  return TileAPI.state.get('info.lastError');
}

function _getTaskMetrics() {
  return TileAPI.state.get('tasks.metrics') || [];
}

function _getSuccessRate() {
  var m = _getTaskMetrics();
  if (!m.length) return { total: 0, success: 0, fail: 0, rate: '--' };
  var ok = 0;
  for (var i = 0; i < m.length; i++) if (m[i].ok) ok++;
  return { total: m.length, success: ok, fail: m.length - ok, rate: Math.round(ok / m.length * 100) + '%' };
}

function _getAvgDuration() {
  var m = _getTaskMetrics();
  if (!m.length) return '--';
  var valid = m.filter(function(x) { return x.ok && x.dur > 0; });
  if (!valid.length) return '--';
  var sum = 0;
  for (var i = 0; i < valid.length; i++) sum += valid[i].dur;
  return _fmtDur(Math.round(sum / valid.length));
}

function _getLastSuccessTime() {
  return TileAPI.state.get('tasks.lastSuccessTime') || 0;
}

function _getActiveTasks() {
  var running = TileAPI.state.get('tasks.running') || {};
  return Object.keys(running).length;
}

function _getPublicIp() {
  return TileAPI.state.get('info.publicIp') || null;  // { masked, time }
}

// 云 Forge 探测结果: { success, modelCount, error, time }
function _getCloudForgeProbe() {
  return TileAPI.state.get('info.cloudForgeProbe') || null;
}

function _getPsCompat() {
  var doc = _getDocInfo();
  var ver = doc.psVersion || '';
  // UXP 插件通常需要 PS 26+(2024 版及以上),再宽松点 22+
  var m = String(ver).match(/(\d+)/);
  var major = m ? parseInt(m[1]) : 0;
  if (!major) return { text: ver || '未知', cls: '' };
  if (major >= 26) return { text: ver + ' ✓', cls: 'ok' };
  if (major >= 22) return { text: ver + ' (兼容)', cls: '' };
  return { text: ver + ' ⚠ 版本可能过低', cls: 'warn' };
}

function _getUserId() {
  var user = TileAPI.storage.get('cloud.user') || {};
  return user.email || user.nickname || '未登录云服务';
}

// ========== 磁贴正面 ==========
function renderFront(container, w, h) {
  if (w >= 2) {
    container.innerHTML =
      '<div class="tile-icon">ℹ️</div>' +
      '<div class="tile-label">信息</div>' +
      '<div class="tile-desc">v' + VERSION + '</div>';
  } else {
    container.innerHTML =
      '<div class="tile-icon">ℹ️</div>' +
      '<div class="tile-label">信息</div>';
  }
}

TileAPI.registerTile({
  id: 'info',
  group: 'main',
  icon: 'ℹ️',
  label: '信息',
  desc: '版本·状态·联系',
  live: true,
  defaultSize: { w: 2, h: 2 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderFront: renderFront,

  renderBack: function(container) {
    container.textContent = '轮椅 v' + VERSION;
  },

  onExpand: function(container, sizeHint) {
    // 信息磁贴展开后永远显示完整内容, 不响应 panel 整体宽度
    // (设计意图: 卡片状态 renderFront 才响应宽度, 展开是为了"看完整诊断")
    var layout = 'wide';
    _renderPanel(container, layout);

    // 启动时请求一次 PS/文档信息
    TileAPI.sendToHost('getDocInfo', {});

    // 首次展开时拉一次公网 IP(之后缓存 10 分钟再拉)
    var ipInfo = TileAPI.state.get('info.publicIp');
    if (!ipInfo || (Date.now() - ipInfo.time) > 600000) {
      TileAPI.sendToHost('fetchPublicIp', {});
    }

    // 首次展开时探测云 Forge(只在已登录且有 URL 时)
    // 10 分钟缓存,避免频繁探测影响云服务
    var probe = TileAPI.state.get('info.cloudForgeProbe');
    if (!probe || (Date.now() - probe.time) > 600000) {
      var enc = (window._cloudGetForgeEncrypted && window._cloudGetForgeEncrypted()) || '';
      if (enc) {
        TileAPI.state.set('info.cloudForgeProbe', { probing: true, time: Date.now() });
        TileAPI.sendToHost('cloudForgeProbe', { encrypted: enc });
      }
    }

    // 订阅各种状态变化,面板局部刷新
    var refresh = function() { _refreshDynamic(container, layout); };
    TileAPI.on('balance:updated', refresh);
    TileAPI.on('grs:creditsUpdated', refresh);
    TileAPI.on('cloud:pointsReady', refresh);
    TileAPI.on('forge:sourceChanged', refresh);
    TileAPI.on('refimages:updated', refresh);
    TileAPI.on('params:providerChanged', refresh);
    TileAPI.on('info:errorLogged', refresh);
    TileAPI.on('tasks:updated', refresh);
    TileAPI.on('generate:complete', refresh);

    // 每 5s 自动刷一次文档信息 + 运行时长
    var docTimer = setInterval(function() {
      TileAPI.sendToHost('getDocInfo', {});
      _refreshDynamic(container, layout);  // 刷新运行时长/距上次成功时间
    }, 5000);

    return function() {
      TileAPI.off('balance:updated', refresh);
      TileAPI.off('grs:creditsUpdated', refresh);
      TileAPI.off('cloud:pointsReady', refresh);
      TileAPI.off('forge:sourceChanged', refresh);
      TileAPI.off('refimages:updated', refresh);
      TileAPI.off('params:providerChanged', refresh);
      TileAPI.off('info:errorLogged', refresh);
      TileAPI.off('tasks:updated', refresh);
      TileAPI.off('generate:complete', refresh);
      if (docTimer) clearInterval(docTimer);
    };
  },

  onResize: renderFront,

  onMessage: function(action, data) {
    if (action === 'docInfo' && data) {
      TileAPI.state.set('info.doc', data);
    }
    if (action === 'publicIpResult' && data) {
      if (data.success && data.ip) {
        TileAPI.state.set('info.publicIp', { masked: data.ip, time: Date.now() });
      } else {
        TileAPI.state.set('info.publicIp', { masked: '获取失败', time: Date.now() });
      }
    }
    if (action === 'cloudForgeProbeResult' && data) {
      if (data.success) {
        TileAPI.state.set('info.cloudForgeProbe', {
          success: true,
          modelCount: data.modelCount || 0,
          time: Date.now()
        });
      } else {
        TileAPI.state.set('info.cloudForgeProbe', {
          success: false,
          error: data.error || '连接失败',
          time: Date.now()
        });
      }
    }
  },
});

// ========== 布局分派 ==========
function _renderPanel(container, layout) {
  // 窄/高布局一律用 square 渲染(单列竖排,内容全),避免精简版藏掉状态灯
  if (layout === 'narrow' || layout === 'tall') layout = 'square';
  if (layout === 'narrow' || layout === 'tall') _renderNarrow(container);
  else if (layout === 'wideshort') _renderWideShort(container);
  else if (layout === 'square') _renderSquare(container);
  else _renderWide(container);
  _bindActions(container);
}

function _refreshDynamic(container, layout) {
  // 按区域局部刷新,不重建监听
  var dyn = container.querySelector('[data-info-dyn]');
  if (dyn) {
    dyn.outerHTML = _renderDynamicSection(layout);
  } else {
    // 没有 dyn 区(narrow/tall 只有关于),不需刷新
  }
}

// ========== 一行工具 ==========
function _row(key, val, cls) {
  return '<div class="info-row"><span class="info-key">' + _esc(key) + '</span>' +
    '<span class="info-val' + (cls ? ' info-val-' + cls : '') + '">' + _esc(val) + '</span></div>';
}

function _sep() {
  return '<div class="info-sep"></div>';
}

// ========== 动态信息段(实时) ==========
function _renderDynamicSection(layout) {
  var doc = _getDocInfo();
  var api = _getApiStatus();
  var bal = _getBalances();
  var forge = _getForgeStatus();
  var comfy = _getComfyStatus();
  var out = _getOutputSettings();
  var gen = _getGenParams();

  var isWideShort = (layout === 'wideshort');
  var isSquare = (layout === 'square');

  if (isWideShort) {
    // 2x1 横排: 关键状态灯 + 错误提示
    var errChipHtml = '';
    var le2 = _getLastError();
    if (le2 && (Date.now() - le2.time) < 600000) {  // 10 分钟内的错误才高亮
      errChipHtml = '<div class="info-chip info-chip-err" title="' + _esc(le2.msg || '') + '">⚠ ' + _esc((le2.msg || '').slice(0, 20)) + '</div>';
    }
    var rate3 = _getSuccessRate();
    var rateCls = rate3.total === 0 ? '' : (parseInt(rate3.rate) >= 80 ? 'ok' : 'warn');
    return '<div class="info-dyn info-dyn-horiz" data-info-dyn>' +
      '<div class="info-chip info-chip-' + api.keyCls + '" title="API Key">' + api.provider + ' ' + api.key + '</div>' +
      '<div class="info-chip info-chip-' + forge.cls + '" title="Forge">Forge · ' + forge.text + '</div>' +
      '<div class="info-chip info-chip-' + rateCls + '" title="成功率">' + rate3.rate + ' · ' + _getAvgDuration() + '</div>' +
      '<div class="info-chip" title="余额">' + bal.aji + ' / ' + bal.grs + '</div>' +
      errChipHtml +
    '</div>';
  }

  if (isSquare) {
    // 紧凑版:只关键几条
    var rate = _getSuccessRate();
    var le = _getLastError();
    var probeSq = _getCloudForgeProbe();
    var probeText, probeCls;
    if (!probeSq) { probeText = '未探测'; probeCls = ''; }
    else if (probeSq.probing) { probeText = '探测中'; probeCls = ''; }
    else if (probeSq.success) { probeText = probeSq.modelCount + ' 模型'; probeCls = 'ok'; }
    else { probeText = '未连接'; probeCls = 'err'; }

    return '<div class="info-dyn" data-info-dyn>' +
      _row('Photoshop', doc.psVersion || '--') +
      _row('当前文档', doc.docName || '无') +
      _sep() +
      _row(api.provider + ' Key', api.key, api.keyCls) +
      _row('Forge', forge.text, forge.cls) +
      _row('云 Forge', probeText, probeCls) +
      _sep() +
      _row('成功率', rate.rate + (rate.total ? ' (' + rate.success + '/' + rate.total + ')' : ''), rate.rate === '--' ? '' : (parseInt(rate.rate) >= 80 ? 'ok' : 'warn')) +
      _row('平均耗时', _getAvgDuration()) +
      (le ? _row('上次错误', (le.msg || '').slice(0, 40), 'err') : '') +
    '</div>';
  }

  // wide 完整版
  var rate2 = _getSuccessRate();
  var lastErr = _getLastError();
  var publicIp = _getPublicIp();
  var psCompat = _getPsCompat();
  var active = _getActiveTasks();

  var errHistory = TileAPI.state.get('info.errorHistory') || [];
  var errHistoryHtml = '';
  if (errHistory.length > 1) {
    errHistoryHtml = '<div class="info-err-history">' +
      '<div class="info-err-history-title">最近错误记录 (' + errHistory.length + ')</div>';
    for (var ei = 0; ei < errHistory.length && ei < 5; ei++) {
      var e = errHistory[ei];
      errHistoryHtml += '<div class="info-err-item">' +
        '<span class="info-err-time">' + _timeAgo(e.time) + '</span>' +
        '<span class="info-err-msg" title="' + _esc(e.msg) + '">' + _esc((e.msg || '').slice(0, 80)) + '</span>' +
      '</div>';
    }
    errHistoryHtml += '</div>';
  }

  return '<div class="info-dyn" data-info-dyn>' +
    '<div class="w10-section-title">诊断 (排障先看这里)</div>' +
    _row('运行时长', _getUptime()) +
    _row('Photoshop', psCompat.text, psCompat.cls) +
    _row('公网 IP', publicIp ? publicIp.masked : '查询中...') +
    _row('活跃任务', active > 0 ? (active + ' 个') : '无', active > 3 ? 'warn' : '') +
    _row('成功率(近20)', rate2.rate + (rate2.total ? ' (' + rate2.success + '/' + rate2.total + ')' : ''), rate2.total === 0 ? '' : (parseInt(rate2.rate) >= 80 ? 'ok' : parseInt(rate2.rate) >= 50 ? 'warn' : 'err')) +
    _row('平均耗时', _getAvgDuration()) +
    _row('距上次成功', _timeAgo(_getLastSuccessTime())) +
    (lastErr ? _row('上次错误', (lastErr.msg || '').slice(0, 60) + ' (' + _timeAgo(lastErr.time) + ')', 'err') : _row('上次错误', '无')) +
    errHistoryHtml +

    '<div class="w10-section-title">运行环境</div>' +
    _row('当前文档', doc.docName || '无打开文档') +
    _row('位深', doc.bitDepth || '--') +
    (doc.docWidth ? _row('画布尺寸', doc.docWidth + ' × ' + doc.docHeight) : '') +
    (doc.colorMode ? _row('色彩模式', doc.colorMode) : '') +

    '<div class="w10-section-title">连接状态</div>' +
    _row(api.provider + ' API Key', api.key, api.keyCls) +
    _row(api.provider + ' URL', api.url, api.urlCls) +
    _row('Forge', forge.text, forge.cls) +
    _row('ComfyUI', comfy.text, comfy.cls) +
    _row('云服务账号', _getUserId()) +
    (function() {
      var probe = _getCloudForgeProbe();
      if (!probe) return _row('云 Forge', '未探测');
      if (probe.probing) return _row('云 Forge', '探测中...');
      if (probe.success) return _row('云 Forge', '已连接 · ' + probe.modelCount + ' 个模型', 'ok');
      return _row('云 Forge', (probe.error || '未连接').slice(0, 50), 'err');
    })() +

    '<div class="w10-section-title">余额/积分</div>' +
    _row((TileAPI.slotLabel ? TileAPI.slotLabel('aji', 'AJI') : 'AJI') + ' 余额', bal.aji) +
    _row((TileAPI.slotLabel ? TileAPI.slotLabel('grs', TileAPI.computeBrand()) : TileAPI.computeBrand()) + ' 积分', bal.grs) +

    '<div class="w10-section-title">生成设置</div>' +
    _row('当前模型', gen.model) +
    _row('分辨率', gen.size) +
    _row('抗截断', gen.anti, gen.antiCls) +
    _row('参考图', gen.refs) +

    '<div class="w10-section-title">输出设置</div>' +
    _row('图层类型', out.layer) +
    _row('自动编组', out.autoGroup) +
    _row('自动返回 PS', out.autoReturn) +
  '</div>';
}

// ========== 关于段 ==========
function _renderAboutSection(compact) {
  if (compact) {
    // 紧凑版(square 用)
    return '<div class="info-about-compact">' +
      '<div class="info-logo">♿</div>' +
      '<div class="info-about-right">' +
        '<div class="info-title">轮椅 v' + VERSION + '</div>' +
        '<div class="info-sub">夏三七 · GPL v3</div>' +
      '</div>' +
    '</div>';
  }

  // 完整版(wide)
  return '' +
    '<div class="w10-section-title">关于</div>' +
    '<div class="info-about-card">' +
      '<div class="info-logo">♿</div>' +
      '<div class="info-about-main">' +
        '<div class="info-title">夏三七的修图轮椅</div>' +
        '<div class="info-sub">v' + VERSION + ' · Photoshop UXP 插件</div>' +
      '</div>' +
    '</div>' +
    '<div class="info-about-grid">' +
      '<div class="info-meta-item"><span class="info-meta-k">👤 作者</span><span class="info-meta-v">夏三七</span></div>' +
      '<div class="info-meta-item"><span class="info-meta-k">📜 协议</span><span class="info-meta-v">GPL v3</span></div>' +
      '<div class="info-meta-item"><span class="info-meta-k">💬 微信</span><span class="info-meta-v">sanlegeqi</span></div>' +
      '<div class="info-meta-item"><span class="info-meta-k">🐧 QQ</span><span class="info-meta-v">2307173033</span></div>' +
      '<div class="info-meta-item"><span class="info-meta-k">🔑 买Key</span><span class="info-meta-v">QQ 770466704</span></div>' +
      '<div class="info-meta-item"><span class="info-meta-k">💲 价格</span><span class="info-meta-v info-meta-free">免费开源</span></div>' +
    '</div>' +
    '<div class="info-actions">' +
      '<button class="w10-btn" data-copy="sanlegeqi">复制微信</button>' +
      '<button class="w10-btn" data-copy="2307173033">复制 QQ</button>' +
      '<button class="w10-btn" id="infoOpenLicense">查看协议</button>' +
    '</div>' +
    '<div class="info-disclaimer">' +
      '⚠️ 免责：本插件仅供合法图像后期处理使用，不得用于生成违反法律法规的内容。用户产生的所有内容由用户本人负责，作者不承担任何法律责任。' +
    '</div>';
}

// ========== Narrow / Tall ==========
function _renderNarrow(container) {
  container.innerHTML =
    '<div class="w10-panel info-panel info-panel-narrow">' +
      '<div class="info-narrow">' +
        '<div class="info-logo">♿</div>' +
        '<div class="info-title">轮椅 v' + VERSION + '</div>' +
        '<div class="info-sub">夏三七</div>' +
        '<div class="info-sub info-sub-sm">GPL v3</div>' +
        '<button class="w10-btn info-narrow-btn" data-copy="sanlegeqi">复制微信</button>' +
        '<button class="w10-btn info-narrow-btn" id="infoOpenLicense">协议</button>' +
      '</div>' +
    '</div>';
}

// ========== Wideshort (N×1) — 横排状态灯 ==========
function _renderWideShort(container) {
  container.innerHTML =
    '<div class="w10-panel info-panel info-panel-wideshort">' +
      _renderDynamicSection('wideshort') +
    '</div>';
}

// ========== Square — 关于 + 关键状态 ==========
function _renderSquare(container) {
  container.innerHTML =
    '<div class="w10-panel info-panel info-panel-square">' +
      _renderAboutSection(true) +
      _sep() +
      _renderDynamicSection('square') +
    '</div>';
}

// ========== Wide — 完整版 ==========
function _renderWide(container) {
  container.innerHTML =
    '<div class="w10-panel info-panel info-panel-wide">' +
      _renderDynamicSection('wide') +
      _renderAboutSection(false) +
    '</div>';
}

// ========== 事件绑定 ==========
function _bindActions(container) {
  container.querySelectorAll('[data-copy]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var text = btn.getAttribute('data-copy');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
          TileAPI.toast('已复制: ' + text, 'success');
        }).catch(function() { TileAPI.toast('复制失败', 'error'); });
      } else {
        var ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); TileAPI.toast('已复制', 'success'); }
        catch(e) { TileAPI.toast('复制失败', 'error'); }
        document.body.removeChild(ta);
      }
    });
  });

  var licBtn = container.querySelector('#infoOpenLicense');
  if (licBtn) licBtn.addEventListener('click', function() {
    TileAPI.sendToHost('openUrl', { url: 'https://www.gnu.org/licenses/gpl-3.0.html' });
  });
}

// ========== 对外: 构建信息面板纯文本快照 (供 tile-support 等调用) ==========
window._buildInfoSnapshot = function() {
  var lines = [];
  var pad = function(k, v) {
    var s = k + ':';
    while (s.length < 14) s += ' ';
    return s + v;
  };

  lines.push('=== 轮椅 v' + VERSION + ' 信息面板 ===');
  lines.push('时间: ' + new Date().toLocaleString('zh-CN', { hour12: false }));
  lines.push('运行时长: ' + _getUptime());
  lines.push('');

  // PS / 文档
  var doc = _getDocInfo();
  var psCompat = _getPsCompat();
  lines.push('--- Photoshop ---');
  lines.push(pad('PS版本', psCompat.text || (doc.psVersion || '未知')));
  lines.push(pad('当前文档', doc.docName || '无'));
  if (doc.docName) {
    lines.push(pad('尺寸', (doc.width || '?') + ' × ' + (doc.height || '?') + ' @ ' + (doc.resolution || '?') + 'dpi'));
    lines.push(pad('色彩模式', doc.mode || '?'));
  }
  lines.push('');

  // 连接状态
  lines.push('--- 连接 / 服务 ---');
  var comfy = _getComfyStatus();
  var forge = _getForgeStatus();
  var api = _getApiStatus();
  lines.push(pad('ComfyUI', comfy.text + (comfy.url ? ' (' + comfy.url + ')' : '')));
  lines.push(pad('Forge', forge.text));
  lines.push(pad('API厂商', api.provider));
  lines.push(pad('API密钥', api.key));
  lines.push(pad('API地址', api.url));
  lines.push(pad('云账号', _getUserId()));
  lines.push('');

  // 余额
  var bal = _getBalances();
  lines.push('--- 余额 ---');
  lines.push(pad((TileAPI.slotLabel ? TileAPI.slotLabel('aji', 'AJI') : 'AJI') + '余额', bal.aji));
  lines.push(pad((TileAPI.slotLabel ? TileAPI.slotLabel('grs', TileAPI.computeBrand()) : TileAPI.computeBrand()) + '积分', bal.grs));
  lines.push('');

  // 出图设置 / 参数
  var out = _getOutputSettings();
  var gen = _getGenParams();
  lines.push('--- 当前参数 ---');
  lines.push(pad('模型', gen.model));
  lines.push(pad('尺寸', gen.size));
  lines.push(pad('抗截断', gen.anti));
  lines.push(pad('参考图', gen.refs));
  lines.push(pad('图层类型', out.layer));
  lines.push(pad('自动编组', out.autoGroup));
  lines.push(pad('自动回写', out.autoReturn));
  lines.push('');

  // 任务统计
  var sr = _getSuccessRate();
  lines.push('--- 运行统计 ---');
  lines.push(pad('成功率', sr.rate + ' (' + sr.success + '/' + sr.total + ')'));
  lines.push(pad('平均耗时', _getAvgDuration()));
  lines.push(pad('当前任务', _getActiveTasks() + ' 个'));
  lines.push(pad('最近成功', _timeAgo(_getLastSuccessTime())));
  var lastErr = _getLastError();
  if (lastErr && lastErr.message) {
    lines.push(pad('最近错误', lastErr.message + ' (' + _timeAgo(lastErr.time) + ')'));
  }

  return lines.join('\n');
};

})();
