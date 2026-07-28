/**
 * HTTP 安全加固:baseUrl 校验 + 认证请求的重定向防护。
 *
 * 背景(2026-07 对外安全评估 P2):GitlabClient 把 `PRIVATE-TOKEN` 发到
 * `config.baseUrl`,而默认 `fetch` 的 `redirect: 'follow'` 会在 3xx 时把请求
 * (连同凭据 header)自动带到 `Location` 指向的任意 host。若 baseUrl 被恶意配置或
 * 自建 GitLab 被攻陷返回一个跨 host 的 3xx,PRIVATE-TOKEN 会被重放到攻击者端点
 * (token 泄漏 / SSRF)。本模块把「不跟随跨 host 重定向」与「baseUrl 结构校验」
 * 收敛成零依赖纯逻辑,便于单测锁死。
 *
 * github-client 有一份逻辑等价的实现(错误类型 / 文案不同);两包刻意各自独立
 * (零运行时依赖、互不 import),与既有 request() 空 body 短路逻辑的重复一致。
 */

import { GitlabApiError } from './types.js';

/** 认证请求专用重定向跟随的默认跳数上限。正常 GitLab API 极少 3xx,给足冗余即可。 */
const MAX_REDIRECTS = 5;

/**
 * 是否是 loopback / 本地 host。此类 host 上用 http 明文传输 token 风险可控
 * (不出本机),因此即使要求 https 也放行,方便本地 / 测试。
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h.endsWith('.localhost')
  );
}

/** assertSafeBaseUrl 的可选行为。 */
export interface AssertSafeBaseUrlOptions {
  /**
   * 是否放行非 loopback 的 http。GitLab 自建实例惯例上允许 http
   * (源自已退役的 shared/connectorUrl.ts「沿用输入协议」惯例),故 GitlabClient 传 true。
   */
  allowInsecureHttp?: boolean;
}

/**
 * 校验 baseUrl 结构安全:必须是可解析的 http(s) URL、不含 userinfo。
 * userinfo(`user[:pass]@host`)会把真实连接主机改写成攻击者控制的 host,必须拒绝。
 * 默认要求 https;`allowInsecureHttp` 时放行 http;loopback host 始终放行 http。
 * 非法输入 fail-closed 抛错(构造期即拒绝,不等到发请求才暴露)。
 */
export function assertSafeBaseUrl(
  baseUrl: string,
  opts: AssertSafeBaseUrlOptions = {},
): void {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`GitlabClient: invalid baseUrl: ${baseUrl}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(
      `GitlabClient: baseUrl must be http(s), got ${u.protocol}`,
    );
  }
  if (u.username || u.password) {
    throw new Error('GitlabClient: baseUrl must not contain credentials (userinfo)');
  }
  if (u.protocol === 'http:' && !opts.allowInsecureHttp && !isLoopbackHost(u.hostname)) {
    throw new Error(
      'GitlabClient: baseUrl must use https (http only allowed for loopback)',
    );
  }
}

/**
 * 认证请求专用 fetch:强制 `redirect: 'manual'` 手动处理重定向。
 *  - 非 3xx:原样返回。
 *  - 同源 3xx:带原始凭据 header 继续跟随(≤ MAX_REDIRECTS 跳),覆盖仓库改名 301
 *    这类合法同 host 跳转。
 *  - 跨源 3xx:fail-closed 直接抛错,绝不把 PRIVATE-TOKEN 重放到另一个 host。
 * 正常 GitLab REST API 极少 3xx,故对常规调用零影响。
 */
export async function fetchWithSafeRedirect(
  url: string,
  init: RequestInit,
  maxRedirects = MAX_REDIRECTS,
  /** 出网通道。宿主可注入(如 desktop 的代理感知 fetch);缺省 = 全局 fetch。 */
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const { origin, host } = new URL(url);
  let current = url;
  let lastStatus = 0;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetchImpl(current, { ...init, redirect: 'manual' });
    // 只有 3xx 才走重定向分支;其余(含 2xx / 4xx / 5xx)交回调用方原有逻辑处理。
    if (res.status < 300 || res.status >= 400) return res;
    lastStatus = res.status;
    const location = res.headers.get('location');
    // 3xx 但没有 Location:无从跟随,原样返回让调用方按非 ok 处理。
    if (!location) return res;
    let target: URL;
    try {
      target = new URL(location, current);
    } catch {
      throw new GitlabApiError(
        `GitLab redirect to invalid Location: ${location}`,
        res.status,
      );
    }
    // 仅比较 host(hostname+port),允许合法的 HTTP→HTTPS 同 host 协议升级重定向
    // (nginx 前置反代的自建 GitLab 常见)。跨 host 始终 fail-closed。
    if (target.host !== host) {
      throw new GitlabApiError(
        `GitLab refused cross-host redirect ${origin} → ${target.origin} ` +
          '(PRIVATE-TOKEN not replayed across hosts)',
        res.status,
      );
    }
    current = target.toString();
  }
  throw new GitlabApiError(
    `GitLab too many redirects (> ${maxRedirects})`,
    lastStatus,
  );
}
