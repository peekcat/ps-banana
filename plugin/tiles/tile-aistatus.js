// ============================================================
//  tile-aistatus.js — AI 服务可用度监控磁贴
//
//  ★ 这个文件是开源的, 用户能完整阅读所有逻辑 ★
//
//  做的事:
//    1. 用户首次打开 → 显示"详细告知"屏, 列出会上报什么/不会上报什么
//    2. 用户勾选同意 + 点启用 → 写 storage 'aistatus.enabled' = true
//    3. 启用后 → 显示大盘 (4 条线的近 1 小时成功率), 同时主插件后台开始上报
//    4. 用户随时可以在磁贴里关掉 → 立刻停止上报, 也无法再看大盘
//
//  绝对不会偷做的事:
//    ✗ 在用户没勾"启用上报"前自动联网
//    ✗ 收集任何身份信息
//    ✗ 把用户提示词或图片发出去
//
//  上报字段在哪里:
//    主插件 host/ai-api.js  里的 reportAiUsage() 函数 — 用户可以审计
// ============================================================
(function() {
'use strict';

var STATUS_REFRESH_MS = 30000;   // 大盘 30 秒刷一次

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 登录态检查 (跟客服磁贴口径一致)
function _isLoggedIn() {
  return !!TileAPI.state.get('cloud.loggedIn') && !!TileAPI.storage.get('cloud.token');
}

// 未登录冻结面板 — 跟 tile-support 一样的"去登录"风格
function _renderLoginGate(container) {
  container.innerHTML =
    '<div class="w10-panel aistatus-panel">' +
      '<div class="aistatus-title">📊 服务可用度监控</div>' +
      '<div class="support-empty" style="padding:24px;text-align:center;line-height:1.8">' +
        '🔐 服务可用度监控需要 <b>登录</b> 后才能使用<br>' +
        '<span style="font-size:12px;color:var(--text-sub,#888)">登录后才能上报匿名数据 / 查看全网大盘</span><br><br>' +
        '<button class="support-send-btn" id="aistatusGotoLoginBtn">去登录</button>' +
      '</div>' +
    '</div>';
  var loginBtn = container.querySelector('#aistatusGotoLoginBtn');
  if (loginBtn) loginBtn.addEventListener('click', function() {
    if (TileAPI && typeof TileAPI.expandTile === 'function') {
      TileAPI.expandTile('topbar');
    } else {
      TileAPI.toast('请打开顶部账号面板登录', 'info');
    }
  });
}

function _isEnabled() {
  return TileAPI.storage.get('aistatus.enabled') === true;
}
function _setEnabled(v) {
  TileAPI.storage.set('aistatus.enabled', !!v);
}

// ============================================================
//  正面磁贴渲染
// ============================================================
function renderFront(container, w, h) {
  var enabled = _isEnabled();
  var iconColor = enabled ? '#4caf50' : '#888';
  if (w >= 2) {
    container.innerHTML =
      '<div class="tile-icon" style="color:' + iconColor + ';">📊</div>' +
      '<div class="tile-label">服务器状态</div>' +
      '<div class="tile-desc">' + (enabled ? '已启用监控' : '未启用') + '</div>';
  } else {
    container.innerHTML =
      '<div class="tile-icon" style="color:' + iconColor + ';">📊</div>' +
      '<div class="tile-label">状态</div>';
  }
}

// ============================================================
//  展开面板渲染 — 根据是否启用 显示不同的屏
// ============================================================
var _statusTimer = null;
var _activeContainer = null;

function onExpand(container, sizeHint) {
  _activeContainer = container;
  // 未登录冻结
  if (!_isLoggedIn()) {
    _renderLoginGate(container);
    return function cleanup() {
      if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; }
      _activeContainer = null;
    };
  }
  if (_isEnabled()) {
    _renderEnabledScreen(container);
  } else {
    _renderConsentScreen(container);
  }
  return function cleanup() {
    if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; }
    _activeContainer = null;
  };
}

