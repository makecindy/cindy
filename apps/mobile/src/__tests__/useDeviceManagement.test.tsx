// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DeviceView } from '@cindy/device-link';
import { useDeviceManagement } from '@/device-link/useDeviceManagement';
import {
  setMobileAuthOwner,
  __testing as authOwnerTesting,
} from '@/auth/authOwnerGeneration';

const mocks = vi.hoisted(() => ({
  renameDevice: vi.fn(),
  removeDevice: vi.fn(),
  clearRevoked: vi.fn(),
  getDeviceIdentity: vi.fn(),
  setDeviceIdentity: vi.fn(),
}));
vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: vi.fn(),
  setSecureItem: vi.fn(),
}));
vi.mock('@/device-link/revokedDevicesStore', () => ({
  revokedDevicesStore: mocks,
}));
vi.mock('@/config/env', () => ({
  DEVICE_LINK_API_BASE_URL: 'https://relay.example.invalid',
}));
vi.mock('@/device-link/remoteStatus', () => ({
  formatRemoteError: (error: Error) => error.message,
}));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: mocks }));

const device: DeviceView = {
  deviceId: 'mac/1',
  name: 'MacBook',
  platform: 'darwin',
  appVersion: null,
  lastSeenAt: null,
  online: true,
  busy: false,
  remoteControlEnabled: true,
  isSelf: false,
};
const apiFetch = vi.fn();
let root: Root;
let state: ReturnType<typeof useDeviceManagement>;
function Harness({ focused }: { focused: boolean }) {
  state = useDeviceManagement(apiFetch, focused);
  return null;
}
async function render(key = 'account-a', focused = true) {
  await act(async () => root.render(createElement(Harness, { key, focused })));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  authOwnerTesting.reset();
  mocks.getDeviceIdentity.mockReturnValue([]);
  mocks.setDeviceIdentity.mockImplementation((items) =>
    mocks.getDeviceIdentity.mockReturnValue(items),
  );
  apiFetch.mockReset().mockResolvedValue({ devices: [device] });
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
});

it('keeps the last device list on refresh failure and can retry', async () => {
  await render();
  apiFetch.mockRejectedValueOnce(new Error('offline'));
  await act(async () => state.refresh());
  expect(state.devices).toEqual([device]);
  expect(state.error).toBe('offline');
  expect(state.loading).toBe(false);
  await act(async () => state.refresh());
  expect(state.error).toBeNull();
});

it('saves a trimmed device name once, then uses the authoritative returned name', async () => {
  await render();
  const save = deferred<{ name: string; deviceId: string }>();
  await act(async () => state.openRename(device));
  act(() => state.setRenameDraft('  Office Mac  '));
  apiFetch.mockImplementation((_path, options) =>
    options.method === 'PATCH'
      ? save.promise
      : Promise.resolve({ devices: [{ ...device, name: 'Office Mac' }] }),
  );
  let request!: Promise<void>;
  act(() => {
    request = state.confirmRename();
    void state.confirmRename();
    state.refresh();
    state.closeRename();
  });
  expect(state.renameTarget).toEqual(device);
  expect(
    apiFetch.mock.calls.filter(([, options]) => options.method === 'PATCH'),
  ).toHaveLength(1);
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/device-link/devices/mac%2F1',
    expect.objectContaining({
      method: 'PATCH',
      body: { name: 'Office Mac' },
      baseUrl: 'https://relay.example.invalid',
    }),
  );
  await act(async () => {
    save.resolve({ deviceId: device.deviceId, name: 'Office Mac' });
    await request;
  });
  expect(state.devices[0]?.name).toBe('Office Mac');
  expect(mocks.renameDevice).toHaveBeenCalledWith(
    device.deviceId,
    'Office Mac',
  );
  expect(state.renameTarget).toBeNull();
  expect(state.renameSaving).toBe(false);
});

it('keeps the rename editor and original name after a failed save', async () => {
  await render();
  act(() => state.openRename(device));
  act(() => state.setRenameDraft('New name'));
  apiFetch.mockRejectedValueOnce(new Error('rename failed'));
  await act(async () => state.confirmRename());
  expect(state.renameError?.message).toBe('rename failed');
  expect(state.renameTarget).toEqual(device);
  expect(state.renameDraft).toBe('New name');
  expect(state.devices[0]?.name).toBe('MacBook');
  expect(mocks.renameDevice).not.toHaveBeenCalled();
});

