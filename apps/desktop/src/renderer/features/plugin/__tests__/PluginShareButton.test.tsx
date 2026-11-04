/** @vitest-environment jsdom */
// The existing share button must keep public anonymous sharing while opening
// local sharing behind explicit upload confirmation. Only auth and native IPC
// are replaced; the real dialog verifies cancellation, identity and owner changes.
// Regression: a delayed local preflight used to open the share page before the
// upload decision. Existing immediate IPC replies missed this visible ordering;
// unit tests hold that boundary pending and resolve it without real timers.
// Upload confirmation must show only the notice and confirmation action. The
// signed-in fixture previously exposed the result page's attribution control
// before consent; these unit assertions cover that missing visible state.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../../shared/ghost';

const auth = vi.hoisted(() => ({ isAuthenticated: true, dataOwnerId: 'owner', dataOwnerGeneration: 1 }));
const ipc = vi.hoisted(() => ({ prepareShare: vi.fn(), prepareLocalShare: vi.fn(), releaseLocalShare: vi.fn() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { PluginShareButton } from '../PluginShareButton';

const ghost: InstalledGhost = {
  manifest: { schemaVersion: 3, id: 'local-share-test', name: 'Local plugin', version: '1.0.0', entry: 'index.js', kind: 'chip' },
  namespace: null, namespaceState: 'confirmed', instanceKey: '_root__local-share-test',
  dir: '/fixture/local-share-test', enabled: true, publishingSource: { kind: 'local', source: 'manual' },
  approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
};
const material = { title: 'Plugin', url: 'https://share.example.test/s/test', imageSvg: '<svg />' };
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(auth, { isAuthenticated: true, dataOwnerId: 'owner', dataOwnerGeneration: 1 });
  ipc.prepareShare.mockResolvedValue(material);
  ipc.prepareLocalShare.mockImplementation(async (_instance, _operation, _options, _binding, confirmed) =>
    confirmed ? material : { confirmationRequired: true });
  ipc.releaseLocalShare.mockResolvedValue(undefined);
  vi.stubGlobal('electronAPI', { pluginMarket: ipc });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openShare() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'sharing.title' })); });
}

it('keeps public sharing anonymous and uses the existing share dialog', async () => {
  auth.isAuthenticated = false;
  render(<PluginShareButton pluginId="public-plugin" />);
  await openShare();
  expect(ipc.prepareShare).toHaveBeenCalledWith('public-plugin', { includeAttribution: false });
  expect(ipc.prepareLocalShare).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'sharing.copyLink' })).toBeTruthy();
});

it('requires upload confirmation and reuses the confirmed opening for attribution', async () => {
  let finishCheck!: (value: { confirmationRequired: true }) => void;
  ipc.prepareLocalShare.mockImplementationOnce(() => new Promise(resolve => { finishCheck = resolve; }));
  render(<PluginShareButton ghost={ghost} />);
  expect(ipc.prepareLocalShare).not.toHaveBeenCalled();
  await openShare();
  expect(ipc.prepareLocalShare.mock.calls[0]?.[4]).toBe(false);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.querySelector('button[aria-busy="true"]')).toBeTruthy();
  await act(async () => { finishCheck({ confirmationRequired: true }); });
  expect(screen.getByText('sharing.localUploadNotice')).toBeTruthy();
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.queryByText('sharing.includeAttribution')).toBeNull();
  expect(screen.queryByRole('button', { name: 'sharing.copyLink' })).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'sharing.uploadLocal' })); });
  expect(ipc.prepareLocalShare).toHaveBeenCalledTimes(2);
  const [instance, operationId, options, expected, confirmed] = ipc.prepareLocalShare.mock.calls[1];
  expect(confirmed).toBe(true);
  expect(instance).toBe('_root__local-share-test');
  expect(operationId).toEqual(expect.any(String));
  expect(options).toEqual({ includeAttribution: true });
  expect(expected).toEqual({ version: '1.0.0', approvalToken: 'approved:00000000-0000-4000-8000-000000000001' });
  expect(screen.getByRole('button', { name: 'sharing.copyLink' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'sharing.uploadLocal' })).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('switch')); });
  expect(ipc.prepareLocalShare).toHaveBeenLastCalledWith(instance, operationId, { includeAttribution: false }, expected, true);
  fireEvent.click(screen.getByRole('button', { name: 'sharing.close' }));
  expect(ipc.releaseLocalShare).toHaveBeenCalledWith(operationId);
  await openShare();
  expect(ipc.prepareLocalShare.mock.calls.at(-1)?.[4]).toBe(false);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'sharing.uploadLocal' })); });
  expect(ipc.prepareLocalShare.mock.calls.at(-1)?.[1]).not.toBe(operationId);
  expect(ipc.prepareShare).not.toHaveBeenCalled();
});

