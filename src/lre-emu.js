'use strict';
/**
 * 纯 JS 的 arm64 模拟器 —— 在任意平台算出主域签名所需的 T。
 *
 * 主域端点要求 URL 带 32 位 MD5 的 `sign`，否则一律 417 `x-block-by: solar-encoder`。
 * T 由 `libRequestEncoder.so`（bin/native/lre.so）生成，只依赖 `time()/60`。
 * 老实现需 arm64 原生跑，Windows/x86 跑不了 → 练习链路必然 417。
 *
 * 两套签名资产（用错会 417）：
 *
 * | variant | so | 指令表 | 用于 |
 * |---|---|---|---|
 * | `exercise` | `bin/native/lre.so` | `lre-insns.js` | 练习（version=3.140.1） |
 * | `pk` | `bin/native/lre_pk.so` | `lre-insns-pk.js` | PK（version=3.143.1） |
 *
 * 不改写混淆代码，而是直接执行：指令表由 tools/gen-lre-insns.py 用 capstone 离线反汇编后
 * 固化在 lre-insns.js，这里只做「取指 → 执行」。对外暴露 calcT，返回 78 个 unsigned 的十进制拼接。
 *
 * 正确性：src/sign.js 的 fixture（真机 T/sign）可作验收，模拟器输出逐字节一致（410/410）。
 *
 * 为什么用 BigInt：64 位乘除法（smulh/umulh）与 128 位 NEON 无法用 Number 精确表示；
 * 一次 T 生成只跑几千条指令且结果按分钟缓存，开销可忽略。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * 两套签名资产：`D`（指令表）与 `SO_PATH` 做成模块级可变变量，`calcT` 进入时按 variant 切换。
 * 类内部有十几处 `D.segs` 引用，改 `this.D` 改动面大；而 `Emu.run()` 全程同步（无 await），
 * 不存在两次 calcT 交错，切换安全。
 */
const EX_INSNS = require('./lre-insns');
const PK_INSNS_PATH = './lre-insns-pk';
let PK_INSNS = null;
let D = EX_INSNS;

const PAGE_SHIFT = 12;
const PAGE_SIZE = 1 << PAGE_SHIFT;
const PAGE_MASK = PAGE_SIZE - 1;

const MASK32 = (1n << 32n) - 1n;
const MASK64 = (1n << 64n) - 1n;
const MASK128 = (1n << 128n) - 1n;

const EX_SO_PATH = path.join(__dirname, '..', 'bin', 'native', 'lre.so');
const PK_SO_PATH = path.join(__dirname, '..', 'bin', 'native', 'lre_pk.so');
let SO_PATH = EX_SO_PATH;

/** 「函数已返回」的哨兵 pc（不落在任何映射区间）。 */
const RET_SENTINEL = 0x0F0000000;

/** capstone arm64_vas → [元素字节数, 元素个数]（元素位宽 = 字节数 × 8）。 */
const VAS_MAP = {
  1: [1, 16], 2: [1, 8], 3: [1, 4], 4: [1, 1],
  5: [2, 8], 6: [2, 4], 7: [2, 2], 8: [2, 1],
  9: [4, 4], 10: [4, 2], 11: [4, 1],
  12: [8, 2], 13: [8, 1], 14: [16, 1],
};

/** 无 vas 时按寄存器名前缀判断形态：[元素位宽, 元素个数]。 */
const PREFIX_SHAPE = { v: [128, 1], q: [128, 1], d: [64, 1], s: [32, 1], h: [16, 1], b: [8, 1] };

const REG_ALIAS = { fp: 'x29', lr: 'x30', ip0: 'x16', ip1: 'x17', wfp: 'w29', wlr: 'w30' };

/** 有符号解释（宽度 w 位）。 */
function sgn(v, w) {
  const bits = BigInt(w);
  const m = (1n << bits) - 1n;
  const x = v & m;
  return (x >> (bits - 1n)) & 1n ? x - (1n << bits) : x;
}

/** 是否立即数操作数（无移位是数字；带移位是 [imm, shiftType, shiftValue]）。 */
function isImm(op) {
  return typeof op === 'number' || (Array.isArray(op) && typeof op[0] === 'number');
}

/** 立即数的实际值（含移位，如 `movk #1040, lsl #16`）。 */
function immVal(op) {
  if (typeof op === 'number') return BigInt(op);
  return BigInt(op[0]) << BigInt(op[2] || 0);
}

/** 取操作数的寄存器名（操作数可能是字符串，也可能是 [name, st, sv, ext, vas, lane]）。 */
function opName(op) {
  return Array.isArray(op) ? op[0] : op;
}

/** 解析向量操作数形态 → [寄存器号, 元素位宽, 元素个数, lane|null]。 */
function shapeOf(op) {
  const arr = Array.isArray(op);
  const name = arr ? op[0] : op;
  if (!name || typeof name !== 'string') return null;
  const vas = arr ? op[4] : 0;
  let lane = arr ? op[5] : -1;
  if (lane == null || lane < 0) lane = null;
  const head = name[0];
  if (vas && head === 'v') {
    const s = VAS_MAP[vas] || [1, 16];
    return [Number(name.slice(1)), s[0] * 8, s[1], lane];
  }
  const ps = PREFIX_SHAPE[head];
  if (!ps) return null;
  return [Number(name.slice(1)), ps[0], ps[1], lane];
}

/** 4KB 页稀疏内存。 */
class Mem {
  constructor() {
    this.pages = new Map();
  }

  page(idx, create) {
    let p = this.pages.get(idx);
    if (!p && create) {
      p = new Uint8Array(PAGE_SIZE);
      this.pages.set(idx, p);
    }
    return p;
  }

  map(addr, data) {
    let off = 0;
    const n = data.length;
    while (off < n) {
      const a = addr + off;
      const pg = this.page(a >>> PAGE_SHIFT, true);
      const pOff = a & PAGE_MASK;
      const take = Math.min(PAGE_SIZE - pOff, n - off);
      pg.set(data.subarray(off, off + take), pOff);
      off += take;
    }
  }

