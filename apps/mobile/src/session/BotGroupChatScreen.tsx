import { useGroupPersonalMask } from './useGroupPersonalMask';
import { GroupMaskAvatar, GroupMaskStatus, GroupMaskSettingsSheet, GroupMaskCatchupSheet } from './GroupMaskControls';
import type { ChatMaskMention } from '@cindy/maker-shared/botGroupChat';
import { deviceDisplayName } from '@/device-link/deviceName';
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { showConfirm } from '@/platform/chrome';
import { Stack, useRouter } from 'expo-router';
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
import { ChatReplyIcon } from '@/components/ChatReplyIcon';
import { MainWindowActionButton, MainWindowEmptyState } from '@/components/MobilePrimitives';
import { readRemoteCollectionCache } from '@/device-link/remoteResourceAvailability';
import type { RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
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
import { companionMessageBubble } from './companionMessageAppearance';
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

export function BotGroupChatScreen({ deviceId, deviceName, groupId, messageId, notificationResponse, threadRootId }: {
  deviceId: string; deviceName: string; groupId: string; messageId?: string; notificationResponse?: string; threadRootId?: string;
}) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
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
  const stickToBottom = useRef(!messageId);
  const [jumpTarget, setJumpTarget] = useState(messageId ?? '');
  const [highlightId, setHighlightId] = useState('');
  const jumpAttempts = useRef(0);
  const messagePositions = useRef(new Map<string, number>());
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
    stickToBottom.current = !messageId;
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
    if (!focused || AppState.currentState !== 'active' || !stickToBottom.current || !group) return;
    const measured = viewport.current;
    // An intended scrollToEnd has not necessarily reached its destination yet.
    if (measured.owner !== viewportOwner || measured.measuredGroup !== group
      || measured.viewportHeight <= 0 || measured.contentHeight <= 0
      || measured.contentHeight - measured.offsetY - measured.viewportHeight >= STICK_TO_BOTTOM_PX) return;
    setSeen(previous => previous?.owner === viewportOwner && previous.sequence === latestSequence
      ? previous : { owner: viewportOwner, sequence: latestSequence });
    const incoming = group.messages.filter(message => message.kind === 'message' && message.isSelf !== true
      && (message.authorKind === 'bot' || (message.authorKind === 'user' && message.isSelf === false))
    );
    if (chat.server && chat.markRead) { void chat.markRead(incoming.map(message => message.id)); return; }
    const at = incoming.reduce((latest, message) => Math.max(latest, message.createdAt), 0);
    if (at > 0) void markRemoteResourceRead(user?.id ?? '', deviceId, groupId, at);
    if (chat.markRead) void chat.markRead(incoming.map(message => message.id));
  }, [focused, group, user?.id, deviceId, groupId, viewportOwner, latestSequence, chat.server, chat.markRead]);
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

  const leave = useCallback(() => goBackGuarded(router, '/devices'), [router]);

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
    jumpAttempts.current = 0;
    setJumpTarget(id);
    setReadTarget(id);
  }, []);
  useEffect(() => { if (messageId) locateMessage(messageId); }, [messageId, notificationResponse, locateMessage]);
  const positionAtMessage = useCallback((id: string, y: number) => {
    stickToBottom.current = false;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - (floatingHeader ? headerHeight : 0) - spacing.md), animated: false });
    setHighlightId(id);
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
    stickToBottom.current = true;
    const quote = replyTo;
    try {
      await chat.act('send', {
        text: input.text,
        mentions: input.mentions,
        clientId: input.clientId,
        ...(quote ? { quote: { messageId: quote.messageId } } : {}),
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

  const header = <ChatIdentityHeader testIDPrefix="botGroup" settingsTestID="botGroup.settingsButton" nativeHeader={nativeHeader}
    mark={peer ? <BotGroupAvatar deviceId={deviceId} identity={identityFor(peer.botId, peer.name)} size={CHAT_HEADER_MARK_SIZE} online={chat.online} /> : <BotGroupDuoAvatar deviceId={deviceId} members={headerMembers} online={chat.online} variant="header"
      working={group?.round.status === 'running'} />}
    title={title}
    subtitle={threadRootId ? t('message.renderer.reply') : memberLine}
    identityLabel={[title, memberLine, memberNames].filter(Boolean).join(', ')}
    identityHint={t('groupChat.settings.open')}
    controlsReady={!!group}
    onBack={threadRootId ? () => router.replace(`/companions/groups/${groupId}?messageId=${threadRootId}` as never) : leave}
    onOpenSettings={direct ? undefined : () => setSettings(true)}
    settingsLabel={t('groupChat.settings.open')} />;

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
        title={t(failed ? 'groupChat.loadFailedTitle' : 'groupChat.unavailableTitle')}
        copy={t(errorCopyKey)}>
        <View style={styles.emptyActions}>
          <MainWindowActionButton action={{ label: t('shared.back'), onPress: leave, testID: 'botGroup.leave' }} />
          {!failed ? <MainWindowActionButton action={{ label: t('groupChat.lifecycle.hide'), onPress: () => void removeFromList(), testID: 'botGroup.hide' }} /> : null}
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
      {group.dissolvedAt ? <Text style={styles.offline}>{t('groupChat.lifecycle.dissolved')}</Text> : null}
      <View style={styles.flex}>
      <MessageListVisibilityContext.Provider value={previewVisibility}>
      <ScrollView ref={scrollRef} style={styles.flex} contentContainerStyle={[styles.timeline, floatingHeader && { paddingTop: headerHeight + spacing.md }]}
        scrollIndicatorInsets={floatingHeader ? { top: headerHeight } : undefined} keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        maintainVisibleContentPosition={chat.server ? { minIndexForVisible: group.hasMoreBefore ? 1 : 0 } : undefined}
        onScroll={onScroll} scrollEventThrottle={64}
        onLayout={event => { viewport.current.viewportHeight = event.nativeEvent.layout.height; previewVisibility.setHeight(event.nativeEvent.layout.height); acknowledge(); }}
        onContentSizeChange={(_width, height) => {
          viewport.current.contentHeight = height;
          viewport.current.measuredGroup = group;
          if (stickToBottom.current) scrollRef.current?.scrollToEnd({ animated: false });
          acknowledge();
        }}
        testID="botGroup.timeline">
        <BotGroupTimeline group={group} deviceId={deviceId} online={chat.online} identityFor={identityFor}
          highlightId={highlightId} onLocateMessage={locateMessage}
          pending={chat.pending} onPendingAction={(id, action) => { void chat.pendingAction?.(id, action).catch(error => report(error, 'groupChat.composer.sendFailed')); }}
          onReply={(chat.server || group.serverBacked) && !group.archived && !group.dissolvedAt ? message => { setReplyTo(botGroupQuoteFromMessage(message)); setReplyFocusRequest(request => request + 1); } : undefined}
          onMessageLayout={(id, y, height) => {
            previewVisibility.setLayout(id, { y, height });
            messagePositions.current.set(id, y);
            if (jumpTarget === id) positionAtMessage(id, y);
          }}
          resolveMedia={resolveMedia} resolveServerMedia={chat.media}
          loadOlder={chat.loadOlder ? () => { stickToBottom.current = false; void chat.loadOlder!().catch(error => report(error, 'groupChat.loadFailedTitle')); } : undefined}
          loadingOlder={chat.loadingOlder} continuing={continuing} planPending={planPending}
          onContinue={() => void continueRound()}
          onPlanAction={(action, planId) => void runPlanAction(action, planId)}
          onEditStep={(planId, step, action, botId) => void editPlanStep(planId, step, action, botId)}
          onInteractionError={(message) => { if (message) Alert.alert(message); }} />
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
            onPress: () => { stickToBottom.current = true; scrollRef.current?.scrollToEnd({ animated: false }); },
          }} />
        </CompanionFadeIn> : null}
      </View> : null}
      </View>
      {replyTo ? <View style={styles.replyDraft}>
        <View style={styles.flex}><BotGroupQuote display={resolveBotGroupQuote(replyTo, group.messages)} onPress={() => locateMessage(replyTo.messageId)} /></View>
        <MainWindowActionButton density="compact" action={{ label: t('message.quote.remove'), onPress: () => setReplyTo(null), testID: 'botGroup.cancelReply' }} />
      </View> : null}
      <BotGroupWorkArea group={group} deviceId={deviceId} online={chat.online} identityFor={identityFor}
        onError={message => { if (message) Alert.alert(message); }} />
      <BotGroupComposer onParticipate={mask.participate} maskIndicator={mask.state?.settings.companionId ? <GroupMaskStatus mask={mask} deviceId={deviceId} onPress={() => setMaskSettings(true)} /> : undefined} members={group.members} identityFor={identityFor} deviceId={deviceId} online={(chat.online || !!chat.canQueue) && !group.archived && !group.dissolvedAt}
        quoteMessageId={replyTo?.messageId} focusRequest={replyFocusRequest}
        running={group.round.status === 'running'} planState={botGroupComposerPlanState(openBotGroupPlan(group), group.replyMode)}
        divisionSupported={!chat.server && (!group.singleSpeaker || group.supportsDivision === true)} attachmentsSupported={group.supportsAttachments === true} uploadAttachment={chat.uploadAttachment} onSend={send} onStop={stop} />
    </KeyboardAvoidingView>;
  }

  return <SafeAreaView style={styles.screen} edges={floatingHeader ? ['left', 'right', 'bottom'] : ['top', 'left', 'right', 'bottom']} testID="botGroup.screen">
    {nativeHeader ? null : <Stack.Screen options={{ headerShown: false }} />}
    {floatingHeader ? <>
      <View style={[styles.flex, group ? null : { paddingTop: headerHeight }]}>{body}</View>
      <SessionHeaderNativeBlur height={Math.max(headerHeight, nativeHeader ? nativeHeaderHeight : insets.top + navigationChrome.target)} fadeInside={CHAT_HEADER_BLUR_FADE_INSIDE} />
      <View style={[styles.floatingHeader, { paddingTop: nativeHeader ? nativeHeaderHeight : insets.top }]} onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}>
        {header}
        {offlineNote}
      </View>
    </> : <>
      {header}
      {body}
    </>}
    {group && !direct ? <BotGroupSettingsSheet readOnly={chat.server} visible={settings} group={group} host={host} identityFor={identityFor} online={chat.online}
      onMask={mask.state ? () => { openMaskAfterSettings.current = true; setSettings(false); } : undefined}
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
  group, deviceId, online, identityFor, resolveMedia, resolveServerMedia, loadOlder, loadingOlder, continuing, planPending, onContinue, onPlanAction, onEditStep, onInteractionError,
  onMessageLayout, onLocateMessage, highlightId, onReply, pending = [], onPendingAction,
}: {
  group: BotGroupRemoteChatData;
  pending?: readonly DurableOutboxRecord[];
  onPendingAction?: (id: string, action: 'retry' | 'cancel') => void;
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
  onInteractionError(message: string | null): void;
  onMessageLayout?: (id: string, y: number, height: number) => void;
  onLocateMessage?: (id: string) => void;
  highlightId?: string;
  onReply?: (message: BotGroupMessageView) => void;
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
  const messages = [...group.messages, ...local.map(pendingChatMessage)];
  const planById = new Map(group.plans.map((plan) => [plan.id, plan]));
  const openPlan = openBotGroupPlan(group);
  const followUp = botGroupPlanFollowUp(openPlan);
  const continueId = continuableRoundEndId(messages, group.round);
  const timeGroups = collectBotMessageTimeGroups(messages.map((message) => ({ clientId: message.id, createdAt: message.createdAt })));
  const allLabel = t('groupChat.mention.all');
  const mentionLabels = useMemo(() => [allLabel, ...group.members.map((member) => member.name)], [allLabel, group.members]);
  const running = group.round.status === 'running';
  const memberById = new Map(group.members.map((member) => [member.botId, member]));
  const pendingFor = (planId: string | null) => planId && planPending?.planId === planId ? planPending.action : null;
  return <>
    {group.hasMoreBefore && loadOlder ? <MainWindowActionButton action={{ label: t('groupChat.server.loadOlder'), busy: loadingOlder, onPress: loadOlder, testID: 'botGroup.loadOlder' }} /> : group.hasMoreBefore ? <Text style={styles.olderNote} testID="botGroup.olderOnComputer">{t('groupChat.timeline.olderOnComputer')}</Text> : null}
    {messages.length === 0 && !running ? <MainWindowEmptyState centered testID="botGroup.empty"
      title={t('groupChat.timeline.emptyTitle')} copy={t('groupChat.timeline.emptyDescription')} /> : null}
    {messages.map((message, index) => {
      const queued = pendingById.get(message.id);
      const groupTime = timeGroups.get(message.id);
      const previous = index > 0 ? messages[index - 1] : undefined;
      // G2: the same teammate speaking again inside one time group keeps its avatar and name once.
      const continued = groupTime === undefined && message.kind === 'message' && message.authorKind === 'bot'
        && previous?.kind === 'message' && previous.authorKind === 'bot' && previous.authorBotId === message.authorBotId;
      const key = rowKey(message.id);
      return <View key={key} style={[styles.item, highlightId === message.id && styles.locatedMessage]}
        onLayout={event => onMessageLayout?.(message.id, event.nativeEvent.layout.y, event.nativeEvent.layout.height)}>
        {groupTime !== undefined ? <Text style={styles.time}>{formatBotMessageGroupTime(groupTime, i18n.language)}</Text> : null}
        <CompanionEntering id={key} createdAt={message.createdAt} kind={message.authorKind === 'user' ? 'send' : 'reply'}>
        <BotGroupTimelineItem message={message} continued={continued} member={message.authorBotId ? memberById.get(message.authorBotId) : undefined}
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
        {queued ? <View style={styles.pendingRow} testID={`botGroup.pending.${queued.item.clientId}`}>
          <Text style={styles.pendingText}>{t(queued.state === 'failed' ? 'message.queue.notSent' : !online ? 'message.queue.waitingForNetwork' : 'message.queue.queued')}</Text>
          {queued.state === 'failed' && !queued.suspended ? <MainWindowActionButton density="compact" action={{ label: t('message.queue.retry'), onPress: () => onPendingAction?.(queued.item.clientId, 'retry') }} /> : null}
          {!queued.enqueueStarted && queued.state !== 'sending' ? <MainWindowActionButton density="compact" action={{ label: t('message.queue.cancelSend'), onPress: () => onPendingAction?.(queued.item.clientId, 'cancel') }} /> : null}
        </View> : null}
        {!queued && onReply && isBotGroupMessageQuotable(message) ? <Pressable
          accessibilityRole="button" accessibilityLabel={t('message.renderer.reply')}
          testID={`botGroup.reply.${message.id}`} onPress={() => onReply(message)}
          style={[styles.replyAction, message.isSelf === true && styles.ownReplyAction]}>
          <ChatReplyIcon size={iconSize.md} color={styles.replyIcon.color} />
        </Pressable> : null}
      </View>;
    })}
    {openPlan && followUp ? <View style={styles.indented}>
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
  message, continued = false, quoteDisplay, onLocateQuote, member, members, deviceId, online, identityFor, mentionLabels, resolveMedia, resolveServerMedia, canContinue, continuing, onContinue,
  plan, planActionable, planReassignable, planPending, onPlanAction, onEditStep,
}: {
  message: BotGroupMessageView;
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
  if (message.kind === 'message' && message.authorKind === 'user' && message.isSelf !== false) {
    // Older computers send no attachments; a message with only attachments has no bubble.
    const attachments = message.attachments ?? [];
    const bubble = message.content.trim().length > 0 || attachments.length === 0;
    // G3: the 1:1 user bubble, including its compact density for one short line.
    const compact = message.content.length <= COMPACT_BUBBLE_MAX_CHARS && !message.content.includes('\n');
    return <View style={styles.userRow} testID="botGroup.message.user">
      <View style={styles.userColumn}>
        {quoteDisplay ? <BotGroupQuote display={quoteDisplay} align="right" onPress={onLocateQuote} /> : null}
        {attachments.length > 0
          ? <BotGroupMessageAttachments messageId={message.id} attachments={attachments} align="right" onResolveRemoteMedia={resolveMedia} resolveServerMedia={resolveServerMedia} />
          : null}
        {bubble ? <View style={[
          styles.userBubble,
          compact && styles.userBubbleCompact,
          userBubbleColors && { backgroundColor: userBubbleColors.background, borderColor: userBubbleColors.border },
        ]} testID="botGroup.message.userBubble">
          <BotGroupUserText content={message.content} mentionLabels={mentionLabels} />
        </View> : null}
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
      {continued ? null : <View style={styles.authorRow}>
        <Text numberOfLines={1} style={styles.authorName}>{author.name}</Text>
        {isPlanCard ? <BotGroupOrganizerTag /> : null}
      </View>}
      {isPlanCard
        ? <BotGroupPlanCard plan={plan} members={members} identityFor={identityFor} deviceId={deviceId} online={online}
          actionable={planActionable} reassignable={planReassignable} pending={planPending}
          onStart={() => onPlanAction('start')} onDismiss={() => onPlanAction('dismiss')} onEditStep={onEditStep} />
        : <View style={styles.botBubble} testID="botGroup.message.botBubble">
          {quoteDisplay ? <BotGroupQuote display={quoteDisplay} onPress={onLocateQuote} /> : null}
          {/* A task this teammate started from the group; mine is live, another owner's is a snapshot.
              An author no longer in the group is unknown: its task may run on another computer, so it
              stays a snapshot rather than a lookup on this one (same rule as the desktop timeline).
              The live card reads the owned companion's home computer when it is known (the group may
              be opened through another computer, or straight from the Chat Server with none); else
              the computer the group was opened through. */}
          {message.task ? <BotGroupTaskCard task={message.task} owned={member !== undefined && member.isOwned !== false}
            deviceId={member?.homeDeviceId || deviceId || ''} /> : null}
          {message.attachments?.length ? <BotGroupMessageAttachments messageId={message.id} attachments={message.attachments} align="left" onResolveRemoteMedia={resolveMedia} resolveServerMedia={resolveServerMedia} /> : null}
          {message.content.trim() ? <BotGroupMarkdownText content={message.content} authorKind={message.authorKind} /> : null}
          <BotGroupHandoffFiles files={message.files} />
        </View>}
    </View>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  flex: { flex: 1 },
  newMessages: { position: 'absolute', bottom: spacing.md, alignSelf: 'center', maxWidth: '90%' },
  newMessagesButton: { backgroundColor: colors.surfaceElevated },
  locatedMessage: { backgroundColor: colors.surfaceElevated, borderRadius: radius.container },
  replyDraft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  replyAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: BOT_GROUP_MESSAGE_AVATAR_SIZE + REPLY_AVATAR_GAP },
  pendingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: spacing.sm },
  pendingText: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  ownReplyAction: { alignSelf: 'flex-end', marginLeft: 0 },
  replyIcon: { color: colors.textSecondary },
  floatingHeader: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyActions: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm, marginTop: spacing.lg },
  timeline: { flexGrow: 1, justifyContent: 'flex-end', gap: spacing.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
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
  // The 1:1 user bubble (MessageRenderer userBubble): 86% wide, padding 12, compact 8/12.
  userBubble: { maxWidth: '86%', backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: 0,
    borderRadius: radius.container, padding: spacing.md },
  userBubbleCompact: { paddingVertical: spacing.sm },
  // The 1:1 reply geometry: avatar 28, 2pt down, 10 to the text.
  botRow: { flexDirection: 'row', alignItems: 'flex-start', gap: REPLY_AVATAR_GAP },
  botRowContinued: { marginTop: -spacing.sm },
  avatarSlot: { marginTop: 2 },
  avatarSpacer: { width: BOT_GROUP_MESSAGE_AVATAR_SIZE },
  botColumn: { flex: 1, minWidth: 0, gap: spacing.xs },
  botBubble: companionMessageBubble(colors),
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: BOT_GROUP_MESSAGE_AVATAR_SIZE },
  authorName: { flexShrink: 1, color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium },
});
