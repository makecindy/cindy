/**
 * claudeRateLimitHeadersObserver.test.ts
 * ---------------------------------------------------------------------------
 * proxy 旁路读订阅余量 headers 的 observer 单测:
 *   - 只处理 api.anthropic.com 上游的响应(网关响应短路)
 *   - 无 listener / 无 unified headers → no-op
 *   - (5h, 7d, status) 签名相同的相邻响应去抖
 *   - composeResponseObservers: 多 observer sink 的 tee 分发与异常隔离
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_XD_GATEWAY_BASE_URL as XD_GATEWAY_BASE_URL } from '../../../test/vitest/clientEndpointsFixture';
import type { ResponseObserverCtx } from '@cindy/anthropic-compat-proxy';

import {
  composeResponseObservers,
  createClaudeRateLimitHeadersObserver,
  recordClaudeRateLimitHeaders,
  resetClaudeRateLimitHeadersDedup,
  setClaudeRateLimitHeadersListener,
} from '../claude-rate-limit-headers-observer';

function makeCtx(overrides: Partial<ResponseObserverCtx> = {}): ResponseObserverCtx {
  return {
    reqId: 1,
    method: 'POST',
    url: '/v1/messages',
    upstreamBase: 'https://api.anthropic.com',
    status: 200,
    requestHeaders: { authorization: 'Bearer sk-ant-oat01-live' },
    responseHeaders: {
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.55',
      'anthropic-ratelimit-unified-5h-reset': '1764554400',
      'anthropic-ratelimit-unified-7d-utilization': '0.11',
      'anthropic-ratelimit-unified-7d-reset': '1764986400',
    },
    requestBody: Buffer.alloc(0),
    ...overrides,
  };
}

describe('createClaudeRateLimitHeadersObserver', () => {
  beforeEach(() => {
    resetClaudeRateLimitHeadersDedup();
  });

  it('parses subscription responses and forwards the snapshot to the listener', () => {
    const listener = vi.fn();
    setClaudeRateLimitHeadersListener(listener);
    const observer = createClaudeRateLimitHeadersObserver();

    expect(observer(makeCtx())).toBeUndefined();  // 不注册 body sink
    expect(listener).toHaveBeenCalledTimes(1);
    const snapshot = listener.mock.calls[0][0];
    expect(snapshot.fiveHour.utilization).toBeCloseTo(55, 5);
    expect(snapshot.sevenDay.utilization).toBeCloseTo(11, 5);
    expect(snapshot.rateLimitStatus).toBe('allowed');
    expect(snapshot.source).toBe('unified-headers');
    // 请求 bearer 一并传出 —— listener 据此把快照绑定到请求归属账号
    expect(listener.mock.calls[0][1]).toBe('sk-ant-oat01-live');
  });

  it('passes null when the request carried no bearer token', () => {
    const listener = vi.fn();
    setClaudeRateLimitHeadersListener(listener);
    const observer = createClaudeRateLimitHeadersObserver();

    observer(makeCtx({ requestHeaders: { 'x-api-key': 'sk-key' } }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][1]).toBeNull();
  });

  it('skips gateway upstreams and header-less responses', () => {
    const listener = vi.fn();
    setClaudeRateLimitHeadersListener(listener);
    const observer = createClaudeRateLimitHeadersObserver();

    observer(makeCtx({ upstreamBase: XD_GATEWAY_BASE_URL }));
    observer(makeCtx({ responseHeaders: { 'content-type': 'application/json' } }));
    expect(listener).not.toHaveBeenCalled();
  });

  it('matches the anthropic upstream by exact hostname, not substring', () => {
    // CodeQL js/incomplete-url-substring-sanitization 回归:包含式匹配会放行
    // `api.anthropic.com` 出现在任意位置的宿主。
    const listener = vi.fn();
    setClaudeRateLimitHeadersListener(listener);
    const observer = createClaudeRateLimitHeadersObserver();

    observer(makeCtx({ upstreamBase: 'https://api.anthropic.com.evil.example' }));
    observer(makeCtx({ upstreamBase: 'https://evil.example/api.anthropic.com' }));
    observer(makeCtx({ upstreamBase: 'not-a-url api.anthropic.com' }));
    expect(listener).not.toHaveBeenCalled();

    observer(makeCtx({ upstreamBase: 'https://api.anthropic.com' }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dedupes consecutive identical snapshots and resumes on change', () => {
    const listener = vi.fn();
    setClaudeRateLimitHeadersListener(listener);
    const observer = createClaudeRateLimitHeadersObserver();

    observer(makeCtx());
    observer(makeCtx());
    expect(listener).toHaveBeenCalledTimes(1);

    observer(makeCtx({
      responseHeaders: {
        ...makeCtx().responseHeaders,
        'anthropic-ratelimit-unified-5h-utilization': '0.56',
      },
    }));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not dedupe identical values coming from a different request token (account switch)', () => {
    // 换号场景: 旧账号尾巴响应写过签名后, 新账号首个响应即使数值相同也必须
    // 到达 listener —— 归属不同不是重复, 否则新账号首笔快照会被静默吞掉。
    const listener = vi.fn();
    setClaudeRateLimitHeadersListener(listener);
    const observer = createClaudeRateLimitHeadersObserver();

    observer(makeCtx({ requestHeaders: { authorization: 'Bearer sk-ant-oat01-old' } }));
    observer(makeCtx({ requestHeaders: { authorization: 'Bearer sk-ant-oat01-new' } }));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0][1]).toBe('sk-ant-oat01-old');
    expect(listener.mock.calls[1][1]).toBe('sk-ant-oat01-new');
  });

  it('does not poison dedupe when the listener rejects ownership', () => {
    const listener = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    setClaudeRateLimitHeadersListener(listener);
    const observer = createClaudeRateLimitHeadersObserver();

    observer(makeCtx());
    observer(makeCtx());
    expect(listener).toHaveBeenCalledTimes(2);

    // 第二次已 accepted,之后同签名才开始 dedupe。
    observer(makeCtx());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('swallows listener exceptions (fire-and-forget)', () => {
    setClaudeRateLimitHeadersListener(() => { throw new Error('boom'); });
    const observer = createClaudeRateLimitHeadersObserver();
    expect(() => observer(makeCtx())).not.toThrow();
  });
});

describe('composeResponseObservers', () => {
  it('tees data/end/error to every sink and isolates observer failures', () => {
    const sinkA = { onData: vi.fn(), onEnd: vi.fn(), onError: vi.fn() };
    const sinkB = { onData: vi.fn(), onEnd: vi.fn() };
    const composed = composeResponseObservers(
      () => sinkA,
      () => { throw new Error('observer boom'); },
      () => sinkB,
      () => undefined,
    );

    const sink = composed(makeCtx());
    expect(sink).toBeTruthy();
    const chunk = Buffer.from('data');
    sink?.onData?.(chunk);
    sink?.onEnd?.();
    sink?.onError?.(new Error('stream'));
    expect(sinkA.onData).toHaveBeenCalledWith(chunk);
    expect(sinkA.onEnd).toHaveBeenCalledTimes(1);
    expect(sinkA.onError).toHaveBeenCalledTimes(1);
    expect(sinkB.onData).toHaveBeenCalledWith(chunk);
    expect(sinkB.onEnd).toHaveBeenCalledTimes(1);
  });

  it('returns the single sink directly and undefined when no observer registers one', () => {
    const sinkA = { onData: vi.fn() };
    expect(composeResponseObservers(() => sinkA)(makeCtx())).toBe(sinkA);
    expect(composeResponseObservers(() => undefined, () => null)(makeCtx())).toBeUndefined();
  });
});

/**
 * recordClaudeRateLimitHeaders —— 透明代理与 codex Anthropic 本地桥的共用入口(#2626)。
 * 桥的 localHandler 绕开 compat-proxy 的转发层, 拿不到 responseObserver, 只能从这里
 * 回喂; 两条链路必须共用同一份去抖与账号归属状态。
 */