  readBytes(addr, size) {
    const out = Buffer.allocUnsafe(size);
    let a = addr;
    let left = size;
    let p = 0;
    while (left > 0) {
      const pg = this.page(a >>> PAGE_SHIFT, false);
      if (!pg) throw new Error('读未映射内存 0x' + a.toString(16));
      const pOff = a & PAGE_MASK;
      const take = Math.min(PAGE_SIZE - pOff, left);
      out.set(pg.subarray(pOff, pOff + take), p);
      p += take;
      a += take;
      left -= take;
    }
    return out;
  }

  writeBytes(addr, data) {
    let a = addr;
    let off = 0;
    while (off < data.length) {
      const pg = this.page(a >>> PAGE_SHIFT, true);
      const pOff = a & PAGE_MASK;
      const take = Math.min(PAGE_SIZE - pOff, data.length - off);
      pg.set(data.subarray(off, off + take), pOff);
      off += take;
      a += take;
    }
  }

  readU32(addr) {
    return BigInt(this.readBytes(addr, 4).readUInt32LE(0));
  }

  readU64(addr) {
    return this.readBytes(addr, 8).readBigUInt64LE(0);
  }

  writeU32(addr, v) {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(Number(v & MASK32), 0);
    this.writeBytes(addr, b);
  }

  writeU64(addr, v) {
    const b = Buffer.allocUnsafe(8);
    b.writeBigUInt64LE(v & MASK64, 0);
    this.writeBytes(addr, b);
  }
}

class Emu {
  constructor(soBuffer) {
    this.so = soBuffer;
    this.mem = new Mem();
    this.x = new Array(31).fill(0n);
    this.sp = 0n;
    this.v = new Array(32).fill(0n);
    this.nzcv = 0;
    this.outU32 = [];
    this.calls = [];
    this.steps = 0;
    this.heapPtr = 0x03000000;
    this.stubMap = new Map();
    this.timeValue = 0n;
    this._load();
  }

  _load() {
    for (const [vaddr, off, size] of D.segs) {
      this.mem.map(vaddr, this.so.subarray(off, off + size));
    }
    for (let i = 0; i < D.relocs.length; i += 2) {
      this.mem.writeU64(D.relocs[i], BigInt(D.relocs[i + 1]));
    }
    for (let i = 0; i < D.stubSyms.length; i++) {
      this.stubMap.set(D.stubBase + i * 16, D.stubSyms[i]);
    }
    this.pltMap = new Map();
    for (const k of Object.keys(D.pltSyms)) {
      this.pltMap.set(Number(k), D.pltSyms[k]);
    }
    // 栈保护字（TLS）：T 函数会读 [tpidr_el0 + 0x28] 并与保存值比对，
    // 只要两次读的是同一地址即可，这里写个常数。
    this.mem.writeU64(D.tlsBase + 0x28, 0xDEADBEEFn);
  }

  // ------------------------------------------------------------ 寄存器
  static norm(name) {
    return REG_ALIAS[name] || name;
  }

  getReg(name0) {
    const name = Emu.norm(opName(name0));
    if (name === 'xzr' || name === 'wzr') return 0n;
    if (name === 'sp') return this.sp;
    if (name === 'wsp') return this.sp & MASK32;
    const i = Number(name.slice(1));
    if (name[0] === 'w') return this.x[i] & MASK32;
    if (name[0] === 'x') return this.x[i];
    throw new Error('不支持读寄存器 ' + name);
  }

  setReg(name0, val) {
    const name = Emu.norm(opName(name0));
    if (name === 'xzr' || name === 'wzr') return;
    if (name === 'sp') { this.sp = val & MASK64; return; }
    if (name === 'wsp') { this.sp = val & MASK32; return; }
    const i = Number(name.slice(1));
    if (name[0] === 'w') { this.x[i] = val & MASK32; return; }
    if (name[0] === 'x') { this.x[i] = val & MASK64; return; }
    throw new Error('不支持写寄存器 ' + name);
  }

  setVecElem(reg, lane, esize, value) {
    const idx = Number(opName(reg).slice(1));
    const bits = BigInt(esize);
    const m = (1n << bits) - 1n;
    const shift = BigInt(lane) * bits;
    this.v[idx] = ((this.v[idx] & ~(m << shift)) | ((value & m) << shift)) & MASK128;
  }

  static regSize(name0) {
    const name = Emu.norm(name0);
    return { w: 4, x: 8, s: 4, d: 8, q: 16, h: 2, b: 1 }[name[0]] || 8;
  }

  // ------------------------------------------------------------ flags
  _flagsSub(a, b, is64) {
    const w = is64 ? 64 : 32;
    const mask = is64 ? MASK64 : MASK32;
    a &= mask; b &= mask;
    const res = (a - b) & mask;
    const sa = sgn(a, w), sb = sgn(b, w), sr = sgn(res, w);
    const n = (res >> BigInt(w - 1)) & 1n ? 1 : 0;
    const z = res === 0n ? 1 : 0;
    const c = a >= b ? 1 : 0;
    const v = ((sa ^ sb) & (sa ^ sr)) < 0n ? 1 : 0;
    this.nzcv = (n << 3) | (z << 2) | (c << 1) | v;
    return res;
  }

  _flagsAdd(a, b, carry, is64) {
    const w = is64 ? 64 : 32;
    const mask = is64 ? MASK64 : MASK32;
    const ca = BigInt(carry);
    a &= mask; b &= mask;
    const res = (a + b + ca) & mask;
    const sa = sgn(a, w), sb = sgn(b, w), sr = sgn(res, w);
    const n = (res >> BigInt(w - 1)) & 1n ? 1 : 0;
    const z = res === 0n ? 1 : 0;
    const c = a + b + ca > mask ? 1 : 0;
    const v = ((sa ^ sr) & (sb ^ sr)) < 0n ? 1 : 0;
    this.nzcv = (n << 3) | (z << 2) | (c << 1) | v;
    return res;
  }

  _flagsLogic(res, is64) {
    const w = is64 ? 64 : 32;
    const n = (res >> BigInt(w - 1)) & 1n ? 1 : 0;
    const z = res === 0n ? 1 : 0;
    this.nzcv = (n << 3) | (z << 2);
  }

