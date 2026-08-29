// ============================================================
//  tile-canvas.js — 创意幕布 (节点画布)
//
//  ComfyUI / Houdini 式横向大画布:
//    - 世界容器 transform 平移缩放; 节点平铺; 端口拖拽连线(SVG, 带吸附)
//    - 节点产出有"类型": 图片(image) / 提示词(prompt)
//    - 生成节点: 自带 服务商/模型/尺寸/比例, 有输出口, 结果显示在节点里, 可往下接
//    - 执行引擎: 按连线依赖拓扑执行(运行全部 / 运行到此)
//    - 导入: PS选区 / 文件 / 网址 / 拖入
//    - 存档: 结构走 storage, 图片走 host 文件(canvas_images/)
// ============================================================
(function() {
'use strict';

// ── 节点类型表(加新节点在这里登记一行即可) ──
//   out:  这个节点产出的数据类型 'image' | 'prompt' | null
//   ins:  输入口 [{name, dtype, multi}]
var TYPE = {
  image:    { icon: '🖼️', title: '图片',   out: 'image',  ins: [] },
  prompt:   { icon: '📝', title: '提示词', out: 'prompt', ins: [] },
  crop:     { icon: '✂️', title: '裁切',   out: 'image',  ins: [{ name: 'in', dtype: 'image' }] },
  pad:      { icon: '⬜', title: '扩边',   out: 'image',  ins: [{ name: 'in', dtype: 'image' }] },
  resize:   { icon: '⤢', title: '缩放',   out: 'image',  ins: [{ name: 'in', dtype: 'image' }] },
  combine:  { icon: '▦', title: '拼接',   out: 'image',  ins: [{ name: 'in', dtype: 'image', multi: true }] },
  promptcat:{ icon: '＋', title: '拼词',   out: 'prompt', ins: [{ name: 'in', dtype: 'prompt', multi: true }] },
  pscapture:{ icon: '📷', title: 'PS抓取', out: 'image',  ins: [] },
  psregion: { icon: '🔲', title: 'PS区域', out: 'image',  ins: [] },
  generate: { icon: '⚡', title: '生成',   out: 'image',  ins: [
                { name: 'img',    dtype: 'image',  multi: true },
                { name: 'prompt', dtype: 'prompt' }
              ] },
  tops:     { icon: '↗', title: '输出PS', out: 'image',  ins: [{ name: 'in', dtype: 'image' }] },
  save:     { icon: '💾', title: '保存',   out: 'image',  ins: [{ name: 'in', dtype: 'image' }] }
};

// 节点体显示"缩略图+摘要+运行按钮"的类型
var IMG_OP = { crop: 1, pad: 1, resize: 1, combine: 1, generate: 1, tops: 1, save: 1, pscapture: 1, psregion: 1 };
// 走客户端 canvas 变换的类型(crop/pad/resize/combine)
var TRANSFORM = { crop: 1, pad: 1, resize: 1, combine: 1 };
// 节点类别(决定标题栏配色, 一眼看懂数据流): 源/提示词/变换/生成/输出
var CATEGORY = {
  image: 'source', pscapture: 'source', psregion: 'source',
  prompt: 'prompt', promptcat: 'prompt',
  crop: 'transform', pad: 'transform', resize: 'transform', combine: 'transform',
  generate: 'generate',
  tops: 'output', save: 'output'
};

var ASPECTS = ['Auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];

// 人体剪影 颜色→部位(对应 icons/body/body_full_map.png, 与剪影磁贴一致)
var BODY_COLOR_MAP = {
  '255,0,0': 'head', '0,255,0': 'hair', '0,0,255': 'neck', '255,255,0': 'torso',
  '0,255,255': 'arms', '255,0,255': 'hands', '255,128,0': 'legs', '128,0,255': 'feet',
  '255,0,128': 'clothing', '128,64,0': 'accessory', '128,128,128': 'fullbody',
  '192,192,192': 'lighting', '0,128,0': 'background', '0,0,128': 'weapon',
  '128,128,0': 'cleanup', '255,128,255': 'effects', '64,64,64': 'other'
};

// ── 模块级状态(折叠/展开间保留) ──
var _project = { nodes: {}, wires: [] };
var _view = { panX: 80, panY: 80, zoom: 1 };
var _selectedId = null;
var _selIds = [];   // 多选: 选中的节点 id 数组(_selectedId 是其中"主选", 给底栏用)
var _loadedFromStorage = false;

var _container = null;
var _root = null, _viewport = null, _world = null, _wiresSvg = null, _bottomBar = null;
var _seq = 0;
var _saveTimer = null;
var _running = false;

var NODE_W = 176;

// ── host 请求/回包(reqId 配对) ──
var _pending = {};
var _reqSeq = 0;
function _hostReq(action, payload) {
  return new Promise(function(resolve) {
    var reqId = 'cv' + (++_reqSeq) + '_' + Date.now();
    _pending[reqId] = resolve;
    var d = Object.assign({}, payload || {}, { reqId: reqId });
    delete d._timeout;
    TileAPI.sendToHost(action, d);
    var to = (payload && payload._timeout) || 60000;
    setTimeout(function() {
      if (_pending[reqId]) { delete _pending[reqId]; resolve({ success: false, error: '请求超时' }); }
    }, to);
  });
}

// ── 工具 ──
function _uid(p) { return (p || 'n') + (++_seq) + '_' + Math.random().toString(36).slice(2, 6); }
function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function _dataURI(b64, mime) { return b64 ? ('data:' + (mime || 'image/png') + ';base64,' + b64) : ''; }
function _clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// 节点参数摘要(显示在节点体上)
function _opSummary(n) {
  if (n.type === 'generate') return (n.provider || 'aji') + ' · ' + (n.model || '?') + ' · ' + (n.size || '2K') + ' · ' + (n.aspect || 'Auto');
  if (n.type === 'crop') return '裁切 ' + (n.rect ? (Math.round(n.rect.w * 100) + '×' + Math.round(n.rect.h * 100) + '%') : '整图');
  if (n.type === 'pad') return '扩边→' + (n.padRatio || '1:1') + ' ' + ({ transparent: '透明', white: '白', black: '黑' }[n.padColor || 'transparent']);
  if (n.type === 'resize') return '缩放 长边' + (n.longEdge || 1024);
  if (n.type === 'combine') return '拼接 ' + ({ h: '横排', v: '纵排', grid: '网格' }[n.layout || 'h']);
  if (n.type === 'pscapture') return 'PS 实时抓取';
  if (n.type === 'tops') return '输出到 PS 图层';
  if (n.type === 'save') return '保存到磁盘';
  if (n.type === 'psregion') return 'PS 区域' + (n.regionSel ? '(已记录)' : '(未记录)');
  return '';
}

// ── 几何: 节点高度 / 端口 ──
function _nodeW(n) { return (n && n.w) ? n.w : NODE_W; }
function _nodeH(n) {
  if (n && n.h) return n.h;   // 用户拖拽过 → 用自定义高
  switch (n.type) {
    case 'image': return 158;
    case 'prompt': return 118 + _promptFields(n.text).length * 30 + _promptParams(n.text).length * 26;
    case 'generate': return 212;
    case 'crop': case 'pad': case 'resize': case 'combine': case 'pscapture': case 'tops': case 'save': case 'psregion': return 196;
    case 'promptcat': return 110;
    default: return 140;
  }
}
function _ports(n) {
  var def = TYPE[n.type]; if (!def) return [];
  var ports = [];
  (def.ins || []).forEach(function(inp, i) {
    ports.push({ name: inp.name, side: 'left', dtype: inp.dtype, multi: !!inp.multi, y: 46 + i * 30 });
  });
  if (def.out) ports.push({ name: 'out', side: 'right', dtype: def.out, y: _nodeH(n) / 2 });
  return ports;
}
function _portPos(n, portName) {
  var ps = _ports(n);
  for (var i = 0; i < ps.length; i++) {
    if (ps[i].name === portName) {
      return { x: n.x + (ps[i].side === 'right' ? _nodeW(n) : 0), y: n.y + ps[i].y, dtype: ps[i].dtype, side: ps[i].side };
    }
  }
  return null;
}

// ── 坐标换算 ──
function _screenToWorld(cx, cy) {
  var r = _viewport.getBoundingClientRect();
  return { x: (cx - r.left - _view.panX) / _view.zoom, y: (cy - r.top - _view.panY) / _view.zoom };
}
function _viewCenterWorld() {
  var r = _viewport.getBoundingClientRect();
  return _screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
}

function _applyView() {
  if (_world) _world.style.transform = 'translate(' + _view.panX + 'px,' + _view.panY + 'px) scale(' + _view.zoom + ')';
  var zi = _container && _container.querySelector('.cv-zoom-ind');
  if (zi) zi.textContent = Math.round(_view.zoom * 100) + '%';
}

// ============================================================
//  渲染
// ============================================================
function _renderAll() { _renderNodes(); _renderWires(); _applyView(); _renderBottomBar(); }

function _renderNodes() {
  if (!_world) return;
  // 就地协调(不再清空全部再重建, 消除整屏抖动): 逐个替换/新增, 再删除多余的
  var seen = {};
  Object.keys(_project.nodes).forEach(function(id) {
    seen[id] = 1;
    var old = _world.querySelector('.cv-node[data-node="' + id + '"]');
    // 正在编辑(焦点在该节点内)就不重建, 避免打断输入/丢焦点
    if (old && old.contains(document.activeElement)) return;
    var fresh = _buildNode(_project.nodes[id]);
    if (old) _world.replaceChild(fresh, old);
    else _world.appendChild(fresh);
  });
  var all = _world.querySelectorAll('.cv-node');
  for (var i = 0; i < all.length; i++) {
    if (!seen[all[i].getAttribute('data-node')]) all[i].remove();
  }
  if (_viewport) { var eh = _viewport.querySelector('.cv-empty-hint'); if (eh) eh.style.display = Object.keys(_project.nodes).length ? 'none' : 'block'; }
}

function _buildNode(n) {
  var def = TYPE[n.type] || { icon: '?', title: n.type };
  var el = document.createElement('div');
  el.className = 'cv-node cv-cat-' + (CATEGORY[n.type] || 'misc') + (_selIds.indexOf(n.id) >= 0 ? ' cv-selected' : '') + (n._running ? ' cv-node-running' : '');
  el.setAttribute('data-node', n.id);
  el.style.left = n.x + 'px';
  el.style.top = n.y + 'px';
  el.style.width = _nodeW(n) + 'px';
  if (n.h) el.style.height = n.h + 'px';   // 手动缩放过才锁高; 否则内容自适应

  var body = '';
  if (n.type === 'image') {
    body = n.imgB64
      ? '<img class="cv-img-thumb" src="' + _dataURI(n.imgB64, n.mime) + '">'
      : '<div class="cv-img-empty">' + (n.loading ? '载入中…' : '空') + '</div>';
  } else if (n.type === 'prompt') {
    var fl = _promptFields(n.text), pm = _promptParams(n.text);
    body = '<textarea class="cv-node-prompt" data-nodeedit="' + n.id + '" placeholder="写提示词…(也可在底栏选预设)">' + _esc(n.text) + '</textarea>';
    if (fl.length) {
      body += '<div class="cv-node-fields">' + fl.map(function(f, i) {
        return '<label class="cv-nf"><span>' + _esc(f.name) + '</span><input type="text" data-nfld="' + i + '" value="' + _esc(f.value) + '"></label>';
      }).join('') + '</div>';
    }
    if (pm.length) {
      body += '<div class="cv-node-params">' + pm.map(function(p, i) {
        return '<div class="cv-np" title="' + _esc(p.desc) + '"><span>' + _esc(p.label) + '</span>' +
          '<input type="range" min="0" max="1" step="0.01" data-nprm="' + i + '" value="' + p.value + '">' +
          '<span class="cv-npv" data-npval="' + i + '">' + p.value.toFixed(2) + '</span></div>';
      }).join('') + '</div>';
    }
  } else if (n.type === 'promptcat') {
    body = '<div class="cv-prompt-text" style="color:#9aa;white-space:pre-wrap">多个提示词连到左边输入口\n用「' + _esc(n.sep || ', ') + '」拼接</div>';
  } else if (IMG_OP[n.type]) {
    body =
      (n.imgB64
        ? '<img class="cv-img-thumb" src="' + _dataURI(n.imgB64, n.mime) + '">'
        : '<div class="cv-img-empty">' + _esc(n.status || (n.loading ? '载入中…' : '未运行')) + '</div>') +
      ((n.type === 'generate' && ((n.resultFiles && n.resultFiles.length > 1) || (n.results && n.results.length > 1)))
        ? '<div class="cv-gen-switch"><span class="cv-gen-arrow" data-genprev="' + n.id + '">‹</span><span>' + ((n.picked || 0) + 1) + '/' + ((n.resultFiles && n.resultFiles.length) || n.results.length) + '</span><span class="cv-gen-arrow" data-gennext="' + n.id + '">›</span></div>'
        : '') +
      '<div class="cv-gen-sum">' + _esc(_opSummary(n)) + '</div>' +
      '<button class="cv-gen-btn" data-gen="' + n.id + '">▶ 运行到此</button>' +
      '<div class="cv-gen-status">' + _esc(n.status || '') + '</div>';
  }

  el.innerHTML =
    '<div class="cv-node-head" data-drag="' + n.id + '">' +
      '<span class="cv-node-icon">' + def.icon + '</span>' +
      '<span class="cv-node-title">' + _esc(n.name || def.title) + '</span>' +
      '<span class="cv-node-del" data-del="' + n.id + '">✕</span>' +
    '</div>' +
    '<div class="cv-node-body">' + body + '</div>' +
    '<div class="cv-resize" data-resize="' + n.id + '" title="拖拽缩放"></div>';

  _ports(n).forEach(function(p) {
    var dot = document.createElement('div');
    dot.className = 'cv-port' + (p.dtype === 'prompt' ? ' cv-port-prompt' : '');
    dot.setAttribute('data-port', p.name);
    dot.setAttribute('data-node', n.id);
    dot.setAttribute('data-side', p.side);
    dot.setAttribute('data-dtype', p.dtype);
    dot.style.top = (p.y - 6.5) + 'px';
    dot.style.left = (p.side === 'right' ? (_nodeW(n) - 6.5) : -6.5) + 'px';
    el.appendChild(dot);
    if (p.side === 'left') {
      var lab = document.createElement('div');
      lab.className = 'cv-port-label';
      lab.textContent = p.name === 'img' ? '图' : p.name === 'prompt' ? '词' : '';
      lab.style.top = (p.y - 7) + 'px'; lab.style.left = '10px';
      el.appendChild(lab);
    }
  });

  return el;
}

function _renderWires() {
  if (!_wiresSvg) return;
  while (_wiresSvg.firstChild) _wiresSvg.removeChild(_wiresSvg.firstChild);
  var SVGNS = 'http://www.w3.org/2000/svg';
  // 箭头标记(指向目标端口, 一眼看清数据流向)
  var defs = document.createElementNS(SVGNS, 'defs');
  var mk = document.createElementNS(SVGNS, 'marker');
  mk.setAttribute('id', 'cvArrowHead'); mk.setAttribute('viewBox', '0 0 10 10');
  mk.setAttribute('refX', '8'); mk.setAttribute('refY', '5');
  mk.setAttribute('markerWidth', '8'); mk.setAttribute('markerHeight', '8');
  mk.setAttribute('orient', 'auto-start-reverse'); mk.setAttribute('markerUnits', 'userSpaceOnUse');
  var mp = document.createElementNS(SVGNS, 'path');
  mp.setAttribute('d', 'M0 0 L10 5 L0 10 z'); mp.setAttribute('fill', '#5a6b86');
  mk.appendChild(mp); defs.appendChild(mk); _wiresSvg.appendChild(defs);
  function addWire(d, id) {
    var g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'cv-wire-g'); g.setAttribute('data-wire', id);
    var hit = document.createElementNS(SVGNS, 'path');
    hit.setAttribute('class', 'cv-wire-hit'); hit.setAttribute('vector-effect', 'non-scaling-stroke'); hit.setAttribute('d', d);
    var vis = document.createElementNS(SVGNS, 'path');
    vis.setAttribute('class', 'cv-wire'); vis.setAttribute('vector-effect', 'non-scaling-stroke'); vis.setAttribute('d', d);
    vis.setAttribute('marker-end', 'url(#cvArrowHead)');
    g.appendChild(hit); g.appendChild(vis); _wiresSvg.appendChild(g);
  }
  function addTemp(d) {
    var p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('class', 'cv-wire cv-wire-temp'); p.setAttribute('vector-effect', 'non-scaling-stroke'); p.setAttribute('d', d);
    _wiresSvg.appendChild(p);
  }
  _project.wires.forEach(function(w) {
    var a = _project.nodes[w.from.node], b = _project.nodes[w.to.node];
    if (!a || !b) return;
    var p1 = _portPos(a, w.from.port), p2 = _portPos(b, w.to.port);
    if (!p1 || !p2) return;
    addWire(_wirePath(p1.x, p1.y, p2.x, p2.y), w.id);
  });
  if (_tempWire) addTemp(_wirePath(_tempWire.x1, _tempWire.y1, _tempWire.x2, _tempWire.y2));
}

function _deleteWire(id) { _project.wires = _project.wires.filter(function(w) { return w.id !== id; }); _renderWires(); _scheduleSave(); }

function _wirePath(x1, y1, x2, y2) {
  var dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + dx) + ' ' + y1 + ', ' + (x2 - dx) + ' ' + y2 + ', ' + x2 + ' ' + y2;
}

// ============================================================
//  节点增删 / 选择
// ============================================================
function _addNode(type, extra) {
  var c = _viewCenterWorld();
  var k = Object.keys(_project.nodes).length % 5;
  var n = Object.assign({
    id: _uid(type), type: type,
    x: Math.round(c.x - NODE_W / 2) + k * 20,
    y: Math.round(c.y - 60) + k * 14,
    text: '', imgB64: null, imgFile: '', status: ''
  }, extra || {});
  if (type === 'generate') {
    var gp = TileAPI.state.get('params.provider') || 'aji';
    if (['aji', 'grs', 'momo', 'others'].indexOf(gp) === -1) gp = 'aji';
    if (!n.provider) n.provider = gp;
    if (!n.model) { var ms = _modelsOf(n.provider); var ks = Object.keys(ms); n.model = ks.length ? ks[0] : ''; }
    if (!n.size) n.size = TileAPI.state.get('params.size') || '2K';
    if (!n.aspect) n.aspect = TileAPI.state.get('params.aspectRatio') || 'Auto';
    if (!n.count) n.count = 1;
  }
  if (type === 'crop' && !n.rect) n.rect = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  if (type === 'pad') { if (!n.padRatio) n.padRatio = '1:1'; if (!n.padColor) n.padColor = 'transparent'; }
  if (type === 'resize' && !n.longEdge) n.longEdge = 1024;
  if (type === 'combine' && !n.layout) n.layout = 'h';
  if (type === 'promptcat' && n.sep == null) n.sep = ', ';
  _project.nodes[n.id] = n;
  _select(n.id);
  _renderAll();
  _scheduleSave();
  return n;
}

function _deleteNode(id) {
  delete _project.nodes[id];
  _project.wires = _project.wires.filter(function(w) { return w.from.node !== id && w.to.node !== id; });
  var si = _selIds.indexOf(id); if (si >= 0) _selIds.splice(si, 1);
  if (_selectedId === id) _selectedId = _selIds.length ? _selIds[_selIds.length - 1] : null;
  _renderAll();
  _scheduleSave();
}

function _deleteSelected() {
  if (!_selIds.length) return;
  var ids = _selIds.slice();
  ids.forEach(function(id) {
    delete _project.nodes[id];
    _project.wires = _project.wires.filter(function(w) { return w.from.node !== id && w.to.node !== id; });
  });
  _selIds = []; _selectedId = null;
  _renderAll();
  _scheduleSave();
}

function _clearCanvas() {
  if (!Object.keys(_project.nodes).length) return;
  var doClear = function() { _project = { nodes: {}, wires: [] }; _selectedId = null; _renderAll(); _scheduleSave(); };
  if (window.TileAPI && TileAPI.confirm) {
    TileAPI.confirm('清空整个幕布?\n所有节点和连线会移除(已贴回 PS 的图层不受影响)。').then(function(ok) { if (ok) doClear(); });
  } else { doClear(); }
}

function _select(id) {
  _selIds = id ? [id] : [];
  _selectedId = id;
  _refreshSelVisual();
  _renderBottomBar();
}
function _selToggle(id) {
  var i = _selIds.indexOf(id);
  if (i >= 0) _selIds.splice(i, 1); else _selIds.push(id);
  _selectedId = _selIds.length ? _selIds[_selIds.length - 1] : null;
  _refreshSelVisual();
  _renderBottomBar();
}
function _selMany(ids) {
  _selIds = ids.slice();
  _selectedId = _selIds.length ? _selIds[_selIds.length - 1] : null;
  _refreshSelVisual();
  _renderBottomBar();
}
function _refreshSelVisual() {
  if (!_world) return;
  _world.querySelectorAll('.cv-node').forEach(function(el) {
    el.classList.toggle('cv-selected', _selIds.indexOf(el.getAttribute('data-node')) >= 0);
  });
}

// ── 图片落图: 存内存 + 存 host 文件 ──
function _setNodeImage(node, b64, mime) {
  node.imgB64 = b64; node.loading = false;
  if (mime) node.mime = mime;
  if (!node.imgFile) node.imgFile = 'img_' + node.id + '.png';
  _hostReq('canvasSaveImage', { fileName: node.imgFile, base64: b64 });
  _renderNodes(); _renderWires();
  _scheduleSave();
}

// ── 图片放大预览 + 发送到 PS 编辑 ──
function _openPreview(node) {
  if (!_root || !node || !node.imgB64) return;
  var ov = document.createElement('div'); ov.className = 'cv-preview';
  var img = document.createElement('img'); img.src = _dataURI(node.imgB64, node.mime);
  var bar = document.createElement('div'); bar.className = 'cv-preview-bar';
  var sendBtn = document.createElement('button'); sendBtn.className = 'cv-gen-btn'; sendBtn.style.cssText = 'width:auto;padding:8px 18px'; sendBtn.textContent = '↗ 发送到 PS 编辑(智能对象)';
  var hint = document.createElement('span'); hint.className = 'cv-preview-hint2'; hint.textContent = '点空白处关闭';
  bar.appendChild(sendBtn); bar.appendChild(hint);
  ov.appendChild(img); ov.appendChild(bar);
  sendBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    sendBtn.disabled = true; sendBtn.textContent = '发送中…';
    _hostReq('canvasPlaceToPS', { base64: node.imgB64 }).then(function(res) {
      TileAPI.toast(res && res.success ? '已作为智能对象发送到 PS' : ('发送失败: ' + ((res && res.error) || '')), res && res.success ? 'success' : 'error');
      sendBtn.disabled = false; sendBtn.textContent = '↗ 发送到 PS 编辑(智能对象)';
    });
  });
  ov.addEventListener('click', function() { if (ov.parentNode) ov.parentNode.removeChild(ov); });
  _root.appendChild(ov);
}

