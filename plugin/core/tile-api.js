/**
 * tile-api.js — TileAPI 标准接口
 * 这是整个插件的"万能插座"，所有磁贴模块通过这个接口注册和通信
 */
(function() {
'use strict';

var _tiles = {};       // id -> TileDefinition
var _events = {};      // eventName -> [handler, handler, ...]
var _state = {};       // path -> value
var _stateSubs = {};   // path -> [handler, ...]

// 插件启动时间(用于诊断面板显示运行时长)
var _pluginStartTime = Date.now();

var TileAPI = {
  // ========== 注册 ==========

  /**
   * 注册一个磁贴
   * def: { id, group, icon, label, desc, color, badge, live, liveBack,
   *        defaultSize:{w,h}, minSize:{w,h}, maxSize:{w,h},
   *        renderFront(container,w,h), renderBack(container),
   *        onExpand(container), onCollapse(), onStorageLoaded(storage),
   *        onMessage(action,data), onResize(w,h),
   *        actions?: [{ id, icon, label, type:'button'|'toggle',
   *                     run(), getState?():bool }]   // 可选: 暴露给右侧 Dock 快捷栏的动作 }
   */
  registerTile: function(def) {
    if (!def || !def.id) { console.error('[TileAPI] registerTile: 缺少id'); return; }
    if (_tiles[def.id]) { console.warn('[TileAPI] 磁贴已注册: ' + def.id); }
    def.group = def.group || 'main';
    def.defaultSize = def.defaultSize || { w: 1, h: 1 };
    def.minSize = def.minSize || { w: 1, h: 1 };
    def.maxSize = def.maxSize || { w: 4, h: 4 };
    _tiles[def.id] = def;
  },

  // ========== 查询 ==========

  getTileDef: function(id) { return _tiles[id] || null; },
  getAllTiles: function() { return Object.keys(_tiles).map(function(k) { return _tiles[k]; }); },

  // ========== 事件总线 ==========

  on: function(event, handler) {
    if (!_events[event]) _events[event] = [];
    _events[event].push(handler);
  },

  off: function(event, handler) {
    if (!_events[event]) return;
    var idx = _events[event].indexOf(handler);
    if (idx >= 0) _events[event].splice(idx, 1);
  },

  emit: function(event, data) {
    if (!_events[event]) return;
    var list = _events[event].slice();
    for (var i = 0; i < list.length; i++) {
      try { list[i](data); } catch(e) { console.error('[TileAPI] event error ' + event + ':', e); }
    }
  },

  // ========== 共享状态 ==========

  state: {
    get: function(path) { return _state[path]; },
    set: function(path, value) {
      var old = _state[path];
      _state[path] = value;
      // 通知订阅者
      if (_stateSubs[path]) {
        var list = _stateSubs[path].slice();
        for (var i = 0; i < list.length; i++) {
          try { list[i](value, old); } catch(e) { console.error('[TileAPI] state subscriber error ' + path + ':', e); }
        }
      }
      // 也发一个全局事件
      TileAPI.emit('state:changed', { path: path, value: value, oldValue: old });
    },
    subscribe: function(path, handler) {
      if (!_stateSubs[path]) _stateSubs[path] = [];
      _stateSubs[path].push(handler);
      // 返回取消订阅的函数
      return function unsubscribe() {
        var list = _stateSubs[path];
        if (!list) return;
        var idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    unsubscribe: function(path, handler) {
      var list = _stateSubs[path];
      if (!list) return;
      var idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    },
  },

  // ========== 存储 (代理到StorageManager) ==========

  storage: {
    get: function(key) { return window._storageManager ? window._storageManager.get(key) : null; },
    set: function(key, value) { if (window._storageManager) window._storageManager.set(key, value); },
    remove: function(key) { if (window._storageManager) window._storageManager.remove(key); },
  },

  // ========== 后端通信 (代理到MessageBridge) ==========

  sendToHost: function(action, data) {
    if (window._messageBridge) window._messageBridge.sendToHost(action, data);
  },

  onHostMessage: function(action, handler) {
    if (window._messageBridge) window._messageBridge.onHostMessage(action, handler);
  },

  // 取消注册 host 消息处理函数(磁贴 cleanup 里调, 避免反复展开叠加监听)
  offHostMessage: function(action, handler) {
    if (window._messageBridge && window._messageBridge.offHostMessage) window._messageBridge.offHostMessage(action, handler);
  },

  // ========== UI 工具 ==========

  /**
   * 确认弹窗，返回 Promise<boolean>
   * 优先用 UIKit.confirm(统一视觉),UIKit 未加载时走老的 #confirmOverlay 兜底
   */
  confirm: function(message) {
    if (window.UIKit && typeof window.UIKit.confirm === 'function') {
      return window.UIKit.confirm(message);
    }
    return new Promise(function(resolve) {
      var overlay = document.getElementById('confirmOverlay');
      var msg = document.getElementById('confirmMsg');
      var btnYes = document.getElementById('confirmYes');
      var btnNo = document.getElementById('confirmNo');
      if (!overlay || !msg) { resolve(false); return; }
      msg.textContent = message;
      overlay.style.display = 'flex';
      function cleanup() { overlay.style.display = 'none'; btnYes.onclick = null; btnNo.onclick = null; }
      btnYes.onclick = function() { cleanup(); resolve(true); };
      btnNo.onclick = function() { cleanup(); resolve(false); };
    });
  },

  /**
   * 通用对话框(透传到 UIKit.dialog)。UIKit 未加载时退回到 confirm。
   */
  dialog: function(config) {
    if (window.UIKit && typeof window.UIKit.dialog === 'function') {
      return window.UIKit.dialog(config);
    }
    return this.confirm((config && config.message) || '').then(function(ok) {
      return { index: ok ? 1 : 0 };
    });
  },

  /**
   * 输入弹窗(prompt)
   */
  prompt: function(message, opts) {
    if (window.UIKit && typeof window.UIKit.prompt === 'function') {
      return window.UIKit.prompt(message, opts);
    }
    return Promise.resolve(null);
  },

  /**
   * 轻提示
   */
  toast: function(message, type) {
    type = type || 'info';
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast toast-' + type + ' show';
    clearTimeout(el._timer);
    el._timer = setTimeout(function() { el.classList.remove('show'); }, 2500);
    // 把 error/warn 写到 info.lastError/info.errorHistory,供信息磁贴诊断用
    if (type === 'error' || type === 'warn') {
      var entry = { time: Date.now(), type: type, msg: String(message || '') };
      _state['info.lastError'] = entry;
      var hist = _state['info.errorHistory'] || [];
      hist.unshift(entry);
      if (hist.length > 10) hist = hist.slice(0, 10);
      _state['info.errorHistory'] = hist;
      // 触发订阅者(信息磁贴会监听 state:changed)
      TileAPI.emit('info:errorLogged', entry);
    }
  },

  /**
   * 获取插件启动时间(ms since epoch),用于显示运行时长
   */
  getStartTime: function() { return _pluginStartTime; },

  /**
   * 清洗服务器下发的公告 HTML(防 XSS, bug #3):
   * 允许基础排版标签(段落/换行/加粗/斜体/列表/链接/图片),
   * 剥掉 <script>/<style>/<iframe> 等危险标签、所有 on* 事件属性、
   * 以及 javascript:/data:(非图片) 协议。公告只用来展示文本+排版,不需要脚本能力。
   * 用法: el.innerHTML = TileAPI.sanitizeHtml(serverHtml);
   */
  sanitizeHtml: function(html) {
    var s = String(html == null ? '' : html);
    // 1. 整段删除危险标签及其内容
    s = s.replace(/<\s*(script|style|iframe|object|embed|form|link|meta|base)[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
    // 2. 删除这些标签的自闭合/无闭合残留
    s = s.replace(/<\s*(script|style|iframe|object|embed|form|link|meta|base)\b[^>]*>/gi, '');
    // 3. 去掉所有 on* 事件处理属性 (onClick / onerror ...)
    s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    // 4. 去掉 href/src 里的 javascript: 与 vbscript: 协议
    s = s.replace(/(href|src)\s*=\s*("|')?\s*(javascript|vbscript)\s*:[^"'>\s]*/gi, '$1=$2#$2');
    return s;
  },

  /**
   * 日志
   */
  log: function(message, type) {
    type = type || 'info';
    console.log('[' + type.toUpperCase() + '] ' + message);
    TileAPI.emit('log', { message: message, type: type });
  },

  // ========== 磁贴控制 (由TileEngine填充) ==========

  expandTile: function(tileId) {
    TileAPI.emit('tile:requestExpand', { tileId: tileId });
  },

  collapseTile: function() {
    TileAPI.emit('tile:requestCollapse', {});
  },

  getTileState: function(tileId) {
    // 由TileEngine在运行时填充实际实现
    return null;
  },

  // ========== GRS 算力 (Stage 4) ==========
  //
  //  状态机:
  //    compute.mode   = 'proxy' | 'byok'        (默认 'proxy')
  //    compute.key    = 'sk-xxxx' 或 ''        (proxy 模式且已建 key 时有值; BYOK 时为空, 用户的 key 在 connection.grs.key)
  //    compute.status = 'ok' | 'no_balance' | 'paused' | 'create_failed' | 'byok_no_key_on_server' | ''
  //    compute.cap    = 28800 (或 0)
  //    compute.balance= 上次同步到的余额 (估计值, 不是实时)
  //  事件:
  //    'compute:keyUpdated'   key/状态有变化时触发, 携带最新 state 对象
  //
  //  典型用法 (在 banana 类磁贴里):
  //    var st = TileAPI.compute.getState();
  //    if (st.mode === 'byok') {
  //        var byokKey = TileAPI.storage.get('connection.grs.key');
  //        ...用 byokKey 直接打 GRS
  //    } else if (st.key) {
  //        ...用 st.key 直接打 GRS
  //    } else {
  //        TileAPI.toast('还没拿到夏算力 key, 充值后再试', 'warn');
  //    }
  //
  //  生成完了 (无论成败) 调一次:
  //    TileAPI.compute.refill(1800);   // 1800 = 这次估算用掉的 credits, 仅日志用
  //
  compute: {
    // 粗估生成 credits 消耗 (服务端按规则决定要不要续杯, 数字不必精确)
    //   nano-banana / 默认 → 1800/张
    //   含 'pro' (Pro 系列) → 3600/张
    //   含 'fast' → 1200/张
    estimateCost: function(model, count) {
      count = parseInt(count, 10) || 1;
      if (!model) return 1800 * count;
      var lower = String(model).toLowerCase();
      if (lower.indexOf('pro') >= 0) return 3600 * count;
      if (lower.indexOf('fast') >= 0) return 1200 * count;
      return 1800 * count;
    },

    getState: function() {
      return {
        mode:    _state['compute.mode']    || 'proxy',
        key:     _state['compute.key']     || '',
        status:  _state['compute.status']  || '',
        cap:     _state['compute.cap']     || 0,
        balance: _state['compute.balance'] || 0,
        lastSyncAt: _state['compute.lastSyncAt'] || '',
        expiresAt: _state['compute.expiresAt'] || ''
      };
    },

    // 异步拿 key. 若 state 已有则秒回; 否则触发 host 拉一次. 永远 resolve, 失败时 key=''
    getKey: function(opts) {
      opts = opts || {};
      var s = TileAPI.compute.getState();
      if (s.key && !opts.forceRefresh) return Promise.resolve(s);
      return new Promise(function(resolve) {
        var done = false;
        var off = function() {};
        var timer = setTimeout(function() {
          if (done) return;
          done = true;
          off();
          resolve(TileAPI.compute.getState());
        }, 8000);
        var handler = function(data) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          off();
          // compute:keyUpdated is emitted after _applyResult has already normalized
          // the host payload. Applying it again would erase camelCase timestamps.
          resolve(data && typeof data === 'object' ? data : TileAPI.compute.getState());
        };
        TileAPI.on('compute:keyUpdated', handler);
        off = function() { TileAPI.off('compute:keyUpdated', handler); };
        TileAPI.sendToHost('cloudComputeGetKey', { forceRefresh: !!opts.forceRefresh });
      });
    },

    // 生成完后调一次 (fire-and-forget). 服务端按规则决定是否真续杯.
    //   usedCredits: 累计 credits (仅日志); attempts: 本次图片张数 (风控计数关键, 必传)
    refill: function(usedCredits, attempts) {
      TileAPI.sendToHost('cloudComputeRefill', {
        used: usedCredits || 0,
        attempts: attempts || 0
      });
    },

    // 强制对账, 返回 Promise<{ success, remaining }>
    sync: function() {
      return new Promise(function(resolve) {
        var done = false;
        var timer = setTimeout(function() {
          if (done) return; done = true;
          TileAPI.off('compute:syncResult', handler);
          resolve({ success: false, timeout: true });
        }, 8000);
        var handler = function(data) {
          if (done) return; done = true;
          clearTimeout(timer);
          TileAPI.off('compute:syncResult', handler);
          resolve(data || { success: false });
        };
        TileAPI.on('compute:syncResult', handler);
        TileAPI.sendToHost('cloudComputeSync', {});
      });
    },

    // 切 BYOK/proxy. 返回 Promise<{ success, mode }>
    setByok: function(mode) {
      return new Promise(function(resolve) {
        var done = false;
        var timer = setTimeout(function() {
          if (done) return; done = true;
          TileAPI.off('compute:byokResult', handler);
          resolve({ success: false, timeout: true });
        }, 6000);
        var handler = function(data) {
          if (done) return; done = true;
          clearTimeout(timer);
          TileAPI.off('compute:byokResult', handler);
          resolve(data || { success: false });
        };
        TileAPI.on('compute:byokResult', handler);
        TileAPI.sendToHost('cloudComputeSetByok', { mode: (mode === 'byok' ? 'byok' : 'proxy') });
      });
    },

    // 用户本地的 BYOK 开关 (storage: connection.grs.use_byok)
    //   默认 true (历史行为: 填了 key 就用 BYOK)
    //   false = 强制走 proxy 子 key 模式, 即使本地填了 key 也不用
    //   说明: 这个开关只影响"路由决策", 不影响 server 端的 compute.mode
    //         server 端 mode 仍由 setByok() 控制 (主要影响余额展示/审计)
    isUserByokActive: function() {
      // 用户填了 key 且没明确关掉 = BYOK
      var key = TileAPI.storage.get('connection.grs.key');
      if (!key) return false;
      var pref = TileAPI.storage.get('connection.grs.use_byok');
      return pref !== false;
    },

    setUserByokPreference: function(useByok) {
      TileAPI.storage.set('connection.grs.use_byok', !!useByok);
      TileAPI.emit('compute:byokPrefChanged', { use_byok: !!useByok });
    },

    // 内部: 把 host 拉到的结构写到 state 并广播事件
    _applyResult: function(data) {
      if (!data) return;
      var mode = data.mode || 'proxy';
      var key = data.key || '';
      var status = data.key_status || (data.success ? 'ok' : '');
      _state['compute.mode']       = mode;
      _state['compute.key']        = key;
      _state['compute.status']     = status;
      _state['compute.cap']        = (typeof data.cap === 'number') ? data.cap : 0;
      _state['compute.balance']    = (typeof data.balance === 'number') ? data.balance : 0;
      _state['compute.lastSyncAt'] = data.last_sync_at || data.lastSyncAt || '';
      _state['compute.expiresAt']  = data.expires_at || data.expiresAt || '';
      TileAPI.emit('compute:keyUpdated', TileAPI.compute.getState());
    },

    // 由 app.js 在初始化时调一次, 把跨场景的 host → state 桥接好
    _bootstrapHostBridge: function() {
      if (!window._messageBridge) return;
      // 主路: host 主动推 compute key 状态 (登录后/充值后/手动 sync 后)
      window._messageBridge.onHostMessage('cloudComputeKeyResult', function(data) {
        TileAPI.compute._applyResult(data);
      });
      // sync / byok 仅触发自定义事件, 走 Promise 路径
      window._messageBridge.onHostMessage('cloudComputeSyncResult', function(data) {
        TileAPI.emit('compute:syncResult', data);
        // sync 之后 host 也会推 cloudComputeKeyResult, 这里不重复写 state
      });
      window._messageBridge.onHostMessage('cloudComputeByokResult', function(data) {
        TileAPI.emit('compute:byokResult', data);
      });
      window._messageBridge.onHostMessage('cloudComputeRefillResult', function(data) {
        TileAPI.emit('compute:refillResult', data);
        // 续杯成功的话 host 也会推 cloudComputeKeyResult 校准, 不在这写
        // Stage 7 风控: 触发上限/限流/熔断时给用户一个友好提示 (errno=10 或 paused/throttled 为 true)
        try {
          if (data && data.errno === 10 && data.info) {
            TileAPI.toast(data.info, 'warn');
          } else if (data && (data.paused || data.throttled)) {
            var msg = data.paused
              ? '今日算力额度已用满, 明日 0 点自动恢复'
              : '触发短时限流, 稍等一会再发图';
            TileAPI.toast(msg, 'warn');
          }
        } catch(_){}
      });
      // 登录/恢复会话/离线登录的结果里如果带了 compute, 也走同一条路径
      window._messageBridge.onHostMessage('cloudLoginResult', function(data) {
        if (data && data.compute) TileAPI.compute._applyResult(data.compute);
      });
      window._messageBridge.onHostMessage('cloudRestoreResult', function(data) {
        if (data && data.compute) TileAPI.compute._applyResult(data.compute);
      });
      window._messageBridge.onHostMessage('cloudLogoutResult', function() {
        // 登出清空
        TileAPI.compute._applyResult({ mode: 'proxy', key: '', key_status: '', cap: 0, balance: 0 });
      });
    }
  },
};

// 算力品牌标签: BYOK → "GRS"; 代理 → "夏三七"/"夏"; 未登录 → 由 hideWhenAnon 决定空或 GRS
// 用法: TileAPI.computeBrand({short:true, hideWhenAnon:true})
// 切模式时各 tile 监听 'compute:keyUpdated' 重渲, 标签自动跟着变
TileAPI.computeBrand = function(opts) {
  opts = opts || {};
  if (!TileAPI.compute || !TileAPI.compute.isUserByokActive) return opts.hideWhenAnon ? '' : 'GRS';
  // 用 loggedIn 而不是 pointsReady: 后者要等 cloud 磁贴的积分查询完成才 true,
  // 但代理用户可能根本没展开过 cloud 磁贴, pointsReady 永远 false, 品牌就退化成 GRS.
  var loggedIn = !!TileAPI.state.get('cloud.loggedIn');
  if (!loggedIn) return opts.hideWhenAnon ? '' : 'GRS';
  if (TileAPI.compute.isUserByokActive()) return 'GRS';
  return opts.short ? '夏' : '夏三七';
};

// ============================================================
// 算力槽位显示名 (阶段2/3 共享): 用户在顶栏「🎛 算力槽位自定义」改过格子名就用它,
// 否则回退 fallback (各调用处传自己的默认: 'AJI' / computeBrand() / '其他'|'Others')。
// 名字在保存时已去掉 < > (见 tile-topbar 保存逻辑), 所以这里返回的串可安全进 HTML 文本。
// 切模式时 grs 的 fallback=computeBrand() 仍随模式变 (未改名才生效)。
// ============================================================
TileAPI.slotLabel = function(engine, fallback) {
  var slots = (TileAPI.state && TileAPI.state.get('compute.slots')) || [];
  for (var i = 0; i < slots.length; i++) {
    if (slots[i] && slots[i].engine === engine) {
      var n = (slots[i].name || '').trim();
      if (n) return n;
      break;
    }
  }
  return (fallback != null) ? fallback : engine;
};

// 槽位缩略名 (阶段4 窄处): 改过名取名字首字, 否则用 fallback (引擎徽章等极窄处用)。
TileAPI.slotShort = function(engine, fallback) {
  var slots = (TileAPI.state && TileAPI.state.get('compute.slots')) || [];
  for (var i = 0; i < slots.length; i++) {
    if (slots[i] && slots[i].engine === engine) {
      var n = (slots[i].name || '').trim();
      if (n) return n.charAt(0);
      break;
    }
  }
  return (fallback != null) ? fallback : engine;
};

// 当前算力来源只有一个权威键: params.provider。connection.provider 仅作为
// 老版本兼容镜像，所有入口都必须通过这里同步，避免界面和实际生成分叉。
TileAPI.getProvider = function() {
  return TileAPI.state.get('params.provider')
    || TileAPI.storage.get('params.provider')
    || TileAPI.storage.get('connection.provider')
    || 'aji';
};
TileAPI.setProvider = function(provider, opts) {
  opts = opts || {};
  provider = String(provider || 'aji');
  var allowed = ['aji', 'grs', 'momo', 'others'];
  if (allowed.indexOf(provider) < 0) provider = 'aji';
  var changed = TileAPI.getProvider() !== provider;
  TileAPI.state.set('params.provider', provider);
  TileAPI.storage.set('params.provider', provider);
  TileAPI.storage.set('connection.provider', provider); // 兼容尚未迁移的读取方
  if (!opts.silent && changed) {
    TileAPI.emit('params:providerChanged', { provider: provider, source: opts.source || '' });
    TileAPI.emit('settings:providerChanged', { provider: provider, source: opts.source || '' });
  }
  return provider;
};

// 槽位顺序 · 全部 (含隐藏的第4格): 返回 4 个标准引擎(用户调过序就按其序), 去重/去脏数据。
// 引入 momo(墨墨) 后共 4 个算力, 但顶栏/参数只显示前 3 个(见 slotOrder)。
// 配置面板 / 算力账单 等"要管全部算力"的地方用本函数; 渲染 provider 选项的地方用 slotOrder(只前3)。
// 补齐缺失引擎时: momo 插在 others 之前(保证 momo 默认进可见区、others 退到隐藏的第4格)。
var _SLOT_CANON = { aji: 1, grs: 1, momo: 1, others: 1 };
TileAPI.slotOrderAll = function() {
  var slots = (TileAPI.state && TileAPI.state.get('compute.slots')) || [];
  var order = [], seen = {};
  for (var i = 0; i < slots.length; i++) {
    var e = slots[i] && slots[i].engine;
    if (_SLOT_CANON[e] && !seen[e]) { order.push(e); seen[e] = 1; }
  }
  // 补齐缺的: aji/grs/momo 若缺, 插到 others 之前(others 永远殿后=隐藏第4格)
  ['aji', 'grs', 'momo'].forEach(function(e) {
    if (seen[e]) return;
    var oi = order.indexOf('others');
    if (oi === -1) order.push(e); else order.splice(oi, 0, e);
    seen[e] = 1;
  });
  if (!seen.others) { order.push('others'); seen.others = 1; }
  return order;
};

// 槽位顺序 · 可见 (前 3 个): 顶栏标签、参数磁贴 provider 按钮、各磁贴算力选项都按它循环。
// 第 4 个(默认 others)不在此列 → 自动从所有界面隐藏; 但仍是合法 provider(老预设/历史回放/Dock 轮到照常出图)。
TileAPI.slotOrder = function() {
  return TileAPI.slotOrderAll().slice(0, 3);
};

// ============================================================
// 任务徽章 (引擎短码 + 内容类型图标)
// 运行中任务和历史记录共用同一套徽章, 任何一边新增 kind 都自动两边同步
// ============================================================
// 任务种类识别: taskId 前缀 > c.engine > 默认 banana
var _TASK_KIND_ICON = {
  tiled: '🔲',
  poster: '📰',
  colorgrade: '🎨',
  light: '💡',
  scene: '🎬',
  camera: '📷',
  comfyui: '⚙️',
  kao: '🍑'
};
TileAPI.taskBadge = {
  kindOf: function(tid, c) {
    var id = String(tid || '');
    if (id.indexOf('tiled_') === 0) return 'tiled';
    if (id.indexOf('light_') === 0) return 'light';
    if (id.indexOf('scene_') === 0) return 'scene';
    if (id.indexOf('cam_') === 0) return 'camera';
    if (id.indexOf('cg_') === 0) return 'colorgrade';
    if (id.indexOf('comfy_') === 0) return 'comfyui';
    if (id.indexOf('kao_') === 0) return 'kao';
    if (c) {
      if (c.engine === 'forge') return 'forge';
      if (c.engine === 'poster') return 'poster';
      if (c.engine === 'comfyui') return 'comfyui';
    }
    return 'banana';
  },
  renderHtml: function(kind, c) {
    var engCode, engCls, engTitle;
    if (kind === 'forge') { engCode = 'F'; engCls = 'task-engine-forge'; engTitle = 'Forge img2img'; }
    else if (kind === 'tiled') { engCode = 'T'; engCls = 'task-engine-tiled'; engTitle = '分块放大'; }
    else {
      var prov = (c && c.provider) || TileAPI.state.get('params.provider') || 'aji';
      if (prov === 'grs') { engCode = TileAPI.slotShort('grs', TileAPI.computeBrand({ short: true })); engCls = 'task-engine-grs'; engTitle = TileAPI.slotLabel('grs', TileAPI.computeBrand()); }
      else if (prov === 'others') { engCode = TileAPI.slotShort('others', 'O'); engCls = 'task-engine-others'; engTitle = TileAPI.slotLabel('others', 'Others'); }
      else if (prov === 'momo') { engCode = TileAPI.slotShort('momo', '墨'); engCls = 'task-engine-momo'; engTitle = TileAPI.slotLabel('momo', '墨墨'); }
      else { engCode = TileAPI.slotShort('aji', 'Aji'); engCls = 'task-engine-banana'; engTitle = TileAPI.slotLabel('aji', 'AJI'); }
    }
    var html = '<span class="task-engine-badge ' + engCls + '" title="' + engTitle + '">' + engCode + '</span>';
    var icon = _TASK_KIND_ICON[kind];
    if (icon) html += '<span class="task-kind-icon" title="' + kind + '">' + icon + '</span>';
    return html;
  }
};

window.TileAPI = TileAPI;
})();
