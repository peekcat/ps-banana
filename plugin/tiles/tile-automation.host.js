// ============================================================
//  tile-automation.host.js — Codex 自动化 API · host 侧（Phase 0 骨架）
//
//  零侵入:本文件由 host/tile-host-loader.js 启动时自动 require,自注册 action,
//  不改任何现有文件(包括 index.js)。
//
//  IPC 契约(独立于卫星 command.json, 互不干扰):
//    读  wheelchair_ipc/automation_command.json   {reqId, ts, action, data}
//    写  wheelchair_ipc/automation_result.json     {reqId, ts, success, data, error}
//    大图 wheelchair_ipc/auto_out/<reqId>.png       (result 里只回 previewPath)
//
//  启动方式:面板 tile-automation.js 加载后 sendToHost('autoBootstrap') 一次,
//  本文件借这次调用的 ctx 拿到 sendToPanel,然后启动自己的 setInterval 自轮询。
//  之后不再依赖面板驱动(无持续跨桥流量)。
//
//  分发:
//    - host 类命令(纯 PS / 查询): 这里直接执行 + 写 result(串行锁防 executeAsModal 冲突)
//    - panel 类命令(提示词/参数/生成): _sendToPanel('autoCommand', ...),
//      面板处理后 sendToHost('autoWriteResult', ...) 回来写 result
// ============================================================

var HostAPI = require('../host/host-api.js');
var uxp = require('uxp');
var fs = uxp.storage.localFileSystem;
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;
var imaging = photoshop.imaging;
var formats = uxp.storage.formats;
var psConstants = photoshop.constants || {};
var psPixels = require('../host/ps-pixels.js');

var CMD_FILE = 'automation_command.json';
var CMD_CLAIM_PREFIX = 'automation_command.processing.';
var RES_FILE = 'automation_result.json';
var RES_TMP = 'automation_result.json.writing';
var OUT_DIR = 'auto_out';
var OUT_MAX_FILES = 160;
var OUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
var OUT_RECENT_GRACE_MS = 5 * 60 * 1000;
var SEEN_COMMAND_MAX = 512;
var PANEL_COMMAND_TIMEOUT_MS = 3600 * 1000;
var POLL_MS = 50;
// 自适应轮询 (2026-07-04 性能优化): 最近 2 分钟收到过命令 → 50ms 高速档;
// 否则 500ms 省电档(外部程序闲置时不再每秒 20 次白读磁盘)。收到命令瞬间切回高速。
var POLL_IDLE_MS = 500;
var POLL_FAST_WINDOW_MS = 2 * 60 * 1000;
var _lastActiveAt = 0;

var _ipcFolder = null;
var _sendToPanel = null;    // bootstrap 时从 ctx 捕获
var _acquirePSLock = null;  // bootstrap 时从 ctx 捕获, 与主生成/贴回共用同一把锁
var _autopilotProfile;      // undefined=尚未加载; null=明确未配置
var _started = false;
var _polling = false;       // 防止 poll 重入
var _pathSeq = 0;           // 临时路径唯一命名
var _cpSeq = 0;             // checkpoint 唯一命名
var _commandSeq = 0;
var _commandQueue = [];
var _drainingCommands = false;
var _seenCommandKeys = Object.create(null);
var _seenCommandOrder = [];
var _panelPending = Object.create(null);
var _lastOutCleanupAt = 0;
var _recentOutNames = Object.create(null);

// 面板类命令清单 (要 TileAPI/DOM, 交给面板处理; 其余默认 host 处理)
var PANEL_ACTIONS = {
  pingPanel: 1,
  getPromptMode: 1, ensurePromptTextMode: 1, clearPromptPresetBinding: 1,
  setPromptText: 1, setParams: 1, setAutoReturn: 1, runGenerate: 1,
  getTaskStatus: 1, getReturnedCandidates: 1, soloCandidate: 1, selectCandidate: 1,
  getCodexAutopilotProfile: 1, getAllowedModels: 1, validateModelPermission: 1
};

// 总开关关闭/暂停时只保留连通性与只读授权查询。远程修改授权档案永不开放。
var PUBLIC_READ_ACTIONS = {
  pingHost: 1, pingPanel: 1,
  getCodexAutopilotProfile: 1, getAllowedModels: 1, validateModelPermission: 1
};

var HOST_PERMISSION_BY_ACTION = {
  gotoGroupMask: 'allowMaskWrite',
  resetGroupMask: 'allowMaskWrite',
  fillGroupMaskRegion: 'allowMaskWrite',
  checkpoint: 'allowRollbackRetry',
  rollback: 'allowRollbackRetry',
  safeDeleteGeneratedLayer: 'allowDeleteGeneratedOnly',
  safeDeleteGeneratedGroupIfEmpty: 'allowDeleteGeneratedOnly'
};

// 这些命令内部会进入 executeAsModal, 必须与主生成/贴回共用 host/ps-lock.js。
var PS_LOCKED_ACTIONS = {
  getPsContext: 1, makeSquareSelection: 1, exportCompositePreview: 1,
  gotoGroupMask: 1, getMaskState: 1, resetGroupMask: 1, fillGroupMaskRegion: 1,
  selectionOps: 1, createPolygonSelection: 1, createBezierSelection: 1,
  exportMaskPreview: 1, activateDocument: 1,
  safeDeleteGeneratedLayer: 1, checkpoint: 1, rollback: 1,
  safeDeleteGeneratedGroupIfEmpty: 1
};

async function _getIpcFolder() {
  if (_ipcFolder) return _ipcFolder;
  var tempFolder = await fs.getTemporaryFolder();
  try { _ipcFolder = await tempFolder.getEntry('wheelchair_ipc'); }
  catch (e) { _ipcFolder = await tempFolder.createFolder('wheelchair_ipc'); }
  return _ipcFolder;
}

// 原子写 result: 先写 .writing 再删旧再 rename, 避免 Codex 读到半截 JSON
async function _writeResult(reqId, success, data, error) {
  try {
    var ipc = await _getIpcFolder();
    var payload = JSON.stringify({
      reqId: reqId || null,
      ts: Date.now(),
      success: !!success,
      data: (data === undefined ? null : data),
      error: error || null
    });
    var tmp = await ipc.createFile(RES_TMP, { overwrite: true });
    await tmp.write(payload);
    try { var old = await ipc.getEntry(RES_FILE); await old.delete(); } catch (_) {}
    try { await tmp.rename(RES_FILE); }
    catch (e) { var f = await ipc.createFile(RES_FILE, { overwrite: true }); await f.write(payload); }
    // 额外: 每个 reqId 独立结果文件(Codex 读它无竞争, 避开主文件 rename 窗口的偶发锁)
    if (reqId) {
      try {
        var out = await _ensureOutDir();
        var rf = await out.createFile(String(reqId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) + '.result.json', { overwrite: true });
        await rf.write(payload);
        _markOutFile(rf.name);
      } catch (_) {}
    }
    _cleanupOutDir(false).catch(function() {});
  } catch (e) {
    try { console.warn('[automation] 写 result 失败: ' + e.message); } catch (_) {}
  }
}

async function _ensureOutDir() {
  var ipc = await _getIpcFolder();
  try { return await ipc.getEntry(OUT_DIR); }
  catch (e) { return await ipc.createFolder(OUT_DIR); }
}

function _markOutFile(name) {
  if (name) _recentOutNames[name] = Date.now();
}

function _entryTime(entry) {
  try {
    var d = entry.dateModified || entry.dateCreated;
    if (d && typeof d.getTime === 'function') return d.getTime();
    if (typeof d === 'number' && isFinite(d)) return d;
  } catch (_) {}
  return 0;
}

async function _cleanupOutDir(force) {
  var now = Date.now();
  if (!force && now - _lastOutCleanupAt < 60 * 1000) return;
  _lastOutCleanupAt = now;
  var out = await _ensureOutDir();
  var entries = await out.getEntries();
  var files = entries.filter(function(e) { return e && e.isFile; });
  files.sort(function(a, b) { return _entryTime(b) - _entryTime(a); });
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var t = _entryTime(f);
    var recentAt = _recentOutNames[f.name] || 0;
    var inGrace = recentAt && now - recentAt < OUT_RECENT_GRACE_MS;
    var expired = t > 0 && now - t > OUT_MAX_AGE_MS;
    var overflow = i >= OUT_MAX_FILES;
    if (!inGrace && (expired || overflow)) {
      try { await f.delete(); } catch (_) {}
      delete _recentOutNames[f.name];
    }
  }
  Object.keys(_recentOutNames).forEach(function(name) {
    if (now - _recentOutNames[name] > OUT_RECENT_GRACE_MS) delete _recentOutNames[name];
  });
}

function _err(code, message) { return { code: code, message: message || code }; }

// ---- PS 工具 ----
function _v(x) { return Math.round((x && x._value != null) ? x._value : x); }

// 读当前选区 bounds (必须在 executeAsModal 内) — 3 种方法兜底, 对齐 ps-io
async function _readSelectionBoundsInModal() {
  var doc = app.activeDocument;
  // 方法1: DOM doc.selection.bounds
  try {
    var b = doc.selection && doc.selection.bounds;
    if (b && typeof b.left === 'number' && (b.right - b.left) > 0 && (b.bottom - b.top) > 0) {
      return { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom),
               width: Math.round(b.right - b.left), height: Math.round(b.bottom - b.top) };
    }
  } catch (e) {}
  // 方法2: batchPlay get document.selection (rectangle / left-right)
  try {
    var bp = await app.batchPlay([{ _obj: 'get', _target: [{ _property: 'selection' }, { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }] }], {});
    if (bp && bp[0] && bp[0].selection) {
      var s = bp[0].selection, sL, sT, sR, sB;
      if (s.left !== undefined) { sL = _v(s.left); sT = _v(s.top); sR = _v(s.right); sB = _v(s.bottom); }
      else if (s._obj === 'rectangle') { sL = _v(s.left); sT = _v(s.top); sR = _v(s.right); sB = _v(s.bottom); }
      if (sL !== undefined && sR !== undefined && (sR - sL) > 0 && (sB - sT) > 0) {
        return { left: sL, top: sT, right: sR, bottom: sB, width: sR - sL, height: sB - sT };
      }
    }
  } catch (e) {}
  // 方法3: 通道 bounds
  try {
    var r = await app.batchPlay([{ _obj: 'get', _target: [{ _property: 'bounds' }, { _ref: 'channel', _enum: 'channel', _value: 'selection' }] }], {});
    if (r && r[0] && r[0].bounds) {
      var cb = r[0].bounds; var L = _v(cb.left), T = _v(cb.top), R = _v(cb.right), B = _v(cb.bottom);
      if (R - L > 0 && B - T > 0) return { left: L, top: T, right: R, bottom: B, width: R - L, height: B - T };
    }
  } catch (e) {}
  return null;
}

