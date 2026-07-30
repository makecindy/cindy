/**
 * retry-escalation 单测 — TurnRetryTracker 的升级阈值与
 * buildBackendUnreachableMessage 的文案契约 (issue #677)。
 */

import { describe, expect, it } from 'vitest';

import {
  TurnRetryTracker,
  buildBackendUnreachableMessage,
  describeOutboundPath,
  RETRY_ESCALATION_MAX_COUNT,
  RETRY_ESCALATION_MAX_ELAPSED_MS,
  type OutboundPathFact,
} from './retry-escalation.js';

describe('TurnRetryTracker', () => {
  it('does not escalate before the count threshold', () => {
    const t = new TurnRetryTracker();
    let last;
    for (let i = 0; i < RETRY_ESCALATION_MAX_COUNT - 1; i += 1) {
      last = t.track('turn-1', 1000 + i * 1000);
    }
    expect(last!.escalate).toBe(false);
    expect(last!.retryCount).toBe(RETRY_ESCALATION_MAX_COUNT - 1);
  });

  it('escalates at the count threshold', () => {
    const t = new TurnRetryTracker();
    let last;
    for (let i = 0; i < RETRY_ESCALATION_MAX_COUNT; i += 1) {
      last = t.track('turn-1', 1000 + i * 100); // 快速重试, elapsed 很小
    }
    expect(last!.escalate).toBe(true);
    expect(last!.retryCount).toBe(RETRY_ESCALATION_MAX_COUNT);
  });

  it('escalates when the elapsed time crosses the cap even with few retries', () => {
    const t = new TurnRetryTracker();
    t.track('turn-1', 0);
    const slow = t.track('turn-1', RETRY_ESCALATION_MAX_ELAPSED_MS + 1);
    expect(slow.retryCount).toBe(2);
    expect(slow.escalate).toBe(true);
  });

  it('treats a turnId change as a fresh sequence', () => {
    const t = new TurnRetryTracker();
    for (let i = 0; i < RETRY_ESCALATION_MAX_COUNT - 1; i += 1) {
      t.track('turn-1', i * 1000);
    }
    const fresh = t.track('turn-2', 999_000);
    expect(fresh.retryCount).toBe(1);
    expect(fresh.escalate).toBe(false);
  });

  it('reset() clears the sequence', () => {
    const t = new TurnRetryTracker();
    for (let i = 0; i < RETRY_ESCALATION_MAX_COUNT - 1; i += 1) {
      t.track('turn-1', i * 1000);
    }
    t.reset();
    const fresh = t.track('turn-1', 999_000);
    expect(fresh.retryCount).toBe(1);
    expect(fresh.escalate).toBe(false);
  });
});

describe('buildBackendUnreachableMessage', () => {
  it('remote variant names the host, keeps the last error, and points at the proxy tunnel setting', () => {
    const msg = buildBackendUnreachableMessage({
      isRemote: true,
      remoteHostId: 'gpu-box',
      retryCount: 30,
      elapsedMs: 32_000,
      lastError: 'unexpected status 403 Forbidden',
    });
    expect(msg).toContain('"gpu-box"');
    expect(msg).toContain('chatgpt.com');
    expect(msg).toContain('403 Forbidden');
    expect(msg).toContain('30 times');
    expect(msg).toContain('32s');
    expect(msg).toContain('Route agent traffic via local proxy');
  });

  it('local variant omits the tunnel hint and host', () => {
    const msg = buildBackendUnreachableMessage({
      isRemote: false,
      retryCount: 5,
      elapsedMs: 121_000,
      lastError: 'fetch failed',
    });
    expect(msg).toContain('fetch failed');
    expect(msg).toContain('121s');
    expect(msg).not.toContain('local proxy');
    expect(msg).not.toContain('SSH remote hosts');
  });

  it('collapses whitespace and truncates a pathological last error', () => {
    const long = `line1\nline2   ${'x'.repeat(500)}`;
    const msg = buildBackendUnreachableMessage({
      isRemote: true,
      remoteHostId: 'h',
      retryCount: 1,
      elapsedMs: 0,
      lastError: long,
    });
    expect(msg).not.toContain('\nline2');
    expect(msg.length).toBeLessThan(900);
  });

  it('local variant replaces the generic cause list with the measured outbound path', () => {
    const msg = buildBackendUnreachableMessage({
      isRemote: false,
      retryCount: 30,
      elapsedMs: 30_000,
      lastError: 'fetch failed',
      outboundPath: {
        source: 'system',
        kind: 'direct',
        upstream: 'https://chatgpt.com',
      },
    });
    expect(msg).toContain('direct connection');
    expect(msg).toContain('https://chatgpt.com');
    // 通用四选一猜测清单应被实测事实取代,否则两段互相矛盾。
    expect(msg).not.toContain('Likely causes');
  });

  it('falls back to the generic cause list when no outbound fact is available', () => {
    const msg = buildBackendUnreachableMessage({
      isRemote: false,
      retryCount: 30,
      elapsedMs: 30_000,
      lastError: 'fetch failed',
      outboundPath: null,
    });
    expect(msg).toContain('Likely causes');
  });

  it('never attaches the local outbound path to a remote failure', () => {
    // 远端 daemon 在远端机器上自己出网 — 报本机代理判定会把排查指向错误的机器。
    const msg = buildBackendUnreachableMessage({
      isRemote: true,
      remoteHostId: 'gpu-box',
      retryCount: 30,
      elapsedMs: 30_000,
      lastError: 'Network unreachable',
      outboundPath: {
        source: 'env',
        kind: 'proxy',
        proxy: 'http://127.0.0.1:7890',
        upstream: 'https://chatgpt.com',
      },
    });
    expect(msg).not.toContain('127.0.0.1:7890');
    expect(msg).not.toContain("Cindy's outbound path");
    expect(msg).toContain('Route agent traffic via local proxy');
  });
});

