# 来源与校验记录

初次归档 2026-08-29（6.6.3）· 最后更新 2026-10-07（收录第三方改版归档件）

当前基线：**6.6.4**，`plugin/` 解包自 `_originals/6.6.4.zip`。`_originals/` 下另存有一个第三方改版的 zip，仅作归档、不参与构建。

## 保留的包

`_originals/` 下的包原样保存，未做任何修改。

| 文件 | 大小 | 来源 | SHA256 |
|---|---|---|---|
| `6.6.4.zip` | 3,360,931 | **作者直接发布的 zip** | `84c9f8196573214aa80c12f77ae48d24845b78b111c7b171fd18e4fec8485402` |
| `轮椅6.6.3_安装程序.exe` | 5,137,900 | **作者直接发布的安装包** | `5800aa7404f928f0814f0c9edf0e1e328ed22548775a6b67c35d02eb1eee5373` |
| `Xiasanqi-Wheelchair.zip` | 3,170,646 | 跑完 exe 后从安装结果打包 | `b6455f0a543ed189c3f3a5a56cd6be887ea190a9e9751bc566276e1f792e1e2c` |
| `Plug-ins.zip` | 29,389 | 跑完 exe 后从 `Plug-ins` 目录打包 | `b456ad641691558a29fd036ed9371a9fc1f2207911ecc41b81a6ff0a644b194b` |
| `轮椅664美式优化.zip` | 17,449,823 | **第三方改版，非作者发布** | `4432f027fe487131486daa3228f527f98a19a4a94deb694ef5680becb15b8a2a` |

来源分三类，这决定了每个包的用途与校验强度：

- `6.6.4.zip` 和那个 exe 是**作者发布的原始分发物**。
- `Xiasanqi-Wheelchair.zip` 与 `Plug-ins.zip` 是本归档的整理者在 Windows 上实际安装 6.6.3 之后，从安装结果打包出来的，**不是作者发布的形态**。打包器指纹与此吻合：两者同为 `create_version=63`、正斜杠路径、带目录条目，同一工具所打。
- `轮椅664美式优化.zip` 是**第三方对 6.6.4 的改版**，详见下文「第三方改版」。它只作为归档件存放，**不参与 `plugin/` 的构建**。

`_originals/extract.py` 的 `JOBS` 显式列出要解哪些包，并不会遍历 `_originals/` 下所有 zip——所以新增归档件不会意外混进工作树。

**6.6.4 的归档强度明显高于 6.6.3**：它直接来自作者发布的 zip，`plugin/` 可以逐字节回溯到上游原始分发物；而 6.6.3 只能回溯到安装结果（见下文「校验结论的强度」）。

## 6.6.4（当前基线）

作者 2026-09-22 发布，2026-09-28 归档。**仍是完整的 GPL v3 源码**——未压缩未混淆（`index.js` 891 行、`core/tile-engine.js` 2459 行，平均行长 40–46 字符），`index.js` 顶部 `Copyright (C) 2026 xiasanqi` 加 GPL v3 全段完好，`tiles/tile-info.js` 界面里仍标「夏三七 · GPL v3」。

许可头只出现在 `index.js` 一个文件里，这**不是 6.6.4 的变化**：6.6.3 同样是 146 个 ASCII 命名的 js 里只有 1 个带完整头。作者一贯如此，不是闭源前的信号。

### 打包质量：三个包里最规范的

| | 6.6.4.zip |
|---|---|
| 条目数 | 659（639 文件 + 20 目录） |
| 包裹目录 | 无，文件直接在 zip 根 |
| 路径分隔符 | `/`（0 条反斜杠） |
| 文件名编码 | 163 个中文名条目**全部带 UTF-8 标志位** |
| mtime | 208 个时间戳（2022-08-11 ~ 2026-09-22） |

中文名全部带标志位意味着**不需要猜编码**，也就不存在前两个包那种「UTF-8 字节被当 GBK 解出乱码却不报错」的隐患。macOS 自带 `unzip` 这次也能正常解。

### 校验结果

```
6.6.4.zip → plugin/
  解出文件 639 个, 目录 20 个, 其中中文名 163 个
  全部文件 CRC32 校验通过
```

`git diff v6.6.4 main -- plugin` 为空，即 `plugin/` 逐字节等于作者发布的 zip 内容。

### 相对 6.6.3 的差异

`git diff --name-status v6.6.3 v6.6.4 -- plugin`：

