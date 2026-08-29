// ============================================================
//  tile-center.js — 📮 生成中心 (对话式生成 + 运行中任务 合并, v6.5.0 二期)
//
//  "活气泡"设计: 同一个 taskId 从提交到完成只有一个气泡, 原地变身:
//    [我]提示词气泡 → [AI·生成中]活气泡(倒计时+三色进度条+停止/延时/传回切换)
//    → 完成变结果气泡(solo/放大/删除) → 待返回时气泡尾部出 [✓返回][丢弃]
//  批处理/分区: 按 batch_xxx/global_xxx 前缀聚合成"任务组气泡"防刷屏。
//
//  数据分工:
//    - 对话消息: storage 'conversation.messages' (★键名/字段不能改 — 卫星每帧直读)
//    - 运行态: state tasks.running/meta/pending (tile-tasks-service.js 常驻记账)
//  本文件只管 UI; 记账链(账单/统计/telemetry/续杯)在 tile-tasks-service.js。
// ============================================================
(function() {
'use strict';

var STORAGE_KEY = 'conversation.messages';
var MAX_MESSAGES = 50;
// taskId → { userMsgId, aiMsgId } 索引,加速合并查找
var _taskIndex = {};

// 内存中的消息列表(从 storage 加载,新消息追加)
var _messages = null;
var _activeContainer = null;
var _pendingSaves = {};        // reqId → resolve callback

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _now() { return Date.now(); }
function _uid(prefix) {
  return (prefix || 'm') + '_' + _now() + '_' + Math.random().toString(36).slice(2, 7);
}

function _loadMessages() {
  if (_messages) return _messages;
  var raw = TileAPI.storage.get(STORAGE_KEY);
  if (!raw) { _messages = []; }
  else {
    try { _messages = (typeof raw === 'string') ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []); }
    catch (_) { _messages = []; }
  }
  if (!Array.isArray(_messages)) _messages = [];
  // 重建 taskIndex(只对最近 5 分钟内的活跃任务,防止冲突)
  _taskIndex = {};
  var fiveMinAgo = _now() - 5 * 60 * 1000;
  for (var i = 0; i < _messages.length; i++) {
    var m = _messages[i];
    if (!m.taskId || (m.ts && m.ts < fiveMinAgo)) continue;
    if (!_taskIndex[m.taskId]) _taskIndex[m.taskId] = {};
    if (m.role === 'user') _taskIndex[m.taskId].userMsgId = m.id;
    else _taskIndex[m.taskId].aiMsgId = m.id;
  }
  return _messages;
}

function _saveMessages() {
  // #50: b64Fallback 是"落盘失败时的内存兜底图", 体积大且只在本次会话有意义 → 不写进 storage。
  //   用浅拷贝剥掉它再存, 不动内存里的 _messages(内存中仍能显示)。
  var toSave = (_messages || []).map(function(m) {
    if (!m || !m.items) return m;
    var hasFb = false;
    for (var i = 0; i < m.items.length; i++) { if (m.items[i] && m.items[i].b64Fallback) { hasFb = true; break; } }
    if (!hasFb) return m;
    var copy = {};
    for (var k in m) { if (Object.prototype.hasOwnProperty.call(m, k)) copy[k] = m[k]; }
    copy.items = m.items.map(function(it) {
      if (!it || !it.b64Fallback) return it;
      var ic = {};
      for (var kk in it) { if (Object.prototype.hasOwnProperty.call(it, kk) && kk !== 'b64Fallback') ic[kk] = it[kk]; }
      return ic;
    });
    return copy;
  });
  TileAPI.storage.set(STORAGE_KEY, toSave);
}

function _findById(id) {
  for (var i = 0; i < _messages.length; i++) {
    if (_messages[i].id === id) return _messages[i];
  }
  return null;
}

function _trimMessages() {
  if (_messages.length <= MAX_MESSAGES) return;
  var dropped = _messages.splice(0, _messages.length - MAX_MESSAGES);
  if (dropped.length) {
    var keepIds = _messages.map(function(m) { return m.id; });
    TileAPI.sendToHost('conversationCleanup', { keepIds: keepIds });
    // 清掉对应的 taskIndex
    dropped.forEach(function(m) {
      if (m.taskId && _taskIndex[m.taskId]) {
        if (_taskIndex[m.taskId].userMsgId === m.id) delete _taskIndex[m.taskId].userMsgId;
        if (_taskIndex[m.taskId].aiMsgId === m.id) delete _taskIndex[m.taskId].aiMsgId;
        if (!_taskIndex[m.taskId].userMsgId && !_taskIndex[m.taskId].aiMsgId) delete _taskIndex[m.taskId];
      }
    });
  }
}

// 把 base64 写到文件,等待 host 返回 nativePath
// bug #50: 原来 10 秒超时后 resolve(null), 上层 imgPath 一直空 → 气泡永远显示"保存中…"(丢图)。
//   现在超时放宽到 20 秒(磁盘慢时更宽容); 仍失败则由调用方用内存 base64 兜底渲染, 不再永久转圈。
function _saveImageToFile(msgId, kind, idx, base64) {
  return new Promise(function(resolve) {
    var reqId = _uid('save');
    _pendingSaves[reqId] = resolve;
    TileAPI.sendToHost('conversationSaveImage', { reqId: reqId, id: msgId, kind: kind, idx: idx, base64: base64 });
    setTimeout(function() {
      if (_pendingSaves[reqId]) {
        delete _pendingSaves[reqId];
        resolve(null);
      }
    }, 20000);
  });
}

function _imgSrc(nativePath) {
  if (!nativePath) return '';
  var p = nativePath.replace(/\\/g, '/');
  if (!/^file:/i.test(p)) p = 'file:///' + p.replace(/^\/+/, '');
  return p;
}

// 单条删除 — 移除消息 + 清掉它持有的图片文件
// alsoPaired: 删 user 时是否同时删配对的 ai(默认 true);删 ai 不会反过来删 user
function _removeMessage(msgId, alsoPaired) {
  var idx = -1;
  var target = null;
  for (var i = 0; i < _messages.length; i++) {
    if (_messages[i].id === msgId) { idx = i; target = _messages[i]; break; }
  }
  if (!target) return;

  // 收集要删的 ids(自己 + 可能的配对)
  var idsToRemove = [target.id];
  if (alsoPaired !== false && target.taskId && _taskIndex[target.taskId]) {
    var entry = _taskIndex[target.taskId];
    var pairedId = (target.role === 'user') ? entry.aiMsgId : null;  // 删 user 时联动删 ai;删 ai 不动 user
    if (pairedId && pairedId !== target.id) idsToRemove.push(pairedId);
  }

  // 从 _messages 移除
  _messages = _messages.filter(function(m) { return idsToRemove.indexOf(m.id) === -1; });

  // 清 _taskIndex
  if (target.taskId && _taskIndex[target.taskId]) {
    if (target.role === 'user') {
      delete _taskIndex[target.taskId].userMsgId;
      if (alsoPaired !== false) delete _taskIndex[target.taskId].aiMsgId;
    } else {
      delete _taskIndex[target.taskId].aiMsgId;
    }
    if (!_taskIndex[target.taskId].userMsgId && !_taskIndex[target.taskId].aiMsgId) {
      delete _taskIndex[target.taskId];
    }
  }

  _saveMessages();

  // 让 host 清理被删消息的所有图片文件(用 keepIds 保留剩下的)
  var keepIds = _messages.map(function(m) { return m.id; });
  TileAPI.sendToHost('conversationCleanup', { keepIds: keepIds });

  _renderIfActive();
}

// ============================================================
//  事件处理
// ============================================================
async function _onConvEvent(data) {
  if (!data || !data.type) return;
  _loadMessages();
  var taskId = data.taskId || '';

  // attach-layers: tile-*.host.js 在贴图完成后,把 layerID 列表附加到对应气泡
  // payload: { type:'attach-layers', taskId, layerIDs:[id1,id2,...], layerNames:['..',...], docId? }
  if (data.type === 'attach-layers') {
    if (!taskId || !_taskIndex[taskId] || !_taskIndex[taskId].aiMsgId) return;
    var aiMsgIdAtt = _taskIndex[taskId].aiMsgId;
    var aiMsgAtt = _findById(aiMsgIdAtt);
    if (!aiMsgAtt || !aiMsgAtt.items) return;
    var ids = data.layerIDs || [];
    var names = data.layerNames || [];
    // 把 layerID 顺序贴到 items 上(按已有 success items 的顺序)
    // v6.5.9 修复：按 imgPath/b64Fallback 存在且 success 的 item 顺序分配，
    // 不管它是否已有 layerID（可能是已删除的旧图层），新 layerID 覆盖旧的
    var assignIdx = 0;
    for (var ai = 0; ai < aiMsgAtt.items.length && assignIdx < ids.length; ai++) {
      var it = aiMsgAtt.items[ai];
      if (!it.success || (!it.imgPath && !it.b64Fallback)) continue;
      // 不再跳过已有 layerID 的 item，直接覆盖（新贴回的图层号才是准确的）
      it.layerID = ids[assignIdx];
      if (names[assignIdx]) it.layerName = names[assignIdx];
      // 清除旧的 layerLost 标记（新贴回的图层是新的，不是丢失状态）
      if (it.layerLost) delete it.layerLost;
      assignIdx++;
    }
    if (data.docId != null) aiMsgAtt.docId = data.docId;
    _saveMessages();
    _renderIfActive();
    return;
  }

  if (data.type === 'request') {
    // 同 taskId 已有用户气泡 → count++ (v6.5.6: 只更新角标文字, 不全量重渲 —
    // 批量任务每张图都发一次 request, 之前每次都刷新整个列表)
    if (taskId && _taskIndex[taskId] && _taskIndex[taskId].userMsgId) {
      var existingUser = _findById(_taskIndex[taskId].userMsgId);
      if (existingUser) {
        existingUser.count = (existingUser.count || 1) + 1;
        _saveMessages();
        _patchUserCount(existingUser);
        return;
      }
    }

    // 新建用户气泡
    var msgId = _uid('req');
    var msg = {
      id: msgId,
      role: 'user',
      ts: data.ts || _now(),
      taskId: taskId,
      provider: data.provider || '',
      model: data.model || '',
      size: data.size || '',
      aspectRatio: data.aspectRatio || '',
      prompt: data.prompt || '',
      mainPath: '',
      refPaths: [],
      count: 1
    };
    _messages.push(msg);
    if (taskId) {
      if (!_taskIndex[taskId]) _taskIndex[taskId] = {};
      _taskIndex[taskId].userMsgId = msgId;
    }

    // 同步创建配对的 AI 占位气泡 (并发场景下立刻在左侧显示"等待中")
    // 同 taskId 已有 ai 气泡就不再建,只复用 (count++ 时占位会自动多一格)
    if (!(taskId && _taskIndex[taskId] && _taskIndex[taskId].aiMsgId)) {
      var pairAiMsgId = _uid('res');
      var pairAiMsg = {
        id: pairAiMsgId,
        role: 'ai',
        ts: data.ts || _now(),
        taskId: taskId,
        items: []
      };
      _messages.push(pairAiMsg);
      if (taskId) {
        if (!_taskIndex[taskId]) _taskIndex[taskId] = {};
        _taskIndex[taskId].aiMsgId = pairAiMsgId;
      }
    }

    _trimMessages();
    _saveMessages();
    _renderIfActive();

    // 异步保存图(只保存一次,因为同 taskId 后续请求图都一样)
    var saveTasks = [];
    if (data.mainBase64) {
      saveTasks.push(_saveImageToFile(msgId, 'req', 0, data.mainBase64).then(function(p) { msg.mainPath = p; }));
    }
    if (data.refBase64s && data.refBase64s.length) {
      data.refBase64s.forEach(function(b64, i) {
        saveTasks.push(_saveImageToFile(msgId, 'ref', i + 1, b64).then(function(p) {
          if (p) msg.refPaths.push(p);
        }));
      });
    }
    if (saveTasks.length) {
      await Promise.all(saveTasks);
      _saveMessages();
      _renderIfActive();
    }
    return;
  }

  if (data.type === 'response') {
    // 找到对应的 ai 气泡(同 taskId)
    var aiMsg = null;
    var aiMsgId = null;
    if (taskId && _taskIndex[taskId] && _taskIndex[taskId].aiMsgId) {
      aiMsgId = _taskIndex[taskId].aiMsgId;
      aiMsg = _findById(aiMsgId);
    }
    if (!aiMsg) {
      // 新建
      aiMsgId = _uid('res');
      aiMsg = {
        id: aiMsgId,
        role: 'ai',
        ts: data.ts || _now(),
        taskId: taskId,
        items: []      // 每个 item: { success, imgPath?, error?, text? }
      };
      _messages.push(aiMsg);
      if (taskId) {
        if (!_taskIndex[taskId]) _taskIndex[taskId] = {};
        _taskIndex[taskId].aiMsgId = aiMsgId;
      }
      _trimMessages();
    }

    var item = { success: data.success !== false, ts: data.ts || _now() };
    if (data.text) item.text = data.text;
    if (data.late) item.late = true;   // 迟到图(停止后才回来): ⏸ 只认这个标, 不再猜任务状态
    if (!item.success) { item.error = data.error || '生成失败'; }
    aiMsg.items.push(item);
    _saveMessages();
    _renderIfActive();

    // 异步保存图(可能一次响应有多张)
    if (item.success && data.base64s && data.base64s.length) {
      var archiveIds = data.archiveIds || [];  // v6.5.9: 归档号数组(供后台完成图传回用)
      // 单张响应只取第一张作为这一项的 imgPath
      // 多张时 push 多个 item(共享 taskId 但每张独立显示)
      var firstSaved = await _saveImageToFile(aiMsgId, 'res', aiMsg.items.length - 1, data.base64s[0]);
      if (firstSaved) item.imgPath = firstSaved;
      else item.b64Fallback = data.base64s[0];   // #50: 落盘失败/超时 → 用内存 base64 兜底显示, 不永久转圈
      if (archiveIds[0]) item.archiveId = archiveIds[0];  // 保存归档号
      // 如果一次响应里有多张图(GPT 节点 n>1 等),其余 push 成额外 item
      for (var i = 1; i < data.base64s.length; i++) {
          var extraItem = { success: true, ts: data.ts || _now() };
        if (data.late) extraItem.late = true;   // 迟到标跟着每张图走
        if (archiveIds[i]) extraItem.archiveId = archiveIds[i];  // 保存归档号
        var extraIdx = aiMsg.items.length;
        aiMsg.items.push(extraItem);
        var extraSaved = await _saveImageToFile(aiMsgId, 'res', extraIdx, data.base64s[i]);
        if (extraSaved) extraItem.imgPath = extraSaved;
        else extraItem.b64Fallback = data.base64s[i];   // #50 同上
      }
      _saveMessages();
      _renderIfActive();
    }
  }
}

// ============================================================
//  渲染
// ============================================================
function _renderIfActive() {
  if (_activeContainer) _renderList(_activeContainer);
}

// ============================================================
//  英文报错自动翻译 — 已移除(2026-07-04, 太耗翻译额度)
//  历史消息里已有的 item.errorZh 仍会优先显示, 只是不再产生新翻译
// ============================================================

function _formatTime(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

// 稳健滚到底: 就地展开时面板高度是动画从 0 涨上来的, 渲染那刻 scrollHeight 还没定,
// 所以除了立即设, 再用 rAF + 一个等展开动画(~0.35s)结束的延时各补一次。
function _scrollListToBottom(listEl) {
  if (!listEl) return;
  var go = function() { listEl.scrollTop = listEl.scrollHeight; };
  go();
  requestAnimationFrame(function() { requestAnimationFrame(go); });
  setTimeout(go, 380);
}

// v6.5.5: 用户在上面翻旧记录时(离底部超过 80px), 重渲不再强拉到底 —
// 保持原滚动位置; 只有本来就贴着底部才跟随新内容。
function _renderList(container) {
  var listEl = container.querySelector('#convList');
  if (!listEl) return;
  var wasNearBottom = (listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight) < 80;
  var savedScrollTop = listEl.scrollTop;
  var hadContent = listEl.childElementCount > 0 && !listEl.querySelector('.conv-empty');
  var msgs = _loadMessages();

  if (!msgs.length) {
    listEl.innerHTML = '<div class="conv-empty">还没有任何对话<br>下次发起生成时会自动出现在这里</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (m.role === 'user') html += _renderUserBubble(m);
    else html += _renderAiBubble(m);
  }
  listEl.innerHTML = html;
  if (!hadContent || wasNearBottom) {
    _scrollListToBottom(listEl);       // 首次渲染 / 本来就在底部 → 跟随
  } else {
    listEl.scrollTop = savedScrollTop; // 正在翻旧记录 → 原地不动
  }
}

function _renderUserBubble(m) {
  // v6.5.1: 隐藏"我发送的" — 完全不渲染, 不留占位(要看的话关掉开关)
  if (_getHideUserBubbles()) return '';
  var meta = (m.provider ? m.provider.toUpperCase() : '?') + ' · ' + (m.model || '?') + ' · ' + (m.size || '');
  if (m.aspectRatio && m.aspectRatio !== 'Auto' && m.aspectRatio !== '1:1') meta += ' · ' + m.aspectRatio;

  var imagesHtml = '';
  if (m.mainPath || (m.refPaths && m.refPaths.length)) {
    imagesHtml = '<div class="conv-imgs conv-imgs-user">';
    if (m.mainPath) {
      imagesHtml += '<div class="conv-img-wrap" data-conv-fullsrc="' + _esc(_imgSrc(m.mainPath)) + '" title="主图 · 单击查看大图">' +
        '<img class="conv-img" src="' + _esc(_imgSrc(m.mainPath)) + '" loading="lazy">' +
        '<span class="conv-img-tag">主</span>' +
      '</div>';
    }
    (m.refPaths || []).forEach(function(p, i) {
      if (!p) return;
      imagesHtml += '<div class="conv-img-wrap" data-conv-fullsrc="' + _esc(_imgSrc(p)) + '" title="参考图 ' + (i + 1) + ' · 单击查看大图">' +
        '<img class="conv-img" src="' + _esc(_imgSrc(p)) + '" loading="lazy">' +
        '<span class="conv-img-tag">参</span>' +
      '</div>';
    });
    imagesHtml += '</div>';
  }

  var batchBadge = (m.count && m.count > 1) ? '<span class="conv-badge-x">×' + m.count + '</span>' : '';

  // prompt 默认折叠(超过 ~60 字才显示折叠按钮,短的直接显示)
  var promptHtml = '';
  if (m.prompt) {
    var rawLen = m.prompt.length;
    var lineCount = (m.prompt.match(/\n/g) || []).length + 1;
    var needCollapse = (rawLen > 60 || lineCount > 3);
    if (needCollapse) {
      promptHtml = '<div class="conv-text conv-text-collapsible is-collapsed" data-conv-prompt-toggle="1">' +
        '<div class="conv-text-content">' + _esc(m.prompt) + '</div>' +
        '<span class="conv-text-toggle">展开</span>' +
      '</div>';
    } else {
      promptHtml = '<div class="conv-text">' + _esc(m.prompt) + '</div>';
    }
  }

  // v6.5.0 排版: 文字右、图片左 横排(图片固定小列, 竖向省一半空间)
  return '<div class="conv-row conv-row-user">' +
    '<div class="conv-bubble conv-bubble-user">' +
      '<button class="conv-msg-del" data-conv-del="' + _esc(m.id) + '" data-conv-del-role="user" title="删除这条记录(连同 AI 回复)">×</button>' +
      '<div class="conv-meta">' + _esc(meta) + ' · ' + _formatTime(m.ts) + batchBadge + '</div>' +
      '<div class="conv-user-flex">' +
        imagesHtml +
        '<div class="conv-user-texts">' + promptHtml + '</div>' +
      '</div>' +
    '</div>' +
  '</div>';
}

// 隐藏"我的发送"开关 (记忆设置)
function _getHideUserBubbles() { return TileAPI.storage.get('center.hideUserBubbles') === true; }

// ============================================================
//  活气泡: 运行态工具 (读 tasks.running/meta, 由 tile-tasks-service 维护)
// ============================================================
function _getRunning() { return TileAPI.state.get('tasks.running') || {}; }
function _getPending() { return TileAPI.state.get('tasks.pending') || {}; }
function _getMeta() { return TileAPI.state.get('tasks.meta') || {}; }

// v6.5.0: 超时 UI 全部移除 — 活气泡显示"已用时"(升序), 不再显示倒计时/延时按钮。
// API 层保留 3600s 兜底防僵尸请求, 但用户不可见。
function _fmtElapsed(startTime) {
  var sec = Math.max(0, Math.floor((Date.now() - (startTime || Date.now())) / 1000));
  var mm = Math.floor(sec / 60), s = sec % 60;
  return (mm < 10 ? '0' : '') + mm + ':' + (s < 10 ? '0' : '') + s;
}
var COL_SUCCESS = '#4caf50', COL_FAIL = '#ff9800', COL_PENDING = '#d32f2f';
function _progGradient(tid) {
  var running = _getRunning();
  var meta = _getMeta();
  var card = running[tid];
  var m = meta[tid] || {};
  if (typeof m.progress === 'number' && m.progress >= 0 && (!card || !(card.batchSize > 0))) {
    var pct = Math.round(Math.max(0, Math.min(1, m.progress)) * 100);
    return 'linear-gradient(90deg,' + COL_SUCCESS + ' 0%,' + COL_SUCCESS + ' ' + pct + '%,' + COL_PENDING + ' ' + pct + '%,' + COL_PENDING + ' 100%)';
  }
  if (!card || card.batchSize <= 0) return 'linear-gradient(90deg,' + COL_PENDING + ' 0%,' + COL_PENDING + ' 100%)';
  var sP = (card.success / card.batchSize) * 100;
  var fP = (card.fail / card.batchSize) * 100;
  var stops = [], pos = 0;
  if (sP > 0) { stops.push(COL_SUCCESS + ' ' + pos + '%'); pos += sP; stops.push(COL_SUCCESS + ' ' + pos + '%'); }
  if (fP > 0) { stops.push(COL_FAIL + ' ' + pos + '%'); pos += fP; stops.push(COL_FAIL + ' ' + pos + '%'); }
  if (pos < 100) { stops.push(COL_PENDING + ' ' + pos + '%'); stops.push(COL_PENDING + ' 100%'); }
  return 'linear-gradient(90deg,' + stops.join(',') + ')';
}

// 批处理/分区聚合: 子任务 id 形如 batch_123_g0 / global_123_45_左上 → 取运行组前缀
function _batchPrefixOf(tid) {
  var m1 = String(tid).match(/^(batch_\d+)_g\d+/);
  if (m1) return m1[1];
  var m2 = String(tid).match(/^(global_\d+)_/);
  if (m2) return m2[1];
  return null;
}

// 消息 taskId → 运行卡 (直接命中或按批前缀命中子任务)
function _runningCardFor(taskId) {
  if (!taskId) return null;
  var running = _getRunning();
  if (running[taskId]) return { tid: taskId, card: running[taskId], grouped: false };
  // 该 taskId 是批前缀(batch_xxx): 找它的子任务们
  var subs = [];
  Object.keys(running).forEach(function(k) {
    if (_batchPrefixOf(k) === taskId) subs.push(k);
  });
  if (subs.length) return { tid: taskId, subs: subs, grouped: true };
  return null;
}

// 消息 taskId → 待返回卡
function _pendingCardFor(taskId) {
  if (!taskId) return null;
  var pending = _getPending();
  return pending[taskId] || null;
}

// 活气泡头部控制条 HTML (倒计时 + 进度条 + 停止/延时/AR切换)
function _liveBarHtml(taskId) {
  var hit = _runningCardFor(taskId);
  if (!hit) return '';
  var meta = _getMeta();
  if (hit.grouped) {
    // 任务组: 汇总子任务进度
    var totS = 0, totF = 0, totB = 0;
    var running = _getRunning();
    hit.subs.forEach(function(k) {
      var c = running[k] || {};
      totS += c.success || 0; totF += c.fail || 0; totB += c.batchSize || 1;
    });
    var gpct = totB > 0 ? Math.round(((totS + totF) / totB) * 100) : 0;
    return '<div class="conv-live-bar" data-live-task="' + _esc(taskId) + '">' +
      '<span class="conv-live-label">⏳ ' + hit.subs.length + ' 组进行中 · ' + (totS + totF) + '/' + totB + '</span>' +
      '<div class="conv-live-prog"><div class="conv-live-fill" data-live-fill="' + _esc(taskId) + '" style="width:' + gpct + '%;background:' + COL_SUCCESS + ';"></div></div>' +
      '<button class="w10-btn conv-live-btn" data-live-stop="' + _esc(taskId) + '" title="停止整批">■</button>' +
    '</div>';
  }
  var c = hit.card;
  var m = meta[hit.tid] || {};
  var isForge = c.engine === 'forge';
  var done = (c.success || 0) + (c.fail || 0);
  var arOn = (m.autoReturn === undefined) ? (TileAPI.storage.get('output.autoReturn') !== false) : !!m.autoReturn;
  return '<div class="conv-live-bar" data-live-task="' + _esc(taskId) + '">' +
    '<span class="conv-live-cd" data-live-cd="' + _esc(taskId) + '" data-live-start="' + (c.startTime || 0) + '" style="color:#ffcc80;">' + _fmtElapsed(c.startTime) + '</span>' +
    '<span class="conv-live-label" data-live-count="' + _esc(taskId) + '">' + done + '/' + (c.batchSize || 1) + '</span>' +
    '<div class="conv-live-prog"><div class="conv-live-fill" data-live-fill="' + _esc(taskId) + '" style="background:' + _progGradient(hit.tid) + ';"></div></div>' +
    (isForge ? '' : '<button class="w10-btn conv-live-btn ' + (arOn ? 'conv-ar-on' : 'conv-ar-off') + '" data-live-ar="' + _esc(taskId) + '" title="自动/手动传回">' + (arOn ? '自动' : '手动') + '</button>') +
    '<button class="w10-btn conv-live-btn" data-live-stop="' + _esc(taskId) + '" title="停止">■</button>' +
  '</div>';
}

// 待返回尾部按钮条
function _pendingBarHtml(taskId) {
  var p = _pendingCardFor(taskId);
  if (!p) return '';
  return '<div class="conv-pending-bar" data-pending-task="' + _esc(taskId) + '">' +
    '<span class="conv-pending-label">✓ ' + (p.successCount || 0) + ' 张待返回</span>' +
    '<button class="w10-btn w10-btn-accent conv-live-btn" data-pending-return="' + _esc(taskId) + '">✓ 返回 PS</button>' +
    '<button class="w10-btn conv-live-btn" data-pending-discard="' + _esc(taskId) + '">丢弃</button>' +
  '</div>';
}

function _renderAiBubble(m) {
  // 总数 N: 用户气泡 count 与任务卡 batchSize 取大 —
  // v6.5.6: batchSize 从点生成那刻就有 → 占位框一次性全出, 不再一张一张长
  var totalN = 1;
  if (m.taskId && _taskIndex[m.taskId] && _taskIndex[m.taskId].userMsgId) {
    var u = _findById(_taskIndex[m.taskId].userMsgId);
    if (u && u.count) totalN = u.count;
  }
  if (m.taskId) {
    var _rc = _getRunning()[m.taskId];
    if (_rc && _rc.batchSize > totalN) totalN = _rc.batchSize;
    var _pc = _getPending()[m.taskId];
    if (_pc && _pc.batchSize > totalN) totalN = _pc.batchSize;
  }
  var items = m.items || [];
  // 兼容老格式(没 items 字段的)
  if (!items.length && (m.imgPaths || m.text || m.error)) {
    items = [];
    if (m.imgPaths) m.imgPaths.forEach(function(p) { items.push({ success: true, imgPath: p }); });
    if (m.text) items[0] = items[0] || { success: true };
    if (m.error) items.push({ success: false, error: m.error });
  }

  var doneCount = items.length;
  var successCount = items.filter(function(x) { return x.success; }).length;
  var failCount = items.length - successCount;

  // 标题:进度 + 状态
  var progressText = doneCount + '/' + totalN;
  var titleCls = (failCount > 0 && successCount === 0) ? 'conv-bubble-error'
               : (failCount > 0) ? 'conv-bubble-mixed'
               : 'conv-bubble-ai';
  var titleIcon = (failCount > 0 && successCount === 0) ? '❌'
                : (doneCount < totalN) ? '⏳'
                : '✓';

  // 图片网格 — 包含成功的和失败的占位符
  var gridHtml = '<div class="conv-imgs">';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.success && it.imgPath) {
      var isSelected = (m.selectedItemIdx === i);
      var isLost = !!it.layerLost;
      var hasLayer = (it.layerID != null);
      var hasArchive = !!(it.archiveId);
      var hasCmTask = !!(it.cmTaskId);  // 校色完成·待传回
      // ⏸(后台完成·未贴回) v6.6.0 第二版判定: 只认 host 打的 late 标(停止后才回来的图)。
      // 第一版用"任务不在运行且无待返回"推断 — 4并发时事件时序会闪(tasks.running
      // 删卡与图回来的先后不定), 导致 ⏸ 时有时无、还把正常图误标成可传回(双贴事故)。
      // late 是 host 在图回来那一刻定死的, 不随前端状态抖动。
      var isBackgroundUnplaced = !!(it.late && hasArchive && !hasLayer);
      var dotCls = 'conv-solo-dot';
      var dotTitle;
      if (isLost) { dotCls += ' is-lost'; dotTitle = '图层已删除,无法联动'; }
      else if (isBackgroundUnplaced) { dotCls += ' is-unplaced'; dotTitle = '⏸ 未贴回 · 点击传回'; }
      else if (!hasLayer) { dotCls += ' is-pending'; dotTitle = '图层尚未就绪'; }
      else if (isSelected) { dotCls += ' is-on'; dotTitle = '当前只显示这一张 · 点击恢复全显'; }
      else { dotCls += ' is-off'; dotTitle = '点击 → PS 中只显示这张'; }
      var wrapCls = 'conv-img-wrap' + (isSelected ? ' is-solo-selected' : '') + (isBackgroundUnplaced ? ' conv-img-unplaced' : '') + (hasCmTask ? ' conv-img-cm-done' : '');
      var wrapTitle = isBackgroundUnplaced ? '点 ⏸ 圆点传回 PS · 点图查看大图' : (hasCmTask ? '点击传回校色 · 双击查看大图' : '双击查看大图 · 单击在 PS 中单独显示这张');
      gridHtml += '<div class="' + wrapCls + '" data-conv-fullsrc="' + _esc(_imgSrc(it.imgPath)) + '" data-msg-id="' + _esc(m.id) + '" data-item-idx="' + i + '" title="' + _esc(wrapTitle) + '"' + (isBackgroundUnplaced ? ' data-archive-id="' + _esc(it.archiveId) + '"' : '') + (hasCmTask ? ' data-cm-taskid="' + _esc(it.cmTaskId) + '"' : '') + '>' +
        '<img class="conv-img" src="' + _esc(_imgSrc(it.imgPath)) + '" loading="lazy">' +
        (totalN > 1 ? '<span class="conv-img-tag">' + (i + 1) + '</span>' : '') +
        '<button class="' + dotCls + '" data-conv-solo="1" title="' + _esc(dotTitle) + '">' +
          (isLost ? '✕' : (isBackgroundUnplaced ? '⏸' : (isSelected ? '●' : '○'))) +
        '</button>' +
      '</div>';
    } else if (it.success && it.b64Fallback) {
      // #50: 落盘失败/超时, 用内存 base64 兜底显示(不落盘, 不参与图层联动), 避免永久"保存中…"
      var fbSrc = 'data:image/png;base64,' + it.b64Fallback;
      gridHtml += '<div class="conv-img-wrap" data-conv-fullsrc="' + _esc(fbSrc) + '" title="单击查看大图(未落盘, 重启后消失)">' +
        '<img class="conv-img" src="' + _esc(fbSrc) + '" loading="lazy">' +
        (totalN > 1 ? '<span class="conv-img-tag">' + (i + 1) + '</span>' : '') +
      '</div>';
    } else if (it.success && !it.imgPath) {
      gridHtml += '<div class="conv-img-wrap conv-img-pending" title="保存中...">' +
        '<span class="conv-img-spinner">…</span>' +
        (totalN > 1 ? '<span class="conv-img-tag">' + (i + 1) + '</span>' : '') +
      '</div>';
    } else {
      var errStr = String(it.errorZh || it.error || '失败').slice(0, 80);
      gridHtml += '<div class="conv-img-wrap conv-img-fail" title="' + _esc(String(it.error || errStr).slice(0, 200)) + '">' +
        '<span class="conv-img-fail-icon">❌</span>' +
        (totalN > 1 ? '<span class="conv-img-tag">' + (i + 1) + '</span>' : '') +
      '</div>';
    }
  }
  // 还没回的位置占位
  for (var j = doneCount; j < totalN; j++) {
    gridHtml += '<div class="conv-img-wrap conv-img-waiting" title="等待中...">' +
      '<span class="conv-img-spinner">…</span>' +
      (totalN > 1 ? '<span class="conv-img-tag">' + (j + 1) + '</span>' : '') +
    '</div>';
  }
  gridHtml += '</div>';

  // 文本(取第一个 item 的)
  var allText = items.map(function(x) { return x.text || ''; }).filter(Boolean).join('\n').trim();
  var textHtml = allText ? '<div class="conv-text">' + _esc(allText) + '</div>' : '';

  // 错误概要(只在所有都失败时显示)
  var errorSummary = '';
  if (failCount > 0 && successCount === 0) {
    var firstErrItem = items.find(function(x) { return !x.success; }) || {};
    var firstErr = firstErrItem.errorZh || firstErrItem.error || '生成失败';
    errorSummary = '<div class="conv-text" title="' + _esc(String(firstErrItem.error || firstErr).slice(0, 300)) + '">❌ ' + _esc(String(firstErr).slice(0, 200)) + '</div>';
  }

  // 活气泡: 该 taskId 还在跑 → 头部控制条; 完成但待返回 → 尾部按钮条
  var liveBar = _liveBarHtml(m.taskId);
  var pendingBar = liveBar ? '' : _pendingBarHtml(m.taskId);
  var bubbleTitleIcon = liveBar ? '⚡' : titleIcon;

  return '<div class="conv-row conv-row-ai">' +
    '<div class="conv-bubble ' + titleCls + (liveBar ? ' conv-bubble-live' : '') + '" data-bubble-task="' + _esc(m.taskId || '') + '">' +
      '<button class="conv-msg-del" data-conv-del="' + _esc(m.id) + '" data-conv-del-role="ai" title="只删除这条 AI 回复">×</button>' +
      '<div class="conv-meta">AI · ' + _formatTime(m.ts) + ' · ' + bubbleTitleIcon + ' ' + progressText + '</div>' +
      liveBar +
      errorSummary +
      textHtml +
      gridHtml +
      pendingBar +
    '</div>' +
  '</div>';
}

