(function() {
'use strict';

var _balanceAutoTimer = null;
var _settingsRequestSeq = 0;
var _openActionsPending = Object.create(null);
var _clearCachePending = Object.create(null);
var _clearCacheBusy = false;
var OPEN_ACTIONS_TIMEOUT_MS = 30000;
var CLEAR_CACHE_TIMEOUT_MS = 180000;
function _settingsReqId(prefix) { return prefix + '_' + Date.now() + '_' + (++_settingsRequestSeq); }
function _trackSettingsRequest(map, reqId, timeoutMs, onTimeout) {
  var timer = setTimeout(function() {
    if (!map[reqId]) return;
    delete map[reqId];
    if (onTimeout) onTimeout();
  }, timeoutMs);
  map[reqId] = { timer: timer };
}
function _takeSettingsRequest(map, reqId) {
  var pending = reqId && map[reqId];
  if (!pending) return null;
  delete map[reqId];
  if (pending.timer) clearTimeout(pending.timer);
  return pending;
}
function _hasRunningTasks() {
  var running = TileAPI.state.get('tasks.running') || {};
  return Object.keys(running).length > 0;
}
function _startBalanceAutoRefresh() {
  if (_balanceAutoTimer) clearInterval(_balanceAutoTimer);
  _balanceAutoTimer = setInterval(function() {
    var p = TileAPI.getProvider ? TileAPI.getProvider() : (TileAPI.state.get('params.provider') || TileAPI.storage.get('params.provider') || TileAPI.storage.get('connection.provider') || 'aji');
    if (p !== 'aji') return;
    var url = TileAPI.storage.get('connection.aji.url');
    var key = TileAPI.storage.get('connection.aji.key');
    if (url && key) TileAPI.sendToHost('calibrateBalance', { apiKey: key, apiBaseUrl: url, silent: true });
  }, 30000);
}
function _stopBalanceAutoRefresh() {
  if (_balanceAutoTimer) { clearInterval(_balanceAutoTimer); _balanceAutoTimer = null; }
}

// ============================================================
//  设置面板分类 (⑧) —— 纯后处理, 不动 innerHTML, 删掉 _applySettingsCategories
//  调用即可整体退回原平铺结构。把 13 个小节归到 4 个可折叠大类。
// ============================================================
var _SETTINGS_CAT_DEF = [
  { key: 'conn',  name: '生成 · 输出', titles: ['输出设置', '传回羽化', 'GPT-Image 高级设置'] },
  { key: 'ui',    name: '外观 · 交互', titles: ['外观', '音效', '快捷键'] },
  { key: 'tools', name: '工具 · 信息', titles: ['余额追踪', '预设', '图片缓存', '公告'] },
  { key: 'sys',   name: '隐私 · 调试', titles: ['用户改进计划', '调试'] }
];

function _injectSettingsCatCss() {
  if (document.getElementById('settings-cat-css')) return;
  var st = document.createElement('style');
  st.id = 'settings-cat-css';
  // 视觉沿用 dev 的 .preset-group-header/body 风格(无外框, 底部细分割线, accent 11px UPPERCASE)。
  // 动画用 JS 测的 scrollHeight 跑 max-height — 不用 2000px 这种"反正足够大"的写法,
  // 否则内容只有 ~200px 时实际可见过渡只有几十毫秒, 体感就是"啪一下", 不流畅。
  st.textContent = [
    '.settings-cat{margin-bottom:4px}',
    '.settings-cat-header{',
      'display:flex;align-items:center;gap:6px;',
      'padding:8px 4px;cursor:pointer;user-select:none;',
      'border-bottom:1px solid rgba(255,255,255,0.06);',
      'transition:background 0.15s;',
    '}',
    '.settings-cat-header:hover{background:rgba(255,255,255,0.03)}',
    '.settings-cat-arrow{',
      'font-size:10px;color:var(--text-sub);',
      'transition:transform 0.22s cubic-bezier(.4,0,.2,1);display:inline-block;width:10px;text-align:center;',
    '}',
    '.settings-cat.collapsed .settings-cat-arrow{transform:rotate(-90deg)}',
    '.settings-cat-name{',
      'font-size:11px;color:var(--accent);font-weight:600;flex:1;',
      'text-transform:uppercase;letter-spacing:0.5px;',
    '}',
    '.settings-cat-body{',
      'padding-left:4px;overflow:hidden;',
      // 双过渡: max-height(布局) + opacity(视觉), 用同一条缓动,体感才"协调"
      'transition:max-height 0.28s cubic-bezier(.4,0,.2,1),opacity 0.2s ease;',
      'opacity:1;',
    '}',
    '.settings-cat-body.collapsed{opacity:0;pointer-events:none}',
    // 大类内部不需要重复醒目的小标题, 降级为次要颜色 / 去掉下划线
    '.settings-cat-body .w10-section-title{',
      'font-size:10px;color:var(--text-sub);',
      'border-bottom:none;margin-top:12px;margin-bottom:4px;padding-bottom:0;',
    '}',
    '.settings-cat-body .w10-section-title:first-child{margin-top:6px}'
  ].join('');
  document.head.appendChild(st);
}

function _toggleSettingsCat(catEl, body, collapse) {
  // 清掉上一次 transitionend 监听, 避免快速折/展时把已折叠的又放开
  if (body._catDone) {
    try { body.removeEventListener('transitionend', body._catDone); } catch(e) {}
    body._catDone = null;
  }
  if (collapse) {
    // 折叠:从当前真实高度精确跑到 0,体感跟其他 0.28s 过渡一致
    body.style.maxHeight = body.scrollHeight + 'px';
    void body.offsetHeight;  // 强制 reflow, 给 0 一个明确起点
    body.style.maxHeight = '0px';
    body.classList.add('collapsed');
    catEl.classList.add('collapsed');
  } else {
    catEl.classList.remove('collapsed');
    body.classList.remove('collapsed');
    body.style.maxHeight = body.scrollHeight + 'px';
    var done = function(e) {
      if (e && e.propertyName && e.propertyName !== 'max-height') return;
      // 展开后放开 max-height, 让内部 provider 切换变高不会被裁
      body.style.maxHeight = 'none';
      try { body.removeEventListener('transitionend', done); } catch(_) {}
      body._catDone = null;
    };
    body._catDone = done;
    body.addEventListener('transitionend', done);
  }
}

function _applySettingsCategories(container) {
  var panel = container.querySelector('.w10-panel');
  if (!panel || panel.dataset.categorized === '1') return;
  _injectSettingsCatCss();

  // 1. 按 .w10-section-title 把直系子节点切成若干小节
  var kids = Array.prototype.slice.call(panel.children);
  var sections = [], cur = null;
  kids.forEach(function(node) {
    if (node.classList && node.classList.contains('w10-section-title')) {
      cur = { title: (node.textContent || '').trim(), nodes: [node] };
      sections.push(cur);
    } else if (cur) {
      cur.nodes.push(node);
    }
  });

  var title2cat = {};
  _SETTINGS_CAT_DEF.forEach(function(c) {
    c.titles.forEach(function(t) { title2cat[t] = c.key; });
  });

  // 2. 建 4 个分类外壳
  var collapsedState = TileAPI.storage.get('settings.catCollapsed') || {};
  var catEls = {};
  _SETTINGS_CAT_DEF.forEach(function(c) {
    var catEl = document.createElement('div');
    catEl.className = 'settings-cat';
    catEl.dataset.cat = c.key;
    var header = document.createElement('div');
    header.className = 'settings-cat-header';
    header.innerHTML = '<span class="settings-cat-arrow">▾</span><span class="settings-cat-name">' + c.name + '</span>';
    var body = document.createElement('div');
    body.className = 'settings-cat-body';
    catEl.appendChild(header);
    catEl.appendChild(body);
    catEls[c.key] = { el: catEl, inner: body, body: body };

    (function(key) {
      header.addEventListener('click', function() {
        var willCollapse = !catEl.classList.contains('collapsed');
        _toggleSettingsCat(catEl, body, willCollapse);
        var s = TileAPI.storage.get('settings.catCollapsed') || {};
        s[key] = willCollapse;
        TileAPI.storage.set('settings.catCollapsed', s);
      });
    })(c.key);
  });

  // 3. 小节搬进对应分类 (未知标题兜底进第一类, 绝不丢内容)
  sections.forEach(function(sec) {
    var key = title2cat[sec.title] || _SETTINGS_CAT_DEF[0].key;
    var target = catEls[key].inner;
    sec.nodes.forEach(function(n) { target.appendChild(n); });
  });

  // 4. 分类外壳按定义顺序加回面板 + 应用初始折叠态 (collapsed 时手动钉 max-height:0)
  _SETTINGS_CAT_DEF.forEach(function(c) {
    var entry = catEls[c.key];
    panel.appendChild(entry.el);
    if (collapsedState[c.key]) {
      entry.el.classList.add('collapsed');
      entry.body.classList.add('collapsed');
      entry.body.style.maxHeight = '0px';
    }
  });

  panel.dataset.categorized = '1';
}

TileAPI.registerTile({
  id: 'settings',
  label: '设置',
  icon: '⚙️',
  desc: '连接配置 / 输出设置 / 外观',
  defaultSize: { w: 2, h: 2 },

  onExpand: function(container) {
    var annHtml = TileAPI.state.get('announcement.html') || '';
    var provider = TileAPI.storage.get('connection.provider') || 'aji';
    var themeColor = TileAPI.storage.get('appearance.themeColor') || '#0078d4';
    var textMode = TileAPI.storage.get('appearance.textMode') || 'auto';

    // --- Others multi-config migration: ensure configs array exists ---
    var _othersConfigs = TileAPI.storage.get('connection.others.configs');
    if (!_othersConfigs || !_othersConfigs.length) {
      var _oldUrl = TileAPI.storage.get('connection.others.url') || '';
      var _oldKey = TileAPI.storage.get('connection.others.key') || '';
      // 老用户首次升级:把 models.others.cache 也搬进默认配置
      var _legacyModels = TileAPI.storage.get('models.others.cache') || {};
      _othersConfigs = [{ name: '默认', url: _oldUrl, key: _oldKey, isActive: true, models: _legacyModels }];
      TileAPI.storage.set('connection.others.configs', _othersConfigs);
    } else {
      // 给老配置补 models 字段(本次升级新增)
      var _migrated = false;
      for (var _mi = 0; _mi < _othersConfigs.length; _mi++) {
        if (!_othersConfigs[_mi].models) { _othersConfigs[_mi].models = {}; _migrated = true; }
      }
      if (_migrated) TileAPI.storage.set('connection.others.configs', _othersConfigs);
    }
    var _activeOthersCfg = null;
    for (var _ci = 0; _ci < _othersConfigs.length; _ci++) {
      if (_othersConfigs[_ci].isActive) { _activeOthersCfg = _othersConfigs[_ci]; break; }
    }
    if (!_activeOthersCfg && _othersConfigs.length) _activeOthersCfg = _othersConfigs[0];
    // Sync flat keys so _fetchOthersModels etc. read the right values
    if (_activeOthersCfg) {
      TileAPI.storage.set('connection.others.url', _activeOthersCfg.url || '');
      TileAPI.storage.set('connection.others.key', _activeOthersCfg.key || '');
      // 同步活跃配置的模型缓存到 state(供 params 磁贴使用)
      var _activeModels = _activeOthersCfg.models || {};
      TileAPI.state.set('models.others', _activeModels);
      TileAPI.storage.set('models.others.cache', _activeModels);
    }

    container.innerHTML =
      '<div class="w10-panel">' +

      // ===== 1. 输出设置 =====
      '<div class="w10-section-title">输出设置</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">图层类型</div></div>' +
        '<div class="w10-row-right">' +
          '<button class="w10-btn' + (TileAPI.storage.get('output.layerType') !== 'pixel' ? ' w10-btn-accent' : '') + '" data-layertype="smartObject">智能对象</button>' +
          '<button class="w10-btn' + (TileAPI.storage.get('output.layerType') === 'pixel' ? ' w10-btn-accent' : '') + '" data-layertype="pixel">普通图层</button>' +
        '</div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">最大分辨率</div></div>' +
        '<div class="w10-row-right"><div class="w10-slider">' +
          '<input type="range" id="inpMaxRes" min="512" max="4096" step="128" value="' + (TileAPI.storage.get('output.maxResolution') || 2048) + '">' +
          '<span class="w10-slider-val" id="inpMaxResVal">' + (TileAPI.storage.get('output.maxResolution') || 2048) + '</span>' +
        '</div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">色彩稳定模式</div><div class="w10-row-desc">抓图转 sRGB、回传标记 sRGB、修正16/32位偏色,避免广色域文档进出偏色(开启后看日志自检结果)</div></div>' +
        '<div class="w10-row-right"><div class="w10-toggle' + (TileAPI.storage.get('output.colorStable') === true ? ' on' : '') + '" id="togColorStable"></div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">自动编组</div><div class="w10-row-desc">自动将相同提示词的图层归组</div></div>' +
        '<div class="w10-row-right"><div class="w10-toggle' + (TileAPI.storage.get('output.autoGroup') !== false ? ' on' : '') + '" id="togAutoGroup"></div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">自动返回</div><div class="w10-row-desc">生成后自动将图像传回到 Photoshop</div></div>' +
        '<div class="w10-row-right"><div class="w10-toggle' + (TileAPI.storage.get('output.autoReturn') !== false ? ' on' : '') + '" id="togAutoReturn"></div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">⚡急速回图 (试验)</div><div class="w10-row-desc">批量贴回改为一次性完成: 快 3~4 倍, 撤销时一步撤整批。试运行期默认关, 遇到贴回异常请关掉并反馈</div></div>' +
        '<div class="w10-row-right"><div class="w10-toggle' + (TileAPI.storage.get('output.fastReturn') === true ? ' on' : '') + '" id="togFastReturn"></div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">无选区自动全图</div><div class="w10-row-desc">点开始时若没有选区,自动用整张画布作为选区(默认关:必须先建选区)</div></div>' +
        '<div class="w10-row-right"><div class="w10-toggle' + (TileAPI.storage.get('selection.autoFullCanvasNoSelection') === true ? ' on' : '') + '" id="togAutoFullCanvas"></div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">自动扩充+裁切</div><div class="w10-row-desc">生图比例选 1:1 而选区不是方形时: 自动补纯白凑成方形送 AI, 回图自动裁掉白边贴回 — 免去手动扩画布/居中/裁切 (仅 1:1 触发)</div></div>' +
        '<div class="w10-row-right"><div class="w10-toggle' + (TileAPI.storage.get('output.autoPadCrop') === true ? ' on' : '') + '" id="togAutoPadCrop"></div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">同步 PS 选框比例</div><div class="w10-row-desc">选生图比例时, PS 矩形选框工具样式自动跟着切 (需先建"修图轮椅_xxx"工具预设)</div></div>' +
        '<div class="w10-row-right"><div class="w10-toggle' + (TileAPI.storage.get('params.syncMarqueeAspect') !== false ? ' on' : '') + '" id="togSyncMarquee"></div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">教学模式</div><div class="w10-row-desc">每次生成时,在图层组里附加一个"教学资料"子组(隐藏文字说明 + 隐藏参考图),用于把 PSD 发给学生</div></div>' +
        '<div class="w10-row-right"><div class="w10-toggle' + (TileAPI.storage.get('teachMode.enabled') === true ? ' on' : '') + '" id="togTeachMode"></div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">滚轮调参</div><div class="w10-row-desc">允许鼠标滚轮在数值控件(张数/超时/各类滑块)上微调数值(默认关:防止滚动页面时误触改参数)</div></div>' +
        '<div class="w10-row-right"><div class="w10-toggle' + (TileAPI.storage.get('params.wheelEnabled') === true ? ' on' : '') + '" id="togWheelParam"></div></div>' +
      '</div>' +

      // ===== 3. 传回羽化 =====
      '<div class="w10-section-title">传回羽化</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">启用羽化</div><div class="w10-row-desc">回传时对边缘进行羽化处理</div></div>' +
        '<div class="w10-row-right"><div class="w10-toggle' + (TileAPI.storage.get('output.returnFeather.enabled') === true ? ' on' : '') + '" id="togRfEnabled"></div></div>' +
      '</div>' +
      '<div id="rfDetailsArea" class="w10-details-anim' + (TileAPI.storage.get('output.returnFeather.enabled') === true ? '' : ' w10-details-hidden') + '">' +
        '<div class="w10-row" style="flex-direction:column;align-items:stretch;gap:6px;">' +
          '<div class="w10-row-left" style="flex:0 0 auto;"><div class="w10-row-label">启用工作流</div><div class="w10-row-desc">选择哪些工作流应用羽化</div></div>' +
          '<div class="w10-row-right" style="flex-wrap:wrap;justify-content:flex-start;margin-left:0;gap:6px;">' +
            '<button class="w10-btn' + ((TileAPI.storage.get('output.returnFeather.workflows') || {}).bananaSingle ? ' w10-btn-accent' : '') + '" data-rfwf="bananaSingle">Banana单图</button>' +
            '<button class="w10-btn' + ((TileAPI.storage.get('output.returnFeather.workflows') || {}).bananaBatch ? ' w10-btn-accent' : '') + '" data-rfwf="bananaBatch">Banana批量</button>' +
            '<button class="w10-btn' + ((TileAPI.storage.get('output.returnFeather.workflows') || {}).tiledUpscale ? ' w10-btn-accent' : '') + '" data-rfwf="tiledUpscale">分区放大</button>' +
            '<button class="w10-btn' + ((TileAPI.storage.get('output.returnFeather.workflows') || {}).forge ? ' w10-btn-accent' : '') + '" data-rfwf="forge">Forge</button>' +
            '<button class="w10-btn' + ((TileAPI.storage.get('output.returnFeather.workflows') || {}).comfyui ? ' w10-btn-accent' : '') + '" data-rfwf="comfyui">ComfyUI</button>' +
          '</div>' +
        '</div>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">收缩值</div></div>' +
          '<div class="w10-row-right"><div class="w10-slider">' +
            '<input type="range" id="rfShrink" min="0" max="50" value="' + (TileAPI.storage.get('output.returnFeather.shrinkPercent') || 2) + '">' +
            '<span class="w10-slider-val" id="rfShrinkVal">' + (TileAPI.storage.get('output.returnFeather.shrinkPercent') || 2) + '</span>' +
          '</div></div>' +
        '</div>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">模糊值</div></div>' +
          '<div class="w10-row-right"><div class="w10-slider">' +
            '<input type="range" id="rfBlur" min="0" max="50" value="' + (TileAPI.storage.get('output.returnFeather.blurPercent') || 3) + '">' +
            '<span class="w10-slider-val" id="rfBlurVal">' + (TileAPI.storage.get('output.returnFeather.blurPercent') || 3) + '</span>' +
          '</div></div>' +
        '</div>' +
      '</div>' +

      // ===== 3.5 GPT-Image 高级设置 =====
      '<div class="w10-section-title">GPT-Image 高级设置</div>' +
      '<div class="w10-row-desc" style="padding:0 0 6px;color:var(--text-sub);font-size:11px;">仅对 AJI 流的 GPT-Image 模型生效;GRS 流的 GPT-Image-2 不支持这些参数,会被忽略。</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">画质 quality</div><div class="w10-row-desc">越高越贵越慢</div></div>' +
        '<div class="w10-row-right"><select class="w10-select" id="gptImgQuality" style="width:140px">' +
          ['auto','high','medium','low'].map(function(v) {
            var cur = TileAPI.storage.get('gptImage.quality') || 'auto';
            return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + v + '</option>';
          }).join('') +
        '</select></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">背景 background</div><div class="w10-row-desc">transparent=自动抠图(仅 png/webp)</div></div>' +
        '<div class="w10-row-right"><select class="w10-select" id="gptImgBackground" style="width:140px">' +
          ['auto','transparent','opaque'].map(function(v) {
            var cur = TileAPI.storage.get('gptImage.background') || 'auto';
            return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + v + '</option>';
          }).join('') +
        '</select></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">输出格式 output_format</div><div class="w10-row-desc">jpeg 不支持透明</div></div>' +
        '<div class="w10-row-right"><select class="w10-select" id="gptImgFormat" style="width:140px">' +
          ['png','jpeg','webp'].map(function(v) {
            var cur = TileAPI.storage.get('gptImage.outputFormat') || 'png';
            return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + v + '</option>';
          }).join('') +
        '</select></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">参考强度 input_fidelity</div><div class="w10-row-desc">auto=默认(部分模型仅支持 auto), high=严格还原, low=大幅创作</div></div>' +
        '<div class="w10-row-right"><select class="w10-select" id="gptImgFidelity" style="width:140px">' +
          ['auto','high','low'].map(function(v) {
            var cur = TileAPI.storage.get('gptImage.inputFidelity') || 'auto';
            return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + v + '</option>';
          }).join('') +
        '</select></div>' +
      '</div>' +

      // ===== 4. 音效 =====
      '<div class="w10-section-title">音效</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">启用音效</div></div>' +
        '<div class="w10-row-right"><div class="w10-toggle' + (TileAPI.storage.get('sound.enabled') === true ? ' on' : '') + '" id="togSound"></div></div>' +
      '</div>' +
      '<div id="soundDetailsArea" class="w10-details-anim' + (TileAPI.storage.get('sound.enabled') === true ? '' : ' w10-details-hidden') + '">' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">成功音效</div></div>' +
          '<div class="w10-row-right"><select class="w10-select" id="selSoundSuccess"></select></div>' +
        '</div>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">全部失败音效</div></div>' +
          '<div class="w10-row-right"><select class="w10-select" id="selSoundAllFail"></select></div>' +
        '</div>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">单个失败音效</div></div>' +
          '<div class="w10-row-right"><select class="w10-select" id="selSoundSingleFail"></select></div>' +
        '</div>' +
      '</div>' +

      // ===== 5. 余额追踪 =====
      '<div class="w10-section-title balance-section">余额追踪</div>' +
      '<div class="w10-row balance-section">' +
        '<div class="w10-row-left"><div class="w10-row-label">启用余额追踪</div><div class="w10-row-desc">余额低于阈值时发出告警</div></div>' +
        '<div class="w10-row-right"><div class="w10-toggle' + (TileAPI.storage.get('balance.enabled') === true ? ' on' : '') + '" id="togBalance"></div></div>' +
      '</div>' +
      '<div id="balDetailsArea" class="balance-section w10-details-anim' + (TileAPI.storage.get('balance.enabled') === true ? '' : ' w10-details-hidden') + '">' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label" id="balDisplay">' + (TileAPI.state.get('balance.current') !== null && TileAPI.state.get('balance.current') !== undefined ? '$' + TileAPI.state.get('balance.current').toFixed(4) : '未查询') + '</div></div>' +
          '<div class="w10-row-right">' +
            '<button class="w10-btn" id="btnCalibrate">校准</button>' +
            '<button class="w10-btn" id="btnCheckBal">查询</button>' +
          '</div>' +
        '</div>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">AJI 阈值</div><div class="w10-row-desc">单位 USD,余额低于此值告警</div></div>' +
          '<div class="w10-row-right"><span style="margin-right:4px;color:var(--text-sub);">$</span><input type="number" class="w10-input" id="inpBalThresholdAji" min="0" step="0.01" value="' + (TileAPI.storage.get('balance.threshold.aji') || TileAPI.storage.get('balance.threshold') || 0.5) + '" style="width:80px"></div>' +
        '</div>' +
        '<div class="w10-row">' +
          '<div class="w10-row-left"><div class="w10-row-label">GRS 阈值</div><div class="w10-row-desc">单位 积分,积分低于此值告警</div></div>' +
          '<div class="w10-row-right"><input type="number" class="w10-input" id="inpBalThresholdGrs" min="0" step="1" value="' + (TileAPI.storage.get('balance.threshold.grs') || 100) + '" style="width:80px"><span style="margin-left:4px;color:var(--text-sub);">pts</span></div>' +
        '</div>' +
      '</div>' +

      // ===== 6. 外观 =====
      '<div class="w10-section-title">外观</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">简洁模式</div><div class="w10-row-desc">去除所有彩色,转为 PS 风灰度;图标变纯色剪影</div></div>' +
        '<div class="w10-row-right"><div class="w10-toggle' + (TileAPI.storage.get('appearance.simpleMode') === true ? ' on' : '') + '" id="togSimple"></div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">磁贴翻转动画</div><div class="w10-row-desc">关闭后 live 磁贴不再周期性翻转展示背面</div></div>' +
        '<div class="w10-row-right"><div class="w10-toggle' + (TileAPI.storage.get('appearance.flipEnabled') === true ? ' on' : '') + '" id="togFlip"></div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">Emoji 风格</div><div class="w10-row-desc">界面图标改用 Fluent Emoji，更清晰；原生=系统自带</div></div>' +
        '<div class="w10-row-right">' +
          '<button class="w10-btn' + ((TileAPI.storage.get('appearance.emojiStyle') || 'off') === 'off' ? ' w10-btn-accent' : '') + '" data-emoji-style="off">原生</button>' +
          '<button class="w10-btn' + ((TileAPI.storage.get('appearance.emojiStyle') || 'off') === 'flat' ? ' w10-btn-accent' : '') + '" data-emoji-style="flat">Flat</button>' +
          '<button class="w10-btn' + ((TileAPI.storage.get('appearance.emojiStyle') || 'off') === 'color' ? ' w10-btn-accent' : '') + '" data-emoji-style="color">Color</button>' +
        '</div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">磁贴图标大小</div></div>' +
        '<div class="w10-row-right"><div class="w10-slider"><input type="range" id="tileIconScale" min="60" max="200" step="5" value="' + Math.round((TileAPI.storage.get('appearance.tileIconScale') || 1) * 100) + '"><span class="w10-slider-val" id="tileIconScaleVal">' + Math.round((TileAPI.storage.get('appearance.tileIconScale') || 1) * 100) + '%</span></div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">主题色</div></div>' +
        '<div class="w10-row-right"><div class="w10-colors" id="themeColors">' +
          '<div class="w10-color' + (themeColor === '#0078d4' ? ' active' : '') + '" data-c="#0078d4" style="background:#0078d4"></div>' +
          '<div class="w10-color' + (themeColor === '#107c10' ? ' active' : '') + '" data-c="#107c10" style="background:#107c10"></div>' +
          '<div class="w10-color' + (themeColor === '#d83b01' ? ' active' : '') + '" data-c="#d83b01" style="background:#d83b01"></div>' +
          '<div class="w10-color' + (themeColor === '#b4009e' ? ' active' : '') + '" data-c="#b4009e" style="background:#b4009e"></div>' +
          '<div class="w10-color' + (themeColor === '#e3008c' ? ' active' : '') + '" data-c="#e3008c" style="background:#e3008c"></div>' +
          '<div class="w10-color' + (themeColor === '#ff8c00' ? ' active' : '') + '" data-c="#ff8c00" style="background:#ff8c00"></div>' +
          '<input type="color" id="themeColorPicker" class="w10-color-picker" value="' + themeColor + '" title="自定义颜色（取色）">' +
          '<span class="w10-color-pick-label">自定义</span>' +
        '</div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">模糊</div></div>' +
        '<div class="w10-row-right"><div class="w10-slider">' +
          '<input type="range" id="setBlur" min="0" max="30" value="' + (TileAPI.storage.get('appearance.blur') || 0) + '">' +
          '<span class="w10-slider-val" id="setBlurVal">' + (TileAPI.storage.get('appearance.blur') || 0) + '</span>' +
        '</div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">不透明度</div></div>' +
        '<div class="w10-row-right"><div class="w10-slider">' +
          '<input type="range" id="setOpa" min="0" max="100" value="' + (TileAPI.storage.get('appearance.opacity') || 100) + '">' +
          '<span class="w10-slider-val" id="setOpaVal">' + (TileAPI.storage.get('appearance.opacity') || 100) + '</span>' +
        '</div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">磁贴颜色透明度</div></div>' +
        '<div class="w10-row-right"><div class="w10-slider">' +
          '<input type="range" id="setTco" min="0" max="100" value="' + (TileAPI.storage.get('appearance.tileColorOpacity') || 50) + '">' +
          '<span class="w10-slider-val" id="setTcoVal">' + (TileAPI.storage.get('appearance.tileColorOpacity') || 50) + '</span>' +
        '</div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">缩放</div><div class="w10-row-desc">松开滑块或回车后生效</div></div>' +
        '<div class="w10-row-right"><div class="w10-slider" style="display:flex;align-items:center;gap:8px;">' +
          '<input type="range" id="setScale" min="50" max="300" value="' + (TileAPI.storage.get('appearance.scale') || 100) + '">' +
          '<input type="number" class="w10-input" id="setScaleVal" min="50" max="300" step="5" value="' + (TileAPI.storage.get('appearance.scale') || 100) + '" style="width:60px;text-align:center;padding:2px 4px;">' +
          '<span style="color:var(--text-sub);font-size:11px;">%</span>' +
        '</div></div>' +
      '</div>' +

      // ===== 7. 文字模式 (NEW) =====
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">文字模式</div></div>' +
        '<div class="w10-row-right"><div class="sf-pill" id="textModePill">' +
          '<span class="sf-pill-opt' + (textMode === 'light' ? ' active' : '') + '" data-mode="light">浅色</span>' +
          '<span class="sf-pill-opt' + (textMode === 'dark' ? ' active' : '') + '" data-mode="dark">深色</span>' +
          '<span class="sf-pill-opt' + (textMode === 'auto' ? ' active' : '') + '" data-mode="auto">自动</span>' +
        '</div></div>' +
      '</div>' +

      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">\u80CC\u666F\u56FE\u7247</div></div>' +
        '<div class="w10-row-right">' +
          '<button class="w10-btn" id="setBgImgBtn">\u9009\u62E9\u56FE\u7247</button>' +
          '<button class="w10-btn" id="setClearBgBtn">\u6E05\u9664</button>' +
        '</div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">\u6C34\u5E73\u4F4D\u7F6E</div><div class="w10-row-desc">0=\u6700\u5DE6 / 50=\u5C45\u4E2D / 100=\u6700\u53F3</div></div>' +
        '<div class="w10-row-right"><div class="w10-slider">' +
          '<input type="range" id="setBgPosX" min="0" max="100" value="' + (function() { var v = TileAPI.storage.get('appearance.bgPosX'); return v != null ? v : 50; })() + '">' +
          '<span class="w10-slider-val" id="setBgPosXVal">' + (function() { var v = TileAPI.storage.get('appearance.bgPosX'); return v != null ? v : 50; })() + '</span>' +
        '</div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">\u5782\u76F4\u4F4D\u7F6E</div><div class="w10-row-desc">0=\u6700\u4E0A / 50=\u5C45\u4E2D / 100=\u6700\u4E0B</div></div>' +
        '<div class="w10-row-right"><div class="w10-slider">' +
          '<input type="range" id="setBgPosY" min="0" max="100" value="' + (function() { var v = TileAPI.storage.get('appearance.bgPosY'); return v != null ? v : 50; })() + '">' +
          '<span class="w10-slider-val" id="setBgPosYVal">' + (function() { var v = TileAPI.storage.get('appearance.bgPosY'); return v != null ? v : 50; })() + '</span>' +
        '</div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">\u80CC\u666F\u7F29\u653E</div><div class="w10-row-desc">100=\u5145\u6EE1\u5C4F\u5E55 (\u57FA\u7EBF) / &gt;100=\u653E\u5927\u88C1\u5207 / &lt;100=\u7F29\u5C0F\u770B\u5168\u56FE (\u4F1A\u9732\u8FB9)</div></div>' +
        '<div class="w10-row-right"><div class="w10-slider">' +
          '<input type="range" id="setBgZoom" min="50" max="300" value="' + (function() { var v = TileAPI.storage.get('appearance.bgZoom'); return v != null ? v : 100; })() + '">' +
          '<span class="w10-slider-val" id="setBgZoomVal">' + (function() { var v = TileAPI.storage.get('appearance.bgZoom'); return v != null ? v : 100; })() + '</span>' +
        '</div></div>' +
      '</div>' +

      // ===== 8. 快捷键 (NEW) =====
      '<div class="w10-section-title">\u5FEB\u6377\u952E</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left">' +
          '<div class="w10-row-label">\u63A8\u8350\u901A\u8FC7 Photoshop \u52A8\u4F5C\u9762\u677F\u5F55\u5236\u52A8\u4F5C\u5E76\u7ED1\u5B9A F \u952E</div>' +
          '<div class="w10-row-desc">\u5728\u52A8\u4F5C\u9762\u677F\u4E2D\u5F55\u5236\u8C03\u7528\u672C\u63D2\u4EF6\u7684\u811A\u672C\u547D\u4EE4\u5373\u53EF</div>' +
        '</div>' +
        '<div class="w10-row-right">' +
          '<button class="w10-btn" id="btnOpenActions">\u6253\u5F00\u52A8\u4F5C\u9762\u677F</button>' +
        '</div>' +
      '</div>' +

      // ===== 8.5 \u9884\u8bbe\u6587\u4ef6\u5939 =====
      '<div class="w10-section-title">\u9884\u8BBE</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left">' +
          '<div class="w10-row-label">\u9884\u8BBE\u5B58\u50A8\u4F4D\u7F6E</div>' +
          '<div class="w10-row-desc">\u6253\u5F00\u7CFB\u7EDF\u6587\u4EF6\u7BA1\u7406\u5668\uFF0C\u624B\u52A8\u5907\u4EFD\u3001\u7F16\u8F91\u6216\u590D\u6DD8\u9884\u8BBE\u6587\u4EF6</div>' +
        '</div>' +
        '<div class="w10-row-right">' +
          '<button class="w10-btn" id="btnOpenPresetFolder">\u6253\u5F00\u6587\u4EF6\u5939</button>' +
        '</div>' +
      '</div>' +

      // ===== 9. 公告 (NEW) =====
      '<div class="w10-section-title">\u516C\u544A</div>' +
      '<div class="w10-row" style="flex-direction:column;align-items:stretch;">' +
        '<div class="w10-announce" id="announceArea">' +
          (annHtml ? _sanitizeAnn(annHtml) : '<span style="color:var(--text-sub);font-style:italic;">\u6682\u65E0\u516C\u544A</span>') +
        '</div>' +
        '<div style="margin-top:8px;text-align:right;">' +
          '<button class="w10-btn" id="btnRefreshAnn">\u5237\u65B0</button>' +
        '</div>' +
      '</div>' +

      // ===== 10. 图片缓存 =====
      '<div class="w10-section-title">图片缓存</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">打开缓存文件夹</div><div class="w10-row-desc">查看历次生成的缓存图片</div></div>' +
        '<div class="w10-row-right"><button class="w10-btn" id="btnOpenImageCache">打开</button></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">清空图片缓存</div><div class="w10-row-desc">删除 image_cache 下所有文件</div></div>' +
        '<div class="w10-row-right"><button class="w10-btn" id="btnClearImageCache" style="color:#ff6b6b;border-color:rgba(255,100,100,0.3)">清空</button></div>' +
      '</div>' +

      // ===== 11. 调试 =====
      '<div class="w10-section-title">用户改进计划</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">参加用户改进计划</div><div class="w10-row-desc">匿名上报使用数据帮我们改进插件 (默认关闭, 完全自愿)</div></div>' +
        '<div class="w10-row-right"><div class="w10-toggle' + (TileAPI.storage.get('improvement.optedIn') === true ? ' on' : '') + '" id="togImprovement"></div></div>' +
      '</div>' +
      '<div class="w10-row" id="improvementDeviceIdRow"' + (TileAPI.storage.get('improvement.optedIn') === true ? '' : ' style="display:none"') + '>' +
        '<div class="w10-row-left"><div class="w10-row-label">设备 ID</div><div class="w10-row-desc">本地随机生成, 不绑账号. 重置后服务端把你视作新用户</div></div>' +
        '<div class="w10-row-right" style="display:flex;gap:6px;align-items:center"><span id="improvementDevId" style="font-family:ui-monospace,monospace;font-size:10px;color:var(--text-sub)">' + _esc((TileAPI.storage.get('improvement.deviceId') || '?').slice(0,12) + '...') + '</span><button class="w10-btn" id="setResetDevId" style="font-size:10px">重置</button></div>' +
      '</div>' +

      '<div class="w10-section-title">调试</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">教程调试模式</div><div class="w10-row-desc">开着 = 每次打开插件都自动弹新手教程(审稿/演示用); 关着 = 正常行为(新用户只弹一次)</div></div>' +
        '<div class="w10-row-right"><div class="w10-toggle' + (TileAPI.storage.get('tutorial.debugAlwaysShow') === true ? ' on' : '') + '" id="togTutorialDebug"></div></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">清除所有缓存</div><div class="w10-row-desc">清除布局和设置（Ctrl+Shift+D）</div></div>' +
        '<div class="w10-row-right"><button class="w10-btn" id="setClearCache" style="color:#ff6b6b;border-color:rgba(255,100,100,0.3)">清除并刷新</button></div>' +
      '</div>' +
      '</div>';


    // ⑧ 把平铺小节归到 4 个可折叠大类 (纯后处理, 不动上面的 innerHTML)
    _applySettingsCategories(container);

    // ========== 事件绑定 ==========

    // --- 磁贴翻转动画开关 ---
    var togFlip = container.querySelector('#togFlip');
    if (togFlip) togFlip.addEventListener('click', function() {
      // appearance.flipEnabled 默认 false (不开翻转), 显式 true 才开
      var now = !(TileAPI.storage.get('appearance.flipEnabled') === true);
      TileAPI.storage.set('appearance.flipEnabled', now);
      togFlip.classList.toggle('on', now);
      document.body.classList.toggle('tile-flip-disabled', !now);
    });

    // --- 简洁模式开关 ---
    var togSimple = container.querySelector('#togSimple');
    if (togSimple) togSimple.addEventListener('click', function() {
      var now = !(TileAPI.storage.get('appearance.simpleMode') === true);
      TileAPI.storage.set('appearance.simpleMode', now);
      togSimple.classList.toggle('on', now);
      document.body.classList.toggle('simple-mode', now);
    });

    // --- Emoji 风格 (原生 / Flat / Color) ---
    container.querySelectorAll('[data-emoji-style]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var s = btn.getAttribute('data-emoji-style');
        if (window.EmojiPack) window.EmojiPack.setStyle(s);
        else TileAPI.storage.set('appearance.emojiStyle', s);
        container.querySelectorAll('[data-emoji-style]').forEach(function(b) {
          b.classList.toggle('w10-btn-accent', b === btn);
        });
      });
    });

    // --- 磁贴图标大小 ---
    // v6.4.7 修复: 之前"界面缩放"注入的 ui-scale-style 会用写死的 px 盖掉 --tile-icon-scale,
    // 导致这个滑块看着能拖但磁贴图标纹丝不动; theme-engine 已改为保留缩放因子。
    var iconScaleInp = container.querySelector('#tileIconScale');
    function _commitIconScale(raw) {
      var pct = parseInt(raw, 10) || 100;
      var mult = pct / 100;
      var valSpan = container.querySelector('#tileIconScaleVal');
      if (valSpan) valSpan.textContent = pct + '%';
      TileAPI.storage.set('appearance.tileIconScale', mult);
      if (window.ThemeEngine && ThemeEngine.applyTileIconScale) ThemeEngine.applyTileIconScale(mult);
    }
    if (iconScaleInp) {
      iconScaleInp.addEventListener('input', function() { _commitIconScale(this.value); });
      // UXP webview 的 range 偶发只发 change 不发 input — 双监听兜底
      iconScaleInp.addEventListener('change', function() { _commitIconScale(this.value); });
    }

    // --- 图层类型 ---
    container.querySelectorAll('[data-layertype]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var v = btn.dataset.layertype;
        container.querySelectorAll('[data-layertype]').forEach(function(b) { b.classList.remove('w10-btn-accent'); });
        btn.classList.add('w10-btn-accent');
        TileAPI.storage.set('output.layerType', v);
        _syncSettings();
      });
    });

    // --- 最大分辨率 ---
    var maxResInp = container.querySelector('#inpMaxRes');
    var maxResVal = container.querySelector('#inpMaxResVal');
    if (maxResInp) maxResInp.addEventListener('input', function() {
      var v = +this.value;
      maxResVal.textContent = v;
      TileAPI.storage.set('output.maxResolution', v);
      _syncSettings();
    });

    // --- 色彩稳定模式 ---
    var tcs = container.querySelector('#togColorStable');
    if (tcs) tcs.addEventListener('click', function() {
      var now = !(TileAPI.storage.get('output.colorStable') === true);
      TileAPI.storage.set('output.colorStable', now);
      tcs.classList.toggle('on', now);
      _syncSettings();
    });

    // --- 自动编组 ---
    var tg = container.querySelector('#togAutoGroup');
    if (tg) tg.addEventListener('click', function() {
      var now = !TileAPI.storage.get('output.autoGroup');
      TileAPI.storage.set('output.autoGroup', now);
      tg.classList.toggle('on', now);
      _syncSettings();
      TileAPI.emit('output:autoGroupChanged', { value: now });  // 通知 Dock 刷新高亮
    });

    // --- 急速回图(v6.5.8 试验) ---
    var togFast = container.querySelector('#togFastReturn');
    if (togFast) togFast.addEventListener('click', function() {
      var now = !(TileAPI.storage.get('output.fastReturn') === true);
      TileAPI.storage.set('output.fastReturn', now);
      togFast.classList.toggle('on', now);
      TileAPI.toast('急速回图: ' + (now ? '开(批量单权限)' : '关(经典逐张)'), 'info');
    });

    // --- 自动返回 ---
    var tr = container.querySelector('#togAutoReturn');
    if (tr) tr.addEventListener('click', function() {
      var cur = TileAPI.storage.get('output.autoReturn');
      if (cur === null || cur === undefined) cur = true;
      var now = !cur;
      TileAPI.storage.set('output.autoReturn', now);
      tr.classList.toggle('on', now);
      TileAPI.emit('output:autoReturnChanged', { value: now });  // 通知 Dock 刷新高亮
    });

    // --- 无选区自动全图 ---
    var tafc = container.querySelector('#togAutoFullCanvas');
    if (tafc) tafc.addEventListener('click', function() {
      var now = !(TileAPI.storage.get('selection.autoFullCanvasNoSelection') === true);
      TileAPI.storage.set('selection.autoFullCanvasNoSelection', now);
      tafc.classList.toggle('on', now);
      _syncSettings();
    });

    // --- 自动扩充+裁切 (1:1 生图, 非方形选区自动补白/裁白) ---
    var tapc = container.querySelector('#togAutoPadCrop');
    if (tapc) tapc.addEventListener('click', function() {
      var now = !(TileAPI.storage.get('output.autoPadCrop') === true);
      TileAPI.storage.set('output.autoPadCrop', now);
      tapc.classList.toggle('on', now);
      _syncSettings();
    });

    // (v6.6.0 移除) 4K偏色自动矫正 / 自动校色 两个开关已从设置删除, 功能整体停用;
    // 手动校色(Dock 校色按钮)不受影响照常可用

    // --- 同步 PS 选框比例 ---
    var tsma = container.querySelector('#togSyncMarquee');
    if (tsma) tsma.addEventListener('click', function() {
      var now = !(TileAPI.storage.get('params.syncMarqueeAspect') !== false);
      TileAPI.storage.set('params.syncMarqueeAspect', now);
      tsma.classList.toggle('on', now);
    });

    // --- 教学模式 ---
    var ttm = container.querySelector('#togTeachMode');
    if (ttm) ttm.addEventListener('click', function() {
      var now = !(TileAPI.storage.get('teachMode.enabled') === true);
      TileAPI.storage.set('teachMode.enabled', now);
      ttm.classList.toggle('on', now);
      _syncSettings();
    });

    var twp = container.querySelector('#togWheelParam');
    if (twp) twp.addEventListener('click', function() {
      var now = !(TileAPI.storage.get('params.wheelEnabled') === true);
      TileAPI.storage.set('params.wheelEnabled', now);
      twp.classList.toggle('on', now);
    });

    // ========== 传回羽化 事件 ==========
    var togRf = container.querySelector('#togRfEnabled');
    if (togRf) togRf.addEventListener('click', function() {
      var now = !(TileAPI.storage.get('output.returnFeather.enabled') === true);
      TileAPI.storage.set('output.returnFeather.enabled', now);
      togRf.classList.toggle('on', now);
      var area = container.querySelector('#rfDetailsArea');
      if (area) area.classList.toggle('w10-details-hidden', !now);
      _syncSettings();
    });

    container.querySelectorAll('[data-rfwf]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var key = btn.dataset.rfwf;
        var wf = TileAPI.storage.get('output.returnFeather.workflows') || {};
        wf[key] = !wf[key];
        TileAPI.storage.set('output.returnFeather.workflows', wf);
        btn.classList.toggle('w10-btn-accent', !!wf[key]);
        _syncSettings();
      });
    });

    var rfShrinkInp = container.querySelector('#rfShrink');
    var rfShrinkValEl = container.querySelector('#rfShrinkVal');
    if (rfShrinkInp) rfShrinkInp.addEventListener('input', function() {
      var v = _clampInt(+this.value, 0, 50);
      rfShrinkValEl.textContent = v;
      TileAPI.storage.set('output.returnFeather.shrinkPercent', v);
      _syncSettings();
    });

    var rfBlurInp = container.querySelector('#rfBlur');
    var rfBlurValEl = container.querySelector('#rfBlurVal');
    if (rfBlurInp) rfBlurInp.addEventListener('input', function() {
      var v = _clampInt(+this.value, 0, 50);
      rfBlurValEl.textContent = v;
      TileAPI.storage.set('output.returnFeather.blurPercent', v);
      _syncSettings();
    });

    // ========== GPT-Image 高级设置 事件 ==========
    var _bindGptSelect = function(id, key) {
      var el = container.querySelector('#' + id);
      if (!el) return;
      el.addEventListener('change', function() {
        TileAPI.storage.set(key, this.value);
        // background=transparent + jpeg 互斥提示
        if (id === 'gptImgBackground' || id === 'gptImgFormat') {
          var bg = TileAPI.storage.get('gptImage.background') || 'auto';
          var fmt = TileAPI.storage.get('gptImage.outputFormat') || 'png';
          if (bg === 'transparent' && fmt === 'jpeg') {
            TileAPI.toast('JPEG 不支持透明背景,实际请求时会自动改为 PNG', 'info');
          }
        }
      });
    };
    _bindGptSelect('gptImgQuality', 'gptImage.quality');
    _bindGptSelect('gptImgBackground', 'gptImage.background');
    _bindGptSelect('gptImgFormat', 'gptImage.outputFormat');
    _bindGptSelect('gptImgFidelity', 'gptImage.inputFidelity');

    // ========== 音效 事件 ==========
    var togSnd = container.querySelector('#togSound');
    if (togSnd) togSnd.addEventListener('click', function() {
      var now = !(TileAPI.storage.get('sound.enabled') === true);
      TileAPI.storage.set('sound.enabled', now);
      togSnd.classList.toggle('on', now);
      var area = container.querySelector('#soundDetailsArea');
      if (area) area.classList.toggle('w10-details-hidden', !now);
      _syncSettings();
    });

    // Request sound file list from backend
    TileAPI.sendToHost('scanSoundFiles', {});

    var _soundSelectIds = ['selSoundSuccess', 'selSoundAllFail', 'selSoundSingleFail'];
    var _soundStorageKeys = ['sound.success', 'sound.allFail', 'sound.singleFail'];
    var _soundDefaults = ['\u4E09\u4E03\u5510\u7B11', 'none', 'none'];

    _soundSelectIds.forEach(function(selId, idx) {
      var sel = container.querySelector('#' + selId);
      if (!sel) return;
      sel.addEventListener('change', function() {
        TileAPI.storage.set(_soundStorageKeys[idx], sel.value);
        if (sel.value !== 'none') {
          TileAPI.sendToHost('previewSound', { fileName: sel.value });
        }
        _syncSettings();
      });
    });

    // ========== 余额追踪 事件 ==========
    var togBal = container.querySelector('#togBalance');
    if (togBal) togBal.addEventListener('click', function() {
      var now = !(TileAPI.storage.get('balance.enabled') === true);
      TileAPI.storage.set('balance.enabled', now);
      togBal.classList.toggle('on', now);
      var area = container.querySelector('#balDetailsArea');
      if (area) area.classList.toggle('w10-details-hidden', !now);
      // 启用时启动定期刷新,关闭时停止
      if (now) _startBalanceAutoRefresh();
      else _stopBalanceAutoRefresh();
    });

    var btnCal = container.querySelector('#btnCalibrate');
    if (btnCal) btnCal.addEventListener('click', function() {
      var url = TileAPI.storage.get('connection.aji.url') || '';
      var key = TileAPI.storage.get('connection.aji.key') || '';
      if (!key) { TileAPI.toast('\u8BF7\u5148\u586B\u5165 AJI Key', 'error'); return; }
      if (!url) { TileAPI.toast('\u8BF7\u5148\u5728\u4E0A\u65B9\u70B9"\u6821\u9A8C Key"\u6FC0\u6D3B AJI \u670D\u52A1\u5668', 'error'); return; }
      TileAPI.sendToHost('calibrateBalance', { apiKey: key, apiBaseUrl: url });
      TileAPI.toast('\u6B63\u5728\u67E5\u8BE2\u4F59\u989D...', 'info');
    });

    var btnChk = container.querySelector('#btnCheckBal');
    if (btnChk) btnChk.addEventListener('click', function() {
      var url = TileAPI.storage.get('connection.aji.url') || '';
      var key = TileAPI.storage.get('connection.aji.key') || '';
      if (!key) { TileAPI.toast('\u8BF7\u5148\u586B\u5165 AJI Key', 'error'); return; }
      if (!url) { TileAPI.toast('\u8BF7\u5148\u5728\u4E0A\u65B9\u70B9"\u6821\u9A8C Key"\u6FC0\u6D3B AJI \u670D\u52A1\u5668', 'error'); return; }
      TileAPI.sendToHost('calibrateBalance', { apiKey: key, apiBaseUrl: url });
      TileAPI.toast('\u6B63\u5728\u67E5\u8BE2...', 'info');
    });

    _bindInput(container, 'inpBalThresholdAji', 'balance.threshold.aji');
    _bindInput(container, 'inpBalThresholdGrs', 'balance.threshold.grs');

    // Provider-dependent balance visibility (AJI=$ 阈值, GRS=积分阈值各显各的)
    var _updateBalanceVisibility = function(data) {
      var p = (data && data.provider) || (TileAPI.getProvider ? TileAPI.getProvider() : TileAPI.storage.get('params.provider')) || 'aji';
      var row = container.querySelector('.balance-section');
      if (row) row.style.display = p === 'aji' ? '' : 'none';
    };
    TileAPI.on('settings:providerChanged', _updateBalanceVisibility);

    // ========== 外观 事件 (existing) ==========
    var colors = container.querySelectorAll('.w10-color');
    var colorPicker = container.querySelector('#themeColorPicker');

    function _applyThemeColor(c) {
      if (!c) return;
      c = String(c).toLowerCase();
      TileAPI.storage.set('appearance.themeColor', c);
      ThemeEngine.applyThemeColor(c);
      // 同步选中态: 命中预设则高亮预设, 否则高亮取色标
      var isPreset = false;
      colors.forEach(function(d) {
        var on = (d.dataset.c || '').toLowerCase() === c;
        d.classList.toggle('active', on);
        if (on) isPreset = true;
      });
      if (colorPicker) {
        colorPicker.value = c;
        colorPicker.classList.toggle('active', !isPreset);
      }
    }

    // 初始选中态
    _applyThemeColorInit();
    function _applyThemeColorInit() {
      var cur = (themeColor || '').toLowerCase();
      var isPreset = false;
      colors.forEach(function(d) {
        var on = (d.dataset.c || '').toLowerCase() === cur;
        d.classList.toggle('active', on);
        if (on) isPreset = true;
      });
      if (colorPicker) colorPicker.classList.toggle('active', !isPreset);
    }

    colors.forEach(function(dot) {
      dot.addEventListener('click', function() { _applyThemeColor(dot.dataset.c); });
    });
    if (colorPicker) {
      // 拖动时实时预览 (input), 选定后落盘 (change) — 两者都走同一套
      colorPicker.addEventListener('input', function() { _applyThemeColor(colorPicker.value); });
      colorPicker.addEventListener('change', function() { _applyThemeColor(colorPicker.value); });
    }

    var bl = container.querySelector('#setBlur');
    var blv = container.querySelector('#setBlurVal');
    if (bl) bl.addEventListener('input', function() {
      var v = +this.value; blv.textContent = v;
      TileAPI.storage.set('appearance.blur', v);
      ThemeEngine.applyBlur(v);
    });

    var op = container.querySelector('#setOpa');
    var opv = container.querySelector('#setOpaVal');
    if (op) op.addEventListener('input', function() {
      var v = +this.value; opv.textContent = v;
      TileAPI.storage.set('appearance.opacity', v);
      ThemeEngine.applyOpacity(v);
    });

    var tc = container.querySelector('#setTco');
    var tcv = container.querySelector('#setTcoVal');
    if (tc) tc.addEventListener('input', function() {
      var v = +this.value; tcv.textContent = v;
      TileAPI.storage.set('appearance.tileColorOpacity', v);
      ThemeEngine.applyTileColorOpacity(v);
    });
    var sc = container.querySelector('#setScale');
    var scv = container.querySelector('#setScaleVal');
    function _clampScale(n) {
      n = parseInt(n, 10);
      if (!isFinite(n)) n = 100;
      if (n < 50) n = 50;
      if (n > 300) n = 300;
      return n;
    }
    function _commitScale(v) {
      v = _clampScale(v);
      if (sc) sc.value = v;
      if (scv) scv.value = v;
      TileAPI.storage.set('appearance.scale', v);
      ThemeEngine.applyScale(v);
    }
    if (sc) {
      // 拖动时:仅同步数字显示,不应用
      sc.addEventListener('input', function() {
        if (scv) scv.value = this.value;
      });
      // 松手时:真正应用
      sc.addEventListener('change', function() {
        _commitScale(this.value);
      });
    }
    if (scv) {
      // 数字输入框:回车 / 失焦时应用,并把 range 拖到对应位置
      scv.addEventListener('change', function() {
        _commitScale(this.value);
      });
      scv.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          _commitScale(this.value);
          this.blur();
        }
      });
    }

    // --- 文字模式 事件 ---
    var textModePills = container.querySelectorAll('#textModePill .sf-pill-opt');
    textModePills.forEach(function(pill) {
      pill.addEventListener('click', function() {
        var mode = pill.dataset.mode;
        textModePills.forEach(function(p) { p.classList.remove('active'); });
        pill.classList.add('active');
        TileAPI.storage.set('appearance.textMode', mode);
        ThemeEngine.applyTextMode(mode);
      });
    });

    var bgBtn = container.querySelector('#setBgImgBtn');
    if (bgBtn) bgBtn.addEventListener('click', function() {
      var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
      inp.addEventListener('change', function() {
        if (!inp.files.length) return;
        var reader = new FileReader();
        reader.onload = function(ev) {
          TileAPI.storage.set('appearance.bgImage', ev.target.result);
          ThemeEngine.applyBgImage(ev.target.result);
          TileAPI.toast('\u80CC\u666F\u5DF2\u8BBE\u7F6E', 'success');
        };
        reader.readAsDataURL(inp.files[0]);
      });
      inp.click();
    });

    var clearBgBtn = container.querySelector('#setClearBgBtn');
    if (clearBgBtn) clearBgBtn.addEventListener('click', function() {
      TileAPI.storage.remove('appearance.bgImage');
      ThemeEngine.applyBgImage(null);
      TileAPI.toast('\u80CC\u666F\u5DF2\u6E05\u9664', 'info');
    });

    // ===== \u80CC\u666F\u56FE\u4F4D\u7F6E / \u7F29\u653E \u6ED1\u5757 =====
    function _bindBgSlider(rangeId, valId, storageKey, applyFn, defaultVal) {
      var r = container.querySelector('#' + rangeId);
      var v = container.querySelector('#' + valId);
      if (!r) return;
      r.addEventListener('input', function() {
        var n = +this.value;
        if (v) v.textContent = n;
        applyFn(n);
      });
      r.addEventListener('change', function() {
        var n = +this.value;
        TileAPI.storage.set(storageKey, n);
      });
    }
    // \u6C34\u5E73 / \u5782\u76F4\u4F4D\u7F6E \u2014 \u62D6\u52A8\u65F6\u5B9E\u65F6\u8C03\u4E00\u5BF9 x/y
    var posXEl = container.querySelector('#setBgPosX');
    var posYEl = container.querySelector('#setBgPosY');
    var posXValEl = container.querySelector('#setBgPosXVal');
    var posYValEl = container.querySelector('#setBgPosYVal');
    function _applyBgPosLive() {
      var x = posXEl ? +posXEl.value : 50;
      var y = posYEl ? +posYEl.value : 50;
      ThemeEngine.applyBgPosition(x, y);
    }
    if (posXEl) {
      posXEl.addEventListener('input', function() {
        if (posXValEl) posXValEl.textContent = this.value;
        _applyBgPosLive();
      });
      posXEl.addEventListener('change', function() {
        TileAPI.storage.set('appearance.bgPosX', +this.value);
      });
    }
    if (posYEl) {
      posYEl.addEventListener('input', function() {
        if (posYValEl) posYValEl.textContent = this.value;
        _applyBgPosLive();
      });
      posYEl.addEventListener('change', function() {
        TileAPI.storage.set('appearance.bgPosY', +this.value);
      });
    }
    // \u7F29\u653E
    _bindBgSlider('setBgZoom', 'setBgZoomVal', 'appearance.bgZoom', function(n) { ThemeEngine.applyBgZoom(n); }, 100);

    // ========== 快捷键 事件 (NEW) ==========
    var btnActions = container.querySelector('#btnOpenActions');
    if (btnActions) btnActions.addEventListener('click', function() {
      var reqId = _settingsReqId('open_actions');
      _trackSettingsRequest(_openActionsPending, reqId, OPEN_ACTIONS_TIMEOUT_MS, function() {
        TileAPI.toast('打开 Photoshop 动作面板超时，请重试', 'error');
      });
      TileAPI.sendToHost('openActionsPanel', { reqId: reqId });
    });

    // ========== 预设文件夹 ==========
    var btnPresetFolder = container.querySelector('#btnOpenPresetFolder');
    if (btnPresetFolder) btnPresetFolder.addEventListener('click', function() {
      TileAPI.sendToHost('openPresetFolder', {});
    });

    // ========== 公告 事件 (NEW) ==========
    TileAPI.sendToHost('cloudGetAnnouncement', {});

    var btnRefAnn = container.querySelector('#btnRefreshAnn');
    if (btnRefAnn) btnRefAnn.addEventListener('click', function() {
      TileAPI.sendToHost('cloudGetAnnouncement', {});
      TileAPI.toast('\u6B63\u5728\u83B7\u53D6\u516C\u544A...', 'info');
    });

    // ========== 清除缓存 (existing) ==========
    var clearBtn = container.querySelector('#setClearCache');
    if (clearBtn) clearBtn.addEventListener('click', function() {
      TileAPI.confirm('\u786E\u5B9A\u6E05\u9664\u6240\u6709\u7F13\u5B58\u5E76\u5237\u65B0\uFF1F').then(function(ok) {
        if (!ok) return;
        try { localStorage.clear(); } catch(e) {}
        location.reload();
      });
    });

    // ========== 用户改进计划 ==========
    var togImp = container.querySelector('#togImprovement');
    var devIdRow = container.querySelector('#improvementDeviceIdRow');
    var devIdSpan = container.querySelector('#improvementDevId');
    if (togImp) togImp.addEventListener('click', function() {
      var nowOn = !togImp.classList.contains('on');
      togImp.classList.toggle('on', nowOn);
      if (nowOn) {
        if (window._telemetry && window._telemetry.optIn) window._telemetry.optIn();
        else TileAPI.storage.set('improvement.optedIn', true);
        if (devIdRow) devIdRow.style.display = '';
        if (devIdSpan) {
          var did = (window._telemetry && window._telemetry.getDeviceId && window._telemetry.getDeviceId()) || TileAPI.storage.get('improvement.deviceId') || '?';
          devIdSpan.textContent = did.slice(0, 12) + '...';
        }
        TileAPI.toast('已开启用户改进计划, 谢谢支持 ❤️', 'success');
      } else {
        if (window._telemetry && window._telemetry.optOut) window._telemetry.optOut();
        else TileAPI.storage.set('improvement.optedIn', false);
        if (devIdRow) devIdRow.style.display = 'none';
        TileAPI.toast('已关闭用户改进计划, 后续不再上报', 'info');
      }
    });
    // --- 教程调试模式 (每次打开插件都弹教程; 持久开关, 默认关) ---
    var ttd = container.querySelector('#togTutorialDebug');
    if (ttd) ttd.addEventListener('click', function() {
      var now = !(TileAPI.storage.get('tutorial.debugAlwaysShow') === true);
      TileAPI.storage.set('tutorial.debugAlwaysShow', now);
      ttd.classList.toggle('on', now);
      TileAPI.toast(now ? '教程调试模式已开: 每次打开插件都会弹教程' : '已恢复正常: 教程不再每次自动弹', 'info');
    });

    var resetDevBtn = container.querySelector('#setResetDevId');
    if (resetDevBtn) resetDevBtn.addEventListener('click', function() {
      TileAPI.confirm('重置设备 ID?\n\n服务端会把你视作一个全新用户, 之前的所有数据无法关联回来.\n\n这个操作不可恢复.').then(function(ok) {
        if (!ok) return;
        if (window._telemetry && window._telemetry.resetDeviceId) window._telemetry.resetDeviceId();
        var newDid = (window._telemetry && window._telemetry.getDeviceId && window._telemetry.getDeviceId()) || '?';
        if (devIdSpan) devIdSpan.textContent = newDid.slice(0, 12) + '...';
        TileAPI.toast('设备 ID 已重置: ' + newDid.slice(0, 8) + '...', 'success');
      });
    });

    // ========== 图片缓存 ==========
    var btnOpenCache = container.querySelector('#btnOpenImageCache');
    if (btnOpenCache) btnOpenCache.addEventListener('click', function() {
      TileAPI.sendToHost('openImageCacheFolder', {});
    });

    var btnClearCache = container.querySelector('#btnClearImageCache');
    if (btnClearCache) btnClearCache.addEventListener('click', function() {
      if (_clearCacheBusy) {
        TileAPI.toast('图片缓存正在清理或等待确认，请勿重复点击', 'warn');
        return;
      }
      if (_hasRunningTasks()) {
        TileAPI.toast('当前还有生成任务，完成或停止后才能清理图片缓存', 'warn');
        return;
      }
      _clearCacheBusy = true;
      TileAPI.confirm('【高危操作】即将删除全部图片缓存（所有任务子文件夹），删除后不可恢复。是否继续？').then(function(ok1) {
        if (!ok1) { _clearCacheBusy = false; return; }
        TileAPI.confirm('二次确认：清理后将丢失历史生成证据与排障素材，且无法找回。是否继续清理？').then(function(ok2) {
          if (!ok2) { _clearCacheBusy = false; return; }
          TileAPI.confirm('最后确认：本次仅保留预设，不会恢复任何已清理缓存。确定立即清理图片缓存？').then(function(ok3) {
            if (!ok3) { _clearCacheBusy = false; return; }
            if (_hasRunningTasks()) {
              _clearCacheBusy = false;
              TileAPI.toast('确认期间有生成任务启动，本次清理已取消', 'warn');
              return;
            }
            var reqId = _settingsReqId('clear_cache');
            _trackSettingsRequest(_clearCachePending, reqId, CLEAR_CACHE_TIMEOUT_MS, function() {
              _clearCacheBusy = false;
              TileAPI.toast('图片缓存清理超时，请查看日志后再重试', 'error');
            });
            TileAPI.sendToHost('clearImageCache', { reqId: reqId });
            TileAPI.toast('正在清理图片缓存...', 'info');
          }, function() { _clearCacheBusy = false; });
        }, function() { _clearCacheBusy = false; });
      }, function() { _clearCacheBusy = false; });
    });

    // ========== Cleanup ==========
    return function() {
      TileAPI.off('settings:providerChanged', _updateBalanceVisibility);
    };
  },

  // ========== 接收后端消息 ==========
  onMessage: function(action, data) {
    if (action === 'openActionsPanelResult') {
      var actionsReqId = data && data.reqId != null ? String(data.reqId) : '';
      if (_takeSettingsRequest(_openActionsPending, actionsReqId)) {
        if (data.success) TileAPI.toast('Photoshop 动作面板已打开', 'success');
        else TileAPI.toast('动作面板打开失败: ' + (data.error || '当前 Photoshop 不支持这个菜单命令'), 'error');
      }
    }
    if (action === 'imageCacheCleared') {
      var cacheReqId = data && data.reqId != null ? String(data.reqId) : '';
      if (_takeSettingsRequest(_clearCachePending, cacheReqId)) {
        _clearCacheBusy = false;
        if (data.success) TileAPI.toast('图片缓存已清空', 'success');
        else TileAPI.toast('图片缓存清理失败: ' + (data.error || '未知错误'), 'error');
      }
    }
    if (action === 'showFolderPath' && data && data.path) {
      TileAPI.toast('无法自动打开文件夹，请手动前往: ' + data.path, 'warn', 10000);
    }
    // 音效文件列表
    if (action === 'soundFilesResult') {
      _populateSoundSelects(data);
    }
    // 余额校准/查询结果
    if (action === 'balanceResult' || action === 'calibrateResult') {
      if (data && data.balanceUSD !== undefined && !data.error) {
        TileAPI.state.set('balance.current', data.balanceUSD);
        var el = document.querySelector('#balDisplay');
        if (el) el.textContent = '$' + data.balanceUSD.toFixed(4);
        if (!data.silent) TileAPI.toast('\u4F59\u989D: $' + data.balanceUSD.toFixed(4), 'success');
      } else if (data && data.error) {
        if (!data.silent) TileAPI.toast('\u4F59\u989D\u67E5\u8BE2\u5931\u8D25: ' + data.error, 'error');
      }
    }
    // GRS 积分查询结果(host action 名是 grsCreditsResult,之前误写成 grsCheckCreditsResult 永远收不到)
    if (action === 'grsCreditsResult') {
      var gEl = document.querySelector('#grsCreditsStatus');
      if (data && data.success) {
        var credits = (data.credits !== undefined) ? data.credits : (data.balance !== undefined ? data.balance : '未知');
        if (gEl) gEl.textContent = '当前积分: ' + credits;
        TileAPI.toast('GRS 积分: ' + credits, 'success');
      } else {
        if (gEl) gEl.textContent = '查询失败: ' + ((data && data.error) || '未知');
        TileAPI.toast('GRS 查询失败', 'error');
      }
    }
    // Others 额度查询结果
    if (action === 'checkQuotaResult') {
      var qEl = document.querySelector('#othersQuotaStatus');
      if (data && !data.error) {
        var info = data.remaining !== undefined ? ('剩余: ' + data.remaining) :
                   data.quota !== undefined ? ('额度: ' + data.quota) : '查询成功';
        if (qEl) qEl.textContent = info;
        TileAPI.toast(info, 'success');
      } else {
        if (qEl) qEl.textContent = '查询失败: ' + ((data && data.error) || '未知');
        TileAPI.toast('额度查询失败', 'error');
      }
    }
    // 公告
    if (action === 'announcementResult' || action === 'cloudAnnouncementResult') {
      var html = (data && (data.html || data.content)) || '';
      TileAPI.state.set('announcement.html', html);
      var area = document.querySelector('#announceArea');
      if (area) {
        area.innerHTML = html ? _sanitizeAnn(html) : '<span style="color:var(--text-sub);font-style:italic;">\u6682\u65E0\u516C\u544A</span>';
      }
    }
  },

  onStorageLoaded: function(storage) {
    // AJI URL 6.2.5 起不再自动填默认值, 由用户填 Key 后赛马自动选 — 这里删掉以前的兜底
    //   (旧行为: 首次安装自动填 https://ai.ajiai.top, 但用户根本不该接触 URL 这一层)
    // GRS 默认地址(对齐 v5 行为:select 默认 = 国内直连)
    if (!storage.get('connection.grs.url')) {
      storage.set('connection.grs.url', 'https://grsai.dakka.com.cn');
    }
    // 音效默认设置(首次安装用户)— 对齐 5.4.6 默认开启
    if (storage.get('sound.enabled') === null || storage.get('sound.enabled') === undefined) {
      storage.set('sound.enabled', true);
    }
    if (!storage.get('sound.success')) storage.set('sound.success', '三七唐笑');
    if (!storage.get('sound.allFail')) storage.set('sound.allFail', 'none');
    if (!storage.get('sound.singleFail')) storage.set('sound.singleFail', 'none');
    // 翻转动画开关:默认关闭, 只有 storage 显式为 true 才允许翻转
    if (storage.get('appearance.flipEnabled') !== true) {
      document.body.classList.add('tile-flip-disabled');
    }
    // 简洁模式:启动时若开启, 给 body 加 class(去色 + 图标剪影由 simple-mode.css 接管)
    if (storage.get('appearance.simpleMode') === true) {
      document.body.classList.add('simple-mode');
    }
    _syncSettings();
    // 如果用户启用了余额追踪,启动时自动开始定期刷新
    if (storage.get('balance.enabled') === true) {
      _startBalanceAutoRefresh();
    }
  },
});