// ============================================================
//  屏 A: 未启用 → 详细告知 + 同意按钮
// ============================================================
function _renderConsentScreen(container) {
  if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; }
  container.innerHTML =
    '<div class="w10-panel aistatus-panel">' +
      '<div class="aistatus-title">🌐 AI 服务可用度监控</div>' +

      '<div class="aistatus-warn">⚠ 这个功能需要你授权后才能使用</div>' +

      '<div class="aistatus-section">每次跑 AI 后, 主插件会上报这 7 件事:</div>' +
      '<ul class="aistatus-list">' +
        '<li>1. 你用的是 AJI 还是 GRS</li>' +
        '<li>2. 用的是香蕉系列还是 GPT-Image 系列 (大类, 不是具体模型名)</li>' +
        '<li>3. 分辨率 (1K / 2K / 4K)</li>' +
        '<li>4. 这次成功还是失败</li>' +
        '<li>5. 跑了多少秒</li>' +
        '<li>6. 是怎么结束的 (成功 / 超时 / 用户中断 / 报错)</li>' +
        '<li>7. 报错时的文字 (脱敏过, 详见下方)</li>' +
      '</ul>' +

      '<div class="aistatus-section aistatus-no">绝对不会上报:</div>' +
      '<ul class="aistatus-list aistatus-list-no">' +
        '<li>✗ 你写的提示词</li>' +
        '<li>✗ 你生成的图</li>' +
        '<li>✗ 你的中转站地址 (URL)</li>' +
        '<li>✗ 你的 API Key</li>' +
        '<li>✗ 你的 IP / 设备号 / 任何身份信息</li>' +
      '</ul>' +

      '<div class="aistatus-section">脱敏怎么做:</div>' +
      '<div class="aistatus-detail">' +
        '报错文字会过滤掉 网址 / sk-xxx 格式的 Key / IP / Bearer token, 全部替换成占位符。<br>' +
        '例: <code>"Key sk-abc123 无效"</code> → <code>"Key &lt;KEY&gt; 无效"</code>' +
      '</div>' +

      '<div class="aistatus-section">你可以监管 (开源):</div>' +
      '<div class="aistatus-codepaths">' +
        '<button class="w10-btn aistatus-codebtn" data-open-code="ai-api">📂 查看上报+脱敏代码 (host/ai-api.js)</button>' +
        '<button class="w10-btn aistatus-codebtn" data-open-code="aistatus-tile">📂 查看本磁贴代码 (tile-aistatus.js)</button>' +
      '</div>' +
      '<div class="aistatus-detail" style="margin-top:6px">主插件是开源项目, 代码完全可读、可改、可关。</div>' +

      '<div class="aistatus-section">互惠原则:</div>' +
      '<div class="aistatus-detail">只有<b>愿意贡献数据的用户</b>才能查看大家的服务器状态。<br>启用上报后能立刻看大盘, 关闭后会立刻看不到 (不是惩罚, 是公平)。</div>' +

      '<div class="aistatus-consent-row">' +
        '<label class="aistatus-consent-label">' +
          '<input type="checkbox" id="aiConsent">' +
          '<span>我已阅读上述说明, 同意启用上报并查看大盘</span>' +
        '</label>' +
      '</div>' +

      '<div class="aistatus-actions">' +
        '<button class="w10-btn w10-btn-accent" id="aiEnableBtn" disabled>启用上报 + 查看大盘</button>' +
        '<button class="w10-btn" id="aiCancelBtn">不启用</button>' +
      '</div>' +
    '</div>';

  var consent = container.querySelector('#aiConsent');
  var enableBtn = container.querySelector('#aiEnableBtn');
  var cancelBtn = container.querySelector('#aiCancelBtn');

  consent.onchange = function() {
    enableBtn.disabled = !consent.checked;
  };
  enableBtn.onclick = function() {
    _setEnabled(true);
    TileAPI.toast('已启用上报, 之后跑 AI 会自动上报匿名数据', 'success');
    _renderEnabledScreen(container);
  };
  cancelBtn.onclick = function() {
    TileAPI.toast('已选择不启用, 磁贴不会上报数据', 'info');
  };

  // 打开代码文件按钮
  container.querySelectorAll('[data-open-code]').forEach(function(btn) {
    btn.onclick = function() {
      var key = btn.dataset.openCode;
      var fileMap = {
        'ai-api': 'host/ai-api.js',
        'aistatus-tile': 'tiles/tile-aistatus.js'
      };
      var rel = fileMap[key];
      if (!rel) return;
      TileAPI.sendToHost('aistatusOpenCodeFile', { rel: rel });
      TileAPI.toast('正在打开 ' + rel + ' (用记事本/VSCode)', 'info');
    };
  });
}

