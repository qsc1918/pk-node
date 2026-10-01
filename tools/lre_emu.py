#!/usr/bin/env python3
"""lre.so 中 T 生成函数（`JNI_OnLoad+0x2dc8`）的 arm64 用户态模拟器。

## 为什么需要它

主域（`xyks.yuanfudao.com`）业务端点要求 URL 带 32 位 MD5 的 `sign`，否则一律
417 `x-block-by: solar-encoder`。`sign` 的链条里有一段 T：

    s = path + salt
    d1 = md5(s); s += d1 + path
    d2 = md5(s); s += d2 + T
    d3 = md5(s); sign = md5(s + d3 + salt)

T 由 so 里这个函数生成，只依赖 `time()/60`（分钟数 M）。原项目靠 `bin/native/`
下的 arm64 linker64 + dump7 来跑它 —— **Windows/x86 跑不了**，这正是练习链路
417 的根因。本模拟器用纯 Python 复现该函数，从而在任意平台算出 T。

## 关键事实（已由重定位表确证）

* `0xd7390` → `time@LIBC`
* `0xd73a0` → `std::ostream::operator<<(unsigned int)`，在 T 函数里被调用 **78 次**
  ⇒ T = 78 个 unsigned 的十进制拼接（长度实测 410 字符）。
* 其余 PLT 目标是 ostringstream 的构造/析构，语义上无副作用。

所以：只需正确执行「计算 78 个数值」的整数/NEON 代码，把每次 `<<` 的参数记下来。

## 实现要点

* 内存按 4KB 页稀疏分配（栈 / TLS / so 各段分别映射）。
* 应用 `R_AARCH64_RELATIVE` 重定位（base=0），保证 vtable 等指针可用。
* `JUMP_SLOT` / `GLOB_DAT` 重定位指向「假 stub 地址」，执行到该地址即按符号名
  分派外部函数语义。
"""

import struct
import sys
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN
from capstone.arm64 import (ARM64_OP_REG, ARM64_OP_IMM, ARM64_OP_MEM,
                            ARM64_OP_CIMM, ARM64_OP_FP)

PAGE_SHIFT = 12
PAGE_SIZE = 1 << PAGE_SHIFT
PAGE_MASK = PAGE_SIZE - 1

MASK64 = (1 << 64) - 1
MASK128 = (1 << 128) - 1
MASK32 = (1 << 32) - 1

# ---- 假内存布局 ----
STACK_TOP = 0x0200_0000
STACK_SIZE = 0x0004_0000
TLS_BASE = 0x0208_0000
SRET_BUF = 0x0209_0000

# 外部符号 stub 地址空间
STUB_BASE = 0x0F00_0000

# T 生成函数入口（`JNI_OnLoad + 0x2dc8`）
T_ENTRY = 0x657B4


def s64(v):
    v &= MASK64
    return v - (1 << 64) if v >> 63 else v


def s32(v):
    v &= MASK32
    return v - (1 << 32) if v >> 31 else v


class Mem:
    """4KB 页稀疏内存。"""

    def __init__(self):
        self.pages = {}

    def _page(self, addr, create=False):
        key = addr >> PAGE_SHIFT
        pg = self.pages.get(key)
        if pg is None and create:
            pg = bytearray(PAGE_SIZE)
            self.pages[key] = pg
        return pg

    def map(self, addr, data):
        """映射一段数据（可跨页）。"""
        off = 0
        n = len(data)
        while off < n:
            a = addr + off
            pg = self._page(a, True)
            p_off = a & PAGE_MASK
            take = min(PAGE_SIZE - p_off, n - off)
            pg[p_off:p_off + take] = data[off:off + take]
            off += take

    def read(self, addr, size):
        out = bytearray()
        while size > 0:
            pg = self._page(addr)
            if pg is None:
                raise RuntimeError('读未映射内存 0x%x' % addr)
            p_off = addr & PAGE_MASK
            take = min(PAGE_SIZE - p_off, size)
            out += pg[p_off:p_off + take]
            addr += take
            size -= take
        return bytes(out)

    def write(self, addr, data):
        if isinstance(data, int):
            data = data.to_bytes(1, 'little')
        while len(data) > 0:
            pg = self._page(addr, True)
            p_off = addr & PAGE_MASK
            take = min(PAGE_SIZE - p_off, len(data))
            pg[p_off:p_off + take] = data[:take]
            data = data[take:]
            addr += take

    def read_u32(self, addr):
        return struct.unpack('<I', self.read(addr, 4))[0]

    def read_u64(self, addr):
        return struct.unpack('<Q', self.read(addr, 8))[0]

    def write_u32(self, addr, v):
        self.write(addr, struct.pack('<I', v & MASK32))

    def write_u64(self, addr, v):
        self.write(addr, struct.pack('<Q', v & MASK64))


# ---- 向量寄存器形态 ----
VAS_SHAPE = {
    '16b': (8, 16), '8b': (8, 8), '8h': (16, 8), '4h': (16, 4),
    '4s': (32, 4), '2s': (32, 2), '2d': (64, 2), '1d': (64, 1),
    '1q': (128, 1), '16B': (8, 16), '8B': (8, 8),
    '1s': (32, 1), '2h': (16, 2), '1h': (16, 1), '4b': (8, 4), '1b': (8, 1),
}

# capstone 的 arm64_vas 枚举 → (元素字节数, 元素个数)
# ⚠️ 这里是**字节数**，不是位宽；元素位宽 = 字节数 × 8（单位写错会让所有 NEON
#    指令按 8 倍宽度计算，向量高位直接丢失）。
VAS_MAP = {
    1: (1, 16),    # 16B
    2: (1, 8),     # 8B
    3: (1, 4),     # 4B
    4: (1, 1),     # 1B
    5: (2, 8),     # 8H
    6: (2, 4),     # 4H
    7: (2, 2),     # 2H
    8: (2, 1),     # 1H
    9: (4, 4),     # 4S
    10: (4, 2),    # 2S
    11: (4, 1),    # 1S
    12: (8, 2),    # 2D
    13: (8, 1),    # 1D
    14: (16, 1),   # 1Q
}


def shape_of(insn, op):
    """从 capstone operand 取 (寄存器索引, 元素位宽, 元素个数, lane)。

    ⚠️ 形态不能只看 `reg_name` —— `v0.s[1]` 的 reg_name 是 `v0`，元素形态与 lane
    分别落在 `op.vas` 与 `op.vector_index` 里；只按文本解析会把 lane 1 当成 lane 0。
    """
    name = insn.reg_name(op.reg)
    if not name:
        return None
    vas = getattr(op, 'vas', 0) or 0
    lane = getattr(op, 'vector_index', -1)
    lane = None if lane is None or lane < 0 else lane
    if vas and name[0] == 'v':
        esize_bytes, count = VAS_MAP.get(vas, (1, 16))
        return (int(name[1:]), esize_bytes * 8, count, lane)
    sh = parse_vec_reg(name)
    if sh is not None and lane is not None:
        sh = (sh[0], sh[1], sh[2], lane)
    return sh