// ============================================================
//  面板
// ============================================================
function _renderPanel(container) {
  _activeContainer = container;
  container.innerHTML =
    '<div class="w10-panel conv-root">' +
      '<div class="conv-head">' +
        '<div class="conv-title">📮 生成中心</div>' +
        '<div style="flex:1;"></div>' +
        '<button class="w10-btn conv-opt-btn' + (_getHideUserBubbles() ? ' w10-btn-accent' : '') + '" id="convHideUser" title="隐藏右侧我发送的气泡, 只看结果">隐藏发送</button>' +
        '<button class="w10-btn conv-opt-btn' + ((TileAPI.storage.get('output.autoReturn') !== false) ? ' w10-btn-accent' : '') + '" id="convGlobalAr" title="一键切换所有任务的自动传回">自动传回</button>' +
        '<button class="w10-btn conv-btn-folder" id="convBtnFolder" title="打开历史图片文件夹">📁</button>' +
        '<button class="w10-btn conv-btn-clear" id="convBtnClear" title="清空对话历史">🗑️</button>' +
        '<button class="w10-btn conv-btn-bottom" id="convBtnBottom" title="跳到最新消息">⬇</button>' +
      '</div>' +
      '<div class="conv-list" id="convList"></div>' +
    '</div>';

  _renderList(container);

  // 隐藏我的发送(文字按钮开关: 开=accent高亮)
  var togHide = container.querySelector('#convHideUser');
  if (togHide) togHide.addEventListener('click', function() {
    var now = !_getHideUserBubbles();
    TileAPI.storage.set('center.hideUserBubbles', now);
    togHide.classList.toggle('w10-btn-accent', now);
    _renderList(container);
  });

  // 全局自动传回(继承老任务磁贴, 同一个 storage 键 + 事件)
  var togGlobal = container.querySelector('#convGlobalAr');
  if (togGlobal) togGlobal.addEventListener('click', function() {
    var now = !(TileAPI.storage.get('output.autoReturn') !== false);
    TileAPI.storage.set('output.autoReturn', now);
    togGlobal.classList.toggle('w10-btn-accent', now);
    TileAPI.emit('output:autoReturnChanged', { value: now });
    var cur = TileAPI.state.get('tasks.meta') || {};
    var running = _getRunning();
    Object.keys(running).forEach(function(tid) {
      if (!cur[tid]) cur[tid] = {};
      cur[tid].autoReturn = now;
      TileAPI.sendToHost('setTaskAutoReturn', { taskId: tid, autoReturn: now });
    });
    TileAPI.state.set('tasks.meta', cur);
    _renderList(container);
    TileAPI.toast(now ? '已开启全部自动传回' : '已关闭全部自动传回', 'info');
  });

  var clearBtn = container.querySelector('#convBtnClear');
  if (clearBtn) clearBtn.addEventListener('click', function() {
    TileAPI.confirm('确定清空对话历史?这会同时删除所有保存的图片文件。').then(function(ok) {
      if (!ok) return;
      _messages = [];
      _taskIndex = {};
      _saveMessages();
      TileAPI.sendToHost('conversationCleanup', { keepIds: [] });
      _renderList(container);
      TileAPI.toast('已清空对话历史', 'info');
    });
  });

  var bottomBtn = container.querySelector('#convBtnBottom');
  if (bottomBtn) bottomBtn.addEventListener('click', function() {
    var listEl = container.querySelector('#convList');
    _scrollListToBottom(listEl);
  });

  var folderBtn = container.querySelector('#convBtnFolder');
  if (folderBtn) folderBtn.addEventListener('click', function() {
    TileAPI.sendToHost('conversationOpenFolder', {});
  });

  var listEl = container.querySelector('#convList');
  if (listEl) listEl.addEventListener('click', function(e) {
    // ── 活气泡控制条: 停止 / 延时 / 自动传回切换 ──
    var stopBtn = e.target.closest('[data-live-stop]');
    if (stopBtn) {
      e.stopPropagation();
      var stopTid = stopBtn.dataset.liveStop;
      var hit = _runningCardFor(stopTid);
      if (!hit) return;
      var stopOne = function(tid) {
        // GRS 续杯 ping(照老任务磁贴的停止逻辑: taskComplete 不会再来, 不 ping 会丢账)
        try {
          var rStop = _getRunning()[tid];
          if (rStop && rStop.provider === 'grs' && TileAPI.compute && TileAPI.compute.getState) {
            var byokActive = TileAPI.compute.isUserByokActive ? TileAPI.compute.isUserByokActive() : !!(TileAPI.storage.get('connection.grs.key'));
            var cs = TileAPI.compute.getState();
            if (!byokActive && cs && cs.key) {
              var attempts = (rStop.success || 0) + (rStop.fail || 0);
              var used = TileAPI.compute.estimateCost ? TileAPI.compute.estimateCost(rStop.model || '', attempts) : (1800 * attempts);
              TileAPI.compute.refill(used, attempts);
            }
          }
        } catch(_) {}
        TileAPI.sendToHost('earlyStopTask', { taskId: tid });
        var curR = _getRunning();
        if (curR[tid]) { delete curR[tid]; TileAPI.state.set('tasks.running', curR); }
        var curM = _getMeta();
        if (curM[tid]) { delete curM[tid]; TileAPI.state.set('tasks.meta', curM); }
      };
      if (hit.grouped) hit.subs.forEach(stopOne);
      else stopOne(hit.tid);
      TileAPI.emit('tasks:updated');
      TileAPI.toast('已停止任务', 'info');
      return;
    }
    // (v6.5.0: +10s 延时按钮已随超时 UI 移除)
    var arBtn = e.target.closest('[data-live-ar]');
    if (arBtn) {
      e.stopPropagation();
      var arTid = arBtn.dataset.liveAr;
      var arMeta = _getMeta();
      if (!arMeta[arTid]) arMeta[arTid] = {};
      arMeta[arTid].autoReturn = !arMeta[arTid].autoReturn;
      TileAPI.state.set('tasks.meta', arMeta);
      TileAPI.sendToHost('setTaskAutoReturn', { taskId: arTid, autoReturn: !!arMeta[arTid].autoReturn });
      arBtn.textContent = arMeta[arTid].autoReturn ? '自动' : '手动';
      arBtn.classList.toggle('conv-ar-on', !!arMeta[arTid].autoReturn);
      arBtn.classList.toggle('conv-ar-off', !arMeta[arTid].autoReturn);
      return;
    }
    // ── 待返回按钮条: ✓返回 / 丢弃 ──
    var retBtn = e.target.closest('[data-pending-return]');
    if (retBtn) {
      e.stopPropagation();
      TileAPI.sendToHost('returnTaskResult', { taskId: retBtn.dataset.pendingReturn });
      return;
    }
    var discBtn = e.target.closest('[data-pending-discard]');
    if (discBtn) {
      e.stopPropagation();
      var dTid = discBtn.dataset.pendingDiscard;
      TileAPI.sendToHost('clearTaskCache', { taskId: dTid });
      var curP = _getPending();
      delete curP[dTid];
      TileAPI.state.set('tasks.pending', curP);
      TileAPI.emit('tasks:updated');
      TileAPI.toast('已丢弃', 'info');
      return;
    }
    // ── 校色完成图传回按钮 ──
    // 点的是单显圆点时放行(否则圆点被"传回校色"截胡, 永远没法单显)
    var cmWrap = e.target.closest('.conv-img-cm-done');
    if (cmWrap && cmWrap.dataset.cmTaskid && !e.target.closest('[data-conv-solo]')) {
      e.stopPropagation();
      TileAPI.sendToHost('returnTaskResult', { taskId: cmWrap.dataset.cmTaskid });
      return;
    }
    // ── 后台完成·未贴回图传回 ──
    // 只有点 ⏸ 圆点才传回; 点图片本体放行给下面的预览逻辑(单击/双击都能看大图)。
    // 之前整张图都触发传回 → 双击放大失灵还会误贴回, 用户实测踩雷。
    var unplacedWrap = e.target.closest('.conv-img-unplaced');
    if (unplacedWrap && unplacedWrap.dataset.archiveId && e.target.closest('[data-conv-solo]')) {
      e.stopPropagation();
      var archiveId = unplacedWrap.dataset.archiveId;
      // 防连点双贴: 同一张图传回在途时, 再点无效(收到 recyclePlaceResult 才解锁)
      if (window._centerRecyclePlacing && window._centerRecyclePlacing[archiveId]) {
        TileAPI.toast('正在传回中, 别急~', 'info');
        return;
      }
      var msgId = unplacedWrap.dataset.msgId;
      var itemIdx = parseInt(unplacedWrap.dataset.itemIdx, 10);
      TileAPI.sendToHost('recyclePlaceToPS', { taskId: archiveId });
      TileAPI.toast('正在传回...', 'info');
      // 记住这次传回的 msgId 和 itemIdx，回填图层号时用
      if (!window._centerRecyclePlacing) window._centerRecyclePlacing = {};
      window._centerRecyclePlacing[archiveId] = { msgId: msgId, itemIdx: itemIdx };
      return;
    }
    // 单条删除
    var delBtn = e.target.closest('.conv-msg-del');
    if (delBtn) {
      e.stopPropagation();
      var msgId = delBtn.dataset.convDel;
      var role = delBtn.dataset.convDelRole;
      if (!msgId) return;
      // 该气泡有待返回图时先拦一下(删气泡不丢图, 但入口没了)
      var delMsg = _findById(msgId);
      var hasPending = delMsg && delMsg.taskId && _pendingCardFor(delMsg.taskId);
      var hint = hasPending
        ? '该记录还有待返回的图!\n删除后请去生成记录磁贴找回。确定删除?'
        : ((role === 'user') ? '删除这条对话记录?\n(请求 + AI 回复都会一并删除)' : '只删除这条 AI 回复?');
      TileAPI.confirm(hint).then(function(ok) {
        if (!ok) return;
        _removeMessage(msgId, role === 'user');
      });
      return;
    }
    // 提示词折叠/展开
    var promptToggle = e.target.closest('[data-conv-prompt-toggle]');
    if (promptToggle) {
      e.stopPropagation();
      var collapsed = promptToggle.classList.toggle('is-collapsed');
      var tog = promptToggle.querySelector('.conv-text-toggle');
      if (tog) tog.textContent = collapsed ? '展开' : '收起';
      return;
    }
    // solo 圆点
    var soloBtn = e.target.closest('[data-conv-solo]');
    if (soloBtn) {
      e.stopPropagation();
      var soloWrap = soloBtn.closest('.conv-img-wrap');
      if (!soloWrap) return;
      var sMid = soloWrap.dataset.msgId;
      var sIdx = parseInt(soloWrap.dataset.itemIdx, 10);
      _toggleSoloOnMsg(sMid, sIdx);
      return;
    }
    // v6.5.1 交互: 结果图 单击=PS单显, 双击=放大。
    // 判定收紧到 180ms + 单击立即执行不等待(粘滞感修复):
    // 单击先立刻单显(响应快), 180ms 内第二击再放大 — 单显是可逆操作(再点一下恢复),
    // 双击误触发一次单显的代价可接受, 换来零迟滞。
    var wrap = e.target.closest('.conv-img-wrap');
    if (!wrap) return;
    var src = wrap.dataset.convFullsrc;
    if (!src) return;
    var lbMid = wrap.dataset.msgId;
    var lbIdx = parseInt(wrap.dataset.itemIdx, 10);
    var lbMsg = lbMid ? _findById(lbMid) : null;
    var lbItem = (lbMsg && lbMsg.items) ? lbMsg.items[lbIdx] : null;
    var canSolo = !!(lbItem && lbItem.layerID != null);   // layerLost 不拦: 交给 PS 实测(自愈误标)
    if (!canSolo) {
      _showFullPreview(src, lbMid, lbIdx);
      return;
    }
    var now = Date.now();
    if (wrap._lastClickTs && (now - wrap._lastClickTs) < 300) {
      // 双击: 撤掉刚才单击造成的单显切换(再切一次=恢复), 然后放大
      wrap._lastClickTs = 0;
      _toggleSoloOnMsg(lbMid, lbIdx);   // 回滚第一击的 solo
      _showFullPreview(src, lbMid, lbIdx);
    } else {
      wrap._lastClickTs = now;
      _toggleSoloOnMsg(lbMid, lbIdx);   // 单击立即单显, 无延迟
    }
  });
}