```
未变 603   修改 18   新增 18   删除 0
```

新增的 18 个中有 2 个是 `browser-pkg.zip` / `satellite-pkg.zip`，**并非 6.6.4 的新增内容**——`v6.6.3` 那份快照解包自 exe 安装结果，本就不含这两个文件（见下文「配套插件的来龙去脉」）。扣掉它们，作者真正新增 16 个文件。

修改的 18 个文件里，`manifest.json` 与 `tiles/tile-info.js` 只是版本号跟进。

新增四个功能磁贴：`tile-dlss`（DLSS 画质增强）、`tile-qwen21`（Qwen2.1 研究项目，打开先弹协议）、`tile-layercm`（双选区互相调色，纯本地）、`tile-light-splitter`（自动拆光）。

后台新增 DLSS 专线 `DLSS_BASE = 'https://xiasanqiforge.vip.cpolar.cn'`，同一台后端换了条更快的 cpolar 线路（作者注释：主域名 cn_top 约 2Mbps，这条 cn_vip 约 22Mbps），断线自动回退到 `OFFICIAL_BASE`。主域名 `xiasanqi.cpolar.top` 未变。

### 重建的 pkg zip 被上游验证为正确

6.6.4 的 zip **自带真实的 `browser-pkg.zip` / `satellite-pkg.zip`**。拿它们与 6.6.3 时期我们从 `companion/` 重建的两个比对：

```
browser-pkg.zip    上游 3 个条目 / 重建 3 个   双向无差集   共有条目 CRC32 全同
satellite-pkg.zip  上游 4 个条目 / 重建 4 个   双向无差集   共有条目 CRC32 全同
```

两项结论：

1. 当初从安装脚本行为反推出的布局（zip 根直接放文件、无包裹目录）**完全正确**。
2. 证实了「**zip 分发带这两个包，exe 安装不带**」——此前只是基于安装结果的推断，现在有了上游正面证据。

`plugin/` 下现已换成上游原始字节。`_originals/build-pkgs.py` 随之从「生成」降为「校验」：默认只在内存里重建并逐条目比对内容，零副作用；仅 `--write` 才覆写。这是为了避免把上游原始字节换成重建字节（内容相同但字节不同），那会污染 `plugin/` 的逐字节纯净性。

### 作者误打包的开发残留

```
40337  tiles/tile-dlss.host.js.bak-20260907-134010
42107  tiles/tile-dlss.host.js.bak2-20260907-183206
25880  tiles/tile-dlss.js.bak-20260907-183206
 2584  factory_layouts/Banana标准模式.json.bak      （6.6.3 就有）
```

前三个是 2026-09-07 开发 DLSS 时的中间版本，不该随包发布。第四个从 6.6.3 就在，是 `Banana标准模式.json` 的旧版本（2584 字节 vs 正本 2660 字节，mtime 早一天）。

**处置方式在两条分支上不同：**

| | `upstream` / `v6.6.3` / `v6.6.4` | `main` |
|---|---|---|
| 这 4 个文件 | **原样保留** | **已删除** |
| 理由 | 契约是「作者发出来的原样」，一旦开始取舍，tag 就不再是可信的上游快照 | 维护基线不需要背着别人的开发垃圾 |

删除是安全的，两条依据：

1. 全库没有任何代码按这些文件名读取它们。`.bak` 在本插件里确实是个运行期机制（`webview_storage.json.bak` 冷备份、预设与回收站的崩溃恢复等），但那些都在 `dataFolder` 里动态生成，与插件目录下这几个静态文件无关。
2. `factory_layouts/` 的加载条件是 `!e.name.toLowerCase().endsWith('.json')` 就跳过（`tiles/tile-layout.host.js:37`），所以 `Banana标准模式.json.bak` 本来就不会被当成布局加载。

`_originals/extract.py` 用 `EXCLUDE` 精确列出这 4 个路径，默认不解出来；加 `--keep-all` 则连它们一起解，用于复现与 tag 逐字节一致的树（已验证：`--keep-all` 解出 639 个文件，`git diff v6.6.4 -- plugin` 为空）。

`EXCLUDE` 故意写成精确路径而非 `*.bak` 通配——新版本若又带残留，应当经人过目再决定，不该被一条通配规则静默吞掉。

### GPTdev.md 引用了未发布的目录

