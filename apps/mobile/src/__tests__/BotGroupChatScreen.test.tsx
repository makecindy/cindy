// @vitest-environment jsdom
import { act, createElement as el, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotGroupRemoteChatData } from '@cindy/maker-shared/botGroupChat';

const h = vi.hoisted(() => ({
  chat: null as any,
  alert: vi.fn(),
  confirm: vi.fn(),
  leave: vi.fn(),
  row: null as any,
  inputs: {} as Record<string, any>,
  teammates: { rows: [] as any[], loading: false, failed: false },
  uuid: 0,
}));

vi.mock('react-native', () => {
  const box = (tag: string) => ({ children, testID, accessibilityLabel }: any) =>
    el(tag, { 'data-testid': testID, 'aria-label': accessibilityLabel }, children);
  return {
    View: box('div'), ScrollView: box('div'), KeyboardAvoidingView: box('div'),
    Pressable: ({ children, onPress, disabled, testID, accessibilityLabel }: any) => el('button',
      { 'data-testid': testID, 'aria-label': accessibilityLabel, disabled, onClick: onPress },
      typeof children === 'function' ? children({ pressed: false }) : children),
    ActivityIndicator: () => el('i', { 'data-testid': 'spinner' }),
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    Platform: { OS: 'ios', select: (value: any) => value.ios },
    Alert: { alert: h.alert },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  };
});
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ back: vi.fn(), replace: vi.fn() }),
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: any) => el('main', null, children) }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => options
      ? `${key}(${Object.entries(options).map(([name, value]) => `${name}=${String(value)}`).join(',')})`
      : key,
    i18n: { language: 'zh-CN' },
  }),
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++h.uuid}` }));
vi.mock('lucide-react-native', () => Object.fromEntries(
  ['ChevronLeft', 'Settings2', 'Plus', 'Square', 'Users', 'X', 'Check', 'CircleAlert', 'CircleCheck', 'CircleDashed', 'FileText', 'Sparkles', 'Folder']
    .map((name) => [name, () => null]),
));
vi.mock('@/theme', () => ({
  useThemedStyles: () => ({}), useTheme: () => ({ colors: {} }), fontWeight: {}, iconStroke: {}, monoFont: 'mono',
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' }, accountGeneration: 1 }) }));
vi.mock('@/utils/backGuard', () => ({ goBackGuarded: h.leave }));
vi.mock('@/device-link/remoteResourceAvailability', () => ({ readRemoteCollectionCache: () => [] }));
vi.mock('@/platform/chrome', () => ({ showConfirm: h.confirm }));
vi.mock('@/platform/chrome/NativePullDownMenu', () => ({
  usesNativePullDownMenu: () => true,
  NativePullDownMenu: ({ actions, onAction, children, testID, disabled }: any) => {
    const flat = (list: any[]): any[] => list.flatMap((action) => action.subactions ? flat(action.subactions) : [action]);
    return el('div', { 'data-testid': testID }, children, disabled ? null : flat(actions).map((action) => el('button', {
      key: action.id, 'data-testid': `${testID}.action.${action.id}`, 'data-state': action.state, disabled: action.disabled,
      onClick: () => onAction(action.id),
    }, action.title)));
  },
}));
vi.mock('@/components/AppText', () => ({
  Text: ({ children, testID }: any) => el('span', { 'data-testid': testID }, children),
  TextInput: ({ testID, ...props }: any) => { h.inputs[testID] = props; return el('input', { 'data-testid': testID, value: props.value ?? '', readOnly: true }); },
}));
vi.mock('@/components/PaperPlaneIcon', () => ({ PaperPlaneIcon: () => null }));
vi.mock('@/components/MobilePrimitives', () => ({
  MainWindowActionButton: ({ action }: any) => el('button', {
    'data-testid': action.testID, 'aria-label': action.accessibilityLabel, 'aria-busy': action.busy ? 'true' : undefined,
    disabled: action.disabled || action.busy || !action.onPress, onClick: action.onPress,
  }, action.label),
  MainWindowOptionButton: ({ label, onPress, selected, disabled, testID }: any) => el('button',
    { 'data-testid': testID, 'aria-pressed': selected, disabled, onClick: onPress }, label),
  MainWindowRowButton: ({ children, onPress, testID }: any) => el('button', { 'data-testid': testID, onClick: onPress }, children),
  MainWindowEmptyState: ({ title, copy, children, testID }: any) => el('section', { 'data-testid': testID }, title, copy, children),
}));
vi.mock('@/session/HomeHeaderGlassButton', () => ({
  HomeHeaderGlassButton: ({ onPress, testID, disabled, children }: any) => el('button', { 'data-testid': testID, disabled, onClick: onPress }, children),
}));
vi.mock('@/session/CompanionSheet', () => ({
  CompanionSheet: ({ visible, children, onClosed, testID }: any) => {
    const was = useRef(visible);
    useEffect(() => { if (was.current && !visible) onClosed?.(); was.current = visible; }, [visible]);
    return visible ? el('div', { 'data-testid': testID }, children) : null;
  },
}));
vi.mock('@/session/BotGroupAvatars', () => ({
  BOT_GROUP_MESSAGE_AVATAR_SIZE: 28, BOT_GROUP_STEP_AVATAR_SIZE: 24, BOT_GROUP_INLINE_AVATAR_SIZE: 20, BOT_GROUP_ROW_AVATAR_SIZE: 32,
  BotGroupAvatar: () => null, BotGroupAvatarStack: () => null,
  useBotGroupIdentities: () => (botId: string, fallbackName = '', member?: { name: string }) => ({ botId, name: fallbackName || member?.name || botId }),
}));
vi.mock('@/session/BotGroupSpeakerRow', () => ({
  BotGroupSpeakerRow: ({ identity, activity, sessionId }: any) => el('div', { 'data-testid': `speaker.${identity.botId}.${activity}`, 'data-session': sessionId }, identity.name),
}));
vi.mock('@/session/MobileComposerInputRow', () => ({
  MobileComposerInputRow: (props: any) => { h.row = props; return el('div', { 'data-testid': 'composer-row' }, props.leading, el('span', { 'data-testid': 'placeholder' }, props.placeholder), props.trailing); },
}));
vi.mock('@/session/useHostTeammates', () => ({ useHostTeammates: () => h.teammates }));
vi.mock('@/session/useBotGroupChat', () => ({ useBotGroupChat: () => h.chat }));

import { BotGroupChatScreen } from '@/session/BotGroupChatScreen';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const message = (id: string, sequence: number, overrides: Partial<BotGroupRemoteChatData['messages'][number]>) => ({
  id, sequence, kind: 'message' as const, authorKind: 'bot' as const, authorBotId: null, authorName: '', content: '',
  mentions: { all: false, botIds: [] }, noticeCode: null, planId: null, files: [], createdAt: sequence * 1000, ...overrides,
});

function group(overrides: Partial<BotGroupRemoteChatData> = {}): BotGroupRemoteChatData {
  return {
    id: 'g1', name: '官网介绍页', replyMode: 'all', speakingMode: 'auto',
    members: [
      { botId: 'mimi', name: '咪咪', avatar: '🐱', avatarColor: 'red', status: 'active' },
      { botId: 'abu', name: '阿布', avatar: '🦉', avatarColor: 'blue', status: 'active' },
      { botId: 'xiaoman', name: '小满', avatar: '', avatarColor: '', status: 'active' },
    ],
    organizerBotId: 'mimi', projectDir: null, projectDirName: 'site', lastMessage: null, speakingBotIds: [], planningBotId: null,
    openPlan: { id: 'p1', status: 'proposed', currentStep: null, stepCount: 2, currentBotName: null, currentStepStatus: null },
    createdAt: 1, updatedAt: 2, hasMoreBefore: true,
    round: { status: 'idle', speakers: [], canContinue: true },
    messages: [
      message('m1', 1, { authorKind: 'user', content: '@咪咪 帮我做官网', mentions: { all: false, botIds: ['mimi'] } }),
      message('m2', 2, { authorBotId: 'mimi', authorName: '咪咪', content: '**好的**，我看看' }),
      message('m3', 3, { kind: 'round-end', authorKind: 'system' }),
      message('m4', 4, { kind: 'notice', authorKind: 'system', authorBotId: 'abu', authorName: '阿布', noticeCode: 'member-failed' }),
      message('m5', 5, { kind: 'round-end', authorKind: 'system' }),
      message('m6', 6, { kind: 'plan', authorBotId: 'mimi', authorName: '咪咪', planId: 'p1' }),
      message('m7', 7, { authorBotId: 'abu', authorName: '阿布', content: '写好了', planId: 'p0', files: ['docs/页面想法.md'] }),
      message('m8', 8, { kind: 'notice', authorKind: 'system', authorName: '阿布', noticeCode: 'member-timeout', planId: 'p0' }),
      message('m9', 9, { kind: 'plan-end', authorKind: 'system', planId: 'p0' }),
    ],
    plans: [
      { id: 'p1', status: 'proposed', organizerBotId: 'mimi', organizerName: '咪咪', currentStep: null, workDir: null, branch: null, createdAt: 1, updatedAt: 1,
        steps: [
          { position: 0, botId: 'mimi', botName: '咪咪', task: '想清楚这页讲什么', status: 'pending' },
          { position: 1, botId: 'abu', botName: '阿布', task: '写代码', status: 'pending' },
        ] },
      { id: 'p0', status: 'done', organizerBotId: 'mimi', organizerName: '咪咪', currentStep: 2, workDir: null, branch: null, createdAt: 1, updatedAt: 1,
        steps: [0, 1, 2].map((position) => ({ position, botId: 'abu', botName: '阿布', task: `步骤${position}`, status: 'done' as const })) },
    ],
    ...overrides,
  };
}

let root: Root;
let node: HTMLDivElement;
const byId = (id: string) => node.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
const all = (id: string) => [...node.querySelectorAll(`[data-testid="${id}"]`)];
async function click(id: string) {
  const target = byId(id);
  if (!target) throw new Error(`missing ${id}`);
  await act(async () => { target.click(); });
}
async function render(data: BotGroupRemoteChatData | null = group(), kind: 'ready' | 'loading' | 'missing' | 'error' = 'ready') {
  h.chat = {
    ...h.chat,
    state: kind === 'ready' ? { kind, group: data } : kind === 'error' ? { kind, message: 'x' } : { kind },
  };
  await act(async () => root.render(el(BotGroupChatScreen, { deviceId: 'mac', deviceName: 'Mac', groupId: 'g1' })));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.uuid = 0; h.inputs = {}; h.teammates = { rows: [], loading: false, failed: false };
  h.chat = { reload: vi.fn(), act: vi.fn(async () => ({ effects: [] })), online: true };
  h.confirm.mockResolvedValue(true);
  node = document.createElement('div');
  root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); });

describe('group timeline', () => {
  it('renders messages, notices, round ends and plan ends like the desktop timeline', async () => {
    await render();
    expect(byId('botGroup.message.user')?.textContent).toBe('@咪咪 帮我做官网');
    expect(all('botGroup.message.bot')[0]?.textContent).toContain('好的，我看看');
    expect(all('botGroup.message.bot')[0]?.textContent).not.toContain('**');
    const notices = all('botGroup.notice').map((entry) => entry.textContent);
    // A plain member failure speaks about a reply; inside a plan it speaks about a step.
    expect(notices).toEqual(['groupChat.notice.memberFailed(name=阿布)', 'groupChat.notice.stepTimeout(name=阿布)']);
    // Only the newest round end offers 继续讨论.
    expect(all('botGroup.roundEnd')).toHaveLength(2);
    expect(all('botGroup.continue')).toHaveLength(1);
    expect(byId('botGroup.planEnd')?.textContent).toBe('groupChat.timeline.planDone(count=3)');
    expect(byId('botGroup.file')?.textContent).toBe('页面想法.md');
    expect(byId('botGroup.olderOnComputer')).not.toBeNull();
    expect(byId('botGroup.organizerTag')?.textContent).toBe('groupChat.organizer');
    expect(node.textContent).toContain('咪咪groupChat.memberSeparator阿布groupChat.memberSeparator小满');
  });

  it('continues the round and explains files that stay on the computer', async () => {
    await render();
    await click('botGroup.continue');
    expect(h.chat.act).toHaveBeenCalledWith('continue');
    await click('botGroup.file');
    expect(h.alert).toHaveBeenCalledWith('docs/页面想法.md', 'groupChat.files.onComputer');
  });

  it('starts, dismisses and edits a proposed plan through the group actions', async () => {
    await render();
    expect(byId('botGroup.plan.proposed')).not.toBeNull();
    await click('botGroup.plan.start');
    expect(h.chat.act).toHaveBeenLastCalledWith('plan-start', { planId: 'p1' });
    await click('botGroup.plan.dismiss');
    expect(h.chat.act).toHaveBeenLastCalledWith('plan-dismiss', { planId: 'p1' });
    // The current Bot is checked; choosing it again changes nothing.
    expect(byId('botGroup.plan.stepMenu.1.action.member:abu')?.getAttribute('data-state')).toBe('on');
    await click('botGroup.plan.stepMenu.1.action.member:abu');
    expect(h.chat.act).toHaveBeenCalledTimes(2);
    await click('botGroup.plan.stepMenu.1.action.member:xiaoman');
    expect(h.chat.act).toHaveBeenLastCalledWith('plan-edit', { planId: 'p1', position: 1, action: 'reassign', botId: 'xiaoman' });
    await click('botGroup.plan.stepMenu.0.action.remove');
    expect(h.chat.act).toHaveBeenLastCalledWith('plan-edit', { planId: 'p1', position: 0, action: 'remove' });
  });

  it('keeps at least one step and names the host’s reason when an action is refused', async () => {
    const data = group();
    data.plans[0]!.steps = [data.plans[0]!.steps[0]!];
    h.chat.act.mockRejectedValueOnce(Object.assign(new Error('PLAN_CLOSED'), { code: 'INVALID_PARAMS' }));
    await render(data);
    expect(byId('botGroup.plan.stepMenu.0.action.remove')?.disabled).toBe(true);
    await click('botGroup.plan.start');
    expect(h.alert).toHaveBeenCalledWith('groupChat.errors.planClosed');
  });

  it('offers 继续 / 结束分工 after a finished step and reassigns only what is not done', async () => {
    const data = group({ openPlan: { id: 'p1', status: 'waiting', currentStep: 0, stepCount: 2, currentBotName: '咪咪', currentStepStatus: 'done' } });
    data.plans[0] = { ...data.plans[0]!, status: 'waiting', currentStep: 0,
      steps: [{ ...data.plans[0]!.steps[0]!, status: 'done' }, data.plans[0]!.steps[1]!] };
    await render(data);
    expect(byId('botGroup.plan.start')).toBeNull();
    expect(byId('botGroup.plan.stepMenu.0')).toBeNull();
    expect(byId('botGroup.plan.stepMenu.1.action.remove')).toBeNull();
    await click('botGroup.plan.stepMenu.1.action.member:xiaoman');
    expect(h.chat.act).toHaveBeenLastCalledWith('plan-edit', { planId: 'p1', position: 1, action: 'reassign', botId: 'xiaoman' });
    expect(byId('botGroup.followUpRow.continue')?.textContent).toContain('阿布');
    await click('botGroup.followUp.continue');
    expect(h.chat.act).toHaveBeenLastCalledWith('plan-continue', { planId: 'p1' });
    await click('botGroup.followUp.end');
    expect(h.chat.act).toHaveBeenLastCalledWith('plan-dismiss', { planId: 'p1' });
    expect(byId('placeholder')?.textContent).toBe('groupChat.composer.placeholderPlanWaiting(name=咪咪)');
  });

  it('offers 重试 when a step did not finish', async () => {
    const data = group({ openPlan: { id: 'p1', status: 'waiting', currentStep: 1, stepCount: 2, currentBotName: '阿布', currentStepStatus: 'failed' } });
    data.plans[0] = { ...data.plans[0]!, status: 'waiting', currentStep: 1,
      steps: [{ ...data.plans[0]!.steps[0]!, status: 'done' }, { ...data.plans[0]!.steps[1]!, status: 'failed' }] };
    await render(data);
    expect(byId('botGroup.followUp.retry')?.textContent).toContain('groupChat.timeline.retryStep');
    expect(node.textContent).toContain('groupChat.timeline.stepFailed(name=阿布)');
    await click('botGroup.followUp.retry');
    expect(h.chat.act).toHaveBeenLastCalledWith('plan-retry', { planId: 'p1' });
  });

  it('shows superseded and stopped plans read-only', async () => {
    const data = group({ openPlan: null });
    data.plans[0] = { ...data.plans[0]!, status: 'superseded' };
    await render(data);
    expect(byId('botGroup.plan.start')).toBeNull();
    expect(byId('botGroup.plan.stepMenu.0')).toBeNull();
    expect(byId('botGroup.plan.finalNote')?.textContent).toBe('groupChat.plan.superseded');
  });

  it('shows one row per speaker with its lane session', async () => {
    await render(group({ round: { status: 'running', canContinue: false, speakers: [
      { botId: 'abu', sessionId: 's-abu', activity: 'reply' },
      { botId: 'mimi', sessionId: null, activity: 'planning' },
      { botId: 'ghost', sessionId: 's-x', activity: 'reply' },
    ] } }));
    expect(byId('speaker.abu.reply')?.getAttribute('data-session')).toBe('s-abu');
    expect(byId('speaker.mimi.planning')).not.toBeNull();
    expect(byId('speaker.ghost.reply')).toBeNull();
    expect(all('botGroup.continue')).toHaveLength(0);
  });

  it('shows the unavailable and failed states', async () => {
    await render(null, 'missing');
    expect(byId('botGroup.unavailable')).not.toBeNull();
    await click('botGroup.leave');
    expect(h.leave).toHaveBeenCalled();
    await render(null, 'error');
    await click('botGroup.retry');
    expect(h.chat.reload).toHaveBeenCalled();
  });
});

describe('group composer', () => {
  async function type(text: string) {
    await act(async () => {
      h.row.onFocus();
      h.row.onChangeText(text);
      h.row.onSelectionChange({ nativeEvent: { selection: { start: text.length, end: text.length } } });
    });
  }

  it('offers 所有人 first, inserts a picked teammate and sends the resolved mentions', async () => {
    await render(group({ openPlan: null }));
    await type('请 @');
    const options = [...node.querySelectorAll('[data-testid^="botGroup.mention."]')].map((entry) => entry.getAttribute('data-testid'));
    expect(options).toEqual(['botGroup.mention.all', 'botGroup.mention.mimi', 'botGroup.mention.abu', 'botGroup.mention.xiaoman']);
    await click('botGroup.mention.abu');
    expect(h.row.value).toBe('请 @阿布 ');
    await type('请 @阿布 写代码');
    await click('botGroup.composer.send');
    expect(h.chat.act).toHaveBeenLastCalledWith('send', {
      text: '请 @阿布 写代码', mentions: { all: false, botIds: ['abu'] }, clientId: 'uuid-1',
    });
    expect(h.row.value).toBe('');
  });

  it('sends a 分工 message and keeps the clientId and tag for a retry', async () => {
    await render(group({ openPlan: null }));
    expect(byId('botGroup.divisionTag')).toBeNull();
    await click('botGroup.composer.menu.action.division');
    expect(byId('botGroup.divisionTag')).not.toBeNull();
    expect(byId('placeholder')?.textContent).toBe('groupChat.composer.placeholderDivision');
    await type('做个官网');
    h.chat.act.mockRejectedValueOnce(new Error('[NOT_CONNECTED] offline'));
    await click('botGroup.composer.send');
    expect(h.chat.act).toHaveBeenLastCalledWith('send', expect.objectContaining({ text: '做个官网', clientId: 'uuid-1', division: true }));
    expect(h.alert).toHaveBeenCalledWith('groupChat.composer.sendFailed');
    // The draft and its tag come back; the retry reuses the same idempotency key.
    expect(h.row.value).toBe('做个官网');
    expect(byId('botGroup.divisionTag')).not.toBeNull();
    await click('botGroup.composer.send');
    expect(h.chat.act).toHaveBeenLastCalledWith('send', expect.objectContaining({ clientId: 'uuid-1', division: true }));
    expect(byId('botGroup.divisionTag')).toBeNull();
    // Removing the tag makes it a different message with its own key.
    await click('botGroup.composer.menu.action.division');
    await type('再做一个');
    h.chat.act.mockRejectedValueOnce(new Error('[NOT_CONNECTED] offline'));
    await click('botGroup.composer.send');
    expect(h.chat.act.mock.calls.at(-1)![1]).toMatchObject({ clientId: 'uuid-2', division: true });
    await click('botGroup.divisionTag.remove');
    await click('botGroup.composer.send');
    const last = h.chat.act.mock.calls.at(-1)![1];
    expect(last).toMatchObject({ text: '再做一个', clientId: 'uuid-3' });
    expect(last).not.toHaveProperty('division');
  });

  it('explains why 安排分工 is unavailable while a plan runs, and stops the round when empty', async () => {
    const data = group({
      openPlan: { id: 'p1', status: 'running', currentStep: 0, stepCount: 2, currentBotName: '咪咪', currentStepStatus: 'running' },
      round: { status: 'running', speakers: [{ botId: 'mimi', sessionId: 's1', activity: 'step' }], canContinue: false },
    });
    data.plans[0] = { ...data.plans[0]!, status: 'running', currentStep: 0, steps: [{ ...data.plans[0]!.steps[0]!, status: 'running' }, data.plans[0]!.steps[1]!] };
    await render(data);
    expect(byId('botGroup.composer.menu')).toBeNull();
    await click('botGroup.composer.more');
    expect(h.alert).toHaveBeenCalledWith('groupChat.composer.division', 'groupChat.composer.divisionBusy');
    expect(byId('placeholder')?.textContent).toBe('groupChat.composer.placeholderPlanRunning(name=咪咪)');
    await click('botGroup.composer.stop');
    expect(h.chat.act).toHaveBeenLastCalledWith('stop');
  });
});

describe('group settings', () => {
  async function openSettings(data = group()) {
    await render(data);
    await click('botGroup.settingsButton');
    expect(byId('botGroup.settings')).not.toBeNull();
  }

  it('renames, changes the organizer and edits members on this computer', async () => {
    h.teammates = { rows: [{ key: 'k', host: { deviceId: 'mac', deviceName: 'Mac' }, item: {
      ref: { collectionId: 'teammates', kind: 'bot', id: 'ahua' }, revision: '1', display: { title: '阿花' }, links: [],
    } }, { key: 'k2', host: { deviceId: 'mac', deviceName: 'Mac' }, item: {
      ref: { collectionId: 'teammates', kind: 'bot', id: 'abu' }, revision: '1', display: { title: '阿布' }, links: [],
    } }], loading: false, failed: false };
    await openSettings();
    await act(async () => { h.inputs['botGroup.settings.name'].onChangeText('新名字'); });
    await act(async () => { h.inputs['botGroup.settings.name'].onBlur(); });
    expect(h.chat.act).toHaveBeenLastCalledWith('update', { name: '新名字' });
    expect(byId('botGroup.settings.organizer.mimi')).toBeNull();
    await click('botGroup.settings.organizer.abu');
    expect(h.chat.act).toHaveBeenLastCalledWith('update', { organizerBotId: 'abu' });
    await click('botGroup.settings.remove.xiaoman');
    expect(h.chat.act).toHaveBeenLastCalledWith('set-members', { botIds: ['mimi', 'abu'] });
    await click('botGroup.settings.add');
    // Current members are not offered again.
    expect(byId('botGroup.settings.addable.abu')).toBeNull();
    await click('botGroup.settings.addable.ahua');
    expect(h.chat.act).toHaveBeenLastCalledWith('set-members', { botIds: ['mimi', 'abu', 'xiaoman', 'ahua'] });
  });

  it('switches reply and speaking modes, shows the folder read-only, and reports failures', async () => {
    await openSettings();
    expect(byId('botGroup.settings.projectDir')?.textContent).toContain('site');
    expect(byId('botGroup.settings.projectDir')?.textContent).toContain('groupChat.settings.projectDirOnComputer');
    await click('botGroup.settings.replyMode.all');
    expect(h.chat.act).not.toHaveBeenCalled();
    await click('botGroup.settings.replyMode.mentioned');
    expect(h.chat.act).toHaveBeenLastCalledWith('update', { replyMode: 'mentioned' });
    h.chat.act.mockRejectedValueOnce(new Error('[INVALID_PARAMS] MEMBER_LIMIT'));
    await click('botGroup.settings.speakingMode.sequential');
    expect(h.chat.act).toHaveBeenLastCalledWith('update', { speakingMode: 'sequential' });
    expect(node.textContent).toContain('groupChat.errors.memberLimit');
  });

  it('keeps two members at least', async () => {
    const data = group();
    data.members = data.members.slice(0, 2);
    await openSettings(data);
    expect(byId('botGroup.settings.remove.abu')?.disabled).toBe(true);
  });

  it('deletes after the system confirmation, then leaves once the sheet has closed', async () => {
    h.confirm.mockResolvedValueOnce(false);
    await openSettings();
    await click('botGroup.settings.delete');
    expect(h.chat.act).not.toHaveBeenCalled();
    await click('botGroup.settings.delete');
    expect(h.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ destructive: true, confirmLabel: 'groupChat.settings.delete' }));
    expect(h.chat.act).toHaveBeenLastCalledWith('delete', {});
    expect(byId('botGroup.settings')).toBeNull();
    expect(h.leave).toHaveBeenCalledOnce();
    // The later re-read that finds the group gone does not leave a second time.
    await render(null, 'missing');
    expect(h.leave).toHaveBeenCalledOnce();
  });

  it('still leaves when the group reads as gone before the delete returns', async () => {
    let finish!: () => void;
    h.chat.act.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ effects: [] }); }));
    await openSettings();
    await click('botGroup.settings.delete');
    // The computer's change announcement re-reads the group first, which unmounts the sheet.
    await render(null, 'missing');
    expect(byId('botGroup.settings')).toBeNull();
    expect(h.leave).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    expect(h.leave).toHaveBeenCalledOnce();
  });
});

describe('offline computer', () => {
  it('says the computer is offline instead of spinning, and disables actions on a loaded group', async () => {
    h.chat = { ...h.chat, online: false };
    await render(null, 'loading');
    expect(byId('botGroup.offline')?.textContent).toContain('devices.resources.hostOffline');
    expect(byId('spinner')).toBeNull();
    await render();
    expect(byId('botGroup.offlineNote')).not.toBeNull();
    expect(byId('botGroup.plan.start')?.disabled).toBe(true);
    expect(byId('botGroup.continue')?.disabled).toBe(true);
    expect(h.row.editable).toBe(false);
  });
});
