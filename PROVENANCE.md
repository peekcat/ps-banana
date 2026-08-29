# 来源与校验记录

归档日期：2026-08-29

## 原始包

三个包原样保存在 `_originals/`，未做任何修改。

| 文件 | 大小 | SHA256 |
|---|---|---|
| `Xiasanqi-Wheelchair.zip` | 3,170,646 | `b6455f0a543ed189c3f3a5a56cd6be887ea190a9e9751bc566276e1f792e1e2c` |
| `6.6.3 for mac.zip` | 3,151,595 | `03d485c8a5cbb45d6054581452a51884a43d04e3a052369f45f4de2a75033b85` |
| `轮椅6.6.3_安装程序.exe` | 5,137,900 | `5800aa7404f928f0814f0c9edf0e1e328ed22548775a6b67c35d02eb1eee5373` |

三者是同一版本 6.6.3 的三种分发形式，不是三个不同的东西。

## 两个 zip 的关系：内容完全相同

621 个文件的 CRC32 作为多重集逐一对应，463 个纯 ASCII 路径的「文件名 + CRC」也完全一致。差别只在打包方式：

| | `Xiasanqi-Wheelchair.zip` | `6.6.3 for mac.zip` |
|---|---|---|
| 顶层目录 | `Xiasanqi-Wheelchair/` | `wheelchair/` |
| 条目数 | 642（621 文件 + 21 目录） | 621（无目录条目） |
| 路径分隔符 | `/` | `\`（全部 621 条） |
| 文件名编码 | GBK 字节，未设 UTF-8 标志位 | UTF-8 字节，163 条中 458 条未设标志位 |
| mtime | 保留原始值（2022-08-11 ~ 2026-08-29） | 全部压平为 2026-08-05 18:54:56 |

**基线取 `Xiasanqi-Wheelchair.zip`**，因为它保留了原始 mtime 且路径结构正常。名字叫 "for mac" 的那个反而是三者里最不适合 macOS 的：全反斜杠路径 + 无目录条目，用系统 `unzip` 解出来是一堆文件名里带反斜杠的平铺文件，目录结构立不起来。

## 解包方式

macOS 自带 `unzip` 假定文件名是 UTF-8，遇到本包的 GBK 中文名会直接报 `Illegal byte sequence`，163 个中文文件解不出来。因此用 `_originals/extract.py`：按 `cp437 → 原始字节 → gbk` 还原文件名，并回写 zip 中记录的 mtime。

命令行等价做法是 `unzip -O GBK`（Info-ZIP 6.0+），但它不回写精确 mtime，且不做逐文件校验。

## 校验结果

```
解出文件 621 个, 目录 20 个, 其中中文名 163 个
全部文件 CRC32 校验通过
```

交叉校验：把解出的 `plugin/` 逐文件与**另一个** zip（`6.6.3 for mac.zip`）比对——

```
mac.zip 条目 621 / 磁盘文件 621
仅 zip 有: 0  仅磁盘有: 0  CRC 不符: 0
```

即 `plugin/` 同时匹配两个独立打包的原始包，可以确信内容无损。

## 已知缺失

`plugin/` **不是完整的安装目录**。插件代码里 `tile-browser.host.js:74` 和 `bootstrap-handlers.js:573` 会从插件目录读取两个配套包：

- `browser-pkg.zip` —— 浏览器面板，`BROWSER_LATEST_VERSION = '1.0.1'`
- `satellite-pkg.zip` —— 卫星面板 / 轮椅遥控器，版本 `2.0.0`

两个 zip 分发包里都没有这两个文件。它们是**内置**的（`pluginFolder.getEntry(...)`）而非运行时下载，所以唯一的副本在 `轮椅6.6.3_安装程序.exe` 里面——exe 5.1MB 比 zip 的 3.1MB 多出的约 2MB 大致就是它们。

**exe 目前拆不开**：它是 Inno Setup 6.7.0 打的，而 innoextract 最新的 1.10-dev 只支持到 6.3.3。手工解 `zlb\x1a` 压缩块也失败——6.7 改了容器布局，块头的 CRC 与 stored_size 都校验不过。

取回这两个包的可行途径，按可靠性排序：

1. 在 Windows 机器（或虚拟机）上跑一遍 `轮椅6.6.3_安装程序.exe`，把装出来的插件目录里的 `browser-pkg.zip` / `satellite-pkg.zip` 拷回来。最稳。
2. 等 innoextract 支持 Inno Setup 6.7 后重拆 exe。
3. 用 `innounp`（Windows 专用的 Inno 解包器，对新版本跟进较快）。

拿到后放进 `plugin/`，在 `upstream` 分支补一次提交并重打 tag。
