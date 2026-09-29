'use strict';
// pk-node 前端。原生 JS，无框架、无构建。

/* ------------------------------ 基础 ------------------------------ */

const $ = (id) => document.getElementById(id);

/** 统一的 API 调用：自动带 cookie，非 2xx 抛错并带 message。 */
async function api(path, options) {
  const opt = Object.assign({ credentials: 'same-origin' }, options || {});
  if (opt.body && typeof opt.body !== 'string') {
    opt.headers = Object.assign({ 'Content-Type': 'application/json' }, opt.headers || {});
    opt.body = JSON.stringify(opt.body);
  }
  const res = await fetch(path, opt);
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    const msg = (data && data.message) || ('HTTP ' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(msg, kind) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast ' + (kind || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast hidden'; }, 4000);
}

/** 往日志容器追加一行并滚到底。 */
function logLine(container, text, cls) {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = text;
  // 心跳行靠 data-tick 标记，便于原地更新而不是刷屏
  if (!div.dataset) div.dataset = {};
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* ------------------------------ 状态 ------------------------------ */

const state = {
  user: null,
  leoAccounts: [],
  subs: [],
  currentJobId: null,
  jobStream: null,
  pollTimer: null,
  streamErrorNotified: false,
  seenRounds: new Set(),
  practiceStream: null,
};

/* ------------------------------ 登录 ------------------------------ */

function showView(name) {
  $('view-auth').classList.toggle('hidden', name !== 'auth');
  $('view-app').classList.toggle('hidden', name !== 'app');
}

async function refreshMe() {
  const r = await api('/api/auth/me');
  state.user = r.user;
  if (!r.user) { showView('auth'); return false; }
  showView('app');
  $('who').textContent = r.user.username + (r.user.role === 'admin' ? '（管理员）' : '');
  document.querySelectorAll('.admin-only').forEach((el) => {
    el.classList.toggle('hidden', r.user.role !== 'admin');
  });
  return true;
}

$('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/auth/login', { method: 'POST', body: { username: $('login-user').value, password: $('login-pass').value } });
    toast('登录成功', 'ok');
    if (await refreshMe()) { await bootstrapAfterLogin(); }
  } catch (err) { toast(err.message, 'err'); }
});

$('form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/auth/register', { method: 'POST', body: { username: $('reg-user').value, password: $('reg-pass').value } });
    toast('注册成功，正在登录…', 'ok');
    await api('/api/auth/login', { method: 'POST', body: { username: $('reg-user').value, password: $('reg-pass').value } });
    if (await refreshMe()) { await bootstrapAfterLogin(); }
  } catch (err) { toast(err.message, 'err'); }
});

document.querySelectorAll('[data-auth-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-auth-tab]').forEach((b) => b.classList.toggle('active', b === btn));
    const isLogin = btn.dataset.authTab === 'login';
    $('form-login').classList.toggle('hidden', !isLogin);
    $('form-register').classList.toggle('hidden', isLogin);
  });
});

$('btn-logout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* 忽略 */ }
  location.reload();
});

/* --------------------------- 顶部导航 --------------------------- */

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
    ['grind', 'pkpage', 'practice', 'accounts', 'jobs', 'tunnel', 'admin'].forEach((t) => {
      $('tab-' + t).classList.toggle('hidden', t !== btn.dataset.tab);
    });
    const t = btn.dataset.tab;
    if (t === 'pkpage') { loadPkPage(); }
    if (t === 'practice') { loadPractice(); }
    if (t === 'accounts') { loadDeviceChains(); }
    if (t === 'accounts') { loadLeoAccounts(); }
    if (t === 'jobs') { loadJobs(); }
    if (t === 'tunnel') { loadTunnel(); }
    if (t === 'admin') { loadAdmin(); }
  });
});

/* ------------------------- PK 页面（H5 容器） ------------------------- */

/**
 * 填充 PK 页的账号/子账号下拉。
 *
 * 复用 [state.leoAccounts]（bootstrapAfterLogin 已拉过），避免重复请求。
 */
async function loadPkPage() {
  if (!state.leoAccounts || state.leoAccounts.length === 0) {
    try {
      const r = await api('/api/leo/accounts');
      state.leoAccounts = r.accounts || [];
    } catch (e) { /* 忽略 */ }
  }
  const sel = $('pkpage-leo');
  const prev = sel.value;
  sel.innerHTML = '';
  const list = state.leoAccounts || [];
  if (list.length === 0) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '（尚未导入小猿账号）';
    sel.appendChild(o);
    $('pkpage-hint').textContent = '先去「小猿账号」页导入一个账号（短信 / 密码 / 粘贴 cookie 都行）。';
    return;
  }
  for (const a of list) {
    const o = document.createElement('option');
    o.value = String(a.id);
    o.textContent = a.name + '（uid ' + (a.yfdU || '?') + '）';
    sel.appendChild(o);
  }
  if (prev && list.some((a) => String(a.id) === prev)) sel.value = prev;

  await loadPkPageSubs();
  $('pkpage-hint').textContent = '点「打开 PK 页面」加载原版 H5。若页面空白，先看浏览器控制台的 __pkH5Hook。';
}

/** 拉 PK 页的子账号下拉。 */
async function loadPkPageSubs() {
  const id = Number($('pkpage-leo').value);
  const sel = $('pkpage-sub');
  sel.innerHTML = '<option value="">（当前身份）</option>';
  if (!id) return;
  try {
    const r = await api('/api/leo/accounts/' + id + '/sub-accounts');
    for (const s of (r.subs || [])) {
      const o = document.createElement('option');
      o.value = String(s.userId);
      o.textContent = (s.nickname || ('账号 ' + s.userId)) + (s.isPrimary ? '（主）' : '');
      sel.appendChild(o);
    }
  } catch (e) { /* 忽略 */ }
}