function _showFullPreview(src, msgId, itemIdx) {
  var msg = msgId ? _findById(msgId) : null;

  // v6.5.3 防闪烁: 弹窗只建一次, ←/→ 切换只换 img.src 和工具条内容, 不销毁重建
  var sibIdxs = [];
  if (msg && msg.items) {
    for (var si = 0; si < msg.items.length; si++) {
      var it2 = msg.items[si];
      if (it2 && it2.success && (it2.imgPath || it2.b64Fallback)) sibIdxs.push(si);
    }
  }
  function _srcOf(idx) {
    var it3 = msg.items[idx];
    if (it3.imgPath) return _imgSrc(it3.imgPath);
    return 'data:image/png;base64,' + it3.b64Fallback;
  }

  var curIdx = itemIdx;
  var hasNav = sibIdxs.length > 1 && sibIdxs.indexOf(itemIdx) >= 0;

  var ov = document.createElement('div');
  ov.className = 'conv-preview-overlay';
  ov.innerHTML =
    '<div class="conv-preview-bar"></div>' +
    (hasNav ? '<button class="conv-preview-arrow conv-preview-arrow-l" data-conv-nav="-1" title="上一张 (←)">‹</button>' : '') +
    '<img>' +
    (hasNav ? '<button class="conv-preview-arrow conv-preview-arrow-r" data-conv-nav="1" title="下一张 (→)">›</button>' : '') +
    '<span class="conv-preview-close">×</span>';
  var imgEl = ov.querySelector('img');
  var barEl = ov.querySelector('.conv-preview-bar');

  // 工具条按当前张重绘(只动工具条, 图片元素不动)
  function _renderBar() {
    var item = (msg && msg.items) ? msg.items[curIdx] : null;
    var isSel = !!(msg && msg.selectedItemIdx === curIdx);
    var hasLayer = !!(item && item.layerID != null);
    var h = '';
    if (hasLayer) {
      h += '<button class="conv-preview-solo' + (isSel ? ' is-on' : '') + '" data-conv-preview-solo="1">' +
        (isSel ? '☉ 取消单显' : '◎ 在 PS 中只显示这张') + '</button>';
    }
    if (hasNav) {
      h += '<span class="conv-preview-pos">' + (sibIdxs.indexOf(curIdx) + 1) + '/' + sibIdxs.length + '</span>';
    }
    barEl.innerHTML = h;
    var soloBtn = barEl.querySelector('[data-conv-preview-solo]');
    if (soloBtn) {
      soloBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        _toggleSoloOnMsg(msgId, curIdx);
        closeAll();
      });
    }
  }

  function _show(idx) {
    curIdx = idx;
    imgEl.src = (msg && msg.items) ? _srcOf(idx) : src;
    // v6.5.7: 切换上下张保留缩放和平移(对比同批多张的同一区域细节), 不再复位
    _renderBar();
  }

  // ── v6.5.6 缩放/平移套件: 滚轮缩放(0.5x~8x, 指针为中心), 拖拽平移, 双击图片复位 ──
  var _z = 1, _tx = 0, _ty = 0;
  function _applyZoom() {
    imgEl.style.transform = 'translate(' + _tx + 'px,' + _ty + 'px) scale(' + _z + ')';
    imgEl.style.cursor = _z > 1 ? 'grab' : 'zoom-in';
  }
  function _resetZoom() { _z = 1; _tx = 0; _ty = 0; _applyZoom(); }
  ov.addEventListener('wheel', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var oldZ = _z;
    _z = Math.max(0.5, Math.min(8, _z * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    // 以指针为中心缩放: 指针相对视口中心的偏移在缩放前后保持指向同一图像点
    var cx = e.clientX - window.innerWidth / 2;
    var cy = e.clientY - window.innerHeight / 2;
    var k = _z / oldZ;
    _tx = cx - (cx - _tx) * k;
    _ty = cy - (cy - _ty) * k;
    if (_z <= 1.001 && oldZ > 1) { _resetZoom(); return; }
    _applyZoom();
  }, { passive: false });
  // 拖拽平移(放大后)
  var _dragging = false, _dx0 = 0, _dy0 = 0;
  imgEl.addEventListener('mousedown', function(e) {
    if (_z <= 1) return;
    e.preventDefault();
    _dragging = true;
    _dx0 = e.clientX - _tx;
    _dy0 = e.clientY - _ty;
    imgEl.style.cursor = 'grabbing';
  });
  ov.addEventListener('mousemove', function(e) {
    if (!_dragging) return;
    _tx = e.clientX - _dx0;
    _ty = e.clientY - _dy0;
    _applyZoom();
  });
  ov.addEventListener('mouseup', function() { _dragging = false; if (_z > 1) imgEl.style.cursor = 'grab'; });
  // 双击图片: 复位/放大2x 切换
  imgEl.addEventListener('dblclick', function(e) {
    e.stopPropagation();
    if (_z > 1) _resetZoom();
    else { _z = 2; _applyZoom(); }
  });
  // 图片单击不关闭(拖拽后松手误关很烦); 点空白遮罩才关
  imgEl.addEventListener('click', function(e) { e.stopPropagation(); });

  var closeAll = function() {
    if (ov._keyHandler) { try { document.removeEventListener('keydown', ov._keyHandler); } catch(_) {} }
    ov.remove();
  };
  var goNav = function(dir) {
    var pos = sibIdxs.indexOf(curIdx) + dir;
    if (pos < 0) pos = sibIdxs.length - 1;
    if (pos >= sibIdxs.length) pos = 0;
    _show(sibIdxs[pos]);
  };

  ov.addEventListener('click', function(e) {
    if (e.target.closest('[data-conv-preview-solo]')) return;
    if (e.target.closest('[data-conv-nav]')) return;
    if (e.target.closest('.conv-preview-bar') && !e.target.closest('button')) return;
    closeAll();
  });
  if (hasNav) {
    var navBtns = ov.querySelectorAll('[data-conv-nav]');
    for (var nb = 0; nb < navBtns.length; nb++) {
      (function(btn) {
        btn.addEventListener('click', function(e) { e.stopPropagation(); goNav(+btn.dataset.convNav); });
      })(navBtns[nb]);
    }
    ov._keyHandler = function(e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); goNav(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goNav(1); }
      else if (e.key === 'Escape') { closeAll(); }
    };
    document.addEventListener('keydown', ov._keyHandler);
  } else {
    ov._keyHandler = function(e) { if (e.key === 'Escape') closeAll(); };
    document.addEventListener('keydown', ov._keyHandler);
  }

  imgEl.src = src;   // 首张直接用传入 src(msg 为空的场景也能显示)
  _renderBar();
  document.body.appendChild(ov);
}

