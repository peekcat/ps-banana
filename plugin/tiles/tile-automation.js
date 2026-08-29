// ============================================================
//  tile-automation.js — Codex 自动化 API · 面板侧（Phase 0 骨架）
//
//  零侵入:本文件由 scanTiles 自动加载。它不注册磁贴(没 UI),只做桥接:
//    1. 加载后 sendToHost('autoBootstrap') 让 host 启动自轮询
//    2. onHostMessage('autoCommand') 接收面板类命令, 处理后 sendToHost('autoWriteResult')
//
//  面板类命令 = 需要 TileAPI/state/DOM 的(提示词/参数/生成/挑图)。
//  纯 PS 命令在 host 侧直接做, 不经过这里。
// ============================================================
(function() {
'use strict';

var PUBLIC_READ_ACTIONS = {
  pingPanel: 1,
  getCodexAutopilotProfile: 1,
  getAllowedModels: 1,
  validateModelPermission: 1
};
var _hostRpcSeq = 0;
var _hostPending = Object.create(null);
var _runAcceptancePending = Object.create(null);
var _automationTasks = Object.create(null);
var RUN_ACCEPTANCE_TIMEOUT_MS = 3600000;

function _sameId(a, b) { return a != null && b != null && String(a) === String(b); }
function _newAutomationTaskId() { return 'auto_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10); }
function _hostRpc(action, resultEvent, data, timeoutMs) {
  return new Promise(function(resolve) {
    var reqId = 'auto_rpc_' + Date.now() + '_' + (++_hostRpcSeq);
    var timer = setTimeout(function() {
      if (!_hostPending[reqId]) return;
      delete _hostPending[reqId];
      resolve({ success: false, error: _err('HOST_TIMEOUT', '等待 Photoshop 回应超时') });
    }, timeoutMs || 3600000);
    _hostPending[reqId] = { event: resultEvent, resolve: resolve, timer: timer };
    var payload = {};
    Object.keys(data || {}).forEach(function(k) { payload[k] = data[k]; });
    payload.reqId = reqId;
    try { TileAPI.sendToHost(action, payload); }
    catch (e) {
      clearTimeout(timer);
      delete _hostPending[reqId];
      resolve({ success: false, error: _err('HOST_SEND_FAILED', (e && e.message) || String(e)) });
    }
  });
}
function _resolveHostRpc(eventName, msg) {
  var key = msg && msg.reqId != null ? String(msg.reqId) : '';
  var pending = key && _hostPending[key];
  if (!pending || pending.event !== eventName) return;
  clearTimeout(pending.timer);
  delete _hostPending[key];
  pending.resolve(msg || { success: false, error: _err('EMPTY_HOST_RESULT', 'Photoshop 没有返回结果') });
}
function _waitForRunAcceptance(authorizationId, taskId, timeoutMs) {
  return new Promise(function(resolve) {
    var key = String(authorizationId || '');
    if (!key) { resolve({ success: false, error: _err('RUN_AUTHORIZATION_INVALID', '缺少生成授权') }); return; }
    var timer = setTimeout(function() {
      if (!_runAcceptancePending[key]) return;
      delete _runAcceptancePending[key];
      try {
        TileAPI.sendToHost('autoCancelCodexRun', { authorizationId: key, taskId: String(taskId || '') });
        TileAPI.sendToHost('earlyStopTask', { taskId: String(taskId || '') });
      } catch (_) {}
      resolve({ success: false, error: _err('HOST_TIMEOUT', '等待 Host 确认生成授权超时') });
    }, timeoutMs || RUN_ACCEPTANCE_TIMEOUT_MS);
    _runAcceptancePending[key] = { taskId: String(taskId || ''), resolve: resolve, timer: timer };
  });
}
['autoProbeSelectionPolicyResult', 'autoAuthorizeCodexRunResult', 'autoRegisterCodexGeneratedLayersResult', 'conversationLayerVisibilityResult'].forEach(function(eventName) {
  TileAPI.onHostMessage(eventName, function(msg) { _resolveHostRpc(eventName, msg); });
});
TileAPI.onHostMessage('automationRunAuthorizationResult', function(msg) {
  var key = msg && msg.authorizationId != null ? String(msg.authorizationId) : '';
  var pending = key && _runAcceptancePending[key];
  if (!pending || (msg.taskId != null && String(msg.taskId) !== pending.taskId)) return;
  clearTimeout(pending.timer);
  delete _runAcceptancePending[key];
  pending.resolve(msg || { success: false, error: _err('EMPTY_HOST_RESULT', 'Host 没有返回生成授权结果') });
});

// ---- 解析 conversation.messages 找一组候选 ----
function _readMessages() {
  var raw = TileAPI.storage.get('conversation.messages');
  var msgs = [];
  try { msgs = (typeof raw === 'string') ? JSON.parse(raw) : (raw || []); } catch (e) {}
  return Array.isArray(msgs) ? msgs : [];
}
function _findGroup(taskId, msgId) {
  var msgs = _readMessages();
  for (var i = msgs.length - 1; i >= 0; i--) {
    var m = msgs[i];
    if (!m || m.role !== 'ai' || !m.items) continue;
    if ((taskId && _sameId(m.taskId, taskId)) || (msgId && _sameId(m.id, msgId)) || (!taskId && !msgId)) return m;
  }
  return null;
}
function _groupCandidates(m) {
  var out = [];
  if (!m || !m.items) return out;
  for (var j = 0; j < m.items.length; j++) {
    var it = m.items[j];
    if (it.layerID == null) continue;
    out.push({ idx: j, layerId: it.layerID, layerName: it.layerName || '', visible: !it.layerLost, thumbPath: it.imgPath || null, imagePath: it.imgPath || null, success: !!it.success });
  }
  return out;
}

// ---- Codex 授权档案 + 模型白名单校验（全部默认拒绝，必须明确开启）----
function _autopilot() { var p = TileAPI.storage.get('codex.autopilot'); return (p && typeof p === 'object') ? p : null; }
function _apActive(ap) { return !!(ap && ap.enabled === true && ap.paused !== true); }
function _activeError() {
  var ap = _autopilot();
  if (!ap || ap.enabled !== true) return _err('AUTOPILOT_DISABLED', '全自动开关未开启，已拒绝操作');
  if (ap.paused === true) return _err('AUTOPILOT_PAUSED', '全自动目前已暂停，已拒绝操作');
  return null;
}
function _permissionError(key) {
  var activeErr = _activeError();
  if (activeErr) return activeErr;
  var ap = _autopilot();
  return (!ap.permissions || ap.permissions[key] !== true) ? _err('NOT_ALLOWED', '这个操作没有明确授权: ' + key) : null;
}
function _effectiveParams(d) {
  d = d || {};
  return {
    provider: d.provider != null ? d.provider : TileAPI.state.get('params.provider'),
    model: d.model != null ? d.model : TileAPI.state.get('params.model'),
    size: d.size != null ? d.size : TileAPI.state.get('params.size'),
    aspectRatio: d.aspectRatio != null ? d.aspectRatio : (TileAPI.state.get('params.aspectRatio') || '1:1'),
    batch: d.batch != null ? Number(d.batch) : Number(TileAPI.state.get('params.batch') || 1),
    autoReturn: d.autoReturn != null ? !!d.autoReturn : TileAPI.storage.get('output.autoReturn') !== false
  };
}
function _checkModel(provider, model, size, batch, aspectRatio) {
  var ap = _autopilot();
  var activeErr = _activeError();
  if (activeErr) return { allowed: false, error: activeErr };
  var allowed = (ap.models && Array.isArray(ap.models.allowed)) ? ap.models.allowed : [];
  if (!allowed.length) return { allowed: false, error: _err('MODEL_WHITELIST_EMPTY', '没有配置任何允许使用的模型') };
  var m = null;
  for (var i = 0; i < allowed.length; i++) {
    if (allowed[i] && allowed[i].allowed === true && String(allowed[i].provider) === String(provider) && String(allowed[i].model) === String(model)) { m = allowed[i]; break; }
  }
  if (!m) return { allowed: false, error: _err('MODEL_NOT_ALLOWED', '模型未授权: ' + provider + ' / ' + model) };
  if (!Array.isArray(m.allowedSizes) || m.allowedSizes.indexOf(size) < 0) return { allowed: false, error: _err('SIZE_NOT_ALLOWED', '分辨率未授权: ' + size) };
  var n = Number(batch), max = Number(m.maxBatch);
  if (!isFinite(n) || Math.floor(n) !== n || n < 1) return { allowed: false, error: _err('BAD_BATCH', '生成张数必须是大于等于 1 的整数') };
  if (!isFinite(max) || Math.floor(max) !== max || max < 1 || n > max) return { allowed: false, error: _err('BATCH_NOT_ALLOWED', '最多只允许一次生成 ' + (isFinite(max) ? max : 0) + ' 张') };
  if (!Array.isArray(m.allowedAspectRatios) || m.allowedAspectRatios.indexOf(aspectRatio) < 0) return { allowed: false, error: _err('ASPECT_NOT_ALLOWED', '画幅比例未授权: ' + aspectRatio) };
  var requiresSquare = m.requireSquareSelection === true || !!(ap.models && ap.models.requireSquareSelection === true);
  if (requiresSquare && aspectRatio !== '1:1') return { allowed: false, error: _err('SQUARE_ASPECT_REQUIRED', '该模型只允许 1:1 正方形画幅') };
  return { allowed: true, model: m, requiresSquare: requiresSquare };
}

function _trackedGroup(d) {
  d = d || {};
  var taskId = d.taskId == null ? '' : String(d.taskId);
  var tracked = taskId && _automationTasks[taskId];
  if (!tracked) return { error: _err('UNTRUSTED_TASK', '这不是本次自动化启动并确认过的任务') };
  var m = _findGroup(taskId, d.msgId);
  if (!m || String(m.taskId || '') !== taskId) return { error: _err('CANDIDATES_NOT_FOUND', '还没有找到这个任务的返回候选') };
  if (m.docId == null) return { error: _err('DOCUMENT_ID_MISSING', '候选结果没有记录所属 Photoshop 文档') };
  if (!_sameId(m.docId, tracked.docId)) return { error: _err('DOCUMENT_MISMATCH', '候选结果所属文档和生成任务不一致') };
  return { taskId: taskId, tracked: tracked, message: m, candidates: _groupCandidates(m), docId: m.docId };
}

async function _registerTrackedCandidates(group) {
  if (!group.candidates.length) return { success: true, data: { layerIds: [] } };
  return await _hostRpc('autoRegisterCodexGeneratedLayers', 'autoRegisterCodexGeneratedLayersResult', {
    taskId: group.taskId, docId: group.docId,
    layerIds: group.candidates.map(function(c) { return c.layerId; })
  });
}

async function _setCandidateVisibility(d, isFinalSelection) {
  var group = _trackedGroup(d);
  if (group.error) return { success: false, error: group.error };
  var solo = (d && d.soloLayerID != null) ? d.soloLayerID : (d && d.layerId);
  if (solo == null) return { success: false, error: _err('BAD_ARGS', '缺少候选图层 ID') };
  var owned = group.candidates.map(function(c) { return c.layerId; });
  if (!owned.some(function(id) { return _sameId(id, solo); })) return { success: false, error: _err('CANDIDATE_NOT_OWNED', '所选图层不属于这个任务的候选列表') };
  if (isFinalSelection) {
    var permErr = _permissionError('allowAutoSelectCandidate');
    if (permErr) return { success: false, error: permErr };
    var liveModel = _checkModel(group.tracked.provider, group.tracked.model, group.tracked.size, group.tracked.batch, group.tracked.aspectRatio);
    if (!liveModel.allowed) return { success: false, error: liveModel.error };
    if (!liveModel.model || liveModel.model.allowCodexAutoSelect !== true) return { success: false, error: _err('MODEL_AUTO_SELECT_DENIED', '这个模型没有授权 Codex 自动挑选候选') };
  }
  var reg = await _registerTrackedCandidates(group);
  if (!reg || !reg.success) return { success: false, error: (reg && reg.error) || _err('LAYER_REGISTER_FAILED', '候选图层可信登记失败') };
  var vis = await _hostRpc('conversationLayerVisibility', 'conversationLayerVisibilityResult', {
    mode: 'solo', docId: group.docId, ownedLayerIDs: owned, soloLayerID: solo
  });
  if (!vis || !vis.success) return { success: false, error: (vis && vis.error) || _err('VISIBILITY_FAILED', 'Photoshop 没能完成候选显示切换') };
  if (Array.isArray(vis.failed) && vis.failed.some(function(id) { return _sameId(id, solo); })) return { success: false, error: _err('CANDIDATE_NOT_FOUND', '所选候选图层在 Photoshop 中不存在') };
  return { success: true, data: { selectedLayerId: solo, soloLayerID: solo, docId: group.docId, ownedLayerIDs: owned, hiddenOthers: owned.filter(function(x) { return !_sameId(x, solo); }) } };
}

// ---- 面板类命令分发表 ----
var HANDLERS = {
  pingPanel: function(data) {
    return { success: true, data: { pong: 'panel', echo: (data && data.echo) || null, ts: Date.now() } };
  },

  // 提示词模式(只读; ensurePromptTextMode/setPromptText 在 2B 接入)
  getPromptMode: function() {
    var kind = TileAPI.state.get('prompt.lastPresetKind') || '';
    var text = String(TileAPI.state.get('prompt.text') || '');
    var mode;
    if (kind === 'forge') mode = 'forge';
    else if (kind) mode = 'preset';
    else {
      // 近似判断(2B 接 tile-prompt 的真实判定): 含 param:数值 或 【填空:】 视为滑块模式
      var hasParam = /(^|\n)\s*[A-Za-z_][\w]*\s*[:：]\s*-?\d/.test(text) || /@\w+\s*=/.test(text);
      var hasField = /【填空[:：]/.test(text);
      mode = (hasParam || hasField) ? 'paramSliders' : 'text';
    }
    return { success: true, data: { mode: mode, presetName: kind || null, hasParamSliders: mode === 'paramSliders' } };
  },

  // 一次性设参数(autopilot 启用时校验模型/分辨率白名单)
  setParams: function(d) {
    d = d || {};
    var effective = _effectiveParams(d);
    var chk = _checkModel(effective.provider, effective.model, effective.size, effective.batch, effective.aspectRatio);
    if (!chk.allowed) return { success: false, error: chk.error };
    if (effective.autoReturn) {
      var autoErr = _permissionError('allowAutoReturn');
      if (autoErr) return { success: false, error: autoErr };
    }
    var keys = ['provider', 'model', 'size', 'aspectRatio', 'batch', 'timeout', 'antiMode'];
    var applied = {};
    keys.forEach(function(k) {
      if (d[k] == null) return;
      var v = d[k];
      if (k === 'provider' && TileAPI.setProvider) TileAPI.setProvider(v, { source: 'automation' });
      else {
        TileAPI.state.set('params.' + k, v);
        TileAPI.storage.set('params.' + k, v);
        if (k === 'provider') TileAPI.emit('params:providerChanged', { provider: v });
      }
      if (k === 'antiMode') TileAPI.sendToHost('updateSettings', { antiMode: +v });
      TileAPI.emit('params:remoteChanged', { key: k, value: v });
      applied[k] = v;
    });
    if (d.autoReturn != null) {
      TileAPI.storage.set('output.autoReturn', !!d.autoReturn);
      TileAPI.emit('output:autoReturnChanged', { value: !!d.autoReturn });
      applied.autoReturn = !!d.autoReturn;
    }
    return { success: true, data: { applied: applied } };
  },

  setAutoReturn: function(d) {
    var en = !!(d && d.enabled);
    if (en) {
      var deny = _permissionError('allowAutoReturn');
      if (deny) return { success: false, error: deny };
    }
    TileAPI.storage.set('output.autoReturn', en);
    TileAPI.emit('output:autoReturnChanged', { value: en });
    return { success: true, data: { enabled: en } };
  },

  getTaskStatus: function(d) {
    var tid = d && d.taskId;
    var running = TileAPI.state.get('tasks.running') || {};
    var meta = TileAPI.state.get('tasks.meta') || {};
    if (tid) {
      var r = running[tid], m = meta[tid] || {};
      if (r) {
        return { success: true, data: {
          taskId: tid, status: 'running', running: true,
          success: r.success || 0, fail: r.fail || 0, batchSize: r.batchSize || 1,
          percent: (r.percent != null ? r.percent : null),
          countdown: (m.countdown != null ? m.countdown : null),
          autoReturn: !!m.autoReturn, awaitingReturn: !!r.awaitingReturn, error: null
        } };
      }
      // 不在 running → 已完成: 从 conversation 找该组统计
      var g = _findGroup(tid, null);
      if (g && g.items) {
        var s = 0, f = 0;
        g.items.forEach(function(it) { if (it.success) s++; else f++; });
        var cc = _groupCandidates(g).length;
        return { success: true, data: {
          taskId: tid, status: 'completed', running: false,
          success: s, fail: f, batchSize: g.items.length, returnedCount: cc, candidateCount: cc,
          autoReturn: (m.autoReturn != null ? !!m.autoReturn : null),
          conversationGroupId: g.id, docId: (g.docId != null ? g.docId : null)
        } };
      }
      // 不在 running 又没找到组 → 也算 completed(不再用 doneOrUnknown), 统计未知
      return { success: true, data: { taskId: tid, status: 'completed', running: false, success: null, fail: null, batchSize: null, returnedCount: null, note: '任务已不在运行队列, 但未在会话里找到该 taskId 的结果组' } };
    }
    return { success: true, data: { tasks: Object.keys(running) } };
  },

  getReturnedCandidates: async function(d) {
    var group = _trackedGroup(d || {});
    if (group.error) return { success: false, error: group.error };
    if (!group.candidates.length) return { success: true, data: { taskId: group.taskId, conversationGroupId: group.message.id, docId: group.docId, candidates: [] } };
    var reg = await _registerTrackedCandidates(group);
    if (!reg || !reg.success) return { success: false, error: (reg && reg.error) || _err('LAYER_REGISTER_FAILED', '候选图层可信登记失败') };
    var actualIds = (reg.data && Array.isArray(reg.data.layerIds)) ? reg.data.layerIds : [];
    var cands = group.candidates.filter(function(c) { return actualIds.some(function(id) { return _sameId(id, c.layerId); }); });
    return { success: true, data: {
      taskId: group.taskId,
      conversationGroupId: group.message.id,
      docId: group.docId,
      firstCandidateLayerId: cands.length ? cands[0].layerId : null,
      candidates: cands,
      missingLayerIds: (reg.data && reg.data.missing) || [],
      registeredGroupLayerIds: (reg.data && reg.data.groupIds) || []
    } };
  },

  // 只显示某候选, 保留背景和其它修图组(复用现成 conversationLayerVisibility)
  soloCandidate: function(d) { return _setCandidateVisibility(d || {}, false); },

  // 强制提示词进普通文本模式(解预设/滑块绑定 + 强制 textarea)
  ensurePromptTextMode: function() {
    TileAPI.emit('prompt:forceText');
    return { success: true, data: { mode: 'text' } };
  },

  // 只解预设绑定, 保留当前文本
  clearPromptPresetBinding: function() {
    TileAPI.state.set('prompt.lastPresetTitle', '');
    TileAPI.state.set('prompt.lastPresetKind', '');
    TileAPI.state.set('prompt.lastPresetId', '');
    TileAPI.state.set('prompt.lastPresetMeta', null);
    return { success: true, data: { cleared: true } };
  },

  // 设提示词文本(自动先切文本模式; 保证 state/storage/DOM textarea 一致)
  setPromptText: function(d) {
    var text = (d && typeof d.text === 'string') ? d.text : '';
    TileAPI.emit('prompt:forceText');                                  // 先确保文本模式
    TileAPI.emit('prompt:changed', { text: text, source: 'automation' }); // 写 state+storage+重渲 textarea
    return { success: true, data: { text: text } };
  },

  // 触发生成: 可选先写词/设参, 然后等价于"开始生成"按钮, 返回新 taskId
  // 注: 选区请先用 makeSquareSelection 设好(run:start 会读当前 PS 选区)
  runGenerate: async function(d) {
    d = d || {};
    var generateErr = _permissionError('allowGenerate');
    if (generateErr) return { success: false, error: generateErr };
    var paramInput = {};
    Object.keys(d.params || {}).forEach(function(k) { paramInput[k] = d.params[k]; });
    if (d.autoReturn != null && paramInput.autoReturn == null) paramInput.autoReturn = !!d.autoReturn;
    var effective = _effectiveParams(paramInput);
    var chk = _checkModel(effective.provider, effective.model, effective.size, effective.batch, effective.aspectRatio);
    if (!chk.allowed) return { success: false, error: chk.error };
    if (effective.autoReturn) {
      var returnErr = _permissionError('allowAutoReturn');
      if (returnErr) return { success: false, error: returnErr };
    }
    var isNextRegion = d.continueNextRegion === true || d.isSubsequentRegion === true || Number(d.regionIndex) > 0;
    if (isNextRegion) {
      var nextErr = _permissionError('allowContinueNextRegion');
      if (nextErr) return { success: false, error: nextErr };
    }
    if (d.prompt != null) { HANDLERS.setPromptText({ text: String(d.prompt) }); }
    if (Object.keys(paramInput).length) {
      var applied = HANDLERS.setParams(paramInput);
      if (!applied || !applied.success) return applied || { success: false, error: _err('PARAMS_REJECTED', '参数没有通过授权检查') };
    }
    effective = _effectiveParams({});
    chk = _checkModel(effective.provider, effective.model, effective.size, effective.batch, effective.aspectRatio);
    if (!chk.allowed) return { success: false, error: chk.error };
    var probe = await _hostRpc('autoProbeSelectionPolicy', 'autoProbeSelectionPolicyResult', {});
    if (!probe || !probe.success || !probe.data) return { success: false, error: (probe && probe.error) || _err('SELECTION_PROBE_FAILED', 'Photoshop 文档或选区验证失败') };
    if (chk.requiresSquare && probe.data.isSquare !== true) return { success: false, error: _err('SQUARE_SELECTION_REQUIRED', '该模型只允许使用正方形选区') };
    var taskId = _newAutomationTaskId();
    var authorization = await _hostRpc('autoAuthorizeCodexRun', 'autoAuthorizeCodexRunResult', {
      taskId: taskId, docId: probe.data.docId, probeId: probe.data.probeId,
      provider: effective.provider, model: effective.model, size: effective.size,
      batch: effective.batch, aspectRatio: effective.aspectRatio,
      autoReturn: effective.autoReturn, continueNextRegion: isNextRegion
    }, RUN_ACCEPTANCE_TIMEOUT_MS);
    if (!authorization || !authorization.success || !authorization.data || !authorization.data.authorizationId) {
      try { TileAPI.sendToHost('autoCancelCodexRun', { taskId: taskId }); } catch (_) {}
      return { success: false, error: (authorization && authorization.error) || _err('RUN_AUTHORIZATION_FAILED', 'Host 没有签发生成授权') };
    }
    var before = {};
    var run0 = TileAPI.state.get('tasks.running') || {};
    Object.keys(run0).forEach(function(k) { before[k] = 1; });
    var startedEventId = null;
    var onStarted = function(info) {
      if (!info || info.taskId == null || before[String(info.taskId)] || String(info.taskId) !== taskId) return;
      if (info.engine && info.engine !== 'banana') return;
      if (info.model != null && String(info.model) !== String(effective.model)) return;
      if (info.batch != null && Number(info.batch) !== Number(effective.batch)) return;
      startedEventId = String(info.taskId);
    };
    try { TileAPI.on('generate:started', onStarted); } catch (_) {}
    var acceptancePromise = _waitForRunAcceptance(authorization.data.authorizationId, taskId, RUN_ACCEPTANCE_TIMEOUT_MS);
    TileAPI.emit('run:start', {
      source: 'automation', taskId: taskId,
      automationAuthorizationId: authorization.data.authorizationId,
      automationDocId: authorization.data.docId,
      continueNextRegion: isNextRegion
    });
    var startedTaskId = await new Promise(function(resolve) {
      var tries = 0;
      var timer = setInterval(function() {
        tries++;
        if (startedEventId) {
          clearInterval(timer);
          resolve(startedEventId);
        } else if (tries >= 50) {
          clearInterval(timer);
          resolve(null);
        }
      }, 100);
    });
    try { if (TileAPI.off) TileAPI.off('generate:started', onStarted); } catch (_) {}
    var accepted = await acceptancePromise;
    if (!accepted || accepted.success !== true) {
      return { success: false, error: (accepted && accepted.error) || _err('RUN_AUTHORIZATION_FAILED', 'Host 拒绝了生成授权'), data: { taskId: taskId, started: !!startedTaskId, trusted: false } };
    }
    if (!startedTaskId) return { success: false, error: _err('GENERATION_NOT_STARTED', '没有检测到新生成任务，可能是 Key、提示词或运行条件不完整') };
    _automationTasks[String(startedTaskId)] = {
      taskId: String(startedTaskId), docId: authorization.data.docId,
      provider: effective.provider, model: effective.model,
      size: effective.size, batch: effective.batch, aspectRatio: effective.aspectRatio,
      registeredAt: Date.now()
    };
    return { success: true, data: { taskId: startedTaskId, docId: authorization.data.docId, started: true, trusted: true } };
  },

  // 选定最终候选: 显示它、隐藏同组其它(不删除)。复用 solo(持久生效, 不调 restore 就保持)
  selectCandidate: function(d) { return _setCandidateVisibility(d || {}, true); },

  // ---- Codex 授权档案 ----
  getCodexAutopilotProfile: function() {
    return { success: true, data: _autopilot() || { enabled: false, note: '未配置(在 Codex 全自动修图磁贴里设置)' } };
  },
  getAllowedModels: function() {
    var ap = _autopilot();
    return { success: true, data: {
      allowed: (ap && ap.models && ap.models.allowed) || [],
      requireSquareSelection: !!(ap && ap.models && ap.models.requireSquareSelection),
      autopilotActive: _apActive(ap)
    } };
  },
  validateModelPermission: function(d) {
    d = d || {};
    var effective = _effectiveParams(d);
    var chk = _checkModel(effective.provider, effective.model, effective.size, effective.batch, effective.aspectRatio);
    return { success: true, data: {
      provider: effective.provider, model: effective.model, size: effective.size,
      batch: effective.batch, aspectRatio: effective.aspectRatio,
      allowed: chk.allowed, requiresSquareSelection: !!chk.requiresSquare,
      reason: chk.error ? chk.error.message : null
    } };
  }
};

function _err(code, message) { return { code: code, message: message || code }; }

function _dispatch(reqId, action, data) {
  if (!PUBLIC_READ_ACTIONS[action]) {
    var activeErr = _activeError();
    if (activeErr) {
      TileAPI.sendToHost('autoWriteResult', { reqId: reqId, success: false, data: null, error: activeErr });
      return;
    }
  }
  var h = HANDLERS[action];
  if (!h) {
    TileAPI.sendToHost('autoWriteResult', { reqId: reqId, success: false, data: null, error: _err('UNKNOWN_ACTION', '未知面板命令: ' + action) });
    return;
  }
  Promise.resolve().then(function() { return h(data || {}); }).then(function(r) {
    r = r || {};
    TileAPI.sendToHost('autoWriteResult', {
      reqId: reqId,
      success: !!r.success,
      data: (r.data === undefined ? null : r.data),
      error: r.error || null
    });
  }).catch(function(e) {
    TileAPI.sendToHost('autoWriteResult', { reqId: reqId, success: false, data: null, error: _err('INTERNAL', (e && e.message) || String(e)) });
  });
}

// host 转来的面板类命令
TileAPI.onHostMessage('autoCommand', function(msg) {
  if (!msg || !msg.action) return;
  _dispatch(msg.reqId || null, msg.action, msg.data || {});
});

// host 启动就绪回执(调试用)
TileAPI.onHostMessage('autoReady', function() {
  try { if (TileAPI.log) TileAPI.log('[automation] host 自轮询已就绪', 'info'); } catch (_) {}
});

// 启动 host 自轮询: 加载即发一次, app:ready 再发一次兜底(防 host 还没加载完)
function _bootstrap() { try { TileAPI.sendToHost('autoBootstrap', { profile: _autopilot() }); } catch (_) {} }
_bootstrap();
try { TileAPI.on('app:ready', _bootstrap); } catch (_) {}

// 暴露给后续阶段往 HANDLERS 里加命令 (Phase 1+ 的 tile-automation.cmds.js 之类可用)
window._automationRegister = function(action, fn) { if (action && typeof fn === 'function') HANDLERS[action] = fn; };

})();
