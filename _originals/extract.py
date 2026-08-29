#!/usr/bin/env python3
"""
把上游分发包还原成工作目录。

  Xiasanqi-Wheelchair.zip  →  plugin/     主插件, 621 个文件
  Plug-ins.zip             →  companion/  两个配套插件 (轮椅浏览器 / 轮椅遥控器)

这些包有两个坑, 所以不能直接用 unzip:
  1. 文件名是 GBK 字节, 且没有设 UTF-8 标志位。macOS 的 unzip 假定 UTF-8,
     遇到中文名会直接报 Illegal byte sequence 解不出来。
  2. 姊妹包 "6.6.3 for mac.zip" 的路径分隔符全是反斜杠、且没有目录条目,
     在 macOS 上解出来是一堆带反斜杠的平铺文件, 目录结构立不起来。
     所以主插件基线取 Xiasanqi-Wheelchair.zip —— 它路径正常, 且保留了原始 mtime。

两个主插件包的 621 个文件内容逐一 CRC32 相同, 取哪个都不影响内容, 只影响可用性。

用法: python3 _originals/extract.py
"""

import os
import sys
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# (源包, 目标目录, 是否剥掉顶层目录)
#   主插件包所有条目都在 Xiasanqi-Wheelchair/ 下, 要剥掉。
#   配套包顶层就是两个插件文件夹, 各自即为一个插件, 保留。
JOBS = [
    ("Xiasanqi-Wheelchair.zip", "plugin", True),
    ("Plug-ins.zip", "companion", False),
]


def real_name(info):
    """还原真实文件名。

    zipfile 在没有 UTF-8 标志位时会按 cp437 解码原始字节, 这是无损的往返映射,
    所以先 encode('cp437') 拿回原始字节, 再按 GBK 解码即得中文名。
    """
    if info.flag_bits & 0x800:
        return info.filename
    return info.orig_filename.encode("cp437").decode("gbk")


def extract(zip_name, dest_name, strip_top):
    src = os.path.join(HERE, zip_name)
    dst = os.path.join(ROOT, dest_name)
    if not os.path.exists(src):
        sys.exit(f"找不到源包: {src}")

    zf = zipfile.ZipFile(src)
    infos = zf.infolist()

    prefix = ""
    if strip_top:
        tops = {real_name(i).split("/", 1)[0] for i in infos}
        if len(tops) != 1:
            sys.exit(f"{zip_name}: 期待单一顶层目录, 实际有 {sorted(tops)}")
        prefix = tops.pop() + "/"

    files = dirs = chinese = 0
    bad_crc = []
    skipped = []

    for info in infos:
        name = real_name(info)
        if prefix:
            if not name.startswith(prefix):
                skipped.append(name)
                continue
            name = name[len(prefix):]
        if not name:
            continue

        # 防路径穿越: 解出来的路径必须老实待在目标目录里面
        target = os.path.normpath(os.path.join(dst, name))
        if not (target == dst or target.startswith(dst + os.sep)):
            skipped.append(name)
            continue

        if info.is_dir():
            os.makedirs(target, exist_ok=True)
            dirs += 1
            continue

        os.makedirs(os.path.dirname(target), exist_ok=True)
        data = zf.read(info)  # zipfile 内部已按中央目录的 CRC 校验过

        actual = zipfile.crc32(data) & 0xFFFFFFFF
        if actual != info.CRC:
            bad_crc.append((name, hex(info.CRC), hex(actual)))

        with open(target, "wb") as fh:
            fh.write(data)

        # 回写 mtime, 保住上游的时间信息
        mtime = time.mktime(info.date_time + (0, 0, -1))
        os.utime(target, (mtime, mtime))

        files += 1
        if any(b > 127 for b in name.encode("utf-8")):
            chinese += 1

    print(f"{zip_name} → {dest_name}/")
    print(f"  解出文件 {files} 个, 目录 {dirs} 个, 其中中文名 {chinese} 个")

    if skipped:
        print(f"  跳过 {len(skipped)} 条前缀异常/越界条目:")
        for n in skipped[:10]:
            print("    ", n)
    if bad_crc:
        print(f"  CRC 不匹配 {len(bad_crc)} 个:")
        for row in bad_crc[:10]:
            print("    ", row)
        return False

    print("  全部文件 CRC32 校验通过")
    return True


def main():
    ok = True
    for job in JOBS:
        ok = extract(*job) and ok
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