it('does not expose attribution or upload when the user closes before confirmation', async () => {
  render(<PluginShareButton ghost={ghost} />);
  await openShare();
  expect(screen.queryByRole('switch')).toBeNull();
  expect(ipc.prepareLocalShare.mock.calls.every(call => call[4] === false)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'sharing.close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(ipc.prepareLocalShare.mock.calls.every(call => call[4] === false)).toBe(true);
});

it('skips confirmation for an unchanged uploaded package and creates a new operation each time', async () => {
  ipc.prepareLocalShare.mockResolvedValue(material);
  let finishCheck!: (value: typeof material) => void;
  ipc.prepareLocalShare.mockImplementationOnce(() => new Promise(resolve => { finishCheck = resolve; }));
  render(<PluginShareButton ghost={ghost} />);
  await openShare();
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => { finishCheck(material); });
  expect(screen.queryByText('sharing.localUploadNotice')).toBeNull();
  expect(screen.getByRole('button', { name: 'sharing.copyLink' })).toBeTruthy();
  const operationId = ipc.prepareLocalShare.mock.calls[0][1];
  fireEvent.click(screen.getByRole('button', { name: 'sharing.close' }));
  await openShare();
  expect(screen.queryByRole('button', { name: 'sharing.uploadLocal' })).toBeNull();
  expect(ipc.prepareLocalShare.mock.calls.at(-1)?.[1]).not.toBe(operationId);
  expect(ipc.prepareLocalShare.mock.calls.every(call => call[4] === false)).toBe(true);
});

it('does not prepare a local package without login', () => {
  auth.isAuthenticated = false;
  const { container } = render(<PluginShareButton ghost={ghost} />);
  const button = container.querySelector('button')!;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(ipc.prepareLocalShare).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('closes the local share on owner change without preparing it for the new owner', async () => {
  const view = render(<PluginShareButton ghost={ghost} />);
  await openShare();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'sharing.uploadLocal' })); });
  const operationId = ipc.prepareLocalShare.mock.calls[0][1];
  Object.assign(auth, { dataOwnerId: 'another-owner', dataOwnerGeneration: 2 });
  view.rerender(<PluginShareButton ghost={ghost} />);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(ipc.prepareLocalShare).toHaveBeenCalledTimes(2);
  expect(ipc.releaseLocalShare).toHaveBeenCalledWith(operationId);
});

it('does not open a delayed local confirmation after the owner changes', async () => {
  let finishCheck!: (value: { confirmationRequired: true }) => void;
  ipc.prepareLocalShare.mockImplementationOnce(() => new Promise(resolve => { finishCheck = resolve; }));
  const view = render(<PluginShareButton ghost={ghost} />);
  await openShare();
  const operationId = ipc.prepareLocalShare.mock.calls[0][1];
  Object.assign(auth, { dataOwnerId: 'another-owner', dataOwnerGeneration: 2 });
  view.rerender(<PluginShareButton ghost={ghost} />);
  await act(async () => { finishCheck({ confirmationRequired: true }); });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.querySelector('button[aria-busy="true"]')).toBeNull();
  expect(ipc.prepareLocalShare).toHaveBeenCalledOnce();
  expect(ipc.releaseLocalShare).toHaveBeenCalledWith(operationId);
});
