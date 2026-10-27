// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SideChatTaskBoundary } from '../session/SideChatTaskBoundary';
import { SessionTaskLayout } from '../session/SessionTaskLayout';
import { NewSessionLayout } from '../session/NewSessionLayout';
import type { ComponentProps } from 'react';
import type { SessionListDrawer } from '../session/SessionListDrawer';
import type { RemoteSessionListItem } from '../session/sessionList';

const state = vi.hoisted(() => ({
  focused: true,
  back: vi.fn(),
  canGoBack: true,
  replace: vi.fn(),
  dismissKeyboard: vi.fn(),
  listeners: new Set<(deviceId: string, sessionId: string) => void>(),
  route: { deviceId: 'host', sessionId: 'child' } as Record<string, string>,
  sidebar: null as ComponentProps<typeof SessionListDrawer> | null,
  source: 'local',
  replaceParams: vi.fn(),
}));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  return {
    Keyboard: { dismiss: state.dismissKeyboard },
    View: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
    StyleSheet: { create: (styles: unknown) => styles },
    Platform: { OS: 'ios' }, Alert: { alert: vi.fn() },
  };
});
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => state.route,
  useNavigation: () => ({ replaceParams: state.replaceParams }),
  useRouter: () => ({
    back: state.back, canGoBack: () => state.canGoBack, replace: state.replace,
  }),
}));
vi.mock('expo-router/react-navigation', () => ({ useIsFocused: () => state.focused }));
vi.mock('../session/remoteSessionStore', () => ({
  remoteSessionStore: {
    getSessionDeviceId: () => 'host',
    onSessionRemoved: (listener: (deviceId: string, sessionId: string) => void) => {
      state.listeners.add(listener);
      return () => { state.listeners.delete(listener); };
    },
  },
  useRemoteSessionDetail: () => ({ source: state.source }),
}));
vi.mock('../session/CindyMakeSessionGate', () => ({
  CindyMakeSessionGate: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../session/RecentMessageHistories', () => ({
  MessageHistoryOverlay: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../session/ResidentHomeList', () => ({ useSessionPaneLayout: () => ({
  persistent: true, sidebarWidth: 320, detail: { x: 320, y: 0, width: 680, height: 800 },
}) }));
vi.mock('@/platform/AdaptiveWindowContext', () => ({
  useAdaptiveWindow: () => ({ barEdge: 'left', width: 1000, height: 800 }),
  PaneViewportProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: { surface: 'white' } }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../session/SessionListDrawer', () => ({ SessionListDrawer: (props: ComponentProps<typeof SessionListDrawer>) => {
  state.sidebar = props;
  return <textarea aria-label="Sidebar search" />;
} }));

