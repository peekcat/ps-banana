// ============================================================
//  tile-poster.js — 海报排版磁贴
//
//  功能:用 GPT-Image 给 cosplay 圈做海报/接单图排版
//  两个大类:
//    - 接单图排版(commission):二次元摄影师接单宣传图
//    - 正片排版(portfolio):cosplay 玩家发布作品
//
//  仅支持全屏展开(full mode),不做就地展开
//  状态全部存在 state(切换大类时不丢失编辑)
// ============================================================
(function() {
'use strict';

if (!window._posterPrompts) {
  // prompts 文件没加载,后面 onExpand 会再 fallback
  console.warn('[poster] _posterPrompts 数据未加载');
}

// ========== 常量 ==========
var MAX_IMAGES = 16;

// 服务通道:海报只支持 grs/aji 两种(无 others),默认推荐 GRS(国内更稳);按槽位顺序排
function _providerOptions() {
  return TileAPI.slotOrder().filter(function(e) { return e === 'grs' || e === 'aji'; }).map(function(eng) {
    var def = eng === 'grs' ? (TileAPI.computeBrand() + ' (国内推荐)') : 'AJI';
    return { id: eng, label: TileAPI.slotLabel(eng, def) };
  });
}

// 各 provider 下的模型列表(GRS 多一个 vip 版,支持 4K)
var GPT_MODELS_AJI = [
  { id: 'gpt-image-2', label: 'GPT-Image-2' }
];
var GPT_MODELS_GRS = [
  { id: 'gpt-image-2',     label: 'GPT-Image-2 (标准 · 最高 2K)' },
  { id: 'gpt-image-2-vip', label: 'GPT-Image-2 VIP (支持 4K · 推荐)' }
];

// 各 (provider, model) 下支持的分辨率
//   AJI gpt-image-2:        1K / 2K / 4K(AJI 自家定价)
//   GRS gpt-image-2:        1K / 2K       (官方文档明示)
//   GRS gpt-image-2-vip:    1K / 2K / 4K  (VIP 才能 4K)
var GPT_SIZES_AJI_STD = [
  { id: '1K', label: '1K' },
  { id: '2K', label: '2K' },
  { id: '4K', label: '4K (推荐)' }
];
var GPT_SIZES_GRS_STD = [
  { id: '1K', label: '1K' },
  { id: '2K', label: '2K (推荐)' }
];
var GPT_SIZES_GRS_VIP = [
  { id: '1K', label: '1K' },
  { id: '2K', label: '2K' },
  { id: '4K', label: '4K (推荐)' }
];

// AJI 支持的比例
var GPT_ASPECTS_AJI = [
  { id: '16:9', label: '16:9 横屏 (推荐)' },
  { id: '9:16', label: '9:16 竖屏' },
  { id: '1:1', label: '1:1 方图' }
];
// GRS 支持的比例(文档说支持更多)
var GPT_ASPECTS_GRS = [
  { id: '16:9', label: '16:9 横屏 (推荐)' },
  { id: '9:16', label: '9:16 竖屏' },
  { id: '1:1', label: '1:1 方图' },
  { id: '3:2', label: '3:2 横屏' },
  { id: '2:3', label: '2:3 竖屏' },
  { id: '4:3', label: '4:3 横屏' },
  { id: '3:4', label: '3:4 竖屏' },
  { id: '21:9', label: '21:9 超宽' },
  { id: '9:21', label: '9:21 长竖' }
];

// 按 provider 拿模型列表
function _getModelsForProvider(provider) {
  return provider === 'grs' ? GPT_MODELS_GRS : GPT_MODELS_AJI;
}
// 按 (provider, model) 拿支持的分辨率列表
function _getGptSizes(provider, model) {
  if (provider === 'grs') {
    if (model === 'gpt-image-2-vip') return GPT_SIZES_GRS_VIP;
    return GPT_SIZES_GRS_STD;
  }
  return GPT_SIZES_AJI_STD;
}
function _getGptAspects(provider) {
  return provider === 'grs' ? GPT_ASPECTS_GRS : GPT_ASPECTS_AJI;
}

// 按指定 provider 拿连接配置(从 storage 直接读,不走 _settingsGetActiveConnection
// 那个函数只返回"当前激活的 provider"的配置,海报要按用户在面板里选的 provider 取)
function _getProviderConnection(provider) {
  if (provider !== 'grs' && provider !== 'aji') provider = 'grs';
  var url = TileAPI.storage.get('connection.' + provider + '.url') || '';
  var key = TileAPI.storage.get('connection.' + provider + '.key') || '';
  var grsKeyPending = false;
  var grsNeedLogin = false;
  // GRS 双路径: BYOK (填了 key 且没在云服务里关) 用自己的; 否则走云端 sub-key (proxy)
  // 切换开关: connection.grs.use_byok (TileAPI.compute.isUserByokActive 统一判定)
  if (provider === 'grs') {
    var byokActive = (window.TileAPI && TileAPI.compute && TileAPI.compute.isUserByokActive)
      ? TileAPI.compute.isUserByokActive() : !!key;
    if (!byokActive) {
      key = '';
      var cs = (window.TileAPI && TileAPI.compute && TileAPI.compute.getState) ? TileAPI.compute.getState() : null;
      var subKey = cs ? cs.key : '';
      if (subKey) {
        key = subKey;
      } else if (window._cloudIsLoggedIn && window._cloudIsLoggedIn()) {
        grsKeyPending = true;
        if (TileAPI.compute && TileAPI.compute.getKey) TileAPI.compute.getKey().catch(function(){});
      } else {
        grsNeedLogin = true;   // 托管模式没登录: 该提示登录, 不是让用户填 key
      }
    }
  }
  return { provider: provider, url: url, key: key, _grsKeyPending: grsKeyPending, _grsNeedLogin: grsNeedLogin };
}

// 影响海报面板显示的"夏算力"状态签名 —— 用于判定 compute:keyUpdated 是否真的需要重渲。
// 登录 / 恢复会话 / 对账 / 续杯都会连发 compute:keyUpdated; 若每次都整块重建面板
// (_renderPanel 是一次性同步重砌整面墙), 开面板瞬间就会被重建风暴卡死。
function _computeKeySig() {
  try {
    var C = window.TileAPI && TileAPI.compute;
    var s = (C && C.getState) ? C.getState() : {};
    var byok = (C && C.isUserByokActive && C.isUserByokActive()) ? '1' : '0';
    var logged = (window._cloudIsLoggedIn && window._cloudIsLoggedIn()) ? '1' : '0';
    var brand = TileAPI.computeBrand ? TileAPI.computeBrand() : '';
    return [s.mode || '', s.key ? 'k' : '', s.status || '', byok, logged, brand].join('|');
  } catch (e) { return ''; }
}

// (size,aspect) → 像素 — 跟 host 端 _mapGptSizeToPixels 行为一致,前端用于显示+算画布
function _gptSizeToPixels(sizeKey, aspectRatio) {
  var ar = (aspectRatio || '16:9').toLowerCase();
  var WIDE = ['16:9', '3:2', '4:3', '5:4'];
  var TALL = ['9:16', '2:3', '3:4', '4:5'];
  var isWide = WIDE.indexOf(ar) !== -1;
  var isTall = TALL.indexOf(ar) !== -1;
  var isSquare = (ar === '1:1');
  if (sizeKey === '4K') {
    if (isTall) return { w: 2160, h: 3840 };
    if (isSquare) return { w: 3840, h: 2160 }; // 4K 不支持 1:1 → 收敛到横屏
    return { w: 3840, h: 2160 };
  }
  if (sizeKey === '2K') {
    if (isSquare) return { w: 2048, h: 2048 };
    if (isTall) return { w: 1152, h: 2048 };
    return { w: 2048, h: 1152 };
  }
  if (isSquare) return { w: 1024, h: 1024 };
  if (isTall) return { w: 1024, h: 1536 };
  return { w: 1536, h: 1024 };
}

// ========== 模块状态(state-driven,切磁贴/切大类不丢) ==========
function _getCfg(category) {
  return TileAPI.state.get('poster.cfg.' + category) || _newCfg();
}
function _setCfg(category, cfg) {
  TileAPI.state.set('poster.cfg.' + category, cfg);
}

// 清理 cfg 里"def 已经找不到"的死引用
// 触发时机:每次 _renderPanel 之前
// 处理:
//   1. selections / inputs / uploads 里 sectionId 在 def 里不存在 → 删
//   2. selections 里 buttonId 在 def 对应的 section.buttons 里不存在 → 从数组中剔除
//   3. 用户改了 section 类型(单选→文本输入等),旧字段(selections/inputs/uploads)对应不上的 → 删
//   返回值:有修改返回 true(便于决定是否 _setCfg)
function _cleanCfgAgainstDef(category, def) {
  var cfg = _getCfg(category);
  if (!cfg || !def || !Array.isArray(def.sections)) return false;
  var changed = false;
  // 建索引:sectionId → section def
  var secById = {};
  for (var i = 0; i < def.sections.length; i++) secById[def.sections[i].id] = def.sections[i];

  // 清理 selections
  if (cfg.selections && typeof cfg.selections === 'object') {
    Object.keys(cfg.selections).forEach(function(secId) {
      var sec = secById[secId];
      if (!sec) {
        delete cfg.selections[secId];
        changed = true;
        return;
      }
      // 类型不匹配的保留方式:single/multi-select/toggle 用 selections;其他类型不该有
      if (sec.type !== 'single-select' && sec.type !== 'multi-select' && sec.type !== 'toggle') {
        delete cfg.selections[secId];
        changed = true;
        return;
      }
      // 单/多选时清掉 def 中已删除的 button id
      if (sec.type === 'single-select' || sec.type === 'multi-select') {
        var validIds = (sec.buttons || []).map(function(b) { return b.id; });
        var arr = cfg.selections[secId] || [];
        var filtered = arr.filter(function(id) { return validIds.indexOf(id) !== -1; });
        if (filtered.length !== arr.length) {
          cfg.selections[secId] = filtered;
          changed = true;
        }
      }
      // toggle 不需要做 button id 清理
    });
  }

  // 清理 inputs(只 text-input 才该有)
  if (cfg.inputs && typeof cfg.inputs === 'object') {
    Object.keys(cfg.inputs).forEach(function(secId) {
      var sec = secById[secId];
      if (!sec || sec.type !== 'text-input') {
        delete cfg.inputs[secId];
        changed = true;
      }
    });
  }

  // 清理 uploads(只 file-upload 才该有)
  if (cfg.uploads && typeof cfg.uploads === 'object') {
    Object.keys(cfg.uploads).forEach(function(secId) {
      var sec = secById[secId];
      if (!sec || sec.type !== 'file-upload') {
        delete cfg.uploads[secId];
        changed = true;
      }
    });
  }

  if (changed) _setCfg(category, cfg);
  return changed;
}

function _newCfg() {
  return {
    selections: {},      // sectionId -> [buttonId] (single 一个/multi 多个)
    inputs: {},          // sectionId -> 用户输入字符串
    uploads: {},         // sectionId -> { name, base64 }   (logo/avatar/qrcode)
    images: [],          // [{ source, ref, name, thumbBase64? }]  待排版的所有图片
    pages: { 1: [] },    // pageNum -> [imageIndex,...] 分组
    activePage: 1,
    multiplier: 1.5,     // 倍率,生成新项目时用
    rolls: 1,            // 每页 roll 几次(1-4),用户挑最爱的那张
    autofillText: '',    // 用户粘的待解析文本
    // 服务通道(默认 GRS):'grs' / 'aji'
    provider: 'grs',
    // 生成参数(命名上叫 aji 是历史遗留,实际两个 provider 共用这套字段)
    // 默认 gpt-image-2-vip:GRS 流推荐用 vip 才能上 4K;AJI 用户切过去时迁移逻辑会自动落到 gpt-image-2
    aji: {
      model:  'gpt-image-2-vip',
      size:   '4K',
      aspect: '16:9'
    }
  };
}

// ========== 当前激活的大类 ==========
function _getActiveCategory() {
  return TileAPI.state.get('poster.activeCategory') || 'commission';
}
function _setActiveCategory(cat) {
  TileAPI.state.set('poster.activeCategory', cat);
}

// ========== 工具 ==========
function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _uniq(arr) {
  var seen = {}, out = [];
  for (var i = 0; i < arr.length; i++) { if (!seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); } }
  return out;
}
// host 端 getSelectionAndImage 返回的 base64 可能是 PNG 也可能是 JPEG(取决于 state.compressFormat),
// 浏览器对错误 MIME 前缀直接拒渲染 → 图片空白。靠 base64 首字符自动选 MIME:
//   PNG: 'iVBOR...' (header 0x89 'P' 'N' 'G' = base64 '/9j/' 不会出现)
//   JPEG: '/9j/...' (header 0xFF 0xD8 = base64 'iVBO' 不会出现)
function _imgSrc(b64) {
  if (!b64) return '';
  var mime = (b64.charAt(0) === '/' ? 'image/jpeg' : 'image/png');
  return 'data:' + mime + ';base64,' + b64;
}

// ========== 正面 ==========
function renderFront(container, w, h) {
  if (w >= 2) {
    container.innerHTML =
      '<div class="tile-icon">📰</div>' +
      '<div class="tile-label">海报排版</div>' +
      '<div class="tile-desc">GPT-Image · Cosplay 排版</div>';
  } else {
    container.innerHTML =
      '<div class="tile-icon">📰</div>' +
      '<div class="tile-label">海报</div>';
  }
}

// ========== 全屏面板 ==========
var _activeContainer = null;
var _firstRender = true;   // 第一次渲染才放 stagger 入场动画;后续重渲(切大类/分页等)不闪

function _renderPanel(container) {
  var cat = _getActiveCategory();
  var defs = window._posterPrompts;
  if (!defs || !defs[cat]) {
    container.innerHTML = '<div class="w10-panel"><div class="poster-empty">提示词数据未加载</div></div>';
    return;
  }
  var def = defs[cat];

  // 渲染前先清理 cfg 中"def 已找不到"的死引用(用户改/删了预设之后留下的)
  _cleanCfgAgainstDef(cat, def);

  var inner =
      _renderTutorialBar() +
      _renderTabRow(defs, cat) +
      _renderStepAutofill(cat) +
      _renderStepSections(def, cat) +
      _renderStepImagePool(cat) +
      _renderStepPages(cat) +
      _renderStepGenerate(cat) +
      _renderStepPromptPreview(cat);

  // 修闪烁抽动(2026-07-10): 滚动容器 .w10-panel 外壳复用, 只换内容 —
  // 以前整面墙连壳重建, 滚动位置要靠双 rAF 两帧后才恢复, 用户每次重渲
  // 都看到"跳顶部→再跳回来"的抽动 + 整片图片重挂的闪烁。
  // 现在: 壳(=滚动容器)不动, scrollTop 天然保留, 零跳动。
  var prevPanel = container.querySelector('.w10-panel');
  if (prevPanel && !_firstRender) {
    prevPanel.classList.add('poster-no-anim');
    prevPanel.innerHTML = inner;
  } else {
    container.innerHTML = '<div class="w10-panel' + (_firstRender ? '' : ' poster-no-anim') + '">' + inner + '</div>';
  }

  _firstRender = false;
  _bindPanel(container);
}

// ========== 一过性教程面板 ==========
//   用户首次打开海报磁贴时弹出,讲清:
//     - 6 个 step 干啥用
//     - 3 个易混淆设计:为什么生成完会新建项目 / 倍率 / 多页
//   点「我知道了」后存 storage 永久不再弹(版本号 _v1,以后大改可以加 _v2 重新弹一遍)
// ========== 顶部「使用教程」按钮 + 就地展开容器 ==========
function _renderTutorialBar() {
  return '<div class="poster-tutorial-bar">' +
      '<button class="w10-btn" id="posterTutorialToggle" type="button">📖 使用教程</button>' +
    '</div>' +
    '<div class="poster-tutorial-inline" id="posterTutorialInline" style="display:none;"></div>';
}

// ========== 教程内容(就地展开用)==========
//   不再 append 到 body 做 fixed 遮罩弹窗 —— 那会在已经很重的海报首屏渲染上再叠一层导致卡死。
//   改为点顶部「📖 使用教程」按钮时,把这段 HTML 塞进面板内的 #posterTutorialInline 就地展开。
function _tutorialInnerHtml() {
  var html =
      '<div class="poster-tutorial-card poster-tutorial-card-inline">' +
        '<div class="poster-tutorial-head">' +
          '<div>' +
            '<div class="poster-tutorial-title">📰 海报排版 · 使用指南</div>' +
            '<div class="poster-tutorial-sub">为二次元摄影师 / Cosplayer 设计:接单宣传图 · 作品集封面</div>' +
          '</div>' +
        '</div>' +

        '<div class="poster-tutorial-body">' +

          '<div class="poster-tutorial-section">' +
            '<div class="poster-tutorial-section-title">🛠 操作流程(6 步)</div>' +
            '<ol class="poster-tutorial-steps">' +
              '<li><b>智能填写(可选)</b> — 把你的接单文案 / 角色设定整段贴进来,AI 自动识别工作室名/业务/报价/角色名等字段</li>' +
              '<li><b>风格设置</b> — 点选海报风格(动漫 KV / 暗调高级 / ACG 流行 等)、业务类型、文字风格;可点「🛠 管理预设」自定义</li>' +
              '<li><b>素材图片</b> — 在 PS 用矩形选框工具(M)框选样片区域,点「✂️ 从 PS 抓取选区」,可框多次抓多张</li>' +
              '<li><b>分页</b> — 把不同素材分配到不同页(每页 = 一张海报);可同一接单集内出多种主题</li>' +
              '<li><b>生成参数</b> — 选服务通道(GRS 国内推荐 / AJI)、模型、分辨率、比例、Roll 次数、新建文档倍率</li>' +
              '<li><b>开始生成</b> — 点蓝色生成按钮,等 AI 出图,自动建新 PS 项目贴回</li>' +
            '</ol>' +
          '</div>' +

          '<div class="poster-tutorial-section">' +
            '<div class="poster-tutorial-section-title">💡 三个容易困惑的设计</div>' +

            '<div class="poster-tutorial-faq">' +
              '<div class="poster-tutorial-faq-q">❓ 为什么生成完会自动新建一个 PS 项目?</div>' +
              '<div class="poster-tutorial-faq-a">' +
                'AI 生成的海报是排好版的<b>低清成图</b>,但你的样片是高清原档。新项目里会:' +
                '<ul>' +
                  '<li><b>顶层放 AI 生成的海报</b>(默认显示),作为版式骨架</li>' +
                  '<li><b>底层放你抓取的所有原始高清素材</b>(默认隐藏),叠在 AI 生成图相同位置</li>' +
                '</ul>' +
                '后期你只需要把 AI 海报里模糊的人物 / 道具区域做个蒙版露底,<b>把高清原图叠回去</b> — 排版还是 AI 的,清晰度回到原档。' +
              '</div>' +
            '</div>' +

            '<div class="poster-tutorial-faq">' +
              '<div class="poster-tutorial-faq-q">❓ 「新建文档倍率」是干嘛的?</div>' +
              '<div class="poster-tutorial-faq-a">' +
                'AI 输出的海报<b>最多到 4K</b>(GPT-Image-2-vip),但你拿这张图去发小红书 / B 站封面 / 微博头图 / 印刷,可能需要更大画布才能容下原图素材原始尺寸不被压缩。<br><br>' +
                '<b>例子</b>:GPT 输出 3840×2160,你的样片是 6000×4000,如果倍率 1x → 样片在新画布里只能缩到 3840 长边,损失一半像素。设倍率 2x → 新画布 7680×4320,样片能完整原尺寸贴入,不损失。' +
              '</div>' +
            '</div>' +

            '<div class="poster-tutorial-faq">' +
              '<div class="poster-tutorial-faq-q">❓ 「多页」用于什么场景?</div>' +
              '<div class="poster-tutorial-faq-a">' +
                '<b>三种典型用法</b>:' +
                '<ul>' +
                  '<li><b>同一项目多变体</b> — 同样的素材,AI 出 3 种排版备选(也可以单页加 Roll 次数)</li>' +
                  '<li><b>多主题打包</b> — 一次性生成"角色 A 主题"+"角色 B 主题"+"群像主题"等不同海报</li>' +
                  '<li><b>套餐交付</b> — 一个接单集里:首页用面样、第二页联系方式、第三页过往作品集 等</li>' +
                '</ul>' +
              '</div>' +
            '</div>' +
          '</div>' +

          '<div class="poster-tutorial-section poster-tutorial-example">' +
            '<div class="poster-tutorial-section-title">📌 营销实例:新接单海报</div>' +
            '<div class="poster-tutorial-example-body">' +
              '小七是个二次元 Cosplay 摄影师,想发一张接单宣传海报到小红书:<br><br>' +
              '1. STEP 1 把朋友圈接单文案整段粘贴 → AI 自动填好工作室名"小七影像"、报价"写真¥499/跟拍¥1999"<br>' +
              '2. STEP 2 选「动漫 KV 风」+「ACG 流行」业务标签风<br>' +
              '3. STEP 3 在 PS 里框选 4 张代表作的精彩区域,逐一抓取<br>' +
              '4. STEP 4 一页就够,默认分配所有素材到 P1<br>' +
              '5. STEP 5 GRS + gpt-image-2-vip + 4K + 16:9 + 倍率 2x(给小红书 / 微博发图都够大)<br>' +
              '6. 点生成 → AI 排版好后,打开新项目里的"原图"图层,把 AI 输出的脸部区域换回原图清晰版 → 发布' +
            '</div>' +
          '</div>' +

        '</div>' +
      '</div>';

  return html;
}

// ========== 顶部 tab 行 ==========
function _renderTabRow(defs, cat) {
  return '<div class="poster-tab-row">' +
    '<button class="w10-btn' + (cat === 'commission' ? ' w10-btn-accent' : '') + '" data-poster-tab="commission">' +
      '🎨 ' + _esc(defs.commission.label) +
    '</button>' +
    '<button class="w10-btn' + (cat === 'portfolio' ? ' w10-btn-accent' : '') + '" data-poster-tab="portfolio">' +
      '🎬 ' + _esc(defs.portfolio.label) +
    '</button>' +
  '</div>';
}

// ========== STEP ① 智能填写(可折叠) ==========
function _renderStepAutofill(cat) {
  var cfg = _getCfg(cat);
  var placeholder = (cat === 'commission')
    ? '粘贴你的接单文案...\n例如:\nCN:你的昵称\n场照接单\nQ:你的QQ号\nV:你的微信号\n4图980r 6图1200r ...\n擅长:战斗风\n联系微信预约'
    : '粘贴你的角色/作品设定描述...\n例如:\n角色名:雷电将军\n来源:原神\n世界观:稻妻雷神,执掌永恒\n气质:威严孤独,黑紫主调\n关键词:闪电、刀芒、樱花、和服、永恒';
  var hint = (cat === 'commission')
    ? '把你打的接单文案/价目表/朋友圈宣传贴进来,AI 自动识别工作室名/业务/报价/联系方式并填到下方各字段。'
    : '把角色背景/作品设定贴进来,AI 自动判断最契合的叙事类型/色彩氛围/几何/字体,并生成主标题、副标题、台词。';
  var hasText = !!(cfg.autofillText && cfg.autofillText.trim());

  return '<details class="poster-fold"' + (hasText ? ' open' : '') + '>' +
    '<summary>' +
      '🪄 STEP 1 · 智能填写' +
      '<span class="poster-fold-meta">' + (hasText ? '已填' + cfg.autofillText.length + '字' : '可选') + '</span>' +
    '</summary>' +
    '<div class="poster-autofill-hint">' + _esc(hint) + '</div>' +
    '<textarea class="poster-autofill-input" id="posterAutofillInput" rows="6" placeholder="' + _esc(placeholder) + '">' + _esc(cfg.autofillText || '') + '</textarea>' +
    '<div class="poster-autofill-actions">' +
      '<button class="w10-btn w10-btn-accent" id="posterAutofillBtn">🪄 一键自动填写</button>' +
      '<span class="poster-autofill-status" id="posterAutofillStatus"></span>' +
    '</div>' +
  '</details>';
}

// ========== STEP ② 风格设置(各 sections) ==========
function _renderStepSections(def, cat) {
  var cfg = _getCfg(cat);
  var html = '<div class="w10-section-title poster-step-title-row">' +
      '🎨 STEP 2 · 风格设置' +
      '<button class="poster-manage-btn" id="posterManageBtn" title="管理预设(添加/编辑/删除选项)">🛠 管理预设</button>' +
    '</div>' +
    '<div class="w10-row" style="display:block;padding-bottom:8px;">' +
      '<div class="w10-row-desc" style="font-size:10px;line-height:1.5;">' + _esc(def.desc) + '</div>' +
    '</div>';

  for (var i = 0; i < def.sections.length; i++) {
    var sec = def.sections[i];
    html += _renderSectionRow(sec, cfg);
  }
  return html;
}

function _renderSectionRow(sec, cfg) {
  // 含 pill 组(数量 >=4)或长输入框的 row 强制纵向堆叠 — label 在上、控件在下,
  // 避免横向布局时 pill 撑大右栏把 label 挤成一字一列。
  // toggle / file-upload / pill 数量 <4 的 single-select 保持横向。
  var stack = '';
  if (sec.type === 'single-select' || sec.type === 'multi-select') {
    if ((sec.buttons || []).length >= 4) stack = ' poster-row-stack';
  }
  if (sec.type === 'text-input') stack = ' poster-row-stack';

  var labelExtra = '';
  if (sec.type === 'single-select') labelExtra = '<div class="w10-row-desc">单选</div>';
  else if (sec.type === 'multi-select') labelExtra = '<div class="w10-row-desc">多选</div>';
  else if (sec.type === 'file-upload') labelExtra = '<div class="w10-row-desc">从 PS 选区抓取 · 算入 16 张配额</div>';

  return '<div class="w10-row' + stack + '">' +
    '<div class="w10-row-left">' +
      '<div class="w10-row-label">' + _esc(sec.label) + '</div>' +
      labelExtra +
    '</div>' +
    '<div class="w10-row-right">' + _renderSectionControl(sec, cfg) + '</div>' +
  '</div>';
}

function _renderSectionControl(sec, cfg) {
  if (sec.type === 'single-select' || sec.type === 'multi-select') {
    var selected = cfg.selections[sec.id] || [];
    var html = '<div class="poster-pill-row">';
    for (var i = 0; i < sec.buttons.length; i++) {
      var b = sec.buttons[i];
      var on = selected.indexOf(b.id) !== -1;
      html += '<button class="poster-pill' + (on ? ' is-on' : '') + '" ' +
        'data-section="' + _esc(sec.id) + '" data-btn="' + _esc(b.id) + '" data-mode="' + sec.type + '">' +
        _esc(b.label) +
      '</button>';
    }
    html += '</div>';
    return html;
  }
  if (sec.type === 'text-input') {
    var val = cfg.inputs[sec.id] || '';
    return '<input type="text" class="w10-input" data-section="' + _esc(sec.id) + '" ' +
      'placeholder="' + _esc(sec.placeholder || '') + '" value="' + _esc(val) + '" style="width:100%;">';
  }
  if (sec.type === 'toggle') {
    var on = !!(cfg.selections[sec.id] && cfg.selections[sec.id][0]);
    return '<div class="w10-toggle' + (on ? ' on' : '') + '" data-section="' + _esc(sec.id) + '" data-mode="toggle"></div>';
  }
  if (sec.type === 'file-upload') {
    var up = cfg.uploads[sec.id];
    var hasUp = !!(up && up.base64);
    return '<div class="poster-upload-row">' +
      '<button class="w10-btn' + (hasUp ? ' w10-btn-accent' : '') + '" data-section="' + _esc(sec.id) + '" data-mode="upload">' +
        (hasUp ? '✓ ' + _esc(_truncate(up.name || '已抓取', 16)) : '✂️ 从 PS 抓取') +
      '</button>' +
      (hasUp ? '<button class="poster-mini-x" data-section="' + _esc(sec.id) + '" data-mode="upload-clear" title="移除">×</button>' : '') +
    '</div>';
  }
  return '';
}

function _truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ========== STEP ③ 素材图片 ==========
function _renderStepImagePool(cat) {
  var cfg = _getCfg(cat);
  var imgs = cfg.images || [];
  var quotaUsed = imgs.length + _countUploadsAsImages(cfg);
  var metaCls = quotaUsed > MAX_IMAGES ? ' is-full' : (quotaUsed >= MAX_IMAGES - 2 ? ' is-warn' : '');

  var html = '<div class="w10-section-title">📥 STEP 3 · 素材图片</div>' +
    '<div class="w10-row poster-row-stack">' +
      '<div class="w10-row-left">' +
        '<div class="w10-row-label">已添加 <span class="poster-pool-meta' + metaCls + '">' + quotaUsed + ' / ' + MAX_IMAGES + '</span></div>' +
        '<div class="w10-row-desc">在 PS 里框选要抓的区域,点下方按钮抓进素材池(同一文档可多次框不同区域加入)</div>' +
      '</div>' +
      '<div class="w10-row-right" style="flex-direction:column;align-items:stretch;gap:6px;width:100%;">' +
        '<div class="poster-source-btns">' +
          '<button class="w10-btn w10-btn-accent" data-source="capture">✂️ 从 PS 抓取选区</button>' +
          '<button class="w10-btn" data-source="clear" style="color:#ff8a8a;border-color:rgba(255,100,100,0.3)">清空</button>' +
        '</div>' +
        '<div class="poster-image-pool" id="posterImagePool">';
  if (imgs.length === 0) {
    html += '<div class="poster-pool-empty">尚未添加任何图片<br><span style="font-size:9px;">在 PS 用矩形选框工具(M)框选,然后点上方"从 PS 抓取选区"</span></div>';
  } else {
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      html += '<div class="poster-image-cell" data-img-idx="' + i + '" title="' + _esc(im.name || '') + '">' +
        (im.thumbBase64 ? '<img src="' + _imgSrc(im.thumbBase64) + '">' : '<span class="poster-img-placeholder">img</span>') +
        '<span class="poster-img-tag">' + (i + 1) + '</span>' +
        '<button class="poster-img-x" data-img-idx="' + i + '" title="移除">×</button>' +
      '</div>';
    }
  }
  html += '</div></div></div>';
  return html;
}