  testCond(cc) {
    const n = (this.nzcv >> 3) & 1;
    const z = (this.nzcv >> 2) & 1;
    const c = (this.nzcv >> 1) & 1;
    const v = this.nzcv & 1;
    switch (cc) {
      case 'eq': return z === 1;
      case 'ne': return z === 0;
      case 'hs': case 'cs': return c === 1;
      case 'lo': case 'cc': return c === 0;
      case 'mi': return n === 1;
      case 'pl': return n === 0;
      case 'vs': return v === 1;
      case 'vc': return v === 0;
      case 'hi': return c === 1 && z === 0;
      case 'ls': return c === 0 || z === 1;
      case 'ge': return n === v;
      case 'lt': return n !== v;
      case 'gt': return z === 0 && n === v;
      case 'le': return z === 1 || n !== v;
      default: return true;
    }
  }

  // ------------------------------------------------------------ 操作数
  extend(val, name, ext) {
    const t = { 1: [8, false], 2: [16, false], 3: [32, false], 4: [64, false],
      5: [8, true], 6: [16, true], 7: [32, true], 8: [64, true] }[ext] || [32, false];
    const bits = BigInt(t[0]);
    const m = (1n << bits) - 1n;
    let v = val & m;
    if (t[1] && (v >> (bits - 1n)) & 1n) v -= (1n << bits);
    return v & MASK64;
  }

  /** 读取带 shift / extend 修饰的寄存器操作数 → [value, is64]。 */
  shifted(op) {
    const arr = Array.isArray(op);
    const name = arr ? op[0] : op;
    let val = this.getReg(name);
    let is64 = name[0] === 'x';
    const st = arr ? op[1] : 0;
    const sv = arr ? op[2] : 0;
    const ext = arr ? op[3] : 0;
    const mask = is64 ? MASK64 : MASK32;
    const w = is64 ? 64 : 32;
    if (ext) {
      val = this.extend(val, name, ext);
      is64 = true;
    } else if (st === 3) {
      val = (val & mask) >> BigInt(sv);
    } else if (st === 4) {
      val = (sgn(val, w) >> BigInt(sv)) & mask;
    } else if (st === 1) {
      val = (val << BigInt(sv)) & mask;
    } else if (st === 5) {
      const b = BigInt(sv);
      val = ((val >> b) | (val << BigInt(w - sv))) & mask;
    }
    return [val, is64];
  }

  /** 内存操作数地址（op = ['m', base, index, disp, st, sv, ext]）。 */
  memAddr(wb, op) {
    const baseName = op[1];
    let base = baseName ? this.getReg(baseName) : 0n;
    let idx = 0n;
    if (op[2]) {
      idx = this.getReg(op[2]);
      const ext = op[6] || 0;
      if (ext) idx = this.extend(idx, op[2], ext);
      const st = op[4] || 0;
      const sv = op[5] || 0;
      if (st === 1 && sv) idx = (idx << BigInt(sv)) & MASK64;
    }
    const disp = BigInt(op[3]);
    if (wb === 2) {                       // post-index
      const addr = (base + idx) & MASK64;
      if (baseName) this.setReg(baseName, (addr + disp) & MASK64);
      return addr;
    }
    const addr = (base + idx + disp) & MASK64;
    if (wb === 1 && baseName) this.setReg(baseName, addr);
    return addr;
  }

  store(reg0, addr) {
    const reg = Emu.norm(reg0);
    const head = reg[0];
    if (head === 'w') { this.mem.writeU32(addr, this.getReg(reg)); return; }
    if (head === 'x') { this.mem.writeU64(addr, this.getReg(reg)); return; }
    if (head === 'b') { this.mem.writeBytes(addr, Buffer.from([Number(this.getReg(reg) & 0xFFn)])); return; }
    if (head === 'h') {
      const b = Buffer.allocUnsafe(2);
      b.writeUInt16LE(Number(this.getReg(reg) & 0xFFFFn), 0);
      this.mem.writeBytes(addr, b);
      return;
    }
    const n = { s: 4, d: 8, q: 16 }[head];
    if (n == null) throw new Error('str 源未支持 ' + reg);
    const bytes = Buffer.alloc(n);
    let val = this.v[Number(reg.slice(1))];
    for (let i = 0; i < n; i++) {
      bytes[i] = Number(val & 0xFFn);
      val >>= 8n;
    }
    this.mem.writeBytes(addr, bytes);
  }

  loadInto(reg0, addr) {
    const head = reg0[0];
    if (head === 'w') { this.setReg(reg0, this.mem.readU32(addr)); return; }
    if (head === 'x') { this.setReg(reg0, this.mem.readU64(addr)); return; }
    const n = { s: 4, d: 8, q: 16, h: 2, b: 1 }[head];
    if (n == null) throw new Error('ldr 目标未支持 ' + reg0);
    const b = this.mem.readBytes(addr, n);
    let val = 0n;
    for (let i = n - 1; i >= 0; i--) val = (val << 8n) | BigInt(b[i]);
    this.v[Number(reg0.slice(1))] = val & MASK128;
  }

  // ------------------------------------------------------------ 运行
  run(start, maxSteps = 4000000) {
    // T 函数以 `ret` 结束，会把 pc 送回 x30。给它一个「哨兵地址」，
    // 执行到那里即视为正常结束（和真机被 JNI 调用后返回等价）。
    this.x[30] = BigInt(RET_SENTINEL);
    let pc = start;
    for (;;) {
      this.steps += 1;
      if (pc === RET_SENTINEL) return;
      if (this.steps > maxSteps) throw new Error('步数超限（疑似死循环）pc=0x' + pc.toString(16));
      const sym = this.stubMap.get(pc) !== undefined ? this.stubMap.get(pc) : this.pltMap.get(pc);
      if (sym !== undefined) { this.callExtern(sym); pc = Number(this.x[30]); continue; }
      const slot = (pc - D.base) >> 2;
      const item = slot >= 0 && slot < D.insns.length ? D.insns[slot] : null;
      if (!item) throw new Error('无指令 @0x' + pc.toString(16));
      const next = pc + 4;
      this.pc = pc;
      this.exec(item);
      pc = this.pc === pc ? next : this.pc;
    }
  }

