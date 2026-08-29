(function() {
'use strict';

// ============================================================
//  tile-records.js — 🗂 生成记录 (回收站 + 历史 合并, v6.4.8)
//
//  统一时间线: 数据源只剩回收站(host 持久, recycle_bin/index.json),
//  老"历史"的 storage(history.list) 废弃。每个 batchId 组一张卡:
//  缩略图 + 预设名/提示词 + [载入提示词][恢复选区] 按钮 + 展开看单张。
//
//  继承回收站: 分页/过滤/搜索/清空/懒加载缩略图/预览模态(贴回/删/复制)
//  继承历史:   载入提示词(含 Forge 参数快照还原)/恢复选区
//  新字段:     presetTitle/presetKind/forgeSnapshot/promptProtected(半合成打码)
//  老数据降级: 没 presetTitle 显示提示词截断; 没快照的 Forge 只回填提示词
//
//  注意: #rbFilter/#rbSearch/#rbClearBtn/#rbGrid 等 id 与旧回收站同名,
//  教程(tile-tutorial)的内部选择器步骤依赖这些 id, 不要改名。
// ============================================================

var PAGE_SIZE = 60;
var _items = [];
var _total = 0;
var _offset = 0;
var _filterStatus = '';
var _searchPrompt = '';

var _previewOverlay = null;
var _currentTaskId = null;
var _thumbCache = {};
var _thumbPending = {};
var _thumbQueue = [];
var _thumbInflight = 0;
var _THUMB_MAX_CONCURRENT = 4;
var _THUMB_CACHE_MAX = 300;
var _expandedGroups = {};
var _groupsCache = {};
var _loadedOnce = false;

function _esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var mm = ('0' + (d.getMonth() + 1)).slice(-2);
    var dd = ('0' + d.getDate()).slice(-2);
    var hh = ('0' + d.getHours()).slice(-2);
    var mi = ('0' + d.getMinutes()).slice(-2);
    return mm + '-' + dd + ' ' + hh + ':' + mi;
}

function _statusLabel(st) {
    if (st === 'success') return '✓ 成功';
    if (st === 'late')    return '⏱ 后台完成';
    if (st === 'failed')  return '✗ 失败';
    if (st === 'aborted') return '⊘ 已中断';
    if (st === 'pending') return '⌛ 生成中';
    return st || '';
}
function _statusColor(st) {
    if (st === 'success') return '#5be37b';
    if (st === 'late')    return '#7ad8ff';
    if (st === 'failed')  return '#ff7a7a';
    if (st === 'aborted') return '#bbb';
    if (st === 'pending') return '#ffd47a';
    return '#999';
}

// ============================================================
//  Host 消息 (复用回收站 5 个 action, host 端零改动)
// ============================================================
TileAPI.onHostMessage('recycleListResult', function(data) {
    if (!data || !data.success) {
        TileAPI.toast('加载失败: ' + (data && data.error || '?'), 'error');
        return;
    }
    if (data.offset === 0) _items = data.items || [];
    else _items = _items.concat(data.items || []);
    _total = data.total || 0;
    _offset = (data.offset || 0) + (data.items ? data.items.length : 0);
    _refreshUI();
});

TileAPI.onHostMessage('recycleGetImageResult', function(data) {
    if (!data) return;
    var tid = data.taskId;
    // (v6.4.9 起本消息只服务预览模态大图; 列表缩略图走 recycleGetThumbResult)
    if (_previewOverlay && _currentTaskId === tid) {
        var imgBox = _previewOverlay.querySelector('.rb-preview-img-wrap');
        if (imgBox) {
            if (data.success && data.base64) {
                imgBox.innerHTML = '<img src="data:image/png;base64,' + data.base64 + '" alt="">';
            } else {
                imgBox.innerHTML = '<div class="rb-preview-fail">' + _esc(data.error || '图像不可用') + '</div>';
            }
        }
    }
});

// v6.4.9: 列表缩略图通道 — 收到小图直接用; 收到原图(isThumb=false, 老数据)则
// 前端用 canvas 压一张 200px JPEG 回传给 host 存起来(自愈), 下次就是小图了
TileAPI.onHostMessage('recycleGetThumbResult', function(data) {
    if (!data) return;
    var tid = data.taskId;
    var wasInThumbQueue = !!_thumbPending[tid];
    if (data.success && data.base64) {
        _thumbCache[tid] = data.base64;
        _capThumbCache();
        _applyThumbToCard(tid, data.base64);
        if (!data.isThumb) {
            // 老数据: 拿到的是原图 → 压小图回传(异步, 不挡渲染)
            _compressAndUploadThumb(tid, data.base64);
        }
    }
    delete _thumbPending[tid];
    if (wasInThumbQueue) {
        _thumbInflight = Math.max(0, _thumbInflight - 1);
        _drainThumbQueue();
    }
});

// canvas 压缩: 200px 短边 JPEG q60 (~10KB), 压好回传 host 落盘
function _compressAndUploadThumb(taskId, base64) {
    try {
        var img = new Image();
        img.onload = function() {
            try {
                var w = img.naturalWidth || img.width;
                var h = img.naturalHeight || img.height;
                if (!w || !h) return;
                var ratio = Math.min(1, 200 / Math.min(w, h));
                var dw = Math.max(1, Math.round(w * ratio));
                var dh = Math.max(1, Math.round(h * ratio));
                var canvas = document.createElement('canvas');
                canvas.width = dw; canvas.height = dh;
                canvas.getContext('2d').drawImage(img, 0, 0, dw, dh);
                var dataUrl = canvas.toDataURL('image/jpeg', 0.6);
                var jpegB64 = dataUrl.split(',')[1];
                if (jpegB64) TileAPI.sendToHost('recycleSaveThumb', { taskId: taskId, base64: jpegB64 });
            } catch(_) {}
        };
        img.onerror = function() {};
        img.src = 'data:image/png;base64,' + base64;
    } catch(_) {}
}

TileAPI.onHostMessage('recyclePlaceResult', function(data) {
    if (!data) return;
    if (data.success) { TileAPI.toast('已贴回到 PS', 'success'); _closePreview(); }
    else TileAPI.toast('贴回失败: ' + (data.error || '?'), 'error');
});

TileAPI.onHostMessage('recycleDeleteResult', function(data) {
    if (!data || !data.success) {
        TileAPI.toast('删除失败' + (data && data.error ? ': ' + data.error : ''), 'error');
        return;
    }
    _items = _items.filter(function(i) { return i.id !== data.taskId; });
    _total = Math.max(0, _total - 1);
    delete _thumbCache[data.taskId];
    _closePreview();
    // 先播卡片缩小淡出, 播完再重渲列表(找不到卡片就直接刷)
    var grid = document.getElementById('rbGrid');
    var card = grid && grid.querySelector('.rb-card[data-tid="' + data.taskId + '"]');
    if (card) {
        card.classList.add('w10-item-removing');
        setTimeout(_refreshUI, 180);
    } else {
        _refreshUI();
    }
});

TileAPI.onHostMessage('recycleClearResult', function(data) {
    if (!data) return;
    if (data.success) {
        TileAPI.toast('已清理 ' + data.deleted + ' 条, 剩 ' + data.remaining, 'success');
        _thumbCache = {};
        _reload();
    } else {
        TileAPI.toast('清空失败: ' + (data.error || '?'), 'error');
    }
});

var _reloadTimer = null;
var _panelOpen = false;   // 卡顿修复: 面板没开时新归档只更新正面数字, 不做全量列表拉取
TileAPI.on('billing:updated', function() {
    // 墨墨倍率账单会在生成后异步回填；面板开着时立即刷新项目金额。
    if (_panelOpen) _refreshUI();
});
TileAPI.onHostMessage('recycleNewArchived', function(data) {
    if (!_panelOpen) {
        // 面板关着: 只把正面"N 条"数字加一, 省掉整个 listItems 往返(生成高峰期一张图一次)
        if (data && data.pending && data.count) _total += data.count;
        else if (data && data.id) { /* update 已有条目, 总数不变 */ }
        else _total += 1;
        _refreshFront();
        return;
    }
    if (_reloadTimer) return;
    _reloadTimer = setTimeout(function() {
        _reloadTimer = null;
        _reload();
    }, 800);
});

function _capThumbCache() {
    var keys = Object.keys(_thumbCache);
    if (keys.length <= _THUMB_CACHE_MAX) return;
    var over = keys.length - _THUMB_CACHE_MAX;
    for (var i = 0; i < over; i++) delete _thumbCache[keys[i]];
}

function _applyThumbToCard(tid, b64) {
    var grid = document.getElementById('rbGrid');
    if (!grid) return;
    var card = grid.querySelector('.rb-card[data-tid="' + tid + '"] .rb-card-thumb');
    if (card) {
        // 图到达淡入: 用引擎验证过的"先设起点→下一帧给 transition+终点"模式。
        // (class+animation 的写法在 UXP 上会先画一帧终态再播动画 = 闪两次, 别改回去)
        if (!card._thumbShown) {
            card._thumbShown = true;
            card.style.transition = 'none';
            card.style.opacity = '0.25';
            card.style.background = 'center/cover no-repeat url("data:image/png;base64,' + b64 + '")';
            requestAnimationFrame(function() {
                card.style.transition = 'opacity 0.25s ease';
                card.style.opacity = '1';
                setTimeout(function() { card.style.transition = ''; }, 300);
            });
        } else {
            card.style.background = 'center/cover no-repeat url("data:image/png;base64,' + b64 + '")';
        }
    }
    // 同一张图可能同时是组封面和项目封面 — 全部填 (querySelectorAll, 不是只填第一个)
    var covers = grid.querySelectorAll('[data-cover-tid="' + tid + '"]');
    for (var i = 0; i < covers.length; i++) {
        covers[i].style.background = 'center/cover no-repeat url("data:image/png;base64,' + b64 + '")';
        covers[i].textContent = '';   // 项目封面的 📁 占位字符清掉
    }
}

function _enqueueThumb(tid) {
    if (_thumbCache[tid] || _thumbPending[tid]) return;
    _thumbPending[tid] = true;
    _thumbQueue.push(tid);
    _drainThumbQueue();
}

function _drainThumbQueue() {
    while (_thumbInflight < _THUMB_MAX_CONCURRENT && _thumbQueue.length > 0) {
        var tid = _thumbQueue.shift();
        _thumbInflight++;
        TileAPI.sendToHost('recycleGetThumb', { taskId: tid });
    }
}

// ============================================================
//  历史功能移植: 载入提示词 / 恢复选区
// ============================================================
function _isForgeItem(it) {
    return it.workflow === 'forge' || it.presetKind === 'forge';
}

// 一组的"代表条目": 取第一条(组内共享提示词/参数)
function _loadPromptFromItem(it) {
    if (!it) return;
    if (it.promptProtected) {
        TileAPI.toast('该玩法的提示词受保护, 不能载入', 'info');
        return;
    }
    var isForge = _isForgeItem(it);
    var snap = isForge ? (it.forgeSnapshot || null) : null;
    var text = (snap && snap.positivePrompt) ? snap.positivePrompt : (it.prompt || '');
    if (!text) { TileAPI.toast('这条记录没有提示词', 'info'); return; }

    TileAPI.state.set('prompt.text', text);
    TileAPI.storage.set('prompt.lastText', text);
    // 幽灵预设名修复: title 和 kind 必须成对 — 老记录 presetKind 常为空,
    // 只塞 title 会造出畸形态(kind空+title有值), 手动改词时解绑逻辑漏掉它。
    // 有 title 没 kind 时补默认 'banana', 保证成对。
    if (it.presetTitle) {
        TileAPI.state.set('prompt.lastPresetTitle', it.presetTitle);
        TileAPI.state.set('prompt.lastPresetKind', isForge ? 'forge' : (it.presetKind || 'banana'));
    } else {
        TileAPI.state.set('prompt.lastPresetTitle', '');
        TileAPI.state.set('prompt.lastPresetKind', isForge ? 'forge' : (it.presetKind || ''));
    }

    // Forge: 参数快照还原(与老历史同一套 storage key + 事件)
    if (isForge && snap) {
        if (snap.positivePrompt !== undefined) TileAPI.storage.set('forge.positivePrompt', snap.positivePrompt);
        if (snap.negativePrompt !== undefined) TileAPI.storage.set('forge.negativePrompt', snap.negativePrompt);
        if (snap.steps !== undefined) TileAPI.storage.set('forge.steps', snap.steps);
        if (snap.cfg !== undefined) TileAPI.storage.set('forge.cfg', snap.cfg);
        if (snap.denoise !== undefined) TileAPI.storage.set('forge.denoise', snap.denoise);
        if (snap.resolution !== undefined) TileAPI.storage.set('forge.resolution', snap.resolution);
        if (snap.sampler !== undefined) TileAPI.storage.set('forge.sampler', snap.sampler);
        if (snap.model !== undefined) TileAPI.storage.set('forge.model', snap.model);
        if (snap.batchSize !== undefined) TileAPI.storage.set('forge.batchSize', snap.batchSize);
        if (snap.seed !== undefined) TileAPI.storage.set('forge.seed', snap.seed);
        TileAPI.emit('forge:applyPreset', { data: snap });
    }

    TileAPI.emit('prompt:changed', { text: text, source: it.presetTitle ? 'preset' : 'history' });
    TileAPI.emit('preset:loaded', {
        content: text,
        title: it.presetTitle || '',
        kind: isForge ? 'forge' : 'banana'
    });
    TileAPI.toast(isForge ? '已恢复 Forge 参数 (点 ▶ 生成)' : '已载入提示词', 'success');
}

function _restoreSelectionFromItem(it) {
    var c = (it && it.context) || {};
    if (!c.docId || !c.selection) {
        TileAPI.toast('这条记录没有选区信息', 'info');
        return;
    }
    TileAPI.sendToHost('restoreSelectionFromHistory', { docId: c.docId, selection: c.selection });
    TileAPI.toast('正在恢复选区...', 'info');
}

// ============================================================
//  Tile 注册
// ============================================================
TileAPI.registerTile({
    id: 'records',
    group: 'main',
    icon: '🗂',
    label: '生成记录',
    desc: '图库 · 提示词 · 全量归档',
    live: true,
    defaultSize: { w: 2, h: 2 },
    minSize: { w: 1, h: 1 },
    maxSize: { w: 4, h: 8 },

    renderBack: function(container) {
        var label = (_total > 0) ? (_total + ' 条') : '空';
        container.textContent = label;
        if (_total === 0 && !_loadedOnce) {
            _loadedOnce = true;
            _reload();
        }
    },

    onExpand: function(container, sizeHint) {
        var layout = (sizeHint && sizeHint.layout) || 'wide';
        _panelOpen = true;
        _renderPanel(container, layout);
        _reload();
        return function() { _panelOpen = false; _closePreview(); };
    }
});

function _reload() {
    _offset = 0;
    TileAPI.sendToHost('recycleListItems', {
        limit: PAGE_SIZE, offset: 0,
        filterStatus: _filterStatus || null,
        searchPrompt: _searchPrompt || null
    });
}

function _loadMore() {
    TileAPI.sendToHost('recycleListItems', {
        limit: PAGE_SIZE, offset: _offset,
        filterStatus: _filterStatus || null,
        searchPrompt: _searchPrompt || null
    });
}

// ============================================================
//  面板
// ============================================================
function _renderPanel(container, layout) {
    container.innerHTML =
        '<div class="w10-panel rb-panel">' +
            '<div class="w10-section-title">生成记录 <span id="rbTotal" class="rb-total"></span></div>' +
            '<div class="rb-toolbar">' +
                '<select class="w10-select rb-filter" id="rbFilter">' +
                    '<option value="">全部</option>' +
                    '<option value="pending">⌛ 生成中</option>' +
                    '<option value="success">✓ 成功</option>' +
                    '<option value="late">⏱ 后台完成</option>' +
                    '<option value="failed">✗ 失败</option>' +
                    '<option value="aborted">⊘ 已中断</option>' +
                '</select>' +
                '<input type="text" class="w10-input rb-search" id="rbSearch" placeholder="搜提示词/预设名..."/>' +
                '<button class="w10-btn rb-clear-btn" id="rbClearBtn" title="清空失败和已中断的">清空</button>' +
            '</div>' +
            '<div class="rb-grid" id="rbGrid"><div class="rb-loading">加载记录中…</div></div>' +
        '</div>';

    var filterSel = container.querySelector('#rbFilter');
    if (filterSel) {
        filterSel.value = _filterStatus || '';
        filterSel.addEventListener('change', function() { _filterStatus = this.value; _reload(); });
    }
    var searchEl = container.querySelector('#rbSearch');
    if (searchEl) {
        var t;
        searchEl.value = _searchPrompt || '';
        searchEl.addEventListener('input', function() {
            var v = this.value;
            if (t) clearTimeout(t);
            t = setTimeout(function() { _searchPrompt = v.trim(); _reload(); }, 300);
        });
    }
    var clearBtn = container.querySelector('#rbClearBtn');
    if (clearBtn) clearBtn.addEventListener('click', function() {
        TileAPI.confirm('清空生成记录会怎么清?\n\n· 取消 = 不动\n· 确定 = 仅删失败和已中断的').then(function(yes) {
            if (yes) TileAPI.sendToHost('recycleClear', { failedOnly: true });
        });
    });
}

// ============================================================
//  时间线渲染 (v6.4.9: 项目(PS文档) → 任务组 两级; 和缓存文件夹同款分类逻辑)
// ============================================================
var _expandedProjects = {};   // projKey → true (会话级, 默认全折叠; 只有一个项目时自动展开)

// docPath 哈希短码(与 fs-utils._hash4 同算法, 让分组和缓存文件夹对得上)
function _hash4(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
    return ('0000' + (h % 65536).toString(16)).slice(-4);
}

// ============================================================
//  项目封面(整画布截图) + 项目开销 (v6.5.0)
// ============================================================
var _projThumbCache = {};    // projKey → base64 (host 的 proj_<key>.jpg)
var _projThumbPending = {};

TileAPI.onHostMessage('recycleProjThumbResult', function(data) {
    if (!data || !data.projKey) return;
    delete _projThumbPending[data.projKey];
    if (data.base64) {
        _projThumbCache[data.projKey] = data.base64;
        _applyProjThumb(data.projKey, data.base64);
    } else {
        // 项目截图不存在(老数据没截过/截取失败) → 退回用该项目最新任务的缩略图当封面
        _applyProjFallbackCover(data.projKey);
    }
});

// 兜底封面: 找该项目最新一条有图的任务, 挂进任务缩略图队列
function _applyProjFallbackCover(projKey) {
    var grid = document.getElementById('rbGrid');
    if (!grid) return;
    var el = grid.querySelector('.rb-proj[data-proj="' + projKey + '"] .rb-proj-cover');
    if (!el || el.getAttribute('data-cover-tid')) return;
    for (var i = 0; i < _items.length; i++) {
        var it = _items[i];
        if (!it.imagePath) continue;
        if (_projKeyOf(it).key !== projKey) continue;
        el.setAttribute('data-cover-tid', it.id);
        if (_thumbCache[it.id]) {
            el.style.background = 'center/cover no-repeat url("data:image/png;base64,' + _thumbCache[it.id] + '")';
            el.textContent = '';
        } else {
            _enqueueThumb(it.id);   // 回包时 _applyThumbToCard 会按 data-cover-tid 填上
        }
        return;
    }
}

// 生成完成后 host 更新了某项目封面 → 缓存作废重拉
TileAPI.onHostMessage('recycleProjThumbUpdated', function(data) {
    if (!data || !data.projKey) return;
    delete _projThumbCache[data.projKey];
    if (_panelOpen) _requestProjThumb(data.projKey);
});

function _requestProjThumb(projKey) {
    if (_projThumbCache[projKey]) { _applyProjThumb(projKey, _projThumbCache[projKey]); return; }
    if (_projThumbPending[projKey]) return;
    _projThumbPending[projKey] = true;
    TileAPI.sendToHost('recycleGetProjThumb', { projKey: projKey });
}

function _applyProjThumb(projKey, b64) {
    var grid = document.getElementById('rbGrid');
    if (!grid) return;
    var el = grid.querySelector('.rb-proj[data-proj="' + projKey + '"] .rb-proj-cover');
    if (el) {
        el.style.background = 'center/cover no-repeat url("data:image/jpeg;base64,' + b64 + '")';
        el.textContent = '';
    }
}

// 项目开销: 账单流水按 docPath/docName 聚合, 全部折美元合计。
// 汇率(用户定, 2026-08-02): 1000 夏算力积分 = $0.1 (即 1积分 = $0.0001)
var GRS_PTS_TO_USD = 0.0001;
function _projCost(projKey) {
    var ledger = TileAPI.storage.get('billing.ledger') || [];
    var usd = 0;
    var pendingMomo = 0;
    var unknownMomo = 0;
    for (var i = 0; i < ledger.length; i++) {
        var e = ledger[i];
        if (!e || (!e.docName && !e.docPath)) continue;
        var k = _projKeyOf({ context: { docName: e.docName, docPath: e.docPath } });
        if (k.key !== projKey) continue;
        if (e.provider === 'momo' && (e.pending || e.pricingStatus === 'pending')) pendingMomo++;
        if (e.provider === 'momo' && e.pricingStatus === 'legacy-unpriced') unknownMomo++;
        if (e.provider === 'grs') usd += (e.cost || 0) * GRS_PTS_TO_USD;
        else usd += (e.cost || 0);   // aji / momo / others 本身就是美元
    }
    var suffix = pendingMomo > 0 ? ' · 待结算' : (unknownMomo > 0 ? ' · 历史未知' : '');
    if (usd <= 0) return suffix ? suffix.slice(3) : '';
    return '$' + usd.toFixed(usd >= 10 ? 1 : 2) + suffix;
}

// 条目 → 项目键 + 显示名 (去后缀正则必须与 host/proj-thumb.js 的 projKeyOf 完全一致!)
function _projKeyOf(it) {
    var c = it.context || {};
    var name = (c.docName || '').replace(/\.(psd|psb|tif|tiff|png|jpe?g|webp|bmp|gif|nef|cr[23]|arw|dng|raf|orf)$/i, '');
    if (!name) return { key: '__none', label: '未关联文档' };
    if (c.docPath) return { key: name + '_' + _hash4(String(c.docPath)), label: name };
    return { key: name + '_noPath', label: name };   // 老数据没 docPath: 按名聚(重名会混, 降级可接受)
}

function _groupItems(items) {
    var byBatch = {};
    var order = [];
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var bid = it.batchId || it.id;
        if (!byBatch[bid]) {
            byBatch[bid] = { batchId: bid, items: [], firstAt: it.createdAt || 0, lastAt: it.createdAt || 0 };
            order.push(bid);
        }
        byBatch[bid].items.push(it);
        if ((it.createdAt || 0) > byBatch[bid].lastAt) byBatch[bid].lastAt = it.createdAt;
        if ((it.createdAt || 0) < byBatch[bid].firstAt) byBatch[bid].firstAt = it.createdAt;
    }
    return order.map(function(bid) { return byBatch[bid]; });
}