/** 打开（或重新加载）PK H5 容器。 */
function openPkPage() {
  const id = $('pkpage-leo').value;
  if (!id) return toast('先导入小猿账号', 'err');
  const frame = $('pkpage-frame');
  // 带上 leoAccountId：hook 会把它拼进 API 代理 URL，Node 用它选账号 jar
  frame.src = '/pk-h5/pk.html?leoAccountId=' + encodeURIComponent(id) + '&t=' + Date.now();
  $('pkpage-hint').textContent = '正在加载原版 PK H5…（账号 id=' + id + '）';
}

$('pkpage-leo').addEventListener('change', loadPkPageSubs);
$('pkpage-open').addEventListener('click', openPkPage);
$('pkpage-reload').addEventListener('click', openPkPage);

/* ---------------------------- 刷局页 ---------------------------- */

async function loadLeoAccounts() {
  const r = await api('/api/leo/accounts');
  state.leoAccounts = r.accounts;

  // 刷局页账号下拉
  const sel = $('grind-leo');
  const prev = sel.value;
  sel.innerHTML = '';
  if (r.accounts.length === 0) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '（尚未导入小猿账号）';
    sel.appendChild(o);
  }
  for (const a of r.accounts) {
    const o = document.createElement('option');
    o.value = String(a.id);
    o.textContent = a.name + '（uid ' + (a.yfdU || '?') + '）';
    sel.appendChild(o);
  }
  if (prev && r.accounts.some((a) => String(a.id) === prev)) sel.value = prev;

  renderLeoList(r.accounts);
  await loadSubsForSelectedLeo();
}

function renderLeoList(accounts) {
  const box = $('leo-list');
  box.innerHTML = '';
  if (accounts.length === 0) {
    box.innerHTML = '<p class="muted small">还没有导入小猿账号。</p>';
    return;
  }
  for (const a of accounts) {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML =
      '<div><div class="title"></div><div class="meta"></div></div>' +
      '<div class="actions">' +
      '<button class="mini" data-act="identity">当前身份</button>' +
      '<button class="mini" data-act="chain">复制设备链</button>' +
      '<button class="mini" data-act="refresh">刷新子账号</button>' +
      '<button class="mini" data-act="subs">查看</button>' +
      '<button class="mini danger" data-act="del">删除</button>' +
      '</div>';
    el.querySelector('.title').textContent = a.name;
    const ks = (a.cookieNames || []).filter((n) => n.indexOf('ks_') === 0);
    el.querySelector('.meta').textContent =
      'uid ' + (a.yfdU || '?') + ' · 年级 ' + (a.grade == null ? '?' : a.grade) +
      ' · cookie ' + (a.cookieNames || []).length + ' 条' +
      (ks.length ? ' · 设备链 ✓(' + ks.length + ')' : ' · 设备链 ✗（PK 刷不了，可「复制设备链」）');
    // 当前身份以服务端回包为准（子账号切换本服务做不到，见 docs）
    el.querySelector('[data-act="identity"]').addEventListener('click', async () => {
      try {
        const r = await api('/api/leo/accounts/' + a.id + '/identity');
        const cur = r.currentIdentity;
        toast(cur == null
          ? '取不到生效身份（登录态可能已失效）'
          : '实际生效身份：' + cur + (String(cur) === String(a.yfdU) ? '（与库中一致）' : '（注意：与库中 uid 不一致）'),
          cur == null ? 'err' : 'ok');
      } catch (err) { toast(err.message, 'err'); }
    });
    el.querySelector('[data-act="chain"]').addEventListener('click', async () => {
      const others = (state.leoAccounts || []).filter((x) => x.id !== a.id);
      if (others.length === 0) return toast('没有其它账号可作为设备链来源', 'err');
      const src = prompt('从哪个账号复制设备链（填序号或 id）？\n' +
        others.map((x, i) => (i + 1) + '. ' + x.name + ' (id=' + x.id + ', 设备链' +
          ((x.cookieNames || []).some((n) => n.indexOf('ks_') === 0) ? '✓' : '✗') + ')').join('\n'));
      if (!src) return;
      const idx = Number(src) - 1;
      const pick = (idx >= 0 && idx < others.length && String(Number(src)) === String(idx + 1))
        ? others[idx] : others.find((x) => String(x.id) === String(src));
      if (!pick) return toast('没找到该账号', 'err');
      try {
        const r = await api('/api/leo/accounts/' + a.id + '/device-chain', {
          method: 'POST', body: { sourceId: pick.id },
        });
        toast(r.message || '已复制设备链', r.ok ? 'ok' : 'err');
        await loadLeoAccounts();
      } catch (err) { toast(err.message, 'err'); }
    });
    el.querySelector('[data-act="refresh"]').addEventListener('click', async () => {
      try {
        const r = await api('/api/leo/accounts/' + a.id + '/refresh', { method: 'POST' });
        toast(r.message || '已刷新', r.ok ? 'ok' : 'err');
        await loadLeoAccounts();
      } catch (err) { toast(err.message, 'err'); }
    });
    el.querySelector('[data-act="subs"]').addEventListener('click', async () => {
      try {
        const r = await api('/api/leo/accounts/' + a.id + '/sub-accounts');
        toast('子账号 ' + r.subs.length + ' 个：' + r.subs.map((s) => s.nickname || s.userId).join(', '), 'ok');
      } catch (err) { toast(err.message, 'err'); }
    });
    el.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm('确定删除该小猿账号？其登录态将从本地库移除。')) return;
      try {
        await api('/api/leo/accounts/' + a.id, { method: 'DELETE' });
        toast('已删除', 'ok');
        await loadLeoAccounts();
      } catch (err) { toast(err.message, 'err'); }
    });
    box.appendChild(el);
  }
}