  exec(item) {
    const mn = D.mnems[item[0]];
    const cond = item[1];
    const wb = item[2];
    const ops = item.slice(3);    // ld4 有 5 个操作数（4 向量 + 内存）

    // 目标为向量寄存器时走 NEON 通道（add/sub/and/orr/eor/bic/orn/mvn 与标量同名）
    const n0 = ops[0] == null ? '' : opName(ops[0]);
    if (typeof n0 === 'string' && n0[0] === 'v') {
      if (mn === 'add') { this._vecPerElem(ops, (a, b, m) => a + b); return; }
      if (mn === 'sub') { this._vecPerElem(ops, (a, b, m) => a - b); return; }
      if (mn === 'and') { this._vecLogic(ops, (a, b) => a & b); return; }
      if (mn === 'orr') { this._vecLogic(ops, (a, b) => a | b); return; }
      if (mn === 'eor') { this._vecLogic(ops, (a, b) => a ^ b); return; }
      if (mn === 'bic') { this._vecLogic(ops, (a, b) => a & ~b); return; }
      if (mn === 'orn') { this._vecLogic(ops, (a, b) => a | ~b); return; }
      if (mn === 'mvn') { this.op_mvn_v(ops); return; }
    }

    if (mn.length === 4 && mn[1] === '.' && typeof ops[0] === 'number') {
      this._bcond(ops, cond);      // b.eq / b.ne / b.hs ...
      return;
    }

    const h = this['op_' + mn.replace(/\./g, '_')];
    if (h) { h.call(this, ops, cond, wb, mn); return; }
    throw new Error('未实现指令 ' + mn + ' @0x' + this.pc.toString(16));
  }

  branch(addr) { this.pc = addr; }

  // ---- 分支 ----
  op_b(ops) { this.branch(ops[0]); }
  op_ret() { this.branch(Number(this.x[30])); }
  op_bl(ops) { this.x[30] = BigInt(this.pc + 4); this.branch(ops[0]); }
  op_br(ops) { this.branch(Number(this.getReg(ops[0]))); }
  op_blr(ops) { this.x[30] = BigInt(this.pc + 4); this.branch(Number(this.getReg(ops[0]))); }

  _bcond(ops, condIdx) {
    const cc = D.conds[condIdx];
    if (this.testCond(cc)) this.branch(ops[0]);
  }

  op_cbz(ops) { if (this.getReg(ops[0]) === 0n) this.branch(ops[1]); }
  op_cbnz(ops) { if (this.getReg(ops[0]) !== 0n) this.branch(ops[1]); }
  op_tbz(ops) { if (((this.getReg(ops[0]) >> BigInt(ops[1])) & 1n) === 0n) this.branch(ops[2]); }
  op_tbnz(ops) { if (((this.getReg(ops[0]) >> BigInt(ops[1])) & 1n) === 1n) this.branch(ops[2]); }

  // ---- 加载 / 存储 ----
  op_ldr(ops, cond, wb) { this.loadInto(ops[0], Number(this.memAddr(wb, ops[1]))); }
  op_ldur(ops, cond, wb) { this.op_ldr(ops, cond, wb); }

  op_ldrb(ops, cond, wb) {
    const addr = Number(this.memAddr(wb, ops[1]));
    this.setReg(ops[0], BigInt(this.mem.readBytes(addr, 1)[0]));
  }

  op_ldurb(ops, cond, wb) { this.op_ldrb(ops, cond, wb); }

  op_ldrh(ops, cond, wb) {
    const addr = Number(this.memAddr(wb, ops[1]));
    this.setReg(ops[0], BigInt(this.mem.readBytes(addr, 2).readUInt16LE(0)));
  }

  op_str(ops, cond, wb) { this.store(ops[0], Number(this.memAddr(wb, ops[1]))); }
  op_stur(ops, cond, wb) { this.op_str(ops, cond, wb); }

  op_strb(ops, cond, wb) {
    const addr = Number(this.memAddr(wb, ops[1]));
    this.mem.writeBytes(addr, Buffer.from([Number(this.getReg(ops[0]) & 0xFFn)]));
  }

  op_sturb(ops, cond, wb) { this.op_strb(ops, cond, wb); }

  op_strh(ops, cond, wb) {
    const addr = Number(this.memAddr(wb, ops[1]));
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16LE(Number(this.getReg(ops[0]) & 0xFFFFn), 0);
    this.mem.writeBytes(addr, b);
  }

  op_ldp(ops, cond, wb) {
    const addr = Number(this.memAddr(wb, ops[2]));
    this.loadInto(ops[0], addr);
    this.loadInto(ops[1], addr + Emu.regSize(ops[0]));
  }

  op_stp(ops, cond, wb) {
    const addr = Number(this.memAddr(wb, ops[2]));
    this.store(ops[0], addr);
    this.store(ops[1], addr + Emu.regSize(ops[0]));
  }

  op_ld4(ops, cond, wb) {
    const addr = Number(this.memAddr(wb, ops[ops.length - 1]));
    const regs = ops.slice(0, 4);
    const sh = shapeOf(regs[0]);
    const nbytes = sh[1] >> 3;
    for (let i = 0; i < sh[2]; i++) {
      for (let j = 0; j < 4; j++) {
        const b = this.mem.readBytes(addr + (i * 4 + j) * nbytes, nbytes);
        let val = 0n;
        for (let k = nbytes - 1; k >= 0; k--) val = (val << 8n) | BigInt(b[k]);
        this.setVecElem(regs[j], i, sh[1], val);
      }
    }
  }

  // ---- 算术 / 逻辑 ----
  _arith(ops, kind, flags) {
    const dst = ops[0];
    const is64 = opName(dst)[0] === 'x';
    const mask = is64 ? MASK64 : MASK32;
    const a = this.getReg(ops[1]);
    let b;
    if (isImm(ops[2])) {
      b = immVal(ops[2]);
    } else {
      b = this.shifted(ops[2])[0];
    }
    const res = kind === '+'
      ? (flags ? this._flagsAdd(a, b, 0, is64) : (a + b) & mask)
      : (flags ? this._flagsSub(a, b, is64) : (a - b) & mask);
    this.setReg(dst, res);
  }

  op_add(ops) { this._arith(ops, '+', false); }
  op_sub(ops) { this._arith(ops, '-', false); }
  op_adds(ops) { this._arith(ops, '+', true); }
  op_subs(ops) { this._arith(ops, '-', true); }