describe('recordClaudeRateLimitHeaders (bridge entry)', () => {
  beforeEach(() => {
    resetClaudeRateLimitHeadersDedup();
  });

  /** 桥侧拿到的是 Fetch `Headers`, 按约定先 Object.fromEntries 再传入。 */
  function fromFetchHeaders(init: Record<string, string>): Record<string, string> {
    return Object.fromEntries(new Headers(init));
  }

  it('parses headers that arrived as a Fetch Headers object, whatever case upstream used', () => {
    // 实测: 上游按 HTTP 语义可能用任意大小写下发; Headers 迭代出的 key 一律小写,
    // 正是 parseClaudeUnifiedRateLimitHeaders 要求的形态。
    const listener = vi.fn();
    setClaudeRateLimitHeadersListener(listener);

    recordClaudeRateLimitHeaders({
      upstreamBase: 'https://api.anthropic.com',
      responseHeaders: fromFetchHeaders({
        'Anthropic-RateLimit-Unified-5h-Utilization': '0.34',
        'ANTHROPIC-RATELIMIT-UNIFIED-5H-RESET': '1786447200',
        'anthropic-ratelimit-unified-7d-utilization': '0.09',
        'Anthropic-RateLimit-Unified-Status': 'allowed',
      }),
      requestHeaders: { authorization: 'Bearer sk-ant-oat01-live' },
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const snapshot = listener.mock.calls[0][0];
    expect(snapshot.fiveHour.utilization).toBeCloseTo(34, 5);
    expect(snapshot.fiveHour.resetsAt).toBe(1786447200);
    expect(snapshot.sevenDay.utilization).toBeCloseTo(9, 5);
    expect(snapshot.rateLimitStatus).toBe('allowed');
    expect(snapshot.source).toBe('unified-headers');
    expect(listener.mock.calls[0][1]).toBe('sk-ant-oat01-live');
  });

  it('extracts the bearer regardless of request header casing', () => {
    // 桥路径的请求头由 provider 自己拼, 大小写不受本模块控制; 取错等于账号归属
    // 丢失, 而这类失败是静默的。
    const listener = vi.fn();
    setClaudeRateLimitHeadersListener(listener);

    recordClaudeRateLimitHeaders({
      upstreamBase: 'https://api.anthropic.com',
      responseHeaders: fromFetchHeaders({ 'anthropic-ratelimit-unified-5h-utilization': '0.5' }),
      requestHeaders: { Authorization: 'Bearer sk-ant-oat01-mixed' },
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][1]).toBe('sk-ant-oat01-mixed');
  });

  it('clamps a utilization above 1.0 instead of overflowing', () => {
    // 实测边界: 超额时上游会下发 5h-utilization = 1.06 (配 status=rejected,
    // overage-in-use=true)。现有语义是 clamp 到 100。
    const listener = vi.fn();
    setClaudeRateLimitHeadersListener(listener);

    recordClaudeRateLimitHeaders({
      upstreamBase: 'https://api.anthropic.com',
      responseHeaders: fromFetchHeaders({
        'anthropic-ratelimit-unified-5h-utilization': '1.06',
        'anthropic-ratelimit-unified-status': 'rejected',
      }),
      requestHeaders: { authorization: 'Bearer sk-ant-oat01-live' },
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].fiveHour.utilization).toBe(100);
    expect(listener.mock.calls[0][0].rateLimitStatus).toBe('rejected');
  });

  it('skips non-anthropic upstreams and header-less responses', () => {
    const listener = vi.fn();
    setClaudeRateLimitHeadersListener(listener);

    recordClaudeRateLimitHeaders({
      upstreamBase: XD_GATEWAY_BASE_URL,
      responseHeaders: fromFetchHeaders({ 'anthropic-ratelimit-unified-5h-utilization': '0.5' }),
      requestHeaders: { authorization: 'Bearer sk-ant-oat01-live' },
    });
    recordClaudeRateLimitHeaders({
      upstreamBase: 'https://api.anthropic.com',
      responseHeaders: fromFetchHeaders({ 'content-type': 'text/event-stream' }),
      requestHeaders: { authorization: 'Bearer sk-ant-oat01-live' },
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it('shares one dedupe state with the transparent-proxy observer', () => {
    // 同一账号、同一组数值, 先后经两条链路到达 —— 第二次必须被去抖掉,
    // 否则同一笔观测会落库 / 广播两次。
    const listener = vi.fn();
    setClaudeRateLimitHeadersListener(listener);
    const observer = createClaudeRateLimitHeadersObserver();

    observer(makeCtx());
    recordClaudeRateLimitHeaders({
      upstreamBase: 'https://api.anthropic.com',
      responseHeaders: fromFetchHeaders(makeCtx().responseHeaders as Record<string, string>),
      requestHeaders: makeCtx().requestHeaders as Record<string, string>,
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('still reports across links when the account changed', () => {
    const listener = vi.fn();
    setClaudeRateLimitHeadersListener(listener);
    const observer = createClaudeRateLimitHeadersObserver();

    observer(makeCtx({ requestHeaders: { authorization: 'Bearer sk-ant-oat01-old' } }));
    recordClaudeRateLimitHeaders({
      upstreamBase: 'https://api.anthropic.com',
      responseHeaders: fromFetchHeaders(makeCtx().responseHeaders as Record<string, string>),
      requestHeaders: { authorization: 'Bearer sk-ant-oat01-new' },
    });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1][1]).toBe('sk-ant-oat01-new');
  });
});
