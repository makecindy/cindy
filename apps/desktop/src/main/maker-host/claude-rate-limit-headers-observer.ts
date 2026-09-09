/**
 * claude-rate-limit-headers-observer — 从订阅直连响应旁路读取 Claude 账号余量。
 *
 * Anthropic 对订阅(OAuth bearer)请求的每个响应都带 `anthropic-ratelimit-unified-*`
 * headers(5h / 7d 已用比例、reset 时间、整体状态)。本 observer 挂在
 * anthropic-compat-proxy 的 responseObserver 上,在响应开始时同步读一次 headers、
 * 组装快照后 fire-and-forget 交给注入的 listener(→ usageBroadcaster 落库 + 广播)。
 *
 * 两条链路共用同一份状态: 透明代理(anthropic-compat-proxy 的 responseObserver)与
 * codex 的 Anthropic 本地桥(localHandler 绕开转发层, 见 codex-proxy-host)都调用
 * recordClaudeRateLimitHeaders —— 去抖签名与账号归属只有一份, 不复制第二份状态。
 *
 * 热路径纪律(规则 10):
 *   - 只在 'response' 事件同步读 header 对象,不返回 sink(不 tee 响应 body,SSE
 *     字节流零感知);
 *   - listener 调用是同步发起的 fire-and-forget(内部才 async),不 await;
 *   - 仅订阅直连(upstreamBase = api.anthropic.com)的响应才解析 —— 网关路由的响应
 *     没有这些头,一次字符串包含判断就短路;
 *   - 相邻两次快照的 (5h, 7d, status) 三元组完全相同时跳过回调,避免 agentic loop
 *     内十几次 API call 反复触发相同值的落库 / 广播。
 */

import type { ResponseObserver } from '@cindy/anthropic-compat-proxy';

import {
  parseClaudeUnifiedRateLimitHeaders,
  type ClaudeSubscriptionUsageSnapshot,
} from '../../shared/claudeSubscriptionUsage.js';

type ClaudeRateLimitHeadersListener = (
  snapshot: ClaudeSubscriptionUsageSnapshot,
  /**
   * 发出本次请求的 OAuth bearer token(从请求头提取, 纯字符串切片零开销);
   * null = 请求未带 bearer。listener 据此把快照绑定到请求归属账号 —— 换号 /
   * 登出瞬间的 in-flight 尾巴响应不会被错误打上最新账号的指纹。
   */
  requestBearerToken: string | null,
) => boolean | void;

// listener 由 main 的 usage 接线层注入(recordClaudeSubscriptionUsageSnapshot),
// 避免本模块直接 import usageBroadcaster(它拉 Electron BrowserWindow)造成 maker-host
// 反向依赖。未注入时 observer 解析后静默丢弃。
let _listener: ClaudeRateLimitHeadersListener | null = null;
export function setClaudeRateLimitHeadersListener(fn: ClaudeRateLimitHeadersListener): void {
  _listener = fn;
}

/** 上次已上报的 (5h, 7d, status) 签名 —— 相同则跳过,见顶部热路径纪律。 */
let _lastSignature: string | null = null;

/**
 * 订阅直连上游判定 —— 精确 hostname 全等比较, 不用 substring 包含
 * (CodeQL js/incomplete-url-substring-sanitization: `includes('api.anthropic.com')`
 * 会放行 `api.anthropic.com.evil.com` 这类宿主)。upstreamBase 取值集合极小
 * (默认网关 + 少数 override), 单值缓存避免每响应重复 URL 解析。
 */
let _lastUpstreamBase: string | null = null;
let _lastUpstreamIsAnthropic = false;

function isAnthropicDirectUpstream(upstreamBase: string): boolean {
  if (upstreamBase === _lastUpstreamBase) return _lastUpstreamIsAnthropic;
  let isAnthropic = false;
  try {
    isAnthropic = new URL(upstreamBase).hostname === 'api.anthropic.com';
  } catch {
    isAnthropic = false;
  }
  _lastUpstreamBase = upstreamBase;
  _lastUpstreamIsAnthropic = isAnthropic;
  return isAnthropic;
}

