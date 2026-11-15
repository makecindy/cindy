import { localBotSettingsTarget } from './localBotSettingsTarget';
import { useOptionalBotSettingsTarget, type BotSettingsTarget } from './botSettingsTarget';

/** The target of the surrounding settings page; this computer when there is none. */
export function useBotSettingsTarget(): BotSettingsTarget {
  return useOptionalBotSettingsTarget() ?? localBotSettingsTarget;
}
