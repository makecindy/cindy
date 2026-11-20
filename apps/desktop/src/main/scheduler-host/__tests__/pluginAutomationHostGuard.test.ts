// Unit tier: actual scheduler runner boundary, two synthetic devices and controlled account replies.
import { afterEach, expect, it, vi } from 'vitest';
import type { FireContext, Schedule, ScheduleRunner } from '@cindy/maker-scheduler';
import { withPluginAutomationHost } from '../pluginAutomationHostGuard.js';

const schedule = { id: 'contacts', primaryHostKey: 'public/cindy-contacts' } as Schedule;
const context = () => ({ runId: 'test', firedAt: Date.now(), signal: new AbortController().signal } as FireContext);
afterEach(() => vi.useRealTimers());

it('skips a follower, an offline host and remote execution before the first Agent call', async () => {
  const fire = vi.fn(async () => ({ sessionId: 'synthetic' }));
  const grants = vi.fn().mockResolvedValueOnce({ granted: false }).mockRejectedValueOnce(new Error('offline'));
  const guard = withPluginAutomationHost({ fire }, () => ({ run: grants }));
  for (const task of [schedule, schedule, { ...schedule, agentDeviceId: 'other' }]) {
    expect(await guard.fire(task, context())).toMatchObject({ skipped: true });
  }
  expect(await withPluginAutomationHost({ fire }).fire(schedule, context())).toMatchObject({ skipped: true });
  expect(fire).not.toHaveBeenCalled();
  expect(grants).toHaveBeenCalledTimes(2);
  await guard.fire({ ...schedule, primaryHostKey: undefined }, context());
  expect(fire).toHaveBeenCalledTimes(1);
});

it('keeps an interrupted continuation reclaimable when its host is offline or has changed', async () => {
  const fire = vi.fn(async () => ({ sessionId: 'original-task' }));
  const account = vi.fn().mockResolvedValueOnce({ granted: false }).mockRejectedValueOnce(new Error('offline'));
  const guard = withPluginAutomationHost({ fire }, () => ({ run: account }));
  const ctx = { ...context(), resumeSessionId: 'original-task' };
  await expect(guard.fire(schedule, ctx)).rejects.toThrow('selected primary computer');
  await expect(guard.fire(schedule, ctx)).rejects.toThrow('could not be confirmed');
  expect(fire).not.toHaveBeenCalled();
  expect(account).toHaveBeenCalledTimes(2);
});

it('renews the original claim and cancels the running Agent if the account loses it', async () => {
  vi.useFakeTimers();
  const grants = vi.fn().mockResolvedValueOnce({ granted: true, validForMs: 120_000 })
    .mockResolvedValueOnce({ granted: false }).mockResolvedValueOnce({ released: true });
  let active!: FireContext;
  const fire: ScheduleRunner['fire'] = async (_schedule, ctx) => {
    active = ctx;
    await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
    return { sessionId: 'synthetic' };
  };
  const pending = withPluginAutomationHost({ fire }, () => ({ run: grants })).fire(schedule, context());
  await vi.advanceTimersByTimeAsync(0);
  expect(active.canDispatch?.()).toBe(true);
  await vi.advanceTimersByTimeAsync(39_000);
  await pending;
  expect(active.canDispatch?.()).toBe(false);
  expect(() => active.assertFireContext?.()).toThrow();
  expect(grants.mock.calls.map(c => c[0])).toEqual(['acquire', 'renew', 'release']);
  expect(new Set(grants.mock.calls.map(c => c[1])).size).toBe(1);
});

it('rechecks owner scope after acquiring a lease and releases it if the task changed', async () => {
  const grants = vi.fn().mockResolvedValue({ granted: true, validForMs: 120_000 });
  const fire = vi.fn(async () => ({ sessionId: 'synthetic' }));
  const ctx = context();
  ctx.canDispatch = () => false;
  expect(await withPluginAutomationHost({ fire }, () => ({ run: grants })).fire(schedule, ctx)).toMatchObject({ skipped: true });
  expect(fire).not.toHaveBeenCalled();
  expect(grants.mock.calls.map(c => c[0])).toEqual(['acquire', 'release']);
});