function snapshotSignature(s: ClaudeSubscriptionUsageSnapshot): string {
  return [
    s.fiveHour?.utilization ?? '',
    s.fiveHour?.resetsAt ?? '',
    s.sevenDay?.utilization ?? '',
    s.sevenDay?.resetsAt ?? '',
    s.rateLimitStatus ?? '',
  ].join('|');
}

/** 测试钩子:重置去抖签名。 */
export function resetClaudeRateLimitHeadersDedup(): void {
  _lastSignature = null;
}

/**
 * bearer 提取 —— 大小写不敏感。转发层的 header 已由 proxy 小写化, 但桥路径传进来的
 * 是 provider 自己拼的请求头, 大小写不受本模块控制; 取错等于账号归属丢失(快照会被
 * 当成"无归属"), 而这类失败是静默的, 所以这里不假设 key 形态。
 */
function extractBearerToken(requestHeaders: Readonly<Record<string, string>>): string | null {
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (name.toLowerCase() !== 'authorization') continue;
    return typeof value === 'string' && value.startsWith('Bearer ')
      ? value.slice('Bearer '.length)
      : null;
  }
  return null;
}

/**
 * 解析一次订阅直连响应的 unified headers 并交给 listener —— 透明代理与 codex 桥的
 * 共用入口(见顶部说明)。同步返回, 内部 fire-and-forget, 任何失败都不抛出。
 *
 * headers 的 key 必须已小写化: `parseClaudeUnifiedRateLimitHeaders` 是按精确
 * key 索引取值的, 传 Fetch `Headers` 对象或未归一化的记录会静默解析成 null。
 * 桥路径请用 `Object.fromEntries(response.headers)`(Fetch 迭代出的 key 一律小写)。
 */
export function recordClaudeRateLimitHeaders(input: {
  upstreamBase: string;
  responseHeaders: Readonly<Record<string, string>>;
  requestHeaders: Readonly<Record<string, string>>;
}): void {
  // 订阅直连才有 unified headers;网关 / 其它上游一次 hostname 比较短路。
  if (!isAnthropicDirectUpstream(input.upstreamBase)) return;
  const listener = _listener;
  if (!listener) return;

  const snapshot = parseClaudeUnifiedRateLimitHeaders(input.responseHeaders, Date.now());
  if (!snapshot) return;

  const requestBearerToken = extractBearerToken(input.requestHeaders);

  // 去抖签名包含请求身份 —— 换号场景旧账号的尾巴响应写过签名后, 新账号首个
  // 响应即使 5h/7d/status 数值恰好相同也必须到达 listener(归属不同, 不是重复)。
  const signature = `${requestBearerToken ?? ''}|${snapshotSignature(snapshot)}`;
  if (signature === _lastSignature) return;

  try {
    const accepted = listener(snapshot, requestBearerToken) !== false;
    if (accepted) _lastSignature = signature;
  } catch {
    // listener 是 fire-and-forget,失败不影响响应转发(proxy 侧还有一层 try 兜底)。
  }
}

/**
 * 创建旁路 observer。永远返回 undefined(不注册 body sink)。
 */
export function createClaudeRateLimitHeadersObserver(): ResponseObserver {
  return (ctx) => {
    recordClaudeRateLimitHeaders({
      upstreamBase: ctx.upstreamBase,
      responseHeaders: ctx.responseHeaders,
      requestHeaders: ctx.requestHeaders,
    });
    return undefined;
  };
}

/**
 * 把多个 responseObserver 组合成一个:按序调用,每个 observer 的 sink 各自收 tee 事件。
 * proxy 的 ProxyOptions.responseObserver 只有一个挂点,fast-mode 核验与本模块共存靠它。
 */
export function composeResponseObservers(
  ...observers: ResponseObserver[]
): ResponseObserver {
  return (ctx) => {
    const sinks = observers
      .map((observer) => {
        try {
          return observer(ctx) ?? null;
        } catch {
          return null;
        }
      })
      .filter((sink): sink is NonNullable<typeof sink> => Boolean(sink));
    if (sinks.length === 0) return undefined;
    if (sinks.length === 1) return sinks[0];
    return {
      onData: (chunk) => {
        for (const sink of sinks) sink.onData?.(chunk);
      },
      onEnd: () => {
        for (const sink of sinks) sink.onEnd?.();
      },
      onError: (err) => {
        for (const sink of sinks) sink.onError?.(err);
      },
    };
  };
}
