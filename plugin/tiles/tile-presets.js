(function() {
'use strict';

// ========== 私有工具函数 ==========

// ========== 拼音首字母模糊搜索 (来自老版本 preset-search.js) ==========
var PY_INITIALS = {
'眼':'y',
'睛':'j',
'鼻':'b',
'梁':'l',
'嘴':'z',
'唇':'c',
'眉':'m',
'毛':'m',
'脸':'l',
'型':'x',
'头':'t',
'发':'f',
'部':'b',
'面':'m',
'颈':'j',
'肩':'j',
'颚':'e',
'下':'x',
'颌':'h',
'骨':'g',
'锁':'s',
'窝':'w',
'腰':'y',
'腹':'f',
'肌':'j',
'胸':'x',
'臂':'b',
'手':'s',
'指':'z',
'甲':'j',
'腿':'t',
'脚':'j',
'膝':'x',
'踝':'h',
'肘':'z',
'背':'b',
'臀':'t',
'皮':'p',
'肤':'f',
'精':'j',
'修':'x',
'磨':'m',
'复':'f',
'制':'z',
'容':'r',
'自':'z',
'然':'r',
'感':'g',
'瞳':'t',
'孔':'k',
'提':'t',
'亮':'l',
'妆':'z',
'补':'b',
'线':'x',
'优':'y',
'化':'h',
'高':'g',
'光':'g',
'柔':'r',
'纹':'w',
'形':'x',
'萝':'l',
'莉':'l',
'御':'y',
'姐':'j',
'乙':'y',
'女':'n',
'男':'n',
'美':'m',
'向':'x',
'成':'c',
'熟':'s',
'少':'s',
'年':'n',
'中':'z',
'性':'x',
'甜':'t',
'偶':'o',
'像':'x',
'清':'q',
'冷':'l',
'仙':'x',
'侠':'x',
'邪':'x',
'魅':'m',
'反':'f',
'派':'p',
'厚':'h',
'涂':'t',
'画':'h',
'笔':'b',
'引':'y',
'导':'d',
'风':'f',
'吹':'c',
'写':'x',
'实':'s',
'绘':'h',
'刘':'l',
'海':'h',
'整':'z',
'体':'t',
'移':'y',
'除':'c',
'一':'y',
'键':'j',
'液':'y',
'扩':'k',
'大':'d',
'绷':'b',
'紧':'j',
'衣':'y',
'服':'f',
'抹':'m',
'油':'y',
'勒':'l',
'肉':'r',
'条':'t',
'纤':'x',
'细':'x',
'身':'s',
'材':'c',
'关':'g',
'节':'j',
'白':'b',
'长':'c',
'丝':'s',
'袜':'w',
'网':'w',
'渔':'y',
'安':'a',
'全':'q',
'裤':'k',
'转':'z',
'连':'l',
'黑':'h',
'色':'s',
'裸':'l',
'洁':'j',
'态':'t',
'布':'b',
'机':'j',
'去':'q',
'打':'d',
'底':'d',
'旗':'q',
'袍':'p',
'杂':'z',
'物':'w',
'配':'p',
'饰':'s',
'道':'d',
'具':'j',
'归':'g',
'位':'w',
'破':'p',
'损':'s',
'带':'d',
'内':'n',
'金':'j',
'属':'s',
'木':'m',
'质':'z',
'做':'z',
'旧':'j',
'锈':'x',
'蚀':'s',
'战':'z',
'碎':'s',
'接':'j',
'缝':'f',
'消':'x',
'翻':'f',
'新':'x',
'表':'b',
'度':'d',
'升':'s',
'套':'t',
'装':'z',
'统':'t',
'刃':'r',
'口':'k',
'锋':'f',
'强':'q',
'宝':'b',
'石':'s',
'镶':'x',
'嵌':'q',
'超':'c',
'场':'c',
'照':'z',
'轮':'l',
'椅':'y',
'处':'c',
'理':'l',
'凭':'p',
'空':'k',
'植':'z',
'入':'r',
'动':'d',
'作':'z',
'设':'s',
'计':'j',
'九':'j',
'宫':'g',
'格':'g',
'浮':'f',
'血':'x',
'水':'s',
'流':'l',
'玩':'w',
'地':'d',
'通':'t',
'用':'y',
'区':'q',
'域':'y',
'擦':'c',
'粘':'n',
'湿':'s',
'汗':'h',
'效':'x',
'果':'g',
'泪':'l',
'痕':'h',
'哭':'k',
'泣':'q',
'唾':'t',
'灯':'d',
'微':'w',
'调':'d',
'图':'t',
'特':'t',
'武':'w',
'器':'q',
'魔':'m',
'法':'f',
'阵':'z',
'火':'h',
'焰':'y',
'环':'h',
'绕':'r',
'冰':'b',
'霜':'s',
'雷':'l',
'电':'d',
'暗':'a',
'影':'y',
'雾':'w',
'元':'y',
'素':'s',
'棚':'p',
'春':'c',
'四':'s',
'合':'h',
'院':'y',
'景':'j',
'咖':'k',
'啡':'f',
'厅':'t',
'虚':'x',
'深':'s',
'镜':'j',
'非':'f',
'人':'r',
'类':'l',
'征':'z',
'花':'h',
'添':'t',
'加':'j',
'伤':'s',
'疤':'b',
'赛':'s',
'博':'b',
'朋':'p',
'克':'k',
'哥':'g',
'日':'r',
'系':'x',
'胶':'j',
'片':'p',
'墨':'m',
'意':'y',
'境':'j',
'夜':'y',
'霓':'n',
'虹':'h',
'氛':'f',
'围':'w',
'印':'y',
'文':'w',
'字':'z',
'岩':'y',
'毒':'d',
'腐':'f',
'翼':'y',
'樱':'y',
'瓣':'b',
'飘':'p',
'落':'l',
'萤':'y',
'虫':'c',
'粒':'l',
'子':'z',
'生':'s',
'预':'y',
'收':'s',
'藏':'c',
'搜':'s',
'索':'s',
'查':'c',
'找':'z',
'抗':'k',
'截':'j',
'断':'d',
'模':'m',
'式':'s',
'参':'c',
'数':'s',
'批':'p',
'量':'l',
'运':'y',
'行':'x',
'启':'q',
'禁':'j',
'开':'k',
'闭':'b',
'停':'t',
'止':'z',
'保':'b',
'存':'c',
'删':'s',
'改':'g',
'更':'g',
'替':'t',
'换':'h',
'重':'c',
'命':'m',
'名':'m',
'出':'c',
'聊':'l',
'天':'t',
'云':'y',
'登':'d',
'录':'l',
'注':'z',
'册':'c',
'密':'m',
'码':'m',
'钥':'y',
'匙':'s',
'令':'l',
'牌':'p',
'验':'y',
'证':'z',
'会':'h',
'员':'y'
};


function _getPYInitials(str) {
  var r = "";
  for (var i = 0; i < str.length; i++) {
    var ch = str[i];
    if (PY_INITIALS[ch]) r += PY_INITIALS[ch];
    else r += ch.toLowerCase();
  }
  return r;
}

// 返回匹配分数 (0=不命中, 越高越精准)
//   100 = 子串完全命中
//   80  = 拼音首字母命中
//   60  = 紧凑跨字符 (字符之间间隔 ≤ 2)
//   0   = 不命中
// 跨字符不再做"全文长跨距"匹配, 因为长跨距噪声太大 (输入两字能命中几乎所有预设)
function _fuzzyScore(text, query) {
  if (!text || !query) return 0;
  var q = query.toLowerCase().trim();
  if (!q) return 0;
  var name = String(text).toLowerCase();
  // 1) 子串
  if (name.indexOf(q) >= 0) return 100;
  // 2) 拼音首字母 (≥2 字符才查, 单字符拼音歧义太大)
  if (q.length >= 2) {
    var initials = _getPYInitials(String(text));
    if (initials.indexOf(q) >= 0) return 80;
  }
  // 3) 紧凑跨字符: q 中相邻两字符在 text 里的间距 ≤ 2 (即最多跨 2 个字)
  //    例: q="照处", text="照背景处理" → 照→处 之间隔了"背景" 2 字 → 命中
  //        q="场照", text="场照瑕疵处理" → 场→照 之间 0 字 → 命中 (但其实子串已经命中了)
  //        q="场照", text="背景扩充" → 不含场, 不命中
  //        q="场照", text="毛绒道具优化" → 不含场, 不命中 (旧版会误命中, 新版不会)
  if (q.length >= 2 && _compactSubsequenceMatch(name, q, 2)) return 60;
  return 0;
}

// 紧凑顺序子序列: q 字符必须按序出现, 且**相邻 q 字符之间的间隔不超过 maxGap 个 text 字符**
// 注意: 一个 q 字符可能在 text 里出现多次 — 间距超限时不立刻判负, 而是当作没匹配上, 让 ti 继续扫
function _compactSubsequenceMatch(text, q, maxGap) {
  var ti = 0, qi = 0;
  var lastMatchTi = -1;
  while (ti < text.length && qi < q.length) {
    if (text.charAt(ti) === q.charAt(qi)) {
      // 第一个字符无间距要求 (lastMatchTi=-1); 后续字符跟前一个匹配位置的间距必须 ≤ maxGap
      if (lastMatchTi < 0 || (ti - lastMatchTi - 1) <= maxGap) {
        lastMatchTi = ti;
        qi++;
      }
      // 间距超限: 不前进 qi, 也不回退, 让 ti++ 继续找下一个出现位置
    }
    ti++;
  }
  return qi === q.length;
}

// 旧 API 保留 (返回 boolean), 内部走分数判断
function _fuzzyMatch(text, query) {
  return _fuzzyScore(text, query) > 0;
}

var _searchTimer = null;
var _currentFilter = '';
var _currentCategory = null;  // 人体剪影联动:当前筛选的分类 id(head/hair/...)
var _currentSub = null;       // 当前筛选的子分类 id
var _currentView = 'home';    // 'home'=分类卡片网格 / 'list'=预设列表

// 分类卡片定义(图标+名称,与人体剪影一致)
var CATEGORY_CARDS = [
  { id: 'head',       name: '头部面部', icon: '🧠' },
  { id: 'hair',       name: '头发',     icon: '💇' },
  { id: 'neck',       name: '颈部',     icon: '🦴' },
  { id: 'torso',      name: '躯干腰腹', icon: '👔' },
  { id: 'arms',       name: '手臂',     icon: '💪' },
  { id: 'hands',      name: '手部',     icon: '✋' },
  { id: 'legs',       name: '腿部',     icon: '🦵' },
  { id: 'feet',       name: '脚部',     icon: '🦶' },
  { id: 'clothing',   name: '服装',     icon: '👗' },
  { id: 'accessory',  name: '配饰',     icon: '💍' },
  { id: 'fullbody',   name: '全身',     icon: '🧍' },
  { id: 'lighting',   name: '光影',     icon: '💡' },
  { id: 'background', name: '背景',     icon: '🏞️' },
  { id: 'weapon',     name: '武器',     icon: '🗡️' },
  { id: 'cleanup',    name: '去杂物',   icon: '🧹' },
  { id: 'effects',    name: '特效',     icon: '✨' },
  { id: 'other',      name: '其他',     icon: '📦' },
];

// 虚拟「示例」预设: 不写盘、不参与导出/收藏/删除, 仅在列表里露出.
// 点击它不是载入提示词, 而是直接全屏展开「尻特效(kao)」磁贴.
var EXAMPLE_KAO_PRESET = {
  id: '__example_kao',
  title: '粒子特效',
  category: 'effects',
  content: ' ',          // 占位, 实际走 _action 分支不会读
  starred: false,
  _isFactory: true,      // 不显示删除按钮
  _virtual: true,        // 标记: 渲染成示例行 (无收藏星/删除)
  _action: 'expandKao',  // 点击动作: 展开 kao 面板
};

// 人体剪影分类名(用于显示)
var _BODY_CAT_NAMES = {
  head:'头部面部', hair:'头发', neck:'颈部', torso:'躯干腰腹',
  arms:'手臂', hands:'手部', legs:'腿部', feet:'脚部',
  clothing:'服装', accessory:'配饰', fullbody:'全身',
  lighting:'光影', background:'背景', weapon:'武器',
  cleanup:'去杂物', effects:'特效', other:'其他'
};
function _bodyCatName(id) { return _BODY_CAT_NAMES[id] || id; }

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 取预设的短预览(不注入 content JSON,避免未转义字符破坏 innerHTML) */
function _previewText(content) {
  var s = String(content || '');
  if (!s) return '';
  // 去掉首尾 JSON 括号/引号等特殊字符,取其中的可读文字片段
  // 用正则找第一段连续中文/英文字符(长度 ≥ 6)
  var mm = s.match(/[一-鿿＀-￯a-zA-Z0-9 ,、。\-]{6,}/);
  var preview = mm ? mm[0] : s.replace(/[^一-鿿\w]/g, ' ').trim();
  if (preview.length > 40) preview = preview.substring(0, 40) + '…';
  return preview;
}

function _uid() {
  return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
}

function _getPresets() {
  return TileAPI.state.get('presets.list') || [];
}

function _setPresets(list) {
  // 注意:预设的真实存储位置是 dataFolder/presets/<file>.json (host 文件系统)
  // storage 不再保存预设列表 — 双向存储会导致 host 文件丢失时被空数组覆盖,
  // 重启后整个列表清空(已发生过严重事故)
  // 现在只更新内存 state,持久化交给 sendToHost('savePresetsFile') 写文件
  TileAPI.state.set('presets.list', list);
}

/** 把 Forge 预设归一化成 banana 预设结构并并入主列表(去重: 按 id 前缀 forge_ 区分) */
function _mergeForgePresets(forgePresets) {
  var bananaList = _getPresets().filter(function(p) { return !p._isForge; });
  // 读取 Forge 收藏状态(独立存储,因为 forge 预设文件本身不持久收藏)
  var forgeStars = TileAPI.storage.get('forge.starred') || {};
  var normalized = [];
  for (var i = 0; i < forgePresets.length; i++) {
    var fp = forgePresets[i];
    if (!fp) continue;
    var d = fp.data || {};
    var forgeId = 'forge_' + (fp.id || fp._fileName || i);
    normalized.push({
      id: forgeId,
      title: fp.displayName || fp.name || '未命名Forge预设',
      category: fp.category || 'fullbody',
      subCategory: fp.subCategory || '',
      // 用正向提示词作为预览文本(banana UI 用 content 字段生成预览)
      content: d.positivePrompt || '',
      refImages: [],
      starred: !!forgeStars[forgeId],
      _isFactory: !!fp._isFactory,
      _isForge: true,
      _forgeData: d,          // 完整 forge 参数,在 _loadPreset 中取用
      _forgeRaw: fp,
    });
  }
  var merged = bananaList.concat(normalized);
  TileAPI.state.set('presets.list', merged);
}


/** 排序：starred先，然后按title字母序 */
function _sortPresets(list, keepOrder) {
  // keepOrder=true 时保持传入顺序 (用于搜索结果按分数排好的列表)
  if (keepOrder) {
    // 仍把收藏的提到前面, 但同分组内保持调用方顺序
    var starred = [], unstarred = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].starred) starred.push(list[i]);
      else unstarred.push(list[i]);
    }
    return starred.concat(unstarred);
  }
  return list.slice().sort(function(a, b) {
    if (a.starred && !b.starred) return -1;
    if (!a.starred && b.starred) return 1;
    return (a.title || '').localeCompare(b.title || '');
  });
}