// ── 工作流 导出/导入(含内置图片 base64) ──
async function _exportWorkflow() {
  TileAPI.toast('正在打包工作流…', 'info');
  var ids = Object.keys(_project.nodes);
  for (var i = 0; i < ids.length; i++) {
    var nn = _project.nodes[ids[i]];
    if (nn.imgFile && !nn.imgB64) {
      var r = await _hostReq('canvasLoadImage', { fileName: nn.imgFile });
      if (r && r.success && r.base64) nn.imgB64 = r.base64;
    }
  }
  var nodes = {};
  ids.forEach(function(id) {
    var n = _project.nodes[id], o = { id: id };
    ['type', 'x', 'y', 'name', 'text', 'provider', 'model', 'size', 'aspect', 'count', 'rect', 'padColor', 'padRatio', 'longEdge', 'layout', 'sep', 'mime'].forEach(function(k) { if (n[k] != null) o[k] = n[k]; });
    if (n.imgB64) o.imgB64 = n.imgB64;
    nodes[id] = o;
  });
  var json = JSON.stringify({ _wcCanvas: 1, version: 1, nodes: nodes, wires: _project.wires, view: _view });
  var res = await _hostReq('canvasExportWorkflow', { json: json, _timeout: 120000 });
  if (res && res.success) TileAPI.toast('工作流已导出', 'success');
  else if (!(res && res.canceled)) TileAPI.toast('导出失败: ' + ((res && res.error) || ''), 'error');
}

async function _importWorkflow() {
  var res = await _hostReq('canvasImportWorkflow', { _timeout: 120000 });
  if (!res || !res.success) { if (!(res && res.canceled)) TileAPI.toast('导入失败: ' + ((res && res.error) || ''), 'info'); return; }
  var doc; try { doc = JSON.parse(res.json); } catch (e) { TileAPI.toast('文件不是有效的工作流', 'error'); return; }
  if (!doc || !doc.nodes) { TileAPI.toast('文件不是有效的工作流', 'error'); return; }
  _project = { nodes: {}, wires: Array.isArray(doc.wires) ? doc.wires : [] };
  Object.keys(doc.nodes).forEach(function(id) {
    var s = doc.nodes[id];
    var n = Object.assign({ id: id, imgFile: '', imgB64: null, status: '' }, s);
    if (s.imgB64) { n.imgB64 = s.imgB64; n.imgFile = 'img_' + id + '.png'; _hostReq('canvasSaveImage', { fileName: n.imgFile, base64: s.imgB64 }); }
    _project.nodes[id] = n;
  });
  if (doc.view) _view = doc.view;
  _selIds = []; _selectedId = null;
  _renderAll(); _scheduleSave();
  TileAPI.toast('工作流已导入', 'success');
}

// ── 幕布设置 ──
function _openSettings() {
  if (!_root) return;
  var on = TileAPI.storage.get('canvas.compress') === true;
  var ov = document.createElement('div'); ov.className = 'cv-picker';
  ov.innerHTML =
    '<div class="cv-pick-panel">' +
      '<div class="cv-pick-title"><span>⚙ 幕布设置</span><span class="cv-pick-close">✕</span></div>' +
      '<div class="cv-pick-list" style="padding:14px">' +
        '<label style="display:flex;align-items:flex-start;gap:10px;color:#ddd;font-size:13px;cursor:pointer;line-height:1.5">' +
          '<input type="checkbox" id="cvSetCompress" ' + (on ? 'checked' : '') + ' style="margin-top:3px"> ' +
          '<span>发送给模型前压缩<br><span style="color:#888;font-size:12px">长边缩到 2048 + 转 JPEG, 省流量、上传更快。默认关(原图无损)。</span></span>' +
        '</label>' +
      '</div>' +
    '</div>';
  function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
  ov.addEventListener('click', function(e) { if (e.target === ov || (e.target.closest && e.target.closest('.cv-pick-close'))) close(); });
  var cb = ov.querySelector('#cvSetCompress');
  if (cb) cb.addEventListener('change', function() { try { TileAPI.storage.set('canvas.compress', cb.checked); } catch (_) {} });
  _root.appendChild(ov);
}

// ── 人体剪影选择器: 点小人身体部位 → 列该部位预设 → 填进提示词节点 ──
function _bodyColorCat(r, g, b, a) {
  if (a != null && a < 10) return null;
  var best = null, bestD = 1e9;
  Object.keys(BODY_COLOR_MAP).forEach(function(k) {
    var p = k.split(','), dr = p[0] - r, dg = p[1] - g, db = p[2] - b, d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = BODY_COLOR_MAP[k]; }
  });
  return bestD <= 3000 ? best : null;
}
function _openBodyPicker(node) {
  if (!_root) return;
  var ov = document.createElement('div'); ov.className = 'cv-bodypick';
  ov.innerHTML =
    '<div class="cv-bp-panel">' +
      '<div class="cv-pick-title"><span>🧍 人体剪影 · 点身体部位挑预设</span><span class="cv-pick-close">✕</span></div>' +
      '<div class="cv-bp-body">' +
        '<div class="cv-bp-stage"><canvas class="cv-bp-canvas"></canvas></div>' +
        '<div class="cv-bp-list"><div class="cv-pick-empty">点左边小人身上的部位 →</div></div>' +
      '</div>' +
    '</div>';
  _root.appendChild(ov);
  var cv = ov.querySelector('.cv-bp-canvas'), listEl = ov.querySelector('.cv-bp-list');
  var ctx = cv.getContext('2d'), mapImg = null, mapCtx = null;
  function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
  ov.querySelector('.cv-pick-close').addEventListener('click', close);
  ov.addEventListener('click', function(e) { if (e.target === ov) close(); });
  function loadSrc(src) { return new Promise(function(res, rej) { var im = new Image(); im.onload = function() { res(im); }; im.onerror = function() { rej(new Error('图加载失败 ' + src)); }; im.src = src; }); }
  Promise.all([loadSrc('icons/body/body_full.png'), loadSrc('icons/body/body_full_map.png')]).then(function(imgs) {
    var body = imgs[0]; mapImg = imgs[1];
    var scale = Math.min(340 / body.naturalWidth, 520 / body.naturalHeight);
    cv.width = Math.round(body.naturalWidth * scale); cv.height = Math.round(body.naturalHeight * scale);
    ctx.drawImage(body, 0, 0, cv.width, cv.height);
    var mc = document.createElement('canvas'); mc.width = mapImg.naturalWidth; mc.height = mapImg.naturalHeight;
    mapCtx = mc.getContext('2d'); mapCtx.drawImage(mapImg, 0, 0);
  }).catch(function() { listEl.innerHTML = '<div class="cv-pick-empty">剪影图加载失败</div>'; });
  cv.addEventListener('click', function(e) {
    if (!mapCtx) return;
    var r = cv.getBoundingClientRect();
    var mx = Math.floor((e.clientX - r.left) / r.width * mapImg.naturalWidth);
    var my = Math.floor((e.clientY - r.top) / r.height * mapImg.naturalHeight);
    if (mx < 0 || my < 0 || mx >= mapImg.naturalWidth || my >= mapImg.naturalHeight) return;
    var d = mapCtx.getImageData(mx, my, 1, 1).data;
    var cat = _bodyColorCat(d[0], d[1], d[2], d[3]);
    if (!cat) { listEl.innerHTML = '<div class="cv-pick-empty">这个部位没识别到分类</div>'; return; }
    var ps = (TileAPI.state.get('presets.list') || []).filter(function(p) { return p && p.title && (p.category || '') === cat; });
    var nm = _catName(cat);
    if (!ps.length) { listEl.innerHTML = '<div class="cv-pick-group">' + _esc(nm) + '</div><div class="cv-pick-empty">这个部位下还没有预设</div>'; return; }
    listEl.innerHTML = '<div class="cv-pick-group">' + _esc(nm) + ' (' + ps.length + ')</div>' +
      ps.map(function(p, i) { return '<div class="cv-pick-item" data-bp="' + i + '"><span class="cv-pick-lbl">' + _esc(p.title) + '</span></div>'; }).join('');
    listEl.querySelectorAll('[data-bp]').forEach(function(el) {
      el.addEventListener('click', function() {
        var p = ps[+el.getAttribute('data-bp')], txt = _presetText(p);
        if (!txt) { TileAPI.toast('该预设没有正文', 'warn'); return; }
        node.text = txt;
        var ta = _bottomBar && _bottomBar.querySelector('#cvBbPrompt'); if (ta) ta.value = txt;
        var nd = _world.querySelector('.cv-node[data-node="' + node.id + '"] [data-nodeedit]'); if (nd) nd.value = txt;
        _scheduleSave(); close(); _renderNodes();
      });
    });
  });
}

