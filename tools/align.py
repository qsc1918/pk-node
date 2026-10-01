#!/usr/bin/env python3
"""把模拟器输出的数字序列与真机 fixture T 做顺序对齐，定位算错的数字。"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lre_emu import dump_T  # noqa: E402

SO = r'D:/pk-node/bin/native/lre.so'


def fixture_t():
    """从 src/sign.js 里提取权威的 fixture T（避免手抄出错）。"""
    src = open(r'D:/pk-node/src/sign.js', encoding='utf-8').read()
    i = src.index('T:')
    j = src.index('sign:', i)
    seg = src[i:j]
    import re
    parts = re.findall(r"'([0-9]+)'", seg)
    return ''.join(parts)


F = fixture_t()


def main():
    m = int(sys.argv[1]) if len(sys.argv) > 1 else 29839215
    nums, T, _ = dump_T(SO, m * 60)
    print('模拟 M=%d 长度=%d  fixture 长度=%d' % (m, len(T), len(F)))
    pos = 0
    bad = []
    for i, n in enumerate(nums):
        s = str(n)
        idx = F.find(s, pos)
        if idx < 0:
            bad.append(i)
            print('%2d  %-12s  未找到' % (i, s))
            continue
        gap = F[pos:idx]
        flag = '' if idx == pos else '  <-- 偏移 %d，中间是 %r' % (idx - pos, gap)
        print('%2d  %-12s @%-4d%s' % (i, s, idx, flag))
        if idx != pos:
            bad.append(i)
        pos = idx + len(s)
    print('\n剩余未对齐尾部:', repr(F[pos:]))
    print('可疑位置:', bad)


if __name__ == '__main__':
    main()
