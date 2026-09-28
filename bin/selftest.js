'use strict';
// 命令行自检：不开服务，直接验证 native 资产 + sign 公式 + PK body 组装。
//
// 用法：node bin/selftest.js

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const nativeLib = require(path.join(root, 'src', 'native'));
const signLib = require(path.join(root, 'src', 'sign'));
const engine = require(path.join(root, 'src', 'pk-engine'));
const { config } = require(path.join(root, 'src', 'config'));

let failed = 0;

/**
 * 能不能跑「原生」检查（sign / 内容编码）。
 *
 * `bin/native/` 里是 **arm64 的 Android 库**，只有在 arm64 环境（手机 / Apple Silicon
 * / arm64 容器）才跑得起来。GitHub 的默认 runner 是 x86_64 Linux，所以那里必须跳过
 * —— 否则 CI 会红，而红的原因是「架构不对」而不是「代码坏了」。
 *
 * 可用 `PK_SKIP_NATIVE=1` 强制跳过；`PK_FORCE_NATIVE=1` 强制尝试。
 */
const CAN_RUN_NATIVE = process.env.PK_FORCE_NATIVE === '1'
  ? true
  : (process.env.PK_SKIP_NATIVE !== '1' && process.arch === 'arm64');

function check(name, ok, detail) {
  console.log((ok ? '  [OK]   ' : '  [FAIL] ') + name + (detail ? ' → ' + detail : ''));
  if (!ok) failed++;
}

function skip(name, why) {
  console.log('  [SKIP] ' + name + ' —— ' + why);
}

console.log('== pk-node 自检 ==');
console.log('项目目录: ' + root);
console.log('native  : ' + config.nativeDir);
console.log('平台    : ' + process.platform + '/' + process.arch +
  (CAN_RUN_NATIVE ? '' : '（未强制跑原生 sign）'));
console.log('');

console.log('1) 编码链路（纯 JS，必需） + sign（按 PK_SIGN_MODE）');
const nt = (() => {
  try { return nativeLib.selfTest(); } catch (e) { return { ok: false, detail: e.message }; }
})();
check('编码链路自检', nt.ok, nt.detail);
if (nt.ok) {
  console.log('        signMode = ' + (nt.signMode || config.signMode || 'off'));
  if (nt.sample) check('sign 可算（示例）', /^[0-9a-f]{32}$/.test(nt.sample), nt.sample);
}

console.log('');
console.log('2) sign 公式（纯 JS，对照历史真机样本）');
const sg = signLib.verifyWithFixture();
check('chainMd5 4 轮公式', sg.ok, sg.ok ? sg.got : 'expect ' + sg.expect + ' got ' + sg.got);

console.log('');
console.log('3) 提交体结构（对照真机 ground truth）');
const match = {
  pkIdStr: 'TEST',
  examVO: {
    pointId: 1951,
    pointName: '5以内比大小',
    ruleType: -7,
    questions: [{ id: 1, examId: 1, answer: '>', answers: ['>', '<'], ruleType: 'COMPARE' }],
  },
};
let body = null;
try {
  body = engine.buildSubmitBody(match, { seedBase: 1, costTimeMs: 100 });
} catch (e) {
  check('buildSubmitBody', false, e.message);
}
if (body) {
  check('顶层字段 = pkIdStr/pointId/pointName/ruleType/questionCnt/correctCnt/costTime/questions',
    Object.keys(body).join(',') === 'pkIdStr,pointId,pointName,ruleType,questionCnt,correctCnt,costTime,questions');
  check('无 examVO / userInfos / updatedTime 嵌套',
    !('examVO' in body) && !('userInfos' in body) && !('updatedTime' in body));
  const q = body.questions[0];
  check('script 与 pathPoints 同源', q.script === JSON.stringify(q.curTrueAnswer.pathPoints));
  check('curTrueAnswer 四字段',
    Object.keys(q.curTrueAnswer).join(',') === 'recognizeResult,pathPoints,answer,showReductionFraction');
}

