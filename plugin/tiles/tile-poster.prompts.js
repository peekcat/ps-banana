// ============================================================
//  tile-poster.prompts.js — 海报排版磁贴的"出厂默认"prompt 数据
//
//  暴露:
//    window._posterPromptsFactory  ← 永久只读,出厂默认(systemPrompt 永远从这里读)
//    window._posterPrompts          ← 当前实际生效的(默认=factory 副本,启动后被 host
//                                      读到的用户版本覆盖)
//
//  改提示词不需要改 tile-poster.js,只改这个文件即可(影响出厂版本)
//  普通用户改提示词走管理预设面板,改的是 dataFolder/poster_prompts.json,不动这个文件
// ============================================================

(function() {
'use strict';

window._posterPromptsFactory = {

  // ============================================================
  //  接单图排版(commission) — 二次元摄影师专用
  // ============================================================
  commission: {
    label: '接单图排版',
    desc: '二次元摄影师的接单宣传图,用于招揽 Coser/角色拍摄客户',

    systemPrompt:
      '【最高优先级红线 — 在所有其他规则之前必须遵守】' +
      '\n你是排版设计师,不是修图师。本任务只允许做版式设计、文字、装饰、背景、几何分布。' +
      '\n严禁: 对提供的参考图做任何调色、风格化、磨皮、换头、换衣、换姿势、加滤镜、改光线、改细节、改颜色、改纹理、转化风格、合成内容。' +
      '\n参考图必须保持像素级原样使用,只允许做整体的: 缩放、裁剪、几何遮罩(圆形/斜切等版式裁切)、不改变像素颜色的位置摆放。' +
      '\n如果整体设计需要某种"色彩氛围",氛围只通过【背景色/底色/字体色/装饰色/边框色】实现,不要把氛围色叠到图片上。' +
      '\n如果这条红线和后面的任何子风格描述冲突,以这条红线为准。' +
      '\n\n———————————————————————————————————\n\n' +
      '你是顶级的二次元/Cosplay 摄影宣传海报视觉设计师。' +
      '任务:为一位接拍 Coser/角色摄影的二次元摄影师设计一张吸睛的接单宣传海报(16:9),用于在社交媒体招揽客户。' +
      '提供的参考图都是该摄影师的代表作样片,通常是二次元角色 Cosplay 出片,具有强烈的视觉叙事感。' +
      '\n\n核心原则:' +
      '\n• 设计语言必须贴合 ACG/Cosplay 圈层文化,严禁通用商业摄影风' +
      '\n• 一到两张代表作做主视觉,其他样片错落聚拢,体现摄影师风格的多样性' +
      '\n• 服务信息(报价/档期/联系方式)作为设计元素融入版面,不要像后加上去的便签' +
      '\n• 整体氛围感、戏剧化,避免企业风的扁平排版,这是给二次元受众看的' +
      '\n• 参考: Cosmode 杂志广告页、BNF 工作室宣传图、Animate 活动海报、AAA 级 Cosplay 比赛宣传图' +
      '\n\n严禁: 企业图库风、纯白底、缩略图九宫格、千篇一律的"摄影师名片感"。' +
      '\n\n输出: 一张完工级商用宣传海报,可直接发布到 B 站/Lofter/微博/小红书。',

    sections: [
      {
        id: 'style',
        label: '整体风格',
        type: 'single-select',
        buttons: [
          { id: 'style_anime_keyvisual', label: '动漫 KV 风',
            prompt: '动漫主视觉(KV)风格。代表作大图主导,周围其他样片有意非对称聚拢,日式排版的粗体显示字。参考: 番剧 BD 封面、官方授权宣传图。' },
          { id: 'style_dark_premium', label: '暗调高级',
            prompt: '暗黑高级氛围。深炭灰/海军蓝背景,微金或粉色点缀,电影感。传达"高端不便宜"的质感,适合资深摄影师。' },
          { id: 'style_acg_pop', label: 'ACG 流行',
            prompt: '热血 ACG 文化氛围。亮粉+电光蓝+奶油色搭配,贴纸装饰、虚线、星芒点缀,活力青春感。参考: 二次元商家宣传图、秋叶原 Animate 海报。' },
          { id: 'style_japanese_studio', label: '日系工作室',
            prompt: '日系摄影工作室宣传风。淡纹理背景(和纸/胶片颗粒),克制的无衬线日文风排版,柔和粉彩高光。参考: 东京 Cosplay 工作室官网、Comiket 风格。' },
          { id: 'style_film_cinematic', label: '胶片电影感',
            prompt: '版面用胶片电影氛围:letterbox 上下黑边,复古片尾字幕风排版,底色和装饰元素呈胶片暖色调。参考图保持原色,不要给样片统一加调色滤镜。适合主打胶片 Cosplay 摄影的人。' },
          { id: 'style_gothic_lolita', label: '哥特暗黑',
            prompt: '哥特暗黑氛围。黑+深红+蕾丝纹理,华丽装饰边框。适合主打哥特/萝莉/暗黑奇幻角色的摄影师。' },
          { id: 'style_kawaii_pastel', label: '马卡龙萌系',
            prompt: '可爱马卡龙氛围。粉/淡紫/奶黄背景,蓬松云朵装饰,爱心点缀,圆角图框。适合主打可爱/偶像/魔法少女类 Cosplay 的摄影师。' },
          { id: 'style_guofeng', label: '国风古韵',
            prompt: '中国风传统氛围。水墨背景纹理,朱砂印章,毛笔题字立排。适合国风/仙侠/古风 Cosplay 摄影师。' }
        ]
      },
      {
        id: 'studio_name',
        label: '工作室/摄影师名',
        type: 'text-input',
        placeholder: '例如:夏三七影像 / 月影写真',
        promptTemplate: '工作室名"{TEXT}"应作为整张图最显眼的文字元素,作为品牌标识。位置: 顶部或居中,大号显示字,与排版融为一体。'
      },
      {
        id: 'tagline',
        label: '宣传标语',
        type: 'text-input',
        placeholder: '例如:把你最爱的角色带到现实 / 二次元造梦师',
        promptTemplate: '加一句宣传标语"{TEXT}"作为辅助文字元素,放在工作室名附近。斜体或瘦体,氛围感,像电影 tagline。'
      },
      {
        id: 'business',
        label: '业务类型',
        type: 'multi-select',
        buttons: [
          { id: 'biz_indoor',  label: '棚拍正片', prompt: '突出"棚拍/室内 Cosplay 正片摄影"业务。' },
          { id: 'biz_outdoor', label: '外景实拍', prompt: '突出"外景实景拍摄"业务。' },
          { id: 'biz_event',   label: '漫展跟拍', prompt: '突出"漫展/活动跟拍"业务。' },
          { id: 'biz_retouch', label: '精修后期', prompt: '突出"专业修图/后期精修"业务。' },
          { id: 'biz_video',   label: '视频拍摄', prompt: '突出"Cosplay 视频/PV/MV 制作"业务。' },
          { id: 'biz_mua',     label: '化妆造型', prompt: '突出"化妆造型/妆造服务"业务。' },
          { id: 'biz_concept', label: '概念出片', prompt: '突出"概念向/故事向特别企划"业务。' }
        ]
      },
      {
        id: 'business_block',
        label: '业务模块写法',
        type: 'single-select',
        buttons: [
          { id: 'biz_menu',  label: '菜单清单式', prompt: '把所选业务类型排成清爽的菜单列表(带分隔线)。位置: 角落面板或侧栏,表格式对齐,像服务菜单。' },
          { id: 'biz_tags',  label: '标签云',     prompt: '把所选业务类型做成装饰性标签/贴纸,有品味地散布画面各处。每个标签用圆角矩形或贴纸形式包起来。' },
          { id: 'biz_strip', label: '横幅条',     prompt: '把所选业务类型排成一条横向条带,横跨海报底部,以分隔符断开。' },
          { id: 'biz_icon',  label: '图标对应',   prompt: '把所选业务类型做成"图标+文字"对。每项配一个极简线性图标,排成一行或两行网格。' }
        ]
      },
      {
        id: 'price',
        label: '报价',
        type: 'text-input',
        placeholder: '例如:写真 ¥499 / 跟拍 ¥1999/天 / 大型企划 私聊',
        promptTemplate: '加一个报价区块,内容: "{TEXT}"。位置: 与品牌主标对角放,多行用表格式对齐,加微妙装饰边框。'
      },
      {
        id: 'character_types',
        label: '可拍角色类型',
        type: 'text-input',
        placeholder: '例如:JK制服 / 哥特暗黑 / 古风国风 / 异世界奇幻',
        promptTemplate: '加一行"可拍类型"描述: "{TEXT}",较小字号,放在业务菜单下方作为辅助信息。'
      },
      {
        id: 'schedule',
        label: '档期信息',
        type: 'text-input',
        placeholder: '例如:2026年4月-5月接单中 / 暑期档预约',
        promptTemplate: '加一个小档期/可约提示: "{TEXT}",做成像状态徽章("接单中"/"现在预约"),位置: 角落印章或横幅。'
      },
      {
        id: 'contact',
        label: '联系方式',
        type: 'text-input',
        placeholder: '例如:WX: photo_xxxx / 微博@xxxx / B站@xxxx',
        promptTemplate: '加联系方式信息"{TEXT}",沿底部边或在联系方式区块内。如出现可识别平台名(微信/微博/B站/小红书/Lofter),配对应平台图标。'
      },
      {
        id: 'logo',
        label: '插入工作室 LOGO',
        type: 'file-upload',
        promptHint: '参考图中包含一个工作室 LOGO。把它作为品牌标记放置 — 右上角或底部居中,尺寸适中(海报高度的 5-10%)。如有透明通道请保留。'
      },
      {
        id: 'avatar',
        label: '插入摄影师头像',
        type: 'file-upload',
        promptHint: '参考图中包含一张摄影师头像。把它做成小圆形或圆角方形头像,放在联系方式附近,尺寸像头像挂件(画面高度的 8-12%)。'
      },
      {
        id: 'qrcode',
        label: '插入二维码',
        type: 'file-upload',
        promptHint: '参考图中包含一张二维码。干净地放在角落,尺寸适合扫描(必须保持清晰可读,海报宽度的 10-12%)。旁边加一句小字标签如"扫码联系"。'
      }
    ]
  },

  // ============================================================
  //  正片排版(portfolio) — Cosplay 玩家发布作品的成品海报
  // ============================================================
  portfolio: {
    label: '正片排版',
    desc: 'Cosplay 正片成品视觉排版,故事向 / 海报向',

    systemPrompt:
      '【最高优先级红线 — 在所有其他规则之前必须遵守】' +
      '\n你是排版设计师,不是修图师。本任务只允许做版式设计、文字、装饰、背景、几何分布。' +
      '\n严禁: 对提供的参考图做任何调色、风格化、磨皮、换头、换衣、换姿势、加滤镜、改光线、改细节、改颜色、改纹理、转化风格、合成内容。' +
      '\n参考图必须保持像素级原样使用,只允许做整体的: 缩放、裁剪、几何遮罩(圆形/斜切等版式裁切)、不改变像素颜色的位置摆放。' +
      '\n如果整体设计需要某种"色彩氛围",氛围只通过【背景色/底色/字体色/装饰色/边框色】实现,不要把氛围色叠到图片上。' +
      '\n如果这条红线和后面的任何子风格描述冲突,以这条红线为准。' +
      '\n\n———————————————————————————————————\n\n' +
      '你是资深的 Cosplay 编辑设计师/海报艺术指导。' +
      '任务: 用提供的 Cosplay 照片做内容,设计一张高端 Cosplay 视觉海报(16:9)。' +
      '这不是作品集九宫格,这是有电影感的视觉宣言 — 像电影海报或杂志大片,讲述角色的故事。' +
      '\n\n核心原则:' +
      '\n• 主次分明: 一两张主视觉占主导,其他照片在周围聚拢、重叠或碎片化处理' +
      '\n• 几何分层: 照片可裁成几何形状(圆形/斜切/三角楔形/角度蒙版),有意使用重叠、透明、混合模式 — 这些处理只改变照片的"形状轮廓",不改变内部像素色彩' +
      '\n• 留白和不对称是有意为之的设计选择' +
      '\n• 文字是构图的一部分 — 粗大显示字,分层、有意被裁切、或一半藏在图后面' +
      '\n• 氛围感强 — 浓郁黑色、深阴影、戏剧化氛围用【背景/装饰/字体】实现;严禁纯平、严禁纯白底(除非是有意设计)' +
      '\n• 参考: AAA 游戏主视觉、电影海报(诺兰/A24/韦斯·安德森)、高定时尚大片' +
      '\n\n严禁: 廉价九宫格、宝丽来贴纸感、缩略图方阵、纯白边距、对参考图做任何修图/调色处理。' +
      '\n\n输出: 一张完工的电影感视觉海报,AAA 品质,可直接打印为电影海报级图像。',

    sections: [
      {
        id: 'genre',
        label: '叙事类型',
        type: 'single-select',
        buttons: [
          { id: 'genre_movie', label: '电影海报',
            prompt: '电影海报构图。一张主肖像居中或偏轴位置占主导,其他场景以角度排列在周围。海量标题文字与构图融为一体(部分藏在主体后或前)。重氛围调色。参考: 沙丘、银翼杀手 2049、艺伎回忆录的海报。' },
          { id: 'genre_keyvisual', label: '游戏 KV 主视觉',
            prompt: 'AAA 游戏主视觉风格。主角姿势居中或四分之三位,背景场景/道具在身后用动态几何面板排列。多角度灯光汇聚于主角身上。参考: 原神、崩坏星穹铁道、女神异闻录5 主视觉。' },
          { id: 'genre_editorial', label: '杂志大片',
            prompt: '高级时尚杂志大片排版。不对称地混合"全出血主图+小幅辅图"。粗大显示字戏剧化地横跨照片裁切。参考: Vogue Italia、i-D、Numéro 时尚杂志大片排版。' },
          { id: 'genre_story', label: '叙事分镜',
            prompt: '连续叙事故事板排版。照片像胶片或漫画分镜一样排列,但有意尺寸变化、戏剧化的转场。从左到右或从上到下读出一段故事弧。参考: 漫画书的全页式 splash page。' },
          { id: 'genre_collage', label: '碎片拼贴',
            prompt: '碎片化梦境拼贴。照片被撕扯、切片,以参差角度重叠。像记忆碎片重组。液体纹理/纸张撕扯边缘/故障碎片。参考: 前卫时尚 campaign、NIN 专辑封面、伊藤润二。' },
          { id: 'genre_doublepage', label: '杂志跨页',
            prompt: '杂志中心跨页排版。两页内容统一在 16:9 内。左半全出血主图延伸到右半;右半显示次要内容+大标题。中央有微妙书脊阴影暗示纸张折痕。参考: Cosmode/NeoGenesis Cosplay 杂志跨页。' },
          { id: 'genre_symmetric', label: '对称构图',
            prompt: '对称或近对称的庄严构图。主体居中,辅助元素左右镜像。建筑/宗教/纹章感。参考: 韦斯·安德森、巴洛克华丽电影海报。' },
          { id: 'genre_diagonal', label: '动态斜线',
            prompt: '斜线主导的动态构图。强烈的斜线划分画面,照片沿这些斜线被几何精度地裁切。运动和张力感。参考: 昆汀的海报艺术、俄国构成主义。' }
        ]
      },
      {
        id: 'mood',
        label: '版面色彩氛围',
        type: 'single-select',
        buttons: [
          { id: 'mood_dark_neon', label: '暗黑霓虹',
            prompt: '版面用赛博朋克暗黑霓虹氛围:背景深黑,装饰元素和字体高光用亮粉+青色+电光蓝。轻微辉光晕、雾气感。注意: 这些色彩用在背景/装饰/文字上,绝对不要叠加到参考图上。适合科幻/赛博朋克/都市角色。' },
          { id: 'mood_cinematic_teal', label: '电影青橙',
            prompt: '版面用电影感青橙调:背景偏青,装饰高光偏暖琥珀。注意: 这些色彩只用于版面背景/装饰/字体,参考图保持原样不要叠青橙调。适合动作/奇幻/戏剧叙事。' },
          { id: 'mood_dark_gold', label: '黑金奢华',
            prompt: '版面用纯黑底+金属金装饰。金箔字效。装饰边框用金色。参考图保持原色,不要镀金或加色调滤镜。适合反派/女王/大魔王。' },
          { id: 'mood_sakura_dusk', label: '樱色暮光',
            prompt: '版面用柔樱粉+灰紫+深紫做背景和装饰元素。浪漫梦幻氛围。注意: 氛围色用在版面而非参考图上,参考图保持原色。适合悲剧女主、亡灵故事、物哀题材。' },
          { id: 'mood_blood_dust', label: '血色尘烟',
            prompt: '版面用焦赭+灰烬+干血暗红做背景和装饰。烟雾、尘埃粒子作装饰元素。参考图保持原色,氛围只通过背景实现。适合战士、战斗后场景、悲剧角色。' },
          { id: 'mood_holy_white', label: '圣洁白光',
            prompt: '版面用高调白底+金色神光做背景和装饰。神性角度的镜头光晕作装饰。注意: 不是平白底,是有光线的设计;参考图保持原色,不要叠白光滤镜。适合天使/牧师/天堂主题。' },
          { id: 'mood_jade_ink', label: '青墨水韵',
            prompt: '版面用青绿+骨白+朱砂红做背景和装饰。水墨晕染背景纹理、毛笔笔触装饰。参考图保持原色,水墨纹理只作为版面背景。适合国风/仙侠/武侠角色。' },
          { id: 'mood_crimson_obsidian', label: '赤红黑曜',
            prompt: '版面用深血红+纯黑做背景。天鹅绒纹理装饰。参考图保持原色,氛围色用于背景和装饰元素。适合吸血鬼、恶魔、哥特角色。' }
        ]
      },
      {
        id: 'geometry',
        label: '几何处理',
        type: 'multi-select',
        buttons: [
          { id: 'geo_circle',        label: '圆形开窗',     prompt: '部分照片裁切成圆形勋章状,作为大构图中的开窗焦点。' },
          { id: 'geo_diagonal',      label: '斜切',         prompt: '用锐利斜切来分隔或叠加图像。严格的几何精度。' },
          { id: 'geo_overlap',       label: '重叠交错',     prompt: '照片重叠处带轻微投影或透明混合。分层深度感。' },
          { id: 'geo_torn',          label: '撕裂边缘',     prompt: '部分图像边缘做成纸张撕扯或粗糙碎片(不是干净的矩形)。增加原始/手工感。' },
          { id: 'geo_grid_offset',   label: '错位网格',     prompt: '底层有网格结构但部分面板有意错位/偏移。有节奏的破坏感。' },
          { id: 'geo_blur_layer',    label: '虚化背景层',   prompt: '允许把【其中一张参考图的临时副本】做模糊处理后铺成全画面背景纹理。注意: 只用于背景纹理,前景的所有参考图主体仍必须保持原图清晰像素;不是把所有图都模糊。' },
          { id: 'geo_double_expose', label: '双重曝光',     prompt: '允许在【背景区域或装饰元素中】用一份参考图的剪影叠加另一份的纹理(双曝艺术效果)。注意: 这种融合只用作版面装饰元素,前景主推图必须保持原图原色清晰像素,不要把主推图变成融合作品。' }
        ]
      },
      {
        id: 'typography',
        label: '文字风格',
        type: 'single-select',
        buttons: [
          { id: 'type_none',         label: '无文字',       prompt: '版面上不加任何文字。让照片承担全部视觉重量。纯图像。' },
          { id: 'type_huge_display', label: '巨型展示字',   prompt: '巨大粗体显示字是构图的一部分 — 标题横跨半个画面,部分藏在主体后或前,有意在边缘被裁切。无衬线粗体。' },
          { id: 'type_serif_movie',  label: '电影衬线字',   prompt: '电影感衬线标题(Trajan/Caslon 风)。居中或顶部位置。克制但奢华。像电影片名卡。' },
          { id: 'type_brush_chinese',label: '中式毛笔题字', prompt: '中式书法毛笔标题立排。靠右或左边缘。浓厚墨韵纹理,部分出血。下方有微妙红色印章点缀。' },
          { id: 'type_neon_glow',    label: '霓虹发光字',   prompt: '霓虹辉光风格化标题。亮粉或青色辉光晕。轻微色差分裂。科幻/赛博朋克感。' },
          { id: 'type_distorted',    label: '故障扭曲字',   prompt: '故障/扭曲风格化标题。Datamosh 字形、RGB 通道分离、断像素。反乌托邦感。' }
        ]
      },
      {
        id: 'character_name',
        label: '角色名/标题',
        type: 'text-input',
        placeholder: '例如:夜刀神十香 / 雷电将军 / 鬼灭之刃',
        promptTemplate: '主标题文字: "{TEXT}"。按所选文字风格渲染。把它作为主要视觉元素摆放。'
      },
      {
        id: 'subtitle',
        label: '副标题/系列',
        type: 'text-input',
        placeholder: '例如:約會大作戰 / Date A Live / EP.07',
        promptTemplate: '加一个较小的副标题"{TEXT}"。位置: 主标题下方或旁边,小一号字,作为辅助层级。'
      },
      {
        id: 'tagline',
        label: '标语/台词',
        type: 'text-input',
        placeholder: '例如:Where shadows meet stars / 命运降临之时',
        promptTemplate: '加一句标语/台词"{TEXT}",用斜体或瘦字。位置: 角落或边缘,氛围感放置,像电影 tagline。'
      },
      {
        id: 'studio_credit',
        label: '制作方署名',
        type: 'text-input',
        placeholder: '例如:夏三七工作室 出品 / © STUDIO XYZ',
        promptTemplate: '加一行小署名"{TEXT}"在底部边缘。低调,像电影 credit。'
      }
    ]
  }
};

// 默认让 _posterPrompts 指向 factory(深拷贝),保证 prompts.js 加载后 magnet 立刻能用
// host 读到 dataFolder/poster_prompts.json 后会用合并版本覆盖 _posterPrompts(systemPrompt 仍走 factory)
try {
  window._posterPrompts = JSON.parse(JSON.stringify(window._posterPromptsFactory));
} catch (_) {
  window._posterPrompts = window._posterPromptsFactory;
}

})();
