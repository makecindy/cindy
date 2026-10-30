import { useEffect, useMemo, useState } from 'react';
import { REMOTE_RESOURCE_GET_CHANNEL, REMOTE_RESOURCE_CHANGED_CHANNEL, parseRemoteResourceChangedPayload } from '@cindy/device-link';
import type { BotGroupDetail, BotGroupSpeaker } from '../../../shared/botGroupChat';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { useCompanionCloud } from './companionCloudStore';

export interface BotGroupWorkTarget {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  botId: string;
}

const EMPTY_TARGETS: ReadonlyMap<string, BotGroupWorkTarget> = new Map();

/** Resolve only our companions, through the existing authenticated group resource.
 * Execution IDs prevent another thread/turn (or the companion's private chat) being opened.
 * Other members' computers are never queried. No work text is sent to Chat Server.
 */
export function useBotGroupWorkTargets(group: BotGroupDetail | null): ReadonlyMap<string, BotGroupWorkTarget> {
  const cloud = useCompanionCloud();
  const candidates = useMemo(() => (group?.round.speakers ?? []).flatMap(speaker => {
    if (speaker.sessionId || !speaker.executionId) return [];
    const actor = cloud.actors.find(actor => actor.id === speaker.botId || actor.externalId === speaker.botId);
    const home = actor?.homeDevice;
    return home && !home.isSelf && home.online && home.remoteControlEnabled
      ? [{ executionId: speaker.executionId, deviceId: home.deviceId, deviceName: home.name, botId: actor.externalId }] : [];
  }), [group?.round.speakers, cloud]);
  const key = JSON.stringify([getDataOwnerGeneration(), group?.id, candidates]);
  const [resolved, setResolved] = useState<{ key: string; targets: ReadonlyMap<string, BotGroupWorkTarget> }>({ key: '', targets: new Map() });
  useEffect(() => {
    if (!group || candidates.length === 0) return;
    const owner = getDataOwnerGeneration();
    let cancelled = false;
    let reading = false;
    let queued = false;
    const current = () => !cancelled && isDataOwnerGenerationCurrent(owner);
    const read = async () => {
      if (!current()) return;
      if (reading) { queued = true; return; }
      reading = true;
      const targets = new Map<string, BotGroupWorkTarget>();
      await Promise.all([...new Set(candidates.map(candidate => candidate.deviceId))].map(async deviceId => {
        try {
          const resource = await window.electronAPI.deviceLink.invoke(deviceId, REMOTE_RESOURCE_GET_CHANNEL, [{
            client: { protocolVersion: 1, primitives: ['bot-group-chat'] },
            ref: { collectionId: 'bot-groups', kind: 'bot-group', id: group.id },
          }]) as { ref?: { id?: string }; blocks?: Array<{ primitive?: string; data?: { id?: string; round?: { speakers?: BotGroupSpeaker[] } } }> };
          const data = resource?.blocks?.find(block => block.primitive === 'bot-group-chat')?.data;
          if (resource?.ref?.id !== group.id || data?.id !== group.id || !Array.isArray(data.round?.speakers)) return;
          for (const candidate of candidates.filter(candidate => candidate.deviceId === deviceId)) {
            const speaker = data.round.speakers.find(speaker => speaker.executionId === candidate.executionId);
            if (typeof speaker?.sessionId === 'string' && speaker.sessionId) targets.set(candidate.executionId, {
              sessionId: speaker.sessionId, deviceId, deviceName: candidate.deviceName, botId: candidate.botId,
            });
          }
        } catch { /* Unknown/old/offline hosts leave the truthful generic status and group stop available. */ }
      }));
      if (current()) setResolved({ key, targets });
      reading = false;
      if (queued) { queued = false; void read(); }
    };
    void read();
    const off = window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
      if (!isDeviceLinkRemotePushCurrent(push, stamp) || push.channel !== REMOTE_RESOURCE_CHANGED_CHANNEL
        || !candidates.some(candidate => candidate.deviceId === push.deviceId)) return;
      const changed = parseRemoteResourceChangedPayload(push.payload);
      if (!changed || changed.collectionId !== 'bot-groups' || (changed.resourceRefs?.length && !changed.resourceRefs.some(ref => ref.id === group.id))) return;
      void read();
    });
    const offReopened = window.electronAPI.deviceLink.onPeerLinkReopened?.(event => {
      if (candidates.some(candidate => candidate.deviceId === event.deviceId)) void read();
    });
    return () => { cancelled = true; off(); offReopened?.(); };
  }, [key]); // key contains the exact group, execution and reachable home identities.
  return resolved.key === key ? resolved.targets : EMPTY_TARGETS;
}