// ========== 工具函数 ==========
// bug #3: 转义 4 个特殊字符(原来只转了 "), 防公告/输入里的 < > & 破坏 innerHTML
function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// 公告 HTML 清洗(去 script/on*/危险协议); 走 TileAPI.sanitizeHtml, 缺失时兜底纯文本转义
function _sanitizeAnn(html) {
  if (window.TileAPI && typeof TileAPI.sanitizeHtml === 'function') return TileAPI.sanitizeHtml(html);
  return _esc(html);
}
function _clampInt(v, min, max) {
  v = Math.round(v);
  if (isNaN(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}
function _bindInput(container, id, storageKey) {
  var inp = container.querySelector('#' + id);
  if (!inp) return;
  inp.addEventListener('change', function() {
    TileAPI.storage.set(storageKey, this.value);
  });
  inp.addEventListener('blur', function() {
    TileAPI.storage.set(storageKey, this.value);
  });
}

function _syncSettings() {
  TileAPI.sendToHost('updateSettings', {
    layerType: TileAPI.storage.get('output.layerType') || 'smartObject',
    maxResolution: TileAPI.storage.get('output.maxResolution') || 2048,
    colorStable: TileAPI.storage.get('output.colorStable') === true,
    autoGroup: TileAPI.storage.get('output.autoGroup') !== false,
    antiMode: TileAPI.state.get('params.antiMode') || 0,
    autoSelectFullCanvasNoSelection: TileAPI.storage.get('selection.autoFullCanvasNoSelection') === true,
    autoPadCrop: TileAPI.storage.get('output.autoPadCrop') === true,
    fix4kMagenta: false,   // v6.6.0: 功能停用(设置开关已删), 恒 false 让 host 侧曲线矫正不再触发
    teachMode: TileAPI.storage.get('teachMode.enabled') === true,
    returnFeather: {
      enabled: TileAPI.storage.get('output.returnFeather.enabled') === true,
      workflows: TileAPI.storage.get('output.returnFeather.workflows') || {},
      shrinkPercent: TileAPI.storage.get('output.returnFeather.shrinkPercent') || 2,
      blurPercent: TileAPI.storage.get('output.returnFeather.blurPercent') || 3,
    },
    sound: {
      enabled: TileAPI.storage.get('sound.enabled') === true,
      success: TileAPI.storage.get('sound.success') || '\u4E09\u4E03\u5510\u7B11',
      allFail: TileAPI.storage.get('sound.allFail') || 'none',
      singleFail: TileAPI.storage.get('sound.singleFail') || 'none',
    },
  });
}

// 填充音效下拉框
function _populateSoundSelects(data) {
  var files = (data && data.files) || [];
  var selectIds = ['selSoundSuccess', 'selSoundAllFail', 'selSoundSingleFail'];
  var storageKeys = ['sound.success', 'sound.allFail', 'sound.singleFail'];
  var defaults = ['\u4E09\u4E03\u5510\u7B11', 'none', 'none'];
  for (var si = 0; si < selectIds.length; si++) {
    var sel = document.querySelector('#' + selectIds[si]);
    if (!sel) continue;
    var savedVal = TileAPI.storage.get(storageKeys[si]) || defaults[si];
    sel.innerHTML = '';
    // 全部失败和单个失败多一个"无"选项
    if (si > 0) {
      var noneOpt = document.createElement('option');
      noneOpt.value = 'none';
      noneOpt.textContent = '\u65E0';
      sel.appendChild(noneOpt);
    }
    for (var fi = 0; fi < files.length; fi++) {
      var opt = document.createElement('option');
      opt.value = files[fi].name;
      opt.textContent = files[fi].name + (files[fi].source === 'custom' ? ' (custom)' : '');
      sel.appendChild(opt);
    }
    sel.value = savedVal;
    if (sel.value !== savedVal) sel.value = defaults[si];
  }
}

// ========== 暴露给外部 ==========
// 取连接配置 (URL + Key).
//   不传参 → 用全局当前 provider (params.provider / connection.provider)
//   传 forceProvider → 按指定 provider 取 (灯光/相机磁贴有自己的 provider 选择)
// GRS 双路径 (BYOK / 夏算力托管) 由本函数统一处理, 调用方拿到 key 就直接用.
//   _grsKeyPending: true 表示已登录但 sub-key 还在异步拉, 调用方可显示"准备中"
window._settingsGetActiveConnection = function(forceProvider) {
  var provider = forceProvider
    || TileAPI.state.get('params.provider')
    || TileAPI.storage.get('connection.provider')
    || 'aji';
  var url = TileAPI.storage.get('connection.' + provider + '.url') || '';
  var key = TileAPI.storage.get('connection.' + provider + '.key') || '';
  // momo(墨墨): URL 嵌死, 不走存储/用户填; key 用户自己贴(connection.momo.key)
  if (provider === 'momo') {
    url = 'https://api.momoapi.icu';
  }
  var grsKeyPending = false;
  var grsNeedLogin = false;
  // GRS 双路径:
  //   1) BYOK (用户填了 connection.grs.key 且没在云服务里关掉) → 用他自己的, 不碰云端 sub-key
  //   2) proxy (没填 / 在云服务里关了开关 ⇒ 走"夏算力"的免配置路径) → 用后台分给他的 sub-key
  // 切换开关: connection.grs.use_byok (TileAPI.compute.isUserByokActive 统一判定)
  if (provider === 'grs') {
    var byokActive = (window.TileAPI && TileAPI.compute && TileAPI.compute.isUserByokActive)
      ? TileAPI.compute.isUserByokActive() : !!key;
    if (!byokActive) {
      // 走 proxy: 忽略本地填的 key (如果有), 改用云端 sub-key
      key = '';
      var cs = (window.TileAPI && TileAPI.compute && TileAPI.compute.getState) ? TileAPI.compute.getState() : null;
      var subKey = cs ? cs.key : '';
      if (subKey) {
        key = subKey;
      } else if (window._cloudIsLoggedIn && window._cloudIsLoggedIn()) {
        // 已登录但 sub-key 还没拿到 → 后台异步拉一次, 给调用方一个"准备中"标记
        grsKeyPending = true;
        if (TileAPI.compute && TileAPI.compute.getKey) TileAPI.compute.getKey().catch(function(){});
      } else {
        // 托管模式但没登录(登出后 sub-key 已清) → 提示登录, 而不是误导用户去填 key
        // (托管模式下本地 key 会被忽略, 照老提示去填也没用)
        grsNeedLogin = true;
      }
    }
  }
  return {
    provider: provider,
    url: url,
    key: key,
    _grsKeyPending: grsKeyPending,
    _grsNeedLogin: grsNeedLogin
  };
};

window._settingsCheckBalance = function() {
  var enabled = TileAPI.storage.get('balance.enabled') === true;
  if (!enabled) return false;
  var cur = TileAPI.state.get('balance.current');
  if (cur === null || cur === undefined || cur < 0) return false;
  var threshold = parseFloat(TileAPI.storage.get('balance.threshold')) || 0.5;
  return cur <= threshold;
};

// #I 双向同步: 外部(Dock / 任务面板)改了 自动返回 / 自动编组 时, 刷新设置面板里的开关
TileAPI.on('output:autoReturnChanged', function() {
  var el = document.getElementById('togAutoReturn');
  if (el) el.classList.toggle('on', TileAPI.storage.get('output.autoReturn') !== false);
});
TileAPI.on('output:autoGroupChanged', function() {
  var el = document.getElementById('togAutoGroup');
  if (el) el.classList.toggle('on', TileAPI.storage.get('output.autoGroup') !== false);
});

})();