// getPsContext — 当前文档/活动图层/选区(全部在一个 modal 里读, 保证选区能读到)
async function _cmdGetPsContext() {
  var doc = app.activeDocument;
  if (!doc) return { success: false, error: _err('NO_ACTIVE_DOCUMENT', '没有打开的文档') };
  var out = { docId: doc.id, docName: doc.name, width: doc.width, height: doc.height };
  try {
    var al = doc.activeLayers && doc.activeLayers[0];
    if (al) {
      out.activeLayerId = al.id;
      out.activeLayerName = al.name;
      out.activeLayerKind = al.kind;
      if (al.kind === 'group') out.activeGroupId = al.id;
      else { try { if (al.parent && al.parent.typename !== 'Document' && al.parent.id != null) out.activeGroupId = al.parent.id; } catch (_) {} }
    }
  } catch (e) {}
  try { out.layerCount = doc.layers ? doc.layers.length : null; } catch (_) {}
  var sel = null;
  try {
    await core.executeAsModal(async function() {
      sel = await _readSelectionBoundsInModal();
      if (!sel) sel = await _readSelectionBoundsInModal();  // 重试一次(偶发首读失败)
    }, { commandName: 'Codex 读上下文' });
  } catch (e) {}
  out.hasSelection = !!sel;
  out.selectionBounds = sel;
  out.activeTarget = null;  // 待后续 batchPlay 探测
  out.zoom = null;
  out.unsaved = null;
  return { success: true, data: out };
}

// getLayerStack — 完整图层树
function _layerNode(layer) {
  var node = { id: layer.id, name: layer.name, type: layer.kind, visible: layer.visible };
  try {
    if (layer.kind === 'group' && layer.layers && layer.layers.length != null) {
      node.children = [];
      for (var i = 0; i < layer.layers.length; i++) node.children.push(_layerNode(layer.layers[i]));
    }
  } catch (e) {}
  return node;
}
async function _cmdGetLayerStack() {
  var doc = app.activeDocument;
  if (!doc) return { success: false, error: _err('NO_ACTIVE_DOCUMENT', '没有打开的文档') };
  var layers = [];
  try { for (var i = 0; i < doc.layers.length; i++) layers.push(_layerNode(doc.layers[i])); } catch (e) {}
  return { success: true, data: { docId: doc.id, layers: layers } };
}

// makeSquareSelection — 正方形选区(香蕉类模型硬规则)
async function _cmdMakeSquareSelection(d) {
  var doc = app.activeDocument;
  if (!doc) return { success: false, error: _err('NO_ACTIVE_DOCUMENT', '没有打开的文档') };
  if (d == null || d.centerX == null || d.centerY == null || !d.size) {
    return { success: false, error: _err('BAD_ARGS', 'makeSquareSelection 需要 centerX/centerY/size') };
  }
  var half = d.size / 2;
  var L = Math.round(d.centerX - half), T = Math.round(d.centerY - half);
  var R = Math.round(d.centerX + half), B = Math.round(d.centerY + half);
  // 夹到文档内
  L = Math.max(0, L); T = Math.max(0, T);
  R = Math.min(doc.width, R); B = Math.min(doc.height, B);
  if (R - L < 2 || B - T < 2) return { success: false, error: _err('BAD_ARGS', '选区落在文档外或过小') };
  var feather = +d.feather || 0;
  await core.executeAsModal(async function() {
    await app.batchPlay([{
      _obj: 'set',
      _target: [{ _ref: 'channel', _property: 'selection' }],
      to: {
        _obj: 'rectangle',
        top: { _unit: 'pixelsUnit', _value: T }, left: { _unit: 'pixelsUnit', _value: L },
        bottom: { _unit: 'pixelsUnit', _value: B }, right: { _unit: 'pixelsUnit', _value: R }
      },
      feather: { _unit: 'pixelsUnit', _value: feather },
      antiAlias: true
    }], {});
  }, { commandName: 'Codex 正方形选区' });
  return { success: true, data: { selectionBounds: { left: L, top: T, right: R, bottom: B, width: R - L, height: B - T }, feather: feather } };
}

// exportCompositePreview — 导出真实合成预览(整张或局部区域), 写 PNG 到 auto_out/<reqId>.png
async function _cmdExportCompositePreview(d, reqId) {
  var doc = app.activeDocument;
  if (!doc) return { success: false, error: _err('NO_ACTIVE_DOCUMENT', '没有打开的文档') };
  d = d || {};
  var scale = (d.scale && d.scale > 0) ? d.scale : 1;
  var bounds = null, srcW = doc.width, srcH = doc.height;
  var rg = d.region;
  if (rg && rg.right > rg.left && rg.bottom > rg.top) {
    bounds = { left: Math.max(0, Math.round(rg.left)), top: Math.max(0, Math.round(rg.top)),
               right: Math.min(doc.width, Math.round(rg.right)), bottom: Math.min(doc.height, Math.round(rg.bottom)) };
    srcW = bounds.right - bounds.left; srcH = bounds.bottom - bounds.top;
  }
  var tw = Math.max(1, Math.round(srcW * scale)), th = Math.max(1, Math.round(srcH * scale));

  var pixels = null, comp = 3, pw = tw, ph = th;
  await core.executeAsModal(async function() {
    var opts = { documentID: doc.id, componentSize: 8, colorSpace: 'RGB', applyAlpha: false, targetSize: { width: tw, height: th } };
    if (bounds) opts.sourceBounds = bounds;
    var pd = await imaging.getPixels(opts);
    var img = pd.imageData || pd;
    comp = img.components || 3;
    pw = img.width || tw; ph = img.height || th;
    var raw = (typeof img.getData === 'function') ? await img.getData({}) : img.data;
    pixels = (raw instanceof Uint8Array) ? raw : new Uint8Array(raw);
    try { if (img.dispose) img.dispose(); } catch (_) {}
  }, { commandName: 'Codex 合成预览' });

  if (!pixels) return { success: false, error: _err('INTERNAL', '读取像素失败') };
  var png = psPixels.encodePNGFromRGB(pw, ph, pixels, comp);
  var out = await _ensureOutDir();
  var name = (reqId ? String(reqId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) : ('prev_' + Date.now())) + '.png';
  var f = await out.createFile(name, { overwrite: true });
  await f.write(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength), { format: formats.binary });
  _markOutFile(f.name);
  _cleanupOutDir(false).catch(function() {});
  return { success: true, data: { previewPath: f.nativePath, width: pw, height: ph, region: bounds, scale: scale } };
}

// ============================================================
//  阶段3: 蒙版 / 选区(全 host 纯 PS batchPlay)
// ============================================================
function _findLayerById(id) {
  var doc = app.activeDocument; if (!doc) return null;
  function walk(layers) {
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      if (l.id === id) return l;
      try { if (l.layers && l.layers.length) { var f = walk(l.layers); if (f) return f; } } catch (e) {}
    }
    return null;
  }
  try { return walk(doc.layers); } catch (e) { return null; }
}
async function _selectLayer(id) {
  await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false }], {});
}
async function _layerHasMask(id) {
  try {
    var r = await app.batchPlay([{ _obj: 'get', _target: [{ _property: 'hasUserMask' }, { _ref: 'layer', _id: id }] }], {});
    return !!(r && r[0] && r[0].hasUserMask);
  } catch (e) { return false; }
}
// 选蒙版通道 / 全选 / 清选区
async function _selectMaskChannel() { await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'channel', _enum: 'channel', _value: 'mask' }], makeVisible: false }], {}); }
async function _selectionNone() { await app.batchPlay([{ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _enum: 'ordinal', _value: 'none' } }], {}); }
async function _selectionAll() { await app.batchPlay([{ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _enum: 'ordinal', _value: 'allEnum' } }], {}); }
async function _fillWith(value) {
  await app.batchPlay([{ _obj: 'fill', using: { _enum: 'fillContents', _value: (value === 'white' ? 'white' : 'black') }, opacity: { _unit: 'percentUnit', _value: 100 }, mode: { _enum: 'blendMode', _value: 'normal' } }], {});
}

// gotoGroupMask — 选中组 + 激活其蒙版(无蒙版则建全白, 不改变可见效果)
async function _cmdGotoGroupMask(d) {
  var id = d && d.groupId;
  if (id == null) return { success: false, error: _err('BAD_ARGS', '需要 groupId') };
  if (!_findLayerById(id)) return { success: false, error: _err('GROUP_NOT_FOUND', '找不到图层 ' + id) };
  await core.executeAsModal(async function() {
    await _selectLayer(id);
    if (!(await _layerHasMask(id))) {
      await app.batchPlay([{ _obj: 'make', new: { _class: 'channel' }, at: { _ref: 'channel', _enum: 'channel', _value: 'mask' }, using: { _enum: 'userMaskEnabled', _value: 'revealAll' } }], {});
      await _selectLayer(id);
    }
    await _selectMaskChannel();
  }, { commandName: 'Codex 定位组蒙版' });
  return { success: true, data: { groupId: id, hasMask: true } };
}

// getMaskState — 读组蒙版状态(hasMask/enabled; 白黑区域 bounds 与 roughType 后续补)
async function _cmdGetMaskState(d) {
  var id = d && d.groupId;
  if (id == null) return { success: false, error: _err('BAD_ARGS', '需要 groupId') };
  if (!_findLayerById(id)) return { success: false, error: _err('GROUP_NOT_FOUND', '找不到图层 ' + id) };
  var has = false, enabled = null;
  await core.executeAsModal(async function() {
    has = await _layerHasMask(id);
    if (has) {
      try { var r = await app.batchPlay([{ _obj: 'get', _target: [{ _property: 'userMaskEnabled' }, { _ref: 'layer', _id: id }] }], {}); enabled = (r && r[0] && r[0].userMaskEnabled != null) ? !!r[0].userMaskEnabled : null; } catch (e) {}
    }
  }, { commandName: 'Codex 读蒙版状态' });
  return { success: true, data: { groupId: id, hasMask: has, enabled: enabled, roughType: has ? 'unknown' : 'none' } };
}