// 任务组 → 按项目聚类, 保持时间倒序(项目按其最新任务排)
function _groupByProject(groups) {
    var byProj = {};
    var order = [];
    for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        var pk = _projKeyOf(g.items[0]);
        if (!byProj[pk.key]) {
            byProj[pk.key] = { key: pk.key, label: pk.label, groups: [], lastAt: g.lastAt || 0 };
            order.push(pk.key);
        }
        byProj[pk.key].groups.push(g);
        if ((g.lastAt || 0) > byProj[pk.key].lastAt) byProj[pk.key].lastAt = g.lastAt;
    }
    return order.map(function(k) { return byProj[k]; });
}

function _groupSummary(g) {
    var ok = 0, fail = 0, late = 0, ab = 0, pend = 0;
    for (var i = 0; i < g.items.length; i++) {
        var s = g.items[i].status;
        if (s === 'success') ok++;
        else if (s === 'late') late++;
        else if (s === 'failed') fail++;
        else if (s === 'aborted') ab++;
        else if (s === 'pending') pend++;
    }
    var color, label;
    if (pend > 0) {
        color = '#ffd47a';
        var parts = ['⌛ ' + pend];
        if (ok + late > 0) parts.push('✓ ' + (ok + late));
        if (fail + ab > 0) parts.push('✗ ' + (fail + ab));
        label = parts.join(' / ') + '张';
    }
    else if (fail === 0 && ab === 0) { color = '#5be37b'; label = '✓ ' + ok + '张'; }
    else if (ok === 0 && late === 0) { color = '#ff7a7a'; label = '✗ ' + (fail + ab) + '张'; }
    else { color = '#ffcc66'; label = ok + '✓ / ' + (fail + ab) + '✗'; }
    return { color: color, label: label };
}