async function loadSubsForSelectedLeo() {
  const id = Number($('grind-leo').value);
  const sel = $('grind-sub');
  sel.innerHTML = '<option value="">（当前身份）</option>';
  if (!id) return;
  try {
    const r = await api('/api/leo/accounts/' + id + '/sub-accounts');
    for (const s of r.subs) {
      const o = document.createElement('option');
      o.value = String(s.userId);
      o.textContent = (s.nickname || ('账号 ' + s.userId)) + (s.isPrimary ? '（主）' : '');
      sel.appendChild(o);
    }
  } catch (e) { /* 忽略：不影响刷局 */ }
}

$('grind-leo').addEventListener('change', loadSubsForSelectedLeo);

/* --------------------- 小猿账号：三个添加方式的分页 --------------------- */

document.querySelectorAll('[data-leo-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-leo-tab]').forEach((b) => b.classList.toggle('active', b === btn));
    const t = btn.dataset.leoTab;
    ['sms', 'password', 'cookie'].forEach((k) => {
      $('leo-pane-' + k).classList.toggle('hidden', k !== t);
    });
    $('leo-msg').textContent = '';
  });
});

/** 短信登录会话 token（发码后由服务端下发，交码时必须带回去）。 */
let smsToken = null;

function leoMsg(text, ok) {
  const el = $('leo-msg');
  el.textContent = text;
  el.style.color = ok ? 'var(--ok)' : 'var(--danger)';
}

$('btn-sms-send').addEventListener('click', async () => {
  const phone = $('sms-phone').value.trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) return leoMsg('请输入正确的 11 位手机号', false);
  const btn = $('btn-sms-send');
  btn.disabled = true;
  btn.textContent = '发送中…';
  leoMsg('正在请求发送…', true);
  try {
    const r = await api('/api/leo/login/sms/send', { method: 'POST', body: { phone: phone, token: smsToken } });
    smsToken = r.token || smsToken;
    leoMsg(r.message, true);
    toast(r.message, r.alreadySent ? '' : 'ok');
    // 冷却态给个倒计时，避免用户狂点
    if (r.alreadySent) {
      let left = 60;
      btn.textContent = left + 's 后重发';
      const t = setInterval(() => {
        left -= 1;
        if (left <= 0) { clearInterval(t); btn.disabled = false; btn.textContent = '发送验证码'; }
        else btn.textContent = left + 's 后重发';
      }, 1000);
      return;
    }
  } catch (err) {
    leoMsg('发送失败：' + err.message, false);
    toast(err.message, 'err');
  }
  btn.disabled = false;
  btn.textContent = '发送验证码';
});

$('btn-sms-login').addEventListener('click', async () => {
  const code = $('sms-code').value.trim();
  if (!code) return leoMsg('请填写收到的验证码', false);
  if (!smsToken) return leoMsg('请先点「发送验证码」', false);
  const btn = $('btn-sms-login');
  btn.disabled = true;
  btn.textContent = '登录中…';
  try {
    const r = await api('/api/leo/login/sms/submit', {
      method: 'POST',
      body: { token: smsToken, code: code, name: $('leo-name').value },
    });
    leoMsg(r.message + (r.yfdU ? '（uid ' + r.yfdU + '）' : ''), true);
    toast('登录成功', 'ok');
    smsToken = null;
    $('sms-code').value = '';
    await loadLeoAccounts();
  } catch (err) {
    leoMsg('登录失败：' + err.message, false);
    toast(err.message, 'err');
  }
  btn.disabled = false;
  btn.textContent = '登录';
});

$('btn-pw-login').addEventListener('click', async () => {
  const phone = $('pw-phone').value.trim();
  const password = $('pw-pass').value;
  if (!/^1[3-9]\d{9}$/.test(phone)) return leoMsg('请输入正确的 11 位手机号', false);
  if (!password) return leoMsg('请输入密码', false);
  const btn = $('btn-pw-login');
  btn.disabled = true;
  btn.textContent = '登录中…';
  try {
    const r = await api('/api/leo/login/password', {
      method: 'POST',
      body: { phone: phone, password: password, name: $('leo-name').value },
    });
    leoMsg(r.message + (r.yfdU ? '（uid ' + r.yfdU + '）' : ''), true);
    toast('登录成功', 'ok');
    $('pw-pass').value = '';
    await loadLeoAccounts();
  } catch (err) {
    leoMsg('登录失败：' + err.message, false);
    toast(err.message, 'err');
  }
  btn.disabled = false;
  btn.textContent = '登录';
});

$('btn-import').addEventListener('click', async () => {
  const msg = $('leo-msg');
  msg.textContent = '导入中…';
  try {
    const r = await api('/api/leo/accounts', {
      method: 'POST',
      body: { name: $('leo-name').value || '小猿账号', cookie: $('leo-cookie').value },
    });
    msg.textContent = '导入成功：' + (r.message || '') + '（uid ' + r.yfdU + '）';
    toast('导入成功', 'ok');
    $('leo-cookie').value = '';
    await loadLeoAccounts();
  } catch (err) {
    msg.textContent = '导入失败：' + err.message;
    toast(err.message, 'err');
  }
});

$('btn-load-points').addEventListener('click', async () => {
  const id = Number($('grind-leo').value);
  if (!id) return toast('先导入小猿账号', 'err');
  const box = $('point-list');
  box.innerHTML = '<span class="muted small">拉取中…</span>';
  try {
    const r = await api('/api/pk/points?leoAccountId=' + id + '&grade=' + (state.grade || 2));
    const list = (r.home && r.home.pointList) || [];
    box.innerHTML = '';
    if (list.length === 0) { box.innerHTML = '<span class="muted small">没有知识点</span>'; return; }
    for (const p of list) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = p.pointName + ' (' + p.pointId + ')';
      c.addEventListener('click', () => { $('grind-point').value = String(p.pointId); });
      box.appendChild(c);
    }
    if (r.home && r.home.totalWinCount != null) {
      toast('本周胜场 ' + (r.home.weekWinCount || 0) + ' / 总胜场 ' + r.home.totalWinCount, 'ok');
    }
  } catch (err) {
    box.innerHTML = '';
    toast(err.message, 'err');
  }
});