// Unit, black-box regression 2026-10-20: a deleted follow-up kept its editor.
// Picker/count tests do not mount this route boundary. Minimal input: an own
// removal signal, with the route focused or hidden. Full pages must unmount the
// editor and return without waiting for the retired sheet's onClosed callback.
describe('side chat task lifecycle', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const render = (enabled = true, sessionId = 'child', deviceId = 'host') => act(() => root.render(
    <SideChatTaskBoundary key={JSON.stringify([deviceId, sessionId])} deviceId={deviceId} sessionId={sessionId} enabled={enabled}>
      <textarea aria-label="Message" />
    </SideChatTaskBoundary>,
  ));
  const remove = (deviceId = 'host', sessionId = 'child') => act(() => {
    state.listeners.forEach(listener => listener(deviceId, sessionId));
  });
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    state.focused = true;
    state.back.mockClear();
    state.canGoBack = true;
    state.replace.mockClear();
    state.dismissKeyboard.mockClear();
    state.source = 'local';
    state.route = { deviceId: 'host', sessionId: 'child' };
    state.replaceParams.mockReset();
    host = document.createElement('div');
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    expect(state.listeners.size).toBe(0);
  });

  // Unit regression #7082: sidebar navigation could cover a pending new task,
  // whose late completion then replaced the selected task. Existing tests only
  // exercise completed-task drawers. Use the real layout's navigation handler
  // while the shared submission ref changes without a React rerender.
  it('blocks new-task sidebar navigation until a pending creation returns to editing', () => {
    const creatingRef = { current: false };
    act(() => root.render(<NewSessionLayout creatingRef={creatingRef}><textarea aria-label="New task" /></NewSessionLayout>));
    const navigate = state.sidebar!.runNavigation;
    let route = 'new';
    navigate(() => { route = 'existing'; });
    expect(route).toBe('existing');
    route = 'new';
    creatingRef.current = true;
    navigate(() => { route = 'existing'; });
    expect(route).toBe('new');
    // A failed/pre-submit-aborted creation clears the same lock; retrying the
    // sidebar action works immediately. Successful handoff keeps it locked.
    creatingRef.current = false;
    navigate(() => { route = 'existing'; });
    expect(route).toBe('existing');
  });

  it('unmounts only its own deleted task and returns immediately once', () => {
    render();
    remove('other-host');
    remove('host', 'other-child');
    expect(host.querySelector('textarea')).not.toBeNull();
    remove();
    expect(host.querySelector('textarea')).toBeNull();
    expect(state.dismissKeyboard).toHaveBeenCalled();
    expect(state.back).toHaveBeenCalledTimes(1);
    // Removal also clears task metadata; losing source must not revive content.
    render(false);
    remove();
    expect(host.querySelector('textarea')).toBeNull();
    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('does not pop a different screen when the removed route is unfocused', () => {
    render();
    state.focused = false;
    render();
    remove();
    expect(host.querySelector('textarea')).toBeNull();
    expect(state.back).not.toHaveBeenCalled();
    state.focused = true;
    render();
    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('leaves ordinary task removal handling unchanged', () => {
    render(false);
    remove();
    expect(host.querySelector('textarea')).not.toBeNull();
    expect(state.back).not.toHaveBeenCalled();
  });

  it('returns to Home when the removed task has no navigation history', () => {
    state.canGoBack = false;
    render();
    remove();
    expect(state.back).not.toHaveBeenCalled();
    expect(state.replace).toHaveBeenCalledExactlyOnceWith('/');
  });

  // Unit regression 2026-10-24 (#6976 review): preserving the entire task leaked
  // local state and late completions. Exercise the production layout boundary
  // with stateful children; the sidebar must survive while detail is replaced.
  it('keeps sidebar measurement/search nodes while replacing tasks and computers', () => {
    const renderRoute = (sessionId: string, deviceId = 'host') => {
      state.route = { deviceId, sessionId };
      act(() => root.render(<SessionTaskLayout>{() => <textarea aria-label="Message" />}</SessionTaskLayout>));
    };
    renderRoute('child');
    const sidebar = host.querySelector('[aria-label="Sidebar search"]')!;
    let editor = host.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
    for (const [sessionId, deviceId] of [['next', 'host'], ['next', 'other-host'], ['child', 'host']] as const) {
      editor.value = 'old task search';
      renderRoute(sessionId, deviceId);
      expect(host.querySelector('[aria-label="Sidebar search"]')).toBe(sidebar);
      expect(host.querySelector('[aria-label="Message"]')).not.toBe(editor);
      editor = host.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
      expect(editor.value).toBe('');
    }
    expect(state.back).not.toHaveBeenCalled();
  });

  it('isolates busy/error completions when an old task settles after a new operation starts', async () => {
    const pending: { reject(error: Error): void }[] = [];
    function TaskContent() {
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      return <button disabled={busy} onClick={() => {
        setBusy(true);
        void new Promise<void>((_resolve, reject) => pending.push({ reject }))
          .catch(reason => setError(reason.message)).finally(() => setBusy(false));
      }}>{error || (busy ? 'pending' : 'ready')}</button>;
    }
    const renderLayout = () => act(() => root.render(
      <SessionTaskLayout>{() => <TaskContent />}</SessionTaskLayout>,
    ));
    renderLayout();
    act(() => host.querySelector('button')!.click());
    state.route = { deviceId: 'other-host', sessionId: 'child' };
    renderLayout();
    expect(host.querySelector('button')!.disabled).toBe(false);
    act(() => host.querySelector('button')!.click());
    await act(async () => pending[0]!.reject(new Error('old task failed')));
    expect(host.querySelector('button')!.disabled).toBe(true);
    expect(host.textContent).toBe('pending');
    await act(async () => pending[1]!.reject(new Error('current task failed')));
    expect(host.querySelector('button')!.disabled).toBe(false);
    expect(host.textContent).toBe('current task failed');
  });

  it('normalizes old history links before mounting the task contents', () => {
    state.route = { deviceId: 'host', sessionId: 'old', resourceHistorySessionId: 'old', resourceId: 'bot', resourceKind: 'bot', focusClientId: 'message' };
    act(() => root.render(<SessionTaskLayout>{() => <textarea aria-label="Legacy history" />}</SessionTaskLayout>));
    expect(host.querySelector('textarea')).toBeNull();
    expect(state.replaceParams).toHaveBeenCalledWith({ deviceId: 'host', deviceName: 'another computer', sessionId: 'old', focusClientId: 'message' });
  });

  // #7105: a same-ID search hit must exit the companion resource skin, whereas
  // selecting the already-open ordinary row is a no-op. Unit, actual layout consumer.
  it.each([false, true])('handles the current task selected from search=%s', (search) => {
    state.route = { deviceId: 'host', sessionId: 'child', resourceCollectionId: 'teammates', resourceKind: 'bot', resourceId: 'bot' };
    act(() => root.render(<SessionTaskLayout>{() => <textarea />}</SessionTaskLayout>));
    const target = {
      session: { id: 'child', canonicalDeviceId: 'host' },
      ...(search ? { searchLocallyCached: false } : {}),
    } as unknown as RemoteSessionListItem;
    act(() => state.sidebar!.onSelectSession!(target));
    if (search) expect(state.replaceParams).toHaveBeenCalledExactlyOnceWith({
      deviceId: 'host', deviceName: 'another computer', sessionId: 'child',
    });
    else expect(state.replaceParams).not.toHaveBeenCalled();
  });

  it('discards the outgoing attachment scope before sidebar navigation and preserves search focus', () => {
    const order: string[] = [];
    state.replaceParams.mockImplementation(() => order.push('navigate'));
    act(() => root.render(<SessionTaskLayout>{chrome => {
      chrome.beforeSessionSwitchRef.current = () => order.push('discard');
      return <textarea />;
    }}</SessionTaskLayout>));
    const target = {
      session: { id: 'next', canonicalDeviceId: 'canonical-host', deviceLinkDeviceId: 'old-host', deviceLinkDeviceName: 'Mac' },
      searchFocusClientId: 'message-42',
    } as unknown as RemoteSessionListItem;
    act(() => state.sidebar!.onSelectSession!(target));
    expect(order).toEqual(['discard', 'navigate']);
    expect(state.replaceParams).toHaveBeenCalledExactlyOnceWith({
      deviceId: 'canonical-host', deviceName: 'Mac', sessionId: 'next', focusClientId: 'message-42',
    });
  });

  it.each([
    ['next', 'host'],
    ['child', 'other-host'],
  ])('does not carry a hidden deletion into %s on %s', (sessionId, deviceId) => {
    state.focused = false;
    render();
    remove();
    expect(host.querySelector('textarea')).toBeNull();
    state.focused = true;
    render(true, sessionId, deviceId);
    expect(host.querySelector('textarea')).not.toBeNull();
    expect(state.back).not.toHaveBeenCalled();
    remove(deviceId, sessionId);
    expect(host.querySelector('textarea')).toBeNull();
    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('returns once per removed task while ignoring a retired subscription callback', () => {
    render();
    const lateRemoval = [...state.listeners][0]!;
    remove();
    expect(state.back).toHaveBeenCalledTimes(1);
    render(true, 'next');
    const editor = host.querySelector('textarea');
    expect(editor).not.toBeNull();
    act(() => lateRemoval('host', 'child'));
    expect(host.querySelector('textarea')).toBe(editor);
    remove('host', 'next');
    remove('host', 'next');
    expect(state.back).toHaveBeenCalledTimes(2);
    expect(host.querySelector('textarea')).toBeNull();
  });
});
