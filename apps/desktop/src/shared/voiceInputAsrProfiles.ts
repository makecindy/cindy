export type VoiceInputRealtimeProtocolProfile =
  | 'openai-transcription-manual'
  | 'qwen-asr-server-vad';

export type VoiceInputNativeProtocolProfile = 'volcengine-sauc-duration';

export type VoiceInputAsrAuthKind = 'api-key' | 'codex';

export type VoiceInputAsrSettingsTab = 'api-keys' | 'connections' | 'providers';

export type VoiceInputAsrMode =
  | 'elevenlabs-realtime'
  | 'realtime-websocket'
  | 'provider-native-websocket'
  | 'batch-http';

export type VoiceInputAsrPricing =
  | { unit: 'audio-second'; usd: number }
  | { unit: 'audio-minute'; usd: number };

export type VoiceInputRealtimeConfig = {
  endpointPath?: string;
  litellmHeaderModel?: string;
  pcmSampleRate: number;
  protocolProfile: VoiceInputRealtimeProtocolProfile;
  prewarmable: boolean;
};

export type VoiceInputNativeWebSocketConfig = {
  endpointPath: string;
  pcmSampleRate: number;
  protocolProfile: VoiceInputNativeProtocolProfile;
  resourceId: string;
  prewarmable: boolean;
};

export type VoiceInputAsrProfile = {
  id: string;
  model: string;
  auth: VoiceInputAsrAuthKind;
  settingsTab: VoiceInputAsrSettingsTab;
  mode: VoiceInputAsrMode;
  realtime?: VoiceInputRealtimeConfig;
  nativeWebSocket?: VoiceInputNativeWebSocketConfig;
  pricing?: VoiceInputAsrPricing;
  missingCredentialMessage: string;
  errorFallbackMessage: string;
};

export const SCRIBE_REALTIME_MODEL = 'scribe_v2_realtime';
export const OPENAI_REALTIME_TRANSCRIPTION_MODEL = 'gpt-realtime-whisper';
export const LITELLM_REALTIME_TRANSCRIPTION_MODEL = 'gpt-realtime-whisper';
export const LITELLM_REALTIME_TRANSCRIPTION_PATH = '/openai/passthrough/v1/realtime?intent=transcription';
export const LITELLM_QWEN3_REALTIME_TRANSCRIPTION_MODEL = 'qwen3-asr-flash-realtime';
export const LITELLM_QWEN3_REALTIME_TRANSCRIPTION_PATH =
  `/dashscope/api-ws/v1/realtime?model=${encodeURIComponent(LITELLM_QWEN3_REALTIME_TRANSCRIPTION_MODEL)}`;
export const LITELLM_QWEN3_REALTIME_PCM_SAMPLE_RATE = 16_000;
// Volcengine SAUC ASR is exposed as a provider-native websocket passthrough.
// It does not have a /v1/models model id; routing is by endpoint path +
// X-Api-Resource-Id. Keep the display model descriptive but do not send it as
// a model parameter.
export const LITELLM_VOLCENGINE_SAUC_ASR_DISPLAY_MODEL = 'volcengine-sauc-asr';
export const LITELLM_VOLCENGINE_SAUC_ASR_ENDPOINT_PATH = '/volcengine/api/v3/sauc/bigmodel_async';
export const LITELLM_VOLCENGINE_SAUC_ASR_RESOURCE_ID = 'volc.seedasr.sauc.duration';
export const LITELLM_VOLCENGINE_SAUC_ASR_PCM_SAMPLE_RATE = 16_000;
export const LITELLM_TRANSCRIPTION_MODEL = 'elevenlabs/scribe_v2';
export const CUSTOM_REALTIME_ASR_DISPLAY_MODEL = 'Custom realtime ASR';

export const DEFAULT_VOICE_INPUT_PROVIDER_KIND = 'litellm-volcengine-sauc-asr';

// Default ASR fallback chain, highest priority first. Only LiteLLM-backed
// providers are listed: they share the same XD Gateway credential, so a chain
// hop never needs a credential the user has not already configured. Providers
// that need separate credentials (ElevenLabs direct, OpenAI Codex realtime) stay
// out of the default chain — users can still put them into a custom chain via
// voice-input-models.json / XDT_VOICE_INPUT_ASR_PROVIDER_CHAIN.
export const DEFAULT_VOICE_INPUT_ASR_PROVIDER_CHAIN = [
  'litellm-volcengine-sauc-asr',
  'litellm-qwen3-asr-flash-realtime',
  'litellm-gpt-realtime-whisper',
] as const;