it('ignores an old list response after switching accounts', async () => {
  const oldList = deferred<{ devices: DeviceView[] }>();
  apiFetch.mockReturnValueOnce(oldList.promise);
  await render();
  const otherDevice = { ...device, deviceId: 'other', name: 'Other account' };
  apiFetch.mockResolvedValue({ devices: [otherDevice] });
  await render('account-b');
  await act(async () => oldList.resolve({ devices: [device] }));
  expect(state.devices).toEqual([otherDevice]);
});

it('does not let a previous account rename update the new account or shared store', async () => {
  await render();
  act(() => state.openRename(device));
  act(() => state.setRenameDraft('Old account name'));
  const save = deferred<{ deviceId: string; name: string }>();
  apiFetch.mockReturnValueOnce(save.promise);
  let request!: Promise<void>;
  act(() => {
    request = state.confirmRename();
  });
  apiFetch.mockResolvedValue({ devices: [] });
  await render('account-b');
  await act(async () => {
    save.resolve({ deviceId: device.deviceId, name: 'Old account name' });
    await request;
  });
  expect(state.devices).toEqual([]);
  expect(state.renameTarget).toBeNull();
  expect(mocks.renameDevice).not.toHaveBeenCalled();
});

it('ignores a list response after leaving the page and refreshes on return', async () => {
  const oldList = deferred<{ devices: DeviceView[] }>();
  apiFetch.mockReturnValueOnce(oldList.promise);
  await render();
  await render('account-a', false);
  await act(async () => oldList.resolve({ devices: [device] }));
  expect(state.devices).toEqual([]);
  await render();
  expect(state.devices).toEqual([device]);
});

it('deletes once and clears device projections only after server success', async () => {
  await render();
  act(() => state.openDelete(device));
  const removal = deferred<{ deviceId: string; deleted: boolean }>();
  apiFetch.mockImplementation((_path, options) =>
    options.method === 'DELETE'
      ? removal.promise
      : Promise.resolve({ devices: [] }),
  );
  let request!: Promise<boolean>;
  act(() => {
    request = state.confirmDelete();
    void state.confirmDelete();
    state.closeDelete();
    state.openRename(device);
  });
  expect(state.deleteTarget).toEqual(device);
  expect(state.renameTarget).toBeNull();
  expect(mocks.removeDevice).not.toHaveBeenCalled();
  expect(
    apiFetch.mock.calls.filter(([, options]) => options.method === 'DELETE'),
  ).toHaveLength(1);
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/device-link/devices/mac%2F1',
    expect.objectContaining({ method: 'DELETE' }),
  );
  await act(async () => {
    removal.resolve({ deviceId: device.deviceId, deleted: true });
    expect(await request).toBe(true);
  });
  expect(state.devices).toEqual([]);
  expect(mocks.removeDevice).toHaveBeenCalledWith(device.deviceId);
  expect(mocks.clearRevoked).toHaveBeenCalledWith(device.deviceId);
});

it('keeps device records and access state when deletion fails, including an online race', async () => {
  await render();
  act(() => state.openDelete(device));
  apiFetch.mockRejectedValueOnce(
    Object.assign(new Error('online'), { code: 'ALREADY_EXISTS' }),
  );
  await act(async () => {
    expect(await state.confirmDelete()).toBe(false);
  });
  expect(state.deleteError).toBeTruthy();
  expect(state.devices).toEqual([device]);
  expect(state.deleteTarget).toEqual(device);
  expect(mocks.removeDevice).not.toHaveBeenCalled();
  expect(mocks.clearRevoked).not.toHaveBeenCalled();
});

it('does not clear shared device state after an old-account deletion completes', async () => {
  await render();
  act(() => state.openDelete(device));
  const removal = deferred<{ deviceId: string; deleted: boolean }>();
  apiFetch.mockReturnValueOnce(removal.promise);
  let request!: Promise<boolean>;
  act(() => {
    request = state.confirmDelete();
  });
  apiFetch.mockResolvedValue({ devices: [] });
  await render('account-b');
  await act(async () => {
    removal.resolve({ deviceId: device.deviceId, deleted: true });
    expect(await request).toBe(false);
  });
  expect(mocks.removeDevice).not.toHaveBeenCalled();
  expect(mocks.clearRevoked).not.toHaveBeenCalled();
});

it('does not treat deleted=false as successful deletion', async () => {
  await render();
  act(() => state.openDelete(device));
  apiFetch.mockResolvedValueOnce({ deviceId: device.deviceId, deleted: false });
  await act(async () => {
    expect(await state.confirmDelete()).toBe(false);
  });
  expect(state.devices).toEqual([device]);
  expect(mocks.removeDevice).not.toHaveBeenCalled();
});

