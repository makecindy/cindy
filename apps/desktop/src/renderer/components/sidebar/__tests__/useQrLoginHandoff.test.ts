// @vitest-environment jsdom
/*
 * 测试价值(「远程控制 Cindy」弹窗的扫码登录出码)
 * - 生产入口与可观察结果:useQrLoginHandoff 的 phase / payload 与它发出的 IPC 调用次数。
 * - 规则依据:docs/dev-rules/server-channel-review.md(轮询须有上限、离开即停、不自动续码)。
 * - 现有覆盖缺口:新增 hook,无相邻覆盖。
 * - 最小失败输入:弹窗关闭后仍轮询;被认领 / 到期后继续轮询;老服务端无接口时把下载码弄丢。
 * - tier:unit(jsdom + fake timers + 内存 IPC fake)。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QR_HANDOFF_POLL_INTERVAL_MS, useQrLoginHandoff, type QrLoginHandoffApi } from '../useQrLoginHandoff';

function fakeApi(states: Array<Awaited<ReturnType<QrLoginHandoffApi['authQrHandoffState']>>>) {
  let created = 0;
  return {
    authQrHandoffCreate: vi.fn(async () => ({
      success: true as const,
      handoffId: `handoff-${++created}-xxxxxxxx`,
      payload: `https://cindy.example/download/?cindy_login=${created}`,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    })),
    authQrHandoffState: vi.fn(async () => states.shift() ?? { success: true as const, status: 'pending' as const }),
    authQrHandoffDecide: vi.fn(async () => ({ success: true as const })),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useQrLoginHandoff', () => {
  it('creates a code while open, stops polling once a phone claims it, and refreshes after a decision', async () => {
    const api = fakeApi([
      { success: true, status: 'pending' },
      { success: true, status: 'claimed', requester: { clientType: 'mobile', deviceName: 'iPhone 15' } },
    ]);
    const { result } = renderHook(() => useQrLoginHandoff(true, api));
    await act(async () => {});
    expect(result.current.phase).toBe('ready');
    expect(result.current.payload).toContain('cindy_login=1');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QR_HANDOFF_POLL_INTERVAL_MS * 2);
    });
    expect(result.current.phase).toBe('claimed');
    expect(result.current.requester?.deviceName).toBe('iPhone 15');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QR_HANDOFF_POLL_INTERVAL_MS * 5);
    });
    expect(api.authQrHandoffState).toHaveBeenCalledTimes(2);

    await act(async () => {
      result.current.decide(true);
    });
    expect(api.authQrHandoffDecide).toHaveBeenCalledWith('handoff-1-xxxxxxxx', true);
    expect(result.current.lastDecision).toBe('approved');
    expect(result.current.payload).toContain('cindy_login=2');
  });

  it('stops polling at expiry and when the dialog closes', async () => {
    const api = fakeApi([]);
    const { result, rerender } = renderHook(({ open }) => useQrLoginHandoff(open, api), {
      initialProps: { open: true },
    });
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(121_000);
    });
    expect(result.current.phase).toBe('expired');
    const callsAtExpiry = api.authQrHandoffState.mock.calls.length;
    expect(callsAtExpiry).toBeLessThanOrEqual(60);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(api.authQrHandoffState).toHaveBeenCalledTimes(callsAtExpiry);

    act(() => result.current.refresh());
    await act(async () => {});
    rerender({ open: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current.phase).toBe('idle');
    expect(api.authQrHandoffState).toHaveBeenCalledTimes(callsAtExpiry);
  });

  it('falls back to the plain download code when the server cannot create a login code', async () => {
    const api = {
      ...fakeApi([]),
      authQrHandoffCreate: vi.fn(async () => ({ success: false as const, code: 'NOT_FOUND' })),
    };
    const { result } = renderHook(() => useQrLoginHandoff(true, api));
    await act(async () => {});
    expect(result.current.phase).toBe('unavailable');
    expect(result.current.payload).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(api.authQrHandoffState).not.toHaveBeenCalled();
  });
});
