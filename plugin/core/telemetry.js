// ============================================================
//  core/telemetry.js — 用户改进计划 (匿名行为收集)
//
//  ★ 这个文件是开源的, 用户能完整阅读所有逻辑 ★
//
//  做的事:
//    1. 用户主动勾选 "参加用户改进计划" 后才采集 (默认不勾)
//    2. 生成稳定 deviceId (本地 hash, 不绑账号), 用户能在设置里重置
//    3. 采集 5 类事件: boot / task / tile_expand / session_end / prefs
//    4. 节流批发: 攒 30 秒或 20 条事件才发, 失败丢弃 (不在本地攒队列)
//    5. 任何 PII 字段都不会被采集 — 提示词/图片/key/路径/账号 全都不上
//
//  绝对不会上报:
//    ✗ 任何用户提示词/生成的图
//    ✗ API Key / 密码 / token
//    ✗ IP / 设备号 / MAC / 主机名 / 用户名
//    ✗ 文档名 / 图层名 / 文件路径
//    ✗ 任何身份信息
// ============================================================
(function() {
  'use strict';

  var TELEMETRY_PATH = '/api/telemetry';
  var _serverConfig = window.WheelchairServerConfig;
  var BATCH_INTERVAL_MS = 30 * 1000;     // 30 秒批发一次
  var BATCH_MAX_EVENTS = 20;             // 攒到 20 条立刻发 (防大批操作时积压)
  var SESSION_ID = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  var SESSION_START = Date.now();

  var _queue = [];
  var _flushTimer = null;
  var _enabled = false;          // 当前是否开启上报
  var _deviceId = null;          // 16 字符稳定 ID
  var _bootSent = false;         // 防止 boot 事件重复发
  var _tasksThisSession = 0;
  var _featuresThisSession = {};
  var _errorsThisSession = 0;

  // ===== deviceId 管理 =====
  // 不依赖 crypto (UXP 老 webview 可能没 crypto.randomUUID), 用本地随机 + 时间戳 + 简单 hash
  function _genDeviceId() {
    var raw = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2) + '_' + Math.random().toString(36).slice(2);
    // 简单 hash (32-bit FNV) → 16 字符
    var h1 = 2166136261, h2 = 5381;
    for (var i = 0; i < raw.length; i++) {
      var c = raw.charCodeAt(i);
      h1 = (h1 ^ c) >>> 0;
      h1 = (h1 * 16777619) >>> 0;
      h2 = (((h2 << 5) + h2) ^ c) >>> 0;
    }
    return ('0000000' + h1.toString(36)).slice(-7) + ('0000000' + h2.toString(36)).slice(-7) + Math.random().toString(36).slice(2, 4);
  }

  function _getOrInitDeviceId() {
    if (_deviceId) return _deviceId;
    var saved = TileAPI.storage.get('improvement.deviceId');
    if (typeof saved === 'string' && /^[a-zA-Z0-9_]{8,64}$/.test(saved)) {
      _deviceId = saved;
    } else {
      _deviceId = _genDeviceId();
      TileAPI.storage.set('improvement.deviceId', _deviceId);
    }
    return _deviceId;
  }

  // ===== 公共 API =====
  function isOptedIn() {
    return TileAPI.storage.get('improvement.optedIn') === true;
  }

  function optIn() {
    TileAPI.storage.set('improvement.optedIn', true);
    _enabled = true;
    _getOrInitDeviceId();
    // 立刻发一次 boot + prefs
    _sendBoot();
    _sendPrefs();
  }

  function optOut() {
    TileAPI.storage.set('improvement.optedIn', false);
    _enabled = false;
    _queue = [];
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  }

  function resetDeviceId() {
    _deviceId = _genDeviceId();
    TileAPI.storage.set('improvement.deviceId', _deviceId);
  }

  function getDeviceId() {
    return _deviceId || TileAPI.storage.get('improvement.deviceId') || null;
  }

  // 启动时调用 — 如果用户已勾选, 启动 boot/prefs/session 流程
  function bootIfOptedIn() {
    if (!isOptedIn()) return;
    _enabled = true;
    _getOrInitDeviceId();
    // 延迟几秒发 boot (避免 PS 启动时网络还没准备好)
    setTimeout(function() {
      _sendBoot();
      _sendPrefs();
    }, 8000);
    // 注册 session 结束事件 (panel 关闭时)
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', function() {
        _sendSessionEnd();
        _flushSync();
      });
    }
  }

  // ===== 事件 push =====
  function event(type, data) {
    if (!_enabled) return;
    var ev = data || {};
    ev.type = type;
    ev.session_id = SESSION_ID;
    ev.ts = Date.now();
    _queue.push(ev);
    if (_queue.length >= BATCH_MAX_EVENTS) {
      _flush();
    } else if (!_flushTimer) {
      _flushTimer = setTimeout(_flush, BATCH_INTERVAL_MS);
    }
  }

  function _flush() {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    if (_queue.length === 0) return;
    if (!_enabled) { _queue = []; return; }
    var events = _queue.slice();
    _queue = [];
    var did = _getOrInitDeviceId();
    try {
      _serverConfig.fetchApi(TELEMETRY_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: did, events: events })
      }).catch(function() {}); // 失败丢弃, 不重试
    } catch(_) {}
  }

  // 同步发 (panel 关闭时)
  function _flushSync() {
    if (_queue.length === 0) return;
    if (!_enabled) return;
    var did = _getOrInitDeviceId();
    var events = _queue.slice();
    _queue = [];
    try {
      // navigator.sendBeacon 适合 unload 场景, fetch 在 beforeunload 里可能被取消
      var payload = JSON.stringify({ deviceId: did, events: events });
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
        var blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon(_serverConfig.url(TELEMETRY_PATH, _serverConfig.FALLBACK_BASE), blob);
      } else {
        // 降级 fetch (在 unload 路径上不一定发得出去)
        _serverConfig.fetchApi(TELEMETRY_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(function() {});
      }
    } catch(_) {}
  }

  // ===== 具体事件构造器 =====

  function _sendBoot() {
    if (_bootSent) return;
    _bootSent = true;
    var psV = '?';
    try {
      // PS 版本只取大版本号 (e.g. "26")
      var hostV = (typeof require === 'function' ? '' : '');   // panel 端拿不到 PS 版本, 让 host 上报
    } catch(_) {}
    var screenClass = _classifyScreen();
    var osLabel = _classifyOS();
    var lang = (typeof navigator !== 'undefined' && navigator.language) ? String(navigator.language).slice(0, 5) : 'unknown';
    var pluginVersion = (window._wheelchairVersion) || '?';
    event('boot', {
      plugin_version: pluginVersion,
      ps_version_major: psV,
      os_label: osLabel,
      screen_class: screenClass,
      language: lang,
      session_start_hour: new Date().getHours()
    });
  }

  function _sendPrefs() {
    var s = TileAPI.storage;
    var themeColor = s.get('appearance.themeColor') || '#0078d4';
    var hueClass = _classifyHue(themeColor);
    var layoutPreset = _classifyLayoutPreset();
    var tileCount = _countEnabledTiles();
    var groupsCount = _countGroups();
    event('prefs', {
      config: {
        theme_hue_class: hueClass,
        layout_preset: layoutPreset,
        tile_count_enabled: tileCount,
        groups_count: groupsCount,
        aji_configured: !!(s.get('connection.aji.url') && s.get('connection.aji.key')),
        grs_configured: !!(s.get('connection.grs.url') && s.get('connection.grs.key')),
        forge_connected: !!s.get('forge.connected'),
        comfyui_connected: !!s.get('comfyui.connected'),
        auto_check_update: s.get('update.autoCheck') !== false,
        sound_enabled: s.get('sound.enabled') !== false
      }
    });
  }

  function _sendSessionEnd() {
    if (!_enabled) return;
    var durMin = Math.round((Date.now() - SESSION_START) / 60000);
    var featList = Object.keys(_featuresThisSession);
    event('session_end', {
      duration_min: durMin,
      tasks_count: _tasksThisSession,
      feature_set_used: featList,
      errors_count: _errorsThisSession
    });
  }

  // ===== 采集点助手函数 =====

  // 任务事件 (host/ai-api 完成任务时调)
  function trackTask(info) {
    if (!_enabled) return;
    _tasksThisSession++;
    if (info && info.feature) _featuresThisSession[info.feature] = true;
    if (info && info.result === 'fail') _errorsThisSession++;
    var clean = {
      feature: info && info.feature,
      provider: info && info.provider,
      model_type: info && info.model_type,
      size: info && info.size,
      aspect_ratio: info && info.aspect_ratio,
      batch_size: info && info.batch_size,
      result: info && info.result,
      elapsed_bucket: info && info.elapsed_bucket,
      error_category: info && info.error_category
    };
    event('task', clean);
  }

  // 磁贴展开 (tile-engine 调)
  function trackTileExpand(tileId) {
    if (!tileId) return;
    event('tile_expand', { tile_id: tileId });
  }

  // 错误事件 (任何关键报错调)
  //   category: 'forge.api.http_5xx' 这种字符串字面量, 全小写下划线
  //   step:     报错发生时的业务步骤 (可选), 比如 'generate' / 'login' / 'refill'
  //   msgRaw:   错误原文 — 内部会自动跑 _sanitizeErrorMsg 脱敏后才发, 调用方不用自己脱敏
  function trackError(category, step, msgRaw) {
    if (!_enabled) return;
    _errorsThisSession++;
    event('error', {
      category: category,
      step: step,
      msg: _sanitizeErrorMsg(msgRaw)
    });
  }

  // 错误文字脱敏 — 集中处理, 在 trackError 入口跑
  //   会杀: URL / Windows 路径 / Mac+Linux 路径 / 邮箱 / sk- 风格 key / Bearer token / 服务端发的 XSQ- 卡密 / 长 hex 串
  //   会留: HTTP 状态码 / 错误类名 / 描述性关键词 (timeout/refused 等) / 短数字
  //   最终截断到 200 字符
  function _sanitizeErrorMsg(s) {
    if (s == null) return '';
    s = String(s);
    // 网址 (优先杀, 因为 URL 里可能含 sk-key, 后面 sk- 规则就不用再扫这一段)
    s = s.replace(/https?:\/\/[^\s"',)<>]+/gi, '[url]');
    // Windows 路径 (C:\Users\张三\Desktop\xx.jpg) — 中文姓名顺带杀
    s = s.replace(/[A-Za-z]:\\[^\s"'<>]+/g, '[path]');
    // Mac/Linux 路径 (/Users/xxx / /home/xxx)
    s = s.replace(/\/Users\/[^\s/]+/g, '/Users/[name]');
    s = s.replace(/\/home\/[^\s/]+/g, '/home/[name]');
    // 邮箱
    s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]');
    // OpenAI 风格 API key
    s = s.replace(/sk-[A-Za-z0-9]{20,}/g, '[key]');
    // Bearer token
    s = s.replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, 'Bearer [key]');
    // 服务端发的卡密 XSQ-XXXXX-XXXXX-XXXXX (见 server.js cardGenerate)
    s = s.replace(/XSQ-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/g, '[cardkey]');
    // 长 hex 串 (token / 文件哈希 / device fingerprint)
    s = s.replace(/[A-Fa-f0-9]{32,}/g, '[hex]');
    // 截断
    if (s.length > 200) s = s.slice(0, 200);
    return s;
  }

  // ===== 分类工具 =====
  function _classifyHue(hex) {
    // 把任意主题色映射到 6 个色相分桶
    if (!hex || hex[0] !== '#') return 'unknown';
    var h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(function(c) { return c + c; }).join('');
    if (h.length !== 6) return 'unknown';
    var r = parseInt(h.slice(0, 2), 16) / 255;
    var g = parseInt(h.slice(2, 4), 16) / 255;
    var b = parseInt(h.slice(4, 6), 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d < 0.05) return 'gray';
    var hue;
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue = hue * 60;
    if (hue < 0) hue += 360;
    if (hue < 30 || hue >= 330) return 'red';
    if (hue < 70) return 'orange';
    if (hue < 100) return 'yellow';
    if (hue < 170) return 'green';
    if (hue < 260) return 'blue';
    return 'purple';
  }

  function _classifyScreen() {
    if (typeof screen === 'undefined') return 'unknown';
    var w = screen.width || 0;
    if (w < 1500) return 'small';
    if (w < 1920) return 'fhd';
    if (w < 2560) return 'qhd';
    return '4k';
  }

  function _classifyOS() {
    if (typeof navigator === 'undefined') return 'unknown';
    var ua = (navigator.userAgent || '').toLowerCase();
    if (ua.indexOf('mac') >= 0) return 'mac';
    if (ua.indexOf('windows nt 10') >= 0) {
      // Windows 11 也报 NT 10.0, 但 UA 里可能有 'win64; x64' 没法可靠区分
      return 'win10_or_11';
    }
    if (ua.indexOf('windows') >= 0) return 'win_other';
    return 'other';
  }

  function _classifyLayoutPreset() {
    var v = TileAPI.storage.get('layout.preset');
    if (v === 'recommended' || v === 'default' || v === 'custom') return v;
    return 'unknown';
  }

  function _countEnabledTiles() {
    try {
      var layout = TileAPI.storage.get('__tile_layout_v6');
      if (!layout || typeof layout !== 'object') return 0;
      // layout 是个对象, 每个 key 是 tile id
      return Object.keys(layout).length;
    } catch(_) { return 0; }
  }

  function _countGroups() {
    try {
      var groups = TileAPI.storage.get('groups.list');
      if (Array.isArray(groups)) return groups.length;
      return 0;
    } catch(_) { return 0; }
  }

  // ===== 暴露公共 API =====
  window._telemetry = {
    isOptedIn: isOptedIn,
    optIn: optIn,
    optOut: optOut,
    resetDeviceId: resetDeviceId,
    getDeviceId: getDeviceId,
    bootIfOptedIn: bootIfOptedIn,
    trackTask: trackTask,
    trackTileExpand: trackTileExpand,
    trackError: trackError,
    event: event,
    showOptInDialogIfNeeded: showOptInDialogIfNeeded
  };

  // ============================================================
  //  许可对话框 — 优先于欢迎页, 用户处理完才走欢迎页
  //  逻辑: 已勾选 / 在 snooze 期 → 不弹直接 resolve
  // ============================================================
  function _ensureOptInStyles() {
    if (document.getElementById('improvementOptInStyles')) return;
    var s = document.createElement('style');
    s.id = 'improvementOptInStyles';
    s.textContent = [
      '.improvement-optin-mask{position:fixed;inset:0;z-index:100600;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;animation:improvement-fadein 0.18s ease}',
      '@keyframes improvement-fadein{from{opacity:0}to{opacity:1}}',
      '.improvement-optin-card{width:480px;max-width:92vw;max-height:88vh;background:var(--bg,#1e1e1e);border:1px solid rgba(255,192,64,0.3);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,0.6);display:flex;flex-direction:column;overflow:hidden;animation:improvement-pop 0.22s cubic-bezier(0.2,1.4,0.5,1)}',
      '@keyframes improvement-pop{from{transform:scale(0.94);opacity:0}to{transform:scale(1);opacity:1}}',
      '.improvement-optin-head{padding:16px 20px 12px;border-bottom:1px solid rgba(255,255,255,0.06);background:rgba(255,192,64,0.05)}',
      '.improvement-optin-title{font-size:18px;font-weight:600;color:#ffd47a;margin-bottom:4px}',
      '.improvement-optin-tag{font-size:11px;color:var(--text-sub,#888)}',
      '.improvement-optin-body{padding:14px 20px;font-size:13px;line-height:1.7;color:var(--text,#ddd);overflow-y:auto;flex:1}',
      '.improvement-optin-body b{color:#ffd47a}',
      '.improvement-optin-details{margin:0 20px 12px;font-size:12px}',
      '.improvement-optin-details summary{cursor:pointer;color:var(--text-sub,#888);user-select:none;padding:6px 0}',
      '.improvement-optin-details summary:hover{color:var(--text,#ddd)}',
      '.improvement-optin-yes,.improvement-optin-no{margin:8px 0;padding:8px 12px;border-radius:5px;line-height:1.7;font-size:12px}',
      '.improvement-optin-yes{background:rgba(76,175,80,0.08);color:#b8e2bb}',
      '.improvement-optin-yes b{color:#69f0ae}',
      '.improvement-optin-no{background:rgba(255,82,82,0.08);color:#f0a8a8}',
      '.improvement-optin-no b{color:#ff8a8a}',
      '.improvement-optin-actions{padding:12px 20px 16px;display:flex;flex-wrap:wrap;gap:8px;border-top:1px solid rgba(255,255,255,0.06)}',
      '.improvement-optin-actions .w10-btn{flex:1 1 auto;font-size:13px;padding:10px 12px;white-space:nowrap}',
      '.improvement-optin-actions .w10-btn-accent{flex:2 1 auto}',
      '.improvement-optin-skip{flex-basis:100%!important;margin-top:2px;color:var(--text-sub,#888)!important;background:transparent!important;border:1px dashed rgba(255,255,255,0.15)!important;font-size:11px!important;padding:6px 10px!important}'
    ].join('');
    document.head.appendChild(s);
  }

  function showOptInDialogIfNeeded() {
    return new Promise(function(resolve) {
      if (!window.TileAPI || !TileAPI.storage) { resolve(); return; }
      if (TileAPI.storage.get('improvement.optedIn') === true) { resolve(); return; }
      var snoozeUntil = TileAPI.storage.get('improvement.snoozeUntil') || 0;
      if (snoozeUntil > Date.now()) { resolve(); return; }

      // 防重复
      if (document.getElementById('improvementOptInDialog')) { resolve(); return; }
      // 防 document.body 还没准备好
      if (!document.body) { resolve(); return; }

      _ensureOptInStyles();

      // 只解析一次, 防多次按钮触发
      var settled = false;
      function _doResolve() {
        if (settled) return;
        settled = true;
        resolve();
      }
      // 兜底: 60 秒后自动放行 (防对话框因任何原因看不到导致启动卡死)
      var hangGuard = setTimeout(function() {
        if (!settled) {
          // 当作 snooze 处理, 3 天后再问
          try { TileAPI.storage.set('improvement.snoozeUntil', Date.now() + 3 * 24 * 60 * 60 * 1000); } catch(_) {}
          var stuck = document.getElementById('improvementOptInDialog');
          if (stuck && stuck.parentNode) stuck.parentNode.removeChild(stuck);
          _doResolve();
        }
      }, 60000);

      var mask = document.createElement('div');
      mask.id = 'improvementOptInDialog';
      mask.className = 'improvement-optin-mask';
      mask.innerHTML =
        '<div class="improvement-optin-card">' +
          '<div class="improvement-optin-head">' +
            '<div class="improvement-optin-title">💝 加入用户改进计划</div>' +
            '<div class="improvement-optin-tag">完全自愿 · 不影响使用</div>' +
          '</div>' +
          '<div class="improvement-optin-body">' +
            '这个插件是夏三七 <b>一个人独立设计开发</b> 的, <b>完全免费开源, 不接任何商业合作, 也不卖任何东西</b>.<br><br>' +
            '我没有任何用户数据, 改起来全靠拍脑袋: 改了一个功能, 不知道有几个人用; 加了一个磁贴, 不知道大家觉得好不好; 修了一个 bug, 不知道是不是真解决了问题.<br><br>' +
            '如果你愿意分享一些 <b>匿名</b> 使用数据, 我会非常感谢. 你帮的不只是我, 是这个插件未来所有的用户.' +
          '</div>' +
          '<details class="improvement-optin-details">' +
            '<summary>📋 我会收集 / 不会收集哪些数据 (点开看完整列表)</summary>' +
            '<div class="improvement-optin-yes"><b>✓ 会收集 (匿名):</b><br>' +
              '· 你用了什么功能 / 哪个磁贴 / 哪个预设类型<br>' +
              '· 任务结果 (成功/失败/取消)<br>' +
              '· 报错文字 — 自动去掉网址 / 文件路径 / 卡密 / 邮箱 / API Key 等敏感片段后才上传<br>' +
              '· 你的偏好 (主题色色相 / 布局类型, 不是具体值)<br>' +
              '· 客户端环境 (PS 版本 / 系统类型 / 屏幕大小分级)<br>' +
              '· 使用时长 (粗到分钟) / 启动时段 (粗到小时)' +
            '</div>' +
            '<div class="improvement-optin-no"><b>✗ 绝对不会收集:</b><br>' +
              '· 你的提示词 / 生成的图<br>' +
              '· API Key / 密码 / token<br>' +
              '· 你的 IP / 微信 / QQ / 任何身份信息<br>' +
              '· 文档名 / 图层名 / 文件路径<br>' +
              '· 任何能定位到你个人的信息' +
            '</div>' +
          '</details>' +
          '<div class="improvement-optin-actions">' +
            '<button class="w10-btn w10-btn-accent" id="improvementOptInBtn">❤️ 我愿意参加</button>' +
            '<button class="w10-btn" id="improvementSnoozeBtn">3 天后再问我</button>' +
            '<button class="w10-btn improvement-optin-skip" id="improvementSkipBtn">这次先不参加 (3 天后再问)</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(mask);

      function _close() {
        clearTimeout(hangGuard);
        if (mask.parentNode) mask.parentNode.removeChild(mask);
      }

      document.getElementById('improvementOptInBtn').onclick = function() {
        try { optIn(); } catch(_) {}
        if (window.TileAPI) TileAPI.toast('谢谢支持 ❤️ 你能在设置里随时关闭', 'success');
        _close();
        _doResolve();
      };
      document.getElementById('improvementSnoozeBtn').onclick = function() {
        TileAPI.storage.set('improvement.snoozeUntil', Date.now() + 3 * 24 * 60 * 60 * 1000);
        _close();
        _doResolve();
      };
      document.getElementById('improvementSkipBtn').onclick = function() {
        TileAPI.storage.set('improvement.snoozeUntil', Date.now() + 3 * 24 * 60 * 60 * 1000);
        _close();
        _doResolve();
      };
    });
  }

})();
