// @vitest-environment jsdom
import { act, createElement as el, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOT_GROUP_RUNTIME_FAILURE_CODES, type BotGroupRemoteChatData } from '@cindy/maker-shared/botGroupChat';

const h = vi.hoisted(() => ({
  chat: null as any,
  management: null as any,
  alert: vi.fn(),
  leaveGuard: [] as boolean[],
  leaveDecision: (async () => false) as () => Promise<boolean>,
  confirm: vi.fn(),
  leave: vi.fn(),
  focused: true,
  closeSettings: null as null | (() => void),
  row: null as any,
  inputs: {} as Record<string, any>,
  teammates: { rows: [] as any[], loading: false, failed: false },
  teammateQuery: '',
  uuid: 0,
  scroll: null as any,
  scrollToEnd: vi.fn(),
  markRead: vi.fn(),
  // Fake of the shared upload pipeline (useMobileLocalAttachments).
  local: null as any,
  discarded: [] as any[],
  deleted: [] as string[],
  keyboardAvoidingView: null as any,
  platform: { OS: 'ios' }, headerBlur: [] as number[], headerFade: [] as (number | undefined)[],
}));

vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => ({})) }));
vi.mock('@/components/ChatReplyIcon', () => ({ ChatReplyIcon: () => null }));
vi.mock('react-native', () => {
  const box = (tag: string) => ({ children, testID, accessibilityLabel, style }: any) =>
    el(tag, { 'data-testid': testID, 'aria-label': accessibilityLabel,
      style: { opacity: [style].flat().filter(Boolean).findLast((item: any) => item.opacity !== undefined)?.opacity } }, children);
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
    ActivityIndicator: ({ testID }: any) => el('i', { 'data-testid': testID ?? 'spinner' }),
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
  useIsFocused: () => h.focused,
  Stack: {
    Screen: ({ options }: any) => typeof options.headerTitle === 'function' ? options.headerTitle() : null,
    Toolbar: Object.assign(({ children }: any) => children, { View: ({ children }: any) => children }),
  },
  useRouter: () => ({ back: vi.fn(), replace: vi.fn() }),
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
}));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 72 }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: any) => el('main', null, children), useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }) }));
vi.mock('@/session/SessionHeaderNativeControls', () => ({ SessionHeaderNativeBlur: ({ height, fadeInside }: any) => { h.headerBlur.push(height); h.headerFade.push(fadeInside); return null; } }));
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
    'Layers', 'ListChecks', 'ListTodo', 'Ellipsis', 'ChevronRight', 'ChevronDown']
    .map((name) => [name, () => null]),
));
vi.mock('@/theme', async () => ({
  ...await import('@/theme/tokens'), useThemedStyles: (makeStyles: any) => makeStyles({}), useTheme: () => ({ colors: {} }), monoFont: 'mono',
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
vi.mock('@/session/useConfirmLeaveWhileUploading', () => ({ useConfirmLeaveWhileUploading: (active: boolean) => { h.leaveGuard.push(active); return () => h.leaveDecision(); } }));
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
  CompanionSheet: ({ visible, children, onClose, onClosed, testID }: any) => {
    if (testID === 'botGroup.settings') h.closeSettings = onClose;
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
  AttachmentStrip: ({ attachments, onOpen, onOpenFile, align }: any) => el('div', { 'data-testid': 'attachmentStrip', 'data-align': align },
    attachments.map((item: any, index: number) => el('button', {
      key: index, 'data-testid': `attachment.${item.kind}`, 'data-uri': item.uri ?? '',
      onClick: () => item.kind === 'file' && onOpenFile
        ? onOpenFile(attachments.slice(0, index).filter((attachment: any) => attachment.kind === 'file').length)
        : onOpen(item.kind === 'image'
        ? { kind: 'media', media: { kind: 'image', url: item.uri, previewable: false } }
        : { kind: 'file', title: item.name, body: '' }),
    }, item.name))),
}));
vi.mock('@/session/useBotGroupRemoteMedia', () => ({ useBotGroupRemoteMedia: () => async () => { throw new Error('offline'); } }));
vi.mock('@/session/useHostTeammates', () => ({ useHostTeammates: (_host: unknown, _enabled: boolean, query = '') => { h.teammateQuery = query; return h.teammates; } }));
vi.mock('@/session/useBotGroupChat', () => ({ useBotGroupChat: () => h.chat }));
vi.mock('@/session/useBotGroupSettingsManagement', () => ({ useBotGroupSettingsManagement: () => h.management ?? ({
  selected: undefined, managers: [], loading: false, reason: 'noHost', act: vi.fn(), select: vi.fn(), refresh: vi.fn(),
}) }));

vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('@/session/CompanionPresenceRing', () => ({ CompanionPresenceRing: () => null }));
vi.mock('@/session/ThinkingDots', () => ({ ThinkingDots: () => null }));
// The live card of my own teammate's task reads the computer over device-link; only which computer is under test.
const taskCardDevices = vi.hoisted(() => [] as string[]);
vi.mock('@/session/CompanionMessageCard', () => ({ CompanionTaskCard: ({ deviceId }: { deviceId: string }) => { taskCardDevices.push(deviceId); return null; } }));
import { BotGroupChatScreen } from '@/session/BotGroupChatScreen';
import { parseBotGroupChatData } from '@/session/botGroupRemote';

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
  h.management = null;
  vi.clearAllMocks();
  h.uuid = 0; h.inputs = {}; h.teammateQuery = ''; h.teammates = { rows: [], loading: false, failed: false };
  h.platform.OS = 'ios'; h.focused = true; h.keyboardAvoidingView = null; h.headerBlur = []; h.headerFade = [];
  h.chat = { reload: vi.fn(), act: vi.fn(async () => ({ effects: [] })), online: true };
  h.discarded = []; h.deleted = []; h.leaveGuard = []; h.leaveDecision = async () => false;
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
  it('shows a 引用回复 block from the loaded original, and only the author once it is deleted', async () => {
    // Server message ids are UUIDs; the parser rejects a quote that points at anything else.
    const originalId = '11111111-1111-4111-8111-111111111111';
    const quote = { messageId: originalId, authorName: '咪咪', authorKind: 'bot' as const, excerpt: 'old snapshot', attachmentCount: 0, attachmentName: null, sequence: 2 };
    // Through the same parser the phone uses for the computer's projection.
    const data = group();
    data.messages.push(message(originalId, 9, { authorBotId: 'mimi', authorName: '咪咪', content: '**好的**，我看看' }),
      message('q1', 10, { authorKind: 'user', content: '就按这个来', quote }));
    await render(parseBotGroupChatData(data)!);
    const block = byId('botGroup.quote')!;
    expect(block.textContent).toContain('咪咪');
    expect(block.textContent).toContain('**好的**，我看看');
    expect(block.textContent).not.toContain('old snapshot');
    const deleted = group();
    deleted.messages = [message(originalId, 9, { authorBotId: 'mimi', authorName: '咪咪', deleted: true, content: '（消息已删除）' }),
      message('q1', 10, { authorKind: 'user', content: '就按这个来', quote: { ...quote, excerpt: '私密的原文' } })];
    await render(parseBotGroupChatData(deleted)!);
    expect(byId('botGroup.quote')!.textContent).toContain('groupChat.quote.deleted');
    expect(node.textContent).not.toContain('私密的原文');
  });

  it('shows a task another owner\'s teammate started from the group as its posted title and state', async () => {
    const meta = { v: 1 as const, role: 'delegation-request' as const, delegationId: 'task-1', fromBotId: 'abu', fromBotName: '阿布', toBotId: null,
      toBotName: 'Cindy', parentSessionId: 'group-lane', childSessionId: 'child-1', objective: '写官网首页' };
    const data = group({ serverBacked: true, members: [
      { botId: 'mimi', name: '咪咪', avatar: '🐱', avatarColor: 'red', status: 'active', isOwned: true },
      { botId: 'abu', name: '阿布', avatar: '🦉', avatarColor: 'blue', status: 'active', isOwned: false },
    ] });
    data.messages.push(message('t1', 20, { authorBotId: 'abu', authorName: '阿布', content: '我开了个任务',
      task: { meta, state: 'waiting', title: '官网首页', summary: '首页要放几个案例？' } }));
    await render(parseBotGroupChatData(data)!);
    const card = byId('botGroup.task')!;
    expect(card.textContent).toContain('官网首页');
    expect(card.textContent).toContain('groupChat.task.state.waiting');
    expect(card.textContent).toContain('首页要放几个案例？');
    expect(byId('botGroup.task.live')).toBeNull();
  });

  it('opens my own teammate\'s task live in a group entered straight from the Chat Server, via the companion\'s home computer', async () => {
    const meta = { v: 1 as const, role: 'delegation-request' as const, delegationId: 'task-3', fromBotId: 'mimi', fromBotName: '咪咪', toBotId: null,
      toBotName: 'Cindy', parentSessionId: 'group-lane', childSessionId: 'child-3', objective: '写官网首页' };
    const data = group({ serverBacked: true, members: [
      { botId: 'mimi', name: '咪咪', avatar: '🐱', avatarColor: 'red', status: 'active', isOwned: true, homeDeviceId: 'pc' },
      { botId: 'abu', name: '阿布', avatar: '🦉', avatarColor: 'blue', status: 'active', isOwned: true, homeDeviceId: null },
    ] });
    data.messages.push(message('t3', 22, { authorBotId: 'mimi', authorName: '咪咪', content: '我开了个任务', task: { meta, state: 'started', title: '官网首页' } }),
      message('t4', 23, { authorBotId: 'abu', authorName: '阿布', content: '我也开了', task: { meta: { ...meta, delegationId: 'task-4', fromBotId: 'abu' }, state: 'started', title: '整理行程' } }));
    h.chat = { ...h.chat, server: true, state: { kind: 'ready', group: data } };
    // No computer on the route: the direct Chat Server entry.
    await act(async () => root.render(el(BotGroupChatScreen, { deviceId: '', deviceName: '', groupId: 'g1' })));
    expect(all('botGroup.task.live')).toHaveLength(1);
    // A companion whose computer the account does not know stays a snapshot.
    expect(byId('botGroup.task')!.textContent).toContain('整理行程');
  });

  it('reads my own teammate\'s live task on its home computer when the group is opened through another computer', async () => {
    const meta = { v: 1 as const, role: 'delegation-request' as const, delegationId: 'task-5', fromBotId: 'mimi', fromBotName: '咪咪', toBotId: null,
      toBotName: 'Cindy', parentSessionId: 'group-lane', childSessionId: 'child-5', objective: '写官网首页' };
    const data = group({ serverBacked: true, members: [
      { botId: 'mimi', name: '咪咪', avatar: '🐱', avatarColor: 'red', status: 'active', isOwned: true, homeDeviceId: 'pc' },
      { botId: 'abu', name: '阿布', avatar: '🦉', avatarColor: 'blue', status: 'active', isOwned: true, homeDeviceId: null },
    ] });
    data.messages.push(message('t5', 24, { authorBotId: 'mimi', authorName: '咪咪', content: '我开了个任务', task: { meta, state: 'started', title: '官网首页' } }),
      message('t6', 25, { authorBotId: 'abu', authorName: '阿布', content: '我也开了', task: { meta: { ...meta, delegationId: 'task-6', fromBotId: 'abu' }, state: 'started', title: '整理行程' } }));
    taskCardDevices.length = 0;
    // Opened through 'mac', which is not 咪咪's home; 阿布's home is unknown, so it stays on 'mac'.
    await render(parseBotGroupChatData(data)!);
    expect(all('botGroup.task.live')).toHaveLength(2);
    expect([...new Set(taskCardDevices)].sort()).toEqual(['mac', 'pc']);
  });

  it('shows a task from an author who has left the group as a snapshot, never a lookup on this phone\'s computer', async () => {
    const meta = { v: 1 as const, role: 'delegation-request' as const, delegationId: 'task-2', fromBotId: 'gone', fromBotName: '离开的伙伴', toBotId: null,
      toBotName: 'Cindy', parentSessionId: 'group-lane', childSessionId: 'child-2', objective: '整理行程' };
    const data = group({ serverBacked: true, members: [
      { botId: 'mimi', name: '咪咪', avatar: '🐱', avatarColor: 'red', status: 'active', isOwned: true },
    ] });
    data.messages.push(message('t2', 21, { authorBotId: 'gone', authorName: '离开的伙伴', content: '我也开了',
      task: { meta, state: 'started', title: '整理行程' } }));
    await render(parseBotGroupChatData(data)!);
    const card = byId('botGroup.task')!;
    expect(card.textContent).toContain('整理行程');
    expect(card.textContent).toContain('groupChat.task.state.started');
    expect(byId('botGroup.task.live')).toBeNull();
  });

  it('uses the shared Android keyboard avoidance behavior for the group composer', async () => {
    h.platform.OS = 'android';
    await render();
    expect(h.keyboardAvoidingView).toMatchObject({ enabled: true, behavior: 'height' });
    expect(h.headerBlur).toEqual([]);
  });

  it('floats the iOS header on the task header blur instead of an opaque band', async () => {
    await render();
    // Duo's native measurement already includes its shared status row; do not add another 44pt.
    expect(h.headerBlur.at(-1)).toBe(72);
    // The two-line identity stays over solid blur; the feather starts at the header's lower edge.
    expect(h.headerFade.at(-1)).toBe(0);
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
    // The reader stays in history, sees the arrival, and can explicitly return to it.
    const jump = byId('botGroup.newMessages') as HTMLButtonElement;
    expect(jump.textContent).toContain('count=1');
    h.scrollToEnd.mockClear();
    await act(async () => jump.click());
    expect(h.scrollToEnd).toHaveBeenCalledWith({ animated: false });
    expect(h.markRead).not.toHaveBeenCalled();
    await act(async () => scroll(2500, 3000));
    expect(byId('botGroup.newMessages')).toBeNull();
  });

  it('notices arrivals after a notification opens history without acknowledging the tail', async () => {
    const data = group();
    h.chat = { ...h.chat, state: { kind: 'ready', group: data } };
    const props = { deviceId: 'mac', deviceName: 'Mac', groupId: 'g1', messageId: data.messages[0].id };
    await act(async () => root.render(el(BotGroupChatScreen, props)));
    await act(async () => {
      h.scroll.onLayout({ nativeEvent: { layout: { height: 500 } } });
      h.scroll.onContentSizeChange(400, 2000);
    });
    h.scrollToEnd.mockClear();
    h.chat = { ...h.chat, state: { kind: 'ready', group: { ...data, messages: [...data.messages, message('arrival', 20, {})] } } };
    await act(async () => root.render(el(BotGroupChatScreen, props)));
    await act(async () => h.scroll.onContentSizeChange(400, 2500));
    expect(byId('botGroup.newMessages')?.textContent).toContain('count=1');
    expect(h.markRead).not.toHaveBeenCalled();
    expect(h.scrollToEnd).not.toHaveBeenCalled();
  });

  it('acknowledges a short conversation only after both native dimensions are measured', async () => {
    vi.useFakeTimers();
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(32); h.scroll.onContentSizeChange(400, 300); });
    expect(h.markRead).not.toHaveBeenCalled();
    await act(async () => h.scroll.onLayout({ nativeEvent: { layout: { height: 500 } } }));
    expect(h.markRead).toHaveBeenLastCalledWith('owner', 'mac', 'g1', 7000);
  });

  it('renders the joined member as a localized system line without a chat bubble', async () => {
    await render(group({ messages: [message('join', 1, { kind: 'notice', authorKind: 'system',
      authorName: 'Taylor', authorBotId: null, noticeCode: 'member-joined', content: 'Fallback text' })] }));
    expect(all('botGroup.notice').map(entry => entry.textContent)).toEqual(['groupChat.notice.memberJoined(name=Taylor)']);
    expect(all('botGroup.message.user')).toHaveLength(0);
    expect(all('botGroup.message.bot')).toHaveLength(0);
  });

  it.each(BOT_GROUP_RUNTIME_FAILURE_CODES)('renders the runtime reason and recovery advice on mobile: %s', async runtimeFailureCode => {
    await render(group({ messages: [message('failure', 1, { kind: 'notice', authorKind: 'system',
      authorName: 'Bot', noticeCode: 'member-failed', runtimeFailureCode })] }));
    const text = all('botGroup.notice')[0]?.textContent;
    expect(text).toContain(`groupChat.notice.runtimeFailure.${runtimeFailureCode}(name=Bot)`);
    expect(text).toContain('groupChat.notice.runtimeFailureSetupHint');
    expect(text).not.toContain('groupChat.notice.memberFailed');
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

  // The computer's 自动交接 survives the phone's parse, so the card does not promise a 继续 that never comes.
  it.each([[true, 'groupChat.plan.autoNote'], [undefined, 'groupChat.plan.pauseNote']] as const)('says how steps hand on (autoContinue=%s)', async (autoContinue, note) => {
    const data = group();
    await render(parseBotGroupChatData({ ...data, plans: data.plans.map(plan => ({ ...plan, ...(autoContinue ? { autoContinue } : {}) })) })!);
    expect(byId('botGroup.message.plan')?.textContent).toContain(note);
  });

  it.each([undefined, true, false])('renders human-signed plans as organizer cards with working actions and read-only old plans (isSelf=%s)', async (isSelf) => {
    const data = group();
    data.messages = data.messages.map(message => message.kind === 'plan'
      ? { ...message, authorKind: 'user', authorBotId: null, authorName: 'Human creator', isSelf } : message);
    await render(data);
    expect(byId('botGroup.message.plan')?.textContent).toContain('咪咪');
    expect(byId('botGroup.message.plan')?.textContent).not.toContain('Human creator');
    await click('botGroup.plan.start');
    expect(h.chat.act).toHaveBeenLastCalledWith('plan-start', { planId: 'p1' });
    await click('botGroup.plan.dismiss');
    expect(h.chat.act).toHaveBeenLastCalledWith('plan-dismiss', { planId: 'p1' });
    data.plans[0]!.status = 'superseded';
    data.openPlan = null;
    await render(data);
    expect(byId('botGroup.plan.finalNote')?.textContent).toBe('groupChat.plan.superseded');
    expect(byId('botGroup.plan.start')).toBeNull();
  });

  it('removes a server human by actor identity without offering them as organizer', async () => {
    const data = group({ serverBacked: true, supportsMemberRemoval: true });
    data.members.push({ botId: 'person', actorId: 'actor-person', actorKind: 'human', name: 'Person', avatar: '', avatarColor: '', status: 'active' });
    await render(data);
    expect(byId('botGroup.plan.stepMenu.0.action.member:person')).toBeNull();
    await click('botGroup.settingsButton');
    expect(byId('botGroup.settings.memberMenu.person.action.organizer:person')).toBeNull();
    await click('botGroup.settings.memberMenu.person.action.remove:person');
    expect(h.chat.act).toHaveBeenLastCalledWith('remove-member', { actorId: 'actor-person' });
    h.chat.act.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
    await click('botGroup.settings.memberMenu.person.action.remove:person');
    expect(node.textContent).toContain('groupChat.errors.permissionDenied');
    expect(byId('botGroup.settings.member.person')).not.toBeNull();
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

  // Both Chat Server entry paths must carry the selected original through the real composer.
  it.each([true, false])('sends a quote and retains it after failure (direct server %s)', async server => {
    h.chat.server = server;
    const originalId = '11111111-1111-4111-8111-111111111111';
    await render(group({ serverBacked: true, openPlan: null, messages: [
      message(originalId, 1, { authorName: '咪咪', authorBotId: 'mimi', content: '请回复这条' }),
    ] }));
    await click(`botGroup.reply.${originalId}`);
    await type('引用回复');
    h.chat.act.mockRejectedValueOnce(new Error('QUOTE_UNAVAILABLE'));
    await click('botGroup.composer.send');
    expect(h.row.value).toBe('引用回复');
    expect(byId('botGroup.cancelReply')).not.toBeNull();
    await click('botGroup.composer.send');
    expect(h.chat.act).toHaveBeenLastCalledWith('send', expect.objectContaining({
      text: '引用回复', quote: { messageId: originalId }, clientId: 'uuid-1',
    }));
    expect(byId('botGroup.cancelReply')).toBeNull();
    expect(h.row.value).toBe('');
  });

  it.each([true, false])('locks an existing draft when dissolved without being archived (direct server %s)', async server => {
    h.chat.server = server;
    const live = group({ openPlan: null, archived: false });
    await render(live);
    await type('Unsent draft');
    expect(h.row.editable).toBe(true);
    expect(byId('botGroup.composer.send')?.disabled).toBe(false);
    await render({ ...live, dissolvedAt: '2026-10-15T00:00:00.000Z' });
    expect(h.row.editable).toBe(false);
    expect(byId('botGroup.composer.send')?.disabled).toBe(true);
    await click('botGroup.composer.send');
    expect(h.chat.act).not.toHaveBeenCalled();
    expect(node.textContent).toContain('好的，我看看');
  });

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

  it.each(['[INVALID_PARAMS] MENTION_UNAVAILABLE', 'MENTION_UNAVAILABLE'])('keeps a stale selected target through a refused send (%s) and lets a new pick replace it', async message => {
    const data = group({ openPlan: null });
    const namesakes = [{ ...data.members[0]!, name: 'Ann' }, { ...data.members[1]!, name: 'Ann' }];
    await render(group({ openPlan: null, members: namesakes }));
    await type('@');
    await click('botGroup.mention.mimi');
    await render(group({ openPlan: null, members: namesakes.slice(1) }));
    h.chat.act.mockRejectedValue(new Error(message));
    for (let retry = 0; retry < 2; retry++) {
      await click('botGroup.composer.send');
      expect(h.chat.act).toHaveBeenLastCalledWith('send', expect.objectContaining({ mentions: { all: false, botIds: ['mimi'] } }));
      expect(h.row.value).toBe('@Ann ');
    }
    expect(h.alert).toHaveBeenCalledWith('groupChat.errors.mentionUnavailable');
    const originalClientId = h.chat.act.mock.calls[0][1].clientId;
    expect(h.chat.act.mock.calls[1][1].clientId).toBe(originalClientId);
    await type('@');
    await click('botGroup.mention.abu');
    h.chat.act.mockResolvedValue({ effects: [] });
    await click('botGroup.composer.send');
    expect(h.chat.act).toHaveBeenLastCalledWith('send', expect.objectContaining({ mentions: { all: false, botIds: ['abu'] } }));
    expect(h.chat.act.mock.calls.at(-1)[1].clientId).not.toBe(originalClientId);
    expect(h.row.value).toBe('');
  });

  it('drops a deleted selected mention before a namesake is manually mentioned again', async () => {
    const data = group({ openPlan: null });
    const namesakes = [{ ...data.members[0]!, name: 'Ann' }, { ...data.members[1]!, name: 'Ann' }];
    await render(group({ openPlan: null, members: namesakes }));
    await type('@');
    await click('botGroup.mention.mimi');
    await render(group({ openPlan: null, members: namesakes.slice(1) }));
    await type('hello');
    await type('@Ann hello');
    await click('botGroup.composer.send');
    expect(h.chat.act).toHaveBeenLastCalledWith('send', expect.objectContaining({ mentions: { all: false, botIds: ['abu'] } }));
  });

  it('keeps the current human in the group but excludes it from mention choices and typed mentions', async () => {
    h.chat.server = true;
    const data = group({ openPlan: null });
    data.members.unshift({ ...data.members[0]!, botId: 'self', name: 'Me', actorKind: 'human', isSelf: true });
    await render(data);
    await type('@');
    expect(byId('botGroup.mention.self')).toBeNull();
    expect(byId('botGroup.mention.mimi')).not.toBeNull();
    await type('@Me @阿布 hello');
    await click('botGroup.composer.send');
    expect(h.chat.act).toHaveBeenLastCalledWith('send', expect.objectContaining({ mentions: { all: false, botIds: ['abu'] } }));
  });

  it.each(['picked', 'manual'])('removes only the %s token identity when same-name mentions coexist', async removed => {
    const data = group({ openPlan: null });
    const namesakes = [{ ...data.members[0]!, name: 'Ann' }, { ...data.members[1]!, name: 'Ann' }];
    await render(group({ openPlan: null, members: namesakes }));
    await type('  @');
    await click('botGroup.mention.mimi');
    await type('  @Ann @Ann');
    await render(group({ openPlan: null, members: namesakes.slice(1) }));
    await act(async () => h.row.onSelectionChange({ nativeEvent: { selection: {
      start: removed === 'picked' ? 2 : 6, end: removed === 'picked' ? 7 : 11,
    } } }));
    await type('  @Ann');
    await click('botGroup.composer.send');
    expect(h.chat.act).toHaveBeenLastCalledWith('send', expect.objectContaining({ mentions: { all: false, botIds: [removed === 'picked' ? 'abu' : 'mimi'] } }));
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

  // bot-group-chat.md §7.0 (2026-10-23): the computer arranges a 分工 in single-speaker rooms too,
  // so a phone working through it keeps 安排分工; a phone talking to the server directly does not, nor one
  // whose older computer would answer the request as a queue (no supportsDivision) (component tier).
  it.each([[true, true, false, true], [true, false, false, false], [false, false, false, true], [true, true, true, false]])(
    'offers 安排分工 (singleSpeaker=%s, supportsDivision=%s, direct=%s)', async (singleSpeaker, supportsDivision, direct, offered) => {
    h.chat.server = direct;
    await render(parseBotGroupChatData(group({ serverBacked: true, singleSpeaker, ...(supportsDivision ? { supportsDivision } : {}), replyMode: 'mentioned', openPlan: null }))!);
    expect(!!byId('botGroup.composer.menu.action.division')).toBe(offered);
  });

  it.each(['all', 'mentioned'] as const)('keeps the running work-plan gate and uses truthful %s copy', async replyMode => {
    const data = group({
      replyMode,
      openPlan: { id: 'p1', status: 'running', currentStep: 0, stepCount: 2, currentBotName: '咪咪', currentStepStatus: 'running' },
      round: { status: 'running', speakers: [{ botId: 'mimi', sessionId: 's1', activity: 'step' }], canContinue: false },
    });
    data.plans[0] = { ...data.plans[0]!, kind: 'work', status: 'running', currentStep: 0, steps: [{ ...data.plans[0]!.steps[0]!, status: 'running' }, data.plans[0]!.steps[1]!] };
    await render(data);
    expect(byId('botGroup.composer.menu')).toBeNull();
    await click('botGroup.composer.more');
    expect(h.alert).toHaveBeenCalledWith('groupChat.composer.division', 'groupChat.composer.divisionBusy');
    expect(byId('placeholder')?.textContent).toBe(replyMode === 'mentioned'
      ? 'groupChat.composer.placeholder' : 'groupChat.composer.placeholderPlanRunning(name=咪咪)');
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

  // Leaving mid-upload drops the photo: ask first, and never send the text alone.
  it('asks before leaving while a send waits on an upload, and sends nothing once left', async () => {
    await render(group({ openPlan: null, supportsAttachments: true }));
    await focusComposer();
    await act(async () => { h.row.onChangeText('配图'); });
    let settle!: (result: { failedCount: number; abandoned: boolean }) => void;
    h.local.wait.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    await click('botGroup.composer.send');
    expect(h.leaveGuard.at(-1)).toBe(true);
    await act(async () => settle({ failedCount: 0, abandoned: true }));
    expect(h.chat.act).not.toHaveBeenCalled();
    expect(h.leaveGuard.at(-1)).toBe(false);
  });

  // The leave dialog stays open after the upload settles: nothing may be sent before the answer.
  it('holds the send for an open leave dialog, then sends or drops it by the answer', async () => {
    await render(group({ openPlan: null, supportsAttachments: true }));
    await focusComposer();
    await act(async () => { h.row.onChangeText('配图'); });
    let answer!: (discard: boolean) => void;
    h.leaveDecision = () => new Promise((resolve) => { answer = resolve; });
    await click('botGroup.composer.send');
    expect(h.chat.act).not.toHaveBeenCalled();
    await act(async () => answer(false));
    expect(h.chat.act).toHaveBeenCalledTimes(1);

    h.chat.act.mockClear();
    await act(async () => { h.row.onChangeText('再来一条'); });
    await click('botGroup.composer.send');
    await act(async () => answer(true));
    expect(h.chat.act).not.toHaveBeenCalled();
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
    // Sent order: the picture's strip, then the file's own strip (a strip draws pictures first).
    const strips = [...users[0]!.querySelectorAll('[data-testid="attachmentStrip"]')];
    expect(strips).toHaveLength(2);
    expect(strips[0]).toBe(strip);
    const file = strips[1]!.querySelector('[data-testid="attachment.file"]') as HTMLButtonElement;
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

  it('allows personal removal from an archived read-only group without management rights', async () => {
    h.chat.server = true;
    await openSettings(group({ serverBacked: true, archived: true, supportsListRemoval: true, supportsSettingsManagement: false,
      members: [{ botId: 'self', actorId: 'self', name: 'Me', avatar: '', avatarColor: '', status: 'active', isSelf: true, role: 'member' }] }));
    expect(byId('botGroup.settings.delete')).toBeNull();
    expect(byId('botGroup.settings.hide')?.disabled).toBe(false);
    await click('botGroup.settings.hide');
    expect(h.chat.act).toHaveBeenCalledExactlyOnceWith('hide', undefined);
  });

  it.each([true, false])('leaves after confirmed personal hide even when settings unmounts before the reply (direct=%s)', async direct => {
    h.chat.server = direct;
    let finish!: () => void;
    h.chat.act.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ effects: [] }); }));
    await openSettings(group({ serverBacked: true, supportsListRemoval: true }));
    await click('botGroup.settings.hide');
    expect(h.chat.act).toHaveBeenLastCalledWith('hide', undefined);
    await render(null, 'missing');
    expect(byId('botGroup.settings')).toBeNull();
    expect(h.leave).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    expect(h.leave).toHaveBeenCalledOnce();
  });

  it('navigates only once when a personal hide completes before the list rerenders', async () => {
    await openSettings(group({ serverBacked: true, supportsListRemoval: true }));
    await click('botGroup.settings.hide');
    expect(h.leave).toHaveBeenCalledOnce();
  });

  it.each([true, false])('leaves once for authoritative hide without a local action (direct=%s)', async direct => {
    h.chat.server = direct;
    await render(group({ serverBacked: true }));
    h.chat.listHidden = true;
    await render(null, 'missing');
    expect(h.leave).toHaveBeenCalledOnce();
    expect(h.chat.act).not.toHaveBeenCalled();
    await render(null, 'missing');
    expect(h.leave).toHaveBeenCalledOnce();
  });

  it('does not navigate twice when the authoritative event precedes the local hide receipt', async () => {
    let finish!: () => void;
    h.chat.act.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ effects: [] }); }));
    await openSettings(group({ serverBacked: true, supportsListRemoval: true }));
    await click('botGroup.settings.hide');
    h.chat.listHidden = true;
    await render(null, 'missing');
    expect(h.leave).toHaveBeenCalledOnce();
    await act(async () => { finish(); });
    expect(h.leave).toHaveBeenCalledOnce();
  });

  it('keeps a hidden background page from navigating another route and leaves when focused again', async () => {
    await render(group({ serverBacked: true }));
    h.focused = false; h.chat.listHidden = true;
    await render(null, 'missing');
    expect(h.leave).not.toHaveBeenCalled();
    h.focused = true;
    await render(null, 'missing');
    expect(h.leave).toHaveBeenCalledOnce();
  });

  it('resets lifecycle busy on reopen and keeps an old reply out of a new request', async () => {
    const data = group({ serverBacked: true, supportsDissolve: true, revision: 1,
      members: [{ botId: 'mimi', actorId: 'mimi', name: 'Mimi', avatar: '', avatarColor: '', status: 'active', isOwned: true, role: 'owner' }] });
    let finishOld!: () => void, finishNew!: () => void;
    h.chat.act.mockImplementationOnce(() => new Promise(resolve => { finishOld = () => resolve({ effects: [] }); }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = () => resolve({ effects: [] }); }));
    await openSettings(data);
    await click('botGroup.settings.dissolve');
    expect(byId('botGroup.settings.dissolve')?.disabled).toBe(true);
    await act(async () => h.closeSettings!());
    await click('botGroup.settingsButton');
    expect(byId('botGroup.settings.dissolve')?.disabled).toBe(false);
    await click('botGroup.settings.dissolve');
    expect(h.chat.act).toHaveBeenCalledTimes(2);
    await act(async () => { finishOld(); });
    expect(byId('botGroup.settings.dissolve')?.disabled).toBe(true);
    await act(async () => { finishNew(); });
    expect(byId('botGroup.settings.dissolve')?.disabled).toBe(false);
  });

  it('does not navigate from an old hide acknowledgement after leaving the screen', async () => {
    let finish!: () => void;
    h.chat.act.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ effects: [] }); }));
    await openSettings(group({ serverBacked: true, supportsListRemoval: true }));
    await click('botGroup.settings.hide');
    await act(async () => root.render(el('div')));
    await act(async () => { finish(); });
    expect(h.leave).not.toHaveBeenCalled();
  });

  it('follows a remote rename on blur without saving an untouched name', async () => {
    await openSettings();
    await act(async () => { h.inputs['botGroup.settings.name'].onFocus(); });
    await render(group({ name: '电脑端的新名称' }));
    expect(h.inputs['botGroup.settings.name'].value).toBe('官网介绍页');
    await act(async () => { h.inputs['botGroup.settings.name'].onBlur(); });
    expect(h.chat.act).not.toHaveBeenCalled();
    expect(h.inputs['botGroup.settings.name'].value).toBe('电脑端的新名称');
  });

  it('keeps a failed name draft and lets the user retry it', async () => {
    await openSettings(); h.chat.act.mockRejectedValueOnce(new Error('PRECONDITION_FAILED'));
    await act(async () => { h.inputs['botGroup.settings.name'].onChangeText('保留草稿'); });
    await act(async () => { await h.inputs['botGroup.settings.name'].onSubmitEditing(); });
    expect(h.inputs['botGroup.settings.name'].value).toBe('保留草稿');
    expect(byId('botGroup.settings')?.textContent).toContain('groupChat.settings.conflict');
    await act(async () => { await h.inputs['botGroup.settings.name'].onSubmitEditing(); });
    expect(h.chat.act).toHaveBeenLastCalledWith('update', { name: '保留草稿' });
  });

  it('edits a direct server group through the management host while chat stays direct', async () => {
    const data = group({ serverBacked: true, supportsSettingsManagement: true, supportsMemberRemoval: true, revision: 5 });
    data.members[0] = { ...data.members[0], isOwned: true, role: 'owner' };
    h.chat.server = true;
    const manage = vi.fn(async () => ({ effects: [] }));
    h.management = { displayHost: { deviceId: 'pc', deviceName: 'PC' }, selected: { host: { deviceId: 'pc', deviceName: 'PC' }, group: data }, managers: [], loading: false, reason: null,
      act: manage, refresh: vi.fn(), select: vi.fn() };
    h.teammates = { rows: [{ key: 'new', host: { deviceId: 'pc', deviceName: 'PC' }, item: {
      ref: { collectionId: 'teammates', kind: 'bot', id: 'new-bot' }, revision: '1', display: { title: 'New bot' }, links: [],
    } }], loading: false, failed: false };
    await openSettings(data);
    expect(h.inputs['botGroup.settings.name'].editable).toBe(true);
    expect(byId('botGroup.settings.managementStatus')?.textContent).toBe('groupChat.settings.managementStatus.ready');
    expect(byId('botGroup.settings.connectedDot')).not.toBeNull();
    expect(byId('botGroup.settings.retry')).toBeNull();
    expect(byId('botGroup.settings.body')?.style.opacity).toBe('');
    await act(async () => { h.inputs['botGroup.settings.name'].onChangeText('Managed'); });
    await act(async () => { await h.inputs['botGroup.settings.name'].onSubmitEditing(); });
    expect(manage).toHaveBeenCalledWith('update', { name: 'Managed', expectedRevision: 5 });
    expect(h.chat.act).not.toHaveBeenCalled(); expect(h.chat.reload).toHaveBeenCalled();
    await click('botGroup.settings.add'); await click('botGroup.settings.addable.new-bot');
    expect(manage).toHaveBeenLastCalledWith('add-member', { botId: 'new-bot', expectedRevision: 5 });
  });

  it('explains unavailable management and offers retry without enabling edits', async () => {
    const refresh = vi.fn();
    h.management = { displayHost: { deviceId: 'pc', deviceName: 'PC' }, selected: undefined, managers: [], loading: false, reason: 'noHost', act: vi.fn(), select: vi.fn(), refresh };
    h.chat.server = true; await openSettings(group({ serverBacked: true }));
    expect(h.inputs['botGroup.settings.name'].editable).toBe(false);
    expect(byId('botGroup.settings.body')?.style.opacity).toBe('0.6');
    expect(byId('botGroup.settings.managementStatus')?.textContent).toBe('groupChat.settings.managementStatus.noHost');
    expect(byId('botGroup.settings.computerName')?.textContent).toBe('PC');
    expect(byId('botGroup.settings.retry')?.textContent).toBe('groupChat.settings.reconnect');
    expect((byId('botGroup.settings.member.mimi') as HTMLButtonElement)?.disabled).toBe(true);
    await click('botGroup.settings.add');
    expect(byId('botGroup.settings.addable')).toBeNull();
    await click('botGroup.settings.retry'); expect(refresh).toHaveBeenCalledOnce();
    expect(h.chat.act).not.toHaveBeenCalled();
    expect(byId('botGroup.settings.delete')).toBeNull();
    expect(byId('botGroup.settings.hide')?.disabled).toBe(true);
    expect(byId('botGroup.settings')?.textContent).toContain('groupChat.lifecycle.unavailable');
    expect(byId('botGroup.settings')?.textContent).not.toContain('groupChat.settings.deleteNote');
  });

  it.each(['upgrade', 'permission', 'unavailable', 'loading'])('keeps the %s reason explicit in the compact status row', async reason => {
    const refresh = vi.fn();
    h.chat.server = true;
    h.management = { selected: undefined, managers: [], loading: reason === 'loading', reason: reason === 'loading' ? null : reason,
      act: vi.fn(), select: vi.fn(), refresh };
    await openSettings(group({ serverBacked: true }));
    expect(byId('botGroup.settings.managementStatus')?.textContent).toBe(`groupChat.settings.managementStatus.${reason}`);
    expect(h.inputs['botGroup.settings.name'].editable).toBe(false);
    if (reason === 'loading') {
      expect(byId('botGroup.settings.connecting')).not.toBeNull();
      expect(byId('botGroup.settings.retry')).toBeNull();
    } else {
      expect(byId('botGroup.settings.connecting')).toBeNull();
      await click('botGroup.settings.retry'); expect(refresh).toHaveBeenCalledOnce();
    }
  });

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

  it.each(['member', 'admin'] as const)('uses explicit leave for a server %s without granting archive or compatibility delete', async (role) => {
    const data = group({ serverBacked: true, supportsSettingsManagement: true, supportsGroupLeave: true, revision: 5 });
    data.members[0] = { ...data.members[0], actorId: 'human', isSelf: true, isOwned: true, role };
    await openSettings(data);
    expect(h.inputs['botGroup.settings.name'].editable).toBe(role === 'admin');
    expect(byId('botGroup.settings.add')?.disabled).toBe(role !== 'admin');
    expect(byId('botGroup.settings.delete')).toBeNull();
    expect(byId('botGroup.settings.leave')?.disabled).toBe(false);
    await click('botGroup.settings.leave');
    expect(h.chat.act).toHaveBeenCalledWith('leave', undefined);
    expect(h.leave).toHaveBeenCalledOnce();
  });

  it('keeps explicit leave disabled when the computer is offline', async () => {
    const data = group({ serverBacked: true, supportsSettingsManagement: true, supportsGroupLeave: true, revision: 5 });
    data.members[0] = { ...data.members[0], actorId: 'human', isSelf: true, isOwned: true, role: 'member' };
    h.chat.online = false;
    await openSettings(data);
    expect(byId('botGroup.settings.delete')).toBeNull();
    expect(byId('botGroup.settings.leave')?.disabled).toBe(true);
    await click('botGroup.settings.leave');
    expect(h.chat.act).not.toHaveBeenCalled();
  });

  it('keeps direct server settings archive owner-only', async () => {
    const data = group({ serverBacked: true, supportsSettingsManagement: true, revision: 5 });
    data.members[0] = { ...data.members[0], isOwned: true, role: 'admin' };
    h.chat.server = true;
    h.management = { selected: { host: { deviceId: 'pc', deviceName: 'PC' }, group: data }, managers: [], loading: false, reason: null,
      act: vi.fn(), refresh: vi.fn(), select: vi.fn() };
    await openSettings(data);
    expect(byId('botGroup.settings.delete')?.disabled).toBe(true);
    await click('botGroup.settings.delete');
    expect(h.management.act).not.toHaveBeenCalled();
  });

  it('searches the host roster when adding a server group member', async () => {
    const data = group({ serverBacked: true, supportsSettingsManagement: true, revision: 5 });
    data.members[0] = { ...data.members[0], isOwned: true, role: 'owner' };
    await openSettings(data);
    await click('botGroup.settings.add');
    expect(h.inputs['botGroup.settings.memberSearch']).toBeDefined();
    await act(async () => { h.inputs['botGroup.settings.memberSearch'].onChangeText('Beyond first page'); });
    expect(h.teammateQuery).toBe('Beyond first page');
    h.teammates.rows = [{ key: 'beyond', host: { deviceId: 'pc', deviceName: 'PC' }, item: {
      ref: { collectionId: 'teammates', kind: 'bot', id: 'bot-201' }, revision: '1', display: { title: 'Beyond first page' }, links: [],
    } }];
    await render(data);
    await click('botGroup.settings.addable.bot-201');
    expect(h.chat.act).toHaveBeenLastCalledWith('add-member', { botId: 'bot-201', expectedRevision: 5 });
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


describe('direct server group presentation', () => {
  it.each([true, false])('aligns attachments with their message author (server=%s)', async (server) => {
    h.chat = { ...h.chat, server, ...(server ? { media: vi.fn() } : {}) };
    const attachment = { id: 'media', name: 'brief.pdf', mimeType: 'application/pdf', size: 10, category: 'pdf' as const, url: null, path: null };
    await render(group({ messages: [
      message('mine', 1, { authorKind: 'user', isSelf: true, attachments: [attachment] }),
      message('other', 2, { authorKind: 'user', isSelf: false, authorName: 'Other member', attachments: [attachment] }),
      message('bot', 3, { authorBotId: 'mimi', authorName: '咪咪', attachments: [attachment] }),
    ], plans: [], openPlan: null }));
    expect(all('botGroup.message.user')).toHaveLength(1);
    expect(all('botGroup.message.bot')).toHaveLength(2);
    expect(all('attachmentStrip').map(strip => strip.getAttribute('data-align'))).toEqual(['right', 'left', 'left']);
  });
  it('uses server failure copy, keeps other humans incoming and loads older history', async () => {
    h.chat = { ...h.chat, server: true, online: false, loadOlder: vi.fn(async () => {}) };
    await render(null, 'error');
    expect(byId('botGroup.loadFailed')?.textContent).toContain('groupChat.server.loadFailed');
    expect(node.textContent).not.toContain('devices.resources.hostOffline');
    h.chat.online = true;
    await render(group({ messages: [message('other', 1, { authorKind: 'user', authorName: 'Other member', isSelf: false, content: 'hello' })], plans: [], openPlan: null, hasMoreBefore: true }));
    expect(all('botGroup.message.user')).toHaveLength(0);
    expect(node.textContent).toContain('Other member');
    expect(h.scroll.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });
    await click('botGroup.loadOlder'); expect(h.chat.loadOlder).toHaveBeenCalledOnce();
    await click('botGroup.settingsButton');
    expect(byId('botGroup.settings.delete')?.disabled).toBe(true);
    expect(byId('botGroup.settings.replyMode.mentioned')?.disabled).toBe(true);
  });
  it('reauthorizes a server attachment on tap and opens the existing image viewer', async () => {
    const attachment = { id: 'media', name: 'picture.png', mimeType: 'image/png', size: 10, category: 'image' as const, url: 'https://media.example.invalid/one-use', path: null };
    h.chat = { ...h.chat, server: true, media: vi.fn(async () => attachment) };
    await render(group({ messages: [message('picture', 1, { authorKind: 'user', isSelf: false, attachments: [{ ...attachment, url: null, category: 'file' }] })], plans: [], openPlan: null }));
    expect(h.chat.media).not.toHaveBeenCalled();
    await click('attachment.file'); expect(h.chat.media).toHaveBeenCalledExactlyOnceWith('media');
    expect(byId('lightbox')?.getAttribute('data-url')).toBe(attachment.url);
  });
});


it.each([true, false])('acknowledges other humans at the measured visible tail (direct: %s)', async server => {
  h.chat.server = server;
  h.chat.markRead = vi.fn(async () => {});
  await render(group({ messages: [message('incoming-human', 12, { authorKind: 'user', isSelf: false, content: 'hello' }),
    message('mine', 13, { authorKind: 'user', isSelf: true, content: 'reply' })], plans: [], openPlan: null }));
  expect(h.markRead).not.toHaveBeenCalled();
  expect(h.chat.markRead).not.toHaveBeenCalled();
  await act(async () => {
    h.scroll.onLayout({ nativeEvent: { layout: { height: 500 } } });
    h.scroll.onContentSizeChange(400, 400);
  });
  expect(h.chat.markRead).toHaveBeenLastCalledWith(['incoming-human']);
  if (server) expect(h.markRead).not.toHaveBeenCalled();
  else expect(h.markRead).toHaveBeenCalled();
});

// #6550: screen + real mobile Markdown parser, with RN host primitives simulated in jsdom.
it('renders component body as readable text without changing the message', async () => {
  const content = 'Before\n\n```cindy-ui\n' + JSON.stringify({ seq: 1, version: 1, op: 'create', id: 'body', kind: 'text', props: { text: 'Readable answer' } }) + '\n```\n\nAfter';
  const reply = message('rich-body', 1, { authorBotId: 'mimi', authorName: '咪咪', content });
  await render(group({ messages: [reply] }));
  const body = byId('botGroup.message.bot')!;
  expect(body.textContent).toContain('Readable answer');
  expect(body.textContent).toContain('Before');
  expect(body.textContent).toContain('After');
  expect(body.textContent).not.toContain('"op":"create"');
  expect(reply.content).toBe(content);
});
