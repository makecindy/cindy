import { BotGroupProcess } from './BotGroupProcess';
import { useGroupPersonalMask } from './useGroupPersonalMask';
import { GroupMaskAvatar, GroupMaskStatus, GroupMaskSettingsSheet, GroupMaskCatchupSheet } from './GroupMaskControls';
import type { ChatMaskMention } from '@cindy/maker-shared/botGroupChat';
import { deviceDisplayName } from '@/device-link/deviceName';
import { BotGroupTopicImageShare } from './BotGroupTopicImageShare';
import { ShareMessageCheckbox } from './ShareMessageCheckbox';
import { ShareSelectAllButton } from './ShareSelectAllButton';
import { shareSelectionStore, useShareSelectionActive, useShareSelectionRevision } from './shareSelectionStore';
import { pendingChatMessage } from '@/chat/chatOutbox';
import { useDelayedConnectionNotice } from '@/components/ConnectionNoticeOverlay';
import type { DurableOutboxRecord } from './durableOutbox';
/**
 * 手机上的群聊页（docs/product-rules/bot-group-chat.md §8，对照桌面 BotGroupChatView.tsx）：
 * 顶栏（叠放头像、群名、成员名单、群设置）+ 多作者时间线 + 输入框。用户消息的附件见
 * BotGroupMessageAttachments（图片从电脑取缩略图，文件显示名称并按格式预览或交系统应用）。
 *
 * 群在电脑上，电脑执行全部规则；这里整页读电脑给的群快照（最新 100 条消息与涉及的安排），
 * 每次电脑推送变化就重读，不在本地拼时间线。分工的安排卡、交接文件、「下一步 · 继续」
 * 「没做完 · 重试」见 BotGroupPlan.tsx；正在发言的伙伴与它待确认的操作见 BotGroupSpeakerRow。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { showConfirm } from '@/platform/chrome';
import { X } from 'lucide-react-native';
import { NativeChromeBackButton } from '@/platform/chrome/NativeChromeBackButton';
import { Stack, useRouter, useNavigation, useFocusEffect } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useAdaptiveWindow } from '@/platform/AdaptiveWindowContext';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';
import {
  BOT_GROUP_REMOTE_COLLECTION_ID,
  isBotGroupRuntimeFailureCode,
  resolveBotGroupQuote,
  BOT_GROUP_MEMBER_LINK_REL,
  botGroupQuoteFromMessage,
  isBotGroupMessageQuotable,
  type BotGroupQuoteView,
  type BotGroupAttachment,
  type BotGroupMemberView,
  type BotGroupQuoteDisplay,
  type BotGroupMessageView,
  type BotGroupPlanAction,
  type BotGroupPlanStepView,
  type BotGroupPlanView,
  type BotGroupRemoteChatData,
} from '@cindy/maker-shared/botGroupChat';
import {
  botGroupComposerPlanState,
  botGroupNewMessageCount,
  botGroupMemberNames,
  botGroupNoticeVariant,
  botGroupPlanFollowUp,
  continuableRoundEndId,
  openBotGroupPlan,
} from '@cindy/maker-shared/botGroupPresentation';
import { collectBotMessageTimeGroups, formatBotMessageGroupTime } from '@cindy/maker-shared/botTimeline';
import { markRemoteResourceRead } from '@/device-link/remoteResourceCache';
import { useIsFocused } from 'expo-router';
import { AppState } from 'react-native';
import { useAuth } from '@/auth/AuthContext';
import { Text } from '@/components/AppText';
import { MainWindowActionButton, MainWindowEmptyState } from '@/components/MobilePrimitives';
import { readRemoteCollectionCache } from '@/device-link/remoteResourceAvailability';
import type { RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { iconStroke, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { useUserBubbleAppearance } from '@/theme/userBubblePreference';
import { fontWeight, iconSize, lineHeight, navigationChrome, radius, spacing, typeScale } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';
import {
  BOT_GROUP_MESSAGE_AVATAR_SIZE,
  BotGroupAvatar,
  BotGroupDuoAvatar,
  useBotGroupIdentities,
} from './BotGroupAvatars';
import { CHAT_HEADER_MARK_SIZE, CHAT_HEADER_BLUR_FADE_INSIDE, ChatIdentityHeader } from './ChatIdentityHeader';
import { SessionHeaderNativeBlur } from './SessionHeaderNativeControls';
import { CompanionEntering, CompanionFadeIn } from './CompanionEntering';
import { BotGroupRuntimeFailureNotice } from './BotGroupRuntimeFailureNotice';
import { BotGroupComposer, type BotGroupSendInput } from './BotGroupComposer';
import { BotGroupMessageAttachments } from './BotGroupMessageAttachments';
import { MessageListVisibilityContext, useScrollViewMessageVisibility } from './messageListVisibility';
import { BotGroupTaskCard } from './BotGroupTaskCard';
import { BotGroupMarkdownText, BotGroupUserText } from './BotGroupMessageText';
import { BotGroupQuote } from './BotGroupQuote';
import {
  BOT_GROUP_COMPACT_HIT_SLOP,
  BotGroupDivider,
  BotGroupHandoffFiles,
  BotGroupOrganizerTag,
  BotGroupPlanCard,
  BotGroupPlanEndDivider,
  BotGroupPlanFollowUpRow,
  type BotGroupFollowUpAction,
  type BotGroupIdentityLookup,
  type BotGroupPlanCardAction,
} from './BotGroupPlan';
import { BotGroupSettingsSheet } from './BotGroupSettingsSheet';
import { BotGroupWorkArea } from './BotGroupWorkArea';
import { botGroupActionErrorText } from './botGroupCopy';
import { keyboardAvoidingBehaviorForPlatform } from './mobileNativeShellLayout';
import type { ResolveRemoteMediaFn } from './remoteMedia';
import { useBotGroupChat } from './useBotGroupChat';
import { useBotGroupRemoteMedia } from './useBotGroupRemoteMedia';
import { botGroupRoute } from './botGroupNavigation';
import { BotGroupThreadEntry, BotGroupThreadFollow, BotGroupThreadShare, BotGroupThreadPosted, BotGroupMessageActions } from './BotGroupThreadViews';
import { compactMessageBubble, messageBubbleBase, userMessageBubble } from './messageBubbleStyles';

/** Toast copy when a plan action fails without a more specific cause. */
const PLAN_ACTION_FAILED: Record<BotGroupPlanAction, string> = {
  start: 'groupChat.plan.startFailed',
  dismiss: 'groupChat.plan.dismissFailed',
  continue: 'groupChat.timeline.continuePlanFailed',
  retry: 'groupChat.timeline.retryFailed',
};

type PlanPending = { planId: string; action: BotGroupPlanAction | 'edit' };
/** Follow new messages while the reader is within this distance of the bottom. */
const STICK_TO_BOTTOM_PX = 48;
/** Teammate replies hang 10pt right of the 28pt portrait, as in the 1:1 chat. */
const REPLY_AVATAR_GAP = 10;
/** One short line gets the compact bubble, as in the 1:1 chat. */
const COMPACT_BUBBLE_MAX_CHARS = 140;

type BotGroupChatScreenProps = {
  deviceId: string; deviceName: string; groupId: string; messageId?: string; notificationResponse?: string; threadRootId?: string;
};

export function BotGroupChatScreen(props: BotGroupChatScreenProps) {
  // The remote resource is keyed only by device/group. Never mount its main-chat
  // projection as a thread, and never silently strip the computer from its route.
  return props.deviceId && props.threadRootId
    ? <UnsupportedRemoteThread {...props} />
    : <BotGroupChatContent {...props} />;
}

function UnsupportedRemoteThread({ deviceId, deviceName, groupId }: BotGroupChatScreenProps) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const back = useCallback(() => router.replace(botGroupRoute({ deviceId, deviceName }, groupId)), [router, deviceId, deviceName, groupId]);
  useFocusEffect(useCallback(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { back(); return true; });
    return () => subscription.remove();
  }, [back]));
  return <SafeAreaView style={styles.screen}>
    <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
    <View style={styles.unavailableHeader}>
      <NativeChromeBackButton label={t('shared.back')} onPress={back} testID="botGroup.back" />
    </View>
    <View style={styles.center}>
      <MainWindowEmptyState centered testID="botGroup.thread.unsupported" title={t('groupChat.thread.title')} copy={t('groupChat.thread.remoteUnavailable')}>
        <MainWindowActionButton action={{ label: t('groupChat.thread.backToGroup'), onPress: back, testID: 'botGroup.thread.back' }} />
      </MainWindowEmptyState>
    </View>
  </SafeAreaView>;
}

