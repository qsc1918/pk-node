#!/usr/bin/env python3
"""分析 lre.so 里 T 生成函数（0x657b4）的指令构成与外部调用。"""
import struct
from collections import Counter
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN

SO = r'D:/pk-node/bin/native/lre.so'
START = 0x657b4


def load(path):
    with open(path, 'rb') as f:
        return f.read()


def segs_of(data):
    e_phoff = struct.unpack_from('<Q', data, 0x20)[0]
    e_phentsize = struct.unpack_from('<H', data, 0x36)[0]
    e_phnum = struct.unpack_from('<H', data, 0x38)[0]
    out = []
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        p_type = struct.unpack_from('<I', data, off)[0]
        p_offset, p_vaddr, _p, p_filesz, _m, _a = struct.unpack_from('<QQQQQQ', data, off + 8)
        if p_type == 1:
            out.append((p_vaddr, p_offset, p_filesz))
    return out


def v2o(segs, va):
    for vaddr, off, filesz in segs:
        if vaddr <= va < vaddr + filesz:
            return off + (va - vaddr)
    raise ValueError(hex(va))


def main():
    data = load(SO)
    segs = segs_of(data)
    md = Cs(CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN)
    md.detail = True

    # 先找函数边界：扫描若干字节后遇到 ret 且后面是 int3/padding 的常见形态
    chunk = data[v2o(segs, START):v2o(segs, START) + 0x1400]
    insns = list(md.disasm(chunk, START))

    # 只保留连续到「函数尾声」的部分：遇到 `ret` 且下一条不是有效同函数延续
    mnems = Counter()
    bls = Counter()
    end = None
    for ins in insns:
        mnems[ins.mnemonic] += 1
        if ins.mnemonic in ('bl', 'b') and ins.op_str.startswith('#'):
            bls[ins.op_str] += 1
        if ins.mnemonic == 'ret':
            end = ins.address
    print('指令总数(窗口内):', len(insns))
    print('最后一个 ret @', hex(end) if end else None)
    print('\n顶层指令分布:')
    for m, c in mnems.most_common(40):
        print('  %-12s %d' % (m, c))
    print('\nbl/b 目标（按次数）:')
    for t, c in bls.most_common(40):
        print('  %-12s %d' % (t, c))


if __name__ == '__main__':
    main()
