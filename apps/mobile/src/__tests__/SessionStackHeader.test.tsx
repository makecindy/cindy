// @vitest-environment jsdom
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Unit regression for the 2026-11-12 StackToolbarHeader update-depth crash.
// Production headers run against a navigator boundary that registers options in
// layout effects, renders them outside the page, and rerenders the page on changes.
// The old option-identity test did not exercise that feedback or press buttons.
// Minimal failure: mounting a header in a stateful route with inline callbacks.
// This file separately covers real state/visibility changes and task-switch presses.
// SwiftUI/RN primitives are DOM adapters; the iOS title/actions implementation is real.
// Standalone vitest run: 0.875s on 2026-11-12 (6 cases, no real waits/network).
const h = vi.hoisted(() => ({ registrations: 0, dark: false, language: 'en', barEdge: 'top',
  nativePresses: new Map<string, () => void>(),
}));
type Options = { left?: ReactNode; right?: ReactNode; headerTitle?: (() => ReactNode) | string; headerTintColor?: string };
const Registry = createContext<(key: symbol, value?: Options) => void>(() => {});
function useOptions(options: Options) {
  const key = useRef(Symbol()).current;
  const update = useContext(Registry);
  useLayoutEffect(() => { update(key, options); return () => update(key); }, [key, options, update]);
}
function Toolbar({ children, placement }: { children?: ReactNode; placement: string }) {
  useOptions(useMemo(() => ({ [placement]: children }), [children, placement]));
  return null;
}
function Button({ accessibilityLabel, onPress, disabled, icon }: any) {
  h.nativePresses.set(accessibilityLabel, onPress);
  return <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress} data-icon={typeof icon === 'string' ? icon : undefined} />;
}
function Box({ children, testID, style }: any) { return <div data-testid={testID} style={style}>{children}</div>; }
vi.mock('expo-router', () => ({ Stack: {
  Screen: ({ options }: { options: Options }) => { useOptions(options); return null; },
  Toolbar: Object.assign(Toolbar, { Button, View: Box }),
} }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, View: Box, StyleSheet: { create: (value: unknown) => value },
  Pressable: ({ children, onPress, disabled, testID }: any) => <div data-testid={testID} onClick={disabled ? undefined : onPress}>{children}</div>,
}));
vi.mock('lucide-react-native', () => ({ Menu: () => null, Folder: () => null, Monitor: () => null,
  Smartphone: () => null, Pin: () => <span data-testid="pin" />,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => `${h.language}:${key}` }) }));
vi.mock('@/theme', async () => ({ ...await import('@/theme/tokens'),
  useTheme: () => ({ mode: h.dark ? 'dark' : 'light', colors: { textPrimary: h.dark ? 'white' : 'black' } }),
}));
vi.mock('@/platform/AdaptiveWindowContext', () => ({ useAdaptiveWindow: () => ({ barEdge: h.barEdge }) }));
vi.mock('@/session/HomeHeaderGlassButton', () => ({ HomeHeaderGlassButton: Button }));
vi.mock('@/session/SessionHeaderNativeControls', () => import('@/session/SessionHeaderNativeControls.ios'));
vi.mock('@/components/AppText', () => ({ Text: ({ children, testID }: any) => <span data-testid={testID}>{children}</span> }));
vi.mock('@/components/QuietSyncIndicator', () => ({ QuietSyncIndicator: ({ active }: any) => active ? <span data-testid="syncing" /> : null }));
vi.mock('@/session/TaskTags', () => ({ TaskTagDots: ({ tags, onPress }: any) =>
  <button aria-label="tags" onClick={onPress}>{tags?.map((tag: any) => tag.name).join(',')}</button> }));
vi.mock('@/session/BlurBackdrop', () => ({ BlurBackdrop: () => null, FLOATING_CHROME_BLUR_INTENSITY: 0 }));
vi.mock('@/platform/chrome/nativeGlassButtonStyle.ios', () => ({ useNativeGlassGroupStyle: () => [] }));
vi.mock('@/platform/chrome/NativeChromeBackButton.ios', () => ({ NativeChromeBackButton: ({ label, onPress }: any) =>
  <Button accessibilityLabel={label} onPress={onPress} /> }));