/** 按分类分组 */
function _groupByCategory(list) {
  var groups = {};
  var order = [];
  for (var i = 0; i < list.length; i++) {
    var cat = list[i].category || '未分类';
    if (!groups[cat]) { groups[cat] = []; order.push(cat); }
    groups[cat].push(list[i]);
  }
  return { groups: groups, order: order };
}

/** 过滤预设(支持关键字 + 人体分类联动) */
function _filterPresets(filter) {
  // 把虚拟示例(粒子特效)并进来一起参与分类过滤/搜索 — 只在本地数组, 不落盘
  var presets = [EXAMPLE_KAO_PRESET].concat(_getPresets());
  // 先按人体分类过滤(来自 tile-bodypreset 的 emit)
  if (_currentCategory) {
    presets = presets.filter(function(p) {
      if ((p.category || '') !== _currentCategory) return false;
      if (_currentSub && (p.subCategory || '') !== _currentSub) return false;
      return true;
    });
  }
  var q = (filter || '').trim();
  if (!q) return _sortPresets(presets);
  // 按字段加权: title 最重要, content 最次要 (避免 content 噪声把好结果挤掉)
  //   title:    score × 1.0
  //   subCat:   score × 0.7
  //   category: score × 0.5
  //   content:  score × 0.3 (并要求子串/紧凑匹配, 不接受首字母拼音)
  var scored = [];
  presets.forEach(function(p) {
    var s = 0;
    s = Math.max(s, _fuzzyScore(p.title, q) * 1.0);
    s = Math.max(s, _fuzzyScore(p.subCategory, q) * 0.7);
    s = Math.max(s, _fuzzyScore(p.category, q) * 0.5);
    s = Math.max(s, _fuzzyScore(_bodyCatName(p.category), q) * 0.5);
    // content 只用子串匹配 (避免长正文里跨字符乱命中)
    if (p.content && String(p.content).toLowerCase().indexOf(q.toLowerCase()) >= 0) {
      s = Math.max(s, 30);
    }
    if (s > 0) scored.push({ p: p, s: s });
  });
  // 按分数降序, 同分按 _sortPresets 的原排序 (用 stable map)
  scored.sort(function(a, b) { return b.s - a.s; });
  return _sortPresets(scored.map(function(x) { return x.p; }), true);
}