function BotGroupChatContent({ deviceId, deviceName, groupId, messageId, notificationResponse, threadRootId }: BotGroupChatScreenProps) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const navigation = useNavigation();
  const { user, accountGeneration } = useAuth();
  const host = useMemo<RemoteResourceHostTarget>(() => ({ deviceId, deviceName: deviceDisplayName(deviceId, deviceName) }), [deviceId, deviceName]);
  const chat = useBotGroupChat(host, groupId, threadRootId);
  const identity = useBotGroupIdentities(deviceId);
  const resolveMedia = useBotGroupRemoteMedia(deviceId);
  const [settings, setSettings] = useState(false);
  const [maskSettings, setMaskSettings] = useState(false), [catchup, setCatchup] = useState(false);
  const openMaskAfterSettings = useRef(false), locateAfterCatchup = useRef<ChatMaskMention | null>(null);
  const [readTarget, setReadTarget] = useState(messageId ?? '');
  const [replyTo, setReplyTo] = useState<BotGroupQuoteView | null>(null);
  const [replyFocusRequest, setReplyFocusRequest] = useState(0);
  const [imageShareBusy, setImageShareBusy] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const autoPaging = useRef(false);
  const userScrolled = useRef(false);
  const pagingAnchor = useRef<{ id: string; y: number; offset: number; ids: Set<string>; sequence: string } | null>(null);
  const initialRead = useRef<{ owner: string; sequence?: string }>({ owner: '', sequence: undefined });
  const leaveAfterSettings = useRef(false);
  const [continuing, setContinuing] = useState(false);
  const [planPending, setPlanPending] = useState<PlanPending | null>(null);
  const planPendingRef = useRef(false);
  const scrollRef = useRef<ScrollView>(null);
  // iOS: the header floats on the task header's feathered blur and the timeline scrolls beneath it.
  const floatingHeader = Platform.OS === 'ios';
  const insets = useSafeAreaInsets();
  const window = useAdaptiveWindow();
  const nativeHeader = floatingHeader && window.barEdge === 'none';
  const nativeHeaderHeight = useHeaderHeight();
  const [headerHeight, setHeaderHeight] = useState(0);
  const stickToBottom = useRef(!messageId && !threadRootId);
  const [jumpTarget, setJumpTarget] = useState(messageId ?? '');
  const [highlightId, setHighlightId] = useState('');
  const jumpAttempts = useRef(0);
  const messagePositions = useRef(new Map<string, number>());
  const messageHeights = useRef(new Map<string, number>());
  const returnAnchor = useRef<{ owner: string; id: string; offset: number } | null>(null);
  const restoreOffset = useRef<number | null>(null);
  const pauseReadUntilInteraction = useRef(false);
  const group = chat.state.kind === 'ready' ? chat.state.group : null;
  const mask = useGroupPersonalMask(groupId, deviceId, !!group?.serverBacked && group.conversationKind !== 'direct' && (!deviceId || group.supportsPersonalMask === true), chat.act, group);
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(() => AppState.currentState === 'active');
  const previewVisibility = useScrollViewMessageVisibility(
    `${accountGeneration}:${deviceId}:${groupId}:${threadRootId ?? ''}`,
    useMemo(() => group?.messages.map(message => message.id) ?? [], [group?.messages]),
    focused && foreground,
  );
  const viewportOwner = `${user?.id ?? ''}:${accountGeneration}:${deviceId}:${groupId}:${threadRootId ?? 'main'}`;
  const shareScope = `bot-group:${viewportOwner}`;
  const imageSelectionActive = useShareSelectionActive(shareScope);
  useShareSelectionRevision();
  const selectedImages = imageSelectionActive ? shareSelectionStore.getSelectedIds() : undefined;
  const shareableMessages = group?.messages.filter(message => message.kind === 'message' && !message.deleted
    && (!message.threadShare || message.threadShare.status === 'available')
    && (threadRootId ? message.id === threadRootId || message.threadRootId === threadRootId : !message.threadRootId)) ?? [];
  const shareDeliveries = threadRootId ? chat.pending.filter(row => row.chat?.messageId && row.chat.shareToMain && row.chat.shareToMain.state !== 'sent') : [];
  const selectedMessages = shareableMessages.filter(message => selectedImages?.includes(message.id));
  const shareableIds = shareableMessages.map(message => message.id);
  useEffect(() => () => {
    if (shareSelectionStore.isActive(shareScope)) shareSelectionStore.exit();
  }, [shareScope]);
  useEffect(() => {
    if (!focused && shareSelectionStore.isActive(shareScope)) shareSelectionStore.exit();
  }, [focused, shareScope]);
  useEffect(() => {
    if (!shareSelectionStore.isActive(shareScope)) return;
    const exposed = shareSelectionStore.getSelectedIdsInOrder(shareableIds);
    if (exposed.length !== shareSelectionStore.count()) shareSelectionStore.setSelection(exposed);
  }, [imageSelectionActive, shareScope, shareableIds.join('\0')]);
  if (initialRead.current.owner !== viewportOwner) initialRead.current = { owner: viewportOwner, sequence: chat.threadMeta?.readSeq };
  else if (initialRead.current.sequence === undefined) initialRead.current.sequence = chat.threadMeta?.readSeq;
  const [seen, setSeen] = useState<{ owner: string; sequence: string } | null>(null);
  const latestSequence = group?.messages.reduce((latest, message) => {
    const position = message.serverSequence ?? String(message.sequence);
    return BigInt(position) > BigInt(latest) ? position : latest;
  }, '0') ?? '0';
  // Opening an older notification establishes an arrival boundary without marking
  // the latest messages read. Later arrivals must still show the return-to-bottom hint.
  useEffect(() => {
    if (group) setSeen(previous => previous?.owner === viewportOwner ? previous : { owner: viewportOwner, sequence: latestSequence });
  }, [group, viewportOwner, latestSequence]);
  const newMessageCount = botGroupNewMessageCount(group?.messages ?? [], seen?.owner === viewportOwner ? seen.sequence : null, threadRootId);
  const viewport = useRef({ owner: viewportOwner, group, measuredGroup: null as typeof group,
    contentHeight: 0, viewportHeight: 0, offsetY: 0 });
  if (viewport.current.owner !== viewportOwner) {
    viewport.current = { owner: viewportOwner, group, measuredGroup: null, contentHeight: 0, viewportHeight: 0, offsetY: 0 };
    stickToBottom.current = !messageId && !threadRootId;
    messagePositions.current.clear(); messageHeights.current.clear(); returnAnchor.current = null;
  } else if (viewport.current.group !== group) {
    if (!viewport.current.group || !group) {
      // Loading/error unmounts the ScrollView; its next instance starts unmeasured.
      viewport.current.contentHeight = 0;
      viewport.current.viewportHeight = 0;
      viewport.current.offsetY = 0;
    }
    viewport.current.group = group;
    viewport.current.measuredGroup = null;
  }
  const acknowledge = useCallback(() => {
    if (!focused || AppState.currentState !== 'active' || !stickToBottom.current || pauseReadUntilInteraction.current || !group) return;
    const measured = viewport.current;
    // An intended scrollToEnd has not necessarily reached its destination yet.
    if (measured.owner !== viewportOwner || measured.measuredGroup !== group
      || measured.viewportHeight <= 0 || measured.contentHeight <= 0
      || measured.contentHeight - measured.offsetY - measured.viewportHeight >= STICK_TO_BOTTOM_PX) return;
    setSeen(previous => previous?.owner === viewportOwner && previous.sequence === latestSequence
      ? previous : { owner: viewportOwner, sequence: latestSequence });
    const incoming = group.messages.filter(message => (!threadRootId || message.threadRootId === threadRootId) && message.kind === 'message' && message.isSelf !== true
      && (message.authorKind === 'bot' || (message.authorKind === 'user' && message.isSelf === false))
    );
    if (chat.server && chat.markRead) { void chat.markRead(incoming.map(message => message.id)); return; }
    const at = incoming.reduce((latest, message) => Math.max(latest, message.createdAt), 0);
    if (at > 0) void markRemoteResourceRead(user?.id ?? '', deviceId, groupId, at);
    if (chat.markRead) void chat.markRead(incoming.map(message => message.id));
  }, [focused, group, user?.id, deviceId, groupId, viewportOwner, latestSequence, chat.server, chat.markRead, threadRootId]);
  useEffect(() => {
    const frame = requestAnimationFrame(acknowledge);
    const subscription = AppState.addEventListener('change', state => {
      setForeground(state === 'active');
      if (state === 'active') acknowledge();
    });
    return () => { cancelAnimationFrame(frame); subscription.remove(); };
  }, [acknowledge]);
  // The list row seeds the header while the first read is in flight (display only).
  const cachedRow = group ? null : readRemoteCollectionCache(`${user?.id ?? ''}:${accountGeneration}`, BOT_GROUP_REMOTE_COLLECTION_ID)
    .find((row) => row.host.deviceId === deviceId && row.item.ref.id === groupId) ?? null;

  const identityFor = useCallback<BotGroupIdentityLookup>((botId, fallbackName = '') => {
    const member = group?.members.find((candidate) => candidate.botId === botId);
    return identity(botId, fallbackName, member);
  }, [group?.members, identity]);

  const navigationState = navigation.getState();
  const previousRoute = navigationState?.routes[navigationState.index - 1];
  const previousParams = previousRoute?.params as { groupId?: string; deviceId?: string; threadRootId?: string } | undefined;
  const previousIsGroup = !!navigationState && previousRoute?.name === navigationState.routes[navigationState.index]?.name && previousParams?.groupId === groupId && (previousParams.deviceId ?? '') === deviceId && !previousParams.threadRootId;
  const leave = useCallback(() => {
    if (!threadRootId) { goBackGuarded(router, '/devices'); return; }
    const route = botGroupRoute(host, groupId);
    const fallback = { ...route, params: { ...route.params, messageId: threadRootId } };
    if (previousIsGroup) { goBackGuarded(router, fallback); return; }
    router.replace(fallback);
  }, [router, threadRootId, previousIsGroup, host, groupId]);
  useFocusEffect(useCallback(() => {
    if (!threadRootId) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { leave(); return true; });
    return () => subscription.remove();
  }, [threadRootId, leave]));

  // The computer announces a deleted group before the delete returns, so the phone can re-read
  // it as gone first. That unmounts the settings sheet before it reports closing; leave anyway.
  const hasGroup = group !== null;
  const hasGroupRef = useRef(hasGroup);
  useEffect(() => {
    hasGroupRef.current = hasGroup;
    if (!hasGroup && leaveAfterSettings.current) { leaveAfterSettings.current = false; leave(); }
  }, [hasGroup, leave]);
  const onGroupDeleted = useCallback(() => {
    if (hasGroupRef.current) { leaveAfterSettings.current = true; setSettings(false); } else leave();
  }, [leave]);

  const offlineKey = chat.server ? 'groupChat.server.offline' : 'devices.resources.hostOffline';
  const report = useCallback((error: unknown, fallbackKey: string) => {
    Alert.alert(chat.online ? botGroupActionErrorText(t, error, fallbackKey) : t(offlineKey));
  }, [chat.online, offlineKey, t]);
  const locateMessage = useCallback((id: string) => {
    stickToBottom.current = false;
    restoreOffset.current = null;
    returnAnchor.current = null;
    jumpAttempts.current = 0;
    setJumpTarget(id);
    setReadTarget(id);
  }, []);
  useEffect(() => { if (messageId) locateMessage(messageId); }, [messageId, notificationResponse, locateMessage]);
  const positionAtMessage = useCallback((id: string, y: number) => {
    stickToBottom.current = false;
    const restoring = restoreOffset.current;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - (restoring ?? ((floatingHeader ? headerHeight : 0) + spacing.md))), animated: false });
    if (restoring === null) setHighlightId(id);
    restoreOffset.current = null;
    setJumpTarget('');
  }, [floatingHeader, headerHeight]);
  useEffect(() => {
    if (!highlightId) return;
    const timer = setTimeout(() => setHighlightId(''), 2000);
    return () => clearTimeout(timer);
  }, [highlightId]);
  useEffect(() => {
    if (!readTarget || catchup || !focused || !foreground || !mask.mentions.some(m => m.messageId === readTarget)) return;
    let acknowledged = false;
    const read = () => {
      if (acknowledged || !previewVisibility.isVisible(readTarget)) return;
      acknowledged = true;
      mask.markRead([readTarget]);
      setReadTarget('');
    };
    const unsubscribe = previewVisibility.subscribe(readTarget, read);
    read();
    return unsubscribe;
  }, [readTarget, catchup, focused, foreground, previewVisibility, mask.markRead, mask.mentions]);
  const loadForJump = useRef(false);
  const [jumpPass, setJumpPass] = useState(0);
  useEffect(() => {
    if (!jumpTarget || !group || loadForJump.current) return;
    if (group.messages.some(message => message.id === jumpTarget)) {
      const y = messagePositions.current.get(jumpTarget);
      if (y !== undefined) positionAtMessage(jumpTarget, y);
      return;
    }
    if (!group.hasMoreBefore || !chat.loadOlder || jumpAttempts.current >= 5) {
      Alert.alert(t('groupChat.quote.unavailable')); setJumpTarget(''); return;
    }
    loadForJump.current = true; jumpAttempts.current++;
    void chat.loadOlder().catch(error => { report(error, 'groupChat.loadFailedTitle'); setJumpTarget(''); })
      .finally(() => { loadForJump.current = false; setJumpPass(pass => pass + 1); });
  }, [jumpTarget, group, chat.loadOlder, positionAtMessage, report, t, jumpPass]);

  const rememberGroupPosition = useCallback((fallbackId: string) => {
    const top = viewport.current.offsetY + (floatingHeader ? headerHeight : 0);
    const visible = [...messagePositions.current].filter(([id, y]) =>
      y + (messageHeights.current.get(id) ?? 0) > top).sort((a, b) => a[1] - b[1])[0];
    returnAnchor.current = { owner: viewportOwner, id: visible?.[0] ?? fallbackId,
      offset: visible ? visible[1] - viewport.current.offsetY : (floatingHeader ? headerHeight : 0) + spacing.md };
    stickToBottom.current = false;
    pauseReadUntilInteraction.current = true;
  }, [floatingHeader, headerHeight, viewportOwner]);
  const openThread = useCallback((message: BotGroupMessageView) => {
    if (deviceId || threadRootId || !chat.server || message.threadRootId || message.deleted) return;
    rememberGroupPosition(message.id);
    const route = botGroupRoute(host, groupId);
    router.push({ ...route, params: { ...route.params, threadRootId: message.id } });
  }, [deviceId, threadRootId, chat.server, rememberGroupPosition, host, groupId, router]);
  const openTopic = (rootId: string, target?: string) => {
    if (deviceId || !chat.server) return;
    const root = group?.messages.find(message => message.id === rootId);
    if (root && !target && !threadRootId) { openThread(root); return; }
    if (!threadRootId) rememberGroupPosition(rootId);
    const route = botGroupRoute(host, groupId);
    router.push({ ...route, params: { ...route.params, threadRootId: rootId, ...(target ? { messageId: target } : {}) } });
  };
  const revealShare = (target: string | null) => {
    if (!target) return;
    if (!threadRootId) { locateMessage(target); return; }
    const route = botGroupRoute(host, groupId);
    router.replace({ ...route, params: { ...route.params, messageId: target } });
  };
  const loadOlderReplies = () => {
    if (!chat.loadOlder || autoPaging.current || chat.loadingOlder || !group?.hasMoreBefore) return;
    autoPaging.current = true; setOlderError(false); stickToBottom.current = false;
    const visible = group.messages.filter(message => message.threadRootId === threadRootId)
      .filter(message => (messagePositions.current.get(message.id) ?? -1) + (messageHeights.current.get(message.id) ?? 0) >= viewport.current.offsetY)
      .sort((a, b) => (messagePositions.current.get(a.id) ?? 0) - (messagePositions.current.get(b.id) ?? 0))[0];
    pagingAnchor.current = visible ? { id: visible.id, y: messagePositions.current.get(visible.id) ?? 0,
      offset: viewport.current.offsetY, ids: new Set(group.messages.map(message => message.id)), sequence: visible.serverSequence ?? String(visible.sequence) } : null;
    void chat.loadOlder().catch(() => { pagingAnchor.current = null; setOlderError(true); })
      .finally(() => { autoPaging.current = false; });
  };
  useEffect(() => {
    if (!focused || !returnAnchor.current || threadRootId) return;
    const anchor = returnAnchor.current;
    returnAnchor.current = null;
    if (anchor.owner !== viewportOwner) return;
    stickToBottom.current = false;
    restoreOffset.current = anchor.offset;
    jumpAttempts.current = 0;
    setJumpTarget(anchor.id);
  }, [focused, viewportOwner, threadRootId]);

  const hidePending = useRef(false);
  const hideScope = useRef('');
  const currentHideScope = `${groupId}:${deviceId}:${accountGeneration}`;
  hideScope.current = currentHideScope;
  useEffect(() => () => { hideScope.current = ''; }, []);
  const leftScope = useRef('');
  const focusedRef = useRef(focused); focusedRef.current = focused;
  const leaveCurrentChat = useCallback((captured: string) => {
    if (!focusedRef.current || hideScope.current !== captured || leftScope.current === captured) return;
    leftScope.current = captured;
    leave();
  }, [leave]);
  useEffect(() => {
    if (focused && chat.listHidden) leaveCurrentChat(currentHideScope);
  }, [focused, chat.listHidden, currentHideScope, leaveCurrentChat]);
  const actFromSettings: typeof chat.act = async (action, input) => {
    const captured = currentHideScope;
    const receipt = await chat.act(action, input);
    // The list listener may already have unmounted settings; the screen still
    // owns this route and can complete navigation after the acknowledgement.
    if (action === 'hide' || action === 'leave') leaveCurrentChat(captured);
    return receipt;
  };
  const removeFromList = async () => {
    if (hidePending.current) return;
    hidePending.current = true;
    const captured = currentHideScope;
    try {
      if (!await showConfirm({ title: t('groupChat.lifecycle.hide'), message: t('groupChat.lifecycle.hideNote'),
        cancelLabel: t('devices.common.cancel'), confirmLabel: t('groupChat.lifecycle.hide'), destructive: true }) || hideScope.current !== captured) return;
      await chat.act('hide');
      leaveCurrentChat(captured);
    } catch (error) { if (hideScope.current === captured) Alert.alert(botGroupActionErrorText(t, error, 'groupChat.lifecycle.failed')); }
    finally { hidePending.current = false; }
  };

  const continueRound = async () => {
    if (continuing) return;
    setContinuing(true);
    stickToBottom.current = true;
    try { await chat.act('continue'); } catch (error) { report(error, 'groupChat.timeline.continueFailed'); } finally { setContinuing(false); }
  };

  /** 开始 / 不用了 / 继续 / 重试 / 结束分工; the computer pushes the change and the view re-reads. */
  const runPlanAction = async (action: BotGroupPlanAction, planId: string) => {
    if (planPendingRef.current) return;
    planPendingRef.current = true;
    setPlanPending({ planId, action });
    stickToBottom.current = true;
    try { await chat.act(`plan-${action}`, { planId }); } catch (error) { report(error, PLAN_ACTION_FAILED[action]); } finally {
      planPendingRef.current = false;
      setPlanPending(null);
    }
  };

  const editPlanStep = async (planId: string, step: BotGroupPlanStepView, action: 'reassign' | 'remove', botId?: string) => {
    if (planPendingRef.current) return;
    planPendingRef.current = true;
    setPlanPending({ planId, action: 'edit' });
    try {
      await chat.act('plan-edit', { planId, position: step.position, action, ...(botId ? { botId } : {}) });
    } catch (error) { report(error, 'groupChat.plan.editFailed'); } finally {
      planPendingRef.current = false;
      setPlanPending(null);
    }
  };

  const send = async (input: BotGroupSendInput) => {
    pauseReadUntilInteraction.current = false;
    stickToBottom.current = true;
    const quote = replyTo;
    try {
      if (input.mentions.allBots && !group?.supportsMentionAudiences) throw new Error('ALL_BOTS_MENTION_DISABLED');
      await chat.act('send', {
        text: input.text,
        mentions: input.mentions,
        clientId: input.clientId,
        ...(quote ? { quote: { messageId: quote.messageId } } : {}),
        ...(threadRootId && input.alsoSendToMain ? { alsoSendToMain: true } : {}),
        ...(input.division ? { division: true } : {}),
        // The active server/computer path declares attachment support (see the composer).
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
      });
      if (quote) setReplyTo(current => current?.messageId === quote.messageId ? null : current);
    } catch (error) {
      report(error, 'groupChat.composer.sendFailed');
      throw error;
    }
  };

  const stop = async () => {
    try { await chat.act('stop'); } catch (error) { report(error, 'groupChat.composer.stopFailed'); }
  };

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    previewVisibility.setViewport(contentOffset.y, layoutMeasurement.height);
    if (stickToBottom.current) setSeen(previous => previous?.owner === viewportOwner && previous.sequence === latestSequence
      ? previous : { owner: viewportOwner, sequence: latestSequence });
    Object.assign(viewport.current, { measuredGroup: group, contentHeight: contentSize.height,
      offsetY: contentOffset.y, viewportHeight: layoutMeasurement.height });
    stickToBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < STICK_TO_BOTTOM_PX;
    acknowledge();
    if (threadRootId && userScrolled.current && !olderError && contentOffset.y < (messageHeights.current.get(threadRootId) ?? 0) + 160) loadOlderReplies();
  };

  const title = group?.name ?? (cachedRow ? resolveRemoteText(cachedRow.item.display.title, i18n.language) : '');
  const direct = group?.conversationKind === 'direct';
  const peer = direct ? group.members.find(member => !member.isSelf) : undefined;
  // The header reads the group's size, not a roll call (owner request 2026-10-26); the names stay
  // in the accessibility label and in group settings. The list row's member links seed the count.
  const memberNames = direct ? '' : group
    ? botGroupMemberNames(group.members, t('groupChat.memberSeparator'))
    : cachedRow?.item.display.subtitle ? resolveRemoteText(cachedRow.item.display.subtitle, i18n.language) : '';
  const memberCount = group ? group.members.length
    : cachedRow?.item.links?.filter((link) => link.rel === BOT_GROUP_MEMBER_LINK_REL).length ?? 0;
  const memberLine = direct || memberCount === 0 ? '' : t('groupChat.memberCount', { count: memberCount });
  const headerMembers = group ? group.members.map((member) => identityFor(member.botId, member.name)) : [];

  const threadFollow = threadRootId && chat.followThread ? <BotGroupThreadFollow nativeHeader={nativeHeader}
    following={chat.threadMeta?.following} online={chat.online}
    onChange={chat.followThread} onError={error => report(error, 'groupChat.thread.followFailed')} /> : undefined;
  const header = imageSelectionActive ? <View style={styles.shareHeader}>
    <Stack.Screen options={{ headerShown: false }} />
    <ShareSelectAllButton busy={imageShareBusy} shareableIds={shareableIds} />
  </View> : <><ChatIdentityHeader testIDPrefix="botGroup" settingsTestID="botGroup.settingsButton" nativeHeader={nativeHeader}
    mark={threadRootId ? null : peer ? <BotGroupAvatar deviceId={deviceId} identity={identityFor(peer.botId, peer.name)} size={CHAT_HEADER_MARK_SIZE} online={chat.online} /> : <BotGroupDuoAvatar deviceId={deviceId} members={headerMembers} online={chat.online} variant="header"
      working={group?.round.status === 'running'} />}
    title={threadRootId ? t('groupChat.thread.title') : title}
    accessory={nativeHeader ? undefined : threadFollow}
    subtitle={threadRootId ? title : memberLine}
    identityLabel={[title, memberLine, memberNames].filter(Boolean).join(', ')}
    identityHint={t('groupChat.settings.open')}
    controlsReady={!!group}
    onBack={leave}
    onOpenSettings={direct || threadRootId ? undefined : () => setSettings(true)}
    settingsLabel={t('groupChat.settings.open')} />{nativeHeader ? threadFollow : null}</>;

  const showOffline = useDelayedConnectionNotice(!!group && !chat.online);
  const offlineNote = showOffline
    ? <Text accessibilityRole="alert" style={styles.offline} testID="botGroup.offlineNote">{t(chat.canQueue ? 'message.queue.waitingForNetwork' : offlineKey)}</Text> : null;
  let body;
  if (chat.state.kind === 'loading' && !chat.online) {
    // Nothing to show until the computer is reachable again; the screen re-reads on reconnect.
    body = <View style={styles.center}>
      <MainWindowEmptyState centered testID="botGroup.offline" title={t('groupChat.loadFailedTitle')} copy={t(offlineKey)}>
        <View style={styles.emptyActions}>
          <MainWindowActionButton action={{ label: t('shared.back'), onPress: leave, testID: 'botGroup.leave' }} />
        </View>
      </MainWindowEmptyState>
    </View>;
  } else if (chat.state.kind === 'loading') {
    body = <View style={styles.center}><ActivityIndicator color={colors.textSecondary} /></View>;
  } else if (chat.state.kind !== 'ready' || !group) {
    const failed = chat.state.kind === 'error';
    const errorCopyKey = !failed ? 'groupChat.unavailableDescription'
      : !chat.server ? 'groupChat.loadFailedDescription'
      : chat.state.kind === 'error' && chat.state.message === 'CHAT_ENDPOINT_UNAVAILABLE' ? 'groupChat.server.endpointUnavailable' : 'groupChat.server.loadFailed';
    body = <View style={styles.center}>
      <MainWindowEmptyState centered testID={failed ? 'botGroup.loadFailed' : 'botGroup.unavailable'}
        title={t(threadRootId ? 'groupChat.thread.unavailableTitle' : failed ? 'groupChat.loadFailedTitle' : 'groupChat.unavailableTitle')}
        copy={t(errorCopyKey)}>
        <View style={styles.emptyActions}>
          <MainWindowActionButton action={{ label: t('shared.back'), onPress: leave, testID: 'botGroup.leave' }} />
          {!failed && !threadRootId ? <MainWindowActionButton action={{ label: t('groupChat.lifecycle.hide'), onPress: () => void removeFromList(), testID: 'botGroup.hide' }} /> : null}
          {failed ? <MainWindowActionButton action={{ label: t('devices.resources.retry'), tone: 'primary', onPress: chat.reload, testID: 'botGroup.retry' }} /> : null}
        </View>
      </MainWindowEmptyState>
    </View>;
  } else {
    body = <KeyboardAvoidingView
      style={styles.flex}
      enabled={Platform.OS === 'ios' || Platform.OS === 'android'}
      behavior={keyboardAvoidingBehaviorForPlatform(
        Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
      )}
    >
      {floatingHeader ? null : offlineNote}
      {group.dissolvedAt || group.archived ? <Text style={styles.offline}>{t(group.dissolvedAt ? 'groupChat.lifecycle.dissolved' : 'groupChat.thread.archived')}</Text> : null}
      <View style={styles.flex}>
      <MessageListVisibilityContext.Provider value={previewVisibility}>
      <ScrollView ref={scrollRef} style={styles.flex} contentContainerStyle={[styles.timeline, threadRootId && styles.threadTimeline, floatingHeader && { paddingTop: headerHeight + spacing.md }]}
        scrollIndicatorInsets={floatingHeader ? { top: headerHeight } : undefined} keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        maintainVisibleContentPosition={chat.server && !threadRootId ? { minIndexForVisible: group.hasMoreBefore ? 1 : 0 } : undefined}
        onScroll={onScroll} scrollEventThrottle={64}
        onScrollBeginDrag={() => { pauseReadUntilInteraction.current = false; userScrolled.current = true; }}
        onLayout={event => { viewport.current.viewportHeight = event.nativeEvent.layout.height; previewVisibility.setHeight(event.nativeEvent.layout.height); acknowledge(); }}
        onContentSizeChange={(_width, height) => {
          viewport.current.contentHeight = height;
          viewport.current.measuredGroup = group;
          if (focused && stickToBottom.current) scrollRef.current?.scrollToEnd({ animated: false });
          acknowledge();
        }}
        testID="botGroup.timeline">
        <BotGroupTimeline threadRootId={threadRootId} onOpenThread={!threadRootId && !deviceId && chat.server && !direct ? openThread : undefined} group={group} deviceId={deviceId} online={chat.online} identityFor={identityFor}
          onRetrySource={chat.reload}
          onOpenTopic={!deviceId && chat.server ? openTopic : undefined} onRevealShare={revealShare}
          onShare={chat.shareToMain ? id => { void chat.shareToMain!(id).catch(error => report(error, 'groupChat.thread.shareFailed')); } : undefined}
          selectedImages={selectedImages} imageShareBusy={imageShareBusy}
          onShareImage={!deviceId && chat.server ? id => { Keyboard.dismiss(); shareSelectionStore.enter(shareScope, id); } : undefined}
          sharedReplies={chat.threadMeta?.shares} readBefore={initialRead.current.sequence} olderError={olderError}
          highlightId={highlightId} onLocateMessage={locateMessage}
          pending={chat.pending} onPendingAction={(id, action) => { void chat.pendingAction?.(id, action).catch(error => report(error, 'groupChat.composer.sendFailed')); }}
          onReply={!threadRootId && (chat.server || group.serverBacked) && !group.archived && !group.dissolvedAt ? message => { setReplyTo(botGroupQuoteFromMessage(message)); setReplyFocusRequest(request => request + 1); } : undefined}
          onMessageLayout={(id, y, height) => {
            previewVisibility.setLayout(id, { y, height });
            messagePositions.current.set(id, y); messageHeights.current.set(id, height);
            const anchor = pagingAnchor.current;
            if (anchor?.id === id && group.messages.some(message => message.threadRootId === threadRootId && !anchor.ids.has(message.id)
              && BigInt(message.serverSequence ?? String(message.sequence)) < BigInt(anchor.sequence))) {
              pagingAnchor.current = null;
              scrollRef.current?.scrollTo({ y: Math.max(0, anchor.offset + y - anchor.y), animated: false });
            }
            if (jumpTarget === id) positionAtMessage(id, y);
          }}
          resolveMedia={resolveMedia} resolveServerMedia={chat.media}
          loadOlder={threadRootId ? loadOlderReplies : chat.loadOlder ? () => { stickToBottom.current = false; void chat.loadOlder!().catch(error => report(error, 'groupChat.loadFailedTitle')); } : undefined}
          loadingOlder={chat.loadingOlder} continuing={continuing} planPending={planPending}
          onContinue={() => void continueRound()}
          onPlanAction={(action, planId) => void runPlanAction(action, planId)}
          onEditStep={(planId, step, action, botId) => void editPlanStep(planId, step, action, botId)}
          />
      {!imageSelectionActive && !threadRootId ? <BotGroupWorkArea group={group} deviceId={deviceId} online={chat.online} identityFor={identityFor}
        onError={message => { if (message) Alert.alert(message); }} /> : null}
      </ScrollView>
      </MessageListVisibilityContext.Provider>
      {newMessageCount > 0 || mask.mentions.length > 0 ? <View style={styles.newMessages} accessibilityLiveRegion="polite">
        {mask.mentions.length > 0 ? <MainWindowActionButton density="compact" style={styles.newMessagesButton} action={{
          label: `@ · ${mask.mentions.length}`, accessibilityLabel: t('groupChat.mask.catchup.title'), testID: 'botGroup.mentions', onPress: () => setCatchup(true),
        }} /> : null}
        {newMessageCount > 0 ? <CompanionFadeIn play distance={spacing.xs}>
          <MainWindowActionButton density="compact" style={styles.newMessagesButton} action={{
            label: t('groupChat.timeline.newMessages', { count: newMessageCount }),
            accessibilityLabel: t('message.renderer.newMessagesToBottom'),
            testID: 'botGroup.newMessages',
            onPress: () => { pauseReadUntilInteraction.current = false; stickToBottom.current = true; scrollRef.current?.scrollToEnd({ animated: false }); },
          }} />
        </CompanionFadeIn> : null}
      </View> : null}
      </View>
      {!imageSelectionActive && shareDeliveries.length ? <ScrollView style={styles.shareDeliveries} nestedScrollEnabled>
        {shareDeliveries.filter(row => row.chat?.shareToMain?.state === 'failed').length > 1 ? <Text style={styles.threadEmpty}>{t('groupChat.thread.shareFailed_many', { count: shareDeliveries.filter(row => row.chat?.shareToMain?.state === 'failed').length })}</Text> : null}
        {shareDeliveries.map(row => <View key={row.item.clientId} style={styles.sharePending} testID={`botGroup.thread.delivery.${row.item.clientId}`}>
        <Text numberOfLines={2} style={styles.threadEmpty}>{row.item.text}</Text>
        <Text style={styles.threadEmpty}>{t(row.suspended ? 'groupChat.thread.shareStopped' : row.chat!.shareToMain!.state === 'pending' ? chat.online ? 'groupChat.thread.posting' : 'message.queue.waitingForNetwork' : row.chat!.shareToMain!.state === 'unavailable' ? 'groupChat.thread.sourceUnavailable' : 'groupChat.thread.shareFailed')}</Text>
        {row.chat!.shareToMain!.state === 'failed' && !row.suspended ? <MainWindowActionButton density="compact" action={{ label: t('groupChat.thread.retryShare'), onPress: () => { void chat.pendingAction?.(row.item.clientId, 'retry').catch(error => report(error, 'groupChat.thread.shareFailed')); } }} /> : null}
        {row.chat!.shareToMain!.state === 'unavailable' || row.suspended ? <MainWindowActionButton density="compact" action={{ label: t('groupChat.thread.dismiss'), onPress: () => { void chat.pendingAction?.(row.item.clientId, 'dismiss-share').catch(error => report(error, 'groupChat.thread.shareFailed')); } }} /> : null}
      </View>)}
      </ScrollView> : null}
      {!imageSelectionActive && replyTo ? <View style={styles.replyDraft}>
        <View style={styles.replyDraftBody}><BotGroupQuote display={resolveBotGroupQuote(replyTo, group.messages)} onPress={() => locateMessage(replyTo.messageId)} /></View>
        <Pressable accessibilityRole="button" accessibilityLabel={t('message.quote.remove')}
          onPress={() => setReplyTo(null)} style={styles.replyDraftClose} testID="botGroup.cancelReply">
          <View pointerEvents="none" style={styles.replyDraftCloseIcon}>
            <X color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
          </View>
        </Pressable>
      </View> : null}
      <BotGroupTopicImageShare key={shareScope} selectionScope={shareScope} messages={selectedMessages} allIds={shareableIds}
        resolveMedia={chat.media} onBusyChange={setImageShareBusy} />
      <View style={selectedImages ? styles.hiddenComposer : undefined} testID="botGroup.composerContainer">
        <BotGroupComposer allowMentionAllBots={group.supportsMentionAudiences === true && group.allowMentionAllBots === true} key={`${viewportOwner}:composer`} topic={!!threadRootId} onParticipate={mask.participate} maskIndicator={mask.state?.settings.companionId ? <GroupMaskStatus mask={mask} deviceId={deviceId} onPress={() => setMaskSettings(true)} /> : undefined} members={group.members} identityFor={identityFor} deviceId={deviceId} online={(chat.online || !!chat.canQueue) && !group.archived && !group.dissolvedAt && (!threadRootId || group.messages.some(message => message.id === threadRootId && !message.deleted))}
        quoteMessageId={replyTo?.messageId} focusRequest={replyFocusRequest}
        placeholder={threadRootId ? t('groupChat.thread.placeholder') : undefined}
        running={!threadRootId && group.round.status === 'running'} planState={threadRootId ? null : botGroupComposerPlanState(openBotGroupPlan(group), group.replyMode)}
        divisionSupported={!threadRootId && !chat.server && (!group.singleSpeaker || group.supportsDivision === true)} attachmentsSupported={!threadRootId && group.supportsAttachments === true} uploadAttachment={chat.uploadAttachment} onSend={send} onStop={stop} />
      </View>
    </KeyboardAvoidingView>;
  }

  return <SafeAreaView style={styles.screen} edges={floatingHeader ? ['left', 'right', 'bottom'] : ['top', 'left', 'right', 'bottom']} testID="botGroup.screen">
    {threadRootId ? <Stack.Screen options={{ gestureEnabled: previousIsGroup }} /> : null}
    {nativeHeader ? null : <Stack.Screen options={{ headerShown: false }} />}
    {floatingHeader ? <>
      <View style={[styles.flex, group ? null : { paddingTop: headerHeight }]}>{body}</View>
      <SessionHeaderNativeBlur height={Math.max(headerHeight, nativeHeader ? nativeHeaderHeight : insets.top + navigationChrome.target)} fadeInside={CHAT_HEADER_BLUR_FADE_INSIDE} />
      <View style={[styles.floatingHeader, { paddingTop: nativeHeader && !imageSelectionActive ? nativeHeaderHeight : insets.top }]} onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}>
        {header}
        {offlineNote}
      </View>
    </> : <>
      {header}
      {body}
    </>}
    {group && !direct ? <BotGroupSettingsSheet readOnly={chat.server} visible={settings} group={group} host={host} identityFor={identityFor} online={chat.online}
      mask={mask} onMask={mask.state ? () => { openMaskAfterSettings.current = true; setSettings(false); } : undefined}
      act={actFromSettings} onClose={() => setSettings(false)}
      onRefresh={chat.reload}
      onClosed={() => { if (openMaskAfterSettings.current) { openMaskAfterSettings.current = false; setMaskSettings(true); } if (leaveAfterSettings.current) { leaveAfterSettings.current = false; leave(); } }}
      onDeleted={onGroupDeleted} /> : null}
    <GroupMaskSettingsSheet visible={maskSettings && !!mask.state} mask={mask} onClose={() => setMaskSettings(false)} />
    <GroupMaskCatchupSheet visible={catchup && !!mask.state} mask={mask} onClose={() => setCatchup(false)}
      onLocate={mention => { locateAfterCatchup.current = mention; setCatchup(false); }} onClosed={() => {
        const mention = locateAfterCatchup.current; locateAfterCatchup.current = null;
        if (!mention) return;
        if ((mention.threadRootId ?? '') === (threadRootId ?? '')) locateMessage(mention.messageId);
        else router.push({ pathname: '/companions/groups/[groupId]', params: { groupId, deviceId, deviceName,
          messageId: mention.messageId, ...(mention.threadRootId ? { threadRootId: mention.threadRootId } : {}) } } as never);
      }} />
  </SafeAreaView>;
}

