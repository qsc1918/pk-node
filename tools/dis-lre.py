#!/usr/bin/env python3
"""反汇编 lre.so（aarch64）的指定虚拟地址区间。

用法: python tools/dis-lre.py <vaddr-hex> <insn-count> [--raw]
需要 capstone（装在 workbuddy python venv 里）。
"""
import sys
import struct
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN

SO = r'D:/pk-node/bin/native/lre.so'


def load_segments(path):
    with open(path, 'rb') as f:
        data = f.read()
    assert data[:4] == b'\x7fELF'
    e_phoff = struct.unpack_from('<Q', data, 0x20)[0]
    e_phentsize = struct.unpack_from('<H', data, 0x36)[0]
    e_phnum = struct.unpack_from('<H', data, 0x38)[0]
    segs = []
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        p_type, p_flags = struct.unpack_from('<II', data, off)
        p_offset, p_vaddr, p_paddr, p_filesz, p_memsz, p_align = struct.unpack_from('<QQQQQQ', data, off + 8)
        if p_type == 1:  # PT_LOAD
            segs.append((p_vaddr, p_offset, p_filesz))
    return data, segs


def vaddr_to_off(segs, va):
    for vaddr, off, filesz in segs:
        if vaddr <= va < vaddr + filesz:
            return off + (va - vaddr)
    raise ValueError('vaddr 0x%x 不在任何 PT_LOAD 段内' % va)


def main():
    va = int(sys.argv[1], 16)
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 200
    data, segs = load_segments(SO)
    off = vaddr_to_off(segs, va)
    md = Cs(CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN)
    md.detail = True
    code = data[off:off + n * 4]
    for ins in md.disasm(code, va):
        print('0x%x:\t%s\t%s' % (ins.address, ins.mnemonic, ins.op_str))


if __name__ == '__main__':
    main()
