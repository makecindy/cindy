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
  glance: {} as any, profile: {} as any, glanceTodos: { enabled: false } as any, unseen: false, markSeen: vi.fn(), push: vi.fn(), dismiss: vi.fn(), returnHome: vi.fn(), screenOptions: [] as Array<Record<string, unknown>>,
  auth: { accountGeneration: 1, user: null },
  cloud: { supported: false, actors: [] as Array<{ kind: string; externalId: string; homeDeviceId: string | null }> },
  homeSheet: {} as any,
}));
vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ width: 662, height: 942 }),
  Keyboard: { dismiss: h.dismiss },
  View: ({ children, testID }: any) => createElement('div', { 'data-testid': testID }, children),
  Pressable: ({ children, onPress, testID, disabled }: any) => createElement('button', { onClick: onPress, disabled, 'data-testid': testID },
    typeof children === 'function' ? children({ pressed: false }) : children),
  StyleSheet: { create: (s: unknown) => s },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 72, bottom: 0, left: 0, right: 0 }) }));
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
vi.mock('@/session/CompanionGlanceSheet', () => ({ CompanionGlanceSheet: (props: unknown) => { h.glance = props; return null; } }));
vi.mock('@/session/useCompanionGlanceTodos', () => ({
  useCompanionGlanceTodos: (options: any) => { h.glanceTodos = options; return { todos: { open: [] }, refresh: vi.fn() }; },
  dueTodos: () => [],
  useGlanceDueSeen: () => ({ unseen: h.unseen, markSeen: h.markSeen }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: h.push }), Stack: {
  Screen: ({ options }: any) => { h.screenOptions.push(options); return typeof options.headerTitle === 'function'
    ? createElement('div', { 'data-testid': 'native-title' }, options.headerTitle()) : null; },
  Toolbar: Object.assign(({ children, placement }: any) => createElement('div', { 'data-toolbar': placement }, children), {
    View: ({ children }: any) => children,
  }),
} }));
vi.mock('@/session/CompanionProfileSheet', () => ({ CompanionProfileSheet: (props: unknown) => { h.profile = props; return null; } }));
vi.mock('@/session/useTeammateNavigation', () => ({ useTeammateNavigation: () => ({ returnHome: h.returnHome }) }));
vi.mock('@/chat/useCloudCompanion', () => ({ useCloudCompanionHome: () => h.cloud }));
vi.mock('@/session/CloudHomeSwitchSheet', () => ({ CloudHomeSwitchSheet: (props: unknown) => { h.homeSheet = props; return null; } }));
import { CompanionHeader } from '@/session/CompanionHeader';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root; let host: HTMLDivElement;
const resource = { ref: { kind: 'bot', collectionId: 'bots', id: 'bot' }, display: { title: 'Cindy' } } as RemoteResource;
const button = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
beforeEach(() => {
  vi.clearAllMocks(); h.auth.accountGeneration = 1; h.profile = {}; h.glance = {}; h.screenOptions = []; h.unseen = false;
  h.cloud = { supported: false, actors: [] }; h.homeSheet = {};
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

// Unit regression: Duo's companion controls must live in the native bar, not a second row
// below its status area. Existing navigation tests only exercised the in-content header.
it('hosts the companion identity and actions in the system bar while keeping their behavior', async () => {
  const onBack = vi.fn();
  await act(async () => root.render(<CompanionHeader nativeHeader sessionId="s1" onQuoteTodo={() => {}} onAskCompanion={() => {}}
    resource={resource} deviceId="pc" deviceName="PC" online onBack={onBack} onSearch={() => {}} />));
  expect(host.querySelector('[data-toolbar="left"]')?.textContent).toContain('Cindy');
  expect(host.querySelector('[data-testid="companion.header"]')).toBeNull();
  await act(async () => button('companion.identity').click());
  expect(h.glance.visible).toBe(true);
  await act(async () => button('companion.settings').click());
  expect(h.profile.visible).toBe(true);
  await act(async () => button('companion.back').click());
  expect(onBack).toHaveBeenCalledOnce();
});

it('goes back from the chat instead of opening a drawer, opens 近况 from the avatar and the profile from settings', async () => {
  const onBack = vi.fn(), onSearch = vi.fn();
  await act(async () => root.render(<CompanionHeader sessionId="s1" onQuoteTodo={() => {}} onAskCompanion={() => {}} resource={resource} deviceId="pc" deviceName="PC" online onBack={onBack} onSearch={onSearch} />));
  await act(async () => button('companion.back').click());
  expect(h.dismiss).toHaveBeenCalledOnce();
  expect(onBack).toHaveBeenCalledOnce();
  await act(async () => button('companion.identity').click());
  expect(h.glance).toMatchObject({ visible: true, botId: 'bot', deviceId: 'pc', sessionId: 's1' });
  expect(h.profile.visible).toBe(false);
  await act(async () => h.glance.onClose());
  await act(async () => button('companion.settings').click());
  expect(h.profile.visible).toBe(true);
  // Search from the profile waits until the sheet has closed.
  await act(async () => h.profile.onOpenSearch());
  expect(onSearch).not.toHaveBeenCalled();
  await act(async () => h.profile.onClosed());
  expect(onSearch).toHaveBeenCalledOnce();
});

it('shows the computer and whether it is online, and breathes while the companion works', async () => {
  await act(async () => root.render(<CompanionHeader sessionId="s1" onQuoteTodo={() => {}} onAskCompanion={() => {}} resource={resource} deviceId="pc" deviceName="Office iMac" online={false} working onBack={() => {}} onSearch={() => {}} />));
  expect(host.textContent).toContain('devices.resources.hostOffline · Office iMac');
  expect(host.querySelector('[data-testid="ring"]')).not.toBeNull();
  await act(async () => root.render(<CompanionHeader sessionId="s1" onQuoteTodo={() => {}} onAskCompanion={() => {}} resource={resource} deviceId="pc" deviceName="Office iMac" online onBack={() => {}} onSearch={() => {}} />));
  expect(host.textContent).toContain('Office iMac');
  expect(host.textContent).not.toContain('devices.resources.hostOffline');
  expect(host.querySelector('[data-testid="ring"]')).toBeNull();
});

it('keeps profile controls closed until the chat entry is validated', async () => {
  await act(async () => root.render(<CompanionHeader sessionId="s1" onQuoteTodo={() => {}} onAskCompanion={() => {}} resource={resource} deviceId="pc" deviceName="PC" online controlsReady={false} onBack={() => {}} onSearch={() => {}} />));
  expect(button('companion.settings').disabled).toBe(true);
  expect(button('companion.identity').disabled).toBe(true);
  expect(h.profile.visible).toBe(false);
  expect(h.glance.visible).toBe(false);
});

// Execute the production page header state and JSX, following the existing page-hook tests.
const source = ts.createSourceFile('screen.tsx', readFileSync(
  resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const page = source.statements.find((n): n is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(n) && n.name?.text === 'SessionScreenContent')!;
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
  const { auth, deviceId, sessionId, companionResource, companionEntry, shareSelectionActive, setSearchOpen, goBackToHome, companionWorkingLabel, quoteTodoInComposer, askCompanionInComposer, canUseComposer, composerDraftHydrated } = bindings;
  const currentSession = null;
  const isSideChatSheet = false;
  const horizontalSystemHeader = bindings.nativeHeader ?? false;
  const companionSettingsRequest = bindings.companionSettingsRequest;
  const deviceName = 'PC', remoteUnavailableReason = null, sessionListDrawerOverlayMounted = false;
  ${statements.slice(stateStart, stateEnd).map(n => n.getText(source)).join('\n')}
  ${statements[declaration('companionHeaderShown')].getText(source)}
  ${relevantJsx(header)}
  return <div data-testid="page-route">{headerNode}</div>;
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
function StackScreen({ options }: { options: Record<string, unknown> }) { h.screenOptions.push(options); return null; }
const PageHost = new Function('React', 'useState', 'useHostManagedSession', 'CompanionHeader', 'StackScreen',
  `${compiled}; return PageHost;`)({ createElement, Fragment }, useState, useHostManagedSession, CompanionHeader, StackScreen);
const pageBindings = () => ({ auth: h.auth, deviceId: 'pc', sessionId: 'session-a', shareSelectionActive: false, nativeHeader: false,
  companionEntry: { ready: true },
  companionResource: { ref: { kind: 'bot', collectionId: 'bots', id: 'bot-a' }, display: { title: 'Cindy' } } as RemoteResource | null,
  setSearchOpen: vi.fn(), goBackToHome: vi.fn(), companionWorkingLabel: null as string | null, quoteTodoInComposer: vi.fn(), askCompanionInComposer: vi.fn(), canUseComposer: true, composerDraftHydrated: true });
const showPage = (bindings: ReturnType<typeof pageBindings>) => act(async () => { root.render(<PageHost bindings={bindings} />); });

it.each([false, true])('wires the page: entry validation, Back and working breath (native=%s)', async nativeHeader => {
  const bindings = pageBindings(); bindings.nativeHeader = nativeHeader; bindings.companionEntry.ready = false;
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
  // Replace the ordinary task title once the companion resolves, in either header host.
  expect(h.screenOptions).toContainEqual(expect.objectContaining({ headerShown: nativeHeader, headerTitle: '' }));
  if (nativeHeader) expect(h.screenOptions.some(options => options.headerShown === false)).toBe(false);
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

it('opens learning links in the existing profile sheet on the requested page', async () => {
  await act(async () => root.render(<CompanionHeader sessionId="s1" onQuoteTodo={() => {}} onAskCompanion={() => {}} resource={resource} deviceId="pc" deviceName="PC" online onBack={() => {}} onSearch={() => {}}
    settingsRequest={{ page: 'memory', sequence: 1 }} />));
  expect(h.profile).toMatchObject({ visible: true, initialPage: 'memory' });
  await act(async () => h.profile.onClose());
  await act(async () => root.render(<CompanionHeader sessionId="s1" onQuoteTodo={() => {}} onAskCompanion={() => {}} resource={resource} deviceId="pc" deviceName="PC" online onBack={() => {}} onSearch={() => {}}
    settingsRequest={{ page: 'capabilities', sequence: 2 }} />));
  expect(h.profile).toMatchObject({ visible: true, initialPage: 'capabilities' });
});

it('reads todos only for an advertised, online host, and clears the due dot by opening 近况', async () => {
  const props = { resource, deviceId: 'pc', deviceName: 'PC', online: true, sessionId: 's1', onQuoteTodo: vi.fn(), onAskCompanion: vi.fn(), onBack: vi.fn(), onSearch: vi.fn() };
  await act(async () => root.render(<CompanionHeader {...props} />));
  expect(h.glanceTodos).toMatchObject({ botId: 'bot', deviceId: 'pc', enabled: false });
  const withTodos: RemoteResource = { ...resource, links: [{ rel: 'todos', label: 'Todo', target: { kind: 'resource', ref: { collectionId: 'teammates', kind: 'bot', id: 'todos:bot' } } }] };
  await act(async () => root.render(<CompanionHeader {...props} resource={withTodos} online={false} />));
  expect(h.glanceTodos.enabled).toBe(false);
  h.unseen = true;
  await act(async () => root.render(<CompanionHeader {...props} resource={withTodos} />));
  expect(h.glanceTodos.enabled).toBe(true);
  expect(button('companion.header.dueDot')).not.toBeNull();
  await act(async () => button('companion.identity').click());
  expect(h.markSeen).toHaveBeenCalledOnce();
  // Quoting a todo goes to this chat's composer.
  expect(h.glance.onQuoteTodo).toBe(props.onQuoteTodo);
  // 「帮我查查」 is the owner's own words, sent through this chat's composer.
  await act(async () => h.glance.onCheckTodos());
  expect(props.onAskCompanion).toHaveBeenCalledWith('devices.glance.checkPrompt');
  // While the chat cannot take it (read-only, locked, draft not restored) 「帮我查查」 is not offered.
  await act(async () => root.render(<CompanionHeader {...props} resource={withTodos} askCompanionReady={false} />));
  expect(h.glance.onCheckTodos).toBeUndefined();
  await act(async () => h.glance.onOpenTask('child-1'));
  expect(h.push).toHaveBeenCalledWith({ pathname: '/sessions/[sessionId]', params: { sessionId: 'child-1', deviceId: 'pc' } });
});

it('names the main computer of a cloud companion and lets the profile change it', async () => {
  h.cloud = { supported: true, actors: [{ kind: 'bot', externalId: 'bot', homeDeviceId: 'pc' }] };
  await act(async () => root.render(<CompanionHeader sessionId="s1" onQuoteTodo={() => {}} onAskCompanion={() => {}} resource={resource} deviceId="pc" deviceName="Office iMac" online onBack={() => {}} onSearch={() => {}} />));
  expect(host.textContent).toContain('devices.cloudCompanion.runsOn');
  await act(async () => button('companion.settings').click());
  await act(async () => h.profile.onOpenHome());
  // Opens once the profile sheet has closed.
  expect(h.homeSheet.visible).toBe(false);
  await act(async () => h.profile.onClosed());
  expect(h.homeSheet.visible).toBe(true);
  expect(h.homeSheet).toMatchObject({ botId: 'bot', homeDeviceId: 'pc', homeName: 'Office iMac' });
  await act(async () => h.homeSheet.onMoved({ deviceId: 'mac', name: 'Mac', online: true }));
  expect(h.returnHome).toHaveBeenCalledOnce();
  // 近况 offers the same switch (its row closes the sheet first).
  expect(h.glance.cloudHome).toBe(true);
  await act(async () => h.glance.onSwitchHome());
  expect(h.homeSheet.visible).toBe(true);
});

it('offers no computer change for a companion without a known main computer', async () => {
  await act(async () => root.render(<CompanionHeader sessionId="s1" onQuoteTodo={() => {}} onAskCompanion={() => {}} resource={resource} deviceId="pc" deviceName="PC" online onBack={() => {}} onSearch={() => {}} />));
  await act(async () => button('companion.settings').click());
  expect(h.profile.onOpenHome).toBeUndefined();
});