新增的 `plugin/GPTdev.md`（1764 行）是作者为 AI 辅助开发生成的代码地图，声明扫描日期 2026-06-10，含全文件清单、各目录职责、启动路径与验证手段。

它引用了一个 `_dev/` 目录（`_dev/UI_SPEC.md` 等 3 个模板，`tile-light-splitter.js` 的注释也提到 `_dev/UI_SPEC.md`），但该目录**未随包发布**。也就是说这份文档描述的工作区比实际分发的内容多。

## 第三方改版：轮椅664美式优化

归档于 2026-10-07。**这不是作者发布的版本**，是一个自称「美式」的人在上游 6.6.4 基础上做的改版。

### 判定依据

决定性证据在 `tiles/tile-welcome.js`，改版者写死了一段本地公告自述身份：

```js
var LOCAL_ANNOUNCEMENT_HTML = '为美式在插件原作者夏三七的基础上进行 UI 优化和调整，请自行使用。<br>本插件免费使用，不提供使用过程中的答疑，特此说明！';
```

包名里的「美式」是改版者的名号，不是「American-style」。四项旁证：

| | 作者的 6.6.4 | 本包 |
|---|---|---|
| `manifest.json` 版本 | 6.6.4 | **仍是 6.6.4**（改了 30 个文件却未升版本） |
| 打包器 | `create_version=20` | `create_version=63` |
| 文件名编码 | 163 个中文名带 UTF-8 标志位 | GBK 字节，无标志位 |
| 结构 | 无包裹目录，是发布包形态 | 包裹目录名 `wheelchair664-sdppp2-work`，工作目录形态 |

### 内容构成

解压后 41.6 MB / 753 个文件：

```
 33.38 MB  102 个  presets/                      提示词预设包(98 json + 3 md + 1 txt)
  8.11 MB  643 个  wheelchair664-sdppp2-work/    插件本体
  0.06 MB    4 个  satellite-pkg/                配套插件(解包形态)
  0.03 MB    3 个  browser-pkg/                  配套插件(解包形态)
  0.01 MB    1 个  美式布局.json                  自定义布局
```

### 插件本体相对上游 v6.6.4 的差异

```
未变 613   改动 26   新增 4   删除 0
```

改动性质是**功能开发，不是破解**（已专门核查 `tiles/tile-billing.js`）：

- `host/ai-api.js` +367 行：接入 Midjourney（走墨墨渠道），含 4 张候选图的选图器与 taskId 挂起/唤醒机制
- 新增磁贴 `tiles/tile-mj.{js,host.js,css}` 与 `icons/mjlogo.svg`
- `tiles/tile-billing.js`：墨墨加为第四个计费渠道，显示顺序改走 `TileAPI.slotOrder()`
- 一个真实的 bug 修复：`Auto` 宽高比原本是死代码——`_mapGptSizeToPixels` 永远返回具体像素串，映射之后再比 `ar === 'auto'` 永不成立，Auto 会被悄悄按 1:1/横屏出图；改为映射之前先判断
- 行为改写：云端公告被换成写死的本地公告，且初始化即把 `_announcementReceived` 设为 `true`、超时也渲染本地文案——作者的云端公告再也盖不掉、也阻塞不了启动

新增的外部主机只有 `api1.momoapi.icu` / `api2.momoapi.icu`，而 momoapi 本就是上游已有渠道，与「MJ 走墨墨」的改动吻合。无可疑端点。

> 核查中的一处自我更正：`qwentest.vip.cpolar.top` 曾被误判为改版新增，实为**上游 6.6.4 自带**（在作者新加的 `tiles/tile-qwen21.*` 里）。误判源于比对时用的是 6.6.3 时代的已知主机清单。

### 为什么不进 upstream 分支，也不打 tag

`upstream` 的契约是「作者发出来的原样」。把第三方改版放进去并打 tag 会毁掉这条分支唯一的价值——`git diff` 两个 tag 时，作者的改动和改版者的改动会混在一起再也分不开，而这正是 vendor branch 设计要解决的问题。

因此本包**只以 zip 形式存放在 `_originals/`**，不解包、不入工作树、不打 tag。要查看内容请直接解压那个 zip。

### 使用前须知的两个风险

