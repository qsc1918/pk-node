#!/usr/bin/env python3
"""sign / T 链路回归测试（以真机 fixture 为准）。

## 判据

`src/sign.js` 里保存着一组**真机抓包**的 (T, path, sign) fixture。T 是
`libRequestEncoder.so` 在某个时刻的输出 —— **410 字符、78 个 unsigned 的十进制拼接**。

fixture 里能直接读出几个 `M//k`，足以把 T 对应的分钟 M 唯一锁定：

    M//9  = 3315466   →  M ∈ [29839194, 29839202]
    M//3  = 9946399   →  M ∈ [29839197, 29839199]
    M//5  = 5967839   →  M ∈ [29839195, 29839199]
    ─────────────────────────────────────────
    交集              →  M = 29839199

所以：**在 M = 29839199 处，模拟器输出的 T 必须与 fixture 逐字节相同**。
这是「模拟器是否真的等价于真机」的硬判据。同时用签名公式复算 fixture 的 sign。

用法：python tools/emu-selftest.py
"""

import hashlib
import os
import re
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from lre_emu import dump_T  # noqa: E402

SO = os.path.join(ROOT, 'bin', 'native', 'lre.so')
SIGN_JS = os.path.join(ROOT, 'src', 'sign.js')

# fixture 对应的分钟（由 M//9 / M//3 / M//5 的交集锁定，见模块 docstring）
FIXTURE_M = 29839199
SALT = 'wdi4n2t8edr'


def chain_md5(url_path, T):
    """s = path + salt; …; sign = md5(s + d3 + salt) —— 与 src/sign.js 同式。"""
    def md5(x):
        return hashlib.md5(x.encode('utf-8')).hexdigest()

    s = url_path + SALT
    d1 = md5(s)
    s += d1 + url_path
    d2 = md5(s)
    s += d2 + T
    d3 = md5(s)
    return md5(s + d3 + SALT)


def load_fixture():
    src = open(SIGN_JS, encoding='utf-8').read()
    i = src.index('T:')
    j = src.index('sign:', i)
    T = ''.join(re.findall(r"'([0-9]+)'", src[i:j]))
    m = re.search(r"sign:\s*'([0-9a-f]{32})'", src[j:j + 200])
    p = re.search(r"path:\s*'([^']+)'", src)   # path 在 `T:` 之前
    return T, (m.group(1) if m else None), (p.group(1) if p else None)


def main():
    T_fix, sign_fix, path = load_fixture()
    ok = True

    print('fixture T 长度   = %d' % len(T_fix))
    print('fixture 分钟 M   = %d' % FIXTURE_M)

    nums, T, _emu = dump_T(SO, FIXTURE_M * 60)
    print('模拟数字个数     = %d' % len(nums))
    print('模拟 T 长度      = %d' % len(T))

    if T == T_fix:
        print('✅ T 与真机 fixture 逐字节一致')
    else:
        ok = False
        print('❌ T 不一致')
        for k in range(min(len(T), len(T_fix))):
            if T[k] != T_fix[k]:
                print('   首个差异 @%d: 模拟=%r 真机=%r' % (k, T[k:k + 20], T_fix[k:k + 20]))
                break
        pos = 0
        for idx, n in enumerate(nums):
            L = len(str(n))
            seg = T_fix[pos:pos + L]
            pos += L
            if seg.isdigit() and int(seg) != n:
                print('   数字 #%d: 模拟=%d 真机=%d' % (idx, n, int(seg)))

    if sign_fix and path:
        got = chain_md5(path, T_fix)
        print('chainMd5(fixture) = %s' % got)
        print('fixture sign      = %s' % sign_fix)
        if got != sign_fix:
            ok = False
            print('❌ sign 公式与 fixture 不符')

    print()
    print('结果:', 'PASS' if ok else 'FAIL')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