// ASR provider registry shared by main/preload/renderer. Future realtime ASR
// models should be added here first: endpoint/auth/sample-rate/pricing belong
// to the profile. Only add provider code when the upstream WebSocket protocol
// is not covered by an existing `protocolProfile`.
export const VOICE_INPUT_ASR_PROFILES = {
  'custom-realtime-asr': {
    id: 'custom-realtime-asr',
    model: CUSTOM_REALTIME_ASR_DISPLAY_MODEL,
    auth: 'api-key',
    settingsTab: 'providers',
    mode: 'realtime-websocket',
    realtime: {
      pcmSampleRate: 24_000,
      protocolProfile: 'openai-transcription-manual',
      prewarmable: true,
    },
    missingCredentialMessage: 'Configure the realtime ASR WebSocket URL, model, protocol, and API key.',
    errorFallbackMessage: 'Custom realtime speech recognition failed.',
  },
  'elevenlabs-scribe-realtime': {
    id: 'elevenlabs-scribe-realtime',
    model: SCRIBE_REALTIME_MODEL,
    auth: 'api-key',
    // 「工具密钥」页 2026-07-13 下架(最后一把 mivo key 随意识化迁走),
    // 直连 key 的配置引导落到模型供应商页。
    settingsTab: 'providers',
    mode: 'elevenlabs-realtime',
    missingCredentialMessage: 'API key is required for ElevenLabs Scribe realtime voice input.',
    errorFallbackMessage: 'ElevenLabs Scribe realtime transcription failed.',
  },
  // Kept as an explicit fallback for future experiments. It is not the
  // default today because the Codex OAuth realtime route cannot reliably drive
  // gpt-realtime-whisper in this app, while XD LiteLLM exposes working
  // realtime ASR through provider-specific passthrough endpoints.
  'openai-realtime-whisper': {
    id: 'openai-realtime-whisper',
    model: OPENAI_REALTIME_TRANSCRIPTION_MODEL,
    auth: 'codex',
    settingsTab: 'providers',
    mode: 'realtime-websocket',
    realtime: {
      pcmSampleRate: 24_000,
      protocolProfile: 'openai-transcription-manual',
      prewarmable: true,
    },
    pricing: { unit: 'audio-minute', usd: 0.017 },
    missingCredentialMessage: 'Codex ChatGPT login is required for OpenAI realtime voice input.',
    errorFallbackMessage: 'OpenAI realtime transcription failed.',
  },
  'litellm-gpt-realtime-whisper': {
    id: 'litellm-gpt-realtime-whisper',
    model: LITELLM_REALTIME_TRANSCRIPTION_MODEL,
    auth: 'api-key',
    settingsTab: 'providers',
    mode: 'realtime-websocket',
    realtime: {
      endpointPath: LITELLM_REALTIME_TRANSCRIPTION_PATH,
      litellmHeaderModel: LITELLM_REALTIME_TRANSCRIPTION_MODEL,
      pcmSampleRate: 24_000,
      protocolProfile: 'openai-transcription-manual',
      prewarmable: true,
    },
    pricing: { unit: 'audio-minute', usd: 0.017 },
    missingCredentialMessage: 'API key is required for LiteLLM realtime voice input.',
    errorFallbackMessage: 'XD LiteLLM realtime transcription failed.',
  },
  'litellm-qwen3-asr-flash-realtime': {
    id: 'litellm-qwen3-asr-flash-realtime',
    model: LITELLM_QWEN3_REALTIME_TRANSCRIPTION_MODEL,
    auth: 'api-key',
    settingsTab: 'providers',
    mode: 'realtime-websocket',
    realtime: {
      endpointPath: LITELLM_QWEN3_REALTIME_TRANSCRIPTION_PATH,
      pcmSampleRate: LITELLM_QWEN3_REALTIME_PCM_SAMPLE_RATE,
      protocolProfile: 'qwen-asr-server-vad',
      prewarmable: true,
    },
    pricing: { unit: 'audio-second', usd: 0.00009 },
    missingCredentialMessage: 'API key is required for LiteLLM realtime voice input.',
    errorFallbackMessage: 'XD LiteLLM realtime transcription failed.',
  },
  'litellm-volcengine-sauc-asr': {
    id: 'litellm-volcengine-sauc-asr',
    model: LITELLM_VOLCENGINE_SAUC_ASR_DISPLAY_MODEL,
    auth: 'api-key',
    settingsTab: 'providers',
    mode: 'provider-native-websocket',
    nativeWebSocket: {
      endpointPath: LITELLM_VOLCENGINE_SAUC_ASR_ENDPOINT_PATH,
      pcmSampleRate: LITELLM_VOLCENGINE_SAUC_ASR_PCM_SAMPLE_RATE,
      protocolProfile: 'volcengine-sauc-duration',
      resourceId: LITELLM_VOLCENGINE_SAUC_ASR_RESOURCE_ID,
      prewarmable: false,
    },
    missingCredentialMessage: 'API key is required for LiteLLM Volcengine ASR voice input.',
    errorFallbackMessage: 'XD LiteLLM Volcengine SAUC transcription failed.',
  },
  'litellm-batch': {
    id: 'litellm-batch',
    model: LITELLM_TRANSCRIPTION_MODEL,
    auth: 'api-key',
    settingsTab: 'providers',
    mode: 'batch-http',
    missingCredentialMessage: 'API key is required for LiteLLM voice input.',
    errorFallbackMessage: 'XD LiteLLM batch transcription failed.',
  },
} as const satisfies Record<string, VoiceInputAsrProfile>;

