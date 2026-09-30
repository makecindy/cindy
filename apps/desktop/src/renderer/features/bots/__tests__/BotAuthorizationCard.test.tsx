// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { __resetStickySessionOriginForTest } from '@/features/device-link/stickySessionOrigin';
import { BotAuthorizationCardView } from '../BotAuthorizationCard';
import type { PluginSetupPrompt } from '@/components/new-chat/PluginSetupPrompt';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/new-chat/PluginSetupPrompt', () => ({
  PluginSetupPrompt: ({ onCommand, commandInFlight }: ComponentProps<typeof PluginSetupPrompt>) => <>
    <button disabled={commandInFlight?.action === 'cancel'} onClick={() => onCommand('request', 'cancel')}>Cancel</button>
    <button disabled={!!commandInFlight} onClick={() => onCommand('request', 'run_action', 'connect')}>Connect</button>
    <button disabled={!!commandInFlight} onClick={() => onCommand('request', 'submit_form', 'key', { value: 'fake-secret' })}>Submit</button>
  </>,
}));
const local = vi.fn(async () => ({ accepted: true }));
const submit = vi.fn(async () => ({ accepted: true }));
const invoke = vi.fn(async () => ({ accepted: true }));
const assist = vi.fn(async () => ({ accepted: true }));
const card = { v: 1, sessionId: 'session', createdAt: 1, target: { kind: 'plugin', id: 'p' },
  snapshot: { kind: 'plugin_setup', requestId: 'request', revision: 3, ghost: { id: 'p', name: 'Plugin' }, steps: [] } };
beforeEach(() => {
  remoteProjectsStore.clear();
  remoteProjectsStore.__resetPinnedOriginsForTest();
  __resetStickySessionOriginForTest();
  vi.clearAllMocks();
  window.electronAPI = { maker: { resolveInteraction: local, submitPluginSetupInline: submit, assistPluginOauth: assist },
    deviceLink: { invoke } } as unknown as typeof window.electronAPI;
});
afterEach(cleanup);

it('sends only card/target IDs to local Main and can cancel while its bridge is pending', async () => {
  remoteProjectsStore.pinSessionOrigin('owner-device', 'session');
  let finish!: (value: { accepted: boolean }) => void;
  assist.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<BotAuthorizationCardView sessionId="session" data={{ ...card, snapshot: {
    ...card.snapshot, remoteOauth: true, steps: [{
      id: 'account', groupId: 'account', groupMode: 'any_of', title: 'Connect', description: '', phase: 'pending',
      action: { id: 'connect', kind: 'oauth_connect' },
    }],
  } }} />);
  fireEvent.click(screen.getByText('Connect'));
  await waitFor(() => expect(assist).toHaveBeenCalledWith({
    deviceId: 'owner-device', ghostId: 'p', requestId: 'request', actionId: 'connect', expectedRevision: 3,
  }));
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Cancel'));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('owner-device', 'maker:resolve-interaction', [
    'request', { kind: 'plugin_setup', action: 'cancel', expectedRevision: 3 },
  ]));
  finish({ accepted: false });
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(submit).not.toHaveBeenCalled();
});

it.each([false, true])('routes remote cancellation to its owner, including reconnect=%s', async (reconnect) => {
  remoteProjectsStore.pinSessionOrigin('owner-device', 'session');
  render(<BotAuthorizationCardView sessionId="session" data={card} />);
  if (reconnect) {
    remoteProjectsStore.clear();
    remoteProjectsStore.__resetPinnedOriginsForTest();
  }
  fireEvent.click(screen.getByText('Cancel'));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('owner-device', 'maker:resolve-interaction', [
    'request', { kind: 'plugin_setup', action: 'cancel', expectedRevision: 3 },
  ]));
  expect(local).not.toHaveBeenCalled();
});

it('rejects remote secret submissions at the callback boundary', () => {
  remoteProjectsStore.pinSessionOrigin('owner-device', 'session');
  render(<BotAuthorizationCardView sessionId="session" data={card} />);
  fireEvent.click(screen.getByText('Submit'));
  expect(submit).not.toHaveBeenCalled();
  expect(local).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toBe('newChat.pluginSetup.error.ACTION_FAILED');
});

it('keeps local cancellation and secret submission on the local maker', async () => {
  render(<BotAuthorizationCardView sessionId="session" data={card} />);
  fireEvent.click(screen.getByText('Cancel'));
  await waitFor(() => expect(local).toHaveBeenCalled());
  await waitFor(() => expect((screen.getByText('Submit') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByText('Submit'));
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ requestId: 'request', actionId: 'key', expectedRevision: 3, value: 'fake-secret' }));
  expect(invoke).not.toHaveBeenCalled();
});
