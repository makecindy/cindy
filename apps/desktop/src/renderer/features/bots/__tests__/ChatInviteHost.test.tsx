// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatInviteHost, requestChatInvite } from '../ChatInviteHost';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const api = vi.hoisted(() => ({ previewInvite: vi.fn(), acceptInvite: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../botGroupStore', () => ({ refreshBotGroups: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn() } }));
const token = 'synthetic-invitation-'.padEnd(43, 'a');
const link = `cindy://chat-invite/${token}`;
const k = (name: string) => `bots.groupChat.server.${name}`;
function Location() { return <p data-testid="location">{useLocation().pathname}</p>; }
function mount() {
  return render(<StrictMode><MemoryRouter><ChatInviteHost /><Location /></MemoryRouter></StrictMode>);
}
async function preview() { await act(async () => { fireEvent.click(screen.getByRole('button', { name: k('previewInvite') })); }); }
beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('owner-a');
  api.previewInvite.mockResolvedValue({ ok: true, groupId: 'room', name: 'Invited group', inviterName: 'Host', joined: false });
  api.acceptInvite.mockResolvedValue({ ok: true, groupId: 'room' });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { chatServer: api } } });
});
afterEach(async () => {
  // Dismiss via the same user action as production, including queued invitations.
  cleanup();
  await act(async () => { mount(); });
  while (screen.queryByRole('dialog')) fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
  cleanup();
});

it('keeps an invitation until the authenticated host mounts and requires preview plus explicit acceptance', async () => {
  requestChatInvite(token);
  mount();
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(link);
  expect(api.previewInvite).not.toHaveBeenCalled();
  expect(api.acceptInvite).not.toHaveBeenCalled();
  await preview(); await screen.findByText('Invited group');
  expect(api.previewInvite).toHaveBeenCalledWith({ link });
  act(() => requestChatInvite(token));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(api.previewInvite).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: k('accept') }));
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/bots/groups/room'));
  expect(api.acceptInvite).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it.each([
  ['INVITATION_NOT_FOUND', 'invalidInvite'],
  ['INVITATION_UNAVAILABLE', 'invalidInvite'],
  ['FORBIDDEN', 'notAllowed'],
  ['AUTH_REQUIRED', 'loginRequired'],
  ['HOST_NOT_READY', 'requestFailed'],
])('retains the target after %s and allows retry once the service is ready', async (errorCode, message) => {
  api.previewInvite.mockResolvedValueOnce({ ok: false, errorCode });
  requestChatInvite(token); mount(); await preview();
  expect((await screen.findByRole('alert')).textContent).toBe(k(message));
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(link);
  expect(api.acceptInvite).not.toHaveBeenCalled();
  await preview(); await screen.findByText('Invited group');
});

it('opens an already joined group without accepting again', async () => {
  api.previewInvite.mockResolvedValue({ ok: true, groupId: 'room', name: 'Invited group', inviterName: 'Host', joined: true });
  requestChatInvite(token); mount(); await preview(); await screen.findByText('Invited group');
  fireEvent.click(screen.getByRole('button', { name: k('openGroup') }));
  expect(screen.getByTestId('location').textContent).toBe('/bots/groups/room');
  expect(api.acceptInvite).not.toHaveBeenCalled();
});

it('discards an old account preview while preserving its target through account selection', async () => {
  let finish!: (result: unknown) => void;
  api.previewInvite.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  requestChatInvite(token); const view = mount(); await preview();
  view.unmount(); setDataOwnerGeneration('owner-b'); mount();
  await act(async () => finish({ ok: true, groupId: 'old-room', name: 'Private old result', joined: false }));
  expect(screen.queryByText('Private old result')).toBeNull();
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(link);
  expect(screen.queryByRole('button', { name: k('accept') })).toBeNull();
  await preview(); await screen.findByText('Invited group');
  expect(api.acceptInvite).not.toHaveBeenCalled();
});

it('queues a second invite without replacing the current confirmation and reuses the id on retry', async () => {
  api.acceptInvite.mockResolvedValueOnce({ ok: false, errorCode: 'REQUEST_TIMEOUT' });
  requestChatInvite(token); mount(); await preview(); await screen.findByText('Invited group');
  act(() => requestChatInvite('b'.repeat(43)));
  fireEvent.click(screen.getByRole('button', { name: k('accept') }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: k('accept') }));
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(`cindy://chat-invite/${'b'.repeat(43)}`));
  expect(api.acceptInvite.mock.calls[0][0].clientId).toBe(api.acceptInvite.mock.calls[1][0].clientId);
});

it.each(['INVITATION_NOT_FOUND', 'FORBIDDEN'])('keeps the dialog when acceptance is rejected after preview: %s', async errorCode => {
  api.acceptInvite.mockResolvedValue({ ok: false, errorCode });
  requestChatInvite(token); mount(); await preview();
  fireEvent.click(screen.getByRole('button', { name: k('accept') }));
  await screen.findByRole('alert');
  expect(screen.getByTestId('location').textContent).toBe('/');
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(link);
});

it('ignores an old account acceptance result after logout and preserves a fresh confirmation for the new account', async () => {
  let finish!: (result: unknown) => void;
  api.acceptInvite.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  requestChatInvite(token); const view = mount(); await preview();
  const accept = screen.getByRole('button', { name: k('accept') });
  fireEvent.click(accept); fireEvent.click(accept);
  expect(api.acceptInvite).toHaveBeenCalledTimes(1);
  view.unmount(); setDataOwnerGeneration('owner-b'); mount();
  await act(async () => finish({ ok: true, groupId: 'old-room' }));
  expect(screen.getByTestId('location').textContent).toBe('/');
  expect(screen.queryByRole('button', { name: k('accept') })).toBeNull();
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(link);
});