it('does not reload after cancelling rename and immediately allows deleting the same device', async () => {
  await render();
  const requestCount = apiFetch.mock.calls.length;
  act(() => state.openRename(device));
  act(() => state.closeRename());
  expect(state.loading).toBe(false);
  expect(apiFetch).toHaveBeenCalledTimes(requestCount);
  act(() => state.openDelete(device));
  expect(state.deleteTarget).toEqual(device);
});

it('rejects repeated oversized names without a request, then saves a 64-character name', async () => {
  await render();
  act(() => state.openRename(device));
  const oversized = 'x'.repeat(65);
  await act(async () => state.confirmRename(oversized));
  const firstError = state.renameError;
  expect(firstError?.message).toContain('64');
  expect(state.renameDraft).toBe(oversized);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  await act(async () => state.confirmRename(oversized));
  expect(state.renameError).not.toBe(firstError);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  const valid = 'x'.repeat(64);
  apiFetch.mockResolvedValueOnce({ deviceId: device.deviceId, name: valid });
  await act(async () => state.confirmRename(valid));
  expect(state.renameTarget).toBeNull();
  expect(state.devices[0]?.name).toBe(valid);
});

it('reuses known names for placeholder snapshots and keeps a successful rename across refreshes', async () => {
  mocks.getDeviceIdentity.mockReturnValue([
    { deviceId: device.deviceId, name: 'Known Mac' },
  ]);
  apiFetch.mockResolvedValue({
    devices: [{ ...device, online: false, name: 'unknown' }],
  });
  await render();
  expect(state.devices[0]?.name).toBe('Known Mac');
  act(() => state.openRename(state.devices[0]!));
  apiFetch.mockResolvedValueOnce({
    deviceId: device.deviceId,
    name: 'Renamed Mac',
  });
  await act(async () => state.confirmRename('Renamed Mac'));
  expect(mocks.getDeviceIdentity()).toEqual([
    { deviceId: device.deviceId, name: 'Renamed Mac' },
  ]);
  apiFetch.mockResolvedValue({
    devices: [{ ...device, online: false, name: 'no' }],
  });
  await act(async () => state.refresh());
  expect(state.devices[0]?.name).toBe('Renamed Mac');
  act(() => state.openDelete(state.devices[0]!));
  apiFetch.mockResolvedValueOnce({ deviceId: device.deviceId, deleted: true });
  await act(async () => state.confirmDelete());
  expect(mocks.getDeviceIdentity()).toEqual([]);
});

it('ignores a rename response when the auth owner changes before React remounts', async () => {
  setMobileAuthOwner('account-a');
  await render();
  act(() => state.openRename(device));
  const save = deferred<{ deviceId: string; name: string }>();
  apiFetch.mockReturnValueOnce(save.promise);
  let request!: Promise<void>;
  act(() => {
    request = state.confirmRename('Old name');
  });
  setMobileAuthOwner('account-b');
  await act(async () => {
    save.resolve({ deviceId: device.deviceId, name: 'Old name' });
    await request;
  });
  expect(mocks.renameDevice).not.toHaveBeenCalled();
  expect(mocks.setDeviceIdentity).not.toHaveBeenCalled();
  expect(state.devices[0]?.name).toBe('MacBook');
});

it('uses a newly learned shared name even when the current view still contains a placeholder', async () => {
  apiFetch.mockResolvedValue({
    devices: [{ ...device, online: false, name: 'unknown' }],
  });
  await render();
  mocks.getDeviceIdentity.mockReturnValue([
    { deviceId: device.deviceId, name: 'Known Mac' },
  ]);
  await act(async () => state.refresh());
  expect(state.devices[0]?.name).toBe('Known Mac');
  mocks.getDeviceIdentity.mockReturnValue([
    { deviceId: device.deviceId, name: 'Latest Mac' },
  ]);
  await act(async () => state.refresh());
  expect(state.devices[0]?.name).toBe('Latest Mac');
});

it.each(['rename', 'delete'] as const)(
  'does not submit an old %s dialog after the auth owner changes',
  async (action) => {
    setMobileAuthOwner('account-a');
    await render();
    act(() =>
      action === 'rename' ? state.openRename(device) : state.openDelete(device),
    );
    setMobileAuthOwner('account-b');
    await act(async () => {
      if (action === 'rename') await state.confirmRename('Old account name');
      else expect(await state.confirmDelete()).toBe(false);
    });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.setDeviceIdentity).not.toHaveBeenCalled();
  },
);
