// @vitest-environment jsdom
import { act, memo, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
import { homeRowPropsEqual } from '../session/homeRowPropsEqual';
import { ResidentHomeList, ResidentHomeListProvider, useResidentHomeList, useSessionPaneLayout } from '../session/ResidentHomeList';

const state = vi.hoisted(() => ({
  pan: {} as Record<string, (...args: any[]) => any>, divider: null as any,
  deferMeasure: false, measurements: [] as (() => void)[],
  platform: 'android', reduceMotion: true, segments: ['devices'], width: 1000, anchorWidth: 1000, mounts: 0, unmounts: 0,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: { textSecondary: 'gray', borderStrong: 'gray' } }) }));
vi.mock('expo-router', () => ({ useSegments: () => state.segments }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => state.reduceMotion }));
vi.mock('@/platform/AdaptiveWindowContext', () => ({ useAdaptiveWindow: () => ({
  width: state.width, height: 800, regularWidth: true, regularHeight: true,
  barEdge: 'right', insets: { top: 0, bottom: 0, left: 0, right: 80 },
  regions: [], reservedRegionsSupported: false,
}) }));
vi.mock('../session/remoteSessionStore', () => ({
  RemoteSessionStoreSubscriptionGate: ({ children, enabled }: any) => <div data-subscriptions={enabled}>{children}</div>,
}));
vi.mock('react-native', async () => {
  const React = await import('react');
  return {
    StyleSheet: { create: (v: any) => v },
    Platform: { get OS() { return state.platform; } },
    PanResponder: { create: (handlers: any) => { state.pan = handlers; return { panHandlers: {} }; } },
    View: React.forwardRef(({ children, onLayout, ...props }: any, ref) => {
      if (props.testID === 'session.paneDivider') state.divider = props;
      React.useImperativeHandle(ref, () => ({
        measureLayout: (_: any, callback: any) => callback(0, 80, state.anchorWidth, 720),
        measureInWindow: (callback: any) => {
          const measure = () => callback(0, 80, state.anchorWidth, 720);
          if (state.deferMeasure) state.measurements.push(measure); else measure();
        },
      }));
      React.useEffect(() => { onLayout?.(); }, [onLayout]);
      return <div data-pointer={props.pointerEvents} data-testid={props.testID}>{children}</div>;
    }),
  };
});
vi.mock('react-native-reanimated', () => ({ default: { View: ({ children, pointerEvents, style }: any) =>
  <div data-host data-pointer={pointerEvents} data-opacity={Object.assign({}, ...[style].flat()).opacity}>{children}</div> } }));
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach(root => root.unmount()));
  state.platform = 'android'; state.reduceMotion = true; state.segments = ['devices']; state.width = 1000; state.anchorWidth = 1000;
  state.mounts = 0; state.unmounts = 0;
  state.deferMeasure = false; state.measurements = [];
  state.divider = null; state.pan = {};
});

// Unit regression: new-task routes must keep the existing sidebar usable. Older
// coverage only visited [sessionId]; a wide /sessions/new was hidden with its
// subscriptions paused. Exercise the real provider through creation and resize.
it.each(['ios', 'android'])('keeps the sidebar active through new task → created task on %s', platform => {
  state.platform = platform;
  state.segments = ['sessions', 'new'];
  const host = document.createElement('div'), root = createRoot(host); roots.push(root);
  const select = vi.fn();
  const render = () => act(() => root.render(<Scene detail homeSelect={select} detailSelect={select} />));
  render();
  expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('box-none');
  expect(host.querySelector('[data-subscriptions]')?.getAttribute('data-subscriptions')).toBe('true');
  expect(host.querySelector('[data-testid="session.paneDivider"]')).not.toBeNull();
  act(() => (host.querySelector('[data-scroll]') as HTMLButtonElement).click());
  const list = host.querySelector('[data-select]');
  state.segments = ['sessions', '[sessionId]']; render();
  expect(host.querySelector('[data-select]')).toBe(list);
  expect(list?.textContent).toBe('240');
  state.segments = ['sessions', 'new']; state.width = 430; render();
  expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('none');
  expect(host.querySelector('[data-subscriptions]')?.getAttribute('data-subscriptions')).toBe('false');
  expect(host.querySelector('[data-testid="session.paneDivider"]')).toBeNull();
  state.width = 1000; render();
  expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('box-none');
  expect(host.querySelector('[data-select]')).toBe(list);
  act(() => (list as HTMLButtonElement).click());
  expect(select).toHaveBeenCalledOnce();
});