// ── 居中弹窗列表选择器(支持分组; 永远在屏幕中央, 不会出画) ──
//   opts: { title, groups:[{label, items:[{label, value, sub}]}], onPick(value) }
function _openListPicker(opts) {
  if (!_root) return;
  var ov = document.createElement('div');
  ov.className = 'cv-picker';
  var groupsHtml = (opts.groups || []).map(function(g) {
    var items = (g.items || []).map(function(it) {
      return '<div class="cv-pick-item" data-v="' + _esc(it.value) + '"><span class="cv-pick-lbl">' + _esc(it.label) + '</span>' +
        (it.sub ? '<span class="cv-pick-sub">' + _esc(it.sub) + '</span>' : '') + '</div>';
    }).join('');
    return (g.label ? '<div class="cv-pick-group">' + _esc(g.label) + '</div>' : '') + items;
  }).join('');
  ov.innerHTML =
    '<div class="cv-pick-panel">' +
      '<div class="cv-pick-title"><span>' + _esc(opts.title || '选择') + '</span><span class="cv-pick-close">✕</span></div>' +
      '<div class="cv-pick-list">' + (groupsHtml || '<div class="cv-pick-empty">没有可选项</div>') + '</div>' +
    '</div>';
  function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
  ov.addEventListener('click', function(e) {
    if (e.target === ov || (e.target.closest && e.target.closest('.cv-pick-close'))) { close(); return; }
    var it = e.target.closest && e.target.closest('.cv-pick-item');
    if (it) { var v = it.getAttribute('data-v'); close(); if (opts.onPick) opts.onPick(v); }
  });
  _root.appendChild(ov);
}

// ── 裁切框选编辑器: 在输入图上拖一个框 ──
function _openCropEditor(n) {
  var srcs = _inputSources(n.id, 'in');
  var src = srcs.length ? _project.nodes[srcs[0]] : null;
  if (!src || !src.imgB64) { TileAPI.toast('裁切节点要先连一个"有图"的节点(上游若是生成/变换, 先运行一次)', 'warn'); return; }
  if (!_root) return;
  var ov = document.createElement('div');
  ov.className = 'cv-crop-editor';
  ov.innerHTML =
    '<div class="cv-crop-stage">' +
      '<img class="cv-crop-img" src="' + _dataURI(src.imgB64, src.mime) + '">' +
      '<div class="cv-crop-sel" style="display:none"></div>' +
      '<div class="cv-crop-hint">在图上拖一个框选择裁切区</div>' +
    '</div>' +
    '<div class="cv-crop-bar">' +
      '<button class="cv-tbtn" id="cvCropCancel">取消</button>' +
      '<button class="cv-gen-btn" style="width:auto;padding:6px 18px" id="cvCropOk">确认裁切</button>' +
    '</div>';
  _root.appendChild(ov);
  var img = ov.querySelector('.cv-crop-img');
  var sel = ov.querySelector('.cv-crop-sel');
  var stage = ov.querySelector('.cv-crop-stage');
  var rect = null; // 像素, 相对 img 左上
  function imgBox() { return img.getBoundingClientRect(); }
  function drawSel() {
    if (!rect) { sel.style.display = 'none'; return; }
    var b = imgBox(), s = stage.getBoundingClientRect();
    sel.style.display = 'block';
    sel.style.left = (b.left - s.left + rect.x) + 'px';
    sel.style.top = (b.top - s.top + rect.y) + 'px';
    sel.style.width = rect.w + 'px';
    sel.style.height = rect.h + 'px';
  }
  function initRect() {
    if (n.rect && n.rect.w < 1) { var b = imgBox(); rect = { x: n.rect.x * b.width, y: n.rect.y * b.height, w: n.rect.w * b.width, h: n.rect.h * b.height }; drawSel(); }
  }
  if (img.complete) initRect(); else img.addEventListener('load', initRect);
  img.addEventListener('mousedown', function(e) {
    e.preventDefault();
    var b = imgBox(); var sx = e.clientX - b.left, sy = e.clientY - b.top;
    function mv(ev) {
      var cx = _clamp(ev.clientX - b.left, 0, b.width), cy = _clamp(ev.clientY - b.top, 0, b.height);
      rect = { x: Math.min(sx, cx), y: Math.min(sy, cy), w: Math.abs(cx - sx), h: Math.abs(cy - sy) };
      drawSel();
    }
    function up() { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });
  ov.querySelector('#cvCropCancel').addEventListener('click', function() { ov.remove(); });
  ov.querySelector('#cvCropOk').addEventListener('click', function() {
    var b = imgBox();
    if (rect && rect.w > 4 && rect.h > 4 && b.width && b.height) {
      n.rect = { x: rect.x / b.width, y: rect.y / b.height, w: rect.w / b.width, h: rect.h / b.height };
    }
    ov.remove(); _renderNodes(); _renderBottomBar(); _scheduleSave(); _runFrom(n.id);
  });
}

// ── 取某 provider 的模型表(视图→重建→完整目录三级兜底) ──
function _modelsOf(provider) {
  var m = TileAPI.state.get('models.' + provider);
  if ((!m || !Object.keys(m).length) && TileAPI.rebuildModelViews) { try { TileAPI.rebuildModelViews(); m = TileAPI.state.get('models.' + provider); } catch (_) {} }
  if ((!m || !Object.keys(m).length) && TileAPI.getFullCatalog) { try { m = TileAPI.getFullCatalog(provider); } catch (_) {} }
  return m || {};
}

// ============================================================
//  连线
// ============================================================
var _tempWire = null;
var _wireFrom = null;

function _tryConnect(a, b) {
  var out = a.side === 'right' ? a : (b.side === 'right' ? b : null);
  var inp = a.side === 'left' ? a : (b.side === 'left' ? b : null);
  if (!out || !inp) return false;
  if (out.node === inp.node) return false;
  if (out.dtype !== inp.dtype) { TileAPI.toast('类型不匹配(' + out.dtype + '→' + inp.dtype + ')', 'warn'); return false; }
  // 单接口(非 multi)只留一根
  var inpNode = _project.nodes[inp.node];
  var inpPortDef = (TYPE[inpNode.type].ins || []).filter(function(p) { return p.name === inp.port; })[0];
  if (inpPortDef && !inpPortDef.multi) {
    _project.wires = _project.wires.filter(function(w) { return !(w.to.node === inp.node && w.to.port === inp.port); });
  }
  var dup = _project.wires.some(function(w) {
    return w.from.node === out.node && w.from.port === out.port && w.to.node === inp.node && w.to.port === inp.port;
  });
  if (dup) return false;
  _project.wires.push({ id: _uid('w'), from: { node: out.node, port: out.port }, to: { node: inp.node, port: inp.port } });
  _renderWires(); _scheduleSave();
  return true;
}

// ============================================================
//  执行引擎 (按连线依赖跑; 记忆化 + 成环检测)
// ============================================================
function _inputSources(id, port) {
  return _project.wires.filter(function(w) { return w.to.node === id && w.to.port === port; }).map(function(w) { return w.from.node; });
}

// 执行一个节点, 返回它的输出值:
//   图片输出 → { b64, mime };  提示词输出 → 字符串
async function _execNode(id, cache, stack) {
  if (Object.prototype.hasOwnProperty.call(cache, id)) return cache[id];
  if (stack[id]) throw new Error('连线成环了');
  stack[id] = true;
  var n = _project.nodes[id];
  if (!n) { stack[id] = false; return null; }
  var out = null;
  var heavy = !!IMG_OP[n.type];   // 这些类型会真干活 → 显示"运行中"脉冲
  if (heavy) { n._running = true; _renderNodes(); }
  try {
    if (n.type === 'image') {
      if (!n.imgB64) throw new Error('有图片节点是空的');
      out = { b64: n.imgB64, mime: n.mime || 'image/png' };
    } else if (n.type === 'prompt') {
      out = n.text || '';
    } else if (n.type === 'promptcat') {
      out = await _execPromptCat(n, cache, stack);
    } else if (n.type === 'pscapture') {
      out = await _execCapture(n);
    } else if (n.type === 'psregion') {
      out = await _execRegion(n);
    } else if (n.type === 'generate') {
      out = await _execGenerate(n, cache, stack);
    } else if (n.type === 'tops') {
      out = await _execPassthrough(n, cache, stack, 'canvasPlaceToPS', '已输出到 PS');
    } else if (n.type === 'save') {
      out = await _execPassthrough(n, cache, stack, 'canvasSaveExport', '已保存');
    } else if (TRANSFORM[n.type]) {
      out = await _execImgOp(n, cache, stack);
    } else {
      throw new Error('未知节点类型: ' + n.type);
    }
  } finally {
    stack[id] = false;
    if (heavy) n._running = false;
  }
  cache[id] = out;
  return out;
}

async function _execGenerate(n, cache, stack) {
  // 收集输入图(按连线顺序) + 提示词
  var imgSrcs = _inputSources(n.id, 'img');
  var images = [];
  for (var i = 0; i < imgSrcs.length; i++) {
    var v = await _execNode(imgSrcs[i], cache, stack);
    if (v && v.b64) images.push(v.b64);
  }
  var promptSrcs = _inputSources(n.id, 'prompt');
  var prompt = '';
  if (promptSrcs.length) {
    var pv = await _execNode(promptSrcs[0], cache, stack);
    prompt = (typeof pv === 'string') ? pv : '';
  }
  if (!prompt || !prompt.trim()) throw new Error('生成节点缺提示词(连一个提示词节点)');

  var conn = (typeof window._settingsGetActiveConnection === 'function') ? window._settingsGetActiveConnection(n.provider) : null;
  if (!conn) throw new Error('读不到服务商连接');
  if (conn._grsKeyPending) throw new Error('算力 Key 正在准备, 稍候再运行');
  if (!conn.key) throw new Error((n.provider || '') + ' 没有 Key, 去顶栏/设置填一下');

  n.status = '生成中…'; _renderNodes();
  var timeout = +TileAPI.state.get('params.timeout') || 3600;
  // #7 发送前压缩(设置里开了才压)
  if (TileAPI.storage.get('canvas.compress') === true) {
    for (var ci = 0; ci < images.length; ci++) images[ci] = await _compressImage(images[ci], 'image/png');
  }
  // #10 张数: 多张并发生成(N 张同时发, 部分失败就用成功的那几张)
  var count = Math.max(1, Math.min(4, +n.count || 1));
  n.status = count > 1 ? ('并发生成 ' + count + ' 张…') : '生成中…';
  _renderNodes();
  function _oneGen() {
    return _hostReq('canvasGenerate', {
      apiKey: conn.key, apiBaseUrl: conn.url, provider: conn.provider,
      prompt: prompt, images: images,
      model: n.model, size: n.size, aspectRatio: n.aspect, timeout: timeout,
      _timeout: timeout * 1000 + 30000
    });
  }
  var reqs = [];
  for (var gi = 0; gi < count; gi++) reqs.push(_oneGen());
  var settled = await Promise.all(reqs);   // 并发等待全部回来(_hostReq 不会 reject)
  var results = [], firstErr = null;
  settled.forEach(function(res) {
    if (res && res.success && res.base64) results.push(res.base64);
    else if (!firstErr) firstErr = (res && res.error) || '生成失败';
  });
  if (!results.length) throw new Error(firstErr || '生成失败');
  if (firstErr && results.length < count) { try { TileAPI.toast('有 ' + (count - results.length) + ' 张失败, 用成功的 ' + results.length + ' 张', 'warn'); } catch (_) {} }
  // 多张 → 暂停, 弹缩略图让用户选一张当输出
  var pick = 0;
  if (results.length > 1) { n.status = '请选择…'; _renderNodes(); pick = await _pickResult(results); }
  // 保留所有结果(各存一个文件), 记 resultFiles 以便重开后还能切换
  n.results = results;
  n.resultFiles = results.map(function(b, k) { var fn = 'img_' + n.id + '_r' + k + '.png'; _hostReq('canvasSaveImage', { fileName: fn, base64: b }); return fn; });
  n.picked = pick;
  var chosen = results[pick] || results[0];
  n.imgB64 = chosen; n.mime = 'image/png';
  n.imgFile = n.resultFiles[pick];
  n.status = '✓ 完成' + (results.length > 1 ? (' (' + (pick + 1) + '/' + results.length + ')') : '');
  return { b64: chosen, mime: 'image/png' };
}

// 切换/设定生成节点当前展示的结果(内存没有就从文件读回)
function _setResultIndex(n, k) {
  if (!n) return;
  var total = (n.resultFiles && n.resultFiles.length) || (n.results && n.results.length) || 0;
  if (total < 1) return;
  k = ((k % total) + total) % total;
  n.picked = k;
  if (n.resultFiles && n.resultFiles[k]) n.imgFile = n.resultFiles[k];
  if (n.results && n.results[k]) { n.imgB64 = n.results[k]; _renderNodes(); _scheduleSave(); }
  else if (n.resultFiles && n.resultFiles[k]) {
    n.loading = true; _renderNodes();
    _hostReq('canvasLoadImage', { fileName: n.resultFiles[k] }).then(function(r) {
      if (r && r.success && r.base64) { n.imgB64 = r.base64; if (!n.results) n.results = []; n.results[k] = r.base64; }
      n.loading = false; _renderNodes(); _scheduleSave();
    });
  }
}
function _switchResult(id, dir) { var n = _project.nodes[id]; if (n) _setResultIndex(n, (n.picked || 0) + dir); }

// #10 多张结果选择器: 返回所选索引的 Promise(执行在此暂停, 直到用户点选)
function _pickResult(results) {
  return new Promise(function(resolve) {
    if (!_root) { resolve(0); return; }
    var ov = document.createElement('div'); ov.className = 'cv-picker';
    var thumbs = results.map(function(b, i) {
      return '<div class="cv-pick-thumb" data-i="' + i + '"><img src="' + _dataURI(b, 'image/png') + '"><div>第 ' + (i + 1) + ' 张</div></div>';
    }).join('');
    ov.innerHTML =
      '<div class="cv-pick-panel" style="width:auto;max-width:92%">' +
        '<div class="cv-pick-title"><span>选一张作为输出</span></div>' +
        '<div class="cv-pick-thumbs">' + thumbs + '</div>' +
      '</div>';
    ov.addEventListener('click', function(e) {
      var t = e.target.closest && e.target.closest('.cv-pick-thumb');
      if (t) { var i = +t.getAttribute('data-i'); if (ov.parentNode) ov.parentNode.removeChild(ov); resolve(i); }
    });
    _root.appendChild(ov);
  });
}

// ── 客户端图像变换(canvas) ──
function _loadImage(b64, mime) {
  return new Promise(function(resolve, reject) {
    var img = new Image();
    img.onload = function() { resolve(img); };
    img.onerror = function() { reject(new Error('图片解码失败')); };
    img.src = _dataURI(b64, mime);
  });
}
function _canvasB64(canvas) {
  var u = canvas.toDataURL('image/png'); var c = u.indexOf(','); return c >= 0 ? u.slice(c + 1) : '';
}
// 发送前压缩: 长边缩到 2048 + 转 JPEG(质量0.9), 省流量/加速。失败回退原图。
async function _compressImage(b64, mime) {
  try {
    var img = await _loadImage(b64, mime);
    var W = img.naturalWidth, H = img.naturalHeight, max = 2048;
    var scale = Math.min(1, max / Math.max(W, H));
    var nw = Math.max(1, Math.round(W * scale)), nh = Math.max(1, Math.round(H * scale));
    var cv = document.createElement('canvas'); cv.width = nw; cv.height = nh;
    var ctx = cv.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, nw, nh);
    var u = cv.toDataURL('image/jpeg', 0.9); var c = u.indexOf(','); return c >= 0 ? u.slice(c + 1) : b64;
  } catch (_) { return b64; }
}
async function _opCrop(n, inImg) {
  var img = await _loadImage(inImg.b64, inImg.mime);
  var r = n.rect || { x: 0, y: 0, w: 1, h: 1 };
  var W = img.naturalWidth, H = img.naturalHeight;
  var sx = _clamp(Math.round(r.x * W), 0, W - 1), sy = _clamp(Math.round(r.y * H), 0, H - 1);
  var sw = Math.max(1, Math.round(r.w * W)), sh = Math.max(1, Math.round(r.h * H));
  if (sx + sw > W) sw = W - sx;
  if (sy + sh > H) sh = H - sy;
  var cv = document.createElement('canvas'); cv.width = sw; cv.height = sh;
  cv.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return { b64: _canvasB64(cv), mime: 'image/png' };
}
async function _opPad(n, inImg) {
  var img = await _loadImage(inImg.b64, inImg.mime);
  var W = img.naturalWidth, H = img.naturalHeight;
  // 扩展画布到目标比例(只往需要的方向加边, 原图居中, 填充空白)
  var parts = String(n.padRatio || '1:1').split(':');
  var rw = +parts[0] || 1, rh = +parts[1] || 1;
  var targetAR = rw / rh, imgAR = W / H;
  var nw = W, nh = H;
  if (imgAR < targetAR) nw = Math.round(H * targetAR);  // 太高 → 加宽
  else nh = Math.round(W / targetAR);                   // 太宽 → 加高
  var cv = document.createElement('canvas'); cv.width = nw; cv.height = nh;
  var ctx = cv.getContext('2d');
  if (n.padColor === 'white') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, nw, nh); }
  else if (n.padColor === 'black') { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, nw, nh); }
  ctx.drawImage(img, Math.round((nw - W) / 2), Math.round((nh - H) / 2));
  return { b64: _canvasB64(cv), mime: 'image/png' };
}
async function _opResize(n, inImg) {
  var img = await _loadImage(inImg.b64, inImg.mime);
  var W = img.naturalWidth, H = img.naturalHeight;
  var target = n.longEdge || 1024;
  var scale = target / Math.max(W, H);
  var nw = Math.max(1, Math.round(W * scale)), nh = Math.max(1, Math.round(H * scale));
  var cv = document.createElement('canvas'); cv.width = nw; cv.height = nh;
  var ctx = cv.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, nw, nh);
  return { b64: _canvasB64(cv), mime: 'image/png' };
}
async function _opCombine(n, inImgs) {
  var imgs = [];
  for (var i = 0; i < inImgs.length; i++) imgs.push(await _loadImage(inImgs[i].b64, inImgs[i].mime));
  if (!imgs.length) throw new Error('拼接没有输入图');
  var layout = n.layout || 'h', gap = 8;
  var cv = document.createElement('canvas'), ctx;
  if (layout === 'h') {
    var Hh = Math.min(1024, Math.min.apply(null, imgs.map(function(im) { return im.naturalHeight; })));
    var ws = imgs.map(function(im) { return Math.round(im.naturalWidth * (Hh / im.naturalHeight)); });
    cv.width = ws.reduce(function(a, b) { return a + b; }, 0) + gap * (imgs.length - 1); cv.height = Hh;
    ctx = cv.getContext('2d'); var x = 0;
    imgs.forEach(function(im, idx) { ctx.drawImage(im, x, 0, ws[idx], Hh); x += ws[idx] + gap; });
  } else if (layout === 'v') {
    var Wv = Math.min(1024, Math.min.apply(null, imgs.map(function(im) { return im.naturalWidth; })));
    var hs = imgs.map(function(im) { return Math.round(im.naturalHeight * (Wv / im.naturalWidth)); });
    cv.width = Wv; cv.height = hs.reduce(function(a, b) { return a + b; }, 0) + gap * (imgs.length - 1);
    ctx = cv.getContext('2d'); var y = 0;
    imgs.forEach(function(im, idx) { ctx.drawImage(im, 0, y, Wv, hs[idx]); y += hs[idx] + gap; });
  } else {
    var cols = 2, cell = 512, rows = Math.ceil(imgs.length / cols);
    cv.width = cols * cell + gap * (cols - 1); cv.height = rows * cell + gap * (rows - 1);
    ctx = cv.getContext('2d');
    imgs.forEach(function(im, idx) {
      var cx = (idx % cols) * (cell + gap), cy = Math.floor(idx / cols) * (cell + gap);
      var s = Math.min(cell / im.naturalWidth, cell / im.naturalHeight);
      var dw = im.naturalWidth * s, dh = im.naturalHeight * s;
      ctx.drawImage(im, cx + (cell - dw) / 2, cy + (cell - dh) / 2, dw, dh);
    });
  }
  return { b64: _canvasB64(cv), mime: 'image/png' };
}

