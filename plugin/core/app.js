/**
 * app.js — 启动入口
 *
 * 新启动流程(2026-04 重排):
 *   消息桥/主题/磁贴引擎 init
 *   → 注册所有后端消息监听(含 storageLoaded / log / 全局转发 等)
 *   → sendToHost('ready')
 *   → 等 storage 就绪
 *   → 显示欢迎页(公告加载 + 用户点按钮)
 *   → loadTileModules() 加载所有磁贴(只在欢迎页关闭后才做)
 *   → 分组渲染 → 主界面出现
 *
 * 这样可避免"主界面闪一下再弹欢迎页"的视觉问题。
 */
(function() {
'use strict';

var TILE_LOAD_TIMEOUT_MS = 15000;

// tile-welcome.js 已经在 panel.html 硬编码加载了,扫描时跳过,避免重复执行
var TILE_SKIP_LIST = ['tile-welcome.js'];

// 等后端回 tilesList，然后动态注入 <script>/<link> 标签
function loadTileModules() {
  return new Promise(function(resolve) {
    var done = false;
    var timer = setTimeout(function() {
      if (done) return;
      done = true;
      console.warn('[App] scanTiles 超时，继续启动');
      resolve();
    }, TILE_LOAD_TIMEOUT_MS);

    window._messageBridge.onHostMessage('tilesList', function(data) {
      if (done) return;
      done = true;
      clearTimeout(timer);

      var jsFiles = ((data && data.jsFiles) || []).filter(function(n) {
        return TILE_SKIP_LIST.indexOf(n) < 0;
      });
      var cssFiles = ((data && data.cssFiles) || []).filter(function(n) {
        // tile-welcome.css 也已在 panel.html 硬编码
        return n !== 'tile-welcome.css';
      });

      if (data && data.error) {
        console.error('[App] tilesList 错误:', data.error);
      }
      console.log('[App] 待加载磁贴: ' + jsFiles.length + ' 个 JS, ' + cssFiles.length + ' 个 CSS');

      // 先注入 CSS（不阻塞 JS 加载）
      cssFiles.forEach(function(name) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'tiles/' + name;
        document.head.appendChild(link);
      });

      // JS 按顺序加载
      var idx = 0;
      function loadNext() {
        if (idx >= jsFiles.length) { resolve(); return; }
        var name = jsFiles[idx++];
        var s = document.createElement('script');
        s.src = 'tiles/' + name;
        s.onload = function() { loadNext(); };
        s.onerror = function() {
          console.error('[App] 磁贴加载失败: ' + name);
          loadNext();
        };
        document.body.appendChild(s);
      }
      loadNext();
    });

    window._messageBridge.sendToHost('scanTiles');
  });
}

// 等 storageLoaded 消息(只等一次)
function waitForStorage() {
  return new Promise(function(resolve) {
    var done = false;
    var timeout = setTimeout(function() {
      if (done) return;
      done = true;
      console.warn('[App] storageLoaded 超时,继续启动');
      resolve();
    }, 10000);

    window._messageBridge.onHostMessage('storageLoaded', function(data) {
      if (done) return;
      done = true;
      clearTimeout(timeout);

      window._storageManager.loadAll(data);
      try { window._storageManager.migrateFromLegacy(); } catch(e) {}
      // 静默升级: < 3600s 的 params.timeout 拉到 3600 (超时 UI 已移除, 值统一拉满)
      try {
        var oldTo = +window._storageManager.get('params.timeout');
        if (!oldTo || oldTo < 3600) {
          window._storageManager.set('params.timeout', 3600);
        }
      } catch (e) {}
      // 全局兜底: GRS 默认地址必须在所有磁贴 onStorageLoaded 之前就位,
      // 否则 tile-settings 比 tile-poster 后加载, poster 的 _getProviderConnection
      // 第一次读 connection.grs.url 会拿到空, 误判"未配置"
      try {
        if (!window._storageManager.get('connection.grs.url')) {
          window._storageManager.set('connection.grs.url', 'https://grsai.dakka.com.cn');
        }
      } catch (e) {}
      window.ThemeEngine.restore();

      // 通知所有已注册的磁贴(此刻只有 tile-welcome,因为其他磁贴还没加载)
      var tiles = TileAPI.getAllTiles();
      tiles.forEach(function(tileDef) {
        if (tileDef.onStorageLoaded) {
          try { tileDef.onStorageLoaded(TileAPI.storage); } catch(e) {}
        }
      });
      TileAPI.emit('app:storageLoaded', {});

      resolve();
    });
  });
}

function startApp() {
  // 1. 消息桥 + 主题引擎 + 磁贴引擎 init
  window._messageBridge.init();
  window.ThemeEngine.init();
  window.TileEngine.init();

  // 1.5  GRS 算力: 桥接 host 消息 → TileAPI.state, 让所有磁贴用 TileAPI.compute.* 拿 key
  if (window.TileAPI && window.TileAPI.compute && typeof window.TileAPI.compute._bootstrapHostBridge === 'function') {
    window.TileAPI.compute._bootstrapHostBridge();
  }

  // 2. 启动全局消息转发(让 tile-welcome 能收到 cloudAnnouncementResult)
  _installGlobalMessageForwarders();

  // 3. 后端消息:ready → 等 storage → 欢迎页 → 加载磁贴 → 渲染主界面
  window._messageBridge.sendToHost('ready');

  waitForStorage()
    .then(function() {
      // Emoji 图片化: storage 就绪后按保存的风格初始化(observer 提前挂, 后续磁贴渲染自动替换)
      if (window.EmojiPack) { try { window.EmojiPack.init(); } catch (e) {} }
      // 改进计划许可对话框 — 先于欢迎页, 用户处理完才继续
      // (没勾 + 不在 snooze 期 才弹)
      if (window._telemetry && typeof window._telemetry.showOptInDialogIfNeeded === 'function') {
        return window._telemetry.showOptInDialogIfNeeded();
      }
    })
    .then(function() {
      // 欢迎页阻塞等待
      if (window._welcomeOverlay && window._welcomeOverlay.showAndWait) {
        return window._welcomeOverlay.showAndWait();
      }
      // 兜底:没有欢迎页模块 — 遮罩淡出后再移除, 不硬切
      var overlay = document.getElementById('bootOverlay');
      if (overlay && overlay.parentNode) {
        overlay.style.transition = 'opacity 0.35s ease';
        overlay.style.opacity = '0';
        setTimeout(function() {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }, 380);
      }
    })
    .then(function() {
      // 用户点完"开始使用" → 加载磁贴
      return loadTileModules();
    })
    .then(function() {
      continueBoot();
    });
}

// 所有全局监听(在欢迎页之前就要挂,否则错过消息)
function _installGlobalMessageForwarders() {
  // 后端日志
  window._messageBridge.onHostMessage('log', function(data) {
    if (window.TileAPI) TileAPI.log(data.message || data.msg, data.type);
  });

  // pong
  window._messageBridge.onHostMessage('pong', function() {});

  // 用户改进计划 — host 端任务完成时通过这里转给 panel 的 telemetry 模块
  window._messageBridge.onHostMessage('telemetryTask', function(data) {
    if (window._telemetry && typeof window._telemetry.trackTask === 'function') {
      try { window._telemetry.trackTask(data || {}); } catch(_) {}
    }
  });

  // 用户改进计划 — host 端报错时通过这里转给 panel 的 telemetry 模块 (msg 在 trackError 入口自动脱敏)
  window._messageBridge.onHostMessage('telemetryError', function(data) {
    if (!data) return;
    if (window._telemetry && typeof window._telemetry.trackError === 'function') {
      try { window._telemetry.trackError(data.category || 'unknown', data.step || '', data.msg || ''); } catch(_) {}
    }
  });

  // 音效播放:任务完成触发的 playSound 和设置内试听触发的 forcePlaySound
  // playSound 尊重 sound.enabled(默认开,仅当用户显式关闭才静音),forcePlaySound 强制播放(预览)
  // Audio 对象复用避免内存泄漏(对齐 v5.4.6 的 _reusableAudio / _previewAudio 行为)
  var _reusableAudio = null;
  window._messageBridge.onHostMessage('playSound', function(data) {
    if (!data || !data.base64) return;
    // sound.enabled === false 才静音,未设置/未知值 → 默认开
    if (window.TileAPI && TileAPI.storage.get('sound.enabled') === false) return;
    try {
      if (_reusableAudio) { _reusableAudio.pause(); _reusableAudio.src = ''; }
      _reusableAudio = new Audio('data:audio/mp3;base64,' + data.base64);
      _reusableAudio.play();
    } catch(e) {}
  });
  var _previewAudio = null;
  window._messageBridge.onHostMessage('forcePlaySound', function(data) {
    if (!data || !data.base64) return;
    try {
      if (_previewAudio) { _previewAudio.pause(); _previewAudio.src = ''; }
      _previewAudio = new Audio('data:audio/mp3;base64,' + data.base64);
      _previewAudio.play();
    } catch(e) {}
  });

  // 面板右上角 ••• 飞出菜单的 5 个动作
  // index.js 的 invokeMenu 把点击转成 sendToPanel('flyoutAction',{action}) 发到这里
  window._messageBridge.onHostMessage('flyoutAction', function(data) {
    if (!data || !data.action || !window.TileAPI) return;
    switch (data.action) {
      case 'flyout-update': TileAPI.expandTile('update'); break;
      case 'flyout-log':    TileAPI.expandTile('log');    break;
      case 'flyout-info':   TileAPI.expandTile('info');   break;
      case 'flyout-reload': location.reload();            break;
      case 'flyout-reset':
        TileAPI.confirm('确定重置布局吗?\n会把所有磁贴恢复到默认排列(只动排布, 不影响你的设置和内容)。').then(function(ok) {
          if (!ok) return;
          TileAPI.storage.remove('__tile_layout_v6');
          location.reload();
        });
        break;
    }
  });

  // 卫星插件命令路由 (轮椅遥控器 v2)
  // host/ipc.js 把 command.json 里的命令转 sendToPanel('ipcCommand', {action,data})
  // 这里把它转成主插件已有的事件/动作, 让卫星跟主插件按钮等价
  window._messageBridge.onHostMessage('ipcCommand', function(data) {
    if (!data || !data.action || !window.TileAPI) return;
    var act = data.action;
    var payload = data.data || {};
    console.log('[satellite-cmd]', act, payload);
    try {
      switch (act) {
        case 'triggerRun':
          // 等价于 tile-run 的"开始生成"按钮 (内部含校验/参数读取)
          TileAPI.emit('run:start');
          break;
        case 'triggerAddToBatch':
          TileAPI.emit('run:addToBatch');
          break;
        case 'triggerAddRefImage':
          TileAPI.sendToHost('captureRefImage', {});
          break;
        case 'earlyStop':
          TileAPI.sendToHost('earlyStop', {});
          break;
        case 'earlyStopTask':
          if (payload.taskId) TileAPI.sendToHost('earlyStopTask', { taskId: payload.taskId });
          break;
        case 'extendTimeout':
          // 跟 tile-tasks 的"+10"按钮等价: 前端 meta 写 + 后端 fetch timeout 延长 (双写)
          var extSec = payload.seconds || 10;
          if (payload.taskId) {
            var meta = TileAPI.state.get('tasks.meta') || {};
            if (meta[payload.taskId]) {
              meta[payload.taskId].countdown = (meta[payload.taskId].countdown || 0) + extSec;
              TileAPI.state.set('tasks.meta', meta);
            }
            TileAPI.sendToHost('extendTimeout', { seconds: extSec, taskId: payload.taskId });
          } else {
            // 没指定 taskId, 全局延长所有任务
            var metaG = TileAPI.state.get('tasks.meta') || {};
            Object.keys(metaG).forEach(function(tid) {
              metaG[tid].countdown = (metaG[tid].countdown || 0) + extSec;
            });
            TileAPI.state.set('tasks.meta', metaG);
            TileAPI.sendToHost('extendTimeout', { seconds: extSec });
          }
          break;
        case 'returnTaskResult':
          if (payload.taskId) TileAPI.sendToHost('returnTaskResult', { taskId: payload.taskId });
          break;
        case 'setTaskAutoReturn':
          if (payload.taskId != null) TileAPI.sendToHost('setTaskAutoReturn', { taskId: payload.taskId, autoReturn: !!payload.autoReturn });
          break;
        case 'soloLayer':
          // 卫星点缩略图 → 走现成 conversationLayerVisibility (mode=solo|restore)
          if (payload.mode && Array.isArray(payload.ownedLayerIDs)) {
            TileAPI.sendToHost('conversationLayerVisibility', {
              mode: payload.mode,
              docId: payload.docId,
              ownedLayerIDs: payload.ownedLayerIDs,
              soloLayerID: payload.soloLayerID
            });
          }
          break;
        case 'gotoLayerMask':
          // 卫星点白方块: 跳到 PS, 选中 layer 父组, 激活蒙版, 设选区, 拍到前面
          if (payload.layerID != null) {
            TileAPI.sendToHost('gotoLayerMask', {
              layerID: payload.layerID,
              docId: payload.docId,
              expandPx: payload.expandPx != null ? +payload.expandPx : 2
            });
          }
          break;
        case 'satelliteDiag':
          if (TileAPI.log) {
            if (payload.msg) {
              TileAPI.log('[卫星·诊断] ' + payload.msg, 'info');
            } else {
              TileAPI.log('[卫星·诊断·握手] 卫星实际 IPC 路径=' + (payload.ipcDir || '?') + ' 卫星 ID=' + (payload.satId || '?'), 'info');
            }
          }
          break;
        case 'setParam':
          // 卫星调参数 → 主插件参数 state 同步 (双向)
          if (payload.key) {
            var k = payload.key;
            var v = payload.value;
            if (k === 'provider' && TileAPI.setProvider) TileAPI.setProvider(v, { source: 'satellite' });
            else TileAPI.state.set('params.' + k, v);
            try {
              if (k === 'provider' || k === 'aspectRatio' || k === 'antiMode') {
                TileAPI.storage.set('params.' + k, v);
              }
            } catch (_) {}
            try {
              if (k === 'provider') {
                if (!TileAPI.setProvider) TileAPI.emit('params:providerChanged', { provider: v });
              }
              if (k === 'antiMode') {
                TileAPI.sendToHost('updateSettings', { antiMode: +v });
              }
            } catch (_) {}
            // 通知主插件参数磁贴展开面板重渲 (它自己只在 click 时重渲, 状态变它不主动刷)
            try { TileAPI.emit('params:remoteChanged', { key: k, value: v }); } catch (_) {}
          }
          break;
        case 'clearThumbs':
          // (相当于"我不再关心这些图层", 卫星缩略图自动消失, 不影响 PS)
          (function() {
            try {
              var raw = TileAPI.storage.get('conversation.messages');
              if (!raw) return;
              var msgs = (typeof raw === 'string') ? JSON.parse(raw) : raw;
              if (!Array.isArray(msgs)) return;
              var changed = false;
              for (var mi = 0; mi < msgs.length; mi++) {
                var mm = msgs[mi];
                if (!mm.items) continue;
                for (var ii = 0; ii < mm.items.length; ii++) {
                  var iit = mm.items[ii];
                  if (iit && iit.layerID != null && !iit.layerLost) {
                    iit.layerLost = true;
                    changed = true;
                  }
                }
              }
              if (changed) {
                TileAPI.storage.set('conversation.messages', JSON.stringify(msgs));
                // 触发 conversation 磁贴重渲 (它监听了 storage 变化)
                if (TileAPI.emit) TileAPI.emit('conversation:updated');
              }
            } catch (e) { console.warn('[satellite] clearThumbs fail:', e); }
          })();
          break;
        case 'clearGroup':
          // 删一组 (同 msgId 的所有 layerID 标 layerLost)
          (function() {
            try {
              var targetMsgId = payload.msgId;
              if (!targetMsgId) return;
              var raw = TileAPI.storage.get('conversation.messages');
              if (!raw) return;
              var msgs = (typeof raw === 'string') ? JSON.parse(raw) : raw;
              if (!Array.isArray(msgs)) return;
              var changed = false;
              for (var mi = 0; mi < msgs.length; mi++) {
                var mm = msgs[mi];
                if (mm.id !== targetMsgId || !mm.items) continue;
                for (var ii = 0; ii < mm.items.length; ii++) {
                  var iit = mm.items[ii];
                  if (iit && iit.layerID != null && !iit.layerLost) {
                    iit.layerLost = true;
                    changed = true;
                  }
                }
                break;
              }
              if (changed) {
                TileAPI.storage.set('conversation.messages', JSON.stringify(msgs));
                if (TileAPI.emit) TileAPI.emit('conversation:updated');
              }
            } catch (e) { console.warn('[satellite] clearGroup fail:', e); }
          })();
          break;
        default:
          console.warn('[satellite-cmd] 未知命令:', act);
      }
    } catch (e) {
      console.error('[satellite-cmd] 命令处理失败:', act, e);
    }
  });

  // PS 事件失效通知: host 监听 PS 的 delete/mergeVisible/flattenImage/mergeLayersNew 事件
  // 收到后, 把 conversation messages 里对应的 ai 气泡 layerID 标 layerLost
  // 下次 _pushSatelliteProgress 周期, _collectThumbs filter 掉, 卫星缩略图自动消失
  window._messageBridge.onHostMessage('psLayerInvalidated', function(data) {
    if (!data || !window.TileAPI) return;
    try {
      var raw = TileAPI.storage.get('conversation.messages');
      if (!raw) return;
      var msgs = (typeof raw === 'string') ? JSON.parse(raw) : raw;
      if (!Array.isArray(msgs)) return;
      var changed = false;
      var invalidateAll = (data.layerIDs === 'all');
      var idSet = {};
      if (!invalidateAll && Array.isArray(data.layerIDs)) {
        data.layerIDs.forEach(function(id) { idSet[+id] = true; });
      }
      for (var mi = 0; mi < msgs.length; mi++) {
        var mm = msgs[mi];
        if (!mm.items) continue;
        for (var ii = 0; ii < mm.items.length; ii++) {
          var iit = mm.items[ii];
          if (!iit || iit.layerID == null || iit.layerLost) continue;
          if (invalidateAll || idSet[+iit.layerID]) {
            iit.layerLost = true;
            if (mm.selectedItemIdx === ii) mm.selectedItemIdx = null;
            changed = true;
          }
        }
      }
      if (changed) {
        TileAPI.storage.set('conversation.messages', JSON.stringify(msgs));
        if (TileAPI.emit) TileAPI.emit('conversation:updated');
      }
    } catch (e) { console.warn('[psLayerInvalidated] handler fail:', e); }
  });

  // 转发所有后端消息到磁贴模块(onMessage)
  window.addEventListener('message', function(e) {
    var msg = e.data;
    if (!msg || msg.source !== 'host') return;
    if (!window.TileAPI) return;
    var tiles = TileAPI.getAllTiles();
    tiles.forEach(function(tileDef) {
      if (tileDef.onMessage) {
        try { tileDef.onMessage(msg.action, msg.data); } catch(err) {}
      }
    });
  });

  // 调试:Ctrl+Shift+D 清除所有缓存并刷新
  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      if (confirm('清除所有缓存并刷新?(调试用)')) {
        try { localStorage.clear(); } catch(err) {}
        location.reload();
      }
    }
  });

  // 卫星 IPC 状态同步
  // 把 tasks.running + tasks.meta 合并成扁平结构, 定时写到 wheelchair_ipc/state.json
  // 卫星插件 200ms 轮询读这个文件就能拿到任务进度
  // 同时收集 conversation 里有 layerID 的 ai 气泡 items, 当作"已传回"缩略图
  // 主题同步: 主插件背景图/主题色/不透明度 一并推过去, 卫星 panel 视觉跟主插件一致

  // hex 颜色亮度位移 (用于派生 accent-hover/accent-dark)
  // delta > 0 提亮, < 0 加深 (单位: 百分比 ~)
  function _shiftHexLightness(hex, delta) {
    if (!hex || hex[0] !== '#') return hex;
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    var r = parseInt(h.substr(0,2),16), g = parseInt(h.substr(2,2),16), b = parseInt(h.substr(4,2),16);
    var amt = Math.round(delta * 2.55);
    r = Math.max(0, Math.min(255, r + amt));
    g = Math.max(0, Math.min(255, g + amt));
    b = Math.max(0, Math.min(255, b + amt));
    return '#' + ('0'+r.toString(16)).slice(-2) + ('0'+g.toString(16)).slice(-2) + ('0'+b.toString(16)).slice(-2);
  }

  var _satelliteLastPayload = '';
  var _satelliteLastThumbsKey = '';
  var MAX_SAT_THUMBS = 20;

  // 从 storage 读 conversation messages, 提取最近 20 个有 layerID 的 res items
  // 返回 [{ taskId, msgId, idx, layerID, layerName, imgPath, thumbName, ts }]
  function _collectThumbs() {
    if (!window.TileAPI) return [];
    var raw = TileAPI.storage.get('conversation.messages');
    if (!raw) {
      if (!window.__satCollectLoggedNoStorage) {
        window.__satCollectLoggedNoStorage = true;
        if (window.TileAPI && TileAPI.log) TileAPI.log('[卫星·诊断] storage 里没有 conversation.messages', 'warn');
      }
      return [];
    }
    var msgs;
    try { msgs = (typeof raw === 'string') ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []); }
    catch (e) {
      if (window.TileAPI && TileAPI.log) TileAPI.log('[卫星·诊断] parse messages 失败: ' + e.message, 'error');
      return [];
    }
    if (!Array.isArray(msgs)) {
      if (window.TileAPI && TileAPI.log) TileAPI.log('[卫星·诊断] msgs 不是数组, 类型: ' + typeof msgs, 'warn');
      return [];
    }
    var collected = [];
    for (var i = msgs.length - 1; i >= 0 && collected.length < MAX_SAT_THUMBS; i--) {
      var m = msgs[i];
      if (!m || m.role !== 'ai' || !m.items) continue;
      for (var j = 0; j < m.items.length && collected.length < MAX_SAT_THUMBS; j++) {
        var it = m.items[j];
        if (!it.success || !it.imgPath || it.layerID == null || it.layerLost) continue;
        var thumbName = String(m.id || 'm').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) + '_' + j + '.jpg';
        collected.push({
          taskId: m.taskId || '',
          msgId: m.id,
          idx: j,
          layerID: it.layerID,
          layerName: it.layerName || '',
          docId: m.docId != null ? m.docId : null,
          imgPath: it.imgPath,
          thumbName: thumbName,
          ts: m.ts || 0
        });
      }
    }
    return collected;
  }

  // v6.4.9 空闲短路: 没有运行中任务 + 对话消息没动过 → 整个循环直接跳过。
  // 之前空闲时每 500ms 也在做 conversation.messages 的 JSON.parse + 全量 payload
  // stringify 比对, 纯浪费 CPU。消息变动靠 conversation.messages 的写入方在
  // storage.set 后 bump 版本号(下方 _bumpSatDirty 挂在 TileAPI.storage.set 上)。
  var _satDirty = true;   // 启动先推一次
  (function _hookStorageForSat() {
    // 包一层 storage.set: 写 conversation.messages 时标脏(卫星缩略图数据源)
    if (!window.TileAPI || !TileAPI.storage || TileAPI.storage.__satHooked) return;
    var _origSet = TileAPI.storage.set;
    TileAPI.storage.set = function(key, value) {
      if (key === 'conversation.messages') _satDirty = true;
      return _origSet.apply(this, arguments);
    };
    TileAPI.storage.__satHooked = true;
  })();

  function _pushSatelliteProgress() {
    if (!window.TileAPI) return;
    var running = TileAPI.state.get('tasks.running') || {};
    var keys = Object.keys(running);
    // 空闲短路: 无任务 且 消息没标脏 → 什么都不做(上一帧 payload 已推过)
    // 钩子没装上(异常场景)就永远当脏, 退回老行为, 不能吞更新
    var _hooked = TileAPI.storage && TileAPI.storage.__satHooked;
    if (keys.length === 0 && _hooked && !_satDirty) return;
    if (keys.length === 0) _satDirty = false;   // 本帧会推一次最终态, 之后归于安静
    var meta = TileAPI.state.get('tasks.meta') || {};
    var tasks = {};
    keys.forEach(function(tid) {
      var r = running[tid] || {};
      var m = meta[tid] || {};
      tasks[tid] = {
        label: r.presetTitle || r.promptSnippet || '生成',
        engine: r.engine || 'banana',
        model: r.model || '',
        batchSize: r.batchSize || 1,
        success: r.success || 0,
        fail: r.fail || 0,
        percent: r.percent != null ? r.percent : null,
        countdown: m.countdown != null ? m.countdown : (m.timeoutSec || 0),
        timeoutSec: m.timeoutSec || 0,
        autoReturn: !!m.autoReturn,
        awaitingReturn: !!r.awaitingReturn,
        startTime: r.startTime || 0
      };
    });
    // 缩略图列表 — 卫星拿这个数组只渲染卡片 + 文件名引用
    // 实际缩略图文件由 host 复制到 IPC thumbs/, 卫星按需 fetch
    var thumbs = _collectThumbs();
    var thumbsForState = thumbs.map(function(t) {
      return {
        thumbName: t.thumbName,
        layerID: t.layerID,
        layerName: t.layerName,
        docId: t.docId,
        msgId: t.msgId,
        idx: t.idx,
        taskId: t.taskId,
        ts: t.ts
      };
    });

    // 注: theme 不再每帧推送 (会让 state.json 含 base64 背景图, 写盘很贵)
    // 改成手动: 用户在 tile-satellite 磁贴点 "同步外观到卫星" 按钮才推一次

    // 当前生成参数 (轻量, 几个字符串/数字, 推每帧没问题)
    var params = null;
    try {
      var provider = TileAPI.state.get('params.provider') || 'aji';
      var modelsState = TileAPI.state.get('models.' + provider) || {};
      var modelKeys = Object.keys(modelsState);
      var modelList = modelKeys.map(function(k) {
        var m = modelsState[k] || {};
        return { id: k, label: m.name || k, sizes: m.sizes || [] };
      });
      var curModel = TileAPI.state.get('params.model') || '';
      var curModelDef = modelsState[curModel] || {};
      // 完整 16 项比例 (跟 tile-params.js line 768 一致)
      var allAspects = ['1:1', 'Auto', '9:16', '16:9', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '21:9', '9:21', '2:1', '1:2', '3:1', '1:3'];
      // gpt-image 模型在 4K 下只支持 16:9 / 9:16
      var curSize = TileAPI.state.get('params.size') || '2K';
      var aspects = allAspects;
      if (curModel && curModel.toLowerCase().indexOf('gpt-image') !== -1 && curSize === '4K') {
        aspects = ['16:9', '9:16'];
      }
      params = {
        provider: provider,
        model: curModel,
        size: curSize,
        aspectRatio: TileAPI.state.get('params.aspectRatio') || '1:1',
        batch: TileAPI.state.get('params.batch') || 1,
        timeout: TileAPI.state.get('params.timeout') || 3600,
        antiMode: +(TileAPI.state.get('params.antiMode') || 0),
        options: {
          providers: TileAPI.slotOrder().map(function(eng) {
            var def = eng === 'aji' ? 'AJI' : eng === 'grs' ? TileAPI.computeBrand() : 'Others';
            return { id: eng, label: TileAPI.slotLabel(eng, def) };
          }),
          models: modelList,
          sizes: curModelDef.sizes || ['1K','2K','4K'],
          aspects: aspects,
          antiModes: [
            { id: 0, label: '关' },
            { id: 1, label: '抗截断' },
            { id: 2, label: '抗截断+' }
          ]
        }
      };
    } catch (e) {}

    var payload = { ts: Date.now(), tasks: tasks, thumbs: thumbsForState, params: params };
    var serialized = JSON.stringify(payload);
    // 内容没变 = 不写 (减少磁盘 IO + 卫星不会重复刷新)
    if (serialized === _satelliteLastPayload) return;
    _satelliteLastPayload = serialized;
    try { TileAPI.sendToHost('ipcWriteState', payload); } catch(e) {}

    // 缩略图集合变了才同步文件 (避免每 200ms 都做 IO)
    var thumbsKey = JSON.stringify(thumbs.map(function(t) { return t.thumbName + '|' + t.imgPath; }));
    if (thumbsKey !== _satelliteLastThumbsKey) {
      _satelliteLastThumbsKey = thumbsKey;
      try {
        TileAPI.sendToHost('satelliteSyncThumbs', {
          items: thumbs.map(function(t) {
            return { thumbName: t.thumbName, sourcePath: t.imgPath };
          })
        });
      } catch (e) {}
    }
  }
  // 上报频率从 200ms 放宽到 500ms (省 60% 序列化/磁盘写), 仍保持亚秒级刷新, 不触发卫星掉线判断
  setInterval(_pushSatelliteProgress, 500);

  // B5: settings:changed 自动推卫星主题的监听已删 (该事件全代码 0 次 emit, 永不触发)
  //     留下 _pushSatelliteTheme 函数供 tile-satellite 磁贴按钮手动调用

  // 手动同步外观到卫星 (tile-satellite 磁贴的按钮调)
  // 不放进每 200ms 的轮询 — base64 背景图能让 state.json 涨到几 MB, 写盘狂占 CPU/IO
  window._pushSatelliteTheme = function() {
    if (!window.TileAPI) return false;
    try {
      var theme = {
        bg: '#1e1e2e',
        // appearance.opacity 主插件存 0-100, 卫星 --bg-opacity 要 0-1
        bgOpacity: ((TileAPI.storage.get('appearance.opacity') == null ? 88 : +TileAPI.storage.get('appearance.opacity')) / 100),
        accent: TileAPI.storage.get('appearance.themeColor') || '#0078d4',
        // 主插件实际 key 是 appearance.blur, 不是 bgBlur
        blur: +(TileAPI.storage.get('appearance.blur') || 16),
        // tileColorOpacity 主插件存 0-100
        tileColorOpacity: ((TileAPI.storage.get('appearance.tileColorOpacity') == null ? 10 : +TileAPI.storage.get('appearance.tileColorOpacity')) / 100),
        bgImage: TileAPI.storage.get('appearance.bgImage') || '',
        bgPosX: TileAPI.storage.get('appearance.bgPosX'),
        bgPosY: TileAPI.storage.get('appearance.bgPosY'),
        bgZoom: TileAPI.storage.get('appearance.bgZoom')
      };
      if (theme.accent) {
        theme.accentHover = _shiftHexLightness(theme.accent, 12);
        theme.accentDark = _shiftHexLightness(theme.accent, -18);
      }
      TileAPI.sendToHost('ipcWriteThemeFile', { theme: theme });
      return true;
    } catch (e) { console.warn('[satellite] pushTheme fail:', e); return false; }
  };

  // (已撤回) 之前的 2 秒 _validateSatelliteLayers 会调用 executeAsModal,
  // 每次进出 modal 让 PS 文档闪烁。改成"按需验证"——卫星点缩略图时主插件先验证一次,
  // 而不是定时验证. 副作用: 用户在 PS 里盖印后, 卫星缩略图不会自动消失,
  // 要等用户点击该缩略图时才发现 layer lost. 这是个可接受的退化.

}