// ========== 磁贴注册 ==========

TileAPI.registerTile({
  id: 'presets',
  group: 'main',
  icon: '\uD83D\uDCBE',
  label: '预设',
  desc: '预设管理',
  live: true,
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderBack: function(container) {
    var presets = _getPresets();
    var starred = presets.filter(function(p) { return p.starred; }).length;
    if (starred > 0) {
      container.textContent = presets.length + '个预设 / ' + starred + '个收藏';
    } else {
      container.textContent = presets.length > 0 ? presets.length + '个预设' : '无预设';
    }
  },

  onExpand: function(container, sizeHint) {
    // 防御:若本磁贴 onExpand 被重复调用,先清掉上次的 listener
    if (window._presetsLastOnBodySelect) {
      try { TileAPI.off('bodypreset:select', window._presetsLastOnBodySelect); } catch(e) {}
      window._presetsLastOnBodySelect = null;
    }
    if (window._presetsLastOnPresetsChanged) {
      try { TileAPI.off('presets:changed', window._presetsLastOnPresetsChanged); } catch(e) {}
      window._presetsLastOnPresetsChanged = null;
    }

    // 实时 layout: sizeHint 在初次展开时可能拿到过渡中的尺寸 (UXP 窗口/抽屉过渡未完成时
    // container.clientWidth 偏小, 会算成 narrow → 卡片标题被压成竖排一字一行)
    // 这里改成每次渲染都用 _detectLayout(container) 实时算 + 自己装一个 RO 兜底
    var getLayout = function() { return _detectLayout(container); };
    var lastLayout = getLayout();
    _currentFilter = '';
    _currentCategory = null;
    _currentSub = null;
    _currentView = 'home';
    _renderPanel(container, lastLayout);

    var _onPresetsChanged = function() {
      var layout = getLayout();
      lastLayout = layout;
      if (_currentView === 'home') {
        _renderHome(container, layout);
      } else {
        _renderList(container, layout);
        _updateCategoryBar(container);
      }
    };
    TileAPI.on('presets:changed', _onPresetsChanged);
    window._presetsLastOnPresetsChanged = _onPresetsChanged;

    var _onBodySelect = function(data) {
      var wasInList = (_currentView === 'list');
      _currentCategory = (data && data.category) || null;
      _currentSub = (data && data.sub) || null;
      var layout = getLayout();
      lastLayout = layout;
      if (_currentCategory) {
        _currentView = 'list';
        if (wasInList) {
          _updateCategoryBarLabel(container);
          _refreshListOnly(container);
        } else {
          _switchViewWith(container, layout, 'left');
        }
      } else {
        _currentView = 'home';
        _switchViewWith(container, layout, 'right');
      }
    };
    TileAPI.on('bodypreset:select', _onBodySelect);
    window._presetsLastOnBodySelect = _onBodySelect;

    // 内部 RO: 容器尺寸变化导致 layout 变了就重渲 (engine 那条 RO 在初次
    // prev===undefined 时不触发, 这里兜底)
    var ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(function() {
        var newLayout = getLayout();
        if (newLayout === lastLayout) return;
        lastLayout = newLayout;
        if (_currentView === 'home') {
          _renderHome(container, newLayout);
        } else {
          _renderPanel(container, newLayout);
        }
      });
      try { ro.observe(container); } catch(_) {}
    }

    return function() {
      TileAPI.off('presets:changed', _onPresetsChanged);
      TileAPI.off('bodypreset:select', _onBodySelect);
      if (window._presetsLastOnBodySelect === _onBodySelect) window._presetsLastOnBodySelect = null;
      if (window._presetsLastOnPresetsChanged === _onPresetsChanged) window._presetsLastOnPresetsChanged = null;
      if (ro) { try { ro.disconnect(); } catch(_) {} ro = null; }
      if (_searchTimer) { clearTimeout(_searchTimer); _searchTimer = null; }
    };
  },

  onMessage: function(action, data) {
    if (action === 'presetsFileLoaded' && data && data.presets) {
      // 记录:host 报空但内存有数据 → 警告(不阻断,因为用户也可能真清空了)
      var prev = TileAPI.state.get('presets.list') || [];
      var prevNonForge = prev.filter(function(p) { return !p._isForge; }).length;
      if (data.presets.length === 0 && prevNonForge > 0) {
        TileAPI.log('[presets] 注意:host 返回空列表覆盖了 ' + prevNonForge + ' 条内存数据', 'warn');
      }
      TileAPI.state.set('presets.list', data.presets);
      // 重新合并已缓存的 forge 预设(如果之前已到达)
      var cachedForge = TileAPI.state.get('forge.presets');
      if (cachedForge && cachedForge.length) {
        _mergeForgePresets(cachedForge);
      }
      TileAPI.emit('presets:changed');
      TileAPI.toast('预设已加载 (' + data.presets.length + ')', 'success');
    }
    if (action === 'forgePresetsFileLoaded' && data && Array.isArray(data.presets)) {
      TileAPI.state.set('forge.presets', data.presets);
      _mergeForgePresets(data.presets);
      TileAPI.emit('presets:changed');
    }
    if (action === 'importPresetData' && data && (data.data || data.text)) {
      // host 发的可能是 { text: '<JSON 字符串>' } 或 { data: <对象/数组> } 或两者都有
      var imported = data.data;
      if (typeof imported === 'string') {
        try { imported = JSON.parse(imported); } catch(_) { imported = null; }
      }
      if (!imported && data.text) {
        try { imported = JSON.parse(data.text); } catch(_) { imported = null; }
      }
      if (!imported) {
        TileAPI.toast('导入失败:无法解析文件', 'error');
        return;
      }
      // 支持单个或数组
      var items = Array.isArray(imported) ? imported : [imported];
      // 过滤无效项
      items = items.filter(function(it) { return it && typeof it === 'object' && it.title; });
      if (!items.length) {
        TileAPI.toast('导入失败:文件中没有有效预设', 'error');
        return;
      }
      var list = _getPresets();
      for (var i = 0; i < items.length; i++) {
        var p = items[i];
        if (!p.id) p.id = _uid();
        p._isFactory = false;
        list.push(p);
      }
      _setPresets(list);
      // 关键:savePresetsFile 期望字段 data.presets (数组),不是 data.preset(单个)
      TileAPI.sendToHost('savePresetsFile', { action: 'import', presets: items });
      TileAPI.emit('presets:changed');
      TileAPI.toast('已导入 ' + items.length + ' 个预设', 'success');
    }
  },

  onStorageLoaded: function(storage) {
    // 兼容旧版 — storage 里如果有 presets.list,作为临时 fallback 显示(避免空白等待)
    // host 的 loadPresetsFile 几百毫秒后会用真实数据覆盖
    var saved = storage.get('presets.list') || storage.get('prompt_presets');
    if (saved) {
      try { if (typeof saved === 'string') saved = JSON.parse(saved); } catch(e) { saved = []; }
      if (Array.isArray(saved) && saved.length > 0) {
        TileAPI.state.set('presets.list', saved);
      }
    }
    // 清理 storage 里残留的 presets.list — 现在文件系统是唯一真相源,storage 不再持有这份大数据
    // (一次性迁移:用户老存档里 presets.list 占了几百 KB,清掉降低 storage 体积)
    if (storage.get('presets.list')) {
      try { storage.remove('presets.list'); } catch(_) {}
    }

    TileAPI.sendToHost('loadPresetsFile');
    // 同时加载 Forge 预设并合并到主列表
    TileAPI.sendToHost('loadForgePresetsFile', {});
  },
});

