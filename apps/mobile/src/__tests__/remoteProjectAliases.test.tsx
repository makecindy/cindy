// @vitest-environment jsdom
// #6916, unit: mount the production hook and observe names, invalidation, reconnect
// and late replies. Existing project-order tests do not cover alias snapshots.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  push: null as null | ((id: string) => void),
  active: null as null | ((state: string) => void),
  accountGeneration: 1,
  offline: new Set<string>(),
  context: {
    connectionEpoch: 1,
    status: 'online',
    recoveringDeviceIds: new Set<string>(),
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
  },
}));
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ accountGeneration: h.accountGeneration }),
}));
vi.mock('@/device-link/unresponsiveDevicesStore', () => ({
  useUnresponsiveDevices: () => new Set(),
}));
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_: string, cb: typeof h.active) => {
      h.active = cb;
      return {
        remove: () => {
          h.active = null;
        },
      };
    },
  },
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({
  useDeviceLink: () => ({
    ...h.context,
    invoke: h.invoke,
    getPresenceAvailability: (id: string) => !h.offline.has(id),
  }),
  subscribeRemoteProjectAliasesChanged: (cb: typeof h.push) => {
    h.push = cb;
    return () => {
      h.push = null;
    };
  },
}));
import { useRemoteProjectAliases } from '@/session/useRemoteProjectAliases';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { remoteProjectAlias } from '@cindy/maker-shared/mobile-home';
let view: ReadonlyMap<string, string>;
let root: ReturnType<typeof createRoot>;
function Probe({ ids = ['a'] }: { ids?: string[] }) {
  view = useRemoteProjectAliases(ids);
  return createElement(
    'span',
    null,
    remoteProjectAlias(view, ids[0], '/repo/app') ?? 'app',
  );
}
const rows = (alias: string) => [{ projectKey: 'local:/repo/app', alias }];
const render = async (ids = ['a']) => {
  await act(async () => root.render(createElement(Probe, { ids })));
};
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  h.accountGeneration = 1;
  h.context.connectionEpoch = 1;
  h.context.status = 'online';
  h.context.recoveringDeviceIds.clear();
  h.offline.clear();
  setMobileAuthOwner('alias-owner');
  h.invoke.mockReset().mockResolvedValue(rows('Portal'));
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});
it('shows host names, refreshes on rename and clear, and isolates same paths on two hosts', async () => {
  h.invoke.mockImplementation(async (id) =>
    rows(id === 'a' ? 'Portal' : 'Other'),
  );
  await render(['a', 'b']);
  expect(remoteProjectAlias(view, 'a', '/repo/app')).toBe('Portal');
  expect(remoteProjectAlias(view, 'b', '/repo/app')).toBe('Other');
  h.invoke.mockResolvedValue(rows('Renamed'));
  await act(async () => h.push?.('a'));
  expect(remoteProjectAlias(view, 'a', '/repo/app')).toBe('Renamed');
  expect(remoteProjectAlias(view, 'b', '/repo/app')).toBe('Other');
  h.invoke.mockResolvedValue([]);
  await act(async () => h.push?.('a'));
  expect(remoteProjectAlias(view, 'a', '/repo/app')).toBeUndefined();
});
it('discards a read overtaken by a rename and rereads after reconnect and foreground', async () => {
  await render();
  let resolve!: (rows: unknown) => void;
  h.invoke.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => h.push?.('a'));
  h.invoke.mockResolvedValue(rows('Newest'));
  await act(async () => {
    h.push?.('a');
    resolve(rows('Stale'));
  });
  expect(remoteProjectAlias(view, 'a', '/repo/app')).toBe('Newest');
  h.context.connectionEpoch++;
  h.invoke.mockResolvedValue(rows('Reconnected'));
  await render();
  expect(remoteProjectAlias(view, 'a', '/repo/app')).toBe('Reconnected');
  h.invoke.mockResolvedValue(rows('Foreground'));
  await act(async () => h.active?.('active'));
  expect(remoteProjectAlias(view, 'a', '/repo/app')).toBe('Foreground');
  h.offline.add('a');
  await render();
  const calls = h.invoke.mock.calls.length;
  await act(async () => h.push?.('a'));
  expect(h.invoke.mock.calls).toHaveLength(calls);
  h.offline.clear();
  h.invoke.mockResolvedValue(rows('Online again'));
  await render();
  expect(remoteProjectAlias(view, 'a', '/repo/app')).toBe('Online again');
});
it('keeps transient failures bounded, but clears stale names for an unsupported old host', async () => {
  await render();
  h.invoke.mockRejectedValue(new Error('offline'));
  await act(async () => h.push?.('a'));
  expect(remoteProjectAlias(view, 'a', '/repo/app')).toBe('Portal');
  const calls = h.invoke.mock.calls.length;
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  expect(h.invoke.mock.calls.length - calls).toBe(2);
  h.invoke.mockRejectedValue(
    Object.assign(new Error('Old host'), { code: 'CHANNEL_NOT_ALLOWED' }),
  );
  await act(async () => h.push?.('a'));
  expect(view.size).toBe(0);
});
it('rejects late old-account/device replies and clears old-account names immediately', async () => {
  await render();
  let resolve!: (rows: unknown) => void;
  h.invoke.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => h.push?.('a'));
  setMobileAuthOwner('another-owner');
  h.accountGeneration++;
  h.invoke.mockResolvedValue([]);
  await render(['b']);
  await act(async () => resolve(rows('Private old name')));
  expect(view.size).toBe(0);
});
