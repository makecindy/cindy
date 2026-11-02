import { BotGroupProcessEntries } from './BotGroupProcess';
import { TeammateProcess, TeammateProcessLink, useTeammateElapsedTitle } from './TeammateProcess';
import { BOT_GROUP_CLIENT_ID, readBotGroupProcessMessages, type BotGroupProcessMessage } from '@cindy/maker-shared/botGroupChat';
import { useRemoteSessionMessages } from './remoteSessionStore';
/**
 * 正在发言 / 安排 / 做事的伙伴一行（对照桌面 BotGroupChatView 的 BotGroupSpeakingRow 与
 * BotGroupPendingInteraction）。
 *
 * 伙伴的群专线或分工 Session 是一条普通 Cindy Session：页面聚焦期间订阅它的
 * `session:<id>` 流并读一次挂起交互的快照，权限请求 / 提问就地用伙伴卡片样式显示在这位
 * 伙伴下面，作答走任务页同一条路径。等你确认时不再显示「正在…」。
 */
import { useCallback, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { readWorkingPhase } from '@cindy/maker-shared';
import type { BotGroupSpeakerActivity, BotGroupSpeaker } from '@cindy/maker-shared/botGroupChat';
import { Text } from '@/components/AppText';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, spacing, typeScale } from '@/theme/tokens';
import {
  BOT_GROUP_INLINE_AVATAR_SIZE,
  BOT_GROUP_MESSAGE_AVATAR_SIZE,
  BotGroupAvatar,
  type BotGroupIdentity,
} from './BotGroupAvatars';
import { InteractionPanel } from './InteractionPanel';
import { remoteSessionStore, useSessionPendingInteractions } from './remoteSessionStore';
import type { PendingInteraction } from './types';
import { CompanionPresenceRing } from './CompanionPresenceRing';