// resetGroupMask — 整块重置为全黑/全白
async function _cmdResetGroupMask(d) {
  var id = d && d.groupId, value = (d && d.value) || 'black';
  if (id == null) return { success: false, error: _err('BAD_ARGS', '需要 groupId') };
  if (!_findLayerById(id)) return { success: false, error: _err('GROUP_NOT_FOUND', '找不到图层 ' + id) };
  var fill = (value === 'white') ? 'white' : 'black';
  await core.executeAsModal(async function() {
    await _selectLayer(id);
    if (!(await _layerHasMask(id))) {
      await app.batchPlay([{ _obj: 'make', new: { _class: 'channel' }, at: { _ref: 'channel', _enum: 'channel', _value: 'mask' }, using: { _enum: 'userMaskEnabled', _value: (fill === 'white' ? 'revealAll' : 'hideAll') } }], {});
    } else {
      await _selectMaskChannel();
      await _selectionAll();
      await _fillWith(fill);
      await _selectionNone();
    }
    await _selectLayer(id);
  }, { commandName: 'Codex 重置组蒙版' });
  return { success: true, data: { groupId: id, value: fill } };
}

// fillGroupMaskRegion — 把当前选区精确写进指定组蒙版(显式 groupId/value/feather, 不依赖前景色/活动图层)
async function _cmdFillGroupMaskRegion(d) {
  var id = d && d.groupId, value = (d && d.value) || 'white', feather = +((d && d.feather) || 0);
  if (id == null) return { success: false, error: _err('BAD_ARGS', '需要 groupId') };
  var deny = await _authDeny('allowMaskWrite'); if (deny) return { success: false, error: deny };
  if (!_findLayerById(id)) return { success: false, error: _err('GROUP_NOT_FOUND', '找不到图层 ' + id) };
  var fill = (value === 'white') ? 'white' : 'black';
  var hadSel = false, selBounds = null;
  await core.executeAsModal(async function() {
    var sel = await _readSelectionBoundsInModal();
    hadSel = !!sel; selBounds = sel;
    if (!hadSel) return;
    await _selectLayer(id);
    if (!(await _layerHasMask(id))) {
      await app.batchPlay([{ _obj: 'make', new: { _class: 'channel' }, at: { _ref: 'channel', _enum: 'channel', _value: 'mask' }, using: { _enum: 'userMaskEnabled', _value: 'hideAll' } }], {});
      await _selectLayer(id);
    }
    await _selectMaskChannel();
    if (feather > 0) { try { await app.batchPlay([{ _obj: 'feather', radius: { _unit: 'pixelsUnit', _value: feather } }], {}); } catch (e) {} }
    await _fillWith(fill);
    await _selectionNone();
    await _selectLayer(id);
  }, { commandName: 'Codex 写组蒙版' });
  if (!hadSel) return { success: false, error: _err('NO_SELECTION', '当前没有选区, 请先建选区(makeSquareSelection / createPolygonSelection)') };
  return { success: true, data: { groupId: id, value: fill, feather: feather, selectionBounds: selBounds } };
}

// selectionOps — 对当前选区 羽化/扩展/收缩/平滑
async function _cmdSelectionOps(d) {
  d = d || {};
  var bounds = null, had = false;
  await core.executeAsModal(async function() {
    had = !!(await _readSelectionBoundsInModal());
    if (!had) return;
    if (+d.expand > 0) await app.batchPlay([{ _obj: 'expand', by: { _unit: 'pixelsUnit', _value: +d.expand } }], {});
    if (+d.contract > 0) await app.batchPlay([{ _obj: 'contract', by: { _unit: 'pixelsUnit', _value: +d.contract } }], {});
    if (+d.smooth > 0) await app.batchPlay([{ _obj: 'smooth', radius: { _unit: 'pixelsUnit', _value: +d.smooth } }], {});
    if (+d.feather > 0) await app.batchPlay([{ _obj: 'feather', radius: { _unit: 'pixelsUnit', _value: +d.feather } }], {});
    bounds = await _readSelectionBoundsInModal();
  }, { commandName: 'Codex 选区处理' });
  if (!had) return { success: false, error: _err('NO_SELECTION', '当前没有选区') };
  return { success: true, data: { selectionBounds: bounds } };
}

// 工作路径 → 选区 (多边形/贝塞尔共用)
// 官方 DOM: 构造器在 app 对象上 (new app.PathPointInfo / new app.SubPathInfo), doc.pathItems.add() 建路径
function _mkPathPoint(anchor, left, right, smooth) {
  var pp = new app.PathPointInfo();
  pp.anchor = anchor;
  pp.leftDirection = left || anchor;
  pp.rightDirection = right || anchor;
  try {
    var PK = psConstants.PointKind || {};
    pp.kind = smooth ? PK.SMOOTHPOINT : PK.CORNERPOINT;
  } catch (e) {}
  return pp;
}
// DOM 建路径, 返回 PathItem (name 由调用方给, 便于按名转选区/清理)
function _domCreatePath(points, bezier, name) {
  var ppts = points.map(function(p) {
    if (bezier && p && p.anchor) {
      var a = p.anchor, l = p.left || p.backward || a, r = p.right || p.forward || a;
      return _mkPathPoint(a, l, r, true);
    }
    var xy = (p && p.anchor) ? p.anchor : p;
    return _mkPathPoint(xy, xy, xy, false);
  });
  var spi = new app.SubPathInfo();
  spi.entireSubPath = ppts;
  spi.closed = true;
  try { var SO = psConstants.ShapeOperation || {}; spi.operation = (SO.SHAPEADD != null ? SO.SHAPEADD : SO.SHAPEXOR); } catch (e) {}
  return app.activeDocument.pathItems.add(name, [spi]);
}
// 路径 → 选区: DOM makeSelection 可用就用; 否则按路径名 batchPlay(本 UXP 版 makeSelection 不可用)
async function _pathToSelection(p, name, operation, feather) {
  var f = +feather || 0;
  if (p && typeof p.makeSelection === 'function') {
    var ST = psConstants.SelectionType || {};
    var domOp = ({
      replace: ST.REPLACE,
      add: ST.EXTEND,
      subtract: ST.DIMINISH,
      intersect: ST.INTERSECT
    })[operation || 'replace'];
    if (domOp != null) {
      try { await p.makeSelection(f, true, domOp); return 'dom-positional'; } catch (e) {}
    }
  }
  var op = ({ replace: 'set', add: 'addTo', subtract: 'subtractFrom', intersect: 'intersectWith' })[operation || 'replace'] || 'set';
  await app.batchPlay([{ _obj: op, _target: [{ _ref: 'channel', _property: 'selection' }], to: { _ref: 'path', _name: name }, feather: { _unit: 'pixelsUnit', _value: f }, antiAlias: true }], {});
  return 'batchplay-byname';
}
function _sameBounds(a, b) { return !!(a && b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom); }
function _pathNames() {
  try {
    var pi = app.activeDocument.pathItems;
    if (!pi) return null;
    var n = [];
    for (var i = 0; i < pi.length; i++) { try { n.push(pi[i].name); } catch (e) {} }
    return n;
  } catch (e) { return null; }
}
function _pathCount() { try { return app.activeDocument.pathItems ? app.activeDocument.pathItems.length : null; } catch (e) { return null; } }
// 读回最后一条路径的真实锚点坐标(判断分辨率坐标偏移 / 路径是否退化)
function _readPathAnchors() {
  try {
    var pi = app.activeDocument.pathItems;
    if (!pi || !pi.length) return null;
    var p = pi[pi.length - 1];
    var out = [];
    var sps = p.subPathItems;
    for (var s = 0; s < sps.length; s++) {
      var pts = sps[s].pathPoints;
      for (var i = 0; i < pts.length; i++) {
        var a = pts[i].anchor;
        var x = (a && a.length != null) ? a[0] : (a && a.horizontal);
        var y = (a && a.length != null) ? a[1] : (a && a.vertical);
        out.push([Math.round(x), Math.round(y)]);
      }
    }
    return out;
  } catch (e) { return 'read-fail:' + (e && e.message || e); }
}

async function _polyOrBezier(d, bezier) {
  var pts = d && d.points;
  if (!pts || pts.length < 3) return { success: false, error: _err('BAD_ARGS', '需要至少 3 个点') };
  function anchorOf(p) { return (p && p.anchor) ? p.anchor : p; }
  var xs = pts.map(function(p) { return anchorOf(p)[0]; }), ys = pts.map(function(p) { return anchorOf(p)[1]; });
  var exp = { left: Math.round(Math.min.apply(null, xs)), top: Math.round(Math.min.apply(null, ys)), right: Math.round(Math.max.apply(null, xs)), bottom: Math.round(Math.max.apply(null, ys)) };
  var before = null, after = null, err = null, diag = {}, newPath = null;
  var pathName = 'Codex_tmp_' + (_pathSeq++);
  await core.executeAsModal(async function() {
    try { diag.resolution = app.activeDocument.resolution; } catch (e) {}
    before = await _readSelectionBoundsInModal();
    diag.pathsBefore = _pathCount();
    try { newPath = _domCreatePath(pts, bezier, pathName); } catch (e) { err = 'domCreatePath: ' + (e && e.message || e); }
    diag.pathsAfter = _pathCount();
    diag.pathAnchors = _readPathAnchors();   // 路径真实坐标 → 看分辨率偏移/是否退化
    if (!err) { try { diag.selMethod = await _pathToSelection(newPath, pathName, d.operation, +((d && d.feather) || 0)); } catch (e) { err = 'pathToSel: ' + (e && e.message || e); } }
    after = await _readSelectionBoundsInModal();
    // 清理临时路径: DOM remove 优先, 失败按名 batchPlay 删
    try {
      if (newPath && typeof newPath.remove === 'function') await newPath.remove();
      else await app.batchPlay([{ _obj: 'delete', _target: [{ _ref: 'path', _name: pathName }] }], {});
    } catch (_) {
      try { await app.batchPlay([{ _obj: 'delete', _target: [{ _ref: 'path', _name: pathName }] }], {}); } catch (e2) {}
    }
  }, { commandName: bezier ? 'Codex 贝塞尔选区' : 'Codex 多边形选区' });
  if (err) return { success: false, error: _err('INTERNAL', '路径/选区命令报错: ' + err), data: { expectedBounds: exp, before: before, after: after, diag: diag } };
  if ((d.operation || 'replace') === 'replace' && !after) {
    return { success: false, error: _err('SELECTION_EMPTY', '路径命令执行后没有得到选区'), data: { before: before, after: after, expectedBounds: exp, diag: diag } };
  }
  return { success: true, data: { selectionBounds: after, expectedBounds: exp, operation: d.operation || 'replace', feather: +((d && d.feather) || 0), diag: diag } };
}

