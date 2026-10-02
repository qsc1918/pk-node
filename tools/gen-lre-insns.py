#!/usr/bin/env python3
"""把 lre.so 里 T 生成函数（及相关内部函数）的指令导出成 JS 数据表。

## 为什么导出而不是在 JS 里解码

项目刻意零依赖，Node 侧没有 arm64 反汇编器；而这段代码需要的指令只有 70 余种。
用 capstone 离线反汇编一次、把「规范化后的操作数」固化成数据，JS 侧只做执行，
既避免手写指令解码器，也保证与逆向结论逐字节一致。

## 规范化（让 JS 执行器尽量简单）

* **post-index 的偏移**：capstone 把 `ldp x29, x30, [sp], #0x50` 的 `#0x50` 放在
  一个**独立的 IMM operand**、且 `mem.disp = 0`。这里合并进 `mem.disp`，并把
  写回类型记为 2，JS 侧不用再解析文本。
* **pre-index**：写回类型记为 1。
* **条件码**：从 mnemonic（`b.eq`）或最后一个操作数（`csel ... , eq`）提取为索引。
* 寄存器名统一（fp→x29、lr→x30），并去掉无用的修饰（全 0 的 shift/ext）。

输出：`src/lre-insns.js`
"""

import json
import struct
import sys
import os

from capstone import Cs, CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN
from capstone.arm64 import ARM64_OP_REG, ARM64_OP_IMM, ARM64_OP_MEM

SO = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'bin', 'native', 'lre.so')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'lre-insns.js')

# 支持命令行指定「输入 so / 输出 js」（签名有两套资产：练习版 lre.so + PK 版 lre_pk.so）。
# 用法：gen-lre-insns.py [so路径] [输出js路径]，省略则用上面的默认值。
if len(sys.argv) > 1:
    SO = sys.argv[1]
if len(sys.argv) > 2:
    OUT = sys.argv[2]

# 导出区间：T 函数本体 + 它 bl 到的内部函数（0x64990 / 0x65614 / 0x65be8 / 0x65dfc / 0x671e0）
BASE = 0x64800
END = 0x67600

ALIAS = {'fp': 'x29', 'lr': 'x30', 'ip0': 'x16', 'ip1': 'x17',
         'wfp': 'w29', 'wlr': 'w30'}

# capstone arm64_extender / arm64_shifter
EXT_SIGNED = {5: 8, 6: 16, 7: 32, 8: 64}      # SXTB/SXTH/SXTW/SXTX
EXT_UNSIGNED = {1: 8, 2: 16, 3: 32, 4: 64}    # UXTB/UXTH/UXTW/UXTX


def load_so():
    data = open(SO, 'rb').read()
    e_phoff = struct.unpack_from('<Q', data, 0x20)[0]
    e_phes = struct.unpack_from('<H', data, 0x36)[0]
    e_phnum = struct.unpack_from('<H', data, 0x38)[0]
    segs = []
    for i in range(e_phnum):
        o = e_phoff + i * e_phes
        if struct.unpack_from('<I', data, o)[0] == 1:
            p_off, p_va, _p, p_fsz, _m, _a = struct.unpack_from('<QQQQQQ', data, o + 8)
            segs.append((p_va, p_off, p_fsz))
    return data, segs


