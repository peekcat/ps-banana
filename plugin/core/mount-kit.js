// ============================================================
//  mount-kit.js —— v7 组件化地基
//  提供两样东西, 供"合并磁贴"用, 严格遵循 UI_SPEC(w10-* + CSS变量):
//    1. MountKit.createService(spec) —— 造一个"多挂载服务"(照 TT 的 _mounts 数组模式)
//       同一服务可同时渲染在多个容器, 互不串; mount 返回卸载函数。
//    2. MountKit.tabs(container, defs, opts) —— w10 规范的页签组件, 高度自适应不塌陷。
//  依赖: 仅 TileAPI。不改 tile-engine。
// ============================================================
(function() {
'use strict';

// ---------- 1. 多挂载服务工厂 ----------
// spec: {
//   id: 'xxx',                       // 唯一
//   render: function(container){},   // 把内容渲染进 container(每次挂载/刷新都调)
//   cleanup: function(container){},  // 可选, 卸载时清理该容器的 timer 等
//   onMessage: function(action,data){} // 可选, 收后端消息(内部会 refresh)
// }
// 返回: { mount(container)->卸载函数, refresh(), each(cb) }
function createService(spec) {
  var mounts = [];   // 所有当前挂载的容器(数组! 不是单变量)

  function renderOne(c) {
    try { spec.render(c); } catch (e) { console.error('[MountKit] render ' + spec.id + ' 失败:', e); }
  }
  function refresh() { mounts.slice().forEach(renderOne); }

  var api = {
    mount: function(container) {
      if (!container) return function() {};
      if (mounts.indexOf(container) < 0) mounts.push(container);
      renderOne(container);
      return function() {
        var i = mounts.indexOf(container);
        if (i >= 0) mounts.splice(i, 1);
        if (spec.cleanup) { try { spec.cleanup(container); } catch (e) {} }
      };
    },
    refresh: refresh,
    each: function(cb) { mounts.slice().forEach(cb); },
    get mounts() { return mounts.slice(); }
  };

  // 注册成后台服务(收 host 消息), 收到就 refresh 所有挂载点
  if (typeof TileAPI.registerService === 'function') {
    TileAPI.registerService({
      id: spec.id,
      onMessage: function(action, data) {
        if (spec.onMessage) { try { spec.onMessage(action, data); } catch (e) {} }
      }
    });
  }
  return api;
}

// ---------- 2. w10 页签组件 ----------
// container: 挂载容器
// defs: [{ id, label, mount:function(bodyEl){return 卸载函数} }]
//   mount 负责把该页内容渲染进 bodyEl, 返回卸载函数(切页/收起时调)
// opts: { storageKey?:记住上次页签, initial?:默认页id }
// 返回: 整体卸载函数
function tabs(container, defs, opts) {
  opts = opts || {};
  container.classList.add('w10-tabs-host');

  var bar = document.createElement('div');
  bar.className = 'w10-tabbar';
  var body = document.createElement('div');
  body.className = 'w10-tabbody';
  container.appendChild(bar);
  container.appendChild(body);

  var current = null, unmount = null;

  function open(id) {
    if (current === id) return;
    var def = null;
    for (var i = 0; i < defs.length; i++) if (defs[i].id === id) def = defs[i];
    if (!def) return;
    current = id;
    if (opts.storageKey) { try { TileAPI.storage.set(opts.storageKey, id); } catch (e) {} }
    Array.prototype.forEach.call(bar.children, function(b) {
      b.classList.toggle('on', b.dataset.tab === id);
    });
    if (unmount) { try { unmount(); } catch (e) {} unmount = null; }
    body.innerHTML = '';
    try { unmount = def.mount(body) || null; } catch (e) { console.error('[MountKit] tab ' + id + ' mount 失败:', e); }
    // 注意: 不要再给 body 叠淡入动画 — 挂载的磁贴内容(w10-panel 行)自带
    // w10SlideIn 错落入场, 再叠一层会变成"闪两次"。
  }

  defs.forEach(function(d) {
    var b = document.createElement('button');
    b.className = 'w10-tab';
    b.dataset.tab = d.id;
    b.textContent = d.label;
    b.addEventListener('click', function() { open(d.id); });
    bar.appendChild(b);
  });

  var initial = opts.initial
    || (opts.storageKey && TileAPI.storage.get(opts.storageKey))
    || (defs[0] && defs[0].id);
  var valid = defs.some(function(d) { return d.id === initial; });
  open(valid ? initial : (defs[0] && defs[0].id));

  return function() {
    if (unmount) { try { unmount(); } catch (e) {} unmount = null; }
    if (container.contains(bar)) container.removeChild(bar);
    if (container.contains(body)) container.removeChild(body);
  };
}

window.MountKit = { createService: createService, tabs: tabs, mountTile: mountTile };

// ---------- 3. 把现有磁贴挂进任意容器(修正版) ----------
// 关键修复(之前踩的坑): 老磁贴靠容器尺寸/ sizeHint 判宽窄, 挂载瞬间 clientWidth=0 → 布局塌。
// 这里延到下一帧、用真实测量尺寸算 sizeHint 再调 onExpand。
// tileId: 目标磁贴; container: 宿主; 返回卸载函数。
function mountTile(tileId, container) {
  var def = TileAPI.getTileDef(tileId);
  if (!def || !def.onExpand) {
    container.innerHTML = '<div class="w10-panel"><div class="w10-row-desc">模块 ' + tileId + ' 未加载</div></div>';
    return function() {};
  }
  var cleanup = null, disposed = false;

  function doMount() {
    if (disposed) return;
    var w = container.clientWidth || (container.parentElement ? container.parentElement.clientWidth : 0) || 0;
    var h = container.clientHeight || 0;
    // v6.5.6 修"就地展开偶发空白": rAF 那一帧容器可能仍是 0 宽(就地面板高度动画刚起步),
    // 此时用假设值渲染会让内容以错误布局渲出去甚至空白。改为最多重试 10 帧等真实尺寸。
    if (w < 40 && _retries < 10) {
      _retries++;
      requestAnimationFrame(doMount);
      return;
    }
    if (!w) w = 320;
    if (!h) h = 400;
    // layout 判定跟磁贴引擎一致: 宽>高偏 wide, 窄面板 narrow
    var layout = (w >= 360) ? 'wide' : 'narrow';
    try {
      cleanup = def.onExpand(container, { width: w, height: h, layout: layout, expandMode: 'mounted' });
    } catch (e) {
      console.error('[MountKit] mountTile ' + tileId + ' 失败:', e);
      container.innerHTML = '<div class="w10-panel"><div class="w10-row-desc">模块出错: ' + (e && e.message) + '</div></div>';
    }
  }
  var _retries = 0;
  // 延一帧让容器拿到真实尺寸(修布局塌陷的关键)
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(doMount);
  else setTimeout(doMount, 16);

  return function() {
    disposed = true;
    if (typeof cleanup === 'function') { try { cleanup(); } catch (e) {} }
    try { if (def.onCollapse) def.onCollapse(); } catch (e) {}
    container.innerHTML = '';
  };
}
})();
