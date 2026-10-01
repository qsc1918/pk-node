#!/usr/bin/env python3
"""统计 lre.so 目标区间内全部指令的 mnemonic/操作数形态，用于确定模拟器覆盖面。"""
import struct
import sys
from collections import Counter
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN
from capstone.arm64 import ARM64_OP_REG, ARM64_OP_IMM

SO = r'D:/pk-node/bin/native/lre.so'


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
    lo = int(sys.argv[1], 16) if len(sys.argv) > 1 else 0x64900
    hi = int(sys.argv[2], 16) if len(sys.argv) > 2 else 0x67400
    data = load(SO)
    segs = segs_of(data)
    md = Cs(CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN)
    md.detail = True
    chunk = data[v2o(segs, lo):v2o(segs, hi)]
    mn = Counter()
    shapes = Counter()
    for ins in md.disasm(chunk, lo):
        mn[ins.mnemonic] += 1
        # 记录操作数类别形态，便于判断需要实现的变体
        kinds = []
        for op in ins.operands:
            if op.type == ARM64_OP_REG:
                r = ins.reg_name(op.reg) or '?'
                kinds.append('V' if r.startswith('v') or r.startswith('q') or r.startswith('d') or r.startswith('s') else 'R')
            elif op.type == ARM64_OP_IMM:
                kinds.append('I')
            else:
                kinds.append('.')
        shapes['%s %s' % (ins.mnemonic, ''.join(kinds))] += 1
    print('=== mnemonic 分布 ===')
    for m, c in mn.most_common():
        print('  %-14s %d' % (m, c))
    print('\n=== 合计 %d 种 mnemonic ===' % len(mn))
    print('\n=== 操作数形态 ===')
    for s, c in shapes.most_common(120):
        print('  %-24s %d' % (s, c))


if __name__ == '__main__':
    main()
