// ============================================================
//  tasks-service.js — 任务记账常驻服务 (v6.5.0 二期第一步)
//
//  从 tile-tasks.js 抽离的"非 UI"逻辑, 原样搬家零改动:
//    - taskComplete 监听: 待返回卡片建档 / 今日统计 / 最近20次诊断 /
//      generate:complete 事件(账单流水+kao/hemisynth并发结算) / telemetry / GRS续杯
//    - taskStarted / task:started / previewImage / taskProgress / forgeProgress 监听
//    - 秒级倒计时 ticker
//    - taskReturned / taskAutoReturnFailed / taskManualReturnFailed
//    - 音效逻辑 _playTaskSound (host 播, 这里保留函数备用)
//
//  ★铁律: state 键(tasks.running/pending/meta)与事件名(tasks:updated/tick/progress,
//  generate:complete)一个都不能改 — 12 个磁贴写 running, 卫星每帧读, 账单挂 complete。
//
//  UI 由 tile-center.js(生成中心)渲染; 本文件不碰 DOM。
// ============================================================
(function() {
'use strict';

function _getRunning() { return TileAPI.state.get('tasks.running') || {}; }
function _getPending() { return TileAPI.state.get('tasks.pending') || {}; }
function _getMeta() { return TileAPI.state.get('tasks.meta') || {}; }
function _setMeta(m) { TileAPI.state.set('tasks.meta', m); }
function _localDateKey() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function _toCount(value) {
  var n = Number(value);
  return isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// ============================================================
//  秒级 ticker (公开 start/stop 给 UI 层复用)
// ============================================================
var _tickTimer = null;
var _completedTaskIds = {};
function _startTicker() {
  if (_tickTimer) return;
  _tickTimer = setInterval(function() {
    var running = _getRunning();
    var meta = _getMeta();
    var changed = false;
    Object.keys(running).forEach(function(tid) {
      var m = meta[tid];
      if (!m || m.countdown === undefined) return;
      if (m.countdown > -999) { m.countdown--; changed = true; }
    });
    if (changed) { _setMeta(meta); TileAPI.emit('tasks:tick'); }
    if (Object.keys(running).length === 0) _stopTicker();
  }, 1000);
}
function _stopTicker() {
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}

// ============================================================
//  任务生命周期监听 (原 tile-tasks.js 模块级监听原样搬)
// ============================================================
TileAPI.on('task:started', function(data) {
  if (!data || !data.taskId) return;
  var meta = _getMeta();
  if (!meta[data.taskId]) {
    meta[data.taskId] = {
      countdown: data.timeoutSec || 3600,
      timeoutSec: data.timeoutSec || 3600,
      autoReturn: (TileAPI.storage.get('output.autoReturn') !== false),
      batchSize: data.batchSize || 1
    };
    _setMeta(meta);
  }
  _startTicker();
});

TileAPI.onHostMessage('taskStarted', function(data) {
  if (!data || !data.taskId) return;
  var meta = _getMeta();
  if (!meta[data.taskId]) {
    meta[data.taskId] = {
      countdown: data.timeoutSec || 3600,
      timeoutSec: data.timeoutSec || 3600,
      autoReturn: (TileAPI.storage.get('output.autoReturn') !== false),
      batchSize: data.batchSize || 1
    };
    _setMeta(meta);
  }
  _startTicker();
});

TileAPI.onHostMessage('previewImage', function(data) {
  if (!data || !data.taskId || !data.base64) return;
  var running = _getRunning();
  var card = running[data.taskId];
  if (!card) return;
  card.thumbnail = 'data:image/png;base64,' + data.base64;
  if (data.docId !== undefined) card.docId = data.docId;
  if (data.docName !== undefined) card.docName = data.docName;
  if (data.docPath !== undefined) card.docPath = data.docPath;
  if (data.selection) card.selection = data.selection;
  TileAPI.state.set('tasks.running', running);
  TileAPI.emit('tasks:updated');
});

TileAPI.onHostMessage('taskProgress', function(data) {
  if (!data || !data.taskId) return;
  var running = _getRunning();
  var card = running[data.taskId];
  if (!card) return;
  card.total = data.total || 0;
  if (data.status === 'success') card.success++;
  if (data.status === 'fail') card.fail++;
  TileAPI.state.set('tasks.running', running);
  TileAPI.emit('tasks:updated');
  TileAPI.emit('tasks:progress', { taskId: data.taskId });
});

TileAPI.onHostMessage('forgeProgress', function(data) {
  if (!data) return;
  var tid = data.taskId;
  var meta = _getMeta();
  if (tid) {
    if (!meta[tid]) meta[tid] = {};
    meta[tid].progress = data.progress || 0;
    if (typeof data.eta === 'number') meta[tid].eta = data.eta;
    if (data.done) meta[tid].progress = 1;
    _setMeta(meta);
    TileAPI.emit('tasks:progress', { taskId: tid });
  } else {
    var running = _getRunning();
    Object.keys(running).forEach(function(k) {
      if (running[k].engine !== 'forge') return;
      if (!meta[k]) meta[k] = {};
      meta[k].progress = data.progress || 0;
    });
    _setMeta(meta);
    TileAPI.emit('tasks:progress', {});
  }
});

// ============================================================
//  taskComplete — 记账链核心 (账单/统计/telemetry/续杯全挂这)
// ============================================================
function _handleTaskComplete(data) {
  if (!data || !data.taskId) return;
  // Host 某些中断/超时分支可能几乎同时回执；同一 taskId 只结算一次。
  if (_completedTaskIds[data.taskId]) return;
  _completedTaskIds[data.taskId] = Date.now();
  var completedKeys = Object.keys(_completedTaskIds);
  if (completedKeys.length > 500) {
    var cutoff = Date.now() - 60 * 60 * 1000;
    completedKeys.forEach(function(k) { if (_completedTaskIds[k] < cutoff) delete _completedTaskIds[k]; });
  }
  var running = _getRunning();
  var r = running[data.taskId];
  var durationMs = r && r.startTime ? (Date.now() - r.startTime) : 0;
  // 完成回执代表实际执行结果，运行卡片只是发起时快照，只在回执缺字段时兜底。
  var provider = data.provider || (r && r.provider) || '';
  var model = data.model || (r && r.model) || '';
  var engine = data.engine || (r && r.engine) || '';
  var size = data.size || data.resolution || (r && (r.size || r.resolution)) || '';
  var docName = data.docName || (r && r.docName) || '';
  var docPath = data.docPath || (r && r.docPath) || '';
  var width = data.width || (r && r.width) || 0;
  var height = data.height || (r && r.height) || 0;
  var batchSize = _toCount(data.batchSize !== undefined ? data.batchSize : (r && r.batchSize)) || 1;
  var failCount = _toCount(data.failCount !== undefined ? data.failCount : data.fail);
  delete running[data.taskId];
  TileAPI.state.set('tasks.running', running);

  var meta = _getMeta();
  var m = meta[data.taskId];
  var taskAutoReturn = m ? !!m.autoReturn : (TileAPI.storage.get('output.autoReturn') !== false);
  delete meta[data.taskId];
  _setMeta(meta);

  var generatedCount = _toCount(data.generatedCount !== undefined
    ? data.generatedCount
    : (data.successCount !== undefined ? data.successCount : data.success));
  var returnedCount = (data.returnedCount !== undefined)
    ? _toCount(data.returnedCount)
    : (taskAutoReturn && !data.cached ? generatedCount : 0);
  var pendingCount = (data.pendingCount !== undefined)
    ? _toCount(data.pendingCount)
    : ((engine === 'forge' ? !!data.pendingReturn : (!taskAutoReturn || data.cached)) ? generatedCount : 0);

  // 待返回卡片只保存仍未贴回的数量，部分成功时不会把已贴图片再贴一遍。
  if (pendingCount > 0) {
    var pending = _getPending();
    pending[data.taskId] = {
      successCount: pendingCount,
      generatedCount: generatedCount,
      returnedCount: returnedCount,
      failCount: failCount,
      time: Date.now(),
      thumbnail: data.thumbnail || (r && r.thumbnail),
      engine: engine,
      provider: provider,
      model: model,
      batchSize: batchSize,
      width: width,
      height: height,
      resolution: size,
      presetTitle: data.presetTitle || (r && r.presetTitle),
      promptSnippet: data.promptSnippet || (r && r.promptSnippet),
      docId: data.docId || (r && r.docId),
      docName: docName,
      docPath: docPath,
      selection: data.selection || (r && r.selection)
    };
    TileAPI.state.set('tasks.pending', pending);
    if (data.cached) {
      TileAPI.toast(generatedCount + ' 张已生成,PS 正忙未能自动返回,请在任务卡片点 ✓ 手动返回', 'warn');
    }
  }

  // 今日统计
  var todayDate = _localDateKey();
  var stats = TileAPI.storage.get('tasks.stats.today') || { count: 0, success: 0, date: '' };
  if (stats.date !== todayDate) stats = { count: 0, success: 0, date: todayDate };
  stats.count += 1;
  stats.success += generatedCount;
  TileAPI.storage.set('tasks.stats.today', stats);
  TileAPI.storage.set('tasks.stats.lastTime', Date.now());

  // 最近 20 次耗时诊断
  var metrics = TileAPI.state.get('tasks.metrics') || [];
  metrics.unshift({
    t: Date.now(),
    dur: durationMs,
    ok: generatedCount > 0,
    success: generatedCount,
    returned: returnedCount,
    pending: pendingCount,
    fail: failCount,
    model: model
  });
  if (metrics.length > 20) metrics = metrics.slice(0, 20);
  TileAPI.state.set('tasks.metrics', metrics);
  if (generatedCount > 0) {
    TileAPI.state.set('tasks.lastSuccessTime', Date.now());
  }

  TileAPI.emit('tasks:updated');
  // 账单流水 + kao/hemisynth 并发结算靠这个事件 — 字段一个不能少
  TileAPI.emit('generate:complete', {
    taskId: data.taskId, success: generatedCount, fail: failCount,
    generatedSuccess: generatedCount, returned: returnedCount, pending: pendingCount,
    provider: provider,
    model: model,
    size: size,
    engine: engine,
    // v6.5.0: 项目开销统计 — 账单流水按文档记账用
    docName: docName, docPath: docPath
  });

  // telemetry (opt-in)
  try {
    if (window._telemetry) {
      var _elapsedBkt = durationMs < 5000 ? '0-5s'
        : durationMs < 15000 ? '5-15s'
        : durationMs < 60000 ? '15-60s'
        : durationMs < 180000 ? '60-180s' : '180s+';
      window._telemetry.trackTask({
        feature: engine || 'unknown',
        provider: provider || 'unknown',
        model_type: String(model).slice(0, 30),
        size: (width && height) ? (width + 'x' + height) : size,
        batch_size: batchSize,
        result: generatedCount > 0 ? (pendingCount > 0 ? 'partial' : 'success') : 'fail',
        elapsed_bucket: _elapsedBkt,
        error_category: data.error_category || ''
      });
    }
  } catch(_) {}

  // GRS 算力续杯 ping (proxy 路径专属)
  try {
    var taskProvider = provider;
    if (taskProvider === 'grs' && TileAPI.compute && TileAPI.compute.getState) {
      var byokActive = TileAPI.compute.isUserByokActive ? TileAPI.compute.isUserByokActive() : !!(TileAPI.storage.get('connection.grs.key'));
      var cs = TileAPI.compute.getState();
      if (!byokActive && cs && cs.key) {
        var attempts = generatedCount + failCount;
        if (attempts > 0) {
          var usedTotal = TileAPI.compute.estimateCost ? TileAPI.compute.estimateCost(model, attempts) : (1800 * attempts);
          TileAPI.compute.refill(usedTotal, attempts);
        }
      }
    }
  } catch(_) {}

  if (generatedCount > 0) {
    if (pendingCount > 0 && returnedCount > 0) TileAPI.toast('生成完成: ' + returnedCount + '张已返回，' + pendingCount + '张待手动返回', 'warn');
    else if (pendingCount > 0) TileAPI.toast('生成完成: ' + pendingCount + '张待确认', 'info');
    else TileAPI.toast('生成完成: ' + generatedCount + '张已返回', 'success');
  } else {
    TileAPI.toast('生成失败', 'error');
  }
}

// Host 正式回执与少数纯前端工作流共用同一结算器；taskId 去重避免双记账。
TileAPI.onHostMessage('taskComplete', _handleTaskComplete);
TileAPI.on('task:complete', _handleTaskComplete);

TileAPI.onHostMessage('taskReturned', function(data) {
  if (data && data.taskId) {
    var pending = _getPending();
    delete pending[data.taskId];
    TileAPI.state.set('tasks.pending', pending);
    TileAPI.emit('tasks:updated');
    TileAPI.toast('已返回 PS', 'success');
  }
});

TileAPI.onHostMessage('taskAutoReturnFailed', function(data) {
  if (data && data.taskId && data.count > 0) {
    var pending = _getPending();
    if (!pending[data.taskId]) {
      var running = _getRunning();
      var r = running[data.taskId];
      pending[data.taskId] = {
        successCount: data.count,
        failCount: 0,
        time: Date.now(),
        thumbnail: r && r.thumbnail,
        engine: r && r.engine,
        provider: r && r.provider,
        model: r && r.model,
        batchSize: r && r.batchSize,
        width: r && r.width,
        height: r && r.height,
        resolution: r && r.resolution,
        presetTitle: r && r.presetTitle,
        promptSnippet: r && r.promptSnippet,
        docId: r && r.docId,
        docName: r && r.docName,
        docPath: r && r.docPath,
        selection: r && r.selection
      };
      TileAPI.state.set('tasks.pending', pending);
    }
  }
  TileAPI.toast('PS 正忙未能自动返回,请在任务卡片点 ✓ 手动返回 (PS 操作完成后)', 'warn');
});

TileAPI.onHostMessage('taskManualReturnFailed', function(data) {
  TileAPI.toast('返回失败:' + (data && data.error || '未知错误'), 'error');
});

// 公开给 UI 层(生成中心)的工具
window._tasksService = {
  startTicker: _startTicker,
  stopTicker: _stopTicker
};

})();
