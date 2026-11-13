import { BotGroupProcessEntries } from './BotGroupProcess';
import { TeammateProcess, useTeammateElapsedTitle } from './TeammateProcess';
import { BOT_GROUP_CLIENT_ID, readBotGroupProcessMessages, isBotGroupProcessMessageVisible, type BotGroupProcessMessage } from '@cindy/maker-shared/botGroupChat';
import { useRemoteSessionMessages } from './remoteSessionStore';
import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
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

/** Owned-session prompts stay outside the collapsible execution progress. */
export function BotGroupSpeakerRow({ deviceId, identity, sessionId, activity, online, executionStatus, stopping, executionId, groupId, startedAt, workStep, revealWaiting = true, footer, onError }: {
  deviceId: string;
  executionId?: string;
  groupId?: string;
  startedAt?: number;
  workStep?: { position: number; total: number; task: string };
  identity: BotGroupIdentity;
  sessionId: string | null;
  activity: BotGroupSpeakerActivity;
  online: boolean;
  executionStatus?: BotGroupSpeaker['executionStatus'];
  stopping?: boolean;
  revealWaiting?: boolean;
  footer?: ReactNode;
  onError(message: string | null): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { invoke, subscribe, unsubscribe } = useDeviceLink();
  const lane = revealWaiting && executionStatus !== 'queued' ? sessionId ?? '' : '';
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
  // The organizer's decision runs outside any Session: there is no live phase to show.
  const elapsedTitle = useTeammateElapsedTitle(true, executionStatus !== 'queued' && startedAt !== undefined && Number.isFinite(startedAt) && startedAt > 0 ? startedAt : undefined);
  const label = isStopping ? t('groupChat.speaking.stopping')
    : executionStatus === 'queued' ? t('groupChat.speaking.queued')
    : activity === 'planning'
    ? t('groupChat.speaking.planning')
    : t('chat.teammateProcess.processing');
  const stateLabel = waiting ? t(revealWaiting ? 'groupChat.waitingConfirm' : 'groupChat.waitingForOwner', { name: '' }) : isStopping || executionStatus === 'queued' || activity === 'planning' ? label : elapsedTitle;
  return <View style={styles.row} testID="botGroup.speaking" accessibilityLabel={`${identity.name}, ${waiting ? t(revealWaiting ? 'groupChat.waitingConfirm' : 'groupChat.waitingForOwner', { name: identity.name }) : label}`}>
    <View style={styles.avatar}>
      <BotGroupAvatar deviceId={deviceId} identity={identity} size={BOT_GROUP_MESSAGE_AVATAR_SIZE} online={online} />
    </View>
    <View style={styles.body}>
      <TeammateProcess id={`group-process:${executionId ?? lane}`} running
        title={`${identity.name} · ${stateLabel}`}
        titleContent={<Text style={styles.processName}>{identity.name}</Text>}
        titleAccessory={<Text numberOfLines={1} style={styles.processState}>{stateLabel}</Text>}>
        {workStep ? <Text style={styles.statusText}>{t('groupChat.progress.step', { step: workStep.position, total: workStep.total })} · {workStep.task}</Text> : null}
        {lane && groupId && executionId ? <BotGroupLiveNotes key={`${deviceId}:${lane}:${executionId}`} deviceId={deviceId} sessionId={lane}
          clientId={BOT_GROUP_CLIENT_ID.memberTurn(groupId, executionId, identity.botId)}
          groupId={groupId} executionId={executionId} since={startedAt} running={!waiting && !isStopping} />
          : live?.compactDetail?.trim() && !/^(?:NO_REPLY|SILENT)$/i.test(live.compactDetail.trim())
            ? <Text style={styles.statusText}>{live.compactDetail}</Text> : null}
      </TeammateProcess>
      {revealWaiting && pending.length > 0 && lane ? <InteractionPanel embedded companion
        companionIdentity={{ name: identity.name, avatar: <BotGroupAvatar deviceId={deviceId} identity={identity} size={BOT_GROUP_INLINE_AVATAR_SIZE} online={online} /> }}
        deviceId={deviceId} sessionId={lane} interactions={pending} onError={onError} />
        : null}
      {footer ? <View style={styles.actions}>{footer}</View> : null}
    </View>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  avatar: { width: BOT_GROUP_MESSAGE_AVATAR_SIZE, height: BOT_GROUP_MESSAGE_AVATAR_SIZE, marginTop: spacing.sm },
  body: { flex: 1, minWidth: 0 },
  processName: { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular },
  processState: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
  statusText: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
});

function BotGroupLiveNotes({ deviceId, sessionId, clientId, groupId, executionId, since, running }: {
  deviceId: string; sessionId: string; clientId: string; groupId: string; executionId: string; since?: number; running: boolean;
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
    return isBotGroupProcessMessageVisible(message)
      && (start >= 0 || since !== undefined && Date.parse(message.createdAt) >= since);
  });
  const merged = [...new Map([...history, ...live].map(message => [message.clientId, message])).values()];
  return <BotGroupProcessEntries messages={merged} id={`group-process:${executionId}`} deviceId={deviceId} sessionId={sessionId} running={running} />;
}
