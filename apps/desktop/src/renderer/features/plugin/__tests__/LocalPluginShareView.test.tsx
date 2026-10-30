/** @vitest-environment jsdom */
// Test value: recipient navigation must require login, wait for an install click,
// preserve cancellation and discard stale account reads. Public detail tests use
// market releases, not this fixed manual package. Unit tier: real view, fake IPC.
// Minimal inputs: one snapshot, a rejected consent and a delayed old-owner read.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseRemoteActionInvokeRequest } from '@cindy/device-link';
import { parseLocalPluginShareSnapshot } from '@cindy/plugin-protocol';
import { createIpcError } from '../../../../shared/ipc-errors';
import { LocalPluginShareView } from '../LocalPluginShareView';
import type { CatalogDeviceControl } from '../PluginDevicePicker';

const io = vi.hoisted(() => ({ read: vi.fn(), install: vi.fn(), invoke: vi.fn(), confirm: vi.fn(), auth: {
  isAuthenticated: true, mode: 'cloud', dataOwnerId: 'owner', dataOwnerGeneration: 1,
} }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => io.auth }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: io.confirm }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const snapshotId = 's'.repeat(32);
const snapshot = { schemaVersion: 1, snapshotId, ghostId: 'shared-plugin', name: 'Shared Plugin', description: null, author: null,
  version: '1.0.0', sha256: 'a'.repeat(64), sizeBytes: 1024, createdAt: '2026-10-28T00:00:00.000Z', icon: null };
const ghost = { manifest: { id: 'shared-plugin' } };
beforeEach(() => {
  io.auth.isAuthenticated = true; io.auth.dataOwnerGeneration = 1;
  io.read.mockReset().mockResolvedValue(snapshot); io.install.mockReset().mockResolvedValue({ ghost });
  io.invoke.mockReset(); io.confirm.mockReset().mockResolvedValue(true);
  vi.stubGlobal('electronAPI', { platform: 'win32', getFullscreenState: async () => false, onFullscreenChange: () => () => {},
    deviceLink: { invoke: io.invoke },
    pluginMarket: { localShareDetail: io.read, installLocalShare: io.install } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const view = (onInstalled = vi.fn(), deviceControl?: CatalogDeviceControl) => <MemoryRouter><LocalPluginShareView snapshotId={snapshotId} deviceControl={deviceControl} onBack={vi.fn()} onInstalled={onInstalled} /></MemoryRouter>;

it('does not read a local share before login', () => {
  io.auth.isAuthenticated = false;
  render(view());
  expect(screen.getByRole('button', { name: 'sharing.localSignIn' })).toBeTruthy();
  expect(io.read).not.toHaveBeenCalled(); expect(io.install).not.toHaveBeenCalled();
});
it('only installs the visible fixed version after an explicit click', async () => {
  const installed = vi.fn(); render(view(installed));
  expect(await screen.findByText('v1.0.0')).toBeTruthy();
  expect(io.install).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'sharing.localInstallButton' }));
  await waitFor(() => expect(installed).toHaveBeenCalledWith(ghost));
  expect(io.install).toHaveBeenCalledWith(snapshotId, snapshot);
});
it('keeps a declined permission confirmation as cancellation without reporting installation', async () => {
  const installed = vi.fn(); io.install.mockRejectedValue(createIpcError('MUTATION_CANCELLED', 'Declined'));
  render(view(installed)); await screen.findByText('v1.0.0');
  fireEvent.click(screen.getByRole('button', { name: 'sharing.localInstallButton' }));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'sharing.localInstallButton' }).disabled).toBe(false));
  expect(installed).not.toHaveBeenCalled(); expect(screen.queryByRole('alert')).toBeNull();
});
it('does not show an old account response after a new account read finishes', async () => {
  let finish!: (value: typeof snapshot) => void;
  io.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const mounted = render(view());
  io.auth.dataOwnerGeneration++;
  io.read.mockResolvedValue({ ...snapshot, name: 'Current Owner Package' });
  mounted.rerender(view());
  await screen.findByText('Current Owner Package');
  await act(async () => { finish(snapshot); });
  expect(screen.queryByText('Shared Plugin')).toBeNull();
  expect(screen.getByText('Current Owner Package')).toBeTruthy();
});