def parse_vec_reg(text):
    """从形如 `v8.2s` / `q0` / `d0` / `s0` / `v0.s[1]` 的文本解析 (idx, esize, count)。

    @returns (reg_index, esize_bits, count, lane) 或 None
    """
    t = text.strip().lower()
    if not t:
        return None
    lane = None
    if '[' in t:
        head, _, tail = t.partition('[')
        lane_txt = tail.rstrip(']')
        try:
            lane = int(lane_txt)
        except ValueError:
            lane = None
        t = head
    if '.' in t:
        reg, _, shape = t.partition('.')
        if '[' in shape:
            shape = shape.split('[')[0]
        sh = VAS_SHAPE.get(shape)
        if sh is None:
            return None
        esize, count = sh
        idx = int(reg[1:])
        return (idx, esize, count, lane)
    if t[0] == 'v':
        return (int(t[1:]), 128, 1, lane)
    if t[0] == 'q':
        return (int(t[1:]), 128, 1, lane)
    if t[0] == 'd':
        return (int(t[1:]), 64, 1, lane)
    if t[0] == 's':
        return (int(t[1:]), 32, 1, lane)
    if t[0] == 'h':
        return (int(t[1:]), 16, 1, lane)
    if t[0] == 'b':
        return (int(t[1:]), 8, 1, lane)
    return None