async function _execImgOp(n, cache, stack) {
  var srcs = _inputSources(n.id, 'in');
  var inputs = [];
  for (var i = 0; i < srcs.length; i++) { var v = await _execNode(srcs[i], cache, stack); if (v && v.b64) inputs.push(v); }
  if (!inputs.length) throw new Error((TYPE[n.type].title || '变换') + '节点没有输入图');
  n.status = '处理中…'; _renderNodes();
  var out;
  if (n.type === 'crop') out = await _opCrop(n, inputs[0]);
  else if (n.type === 'pad') out = await _opPad(n, inputs[0]);
  else if (n.type === 'resize') out = await _opResize(n, inputs[0]);
  else if (n.type === 'combine') out = await _opCombine(n, inputs);
  else throw new Error('未知变换: ' + n.type);
  n.imgB64 = out.b64; n.mime = out.mime;
  if (!n.imgFile) n.imgFile = 'img_' + n.id + '.png';
  _hostReq('canvasSaveImage', { fileName: n.imgFile, base64: out.b64 });
  n.status = '✓ 完成';
  return out;
}

// ── 提示词拼接 ──
async function _execPromptCat(n, cache, stack) {
  var srcs = _inputSources(n.id, 'in');
  var parts = [];
  for (var i = 0; i < srcs.length; i++) {
    var v = await _execNode(srcs[i], cache, stack);
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
  }
  return parts.join(n.sep == null ? ', ' : n.sep);
}

// ── PS 实时抓取(每次运行都重新抓当前选区) ──
async function _execCapture(n) {
  n.status = '抓取中…'; _renderNodes();
  var res = await _hostReq('canvasCaptureSelection', {});
  if (res && res.success && res.base64) {
    n.imgB64 = res.base64; n.mime = 'image/png';
    if (!n.imgFile) n.imgFile = 'img_' + n.id + '.png';
    _hostReq('canvasSaveImage', { fileName: n.imgFile, base64: res.base64 });
    n.status = '✓ 已抓取';
    return { b64: res.base64, mime: 'image/png' };
  }
  throw new Error((res && res.error) || '抓取失败');
}

// ── PS区域: 按记录的选区, 运行时重新抓当前画布 ──
async function _execRegion(n) {
  if (!n.regionSel) throw new Error('PS区域未记录: 在 PS 里框选, 选中本节点点「记录 PS 选区」');
  n.status = '抓取区域…'; _renderNodes();
  var res = await _hostReq('canvasRegionGrab', { selection: n.regionSel });
  if (res && res.success && res.base64) {
    n.imgB64 = res.base64; n.mime = 'image/png';
    if (!n.imgFile) n.imgFile = 'img_' + n.id + '.png';
    _hostReq('canvasSaveImage', { fileName: n.imgFile, base64: res.base64 });
    n.status = '✓ 已抓取';
    return { b64: res.base64, mime: 'image/png' };
  }
  throw new Error((res && res.error) || '区域抓取失败');
}

// ── 输出节点(输出到PS / 保存): 把输入图原样透传, 顺带做副作用 ──
async function _execPassthrough(n, cache, stack, action, okMsg) {
  var srcs = _inputSources(n.id, 'in');
  if (!srcs.length) throw new Error(TYPE[n.type].title + ' 没有输入图');
  var v = await _execNode(srcs[0], cache, stack);
  if (!v || !v.b64) throw new Error(TYPE[n.type].title + ' 输入为空');
  n.status = '处理中…'; _renderNodes();
  var res = await _hostReq(action, { base64: v.b64 });
  if (res && res.success) { n.imgB64 = v.b64; n.mime = v.mime; n.status = '✓ ' + okMsg; return v; }
  throw new Error((res && res.error) || (okMsg + '失败'));
}

async function _runFrom(id) {
  if (_running) { TileAPI.toast('正在运行, 请稍候', 'warn'); return; }
  _running = true;
  var cache = {}, stack = {};
  try {
    await _execNode(id, cache, stack);
    TileAPI.toast('运行完成', 'success');
  } catch (e) {
    var nn = _project.nodes[id]; if (nn && nn.type === 'generate') nn.status = '✗ ' + (e && e.message || e);
    TileAPI.toast('运行失败: ' + (e && e.message || e), 'error');
  }
  _running = false;
  _renderAll(); _scheduleSave();
}

async function _runAll() {
  if (_running) { TileAPI.toast('正在运行, 请稍候', 'warn'); return; }
  var ids = Object.keys(_project.nodes);
  if (!ids.length) return;
  _running = true;
  var cache = {}, stack = {};
  var okCount = 0, failCount = 0;
  for (var i = 0; i < ids.length; i++) {
    try { await _execNode(ids[i], cache, stack); okCount++; }
    catch (e) {
      failCount++;
      var nn = _project.nodes[ids[i]]; if (nn && nn.type === 'generate') nn.status = '✗ ' + (e && e.message || e);
    }
    _renderNodes();
  }
  _running = false;
  _renderAll(); _scheduleSave();
  TileAPI.toast('运行结束 (成功链 ' + okCount + ' / 失败 ' + failCount + ')', failCount ? 'warn' : 'success');
}

// ============================================================
//  导入
// ============================================================
function _importFromPS() {
  var n = _addNode('image', { loading: true });
  _hostReq('canvasCaptureSelection', {}).then(function(res) {
    if (res && res.success && res.base64) _setNodeImage(_project.nodes[n.id], res.base64);
    else { TileAPI.toast((res && res.error) || '抓取失败', 'error'); _deleteNode(n.id); }
  });
}
function _importFromFile() {
  var inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.addEventListener('change', function() {
    if (!inp.files || !inp.files.length) return;
    var reader = new FileReader();
    reader.onload = function() {
      var url = String(reader.result || ''); var c = url.indexOf(',');
      var b64 = c >= 0 ? url.slice(c + 1) : '';
      var mm = /^data:([^;]+);/.exec(url); var mime = mm ? mm[1] : 'image/png';
      if (b64) { var n = _addNode('image'); _setNodeImage(_project.nodes[n.id], b64, mime); }
    };
    reader.readAsDataURL(inp.files[0]);
  });
  inp.click();
}
function _importFromUrl() {
  function go(url) {
    if (!url) return;
    var n = _addNode('image', { loading: true });
    _hostReq('canvasDownloadUrl', { url: url, _timeout: 60000 }).then(function(res) {
      if (res && res.success && res.base64) _setNodeImage(_project.nodes[n.id], res.base64, res.mime);
      else { TileAPI.toast('下载失败: ' + ((res && res.error) || ''), 'error'); _deleteNode(n.id); }
    });
  }
  if (window.UIKit && UIKit.prompt) UIKit.prompt({ title: '从网址导入图片', placeholder: 'https://....jpg' }).then(function(v) { go(v && v.trim()); });
  else { var v = window.prompt('图片网址:'); go(v && v.trim()); }
}

