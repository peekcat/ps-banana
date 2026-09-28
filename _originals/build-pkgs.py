#!/usr/bin/env python3
"""
比对 companion/ 的源码与 plugin/ 下两个内置配套包的内容, 必要时重新打包。

  companion/轮椅浏览器/  ↔  plugin/browser-pkg.zip
  companion/轮椅遥控器/  ↔  plugin/satellite-pkg.zip

这两个 zip 是主插件一键安装配套插件时读的 ——

    tile-browser.host.js:74    pluginFolder.getEntry('browser-pkg.zip')
    bootstrap-handlers.js:573  pluginFolder.getEntry('satellite-pkg.zip')

历史: 6.6.3 的 exe 装出来的插件目录里没有这两个文件, 当时本脚本负责按安装脚本
期待的布局重建它们。6.6.4 的 zip 分发**自带了真实的两个包**, 缺口由上游闭合,
而且当初重建的版本与上游真实文件内容逐一 CRC32 相同 —— 重建的判断是对的。

所以本脚本的职责从「生成」改成了「校验」: plugin/ 下现在是上游原始字节,
默认只比对不落盘, 免得把它们换成重建字节(内容相同但字节不同), 那会污染
plugin/ 的逐字节纯净性, 也会让 git status 无故变脏。

只有你改了 companion/ 里的源码、需要让主插件的安装流程带上你的改动时,
才用 --write 真正覆写。

布局要求来自 install_browser.bat / install_satellite.bat:

    Expand-Archive -Path <pkg.zip> -DestinationPath <PS Plug-ins\\轮椅浏览器>
    if (-not (Test-Path (Join-Path $d 'manifest.json'))) { 报错 }

即 zip 根目录下直接就是 manifest.json 等文件, **不能**有一层包裹目录。

--write 时条目时间戳一律写成固定值 FIXED_DATE_TIME 而不取文件系统 mtime ——
git 不保存 mtime, checkout 会把它刷成检出时刻, 若照抄 mtime 则换台机器 clone
出来重建的 zip 字节就不一样了。Expand-Archive 不关心这个时间戳。

用法:
  python3 _originals/build-pkgs.py           # 只比对, 报告是否与 plugin/ 一致
  python3 _originals/build-pkgs.py --write   # 重新打包并覆写 plugin/ 下的两个 zip
"""

import io
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# zip 格式能表示的最早时间, 可重复构建的惯用取值
FIXED_DATE_TIME = (1980, 1, 1, 0, 0, 0)

# (配套插件目录名, 对应的包名)
PKGS = [
    ("轮椅浏览器", "browser-pkg.zip"),
    ("轮椅遥控器", "satellite-pkg.zip"),
]


def collect(src):
    """列出配套插件目录下的文件, 按包内路径排序。"""
    entries = []
    for root, _, files in os.walk(src):
        for f in files:
            path = os.path.join(root, f)
            entries.append((path, os.path.relpath(path, src)))
    entries.sort(key=lambda x: x[1])
    return entries


def pack(entries):
    """按安装脚本期待的布局打成 zip, 返回字节。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, rel in entries:
            info = zipfile.ZipInfo(rel, date_time=FIXED_DATE_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(path, "rb") as fh:
                zf.writestr(info, fh.read())
    return buf.getvalue()


def check_layout(data, label):
    """按安装脚本的判据检查: 根目录下必须直接有 manifest.json, 且无包裹目录。"""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
        if "manifest.json" not in names:
            sys.exit(f"{label}: 根目录缺 manifest.json, 安装会失败")
        nested = [n for n in names if "/" in n]
        if nested:
            sys.exit(f"{label}: 存在包裹目录 {nested[:3]}, 安装脚本不接受")
        bad = zf.testzip()
        if bad:
            sys.exit(f"{label}: {bad} 损坏")


def content_map(data):
    """包内每个条目的 CRC32, 用于只比内容、不比压缩字节。"""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return {i.filename: i.CRC for i in zf.infolist() if not i.is_dir()}


def handle(src_name, pkg_name, write):
    src = os.path.join(ROOT, "companion", src_name)
    out = os.path.join(ROOT, "plugin", pkg_name)

    if not os.path.isdir(src):
        sys.exit(f"找不到源目录: {src}")
    if not os.path.exists(os.path.join(src, "manifest.json")):
        sys.exit(f"{src} 下没有 manifest.json, 安装脚本会判定安装失败")

    entries = collect(src)
    rebuilt = pack(entries)
    check_layout(rebuilt, f"由 {src_name}/ 重建的包")

    if write:
        with open(out, "wb") as fh:
            fh.write(rebuilt)
        print(f"{src_name}/ → plugin/{pkg_name}  已覆写 "
              f"({len(entries)} 个文件, {len(rebuilt)} 字节)")
        return True

    if not os.path.exists(out):
        print(f"{src_name}/  ⚠ plugin/{pkg_name} 不存在, 用 --write 生成")
        return False

    with open(out, "rb") as fh:
        current = fh.read()
    check_layout(current, f"plugin/{pkg_name}")

    mine, theirs = content_map(rebuilt), content_map(current)
    only_src = sorted(set(mine) - set(theirs))
    only_pkg = sorted(set(theirs) - set(mine))
    differ = sorted(k for k in set(mine) & set(theirs) if mine[k] != theirs[k])

    if not (only_src or only_pkg or differ):
        print(f"{src_name}/  ✅ 与 plugin/{pkg_name} 内容一致 ({len(theirs)} 个条目)")
        return True

    print(f"{src_name}/  ❌ 与 plugin/{pkg_name} 不一致:")
    if only_src:
        print(f"    仅 companion/ 有: {only_src}")
    if only_pkg:
        print(f"    仅 pkg 有:        {only_pkg}")
    if differ:
        print(f"    内容不同:          {differ}")
    print("    改动来自 companion/ 的话, 用 --write 重新打包")
    return False


def main():
    write = "--write" in sys.argv[1:]
    for arg in sys.argv[1:]:
        if arg != "--write":
            sys.exit(f"未知参数: {arg}\n用法: build-pkgs.py [--write]")

    ok = True
    for src_name, pkg_name in PKGS:
        ok = handle(src_name, pkg_name, write) and ok

    if not write:
        print("（只比对内容, 未改动任何文件; plugin/ 下是上游原始字节）")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