// ============================================================
//  屏 B: 已启用 → 大盘 + 关闭按钮
// ============================================================
var _currentWindow = '1h';   // 当前查看的窗口: 1h / 24h / 7d

function _renderEnabledScreen(container) {
  var w = _currentWindow;
  var winLabel = w === '24h' ? '24 小时' : (w === '7d' ? '7 天' : '近 1 小时');
  container.innerHTML =
    '<div class="w10-panel aistatus-panel">' +
      '<div class="aistatus-title">🌐 AI 服务可用度 <span class="aistatus-title-window">(' + winLabel + ')</span></div>' +
      '<div class="aistatus-tip">数据来自所有授权用户的匿名上报</div>' +

      '<div class="aistatus-tabs">' +
        '<span class="aistatus-tab' + (w === '1h' ? ' active' : '') + '" data-window="1h">🕐 1 小时</span>' +
        '<span class="aistatus-tab' + (w === '24h' ? ' active' : '') + '" data-window="24h">📅 24 小时</span>' +
        '<span class="aistatus-tab' + (w === '7d' ? ' active' : '') + '" data-window="7d">📊 7 天</span>' +
      '</div>' +

      // 24h/7d 才有图表区, 1h 不画 (数据点太少没意义)
      ((w === '24h' || w === '7d')
        ? '<canvas id="aiBoardChart" class="aistatus-chart" width="640" height="200"></canvas>' +
          '<div id="aiBoardChartLegend" class="aistatus-chart-legend"></div>'
        : '') +

      '<div id="aiBoardArea" class="aistatus-board">' +
        '<div class="aistatus-loading">正在加载…</div>' +
      '</div>' +

      '<div class="aistatus-actions" style="margin-top:8px">' +
        '<button class="w10-btn" id="aiRefreshBtn">🔄 刷新</button>' +
        '<button class="w10-btn" id="aiDisableBtn" style="color:#ff8a8a">关闭上报</button>' +
      '</div>' +

      '<div class="aistatus-detail" style="margin-top:6px">' +
        '关闭后会立刻停止上报, 也无法再查看大盘。<br>' +
        '上报详情 / 代码位置: <a href="#" data-open-code="ai-api">查看代码</a>' +
      '</div>' +
    '</div>';

  // tab 切换
  container.querySelectorAll('.aistatus-tab').forEach(function(t) {
    t.onclick = function() {
      var w = t.getAttribute('data-window');
      if (!w || w === _currentWindow) return;
      _currentWindow = w;
      _renderEnabledScreen(container);  // 重新渲染整个屏 (会重新拉数据 + 重置定时器)
    };
  });

  container.querySelector('#aiRefreshBtn').onclick = _fetchAndRender;
  container.querySelector('#aiDisableBtn').onclick = function() {
    TileAPI.confirm('确定关闭上报吗?\n\n关闭后:\n· 立刻停止上报你的任务数据\n· 大盘也会被关闭, 看不到其他人的状态').then(function(ok) {
      if (!ok) return;
      _setEnabled(false);
      TileAPI.toast('已关闭上报', 'info');
      _renderConsentScreen(container);
    });
  };
  container.querySelectorAll('[data-open-code]').forEach(function(a) {
    a.onclick = function(e) {
      e.preventDefault();
      TileAPI.sendToHost('aistatusOpenCodeFile', { rel: 'host/ai-api.js' });
    };
  });

  // 立即拉一次, 然后定时刷
  _fetchAndRender();
  if (_statusTimer) clearInterval(_statusTimer);
  // 24h/7d 视图刷新得慢一点, 节省服务器和流量
  var refreshMs = _currentWindow === '7d' ? 5*60*1000 : (_currentWindow === '24h' ? 60*1000 : STATUS_REFRESH_MS);
  _statusTimer = setInterval(_fetchAndRender, refreshMs);
}

function _fetchAndRender() {
  TileAPI.sendToHost('aistatusFetch', { window: _currentWindow });
}

