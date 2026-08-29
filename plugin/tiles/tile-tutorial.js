// ============================================================
//  tile-tutorial.js — 教程系统 (批1: 引擎 + 教程磁贴 + 新手主线)
//  2026-07-05
//
//  组成:
//    1. 引导引擎: 滚动→聚光灯→气泡, 支持 磁贴目标/CSS选择器目标/居中卡片,
//       假计算步骤, 步骤 onEnter 动作钩子
//    2. 章节注册表: 主线已实装; 1~12 章占位(状态"制作中"), 后续批次逐批填
//    3. 教程磁贴: 章节目录(完成标记) + 关键词搜索 + 重看主线 + 锚点自检
//    4. 新手主线自动弹: 等 firstrun 三件套(欢迎页/导览/卫星推荐)全部收场后接力,
//       只弹一次(tutorial.mainlineDone)
//
//  维护约定:
//    - 所有关卡的锚点(磁贴id/选择器)只写在 CHAPTERS 的 step.target 里, 别散落
//    - 改 UI 后在教程磁贴里点一次「🔍 锚点自检」, 失效锚点会全部列出来
// ============================================================
(function() {
'use strict';

var DONE_KEY = 'tutorial.mainlineDone';
var CHAPTER_DONE_PREFIX = 'tutorial.done.';   // + 章节id
var RESUME_KEY = 'tutorial.resume';           // 断点续传: 应用布局会整页 reload, 教程靠它接上
var DEMO_PROMPT = '把背景换成夕阳下的海边, 人物和衣服保持不变';

// ============================================================
//  章节注册表
//  step 字段: target: 'tileId' | {sel:'css选择器'} | null(居中)
//             title/text/btn, fake(假计算), onEnter(进入本步时执行的动作函数)
//  章节字段: id/icon/title/desc/steps; steps 为 null = 还没做(目录里显示"制作中")
// ============================================================
var CHAPTERS = [
  {
    id: 'mainline', icon: '🎓', title: '新手主线: 认识面板 + 出第一张图', desc: '存档你的界面 → 认全每个部件 → 走通出图闭环(教练模式)',
    steps: [
      // —— 第一幕: 界面存档 + 切换标准界面 ——
      {
        target: null,
        title: '🎓 欢迎来到修图轮椅',
        text: '这趟引导会带你认全面板、并完整走一遍出图流程。\n全程教练模式, 怎么点都不会花钱。\n\n教程按「Banana 标准界面」讲解, 所以第一件事:\n先把你现在的界面存档, 再切到标准界面。',
        btn: '开始'
      },
      {
        target: { sel: '#layoutSaveBtn', inner: true }, wait: 600, interactive: true,
        onEnter: function() { try { window._topbarToggleLayoutPanel && window._topbarToggleLayoutPanel(); } catch (e) {} },
        title: '第一步: 存档你的界面',
        text: '这是「布局快照」面板(顶栏右上角 ☰ 随时能打开)。\n点亮着的「+ 保存当前」→ 起个名字(比如: 我的界面) → 确定。\n刚装还没动过界面的话, 也可以不存直接下一步。',
        btn: '存好了 / 不用存'
      },
      {
        target: { sel: '#layoutFactoryArea .layout-row-apply', inner: true }, interactive: true, resumeNext: true,
        title: '第二步: 换上 Banana 标准界面',
        text: '在「⭐ 内置布局」里找到「Banana标准模式」,\n点它右边的 [应用] → 确认。\n应用后界面会刷新一下 — 别慌, 教程会自动接着讲。\n(后悔药: 这个面板里的「↶ 恢复我之前的布局」\n随时能一键回到应用前的样子)',
        btn: '应用好了'
      },
      // —— 第二幕: 顶栏全览(逐区带框) ——
      {
        target: 'topbar', wait: 400,
        onEnter: function() { try { if (window._layoutModule && window._layoutModule.isOpen()) window._topbarToggleLayoutPanel(); } catch (e) {} },
        title: '顶栏 — 你的仪表盘',
        text: '常驻最上方, 平时看一眼就知道: 登没登录、算力还剩多少。\n展开后里面分「👤 账户」和「⚡ 算力」两个标签页,\n我们两页都逛一遍。',
        btn: '展开看看 →'
      },
      {
        target: { sel: '[data-section="account"]', inner: true }, keepOpen: 'topbar', wait: 750,
        onEnter: function() {
          try { TileAPI.expandTile('topbar'); } catch (e) {}
          setTimeout(function() { _topbarTab('account'); }, 500);
        },
        title: '👤 账户页 ① 账号区',
        text: '邮箱注册 / 登录 / 记住我 / 找回密码都在这。\n登录后才能用「夏三七托管」(免配置出图)、\n云同步、在线客服和修脸服务。',
        btn: '下一步'
      },
      {
        target: { sel: '[data-section="forge"]', inner: true }, keepOpen: 'topbar',
        title: '👤 账户页 ② 修脸服务 (Forge)',
        text: 'AI 精修脸部的云服务:\n选服务器 → 连接 → 状态灯变绿就能用。\n(收纳态顶栏第三格的灯就是它的状态;\n这一节登录后才出现)',
        btn: '下一步'
      },
      {
        target: { sel: '[data-section="recharge"]', inner: true }, keepOpen: 'topbar',
        title: '👤 账户页 ③ 充值区',
        text: '买来的卡密贴进输入框 → 兑换,\n算力立刻到账, 顶栏余额跟着更新。\n(这一节登录后才出现)',
        btn: '下一步'
      },
      {
        target: { sel: '#topbarSupportLink', inner: true }, keepOpen: 'topbar',
        title: '👤 账户页 ④ 客服与公告',
        text: '出问题点「联系客服」直接在插件里发消息;\n公告区会推最新通知和活动。\n账户页看完了, 下一步切到「⚡ 算力」页。',
        btn: '去算力页 →'
      },
      {
        target: { sel: '[data-section="power"]', inner: true }, keepOpen: 'topbar', wait: 400,
        onEnter: function() { _topbarTab('compute'); },
        title: '⚡ 算力页 ① 算力与模式切换',
        text: '(注意: 顶部标签已经切到「算力」页)\n两种用算力的方式在这切换:\n· 夏三七托管(推荐新手): 充值后零配置直接出图\n· 自带 Key: 有自己的 GRS Key 就填进来用自己额度',
        btn: '下一步'
      },
      {
        target: { sel: '[data-section="slots"]', inner: true }, keepOpen: 'topbar',
        title: '⚡ 算力页 ② 算力槽位自定义',
        text: '给三格算力: 改名字(比如叫"我的中转")、\n挑露出哪些模型、调顺序。\n改完全插件所有磁贴同步生效。',
        btn: '下一步'
      },
      {
        target: null, bubblePos: 'bottom',
        title: '顶栏小结',
        text: '两个标签页记住分工:\n👤 账户页 = 登录 / 充值 / 修脸 / 客服\n⚡ 算力页 = 用哪家算力 / 模式切换 / 槽位自定义\n收纳状态下点顶栏任意格子, 也会直接跳进对应配置。',
        btn: '收起, 继续'
      },
      // —— 第三幕: 磁贴 / 编辑模式 / Dock / 抽屉 / 缩放 (手把手逐操作) ——
      {
        target: null, wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '磁贴 — 面板的基本单位',
        text: '下面这一格格方块都是「磁贴」, 每块 = 一个功能。\n它有两种形态:\n· 1×1 小方块 = 图标, 像手机 App 图标\n· 拉大的 = 常驻小面板, 功能直接摊开在桌面上\n接下来一个动作一个动作教你摆弄它。',
        btn: '下一步'
      },
      {
        target: 'info', interactive: true,
        title: '动作①: 点一下 = 打开',
        text: '先试最简单的:\n用鼠标【点一下】圈住的这块「信息」磁贴 →\n它会展开成一个面板。\n看完【再点面板右上角的 × 】(或按 ESC) 把它收起来。\n做完这两下, 回来点下面的按钮。',
        btn: '我开了也关了'
      },
      {
        target: 'info', interactive: true,
        title: '动作②: 长按 0.4 秒 = 进入编辑模式',
        text: '现在【按住】这块磁贴别松手, 数"零点四秒"再松 →\n所有磁贴出现选中边框 = 你进入了编辑模式。\n(进入后先别点别的, 直接回来点下面按钮 —\n我会检查你是不是真的进来了)',
        btn: '我进来了',
        verify: function(done) {
          if (_inEditMode()) { done(true); return; }
          TileAPI.toast('还没进入编辑模式哦 — 在磁贴上按住 0.4 秒再松手, 出现边框才算', 'warn');
          done(false);
        }
      },
      {
        target: 'info', interactive: true,
        title: '动作③: 编辑模式里 — 拖动换位置',
        text: '保持编辑模式:\n【按住这块磁贴 → 拖到旁边任意空格 → 松手】\n它就搬家了。再拖回来也行, 随便玩。\n(拖到别的磁贴上会跟它换位; 拖到「抽屉」上会被收纳 —\n先别拖抽屉, 后面会专门讲)',
        btn: '拖过了'
      },
      {
        target: 'info', interactive: true,
        title: '动作④: 编辑模式里 — 拖角改大小',
        text: '还是这块磁贴:\n【捏住它的右下角 → 往外拖】= 变大(1×1 → 2×2)\n变大后它就地变成常驻小面板, 内容直接显示;\n【往回拖到 1×1】= 变回图标。\n屏幕大就多放几块大的, 屏幕小就全用图标 — 你说了算。',
        btn: '试过了'
      },
      {
        target: { sel: '#editToolbar', inner: false }, interactive: true,
        onEnter: function() {
          // 阀门: 不在编辑模式就先提醒 — 工具栏只有编辑模式才出现;
          // 用户长按进入的瞬间, 寻的跟踪会自动把聚光灯圈上去
          if (!_inEditMode()) {
            try { TileAPI.toast('先在任意磁贴上长按 0.4 秒进入编辑模式, 底部工具栏就会出现', 'info'); } catch (e) {}
          }
        },
        title: '动作⑤: 认识底部编辑工具栏',
        text: '(不在编辑模式? 长按磁贴 0.4 秒, 工具栏一出现\n聚光灯会自动圈上去)\n编辑模式下屏幕底部这条工具栏:\n【📐 自动排序】磁贴挤乱了一键排整齐\n【📁 新建文件夹】建分组, 磁贴拖进组头就归组\n【🗄️ 全部收纳】所有磁贴一键扫进抽屉(大扫除用)\n【🎨 清除所有颜色】把改过色的磁贴全部还原',
        btn: '认识了',
        verify: function(done) {
          if (_inEditMode()) { done(true); return; }
          TileAPI.toast('长按磁贴 0.4 秒进入编辑模式, 亲眼看一眼这条工具栏再继续', 'warn');
          done(false);
        }
      },
      {
        target: null, bubblePos: 'bottom', interactive: true,
        title: '动作⑥: 选中单个磁贴的专属设置',
        text: '编辑模式下【单击选中】任意磁贴(别拖, 就点一下),\n底部工具栏会多出两个按钮:\n【📌 点击方式】切换这块磁贴的打开方式:\n· 就地展开 = 在原位向下铺开(默认, 小改就收很方便)\n· 全屏展开 = 铺满整个面板(适合沉浸操作)\n【🎨 颜色】给这块磁贴换个底色, 重要磁贴标个色好找。\n试一试, 试完点空白处退出编辑模式。',
        btn: '玩好了, 已退出'
      },
      {
        target: { sel: '#dockHost', inner: false },
        title: 'Dock 快捷条 — 是什么',
        text: '屏幕底部这条就是 Dock:\n把最常用的按钮钉在这, 不管你磁贴翻到哪一页,\n它永远在最底下待命。\n下一步逐个认识它出厂自带的 8 个按钮。',
        btn: '下一步'
      },
      {
        target: { sel: '#dockHost', inner: false },
        title: 'Dock 默认按钮 (前4个)',
        text: '从左往右:\n【▶️ 开始生成】= 跟生成磁贴同一个"开跑"\n【🔁 一键重跑】= 把上一单原样再来一次\n(抽卡不满意, 一键再抽, 不用重新设置任何东西)\n【⏹️ 停止全部】= 紧急刹车, 所有任务立刻叫停\n【💾 保存预设】= 当前提示词一键存成配方',
        btn: '下一步'
      },
      {
        target: { sel: '#dockHost', inner: false },
        title: 'Dock 默认按钮 (后4个)',
        text: '【🛡️ 抗截断】= 点一下切换 关→抗截断→抗截断+ 循环\n(亮着 = 开着, 人物贴边被裁时用)\n【↩️ 自动返回】= 开关"图好了自动贴回 PS"\n【📝 展开提示词】【⚙️ 展开设置】= 两个传送门,\n一键跳到对应磁贴, 不用滚动去找。',
        btn: '下一步'
      },
      {
        target: { sel: '#dockHost', inner: false }, interactive: true,
        title: '✋ 动作⑦: 亲手改一次 Dock',
        text: '一步步来:\n① 在任意磁贴上长按 0.4 秒进入编辑模式\n② 看 Dock: 每个按钮右上角出现小 ×, 条末尾出现 +\n③ 【点某个按钮的 ×】= 删掉它(别怕, 能加回来)\n④ 【点末尾的 +】= 打开按钮库, 挑一个点它 = 加上\n⑤ 点面板空白处退出编辑\n全套做一遍, 做完回来。',
        btn: '做完了'
      },
      {
        target: 'dock',
        title: 'Dock 设置磁贴 — 管这条的地方',
        text: '刚才改的是"放什么按钮",\n这块磁贴管的是 Dock 条本身的样子。\n打开逐项看。',
        btn: '打开看看 →'
      },
      {
        target: { sel: '#togDockEnable', inner: true }, keepOpen: 'dock', wait: 750,
        onEnter: function() { try { TileAPI.expandTile('dock'); } catch (e) {} },
        title: '「启用 Dock」总开关',
        text: '【干嘛用】整条 Dock 的生死开关。\n屏幕实在小、或者你就爱纯净桌面 → 关掉它;\n关了随时回这里再打开, 按钮配置不会丢。',
        btn: '下一步'
      },
      {
        target: { sel: '#inpDockScale', inner: true }, keepOpen: 'dock',
        title: 'Dock 外观四件套',
        text: '这几条滑杆从上到下:\n【位置】Dock 贴屏幕哪边\n【Dock 大小】整条的缩放\n【图标大小】按钮里图标的大小(条不变按钮变)\n【不透明度/模糊】底色的通透感\n【设计意图】特意跟主界面缩放分开 —\n很多人主面板要大字, 但 Dock 想要小巧不挡画。',
        btn: '看完了, 收起'
      },
      {
        target: 'drawer', wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '抽屉 — 磁贴收纳箱',
        text: '不常用的磁贴丢进来, 桌面清爽。\n【怎么收】编辑模式下把磁贴拖到抽屉上 → 松手\n【怎么取】点开抽屉 → 点里面的磁贴 → 它回到桌面\n【设计边界】抽屉自己和设置磁贴不能被收纳 —\n防止把"取出来的入口"也收进去出不来。',
        btn: '下一步'
      },
      {
        target: { sel: '#setScale', inner: true }, keepOpen: 'settings', wait: 750, bubblePos: 'bottom',
        onEnter: function() { try { TileAPI.expandTile('settings'); } catch (e) {} },
        title: '整个界面还能缩放',
        text: '屏幕小字太挤、或者字太小看不清?\n设置磁贴里的「缩放」滑块 50%~300% 随便调:\n【往左拖】整个面板变小, 一屏塞下更多磁贴\n【往右拖】全面板变大, 护眼\n松手就生效, 不满意再拖回来。',
        btn: '知道了, 收起'
      },
      // —— 第四幕: 完整出图流程 ——
      {
        target: 'prompt', wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '出图第 1 步: 提示词',
        text: '界面认完了, 开始出图!\n你想让 AI 做什么, 用大白话写在这。\n点下一步, 我帮你填一句演示提示词。',
        btn: '帮我填上 →'
      },
      {
        target: 'prompt',
        title: '提示词已就位',
        text: '我填的是:「' + DEMO_PROMPT + '」\n正式使用时, 也可以从预设磁贴里挑现成配方, 不用自己想词。',
        btn: '下一步',
        onEnter: function() {
          try { TileAPI.emit('prompt:changed', { text: DEMO_PROMPT, source: 'tutorial' }); } catch (e) {}
        }
      },
      {
        target: null, wait: 750, interactive: true, bubblePos: 'bottom',
        onEnter: function() { try { TileAPI.expandTile('params'); } catch (e) {} },
        title: '出图第 2 步: 亲手调参数',
        text: '这是生成参数面板, 现在真的动手调调看:\n· 点最上排的算力渠道按钮, 切一切再切回来\n  (三格随时切, 出图用的就是当前亮着的那格)\n· 把「尺寸」换成 1K 或 2K\n· 把「张数」加一加减一减\n随便改, 教练模式不花钱, 调完点下面按钮。',
        btn: '调好了, 收起'
      },
      {
        target: null, wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '出图第 3 步: 去 PS 里框选区',
        text: '切到 Photoshop, 用矩形选框(快捷键 M)或套索,\n在画面上随便框住一块区域 —\n这就是"要 AI 修改的范围"。\n没开文档? 先随便打开/新建一张图。\n框好了回来点下面的按钮, 我会帮你检查。',
        btn: '我框好了, 检查一下',
        verify: function(done) {
          if (!(window.AspectWarn && AspectWarn.probeSelection)) { done(true); return; }
          AspectWarn.probeSelection().then(function(p) {
            if (p && p.hasSelection) {
              TileAPI.toast('检测到选区 ' + (p.selWidth || '?') + '×' + (p.selHeight || '?') + ', 完美!', 'success');
              done(true);
              return;
            }
            TileAPI.toast(p && p.hasDoc ? '还没检测到选区 — 切到 PS 框一块区域再回来' : '先在 PS 里打开或新建一张图, 再框选区', 'warn');
            done(false);
          }).catch(function() { done(true); });
        }
      },
      {
        target: 'run',
        title: '出图第 4 步: 点生成',
        text: '选区有了、提示词有了、参数调好了 —\n这是最主要的生成按钮: 生成磁贴。\n不过生成入口不止这一个, 再看两个顺手的。',
        btn: '下一步'
      },
      {
        target: { sel: '#dockHost .dock-btn[data-key="common:gen"]', inner: false },
        title: '生成入口 2: Dock 上的 ▶',
        text: 'Dock 快捷条上的这个按钮 = 同一个生成。\n磁贴翻页翻远了, 按这里最快。',
        btn: '下一步'
      },
      {
        target: { sel: '.prompt-preset-run', inner: false },
        title: '生成入口 3: 提示词面板顶部的 ▶',
        text: '载入预设调参数时, 面板顶栏也有个 ▶ —\n调完滑块不用挪地方, 就地开跑。\n(现在没载预设可能看不到它, 知道有这回事就行)\n三个入口按的是同一个"开始", 哪个顺手用哪个。',
        btn: '▶ 开始演示生成'
      },
      {
        target: null, fake: true, bubblePos: 'bottom',
        onEnter: function() {
          _fakeTaskStart();
          try { TileAPI.expandTile('center'); } catch (e) {}
        },
        title: '', text: '', btn: null
      },
      {
        target: null, bubblePos: 'bottom',
        title: '这就是任务卡',
        text: '上面这张卡就是一次生成任务:\n引擎徽章 / 用的模型 / 提示词摘要 / 倒计时都在卡上。\n真实出图时可以随时点卡上的按钮中断任务。\n(这张是教学演示卡, 不在计费)',
        btn: '让它完成 →'
      },
      {
        target: null, bubblePos: 'bottom', wait: 900,
        onEnter: function() {
          _fakeTaskFinish();
          try { TileAPI.collapseTile(); } catch (e) {}
        },
        title: '完成的任务去哪了?',
        text: '任务卡消失 = 这单跑完了。\n所有生成结果都自动归档进「🗂 生成记录」磁贴:\n· 缩略图墙按任务分组, 点开能看大图\n· 每组卡片上有 📋词 按钮 → 一键把当时的提示词装回\n· ▣区 按钮 → 恢复当时的 PS 选区\n(真实出图才会进记录, 这单演示不会出现在里面)',
        btn: '下一步'
      },
      {
        target: 'records', wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '认识「生成记录」',
        text: '它收的是【每一次生成任务的归档】— 图和提示词都在。\n尤其是点了"提前结束"的任务 — 其实在后台继续跑,\n跑出来的图静默存在这里, 花了钱的图绝不白丢。\n成功/失败/中断的任务都有(详解见「预设库」一章)。',
        btn: '下一步'
      },
      {
        target: null,
        title: '🎉 出师了!',
        text: '坦白说: 刚才是教学演示, 没有真的消耗算力。\n真实出图时, 结果会以图层形式自动贴回你的 PS 文档。\n\n你已经会了: 存布局 → 写提示词 → 调参数 → 框选区 → 生成。\n想深入学某个功能? 打开「🎓 教程」磁贴, 每个功能都有章节。',
        btn: '完成'
      }
    ]
  },
  { id: 'ch2',  icon: '🖼', title: '出图三件套 (控件级详解)', desc: '提示词 / 生成参数 / 生成按钮与任务卡, 每个按钮讲到',
    steps: [
      { target: null, title: '🖼 出图铁三角',
        text: '出一张图只需要三步:\n① 提示词(想改什么) ② 参数(用什么算) ③ 生成(动手)\n这一章把三个磁贴里的每个按钮、每个框都讲到。\n内容较多, 气泡文字可以上下滚动。', btn: '开始' },

      // ===== 提示词磁贴 =====
      { target: 'prompt', title: '① 提示词磁贴',
        text: '整个插件的"嘴巴" — 你对 AI 说的话都从这里出去。\n我们打开它, 逐个部件看。', btn: '打开看看 →' },
      { target: { sel: '#promptTextarea', inner: true }, wait: 750,
        onEnter: function() { try { TileAPI.expandTile('prompt'); } catch (e) {} },
        title: '文本输入区',
        text: '【干嘛用】直接打字描述你要的修改, 中文英文都行。\n【设计意图】故意做成"一整块大输入区"而不是一堆选项 —\n因为 AI 修图的本质就是一句话说清需求, 别的都是辅助。\n【小技巧】\n· 写中文就够, 模型看得懂; 想转英文用翻译按钮\n· 描述"要什么"比"不要什么"更有效\n· 越具体越好:「把天空换成晚霞」优于「弄好看点」', btn: '下一步' },
      { target: { sel: '#promptSavePresetBtn', inner: true },
        title: '💾 存预设按钮',
        text: '【干嘛用】把当前这段提示词一键保存为你自己的预设。\n【设计意图】好词是试出来的 — 试到满意的瞬间就该存,\n所以按钮放在输入区旁边, 顺手一点, 不用切到预设磁贴。\n【去哪了】存完在预设磁贴的"我的"分类里能找到。', btn: '下一步' },
      { target: null, bubblePos: 'bottom', interactive: true,
        onEnter: function() {
          try {
            if (_savedPromptText === null) _savedPromptText = TileAPI.state.get('prompt.text') || '';
            TileAPI.emit('prompt:changed', {
              text: '【填空:主题=夕阳下的海边】\n@光影强度"光影强度": 0.6\n@胶片颗粒"胶片颗粒": 0.3',
              source: 'preset'
            });
          } catch (e) {}
        },
        title: '✋ 练手: 参数面板(滑块+填空)',
        text: '我装了一份演示参数, 输入区变成了参数面板(没冻结, 动手):\n【滑块】拖动直接改强度, 数值实时写回提示词原文 —\n设计成滑块是因为 AI 对数字不敏感, 拖到"感觉对"比填数靠谱\n【填空框】要你填的关键词, 右下角可以拖高\n【↺ 还原预设默认值】调乱了的后悔药\n【记忆】你调的值按预设自动记住, 下次载入直接复原\n练完点下面按钮。', btn: '练完了' },
      { target: { sel: '[data-preset-action="toggle-view"]', inner: true }, keepOpen: 'prompt',
        title: '⇄ 视图切换按钮',
        text: '【干嘛用】在"参数面板"和"提示词原文"之间切换。\n【设计意图】滑块面板对新手友好, 但老手偶尔要看\n滑块背后到底改了原文的哪个数字 — 这个按钮就是给\n"想掀开引擎盖看看"的人留的。切回参数视图无损。', btn: '下一步' },
      { target: { sel: '.prompt-preset-run', inner: true }, keepOpen: 'prompt',
        title: '▶ 就地生成按钮',
        text: '【干嘛用】跟生成磁贴完全同一个"开始", 放在这里是为了:\n调完滑块 → 手不用离开这个面板 → 直接开跑。\n【设计意图】高频操作路径越短越好 —\n"调参→生成→看图→再调"这个循环里省一次翻面板。', btn: '下一步' },
      { target: { sel: '[data-preset-action="clear-params"], [data-preset-action="clear-text"], [data-preset-action="unbind"]', inner: true }, keepOpen: 'prompt',
        title: '× 清空/解绑按钮',
        text: '【干嘛用】看当前状态有三种语义:\n· 纯文本时 = 清空提示词\n· 参数模式 = 清掉参数回到输入框\n· 绑着预设 = 解除预设绑定并清空\n【设计意图】一个位置一个 ×, 永远是"我想重新开始",\n不用记三个按钮在哪。', btn: '下一步' },
      { target: null, bubblePos: 'bottom',
        onEnter: function() {
          try {
            if (_savedPromptText !== null) {
              TileAPI.emit('prompt:changed', { text: _savedPromptText, source: 'tutorial' });
              _savedPromptText = null;
            }
          } catch (e) {}
        },
        title: '提示词部分小结',
        text: '(你原来的提示词已经还原)\n输入区写话 → 存预设留配方 → 载预设变滑块 →\n⇄ 看原文 → ▶ 就地开跑 → × 重新开始。\n一块磁贴管完"说什么"的全部环节。', btn: '继续, 收起' },

      // ===== 生成参数磁贴 =====
      { target: 'params', wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '② 生成参数磁贴',
        text: '"说什么"解决了, 这块管"怎么算"。\n打开, 每个控件过一遍。', btn: '打开看看 →' },
      { target: null, bubblePos: 'bottom', wait: 750,
        onEnter: function() { try { TileAPI.expandTile('params'); } catch (e) {} },
        title: '算力渠道按钮(最上排)',
        text: '【干嘛用】选这次出图用哪家算力, 亮着的 = 当前生效。\n【设计意图】为什么给你三格而不是一格?\nAI 绘图服务都有抖的时候 — 一家排队/维护, 点一下切\n另一家接着干活, 不让你干等。备胎常备是刻意的。\n【提醒】三格的名字/顺序/露出哪些模型, 顶栏里可自定义;\n没配置的渠道会引导你去配置。', btn: '下一步' },
      { target: { sel: '#paramModel', inner: true },
        title: '模型下拉',
        text: '【干嘛用】同一家算力下选具体模型。\n【怎么选】\n· 默认模型 = 性价比平衡, 新手就用它\n· Pro 类 = 更贵更强, 商稿/难活用\n· 老版本模型留着是给"就爱那个味"的老用户\n【设计意图】下拉里显示的是"人话名"(可在顶栏改名/精简),\n计费和请求用的是真实模型, 显示层怎么改都不影响出图。', btn: '下一步' },
      { target: { sel: '#paramSize', inner: true },
        title: '尺寸下拉',
        text: '【干嘛用】出图分辨率档位。\n【怎么选】1K 快而便宜(试构图用) / 2K 日常主力 /\n4K 精修出片(慢且贵, 部分模型不支持会提示)。\n【设计意图】档位化而不是自由填数 —\n因为上游按档计价, 档位让你出图前就知道这张花多少。', btn: '下一步' },
      { target: { sel: '#paramAspect', inner: true },
        title: '宽高比下拉',
        text: '【干嘛用】告诉 AI 出什么比例的图。\n【跟选区的关系】Auto = 跟着你的选区比例走(最常用);\n指定比例时, 若选区比例差太多会弹预警防翻车。\n【联动彩蛋】设置里开"同步 PS 选框比例"后,\n这里选 16:9, PS 的选框工具自动锁 16:9。', btn: '下一步' },
      { target: { sel: '#paramBatch', inner: true },
        title: '批次(张数)',
        text: '【干嘛用】一次生成几张, 也就是"抽几张卡"。\n【怎么用】AI 出图有随机性 — 要求高的活一次抽 3~4 张\n挑最好的, 比一张张试省时间(注意按张计费)。\n【设计意图】上限收着不放开, 防手滑一次抽几十张爆预算。', btn: '下一步' },
      { target: { sel: '#paramTimeout', inner: true },
        title: '超时(秒)',
        text: '【干嘛用】一张图最多等多久, 超了自动判失败。\n【为什么默认 500 秒】高峰期排队 + 绘制常要三五分钟,\n设太短会"人家还在画你先挂了电话" — 白等还可能白花钱。\n【建议】别低于 300; 挂机跑批处理可以更长。', btn: '下一步' },
      { target: null, bubblePos: 'bottom',
        title: '抗截断(三档)',
        text: '【干嘛用】治"AI 拒画/裁人"的老毛病。\n【真实原理】发送前给图做 R17 处理(色相偏移 180°,\n加档再垂直翻转), AI 算完贴回时自动反向还原 —\n骗过挑剔的模型, 你的图色彩不受任何影响。\n【三档逻辑】\n· 关 = 原样发\n· 抗截断 = 色相偏移\n· 抗截断+ = 色相偏移 + 垂直翻转(更狠)\n【什么时候开】画面老被拒绝/被裁时逐档往上试。', btn: '下一步' },
      { target: { sel: '#paramsMoreToggle', inner: true },
        title: '「更多」折叠区 + 跳设置',
        text: '【干嘛用】低频参数收在"更多"里, 面板保持清爽;\n"打开设置"按钮直达设置磁贴的输出选项。\n【设计意图】常用的 6 件套(模型/尺寸/比例/批次/超时/抗截断)\n永远一屏可见, 其他的藏而不删 — 要用能找到, 不用不碍眼。', btn: '下一步' },

      // ===== 生成按钮 + 任务 =====
      { target: 'run', wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '③ 生成磁贴 — 三个按钮',
        text: '【▶ 开始】主按钮: 读取选区 → 连提示词参数打包发出去。\n没框选区会按你的设置提醒或自动全图, 不会瞎跑。\n【📎 参考图】快捷入口: 把当前 PS 选区抓成参考图,\n等于"照着这个改", 跟参考图磁贴相通。\n【⏹/批次】排队与停止相关的快捷键位。\n【设计意图】这块磁贴常驻 1×1 也能按 —\n所以最重要的三件事(开跑/喂参考/停下)都压缩在正面。', btn: '下一步' },
      { target: 'center', title: '生成中心 — 活气泡解剖',
        text: '点生成后每张图一张卡片, 卡上从左到右:\n【缩略图】发出去的选区截图, 点它跳回原文档原选区\n【标题行】用的预设名/提示词摘要 + 引擎徽章(哪家算力)\n【进度条+百分比】排队/绘制进度\n【倒计时】离超时还有多久 — 心里有数, 不用干瞪眼\n【按钮】中断这一单 / 全部停止\n【设计意图】每单可单独中断: 抽 4 张时第 1 张已经满意,\n剩下 3 张随时叫停, 省下的就是钱。', btn: '下一步' },
      { target: null, title: '✅ 本章完成',
        text: '铁三角每个螺丝都拧过了:\n提示词(说什么) → 参数(怎么算) → 生成(跑起来) → 任务卡(盯进度)。\n忘了哪个按钮干嘛的, 随时回来重看这章。', btn: '完成' }
    ] },
  { id: 'ch3',  icon: '💾', title: '预设库 (控件级详解)', desc: '预设 / 收藏 / 云同步 / 回收站 / 布局快照',
    steps: [
      { target: null, title: '💾 预设 = 现成配方',
        text: '不会写提示词没关系 — 预设就是打包好的配方:\n提示词、参数、强度全都调好了, 点一下就能用。\n这一章把预设生态的每个按钮讲到。', btn: '开始' },
      { target: 'presets', title: '预设磁贴',
        text: '所有配方的家。打开逐个部件看。', btn: '打开看看 →' },
      { target: { sel: '#presetCategoryBar, .preset-cat-grid', inner: true }, keepOpen: 'presets', wait: 750,
        onEnter: function() { try { TileAPI.expandTile('presets'); } catch (e) {} },
        title: '分类区',
        text: '【干嘛用】预设按用途分类(人像/光影/场景…), 点进分类看卡片。\n【设计意图】配方一多就得有货架 — 按"你想干什么活"分堆,\n而不是按技术原理分, 找起来跟逛超市一样。\n【出厂 vs 我的】官方自带的配方和你自己存的分开放,\n更新插件时官方配方会刷新, 你的永远不动。', btn: '下一步' },
      { target: { sel: '#presetSearchToggle', inner: true }, keepOpen: 'presets',
        title: '🔍 搜索按钮',
        text: '【干嘛用】点开搜索框, 中文和拼音首字母都能搜\n(搜 "gm" 能找到 "光膜")。\n【设计意图】首字母搜索是给手熟的人提速的 —\n知道配方名的前两个字母就能三键直达, 不用翻分类。', btn: '下一步' },
      { target: { sel: '#presetImportBtn', inner: true }, keepOpen: 'presets',
        title: '📥 导入按钮',
        text: '【干嘛用】把别人分享给你的预设文件(.json)装进来。\n【设计意图】预设是能传播的 — 同行发你一个配方文件,\n导入就能用。跟导出按钮配对, 构成"预设的社交"。\n【提醒】导入的预设进"我的"分类, 不会覆盖官方的。', btn: '下一步' },
      { target: { sel: '#presetExportBtn', inner: true }, keepOpen: 'presets',
        title: '📤 导出按钮',
        text: '【干嘛用】把你的预设打包成文件, 发给别人/自己备份。\n【设计意图】你调出来的好配方是资产 —\n导出的文件里是"作者默认值"(不含你的临时滑块调整),\n别人拿到的永远是干净版。', btn: '下一步' },
      { target: { sel: '#presetOpenFolderBtn', inner: true }, keepOpen: 'presets',
        title: '📁 打开文件夹 / 🔄 刷新',
        text: '【干嘛用】直接打开预设存放的本地文件夹;\n手动往里放了文件后点刷新, 列表立刻更新。\n【设计意图】不把文件藏起来 — 高级用户想批量管理、\n手动备份, 直接操作文件夹最快, 插件不当中间商。', btn: '下一步' },
      { target: null, bubblePos: 'bottom',
        title: '预设卡片本体',
        text: '每张卡片上:\n【点卡片】= 载入配方 → 提示词磁贴自动变滑块面板\n【⭐ 收藏】= 钉到收藏分类, 常用配方置顶找\n【长按/右键】= 编辑、删除等管理操作\n【F 角标】= Forge 专用预设(会连 Forge 参数一起装)\n【设计意图】"点了就能用"是底线 — 所有管理操作都藏在\n二级手势里, 首层交互只留最高频的"用"。', btn: '看完了, 收起' },
      { target: 'sync', wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '云同步磁贴',
        text: '【干嘛用】把"我的"预设同步到云端账号。\n【为什么要它】重装系统/换电脑, 登录一拉全回来;\n也是防手滑删除的异地备份。\n【设计边界】只同步你自己的预设 — 官方配方跟着插件走,\n不占你的云空间。', btn: '下一步' },
      { target: 'records', title: '生成记录磁贴 (原回收站+历史)',
        text: '它收的是【所有生成任务的归档】— 图和提示词都在一起。\n【设计初心】你点"提前结束"后, 任务其实在后台继续跑 —\n跑出来的图静默归档在这, 花了算力的图一张不丢。\n打开看内部。', btn: '打开看看 →' },
      { target: { sel: '#rbFilter', inner: true }, keepOpen: 'records', wait: 750,
        onEnter: function() { try { TileAPI.expandTile('records'); } catch (e) {} },
        title: '生成记录: 筛选下拉',
        text: '【干嘛用】按任务结局过滤:\n⌛生成中 / ✓成功 / ⏱后台完成 / ✗失败 / ⊘已中断\n【重点看「⏱后台完成」】这些就是你提前结束后\n被抢救回来的图 — 白捡的, 记得翻。', btn: '下一步' },
      { target: { sel: '#rbSearch', inner: true }, keepOpen: 'records',
        title: '生成记录: 搜索框 + 清空',
        text: '【搜索框】按提示词搜历史任务, 找"上周那张海边"用它\n【清空按钮】归档不限量、全靠手动清 —\n占地方了来清一次(只清失败/中断的, 有确认不会手滑)。', btn: '下一步' },
      { target: null, bubblePos: 'bottom', keepOpen: 'records',
        title: '生成记录: 组卡怎么用',
        text: '每组任务一张卡, 卡上两个快捷按钮:\n【📋词】把当时的提示词一键装回(Forge 单连参数一起装)\n【▣区】恢复当时的 PS 选区\n点开组能看每张图, 再点图打开预览:\n【📎 智能贴回 PS】回到生成当时的文档和选区位置\n【📄 复制提示词】把那单用的词抄走再利用\n【🗑 删除】彻底删这一条\n【设计意图】图和词一个地方找 — 抽到 80 分的卡,\n装回词微调再抽, 比从头写快十倍。', btn: '看完了, 收起' },
      { target: 'layout', wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '布局快照磁贴',
        text: '【干嘛用】把整个面板的磁贴摆位/颜色/分组存成快照。\n【跟预设的关系】预设存"配方", 布局存"工作台" —\n比如一套修人像的台子、一套出海报的台子, 一键切换。\n【入口】这块磁贴和顶栏右上角 ☰ 按钮是同一个功能。\n【面板里的按钮】+ 保存当前 / 🔄 刷新列表 / 📁 打开布局文件夹\n【↶ 恢复我之前的布局】救命按钮! 每次应用布局前\n都会自动快照, 应用错了点它一键回到应用前。\n【内置布局】Banana/ComfyUI 等标准模式随时可恢复。', btn: '下一步' },
      { target: null, title: '✅ 本章完成',
        text: '新手最推荐的路线: 预设起手 → 微调滑块 → 生成。\n好配方记得 ⭐收藏 + 导出备份 + 开云同步,\n三层保险, 心血不丢。', btn: '完成' }
    ] },
  { id: 'ch4',  icon: '📎', title: '参考图与素材 (控件级详解)', desc: '参考图 / 历史 / 批处理',
    steps: [
      { target: null, title: '📎 给 AI 递参考',
        text: '光靠文字说不清的东西(特定的脸/服装/色调),\n直接甩图给 AI 看 — 这就是参考图。\n这一章还讲历史记录和批处理的每个控件。', btn: '开始' },
      { target: 'refimages', title: '参考图磁贴',
        text: '最多挂 4 张, 生成时连同选区一起发给 AI。\n打开看里面的部件。', btn: '打开看看 →' },
      { target: { sel: '.refimg-add-cell', inner: true }, keepOpen: 'refimages', wait: 750,
        onEnter: function() { try { TileAPI.expandTile('refimages'); } catch (e) {} },
        title: '＋ 添加格子',
        text: '【干嘛用】点它添加参考图, 两个来源:\n· 从 PS 选区抓取(推荐): 框住画面某块直接抓进来\n· 从文件选择\n【设计意图】默认走"选区抓取"而不是文件选择器 —\n修图时素材就在画布上, 框一下比翻文件夹快得多。\n【上限 4 张】不是抠门: 参考图越多 AI 越容易精神分裂,\n4 张是效果和自由度的平衡点。', btn: '下一步' },
      { target: null, bubblePos: 'bottom',
        title: '参考图卡片',
        text: '每张已添加的参考图:\n【缩略图】点了放大预览\n【× 删除】用完的参考记得删 — 参考图会一直跟着\n每次生成, 忘删会让下一张图莫名"长得像上一单"\n【设计意图】卡片常驻可见而不是收进菜单,\n就是要让"现在挂着什么参考"一眼可查, 防呆。', btn: '看完了, 收起' },
      { target: 'records', wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '生成记录磁贴',
        text: '每次生成的档案柜(图+提示词一起存)。打开看部件。', btn: '打开看看 →' },
      { target: { sel: '#rbFilter', inner: true }, keepOpen: 'records', wait: 750,
        onEnter: function() { try { TileAPI.expandTile('records'); } catch (e) {} },
        title: '筛选与搜索',
        text: '【筛选下拉】按结局过滤: 成功/失败/后台完成…\n【搜索框】按提示词或预设名搜 — 找"上周那张海边"用它。\n【设计意图】记录是全量归档不限量, 靠筛选和搜索取用,\n而不是像老历史那样只留最近几十条。', btn: '下一步' },
      { target: null, bubblePos: 'bottom', keepOpen: 'records',
        title: '组卡解剖',
        text: '每组任务一张卡:\n【封面缩略图】该组第一张成功图\n【📋词】当时的提示词一键装回(Forge 单连参数快照一起)\n【▣区】恢复当时的 PS 选区\n【引擎标】哪条工作流出的(run/forge/batch...)\n【设计意图】"装回再微调"是记录的灵魂 — 出图是抽卡,\n抽到 80 分的那张, 装回微调比从头再写快十倍。', btn: '看完了, 收起' },
      { target: 'batch', wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '批处理磁贴',
        text: '【干嘛用】把多个生成任务排成队列自动执行:\n【＋ 添加】把"当前选区+当前提示词参数"存成一单\n(换选区/换词再添加, 攒一队)\n【▶ 开始】从头到尾自动跑, 每单之间自动衔接\n【🗑 清空】清掉整个队列\n【设计意图】给"睡前挂机"设计的 — 白天把要试的\n组合都添加进队列, 晚上一键跑, 早上收图。\n配合设置里的音效, 跑完还会响铃提醒。', btn: '下一步' },
      { target: null, title: '✅ 本章完成',
        text: '组合拳记住这套:\n参考图定风格 → 出图 → 历史回放做迭代 → 批处理跑量。\n素材链的每一环都有专门的磁贴管着。', btn: '完成' }
    ] },
  { id: 'ch5',  icon: '⚡', title: '算力与账号 (控件级详解)', desc: '登录 / 托管与自带Key / 槽位 / 账单 / 状态大盘',
    steps: [
      { target: null, title: '⚡ 算力是什么',
        text: '每次 AI 出图都要消耗算力(就是钱)。\n这一章讲清: 算力从哪来、怎么充、怎么查、怎么省。\n(全程只讲解, 不会动你的账号)', btn: '开始' },
      { target: 'topbar', title: '一切从顶栏开始',
        text: '账号和算力的家就是顶栏(里面分「👤账户/⚡算力」两页)。\n展开看细节。', btn: '展开看看 →' },
      { target: { sel: '[data-section="account"]', inner: true }, keepOpen: 'topbar', wait: 750,
        onEnter: function() {
          try { TileAPI.expandTile('topbar'); } catch (e) {}
          setTimeout(function() { _topbarTab('account'); }, 500);
        },
        title: '账户页: 登录区逐控件',
        text: '【邮箱/密码框】注册和登录共用, 填完点按钮\n【记住我】勾了下次自动登录(公用电脑别勾)\n【忘记密码】邮箱+充值卡密自助找回, 没充过值走客服\n【设计意图】为什么非要登录? 托管算力、云同步、客服\n都得知道"你是谁"才能把东西记在你名下。', btn: '下一步' },
      { target: { sel: '[data-section="power"]', inner: true }, keepOpen: 'topbar', wait: 400,
        onEnter: function() { _topbarTab('compute'); },
        title: '算力页: 模式切换(两个单选)',
        text: '(已切到⚡算力页)\n【夏三七托管】后台直接分配算力: 充卡密就能用, 零配置。\n锁着(🔒) = 还没登录。\n【自带 Key】你自己去 GRS/AJI 买的 Key 填进来,\n用自己的额度, 不依赖登录, 隐私优先。\n【设计意图】新手图省事走托管, 老手图便宜自带 Key,\n两条路随时一键互切, 出图自动用当前选中的那路。', btn: '下一步' },
      { target: { sel: '[data-section="power"]', inner: true }, keepOpen: 'topbar',
        title: '算力页: 每家渠道的配置块',
        text: '同一个区里每家算力各有一块:\n【Key 输入框】贴上你的 Key(小眼睛👁可以显示/隐藏)\n【查询按钮】点了立刻查余额/积分, 顺带验证 Key 对不对\n【地址下拉】(GRS)选服务器线路, 连不上换一条\n【自定义渠道】"其他"支持添加/删除自己的中转配置,\n还能一键拉取该渠道支持的模型列表。', btn: '下一步' },
      { target: { sel: '[data-section="slots"]', inner: true }, keepOpen: 'topbar',
        title: '算力页: 槽位自定义逐控件',
        text: '点开「🎛 算力槽位自定义」这一节:\n【名字输入框】给每格算力起自己的名(如"我的中转")\n【▲▼】调三格的显示顺序\n【模型勾选】每格只露出你常用的模型, 长列表清爽掉\n【全名/短名】给模型起人话名(短名用于窄处显示)\n【保存】改完必点, 全插件同步生效\n【恢复默认】玩坏了一键回出厂。', btn: '下一步' },
      { target: 'billing', wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '算力账单磁贴',
        text: '【渠道卡片】每家算力一张卡: 当前余额 + 近期消费\n【明细行】每笔花销: 时间/模型/张数/花了多少\n【设计意图】AI 出图是按张烧钱的, 账单让你随时知道\n"钱花哪了" — 对不上账先来这查, 再找客服。', btn: '下一步' },
      { target: 'aistatus', title: 'AI 状态大盘磁贴',
        text: '【时间窗标签】近1小时 / 24小时 / 7天 三档切换\n【渠道分组】每家算力按模型列成功率和平均耗时\n【颜色】绿=健康 黄=抖 红=大面积故障\n【设计意图】"出图老失败"最常见的原因是上游在抖 —\n大盘一片红就等恢复, 别反复重试白烧算力。\n数据来自全体用户匿名汇总, 比你自己试靠谱。', btn: '下一步' },
      { target: null, title: '✅ 本章完成',
        text: '新手路线: 注册登录 → 卡密充进托管 → 直接出图。\n玩熟了想省钱再研究自带 Key。\n花销看账单, 故障看大盘, 各管一摊。', btn: '完成' }
    ] },
  { id: 'ch6',  icon: '💬', title: '对话与助手 (控件级详解)', desc: 'AI助手 / 对话历史 / 提示词优化器 / 翻译',
    steps: [
      { target: null, title: '💬 你的修图参谋',
        text: '除了出图, 插件里还住着几个"文字型"帮手:\nAI 助手、对话历史、提示词优化器。\n这一章把每个的按钮都讲到。', btn: '开始' },
      { target: 'chat', title: 'AI 助手磁贴',
        text: '内置聊天窗。打开逐个部件看。', btn: '打开看看 →' },
      { target: { sel: '#chatSessionStrip, #chatSessionSelect', inner: true }, keepOpen: 'chat', wait: 750,
        onEnter: function() { try { TileAPI.expandTile('chat'); } catch (e) {} },
        title: '会话区',
        text: '【会话列表/下拉】多个对话平行开, 互不串味 —\n一个聊调色思路、一个聊构图, 各聊各的\n【+ 新建】开新话题就新建, 别在旧会话里混着问\n(AI 会把整段历史都当上下文, 混着问会互相干扰)', btn: '下一步' },
      { target: { sel: '#chatRoleBtn, #chatRoleCard', inner: true }, keepOpen: 'chat',
        title: '角色卡',
        text: '【干嘛用】9 个内置职业角色: 修图助手/摄影后期师/\n人像精修/化妆师/服装师…还能自建角色。\n【设计意图】"问对人"比"会问"更重要 —\n每个角色底层塞了整套专业提示词, 同一个问题\n化妆师和后期师给的答案完全不同。\n【管理】角色管理里可编辑图标/名字/人设提示词。', btn: '下一步' },
      { target: { sel: '#chatAttachPS', inner: true }, keepOpen: 'chat',
        title: '📷 PS 截图按钮',
        text: '【干嘛用】把当前 PS 选区截给 AI 看图诊断。\n流程: PS 里框住要问的区域 → 点它 → 图进对话\n【隔壁的 📎】从文件选图, 手机拍的原片也能发\n(所有图发送前都会自动压缩, 不用担心太大)\n【上限】一条消息最多 4 张图。', btn: '下一步' },
      { target: { sel: '#chatInput', inner: true }, keepOpen: 'chat',
        title: '输入区三件套',
        text: '【输入框】问题打在这, 回车发送\n【发送/停止】生成中会变成停止键, 嫌它啰嗦随时打断\n【消息上的按钮】AI 回答下面有三个小按钮:\n📋复制 / 📝填入提示词(答案直接进提示词磁贴) /\n🔄重新生成(不满意就重答)\n【设计意图】"填入提示词"是灵魂 — 问完直接开跑,\n聊天和出图不断链。', btn: '下一步' },
      { target: { sel: '#chatSettingsBtn', inner: true }, keepOpen: 'chat',
        title: '⚙ 助手设置',
        text: '点开后:\n【API 地址/Key/模型】对话用的服务(跟出图算力分开,\n需要单独配一个对话 Key; 模型可一键拉取列表)\n【温度】答案的"放飞程度", 低=严谨 高=有创意\n【最大 tokens】单次回答长度上限\n【图片分辨率】发给 AI 的图压到多大, 默认 1024 够用\n【清空对话】当前会话推倒重来。', btn: '看完了, 收起' },
      { target: 'center', wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '生成中心磁贴',
        text: '【干嘛用】每次生成像聊天记录一样排: 你发的选区+词\n→ AI 回的图; 进行中的单子是带控制条的"活气泡",\n倒计时/停止/传回切换都在气泡上。\n【图片可点】点回图放大, ○ 圆点在 PS 里单显这张\n【失败条目】红字显示原因, 复制发客服刚好\n【🗑 清空 / 📁 文件夹】清记录 / 直接开图片缓存目录\n【设计意图】进度和结果同屏, 不用在两个磁贴间跳。', btn: '下一步' },
      { target: 'prompt-optimizer', title: '提示词优化器磁贴',
        text: '【主输入框】把大白话丢进去(如"把人变好看点")\n【✨ 优化】AI 帮你扩写成结构化专业提示词\n【追问框 + 继续优化】对结果不满意, 用大白话再提要求,\n它在上一版基础上改(比如"再强调一下光影")\n【发送到提示词】一键把成品填进提示词磁贴\n【设计意图】新手卡壳的从来不是想法, 是"翻译" —\n它就是你和 AI 之间的翻译官。(需登录, 走服务端算力)', btn: '下一步' },
      { target: null, title: '翻译在哪?',
        text: '没有独立的翻译磁贴 — 翻译长在需要它的地方:\n【Forge 磁贴】正/负提示词各有翻译按钮(中译英)\n【提示词磁贴】文本模式有翻译追加\n【设计意图】翻译是个动作不是个地方 —\n在你写词的现场给你按钮, 而不是让你复制粘贴来回跑。', btn: '下一步' },
      { target: null, title: '✅ 本章完成',
        text: '词穷 → 优化器; 思路/看图问题 → AI 助手(记得选对角色);\n翻旧图 → 对话历史。三个参谋各司其职。', btn: '完成' }
    ] },
  { id: 'ch7',  icon: '📷', title: '摄影专业工具 (控件级详解)', desc: '3D镜头 / 灯光 / 人体剪影 / 场景包 / 示波器 / 尻特效',
    steps: [
      { target: null, title: '📷 给摄影师的工具箱',
        text: '这一组是专业向: 用 3D 的方式摆镜头、打灯、定姿势,\n再交给 AI 出图。新手可先跳过, 想进阶再回来。\n每块磁贴的控件都会讲到。', btn: '开始' },
      { target: 'camera', title: '3D 镜头磁贴',
        text: '打开看内部(3D 画布会加载一下)。', btn: '打开看看 →' },
      { target: null, bubblePos: 'bottom', wait: 900,
        onEnter: function() { try { TileAPI.expandTile('camera'); } catch (e) {} },
        title: '3D 镜头逐控件',
        text: '【3D 画布】拖动旋转视角, 里面站着个假人 —\n你现在看到的构图 = AI 将来出的构图\n【方位角/俯仰角滑杆】精确调机位(旁边小字是当前度数,\n⟲ 按钮一键归零)\n【距离/焦段】推拉镜头: 近=特写 远=全身\n【下方参数区】跟主参数一样的 渠道/模型/尺寸/张数\n【开始生成】按当前机位构图出图\n【设计意图】"低角度仰拍"这种话 AI 理解得七七八八,\n但 3D 摆出来的机位它照着画 — 眼见为实。', btn: '看完了, 收起' },
      { target: 'light', wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '灯光磁贴',
        text: '打开看内部(2D/3D 两个标签页)。', btn: '打开看看 →' },
      { target: null, bubblePos: 'bottom', wait: 900,
        onEnter: function() { try { TileAPI.expandTile('light'); } catch (e) {} },
        title: '灯光逐控件',
        text: '【2D / 3D 标签】平面打光(快) / 立体打光(准) 两套\n【灯位画布】把光源拖到人物周围 — 主光/轮廓光/氛围光\n【颜色选择器】每盏灯的色温颜色(暖橙/冷蓝随你)\n【强度滑杆】灯的亮度\n【方位/俯仰】(3D页)光从哪个立体角度打过来\n【无损模式⭐】强烈推荐开: 输出的不是改过的图, 而是一层\n中性灰柔光校正层 — 不毁原图、不丢分辨率, 不满意删图层\n就回去了, 专业修图的"非破坏性"打灯\n【生成按钮】把这套布光"告诉"AI 照着打\n【设计意图】摄影棚布光思路原样搬进 AI —\n会打灯的人不用学新东西, 不会的照模板摆也能出效果。', btn: '看完了, 收起' },
      { target: 'bodypreset', wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '人体剪影磁贴',
        text: '打开看内部。', btn: '打开看看 →' },
      { target: null, bubblePos: 'bottom', wait: 900,
        onEnter: function() { try { TileAPI.expandTile('bodypreset'); } catch (e) {} },
        title: '人体剪影逐控件',
        text: '【剪影画布】人形轮廓, 摆姿势用\n【体型参数】身高/体型比例等滑杆, 定人物身形\n【💾 保存 / 📥 导入 / 📤 导出】自己调的体型存成预设,\n也能跟同行互传\n【返回按钮】回列表选别的剪影\n【设计意图】"控制人站成什么样"是文字最说不清的事 —\n剪影一摆, AI 往轮廓里填内容, 姿势就定住了。', btn: '看完了, 收起' },
      { target: 'scene', wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '场景包磁贴',
        text: '打开看内部。', btn: '打开看看 →' },
      { target: null, bubblePos: 'bottom', wait: 900,
        onEnter: function() { try { TileAPI.expandTile('scene'); } catch (e) {} },
        title: '场景包逐控件',
        text: '【场景卡片区】成套的场景/风格模板, 点选套用\n【焦段滑杆】该场景用什么镜头感觉拍\n【抓取参考】把 PS 选区抓进来跟场景组合\n【返回】回场景列表\n【批量按钮】同一场景一次出多张\n【设计意图】搭环境是最费提示词的活 —\n场景包 = 别人替你写好的环境提示词+参考组合,\n选完只管按快门。', btn: '看完了, 收起' },
      { target: 'scope', wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '示波器磁贴',
        text: '【干嘛用】专业调色的波形/直方图监视器:\n实时显示 PS 画面的曝光和色彩分布。\n【怎么看】波形顶到天花板 = 过曝死白;\n堆在地板 = 欠曝死黑; RGB 三色分离 = 偏色。\n【1:1 模式】按真实比例显示不拉伸。\n【设计意图】眼睛会骗人(屏幕/环境光都影响判断),\n波形不会 — 调色老手的标配仪表。', btn: '下一步' },
      { target: 'kao', title: '尻特效磁贴',
        text: '【干嘛用】给画面加动态粒子特效: 光斑/飞尘/魔法光效。\n【🎲 随机】不知道要什么就摇一把\n【张数】特效也能一次多抽几张挑\n【开始/禁用按钮】跑特效 / 临时关掉它的钩子\n【设计意图】出好图后的"氛围感最后一公里" —\n实拍很难拍到的空气感粒子, 后期一键补。', btn: '下一步' },
      { target: null, title: '✅ 本章完成',
        text: '机位找 3D镜头, 打光找灯光, 姿势找剪影,\n环境找场景包, 曝光看示波器, 氛围加尻特效。\n六件套按需取用, 不用全学。', btn: '完成' }
    ] },
  { id: 'ch8',  icon: '📰', title: '海报排版 (控件级详解)', desc: '接单图 / 正片排版一条龙',
    steps: [
      { target: null, title: '📰 一键出海报',
        text: '专门做二次元摄影海报: 接单图(价目表/约拍宣传)、\n正片作品图。填好信息自动排版。\n这一章按面板里的 5 个 STEP 逐步讲。', btn: '开始' },
      { target: 'poster', title: '海报磁贴',
        text: '打开, 面板从上到下就是制作流程。', btn: '打开看看 →' },
      { target: null, bubblePos: 'bottom', wait: 900,
        onEnter: function() { try { TileAPI.expandTile('poster'); } catch (e) {} },
        title: 'STEP 1 · 智能填写',
        text: '【类型选择】接单图 or 正片, 两套完全不同的排版逻辑\n【大文本框】把你的接单文案/作品说明原样粘进来 —\n朋友圈文案、聊天记录、价目表, 什么格式都行\n【AI 自动填写按钮】AI 读你的文案, 自动拆出\n标题/价格/联系方式等字段填进表单\n【设计意图】没人愿意逐格填表 — 你平时怎么发朋友圈,\n就怎么喂给它, 拆字段的活 AI 干。', btn: '下一步' },
      { target: null, bubblePos: 'bottom',
        title: 'STEP 2 · 风格设置',
        text: '【模板选择】动漫 KV 风等成套模板\n【配色/字段微调】自动填的结果可以逐格改,\n改错哪格改哪格, 不用重新生成\n【设计意图】模板定骨架、字段定内容, 两层分开 —\n换模板不丢内容, 改内容不动版式。', btn: '下一步' },
      { target: null, bubblePos: 'bottom',
        title: 'STEP 3 · 素材图片',
        text: '【添加图片】海报上放的照片:\n从 PS 选区框选抓取(正片流程常用 4 格素材位)\n或从文件添加\n【设计意图】素材直接从你正在修的 PS 文档里拿 —\n修完的成品图不用先导出再导入, 少一趟文件操作。', btn: '下一步' },
      { target: null, bubblePos: 'bottom',
        title: 'STEP 4 · 分页 / STEP 5 · 生成',
        text: '【分页】内容多的接单图可以分成几页(一页价目\n一页须知), 每页单独生成\n【服务通道】GRS/AJI 二选一(用 GPT-Image 系模型排版)\n【生成】每页一张任务卡, 成品自动贴回 PS\n【连接警告区】通道没配好这里会红字提示 —\n托管没登录会明确让你去登录, 照提示走就行。', btn: '看完了, 收起' },
      { target: null, wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '✅ 本章完成',
        text: '海报 = 粘文案 → AI 拆字段 → 选模板 → 框素材 → 生成。\n接单季批量出价目表, 全程不碰排版软件。', btn: '完成' }
    ] },
  { id: 'ch9',  icon: '🖥', title: '本地引擎 (控件级详解)', desc: 'Forge / ComfyUI / 分块放大 / 全局分区',
    steps: [
      { target: null, title: '🖥 用自己的显卡出图',
        text: '前面用的都是云端算力。有好显卡的话,\n接本地 Forge / ComfyUI 自己跑, 不花算力。\n这一章连两个进阶工具一起, 控件全讲。', btn: '开始' },
      { target: 'forge', title: 'Forge 磁贴',
        text: '打开看内部(控件最多的磁贴之一)。', btn: '打开看看 →' },
      { target: null, bubblePos: 'bottom', wait: 900,
        onEnter: function() { try { TileAPI.expandTile('forge'); } catch (e) {} },
        title: 'Forge 逐控件 (上)',
        text: '【连接按钮】连本地 Forge 或云端修脸服务器,\n连上才解锁下面所有功能\n【正向提示词】想要什么(带翻译按钮, 中文写完转英文)\n【负向提示词】不想要什么(同样带翻译)\n【模型下拉】用哪个 SD 大模型\n【LoRA 按钮】添加风格微调模型(修脸的灵魂)\n【拉取列表】从服务器同步可用的模型/LoRA 清单', btn: '下一步' },
      { target: null, bubblePos: 'bottom',
        title: 'Forge 逐控件 (下)',
        text: '【步数】画多少步, 20~30 常用, 越多越慢\n【重绘幅度】关键滑杆! 0.3=轻修 0.5=明显改 0.75=大改\n(修脸一般 0.3~0.5, 太高会换头)\n【CFG】提示词服从度, 7 左右即可\n【分辨率/张数/采样器】按需调\n【生成按钮】框选区开跑, 跟主流程一样回图层\n【设计意图】参数虽多但只有"重绘幅度"要天天动 —\n其他都有靠谱默认值, 别乱动。', btn: '看完了, 收起' },
      { target: 'comfyui', wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: 'ComfyUI 磁贴',
        text: '【连接按钮】连你本地跑着的 ComfyUI\n【载入参数按钮】读取你的工作流, 把里面的可调参数\n自动变成表单(参数区动态生成)\n【进度条】节点流跑到哪一步实时显示\n【打开文件夹】工作流文件放这里\n【设计意图】不复刻 ComfyUI 界面, 只把你调好的\n工作流"参数化" — 复杂度留在 ComfyUI, 日用只填表单。\n(玩得转节点流的高级用户专属)', btn: '下一步' },
      { target: 'tiled', title: '分块放大磁贴',
        text: '【提示词框+预设搜索】放大时可以带风格提示词\n【渠道/模型/尺寸】跟主参数同款选择器\n【重叠像素】关键参数: 相邻块的重叠区, 大了拼缝更\n自然但更费算力(默认值就好)\n【测试按钮】先跑一小块预览效果, 别整张试错\n【开始】整图切块→逐块放大→自动拼回\n【设计意图】低配显卡出印刷级大图的唯一姿势 —\n一整张 8K 谁都吃不下, 切成小块谁都能吃。', btn: '下一步' },
      { target: 'partition', title: '全局分区磁贴',
        text: '【干嘛用】把画面切成几个区, 每区各配一套\n提示词/参数, 分别生成。\n【分区列表】每区一行: 独立的提示词框和参数\n【区域框选】每区在 PS 里各框一个选区绑定\n【逐区/整批执行】一个区一个区跑, 或排队全跑\n【设计意图】"左边换背景、右边修人物"这种活,\n一把梭 AI 会顾此失彼 — 分区各管各的, 互不打架。', btn: '下一步' },
      { target: 'stitch', title: '多区拼接磁贴 — 省钱神器',
        text: '【干嘛用】跟全局分区反着来: 多个区域做【同一种】修改时,\n把它们拼成一张 1:1 的图, 一次调用全处理 — 3 个区 = 1 次的钱。\n(1:1 也正好是 banana 模型最稳定的比例)\n【+ 从当前选区添加】PS 里框一块加一块, 最多 6 块,\n支持跨文档(会分文档各自贴回编组)\n【▲▼】调放置优先级, 排前面的先挑好位置\n【张数 1~4】同一拼接图抽几张 — 每张回来各编一个组, 挑最好的留\n【▶ 拼接生成】智能排布成 1:1 → 生成 → 回图自动切块、\n各归各位贴回原选区(+羽化蒙版) + 编组', btn: '下一步' },
      { target: 'stitch', title: '多区拼接: 排布预览还能手动摆',
        text: '面板里那张 1:1 预览图显示的是【真实图像内容】,\n所见即所拼:\n【拖动图块】= 挪位置(想让谁挨着谁自己定)\n【拖右下角小方块】= 等比缩放(比例锁死, 不会变形)\n【↺ 自动排布】= 摆乱了一键回到算法排布\n【⚠有重叠】= 块叠住了会黄字提醒, 叠不叠你说了算\n【设计意图】AI 对画面顶部关注度略高 —\n重点区域可以手动挪到上面, 或放大占比。\n【提示词】用提示词磁贴当前内容, 全部区域共用。', btn: '下一步' },
      { target: null, title: '✅ 本章完成',
        text: '有显卡: Forge 修脸 / ComfyUI 跑工作流, 不花算力。\n要大图: 分块放大。分区域不同处理: 全局分区。\n多区域同一处理: 多区拼接(省调用费)。\n都是进阶件, 用不上先放着。', btn: '完成' }
    ] },
  { id: 'ch10', icon: '🎬', title: '创意幕布 (控件级详解)', desc: '节点式创作画布',
    steps: [
      { target: null, title: '🎬 自由创作的大画布',
        text: '常规出图是"选区→一张图"。创意幕布是另一种玩法:\n无限大的画布, 把图片、提示词、生成步骤摆成\n节点连着跑。这一章讲它的每类部件。', btn: '开始' },
      { target: 'canvas', title: '幕布磁贴(入口)',
        text: '从这块磁贴进幕布。\n(幕布是全屏大画布, 教程不带你进去逛,\n下面把里面的东西提前讲清, 进去就不慌)', btn: '下一步' },
      { target: null, title: '画布基本操作',
        text: '【拖动空白处】平移画布, 空间无限大\n【滚轮】缩放视角, 看全局或看细节\n【右键/长按空白】呼出节点菜单, 选一种节点放下\n【拖动节点】随意摆位置\n【连线】从节点边缘的接口拖到另一个节点 = 建立流程\n【设计意图】跟磁贴桌面同一个理念 — 你的工作台\n长什么样你说了算, 只是这里连"流程"也可视化了。', btn: '下一步' },
      { target: null, title: '节点家族(生成类)',
        text: '【提示词节点】写一段词, 可以连给多个生成节点复用\n【提示词分类节点】成组管理多段词\n【生成节点】吃"图+词"两个输入, 吐结果图 —\n它就是画布上的"出图按钮", 参数(渠道/模型/尺寸)\n节点上直接调\n【设计意图】词和生成分开成两种节点 —\n同一段词喂 3 个生成节点 = 一词多试, 改一处全更新。', btn: '下一步' },
      { target: null, title: '节点家族(图像处理类)',
        text: '这些不花算力, 本地秒算:\n【裁剪】切掉多余部分\n【扩边】往外补画布(配合生成节点做扩图)\n【缩放】改尺寸\n【拼合】多张图拼成一张(拼参考板/对比图)\n【PS 抓取/PS 选区】把 PS 画面抓进画布当素材\n【送回 PS / 保存】成果一键回 PS 文档或存文件\n【设计意图】幕布不是孤岛 — 素材从 PS 来,\n成品回 PS 去, 它是"草稿桌", PS 是"精修台"。', btn: '下一步' },
      { target: null, title: '幕布的生成怎么算钱',
        text: '幕布的生成节点走的是跟主插件同一套算力\n(同一个登录、同一份余额、同一个当前渠道)。\n本地处理节点(裁剪/拼合等)永远免费。\n任务进度同样出现在任务磁贴里, 随时可中断。', btn: '下一步' },
      { target: null, title: '✅ 本章完成',
        text: '幕布适合: 多素材拼构思、一张图连续多轮加工、\n一段词多路尝试。自由度最高, 也最吃想法 —\n常规流程跑熟了再来玩组合。', btn: '完成' }
    ] },
  { id: 'ch11', icon: '🛰', title: '扩展小工具 (控件级详解)', desc: '卫星遥控 / 轮椅浏览器 / 自动化接口',
    steps: [
      { target: null, title: '🛰 插件之外的帮手',
        text: '这几个是"长在主面板外面"的扩展:\n独立小窗、内置浏览器、编程接口。\n都是选装, 不装不影响主流程。', btn: '开始' },
      { target: 'satellite', title: '卫星遥控器磁贴',
        text: '【干嘛用】一个独立的迷你悬浮窗(单独的小插件):\n开始/停止/换模型/进度 常驻 PS 画布边上,\n修图时不用来回切主面板。\n【一键安装按钮】点了自动装(要关一次 PS, 按提示走)\n【版本/状态区】装没装、版本对不对一眼看到\n【设计意图】修图党 90% 的时间在画布上 —\n把最高频的三个按钮送到画布旁边, 主面板留给配置。', btn: '下一步' },
      { target: 'browser', title: '轮椅浏览器磁贴',
        text: '【干嘛用】同样是独立小插件: 在 PS 里开浏览器窗,\n查参考图、翻资料不用切出去。\n【一键安装/打开按钮】跟卫星同款安装流程\n【设计意图】找参考是修图的日常 —\n切浏览器再切回来, 心流就断了; 窗内解决不切屏。', btn: '下一步' },
      { target: 'codex', title: '自动化接口磁贴 (Codex)',
        text: '【总开关】"允许自动生成" — 关着时外部程序\n指挥不动插件, 这是安全闸\n【干嘛用】给懂技术的用户/AI 工具留的编程接口:\n外部程序下指令 → 插件自动填词出图。\n【设计意图】默认关闭 + 手动开启 —\n自动化很强也有风险, 必须你亲手放行才生效。\n普通用户可以完全无视这块磁贴。', btn: '下一步' },
      { target: null, title: '✅ 本章完成',
        text: '卫星窗是里面最实用的, 修图党强烈建议装;\n浏览器看习惯; 自动化接口不懂就别开。', btn: '完成' }
    ] },
  { id: 'ch13', icon: '⚙', title: '设置大全',       desc: '输出 / 生成行为 / 羽化 / 音效 / 外观 / 余额追踪 逐项讲',
    steps: [
      { target: null, title: '⚙ 把设置摸个底朝天',
        text: '设置磁贴里有三十多个开关,\n这一章按分区逐个讲清楚每个是干嘛的。\n(全程只讲解, 你不点就不会改到任何东西)', btn: '开始' },
      { target: 'settings', title: '设置磁贴',
        text: '就是它。打开逐区看。', btn: '打开看看 →' },
      { target: null, bubblePos: 'bottom', wait: 750,
        onEnter: function() { try { TileAPI.expandTile('settings'); } catch (e) {} },
        title: '① 输出设置 — 最影响日常的一区',
        text: '· 图层类型: 智能对象(可再编辑,推荐) / 普通图层(轻快)\n· 最大分辨率: 送给 AI 的图最长边, 越大越清晰但越慢\n· 色彩稳定模式: 回图偏色时开它\n· 自动编组: 出的图自动进分组, 图层面板不乱\n· 自动返回: 图好了自动贴回文档(关掉则手动取)\n· 无选区自动全图: 忘框选区时直接按整图算\n· 自动扩充+裁切⭐: 1:1 生图最稳定, 但照片选区多是 3:2 —\n开了它: 非方形选区自动补纯白凑成方形送 AI,\n回图自动裁掉白边贴回, 免去手动扩画布/居中/裁切三步\n· 4K偏色自动矫正: banana 模型 4K 出图偏洋红 —\n开了它: 编组完成后自动往组里嵌一层矫正曲线\n(需要同时开着自动编组才会触发)', btn: '下一步' },
      { target: { sel: '#togSyncMarquee', inner: true }, keepOpen: 'settings',
        title: '② 同步 PS 选框比例',
        text: '开了之后: 在参数磁贴选好比例(如16:9),\nPS 的矩形选框工具会自动锁定同比例,\n框出来的选区跟出图比例永远一致。', btn: '下一步' },
      { target: { sel: '#togTeachMode', inner: true }, keepOpen: 'settings',
        title: '③ 教学模式 / 滚轮调参',
        text: '· 教学模式: 每次生成会在 PS 里附一组"教学资料"\n  (当时的参数/参考图), 方便复盘和教学\n· 滚轮调参: 鼠标悬在滑块上直接滚轮微调, 老手提速', btn: '下一步' },
      { target: { sel: '#togRfEnabled', inner: true }, keepOpen: 'settings',
        title: '④ 传回羽化',
        text: 'AI 图贴回 PS 时给边缘加羽化过渡:\n· 收缩值: 往里收几像素, 吃掉生硬的边\n· 模糊值: 过渡带的柔和程度\n贴回的图边缘有"贴纸感"时来调这里。', btn: '下一步' },
      { target: null, bubblePos: 'bottom',
        title: '⑤ GPT-Image 高级设置',
        text: '只影响 GPT-Image 系列模型(海报常用):\n画质 / 背景透明 / 输出格式 / 参考强度。\n不用 GPT 模型的话这区可以无视。', btn: '下一步' },
      { target: { sel: '#togSound', inner: true }, keepOpen: 'settings',
        title: '⑥ 音效',
        text: '出图成功/失败的提示音, 三种情况可以分别设置。\n挂机跑批处理时建议开着, 有动静就知道结果。', btn: '下一步' },
      { target: { sel: '#setBlur', inner: true }, keepOpen: 'settings',
        title: '⑦ 外观 — 面板长相随你调',
        text: '· 模糊/透明度: 毛玻璃观感\n· 磁贴底色浓度 / 背景图(可自定义壁纸+位置缩放)\n· 缩放: 整个界面 50%~300%(前面讲过)\n· 简洁模式: 全面板去色变 PS 风灰度, 低调党福音\n· 磁贴翻转动画 / Emoji 风格 / 图标大小 / 主题色', btn: '下一步' },
      { target: { sel: '#togBalance', inner: true }, keepOpen: 'settings',
        title: '⑧ 余额追踪',
        text: '给 AJI/GRS 各设一条警戒线,\n余额低于阈值时生成前会弹提醒,\n防止跑批处理时余额见底白跑。', btn: '下一步' },
      { target: { sel: '#setClearCache', inner: true }, keepOpen: 'settings',
        title: '⑨ 图片缓存与杂项',
        text: '· 图片缓存: 生成的图都留了本地备份, 太占地了来这清\n· 用户改进计划: 匿名统计开关, 随时可关\n· 快捷键/预设/公告 等杂项也都在这一片', btn: '下一步' },
      { target: null, wait: 550,
        onEnter: function() { try { TileAPI.collapseTile(); } catch (e) {} },
        title: '✅ 本章完成',
        text: '三十多个开关全过了一遍。\n记不住没关系 — 知道"有这么个开关、在设置里"就够,\n用到时回来翻。', btn: '完成' }
    ] },
  { id: 'ch12', icon: '🚑', title: '疑难杂症 (控件级详解)', desc: '报错自查 / 客服 / 更新 / 日志 / 信息 / 帮助',
    steps: [
      { target: null, title: '🚑 出问题了怎么办',
        text: '最后一章讲"救命通道": 自查 → 问诊 → 治疗,\n每个环节的工具和按钮全讲到。\n看完这章 90% 的问题自己就能解决。', btn: '开始' },
      { target: 'center', title: '第一步: 看气泡上的原因',
        text: '生成失败时气泡直接写原因, 常见三种的自救:\n【内容审核未通过】换个说法, 避开敏感词\n【余额不足/额度】顶栏充值或换一格算力\n【超时】高峰期排队, 等会再试(别连点重试烧钱)\n看不懂的原因 → 复制下来, 走下面的路。', btn: '下一步' },
      { target: 'aistatus', title: '第二步: 看是不是服务在抖',
        text: '状态大盘切到「近1小时」看当前渠道:\n一片红 = 上游故障, 跟你无关, 等恢复;\n只有你红 = 你的配置问题, 检查 Key 和网络。\n【设计意图】把"是我的问题还是服务的问题"\n变成 10 秒能回答的事 — 这是排查的第一分岔口。', btn: '下一步' },
      { target: 'support', title: '第三步: 在线客服磁贴',
        text: '前两步解决不了 → 打开客服:\n【输入框+发送】直接发消息, 人在会回到插件里\n【📷 发图按钮】报错截图直接传\n【ℹ 附加信息按钮】一键把你的版本/环境信息\n附在消息里 — 强烈建议点, 省一半来回问\n【⚙ 配置】通知等选项\n(需要登录 — 客服得知道回消息给谁)', btn: '下一步' },
      { target: 'update', title: '保持最新版: 更新磁贴',
        text: '【检查更新按钮】手动查新版\n【自动提醒弹窗】有新版时弹出, 四个选择:\n立即更新 / 稍后 / 跳过这版 / 一段时间别提醒\n【更新历史】每版改了什么, 点开能看\n【设计意图】很多"怪问题"新版早修了 —\n弹窗给足选项是尊重你的节奏, 但建议别攒版本。', btn: '下一步' },
      { target: 'log', title: '日志磁贴 — 行车记录仪',
        text: '【日志流】插件运行的每一步都记着, 报错会标红\n【复制按钮】客服让你"发日志"时从这里一键复制\n【清空】记录太长看不清就清一下再复现问题\n【设计意图】你说"出不了图"和日志里的红字,\n对排查来说是两个信息量级 — 日志在, 问题跑不掉。', btn: '下一步' },
      { target: 'info', title: '信息磁贴 — 体检报告',
        text: '【运行状态区】版本/PS版本/连接状态/成功率统计\n【关于区】作者联系方式/免责声明\n【一键复制】整份状态复制成文本\n【跟日志的分工】信息 = 现在的体检报告(截面),\n日志 = 过去的行车记录(过程), 客服通常两个都要。', btn: '下一步' },
      { target: 'netdoctor', title: '网络体检磁贴 — 连不上先找它',
        text: '【▶ 开始体检】约10秒跑完四层检查:\n公网通不通 → DNS 有没有被劫持 → 每家出图服务哪个挂了 →\n浏览器和 PS 两条网络通路对照(PS被代理单独拦会当场现形)\n【结论】大白话直接告诉你该干嘛(换线路/关代理/等恢复)\n【📋 复制报告】一键复制发客服, 省一堆来回问\n【设计意图】"网络请求失败"五个字帮不了任何人 —\n这块磁贴把它翻译成人能懂、能行动的结论。', btn: '下一步' },
      { target: 'qa', title: '帮助磁贴 — 图文问答库',
        text: '【问题列表】常见问题按分类排\n【搜索】关键词直达答案\n【图文详情】带截图的操作说明, 比文字好懂\n【跟教程的分工】教程讲"怎么用"(带你操作),\n帮助讲"出了问题查什么"(像字典) — 互为补充。', btn: '下一步' },
      { target: null, title: '🎓 全部教程完成!',
        text: '恭喜, 整个轮椅从头到尾摸了一遍。\n排障口诀: 任务卡看原因 → 大盘看服务 →\n日志+信息发客服。\n忘了哪块随时回教程磁贴重看。祝出图愉快!', btn: '完成' }
    ] }

];

function _chapterById(id) {
  for (var i = 0; i < CHAPTERS.length; i++) if (CHAPTERS[i].id === id) return CHAPTERS[i];
  return null;
}

// 顶栏展开面板有「账户/算力」两个标签页, 圈对应区块前要先切到对的页
function _topbarTab(tab) {
  try {
    var t = document.querySelector('.topbar-toptab[data-toptab="' + tab + '"]');
    if (t) t.click();
  } catch (e) {}
}

// 当前是否处于磁贴编辑模式(dock.js 在 editMode:enter 时给 body 加 dock-editing;
// 双保险再看网格的 editing class)
function _inEditMode() {
  try {
    return document.body.classList.contains('dock-editing') || !!document.querySelector('.grid.editing');
  } catch (e) { return false; }
}

// ============================================================
//  引导引擎
// ============================================================
var _root = null;
var _curChapter = null;
var _stepIdx = -1;
var _trackTimer = null;   // interactive 步骤: 跟踪目标磁贴被拖动后的新位置
var _transitioning = false;   // 转场锁: 气泡淡出/滚动/等待期间防连点跳步
var _savedPromptText = null;  // ch2 滑块练手: 注入演示参数前备份的用户提示词

var FAKE_LINES = [
  ['⏳', '正在连接算力…', 1200],
  ['🎨', 'AI 正在理解你的提示词…', 2200],
  ['🖌', '绘制中… 60%', 2400],
  ['📥', '正在把结果贴回 PS…', 1600]
];

// ============================================================
//  教学假任务: 在任务磁贴里放一张"真实的"任务卡(不发任何请求),
//  用它串讲 任务面板 → 历史面板 → 回收站。教程结束一律清理干净。
// ============================================================
var FAKE_TASK_ID = null;

function _fakeTaskStart() {
  try {
    if (FAKE_TASK_ID) _fakeTaskCleanup();
    FAKE_TASK_ID = 'tutorial_demo_' + Date.now();
    var running = TileAPI.state.get('tasks.running') || {};
    running[FAKE_TASK_ID] = {
      engine: 'banana', provider: 'aji',
      batchSize: 1, startTime: Date.now(), success: 0, fail: 0, total: 1,
      model: '教学演示', size: '2K',
      presetTitle: '教学演示',
      promptSnippet: DEMO_PROMPT.substring(0, 30),
      thumbnail: null, docId: null, selection: null
    };
    TileAPI.state.set('tasks.running', running);
    var meta = TileAPI.state.get('tasks.meta') || {};
    // 超时给 9999 秒: 用户在解说步骤停多久都不会触发超时逻辑
    meta[FAKE_TASK_ID] = { countdown: 9999, timeoutSec: 9999, autoReturn: false, batchSize: 1 };
    TileAPI.state.set('tasks.meta', meta);
    TileAPI.emit('tasks:updated');
    TileAPI.emit('task:started', { taskId: FAKE_TASK_ID, timeoutSec: 9999, batchSize: 1 });
  } catch (e) {}
}

// 任务"完成": 从运行区拿掉(不走 generate 事件链, 不惊动计费/统计)
// v6.4.8: 历史磁贴已并入生成记录(数据走 host 回收站), 演示不再写假历史条目
function _fakeTaskFinish() {
  try {
    if (!FAKE_TASK_ID) return;
    var running = TileAPI.state.get('tasks.running') || {};
    delete running[FAKE_TASK_ID];
    TileAPI.state.set('tasks.running', running);
    var meta = TileAPI.state.get('tasks.meta') || {};
    delete meta[FAKE_TASK_ID];
    TileAPI.state.set('tasks.meta', meta);
    TileAPI.emit('tasks:updated');
    FAKE_TASK_ID = null;
  } catch (e) {}
}

// 兜底清理: 运行卡 + meta 撤走(跳过/完成都调)
function _fakeTaskCleanup() {
  try {
    if (FAKE_TASK_ID) {
      var running = TileAPI.state.get('tasks.running') || {};
      delete running[FAKE_TASK_ID];
      TileAPI.state.set('tasks.running', running);
      var meta = TileAPI.state.get('tasks.meta') || {};
      delete meta[FAKE_TASK_ID];
      TileAPI.state.set('tasks.meta', meta);
      TileAPI.emit('tasks:updated');
      FAKE_TASK_ID = null;
    }
    // 老版本演示条目扫雷: v6.4.8 前的教程会往 history.list 写演示假条目, 升级用户可能有残留
    var list = TileAPI.storage.get('history.list') || [];
    if (Array.isArray(list) && list.length) {
      var cleaned = list.filter(function(it) { return !(it && it.__tutorialDemo); });
      if (cleaned.length !== list.length) TileAPI.storage.set('history.list', cleaned);
    }
  } catch (e) {}
}

// 启动扫雷: v6.4.8 前版本的教程演示条目可能残留在落盘的 history.list 里 → 开机剔除
setTimeout(function() {
  try {
    var list = TileAPI.storage.get('history.list') || [];
    if (!Array.isArray(list) || !list.length) return;
    var cleaned = list.filter(function(it) { return !(it && it.__tutorialDemo); });
    if (cleaned.length !== list.length) TileAPI.storage.set('history.list', cleaned);
  } catch (e) {}
}, 4000);

function _buildRoot() {
  var d = document.createElement('div');
  d.className = 'tut-root';
  d.innerHTML =
    '<div class="tut-spot"></div>' +
    '<div class="tut-bubble">' +
      '<div class="tut-title"></div>' +
      '<div class="tut-text"></div>' +
      '<div class="tut-foot">' +
        '<span class="tut-skip">跳过引导</span>' +
        '<button class="w10-btn tut-next"></button>' +
      '</div>' +
    '</div>';
  d.querySelector('.tut-skip').addEventListener('click', function() { _endTour(true); });
  d.querySelector('.tut-next').addEventListener('click', function() {
    if (_transitioning) return;   // 转场中(滚动/等待/淡出) → 忽略连点, 防跳步
    // 带 verify 的步骤(比如"检查 PS 选区"): 校验通过才放行
    var s = _curChapter && _curChapter.steps[_stepIdx];
    if (s && s.verify) {
      var btn = this;
      btn.disabled = true;
      s.verify(function(ok) {
        btn.disabled = false;
        if (ok) _goto(_stepIdx + 1);
      });
    } else {
      _goto(_stepIdx + 1);
    }
  });
  document.body.appendChild(d);
  return d;
}

// 解析步骤目标 → DOM 元素(找不到/存在但不可见 都返回 null, 避免聚光灯圈在 0,0)
function _resolveTarget(target) {
  if (!target) return null;
  var el = null;
  try {
    if (typeof target === 'string') el = window.TileEngine ? TileEngine.getTileElement(target) : null;
    else if (target.sel) el = document.querySelector(target.sel);
    if (el) {
      var r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return null;   // display:none / 折叠区里
    }
  } catch (e) { return null; }
  return el;
}

function _moveSpot(el) {
  var spot = _root.querySelector('.tut-spot');
  if (el) {
    var r = el.getBoundingClientRect();
    spot.classList.remove('tut-spot-none');
    spot.style.left = (r.left - 6) + 'px';
    spot.style.top = (r.top - 6) + 'px';
    spot.style.width = (r.width + 12) + 'px';
    spot.style.height = (r.height + 12) + 'px';
    spot.style.opacity = '1';
    return r;
  }
  // 无目标(居中卡片): 聚光灯缩成 0 但保留阴影 → 整屏遮罩仍在, 用户聚焦教程本身
  spot.classList.add('tut-spot-none');
  spot.style.left = '50%';
  spot.style.top = '38%';
  spot.style.width = '0';
  spot.style.height = '0';
  spot.style.opacity = '1';
  return null;
}

function _placeBubble(rect, pos) {
  var b = _root.querySelector('.tut-bubble');
  b.style.transform = '';
  var bw = b.offsetWidth || 280, bh = b.offsetHeight || 140;
  var W = window.innerWidth, H = window.innerHeight;
  if (pos === 'bottom') {
    // 看展开面板/练手的步骤: 气泡沉底居中, 露出主要内容
    b.style.left = '50%';
    b.style.top = Math.max(8, H - bh - 16) + 'px';
    b.style.transform = 'translateX(-50%)';
    return;
  }
  if (!rect) {
    b.style.left = '50%';
    b.style.top = '42%';
    b.style.transform = 'translate(-50%, -50%)';
    return;
  }
  // 原则: 永不遮挡聚光灯圈住的区域。优先下方, 其次上方;
  // 目标太高上下都塞不下时, 贴到离目标中心较远的屏幕边缘(遮挡最少)
  var left = Math.max(8, Math.min(rect.left, W - bw - 8));
  var top;
  if (rect.bottom + 14 + bh <= H - 8) {
    top = rect.bottom + 14;
  } else if (rect.top - 14 - bh >= 8) {
    top = rect.top - bh - 14;
  } else {
    top = (rect.top + rect.height / 2 < H / 2) ? Math.max(8, H - bh - 12) : 12;
  }
  b.style.left = left + 'px';
  b.style.top = top + 'px';
}

function _playFake(done) {
  var title = _root.querySelector('.tut-title');
  var text = _root.querySelector('.tut-text');
  var i = 0;
  text.textContent = '(往上看: 任务面板里已经出现了你的任务卡)';
  function next() {
    if (!_root) return;
    if (i >= FAKE_LINES.length) { done(); return; }
    var L = FAKE_LINES[i++];
    title.textContent = L[0] + ' ' + L[1];
    setTimeout(next, L[2]);
  }
  next();
}

function _goto(idx) {
  var steps = _curChapter.steps;
  _stepIdx = idx;
  _transitioning = true;   // 进入转场 → 锁住"下一步", 直到本步气泡点亮
  if (_trackTimer) { clearInterval(_trackTimer); _trackTimer = null; }
  if (idx >= steps.length) { _endTour(false); return; }
  var s = steps[idx];
  if (s.onEnter) { try { s.onEnter(); } catch (e) {} }
  // 断点续传指针: 站在"会触发整页刷新"的步骤上时, 把下一步写进 storage
  // (应用布局前宿主会 storageFlush, 指针一定落盘; reload 后由 _resume 接力)
  // 离开这类步骤/普通步骤一律清指针, 防止过期指针在下次手动刷新时诈尸
  try {
    if (s.resumeNext) TileAPI.storage.set(RESUME_KEY, { ch: _curChapter.id, step: idx + 1 });
    else TileAPI.storage.remove(RESUME_KEY);
  } catch (e) {}

  var b = _root.querySelector('.tut-bubble');
  var btn = b.querySelector('.tut-next');
  var skip = b.querySelector('.tut-skip');
  // 转场顺序(修卡顿感): 旧气泡先淡出 → 聚光灯挪到新目标 → 才换文字 → 新位置淡入。
  // 文字的更新推迟到最后一拍, 绝不出现"旧位置挂着新文字"的错帧。
  b.style.opacity = '0';

  var myStep = idx;
  // 三段等待: ① 气泡淡出 180ms  ② s.wait = onEnter 动作(展开/收起)动画  ③ 滚动到目标
  var preWait = 180 + (s.wait || 0);
  setTimeout(function() {
    if (_stepIdx !== myStep || !_root) return;
    // 竖向长面板: 先滚到目标, 滚完再点亮
    var el = _resolveTarget(s.target);
    var delay = 0;
    if (el) {
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        delay = 450;
      } catch (e) {
        try { el.scrollIntoView(); } catch (e2) {}
        delay = 60;
      }
      b.style.opacity = '0';
    }
    setTimeout(function() {
      if (_stepIdx !== myStep || !_root) return;
      _transitioning = false;   // 气泡即将点亮 → 解锁"下一步"
      _root.classList.toggle('tut-interactive', !!s.interactive);   // 练手步骤: 点击放行到底下界面
      var rect = _moveSpot(el);
      // 文字到这一拍才换 — 此时气泡还是透明的, 用户看不到"旧位置新文字"的错帧
      b.querySelector('.tut-title').textContent = s.title;
      b.querySelector('.tut-text').textContent = s.text;
      b.querySelector('.tut-text').scrollTop = 0;
      b.style.opacity = '1';
      if (s.fake) {
        btn.style.display = 'none';
        skip.style.display = 'none';
        _placeBubble(null);
        _playFake(function() { if (_root) _goto(_stepIdx + 1); });
      } else {
        btn.style.display = '';
        skip.style.display = (idx === steps.length - 1) ? 'none' : '';
        btn.textContent = s.btn || '下一步';
        _placeBubble(rect, s.bubblePos);
        // 寻的模式跟踪(所有带目标的步骤都开, 哪怕目标暂时不存在):
        // · 磁贴被拖动/布局回流 → 每半秒跟新位置(防抖: 位置没变不动)
        // · 目标此刻不存在(如编辑工具栏要进编辑模式才出现) → 持续找,
        //   用户一做出正确操作元素一出现, 聚光灯立刻自动圈上 — 不再"定位失效"
        if (s.target) {
          var lastKey = '';
          _trackTimer = setInterval(function() {
            if (!_root || _stepIdx !== myStep) { clearInterval(_trackTimer); _trackTimer = null; return; }
            var el2 = _resolveTarget(s.target);
            if (!el2) {
              // 目标消失/还没出现: 配置了 keepOpen 就把所属磁贴重新展开(用户可能手滑关了面板)
              if (s.keepOpen) { try { TileAPI.expandTile(s.keepOpen); } catch (e) {} }
              return;
            }
            var r2 = el2.getBoundingClientRect();
            var key = Math.round(r2.left) + ',' + Math.round(r2.top) + ',' + Math.round(r2.width) + ',' + Math.round(r2.height);
            if (key === lastKey) return;
            lastKey = key;
            var rect2 = _moveSpot(el2);
            _placeBubble(rect2, s.bubblePos);
          }, 500);
        }
      }
    }, delay);
  }, preWait);
}

function _startTour(chapterId, stepIdx) {
  var ch = _chapterById(chapterId);
  if (!ch || !ch.steps) { TileAPI.toast('这一章还在制作中', 'info'); return; }
  if (_root) _endTour(true);
  _curChapter = ch;
  _root = _buildRoot();
  _goto(stepIdx || 0);
}

function _endTour(skipped) {
  if (_trackTimer) { clearInterval(_trackTimer); _trackTimer = null; }
  try { TileAPI.storage.remove(RESUME_KEY); } catch (e) {}
  _fakeTaskCleanup();   // 教学假任务/演示历史条目, 无论怎么退出都撤干净
  // ch2 滑块练手如果没走到还原那步就退出了 → 这里兜底还原用户的提示词
  try {
    if (_savedPromptText !== null) {
      TileAPI.emit('prompt:changed', { text: _savedPromptText, source: 'tutorial' });
      _savedPromptText = null;
    }
  } catch (e) {}
  // 教程期间展开过磁贴的话, 收场时顺手收起, 别把用户留在半路状态
  try { TileAPI.collapseTile(); } catch (e) {}
  if (_curChapter && !skipped) {
    try {
      TileAPI.storage.set(CHAPTER_DONE_PREFIX + _curChapter.id, true);
      if (_curChapter.id === 'mainline') TileAPI.storage.set(DONE_KEY, true);
      TileAPI.toast('本章完成! 教程磁贴里可以学更多', 'success');
    } catch (e) {}
  }
  if (skipped) { try { TileAPI.storage.set(DONE_KEY, true); } catch (e) {} }  // 跳过=别再自动弹
  if (_root && _root.parentNode) _root.parentNode.removeChild(_root);
  _root = null;
  _curChapter = null;
  _stepIdx = -1;
  try { _renderPanelIfOpen(); } catch (e) {}
}

// ============================================================
//  锚点自检: 遍历所有已实装章节的 step.target, 报告失效锚点
//  (选择器类锚点若在未展开的面板里, 会报"当前不可见", 属正常提示而非失效)
// ============================================================
function _selfCheck() {
  var lines = [];
  var bad = 0;
  for (var c = 0; c < CHAPTERS.length; c++) {
    var ch = CHAPTERS[c];
    if (!ch.steps) continue;
    for (var i = 0; i < ch.steps.length; i++) {
      var t = ch.steps[i].target;
      if (!t) continue;
      var desc = (typeof t === 'string') ? ('磁贴 ' + t) : ('选择器 ' + t.sel);
      if (_resolveTarget(t)) {
        lines.push('✓ ' + ch.title + ' 第' + (i + 1) + '步 → ' + desc);
      } else if (typeof t === 'object' && t.inner) {
        // 面板内部锚点: 平时不在 DOM 里, 展开后才有 → 提示而非报错
        lines.push('⏸ ' + ch.title + ' 第' + (i + 1) + '步 → ' + desc + '  (面板内锚点, 展开对应磁贴后再点一次自检可复核)');
      } else {
        bad++;
        lines.push('✗ ' + ch.title + ' 第' + (i + 1) + '步 → ' + desc + '  【找不到!】');
      }
    }
  }
  lines.unshift(bad === 0 ? '🟢 顶层锚点全部正常 (⏸ 为面板内锚点, 需展开复核)' : '🔴 有 ' + bad + ' 个锚点失效, 教程会指错位置:');
  try { TileAPI.log('[教程自检]\n' + lines.join('\n'), bad ? 'warn' : 'info'); } catch (e) {}
  return lines;
}

// ============================================================
//  教程磁贴
// ============================================================
var _panelContainer = null;

function _isDone(chId) {
  return TileAPI.storage.get(CHAPTER_DONE_PREFIX + chId) === true;
}

// 搜索: 关键词匹配章节标题/描述/步骤文案 → [{ch, stepIdx|null, label}]
function _search(kw) {
  var out = [];
  kw = (kw || '').trim().toLowerCase();
  if (!kw) return out;
  for (var c = 0; c < CHAPTERS.length; c++) {
    var ch = CHAPTERS[c];
    if ((ch.title + ch.desc).toLowerCase().indexOf(kw) >= 0) {
      out.push({ ch: ch, stepIdx: null, label: ch.icon + ' ' + ch.title });
    }
    if (!ch.steps) continue;
    for (var i = 0; i < ch.steps.length; i++) {
      var s = ch.steps[i];
      if (((s.title || '') + (s.text || '')).toLowerCase().indexOf(kw) >= 0) {
        out.push({ ch: ch, stepIdx: i, label: ch.icon + ' ' + ch.title + ' · ' + (s.title || ('第' + (i + 1) + '步')) });
      }
    }
  }
  return out.slice(0, 12);
}

function _renderPanel(container) {
  _panelContainer = container;
  var html =
    '<div class="w10-panel tut-panel">' +
      '<div class="w10-section-title">🎓 教程</div>' +
      '<div class="tut-search-row">' +
        '<input type="text" class="w10-input" id="tutSearchInput" placeholder="搜功能关键词, 比如: 预设 / 算力 / 报错">' +
      '</div>' +
      '<div class="tut-search-results" id="tutSearchResults"></div>' +
      '<div class="tut-chapter-list" id="tutChapterList"></div>' +
      '<div class="tut-panel-foot">' +
        '<button class="w10-btn" id="tutSelfCheck" title="检查教程锚点是否与当前界面对得上(开发者用)">🔍 锚点自检</button>' +
      '</div>' +
      '<div class="tut-selfcheck-out" id="tutSelfCheckOut" style="display:none"></div>' +
    '</div>';
  container.innerHTML = html;

  // 章节目录
  var list = container.querySelector('#tutChapterList');
  var itemsHtml = '';
  for (var i = 0; i < CHAPTERS.length; i++) {
    var ch = CHAPTERS[i];
    var ready = !!ch.steps;
    var done = _isDone(ch.id);
    itemsHtml +=
      '<div class="tut-ch' + (ready ? '' : ' tut-ch-planned') + '" data-ch="' + ch.id + '">' +
        '<span class="tut-ch-icon">' + ch.icon + '</span>' +
        '<span class="tut-ch-main"><span class="tut-ch-title">' + ch.title + '</span>' +
        '<span class="tut-ch-desc">' + ch.desc + '</span></span>' +
        '<span class="tut-ch-state">' + (ready ? (done ? '✓ 已看' : '开始 ›') : '制作中') + '</span>' +
      '</div>';
  }
  list.innerHTML = itemsHtml;
  list.addEventListener('click', function(e) {
    var row = e.target.closest('.tut-ch');
    if (!row || row.classList.contains('tut-ch-planned')) return;
    _startTour(row.getAttribute('data-ch'), 0);
  });

  // 搜索
  var inp = container.querySelector('#tutSearchInput');
  var resBox = container.querySelector('#tutSearchResults');
  inp.addEventListener('input', function() {
    var results = _search(this.value);
    if (!results.length) { resBox.innerHTML = ''; resBox.style.display = 'none'; return; }
    var h = '';
    for (var i = 0; i < results.length; i++) {
      var ready = !!results[i].ch.steps;
      h += '<div class="tut-sr' + (ready ? '' : ' tut-ch-planned') + '" data-i="' + i + '">' + results[i].label + (ready ? '' : ' (制作中)') + '</div>';
    }
    resBox.innerHTML = h;
    resBox.style.display = '';
    resBox._results = results;
  });
  resBox.addEventListener('click', function(e) {
    var row = e.target.closest('.tut-sr');
    if (!row || !resBox._results) return;
    var r = resBox._results[+row.getAttribute('data-i')];
    if (!r || !r.ch.steps) return;
    _startTour(r.ch.id, r.stepIdx || 0);
  });

  // 自检
  container.querySelector('#tutSelfCheck').addEventListener('click', function() {
    var out = container.querySelector('#tutSelfCheckOut');
    out.textContent = _selfCheck().join('\n');
    out.style.display = '';
  });
}

function _renderPanelIfOpen() {
  if (_panelContainer && _panelContainer.isConnected) _renderPanel(_panelContainer);
}

TileAPI.registerTile({
  id: 'tutorial',
  group: 'main',
  icon: '🎓',
  label: '教程',
  desc: '新手引导与功能图鉴',
  live: false,
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 6 },

  renderFront: function(container, w) {
    if (w >= 2) {
      container.innerHTML = '<div class="tile-icon">🎓</div><div class="tile-label">教程</div><div class="tile-desc">新手引导与功能图鉴</div>';
    } else {
      container.innerHTML = '<div class="tile-icon">🎓</div><div class="tile-label">教程</div>';
    }
  },

  onExpand: function(container) {
    _renderPanel(container);
    return function() { _panelContainer = null; };
  }
});