describe('describeOutboundPath', () => {
  const fact = (over: Partial<OutboundPathFact>): OutboundPathFact => ({
    source: 'system',
    kind: 'direct',
    upstream: 'https://chatgpt.com',
    ...over,
  });

  it('names the proxy and where the verdict came from', () => {
    expect(describeOutboundPath(fact({
      kind: 'proxy', proxy: 'http://127.0.0.1:7890', source: 'env',
    }))).toContain('via http://127.0.0.1:7890');
    expect(describeOutboundPath(fact({
      kind: 'proxy', proxy: 'socks5://127.0.0.1:7891', source: 'system',
    }))).toContain('system proxy settings');
  });

  it('states a system-sourced direct path without asserting the system has no proxy', () => {
    // 只有「没有代理 env」可以断言(走到 system 分支的前提)。系统侧不能断言 ——
    // resolveProxy 是逐 URL 解析,系统可能配了代理、只是 PAC/bypass 豁免了这个上游,
    // 那时它对该 URL 就返回 DIRECT。说成「系统报告无代理」会盖掉这种 bypass。
    const text = describeOutboundPath(fact({ source: 'system', kind: 'direct' }));
    expect(text).toContain('direct connection');
    expect(text).toContain('no proxy env var is set');
    expect(text).toContain('returned a direct route for this upstream');
    expect(text).toContain('bypassing this host');
    expect(text).not.toContain('reported none');
  });

  it('renders an env-sourced direct path as a bypass, never as missing proxy config', () => {
    // 走 env 分支的前提恰恰是**有**代理 env。此时的 direct 意味着配了代理却对这个
    // 上游不生效(NO_PROXY 豁免 / 没有覆盖该 scheme 的变量)。说成「没设代理」会
    // 盖掉真正的故障原因,把用户推向反方向。
    const text = describeOutboundPath(fact({ source: 'env', kind: 'direct' }));
    expect(text).toContain('proxy env vars are set');
    expect(text).toContain('NO_PROXY');
    expect(text).toContain('bypassed');
    expect(text).not.toContain('no proxy env var is set');
    expect(text).not.toContain('reported none');
  });

  it('renders an unsupported system proxy as configured-but-unusable, not as absent', () => {
    // 企业 PAC 只给 HTTPS(TLS-to-proxy)出口时,行为上是直连,但原因是「Cindy 用
    // 不了那个形态」。报成「没有代理」会让用户以为配置正常,而正确动作是换出口类型。
    const text = describeOutboundPath(fact({ source: 'system', kind: 'unsupported' }));
    expect(text).toContain('do list a proxy');
    expect(text).toContain('cannot use');
    expect(text).toContain('SOCKS5');
    expect(text).not.toContain('no proxy env var is set');
  });

  it('points env-sourced unsupported values at the variable, not the system settings', () => {
    // unsupported 也可能来自 env(HTTPS_PROXY=https://… / socks4://),此时该改的是
    // 变量值而不是系统设置 —— 指错位置等于没给动作。
    const text = describeOutboundPath(fact({ source: 'env', kind: 'unsupported' }));
    expect(text).toContain('proxy env var is set');
    expect(text).toContain('http:// or socks5://');
    expect(text).not.toContain('system proxy settings');
  });

  it('always returns a non-empty diagnostic for every kind', () => {
    for (const kind of ['proxy', 'direct', 'unsupported', 'unknown'] as const) {
      for (const source of ['env', 'system'] as const) {
        expect(describeOutboundPath(fact({ kind, source })).length).toBeGreaterThan(0);
      }
    }
  });

  it('marks an unresolved path as a guess rather than a confirmed no-proxy', () => {
    // 这条是整个改动的语义核心:超时兜底不得被读成「确认无代理」。
    const text = describeOutboundPath(fact({ kind: 'unknown', reason: 'resolve_timeout' }));
    expect(text).toContain('could not determine');
    expect(text).toContain('resolve_timeout');
    expect(text).toContain('a guess');
    expect(text).not.toContain('reported none');
  });
});
