// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createContext, useEffect, useImperativeHandle, useState, type ReactNode, type Ref } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
const state = vi.hoisted(() => ({ focused: true, onTask: true, width: 390, height: 844, native: false, upgrade: false }));
vi.mock('@/session/NativeResidentHistory', () => {
  const Host = ({ children, surfaceId }: { children: ReactNode; surfaceId: string }) => <div data-host={surfaceId}>{children}</div>;
  const Slot = ({ surfaceId, selected }: { surfaceId: string; selected: boolean }) => <div data-slot={surfaceId} data-selected={selected} />;
  return { get NativeHistoryHost() { return state.native ? Host : null; },
    get NativeHistorySlot() { return state.native ? Slot : null; },
    get needsResidentHistoryUpgrade() { return state.upgrade; } };
});
vi.mock('expo-router', () => ({ useSegments: () => state.onTask ? ['sessions', '[sessionId]'] : ['index'] }));
vi.mock('expo-router/react-navigation', () => ({ useIsFocused: () => state.focused,
  NavigationContext: createContext(null), NavigationRouteContext: createContext(null) }));
vi.mock('@/platform/AdaptiveWindowContext', () => ({
  usePaneViewport: () => ({ width: state.width, height: state.height }),
  PaneViewportProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children, pointerEvents, accessibilityElementsHidden, ref, style, onLayout }: {
    children: ReactNode; pointerEvents?: string; accessibilityElementsHidden?: boolean; ref: Ref<unknown>; style?: unknown; onLayout?: () => void;
  }) => {
    useImperativeHandle(ref, () => ({ measureInWindow: (fn: (...args: number[]) => void) => fn(0, 0, state.width, state.height) }));
    useEffect(() => { onLayout?.(); }, [onLayout]);
    return <div data-input={pointerEvents} aria-hidden={accessibilityElementsHidden} data-layout={JSON.stringify(style)}>{children}</div>;
  },
}));
import { RecentMessageHistories, RecentMessageHistoriesProvider, MessageHistoryOverlay, useMessageHistoryActive, useMessageHistoryPositioning } from '@/session/RecentMessageHistories';
import { recentTaskKey, rememberRecentTask } from '@/session/recentTasks';
const key = (id: string) => recentTaskKey({ deviceId: 'pc', sessionId: id });
const remember = (id: string) => rememberRecentTask({ pathname: '/sessions/[sessionId]', params: { deviceId: 'pc', deviceName: 'PC', sessionId: id } });