// ========== 面板渲染 ==========

// 切换视图时用的滑动方向:'left' 左进右出,'right' 右进左出,'fade' 纯淡入
function _switchViewWith(container, layout, direction) {
  // 抓当前 panel,克隆做为"旧内容"同步退场,然后渲染新内容
  var oldPanel = container.querySelector('.w10-panel');
  if (!oldPanel) {
    _renderPanel(container, layout);
    return;
  }
  var prevRect = oldPanel.getBoundingClientRect();
  // 渲染新内容
  _renderPanel(container, layout);
  var newPanel = container.querySelector('.w10-panel');
  if (!newPanel) return;

  // 初始态:根据方向把新面板推到旁边
  var offset = direction === 'right' ? '24px' : (direction === 'left' ? '-24px' : '0');
  newPanel.style.transform = 'translateX(' + offset + ')';
  newPanel.style.opacity = '0';
  newPanel.style.transition = 'transform 0.25s cubic-bezier(.4,0,.2,1), opacity 0.22s ease';
  // 下一帧归位
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      newPanel.style.transform = '';
      newPanel.style.opacity = '';
    });
  });
  // 动画结束后清 inline style
  setTimeout(function() {
    if (newPanel.parentElement) {
      newPanel.style.transition = '';
    }
  }, 280);
}

// 只更新 categoryBar 的 label 文字(保留返回按钮 + 放大镜 + 搜索框状态)
function _updateCategoryBarLabel(container) {
  var labelEl = container.querySelector('.preset-cat-label');
  if (!labelEl) return;
  var label;
  if (_currentCategory) {
    label = _bodyCatName(_currentCategory);
    if (_currentSub) label += ' / ' + _currentSub;
  } else if (_currentFilter) {
    label = '搜索: "' + _currentFilter + '"';
  } else {
    label = '全部预设';
  }
  // 淡入文字
  labelEl.textContent = label;
  labelEl.classList.remove('preset-cat-label-flash');
  void labelEl.offsetWidth;
  labelEl.classList.add('preset-cat-label-flash');
}

// 只刷新列表内容(整面板不重建,顶栏保留)
// 二级→二级切换时,不做动画 — 避免"消失再出现"的刷新闪烁感
function _refreshListOnly(container) {
  var layout = _detectLayout(container);
  var area = container.querySelector('#presetListArea');
  if (!area) return;
  var isPanelMode = container._isInline === false;
  // 窄/高布局一律用 square 渲染(跟 _renderPanel 保持一致)
  if (layout === 'narrow' || layout === 'tall') layout = 'square';
  if (layout === 'narrow' || layout === 'tall') {
    _renderNarrowList(container, isPanelMode);
  } else if (layout === 'wide') {
    _renderGroupedList(container);
  } else {
    _renderFlatList(container, layout === 'square' ? 30 : 50);
  }
}

function _renderPanel(container, layout) {
  if (_currentView === 'home') {
    _renderHome(container, layout);
    return;
  }
  // 窄/高布局一律用 square 渲染(单列竖排,内容全),避免精简版藏掉「导入」按钮
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
  // 搜索已挂到 categoryBar,不再用 _bindSearch
}

// ========== 分类卡片主页 ==========
function _renderHome(container, layout) {
  var presets = _getPresets();
  var totalUser = presets.filter(function(p) { return !p._isFactory; }).length;
  var totalFactory = presets.length - totalUser;

  // 统计每个分类下的预设数
  var counts = {};
  presets.forEach(function(p) {
    var c = p.category || 'other';
    counts[c] = (counts[c] || 0) + 1;
  });
  // 把虚拟示例(粒子特效)计入: 特效分类 +1, 工厂数 +1 (它常驻在特效分类里)
  counts['effects'] = (counts['effects'] || 0) + 1;
  totalFactory += 1;
  // "全部" 卡片排第一
  var allCount = presets.length + 1;

  var cardsHtml = '<div class="preset-cat-card preset-cat-card-all" data-cat-id="">' +
    '<span class="preset-cat-card-icon">🧍</span>' +
    '<span class="preset-cat-card-name">全部</span>' +
  '</div>';

  CATEGORY_CARDS.forEach(function(cat) {
    var n = counts[cat.id] || 0;
    cardsHtml +=
      '<div class="preset-cat-card" data-cat-id="' + _esc(cat.id) + '">' +
        '<span class="preset-cat-card-icon">' + cat.icon + '</span>' +
        '<span class="preset-cat-card-name">' + _esc(cat.name) + '</span>' +
        (n > 0 ? '<span class="preset-cat-card-count">' + n + '</span>' : '') +
      '</div>';
  });

  // 判断当前是否 panel-mode(大磁贴永久显示内容) → 隐藏底部操作按钮
  // panel-mode:_isInline===false;inline/全屏:_isInline===true 或 undefined
  var isPanelMode = container._isInline === false;
  var actionsHtml = isPanelMode ? '' :
    '<div class="preset-home-actions">' +
      '<button class="w10-btn w10-btn-accent" id="presetSaveBtn">保存当前</button>' +
      '<button class="w10-btn" id="presetImportBtn">导入</button>' +
      '<button class="w10-btn" id="presetRefreshBtn">刷新</button>' +
    '</div>';

  container.innerHTML =
    '<div class="w10-panel preset-home-panel">' +
      '<div class="preset-home-head">' +
        '<div class="preset-home-title">🧍 全部</div>' +
        '<div class="preset-home-meta">' + totalUser + ' + ' + totalFactory + ' 个预设</div>' +
        '<button class="preset-search-toggle" id="presetSearchToggle" title="搜索">🔍</button>' +
      '</div>' +
      '<div class="preset-home-search preset-home-search-hidden" id="presetHomeSearch">' +
        '<input class="w10-input" id="presetSearch" placeholder="搜索预设(中文/拼音首字母)...">' +
      '</div>' +
      '<div class="preset-cat-grid">' + cardsHtml + '</div>' +
      actionsHtml +
    '</div>';

  // 卡片点击 → 进入该分类列表
  container.querySelectorAll('.preset-cat-card').forEach(function(card) {
    card.addEventListener('click', function() {
      var id = card.dataset.catId || '';
      _currentCategory = id || null;   // 空字符串表示全部
      _currentSub = null;
      _currentView = 'list';
      _switchViewWith(container, layout, 'left');
    });
  });

  // 放大镜切换搜索框
  var searchToggle = container.querySelector('#presetSearchToggle');
  var searchWrap = container.querySelector('#presetHomeSearch');
  var search = container.querySelector('#presetSearch');
  if (searchToggle && searchWrap && search) {
    searchToggle.addEventListener('click', function(e) {
      e.stopPropagation();
      var willShow = searchWrap.classList.contains('preset-home-search-hidden');
      searchWrap.classList.toggle('preset-home-search-hidden', !willShow);
      searchToggle.classList.toggle('active', willShow);
      if (willShow) {
        setTimeout(function() { search.focus(); }, 50);
      }
    });
  }

  // 搜索框输入:进 list 视图
  if (search) {
    var _doHomeSearch = function() {
      var val = search.value;
      var caret = (search.selectionStart != null) ? search.selectionStart : val.length;
      if (_searchTimer) clearTimeout(_searchTimer);
      _searchTimer = setTimeout(function() {
        _currentFilter = val;
        _currentCategory = null;
        _currentView = 'list';
        _switchViewWith(container, layout, 'left');
        // 聚焦到新搜索框, 并把光标还原到原位置(否则重建后光标会掉到最前)
        var ns = container.querySelector('#presetSearch');
        if (ns) {
          ns.value = val;
          ns.focus();
          try { ns.selectionStart = ns.selectionEnd = caret; } catch (_) {}
        }
      }, 200);
    };
    // 中文输入法保护: 拼字过程中(composition)不触发重建, 拼完再过滤一次
    search.addEventListener('compositionstart', function() { search._composing = true; });
    search.addEventListener('compositionend', function() { search._composing = false; _doHomeSearch(); });
    search.addEventListener('input', function() {
      if (search._composing) return;
      _doHomeSearch();
    });
  }

  // 底部操作(panel-mode 下不存在)
  var saveBtn = container.querySelector('#presetSaveBtn');
  if (saveBtn) saveBtn.addEventListener('click', function() { _showSaveDialog(container); });
  var importBtn = container.querySelector('#presetImportBtn');
  if (importBtn) importBtn.addEventListener('click', function() { TileAPI.sendToHost('importPreset'); });
  var refreshBtn = container.querySelector('#presetRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', function() {
    TileAPI.sendToHost('refreshPresets');
    TileAPI.toast('正在刷新...', 'info');
  });
}