// 页主体内容(已分配缩略图行 + 分配编号按钮行) — 单独抽出来,patch 时只重画这一段
function _renderPageBodyContent(cfg, pn) {
  var imgsInPage = cfg.pages[pn] || [];
  var html = '';

  if (imgsInPage.length === 0) {
    html += '<div class="poster-page-empty">尚未分配图片 · 请在下方点击编号加入本页</div>';
  } else {
    html += '<div class="poster-page-imgs">';
    for (var ii = 0; ii < imgsInPage.length; ii++) {
      var idx = imgsInPage[ii];
      var imRef = (cfg.images || [])[idx];
      if (!imRef) continue;
      html += '<div class="poster-page-img" title="' + _esc(imRef.name || '') + '">' +
        (imRef.thumbBase64 ? '<img src="' + _imgSrc(imRef.thumbBase64) + '">' : '<span class="poster-img-placeholder">' + (idx + 1) + '</span>') +
      '</div>';
    }
    html += '</div>';
  }

  var pool = cfg.images || [];
  if (pool.length > 0) {
    html += '<div class="poster-assign-label">从图片池快速分配</div>' +
      '<div class="poster-assign-row">';
    for (var ai = 0; ai < pool.length; ai++) {
      var assigned = imgsInPage.indexOf(ai) !== -1;
      html += '<button class="poster-assign-pill' + (assigned ? ' is-on' : '') + '" data-assign="' + ai + '" data-assign-page="' + pn + '">' + (ai + 1) + '</button>';
    }
    html += '</div>';
  } else {
    html += '<div class="poster-assign-label" style="color:var(--text-sub);">先到 STEP 3 添加素材图片</div>';
  }
  return html;
}