// exportMaskPreview — 导组蒙版灰度图(尝试 imaging.getLayerMask; 不可用则报 NOT_SUPPORTED)
async function _cmdExportMaskPreview(d, reqId) {
  var id = d && d.groupId;
  if (id == null) return { success: false, error: _err('BAD_ARGS', '需要 groupId') };
  if (!_findLayerById(id)) return { success: false, error: _err('GROUP_NOT_FOUND', '找不到图层 ' + id) };
  var pixels = null, pw = 0, ph = 0, comp = 1, scaleApplied = false;
  var scale = (d.scale && d.scale > 0 && d.scale !== 1) ? d.scale : 1;
  try {
    await core.executeAsModal(async function() {
      if (!imaging.getLayerMask) throw new Error('imaging.getLayerMask 不存在');
      var opts = { documentID: app.activeDocument.id, layerID: id, componentSize: 8 };
      var expW = 0, expH = 0;
      if (scale !== 1) {
        // 组蒙版通常是文档尺寸; 按文档尺寸×scale 给 targetSize
        expW = Math.max(1, Math.round(app.activeDocument.width * scale));
        expH = Math.max(1, Math.round(app.activeDocument.height * scale));
        opts.targetSize = { width: expW, height: expH };
      }
      var pd = await imaging.getLayerMask(opts);
      var img = pd.imageData || pd;
      pw = img.width; ph = img.height; comp = img.components || 1;
      if (scale !== 1 && Math.abs(pw - expW) <= 2 && Math.abs(ph - expH) <= 2) scaleApplied = true;
      var raw = (typeof img.getData === 'function') ? await img.getData({}) : img.data;
      pixels = (raw instanceof Uint8Array) ? raw : new Uint8Array(raw);
      try { if (img.dispose) img.dispose(); } catch (_) {}
    }, { commandName: 'Codex 蒙版预览' });
  } catch (e) {
    return { success: false, error: _err('NOT_SUPPORTED', '导蒙版预览失败(可能 imaging.getLayerMask 不可用): ' + (e && e.message || e)) };
  }
  if (!pixels) return { success: false, error: _err('INTERNAL', '读蒙版像素失败') };
  // 灰度 → RGB (encodePNGFromRGB 只输出 RGB)
  var rgb = new Uint8Array(pw * ph * 3);
  for (var i = 0; i < pw * ph; i++) { var g = pixels[i * comp]; rgb[i * 3] = g; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = g; }
  var png = psPixels.encodePNGFromRGB(pw, ph, rgb, 3);
  var out = await _ensureOutDir();
  var name = (reqId ? String(reqId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) : ('mask_' + Date.now())) + '.png';
  var f = await out.createFile(name, { overwrite: true });
  await f.write(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength), { format: formats.binary });
  _markOutFile(f.name);
  _cleanupOutDir(false).catch(function() {});
  return { success: true, data: { previewPath: f.nativePath, width: pw, height: ph, scaleApplied: scaleApplied, scaleIgnored: (scale !== 1 && !scaleApplied) } };
}

// host 侧命令执行 (Phase 0 只有 pingHost; Phase 1+ 在此扩展纯 PS 查询/选区/蒙版)
// 改文档命令放进 executeAsModal，并由底部统一走全局 acquirePSLock。
// 找某图层的父组 PS id(给 Codex 把候选 layerId 换成 groupLayerId)
function _findParentGroupId(id) {
  var doc = app.activeDocument; if (!doc) return undefined;
  function walk(layers, parentId) {
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      if (l.id === id) return parentId;
      try { if (l.kind === 'group' && l.layers && l.layers.length) { var r = walk(l.layers, l.id); if (r !== undefined) return r; } } catch (e) {}
    }
    return undefined;
  }
  return walk(doc.layers, null);
}
async function _cmdGetLayerParentGroup(d) {
  var id = d && d.layerId;
  if (id == null) return { success: false, error: _err('BAD_ARGS', '需要 layerId') };
  if (!_findLayerById(id)) return { success: false, error: _err('LAYER_NOT_FOUND', '找不到图层 ' + id) };
  var gid = _findParentGroupId(id);
  return { success: true, data: { layerId: id, groupLayerId: (gid === undefined ? null : gid) } };
}

// listDocuments / activateDocument — 全自动流程切回目标文档
async function _cmdListDocuments() {
  var docs = [], active = app.activeDocument;
  try {
    for (var i = 0; i < app.documents.length; i++) {
      var dd = app.documents[i];
      docs.push({ id: dd.id, name: dd.name, width: dd.width, height: dd.height, active: !!(active && active.id === dd.id) });
    }
  } catch (e) {}
  return { success: true, data: { documents: docs, activeDocId: active ? active.id : null } };
}
async function _cmdActivateDocument(d) {
  var id = d && d.docId;
  if (id == null) return { success: false, error: _err('BAD_ARGS', '需要 docId') };
  var found = null;
  try { for (var i = 0; i < app.documents.length; i++) { if (app.documents[i].id === id) { found = app.documents[i]; break; } } } catch (e) {}
  if (!found) return { success: false, error: _err('DOCUMENT_NOT_FOUND', '找不到文档 ' + id) };
  await core.executeAsModal(async function() {
    await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: id }] }], {});
  }, { commandName: 'Codex 切换文档' });
  return { success: true, data: { activeDocId: id, name: found.name } };
}

// ============================================================
//  阶段4: 安全锁 (baseline 保护 / 生成登记 / checkpoint-rollback) — 全 host
// ============================================================
async function _readJson(name) { try { var ipc = await _getIpcFolder(); var f = await ipc.getEntry(name); var t = await f.read(); return t ? JSON.parse(t) : null; } catch (e) { return null; } }
async function _writeJson(name, obj) { try { var ipc = await _getIpcFolder(); var f = await ipc.createFile(name, { overwrite: true }); await f.write(JSON.stringify(obj)); return true; } catch (e) { return false; } }

// 授权档案(由 Codex 磁贴保存时写到 codex_autopilot.json) + 是否生效 + 权限拦截
async function _readAutopilot() {
  if (_autopilotProfile !== undefined) return _autopilotProfile;
  var p = await _readJson('codex_autopilot.json');
  _autopilotProfile = (p && typeof p === 'object') ? p : null;
  return _autopilotProfile;
}
function _autopilotActive(ap) { return !!(ap && ap.enabled === true && ap.paused !== true); }
// Fail closed authorization: inactive, paused, or missing permission all reject.
async function _authDeny(permKey) {
  var ap = await _readAutopilot();
  if (!ap || ap.enabled !== true) return _err('AUTOPILOT_DISABLED', '全自动开关未开启，已拒绝自动化操作');
  if (ap.paused === true) return _err('AUTOPILOT_PAUSED', '全自动目前已暂停，已拒绝自动化操作');
  if (permKey && (!ap.permissions || ap.permissions[permKey] !== true)) return _err('NOT_ALLOWED', '这个操作没有明确授权: ' + permKey);
  return null;
}
async function _authorizeAction(action) {
  if (PUBLIC_READ_ACTIONS[action]) return null;
  var ap = await _readAutopilot();
  if (!ap || ap.enabled !== true) return _err('AUTOPILOT_DISABLED', '全自动开关未开启，已拒绝自动化操作');
  if (ap.paused === true) return _err('AUTOPILOT_PAUSED', '全自动目前已暂停，已拒绝自动化操作');
  var perm = HOST_PERMISSION_BY_ACTION[action];
  if (perm && (!ap.permissions || ap.permissions[perm] !== true)) return _err('NOT_ALLOWED', '这个操作没有明确授权: ' + perm);
  return null;
}

// Trusted registry is session-bound. A disk entry alone cannot authorize deletion.
var _trustedTasks = Object.create(null);
var _trustedEntries = Object.create(null);
var _selectionProbes = Object.create(null);
var _selectionProbeSeq = 0;
var _runAuthorizations = Object.create(null);
var _runAuthorizationSeq = 0;
var RUN_AUTH_TTL_MS = 60 * 1000;
var _cancelledRunTasks = Object.create(null);
var CANCELLED_RUN_TTL_MS = 5 * 60 * 1000;
var _baselineState = null;
function _idKey(docId, layerId) { return String(docId) + ':' + String(layerId); }
function _sameId(a, b) { return a != null && b != null && String(a) === String(b); }
function _isFiniteId(id) { return id != null && id !== '' && isFinite(Number(id)); }
function _rememberEntry(entry) {
  if (!entry || !_isFiniteId(entry.docId) || !_isFiniteId(entry.layerId) || entry.trusted !== true) return;
  _trustedEntries[_idKey(entry.docId, entry.layerId)] = entry;
}
function _entryFor(docId, layerId) { return _trustedEntries[_idKey(docId, layerId)] || null; }
async function _saveTrustedRegistry() {
  var layers = Object.keys(_trustedEntries).map(function(k) { return _trustedEntries[k]; });
  await _writeJson('codex_generated.json', { version: 2, layers: layers });
}
function _findDocumentById(docId) {
  if (!_isFiniteId(docId)) return null;
  try {
    for (var i = 0; i < app.documents.length; i++) if (_sameId(app.documents[i].id, docId)) return app.documents[i];
  } catch (_) {}
  return null;
}
function _findLayerRecordInDoc(doc, id) {
  if (!doc || !_isFiniteId(id)) return null;
  function walk(layers, parent) {
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (_sameId(layer.id, id)) return { layer: layer, parent: parent || null };
      try {
        if (layer.kind === 'group' && layer.layers && layer.layers.length) {
          var found = walk(layer.layers, layer);
          if (found) return found;
        }
      } catch (_) {}
    }
    return null;
  }
  try { return walk(doc.layers, null); } catch (_) { return null; }
}
function _registryEntryFromLayer(doc, task, rec, source) {
  if (!doc || !task || !rec || !rec.layer) return null;
  return {
    docId: doc.id, taskId: task.taskId, layerId: rec.layer.id,
    kind: rec.layer.kind === 'group' ? 'group' : 'layer', trusted: true,
    createdBy: 'codex', source: source || 'automation-return', createdAt: Date.now(),
    provider: task.provider || '', model: task.model || ''
  };
}
function _collectAllLayers(doc) {
  doc = doc || app.activeDocument;
  var layerIds = [], groupIds = [];
  function walk(layers) {
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      layerIds.push(l.id);
      if (l.kind === 'group') { groupIds.push(l.id); try { if (l.layers && l.layers.length) walk(l.layers); } catch (e) {} }
    }
  }
  try { walk(doc.layers); } catch (e) {}
  return { layerIds: layerIds, groupIds: groupIds };
}

