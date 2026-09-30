import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => h.exec }));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  accessSync: vi.fn(),
}));
import { lockLinuxDesktop } from '../linuxDesktop';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const reply = (secure = false, passwordPam = true) => ({
  stdout: JSON.stringify({ secure, passwordPam, locked: true, requested: true }),
});
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  vi.stubEnv('XDG_SESSION_ID', '1');
  vi.stubEnv('HYPRLAND_INSTANCE_SIGNATURE', 'test');
  h.exec.mockReset();
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
it('uses Omarchy lock IPC and waits for secure, not merely requested', async () => {
  vi.useFakeTimers();
  h.exec
    .mockResolvedValueOnce(reply())
    .mockResolvedValueOnce({ stdout: 'ok' })
    .mockResolvedValueOnce(reply())
    .mockResolvedValueOnce(reply(true));
  const locking = lockLinuxDesktop(() => true, new AbortController().signal);
  await vi.runAllTimersAsync();
  await locking;
  expect(h.exec.mock.calls.map((c) => [c[0], c[1]])).toEqual([
    ['/usr/bin/omarchy-shell', ['lock', 'status']],
    ['/usr/bin/omarchy-shell', ['lock', 'lock']],
    ['/usr/bin/omarchy-shell', ['lock', 'status']],
    ['/usr/bin/omarchy-shell', ['lock', 'status']],
  ]);
});
it('falls back to logind when the Omarchy interface is unavailable', async () => {
  h.exec
    .mockRejectedValueOnce(new Error('ENOENT'))
    .mockResolvedValueOnce({ stdout: '' })
    .mockResolvedValueOnce({ stdout: 'yes' });
  await lockLinuxDesktop(() => true, new AbortController().signal);
  expect(h.exec.mock.calls[1][1]).toEqual(['lock-session', '1']);
});
it('does not lock after the lease was revoked during the probe', async () => {
  let current = true;
  h.exec.mockImplementationOnce(async () => {
    current = false;
    return reply();
  });
  await expect(lockLinuxDesktop(() => current, new AbortController().signal)).rejects.toThrow(
    'DESKTOP_LEASE_EXPIRED',
  );
  expect(h.exec).toHaveBeenCalledTimes(1);
});
it('does not claim success after cancellation during acknowledgement', async () => {
  const cancellation = new AbortController();
  h.exec
    .mockResolvedValueOnce(reply())
    .mockResolvedValueOnce({ stdout: 'ok' })
    .mockImplementationOnce(async () => {
      cancellation.abort();
      return reply(true);
    });
  await expect(lockLinuxDesktop(() => true, cancellation.signal)).rejects.toThrow(
    'DESKTOP_LEASE_EXPIRED',
  );
});
it.each(['missing-pam', 'failed'])('rejects locker refusal: %s', async (stdout) => {
  h.exec.mockResolvedValueOnce(reply()).mockResolvedValueOnce({ stdout });
  await expect(lockLinuxDesktop(() => true, new AbortController().signal)).rejects.toThrow(
    'DESKTOP_LOCK_FAILED',
  );
  expect(h.exec).toHaveBeenCalledTimes(2);
});
it('does not treat a pending lock as success when acknowledgement times out', async () => {
  vi.useFakeTimers();
  h.exec
    .mockResolvedValue(reply())
    .mockResolvedValueOnce(reply())
    .mockResolvedValueOnce({ stdout: 'ok' });
  const result = expect(lockLinuxDesktop(() => true, new AbortController().signal)).rejects.toThrow(
    'DESKTOP_LOCK_FAILED',
  );
  await vi.runAllTimersAsync();
  await result;
});