// ========== STEP ④ 分页 ==========
function _renderStepPages(cat) {
  var cfg = _getCfg(cat);
  var pageNums = Object.keys(cfg.pages).map(Number).sort(function(a, b) { return a - b; });
  if (pageNums.length === 0) pageNums = [1];

  var html = '<div class="w10-section-title">📄 STEP 4 · 分页 · 每页一张海报</div>';

  for (var pi = 0; pi < pageNums.length; pi++) {
    var pn = pageNums[pi];
    var imgsInPage = cfg.pages[pn] || [];
    var isActive = (cfg.activePage === pn);
    var canDel = pageNums.length > 1;
    html += '<details class="poster-fold"' + (isActive ? ' open' : '') + ' data-page-fold="' + pn + '">' +
      '<summary>' +
        '<span class="poster-page-summary">' +
          '页 ' + pn +
          '<span class="poster-fold-meta" data-page-count="' + pn + '">' + imgsInPage.length + ' 张</span>' +
          (canDel ? '<button class="poster-page-del" data-page-del="' + pn + '" title="删除该页">×</button>' : '') +
        '</span>' +
      '</summary>' +
      '<div class="poster-page-body" data-page="' + pn + '">' +
        _renderPageBodyContent(cfg, pn) +
      '</div>' +
    '</details>';
  }

  html += '<div class="poster-add-page-row">' +
    '<button class="w10-btn" data-action="add-page">+ 新增页</button>' +
  '</div>';

  return html;
}

