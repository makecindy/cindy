/**
 * 正在发言 / 安排 / 做事的伙伴一行（对照桌面 BotGroupChatView 的 BotGroupSpeakingRow 与
 * BotGroupPendingInteraction）。
 *
 * 伙伴的群专线或分工 Session 是一条普通 Cindy Session：页面聚焦期间订阅它的
 * `session:<id>` 流并读一次挂起交互的快照，权限请求 / 提问就地用伙伴卡片样式显示在这位
 * 伙伴下面，作答走任务页同一条路径。等你确认时不再显示「正在…」。
 */
import { useCallback, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { readWorkingPhase } from '@cindy/maker-shared';
import type { BotGroupSpeakerActivity, BotGroupSpeaker } from '@cindy/maker-shared/botGroupChat';
import { Text } from '@/components/AppText';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import {
  BOT_GROUP_INLINE_AVATAR_SIZE,
  BotGroupAvatar,
  type BotGroupIdentity,
} from './BotGroupAvatars';
import { InteractionPanel } from './InteractionPanel';
import { remoteSessionStore, useSessionPendingInteractions } from './remoteSessionStore';
import type { PendingInteraction } from './types';
import { useCompanionGenerationCopy } from './useCompanionGenerationCopy';
import { CompanionPresenceRing } from './CompanionPresenceRing';
import { formatLocalizedSeconds } from './sessionDurationFormat';
import { WorkingStatusText } from './WorkingStatusText';

export function BotGroupSpeakerRow({ deviceId, identity, sessionId, activity, online, executionStatus, stopping, startedAt, onStop, stopPending, onError }: {
  deviceId: string;
  identity: BotGroupIdentity;
  sessionId: string | null;
  activity: BotGroupSpeakerActivity;
  online: boolean;
  executionStatus?: BotGroupSpeaker['executionStatus'];
  stopping?: boolean;
  startedAt?: number;
  onStop?: () => Promise<void>;
  stopPending?: boolean;
  onError(message: string | null): void;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const { invoke, subscribe, unsubscribe } = useDeviceLink();
  const lane = sessionId ?? '';
  const [now, setNow] = useState(Date.now);
  useFocusEffect(useCallback(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []));
  useFocusEffect(useCallback(() => {
    if (!lane || !online) return;
    let cancelled = false;
    const offTopic = startFocusedTopicSubscription({ deviceId, owner: `bot-group-speaker:${lane}`, topic: `session:${lane}`, subscribe, unsubscribe });
    // Seed prompts raised before this screen subscribed; later ones arrive as pushes.
    void invoke<PendingInteraction[]>(deviceId, 'maker:get-pending-interactions', [lane]).then((list) => {
      if (!cancelled && Array.isArray(list)) remoteSessionStore.setPendingInteractions(lane, list, { deviceId });
    }).catch(() => undefined);
    return () => { cancelled = true; offTopic(); };
  }, [deviceId, invoke, lane, online, subscribe, unsubscribe]));
  const pending = useSessionPendingInteractions(lane);
  const live = useSyncExternalStore(remoteSessionStore.subscribe, () => lane ? remoteSessionStore.getSessionLiveActivity(lane, deviceId) : null);
  const isStopping = stopping || executionStatus === 'stopping';
  const waiting = !isStopping && (pending.length > 0 || live?.phase === 'needs-interaction' || executionStatus === 'needs_input');
  const livePhase = readWorkingPhase(live?.workingPhase);
  // The organizer's decision runs outside any Session: there is no live phase to show.
  const copy = useCompanionGenerationCopy({
    deviceId,
    botId: identity.botId,
    phase: activity === 'reply' ? livePhase ?? 'processing' : livePhase,
    active: !waiting && !isStopping && activity !== 'planning' && (activity === 'reply' || livePhase !== null),
    turnId: lane,
  });
  const label = isStopping ? t('groupChat.speaking.stopping')
    : executionStatus === 'queued' ? t('devices.companions.status.queued')
    : activity === 'planning'
    ? t('groupChat.speaking.planning')
    : copy ?? (activity === 'step' ? t('groupChat.speaking.step') : t('devices.companions.working.processing'));
  const elapsed = executionStatus !== 'queued' && startedAt && Number.isFinite(startedAt)
    ? t('message.renderer.workedDuration', { duration: formatLocalizedSeconds((now - startedAt) / 1000) }) : null;
  return <View style={styles.row} testID="botGroup.speaking" accessibilityLabel={`${identity.name}, ${waiting ? t('groupChat.waitingConfirm', { name: identity.name }) : label}`}>
    <View style={styles.nameRow}>
      <View style={styles.avatar}>
        <BotGroupAvatar deviceId={deviceId} identity={identity} size={iconSize.xl} online={online} />
        <CompanionPresenceRing active={!waiting && !isStopping} width={1.5} />
      </View>
      <Text numberOfLines={1} style={styles.name}>{identity.name}</Text>
    </View>
    <View style={styles.actions}>
      <View style={styles.status} accessibilityLiveRegion="polite" testID={waiting ? 'botGroup.speaking.waiting' : `botGroup.speaking.${activity}`}>
        {waiting ? <Text numberOfLines={1} style={styles.statusText}>{t('groupChat.waitingConfirm', { name: '' })}</Text>
          : <WorkingStatusText key={`${lane}:${activity}`} text={label} style={styles.statusText} />}
        {elapsed ? <Text numberOfLines={1} style={styles.statusText}>{elapsed}</Text> : null}
      </View>
      {sessionId && deviceId ? <Pressable accessibilityRole="button" style={styles.button}
        onPress={() => router.push({ pathname: '/sessions/[sessionId]', params: { sessionId, deviceId } })}>
        <Text style={styles.buttonText}>{t('groupChat.progress.viewProcess')}</Text>
      </Pressable> : null}
      {onStop ? <Pressable accessibilityRole="button" accessibilityLabel={t('groupChat.composer.stop')}
        testID="botGroup.work.stop" disabled={stopPending} style={styles.button} onPress={() => { void onStop(); }}>
        <Text style={styles.buttonText}>{t(stopPending ? 'groupChat.speaking.stopping' : 'groupChat.progress.stop')}</Text>
      </Pressable> : null}
    </View>
      {pending.length > 0 && lane ? <InteractionPanel embedded companion
        companionIdentity={{ name: identity.name, avatar: <BotGroupAvatar deviceId={deviceId} identity={identity} size={BOT_GROUP_INLINE_AVATAR_SIZE} online={online} /> }}
        deviceId={deviceId} sessionId={lane} interactions={pending} onError={onError} />
        : null}
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  row: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container, paddingHorizontal: spacing.sm, paddingTop: spacing.sm },
  avatar: { width: iconSize.xl, height: iconSize.xl },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { flex: 1, color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  status: { flex: 1, minWidth: 0 },
  statusText: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  button: { minHeight: 44, minWidth: 48, paddingHorizontal: spacing.xs, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
});