vi.mock('@expo/ui', () => ({ Host: Box }));
vi.mock('@expo/ui/swift-ui', () => ({
  HStack: Box, VStack: Box, RNHostView: Box, Mask: Object.assign(Box, { Content: Box }), Rectangle: () => null,
  Button: ({ onPress, modifiers, label, children }: any) => <button onClick={onPress}
    aria-label={modifiers.find((m: any) => m.accessibilityLabel)?.accessibilityLabel ?? label}
    title={modifiers.find((m: any) => m.accessibilityHint)?.accessibilityHint}
    disabled={modifiers.some((m: any) => m.disabled)}>{children}</button>,
}));
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ...Object.fromEntries(['accessibilityHint', 'accessibilityElement', 'accessibilityLabel', 'background',
    'buttonStyle', 'contentShape', 'disabled', 'frame', 'foregroundStyle', 'labelStyle'].map(name => [name, (value: unknown) => ({ [name]: value })])),
  shapes: { rectangle: () => ({}) },
}));

import { SessionStackActions, SessionStackHeader } from '@/session/SessionStackHeader';
import { SystemNavigationBack } from '@/platform/chrome/SystemNavigationBack';

function Navigator({ page }: { page: () => ReactNode }) {
  const [entries, setEntries] = useState(new Map<symbol, Options>());
  const update = useMemo(() => (key: symbol, options?: Options) => {
    if (options) h.registrations++;
    setEntries(previous => {
      const next = new Map(previous);
      if (options) next.set(key, options); else next.delete(key);
      return next;
    });
  }, []);
  return <Registry.Provider value={update}>{page()}
    <nav>{[...entries.values()].map((options, index) => <div key={index} data-tint={options.headerTintColor}>
      {typeof options.headerTitle === 'function' ? options.headerTitle() : null}{options.left}{options.right}
    </div>)}</nav>
  </Registry.Provider>;
}
beforeEach(() => { h.registrations = 0; h.dark = false; h.language = 'en'; h.barEdge = 'top'; h.nativePresses.clear(); });
afterEach(cleanup);
const names = {
  desktop: 'en:remoteDesktop.title', files: 'en:session.presentation.overview.actions.files.a11y',
  details: 'en:session.menu.details', back: 'en:shared.back', list: 'en:home.drawer.openA11y',
};
const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
function setup(horizontal: boolean) {
  let task = 'A';
  let available = true, detailsOnly = false, filesDisabled = false, live = false, list = true;
  let title = 'Task', notice: string | null = null, tag = 'Tag', pinned = false, syncing = false, rename = true;
  const actions: string[] = [];
  const page = () => {
    // Capture the task like the actual route callbacks: the registered buttons
    // must call this render's task even when their visual configuration is equal.
    const current = task;
    const action = (name: string) => () => { actions.push(`${current}:${name}`); };
    const props = { available, detailsOnly, filesDisabled,
      screen: live ? { label: 'Live screen', onPress: action('live') } : undefined,
      onFiles: action('files'), onDetails: action('details'), onDesktop: action('desktop') };
    return horizontal ? <SessionStackHeader {...props} titleMaxWidth={240} title={title}
      tags={[{ id: 'tag', name: tag, color: 'red', favoriteOrder: null, revision: 1 }]}
      notice={notice} pinned={pinned} syncing={syncing} syncingImmediately={false}
      onTagsPress={action('tags')} onTitleDoubleTap={rename ? action('rename') : undefined}
      onBack={action('back')} onOpenSessionList={list ? action('list') : undefined} />
      : <SessionStackActions {...props} />;
  };
  const view = render(<Navigator page={page} />);
  return { actions, view, refresh() { view.rerender(<Navigator page={page} />); },
    change(next: Partial<{ task: string; available: boolean; detailsOnly: boolean; filesDisabled: boolean; live: boolean; list: boolean;
      title: string; notice: string | null; tag: string; pinned: boolean; syncing: boolean; rename: boolean }>) {
      task = next.task ?? task; available = next.available ?? available; detailsOnly = next.detailsOnly ?? detailsOnly;
      filesDisabled = next.filesDisabled ?? filesDisabled; live = next.live ?? live; list = next.list ?? list;
      title = next.title ?? title; notice = next.notice === undefined ? notice : next.notice;
      tag = next.tag ?? tag; pinned = next.pinned ?? pinned; syncing = next.syncing ?? syncing; rename = next.rename ?? rename;
      this.refresh();
    } };
}

