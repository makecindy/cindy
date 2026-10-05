// @vitest-environment jsdom
import { act, createElement as el, useEffect, useImperativeHandle, useRef, useState } from 'react';
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
  scroll: null as any,
  scrollToEnd: vi.fn(),
  markRead: vi.fn(),
  // Fake of the shared upload pipeline (useMobileLocalAttachments).
  local: null as any,
  discarded: [] as any[],
  deleted: [] as string[],
  keyboardAvoidingView: null as any,
  platform: { OS: 'ios' },
}));

vi.mock('react-native', () => {
  const box = (tag: string) => ({ children, testID, accessibilityLabel }: any) =>
    el(tag, { 'data-testid': testID, 'aria-label': accessibilityLabel }, children);
  return {
    View: box('div'), ScrollView: ({ ref, children, ...props }: any) => {
      h.scroll = props;
      useImperativeHandle(ref, () => ({ scrollToEnd: h.scrollToEnd }));
      return el('div', { 'data-testid': props.testID }, children);
    }, KeyboardAvoidingView: ({ children, ...props }: any) => {
      h.keyboardAvoidingView = props;
      return el('div', null, children);
    },
    Pressable: ({ children, onPress, disabled, testID, accessibilityLabel }: any) => el('button',
      { 'data-testid': testID, 'aria-label': accessibilityLabel, disabled, onClick: onPress },
      typeof children === 'function' ? children({ pressed: false }) : children),
    ActivityIndicator: () => el('i', { 'data-testid': 'spinner' }),
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    Platform: { get OS() { return h.platform.OS; }, select: (value: any) => value[h.platform.OS] },
    Alert: { alert: h.alert },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    Keyboard: { dismiss: () => {} },
    Animated: { View: box('div'), Value: class { setValue() {} interpolate() { return this; } }, timing: () => ({ start() {}, stop() {} }),
      loop: () => ({ start() {}, stop() {} }), sequence: () => ({}) },
    Easing: { inOut: () => undefined, ease: undefined, bezier: () => undefined },
  };
});
vi.mock('expo-router', () => ({
  useIsFocused: () => true,
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
  ['ChevronLeft', 'Settings2', 'Plus', 'Square', 'Users', 'X', 'Check', 'CircleAlert', 'CircleCheck', 'CircleDashed', 'FileText', 'Sparkles', 'Folder', 'Camera', 'Image',
    'Layers', 'ListChecks', 'Ellipsis', 'ChevronRight', 'ChevronDown']
    .map((name) => [name, () => null]),
));
vi.mock('@/theme', async () => ({
  ...await import('@/theme/tokens'), useThemedStyles: () => ({}), useTheme: () => ({ colors: {} }), monoFont: 'mono',
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({
  user: { id: 'owner' }, accountGeneration: 1, getAccessToken: async () => 'token', apiFetch: async () => ({}),
}) }));
vi.mock('@/utils/backGuard', () => ({ goBackGuarded: h.leave }));
vi.mock('@/device-link/remoteResourceCache', () => ({ markRemoteResourceRead: h.markRead }));
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
  BotGroupAvatar: () => null, BotGroupDuoAvatar: () => null,
  useBotGroupIdentities: () => (botId: string, fallbackName = '', member?: { name: string }) => ({ botId, name: fallbackName || member?.name || botId }),
}));
vi.mock('@/session/BotGroupSpeakerRow', () => ({
  BotGroupSpeakerRow: ({ identity, activity, sessionId }: any) => el('div', { 'data-testid': `speaker.${identity.botId}.${activity}`, 'data-session': sessionId }, identity.name),
}));
vi.mock('@/session/MobileComposerInputRow', () => ({
  // Like the real row: the card shows the tray above the input and the toolbar below it.
  MobileComposerInputRow: (props: any) => {
    h.row = props;
    return el('div', { 'data-testid': 'composer-row', 'data-card': props.cardActive ? 'true' : 'false' },
      props.cardActive ? props.accessoryAbove : props.leading,
      el('span', { 'data-testid': 'placeholder' }, props.placeholder),
      props.cardActive ? props.toolbar : props.trailing);
  },
  ComposerToolbarLeftGroup: ({ children }: any) => el('div', null, children),
  ComposerToolbarSpacer: () => null,
}));
vi.mock('@/session/useMobileLocalAttachments', () => ({
  useMobileLocalAttachments: (options: any) => {
    const [pendingUploads, setPending] = useState<any[]>([]);
    h.local.options = options;
    h.local.setPending = setPending;
    return {
      pendingUploads, pastePlaceholderCount: 0,
      addImages: h.local.addImages, addDocument: h.local.addDocument, addPastedImages: h.local.addPastedImages,
      beginPastePlaceholders: vi.fn(), failPastePlaceholders: vi.fn(), enqueueUploads: h.local.enqueueUploads,
      removePendingUpload: h.local.removePendingUpload, retryPendingUpload: vi.fn(),
      waitForPendingUploads: h.local.wait, releaseUploadedSources: h.local.release, getPendingUploadCount: () => pendingUploads.length,
    };
  },
}));
vi.mock('@/session/mobileAttachmentUpload', () => ({ discardMobileUploadedAttachment: (attachment: unknown) => h.discarded.push(attachment) }));
vi.mock('@/session/useContextSheetMediaAssets', () => ({ resolveContextSheetMediaAssetForUpload: vi.fn() }));
vi.mock('expo-file-system/legacy', () => ({ deleteAsync: async (uri: string) => { h.deleted.push(uri); } }));
vi.mock('@/session/ContextSheet', () => ({
  ContextSheet: ({ visible, children, media, error, title, testID }: any) => visible
    ? el('div', { 'data-testid': testID, 'aria-label': title }, media, children, error) : null,
  ContextSheetGroup: ({ label, children }: any) => el('section', { 'aria-label': label }, children),
  ContextSheetRow: ({ label, detail, onPress, disabled, testID }: any) => el('button',
    { 'data-testid': testID, disabled, onClick: onPress }, label, detail ? el('small', null, detail) : null),
}));
vi.mock('@/session/ContextSheetMediaViews', () => ({
  RecentPhotosStrip: ({ onToggleAsset, testID }: any) => el('button',
    { 'data-testid': testID, onClick: () => onToggleAsset({ id: 'asset-1', filename: 'IMG_1.HEIC', uri: 'ph://asset-1' }) }),
}));
vi.mock('@/session/ComposerAttachmentTray', () => ({
  ComposerAttachmentTray: ({ attachments, pendingUploads, onRemove, onRemovePending, removeDisabled, testIDPrefix }: any) => el('div',
    { 'data-testid': `${testIDPrefix}.attachmentTray` },
    ...attachments.map((item: any) => el('button', { key: item.id, 'data-testid': `tray.attachment.${item.id}`, disabled: removeDisabled, onClick: () => onRemove(item.id) }, item.name)),
    ...pendingUploads.map((item: any) => el('button', { key: item.localId, 'data-testid': `tray.pending.${item.localId}`, onClick: () => onRemovePending(item.localId) }, item.name))),
  ComposerAttachmentCollapsedBadge: ({ attachments, pendingUploads, onPress, testID }: any) => el('button',
    { 'data-testid': testID, onClick: onPress }, String(attachments.length + pendingUploads.length)),
}));
vi.mock('@/session/ImageLightbox', () => ({
  ImageLightbox: ({ images, initialUrl }: any) => el('div', { 'data-testid': 'lightbox', 'data-url': initialUrl, 'data-count': String(images.length) }),
}));
vi.mock('@/session/MessageRenderer', () => ({
  AttachmentStrip: ({ attachments, onOpen, align }: any) => el('div', { 'data-testid': 'attachmentStrip', 'data-align': align },
    attachments.map((item: any, index: number) => el('button', {
      key: index, 'data-testid': `attachment.${item.kind}`, 'data-uri': item.uri ?? '',
      onClick: () => onOpen(item.kind === 'image'
        ? { kind: 'media', media: { kind: 'image', url: item.uri, previewable: false } }
        : { kind: 'file', title: item.name, body: '' }),
    }, item.name))),
}));
vi.mock('@/session/useBotGroupRemoteMedia', () => ({ useBotGroupRemoteMedia: () => async () => { throw new Error('offline'); } }));
vi.mock('@/session/useHostTeammates', () => ({ useHostTeammates: () => h.teammates }));
vi.mock('@/session/useBotGroupChat', () => ({ useBotGroupChat: () => h.chat }));

vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('@/session/CompanionPresenceRing', () => ({ CompanionPresenceRing: () => null }));
vi.mock('@/session/ThinkingDots', () => ({ ThinkingDots: () => null }));
import { BotGroupChatScreen } from '@/session/BotGroupChatScreen';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const message = (id: string, sequence: number, overrides: Partial<BotGroupRemoteChatData['messages'][number]>) => ({
  id, sequence, kind: 'message' as const, authorKind: 'bot' as const, authorBotId: null, authorName: '', content: '',
  mentions: { all: false, botIds: [] }, noticeCode: null, planId: null, files: [], attachments: [], createdAt: sequence * 1000, ...overrides,
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
  h.platform.OS = 'ios'; h.keyboardAvoidingView = null;
  h.chat = { reload: vi.fn(), act: vi.fn(async () => ({ effects: [] })), online: true };
  h.discarded = []; h.deleted = [];
  h.local = {
    options: null, setPending: null,
    addImages: vi.fn(), addDocument: vi.fn(), addPastedImages: vi.fn(), enqueueUploads: vi.fn(),
    removePendingUpload: vi.fn(), release: vi.fn(), wait: vi.fn(async () => ({ failedCount: 0 })),
  };
  h.confirm.mockResolvedValue(true);
  node = document.createElement('div');
  root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });

