// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SwipeableSessionRow } from '@/session/SwipeableSessionRow';
import { SwipeableProjectHeader } from '@/session/SwipeableProjectHeader.android';
import { createSwipeRowRegistry } from '@/session/swipeRowRegistry';
import type * as SwipeRegistryModule from '@/session/swipeRowRegistry';
import type { SwipeRowRegistry } from '@/session/swipeRowRegistry';
import { PaneEdgeInsetProvider } from '@/session/SessionPaneDivider';
import type { RemoteSession } from '@/session/types';

interface BoundaryTranslation {
  __getValue(): number;
  interpolate(...args: unknown[]): BoundaryTranslation;
  addListener(callback: (event: { value: number }) => void): string;
  removeListener(id: string): void;
}
interface BoundaryProps {
  children?: ReactNode;
  hitSlop?: unknown;
  renderLeftActions(progress: object, translation: BoundaryTranslation): ReactNode;
  renderRightActions(progress: object, translation: BoundaryTranslation): ReactNode;
  onSwipeableOpenStartDrag(): void;
  onSwipeableClose(): void;
  onSwipeableWillOpen(direction: 'left' | 'right'): void;
}

const runtime = vi.hoisted(() => ({
  // The native-boundary mock assigns both values before any render/assertion.
  props: null as unknown as BoundaryProps, release: 0, width: 400,
  translation: null as unknown as BoundaryTranslation,
  listeners: new Map<string, (event: { value: number }) => void>(),
  removed: vi.fn(), stopped: vi.fn(), close: vi.fn(), reset: vi.fn(),
}));
// Keep the UI-to-JS bridge at the native boundary, like the other row fixtures.
vi.mock('react-native-reanimated', () => ({ runOnJS: (fn: unknown) => fn }));
vi.mock('react-native', async () => {
  const { createElement: el } = await import('react');
  const View = ({ children }: { children?: ReactNode }) => el('div', null, children);
  class Value {
    setValue() {}
    stopAnimation() { runtime.stopped(); }
    interpolate() { return this; }
  }
  const node = { interpolate: () => node };
  return {
    View, Pressable: ({ children, testID, onPress, accessibilityLabel }: { children?: ReactNode; testID?: string; onPress?: () => void; accessibilityLabel?: string }) => el('button', { 'data-testid': testID, onClick: onPress, 'aria-label': accessibilityLabel }, children),
    StyleSheet: { create: (value: unknown) => value }, Dimensions: { get: () => ({ width: runtime.width }), addEventListener: () => ({ remove() {} }) },
    Animated: { Value, View, add: () => node, divide: () => node, multiply: () => node,
      subtract: () => node, timing: () => ({ start() {} }) },
  };
});
vi.mock('@/platform/gestureHandler', async () => {
  const { createElement: el, Fragment, forwardRef, useImperativeHandle } = await import('react');
  runtime.translation = {
    __getValue: () => runtime.release,
    interpolate: () => runtime.translation,
    addListener: (callback: (event: { value: number }) => void) => {
      const id = String(runtime.listeners.size + 1);
      runtime.listeners.set(id, callback);
      return id;
    },
    removeListener: (id: string) => { runtime.removed(id); runtime.listeners.delete(id); },
  };
  return { ClassicSwipeable: forwardRef((props: BoundaryProps, ref) => {
    runtime.props = props;
    useImperativeHandle(ref, () => ({ close: runtime.close, reset: runtime.reset }));
    return el(Fragment, null, props.renderLeftActions({}, runtime.translation),
      props.renderRightActions({}, runtime.translation), props.children);
  }) };
});
vi.mock('lucide-react-native', () => Object.fromEntries(
  ['Check', 'Archive', 'ArchiveRestore', 'Ellipsis', 'Pin', 'PinOff', 'List', 'Search', 'SquarePen'].map((name) => [name, () => null]),
));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// Registry ownership is real; locale startup is outside this native-boundary fixture.
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/session/listDisclosureTransition', () => ({ useDisclosurePrepare: () => () => {} }));
vi.mock('@/session/swipeRowRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof SwipeRegistryModule>()),
  pinToggleAction: () => ({ label: 'pin' }), statusToggleAction: () => ({ label: 'archive', action: 'archive' }),
}));
vi.mock('@/theme', () => ({
  iconSize: { swipeAction: 24 }, iconStroke: { regular: 2 },
  useTheme: () => ({ colors: {} }), useThemedStyles: (make: (colors: object) => unknown) => make({}),
}));
vi.mock('@/theme/tokens', () => ({ radius: { pill: 9999 }, spacing: { md: 12, xl: 24 } }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
const controls = {
  onMarkRead: vi.fn(), onArchive: vi.fn(), onTogglePin: vi.fn(), onShowOptions: vi.fn(),
  registry: { onRowOpen: vi.fn(), onRowClose: vi.fn(), closeOpenRow: vi.fn() },
};
function render(id = 'row') {
  act(() => root.render(createElement(SwipeableSessionRow, {
    ...controls, session: { id, status: 'active' } as RemoteSession, testID: 'swipe', children: 'row',
  })));
}
beforeEach(() => {
  vi.clearAllMocks(); runtime.release = 0; runtime.width = 400; runtime.listeners.clear();
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

// Unit: render the production classic row at a mocked native boundary. These
// regressions protect release-position archiving, lazy native trees and disposal;
// the old import/substring/layout checks never invoked a gesture or React cleanup.
describe('classic swipe row lifecycle', () => {
  it.each([
    ['right', -260, -100, false, 'onArchive'],
    ['right', -260, -260, true, 'onArchive'],
    ['left', 260, 100, false, 'onMarkRead'],
    ['left', 260, 260, true, 'onMarkRead'],
  ] as const)('uses release position for %s after peak=%s, end=%s', (direction, peak, end, fires, action) => {
    render();
    expect(runtime.listeners.size).toBe(0);
    expect(host.querySelector('button')).toBeNull();
    act(() => runtime.props.onSwipeableOpenStartDrag());
    expect(runtime.listeners.size).toBe(2);
    expect(host.querySelectorAll('button')).toHaveLength(4);
    act(() => {
      for (const listener of runtime.listeners.values()) listener({ value: peak });
      runtime.release = end;
      runtime.props.onSwipeableWillOpen(direction);
    });
    expect(controls[action]).toHaveBeenCalledTimes(fires ? 1 : 0);
    if (fires) expect(controls[action]).toHaveBeenCalledWith(expect.objectContaining({ id: 'row' }));
    const stoppedBefore = runtime.stopped.mock.calls.length;
    act(() => runtime.props.onSwipeableClose());
    expect(runtime.listeners.size).toBe(0);
    expect(runtime.removed).toHaveBeenCalledTimes(2);
    expect(runtime.stopped.mock.calls.length).toBeGreaterThan(stoppedBefore);
    expect(host.querySelector('button')).toBeNull();
  });

  it('retires listeners and armed animation when a visible row unmounts', () => {
    render();
    act(() => runtime.props.onSwipeableOpenStartDrag());
    const stoppedBefore = runtime.stopped.mock.calls.length;
    act(() => root.render(null));
    expect(runtime.listeners.size).toBe(0);
    expect(runtime.removed).toHaveBeenCalledTimes(2);
    expect(runtime.stopped.mock.calls.length).toBeGreaterThan(stoppedBefore);
    expect(controls.registry.onRowClose).toHaveBeenCalledWith('row');
  });
});

// Unit, #10586: exercise Android's production project entry at the native boundary.
describe('Android project swipe actions', () => {
  let registry: SwipeRowRegistry;
  beforeEach(() => { registry = createSwipeRowRegistry(); });
  function renderProject(projectKey = 'project', edgeInset = 0) {
    const actions = { onNewTask: vi.fn(), onOpenTasks: vi.fn(), onSearch: vi.fn() };
    act(() => root.render(createElement(PaneEdgeInsetProvider, { value: edgeInset },
      createElement(SwipeableProjectHeader, {
        ...actions, projectKey, registry, children: 'header',
      }))));
    return actions;
  }

  it('closes through the registry and ref for each explicit action', () => {
    const actions = renderProject();
    expect(runtime.reset).toHaveBeenCalledOnce();
    const closeTask = vi.fn();
    registry.onRowOpen('task', closeTask);
    act(() => runtime.props.onSwipeableOpenStartDrag());
    expect(closeTask).toHaveBeenCalledOnce();
    expect(registry.closeOpenRow()).toBe(true);
    expect(runtime.close).toHaveBeenCalledOnce();
    runtime.close.mockClear();
    for (const button of host.querySelectorAll('button')) act(() => button.click());
    expect(actions.onOpenTasks).toHaveBeenCalledOnce();
    expect(actions.onSearch).toHaveBeenCalledOnce();
    expect(actions.onNewTask).toHaveBeenCalledOnce();
    expect(runtime.close).toHaveBeenCalledTimes(3);
    expect(registry.closeOpenRow()).toBe(false);
    registry.onRowOpen('newer-task', closeTask);
    act(() => runtime.props.onSwipeableClose());
    act(() => root.render(null));
    expect(registry.closeOpenRow()).toBe(true);
    expect(closeTask).toHaveBeenCalledTimes(2);
  });

  it('resets recycled headers without leaving the previous registration open', () => {
    renderProject();
    act(() => runtime.props.onSwipeableOpenStartDrag());
    runtime.reset.mockClear();
    renderProject('next-project');
    expect(runtime.reset).toHaveBeenCalledOnce();
    expect(registry.closeOpenRow()).toBe(false);
    act(() => runtime.props.onSwipeableOpenStartDrag());
    expect(registry.closeOpenRow()).toBe(true);
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it('uses the resized pane width and reserves its resize hit band', () => {
    renderProject();
    runtime.width = 800;
    const actions = renderProject('project', 24);
    expect(runtime.props.hitSlop).toEqual({ left: -24, right: -24 });
    expect(runtime.reset).toHaveBeenCalledOnce();
    runtime.release = -260;
    act(() => runtime.props.onSwipeableWillOpen('right'));
    expect(actions.onNewTask).not.toHaveBeenCalled();
    runtime.release = -500;
    act(() => runtime.props.onSwipeableWillOpen('right'));
    expect(actions.onNewTask).toHaveBeenCalledOnce();
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it.each([[-260, 'right', true], [-100, 'right', false], [260, 'left', false]] as const)(
    'uses release position %s and classic direction %s for full swipe', (release, direction, fires) => {
      const actions = renderProject();
      runtime.release = release;
      act(() => runtime.props.onSwipeableWillOpen(direction));
      expect(actions.onNewTask).toHaveBeenCalledTimes(fires ? 1 : 0);
      expect(actions.onSearch).not.toHaveBeenCalled();
      expect(actions.onOpenTasks).not.toHaveBeenCalled();
    },
  );
});