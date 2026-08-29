// ============================================================
//  tile-codex.js — Codex 全自动修图(授权 / 白名单 / 安全 / 启动上下文)
//
//  作用: 把「用户意图 + 模型权限 + 安全边界 + 修图注意事项 + Codex 启动记忆」
//  合成一份「全自动任务配置」(codex.autopilot)。Codex 读它就知道能干啥、不能碰啥,
//  不再反复询问。配置经自动化 API(tile-automation) 供 Codex 读取/校验。
//
//  阶段1: 区1/2/3 + 自由文本 可编辑可保存; 区4/5/6 先信息展示, 动作(记 baseline /
//  生成启动上下文 / 权限焊接)在后续阶段接入。
// ============================================================
(function() {
'use strict';

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- 权限开关(区1)----
var PERMS = [
  { key: 'allowGenerate',           label: '允许自动生成' },
  { key: 'allowAutoReturn',         label: '允许自动传回' },
  { key: 'allowAutoSelectCandidate',label: '允许自动挑选最佳候选' },
  { key: 'allowMaskWrite',          label: '允许自动写组蒙版' },
  { key: 'allowRollbackRetry',      label: '允许自动回滚重试' },
  { key: 'allowContinueNextRegion', label: '允许继续处理下一个区域' },
  { key: 'allowDeleteGeneratedOnly',label: '允许删除本轮生成的隐藏候选', off: true } // 默认关
];
// 始终强制为 false 的硬边界(不在 UI 给开关, 只读展示)
var HARD_OFF = ['allowDeleteBaselineLayers', 'allowOverwriteSave', 'allowFlatten'];

// ---- 修图项目(区2)----
var ITEMS = [
  { key: 'retouchFace',   label: '修脸' },
  { key: 'removeHair',    label: '去头发' },
  { key: 'retouchNeck',   label: '修脖子' },
  { key: 'retouchSkin',   label: '修皮肤' },
  { key: 'retouchHand',   label: '修手' },
  { key: 'retouchClothes',label: '修衣服' },
  { key: 'cleanBackground',label: '清理背景' },
  { key: 'removeClutter', label: '去杂物' },
  { key: 'localPaint',    label: '局部补画' },
  { key: 'changeMaterial',label: '局部换材质' },
  { key: 'unifyLight',    label: '统一光影' },
  { key: 'other',         label: '其它' }
];

var WORKFLOW_STEPS = [
  '读取当前文档和图层', '导出当前画面预览', '按任务目标分析要处理的区域',
  '为每个区域生成正方形选区', '选预设或写新提示词', '选授权模型和分辨率',
  '生成指定 batch', '自动传回并编组', '逐张 solo 候选 + 导真实合成预览',
  '自动选最佳候选', '隐藏其它候选', '重置组蒙版',
  '多边形/贝塞尔/羽化选区精准写蒙版', '导合成预览 + 蒙版预览',
  '检查硬边/错位/方形边缘/误伤', '失败则 rollback 重试',
  '继续下一个区域', '全部完成停在当前状态, 不覆盖保存'
];

// ---- 默认配置 ----
function _defaultProfile() {
  var perms = {};
  PERMS.forEach(function(p) { perms[p.key] = !p.off; });        // 除删除候选外默认开
  HARD_OFF.forEach(function(k) { perms[k] = false; });
  return {
    enabled: false,   // 总开关默认关, 用户配置好再开
    paused: false,
    permissions: perms,
    task: { allowedItems: [], blockedItems: [], description: '', notes: '' },
    models: { allowed: [], requireSquareSelection: true },
    safety: { protectBaselineLayers: true, baselineLayerIds: [], baselineGroupIds: [] }
  };
}

function _loadProfile() {
  var p = TileAPI.storage.get('codex.autopilot');
  if (!p || typeof p !== 'object') return _defaultProfile();
  var def = _defaultProfile();
  // 浅合并, 保证新加的字段有默认
  p.permissions = Object.assign({}, def.permissions, p.permissions || {});
  HARD_OFF.forEach(function(k) { p.permissions[k] = false; }); // 硬边界永远 false
  p.task = Object.assign({}, def.task, p.task || {});
  p.models = Object.assign({}, def.models, p.models || {});
  p.safety = Object.assign({}, def.safety, p.safety || {});
  if (typeof p.enabled !== 'boolean') p.enabled = false;
  if (typeof p.paused !== 'boolean') p.paused = false;
  return p;
}

// ---- 读插件现有模型(白名单数据源)----
function _allEngineModels() {
  var out = [];
  var order = (TileAPI.slotOrder ? TileAPI.slotOrder() : ['aji', 'grs', 'others']);
  var engLabel = { aji: 'AJI', grs: 'GRS', others: '自定义渠道' };
  order.forEach(function(eng) {
    var cfg = TileAPI.state.get('models.' + eng) || {};
    Object.keys(cfg).forEach(function(id) {
      out.push({
        provider: eng,
        engLabel: (TileAPI.slotLabel ? TileAPI.slotLabel(eng, engLabel[eng] || eng) : (engLabel[eng] || eng)),
        model: id,
        name: (cfg[id] && cfg[id].name) || id,
        sizes: (cfg[id] && cfg[id].sizes) || ['1K', '2K', '4K']
      });
    });
  });
  return out;
}
function _mkey(provider, model) { return provider + '|' + model; }
// 把已存的模型白名单转成 map
function _modelMap(profile) {
  var m = {};
  ((profile.models && profile.models.allowed) || []).forEach(function(it) {
    if (it && it.provider && it.model) m[_mkey(it.provider, it.model)] = it;
  });
  return m;
}

// ============================================================
//  渲染
// ============================================================
function renderFront(container, w, h) {
  if (w >= 2) {
    container.innerHTML =
      '<div class="tile-icon">🤖</div>' +
      '<div class="tile-label">Codex 全自动修图</div>' +
      '<div class="tile-desc">授权 · 白名单 · 安全</div>';
  } else {
    container.innerHTML = '<div class="tile-icon">🤖</div><div class="tile-label">Codex</div>';
  }
}

function onExpand(container) {
  var _p = _loadProfile();
  var _modelDraft = _modelMap(_p);   // 编辑中的模型白名单草稿

  function _permRows() {
    return PERMS.map(function(p) {
      var on = _p.permissions[p.key] !== false ? (_p.permissions[p.key] === true) : false;
      // 注意: off 项默认 false, 其它默认 true
      on = (_p.permissions[p.key] === true);
      return '<div class="cx-row"><span class="cx-row-label">' + _esc(p.label) + '</span>' +
        '<div class="w10-toggle' + (on ? ' on' : '') + '" data-perm="' + p.key + '"></div></div>';
    }).join('');
  }

  function _itemRows() {
    return ITEMS.map(function(it) {
      var allowed = _p.task.allowedItems.indexOf(it.key) >= 0;
      // 三态简化为两态: 允许 / 禁止
      return '<div class="cx-item' + (allowed ? ' is-allow' : ' is-block') + '" data-item="' + it.key + '">' +
        '<span class="cx-item-name">' + _esc(it.label) + '</span>' +
        '<span class="cx-item-state">' + (allowed ? '允许' : '禁止') + '</span>' +
      '</div>';
    }).join('');
  }

  function _modelRows() {
    var list = _allEngineModels();
    if (!list.length) return '<div class="cx-empty">没读到模型(先在主参数/算力配置里配置好)</div>';
    return list.map(function(mm) {
      var k = _mkey(mm.provider, mm.model);
      var saved = _modelDraft[k] || {};
      var allowed = saved.allowed === true;
      var maxBatch = saved.maxBatch || 4;
      var reqSq = saved.requireSquareSelection !== false; // 默认正方形
      var autoSel = saved.allowCodexAutoSelect !== false; // 默认可自动选
      var allowedSizes = saved.allowedSizes || mm.sizes.slice(0, 1); // 默认第一个尺寸
      var sizeChips = mm.sizes.map(function(s) {
        var on = allowedSizes.indexOf(s) >= 0;
        return '<span class="cx-size-chip' + (on ? ' on' : '') + '" data-msize="' + k + '" data-sz="' + s + '">' + s + '</span>';
      }).join('');
      return '<div class="cx-model" data-model="' + _esc(k) + '" data-provider="' + mm.provider + '" data-mid="' + _esc(mm.model) + '">' +
        '<label class="cx-model-head">' +
          '<input type="checkbox" class="cx-model-chk" data-mallow="1"' + (allowed ? ' checked' : '') + '>' +
          '<span class="cx-model-name">' + _esc(mm.name) + '</span>' +
          '<span class="cx-model-eng">' + _esc(mm.engLabel) + '</span>' +
        '</label>' +
        '<div class="cx-model-body"' + (allowed ? '' : ' style="display:none"') + '>' +
          '<div class="cx-model-line"><span class="cx-mini-label">分辨率</span><span class="cx-sizes">' + sizeChips + '</span></div>' +
          '<div class="cx-model-line">' +
            '<span class="cx-mini-label">最大batch</span><input class="w10-input cx-batch" type="number" min="1" max="9" value="' + maxBatch + '" data-mbatch="1">' +
            '<label class="cx-mini-tog"><input type="checkbox" data-msq="1"' + (reqSq ? ' checked' : '') + '> 强制正方形</label>' +
            '<label class="cx-mini-tog"><input type="checkbox" data-mauto="1"' + (autoSel ? ' checked' : '') + '> 允许Codex自动选</label>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function _renderAll() {
    container.innerHTML =
      '<div class="w10-panel cx-panel">' +

        '<div class="w10-section-title">① 全自动开关</div>' +
        '<div class="cx-row cx-row-master"><span class="cx-row-label"><b>启用 Codex 全自动接管</b></span>' +
          '<div class="w10-toggle' + (_p.enabled ? ' on' : '') + '" id="cxEnabled"></div></div>' +
        '<div class="cx-row cx-row-master"><span class="cx-row-label">暂停自动化(临时停)</span>' +
          '<div class="w10-toggle' + (_p.paused ? ' on' : '') + '" id="cxPaused"></div></div>' +
        '<div class="cx-sub">具体授权:</div>' +
        _permRows() +
        '<div class="cx-hardoff">硬边界(永远禁止,不可开):不删原图层 · 不覆盖保存 · 不合并图层</div>' +

        '<div class="w10-section-title">② 修图项目授权</div>' +
        '<div class="cx-hint">点一下在「允许 / 禁止」之间切换。Codex 只会自动处理「允许」的项。</div>' +
        '<div class="cx-items">' + _itemRows() + '</div>' +
        '<div class="cx-field"><label class="cx-flabel">当前任务目标</label>' +
          '<textarea class="cx-textarea" id="cxDesc" placeholder="例:移除模特全部头发,保留脸、耳朵、脖子,不改变身份。">' + _esc(_p.task.description) + '</textarea></div>' +
        '<div class="cx-field"><label class="cx-flabel">注意事项(审美/安全)</label>' +
          '<textarea class="cx-textarea" id="cxNotes" placeholder="例:不要改变五官,不要塑料皮肤,不要正方形硬边,不要误伤衣服和背景。">' + _esc(_p.task.notes) + '</textarea></div>' +

        '<div class="w10-section-title">③ 模型 / 分辨率白名单</div>' +
        '<div class="cx-hint">勾选允许 Codex 使用的模型。Codex 请求未授权模型/分辨率时,自动化 API 直接拒绝。</div>' +
        '<div class="cx-models">' + _modelRows() + '</div>' +

        '<div class="w10-section-title">④ 图层保护(baseline)</div>' +
        '<div class="cx-info">开启接管并保存时会自动记录当前所有图层为 <b>baseline</b>。规则:baseline 图层/组<b>不可删</b>;Codex 只能删自己新建且带 <code>createdBy:codex</code> 标记、且不在 baseline 里的图层;失败候选默认隐藏不删。</div>' +

        '<div class="w10-section-title">⑤ 全自动工作流</div>' +
        '<ol class="cx-flow">' + WORKFLOW_STEPS.map(function(s) { return '<li>' + _esc(s) + '</li>'; }).join('') + '</ol>' +

        '<div class="w10-section-title">⑥ Codex 启动上下文</div>' +
        '<div class="cx-info">把上面的配置 + IPC 路径 + 自动化协议 合成启动说明,让新 Codex 一读就懂、不用反复问。<br><span class="cx-todo">(生成 .md/.json 文件在后续阶段接入)</span></div>' +
        '<div class="cx-row" style="gap:6px;flex-wrap:wrap;margin-top:6px">' +
          '<button class="w10-btn" id="cxPreview">预览配置 JSON</button>' +
        '</div>' +
        '<div id="cxPreviewBox" class="cx-preview" style="display:none"></div>' +

        '<div class="cx-actions">' +
          '<button class="w10-btn" id="cxReset">恢复默认</button>' +
          '<button class="w10-btn w10-btn-accent" id="cxSave">保存配置</button>' +
        '</div>' +
      '</div>';
    _bind();
  }

  // 从 DOM 收集成 profile
  function _collect() {
    var p = _defaultProfile();
    p.enabled = container.querySelector('#cxEnabled').classList.contains('on');
    p.paused = container.querySelector('#cxPaused').classList.contains('on');
    container.querySelectorAll('[data-perm]').forEach(function(t) {
      p.permissions[t.getAttribute('data-perm')] = t.classList.contains('on');
    });
    HARD_OFF.forEach(function(k) { p.permissions[k] = false; });
    // 修图项
    var allowed = [], blocked = [];
    container.querySelectorAll('[data-item]').forEach(function(el) {
      var key = el.getAttribute('data-item');
      if (el.classList.contains('is-allow')) allowed.push(key); else blocked.push(key);
    });
    p.task.allowedItems = allowed;
    p.task.blockedItems = blocked;
    p.task.description = (container.querySelector('#cxDesc').value || '').trim();
    p.task.notes = (container.querySelector('#cxNotes').value || '').trim();
    // 模型白名单
    var models = [];
    container.querySelectorAll('.cx-model').forEach(function(el) {
      var provider = el.getAttribute('data-provider');
      var model = el.getAttribute('data-mid');
      var allow = el.querySelector('[data-mallow]');
      if (!allow || !allow.checked) return; // 只存允许的
      var sizes = [];
      el.querySelectorAll('.cx-size-chip.on').forEach(function(c) { sizes.push(c.getAttribute('data-sz')); });
      var batchEl = el.querySelector('[data-mbatch]');
      var maxBatch = Math.max(1, Math.min(9, +(batchEl && batchEl.value) || 4));
      var sqEl = el.querySelector('[data-msq]');
      var autoEl = el.querySelector('[data-mauto]');
      models.push({
        provider: provider, model: model, allowed: true,
        allowedSizes: sizes.length ? sizes : [],
        allowedAspectRatios: ['1:1'],
        defaultSize: sizes[0] || '',
        defaultBatch: Math.min(maxBatch, 4),
        maxBatch: maxBatch,
        allowCodexAutoSelect: !!(autoEl && autoEl.checked),
        requireSquareSelection: !!(sqEl && sqEl.checked)
      });
    });
    p.models.allowed = models;
    p.models.requireSquareSelection = true;
    // 保留 safety 里已记的 baseline
    p.safety = _p.safety || p.safety;
    return p;
  }

  function _bind() {
    // 区1 toggles
    ['cxEnabled', 'cxPaused'].forEach(function(id) {
      var t = container.querySelector('#' + id);
      if (t) t.onclick = function() { t.classList.toggle('on'); };
    });
    container.querySelectorAll('[data-perm]').forEach(function(t) {
      t.onclick = function() { t.classList.toggle('on'); };
    });
    // 区2 修图项 允许/禁止 切换
    container.querySelectorAll('[data-item]').forEach(function(el) {
      el.onclick = function() {
        var allow = el.classList.toggle('is-allow');
        el.classList.toggle('is-block', !allow);
        var st = el.querySelector('.cx-item-state');
        if (st) st.textContent = allow ? '允许' : '禁止';
      };
    });
    // 区3 模型: 勾选展开 body
    container.querySelectorAll('[data-mallow]').forEach(function(chk) {
      chk.onchange = function() {
        var body = chk.closest('.cx-model').querySelector('.cx-model-body');
        if (body) body.style.display = chk.checked ? '' : 'none';
      };
    });
    // 尺寸 chip 多选
    container.querySelectorAll('.cx-size-chip').forEach(function(c) {
      c.onclick = function() { c.classList.toggle('on'); };
    });
    // 预览 JSON
    var pv = container.querySelector('#cxPreview');
    if (pv) pv.onclick = function() {
      var box = container.querySelector('#cxPreviewBox');
      if (!box) return;
      if (box.style.display === 'none') {
        box.textContent = JSON.stringify({ codexAutopilot: _collect() }, null, 2);
        box.style.display = 'block';
        pv.textContent = '收起预览';
      } else { box.style.display = 'none'; pv.textContent = '预览配置 JSON'; }
    };
    // 保存
    var save = container.querySelector('#cxSave');
    if (save) save.onclick = function() {
      _p = _collect();
      TileAPI.storage.set('codex.autopilot', _p);
      try { TileAPI.sendToHost('ipcWriteCodexProfile', { profile: _p }); } catch (e) {}   // 推到 IPC 供自动化 host 命令校验
      TileAPI.toast('✓ Codex 全自动配置已保存', 'success');
    };
    // 恢复默认
    var reset = container.querySelector('#cxReset');
    if (reset) reset.onclick = function() {
      TileAPI.confirm('恢复 Codex 全自动配置到默认?(不影响已记录的 baseline)').then(function(ok) {
        if (!ok) return;
        var keepSafety = _p.safety;
        _p = _defaultProfile();
        _p.safety = keepSafety || _p.safety;
        _modelDraft = {};
        _renderAll();
        TileAPI.toast('已恢复默认,记得点保存', 'info');
      });
    };
  }

  _renderAll();
  return function() {};
}

TileAPI.registerTile({
  id: 'codex',
  icon: '🤖',
  label: 'Codex 全自动修图',
  desc: '授权 / 白名单 / 安全 / 启动上下文',
  group: 'main',
  defaultSize: { w: 2, h: 2 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 4 },
  renderFront: renderFront,
  onExpand: onExpand
});

})();