// ============================================================
//  图层联动: solo / restore
// ============================================================
function _toggleSoloOnMsg(msgId, itemIdx) {
  if (!msgId || isNaN(itemIdx)) return;
  var msg = _findById(msgId);
  if (!msg || !msg.items) return;
  var item = msg.items[itemIdx];
  if (!item) return;
  if (item.layerID == null) { TileAPI.toast('图层尚未就绪(贴回完成后才能单显),请稍候', 'info'); return; }
  // v6.5.3: layerLost 不再前端拦死 — 合并/拼合事件的批量作废经常误标(图层其实还在)。
  // 照样发给 PS 实测: 还在 → host 返回 applied, 上面的自愈逻辑撤销误标; 真没了 → failed 标灰。

  // 收集本气泡所有的"我创建的图层 ID"(误标的也带上, 让 PS 实测裁决)
  var ownedLayerIDs = [];
  for (var i = 0; i < msg.items.length; i++) {
    var it2 = msg.items[i];
    if (it2 && it2.layerID != null) ownedLayerIDs.push(it2.layerID);
  }
  if (!ownedLayerIDs.length) return;

  var alreadySelected = (msg.selectedItemIdx === itemIdx);
  var reqId = 'cv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

  if (alreadySelected) {
    // 取消 → restore 全显
    msg.selectedItemIdx = null;
    _saveMessages();
    _patchSoloDots(msg);   // v6.5.3: 定点更新圆点, 不全量重渲(防滚动跳动)
    TileAPI.sendToHost('conversationLayerVisibility', {
      reqId: reqId,
      mode: 'restore',
      docId: msg.docId,
      ownedLayerIDs: ownedLayerIDs
    });
  } else {
    msg.selectedItemIdx = itemIdx;
    _saveMessages();
    _patchSoloDots(msg);
    TileAPI.sendToHost('conversationLayerVisibility', {
      reqId: reqId,
      mode: 'solo',
      docId: msg.docId,
      ownedLayerIDs: ownedLayerIDs,
      soloLayerID: item.layerID
    });
  }
}