export type VoiceInputProviderKind = keyof typeof VOICE_INPUT_ASR_PROFILES;

export function getVoiceInputAsrProfile(provider: VoiceInputProviderKind): VoiceInputAsrProfile {
  return VOICE_INPUT_ASR_PROFILES[provider];
}

export function getVoiceInputAsrProfiles(): VoiceInputAsrProfile[] {
  return Object.values(VOICE_INPUT_ASR_PROFILES);
}

export function voiceInputProviderModel(provider: VoiceInputProviderKind): string {
  return getVoiceInputAsrProfile(provider).model;
}

export function isRealtimeAsrProvider(provider: VoiceInputProviderKind): boolean {
  const mode = getVoiceInputAsrProfile(provider).mode;
  return mode === 'realtime-websocket' || mode === 'provider-native-websocket';
}

export function isLiteLlmProvider(provider: VoiceInputProviderKind): boolean {
  return provider.startsWith('litellm-');
}

export function isVoiceInputProviderKind(value: string): value is VoiceInputProviderKind {
  return value in VOICE_INPUT_ASR_PROFILES;
}

const VOICE_INPUT_PROVIDER_ALIASES: Record<string, VoiceInputProviderKind> = {
  '': DEFAULT_VOICE_INPUT_PROVIDER_KIND,
  xd: DEFAULT_VOICE_INPUT_PROVIDER_KIND,
  'xd-litellm': DEFAULT_VOICE_INPUT_PROVIDER_KIND,
  'xd-litellm-realtime': DEFAULT_VOICE_INPUT_PROVIDER_KIND,
  litellm: DEFAULT_VOICE_INPUT_PROVIDER_KIND,
  'litellm-realtime': DEFAULT_VOICE_INPUT_PROVIDER_KIND,
  'gpt-realtime-whisper': 'litellm-gpt-realtime-whisper',
  'litellm-gpt-realtime-whisper': 'litellm-gpt-realtime-whisper',
  'qwen3-asr-flash-realtime': 'litellm-qwen3-asr-flash-realtime',
  'litellm-qwen3-asr-flash-realtime': 'litellm-qwen3-asr-flash-realtime',
  'litellm-volcengine-sauc-asr': 'litellm-volcengine-sauc-asr',
  openai: 'openai-realtime-whisper',
  'openai-realtime': 'openai-realtime-whisper',
  'openai-realtime-whisper': 'openai-realtime-whisper',
  'openai-direct': 'openai-realtime-whisper',
  'codex-realtime': 'openai-realtime-whisper',
  'litellm-batch': 'litellm-batch',
  batch: 'litellm-batch',
  elevenlabs: 'elevenlabs-scribe-realtime',
  scribe: 'elevenlabs-scribe-realtime',
  'scribe-realtime': 'elevenlabs-scribe-realtime',
  scribe_v2_realtime: 'elevenlabs-scribe-realtime',
  'elevenlabs-scribe-realtime': 'elevenlabs-scribe-realtime',
  custom: 'custom-realtime-asr',
  'custom-realtime': 'custom-realtime-asr',
  'custom-realtime-asr': 'custom-realtime-asr',
};

export function resolveVoiceInputProviderKindAlias(value: string): VoiceInputProviderKind | null {
  const normalized = value.trim().toLowerCase();
  return VOICE_INPUT_PROVIDER_ALIASES[normalized] ?? (isVoiceInputProviderKind(normalized) ? normalized : null);
}

export function estimateVoiceInputAsrCostUsd(provider: VoiceInputProviderKind, audioMs: number): number {
  if (!Number.isFinite(audioMs) || audioMs <= 0) return 0;
  const pricing = getVoiceInputAsrProfile(provider).pricing;
  if (!pricing) return 0;
  if (pricing.unit === 'audio-second') return (audioMs / 1000) * pricing.usd;
  return (audioMs / 60_000) * pricing.usd;
}
