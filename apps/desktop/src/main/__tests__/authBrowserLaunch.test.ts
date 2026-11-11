import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_BROWSER_LAUNCH_TIMEOUT_MS, launchAuthBrowser } from '../authBrowserLaunch';

describe('system browser launch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('bounds a hung OS call and consumes its late rejection', async () => {
    let reject!: (reason: Error) => void;
    const open = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    const result = launchAuthBrowser(open, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(AUTH_BROWSER_LAUNCH_TIMEOUT_MS);
    await expect(result).resolves.toEqual({ opened: false, error: 'BROWSER_OPEN_TIMEOUT' });
    reject(new Error('late OS failure containing an auth URL'));
    await Promise.resolve();
    expect(open).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels promptly, ignoring a late successful OS response', async () => {
    let resolve!: () => void;
    const controller = new AbortController();
    const result = launchAuthBrowser(() => new Promise<void>((done) => { resolve = done; }), controller.signal);
    controller.abort();
    resolve();
    await expect(result).resolves.toEqual({ opened: false, error: 'USER_CANCELLED' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not launch a cancelled attempt', async () => {
    const controller = new AbortController();
    controller.abort();
    const open = vi.fn();
    await expect(launchAuthBrowser(open, controller.signal))
      .resolves.toEqual({ opened: false, error: 'USER_CANCELLED' });
    expect(open).not.toHaveBeenCalled();
  });

  it('clears the deadline after the OS accepts the request', async () => {
    await expect(launchAuthBrowser(async () => {}, new AbortController().signal))
      .resolves.toEqual({ opened: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['sync', 'async'])('reports a %s launch failure without exposing the OS error', async (mode) => {
    const error = new Error('https://auth.invalid/?secret=not-for-renderer');
    const open = mode === 'sync' ? () => { throw error; } : () => Promise.reject(error);
    await expect(launchAuthBrowser(open, new AbortController().signal))
      .resolves.toEqual({ opened: false, error: 'BROWSER_OPEN_FAILED' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
