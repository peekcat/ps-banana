#!/usr/bin/env python3
"""
用 companion/ 里的源码重建两个内置配套包:

  companion/轮椅浏览器/  →  plugin/browser-pkg.zip
  companion/轮椅遥控器/  →  plugin/satellite-pkg.zip

为什么需要这两个 zip: 主插件的一键安装流程会从自己的插件目录读它们 ——

    tile-browser.host.js:74    pluginFolder.getEntry('browser-pkg.zip')
    bootstrap-handlers.js:573  pluginFolder.getEntry('satellite-pkg.zip')

上游的 zip 分发包里没有这两个文件, 只有 exe 安装包里有, 而那个 exe 拆不开
(Inno Setup 6.7, innoextract 只支持到 6.3.3)。所以这里按安装脚本期待的布局重建。

布局要求来自 install_browser.bat / install_satellite.bat:

    Expand-Archive -Path <pkg.zip> -DestinationPath <PS Plug-ins\轮椅浏览器>
    if (-not (Test-Path (Join-Path $d 'manifest.json'))) { 报错 }

即 zip 根目录下直接就是 manifest.json 等文件, **不能**有一层包裹目录。

注意: 这是重建产物, 不是上游原始字节。上游那两个 zip 的确切内容(压缩参数、
条目顺序、有无额外文件)无从得知, 这里只保证解压后的文件与安装出来的一致。

用法: python3 _originals/build-pkgs.py
"""

import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# (配套插件目录名, 生成的包名)
PKGS = [
    ("轮椅浏览器", "browser-pkg.zip"),
    ("轮椅遥控器", "satellite-pkg.zip"),
]


def build(src_name, pkg_name):
    src = os.path.join(ROOT, "companion", src_name)
    out = os.path.join(ROOT, "plugin", pkg_name)

    if not os.path.isdir(src):
        sys.exit(f"找不到源目录: {src}")
    if not os.path.exists(os.path.join(src, "manifest.json")):
        sys.exit(f"{src} 下没有 manifest.json, 安装脚本会判定安装失败")

    entries = []
    for root, _, files in os.walk(src):
        for f in sorted(files):
            path = os.path.join(root, f)
            entries.append((path, os.path.relpath(path, src)))
    entries.sort(key=lambda x: x[1])

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, rel in entries:
            # 用源文件自己的 mtime, 保证重复构建产物一致
            st = os.stat(path)
            import time
            info = zipfile.ZipInfo(rel, date_time=time.localtime(st.st_mtime)[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(path, "rb") as fh:
                zf.writestr(info, fh.read())

    size = os.path.getsize(out)
    print(f"{src_name}/ → plugin/{pkg_name}  ({len(entries)} 个文件, {size} 字节)")
    for _, rel in entries:
        print(f"    {rel}")
    return out


def verify(pkg_path):
    """按安装脚本的判据检查: 根目录下必须直接有 manifest.json。"""
    with zipfile.ZipFile(pkg_path) as zf:
        names = zf.namelist()
        if "manifest.json" not in names:
            sys.exit(f"{pkg_path}: 根目录缺 manifest.json, 安装会失败")
        nested = [n for n in names if "/" in n]
        if nested:
            sys.exit(f"{pkg_path}: 存在包裹目录 {nested[:3]}, 安装脚本不接受")
        bad = zf.testzip()
        if bad:
            sys.exit(f"{pkg_path}: {bad} 损坏")


def main():
    for src_name, pkg_name in PKGS:
        out = build(src_name, pkg_name)
        verify(out)
    print("两个包均通过布局校验 (根目录直接含 manifest.json, 无包裹目录)")


if __name__ == "__main__":
    main()
