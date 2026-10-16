import {
  normalizeVoiceConversationSelection,
  voiceModelKey,
  type VoiceConversationModel,
  type VoiceConversationSelection,
} from '@/../shared/voiceConversation';

/** Settings and call startup must resolve the same route without saving inferred defaults. */
export function resolveVoiceConfiguration(
  models: readonly VoiceConversationModel[],
  preference: VoiceConversationSelection | null,
  voice?: string,
) {
  const selectedModel = preference
    ? models.find((model) => voiceModelKey(model) === voiceModelKey(preference))
    : models[0];
  const protocolOverride = selectedModel?.protocolLocked ? undefined : preference?.protocol;
  const incompatibleSavedProtocol = Boolean(
    selectedModel?.protocolLocked &&
    preference?.protocol !== undefined &&
    preference.protocol !== selectedModel.protocol,
  );
  // Voices do not transfer between adapters. Preserve the stored choice until
  // the user corrects it, but never start a call with a mismatched voice.
  const selectedVoice =
    voice ??
    (incompatibleSavedProtocol ? '' : (preference?.voice ?? selectedModel?.defaultVoice ?? ''));
  const protocol =
    protocolOverride ??
    selectedModel?.protocol ??
    ((selectedModel?.providerId ?? 'xd') === 'xd' ? 'openai' : undefined);
  const selection = selectedModel
    ? normalizeVoiceConversationSelection({
        providerId: selectedModel.providerId,
        agent: selectedModel.agent,
        modelId: selectedModel.id,
        protocol: protocolOverride,
        voice: selectedVoice,
      })
    : null;
  return {
    selectedModel,
    protocolOverride,
    incompatibleSavedProtocol,
    selectedVoice,
    protocol,
    selection,
  };
}
