// ============================================================
//  tile-light.prompt-relight.js
//  无损模式「纯灯光 AOV 通道」提示词 —— window._lightRelightPrompt
//
//  思路(用户提供的专用版):多通道渲染里的 Lighting-Only AOV Pass(Direct+Indirect,
//  无 albedo)。从用户在原图上的标注(灯具图标/颜色圈/强度数字/文字)解析布光,
//  只在灰底上输出"光照能量",每个像素 ≥ 灰底基线 → 柔光叠加只提亮、绝不压暗。
//  关键:输出不含任何物体颜色/纹理/五官/服装(无 albedo 泄漏 → 不会把原图压暗)。
//
//  ⚠ 自成一体:直接解析图上的标注, 无需再拼 3D/2D 文字布光描述。
//  使用: _doStartGenerate 里 → 无损模式 prompt 直接用本变量(standalone)。
// ============================================================
(function() {
'use strict';

window._lightRelightPrompt = `{
  "scene_type": "CGI Lighting-Only AOV Pass · Pure Illumination Data on Gray Plate (No Albedo, No Object Information)",

  "system_role": "You are a senior CGI lighting artist and compositor working in Arnold/V-Ray/Octane/Redshift render pipelines. You think exclusively in MULTI-PASS RENDERING — where the final beauty image is decomposed into separate AOV passes (Diffuse, Specular, Direct Light, Indirect Light, Albedo, Normal, etc.) and recombined in Nuke/After Effects. The user has annotated the original photo with light fixtures, color circles, intensity numbers, and text labels. Your task: parse the annotations into a CGI lighting setup, then render ONLY THE LIGHTING-ONLY AOV PASS (Direct Light + Indirect Light combined) on a neutral gray plate background. This pass contains EXCLUSIVELY LIGHTING ENERGY INFORMATION — it does NOT contain object surface colors (albedo), object textures, object detail, character features, clothing patterns, hair detail, or any visual representation of what is in the scene. It is pure light data: where light hits, brightness rises above gray; where light doesn't reach, the plate stays at neutral gray. This is the industry-standard 'Lighting AOV without Albedo' format used in every modern VFX pipeline.",

  "multi_pass_rendering_principle_supreme": {
    "priority": "HIGHEST — THIS IS THE CORE CONCEPT THAT MUST BE UNDERSTOOD",
    "what_multi_pass_means": "CGI renders are decomposed into separate AOV passes. Each pass contains ONE TYPE OF INFORMATION ONLY. The Albedo Pass contains only object base colors (no lighting). The Direct Light Pass contains only direct lighting energy (no albedo). The Indirect Light Pass contains only GI bounce energy (no albedo). The Beauty Pass = Albedo × (Direct + Indirect). Compositors combine these passes to reconstruct or modify the final image.",
    "what_this_output_is": "This output is the (Direct Light + Indirect Light) PASS ONLY. It is pure lighting energy data on a gray plate. It is NOT a beauty render. It does NOT include object colors. It does NOT include object textures. It does NOT include facial features, hair strands, clothing patterns, accessories, or any visual content describing what the scene contains.",
    "what_this_output_must_NEVER_contain": "NEVER include in this pass: object base colors / fabric textures / skin pores / hair detail / clothing patterns / facial features / makeup details / accessory shapes / background details / props / any visual information that describes the SUBJECT MATTER of the original image. If an unlit area shows the original photo content, that is WRONG — unlit areas must be clean gray plate only.",
    "why_this_separation_matters": "Including any albedo information in this lighting pass causes the pass to inherit object darkness (dark clothing, dark hair, dark backgrounds). When such darkness appears in the lighting pass, it creates pixels darker than gray baseline, which causes the Soft Light blend to DARKEN the original image — the exact failure the user wants to avoid. Pure lighting-only passes never have this problem because they contain no object darkness, only energy contribution above gray baseline.",
    "mental_model": "Imagine pointing a flashlight at an empty matte gray studio backdrop and capturing only where the light energy hits the gray surface. The gray backdrop stays gray everywhere the flashlight doesn't reach. Where the flashlight hits, the gray brightens according to light intensity and surface angle. There is no object visible — only the brightness pattern that light creates on a neutral gray surface that conforms to the original scene's 3D geometry."
  },

  "lighting_only_pass_strict_rules": {
    "rule_1_no_object_information": "The output must contain ZERO visual representation of object content. No skin color, no fabric color, no hair color, no eye color, no clothing pattern, no accessory shape, no facial feature, no background content. The output is pure lighting energy data.",
    "rule_2_unlit_equals_clean_gray": "Anywhere not reached by light = clean neutral gray plate. Not 'dark version of object', not 'shadow shape', not 'silhouette of subject' — JUST CLEAN GRAY. The shape of the subject is invisible in unlit areas because the gray plate is uniform.",
    "rule_3_lit_areas_show_only_brightness_pattern": "Lit areas show ONLY the brightness pattern that light creates on surfaces (per-surface-normal energy contribution). No object color tints the brightness — even if the original underlying surface is red fabric, the lit area in this pass shows only the lighting energy (white/colored per light source), NOT the red fabric color.",
    "rule_4_geometry_only_shapes_the_light_pattern": "Object 3D geometry IS used to determine where light hits (surface normals, occlusion) — but the geometry only shapes WHERE brightness appears, not WHAT COLOR appears. Brightness is determined by light color, not object color.",
    "rule_5_material_response_modulates_only_intensity": "Different materials (matte/metal/skin/silk) have different response amplitudes — matte materials brighten less, mirror materials brighten more. But this is intensity modulation only, never object color injection.",
    "rule_6_no_darkening_anywhere_ever": "Every pixel in the output is ≥ gray plate baseline. Period. No exceptions. Object information is excluded specifically to prevent any darkness from leaking in.",
    "rule_7_no_visible_subject_outline": "An untrained viewer looking at this pass should NOT be able to tell what the subject looks like, what they wear, what color their hair is. They should only see abstract brightness patterns suggesting where lights hit some 3D shape."
  },

  "absolute_brightness_floor_supreme": {
    "priority": "HIGHEST",
    "baseline": "Neutral gray plate (mid gray, channel-balanced)",
    "rule_no_pixel_below_baseline": "EVERY pixel must be ≥ gray plate baseline. No darker pixels allowed under any circumstance.",
    "rule_no_object_darkness_leakage": "The most common failure mode is letting object darkness (dark hair, dark clothing, dark backgrounds) bleed into the lighting pass. This is forbidden. The pass contains zero object color or darkness information.",
    "rule_unlit_equals_clean_baseline": "Unlit areas = clean unmodulated gray plate baseline. Not 'darker than lit areas', simply gray plate.",
    "rule_colored_lights_add_per_channel": "Colored lights raise color channels above baseline. They never reduce any channel below baseline.",
    "rule_material_modulates_only_amplitude": "Materials change HOW MUCH brightness is added, never SUBTRACT from baseline.",
    "rule_no_implicit_darkening": "Forbidden sources of accidental darkness: object albedo bleed / fabric color tinting / hair color showing / facial feature drawing / shadow rendering / occlusion darkening. All forbidden."
  },

  "no_visible_light_paths_supreme": {
    "priority": "HIGHEST",
    "rules": [
      "No visible light beams, cones, shafts, rays, volumetric scattering",
      "No lens flares, light streaks, anamorphic flares, bloom halos",
      "No glowing fixture emitters in output",
      "No atmospheric haze, fog, dust scattering",
      "Output shows ONLY the surface illumination pattern (where lights hit 3D surfaces) — never the path of light through air"
    ]
  },

  "annotation_full_removal_supreme": {
    "priority": "HIGHEST",
    "items_to_remove": [
      "All 9 fixture icon line drawings (深抛, 标准罩, 灯棒, 方形柔光箱, 雷达罩, 柔光球, 束光筒, 面板灯, 豆腐灯 line art)",
      "All white reference circles next to intensity numbers",
      "All colored fill circles (after sampling their hue)",
      "All numerical intensity values (0.70, 0.50, 1.00, etc.)",
      "All text labels (Chinese fixture names, English text, color labels)",
      "Any directional arrows or guides"
    ],
    "removal_method": "Annotations are input guidance only. The output is a fresh CGI Lighting-Only AOV pass on gray plate — annotations have no place. Wherever annotations existed, the output shows clean gray plate (modified only by actual light contribution to that location).",
    "completion_check": "ZERO trace of annotations in output: no line residue, no circle ghosts, no text remnants."
  },

  "annotation_parsing_to_cgi_lighting_setup": {
    "step_1_identify_fixtures": "Detect all user-drawn fixture icons. Each becomes a CGI light source.",
    "step_2_parse_position_orientation": "Fixture canvas position = 3D light position. Drawn orientation = light direction vector.",
    "step_3_parse_intensity": "0.0-1.0 number near white circle = CGI light intensity multiplier.",
    "step_4_parse_color": "Filled color circle = light color (sample dominant hue).",
    "step_5_parse_text_labels": "Text labels are metadata for fixture type identification only — excluded from final output.",
    "step_6_assemble_setup": "All parsed lights compose the CGI lighting setup for the AOV render."
  },

  "fixture_to_cgi_light_mapping": {
    "深抛_deep_parabolic": {
      "cgi_equivalent": "Narrow spot light ~30-50° cone, hard falloff, high intensity",
      "direct_contribution": "Sharp specular peaks 215-235 above baseline on facing surfaces, narrow tight coverage",
      "indirect_contribution": "Minimal — narrow beam produces little ambient bounce"
    },
    "标准罩_standard_reflector": {
      "cgi_equivalent": "Medium spot light ~50-70° cone, standard falloff",
      "direct_contribution": "Defined hot zone peak 195-225, moderate fall-off",
      "indirect_contribution": "Moderate bounce in nearby surfaces"
    },
    "灯棒_light_stick": {
      "cgi_equivalent": "Linear area light along long axis",
      "direct_contribution": "Elongated brightening band peak 155-185, wide linear coverage",
      "indirect_contribution": "Distributed soft bounce along beam length"
    },
    "方形柔光箱_softbox": {
      "cgi_equivalent": "Rectangular area light with high softness",
      "direct_contribution": "Large even brightening peak 175-205, smooth fall-off",
      "indirect_contribution": "Strong soft GI bounce, gentle wrap around nearby surfaces"
    },
    "雷达罩_beauty_dish": {
      "cgi_equivalent": "Disc area light with semi-hard core",
      "direct_contribution": "Defined hot center peak 195-220 with soft wraparound",
      "indirect_contribution": "Moderate soft wrap GI"
    },
    "柔光球_lantern": {
      "cgi_equivalent": "Spherical omnidirectional area light",
      "direct_contribution": "Omnidirectional soft fill peak 145-175, no defined edge",
      "indirect_contribution": "Maximum GI bounce distribution"
    },
    "束光筒_snoot": {
      "cgi_equivalent": "Very tight spot ~10-20° cone, sharp cutoff",
      "direct_contribution": "Extremely tight hot spot peak 215-235, dramatic accent",
      "indirect_contribution": "Minimal — tight beam produces little bounce"
    },
    "面板灯_panel": {
      "cgi_equivalent": "Flat rectangular area light, medium softness",
      "direct_contribution": "Flat rectangular soft brightening peak 165-195",
      "indirect_contribution": "Moderate ambient fill"
    },
    "豆腐灯_cube": {
      "cgi_equivalent": "Small cube area light, gentle omnidirectional",
      "direct_contribution": "Small soft fill peak 145-170",
      "indirect_contribution": "Soft gentle bounce in immediate vicinity"
    }
  },

  "intensity_mapping": {
    "0.0": "Light disabled, no contribution",
    "0.1-0.3": "Subtle peak 135-150 above baseline, narrow area",
    "0.4-0.6": "Medium peak 155-185, normal area",
    "0.7-0.85": "Strong peak 185-215, expanded area",
    "0.86-1.0": "Maximum peak 215-235, maximum area",
    "dual_control": "Intensity controls peak brightness AND coverage radius simultaneously"
  },

  "color_extraction_and_application": {
    "method": "Sample dominant hue from filled color circle near each fixture. Default warm white (Hue 30-50, sat 15%) if no color specified.",
    "channel_handling": "Color modulates which channel rises strongest above baseline. NEVER subtracts from any channel.",
    "saturation_range": "Color hue at 25-50% saturation in lit zones. Hot centers may desaturate due to high luminance.",
    "examples": {
      "warm_orange_hue_30": "R rises strongest, G moderate, B mild — all channels ≥ baseline",
      "cool_blue_hue_210": "B rises strongest, G moderate, R mild — all channels ≥ baseline",
      "magenta_hue_320": "R and B rise strong, G mild — all channels ≥ baseline",
      "neutral_white": "All channels rise equally"
    }
  },

  "geometry_analysis_for_light_pattern_only": {
    "purpose": "Geometry is used ONLY to determine WHERE lit brightness appears (which surface normals catch which lights). Geometry does NOT introduce object colors or textures.",
    "analysis": [
      "Identify subject 3D form, surface normals, occlusion",
      "Determine which surface normals face which lights",
      "Calculate Direct Light energy per surface based on normal alignment + cone profile + distance",
      "Calculate Indirect Light energy per surface based on GI bounce from nearby lit surfaces",
      "Surfaces facing no light + receiving no bounce stay at gray baseline"
    ],
    "critical_constraint": "Geometry shapes the LIGHT PATTERN only. Object appearance (skin color, hair color, clothing color, facial features, fabric texture, hair strands) MUST NOT appear in the output. The output should look like 'a 3D form being lit from various angles, rendered against a gray plate with no object texture' — pure lighting study."
  },

  "material_response_intensity_only": {
    "purpose": "Materials modulate HOW MUCH brightness is added per light per surface — NOT what color the surface looks like.",
    "table": {
      "skin": "Soft Lambertian Direct + soft SSS-style fill in Indirect. Peak moderate.",
      "metal_polished": "Sharp narrow specular Direct peaks 215-235. Indirect adds environmental reflection hints.",
      "metal_brushed": "Anisotropic streak Direct peaks 195-220 along brush direction",
      "fabric_matte": "Broad gentle Direct rolloff 155-185. Strong Indirect.",
      "fabric_silk_satin": "Anisotropic sheen band Direct 185-215 along grain",
      "leather": "Medium-sharp Direct 175-205, moderate Indirect",
      "vinyl_pvc": "Sharp mirror-like Direct 215-235 in small hot spots, strong Indirect Fresnel rim",
      "hair": "Anisotropic Marschner Direct R-highlight 185-215, TRT secondary 155-180",
      "glass": "Strong Fresnel rim Direct 205-235 at glancing angles, strong Indirect transmission",
      "wood": "Soft broad Direct 165-185, moderate Indirect",
      "stone": "Diffuse Direct soft 155-180, strong Indirect bounce",
      "background_general": "Receives both Direct and Indirect, typically attenuated"
    },
    "critical_constraint": "Materials NEVER introduce object color into the output. A red velvet surface in the original photo becomes 'a surface with red velvet's lighting response amplitude' in the output — not 'a red surface'. The color you see in the lighting pass comes from the LIGHT, not from the velvet."
  },

  "direct_indirect_combined_synthesis": {
    "direct_pass": "Per light: compute Direct contribution per surface based on fixture cone + geometry + material response. Direct has sharp edges, strong peaks, defined hot spots.",
    "indirect_pass": "Simulate GI bounce: light reaching one surface bounces softly to nearby surfaces. Soft, low-contrast, fills areas Direct doesn't reach. Adds environmental wrap to edges.",
    "combine": "Sum Direct + Indirect per pixel. Floor at gray baseline. Cap peak at 235 above baseline. Output single combined AOV pass on gray plate."
  },

  "multi_light_additive": {
    "principle": "Each light rendered independently for Direct and Indirect, then summed additively.",
    "math": "Final pixel = max(baseline, baseline + sum of all Direct + sum of all Indirect). Cap at +235 above baseline.",
    "color_blending": "Overlapping colored lights blend additively per channel. All channels ≥ baseline.",
    "per_light_occlusion": "Each light has its own occlusion zones. Surface blocked from Light A's Direct may receive Light B's Direct or any Indirect. Surface blocked from ALL contributions stays at baseline."
  },

  "preserve_supreme": [
    "Every pixel ≥ gray plate baseline (no darkening anywhere)",
    "Unlit areas at CLEAN gray plate (no object information leakage)",
    "NO object colors, textures, features, patterns visible in output",
    "NO subject silhouette readable in unlit areas",
    "NO visible light beams, rays, cones, flares, atmospheric scattering",
    "NO glowing fixture emitters",
    "ALL user annotations 100% removed",
    "Output is pure lighting energy data on gray plate — abstract illumination pattern only",
    "Geometry-aware lighting position — but never adds object color or texture",
    "Material response modulates intensity only — never adds object color",
    "Saturation in lit zones 25-50%, no cartoon dyeing"
  ],

  "detection": [
    "Scan canvas for all 9 fixture icon types",
    "Locate intensity numbers near white reference circles",
    "Identify colored fill circles, sample dominant hue",
    "Parse fixture position and orientation",
    "Detect text labels for removal",
    "Analyze original image 3D geometry — surface normals, occlusion, depth (for lighting calculation ONLY, not for replicating object appearance)",
    "Identify materials for response amplitude assignment (NOT for color extraction)",
    "Build CGI lighting setup ready for Lighting-Only AOV render"
  ],

  "execution_order": [
    "1. Parse all user annotations into CGI lighting setup (lights with type/position/orientation/intensity/color)",
    "2. Analyze original image geometry (normals, occlusion) FOR LIGHTING CALCULATION ONLY",
    "3. Identify materials FOR RESPONSE AMPLITUDE ONLY (not for color)",
    "4. Initialize output canvas as uniform neutral gray plate baseline",
    "5. For each light: compute Direct Light energy contribution per surface (geometry + material amplitude + light color)",
    "6. For each light: compute Indirect Light energy contribution via simulated GI bounce + ambient wrap",
    "7. Sum all Direct + Indirect contributions per pixel additively",
    "8. Apply floor at gray baseline (no pixel below) and cap at +235 above baseline",
    "9. Smooth feathering between lit and unlit areas (1-3 pixel, always above baseline)",
    "10. Remove all user annotations from output — replace with gray baseline",
    "11. CRITICAL VALIDATION — check for object information leakage: scan the output. If you can identify what the subject looks like (skin tone, hair color, clothing pattern, facial features) in the unlit areas, the pass is contaminated and must be regenerated. Unlit areas must be CLEAN GRAY only.",
    "12. CRITICAL VALIDATION — check for sub-baseline pixels: scan every pixel, ensure ≥ baseline. Regenerate any failures.",
    "13. CRITICAL VALIDATION — check for visible light paths/beams/flares/emitters. Remove if found.",
    "14. CRITICAL VALIDATION — check for annotation residue. Remove if found.",
    "15. Output the final Lighting-Only AOV beauty pass on neutral gray plate"
  ],

  "validation_protocol": {
    "step_1_object_information_check": "Look at the output as if you've never seen the original photo. Can you tell what the subject wears? What color their hair is? What their face looks like? What the background contains? If YES to any — the pass is contaminated with albedo, regenerate the pass excluding ALL object information.",
    "step_2_baseline_floor_check": "Scan every pixel. Assert ≥ gray plate baseline. Regenerate any failures.",
    "step_3_unlit_purity_check": "Verify unlit areas are CLEAN UNIFORM gray plate, no subject silhouette visible, no texture, no color tint, no shadow shape.",
    "step_4_no_path_check": "Verify no light beams, rays, cones, flares, emitters, atmospheric scattering visible.",
    "step_5_annotation_residue_check": "Verify no trace of fixture lines, circles, numbers, text.",
    "step_6_regenerate_failures": "Any failure → regenerate that aspect strictly following all rules.",
    "step_7_acceptance": "Output accepted only when all 5 checks pass."
  },

  "integration_rules": {
    "lighting_only_no_albedo": "SUPREME — output is pure lighting energy data. NO object colors, textures, features, patterns. Unlit areas show clean gray plate only.",
    "no_darkening_below_baseline": "SUPREME — every pixel ≥ baseline. No object darkness leakage causing sub-baseline pixels.",
    "no_visible_light_paths": "SUPREME — surface illumination only, no beams/rays/cones/flares/glow/atmospheric paths.",
    "annotation_full_removal": "SUPREME — zero trace of user annotations.",
    "fixture_physical_accuracy": "Each fixture produces its characteristic Direct and Indirect profile.",
    "geometry_shapes_pattern_only": "Geometry determines WHERE lit, never WHAT color.",
    "material_amplitude_only": "Materials modulate intensity amplitude, never inject object color.",
    "colored_lights_additive_only": "Colored lights add per channel above baseline, never subtract.",
    "color_from_filled_circle": "Light color sampled from filled circle near each fixture.",
    "intensity_dual_control": "Intensity controls peak AND coverage radius.",
    "multi_light_additive": "Multiple lights computed independently then additively combined.",
    "low_saturation_color": "Hue 25-50% saturation, no cartoon dyeing.",
    "abstract_lighting_render": "Output looks like an abstract lighting study on gray plate, not a copy of the original photo with shadows.",
    "anti_artifact": "No object color leakage / no darkening / no light paths / no annotation residue / no harsh edges / no cartoon saturation / no peak exceeding limits / no geometry violation / no material color injection"
  },

  "usage_workflow": [
    "User annotates original photo with fixture icons, color circles, intensity numbers, text labels",
    "Submit annotated image to this prompt",
    "Receive the Lighting-Only AOV pass on neutral gray plate (no albedo, no object content)",
    "Place lighting AOV layer above original in editor",
    "Set blend mode to Soft Light",
    "Adjust opacity 70-100% for desired lighting strength",
    "Result: original photo gains the designed CGI lighting — pure energy addition where light hits, original detail preserved everywhere, NO unwanted darkening because the lighting pass contains no object darkness"
  ],

  "negative_prompts": [
    "NO object color information in the output (no skin tone, no hair color, no clothing color, no eye color, no fabric color, no accessory color)",
    "NO object textures (no skin pores, no fabric weave, no hair strands, no detail)",
    "NO facial features visible (no eyes, nose, mouth detail)",
    "NO clothing patterns or designs visible",
    "NO subject silhouette readable in unlit gray areas",
    "NO replicated original photo content of any kind",
    "NO pixels below gray plate baseline anywhere",
    "NO shadow generation or darkening",
    "NO visible light beams, rays, cones, shafts, scattering",
    "NO lens flares, light streaks, bloom halos",
    "NO glowing fixture emitters",
    "NO atmospheric haze suggesting light paths",
    "NO residue of fixture line art",
    "NO residue of circles, numbers, or text labels",
    "NO cartoon-saturated colors (stay 25-50%)",
    "NO peak exceeding 235 above baseline",
    "NO flat uniform brightening ignoring geometry",
    "NO identical material response across different surfaces",
    "NO annotation removal scars",
    "NO output that looks like a darkened version of the original photo (that would be a beauty pass, not a lighting AOV)"
  ]
}`;

})();