async function _captureBaselineForDocument(doc) {
  if (!doc) return { success: false, error: _err('NO_ACTIVE_DOCUMENT', '没有打开的文档') };
  var c = _collectAllLayers(doc);
  var baseline = { docId: doc.id, docName: doc.name, capturedAt: Date.now(), protectedLayerIds: c.layerIds, protectedGroupIds: c.groupIds };
  _baselineState = baseline;
  await _writeJson('codex_baseline.json', baseline);
  return { success: true, data: baseline };
}

async function _ensureBaselineForDocument(doc) {
  if (_baselineState && doc && _sameId(_baselineState.docId, doc.id)) {
    return { success: true, data: _baselineState, existing: true };
  }
  return await _captureBaselineForDocument(doc);
}

async function _autoCaptureBaselineForCurrentDocument(ctx) {
  var ap = await _readAutopilot();
  if (!_autopilotActive(ap)) return null;
  var doc = null;
  try { doc = app.activeDocument; } catch (_) {}
  if (!doc) return null;
  var capture = function() { return _ensureBaselineForDocument(doc); };
  if (ctx && typeof ctx.acquirePSLock === 'function') {
    return await ctx.acquirePSLock(capture, 'automation:auto-baseline:' + doc.id);
  }
  return await capture();
}

// captureCodexBaseline — 接管时记录当前全部图层为 baseline(不可删)
async function _cmdCaptureCodexBaseline() {
  var doc = app.activeDocument;
  return await _captureBaselineForDocument(doc);
}
async function _cmdGetCodexBaseline() {
  if (_baselineState) return { success: true, data: _baselineState };
  var stored = await _readJson('codex_baseline.json');
  return { success: true, data: stored ? {
    captured: false, storedOnly: true, docId: stored.docId, docName: stored.docName,
    capturedAt: stored.capturedAt,
    note: '这是上次会话留下的记录；为防篡改，本次接管前需要重新 captureCodexBaseline'
  } : { captured: false } };
}
// validateLayerMutation — 校验某操作是否允许(baseline 图层禁删)
async function _cmdValidateLayerMutation(d) {
  var id = d && d.layerId, op = (d && d.op) || 'delete';
  if (id == null) return { success: false, error: _err('BAD_ARGS', '需要 layerId') };
  var doc = app.activeDocument;
  var b = (doc && _baselineState && _sameId(_baselineState.docId, doc.id)) ? _baselineState : null;
  var prot = b ? (b.protectedLayerIds || []).concat(b.protectedGroupIds || []) : [];
  var isBaseline = prot.some(function(x) { return _sameId(x, id); });
  var allowed = true, reason = null;
  if (!b && (op === 'delete' || op === 'remove' || op === 'flatten' || op === 'merge')) { allowed = false; reason = '当前文档还没有本次会话的可信 baseline'; }
  if ((op === 'delete' || op === 'remove' || op === 'flatten' || op === 'merge') && isBaseline) { allowed = false; reason = '该图层属于 baseline(接管前已存在), 禁止 ' + op; }
  return { success: true, data: { layerId: id, op: op, docId: doc ? doc.id : null, hasTrustedBaseline: !!b, isBaseline: isBaseline, allowed: allowed, reason: reason } };
}
// 远程命令只能补充已可信登记的描述，不能凭调用者标签创建删除权限。
async function _cmdTagLayerMetadata(d) {
  var id = d && d.layerId;
  if (id == null) return { success: false, error: _err('BAD_ARGS', '需要 layerId') };
  var doc = app.activeDocument;
  if (!doc) return { success: false, error: _err('NO_ACTIVE_DOCUMENT', '没有打开的文档') };
  var entry = _entryFor(doc.id, id);
  if (!entry || entry.trusted !== true || !_trustedTasks[entry.taskId]) {
    return { success: false, error: _err('NOT_TRUSTED_GENERATED', '该图层不是本次自动化任务真实返回的图层，不能登记删除权限') };
  }
  ['prompt', 'candidateIndex', 'selectedReason'].forEach(function(k) { if (d[k] != null) entry[k] = d[k]; });
  await _saveTrustedRegistry();
  return { success: true, data: entry };
}
function _trustedDeleteContext(id, expectedKind) {
  var doc = app.activeDocument;
  if (!doc) return { error: _err('NO_ACTIVE_DOCUMENT', '没有打开的文档') };
  if (!_baselineState || !_sameId(_baselineState.docId, doc.id)) return { error: _err('BASELINE_REQUIRED', '当前文档没有本次会话的可信 baseline，拒绝删除') };
  var entry = _entryFor(doc.id, id);
  if (!entry || entry.trusted !== true || !_trustedTasks[entry.taskId] || !_sameId(entry.docId, doc.id)) {
    return { error: _err('NOT_TRUSTED_GENERATED', '该图层不是本次自动化任务真实返回的图层，拒绝删除') };
  }
  if (expectedKind && entry.kind !== expectedKind) return { error: _err('WRONG_LAYER_KIND', '登记类型不匹配，拒绝删除') };
  var prot = (_baselineState.protectedLayerIds || []).concat(_baselineState.protectedGroupIds || []);
  if (prot.some(function(x) { return _sameId(x, id); })) return { error: _err('PROTECTED_LAYER', '该图层属于 baseline，禁止删除') };
  var rec = _findLayerRecordInDoc(doc, id);
  if (!rec) return { error: _err('LAYER_NOT_FOUND', '找不到图层 ' + id) };
  return { doc: doc, entry: entry, rec: rec };
}

// safeDeleteGeneratedLayer — 只删本次可信任务返回且不在 baseline 里的普通图层。
async function _cmdSafeDeleteGeneratedLayer(d) {
  var id = d && d.layerId;
  if (id == null) return { success: false, error: _err('BAD_ARGS', '需要 layerId') };
  var deny = await _authDeny('allowDeleteGeneratedOnly'); if (deny) return { success: false, error: deny };
  var checked = _trustedDeleteContext(id, 'layer');
  if (checked.error) return { success: false, error: checked.error };
  var lyr = checked.rec.layer;
  await core.executeAsModal(async function() {
    if (typeof lyr.delete === 'function') await lyr.delete();
    else await app.batchPlay([{ _obj: 'delete', _target: [{ _ref: 'layer', _id: id }] }], {});
  }, { commandName: 'Codex 安全删除' });
  delete _trustedEntries[_idKey(checked.doc.id, id)];
  await _saveTrustedRegistry();
  return { success: true, data: { deletedLayerId: id, docId: checked.doc.id, taskId: checked.entry.taskId } };
}
// checkpoint — PS 历史快照
async function _cmdCheckpoint(d) {
  var doc = app.activeDocument;
  if (!doc) return { success: false, error: _err('NO_ACTIVE_DOCUMENT', '没有打开的文档') };
  var label = (d && d.label) ? String(d.label).replace(/[^\w一-龥\- ]/g, '').slice(0, 40) : '';
  var id = 'codex_cp_' + (_cpSeq++) + (label ? ('_' + label) : '');
  await core.executeAsModal(async function() {
    await app.batchPlay([{
      _obj: 'make', _target: [{ _ref: 'snapshotClass' }],
      from: { _ref: 'historyState', _property: 'currentHistoryState' },
      name: id, using: { _enum: 'historyState', _value: 'fullDocument' }
    }], {});
  }, { commandName: 'Codex checkpoint' });
  return { success: true, data: { checkpointId: id, label: label } };
}
// rollback — 回到指定快照
async function _cmdRollback(d) {
  var id = d && d.checkpointId;
  if (!id) return { success: false, error: _err('BAD_ARGS', '需要 checkpointId') };
  try {
    await core.executeAsModal(async function() {
      await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'snapshotClass', _name: id }] }], {});
    }, { commandName: 'Codex rollback' });
  } catch (e) {
    return { success: false, error: _err('CHECKPOINT_NOT_FOUND', '回滚失败(快照可能不存在/已被清): ' + (e && e.message || e)) };
  }
  return { success: true, data: { rolledBackTo: id } };
}

// safeDeleteGeneratedGroupIfEmpty — 只删「不在 baseline 且为空」的组
async function _cmdSafeDeleteGeneratedGroupIfEmpty(d) {
  var id = d && d.groupId;
  if (id == null) return { success: false, error: _err('BAD_ARGS', '需要 groupId') };
  var deny = await _authDeny('allowDeleteGeneratedOnly'); if (deny) return { success: false, error: deny };
  var checked = _trustedDeleteContext(id, 'group');
  if (checked.error) return { success: false, error: checked.error };
  var lyr = checked.rec.layer;
  if (lyr.kind !== 'group') return { success: false, error: _err('NOT_A_GROUP', '该图层不是组') };
  var childCount = 0; try { childCount = lyr.layers ? lyr.layers.length : 0; } catch (e) {}
  if (childCount > 0) return { success: false, error: _err('GROUP_NOT_EMPTY', '组里还有 ' + childCount + ' 个图层, 只删空组') };
  await core.executeAsModal(async function() {
    if (typeof lyr.delete === 'function') await lyr.delete();
    else await app.batchPlay([{ _obj: 'delete', _target: [{ _ref: 'layer', _id: id }] }], {});
  }, { commandName: 'Codex 删空组' });
  delete _trustedEntries[_idKey(checked.doc.id, id)];
  await _saveTrustedRegistry();
  return { success: true, data: { deletedGroupId: id, docId: checked.doc.id, taskId: checked.entry.taskId } };
}

function _cleanupRunAuthorizations() {
  var now = Date.now();
  Object.keys(_runAuthorizations).forEach(function(k) {
    if (!(_runAuthorizations[k] && now - _runAuthorizations[k].createdAt <= RUN_AUTH_TTL_MS)) delete _runAuthorizations[k];
  });
  Object.keys(_cancelledRunTasks).forEach(function(taskId) {
    if (!(now - _cancelledRunTasks[taskId] <= CANCELLED_RUN_TTL_MS)) delete _cancelledRunTasks[taskId];
  });
}

