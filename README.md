# 修图轮椅 v6.6.4 —— 归档与自维护分支

这是「夏三七的修图轮椅 v6」的存档与 fork，一个 Photoshop UXP 插件。当前基线 **6.6.4**（作者 2026-09-22 发布）。

原作者 **xiasanqi（夏三七）**，原项目以 **GPL v3** 发布。本仓库把上游每个拿到的版本完整、可校验地固定下来，作为长期自行维护的基线。

**作者尚未闭源。** 截至 6.6.4，源码仍以 GPL v3 完整发布——未压缩未混淆，`index.js` 顶部许可头与界面里的「夏三七 · GPL v3」都在。此前本文件曾写「6.6.3 是最后一个开源版本」，已被 6.6.4 推翻，特此更正。

原项目只通过 zip 分发，没有公开的 git 仓库，因此没有上游历史可继承。

> **非官方存档。** 本仓库由第三方整理，与原作者夏三七无隶属、无关联，也未经其背书。
> 「修图轮椅」这一名称属于原作者；GPL v3 授予的是版权许可，不包含名称或商标权利。
> 请勿将本仓库当作官方发布渠道，也不要就本仓库的问题去打扰原作者。

## 相对上游的修改

依 GPL v3 第 5(a) 条，此处载明本仓库相对上游 6.6.4 的全部改动。**最后更新 2026-09-28。**

**我们没有改写任何一个上游文件。** `plugin/` 下 635 个文件与作者发布的 `6.6.4.zip` 逐一 CRC32 相同（校验记录见 `PROVENANCE.md`）。

对 `plugin/` 唯一的改动是**删除了 4 个作者误打包的开发残留**：

```
tiles/tile-dlss.host.js.bak-20260907-134010
tiles/tile-dlss.host.js.bak2-20260907-183206
tiles/tile-dlss.js.bak-20260907-183206
factory_layouts/Banana标准模式.json.bak
```

它们是惰性的，删除不影响任何功能——全库没有任何代码按这些文件名读取它们，且 `factory_layouts` 的加载条件是 `!name.toLowerCase().endsWith('.json')` 就跳过（`tiles/tile-layout.host.js:37`），`.json.bak` 本来就不会被当成布局加载。

`upstream` 分支与 `v6.6.3` / `v6.6.4` 两个 tag **原样保留**这 4 个文件，那条分支的契约是「作者发出来的原样」。要复现与 tag 逐字节一致的树：`python3 _originals/extract.py --keep-all`。

6.6.3 时代我们曾往 `plugin/` 里补过两个重建的 `*-pkg.zip`，因为当时的 exe 安装结果里缺这两个文件。6.6.4 的 zip 自带了真实版本，缺口由上游闭合，那两个重建产物已被上游原始字节替换。

其余新增内容全部在 `plugin/` 之外：

| 路径 | 说明 |
|---|---|
| `LICENSE` | GPL-3.0 全文。上游分发未附带此文件，此处补上 |
| `README.md` | 本文件 |
| `PROVENANCE.md` | 来源、SHA256、校验记录 |
| `.gitattributes` | 关闭行尾转换，保住逐字节归档（见文件内注释） |
| `.gitignore` | |
| `_originals/` | 上游分发包、解包脚本 `extract.py`、校验脚本 `build-pkgs.py` |
| `companion/` | 两个配套插件源码的解包形态，内容未改 |

要拿到完全未经取舍的上游快照：`git checkout v6.6.4`（或 `v6.6.3`）。

## 6.6.4 带来了什么

`git diff --name-status v6.6.3 v6.6.4 -- plugin` 的结果：**未变 603 / 修改 18 / 新增 18 / 删除 0**。

新增的 18 个里有 2 个是 `browser-pkg.zip` / `satellite-pkg.zip`——它们并非 6.6.4 才有的新东西，只是 `v6.6.3` 那份快照来自 exe 安装结果而不含它们（详见「配套插件」）。所以作者真正新增的是 16 个文件，构成四个新功能磁贴加一份文档：

