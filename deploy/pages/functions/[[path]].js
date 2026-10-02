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

  // 原样转发（method / headers / body 全部保留）
  const init = {
    method: context.request.method,
    headers: context.request.headers,
    redirect: 'manual',
  };
  // GET/HEAD 不能带 body
  if (context.request.method !== 'GET' &amp;&amp; context.request.method !== 'HEAD') {
    init.body = context.request.body;
  }

  const resp = await fetch(target, init);

  // 原样返回状态码与响应体（含 Set-Cookie 等响应头）
  const headers = new Headers(resp.headers);
  // 去掉可能引起困惑的转发相关头
  headers.delete('cf-connecting-ip');
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: headers,
  });
}