  op_cmp(ops) {
    const is64 = (Array.isArray(ops[0]) ? ops[0][0] : ops[0])[0] === 'x';
    const a = this.getReg(Array.isArray(ops[0]) ? ops[0][0] : ops[0]);
    const b = isImm(ops[1]) ? immVal(ops[1]) : this.shifted(ops[1])[0];
    this._flagsSub(a, b, is64);
  }

  op_cmn(ops) {
    const is64 = (Array.isArray(ops[0]) ? ops[0][0] : ops[0])[0] === 'x';
    const a = this.getReg(Array.isArray(ops[0]) ? ops[0][0] : ops[0]);
    const b = isImm(ops[1]) ? immVal(ops[1]) : this.shifted(ops[1])[0];
    this._flagsAdd(a, b, 0, is64);
  }

  op_tst(ops) {
    const is64 = (Array.isArray(ops[0]) ? ops[0][0] : ops[0])[0] === 'x';
    const a = this.getReg(Array.isArray(ops[0]) ? ops[0][0] : ops[0]);
    const b = isImm(ops[1]) ? immVal(ops[1]) : this.shifted(ops[1])[0];
    const mask = is64 ? MASK64 : MASK32;
    this._flagsLogic(a & b & mask, is64);
  }

  _logic(ops, fn, flags) {
    const dst = ops[0];
    const is64 = opName(dst)[0] === 'x';
    const mask = is64 ? MASK64 : MASK32;
    const a = this.getReg(ops[1]);
    const b = isImm(ops[2]) ? immVal(ops[2]) : this.shifted(ops[2])[0];
    const res = fn(a & mask, b & mask) & mask;
    // ANDS/ORRS/... 是「运算 + 置标志」，结果同样要写回目标寄存器
    this.setReg(dst, res);
    if (flags) this._flagsLogic(res, is64);
  }

  op_and(ops) { this._logic(ops, (a, b) => a & b, false); }
  op_ands(ops) { this._logic(ops, (a, b) => a & b, true); }
  op_orr(ops) { this._logic(ops, (a, b) => a | b, false); }
  op_eor(ops) { this._logic(ops, (a, b) => a ^ b, false); }
  op_bic(ops) { this._logic(ops, (a, b) => a & ~b, false); }
  op_orn(ops) { this._logic(ops, (a, b) => a | ~b, false); }

  op_mvn(ops) {
    const dst = ops[0];
    const is64 = opName(dst)[0] === 'x';
    const mask = is64 ? MASK64 : MASK32;
    const src = typeof ops[1] === 'number' ? BigInt(ops[1]) : this.shifted(ops[1])[0];
    this.setReg(dst, (~src) & mask);
  }

  op_neg(ops) {
    const dst = ops[0];
    const mask = opName(dst)[0] === 'x' ? MASK64 : MASK32;
    this.setReg(dst, (-this.getReg(ops[1])) & mask);
  }

  op_mov(ops) {
    const dst = ops[0];
    if (opName(dst)[0] === 'v') {
      // `mov v0.s[2], w8` —— 写单个 lane（INS），别整寄存器覆盖
      const sh = shapeOf(dst);
      if (sh && sh[3] != null) {
        const srcOp = ops[1];
        const srcName = Array.isArray(srcOp) ? srcOp[0] : srcOp;
        const val = (srcName[0] === 'x' || srcName[0] === 'w')
          ? this.getReg(srcName)
          : this.v[Number(srcName.slice(1))];
        this.setVecElem(dst, sh[3], sh[1], val);
        return;
      }
      return this.op_dup(ops);
    }
    if (isImm(ops[1])) { this.setReg(dst, immVal(ops[1])); return; }
    const srcName = Array.isArray(ops[1]) ? ops[1][0] : ops[1];
    if (srcName[0] === 'v') {
      // mov w8, v0.s[1] —— UMOV
      const sh = shapeOf(ops[1]);
      if (!sh) throw new Error('mov 向量未支持');
      const shift = BigInt(sh[3] == null ? 0 : sh[3]) * BigInt(sh[1]);
      const m = (1n << BigInt(sh[1])) - 1n;
      this.setReg(dst, (this.v[sh[0]] >> shift) & m);
      return;
    }
    this.setReg(dst, this.shifted(ops[1])[0]);
  }

  op_movz(ops) { this.setReg(ops[0], BigInt(ops[1])); }

  op_movn(ops) {
    const dst = ops[0];
    const mask = opName(dst)[0] === 'x' ? MASK64 : MASK32;
    this.setReg(dst, (~BigInt(ops[1])) & mask);
  }

  op_movk(ops) {
    const dst = ops[0];
    const mask = opName(dst)[0] === 'x' ? MASK64 : MASK32;
    // 注意取「未移位」的原始 16 位立即数，再自己左移 ——
    // 若先 immVal() 再 &0xFFFF，移位结果会被抹掉
    const raw = Array.isArray(ops[1]) ? BigInt(ops[1][0]) : BigInt(ops[1]);
    const sh = (Array.isArray(ops[1]) && typeof ops[1][0] === 'number') ? BigInt(ops[1][2]) : 0n;
    const cur = this.getReg(dst);
    this.setReg(dst, ((cur & ~(0xFFFFn << sh)) | ((raw & 0xFFFFn) << sh)) & mask);
  }

  _shift(ops, fn) {
    const dst = ops[0];
    const is64 = opName(dst)[0] === 'x';
    const mask = is64 ? MASK64 : MASK32;
    const w = is64 ? 64 : 32;
    const a = this.getReg(ops[1]) & mask;
    const b = isImm(ops[2])
      ? Number(immVal(ops[2]))
      : Number(this.getReg(opName(ops[2])) & BigInt(w - 1));
    this.setReg(dst, fn(a, b, mask, w));
  }

  op_lsl(ops) { this._shift(ops, (a, b, m) => (a << BigInt(b)) & m); }
  op_lsr(ops) { this._shift(ops, (a, b, m) => (a & m) >> BigInt(b)); }
  op_asr(ops) { this._shift(ops, (a, b, m, w) => (sgn(a, w) >> BigInt(b)) & m); }

