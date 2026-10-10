// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { ChatInviteDialog } from '../ChatInviteDialog';
const mocks = vi.hoisted(() => ({ createInvite: vi.fn(), previewInvite: vi.fn(), acceptInvite: vi.fn(), revokeInvite: vi.fn(), copy: vi.fn(), success: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { date?: string }) => values?.date ? `${key}: ${values.date}` : key, i18n: { language: 'en' } }) }));
vi.mock('../botGroupStore', () => ({ refreshBotGroups: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { success: mocks.success } }));
const k = (name: string) => `bots.groupChat.server.${name}`;
const link = `cindy://chat-invite/${'a'.repeat(43)}`;
beforeEach(() => {
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
  render(<ChatInviteDialog groupId="room" onClose={vi.fn()} />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: k('createLink') })));
}
describe('invitation validity', () => {
  it('shows null as reusable and copies the same link repeatedly without generating more', async () => {
    await create();
    expect(screen.getByRole('status').textContent).toBe(k('reusableLink'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: k('copyLink') })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: k('copyLink') })));
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
    await act(async () => fireEvent.click(screen.getByRole('button', { name: k('previewInvite') })));
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
    expect(screen.getByRole('status').textContent).toBe(k('reusableLink'));
  });
  it.each(['ROLE_REQUIRED', 'INVITATION_NOT_FOUND', 'REQUEST_TIMEOUT', 'INVITE_REVOKE_UNSUPPORTED'])('retains state when revoke fails with %s', async errorCode => {
    mocks.revokeInvite.mockResolvedValue({ ok: false, errorCode });
    await create();
    fireEvent.click(screen.getByRole('button', { name: k('revokeLink') }));
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: k('revokeLink') }).at(-1)!));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(k('reusableLink'));
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
    await act(async () => fireEvent.click(screen.getByRole('button', { name: k('createLink') })));
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
    expect(screen.getByRole('status').textContent).toBe(k('reusableLink'));
    expect(mocks.success).not.toHaveBeenCalled();
    const close = screen.getByRole('button', { name: 'bots.close' }) as HTMLButtonElement;
    expect(close.disabled).toBe(false);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('discards a stale reusable preview when the server reports an expired or revoked link on acceptance', async () => {
    mocks.acceptInvite.mockResolvedValue({ ok: false, errorCode: 'INVITATION_NOT_FOUND' });
    render(<ChatInviteDialog initialLink={link} onClose={vi.fn()} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: k('previewInvite') })));
    expect(screen.getByRole('status').textContent).toBe(k('reusableLink'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: k('accept') })));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe(k('invalidInvite'));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(link);
  });
  it('does not show permanent validity when a response omits the reusable flag', async () => {
    mocks.createInvite.mockResolvedValue({ ok: true, link, expiresAt: null });
    await create();
    expect(screen.queryByText(k('reusableLink'))).toBeNull();
  });
  it('retains link and shows a failed clipboard action without a success toast', async () => {
    mocks.copy.mockRejectedValue(new Error('unavailable'));
    await create();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: k('copyLink') })));
    expect(screen.getByRole('alert').textContent).toBe(k('copyFailed'));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(link);
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