export function BotGroupSpeakerRow({ deviceId, identity, sessionId, activity, online, executionStatus, stopping, executionId, groupId, startedAt, onError }: {
  deviceId: string;
  executionId?: string;
  groupId?: string;
  startedAt?: number;
  identity: BotGroupIdentity;
  sessionId: string | null;
  activity: BotGroupSpeakerActivity;
  online: boolean;
  executionStatus?: BotGroupSpeaker['executionStatus'];
  stopping?: boolean;
  onError(message: string | null): void;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const { invoke, subscribe, unsubscribe } = useDeviceLink();
  const lane = sessionId ?? '';
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
  const waiting = pending.length > 0 || live?.phase === 'needs-interaction' || executionStatus === 'needs_input';
  const livePhase = readWorkingPhase(live?.workingPhase);
  // The organizer's decision runs outside any Session: there is no live phase to show.
  const copy = t(`devices.companions.working.${livePhase ?? 'processing'}`);
  const elapsedTitle = useTeammateElapsedTitle(true, startedAt);
  const label = stopping || executionStatus === 'stopping' ? t('groupChat.speaking.stopping')
    : executionStatus === 'queued' ? t('devices.companions.status.queued')
    : activity === 'planning'
    ? t('groupChat.speaking.planning')
    : copy ?? (activity === 'step' ? t('groupChat.speaking.step') : t('devices.companions.working.processing'));
  // G4: the same working vocabulary as the 1:1 chat — breathing portrait, three dots, paced copy.
  return <View style={styles.row} testID="botGroup.speaking" accessibilityLabel={`${identity.name}, ${waiting ? t('groupChat.waitingConfirm', { name: identity.name }) : label}`}>
    <View style={styles.avatar}>
      <BotGroupAvatar deviceId={deviceId} identity={identity} size={BOT_GROUP_MESSAGE_AVATAR_SIZE} online={online} />
      <CompanionPresenceRing active={!waiting} width={1.5} />
    </View>
    <View style={styles.column}>
      <View style={styles.nameRow}><Text numberOfLines={1} style={styles.name}>{identity.name}</Text></View>
      <TeammateProcess id={`group-process:${executionId ?? lane}`} running
        title={waiting ? t('groupChat.waitingConfirm', { name: identity.name }) : stopping || executionStatus === 'stopping' || executionStatus === 'queued' || activity === 'planning' ? label : elapsedTitle}>
        {lane && groupId && executionId ? <BotGroupLiveNotes deviceId={deviceId} sessionId={lane}
          clientId={BOT_GROUP_CLIENT_ID.memberTurn(groupId, executionId, identity.botId)}
          groupId={groupId} executionId={executionId} since={startedAt} />
          : live?.compactDetail?.trim() && !/^(?:NO_REPLY|SILENT)$/i.test(live.compactDetail.trim())
            ? <Text style={styles.statusText}>{live.compactDetail}</Text> : null}
        {sessionId && deviceId ? <TeammateProcessLink title={t('devices.companions.openTask')}
          onPress={() => router.push({ pathname: '/sessions/[sessionId]', params: { sessionId, deviceId } })} /> : null}
      </TeammateProcess>
      {pending.length > 0 && lane ? <InteractionPanel embedded companion
        companionIdentity={{ name: identity.name, avatar: <BotGroupAvatar deviceId={deviceId} identity={identity} size={BOT_GROUP_INLINE_AVATAR_SIZE} online={online} /> }}
        deviceId={deviceId} sessionId={lane} interactions={pending} onError={onError} />
        : null}
    </View>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  // The group message row: 28 portrait 2pt down, 10 to the text, name row as tall as the portrait.
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  avatar: { marginTop: 2, width: BOT_GROUP_MESSAGE_AVATAR_SIZE, height: BOT_GROUP_MESSAGE_AVATAR_SIZE },
  column: { flex: 1, minWidth: 0, gap: spacing.xs },
  nameRow: { minHeight: BOT_GROUP_MESSAGE_AVATAR_SIZE, justifyContent: 'center' },
  name: { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium },
  status: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusText: { flexShrink: 1, color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  // Waiting on you reads like the list's 「等你确认」 prefix: body color, medium — no warning icon.
  waitingText: { flexShrink: 1, color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium },
});

function BotGroupLiveNotes({ deviceId, sessionId, clientId, groupId, executionId, since }: {
  deviceId: string; sessionId: string; clientId: string; groupId: string; executionId: string; since?: number;
}) {
  const { invoke } = useDeviceLink();
  const messages = useRemoteSessionMessages(sessionId);
  const [history, setHistory] = useState<BotGroupProcessMessage[]>([]);
  useFocusEffect(useCallback(() => {
    let cancelled = false;
    // The task page revokes its own detail authority on blur. Hold a separate
    // focused work lease so pushes remain writable when returning to this group.
    const lease = remoteSessionStore.acquireSessionMessageWork(sessionId, true);
    setHistory([]);
    void readBotGroupProcessMessages({ sessionId, clientId, groupId, executionId }, cursor => invoke<BotGroupProcessMessage[]>(deviceId,
      'local-db:messages:around-client-id', [sessionId, cursor, { radius: 80 }]), () => cancelled)
      .then(notes => { if (!cancelled) setHistory(notes); }).catch(() => { /* Live status and the original task remain available. */ });
    return () => { cancelled = true; lease.release(); };
  }, [deviceId, sessionId, clientId, groupId, executionId, invoke]));
  const start = messages.findIndex(message => message.clientId === clientId);
  const live = messages.slice(start >= 0 ? start + 1 : 0).filter(message => {
    const meta = message.agentMeta;
    return !meta?.botPrivateReply && !meta?.failedSamplingAttempt
      && (start >= 0 || since !== undefined && Date.parse(message.createdAt) >= since);
  });
  const merged = [...new Map([...history, ...live].map(message => [message.clientId, message])).values()];
  return <BotGroupProcessEntries messages={merged} id={`group-live:${executionId}`} running />;
}
