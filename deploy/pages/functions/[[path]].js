// Cloudflare Pages Function：把 pages.dev 的请求转发给 Worker。
//
// ## 为什么要这一层
//
// 实测（国内网络，2026-10-02）：
//   https://pk-node.sxdd.workers.dev  → SSL_ERROR_SYSCALL / 000（被阻断）
//   https://6615.pages.dev            → 200（同一账号下的 Pages 站点，正常）
//   https://pages.dev                 → 200
// 即：`workers.dev` 这个域名被 SNI 层阻断，而 `pages.dev` 没被阻断。
//
// ## 这一层做了什么
//
// 浏览器 → https://<project>.pages.dev/<path>
//        → 本 Function（Pages 运行时）
//        → fetch(https://pk-node.sxdd.workers.dev/<path>)   ← Cloudflare 内部调用，不走公网
//        → Worker 执行业务逻辑 → 原样返回
//
// 因为 Function → Worker 是 Cloudflare 内部转发，`workers.dev` 被墙**不影响**。
//
// ## 注意
//
// - 用 `new Request(target, request)` 原样转发 method / headers / body（含 POST 表单）；
// - 不缓冲响应（直接 return fetch 的结果，保留流式）；
// - 客户端 IP 会变成 Cloudflare 内部 IP（本项目不依赖真实 IP，可接受）。

const UPSTREAM = 'https://pk-node.sxdd.workers.dev';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const target = UPSTREAM + url.pathname + url.search;

  try {
    // 原样转发（method / headers / body 全部保留）
    const headers = new Headers(context.request.headers);
    // ⚠️ 必须删掉这两个：转发时 body 可能被重新编码，长度对不上会让上游报错；
    //    Host 也要去掉（由 fetch 按目标 URL 生成）。
    headers.delete('content-length');
    headers.delete('host');

    const init = {
      method: context.request.method,
      headers: headers,
      redirect: 'manual',
    };
    // GET/HEAD 不能带 body
    if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
      init.body = await context.request.arrayBuffer();
    }

    const resp = await fetch(target, init);

    // 原样返回（含 Set-Cookie 等）
    const outHeaders = new Headers(resp.headers);
    outHeaders.delete('cf-connecting-ip');
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: outHeaders,
    });
  } catch (e) {
    // 出错时把真实原因返回出来（而不是一个空白的 500），便于排查
    return new Response(JSON.stringify({
      ok: false,
      layer: 'pages-function',
      message: String(e && e.message ? e.message : e),
      target: target,
      method: context.request.method,
    }, null, 2), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
}