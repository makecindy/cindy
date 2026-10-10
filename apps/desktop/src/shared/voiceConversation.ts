import type { AudioTrace, ConversationInputEvent } from '@cindy/voice-input-core';

/** Local Desktop voice UI contract. No credentials, raw paths or remote invoke access. */
export type VoiceConversationSelection = { modelId: string; voice: string };
export type VoiceConversationModel = { id: string; name: string };
export type VoiceConversationEvent = {
  callId: string;
  event: ConversationInputEvent | { type: 'ended' };
};
export type VoiceConversationStart = VoiceConversationSelection & {
  callId: string;
  botId: string;
  sessionId: string;
};
export interface VoiceConversationApi {
  models(): Promise<VoiceConversationModel[]>;
  start(input: VoiceConversationStart): Promise<{ callId: string }>;
  audio(input: { callId: string; pcm: ArrayBuffer; trace?: AudioTrace }): void;
  finishUtterance(callId: string): Promise<void>;
  end(callId: string): Promise<void>;
  speak(input: {
    callId: string;
    requestId: string;
    text: string;
  }): Promise<{ sampleRate: number }>;
  readSpeech(callId: string, requestId: string): Promise<{ pcm: ArrayBuffer; done: boolean }>;
  interrupt(callId: string): Promise<void>;
  onEvent(callback: (event: VoiceConversationEvent) => void): () => void;
}

export function normalizeVoiceConversationSelection(
  value: unknown,
): VoiceConversationSelection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { modelId, voice } = value as Partial<VoiceConversationSelection>;
  if (
    typeof modelId !== 'string' ||
    !modelId.trim() ||
    modelId.length > 256 ||
    typeof voice !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(voice)
  )
    return undefined;
  return { modelId: modelId.trim(), voice };
}