function _refreshUI() {
    _refreshFront();
    var grid = document.getElementById('rbGrid');
    var totalEl = document.getElementById('rbTotal');
    if (totalEl) totalEl.textContent = _total > 0 ? '(共 ' + _total + ' 条)' : '';
    if (!grid) return;

    if (_items.length === 0) {
        grid.innerHTML = '<div class="rb-empty">暂无记录. 任何生成任务 (成功 / 失败 / 提前结束) 都会自动归档到这里.</div>';
        return;
    }

    var groups = _groupItems(_items);
    _groupsCache = {};
    for (var gi0 = 0; gi0 < groups.length; gi0++) _groupsCache[groups[gi0].batchId] = groups[gi0];

    // v6.4.9: 项目一级分组; 只有一个项目时自动展开(免得多点一下)
    var projects = _groupByProject(groups);
    if (projects.length === 1) _expandedProjects[projects[0].key] = true;

    var html = '';
    for (var pi2 = 0; pi2 < projects.length; pi2++) {
        var proj = projects[pi2];
        var pOpen = !!_expandedProjects[proj.key];
        var pTotal = 0;
        for (var pg = 0; pg < proj.groups.length; pg++) pTotal += proj.groups[pg].items.length;
        // 项目封面: 整画布截图(host proj_<key>.jpg, 每次生成后更新); 渲染后异步拉
        // 项目开销: 本地流水按文档聚合；墨墨倍率模型使用今日同模型账单均价回填。
        var pCost = _projCost(proj.key);
        html += '<div class="rb-proj' + (pOpen ? ' rb-proj-open' : '') + '" data-proj="' + _esc(proj.key) + '">';
        html += '<div class="rb-proj-head" data-proj-head="' + _esc(proj.key) + '" title="点击' + (pOpen ? '折叠' : '展开') + '">';
        html +=   '<div class="rb-proj-cover">📁</div>';
        html +=   '<span class="rb-proj-name">' + _esc(proj.label) + '</span>';
        html +=   (pCost ? '<span class="rb-proj-cost" title="本文档累计开销(本地估算; 积分按 1000分=$0.1 折算)">' + _esc(pCost) + '</span>' : '');
        html +=   '<span class="rb-proj-count">' + proj.groups.length + ' 组 · ' + pTotal + ' 张</span>';
        html +=   '<span class="rb-group-arrow">▸</span>';
        html += '</div>';
        if (pOpen) {
            html += '<div class="rb-proj-body">';
            for (var gi = 0; gi < proj.groups.length; gi++) html += _renderGroup(proj.groups[gi]);
            html += '</div>';
        }
        html += '</div>';
    }
    grid.innerHTML = html;

    if (!grid._rbDelegated) {
        grid._rbDelegated = true;
        grid.addEventListener('click', _onGridClick);
    }

    // 缩略图统一入队: 项目封面 + 组封面 + 所有已渲出的卡片(含重开面板时直渲的展开组 — bug#1 修复:
    // 之前只有"点击展开"路径给卡片排队, 重开面板时直渲的 body 里的卡片没人拉图 → 缩略图消失)
    _fillThumbsIn(grid);
    // 项目封面异步拉取(整画布小图, 独立于任务缩略图通道)
    for (var pt = 0; pt < projects.length; pt++) _requestProjThumb(projects[pt].key);

    // v6.5.5: 加载更多贴在最后一条记录后面(网格内), 不再吊在面板底部
    if (_offset < _total) {
        grid.insertAdjacentHTML('beforeend',
            '<div class="rb-loadmore-inline" data-rec-loadmore="1">⌄ 加载更多 (' + (_total - _offset) + ' 条未加载)</div>');
    }
}