function continueBoot() {
  // 此时所有磁贴已加载完,可以渲染主界面
  var vp = document.getElementById('vp');
  window.GroupManager.init(vp);
  window.GroupManager.render();
  window.GroupManager.renderTiles();

  // 布局恢复(磁贴已全部注册,可以读 storage 里的位置)
  window.TileEngine.restoreLayout();

  // 再次通知新加载进来的磁贴 onStorageLoaded(storage 此时已就绪)
  var tiles = TileAPI.getAllTiles();
  tiles.forEach(function(tileDef) {
    if (tileDef._storageLoadedNotified) return;
    if (tileDef.onStorageLoaded) {
      try { tileDef.onStorageLoaded(TileAPI.storage); } catch(e) {}
    }
    tileDef._storageLoadedNotified = true;
  });

  // 首次进入主界面:磁贴从四面八方飞到各自位置
  _animateFirstEntrance();

  // UIKit 自动增强(监听新出现的 <select>)
  if (window.UIKit && window.UIKit.enhance) {
    window.UIKit.enhance(document.body);
    var _uikObs = new MutationObserver(function(muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'SELECT') window.UIKit.bindSelect(n);
          else if (n.querySelectorAll) window.UIKit.enhance(n);
        }
      }
    });
    _uikObs.observe(document.body, { childList: true, subtree: true });
  }

  // v6.5.0 把 body 设成 user-select:none 后, 面板空白处的"按住拖动"不再被文字选中
  // 手势消费, 会漏给 PS 宿主 → PS 误判为拖拽整个插件面板(小抓手), 且 mouseup 常丢失,
  // 导致整个 PS 卡在面板拖拽态。这里统一把落在非交互区域的按压 preventDefault 掉,
  // 在插件内部消费该手势。表单控件和可选中文字(user-select:text 白名单)不拦截,
  // 磁贴拖拽/编辑模式是纯 JS 实现(监听 mousemove/mouseup), 不受 preventDefault 影响。
  document.addEventListener('mousedown', function(e) {
    var t = e.target;
    if (!t || t.nodeType !== 1) return;
    if (t.closest('input,textarea,select,button,[contenteditable],a')) return;
    try {
      var us = window.getComputedStyle(t).webkitUserSelect || window.getComputedStyle(t).userSelect;
      if (us === 'text' || us === 'auto' || us === 'all') return;   // 日志/提示词等可复制区域, 保留原生选中
    } catch (_) {}
    e.preventDefault();
    // preventDefault 会顺带取消"点空白让输入框失焦"的默认行为,
    // 而缩放数字框等靠失焦(change)提交 → 手动补一次 blur, 保持老习惯不变。
    try {
      var ae = document.activeElement;
      if (ae && ae !== document.body && ae.blur && ae.closest && ae.closest('input,textarea,select,[contenteditable]')) ae.blur();
    } catch (_) {}
  });

  TileAPI.emit('app:ready', {});

  // 启动时推一次浏览器配置(书签+寸止)给独立的「轮椅浏览器」插件, 保证用户没开过控制磁贴也能拿到
  try { if (typeof window._pushBrowserConfig === 'function') window._pushBrowserConfig(); } catch (e) {}

  // 新版默认布局迁移询问（老用户弹窗问，新用户静默）
  // 延迟到入场动画大致完成后再问，避免和动画抢注意力
  if (window._layoutMigration && typeof window._layoutMigration.run === 'function') {
    setTimeout(function() {
      try { window._layoutMigration.run(); } catch(e) { console.error('[layout-migration] error:', e); }
    }, 1200);
  }

  // v5 → v6 数据迁移（仅 API key/URL，结构不兼容的不动）
  // 再延后一点，避免与布局迁移弹窗叠加
  if (window._v5DataMigration && typeof window._v5DataMigration.run === 'function') {
    setTimeout(function() {
      try { window._v5DataMigration.run(); } catch(e) { console.error('[v5-data-migration] error:', e); }
    }, 2000);
  }

  // 6.2.5 起 AJI URL 不再让用户填, 强制清掉老 storage 里的手填值 (一次性迁移, 静默)
  if (window._ajiUrlMigration && typeof window._ajiUrlMigration.run === 'function') {
    try { window._ajiUrlMigration.run(); } catch(e) { console.error('[aji-url-migration] error:', e); }
  }

  // 布局快照引导: 单次弹窗 (storage 标记, 只弹一次). 延后最久, 避开迁移弹窗.
  try {
    if (!TileAPI.storage.get('layout.tipShown')) {
      setTimeout(function() {
        TileAPI.storage.set('layout.tipShown', true);
        TileAPI.confirm(
          '💡 小提示\n\n' +
          '点右上角 ☰ 打开「布局快照」，可以一键加载内置的\n' +
          'Comfyui / PsDlink / Banana 标准布局 试试看。\n\n' +
          '也能在那里保存和恢复你自己的布局。'
        );
      }, 3000);
    }
  } catch(e) { console.error('[layout-tip] error:', e); }

  // 启动时自动检查更新 (网络静默, 失败不打扰; 默认开, 可在更新磁贴里关掉)
  // 6 秒后再查, 让前面的入场动画 / 迁移弹窗都先过完
  if (typeof window._updateAutoCheck === 'function') {
    setTimeout(function() {
      try { window._updateAutoCheck(); } catch(e) { console.warn('[update-auto-check] error:', e); }
    }, 6000);
  }

  // 用户改进计划: 用户已勾选才启动遥测 (默认不勾, 完全自愿)
  if (window._telemetry && typeof window._telemetry.bootIfOptedIn === 'function') {
    try { window._telemetry.bootIfOptedIn(); } catch(e) { console.warn('[telemetry] boot fail:', e); }
  }
}

