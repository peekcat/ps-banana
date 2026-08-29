#!/usr/bin/env python3
"""
把 Xiasanqi-Wheelchair.zip 还原成 plugin/ 目录。

这个包有两个坑，所以不能直接用 unzip：
  1. 文件名是 GBK 字节，且没有设 UTF-8 标志位。macOS 的 unzip 假定 UTF-8,
     遇到 163 个中文名会直接报 Illegal byte sequence 解不出来。
  2. 姊妹包 "6.6.3 for mac.zip" 的路径分隔符全是反斜杠、且没有目录条目,
     在 macOS 上解出来是一堆带反斜杠的平铺文件, 目录结构立不起来。
     所以基线取 Xiasanqi-Wheelchair.zip —— 它路径正常, 而且保留了原始 mtime。

两个包的 621 个文件内容逐一 CRC32 相同, 取哪个都不影响内容, 只影响可用性。

用法: python3 _originals/extract.py
"""

import os
import sys
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(HERE, "Xiasanqi-Wheelchair.zip")
DST = os.path.join(ROOT, "plugin")
PREFIX = "Xiasanqi-Wheelchair/"


def real_name(info):
    """还原真实文件名。

    zipfile 在没有 UTF-8 标志位时会按 cp437 解码原始字节, 这是无损的往返映射,
    所以先 encode('cp437') 拿回原始字节, 再按 GBK 解码即得中文名。
    """
    if info.flag_bits & 0x800:
        return info.filename
    return info.orig_filename.encode("cp437").decode("gbk")


def main():
    if not os.path.exists(SRC):
        sys.exit(f"找不到源包: {SRC}")

    zf = zipfile.ZipFile(SRC)
    infos = zf.infolist()

    files = 0
    dirs = 0
    chinese = 0
    bad_crc = []
    outside = []

    for info in infos:
        name = real_name(info)
        if not name.startswith(PREFIX):
            outside.append(name)
            continue
        rel = name[len(PREFIX):]
        if not rel:
            continue

        # 防路径穿越: 解出来的路径必须老实待在 plugin/ 里面
        target = os.path.normpath(os.path.join(DST, rel))
        if not (target == DST or target.startswith(DST + os.sep)):
            outside.append(name)
            continue

        if info.is_dir():
            os.makedirs(target, exist_ok=True)
            dirs += 1
            continue

        os.makedirs(os.path.dirname(target), exist_ok=True)
        data = zf.read(info)  # zipfile 内部已按中央目录的 CRC 校验过

        actual = zipfile.crc32(data) & 0xFFFFFFFF
        if actual != info.CRC:
            bad_crc.append((rel, hex(info.CRC), hex(actual)))

        with open(target, "wb") as fh:
            fh.write(data)

        # 回写 mtime, 保住上游的时间信息 (2022-08-11 ~ 2026-08-29)
        mtime = time.mktime(info.date_time + (0, 0, -1))
        os.utime(target, (mtime, mtime))

        files += 1
        if any(b > 127 for b in rel.encode("utf-8")):
            chinese += 1

    print(f"解出文件 {files} 个, 目录 {dirs} 个, 其中中文名 {chinese} 个")

    if outside:
        print(f"跳过 {len(outside)} 条前缀异常/越界条目:")
        for n in outside[:10]:
            print("  ", n)
    if bad_crc:
        print(f"CRC 不匹配 {len(bad_crc)} 个:")
        for row in bad_crc[:10]:
            print("  ", row)
        sys.exit(1)

    print("全部文件 CRC32 校验通过")


if __name__ == "__main__":
    main()