// --- narrow/tall: category bar + top 5 compact rows ---
function _renderNarrow(container) {
  // panel-mode 下分类列表里彻底不要保存/刷新按钮(主页已经处理了)
  var isPanelMode = container._isInline === false;
  var actionsHtml = isPanelMode ? '' :
    '<div class="preset-actions-compact">' +
      '<button class="w10-btn" id="presetSaveBtn" title="保存当前提示词">+</button>' +
      '<button class="w10-btn" id="presetRefreshBtn" title="刷新预设">R</button>' +
    '</div>';
  container.innerHTML =
    '<div class="w10-panel preset-list-panel">' +
      '<div id="presetCategoryBar" class="preset-cat-bar"></div>' +
      '<div id="presetListArea" class="preset-list-area' + (isPanelMode ? ' preset-list-scroll' : '') + '"></div>' +
      actionsHtml +
    '</div>';
  _updateCategoryBar(container);
  _renderNarrowList(container, isPanelMode);
  _bindNarrowActions(container);
}

function _renderNarrowList(container, showAll) {
  var area = container.querySelector('#presetListArea');
  if (!area) return;
  var filtered = _filterPresets(_currentFilter);
  // 完全不截断: 一次性列全 (列表区可滚动)
  var show = filtered;
  if (!show.length) {
    area.innerHTML = '<div class="preset-empty">无匹配预设</div>';
    return;
  }
  area.innerHTML = '';
  TileAPI.log('[presets] _renderNarrowList rendering ' + show.length + ' rows', 'info');
  show.forEach(function(preset) {
    var row = document.createElement('div');
    // 虚拟示例行: 紧凑样式, 无收藏星, 点击展开 kao 面板
    if (preset._virtual) {
      row.className = 'preset-item preset-item-compact preset-item-example';
      row.dataset.presetId = preset.id || '';
      row.innerHTML =
        '<span class="preset-example-icon">✨</span>' +
        '<span class="preset-item-title">' + _esc(preset.title || '示例') + '</span>' +
        '<span class="preset-example-go">›</span>';
      row.addEventListener('click', function() { _loadPreset(preset); });
      area.appendChild(row);
      return;
    }
    row.className = 'preset-item preset-item-compact' + (preset._isForge ? ' preset-item-forge' : '');
    row.dataset.presetId = preset.id || '';
    row.innerHTML =
      (preset._isForge ? '<span class="preset-forge-flag" title="Forge预设">F</span>' : '') +
      '<span class="preset-star' + (preset.starred ? ' starred' : '') + '" data-preset-star="' + _esc(preset.id) + '">' +
        (preset.starred ? '\u2605' : '\u2606') +
      '</span>' +
      '<span class="preset-item-title">' + _esc(preset.title || '未命名') + '</span>';
    row.addEventListener('click', function(e) {
      TileAPI.log('[presets] NARROW row listener triggered, target=' + e.target.tagName, 'info');
      if (e.target.hasAttribute('data-preset-star')) { TileAPI.log('[presets] star attr hit, skip', 'warn'); return; }
      _loadPreset(preset);
    });
    _bindStarClick(row, preset);
    area.appendChild(row);
  });
}

function _bindNarrowActions(container) {
  var saveBtn = container.querySelector('#presetSaveBtn');
  if (saveBtn) saveBtn.addEventListener('click', function() { _showSaveDialog(container); });
  var refreshBtn = container.querySelector('#presetRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', function() {
    TileAPI.sendToHost('refreshPresets');
    TileAPI.toast('正在刷新...', 'info');
  });
}

// --- square: search + flat list, no category grouping ---
function _renderSquare(container) {
  // panel-mode 下隐藏保存/刷新/导入(和主页一致)
  var isPanelMode = container._isInline === false;
  var actionsHtml = isPanelMode ? '' :
    '<div class="preset-actions-row">' +
      '<button class="w10-btn w10-btn-accent" id="presetSaveBtn">保存当前</button>' +
      '<button class="w10-btn" id="presetRefreshBtn">刷新</button>' +
      '<button class="w10-btn" id="presetImportBtn">导入</button>' +
    '</div>';
  container.innerHTML =
    '<div class="w10-panel preset-list-panel">' +
      '<div id="presetCategoryBar" class="preset-cat-bar"></div>' +
      '<div id="presetListArea" class="preset-list-area preset-list-scroll"></div>' +
      actionsHtml +
    '</div>';
  _updateCategoryBar(container);
  _renderFlatList(container, 30);
  _bindSquareActions(container);
}

function _bindSquareActions(container) {
  var saveBtn = container.querySelector('#presetSaveBtn');
  if (saveBtn) saveBtn.addEventListener('click', function() { _showSaveDialog(container); });
  var refreshBtn = container.querySelector('#presetRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', function() {
    TileAPI.sendToHost('refreshPresets');
    TileAPI.toast('正在刷新...', 'info');
  });
  var importBtn = container.querySelector('#presetImportBtn');
  if (importBtn) importBtn.addEventListener('click', function() { TileAPI.sendToHost('importPreset'); });
}

// --- wideshort: left list, right action buttons ---
function _renderWideShort(container) {
  var isPanelMode = container._isInline === false;
  var actionsHtml = isPanelMode ? '' :
    '<div class="preset-horiz-right">' +
      '<div class="w10-section-title">操作</div>' +
      '<button class="w10-btn w10-btn-accent preset-action-btn" id="presetSaveBtn">保存当前提示词</button>' +
      '<button class="w10-btn preset-action-btn" id="presetImportBtn">导入预设</button>' +
      '<button class="w10-btn preset-action-btn" id="presetExportBtn">导出预设</button>' +
      '<button class="w10-btn preset-action-btn" id="presetRefreshBtn">刷新预设</button>' +
      '<button class="w10-btn preset-action-btn" id="presetOpenFolderBtn">打开文件夹</button>' +
    '</div>';
  container.innerHTML =
    '<div class="w10-panel preset-list-panel">' +
      '<div class="preset-layout-horiz">' +
        '<div class="preset-horiz-left">' +
          '<div id="presetCategoryBar" class="preset-cat-bar"></div>' +
          '<div id="presetListArea" class="preset-list-area preset-list-scroll"></div>' +
        '</div>' +
        actionsHtml +
      '</div>' +
    '</div>';
  _updateCategoryBar(container);
  _renderFlatList(container, 50);
  _bindAllActions(container);
}