// Unit: real divider handlers + provider layout. User's 2026-10-23 request adds
// live bounded resizing; previous resident-list tests never drove a divider.
it('drags both panes together, clamps the bounds and retains width through route and orientation changes', () => {
  state.platform = 'ios'; state.segments = ['sessions', '[sessionId]'];
  let layout: ReturnType<typeof useSessionPaneLayout>;
  function Probe() {
    layout = useSessionPaneLayout();
    state.anchorWidth = layout.sidebarWidth;
    return <><div data-detail={layout.detail.x} />
      <ResidentHomeList focused top={80} left={0} right={0}><ListProbe onSelect={() => {}} /></ResidentHomeList>
    </>;
  }
  const host = document.createElement('div'), root = createRoot(host); roots.push(root);
  const render = (key: string) => act(() => root.render(<ResidentHomeListProvider><Probe key={key} /></ResidentHomeListProvider>));
  render('task-a');
  const list = host.querySelector('[data-select]');
  act(() => (host.querySelector('[data-scroll]') as HTMLButtonElement).click());
  expect(state.pan.onMoveShouldSetPanResponder(null, { dx: 2, dy: 20 })).toBe(false);
  expect(state.pan.onMoveShouldSetPanResponder(null, { dx: 8, dy: 1 })).toBe(true);
  const start = layout!.sidebarWidth;
  act(() => state.pan.onPanResponderGrant());
  act(() => state.pan.onPanResponderMove(null, { dx: 360 - start }));
  expect(layout!.sidebarWidth).toBe(360);
  expect(layout!.detail.x).toBe(360);
  act(() => state.pan.onPanResponderRelease(null, { dx: 1000 }));
  expect(layout!.sidebarWidth).toBe(420);
  render('task-b'); expect(layout!.sidebarWidth).toBe(420);
  state.width = 669; render('task-b');
  expect(layout!.persistent).toBe(false);
  expect(host.querySelector('[data-testid="session.paneDivider"]')).toBeNull();
  state.width = 1000; render('task-b'); expect(layout!.sidebarWidth).toBe(420);
  act(() => state.pan.onPanResponderGrant());
  act(() => state.pan.onPanResponderMove(null, { dx: -1000 }));
  expect(layout!.sidebarWidth).toBe(240);
  act(() => state.pan.onPanResponderTerminate());
  expect(layout!.sidebarWidth).toBe(420);
  act(() => state.divider.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } }));
  expect(layout!.sidebarWidth).toBe(396);
  expect(host.querySelector('[data-select]')).toBe(list);
  expect(list?.textContent).toBe('240');
  expect(state.mounts).toBe(1);
  expect(state.unmounts).toBe(0);
});
const ListProbe = memo(function ListProbe({ onSelect }: { onSelect(): void }) {
  const [position, setPosition] = useState(0);
  useEffect(() => { state.mounts++; return () => { state.unmounts++; }; }, []);
  return <><button data-scroll onClick={() => setPosition(240)}>scroll</button>
    <button data-select onClick={onSelect}>{position}</button></>;
}, homeRowPropsEqual);
function Scene({ detail, homeSelect, detailSelect }: any) {
  return <ResidentHomeListProvider>
    <ResidentHomeList focused={!detail} top={80} left={0} right={0}>
      <ListProbe onSelect={homeSelect} />
    </ResidentHomeList>
    {detail ? <ResidentHomeList focused top={80} left={0} right={0}>
      <ListProbe onSelect={detailSelect} />
    </ResidentHomeList> : null}
  </ResidentHomeListProvider>;
}
it.each([{ homeSegments: [] }, { homeSegments: ['index'] }, { homeSegments: ['devices'] }])('keeps one visible list through home %j → detail → home, while switching actions', ({ homeSegments }) => {
  state.segments = homeSegments;
  const host = document.createElement('div');
  const root = createRoot(host); roots.push(root);
  const homeSelect = vi.fn(), detailSelect = vi.fn();
  const render = (detail: boolean) => act(() => root.render(<Scene {...{ detail, homeSelect, detailSelect }} />));
  render(false);
  expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('box-none');
  expect(host.querySelector('[data-subscriptions]')?.getAttribute('data-subscriptions')).toBe('true');
  act(() => (host.querySelector('[data-scroll]') as HTMLButtonElement).click());
  state.segments = ['sessions', '[sessionId]']; state.anchorWidth = 320;
  render(true);
  expect(host.querySelectorAll('[data-select]')).toHaveLength(1);
  expect(host.querySelector('[data-select]')?.textContent).toBe('240');
  act(() => (host.querySelector('[data-select]') as HTMLButtonElement).click());
  expect(detailSelect).toHaveBeenCalledOnce(); expect(homeSelect).not.toHaveBeenCalled();
  state.segments = homeSegments; state.anchorWidth = 1000;
  render(false);
  expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('box-none');
  expect(host.querySelector('[data-select]')?.textContent).toBe('240');
  expect(state.mounts).toBe(1); expect(state.unmounts).toBe(0);
});
it('hides the resident list and pauses row subscriptions on other routes without destroying it', () => {
  const host = document.createElement('div');
  const root = createRoot(host); roots.push(root);
  const render = () => act(() => root.render(<Scene detail={false} homeSelect={() => {}} />));
  render();
  state.segments = ['settings']; render();
  expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('none');
  expect(host.querySelector('[data-subscriptions]')?.getAttribute('data-subscriptions')).toBe('false');
  expect(state.mounts).toBe(1); expect(state.unmounts).toBe(0);
});