| 磁贴 | 功能 |
|---|---|
| `tiles/tile-dlss.*` | DLSS 画质增强。前端只有参数面板与预览对比，引擎在后台静默跑 |
| `tiles/tile-qwen21.*` | 「Qwen2.1 大家一起研究」。作者注释写明这是研究项目、不是免费改图工具，打开先弹协议 |
| `tiles/tile-layercm.*` | 双选区互相调色。纯本地，与 AI 无关：框选区 → 抓参照 A → 抓目标 B |
| `tiles/tile-light-splitter.*` | 自动拆光。LLM vision 分析光源 → 用户确认/编辑 → banana 批量分离 → PS 多图层输出 |

另附 `plugin/GPTdev.md`（1764 行）——作者为 AI 辅助开发生成的代码地图：全文件清单、各目录职责、启动路径、验证手段。对自行维护来说这是最有价值的新增内容，等于补上了原本缺失的开发者文档。注意它引用的 `_dev/` 目录（`_dev/UI_SPEC.md` 等）**未随包发布**。

包里还有三个作者误打包的开发残留（`tiles/tile-dlss.host.js.bak-20260907-134010` 等，均为 2026-09-07 开发 DLSS 时的中间版本）。`main` 上已删除，`upstream` 与两个 tag 原样保留，详见上文「相对上游的修改」。

## 授权

GPL v3。见 `LICENSE`。

已按 GPL v3 发布的版本，其授权是**永久且不可撤销**的——作者可以把以后的版本闭源，但收不回已经发出去的 6.6.3。所以修改、自用、乃至公开发布本仓库都合法，前提是：

- 继续以 GPL v3 发布
- 保留原作者的版权声明（`index.js` 等文件顶部的许可头，**不要删**）
- 分发时附带完整源码

需要区分清楚的是：**GPL 覆盖代码，不覆盖服务**。你有权修改代码（包括改掉积分与付费链路），但无权要求作者继续提供后台服务。

## 目录

```
plugin/       主插件源码，635 个文件，解包自作者发布的 6.6.4.zip（去掉 4 个开发残留）
companion/    两个配套插件源码：轮椅浏览器 1.0.1、轮椅遥控器 2.0.0
_originals/   上游分发包 + 解包脚本 extract.py + 校验脚本 build-pkgs.py
LICENSE       GPL-3.0 全文（上游分发缺这个文件，此处补上）
PROVENANCE.md 来源、SHA256、校验结果、版本间差异
```

重建 `plugin/` 与 `companion/`：

```
python3 _originals/extract.py             # 解包，并报告目标目录里的多余文件
python3 _originals/extract.py --clean     # 先清空目标目录再解（复现校验用）
python3 _originals/extract.py --keep-all  # 连开发残留一起解（复现 upstream 快照）
```

## 分支

- **`upstream`** —— 只放原样解包的上游内容，不掺任何自己的改动。tag `v6.6.3`、`v6.6.4`。
  再拿到上游包就解到这条分支打新 tag，于是能直接看出作者改了什么：

  ```
  git diff --stat v6.6.3 v6.6.4 -- plugin
  ```

  这套机制已经派上用场：6.6.3 → 6.6.4 是「未变 603 / 修改 18 / 新增 18 / 删除 0」。
- **`main`** —— 从 `upstream` 分出，加上 LICENSE / README / PROVENANCE 以及今后所有自己的修改。

## 加载

插件未签名，走开发者方式加载：