// ============================================================
//  新手主线自动弹: 等 firstrun 三件套全部收场后接力, 只弹一次
// ============================================================
TileAPI.on('tutorial:start', function(d) { _startTour((d && d.chapter) || 'mainline', (d && d.step) || 0); });

// —— 断点续传: 应用布局导致整页 reload 后, 从指针处接着讲 ——
(function _resume() {
  var r = TileAPI.storage.get(RESUME_KEY);
  if (!r || !r.ch) return;
  try { TileAPI.storage.remove(RESUME_KEY); } catch (e) {}
  var tries = 0;
  var t = setInterval(function() {
    tries++;
    if (tries > 30) { clearInterval(t); return; }   // 15 秒还没就绪就放弃(可从教程磁贴重进)
    // 等磁贴网格渲染完(拿顶栏当就绪信号)
    if (!(window.TileEngine && TileEngine.getTileElement && TileEngine.getTileElement('topbar'))) return;
    clearInterval(t);
    setTimeout(function() {
      try { TileAPI.toast('界面刷新完毕, 教程继续~', 'info'); } catch (e) {}
      _startTour(r.ch, r.step || 0);
    }, 600);
  }, 500);
})();

(function _autoStart() {
  // 教程调试模式(设置磁贴「调试」区的持久开关, 默认关):
  // 开着 = 每次加载都清"已弹过"标记 → 每次打开插件都自动弹主线(审稿/调试用)
  // 关着 = 正常行为: 新用户自动弹一次, 之后永不自动弹
  try {
    if (TileAPI.storage.get('tutorial.debugAlwaysShow') === true) TileAPI.storage.remove(DONE_KEY);
  } catch (e) {}
  if (TileAPI.storage.get(DONE_KEY) === true) return;
  if (TileAPI.storage.get('firstrun.welcomeShown') !== true) {
    // 全新用户: 欢迎页/导览还没走完, 等他们走完再说(下次启动自然会满足条件)
    // 这里也挂一个兜底: 每 3 秒看一次, 本次会话内走完三件套也能接上
  }
  var tries = 0;
  var timer = setInterval(function() {
    tries++;
    if (tries > 60) { clearInterval(timer); return; }   // 最多等 3 分钟, 等不到下次启动再来
    if (_root || _curChapter) { clearInterval(timer); return; }   // 教程已在跑(断点续传接上了) → 别抢
    if (TileAPI.storage.get(DONE_KEY) === true) { clearInterval(timer); return; }
    if (TileAPI.storage.get('firstrun.welcomeShown') !== true) return;   // 欢迎页还没看完
    // 欢迎页/功能导览/卫星推荐的遮罩都不在了 → 轮到我们
    if (document.querySelector('.fr-overlay') || document.querySelector('.frs-overlay')) return;
    clearInterval(timer);
    // 弹出的瞬间就记"已弹过": 中途关掉/重载也不再自动弹(调试和真实用户同理),
    // 想重看随时打开教程磁贴点主线
    try { TileAPI.storage.set(DONE_KEY, true); } catch (e) {}
    setTimeout(function() { if (!_root) _startTour('mainline', 0); }, 800);
  }, 3000);
})();

})();
