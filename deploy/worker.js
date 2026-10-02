// Cloudflare Worker：把公网请求转发给 pk-node 容器实例。
//
// 设计要点
//  - **单实例**：pk-node 的任务状态在进程内存 + 单个 SQLite 里，天然只适合一个实例。
//    所以固定用 idFromName('singleton')，绝不按 session 分流（多实例会数据打架）。
//  - **SSE 直通**：pk-node 的实时日志是 SSE（长连接）。容器端口转发是流式的，
//    这里直接 `getTcpPort(8792).fetch(request)` 返回其 Response，不做任何缓冲/改写。
//  - **保活**：刷局任务可能跑很久，实例休眠会中断任务。见 wrangler.jsonc 的 sleepAfter
//    与下面的 setInactivityTimeout。
import { DurableObject } from 'cloudflare:workers';

const APP_PORT = 8792;

export class PkNodeContainer extends DurableObject {
  async fetch(request) {
    const container = this.ctx.container;
    if (!container) {
      return new Response('容器不可用（不是 Container 实例？）', { status: 500 });
    }

    // 存活期间尽量不睡：刷局/刷练习是长时间任务，休眠即中断。
    // （真正空闲时仍会按 wrangler.jsonc 的 sleepAfter 休眠，避免白烧钱。）
    try {
      await container.setInactivityTimeout(60 * 60 * 1000); // 1 小时无请求才考虑睡
    } catch (e) { /* 老版本 API 没有该方法时忽略 */ }

    if (!container.running) {
      container.start();
      await this.#waitForPort();
    }

    // 转发前把 Host 头去掉（容器内是 127.0.0.1 语义）
    const url = new URL(request.url);
    url.protocol = 'http:';
    url.host = 'container';
    const forwarded = new Request(url, request);
    forwarded.headers.delete('host');

    return container.getTcpPort(APP_PORT).fetch(forwarded);
  }

  /** 轮询 / 直到容器在 8792 上能应答（容器冷启动通常 1~3 秒）。 */
  async #waitForPort() {
    const port = this.ctx.container.getTcpPort(APP_PORT);
    let lastErr;
    for (let i = 0; i < 150; i++) {           // 最多约 30 秒
      try {
        const r = await port.fetch('http://container/__health');
        if (r.status < 500) return;           // 有应答即可（404 也算「服务已起来」）
      } catch (e) {
        lastErr = e;
      }
      await new Promise((res) => setTimeout(res, 200));
    }
    throw new Error('容器未在 30 秒内就绪: ' + (lastErr && lastErr.message));
  }
}

export default {
  async fetch(request, env) {
    // 所有请求都打到同一个实例（单实例架构，见文件头说明）
    const stub = env.PKNODE.get(env.PKNODE.idFromName('singleton'));
    return stub.fetch(request);
  },
};