def main():
    data, segs = load_so()

    def v2o(va):
        for v, o, f in segs:
            if v <= va < v + f:
                return o + (va - v)
        raise ValueError(hex(va))

    md = Cs(CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN)
    md.detail = True
    code = data[v2o(BASE):v2o(BASE) + (END - BASE)]

    regs, mnems, conds, sysregs = [], [], [], []
    rmap, mmap, cmap, smap = {}, {}, {}, {}

    def ridx(n):
        n = ALIAS.get(n, n)
        if n not in rmap:
            rmap[n] = len(regs)
            regs.append(n)
        return rmap[n]

    def midx(n):
        if n not in mmap:
            mmap[n] = len(mnems)
            mnems.append(n)
        return mmap[n]

    def cidx(n):
        if n not in cmap:
            cmap[n] = len(conds)
            conds.append(n)
        return cmap[n]

    def sidx(n):
        if n not in smap:
            smap[n] = len(sysregs)
            sysregs.append(n)
        return smap[n]

    insns = []
    decoded = list(md.disasm(code, BASE))
    by_addr = {i.address: i for i in decoded}
    post_index = set()

    for addr in range(BASE, END, 4):
        ins = by_addr.get(addr)
        if ins is None:
            insns.append(None)
            continue
        ops_raw = ins.operands
        txt = ins.op_str
        # ---- 写回类型 ----
        is_post = '],' in txt
        is_pre = txt.rstrip().endswith('!')
        wb = 2 if is_post else (1 if is_pre else 0)
        # post-index 的偏移在独立 IMM operand 里
        post_imm = None
        if is_post:
            for o in ops_raw:
                if o.type == ARM64_OP_IMM:
                    post_imm = o.imm

        ops = []
        for op in ops_raw:
            if op.type == ARM64_OP_REG:
                name = ins.reg_name(op.reg)
                if not name:
                    ops.append(None)
                    continue
                name = ALIAS.get(name, name)
                st = sv = ext = 0
                try:
                    st, sv = op.shift.type, op.shift.value
                except Exception:
                    pass
                try:
                    ext = op.ext or 0
                except Exception:
                    pass
                # 向量寄存器必须带上元素形态（vas）与 lane ——
                # 只看寄存器名无法区分 `v0.2s` 与 `v0.16b`，也读不出 `v0.s[1]` 的 lane
                if name[0] == 'v' or st or sv or ext:
                    vas = getattr(op, 'vas', 0) or 0
                    lane = getattr(op, 'vector_index', -1)
                    lane = -1 if lane is None else lane
                    ops.append([name, st, sv, ext, vas, lane])
                else:
                    ops.append(name)
            elif op.type == ARM64_OP_IMM:
                if is_post and post_imm is not None and op.imm == post_imm:
                    continue          # 已合并进 mem.disp
                # 立即数也可能带移位（`movk w9, #1040, lsl #16`）——
                # 丢掉它会让 movk 写错半字，结果整体偏掉
                ist = isv = 0
                try:
                    ist, isv = op.shift.type, op.shift.value
                except Exception:
                    pass
                if ist and isv:
                    ops.append([op.imm, ist, isv])
                else:
                    ops.append(op.imm)
            elif op.type == ARM64_OP_MEM:
                base = ins.reg_name(op.mem.base) if op.mem.base else None
                index = ins.reg_name(op.mem.index) if op.mem.index else None
                base = ALIAS.get(base, base) if base else None
                index = ALIAS.get(index, index) if index else None
                st = sv = ext = 0
                try:
                    st, sv = op.shift.type, op.shift.value
                except Exception:
                    pass
                try:
                    ext = op.ext or 0
                except Exception:
                    pass
                disp = op.mem.disp
                if is_post and post_imm is not None:
                    disp = post_imm
                ops.append(['m', base, index, disp, st, sv, ext])
            else:
                ops.append(None)

        # ---- 条件码 ----
        cond = -1
        if ins.mnemonic.startswith('b.') and len(ins.mnemonic) == 4:
            cond = cidx(ins.mnemonic[2:])
        elif ins.mnemonic in ('csel', 'csinc', 'csinv', 'csneg', 'cinc', 'cinv', 'cneg', 'cset', 'csetm'):
            tok = txt.split(',')[-1].strip()
            cond = cidx(tok)

        insns.append([midx(ins.mnemonic), cond, wb] + ops)

    # ---- 内存布局 / 重定位（直接固化，省得 JS 侧再解析 ELF 动态表）----
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from lre_emu import Emu, STUB_BASE, STACK_TOP, TLS_BASE, SRET_BUF, T_ENTRY

    emu = Emu(SO)
    segs = [[v, o, f] for (v, o, f, _m) in emu.loads]

    # PLT stub 不在函数区间内，但它只是「读 GOT 再 br」——把 pltAddr → 符号名
    # 固化下来，JS 侧调用到 PLT 地址时直接走外部函数分支。
    plt_map = {}
    scan = 0xD6000
    while scan < 0xD8000:
        ins0 = emu.decode(scan)
        if ins0.mnemonic == 'adrp' and ins0.op_str.split(',')[0].strip() == 'x16':
            ins1 = emu.decode(scan + 4)
            ins3 = emu.decode(scan + 12)
            if ins1.mnemonic == 'ldr' and ins3.mnemonic == 'br':
                try:
                    got = ins1.operands[1].mem.disp + 0xE0000
                    stub = emu.mem.read_u64(got)
                    nm = emu.sym_stubs.get(stub)
                    if nm is not None:
                        plt_map[scan] = nm
                except Exception:
                    pass
        scan += 4
    print('PLT stub 识别到 %d 个' % len(plt_map))
    flat_relocs = []
    for a, v in emu.reloc_writes:
        flat_relocs.append(a)
        flat_relocs.append(v)

    # ---- 输出 ----
    body = json.dumps(insns, separators=(',', ':'))
    js = (
        "'use strict';\n"
        "// 由 tools/gen-lre-insns.py 生成，请勿手改。\n"
        "//\n"
        "// lre.so 中 T 生成函数（及内部函数）的指令表，区间 [" + hex(BASE) + ", " + hex(END) + ")，\n"
        "// 每 4 字节一条，第 i 项对应地址 BASE + i*4。\n"
        "//\n"
        "// 指令项格式：[mnemonicIdx, condIdx, writeback, op0, op1, op2, op3]\n"
        "//   writeback: 0=无, 1=pre-index, 2=post-index（此时 mem 的 disp 已是后置偏移）\n"
        "//   op 编码: 字符串=寄存器 | 数字=立即数 | ['m',base,index,disp,shiftType,shiftValue,ext]=内存 | null\n"
        "//   带修饰的寄存器: [regName, shiftType, shiftValue, ext]\n"
        "module.exports = {\n"
        "  base: 0x%x,\n"
        "  end: 0x%x,\n"
        "  tEntry: 0x%x,\n"
        "  stackTop: 0x%x,\n"
        "  tlsBase: 0x%x,\n"
        "  sretBuf: 0x%x,\n"
        "  stubBase: 0x%x,\n"
        "  // PT_LOAD 段：[虚拟地址, 文件偏移, 文件长度]\n"
        "  segs: %s,\n"
        "  // 重定位写入（扁平 [addr, value, ...]）：RELATIVE 取 addend；\n"
        "  // JUMP_SLOT/GLOB_DAT 写入对应符号的 stub 地址。\n"
        "  relocs: %s,\n"
        "  // 第 i 个 stub 的符号名（stub 地址 = stubBase + i*16）\n"
        "  stubSyms: %s,\n"
        "  // PLT stub 地址 → 符号名（这些地址上没有导出指令，调用到就直接进外部函数）\n"
        "  pltSyms: %s,\n"
        "  mnems: %s,\n"
        "  conds: %s,\n"
        "  insns: %s,\n"
        "};\n"
    ) % (BASE, END, T_ENTRY, STACK_TOP, TLS_BASE, SRET_BUF, STUB_BASE,
         json.dumps(segs, separators=(',', ':')),
         json.dumps(flat_relocs, separators=(',', ':')),
         json.dumps(emu.stub_syms, separators=(',', ':')),
         json.dumps(plt_map, separators=(',', ':')),
         json.dumps(mnems, separators=(',', ':')),
         json.dumps(conds, separators=(',', ':')),
         body)
    open(OUT, 'w', encoding='utf-8').write(js)

    n_ins = sum(1 for x in insns if x)
    print('区间 [0x%x, 0x%x)  指令 %d 条 / 槽位 %d' % (BASE, END, n_ins, len(insns)))
    print('mnemonic %d 种，寄存器 %d 个，条件码 %d 个' % (len(mnems), len(regs), len(conds)))
    print('输出 %s，%.1f KB' % (OUT, len(js) / 1024))


if __name__ == '__main__':
    main()