function _revokeTrustedTask(taskId) {
  taskId = taskId == null ? '' : String(taskId);
  if (!taskId) return false;
  var existed = !!_trustedTasks[taskId];
  delete _trustedTasks[taskId];
  return existed;
}

function _isRunCancelled(taskId) {
  _cleanupRunAuthorizations();
  taskId = taskId == null ? '' : String(taskId);
  return !!(taskId && _cancelledRunTasks[taskId]);
}

function _cancelAutomationRun(d) {
  d = d || {};
  _cleanupRunAuthorizations();
  var authorizationId = d.authorizationId == null ? '' : String(d.authorizationId);
  var taskId = d.taskId == null ? '' : String(d.taskId);
  var pendingAuthorization = authorizationId && _runAuthorizations[authorizationId];
  if (pendingAuthorization) {
    if (taskId && taskId !== pendingAuthorization.taskId) {
      return { success: false, error: _err('RUN_AUTHORIZATION_MISMATCH', '取消请求与生成授权不一致') };
    }
    taskId = pendingAuthorization.taskId;
    delete _runAuthorizations[authorizationId];
  }
  if (!taskId) return { success: false, error: _err('BAD_ARGS', '缺少要取消的自动化任务 ID') };
  Object.keys(_runAuthorizations).forEach(function(key) {
    if (_runAuthorizations[key] && String(_runAuthorizations[key].taskId) === taskId) delete _runAuthorizations[key];
  });
  _cancelledRunTasks[taskId] = Date.now();
  _revokeTrustedTask(taskId);
  return { success: true, data: { taskId: taskId, cancelled: true } };
}

async function _authorizeAutomationRun(d) {
  d = d || {};
  var deny = await _authDeny('allowGenerate');
  if (deny) return { success: false, error: deny };
  var taskId = d.taskId == null ? '' : String(d.taskId);
  if (!taskId) return { success: false, error: _err('BAD_ARGS', '缺少 taskId') };
  if (_isRunCancelled(taskId)) return { success: false, error: _err('RUN_AUTHORIZATION_CANCELLED', '这次自动化生成已经取消') };
  if (_trustedTasks[taskId]) return { success: false, error: _err('TASK_ID_ALREADY_USED', '这个任务 ID 已经使用过') };
  var doc = _findDocumentById(d.docId);
  if (!doc) return { success: false, error: _err('DOCUMENT_NOT_FOUND', '生成任务对应的 Photoshop 文档不存在') };
  var activeDoc = null;
  try { activeDoc = app.activeDocument; } catch (_) {}
  if (!activeDoc || !_sameId(activeDoc.id, doc.id)) return { success: false, error: _err('DOCUMENT_CHANGED', 'Photoshop 当前文档已变化，请重新验证选区') };
  var probe = d.probeId && _selectionProbes[String(d.probeId)];
  if (!probe || !_sameId(probe.docId, doc.id) || Date.now() - probe.createdAt > 30 * 1000) {
    return { success: false, error: _err('SELECTION_PROBE_REQUIRED', '缺少刚刚由 Photoshop 验证过的选区结果') };
  }
  delete _selectionProbes[String(d.probeId)];
  var ap = await _readAutopilot();
  var allowed = (ap && ap.models && Array.isArray(ap.models.allowed)) ? ap.models.allowed : [];
  var modelRule = null;
  for (var i = 0; i < allowed.length; i++) {
    if (allowed[i] && allowed[i].allowed === true && String(allowed[i].provider) === String(d.provider) && String(allowed[i].model) === String(d.model)) { modelRule = allowed[i]; break; }
  }
  if (!modelRule) return { success: false, error: _err('MODEL_NOT_ALLOWED', '模型不在明确授权白名单中') };
  if (!Array.isArray(modelRule.allowedSizes) || modelRule.allowedSizes.indexOf(d.size) < 0) return { success: false, error: _err('SIZE_NOT_ALLOWED', '分辨率不在模型授权范围内') };
  if (!Array.isArray(modelRule.allowedAspectRatios) || modelRule.allowedAspectRatios.indexOf(d.aspectRatio) < 0) return { success: false, error: _err('ASPECT_NOT_ALLOWED', '画幅比例不在模型授权范围内') };
  var batch = Number(d.batch), maxBatch = Number(modelRule.maxBatch);
  if (!isFinite(batch) || Math.floor(batch) !== batch || batch < 1 || !isFinite(maxBatch) || Math.floor(maxBatch) !== maxBatch || maxBatch < 1 || batch > maxBatch) {
    return { success: false, error: _err('BATCH_NOT_ALLOWED', '生成张数超过模型授权上限') };
  }
  var requiresSquare = modelRule.requireSquareSelection === true || !!(ap.models && ap.models.requireSquareSelection === true);
  if (requiresSquare && probe.isSquare !== true) {
    return { success: false, error: _err('SQUARE_SELECTION_REQUIRED', '该模型只允许使用正方形选区') };
  }
  if (d.autoReturn === true && (!ap.permissions || ap.permissions.allowAutoReturn !== true)) return { success: false, error: _err('NOT_ALLOWED', '没有明确授权自动传回') };
  if (d.continueNextRegion === true && (!ap.permissions || ap.permissions.allowContinueNextRegion !== true)) return { success: false, error: _err('NOT_ALLOWED', '没有明确授权继续处理下一个区域') };
  var baseline = await _ensureBaselineForDocument(doc);
  if (!baseline || !baseline.success) return baseline || { success: false, error: _err('BASELINE_CAPTURE_FAILED', '无法建立图层保护基线') };
  _cleanupRunAuthorizations();
  var authorizationId = 'run_auth_' + Date.now() + '_' + (++_runAuthorizationSeq) + '_' + Math.random().toString(36).slice(2, 10);
  var authorization = {
    authorizationId: authorizationId, taskId: taskId, docId: doc.id, createdAt: Date.now(),
    provider: d.provider == null ? '' : String(d.provider),
    model: d.model == null ? '' : String(d.model), size: d.size || '',
    aspectRatio: d.aspectRatio || '', batch: batch,
    selectionBounds: probe.selectionBounds ? {
      left: Number(probe.selectionBounds.left), top: Number(probe.selectionBounds.top),
      right: Number(probe.selectionBounds.right), bottom: Number(probe.selectionBounds.bottom),
      width: Number(probe.selectionBounds.width), height: Number(probe.selectionBounds.height)
    } : null,
    requiresSquare: requiresSquare,
    autoReturn: d.autoReturn === true,
    continueNextRegion: d.continueNextRegion === true
  };
  if (_isRunCancelled(taskId)) return { success: false, error: _err('RUN_AUTHORIZATION_CANCELLED', '这次自动化生成已经取消') };
  _runAuthorizations[authorizationId] = authorization;
  return { success: true, data: {
    authorizationId: authorizationId, taskId: taskId, docId: doc.id,
    expiresAt: authorization.createdAt + RUN_AUTH_TTL_MS,
    baselineCapturedAt: baseline.data && baseline.data.capturedAt
  } };
}

async function _consumeRunAuthorization(d) {
  d = d || {};
  var deny = await _authDeny('allowGenerate');
  if (deny) return { success: false, error: deny };
  _cleanupRunAuthorizations();
  var authorizationId = d.authorizationId == null ? '' : String(d.authorizationId);
  var authorization = authorizationId && _runAuthorizations[authorizationId];
  if (!authorization) return { success: false, error: _err('RUN_AUTHORIZATION_INVALID', '生成授权不存在、已使用或已过期') };
  delete _runAuthorizations[authorizationId];
  var taskId = d.taskId == null ? '' : String(d.taskId);
  if (!taskId || taskId !== authorization.taskId) return { success: false, error: _err('RUN_AUTHORIZATION_MISMATCH', '生成任务 ID 与一次性授权不一致') };
  if (_isRunCancelled(taskId)) return { success: false, error: _err('RUN_AUTHORIZATION_CANCELLED', '这次自动化生成已经取消') };
  if (Date.now() - authorization.createdAt > RUN_AUTH_TTL_MS) return { success: false, error: _err('RUN_AUTHORIZATION_EXPIRED', '生成授权已过期，请重新发起') };
  if (!_sameId(d.docId, authorization.docId)) return { success: false, error: _err('DOCUMENT_MISMATCH', '生成文档与一次性授权不一致') };
  if (String(d.engine || 'api') !== 'api' || String(d.provider || '') !== authorization.provider ||
      String(d.model || '') !== authorization.model || String(d.size || '') !== authorization.size ||
      String(d.aspectRatio || '') !== authorization.aspectRatio || Number(d.batch) !== authorization.batch ||
      (d.autoReturn === true) !== authorization.autoReturn ||
      (d.continueNextRegion === true) !== authorization.continueNextRegion) {
    return { success: false, error: _err('RUN_AUTHORIZATION_MISMATCH', '实际生成参数与一次性授权不一致') };
  }
  var doc = _findDocumentById(authorization.docId);
  if (!doc) return { success: false, error: _err('DOCUMENT_NOT_FOUND', '生成任务对应的 Photoshop 文档已关闭或不存在') };
  var activeDoc = null;
  try { activeDoc = app.activeDocument; } catch (_) {}
  if (!activeDoc || !_sameId(activeDoc.id, authorization.docId)) {
    return { success: false, error: _err('DOCUMENT_CHANGED', '生成前 Photoshop 当前文档已变化，请重新发起') };
  }
  if (_trustedTasks[taskId]) return { success: false, error: _err('TASK_ID_ALREADY_USED', '这个任务 ID 已经使用过') };
  var task = {
    taskId: taskId, docId: doc.id, registeredAt: Date.now(),
    provider: authorization.provider, model: authorization.model,
    size: authorization.size, aspectRatio: authorization.aspectRatio,
    selectionBounds: authorization.selectionBounds,
    batch: authorization.batch, requiresSquare: authorization.requiresSquare === true,
    source: 'automation-run'
  };
  _trustedTasks[taskId] = task;
  return { success: true, data: task };
}

