// @vitest-environment jsdom
import { act, memo, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { homeRowPropsEqual } from '../session/homeRowPropsEqual';
import { ResidentHomeList, ResidentHomeListProvider } from '../session/ResidentHomeList';

const state = vi.hoisted(() => ({
  mode: 'tasks', segments: ['devices'], width: 1000, anchorWidth: 1000, mounts: 0, unmounts: 0,
}));
vi.mock('../session/useHomeMode', () => ({ useHomeMode: () => ({ mode: state.mode }) }));
vi.mock('expo-router', () => ({ useSegments: () => state.segments }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
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
    View: React.forwardRef(({ children, onLayout, ...props }: any, ref) => {
      React.useImperativeHandle(ref, () => ({
        measureLayout: (_: any, callback: any) => callback(0, 80, state.anchorWidth, 720),
      }));
      React.useEffect(() => { onLayout?.(); }, [onLayout]);
      return <div data-pointer={props.pointerEvents}>{children}</div>;
    }),
  };
});
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children, pointerEvents }: any) => <div data-host data-pointer={pointerEvents}>{children}</div> },
}));
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach(root => root.unmount()));
  state.mode = 'tasks'; state.segments = ['devices']; state.width = 1000; state.anchorWidth = 1000;
  state.mounts = 0; state.unmounts = 0;
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

it.each([{ homeSegments: [] }, { homeSegments: ['index'] }, { homeSegments: ['devices'] }, { homeSegments: ['devices', 'index'] }])('keeps task state but hides the resident list in teammate mode on %j', ({ homeSegments }) => {
  state.segments = homeSegments;
  const host = document.createElement('div');
  const root = createRoot(host); roots.push(root);
  const render = (detail = false) => act(() => root.render(<Scene detail={detail} homeSelect={() => {}} detailSelect={() => {}} />));
  render();
  act(() => (host.querySelector('[data-scroll]') as HTMLButtonElement).click());
  state.mode = 'teammates'; render();
  expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('none');
  expect(host.querySelector('[data-subscriptions]')?.getAttribute('data-subscriptions')).toBe('false');
  // An actual task route still owns the upstream persistent sidebar, irrespective of home preference.
  state.segments = ['sessions', '[sessionId]']; render(true);
  expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('box-none');
  state.segments = homeSegments; state.mode = 'tasks'; render();
  expect(host.querySelector('[data-host]')?.getAttribute('data-pointer')).toBe('box-none');
  expect(host.querySelector('[data-select]')?.textContent).toBe('240');
  expect(state.mounts).toBe(1); expect(state.unmounts).toBe(0);
});