  op_ror(ops) {
    this._shift(ops, (a, b, m, w) => {
      const s = b & (w - 1);
      if (!s) return a;
      return ((a >> BigInt(s)) | (a << BigInt(w - s))) & m;
    });
  }

  op_mul(ops) {
    const dst = ops[0];
    const mask = opName(dst)[0] === 'x' ? MASK64 : MASK32;
    this.setReg(dst, (this.getReg(ops[1]) * this.getReg(ops[2])) & mask);
  }

  op_madd(ops) {
    const dst = ops[0];
    const mask = opName(dst)[0] === 'x' ? MASK64 : MASK32;
    this.setReg(dst, (this.getReg(ops[3]) + this.getReg(ops[1]) * this.getReg(ops[2])) & mask);
  }

  op_msub(ops) {
    const dst = ops[0];
    const mask = opName(dst)[0] === 'x' ? MASK64 : MASK32;
    this.setReg(dst, (this.getReg(ops[3]) - this.getReg(ops[1]) * this.getReg(ops[2])) & mask);
  }

  op_smulh(ops) {
    const a = sgn(this.getReg(ops[1]), 64);
    const b = sgn(this.getReg(ops[2]), 64);
    this.setReg(ops[0], ((a * b) >> 64n) & MASK64);
  }

  op_umulh(ops) {
    const a = this.getReg(ops[1]);
    const b = this.getReg(ops[2]);
    this.setReg(ops[0], ((a * b) >> 64n) & MASK64);
  }

  op_umull(ops) {
    const a = this.getReg(ops[1]) & MASK32;
    const b = this.getReg(ops[2]) & MASK32;
    this.setReg(ops[0], (a * b) & MASK64);
  }

  op_smull(ops) {
    const a = sgn(this.getReg(ops[1]), 32);
    const b = sgn(this.getReg(ops[2]), 32);
    this.setReg(ops[0], (a * b) & MASK64);
  }

  op_ubfx(ops) {
    const src = this.getReg(ops[1]);
    const lsb = BigInt(ops[2]);
    const width = BigInt(ops[3]);
    this.setReg(ops[0], (src >> lsb) & ((1n << width) - 1n));
  }

  op_sbfx(ops) {
    const src = this.getReg(ops[1]);
    const lsb = BigInt(ops[2]);
    const width = BigInt(ops[3]);
    let v = (src >> lsb) & ((1n << width) - 1n);
    if ((v >> (width - 1n)) & 1n) v -= (1n << width);
    this.setReg(ops[0], v & MASK64);
  }

  op_ubfiz(ops) {
    const src = this.getReg(ops[1]);
    const lsb = BigInt(ops[2]);
    const width = BigInt(ops[3]);
    this.setReg(ops[0], ((src & ((1n << width) - 1n)) << lsb) & MASK64);
  }

  op_bfi(ops) {
    const dst = ops[0];
    const mask = opName(dst)[0] === 'x' ? MASK64 : MASK32;
    const cur = this.getReg(dst);
    const src = this.getReg(ops[1]);
    const lsb = BigInt(ops[2]);
    const width = BigInt(ops[3]);
    const field = ((1n << width) - 1n) << lsb;
    this.setReg(dst, ((cur & ~field) | ((src << lsb) & field)) & mask);
  }

  op_bfxil(ops) {
    const dst = ops[0];
    const mask = opName(dst)[0] === 'x' ? MASK64 : MASK32;
    const cur = this.getReg(dst);
    const src = this.getReg(ops[1]);
    const lsb = BigInt(ops[2]);
    const width = BigInt(ops[3]);
    const field = ((1n << width) - 1n) << lsb;
    this.setReg(dst, ((cur & ~field) | (src & field)) & mask);
  }

  op_csel(ops, condIdx) {
    this.setReg(ops[0], this.testCond(D.conds[condIdx]) ? this.getReg(ops[1]) : this.getReg(ops[2]));
  }

  op_csinc(ops, condIdx) {
    const dst = ops[0];
    const mask = opName(dst)[0] === 'x' ? MASK64 : MASK32;
    const a = this.getReg(ops[1]);
    const b = this.getReg(ops[2]);
    this.setReg(dst, this.testCond(D.conds[condIdx]) ? a : (b + 1n) & mask);
  }

  op_csinv(ops, condIdx) {
    const dst = ops[0];
    const mask = opName(dst)[0] === 'x' ? MASK64 : MASK32;
    const a = this.getReg(ops[1]);
    const b = this.getReg(ops[2]);
    this.setReg(dst, this.testCond(D.conds[condIdx]) ? a : (~b) & mask);
  }

  op_csneg(ops, condIdx) {
    const dst = ops[0];
    const mask = opName(dst)[0] === 'x' ? MASK64 : MASK32;
    const a = this.getReg(ops[1]);
    const b = this.getReg(ops[2]);
    this.setReg(dst, this.testCond(D.conds[condIdx]) ? a : (-b) & mask);
  }

  op_cinc(ops, condIdx) {
    // CINC Rd, Rn, cond == CSINC Rd, Rn, Rn, invert(cond)
    //   ⇒ cond 成立取 Rn+1，否则取 Rn
    const dst = ops[0];
    const mask = opName(dst)[0] === 'x' ? MASK64 : MASK32;
    const a = this.getReg(ops[1]);
    this.setReg(dst, this.testCond(D.conds[condIdx]) ? (a + 1n) & mask : a);
  }

  op_cinv(ops, condIdx) {
    const dst = ops[0];
    const mask = opName(dst)[0] === 'x' ? MASK64 : MASK32;
    const a = this.getReg(ops[1]);
    this.setReg(dst, this.testCond(D.conds[condIdx]) ? a : (~a) & mask);
  }

  op_cneg(ops, condIdx) {
    const dst = ops[0];
    const mask = opName(dst)[0] === 'x' ? MASK64 : MASK32;
    const a = this.getReg(ops[1]);
    this.setReg(dst, this.testCond(D.conds[condIdx]) ? a : (-a) & mask);
  }

  op_cset(ops, condIdx) {
    this.setReg(ops[0], this.testCond(D.conds[condIdx]) ? 1n : 0n);
  }

