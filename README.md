# 修图轮椅 v6.6.3 —— 归档与自维护分支

这是「夏三七的修图轮椅 v6」6.6.3 版的存档与 fork，一个 Photoshop UXP 插件。

原作者 **xiasanqi（夏三七）**，原项目以 **GPL v3** 发布。作者准备闭源，6.6.3 是最后一个开源版本。本仓库把这个版本完整、可校验地固定下来，作为长期自行维护的基线。

原项目只通过 zip 分发，没有公开的 git 仓库，因此没有上游历史可继承。

## 授权

GPL v3。见 `LICENSE`。

已按 GPL v3 发布的版本，其授权是**永久且不可撤销**的——作者可以把以后的版本闭源，但收不回已经发出去的 6.6.3。所以修改、自用、乃至公开发布本仓库都合法，前提是：

- 继续以 GPL v3 发布
- 保留原作者的版权声明（`index.js` 等文件顶部的许可头，**不要删**）
- 分发时附带完整源码

需要区分清楚的是：**GPL 覆盖代码，不覆盖服务**。你有权修改代码（包括改掉积分与付费链路），但无权要求作者继续提供后台服务。

## 目录

```
plugin/       主插件源码，621 个文件，原样解包自上游 zip
companion/    两个配套插件源码：轮椅浏览器 1.0.1、轮椅遥控器 2.0.0
_originals/   上游安装包 + 由其安装结果打包的两个 zip + 解包/重建脚本
LICENSE       GPL-3.0 全文（上游分发缺这个文件，此处补上）
PROVENANCE.md 来源、SHA256、校验结果、重建说明
```

## 分支

- **`upstream`** —— 只放原样解包的上游内容，不掺任何自己的改动。tag `v6.6.3`。
  将来若再拿到上游包，解到这个分支再打 tag，就能直接 diff 出作者改了什么。
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

主插件带一键安装两个配套插件的功能，会从自己的插件目录读 `browser-pkg.zip` / `satellite-pkg.zip`。这两个文件上游的 zip 分发包里没有，只有 exe 安装包里有，而该 exe 拆不开（Inno Setup 6.7，innoextract 只支持到 6.3.3）。

已通过在 Windows 上实机安装绕过：配套插件源码在 `companion/`，`plugin/` 下的两个 pkg zip 由 `_originals/build-pkgs.py` 重建——

```
python3 _originals/build-pkgs.py
```

| 插件 | 版本 | 说明 |
|---|---|---|
| `companion/轮椅浏览器/` | 1.0.1 | 浏览器面板，PS ≥ 24.0.0 |
| `companion/轮椅遥控器/` | 2.0.0 | 遥控器 / 卫星面板，PS ≥ 26.0.0 |

两者也可以单独用 UDT 加载，不必走主插件的安装流程（那个流程是 Windows 专用的 .bat）。

注意 `plugin/browser-pkg.zip` 和 `plugin/satellite-pkg.zip` 是**重建产物**，不是上游原始字节，详见 `PROVENANCE.md`。
