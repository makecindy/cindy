import type { AudioTrace, ConversationInputEvent } from '@cindy/voice-input-core';
import type { AgentKind } from '@cindy/model-providers';

/** Local Desktop voice UI contract. No credentials, raw paths or remote invoke access. */
export type SpeechProtocol = 'openai' | 'elevenlabs' | 'minimax';
// Missing provider/runtime is the original Cindy AI selection, never another connection.
export type SpeechModelSelection = {
  providerId?: string;
  agent?: AgentKind;
  modelId: string;
  /** Custom endpoints allow overrides; official endpoints always use their own adapter. */
  protocol?: SpeechProtocol;
};
export type VoiceConversationSelection = SpeechModelSelection & { voice: string };
export type SpeechVoice = { id: string; name: string };
export type SpeechVoiceCatalog = {
  voices: SpeechVoice[];
  /** References are model-specific suggestions, not proof a compatible proxy supports them. */
  source: 'provider' | 'reference' | 'manual';
  truncated?: boolean;
};
export type SpeechPreviewStart = VoiceConversationSelection & {
  previewId: string;
  botId: string;
  sessionId: string;
  text: string;
};
export type VoiceConversationModel = {
  id: string;
  name: string;
  providerId?: string;
  providerName?: string;
  agent?: AgentKind;
  protocol?: SpeechProtocol;
  /** The official endpoint fixes protocol; saved overrides cannot select another adapter. */
  protocolLocked?: boolean;
  defaultVoice?: string;
};
export type VoiceConversationPreference = {
  selection: VoiceConversationSelection | null;
  customized: boolean;
  /** Absent on older local bridges; the current default is enabled. */
  sentencePlayback?: boolean;
};
export type SpeechStartResult = { sampleRate: number } | { deferred: true };
export function voiceModelKey(model: {
  providerId?: string;
  agent?: AgentKind;
  modelId?: string;
  id?: string;
}): string {
  return JSON.stringify([model.providerId ?? 'xd', model.agent ?? '', model.modelId ?? model.id]);
}
export type VoiceConversationEvent = {
  callId: string;
  /** Identifies the ASR capture generation; ended events have no input generation. */
  inputGeneration?: number;
  event: ConversationInputEvent | { type: 'ended' };
};
export type VoiceConversationStart = VoiceConversationSelection & {
  callId: string;
  botId: string;
  sessionId: string;
};
export interface VoiceConversationApi {
  models(): Promise<VoiceConversationModel[]>;
  voices(selection: SpeechModelSelection): Promise<SpeechVoiceCatalog>;
  preview(input: SpeechPreviewStart): Promise<{ sampleRate: number }>;
  readPreview(previewId: string): Promise<{ pcm: ArrayBuffer; done: boolean }>;
  stopPreview(previewId: string): Promise<void>;
  preference(botId: string): Promise<VoiceConversationPreference>;
  setPreference(
    botId: string,
    selection: VoiceConversationSelection | null | undefined,
    /** undefined preserves this override; null restores the current default. */
    sentencePlayback?: boolean | null,
  ): Promise<VoiceConversationPreference>;
  start(input: VoiceConversationStart): Promise<{ callId: string }>;
  /** Explicit message read-aloud: the same TTS lease and queue, without ASR or microphone input. */
  startPlayback(input: VoiceConversationStart): Promise<{ callId: string }>;
  audio(input: {
    callId: string;
    pcm: ArrayBuffer;
    inputGeneration?: number;
    trace?: AudioTrace;
  }): void;
  setInputMuted(callId: string, muted: boolean): Promise<{ inputGeneration: number }>;
  finishUtterance(callId: string): Promise<void>;
  end(callId: string): Promise<void>;
  speak(input: {
    callId: string;
    requestId: string;
    text: string;
    /** Main defers unfinished replies while an outgoing reply hook is enabled. */
    streaming?: boolean;
  }): Promise<SpeechStartResult>;
  readSpeech(callId: string, requestId: string): Promise<{ pcm: ArrayBuffer; done: boolean }>;
  interrupt(callId: string): Promise<void>;
  onEvent(callback: (event: VoiceConversationEvent) => void): () => void;
}

export function normalizeVoiceConversationSelection(
  value: unknown,
): VoiceConversationSelection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const route = normalizeSpeechModelSelection(value);
  const voice = normalizeSpeechVoiceId((value as Partial<VoiceConversationSelection>).voice);
  return route && voice ? { ...route, voice } : undefined;
}

/** Voice IDs are opaque provider identifiers; MiniMax IDs include spaces and parentheses. */
export function normalizeSpeechVoiceId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 128) return undefined;
  const voice = value.trim();
  // Retain the path/control-character boundary for manual IDs. URL use also encodes the ID.
  const invalid = [...value].some(
    (char) =>
      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '/' || char === '\\',
  );
  return voice && !invalid ? voice : undefined;
}

export function normalizeSpeechModelSelection(value: unknown): SpeechModelSelection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { modelId, providerId, agent, protocol } = value as Partial<SpeechModelSelection>;
  if (
    typeof modelId !== 'string' ||
    !modelId.trim() ||
    modelId.length > 256 ||
    (providerId !== undefined &&
      (typeof providerId !== 'string' || !providerId.trim() || providerId.length > 256)) ||
    (protocol !== undefined && !['openai', 'elevenlabs', 'minimax'].includes(protocol)) ||
    ((providerId === undefined || providerId === 'xd') &&
      protocol !== undefined &&
      protocol !== 'openai') ||
    (agent !== undefined && !['claude-code', 'codex', 'pi'].includes(agent)) ||
    (providerId !== undefined && providerId !== 'xd' && !agent) ||
    ((providerId === undefined || providerId === 'xd') && agent !== undefined)
  )
    return undefined;
  return {
    modelId: modelId.trim(),
    ...(providerId ? { providerId } : {}),
    ...(agent ? { agent } : {}),
    ...(protocol ? { protocol } : {}),
  };
}

export function normalizeVoiceConversationPreferences(
  value: unknown,
): Record<string, VoiceConversationSelection | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, raw]) => {
      const selection = raw === null ? null : normalizeVoiceConversationSelection(raw);
      return id.trim() && id.length <= 256 && selection !== undefined ? [[id, selection]] : [];
    }),
  );
}

/** Only explicit per-companion choices are stored, never copies of the default. */
export function normalizeSentencePlaybackOverrides(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([id, enabled]) => id.trim() && id.length <= 256 && typeof enabled === 'boolean',
    ),
  ) as Record<string, boolean>;
}
