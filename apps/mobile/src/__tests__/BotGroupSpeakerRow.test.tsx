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
  focused: true,
}));

vi.mock('react-native', () => ({
  View: ({ children, testID, accessibilityLabel }: any) => el('div', { 'data-testid': testID, 'aria-label': accessibilityLabel }, children),
  ScrollView: ({ children, testID }: any) => el('div', { 'data-testid': testID }, children),
  Pressable: ({ children, testID, onPress, accessibilityLabel, accessibilityState, disabled }: any) => el('button', {
    'data-testid': testID, 'aria-label': accessibilityLabel, 'aria-expanded': accessibilityState?.expanded, onClick: onPress, disabled,
  }, children),
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: ({ action }: any) => el('button', { onClick: action.onPress }, action.label) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: h.push }), useFocusEffect: (effect: () => void) => useEffect(() => h.focused ? effect() : undefined, [effect, h.focused]) }));
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
vi.mock('@/session/remoteSessionStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/session/remoteSessionStore')>();
  return { ...actual,
  remoteSessionStore: {
    ...actual.remoteSessionStore,
    subscribe: () => () => {},
    getSessionLiveActivity: (sessionId: string) => h.live[sessionId] ?? null,
    setPendingInteractions: h.setPending,
  },
  useSessionPendingInteractions: (sessionId: string) => h.pending[sessionId] ?? [],
}; });
vi.mock('@/session/useCompanionGenerationCopy', () => ({
  useCompanionGenerationCopy: (input: { phase: string | null; active: boolean }) => { h.copy(input); return input.active ? `copy:${input.phase}` : null; },
}));
vi.mock('@/session/TeammateProcess', () => ({ useTeammateElapsedTitle: () => 'Working', TeammateWorkSegment: ({ title, children }: any) => el('div', null, title, children), TeammateProcessLink: ({ title, onPress }: any) => el('button', { onClick: onPress }, title), TeammateProcess: ({ title, children }: any) => el('section', null, el('span', { 'data-testid': 'status' }, title), children) }));
vi.mock('@/session/BotGroupMessageText', () => ({ BotGroupMarkdownText: ({ content }: any) => el('p', null, content) }));
vi.mock('@/session/WorkingStatusText', () => ({ WorkingStatusText: ({ text }: any) => el('span', { 'data-testid': 'status' }, text) }));

vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('@/session/CompanionPresenceRing', () => ({ CompanionPresenceRing: () => null }));
vi.mock('@/session/BotGroupMenu', () => ({ BotGroupMenu: ({ children }: any) => children(() => {}) }));
vi.mock('@/session/ThinkingDots', () => ({ ThinkingDots: () => null }));
import { BotGroupSpeakerRow } from '@/session/BotGroupSpeakerRow';
import { BotGroupWorkArea } from '@/session/BotGroupWorkArea';
import i18n from '@/i18n';
import { remoteSessionStore } from '@/session/remoteSessionStore';

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
  h.focused = true;
  remoteSessionStore.clear();
  h.invoke.mockResolvedValue([{ request: { requestId: 'r1' } }]);
  node = document.createElement('div'); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });

it('follows the speaking lane while focused and seeds its pending prompts', async () => {
  await render({});
  expect(h.subscribe).toHaveBeenCalledWith(expect.stringMatching(/^bot-group-speaker:s1:focus:/), 'mac', ['session:s1']);
  expect(h.invoke).toHaveBeenCalledWith('mac', 'maker:get-pending-interactions', ['s1']);
  expect(h.setPending).toHaveBeenCalledWith('s1', [{ request: { requestId: 'r1' } }], { deviceId: 'mac' });
  // No observed phase must not falsely claim thinking.
  expect(node.textContent).toContain('Working');
  await act(async () => root.unmount());
  expect(h.unsubscribe).toHaveBeenCalledWith(expect.stringMatching(/^bot-group-speaker:s1:focus:/), 'mac', ['session:s1']);
  root = createRoot(node);
});

