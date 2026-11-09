vi.mock('@/session/TaskDrawerPresentation', () => ({ useTaskDrawerPresentation: () => null, TaskDrawerPresentation: () => null }));
// @vitest-environment jsdom
import { act, useState } from 'react';
import { BotGroupPaneLayout } from '@/session/BotGroupPaneLayout';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useConversationTaskDrawer } from '@/session/useConversationTaskDrawer';
const state = vi.hoisted(() => ({ gesture: null as any, pane: null as any, persistent: false, instances: 0 }));
vi.mock('react-native', () => ({ View: ({ children }: any) => <div>{children}</div>, StyleSheet: { create: (s: any) => s }, Platform: { OS: 'ios' }, BackHandler: { addEventListener: () => ({ remove() {} }) } }));
vi.mock('@/session/SessionListDrawer', () => ({ SessionListDrawer: (props: any) => { useState(() => ++state.instances); state.pane = props; return null; }, useSessionListDrawerMotion: () => ({}),
  useSessionListDrawerOpenGesture: (props: any) => { state.gesture = props; return props; } }));
let root: ReturnType<typeof createRoot>, node: HTMLDivElement, drawer: ReturnType<typeof useConversationTaskDrawer>;
function Probe({ persistent = false, enabled = true }: { persistent?: boolean; enabled?: boolean }) {
  drawer = useConversationTaskDrawer({ enabled, persistent, width: 400 }); return null;
}
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; node = document.createElement('div'); root = createRoot(node); });
afterEach(() => act(() => root.unmount()));
it('defers the first destination until the drawer is gone, rejecting subsequent taps', () => {
  act(() => root.render(<Probe />)); act(() => drawer.openSessionListDrawer());
  const first = vi.fn(), second = vi.fn();
  act(() => { drawer.queueDrawerNavigation(first); drawer.queueDrawerNavigation(second); });
  expect(first).not.toHaveBeenCalled(); expect(drawer.sessionListDrawerOverlayMounted).toBe(true);
  expect(drawer.sessionListDrawerOpen).toBe(false);
  act(() => drawer.handleSessionListDrawerClosed());
  expect(first).toHaveBeenCalledTimes(1); expect(second).not.toHaveBeenCalled();
  expect(drawer.sessionListDrawerOverlayMounted).toBe(false);
});
it('cancels a pull before its opening render without leaving an input blocker', () => {
  act(() => root.render(<Probe />));
  act(() => { state.gesture.onOpen(); state.gesture.onCancel(); state.gesture.onSettle(); });
  expect(drawer.sessionListDrawerOpen).toBe(false); expect(drawer.sessionListDrawerOverlayMounted).toBe(false);
  act(() => drawer.openSessionListDrawer()); expect(drawer.sessionListDrawerOpen).toBe(true);
});
// Unit: replace the retired source-order guard with the observable close-only
// race. Existing duplicate-navigation coverage has a pending destination; this
// case must also reject a tap while closing without any pending destination.
it('rejects navigation during a close-only exit and accepts it after reopening', () => {
  act(() => root.render(<Probe />)); act(() => drawer.openSessionListDrawer());
  const next = vi.fn();
  act(() => { drawer.closeSessionListDrawer(); drawer.queueDrawerNavigation(next); });
  expect(drawer.sessionListDrawerOpen).toBe(false);
  expect(drawer.sessionListDrawerOverlayMounted).toBe(true);
  act(() => drawer.handleSessionListDrawerClosed()); expect(next).not.toHaveBeenCalled();
  act(() => drawer.openSessionListDrawer());
  act(() => drawer.queueDrawerNavigation(next));
  act(() => drawer.handleSessionListDrawerClosed()); expect(next).toHaveBeenCalledOnce();
});
it('finishes pending navigation after docking, then restores the portrait gesture', () => {
  act(() => root.render(<Probe />)); act(() => drawer.openSessionListDrawer());
  const next = vi.fn(); act(() => drawer.queueDrawerNavigation(next));
  act(() => root.render(<Probe persistent />)); expect(state.gesture.enabled).toBe(false);
  act(() => drawer.handleSessionListDrawerClosed()); expect(next).toHaveBeenCalledTimes(1);
  act(() => root.render(<Probe />)); expect(state.gesture.enabled).toBe(true);
});
it('does not intercept narrow phones and navigates directly from a docked sidebar', () => {
  act(() => root.render(<Probe enabled={false} />)); act(() => drawer.openSessionListDrawer());
  expect(state.gesture.enabled).toBe(false); expect(drawer.sessionListDrawerOpen).toBe(false);
  act(() => root.render(<Probe persistent />)); const next = vi.fn();
  act(() => drawer.queueDrawerNavigation(next)); expect(next).toHaveBeenCalledTimes(1);
});

vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useLocalSearchParams: () => ({}) }));
vi.mock('expo-router/react-navigation', () => ({ useIsFocused: () => true }));
vi.mock('@/platform/gestureHandler', () => ({ GestureDetector: ({ children }: any) => children }));
vi.mock('@/platform/AdaptiveWindowContext', () => ({ PaneViewportProvider: ({ children }: any) => children,
  useAdaptiveWindow: () => ({ width: 669, height: 951, insets: { top: 88, bottom: 34, left: 0, right: 0 },
    regularWidth: true, reservedRegionsSupported: true, regions: [], barEdge: 'none' }) }));
vi.mock('@/session/RecentMessageHistories', () => ({ MessageHistoryOverlay: ({ children }: any) => children }));
vi.mock('@/session/SessionPaneDivider', () => ({ SessionPaneDivider: () => null }));
vi.mock('@/session/useSessionHeaderHeight', () => ({ useSessionHeaderHeight: () => 88 }));
vi.mock('@/session/ResidentHomeList', () => ({ useSessionSidebarWidthPreference: () => ({ width: 386, setWidth() {} }),
  useSessionPaneLayout: () => ({ persistent: state.persistent, sidebarWidth: 386, detail: { x: 0, y: 0, width: 669 }, resizeBounds: null }) }));
it('the group route wires the shared gesture and keeps one drawer while docking', () => {
  state.persistent = false; state.instances = 0;
  act(() => root.render(<BotGroupPaneLayout><span>conversation</span></BotGroupPaneLayout>));
  expect(state.gesture.enabled).toBe(true); expect(state.pane.open).toBe(false);
  act(() => state.gesture.onOpen()); expect(state.pane.open).toBe(true);
  expect(state.pane.width).toBe(386); expect(state.pane.aboveSystemBar).toBe(true);
  state.persistent = true;
  act(() => root.render(<BotGroupPaneLayout><span>conversation</span></BotGroupPaneLayout>));
  expect(state.pane.persistent).toBe(true); expect(state.pane.width).toBe(386);
  expect(state.gesture.enabled).toBe(false); expect(state.instances).toBe(1);
  act(() => state.pane.onColumnReady());
  state.persistent = false;
  act(() => root.render(<BotGroupPaneLayout><span>conversation</span></BotGroupPaneLayout>));
  expect(state.gesture.enabled).toBe(true); expect(state.pane.open).toBe(false);
});
