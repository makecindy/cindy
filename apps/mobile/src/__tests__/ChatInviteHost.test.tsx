// @vitest-environment jsdom
// Test value: real Host + intent/native entry; a controlled sheet substitutes only
// the separately-owned preview/accept UI. Protects A2's login, single-presentation
// and current-account navigation contract, absent from nativeIntent's pure tests.
// Minimum failure: a login-delayed link or an old onJoined callback after switching.
// Unit tier, in-memory React rendering; no native/network/credential access.
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { StackRouter } from 'expo-router/build/react-navigation/routers/StackRouter';

const h = vi.hoisted(() => ({
  push: vi.fn(), resetRoot: vi.fn(), wrapped: false,
  routes: [] as Array<{ name: string; key: string; params?: Record<string, unknown> }>,
  auth: { user: null as { id: string } | null },
  sheets: [] as any[],
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: h.push }),
  useNavigationContainerRef: () => ({ getRootState: () => h.wrapped ? ({ index: 0, routes: [{ name: "__root", key: "expo-root", state: { index: h.routes.length - 1, routes: h.routes } }] }) : ({ index: h.routes.length - 1, routes: h.routes }), resetRoot: h.resetRoot }),
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/chat/useClipboardChatInvite', () => ({ useClipboardChatInvite: vi.fn() }));
vi.mock('@/chat/ChatInviteSheet', () => ({ ChatInviteSheet: (props: any) => {
  h.sheets.push(props);
  return createElement('div', { 'data-sheet': true, 'data-visible': props.visible });
} }));
vi.mock('@/config/env', () => ({ WECHAT_APP_ID: 'wx-test-mobile', WECHAT_UNIVERSAL_LINK: 'https://login.example.invalid/app/' }));

import { ChatInviteHost } from '@/chat/ChatInviteHost';
import { closeChatInvite, getChatInviteIntent, openManualChatInvite } from '@/chat/chatInviteIntent';
import { invalidateMobileAuthOwnerForSwitch, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { redirectSystemPath } from '../../app/+native-intent';

const link = `cindy://chat-invite/${'A'.repeat(43)}`;
const groupId = '00000000-0000-4000-8000-000000000001';
let root: Root;
let container: HTMLDivElement;
let ready = false;
const latest = () => h.sheets.at(-1) as ComponentProps<typeof import('@/chat/ChatInviteSheet').ChatInviteSheet>;
const render = () => act(() => root.render(createElement(StrictMode, null, createElement(ChatInviteHost, { ready }))));
const openLink = (value = link) => act(() => { redirectSystemPath({ path: value, initial: false }); });
function signIn(id: string) {
  act(() => { h.auth.user = { id }; setMobileAuthOwner(id); });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
  const pending = getChatInviteIntent();
  if (pending) closeChatInvite(pending.id);
  setMobileAuthOwner(null); h.auth.user = null; h.sheets = []; h.push.mockClear(); h.resetRoot.mockClear();
  h.wrapped = false; h.routes = [{ name: 'devices/index', key: 'home-existing' }];
  ready = false; container = document.createElement('div'); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  const pending = getChatInviteIntent();
  if (pending) closeChatInvite(pending.id);
});

describe('the single mobile invitation host', () => {
  it('resumes the same invitation after login, without navigating or accepting early', () => {
    render(); openLink();
    expect(latest()).toMatchObject({ visible: false, link, retainTargetWhenHidden: true });
    latest().onJoined(groupId); expect(h.push).not.toHaveBeenCalled();
    signIn('owner'); ready = true; render();
    expect(latest()).toMatchObject({ visible: true, link });
    act(() => latest().onClose());
    expect(getChatInviteIntent()).toBeNull();
    expect(latest()).toMatchObject({ visible: false, link: undefined, retainTargetWhenHidden: false });
    const joined = latest().onJoined;
    act(() => joined(groupId));
    joined(groupId);
    expect(h.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/companions/groups/[groupId]', params: { groupId } });
    expect(getChatInviteIntent()).toBeNull();
    expect(container.querySelectorAll('[data-visible="true"]')).toHaveLength(0);
  });

  it('returns a warm invitation to the mounted home after successful joining', () => {
    const home = { name: 'devices/index', key: 'home-existing', params: { scroll: 'preserved' } };
    h.routes = [home, { name: 'sessions/[sessionId]', key: 'task', params: { sessionId: 'old-task' } }];
    signIn('owner'); ready = true; render(); openLink();
    expect(h.resetRoot).not.toHaveBeenCalled();
    act(() => latest().onClose());
    expect(h.resetRoot).not.toHaveBeenCalled();
    act(() => latest().onJoined(groupId));
    expect(h.push).not.toHaveBeenCalled();
    expect(h.resetRoot).toHaveBeenCalledOnce();
    const reset = h.resetRoot.mock.calls[0]![0];
    expect(reset.routes[0]).toEqual(home);
    expect(reset.routes).toHaveLength(2);
    expect(reset.routes[1]).toEqual({ name: 'companions/groups/[groupId]', params: { groupId } });
    // Execute the actual Expo stack reducer: native/system GO_BACK must land on home.
    const stack = StackRouter({});
    const config = { routeNames: ['devices/index', 'sessions/[sessionId]', 'companions/groups/[groupId]'], routeParamList: {}, routeGetIdList: {} };
    const joined = stack.getRehydratedState({ ...reset, stale: true } as never, config);
    const back = stack.getStateForAction(joined, { type: 'GO_BACK' }, config);
    expect(back?.routes[back.index ?? 0].key).toBe(home.key);
  });

  it('adds a home fallback when an accepted external invitation started without home', () => {
    h.routes = [{ name: 'settings/index', key: 'settings' }];
    signIn('owner'); ready = true; render(); openLink();
    act(() => latest().onClose()); act(() => latest().onJoined(groupId));
    expect(h.resetRoot).toHaveBeenCalledExactlyOnceWith({ index: 1, routes: [
      { name: 'devices/index' }, { name: 'companions/groups/[groupId]', params: { groupId } },
    ] });
  });

  it('leaves the warm origin stack untouched when the invitation is cancelled', () => {
    h.routes = [{ name: 'devices/index', key: 'home' }, { name: 'settings/index', key: 'settings' }];
    signIn('owner'); ready = true; render(); openLink();
    act(() => latest().onClose());
    expect(h.push).not.toHaveBeenCalled(); expect(h.resetRoot).not.toHaveBeenCalled();
  });

  it('retains the target but ignores stale success/close callbacks across account switching', () => {
    signIn('owner'); ready = true; render(); openLink();
    const old = latest();
    act(() => invalidateMobileAuthOwnerForSwitch());
    expect(latest()).toMatchObject({ visible: false, retainTargetWhenHidden: true });
    act(() => { old.onJoined(groupId); old.onClose(); });
    expect(h.push).not.toHaveBeenCalled(); expect(getChatInviteIntent()?.link).toBe(link);
    // The synchronous owner can publish before AuthContext renders its new user.
    act(() => setMobileAuthOwner('other'));
    expect(latest().visible).toBe(false);
    signIn('other'); render();
    expect(latest()).toMatchObject({ visible: true, link });
    act(() => old.onJoined(groupId)); expect(h.push).not.toHaveBeenCalled();
    act(() => latest().onClose());
    act(() => latest().onJoined(groupId)); expect(h.push).toHaveBeenCalledOnce();
  });

  it('keeps one panel when manual entry and another external link collide', () => {
    signIn('owner'); ready = true; render();
    act(() => openManualChatInvite());
    openLink();
    expect(container.querySelectorAll('[data-sheet]')).toHaveLength(1);
    expect(latest()).toMatchObject({ visible: true, link: undefined, hasOtherInvitation: true });
    act(() => latest().onClose());
    expect(getChatInviteIntent()).toBeNull();
    expect(container.querySelectorAll('[data-visible="true"]')).toHaveLength(0);
  });

  it('does not replace a confirming link or enqueue a second one', () => {
    signIn('owner'); ready = true; render(); openLink();
    openLink(`cindycn://chat-invite/${'A'.repeat(43)}`);
    expect(latest().hasOtherInvitation).toBe(false);
    openLink(`cindy://chat-invite/${'B'.repeat(43)}`);
    expect(latest()).toMatchObject({ link, hasOtherInvitation: true });
    expect(container.querySelectorAll('[data-sheet]')).toHaveLength(1);
    act(() => latest().onClose());
    expect(getChatInviteIntent()).toBeNull();
  });

  it('ignores success from an inactive login route or unmounted Host', () => {
    signIn('owner'); ready = true; render(); openLink();
    const old = latest(); ready = false; render();
    act(() => old.onJoined(groupId)); expect(h.push).not.toHaveBeenCalled();
    ready = true; render(); const active = latest();
    act(() => root.unmount());
    root = createRoot(container); // afterEach owns the fresh empty root.
    active.onJoined(groupId);
    expect(h.push).not.toHaveBeenCalled(); expect(getChatInviteIntent()?.link).toBe(link);
  });
});

// Native regression: Expo's actual container has __root -> app stack. Flat mocks
// previously passed while Open Group dismissed the sheet and stayed on Home.
it.each([false, true])('opens the group inside the real Expo root (warm=%s)', warm => {
  h.wrapped = true;
  const home = { name: 'index', key: 'mounted-home' };
  h.routes = warm ? [home, { name: 'settings/index', key: 'settings' }] : [home];
  signIn('owner'); ready = true; render(); openLink();
  act(() => latest().onClose()); act(() => latest().onJoined(groupId));
  if (!warm) {
    expect(h.resetRoot).not.toHaveBeenCalled();
    expect(h.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/companions/groups/[groupId]', params: { groupId } });
    return;
  }
  const reset = h.resetRoot.mock.calls[0]?.[0];
  expect(reset.routes[0]).toMatchObject({ name: '__root', key: 'expo-root' });
  const stack = StackRouter({});
  const config = { routeNames: ['index', 'settings/index', 'companions/groups/[groupId]'], routeParamList: {}, routeGetIdList: {} };
  const joined = stack.getRehydratedState({ ...reset.routes[0].state, stale: true } as never, config);
  expect(joined.routes[joined.index]).toMatchObject({ name: 'companions/groups/[groupId]', params: { groupId } });
  const back = stack.getStateForAction(joined, { type: 'GO_BACK' }, config);
  expect(back?.routes[back.index ?? 0].key).toBe(home.key);
});
