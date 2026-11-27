// @vitest-environment jsdom
/**
 * Production entry: the real link dialog writes a private task/message and opens it.
 * Contract: provider-sharing §4.1, engineering-conventions §8.2 (explicit, bounded writes).
 * Existing share-page tests do not exercise sending a generated link to oneself.
 * Minimal failures: one click; a rejected message write; expiry/account change during creation.
 * Unit tier: in-memory IPC boundaries, real component, no accounts/network/model execution.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { ProviderShareLinkDialog } from '../ProviderShareLinkDialog';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, opts?: { provider?: string }) => opts?.provider ? key + ':' + opts.provider : key,
}) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const link = 'https://example.invalid/provider-share/join#fixture-not-a-real-token';
let expiresAt: string;
const createSession = vi.fn();
const createMessage = vi.fn();
const command = vi.fn();
const remoteCommand = vi.fn();
const copy = vi.fn();
const close = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function Location() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}
function mount(deviceId?: string) {
  return render(<MemoryRouter initialEntries={['/settings']}>
    <ProviderShareLinkDialog providerId="fixture-provider" providerLabel="Fixture" deviceId={deviceId} onClose={close} />
    <Location />
  </MemoryRouter>);
}
const sendButton = () => screen.getByRole('button', { name: 'providerShare.link.sendToSelf' });
async function ready(deviceId?: string) {
  const view = mount(deviceId);
  await screen.findByRole('textbox', { name: 'providerShare.link.fieldLabel' });
  return view;
}
beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('fixture-owner', 1);
  expiresAt = new Date(Date.now() + 300_000).toISOString();
  command.mockReset().mockImplementation(async () => ({ link, expiresAt }));
  remoteCommand.mockReset().mockImplementation(async () => ({ link, expiresAt }));
  createSession.mockReset().mockResolvedValue({ id: 'private-task' });
  createMessage.mockReset().mockResolvedValue({ id: 'saved-message' });
  Object.assign(window, { electronAPI: {
    providerShare: { command }, providerGroup: { command: remoteCommand },
    copyTextToClipboard: copy,
    localDb: { sessions: { create: createSession }, messages: { create: createMessage } },
  } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('send a provider share link to myself', () => {
  it.each([undefined, 'other-own-computer'])('saves locally only after a click (provider device: %s)', async deviceId => {
    await ready(deviceId);
    expect(createSession).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/cc-agent/private-task'));
    expect(createSession).toHaveBeenCalledExactlyOnceWith({
      title: 'providerShare.link.taskTitle:Fixture', workspaceKind: 'dialogue',
    });
    expect(createMessage).toHaveBeenCalledExactlyOnceWith('private-task', {
      clientId: 'provider-share-link', role: 'user', content: link,
    });
    expect(close).toHaveBeenCalledTimes(1);
    // The host fake exposes no Agent/send/enqueue API: persistence alone must work.
    expect(remoteCommand).toHaveBeenCalledTimes(deviceId ? 1 : 0);
  });

  it('blocks duplicate clicks, closing and regeneration until the message is committed', async () => {
    const pending = deferred<unknown>();
    createMessage.mockReturnValue(pending.promise);
    await ready();
    fireEvent.click(sendButton());
    fireEvent.click(sendButton());
    await waitFor(() => expect(createMessage).toHaveBeenCalledTimes(1));
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'providerShare.link.regenerate' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe('/settings');
    await act(async () => pending.resolve({}));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps the link copyable after task creation fails and permits a deliberate retry', async () => {
    createSession.mockRejectedValueOnce(new Error('fixture failure'));
    await ready();
    fireEvent.click(sendButton());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('providerShare.link.sendFailed'));
    expect(createMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'providerShare.link.copy' }));
    expect(copy).toHaveBeenCalledWith({ text: link });
    fireEvent.click(sendButton());
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it('retries a failed message in the same task with the same message identity', async () => {
    createMessage.mockRejectedValueOnce(new Error('fixture failure'));
    await ready();
    fireEvent.click(sendButton());
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(sendButton());
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createMessage.mock.calls[0]).toEqual(createMessage.mock.calls[1]);
  });

  it('does not save an expired link', async () => {
    expiresAt = new Date(Date.now() - 1).toISOString();
    await ready();
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(sendButton());
    expect(createSession).not.toHaveBeenCalled();
  });

  it('checks the actual expiry again after task creation', async () => {
    const pending = deferred<{ id: string }>();
    createSession.mockReturnValue(pending.promise);
    await ready();
    fireEvent.click(sendButton());
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(expiresAt) + 1);
    await act(async () => pending.resolve({ id: 'private-task' }));
    expect(createMessage).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('providerShare.link.expired');
    expect(close).not.toHaveBeenCalled();
  });

  it.each(['account', 'unmount'])('does not write or navigate after %s changes during task creation', async change => {
    const pending = deferred<{ id: string }>();
    createSession.mockReturnValue(pending.promise);
    const view = await ready();
    fireEvent.click(sendButton());
    if (change === 'account') setDataOwnerGeneration('another-owner', 2);
    else view.unmount();
    await act(async () => pending.resolve({ id: 'private-task' }));
    expect(createMessage).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('refuses a previous account’s displayed link', async () => {
    await ready();
    setDataOwnerGeneration('another-owner', 2);
    fireEvent.click(sendButton());
    expect(createSession).not.toHaveBeenCalled();
  });
});