describe('resident five-task message lists outside route lifetimes', () => {
  let root: Root;
  let container: HTMLDivElement;
  const mounts = new Map<string, number>();
  const unmounts: string[] = [];
  function History({ id, text }: { id: string; text: string }) {
    const active = useMessageHistoryActive();
    const positioning = useMessageHistoryPositioning();
    const [position, setPosition] = useState(0);
    useEffect(() => {
      mounts.set(id, (mounts.get(id) ?? 0) + 1);
      return () => { unmounts.push(id); };
    }, [id]);
    return <button data-task={id} data-active={active} data-positioning={positioning} onClick={() => setPosition(420)}>{text}:{position}</button>;
  }
  async function show(id: string | null, text = id ?? '', ready = true) {
    state.onTask = id !== null;
    await act(async () => {
      if (id) remember(id);
      root.render(<RecentMessageHistoriesProvider>{id ?
        <RecentMessageHistories key={id} activeKey={key(id)} ready={ready} topInset={ready ? 90 : 0} bottomInset={ready ? 80 : 0}>
          <History id={id} text={text} />
        </RecentMessageHistories> : <p>Home</p>}
      </RecentMessageHistoriesProvider>);
    });
  }
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    setMobileAuthOwner(null); setMobileAuthOwner('one'); state.focused = true; state.onTask = true;
    state.width = 390; state.height = 844;
    state.native = false; state.upgrade = false;
    mounts.clear(); unmounts.length = 0;
    container = document.createElement('div'); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); });
  it('keeps the exact list instance after its route is destroyed, then publishes fresh props', async () => {
    await show('a');
    const original = container.querySelector<HTMLButtonElement>('[data-task="a"]')!;
    await act(async () => original.click());
    await show(null);
    expect(original.dataset.active).toBe('false');
    expect(original.dataset.positioning).toBe('false');
    expect(unmounts).toEqual([]);
    await show('b'); await show(null); await show('a', 'updated');
    expect(container.querySelector('[data-task="a"]')).toBe(original);
    expect(original.textContent).toBe('updated:420');
    expect(mounts.get('a')).toBe(1);
  });
  it('resizes the same list on rotation without changing its state', async () => {
    await show('a');
    const original = container.querySelector<HTMLButtonElement>('button')!;
    await act(async () => original.click());
    state.width = 844; state.height = 390; await show('a');
    expect(container.querySelector('button')).toBe(original);
    expect(original.textContent).toBe('a:420');
    expect(original.closest('[data-layout*="844"]')).not.toBeNull();
    expect(mounts.get('a')).toBe(1);
  });
  it('keeps native-host children when route slots disappear and reconnects the same surface', async () => {
    state.native = true;
    await show('a');
    const original = container.querySelector<HTMLButtonElement>('[data-task="a"]')!;
    const host = container.querySelector('[data-host]');
    const surface = host?.getAttribute('data-host');
    expect(container.querySelector('[data-slot]')?.getAttribute('data-slot')).toBe(surface);
    await act(async () => original.click());
    await show(null);
    expect(container.querySelector('[data-slot]')).toBeNull();
    expect(container.querySelector('[data-host]')).toBe(host);
    await show('b'); await show('a');
    expect(container.querySelector('[data-task="a"]')).toBe(original);
    expect(original.textContent).toBe('a:420');
    expect(container.querySelector('[data-slot]')?.getAttribute('data-slot')).toBe(surface);
    expect(unmounts).toEqual([]);
  });
  it('keeps old iOS binaries route-local instead of blocking native gestures with an overlay', async () => {
    state.upgrade = true;
    await show('a'); await show(null);
    expect(container.querySelector('button')).toBeNull();
    expect(unmounts).toEqual(['a']);
  });
  it('shows cached native content before new route data and chrome are ready', async () => {
    state.native = true;
    await show('a', 'cached');
    const original = container.querySelector<HTMLButtonElement>('[data-task="a"]')!;
    await act(async () => original.click());
    await show('b'); await show(null); await show('a', 'loading', false);
    expect(container.querySelector('[data-slot]')?.getAttribute('data-selected')).toBe('true');
    expect(container.querySelector('[data-task="a"]')).toBe(original);
    expect(original.textContent).toBe('cached:420');
    expect(original.dataset.positioning).toBe('false');
    expect(unmounts).toEqual([]);
    await show('a', 'fresh');
    expect(original.textContent).toBe('fresh:420');
    expect(mounts.get('a')).toBe(1);
  });
  it('evicts only the least recently used task when opening a sixth', async () => {
    for (const id of ['a','b','c','d','e','a','f']) await show(id);
    expect(unmounts).toEqual(['b']);
    expect(container.querySelectorAll('button')).toHaveLength(5);
    await show('b'); expect(mounts.get('b')).toBe(2);
  });
  it('pauses hidden lists and disables their input/accessibility without removing them', async () => {
    await show('a'); await show(null);
    const original = container.querySelector<HTMLButtonElement>('button')!;
    expect(original.dataset.active).toBe('false');
    expect(original.closest('[data-input="none"]')).not.toBeNull();
    expect(original.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(unmounts).toEqual([]);
  });
  it('does not replace retained content with a new route loading shell', async () => {
    await show('a', 'cached'); await show(null); await show('a', 'loading', false);
    const original = container.querySelector<HTMLButtonElement>('button')!;
    expect(original.textContent).toBe('cached:0');
    expect(original.dataset.active).toBe('false');
    expect(original.parentElement?.parentElement?.getAttribute('data-layout')).toContain('\"top\":90');
    expect(original.closest('[data-input="none"]')).not.toBeNull();
    await show('a', 'fresh'); expect(original.textContent).toBe('fresh:0');
  });
  it('keeps route drawers above the retained list and removes them on route exit', async () => {
    await show('a');
    await act(async () => root.render(<RecentMessageHistoriesProvider>
      <MessageHistoryOverlay><button data-drawer="true">Drawer</button></MessageHistoryOverlay>
    </RecentMessageHistoriesProvider>));
    const nodes = container.querySelectorAll('button');
    expect(nodes[0]?.dataset.task).toBe('a');
    expect(nodes[1]?.dataset.drawer).toBe('true');
    await show(null);
    expect(container.querySelector('[data-drawer]')).toBeNull();
    expect(container.querySelector('[data-task="a"]')).not.toBeNull();
  });
  it('does not keep the old route preloading mechanism alongside the resident host', () => {
    const home = readFileSync(resolve(process.cwd(), 'src/session/HomeSurface.tsx'), 'utf8');
    expect(home).not.toContain('useRecentTaskPreload');
    expect(home).not.toContain('router.prefetch');
    const layout = readFileSync(resolve(process.cwd(), 'app/_layout.tsx'), 'utf8');
    // Source structure is independent of checkout line endings.
    for (const source of [layout.replace(/\r\n/g, '\n'), layout.replace(/\r?\n/g, '\r\n')]) {
      const provider = source.indexOf('<RecentMessageHistoriesProvider>');
      const stack = source.search(/<Stack\s/);
      expect(provider).toBeGreaterThanOrEqual(0);
      expect(stack).toBeGreaterThan(provider);
    }
  });
  it('clears all instances at an account boundary', async () => {
    await show('a'); await show('b');
    await act(async () => setMobileAuthOwner('two'));
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(unmounts).toEqual(['a','b']);
  });
});