// ========== STEP ⑤ 生成参数 ==========
function _renderStepGenerate(cat) {
  var cfg = _getCfg(cat);
  var aji = cfg.aji || { model: 'gpt-image-2', size: '4K', aspect: '16:9' };
  // 当前 provider(默认 grs)
  var provider = cfg.provider || 'grs';
  if (provider !== 'grs' && provider !== 'aji') provider = 'grs';
  // 按 provider 决定哪些模型可用;模型不在白名单 → 落到第一个
  var modelsForP = _getModelsForProvider(provider);
  var validModelIds = modelsForP.map(function(m) { return m.id; });
  if (validModelIds.indexOf(aji.model) === -1) {
    aji.model = modelsForP[0].id;
    cfg.aji = aji;
    _setCfg(cat, cfg);
  }
  // 按 (provider, model) 拿合法的 sizes;按 provider 拿合法的 aspects
  var sizesForP = _getGptSizes(provider, aji.model);
  var aspectsForP = _getGptAspects(provider);
  var validSizeIds = sizesForP.map(function(s) { return s.id; });
  var validAspectIds = aspectsForP.map(function(a) { return a.id; });
  // 迁移:用户的 size 不在当前模型支持的列表里(比如从 vip 切到标准但带着 4K) →
  //       落到列表里"最大的那个"(标准最大就是 2K),并 toast 提示一次
  if (validSizeIds.indexOf(aji.size) === -1) {
    var prevSize = aji.size;
    // 找最大的:列表里默认从小到大排,取最后一个
    aji.size = sizesForP[sizesForP.length - 1].id;
    cfg.aji = aji;
    _setCfg(cat, cfg);
    try {
      TileAPI.toast('当前模型不支持 ' + prevSize + ',已自动切换到 ' + aji.size, 'warn');
    } catch (_) {}
  }
  if (validAspectIds.indexOf(aji.aspect) === -1) {
    aji.aspect = aspectsForP[0].id;
    cfg.aji = aji;
    _setCfg(cat, cfg);
  }

  var px = _gptSizeToPixels(aji.size, aji.aspect);
  var newW = Math.round(px.w * cfg.multiplier);
  var newH = Math.round(px.h * cfg.multiplier);
  var rolls = +cfg.rolls || 1;
  if (rolls < 1) rolls = 1; if (rolls > 4) rolls = 4;
  var pageCnt = Object.keys(cfg.pages).length;
  var totalCalls = pageCnt * rolls;

  // 检查当前 connection 是否配置了对应 provider 的 URL/Key(给警告用)
  var connInfo = _getProviderConnection(provider);
  var connOK = !!(connInfo && connInfo.url && connInfo.key);

  var providerOpts = _providerOptions().map(function(p) {
    return '<option value="' + _esc(p.id) + '"' + (provider === p.id ? ' selected' : '') + '>' + _esc(p.label) + '</option>';
  }).join('');
  var modelOpts = modelsForP.map(function(m) {
    return '<option value="' + _esc(m.id) + '"' + (aji.model === m.id ? ' selected' : '') + '>' + _esc(m.label) + '</option>';
  }).join('');
  var sizeOpts = sizesForP.map(function(s) {
    return '<option value="' + _esc(s.id) + '"' + (aji.size === s.id ? ' selected' : '') + '>' + _esc(s.label) + '</option>';
  }).join('');
  var aspectOpts = aspectsForP.map(function(a) {
    return '<option value="' + _esc(a.id) + '"' + (aji.aspect === a.id ? ' selected' : '') + '>' + _esc(a.label) + '</option>';
  }).join('');

  // GRS 流的提醒 + 未配置的警告
  var providerHint = '';
  if (provider === 'grs') {
    providerHint = '<div class="w10-row-desc" style="color:#c8a8ff;">' + TileAPI.computeBrand() + ' 流:参考图会先上传到作者的临时图床(2 小时自动清理),再调 GPT-Image</div>';
  } else {
    providerHint = '<div class="w10-row-desc">AJI 流:参考图直接走 multipart 上传给 AJI</div>';
  }
  var connWarn = '';
  if (!connOK) {
    var pnameDef = provider === 'grs' ? TileAPI.computeBrand() : 'AJI';
    var pname = TileAPI.slotLabel ? TileAPI.slotLabel(provider, pnameDef) : pnameDef;
    if (connInfo && connInfo._grsKeyPending) {
      // 夏算力 sub-key 还在异步拉, 不是真没配, 显示蓝色"准备中"
      connWarn = '<div class="w10-row" style="background:rgba(74,158,255,0.08);border:1px solid rgba(74,158,255,0.3);border-radius:6px;padding:10px 12px;margin-bottom:10px;">' +
        '<div class="w10-row-left">' +
          '<div class="w10-row-label" style="color:#7ab8ff;">⏳ 正在准备夏三七 Key, 稍等...</div>' +
          '<div class="w10-row-desc">拿到后这里会自动消失, 不用刷新</div>' +
        '</div></div>';
    } else if (connInfo && connInfo._grsNeedLogin) {
      // 托管模式没登录: 该提示登录, 不是让用户去填 key
      connWarn = '<div class="w10-row" style="background:rgba(255,69,58,0.08);border:1px solid rgba(255,69,58,0.3);border-radius:6px;padding:10px 12px;margin-bottom:10px;">' +
        '<div class="w10-row-left">' +
          '<div class="w10-row-label" style="color:#ff8a8a;">⚠️ 夏算力托管需要登录</div>' +
          '<div class="w10-row-desc">到顶栏账号区登录, 或切回「自带 Key」再回来生成</div>' +
        '</div></div>';
    } else {
      connWarn = '<div class="w10-row" style="background:rgba(255,69,58,0.08);border:1px solid rgba(255,69,58,0.3);border-radius:6px;padding:10px 12px;margin-bottom:10px;">' +
        '<div class="w10-row-left">' +
          '<div class="w10-row-label" style="color:#ff8a8a;">⚠️ 当前未配置 ' + pname + ' 通道的 URL 和 Key</div>' +
          '<div class="w10-row-desc">请到顶栏 → 服务通道选 ' + pname + ' → 填好 URL 和 Key 后再回来生成</div>' +
        '</div></div>';
    }
  }

  return '<div class="w10-section-title">⚙️ STEP 5 · 生成参数</div>' +
    connWarn +
    '<div class="w10-row">' +
      '<div class="w10-row-left">' +
        '<div class="w10-row-label">服务通道</div>' +
        providerHint +
      '</div>' +
      '<div class="w10-row-right"><select class="w10-select" id="posterProvider">' + providerOpts + '</select></div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">模型</div></div>' +
      '<div class="w10-row-right"><select class="w10-select" id="posterAjiModel">' + modelOpts + '</select></div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">分辨率</div></div>' +
      '<div class="w10-row-right"><select class="w10-select" id="posterAjiSize">' + sizeOpts + '</select></div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left"><div class="w10-row-label">比例</div></div>' +
      '<div class="w10-row-right"><select class="w10-select" id="posterAjiAspect">' + aspectOpts + '</select></div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left">' +
        '<div class="w10-row-label">每页 Roll 次数</div>' +
        '<div class="w10-row-desc">同页多 roll 用于挑最爱</div>' +
      '</div>' +
      '<div class="w10-row-right"><select class="w10-select" id="posterRolls">' +
        '<option value="1"' + (rolls === 1 ? ' selected' : '') + '>1 次</option>' +
        '<option value="2"' + (rolls === 2 ? ' selected' : '') + '>2 次</option>' +
        '<option value="3"' + (rolls === 3 ? ' selected' : '') + '>3 次</option>' +
        '<option value="4"' + (rolls === 4 ? ' selected' : '') + '>4 次</option>' +
      '</select></div>' +
    '</div>' +
    '<div class="w10-row">' +
      '<div class="w10-row-left">' +
        '<div class="w10-row-label">新建文档倍率</div>' +
        '<div class="w10-row-desc">创建 PS 文档时的画布放大</div>' +
      '</div>' +
      '<div class="w10-row-right"><select class="w10-select" id="posterMultiplier">' +
        '<option value="1"' + (cfg.multiplier == 1 ? ' selected' : '') + '>1x</option>' +
        '<option value="1.5"' + (cfg.multiplier == 1.5 ? ' selected' : '') + '>1.5x</option>' +
        '<option value="2"' + (cfg.multiplier == 2 ? ' selected' : '') + '>2x</option>' +
        '<option value="3"' + (cfg.multiplier == 3 ? ' selected' : '') + '>3x</option>' +
      '</select></div>' +
    '</div>' +
    '<div class="poster-resolution-hint" id="posterResolutionHint">' +
      '📐 GPT 输出 <b>' + px.w + '×' + px.h + '</b> · 新建文档 <b>' + newW + '×' + newH + '</b><br>' +
      '🎯 共 <b>' + pageCnt + '</b> 页 × <b>' + rolls + '</b> roll = <b>' + totalCalls + '</b> 张' +
    '</div>' +
    '<button class="w10-btn w10-btn-accent poster-generate-btn" id="posterGenerateBtn">' +
      '▶ 开始生成 (' + totalCalls + ' 张)' +
    '</button>' +
    '<div class="poster-status" id="posterStatus" style="display:none;"></div>';
}

// ========== STEP ⑥ 提示词预览(可折叠,默认折叠) ==========
function _renderStepPromptPreview(cat) {
  var cfg = _getCfg(cat);
  var preview = '';
  try { preview = _buildPrompt(cat, cfg); } catch(e) { preview = '(预览生成失败: ' + (e && e.message || e) + ')'; }
  var charCount = preview.length;
  return '<details class="poster-fold">' +
    '<summary>' +
      '📝 STEP 6 · 提示词预览' +
      '<span class="poster-fold-meta" id="posterPromptCount">' + charCount + ' 字</span>' +
    '</summary>' +
    '<textarea class="poster-prompt-preview" id="posterPromptPreview" readonly>' + _esc(preview) + '</textarea>' +
  '</details>';
}

// ============================================================
//  管理预设编辑器(全屏覆盖在海报面板上方)
//
//  数据流:
//    1. 打开编辑器 → 把 window._posterPrompts 深拷贝到 _editorData
//    2. 用户在 _editorData 上增删改查
//    3. 点保存 → 发 posterPromptsSave({data: _editorData}) → host 落盘
//    4. host 落盘成功 → 前端 reload(自动重新调 posterPromptsLoad)
//    5. reload 完合并 systemPrompt 后,window._posterPrompts 是最新的 → 重渲 STEP 面板
//
//  systemPrompt 在编辑器里只读展示,不让改(发给 host 时也会被 host 端忽略,但这里直接 UI 不暴露编辑)
// ============================================================
var _editorData = null;       // 编辑器当前操作的数据(_posterPrompts 深拷贝)
var _editorActiveCat = null;  // 当前编辑的 category
var _editorActiveSecIdx = -1; // 当前选中的 section 在 sections[] 里的索引(-1 表示没选)
var _editorMounted = false;   // 编辑器是否在 DOM 中

function _openPromptEditor(container) {
  if (!window._posterPrompts) {
    TileAPI.toast('预设数据未加载,请稍候再试', 'warn');
    return;
  }
  _editorData = JSON.parse(JSON.stringify(window._posterPrompts));
  _editorActiveCat = _getActiveCategory();
  _editorActiveSecIdx = 0;
  _editorMounted = true;
  _renderEditor(container);
}

function _closePromptEditor(container) {
  _editorMounted = false;
  _editorData = null;
  _editorActiveCat = null;
  _editorActiveSecIdx = -1;
  _renderPanel(container);
}

function _renderEditor(container) {
  var cat = _editorActiveCat;
  var def = _editorData[cat];
  if (!def) {
    container.innerHTML = '<div class="w10-panel"><div class="poster-empty">编辑器数据缺失</div></div>';
    return;
  }
  var html =
    '<div class="w10-panel poster-editor-panel poster-no-anim">' +
      '<div class="poster-editor-topbar">' +
        '<button class="w10-btn poster-editor-back-btn" id="posterEdBack">← 返回</button>' +
        '<div class="poster-editor-tab-row">' +
          '<button class="w10-btn' + (cat === 'commission' ? ' w10-btn-accent' : '') + '" data-ed-tab="commission">🎨 接单图排版</button>' +
          '<button class="w10-btn' + (cat === 'portfolio' ? ' w10-btn-accent' : '') + '" data-ed-tab="portfolio">🎬 正片排版</button>' +
        '</div>' +
        '<div class="poster-editor-actions">' +
          '<button class="w10-btn" id="posterEdImport" title="从 JSON 文件导入">📥 导入</button>' +
          '<button class="w10-btn" id="posterEdExport" title="导出到剪贴板">📤 导出</button>' +
          '<button class="w10-btn" id="posterEdReset" style="color:#ff8a8a;border-color:rgba(255,100,100,0.3)" title="把当前大类恢复到出厂默认">↺ 重置</button>' +
          '<button class="w10-btn w10-btn-accent" id="posterEdSave">💾 保存</button>' +
        '</div>' +
      '</div>' +
      '<div class="poster-editor-body">' +
        _renderEditorLeft(def, cat) +
        _renderEditorRight(def, cat) +
      '</div>' +
    '</div>';
  container.innerHTML = html;
  _bindEditor(container);
}

function _renderEditorLeft(def, cat) {
  var sections = def.sections || [];
  var html = '<div class="poster-editor-left">' +
    '<div class="poster-editor-left-head">' +
      '<span>分类清单</span>' +
      '<button class="poster-mini-btn-add" data-ed-add-section title="新增分类">+ 新增分类</button>' +
    '</div>' +
    '<div class="poster-editor-section-list">';
  for (var i = 0; i < sections.length; i++) {
    var sec = sections[i];
    var sel = (i === _editorActiveSecIdx);
    var btnCount = (sec.buttons || []).length;
    html += '<div class="poster-editor-section-item' + (sel ? ' is-active' : '') + '" data-ed-sec-idx="' + i + '">' +
      '<div class="poster-editor-sec-name">' + _esc(sec.label || '(未命名)') + '</div>' +
      '<div class="poster-editor-sec-meta">' +
        '<span>' + _esc(_secTypeLabel(sec.type)) + '</span>' +
        (btnCount ? '<span> · ' + btnCount + ' 项</span>' : '') +
      '</div>' +
      '<button class="poster-editor-sec-del" data-ed-del-section="' + i + '" title="删除分类">×</button>' +
    '</div>';
  }
  html += '</div></div>';
  return html;
}

function _secTypeLabel(t) {
  if (t === 'single-select') return '单选';
  if (t === 'multi-select') return '多选';
  if (t === 'text-input') return '文本输入';
  if (t === 'toggle') return '开关';
  if (t === 'file-upload') return '图片上传';
  return t || '?';
}