  op_csetm(ops, condIdx) {
    const dst = ops[0];
    const is64 = opName(dst)[0] === 'x';
    this.setReg(dst, this.testCond(D.conds[condIdx]) ? (is64 ? MASK64 : MASK32) : 0n);
  }

  op_rbit(ops) {
    const dst = ops[0];
    const is64 = opName(dst)[0] === 'x';
    const w = is64 ? 64 : 32;
    let v = this.getReg(ops[1]) & ((1n << BigInt(w)) - 1n);
    let out = 0n;
    for (let i = 0; i < w; i++) {
      if ((v >> BigInt(i)) & 1n) out |= 1n << BigInt(w - 1 - i);
    }
    this.setReg(dst, out);
  }

  op_mrs(ops) {
    // 这段代码里 mrs 只读 tpidr_el0（栈保护用）
    this.setReg(ops[0], BigInt(D.tlsBase));
  }

  op_msr() { /* no-op */ }

  op_adrp(ops) { this.setReg(ops[0], BigInt(ops[1])); }
  op_adr(ops) { this.setReg(ops[0], BigInt(ops[1])); }

  // ---- NEON ----
  _vec(a, b, fn, width) {
    return fn(a, b) & ((1n << BigInt(width)) - 1n);
  }

  op_dup(ops) {
    const dst = ops[0];
    let sh = shapeOf(dst);
    if (!sh) sh = [Number(opName(dst).slice(1)), 128, 1, null];
    const esize = sh[1];
    const count = sh[2];
    const srcOp = ops[1];
    const srcName = Array.isArray(srcOp) ? srcOp[0] : srcOp;
    let val;
    if (srcName[0] === 'w' || srcName[0] === 'x') {
      val = this.getReg(srcName) & ((1n << BigInt(esize)) - 1n);
    } else {
      const s2 = shapeOf(srcOp);
      const shift = BigInt(s2[3] == null ? 0 : s2[3]) * BigInt(s2[1]);
      val = (this.v[s2[0]] >> shift) & ((1n << BigInt(esize)) - 1n);
    }
    let out = 0n;
    for (let i = 0; i < count; i++) out |= val << BigInt(i * esize);
    this.v[Number(opName(dst).slice(1))] = out & MASK128;
  }

  op_movi(ops) {
    const dst = ops[0];
    const sh = shapeOf(dst);
    const esize = sh[1];
    const count = sh[2];
    const imm = BigInt(ops[1]) & ((1n << BigInt(Math.min(esize, 64))) - 1n);
    let out = 0n;
    for (let i = 0; i < count; i++) out |= imm << BigInt(i * esize);
    this.v[Number(opName(dst).slice(1))] = out & MASK128;
  }

  op_fmov(ops) {
    const dst = ops[0];
    const src = ops[1];
    const dIdx = Number(opName(dst).slice(1));
    const sIdx = Number(opName(src).slice(1));
    if ((opName(dst)[0] === 'w' || opName(dst)[0] === 'x') && opName(src)[0] === 's') {
      this.setReg(dst, this.v[sIdx] & MASK32);
    } else if (opName(dst)[0] === 's' && (opName(src)[0] === 'w' || opName(src)[0] === 'x')) {
      this.v[dIdx] = this.getReg(src) & MASK32;
    } else if (opName(dst)[0] === 'd' && (opName(src)[0] === 'w' || opName(src)[0] === 'x')) {
      this.v[dIdx] = this.getReg(src) & MASK64;
    } else if ((opName(dst)[0] === 'w' || opName(dst)[0] === 'x') && opName(src)[0] === 'd') {
      this.setReg(dst, this.v[sIdx] & (opName(dst)[0] === 'w' ? MASK32 : MASK64));
    } else {
      throw new Error('fmov 未支持');
    }
  }

  _shll(ops, high) {
    const dst = ops[0];
    const dsh = shapeOf(dst);
    const ssh = shapeOf(ops[1]);
    const shift = BigInt(ops[2]);
    let src = this.v[ssh[0]];
    if (high) src >>= 64n;
    const se = BigInt(ssh[1]);
    const sm = (1n << se) - 1n;
    let out = 0n;
    for (let i = 0; i < ssh[2]; i++) {
      const v = (src >> (BigInt(i) * se)) & sm;
      out |= (v << shift) << (BigInt(i) * BigInt(dsh[1]));
    }
    this.v[Number(opName(dst).slice(1))] = out & MASK128;
  }

  op_ushll(ops) { this._shll(ops, false); }
  op_ushll2(ops) { this._shll(ops, true); }
  op_shll(ops) { this._shll(ops, false); }
  op_shll2(ops) { this._shll(ops, true); }

  _vecPerElem(ops, fn, withImm) {
    const dst = ops[0];
    const sh = shapeOf(dst);
    const esize = sh[1];
    const count = sh[2];
    const m = (1n << BigInt(esize)) - 1n;
    const a = this.v[Number(opName(ops[1]).slice(1))];
    let b;
    let bImm = null;
    if (typeof ops[2] === 'number') bImm = BigInt(ops[2]);
    else b = this.v[Number(opName(ops[2]).slice(1))];
    let out = 0n;
    for (let i = 0; i < count; i++) {
      const x = (a >> BigInt(i * esize)) & m;
      const y = bImm != null ? bImm : (b >> BigInt(i * esize)) & m;
      out |= (fn(x, y, m) & m) << BigInt(i * esize);
    }
    this.v[Number(opName(dst).slice(1))] = out & MASK128;
  }

  /**
   * 向量按位运算。
   *
   * ⚠️ 必须按「元素位宽 × 元素个数」截断 —— 一律按 128 位算会让 `orr v0.8b, ...`
   * 的高 64 位留下源寄存器的脏数据，后面 `mov w9, v0.s[1]` 就读到它。
   */
  _vecLogic(ops, fn) {
    const dst = ops[0];
    const sh = shapeOf(dst);
    const width = sh ? Math.min(128, sh[1] * sh[2]) : 128;
    const a = this.v[Number(opName(ops[1]).slice(1))];
    const b = this.v[Number(opName(ops[2]).slice(1))];
    this.v[Number(opName(dst).slice(1))] = fn(a, b) & ((1n << BigInt(width)) - 1n);
  }