const target = { deviceId: 'target-computer', name: 'Office Computer' };
const control = (online = true): CatalogDeviceControl => ({ selected: target, onSelect: vi.fn(),
  directory: { candidates: [], target: undefined, relayOnline: online, online } });

// A signed-in recipient with only this computer must install without a redundant
// device choice. Existing tests use no control or a selected remote target;
// neither covers the real catalog control with selected=null (unit, fake IPC).
it.each([false, true])('installs on this computer without requiring a device choice (alternative=%s)', async alternative => {
  const selection: CatalogDeviceControl = { selected: null, onSelect: vi.fn(), directory: {
    candidates: alternative ? [{ ...target, platform: 'darwin', appVersion: '0.0.0', lastSeenAt: null,
      online: true, busy: false, remoteControlEnabled: true, controlEnabled: true, isSelf: false }] : [],
    target: undefined, relayOnline: true, online: true,
  } };
  const installed = vi.fn(); render(view(installed, selection));
  await screen.findByText('v1.0.0');
  expect(!!screen.queryByRole('button', { name: 'settings.ghosts.remote.device' })).toBe(alternative);
  fireEvent.click(screen.getByRole('button', { name: 'sharing.localInstallButton' }));
  await waitFor(() => expect(installed).toHaveBeenCalledWith(ghost));
  expect(io.install).toHaveBeenCalledWith(snapshotId, snapshot);
  expect(selection.onSelect).not.toHaveBeenCalled();
  expect(io.invoke).not.toHaveBeenCalled();
});

function remoteHost(supported = true, replacing = false) {
  let outcome: 'succeeded' | 'cancelled' = 'succeeded';
  io.invoke.mockImplementation(async (_device, channel, [request]) => {
    if (String(channel).includes('manifest')) return { collections: [{ id: 'plugins', actions: [{ id: 'management:snapshot' }] }] };
    if (request.actionId === 'management:snapshot') return { effects: [], result: { version: 1, ghosts: [],
      market: { items: [], customSourceNames: [], unavailableCustomSourceNames: [] }, ...(supported ? { localShares: true } : {}) } };
    const operationId = request.input.operationId;
    if (request.actionId === 'management:begin') return { effects: [], result: { operationId, phase: 'confirmation', consent: {
      requestId: 'consent-request', initiator: 'user', origin: 'local-file',
      ...(replacing ? { purpose: 'share-replace', target: { namespace: null, sourceChanged: false, otherCopies: 0 } } : {}),
      facts: replacing ? { kind: 'update', name: snapshot.name, version: snapshot.version, previousVersion: snapshot.version,
        added: [], removed: [], unchangedCount: 1, builtinOauthClientChanged: false }
        : { kind: 'install', name: snapshot.name, version: snapshot.version, permissions: [] },
    } } };
    if (request.actionId === 'management:answer') outcome = request.input.confirmed ? 'succeeded' : 'cancelled';
    return { effects: [], result: { operationId, phase: outcome } };
  });
}
it('installs on the chosen device with its consent receipt and never invokes local installation', async () => {
  remoteHost(); const installed = vi.fn(); render(view(installed, control()));
  const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'sharing.localInstallButton' });
  await waitFor(() => expect(button.disabled).toBe(false));
  vi.useFakeTimers();
  try {
    await act(async () => { fireEvent.click(button); });
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(installed).toHaveBeenCalledWith();
  } finally { vi.useRealTimers(); }
  expect(io.install).not.toHaveBeenCalled();
  expect(io.invoke.mock.calls.every(([id]) => id === target.deviceId)).toBe(true);
  expect(io.invoke.mock.calls.find(([, , [r]]) => r.actionId === 'management:begin')?.[2][0].input)
    .toMatchObject({ kind: 'install-share', expectedSnapshot: snapshot });
  expect(io.confirm).toHaveBeenCalledOnce();
});