function _renderEditorRight(def, cat) {
  if (_editorActiveSecIdx < 0 || !def.sections || !def.sections[_editorActiveSecIdx]) {
    return '<div class="poster-editor-right"><div class="poster-editor-empty">点击左侧分类查看详情<br><br>分类的"红线指挥"是只读的(出厂版本永远不变),<br>这里只能改具体选项的标题和提示词。</div></div>';
  }
  var sec = def.sections[_editorActiveSecIdx];
  var html = '<div class="poster-editor-right">' +
    // 分类元信息
    '<div class="poster-editor-meta">' +
      '<div class="poster-editor-field">' +
        '<label>分类标题(用户在面板看到的名字)</label>' +
        '<input type="text" class="w10-input" data-ed-meta="label" value="' + _esc(sec.label || '') + '">' +
      '</div>' +
      '<div class="poster-editor-field">' +
        '<label>分类 ID(英文,改了会重置已有用户选择)</label>' +
        '<input type="text" class="w10-input" data-ed-meta="id" value="' + _esc(sec.id || '') + '">' +
      '</div>' +
      '<div class="poster-editor-field">' +
        '<label>类型</label>' +
        '<select class="w10-select" data-ed-meta="type">' +
          ['single-select','multi-select','text-input','toggle','file-upload'].map(function(t) {
            return '<option value="' + t + '"' + (sec.type === t ? ' selected' : '') + '>' + _secTypeLabel(t) + '(' + t + ')</option>';
          }).join('') +
        '</select>' +
      '</div>';

  if (sec.type === 'text-input') {
    html += '<div class="poster-editor-field">' +
      '<label>输入框占位提示</label>' +
      '<input type="text" class="w10-input" data-ed-meta="placeholder" value="' + _esc(sec.placeholder || '') + '">' +
    '</div>' +
    '<div class="poster-editor-field">' +
      '<label>给 AI 的话(用 {TEXT} 占位用户输入)</label>' +
      '<textarea class="poster-editor-textarea" data-ed-meta="promptTemplate">' + _esc(sec.promptTemplate || '') + '</textarea>' +
    '</div>';
  }
  if (sec.type === 'toggle') {
    html += '<div class="poster-editor-field">' +
      '<label>开启时给 AI 的话</label>' +
      '<textarea class="poster-editor-textarea" data-ed-meta="prompt">' + _esc(sec.prompt || '') + '</textarea>' +
    '</div>';
  }
  if (sec.type === 'file-upload') {
    html += '<div class="poster-editor-field">' +
      '<label>用户上传图片后给 AI 的话(描述这张图的用途)</label>' +
      '<textarea class="poster-editor-textarea" data-ed-meta="promptHint">' + _esc(sec.promptHint || '') + '</textarea>' +
    '</div>';
  }
  html += '</div>';

  // 选项列表(buttons) - 仅 single/multi-select 有
  if (sec.type === 'single-select' || sec.type === 'multi-select') {
    html += '<div class="poster-editor-buttons">' +
      '<div class="poster-editor-buttons-head">' +
        '<span>选项列表(用户在按钮面板上能看到/点击的)</span>' +
        '<button class="poster-mini-btn-add" data-ed-add-button>+ 新增选项</button>' +
      '</div>';
    var btns = sec.buttons || [];
    for (var bi = 0; bi < btns.length; bi++) {
      var b = btns[bi];
      html += '<div class="poster-editor-button-item" data-ed-btn-idx="' + bi + '">' +
        '<div class="poster-editor-btn-row">' +
          '<input type="text" class="w10-input" data-ed-btn="label" placeholder="选项标题(用户看到)" value="' + _esc(b.label || '') + '">' +
          '<input type="text" class="w10-input poster-editor-btn-id" data-ed-btn="id" placeholder="ID(英文)" value="' + _esc(b.id || '') + '">' +
          '<button class="poster-mini-x" data-ed-del-button="' + bi + '" title="删除该选项">×</button>' +
        '</div>' +
        '<textarea class="poster-editor-textarea" data-ed-btn="prompt" placeholder="给 AI 的话(选这个选项就把这段塞给 AI)">' + _esc(b.prompt || '') + '</textarea>' +
      '</div>';
    }
    if (btns.length === 0) {
      html += '<div class="poster-editor-empty-list">还没有任何选项,点上方"+ 新增选项"添加</div>';
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function _bindEditor(container) {
  // 返回
  var backBtn = container.querySelector('#posterEdBack');
  if (backBtn) backBtn.addEventListener('click', function() {
    if (_editorHasChanges()) {
      TileAPI.confirm('有未保存的修改,确定放弃吗?').then(function(ok) {
        if (ok) _closePromptEditor(container);
      });
    } else {
      _closePromptEditor(container);
    }
  });

  // 大类 tab
  container.querySelectorAll('[data-ed-tab]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      _editorActiveCat = btn.getAttribute('data-ed-tab');
      _editorActiveSecIdx = 0;
      _renderEditor(container);
    });
  });

  // 保存
  var saveBtn = container.querySelector('#posterEdSave');
  if (saveBtn) saveBtn.addEventListener('click', function() {
    // 校验:每个 section.id 唯一,每个 button.id 唯一
    var err = _validateEditorData();
    if (err) { TileAPI.toast('保存失败: ' + err, 'error'); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = '⏳ 保存中…';
    TileAPI.sendToHost('posterPromptsSave', { data: _editorData });
    setTimeout(function() {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 保存'; }
    }, 5000);
    // 保存成功后关闭编辑器(在 _onPromptsSaveResult 里 reload 完成后退出)
    _editorPendingClose = true;
  });

  // 重置
  var resetBtn = container.querySelector('#posterEdReset');
  if (resetBtn) resetBtn.addEventListener('click', function() {
    var cat = _editorActiveCat;
    TileAPI.confirm('确定把"' + (cat === 'commission' ? '接单图排版' : '正片排版') + '"恢复到出厂默认吗?\n\n你在这个分类下做的所有修改会丢失,但另一个分类不受影响。\n备份会自动写到 poster_prompts.bak.json。').then(function(ok) {
      if (!ok) return;
      var fc = (window._posterPromptsFactory || {})[cat];
      if (!fc) { TileAPI.toast('找不到出厂数据', 'error'); return; }
      TileAPI.sendToHost('posterPromptsResetCategory', {
        category: cat,
        factoryCategory: JSON.parse(JSON.stringify(fc))
      });
      _editorPendingClose = true;
    });
  });

  // 导出 — 复制 JSON 到剪贴板
  var exportBtn = container.querySelector('#posterEdExport');
  if (exportBtn) exportBtn.addEventListener('click', function() {
    try {
      var json = JSON.stringify(_editorData, null, 2);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).then(function() {
          TileAPI.toast('已复制到剪贴板(' + json.length + ' 字符)', 'success');
        }).catch(function() {
          _fallbackShowJson(container, json);
        });
      } else {
        _fallbackShowJson(container, json);
      }
    } catch (e) {
      TileAPI.toast('导出失败: ' + e.message, 'error');
    }
  });

  // 导入 — 弹出 textarea 让用户粘贴
  var importBtn = container.querySelector('#posterEdImport');
  if (importBtn) importBtn.addEventListener('click', function() {
    TileAPI.prompt('粘贴预设 JSON 内容:', { defaultValue: '', multiline: true }).then(function(val) {
      if (!val) return;
      try {
        var obj = JSON.parse(val);
        if (!obj.commission && !obj.portfolio) {
          TileAPI.toast('JSON 格式不对(缺少 commission/portfolio)', 'error');
          return;
        }
        _editorData = obj;
        _editorActiveSecIdx = 0;
        _renderEditor(container);
        TileAPI.toast('已加载,记得点保存', 'info');
      } catch (e) {
        TileAPI.toast('JSON 解析失败: ' + e.message, 'error');
      }
    });
  });

  // 选中某个 section
  container.querySelectorAll('[data-ed-sec-idx]').forEach(function(item) {
    item.addEventListener('click', function(e) {
      if (e.target.closest('[data-ed-del-section]')) return; // 避免点删除按钮误触
      _editorActiveSecIdx = parseInt(item.getAttribute('data-ed-sec-idx'), 10);
      _renderEditor(container);
    });
  });

  // 删除 section
  container.querySelectorAll('[data-ed-del-section]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var idx = parseInt(btn.getAttribute('data-ed-del-section'), 10);
      var sec = _editorData[_editorActiveCat].sections[idx];
      TileAPI.confirm('删除分类"' + (sec.label || sec.id) + '"吗?\n这个分类下所有选项也会一起删除。').then(function(ok) {
        if (!ok) return;
        _editorData[_editorActiveCat].sections.splice(idx, 1);
        if (_editorActiveSecIdx >= _editorData[_editorActiveCat].sections.length) {
          _editorActiveSecIdx = Math.max(0, _editorData[_editorActiveCat].sections.length - 1);
        }
        _renderEditor(container);
      });
    });
  });

  // 新增 section
  var addSecBtn = container.querySelector('[data-ed-add-section]');
  if (addSecBtn) addSecBtn.addEventListener('click', function() {
    TileAPI.prompt('新分类的 ID(英文,如 lighting):').then(function(idVal) {
      if (!idVal) return;
      idVal = String(idVal).trim().replace(/[^a-zA-Z0-9_]/g, '_');
      if (!idVal) { TileAPI.toast('ID 不能为空', 'error'); return; }
      // 检查是否重复
      var existing = _editorData[_editorActiveCat].sections;
      for (var i = 0; i < existing.length; i++) {
        if (existing[i].id === idVal) { TileAPI.toast('ID 已存在', 'error'); return; }
      }
      var newSec = {
        id: idVal,
        label: idVal,
        type: 'single-select',
        buttons: []
      };
      _editorData[_editorActiveCat].sections.push(newSec);
      _editorActiveSecIdx = _editorData[_editorActiveCat].sections.length - 1;
      _renderEditor(container);
    });
  });

  // 元信息字段(label/id/type/placeholder/promptTemplate/prompt/promptHint)
  container.querySelectorAll('[data-ed-meta]').forEach(function(el) {
    var key = el.getAttribute('data-ed-meta');
    var listener = (el.tagName === 'SELECT') ? 'change' : 'input';
    el.addEventListener(listener, function() {
      var sec = _editorData[_editorActiveCat].sections[_editorActiveSecIdx];
      if (!sec) return;
      sec[key] = el.value;
      // 改 type 后,可能需要重新渲染右栏(显示不同的字段)
      if (key === 'type') {
        // 切换类型时清理无关字段,初始化新类型必需字段
        if (sec.type === 'single-select' || sec.type === 'multi-select') {
          if (!Array.isArray(sec.buttons)) sec.buttons = [];
        }
        _renderEditor(container);
      } else if (key === 'label') {
        // label 变了 → 左栏显示也要更新(简单做法直接重渲)
        _renderEditor(container);
      }
    });
  });

  // 选项 buttons 字段编辑
  container.querySelectorAll('[data-ed-btn-idx]').forEach(function(item) {
    var bi = parseInt(item.getAttribute('data-ed-btn-idx'), 10);
    item.querySelectorAll('[data-ed-btn]').forEach(function(input) {
      var key = input.getAttribute('data-ed-btn');
      input.addEventListener('input', function() {
        var sec = _editorData[_editorActiveCat].sections[_editorActiveSecIdx];
        if (!sec || !sec.buttons || !sec.buttons[bi]) return;
        sec.buttons[bi][key] = input.value;
      });
    });
  });

  // 删除单个 button
  container.querySelectorAll('[data-ed-del-button]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var bi = parseInt(btn.getAttribute('data-ed-del-button'), 10);
      var sec = _editorData[_editorActiveCat].sections[_editorActiveSecIdx];
      if (!sec || !sec.buttons) return;
      sec.buttons.splice(bi, 1);
      _renderEditor(container);
    });
  });

  // 新增 button
  var addBtnBtn = container.querySelector('[data-ed-add-button]');
  if (addBtnBtn) addBtnBtn.addEventListener('click', function() {
    var sec = _editorData[_editorActiveCat].sections[_editorActiveSecIdx];
    if (!sec) return;
    if (!Array.isArray(sec.buttons)) sec.buttons = [];
    var newId = 'opt_' + Date.now().toString(36).slice(-4);
    sec.buttons.push({ id: newId, label: '新选项', prompt: '' });
    _renderEditor(container);
  });
}

// 简单的"是否有改动"检测:对比 _editorData 和 window._posterPrompts 的 JSON
// (注意 systemPrompt 可能不一致 — 用户文件不存 systemPrompt,但 _posterPrompts 合并后会有,
//  所以比较时把 systemPrompt 都剥掉再比)
function _editorHasChanges() {
  if (!_editorData || !window._posterPrompts) return false;
  function _strip(o) {
    var s = JSON.parse(JSON.stringify(o || {}));
    ['commission', 'portfolio'].forEach(function(c) {
      if (s[c]) delete s[c].systemPrompt;
    });
    return s;
  }
  return JSON.stringify(_strip(_editorData)) !== JSON.stringify(_strip(window._posterPrompts));
}

function _validateEditorData() {
  var d = _editorData || {};
  var cats = ['commission', 'portfolio'];
  for (var ci = 0; ci < cats.length; ci++) {
    var cat = cats[ci];
    var def = d[cat];
    if (!def || !Array.isArray(def.sections)) continue;
    var secIds = {};
    for (var si = 0; si < def.sections.length; si++) {
      var sec = def.sections[si];
      if (!sec.id || !sec.label) return cat + ' 第 ' + (si+1) + ' 个分类缺少 ID 或标题';
      if (secIds[sec.id]) return cat + ' 分类 ID 重复: ' + sec.id;
      secIds[sec.id] = 1;
      if (Array.isArray(sec.buttons)) {
        var btnIds = {};
        for (var bi = 0; bi < sec.buttons.length; bi++) {
          var b = sec.buttons[bi];
          if (!b.id || !b.label) return '分类"' + sec.label + '"第 ' + (bi+1) + ' 个选项缺少 ID 或标题';
          if (btnIds[b.id]) return '分类"' + sec.label + '"选项 ID 重复: ' + b.id;
          btnIds[b.id] = 1;
        }
      }
    }
  }
  return null;
}

var _editorPendingClose = false;
function _fallbackShowJson(container, json) {
  TileAPI.dialog({
    title: '导出预设(请手动复制)',
    message: json,
    buttons: ['关闭']
  });
}

// 保存/重置成功后,会重新加载预设;加载完后由 _onPromptsLoadResult 触发 _renderPanel
// 但如果编辑器 mounted 着,_renderPanel 会显示主面板,需要主动检查 _editorPendingClose
// → 让 _onPromptsLoadResult 也处理这个标志
// (修改 _onPromptsLoadResult 在那里加 close 逻辑)

// ========== 局部更新(避免每次按钮点击都整面板重渲染闪一下) ==========

