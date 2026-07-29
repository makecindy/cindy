/**
 * retry-escalation 单测 — TurnRetryTracker 的升级阈值与
 * buildBackendUnreachableMessage 的文案契约 (issue #677)。
 */

import { describe, expect, it } from 'vitest';

import {
  TurnRetryTracker,
  buildBackendUnreachableMessage,
  RETRY_ESCALATION_MAX_COUNT,
  RETRY_ESCALATION_MAX_ELAPSED_MS,
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
});
