# Windows 测试端准备

> 读者：Windows 电脑上的使用者与 Agent。配套文档：`docs/去云化评估.md`。

## 分工

**2026-10-26 起开发和测试都在 Windows 上做**，Mac 端不再改代码。开发任务、规矩和验收标准见 `docs/Windows任务/开发交接.md`；本文只管环境。第 7、8 节是之前「Mac 开发、Windows 测试」时的流程，已经被交接文档取代，留着备查。

Agent 能做：装软件、git、改代码、改 hosts、检查网络、整理记录。
**只有人能做**：操作 Photoshop 和 UXP Developer Tool 的界面、按回归清单逐项点。

## 1. 环境清单

| 软件 | 要求 | 说明 |
|---|---|---|
| Photoshop | **≥ 26.0（2025 版）** | `plugin/manifest.json` 写死了下限 |
| UXP Developer Tool（UDT） | 最新版 | Creative Cloud 桌面端 →「所有应用」里搜 *UXP Developer Tool* 安装 |
| Git for Windows | 任意新版 | 换行不用额外配置，见第 2 步 |
| Python 3 | 3.10+，可选 | 以后跑检查脚本、GRS 验证脚本用 |
| 本地 Forge / ComfyUI | 可选，有 N 卡再装 | 见第 6 步 |

## 2. 拉取仓库

```powershell
git clone https://github.com/peekcat/ps-banana.git
cd ps-banana
git status        # 必须显示 working tree clean
```

仓库的 `.gitattributes` 已经对所有文件关闭了换行转换（`* -text`），不管本机 `core.autocrlf` 怎么设，拿到的字节都和 Mac 一致。**如果 clone 完 `git status` 显示几百个改动，就是出问题了，先停下来报告。**

## 3. 处理已安装的原版插件（重要）

开发版和原版用的是**同一个插件 ID**（`com.xiasanqi.ps.wheelchair.v4`），同时存在会冲突，而且两者共用本地数据。

- 如果这台电脑装过原版「修图轮椅」（exe 安装或 Creative Cloud 安装），先在 PS 菜单「增效工具 → 管理增效工具」或 Creative Cloud 里**停用或卸载**。
- 原版的本地设置和预设要保留的话，先备份插件数据目录（路径可以在原版设置里找，或在 UDT 里加载后点「Open Data Folder」查看）。
- 以后 Mac 这边改了插件 ID，这一步就不需要了。

## 4. 屏蔽作者服务器（模拟停服）

用**管理员** PowerShell 执行：

```powershell
$hosts = "$env:SystemRoot\System32\drivers\etc\hosts"
Add-Content -Path $hosts -Value @"

# ps-banana: 屏蔽原作者后台, 模拟停服
0.0.0.0 xiasanqi.cpolar.top
0.0.0.0 xiasanqiforge.vip.cpolar.cn
0.0.0.0 qwentest.vip.cpolar.top
"@
ipconfig /flushdns
```

验证（三个域名都应解析到 `0.0.0.0`）：

```powershell
Resolve-DnsName xiasanqi.cpolar.top -Type A
Resolve-DnsName xiasanqiforge.vip.cpolar.cn -Type A
Resolve-DnsName qwentest.vip.cpolar.top -Type A
```

**整个测试期间一直保持屏蔽。** 它也是一道保险：就算代码里漏删了什么，也不会真的连到这几个域名（包括被别人接管之后）。

**开了代理软件（Clash / mihomo 等）时 hosts 可能不起作用**：请求走 HTTP 代理时，域名由代理端解析，绕过本机 hosts。这时还要在代理规则里把三个域名设为 `REJECT`，做法和验证见 `docs/Windows任务/开发交接.md` 阶段 0。

## 5. 用 UDT 加载插件

1. Photoshop → 首选项 → 增效工具 → 勾选 **启用开发人员模式**，重启 PS。
2. 打开 UDT → **Add Plugin** → 选 `ps-banana\plugin\manifest.json`。
3. 确认 PS 已经打开，点该插件的 **Load**。PS 里出现插件面板就算成功。
4. 点 **Debug**，会打开 DevTools。之后主要看两个面板：
   - **Console**：报错与插件日志
   - **Network**：每一个网络请求（验收「不连作者服务器」就看这里）
5. Mac 那边更新后：`git pull` → 在 UDT 里点 **Reload**。改了 `manifest.json` 的话要先 Unload 再 Load。

不要用 `plugin\` 下的 `install_*.bat`、`update_plugin.bat`。那是原版的安装和更新脚本，开发期用不上。

## 6. 本地 Forge / ComfyUI（可选）

| | 默认地址 | 注意 |
|---|---|---|
| Forge | `http://127.0.0.1:7860` | 启动参数**必须加 `--api`**，否则插件调不了 `/sdapi/v1/*` |
| ComfyUI | `http://127.0.0.1:8188` | 默认启动即可；插件从你指定的文件夹读取工作流 |

装在别的机器上也可以，在插件里把地址改成局域网 IP 即可。

## 7. 第一项任务：原版停服演习（基线）

**目的**：在代码一行都还没改之前，实机确认「作者停服后原版哪些功能坏、哪些正常」，用来核对 `docs/去云化评估.md`（那份结论是读代码得出的），也作为后续改造的对照基线。

