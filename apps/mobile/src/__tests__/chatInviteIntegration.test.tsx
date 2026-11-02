// @vitest-environment jsdom
// Integration tier: real intent, Host, Sheet and invitation hook. Only native
// rendering, HTTP identity/operations and navigation are substituted. Separate
// Host/hook tests cannot detect a lost receipt when Host clears the link on close.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ auth: { user: null as { id: string } | null }, push: vi.fn(),
  preview: vi.fn(), accept: vi.fn(), clipboard: vi.fn(), view: null as any, sequence: 0,
  state: 'active', listeners: new Set<(value: string) => void>() }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: h.push }),
  useNavigationContainerRef: () => ({ getRootState: () => ({ index: 0, routes: [{ name: 'devices/index', key: 'home' }] }) }),
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => `operation-${++h.sequence}` }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('expo-clipboard', () => ({ hasStringAsync: async () => true, getStringAsync: h.clipboard }));
vi.mock('../../modules/cindy-remote-presentation/src', () => ({ remotePresentation: null }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: { get currentState() { return h.state; },
  addEventListener: (_: string, listener: (value: string) => void) => {
    h.listeners.add(listener); return { remove: () => h.listeners.delete(listener) };
  },
} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/chat/ChatInviteView', () => ({ ChatInviteView: (props: unknown) => { h.view = props; return null; } }));
vi.mock('@/chat/useChatServer', () => ({ useChatClient: () => {
  const owner = getMobileAuthOwner();
  return { owner: `${owner.accountKey}:${owner.generation}`, enabled: !!owner.accountKey && !owner.switching,
    current: () => isMobileAuthOwnerCurrent(owner), client: { previewInvite: h.preview, acceptInvite: h.accept } };
} }));
import { ChatInviteHost } from '@/chat/ChatInviteHost';
import { closeChatInvite, getChatInviteIntent, openManualChatInvite, receiveChatInviteLink } from '@/chat/chatInviteIntent';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
const token = 'A'.repeat(43);
const groupId = '00000000-0000-4000-8000-000000000001';
const preview = { groupId, name: 'Support', inviterName: 'Lin', expiresAt: null, reusable: true, joined: false };
let root: Root;
let ready: boolean;
const render = () => act(async () => root.render(createElement(ChatInviteHost, { ready })));
const appState = (value: string) => act(async () => { h.state = value; for (const listener of h.listeners) listener(value); });
const account = (id: string | null) => act(async () => {
  h.auth.user = id ? { id } : null; setMobileAuthOwner(id);
});
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const old = getChatInviteIntent(); if (old) closeChatInvite(old.id);
  setMobileAuthOwner(null); h.auth.user = null; h.view = null;
  h.state = 'active'; h.listeners.clear();
  vi.clearAllMocks(); h.preview.mockResolvedValue(preview); h.accept.mockResolvedValue({ groupId });
  h.clipboard.mockResolvedValue('');
  ready = false; root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  const old = getChatInviteIntent(); if (old) closeChatInvite(old.id);
});
it('waits for login and native dismissal before navigating an explicitly accepted invitation', async () => {
  receiveChatInviteLink(`cindy://chat-invite/${token}`); await render();
  expect(h.preview).not.toHaveBeenCalled();
  await account('owner'); ready = true; await render();
  expect(h.view.model.phase).toBe('preview'); expect(h.accept).not.toHaveBeenCalled();
  await act(async () => h.view.model.accept());
  expect(h.accept).toHaveBeenCalledOnce(); expect(getChatInviteIntent()).toBeNull();
  expect(h.view.visible).toBe(false); expect(h.push).not.toHaveBeenCalled();
  expect(h.view.model.manual).toBe(false); // clearing the token must not add manual controls while closing
  await act(async () => { h.view.model.closed(); h.view.model.closed(); });
  expect(h.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/companions/groups/[groupId]', params: { groupId } });
});
it('previews a copied invitation through the real Host and accepts only after confirmation', async () => {
  h.clipboard.mockResolvedValue(`https://invite.example.test/chat-invite/join#${token}`);
  await account('owner'); ready = true; await render();
  expect(h.preview).toHaveBeenCalledOnce();
  expect(h.view.model.phase).toBe('preview');
  expect(h.accept).not.toHaveBeenCalled(); expect(h.push).not.toHaveBeenCalled();
  await act(async () => h.view.model.accept());
  expect(h.accept).toHaveBeenCalledOnce(); expect(getChatInviteIntent()).toBeNull();
  await act(async () => h.view.model.closed());
  expect(h.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/companions/groups/[groupId]', params: { groupId } });
});
it('re-reads a manual target after authentication hiding and clears it on explicit cancel', async () => {
  await account('owner'); ready = true; openManualChatInvite(); await render();
  await act(async () => h.view.model.setInput(token)); await act(async () => h.view.model.read());
  expect(h.view.model.preview.name).toBe('Support');
  await account(null); expect(h.view.visible).toBe(false);
  h.preview.mockResolvedValueOnce({ ...preview, name: 'New account view' });
  await account('other'); await render();
  expect(h.preview).toHaveBeenCalledTimes(2); expect(h.view.model.preview.name).toBe('New account view');
  expect(h.accept).not.toHaveBeenCalled();
  await act(async () => h.view.model.close()); await act(async () => h.view.model.closed());
  await act(async () => openManualChatInvite());
  expect(h.view.input).toBe(true); expect(h.view.model.input).toBe('');
  expect(h.push).not.toHaveBeenCalled();
});
// Independent review P1: isolated Host/hook tests never submitted a manual target
// before a native-link collision or a fresh foreground clipboard read.
it('recognizes the same external link during a manual preview without changing its editing mode', async () => {
  await account('owner'); ready = true; openManualChatInvite(); await render();
  const link = `cindy://chat-invite/${token}`;
  await act(async () => h.view.model.setInput(link));
  await act(async () => h.view.model.read());
  await act(async () => receiveChatInviteLink(link));
  expect(getChatInviteIntent()?.hasOtherInvitation).toBe(false);
  expect(h.view.model.manual).toBe(true);
  expect(h.preview).toHaveBeenCalledOnce();
  await act(async () => receiveChatInviteLink(`cindy://chat-invite/${'B'.repeat(43)}`));
  expect(getChatInviteIntent()?.hasOtherInvitation).toBe(true);
  expect(h.accept).not.toHaveBeenCalled();
});
it('does not reopen a manually previewed clipboard invitation after cancellation and another link', async () => {
  await account('owner'); ready = true; openManualChatInvite(); await render();
  const link = `cindy://chat-invite/${token}`;
  h.clipboard.mockResolvedValue(link);
  await act(async () => h.view.model.setInput(link));
  await act(async () => h.view.model.read());
  await act(async () => h.view.model.close());
  await act(async () => h.view.model.closed());
  await appState('background'); await appState('active');
  expect(getChatInviteIntent()).toBeNull();
  await act(async () => receiveChatInviteLink(`cindy://chat-invite/${'B'.repeat(43)}`));
  await act(async () => h.view.model.close());
  await act(async () => h.view.model.closed());
  await appState('background'); await appState('active');
  expect(getChatInviteIntent()).toBeNull();
  const fresh = `cindy://chat-invite/${'C'.repeat(43)}`;
  h.clipboard.mockResolvedValue(fresh);
  await appState('background'); await appState('active');
  expect(getChatInviteIntent()?.link).toBe(fresh);
  expect(h.preview).toHaveBeenCalledTimes(3);
  expect(h.accept).not.toHaveBeenCalled();
});
it('does not navigate a successful old-account receipt when the account changes during dismissal', async () => {
  await account('owner'); ready = true; receiveChatInviteLink(`cindy://chat-invite/${token}`); await render();
  await act(async () => h.view.model.accept()); expect(h.view.visible).toBe(false);
  await account('other'); await render();
  await act(async () => h.view.model.closed());
  expect(h.push).not.toHaveBeenCalled();
});

// V9 presentation through real Host + Sheet: old servers must not invent an expiry label.
it.each([undefined, null, '2099-11-30T10:00:00Z'])('shows only a real finite deadline (%s)', async expiresAt => {
  h.preview.mockResolvedValue({ ...preview, expiresAt });
  await account('owner'); ready = true; receiveChatInviteLink(`cindy://chat-invite/${token}`); await render();
  expect(h.view.validity).toBe(typeof expiresAt === 'string' ? 'groupChat.invitation.until' : undefined);
  expect(h.accept).not.toHaveBeenCalled();
});

it.each([false, true])('keeps existing membership visible until Open Group is tapped (manual=%s)', async manual => {
  h.preview.mockResolvedValue({ ...preview, joined: true });
  await account('owner'); ready = true;
  if (manual) openManualChatInvite(); else receiveChatInviteLink(`cindy://chat-invite/${token}`);
  await render();
  if (manual) {
    await act(async () => h.view.model.setInput(token));
    await act(async () => h.view.primary.onPress());
  }
  expect(h.view.visible).toBe(true);
  expect(h.view.model.preview.joined).toBe(true);
  expect(h.view.message).toBe('groupChat.invitation.alreadyMember');
  expect(h.view.primary.label).toBe('groupChat.invitation.openGroup');
  expect(h.push).not.toHaveBeenCalled(); expect(h.accept).not.toHaveBeenCalled();
  await act(async () => h.view.primary.onPress());
  expect(h.view.visible).toBe(false); expect(h.push).not.toHaveBeenCalled();
  await act(async () => h.view.model.closed());
  expect(h.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/companions/groups/[groupId]', params: { groupId } });
  expect(h.accept).not.toHaveBeenCalled();
});
