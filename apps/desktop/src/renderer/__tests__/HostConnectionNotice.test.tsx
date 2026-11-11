// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HostConnectionState } from '@cindy/maker-shared/host-event-stream';
import { HostConnectionNotice } from '@/components/HostConnectionNotice';
import { makerChatStore } from '@/lib/makerChatStore';
import { sessionsStore } from '@/lib/sessionsStore';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({
  dataOwnerId: 'test-owner', dataOwnerGeneration: 1, canEnterApp: true,
}) }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { reconcileHostConnection: vi.fn(async () => {}) } }));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { forceRefreshAll: vi.fn(async () => {}) } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// Unit: mount the production subscription component, not just its banner.
// Existing transport/store tests do not catch a missing renderer subscription.
// No timers, network, accounts or model calls; scenario UI covers actual text.
let notify: (state: HostConnectionState) => void;
beforeEach(() => {
  vi.clearAllMocks();
  notify = () => {};
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    hostConnection: { client: 'browser', onStateChanged: (cb: typeof notify) => { notify = cb; return vi.fn(); }, retry: vi.fn() },
  } });
});
afterEach(cleanup);

it('ordinary desktop receives no Host signal, shows no notice and starts no recovery', () => {
  render(<HostConnectionNotice />);
  expect(screen.queryByRole('status')).toBeNull();
  expect(sessionsStore.forceRefreshAll).not.toHaveBeenCalled();
  expect(makerChatStore.reconcileHostConnection).not.toHaveBeenCalled();
});

it('routes reset signals to task stores but avoids rereading after complete replay', async () => {
  render(<HostConnectionNotice />);
  await act(async () => notify({ status: 'connected', connection: 1, recovery: 1, reason: 'initial' }));
  expect(sessionsStore.forceRefreshAll).toHaveBeenCalledOnce();
  expect(makerChatStore.reconcileHostConnection).toHaveBeenCalledOnce();
  await act(async () => notify({ status: 'disconnected', connection: 1, recovery: 1 }));
  await act(async () => notify({ status: 'connected', connection: 2, recovery: 1 }));
  expect(makerChatStore.reconcileHostConnection).toHaveBeenCalledOnce();
  await act(async () => notify({ status: 'connected', connection: 3, recovery: 2, reason: 'restarted' }));
  expect(makerChatStore.reconcileHostConnection).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('status')).toBeNull();
});

it('authorization loss leaves the editor mounted and offers a retry on the same page', async () => {
  render(<><textarea aria-label="draft" defaultValue="keep editing" /><HostConnectionNotice /></>);
  const draft = screen.getByRole('textbox') as HTMLTextAreaElement;
  await act(async () => notify({ status: 'authorization-required', connection: 1, recovery: 0 }));
  expect(screen.getByRole('status').textContent).toContain('hostConnection.pairingHelp');
  await act(async () => screen.getByRole('button', { name: 'hostConnection.retry' }).click());
  expect(window.electronAPI.hostConnection?.retry).toHaveBeenCalledOnce();
  expect(screen.getByRole('textbox')).toBe(draft);
  expect(draft.value).toBe('keep editing');
  expect(makerChatStore.reconcileHostConnection).not.toHaveBeenCalled();
});