$('btn-start').addEventListener('click', async () => {
  const leoAccountId = Number($('grind-leo').value);
  if (!leoAccountId) return toast('先导入小猿账号', 'err');

  const strokeEl = document.querySelector('input[name="strokeMode"]:checked');
  const body = {
    leoAccountId: leoAccountId,
    subUserId: $('grind-sub').value ? Number($('grind-sub').value) : null,
    pointId: Number($('grind-point').value || 1951),
    rounds: Number($('grind-rounds').value || 10),
    gapMinMs: Number($('grind-gapmin').value || 4000),
    gapMaxMs: Number($('grind-gapmax').value || 8000),
    submitDelayMinMs: Number($('grind-delaymin').value || 0),
    submitDelayMaxMs: Number($('grind-delaymax').value || 0),
    rateLimitBaseMs: Number($('grind-rlbase').value || 60000),
    rateLimitMaxWait: Number($('grind-rlmax').value || 2),
    matchRetryIntervalMs: Number(($('grind-mretry') || {}).value || 8000),
    matchRetryMaxMs: Number(($('grind-mmax') || {}).value || 240000),
    strokeMode: strokeEl ? strokeEl.value : 'ARC',
  };
  // costTime 留空 = 自动（服务端按题数 × 5ms 给下限）
  const cost = $('grind-cost').value.trim();
  if (cost !== '') body.costTimeMs = Number(cost);

  $('log').innerHTML = '';
  try {
    const r = await api('/api/jobs', { method: 'POST', body: body });
    if (!r.ok) return toast(r.message || '启动失败', 'err');
    state.currentJobId = r.jobId;
    attachJobStream(r.jobId);
    // 允许并行：开始按钮**不禁用**（可以再开一个任务）；停止按钮指向最近这个任务
    $('btn-stop').disabled = false;
    $('job-badge').textContent = '#' + r.jobId;
    $('job-badge').className = 'badge run';
    toast('已开始，' + body.rounds + ' 局 · ' + (body.strokeMode === 'ARC' ? '弧线' : '七段码')
      + (body.costTimeMs != null ? ' · costTime ' + body.costTimeMs + 'ms' : ' · costTime 自动'), 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('btn-stop').addEventListener('click', async () => {
  if (!state.currentJobId) return;
  const btn = $('btn-stop');
  btn.disabled = true;
  btn.textContent = '正在中断…';
  try {
    // immediate=true → 中断在途请求与等待，不用等本轮跑完
    const r = await api('/api/jobs/' + state.currentJobId + '/stop', { method: 'POST', body: { immediate: true } });
    toast(r.message || '已立即结束', 'ok');
    logLine($('log'), '[已请求立即结束，正在中断在途请求…]', 'l-warn');
  } catch (err) {
    toast(err.message, 'err');
    btn.disabled = false;
  }
  btn.textContent = '立即结束';
});

/** 订阅任务事件流（SSE）+ 轮询兜底。 */
function attachJobStream(jobId) {
  stopJobStream();

  const log = $('log');
  const seenRounds = new Set();   // 已渲染过的轮次号，防止 SSE 与轮询重复
  state.seenRounds = seenRounds;

  const es = new EventSource('/api/jobs/' + jobId + '/stream');
  state.jobStream = es;

  es.onopen = () => {
    logLine(log, '[连接已建立，等待事件…]', 'l-dim');
  };

  es.onmessage = (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    handleJobEvent(d, log, seenRounds, es);
  };

  es.onerror = () => {
    // EventSource 会自动重连；这里只提示一次，不关连接
    if (!state.streamErrorNotified) {
      state.streamErrorNotified = true;
      logLine(log, '[日志流中断，正在自动重连；同时已启用 3 秒轮询兜底]', 'l-warn');
    }
    startPollFallback(jobId);
  };

  // 双保险：3 秒轮询一次任务详情，补齐任何漏掉的轮次
  startPollFallback(jobId);
}

/** 停止当前任务的事件流与轮询。 */
function stopJobStream() {
  if (state.jobStream) { state.jobStream.close(); state.jobStream = null; }
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  state.streamErrorNotified = false;
}

/** 轮询兜底：每 3 秒拉一次任务详情，把没渲染过的轮次补上。 */
function startPollFallback(jobId) {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    if (!state.currentJobId) return;
    try {
      const r = await api('/api/jobs/' + state.currentJobId);
      const log = $('log');
      for (const rd of r.rounds || []) {
        if (state.seenRounds.has(rd.round_no)) continue;
        state.seenRounds.add(rd.round_no);
        logLine(log, `（轮询补齐）第 ${rd.round_no} 轮${rd.ok ? '成功' : '失败'}：${rd.message || ''}`,
          rd.ok ? 'l-ok' : 'l-fail');
        if (rd.detail) logLine(log, '         ' + String(rd.detail).slice(0, 300), 'l-dim');
      }
      if (!(r.job && r.job.status === 'running') && state.pollTimer) {
        // 任务已结束：收尾
        finishJobUi(r.job ? r.job.status : '');
        stopJobStream();
      }
    } catch (e) { /* 轮询失败不打扰用户，等下一次 */ }
  }, 3000);
}

/** 统一处理一条任务事件。 */
function handleJobEvent(d, log, seenRounds, es) {
  const t = fmtTime(d.at);

  switch (d.type) {
    case 'snapshot': {
      // 连接时服务端发的现状快照：先把已落库的轮次补上，再接实时事件
      const j = d.job || {};
      logLine(log, `[快照] 任务 #${j.id} ${statusText(j.status)} · 成功 ${j.roundsDone}/${j.roundsTotal} · 失败 ${j.roundsFailed}`, 'l-dim');
      const cfg = j.config || {};
      logLine(log, `[配置] 知识点 ${cfg.pointId} · 画笔 ${cfg.strokeMode === 'SEVEN_SEGMENT' ? '七段码' : '弧线'}` +
        ` · costTime ${cfg.costTimeMs == null ? '自动' : cfg.costTimeMs + 'ms'}` +
        ` · 轮间隔 ${cfg.gapMinMs}~${cfg.gapMaxMs}ms` +
        ` · 答题间隔 ${(cfg.submitDelayMaxMs || 0) > 0 ? (cfg.submitDelayMinMs + '~' + cfg.submitDelayMaxMs + 'ms') : '无'}`, 'l-dim');
      for (const rd of d.rounds || []) {
        if (seenRounds.has(rd.round_no)) continue;
        seenRounds.add(rd.round_no);
        logLine(log, `第 ${rd.round_no} 轮${rd.ok ? '成功' : '失败'}：${rd.message || ''}`, rd.ok ? 'l-ok' : 'l-fail');
      }
      return;
    }
    case 'tick':
      // 心跳：更新最后一行，不刷屏
      updateTickLine(log, `[${t}] ${d.message}`, 'l-dim');
      return;
    case 'gap':
      logLine(log, `[${t}] ${d.message}`, 'l-warn');
      return;
    case 'ok':
    case 'fail': {
      if (d.round != null) seenRounds.add(d.round);
      logLine(log, `[${t}] ${d.message}`, d.type === 'ok' ? 'l-ok' : 'l-fail');
      if (d.detail) logLine(log, '         ' + String(d.detail).slice(0, 400), 'l-dim');
      return;
    }
    case 'status': {
      logLine(log, `[${t}] ${d.message}`, d.finished || /完成|已停止|中止/.test(d.message || '') ? 'l-ok' : 'l-dim');
      if (d.finished || /任务完成|已停止|中止|失败/.test(d.message || '')) {
        finishJobUi('');
        if (es) es.close();
        stopJobStream();
      }
      return;
    }
    default: {
      // match / match-ok / encode / encode-ok / submit / rate-limit / warn 等
      let cls = 'l-dim';
      if (d.type === 'rate-limit' || d.type === 'warn') cls = 'l-warn';
      if (d.type === 'match-ok' || d.type === 'encode-ok') cls = 'l-ok';
      logLine(log, `[${t}] ${d.message || ''}`, cls);
    }
  }
}

/** 原地更新最后一条「心跳」行，避免 5 秒一条把日志刷满。 */
function updateTickLine(log, text, cls) {
  const last = log.lastElementChild;
  if (last && last.dataset && last.dataset.tick === '1') {
    last.textContent = text;
  } else {
    const div = logLine(log, text, cls);
    div.dataset.tick = '1';
  }
  log.scrollTop = log.scrollHeight;
}

/** 任务收尾：恢复按钮状态（并行模式下开始按钮一直是可用的）。 */
function finishJobUi(status) {
  $('btn-stop').disabled = true;
  $('btn-stop').textContent = '立即结束';
  if (status === 'done') $('job-badge').className = 'badge ok';
  else if (status === 'failed') $('job-badge').className = 'badge fail';
  loadJobs();
}

/* ---------------------------- 任务页 ---------------------------- */

async function loadJobs() {
  try {
    const r = await api('/api/jobs');
    const box = $('jobs-list');
    box.innerHTML = '';
    if (r.jobs.length === 0) { box.innerHTML = '<p class="muted small">暂无任务</p>'; return; }
    for (const j of r.jobs) {
      const el = document.createElement('div');
      el.className = 'item';
      el.innerHTML = '<div><div class="title"></div><div class="meta"></div></div><div class="actions"></div>';
      el.querySelector('.title').textContent = '#' + j.id + ' ' + statusText(j.status);
      el.querySelector('.meta').textContent =
        '成功 ' + j.roundsDone + '/' + j.roundsTotal + ' · 失败 ' + j.roundsFailed +
        ' · pointId ' + (j.config ? j.config.pointId : '?') +
        ' · ' + fmtTime(j.createdAt);
      const btn = document.createElement('button');
      btn.className = 'mini';
      btn.textContent = '明细';
      btn.addEventListener('click', () => showJobDetail(j.id));
      el.querySelector('.actions').appendChild(btn);
      box.appendChild(el);
    }
  } catch (err) { toast(err.message, 'err'); }
}

function statusText(s) {
  return { queued: '排队中', running: '运行中', done: '已完成', failed: '失败', stopped: '已停止' }[s] || s;
}

async function showJobDetail(id) {
  try {
    const r = await api('/api/jobs/' + id);
    const box = $('job-detail');
    box.innerHTML = '';
    logLine(box, '任务 #' + r.job.id + ' ' + statusText(r.job.status) + '  成功 ' + r.job.roundsDone + ' 失败 ' + r.job.roundsFailed, 'l-dim');
    for (const rd of r.rounds) {
      logLine(box,
        '#' + rd.round_no + ' ' + (rd.ok ? 'OK' : 'FAIL') + ' HTTP ' + (rd.http_code == null ? '-' : rd.http_code) + '  ' + (rd.message || ''),
        rd.ok ? 'l-ok' : 'l-fail');
      if (rd.detail) logLine(box, '    ' + String(rd.detail).slice(0, 300), 'l-dim');
    }
  } catch (err) { toast(err.message, 'err'); }
}

$('btn-refresh-jobs').addEventListener('click', loadJobs);

/* ---- 刷练习页按钮 ---- */
$('prac-refresh').addEventListener('click', refreshPractice);
$('prac-pump').addEventListener('click', pumpPractice);
$('prac-exam').addEventListener('click', fetchPracticeExam);
$('prac-run').addEventListener('click', runPractice);
$('prac-leo').addEventListener('change', loadPracticeSubs);
$('prac-switch').addEventListener('click', switchPracticeSub);
$('dc-add').addEventListener('click', addDeviceChain);
$('dc-list').addEventListener('click', onDeviceChainListClick);

/* ---------------------------- 穿透页 ---------------------------- */

async function loadTunnel() {
  try {
    const r = await api('/api/tunnel');
    const t = r.tunnel;
    $('tunnel-url').textContent = t.url || '（未启动）';
    const box = $('tunnel-logs');
    box.innerHTML = '';
    for (const l of t.logs) logLine(box, l, 'l-dim');
    if (!t.available) logLine(box, '未检测到 cloudflared，点「启动穿透」会给出下载命令', 'l-warn');
  } catch (err) { toast(err.message, 'err'); }
}

$('btn-tunnel-start').addEventListener('click', async () => {
  toast('正在启动隧道（最多等 20 秒）…', 'ok');
  try {
    const r = await api('/api/tunnel', { method: 'POST', body: {} });
    if (r.ok) {
      $('tunnel-url').textContent = r.url;
      toast('穿透地址：' + r.url, 'ok');
    } else {
      toast('启动失败：' + (r.message || ''), 'err');
    }
    await loadTunnel();
  } catch (err) { toast(err.message, 'err'); }
});

$('btn-tunnel-stop').addEventListener('click', async () => {
  try {
    await api('/api/tunnel', { method: 'POST', body: { action: 'stop' } });
    toast('已停止', 'ok');
    await loadTunnel();
  } catch (err) { toast(err.message, 'err'); }
});

/* ---------------------------- 管理页 ---------------------------- */

async function loadAdmin() {
  if (!state.user || state.user.role !== 'admin') return;
  try {
    const [users, jobs, audit, sys] = await Promise.all([
      api('/api/admin/users'),
      api('/api/admin/jobs'),
      api('/api/admin/audit'),
      api('/api/system'),
    ]);

    const ub = $('admin-users');
    ub.innerHTML = '';
    for (const u of users.users) {
      const el = document.createElement('div');
      el.className = 'item';
      el.innerHTML = '<div><div class="title"></div><div class="meta"></div></div><div class="actions"></div>';
      el.querySelector('.title').textContent = u.username + (u.role === 'admin' ? '（管理员）' : '');
      el.querySelector('.meta').textContent = '最后登录 ' + fmtTime(u.last_login_at) + (u.disabled ? ' · 已禁用' : '');
      const b1 = document.createElement('button');
      b1.className = 'mini';
      b1.textContent = '重置密码';
      b1.addEventListener('click', async () => {
        const np = prompt('输入新密码（≥6 位）');
        if (!np) return;
        try { await api('/api/admin/users/' + u.id + '/password', { method: 'POST', body: { password: np } }); toast('已重置', 'ok'); }
        catch (err) { toast(err.message, 'err'); }
      });
      const b2 = document.createElement('button');
      b2.className = 'mini';
      b2.textContent = u.disabled ? '启用' : '禁用';
      b2.addEventListener('click', async () => {
        try { await api('/api/admin/users/' + u.id + '/disable', { method: 'POST', body: { disabled: !u.disabled } }); loadAdmin(); }
        catch (err) { toast(err.message, 'err'); }
      });
      el.querySelector('.actions').append(b1, b2);
      ub.appendChild(el);
    }

    const jb = $('admin-jobs');
    jb.innerHTML = '';
    for (const j of jobs.jobs) {
      const el = document.createElement('div');
      el.className = 'item';
      el.innerHTML = '<div><div class="title"></div><div class="meta"></div></div>';
      el.querySelector('.title').textContent = '#' + j.id + ' ' + (j.username || '-') + ' ' + statusText(j.status);
      el.querySelector('.meta').textContent = '成功 ' + j.roundsDone + '/' + j.roundsTotal + ' · ' + fmtTime(j.createdAt);
      jb.appendChild(el);
    }

    const ab = $('admin-audit');
    ab.innerHTML = '';
    for (const a of audit.audit) {
      logLine(ab, '[' + fmtTime(a.created_at) + '] ' + (a.action || '') + ' ' + (a.detail || '') + ' ' + (a.ip || ''), 'l-dim');
    }

    const sb = $('sys-info');
    sb.innerHTML = '';
    logLine(sb, '端口 ' + sys.config.port + ' · 数据库 ' + sys.config.dbFile, 'l-dim');
    logLine(sb, 'native：' + (sys.native.ok ? 'OK（样例 sign ' + sys.native.sample + '）' : '失败 → ' + sys.native.detail), sys.native.ok ? 'l-ok' : 'l-fail');
    logLine(sb, 'sign 公式自校验：' + (sys.signFixture.ok ? 'OK' : '失败'), sys.signFixture.ok ? 'l-ok' : 'l-fail');
    logLine(sb, '任务：' + (sys.jobs.busy ? '运行中 ' + JSON.stringify(sys.jobs.running) : '空闲'), 'l-dim');
    logLine(sb, '频控退避：基数 ' + sys.pk.rateLimitBaseMs + 'ms · 最多 ' + sys.pk.rateLimitMaxWait + ' 次', 'l-dim');
  } catch (err) { toast(err.message, 'err'); }
}

$('btn-admin-add').addEventListener('click', async () => {
  try {
    await api('/api/admin/users', {
      method: 'POST',
      body: { username: $('admin-newuser').value, password: $('admin-newpass').value },
    });
    toast('已新增', 'ok');
    $('admin-newuser').value = '';
    $('admin-newpass').value = '';
    loadAdmin();
  } catch (err) { toast(err.message, 'err'); }
});

/* ------------------------------ 启动 ------------------------------ */

async function bootstrapAfterLogin() {
  await loadLeoAccounts();
  await loadJobs();
}

/* ========================= 刷练习 =========================
 *
 * 与「刷局」是两条独立链路（PK 走 leo-game-pk，练习走 leo-star / leo-math）。
 * 关键：练习的公共参数必须 version=3.140.1 + platform=android37，
 * 否则被 solar-encoder 拦成 417（服务端拒绝未知版本号）。
 */

/** 把已导入的小猿账号填进练习页的下拉框。 */
function fillPracticeLeo(accounts) {
  const sel = $('prac-leo');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const a of accounts) {
    const o = document.createElement('option');
    o.value = String(a.id);
    o.textContent = a.name + '（uid ' + (a.yfdU || '?') + '）';
    sel.appendChild(o);
  }
  if (prev && accounts.some((a) => String(a.id) === prev)) sel.value = prev;
}

/** 进 tab 时调用：拉账号列表填下拉，并给点提示。 */
async function loadPractice() {
  try {
    const r = await api('/api/leo/accounts');
    fillPracticeLeo(r.accounts || []);
    await loadPracticeSubs();
    if (!(r.accounts || []).length) {
      $('prac-status').textContent = '还没有导入小猿账号 —— 先去「小猿账号」页添加。';
    }
  } catch (e) { toast(e.message, 'err'); }
}

/** 刷新分数 / 任务 / 道具。 */
async function refreshPractice() {
  const id = $('prac-leo').value;
  if (!id) return toast('先选择小猿账号', 'err');
  const box = $('prac-status');
  box.textContent = '请求中…';
  try {
    const r = await api('/api/exercise/overview?leoAccountId=' + id);
    if (!r.ok) { box.textContent = '失败：' + (r.error || '未知'); return toast(r.error || '失败', 'err'); }
    const lines = [
      '当前周分数 curWeekScore : ' + (r.curWeekScore == null ? '?' : r.curWeekScore),
      '本周经验 curWeekExp     : ' + (r.curWeekExp == null ? '?' : r.curWeekExp),
      '今日获得积分             : ' + (r.todayObtainedPoints == null ? '?' : r.todayObtainedPoints),
      '下次倍数 nextMultiplier : ' + (r.nextMultiplier == null ? '?' : r.nextMultiplier),
      '连续打卡三天数           : ' + (r.continuousDays == null ? '?' : r.continuousDays),
      '当前排名 curRank        : ' + (r.curRank == null ? '?' : r.curRank),
      '',
      '道具: ' + (r.item ? (r.item.itemName + ' ×' + r.item.multiple + '（' + (r.item.duration / 60000) + ' 分钟）') : '无'),
      '',
      '今日任务:',
    ];
    for (const t of (r.tasks || [])) {
      lines.push('  · ' + t.taskName + '  ' + t.curCnt + '/' + t.targetCnt +
        '  ' + (t.taskStatus === 2 ? '已完成' : '进行中') + '  +' + t.taskScore);
    }
    if (r.limits) lines.push('', '上限：' + r.limits.note);
    box.textContent = lines.join('\n');
  } catch (e) {
    box.textContent = '异常：' + e.message;
    toast(e.message, 'err');
  }
}

/** 刷分：对若干 ruleType 各上报一次。 */
async function pumpPractice() {
  const id = $('prac-leo').value;
  if (!id) return toast('先选择小猿账号', 'err');
  const out = $('prac-log');
  out.textContent = '';
  const say = (s) => { out.textContent += s + '\n'; out.scrollTop = out.scrollHeight; };
  const ruleTypes = $('prac-rts').value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  try {
    say('开始上报…');
    const r = await api('/api/exercise/pump', {
      method: 'POST',
      body: { leoAccountId: Number(id), delta: Number($('prac-delta').value || 200), ruleTypes },
    });
    for (const a of (r.applied || [])) {
      say(`  ruleType=${a.ruleType}  HTTP ${a.status}  ` + (a.gained > 0 ? `★ 入账 +${a.gained}` : '未增加（今日已记过）'));
    }
    say('');
    say(`合计入账 +${r.gained}    ${r.before} → ${r.after}`);
    if (r.gained === 0) say('（每个 ruleType 每天只记一次；今天已经报过了）');
    toast(r.gained > 0 ? ('入账 +' + r.gained) : '本次未增加', r.gained > 0 ? 'ok' : 'err');
  } catch (e) {
    say('异常：' + e.message);
    toast(e.message, 'err');
  }
}

/** 出题（看题 / 抄答案）。 */
async function fetchPracticeExam() {
  const id = $('prac-leo').value;
  if (!id) return toast('先选择小猿账号', 'err');
  const out = $('prac-runlog');
  out.textContent = '请求中…';
  try {
    const r = await api('/api/exercise/exam', {
      method: 'POST',
      body: { leoAccountId: Number(id), keypointId: Number($('prac-kp').value || 235001), limit: Number($('prac-limit').value || 10) },
    });
    if (!r.ok) { out.textContent = '失败 HTTP ' + r.status + '\n' + (r.text || ''); return toast('出题失败', 'err'); }
    const ex = r.exam || {};
    const lines = [
      'examId  : ' + ex.idString,
      '知识点  : ' + ex.keypoint + ' (id=' + ex.keypointId + ')',
      '题数    : ' + ex.questionCnt + '   预计经验 = 答对题数 × 2 = ' + (ex.questionCnt * 2),
      '',
    ];
    for (const [i, q] of (ex.questions || []).entries()) {
      lines.push(String(i + 1).padStart(3) + '. ' + q.content + '   答案=' + q.answer);
    }
    out.textContent = lines.join('\n');
  } catch (e) {
    out.textContent = '异常：' + e.message;
    toast(e.message, 'err');
  }
}

/**
 * 开始自动刷练习：POST /api/exercise/run，然后订阅 /api/exercise/stream 看实时日志。
 * 与「刷局」共用 jobs 的事件总线（服务端 publish(0, {exercise:true,...})）。
 */
async function runPractice() {
  const id = $('prac-leo').value;
  if (!id) return toast('先选择小猿账号', 'err');
  const log = $('prac-runlog');
  log.textContent = '';
  const say = (s, cls) => logLine(log, s, cls);
  stopPracticeStream();
  try {
    const r = await api('/api/exercise/run', {
      method: 'POST',
      body: {
        leoAccountId: Number(id),
        rounds: Number($('prac-rounds').value || 1),
        limit: Number($('prac-limit').value || 100),
        keypointId: Number($('prac-kp').value || 16),
        gapMinMs: Number($('prac-gapmin').value || 0),
        gapMaxMs: Number($('prac-gapmax').value || 0),
      },
    });
    say(r.message || '已开始', 'l-ok');
    attachPracticeStream();
  } catch (e) {
    say('启动失败：' + e.message, 'l-warn');
    toast(e.message, 'err');
  }
}
/** 订阅练习事件流（服务端把所有练习事件 publish 到 id=0 的 exercise 通道）。 */
function attachPracticeStream() {
  stopPracticeStream();
  const log = $('prac-runlog');
  const es = new EventSource('/api/exercise/stream');
  state.practiceStream = es;
  es.onopen = () => logLine(log, '[已连接练习日志流…]', 'l-dim');
  es.onmessage = (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    const cls = d.type === 'ex-ok' ? 'l-ok'
      : (d.type === 'ex-fail' || d.type === 'ex-rate-limit') ? 'l-warn'
      : (d.type === 'ex-done' || d.type === 'ex-final') ? 'l-ok' : '';
    logLine(log, (d.message || d.type), cls);
  };
  es.onerror = () => { /* EventSource 自动重连 */ };
}
/** 关闭练习事件流。 */
function stopPracticeStream() {
  if (state.practiceStream) { state.practiceStream.close(); state.practiceStream = null; }
}
/* ========================= 设备链池 ========================= */
async function loadDeviceChains() {
  try {
    const r = await api('/api/device-chains');
    renderDeviceChains(r.chains || []);
  } catch (e) { /* 未登录等，忽略 */ }
}
function renderDeviceChains(list) {
  const box = $('dc-list');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<p class="muted small">池子里还没有设备链。新登录的账号将没有 ks_*（PK 会 400）。</p>';
    return;
  }
  for (const c of list) {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = '<div><div class="title"></div><div class="meta"></div></div>' +
      '<div class="actions"><button class="mini danger" data-dc-del="' + c.id + '">删除</button></div>';
    el.querySelector('.title').textContent = c.label + '（ks_deviceid=' + (c.deviceId || '?') + '）';
    el.querySelector('.meta').textContent = (c.names || []).join(',') + ' · ' + c.bytes + 'B · ' + (c.enabled ? '启用' : '停用');
    box.appendChild(el);
  }
}
async function addDeviceChain() {
  const cookie = $('dc-cookie').value.trim();
  if (!cookie) return toast('先粘贴设备链 cookie', 'err');
  try {
    const r = await api('/api/device-chains', {
      method: 'POST', body: { label: $('dc-label').value.trim(), cookie: cookie },
    });
    toast((r.created ? '已保存' : '已更新') + '：ks_deviceid=' + r.deviceId, 'ok');
    $('dc-cookie').value = '';
    $('dc-label').value = '';
    await loadDeviceChains();
  } catch (e) { toast(e.message, 'err'); }
}
async function onDeviceChainListClick(ev) {
  const id = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-dc-del');
  if (!id) return;
  if (!confirm('删除这份设备链？已用它补齐的账号不受影响，但新账号将无法自动补链。')) return;
  try {
    await api('/api/device-chains/' + id, { method: 'DELETE' });
    toast('已删除', 'ok');
    await loadDeviceChains();
  } catch (e) { toast(e.message, 'err'); }
}
/**
 * 拉「选中小猿账号」的子账号列表，填进练习页的子账号下拉。
 *
 * ⚠️ 练习与「当前身份」绑定：切号后练习/刷分都跑在新身份下。
 * 子账号名字/头像来自 batchGet（需 sign）。
 */
