import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BotGroupRemoteChatData } from '@cindy/maker-shared/botGroupChat';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { getRemoteResource } from '@/device-link/remoteResources';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { BOT_GROUP_CLIENT_PRIMITIVES, botGroupChatDataFromResource, botGroupResourceRef } from './botGroupRemote';
import { BotGroupMenu } from './BotGroupMenu';
import { BotGroupSpeakerRow } from './BotGroupSpeakerRow';
import type { BotGroupIdentity } from './BotGroupAvatars';
import { Text } from '@/components/AppText';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { lineHeight, spacing, typeScale } from '@/theme/tokens';

/** Live work is separate from messages. Only an owned companion's computer can
 * resolve its execution to a task; another member's private task is never queried. */
export function BotGroupWorkArea({ group, deviceId, online, identityFor, onStop, stopping = false, onError }: {
  group: BotGroupRemoteChatData; deviceId: string; online: boolean;
  identityFor(botId: string, name: string): BotGroupIdentity;
  onStop?(scope?: 'all'): Promise<void>;
  stopping?: boolean;
  onError(message: string | null): void;
}) {
  const { accountGeneration } = useAuth();
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { invoke, openLink, connectionEpoch, presenceVersion, getPresenceAvailability, subscribe, unsubscribe, onRemoteResourceChanged } = useDeviceLink();
  const candidates = group.round.speakers.flatMap(speaker => {
    const member = group.members.find(member => member.botId === speaker.botId);
    return !speaker.sessionId && speaker.executionId && member?.isOwned && member.homeDeviceId
      ? [{ executionId: speaker.executionId, deviceId: member.homeDeviceId }] : [];
  });
  const scope = JSON.stringify([accountGeneration, group.id, deviceId, candidates]);
  const [resolved, setResolved] = useState<{ scope: string; targets: Map<string, { deviceId: string; sessionId: string; botId: string }> }>();
  useFocusEffect(useCallback(() => {
    if (!online || !candidates.length) return;
    let cancelled = false;
    let reading = false;
    let again = false;
    const hosts = [...new Set(candidates.map(candidate => candidate.deviceId))];
    const read = async () => {
      if (cancelled) return;
      if (reading) { again = true; return; }
      reading = true;
      const targets = new Map<string, { deviceId: string; sessionId: string; botId: string }>();
      await Promise.all(hosts.map(async host => {
        if (getPresenceAvailability(host) === false) return;
        try {
          await openLink(host);
          if (cancelled) return;
          const resource = await getRemoteResource(invoke, { deviceId: host, deviceName: '' }, botGroupResourceRef(group.id), i18n.language, BOT_GROUP_CLIENT_PRIMITIVES);
          const remote = botGroupChatDataFromResource(resource);
          if (remote?.id !== group.id) return;
          for (const candidate of candidates.filter(candidate => candidate.deviceId === host)) {
            const speaker = remote.round.speakers.find(speaker => speaker.executionId === candidate.executionId);
            if (speaker?.sessionId) targets.set(candidate.executionId, { deviceId: host, sessionId: speaker.sessionId, botId: speaker.botId });
          }
        } catch { /* Generic server status remains available while the computer cannot be reached. */ }
      }));
      if (!cancelled) setResolved({ scope, targets });
      reading = false;
      if (again) { again = false; void read(); }
    };
    const off = onRemoteResourceChanged((host, payload) => {
      if (hosts.includes(host) && payload.collectionId === 'bot-groups'
        && (!payload.resourceRefs?.length || payload.resourceRefs.some(ref => ref.id === group.id))) void read();
    });
    const topics = hosts.map(host => startFocusedTopicSubscription({ deviceId: host, owner: `group-work:${group.id}`, topic: 'sessions', subscribe, unsubscribe }));
    void read();
    return () => { cancelled = true; off(); topics.forEach(offTopic => offTopic()); };
  }, [scope, online, connectionEpoch, presenceVersion, invoke, openLink, subscribe, unsubscribe, onRemoteResourceChanged, getPresenceAvailability, i18n.language]));
  if (group.round.status !== 'running' || !group.round.speakers.length) return null;
  const speakers = group.round.speakers.filter(speaker => group.members.some(member => member.botId === speaker.botId));
  if (!speakers.length) return null;
  const stopPending = stopping || speakers.every(speaker => speaker.stopping || speaker.executionStatus === 'stopping');
  const stopButton = (onPress: (() => void) | undefined) => <Pressable testID="botGroup.work.stop" accessibilityRole="button"
    accessibilityLabel={t('groupChat.composer.stop')} accessibilityState={{ disabled: stopPending, busy: stopPending }}
    disabled={stopPending} style={styles.stop} onPress={onPress}>
    <Text style={styles.stopText}>{t(stopPending ? 'groupChat.speaking.stopping' : 'groupChat.progress.stop')}</Text>
  </Pressable>;
  const canStopAll = group.supportsScopedStop && group.canStopAll && group.round.othersActive;
  const stopControl = online && onStop && (group.round.canStop !== false || canStopAll) ? canStopAll
      ? <BotGroupMenu title={t('groupChat.progress.stop')} accessibilityLabel={t('groupChat.composer.stop')}
          disabled={stopPending} testID="botGroup.work.stopMenu" sections={[{ id: 'scope', options: [
            ...(group.round.canStop !== false ? [{ id: 'mine', title: t('groupChat.progress.stopMine') }] : []),
            { id: 'all', title: t('groupChat.progress.stopAll'), subtitle: t('groupChat.progress.stopAllHint'), destructive: true },
          ] }]} onSelect={id => { void onStop(id === 'all' ? 'all' : undefined); }}>
          {stopButton}
        </BotGroupMenu>
      : stopButton(() => { void onStop(); }) : null;
  return <View testID="botGroup.work" style={styles.container}>
      {speakers.map((speaker, index) => {
        const member = group.members.find(member => member.botId === speaker.botId);
        if (!member) return null;
        const target = speaker.executionId && resolved?.scope === scope ? resolved.targets.get(speaker.executionId) : undefined;
        const host = target?.deviceId ?? deviceId;
        const plan = speaker.activity === 'step' ? group.plans?.find(plan => plan.status === 'running' && plan.kind !== 'talk'
          && plan.steps.some(step => step.position === plan.currentStep && step.status === 'running' && step.botId === speaker.botId
            && (step.executionId ? step.executionId === speaker.executionId : speakers.filter(candidate => candidate.activity === 'step'
              && candidate.botId === step.botId && !candidate.stopping && candidate.executionStatus !== 'queued'
              && candidate.executionStatus !== 'stopping').length === 1))
          && !speaker.stopping && speaker.executionStatus !== 'queued' && speaker.executionStatus !== 'stopping') : undefined;
        const step = plan?.steps.find(step => step.position === plan.currentStep);
        return <BotGroupSpeakerRow key={`${accountGeneration}:${group.id}:${deviceId}:${speaker.executionId ?? `${speaker.botId}:${speaker.activity}`}`}
          deviceId={host} online={online && !!host && getPresenceAvailability(host) !== false}
          identity={{ ...identityFor(member.botId, member.name), ...(target ? { botId: target.botId } : {}) }} sessionId={member.isOwned === false ? null : speaker.sessionId ?? target?.sessionId ?? null}
          executionId={speaker.executionId} startedAt={speaker.startedAt} groupId={group.id}
          workStep={plan && step ? { position: step.position + 1, total: plan.steps.length, task: step.task } : undefined}
          revealWaiting={member.isOwned !== false} footer={index === speakers.length - 1 ? stopControl : undefined}
          activity={speaker.activity} executionStatus={speaker.executionStatus} stopping={speaker.stopping} onError={onError} />;
      })}
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: { flexShrink: 0, gap: spacing.sm },
  stop: { alignSelf: 'flex-start', minHeight: 44, minWidth: 48,
    paddingHorizontal: spacing.sm, justifyContent: 'center', alignItems: 'center' },
  stopText: { color: colors.destructive, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
});