// --- wide: category groups, collapsible, search, all buttons ---
function _renderWide(container) {
  var isPanelMode = container._isInline === false;
  var toolbarHtml = isPanelMode ? '' :
    '<div class="preset-toolbar">' +
      '<button class="w10-btn w10-btn-accent" id="presetSaveBtn">保存当前提示词</button>' +
      '<button class="w10-btn" id="presetImportBtn">导入</button>' +
      '<button class="w10-btn" id="presetExportBtn">导出</button>' +
      '<button class="w10-btn" id="presetRefreshBtn">刷新</button>' +
      '<button class="w10-btn" id="presetOpenFolderBtn">打开文件夹</button>' +
    '</div>';
  container.innerHTML =
    '<div class="w10-panel preset-list-panel">' +
      '<div id="presetCategoryBar" class="preset-cat-bar"></div>' +
      toolbarHtml +
      '<div id="presetListArea" class="preset-list-area preset-list-scroll"></div>' +
    '</div>';
  _updateCategoryBar(container);
  _renderGroupedList(container);
  _bindAllActions(container);
}

// 分类过滤提示条:显示当前筛选 + 清除按钮
function _updateCategoryBar(container) {
  var bar = container.querySelector('#presetCategoryBar');
  if (!bar) return;
  var label;
  if (_currentCategory) {
    label = _bodyCatName(_currentCategory);
    if (_currentSub) label += ' / ' + _currentSub;
  } else if (_currentFilter) {
    label = '搜索: "' + _currentFilter + '"';
  } else {
    label = '全部预设';
  }
  bar.style.display = '';
  bar.innerHTML =
    '<button class="preset-back-btn" id="presetBackBtn" title="关闭分类">×</button>' +
    '<span class="preset-cat-label">' + _esc(label) + '</span>' +
    '<button class="preset-search-toggle" id="presetListSearchToggle" title="搜索">🔍</button>' +
    '<div class="preset-list-search preset-list-search-hidden" id="presetListSearchWrap">' +
      '<input class="w10-input" id="presetSearch" placeholder="搜索(中文/拼音首字母)..." value="' + _esc(_currentFilter) + '">' +
    '</div>';
  var backBtn = bar.querySelector('#presetBackBtn');
  if (backBtn) backBtn.addEventListener('click', function() {
    _currentCategory = null;
    _currentSub = null;
    _currentFilter = '';
    _currentView = 'home';
    TileAPI.state.set('bodypreset.currentCategory', null);
    TileAPI.state.set('bodypreset.currentSub', null);
    TileAPI.emit('bodypreset:select', { category: null, sub: null });
    _switchViewWith(container, _detectLayout(container), 'right');
  });

  // 搜索放大镜切换
  var searchToggle = bar.querySelector('#presetListSearchToggle');
  var searchWrap = bar.querySelector('#presetListSearchWrap');
  var searchInput = bar.querySelector('#presetSearch');
  if (searchToggle && searchWrap && searchInput) {
    // 有 filter 时默认展开
    if (_currentFilter) {
      searchWrap.classList.remove('preset-list-search-hidden');
      searchToggle.classList.add('active');
    }
    searchToggle.addEventListener('click', function(e) {
      e.stopPropagation();
      var willShow = searchWrap.classList.contains('preset-list-search-hidden');
      searchWrap.classList.toggle('preset-list-search-hidden', !willShow);
      searchToggle.classList.toggle('active', willShow);
      if (willShow) setTimeout(function() { searchInput.focus(); }, 50);
    });
    var _doListSearch = function() {
      var val = searchInput.value;
      if (_searchTimer) clearTimeout(_searchTimer);
      _searchTimer = setTimeout(function() {
        _currentFilter = val;
        // 输入搜索词时跨分类搜索 (跟 home 视图行为一致), 清掉 lingering 的分类锁
        // 用户清空搜索框时不动 — 让分类筛选状态保留
        if (val && val.trim()) _currentCategory = null;
        var layout = _detectLayout(container);
        _renderList(container, layout);
      }, 200);
    };
    // 中文输入法保护
    searchInput.addEventListener('compositionstart', function() { searchInput._composing = true; });
    searchInput.addEventListener('compositionend', function() { searchInput._composing = false; _doListSearch(); });
    searchInput.addEventListener('input', function() {
      if (searchInput._composing) return;
      _doListSearch();
    });
  }
}

function _detectLayout(container) {
  var w = container.clientWidth || 400;
  var h = container.clientHeight || 300;
  if (w < 200) return 'narrow';
  if (w < 300 && h > w * 1.3) return 'tall';
  if (w >= 400 && w > h * 1.8) return 'wideshort';
  if (w < 400) return 'square';
  return 'wide';
}

// ========== 列表渲染 ==========

/** 渲染列表入口（根据layout调用对应渲染） */
function _renderList(container, layout) {
  var isPanelMode = container._isInline === false;
  // 窄/高布局一律用 square 渲染(跟 _renderPanel 保持一致)
  if (layout === 'narrow' || layout === 'tall') layout = 'square';
  if (layout === 'narrow' || layout === 'tall') {
    _renderNarrowList(container, isPanelMode);
  } else if (layout === 'wide') {
    _renderGroupedList(container);
  } else {
    _renderFlatList(container, layout === 'square' ? 30 : 50);
  }
}

/** 扁平列表（square / wideshort） */
function _renderFlatList(container, limit) {
  var area = container.querySelector('#presetListArea');
  if (!area) return;
  var filtered = _filterPresets(_currentFilter);
  if (!filtered.length) {
    var all = _getPresets();
    area.innerHTML = '<div class="preset-empty">' +
      (all.length ? '无匹配结果' : '无预设，请刷新或导入') + '</div>';
    return;
  }
  area.innerHTML = '';
  filtered.forEach(function(preset) {
    area.appendChild(_createPresetRow(preset, false));
  });
}

/** 分组列表（wide） */
function _renderGroupedList(container) {
  var area = container.querySelector('#presetListArea');
  if (!area) return;
  var filtered = _filterPresets(_currentFilter);
  if (!filtered.length) {
    var all = _getPresets();
    area.innerHTML = '<div class="preset-empty">' +
      (all.length ? '无匹配结果' : '无预设，请刷新或导入') + '</div>';
    return;
  }
  area.innerHTML = '';
  var grouped = _groupByCategory(filtered);
  // 读取折叠状态
  var collapsed = TileAPI.storage.get('presets.collapsed') || {};

  grouped.order.forEach(function(cat) {
    var items = grouped.groups[cat];
    // 折叠状态: 当前在分类筛选下永远展开; 在搜索状态下也强制展开 (避免命中预设落在折叠分组里看不到)
    var inSearchMode = (_currentFilter || '').trim().length > 0;
    var isCollapsed = (_currentCategory || inSearchMode) ? false : !!collapsed[cat];

    // 分类头
    var header = document.createElement('div');
    header.className = 'preset-group-header';
    header.innerHTML =
      '<span class="preset-group-arrow' + (isCollapsed ? ' collapsed' : '') + '">\u25BE</span>' +
      '<span class="preset-group-name">' + _esc(_bodyCatName(cat)) + '</span>' +
      '<span class="preset-group-count">' + items.length + '</span>';
    // 筛选状态(分类联动 / 搜索)下禁用折叠交互, 避免命中结果被意外折回去
    if (!_currentCategory && !inSearchMode) {
      header.addEventListener('click', function() {
        var c = TileAPI.storage.get('presets.collapsed') || {};
        c[cat] = !c[cat];
        TileAPI.storage.set('presets.collapsed', c);
        var arrow = header.querySelector('.preset-group-arrow');
        var body = header.nextElementSibling;
        if (c[cat]) {
          if (arrow) arrow.classList.add('collapsed');
          if (body) body.classList.add('collapsed');
        } else {
          if (arrow) arrow.classList.remove('collapsed');
          if (body) body.classList.remove('collapsed');
        }
      });
    } else {
      header.style.cursor = 'default';
    }
    area.appendChild(header);

    // 分类内容
    var groupBody = document.createElement('div');
    groupBody.className = 'preset-group-body' + (isCollapsed ? ' collapsed' : '');
    items.forEach(function(preset) {
      groupBody.appendChild(_createPresetRow(preset, true));
    });
    area.appendChild(groupBody);
  });
}

