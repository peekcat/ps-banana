#!/usr/bin/env python3
"""
把上游分发包还原成工作目录。

  6.6.4.zip      →  plugin/     主插件, 639 个文件 (含真实的两个 pkg zip)
  Plug-ins.zip   →  companion/  两个配套插件 (轮椅浏览器 / 轮椅遥控器)

文件名编码, 两个包情况不同:
  - 6.6.4.zip 打得很规范: 163 个中文名条目全部带 UTF-8 标志位, 无需猜编码,
    macOS 自带 unzip 也能正常解。
  - Plug-ins.zip 是 GBK 字节且没设标志位, macOS 的 unzip 假定 UTF-8, 会直接报
    Illegal byte sequence 解不出来, 必须靠 real_name() 还原。

6.6.4.zip 是作者直接发布的 zip; Plug-ins.zip 则是在 Windows 上跑完
轮椅6.6.3_安装程序.exe 之后从安装结果打包的 —— 因为 6.6.3 的 exe 装出来
不含配套插件包。详见 PROVENANCE.md。

用法:
  python3 _originals/extract.py            # 解包, 并报告目标目录里的多余文件
  python3 _originals/extract.py --clean    # 先清空目标目录再解 (复现校验用)
"""

import os
import shutil
import sys
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# (源包, 目标目录, 是否剥掉顶层目录)
#   6.6.4.zip 没有包裹目录, 文件直接在 zip 根, 不剥。
#   配套包顶层就是两个插件文件夹, 各自即为一个插件, 也不剥。
JOBS = [
    ("6.6.4.zip", "plugin", False),
    ("Plug-ins.zip", "companion", False),
]


def real_name(info):
    """还原真实文件名。

    带 UTF-8 标志位的直接用 filename。否则 zipfile 会按 cp437 解码原始字节,
    那是无损的往返映射, 所以先 encode('cp437') 拿回原始字节, 再按 GBK 解码。
    """
    if info.flag_bits & 0x800:
        return info.filename
    return info.orig_filename.encode("cp437").decode("gbk")


def extract(zip_name, dest_name, strip_top, clean=False):
    src = os.path.join(HERE, zip_name)
    dst = os.path.join(ROOT, dest_name)
    if not os.path.exists(src):
        sys.exit(f"找不到源包: {src}")

    if clean and os.path.isdir(dst):
        # 只允许清理 ROOT 下一层的已知目标目录, 免得参数写错时误删别处
        if os.path.dirname(dst) != ROOT or dest_name not in {j[1] for j in JOBS}:
            sys.exit(f"拒绝清理非预期目录: {dst}")
        shutil.rmtree(dst)

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
    written = set()

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
        written.add(os.path.normpath(target))
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

    # 目标目录里有、zip 里没有的文件。版本升级后的陈旧残留会在这里现形,
    # 否则它们会一直躺在 plugin/ 里冒充上游内容。不自动删, 只报告。
    extra = []
    for root, _, fs in os.walk(dst):
        for f in fs:
            p = os.path.normpath(os.path.join(root, f))
            if p not in written:
                extra.append(os.path.relpath(p, dst))
    if extra:
        print(f"  ⚠ 目标目录有 {len(extra)} 个文件不属于本包 (陈旧残留或本地新增):")
        for n in sorted(extra)[:20]:
            print("    ", n)
        print("    用 --clean 可清空后重解")

    return True


def main():
    clean = "--clean" in sys.argv[1:]
    for arg in sys.argv[1:]:
        if arg != "--clean":
            sys.exit(f"未知参数: {arg}\n用法: extract.py [--clean]")

    ok = True
    for zip_name, dest_name, strip_top in JOBS:
        ok = extract(zip_name, dest_name, strip_top, clean=clean) and ok
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