// ── 拖拽导入 ──
function _dropFileToWorld(file, w) {
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function() {
    var u = String(reader.result || ''); var c = u.indexOf(',');
    var b64 = c >= 0 ? u.slice(c + 1) : '';
    var mm = /^data:([^;]+);/.exec(u); var mime = mm ? mm[1] : 'image/png';
    if (b64) { var n = _addNode('image', { x: Math.round(w.x - NODE_W / 2), y: Math.round(w.y - 30) }); _setNodeImage(_project.nodes[n.id], b64, mime); }
  };
  reader.readAsDataURL(file);
}
function _dropUrlToWorld(url, w) {
  var n = _addNode('image', { x: Math.round(w.x - NODE_W / 2), y: Math.round(w.y - 30), loading: true });
  _hostReq('canvasDownloadUrl', { url: url, _timeout: 60000 }).then(function(res) {
    if (res && res.success && res.base64) _setNodeImage(_project.nodes[n.id], res.base64, res.mime);
    else { TileAPI.toast('拖入下载失败: ' + ((res && res.error) || ''), 'error'); _deleteNode(n.id); }
  });
}
function _handleDrop(e) {
  if (!_viewport || !_world) return;
  e.preventDefault(); e.stopPropagation();
  if (_root) _root.classList.remove('cv-dragover');
  var w = _screenToWorld(e.clientX, e.clientY);
  var dt = e.dataTransfer; if (!dt) return;
  if (dt.files && dt.files.length) { _dropFileToWorld(dt.files[0], w); return; }
  if (dt.items && dt.items.length) {
    for (var i = 0; i < dt.items.length; i++) {
      if (dt.items[i].kind === 'file') { var f = dt.items[i].getAsFile && dt.items[i].getAsFile(); if (f) { _dropFileToWorld(f, w); return; } }
    }
  }
  var html = '';
  try { html = (dt.getData && dt.getData('text/html')) || ''; } catch (_) {}
  if (html) { var m = /<img[^>]+src=["']([^"']+)["']/i.exec(html); if (m && /^https?:\/\//i.test(m[1])) { _dropUrlToWorld(m[1], w); return; } }
  var uri = '';
  try { uri = (dt.getData && (dt.getData('text/uri-list') || dt.getData('text/plain'))) || ''; } catch (_) {}
  uri = (uri || '').trim();
  if (uri && /^https?:\/\//i.test(uri)) _dropUrlToWorld(uri, w);
  else if (uri) TileAPI.toast('拖入的不是图片(像是网页地址): ' + uri.slice(0, 60), 'warn');
}
function _bindDropImport() {
  function over(e) { e.preventDefault(); e.stopPropagation(); try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } catch (_) {} if (_root) _root.classList.add('cv-dragover'); }
  function leave(e) { if (_root && e.target === _viewport) _root.classList.remove('cv-dragover'); }
  _viewport.addEventListener('dragenter', over);
  _viewport.addEventListener('dragover', over);
  _viewport.addEventListener('dragleave', leave);
  _viewport.addEventListener('drop', _handleDrop);
  _onDoc('dragover', function(e) { e.preventDefault(); });
  _onDoc('drop', _handleDrop);
}

// ============================================================
//  底栏
// ============================================================
function _renderBottomBar() {
  if (!_bottomBar) return;
  var n = _selectedId ? _project.nodes[_selectedId] : null;
  if (!n) { _bottomBar.innerHTML = '<span class="cv-bb-empty">点选一个节点 → 这里显示它的详情。空白处拖动平移, 滚轮缩放。</span>'; return; }

  if (n.type === 'prompt') { _bbPrompt(n); return; }
  if (n.type === 'image') { _bbImage(n); return; }
  if (n.type === 'generate') { _bbGenerate(n); return; }
  if (n.type === 'crop') { _bbCrop(n); return; }
  if (n.type === 'pad') { _bbPad(n); return; }
  if (n.type === 'resize') { _bbResize(n); return; }
  if (n.type === 'combine') { _bbCombine(n); return; }
  if (n.type === 'promptcat') { _bbPromptCat(n); return; }
  if (n.type === 'psregion') { _bbRegion(n); return; }
  if (n.type === 'pscapture' || n.type === 'tops' || n.type === 'save') { _bbSimpleRun(n); return; }
}

function _bbRegion(n) {
  var info = n.regionSel ? ('已记录选区 ' + Math.round(n.regionSel.width || 0) + '×' + Math.round(n.regionSel.height || 0)) : '未记录(先在 PS 里框个选区)';
  _bottomBar.innerHTML =
    '<span class="cv-bb-label">🔲 PS区域</span>' +
    '<div class="cv-bb-row">' +
      '<span class="cv-bb-label" style="color:#888">' + info + '</span>' +
      '<button class="cv-tbtn" id="cvRegRec">记录 PS 选区</button>' +
      '<button class="cv-tbtn" id="cvRegLayer">建空白图层</button>' +
      '<button class="cv-gen-btn" style="width:auto;padding:6px 16px" id="cvRegRun">▶ 运行到此</button>' +
    '</div>';
  var rec = _bottomBar.querySelector('#cvRegRec');
  if (rec) rec.addEventListener('click', function() {
    _hostReq('canvasRegionRecord', {}).then(function(res) {
      if (res && res.success && res.selection) {
        n.regionSel = res.selection;
        if (res.base64) _setNodeImage(n, res.base64);
        _renderBottomBar(); _scheduleSave();
        TileAPI.toast('已记录选区', 'success');
      } else TileAPI.toast((res && res.error) || '没读到选区', 'error');
    });
  });
  var lay = _bottomBar.querySelector('#cvRegLayer');
  if (lay) lay.addEventListener('click', function() {
    _hostReq('canvasRegionMakeLayer', { name: n.name || 'PS区域' }).then(function(res) {
      TileAPI.toast(res && res.success ? '已建空白图层, 现在去 PS 里框选再点[记录]' : ('建图层失败: ' + ((res && res.error) || '')), res && res.success ? 'success' : 'error');
    });
  });
  var run = _bottomBar.querySelector('#cvRegRun');
  if (run) run.addEventListener('click', function() { _runFrom(n.id); });
}

function _bbPromptCat(n) {
  _bottomBar.innerHTML =
    '<span class="cv-bb-label">＋ 提示词拼接</span>' +
    '<div class="cv-bb-row">' +
      '<span class="cv-bb-label">分隔符</span>' +
      '<input type="text" class="cv-bb-text" id="cvCatSep" value="' + _esc(n.sep == null ? ', ' : n.sep) + '" style="width:120px">' +
      '<span class="cv-bb-label" style="color:#888">把多个提示词节点连到左边输入口, 运行时按此拼接</span>' +
    '</div>';
  var s = _bottomBar.querySelector('#cvCatSep');
  if (s) s.addEventListener('input', function() { n.sep = s.value; _renderNodes(); _scheduleSave(); });
}

function _bbSimpleRun(n) {
  var note = n.type === 'pscapture' ? '运行时抓取 PS 当前选区(可反复抓)'
           : n.type === 'tops' ? '把输入图贴成 PS 图层'
           : '把输入图保存到 dataFolder/canvas_exports 文件夹';
  _bottomBar.innerHTML =
    '<span class="cv-bb-label">' + TYPE[n.type].icon + ' ' + _esc(TYPE[n.type].title) + '</span>' +
    '<div class="cv-bb-row">' +
      '<span class="cv-bb-label" style="color:#888">' + note + '</span>' +
      '<button class="cv-gen-btn" style="width:auto;padding:6px 16px" id="cvSimpleRun">▶ 运行到此</button>' +
    '</div>';
  var r = _bottomBar.querySelector('#cvSimpleRun');
  if (r) r.addEventListener('click', function() { _runFrom(n.id); });
}

function _bbCrop(n) {
  _bottomBar.innerHTML =
    '<span class="cv-bb-label">✂️ 裁切</span>' +
    '<div class="cv-bb-row">' +
      '<span class="cv-bb-label">当前: ' + (n.rect ? (Math.round(n.rect.w * 100) + '×' + Math.round(n.rect.h * 100) + '%') : '整图') + '</span>' +
      '<button class="cv-tbtn" id="cvCropEdit">🔲 框选裁切区</button>' +
      '<button class="cv-tbtn" id="cvCropReset">重置</button>' +
      '<button class="cv-gen-btn" style="width:auto;padding:6px 16px" id="cvCropRun">▶ 运行到此</button>' +
    '</div>';
  var ed = _bottomBar.querySelector('#cvCropEdit'); if (ed) ed.addEventListener('click', function() { _openCropEditor(n); });
  var rs = _bottomBar.querySelector('#cvCropReset'); if (rs) rs.addEventListener('click', function() { n.rect = { x: 0, y: 0, w: 1, h: 1 }; _renderNodes(); _renderBottomBar(); _scheduleSave(); });
  var rn = _bottomBar.querySelector('#cvCropRun'); if (rn) rn.addEventListener('click', function() { _runFrom(n.id); });
}

function _bbPad(n) {
  var ratios = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'];
  var colors = [['transparent', '透明'], ['white', '白'], ['black', '黑']];
  _bottomBar.innerHTML =
    '<span class="cv-bb-label">⬜ 扩边到比例</span>' +
    '<div class="cv-bb-row">' +
      '<span class="cv-bb-label">目标比例</span><span class="cv-bb-seg" id="cvPadR">' +
        ratios.map(function(r) { return '<button data-r="' + r + '" class="' + ((n.padRatio || '1:1') === r ? 'is-on' : '') + '">' + r + '</button>'; }).join('') +
      '</span>' +
      '<span class="cv-bb-label">填充</span><span class="cv-bb-seg" id="cvPadC">' +
        colors.map(function(c) { return '<button data-c="' + c[0] + '" class="' + ((n.padColor || 'transparent') === c[0] ? 'is-on' : '') + '">' + c[1] + '</button>'; }).join('') +
      '</span>' +
      '<button class="cv-gen-btn" style="width:auto;padding:6px 16px" id="cvPadRun">▶ 运行到此</button>' +
    '</div>';
  _bottomBar.querySelectorAll('#cvPadR button').forEach(function(b) { b.addEventListener('click', function() { n.padRatio = b.getAttribute('data-r'); _renderNodes(); _renderBottomBar(); _scheduleSave(); }); });
  _bottomBar.querySelectorAll('#cvPadC button').forEach(function(b) { b.addEventListener('click', function() { n.padColor = b.getAttribute('data-c'); _renderNodes(); _renderBottomBar(); _scheduleSave(); }); });
  var rn = _bottomBar.querySelector('#cvPadRun'); if (rn) rn.addEventListener('click', function() { _runFrom(n.id); });
}

function _bbResize(n) {
  var opts = [512, 1024, 1536, 2048];
  _bottomBar.innerHTML =
    '<span class="cv-bb-label">⤢ 缩放</span>' +
    '<div class="cv-bb-row">' +
      '<span class="cv-bb-label">长边像素</span><span class="cv-bb-seg" id="cvRsz">' +
        opts.map(function(o) { return '<button data-o="' + o + '" class="' + ((n.longEdge || 1024) === o ? 'is-on' : '') + '">' + o + '</button>'; }).join('') +
      '</span>' +
      '<button class="cv-gen-btn" style="width:auto;padding:6px 16px" id="cvRszRun">▶ 运行到此</button>' +
    '</div>';
  _bottomBar.querySelectorAll('#cvRsz button').forEach(function(b) { b.addEventListener('click', function() { n.longEdge = +b.getAttribute('data-o'); _renderNodes(); _renderBottomBar(); _scheduleSave(); }); });
  var rn = _bottomBar.querySelector('#cvRszRun'); if (rn) rn.addEventListener('click', function() { _runFrom(n.id); });
}

function _bbCombine(n) {
  var lays = [['h', '横排'], ['v', '纵排'], ['grid', '网格']];
  _bottomBar.innerHTML =
    '<span class="cv-bb-label">▦ 拼接</span>' +
    '<div class="cv-bb-row">' +
      '<span class="cv-bb-label">排列</span><span class="cv-bb-seg" id="cvCmb">' +
        lays.map(function(o) { return '<button data-l="' + o[0] + '" class="' + ((n.layout || 'h') === o[0] ? 'is-on' : '') + '">' + o[1] + '</button>'; }).join('') +
      '</span>' +
      '<span class="cv-bb-label" style="color:#888">多张图连到输入口, 会按上面方式拼成一张</span>' +
      '<button class="cv-gen-btn" style="width:auto;padding:6px 16px" id="cvCmbRun">▶ 运行到此</button>' +
    '</div>';
  _bottomBar.querySelectorAll('#cvCmb button').forEach(function(b) { b.addEventListener('click', function() { n.layout = b.getAttribute('data-l'); _renderNodes(); _renderBottomBar(); _scheduleSave(); }); });
  var rn = _bottomBar.querySelector('#cvCmbRun'); if (rn) rn.addEventListener('click', function() { _runFrom(n.id); });
}

function _presetText(p) {
  if (!p) return '';
  if (p._isForge) return (p._forgeData && p._forgeData.positivePrompt) || '';
  return p.content || '';
}
// 分类 id → 中文名(用人体剪影那套分类名), 取不到就用原值
function _catName(id) {
  var cats = window._bodyCategories || [];
  for (var i = 0; i < cats.length; i++) if (cats[i].id === id) return cats[i].name;
  return id || '未分类';
}
// 解析提示词里的填空字段 【填空:名=值】(同名只取第一个)
function _promptFields(text) {
  var fields = [], seen = {}, r = /【填空:([^=】]+?)(?:=([^】]*))?】/g, m;
  while ((m = r.exec(text || '')) !== null) {
    var nm = m[1]; if (!(nm in seen)) { seen[nm] = 1; fields.push({ name: nm, value: m[2] != null ? m[2] : '' }); }
  }
  return fields;
}
// 把某个填空名的值改掉(所有同名一起换)
function _setPromptField(text, name, val) {
  var safe = String(val).replace(/[【】]/g, '');
  var esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text).replace(new RegExp('【填空:' + esc + '(?:=[^】]*)?】', 'g'), function() { return '【填空:' + name + '=' + safe + '】'; });
}
// 解析提示词里的 @param 滑块参数(新格式 @param:名"：值; _label/_desc 是元数据)
function _promptParams(text) {
  var params = [], labelMap = {}, descMap = {}, seen = {}, r = /"?@param:([^"\s:]+?)"\s*:\s*("[^"]*"|[-\d.]+)/g, m;
  while ((m = r.exec(text || '')) !== null) {
    var nm = m[1], raw = m[2];
    if (nm.slice(-5) === '_desc') { descMap[nm.slice(0, -5)] = (raw.charAt(0) === '"') ? raw.slice(1, -1) : raw; continue; }
    if (nm.slice(-6) === '_label') { labelMap[nm.slice(0, -6)] = (raw.charAt(0) === '"') ? raw.slice(1, -1) : raw; continue; }
    if (/_(?:note|range)$/.test(nm)) continue;
    var v = parseFloat(raw); if (isNaN(v)) continue;
    if (seen[nm]) continue; seen[nm] = true;
    params.push({ name: nm, value: v });
  }
  params.forEach(function(p) {
    p.label = labelMap[p.name] || (/^[A-Za-z_][\w]*$/.test(p.name) ? p.name.replace(/_/g, ' ').replace(/\b[a-z]/g, function(c) { return c.toUpperCase(); }) : p.name);
    p.desc = descMap[p.name] || '';
  });
  return params;
}
function _setPromptParam(text, name, val) {
  var esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text).replace(new RegExp('("?@param:' + esc + '"\\s*:\\s*)[-\\d.]+', 'g'), '$1' + val);
}
function _bbPrompt(n) {
  _bottomBar.innerHTML =
    '<span class="cv-bb-label">📝 提示词</span>' +
    '<button class="cv-bb-pickbtn" id="cvBbPreset">📚 选预设…</button>' +
    '<button class="cv-bb-pickbtn" id="cvBbBody">🧍 人体剪影</button>' +
    '<textarea class="cv-bb-prompt" id="cvBbPrompt" placeholder="在这里写提示词…(填空/滑块在节点上调)">' + _esc(n.text) + '</textarea>';
  function syncNode(v) {
    var nd = _world.querySelector('.cv-node[data-node="' + n.id + '"] [data-nodeedit]');
    if (nd && nd.value !== v) nd.value = v;
  }
  var ta = _bottomBar.querySelector('#cvBbPrompt');
  if (ta) ta.addEventListener('input', function() { n.text = ta.value; syncNode(ta.value); _scheduleSave(); });
  var bodyBtn = _bottomBar.querySelector('#cvBbBody');
  if (bodyBtn) bodyBtn.addEventListener('click', function() { _openBodyPicker(n); });
  var ps = _bottomBar.querySelector('#cvBbPreset');
  if (ps) ps.addEventListener('click', function() {
    var presets = (TileAPI.state.get('presets.list') || []).filter(function(p) { return p && p.title; });
    if (!presets.length) { TileAPI.toast('还没有预设', 'info'); return; }
    var gmap = {}, gorder = [];
    presets.forEach(function(p, i) {
      var c = p.category || '未分类';
      if (!gmap[c]) { gmap[c] = []; gorder.push(c); }
      gmap[c].push({ label: p.title, value: String(i) });
    });
    var groups = gorder.map(function(c) { return { label: _catName(c), items: gmap[c] }; });
    _openListPicker({ title: '选预设填入', groups: groups, onPick: function(v) {
      var i = parseInt(v, 10); var p = presets[i]; var txt = _presetText(p);
      if (!txt) { TileAPI.toast('该预设没有提示词正文', 'warn'); return; }
      n.text = txt; if (ta) ta.value = txt; _scheduleSave();
      _renderNodes();   // 节点上重渲出填空/滑块
    } });
  });
}