class Emu:
    def __init__(self, so_path, verbose=False):
        self.so = open(so_path, 'rb').read()
        self.verbose = verbose
        self.mem = Mem()
        self.md = Cs(CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN)
        self.md.detail = True
        self.decode_cache = {}
        self.x = [0] * 32          # x0..x30, 31 只用于 sp 语义外的临时
        self.sp = STACK_TOP
        self.v = [0] * 32
        self.nzcv = 0
        self.pc = 0
        self.calls = []            # 记录 appends
        self.sym_stubs = {}
        self.out_u32 = []
        self.time_value = 0
        self.steps = 0
        self.heap_ptr = 0x0300_0000
        self.unknown = set()
        self.reloc_writes = []      # [[addr, value]] —— 供导出器固化到 JS 数据
        self.stub_syms = []         # 第 i 项 = stub 地址 STUB_BASE + i*16 对应的符号名
        self._load_elf()
        self.mem.write(TLS_BASE + 0x28, struct.pack('<Q', 0xDEADBEEF))

    # ------------------------------------------------------------ ELF 加载
    def _load_elf(self):
        data = self.so
        e_phoff = struct.unpack_from('<Q', data, 0x20)[0]
        e_phes = struct.unpack_from('<H', data, 0x36)[0]
        e_phnum = struct.unpack_from('<H', data, 0x38)[0]
        self.loads = []
        for i in range(e_phnum):
            o = e_phoff + i * e_phes
            p_type = struct.unpack_from('<I', data, o)[0]
            p_offset, p_vaddr, _p, p_filesz, p_memsz, _a = struct.unpack_from('<QQQQQQ', data, o + 8)
            if p_type == 1:
                self.loads.append((p_vaddr, p_offset, p_filesz, p_memsz))
                self.mem.map(p_vaddr, data[p_offset:p_offset + p_filesz])
        self._apply_relocs()

    def _sections(self):
        data = self.so
        e_shoff = struct.unpack_from('<Q', data, 0x28)[0]
        e_shentsize = struct.unpack_from('<H', data, 0x3A)[0]
        e_shnum = struct.unpack_from('<H', data, 0x3C)[0]
        e_shstrndx = struct.unpack_from('<H', data, 0x3E)[0]
        secs = []
        for i in range(e_shnum):
            o = e_shoff + i * e_shentsize
            name, typ, flags, addr, off, size, link, info, align, entsize = struct.unpack_from('<IIQQQQIIQQ', data, o)
            secs.append(dict(name=name, type=typ, addr=addr, off=off, size=size, link=link, info=info, entsize=entsize))
        strtab_off = secs[e_shstrndx]['off']
        for s in secs:
            end = data.index(b'\0', strtab_off + s['name'])
            s['sname'] = data[strtab_off + s['name']:end].decode('latin1')
        return secs

    def _apply_relocs(self):
        data = self.so
        secs = self._sections()
        dynsym = next((s for s in secs if s['type'] == 11), None)   # SHT_DYNSYM
        dynstr = secs[dynsym['link']] if dynsym else None
        syms = []
        if dynsym:
            for i in range(dynsym['size'] // 24):
                o = dynsym['off'] + i * 24
                name, info, other, shndx, value, size = struct.unpack_from('<IBBHQQ', data, o)
                end = data.index(b'\0', dynstr['off'] + name) if name else dynstr['off']
                nm = data[dynstr['off'] + name:end].decode('latin1') if name else ''
                syms.append(nm)

        stub_idx = 0
        for s in secs:
            if s['type'] not in (4, 9):      # RELA
                continue
            for i in range(s['size'] // 24):
                o = s['off'] + i * 24
                r_offset, r_info, r_addend = struct.unpack_from('<QQq', data, o)
                r_type = r_info & 0xFFFFFFFF
                r_sym = r_info >> 32
                if r_type == 1027:            # R_AARCH64_RELATIVE
                    self.mem.write_u64(r_offset, r_addend)
                    self.reloc_writes.append([r_offset, r_addend])
                elif r_type in (1025, 1026):  # JUMP_SLOT / GLOB_DAT
                    nm = syms[r_sym] if r_sym < len(syms) else ''
                    stub = STUB_BASE + stub_idx * 16
                    stub_idx += 1
                    self.sym_stubs[stub] = nm
                    self.mem.write_u64(r_offset, stub)
                    self.reloc_writes.append([r_offset, stub])
                    self.stub_syms.append(nm)

    # ------------------------------------------------------------ 解码
    def decode(self, pc):
        insn = self.decode_cache.get(pc)
        if insn is None:
            code = self.mem.read(pc, 4)
            gen = self.md.disasm(code, pc)
            insn = next(gen, None)
            if insn is None:
                raise RuntimeError('无法解码 0x%x' % pc)
            self.decode_cache[pc] = insn
        return insn

    # ------------------------------------------------------------ 寄存器
    REG_ALIAS = {'fp': 'x29', 'lr': 'x30', 'ip0': 'x16', 'ip1': 'x17',
                 'wfp': 'w29', 'wlr': 'w30'}

    def _norm(self, name):
        return self.REG_ALIAS.get(name, name)

    def get_reg(self, name):
        name = self._norm(name)
        if name in ('xzr', 'wzr'):
            return 0
        if name in ('sp', 'wsp'):
            return self.sp & (MASK32 if name == 'wsp' else MASK64)
        if name[0] == 'w':
            return self.x[int(name[1:])] & MASK32
        if name[0] == 'x':
            return self.x[int(name[1:])] & MASK64
        raise RuntimeError('不支持读寄存器 %s' % name)

    def set_reg(self, name, val):
        name = self._norm(name)
        if name in ('xzr', 'wzr'):
            return
        if name in ('sp', 'wsp'):
            self.sp = val & MASK64
            return
        if name[0] == 'w':
            self.x[int(name[1:])] = val & MASK32
            return
        if name[0] == 'x':
            self.x[int(name[1:])] = val & MASK64
            return
        raise RuntimeError('不支持写寄存器 %s' % name)

    # ------------------------------------------------------------ flags
    def set_flags_sub(self, a, b, is64=True):
        w = 64 if is64 else 32
        mask = MASK64 if is64 else MASK32
        res = (a - b) & mask
        sa, sb, sr = self._sgn(a, w), self._sgn(b, w), self._sgn(res, w)
        n = 1 if (res >> (w - 1)) & 1 else 0
        z = 1 if res == 0 else 0
        c = 1 if (a & mask) >= (b & mask) else 0
        v = 1 if ((sa ^ sb) & (sa ^ sr)) < 0 else 0
        self.nzcv = (n << 3) | (z << 2) | (c << 1) | v
        return res

    def set_flags_add(self, a, b, carry=0, is64=True):
        w = 64 if is64 else 32
        mask = MASK64 if is64 else MASK32
        res = (a + b + carry) & mask
        sa, sb, sr = self._sgn(a, w), self._sgn(b, w), self._sgn(res, w)
        n = 1 if (res >> (w - 1)) & 1 else 0
        z = 1 if res == 0 else 0
        c = 1 if (a & mask) + (b & mask) + carry > mask else 0
        v = 1 if ((sa ^ sr) & (sb ^ sr)) < 0 else 0
        self.nzcv = (n << 3) | (z << 2) | (c << 1) | v
        return res

    @staticmethod
    def _sgn(v, w):
        v &= (1 << w) - 1
        return v - (1 << w) if v >> (w - 1) else v

    def test_flags(self, cc):
        n = (self.nzcv >> 3) & 1
        z = (self.nzcv >> 2) & 1
        c = (self.nzcv >> 1) & 1
        v = self.nzcv & 1
        return {
            'eq': z == 1, 'ne': z == 0,
            'hs': c == 1, 'cs': c == 1, 'lo': c == 0, 'cc': c == 0,
            'mi': n == 1, 'pl': n == 0,
            'vs': v == 1, 'vc': v == 0,
            'hi': (c == 1 and z == 0), 'ls': (c == 0 or z == 1),
            'ge': n == v, 'lt': n != v,
            'gt': (z == 0 and n == v), 'le': (z == 1 or n != v),
            'al': True, 'nv': True,
        }[cc]

    # ------------------------------------------------------------ 执行
    def run(self, start, max_steps=4_000_000):
        from collections import deque
        self.history = deque(maxlen=120)
        self.pc = start
        try:
            return self._run_loop(max_steps)
        except Exception:
            print('--- 出错前轨迹（末尾 25 条）---')
            for h in list(self.history)[-25:]:
                print('  ' + h)
            raise

    def _run_loop(self, max_steps):
        while True:
            self.steps += 1
            if self.steps > max_steps:
                raise RuntimeError('步数超限（疑似死循环）pc=0x%x' % self.pc)
            if self.pc in self.sym_stubs:
                if self._call_extern(self.sym_stubs[self.pc]):
                    return self.pc        # 特殊：extern 指示结束
                continue
            insn = self.decode(self.pc)
            self.history.append('0x%x  %-9s %s' % (insn.address, insn.mnemonic, insn.op_str))
            if self.verbose:
                print('0x%x  %-9s %s' % (insn.address, insn.mnemonic, insn.op_str))
            nxt = self.pc + 4
            self._exec(insn)
            if self.pc == insn.address:   # 指令内部未改 pc
                self.pc = nxt
            elif self.pc is None:
                self.pc = nxt

    def _branch(self, addr):
        self.pc = addr

    def _exec(self, insn):
        m = insn.mnemonic
        ops = insn.operands
        # 目标为向量寄存器时走 NEON 通道（add/sub/and/orr/eor/bic/mvn 与标量同名）
        if ops and ops[0].type == ARM64_OP_REG:
            dstn = insn.reg_name(ops[0].reg) or ''
            if dstn[:1] == 'v':
                if m in ('add', 'sub'):
                    return self._vec_arith(insn, ops, (lambda a, b: a + b) if m == 'add' else (lambda a, b: a - b))
                if m == 'and':
                    return self._vec_logic(insn, ops, lambda a, b: a & b)
                if m == 'orr':
                    return self._vec_logic(insn, ops, lambda a, b: a | b)
                if m == 'eor':
                    return self._vec_logic(insn, ops, lambda a, b: a ^ b)
                if m == 'bic':
                    return self._vec_logic(insn, ops, lambda a, b: a & ~b)
                if m == 'orn':
                    return self._vec_logic(insn, ops, lambda a, b: a | ~b)
                if m == 'mvn':
                    return self.op_mvn_v(insn, ops)
                if m == 'ushr':
                    return self.op_ushr(insn, ops)
                if m == 'shr':
                    return self.op_shr(insn, ops)
                if m == 'shl':
                    return self.op_shl_vec(insn, ops)
                if m == 'ushl':
                    return self.op_ushl(insn, ops)
        if m.startswith('b.') and ops and ops[0].type == ARM64_OP_IMM:
            return self._cond_branch(insn, ops, m[2:])
        handler = getattr(self, 'op_' + m.replace('.', '_'), None)
        if handler is None:
            raise RuntimeError('未实现指令 %s %s @0x%x' % (m, insn.op_str, insn.address))
        handler(insn, ops)

    # ---- 分支 ----
    def op_b(self, insn, ops):
        self._branch(ops[0].imm)

    def op_ret(self, insn, ops):
        self._branch(self.x[30])

    def op_bl(self, insn, ops):
        self.x[30] = insn.address + 4
        self._branch(ops[0].imm)

    def op_br(self, insn, ops):
        self._branch(self.get_reg(insn.reg_name(ops[0].reg)))

    def op_blr(self, insn, ops):
        self.x[30] = insn.address + 4
        self._branch(self.get_reg(insn.reg_name(ops[0].reg)))

    def _cond_branch(self, insn, ops, cc):
        if self.test_flags(cc):
            self._branch(ops[0].imm)

    def op_cbz(self, insn, ops):
        if self.get_reg(insn.reg_name(ops[0].reg)) == 0:
            self._branch(ops[1].imm)

    def op_cbnz(self, insn, ops):
        if self.get_reg(insn.reg_name(ops[0].reg)) != 0:
            self._branch(ops[1].imm)

    def op_tbz(self, insn, ops):
        val = self.get_reg(insn.reg_name(ops[0].reg))
        if (val >> ops[1].imm) & 1 == 0:
            self._branch(ops[2].imm)

    def op_tbnz(self, insn, ops):
        val = self.get_reg(insn.reg_name(ops[0].reg))
        if (val >> ops[1].imm) & 1 == 1:
            self._branch(ops[2].imm)

    # ---- 内存 ----
    def _mem_addr(self, insn, op, is64=True):
        """计算内存操作数地址，并处理 pre / post-index 的基寄存器写回。

        ⚠️ capstone 对 **post-index**（`ldp x29, x30, [sp], #0x50`）会给
        `mem.disp = 0`，把偏移放在**末尾一个独立的 IMM operand** 里。只读
        `mem.disp` 会让基寄存器「回写等于原值」—— 表现为函数返回后 sp 少了一截，
        之后所有 [sp+imm] 读写全部错位（实测就是这个 bug 让第 5 个数字算错）。
        """
        base_name = insn.reg_name(op.mem.base) if op.mem.base else None
        base = self.get_reg(base_name) if base_name else 0
        idx = 0
        if op.mem.index:
            iname = insn.reg_name(op.mem.index)
            idx = self.get_reg(iname)
            # 寄存器偏移可以带扩展 + 移位：`ldr w8, [x22, w8, uxtw #2]`
            # （capstone 把 ext/shift 挂在这个 MEM operand 上，只看 index 会漏掉）
            ext = getattr(op, 'ext', 0) or 0
            if ext:
                idx = self._extend(idx, iname, ext)
            try:
                st, sv = op.shift.type, op.shift.value
            except Exception:
                st, sv = 0, 0
            if st == 1 and sv:      # LSL
                idx = (idx << sv) & MASK64
        disp = op.mem.disp
        txt = insn.op_str

        if '],' in txt:           # post-index
            off = disp
            for o in insn.operands:
                if o.type == ARM64_OP_IMM and o is not op:
                    off = o.imm
            addr = base + idx
            if base_name:
                self.set_reg(base_name, (base + idx + off) & MASK64)
            return addr & MASK64

        addr = base + idx + disp
        if txt.rstrip().endswith('!') and base_name:   # pre-index
            self.set_reg(base_name, addr & MASK64)
        return addr & MASK64

    def op_ldr(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        op = ops[1]
        if op.type != ARM64_OP_MEM:
            return
        addr = self._mem_addr(insn, op)
        if dst[0] == 'w':
            self.set_reg(dst, self.mem.read_u32(addr))
        elif dst[0] == 'x':
            self.set_reg(dst, self.mem.read_u64(addr))
        elif dst[0] == 's':
            self.set_vec_lane_from_bytes(dst, self.mem.read(addr, 4))
        elif dst[0] == 'd':
            self.set_vec_lane_from_bytes(dst, self.mem.read(addr, 8))
        elif dst[0] == 'q':
            self.set_vec_lane_from_bytes(dst, self.mem.read(addr, 16))
        else:
            raise RuntimeError('ldr 目标未支持 %s' % dst)

    def op_ldur(self, insn, ops):
        self.op_ldr(insn, ops)

    def op_ldrb(self, insn, ops):
        addr = self._mem_addr(insn, ops[1])
        self.set_reg(insn.reg_name(ops[0].reg), self.mem.read(addr, 1)[0])

    def op_ldurb(self, insn, ops):
        self.op_ldrb(insn, ops)

    def op_ldrh(self, insn, ops):
        addr = self._mem_addr(insn, ops[1])
        self.set_reg(insn.reg_name(ops[0].reg), struct.unpack('<H', self.mem.read(addr, 2))[0])

    def op_str(self, insn, ops):
        src = insn.reg_name(ops[0].reg)
        addr = self._mem_addr(insn, ops[1])
        self._store(src, addr)

    def op_stur(self, insn, ops):
        self.op_str(insn, ops)

    def op_strb(self, insn, ops):
        src = insn.reg_name(ops[0].reg)
        addr = self._mem_addr(insn, ops[1])
        v = self.get_reg(src)
        self.mem.write(addr, struct.pack('<B', v & 0xFF))

    def op_sturb(self, insn, ops):
        self.op_strb(insn, ops)

    def op_strh(self, insn, ops):
        src = insn.reg_name(ops[0].reg)
        addr = self._mem_addr(insn, ops[1])
        self.mem.write(addr, struct.pack('<H', self.get_reg(src) & 0xFFFF))

    def _store(self, reg, addr):
        reg = self._norm(reg)
        if reg[0] == 'w':
            self.mem.write_u32(addr, self.get_reg(reg))
        elif reg[0] == 'x':
            self.mem.write_u64(addr, self.get_reg(reg))
        elif reg[0] == 'b':
            self.mem.write(addr, bytes([self.get_reg(reg) & 0xFF]))
        elif reg[0] == 'h':
            self.mem.write(addr, struct.pack('<H', self.get_reg(reg) & 0xFFFF))
        elif reg[0] == 's':
            self.mem.write(addr, self.vec_bytes(reg, 4))
        elif reg[0] == 'd':
            self.mem.write(addr, self.vec_bytes(reg, 8))
        elif reg[0] == 'q':
            self.mem.write(addr, self.vec_bytes(reg, 16))
        else:
            raise RuntimeError('str 源未支持 %s' % reg)

    @staticmethod
    def _reg_size(name):
        """寄存器字节宽度 —— stp/ldp 的两个元素间隔**等于寄存器宽度**。

        ⚠️ 固定用 8 会让 `stp w9, w10, [sp, #0xd8]` 把 w10 写到 +8 而不是 +4，
        `ldr w9, [sp, #0xdc]` 就永远读到 0（实测就是这个 bug 让第 5 个数字算错）。
        """
        n = Emu.REG_ALIAS.get(name, name)
        return {'w': 4, 'x': 8, 's': 4, 'd': 8, 'q': 16, 'h': 2, 'b': 1}.get(n[0], 8)

    def op_stp(self, insn, ops):
        addr = self._mem_addr(insn, ops[2])
        r0 = insn.reg_name(ops[0].reg)
        r1 = insn.reg_name(ops[1].reg)
        self._store(r0, addr)
        self._store(r1, addr + self._reg_size(r0))

    def op_ldp(self, insn, ops):
        addr = self._mem_addr(insn, ops[2])
        r0 = insn.reg_name(ops[0].reg)
        r1 = insn.reg_name(ops[1].reg)
        self._load_into(r0, addr)
        self._load_into(r1, addr + self._reg_size(r0))

    def _load_into(self, reg, addr):
        reg = self._norm(reg)
        if reg[0] == 'w':
            self.set_reg(reg, self.mem.read_u32(addr))
        elif reg[0] == 'x':
            self.set_reg(reg, self.mem.read_u64(addr))
        elif reg[0] in 'dh':
            self.set_vec_lane_from_bytes(reg, self.mem.read(addr, 8 if reg[0] == 'd' else 2))
        elif reg[0] == 's':
            self.set_vec_lane_from_bytes(reg, self.mem.read(addr, 4))
        elif reg[0] == 'q':
            self.set_vec_lane_from_bytes(reg, self.mem.read(addr, 16))
        else:
            raise RuntimeError('ldp 目标未支持 %s' % reg)

    def op_ld4(self, insn, ops):
        # ld4 {v0.4s, v1.4s, v2.4s, v3.4s}, [x]
        mem_op = ops[-1]
        addr = self._mem_addr(insn, mem_op)
        regs = [insn.reg_name(o.reg) for o in ops[:-1]]
        shapes = [shape_of(insn, o) for o in ops[:-1]]
        esize = shapes[0][1]
        count = shapes[0][2]
        nbytes = esize // 8
        for i in range(count):
            for j, r in enumerate(regs):
                chunk = self.mem.read(addr + (i * 4 + j) * nbytes, nbytes)
                self.set_vec_elem(r, i, esize, int.from_bytes(chunk, 'little'))

    # ---- 向量存取辅助 ----
    def vec_bytes(self, reg, n):
        vidx = self._vidx(reg)
        val = self.v[vidx]
        return val.to_bytes(16, 'little')[:n]

    def set_vec_lane_from_bytes(self, reg, data):
        vidx = self._vidx(reg)
        val = int.from_bytes(data, 'little')
        self._setv(vidx, val & MASK64 if len(data) == 8 else (val & ((1 << (len(data) * 8)) - 1)))

    def set_vec_elem(self, reg, lane, esize, value):
        vidx = self._vidx(reg)
        mask = (1 << esize) - 1
        cur = self.v[vidx]
        shift = lane * esize
        cur = (cur & ~(mask << shift)) | ((value & mask) << shift)
        self._setv(vidx, cur)

    @staticmethod
    def _vidx(reg):
        return int(reg[1:])

    def _setv(self, idx, val):
        self.v[idx] = val & MASK128

    def _regv(self, name):
        """读寄存器（整数）。"""
        return self.get_reg(name)

    # ---- 算术/逻辑 ----
    def _shifted(self, insn, ops, idx):
        """返回 (value, is64)，应用第三操作数的 shift/extend。"""
        op = ops[idx]
        name = insn.reg_name(op.reg)
        val = self.get_reg(name)
        is64 = name[0] == 'x'
        shift_t = 0
        shift_v = 0
        try:
            shift_t = op.shift.type
            shift_v = op.shift.value
        except Exception:
            pass
        ext = 0
        try:
            ext = op.ext
        except Exception:
            ext = 0
        # ⚠️ capstone 的 arm64_shifter 枚举：1=LSL, 2=MSL, 3=LSR, 4=ASR, 5=ROR
        #    （不是「1=LSL, 2=ASR, 3=LSR, 4=ROR」—— 弄错会把 ASR 当成 ROR）
        if ext:
            val = self._extend(val, name, ext)
            is64 = True
        elif shift_t == 3:      # LSR
            val = (val & (MASK64 if is64 else MASK32)) >> shift_v
        elif shift_t == 4:      # ASR
            val = self._sgn(val, 64 if is64 else 32) >> shift_v
            val &= MASK64 if is64 else MASK32
        elif shift_t == 1:      # LSL
            val = (val << shift_v) & (MASK64 if is64 else MASK32)
        elif shift_t == 5:      # ROR
            w = 64 if is64 else 32
            m = MASK64 if is64 else MASK32
            val = ((val >> shift_v) | (val << (w - shift_v))) & m
        return val, is64

    def _extend(self, val, name, ext):
        w = 32 if name[0] == 'w' else 64
        bits = {'sxtb': 8, 'sxth': 16, 'sxtw': 32, 'uxtb': 8, 'uxth': 16, 'uxtw': 32}
        signed = ext in (1, 2, 3)   # capstone: SXTB=1? 用字符串兜底
        # capstone arm64_extender: UXTB=1,UXTH=2,UXTW=3,UXTX=4,SXTB=5,SXTH=6,SXTW=7,SXTX=8
        table = {1: (8, False), 2: (16, False), 3: (32, False), 4: (64, False),
                 5: (8, True), 6: (16, True), 7: (32, True), 8: (64, True)}
        bits, signed = table.get(ext, (32, False))
        m = (1 << bits) - 1
        v = val & m
        if signed and (v >> (bits - 1)) & 1:
            v -= (1 << bits)
        return v & MASK64

    def op_add(self, insn, ops):
        self._arith(insn, ops, '+')

    def op_sub(self, insn, ops):
        self._arith(insn, ops, '-')

    def op_adds(self, insn, ops):
        self._arith(insn, ops, '+', flags=True)

    def op_subs(self, insn, ops):
        self._arith(insn, ops, '-', flags=True)

    def _arith(self, insn, ops, kind, flags=False):
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        a = self.get_reg(insn.reg_name(ops[1].reg))
        if ops[2].type == ARM64_OP_IMM:
            b = ops[2].imm
            sh = 0
            try:
                sh = ops[2].shift.value if ops[2].shift.type else 0
            except Exception:
                sh = 0
            if sh:
                b <<= sh
            is64 = dst[0] == 'x'
        else:
            b, _ = self._shifted(insn, ops, 2)
        mask = MASK64 if is64 else MASK32
        if kind == '+':
            res = self.set_flags_add(a, b, 0, is64) if flags else (a + b) & mask
        else:
            res = self.set_flags_sub(a, b, is64) if flags else (a - b) & mask
        self.set_reg(dst, res)

    def op_cmp(self, insn, ops):
        a = self.get_reg(insn.reg_name(ops[0].reg))
        is64 = insn.reg_name(ops[0].reg)[0] == 'x'
        if ops[1].type == ARM64_OP_IMM:
            b = ops[1].imm
        else:
            b, _ = self._shifted(insn, ops, 1)
        self.set_flags_sub(a, b, is64)

    def op_cmn(self, insn, ops):
        a = self.get_reg(insn.reg_name(ops[0].reg))
        is64 = insn.reg_name(ops[0].reg)[0] == 'x'
        if ops[1].type == ARM64_OP_IMM:
            b = ops[1].imm
        else:
            b, _ = self._shifted(insn, ops, 1)
        self.set_flags_add(a, b, 0, is64)

    def op_tst(self, insn, ops):
        a = self.get_reg(insn.reg_name(ops[0].reg))
        is64 = insn.reg_name(ops[0].reg)[0] == 'x'
        if ops[1].type == ARM64_OP_IMM:
            b = ops[1].imm
        else:
            b, _ = self._shifted(insn, ops, 1)
        mask = MASK64 if is64 else MASK32
        res = (a & b) & mask
        self.set_flags_logic(res, is64)

    def set_flags_logic(self, res, is64):
        w = 64 if is64 else 32
        n = 1 if (res >> (w - 1)) & 1 else 0
        z = 1 if res == 0 else 0
        self.nzcv = (n << 3) | (z << 2) | 0

    def _logic(self, insn, ops, fn, flags=False):
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        a = self.get_reg(insn.reg_name(ops[1].reg))
        if ops[2].type == ARM64_OP_IMM:
            b = ops[2].imm
            mask = MASK64 if is64 else MASK32
            b &= mask
        else:
            b, _ = self._shifted(insn, ops, 2)
        mask = MASK64 if is64 else MASK32
        res = fn(a & mask, b & mask) & mask
        # ANDS/ORRS/... 是「运算 + 置标志」，**结果同样要写回目标寄存器**
        # （只置标志会把 `ands w19, w26, #0xffff` 的目标寄存器留成旧值）
        self.set_reg(dst, res)
        if flags:
            self.set_flags_logic(res, is64)

    def op_and(self, insn, ops):
        self._logic(insn, ops, lambda a, b: a & b)

    def op_ands(self, insn, ops):
        self._logic(insn, ops, lambda a, b: a & b, flags=True)

    def op_orr(self, insn, ops):
        self._logic(insn, ops, lambda a, b: a | b)

    def op_eor(self, insn, ops):
        self._logic(insn, ops, lambda a, b: a ^ b)

    def op_shl_vec(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        _i, esize, count, _l = shape_of(insn, ops[0])
        src = self.v[self._vidx(insn.reg_name(ops[1].reg))]
        shift = ops[2].imm
        mask = (1 << esize) - 1
        out = 0
        for i in range(count):
            v = (src >> (i * esize)) & mask
            out |= ((v << shift) & mask) << (i * esize)
        self._setv(self._vidx(dst), out)

    def op_bic(self, insn, ops):
        self._logic(insn, ops, lambda a, b: a & ~b)

    def op_orn(self, insn, ops):
        self._logic(insn, ops, lambda a, b: a | ~b)

    def op_mvn(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        mask = MASK64 if is64 else MASK32
        src, _ = (self._shifted(insn, ops, 1) if ops[1].type != ARM64_OP_IMM
                  else (ops[1].imm, is64))
        self.set_reg(dst, (~src) & mask)

    def op_neg(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        mask = MASK64 if is64 else MASK32
        src = self.get_reg(insn.reg_name(ops[1].reg))
        self.set_reg(dst, (-src) & mask)

    def op_mov(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        if dst[0] == 'v':
            # `mov v0.s[2], w8` —— 写**单个 lane**（INS），别整寄存器覆盖
            sh = shape_of(insn, ops[0])
            if sh and sh[3] is not None:
                _idx, esize, _cnt, lane = sh
                src = insn.reg_name(ops[1].reg)
                val = self.get_reg(src) if src[0] in 'wx' else self.v[self._vidx(src)]
                self.set_vec_elem(dst, lane, esize, val)
                return
            return self.op_dup(insn, ops)
        if ops[1].type == ARM64_OP_IMM:
            self.set_reg(dst, ops[1].imm)
            return
        src = insn.reg_name(ops[1].reg)
        if src[0] == 'v':
            # mov w8, v0.s[1]  —— UMOV
            shape = shape_of(insn, ops[1])
            if shape is None:
                raise RuntimeError('mov 向量未支持 %s' % insn.op_str)
            idx, esize, _cnt, lane = shape
            shift = (lane or 0) * esize
            val = (self.v[idx] >> shift) & ((1 << esize) - 1)
            self.set_reg(dst, val)
            return
        val, _ = self._shifted(insn, ops, 1)
        self.set_reg(dst, val)

    def op_movz(self, insn, ops):
        self.set_reg(insn.reg_name(ops[0].reg), ops[1].imm)

    def op_movn(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        mask = MASK64 if is64 else MASK32
        self.set_reg(dst, (~ops[1].imm) & mask)

    def op_movk(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        mask = MASK64 if is64 else MASK32
        sh = 0
        try:
            if ops[1].shift.type:
                sh = ops[1].shift.value
        except Exception:
            sh = 0
        cur = self.get_reg(dst)
        v = (cur & ~(0xFFFF << sh)) | ((ops[1].imm & 0xFFFF) << sh)
        self.set_reg(dst, v & mask)

    def op_lsl(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        mask = MASK64 if is64 else MASK32
        a = self.get_reg(insn.reg_name(ops[1].reg))
        if ops[2].type == ARM64_OP_IMM:
            b = ops[2].imm
        else:
            b = self.get_reg(insn.reg_name(ops[2].reg)) & (63 if is64 else 31)
        self.set_reg(dst, (a << b) & mask)

    def op_lsr(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        mask = MASK64 if is64 else MASK32
        a = self.get_reg(insn.reg_name(ops[1].reg)) & mask
        if ops[2].type == ARM64_OP_IMM:
            b = ops[2].imm
        else:
            b = self.get_reg(insn.reg_name(ops[2].reg)) & (63 if is64 else 31)
        self.set_reg(dst, (a >> b) & mask)

    def op_asr(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        mask = MASK64 if is64 else MASK32
        a = self.get_reg(insn.reg_name(ops[1].reg))
        if ops[2].type == ARM64_OP_IMM:
            b = ops[2].imm
        else:
            b = self.get_reg(insn.reg_name(ops[2].reg)) & (63 if is64 else 31)
        self.set_reg(dst, (self._sgn(a, 64 if is64 else 32) >> b) & mask)

    def op_ror(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        w = 64 if is64 else 32
        mask = MASK64 if is64 else MASK32
        a = self.get_reg(insn.reg_name(ops[1].reg)) & mask
        b = ops[2].imm if ops[2].type == ARM64_OP_IMM else self.get_reg(insn.reg_name(ops[2].reg)) & (w - 1)
        b &= (w - 1)
        self.set_reg(dst, (((a >> b) | (a << (w - b))) & mask) if b else a)

    def op_mul(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        mask = MASK64 if is64 else MASK32
        a = self.get_reg(insn.reg_name(ops[1].reg))
        b = self.get_reg(insn.reg_name(ops[2].reg))
        self.set_reg(dst, (a * b) & mask)

    def op_madd(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        mask = MASK64 if is64 else MASK32
        a = self.get_reg(insn.reg_name(ops[1].reg))
        b = self.get_reg(insn.reg_name(ops[2].reg))
        c = self.get_reg(insn.reg_name(ops[3].reg))
        self.set_reg(dst, (c + a * b) & mask)

    def op_msub(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        mask = MASK64 if is64 else MASK32
        a = self.get_reg(insn.reg_name(ops[1].reg))
        b = self.get_reg(insn.reg_name(ops[2].reg))
        c = self.get_reg(insn.reg_name(ops[3].reg))
        self.set_reg(dst, (c - a * b) & mask)

    def op_smulh(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        a = self._sgn(self.get_reg(insn.reg_name(ops[1].reg)), 64)
        b = self._sgn(self.get_reg(insn.reg_name(ops[2].reg)), 64)
        self.set_reg(dst, ((a * b) >> 64) & MASK64)

    def op_umulh(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        a = self.get_reg(insn.reg_name(ops[1].reg))
        b = self.get_reg(insn.reg_name(ops[2].reg))
        self.set_reg(dst, ((a * b) >> 64) & MASK64)

    def op_umull(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        a = self.get_reg(insn.reg_name(ops[1].reg)) & MASK32
        b = self.get_reg(insn.reg_name(ops[2].reg)) & MASK32
        self.set_reg(dst, (a * b) & MASK64)

    def op_smull(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        a = s32(self.get_reg(insn.reg_name(ops[1].reg)))
        b = s32(self.get_reg(insn.reg_name(ops[2].reg)))
        self.set_reg(dst, (a * b) & MASK64)

    def op_ubfx(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        src = self.get_reg(insn.reg_name(ops[1].reg))
        lsb, width = ops[2].imm, ops[3].imm
        self.set_reg(dst, (src >> lsb) & ((1 << width) - 1))

    def op_sbfx(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        src = self.get_reg(insn.reg_name(ops[1].reg))
        lsb, width = ops[2].imm, ops[3].imm
        v = (src >> lsb) & ((1 << width) - 1)
        if (v >> (width - 1)) & 1:
            v -= (1 << width)
        self.set_reg(dst, v & MASK64)

    def op_ubfiz(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        src = self.get_reg(insn.reg_name(ops[1].reg))
        lsb, width = ops[2].imm, ops[3].imm
        self.set_reg(dst, ((src & ((1 << width) - 1)) << lsb) & MASK64)

    def op_bfi(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        mask = MASK64 if is64 else MASK32
        cur = self.get_reg(dst)
        src = self.get_reg(insn.reg_name(ops[1].reg))
        lsb, width = ops[2].imm, ops[3].imm
        field = ((1 << width) - 1) << lsb
        self.set_reg(dst, ((cur & ~field) | ((src << lsb) & field)) & mask)

    def op_bfxil(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        mask = MASK64 if is64 else MASK32
        cur = self.get_reg(dst)
        src = self.get_reg(insn.reg_name(ops[1].reg))
        lsb, width = ops[2].imm, ops[3].imm
        field = ((1 << width) - 1) << lsb
        self.set_reg(dst, ((cur & ~field) | (src & field)) & mask)

    def op_csel(self, insn, ops):
        cond = insn.op_str.split(',')[-1].strip()
        dst = insn.reg_name(ops[0].reg)
        a = self.get_reg(insn.reg_name(ops[1].reg))
        b = self.get_reg(insn.reg_name(ops[2].reg))
        self.set_reg(dst, a if self.test_flags(cond) else b)

    def op_csinc(self, insn, ops):
        cond = insn.op_str.split(',')[-1].strip()
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        mask = MASK64 if is64 else MASK32
        a = self.get_reg(insn.reg_name(ops[1].reg))
        b = self.get_reg(insn.reg_name(ops[2].reg))
        self.set_reg(dst, (a if self.test_flags(cond) else b + 1) & mask)

    def op_csinv(self, insn, ops):
        cond = insn.op_str.split(',')[-1].strip()
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        mask = MASK64 if is64 else MASK32
        a = self.get_reg(insn.reg_name(ops[1].reg))
        b = self.get_reg(insn.reg_name(ops[2].reg))
        self.set_reg(dst, (a if self.test_flags(cond) else (~b) & mask))

    def op_cneg(self, insn, ops):
        cond = insn.op_str.split(',')[-1].strip()
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        mask = MASK64 if is64 else MASK32
        a = self.get_reg(insn.reg_name(ops[1].reg))
        self.set_reg(dst, (a if self.test_flags(cond) else (-a) & mask))

    def op_cinc(self, insn, ops):
        # CINC Rd, Rn, cond == CSINC Rd, Rn, Rn, invert(cond)
        #   ⇒ cond 成立取 Rn+1，否则取 Rn（**不是**反过来）
        cond = insn.op_str.split(',')[-1].strip()
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        mask = MASK64 if is64 else MASK32
        a = self.get_reg(insn.reg_name(ops[1].reg))
        self.set_reg(dst, ((a + 1) & mask) if self.test_flags(cond) else a)

    def op_cinv(self, insn, ops):
        cond = insn.op_str.split(',')[-1].strip()
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        mask = MASK64 if is64 else MASK32
        a = self.get_reg(insn.reg_name(ops[1].reg))
        self.set_reg(dst, (a if self.test_flags(cond) else (~a) & mask))

    def op_cset(self, insn, ops):
        cond = insn.op_str.split(',')[-1].strip()
        dst = insn.reg_name(ops[0].reg)
        self.set_reg(dst, 1 if self.test_flags(cond) else 0)

    def op_csetm(self, insn, ops):
        cond = insn.op_str.split(',')[-1].strip()
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        self.set_reg(dst, MASK64 if (is64 and self.test_flags(cond)) else (MASK32 if self.test_flags(cond) else 0))

    def op_rbit(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        w = 64 if is64 else 32
        v = self.get_reg(insn.reg_name(ops[1].reg)) & ((1 << w) - 1)
        out = 0
        for i in range(w):
            if (v >> i) & 1:
                out |= 1 << (w - 1 - i)
        self.set_reg(dst, out)

    def op_rev(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        is64 = dst[0] == 'x'
        n = 8 if is64 else 4
        v = self.get_reg(insn.reg_name(ops[1].reg)).to_bytes(n, 'little')
        self.set_reg(dst, int.from_bytes(v[::-1], 'little'))

    def op_mrs(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        sysname = insn.op_str.split(',')[-1].strip()
        if 'tpidr_el0' in sysname:
            self.set_reg(dst, TLS_BASE)
        else:
            self.set_reg(dst, 0)

    def op_msr(self, insn, ops):
        return

    def op_adrp(self, insn, ops):
        self.set_reg(insn.reg_name(ops[0].reg), ops[1].imm)

    def op_adr(self, insn, ops):
        self.set_reg(insn.reg_name(ops[0].reg), ops[1].imm)

    # ---- NEON ----
    def _vec_logic(self, insn, ops, fn):
        dst = insn.reg_name(ops[0].reg)
        a = self.v[self._vidx(insn.reg_name(ops[1].reg))]
        b = self.v[self._vidx(insn.reg_name(ops[2].reg))]
        self._setv(self._vidx(dst), fn(a, b) & ((1 << self._vec_width(insn, ops[0])) - 1))

    @staticmethod
    def _vec_width(insn, op):
        """该向量操作数的有效位宽（= 元素位宽 × 元素个数）。

        ⚠️ 按 128 位整体算会让 `orr v0.8b, ...` 的高 64 位留下源寄存器的脏数据
        —— 后面 `mov w9, v0.s[1]` 就会读到它。
        """
        sh = shape_of(insn, op)
        if not sh:
            return 128
        return min(128, sh[1] * sh[2])

    def op_dup(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        shape = shape_of(insn, ops[0])
        if shape is None:
            shape = (self._vidx(dst), 128, 1, None)
        _idx, esize, count, _lane = shape
        src = insn.reg_name(ops[1].reg)
        if src[0] in 'wx':
            val = self.get_reg(src) & ((1 << esize) - 1)
        elif src[0] == 'v':
            s2 = shape_of(insn, ops[1])
            shift = (s2[3] or 0) * s2[1]
            val = (self.v[s2[0]] >> shift) & ((1 << esize) - 1)
        else:
            raise RuntimeError('dup 源未支持 %s' % insn.op_str)
        out = 0
        for i in range(count):
            out |= val << (i * esize)
        self._setv(self._vidx(dst), out)

    def op_movi(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        shape = shape_of(insn, ops[0])
        _idx, esize, count, _lane = shape
        imm = ops[1].imm & ((1 << min(esize, 64)) - 1)
        out = 0
        for i in range(count):
            out |= imm << (i * esize)
        self._setv(self._vidx(dst), out)

    def op_fmov(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        src = insn.reg_name(ops[1].reg)
        if dst[0] in 'wx' and src[0] == 's':
            self.set_reg(dst, self.v[self._vidx(src)] & MASK32)
        elif dst[0] == 's' and src[0] in 'wx':
            self._setv(self._vidx(dst), self.get_reg(src) & MASK32)
        elif dst[0] == 'd' and src[0] in 'wx':
            self._setv(self._vidx(dst), self.get_reg(src) & MASK64)
        elif dst[0] in 'wx' and src[0] == 'd':
            self.set_reg(dst, self.v[self._vidx(src)] & (MASK32 if dst[0] == 'w' else MASK64))
        else:
            raise RuntimeError('fmov 未支持 %s' % insn.op_str)

    def op_ushll(self, insn, ops):
        self._shll_vec(insn, ops, high=False)

    def op_ushll2(self, insn, ops):
        self._shll_vec(insn, ops, high=True)

    def op_shll(self, insn, ops):
        self._shll_vec(insn, ops, high=False)

    def op_shll2(self, insn, ops):
        self._shll_vec(insn, ops, high=True)

    def _shll_vec(self, insn, ops, high):
        dst = insn.reg_name(ops[0].reg)
        dshape = shape_of(insn, ops[0])
        sshape = shape_of(insn, ops[1])
        shift = ops[2].imm
        src = self.v[sshape[0]]
        se, sn = sshape[1], sshape[2]
        if high:
            src >>= 64
        out = 0
        for i in range(sn):
            v = (src >> (i * se)) & ((1 << se) - 1)
            out |= (v << shift) << (i * dshape[1])
        self._setv(self._vidx(dst), out)

    def op_ushr(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        shape = shape_of(insn, ops[0])
        _idx, esize, count, _lane = shape
        src = self.v[self._vidx(insn.reg_name(ops[1].reg))]
        shift = ops[2].imm
        mask = (1 << esize) - 1
        out = 0
        for i in range(count):
            v = (src >> (i * esize)) & mask
            out |= ((v >> shift) & mask) << (i * esize)
        self._setv(self._vidx(dst), out)

    def op_shr(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        shape = shape_of(insn, ops[0])
        _idx, esize, count, _lane = shape
        src = self.v[self._vidx(insn.reg_name(ops[1].reg))]
        shift = ops[2].imm
        mask = (1 << esize) - 1
        out = 0
        for i in range(count):
            v = (src >> (i * esize)) & mask
            v = self._sgn(v, esize) >> shift
            out |= (v & mask) << (i * esize)
        self._setv(self._vidx(dst), out)

    def op_ushl(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        shape = shape_of(insn, ops[0])
        _idx, esize, count, _lane = shape
        a = self.v[self._vidx(insn.reg_name(ops[1].reg))]
        b = self.v[self._vidx(insn.reg_name(ops[2].reg))]
        mask = (1 << esize) - 1
        out = 0
        for i in range(count):
            x = (a >> (i * esize)) & mask
            sh = (b >> (i * esize)) & 0xFF
            if sh >= 0x80:
                sh -= 0x100
            if sh >= 0:
                y = (x << sh) & mask
            else:
                y = (x >> (-sh)) & mask
            out |= y << (i * esize)
        self._setv(self._vidx(dst), out)

    def op_add_v(self, insn, ops):
        self._vec_arith(insn, ops, lambda a, b: a + b)

    def op_sub_v(self, insn, ops):
        self._vec_arith(insn, ops, lambda a, b: a - b)

    def _vec_arith(self, insn, ops, fn):
        dst = insn.reg_name(ops[0].reg)
        shape = shape_of(insn, ops[0])
        _idx, esize, count, _lane = shape
        mask = (1 << esize) - 1
        a = self.v[self._vidx(insn.reg_name(ops[1].reg))]
        if ops[2].type == ARM64_OP_IMM:
            bimm = ops[2].imm
            out = 0
            for i in range(count):
                x = (a >> (i * esize)) & mask
                out |= ((fn(x, bimm) & mask)) << (i * esize)
            self._setv(self._vidx(dst), out)
            return
        b = self.v[self._vidx(insn.reg_name(ops[2].reg))]
        out = 0
        for i in range(count):
            x = (a >> (i * esize)) & mask
            y = (b >> (i * esize)) & mask
            out |= ((fn(x, y) & mask)) << (i * esize)
        self._setv(self._vidx(dst), out)

    def op_ext(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        a = self.v[self._vidx(insn.reg_name(ops[1].reg))]
        b = self.v[self._vidx(insn.reg_name(ops[2].reg))]
        idx = ops[3].imm
        concat = (b << 128) | a
        self._setv(self._vidx(dst), (concat >> (idx * 8)) & ((1 << 128) - 1))

    def op_xtn(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        dshape = shape_of(insn, ops[0])
        sshape = shape_of(insn, ops[1])
        src = self.v[sshape[0]]
        out = 0
        for i in range(dshape[2]):
            v = (src >> (i * sshape[1])) & ((1 << sshape[1]) - 1)
            out |= v << (i * dshape[1])
        self._setv(self._vidx(dst), out)

    def op_xtn2(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        dshape = shape_of(insn, ops[0])
        sshape = shape_of(insn, ops[1])
        src = self.v[sshape[0]]
        cur = self.v[self._vidx(dst)]
        out = cur
        for i in range(dshape[2]):
            v = (src >> (i * sshape[1])) & ((1 << sshape[1]) - 1)
            lane = i + dshape[2] // 2
            out &= ~(((1 << dshape[1]) - 1) << (lane * dshape[1]))
            out |= v << (lane * dshape[1])
        self._setv(self._vidx(dst), out)

    def op_mvn_v(self, insn, ops):
        dst = insn.reg_name(ops[0].reg)
        w = self._vec_width(insn, ops[0])
        self._setv(self._vidx(dst), (~self.v[self._vidx(insn.reg_name(ops[1].reg))]) & ((1 << w) - 1))

    # ---- 外部函数 ----
    def _call_extern(self, name):
        """执行外部符号语义。

        @returns True 表示这是「结束执行」的特殊调用
        """
        self.calls.append(name)
        lr = self.x[30]
        if name == 'time@LIBC' or name.startswith('time'):
            t = self.time_value
            ptr = self.x[0]
            if ptr:
                self.mem.write_u64(ptr, t)
            self.x[0] = t
            self.pc = lr
            return False
        if 'basic_ostream' in name and 'lsEj' in name:
            # std::ostream& operator<<(unsigned int)
            self.out_u32.append(self.x[1] & MASK32)
            self.pc = lr
            return False
        if name in ('__cxa_finalize@LIBC', '__cxa_atexit@LIBC'):
            self.pc = lr
            return False
        if name == '':
            raise RuntimeError('未解析的 stub @0x%x' % self.pc)
        # ---- C++ 内存分配（**必须真分配**）----
        #
        # 否则 `operator new` 返回的「指针」就是请求的字节数这个小整数，调用方
        # 会拿它当缓冲写 —— 直接把 so 的代码段砸烂（实测：写完后面所有指令都乱）。
        if name.startswith('_Znwm') or name.startswith('_Znam'):
            size = int(self.x[0]) & MASK64
            self.x[0] = self._heap_alloc(size)
            self.pc = lr
            return False
        if name.startswith('_ZdlPv') or name.startswith('_ZdaPv'):
            self.pc = lr
            return False
        if name in self.NOOP_SYMS:
            self.pc = lr
            return False
        # 其余（尤其 ostringstream 生命周期）无副作用，但仍要留痕便于排查
        self.unknown.add(name)
        self.pc = lr
        return False

    NOOP_SYMS = {
        '_ZNSt6__ndk18ios_base4initEPv',
        '_ZdlPv', '_ZdaPv',
    }

    def _heap_alloc(self, size):
        """极简 bump 分配器（够跑完一次 T 生成即可）。"""
        if size <= 0:
            size = 1
        p = self.heap_ptr
        self.heap_ptr = (self.heap_ptr + size + 15) & ~0xF
        # 保证落在已映射页内
        self.mem.write(p, b'\0' * min(size, 16))
        return p


def dump_T(so_path, t_value, ts=0, verbose=False):
    e = Emu(so_path, verbose=verbose)
    e.time_value = t_value
    # T 函数签名：x8 = sret 缓冲，w1 = ts；x0 未用
    e.x[8] = SRET_BUF
    e.x[1] = ts
    e.x[0] = 0
    e.sp = STACK_TOP
    try:
        e.run(T_ENTRY)
    except Exception:
        # 尾部还有 stack-canary 校验与 ostringstream 析构，它们不影响 78 个
        # `<<` 参数的正确性；只要数字已收满就视为成功（详见 README）。
        if len(e.out_u32) != 78:
            raise
    nums = e.out_u32
    return nums, ''.join(str(n) for n in nums), e


if __name__ == '__main__':
    so = sys.argv[1] if len(sys.argv) > 1 else r'D:/pk-node/bin/native/lre.so'
    t = int(sys.argv[2]) if len(sys.argv) > 2 else 1790831613
    verbose = '-v' in sys.argv
    nums, T, e = dump_T(so, t, verbose=verbose)
    print('数字个数:', len(nums))
    print('T 长度:', len(T))
    print('T =', T)