1. 装 [Adobe UXP Developer Tool](https://developer.adobe.com/photoshop/uxp/devtool/)（UDT）
2. Add Plugin → 选 `plugin/manifest.json`
3. Load

需要 Photoshop ≥ 26.0.0（2025）。`manifest.json` 里 `host.minVersion` 写死了这个下限。

`plugin/` 下的 `install_browser.bat` / `install_satellite.bat` / `update_plugin.bat` 是 Windows PowerShell 脚本，macOS 上用不上。

## 权限

`manifest.json` 申请的权限很宽，装之前应当知情：

```
localFileSystem: fullAccess          完整文件系统读写
network.domains: all                 任意域名联网
webview.domains: all                 webview 可载入任意域名
allowCodeGenerationFromStrings: true 允许 eval 类动态求值
launchProcess: .bat / .cmd           可拉起外部进程
```

## 后台依赖现状

插件是「客户端 + 付费后台」结构。**这一节只是记录现状，代码未做任何改动。**

后台地址固定在 `plugin/core/server-config.js`：

```js
var OFFICIAL_BASE = 'https://xiasanqi.cpolar.top';
```

cpolar 是内网穿透的临时域名，随时可能变更或失效。要换地址改这一行即可全插件切换（`FALLBACK_BASE` 与之相同，等于关闭回退）。

6.6.4 起另有一条 DLSS 专线，同一台后端、换了条更快的 cpolar 线路：

```js
var DLSS_BASE = 'https://xiasanqiforge.vip.cpolar.cn';
```

作者注释说明：主域名走 cn_top 实测约 2Mbps，这条 cn_vip 约 22Mbps，差十倍；DLSS 要传几十 MB 的图才值得单开一条，其余接口流量小继续走主域名。这条线断了会自动回退到 `OFFICIAL_BASE`。

`plugin/login-service.js` 承载登录、注册、积分（`common_points` / `banana_points`）和 `/auth/consume` 先扣分后出图。云 Forge / ComfyUI 的地址做了 XOR + Base64 混淆，密钥明文写在同一个文件里（`_xorKey = "xsq2026banana"`），源码注释说明其用途是「防止用户拿到地址绕过付费直连」。

**出图主链路不依赖作者后台。** `plugin/tiles/ai-api.js` 的 `callAiApi()` 接收 `apiKey` + `apiBaseUrl` + `provider` 参数，`provider` 支持 `aji` / `grs` / `momo` / `others`。在「自带 Key」（BYOK）模式下直连你自己配置的服务商，不经代理、不扣积分。

后台一旦停服，受影响的功能：

| 挂掉 | 不受影响 |
|---|---|
| 夏算力托管、云 Forge / 云 ComfyUI | BYOK 出图（自带 Key + base URL） |
| 预设云同步 `/api/presets` | 本地 ComfyUI（`127.0.0.1`） |
| 翻译 `/api/translate` | 本地 Forge |
| 提示词优化 `/api/optimize` | 全部本地预设、知识库、布局 |
| 海报自动填充 `/api/poster-autofill` | |
| 公告、用量查询、telemetry | |

因此长期可持续的方向是转向纯 BYOK，或自建一套后台顶替这些 `/api/*` 端点。

## 配套插件

主插件带一键安装两个配套插件的功能，会从自己的插件目录读 `browser-pkg.zip` / `satellite-pkg.zip`。**6.6.4 的 zip 自带这两个文件**，`plugin/` 下的就是上游原始字节。

| 插件 | 版本 | 说明 |
|---|---|---|
| `companion/轮椅浏览器/` | 1.0.1 | 浏览器面板，PS ≥ 24.0.0 |
| `companion/轮椅遥控器/` | 2.0.0 | 遥控器 / 卫星面板，PS ≥ 26.0.0 |

`companion/` 是同样内容的解包形态——zip 里没法 diff 也没法改，要看要动就看这里。两者也能单独用 UDT 加载，不必走主插件那套 Windows 专用的 `.bat` 安装流程。

改了 `companion/` 之后要让主插件的安装流程带上你的改动，才需要重新打包：

```
python3 _originals/build-pkgs.py           # 只比对，报告是否与 plugin/ 一致
python3 _originals/build-pkgs.py --write   # 重新打包并覆写 plugin/ 下的两个 zip
```

默认只比对不落盘，就是为了别把上游原始字节换成重建字节（内容相同但字节不同）。

> 6.6.3 时期 exe 安装结果里没有这两个包，当时是靠 `build-pkgs.py` 从 `companion/` 重建补上的。6.6.4 到手后比对发现：**当初重建的版本与上游真实文件内容逐一 CRC32 相同**，也证实了「zip 分发带这两个包、exe 安装不带」。详见 `PROVENANCE.md`。