it('uses the live phase, and plain copy while planning or before a step reports one', async () => {
  h.live.s1 = { sessionId: 's1', phase: 'running', compactDetail: '', workingPhase: 'reading-file' };
  await render({});
  expect(node.textContent).toContain('Working');
  await render({ activity: 'planning', sessionId: null });
  expect(node.textContent).toContain(i18n.t('groupChat.speaking.planning'));
  expect(h.copy).not.toHaveBeenCalled();
  await render({ activity: 'step', sessionId: 's2' });
  expect(node.textContent).toContain('Working');
});

it('shows the teammate’s pending prompt inline instead of the working line', async () => {
  h.pending.s1 = [{ request: { requestId: 'r1', kind: 'permission' } }];
  await render({});
  expect(h.panel).toMatchObject({ companion: true, embedded: true, deviceId: 'mac', sessionId: 's1', interactions: h.pending.s1 });
  expect(h.panel.companionIdentity.name).toBe('阿布');
  expect(node.querySelector('[data-testid="panel"]')).not.toBeNull();
});

it('says it is waiting when the host reports a prompt the phone cannot show yet', async () => {
  h.live.s1 = { sessionId: 's1', phase: 'needs-interaction', compactDetail: '' };
  await render({});
  expect(node.querySelector('[data-testid="status"]')?.textContent).toContain(i18n.t('groupChat.waitingConfirm', { name: '' }));
  expect(h.panel).toBeNull();
});

it('does not subscribe without a lane or while the computer is offline', async () => {
  await render({ sessionId: null, activity: 'planning' });
  await render({ online: false, sessionId: 's3' });
  expect(h.subscribe).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
});

// Product decision: hide the whole-task shortcut; keep the execution's stop footer usable.
it('hides original-task navigation while keeping the group stop action available', async () => {
  const stop = vi.fn();
  await render({ sessionId: 'group-lane', deviceId: 'studio', online: false,
    footer: el('button', { onClick: stop }, 'Stop') });
  h.invoke.mockClear();
  expect(node.querySelectorAll('button')).toHaveLength(1);
  await act(async () => node.querySelector('button')!.click());
  expect(stop).toHaveBeenCalledOnce();
  expect(h.push).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
});

// Unit regression for PR #7233 / discussion_r4384096621: render a queued execution
// through the real i18n hook/catalog. The previous key-only mock hid missing keys;
// this minimal queued row must show localized copy instead of a resource path.
// PR #8088: cover all 12 catalogs so queued work never claims it has started.
it.each([
  ['en', 'Queued'],
  ['zh-CN', '排队中'],
  ['zh-TW', '排隊中'],
  ['ja', '待機中'],
  ['ko', '대기 중'],
  ['de', 'In der Warteschlange'],
  ['es', 'En cola'],
  ['fr', 'En attente'],
  ['pt-BR', 'Na fila'],
  ['pt-PT', 'Em fila'],
  ['zh-Hans-x-lzh', '待次'],
  ['zh-Hant-x-lzh', '待次'],
])('localizes queued work with the real %s catalog', async (locale, expected) => {
  await i18n.changeLanguage(locale);
  await render({ executionStatus: 'queued' });
  expect(node.querySelector('[data-testid="status"]')?.textContent).toContain(expected);
});