// 把容器里所有带图的封面/卡片查一遍: 有缓存直接填, 没缓存入队拉
function _fillThumbsIn(rootEl) {
    if (!rootEl) return;
    var covers = rootEl.querySelectorAll('[data-cover-tid]');
    for (var ci = 0; ci < covers.length; ci++) {
        var ctid = covers[ci].getAttribute('data-cover-tid');
        if (_thumbCache[ctid]) {
            covers[ci].style.background = 'center/cover no-repeat url("data:image/png;base64,' + _thumbCache[ctid] + '")';
        } else {
            _enqueueThumb(ctid);
        }
    }
    var cards = rootEl.querySelectorAll('.rb-card[data-has-img="1"]');
    for (var ki = 0; ki < cards.length; ki++) {
        var ktid = cards[ki].getAttribute('data-tid');
        if (_thumbCache[ktid]) _applyThumbToCard(ktid, _thumbCache[ktid]);
        else _enqueueThumb(ktid);
    }
}

function _onGridClick(e) {
    var lmEl = e.target.closest && e.target.closest('[data-rec-loadmore]');
    if (lmEl) {
        lmEl.textContent = '加载中…';
        _loadMore();
        return;
    }
    // 项目头: 展开/折叠该文档的任务列表(懒渲: 首开才建 DOM)
    var projHead = e.target.closest && e.target.closest('[data-proj-head]');
    if (projHead) {
        var pKey = projHead.getAttribute('data-proj-head');
        var projEl = projHead.parentNode;
        var nowOpenP = !_expandedProjects[pKey];
        _expandedProjects[pKey] = nowOpenP;
        if (nowOpenP) {
            if (!projEl.querySelector('.rb-proj-body')) {
                // 懒渲该项目下的组卡
                var groupsAll = _groupItems(_items);
                var bodyHtml = '<div class="rb-proj-body">';
                for (var g2 = 0; g2 < groupsAll.length; g2++) {
                    var pk2 = _projKeyOf(groupsAll[g2].items[0]);
                    if (pk2.key === pKey) bodyHtml += _renderGroup(groupsAll[g2]);
                }
                bodyHtml += '</div>';
                projEl.insertAdjacentHTML('beforeend', bodyHtml);
                _fillThumbsIn(projEl);   // 新渲出来的封面/卡片统一入队
                // 首开: 元素以折叠态(max-height:0)插入, 下一帧再加 open 类,
                // 让 transition 从 0 播到展开 — 同帧加类会直接跳到终态没有动画
                requestAnimationFrame(function() { projEl.classList.add('rb-proj-open'); });
            } else {
                projEl.classList.add('rb-proj-open');
            }
        } else {
            projEl.classList.remove('rb-proj-open');
        }
        projHead.setAttribute('title', '点击' + (nowOpenP ? '折叠' : '展开'));
        return;
    }
    // 组卡上的动作按钮 (载入提示词 / 恢复选区) — 先于 head 展开处理
    var actBtn = e.target.closest && e.target.closest('[data-rec-act]');
    if (actBtn) {
        e.stopPropagation();
        var bid0 = actBtn.getAttribute('data-batch');
        var g0 = _groupsCache[bid0];
        var rep = g0 && g0.items && g0.items[0];
        if (actBtn.getAttribute('data-rec-act') === 'prompt') _loadPromptFromItem(rep);
        else if (actBtn.getAttribute('data-rec-act') === 'sel') _restoreSelectionFromItem(rep);
        return;
    }
    var head = e.target.closest && e.target.closest('.rb-group-head');
    if (head) {
        var groupEl = head.parentNode;
        if (!groupEl || !groupEl.classList.contains('rb-group')) return;
        var bid = head.getAttribute('data-batch');
        var nowOpen = !_expandedGroups[bid];
        _expandedGroups[bid] = nowOpen;
        head.setAttribute('title', '点击' + (nowOpen ? '折叠' : '展开'));
        if (nowOpen) {
            var alreadyHasBody = !!groupEl.querySelector('.rb-group-body');
            if (alreadyHasBody) {
                groupEl.classList.add('rb-group-open');
            } else {
                _ensureGroupBody(groupEl);
                void groupEl.offsetWidth;
                groupEl.classList.add('rb-group-open');
            }
        } else {
            groupEl.classList.remove('rb-group-open');
        }
        return;
    }
    var card = e.target.closest && e.target.closest('.rb-card');
    if (card) {
        var tid = card.getAttribute('data-tid');
        if (tid) _openPreview(tid);
    }
}