function _bbImage(n) {
  _bottomBar.innerHTML =
    '<span class="cv-bb-label">🖼️ 图片</span>' +
    '<div class="cv-bb-row">' +
      '<button class="cv-tbtn" id="cvBbRecap">↻ 重新抓 PS 选区</button>' +
      '<button class="cv-tbtn" id="cvBbToPS"' + (n.imgB64 ? '' : ' disabled') + '>↗ 贴回 PS</button>' +
    '</div>';
  var rc = _bottomBar.querySelector('#cvBbRecap');
  if (rc) rc.addEventListener('click', function() {
    n.loading = true; _renderNodes();
    _hostReq('canvasCaptureSelection', {}).then(function(res) {
      if (res && res.success && res.base64) _setNodeImage(n, res.base64);
      else { n.loading = false; _renderNodes(); TileAPI.toast((res && res.error) || '抓取失败', 'error'); }
    });
  });
  var tp = _bottomBar.querySelector('#cvBbToPS');
  if (tp) tp.addEventListener('click', function() {
    if (!n.imgB64) return;
    _hostReq('canvasPlaceToPS', { base64: n.imgB64 }).then(function(res) {
      TileAPI.toast(res && res.success ? '已贴回 PS' : ('贴回失败: ' + ((res && res.error) || '')), res && res.success ? 'success' : 'error');
    });
  });
}

function _bbGenerate(n) {
  // 该生成节点的输入图连线(按发送顺序). idx 是在这组里的序号
  function _imgWires() { return _project.wires.filter(function(w) { return w.to.node === n.id && w.to.port === 'img'; }); }
  function _reorderImg(idx, dir) {
    var poss = []; _project.wires.forEach(function(w, i) { if (w.to.node === n.id && w.to.port === 'img') poss.push(i); });
    var j = idx + dir; if (j < 0 || j >= poss.length) return;
    var a = poss[idx], b = poss[j], t = _project.wires[a]; _project.wires[a] = _project.wires[b]; _project.wires[b] = t;
    _scheduleSave();
  }
  if (['aji', 'grs', 'momo', 'others'].indexOf(n.provider) === -1) n.provider = 'aji';
  var slots = (typeof TileAPI.slotOrder === 'function') ? TileAPI.slotOrder() : ['aji'];
  function provLabel(eng) {
    var name = (typeof TileAPI.slotLabel === 'function') ? TileAPI.slotLabel(eng, null) : null;
    if (name) return name;
    if (eng === 'aji') return 'AJI';
    if (eng === 'grs') return (TileAPI.computeBrand ? TileAPI.computeBrand() : 'GRS');
    if (eng === 'momo') return '墨墨';
    return 'Others';
  }
  var provBtns = slots.map(function(eng) {
    return '<button data-prov="' + eng + '" class="' + (eng === n.provider ? 'is-on' : '') + '">' + _esc(provLabel(eng)) + '</button>';
  }).join('');

  var models = _modelsOf(n.provider);
  var mkeys = Object.keys(models);
  if ((!n.model || !models[n.model]) && mkeys.length) n.model = mkeys[0];
  var modelOpts = mkeys.map(function(k) {
    var m = models[k] || {};
    return '<option value="' + _esc(k) + '"' + (k === n.model ? ' selected' : '') + '>' + _esc(m.name || k) + '</option>';
  }).join('') || '<option value="">(该服务商暂无可用模型)</option>';

  var sizeBtns = ['1K', '2K', '4K'].map(function(s) {
    return '<button data-size="' + s + '" class="' + (s === n.size ? 'is-on' : '') + '">' + s + '</button>';
  }).join('');
  var aspectOpts = ASPECTS.map(function(a) {
    return '<option value="' + a + '"' + (a === n.aspect ? ' selected' : '') + '>' + a + '</option>';
  }).join('');

  var modelLabel = (models[n.model] && models[n.model].name) || n.model || '(选模型)';
  var aspectSeg = ASPECTS.map(function(a) {
    return '<button data-asp="' + a + '" class="' + (a === n.aspect ? 'is-on' : '') + '">' + a + '</button>';
  }).join('');
  var countSeg = [1, 2, 3, 4].map(function(c) {
    return '<button data-cnt="' + c + '" class="' + ((+n.count || 1) === c ? 'is-on' : '') + '">' + c + '</button>';
  }).join('');

  _bottomBar.innerHTML =
    '<span class="cv-bb-label">⚡ 生成</span>' +
    '<div class="cv-bb-row">' +
      '<span class="cv-bb-label">服务商</span><span class="cv-bb-seg" id="cvBbProv">' + provBtns + '</span>' +
      '<span class="cv-bb-label">模型</span><button class="cv-bb-pickbtn" id="cvBbModel">' + _esc(modelLabel) + ' ▾</button>' +
      '<span class="cv-bb-label">尺寸</span><span class="cv-bb-seg" id="cvBbSize">' + sizeBtns + '</span>' +
      '<span class="cv-bb-label">比例</span><span class="cv-bb-seg" id="cvBbAspect">' + aspectSeg + '</span>' +
      '<span class="cv-bb-label">张数</span><span class="cv-bb-seg" id="cvBbCount">' + countSeg + '</span>' +
      ((n.resultFiles && n.resultFiles.length > 1) || (n.results && n.results.length > 1) ? '<button class="cv-tbtn" id="cvBbRepick">重选结果</button>' : '') +
      '<button class="cv-gen-btn" style="width:auto;padding:6px 16px" id="cvBbRun">▶ 运行到此</button>' +
    '</div>' +
    (function() {
      var iw = _imgWires();
      if (!iw.length) return '';
      return '<div class="cv-bb-row" style="width:100%;flex-wrap:wrap">' +
        '<span class="cv-bb-label">输入图顺序</span>' +
        iw.map(function(w, i) {
          var src = _project.nodes[w.from.node];
          var nm = (src && (src.name || (TYPE[src.type] && TYPE[src.type].title))) || '?';
          var thumb = (src && src.imgB64)
            ? '<img class="cv-imgord-thumb" data-ordthumb="' + w.from.node + '" title="点看大图" src="' + _dataURI(src.imgB64, src.mime) + '">'
            : '<span class="cv-imgord-noimg">无图</span>';
          return '<span class="cv-imgord">' + thumb + '<b>图' + (i + 1) + '</b> ' + _esc(nm) +
                 ' <span class="cv-ord-btn" data-ordup="' + i + '">▲</span><span class="cv-ord-btn" data-orddn="' + i + '">▼</span></span>';
        }).join('') +
      '</div>';
    })();

  _bottomBar.querySelectorAll('#cvBbProv button').forEach(function(b) {
    b.addEventListener('click', function() {
      n.provider = b.getAttribute('data-prov');
      var ms = _modelsOf(n.provider); var keys = Object.keys(ms);
      if (!n.model || keys.indexOf(n.model) === -1) n.model = keys.length ? keys[0] : '';
      _renderNodes(); _renderBottomBar(); _scheduleSave();
    });
  });
  var mbtn = _bottomBar.querySelector('#cvBbModel');
  if (mbtn) mbtn.addEventListener('click', function() {
    var ms = _modelsOf(n.provider);
    var items = Object.keys(ms).map(function(k) { return { label: (ms[k] && ms[k].name) || k, value: k }; });
    _openListPicker({ title: '选择模型', groups: [{ label: '', items: items }], onPick: function(v) { n.model = v; _renderNodes(); _renderBottomBar(); _scheduleSave(); } });
  });
  _bottomBar.querySelectorAll('#cvBbSize button').forEach(function(b) {
    b.addEventListener('click', function() { n.size = b.getAttribute('data-size'); _renderNodes(); _renderBottomBar(); _scheduleSave(); });
  });
  _bottomBar.querySelectorAll('#cvBbAspect button').forEach(function(b) {
    b.addEventListener('click', function() { n.aspect = b.getAttribute('data-asp'); _renderNodes(); _renderBottomBar(); _scheduleSave(); });
  });
  _bottomBar.querySelectorAll('#cvBbCount button').forEach(function(b) {
    b.addEventListener('click', function() { n.count = +b.getAttribute('data-cnt'); _renderNodes(); _renderBottomBar(); _scheduleSave(); });
  });
  var repick = _bottomBar.querySelector('#cvBbRepick');
  if (repick) repick.addEventListener('click', function() {
    var arr = n.results && n.results.filter(Boolean);
    if (!arr || arr.length < 2) { TileAPI.toast('结果还在载入, 稍候再试', 'info'); return; }
    _pickResult(n.results).then(function(i) { _setResultIndex(n, i); });
  });
  var run = _bottomBar.querySelector('#cvBbRun');
  if (run) run.addEventListener('click', function() { _runFrom(n.id); });
  _bottomBar.querySelectorAll('[data-ordup]').forEach(function(b) { b.addEventListener('click', function() { _reorderImg(+b.getAttribute('data-ordup'), -1); _renderBottomBar(); _renderWires(); }); });
  _bottomBar.querySelectorAll('[data-orddn]').forEach(function(b) { b.addEventListener('click', function() { _reorderImg(+b.getAttribute('data-orddn'), 1); _renderBottomBar(); _renderWires(); }); });
  _bottomBar.querySelectorAll('[data-ordthumb]').forEach(function(b) { b.addEventListener('click', function() { var s = _project.nodes[b.getAttribute('data-ordthumb')]; if (s && s.imgB64) _openPreview(s); }); });
}

// ============================================================
//  交互
// ============================================================
var _docHandlers = [];
function _onDoc(type, fn) { document.addEventListener(type, fn); _docHandlers.push([type, fn]); }
function _clearDocHandlers() { _docHandlers.forEach(function(h) { document.removeEventListener(h[0], h[1]); }); _docHandlers = []; }