// A remote replacement with unchanged permissions must show state inheritance
// and send the explicit choice to the selected Host, including cancellation.
it.each([false, true])('confirms replacement on the selected computer (allow=%s)', async allow => {
  remoteHost(true, true); io.confirm.mockResolvedValue(allow);
  const installed = vi.fn(); render(view(installed, control()));
  const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'sharing.localInstallButton' });
  await waitFor(() => expect(button.disabled).toBe(false));
  vi.useFakeTimers();
  try {
    await act(async () => { fireEvent.click(button); });
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
  } finally { vi.useRealTimers(); }
  expect(button.disabled).toBe(false);
  const options = io.confirm.mock.calls[0][0];
  expect(options.confirmText).toBe('sharing.localReplaceButton');
  render(<>{options.content}</>);
  expect(screen.getByText('sharing.localReplaceNotice')).toBeTruthy();
  expect(screen.getByText('sharing.localReplaceRetainsState')).toBeTruthy();
  const answer = io.invoke.mock.calls.find(([, , [r]]) => r.actionId === 'management:answer');
  expect(answer?.[0]).toBe(target.deviceId);
  expect(answer?.[2][0].input).toMatchObject({ requestId: 'consent-request', confirmed: allow });
  expect(installed).toHaveBeenCalledTimes(allow ? 1 : 0);
  expect(io.install).not.toHaveBeenCalled();
});

// The fixed snapshot may carry a valid 512 KiB icon, while device-link actions
// allow only 64 KiB. Exercise the real request parser at the fake IPC boundary;
// the earlier remote test only used icon=null and could not expose the failure.
it('installs a share with a large icon within the existing remote request limit', async () => {
  const shown = parseLocalPluginShareSnapshot({ ...snapshot,
    name: '本地插件'.repeat(64), description: '说明'.repeat(5000), author: '作'.repeat(256),
    icon: 'data:image/png;base64,' + 'A'.repeat(Math.ceil(512 * 1024 / 3) * 4),
  });
  io.read.mockResolvedValue(shown);
  remoteHost();
  const host = io.invoke.getMockImplementation()!;
  io.invoke.mockImplementation(async (...args) => {
    const request = args[2][0];
    if (request.actionId === 'management:begin' && !parseRemoteActionInvokeRequest(request))
      throw createIpcError('INVALID_PARAMS', 'Action input exceeds the existing limit');
    return host(...args);
  });
  const installed = vi.fn(); render(view(installed, control()));
  const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'sharing.localInstallButton' });
  await waitFor(() => expect(button.disabled).toBe(false));
  vi.useFakeTimers();
  try {
    await act(async () => { fireEvent.click(button); });
    const begin = io.invoke.mock.calls.find(([, , [r]]) => r.actionId === 'management:begin')![2][0];
    expect(parseRemoteActionInvokeRequest({ ...begin, input: { ...begin.input, expectedSnapshot: shown } })).toBeNull();
    expect(parseRemoteActionInvokeRequest(begin)).not.toBeNull();
    expect(begin.input.expectedSnapshot).toEqual({ ...shown, icon: null });
    expect(shown.icon).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(installed).toHaveBeenCalledOnce();
    expect(io.install).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it.each([false, true])('keeps an offline or unsupported device selected without installing locally (%s)', async online => {
  remoteHost(false); render(view(vi.fn(), control(online)));
  await screen.findByText('v1.0.0');
  if (online) await screen.findByText('sharing.localTargetUnsupported');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'sharing.localInstallButton' }).disabled).toBe(true);
  expect(screen.getByText(target.name)).toBeTruthy();
  expect(io.install).not.toHaveBeenCalled();
});