console.log('');
console.log('4) 内容编码器（纯 JS 密钥流 + 可选原生对拍）');
const sampleGz = path.join(config.nativeDir, 'pk_body.gz');
const samplePlain = process.env.PK_SAMPLE_PLAIN || '/root/alinker/pk_body.json';
const ksLib = require(path.join(root, 'src', 'keystream'));
const ksTest = ksLib.selfTest();
if (!ksTest.ok) {
  check('密钥流可用', false, ksTest.detail);
} else {
  check('密钥流可用', true, ksTest.detail);

  // 纯 JS 编码是否与「设备 gzip 口径」逐字节可复现
  if (fs.existsSync(sampleGz)) {
    const raw = fs.existsSync(samplePlain) ? fs.readFileSync(samplePlain) : null;
    if (raw) {
      const gz = nativeLib.gzipLikeDevice(raw);
      check('gzip(level6,mtime0,OS=0xff) 与样本一致', gz.equals(fs.readFileSync(sampleGz)));
      const enc = nativeLib.encodeSubmitBody(raw);
      check('纯 JS 编码长度 == gzip 长度（等长）', enc.length === gz.length, enc.length + 'B');
      check('纯 JS 编码 == XOR(gzip, 密钥流)',
        enc.equals(ksLib.xorEncode(gz)));
      // 超长必须明确报错，不能静默截断
      let threw = false;
      try { ksLib.xorEncode(Buffer.alloc(ksLib.length() + 1)); } catch (e) { threw = true; }
      check('超长输入会明确报错（不静默截断）', threw);
    } else {
      skip('与样本对拍', '缺 ' + samplePlain);
    }
  } else {
    skip('与样本对拍', '缺 ' + sampleGz);
  }
}

console.log('');
console.log('5) 登录 RSA 编码器（原版硬编码公钥）');
const rsa = require(path.join(root, 'src', 'crypto-rsa'));
const rt = rsa.selfTest();
check('RSA 1024 / PKCS#1 可用', rt.ok, rt.detail);
check('手机号格式校验', rsa.isValidPhone('13800138000') && !rsa.isValidPhone('123'));
check('两次加密密文不同（PKCS#1 随机填充，预期行为）',
  rsa.encrypt('13800138000') !== rsa.encrypt('13800138000'));

console.log('');
console.log('6) 画笔算法（ARC 弧线 / SEVEN_SEGMENT 七段码）');
const strokeLib = require(path.join(root, 'src', 'strokes'));
const st = strokeLib.selfTest();
check('两种模式都能出笔迹 + ARC 遇非比较题回落', st.ok, st.detail);
const arcPt = strokeLib.buildPathPoints('>', 42, strokeLib.STROKE_MODES.ARC);
check('ARC 坐标是像素口径（x>100）', arcPt.strokes[0][0].x > 100, 'x=' + arcPt.strokes[0][0].x);
const segPt = strokeLib.buildPathPoints('78', 42, strokeLib.STROKE_MODES.SEVEN_SEGMENT);
check('七段码按字符分格（2 字符 → 2 笔）', segPt.strokes.length === 2);

console.log('');
console.log('7) 模块导出完整性（防「漏导出」这类只在运行时才炸的错）');
// 起因：把 leo.pkSubmit 拆成 pkSubmitRaw + pkSubmit 时，漏了把 pkSubmitRaw 加进
// module.exports，结果第 1 轮直接挂 "leo.pkSubmitRaw is not a function"。
// 这种错静态检查抓不到、只有真跑才暴露 —— 所以在这里钉死。
const leoLib = require(path.join(root, 'src', 'leo'));
const REQUIRED_LEO = [
  'buildUrl', 'pkMatch', 'pkSubmit', 'pkSubmitRaw', 'pkHistoryDetail', 'pkHome',
  'userInfosContext', 'subAccountsBatchGet', 'ytkUserProfile', 'switchSubAccount',
  'ytkSmsVerify', 'ytkSmsLogin', 'ytkPasswordLogin', 'CookieJar',
];
const missingLeo = REQUIRED_LEO.filter((k) => typeof leoLib[k] === 'undefined');
check('leo.js 导出齐全', missingLeo.length === 0,
  missingLeo.length === 0 ? REQUIRED_LEO.length + ' 项' : '缺少 ' + missingLeo.join(', '));

