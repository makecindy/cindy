/**
 * 手机上的群聊页（docs/product-rules/bot-group-chat.md §8，对照桌面 BotGroupChatView.tsx）：
 * 顶栏（叠放头像、群名、成员名单、群设置）+ 多作者时间线 + 输入框。用户消息的附件见
 * BotGroupMessageAttachments（图片从电脑取缩略图，文件只显示名字）。
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
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';
import {
  BOT_GROUP_REMOTE_COLLECTION_ID,
  type BotGroupAttachment,
  type BotGroupMemberView,
  type BotGroupMessageView,
  type BotGroupPlanAction,
  type BotGroupPlanStepView,
  type BotGroupPlanView,
  type BotGroupRemoteChatData,
} from '@cindy/maker-shared/botGroupChat';
import {
  botGroupComposerPlanState,
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
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';
import {
  BOT_GROUP_MESSAGE_AVATAR_SIZE,
  BotGroupAvatar,
  BotGroupDuoAvatar,
  useBotGroupIdentities,
} from './BotGroupAvatars';
import { ChatIdentityHeader } from './ChatIdentityHeader';
import { CompanionEntering } from './CompanionEntering';
import { BotGroupComposer, type BotGroupSendInput } from './BotGroupComposer';
import { BotGroupMessageAttachments } from './BotGroupMessageAttachments';
import { BotGroupMarkdownText, BotGroupUserText } from './BotGroupMessageText';
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
import { BotGroupSpeakerRow } from './BotGroupSpeakerRow';
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

export function BotGroupChatScreen({ deviceId, deviceName, groupId }: { deviceId: string; deviceName: string; groupId: string }) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user, accountGeneration } = useAuth();
  const host = useMemo<RemoteResourceHostTarget>(() => ({ deviceId, deviceName: deviceName || deviceId }), [deviceId, deviceName]);
  const chat = useBotGroupChat(host, groupId);
  const identity = useBotGroupIdentities(deviceId);
  const resolveMedia = useBotGroupRemoteMedia(deviceId);
  const [settings, setSettings] = useState(false);
  const leaveAfterSettings = useRef(false);
  const [continuing, setContinuing] = useState(false);
  const [planPending, setPlanPending] = useState<PlanPending | null>(null);
  const planPendingRef = useRef(false);
  const scrollRef = useRef<ScrollView>(null);
  const stickToBottom = useRef(true);
  const group = chat.state.kind === 'ready' ? chat.state.group : null;
  const focused = useIsFocused();
  const viewportOwner = `${user?.id ?? ''}:${accountGeneration}:${deviceId}:${groupId}`;
  const viewport = useRef({ owner: viewportOwner, group, measuredGroup: null as typeof group,
    contentHeight: 0, viewportHeight: 0, offsetY: 0 });
  if (viewport.current.owner !== viewportOwner) {
    viewport.current = { owner: viewportOwner, group, measuredGroup: null, contentHeight: 0, viewportHeight: 0, offsetY: 0 };
    stickToBottom.current = true;
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
    const incoming = group.messages.filter(message => message.kind === 'message' && message.isSelf !== true
      && (message.authorKind === 'bot' || (message.authorKind === 'user' && message.isSelf === false))
    );
    if (chat.server && chat.markRead) { void chat.markRead(incoming.map(message => message.id)); return; }
    const at = incoming.reduce((latest, message) => Math.max(latest, message.createdAt), 0);
    if (at > 0) void markRemoteResourceRead(user?.id ?? '', deviceId, groupId, at);
  }, [focused, group, user?.id, deviceId, groupId, viewportOwner, chat.server, chat.markRead]);
  useEffect(() => {
    const frame = requestAnimationFrame(acknowledge);
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') acknowledge(); });
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
    try {
      await chat.act('send', {
        text: input.text,
        mentions: input.mentions,
        clientId: input.clientId,
        ...(input.division ? { division: true } : {}),
        // Only a computer that declared `supportsAttachments` is offered any (see the composer).
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
      });
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
    Object.assign(viewport.current, { measuredGroup: group, contentHeight: contentSize.height,
      offsetY: contentOffset.y, viewportHeight: layoutMeasurement.height });
    stickToBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < STICK_TO_BOTTOM_PX;
    acknowledge();
  };

  const title = group?.name ?? (cachedRow ? resolveRemoteText(cachedRow.item.display.title, i18n.language) : '');
  const memberLine = group
    ? botGroupMemberNames(group.members, t('groupChat.memberSeparator'))
    : cachedRow?.item.display.subtitle ? resolveRemoteText(cachedRow.item.display.subtitle, i18n.language) : '';
  const headerMembers = group ? group.members.map((member) => identityFor(member.botId, member.name)) : [];

  const header = <ChatIdentityHeader testIDPrefix="botGroup" settingsTestID="botGroup.settingsButton"
    mark={<BotGroupDuoAvatar deviceId={deviceId} members={headerMembers} online={chat.online} variant="header"
      working={group?.round.status === 'running'} />}
    title={title}
    subtitle={memberLine}
    identityLabel={[title, memberLine].filter(Boolean).join(', ')}
    identityHint={t('groupChat.settings.open')}
    controlsReady={!!group}
    onBack={leave}
    onOpenSettings={() => setSettings(true)}
    settingsLabel={t('groupChat.settings.open')} />;

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
      {!chat.online ? <Text accessibilityRole="alert" style={styles.offline} testID="botGroup.offlineNote">{t(offlineKey)}</Text> : null}
      <ScrollView ref={scrollRef} style={styles.flex} contentContainerStyle={styles.timeline} keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        maintainVisibleContentPosition={chat.server ? { minIndexForVisible: group.hasMoreBefore ? 1 : 0 } : undefined}
        onScroll={onScroll} scrollEventThrottle={64}
        onLayout={event => { viewport.current.viewportHeight = event.nativeEvent.layout.height; acknowledge(); }}
        onContentSizeChange={(_width, height) => {
          viewport.current.contentHeight = height;
          viewport.current.measuredGroup = group;
          if (stickToBottom.current) scrollRef.current?.scrollToEnd({ animated: false });
          acknowledge();
        }}
        testID="botGroup.timeline">
        <BotGroupTimeline group={group} deviceId={deviceId} online={chat.online} identityFor={identityFor}
          resolveMedia={resolveMedia} resolveServerMedia={chat.media}
          loadOlder={chat.loadOlder ? () => { stickToBottom.current = false; void chat.loadOlder!().catch(error => report(error, 'groupChat.loadFailedTitle')); } : undefined}
          loadingOlder={chat.loadingOlder} continuing={continuing} planPending={planPending}
          onContinue={() => void continueRound()}
          onPlanAction={(action, planId) => void runPlanAction(action, planId)}
          onEditStep={(planId, step, action, botId) => void editPlanStep(planId, step, action, botId)}
          onInteractionError={(message) => { if (message) Alert.alert(message); }} />
      </ScrollView>
      <BotGroupComposer members={group.members} identityFor={identityFor} deviceId={deviceId} online={chat.online && !group.archived}
        running={group.round.status === 'running'} planState={botGroupComposerPlanState(openBotGroupPlan(group))}
        divisionSupported={!chat.server} attachmentsSupported={group.supportsAttachments === true} onSend={send} onStop={stop} />
    </KeyboardAvoidingView>;
  }

  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']} testID="botGroup.screen">
    <Stack.Screen options={{ headerShown: false }} />
    {header}
    {body}
    {group ? <BotGroupSettingsSheet readOnly={chat.server} visible={settings} group={group} host={host} identityFor={identityFor} online={chat.online}
      act={chat.act} onClose={() => setSettings(false)}
      onClosed={() => { if (leaveAfterSettings.current) { leaveAfterSettings.current = false; leave(); } }}
      onDeleted={onGroupDeleted} /> : null}
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
}: {
  group: BotGroupRemoteChatData;
  deviceId: string;
  online: boolean;
  identityFor: BotGroupIdentityLookup;
  /** Reads a picture attached to a message from the computer. */
  resolveMedia: ResolveRemoteMediaFn;
  resolveServerMedia?: (id: string) => Promise<BotGroupAttachment>;
  loadOlder?: () => void;
  loadingOlder?: boolean;
  continuing: boolean;
  planPending: PlanPending | null;
  onContinue(): void;
  onPlanAction(action: BotGroupPlanAction, planId: string): void;
  onEditStep(planId: string, step: BotGroupPlanStepView, action: 'reassign' | 'remove', botId?: string): void;
  onInteractionError(message: string | null): void;
}) {
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const messages = group.messages;
  const planById = new Map(group.plans.map((plan) => [plan.id, plan]));
  const openPlan = openBotGroupPlan(group);
  const followUp = botGroupPlanFollowUp(openPlan);
  const continueId = continuableRoundEndId(messages, group.round);
  const timeGroups = collectBotMessageTimeGroups(messages.map((message) => ({ clientId: message.id, createdAt: message.createdAt })));
  const allLabel = t('groupChat.mention.all');
  const mentionLabels = useMemo(() => [allLabel, ...group.members.map((member) => member.name)], [allLabel, group.members]);
  const running = group.round.status === 'running';
  const memberById = new Map(group.members.map((member) => [member.botId, member]));
  const speakers = running
    ? group.round.speakers.filter((speaker) => memberById.has(speaker.botId))
    : [];
  const pendingFor = (planId: string | null) => planId && planPending?.planId === planId ? planPending.action : null;
  return <>
    {group.hasMoreBefore && loadOlder ? <MainWindowActionButton action={{ label: t('groupChat.server.loadOlder'), busy: loadingOlder, onPress: loadOlder, testID: 'botGroup.loadOlder' }} /> : group.hasMoreBefore ? <Text style={styles.olderNote} testID="botGroup.olderOnComputer">{t('groupChat.timeline.olderOnComputer')}</Text> : null}
    {messages.length === 0 && !running ? <MainWindowEmptyState centered testID="botGroup.empty"
      title={t('groupChat.timeline.emptyTitle')} copy={t('groupChat.timeline.emptyDescription')} /> : null}
    {messages.map((message, index) => {
      const groupTime = timeGroups.get(message.id);
      const previous = index > 0 ? messages[index - 1] : undefined;
      // G2: the same teammate speaking again inside one time group keeps its avatar and name once.
      const continued = groupTime === undefined && message.kind === 'message' && message.authorKind === 'bot'
        && previous?.kind === 'message' && previous.authorKind === 'bot' && previous.authorBotId === message.authorBotId;
      return <View key={message.id} style={styles.item}>
        {groupTime !== undefined ? <Text style={styles.time}>{formatBotMessageGroupTime(groupTime, i18n.language)}</Text> : null}
        <CompanionEntering id={message.id} createdAt={message.createdAt} kind={message.authorKind === 'user' ? 'send' : 'reply'}>
        <BotGroupTimelineItem message={message} continued={continued} member={message.authorBotId ? memberById.get(message.authorBotId) : undefined}
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
    {speakers.map((speaker) => {
      const member = memberById.get(speaker.botId)!;
      return <BotGroupSpeakerRow key={`${speaker.botId}:${speaker.activity}`} deviceId={deviceId} online={online}
        identity={identityFor(member.botId, member.name)} sessionId={speaker.sessionId} activity={speaker.activity}
        onError={onInteractionError} />;
    })}
  </>;
}

function BotGroupTimelineItem({
  message, continued = false, member, members, deviceId, online, identityFor, mentionLabels, resolveMedia, resolveServerMedia, canContinue, continuing, onContinue,
  plan, planActionable, planReassignable, planPending, onPlanAction, onEditStep,
}: {
  message: BotGroupMessageView;
  /** Same teammate as the message just above: no second avatar or name. */
  continued?: boolean;
  member: BotGroupMemberView | undefined;
  members: readonly BotGroupMemberView[];
  deviceId: string;
  online: boolean;
  identityFor: BotGroupIdentityLookup;
  mentionLabels: readonly string[];
  resolveMedia: ResolveRemoteMediaFn;
  resolveServerMedia?: (id: string) => Promise<BotGroupAttachment>;
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
    const variant = botGroupNoticeVariant(message.noticeCode, message.planId !== null);
    return <Text style={styles.notice} testID="botGroup.notice">{variant ? t(`groupChat.notice.${variant}`, { name }) : message.content}</Text>;
  }
  if (message.authorKind === 'user' && message.isSelf !== false) {
    // Older computers send no attachments; a message with only attachments has no bubble.
    const attachments = message.attachments ?? [];
    const bubble = message.content.trim().length > 0 || attachments.length === 0;
    // G3: the 1:1 user bubble, including its compact density for one short line.
    const compact = message.content.length <= COMPACT_BUBBLE_MAX_CHARS && !message.content.includes('\n');
    return <View style={styles.userRow} testID="botGroup.message.user">
      <View style={styles.userColumn}>
        {attachments.length > 0
          ? <BotGroupMessageAttachments messageId={message.id} attachments={attachments} align="right" onResolveRemoteMedia={resolveMedia} resolveServerMedia={resolveServerMedia} />
          : null}
        {bubble ? <View style={[styles.userBubble, compact && styles.userBubbleCompact]} testID="botGroup.message.userBubble">
          <BotGroupUserText content={message.content} mentionLabels={mentionLabels} />
        </View> : null}
      </View>
    </View>;
  }
  // Name snapshot from when it was said; the avatar follows the live profile.
  const author = identityFor(message.authorBotId ?? '', message.authorName || member?.name || '');
  const isPlanCard = message.kind === 'plan';
  return <View style={[styles.botRow, continued && styles.botRowContinued]} testID={isPlanCard ? 'botGroup.message.plan' : 'botGroup.message.bot'}>
    {continued ? <View style={styles.avatarSpacer} /> : <View style={styles.avatarSlot}>
      <BotGroupAvatar deviceId={deviceId} identity={author} size={BOT_GROUP_MESSAGE_AVATAR_SIZE} online={online} />
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
        : <>
          {message.attachments?.length ? <BotGroupMessageAttachments messageId={message.id} attachments={message.attachments} align="left" onResolveRemoteMedia={resolveMedia} resolveServerMedia={resolveServerMedia} /> : null}
          {message.content.trim() ? <BotGroupMarkdownText content={message.content} /> : null}
          <BotGroupHandoffFiles files={message.files} />
        </>}
    </View>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  flex: { flex: 1 },
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
  // The 1:1 user bubble (MessageRenderer userBubble + companion border): 86% wide, padding 12, compact 8/12.
  userBubble: { maxWidth: '86%', backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container, padding: spacing.md },
  userBubbleCompact: { paddingVertical: spacing.sm },
  // The 1:1 reply geometry: avatar 28, 2pt down, 10 to the text.
  botRow: { flexDirection: 'row', alignItems: 'flex-start', gap: REPLY_AVATAR_GAP },
  botRowContinued: { marginTop: -spacing.sm },
  avatarSlot: { marginTop: 2 },
  avatarSpacer: { width: BOT_GROUP_MESSAGE_AVATAR_SIZE },
  botColumn: { flex: 1, minWidth: 0, gap: spacing.xs },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: BOT_GROUP_MESSAGE_AVATAR_SIZE },
  authorName: { flexShrink: 1, color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium },
});
