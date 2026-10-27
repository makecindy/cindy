import { useCallback, useState } from 'react';
import { ScrollView } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BotGroupRemoteChatData } from '@cindy/maker-shared/botGroupChat';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { getRemoteResource } from '@/device-link/remoteResources';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { BOT_GROUP_CLIENT_PRIMITIVES, botGroupChatDataFromResource, botGroupResourceRef } from './botGroupRemote';
import { BotGroupSpeakerRow } from './BotGroupSpeakerRow';
import type { BotGroupIdentity } from './BotGroupAvatars';

/** Live work is separate from messages. Only an owned companion's computer can
 * resolve its execution to a task; another member's private task is never queried. */
export function BotGroupWorkArea({ group, deviceId, online, identityFor, onError }: {
  group: BotGroupRemoteChatData; deviceId: string; online: boolean;
  identityFor(botId: string, name: string): BotGroupIdentity;
  onError(message: string | null): void;
}) {
  const { accountGeneration } = useAuth();
  const { i18n } = useTranslation();
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
  return <ScrollView testID="botGroup.work" style={{ maxHeight: 220 }} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, gap: 12 }} keyboardShouldPersistTaps="handled">
    {group.round.speakers.map(speaker => {
      const member = group.members.find(member => member.botId === speaker.botId);
      if (!member) return null;
      const target = speaker.executionId && resolved?.scope === scope ? resolved.targets.get(speaker.executionId) : undefined;
      const host = target?.deviceId ?? deviceId;
      return <BotGroupSpeakerRow key={speaker.executionId ?? `${speaker.botId}:${speaker.activity}`}
        deviceId={host} online={online && !!host && getPresenceAvailability(host) !== false}
        identity={{ ...identityFor(member.botId, member.name), ...(target ? { botId: target.botId } : {}) }} sessionId={speaker.sessionId ?? target?.sessionId ?? null}
        activity={speaker.activity} executionStatus={speaker.executionStatus} stopping={speaker.stopping} onError={onError} />;
    })}
  </ScrollView>;
}
