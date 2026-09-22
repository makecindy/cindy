// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { act, createContext, createElement, Fragment, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RemoteResource } from '@cindy/device-link';

const h = vi.hoisted(() => ({
  focused: true, drawer: {} as any, accounts: {} as any, profile: {} as any,
  dismiss: vi.fn(), push: vi.fn(), chooseMode: vi.fn(),
  auth: { accountGeneration: 1, user: null, logout: vi.fn(), beginAddAccount: vi.fn() },
}));
vi.mock('react-native', () => ({
  Keyboard: { dismiss: h.dismiss }, Alert: { alert: vi.fn() },
  View: ({ children, testID }: any) => createElement('div', { 'data-testid': testID }, children),
  Pressable: ({ children, onPress, testID }: any) => createElement('button', { onClick: onPress, 'data-testid': testID }, children),
  StyleSheet: { create: (s: unknown) => s },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string) => s, i18n: { language: 'en' } }) }));
vi.mock('expo-router', () => ({ useSegments: () => ['sessions', '[sessionId]'] }));
vi.mock('expo-router/react-navigation', () => ({
  useIsFocused: () => h.focused, NavigationContext: createContext(null), NavigationRouteContext: createContext(null),
}));
vi.mock('@/session/NativeResidentHistory', () => ({ NativeHistoryHost: null, NativeHistorySlot: null, needsResidentHistoryUpgrade: false }));
vi.mock('@/platform/AdaptiveWindowContext', () => ({
  usePaneViewport: () => ({ width: 390, height: 844 }), PaneViewportProvider: ({ children }: any) => children,
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/components/AppText', () => ({ Text: 'span' }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: () => null }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, useTheme: () => ({ colors: tokens.lightColors }), useThemedStyles: (fn: any) => fn(tokens.lightColors) };
});
vi.mock('lucide-react-native', () => ({ ChevronDown: () => null, PanelLeft: () => null, Settings2: () => null }));
vi.mock('@/session/HomeHeaderGlassButton', () => ({ HomeHeaderGlassButton: ({ onPress, testID, children }: any) =>
  createElement('button', { onClick: onPress, 'data-testid': testID }, children) }));
vi.mock('@/session/TeammatePicker', () => ({ TeammatePicker: () => null }));
vi.mock('@/session/CompanionProfileSheet', () => ({ CompanionCreateSheet: () => null,
  CompanionProfileSheet: (props: unknown) => { h.profile = props; return null; } }));
vi.mock('@/session/CompanionAutomationSheet', () => ({ CompanionAutomationSheet: () => null }));
vi.mock('@/session/useTeammateNavigation', () => ({ useTeammateNavigation: () => ({ chooseMode: h.chooseMode }) }));
vi.mock('@/utils/useGuardedPush', () => ({ useGuardedPush: () => h.push }));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: String }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: {
  subscribe: () => () => {}, getSessions: () => [], isSessionRunning: () => false,
} }));
vi.mock('@/session/AccountSwitcherSheet', () => ({ AccountSwitcherSheet: (props: unknown) => { h.accounts = props; return null; } }));
vi.mock('@/session/HomeChromeDrawer', () => ({ HomeChromeDrawer: (props: any) => {
  h.drawer = props;
  return createElement('div', { 'data-drawer': true, 'data-open': props.open });
} }));
import { MessageHistoryOverlay, RecentMessageHistoriesProvider } from '@/session/RecentMessageHistories';
import { CompanionHeader } from '@/session/CompanionHeader';
import { CompanionNavigationDrawer } from '@/session/CompanionNavigationDrawer';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); h.auth.accountGeneration = 1; h.focused = true;
  h.drawer = {}; h.accounts = {}; h.profile = {};
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

it('opens navigation through the page owner without mounting an overlay inside the clipped header', async () => {
  const onOpenNavigation = vi.fn(), onSearch = vi.fn();
  const resource = { ref: { kind: 'bot', collectionId: 'bots', id: 'bot' }, display: { title: 'Cindy' } } as RemoteResource;
  await act(async () => root.render(<CompanionHeader resource={resource} deviceId="pc" deviceName="PC" online
    onOpenNavigation={onOpenNavigation} onSearch={onSearch} />));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="companion.navigation"]')!.click());
  expect(h.dismiss).toHaveBeenCalledOnce();
  expect(onOpenNavigation).toHaveBeenCalledOnce();
  expect(host.querySelector('[data-drawer]')).toBeNull();
  // Profile/search remain the existing sheet flow, independent of drawer ownership.
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="companion.settings"]')!.click());
  expect(h.profile.visible).toBe(true);
  await act(async () => h.profile.onOpenSearch());
  expect(onSearch).not.toHaveBeenCalled();
  await act(async () => h.profile.onClosed());
  expect(onSearch).toHaveBeenCalledOnce();
});