async function loadPracticeSubs() {
  const id = $('prac-leo').value;
  const sel = $('prac-sub');
  sel.innerHTML = '<option value="">（当前身份）</option>';
  if (!id) return;
  try {
    const r = await api('/api/leo/accounts/' + id + '/sub-accounts');
    for (const s of (r.subs || [])) {
      const o = document.createElement('option');
      o.value = String(s.userId);
      o.textContent = (s.nickname || ('账号 ' + s.userId)) + (s.isPrimary ? '（主）' : '') + (s.isCurrent ? ' ← 当前' : '');
      sel.appendChild(o);
    }
  } catch (e) { /* 不影响其它功能 */ }
}

/** 切换练习用的子账号（走已攻破的 switch），成功后刷新分数。 */
async function switchPracticeSub() {
  const id = $('prac-leo').value;
  const target = $('prac-sub').value;
  if (!id) return toast('先选择小猿账号', 'err');
  if (!target) return toast('先选择要切换的子账号', 'err');
  try {
    const r = await api('/api/leo/accounts/' + id + '/switch', {
      method: 'POST', body: { userId: Number(target) },
    });
    toast(r.message || '已切换', r.ok ? 'ok' : 'err');
    await loadPracticeSubs();
    await refreshPractice();
  } catch (e) {
    toast(e.message, 'err');
  }
}
/* ========================= 刷练习 结束 ========================= */

(async function init() {
  try {
    const ok = await refreshMe();
    if (ok) await bootstrapAfterLogin();
  } catch (e) {
    showView('auth');
  }
})();