function planCardPending(action: PlanPending['action'] | null): BotGroupPlanCardAction | null {
  return action === 'start' || action === 'dismiss' || action === 'edit' ? action : null;
}

function followUpPending(action: PlanPending['action'] | null): BotGroupFollowUpAction | null {
  return action === 'continue' || action === 'retry' || action === 'dismiss' ? action : null;
}

export function BotGroupTimeline({
  group, deviceId, online, identityFor, resolveMedia, resolveServerMedia, loadOlder, loadingOlder, continuing, planPending, onContinue, onPlanAction, onEditStep,
  onMessageLayout, onLocateMessage, highlightId, onReply, onOpenThread, threadRootId, pending = [], onPendingAction,
  onOpenTopic, onRevealShare, onShare, sharedReplies, readBefore, olderError, onRetrySource, onShareImage, selectedImages, imageShareBusy,
}: {
  group: BotGroupRemoteChatData;
  pending?: readonly DurableOutboxRecord[];
  onPendingAction?: (id: string, action: 'retry' | 'cancel' | 'dismiss-share') => void;
  deviceId: string;
  online: boolean;
  identityFor: BotGroupIdentityLookup;
  /** Reads a picture attached to a message from the computer. */
  resolveMedia: ResolveRemoteMediaFn;
  resolveServerMedia?: (id: string, signal?: AbortSignal) => Promise<BotGroupAttachment>;
  loadOlder?: () => void;
  loadingOlder?: boolean;
  continuing: boolean;
  planPending: PlanPending | null;
  onContinue(): void;
  onPlanAction(action: BotGroupPlanAction, planId: string): void;
  onEditStep(planId: string, step: BotGroupPlanStepView, action: 'reassign' | 'remove', botId?: string): void;
  onMessageLayout?: (id: string, y: number, height: number) => void;
  onLocateMessage?: (id: string) => void;
  highlightId?: string;
  onReply?: (message: BotGroupMessageView) => void;
  onOpenThread?: (message: BotGroupMessageView) => void;
  threadRootId?: string;
  onOpenTopic?: (rootId: string, messageId?: string) => void;
  onRevealShare?: (messageId: string | null) => void;
  onShare?: (messageId: string) => void;
  onRetrySource?: () => void;
  selectedImages?: string[]; imageShareBusy?: boolean; onShareImage?: (messageId: string) => void;
  sharedReplies?: Record<string, { messageId: string; bySelf: boolean }>;
  readBefore?: string;
  olderError?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const canonicalIds = new Set(group.messages.map(message => message.id));
  const rowIdentity = useRef({ groupId: group.id, ids: new Map<string, string>() });
  if (rowIdentity.current.groupId !== group.id) rowIdentity.current = { groupId: group.id, ids: new Map() };
  for (const row of pending) if (row.chat?.messageId) rowIdentity.current.ids.set(row.chat.messageId, `local:${row.item.clientId}`);
  const rowKey = (id: string) => rowIdentity.current.ids.get(id) ?? id;
  const local = pending.filter(row => !row.chat?.messageId || !canonicalIds.has(row.chat.messageId));
  const pendingById = new Map(local.map(row => [`local:${row.item.clientId}`, row]));
  const root = threadRootId ? group.messages.find(message => message.id === threadRootId && !message.deleted) : undefined;
  const messages = threadRootId
    ? [...(root ? [root] : []), ...group.messages.filter(message => message.threadRootId === threadRootId && !message.deleted), ...local.map(pendingChatMessage)]
    : [...group.messages, ...local.map(pendingChatMessage)];
  const [expandedRoot, setExpandedRoot] = useState(false);
  const planById = new Map(group.plans.map((plan) => [plan.id, plan]));
  const openPlan = openBotGroupPlan(group);
  const followUp = botGroupPlanFollowUp(openPlan);
  const continueId = continuableRoundEndId(messages, group.round);
  const timeGroups = collectBotMessageTimeGroups(messages.map((message) => ({ clientId: message.id, createdAt: message.createdAt })));
  const allLabel = t('groupChat.mention.all');
  const allBotsLabel = t('groupChat.mention.allBots');
  const mentionLabels = useMemo(() => [allLabel, allBotsLabel, ...group.members.map((member) => member.name)], [allLabel, allBotsLabel, group.members]);
  const running = !threadRootId && group.round.status === 'running';
  const memberById = new Map(group.members.map((member) => [member.botId, member]));
  const pendingFor = (planId: string | null) => planId && planPending?.planId === planId ? planPending.action : null;
  const firstNew = readBefore === undefined ? undefined : messages.findIndex(message => message.threadRootId === threadRootId && message.isSelf === false
    && message.kind === 'message' && BigInt(message.serverSequence ?? String(message.sequence)) > BigInt(readBefore));
  const firstReply = messages.findIndex(message => message.threadRootId === threadRootId);
  const threadBoundary = <View style={styles.threadBoundary} testID="botGroup.thread.separator">
    <View style={styles.threadMeta}>
      <Text style={styles.threadCaption}>{root?.replyCount !== undefined ? t('groupChat.thread.replyCount', { count: root.replyCount }) : t('groupChat.thread.replies')}</Text>
      <View style={styles.threadLine} />
    </View>
    {loadingOlder ? <ActivityIndicator accessibilityLabel={t('groupChat.thread.loadingOlder')} /> : null}
    {olderError && loadOlder ? <MainWindowActionButton density="compact" action={{ label: t('groupChat.thread.retryOlder'), onPress: loadOlder, testID: 'botGroup.thread.retryOlder' }} /> : null}
    {messages.length === (root ? 1 : 0) ? <Text style={styles.threadEmpty} testID="botGroup.thread.empty">{t('groupChat.thread.empty')}</Text> : null}
  </View>;
  return <>
    {threadRootId && !root ? <View testID="botGroup.thread.rootUnavailable">
      <Text style={styles.threadEmpty}>{t('groupChat.thread.rootUnavailable')}</Text>{threadBoundary}
    </View> : null}
    {!threadRootId && group.hasMoreBefore && loadOlder ? <MainWindowActionButton action={{ label: t('groupChat.server.loadOlder'), busy: loadingOlder, onPress: loadOlder, testID: 'botGroup.loadOlder' }} /> : !threadRootId && group.hasMoreBefore ? <Text style={styles.olderNote} testID="botGroup.olderOnComputer">{t('groupChat.timeline.olderOnComputer')}</Text> : null}
    {!threadRootId && messages.length === 0 && !running ? <MainWindowEmptyState centered testID="botGroup.empty"
      title={t('groupChat.timeline.emptyTitle')} copy={t('groupChat.timeline.emptyDescription')} /> : null}
    {messages.map((message, index) => {
      const isRoot = message.id === threadRootId;
      const longRoot = isRoot && message.content.length > 600;
      const displayMessage = longRoot && !expandedRoot ? { ...message, content: `${message.content.slice(0, 600)}…` } : message;
      const queued = pendingById.get(message.id);
      const groupTime = timeGroups.get(message.id);
      const previous = index > 0 ? messages[index - 1] : undefined;
      // G2: the same teammate speaking again inside one time group keeps its avatar and name once.
      const continued = previous?.id !== threadRootId && groupTime === undefined && message.kind === 'message' && message.authorKind === 'bot'
        && previous?.kind === 'message' && previous.authorKind === 'bot' && previous.authorBotId === message.authorBotId;
      const posted = pending.find(row => row.chat?.messageId === message.id && row.chat.shareToMain?.state === 'sent')?.chat?.shareToMain;
      const shared = posted ? { messageId: posted.messageId ?? null, bySelf: true } : sharedReplies?.[message.id];
      const revealShare = () => onRevealShare?.(shared?.messageId ?? null);
      const ownMessage = message.authorKind === 'user' && message.isSelf !== false
        && (!message.threadShare || message.threadShare.status === 'available' && message.threadShare.sharedByAuthor);
      const actions = <BotGroupMessageActions message={message} align={ownMessage ? 'right' : 'left'} online={online} readOnly={!!group.archived || !!group.dissolvedAt}
            onShareImage={onShareImage && (!message.threadShare || message.threadShare.status === 'available') ? () => onShareImage(message.id) : undefined}
            onQuote={onReply && isBotGroupMessageQuotable(message) ? () => onReply(message) : undefined}
            onThread={onOpenThread && !message.threadRootId ? () => onOpenThread(message) : undefined}
            onShare={onShare && !isRoot && message.threadRootId ? () => onShare(message.id) : undefined}
            shared={shared} onReveal={revealShare} />;
      const key = rowKey(message.id);
      const selectable = selectedImages && !queued && message.kind === 'message' && !message.deleted
        && (!message.threadShare || message.threadShare.status === 'available');
      const messageRow = <>
        {!threadRootId && groupTime !== undefined ? <Text style={styles.time}>{formatBotMessageGroupTime(groupTime, i18n.language)}</Text> : null}
        {firstNew !== undefined && index === firstNew && firstNew > firstReply ? <View style={styles.newReplyBoundary}><View style={styles.newReplyLine} /><Text style={styles.newReplyDivider}>{t('groupChat.thread.newRepliesDivider')}</Text></View> : null}
        <CompanionEntering id={key} createdAt={message.createdAt} kind={message.authorKind === 'user' ? 'send' : 'reply'}>
        <BotGroupTimelineItem groupId={group.id} footer={selectedImages || queued || message.kind !== 'message' || message.deleted ? undefined : <View style={[styles.messageFooter, ownMessage && styles.ownMessageFooter]}>
        {onOpenThread && !message.threadRootId && !message.threadShare ?
          <BotGroupThreadEntry message={message} identityFor={identityFor} onPress={() => onOpenThread(message)} />
        : null}
        {message.threadShare ?
          <BotGroupThreadEntry message={message} summary={messages.find(candidate => candidate.id === message.threadShare?.threadRootId) ?? message.threadShare}
            identityFor={identityFor} onPress={() => onOpenTopic?.(message.threadShare!.threadRootId, message.threadShare!.messageId)} />
        : null}
        {shared ?
          <BotGroupThreadPosted messageId={message.id} shared={shared} onPress={revealShare} />
        : null}
        {actions}
        </View>} topic={!!threadRootId} isRoot={isRoot} onRetrySource={onRetrySource} message={displayMessage} continued={continued} member={message.authorBotId ? memberById.get(message.authorBotId) : undefined}
          quoteDisplay={message.quote ? resolveBotGroupQuote(message.quote, messages) : undefined}
          onLocateQuote={message.quote && onLocateMessage ? () => onLocateMessage(message.quote!.messageId) : undefined}
          members={group.members} deviceId={deviceId} online={online} identityFor={identityFor} mentionLabels={mentionLabels}
          resolveMedia={resolveMedia} resolveServerMedia={resolveServerMedia}
          canContinue={message.id === continueId} continuing={continuing} onContinue={onContinue}
          plan={message.planId ? planById.get(message.planId) : undefined}
          planActionable={message.kind === 'plan' && openPlan?.id === message.planId && openPlan.status === 'proposed'}
          planReassignable={message.kind === 'plan' && openPlan?.id === message.planId && openPlan.status === 'waiting'}
          planPending={planCardPending(pendingFor(message.planId))}
          onPlanAction={(action) => { if (message.planId) onPlanAction(action, message.planId); }}
          onEditStep={(step, action, botId) => { if (message.planId) onEditStep(message.planId, step, action, botId); }} />
        </CompanionEntering>
        {longRoot ? <MainWindowActionButton density="compact" action={{ label: t(expandedRoot ? 'groupChat.thread.collapseRoot' : 'groupChat.thread.expandRoot'), onPress: () => setExpandedRoot(value => !value), testID: 'botGroup.thread.expandRoot' }} /> : null}
        {isRoot ? threadBoundary : null}
      </>;
      return <View key={key} testID={`botGroup.row.${message.id}`} style={[styles.item, highlightId === message.id && styles.locatedMessage]}
        onLayout={event => onMessageLayout?.(message.id, event.nativeEvent.layout.y, event.nativeEvent.layout.height)}>
        {selectable ? <ShareMessageCheckbox clientId={message.id} disabled={imageShareBusy} fill>
          <View style={styles.flex}>{messageRow}</View>
        </ShareMessageCheckbox> : messageRow}
        {queued ? <View style={styles.pendingRow} testID={`botGroup.pending.${queued.item.clientId}`}>
          <Text style={styles.pendingText}>{t(queued.state === 'failed' ? 'message.queue.notSent' : !online ? 'message.queue.waitingForNetwork' : 'message.queue.queued')}</Text>
          {queued.state === 'failed' && !queued.suspended ? <MainWindowActionButton density="compact" action={{ label: t('message.queue.retry'), onPress: () => onPendingAction?.(queued.item.clientId, 'retry') }} /> : null}
          {!queued.enqueueStarted && queued.state !== 'sending' ? <MainWindowActionButton density="compact" action={{ label: t('message.queue.cancelSend'), onPress: () => onPendingAction?.(queued.item.clientId, 'cancel') }} /> : null}
        </View> : null}

      </View>;
    })}
    {!threadRootId && openPlan && followUp ? <View style={styles.indented}>
      <BotGroupPlanFollowUpRow followUp={followUp} identityFor={identityFor} deviceId={deviceId} online={online}
        stepNumber={openPlan.steps.indexOf(followUp.kind === 'continue' ? followUp.next : followUp.failed) + 1} stepTotal={openPlan.steps.length}
        pending={followUpPending(pendingFor(openPlan.id))}
        onContinue={() => onPlanAction('continue', openPlan.id)}
        onRetry={() => onPlanAction('retry', openPlan.id)}
        onEnd={() => onPlanAction('dismiss', openPlan.id)} />
    </View> : null}
  </>;
}

function BotGroupTimelineItem({
  groupId, message, footer, topic = false, isRoot = false, onRetrySource, continued = false, quoteDisplay, onLocateQuote, member, members, deviceId, online, identityFor, mentionLabels, resolveMedia, resolveServerMedia, canContinue, continuing, onContinue,
  plan, planActionable, planReassignable, planPending, onPlanAction, onEditStep,
}: {
  groupId: string;
  message: BotGroupMessageView;
  footer?: ReactNode;
  onRetrySource?: () => void;
  topic?: boolean; isRoot?: boolean;
  /** Same teammate as the message just above: no second avatar or name. */
  continued?: boolean;
  /** 引用回复: how the quoted message reads now. */
  quoteDisplay?: BotGroupQuoteDisplay;
  onLocateQuote?: () => void;
  member: BotGroupMemberView | undefined;
  members: readonly BotGroupMemberView[];
  deviceId: string;
  online: boolean;
  identityFor: BotGroupIdentityLookup;
  mentionLabels: readonly string[];
  resolveMedia: ResolveRemoteMediaFn;
  resolveServerMedia?: (id: string, signal?: AbortSignal) => Promise<BotGroupAttachment>;
  canContinue: boolean;
  continuing: boolean;
  onContinue(): void;
  /** Snapshot of the plan this message belongs to (安排卡, hand-off or plan end). */
  plan: BotGroupPlanView | undefined;
  planActionable: boolean;
  planReassignable: boolean;
  planPending: BotGroupPlanCardAction | null;
  onPlanAction(action: 'start' | 'dismiss'): void;
  onEditStep(step: BotGroupPlanStepView, action: 'reassign' | 'remove', botId?: string): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { colors: userBubbleColors } = useUserBubbleAppearance();
  if (message.kind === 'round-end') {
    return <BotGroupDivider testID="botGroup.roundEnd">
      <Text style={styles.dividerText}>{t('groupChat.timeline.roundEnded')}</Text>
      {canContinue ? <MainWindowActionButton density="compact" hitSlop={BOT_GROUP_COMPACT_HIT_SLOP}
        action={{ label: t('groupChat.timeline.continue'), busy: continuing, disabled: !online, onPress: onContinue, testID: 'botGroup.continue' }} /> : null}
    </BotGroupDivider>;
  }
  if (message.kind === 'plan-end') return <BotGroupPlanEndDivider stepCount={plan ? plan.steps.length : null} />;
  if (message.kind === 'notice' || message.authorKind === 'system') {
    const name = message.authorName.trim() || member?.name || '';
    if (isBotGroupRuntimeFailureCode(message.runtimeFailureCode)) {
      return <BotGroupRuntimeFailureNotice key={message.id} code={message.runtimeFailureCode} name={name} />;
    }
    const variant = botGroupNoticeVariant(message.noticeCode, message.planId !== null);
    return <Text style={styles.notice} testID="botGroup.notice">{variant ? t(`groupChat.notice.${variant}`, { name }) : message.content}</Text>;
  }
  // Posting one's own reply retains its author and normal message appearance.
  // Only resolved sources qualify; never render a share's fallback as a message.
  const authoredShare = message.threadShare?.status === 'available' && message.threadShare.sharedByAuthor
    ? message.threadShare : undefined;
  const content = authoredShare?.content ?? message.content;
  const attachments = authoredShare?.attachments ?? message.attachments ?? [];
  const renderAttachments = (align: 'left' | 'right') => {
    if (!attachments.length) return null;
    return <BotGroupMessageAttachments messageId={authoredShare?.messageId ?? message.id} attachments={attachments}
      align={align} onResolveRemoteMedia={resolveMedia} resolveServerMedia={resolveServerMedia} />;
  };
  const shareFooter = authoredShare ? <>
    {authoredShare.edited ? <Text style={styles.threadCaption}>{t('groupChat.thread.edited')}</Text> : null}
  </> : null;
  if ((!message.threadShare || authoredShare) && message.kind === 'message' && message.authorKind === 'user' && message.isSelf !== false) {
    // Older computers send no attachments; a message with only attachments has no bubble.
    const bubble = !!quoteDisplay || content.trim().length > 0 || attachments.length === 0;
    // G3: the 1:1 user bubble, including its compact density for one short line.
    const compact = !quoteDisplay && content.length <= COMPACT_BUBBLE_MAX_CHARS && !content.includes('\n');
    return <View style={styles.userRow} testID="botGroup.message.user">
      <View style={styles.userColumn}>
        <View style={styles.userMessageContent}>
          {renderAttachments('right')}
          {bubble ? <View style={[
            styles.userBubble,
            compact && styles.userBubbleCompact,
            userBubbleColors && { backgroundColor: userBubbleColors.background, borderColor: userBubbleColors.border },
          ]} testID="botGroup.message.userBubble">
            {quoteDisplay ? <View style={styles.userQuote}>
              <BotGroupQuote display={quoteDisplay} onPress={onLocateQuote} />
            </View> : null}
            {content.trim() ? <BotGroupUserText content={content} mentionLabels={mentionLabels} /> : null}
          </View> : null}
        </View>
        {shareFooter}{footer}
      </View>
      {message.maskAttribution ? <GroupMaskAvatar {...message.maskAttribution} deviceId={deviceId} /> : null}
    </View>;
  }
  // Server plans retain the human creator as author, but the card belongs to its organizer.
  const isPlanCard = message.kind === 'plan';
  const organizer = isPlanCard ? members.find(candidate => candidate.botId === plan?.organizerBotId) : undefined;
  const author = isPlanCard
    ? identityFor(plan?.organizerBotId ?? '', organizer?.name || plan?.organizerName || '')
    : identityFor(message.authorBotId ?? '', message.authorName || member?.name || '');
  if (isPlanCard || message.maskAttribution) continued = false;
  return <View style={[styles.botRow, continued && styles.botRowContinued]} testID={isPlanCard ? 'botGroup.message.plan' : 'botGroup.message.bot'}>
    {continued ? <View style={styles.avatarSpacer} /> : <View style={styles.avatarSlot}>
      {message.maskAttribution ? <GroupMaskAvatar {...message.maskAttribution} deviceId={deviceId} /> : <BotGroupAvatar deviceId={deviceId} identity={author} size={BOT_GROUP_MESSAGE_AVATAR_SIZE} online={online} />}
    </View>}
    <View style={styles.botColumn}>
      {continued ? null : <View style={[styles.authorRow, topic && styles.topicAuthorRow]}>
        <Text numberOfLines={1} style={styles.authorName}>{author.name}</Text>
        {topic ? <Text style={styles.threadCaption}>{new Date(message.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</Text> : null}
        {isRoot ? <Text style={styles.threadCaption}>{t('groupChat.thread.root')}</Text> : null}
        {isPlanCard ? <BotGroupOrganizerTag /> : null}
      </View>}
      {message.process && message.process.groupId === groupId ? <BotGroupProcess process={message.process} owned={member?.isOwned === true}
        deviceId={member?.homeDeviceId || deviceId || ''} /> : null}
      {isPlanCard
        ? <BotGroupPlanCard plan={plan} members={members} identityFor={identityFor} deviceId={deviceId} online={online}
          actionable={planActionable} reassignable={planReassignable} pending={planPending}
          onStart={() => onPlanAction('start')} onDismiss={() => onPlanAction('dismiss')} onEditStep={onEditStep} />
        : <>
          {quoteDisplay ? <BotGroupQuote display={quoteDisplay} onPress={onLocateQuote} /> : null}
          {/* A task this teammate started from the group; mine is live, another owner's is a snapshot.
              An author no longer in the group is unknown: its task may run on another computer, so it
              stays a snapshot rather than a lookup on this one (same rule as the desktop timeline).
              The live card reads the owned companion's home computer when it is known (the group may
              be opened through another computer, or straight from the Chat Server with none); else
              the computer the group was opened through. */}
          {message.task ? <BotGroupTaskCard task={message.task} owned={member !== undefined && member.isOwned !== false}
            deviceId={member?.homeDeviceId || deviceId || ''} /> : null}
          <View style={styles.botMessageContent}>
            {renderAttachments('left')}
            {message.threadShare && !authoredShare ? <BotGroupThreadShare onRetry={onRetrySource} share={message.threadShare} resolveMedia={resolveMedia} resolveServerMedia={resolveServerMedia} />
              : content.trim() ? <BotGroupMarkdownText content={content} authorKind={message.authorKind} /> : null}
          </View>
          <BotGroupHandoffFiles files={message.files} />
          {shareFooter}
          {footer}
        </>}
    </View>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  flex: { flex: 1 },
  hiddenComposer: { display: 'none' },
  newMessages: { position: 'absolute', bottom: spacing.md, alignSelf: 'center', maxWidth: '90%' },
  newMessagesButton: { backgroundColor: colors.surfaceElevated },
  locatedMessage: { backgroundColor: colors.surfaceElevated, borderRadius: radius.container },
  replyDraft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container, marginHorizontal: spacing.md, marginBottom: spacing.xs,
    paddingLeft: spacing.md, paddingRight: spacing.xs, paddingVertical: spacing.sm },
  replyDraftClose: { alignItems: 'center', justifyContent: 'center', height: 44, width: 44 },
  replyDraftCloseIcon: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill, height: 26, width: 26 },
  replyDraftBody: { flex: 1, minWidth: 0 },
  userQuote: { alignSelf: 'stretch', marginBottom: spacing.xs },
  pendingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: spacing.sm },
  pendingText: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  floatingHeader: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  unavailableHeader: { paddingHorizontal: spacing.lg, alignItems: 'flex-start' },
  emptyActions: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm, marginTop: spacing.lg },
  threadTimeline: { justifyContent: 'flex-start' },
  threadBoundary: { paddingTop: spacing.md, gap: spacing.sm },
  shareHeader: { minHeight: 44, paddingLeft: spacing.sm },
  shareDeliveries: { maxHeight: 160, flexGrow: 0 },
  sharePending: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  threadLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  newReplyBoundary: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  newReplyLine: { flex: 1, height: 0.5, backgroundColor: colors.threadUnreadDivider },
  newReplyDivider: { color: colors.threadUnreadDivider, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
  threadMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.sm },
  threadCaption: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
  threadEmpty: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, paddingVertical: spacing.sm },
  messageFooter: { width: '100%', alignItems: 'flex-start' },
  ownMessageFooter: { alignItems: 'flex-end' },
  timeline: { flexGrow: 1, justifyContent: 'flex-end', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  item: { gap: spacing.lg },
  // Aligns the follow-up card with message text, past the 28pt avatar and its gap (1:1 reply geometry).
  indented: { paddingLeft: BOT_GROUP_MESSAGE_AVATAR_SIZE + REPLY_AVATAR_GAP },
  offline: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, textAlign: 'center',
    paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  olderNote: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, textAlign: 'center' },
  time: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, textAlign: 'center' },
  notice: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, textAlign: 'center' },
  dividerText: { flexShrink: 1, color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, textAlign: 'center' },
  userRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  // Full width so the bubble keeps its 86% cap and attachments their own size limits.
  userColumn: { flex: 1, minWidth: 0, alignItems: 'flex-end', gap: spacing.xs },
  userMessageContent: { width: '100%', alignItems: 'flex-end', gap: spacing.xs },
  botMessageContent: { gap: spacing.xs },
  userBubble: { ...messageBubbleBase, ...userMessageBubble(colors) },
  userBubbleCompact: compactMessageBubble,
  // The 1:1 reply geometry: avatar 28, 2pt down, 10 to the text.
  botRow: { flexDirection: 'row', alignItems: 'flex-start', gap: REPLY_AVATAR_GAP },
  botRowContinued: { marginTop: -spacing.sm },
  avatarSlot: { marginTop: 2 },
  avatarSpacer: { width: BOT_GROUP_MESSAGE_AVATAR_SIZE },
  botColumn: { flex: 1, minWidth: 0, gap: spacing.xs },
  topicAuthorRow: { alignItems: 'baseline' },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: BOT_GROUP_MESSAGE_AVATAR_SIZE },
  authorName: { flexShrink: 1, color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium },
});
