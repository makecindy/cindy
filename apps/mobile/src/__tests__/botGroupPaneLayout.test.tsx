// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { WindowGeometry } from '../platform/windowGeometry';
import { sessionPaneLayout } from '../session/sessionPaneLayout';
import BotGroupChatRoute from '../../app/companions/groups/[groupId]';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const state = vi.hoisted(() => ({ width: 1000, mounts: 0, unmounts: 0, drawer: null as any }));
const geometry = (): WindowGeometry => ({
  width: state.width, height: 800, insets: { top: 0, right: 0, bottom: 0, left: 0 },
  regularWidth: state.width >= 600, regularHeight: true, barEdge: 'none', regions: [], reservedRegionsSupported: false,
});
vi.mock('react-native', async () => {
  const React = await import('react');
  return {
    StyleSheet: { create: (v: any) => v },
    useWindowDimensions: () => ({ width: state.width, height: 800 }),
    View: ({ children, style }: any) => {
      const flat = Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
      return React.createElement('div', { 'data-margin-left': flat.marginLeft ?? 0, 'data-margin-right': flat.marginRight ?? 0 }, children);
    },
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ groupId: 'g1', deviceId: 'mac', deviceName: 'Mac' }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: 1 }) }));
vi.mock('@/session/ResidentHomeList', () => ({ useSessionPaneLayout: () => sessionPaneLayout(geometry()) }));
vi.mock('@/session/RecentMessageHistories', () => ({ MessageHistoryOverlay: ({ children }: any) => children }));
vi.mock('@/session/SessionListDrawer', () => ({ SessionListDrawer: (props: any) => { state.drawer = props; return null; } }));
vi.mock('@/session/BotGroupChatScreen', async () => {
  const React = await import('react');
  return { BotGroupChatScreen: () => {
    React.useEffect(() => { state.mounts += 1; return () => { state.unmounts += 1; }; }, []);
    return React.createElement('section', { 'data-group': 'g1' });
  } };
});

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach(root => root.unmount()));
  state.width = 1000; state.mounts = 0; state.unmounts = 0; state.drawer = null;
});

// Unit regression for #8303 review: drive the real group route and its pane
// layout, not a stand-in. Before the fix the route rendered the chat full
// width with no sidebar; folding must not remount the chat.
it('places the routed group chat beside a persistent sidebar and keeps it mounted through fold and unfold', () => {
  const host = document.createElement('div'), root = createRoot(host); roots.push(root);
  const render = () => act(() => root.render(<BotGroupChatRoute />));
  const pane = () => host.querySelector('[data-group]')!.parentElement!;
  render();
  const wide = sessionPaneLayout(geometry());
  expect(wide.persistent).toBe(true);
  expect(Number(pane().getAttribute('data-margin-left'))).toBe(wide.detail.x);
  expect(Number(pane().getAttribute('data-margin-right'))).toBe(1000 - wide.detail.x - wide.detail.width);
  expect(state.drawer).toMatchObject({ persistent: true, open: true, width: wide.sidebarWidth });
  expect(state.drawer.onSelectSession).toBeUndefined();

  state.width = 430; state.drawer = null; render();
  expect(pane().getAttribute('data-margin-left')).toBe('0');
  expect(state.drawer).toBeNull();

  state.width = 1000; render();
  expect(Number(pane().getAttribute('data-margin-left'))).toBe(wide.detail.x);
  expect(state.mounts).toBe(1);
  expect(state.unmounts).toBe(0);
});
