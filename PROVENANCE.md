# 来源与校验记录

归档日期：2026-08-29

## 保留的包

`_originals/` 下的包原样保存，未做任何修改。

| 文件 | 大小 | 来源 | SHA256 |
|---|---|---|---|
| `轮椅6.6.3_安装程序.exe` | 5,137,900 | **上游原始分发** | `5800aa7404f928f0814f0c9edf0e1e328ed22548775a6b67c35d02eb1eee5373` |
| `Xiasanqi-Wheelchair.zip` | 3,170,646 | 跑完 exe 后从安装结果打包 | `b6455f0a543ed189c3f3a5a56cd6be887ea190a9e9751bc566276e1f792e1e2c` |
| `Plug-ins.zip` | 29,389 | 跑完 exe 后从 `Plug-ins` 目录打包 | `b456ad641691558a29fd036ed9371a9fc1f2207911ecc41b81a6ff0a644b194b` |

**只有 exe 是上游原始分发物**，另外两个 zip 都是本归档的整理者在 Windows 上实际安装之后，从安装结果打包出来的——不是作者发布的形态。这一点决定了下面校验结论的强度。

打包器指纹与此吻合：两个 zip 都是 `create_version=63`、正斜杠路径、带目录条目，同一个工具所打。

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

## 校验结论的强度

`plugin/` 的内容曾同时与两个 zip 逐文件比对通过。但需要说明：**这两个 zip 并非独立来源**，它们都溯源到同一个 `轮椅6.6.3_安装程序.exe`。

所以这次比对证明的是「解包过程无损、两次打包都没损坏文件」，**不是**「两个独立分发物互相印证」。真正的唯一信任根是那个 exe，而它至今拆不开（见下文），因此无法把 `plugin/` 直接回溯校验到上游原始字节。

**基线取 `Xiasanqi-Wheelchair.zip`**，因为它路径结构正常且保留了 180 个真实文件时间戳（Inno Setup 安装时还原的原始时间）。

## 解包方式

macOS 自带 `unzip` 假定文件名是 UTF-8，遇到本包的 GBK 中文名会直接报 `Illegal byte sequence`，163 个中文文件解不出来。因此用 `_originals/extract.py`：按 `cp437 → 原始字节 → gbk` 还原文件名，并回写 zip 中记录的 mtime。

命令行等价做法是 `unzip -O GBK`（Info-ZIP 6.0+），但它不回写精确 mtime，且不做逐文件校验。

## 校验结果

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

## 配套插件

安装出来的主插件目录里**不含**配套插件，但主插件的一键安装流程会从自己的插件目录读它们：

```
tile-browser.host.js:74    pluginFolder.getEntry('browser-pkg.zip')
bootstrap-handlers.js:573  pluginFolder.getEntry('satellite-pkg.zip')
```

是**内置**读取而非运行时下载。但**已确认**：从 `轮椅6.6.3_安装程序.exe` 装出来的插件目录里并没有这两个文件（已在 Windows 上核对安装结果）。

安装程序是把三个插件各装成独立文件夹（`修图轮椅` / `轮椅浏览器` / `轮椅遥控器`），根本不带 pkg zip——这也解释了为什么配套插件能直接从 `Plug-ins` 目录取回。也就是说主插件里那套一键安装配套插件的流程，在 exe 安装场景下是闲置的，大概只服务于纯 zip 分发的安装方式。

**exe 至今拆不开**：Inno Setup 6.7.0 打的，innoextract 最新的 1.10-dev 只支持到 6.3.3。手工解 `zlb\x1a` 压缩块也失败——6.7 改了容器布局，块头的 CRC 与 stored_size 都校验不过。

**已通过实机安装绕过**：在 Windows 上跑完安装程序，从 Photoshop 的 `Plug-ins` 目录取回两个插件文件夹，即 `Plug-ins.zip`，解包到 `companion/`：

| 插件 | id | 版本 | 主插件期待值 |
|---|---|---|---|
| 轮椅浏览器 | `com.xiasanqi.ps.wheelchair.browser` | 1.0.1 | `BROWSER_LATEST_VERSION = '1.0.1'` ✅ |
| 轮椅遥控器 v2 | `com.xiasanqi.ps.wheelchair.v6.satellite` | 2.0.0 | `latestVersion = '2.0.0'` ✅ |

版本与主插件里硬编码的常量吻合，可确认是配套的同一批。安装目标目录名也对得上（`BROWSER_DIR_NAME = '轮椅浏览器'`、`targetDir = pluginsDir + '\轮椅遥控器'`）。

## 重建的文件（非上游原始字节）

`plugin/browser-pkg.zip` 和 `plugin/satellite-pkg.zip` 由 `_originals/build-pkgs.py` 从 `companion/` 重建，**不是**上游的原始字节。

布局依据 `install_browser.bat` / `install_satellite.bat` 的行为：

```powershell
Expand-Archive -Path <pkg.zip> -DestinationPath <PS Plug-ins\轮椅浏览器>
if (-not (Test-Path (Join-Path $d 'manifest.json'))) { 报错 }
```

即 zip 根目录下直接是 `manifest.json` 等文件，不能有包裹目录。脚本构建后会按这条判据自检。

条目时间戳一律写成固定值 `1980-01-01` 而不取文件系统 mtime：git 不保存 mtime，`checkout` 会把它刷成检出时刻，若照抄 mtime 则换台机器 clone 出来重建的 zip 字节就不一样。`Expand-Archive` 不关心这个时间戳，固定它换来跨机器可重复构建。

这两个 zip 在 exe 的安装结果里并不存在（见上），所以它们**补的是 exe 安装场景缺失的部分**，而不是复原上游的某个已知文件。上游若在纯 zip 分发里带过 pkg zip，其确切字节无从得知；这里只保证**解压后的文件内容与实际安装出来的配套插件一致**。