/** 创建单个预设行 */
function _createPresetRow(preset, showCategory) {
  var row = document.createElement('div');

  // 虚拟示例行: 无收藏星 / 无删除, 点击直接展开 kao 面板
  if (preset._virtual) {
    row.className = 'preset-item preset-item-example';
    row.dataset.presetId = preset.id || '';
    row.innerHTML =
      '<span class="preset-example-icon">✨</span>' +
      '<div class="preset-item-info">' +
        '<div class="preset-item-title">' + _esc(preset.title || '示例') + '</div>' +
      '</div>' +
      '<span class="preset-example-go">›</span>';
    row.addEventListener('click', function() { _loadPreset(preset); });
    return row;
  }

  row.className = 'preset-item' + (preset._isForge ? ' preset-item-forge' : '');
  row.dataset.presetId = preset.id || '';
  var forgeFlag = preset._isForge ? '<span class="preset-forge-flag" title="Forge预设">F</span>' : '';

  row.innerHTML =
    forgeFlag +
    '<span class="preset-star' + (preset.starred ? ' starred' : '') + '" data-preset-star="' + _esc(preset.id) + '">' +
      (preset.starred ? '\u2605' : '\u2606') +
    '</span>' +
    '<div class="preset-item-info">' +
      '<div class="preset-item-title">' + _esc(preset.title || '未命名') + '</div>' +
    '</div>' +
    '<div class="preset-item-actions">' +
      (preset._isFactory
        ? ''
        : '<button class="w10-btn preset-item-btn preset-item-btn-del" data-preset-delete="' + _esc(preset.id) + '" title="删除">\u00D7</button>') +
    '</div>';

  // Load on click (but not on star/action buttons / header / empty)
  row.addEventListener('click', function(e) {
    TileAPI.log('[presets] CLICK target=' + (e.target.tagName||'?') + '.' + (e.target.className||'?') + ' preset="' + (preset && preset.title || '?') + '"', 'info');
    if (e.target.closest('[data-preset-star]')) { TileAPI.log('[presets] 被 star 拦截', 'warn'); return; }
    if (e.target.closest('[data-preset-delete]')) { TileAPI.log('[presets] 被 delete 拦截', 'warn'); return; }
    _loadPreset(preset);
  });

  // Star toggle
  _bindStarClick(row, preset);

  // Delete
  var deleteBtn = row.querySelector('[data-preset-delete]');
  if (deleteBtn) deleteBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    _deletePreset(preset);
  });

  return row;
}

// ========== 搜索绑定 ==========

function _bindSearch(container, layout) {
  var searchInput = container.querySelector('#presetSearch');
  if (!searchInput) return;
  var _doSearch = function() {
    var val = searchInput.value;
    if (_searchTimer) clearTimeout(_searchTimer);
    _searchTimer = setTimeout(function() {
      _currentFilter = val;
      // 跟 home/list 一致: 有搜索词时跨分类搜
      if (val && val.trim()) _currentCategory = null;
      _renderList(container, layout);
    }, 200);
  };
  // 中文输入法保护
  searchInput.addEventListener('compositionstart', function() { searchInput._composing = true; });
  searchInput.addEventListener('compositionend', function() { searchInput._composing = false; _doSearch(); });
  searchInput.addEventListener('input', function() {
    if (searchInput._composing) return;
    _doSearch();
  });
}

// ========== 操作按钮绑定 ==========

function _bindAllActions(container) {
  var saveBtn = container.querySelector('#presetSaveBtn');
  if (saveBtn) saveBtn.addEventListener('click', function() { _showSaveDialog(container); });

  var importBtn = container.querySelector('#presetImportBtn');
  if (importBtn) importBtn.addEventListener('click', function() { TileAPI.sendToHost('importPreset'); });

  var exportBtn = container.querySelector('#presetExportBtn');
  if (exportBtn) exportBtn.addEventListener('click', function() {
    // Export all presets (prompt user to pick via backend file dialog)
    var all = _getPresets();
    if (!all.length) { TileAPI.toast('没有可导出的预设', 'error'); return; }
    TileAPI.sendToHost('exportPreset', { preset: all });
    TileAPI.toast('正在导出...', 'info');
  });

  var refreshBtn = container.querySelector('#presetRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', function() {
    TileAPI.sendToHost('refreshPresets');
    TileAPI.toast('正在刷新...', 'info');
  });

  var openFolderBtn = container.querySelector('#presetOpenFolderBtn');
  if (openFolderBtn) openFolderBtn.addEventListener('click', function() {
    TileAPI.sendToHost('openPresetFolder');
  });
}

// ========== 核心操作 ==========

/** 加载预设到提示词 */
function _loadPreset(preset) {
  // 虚拟示例: 不载入提示词, 直接全屏展开「尻特效(kao)」磁贴
  if (preset && preset._action === 'expandKao') {
    if (TileAPI.getTileState && !TileAPI.getTileState('kao')) {
      TileAPI.toast('请先把「尻特效」磁贴放到桌面上再打开', 'warn');
      return;
    }
    TileAPI.expandTile('kao');
    return;
  }

  // Forge 预设: 把正向提示词显示到提示词磁贴,同时广播给 tile-forge 填 forge 参数
  if (preset && preset._isForge) {
    TileAPI.log('[presets] _loadPreset(forge): title="' + (preset.title || '?') + '"', 'info');
    var forgeData = preset._forgeData || {};
    var forgeText = forgeData.positivePrompt || '';
    // 关键: 必须在 emit('prompt:changed') 之前把新预设的参数写进 forge.* storage.
    // 否则提示词磁贴重绘的 forge 参数面板会读到上一次预设的旧值
    // (race: prompt:changed → 提示词磁贴渲染读 storage → 此时 forge:applyPreset 还没派发, storage 还是旧的)
    if (typeof forgeData.positivePrompt === 'string') TileAPI.storage.set('forge.positivePrompt', forgeData.positivePrompt);
    if (typeof forgeData.negativePrompt === 'string') TileAPI.storage.set('forge.negativePrompt', forgeData.negativePrompt);
    if (forgeData.step)          TileAPI.storage.set('forge.steps', forgeData.step);
    if (forgeData.redrawAmount)  TileAPI.storage.set('forge.denoise', forgeData.redrawAmount);
    if (forgeData.resolution)    TileAPI.storage.set('forge.resolution', forgeData.resolution);
    if (forgeData.imageCount)    TileAPI.storage.set('forge.batchSize', forgeData.imageCount);
    if (forgeData.model)         TileAPI.storage.set('forge.model', forgeData.model);
    if (forgeData.selectedName)  TileAPI.storage.set('forge.sampler', forgeData.selectedName);
    // 同步到 prompt.text,提示词磁贴就能显示 forge 的正向提示词
    TileAPI.state.set('prompt.text', forgeText);
    TileAPI.storage.set('prompt.lastText', forgeText);
    TileAPI.state.set('prompt.lastPresetTitle', preset.title || '');
    TileAPI.state.set('prompt.lastPresetKind', 'forge');
    TileAPI.state.set('prompt.lastPresetId', preset.id || '');
    TileAPI.state.set('prompt.lastPresetMeta', {
      model: forgeData.model || '',
      sampler: forgeData.selectedName || '',
      steps: forgeData.step || '',
      denoise: forgeData.redrawAmount || '',
      resolution: forgeData.resolution || '',
      batch: forgeData.imageCount || '',
      lora: forgeData.lora || '',
      negativePrompt: forgeData.negativePrompt || '',
    });
    TileAPI.emit('prompt:changed', { text: forgeText, source: 'preset' });
    TileAPI.emit('preset:loaded', { id: preset.id, content: forgeText, title: preset.title, refImages: [] });
    // 广播给 tile-forge 填 forge 参数 (这里会再调一次 _persistPresetToStorage, 重复写但值相同, 无副作用)
    TileAPI.emit('forge:applyPreset', {
      id: preset.id,
      title: preset.title,
      data: forgeData,
    });
    TileAPI.toast('已载入 Forge 预设: ' + (preset.title || ''), 'success');
    return;
  }

  var content = preset && preset.content || '';
  TileAPI.log('[presets] _loadPreset: title="' + (preset && preset.title || '?') + '" content len=' + content.length, 'info');
  if (!content) {
    TileAPI.log('[presets] content 为空,中止载入', 'error');
    TileAPI.toast('预设 content 为空', 'error');
    return;
  }
  TileAPI.state.set('prompt.text', content);
  TileAPI.storage.set('prompt.lastText', content);
  TileAPI.state.set('prompt.lastPresetTitle', preset.title || '');
  TileAPI.state.set('prompt.lastPresetKind', 'banana');
  TileAPI.state.set('prompt.lastPresetId', preset.id || '');
  TileAPI.state.set('prompt.lastPresetMeta', null);
  if (preset.refImages && preset.refImages.length) {
    TileAPI.state.set('refimages.list', preset.refImages);
  }
  TileAPI.log('[presets] emit prompt:changed + preset:loaded', 'info');
  TileAPI.emit('prompt:changed', { text: content, source: 'preset' });
  TileAPI.emit('preset:loaded', { id: preset.id, content: content, title: preset.title, refImages: preset.refImages });
  TileAPI.toast('已载入: ' + (preset.title || '预设'), 'success');
}