it.each([
  ['onOpenSettings', '/settings'], ['onOpenDevices', '/devices/manage'],
])('preserves %s navigation after the full-screen drawer finishes closing', async (action, route) => {
  const onClose = vi.fn();
  await act(async () => root.render(<CompanionNavigationDrawer open onClose={onClose} onSearch={() => {}} />));
  await act(async () => h.drawer[action]());
  expect(onClose).toHaveBeenCalledOnce(); expect(h.push).not.toHaveBeenCalled();
  await act(async () => h.drawer.onClosed());
  expect(h.push).toHaveBeenCalledExactlyOnceWith(route);
  await act(async () => h.drawer.onClosed());
  expect(h.push).toHaveBeenCalledTimes(1);
});

it('preserves search, mode switching, account switching and logout actions', async () => {
  const onSearch = vi.fn();
  await act(async () => root.render(<CompanionNavigationDrawer open onClose={() => {}} onSearch={onSearch} />));
  await act(async () => h.drawer.onOpenSearch()); expect(onSearch).not.toHaveBeenCalled();
  await act(async () => h.drawer.onClosed()); expect(onSearch).toHaveBeenCalledOnce();
  await act(async () => h.drawer.onModeChange('tasks')); expect(h.chooseMode).not.toHaveBeenCalled();
  await act(async () => h.drawer.onClosed()); expect(h.chooseMode).toHaveBeenCalledWith('tasks');
  await act(async () => { h.drawer.onOpenAccounts(); h.drawer.onClosed(); }); expect(h.accounts.visible).toBe(true);
  h.auth.logout.mockResolvedValue(undefined);
  await act(async () => h.drawer.onLogout()); expect(h.auth.logout).toHaveBeenCalledOnce();
});

it.each(['account', 'companion'])('drops a queued navigation action when the %s scope changes', async (change) => {
  const render = (scope: string) => act(async () => root.render(<CompanionNavigationDrawer key={scope} open onClose={() => {}} onSearch={() => {}} />));
  await render('old');
  await act(async () => h.drawer.onOpenSettings());
  const staleFinish = h.drawer.onClosed;
  if (change === 'account') h.auth.accountGeneration++;
  await render('new');
  await act(async () => staleFinish());
  expect(h.push).not.toHaveBeenCalled();
});

