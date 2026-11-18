import { useMemo } from 'react';
import type { ComposerBotMention } from '@/lib/fileTypes';
import { useBotProfiles } from '@/features/bots/botStore';
import { useCompanionCloud } from '@/features/bots/companionCloudStore';
import { withoutShadowedBots } from '@/features/bots/companionCloudPresentation';

/** Ordinary tasks share the local roster only after their owning computer is known. */
export function useTaskBotMentions(
  deviceId: string | null | undefined,
  remoteHostId: string | null | undefined,
  explicitMentions?: readonly ComposerBotMention[],
): readonly ComposerBotMention[] | undefined {
  const profiles = useBotProfiles();
  const cloud = useCompanionCloud();
  return useMemo(() => {
    // An explicit empty list is intentional. Remote / unresolved tasks must not
    // receive bot IDs that only the controller can resolve (see PR #9029).
    if (explicitMentions !== undefined) return explicitMentions;
    if (deviceId !== null || remoteHostId) return undefined;
    return withoutShadowedBots(profiles, cloud)
      .filter((bot) => bot.enabled !== false && bot.status === 'active')
      .map(({ id, name, description }) => ({
        id,
        name,
        ...(description?.trim() ? { description } : {}),
      }));
  }, [deviceId, remoteHostId, explicitMentions, profiles, cloud]);
}
