// ============================================================
//  tile-light-splitter.host.js — 自动拆光 后端处理器
//  ① lightSplitAnalyze: 抓选区 → 调 AI 助手 vision → 返回光源列表JSON
//  ② lightSplitTask: 抓选区(共用base64) → callAiApi → 贴回 → batchPlay设screen+重命名
// ============================================================

var HostAPI = require('../host/host-api.js');
var photoshop = require('photoshop');
var app = photoshop.app;
var core = photoshop.core;

function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

// 规范化 chat URL — 与 tile-hemisynth.host.js 同一套
function _normalizeChatUrl(url) {
  var u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return null;
  u = u.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(u)) { /* 已完整 */ }
  else if (/\/completions$/i.test(u)) { /* 老接口保留 */ }
  else if (/\/v\d+$/i.test(u)) u += '/chat/completions';
  else u += '/v1/chat/completions';
  return u;
}

// 从模型回复文本里挖 JSON 数组 (容忍 ```json 围栏 / 前后废话 / 截断)
function _extractJsonArray(text) {
  var t = String(text || '');
  var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1];
  // 尝试找完整数组
  var start = t.indexOf('[');
  if (start === -1) return null;
  var end = t.lastIndexOf(']');
  if (end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (_) {}
  }
  // 截断修复: 补右方括号
  var fixed = t.slice(start);
  var open = (fixed.match(/\[/g) || []).length;
  var close = (fixed.match(/\]/g) || []).length;
  for (var k = 0; k < open - close; k++) fixed += ']';
  // 补未闭合字符串
  var inStr = false, esc = false;
  for (var i = 0; i < fixed.length; i++) {
    var c = fixed[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') inStr = !inStr;
  }
  if (inStr) fixed += '"';
  fixed = fixed.replace(/,\s*$/, '');
  try { return JSON.parse(fixed); } catch (_) {}
  return null;
}