  op_ushr(ops) {
    const dst = ops[0];
    const sh = shapeOf(dst);
    const esize = sh[1];
    const count = sh[2];
    const m = (1n << BigInt(esize)) - 1n;
    const src = this.v[Number(opName(ops[1]).slice(1))];
    const shift = BigInt(ops[2]);
    let out = 0n;
    for (let i = 0; i < count; i++) {
      const v = (src >> BigInt(i * esize)) & m;
      out |= ((v >> shift) & m) << BigInt(i * esize);
    }
    this.v[Number(opName(dst).slice(1))] = out & MASK128;
  }

  op_shr(ops) {
    const dst = ops[0];
    const sh = shapeOf(dst);
    const esize = sh[1];
    const count = sh[2];
    const m = (1n << BigInt(esize)) - 1n;
    const src = this.v[Number(opName(ops[1]).slice(1))];
    const shift = BigInt(ops[2]);
    let out = 0n;
    for (let i = 0; i < count; i++) {
      const v = (src >> BigInt(i * esize)) & m;
      out |= ((sgn(v, esize) >> shift) & m) << BigInt(i * esize);
    }
    this.v[Number(opName(dst).slice(1))] = out & MASK128;
  }

  op_shl(ops) {
    const dst = ops[0];
    const sh = shapeOf(dst);
    const esize = sh[1];
    const count = sh[2];
    const m = (1n << BigInt(esize)) - 1n;
    const src = this.v[Number(opName(ops[1]).slice(1))];
    const shift = BigInt(ops[2]);
    let out = 0n;
    for (let i = 0; i < count; i++) {
      const v = (src >> BigInt(i * esize)) & m;
      out |= ((v << shift) & m) << BigInt(i * esize);
    }
    this.v[Number(opName(dst).slice(1))] = out & MASK128;
  }

  op_ushl(ops) {
    const dst = ops[0];
    const sh = shapeOf(dst);
    const esize = sh[1];
    const count = sh[2];
    const m = (1n << BigInt(esize)) - 1n;
    const a = this.v[Number(opName(ops[1]).slice(1))];
    const b = this.v[Number(opName(ops[2]).slice(1))];
    let out = 0n;
    for (let i = 0; i < count; i++) {
      const x = (a >> BigInt(i * esize)) & m;
      let s = Number((b >> BigInt(i * esize)) & 0xFFn);
      if (s >= 0x80) s -= 0x100;
      const y = s >= 0 ? (x << BigInt(s)) & m : (x >> BigInt(-s)) & m;
      out |= y << BigInt(i * esize);
    }
    this.v[Number(opName(dst).slice(1))] = out & MASK128;
  }

  op_ext(ops) {
    const dst = ops[0];
    const a = this.v[Number(opName(ops[1]).slice(1))];
    const b = this.v[Number(opName(ops[2]).slice(1))];
    const idx = BigInt(ops[3]);
    const concat = (b << 128n) | a;
    this.v[Number(opName(dst).slice(1))] = (concat >> (idx * 8n)) & MASK128;
  }

  op_mvn_v(ops) {
    const dst = ops[0];
    const sh = shapeOf(dst);
    const width = Math.min(128, sh[1] * sh[2]);
    this.v[Number(opName(dst).slice(1))] = (~this.v[Number(opName(ops[1]).slice(1))]) & ((1n << BigInt(width)) - 1n);
  }

  // ---- 外部符号 ----
  callExtern(name) {
    this.calls.push(name);
    const lr = Number(this.x[30]);
    if (name === 'time@LIBC' || name === 'time') {
      const t = this.timeValue;
      const ptr = Number(this.x[0]);
      if (ptr) this.mem.writeU64(ptr, t);
      this.x[0] = t;
    } else if (name.indexOf('basic_ostream') >= 0 && name.indexOf('lsEj') >= 0) {
      // std::ostream& operator<<(unsigned int)
      this.outU32.push(Number(this.x[1] & MASK32));
    } else if (name.indexOf('_Znwm') === 0 || name.indexOf('_Znam') === 0) {
      // operator new —— 必须真分配：否则调用方把「返回的字节数」当指针用，
      // 会把 so 的代码段砸烂。
      const size = Number(this.x[0]);
      const p = this.heapPtr;
      this.heapPtr = (this.heapPtr + (size > 0 ? size : 1) + 15) & ~0xF;
      this.x[0] = BigInt(p);
    }
    // 其余（delete / iostream 生命周期 / string 工具）无副作用
    this.pc = lr;
  }
}

/** so 内容按路径缓存（两套各读一次即可，避免每轮都读 900KB）。 */
const soCache = new Map();
function soBufferFor(p) {
  let b = soCache.get(p);
  if (!b) { b = fs.readFileSync(p); soCache.set(p, b); }
  return b;
}

/**
 * 算出给定时刻的 T 串（78 个 unsigned 的十进制拼接）。
 *
 * @param {number} epochSec Unix 秒（模拟 `time()`；同一分钟内结果相同）
 * @param {'exercise'|'pk'} [variant] 用哪套签名资产，默认 `exercise`（见文件头表格）
 * @returns {string} T
 */
function calcT(epochSec, variant) {
  // 切换模块级的指令表与 so 路径（同步执行，安全 —— 见上方 require 处注释）
  if (variant === 'pk') {
    if (!PK_INSNS) PK_INSNS = require(PK_INSNS_PATH);
    D = PK_INSNS;
    SO_PATH = PK_SO_PATH;
  } else {
    D = EX_INSNS;
    SO_PATH = EX_SO_PATH;
  }
  const emu = new Emu(soBufferFor(SO_PATH));
  emu.timeValue = BigInt(Math.floor(epochSec));
  emu.x[8] = BigInt(D.sretBuf);   // sret 缓冲（std::string 返回值）
  emu.x[1] = 0n;                  // ts 参数
  emu.x[0] = 0n;
  emu.sp = BigInt(D.stackTop);
  try {
    emu.run(D.tEntry);
  } catch (e) {
    // 尾部还有 ostringstream 析构等收尾代码；只要 78 个 `<<` 参数收满，
    // 结果就已完整（真机抓包 fixture 已逐字节验证过）。
    if (emu.outU32.length !== 78) throw e;
  }
  return emu.outU32.join('');
}

module.exports = { calcT, Emu, SO_PATH };