// Regression: Duo portrait → landscape briefly removed the task list while its
// new host waited for native measurements. Existing tests only switched routes
// at a fixed wide size. Exercise the real provider/slot (unit tier), preserving
// visible content and component state even while measurements are outstanding.
it.each([669, 951])('keeps the home list mounted across rotation, starting at width %i', (width) => {
  const host = document.createElement('div'); const root = createRoot(host); roots.push(root);
  const render = () => act(() => root.render(<Scene detail={false} homeSelect={() => {}} />));
  state.width = width; render();
  expect(host.querySelector('[data-scroll]')).not.toBeNull();
  act(() => (host.querySelector('[data-scroll]') as HTMLButtonElement).click());
  for (const next of [951, 669, 951, 430, 669]) {
    state.deferMeasure = true; state.width = next; state.anchorWidth = next;
    render();
    expect(host.querySelector('[data-select]')?.textContent).toBe('240');
    expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('box-none');
    act(() => { while (state.measurements.length) state.measurements.shift()!(); });
    expect(state.mounts).toBe(1); expect(state.unmounts).toBe(0);
  }
});

it('hides the retained home list on a narrow task route, then reuses it on return', () => {
  const host = document.createElement('div'); const root = createRoot(host); roots.push(root);
  const render = () => act(() => root.render(<Scene detail={false} homeSelect={() => {}} />));
  render();
  act(() => (host.querySelector('[data-scroll]') as HTMLButtonElement).click());
  state.width = 669; state.segments = ['sessions', '[sessionId]']; render();
  expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('none');
  expect(host.querySelector('[data-subscriptions]')?.getAttribute('data-subscriptions')).toBe('false');
  state.segments = ['devices']; render();
  expect(host.querySelector('[data-select]')?.textContent).toBe('240');
  expect(state.mounts).toBe(1); expect(state.unmounts).toBe(0);
});

it('keeps iOS home inside its native route at every width, while only persistent drawers use the root host', () => {
  state.platform = 'ios';
  function Owners() {
    const home = useResidentHomeList();
    const drawer = useResidentHomeList(true);
    return <div data-home={home.enabled} data-drawer={drawer.enabled} />;
  }
  const host = document.createElement('div'); const root = createRoot(host); roots.push(root);
  const render = () => act(() => root.render(<ResidentHomeListProvider><Owners /></ResidentHomeListProvider>));
  for (const width of [669, 951, 430]) {
    state.width = width; render();
    expect(host.querySelector('[data-home]')?.getAttribute('data-home')).toBe('false');
    expect(host.querySelector('[data-drawer]')?.getAttribute('data-drawer')).toBe(String(width === 951));
  }
  act(() => root.render(<Owners />));
  expect(host.querySelector('[data-home]')?.getAttribute('data-home')).toBe('false');
});

