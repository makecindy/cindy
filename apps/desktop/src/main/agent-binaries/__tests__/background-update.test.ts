import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../../manifestService';

const mocks = vi.hoisted(() => ({
  packaged: true,
  personal: false,
  observe: undefined as ((manifest: Manifest) => void) | undefined,
  unsubscribe: vi.fn(),
  prefetch: vi.fn(),
  once: vi.fn(),
}));
vi.mock('electron', () => ({ app: {
  get isPackaged() { return mocks.packaged; },
  once: mocks.once,
  removeListener: vi.fn(),
} }));
vi.mock('../../cindy-make/versionRuntimeIdentity.js', () => ({ isCindyPersonalRuntime: () => mocks.personal }));
vi.mock('../../manifestService.js', () => ({
  getCachedManifest: () => ({ app: { version: '1.0.0' } }),
  onManifestFetched: (callback: (manifest: Manifest) => void) => {
    mocks.observe = callback;
    return mocks.unsubscribe;
  },
}));
vi.mock('../index.js', () => ({ prefetch: mocks.prefetch }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

import { startBinaryBackgroundUpdates, stopBinaryBackgroundUpdates } from '../background-update';

/*
 * Production start/manifest observer/stop lifecycle. Existing installer tests do
 * not exercise scheduling: prefetch must not gate startup or keep running after
 * exit, and failures must retry on a later manifest. Minimal inputs are readiness
 * plus one manifest or cancellation. Tier: unit; timers and network are fake.
 */
describe('binary background update lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.packaged = true;
    mocks.personal = false;
    mocks.observe = undefined;
    mocks.prefetch.mockReset().mockResolvedValue(true);
    mocks.unsubscribe.mockClear();
    mocks.once.mockClear();
  });
  afterEach(() => { stopBinaryBackgroundUpdates(); vi.useRealTimers(); });

  it('starts once after readiness without blocking startup and uses the cached manifest', async () => {
    expect(startBinaryBackgroundUpdates()).toBeUndefined();
    startBinaryBackgroundUpdates();
    expect(mocks.once).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(mocks.prefetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(mocks.prefetch.mock.calls.map(([kind]) => kind)).toEqual(['claude-code', 'codex', 'pi']);
    expect(mocks.prefetch.mock.calls[0][1].manifest.app.version).toBe('1.0.0');
  });

  it('retries failed preparation when the app next fetches fresh metadata, without a separate polling loop', async () => {
    mocks.prefetch.mockResolvedValue(false);
    startBinaryBackgroundUpdates();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(mocks.prefetch).toHaveBeenCalledTimes(3);
    const manifest = { app: { version: '2.0.0' } };
    mocks.observe?.(manifest);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.prefetch).toHaveBeenCalledTimes(6);
    expect(mocks.prefetch.mock.calls[3][1].manifest).toBe(manifest);
  });

  it('cancels in-flight work and removes the observer when quitting', async () => {
    const preparation = Promise.withResolvers<boolean>();
    mocks.prefetch.mockReturnValueOnce(preparation.promise);
    startBinaryBackgroundUpdates();
    await vi.advanceTimersByTimeAsync(10_001);
    const signal = mocks.prefetch.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    stopBinaryBackgroundUpdates();
    expect(signal.aborted).toBe(true);
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    preparation.resolve(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.prefetch).toHaveBeenCalledOnce();
  });

  it.each(['development', 'personal'] as const)('leaves %s builds on their existing update policy', async mode => {
    mocks.packaged = mode !== 'development';
    mocks.personal = mode === 'personal';
    startBinaryBackgroundUpdates();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.observe).toBeUndefined();
    expect(mocks.prefetch).not.toHaveBeenCalled();
  });
});