/** 收藏/取消收藏 */
function _bindStarClick(row, preset) {
  var starEl = row.querySelector('[data-preset-star]');
  if (!starEl) return;
  starEl.addEventListener('click', function(e) {
    e.stopPropagation();
    var list = _getPresets();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === preset.id) {
        list[i].starred = !list[i].starred;
        preset.starred = list[i].starred;
        break;
      }
    }
    // forge 预设的收藏状态单独落盘(host 的 savePresetsFile 不处理 forge)
    if (preset._isForge) {
      var forgeStars = TileAPI.storage.get('forge.starred') || {};
      if (preset.starred) forgeStars[preset.id] = true;
      else delete forgeStars[preset.id];
      TileAPI.storage.set('forge.starred', forgeStars);
      TileAPI.state.set('presets.list', list);
    } else {
      _setPresets(list);
      TileAPI.sendToHost('savePresetsFile', { action: 'save', preset: preset });
    }
    // Update star display inline
    starEl.textContent = preset.starred ? '\u2605' : '\u2606';
    starEl.classList.toggle('starred', preset.starred);
    TileAPI.emit('presets:changed');
  });
}

/** 删除预设 */
function _deletePreset(preset) {
  TileAPI.confirm('确定删除预设 "' + (preset.title || '未命名') + '"？').then(function(yes) {
    if (!yes) return;
    var list = _getPresets();
    var newList = list.filter(function(p) { return p.id !== preset.id; });
    _setPresets(newList);
    TileAPI.sendToHost('savePresetsFile', { action: 'delete', preset: preset });
    TileAPI.emit('presets:changed');
    TileAPI.toast('已删除: ' + (preset.title || '预设'), 'info');
  });
}

/** 保存当前提示词为预设 — 弹出对话框 */
function _showSaveDialog(container) {
  var currentText = TileAPI.state.get('prompt.text') || '';
  var currentRefImages = TileAPI.state.get('refimages.list') || [];

  // 当前选中的剪影分类 → 作为下拉默认选项(用户从剪影上点了某个部位再保存,自动选中)
  var currentBodyCat = TileAPI.state.get('bodypreset.currentCategory') || '';

  // 分类下拉选项:从 tile-bodypreset 的 CATS 拿;失败回退到空数组(下拉只有"未分类")
  var bodyCats = (window._bodyCategories && Array.isArray(window._bodyCategories)) ? window._bodyCategories : [];
  var catOptionsHtml = '<option value=""' + (currentBodyCat ? '' : ' selected') + '>未分类</option>' +
    bodyCats.map(function(c) {
      var sel = (c.id === currentBodyCat) ? ' selected' : '';
      return '<option value="' + _esc(c.id) + '"' + sel + '>' + _esc(c.name) + '</option>';
    }).join('');

  // 用 overlay 模拟对话框
  var overlay = document.createElement('div');
  overlay.className = 'preset-save-overlay';
  overlay.innerHTML =
    '<div class="preset-save-dialog">' +
      '<div class="preset-save-title">保存预设</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">预设名称</div></div>' +
        '<div class="w10-row-right" style="flex:1;"><input class="w10-input" id="presetSaveName" placeholder="输入预设名称..."></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">分类</div></div>' +
        '<div class="w10-row-right" style="flex:1;"><select class="w10-select" id="presetSaveCat" style="width:100%;">' + catOptionsHtml + '</select></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">子分类</div></div>' +
        '<div class="w10-row-right" style="flex:1;"><input class="w10-input" id="presetSaveSubCat" placeholder="子分类（可选）"></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left">' +
          '<div class="w10-row-label">提示词内容</div>' +
          '<div class="w10-row-desc">' + (currentText ? _esc(currentText.substring(0, 80)) + (currentText.length > 80 ? '...' : '') : '(空)') + '</div>' +
        '</div>' +
      '</div>' +
      (currentRefImages.length
        ? '<div class="w10-row"><div class="w10-row-left"><div class="w10-row-label">包含 ' + currentRefImages.length + ' 张参考图</div></div></div>'
        : '') +
      '<div class="preset-save-btns">' +
        '<button class="w10-btn" id="presetSaveCancel">取消</button>' +
        '<button class="w10-btn w10-btn-accent" id="presetSaveConfirm">保存</button>' +
      '</div>' +
    '</div>';

  container.appendChild(overlay);

  var nameInput = overlay.querySelector('#presetSaveName');
  if (nameInput) nameInput.focus();

  var cancelBtn = overlay.querySelector('#presetSaveCancel');
  if (cancelBtn) cancelBtn.addEventListener('click', function() { overlay.remove(); });

  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) overlay.remove();
  });

  var confirmBtn = overlay.querySelector('#presetSaveConfirm');
  if (confirmBtn) confirmBtn.addEventListener('click', function() {
    var name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
      TileAPI.toast('请输入预设名称', 'error');
      return;
    }
    var catInput = overlay.querySelector('#presetSaveCat');
    var subCatInput = overlay.querySelector('#presetSaveSubCat');
    var newPreset = {
      id: _uid(),
      _isFactory: false,
      title: name,
      content: currentText,
      category: catInput ? catInput.value.trim() : '',
      subCategory: subCatInput ? subCatInput.value.trim() : '',
      refImages: currentRefImages.length ? currentRefImages : undefined,
      starred: false,
    };
    var list = _getPresets();
    list.push(newPreset);
    _setPresets(list);
    TileAPI.sendToHost('savePresetsFile', { action: 'save', preset: newPreset });
    TileAPI.emit('presets:changed');
    TileAPI.toast('已保存预设: ' + name, 'success');
    overlay.remove();
  });
}

// ========== 跨磁贴入口 ==========
// 让其他磁贴(如 tile-bodypreset)触发"保存当前预设"对话框,
// 复用本磁贴的 _showSaveDialog,无论本磁贴当前是否展开
TileAPI.on('presets:requestSaveDialog', function() {
  var host = document.body || document.documentElement;
  if (host) _showSaveDialog(host);
});

})();