async function _registerGeneratedLayers(d) {
  d = d || {};
  var taskId = d.taskId == null ? '' : String(d.taskId);
  var task = _trustedTasks[taskId];
  if (!task) return { success: false, error: _err('UNTRUSTED_TASK', '这不是本次自动化启动并确认过的生成任务') };
  if (!_sameId(task.docId, d.docId)) return { success: false, error: _err('DOCUMENT_MISMATCH', '候选图层所属文档和生成任务不一致') };
  var doc = _findDocumentById(task.docId);
  if (!doc) return { success: false, error: _err('DOCUMENT_NOT_FOUND', '生成任务对应的 Photoshop 文档已关闭或不存在') };
  var layerIds = Array.isArray(d.layerIds) ? d.layerIds : [];
  if (!layerIds.length) return { success: false, error: _err('BAD_ARGS', '没有可登记的候选图层') };
  var registeredLayers = [], registeredGroups = [], missing = [];
  for (var i = 0; i < layerIds.length; i++) {
    var layerId = layerIds[i];
    var rec = _findLayerRecordInDoc(doc, layerId);
    if (!rec) { missing.push(layerId); continue; }
    var entry = _registryEntryFromLayer(doc, task, rec, 'automation-return');
    _rememberEntry(entry);
    registeredLayers.push(entry.layerId);
    if (rec.parent && rec.parent.kind === 'group') {
      var groupEntry = _registryEntryFromLayer(doc, task, { layer: rec.parent, parent: null }, 'automation-return-parent');
      _rememberEntry(groupEntry);
      if (!registeredGroups.some(function(x) { return _sameId(x, groupEntry.layerId); })) registeredGroups.push(groupEntry.layerId);
    }
  }
  if (!registeredLayers.length) return { success: false, error: _err('LAYER_NOT_FOUND', '候选图层在指定 Photoshop 文档中都不存在'), data: { missing: missing } };
  await _saveTrustedRegistry();
  return { success: true, data: { taskId: taskId, docId: doc.id, layerIds: registeredLayers, groupIds: registeredGroups, missing: missing } };
}

async function _probeSelectionPolicy() {
  var doc = app.activeDocument;
  if (!doc) return { success: false, error: _err('NO_ACTIVE_DOCUMENT', '没有打开的文档') };
  var bounds = await _readSelectionBoundsInModal();
  if (!bounds) return { success: false, error: _err('NO_SELECTION', '当前没有有效选区') };
  var tolerance = Math.max(1, Math.round(Math.max(bounds.width, bounds.height) * 0.002));
  var probeId = 'sel_' + Date.now() + '_' + (++_selectionProbeSeq);
  _selectionProbes[probeId] = { docId: doc.id, selectionBounds: bounds, isSquare: Math.abs(bounds.width - bounds.height) <= tolerance, createdAt: Date.now() };
  Object.keys(_selectionProbes).forEach(function(k) { if (Date.now() - _selectionProbes[k].createdAt > 60 * 1000) delete _selectionProbes[k]; });
  return { success: true, data: {
    probeId: probeId,
    docId: doc.id, selectionBounds: bounds,
    isSquare: Math.abs(bounds.width - bounds.height) <= tolerance,
    aspectRatio: bounds.width + ':' + bounds.height
  } };
}

// 生成 Codex 启动上下文(.md 给人/Codex 读, .json 给机器), 写到 wheelchair_ipc/
function _buildActivationMd(ctx) {
  var ap = ctx.autopilot || {};
  var task = ap.task || {}, perms = ap.permissions || {}, models = (ap.models && ap.models.allowed) || [];
  var L = [];
  L.push('# Codex 全自动修图 · 启动上下文');
  L.push('> 新 Codex 读这份就知道:能干啥、不能碰啥、用哪些模型、怎么调插件。生成时间(ms): ' + ctx.generatedAt);
  L.push('');
  L.push('## IPC 通道');
  L.push('- 目录: `' + ctx.ipcDir + '`');
  L.push('- 发命令: 写 `automation_command.json` = `{reqId, ts, action, data}`');
  L.push('- 读结果: 优先 `auto_out/<reqId>.result.json`(无竞争), 回退 `automation_result.json` = `{reqId, ts, success, data, error}`');
  L.push('- 任务进度: 读 `state.json`');
  L.push('');
  L.push('## 当前任务');
  L.push('- 目标: ' + (task.description || '(未填)'));
  L.push('- 注意事项: ' + (task.notes || '(未填)'));
  L.push('- 允许处理项: ' + ((task.allowedItems || []).join(', ') || '(无)'));
  L.push('- 禁止处理项: ' + ((task.blockedItems || []).join(', ') || '(无)'));
  L.push('');
  L.push('## 权限(全自动)');
  Object.keys(perms).forEach(function(k) { L.push('- ' + k + ': ' + perms[k]); });
  L.push('- 总开关 enabled: ' + ap.enabled + ' / paused: ' + ap.paused);
  L.push('');
  L.push('## 允许的模型/分辨率(白名单, 越权直接拒绝)');
  if (!models.length) L.push('- (未配置：拒绝生成，必须先明确勾选允许的模型)');
  models.forEach(function(m) { L.push('- ' + m.provider + ' / ' + m.model + ' · 尺寸[' + (m.allowedSizes || []).join(',') + '] · 默认' + m.defaultSize + ' · maxBatch ' + m.maxBatch + ' · 正方形=' + m.requireSquareSelection + ' · 可自动选=' + m.allowCodexAutoSelect); });
  L.push('- 香蕉/Gemini 类: 一律正方形选区');
  L.push('');
  L.push('## 图层安全');
  if (ctx.baseline) L.push('- baseline 已记录: ' + ctx.baseline.protectedLayerCount + ' 层 / ' + ctx.baseline.protectedGroupCount + ' 组 受保护(不可删/合并/拼平)');
  else L.push('- baseline 未记录: 先调 captureCodexBaseline');
  L.push('- Codex 只能删自己建且登记(createdBy:codex)且不在 baseline 的图层(safeDeleteGeneratedLayer)');
  L.push('- 失败候选默认隐藏不删; 不覆盖保存; 不合并; 不破坏原结构');
  L.push('');
  L.push('## 出错回滚');
  L.push('- 关键步骤前 checkpoint{label}; 出错 rollback{checkpointId}');
  L.push('');
  L.push('## 全自动流程');
  (ctx.workflow || []).forEach(function(s, i) { L.push((i + 1) + '. ' + s); });
  return L.join('\n');
}
async function _cmdGenerateActivationContext() {
  var ap = await _readAutopilot() || {};
  var baseline = _baselineState;
  var ipc = await _getIpcFolder();
  var ipcPath = (ipc.nativePath || '');
  var ctx = {
    generatedAt: Date.now(),
    ipcDir: ipcPath,
    protocol: { commandFile: 'automation_command.json', resultFile: 'automation_result.json', perReqResult: 'auto_out/<reqId>.result.json', stateFile: 'state.json' },
    autopilot: ap,
    baseline: baseline ? { docId: baseline.docId, protectedLayerCount: (baseline.protectedLayerIds || []).length, protectedGroupCount: (baseline.protectedGroupIds || []).length, capturedAt: baseline.capturedAt } : null,
    workflow: [
      '读取当前文档和图层(getPsContext/getLayerStack)', '导出当前画面预览(exportCompositePreview)',
      '按任务目标分析要处理的区域', '为每个区域建正方形选区(makeSquareSelection)或多边形/贝塞尔',
      '切文本模式+写提示词(ensurePromptTextMode/setPromptText)', '设授权模型和分辨率(setParams)',
      'checkpoint{label} 再生成(runGenerate)', '查任务(getTaskStatus)+拿候选(getReturnedCandidates)',
      '逐张 solo+合成预览(soloCandidate/exportCompositePreview)', '选最佳候选(selectCandidate)',
      '重置组蒙版(resetGroupMask)', '精准选区+羽化写蒙版(fillGroupMaskRegion)',
      '导蒙版/合成预览检查', '失败则 rollback 重试', '继续下一区域', '全部完成停在当前状态, 不覆盖保存'
    ]
  };
  await _writeJson('codex_activation_context.json', ctx);
  var md = _buildActivationMd(ctx);
  var f = await ipc.createFile('codex_activation_context.md', { overwrite: true });
  await f.write(md);
  return { success: true, data: { jsonPath: ipcPath + '/codex_activation_context.json', mdPath: ipcPath + '/codex_activation_context.md' } };
}
async function _cmdGetActivationContext() {
  var j = await _readJson('codex_activation_context.json');
  return { success: true, data: j || { generated: false, note: '先调 generateCodexActivationContext' } };
}

async function _runHostCommand(action, data, reqId) {
  switch (action) {
    case 'pingHost':
      return { success: true, data: { pong: 'host', echo: (data && data.echo) || null, ts: Date.now() } };
    case 'getPsContext':            return await _cmdGetPsContext();
    case 'getLayerStack':           return await _cmdGetLayerStack();
    case 'makeSquareSelection':     return await _cmdMakeSquareSelection(data || {});
    case 'exportCompositePreview':  return await _cmdExportCompositePreview(data || {}, reqId);
    case 'gotoGroupMask':           return await _cmdGotoGroupMask(data || {});
    case 'getMaskState':            return await _cmdGetMaskState(data || {});
    case 'resetGroupMask':          return await _cmdResetGroupMask(data || {});
    case 'fillGroupMaskRegion':     return await _cmdFillGroupMaskRegion(data || {});
    case 'selectionOps':            return await _cmdSelectionOps(data || {});
    case 'createPolygonSelection':  return await _polyOrBezier(data || {}, false);
    case 'createBezierSelection':   return await _polyOrBezier(data || {}, true);
    case 'exportMaskPreview':       return await _cmdExportMaskPreview(data || {}, reqId);
    case 'getLayerParentGroup':     return await _cmdGetLayerParentGroup(data || {});
    case 'listDocuments':           return await _cmdListDocuments();
    case 'activateDocument':        return await _cmdActivateDocument(data || {});
    case 'captureCodexBaseline':    return await _cmdCaptureCodexBaseline();
    case 'getCodexBaseline':        return await _cmdGetCodexBaseline();
    case 'validateLayerMutation':   return await _cmdValidateLayerMutation(data || {});
    case 'tagLayerMetadata':        return await _cmdTagLayerMetadata(data || {});
    case 'safeDeleteGeneratedLayer':return await _cmdSafeDeleteGeneratedLayer(data || {});
    case 'checkpoint':              return await _cmdCheckpoint(data || {});
    case 'rollback':                return await _cmdRollback(data || {});
    case 'safeDeleteGeneratedGroupIfEmpty': return await _cmdSafeDeleteGeneratedGroupIfEmpty(data || {});
    case 'generateCodexActivationContext':  return await _cmdGenerateActivationContext();
    case 'getCodexActivationContext':       return await _cmdGetActivationContext();
    default:
      return { success: false, error: _err('UNKNOWN_ACTION', '未知 host 命令: ' + action) };
  }
}

