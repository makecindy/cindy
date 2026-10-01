// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { useLeaveSharedTask } from '@/device-link/useLeaveSharedTask';

const h = vi.hoisted(() => ({
  confirm: vi.fn(), api: { leave: vi.fn() }, link: { closeLink: vi.fn() },
  remove: vi.fn(), revoke: vi.fn(), revoked: vi.fn(), left: vi.fn(), error: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) };
});
vi.mock('@/session/useSharedTaskConfirmation', () => ({ useSharedTaskConfirmation: () => ({ confirm: h.confirm, dialog: null }) }));
vi.mock('@/device-link/useSharedTaskApi', () => ({ useSharedTaskApi: () => h.api }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: { removeDevice: h.remove } }));
vi.mock('@/device-link/accessRevoked', () => ({ markDeviceAccessRevoked: h.revoke }));
vi.mock('@/device-link/revokedDevicesStore', () => ({ revokedDevicesStore: { has: h.revoked } }));
let root: Root;
let host: HTMLDivElement;
let resolveConfirm: (value: boolean) => void;
const peer = sharedTaskHostPeer('shared', 'desktop');
function Harness({ enabled = true, deviceId = peer }) {
  const exit = useLeaveSharedTask({ deviceId, enabled, onLeft: h.left, onError: h.error });
  return <button disabled={exit.busy} onClick={() => void exit.leave()}>leave</button>;
}
const click = () => act(async () => host.querySelector('button')!.click());
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks(); setMobileAuthOwner('owner');
  h.confirm.mockImplementation(() => new Promise<boolean>((resolve) => { resolveConfirm = resolve; }));
  h.api.leave.mockResolvedValue(undefined);
  host = document.createElement('div'); root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); });
it('opens only one native confirmation and cancelling leaves the task untouched', async () => {
  await click(); await click();
  expect(h.confirm).toHaveBeenCalledTimes(1);
  expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true, cancelable: true }));
  await act(async () => resolveConfirm(false));
  expect(h.api.leave).not.toHaveBeenCalled(); expect(h.link.closeLink).not.toHaveBeenCalled();
  expect(h.remove).not.toHaveBeenCalled(); expect(h.left).not.toHaveBeenCalled();
  await click(); expect(h.confirm).toHaveBeenCalledTimes(2);
});
it('waits for successful leave before revoking only the shared peer and leaving the page', async () => {
  let complete!: () => void;
  h.api.leave.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
  await click(); await act(async () => resolveConfirm(true));
  expect(h.api.leave).toHaveBeenCalledWith('shared');
  expect(host.querySelector('button')!.disabled).toBe(true);
  expect(h.link.closeLink).not.toHaveBeenCalled(); expect(h.left).not.toHaveBeenCalled();
  await act(async () => complete());
  expect(h.revoke).toHaveBeenCalledWith(peer); expect(h.link.closeLink).toHaveBeenCalledWith(peer);
  expect(h.remove).toHaveBeenCalledWith(peer); expect(h.left).toHaveBeenCalledOnce();
});
it('retains task access on failure and allows retry', async () => {
  h.api.leave.mockRejectedValue(new Error('offline'));
  await click(); await act(async () => resolveConfirm(true));
  expect(h.error).toHaveBeenCalledWith('sharedTask.retry');
  expect(h.remove).not.toHaveBeenCalled(); expect(h.revoke).not.toHaveBeenCalled();
  expect(h.link.closeLink).not.toHaveBeenCalled(); expect(h.left).not.toHaveBeenCalled();
  await click(); expect(h.confirm).toHaveBeenCalledTimes(2);
});
it.each(['account', 'menu', 'device', 'revoked'])('ignores confirmation after %s changes', async (change) => {
  await click();
  if (change === 'account') setMobileAuthOwner('other');
  if (change === 'menu') await act(async () => root.render(<Harness enabled={false} />));
  if (change === 'device') await act(async () => root.render(<Harness deviceId={sharedTaskHostPeer('other', 'desktop')} />));
  if (change === 'revoked') h.revoked.mockReturnValue(true);
  await act(async () => resolveConfirm(true));
  expect(h.api.leave).not.toHaveBeenCalled(); expect(h.left).not.toHaveBeenCalled();
});
it('ignores a completed leave after switching accounts', async () => {
  let complete!: () => void;
  h.api.leave.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
  await click(); await act(async () => resolveConfirm(true));
  setMobileAuthOwner('other'); await act(async () => complete());
  expect(h.link.closeLink).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled();
  expect(h.left).not.toHaveBeenCalled();
});