function _ensureGroupBody(groupEl) {
    if (groupEl.querySelector('.rb-group-body')) return;
    var head = groupEl.querySelector('.rb-group-head');
    if (!head) return;
    var bid = head.getAttribute('data-batch');
    var g = _groupsCache[bid];
    if (!g) return;

    var bodyHtml = '<div class="rb-group-body">';
    for (var j = 0; j < g.items.length; j++) bodyHtml += _renderCard(g.items[j]);
    bodyHtml += '</div>';
    groupEl.insertAdjacentHTML('beforeend', bodyHtml);

    var newCards = groupEl.querySelectorAll('.rb-card');
    for (var k = 0; k < newCards.length; k++) {
        var ntid = newCards[k].getAttribute('data-tid');
        if (newCards[k].getAttribute('data-has-img') !== '1') continue;
        if (_thumbCache[ntid]) _applyThumbToCard(ntid, _thumbCache[ntid]);
        else _enqueueThumb(ntid);
    }
}

function _renderGroup(g) {
    var summary = _groupSummary(g);
    var first = g.items[0];
    var expanded = !!_expandedGroups[g.batchId];
    // 显示优先: 预设名 > 提示词首个"人话"行(跳过 // 注释头和空行 — 预设正文常以 // scene_type: 开头)
    var displayText = first.presetTitle;
    if (!displayText) {
        var lines = String(first.prompt || '').split('\n');
        for (var li = 0; li < lines.length; li++) {
            var ln = lines[li].replace(/^\s*\/\/\s*/, '').trim();
            if (ln) { displayText = ln.slice(0, 60); break; }
        }
    }
    var coverItem = null;
    for (var i = 0; i < g.items.length; i++) {
        if (g.items[i].imagePath) { coverItem = g.items[i]; break; }
    }
    var coverAttr = coverItem ? (' data-cover-tid="' + _esc(coverItem.id) + '"') : '';
    var coverBg = coverItem
        ? 'background:linear-gradient(135deg,#404659,#2a2f3d);'
        : 'background:linear-gradient(135deg,#3a2a2a,#2a1f1f);';

    // 按钮可用性: 打码词禁载入; 没选区上下文禁恢复
    var protectedWord = !!first.promptProtected;
    var hasSel = !!(first.context && first.context.docId && first.context.selection);
    var promptBtn = protectedWord
        ? '<button class="w10-btn rb-act-mini" disabled title="该玩法的提示词受保护">🔒词</button>'
        : '<button class="w10-btn rb-act-mini" data-rec-act="prompt" data-batch="' + _esc(g.batchId) + '" title="载入提示词' + (_isForgeItem(first) && first.forgeSnapshot ? '(含 Forge 参数)' : '') + '">📋词</button>';
    var selBtn = hasSel
        ? '<button class="w10-btn rb-act-mini" data-rec-act="sel" data-batch="' + _esc(g.batchId) + '" title="恢复 PS 选区">▣区</button>'
        : '';

    var html = '<div class="rb-group' + (expanded ? ' rb-group-open' : '') + '">';
    html += '<div class="rb-group-head" data-batch="' + _esc(g.batchId) + '" title="点击' + (expanded ? '折叠' : '展开') + '">';
    html +=   '<div class="rb-group-cover"' + coverAttr + ' style="' + coverBg + '"></div>';
    html +=   '<div class="rb-group-info">';
    html +=     '<div class="rb-group-prompt">' + _esc(displayText || '(无提示词)') + '</div>';
    html +=     '<div class="rb-group-meta">';
    html +=       '<span class="rb-group-count" style="color:' + summary.color + '">' + summary.label + '</span>';
    html +=       '<span class="rb-group-wf">' + _esc(first.workflow || '?') + '</span>';
    html +=       '<span class="rb-group-time">' + _fmtTime(g.lastAt) + '</span>';
    html +=     '</div>';
    html +=   '</div>';
    html +=   '<div class="rb-group-acts">' + promptBtn + selBtn + '</div>';
    html +=   '<div class="rb-group-arrow">▸</div>';
    html += '</div>';

    if (expanded) {
        html += '<div class="rb-group-body">';
        for (var j = 0; j < g.items.length; j++) html += _renderCard(g.items[j]);
        html += '</div>';
    }
    html += '</div>';
    return html;
}

