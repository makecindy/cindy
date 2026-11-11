import { mountPage, forbid } from '../../ui-page/harness';
import { CompanionVoiceSettings } from '../../../src/renderer/features/bots/voice/CompanionVoiceSettings';
import { alibabaSystemVoices } from '../../../src/shared/alibabaSpeechVoices';
import { gatewayReferenceSpeechVoices } from '../../../src/shared/speechVoices';
import type {
  SpeechProtocol,
  SpeechModelSelection,
  VoiceConversationPreference,
  VoiceConversationSelection,
} from '../../../src/shared/voiceConversation';

// The UI harness's custom origin lacks secure-context randomUUID. IDs below are
// fixture-only correlation tokens; the real app keeps its native crypto API.
if (!crypto.randomUUID) {
  let sequence = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
}

mountPage({
  host: (ctx) => {
    const protocol = (ctx.data.protocol ?? 'elevenlabs') as SpeechProtocol;
    const modelId = String(ctx.data.modelId ?? 'eleven_flash_v2_5');
    const gatewayVoices = ctx.data.gatewayReference ? gatewayReferenceSpeechVoices(modelId) : [];
    const providerId = ctx.data.gatewayReference ? 'xd' : 'fixture';
    const agent = ctx.data.gatewayReference ? undefined : ('codex' as const);
    const referenceVoice = String(ctx.data.voiceId ?? gatewayVoices[0]?.id ?? 'river');
    const initialVoice = ctx.data.manual ? 'custom-voice' : referenceVoice;
    const systemVoices = alibabaSystemVoices(modelId, protocol);
    ctx.data.gatewayVoices = gatewayVoices;
    ctx.data.voiceId = ctx.data.voiceId ?? (ctx.data.gatewayReference ? referenceVoice : undefined);
    ctx.data.voiceLabel = ctx.data.gatewayReference
      ? gatewayVoices.find((voice) => voice.id === referenceVoice)?.name
      : ctx.data.systemCatalog
        ? systemVoices.find((voice) => voice.id === referenceVoice)?.name
        : undefined;
    const pending = new Map<string, () => void>();
    const previews: Array<{ voice: string; speed?: number; previewId: string }> = [];
    const stops: string[] = [];
    ctx.data.previewRequests = previews;
    ctx.data.previewStops = stops;
    ctx.data.savedVoice = initialVoice;
    ctx.data.saveCount = 0;
    let preference: VoiceConversationPreference = {
      selection: {
        providerId,
        agent,
        modelId,
        voice: initialVoice,
        ...(ctx.data.custom ? { protocol } : {}),
        ...(typeof ctx.data.speed === 'number' ? { speed: ctx.data.speed } : {}),
      },
      customized: ctx.data.speed !== undefined || !!ctx.data.manual,
      sentencePlayback: true,
    };
    if (ctx.data.noPreference) preference.selection = null;
    return {
      onAuthStateChange: () => () => {},
      voiceInput: { onPowerStateChange: () => () => {} },
      maker: { refreshBuiltinProviderModels: async () => {} },
      voiceConversation: {
        models: async () =>
          ctx.data.empty
            ? []
            : [
                {
                  id: modelId,
                  ...(ctx.data.hidden ? { pickerVisible: false } : {}),
                  name: modelId,
                  providerId,
                  providerName: ctx.data.openRouter ? 'OpenRouter' : ctx.data.gatewayReference
                    ? 'XD Gateway'
                    : protocol === 'elevenlabs'
                      ? 'ElevenLabs'
                      : protocol === 'minimax'
                        ? 'MiniMax'
                        : protocol === 'qwen-tts' || protocol === 'dashscope-tts'
                          ? 'Alibaba Cloud'
                          : 'OpenAI',
                  agent,
                  protocol: ctx.data.custom ? undefined : protocol,
                  protocolLocked: !ctx.data.custom,
                  defaultVoice: ctx.data.openRouter ? '' : referenceVoice,
                  ...(ctx.data.openRouter ? { speedRange: null } : {}),
                },
                ...(ctx.data.autoVoice ? [{
                  id: String(ctx.data.nextModelId),
                  name: String(ctx.data.nextModelId),
                  providerId,
                  providerName: ctx.data.openRouter ? 'OpenRouter' : 'MiniMax',
                  agent,
                  protocol,
                  protocolLocked: true,
                  defaultVoice: '',
                  ...(ctx.data.openRouter ? { speedRange: null } : {}),
                }] : []),
                ...(ctx.data.hidden ? [{ id: 'unchecked', name: 'Unchecked speech', providerId: 'fixture', agent: 'codex' as const, pickerVisible: false }] : []),
                ...(ctx.data.hidden && !ctx.data.noPreference ? [{ id: 'visible', name: 'Visible speech', providerId: 'fixture', agent: 'codex' as const, protocol, protocolLocked: true, defaultVoice: 'river' }] : []),
              ],
        voices: async (route: SpeechModelSelection) =>
          ctx.data.autoVoice && route.modelId === ctx.data.nextModelId
            ? { source: 'provider', voices: ctx.data.nextVoices }
            : ctx.data.openRouter
            ? { source: 'provider', voices: ['sarah', 'george'].map(id => ({ id, name: id })) }
            : ctx.data.gatewayReference
            ? { source: 'reference', voices: gatewayVoices.map((voice) => ({ ...voice })) }
            : ctx.data.systemCatalog
              ? {
                  source: ctx.data.customCatalog ? 'mixed' : 'reference',
                  ...(ctx.data.customCatalogFailure ? { customVoicesUnavailable: true } : {}),
                  voices: [
                    ...systemVoices,
                    ...(ctx.data.customCatalog
                      ? [{ id: 'account-clone', name: 'My Custom Voice' }]
                      : []),
                  ],
                }
              : {
                  source: ctx.data.voiceId ? 'reference' : 'provider',
                  voices: [
                    {
                      id: referenceVoice,
                      name: ctx.data.voiceId
                        ? referenceVoice
                        : 'River — Relaxed, Neutral, Informative',
                    },
                    ...(ctx.data.menu
                      ? [
                          { id: 'bella', name: 'Bella — Professional, Bright, Warm' },
                          { id: 'sarah', name: 'Sarah — Mature, Reassuring, Confident' },
                          { id: 'roger', name: 'Roger — Laid-Back, Casual, Resonant' },
                          { id: 'laura', name: 'Laura — Enthusiast, Quirky Attitude' },
                          { id: 'charlie', name: 'Charlie — Deep, Confident, Energetic' },
                          { id: 'george', name: 'George — Warm, Captivating Storyteller' },
                          { id: 'callum', name: 'Callum — Husky, Trickster' },
                        ]
                      : []),
                  ],
                },
        preference: async () => preference,
        setPreference: async (
          _botId: string,
          selection: VoiceConversationSelection | null | undefined,
          sentencePlayback?: boolean | null,
        ) => {
          preference = {
            selection: selection === undefined ? preference.selection : selection,
            customized: selection !== null || sentencePlayback != null,
            sentencePlayback:
              sentencePlayback === undefined
                ? preference.sentencePlayback
                : (sentencePlayback ?? true),
          };
          ctx.data.savedVoice = preference.selection?.voice;
          ctx.data.savedModelId = preference.selection?.modelId;
          ctx.data.saveCount = Number(ctx.data.saveCount) + 1;
          return preference;
        },
        // Controlled synthesis boundary: never contacts a provider or emits audio.
        stopPreview: async (id: string) => {
          stops.push(id);
          pending.get(id)?.();
          pending.delete(id);
        },
        preview: async (input: { voice: string; speed?: number; previewId: string }) => {
          previews.push(input);
          if (ctx.data.previewTimeout) throw new Error('[VOICE_SPEECH_TIMEOUT] Speech timed out');
          if (ctx.data.previewFailure) throw new Error('fixture preview unavailable');
          await new Promise<void>((resolve) => pending.set(input.previewId, resolve));
          return { sampleRate: 24000 };
        },
        readPreview: async () => ({ pcm: new ArrayBuffer(0), done: true }),
        start: forbid('microphone capture'),
      },
    };
  },
  render: () => (
    <main className="mx-auto min-h-screen max-w-[460px] p-5">
      <CompanionVoiceSettings
        botId="fixture-bot"
        sessionId="fixture-session"
        onOpenProviders={() => {}}
      />
    </main>
  ),
});