// 测试价值：真实 BotGroupWorkArea + BotGroupSpeakerRow 的收起、展开与交互到达。
// Bug：2026-10-30 用户视频中离线伙伴的「正在开始」长期挤占群消息区域。
// 缺口：原用例只挂载单个始终可见的 SpeakerRow，没有经过工作区收起入口。
// 最小输入：两位伙伴，排队/运行各一条；收起后收到自己的待确认交互。
// tier：unit，原生宿主和远端读取用内存 fake，不连接网络。
// 复验：保留主干消息工作租约回归；工作区用例覆盖离线、折叠与待确认恢复。
function workGroup(): BotGroupRemoteChatData {
  return { id: 'group', members: [{ botId: 'abu', name: '阿布', isOwned: true }, { botId: 'other', name: '其他伙伴', isOwned: false }],
    round: { status: 'running', speakers: [
      { botId: 'abu', sessionId: 's1', executionId: 'e1', executionStatus: 'queued', activity: 'reply' },
      { botId: 'other', sessionId: 's2', executionId: 'e2', executionStatus: 'running', activity: 'reply' },
    ] } } as BotGroupRemoteChatData;
}
async function renderWork(group: BotGroupRemoteChatData, online = true, controls: { onStop?: () => Promise<void>; stopping?: boolean } = {}) {
  await act(async () => root.render(el(BotGroupWorkArea, { group, deviceId: 'mac', online, identityFor: (botId, name) => ({ botId, name }), onError: vi.fn(), ...controls })));
}
// 测试价值：生产工作区必须逐 execution 连续可读（群聊 §5）；旧覆盖只验证按 Bot 收起。
// 最小失败输入：同一 Bot 排队 + 运行、另一位等待；两个自有 lane 的确认不在过程折叠内。
// tier: unit，沿用本文件内存远端与真实工作区入口。
it('shows every execution directly, including two executions for the same teammate offline', async () => {
  const group = workGroup();
  group.round.speakers.push({ ...group.round.speakers[0], executionId: 'e3', sessionId: 's3', executionStatus: 'running' });
  await renderWork(group, false);
  expect(node.querySelectorAll('[data-testid="botGroup.speaking"]')).toHaveLength(3);
  expect(node.querySelector('[data-testid="botGroup.work.toggle"]')).toBeNull();
  expect(node.textContent).toContain('排队中');
  expect(node.textContent).toContain('其他伙伴');
});

it('keeps both owned confirmations outside process folds and never reads another owner’s lane', async () => {
  h.invoke.mockResolvedValue([]);
  const group = workGroup();
  group.round.speakers.push({ ...group.round.speakers[0], executionId: 'e3', sessionId: 's3', executionStatus: 'needs_input' });
  group.round.speakers[0].executionStatus = 'needs_input';
  group.round.speakers[1].executionStatus = 'needs_input';
  h.pending.s1 = [{ request: { requestId: 'permission', kind: 'permission' } }];
  h.pending.s3 = [{ request: { requestId: 'question', kind: 'ask_user' } }];
  h.pending.s2 = [{ request: { requestId: 'foreign', kind: 'permission' } }];
  await renderWork(group);
  const panels = node.querySelectorAll('[data-testid="panel"]');
  expect(panels).toHaveLength(2);
  for (const panel of panels) expect(panel.closest('section')).toBeNull();
  expect(h.subscribe).toHaveBeenCalledWith(expect.any(String), 'mac', ['session:s1']);
  expect(h.subscribe).not.toHaveBeenCalledWith(expect.any(String), 'mac', ['session:s2']);
  expect(node.textContent).toContain('其他伙伴');
  expect(node.textContent).not.toContain('其他伙伴在等你确认');
});

it('removes live process entries when the round finishes', async () => {
  const group = workGroup();
  await renderWork(group);
  expect(node.querySelectorAll('[data-testid="botGroup.speaking"]')).toHaveLength(2);
  await renderWork({ ...group, round: { ...group.round, status: 'idle', speakers: [] } });
  expect(node.textContent).toBe('');
});

