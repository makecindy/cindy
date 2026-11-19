import { describe, expect, it, vi } from 'vitest';
import type { DeviceView } from '@cindy/device-link';
import { DEVICE_LINK_USAGE_WIDGET_SNAPSHOT_CHANNEL } from '@cindy/maker-shared/device-link-contract';

const native = vi.hoisted(() => ({ readSnapshot: () => null, readPinnedDeviceIds: () => ['b'], writeSnapshot: vi.fn(() => true) }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => native }));

const { refreshUsageWidgetStore, refreshUsageWidgets } = await import('@/widgets/usageWidgetSync');

function device(deviceId: string, patch: Partial<DeviceView> = {}): DeviceView {
  return {
    deviceId, name: deviceId, platform: 'darwin', appVersion: '1', lastSeenAt: null,
    online: true, busy: false, remoteControlEnabled: true, isSelf: false, ...patch,
  };
}

const snapshot = { version: 1, sources: [], usage: { scope: 'all', days: [], daily: [] }, strings: {} };
const tooOld = Object.assign(new Error('[CHANNEL_NOT_ALLOWED] not allowed'), { code: 'CHANNEL_NOT_ALLOWED' });

// A computer that does not answer keeps its last state; "automatic" sticks to the computer
// that answered last; only "every reachable computer is too old" shows the update prompt.
describe('refreshUsageWidgetStore', () => {
  it('asks Macs first, skips this phone and remote-off devices, and lists offline computers', async () => {
    const asked: string[] = [];
    const invoke = vi.fn(async (deviceId: string, channel: string) => {
      asked.push(deviceId);
      expect(channel).toBe(DEVICE_LINK_USAGE_WIDGET_SNAPSHOT_CHANNEL);
      return { ok: true, snapshot };
    });
    const store = await refreshUsageWidgetStore(null, [
      device('pc', { platform: 'win32' }),
      device('phone', { platform: 'ios', isSelf: true }),
      device('off', { online: false }),
      device('locked', { remoteControlEnabled: false }),
      device('mac'),
    ], invoke as never, [], () => 7);
    expect(asked).toEqual(['mac']);
    expect(store.autoDeviceId).toBe('mac');
    expect(store.computers.map(computer => computer.id)).toEqual(['pc', 'off', 'mac']);
    expect(store.states.mac).toMatchObject({ kind: 'snapshot', deviceName: 'mac', receivedAtMs: 7 });
  });

  it('prefers the computer that answered last, asks pinned ones too, and keeps what went unanswered', async () => {
    const first = await refreshUsageWidgetStore(null, [device('mac'), device('pc', { platform: 'win32' })],
      (async () => ({ ok: true, snapshot })) as never, ['pc'], () => 1);
    const previous = { ...first, autoDeviceId: 'pc' };
    const asked: string[] = [];
    const invoke = vi.fn(async (deviceId: string) => {
      asked.push(deviceId);
      if (deviceId === 'pc') throw new Error('timeout');
      return { ok: true, snapshot };
    });
    const store = await refreshUsageWidgetStore(previous, [device('mac'), device('pc', { platform: 'win32' }), device('mini')],
      invoke as never, ['mini'], () => 2);
    expect(asked).toEqual(['pc', 'mac', 'mini']);
    expect(store.autoDeviceId).toBe('mac');
    expect(store.states.pc).toMatchObject({ kind: 'snapshot', receivedAtMs: 1 });
    expect(store.states.mini).toMatchObject({ kind: 'snapshot', receivedAtMs: 2 });
  });

  it('prompts for an update only when every reachable computer lacks the channel', async () => {
    const allOld = await refreshUsageWidgetStore(null, [device('a'), device('b')], (async () => { throw tooOld; }) as never, [], () => 1);
    expect(allOld.autoDeviceId).toBe('a');
    expect(allOld.states.a).toEqual({ kind: 'update-desktop', receivedAtMs: 1 });

    const mixed = vi.fn()
      .mockRejectedValueOnce(tooOld)
      .mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    expect((await refreshUsageWidgetStore(null, [device('a'), device('b')], mixed as never)).autoDeviceId).toBeNull();
  });

  it('keeps a downgraded computer\'s snapshot unless a widget is set to it', async () => {
    const kept = { kind: 'snapshot' as const, receivedAtMs: 5, deviceName: 'a', snapshot: snapshot as never };
    const previous = { version: 2 as const, autoDeviceId: 'a', computers: [], states: { a: kept } };
    const answer = () => vi.fn().mockRejectedValueOnce(tooOld).mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    const auto = await refreshUsageWidgetStore(previous, [device('a'), device('b')], answer() as never, [], () => 9);
    expect(auto.autoDeviceId).toBe('a');
    expect(auto.states.a).toBe(kept);
    const pinned = await refreshUsageWidgetStore(previous, [device('a'), device('b')], answer() as never, ['a'], () => 9);
    expect(pinned.states.a).toEqual({ kind: 'update-desktop', receivedAtMs: 9 });
  });
});

// Production refreshUsageWidgets: late reads cannot write or issue another peer request
// after timeout/account change/new refresh (#11178). Prior coverage only tested peer selection.
// Minimum input: suspend the list, first or last peer; invalidate, resume. Tier: unit; no real waits.
// Measured wall time for this file: 1.31 s.
it.each(['list', 'peer', 'last-peer'] as const)('discards an expired refresh waiting on %s', async (stage) => {
  native.writeSnapshot.mockClear();
  let resume!: () => void;
  const suspended = new Promise<void>((resolve) => { resume = resolve; });
  let active = true;
  const invoke = vi.fn(async () => { if (stage !== 'list') await suspended; return { ok: true, snapshot }; });
  const latest = { current: {
    readDeviceList: async () => { if (stage === 'list') await suspended; return { devices: stage === 'last-peer' ? [device('a')] : [device('a'), device('b')] }; },
    invoke: invoke as never, accountGeneration: 1, userId: 'account',
  } };
  const pending = refreshUsageWidgets(latest, 1, () => active).catch(() => false);
  await Promise.resolve();
  active = false;
  resume();
  expect(await pending).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(stage === 'list' ? 0 : 1);
  expect(native.writeSnapshot).not.toHaveBeenCalled();
});

// Both mobile surfaces subscribe to the widget's automatic selection. A pinned
// computer finishing later must not replace it or expose another account's data.
it('publishes the automatic reading to the active account only', async () => {
  const { automaticUsageState, readUsageWidgetStore, subscribeUsageWidgetStore, writeUsageWidgetStore } = await import('@/widgets/usageWidgetSync');
  const store = await refreshUsageWidgetStore(null, [device('a'), device('b')],
    (async () => ({ ok: true, snapshot })) as never, ['b']);
  const notify = vi.fn();
  const unsubscribe = subscribeUsageWidgetStore(notify);
  writeUsageWidgetStore({ ...store, accountId: 'owner' });
  expect(notify).toHaveBeenCalledOnce();
  expect(automaticUsageState(readUsageWidgetStore(), 'owner')).toBe(store.states.a);
  expect(automaticUsageState(readUsageWidgetStore(), 'other')).toBeNull();
  expect(automaticUsageState(readUsageWidgetStore())).toBeNull();
  unsubscribe();
});