it.each([false, true])('settles the %s horizontal header and keeps every button on the latest task', horizontal => {
  const page = setup(horizontal);
  const settled = h.registrations;
  page.refresh();
  page.change({ task: 'B' });
  expect(h.registrations).toBe(settled);
  press(names.desktop); press(names.files); press(names.details);
  if (horizontal) { press(names.back); press(names.list); press('tags');
    fireEvent.click(screen.getByTestId('session.titleArea')); fireEvent.click(screen.getByTestId('session.titleArea')); }
  expect(page.actions).toEqual(horizontal
    ? ['B:desktop', 'B:files', 'B:details', 'B:back', 'B:list', 'B:tags', 'B:rename']
    : ['B:desktop', 'B:files', 'B:details']);
  page.view.unmount();
  const reopened = setup(horizontal); press(names.files);
  expect(reopened.actions).toEqual(['A:files']);
});

it.each([false, true])('updates disabled, live-screen and worker actions in the %s horizontal header', horizontal => {
  const page = setup(horizontal);
  page.change({ available: false });
  press(names.desktop); press(names.files); press(names.details);
  expect(page.actions).toEqual([]);
  page.change({ available: true, filesDisabled: true });
  press(names.files); press(names.details);
  expect(page.actions).toEqual(['A:details']);
  page.change({ live: true, task: 'B' });
  expect(screen.queryByRole('button', { name: names.files })).toBeNull();
  press('Live screen');
  page.change({ task: 'C' }); press('Live screen');
  page.change({ detailsOnly: true });
  expect(screen.queryByRole('button', { name: names.desktop })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Live screen' })).toBeNull();
  press(names.details);
  page.change({ detailsOnly: false, live: false, filesDisabled: false }); press(names.files);
  expect(page.actions).toEqual(['A:details', 'B:live', 'C:live', 'C:details', 'C:files']);
});

it('refreshes title, tags, status, theme and language while removing optional actions', () => {
  const page = setup(true);
  h.dark = true; h.language = 'zh';
  page.change({ title: 'Changed', tag: 'Changed tag', notice: 'Offline', pinned: true, syncing: true, list: false, rename: false });
  expect(screen.getByTestId('session.title').textContent).toBe('Changed');
  expect(screen.getByTestId('pin')).toBeTruthy(); expect(screen.getByTestId('syncing')).toBeTruthy();
  expect(screen.getByText('Offline')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'tags' }).textContent).toBe('Changed tag');
  expect(page.view.container.querySelector('[data-tint="white"]')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /home.drawer/ })).toBeNull();
  press('zh:session.menu.details');
  fireEvent.click(screen.getByTestId('session.titleArea')); fireEvent.click(screen.getByTestId('session.titleArea'));
  expect(page.actions).toEqual(['A:details']);
});

it('settles shared back/new-task buttons, refreshes callbacks and unregisters on exit', () => {
  let task = 'A', disabled = false, close = false, newTask = true, available = true;
  const actions: string[] = [];
  const page = () => { const current = task; return <SystemNavigationBack label="Back" disabled={disabled} close={close} available={available}
    onPress={() => actions.push(`${current}:back`)} newTask={newTask ? { label: 'New', onPress: () => actions.push(`${current}:new`) } : undefined} />; };
  const view = render(<Navigator page={page} />);
  const refresh = () => view.rerender(<Navigator page={page} />);
  const settled = h.registrations;
  task = 'B'; refresh(); expect(h.registrations).toBe(settled);
  press('Back'); press('New'); expect(actions).toEqual(['B:back', 'B:new']);
  const lateNewTask = h.nativePresses.get('New')!;
  const lateBack = h.nativePresses.get('Back')!;
  disabled = true; close = true; refresh(); press('Back');
  expect(screen.getByRole('button', { name: 'Back' }).dataset.icon).toBe('xmark');
  expect(actions).toHaveLength(2);
  newTask = false; refresh(); expect(screen.queryByRole('button', { name: 'New' })).toBeNull();
  lateNewTask(); expect(actions).toHaveLength(2);
  available = false; refresh(); expect(screen.queryAllByRole('button')).toHaveLength(0);
  available = true; disabled = false; refresh(); press('Back');
  view.unmount();
  lateBack();
  expect(actions).toEqual(['B:back', 'B:new', 'B:back']);
  // Reopening the same task starts a fresh registration lifetime.
  render(<Navigator page={page} />); press('Back'); expect(actions.at(-1)).toBe('B:back');
});