describe('group timeline', () => {
  it('uses the shared Android keyboard avoidance behavior for the group composer', async () => {
    h.platform.OS = 'android';
    await render();
    expect(h.keyboardAvoidingView).toMatchObject({ enabled: true, behavior: 'height' });
  });

  it('waits for measured tail positioning before acknowledging replies, including new snapshots', async () => {
    vi.useFakeTimers();
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    expect(h.markRead).not.toHaveBeenCalled();
    await act(async () => {
      h.scroll.onLayout({ nativeEvent: { layout: { height: 500 } } });
      h.scroll.onContentSizeChange(400, 2000);
    });
    expect(h.scrollToEnd).toHaveBeenCalled();
    expect(h.markRead).not.toHaveBeenCalled();
    const scroll = (offsetY: number, contentHeight = 2000) => h.scroll.onScroll({ nativeEvent: {
      contentOffset: { y: offsetY }, contentSize: { height: contentHeight }, layoutMeasurement: { height: 500 },
    } });
    await act(async () => scroll(0));
    expect(h.markRead).not.toHaveBeenCalled();
    await act(async () => scroll(1500));
    expect(h.markRead).toHaveBeenLastCalledWith('owner', 'mac', 'g1', 7000);
    h.markRead.mockClear();
    const next = group();
    next.messages.push(message('new-reply', 10, { content: 'New reply' }));
    await render(next);
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    expect(h.markRead).not.toHaveBeenCalled();
    await act(async () => h.scroll.onContentSizeChange(400, 2500));
    expect(h.markRead).not.toHaveBeenCalled();
    await act(async () => scroll(2000, 2500));
    expect(h.markRead).toHaveBeenLastCalledWith('owner', 'mac', 'g1', 10000);
    h.markRead.mockClear();
    await act(async () => scroll(0, 2500));
    const newer = { ...next, messages: [...next.messages, message('newer-reply', 11, { content: 'Unread above tail' })] };
    await render(newer);
    await act(async () => h.scroll.onContentSizeChange(400, 3000));
    expect(h.markRead).not.toHaveBeenCalled();
  });

  it('acknowledges a short conversation only after both native dimensions are measured', async () => {
    vi.useFakeTimers();
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(32); h.scroll.onContentSizeChange(400, 300); });
    expect(h.markRead).not.toHaveBeenCalled();
    await act(async () => h.scroll.onLayout({ nativeEvent: { layout: { height: 500 } } }));
    expect(h.markRead).toHaveBeenLastCalledWith('owner', 'mac', 'g1', 7000);
  });

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
    expect(node.textContent).toContain('groupChat.followUp.failedStep(step=2)');
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