1. **id 与版本号同上游真 6.6.4 完全相同**（`com.xiasanqi.ps.wheelchair.v4` / `6.6.4`）。装上去占同一槽位，Photoshop 插件列表与插件界面里**无法区分**是哪一个。两者都装过的话，没有办法判断当前运行的是谁的版本。
2. **`presets/` 含明确的成人向内容**（如「胸部大小调整提示词」明示"极夸张增大"并要求 AI 不得自行缩小幅度，以及若干同类预设）。上游本就带过一个 NSFW 预设，但此处是 33 MB 规模的预设包，这类内容占比不低。本仓库为公开仓库，收录该 zip 即意味着对外托管这些内容。

### 授权

美式的改版是 GPL v3 软件的衍生作品，保留了原作者的版权头，并在公告中标注了原作者——合法的衍生作品，再分发也合法。本仓库对该 zip **原样收录、未作任何修改**（GPL 第 4 条「逐字复制」），其自身的修改声明在包内 `tiles/tile-welcome.js`。

## 已删除的包

| 文件 | 大小 | SHA256 |
|---|---|---|
| `6.6.3 for mac.zip` | 3,151,595 | `03d485c8a5cbb45d6054581452a51884a43d04e3a052369f45f4de2a75033b85` |

来源不明的第三方包，已连同 git 历史一并删除。删除理由是它的信息量被 `Xiasanqi-Wheelchair.zip` **严格包含**：

