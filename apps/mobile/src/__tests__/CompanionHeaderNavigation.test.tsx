// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { act, createElement, Fragment, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useHostManagedSession } from '@/session/hostManagedSession';
import type { RemoteResource } from '@cindy/device-link';

const h = vi.hoisted(() => ({
  profile: {} as any, dismiss: vi.fn(), chooseMode: vi.fn(), screenOptions: [] as Array<Record<string, unknown>>,
  auth: { accountGeneration: 1, user: null },
}));
vi.mock('react-native', () => ({
  Keyboard: { dismiss: h.dismiss },
  View: ({ children, testID }: any) => createElement('div', { 'data-testid': testID }, children),
  Pressable: ({ children, onPress, testID, disabled }: any) => createElement('button', { onClick: onPress, disabled, 'data-testid': testID },
    typeof children === 'function' ? children({ pressed: false }) : children),
  StyleSheet: { create: (s: unknown) => s },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string) => s, i18n: { language: 'en' } }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => createElement('span', null, children) }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: () => null }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, useTheme: () => ({ colors: tokens.lightColors }), useThemedStyles: (fn: any) => fn(tokens.lightColors) };
});
vi.mock('lucide-react-native', () => ({ ChevronLeft: () => null, Settings2: () => null }));
vi.mock('@/session/HomeHeaderGlassButton', () => ({ HomeHeaderGlassButton: ({ onPress, testID, children, disabled }: any) =>
  createElement('button', { onClick: onPress, disabled, 'data-testid': testID }, children) }));
