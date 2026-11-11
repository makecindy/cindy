// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { ChatInviteDialog } from '../ChatInviteDialog';
const mocks = vi.hoisted(() => ({ createInvite: vi.fn(), previewInvite: vi.fn(), acceptInvite: vi.fn(), status: vi.fn(), revokeInvite: vi.fn(), copy: vi.fn(), success: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { date?: string }) => values?.date ? `${key}: ${values.date}` : key, i18n: { language: 'en' } }) }));
vi.mock('../botGroupStore', () => ({ refreshBotGroups: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { success: mocks.success } }));
const k = (name: string) => `bots.groupChat.server.${name}`;
const link = `cindy://chat-invite/${'a'.repeat(43)}`;
beforeEach(() => {
  mocks.status.mockResolvedValue({ personalMask: false });
  vi.clearAllMocks(); setDataOwnerGeneration('account', 1);
  mocks.createInvite.mockResolvedValue({ ok: true, link, expiresAt: null, reusable: true });
  mocks.previewInvite.mockResolvedValue({ ok: true, groupId: 'room', name: 'Room', inviterName: 'Host', expiresAt: null, reusable: true, joined: false });
  mocks.copy.mockResolvedValue(undefined);
  mocks.revokeInvite.mockResolvedValue({ ok: true, revoked: true });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.copy } });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { chatServer: mocks } } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function create() {
  await act(async () => { render(<ChatInviteDialog groupId="room" onClose={vi.fn()} />); });
}
describe('invitation validity', () => {
  it('automatically generates a link after creation with just close and copy actions', async () => {
    render(<ChatInviteDialog groupId="new-room" created onClose={vi.fn()} />);
    expect(screen.getByRole('heading').textContent).toBe(k('groupCreated'));
    const copy = await screen.findByRole('button', { name: k('copyLink') });
    expect(mocks.createInvite).toHaveBeenCalledExactlyOnceWith({ groupId: 'new-room', clientId: expect.any(String) });
    expect(screen.queryByRole('button', { name: k('revokeLink') })).toBeNull();
    expect(screen.getByText(k('inviteFriends'))).toBeTruthy();
    expect(screen.queryByText(k('reusableLink'))).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(2);
    await act(async () => fireEvent.click(copy));
    expect(mocks.copy).toHaveBeenCalledWith(link);
    expect(screen.getByRole('button', { name: k('copied') })).toBeTruthy();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it.each([false, true])('retries only the invitation with the same operation after automatic generation fails (created=%s)', async created => {
    mocks.createInvite.mockResolvedValueOnce({ ok: false, errorCode: 'REQUEST_TIMEOUT' });
    render(<ChatInviteDialog groupId="new-room" created={created} onClose={vi.fn()} />);
    await screen.findByRole('alert');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: k('createLink') })));
    await screen.findByRole('button', { name: k('copyLink') });
    expect(mocks.createInvite).toHaveBeenCalledTimes(2);
    expect(mocks.createInvite.mock.calls[0][0]).toEqual(mocks.createInvite.mock.calls[1][0]);
  });

  // Automatic generation must remain dismissible; earlier unit cases only settled requests before closing.
  it('allows closing during automatic generation and ignores its late result', async () => {
    let finish!: (value: unknown) => void;
    mocks.createInvite.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const onClose = vi.fn();
    const view = render(<ChatInviteDialog groupId="room" onClose={onClose} />);
    expect(mocks.createInvite).toHaveBeenCalledOnce();
    const close = screen.getByRole('button', { name: 'bots.close' }) as HTMLButtonElement;
    expect(close.disabled).toBe(false);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => finish({ ok: true, link, expiresAt: null, reusable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.createInvite).toHaveBeenCalledOnce();
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('copies the same reusable link repeatedly without generating more or showing extra validity text', async () => {
    await create();
    expect(screen.queryByText(k('reusableLink'))).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: k('copyLink') })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: k('copied') })));
    expect(mocks.copy.mock.calls).toEqual([[link], [link]]);
    expect(mocks.createInvite).toHaveBeenCalledOnce();
  });
  it('shows an old server expiry as single use and never calls it permanent', async () => {
    mocks.createInvite.mockResolvedValue({ ok: true, link, expiresAt: '2099-10-09T12:00:00Z' });
    await create();
    expect(screen.getByRole('status').textContent).toContain(k('singleUseUntil'));
    expect(screen.queryByText(k('reusableLink'))).toBeNull();
  });
  it('stops copying when the open dialog reaches its expiry and generates with a fresh id', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
    mocks.createInvite.mockResolvedValueOnce({ ok: true, link, expiresAt: '2026-10-09T12:00:01Z' });
    await create();
    await act(async () => { vi.advanceTimersByTime(1001); });
    expect(screen.getByRole('status').textContent).toBe(k('expiredLink'));
    expect(screen.queryByRole('button', { name: k('copyLink') })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: k('createLink') })));
    expect(mocks.createInvite.mock.calls[0][0].clientId).not.toBe(mocks.createInvite.mock.calls[1][0].clientId);
  });
  it('disables acceptance for expired previews', async () => {
    mocks.previewInvite.mockResolvedValue({ ok: true, groupId: 'room', name: 'Room', inviterName: 'Host', expiresAt: '2000-01-01T00:00:00Z', joined: false });
    render(<ChatInviteDialog initialLink={link} onClose={vi.fn()} />);
    await screen.findByText('Room');
    expect(screen.getByRole('status').textContent).toBe(k('expiredLink'));
    expect((screen.getByRole('button', { name: k('accept') }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.acceptInvite).not.toHaveBeenCalled();
  });
  it('requires confirmation and cancelling preserves the copyable link', async () => {
    await create();
    fireEvent.click(screen.getByRole('button', { name: k('revokeLink') }));
    expect(mocks.revokeInvite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'commonUi.confirmDialog.cancel' }));
    expect(mocks.revokeInvite).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: k('copyLink') })).toBeTruthy();
  });
  it('revokes only this link, disables it, and generates a new link with a fresh id', async () => {
    await create();
    const newLink = `cindy://chat-invite/${'b'.repeat(43)}`;
    mocks.createInvite.mockResolvedValue({ ok: true, link: newLink, expiresAt: null, reusable: true });
    fireEvent.click(screen.getByRole('button', { name: k('revokeLink') }));
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: k('revokeLink') }).at(-1)!));
    expect(mocks.revokeInvite).toHaveBeenCalledWith({ groupId: 'room', link, clientId: expect.any(String) });
    expect(screen.getByRole('status').textContent).toBe(k('revokedLink'));
    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: k('copyLink') })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: k('createLink') })));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(newLink);
    expect(mocks.createInvite.mock.calls[0][0].clientId).not.toBe(mocks.createInvite.mock.calls[1][0].clientId);
    expect(screen.queryByText(k('reusableLink'))).toBeNull();
  });
  it.each(['ROLE_REQUIRED', 'INVITATION_NOT_FOUND', 'REQUEST_TIMEOUT', 'INVITE_REVOKE_UNSUPPORTED'])('retains state when revoke fails with %s', async errorCode => {
    mocks.revokeInvite.mockResolvedValue({ ok: false, errorCode });
    await create();
    fireEvent.click(screen.getByRole('button', { name: k('revokeLink') }));
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: k('revokeLink') }).at(-1)!));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText(k('reusableLink'))).toBeNull();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(link);
    expect(screen.getByRole('button', { name: k('copyLink') })).toBeTruthy();
    expect(mocks.success).not.toHaveBeenCalled();
  });
  it('disables revoke with an explicit fallback for an old server response', async () => {
    mocks.createInvite.mockResolvedValue({ ok: true, link, expiresAt: '2099-10-09T12:00:00Z' });
    await create();
    expect(screen.getByText(k('revokeUnsupported'))).toBeTruthy();
    expect((screen.getByRole('button', { name: k('revokeLink') }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.revokeInvite).not.toHaveBeenCalled();
  });
  it('keeps the confirmation and blocks copy, dismiss and duplicate revocation while pending', async () => {
    let finish!: (value: unknown) => void;
    mocks.revokeInvite.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await create();
    fireEvent.click(screen.getByRole('button', { name: k('revokeLink') }));
    const confirm = screen.getByRole('button', { name: k('revokeLink') });
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(mocks.revokeInvite).toHaveBeenCalledOnce();
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'commonUi.confirmDialog.cancel' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish({ ok: true, revoked: true }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mocks.copy).not.toHaveBeenCalled();
  });
  it('reuses the same revocation id after an uncertain timeout', async () => {
    mocks.revokeInvite.mockResolvedValueOnce({ ok: false, errorCode: 'REQUEST_TIMEOUT' });
    await create();
    for (let i = 0; i < 2; i++) {
      fireEvent.click(screen.getByRole('button', { name: k('revokeLink') }));
      await act(async () => fireEvent.click(screen.getByRole('button', { name: k('revokeLink') })));
    }
    expect(mocks.revokeInvite.mock.calls[0][0]).toEqual(mocks.revokeInvite.mock.calls[1][0]);
    expect(screen.getByRole('status').textContent).toBe(k('revokedLink'));
  });
  it('does not apply a revocation result or toast from an old account', async () => {
    let finish!: (value: unknown) => void;
    mocks.revokeInvite.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await create();
    fireEvent.click(screen.getByRole('button', { name: k('revokeLink') }));
    fireEvent.click(screen.getByRole('button', { name: k('revokeLink') }));
    setDataOwnerGeneration('other-account', 2);
    await act(async () => finish({ ok: true, revoked: true }));
    expect(screen.queryByText(k('revokedLink'))).toBeNull();
    expect(mocks.success).not.toHaveBeenCalled();
  });
  it.each(['success', 'error', 'rejection'])('clears a pending revoke after a same-account generation update on %s', async outcome => {
    let finish!: (value: unknown) => void;
    let reject!: (reason: Error) => void;
    mocks.revokeInvite.mockReturnValue(new Promise((resolve, fail) => { finish = resolve; reject = fail; }));
    const onClose = vi.fn();
    render(<ChatInviteDialog groupId="room" onClose={onClose} />);
    await screen.findByRole('button', { name: k('copyLink') });
    fireEvent.click(screen.getByRole('button', { name: k('revokeLink') }));
    fireEvent.click(screen.getByRole('button', { name: k('revokeLink') }));
    expect((screen.getByRole('button', { name: 'commonUi.confirmDialog.cancel' }) as HTMLButtonElement).disabled).toBe(true);
    setDataOwnerGeneration('account', 2);
    await act(async () => {
      if (outcome === 'rejection') reject(new Error('unavailable'));
      else finish(outcome === 'success' ? { ok: true, revoked: true } : { ok: false, errorCode: 'ROLE_REQUIRED' });
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(k('reusableLink'))).toBeNull();
    expect(mocks.success).not.toHaveBeenCalled();
    const close = screen.getByRole('button', { name: 'bots.close' }) as HTMLButtonElement;
    expect(close.disabled).toBe(false);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('discards a stale reusable preview when the server reports an expired or revoked link on acceptance', async () => {
    mocks.acceptInvite.mockResolvedValue({ ok: false, errorCode: 'INVITATION_NOT_FOUND' });
    render(<ChatInviteDialog initialLink={link} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: k('accept') });
    expect(screen.getByRole('status').textContent).toBe(k('reusableLink'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: k('accept') })));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe(k('invalidInvite'));
    expect(screen.queryByRole('button', { name: k('accept') })).toBeNull();
    expect(mocks.previewInvite).toHaveBeenCalledTimes(1);
  });
  it('does not show permanent validity when a response omits the reusable flag', async () => {
    mocks.createInvite.mockResolvedValue({ ok: true, link, expiresAt: null });
    await create();
    expect(screen.queryByText(k('reusableLink'))).toBeNull();
  });
  it.each([false, true])('retains the link and clears successful copy feedback on clipboard failure (previousSuccess=%s)', async previousSuccess => {
    await create();
    if (previousSuccess) {
      await act(async () => fireEvent.click(screen.getByRole('button', { name: k('copyLink') })));
      expect(screen.getByRole('button', { name: k('copied') })).toBeTruthy();
    }
    mocks.copy.mockRejectedValueOnce(new Error('unavailable'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: k(previousSuccess ? 'copied' : 'copyLink') })));
    expect(screen.getByRole('alert').textContent).toBe(k('copyFailed'));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(link);
    expect(screen.getByRole('button', { name: k('copyLink') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: k('copied') })).toBeNull();
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
