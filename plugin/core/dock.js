// ============================================================
//  dock.js —— 右侧固定快捷栏 (Dock)
//  - 默认关闭(appearance.dockEnabled),开关在设置磁贴里。
//  - 渲染两部分:① 内置"常用"分组(跨磁贴高频动作);
//                ② 各磁贴在 registerTile 时声明的 actions(自动枚举,Phase 2 渐进铺开)。
//  - 触发全部复用现成机制:TileAPI.emit / sendToHost / expandTile。
//  - 不改 tile-engine:.vp 让出 --dock-w 宽度后,updCell() 经 ResizeObserver 自动适配磁贴。
// ============================================================
(function() {
'use strict';

var _host = null;   // #dockHost 元素

// Dock 宽度 = 0.5 个标准磁贴。标准磁贴格子宽 _cell 由 tile-engine 维护:
//   _cell = floor((vp.clientWidth - 16 - GAP*(COLS-1)) / COLS)  (GAP=4, COLS=4)
// 这里用整块面板宽(documentElement.clientWidth, 不受 Dock 让宽影响)算"标准格子",
// 取一半作 Dock 宽 —— 避免"Dock 占宽→格子变小→Dock 又变"的反馈循环。
function _stdCell() {
  var full = document.documentElement.clientWidth || window.innerWidth || 320;
  var cell = Math.floor((full - 16 - 4 * 3) / 4);
  if (!isFinite(cell) || cell < 24) cell = 24;
  return cell;
}
function _dockScale() { var v = parseFloat(TileAPI.storage.get('dock.scale')); return (isFinite(v) && v > 0) ? v : 1; }
function _applyWidth() {
  document.documentElement.style.setProperty('--dock-w', Math.round(_stdCell() / 2 * _dockScale()) + 'px');
}

// 应用 Dock 显示参数(不透明度/模糊)和左右位置 —— Dock 设置磁贴改完调它即时生效, 启动也调一次。
function _applyDisplay() {
  var op = TileAPI.storage.get('dock.opacity'); if (op == null) op = 0.92;
  var bl = TileAPI.storage.get('dock.blur'); if (bl == null) bl = 6;
  var ic = parseFloat(TileAPI.storage.get('dock.iconScale')); if (!isFinite(ic) || ic <= 0) ic = 1;
  var side = TileAPI.storage.get('dock.side') || 'right';
  document.documentElement.style.setProperty('--dock-opacity', op);
  document.documentElement.style.setProperty('--dock-blur', bl + 'px');
  document.documentElement.style.setProperty('--dock-icon-scale', ic);
  document.body.classList.toggle('dock-left', side === 'left');
}

function _toast(msg, type) { if (TileAPI.toast) TileAPI.toast(msg, type || 'info'); }
function _provider() {
  return TileAPI.getProvider ? TileAPI.getProvider() : (TileAPI.state.get('params.provider') || TileAPI.storage.get('params.provider') || 'aji');
}

// ---------- 内置"常用"动作(Phase 1) ----------
// 1-4 / 9-10 零胶水(单 emit/调用);5-8 少量内联逻辑。
var COMMON_ACTIONS = [
  { id: 'gen',  icon: '▶️', label: '开始生成', type: 'button',
    run: function() { TileAPI.emit('run:start'); } },
  { id: 'repeatLast', icon: '🔁', label: '一键重跑(上次单图)', type: 'button',
    run: function() { TileAPI.emit('run:repeatLast'); } },
  { id: 'stop', icon: '⏹️', label: '停止全部任务', type: 'button',
    run: function() { TileAPI.sendToHost('earlyStop', {}); _toast('已请求停止全部任务'); } },
  { id: 'savePreset', icon: '💾', label: '保存预设', type: 'button',
    run: function() { TileAPI.emit('presets:requestSaveDialog'); } },
  { id: 'addBatch', icon: '📦', label: '加入批处理队列', type: 'button',
    run: function() { TileAPI.emit('run:addToBatch'); } },
  { id: 'provider', icon: '🔄', label: '切换算力来源', type: 'button',
    run: function() {
      // 只在可见的前3个算力间轮换(slotOrder), 隐藏的第4格不参与
      var order = (TileAPI.slotOrder ? TileAPI.slotOrder() : ['aji', 'grs', 'others']);
      var idx = order.indexOf(_provider());
      var next = order[(idx + 1) % order.length] || order[0] || 'aji';
      if (TileAPI.setProvider) TileAPI.setProvider(next, { source: 'dock' });
      else { TileAPI.state.set('params.provider', next); TileAPI.storage.set('params.provider', next); }
      // 兜底: 选中模型若对新算力无效(精简掉/没拉取) → 回退该算力视图第一个; 防止参数磁贴没开时切完出图崩
      var view = TileAPI.state.get('models.' + next) || {};
      var curModel = TileAPI.state.get('params.model');
      if (!curModel || !view[curModel]) {
        var first = Object.keys(view)[0] || '';
        TileAPI.state.set('params.model', first);
        TileAPI.storage.set('params.model', first);
      }
      if (!TileAPI.setProvider) TileAPI.emit('params:providerChanged', { provider: next });
      var def = next === 'aji' ? 'AJI' : next === 'grs' ? (TileAPI.computeBrand ? TileAPI.computeBrand() : 'GRS') : next === 'momo' ? '墨墨' : '其他';
      _toast('算力来源: ' + (TileAPI.slotLabel ? TileAPI.slotLabel(next, def) : def));
    } },
  { id: 'anti', icon: '🛡️', label: '抗截断 (循环 关/抗截断/抗截断+)', type: 'toggle',
    run: function() {
      var cur = +(TileAPI.state.get('params.antiMode') || 0);
      var next = (cur + 1) % 3;
      TileAPI.state.set('params.antiMode', next);
      TileAPI.storage.set('params.antiMode', next);
      TileAPI.sendToHost('updateSettings', { antiMode: next });
      TileAPI.emit('params:antiModeChanged', { mode: next });
      _toast('抗截断: ' + ['关', '抗截断', '抗截断+'][next]);
    },
    getState: function() { return (+(TileAPI.state.get('params.antiMode') || 0)) > 0; } },
  { id: 'autoReturn', icon: '↩️', label: '自动返回 PS', type: 'toggle',
    run: function() {
      var cur = TileAPI.storage.get('output.autoReturn');
      if (cur === null || cur === undefined) cur = true;
      var now = !cur;
      TileAPI.storage.set('output.autoReturn', now);
      TileAPI.emit('output:autoReturnChanged', { value: now });
      _toast('自动返回: ' + (now ? '开' : '关'));
    },
    getState: function() { return TileAPI.storage.get('output.autoReturn') !== false; } },
  { id: 'autoGroup', icon: '📂', label: '自动编组', type: 'toggle',
    run: function() {
      var cur = TileAPI.storage.get('output.autoGroup');
      if (cur === null || cur === undefined) cur = true;
      var now = !cur;
      TileAPI.storage.set('output.autoGroup', now);
      TileAPI.sendToHost('updateSettings', { autoGroup: now });
      TileAPI.emit('output:autoGroupChanged', { value: now });
      _toast('自动编组: ' + (now ? '开' : '关'));
    },
    getState: function() { return TileAPI.storage.get('output.autoGroup') !== false; } },
  { id: 'openPrompt', icon: '📝', label: '展开提示词', type: 'button',
    run: function() { if (TileAPI.expandTile) TileAPI.expandTile('prompt'); } },
  { id: 'openSettings', icon: '⚙️', label: '展开设置', type: 'button',
    run: function() { if (TileAPI.expandTile) TileAPI.expandTile('settings'); } },
  { id: 'colorMatchWavelet', icon: '🎯', label: '精准校色 · 画面没大变时用(修脸/局部修)', type: 'button',
    run: function() { TileAPI.sendToHost('colorMatchRun', { method: 'wavelet', autoReturn: TileAPI.storage.get('output.autoReturn') !== false }); } },
  { id: 'colorMatchGlobal', icon: '🌊', label: '整体校色 · 画面大变/无中生有时用(特效)', type: 'button',
    run: function() { TileAPI.sendToHost('colorMatchRun', { method: 'reinhard', autoReturn: TileAPI.storage.get('output.autoReturn') !== false }); } },
  { id: 'colorMatchAlign', icon: '📐', label: '对齐校色 · 生成有位移/拉伸时先把画面拉回原图再校色', type: 'button',
    run: function() { TileAPI.sendToHost('colorMatchRun', { method: 'wavelet', align: true, autoReturn: TileAPI.storage.get('output.autoReturn') !== false }); } },
  { id: 'alignOnly', icon: '🎛️', label: '只对齐 · 只把回图拉回原图位置, 不动颜色(校色后再单独跑)', type: 'button',
    run: function() { TileAPI.sendToHost('colorMatchRun', { alignOnly: true, autoReturn: TileAPI.storage.get('output.autoReturn') !== false }); } },
  { id: 'openPresetFolder', icon: '📁', label: '打开预设文件夹', type: 'button',
    run: function() { TileAPI.sendToHost('openPresetFolder', {}); _toast('正在打开预设文件夹...'); } },
  { id: 'openCacheFolder', icon: '🗂️', label: '打开缓存文件夹', type: 'button',
    run: function() { TileAPI.sendToHost('openImageCacheFolder', {}); _toast('正在打开缓存文件夹...'); } },
  { id: 'collapseGroups', icon: '📕', label: '折叠所有图层组', type: 'button',
    run: function() { TileAPI.sendToHost('collapseAllGroups', {}); _toast('正在折叠所有组...'); } }
];

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- 动作库 (H): 内置常用 + 各磁贴声明的 actions, 拍平成 {key, action, group} ----------
// key 全局唯一: 'common:<id>' 或 'tile:<tileId>:<id>'。
function _libraryList() {
  var out = [];
  for (var i = 0; i < COMMON_ACTIONS.length; i++) {
    out.push({ key: 'common:' + COMMON_ACTIONS[i].id, action: COMMON_ACTIONS[i], group: '常用' });
  }
  var tiles = (TileAPI.getAllTiles && TileAPI.getAllTiles()) || [];
  for (var t = 0; t < tiles.length; t++) {
    var def = tiles[t];
    if (def && def.actions && def.actions.length) {
      for (var a = 0; a < def.actions.length; a++) {
        out.push({ key: 'tile:' + def.id + ':' + def.actions[a].id, action: def.actions[a], group: def.label || def.id });
      }
    }
    if (def && def.steppers && def.steppers.length) {
      for (var s = 0; s < def.steppers.length; s++) {
        out.push({ key: 'step:' + def.id + ':' + def.steppers[s].id, stepper: def.steppers[s], group: def.label || def.id });
      }
    }
  }
  // 所有磁贴 → "打开磁贴" 快捷项(用磁贴自己的图标 + 名, 点了 expandTile 打开)
  for (var k = 0; k < tiles.length; k++) {
    var d = tiles[k];
    if (!d || !d.id || d.id === 'welcome') continue;
    (function(tid, ticon, tlabel) {
      out.push({
        key: 'open:' + tid,
        action: {
          id: 'open:' + tid, icon: ticon || '🔲', label: '打开 ' + (tlabel || tid),
          run: function() { if (TileAPI.expandTile) TileAPI.expandTile(tid); }
        },
        group: '打开磁贴'
      });
    })(d.id, d.icon, d.label);
  }
  return out;
}
function _libraryMap() {
  var m = {}, list = _libraryList();
  for (var i = 0; i < list.length; i++) m[list[i].key] = list[i];
  return m;
}

// ---------- 已钉选列表(用户挑选 + 排序, 持久化) ----------
var DEFAULT_ITEMS = ['common:gen', 'common:repeatLast', 'common:stop', 'common:savePreset', 'common:anti', 'common:autoReturn', 'common:openPrompt', 'common:openSettings'];
function _pinnedKeys() {
  var v = TileAPI.storage.get('dock.items');
  return Array.isArray(v) ? v.slice() : DEFAULT_ITEMS.slice();
}
function _savePinned(keys) { TileAPI.storage.set('dock.items', keys); }
function _removeKey(key) { _savePinned(_pinnedKeys().filter(function(k) { return k !== key; })); _render(); }
function _addKey(key) {
  var keys = _pinnedKeys();
  if (keys.indexOf(key) === -1) { keys.push(key); _savePinned(keys); _render(); }
}
function _isEditing() { return document.body.classList.contains('dock-editing'); }

// ---------- 渲染 ----------
function _applyState(el, a) {
  var on = false;
  try { on = a.getState ? !!a.getState() : false; } catch (_) {}
  el.classList.toggle('dock-btn-on', on);
}

function _makeBtn(a, key, editing) {
  var el = document.createElement('div');
  el.className = 'dock-btn dock-item';
  el.dataset.key = key;
  el.setAttribute('title', a.label || a.id || '');
  // 中文文字图标(如 张＋ / 型－)用更小字号紧排, 避免巨大汉字 + 折行
  var iconCls = 'tile-icon' + (/[一-鿿]/.test(a.icon || '') ? ' dock-ico-text' : '');
  el.innerHTML = '<div class="' + iconCls + '">' + (a.icon || '•') + '</div>';
  el._action = a;
  var hasState = (a.type === 'toggle' || typeof a.getState === 'function');
  if (hasState) _applyState(el, a);
  if (editing) {
    el.classList.add('dock-item-editing');
    var x = document.createElement('div');
    x.className = 'dock-rm';
    x.textContent = '×';
    x.addEventListener('click', function(ev) { ev.stopPropagation(); _removeKey(key); });
    el.appendChild(x);
    _attachDrag(el);
  } else {
    // 长按进入编辑模式(复用插件编辑模式), 短按触发动作
    var lpTimer = null, lpFired = false;
    el.addEventListener('mousedown', function() {
      lpFired = false;
      lpTimer = setTimeout(function() {
        lpFired = true;
        if (window.TileEngine && typeof TileEngine.enterEdit === 'function') TileEngine.enterEdit();
      }, 400);
    });
    var _cancelLp = function() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
    el.addEventListener('mousemove', _cancelLp);
    el.addEventListener('mouseup', _cancelLp);
    el.addEventListener('mouseleave', _cancelLp);
    el.addEventListener('click', function(ev) {
      ev.stopPropagation();
      if (lpFired) { lpFired = false; return; }   // 长按已进编辑, 不触发动作
      try { if (typeof a.run === 'function') a.run(); }
      catch (err) { console.error('[Dock] action error: ' + (a.id || '?'), err); }
      if (hasState) _applyState(el, a);
    });
  }
  return el;
}

// 参数步进器组(糖葫芦): 上=名+当前值, 中=＋, 下=－; 整组作为一个 .dock-item 添加/拖拽/删除
function _makeStepper(s, key, editing) {
  var el = document.createElement('div');
  el.className = 'dock-stepper dock-item';
  el.dataset.key = key;
  el._stepper = s;
  el.setAttribute('title', s.name || s.id || '');
  var val = '';
  try { val = s.getValue(); } catch (_) {}
  var head = document.createElement('div');
  head.className = 'dock-step-cell dock-step-head';
  head.setAttribute('title', (s.name || '') + ': ' + val);   // 悬停显示完整值(长模型名)
  head.innerHTML = '<span class="dock-step-name">' + _esc(s.name || '') + '</span>' +
                   '<span class="dock-step-val">' + _esc(val) + '</span>';
  var inc = document.createElement('div');
  inc.className = 'dock-step-cell dock-step-inc';
  inc.innerHTML = '<span class="dock-step-sign">＋</span>';
  inc.setAttribute('title', (s.name || '') + ' +');
  var dec = document.createElement('div');
  dec.className = 'dock-step-cell dock-step-dec';
  dec.innerHTML = '<span class="dock-step-sign">－</span>';
  dec.setAttribute('title', (s.name || '') + ' -');
  el.appendChild(head); el.appendChild(inc); el.appendChild(dec);
  if (editing) {
    el.classList.add('dock-item-editing');
    var x = document.createElement('div');
    x.className = 'dock-rm';
    x.textContent = '×';
    x.addEventListener('click', function(ev) { ev.stopPropagation(); _removeKey(key); });
    el.appendChild(x);
    _attachDrag(el);
  } else {
    inc.addEventListener('click', function(ev) { ev.stopPropagation(); try { s.inc(); } catch (e) {} _updateStepper(el); });
    dec.addEventListener('click', function(ev) { ev.stopPropagation(); try { s.dec(); } catch (e) {} _updateStepper(el); });
  }
  return el;
}
function _updateStepper(el) {
  if (!el || !el._stepper) return;
  var v = el.querySelector('.dock-step-val');
  if (v) { try { v.textContent = el._stepper.getValue(); } catch (_) {} }
  var head = el.querySelector('.dock-step-head');
  if (head) { try { head.setAttribute('title', (el._stepper.name || '') + ': ' + el._stepper.getValue()); } catch (_) {} }
}
function _refreshSteppers() {
  if (!_host) return;
  var arr = _host.querySelectorAll('.dock-stepper');
  for (var i = 0; i < arr.length; i++) _updateStepper(arr[i]);
}

function _render() {
  if (!_host) return;
  _host.innerHTML = '';
  var editing = _isEditing();
  var map = _libraryMap();
  var keys = _pinnedKeys();
  for (var i = 0; i < keys.length; i++) {
    var e = map[keys[i]];
    if (!e) continue;   // 该动作已不存在(磁贴未声明/已移除), 跳过
    if (e.stepper) _host.appendChild(_makeStepper(e.stepper, keys[i], editing));
    else _host.appendChild(_makeBtn(e.action, keys[i], editing));
  }
  if (editing) {
    var add = document.createElement('div');
    add.className = 'dock-btn dock-add';
    add.setAttribute('title', '添加动作');
    add.innerHTML = '<div class="tile-icon">＋</div>';
    add.addEventListener('click', function(ev) { ev.stopPropagation(); _openPicker(); });
    _host.appendChild(add);
  }
}

// ---------- 编辑态: 浮动拖拽排序(被拖的跟手浮起, 其它图标平移让位 —— 复用磁贴观感) ----------
function _attachDrag(el) {
  el.addEventListener('mousedown', function(e) {
    if (!_isEditing()) return;
    if (e.target && e.target.closest && e.target.closest('.dock-rm')) return;  // 点×不拖
    e.preventDefault();
    e.stopPropagation();

    var items = Array.prototype.slice.call(_host.querySelectorAll('.dock-item'));
    var startIndex = items.indexOf(el);
    if (startIndex < 0) return;
    var rects = items.map(function(b) { return b.getBoundingClientRect(); });
    var slot = el.offsetHeight + 2;   // 让出的空位 = 被拖项自身高度(兼容糖葫芦组比普通按钮高)
    var startY = e.clientY, curY = e.clientY, moved = false, targetIndex = startIndex;

    _host.classList.add('dock-reordering');   // 暂停抖动
    el.classList.add('dock-dragging');
    el.style.transition = 'none';

    function apply() {
      // 被拖图标跟手浮动(略放大)
      el.style.transform = 'translateY(' + (curY - startY) + 'px) scale(1.06)';
      // 其它图标平移让出空位
      for (var i = 0; i < items.length; i++) {
        if (i === startIndex) continue;
        var shift = 0;
        if (startIndex < targetIndex && i > startIndex && i <= targetIndex) shift = -slot;
        else if (startIndex > targetIndex && i >= targetIndex && i < startIndex) shift = slot;
        items[i].style.transition = 'transform 0.15s cubic-bezier(.4,0,.2,1)';
        items[i].style.transform = shift ? ('translateY(' + shift + 'px)') : '';
      }
    }
    function onMove(ev) {
      moved = true;
      curY = ev.clientY;
      var center = rects[startIndex].top + rects[startIndex].height / 2 + (curY - startY);
      var idx = 0;
      for (var i = 0; i < items.length; i++) {
        if (i === startIndex) continue;
        if (center > rects[i].top + rects[i].height / 2) idx++;
      }
      targetIndex = Math.min(idx, items.length - 1);
      apply();
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      el.classList.remove('dock-dragging');
      _host.classList.remove('dock-reordering');
      for (var i = 0; i < items.length; i++) { items[i].style.transition = ''; items[i].style.transform = ''; }
      if (moved && targetIndex !== startIndex) {
        var addBtn = _host.querySelector('.dock-add');
        var without = items.filter(function(b) { return b !== el; });
        var ref = without[targetIndex] || addBtn || null;
        if (ref) _host.insertBefore(el, ref); else _host.appendChild(el);
        var keys = Array.prototype.slice.call(_host.querySelectorAll('.dock-item'))
          .map(function(b) { return b.dataset.key; });
        _savePinned(keys);
      }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ---------- 动作库选择器(＋) ----------
function _closePicker() { var p = document.getElementById('dockPicker'); if (p && p.parentNode) p.parentNode.removeChild(p); }
function _openPicker() {
  _closePicker();
  var lib = _libraryList();
  var groups = {}, order = [];
  for (var i = 0; i < lib.length; i++) {
    if (!groups[lib[i].group]) { groups[lib[i].group] = []; order.push(lib[i].group); }
    groups[lib[i].group].push(lib[i]);
  }
  var pinned = _pinnedKeys();
  var html = '<div class="dock-picker"><div class="dock-picker-title">添加 / 移除 Dock 动作</div><div class="dock-picker-list">';
  for (var g = 0; g < order.length; g++) {
    html += '<div class="dock-picker-group">' + _esc(order[g]) + '</div>';
    var arr = groups[order[g]];
    for (var j = 0; j < arr.length; j++) {
      var on = pinned.indexOf(arr[j].key) !== -1;
      var eIco = arr[j].stepper ? '±' : (arr[j].action.icon || '•');
      var eLbl = arr[j].stepper ? (arr[j].stepper.name || arr[j].stepper.id) : (arr[j].action.label || arr[j].action.id);
      html += '<div class="dock-picker-item' + (on ? ' on' : '') + '" data-key="' + _esc(arr[j].key) + '">' +
                '<span class="dock-picker-ico">' + eIco + '</span>' +
                '<span class="dock-picker-lbl">' + _esc(eLbl) + '</span>' +
                '<span class="dock-picker-chk">' + (on ? '✓' : '＋') + '</span>' +
              '</div>';
    }
  }
  html += '</div><div class="dock-picker-foot"><button class="w10-btn w10-btn-accent" id="dockPickerDone">完成</button></div></div>';
  var ov = document.createElement('div');
  ov.id = 'dockPicker';
  ov.className = 'dock-picker-overlay';
  ov.innerHTML = html;
  document.body.appendChild(ov);
  ov.addEventListener('click', function(ev) {
    ev.stopPropagation();   // 不冒泡到 document, 否则会触发"点磁贴外→退出编辑"把选择器关掉
    if (ev.target === ov || (ev.target.closest && ev.target.closest('#dockPickerDone'))) { _closePicker(); return; }
    var item = ev.target.closest && ev.target.closest('.dock-picker-item');
    if (!item) return;
    var key = item.dataset.key;
    if (_pinnedKeys().indexOf(key) !== -1) _removeKey(key); else _addKey(key);
    var nowOn = _pinnedKeys().indexOf(key) !== -1;
    item.classList.toggle('on', nowOn);
    var chk = item.querySelector('.dock-picker-chk'); if (chk) chk.textContent = nowOn ? '✓' : '＋';
  });
}


// 只刷新 toggle 高亮(不重建 DOM,避免滚动跳)
function _refreshStates() {
  if (!_host) return;
  var btns = _host.querySelectorAll('.dock-btn');
  for (var i = 0; i < btns.length; i++) {
    var a = btns[i]._action;
    if (a && (a.type === 'toggle' || typeof a.getState === 'function')) _applyState(btns[i], a);
  }
}

// ---------- 开关 ----------
function _setEnabled(on) {
  if (on) {
    _applyWidth();
    _applyDisplay();
    document.body.classList.add('dock-on');
    if (!_host) {
      _host = document.createElement('div');
      _host.id = 'dockHost';
      // 编辑态下吞掉 click, 避免冒泡到 document 的"点磁贴外→退出编辑"逻辑(否则一点就退出编辑)
      _host.addEventListener('click', function(e) { if (_isEditing()) e.stopPropagation(); });
      document.body.appendChild(_host);
    }
    _render();
    _refreshStates();
  } else {
    document.body.classList.remove('dock-on');
    document.documentElement.style.setProperty('--dock-w', '0px');
    // 保留 #dockHost 在 DOM 里(被 CSS 隐藏),再次开启时直接复用
  }
}

// ---------- 接线 ----------
TileAPI.on('app:ready', function() {
  _applyDisplay();
  _setEnabled(TileAPI.storage.get('appearance.dockEnabled') !== false);
});
TileAPI.on('dock:toggle', function(data) {
  _setEnabled(!!(data && data.enabled));
});
// 外部改了这些状态时,刷新 Dock 上对应 toggle 的高亮
TileAPI.on('params:antiModeChanged', _refreshStates);
TileAPI.on('output:autoReturnChanged', _refreshStates);
TileAPI.on('output:autoGroupChanged', _refreshStates);
TileAPI.on('params:providerChanged', _refreshStates);
// 参数(模型/尺寸/张数等)在别处改了 → 刷新 Dock 步进器组里显示的当前值
TileAPI.on('params:remoteChanged', _refreshSteppers);

// 复用插件编辑模式: 进入 → Dock 可拖拽排序/增删; 退出 → 保存并恢复
TileAPI.on('editMode:enter', function() { document.body.classList.add('dock-editing'); _render(); });
TileAPI.on('editMode:exit', function() { document.body.classList.remove('dock-editing'); _closePicker(); _render(); });

// 面板尺寸变化时, Dock 宽度(0.5 标准磁贴)跟着重算
window.addEventListener('resize', function() {
  if (document.body.classList.contains('dock-on')) _applyWidth();
});

// 暴露给「Dock 设置磁贴」调用
window.Dock = {
  setEnabled: _setEnabled,      // 开/关
  applyDisplay: _applyDisplay,  // 应用不透明度/模糊/左右(改完即时生效)
  applyWidth: _applyWidth,      // 应用 Dock 大小(缩放)
  refresh: _render              // 重建 Dock 内容(编辑/增删后用, Phase 3)
};

})();
