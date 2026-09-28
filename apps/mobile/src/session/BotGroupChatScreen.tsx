/**
 * 手机上的群聊页（docs/product-rules/bot-group-chat.md §8，对照桌面 BotGroupChatView.tsx）：
 * 顶栏（叠放头像、群名、成员名单、群设置）+ 多作者时间线 + 输入框。
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
import { Stack, useRouter } from 'expo-router';
import { ChevronLeft, Settings2 } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';
import {
  BOT_GROUP_REMOTE_COLLECTION_ID,
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
import { useAuth } from '@/auth/AuthContext';
import { Text } from '@/components/AppText';
import { MainWindowActionButton, MainWindowEmptyState } from '@/components/MobilePrimitives';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { readRemoteCollectionCache } from '@/device-link/remoteResourceAvailability';
import type { RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';
import {
  BOT_GROUP_MESSAGE_AVATAR_SIZE,
  BotGroupAvatar,
  BotGroupAvatarStack,
  useBotGroupIdentities,
} from './BotGroupAvatars';
import { BotGroupComposer, type BotGroupSendInput } from './BotGroupComposer';
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
import { HomeHeaderGlassButton } from './HomeHeaderGlassButton';
import { useBotGroupChat } from './useBotGroupChat';

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

export function BotGroupChatScreen({ deviceId, deviceName, groupId }: { deviceId: string; deviceName: string; groupId: string }) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user, accountGeneration } = useAuth();
  const host = useMemo<RemoteResourceHostTarget>(() => ({ deviceId, deviceName: deviceName || deviceId }), [deviceId, deviceName]);
  const chat = useBotGroupChat(host, groupId);
  const identity = useBotGroupIdentities(deviceId);
  const [settings, setSettings] = useState(false);
  const leaveAfterSettings = useRef(false);
  const [continuing, setContinuing] = useState(false);
  const [planPending, setPlanPending] = useState<PlanPending | null>(null);
  const planPendingRef = useRef(false);
  const scrollRef = useRef<ScrollView>(null);
  const stickToBottom = useRef(true);
  const group = chat.state.kind === 'ready' ? chat.state.group : null;
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

  const report = useCallback((error: unknown, fallbackKey: string) => {
    Alert.alert(chat.online ? botGroupActionErrorText(t, error, fallbackKey) : t('devices.resources.hostOffline'));
  }, [chat.online, t]);

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
    stickToBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < STICK_TO_BOTTOM_PX;
  };

  const title = group?.name ?? (cachedRow ? resolveRemoteText(cachedRow.item.display.title, i18n.language) : '');
  const memberLine = group
    ? botGroupMemberNames(group.members, t('groupChat.memberSeparator'))
    : cachedRow?.item.display.subtitle ? resolveRemoteText(cachedRow.item.display.subtitle, i18n.language) : '';
  const headerMembers = group ? group.members.map((member) => identityFor(member.botId, member.name)) : [];

  const header = <View style={styles.header} testID="botGroup.header">
    <HomeHeaderGlassButton accessibilityLabel={t('shared.back')} onPress={leave} testID="botGroup.back">
      <ChevronLeft size={iconSize.xl} color={colors.textPrimary} strokeWidth={iconStroke.regular} />
    </HomeHeaderGlassButton>
    <Pressable accessibilityRole="button" accessibilityLabel={[title, memberLine].filter(Boolean).join(', ')}
      accessibilityHint={t('groupChat.settings.open')} disabled={!group} onPress={() => setSettings(true)}
      style={({ pressed }) => [styles.identity, pressed && mobileInteractionStyles.pressed]} testID="botGroup.identity">
      {headerMembers.length ? <BotGroupAvatarStack deviceId={deviceId} members={headerMembers} online={chat.online} /> : null}
      <View style={styles.identityText}>
        <Text numberOfLines={1} style={styles.headerTitle}>{title}</Text>
        {memberLine ? <Text numberOfLines={1} style={styles.headerSubtitle}>{memberLine}</Text> : null}
      </View>
    </Pressable>
    <HomeHeaderGlassButton accessibilityLabel={t('groupChat.settings.open')} disabled={!group} onPress={() => setSettings(true)}
      testID="botGroup.settingsButton">
      <Settings2 size={iconSize.lg} color={colors.textPrimary} strokeWidth={iconStroke.regular} />
    </HomeHeaderGlassButton>
  </View>;

  let body;
  if (chat.state.kind === 'loading' && !chat.online) {
    // Nothing to show until the computer is reachable again; the screen re-reads on reconnect.
    body = <View style={styles.center}>
      <MainWindowEmptyState centered testID="botGroup.offline" title={t('groupChat.loadFailedTitle')} copy={t('devices.resources.hostOffline')}>
        <View style={styles.emptyActions}>
          <MainWindowActionButton action={{ label: t('shared.back'), onPress: leave, testID: 'botGroup.leave' }} />
        </View>
      </MainWindowEmptyState>
    </View>;
  } else if (chat.state.kind === 'loading') {
    body = <View style={styles.center}><ActivityIndicator color={colors.textSecondary} /></View>;
  } else if (chat.state.kind !== 'ready' || !group) {
    const failed = chat.state.kind === 'error';
    body = <View style={styles.center}>
      <MainWindowEmptyState centered testID={failed ? 'botGroup.loadFailed' : 'botGroup.unavailable'}
        title={t(failed ? 'groupChat.loadFailedTitle' : 'groupChat.unavailableTitle')}
        copy={t(failed ? 'groupChat.loadFailedDescription' : 'groupChat.unavailableDescription')}>
        <View style={styles.emptyActions}>
          <MainWindowActionButton action={{ label: t('shared.back'), onPress: leave, testID: 'botGroup.leave' }} />
          {failed ? <MainWindowActionButton action={{ label: t('devices.resources.retry'), tone: 'primary', onPress: chat.reload, testID: 'botGroup.retry' }} /> : null}
        </View>
      </MainWindowEmptyState>
    </View>;
  } else {
    body = <KeyboardAvoidingView style={styles.flex} enabled={Platform.OS === 'ios'} behavior="padding">
      {!chat.online ? <Text accessibilityRole="alert" style={styles.offline} testID="botGroup.offlineNote">{t('devices.resources.hostOffline')}</Text> : null}
      <ScrollView ref={scrollRef} style={styles.flex} contentContainerStyle={styles.timeline} keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive" onScroll={onScroll} scrollEventThrottle={64}
        onContentSizeChange={() => { if (stickToBottom.current) scrollRef.current?.scrollToEnd({ animated: false }); }}
        testID="botGroup.timeline">
        <BotGroupTimeline group={group} deviceId={deviceId} online={chat.online} identityFor={identityFor}
          continuing={continuing} planPending={planPending}
          onContinue={() => void continueRound()}
          onPlanAction={(action, planId) => void runPlanAction(action, planId)}
          onEditStep={(planId, step, action, botId) => void editPlanStep(planId, step, action, botId)}
          onInteractionError={(message) => { if (message) Alert.alert(message); }} />
      </ScrollView>
      <BotGroupComposer members={group.members} identityFor={identityFor} deviceId={deviceId} online={chat.online}
        running={group.round.status === 'running'} planState={botGroupComposerPlanState(openBotGroupPlan(group))}
        onSend={send} onStop={stop} />
    </KeyboardAvoidingView>;
  }

  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']} testID="botGroup.screen">
    <Stack.Screen options={{ headerShown: false }} />
    {header}
    {body}
    {group ? <BotGroupSettingsSheet visible={settings} group={group} host={host} identityFor={identityFor} online={chat.online}
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
  group, deviceId, online, identityFor, continuing, planPending, onContinue, onPlanAction, onEditStep, onInteractionError,
}: {
  group: BotGroupRemoteChatData;
  deviceId: string;
  online: boolean;
  identityFor: BotGroupIdentityLookup;
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
    {group.hasMoreBefore ? <Text style={styles.olderNote} testID="botGroup.olderOnComputer">{t('groupChat.timeline.olderOnComputer')}</Text> : null}
    {messages.length === 0 && !running ? <MainWindowEmptyState centered testID="botGroup.empty"
      title={t('groupChat.timeline.emptyTitle')} copy={t('groupChat.timeline.emptyDescription')} /> : null}
    {messages.map((message) => {
      const groupTime = timeGroups.get(message.id);
      return <View key={message.id} style={styles.item}>
        {groupTime !== undefined ? <Text style={styles.time}>{formatBotMessageGroupTime(groupTime, i18n.language)}</Text> : null}
        <BotGroupTimelineItem message={message} member={message.authorBotId ? memberById.get(message.authorBotId) : undefined}
          members={group.members} deviceId={deviceId} online={online} identityFor={identityFor} mentionLabels={mentionLabels}
          canContinue={message.id === continueId} continuing={continuing} onContinue={onContinue}
          plan={message.planId ? planById.get(message.planId) : undefined}
          planActionable={message.kind === 'plan' && openPlan?.id === message.planId && openPlan.status === 'proposed'}
          planReassignable={message.kind === 'plan' && openPlan?.id === message.planId && openPlan.status === 'waiting'}
          planPending={planCardPending(pendingFor(message.planId))}
          onPlanAction={(action) => { if (message.planId) onPlanAction(action, message.planId); }}
          onEditStep={(step, action, botId) => { if (message.planId) onEditStep(message.planId, step, action, botId); }} />
      </View>;
    })}
    {openPlan && followUp ? <View style={styles.indented}>
      <BotGroupPlanFollowUpRow followUp={followUp} identityFor={identityFor} deviceId={deviceId} online={online}
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
  message, member, members, deviceId, online, identityFor, mentionLabels, canContinue, continuing, onContinue,
  plan, planActionable, planReassignable, planPending, onPlanAction, onEditStep,
}: {
  message: BotGroupMessageView;
  member: BotGroupMemberView | undefined;
  members: readonly BotGroupMemberView[];
  deviceId: string;
  online: boolean;
  identityFor: BotGroupIdentityLookup;
  mentionLabels: readonly string[];
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
  if (message.authorKind === 'user') {
    return <View style={styles.userRow} testID="botGroup.message.user">
      <View style={styles.userBubble}><BotGroupUserText content={message.content} mentionLabels={mentionLabels} /></View>
    </View>;
  }
  // Name snapshot from when it was said; the avatar follows the live profile.
  const author = identityFor(message.authorBotId ?? '', message.authorName || member?.name || '');
  const isPlanCard = message.kind === 'plan';
  return <View style={styles.botRow} testID={isPlanCard ? 'botGroup.message.plan' : 'botGroup.message.bot'}>
    <BotGroupAvatar deviceId={deviceId} identity={author} size={BOT_GROUP_MESSAGE_AVATAR_SIZE} online={online} />
    <View style={styles.botColumn}>
      <View style={styles.authorRow}>
        <Text numberOfLines={1} style={styles.authorName}>{author.name}</Text>
        {isPlanCard ? <BotGroupOrganizerTag /> : null}
      </View>
      {isPlanCard
        ? <BotGroupPlanCard plan={plan} members={members} identityFor={identityFor} deviceId={deviceId} online={online}
          actionable={planActionable} reassignable={planReassignable} pending={planPending}
          onStart={() => onPlanAction('start')} onDismiss={() => onPlanAction('dismiss')} onEditStep={onEditStep} />
        : <>
          {message.content.trim() ? <BotGroupMarkdownText content={message.content} /> : null}
          <BotGroupHandoffFiles files={message.files} />
        </>}
    </View>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 52, paddingHorizontal: spacing.md,
    borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
  identity: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  identityText: { flex: 1, minWidth: 0 },
  headerTitle: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.semibold },
  headerSubtitle: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyActions: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm, marginTop: spacing.lg },
  timeline: { flexGrow: 1, justifyContent: 'flex-end', gap: spacing.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  item: { gap: spacing.lg },
  // Aligns the follow-up row with message text, past the 28pt avatar and its gap.
  indented: { paddingLeft: BOT_GROUP_MESSAGE_AVATAR_SIZE + spacing.sm },
  offline: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, textAlign: 'center',
    paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  olderNote: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, textAlign: 'center' },
  time: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, textAlign: 'center' },
  notice: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, textAlign: 'center' },
  dividerText: { flexShrink: 1, color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, textAlign: 'center' },
  userRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  userBubble: { maxWidth: '82%', backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  botRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  botColumn: { flex: 1, minWidth: 0, gap: spacing.xs },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: BOT_GROUP_MESSAGE_AVATAR_SIZE },
  authorName: { flexShrink: 1, color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium },
});
