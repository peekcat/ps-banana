// ============================================================
//  tile-sync.js — 预设云同步磁贴
//  从独立预设服务器拉取 banana 预设,比对本地缺失,导入
//  不上传、不登录、不自动同步 — 参考 5.4.6 设计
// ============================================================
(function() {
'use strict';

// ========== 工具 ==========
function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _uid() {
  return 'p_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

// 登录态检查 (跟客服磁贴口径一致: state.cloud.loggedIn + storage.cloud.token 都有才算登录)
function _isLoggedIn() {
  return !!TileAPI.state.get('cloud.loggedIn') && !!TileAPI.storage.get('cloud.token');
}

// 未登录冻结面板 — 跟 tile-support 一样的"去登录"风格
function _renderLoginGate(container) {
  container.innerHTML =
    '<div class="w10-panel">' +
      '<div class="w10-section-title">☁️ 预设同步</div>' +
      '<div class="support-empty" style="padding:24px;text-align:center;line-height:1.8">' +
        '🔐 预设同步需要 <b>登录</b> 后才能使用<br>' +
        '<span style="font-size:12px;color:var(--text-sub,#888)">登录后才能从云端拉取最新预设</span><br><br>' +
        '<button class="support-send-btn" id="syncGotoLoginBtn">去登录</button>' +
      '</div>' +
    '</div>';
  var loginBtn = container.querySelector('#syncGotoLoginBtn');
  if (loginBtn) loginBtn.addEventListener('click', function() {
    if (TileAPI && typeof TileAPI.expandTile === 'function') {
      TileAPI.expandTile('topbar');
    } else {
      TileAPI.toast('请打开顶部账号面板登录', 'info');
    }
  });
}

// ========== 分类定义(和 tile-bodypreset 对齐) ==========
var CATS = [
  { id:'head', name:'头部面部', icon:'🧠' },
  { id:'hair', name:'头发', icon:'💇' },
  { id:'neck', name:'颈部', icon:'🦴' },
  { id:'torso', name:'躯干腰腹', icon:'👔' },
  { id:'arms', name:'手臂', icon:'💪' },
  { id:'hands', name:'手部', icon:'🤚' },
  { id:'legs', name:'腿部', icon:'🦵' },
  { id:'feet', name:'脚部', icon:'🦶' },
  { id:'clothing', name:'服装', icon:'👗' },
  { id:'accessory', name:'配饰', icon:'💍' },
  { id:'fullbody', name:'全身', icon:'🧍' },
  { id:'lighting', name:'光影', icon:'💡' },
  { id:'background', name:'背景', icon:'🏞️' },
  { id:'weapon', name:'武器', icon:'🗡️' },
  { id:'cleanup', name:'去杂物', icon:'🧹' },
  { id:'effects', name:'特效', icon:'✨' },
  { id:'other', name:'其他', icon:'📦' }
];
function catById(id) {
  for (var i = 0; i < CATS.length; i++) if (CATS[i].id === id) return CATS[i];
  return null;
}

// ========== 模块状态 ==========
var _activeContainer = null;
var _cloudPresetsAll = [];     // 所有云端预设(拉全后填充)
var _cloudPresets = [];        // 本地缺失的云端预设
var _pendingFiles = 0;         // 正在 fetch 的文件数
var _fetching = false;         // 是否在拉取中
var _level = 0;                // 0 = 分类网格, 1 = 分类详情
var _currentCat = null;        // 当前钻入的分类 id
var _batchImportPending = null; // 批量导入完成时清空:{ timeStart, total, remaining }

// 增量同步缓存 (按文件 hash 比对, 命中就跳过下载)
//   hashes:  { 'foo.json': 'abc123...' }
//   presets: { 'foo.json': { ...预设内容... } }
// 空 hash (老服务端 fallback) 不写入缓存, 每次都重新下
var SYNC_CACHE_KEY = 'sync.cloudCache.v1';
var _cloudCache = null;
var _pendingSync = null;       // 当前一轮同步会话: { newCache, toFetchCount, items }

function _loadCloudCache() {
  if (_cloudCache) return _cloudCache;
  var c = TileAPI.storage.get(SYNC_CACHE_KEY);
  if (!c || typeof c !== 'object') c = {};
  if (!c.hashes || typeof c.hashes !== 'object') c.hashes = {};
  if (!c.presets || typeof c.presets !== 'object') c.presets = {};
  _cloudCache = c;
  return c;
}
function _saveCloudCache() {
  if (_cloudCache) TileAPI.storage.set(SYNC_CACHE_KEY, _cloudCache);
}

// ========== 本地比对(读 tile-presets 的 state) ==========
function _getLocalPresets() {
  var list = TileAPI.state.get('presets.list') || [];
  // 只看 banana 预设,不算 forge
  return list.filter(function(p) { return !p._isForge; });
}
function _buildLocalSet() {
  var ids = {}, titles = {};
  var locals = _getLocalPresets();
  for (var i = 0; i < locals.length; i++) {
    var p = locals[i];
    if (p.id) ids[p.id] = true;
    if (p.title) titles[p.title] = true;
  }
  return { ids: ids, titles: titles };
}
function _isLocalExist(p, localSet) {
  if (p.id && localSet.ids[p.id]) return true;
  if (p.title && localSet.titles[p.title]) return true;
  return false;
}
function _recomputeMissing() {
  var localSet = _buildLocalSet();
  _cloudPresets = _cloudPresetsAll.filter(function(p) { return !_isLocalExist(p, localSet); });
}

// ========== 导入(发 host + 本地 state) ==========
function _importPresets(items) {
  if (!items || !items.length) return;
  var list = TileAPI.state.get('presets.list') || [];
  var added = 0;
  var importedItems = [];
  for (var i = 0; i < items.length; i++) {
    var p = items[i];
    if (!p || !p.title) continue;
    // 保险再去重
    var dup = false;
    for (var j = 0; j < list.length; j++) {
      if ((p.id && list[j].id === p.id) || (p.title && list[j].title === p.title)) { dup = true; break; }
    }
    if (dup) continue;
    if (!p.id) p.id = _uid();
    p._isFactory = false;
    list.push(p);
    importedItems.push(p);
    added++;
  }
  // 只更新 state,不再写 storage(文件系统是唯一真相源,已修过双写灾难)
  TileAPI.state.set('presets.list', list);
  // 关键:host savePresetsFile 字段名是 data.presets(数组),之前写 preset 永远静默 return
  TileAPI.sendToHost('savePresetsFile', { action: 'import', presets: importedItems });
  // 通知其他磁贴(尤其 tile-presets)刷新
  TileAPI.emit('presets:changed');
  return added;
}

// ========== 磁贴注册 ==========
TileAPI.registerTile({
  id: 'sync',
  group: 'main',
  icon: '☁️',
  label: '预设同步',
  desc: '云端预设导入',
  live: false,
  defaultSize: { w: 2, h: 2 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderFront: function(container, w, h) {
    var missing = _cloudPresets.length;
    var icon = '☁️';
    if (w >= 2) {
      var desc = missing > 0 ? missing + ' 个可更新' : (_cloudPresetsAll.length ? '已全部同步' : '点击获取列表');
      container.innerHTML =
        '<div class="tile-icon">' + icon + '</div>' +
        '<div class="tile-label">预设同步</div>' +
        '<div class="tile-desc">' + desc + '</div>';
    } else {
      container.innerHTML = '<div class="tile-icon">' + icon + '</div><div class="tile-label">同步</div>';
    }
  },

  renderBack: function(container) {
    container.textContent = _cloudPresets.length > 0
      ? _cloudPresets.length + ' 个可更新'
      : (_cloudPresetsAll.length ? '已同步' : '未获取');
  },

  onExpand: function(container, sizeHint) {
    var layout = (sizeHint && sizeHint.layout) || 'wide';
    _activeContainer = container;

    // 未登录冻结
    if (!_isLoggedIn()) {
      _renderLoginGate(container);
      return function() { _activeContainer = null; };
    }

    _level = 0;
    _currentCat = null;
    _renderPanel(container, layout);

    return function() {
      _activeContainer = null;
    };
  },

  onMessage: function(action, data) {
    _handleMessage(action, data);
  }
});

// ========== 消息处理 ==========
function _handleMessage(action, data) {
  var container = _activeContainer;

  if (action === 'syncFetchManifestResult') {
    if (!data || !data.success) {
      _fetching = false;
      _pendingSync = null;
      _setStatus((data && data.error) ? ('获取清单失败: ' + data.error) : '获取清单失败', 'err');
      _updateFetchBtn();
      return;
    }
    var items = data.items || [];
    if (!items.length) {
      _fetching = false;
      _pendingSync = null;
      _cloudPresetsAll = [];
      _cloudPresets = [];
      _setStatus('服务器上没有预设', 'warn');
      _updateFetchBtn();
      _rerenderContent();
      return;
    }
    // 跟缓存比对, 决定哪些要重新下
    var cache = _loadCloudCache();
    var newCache = { hashes: {}, presets: {} };
    var reusePresets = [];
    var toFetch = [];
    items.forEach(function(item) {
      var fn = item.file;
      var hash = item.hash || '';
      // 空 hash = 老服务端, 必须重下
      if (hash && cache.hashes[fn] === hash && cache.presets[fn]) {
        newCache.hashes[fn] = hash;
        newCache.presets[fn] = cache.presets[fn];
        reusePresets.push(cache.presets[fn]);
      } else {
        // 新下载: 先把 hash 记进 newCache (preset 等 syncFetchOneResult 回来才填)
        // 空 hash 不写 → 老服务端 fallback 不缓存
        if (hash) newCache.hashes[fn] = hash;
        toFetch.push(item);
      }
    });

    // 准备本轮会话
    _pendingSync = { newCache: newCache, toFetchCount: toFetch.length, totalCount: items.length };
    _cloudPresetsAll = reusePresets.slice();
    _pendingFiles = toFetch.length;

    if (toFetch.length === 0) {
      // 全部命中缓存, 立刻收尾
      _finalizeSync();
      return;
    }
    _setStatus('清单 ' + items.length + ' 个, 命中缓存 ' + reusePresets.length + ' 个, 需下载 ' + toFetch.length + ' 个...', '');
    toFetch.forEach(function(item) {
      TileAPI.sendToHost('syncFetchOne', { file: item.file });
    });
    return;
  }

  // 兼容: 老调用路径 (理论上现已不再触发, 保留兜底)
  if (action === 'syncFetchListResult') {
    if (!data || !data.success) {
      _fetching = false;
      _setStatus((data && data.error) ? ('获取列表失败: ' + data.error) : '获取列表失败', 'err');
      _updateFetchBtn();
      return;
    }
    var files = data.files || [];
    if (!files.length) {
      _fetching = false;
      _setStatus('服务器上没有预设', 'warn');
      _updateFetchBtn();
      return;
    }
    _pendingSync = { newCache: { hashes: {}, presets: {} }, toFetchCount: files.length, totalCount: files.length };
    _cloudPresetsAll = [];
    _cloudPresets = [];
    _pendingFiles = files.length;
    _setStatus('正在下载 ' + files.length + ' 个预设...', '');
    files.forEach(function(f) { TileAPI.sendToHost('syncFetchOne', { file: f }); });
    return;
  }

  if (action === 'syncFetchOneResult') {
    _pendingFiles = Math.max(0, _pendingFiles - 1);
    if (data && data.success && data.preset && data.preset.title) {
      _cloudPresetsAll.push(data.preset);
      // 写入本轮缓存 (有 file 才存; manifest 流转会带 file 字段, 老路径也带)
      if (_pendingSync && data.file) {
        _pendingSync.newCache.presets[data.file] = data.preset;
        // hash 不在 syncFetchOneResult 里, 由 manifest 阶段记下的 hash 决定. 这里只补 preset.
      }
    }
    if (_pendingFiles > 0) {
      _setStatus('下载中... 剩余 ' + _pendingFiles, '');
    } else {
      _finalizeSync();
    }
    return;
  }
}

// 当前同步会话收尾: 保存缓存, 比对本地, 重绘
function _finalizeSync() {
  _fetching = false;
  var downloaded = 0;
  if (_pendingSync) {
    // newCache.hashes 已在 manifest 阶段填好 (含命中缓存的 + 本次下载的)
    // newCache.presets 命中缓存的提前填好; 本次下载的在 syncFetchOneResult 里追加
    // 没下载成功的文件 hash 在但 preset 没在 → 下次访问视为 miss (hashes[fn] 命中但 presets[fn] 缺失), 会重下
    downloaded = _pendingSync.toFetchCount || 0;
    _cloudCache = _pendingSync.newCache;
    _saveCloudCache();
    _pendingSync = null;
  }
  _recomputeMissing();
  var total = _cloudPresetsAll.length;
  var miss = _cloudPresets.length;
  if (downloaded === 0) {
    // 服务端跟本地缓存完全一致, 没下任何东西 → 明确提示
    _setStatus('✓ 已是最新, 共 ' + total + ' 个预设, 服务端无变化', 'ok');
    if (miss === 0) {
      TileAPI.toast('预设已最新, 无需更新', 'info');
    } else {
      TileAPI.toast('云端无变化, 但本地缺 ' + miss + ' 个 (点📥导入)', 'info');
    }
  } else if (miss > 0) {
    _setStatus('已同步 ' + downloaded + ' 个更新, 共 ' + total + ' 个预设, 其中 ' + miss + ' 个本地缺失', 'ok');
  } else {
    _setStatus('已同步 ' + downloaded + ' 个更新, 共 ' + total + ' 个预设, 本地已全部同步', 'ok');
  }
  _updateFetchBtn();
  _rerenderContent();
}

// ========== 渲染入口 ==========
function _renderPanel(container, layout) {
  // 窄/高布局一律用 browser 渲染(全内容含分类网格),避免精简版只剩 status+fetch+import
  if (layout === 'narrow' || layout === 'tall') layout = 'square';
  var isNarrow = (layout === 'narrow' || layout === 'tall');
  var isWideShort = (layout === 'wideshort');

  if (isNarrow) { _renderNarrow(container); return; }
  if (isWideShort) { _renderWideShort(container); return; }

  // square / wide: 浏览器式
  _renderBrowser(container);
}

// ========== 浏览器视图(square/wide) ==========
function _renderBrowser(container) {
  var hasData = _cloudPresetsAll.length > 0;

  container.innerHTML =
    '<div class="w10-panel sync-panel">' +
      '<div class="sync-top-bar">' +
        '<button class="w10-btn w10-btn-accent" id="syncFetchBtn">' +
          (_fetching ? '获取中...' : (hasData ? '🔄 重新获取' : '🔄 获取列表')) +
        '</button>' +
        (_cloudPresets.length > 0
          ? '<button class="w10-btn sync-import-all" id="syncImportAllBtn" title="把所有本地没有的云端预设一次性全部导入">📥 一键同步全部预设 (' + _cloudPresets.length + ')</button>'
          : '') +
      '</div>' +
      '<div class="sync-status" id="syncStatus"></div>' +
      '<div class="sync-body" id="syncBody"></div>' +
    '</div>';

  _bindTopBar(container);
  _rerenderContent();
}

// 根据当前 level 刷内容区
function _rerenderContent() {
  var container = _activeContainer;
  if (!container) return;
  var body = container.querySelector('#syncBody');
  if (!body) return;

  if (_cloudPresetsAll.length === 0) {
    // 还没拉过数据 → 显示使用说明
    if (_fetching) {
      body.innerHTML = '<div class="sync-empty">⏳ 正在获取预设...</div>';
    } else {
      body.innerHTML = _renderHelpPanel();
    }
    return;
  }

  if (_level === 0) {
    body.innerHTML = _renderHelpBar() + _renderCatGrid();
    _bindCatGrid(container);
    _bindHelpBar(container);
  } else {
    body.innerHTML = _renderCatDetail(_currentCat);
    _bindCatDetail(container);
  }
}

// ========== 使用说明 ==========

// 首次打开时的完整引导说明(替代原来的一行空状态提示)
function _renderHelpPanel() {
  return '<div class="sync-help-panel">' +
    '<div class="sync-help-title">☁️ 预设同步是什么?</div>' +
    '<div class="sync-help-text">' +
      '作者和社区把整理好的优质提示词预设发到<b>云端仓库</b>，这个磁贴帮你把新预设<b>下载到本地</b>使用。' +
    '</div>' +

    '<div class="sync-help-title">📋 使用步骤</div>' +
    '<ol class="sync-help-steps">' +
      '<li>点击顶部 <b>"🔄 获取列表"</b> 从云端拉取最新预设清单</li>' +
      '<li>系统会自动和你本地预设比对，标出<b>缺失的</b>和<b>已有的</b></li>' +
      '<li>按分类浏览，或直接点 <b>"📥 一键同步全部预设"</b> 全量导入</li>' +
    '</ol>' +

    '<div class="sync-help-title">⚙️ 同步逻辑</div>' +
    '<ul class="sync-help-rules">' +
      '<li><b>只下载不上传</b>：云端预设单向流入本地</li>' +
      '<li><b>智能去重</b>：按预设名和 ID 比对，<b>不会覆盖</b>你已有的同名预设</li>' +
      '<li><b>免登录</b>：预设服务器公开，无需账号</li>' +
      '<li><b>仅普通预设</b>：Forge 专属预设由 Forge 磁贴单独管理</li>' +
    '</ul>' +

    '<div class="sync-help-hint">' +
      '💡 建议定期点击"获取列表"检查是否有新预设更新' +
    '</div>' +
  '</div>';
}

// 已拉取后的精简提示栏(可折叠)
function _renderHelpBar() {
  var collapsed = TileAPI.storage.get('sync.helpBarCollapsed');
  if (collapsed) {
    return '<div class="sync-help-bar sync-help-bar-collapsed" id="syncHelpBar">' +
      '<span>💡 使用说明</span>' +
      '<button class="sync-help-toggle" data-helptoggle="open">▸</button>' +
    '</div>';
  }
  return '<div class="sync-help-bar" id="syncHelpBar">' +
    '<div class="sync-help-bar-row">' +
      '<span class="sync-help-bar-icon">💡</span>' +
      '<span class="sync-help-bar-text">' +
        '点分类卡片看详情 · 单条点 📥 导入 · 顶部"一键同步"全量导入 · 本地已有不会被覆盖' +
      '</span>' +
      '<button class="sync-help-toggle" data-helptoggle="close" title="收起">▾</button>' +
    '</div>' +
  '</div>';
}

function _bindHelpBar(container) {
  var btns = container.querySelectorAll('[data-helptoggle]');
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function(e) {
      e.stopPropagation();
      var action = this.getAttribute('data-helptoggle');
      TileAPI.storage.set('sync.helpBarCollapsed', action === 'close');
      _rerenderContent();
    });
  }
}

// --- 分类网格 ---
function _renderCatGrid() {
  // 统计每个分类的 missing / total
  var missingMap = {}, totalMap = {};
  _cloudPresetsAll.forEach(function(p) {
    var c = p.category || 'other';
    totalMap[c] = (totalMap[c] || 0) + 1;
  });
  _cloudPresets.forEach(function(p) {
    var c = p.category || 'other';
    missingMap[c] = (missingMap[c] || 0) + 1;
  });

  var html = '<div class="sync-cat-grid">';
  CATS.forEach(function(cat) {
    var miss = missingMap[cat.id] || 0;
    var total = totalMap[cat.id] || 0;
    var cls = 'sync-cat-card';
    if (total === 0) cls += ' sync-cat-empty';
    else if (miss === 0) cls += ' sync-cat-done';
    else cls += ' sync-cat-miss';

    var badge = '';
    if (total > 0) {
      badge = miss > 0
        ? '<span class="sync-cat-badge sync-cat-badge-miss">' + miss + ' 可更新</span>'
        : '<span class="sync-cat-badge sync-cat-badge-done">已完整</span>';
    }

    html += '<div class="' + cls + '" data-cat="' + cat.id + '">' +
      '<span class="sync-cat-icon">' + cat.icon + '</span>' +
      '<span class="sync-cat-name">' + _esc(cat.name) + '</span>' +
      (total > 0 ? '<span class="sync-cat-count">' + (total - miss) + '/' + total + '</span>' : '') +
      badge +
    '</div>';
  });
  html += '</div>';
  return html;
}

function _bindCatGrid(container) {
  var cards = container.querySelectorAll('.sync-cat-card[data-cat]');
  for (var i = 0; i < cards.length; i++) {
    (function(card) {
      card.addEventListener('click', function() {
        if (card.classList.contains('sync-cat-empty')) return;
        var catId = card.getAttribute('data-cat');
        _level = 1;
        _currentCat = catId;
        _rerenderContent();
      });
    })(cards[i]);
  }
}

// --- 分类详情 ---
function _renderCatDetail(catId) {
  var cat = catById(catId);
  if (!cat) return '<div class="sync-empty">分类不存在</div>';

  var localSet = _buildLocalSet();
  var allInCat = _cloudPresetsAll.filter(function(p) { return (p.category || 'other') === catId; });
  var missingInCat = allInCat.filter(function(p) { return !_isLocalExist(p, localSet); });
  var existInCat = allInCat.filter(function(p) { return _isLocalExist(p, localSet); });

  var html = '' +
    '<div class="sync-detail-header">' +
      '<button class="sync-back-btn" id="syncBackBtn">× 返回</button>' +
      '<span class="sync-detail-title">' + cat.icon + ' ' + _esc(cat.name) + '</span>' +
      '<span class="sync-detail-count">' + missingInCat.length + ' 可更新 / ' + allInCat.length + ' 总计</span>' +
    '</div>';

  if (allInCat.length === 0) {
    return html + '<div class="sync-empty">此分类暂无远程预设</div>';
  }

  // "分类内全部缺失导入"按钮
  if (missingInCat.length > 0) {
    html += '<button class="w10-btn sync-import-cat-btn" data-importcat="' + catId + '">' +
      '📥 导入此分类所有缺失 (' + missingInCat.length + ')' +
    '</button>';
  }

  html += '<div class="sync-preset-list">';

  // 先列缺失
  missingInCat.forEach(function(p, idx) {
    html += _renderPresetItem(p, true, idx);
  });

  // 分隔线 + 已有
  if (existInCat.length > 0) {
    html += '<div class="sync-divider">── 本地已有 (' + existInCat.length + ') ──</div>';
    existInCat.forEach(function(p, idx) {
      html += _renderPresetItem(p, false, idx + missingInCat.length);
    });
  }

  html += '</div>';
  return html;
}

function _renderPresetItem(p, isMissing, idx) {
  var tag = isMissing
    ? '<span class="sync-tag sync-tag-miss">缺失</span>'
    : '<span class="sync-tag sync-tag-have">已有</span>';
  var preview = '';
  if (p.content) {
    var s = String(p.content).replace(/\s+/g, ' ').trim();
    if (s.length > 60) s = s.slice(0, 60) + '...';
    preview = '<div class="sync-item-preview">' + _esc(s) + '</div>';
  }
  var action = isMissing
    ? '<button class="sync-item-btn sync-item-btn-import" data-importidx="' + idx + '">📥</button>'
    : '<span class="sync-item-check">✓</span>';
  return '<div class="sync-item' + (isMissing ? '' : ' sync-item-have') + '" data-idx="' + idx + '">' +
    '<div class="sync-item-info">' +
      '<div class="sync-item-title">' + tag + _esc(p.title || '未命名') + '</div>' +
      preview +
    '</div>' +
    action +
  '</div>';
}

function _bindCatDetail(container) {
  // 返回
  var backBtn = container.querySelector('#syncBackBtn');
  if (backBtn) backBtn.addEventListener('click', function() {
    _level = 0;
    _currentCat = null;
    _rerenderContent();
  });

  // 分类内全部缺失导入
  var importCatBtn = container.querySelector('[data-importcat]');
  if (importCatBtn) importCatBtn.addEventListener('click', function() {
    var cid = importCatBtn.getAttribute('data-importcat');
    var localSet = _buildLocalSet();
    var toImport = _cloudPresetsAll.filter(function(p) {
      return (p.category || 'other') === cid && !_isLocalExist(p, localSet);
    });
    if (!toImport.length) return;
    var n = _importPresets(toImport);
    TileAPI.toast('已导入 ' + n + ' 个' + (catById(cid) ? catById(cid).name : '') + '预设', 'success');
    _recomputeMissing();
    _rerenderContent();
    _updateFetchBtn();
  });

  // 单条导入
  var btns = container.querySelectorAll('[data-importidx]');
  for (var i = 0; i < btns.length; i++) {
    (function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        // 点击的是哪个预设? 直接从当前分类的 missing 列表按 idx 取
        // 但 idx 是整个详情列表的索引,需要重新计算
        var cid = _currentCat;
        if (!cid) return;
        var localSet = _buildLocalSet();
        var allInCat = _cloudPresetsAll.filter(function(p) { return (p.category || 'other') === cid; });
        var missingInCat = allInCat.filter(function(p) { return !_isLocalExist(p, localSet); });
        var realIdx = parseInt(btn.getAttribute('data-importidx'), 10);
        var p = missingInCat[realIdx];
        if (!p) return;
        _importPresets([p]);
        TileAPI.toast('已导入: ' + (p.title || '未命名'), 'success');
        _recomputeMissing();
        _rerenderContent();
        _updateFetchBtn();
      });
    })(btns[i]);
  }
}

