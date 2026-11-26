import type { AgentKind } from '@cindy/model-providers';
import { alibabaSystemVoices } from './alibabaSpeechVoices.js';
import { normalizeSpeechVoiceId, type SpeechVoice } from './voiceConversation.js';

export const REALTIME_PROTOCOLS = ['openai-realtime', 'qwen-audio-realtime'] as const;
export type RealtimeProtocol = (typeof REALTIME_PROTOCOLS)[number];
export type RealtimeVoiceSelection = {
  mode: 'realtime';
  providerId: string;
  agent: AgentKind;
  modelId: string;
  voice: string;
  protocol: RealtimeProtocol;
};
export type RealtimeVoiceModel = {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  agent: AgentKind;
  protocol?: RealtimeProtocol;
  protocolLocked: boolean;
  pickerVisible?: boolean;
  systemVoices?: SpeechVoice[];
  hasCustomVoiceCatalog?: boolean;
};
export type RealtimePlaybackPosition = { itemId: string; playedMs: number };
export type RealtimeVoiceEvent =
  | { type: 'realtime-audio'; itemId: string }
  | { type: 'realtime-interrupt'; throughResponse: number }
  | { type: 'realtime-thinking' }
  | { type: 'realtime-input-start'; itemId: string }
  | { type: 'realtime-utterance'; itemId: string; text: string; question: boolean };

export function normalizeRealtimeVoiceSelection(
  value: unknown,
): RealtimeVoiceSelection | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Partial<RealtimeVoiceSelection>;
  const bounded = (s: unknown): s is string =>
    typeof s === 'string' && !!s.trim() && s.length <= 256;
  const voice = normalizeSpeechVoiceId(v.voice);
  if (
    v.mode !== 'realtime' ||
    !bounded(v.providerId) ||
    v.providerId === 'xd' ||
    !bounded(v.modelId) ||
    !voice ||
    !['codex', 'claude-code', 'pi'].includes(v.agent ?? '') ||
    !REALTIME_PROTOCOLS.includes(v.protocol!)
  )
    return;
  return {
    mode: 'realtime',
    providerId: v.providerId,
    agent: v.agent!,
    modelId: v.modelId.trim(),
    voice,
    protocol: v.protocol!,
  };
}

export function normalizeRealtimeVoicePreferences(
  value: unknown,
): Record<string, RealtimeVoiceSelection> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, raw]) => {
      const selection = normalizeRealtimeVoiceSelection(raw);
      return id.trim() && id.length <= 256 && selection ? [[id, selection]] : [];
    }),
  );
}

/** Public presets only. Both 3.1 realtime models accept the union of 3.1 Plus
 * and Flash TTS voices (the Flash catalog includes the four Plus voices).
 * https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides
 */
export function realtimeSystemVoices(protocol: RealtimeProtocol, modelId: string, baseUrl?: string): SpeechVoice[] {
  if (protocol === 'openai-realtime') {
    return ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']
      .map(id => ({ id, name: id }));
  }
  if (!isQwenRealtimeModel(modelId)) return [];
  if (modelId.startsWith('qwen-audio-3.1-')) {
    return [
      { id: 'longanqian_v3.1', name: 'longanqian_v3.1' },
      ...alibabaSystemVoices('qwen-audio-3.1-tts-flash', 'dashscope-tts', baseUrl),
    ];
  }
  return ['longanqian', 'longanlingxin', 'longanlingxi', 'longanxiaoxin', 'longanlufeng']
    .map(id => ({ id, name: id }));
}

export function isQwenRealtimeModel(id: string): boolean {
  return /^qwen-audio-3\.[01]-realtime-(plus|flash)$/.test(id);
}

/** An official route fixes the protocol. The Token Plan scope is independent. */
export function officialRealtimeProtocol(base: URL, modelId: string): RealtimeProtocol | undefined {
  if (base.protocol !== 'https:' || base.port) return;
  if (base.hostname === 'api.openai.com') {
    // The dedicated translation and transcription services use different sessions.
    const conversational = /^gpt-realtime(?:-(?:mini|\d+(?:\.\d+)*(?:-mini)?))?(?:-\d{4}-\d{2}-\d{2})?$/
      .test(modelId) || /^gpt-4o(?:-mini)?-realtime-preview(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId);
    return conversational ? 'openai-realtime' : undefined;
  }
  if (!isQwenRealtimeModel(modelId)) return;
  if (base.hostname === 'token-plan.cn-beijing.maas.aliyuncs.com')
    return modelId === 'qwen-audio-3.0-realtime-plus' ? 'qwen-audio-realtime' : undefined;
  if (
    ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(base.hostname) ||
    /^(?!token-plan\.)[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(
      base.hostname,
    )
  )
    return 'qwen-audio-realtime';
}