// 重算并刷新提示词预览
function _patchPromptPreview(container) {
  if (!container) return;
  var cat = _getActiveCategory();
  var cfg = _getCfg(cat);
  var preview = '';
  try { preview = _buildPrompt(cat, cfg); } catch(e) { preview = '(预览生成失败: ' + (e && e.message || e) + ')'; }
  var ta = container.querySelector('#posterPromptPreview');
  if (ta) ta.value = preview;
  var cnt = container.querySelector('#posterPromptCount');
  if (cnt) cnt.textContent = preview.length + ' 字';
}

// 刷新 STEP 5 的分辨率提示行 + 生成按钮文案
function _patchGenerateMeta(container) {
  if (!container) return;
  var cat = _getActiveCategory();
  var cfg = _getCfg(cat);
  var aji = cfg.aji || { model: 'gpt-image-2', size: '4K', aspect: '16:9' };
  var px = _gptSizeToPixels(aji.size, aji.aspect);
  var newW = Math.round(px.w * cfg.multiplier);
  var newH = Math.round(px.h * cfg.multiplier);
  var rolls = +cfg.rolls || 1;
  if (rolls < 1) rolls = 1; if (rolls > 4) rolls = 4;
  var pageCnt = Object.keys(cfg.pages).length;
  var totalCalls = pageCnt * rolls;
  var hint = container.querySelector('#posterResolutionHint');
  if (hint) {
    hint.innerHTML =
      '📐 GPT 输出 <b>' + px.w + '×' + px.h + '</b> · 新建文档 <b>' + newW + '×' + newH + '</b><br>' +
      '🎯 共 <b>' + pageCnt + '</b> 页 × <b>' + rolls + '</b> roll = <b>' + totalCalls + '</b> 张';
  }
  var btn = container.querySelector('#posterGenerateBtn');
  if (btn) btn.textContent = '▶ 开始生成 (' + totalCalls + ' 张)';
}

// 刷新单个 section 的 pill 选中状态(single/multi-select 用)
function _patchPillSelection(container, sectionId, selected) {
  if (!container) return;
  var pills = container.querySelectorAll('.poster-pill[data-section="' + sectionId + '"]');
  for (var i = 0; i < pills.length; i++) {
    var p = pills[i];
    var bid = p.getAttribute('data-btn');
    p.classList.toggle('is-on', selected.indexOf(bid) !== -1);
  }
}

// 切换 toggle 视觉(.w10-toggle.on)
function _patchToggleState(container, sectionId, on) {
  if (!container) return;
  var t = container.querySelector('.w10-toggle[data-section="' + sectionId + '"]');
  if (t) t.classList.toggle('on', !!on);
}

// 重画"页 N"的内容(用于"分配编号"切换):只动该页的 body 和 summary 计数
// 不重渲整面板 → 保留 details 折叠状态、滚动位置、所有事件绑定
function _patchPage(container, pn) {
  if (!container) return;
  var cat = _getActiveCategory();
  var cfg = _getCfg(cat);
  // 1) summary 上的计数
  var cntEl = container.querySelector('.poster-fold-meta[data-page-count="' + pn + '"]');
  if (cntEl) cntEl.textContent = ((cfg.pages[pn] || []).length) + ' 张';
  // 2) body 内容(缩略图行 + 编号按钮行)
  var bodyEl = container.querySelector('.poster-page-body[data-page="' + pn + '"]');
  if (bodyEl) {
    bodyEl.innerHTML = _renderPageBodyContent(cfg, pn);
    // 重新绑事件 — body 里的 [data-assign] 和分配按钮都被替换了
    _bindPageBody(container, bodyEl);
  }
}

// 给 page body 内的元素绑事件(从主 _bindPanel 抽出来,以便 _patchPage 复用)
function _bindPageBody(container, scope) {
  scope.querySelectorAll('[data-assign]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var cat = _getActiveCategory();
      var cfg = _getCfg(cat);
      var idx = parseInt(btn.getAttribute('data-assign'), 10);
      var pn = parseInt(btn.getAttribute('data-assign-page'), 10) || cfg.activePage;
      var arr = cfg.pages[pn] || [];
      var pos = arr.indexOf(idx);
      if (pos >= 0) arr.splice(pos, 1); else arr.push(idx);
      cfg.pages[pn] = arr;
      cfg.activePage = pn;
      _setCfg(cat, cfg);
      _patchPage(container, pn);   // 局部更新该页,不重渲整面板
    });
  });
}

// ========== 用户预设(管理预设面板)三个回调 ==========
// 用户文件加载完成 → 把 systemPrompt 用 factory 的覆盖回去 → 注入到 window._posterPrompts
function _onPromptsLoadResult(data) {
  if (!data || !data.success) {
    if (data && data.error) {
      TileAPI.toast('用户预设加载失败,使用出厂版本: ' + data.error, 'warn');
    }
    // factory 已经是 window._posterPrompts 了(prompts.js 默认赋值),啥都不动
    return;
  }
  var userData = data.data || {};
  var factory = window._posterPromptsFactory || {};
  var merged = {};
  // 合并:用户层为主,但 systemPrompt 永远从 factory 读
  ['commission', 'portfolio'].forEach(function(cat) {
    var u = userData[cat];
    var f = factory[cat] || {};
    if (!u || typeof u !== 'object') {
      merged[cat] = JSON.parse(JSON.stringify(f));
    } else {
      merged[cat] = JSON.parse(JSON.stringify(u));
      merged[cat].systemPrompt = f.systemPrompt;   // 强制走出厂(硬约束)
    }
  });
  window._posterPrompts = merged;
  // 如果磁贴已经展开:
  //   - 保存/重置流程结束 → 关闭编辑器,回到主面板(已显示最新数据)
  //   - 否则单纯重渲(主面板或编辑器都行)
  if (_activeContainer) {
    if (_editorPendingClose && _editorMounted) {
      _editorPendingClose = false;
      _closePromptEditor(_activeContainer);
    } else if (_editorMounted) {
      // 编辑器在用,reload 也把 _editorData 同步成最新
      _editorData = JSON.parse(JSON.stringify(window._posterPrompts));
      _renderEditor(_activeContainer);
    } else {
      _renderPanel(_activeContainer);
    }
  }
  if (data.initialized) {
    TileAPI.log('[海报] 首次启动,已初始化用户预设文件', 'info');
  }
}

function _onPromptsSaveResult(data) {
  if (!data || !data.success) {
    TileAPI.toast('保存失败: ' + (data && data.error || '?'), 'error');
    return;
  }
  TileAPI.toast('已保存', 'success');
  // 保存后立刻 reload 拿到最新数据(让 systemPrompt 等也再合并一次)
  if (window._posterPromptsFactory) {
    TileAPI.sendToHost('posterPromptsLoad', { factory: window._posterPromptsFactory });
  }
}

function _onPromptsResetResult(data) {
  if (!data || !data.success) {
    TileAPI.toast('恢复出厂失败: ' + (data && data.error || '?'), 'error');
    return;
  }
  TileAPI.toast('已恢复出厂', 'success');
  if (window._posterPromptsFactory) {
    TileAPI.sendToHost('posterPromptsLoad', { factory: window._posterPromptsFactory });
  }
}

// ========== 接收自动填写结果 ==========
function _onAutofillResult(data) {
  var container = _activeContainer;
  if (container) {
    var btn = container.querySelector('#posterAutofillBtn');
    var statusEl = container.querySelector('#posterAutofillStatus');
    if (btn) { btn.disabled = false; btn.textContent = '🪄 一键自动填写'; }
    if (statusEl) statusEl.className = 'poster-autofill-status';
  }

  if (!data || !data.success) {
    var err = (data && data.error) || '未知错误';
    if (container) {
      var sEl = container.querySelector('#posterAutofillStatus');
      if (sEl) { sEl.textContent = '✕ ' + err.slice(0, 80); sEl.className = 'poster-autofill-status is-err'; }
    }
    TileAPI.toast('自动填写失败: ' + err, 'error');
    return;
  }

  var cat = _getActiveCategory();
  var cfg = _getCfg(cat);
  var def = window._posterPrompts && window._posterPrompts[cat];
  if (!def) return;

  var parsed = data.parsed || {};
  var sels = parsed.selections || {};
  var inputs = parsed.inputs || {};
  var appliedCount = 0;

  // 逐 section 校验后写入(防 LLM 幻觉非法 id)
  for (var i = 0; i < def.sections.length; i++) {
    var sec = def.sections[i];
    if (sec.type === 'single-select') {
      var pickedSingle = sels[sec.id];
      if (!pickedSingle) continue;
      // 校验 id 真存在
      var validIdsSingle = (sec.buttons || []).map(function(b) { return b.id; });
      if (validIdsSingle.indexOf(pickedSingle) >= 0) {
        cfg.selections[sec.id] = [pickedSingle];
        appliedCount++;
      }
    } else if (sec.type === 'multi-select') {
      var pickedMulti = sels[sec.id];
      if (!Array.isArray(pickedMulti)) continue;
      var validIdsMulti = (sec.buttons || []).map(function(b) { return b.id; });
      var keep = pickedMulti.filter(function(id) { return validIdsMulti.indexOf(id) >= 0; });
      if (keep.length) {
        cfg.selections[sec.id] = keep;
        appliedCount++;
      }
    } else if (sec.type === 'text-input') {
      var v = inputs[sec.id];
      if (typeof v === 'string' && v.trim()) {
        cfg.inputs[sec.id] = v;
        appliedCount++;
      }
    }
    // toggle / file-upload 不接受自动填写
  }

  _setCfg(cat, cfg);
  if (container) _renderPanel(container);
  TileAPI.toast('已自动填写 ' + appliedCount + ' 项', 'success');
}

// ========== 计数 ==========
function _countUploadsAsImages(cfg) {
  if (!cfg.uploads) return 0;
  return Object.keys(cfg.uploads).filter(function(k) { return cfg.uploads[k] && cfg.uploads[k].base64; }).length;
}
function _allImagesForGen(cfg, pageNum) {
  // 该页的素材图 + 该 cfg 下所有 upload(LOGO/头像/二维码 — 全局共用)
  var out = [];
  var imgs = cfg.images || [];
  var pageIdxs = (cfg.pages[pageNum] || []);
  for (var i = 0; i < pageIdxs.length; i++) {
    var im = imgs[pageIdxs[i]];
    if (im && im.base64) out.push({ name: im.name, base64: im.base64 });
  }
  // upload(LOGO/头像/二维码)始终全部参与
  if (cfg.uploads) {
    Object.keys(cfg.uploads).forEach(function(k) {
      var u = cfg.uploads[k];
      if (u && u.base64) out.push({ name: u.name || k, base64: u.base64 });
    });
  }
  return out;
}

// ========== 拼装 prompt ==========
function _buildPrompt(category, cfg) {
  var def = window._posterPrompts[category];
  if (!def) return '';
  var parts = [def.systemPrompt];

  for (var i = 0; i < def.sections.length; i++) {
    var sec = def.sections[i];
    if (sec.type === 'single-select' || sec.type === 'multi-select') {
      var sel = cfg.selections[sec.id] || [];
      for (var j = 0; j < sel.length; j++) {
        var btn = sec.buttons.filter(function(b) { return b.id === sel[j]; })[0];
        if (btn && btn.prompt) parts.push(btn.prompt);
      }
    } else if (sec.type === 'text-input') {
      var v = (cfg.inputs[sec.id] || '').trim();
      if (v && sec.promptTemplate) parts.push(sec.promptTemplate.replace('{TEXT}', v));
    } else if (sec.type === 'toggle') {
      var on = !!(cfg.selections[sec.id] && cfg.selections[sec.id][0]);
      if (on && sec.prompt) parts.push(sec.prompt);
    } else if (sec.type === 'file-upload') {
      var up = cfg.uploads[sec.id];
      if (up && up.base64 && sec.promptHint) parts.push(sec.promptHint);
    }
  }

  // 输出指令(动态拼当前 size+aspect)
  var aji = cfg.aji || { size: '4K', aspect: '16:9' };
  var px = _gptSizeToPixels(aji.size, aji.aspect);
  parts.push('输出: 一张 ' + aji.aspect + ' 海报(' + px.w + '×' + px.h + ')。使用提供的参考图作为图像内容,按以上排版原则分布。' +
    '\n再次提醒[最高优先级]: 参考图保持原图像素原样,严禁调色、滤镜、磨皮、风格化;氛围只通过版面背景/装饰/字体实现。');
  return parts.join('\n\n');
}

