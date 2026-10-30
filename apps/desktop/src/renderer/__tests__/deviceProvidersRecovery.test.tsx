// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function fixture() {
  const invoke = vi.fn().mockRejectedValue(new Error('[DEVICE_LINK_TIMEOUT] timed out'));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { deviceLink: { invoke } },
  });
  const mod = await import('@/hooks/useDeviceProviders');
  let latest: ReturnType<typeof mod.useDeviceProviders>;
  function Probe({ device = 'a' }: { device?: string }) {
    latest = mod.useDeviceProviders(device);
    return null;
  }
  const view = render(<Probe />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return { invoke, mod, Probe, view, latest: () => latest! };
}

function foreground() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('mounted remote catalog recovery', () => {
  it('recovers on foreground entry and deduplicates readers without periodic retries', async () => {
    const f = await fixture();
    const other = render(<f.Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const before = f.invoke.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(f.invoke.mock.calls.length).toBe(before);
    f.invoke.mockResolvedValue({ providers: [] });
    await act(async () => {
      foreground();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(f.invoke.mock.calls.length).toBe(before + 1);
    expect(f.latest().error).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(f.invoke.mock.calls.length).toBe(before + 1);
    other.unmount();
  });

  it.each([
    '[DEVICE_LINK_CHANNEL_NOT_ALLOWED] old host',
    '[ACCESS_REVOKED] denied',
    'Invalid provider list response',
  ])('stops retrying permanent failures: %s', async (error) => {
    const f = await fixture();
    f.invoke.mockRejectedValue(new Error(error));
    await act(async () => {
      foreground();
      await vi.advanceTimersByTimeAsync(0);
    });
    const count = f.invoke.mock.calls.length;
    await act(async () => {
      foreground();
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(f.invoke.mock.calls.length).toBe(count);
  });

  it('pauses hidden windows and immediately recovers on visibility', async () => {
    const f = await fixture();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(f.invoke).toHaveBeenCalledTimes(1);
    f.invoke.mockResolvedValue({ providers: [] });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(f.latest().error).toBeNull();
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });

  it.each(['unmount', 'device', 'owner'] as const)(
    'cancels recovery on %s change',
    async (change) => {
      const f = await fixture();
      if (change === 'unmount') f.view.unmount();
      if (change === 'device') f.view.rerender(<f.Probe device="b" />);
      if (change === 'owner') {
        const { setDataOwnerGeneration } = await import('@/contexts/dataOwnerGeneration');
        setDataOwnerGeneration('new-owner');
      }
      await act(async () => {
        foreground();
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(f.invoke.mock.calls.filter(([device]) => device === 'a')).toHaveLength(1);
    },
  );

  it('restarts recovery after invalidation followed by the same error', async () => {
    const f = await fixture();
    await act(async () => {
      f.mod.evictDeviceProviders('a');
      await f.mod.prefetchDeviceProviders('a');
    });
    const count = f.invoke.mock.calls.length;
    f.invoke.mockResolvedValue({ providers: [] });
    await act(async () => {
      foreground();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(f.invoke.mock.calls.length).toBe(count + 1);
    expect(f.latest().error).toBeNull();
  });
});