// 收 host 的查询结果
TileAPI.onHostMessage('aistatusResult', function(data) {
  if (!_activeContainer) return;
  var area = _activeContainer.querySelector('#aiBoardArea');
  if (!area) return;
  if (!data || !data.success) {
    if (data && data.status === 403) {
      area.innerHTML = '<div class="aistatus-empty">⚠ 服务器拒绝了查询<br><br>原因: 你需要先上报过数据才能查看大盘 (互惠原则)<br><br>请等下一次 AI 调用完成后再来看</div>';
    } else {
      area.innerHTML = '<div class="aistatus-empty">无法连接服务器: ' + _esc((data && data.error) || '?') + '</div>';
      try {
        if (window._telemetry) window._telemetry.trackError('aistatus.fetch.fail', 'fetch_board', (data && data.error) || ('status=' + (data && data.status)));
      } catch(_) {}
    }
    return;
  }
  var d = data.data || {};
  var buckets = d.buckets || [];
  var winLabel = _currentWindow === '24h' ? '24 小时' : (_currentWindow === '7d' ? '7 天' : '近 1 小时');
  if (buckets.length === 0) {
    area.innerHTML = '<div class="aistatus-empty">' + winLabel + '内还没有数据</div>';
    return;
  }
  // 排序: aji 优先, 然后 grs, 然后其他; 同 provider 内按"重要度"排序
  var modelOrder = ['banana-pro','banana-2','banana-old','banana-other','banana','gpt-image'];
  buckets.sort(function(a, b) {
    var pp = ['aji','grs','momo','others'];
    var pa = pp.indexOf(a.provider), pb = pp.indexOf(b.provider);
    if (pa !== pb) return pa - pb;
    var ma = modelOrder.indexOf(a.modelType);
    var mb = modelOrder.indexOf(b.modelType);
    if (ma === -1) ma = 999;
    if (mb === -1) mb = 999;
    return ma - mb;
  });
  // 表头说明每列的含义
  var html =
    '<div class="aistatus-header">' +
      '<div class="aistatus-header-name">类型</div>' +
      '<div class="aistatus-header-rate" title="出图成功的次数 ÷ 总次数">成功率</div>' +
      '<div class="aistatus-header-time" title="所有任务的平均耗时, 单位秒">平均耗时</div>' +
      '<div class="aistatus-header-count" title="' + winLabel + '内统计到的任务总数">总次数</div>' +
    '</div>';
  var lastProvider = null;
  buckets.forEach(function(b) {
    if (b.provider !== lastProvider) {
      html += '<div class="aistatus-providertitle">' + _providerLabel(b.provider) + '</div>';
      lastProvider = b.provider;
    }
    var rateColor = _rateColor(b.successRate);
    html +=
      '<div class="aistatus-row">' +
        '<div class="aistatus-row-name">' + _modelTypeLabel(b.modelType) + '</div>' +
        '<div class="aistatus-row-rate" style="color:' + rateColor + '">' +
          (b.successRate != null ? (b.successRate + '%') : '?') +
        '</div>' +
        '<div class="aistatus-row-time">' + (b.avgElapsed != null ? (b.avgElapsed + 's') : '-') + '</div>' +
        '<div class="aistatus-row-count">' + b.total + ' 次</div>' +
      '</div>';
    // 分辨率耗时拆分 (只在服务端有数据时才显示, 服务端只回样本数 >= 3 的, 避免噪声)
    // 不同分辨率走不同处理流, 2K/1K/4K 速度差很多, 单独看更准
    if (b.sizeStats && Object.keys(b.sizeStats).length > 0) {
      var sizeOrder = ['1K','2K','4K','Auto'];
      var parts = [];
      sizeOrder.forEach(function(sz) {
        if (b.sizeStats[sz]) {
          parts.push(sz + ' ' + b.sizeStats[sz].avgElapsed + 's<span class="aistatus-size-cnt">(' + b.sizeStats[sz].count + ')</span>');
        }
      });
      // 兜底: 服务端如果出现非标准 size, 也显示
      Object.keys(b.sizeStats).forEach(function(sz) {
        if (sizeOrder.indexOf(sz) === -1) {
          parts.push(_esc(sz) + ' ' + b.sizeStats[sz].avgElapsed + 's<span class="aistatus-size-cnt">(' + b.sizeStats[sz].count + ')</span>');
        }
      });
      if (parts.length) {
        html += '<div class="aistatus-row-sizes">分辨率耗时: ' + parts.join(' · ') + '</div>';
      }
    }
    // 内容审查率 (如果服务端给了这个字段, 单独展示一行 — 不算服务器问题, 让用户知道自己内容触发审查的比例)
    if (b.contentRejectRate != null && b.contentRejectRate > 0) {
      html += '<div class="aistatus-row-reasons" style="color:#ff9800">内容审查率 ' + b.contentRejectRate + '% (跟服务器无关, 是你的图/词被 AI 判定违规)</div>';
    }
    // 真服务器问题分布 (只在联通率 < 80% 才显示, 因为这时候才有意义)
    if (b.successRate != null && b.successRate < 80 && b.reasons) {
      var failReasons = [];
      var totalRealFail = (b.reasons.timeout || 0) + (b.reasons.apiError || 0);
      if (totalRealFail > 0) {
        if (b.reasons.timeout > 0) {
          failReasons.push(Math.round((b.reasons.timeout / totalRealFail) * 100) + '% 网络超时');
        }
        if (b.reasons.apiError > 0) {
          failReasons.push(Math.round((b.reasons.apiError / totalRealFail) * 100) + '% 服务器报错');
        }
        if (failReasons.length) {
          html += '<div class="aistatus-row-reasons">服务器问题: ' + failReasons.join(', ') + '</div>';
        }
      }
      // 错误样本 (服务端已经过滤了 safetyFilter / userStop, 不会污染)
      if (b.errSamples && b.errSamples.length > 0) {
        html += '<div class="aistatus-row-samples">常见报错: ' + b.errSamples.slice(0, 3).map(_esc).join(' / ') + '</div>';
      }
    }
  });
  html += '<div class="aistatus-meta">总样本 ' + d.totalSamples + ' 条 · ' + new Date(d.updatedAt).toLocaleTimeString() + '</div>';
  area.innerHTML = html;

  // 24h/7d 视图带 series 时间序列, 画 Canvas 折线图
  if (d.series && d.series.length > 0) {
    var canvas = _activeContainer.querySelector('#aiBoardChart');
    var legend = _activeContainer.querySelector('#aiBoardChartLegend');
    if (canvas && legend) {
      _renderChart(canvas, legend, d.series, _currentWindow);
    }
  }
});

