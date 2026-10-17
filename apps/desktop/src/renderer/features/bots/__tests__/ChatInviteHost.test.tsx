// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatInviteHost, reportMalformedChatInvite, requestChatInvite } from '../ChatInviteHost';
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
async function retry() { await act(async () => { fireEvent.click(screen.getByRole('button', { name: k('retryInvite') })); }); }
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

it('keeps an invitation until the authenticated host mounts, previews it without a paste field and requires explicit acceptance', async () => {
  requestChatInvite(token);
  mount();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe(k('loadingInvite'));
  expect(screen.getByRole('button', { name: 'bots.close' }).hasAttribute('disabled')).toBe(false);
  await screen.findByText('Invited group');
  expect(api.previewInvite).toHaveBeenCalledExactlyOnceWith({ link });
  expect(api.acceptInvite).not.toHaveBeenCalled();
  act(() => requestChatInvite(token));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(api.previewInvite).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: k('accept') }));
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/bots/groups/room'));
  expect(api.acceptInvite).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it.each([
  ['FORBIDDEN', 'notAllowed'],
  ['AUTH_REQUIRED', 'loginRequired'],
  ['HOST_NOT_READY', 'requestFailed'],
])('retains the target after %s and reloads it on request', async (errorCode, message) => {
  api.previewInvite.mockResolvedValueOnce({ ok: false, errorCode });
  requestChatInvite(token); mount();
  expect((await screen.findByRole('alert')).textContent).toBe(k(message));
  expect(screen.queryByRole('button', { name: k('accept') })).toBeNull();
  await retry(); await screen.findByText('Invited group');
  expect(api.previewInvite).toHaveBeenLastCalledWith({ link });
  expect(api.acceptInvite).not.toHaveBeenCalled();
});

it.each(['INVITATION_NOT_FOUND', 'INVITATION_UNAVAILABLE', 'INVALID_INPUT'])('explains an unusable invitation (%s) without offering to accept or reload it', async errorCode => {
  api.previewInvite.mockResolvedValueOnce({ ok: false, errorCode });
  requestChatInvite(token); mount();
  expect((await screen.findByRole('alert')).textContent).toBe(k('invalidInvite'));
  expect(screen.queryByRole('button', { name: k('accept') })).toBeNull();
  expect(screen.queryByRole('button', { name: k('retryInvite') })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.acceptInvite).not.toHaveBeenCalled();
});

it('opens an already joined group directly without accepting again', async () => {
  api.previewInvite.mockResolvedValue({ ok: true, groupId: 'room', name: 'Invited group', inviterName: 'Host', joined: true });
  requestChatInvite(token); mount();
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/bots/groups/room'));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.acceptInvite).not.toHaveBeenCalled();
});

