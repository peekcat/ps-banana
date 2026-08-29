(function() {
'use strict';

// === 常量 ===
var MODELS = ['AJbanana3', 'AJbanana2', 'AJfudge', 'AJpudding'];
var SIZES = ['1K', '2K', '4K'];

// #6.1: 本次批处理注册到任务列表的所有子任务ID
var _batchSubTaskIds = [];
// #4: 标记本次结束是不是用户主动中断的(中断不清队列, 让用户能续跑)
var _batchStopped = false;

// === 工具函数 ===
function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _getQueue() {
  return TileAPI.state.get('batch.queue') || [];
}

// 落盘时剥掉大图(主图 base64 + 参考图 refImages),只持久化元数据。
// 原来每加一个项目都把"整条队列的所有大图"重新打包写 localStorage + 发后台写文件,
// 加到七八个就因为大图被反复整体复制而内存溢出。现在每项只存 ~1KB 元数据。
// 代价:重载/重启后大图丢失,队列只剩元数据 → onStorageLoaded 检测到无图就清空。
function _stripForSave(q) {
  return (q || []).map(function(item) {
    var copy = {};
    for (var k in item) {
      if (item.hasOwnProperty(k) && k !== 'base64' && k !== 'refImages' && k !== 'taskId') copy[k] = item[k];
    }
    return copy;
  });
}

// 队列落盘用 debounce,避免滚轮微调 count/timeout 时高频写磁盘
var _saveQueueTimer = null;
function _setQueue(q) {
  TileAPI.state.set('batch.queue', q);
  _updateBadge(q);
  if (_saveQueueTimer) clearTimeout(_saveQueueTimer);
  _saveQueueTimer = setTimeout(function() {
    TileAPI.storage.set('batch.savedQueue', _stripForSave(q));
    _saveQueueTimer = null;
  }, 400);
}

function _updateBadge(q) {
  if (typeof TileEngine !== 'undefined' && TileEngine.updateBadge) {
    TileEngine.updateBadge('batch', q.length > 0 ? q.length + '' : '');
  }
}

function _isRunning() {
  return !!TileAPI.state.get('batch.running');
}

function _getConn() {
  if (window._settingsGetActiveConnection) return window._settingsGetActiveConnection();
  var provider = TileAPI.state.get('params.provider') || TileAPI.storage.get('connection.provider') || 'aji';
  return {
    provider: provider,
    url: TileAPI.storage.get('connection.' + provider + '.url') || '',
    key: TileAPI.storage.get('connection.' + provider + '.key') || '',
  };
}

function _cycleValue(arr, current) {
  var idx = arr.indexOf(current);
  return arr[(idx + 1) % arr.length];
}

// 当前激活 provider 的模型 id 列表(从 params 建好的模型视图取, 无自定义时=完整目录)
function _providerModelIds() {
  var provider = TileAPI.state.get('params.provider') || TileAPI.storage.get('connection.provider') || 'aji';
  var cfg = TileAPI.state.get('models.' + provider) || {};
  return Object.keys(cfg);
}

function _clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// === 当前活跃的面板容器（用于外部刷新） ===
var _activeContainer = null;
var _activeLayout = 'wide';

// ========================================
// 磁贴注册
// ========================================
TileAPI.registerTile({
  id: 'batch',
  group: 'main',
  icon: '📋',
  label: '批处理',
  desc: '多任务调度',
  live: true,
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderFront: function(container, w, h) {
    var q = _getQueue();
    var running = _isRunning();
    if (running) {
      container.innerHTML = '<div class="tile-icon">⏳</div><div class="tile-label">批处理中</div>';
    } else if (q.length > 0 && w >= 2) {
      container.innerHTML = '<div class="tile-icon">📋</div><div class="tile-label">批处理</div><div class="tile-desc">队列: ' + q.length + ' 项</div>';
    } else if (q.length > 0) {
      container.innerHTML = '<div class="tile-icon">📋</div><div class="tile-label">队列 ' + q.length + '</div>';
    } else {
      container.innerHTML = '<div class="tile-icon">📋</div><div class="tile-label">批处理</div>';
    }
  },

  renderBack: function(container) {
    var q = _getQueue();
    var running = _isRunning();
    if (running) {
      container.textContent = '批处理运行中';
    } else if (q.length > 0) {
      container.textContent = '队列: ' + q.length + ' 项';
    } else {
      container.textContent = '队列为空';
    }
  },

  onExpand: function(container, sizeHint) {
    var layout = (sizeHint && sizeHint.layout) || 'wide';
    // #6.2: 全局(全屏)展开时无视磁贴宽度, 强制完整布局, 显示全部元素 + 完整功能面板
    if (sizeHint && sizeHint.expandMode === 'full') layout = 'wide';
    _activeContainer = container;
    _activeLayout = layout;
    _renderPanel(container, layout);

    // 监听夏算力 sub-key 到位事件: 拿到后刷新一下面板, 让"请先在设置中配置 API Key"自动消失
    var onKeyReady = function() {
      if (_activeContainer === container) _refreshPanel();
    };
    TileAPI.on('compute:keyUpdated', onKeyReady);

    return function() {
      _activeContainer = null;
      TileAPI.off('compute:keyUpdated', onKeyReady);
    };
  },

  onResize: function(container, w, h) {
    var q = _getQueue();
    var running = _isRunning();
    if (running) {
      container.innerHTML = '<div class="tile-icon">⏳</div><div class="tile-label">批处理中</div>';
    } else if (q.length > 0 && w >= 2) {
      container.innerHTML = '<div class="tile-icon">📋</div><div class="tile-label">批处理</div><div class="tile-desc">队列: ' + q.length + ' 项</div>';
    } else if (q.length > 0) {
      container.innerHTML = '<div class="tile-icon">📋</div><div class="tile-label">队列 ' + q.length + '</div>';
    } else {
      container.innerHTML = '<div class="tile-icon">📋</div><div class="tile-label">批处理</div>';
    }
  },

  onMessage: function(action, data) {
    if (action === 'batchTaskAdded') {
      var q = _getQueue();
      // data 结构:{task: {...}} 或直接 task 对象 → 统一为 task
      var task = (data && data.task) ? data.task : data;
      // 补充前端已知的 presetTitle(后端不持有这个状态)
      task.presetTitle = TileAPI.state.get('prompt.lastPresetTitle') || '';
      q.push(task);
      _setQueue(q);
      TileAPI.toast('已加入队列', 'success');
      _refreshPanel();
    }

    if (action === 'batchStarted') {
      TileAPI.state.set('batch.running', true);
      _refreshPanel();
    }

    if (action === 'batchProgress') {
      // data: { index, total, status }
      TileAPI.state.set('batch.progress', data);
      _refreshPanel();
    }

    if (action === 'batchComplete') {
      TileAPI.state.set('batch.running', false);
      TileAPI.state.set('batch.progress', null);
      _batchSubTaskIds = [];
      // #4: 只有"干净跑完"(host 没报错 ok!==false, 且非用户中断)才清空队列;
      //     出错/中断则保留队列, 让用户重试或续跑。
      var ok = !(data && data.ok === false) && !_batchStopped;
      _batchStopped = false;
      if (ok) _setQueue([]);
      TileAPI.toast(ok ? '批处理完成' : '批处理结束(队列已保留)', ok ? 'success' : 'info');
      _updateBadge(ok ? [] : _getQueue());
      _refreshPanel();
    }
  },

  onStorageLoaded: function(storage) {
    var saved = storage.get('batch.savedQueue');
    if (saved && Array.isArray(saved) && saved.length > 0) {
      // 持久化的队列已不含大图(见 _stripForSave),没图没法继续跑 → 清空并提示。
      // 老版本存的带图队列仍能正常恢复,做向下兼容。
      var hasImg = saved.some(function(it) { return it && it.base64; });
      if (!hasImg) {
        TileAPI.storage.set('batch.savedQueue', []);
        TileAPI.state.set('batch.queue', []);
        _updateBadge([]);
        if (TileAPI && TileAPI.toast) TileAPI.toast('上次的批处理队列已清空(图像未随重启保存)', 'info');
        return;
      }
      TileAPI.state.set('batch.queue', saved);
      _updateBadge(saved);
    }
  },
});

// ========================================
// 面板刷新
// ========================================
function _refreshPanel() {
  if (_activeContainer) {
    _renderPanel(_activeContainer, _activeLayout);
  }
}

// ========================================
// 主面板渲染（按布局分发）
// ========================================
function _renderPanel(container, layout) {
  // 窄/高布局一律用 square 渲染(单列竖排,内容全),避免精简版藏掉队列列表
  if (layout === 'narrow' || layout === 'tall') layout = 'square';
  if (layout === 'narrow' || layout === 'tall') {
    _renderNarrow(container);
  } else if (layout === 'square') {
    _renderSquare(container);
  } else if (layout === 'wideshort') {
    _renderWideShort(container);
  } else {
    _renderWide(container);
  }
}

// ========================================
// narrow/tall 布局：仅计数徽章 + 运行/停止图标按钮
// ========================================
function _renderNarrow(container) {
  var q = _getQueue();
  var running = _isRunning();
  var progress = TileAPI.state.get('batch.progress');

  container.innerHTML =
    '<div class="w10-panel">' +
      '<div class="batch-narrow-stack">' +
        '<div class="batch-narrow-badge">' + q.length + '</div>' +
        (running && progress
          ? '<div class="batch-narrow-progress">' + (progress.index || 0) + '/' + (progress.total || q.length) + '</div>'
          : '') +
        '<button class="w10-btn w10-btn-accent run-btn-big" id="batchNarrowAddBtn">+</button>' +
        (running
          ? '<button class="w10-btn run-btn-big run-btn-stop" id="batchNarrowStopBtn">■</button>'
          : '<button class="w10-btn w10-btn-accent run-btn-big" id="batchNarrowRunBtn">▶</button>') +
      '</div>' +
    '</div>';

  var addBtn = container.querySelector('#batchNarrowAddBtn');
  if (addBtn) addBtn.addEventListener('click', _addToBatch);

  var runBtn = container.querySelector('#batchNarrowRunBtn');
  if (runBtn) runBtn.addEventListener('click', _runBatch);

  var stopBtn = container.querySelector('#batchNarrowStopBtn');
  if (stopBtn) stopBtn.addEventListener('click', _stopBatch);
}

// ========================================
// square 布局：紧凑队列列表（无缩略图）+ 按钮
// ========================================
function _renderSquare(container) {
  var q = _getQueue();
  var running = _isRunning();

  container.innerHTML =
    '<div class="w10-panel">' +
      '<div class="w10-section-title">队列 (' + q.length + ')</div>' +
      '<div class="batch-queue-compact" id="batchQueueCompact"></div>' +
      '<div class="batch-btns-row">' +
        '<button class="w10-btn" id="batchAddBtnSq">+ 加入</button>' +
        (running
          ? '<button class="w10-btn run-btn-stop" id="batchStopBtnSq">■ 停止</button>'
          : '<button class="w10-btn w10-btn-accent" id="batchRunBtnSq">▶ 开始</button>') +
        '<button class="w10-btn" id="batchClearBtnSq" style="color:#ff6b6b;border-color:rgba(255,100,100,0.3)">清空</button>' +
      '</div>' +
    '</div>';

  _renderCompactQueue(container.querySelector('#batchQueueCompact'), q);

  var addBtn = container.querySelector('#batchAddBtnSq');
  if (addBtn) addBtn.addEventListener('click', _addToBatch);

  var runBtn = container.querySelector('#batchRunBtnSq');
  if (runBtn) runBtn.addEventListener('click', _runBatch);

  var stopBtn = container.querySelector('#batchStopBtnSq');
  if (stopBtn) stopBtn.addEventListener('click', _stopBatch);

  var clearBtn = container.querySelector('#batchClearBtnSq');
  if (clearBtn) clearBtn.addEventListener('click', _clearQueue);
}

// ========================================
// wideshort 布局：左侧队列 + 右侧按钮
// ========================================
function _renderWideShort(container) {
  var q = _getQueue();
  var running = _isRunning();
  var progress = TileAPI.state.get('batch.progress');

  container.innerHTML =
    '<div class="w10-panel">' +
      '<div class="batch-horiz">' +
        '<div class="batch-horiz-left">' +
          '<div class="w10-section-title" style="margin-top:0">队列 (' + q.length + ')</div>' +
          '<div class="batch-queue-compact" id="batchQueueWS"></div>' +
        '</div>' +
        '<div class="batch-horiz-right">' +
          '<button class="w10-btn w10-btn-accent" id="batchAddBtnWS" style="width:100%">+ 加入队列</button>' +
          (running
            ? '<button class="w10-btn run-btn-stop" id="batchStopBtnWS" style="width:100%">■ 停止</button>'
            : '<button class="w10-btn w10-btn-accent" id="batchRunBtnWS" style="width:100%">▶ 开始批处理</button>') +
          '<button class="w10-btn" id="batchClearBtnWS" style="width:100%;color:#ff6b6b;border-color:rgba(255,100,100,0.3)">清空队列</button>' +
          (running && progress
            ? '<div class="batch-progress-text">' + (progress.index || 0) + ' / ' + (progress.total || q.length) + ' 完成</div>'
            : '') +
        '</div>' +
      '</div>' +
    '</div>';

  _renderCompactQueue(container.querySelector('#batchQueueWS'), q);

  var addBtn = container.querySelector('#batchAddBtnWS');
  if (addBtn) addBtn.addEventListener('click', _addToBatch);

  var runBtn = container.querySelector('#batchRunBtnWS');
  if (runBtn) runBtn.addEventListener('click', _runBatch);

  var stopBtn = container.querySelector('#batchStopBtnWS');
  if (stopBtn) stopBtn.addEventListener('click', _stopBatch);

  var clearBtn = container.querySelector('#batchClearBtnWS');
  if (clearBtn) clearBtn.addEventListener('click', _clearQueue);
}

// ========================================
// wide 布局：完整队列 + 缩略图 + 可编辑标签
// ========================================
function _renderWide(container) {
  var q = _getQueue();
  var running = _isRunning();
  var progress = TileAPI.state.get('batch.progress');

  container.innerHTML =
    '<div class="w10-panel">' +
      '<div class="w10-section-title">批处理队列</div>' +
      '<div class="batch-queue-full" id="batchQueueFull"></div>' +

      (running && progress
        ? '<div class="batch-progress-bar-wrap">' +
            '<div class="batch-progress-bar" style="width:' + Math.round(((progress.index || 0) / Math.max(1, progress.total || q.length)) * 100) + '%"></div>' +
          '</div>' +
          '<div class="batch-progress-text" style="margin-bottom:8px">' +
            (progress.index || 0) + ' / ' + (progress.total || q.length) + ' 完成' +
            (progress.status ? ' - ' + _esc(progress.status) : '') +
          '</div>'
        : '') +

      '<div class="w10-section-title">操作</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left">' +
          '<div class="w10-row-label">添加到队列</div>' +
          '<div class="w10-row-desc">捕获当前PS选区与参数</div>' +
        '</div>' +
        '<div class="w10-row-right">' +
          '<button class="w10-btn w10-btn-accent" id="batchAddBtnWide">+ 加入队列</button>' +
        '</div>' +
      '</div>' +

      '<div class="w10-row">' +
        '<div class="w10-row-left">' +
          '<div class="w10-row-label">执行批处理</div>' +
          '<div class="w10-row-desc">按顺序执行队列中所有任务</div>' +
        '</div>' +
        '<div class="w10-row-right">' +
          (running
            ? '<button class="w10-btn run-btn-stop" id="batchStopBtnWide">■ 停止全部</button>'
            : '<button class="w10-btn w10-btn-accent" id="batchRunBtnWide">▶ 开始批处理</button>') +
        '</div>' +
      '</div>' +

      '<div class="w10-row">' +
        '<div class="w10-row-left">' +
          '<div class="w10-row-label">清空队列</div>' +
          '<div class="w10-row-desc">移除所有排队任务</div>' +
        '</div>' +
        '<div class="w10-row-right">' +
          '<button class="w10-btn" id="batchClearBtnWide" style="color:#ff6b6b;border-color:rgba(255,100,100,0.3)">清空</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  _renderFullQueue(container.querySelector('#batchQueueFull'), q);

  var addBtn = container.querySelector('#batchAddBtnWide');
  if (addBtn) addBtn.addEventListener('click', _addToBatch);

  var runBtn = container.querySelector('#batchRunBtnWide');
  if (runBtn) runBtn.addEventListener('click', _runBatch);

  var stopBtn = container.querySelector('#batchStopBtnWide');
  if (stopBtn) stopBtn.addEventListener('click', _stopBatch);

  var clearBtn = container.querySelector('#batchClearBtnWide');
  if (clearBtn) clearBtn.addEventListener('click', _clearQueue);
}

// ========================================
// 紧凑队列渲染（square/wideshort 用）
// ========================================
function _renderCompactQueue(area, queue) {
  if (!area) return;
  if (!queue.length) {
    area.innerHTML = '<div class="batch-empty">队列为空 — 点击"加入"添加任务</div>';
    return;
  }
  area.innerHTML = '';
  queue.forEach(function(item, i) {
    var row = document.createElement('div');
    row.className = 'batch-item-compact';
    // 优先显示预设名,否则 prompt 前 50 字
    var shortText = item.presetTitle
      ? _esc(item.presetTitle)
      : _esc((item.prompt || '').split('\n')[0].substr(0, 50));

    // 主图缩略图
    var canJump = item.base64 && item.docId !== undefined && item.selection;
    var mainThumbHtml = item.base64
      ? '<div class="batch-item-thumb-sm"' +
          (canJump ? ' data-jump="' + i + '" title="点击跳转 PS 对应选区"' : '') + '>' +
          '<img src="' + (item.base64.indexOf('data:') === 0 ? item.base64 : 'data:image/png;base64,' + item.base64) + '" alt="">' +
        '</div>'
      : '';

    // 参考图小图标组
    var refImgs = item.refImages || [];
    var refSels = item.refSelections || [];
    var refMiniHtml = '';
    if (refImgs.length) {
      refMiniHtml = '<div class="batch-ref-thumbs-sm">';
      for (var ri = 0; ri < refImgs.length; ri++) {
        var rs = refSels[ri];
        var refCanJump = rs && rs.docId;
        var refB64 = refImgs[ri];
        var refSrc = (refB64 && refB64.indexOf('data:') === 0) ? refB64 : ('data:image/png;base64,' + refB64);
        refMiniHtml += '<div class="batch-ref-thumb-sm"' +
          (refCanJump ? ' data-jumpref="' + i + ':' + ri + '" title="点击跳转 PS 对应选区"' : '') +
          '><img src="' + refSrc + '" alt=""></div>';
      }
      refMiniHtml += '</div>';
    }

    row.innerHTML =
      '<div class="batch-item-idx">' + (i + 1) + '</div>' +
      mainThumbHtml +
      '<div class="batch-item-prompt-short">' + shortText + refMiniHtml + '</div>' +
      '<div class="batch-item-count">' + (item.settings && item.settings.count || 1) + 'x</div>' +
      '<button class="w10-btn batch-item-del" data-batchdel="' + i + '">x</button>';

    var delBtn = row.querySelector('[data-batchdel]');
    if (delBtn) delBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      _removeItem(i);
    });

    // 主图跳转
    var thumbEl = row.querySelector('[data-jump]');
    if (thumbEl) thumbEl.addEventListener('click', function(e) {
      e.stopPropagation();
      if (item.docId !== undefined && item.selection) {
        TileAPI.sendToHost('restoreSelectionFromHistory', { docId: item.docId, selection: item.selection.bounds || item.selection });
        TileAPI.toast('正在跳转...', 'info');
      }
    });

    // 参考图跳转
    var refEls = row.querySelectorAll('[data-jumpref]');
    for (var rj = 0; rj < refEls.length; rj++) {
      (function(el) {
        el.addEventListener('click', function(e) {
          e.stopPropagation();
          var parts = el.getAttribute('data-jumpref').split(':');
          var itemIdx = +parts[0];
          var refIdx = +parts[1];
          var q = _getQueue();
          var it = q[itemIdx];
          if (!it) return;
          var sel = (it.refSelections || [])[refIdx];
          if (sel && sel.docId) {
            TileAPI.sendToHost('restoreSelectionFromHistory', { docId: sel.docId, selection: sel.bounds || sel });
            TileAPI.toast('正在跳转参考图选区...', 'info');
          }
        });
      })(refEls[rj]);
    }

    area.appendChild(row);
  });
}