function _providerLabel(p) {
  // 接槽位自定义名(用户改过名就显示他起的名字), 没改名走原默认
  var def;
  if (p === 'aji') def = 'AJI';
  else if (p === 'grs') def = TileAPI.computeBrand();
  else def = '其他';
  return TileAPI.slotLabel ? TileAPI.slotLabel(p, def) : def;
}
function _modelTypeLabel(t) {
  if (t === 'banana-pro')   return '香蕉 Pro';
  if (t === 'banana-2')     return '香蕉 2';
  if (t === 'banana-old')   return '香蕉 1 (旧)';
  if (t === 'banana-other') return '其他香蕉';
  if (t === 'banana')       return '香蕉系列';
  if (t === 'gpt-image')    return 'GPT-Image 系列';
  return t;
}
function _reasonLabel(r) {
  if (r === 'timeout') return '网络超时';
  if (r === 'userStop') return '用户中断';
  if (r === 'safetyFilter') return '内容被安全过滤';
  if (r === 'apiError') return '服务器报错';
  return r;
}
function _rateColor(rate) {
  if (rate == null) return '#888';
  if (rate >= 80) return '#4caf50';   // 绿: 联通良好
  if (rate >= 60) return '#ffc107';   // 黄: 偶有抖动
  return '#ff5252';                    // 红: 明显不通
}

// ============================================================
//  Canvas 折线图: 时间序列联通率
//  series = [{ provider, modelType, points: [{ts, successRate, samples}, ...] }]
//  successRate = null 时该点断开, 不画连线 (样本太少不可信)
// ============================================================
// 每个 series 的颜色 — 按 provider+modelType 组合算一个固定色
function _seriesColor(provider, modelType) {
  // 主色: aji 蓝 / grs 橙 / others 灰
  var base = provider === 'aji' ? [79, 195, 247] :
             (provider === 'grs' ? [255, 152, 0] : [144, 144, 144]);
  // 副色调: 按 modelType 微调亮度
  var modelOrder = ['banana-pro','banana-2','banana-old','banana-other','banana','gpt-image'];
  var idx = Math.max(0, modelOrder.indexOf(modelType));
  var shift = idx * 18;   // 每个 model 在 base 上偏一点
  return 'rgb(' +
    Math.min(255, base[0] - shift) + ',' +
    Math.min(255, base[1] + shift / 2) + ',' +
    Math.min(255, base[2] + shift) + ')';
}