前提：第 4 步屏蔽已生效，`git checkout main` 拉到最新，加载 `plugin/`。

**逐项记录**：结果（正常 / 报错 / 卡住 / 静默无反应）+ Console 报错原文 + Network 里打向被屏蔽域名的请求。

| # | 项目 | 评估文档的预期 |
|---|---|---|
| 1 | 插件启动，面板正常显示 | 正常 |
| 2 | 启动后 30 秒内 Network 里打向被屏蔽域名的请求（全部列出） | 有：会话恢复、公告、AJI 地址列表、Momo 链接等 |
| 3 | 本地预设、布局能加载 | 正常 |
| 4 | 自带 Key 出图（有哪家服务商的 Key 就测哪家）：文生图 + 带选区的图生图 | 正常 |
| 5 | GRS + GPT-Image **带图**生成（有 GRS Key 才测） | **失败**：卡在「上传图床」 |
| 6 | 本地 Forge 生成（有才测） | 正常 |
| 7 | 本地 ComfyUI 生成（有才测） | 正常 |
| 8 | 登录 / 注册 | 失败 |
| 9 | 翻译、提示词优化、海报自动填充 | 失败 |
| 10 | 磁贴：同步、更新、客服、服务器状态、DLSS、Qwen2.1 | 失败或要求登录 |
| 11 | 网络诊断磁贴 | 「夏三七正式服务器」一项失败，其余正常 |

第 4、5 项会产生少量出图费用，没有 Key 的项目直接标「未测」。

**交付**：把记录写成 `docs/实机记录/<日期>-6.6.4-停服基线.md`，推到 `win-test` 分支：

```powershell
git checkout -b win-test        # 以后用 git checkout win-test
# 写好记录文件后
git add docs/实机记录
git commit -m "实机记录: 6.6.4 停服基线"
git push -u origin win-test
```

Mac 那边会读这份记录，有差异的地方再更新评估文档。**不要往 `main` 推，也不要改 `plugin/` 下的文件。**

## 8. 之后每轮的流程

```
Mac 推开发分支 → Windows: git fetch && git checkout <分支> && git pull
→ UDT Reload → 按当轮回归清单测 → 记录推到 win-test → Mac 读记录继续改
```

（已被 `docs/Windows任务/开发交接.md` 取代。）

## 9. 当前测试机（2026-10-24 就绪，2026-10-26 22:57 复核）

完整的就绪报告在 git 历史里（`win-test` 分支提交 `2bcc190`），这里只留后续会用到的信息。

| 项 | 情况 |
|---|---|
| 系统 / 硬件 | Windows 11 LTSC 24H2，i5-12500，32 GB，**无 N 卡**（本地 Forge / ComfyUI 测不了，相关项一律标「未测」） |
| Photoshop | 26.11.6（2025），**破解版**：exe 被改过，hosts 里自带 5925 条 Adobe 域名屏蔽。插件本身的行为不受影响，但凡是依赖 Adobe 账号或云的功能失败，不能算到「作者停服」头上 |
| UDT | 2.3.0.5，加载的是仓库源码 `D:\code\ps-banana\plugin`，改完点 Reload 即生效 |
| 网络 | **2026-10-26 22:57 起不用代理**：系统代理关闭（`ProxyEnable=0`），屏蔽只靠 hosts（第 4 步），验证记录见 `docs/实机记录/2026-10-26-6.6.4-停服基线.md` §7。`127.0.0.1:7892` 现在是 **BoostNet**（配置加密，当前对任何请求都超时）；Clash Verge 的混合端口是 7897，平时不启动。**哪天重新启用代理，要先把 Clash Verge `profiles/Script.js` 的三条 `REJECT` 恢复**（备份 `Script.js.bak-psbanana-20261026-214900`），否则 hosts 会被绕过 |
| Node.js | 24.22.1 LTS，只用来做 `node --check`。装完后已经启动的进程（包括 harness 里的 shell）读不到新 PATH，脚本里请用完整路径 `C:\Program Files\nodejs\node.exe` |
| 原版插件 | 本机从未装过，无 ID 冲突 |
| Creative Cloud | 为装 UDT 装过，已卸载。以后要再装，得临时解除 hosts 里对 `cc-api-data.adobe.io` 的屏蔽 |
| hosts 备份 | `C:\WINDOWS\System32\drivers\etc\hosts.bak-psbanana-20261024-113419` |

日志位置：

| 用途 | 路径 |
|---|---|
| PS 里的插件 console | `%APPDATA%\Adobe\Adobe Photoshop 2025\Logs\UXPLogs_*.log` |
| UDT 日志 | `%APPDATA%\Adobe\Adobe UXP Developer Tool\Logs\appLogs-<日期>.log` |
| 插件数据 | `%APPDATA%\Adobe\UXP\PluginsStorage\PHSP\26\Developer\<插件ID>\PluginData` |

已知噪音（每次加载都会报，不是故障）：`icon_24@1x.png not found`（manifest 声明了 1x 图标但文件缺失）；`Could not find command runSingleCommand in manifest`（`index.js:852` 注册了 manifest 里没声明的命令）；`com.adobe.ccx.start` 版本不兼容（Adobe 自带面板）。前两条是上游遗留问题，改造时顺手修。
