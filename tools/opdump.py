#!/usr/bin/env python3
"""转储 capstone 对 lre.so 指令的 operand 解析结果，确认字段语义。"""
import struct
import sys
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN

SO = r'D:/pk-node/bin/native/lre.so'
TYPES = {0: 'INVALID', 1: 'REG', 2: 'IMM', 3: 'MEM', 4: 'FP', 5: 'CIMM',
         6: 'REG_MRS', 7: 'REG_MSR', 8: 'SYS', 9: 'PREFETCH', 10: 'BARRIER'}


def load():
    data = open(SO, 'rb').read()
    e_phoff = struct.unpack_from('<Q', data, 0x20)[0]
    e_phes = struct.unpack_from('<H', data, 0x36)[0]
    e_phnum = struct.unpack_from('<H', data, 0x38)[0]
    segs = []
    for i in range(e_phnum):
        o = e_phoff + i * e_phes
        t = struct.unpack_from('<I', data, o)[0]
        po, pv, _p, pf, _m, _a = struct.unpack_from('<QQQQQQ', data, o + 8)
        if t == 1:
            segs.append((pv, po, pf))
    return data, segs


def main():
    lo = int(sys.argv[1], 16)
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    data, segs = load()

    def v2o(va):
        for v, o, f in segs:
            if v <= va < v + f:
                return o + (va - v)
        raise ValueError(hex(va))

    md = Cs(CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN)
    md.detail = True
    code = data[v2o(lo):v2o(lo) + n * 4]
    for ins in md.disasm(code, lo):
        parts = []
        for i, op in enumerate(ins.operands):
            d = TYPES.get(op.type, str(op.type))
            if op.type == 1:
                d += ':' + (ins.reg_name(op.reg) or '?')
            elif op.type == 2:
                d += ':0x%x' % op.imm
            elif op.type == 3:
                d += ':base=%s' % (ins.reg_name(op.mem.base) or '-')
                if op.mem.index:
                    d += ',idx=%s' % ins.reg_name(op.mem.index)
                d += ',disp=0x%x' % op.mem.disp
            elif op.type in (6, 7, 8):
                d += ':%s' % (ins.reg_name(op.reg) or '?')
            try:
                if op.shift.type:
                    d += ' shift(t=%d,v=%d)' % (op.shift.type, op.shift.value)
            except Exception:
                pass
            try:
                if getattr(op, 'ext', 0):
                    d += ' ext=%d' % op.ext
            except Exception:
                pass
            try:
                if getattr(op, 'vas', 0):
                    d += ' vas=%d' % op.vas
            except Exception:
                pass
            parts.append(d)
        wb = ' [wb]' if getattr(ins, 'writeback', False) else ''
        print('0x%x  %-9s %-30s %s%s' % (ins.address, ins.mnemonic, ins.op_str, ' | '.join(parts), wb))


if __name__ == '__main__':
    main()
