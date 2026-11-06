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

import { getScheduleWebhookHost, startScheduleWebhooks, stopScheduleWebhooks } from '../runtime';

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