vi.mock('@/session/CompanionPresenceRing', () => ({ CompanionPresenceRing: ({ active }: any) => active ? createElement('i', { 'data-testid': 'ring' }) : null }));
vi.mock('@/session/CompanionProfileSheet', () => ({ CompanionProfileSheet: (props: unknown) => { h.profile = props; return null; } }));
vi.mock('@/session/useTeammateNavigation', () => ({ useTeammateNavigation: () => ({ chooseMode: h.chooseMode }) }));
import { CompanionHeader } from '@/session/CompanionHeader';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root; let host: HTMLDivElement;
const resource = { ref: { kind: 'bot', collectionId: 'bots', id: 'bot' }, display: { title: 'Cindy' } } as RemoteResource;
const button = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
beforeEach(() => {
  vi.clearAllMocks(); h.auth.accountGeneration = 1; h.profile = {}; h.screenOptions = [];
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

it('goes back from the chat instead of opening a drawer, and opens the profile from the name or the settings button', async () => {
  const onBack = vi.fn(), onSearch = vi.fn();
  await act(async () => root.render(<CompanionHeader resource={resource} deviceId="pc" deviceName="PC" online onBack={onBack} onSearch={onSearch} />));
  await act(async () => button('companion.back').click());
  expect(h.dismiss).toHaveBeenCalledOnce();
  expect(onBack).toHaveBeenCalledOnce();
  await act(async () => button('companion.identity').click());
  expect(h.profile.visible).toBe(true);
  await act(async () => h.profile.onClose());
  await act(async () => button('companion.settings').click());
  expect(h.profile.visible).toBe(true);
  // Search from the profile waits until the sheet has closed.
  await act(async () => h.profile.onOpenSearch());
  expect(onSearch).not.toHaveBeenCalled();
  await act(async () => h.profile.onClosed());
  expect(onSearch).toHaveBeenCalledOnce();
});

it('shows the computer and whether it is online, and breathes while the companion works', async () => {
  await act(async () => root.render(<CompanionHeader resource={resource} deviceId="pc" deviceName="Office iMac" online={false} working onBack={() => {}} onSearch={() => {}} />));
  expect(host.textContent).toContain('devices.resources.hostOffline · Office iMac');
  expect(host.querySelector('[data-testid="ring"]')).not.toBeNull();
  await act(async () => root.render(<CompanionHeader resource={resource} deviceId="pc" deviceName="Office iMac" online onBack={() => {}} onSearch={() => {}} />));
  expect(host.textContent).toContain('Office iMac');
  expect(host.textContent).not.toContain('devices.resources.hostOffline');
  expect(host.querySelector('[data-testid="ring"]')).toBeNull();
});

it('keeps profile controls closed until the chat entry is validated', async () => {
  await act(async () => root.render(<CompanionHeader resource={resource} deviceId="pc" deviceName="PC" online controlsReady={false} onBack={() => {}} onSearch={() => {}} />));
  expect(button('companion.settings').disabled).toBe(true);
  expect(button('companion.identity').disabled).toBe(true);
  expect(h.profile.visible).toBe(false);
});

// Execute the production page header state and JSX, following the existing page-hook tests.
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
const printer = ts.createPrinter();
function relevantJsx(node: ts.Node): string {
  const result = ts.transform(node, [context => root => {
    const visit: ts.Visitor = child => {
      if (ts.isJsxSelfClosingElement(child) && child.tagName.getText(source) === 'Stack.Screen') {
        return ts.factory.createJsxSelfClosingElement(ts.factory.createIdentifier('StackScreen'), undefined, child.attributes);
      }
      if (ts.isJsxSelfClosingElement(child) && child.tagName.getText(source) === 'SessionHeaderBar') {
        return ts.factory.createJsxSelfClosingElement(ts.factory.createIdentifier('span'), undefined, ts.factory.createJsxAttributes([]));
      }
      return ts.visitEachChild(child, visit, context);
    };
    return ts.visitNode(root, visit) as typeof root;
  }]);
  const text = printer.printNode(ts.EmitHint.Unspecified, result.transformed[0], source);
  result.dispose(); return text;
}
const moduleConstant = (name: string) => source.statements.find(n => ts.isVariableStatement(n)
  && n.declarationList.declarations.some(d => d.name.getText(source) === name))!.getText(source);
const compiled = ts.transpileModule(`${moduleConstant('COMPANION_NATIVE_HEADER_OPTIONS')}
function PageHost({ bindings }) {
  const { auth, deviceId, sessionId, companionResource, companionEntry, shareSelectionActive, setSearchOpen, goBackToHome, companionWorkingLabel } = bindings;
  const currentSession = null;
  const deviceName = 'PC', remoteUnavailableReason = null, sessionListDrawerOverlayMounted = false;
  ${statements.slice(stateStart, stateEnd).map(n => n.getText(source)).join('\n')}
  ${relevantJsx(header)}
  return <div data-testid="page-route">{headerNode}</div>;
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
function StackScreen({ options }: { options: Record<string, unknown> }) { h.screenOptions.push(options); return null; }
const PageHost = new Function('React', 'useState', 'useHostManagedSession', 'CompanionHeader', 'StackScreen',
  `${compiled}; return PageHost;`)({ createElement, Fragment }, useState, useHostManagedSession, CompanionHeader, StackScreen);
const pageBindings = () => ({ auth: h.auth, deviceId: 'pc', sessionId: 'session-a', shareSelectionActive: false,
  companionEntry: { ready: true },
  companionResource: { ref: { kind: 'bot', collectionId: 'bots', id: 'bot-a' }, display: { title: 'Cindy' } } as RemoteResource | null,
  setSearchOpen: vi.fn(), goBackToHome: vi.fn(), companionWorkingLabel: null as string | null });
const showPage = (bindings: ReturnType<typeof pageBindings>) => act(async () => { root.render(<PageHost bindings={bindings} />); });

it('wires the page: title while entry validation runs, Back to the roster, and the working breath', async () => {
  const bindings = pageBindings(); bindings.companionEntry.ready = false;
  await showPage(bindings);
  expect(host.textContent).toContain('Cindy');
  expect(button('companion.settings').disabled).toBe(true);
  expect(h.profile.online).toBe(true); // Synchronizing is not an offline connection.
  bindings.companionEntry.ready = true; bindings.companionWorkingLabel = 'Thinking…';
  await showPage(bindings);
  expect(button('companion.settings').disabled).toBe(false);
  expect(host.querySelector('[data-testid="ring"]')).not.toBeNull();
  await act(async () => button('companion.back').click());
  expect(bindings.goBackToHome).toHaveBeenCalledOnce();
  // The companion row is the only header: the native bar the task header configured while the
  // entry resolved must not keep its title and sync spinner on top of the identity.
  expect(h.screenOptions).toContainEqual(expect.objectContaining({ headerShown: false, headerTitle: '' }));
});

it('shows the ordinary task header on non-companion pages and while sharing', async () => {
  const bindings = pageBindings(); bindings.companionResource = null;
  await showPage(bindings);
  expect(host.querySelector('[data-testid="companion.header"]')).toBeNull();
  bindings.companionResource = pageBindings().companionResource; bindings.shareSelectionActive = true;
  await showPage(bindings);
  expect(host.querySelector('[data-testid="companion.header"]')).toBeNull();
  // The task header keeps its native bar.
  expect(h.screenOptions.some((options) => options.headerShown === false)).toBe(false);
});