function _refreshFront() {
    try {
        if (!window.TileEngine) return;
        var el = window.TileEngine.getTileElement('records');
        if (!el) return;
        if (el.classList.contains('panel-mode')) return;
        var label = (_total > 0) ? (_total + ' 条') : '空';
        var back = el.querySelector('.tile-flip-back');
        if (back) back.textContent = label;
    } catch(_) {}
}

function _renderCard(it) {
    var hasImg = !!it.imagePath;
    var st = it.status || 'success';
    var isPending = (st === 'pending');
    var bgStyle;
    if (isPending) bgStyle = 'style="background:linear-gradient(135deg,#3a4255,#2a3040);"';
    else if (hasImg) bgStyle = 'style="background:linear-gradient(135deg,#404659,#2a2f3d);"';
    else bgStyle = 'style="background:linear-gradient(135deg,#3a2a2a,#2a1f1f);"';
    var stColor = _statusColor(st);
    var promptShort = (it.presetTitle || it.prompt || '').slice(0, 36).replace(/\s+/g, ' ');
    var cardCls = 'rb-card' + (isPending ? ' rb-card-pending' : '');
    return '' +
        '<div class="' + cardCls + '" data-tid="' + _esc(it.id) + '" data-has-img="' + (hasImg ? '1' : '0') + '" title="' + _esc(it.prompt || '') + '">' +
            '<div class="rb-card-thumb" ' + bgStyle + '>' +
                '<div class="rb-card-status" style="color:' + stColor + '">' + _statusLabel(st) + '</div>' +
            '</div>' +
            '<div class="rb-card-meta">' +
                '<div class="rb-card-prompt">' + _esc(promptShort) + '</div>' +
                '<div class="rb-card-foot">' +
                    '<span>' + _fmtTime(it.createdAt) + '</span>' +
                    '<span class="rb-card-wf">' + _esc(it.workflow || '?') + '</span>' +
                '</div>' +
            '</div>' +
        '</div>';
}