// 练习协议层（/leo-star /leo-math；417 已破，version 必须 3.140.1）
const exLib = require(path.join(root, 'src', 'exercise'));
const REQUIRED_EX = ['buildExerciseUrl', 'exerciseHeaders', 'overview', 'getExam', 'attend', 'pumpScore', 'readScore', 'runPractice', 'practiceLoop', 'submitExam', 'answerAll'];
const missingEx = REQUIRED_EX.filter((k) => typeof exLib[k] !== 'function');
check('exercise.js 导出齐全', missingEx.length === 0,
  missingEx.length === 0 ? REQUIRED_EX.length + ' 项' : '缺少 ' + missingEx.join(', '));

// 练习 URL 必须带 version=3.140.1 + platform=android37（否则 417）
{
  const u = exLib.buildExerciseUrl('/leo-star/android/exercise/homepage');
  const okVer = u.includes('version=3.140.1');
  const okPlat = u.includes('platform=android37');
  const okProd = u.includes('_productId=611');
  check('练习参数 version=3.140.1 / platform=android37 / _productId=611',
    okVer && okPlat && okProd,
    (okVer ? '' : 'version 错 ') + (okPlat ? '' : 'platform 错 ') + (okProd ? '' : '_productId 错 '));
}

const engineLib = require(path.join(root, 'src', 'pk-engine'));
const REQUIRED_ENGINE = ['makePath', 'buildSubmitBody', 'pickAnswer', 'isRateLimited', 'backoffMs', 'runOneRound'];
const missingEngine = REQUIRED_ENGINE.filter((k) => typeof engineLib[k] === 'undefined');
check('pk-engine.js 导出齐全', missingEngine.length === 0,
  missingEngine.length === 0 ? REQUIRED_ENGINE.length + ' 项' : '缺少 ' + missingEngine.join(', '));

const jobsLib = require(path.join(root, 'src', 'jobs'));
const REQUIRED_JOBS = ['startJob', 'stopJob', 'subscribe', 'publish', 'bufferedEvents', 'isBusy'];
const missingJobs = REQUIRED_JOBS.filter((k) => typeof jobsLib[k] === 'undefined');
// ---- cookie 加密 + 设备链池 ----
const cookiecrypt = require(path.join(root, 'src', 'cookiecrypt'));
const ct = cookiecrypt.selfTest();
check('cookie 加密（AES-256-GCM）往返一致', ct.ok, ct.detail + ' | 密钥来源: ' + ct.mode);
const encSample = cookiecrypt.encryptValue('ks_deviceid=352949417');
check('密文不含明文', encSample.indexOf('352949417') < 0 && encSample.indexOf(cookiecrypt.PREFIX) === 0);
const laLib = require(path.join(root, 'src', 'services', 'leo-accounts'));
check('设备链解析 extractDeviceChain',
  !!laLib.extractDeviceChain('ks_deviceid=1; ks_r=2; ks_u=3') &&
  laLib.extractDeviceChain('sess=abc') === null);

check('jobs.js 导出齐全', missingJobs.length === 0,
  missingJobs.length === 0 ? REQUIRED_JOBS.length + ' 项' : '缺少 ' + missingJobs.join(', '));

console.log('');
console.log(failed === 0 ? '全部通过 ✔' : ('有 ' + failed + ' 项失败 ✘'));
process.exit(failed === 0 ? 0 : 1);