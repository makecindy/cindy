// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SwipeableSessionRow } from '@/session/SwipeableSessionRow';
import type { RemoteSession } from '@/session/types';

const runtime = vi.hoisted(() => ({
  props: null as any, release: 0, translation: null as any,
  listeners: new Map<string, (event: { value: number }) => void>(),
  removed: vi.fn(), stopped: vi.fn(), close: vi.fn(), reset: vi.fn(),
}));
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
    View, Pressable: ({ children, testID }: any) => el('button', { 'data-testid': testID }, children),
    StyleSheet: { create: (value: unknown) => value }, useWindowDimensions: () => ({ width: 400 }),
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
  return { ClassicSwipeable: forwardRef((props: any, ref) => {
    runtime.props = props;
    useImperativeHandle(ref, () => ({ close: runtime.close, reset: runtime.reset }));
    return el(Fragment, null, props.renderLeftActions({}, runtime.translation),
      props.renderRightActions({}, runtime.translation), props.children);
  }) };
});
vi.mock('lucide-react-native', () => Object.fromEntries(
  ['Archive', 'ArchiveRestore', 'Ellipsis', 'Pin', 'PinOff'].map((name) => [name, () => null]),
));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/session/listDisclosureTransition', () => ({ useDisclosurePrepare: () => () => {} }));
vi.mock('@/session/swipeRowRegistry', () => ({
  pinToggleAction: () => ({ label: 'pin' }), statusToggleAction: () => ({ label: 'archive', action: 'archive' }),
}));
vi.mock('@/theme', () => ({
  iconSize: { swipeAction: 24 }, iconStroke: { regular: 2 },
  useTheme: () => ({ colors: {} }), useThemedStyles: (make: (colors: object) => unknown) => make({}),
}));
vi.mock('@/theme/tokens', () => ({ radius: { pill: 9999 }, spacing: { md: 12 } }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
const controls = {
  onArchive: vi.fn(), onTogglePin: vi.fn(), onShowOptions: vi.fn(),
  registry: { onRowOpen: vi.fn(), onRowClose: vi.fn(), closeOpenRow: vi.fn() },
};
function render(id = 'row') {
  act(() => root.render(createElement(SwipeableSessionRow, {
    ...controls, session: { id, status: 'active' } as RemoteSession, testID: 'swipe', children: 'row',
  })));
}
beforeEach(() => {
  vi.clearAllMocks(); runtime.release = 0; runtime.listeners.clear();
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
    ['left', 260, 100, false, 'onTogglePin'],
    ['left', 260, 260, true, 'onTogglePin'],
  ] as const)('uses release position for %s after peak=%s, end=%s', (direction, peak, end, fires, action) => {
    render();
    expect(runtime.listeners.size).toBe(0);
    expect(host.querySelector('button')).toBeNull();
    act(() => runtime.props.onSwipeableOpenStartDrag());
    expect(runtime.listeners.size).toBe(2);
    expect(host.querySelectorAll('button')).toHaveLength(3);
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