// The previous rotation test only checked mount counts in the root host. UIKit
// needs the covered HOME ROUTE to still contain its list before JS focus changes
// during interactive back. This unit test covers ownership; device video covers
// the native transition itself.
it('keeps the scrolled iOS home list in the covered route through rotation and back', () => {
  state.platform = 'ios';
  function HomeRoute({ focused }: { focused: boolean }) {
    const resident = useResidentHomeList();
    const list = <ListProbe onSelect={() => {}} />;
    return <section data-home-route>{resident.enabled
      ? <ResidentHomeList focused={focused} top={80} left={0} right={0}>{list}</ResidentHomeList>
      : list}</section>;
  }
  const host = document.createElement('div'); const root = createRoot(host); roots.push(root);
  const render = (focused: boolean) => act(() => root.render(
    <ResidentHomeListProvider><HomeRoute focused={focused} /></ResidentHomeListProvider>,
  ));
  render(true);
  const list = host.querySelector('[data-home-route] [data-select]');
  expect(list).not.toBeNull();
  act(() => (host.querySelector('[data-scroll]') as HTMLButtonElement).click());
  for (const width of [669, 951, 430, 951]) {
    state.width = width; render(true);
    expect(host.querySelector('[data-home-route] [data-select]')).toBe(list);
    state.segments = ['sessions', '[sessionId]']; render(false);
    expect(host.querySelector('[data-home-route] [data-select]')).toBe(list);
    expect(list?.textContent).toBe('240');
    state.segments = []; render(true);
    expect(host.querySelector('[data-home-route] [data-select]')).toBe(list);
  }
  expect(state.mounts).toBe(1); expect(state.unmounts).toBe(0);
});

it('does not draw the retained iOS sidebar over home during return', () => {
  state.platform = 'ios';
  state.segments = ['sessions', '[sessionId]'];
  const host = document.createElement('div'); const root = createRoot(host); roots.push(root);
  const render = () => act(() => root.render(<Scene detail homeSelect={() => {}} detailSelect={() => {}} />));
  render();
  expect(host.querySelector('[data-host]')?.getAttribute('data-opacity')).toBe('1');
  state.segments = []; render();
  expect(host.querySelector('[data-host]')?.getAttribute('data-opacity')).toBe('0');
  expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('none');
});

// Unit regression #6902: earlier return coverage kept the drawer owner mounted.
// Real iOS back unmounts it; entering another task must not expose its old actions
// while the next drawer waits for measurement, or resurrect it from a late one.
it('revokes an unmounted iOS drawer while the next task waits for measurement', () => {
  state.platform = 'ios'; state.segments = ['sessions', '[sessionId]'];
  const host = document.createElement('div'), root = createRoot(host); roots.push(root);
  const oldSelect = vi.fn(), nextSelect = vi.fn();
  const render = (task: string | null) => act(() => root.render(<ResidentHomeListProvider>
    {task ? <ResidentHomeList key={task} focused top={80} left={0} right={0}>
      <ListProbe onSelect={task === 'old' ? oldSelect : nextSelect} />
    </ResidentHomeList> : null}
  </ResidentHomeListProvider>));
  render('old');
  expect(host.querySelector('[data-select]')).not.toBeNull();
  state.deferMeasure = true; render('old');
  state.segments = []; render(null);
  act(() => { while (state.measurements.length) state.measurements.shift()!(); });
  state.segments = ['sessions', '[sessionId]']; render('next');
  expect(host.querySelector('[data-select]')).toBeNull();
  act(() => { while (state.measurements.length) state.measurements.shift()!(); });
  act(() => (host.querySelector('[data-select]') as HTMLButtonElement).click());
  expect(nextSelect).toHaveBeenCalledOnce(); expect(oldSelect).not.toHaveBeenCalled();
});

it('keeps the new drawer entry when an older retained owner unmounts later', () => {
  state.platform = 'ios'; state.segments = ['sessions', '[sessionId]'];
  const host = document.createElement('div'), root = createRoot(host); roots.push(root);
  const oldSelect = vi.fn(), nextSelect = vi.fn();
  const render = (old: boolean, next: boolean) => act(() => root.render(<ResidentHomeListProvider>
    {old ? <ResidentHomeList key="old" focused={!next} top={80} left={0} right={0}>
      <ListProbe onSelect={oldSelect} />
    </ResidentHomeList> : null}
    {next ? <ResidentHomeList key="next" focused top={80} left={0} right={0}>
      <ListProbe onSelect={nextSelect} />
    </ResidentHomeList> : null}
  </ResidentHomeListProvider>));
  render(true, false); render(true, true);
  const list = host.querySelector('[data-select]');
  render(false, true);
  expect(host.querySelector('[data-select]')).toBe(list);
  act(() => (list as HTMLButtonElement).click());
  expect(nextSelect).toHaveBeenCalledOnce(); expect(oldSelect).not.toHaveBeenCalled();
});