// 定点更新用户气泡的 ×N 角标(不重渲列表)
function _patchUserCount(msg) {
  if (!_activeContainer || !msg) return;
  var del = _activeContainer.querySelector('[data-conv-del="' + msg.id + '"]');
  var bubble = del ? del.closest('.conv-bubble') : null;
  if (!bubble) return;
  var meta = bubble.querySelector('.conv-meta');
  if (!meta) return;
  var badge = meta.querySelector('.conv-badge-x');
  if (badge) badge.textContent = '×' + msg.count;
  else meta.insertAdjacentHTML('beforeend', '<span class="conv-badge-x">×' + msg.count + '</span>');
}

// 定点更新某条 AI 气泡的 solo 圆点/选中框, 不动列表其它部分
function _patchSoloDots(msg) {
  if (!_activeContainer) return;
  var wraps = _activeContainer.querySelectorAll('.conv-img-wrap[data-msg-id="' + msg.id + '"]');
  for (var i = 0; i < wraps.length; i++) {
    var idx = parseInt(wraps[i].dataset.itemIdx, 10);
    var isSel = (msg.selectedItemIdx === idx);
    wraps[i].classList.toggle('is-solo-selected', isSel);
    var dot = wraps[i].querySelector('.conv-solo-dot');
    if (dot) {
      dot.classList.toggle('is-on', isSel);
      dot.classList.toggle('is-off', !isSel && !dot.classList.contains('is-pending') && !dot.classList.contains('is-lost'));
      if (!dot.classList.contains('is-pending') && !dot.classList.contains('is-lost')) {
        dot.textContent = isSel ? '●' : '○';
      }
    }
  }
}