function _bindInteractions() {
  _onDoc('keydown', function(e) {
    if (!_container) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'Delete' && _selIds.length) { e.preventDefault(); _deleteSelected(); }
  });

  _wiresSvg.addEventListener('click', function(e) {
    var g = e.target.closest && e.target.closest('.cv-wire-g');
    if (g) { e.stopPropagation(); _deleteWire(g.getAttribute('data-wire')); }
  });

  // 节点内编辑: 提示词正文 / 填空框 / 滑块(都在节点本体上)
  _world.addEventListener('input', function(e) {
    var t = e.target;
    var nodeEl = t.closest && t.closest('.cv-node');
    var id = nodeEl && nodeEl.getAttribute('data-node');
    var n = id && _project.nodes[id]; if (!n) return;
    // 正文 textarea
    if (t.hasAttribute('data-nodeedit')) {
      n.text = t.value;
      if (_selectedId === id) { var bb = _bottomBar && _bottomBar.querySelector('#cvBbPrompt'); if (bb && bb.value !== t.value) bb.value = t.value; }
      _scheduleSave(); return;
    }
    // 填空框
    if (t.hasAttribute('data-nfld')) {
      var fl = _promptFields(n.text), f = fl[+t.getAttribute('data-nfld')]; if (!f) return;
      n.text = _setPromptField(n.text, f.name, t.value);
      var ta = nodeEl.querySelector('[data-nodeedit]'); if (ta) ta.value = n.text;
      _scheduleSave(); return;
    }
    // 滑块
    if (t.hasAttribute('data-nprm')) {
      var pm = _promptParams(n.text), p = pm[+t.getAttribute('data-nprm')]; if (!p) return;
      n.text = _setPromptParam(n.text, p.name, t.value);
      var pv = nodeEl.querySelector('[data-npval="' + t.getAttribute('data-nprm') + '"]'); if (pv) pv.textContent = (+t.value).toFixed(2);
      var ta2 = nodeEl.querySelector('[data-nodeedit]'); if (ta2) ta2.value = n.text;
      _scheduleSave(); return;
    }
  });

  // 双击: 标题→重命名; 空白→加节点。挂在 viewport(world 是 0×0, 空白区落在 viewport 上)
  _viewport.addEventListener('dblclick', function(e) {
    if (e.target.closest('.cv-toolbar') || e.target.closest('.cv-bottombar') || e.target.closest('.cv-port')) return;
    var titleEl = e.target.closest && e.target.closest('.cv-node-title');
    if (titleEl) {
      var ne = titleEl.closest('.cv-node'); var id = ne && ne.getAttribute('data-node');
      var n = id && _project.nodes[id]; if (!n) return;
      var cur = n.name || (TYPE[n.type] && TYPE[n.type].title) || '';
      if (TileAPI.prompt) TileAPI.prompt('节点名称:', { defaultValue: cur }).then(function(v) { if (v != null) { n.name = (v || '').trim(); _renderNodes(); _scheduleSave(); } });
      else { var v = window.prompt('节点名称:', cur); if (v != null) { n.name = (v || '').trim(); _renderNodes(); _scheduleSave(); } }
      return;
    }
    // 双击空白 → 在此处加节点
    if (e.target.closest('.cv-node')) return;
    var w = _screenToWorld(e.clientX, e.clientY);
    _openAddNodeMenu(w, null);
  });

  // Ctrl+V 粘贴剪贴板里的图片 → 落到画布中心
  _onDoc('paste', function(e) {
    if (!_container) return;
    var cd = e.clipboardData || window.clipboardData;
    if (!cd || !cd.items) return;
    for (var i = 0; i < cd.items.length; i++) {
      var it = cd.items[i];
      if (it.type && it.type.indexOf('image/') === 0) {
        var f = it.getAsFile && it.getAsFile();
        if (f) { e.preventDefault(); _dropFileToWorld(f, _viewCenterWorld()); return; }
      }
    }
  });

  _viewport.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    var t = e.target;
    if (t.closest('.cv-node') || t.closest('.cv-toolbar') || t.closest('.cv-bottombar') || t.closest('.cv-port')) return;
    if (e.shiftKey) { _startBoxSelect(e); return; }   // Shift+拖空白 = 框选多个节点
    _select(null);
    var sx = e.clientX, sy = e.clientY, px = _view.panX, py = _view.panY;
    _viewport.classList.add('cv-panning');
    function mv(ev) { _view.panX = px + (ev.clientX - sx); _view.panY = py + (ev.clientY - sy); _applyView(); }
    function up() { _viewport.classList.remove('cv-panning'); document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); _scheduleSave(); }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });

  _viewport.addEventListener('wheel', function(e) {
    e.preventDefault();
    var r = _viewport.getBoundingClientRect();
    var mx = e.clientX - r.left, my = e.clientY - r.top;
    var wx = (mx - _view.panX) / _view.zoom, wy = (my - _view.panY) / _view.zoom;
    var factor = e.deltaY < 0 ? 1.1 : 0.9;
    _view.zoom = _clamp(_view.zoom * factor, 0.2, 3);
    _view.panX = mx - wx * _view.zoom; _view.panY = my - wy * _view.zoom;
    _applyView(); _scheduleSave();
  }, { passive: false });

  // 双击右下角手柄 → 恢复自适应大小
  _world.addEventListener('dblclick', function(e) {
    var rz = e.target.closest && e.target.closest('.cv-resize');
    if (!rz) return;
    e.stopPropagation();
    var n = _project.nodes[rz.getAttribute('data-resize')]; if (!n) return;
    delete n.w; delete n.h;
    _renderNodes(); _renderWires(); _scheduleSave();
  });

  _world.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    var rz = e.target.closest('.cv-resize');
    if (rz) { e.stopPropagation(); e.preventDefault(); _startResize(rz.getAttribute('data-resize'), e); return; }
    var port = e.target.closest('.cv-port');
    if (port) { e.stopPropagation(); _startWire(port, e); return; }
    var node = e.target.closest('.cv-node');
    if (!node) return;
    var id = node.getAttribute('data-node');
    if (e.shiftKey) _selToggle(id);
    else if (_selIds.indexOf(id) < 0) _select(id);   // 未选中的→单选; 已在多选里→保持(便于整组拖)
    var drag = e.target.closest('[data-drag]');
    // 点 ✕ 删除钮时不要启动拖拽(拖拽会移动节点 DOM, 把随后的 click 吞掉, 导致删不掉)
    if (drag && !e.target.closest('.cv-node-del')) { e.preventDefault(); _startNodeDrag(id, e); }
  });
  _world.addEventListener('click', function(e) {
    var img = e.target.closest('.cv-img-thumb');
    if (img) {
      var ne = img.closest('.cv-node'); var nid = ne && ne.getAttribute('data-node');
      var nn = nid && _project.nodes[nid];
      if (nn && nn.imgB64) { e.stopPropagation(); _openPreview(nn); return; }
    }
    var del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); _deleteNode(del.getAttribute('data-del')); return; }
    var prv = e.target.closest('[data-genprev]');
    if (prv) { e.stopPropagation(); _switchResult(prv.getAttribute('data-genprev'), -1); return; }
    var nxt = e.target.closest('[data-gennext]');
    if (nxt) { e.stopPropagation(); _switchResult(nxt.getAttribute('data-gennext'), 1); return; }
    var gen = e.target.closest('[data-gen]');
    if (gen) { e.stopPropagation(); _runFrom(gen.getAttribute('data-gen')); }
  });
}

// 右下角拖拽缩放节点(改 n.w / n.h)
function _startResize(id, e) {
  var n = _project.nodes[id]; if (!n) return;
  var sx = e.clientX, sy = e.clientY, ow = _nodeW(n), oh = _nodeH(n);
  var elNode = _world.querySelector('.cv-node[data-node="' + id + '"]');
  function mv(ev) {
    n.w = Math.max(120, Math.round(ow + (ev.clientX - sx) / _view.zoom));
    n.h = Math.max(70, Math.round(oh + (ev.clientY - sy) / _view.zoom));
    if (elNode) {
      elNode.style.width = n.w + 'px'; elNode.style.height = n.h + 'px';
      // 右侧输出口圆点跟着动(贴右边、随高度居中), 否则拖动时圆点会和连线分离
      var outDot = elNode.querySelector('.cv-port[data-side="right"]');
      if (outDot) { outDot.style.left = (n.w - 6.5) + 'px'; outDot.style.top = (n.h / 2 - 6.5) + 'px'; }
    }
    _renderWires();   // 连线跟着移
  }
  function up() {
    document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
    _renderNodes(); _scheduleSave();   // 重渲一次让端口位置精确
  }
  document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
}

function _startNodeDrag(id, e) {
  if (!_project.nodes[id]) return;
  // 拖的是多选里的节点 → 整组一起移动; 否则只移这个
  var ids = (_selIds.indexOf(id) >= 0 && _selIds.length > 1) ? _selIds.slice() : [id];
  var starts = ids.map(function(i) { var nn = _project.nodes[i]; return { id: i, ox: nn.x, oy: nn.y }; });
  var sx = e.clientX, sy = e.clientY;
  var elNode = _world.querySelector('.cv-node[data-node="' + id + '"]');
  var brought = false;
  function mv(ev) {
    if (!brought && elNode) { _world.appendChild(elNode); brought = true; }   // 真正拖动了才置顶, 避免吞掉双击
    var dx = (ev.clientX - sx) / _view.zoom, dy = (ev.clientY - sy) / _view.zoom;
    starts.forEach(function(s) {
      var nn = _project.nodes[s.id]; if (!nn) return;
      nn.x = s.ox + dx; nn.y = s.oy + dy;
      var el = _world.querySelector('.cv-node[data-node="' + s.id + '"]');
      if (el) { el.style.left = nn.x + 'px'; el.style.top = nn.y + 'px'; }
    });
    _renderWires();
  }
  function up() { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); _scheduleSave(); }
  document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
}

// Shift+空白拖动 = 框选多个节点
function _startBoxSelect(e) {
  var r = _viewport.getBoundingClientRect();
  var box = document.createElement('div'); box.className = 'cv-boxsel';
  _viewport.appendChild(box);
  var sx = e.clientX, sy = e.clientY;
  function mv(ev) {
    box.style.left = (Math.min(sx, ev.clientX) - r.left) + 'px';
    box.style.top = (Math.min(sy, ev.clientY) - r.top) + 'px';
    box.style.width = Math.abs(ev.clientX - sx) + 'px';
    box.style.height = Math.abs(ev.clientY - sy) + 'px';
  }
  function up(ev) {
    document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
    if (box.parentNode) box.parentNode.removeChild(box);
    var w1 = _screenToWorld(Math.min(sx, ev.clientX), Math.min(sy, ev.clientY));
    var w2 = _screenToWorld(Math.max(sx, ev.clientX), Math.max(sy, ev.clientY));
    var hits = [];
    Object.keys(_project.nodes).forEach(function(id) {
      var n = _project.nodes[id], nx2 = n.x + _nodeW(n), ny2 = n.y + _nodeH(n);
      if (n.x < w2.x && nx2 > w1.x && n.y < w2.y && ny2 > w1.y) hits.push(id);
    });
    if (hits.length) _selMany(hits); else _select(null);
  }
  document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
}

function _findSnapPort(wx, wy, from) {
  var R = 26 / _view.zoom;
  var best = null, bestD = R * R;
  var fromIsOut = from.side === 'right';
  Object.keys(_project.nodes).forEach(function(id) {
    if (id === from.node) return;
    var n = _project.nodes[id];
    _ports(n).forEach(function(p) {
      if (fromIsOut && p.side !== 'left') return;
      if (!fromIsOut && p.side !== 'right') return;
      if (p.dtype !== from.dtype) return;
      var pos = _portPos(n, p.name);
      var dx = pos.x - wx, dy = pos.y - wy, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = { node: id, port: p.name, side: p.side, dtype: p.dtype, x: pos.x, y: pos.y }; }
    });
  });
  return best;
}
function _portDom(node, port) { return _world && _world.querySelector('.cv-port[data-node="' + node + '"][data-port="' + port + '"]'); }

// 加节点菜单(双击空白 / 从端口拉到空白). fromPort 有值则只列可连接的类型并自动连。
function _typeFirstInput(type, dtype) {
  var ins = (TYPE[type] && TYPE[type].ins) || [];
  for (var i = 0; i < ins.length; i++) if (ins[i].dtype === dtype) return ins[i].name;
  return null;
}
function _openAddNodeMenu(w, fromPort) {
  var types = ['prompt', 'promptcat', 'generate', 'crop', 'pad', 'resize', 'combine', 'pscapture', 'tops', 'save'];
  if (fromPort) {
    types = types.filter(function(t) {
      return fromPort.side === 'right' ? !!_typeFirstInput(t, fromPort.dtype) : (TYPE[t].out === fromPort.dtype);
    });
  }
  if (!types.length) { TileAPI.toast('没有可连接的节点类型', 'info'); return; }
  var items = types.map(function(t) { return { label: TYPE[t].icon + ' ' + TYPE[t].title, value: t }; });
  _openListPicker({ title: fromPort ? '连接到新节点' : '添加节点', groups: [{ label: '', items: items }], onPick: function(type) {
    var n = _addNode(type, { x: Math.round(w.x), y: Math.round(w.y - 30) });
    if (fromPort) {
      if (fromPort.side === 'right') {
        var inName = _typeFirstInput(type, fromPort.dtype);
        if (inName) _tryConnect({ node: fromPort.node, port: fromPort.port, side: 'right', dtype: fromPort.dtype }, { node: n.id, port: inName, side: 'left', dtype: fromPort.dtype });
      } else {
        _tryConnect({ node: n.id, port: 'out', side: 'right', dtype: TYPE[type].out }, { node: fromPort.node, port: fromPort.port, side: 'left', dtype: fromPort.dtype });
      }
    }
  } });
}

// 工具条「＋ 添加节点」: 分组菜单(源/提示词/生成/变换/输出), 含图像导入源
function _openToolbarAddMenu() {
  var groups = [
    { label: '源', items: [
      { label: '🖼️ PS 选区', value: 'ps' },
      { label: '📷 PS 抓取', value: 'pscap' },
      { label: '🔲 PS 区域', value: 'region' },
      { label: '📁 文件', value: 'file' },
      { label: '🔗 网址', value: 'url' }
    ] },
    { label: '提示词', items: [
      { label: '📝 提示词', value: 'prompt' },
      { label: '＋ 拼词', value: 'promptcat' }
    ] },
    { label: '生成', items: [ { label: '⚡ 生成', value: 'gen' } ] },
    { label: '变换', items: [
      { label: '✂️ 裁切', value: 'crop' },
      { label: '⬜ 扩边', value: 'pad' },
      { label: '⤢ 缩放', value: 'resize' },
      { label: '▦ 拼接', value: 'combine' }
    ] },
    { label: '输出', items: [
      { label: '↗ 输出 PS', value: 'tops' },
      { label: '💾 保存', value: 'save' }
    ] }
  ];
  _openListPicker({ title: '添加节点', groups: groups, onPick: function(v) {
    switch (v) {
      case 'ps': _importFromPS(); break;
      case 'pscap': _addNode('pscapture'); break;
      case 'region': _addNode('psregion'); break;
      case 'file': _importFromFile(); break;
      case 'url': _importFromUrl(); break;
      case 'prompt': _addNode('prompt'); break;
      case 'promptcat': _addNode('promptcat'); break;
      case 'gen': _addNode('generate'); break;
      case 'crop': _addNode('crop'); break;
      case 'pad': _addNode('pad'); break;
      case 'resize': _addNode('resize'); break;
      case 'combine': _addNode('combine'); break;
      case 'tops': _addNode('tops'); break;
      case 'save': _addNode('save'); break;
    }
  } });
}

// 工具条「⋯ 更多」: 画布管理 + 图例帮助
function _openMoreMenu() {
  _openListPicker({ title: '更多', groups: [{ label: '', items: [
    { label: '📐 对齐所选', value: 'align' },
    { label: '🗑 清空画布', value: 'clear' },
    { label: '⚙ 设置', value: 'settings' },
    { label: '💾 导出工作流', value: 'export' },
    { label: '📂 导入工作流', value: 'import' },
    { label: '❔ 图例 / 帮助', value: 'legend' }
  ] }], onPick: function(v) {
    switch (v) {
      case 'align': _openAlign(); break;
      case 'clear': _clearCanvas(); break;
      case 'settings': _openSettings(); break;
      case 'export': _exportWorkflow(); break;
      case 'import': _importWorkflow(); break;
      case 'legend': _openLegend(); break;
    }
  } });
}