// Unit regression: real store refuses new text after task-detail blur unless
// the focused group owns a message lease. Previous row tests mocked this store.
it('keeps new stage text visible after returning from the task and releases it on blur', async () => {
  h.invoke.mockResolvedValue([]);
  const stop = vi.fn(async () => undefined);
  const props = { groupId: 'g1', executionId: 'exec', startedAt: 0, onStop: stop };
  await render(props);
  h.focused = false;
  await render(props);
  const task = remoteSessionStore.enterSessionMessageDetail('s1');
  remoteSessionStore.leaveSessionMessageDetail('s1', 'detail-blur', task);
  h.focused = true;
  await render(props);
  await act(async () => remoteSessionStore.applyMakerEvent('s1', {
    type: 'text', data: { text: 'New stage after return', isFullText: true, isFinal: false },
  }, 'continued'));
  expect(remoteSessionStore.getMessages('s1').some(message => message.content === 'New stage after return')).toBe(true);
  expect(node.textContent).toContain('New stage after return');
  h.focused = false;
  await render(props);
  await act(async () => remoteSessionStore.applyMakerEvent('s1', {
    type: 'text', data: { text: 'Late text after leaving', isFullText: true, isFinal: false },
  }, 'late'));
  expect(remoteSessionStore.getMessages('s1').some(message => message.content === 'Late text after leaving')).toBe(false);
});

// Integration regression: folding must retain the group stop without duplicating
// it per execution; one stopping speaker cannot disable other active work.
it('preserves exactly one group stop across disclosure and pending snapshots', async () => {
  const group = workGroup();
  group.round.speakers[1].executionStatus = 'stopping';
  const onStop = vi.fn(async () => undefined);
  const stopButton = () => node.querySelector<HTMLButtonElement>('[data-testid="botGroup.work.stop"]')!;
  await renderWork(group, true, { onStop });
  expect(node.querySelectorAll('[data-testid="botGroup.work.stop"]')).toHaveLength(1);
  expect(stopButton().disabled).toBe(false);
  await act(async () => stopButton().click());
  expect(onStop).toHaveBeenCalledTimes(1);
  await renderWork(group, true, { onStop, stopping: true });
  expect(stopButton().disabled).toBe(true);
  expect(node.querySelectorAll('[data-testid="botGroup.work.stop"]')).toHaveLength(1);
  expect(stopButton().disabled).toBe(true);
  expect(node.textContent).toContain('其他伙伴');
  await renderWork(group, false, { onStop });
  expect(node.querySelector('[data-testid="botGroup.work.stop"]')).toBeNull();
});

// Native acceptance found a waiting row still ending in a running placeholder.
// Unit: the real process projection must settle its pending stage outside the waiting card.
it('does not claim it is still thinking or processing while a confirmation is pending', async () => {
  h.invoke.mockResolvedValue([]);
  h.pending.s1 = [{ request: { requestId: 'permission', kind: 'permission' } }];
  await render({ groupId: 'g', executionId: 'e', startedAt: 1 });
  expect(node.textContent).toContain(i18n.t('groupChat.waitingConfirm', { name: '' }));
  expect(node.textContent).not.toContain(i18n.t('chat.teammateProcess.processing'));
  expect(node.textContent).not.toContain(i18n.t('chat.teammateProcess.thinking'));
});

// Unit: same-bot executions must not borrow the current step's task text (§8.2).
it.each([true, false])('labels only an unambiguous current step execution (identity supplied: %s)', async identified => {
  const group = workGroup();
  group.plans = [{ id: 'p', kind: 'work', status: 'running', currentStep: 0, steps: [
    { position: 0, status: 'running', botId: 'abu', task: 'Only the current execution', ...(identified ? { executionId: 'current' } : {}) },
  ] }] as any;
  group.round.speakers = [
    { botId: 'abu', activity: 'step', executionId: 'old', executionStatus: 'running', sessionId: null },
    { botId: 'abu', activity: 'step', executionId: 'current', executionStatus: 'running', sessionId: null },
    { botId: 'abu', activity: 'step', executionId: 'queued', executionStatus: 'queued', sessionId: null },
  ];
  await renderWork(group);
  const rows = node.querySelectorAll('section');
  expect(rows[0].textContent).not.toContain('Only the current execution');
  expect(rows[1].textContent?.includes('Only the current execution')).toBe(identified);
  expect(rows[2].textContent).not.toContain('Only the current execution');
});