async function _executeHostCommand(action, data, reqId) {
  if (!PS_LOCKED_ACTIONS[action]) return await _runHostCommand(action, data, reqId);
  if (typeof _acquirePSLock !== 'function') return { success: false, error: _err('PS_LOCK_UNAVAILABLE', 'Photoshop 全局操作锁还没有就绪') };
  return await _acquirePSLock(function() { return _runHostCommand(action, data, reqId); }, 'automation:' + reqId);
}

function _rememberCommand(reqId) {
  var key = String(reqId);
  if (_seenCommandKeys[key]) return false;
  _seenCommandKeys[key] = Date.now();
  _seenCommandOrder.push(key);
  while (_seenCommandOrder.length > SEEN_COMMAND_MAX) delete _seenCommandKeys[_seenCommandOrder.shift()];
  return true;
}

function _invokePanelCommand(cmd) {
  return new Promise(function(resolve) {
    if (!_sendToPanel) { resolve({ success: false, error: _err('PANEL_NOT_READY', '面板未就绪，无法处理面板命令') }); return; }
    var key = String(cmd.reqId);
    var timer = setTimeout(function() {
      if (!_panelPending[key]) return;
      delete _panelPending[key];
      resolve({ success: false, error: _err('PANEL_TIMEOUT', '面板命令等待超时') });
    }, PANEL_COMMAND_TIMEOUT_MS);
    _panelPending[key] = { resolve: resolve, timer: timer };
    try { _sendToPanel('autoCommand', { reqId: cmd.reqId, action: cmd.action, data: cmd.data }); }
    catch (e) {
      clearTimeout(timer);
      delete _panelPending[key];
      resolve({ success: false, error: _err('PANEL_SEND_FAILED', (e && e.message) || String(e)) });
    }
  });
}

async function _runQueuedCommand(cmd) {
  var denied = await _authorizeAction(cmd.action);
  if (denied) { await _writeResult(cmd.reqId, false, null, denied); return; }
  try {
    var result = PANEL_ACTIONS[cmd.action]
      ? await _invokePanelCommand(cmd)
      : await _executeHostCommand(cmd.action, cmd.data, cmd.reqId);
    result = result || {};
    await _writeResult(cmd.reqId, !!result.success, result.data, result.error);
  } catch (e) {
    await _writeResult(cmd.reqId, false, null, _err('INTERNAL', (e && e.message) || String(e)));
  }
}

async function _drainCommandQueue() {
  if (_drainingCommands) return;
  _drainingCommands = true;
  try {
    while (_commandQueue.length) await _runQueuedCommand(_commandQueue.shift());
  } finally {
    _drainingCommands = false;
    if (_commandQueue.length) _drainCommandQueue().catch(function() {});
  }
}

async function _claimCommandFile() {
  var ipc = await _getIpcFolder();
  var file;
  try { file = await ipc.getEntry(CMD_FILE); } catch (_) { return null; }
  var claimName = CMD_CLAIM_PREFIX + Date.now() + '.' + (++_commandSeq) + '.json';
  try { await file.rename(claimName); return file; }
  catch (e) {
    try { console.warn('[automation] 命令文件认领失败: ' + ((e && e.message) || e)); } catch (_) {}
    return null;
  }
}

// 先把单槽命令文件原子改名认领，再快速入内存队列；长命令不会阻塞继续认领下一条。
async function _poll() {
  if (_polling) return;
  _polling = true;
  var file = null;
  try {
    file = await _claimCommandFile();
    if (!file) return;
    var text = await file.read();
    if (!text || text === '{}' || !text.trim()) return;
    var cmd;
    try { cmd = JSON.parse(text); }
    catch (parseErr) { try { console.warn('[automation] 命令 JSON 无效，已丢弃已认领文件'); } catch (_) {} return; }
    var reqId = (cmd && cmd.reqId != null) ? cmd.reqId : (cmd && cmd.data && cmd.data.reqId);
    if (!cmd || !cmd.action || reqId == null || String(reqId) === '') {
      await _writeResult(reqId || null, false, null, _err('BAD_COMMAND', '命令必须包含 action 和非空 reqId'));
      return;
    }
    _lastActiveAt = Date.now();
    if (!_rememberCommand(reqId)) return;
    _commandQueue.push({ reqId: String(reqId), action: String(cmd.action), data: (cmd.data && typeof cmd.data === 'object') ? cmd.data : {}, ts: cmd.ts || null });
    _drainCommandQueue().catch(function(e) { try { console.warn('[automation] 命令队列异常: ' + e.message); } catch (_) {} });
  } catch (e) {
    try { console.warn('[automation] poll 异常: ' + e.message); } catch (_) {}
  } finally {
    if (file) { try { await file.delete(); } catch (_) {} }
    _polling = false;
  }
}

// ============================================================
//  autoBootstrap — 面板加载后调一次, 借 ctx 拿 sendToPanel + 启动自轮询
// ============================================================
HostAPI.registerAction('autoBootstrap', async function(data, ctx) {
  try {
    if (ctx && ctx.sendToPanel) _sendToPanel = ctx.sendToPanel;
    if (ctx && typeof ctx.acquirePSLock === 'function') _acquirePSLock = ctx.acquirePSLock;
    if (data && Object.prototype.hasOwnProperty.call(data, 'profile')) {
      _autopilotProfile = (data.profile && typeof data.profile === 'object') ? data.profile : null;
      await _writeJson('codex_autopilot.json', _autopilotProfile || {});
    } else if (_autopilotProfile === undefined) {
      await _readAutopilot();
    }
    try { await _autoCaptureBaselineForCurrentDocument(ctx); }
    catch (baselineErr) { try { console.warn('[automation] 自动记录 baseline 失败: ' + ((baselineErr && baselineErr.message) || baselineErr)); } catch (_) {} }
    if (!_started) {
      _started = true;
      await _getIpcFolder();
      await _ensureOutDir();
      _cleanupOutDir(true).catch(function() {});
      // 自适应轮询: 活跃 50ms / 闲置 500ms
      (function _schedulePoll() {
        setTimeout(async function() {
          try { await _poll(); } catch (_) {}
          _schedulePoll();
        }, (Date.now() - _lastActiveAt < POLL_FAST_WINDOW_MS) ? POLL_MS : POLL_IDLE_MS);
      })();
      try { console.log('[automation] 已启动自适应轮询 (活跃' + POLL_MS + 'ms/闲置' + POLL_IDLE_MS + 'ms)'); } catch (_) {}
    }
    if (ctx && ctx.sendToPanel) ctx.sendToPanel('autoReady', { ok: true });
  } catch (e) {
    try { console.warn('[automation] bootstrap 失败: ' + e.message); } catch (_) {}
  }
  return true;
}, { tileId: 'automation' });

// ============================================================
//  autoWriteResult — 面板处理完面板类命令后回调, 由 host 写 result
//  data: { reqId, success, data, error }
// ============================================================
HostAPI.registerAction('autoWriteResult', async function(data, ctx) {
  var key = data && data.reqId != null ? String(data.reqId) : '';
  var pending = key && _panelPending[key];
  if (!pending) return true;
  clearTimeout(pending.timer);
  delete _panelPending[key];
  pending.resolve({ success: !!data.success, data: data.data, error: data.error || null });
  return true;
}, { tileId: 'automation' });

// Codex 磁贴保存授权档案时, 写一份到 wheelchair_ipc/codex_autopilot.json(供 host 命令做权限校验)
HostAPI.registerAction('ipcWriteCodexProfile', async function(data, ctx) {
  var profile = (data && data.profile) || data;
  _autopilotProfile = (profile && typeof profile === 'object') ? profile : null;
  await _writeJson('codex_autopilot.json', _autopilotProfile || {});
  try { await _autoCaptureBaselineForCurrentDocument(ctx); }
  catch (baselineErr) { try { console.warn('[automation] 保存配置后自动记录 baseline 失败: ' + ((baselineErr && baselineErr.message) || baselineErr)); } catch (_) {} }
  return true;
}, { tileId: 'automation' });

HostAPI.registerAction('autoProbeSelectionPolicy', async function(data, ctx) {
  var reqId = data && data.reqId;
  var result;
  try {
    if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop 全局操作锁不可用');
    result = await ctx.acquirePSLock(function() {
      return core.executeAsModal(function() { return _probeSelectionPolicy(); }, { commandName: 'Codex 验证自动化选区' });
    }, 'automation:probe:' + reqId);
  } catch (e) { result = { success: false, error: _err('SELECTION_PROBE_FAILED', (e && e.message) || String(e)) }; }
  ctx.sendToPanel('autoProbeSelectionPolicyResult', { reqId: reqId, success: !!result.success, data: result.data || null, error: result.error || null });
  return true;
}, { tileId: 'automation' });

HostAPI.registerAction('autoAuthorizeCodexRun', async function(data, ctx) {
  var result;
  try {
    if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop 全局操作锁不可用');
    result = await ctx.acquirePSLock(function() { return _authorizeAutomationRun(data || {}); }, 'automation:authorize-run:' + (data && data.reqId));
  }
  catch (e) { result = { success: false, error: _err('RUN_AUTHORIZATION_FAILED', (e && e.message) || String(e)) }; }
  ctx.sendToPanel('autoAuthorizeCodexRunResult', { reqId: data && data.reqId, success: !!result.success, data: result.data || null, error: result.error || null });
  return true;
}, { tileId: 'automation' });

HostAPI.registerAction('autoCancelCodexRun', async function(data) {
  _cancelAutomationRun(data || {});
  return true;
}, { tileId: 'automation' });

HostAPI.registerAction('autoRegisterCodexGeneratedLayers', async function(data, ctx) {
  var result;
  try {
    if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop 全局操作锁不可用');
    result = await ctx.acquirePSLock(function() { return _registerGeneratedLayers(data || {}); }, 'automation:register-layers:' + (data && data.reqId));
  }
  catch (e) { result = { success: false, error: _err('LAYER_REGISTER_FAILED', (e && e.message) || String(e)) }; }
  ctx.sendToPanel('autoRegisterCodexGeneratedLayersResult', { reqId: data && data.reqId, success: !!result.success, data: result.data || null, error: result.error || null });
  return true;
}, { tileId: 'automation' });

module.exports = {
  consumeRunAuthorization: _consumeRunAuthorization,
  cancelRunAuthorization: _cancelAutomationRun,
  isRunCancelled: _isRunCancelled,
  revokeTrustedTask: _revokeTrustedTask
};