// 图例 / 帮助: 节点类别配色 + 端口颜色 + 操作手势
function _openLegend() {
  if (!_root) return;
  var ov = document.createElement('div');
  ov.className = 'cv-picker';
  var cats = [
    ['--cat-source', '源 — PS 选区 / 抓取 / 文件 / 网址'],
    ['--cat-prompt', '提示词 — 提示词 / 拼词'],
    ['--cat-transform', '变换 — 裁切 / 扩边 / 缩放 / 拼接'],
    ['--cat-generate', '生成 — 出图'],
    ['--cat-output', '输出 — 输出 PS / 保存']
  ];
  var catRows = cats.map(function(c) {
    return '<div class="cv-legend-row"><span class="cv-legend-bar" style="background:var(' + c[0] + ')"></span>' + c[1] + '</div>';
  }).join('');
  ov.innerHTML =
    '<div class="cv-pick-panel">' +
      '<div class="cv-pick-title"><span>图例 / 帮助</span><span class="cv-pick-close">✕</span></div>' +
      '<div class="cv-pick-list">' +
        '<div class="cv-legend-sec">节点类别(看标题栏颜色)</div>' + catRows +
        '<div class="cv-legend-sec">端口颜色</div>' +
        '<div class="cv-legend-row"><span class="cv-legend-dot" style="background:var(--cv-accent)"></span>蓝点 = 图像</div>' +
        '<div class="cv-legend-row"><span class="cv-legend-dot" style="background:var(--cat-prompt)"></span>紫点 = 提示词</div>' +
        '<div class="cv-legend-sec">操作手势</div>' +
        '<div class="cv-legend-tip" style="padding:4px 11px;line-height:1.9">' +
          '· 双击空白 → 添加节点<br>' +
          '· 从圆点拉线到另一个圆点 → 连接;拉到空白 → 新建并连接<br>' +
          '· 双击节点标题 → 改名<br>' +
          '· 拖右下角手柄缩放;双击手柄 → 还原自适应<br>' +
          '· Shift+拖空白 → 框选;滚轮 → 缩放;拖空白 → 平移' +
        '</div>' +
      '</div>' +
    '</div>';
  ov.addEventListener('click', function(e) {
    if (e.target === ov || (e.target.closest && e.target.closest('.cv-pick-close'))) { if (ov.parentNode) ov.parentNode.removeChild(ov); }
  });
  _root.appendChild(ov);
}

function _startWire(portEl, e) {
  _wireFrom = { node: portEl.getAttribute('data-node'), port: portEl.getAttribute('data-port'), side: portEl.getAttribute('data-side'), dtype: portEl.getAttribute('data-dtype') };
  var sp = _portPos(_project.nodes[_wireFrom.node], _wireFrom.port);
  var snapTarget = null;
  function clearSnap() { if (snapTarget) { var d = _portDom(snapTarget.node, snapTarget.port); if (d) d.classList.remove('cv-port-snap'); snapTarget = null; } }
  function mv(ev) {
    var w = _screenToWorld(ev.clientX, ev.clientY);
    var snap = _findSnapPort(w.x, w.y, _wireFrom);
    if (!snap || !snapTarget || snap.node !== snapTarget.node || snap.port !== snapTarget.port) clearSnap();
    if (snap) { snapTarget = snap; var d = _portDom(snap.node, snap.port); if (d) d.classList.add('cv-port-snap'); _tempWire = { x1: sp.x, y1: sp.y, x2: snap.x, y2: snap.y }; }
    else _tempWire = { x1: sp.x, y1: sp.y, x2: w.x, y2: w.y };
    _renderWires();
  }
  function up(ev) {
    document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
    _tempWire = null;
    var tgt = snapTarget;
    if (!tgt) { var el = ev.target.closest && ev.target.closest('.cv-port'); if (el) tgt = { node: el.getAttribute('data-node'), port: el.getAttribute('data-port'), side: el.getAttribute('data-side'), dtype: el.getAttribute('data-dtype') }; }
    clearSnap();
    if (tgt) _tryConnect(_wireFrom, tgt);
    else { var fp = _wireFrom; var ww = _screenToWorld(ev.clientX, ev.clientY); _openAddNodeMenu(ww, fp); }
    _wireFrom = null; _renderWires();
  }
  document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
}

// ============================================================
//  对齐(多选)
// ============================================================
function _alignSelected(mode) {
  var ns = _selIds.map(function(i) { return _project.nodes[i]; }).filter(Boolean);
  if (ns.length < 2) { TileAPI.toast('先 Shift 框选/点选 2 个以上节点', 'warn'); return; }
  var minX = Math.min.apply(null, ns.map(function(n) { return n.x; }));
  var maxR = Math.max.apply(null, ns.map(function(n) { return n.x + _nodeW(n); }));
  var minY = Math.min.apply(null, ns.map(function(n) { return n.y; }));
  var maxB = Math.max.apply(null, ns.map(function(n) { return n.y + _nodeH(n); }));
  if (mode === 'left') ns.forEach(function(n) { n.x = minX; });
  else if (mode === 'right') ns.forEach(function(n) { n.x = maxR - _nodeW(n); });
  else if (mode === 'top') ns.forEach(function(n) { n.y = minY; });
  else if (mode === 'bottom') ns.forEach(function(n) { n.y = maxB - _nodeH(n); });
  else if (mode === 'cx') { var cx = (minX + maxR) / 2; ns.forEach(function(n) { n.x = Math.round(cx - _nodeW(n) / 2); }); }
  else if (mode === 'cy') { var cy = (minY + maxB) / 2; ns.forEach(function(n) { n.y = Math.round(cy - _nodeH(n) / 2); }); }
  else if (mode === 'distX') { var sx = ns.slice().sort(function(a, b) { return a.x - b.x; }); var stepX = (sx[sx.length - 1].x - sx[0].x) / (sx.length - 1); sx.forEach(function(n, i) { n.x = Math.round(sx[0].x + stepX * i); }); }
  else if (mode === 'distY') { var sy = ns.slice().sort(function(a, b) { return a.y - b.y; }); var stepY = (sy[sy.length - 1].y - sy[0].y) / (sy.length - 1); sy.forEach(function(n, i) { n.y = Math.round(sy[0].y + stepY * i); }); }
  // 对齐后防重叠: 对齐了 X 就沿 Y 错开, 对齐了 Y 就沿 X 错开
  if (mode === 'left' || mode === 'right' || mode === 'cx') _spreadNoOverlap(ns, 'y');
  else if (mode === 'top' || mode === 'bottom' || mode === 'cy') _spreadNoOverlap(ns, 'x');
  _renderNodes(); _renderWires(); _scheduleSave();
}
function _spreadNoOverlap(ns, axis) {
  var gap = 14;
  if (axis === 'y') {
    var s = ns.slice().sort(function(a, b) { return a.y - b.y; });
    for (var i = 1; i < s.length; i++) { var pb = s[i - 1].y + _nodeH(s[i - 1]) + gap; if (s[i].y < pb) s[i].y = pb; }
  } else {
    var sx = ns.slice().sort(function(a, b) { return a.x - b.x; });
    for (var j = 1; j < sx.length; j++) { var pr = sx[j - 1].x + _nodeW(sx[j - 1]) + gap; if (sx[j].x < pr) sx[j].x = pr; }
  }
}
function _openAlign() {
  if (_selIds.length < 2) { TileAPI.toast('先 Shift 框选/点选 2 个以上节点再对齐', 'warn'); return; }
  _openListPicker({ title: '对齐选中的 ' + _selIds.length + ' 个节点', groups: [{ label: '', items: [
    { label: '左对齐', value: 'left' }, { label: '右对齐', value: 'right' },
    { label: '顶对齐', value: 'top' }, { label: '底对齐', value: 'bottom' },
    { label: '水平居中', value: 'cx' }, { label: '垂直居中', value: 'cy' },
    { label: '横向均匀分布', value: 'distX' }, { label: '纵向均匀分布', value: 'distY' }
  ] }], onPick: function(v) { _alignSelected(v); } });
}

function _fitView() {
  var ids = Object.keys(_project.nodes);
  if (!ids.length) { _view = { panX: 80, panY: 80, zoom: 1 }; _applyView(); return; }
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  ids.forEach(function(id) {
    var n = _project.nodes[id];
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + _nodeW(n)); maxY = Math.max(maxY, n.y + _nodeH(n));
  });
  var r = _viewport.getBoundingClientRect();
  var pad = 60;
  var zoom = _clamp(Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY)), 0.2, 1.5);
  _view.zoom = isFinite(zoom) && zoom > 0 ? zoom : 1;
  _view.panX = pad - minX * _view.zoom;
  _view.panY = pad - minY * _view.zoom;
  _applyView(); _scheduleSave();
}

// ============================================================
//  存档 / 读档
// ============================================================
function _serialize() {
  var nodes = {};
  Object.keys(_project.nodes).forEach(function(id) {
    var n = _project.nodes[id];
    nodes[id] = {
      id: n.id, type: n.type, x: Math.round(n.x), y: Math.round(n.y), w: n.w || 0, h: n.h || 0, name: n.name || '',
      text: n.text || '', imgFile: n.imgFile || '', mime: n.mime || 'image/png',
      provider: n.provider || '', model: n.model || '', size: n.size || '', aspect: n.aspect || '', count: n.count || 1, resultFiles: n.resultFiles || null, picked: n.picked || 0,
      rect: n.rect || null, padPercent: n.padPercent, padColor: n.padColor || '', padRatio: n.padRatio || '', longEdge: n.longEdge || 0, layout: n.layout || '', sep: n.sep, regionSel: n.regionSel || null
    };
  });
  return { nodes: nodes, wires: _project.wires, view: _view, _seq: _seq };
}
function _scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(function() { try { TileAPI.storage.set('canvas.project', _serialize()); } catch (_) {} }, 400);
}
function _loadFromStorage() {
  if (_loadedFromStorage) return;
  _loadedFromStorage = true;
  var saved = null;
  try { saved = TileAPI.storage.get('canvas.project'); } catch (_) {}
  if (!saved || !saved.nodes) return;
  _project.nodes = {};
  Object.keys(saved.nodes).forEach(function(id) {
    var s = saved.nodes[id];
    _project.nodes[id] = {
      id: s.id, type: s.type, x: s.x, y: s.y, w: s.w || 0, h: s.h || 0, name: s.name || '', text: s.text || '', imgFile: s.imgFile || '', mime: s.mime || 'image/png',
      provider: s.provider || '', model: s.model || '', size: s.size || '', aspect: s.aspect || '', count: s.count || 1, resultFiles: s.resultFiles || null, picked: s.picked || 0,
      rect: s.rect || null, padPercent: s.padPercent, padColor: s.padColor || '', padRatio: s.padRatio || '', longEdge: s.longEdge || 0, layout: s.layout || '', sep: s.sep, regionSel: s.regionSel || null,
      imgB64: null, status: ''
    };
  });
  _project.wires = Array.isArray(saved.wires) ? saved.wires : [];
  if (saved.view) _view = saved.view;
  if (saved._seq) _seq = saved._seq;
  // 懒加载图片(图片节点 + 已生成过的生成节点)
  Object.keys(_project.nodes).forEach(function(id) {
    var n = _project.nodes[id];
    if (n.imgFile) {
      n.loading = true;
      _hostReq('canvasLoadImage', { fileName: n.imgFile }).then(function(res) {
        var nn = _project.nodes[id]; if (!nn) return;
        if (res && res.success && res.base64) { nn.imgB64 = res.base64; }
        nn.loading = false; _renderNodes();
      });
    }
    // 多结果: 把每张结果也读回内存, 让重开后还能切换
    if (n.resultFiles && n.resultFiles.length) {
      n.results = [];
      n.resultFiles.forEach(function(fn, k) {
        _hostReq('canvasLoadImage', { fileName: fn }).then(function(r) {
          var nn = _project.nodes[id]; if (nn && r && r.success && r.base64) { if (!nn.results) nn.results = []; nn.results[k] = r.base64; }
        });
      });
    }
  });
}

// ============================================================
//  展开 / 收起
// ============================================================
function onExpand(container, sizeHint) {
  _container = container;
  var isFull = !!(sizeHint && (sizeHint.expandMode === 'full' || sizeHint.mode === 'full'));

  container.innerHTML =
    '<div class="cv-root">' +
      '<div class="cv-viewport"><div class="cv-world"><svg class="cv-wires"></svg></div>' +
        '<div class="cv-empty-hint">' +
          '<div class="cv-eh-big">创意画布</div>' +
          '<div class="cv-eh-sm">双击空白处 → 添加节点 · 拖图片 / PS 选区进来<br>' +
            '从节点上的小圆点拉出连线 → 松手即可连接，或新建并连接<br>' +
            'Shift+拖动 = 框选 · 滚轮 = 缩放 · 拖空白 = 平移 · 点「更多 → 图例」看说明</div>' +
        '</div>' +
      '</div>' +
      '<div class="cv-toolbar">' +
        '<button class="cv-tbtn cv-tbtn-primary" data-act="add">＋ 添加节点</button>' +
        '<span class="cv-tb-sep"></span>' +
        '<button class="cv-tbtn cv-tbtn-run" data-act="runall">▶ 运行全部</button>' +
        '<button class="cv-tbtn" data-act="fit">🎯 适应</button>' +
        '<button class="cv-tbtn" data-act="more">⋯ 更多</button>' +
        (isFull ? '' : '<span class="cv-tb-sep"></span><span class="cv-bb-label">建议点磁贴全屏使用</span>') +
      '</div>' +
      '<div class="cv-zoom-ind">100%</div>' +
      '<div class="cv-bottombar"></div>' +
    '</div>';

  _root = container.querySelector('.cv-root');
  _viewport = container.querySelector('.cv-viewport');
  _world = container.querySelector('.cv-world');
  _wiresSvg = container.querySelector('.cv-wires');
  _bottomBar = container.querySelector('.cv-bottombar');

  container.querySelectorAll('.cv-toolbar button').forEach(function(b) {
    b.addEventListener('click', function() {
      switch (b.getAttribute('data-act')) {
        case 'add': _openToolbarAddMenu(); break;
        case 'runall': _runAll(); break;
        case 'fit': _fitView(); break;
        case 'more': _openMoreMenu(); break;
      }
    });
  });

  _bindInteractions();
  _bindDropImport();
  _loadFromStorage();
  _renderAll();

  return function cleanup() {
    _clearDocHandlers();
    _container = _root = _viewport = _world = _wiresSvg = _bottomBar = null;
  };
}

function onMessage(action, data) {
  if (data && data.reqId && _pending[data.reqId]) { var r = _pending[data.reqId]; delete _pending[data.reqId]; r(data); }
}

TileAPI.registerTile({
  id: 'canvas',
  icon: '🎬',
  label: '创意幕布',
  desc: '节点式生成画布',
  group: 'main',
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },
  badge: '新',
  renderFront: function(container, w) {
    container.innerHTML = '<div class="tile-icon">🎬</div><div class="tile-label">创意幕布</div>' + (w >= 2 ? '<div class="tile-desc">节点式生成画布</div>' : '');
  },
  onExpand: onExpand,
  onMessage: onMessage,
  onStorageLoaded: function(storage) {
    try { var modes = storage.get('__tile_expand_modes') || {}; if (!modes['canvas']) { modes['canvas'] = 'full'; storage.set('__tile_expand_modes', modes); } } catch (_) {}
  }
});

})();
