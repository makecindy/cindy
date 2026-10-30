// @vitest-environment jsdom
import { act, createElement as el, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotGroupRemoteChatData } from '@cindy/maker-shared/botGroupChat';

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
  openLink: vi.fn(async () => undefined),
  availability: vi.fn(() => true),
  resourceChanged: vi.fn(() => () => {}),
}));

vi.mock('react-native', () => ({
  View: ({ children, testID, accessibilityLabel }: any) => el('div', { 'data-testid': testID, 'aria-label': accessibilityLabel }, children),
  ScrollView: ({ children, testID }: any) => el('div', { 'data-testid': testID }, children),
  Pressable: ({ children, testID, onPress, accessibilityLabel, accessibilityState }: any) => el('button', {
    'data-testid': testID, 'aria-label': accessibilityLabel, 'aria-expanded': accessibilityState?.expanded, onClick: onPress,
  }, children),
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: ({ action }: any) => el('button', { onClick: action.onPress }, action.label) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: h.push }), useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) }));
vi.mock('lucide-react-native', () => ({ CircleAlert: () => null, Sparkles: () => null, ChevronDown: () => null, ChevronUp: () => null }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}), useTheme: () => ({ colors: {} }), iconStroke: { regular: 1.5 } }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => el('span', null, children) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke, subscribe: h.subscribe, unsubscribe: h.unsubscribe,
  openLink: h.openLink, getPresenceAvailability: h.availability, onRemoteResourceChanged: h.resourceChanged }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: 1 }) }));
vi.mock('@/device-link/remoteResources', () => ({ getRemoteResource: vi.fn(async () => null) }));
vi.mock('@/session/botGroupRemote', () => ({ BOT_GROUP_CLIENT_PRIMITIVES: [], botGroupChatDataFromResource: () => null, botGroupResourceRef: (id: string) => ({ id }) }));
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
import { BotGroupWorkArea } from '@/session/BotGroupWorkArea';
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
  ['en', 'Queued'],
  ['zh-CN', '排队中'],
  ['zh-TW', '排隊中'],
  ['ja', '待機中'],
  ['ko', '대기 중'],
])('localizes queued work with the real %s catalog', async (locale, expected) => {
  await i18n.changeLanguage(locale);
  await render({ executionStatus: 'queued' });
  expect(node.querySelector('[data-testid="status"]')?.textContent).toBe(expected);
});

// 测试价值：真实 BotGroupWorkArea + BotGroupSpeakerRow 的收起、展开与交互到达。
// Bug：2026-10-30 用户视频中离线伙伴的「正在开始」长期挤占群消息区域。
// 缺口：原用例只挂载单个始终可见的 SpeakerRow，没有经过工作区收起入口。
// 最小输入：两位伙伴，排队/运行各一条；收起后收到自己的待确认交互。
// tier：unit，原生宿主和远端读取用内存 fake，不连接网络。
// 实测耗时：该文件单独运行 1.41 秒（14 项用例）；旧实现下新增的 3 项工作区用例失败。
function workGroup(): BotGroupRemoteChatData {
  return { id: 'group', members: [{ botId: 'abu', name: '阿布', isOwned: true }, { botId: 'other', name: '其他伙伴', isOwned: false }],
    round: { status: 'running', speakers: [
      { botId: 'abu', sessionId: 's1', executionId: 'e1', executionStatus: 'queued', activity: 'reply' },
      { botId: 'other', sessionId: 's2', executionId: 'e2', executionStatus: 'running', activity: 'reply' },
    ] } } as BotGroupRemoteChatData;
}
async function renderWork(group: BotGroupRemoteChatData, online = true) {
  await act(async () => root.render(el(BotGroupWorkArea, { group, deviceId: 'mac', online, identityFor: (botId, name) => ({ botId, name }), onError: vi.fn() })));
}
const toggle = () => node.querySelector<HTMLButtonElement>('[data-testid="botGroup.work.toggle"]')!;

it('collapses queued and running work into one disclosure, including offline work', async () => {
  const group = workGroup();
  // Two executions for one teammate must not inflate the teammate count.
  group.round.speakers.push({ ...group.round.speakers[1], executionId: 'e3', executionStatus: 'queued' });
  await renderWork(group, false);
  expect(toggle().textContent).toBe('排队 1 · 进行中 1');
  expect(node.querySelectorAll('[data-testid="botGroup.speaking"]')).toHaveLength(0);
  await act(async () => toggle().click());
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  expect(node.textContent).toContain('阿布');
  expect(node.textContent).toContain('其他伙伴');
  expect(node.textContent).toContain('排队中');
  await act(async () => toggle().click());
  expect(node.querySelectorAll('[data-testid="botGroup.speaking"]')).toHaveLength(0);
});

it('keeps collapsed lanes subscribed and reveals only owned prompts as they arrive', async () => {
  h.invoke.mockResolvedValue([]);
  const group = workGroup();
  group.round.speakers[1].executionStatus = 'needs_input';
  await renderWork(group);
  expect(node.querySelectorAll('[data-testid="botGroup.speaking"]')).toHaveLength(0);
  expect(h.subscribe).toHaveBeenCalledWith(expect.any(String), 'mac', ['session:s1']);
  h.pending.s1 = [{ request: { requestId: 'permission', kind: 'permission' } }];
  await renderWork(group);
  expect(node.querySelector('[data-testid="panel"]')).not.toBeNull();
  expect(node.textContent).toContain('阿布');
  expect(node.textContent).not.toContain('其他伙伴');
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  h.pending.s1 = [];
  await renderWork(group);
  expect(node.querySelectorAll('[data-testid="botGroup.speaking"]')).toHaveLength(0);
  group.round.speakers[0].executionStatus = 'needs_input';
  await renderWork(group, false);
  expect(node.querySelector('[data-testid="botGroup.speaking.waiting"]')).not.toBeNull();
});

it('clears expanded details when the round finishes and when switching groups', async () => {
  const group = workGroup();
  await renderWork(group);
  await act(async () => toggle().click());
  await renderWork({ ...group, id: 'another-group' });
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  await act(async () => toggle().click());
  await renderWork({ ...group, id: 'another-group', round: { ...group.round, status: 'idle', speakers: [] } });
  expect(node.textContent).toBe('');
  await renderWork({ ...group, id: 'another-group' });
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
});