// A known rejection happens before the target stores a receipt. The old test
// only covered a lost response after send; querying that nonexistent operation
// must not leave installation and device selection permanently busy (unit).
it.each(['INVALID_PARAMS', 'NOT_FOUND', 'PRECONDITION_FAILED', 'UNSUPPORTED_CAPABILITY', 'PERMISSION_DENIED'] as const)(
  'allows a new explicit install after the target rejects begin with %s', async code => {
    remoteHost();
    const host = io.invoke.getMockImplementation()!;
    let refused = false;
    io.invoke.mockImplementation(async (...args) => {
      if (args[2][0].actionId === 'management:begin' && !refused) {
        refused = true;
        throw createIpcError(code, 'Request rejected before creating an operation');
      }
      return host(...args);
    });
    const installed = vi.fn(); render(view(installed, control()));
    const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'sharing.localInstallButton' });
    await waitFor(() => expect(button.disabled).toBe(false));
    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(button); });
      expect(button.disabled).toBe(false);
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'settings.ghosts.remote.device' }).disabled).toBe(false);
      expect(screen.getByText('settings.ghosts.remote.actionFailed')).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(650); });
      expect(io.invoke.mock.calls.some(([, , [request]]) => request.actionId === 'management:operation')).toBe(false);
      await act(async () => { fireEvent.click(button); });
      await act(async () => { await vi.advanceTimersByTimeAsync(650); });
      expect(installed).toHaveBeenCalledOnce();
      const begins = io.invoke.mock.calls.filter(([, , [request]]) => request.actionId === 'management:begin');
      expect(begins).toHaveLength(2);
      expect(begins[1][2][0].input.operationId).not.toBe(begins[0][2][0].input.operationId);
      expect(io.install).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  },
);

it('reads the original receipt after an ambiguous begin without sending another install', async () => {
  remoteHost();
  const host = io.invoke.getMockImplementation()!;
  io.invoke.mockImplementation(async (...args) => {
    if (args[2][0].actionId === 'management:begin') throw new Error('Connection closed after send');
    return host(...args);
  });
  const installed = vi.fn(); render(view(installed, control()));
  const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'sharing.localInstallButton' });
  await waitFor(() => expect(button.disabled).toBe(false));
  vi.useFakeTimers();
  try {
    await act(async () => { fireEvent.click(button); });
    expect(screen.getByText('settings.ghosts.remote.unknown')).toBeTruthy();
    expect(installed).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(installed).toHaveBeenCalledOnce();
    const requests = io.invoke.mock.calls.map(([, , [r]]) => r);
    const begin = requests.filter(r => r.actionId === 'management:begin');
    expect(begin).toHaveLength(1);
    expect(requests.find(r => r.actionId === 'management:operation')?.input.operationId).toBe(begin[0].input.operationId);
    expect(io.install).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it('cancels only the original target when the receiver leaves and discards its late result', async () => {
  remoteHost();
  const host = io.invoke.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  let originalId = '';
  io.invoke.mockImplementation(async (...args) => {
    if (args[2][0].actionId === 'management:begin') {
      originalId = args[2][0].input.operationId;
      return new Promise(resolve => { finish = resolve; });
    }
    return host(...args);
  });
  const installed = vi.fn(); const mounted = render(view(installed, control()));
  const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'sharing.localInstallButton' });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(originalId).not.toBe(''));
  mounted.unmount();
  expect(io.invoke.mock.calls.find(([, , [r]]) => r.actionId === 'management:cancel')).toMatchObject([
    target.deviceId, expect.any(String), [{ input: { operationId: originalId } }],
  ]);
  await act(async () => { finish({ effects: [], result: { operationId: originalId, phase: 'succeeded' } }); });
  expect(installed).not.toHaveBeenCalled();
  expect(io.install).not.toHaveBeenCalled();
});