// ========================================
// 完整队列渲染（wide 用，带缩略图 + 可编辑标签）
// ========================================
function _renderFullQueue(area, queue) {
  if (!area) return;
  if (!queue.length) {
    area.innerHTML = '<div class="batch-empty">队列为空 — 点击"加入队列"捕获当前PS选区与参数</div>';
    return;
  }
  area.innerHTML = '';
  queue.forEach(function(item, i) {
    var s = item.settings || {};
    var card = document.createElement('div');
    card.className = 'batch-item-full';

    // 主图缩略图(有 base64 时可点击跳转 PS 对应选区)
    var canJump = item.base64 && item.docId !== undefined && item.selection;
    var thumbAttrs = canJump ? ' data-jump="' + i + '" title="点击跳转到 PS 选区"' : '';
    var mainSrc = item.base64 ? (item.base64.indexOf('data:') === 0 ? item.base64 : 'data:image/png;base64,' + item.base64) : '';
    var mainThumbHtml = item.base64
      ? '<div class="batch-item-thumb"' + thumbAttrs + '>' +
          '<img src="' + mainSrc + '" alt="">' +
          '<div class="batch-thumb-badge-main">主</div>' +
        '</div>'
      : '<div class="batch-item-thumb batch-item-thumb-empty">无图</div>';

    // 参考图缩略图(若有)
    var refImgs = item.refImages || [];
    var refSels = item.refSelections || [];
    var refThumbsHtml = '';
    if (refImgs.length) {
      refThumbsHtml += '<div class="batch-ref-thumbs">';
      for (var ri = 0; ri < refImgs.length; ri++) {
        var rs = refSels[ri];
        var refCanJump = rs && rs.docId;
        var refB64 = refImgs[ri];
        var refSrc = (refB64 && refB64.indexOf('data:') === 0) ? refB64 : ('data:image/png;base64,' + refB64);
        refThumbsHtml += '<div class="batch-ref-thumb"' +
          (refCanJump ? ' data-jumpref="' + i + ':' + ri + '" title="点击跳转 PS 对应选区"' : '') +
          '><img src="' + refSrc + '" alt=""></div>';
      }
      refThumbsHtml += '</div>';
    }

    // 标签
    var model = s.model || 'AJbanana3';
    var size = s.size || '2K';
    var count = s.count || 1;
    var timeout = s.timeout || 3600;
    // 标题:优先预设名,否则 "#N 文档名"
    var titleText = item.presetTitle
      ? _esc(item.presetTitle)
      : ('#' + (i + 1) + ' ' + _esc(item.docName || '文档'));

    card.innerHTML =
      '<div class="batch-item-thumbs-col">' +
        mainThumbHtml +
        refThumbsHtml +
      '</div>' +
      '<div class="batch-item-body">' +
        '<div class="batch-item-header">' +
          '<span class="batch-item-title">' + titleText + '</span>' +
          '<button class="w10-btn batch-item-del" data-fulldel="' + i + '">x</button>' +
        '</div>' +
        '<div class="batch-item-prompt" data-promptidx="' + i + '">' +
          _esc((item.prompt || '无提示词')) +
        '</div>' +
        '<div class="batch-item-tags">' +
          '<span class="batch-tag batch-tag-model" data-tagmodel="' + i + '">' + _esc(model) + '</span>' +
          '<span class="batch-tag batch-tag-size" data-tagsize="' + i + '">' + _esc(size) + '</span>' +
          '<span class="batch-tag batch-tag-count" data-tagcount="' + i + '">' + count + 'x</span>' +
          '<span class="batch-tag batch-tag-timeout" data-tagtimeout="' + i + '">' + timeout + 's</span>' +
        '</div>' +
      '</div>';

    // 删除按钮
    var delBtn = card.querySelector('[data-fulldel]');
    if (delBtn) delBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      _removeItem(i);
    });

    // 主图缩略图点击 → 跳转 PS 对应选区
    var thumbEl = card.querySelector('[data-jump]');
    if (thumbEl) thumbEl.addEventListener('click', function(e) {
      e.stopPropagation();
      if (item.docId !== undefined && item.selection) {
        TileAPI.sendToHost('restoreSelectionFromHistory', { docId: item.docId, selection: item.selection.bounds || item.selection });
        TileAPI.toast('正在跳转...', 'info');
      }
    });

    // 参考图缩略图点击 → 跳转 PS 对应选区
    var refEls = card.querySelectorAll('[data-jumpref]');
    for (var rj = 0; rj < refEls.length; rj++) {
      (function(el) {
        el.addEventListener('click', function(e) {
          e.stopPropagation();
          var parts = el.getAttribute('data-jumpref').split(':');
          var itemIdx = +parts[0];
          var refIdx = +parts[1];
          var q = _getQueue();
          var it = q[itemIdx];
          if (!it) return;
          var sel = (it.refSelections || [])[refIdx];
          if (sel && sel.docId) {
            TileAPI.sendToHost('restoreSelectionFromHistory', { docId: sel.docId, selection: sel.bounds || sel });
            TileAPI.toast('正在跳转参考图选区...', 'info');
          }
        });
      })(refEls[rj]);
    }

    // 双击提示词 => 内联编辑
    var promptEl = card.querySelector('[data-promptidx]');
    if (promptEl) promptEl.addEventListener('dblclick', function() {
      _inlineEditPrompt(promptEl, i);
    });

    // 点击model标签 => 循环切换
    // bug: 原来固定循环 MODELS(全是 AJI 模型), 批处理用 GRS/墨墨 时会切出对该服务商无效的模型名。
    //   改为按当前激活 provider 的模型视图循环(models.<provider>), 无自定义时=完整目录。
    var modelTag = card.querySelector('[data-tagmodel]');
    if (modelTag) modelTag.addEventListener('click', function() {
      var q = _getQueue();
      if (!q[i]) return;
      if (!q[i].settings) q[i].settings = {};
      var modelList = _providerModelIds();
      if (!modelList.length) modelList = MODELS;   // 视图为空(极端情况)兜底旧列表
      q[i].settings.model = _cycleValue(modelList, q[i].settings.model || modelList[0]);
      _setQueue(q);
      modelTag.textContent = q[i].settings.model;
    });

    // 点击size标签 => 循环切换
    var sizeTag = card.querySelector('[data-tagsize]');
    if (sizeTag) sizeTag.addEventListener('click', function() {
      var q = _getQueue();
      if (!q[i]) return;
      if (!q[i].settings) q[i].settings = {};
      q[i].settings.size = _cycleValue(SIZES, q[i].settings.size || '2K');
      _setQueue(q);
      sizeTag.textContent = q[i].settings.size;
    });

    // 滚轮调整 count
    var countTag = card.querySelector('[data-tagcount]');
    if (countTag) countTag.addEventListener('wheel', function(e) {
      if (window.UIKit && !UIKit.wheelEnabled()) return;   // 滚轮调参开关(默认关)
      e.preventDefault();
      var q = _getQueue();
      if (!q[i]) return;
      if (!q[i].settings) q[i].settings = {};
      var cur = q[i].settings.count || 1;
      cur += (e.deltaY < 0 ? 1 : -1);
      q[i].settings.count = _clamp(cur, 1, 20);
      _setQueue(q);
      countTag.textContent = q[i].settings.count + 'x';
    }, { passive: false });

    // 滚轮调整 timeout
    var timeoutTag = card.querySelector('[data-tagtimeout]');
    if (timeoutTag) timeoutTag.addEventListener('wheel', function(e) {
      if (window.UIKit && !UIKit.wheelEnabled()) return;   // 滚轮调参开关(默认关)
      e.preventDefault();
      var q = _getQueue();
      if (!q[i]) return;
      if (!q[i].settings) q[i].settings = {};
      var cur = q[i].settings.timeout || 3600;
      cur += (e.deltaY < 0 ? 10 : -10);
      q[i].settings.timeout = _clamp(cur, 30, 3600);
      _setQueue(q);
      timeoutTag.textContent = q[i].settings.timeout + 's';
    }, { passive: false });

    area.appendChild(card);
  });
}