// ============================================================
//  消息处理(host 端来的)
// ============================================================
function _onMessage(action, data) {
  if (action === 'conversationEvent') {
    _onConvEvent(data);
    return;
  }
  // 校色传回成功 → 清掉对应 item 的 cmTaskId 标记(否则"传回校色"按钮永远赖着,
  // 还会截胡单显圆点的点击); host 的 returnTaskResult 成功后发 taskReturned
  if (action === 'taskReturned') {
    if (!data || !data.taskId) return;
    _loadMessages();
    var cmCleared = false;
    for (var cmi = 0; cmi < _messages.length; cmi++) {
      var cmm = _messages[cmi];
      if (!cmm.items) continue;
      for (var cmj = 0; cmj < cmm.items.length; cmj++) {
        if (cmm.items[cmj] && cmm.items[cmj].cmTaskId === data.taskId) {
          delete cmm.items[cmj].cmTaskId;
          cmCleared = true;
        }
      }
    }
    if (cmCleared) {
      _saveMessages();
      _renderIfActive();
    }
    return;
  }
  // 回收站归档广播: status='late'(停止后才完成) 是"这张图没赶上正常传回"的权威信号 —
  // 图回气泡那刻的 late 标有极小时间窗可能漏打(停止与图落地同瞬), 这里兜底补标。
  // 归档号能对上气泡里的 item 就补 late + 重渲 → ⏸ 一定会出来, 不再有"孤儿图"。
  if (action === 'recycleNewArchived') {
    if (!data || !data.id || data.status !== 'late') return;
    _loadMessages();
    var lateFixed = false;
    for (var lmi = 0; lmi < _messages.length; lmi++) {
      var lmm = _messages[lmi];
      if (!lmm.items) continue;
      for (var lmj = 0; lmj < lmm.items.length; lmj++) {
        var lit = lmm.items[lmj];
        if (lit && lit.archiveId === data.id && !lit.late) {
          lit.late = true;
          lateFixed = true;
        }
      }
    }
    if (lateFixed) {
      _saveMessages();
      _renderIfActive();
    }
    return;
  }
  // v6.5.4: 校色阶段(自动+手动) — 给相关气泡的缩略图加"校色中"呼吸动画
  // 自动校色带 genTaskId(按任务定位); 手动校色带 layerIDs(按图层反查气泡)
  if (action === 'colormatchPhase') {
    if (!data || !_activeContainer) return;
    var targets = [];   // [{aiMsgId, itemIdxs:[..]|null}] — itemIdxs=null 表示整气泡全部图
    if (data.genTaskId) {
      var idx = _taskIndex[data.genTaskId];
      if (idx && idx.aiMsgId) targets.push({ aiMsgId: idx.aiMsgId, itemIdxs: null });
    } else if (Array.isArray(data.layerIDs) && data.layerIDs.length) {
      // 手动校色: 按 layerID 找到所属气泡和具体哪几张
      _loadMessages();
      var lidSet = {};
      data.layerIDs.forEach(function(id) { lidSet[+id] = true; });
      for (var mi = 0; mi < _messages.length; mi++) {
        var mm = _messages[mi];
        if (mm.role !== 'ai' || !mm.items) continue;
        var hitIdxs = [];
        for (var ii = 0; ii < mm.items.length; ii++) {
          var iit = mm.items[ii];
          if (iit && iit.layerID != null && lidSet[+iit.layerID]) hitIdxs.push(ii);
        }
        if (hitIdxs.length) targets.push({ aiMsgId: mm.id, itemIdxs: hitIdxs });
      }
    }
    if (!targets.length) return;
    var on = (data.phase !== 'done');

    // done 阶段: 需要给数据打标记，然后重新渲染整个气泡（保留圆点等结构）
    // 只有手动校色(layerIDs 路)才打"传回校色"标记 — 自动校色(genTaskId 路)的成品
    // 跟着正常传回流程走(✓返回PS 贴的就是校色版), cmTaskId 下没有货, 打了标记
    // 按钮就永远赖着且点了空转(问题3根源)
    if (data.phase === 'done' && data.taskId && !data.genTaskId) {
      _loadMessages();
      for (var ti = 0; ti < targets.length; ti++) {
        var t = targets[ti];
        var aiMsg = _findById(t.aiMsgId);
        if (!aiMsg || !aiMsg.items) continue;
        // 给对应的 item 打上校色完成标记
        for (var ii = 0; ii < aiMsg.items.length; ii++) {
          if (t.itemIdxs === null || t.itemIdxs.indexOf(ii) !== -1) {
            if (!aiMsg.items[ii].cmTaskId) aiMsg.items[ii].cmTaskId = data.taskId;
          }
        }
      }
      _saveMessages();
      _renderIfActive();  // 重新渲染整个列表，保留圆点结构
      return;
    }

    // start/progress 阶段: 只操作 DOM 添加呼吸动画
    for (var ti = 0; ti < targets.length; ti++) {
      var t = targets[ti];
      var wraps = _activeContainer.querySelectorAll('.conv-img-wrap[data-msg-id="' + t.aiMsgId + '"]');
      for (var wi = 0; wi < wraps.length; wi++) {
        var wIdx = parseInt(wraps[wi].dataset.itemIdx, 10);
        var match = (t.itemIdxs === null) || (t.itemIdxs.indexOf(wIdx) !== -1);
        if (match) {
          wraps[wi].classList.toggle('conv-img-colorgrading', on);
        }
      }
      // 气泡 meta 行显示校色进度文字
      var bubble = wraps.length ? wraps[0].closest('.conv-bubble') : null;
      if (bubble) {
        var metaEl = bubble.querySelector('.conv-meta');
        if (metaEl) {
          var old = metaEl.getAttribute('data-cm-orig');
          if (data.phase === 'done') {
            if (old != null) { metaEl.textContent = old; metaEl.removeAttribute('data-cm-orig'); }
          } else {
            if (old == null) metaEl.setAttribute('data-cm-orig', metaEl.textContent);
            metaEl.textContent = '🎨 校色中 ' + (data.done || 0) + '/' + (data.total || '?') + ' …';
          }
        }
      }
    }
    return;
  }
  if (action === 'conversationSaveImageResult') {
    var cb = _pendingSaves[data && data.reqId];
    if (cb) {
      delete _pendingSaves[data.reqId];
      cb((data && data.success) ? data.nativePath : null);
    }
    return;
  }
  if (action === 'conversationOpenFolderResult') {
    if (data && !data.success) TileAPI.toast('打开失败: ' + (data.error || '未知错误'), 'error');
    return;
  }
  if (action === 'conversationLayerVisibilityResult') {
    var failed = (data && data.failed) || [];
    var applied = (data && data.applied) || [];
    _loadMessages();
    var changed = false;
    for (var mi = 0; mi < _messages.length; mi++) {
      var mm = _messages[mi];
      if (!mm.items) continue;
      for (var ii = 0; ii < mm.items.length; ii++) {
        var iit = mm.items[ii];
        if (!iit || iit.layerID == null) continue;
        // v6.5.3 自愈: PS 实测图层还在 → 撤销之前的"已删除"误标
        // (合并/拼合事件的批量作废是宁枉勿纵的, 图层队列变动后大量误标; 以点击时实测为准)
        if (applied.indexOf(iit.layerID) !== -1 && iit.layerLost) {
          iit.layerLost = false;
          changed = true;
        }
        if (failed.indexOf(iit.layerID) !== -1 && !iit.layerLost) {
          iit.layerLost = true;
          if (mm.selectedItemIdx === ii) mm.selectedItemIdx = null;
          changed = true;
        }
      }
    }
    if (changed) {
      _saveMessages();
      _renderIfActive();
    }
    if (failed.length) TileAPI.toast(failed.length + ' 个图层已不存在,已标灰', 'warn');
    if (data && !data.success) {
      TileAPI.toast('图层联动失败: ' + (data.error || '未知错误'), 'error');
    }
    return;
  }
  // v6.5.9: 后台完成图传回结果
  if (action === 'recyclePlaceResult') {
    if (!data) return;
    if (!data.success) {
      // 失败也要解锁在途标记, 否则这张图的 ⏸ 永远点不动了
      if (window._centerRecyclePlacing && data.taskId) delete window._centerRecyclePlacing[data.taskId];
      TileAPI.toast('传回失败: ' + (data.error || '未知错误'), 'error');
      return;
    }
    var archiveId = data.taskId;
    var layerId = data.layerId;
    TileAPI.toast('已传回', 'success');
    // 从记录中找到这张图，回填图层号
    var placing = window._centerRecyclePlacing && window._centerRecyclePlacing[archiveId];
    if (placing) delete window._centerRecyclePlacing[archiveId];   // 成功一律解锁(含没拿到图层号的边角)
    if (placing && layerId != null) {
      _loadMessages();
      var targetMsg = _findById(placing.msgId);
      if (targetMsg && targetMsg.items && targetMsg.items[placing.itemIdx]) {
        var targetItem = targetMsg.items[placing.itemIdx];
        targetItem.layerID = layerId;
        // 清除 archiveId 标记（已经贴回了，不再是"未贴回"状态）
        // 注：保留 archiveId 也可以，只是渲染时优先看 layerID
        _saveMessages();
        _renderIfActive();
      }
    }
    return;
  }
}