// ========== 事件绑定 ==========
function _bindPanel(container) {
  // 「🛠 管理预设」按钮
  var manageBtn = container.querySelector('#posterManageBtn');
  if (manageBtn) manageBtn.addEventListener('click', function() {
    _openPromptEditor(container);
  });

  // 「📖 使用教程」就地展开 / 收起 (不再弹 fixed 遮罩)
  var tutBtn = container.querySelector('#posterTutorialToggle');
  var tutBox = container.querySelector('#posterTutorialInline');
  if (tutBtn && tutBox) {
    tutBtn.addEventListener('click', function() {
      var panel = container.querySelector('.w10-panel');
      var isOpen = tutBox.style.display !== 'none';
      if (isOpen) {
        tutBox.style.display = 'none';
        tutBox.innerHTML = '';            // 收起时清空, 不留 DOM
        tutBtn.textContent = '📖 使用教程';
      } else {
        tutBox.innerHTML = _tutorialInnerHtml();   // 点开才构建, 不占首屏渲染
        tutBox.style.display = '';
        tutBtn.textContent = '✕ 收起教程';
      }
      // 按钮在面板顶部: 展开/收起后都把面板滚回顶部 —— 展开从教程开头看起,
      // 收起也不会卡在半中间、要手动往上拉才看得见按钮。
      if (panel) panel.scrollTop = 0;
    });
  }

  // 大类 tab
  container.querySelectorAll('[data-poster-tab]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var tab = btn.getAttribute('data-poster-tab');
      _setActiveCategory(tab);
      _renderPanel(container);
    });
  });

  // section 按钮(single/multi-select) — 局部 patch,不重渲
  container.querySelectorAll('[data-section][data-btn]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var cat = _getActiveCategory();
      var cfg = _getCfg(cat);
      var sectionId = btn.getAttribute('data-section');
      var btnId = btn.getAttribute('data-btn');
      var mode = btn.getAttribute('data-mode');
      cfg.selections = cfg.selections || {};
      var cur = cfg.selections[sectionId] || [];
      var wasOn = cur.indexOf(btnId) !== -1;
      if (mode === 'single-select') {
        cfg.selections[sectionId] = wasOn ? [] : [btnId];
      } else {
        if (wasOn) {
          cur.splice(cur.indexOf(btnId), 1);
        } else {
          cur.push(btnId);
        }
        cfg.selections[sectionId] = cur;
      }
      _setCfg(cat, cfg);
      _patchPillSelection(container, sectionId, cfg.selections[sectionId]);
      _patchPromptPreview(container);
      // 埋点上报:select 或 deselect(失败静默)
      try {
        TileAPI.sendToHost('posterReportUsage', {
          category: cat,
          sectionId: sectionId,
          buttonId: btnId,
          action: wasOn ? 'deselect' : 'select'
        });
      } catch(_) {}
    });
  });
  container.querySelectorAll('[data-section][data-mode="toggle"]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var cat = _getActiveCategory();
      var cfg = _getCfg(cat);
      var sectionId = btn.getAttribute('data-section');
      var on = !!(cfg.selections[sectionId] && cfg.selections[sectionId][0]);
      var newOn = !on;
      cfg.selections[sectionId] = newOn ? ['on'] : [];
      _setCfg(cat, cfg);
      _patchToggleState(container, sectionId, newOn);
      _patchPromptPreview(container);
    });
  });

  // 文本输入 — 不重渲,只更新提示词预览(去抖)
  var _txtTimer = null;
  container.querySelectorAll('input.w10-input[data-section]').forEach(function(inp) {
    inp.addEventListener('input', function() {
      var cat = _getActiveCategory();
      var cfg = _getCfg(cat);
      cfg.inputs = cfg.inputs || {};
      cfg.inputs[inp.getAttribute('data-section')] = inp.value;
      _setCfg(cat, cfg);
      if (_txtTimer) clearTimeout(_txtTimer);
      _txtTimer = setTimeout(function() { _patchPromptPreview(container); }, 250);
    });
  });

  // file-upload 区(LOGO/头像/二维码) — 改用从 PS 抓取
  container.querySelectorAll('[data-mode="upload"]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var sectionId = btn.getAttribute('data-section');
      btn.disabled = true;
      var oldText = btn.textContent;
      btn.textContent = '⏳ 抓取中…';
      TileAPI.sendToHost('posterCaptureFromPS', { slot: 'upload', uploadKey: sectionId });
      // 失败/成功都会通过 onMessage 回来,届时 _renderPanel 会重绘按钮(无需手动恢复)
      // 但万一消息丢失,做个兜底超时恢复(15s)
      setTimeout(function() {
        if (btn && btn.disabled) {
          btn.disabled = false;
          btn.textContent = oldText;
        }
      }, 15000);
    });
  });
  container.querySelectorAll('[data-mode="upload-clear"]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var cat = _getActiveCategory();
      var cfg = _getCfg(cat);
      var sectionId = btn.getAttribute('data-section');
      if (cfg.uploads) delete cfg.uploads[sectionId];
      _setCfg(cat, cfg);
      _renderPanel(container);
    });
  });

  // 图片池来源 — 现在只剩 capture 和 clear
  container.querySelectorAll('[data-source]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var src = btn.getAttribute('data-source');
      if (src === 'capture') {
        // 抓选区到素材池 — 先做配额检查
        var cat = _getActiveCategory();
        var cfg = _getCfg(cat);
        var quotaUsed = (cfg.images || []).length + _countUploadsAsImages(cfg);
        if (quotaUsed >= MAX_IMAGES) {
          TileAPI.toast('已达 ' + MAX_IMAGES + ' 张上限,请先删除一些再抓', 'warn');
          return;
        }
        btn.disabled = true;
        var oldText = btn.textContent;
        btn.textContent = '⏳ 抓取中…';
        TileAPI.sendToHost('posterCaptureFromPS', { slot: 'pool' });
        setTimeout(function() {
          if (btn && btn.disabled) {
            btn.disabled = false;
            btn.textContent = oldText;
          }
        }, 15000);
      } else if (src === 'clear') {
        var cat2 = _getActiveCategory();
        var cfg2 = _getCfg(cat2);
        cfg2.images = [];
        cfg2.pages = { 1: [] };
        cfg2.activePage = 1;
        _setCfg(cat2, cfg2);
        _renderPanel(container);
      }
    });
  });

  // 图片池单个移除
  container.querySelectorAll('[data-img-idx]').forEach(function(btn) {
    if (btn.classList && btn.classList.contains('poster-img-x')) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = parseInt(btn.getAttribute('data-img-idx'), 10);
        var cat = _getActiveCategory();
        var cfg = _getCfg(cat);
        cfg.images.splice(idx, 1);
        // 重整 pages 索引(被删的之后所有索引 -1,等于该索引的剔除)
        Object.keys(cfg.pages).forEach(function(pn) {
          cfg.pages[pn] = cfg.pages[pn].filter(function(i) { return i !== idx; }).map(function(i) { return i > idx ? i - 1 : i; });
        });
        _setCfg(cat, cfg);
        _renderPanel(container);
      });
    }
  });

  // 分页:新建/折叠展开/删除
  var addBtn = container.querySelector('[data-action="add-page"]');
  if (addBtn) addBtn.addEventListener('click', function() {
    var cat = _getActiveCategory();
    var cfg = _getCfg(cat);
    var nums = Object.keys(cfg.pages).map(Number);
    var next = nums.length ? Math.max.apply(null, nums) + 1 : 1;
    cfg.pages[next] = [];
    cfg.activePage = next;
    _setCfg(cat, cfg);
    _renderPanel(container);
  });
  // 分页折叠:展开某一页 = 把它设为 activePage(用于"从图片池快速分配")
  container.querySelectorAll('details[data-page-fold]').forEach(function(det) {
    det.addEventListener('toggle', function() {
      if (!det.open) return;
      var cat = _getActiveCategory();
      var cfg = _getCfg(cat);
      var pn = parseInt(det.getAttribute('data-page-fold'), 10);
      if (cfg.activePage !== pn) {
        cfg.activePage = pn;
        _setCfg(cat, cfg);
      }
    });
  });
  container.querySelectorAll('[data-page-del]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      e.preventDefault();   // 防止 summary 的 click 翻转 details
      var cat = _getActiveCategory();
      var cfg = _getCfg(cat);
      var pn = parseInt(btn.getAttribute('data-page-del'), 10);
      delete cfg.pages[pn];
      var rem = Object.keys(cfg.pages).map(Number).sort(function(a, b) { return a - b; });
      if (rem.length === 0) { cfg.pages = { 1: [] }; rem = [1]; }
      if (cfg.activePage === pn) cfg.activePage = rem[0];
      _setCfg(cat, cfg);
      _renderPanel(container);
    });
  });
  // 分配:把图片池索引加/移出某一页 — 用 _bindPageBody 绑定,点击走 _patchPage 局部更新
  _bindPageBody(container, container);

  // 倍率 — 局部更新分辨率提示和生成按钮文案
  var multSelect = container.querySelector('#posterMultiplier');
  if (multSelect) multSelect.addEventListener('change', function() {
    var cat = _getActiveCategory();
    var cfg = _getCfg(cat);
    cfg.multiplier = parseFloat(multSelect.value) || 1.5;
    _setCfg(cat, cfg);
    _patchGenerateMeta(container);
  });

  // 服务通道切换 — 整面板重渲(因为 sizes/aspects 列表会变)
  var providerSel = container.querySelector('#posterProvider');
  if (providerSel) providerSel.addEventListener('change', function() {
    var cat = _getActiveCategory();
    var cfg = _getCfg(cat);
    cfg.provider = providerSel.value;
    _setCfg(cat, cfg);
    _renderPanel(container);
  });

  // 模型切换 — 整面板重渲(不同模型支持的分辨率不同,要重新生成 size 下拉)
  var ajiModelSel = container.querySelector('#posterAjiModel');
  if (ajiModelSel) ajiModelSel.addEventListener('change', function() {
    var cat = _getActiveCategory();
    var cfg = _getCfg(cat);
    cfg.aji = cfg.aji || {};
    cfg.aji.model = ajiModelSel.value;
    // 模型变 → 联动"分辨率"可选项(sizes 随 model 变);当前 size 不被新模型支持则迁移到最大档
    var provider = cfg.provider || 'grs';
    if (provider !== 'grs' && provider !== 'aji') provider = 'grs';
    var sizesForP = _getGptSizes(provider, cfg.aji.model);
    var validSizeIds = sizesForP.map(function(s) { return s.id; });
    if (validSizeIds.indexOf(cfg.aji.size) === -1) {
      var prev = cfg.aji.size;
      cfg.aji.size = sizesForP[sizesForP.length - 1].id;
      try { TileAPI.toast('当前模型不支持 ' + prev + ', 已自动切换到 ' + cfg.aji.size, 'warn'); } catch (_) {}
    }
    _setCfg(cat, cfg);
    // 精准更新分辨率下拉 + 提示/预览, 不走 _renderPanel(整面板重砌会清滚动→跳顶闪烁)
    var sizeSel = container.querySelector('#posterAjiSize');
    if (sizeSel) {
      sizeSel.innerHTML = sizesForP.map(function(s) {
        return '<option value="' + _esc(s.id) + '"' + (cfg.aji.size === s.id ? ' selected' : '') + '>' + _esc(s.label) + '</option>';
      }).join('');
      sizeSel.value = cfg.aji.size;
    }
    _patchGenerateMeta(container);
    _patchPromptPreview(container);
  });
  var ajiSizeSel = container.querySelector('#posterAjiSize');
  if (ajiSizeSel) ajiSizeSel.addEventListener('change', function() {
    var cat = _getActiveCategory();
    var cfg = _getCfg(cat);
    cfg.aji = cfg.aji || {};
    cfg.aji.size = ajiSizeSel.value;
    _setCfg(cat, cfg);
    _patchGenerateMeta(container);
    _patchPromptPreview(container);  // prompt 末尾会带上分辨率
  });
  var ajiAspectSel = container.querySelector('#posterAjiAspect');
  if (ajiAspectSel) ajiAspectSel.addEventListener('change', function() {
    var cat = _getActiveCategory();
    var cfg = _getCfg(cat);
    cfg.aji = cfg.aji || {};
    cfg.aji.aspect = ajiAspectSel.value;
    _setCfg(cat, cfg);
    _patchGenerateMeta(container);
    _patchPromptPreview(container);
  });

  // Roll 次数 — 局部更新
  var rollsSel = container.querySelector('#posterRolls');
  if (rollsSel) rollsSel.addEventListener('change', function() {
    var cat = _getActiveCategory();
    var cfg = _getCfg(cat);
    cfg.rolls = parseInt(rollsSel.value, 10) || 1;
    if (cfg.rolls < 1) cfg.rolls = 1; if (cfg.rolls > 4) cfg.rolls = 4;
    _setCfg(cat, cfg);
    _patchGenerateMeta(container);
  });

  // 生成
  var genBtn = container.querySelector('#posterGenerateBtn');
  if (genBtn) genBtn.addEventListener('click', function() {
    _doGenerate(container);
  });

  // 自动填写
  var autofillInp = container.querySelector('#posterAutofillInput');
  if (autofillInp) autofillInp.addEventListener('input', function() {
    var cat = _getActiveCategory();
    var cfg = _getCfg(cat);
    cfg.autofillText = autofillInp.value;
    _setCfg(cat, cfg);
  });
  var autofillBtn = container.querySelector('#posterAutofillBtn');
  if (autofillBtn) autofillBtn.addEventListener('click', function() {
    var cat = _getActiveCategory();
    var cfg = _getCfg(cat);
    var txt = (cfg.autofillText || '').trim();
    if (!txt) {
      TileAPI.toast('请先粘贴待解析的文案', 'warn');
      return;
    }
    var statusEl = container.querySelector('#posterAutofillStatus');
    if (statusEl) { statusEl.textContent = '正在调用 AI 解析…'; statusEl.className = 'poster-autofill-status is-loading'; }
    autofillBtn.disabled = true;
    autofillBtn.textContent = '⏳ 解析中…';
    TileAPI.sendToHost('posterAutofill', { mode: cat, userText: txt });
  });
}