// ========================================
// 内联编辑提示词
// ========================================
function _inlineEditPrompt(el, idx) {
  var q = _getQueue();
  if (!q[idx]) return;
  var original = q[idx].prompt || '';

  var input = document.createElement('textarea');
  input.className = 'w10-input batch-inline-edit';
  input.value = original;
  input.rows = 3;
  el.innerHTML = '';
  el.appendChild(input);
  input.focus();

  function _commit() {
    var val = input.value.trim();
    var q2 = _getQueue();
    if (q2[idx]) {
      q2[idx].prompt = val || original;
      _setQueue(q2);
    }
    el.textContent = q2[idx] ? q2[idx].prompt : original;
  }

  input.addEventListener('blur', _commit);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      input.blur();
    }
    if (e.key === 'Escape') {
      input.value = original;
      input.blur();
    }
  });
}

// ========================================
// 操作函数
// ========================================
function _addToBatch() {
  var prompt = TileAPI.state.get('prompt.text');
  if (!prompt || !prompt.trim()) {
    TileAPI.toast('请先输入提示词', 'error');
    return;
  }
  var model = TileAPI.state.get('params.model') || 'AJbanana3';
  var size = TileAPI.state.get('params.size') || '2K';
  var batch = TileAPI.state.get('params.batch') || 1;
  var timeout = TileAPI.state.get('params.timeout') || 3600;
  var antiMode = TileAPI.state.get('params.antiMode') || 0;
  var aspectRatio = TileAPI.state.get('params.aspectRatio') || '1:1';
  var refImages = TileAPI.state.get('refimages.list') || [];
  var refSelections = TileAPI.state.get('refimages.listSelections') || [];
  var layerType = TileAPI.storage.get('output.layerType') || 'smartObject';

  function _doAdd() {
    TileAPI.sendToHost('addToBatch', {
      prompt: prompt, size: size, model: model, aspectRatio: aspectRatio,
      batchSize: batch, timeout: timeout, antiMode: antiMode, layerType: layerType,
      refImages: refImages, refSelections: refSelections,
    });
    TileAPI.toast('正在捕获选区...', 'info');
  }

  // === 比例预警: 加入队列前先探测选区比例和生图比例对不对得上 ===
  if (window.AspectWarn) {
    window.AspectWarn.probeSelection().then(function(probe) {
      var refW, refH;
      if (probe && probe.hasSelection) {
        refW = probe.selWidth; refH = probe.selHeight;
      } else if (probe && probe.docWidth && probe.docHeight) {
        refW = probe.docWidth; refH = probe.docHeight;
      }
      if (refW && refH) {
        var verdict = window.AspectWarn.checkSelVsAspect(refW, refH, aspectRatio);
        if (verdict === 'mismatch') {
          window.AspectWarn.confirmBeforeGenerate({
            selW: refW, selH: refH, aspect: aspectRatio, kind: 'batch'
          }).then(function(yes) { if (yes) _doAdd(); });
          return;
        }
      }
      _doAdd();
    });
  } else {
    _doAdd();
  }
}