describe('group attachments', () => {
  const uploaded = (id: string, name: string, category: 'image' | 'pdf' = 'image') => ({
    id, name, path: `cindy-peer-attach://${id}`, ext: category === 'image' ? '.jpg' : '.pdf', size: 10, category,
    mimeType: category === 'image' ? 'image/jpeg' : 'application/pdf', ...(category === 'image' ? { url: `cindy-peer-attach://${id}` } : {}),
  });
  /** The shared pipeline finishes an upload (what useMobileLocalAttachments reports). */
  async function finishUpload(attachment: ReturnType<typeof uploaded>, uri = `file:///tmp/${attachment.name}`) {
    await act(async () => {
      h.local.setPending([]);
      h.local.options.onUploaded(attachment, { kind: attachment.category === 'image' ? 'image' : 'file', uri, name: attachment.name, size: 10 }, 'l1');
    });
  }
  async function focusComposer() { await act(async () => { h.row.onFocus(); }); }

  it('offers no attachments when the computer does not support them, and ignores pasted images', async () => {
    await render(group({ openPlan: null }));
    expect(byId('botGroup.composer.menu.action.division')).not.toBeNull();
    await click('botGroup.composer.more');
    expect(byId('botGroup.contextSheet')).toBeNull();
    expect(byId('botGroup.contextSheetPhotoRow')).toBeNull();
    await act(async () => { h.row.onPasteImages(['file:///cache/cindy-composer-paste-1.png']); });
    expect(h.local.addPastedImages).not.toHaveBeenCalled();
    expect(h.deleted).toEqual(['file:///cache/cindy-composer-paste-1.png']);
    // Offline: the + stays the old disabled menu even on a computer that takes attachments.
    h.chat = { ...h.chat, online: false };
    await render(group({ openPlan: null, supportsAttachments: true }));
    expect(byId('botGroup.composer.menu')).not.toBeNull();
    expect(byId('botGroup.composer.more')?.disabled).toBe(true);
  });

  it('opens the 1:1 attachment panel with 安排分工 next to it, and keeps the plan condition', async () => {
    await render(group({ openPlan: null, supportsAttachments: true }));
    expect(byId('botGroup.composer.menu')).toBeNull();
    await click('botGroup.composer.more');
    expect(byId('botGroup.contextSheet')?.getAttribute('aria-label')).toBe('groupChat.composer.more');
    for (const row of ['botGroup.contextSheetPhotos', 'botGroup.contextSheetPhotoRow', 'botGroup.contextSheetCameraRow', 'botGroup.contextSheetFileRow']) {
      expect(byId(row)).not.toBeNull();
    }
    expect(node.textContent).toContain('session.common.photo');
    await click('botGroup.contextSheetCameraRow');
    expect(h.local.addImages).toHaveBeenLastCalledWith('camera');
    await click('botGroup.contextSheetFileRow');
    expect(h.local.addDocument).toHaveBeenCalled();
    await click('botGroup.contextSheetDivisionRow');
    expect(byId('botGroup.divisionTag')).not.toBeNull();
    // A tap in the recent-photo strip queues that photo through the shared pipeline.
    await click('botGroup.contextSheetPhotos');
    expect(h.local.enqueueUploads).toHaveBeenCalledWith([expect.objectContaining({ kind: 'image', uri: 'ph://asset-1', sourceId: 'asset-1' })], expect.anything());
    // While a plan runs the row explains why instead of adding the tag.
    const running = group({ supportsAttachments: true,
      openPlan: { id: 'p1', status: 'running', currentStep: 0, stepCount: 2, currentBotName: '咪咪', currentStepStatus: 'running' } });
    running.plans[0] = { ...running.plans[0]!, status: 'running', currentStep: 0 };
    await render(running);
    await click('botGroup.composer.more');
    expect(byId('botGroup.contextSheetDivisionRow')?.disabled).toBe(true);
    expect(byId('botGroup.contextSheetDivisionRow')?.textContent).toContain('groupChat.composer.divisionBusy');
  });

  it('shows a picked photo as pending, then sends the upload with the text', async () => {
    h.local.addImages.mockImplementation(async () => {
      h.local.setPending([{ localId: 'l1', kind: 'image', previewUri: 'file:///tmp/a.jpg', name: 'a.jpg', size: 10 }]);
      h.local.options.onPicked();
    });
    await render(group({ openPlan: null, supportsAttachments: true }));
    await click('botGroup.composer.more');
    await click('botGroup.contextSheetPhotoRow');
    expect(h.local.addImages).toHaveBeenLastCalledWith('library');
    expect(byId('botGroup.contextSheet')).toBeNull();
    // Collapsed: a badge next to +; focused: the tray inside the card.
    expect(byId('botGroup.attachmentCollapsedBadge')?.textContent).toBe('1');
    await focusComposer();
    expect(byId('composer-row')?.getAttribute('data-card')).toBe('true');
    expect(byId('tray.pending.l1')?.textContent).toBe('a.jpg');
    // Sending waits for the upload and carries it.
    const photo = uploaded('att-1', 'a.jpg');
    h.local.wait.mockImplementationOnce(async () => { await finishUpload(photo); return { failedCount: 0 }; });
    await act(async () => { h.row.onChangeText('看看这张'); });
    await click('botGroup.composer.send');
    expect(h.chat.act).toHaveBeenLastCalledWith('send', {
      text: '看看这张', mentions: { all: false, botIds: [] }, clientId: 'uuid-1', attachments: [photo],
    });
    // Sent attachments leave the tray and are not reclaimed by the phone (the computer took them).
    expect(byId('botGroup.attachmentTray')).toBeNull();
    expect(h.local.release).toHaveBeenCalledWith(['att-1']);
    expect(h.discarded).toEqual([]);
  });

  it('sends attachments without text and keeps them when the send fails', async () => {
    await render(group({ openPlan: null, supportsAttachments: true, round: { status: 'running', speakers: [], canContinue: false } }));
    const file = uploaded('att-2', 'spec.pdf', 'pdf');
    await finishUpload(file);
    await focusComposer();
    expect(byId('tray.attachment.att-2')).not.toBeNull();
    // With only an attachment the button sends, even while a round runs.
    expect(byId('botGroup.composer.stop')).toBeNull();
    h.chat.act.mockRejectedValueOnce(new Error('[NOT_CONNECTED] offline'));
    await click('botGroup.composer.send');
    expect(h.chat.act).toHaveBeenLastCalledWith('send', expect.objectContaining({ text: '', clientId: 'uuid-1', attachments: [file] }));
    expect(h.alert).toHaveBeenCalledWith('groupChat.composer.sendFailed');
    expect(byId('tray.attachment.att-2')).not.toBeNull();
    // The retry is the same message.
    await click('botGroup.composer.send');
    expect(h.chat.act).toHaveBeenLastCalledWith('send', expect.objectContaining({ clientId: 'uuid-1', attachments: [file] }));
    expect(byId('tray.attachment.att-2')).toBeNull();
  });

  it('does not send while an upload failed, and reclaims a removed upload', async () => {
    await render(group({ openPlan: null, supportsAttachments: true }));
    const photo = uploaded('att-3', 'b.jpg');
    await finishUpload(photo);
    await focusComposer();
    await act(async () => { h.row.onChangeText('配图'); });
    h.local.wait.mockResolvedValueOnce({ failedCount: 1 });
    await click('botGroup.composer.send');
    expect(h.chat.act).not.toHaveBeenCalled();
    expect(h.row.value).toBe('配图');
    await click('tray.attachment.att-3');
    expect(h.discarded).toEqual([photo]);
    expect(byId('botGroup.attachmentTray')).toBeNull();
  });

  it('reclaims unsent uploads when the chat closes', async () => {
    await render(group({ openPlan: null, supportsAttachments: true }));
    const photo = uploaded('att-4', 'c.jpg');
    await finishUpload(photo);
    await act(async () => root.unmount());
    expect(h.discarded).toEqual([photo]);
    root = createRoot(node);
  });

  it('shows attached pictures and files in the timeline without an empty bubble', async () => {
    const data = group();
    data.messages = [
      message('a1', 1, { authorKind: 'user', content: '', attachments: [
        { id: 'x1', name: 'shot.png', category: 'image', mimeType: 'image/png', size: 5, url: 'cindy-media://blobs/abc.png', path: null },
        { id: 'x2', name: 'brief.pdf', category: 'pdf', mimeType: 'application/pdf', size: 9, url: null, path: null },
      ] }),
      message('a2', 2, { authorKind: 'user', content: '文字和图', attachments: [
        { id: 'x3', name: 'more.jpg', category: 'image', mimeType: 'image/jpeg', size: 5, url: 'cindy-media://blobs/def.jpg', path: null },
      ] }),
    ];
    await render(data);
    const users = all('botGroup.message.user');
    expect(users).toHaveLength(2);
    expect(users[0]!.querySelector('[data-testid="botGroup.message.userBubble"]')).toBeNull();
    expect(users[1]!.querySelector('[data-testid="botGroup.message.userBubble"]')?.textContent).toBe('文字和图');
    const strip = users[0]!.querySelector('[data-testid="attachmentStrip"]')!;
    expect(strip.getAttribute('data-align')).toBe('right');
    const image = strip.querySelector('[data-testid="attachment.image"]') as HTMLButtonElement;
    expect(image.getAttribute('data-uri')).toBe('cindy-media://blobs/abc.png');
    await act(async () => { image.click(); });
    expect(byId('lightbox')?.getAttribute('data-url')).toBe('cindy-media://blobs/abc.png');
    expect(byId('lightbox')?.getAttribute('data-count')).toBe('1');
    const file = strip.querySelector('[data-testid="attachment.file"]') as HTMLButtonElement;
    expect(file.textContent).toBe('brief.pdf');
    await act(async () => { file.click(); });
    expect(h.alert).toHaveBeenCalledWith('brief.pdf', 'groupChat.files.onComputer');
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
    // The organizer is not offered again; each member row opens its own menu.
    expect(byId('botGroup.settings.memberMenu.mimi.action.organizer:mimi')).toBeNull();
    await click('botGroup.settings.memberMenu.abu.action.organizer:abu');
    expect(h.chat.act).toHaveBeenLastCalledWith('update', { organizerBotId: 'abu' });
    await click('botGroup.settings.memberMenu.xiaoman.action.remove:xiaoman');
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
    expect(byId('botGroup.settings.memberMenu.abu.action.remove:abu')?.disabled).toBe(true);
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
