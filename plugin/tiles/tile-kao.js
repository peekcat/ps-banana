// ============================================================
//  tile-kao.js  —  尻特效 (VFX 粒子特效)
//  逻辑/参数移植自新开发者 PSBananaUXP 的 VFXModule。
//  UI 遵循 _dev/UI_SPEC.md: 单层 .w10-panel + 标准 .w10-* 组件。
//  生成走轮椅总体配置渠道, 并接入任务队列(tasks.running/meta + 历史)。
// ============================================================
(function() {
'use strict';

// ========== Private state ==========
// #14: 支持并发 — 用计数器 + taskId 数组代替单一布尔锁
var _runningCount = 0;
var _taskIds = [];
var _activeContainer = null;
var _saveTimer = null;

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
//  VFX 逻辑核心 (与 DOM 解耦, 状态全在 S 对象)
// ============================================================
var VFX_EFFECTS = [
  { id: "particleDensity", name: "细沙状粒子逸散", defaultWeight: 0.7, category: "density" },
  { id: "distortion", name: "接触面扭曲解离", defaultWeight: 0.6, category: "intensity" },
  { id: "heatHaze", name: "粒子周围热空气折射", defaultWeight: 0.6, category: "intensity" },
  { id: "chromatic", name: "粒子边缘色散", defaultWeight: 0.4, category: "degree" },
  { id: "flocculent", name: "细小组絮状粒子", defaultWeight: 0.5, category: "amount" },
  { id: "fadeSpeed", name: "主粒子褪散至无色", defaultWeight: 0.6, category: "speed" },
  { id: "hideLines", name: "隐藏原始线条痕迹", defaultWeight: 0.7, category: "hide" },
  { id: "fresnel", name: "菲涅尔能量(按明暗)", defaultWeight: 0.7, category: "intensity" },
  { id: "edgeWarp", name: "图形边缘光线扭曲", defaultWeight: 0.5, category: "intensity" },
  { id: "selfGlowLuma", name: "自发光范围(明度联动)", defaultWeight: 0.6, category: "glowRange" },
  { id: "densityByTransparency", name: "粒子密度(基于线条透明度)", defaultWeight: 0.6, category: "densityByAlpha" }
];

var PARTICLE_DESCRIPTIONS = {
  main: {
    original: "影视级VFX流体粒子，粒子呈细沙状，单个粒子轮廓清晰可辨；主粒子与周边细小组絮状粒子保持同步逸散节奏，运动轨迹协调统一；虚化效果需贴合物理逻辑，真实自然；粒子质感细腻柔和，逸散动态流畅顺滑，色调与底图高度统一，粒子运动方向严格遵循线条走向，彻底隐藏绘制线条痕迹。",
    energy: "高饱和 HDR 自发光粒子，自带弥散辉光光晕，无环境光照影响；加法叠加渲染效果，粒子叠加区域亮度递增，色彩可按参考图配色渐变过渡。粒子形态可呈不规则能量束或流动的波前。整体充满爆发感与科技感。所有粒子的颜色**严格从参考图或绘制的线条图形中提取**，无预设色彩。",
    volumetric: "体积粒子：高斯模糊软云，不规则噪声形状，径向渐变，散射光，叠加混合，深度消隐，先膨胀后收缩生命周期，体积雾粒子，三维单形噪波，四层采样，背光透射，半透明边缘，无硬边界。粒子的所有颜色完全从参考图或绘制的线条图形中提取，无预设色彩。",
    smoke: "烟雾粒子：湍流，S形轨迹，柏林噪波场，自阴影，背光银边，菲涅尔效应，顶光，折射扭曲，轻薄烟缕，头浓尾淡，涡旋扰动，热浮升，渐变，屏幕空间扭曲。粒子的所有颜色完全从参考图或绘制的线条图形中提取，无预设色彩。",
    hair: "毛发粒子：锥形曲线条带，分叉末端，各向异性高光，重力效果，次级运动延迟，根部环境遮蔽，尖端透射亮部，正弦波风动，毛束，CatmullRom曲线卡片，根部固定尖端摆动（振幅0.2至0.8），Kajiya-Kay高光，背逆光边缘。粒子的所有颜色完全从参考图或绘制的线条图形中提取，无预设色彩。",
    burn: "燃烧粒子：VFX火焰特效，自发光，有零星火花迸射。作为主粒子时，粒子位于参考图形的中心，随混合占比由径向方向向边缘和末端扩展，火焰强度与范围随混合占比增加而向外蔓延。粒子的所有颜色完全从参考图或绘制的线条图形中提取，无预设色彩。"
  },
  secondary: {
    original: "辅助原始粒子特性：保持细沙状粒子质感，与主粒子逸散节奏同步，物理碰撞真实，色调统一。",
    energy: "辅助能量粒子特性：同样具有高饱和 HDR 自发光、弥散辉光光晕、无环境光照影响，叠加区域亮度递增。颜色随主能量粒子渐变过渡，增强整体能量爆发感。",
    volumetric: "辅助体积粒子特性：高斯模糊软云，不规则噪声，径向渐变，散射光，深度消隐，体积雾，三维噪波，背光透射，半透明边缘。",
    smoke: "辅助烟雾粒子特性：湍流，S形轨迹，柏林噪波，自阴影，菲涅尔效应，折射扭曲，涡旋扰动，热浮升，屏幕空间扭曲。",
    hair: "辅助毛发粒子特性：锥形条带，各向异性高光，重力，次级运动延迟，环境遮蔽，正弦波风动，CatmullRom曲线，Kajiya-Kay高光。",
    burn: "辅助燃烧粒子特性：VFX火焰特效，自发光，零星火花迸射。作为辅助粒子时，粒子位于参考图形的边缘，由混合占比控制范围，火焰强度与范围随混合占比增加而向内部/外部扩展。粒子的所有颜色完全从参考图或绘制的线条图形中提取，无预设色彩。"
  }
};

// 运行时状态
var S = null;
function _defaultState() {
  var fx = {};
  VFX_EFFECTS.forEach(function(e) { fx[e.id] = { weight: e.defaultWeight, enabled: true }; });
  return {
    fx: fx,
    ior: 1.33, iorOn: true,
    noiseRange: 0.5, noiseAmp: 0.5, noiseOn: true,
    blur: 0.5, blurOn: true,
    fresnelSpread: 0.5, fresnelOn: true,
    gravity: 0.5, gravityOn: true,
    mainType: 'original', secondaryType: 'none', mix: 0.3
  };
}
function _ensureState() {
  if (S) return;
  S = _defaultState();
  var saved = TileAPI.storage.get('kao.snapshot');
  if (saved) _applySnapshot(saved);
}
function _applySnapshot(s) {
  if (!s) return;
  if (s.fx) VFX_EFFECTS.forEach(function(e) {
    var v = s.fx[e.id];
    if (v) S.fx[e.id] = { weight: +v.weight, enabled: !!v.enabled };
  });
  ['ior', 'noiseRange', 'noiseAmp', 'blur', 'fresnelSpread', 'gravity', 'mix'].forEach(function(k) {
    if (typeof s[k] === 'number') S[k] = s[k];
  });
  ['iorOn', 'noiseOn', 'blurOn', 'fresnelOn', 'gravityOn'].forEach(function(k) {
    if (typeof s[k] === 'boolean') S[k] = s[k];
  });
  if (s.mainType) S.mainType = s.mainType;
  if (s.secondaryType) S.secondaryType = s.secondaryType;
}
function _saveSnapshot() { try { TileAPI.storage.set('kao.snapshot', S); } catch (e) {} }
function _saveDebounced() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(function() { _saveTimer = null; _saveSnapshot(); }, 300);
}

function _mapWeightToAdverb(weight, category) {
  var w = parseFloat(weight);
  if (category === "density") { if (w <= 0.2) return "稀疏"; if (w <= 0.4) return "偏少"; if (w <= 0.6) return "中等"; if (w <= 0.8) return "密集"; return "极密"; }
  if (category === "intensity") { if (w <= 0.2) return "隐约/轻微"; if (w <= 0.4) return "较弱"; if (w <= 0.6) return "中等"; if (w <= 0.8) return "明显/强烈"; return "极强"; }
  if (category === "degree") { if (w <= 0.1) return "几乎不可见"; if (w <= 0.3) return "轻微"; if (w <= 0.6) return "中等"; if (w <= 0.8) return "显著"; return "强烈色散"; }
  if (category === "amount") { if (w <= 0.2) return "少量"; if (w <= 0.4) return "偏少"; if (w <= 0.6) return "均衡"; if (w <= 0.8) return "大量"; return "极多"; }
  if (category === "speed") { if (w <= 0.2) return "慢速"; if (w <= 0.4) return "偏慢"; if (w <= 0.6) return "中速"; if (w <= 0.8) return "快速"; return "极快"; }
  if (category === "hide") { if (w <= 0.2) return "极少隐藏"; if (w <= 0.4) return "部分隐藏（弱）"; if (w <= 0.6) return "部分隐藏（中）"; if (w <= 0.8) return "大部分隐藏"; return "完全擦除"; }
  if (category === "glowRange") { if (w <= 0.2) return "微弱亮度联动"; if (w <= 0.4) return "轻度亮度联动"; if (w <= 0.6) return "中等亮度联动"; if (w <= 0.8) return "较强亮度联动"; return "极强亮度联动"; }
  if (category === "densityByAlpha") { if (w <= 0.2) return "极弱透明度影响"; if (w <= 0.4) return "轻度透明度影响"; if (w <= 0.6) return "中等透明度影响"; if (w <= 0.8) return "较强透明度影响"; return "极强透明度影响"; }
  return w.toFixed(1);
}

function _getEffectDescription(effectId, weight, enabled) {
  if (!enabled || weight === 0) return null;
  var effect = VFX_EFFECTS.find(function(e) { return e.id === effectId; });
  if (!effect) return null;
  var adv = _mapWeightToAdverb(weight, effect.category);
  switch (effectId) {
    case "particleDensity": return "产生" + adv + "的细沙状粒子逸散，每个粒子轮廓清晰可见";
    case "distortion": return "接触面呈现" + adv + "的扭曲解离质感（时空撕裂感）";
    case "heatHaze": return "粒子周边叠加" + adv + "的热空气折射效果（热浪扭曲，折射率 " + S.ior.toFixed(2) + "）";
    case "chromatic": return "粒子边缘有" + adv + "的色散现象（RGB分离）";
    case "flocculent": return "主粒子周围附带" + adv + "的细小组絮状粒子，同步飘散褪散";
    case "fadeSpeed": return "粒子颜色以" + adv + "褪散至无色透明";
    case "hideLines": return "原始绘制线条痕迹被" + adv + "隐藏";
    case "fresnel": {
      var range = "";
      var w = parseFloat(weight);
      if (w <= 0.2) range = "极小局部范围"; else if (w <= 0.4) range = "局部范围"; else if (w <= 0.6) range = "中等范围"; else if (w <= 0.8) range = "大范围"; else range = "全图形覆盖范围";
      var spreadDesc = "";
      if (S.fresnelOn) {
        if (S.fresnelSpread <= 0.2) spreadDesc = "效果**严格集中于粒子边缘**，产生强烈的边缘高光，几乎不向内部表面扩散。";
        else if (S.fresnelSpread <= 0.4) spreadDesc = "效果**偏重于粒子边缘**，边缘高光明显，表面仅有轻微的光晕。";
        else if (S.fresnelSpread <= 0.6) spreadDesc = "效果**边缘与表面均衡**，边缘高光和表面自发光强度相当。";
        else if (S.fresnelSpread <= 0.8) spreadDesc = "效果**偏向粒子表面蔓延**，表面自发光增强，边缘高光减弱。";
        else spreadDesc = "效果**大面积向粒子表面蔓延**，表面自发光覆盖整个粒子区域，边缘仅余微弱光效。";
      } else {
        spreadDesc = "效果采用默认的均衡分布（边缘与表面强度相当）。";
      }
      var lumaLink = "与粒子明度联动：明亮区域表面蔓延占主导，暗部区域边缘效果更显著。与自发光范围联动：自发光越强的粒子区域，蔓延效果越明显，整体光感增强。";
      return "菲涅尔自发光效果：颜色从参考图形中提取，光效沿图形曲面和噪波边缘生成，覆盖" + range + "（权重 " + w.toFixed(2) + "）。" + spreadDesc + " " + lumaLink + " 强度随曲面曲率、噪波密度及明度自然变化，无预设色彩。";
    }
    case "edgeWarp": return "图形边缘出现" + adv + "的光线扭曲，贴合轮廓，背景错位";
    case "selfGlowLuma": return "自发光范围随绘制曲线明度动态调整：" + adv + "，亮部粒子反光面积大、强度高，暗部粒子反光微弱";
    case "densityByTransparency": return "粒子密度随绘制线条透明度动态变化：" + adv + "（越透明的线条区域粒子越稀疏，越不透明的区域粒子越密集）";
    default: return "";
  }
}

function _getParticleTypeDescription() {
  var mainType = S.mainType, secondaryType = S.secondaryType, mix = S.mix;
  var mainDesc = PARTICLE_DESCRIPTIONS.main[mainType] || PARTICLE_DESCRIPTIONS.main.original;
  if (secondaryType === "none" || mix === 0) {
    return "粒子主体为" + mainDesc;
  }
  var mainPct = Math.round((1 - mix) * 100);
  var secPct = Math.round(mix * 100);
  var secDesc = PARTICLE_DESCRIPTIONS.secondary[secondaryType] || PARTICLE_DESCRIPTIONS.secondary.original;
  return "粒子混合类型：" + mainPct + "% 主粒子特性 + " + secPct + "% 辅助粒子特性。主粒子特性：" + mainDesc + " 辅助粒子特性：" + secDesc;
}

function _generateVFXPrompt() {
  var lines = [];
  lines.push("8K/4K超高清细节，照片级真实渲染质感，Houdini粒子系统（重点强化粒子运算精度）；基于参考图中的图形，在线条与人物/物体的接触面精准产生粒子逸散效果，接触面需突出扭曲解离质感；");
  lines.push("");
  lines.push("生成一张 4K 分辨率、照片级真实的影视特效图像。基于我提供的参考图，参考图中的绘制线条区域将作为所有效果的发生边界。");

  var mainType = S.mainType;
  if (mainType !== "none") lines.push(_getParticleTypeDescription());
  else lines.push("⚠️ 注意：本次生成不包含任何粒子效果，仅保留其他特效（扭曲、折射、褪色、菲涅尔、边缘扭曲、碰撞、景深、噪波、动态模糊等）。");

  lines.push("请严格按照以下要求生成其余效果：");

  var descMap = {};
  VFX_EFFECTS.forEach(function(effect) {
    var st = S.fx[effect.id];
    if (st && st.enabled && st.weight > 0) {
      var desc = _getEffectDescription(effect.id, st.weight, true);
      if (desc) descMap[effect.id] = desc;
    }
  });

  lines.push("1. 粒子逸散与质感：");
  if (mainType !== "none") {
    lines.push("   " + (descMap.particleDensity || "产生中等密度细沙状粒子逸散，单个粒子轮廓清晰可见") + "。");
    if (descMap.flocculent) lines.push("   " + descMap.flocculent + "。");
    if (descMap.densityByTransparency) lines.push("   " + descMap.densityByTransparency + "。");
  } else lines.push("   无粒子逸散效果（已关闭）。");

  lines.push("2. 接触面特殊效果：");
  lines.push("   " + (descMap.distortion || "接触面呈现中等扭曲解离质感") + "。");

  lines.push("3. 粒子颜色与褪色：");
  if (mainType !== "none") lines.push("   - 粒子颜色严格从底图中对应区域提取，然后" + (descMap.fadeSpeed || "中速褪散至无色") + "。");
  else lines.push("   - 无粒子褪色效果。");

  lines.push("4. 粒子周边光学效果：");
  if (mainType !== "none") {
    lines.push("   " + (descMap.chromatic || "粒子边缘有轻微色散") + "。");
    if (S.iorOn && descMap.heatHaze) lines.push("   " + descMap.heatHaze + "。");
    else lines.push("   粒子周边无热空气折射效果（已关闭）。");
  } else lines.push("   无粒子光学效果。");

  if (S.noiseOn && (S.noiseRange > 0 || S.noiseAmp > 0)) {
    var rangeDesc = S.noiseRange <= 0.1 ? "极窄范围" : (S.noiseRange <= 0.3 ? "较小范围" : (S.noiseRange <= 0.6 ? "中等范围" : (S.noiseRange <= 0.8 ? "大范围" : "超大范围")));
    var ampDesc = S.noiseAmp <= 0.1 ? "极低幅度" : (S.noiseAmp <= 0.3 ? "低幅度" : (S.noiseAmp <= 0.6 ? "中等幅度" : (S.noiseAmp <= 0.8 ? "高幅度" : "极高幅度")));
    lines.push("   全局噪波扭曲：影响范围" + rangeDesc + "（权重 " + S.noiseRange.toFixed(2) + "），噪波幅度" + ampDesc + "（幅度 " + S.noiseAmp.toFixed(2) + "），幅度越大噪波越细密随机，与粒子运动轨迹自然融合。");
  } else lines.push("   无全局噪波扭曲效果（已关闭）。");

  if (S.blurOn && S.blur > 0) {
    var blurDesc = "";
    if (S.blur <= 0.2) blurDesc = "轻微动态模糊，极细运动拖尾";
    else if (S.blur <= 0.4) blurDesc = "中等动态模糊，可见方向性拖尾";
    else if (S.blur <= 0.6) blurDesc = "显著动态模糊，强烈运动速度线";
    else if (S.blur <= 0.8) blurDesc = "高强度动态模糊，长拖尾与速度线重叠";
    else blurDesc = "极致动态模糊，残影与运动轨迹完全融合";
    lines.push("   全局动态模糊强度：" + blurDesc + "（权重 " + S.blur.toFixed(2) + "），粒子运动轨迹带方向性拖尾，符合物理快门速度。");
  } else lines.push("   无动态模糊效果（已关闭）。");

  lines.push("5. 线条隐藏：");
  lines.push("   " + (descMap.hideLines || "原始线条痕迹大部分隐藏") + "。");

  lines.push("6. 菲涅尔能量效果：");
  if (descMap.fresnel) lines.push("   " + descMap.fresnel + "。");
  else lines.push("   无菲涅尔自发光效果。");

  lines.push("7. 图形边缘光线扭曲：");
  lines.push("   " + (descMap.edgeWarp || "边缘出现中等光线扭曲，贴合轮廓") + "。");

  lines.push("8. 自发光范围：");
  if (mainType !== "none") {
    if (descMap.selfGlowLuma) lines.push("   " + descMap.selfGlowLuma + "。");
    else lines.push("   自发光范围无特殊亮度联动（常规漫反射）。");
  } else lines.push("   无自发光效果。");

  lines.push("9. 重力对粒子物理形态的影响：");
  if (S.gravityOn) {
    var gravityDesc = "";
    if (S.gravity <= 0.1) gravityDesc = "极微弱的引力影响，粒子几乎不受重力作用，仅存在极其轻微的下沉趋势。";
    else if (S.gravity <= 0.3) gravityDesc = "轻度重力影响，粒子缓慢下落，碰撞响应较为柔和。";
    else if (S.gravity <= 0.6) gravityDesc = "标准地球重力（约9.8m/s²），粒子下落速度正常，碰撞后弹跳符合物理预期。";
    else if (S.gravity <= 0.8) gravityDesc = "增强重力，粒子下落明显加快，堆积效应显著，碰撞后弹跳减弱。";
    else gravityDesc = "超强重力，粒子迅速坠落，几乎没有悬浮时间，碰撞后几乎不反弹。";
    lines.push("   " + gravityDesc + " 所有粒子的运动（逸散、碰撞、堆积、下落）均需严格遵守此重力设定，与画面的其他物体产生真实的物理互动。");
  } else lines.push("   重力已禁用，粒子处于完全失重状态，所有粒子自由漂浮，无定向下落或堆积行为。");

  lines.push("10. 强约束：");
  lines.push("    粒子需具备真实物理碰撞效果，可与画面内所有物体产生精准、自然的物理碰撞反应，碰撞反馈符合现实物理逻辑，无穿透、无悬浮等异常现象；粒子视为自碰撞体，其它的元素视为碰撞体。");

  lines.push("11. 景深与虚实效果：");
  lines.push("    根据粒子与主体（人物/物体）的**深度距离、明暗对比、远近关系**自动生成合理的景深虚化效果：近实远虚，主体清晰，粒子在纵深方向上产生自然的虚实过渡，与镜头焦距和光圈相匹配。粒子的模糊程度随距离主体越远而增强，明暗交界处保持适当锐度，避免整体模糊。");

  lines.push("12. 整体质量：");
  lines.push("    无噪点、无颗粒感、无模糊。虚化贴合物理景深。粒子运动方向严格遵循线条走向。色调与底图高度统一。");

  lines.push("");
  lines.push("负面提示词:禁止出现杂乱无章粒子、粒子颜色与底图存在偏差、无符合物理逻辑的虚化效果、粒子边缘无色散质感、无空气扭曲折射效果、缺失细小组絮状粒子、粒子轮廓模糊不可辨、粒子体积超出标准范围、接触面无扭曲解离效果、粒子运动轨迹僵硬不自然、粒子消散过程突兀生硬、画面细节缺失、整体画面模糊不清、线条出现扭曲变形、色调与底图偏差明显、画面存在颗粒感、画面存在噪点干扰。");

  return lines.join("\n");
}

function _randomizeAll() {
  VFX_EFFECTS.forEach(function(e) { S.fx[e.id] = { weight: Math.random(), enabled: Math.random() > 0.3 }; });
  S.iorOn = Math.random() > 0.2; S.ior = 1.0 + Math.random();
  S.noiseOn = Math.random() > 0.3; S.noiseRange = Math.random(); S.noiseAmp = Math.random();
  S.blurOn = Math.random() > 0.3; S.blur = Math.random();
  S.fresnelOn = Math.random() > 0.2; S.fresnelSpread = Math.random();
  S.gravityOn = Math.random() > 0.3; S.gravity = Math.random();
  var types = ['none', 'original', 'energy', 'volumetric', 'smoke', 'hair', 'burn'];
  S.mainType = types[Math.floor(Math.random() * types.length)];
  S.secondaryType = types[Math.floor(Math.random() * types.length)];
  S.mix = Math.random();
}

// ============================================================
//  渠道 / 模型 / 尺寸 (读全局配置)
// ============================================================
function _getConfigFor(provider) {
  // 统一读视图(rebuildModelViews 已给 aji/grs/momo/others 全建好), 自动覆盖 momo
  return TileAPI.state.get('models.' + (provider || 'aji')) || {};
}
function _populateModelSelect(sel, provider) {
  if (!sel) return;
  var cfg = _getConfigFor(provider);
  sel.innerHTML = '';
  for (var mid in cfg) {
    var opt = document.createElement('option');
    opt.value = mid;
    opt.textContent = (cfg[mid] && cfg[mid].name) || mid;
    sel.appendChild(opt);
  }
  var saved = TileAPI.storage.get('kao.model');
  if (saved && cfg[saved]) sel.value = saved;
}
function _populateSizeSelect(sel, provider, modelKey) {
  if (!sel) return;
  var cfg = _getConfigFor(provider);
  var mc = cfg[modelKey];
  var curSize = sel.value;
  sel.innerHTML = '';
  if (mc && mc.sizes) {
    mc.sizes.forEach(function(s) {
      var opt = document.createElement('option');
      opt.value = s; opt.textContent = s;
      sel.appendChild(opt);
    });
    if (mc.sizes.indexOf(curSize) !== -1) sel.value = curSize;
    else sel.value = mc.default || mc.sizes[0] || '';
  }
}
function _onModelChange(container) {
  var providerSel = container.querySelector('#kaoProvider');
  var modelSel = container.querySelector('#kaoModel');
  var sizeSel = container.querySelector('#kaoSize');
  var provider = (providerSel && providerSel.value) || 'aji';
  if (modelSel) {
    _populateSizeSelect(sizeSel, provider, modelSel.value);
    TileAPI.storage.set('kao.model', modelSel.value);
  }
}

// ============================================================
//  渲染 (单层 w10-panel + PS 细条滑块 + 分区 + 动态 tooltip)
//  分区遵循原版 PSBananaUXP: 粒子类型 / 11项特效 / 物理光学(分区开关) / 生成
// ============================================================
function _typeOptions(selected) {
  var list = [['none', '无'], ['original', '影视级流体'], ['energy', '能量自发光'], ['volumetric', '体积云'], ['smoke', '烟雾'], ['hair', '毛发'], ['burn', '燃烧']];
  var h = '';
  for (var i = 0; i < list.length; i++) h += '<option value="' + list[i][0] + '"' + (list[i][0] === selected ? ' selected' : '') + '>' + list[i][1] + '</option>';
  return h;
}

// 分区标题(可带一个区级总开关)
function _sectionTitle(title, togId, togOn) {
  if (!togId) return '<div class="w10-section-title">' + title + '</div>';
  return '<div class="w10-section-title" style="display:flex;align-items:center;justify-content:space-between;">' +
    '<span>' + title + '</span>' +
    '<div class="w10-toggle' + (togOn ? ' on' : '') + '" id="' + togId + '" style="flex-shrink:0;"></div>' +
  '</div>';
}

// PS 细条滑块行: 参数名(可挂 tooltip) + 数值 / 三角滑块(可在轨道行右侧挂一个开关)
function _psSliderRow(label, sliderId, value, min, max, step, valText, opts) {
  opts = opts || {};
  var disabled = !!opts.disabled;
  var fill = ((value - min) / (max - min) * 100).toFixed(1);
  var labelCls = opts.tip ? 'w10-row-label w10-tip-label' : 'w10-row-label';
  var tipAttr = opts.tip ? ' data-tip="" data-tipid="' + sliderId + '"' : '';
  var sliderInput = '<input type="range" id="' + sliderId + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '"' +
    (disabled ? ' disabled' : '') + ' style="--fill:' + fill + '%">';
  var trackRow;
  if (opts.togId) {
    // 轨道 + 开关 同一行
    trackRow = '<div style="display:flex;align-items:center;gap:8px;">' +
      '<div class="w10-ps-slider" style="flex:1;">' + sliderInput + '</div>' +
      '<div class="w10-toggle' + (opts.togOn ? ' on' : '') + '" id="' + opts.togId + '" style="flex-shrink:0;"></div>' +
    '</div>';
  } else {
    trackRow = '<div class="w10-ps-slider">' + sliderInput + '</div>';
  }
  return '<div class="w10-row" style="flex-direction:column;align-items:stretch;gap:4px;padding:5px 0;">' +
    '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;">' +
      '<div class="' + labelCls + '"' + tipAttr + ' style="font-size:11px;">' + label + '</div>' +
      '<span class="w10-ps-val" id="' + sliderId + 'Val">' + valText + '</span>' +
    '</div>' +
    trackRow +
  '</div>';
}

function _selectRow(label, selId, innerHtml) {
  // 下拉框靠右对齐: row-right 收成内容宽 (space-between 把它顶到右边缘),
  // select 固定宽度让各行左右边都对齐
  return '<div class="w10-row">' +
    '<div class="w10-row-left"><div class="w10-row-label">' + label + '</div></div>' +
    '<div class="w10-row-right"><select class="w10-select" id="' + selId + '" style="width:150px;max-width:55%;">' + innerHtml + '</select></div>' +
  '</div>';
}

function _renderLayout(container) {
  _ensureState();
  var provider = TileAPI.storage.get('kao.provider') || TileAPI.state.get('params.provider') || 'aji';
  var aspect = TileAPI.storage.get('kao.aspectRatio') || 'Auto';
  var batch = TileAPI.storage.get('kao.batch') || 1;
  var aspOpts = ['Auto', '1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4'];
  var aspHtml = '';
  for (var i = 0; i < aspOpts.length; i++) aspHtml += '<option' + (aspect === aspOpts[i] ? ' selected' : '') + '>' + aspOpts[i] + '</option>';

  var html = '<div class="w10-panel">';

  // —— 粒子类型 ——
  html += _sectionTitle('粒子类型');
  html += _selectRow('主粒子', 'kaoMainType', _typeOptions(S.mainType));
  html += _selectRow('辅粒子', 'kaoSecondaryType', _typeOptions(S.secondaryType));
  html += _psSliderRow('辅助混合占比', 'kaoMix', S.mix, 0, 1, 0.01, Math.round(S.mix * 100) + '%', {});

  // —— 11 项粒子特效 (每个带行内开关 + 动态 tooltip) ——
  html += _sectionTitle('粒子特效 (11 项)');
  VFX_EFFECTS.forEach(function(e) {
    var st = S.fx[e.id];
    html += '<div class="w10-row" style="flex-direction:column;align-items:stretch;gap:4px;padding:5px 0;">' +
      '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;">' +
        '<div class="w10-row-label w10-tip-label" data-tip="" data-tipid="kaoFx_' + e.id + '" style="font-size:11px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + e.name + '</div>' +
        '<span class="w10-ps-val" id="kaoFx_' + e.id + 'Val">' + st.weight.toFixed(2) + '</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;">' +
        '<div class="w10-ps-slider" style="flex:1;"><input type="range" id="kaoFx_' + e.id + '" min="0" max="1" step="0.01" value="' + st.weight + '"' + (!st.enabled ? ' disabled' : '') + ' style="--fill:' + (st.weight * 100).toFixed(1) + '%"></div>' +
        '<div class="w10-toggle' + (st.enabled ? ' on' : '') + '" id="kaoFxTog_' + e.id + '" style="flex-shrink:0;"></div>' +
      '</div>' +
    '</div>';
  });

  // —— 热折射 IOR (开关挂在轨道行) ——
  html += _sectionTitle('热空气折射 IOR');
  html += _psSliderRow('折射率 IOR', 'kaoIor', S.ior, 1, 2, 0.01, S.ior.toFixed(2), { disabled: !S.iorOn, tip: true, togId: 'kaoIorTog', togOn: S.iorOn });

  // —— 噪波 (一个开关管 范围+幅度 两个滑块; 开关放在「影响范围」轨道行) ——
  html += _sectionTitle('全局噪波');
  html += _psSliderRow('噪波影响范围', 'kaoNoiseR', S.noiseRange, 0, 1, 0.01, S.noiseRange.toFixed(2), { disabled: !S.noiseOn, tip: true, togId: 'kaoNoiseTog', togOn: S.noiseOn });
  html += _psSliderRow('噪波幅度(细密度)', 'kaoNoiseA', S.noiseAmp, 0, 1, 0.01, S.noiseAmp.toFixed(2), { disabled: !S.noiseOn });

  // —— 动态模糊 (开关挂在轨道行) ——
  html += _sectionTitle('动态模糊');
  html += _psSliderRow('模糊强度(运动拖尾)', 'kaoBlur', S.blur, 0, 1, 0.01, S.blur.toFixed(2), { disabled: !S.blurOn, tip: true, togId: 'kaoBlurTog', togOn: S.blurOn });

  // —— 菲涅尔 / 重力 (开关各自挂在轨道行) ——
  html += _sectionTitle('菲涅尔蔓延');
  html += _psSliderRow('边缘/表面蔓延', 'kaoFresnel', S.fresnelSpread, 0, 1, 0.01, S.fresnelSpread.toFixed(2), { disabled: !S.fresnelOn, togId: 'kaoFresnelTog', togOn: S.fresnelOn });
  html += _sectionTitle('重力');
  html += _psSliderRow('重力强度', 'kaoGravity', S.gravity, 0, 1, 0.01, S.gravity.toFixed(2), { disabled: !S.gravityOn, togId: 'kaoGravityTog', togOn: S.gravityOn });

  // —— 生成 ——
  html += _sectionTitle('生成');
  html += _selectRow('API 引擎', 'kaoProvider',
    TileAPI.slotOrder().map(function(eng) {
      var def = eng === 'aji' ? 'AJI' : eng === 'grs' ? (TileAPI.computeBrand ? TileAPI.computeBrand() : 'GRS') : 'Others';
      return '<option value="' + eng + '"' + (provider === eng ? ' selected' : '') + '>' + TileAPI.slotLabel(eng, def) + '</option>';
    }).join(''));
  html += _selectRow('模型', 'kaoModel', '');
  html += _selectRow('分辨率', 'kaoSize', '');
  html += _selectRow('宽高比', 'kaoAspect', aspHtml);
  // 生成数量: 输入框模式 (不是滑块)
  html += '<div class="w10-row">' +
    '<div class="w10-row-left"><div class="w10-row-label">生成数量</div></div>' +
    '<div class="w10-row-right"><input type="number" class="w10-input" id="kaoBatch" min="1" max="8" step="1" value="' + batch + '" style="width:80px;text-align:center;"></div>' +
  '</div>';

  html += '<div class="w10-row" style="border-bottom:none;flex-direction:column;align-items:stretch;gap:8px;">' +
    '<button class="w10-btn" id="kaoRandomBtn">💥 尻子大爆炸（随机所有参数）</button>' +
    '<div style="display:flex;gap:8px;">' +
      '<button class="w10-btn" id="kaoDisableBtn" style="flex:1;">关闭所有粒子</button>' +
      '<button class="w10-btn w10-btn-accent" id="kaoStartBtn" style="flex:2;">✨ 生成特效</button>' +
    '</div>' +
    '<div class="w10-row-desc" id="kaoStatus" style="text-align:center;"></div>' +
  '</div>';

  html += '</div>';
  container.innerHTML = html;
}

// ========== 只同步控件值, 不重建 DOM (修 bug: 随机/关闭时全局刷新) ==========
function _setSlider(container, id, value, valText) {
  var sl = container.querySelector('#' + id);
  if (sl) {
    var min = parseFloat(sl.min), max = parseFloat(sl.max);
    sl.value = value;
    sl.style.setProperty('--fill', ((value - min) / (max - min) * 100).toFixed(1) + '%');
  }
  var v = container.querySelector('#' + id + 'Val');
  if (v && valText != null) v.textContent = valText;
}
function _setToggle(container, id, on, slaveIds) {
  var tg = container.querySelector('#' + id);
  if (tg) tg.classList.toggle('on', !!on);
  (slaveIds || []).forEach(function(sid) { var s = container.querySelector('#' + sid); if (s) s.disabled = !on; });
}
function _syncControls(container) {
  if (!container) return;
  VFX_EFFECTS.forEach(function(e) {
    var st = S.fx[e.id];
    _setSlider(container, 'kaoFx_' + e.id, st.weight, st.weight.toFixed(2));
    _setToggle(container, 'kaoFxTog_' + e.id, st.enabled, ['kaoFx_' + e.id]);
  });
  _setSlider(container, 'kaoMix', S.mix, Math.round(S.mix * 100) + '%');
  _setSlider(container, 'kaoIor', S.ior, S.ior.toFixed(2)); _setToggle(container, 'kaoIorTog', S.iorOn, ['kaoIor']);
  _setSlider(container, 'kaoNoiseR', S.noiseRange, S.noiseRange.toFixed(2));
  _setSlider(container, 'kaoNoiseA', S.noiseAmp, S.noiseAmp.toFixed(2));
  _setToggle(container, 'kaoNoiseTog', S.noiseOn, ['kaoNoiseR', 'kaoNoiseA']);
  _setSlider(container, 'kaoBlur', S.blur, S.blur.toFixed(2)); _setToggle(container, 'kaoBlurTog', S.blurOn, ['kaoBlur']);
  _setSlider(container, 'kaoFresnel', S.fresnelSpread, S.fresnelSpread.toFixed(2)); _setToggle(container, 'kaoFresnelTog', S.fresnelOn, ['kaoFresnel']);
  _setSlider(container, 'kaoGravity', S.gravity, S.gravity.toFixed(2)); _setToggle(container, 'kaoGravityTog', S.gravityOn, ['kaoGravity']);
  var mainSel = container.querySelector('#kaoMainType'); if (mainSel) mainSel.value = S.mainType;
  var secSel = container.querySelector('#kaoSecondaryType'); if (secSel) secSel.value = S.secondaryType;
}

// 数值 bump 反馈
function _bump(container, id) {
  var v = container.querySelector('#' + id + 'Val');
  if (!v) return;
  v.classList.remove('bump'); void v.offsetWidth; v.classList.add('bump');
}

// ========== Running UI ==========
// #14: 按钮始终是"生成特效", 正在跑时括号里显示当前并发数量; 不再变成"中断"。
function _setRunningUI(container) {
  var btn = container ? container.querySelector('#kaoStartBtn') : null;
  if (!btn) return;
  btn.classList.add('w10-btn-accent');
  btn.style.color = '';
  btn.style.borderColor = '';
  btn.textContent = _runningCount > 0 ? ('✨ 生成特效 (' + _runningCount + ')') : '✨ 生成特效';
}

// ========== Event binding ==========
function _bindEvents(container) {
  // 粒子类型
  var mainSel = container.querySelector('#kaoMainType');
  if (mainSel) mainSel.addEventListener('change', function() { S.mainType = mainSel.value; _saveDebounced(); });
  var secSel = container.querySelector('#kaoSecondaryType');
  if (secSel) secSel.addEventListener('change', function() { S.secondaryType = secSel.value; _saveDebounced(); });
  var mix = container.querySelector('#kaoMix');
  if (mix) mix.addEventListener('input', function() {
    S.mix = +mix.value; mix.style.setProperty('--fill', (S.mix * 100).toFixed(1) + '%');
    var v = container.querySelector('#kaoMixVal'); if (v) v.textContent = Math.round(S.mix * 100) + '%';
    _bump(container, 'kaoMix'); _saveDebounced();
  });

  // 11 个效果滑块 + 开关
  VFX_EFFECTS.forEach(function(e) {
    var sl = container.querySelector('#kaoFx_' + e.id);
    if (sl) sl.addEventListener('input', function() {
      S.fx[e.id].weight = +sl.value; sl.style.setProperty('--fill', (sl.value * 100).toFixed(1) + '%');
      var v = container.querySelector('#kaoFx_' + e.id + 'Val'); if (v) v.textContent = (+sl.value).toFixed(2);
      _bump(container, 'kaoFx_' + e.id); _saveDebounced();
    });
    var tg = container.querySelector('#kaoFxTog_' + e.id);
    if (tg) tg.addEventListener('click', function() {
      var on = !S.fx[e.id].enabled; S.fx[e.id].enabled = on;
      tg.classList.toggle('on', on);
      if (sl) sl.disabled = !on;
      _saveDebounced();
    });
  });

  // 物理/光学
  function bindSlider(id, key, decimals) {
    var sl = container.querySelector('#' + id);
    if (sl) sl.addEventListener('input', function() {
      S[key] = +sl.value; sl.style.setProperty('--fill', ((sl.value - sl.min) / (sl.max - sl.min) * 100).toFixed(1) + '%');
      var v = container.querySelector('#' + id + 'Val'); if (v) v.textContent = (+sl.value).toFixed(decimals);
      _bump(container, id); _saveDebounced();
    });
  }
  function bindToggle(id, key, slaveIds) {
    var tg = container.querySelector('#' + id);
    if (tg) tg.addEventListener('click', function() {
      var on = !S[key]; S[key] = on;
      tg.classList.toggle('on', on);
      (slaveIds || []).forEach(function(sid) { var s = container.querySelector('#' + sid); if (s) s.disabled = !on; });
      _saveDebounced();
    });
  }
  bindSlider('kaoIor', 'ior', 2); bindToggle('kaoIorTog', 'iorOn', ['kaoIor']);
  bindSlider('kaoNoiseR', 'noiseRange', 2); bindSlider('kaoNoiseA', 'noiseAmp', 2); bindToggle('kaoNoiseTog', 'noiseOn', ['kaoNoiseR', 'kaoNoiseA']);
  bindSlider('kaoBlur', 'blur', 2); bindToggle('kaoBlurTog', 'blurOn', ['kaoBlur']);
  bindSlider('kaoFresnel', 'fresnelSpread', 2); bindToggle('kaoFresnelTog', 'fresnelOn', ['kaoFresnel']);
  bindSlider('kaoGravity', 'gravity', 2); bindToggle('kaoGravityTog', 'gravityOn', ['kaoGravity']);

  // 渠道/模型/尺寸/宽高比/数量
  var providerSel = container.querySelector('#kaoProvider');
  if (providerSel) providerSel.addEventListener('change', function() {
    TileAPI.storage.set('kao.provider', providerSel.value);
    _populateModelSelect(container.querySelector('#kaoModel'), providerSel.value);
    _onModelChange(container);
  });
  var modelSel = container.querySelector('#kaoModel');
  if (modelSel) modelSel.addEventListener('change', function() { _onModelChange(container); });
  var sizeSel = container.querySelector('#kaoSize');
  if (sizeSel) sizeSel.addEventListener('change', function() { TileAPI.storage.set('kao.size', sizeSel.value); });
  var aspSel = container.querySelector('#kaoAspect');
  if (aspSel) aspSel.addEventListener('change', function() { TileAPI.storage.set('kao.aspectRatio', aspSel.value); });
  var batchIn = container.querySelector('#kaoBatch');
  if (batchIn) {
    var _commitBatch = function() {
      var n = parseInt(batchIn.value, 10);
      if (isNaN(n)) n = 1;
      n = Math.max(1, Math.min(8, n));
      TileAPI.storage.set('kao.batch', n);
    };
    batchIn.addEventListener('input', _commitBatch);
    // 失焦时把越界/空值规整回 1–8
    batchIn.addEventListener('change', function() {
      var n = parseInt(batchIn.value, 10);
      if (isNaN(n)) n = 1;
      n = Math.max(1, Math.min(8, n));
      batchIn.value = n;
      TileAPI.storage.set('kao.batch', n);
    });
  }

  // 尻子大爆炸 (随机) — 修 bug: 只同步控件值, 不重建 DOM
  var randomBtn = container.querySelector('#kaoRandomBtn');
  if (randomBtn) randomBtn.addEventListener('click', function() {
    _randomizeAll(); _saveSnapshot(); _syncControls(container);
    TileAPI.toast('已随机所有参数', 'info');
  });
  // 关闭所有粒子 — 同样只同步, 不重建
  var disableBtn = container.querySelector('#kaoDisableBtn');
  if (disableBtn) disableBtn.addEventListener('click', function() {
    VFX_EFFECTS.forEach(function(e) { S.fx[e.id].enabled = false; });
    _saveSnapshot(); _syncControls(container);
    var st = container.querySelector('#kaoStatus'); if (st) st.textContent = '已关闭所有粒子效果（其他特效保留）';
  });

  // 生成 (可连续点, 并发提交)
  var startBtn = container.querySelector('#kaoStartBtn');
  if (startBtn) startBtn.addEventListener('click', function() {
    // #14: 不再阻塞 — 每次点击立即提交一个新任务, 可连续点并发。
    // 中断改到"任务列表"磁贴里逐个停 (列表的停止按钮 → earlyStopTask, host 已支持)。
    _doStart(container);
  });
}

// 给参数名挂动态 tooltip: 内容随当前滑块值变化
function _wireTooltips(container) {
  if (!window.TileTip) return;
  // 11 项特效: 动态描述(随值变化)
  VFX_EFFECTS.forEach(function(e) {
    var lab = container.querySelector('[data-tipid="kaoFx_' + e.id + '"]');
    if (lab) window.TileTip.attach(lab, function() {
      var st = S.fx[e.id];
      var d = _getEffectDescription(e.id, st.weight, st.enabled);
      return d || (e.name + '：当前已关闭');
    });
  });
  // 物理/光学: 简明动态说明
  var tipMap = {
    kaoIor: function() { return S.iorOn ? ('热空气折射(IOR=' + S.ior.toFixed(2) + ')：粒子周边热浪扭曲，数值越高折射越强') : '热折射已关闭'; },
    kaoNoiseR: function() { return S.noiseOn ? ('噪波影响范围 ' + S.noiseRange.toFixed(2) + '：值越大噪波扰动覆盖越广') : '噪波已关闭'; },
    kaoBlur: function() { return S.blurOn ? ('动态模糊 ' + S.blur.toFixed(2) + '：值越大运动拖尾越长') : '动态模糊已关闭'; }
  };
  Object.keys(tipMap).forEach(function(id) {
    var lab = container.querySelector('[data-tipid="' + id + '"]');
    if (lab) window.TileTip.attach(lab, tipMap[id]);
  });
}

function _afterRender(container) {
  var providerSel = container.querySelector('#kaoProvider');
  _populateModelSelect(container.querySelector('#kaoModel'), providerSel ? providerSel.value : 'aji');
  _onModelChange(container);
  var savedSize = TileAPI.storage.get('kao.size');
  var sizeSel = container.querySelector('#kaoSize');
  if (savedSize && sizeSel) {
    for (var i = 0; i < sizeSel.options.length; i++) {
      if (sizeSel.options[i].value === savedSize) { sizeSel.value = savedSize; break; }
    }
  }
  _bindEvents(container);
  _wireTooltips(container);
  _setRunningUI(container);
}

// ========== Start task ==========
function _doStart(container) {
  _ensureState();
  var prompt = _generateVFXPrompt();
  if (!prompt) { TileAPI.toast('生成提示词失败', 'error'); return; }

  var provider = (container.querySelector('#kaoProvider') || {}).value || TileAPI.state.get('params.provider') || 'aji';
  var conn = window._settingsGetActiveConnection ? window._settingsGetActiveConnection(provider) : { provider: provider, url: '', key: '' };
  if (!conn || !conn.key) {
    if (conn && conn._grsKeyPending) TileAPI.toast('正在准备夏算力, 请稍后再试', 'info');
    else if (conn && conn._grsNeedLogin) TileAPI.toast('夏算力托管需要登录 (顶栏账号区), 或切回「自带 Key」', 'error');
    else TileAPI.toast('当前渠道未配置 API Key，请到设置里填写', 'error');
    return;
  }
  if (!conn.url) { TileAPI.toast('当前渠道未配置 API 地址', 'error'); return; }

  var model = (container.querySelector('#kaoModel') || {}).value || '';
  var size = (container.querySelector('#kaoSize') || {}).value || '2K';
  var aspectRatio = (container.querySelector('#kaoAspect') || {}).value || 'Auto';
  var batch = parseInt((container.querySelector('#kaoBatch') || {}).value, 10) || 1;
  var timeout = 3600;
  var taskId = 'kao_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  var realProvider = conn.provider || provider;
  var autoReturn = TileAPI.storage.get('output.autoReturn') !== false;

  // 发给 host
  TileAPI.sendToHost('kaoVfxTask', {
    taskId: taskId, apiKey: conn.key, apiBaseUrl: conn.url, provider: realProvider,
    model: model, size: size, aspectRatio: aspectRatio, prompt: prompt, batchSize: batch, timeout: timeout,
    autoReturn: autoReturn
  });

  // 接入任务队列 (仿 tile-run)
  var running = TileAPI.state.get('tasks.running') || {};
  running[taskId] = {
    engine: 'kao', provider: realProvider, batchSize: batch, startTime: Date.now(),
    success: 0, fail: 0, total: batch, model: model,
    presetTitle: '尻特效', promptSnippet: '尻特效 · VFX 粒子',
    thumbnail: null, docId: null, selection: null, resolution: size
  };
  TileAPI.state.set('tasks.running', running);
  var meta = TileAPI.state.get('tasks.meta') || {};
  meta[taskId] = { countdown: timeout, timeoutSec: timeout, autoReturn: autoReturn, batchSize: batch };
  TileAPI.state.set('tasks.meta', meta);
  TileAPI.emit('tasks:updated');
  TileAPI.emit('task:started', { taskId: taskId, timeoutSec: timeout, batchSize: batch });
  TileAPI.emit('generate:started', { taskId: taskId, engine: 'kao', model: model, batch: batch, text: '尻特效 · VFX 粒子特效' });

  _taskIds.push(taskId);
  _runningCount++;
  _setRunningUI(container);
  TileAPI.toast('尻特效已提交', 'success');
  var st = container.querySelector('#kaoStatus'); if (st) st.textContent = '已提交，详见任务磁贴';
}

// ========== 完成 → 减计数 / 刷新按钮 (双保险: 全局事件 + host 消息) ==========
// #14: 按 taskId 逐个结算; 只处理本磁贴提交过的任务
function _finishOne(taskId, success, failNote) {
  if (taskId) {
    var idx = _taskIds.indexOf(taskId);
    if (idx === -1) return; // 不是本磁贴提交的, 或已结算过
    _taskIds.splice(idx, 1);
  }
  if (_runningCount > 0) _runningCount--;
  _setRunningUI(_activeContainer);
  if (_activeContainer) {
    var st = _activeContainer.querySelector('#kaoStatus');
    if (st) st.textContent = success ? '✅ 完成' : ('❌ ' + (failNote || '生成失败'));
  }
}
function _onGenComplete(data) {
  if (!data || !data.taskId) return;
  _finishOne(data.taskId, (data.success || 0) > 0);
}

// ========== 作者信息 (展开态头部带 = 标题右侧空白处) ==========
// .tile-inner 在展开态是 pointer-events:none, 链接放里面点不动,
// 所以把作者信息块作为绝对定位元素挂到 .tile 上 (它能拿到 pointer-events:auto),
// 落在 ✨标题 右侧、× 左侧的那条横向空白带里.
function _mountAuthorHeader(container) {
  var tile = (container && container.closest) ? container.closest('.tile') : null;
  if (!tile || !tile.classList.contains('expanded')) return;
  _unmountAuthorHeader(tile);
  var box = document.createElement('div');
  box.className = 'kao-author-hd';
  box.style.cssText = 'position:absolute;top:9px;left:70px;right:50px;z-index:6;' +
    'display:flex;flex-direction:column;gap:2px;pointer-events:auto;';
  box.innerHTML =
    '<div style="font-size:11px;color:var(--text-sub);line-height:1.35;">提示词贡献者：<span style="color:var(--text);font-weight:600;">大尻</span></div>' +
    '<div style="font-size:11px;color:var(--text-sub);line-height:1.35;">联系方式 QQ：<span style="color:var(--text);">2822440635</span></div>' +
    '<div style="font-size:11px;color:var(--text-sub);line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">尻老师个人课程咨询QQ群：' +
      '<a data-link-url="https://qm.qq.com/q/no7yxTE7m2" style="color:var(--accent);text-decoration:underline;cursor:pointer;">761387850（点击加群）</a>' +
    '</div>';
  tile.appendChild(box);
  // QQ 群链接 → 走 host openUrl (与公告链接同一拉起方式)
  var link = box.querySelector('[data-link-url]');
  if (link) link.addEventListener('click', function() {
    var u = link.getAttribute('data-link-url');
    if (u) TileAPI.sendToHost('openUrl', { url: u });
  });
}
function _unmountAuthorHeader(tile) {
  if (!tile) return;
  var old = tile.querySelector('.kao-author-hd');
  if (old && old.parentNode) old.parentNode.removeChild(old);
}

// ========== Tile Registration ==========
TileAPI.registerTile({
  id: 'kao',
  group: 'main',
  icon: '✨',
  label: '尻特效',
  desc: 'VFX 粒子特效生成',
  live: false,
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  onExpand: function(container) {
    _activeContainer = container;
    _renderLayout(container);
    _afterRender(container);
    _mountAuthorHeader(container);
    return function() {
      var tile = (container && container.closest) ? container.closest('.tile') : null;
      _unmountAuthorHeader(tile);
      if (window.TileTip) window.TileTip.hide();
      _activeContainer = null;
    };
  },

  onMessage: function(action, data) {
    // host 消息不带 taskId, 不动并发计数(计数由 generate:complete 按 taskId 结算);
    // 这里仅在失败时给个状态文字 + toast 提示。
    if (action === 'kaoComplete' && data) {
      if (data.error) {
        if (_activeContainer) {
          var st = _activeContainer.querySelector('#kaoStatus');
          if (st) st.textContent = '❌ ' + (data.error || '生成失败');
        }
        TileAPI.toast('尻特效失败: ' + data.error, 'error');
      }
    }
  },

  onStorageLoaded: function(storage) {
    // 默认 expandMode = full (本磁贴强制全屏展开)
    var modes = storage.get('__tile_expand_modes') || {};
    if (!modes['kao']) {
      modes['kao'] = 'full';
      storage.set('__tile_expand_modes', modes);
    }
  }
});

// #14: generate:complete 必须模块级常驻监听 — 否则关闭面板后仍在跑的并发任务完成时
// 漏减计数, 导致 _runningCount/_taskIds 泄漏、下次展开按钮显示错误数量。
// _finishOne 内已用 _taskIds.indexOf 过滤, 只结算本磁贴提交的任务。
TileAPI.on('generate:complete', _onGenComplete);

})();
