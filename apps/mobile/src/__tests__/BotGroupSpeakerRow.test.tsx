// @vitest-environment jsdom
import { act, createElement as el, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  push: vi.fn(),
  invoke: vi.fn(),
  subscribe: vi.fn(async () => undefined),
  unsubscribe: vi.fn(async () => undefined),
  setPending: vi.fn(),
  pending: {} as Record<string, unknown[]>,
  live: {} as Record<string, unknown>,
  copy: vi.fn(),
  panel: null as any,
}));

vi.mock('react-native', () => ({
  View: ({ children, testID, accessibilityLabel }: any) => el('div', { 'data-testid': testID, 'aria-label': accessibilityLabel }, children),
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: ({ action }: any) => el('button', { onClick: action.onPress }, action.label) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: h.push }), useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) }));
vi.mock('lucide-react-native', () => ({ CircleAlert: () => null, Sparkles: () => null }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}), useTheme: () => ({ colors: {} }) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => el('span', null, children) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke, subscribe: h.subscribe, unsubscribe: h.unsubscribe }) }));
vi.mock('@/session/BotGroupAvatars', () => ({ BOT_GROUP_MESSAGE_AVATAR_SIZE: 28, BOT_GROUP_INLINE_AVATAR_SIZE: 20, BotGroupAvatar: () => null }));
vi.mock('@/session/InteractionPanel', () => ({ InteractionPanel: (props: any) => { h.panel = props; return el('div', { 'data-testid': 'panel' }); } }));
vi.mock('@/session/remoteSessionStore', () => ({
  remoteSessionStore: {
    subscribe: () => () => {},
    getSessionLiveActivity: (sessionId: string) => h.live[sessionId] ?? null,
    setPendingInteractions: h.setPending,
  },
  useSessionPendingInteractions: (sessionId: string) => h.pending[sessionId] ?? [],
}));
vi.mock('@/session/useCompanionGenerationCopy', () => ({
  useCompanionGenerationCopy: (input: { phase: string | null; active: boolean }) => { h.copy(input); return input.active ? `copy:${input.phase}` : null; },
}));
vi.mock('@/session/WorkingStatusText', () => ({ WorkingStatusText: ({ text }: any) => el('span', { 'data-testid': 'status' }, text) }));

vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('@/session/CompanionPresenceRing', () => ({ CompanionPresenceRing: () => null }));
vi.mock('@/session/ThinkingDots', () => ({ ThinkingDots: () => null }));
import { BotGroupSpeakerRow } from '@/session/BotGroupSpeakerRow';
import i18n from '@/i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let node: HTMLDivElement;
const identity = { botId: 'abu', name: '阿布' };
async function render(props: Record<string, unknown>) {
  await act(async () => root.render(el(BotGroupSpeakerRow, { deviceId: 'mac', identity, online: true, onError: vi.fn(), sessionId: 's1', activity: 'reply', ...props } as any)));
}
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  vi.clearAllMocks(); h.pending = {}; h.live = {}; h.panel = null;
  h.invoke.mockResolvedValue([{ request: { requestId: 'r1' } }]);
  node = document.createElement('div'); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); });

it('follows the speaking lane while focused and seeds its pending prompts', async () => {
  await render({});
  expect(h.subscribe).toHaveBeenCalledWith(expect.stringMatching(/^bot-group-speaker:s1:focus:/), 'mac', ['session:s1']);
  expect(h.invoke).toHaveBeenCalledWith('mac', 'maker:get-pending-interactions', ['s1']);
  expect(h.setPending).toHaveBeenCalledWith('s1', [{ request: { requestId: 'r1' } }], { deviceId: 'mac' });
  // No observed phase must not falsely claim thinking.
  expect(node.textContent).toContain('copy:processing');
  await act(async () => root.unmount());
  expect(h.unsubscribe).toHaveBeenCalledWith(expect.stringMatching(/^bot-group-speaker:s1:focus:/), 'mac', ['session:s1']);
  root = createRoot(node);
});

it('uses the live phase, and plain copy while planning or before a step reports one', async () => {
  h.live.s1 = { sessionId: 's1', phase: 'running', compactDetail: '', workingPhase: 'reading-file' };
  await render({});
  expect(node.textContent).toContain('copy:reading-file');
  await render({ activity: 'planning', sessionId: null });
  expect(node.textContent).toContain(i18n.t('groupChat.speaking.planning'));
  expect(h.copy).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
  await render({ activity: 'step', sessionId: 's2' });
  expect(node.textContent).toContain(i18n.t('groupChat.speaking.step'));
});

it('shows the teammate’s pending prompt inline instead of the working line', async () => {
  h.pending.s1 = [{ request: { requestId: 'r1', kind: 'permission' } }];
  await render({});
  expect(h.panel).toMatchObject({ companion: true, embedded: true, deviceId: 'mac', sessionId: 's1', interactions: h.pending.s1 });
  expect(h.panel.companionIdentity.name).toBe('阿布');
  expect(node.querySelector('[data-testid="status"]')).toBeNull();
});

it('says it is waiting when the host reports a prompt the phone cannot show yet', async () => {
  h.live.s1 = { sessionId: 's1', phase: 'needs-interaction', compactDetail: '' };
  await render({});
  expect(node.querySelector('[data-testid="botGroup.speaking.waiting"]')?.textContent).toBe(i18n.t('groupChat.waitingConfirm', { name: identity.name }));
  expect(h.panel).toBeNull();
});

it('does not subscribe without a lane or while the computer is offline', async () => {
  await render({ sessionId: null, activity: 'planning' });
  await render({ online: false, sessionId: 's3' });
  expect(h.subscribe).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
});

// Regression: a group lane must open its original task on the correct computer.
it('opens the ordinary task with no companion wrapper or new execution', async () => {
  await render({ sessionId: 'group-lane', deviceId: 'studio', online: false });
  h.invoke.mockClear();
  await act(async () => node.querySelector('button')!.click());
  expect(h.push).toHaveBeenCalledWith({ pathname: '/sessions/[sessionId]', params: { sessionId: 'group-lane', deviceId: 'studio' } });
  expect(h.invoke).not.toHaveBeenCalled();
});

// Unit regression for PR #7233 / discussion_r4384096621: render a queued execution
// through the real i18n hook/catalog. The previous key-only mock hid missing keys;
// this minimal queued row must show localized copy instead of a resource path.
it.each([
  ['en', 'Getting started'],
  ['zh-CN', '正在开始'],
  ['zh-TW', '正在開始'],
  ['ja', '開始しています'],
  ['ko', '시작하는 중'],
])('localizes queued work with the real %s catalog', async (locale, expected) => {
  await i18n.changeLanguage(locale);
  await render({ executionStatus: 'queued' });
  expect(node.querySelector('[data-testid="status"]')?.textContent).toBe(expected);
});