function _runBatch() {
  var queue = _getQueue();
  if (!queue.length) {
    TileAPI.toast('队列为空', 'error');
    return;
  }

  var conn = _getConn();
  if (!conn.key) {
    if (conn._grsKeyPending) TileAPI.toast('正在准备夏算力, 请稍后再试', 'info');
    else if (conn._grsNeedLogin) TileAPI.toast('夏算力托管需要登录 (顶栏账号区), 或切回「自带 Key」', 'error');
    else TileAPI.toast('请先在设置中配置 API Key', 'error');
    return;
  }

  // #6.1: 给队列每一项分配子任务ID并登记成一条任务列表条目
  var base = 'batch_' + Date.now();
  var running = TileAPI.state.get('tasks.running') || {};
  var meta = TileAPI.state.get('tasks.meta') || {};
  var autoReturn = TileAPI.storage.get('output.autoReturn') !== false;
  _batchSubTaskIds = [];
  queue.forEach(function(item, i) {
    var subId = base + '_g' + i;
    item.taskId = subId;   // 传给 host, 让进度/完成/中断按这个ID路由
    _batchSubTaskIds.push(subId);
    var st = item.settings || {};
    var cnt = st.count || 1;
    var to = st.timeout || 3600;
    running[subId] = {
      engine: 'banana', provider: conn.provider, batchSize: cnt,
      startTime: Date.now(), success: 0, fail: 0, total: cnt, model: st.model,
      presetTitle: item.presetTitle || '批处理',
      promptSnippet: (item.prompt || '').replace(/\s+/g, ' ').trim().substring(0, 30),
      thumbnail: item.base64 ? ('data:image/png;base64,' + item.base64) : null,
      docId: item.docId, selection: item.selection || null, resolution: st.size
    };
    meta[subId] = { countdown: to, timeoutSec: to, autoReturn: autoReturn, batchSize: cnt };
  });
  TileAPI.state.set('tasks.running', running);
  TileAPI.state.set('tasks.meta', meta);
  TileAPI.emit('tasks:updated');
  _batchSubTaskIds.forEach(function(subId) {
    var m = meta[subId];
    TileAPI.emit('task:started', { taskId: subId, timeoutSec: m.timeoutSec, batchSize: m.batchSize });
  });

  TileAPI.sendToHost('runBatch', {
    queue: queue,
    params: {
      apiKey: conn.key,
      apiBaseUrl: conn.url,
      provider: conn.provider,
      autoReturn: autoReturn,
    },
  });

  TileAPI.state.set('batch.running', true);
  _refreshPanel();
  TileAPI.toast('批处理已启动', 'success');
}