// ============================================================
//  正面 + 注册
// ============================================================
function renderFront(container, w, h) {
  var running = Object.keys(_getRunning()).length;
  var pending = Object.keys(_getPending()).length;
  if (running > 0) {
    var tids = Object.keys(_getRunning());
    container.innerHTML =
      '<div class="tile-icon">⚡</div>' +
      '<div class="tile-label">生成中 ' + running + '</div>' +
      '<div class="tile-task-front-bar"><div class="tile-task-front-fill" style="background:' + _progGradient(tids[0]) + ';"></div></div>';
  } else if (pending > 0) {
    container.innerHTML = '<div class="tile-icon">✓</div><div class="tile-label">待返回 ' + pending + '</div>';
  } else if (w >= 2) {
    var msgs = _loadMessages();
    container.innerHTML =
      '<div class="tile-icon">📮</div>' +
      '<div class="tile-label">生成中心</div>' +
      '<div class="tile-desc">对话 · ' + msgs.length + ' 条</div>';
  } else {
    container.innerHTML =
      '<div class="tile-icon">📮</div>' +
      '<div class="tile-label">生成中心</div>';
  }
}

// 正面实时刷新(任务开始/结束时) — 继承老任务磁贴的正面联动
function _refreshFront() {
  try {
    if (!window.TileEngine) return;
    var el = TileEngine.getTileElement('center');
    if (!el || el.classList.contains('panel-mode')) return;
    var inner = el.querySelector('.tile-inner') || el.querySelector('.tile-flip-front');
    if (inner) renderFront(inner, +el.dataset.w || 1, +el.dataset.h || 1);
  } catch(_) {}
}
TileAPI.on('tasks:updated', _refreshFront);
TileAPI.on('tasks:progress', function() {
  try {
    if (!window.TileEngine) return;
    var el = TileEngine.getTileElement('center');
    if (!el || el.classList.contains('panel-mode')) return;
    var fill = el.querySelector('.tile-task-front-fill');
    if (fill) {
      var tids = Object.keys(_getRunning());
      if (tids.length) fill.style.background = _progGradient(tids[0]);
    }
  } catch(_) {}
});