function _renderChart(canvas, legendEl, series, windowKey) {
  var ctx = canvas.getContext('2d');
  // 让 canvas 显示尺寸跟内置宽高匹配 (避免 DPR 模糊)
  var dpr = window.devicePixelRatio || 1;
  var rect = canvas.getBoundingClientRect();
  var W = rect.width || canvas.width;
  var H = rect.height || canvas.height;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, W, H);

  // 内边距 (留给 Y 轴标签 / X 轴时间)
  var pad = { top: 12, right: 12, bottom: 22, left: 32 };
  var plotW = W - pad.left - pad.right;
  var plotH = H - pad.top - pad.bottom;

  // 找全局 X 范围 (所有 series 共享同一时间轴)
  var minTs = Infinity, maxTs = -Infinity;
  series.forEach(function(s) {
    s.points.forEach(function(p) {
      if (p.ts < minTs) minTs = p.ts;
      if (p.ts > maxTs) maxTs = p.ts;
    });
  });
  if (!isFinite(minTs) || !isFinite(maxTs) || minTs === maxTs) {
    // 数据不足
    ctx.fillStyle = '#888';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('数据点不足, 无法绘图', W / 2, H / 2);
    if (legendEl) legendEl.innerHTML = '';
    return;
  }

  // Y 轴: 联通率 0-100%
  function tx(ts) { return pad.left + (ts - minTs) / (maxTs - minTs) * plotW; }
  function ty(rate) { return pad.top + (1 - rate / 100) * plotH; }

  // 网格线 + Y 轴标签 (0/25/50/75/100)
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#888';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  [0, 25, 50, 75, 100].forEach(function(yv) {
    var y = ty(yv);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
    ctx.fillText(yv + '%', pad.left - 4, y);
  });

  // X 轴时间标签
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  var labelCount = windowKey === '7d' ? 7 : 6;
  for (var i = 0; i <= labelCount; i++) {
    var t = minTs + (maxTs - minTs) * (i / labelCount);
    var dt = new Date(t);
    var label;
    if (windowKey === '7d') {
      label = (dt.getMonth() + 1) + '/' + dt.getDate();
    } else {
      label = dt.getHours() + ':' + ('0' + dt.getMinutes()).slice(-2);
    }
    ctx.fillText(label, tx(t), H - pad.bottom + 4);
  }

  // 画每条线
  ctx.lineWidth = 1.6;
  series.forEach(function(s) {
    var color = _seriesColor(s.provider, s.modelType);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    var prevValid = false;
    ctx.beginPath();
    s.points.forEach(function(p) {
      if (p.successRate == null) {
        prevValid = false;
        return;
      }
      var x = tx(p.ts);
      var y = ty(p.successRate);
      if (!prevValid) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      prevValid = true;
    });
    ctx.stroke();
    // 画点 (有数据的点)
    s.points.forEach(function(p) {
      if (p.successRate == null) return;
      ctx.beginPath();
      ctx.arc(tx(p.ts), ty(p.successRate), 2, 0, Math.PI * 2);
      ctx.fill();
    });
  });

  // 图例
  if (legendEl) {
    var legendHtml = series.map(function(s) {
      var color = _seriesColor(s.provider, s.modelType);
      return '<span class="aistatus-legend-item">' +
        '<span class="aistatus-legend-dot" style="background:' + color + '"></span>' +
        _providerLabel(s.provider) + ' / ' + _modelTypeLabel(s.modelType) +
      '</span>';
    }).join('');
    legendEl.innerHTML = legendHtml;
  }
}

// ============================================================
//  注册磁贴
// ============================================================
TileAPI.registerTile({
  id: 'aistatus',
  icon: '📊',
  label: '服务器状态',
  desc: 'AI 可用度监控',
  group: 'main',
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 3, h: 3 },
  renderFront: renderFront,
  onExpand: onExpand
});

// 登录态变化 → 展开中的面板自动刷新
if (TileAPI && typeof TileAPI.on === 'function') {
  TileAPI.on('auth:loggedIn', function() {
    if (!_activeContainer) return;
    if (_isEnabled()) _renderEnabledScreen(_activeContainer);
    else _renderConsentScreen(_activeContainer);
  });
  TileAPI.on('auth:loggedOut', function() {
    if (!_activeContainer) return;
    if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; }
    _renderLoginGate(_activeContainer);
  });
}

})();
