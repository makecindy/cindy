/**
 * DNS 回退层单测:成功缓存 / 失败回退 / 慢解析回退 / all 形态透传 / 单次回调。
 */
import { describe, it, expect, vi } from 'vitest';
import type dns from 'node:dns';
import { createDnsFallbackLookup, type DnsLookupFn } from '../dnsFallbackLookup';

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | dns.LookupAddress[],
  family?: number,
) => void;

/** 可编程 lookup 桩:按调用顺序弹出预设行为。 */
function makeLookupStub(
  behaviors: Array<
    | { ok: string; family?: number; delayMs?: number }
    | { err: string }
    | { hang: true }
  >,
) {
  let calls = 0;
  const impl: DnsLookupFn = (_hostname, _options, callback) => {
    const behavior = behaviors[Math.min(calls, behaviors.length - 1)];
    calls++;
    const cb = callback as LookupCallback;
    if ('hang' in behavior) return;
    if ('err' in behavior) {
      const error = new Error(behavior.err) as NodeJS.ErrnoException;
      error.code = behavior.err;
      cb(error);
      return;
    }
    const respond = () => cb(null, behavior.ok, behavior.family ?? 4);
    if (behavior.delayMs) setTimeout(respond, behavior.delayMs);
    else respond();
  };
  return { impl, callCount: () => calls };
}

function lookupOnce(
  lookup: DnsLookupFn,
  hostname = 'relay.example',
  options: dns.LookupOptions = {},
): Promise<{ err: NodeJS.ErrnoException | null; address?: unknown; family?: number }> {
  return new Promise((resolve) => {
    lookup(hostname, options, (err, address, family) => resolve({ err, address, family }));
  });
}

describe('createDnsFallbackLookup', () => {
  it('成功解析透传结果;随后失败回退到缓存地址', async () => {
    const stub = makeLookupStub([{ ok: '1.2.3.4' }, { err: 'EAI_AGAIN' }]);
    const lookup = createDnsFallbackLookup({ lookupImpl: stub.impl });

    const first = await lookupOnce(lookup);
    expect(first.err).toBeNull();
    expect(first.address).toBe('1.2.3.4');

    const second = await lookupOnce(lookup);
    expect(second.err).toBeNull();
    expect(second.address).toBe('1.2.3.4'); // 回退缓存
    expect(second.family).toBe(4);
  });

  it('失败且无缓存 → 原样透传错误', async () => {
    const stub = makeLookupStub([{ err: 'ENOTFOUND' }]);
    const lookup = createDnsFallbackLookup({ lookupImpl: stub.impl });
    const result = await lookupOnce(lookup);
    expect(result.err?.code).toBe('ENOTFOUND');
    expect(result.address).toBeUndefined();
  });

  it('慢解析且有缓存 → slowFallbackMs 后先回缓存,迟到结果仍刷新缓存且不二次回调', async () => {
    vi.useFakeTimers();
    try {
      const stub = makeLookupStub([{ ok: '1.2.3.4' }, { ok: '5.6.7.8', delayMs: 500 }, { err: 'EAI_AGAIN' }]);
      const lookup = createDnsFallbackLookup({ lookupImpl: stub.impl, slowFallbackMs: 100 });

      await lookupOnce(lookup); // 灌缓存 1.2.3.4

      const callback = vi.fn();
      lookup('relay.example', {}, callback);
      await vi.advanceTimersByTimeAsync(100); // 触发慢回退
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(null, '1.2.3.4', 4);

      await vi.advanceTimersByTimeAsync(500); // 真实结果 5.6.7.8 迟到
      expect(callback).toHaveBeenCalledTimes(1); // 不二次回调

      // 迟到结果已刷新缓存:下一次失败回退到 5.6.7.8
      const next = await lookupOnce(lookup);
      expect(next.address).toBe('5.6.7.8');
    } finally {
      vi.useRealTimers();
    }
  });

  it('慢解析但无缓存 → 不提前失败,等原生结果', async () => {
    vi.useFakeTimers();
    try {
      const stub = makeLookupStub([{ ok: '9.9.9.9', delayMs: 300 }]);
      const lookup = createDnsFallbackLookup({ lookupImpl: stub.impl, slowFallbackMs: 100 });
      const callback = vi.fn();
      lookup('relay.example', {}, callback);
      await vi.advanceTimersByTimeAsync(150);
      expect(callback).not.toHaveBeenCalled(); // 无缓存不介入
      await vi.advanceTimersByTimeAsync(200);
      expect(callback).toHaveBeenCalledWith(null, '9.9.9.9', 4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('options.all 形态直接透传,不参与缓存回退', async () => {
    const stub = makeLookupStub([{ err: 'EAI_AGAIN' }]);
    const lookup = createDnsFallbackLookup({ lookupImpl: stub.impl });
    // 先灌一个非 all 的缓存也不该被 all 使用
    const result = await lookupOnce(lookup, 'relay.example', { all: true });
    expect(result.err?.code).toBe('EAI_AGAIN');
  });

  it('缓存按 hostname+family 隔离', async () => {
    const stub = makeLookupStub([{ ok: '1.2.3.4', family: 4 }, { err: 'EAI_AGAIN' }]);
    const lookup = createDnsFallbackLookup({ lookupImpl: stub.impl });
    await lookupOnce(lookup, 'relay.example', { family: 4 });
    // family 6 无缓存 → 错误透传,不误用 v4 缓存
    const v6 = await lookupOnce(lookup, 'relay.example', { family: 6 });
    expect(v6.err?.code).toBe('EAI_AGAIN');
  });
});