// ============================================================
//  预览模态 (回收站原样 + 载入提示词 + ←/→ 切换同批结果)
// ============================================================

// 同批(batchId)内有图的兄弟条目列表 — 给 ←/→ 用
function _siblingsWithImage(item) {
    var bid = item.batchId || item.id;
    var sibs = [];
    for (var i = 0; i < _items.length; i++) {
        var it = _items[i];
        if ((it.batchId || it.id) === bid && it.imagePath) sibs.push(it);
    }
    return sibs;
}

function _openPreview(taskId) {
    var item = null;
    for (var i = 0; i < _items.length; i++) {
        if (_items[i].id === taskId) { item = _items[i]; break; }
    }
    if (!item) return;

    // bug#3 修复: 先关旧预览再记 _currentTaskId。
    // 原顺序是 先记 id 再 _closePreview() — 而 _closePreview 会把 _currentTaskId 清空,
    // 导致原图回包时 (_currentTaskId === tid) 永远不成立, 大图被丢弃, 只剩模糊小图垫底。
    _closePreview();
    _currentTaskId = taskId;

    var canLoadPrompt = !item.promptProtected && (item.prompt || (item.forgeSnapshot && item.forgeSnapshot.positivePrompt));

    // ←/→: 同批多张结果间切换
    var sibs = _siblingsWithImage(item);
    var sibIdx = -1;
    for (var si = 0; si < sibs.length; si++) { if (sibs[si].id === taskId) { sibIdx = si; break; } }
    var hasNav = sibs.length > 1 && sibIdx >= 0;

    var ov = document.createElement('div');
    ov.className = 'rb-preview-overlay';
    ov.innerHTML =
        '<div class="rb-preview-card">' +
            '<div class="rb-preview-head">' +
                '<div class="rb-preview-title">' +
                    '<span style="color:' + _statusColor(item.status) + '">' + _statusLabel(item.status) + '</span>' +
                    ' · ' + _esc(item.workflow || '?') + ' · ' + _fmtTime(item.createdAt) +
                    (hasNav ? ' · <span class="rb-preview-nav-pos">' + (sibIdx + 1) + '/' + sibs.length + '</span>' : '') +
                '</div>' +
                '<button class="rb-preview-close" title="关闭">×</button>' +
            '</div>' +
            '<div class="rb-preview-body">' +
                '<div class="rb-preview-img-zone">' +
                    (hasNav ? '<button class="rb-preview-arrow rb-preview-arrow-l" id="rbNavPrev" title="上一张 (←)">‹</button>' : '') +
                    '<div class="rb-preview-img-wrap"><div class="rb-preview-loading">加载图像中...</div></div>' +
                    (hasNav ? '<button class="rb-preview-arrow rb-preview-arrow-r" id="rbNavNext" title="下一张 (→)">›</button>' : '') +
                '</div>' +
                '<div class="rb-preview-info">' +
                    (item.presetTitle ? '<div class="rb-info-row"><span>预设</span><b>' + _esc(item.presetTitle) + '</b></div>' : '') +
                    '<div class="rb-info-row"><span>模型</span><b>' + _esc(item.model || '?') + '</b></div>' +
                    '<div class="rb-info-row"><span>提供商</span><b>' + _esc(item.provider || '?') + '</b></div>' +
                    '<div class="rb-info-row"><span>尺寸</span><b>' + _esc(item.size || '?') + ' / ' + _esc(item.aspectRatio || 'Auto') + '</b></div>' +
                    (item.error ? '<div class="rb-info-row rb-info-err"><span>报错</span><b>' + _esc(item.error) + '</b></div>' : '') +
                    _renderContextBlock(item) +
                    '<div class="rb-info-prompt-label">提示词</div>' +
                    '<div class="rb-info-prompt-box">' + _esc(item.prompt || '(无)') + '</div>' +
                '</div>' +
            '</div>' +
            '<div class="rb-preview-actions">' +
                (item.imagePath ? '<button class="w10-btn rb-act-place" id="rbActPlace">📎 智能贴回 PS</button>' : '') +
                (canLoadPrompt ? '<button class="w10-btn" id="rbActLoadPrompt">📋 载入提示词</button>' : '') +
                '<button class="w10-btn rb-act-copy" id="rbActCopy">📄 复制提示词</button>' +
                '<button class="w10-btn rb-act-del" id="rbActDel">🗑 删除</button>' +
                '<button class="w10-btn rb-act-close" id="rbActClose">关闭</button>' +
            '</div>' +
        '</div>';
    document.body.appendChild(ov);
    _previewOverlay = ov;

    ov.querySelector('.rb-preview-close').addEventListener('click', _closePreview);
    ov.querySelector('#rbActClose').addEventListener('click', _closePreview);
    ov.addEventListener('click', function(e) { if (e.target === ov) _closePreview(); });

    // ←/→ 导航: 按钮 + 键盘(监听挂 overlay 存活期, 关闭时随 DOM 一起走)
    if (hasNav) {
        var goto2 = function(dir) {
            var ni = sibIdx + dir;
            if (ni < 0) ni = sibs.length - 1;
            if (ni >= sibs.length) ni = 0;
            _openPreview(sibs[ni].id);
        };
        var prevBtn = ov.querySelector('#rbNavPrev');
        var nextBtn = ov.querySelector('#rbNavNext');
        if (prevBtn) prevBtn.addEventListener('click', function(e) { e.stopPropagation(); goto2(-1); });
        if (nextBtn) nextBtn.addEventListener('click', function(e) { e.stopPropagation(); goto2(1); });
        var keyHandler = function(e) {
            if (e.key === 'ArrowLeft') { e.preventDefault(); goto2(-1); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); goto2(1); }
            else if (e.key === 'Escape') { _closePreview(); }
        };
        document.addEventListener('keydown', keyHandler);
        ov._keyHandler = keyHandler;   // _closePreview 里摘掉
    }

    var loadBtn = ov.querySelector('#rbActLoadPrompt');
    if (loadBtn) loadBtn.addEventListener('click', function() {
        _loadPromptFromItem(item);
        _closePreview();
    });

    var copyBtn = ov.querySelector('#rbActCopy');
    if (copyBtn) copyBtn.addEventListener('click', function() {
        try {
            if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(item.prompt || '');
            } else {
                var ta = document.createElement('textarea');
                ta.value = item.prompt || '';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
            TileAPI.toast('提示词已复制', 'success');
        } catch(e) {
            TileAPI.toast('复制失败: ' + e.message, 'error');
        }
    });

    var delBtn = ov.querySelector('#rbActDel');
    if (delBtn) delBtn.addEventListener('click', function() {
        TileAPI.confirm('确定删除这条记录?').then(function(yes) {
            if (yes) TileAPI.sendToHost('recycleDelete', { taskId: taskId });
        });
    });

    var placeBtn = ov.querySelector('#rbActPlace');
    if (placeBtn) placeBtn.addEventListener('click', function() {
        TileAPI.sendToHost('recyclePlaceToPS', { taskId: taskId });
    });

    if (item.imagePath) {
        // 缓存里是缩略小图 → 先垫底(模糊), 原图回包后由 recycleGetImageResult 换成清晰大图
        if (_thumbCache[taskId]) {
            var box0 = ov.querySelector('.rb-preview-img-wrap');
            if (box0) box0.innerHTML = '<img src="data:image/png;base64,' + _thumbCache[taskId] + '" alt="" style="filter:blur(2px);">';
        }
        TileAPI.sendToHost('recycleGetImage', { taskId: taskId });
    } else {
        var box = ov.querySelector('.rb-preview-img-wrap');
        if (box) box.innerHTML = '<div class="rb-preview-fail">该任务没有保存图像 (失败 / 已中断)</div>';
    }
}

function _renderContextBlock(item) {
    var c = item.context || {};
    if (!c.docId) return '';
    return '' +
        '<div class="rb-info-context">' +
            '<div class="rb-info-row"><span>原文档</span><b>' + _esc(c.docName || ('doc#' + c.docId)) + '</b></div>' +
            (c.selection ? '<div class="rb-info-row"><span>选区</span><b>' + (c.selection.width || 0) + '×' + (c.selection.height || 0) + ' @(' + (c.selection.left || 0) + ',' + (c.selection.top || 0) + ')</b></div>' : '') +
            (c.layerType ? '<div class="rb-info-row"><span>图层</span><b>' + _esc(c.layerType) + '</b></div>' : '') +
        '</div>';
}

function _closePreview() {
    if (_previewOverlay) {
        if (_previewOverlay._keyHandler) {
            try { document.removeEventListener('keydown', _previewOverlay._keyHandler); } catch(_) {}
        }
        if (_previewOverlay.parentNode) _previewOverlay.parentNode.removeChild(_previewOverlay);
    }
    _previewOverlay = null;
    _currentTaskId = null;
}

})();