/**
 * 首次进入主界面的"四面八方归位"动画
 *
 * - 每个磁贴根据自己到视口中心的**角度**,选最近边缘作为飞入起点(左上磁贴从左上外飞来,等等)
 * - 按**到中心的距离**排序 stagger-delay:离中心近的先到位,远的后到位
 * - 结束状态 transform:none,完全归位,不影响后续拖拽/布局
 */
function _animateFirstEntrance() {
  var tiles = document.querySelectorAll('.tile');
  if (!tiles.length) {
    if (window.TileAPI && TileAPI.log) TileAPI.log('入场动画:未找到磁贴', 'warn');
    return;
  }

  // 等一帧让 grid 布局完成,否则 getBoundingClientRect 可能拿到 0 或未布局值
  requestAnimationFrame(function() {
    _doAnimateFirstEntrance(tiles);
  });
}

function _doAnimateFirstEntrance(tiles) {
  var vp = document.getElementById('vp') || document.body;
  var vpRect = vp.getBoundingClientRect();
  var cx = vpRect.left + vpRect.width / 2;
  var cy = vpRect.top + vpRect.height / 2;

  if (window.TileAPI && TileAPI.log) {
    TileAPI.log('入场动画开始:' + tiles.length + ' 个磁贴,中心 (' + Math.round(cx) + ',' + Math.round(cy) + ')', 'info');
  }

  var OFFSET = 260;  // 磁贴从边缘外多远飞入
  var infos = [];
  var maxDist = 0;

  tiles.forEach(function(t) {
    var r = t.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;   // 跳过未布局元素
    var tx = r.left + r.width / 2;
    var ty = r.top + r.height / 2;
    var dx = tx - cx;
    var dy = ty - cy;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > maxDist) maxDist = dist;

    // 单位化 + 放大到屏外起点
    // 如果磁贴恰好在中心,随机给一个方向,避免 0 向量
    var len = dist;
    if (len < 1) { dx = 1; dy = 1; len = Math.sqrt(2); }
    var ox = (dx / len) * OFFSET;
    var oy = (dy / len) * OFFSET;

    infos.push({ el: t, ox: ox, oy: oy, dist: dist });
  });

  if (!infos.length) {
    if (window.TileAPI && TileAPI.log) TileAPI.log('入场动画:所有磁贴都未布局', 'warn');
    return;
  }

  // 第一阶段:瞬时设初始态(transition:none 确保瞬时跳,不走过渡)
  infos.forEach(function(info) {
    info.el.classList.add('tile-fly-init');
    info.el.style.transform = 'translate(' + info.ox.toFixed(1) + 'px, ' + info.oy.toFixed(1) + 'px) scale(0.9)';
  });

  // 强制触发 reflow,确保初始态已被浏览器读取
  // (如果不做 reflow,浏览器可能合并同一帧的所有 style 变更,导致没有过渡起点)
  void tiles[0].offsetWidth;

  // 第二阶段:两次 rAF 后切到归位动画
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      var MAX_STAGGER = 300;
      infos.forEach(function(info) {
        var ratio = maxDist > 0 ? (info.dist / maxDist) : 0;
        var delay = Math.round(ratio * MAX_STAGGER);
        info.el.style.transitionDelay = delay + 'ms';
        info.el.classList.remove('tile-fly-init');
        info.el.classList.add('tile-fly-in');
        info.el.style.transform = '';
      });

      // 动画结束后清理(950ms 后)
      setTimeout(function() {
        infos.forEach(function(info) {
          info.el.classList.remove('tile-fly-in');
          info.el.style.transitionDelay = '';
          info.el.style.transform = '';
          info.el.style.willChange = '';
        });
      }, 1000);
    });
  });
}

// DOM 加载后启动
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}

})();