// Execute production page state, callbacks and conditional JSX, following the
// existing page-hook tests. Do not reconstruct the navigation wiring in a fixture.
// Only unrelated chrome/sidebar components are omitted; the Android overlay
// provider and both companion components below are the production implementations.
const source = ts.createSourceFile('screen.tsx', readFileSync(
  resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const page = source.statements.find((n): n is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(n) && n.name?.text === 'SessionScreen')!;
const statements = page.body!.statements;
const declaration = (name: string) => statements.findIndex(n => ts.isVariableStatement(n)
  && n.declarationList.declarations.some(d => d.name.getText(source) === name));
const stateStart = declaration('companionChat');
const stateEnd = declaration('lastAckKeyRef');
if (stateStart < 0 || stateEnd <= stateStart) throw new Error('Missing companion page state');
const header = statements[declaration('headerNode')];
const returned = statements.find(ts.isReturnStatement)!.expression as ts.ParenthesizedExpression;
const screenRoot = returned.expression as ts.JsxElement;
// Select from the screen root, never from a descendant under session.chrome.
const overlay = screenRoot.children.find(n => ts.isJsxElement(n)
  && n.openingElement.tagName.getText(source) === 'MessageHistoryOverlay');
if (!overlay) throw new Error('Missing page-root MessageHistoryOverlay');
const printer = ts.createPrinter();
function relevantJsx(node: ts.Node): string {
  const result = ts.transform(node, [context => root => {
    const visit: ts.Visitor = child => {
      if (ts.isJsxSelfClosingElement(child)
        && ['Stack.Screen', 'SystemNavigationBack', 'SessionHeaderBar', 'SessionListDrawer'].includes(child.tagName.getText(source))) {
        return ts.factory.createJsxSelfClosingElement(ts.factory.createIdentifier('span'), undefined, ts.factory.createJsxAttributes([]));
      }
      return ts.visitEachChild(child, visit, context);
    };
    return ts.visitNode(root, visit) as typeof root;
  }]);
  const text = printer.printNode(ts.EmitHint.Unspecified, result.transformed[0], source);
  result.dispose(); return text;
}
const compiled = ts.transpileModule(`function PageHost({ bindings }) {
  const { auth, deviceId, sessionId, companionResource, shareSelectionActive, setSearchOpen } = bindings;
  const deviceName = 'PC', remoteUnavailableReason = null, sessionListDrawerOverlayMounted = false;
  ${statements.slice(stateStart, stateEnd).map(n => n.getText(source)).join('\n')}
  ${relevantJsx(header)}
  return <div data-testid="page-route"><div data-testid="clipped-chrome">{headerNode}</div>${relevantJsx(overlay)}</div>;
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const PageHost = new Function('React', 'useState', 'CompanionHeader', 'CompanionNavigationDrawer', 'MessageHistoryOverlay',
  `${compiled}; return PageHost;`)({ createElement, Fragment }, useState, CompanionHeader, CompanionNavigationDrawer, MessageHistoryOverlay);
const pageBindings = () => ({ auth: h.auth, deviceId: 'pc', sessionId: 'session-a', shareSelectionActive: false,
  companionResource: { ref: { kind: 'bot', collectionId: 'bots', id: 'bot-a' }, display: { title: 'Cindy' } } as RemoteResource | null,
  setSearchOpen: vi.fn() });
const showPage = (bindings: ReturnType<typeof pageBindings>) => act(async () => {
  root.render(<RecentMessageHistoriesProvider><PageHost bindings={bindings} /></RecentMessageHistoriesProvider>);
});
const openPageDrawer = () => act(async () => host.querySelector<HTMLButtonElement>('[data-testid="companion.navigation"]')!.click());

it('opens the page-owned drawer in the real Android history overlay and closes before searching', async () => {
  const bindings = pageBindings();
  await showPage(bindings); await openPageDrawer();
  const drawer = host.querySelector('[data-drawer]')!;
  expect(drawer.getAttribute('data-open')).toBe('true');
  expect(host.querySelector('[data-testid="page-route"]')!.contains(drawer)).toBe(false);
  expect(host.querySelector('[data-testid="clipped-chrome"]')!.contains(drawer)).toBe(false);
  await act(async () => h.drawer.onOpenSearch());
  expect(host.querySelector('[data-drawer]')!.getAttribute('data-open')).toBe('false');
  expect(bindings.setSearchOpen).not.toHaveBeenCalled();
  await act(async () => h.drawer.onClosed());
  expect(bindings.setSearchOpen).toHaveBeenCalledExactlyOnceWith(true);
});

it.each(['account', 'device', 'session', 'companion', 'share'] as const)('resets the page drawer across the %s boundary', async change => {
  const bindings = pageBindings();
  await showPage(bindings); await openPageDrawer();
  await act(async () => h.drawer.onOpenSettings());
  const staleFinish = h.drawer.onClosed;
  await openPageDrawer();
  if (change === 'account') h.auth.accountGeneration++;
  if (change === 'device') bindings.deviceId = 'pc-b';
  if (change === 'session') bindings.sessionId = 'session-b';
  if (change === 'companion') bindings.companionResource = { ...bindings.companionResource!, ref: { kind: 'bot', collectionId: 'bots', id: 'bot-b' } };
  if (change === 'share') bindings.shareSelectionActive = true;
  await showPage(bindings);
  expect(host.querySelector('[data-open="true"]')).toBeNull();
  await act(async () => staleFinish()); expect(h.push).not.toHaveBeenCalled();
  if (change === 'share') {
    expect(host.querySelector('[data-drawer]')).toBeNull();
    bindings.shareSelectionActive = false; await showPage(bindings);
    expect(host.querySelector('[data-open="true"]')).toBeNull();
  }
});

it('does not mount a companion drawer on an ordinary task or unfocused route', async () => {
  const bindings = pageBindings(); bindings.companionResource = null;
  await showPage(bindings); expect(host.querySelector('[data-drawer]')).toBeNull();
  bindings.companionResource = pageBindings().companionResource;
  await showPage(bindings); await openPageDrawer();
  h.focused = false; await showPage(bindings);
  expect(host.querySelector('[data-drawer]')).toBeNull();
});