// ========== narrow / wideshort 简化版 ==========
function _renderNarrow(container) {
  var miss = _cloudPresets.length;
  var total = _cloudPresetsAll.length;
  var statusText = total === 0
    ? (_fetching ? '获取中' : '未获取')
    : (miss > 0 ? miss + '/' + total + ' 可更新' : '全部已同步');

  container.innerHTML =
    '<div class="w10-panel sync-panel sync-panel-narrow">' +
      '<div class="sync-narrow-stat">' +
        '<div class="sync-narrow-num">' + (miss > 0 ? miss : (total || '--')) + '</div>' +
        '<div class="sync-narrow-label">' + statusText + '</div>' +
      '</div>' +
      '<button class="w10-btn w10-btn-accent sync-narrow-btn" id="syncFetchBtn">' +
        (_fetching ? '⏳' : '🔄 获取') +
      '</button>' +
      (miss > 0
        ? '<button class="w10-btn sync-narrow-btn" id="syncImportAllBtn">📥 同步预设</button>'
        : '') +
    '</div>';

  _bindTopBar(container);
}

function _renderWideShort(container) {
  var miss = _cloudPresets.length;
  var total = _cloudPresetsAll.length;
  var statusText = total === 0
    ? (_fetching ? '正在获取云端预设...' : '点击获取云端预设列表')
    : (miss > 0
      ? miss + ' 个缺失 / 共 ' + total
      : '全部 ' + total + ' 个预设已同步');

  container.innerHTML =
    '<div class="w10-panel sync-panel sync-panel-wideshort">' +
      '<div class="sync-wideshort-strip">' +
        '<span class="sync-wideshort-icon">☁️</span>' +
        '<span class="sync-wideshort-text">' + statusText + '</span>' +
        '<button class="w10-btn w10-btn-accent" id="syncFetchBtn">' +
          (_fetching ? '⏳ 获取中' : '🔄 获取列表') +
        '</button>' +
        (miss > 0
          ? '<button class="w10-btn sync-import-all" id="syncImportAllBtn" title="把所有本地没有的云端预设一次性全部导入">📥 一键同步全部预设 (' + miss + ')</button>'
          : '') +
      '</div>' +
    '</div>';

  _bindTopBar(container);
}

