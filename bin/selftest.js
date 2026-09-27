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

function check(name, ok, detail) {
  console.log((ok ? '  [OK]   ' : '  [FAIL] ') + name + (detail ? ' → ' + detail : ''));
  if (!ok) failed++;
}

console.log('== pk-node 自检 ==');
console.log('项目目录: ' + root);
console.log('native  : ' + config.nativeDir);
console.log('');

console.log('1) native 资产与 sign');
const nt = nativeLib.selfTest();
check('native 链路', nt.ok, nt.ok ? '样例 sign ' + nt.sample : nt.detail);

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
console.log('4) 内容编码器（密文逐字节对齐真机，若样本在）');
const sampleGz = path.join(config.nativeDir, 'pk_body.gz');
const samplePlain = '/root/alinker/pk_body.json';
if (fs.existsSync(sampleGz) && fs.existsSync(samplePlain)) {
  const raw = fs.readFileSync(samplePlain);
  const gz = nativeLib.gzipLikeDevice(raw);
  check('gzip(level6,mtime0,OS=0xff) 与样本一致', gz.equals(fs.readFileSync(sampleGz)));
  const enc = nativeLib.encodeSubmitBody(raw);
  check('c(gzip) 长度与 gzip 相同（等长变换）', enc.length === gz.length, enc.length + 'B');
} else {
  console.log('  [SKIP] 无样本（bin/native/pk_body.gz 或 /root/alinker/pk_body.json 缺失）');
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
  'buildUrl', 'pkMatch', 'pkSubmit', 'pkSubmitRaw', 'pkHome',
  'userInfosContext', 'subAccountsBatchGet', 'ytkUserProfile', 'switchSubAccount',
  'ytkSmsVerify', 'ytkSmsLogin', 'ytkPasswordLogin', 'CookieJar',
];
const missingLeo = REQUIRED_LEO.filter((k) => typeof leoLib[k] === 'undefined');
check('leo.js 导出齐全', missingLeo.length === 0,
  missingLeo.length === 0 ? REQUIRED_LEO.length + ' 项' : '缺少 ' + missingLeo.join(', '));

const engineLib = require(path.join(root, 'src', 'pk-engine'));
const REQUIRED_ENGINE = ['makePath', 'buildSubmitBody', 'pickAnswer', 'isRateLimited', 'backoffMs', 'runOneRound'];
const missingEngine = REQUIRED_ENGINE.filter((k) => typeof engineLib[k] === 'undefined');
check('pk-engine.js 导出齐全', missingEngine.length === 0,
  missingEngine.length === 0 ? REQUIRED_ENGINE.length + ' 项' : '缺少 ' + missingEngine.join(', '));

const jobsLib = require(path.join(root, 'src', 'jobs'));
const REQUIRED_JOBS = ['startJob', 'stopJob', 'subscribe', 'publish', 'bufferedEvents', 'isBusy'];
const missingJobs = REQUIRED_JOBS.filter((k) => typeof jobsLib[k] === 'undefined');
check('jobs.js 导出齐全', missingJobs.length === 0,
  missingJobs.length === 0 ? REQUIRED_JOBS.length + ' 项' : '缺少 ' + missingJobs.join(', '));

console.log('');
console.log(failed === 0 ? '全部通过 ✔' : ('有 ' + failed + ' 项失败 ✘'));
process.exit(failed === 0 ? 0 : 1);