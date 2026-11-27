import {
  normalizeVoiceConversationPreferences,
  normalizeSentencePlaybackOverrides,
  type VoiceConversationPreference,
  type VoiceConversationSelection,
} from '../../shared/voiceConversation.js';
import type { VoiceInputSettings } from '../../shared/voiceInputData.js';
import { normalizeRealtimeVoicePreferences, type RealtimeVoiceSelection } from '../../shared/realtimeVoice.js';

export function companionVoicePreference(
  settings: VoiceInputSettings,
  botId: string,
): VoiceConversationPreference {
  const map = normalizeVoiceConversationPreferences(settings.conversationSelections);
  const selection = Object.hasOwn(map, botId)
    ? map[botId]
    : (settings.conversationSelection ?? null);
  const playback = normalizeSentencePlaybackOverrides(settings.conversationSentencePlayback);
  const hasOverride = Object.hasOwn(playback, botId);
  const active = normalizeRealtimeVoicePreferences(settings.realtimeSelections);
  const previous = normalizeRealtimeVoicePreferences(settings.previousRealtimeSelections);
  return {
    selection,
    customized: !!selection || hasOverride,
    sentencePlayback: hasOverride ? playback[botId] : true,
    ...(Object.hasOwn(active, botId) ? { realtimeSelection: active[botId] } : {}),
    ...(Object.hasOwn(previous, botId) ? { previousRealtimeSelection: previous[botId] } : {}),
  };
}

export function updateRealtimeVoicePreference(settings: VoiceInputSettings, botId: string, selection: RealtimeVoiceSelection | null) {
  const active = normalizeRealtimeVoicePreferences(settings.realtimeSelections);
  const previous = normalizeRealtimeVoicePreferences(settings.previousRealtimeSelections);
  if (selection) {
    Object.defineProperty(active, botId, { value: selection, enumerable: true, configurable: true, writable: true });
    delete previous[botId];
  } else if (Object.hasOwn(active, botId)) {
    Object.defineProperty(previous, botId, { value: active[botId], enumerable: true, configurable: true, writable: true });
    delete active[botId];
  }
  return { realtimeSelections: active, previousRealtimeSelections: previous };
}

export function updateSentencePlaybackPreference(
  settings: VoiceInputSettings,
  botId: string,
  enabled: boolean | null,
): Record<string, boolean> {
  const map = normalizeSentencePlaybackOverrides(settings.conversationSentencePlayback);
  if (enabled === null) delete map[botId];
  else
    Object.defineProperty(map, botId, {
      value: enabled,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  return map;
}

/** Read the latest map in Main before changing one key; windows never overwrite each other. */
export function updateCompanionVoicePreference(
  settings: VoiceInputSettings,
  botId: string,
  selection: VoiceConversationSelection | null,
): Record<string, VoiceConversationSelection | null> {
  const map = normalizeVoiceConversationPreferences(settings.conversationSelections);
  // A null entry clears only this companion's legacy global selection. It stores
  // no derived model/voice default; other companions retain their old preference.
  if (selection || settings.conversationSelection)
    Object.defineProperty(map, botId, {
      value: selection,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  else delete map[botId];
  return map;
}