// ========== 顶部栏事件 ==========
function _bindTopBar(container) {
  var fetchBtn = container.querySelector('#syncFetchBtn');
  if (fetchBtn) fetchBtn.addEventListener('click', function() {
    if (_fetching) return;
    _fetching = true;
    _setStatus('正在获取清单...', '');
    fetchBtn.disabled = true;
    fetchBtn.textContent = '获取中...';
    TileAPI.sendToHost('syncFetchManifest', {});
    _rerenderContent();
    // 30s 超时兜底
    setTimeout(function() {
      if (_fetching && _pendingFiles > 0) {
        _fetching = false;
        _pendingSync = null;
        _setStatus('部分预设下载超时, 请重试', 'warn');
        _updateFetchBtn();
      }
    }, 30000);
  });

  var importAllBtn = container.querySelector('#syncImportAllBtn');
  if (importAllBtn) importAllBtn.addEventListener('click', function() {
    if (!_cloudPresets.length) return;
    var n = _importPresets(_cloudPresets.slice());
    TileAPI.toast('已同步 ' + n + ' 个预设', 'success');
    _recomputeMissing();
    _updateFetchBtn();
    _rerenderContent();
  });
}

function _updateFetchBtn() {
  var container = _activeContainer;
  if (!container) return;
  var btn = container.querySelector('#syncFetchBtn');
  if (btn) {
    btn.disabled = false;
    btn.textContent = _cloudPresetsAll.length ? '🔄 重新获取' : '🔄 获取列表';
  }
  // 更新导入按钮和状态(整面板重绘)
  var layout = container._layoutType || 'wide';
  // 窄/高布局一律用 browser 渲染(跟 _renderPanel 保持一致)
  if (layout === 'narrow' || layout === 'tall') layout = 'square';
  var isNarrow = (layout === 'narrow' || layout === 'tall');
  var isWideShort = (layout === 'wideshort');
  if (isNarrow) _renderNarrow(container);
  else if (isWideShort) _renderWideShort(container);
  // square/wide 通过 _rerenderContent 刷新主体,按钮在 top-bar,需要重绘整个 panel
  else _renderBrowser(container);
}

function _setStatus(msg, cls) {
  var container = _activeContainer;
  if (!container) return;
  var el = container.querySelector('#syncStatus');
  if (el) {
    el.textContent = msg;
    el.className = 'sync-status' + (cls ? ' sync-status-' + cls : '');
  }
}

// 登录态变化 → 展开中的面板自动刷新
if (TileAPI && typeof TileAPI.on === 'function') {
  TileAPI.on('auth:loggedIn', function() {
    if (!_activeContainer) return;
    _level = 0;
    _currentCat = null;
    _renderPanel(_activeContainer, 'wide');
  });
  TileAPI.on('auth:loggedOut', function() {
    if (!_activeContainer) return;
    _renderLoginGate(_activeContainer);
  });
}

})();