it('reports a malformed clicked link once, without contacting the service', async () => {
  reportMalformedChatInvite(); reportMalformedChatInvite();
  mount();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('alert').textContent).toBe(k('malformedInvite'));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: k('retryInvite') })).toBeNull();
  expect(api.previewInvite).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('lets the user dismiss an invitation while it is still loading', async () => {
  api.previewInvite.mockReturnValueOnce(new Promise(() => undefined));
  requestChatInvite(token); mount();
  await waitFor(() => expect(api.previewInvite).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('reads the invitation again when the same account moved to a newer data generation mid-request', async () => {
  let finish!: (result: unknown) => void;
  api.previewInvite.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  requestChatInvite(token); mount();
  await waitFor(() => expect(api.previewInvite).toHaveBeenCalledTimes(1));
  setDataOwnerGeneration('owner-a');
  await act(async () => finish({ ok: true, groupId: 'stale-room', name: 'Stale result', inviterName: 'Old', joined: false }));
  expect(screen.queryByText('Stale result')).toBeNull();
  await screen.findByText('Invited group');
  expect(api.previewInvite).toHaveBeenCalledTimes(2);
  expect(api.previewInvite).toHaveBeenLastCalledWith({ link });
  expect(api.acceptInvite).not.toHaveBeenCalled();
});

it('discards an old account preview while preserving its target through account selection', async () => {
  let finish!: (result: unknown) => void;
  api.previewInvite.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  requestChatInvite(token); const view = mount();
  await waitFor(() => expect(api.previewInvite).toHaveBeenCalledTimes(1));
  view.unmount(); setDataOwnerGeneration('owner-b');
  api.previewInvite.mockReturnValueOnce(new Promise(() => undefined));
  mount();
  await act(async () => finish({ ok: true, groupId: 'old-room', name: 'Private old result', inviterName: 'Old', joined: false }));
  expect(screen.queryByText('Private old result')).toBeNull();
  expect(screen.queryByRole('button', { name: k('accept') })).toBeNull();
  // The new account previews the same target afresh.
  expect(api.previewInvite).toHaveBeenCalledTimes(2);
  expect(api.previewInvite).toHaveBeenLastCalledWith({ link });
  expect(api.acceptInvite).not.toHaveBeenCalled();
});

it('queues a second invite without replacing the current confirmation and reuses the id on retry', async () => {
  api.acceptInvite.mockResolvedValueOnce({ ok: false, errorCode: 'REQUEST_TIMEOUT' });
  requestChatInvite(token); mount(); await screen.findByText('Invited group');
  act(() => requestChatInvite('b'.repeat(43)));
  expect(api.previewInvite).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: k('accept') }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: k('accept') }));
  await waitFor(() => expect(api.previewInvite).toHaveBeenLastCalledWith({ link: `cindy://chat-invite/${'b'.repeat(43)}` }));
  expect(api.acceptInvite.mock.calls[0][0].clientId).toBe(api.acceptInvite.mock.calls[1][0].clientId);
});

it('keeps the dialog without an accept button when the invitation became unusable after preview', async () => {
  api.acceptInvite.mockResolvedValue({ ok: false, errorCode: 'INVITATION_NOT_FOUND' });
  requestChatInvite(token); mount(); await screen.findByText('Invited group');
  fireEvent.click(screen.getByRole('button', { name: k('accept') }));
  expect((await screen.findByRole('alert')).textContent).toBe(k('invalidInvite'));
  expect(screen.getByTestId('location').textContent).toBe('/');
  expect(screen.queryByRole('button', { name: k('accept') })).toBeNull();
  expect(screen.queryByRole('button', { name: k('retryInvite') })).toBeNull();
});

it('keeps the confirmation when acceptance is refused for this account', async () => {
  api.acceptInvite.mockResolvedValue({ ok: false, errorCode: 'FORBIDDEN' });
  requestChatInvite(token); mount(); await screen.findByText('Invited group');
  fireEvent.click(screen.getByRole('button', { name: k('accept') }));
  expect((await screen.findByRole('alert')).textContent).toBe(k('notAllowed'));
  expect(screen.getByTestId('location').textContent).toBe('/');
  expect(screen.getByText('Invited group')).toBeTruthy();
  expect(screen.getByRole('button', { name: k('accept') })).toBeTruthy();
});

it('ignores an old account acceptance result after logout and preserves a fresh confirmation for the new account', async () => {
  let finish!: (result: unknown) => void;
  api.acceptInvite.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  requestChatInvite(token); const view = mount(); await screen.findByText('Invited group');
  const accept = screen.getByRole('button', { name: k('accept') });
  fireEvent.click(accept); fireEvent.click(accept);
  expect(api.acceptInvite).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'bots.close' }).hasAttribute('disabled')).toBe(true);
  view.unmount(); setDataOwnerGeneration('owner-b'); mount();
  await act(async () => finish({ ok: true, groupId: 'old-room' }));
  expect(screen.getByTestId('location').textContent).toBe('/');
  await screen.findByText('Invited group');
  expect(api.acceptInvite).toHaveBeenCalledTimes(1);
});