// ============================================================
//  光源分析 (LLM vision)
// ============================================================
HostAPI.registerAction('lightSplitAnalyze', async function(data, ctx) {
  var chatUrl = _normalizeChatUrl(data && data.chatUrl);
  var chatKey = (data && data.chatKey) || '';
  var chatModel = (data && data.chatModel) || '';
  function fail(msg) {
    ctx.logToPanel('[拆光·分析] ' + msg, 'error');
    ctx.sendToPanel('lightSplitAnalyzeResult', { success: false, error: msg });
  }

  try {

  if (!chatUrl) { fail('AI 助手 URL 无效'); return; }
  if (!chatKey || !chatModel) { fail('AI 助手配置缺失 (URL/Key/模型)'); return; }

  var doc = app.activeDocument;
  if (!doc) { fail('没有打开的文档'); return; }

  // 抓选区图压到1024px (与半合成自动识别同一逻辑)
  var captureBase64 = null;
  var savedMaxRes = ctx.g_maxResolutionRef ? ctx.g_maxResolutionRef.value : null;
  var savedAntiMode = ctx.g_antiTruncationModeRef ? ctx.g_antiTruncationModeRef.value : null;
  try {
    if (ctx.g_maxResolutionRef) ctx.g_maxResolutionRef.value = 1024;
    if (ctx.g_antiTruncationModeRef) ctx.g_antiTruncationModeRef.value = 0;
    await ctx.acquirePSLock(async function() {
      var cap = await ctx.getSelectionAndImage();
      if (cap && cap.base64) captureBase64 = cap.base64;
    }, 'litanalyze_' + Date.now());
  } finally {
    if (ctx.g_maxResolutionRef && savedMaxRes !== null) ctx.g_maxResolutionRef.value = savedMaxRes;
    if (ctx.g_antiTruncationModeRef && savedAntiMode !== null) ctx.g_antiTruncationModeRef.value = savedAntiMode;
  }
  if (!captureBase64) { fail('未能抓取选区/画布'); return; }

  ctx.logToPanel('[拆光·分析] 选区已抓取, 调用语言模型分析光源...', 'info');

  var sysPrompt =
    '你是一位专业的摄影灯光分析师。用户会给你一张人物照片,你要分析画面中所有照射在人物身上的光源。' +
    '\n对每个光源,输出以下信息:' +
    '\n- type: 光源类型,【只能从以下4种中选择】: 主光 / 辅光 / 填充 / 特效光。不要细分出"补光/轮廓光/逆光/顶光/底光/天光/实际光源"等子类别——它们都归入"辅光"或"填充"。' +
    '\n- direction: 光的照射方向,【简短方位词】(如"左前45°"/"正后方"/"顶部"/"环境")。不要写长句。' +
    '\n- color: 该光的实际颜色,【简短色温词】(如"暖白"/"冷蓝"/"橙黄"/"中性")。不要写长句。' +
    '\n- area: 该光在人物身上的照射区域,【简短部位词】(如"左脸左臂"/"头发边缘"/"全身均匀")。不要写长句。' +
    '\n- intensity: 强度等级,【只写一个字】: 强 / 中 / 弱' +
    '\n- description: 【留空或写不超过10字的定位词】,用于AI分离时定位。例如"左侧主光"/"边缘高光"/"蓝色环境光"。不要写长段描述。' +
    '\n' +
    '\n【类别定义】' +
    '\n- 主光: 画面中最亮、最主导的光,塑造主要明暗关系。通常只有1束。' +
    '\n- 辅光: 协助主光的定向光源(侧光/逆光/轮廓光/顶光等),有明确方向性。可以多束。' +
    '\n- 填充: 环境光/天光/反射光等无明确方向的均匀补光。' +
    '\n- 特效光: 画面中的魔法发光/能量光环/LED灯带等特效。' +
    '\n' +
    '\n重要规则:' +
    '\n1. 只输出一个JSON数组,不要输出任何其他文字' +
    '\n2. 数组中每个元素是一个光源对象,包含 type/direction/color/area/intensity/description 六个字段' +
    '\n3. type【只能是4选1】: 主光/辅光/填充/特效光。不要出现其他类别名' +
    '\n4. direction/color/area/description 都要【简短】——方位词/色温词/部位词,不要长句' +
    '\n5. description 字段【留空或不超过10字】,仅用于定位,不要写光的成因/作用/情绪等分析' +
    '\n6. 一般3-6束光,不要过多' +
    '\n7. 值里不要出现【】这两个符号';


  var body = JSON.stringify({
    model: chatModel,
    stream: false,
    temperature: 0.3,
    max_tokens: 2048,
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: [
        { type: 'text', text: '分析这张图中照射在人物身上的所有光源,输出JSON数组。' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + captureBase64 } }
      ] }
    ]
  });

  var controller = new AbortController();
  var timeoutId = setTimeout(function() { try { controller.abort(); } catch (_) {} }, 120 * 1000);
  var resp;
  var raw = '';
  try {
    resp = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + chatKey },
      body: body,
      signal: controller.signal
    });
    raw = await resp.text();
  } finally {
    clearTimeout(timeoutId);
  }

  if (!resp.ok) {
    var hints = { 401: 'Key 无效', 402: '余额不足', 404: '模型不存在', 429: '请求太频繁' };
    fail('语言模型 HTTP ' + resp.status + (hints[resp.status] ? ' (' + hints[resp.status] + ')' : '') + (raw ? ' — ' + raw.substring(0, 200) : ''));
    return;
  }

  var json = null;
  try { json = JSON.parse(raw); } catch (_) {}
  var choice0 = json && json.choices && json.choices[0];
  var content = choice0 && choice0.message && choice0.message.content;
  if (!content) { fail('语言模型返回格式异常'); return; }

  var sources = _extractJsonArray(content);
  if (!sources || !Array.isArray(sources) || sources.length === 0) {
    fail('未能从模型回复中解析出光源列表。原始片段: ' + String(content).substring(0, 200));
    return;
  }

  // 只保留需要的字段,净化
  var cleaned = [];
  var validTypes = ['主光', '辅光', '填充', '特效光'];
  for (var i = 0; i < sources.length; i++) {
    var s = sources[i];
    if (!s || !s.type) continue;
    cleaned.push({
      type: validTypes.indexOf(s.type) !== -1 ? s.type : '辅光',   // 非法类型兜底成"辅光"
      direction: String(s.direction || '').replace(/[【】]/g, '').substring(0, 20),  // 限20字
      color: String(s.color || '').replace(/[【】]/g, '').substring(0, 10),         // 限10字
      area: String(s.area || '').replace(/[【】]/g, '').substring(0, 20),           // 限20字
      intensity: String(s.intensity || '中').replace(/[【】]/g, ''),
      description: String(s.description || '').replace(/[【】]/g, '').substring(0, 15),  // 限15字
      enabled: true
    });
  }

  ctx.logToPanel('[拆光·分析] 识别到 ' + cleaned.length + ' 束光源', 'success');
  ctx.sendToPanel('lightSplitAnalyzeResult', { success: true, sources: cleaned });

  } catch (e) {
    var msg = (e && e.name === 'AbortError') ? '分析请求超时 (120秒)' : ((e && e.message) || String(e));
    fail(msg);
  }
});


// ============================================================
//  贴回后处理: 设混合模式screen + 重命名 + 设不可见
//  由前端监听 conversationEvent attach-layers 后调用 (生成走 runSingle 完整链路)
//  data: { docId, layerIDs: [id...], layerName }
// ============================================================
HostAPI.registerAction('lightSplitPostProcess', async function(data, ctx) {
  var docId = data && data.docId;
  var layerIDs = (data && data.layerIDs) || [];
  var layerName = (data && data.layerName) || '光域';
  if (!layerIDs.length) return;

  try {
    await ctx.acquirePSLock(async function() {
      await core.executeAsModal(async function() {
        if (docId) {
          await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: docId }] }], {});
        }
        for (var i = 0; i < layerIDs.length; i++) {
          var lid = layerIDs[i];
          // 按图层ID选中 (不用targetEnum, 防止用户切换图层导致错改)
          await app.batchPlay([{
            _obj: "select",
            _target: [{ _ref: "layer", _id: lid }],
            makeVisible: false
          }], {});
          // 设混合模式=screen + 重命名 + 不可见 (一次set搞定)
          await app.batchPlay([{
            _obj: "set",
            _target: [{ _ref: "layer", _id: lid }],
            to: {
              _obj: "layer",
              mode: { _enum: "blendMode", _value: "screen" },
              name: layerName,
              visible: false
            }
          }], {});
        }
      }, { commandName: "拆光-图层后处理" });
    }, 'lspost_' + Date.now());
    ctx.logToPanel('[拆光] 图层「' + layerName + '」已设为屏幕混合+隐藏', 'info');
  } catch (e) {
    ctx.logToPanel('[拆光] 图层后处理失败(图已贴回, 请手动设混合模式): ' + ((e && e.message) || e), 'warn');
  }
});

module.exports = {};
