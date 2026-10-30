// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  os: 'ios', state: 'active', version: '1',
  listeners: new Set<(state: string) => void>(),
  read: vi.fn(), hasText: vi.fn(), readVersion: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { get OS() { return h.os; } },
  AppState: { get currentState() { return h.state; }, addEventListener: (_: string, listener: (state: string) => void) => {
    h.listeners.add(listener); return { remove: () => h.listeners.delete(listener) };
  } },
}));
vi.mock('expo-clipboard', () => ({ getStringAsync: h.read, hasStringAsync: h.hasText }));
vi.mock('../../modules/cindy-remote-presentation/src', () => ({ remotePresentation: { clipboardVersion: h.readVersion } }));
import { useClipboardChatInvite } from '@/chat/useClipboardChatInvite';
import { getMobileAuthOwner, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { getChatInviteIntent, closeChatInvite, openManualChatInvite, receiveChatInviteLink } from '@/chat/chatInviteIntent';
const link = `https://invite.example.test/chat-invite/join#${'A'.repeat(43)}`;
const canonical = `cindy://chat-invite/${'A'.repeat(43)}`;
const other = `cindy://chat-invite/${'B'.repeat(43)}`;
let root: Root;
function Harness({ enabled }: { enabled: boolean }) { useClipboardChatInvite(enabled, getMobileAuthOwner()); return null; }
const render = (enabled = true) => act(async () => root.render(createElement(Harness, { enabled })));
const state = (value: string) => act(async () => { h.state = value; for (const listener of h.listeners) listener(value); });
const close = () => { const value = getChatInviteIntent(); if (value) closeChatInvite(value.id); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  close(); setMobileAuthOwner('clipboard-owner');
  h.os = 'ios'; h.state = 'active'; h.version = '1'; h.listeners.clear();
  h.read.mockReset().mockResolvedValue(link); h.hasText.mockReset().mockResolvedValue(true);
  h.readVersion.mockReset().mockImplementation(async () => h.version);
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => root.unmount()); close(); });

it('waits for startup/login readiness, then opens a complete copied invitation', async () => {
  await render(false); expect(h.read).not.toHaveBeenCalled();
  await render(); expect(getChatInviteIntent()?.link).toBe(canonical);
});
it('waits until foreground and discovers a newly copied link on returning', async () => {
  h.state = 'background'; await render(); expect(h.read).not.toHaveBeenCalled();
  await state('active'); expect(getChatInviteIntent()?.link).toBe(canonical); close();
  await state('background'); h.version = '2'; h.read.mockResolvedValue(other);
  await state('active'); expect(getChatInviteIntent()?.link).toBe(other);
});
it('does not reread unchanged iOS contents or reopen a cancelled invitation', async () => {
  await render(); close(); await state('background'); await state('active');
  expect(h.read).toHaveBeenCalledTimes(1); expect(getChatInviteIntent()).toBeNull();
});
// Unit regression from Dev UAT: another external invite overwrote the only
// content-dedup key. The simple cancellation test never opens a second link.
it.each(['ios', 'android'])('does not revive the previous clipboard after another invitation on %s', async os => {
  h.os = os;
  await render(); expect(getChatInviteIntent()?.link).toBe(canonical); close();
  receiveChatInviteLink(other); close();
  await state('background'); h.version = '2'; await state('active');
  expect(getChatInviteIntent()).toBeNull();
  const fresh = `cindy://chat-invite/${'C'.repeat(43)}`;
  await state('background'); h.version = '3'; h.read.mockResolvedValue(fresh); await state('active');
  expect(getChatInviteIntent()?.link).toBe(fresh);
});
it.each(['', 'hello', 'https://example.test', 'A'.repeat(43), 'cindy://chat-invite/bad', `/chat-invite/${'A'.repeat(43)}`])('ignores unrelated or malformed clipboard content %s', async text => {
  h.read.mockResolvedValue(text); await render(); expect(getChatInviteIntent()).toBeNull();
});
it('ignores images without reading the clipboard contents', async () => {
  h.hasText.mockResolvedValue(false); await render(); expect(h.read).not.toHaveBeenCalled();
});
it.each([false, true])('does not repeat permission denial for the same clipboard (throws=%s)', async throws => {
  if (throws) h.read.mockRejectedValue(new Error('denied')); else h.read.mockResolvedValue('');
  await render(); await state('inactive'); await state('active');
  expect(h.read).toHaveBeenCalledTimes(1); expect(getChatInviteIntent()).toBeNull();
  h.version = '2'; h.read.mockResolvedValue(link); await state('background'); await state('active');
  expect(getChatInviteIntent()?.link).toBe(canonical);
});
it('waits through permission-dialog inactivity and presents only when active', async () => {
  const reading = deferred<string>(); h.read.mockReturnValue(reading.promise); await render();
  await state('inactive'); await act(async () => reading.resolve(link));
  expect(getChatInviteIntent()).toBeNull(); await state('active');
  expect(getChatInviteIntent()?.link).toBe(canonical); expect(h.read).toHaveBeenCalledTimes(1);
});
it('discards a read across real backgrounding and checks again on return', async () => {
  const reading = deferred<string>(); h.read.mockReturnValueOnce(reading.promise); await render();
  await state('background'); await act(async () => reading.resolve(link));
  expect(getChatInviteIntent()).toBeNull(); h.version = '2'; h.read.mockResolvedValue(other);
  await state('active'); expect(getChatInviteIntent()?.link).toBe(other);
});
it('does not revive a closed manual entry with a late clipboard result', async () => {
  const reading = deferred<string>(); h.read.mockReturnValue(reading.promise); await render();
  openManualChatInvite(); close(); await act(async () => reading.resolve(link));
  expect(getChatInviteIntent()).toBeNull();
});
it('does not overwrite a native-link invitation with a late clipboard result', async () => {
  const reading = deferred<string>(); h.read.mockReturnValue(reading.promise); await render();
  receiveChatInviteLink(other); await act(async () => reading.resolve(link));
  expect(getChatInviteIntent()).toMatchObject({ link: other, hasOtherInvitation: false });
});
it('rejects an old account read after the account owner changes', async () => {
  const reading = deferred<string>(); h.read.mockReturnValue(reading.promise); await render();
  setMobileAuthOwner('another-owner'); await render(false);
  await act(async () => reading.resolve(link)); expect(getChatInviteIntent()).toBeNull();
});
it('discards content when the iOS clipboard changed during its read', async () => {
  h.read.mockImplementation(async () => { h.version = '2'; return link; });
  await render(); expect(getChatInviteIntent()).toBeNull();
});
it('uses content deduplication on Android without an iOS version API', async () => {
  h.os = 'android'; await render(); expect(getChatInviteIntent()?.link).toBe(canonical); close();
  await state('background'); await state('active'); expect(getChatInviteIntent()).toBeNull();
  expect(h.readVersion).not.toHaveBeenCalled();
  h.read.mockResolvedValue(other); await state('background'); await state('active');
  expect(getChatInviteIntent()?.link).toBe(other);
});
it('keeps an explicit invitation ahead of automatic detection', async () => {
  receiveChatInviteLink(canonical); await render(); expect(h.read).not.toHaveBeenCalled(); close();
  await state('background'); await state('active'); expect(getChatInviteIntent()).toBeNull();
});
it('removes foreground listeners and ignores reads after unmounting', async () => {
  const reading = deferred<string>(); h.read.mockReturnValue(reading.promise); await render();
  await act(async () => root.render(null)); await act(async () => reading.resolve(link));
  expect(h.listeners.size).toBe(0); expect(getChatInviteIntent()).toBeNull();
});
