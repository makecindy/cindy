import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
import { createRemoteReadRecovery } from '@/device-link/remoteReadRecovery';
afterEach(() => vi.useRealTimers());
it('backs off failed reads, coalesces events, resets after success and cancels on disposal', async () => {
  vi.useFakeTimers();
  const retry = vi.fn();
  const recovery = createRemoteReadRecovery(retry, () => true);
  recovery.failed(new Error('INVOKE_TIMEOUT'));
  recovery.failed(new Error('INVOKE_TIMEOUT'));
  await vi.advanceTimersByTimeAsync(899); expect(retry).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(retry).toHaveBeenCalledTimes(1);
  recovery.failed(new Error('DEVICE_UNRESPONSIVE'));
  await vi.advanceTimersByTimeAsync(1799); expect(retry).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(retry).toHaveBeenCalledTimes(2);
  recovery.succeeded(); recovery.failed(new Error('NOT_CONNECTED'));
  await vi.advanceTimersByTimeAsync(900); expect(retry).toHaveBeenCalledTimes(3);
  recovery.failed(new Error('NOT_CONNECTED')); recovery.dispose();
  await vi.advanceTimersByTimeAsync(60000); expect(retry).toHaveBeenCalledTimes(3);
});
it.each(['ACCESS_REVOKED', 'NOT_FOUND', 'REMOTE_DISABLED', 'CHANNEL_NOT_ALLOWED', 'PRECONDITION_FAILED', 'INTERNAL'])('does not retry permanent failure %s', async code => {
  vi.useFakeTimers(); const retry = vi.fn(); const recovery = createRemoteReadRecovery(retry, () => true);
  recovery.failed(new Error(code)); await vi.advanceTimersByTimeAsync(60000);
  expect(retry).not.toHaveBeenCalled(); recovery.dispose();
});
it('drops a timer when the account, foreground or page is no longer current', async () => {
  vi.useFakeTimers(); let current = true; const retry = vi.fn();
  const recovery = createRemoteReadRecovery(retry, () => current);
  recovery.failed(new Error('NOT_CONNECTED')); current = false;
  await vi.advanceTimersByTimeAsync(60000); expect(retry).not.toHaveBeenCalled(); recovery.dispose();
});
