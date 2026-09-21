// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  router: { replace: vi.fn() }, generation: 1,
  params: { collectionId: 'teammates', resourceId: 'bot-1', resourceKind: 'bot', deviceId: 'mac', deviceName: 'Mac' },
  translation: { t: (key: string) => key, i18n: { language: 'en' } },
  read: vi.fn(), action: vi.fn(), upsert: vi.fn(), push: null as null | ((device: string, payload: any) => void),
  link: { connectionEpoch: 1, status: 'online', invoke: vi.fn(), onRemoteResourceChanged: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() },
}));
vi.mock('react-native', async () => {
  const { createElement: el } = await import('react');
  const view = ({ children, testID }: any) => el('div', { 'data-testid': testID }, children);
  return { View: view, ActivityIndicator: () => null, StyleSheet: { create: (s: any) => s }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } };
});
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return { useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]), useRouter: () => h.router, useLocalSearchParams: () => h.params };
});
vi.mock('react-i18next', () => ({ useTranslation: () => h.translation }));
vi.mock('react-native-safe-area-context', async () => { const { createElement: el } = await import('react'); return { SafeAreaView: ({ children }: any) => el('div', {}, children) }; });
vi.mock('@/components/AppText', () => ({ Text: 'span' }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: () => null }));
vi.mock('@/components/MobilePrimitives', async () => {
  const { createElement: el } = await import('react');
  return { MainWindowEmptyState: ({ copy }: any) => el('span', {}, copy), MainWindowActionButton: ({ action }: any) => el('button', { onClick: action.onPress, 'data-testid': action.testID }, action.label) };
});
vi.mock('@/platform/chrome', () => ({ SimpleStackHeader: () => null, simpleScreenSafeAreaEdges: () => [] }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: h.generation }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: String }));
vi.mock('@/device-link/focusedTopicSubscription', () => ({ startFocusedTopicSubscription: () => () => {} }));
vi.mock('@/device-link/remoteResources', () => ({ getRemoteResource: h.read, invokeRemoteResourceAction: h.action }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: { getSessionDeviceId: () => null, upsertDeviceSession: h.upsert } }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}), useTheme: () => ({ colors: {} }) }));
vi.mock('@/utils/backGuard', () => ({ goBackGuarded: vi.fn() }));
import Screen from '../../app/resources/[collectionId]/[resourceId]';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const resource = (stage: string) => ({ ref: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' }, display: { title: 'Mimi' }, revision: stage, links: stage === 'ready' ? [{ rel: 'conversation', target: { kind: 'session', sessionId: 'chat-1' } }] : [], blocks: [{ id: 'invitation', primitive: 'status', fallbackMarkdown: '', data: { stage } }], actions: stage === 'failed' ? [{ id: 'opaque-retry', label: 'Retry' }] : [] });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks(); h.generation = 1;
  h.link.onRemoteResourceChanged.mockImplementation(callback => { h.push = callback; return () => { h.push = null; }; });
  h.link.invoke.mockResolvedValue({ id: 'chat-1', source: 'bot' });
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); });
it('keeps preparation in place and opens the canonical chat only after the host is ready', async () => {
  h.read.mockResolvedValue(resource('skills'));
  await act(async () => root.render(createElement(Screen)));
  expect(container.textContent).toContain('devices.companions.invitation.skills');
  expect(h.router.replace).not.toHaveBeenCalled();
  h.read.mockResolvedValue(resource('ready'));
  await act(async () => h.push!('mac', { collectionId: 'teammates' }));
  expect(h.upsert).toHaveBeenCalledWith('mac', 'Mac', { id: 'chat-1', source: 'bot' });
  expect(h.router.replace).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/sessions/[sessionId]' }));
});
it('retries failed preparation through the advertised action without creating another teammate', async () => {
  h.read.mockResolvedValue(resource('failed'));
  h.action.mockImplementation(async () => { h.read.mockResolvedValue(resource('skills')); return { effects: [] }; });
  await act(async () => root.render(createElement(Screen)));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="remoteResourceResolver.retryInvitation"]')!.click());
  expect(h.action).toHaveBeenCalledWith(h.link.invoke, { deviceId: 'mac', deviceName: 'Mac' }, expect.objectContaining({ actionId: 'opaque-retry', resourceRef: resource('failed').ref }), 'en');
  expect(container.textContent).toContain('devices.companions.invitation.skills');
});
it('ignores a late ready response from the previous account', async () => {
  let finish!: (value: unknown) => void;
  h.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(resource('failed'));
  await act(async () => root.render(createElement(Screen)));
  h.generation = 2;
  await act(async () => root.render(createElement(Screen)));
  await act(async () => finish(resource('ready')));
  expect(h.router.replace).not.toHaveBeenCalled();
  expect(h.upsert).not.toHaveBeenCalled();
});