function _stopBatch() {
  _batchStopped = true;   // #4: 标记中断, batchComplete 时不清队列(可续跑)
  // #6.1: 只停本批的子任务, 不误杀其它磁贴正在跑的任务
  if (_batchSubTaskIds && _batchSubTaskIds.length) {
    _batchSubTaskIds.forEach(function(tid) { TileAPI.sendToHost('earlyStopTask', { taskId: tid }); });
  } else {
    TileAPI.sendToHost('earlyStop');
  }
  TileAPI.state.set('batch.running', false);
  TileAPI.toast('正在停止批处理...', 'info');
  _refreshPanel();
}

function _clearQueue() {
  var q = _getQueue();
  if (!q.length) {
    TileAPI.toast('队列已经为空', 'info');
    return;
  }
  TileAPI.confirm('确定清空队列中的 ' + q.length + ' 项任务？').then(function(yes) {
    if (!yes) return;
    _setQueue([]);
    TileAPI.storage.set('batch.savedQueue', []);
    TileAPI.toast('队列已清空', 'info');
    _refreshPanel();
  });
}

function _removeItem(idx) {
  var q = _getQueue();
  if (idx < 0 || idx >= q.length) return;
  q.splice(idx, 1);
  _setQueue(q);
  _refreshPanel();
}

})();
