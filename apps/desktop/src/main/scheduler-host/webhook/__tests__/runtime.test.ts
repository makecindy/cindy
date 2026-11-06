import { afterEach, expect, it, vi } from 'vitest';
import type { Scheduler } from '@cindy/maker-scheduler';

// Unit: the runtime owns dynamic module loading and the singleton, unlike the
// host tests. Stop during that await must cancel publication of the old owner.
// Minimal failure: start(old), stop(), start(new), then finish the pending loads.
const mocks = vi.hoisted(() => ({
  construct: vi.fn(), start: vi.fn(async () => {}), stop: vi.fn(async () => {}), unwatch: vi.fn(),
}));
vi.mock('electron', () => ({ app: { isPackaged: true }, BrowserWindow: {}, Notification: {} }));
vi.mock('../index.js', () => ({ ScheduleWebhookHost: class {
  constructor(scheduler: unknown) { mocks.construct(scheduler); }
  start = mocks.start;
  stop = mocks.stop;
  receiver = () => 'cloud';
} }));
vi.mock('../../../device-link/deviceName.js', () => ({ deviceName: () => 'fixture' }));
vi.mock('../../../authManager.js', () => ({
  getAuthState: () => ({ ownerGeneration: 1 }), onAuthStateChange: () => mocks.unwatch,
}));
vi.mock('../../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyAccountServices: true }) }));
vi.mock('../../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://example.test' }));
vi.mock('../../../maker-host/outbound-fetch.js', () => ({ createOutboundHttpAgent: vi.fn(), outboundFetch: vi.fn() }));

import { getScheduleWebhookHost, scheduleWebhookReceiver, startScheduleWebhooks, stopScheduleWebhooks } from '../runtime';

afterEach(async () => { await stopScheduleWebhooks(); vi.clearAllMocks(); });

it('does not publish a startup cancelled before dynamic imports complete', async () => {
  const pending = startScheduleWebhooks({} as Scheduler, {});
  await stopScheduleWebhooks();
  await pending;
  expect(getScheduleWebhookHost()).toBeNull();
  expect(mocks.construct).not.toHaveBeenCalled();
});

it('allows the new owner to start while the cancelled startup is still pending', async () => {
  const old = startScheduleWebhooks({} as Scheduler, {});
  await stopScheduleWebhooks();
  const scheduler = {} as Scheduler;
  await Promise.all([old, startScheduleWebhooks(scheduler, {})]);
  expect(mocks.construct).toHaveBeenCalledOnce();
  expect(mocks.construct.mock.calls[0][0]).toBe(scheduler);
  expect(getScheduleWebhookHost()).not.toBeNull();
});

it('stops an already published host while its start is still pending', async () => {
  let finish!: () => void;
  mocks.start.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const pending = startScheduleWebhooks({} as Scheduler, {});
  await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
  await stopScheduleWebhooks();
  finish();
  await pending;
  expect(getScheduleWebhookHost()).toBeNull();
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(mocks.unwatch).toHaveBeenCalledOnce();
});

// PR #8470, unit: successful/cancelled startup tests do not cover rejection.
// A failed start must release the singleton/listener so a later start can retry.
it('cleans up a failed startup and allows a fresh attempt', async () => {
  const error = new Error('initial scheduler read failed');
  mocks.start.mockRejectedValueOnce(error);
  await expect(startScheduleWebhooks({} as Scheduler, {})).rejects.toBe(error);
  expect(getScheduleWebhookHost()).toBeNull();
  expect(scheduleWebhookReceiver()).toBe('unavailable');
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(mocks.unwatch).toHaveBeenCalledOnce();
  const scheduler = {} as Scheduler;
  await startScheduleWebhooks(scheduler, {});
  expect(mocks.construct.mock.calls[1][0]).toBe(scheduler);
  expect(scheduleWebhookReceiver()).toBe('cloud');
});

it('does not clear a new owner when an old startup rejects late', async () => {
  const error = new Error('old startup failed');
  let fail!: (error: Error) => void;
  mocks.start.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  const old = startScheduleWebhooks({} as Scheduler, {});
  const rejected = expect(old).rejects.toBe(error);
  await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
  await stopScheduleWebhooks();
  await startScheduleWebhooks({} as Scheduler, {});
  const current = getScheduleWebhookHost();
  fail(error);
  await rejected;
  expect(getScheduleWebhookHost()).toBe(current);
  expect(scheduleWebhookReceiver()).toBe('cloud');
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(mocks.unwatch).toHaveBeenCalledOnce();
});

it('preserves the startup error if cleanup also fails', async () => {
  const error = new Error('queue load failed');
  const stopError = new Error('cleanup failed');
  const warn = vi.fn();
  mocks.start.mockRejectedValueOnce(error);
  mocks.stop.mockRejectedValueOnce(stopError);
  await expect(startScheduleWebhooks({} as Scheduler, { warn })).rejects.toBe(error);
  expect(getScheduleWebhookHost()).toBeNull();
  expect(scheduleWebhookReceiver()).toBe('unavailable');
  expect(mocks.unwatch).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith(expect.any(String), { error: String(stopError) });
});
