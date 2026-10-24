# Windows 测试端准备

> 读者：Windows 电脑上的使用者与 Agent。配套文档：`docs/去云化评估.md`。

## 分工

| | Mac | Windows（本文） |
|---|---|---|
| 角色 | 开发：改代码、静态检查 | 实机测试：在 Photoshop 里加载、观察、记录 |
| 改 `plugin/` 代码 | 是 | **否**，只读 |
| git | 在开发分支上提交 | 只 `pull`；测试记录推到 `win-test` 分支 |

Agent 能做：装软件、git、改 hosts、检查网络、整理记录。
**只有人能做**：操作 Photoshop 和 UXP Developer Tool 的界面、看 DevTools、按回归清单逐项点。

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

每轮的回归清单由 Mac 端随代码一起给出。