| | `Xiasanqi-Wheelchair.zip` | `6.6.3 for mac.zip`（已删） |
|---|---|---|
| 顶层目录 | `Xiasanqi-Wheelchair/` | `wheelchair/` |
| 条目数 | 642（621 文件 + 21 目录） | 621（无目录条目） |
| 路径分隔符 | `/` | `\`（全部 621 条） |
| 文件名编码 | GBK 字节 | UTF-8 字节 |
| mtime | 180 个真实时间戳（2022-08-11 ~ 2026-08-29） | 1 个，全部压平为 2026-08-05 18:54:56 |
| 打包器 | `create_version=63` | `create_version=20` |

内容层面：621 个文件的 CRC32 逐一相同，零差异。它多出的信息为零，而少了 179 个时间戳；且全反斜杠路径 + 无目录条目，在 macOS 上解出来是一堆带反斜杠的平铺文件，目录结构立不起来。

删除前已确认删掉不损失任何内容：`plugin/` 曾与该包逐文件比对，缺失 0、多余 0、CRC 不符 0。

## 校验结论的强度（6.6.3）

> 本节只针对 6.6.3。6.6.4 直接来自作者发布的 zip，不受这里的限制。

6.6.3 的 `plugin/` 曾同时与两个 zip 逐文件比对通过。但需要说明：**这两个 zip 并非独立来源**，它们都溯源到同一个 `轮椅6.6.3_安装程序.exe`。

所以那次比对证明的是「解包过程无损、两次打包都没损坏文件」，**不是**「两个独立分发物互相印证」。6.6.3 唯一的信任根是那个 exe，而它至今拆不开（见下文），因此无法把 6.6.3 的 `plugin/` 逐字节回溯到上游原始分发物——只能回溯到安装结果。

6.6.3 的基线取 `Xiasanqi-Wheelchair.zip`（见 tag `v6.6.3`），因为它路径结构正常且保留了 180 个真实文件时间戳（Inno Setup 安装时还原的原始时间）。

## 解包方式

`_originals/extract.py` 负责把分发包还原成 `plugin/` 与 `companion/`，逐文件校验 CRC32 并回写 zip 中记录的 mtime。

两个包的文件名编码情况不同：

- **`6.6.4.zip`**：163 个中文名条目全带 UTF-8 标志位，无需猜编码。
- **`Plug-ins.zip`**：GBK 字节且未设标志位。macOS 自带 `unzip` 假定 UTF-8，会直接报 `Illegal byte sequence` 解不出中文文件，必须按 `cp437 → 原始字节 → gbk` 还原。

脚本另有两个开关：默认会报告「目标目录里有、zip 里没有」的多余文件（版本升级留下的陈旧残留会在这里现形，否则会一直躺在 `plugin/` 里冒充上游内容），`--clean` 则先清空目标目录再解，供复现校验用。

命令行等价做法是 `unzip -O GBK`（Info-ZIP 6.0+），但它不回写精确 mtime，且不做逐文件校验。

## 校验结果（6.6.3）

> 6.6.4 的校验结果见上文「6.6.4（当前基线）」。

```
解出文件 621 个, 目录 20 个, 其中中文名 163 个
全部文件 CRC32 校验通过
```

删除 `6.6.3 for mac.zip` 之前，曾把解出的 `plugin/` 逐文件与它比对——

```
mac.zip 条目 621 / 磁盘文件 621
仅 zip 有: 0  仅磁盘有: 0  CRC 不符: 0
```

即两次独立打包的结果一致，解包过程无损。强度限制见上文「校验结论的强度」。

## 配套插件的来龙去脉

> 结论已由 6.6.4 闭合，见上文「重建的 pkg zip 被上游验证为正确」。本节保留当时的推理过程与证据。

安装出来的主插件目录里**不含**配套插件，但主插件的一键安装流程会从自己的插件目录读它们：

```
tile-browser.host.js:74    pluginFolder.getEntry('browser-pkg.zip')
bootstrap-handlers.js:573  pluginFolder.getEntry('satellite-pkg.zip')
```

是**内置**读取而非运行时下载。但**已确认**：从 `轮椅6.6.3_安装程序.exe` 装出来的插件目录里并没有这两个文件（已在 Windows 上核对安装结果）。

安装程序是把三个插件各装成独立文件夹（`修图轮椅` / `轮椅浏览器` / `轮椅遥控器`），根本不带 pkg zip——这也解释了为什么配套插件能直接从 `Plug-ins` 目录取回。也就是说主插件里那套一键安装配套插件的流程，在 exe 安装场景下是闲置的，大概只服务于纯 zip 分发的安装方式。**这个推断后来被 6.6.4 证实**：它的 zip 分发确实自带这两个包。

**exe 至今拆不开**：Inno Setup 6.7.0 打的，innoextract 最新的 1.10-dev 只支持到 6.3.3。手工解 `zlb\x1a` 压缩块也失败——6.7 改了容器布局，块头的 CRC 与 stored_size 都校验不过。

**已通过实机安装绕过**：在 Windows 上跑完安装程序，从 Photoshop 的 `Plug-ins` 目录取回两个插件文件夹，即 `Plug-ins.zip`，解包到 `companion/`：

| 插件 | id | 版本 | 主插件期待值 |
|---|---|---|---|
| 轮椅浏览器 | `com.xiasanqi.ps.wheelchair.browser` | 1.0.1 | `BROWSER_LATEST_VERSION = '1.0.1'` ✅ |
| 轮椅遥控器 v2 | `com.xiasanqi.ps.wheelchair.v6.satellite` | 2.0.0 | `latestVersion = '2.0.0'` ✅ |

版本与主插件里硬编码的常量吻合，可确认是配套的同一批。安装目标目录名也对得上（`BROWSER_DIR_NAME = '轮椅浏览器'`、`targetDir = pluginsDir + '\轮椅遥控器'`）。

## pkg zip 的重建方式（历史，已被上游取代）

> 6.6.4 起 `plugin/` 下的两个 pkg zip 是上游原始字节，不再是重建产物。本节记录 6.6.3 时期的重建依据——`build-pkgs.py --write` 仍按同样规则工作。

6.6.3 时期 `plugin/browser-pkg.zip` 和 `plugin/satellite-pkg.zip` 由 `_originals/build-pkgs.py` 从 `companion/` 重建。

布局依据 `install_browser.bat` / `install_satellite.bat` 的行为：

```powershell
Expand-Archive -Path <pkg.zip> -DestinationPath <PS Plug-ins\轮椅浏览器>
if (-not (Test-Path (Join-Path $d 'manifest.json'))) { 报错 }
```

即 zip 根目录下直接是 `manifest.json` 等文件，不能有包裹目录。脚本构建后会按这条判据自检。

条目时间戳一律写成固定值 `1980-01-01` 而不取文件系统 mtime：git 不保存 mtime，`checkout` 会把它刷成检出时刻，若照抄 mtime 则换台机器 clone 出来重建的 zip 字节就不一样。`Expand-Archive` 不关心这个时间戳，固定它换来跨机器可重复构建。

当时这两个 zip 在 exe 的安装结果里并不存在，所以它们补的是 exe 安装场景缺失的部分，且无从知道上游纯 zip 分发里的确切字节，只能保证解压后的文件内容与实际安装出来的配套插件一致。

**后续验证**：6.6.4 到手后与其自带的真实包比对，重建版本的内容逐一 CRC32 相同、双向无差集——上述布局推断完全正确。详见上文「重建的 pkg zip 被上游验证为正确」。