// ── 面板打开时的运行态刷新 ──
// tasks:updated(任务增删/图回) → 全量重渲列表(活气泡结构变了)
// tasks:tick(每秒) → 只改"已用时"文字节点, 不重渲(纪律: 防止每秒重渲 50 条消息)
// tasks:progress → 只改进度条背景
TileAPI.on('output:autoReturnChanged', function() {
  if (!_activeContainer) return;
  var b = _activeContainer.querySelector('#convGlobalAr');
  if (b) b.classList.toggle('w10-btn-accent', TileAPI.storage.get('output.autoReturn') !== false);
});
TileAPI.on('tasks:updated', function() { _renderIfActive(); });
TileAPI.on('tasks:tick', function() {
  if (!_activeContainer) return;
  var cds = _activeContainer.querySelectorAll('[data-live-cd]');
  for (var i = 0; i < cds.length; i++) {
    var st = +cds[i].getAttribute('data-live-start') || 0;
    if (!st) continue;
    cds[i].textContent = _fmtElapsed(st);
  }
});
TileAPI.on('tasks:progress', function() {
  if (!_activeContainer) return;
  var fills = _activeContainer.querySelectorAll('[data-live-fill]');
  var running = _getRunning();
  for (var i = 0; i < fills.length; i++) {
    var tid = fills[i].getAttribute('data-live-fill');
    var hit = _runningCardFor(tid);
    if (!hit) continue;
    if (hit.grouped) {
      var totS = 0, totF = 0, totB = 0;
      hit.subs.forEach(function(k) {
        var c = running[k] || {};
        totS += c.success || 0; totF += c.fail || 0; totB += c.batchSize || 1;
      });
      fills[i].style.width = (totB > 0 ? Math.round(((totS + totF) / totB) * 100) : 0) + '%';
    } else {
      fills[i].style.background = _progGradient(hit.tid);
    }
    // 计数文字
    var cnt = _activeContainer.querySelector('[data-live-count="' + tid + '"]');
    if (cnt && !hit.grouped) {
      var c2 = running[hit.tid] || {};
      cnt.textContent = ((c2.success || 0) + (c2.fail || 0)) + '/' + (c2.batchSize || 1);
    }
  }
});

TileAPI.registerTile({
  id: 'center',
  group: 'main',
  icon: '📮',
  label: '生成中心',
  desc: '对话 · 进度 · 结果',
  live: true,
  defaultSize: { w: 2, h: 3 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },
  renderFront: renderFront,
  renderBack: function(c) {
    var running = Object.keys(_getRunning()).length;
    c.textContent = running > 0 ? ('⚡ ' + running + ' 个进行中') : '对话 · 进度 · 结果';
  },
  onResize: renderFront,
  onExpand: function(container) {
    _renderPanel(container);
    return function() { _activeContainer = null; };
  },
  onCollapse: function() { _activeContainer = null; },
  onMessage: _onMessage,
  onStorageLoaded: function() {
    _loadMessages();
  }
});

})();