// ========== 添加图片到池子 ==========
function _addImagesToPool(newImages) {
  var cat = _getActiveCategory();
  var cfg = _getCfg(cat);
  cfg.images = cfg.images || [];
  for (var i = 0; i < newImages.length; i++) {
    var im = newImages[i];
    if (!im || !im.base64) continue;
    if (cfg.images.length + _countUploadsAsImages(cfg) >= MAX_IMAGES) {
      TileAPI.toast('已达 ' + MAX_IMAGES + ' 张上限,新增图片被忽略', 'warn');
      break;
    }
    cfg.images.push(im);
  }
  _setCfg(cat, cfg);
  if (_activeContainer) _renderPanel(_activeContainer);
}

// ========== 生成 ==========
function _doGenerate(container) {
  var cat = _getActiveCategory();
  var cfg = _getCfg(cat);

  // 校验
  var pages = cfg.pages || { 1: [] };
  var pageNums = Object.keys(pages).map(Number).sort(function(a, b) { return a - b; });
  var hasContent = false;
  for (var p = 0; p < pageNums.length; p++) {
    if ((pages[pageNums[p]] || []).length > 0) { hasContent = true; break; }
  }
  if (!hasContent) {
    TileAPI.toast('请先把图片池里的图分配到至少一页', 'warn');
    return;
  }

  // 取 API 配置(必须 AJI 通道,GPT-Image 当前只走 AJI)
  // 按用户在面板里选的 provider 读对应 connection(不依赖全局激活的 provider)
  var provider = cfg.provider || 'grs';
  if (provider !== 'grs' && provider !== 'aji') provider = 'grs';
  var conn = _getProviderConnection(provider);
  if (!conn || !conn.url || !conn.key) {
    var pnameDef2 = provider === 'grs' ? TileAPI.computeBrand() : 'AJI';
    var pname = TileAPI.slotLabel ? TileAPI.slotLabel(provider, pnameDef2) : pnameDef2;
    if (conn && conn._grsKeyPending) TileAPI.toast('正在准备夏三七, 请稍后再试', 'info');
    else if (conn && conn._grsNeedLogin) TileAPI.toast('夏算力托管需要登录 (顶栏账号区), 或切回「自带 Key」', 'error');
    else TileAPI.toast('请先到「设置」磁贴配置 ' + pname + ' 通道的 URL 和 Key', 'error');
    return;
  }

  // 拼基础 prompt
  var basePrompt = _buildPrompt(cat, cfg);

  // 收集每页要发的 base64 列表 + 给每页 × 每 roll 分配一个 taskCardId(任务卡)
  // 同页 N 个 roll 共享一个 convTaskId(对话气泡用,自动合并显示成 ×N 主体 + N 张回图)
  var rolls = +cfg.rolls || 1;
  if (rolls < 1) rolls = 1; if (rolls > 4) rolls = 4;
  var jobs = [];
  var running = TileAPI.state.get('tasks.running') || {};
  var meta = TileAPI.state.get('tasks.meta') || {};
  var promptSnippet = (basePrompt || '').replace(/\s+/g, ' ').trim().substring(0, 30);

  for (var pi = 0; pi < pageNums.length; pi++) {
    var pn = pageNums[pi];
    var refs = _allImagesForGen(cfg, pn);
    if (refs.length === 0) continue;
    if (refs.length > MAX_IMAGES) refs = refs.slice(0, MAX_IMAGES);

    // 同页所有 roll 共享同一个对话气泡 ID
    var convTaskId = 'poster_p' + pn + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

    for (var ri = 1; ri <= rolls; ri++) {
      // 任务卡用独立 ID
      var taskCardId = convTaskId + '_card_r' + ri;
      jobs.push({
        convTaskId: convTaskId,    // 对话气泡合并键 (同页同一个)
        taskCardId: taskCardId,    // 任务卡独立 ID
        pageNum: pn,
        rollIdx: ri,
        rollTotal: rolls,
        refs: refs,
        prompt: basePrompt + '\n\n[Page ' + pn + ' of ' + pageNums.length + ', Roll ' + ri + ' of ' + rolls + ']'
      });

      // 注册到任务系统(每 roll 一卡)
      running[taskCardId] = {
        engine: 'banana',
        provider: provider,
        batchSize: 1,
        startTime: Date.now(),
        success: 0, fail: 0, total: 0,
        model: (cfg.aji && cfg.aji.model) || 'gpt-image-2',
        presetTitle: rolls > 1
          ? ('海报 P' + pn + '/' + pageNums.length + ' · R' + ri + '/' + rolls)
          : ('海报 P' + pn + '/' + pageNums.length),
        promptSnippet: promptSnippet,
        thumbnail: null,
        docId: null,
        selection: null
      };
      meta[taskCardId] = {
        countdown: 300,
        timeoutSec: 3600,
        autoReturn: true,
        batchSize: 1
      };
      TileAPI.emit('task:started', { taskId: taskCardId, timeoutSec: 3600, batchSize: 1 });
      TileAPI.emit('generate:started', { taskId: taskCardId, engine: 'gpt-image', model: running[taskCardId].model, batch: 1 });
    }
  }

  if (!jobs.length) {
    TileAPI.toast('没有可生成的页', 'warn');
    return;
  }

  TileAPI.state.set('tasks.running', running);
  TileAPI.state.set('tasks.meta', meta);
  TileAPI.emit('tasks:updated');

  _setStatus(container, '准备生成 ' + jobs.length + ' 页…', 'info');
  var aji = cfg.aji || { model: 'gpt-image-2', size: '4K', aspect: '16:9' };
  var px = _gptSizeToPixels(aji.size, aji.aspect);
  TileAPI.sendToHost('posterGenerate', {
    jobs: jobs,
    multiplier: cfg.multiplier,
    posterW: px.w,
    posterH: px.h,
    category: cat,
    provider: provider,        // 'grs' 或 'aji'
    apiKey: conn.key,
    apiUrl: conn.url,
    gptModel:  aji.model,
    gptSize:   aji.size,
    gptAspect: aji.aspect
  });
}

function _setStatus(container, msg, kind) {
  var el = container.querySelector('#posterStatus');
  if (!el) return;
  if (!msg) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.className = 'poster-status poster-status-' + (kind || 'info');
  el.textContent = msg;
}

// ========== 注册磁贴 ==========
TileAPI.registerTile({
  id: 'poster',
  group: 'main',
  icon: '📰',
  label: '海报排版',
  desc: 'GPT-Image · Cosplay 排版',
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderFront: renderFront,

  onExpand: function(container) {
    _activeContainer = container;
    _firstRender = true;     // 每次重新展开磁贴都允许 stagger 入场动画
    // 关闭磁贴再重开,任何残留的编辑器未保存数据都丢弃,直接回到主面板
    _editorMounted = false;
    _editorData = null;
    _editorPendingClose = false;
    _renderPanel(container);

    // 监听夏算力 sub-key 到位事件: 拿到后自动重渲, 蓝色"准备中"警告自动消失。
    // 但 compute:keyUpdated 会被登录/对账/续杯连发 —— 必须做两层防抖, 否则整块大面板
    // 被反复同步重建, 开面板瞬间卡死:
    //   1. 状态签名没变 → 直接跳过 (重复事件不重渲)
    //   2. 真变了也合并 200ms 内的连发, 只重渲一次
    var _lastKeySig = _computeKeySig();
    var _keyRerenderTimer = null;
    var onKeyReady = function() {
      if (_activeContainer !== container) return;
      var sig = _computeKeySig();
      if (sig === _lastKeySig) return;
      _lastKeySig = sig;
      if (_keyRerenderTimer) clearTimeout(_keyRerenderTimer);
      _keyRerenderTimer = setTimeout(function() {
        _keyRerenderTimer = null;
        if (_activeContainer === container) _renderPanel(container);
      }, 200);
    };
    TileAPI.on('compute:keyUpdated', onKeyReady);

    return function() {
      _activeContainer = null;
      if (_keyRerenderTimer) { clearTimeout(_keyRerenderTimer); _keyRerenderTimer = null; }
      TileAPI.off('compute:keyUpdated', onKeyReady);
    };
  },

  onCollapse: function() {
    _activeContainer = null;
    _firstRender = true;
    // 清编辑器残留状态,避免下次 reload 错走编辑器分支
    _editorMounted = false;
    _editorData = null;
    _editorPendingClose = false;
  },

  onMessage: function(action, data) {
    if (action === 'posterCaptureFromPSResult') {
      if (!data || !data.success) {
        TileAPI.toast('抓取失败: ' + (data && data.error || '?'), 'error');
        // 失败也重渲让"⏳ 抓取中…"按钮恢复成原文(原本只 toast 会让按钮卡 15s 超时才恢复)
        if (_activeContainer) _renderPanel(_activeContainer);
        return;
      }
      var cat = _getActiveCategory();
      var cfg = _getCfg(cat);
      if (data.slot === 'upload' && data.uploadKey) {
        cfg.uploads = cfg.uploads || {};
        cfg.uploads[data.uploadKey] = { name: data.name, base64: data.base64 };
        _setCfg(cat, cfg);
        if (_activeContainer) _renderPanel(_activeContainer);
        TileAPI.toast('已抓取到 ' + data.uploadKey, 'success');
      } else {
        // 默认 slot='pool'
        _addImagesToPool([{
          name: data.name,
          base64: data.base64,
          thumbBase64: data.thumbBase64
        }]);
        TileAPI.toast('已抓取选区到素材池', 'success');
      }
    }
    else if (action === 'posterGenerateProgress') {
      if (!_activeContainer) return;
      _setStatus(_activeContainer, data.msg || '', data.kind || 'info');
    }
    else if (action === 'posterGenerateResult') {
      if (!_activeContainer) return;
      if (data && data.success) {
        _setStatus(_activeContainer, '✓ 生成完成 (' + (data.completedPages || 0) + ' 页)', 'ok');
        TileAPI.toast('海报生成完成', 'success');
      } else {
        _setStatus(_activeContainer, '✕ 生成失败: ' + (data && data.error || '?'), 'err');
        TileAPI.toast('海报生成失败', 'error');
      }
    }
    else if (action === 'posterAutofillResult') {
      _onAutofillResult(data);
    }
    else if (action === 'posterPromptsLoadResult') {
      _onPromptsLoadResult(data);
    }
    else if (action === 'posterPromptsSaveResult') {
      _onPromptsSaveResult(data);
    }
    else if (action === 'posterPromptsResetCategoryResult') {
      _onPromptsResetResult(data);
    }
  },

  onStorageLoaded: function(storage) {
    // 默认 expandMode = full(本磁贴只支持全屏展开)
    var modes = storage.get('__tile_expand_modes') || {};
    if (!modes['poster']) {
      modes['poster'] = 'full';
      storage.set('__tile_expand_modes', modes);
    }

    // 启动后立刻让 host 读用户预设(首次启动则用 factory 初始化)
    // 等 prompts.js 加载完(window._posterPromptsFactory 存在)
    function _kickPromptsLoad(retry) {
      retry = retry || 0;
      if (window._posterPromptsFactory) {
        TileAPI.sendToHost('posterPromptsLoad', {
          factory: window._posterPromptsFactory
        });
      } else if (retry < 30) {
        setTimeout(function() { _kickPromptsLoad(retry + 1); }, 100);
      }
    }
    _kickPromptsLoad();
  }
});

})();
