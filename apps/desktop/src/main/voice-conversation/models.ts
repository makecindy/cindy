import { BUNDLED_CATALOG, resolveModelNativeApi, type Catalog } from '@cindy/model-providers';
import type { VoiceConversationModel } from '../../shared/voiceConversation.js';

/** Registry metadata explains the protocol; only the account catalog grants access. */
export function speechModels(
  catalog: Catalog,
  gatewayAllowed: boolean,
  disabled: (modelId: string) => boolean,
): VoiceConversationModel[] {
  if (!gatewayAllowed) return [];
  return (catalog.providers.find((provider) => provider.id === 'xd')?.audioModels ?? [])
    .filter((model) => {
      if (
        model.mode !== 'audio_speech' ||
        model.availability !== 'available' ||
        model.disabled ||
        disabled(model.id)
      )
        return false;
      const declared =
        model.nativeApi !== undefined
          ? model.nativeApi
          : resolveModelNativeApi(catalog.modelRegistry, 'xd', model.id);
      const protocol =
        declared !== undefined
          ? declared
          : resolveModelNativeApi(BUNDLED_CATALOG.modelRegistry, 'xd', model.id);
      // Unknown Gateway entries use its OpenAI speech contract. Explicitly unverified
      // (null) or another native API must not be silently treated as that protocol.
      return protocol === undefined || protocol === 'openai-audio-speech';
    })
    .map((model) => ({ id: model.id, name: model.name }));
}
