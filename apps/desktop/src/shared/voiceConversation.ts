import type { VoiceCallRecord } from '@cindy/maker-core';
export type { VoiceCallRecord } from '@cindy/maker-core';
import type { AudioTrace, ConversationInputEvent } from '@cindy/voice-input-core';
import type { AgentKind } from '@cindy/model-providers';
import type { AgentRequestReceipt } from './forwardedRequest.js';

/** Display-only recognition of the existing host-generated dispatch id and
 * protected source receipt. Never use this marker as permission or acceptance.
 * It works even when the call card is outside the current history page. */
export function isVoiceCallTaskMessage(
  clientId: string,
  sessionId: string,
  text: string,
  receipt: unknown,
): boolean {
  if (!receipt || typeof receipt !== 'object') return false;
  const candidate = receipt as Partial<AgentRequestReceipt>;
  const source = candidate.kind === 'agent-request' ? candidate.request : undefined;
  if (typeof source?.clientId !== 'string' || !source.clientId
    || source.sessionId !== sessionId || source.userText !== text) return false;
  const prefix = 'voice-task:';
  const suffix = `:${source.clientId}`;
  return clientId.startsWith(prefix) && clientId.endsWith(suffix)
    && clientId.length > prefix.length + suffix.length;
}

/** Persisted metadata can come from an older or incomplete history projection. */
export function readVoiceCallRecord(value: unknown): VoiceCallRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<VoiceCallRecord>;
  if (record.version !== 1 || typeof record.callId !== 'string'
    || !Number.isFinite(record.startedAt)
    || (record.endedAt !== undefined && !Number.isFinite(record.endedAt))
    || !Array.isArray(record.turns) || record.turns.length > 2_000
    || !Array.isArray(record.handoffs) || record.handoffs.length > 2_000) return null;
  if (!record.turns.every(turn => turn && typeof turn.id === 'string'
    && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.text === 'string'
    && Number.isFinite(turn.createdAt) && typeof turn.complete === 'boolean')) return null;
  if (!record.handoffs.every(task => task && typeof task.id === 'string'
    && typeof task.inputId === 'string' && typeof task.text === 'string'
    && ['sending', 'accepted', 'failed', 'completed'].includes(task.state))) return null;
  return record as VoiceCallRecord;
}

/** Presentation frame of the one live call, published by the main window's call host. */
export type VoiceCallSnapshot = {
  callRecord?: VoiceCallRecord;
  phase:
    | 'idle'
    | 'connecting'
    | 'microphone'
    | 'listening'
    | 'thinking'
    | 'preparing'
    | 'speaking'
    | 'paused'
    | 'error';
  transcript: string;
  unsent: string;
  /** Partial question answers must never be concatenated into ordinary chat. */
  questionDraft?: string;
  level: number;
  error: 'connection' | 'busy' | 'microphone' | 'send' | 'speech' | 'speechTimeout' | null;
  muted: boolean;
  microphonePending: boolean;
  microphoneError: boolean;
  /** "Recognize my voice" just muted someone else; cleared shortly after. */
  speakerFiltered: boolean;
  exitCountdown: {
    reason: 'idle' | 'farewell' | 'semantic';
    secondsRemaining: number;
    waitingForSend?: boolean;
  } | null;
};
export type VoiceCallBot = {
  id: string;
  name: string;
  templateId?: string;
  avatar?: string | null;
  avatarColor?: string | null;
};
/** A call is owned by the app, not by a task page: every window renders this same state. */
export type VoiceCallStatus = {
  /** False only during the exit transition, before the status is cleared. */
  open: boolean;
  bot: VoiceCallBot;
  sessionId: string;
  callId: string | null;
  state: VoiceCallSnapshot;
  loading: boolean;
  blocked: boolean;
  configurationError: boolean;
  questionPending: boolean;
  /** The task asks a question, but its card is not on screen in the host window. */
  questionElsewhere: boolean;
};
/** Level-only updates keep PCM-rate meters from cloning the call record over IPC. */
export type VoiceCallStatusUpdate = { status: VoiceCallStatus | null } | { level: number };
export type VoiceCallCommand =
  | { type: 'start'; bot: VoiceCallBot; sessionId: string }
  | {
      type: 'end' | 'mute' | 'interrupt' | 'send' | 'cancel-exit' | 'resume';
      sessionId: string;
    };

/** Call-local exit decision, observed alongside normal message dispatch.
 * true offers a cancellable countdown after acceptance; submit_then_exit closes
 * immediately after acceptance. Neither result retracts or resends the message.
 * Keep boolean outcomes for local bridge/test compatibility. */
export type VoiceExitDecision = boolean | 'submit_then_exit';

export { speechSpeedRange, isSpeechSpeedSupported, resolveSpeechSpeed } from './speechProtocols.js';
export type { SpeechProtocol } from './speechProtocols.js';
import { SPEECH_PROTOCOLS, type SpeechProtocol, type SpeechSpeedRange } from './speechProtocols.js';

// Missing provider/runtime is the original Cindy AI selection, never another connection.
export type SpeechModelSelection = {
  providerId?: string;
  agent?: AgentKind;
  modelId: string;
  /** Custom endpoints allow overrides; official endpoints always use their own adapter. */
  protocol?: SpeechProtocol;
};
export type VoiceConversationSelection = SpeechModelSelection & {
  voice: string;
  /** Explicit per-companion synthesis speed. Absent keeps the provider default (1×). */
  speed?: number;
};
export type SpeechVoice = { id: string; name: string };
export type SpeechVoiceCatalog = {
  voices: SpeechVoice[];
  /** References are model-specific suggestions, not proof a compatible proxy supports them. */
  source: 'provider' | 'reference' | 'mixed' | 'manual';
  truncated?: boolean;
  /** Public references and verified entries remain usable after a partial private lookup. */
  customVoicesUnavailable?: boolean;
};
export type SpeechPreviewStart = VoiceConversationSelection & {
  previewId: string;
  botId: string;
  sessionId: string;
  text: string;
};
export type VoiceConversationModel = {
  /** Display preference only; hidden routes remain available for saved selections. */
  pickerVisible?: boolean;
  id: string;
  name: string;
  providerId?: string;
  providerName?: string;
  agent?: AgentKind;
  protocol?: SpeechProtocol;
  /** The official endpoint fixes protocol; saved overrides cannot select another adapter. */
  protocolLocked?: boolean;
  /** Host-owned route capability. Absent uses protocol defaults; null omits speed.
   * Display only, never persisted or accepted as a caller-provided capability. */
  speedRange?: SpeechSpeedRange;
  defaultVoice?: string;
};
export type VoiceConversationPreference = {
  selection: VoiceConversationSelection | null;
  customized: boolean;
  /** Absent on older local bridges; the current default is enabled. */
  sentencePlayback?: boolean;
};
/** Local-only synthesis result. PCM remains pull-driven; encoded segments are
 * received during bounded prefetch and decoded by the sandboxed audio player. */
export type EncodedSpeechAudio = { format: 'mp3'; data: ArrayBuffer };
export type SpeechAudioResult = { sampleRate: number } | EncodedSpeechAudio;
export const MAX_ENCODED_SPEECH_BYTES = 8 * 1024 * 1024;
export type SpeechStartResult = SpeechAudioResult | { deferred: true };
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
  event:
    | ConversationInputEvent
    | { type: 'ended' }
    | { type: 'call-record'; record: VoiceCallRecord }
    /** "Recognize my voice" muted speech judged to be someone else. */
    | { type: 'speaker-filtered' };
};
export type VoiceConversationStart = VoiceConversationSelection & {
  callId: string;
  botId: string;
  sessionId: string;
};
export interface VoiceConversationApi {
  models(): Promise<VoiceConversationModel[]>;
  voices(selection: SpeechModelSelection): Promise<SpeechVoiceCatalog>;
  preview(input: SpeechPreviewStart): Promise<SpeechAudioResult>;
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
  promoteTurn?(callId: string, inputId: string): Promise<boolean>;
  submitTurn?(callId: string, inputId: string, text: string, forceHandoff: boolean): Promise<boolean>;
  startPlayback(input: VoiceConversationStart): Promise<{ callId: string }>;
  /** One finalized ASR utterance, bound to the active local call; never creates a task. */
  classifyExit(
    callId: string,
    utteranceId: string,
    inputGeneration: number,
  ): Promise<VoiceExitDecision>;
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
  /** Reads the live call and subscribes this window to its later updates. */
  callStatus(): Promise<VoiceCallStatus | null>;
  /** Main window only: Main ignores status published by any other window. */
  publishCallStatus(update: VoiceCallStatusUpdate): void;
  /** Routes an operation to the main window, which owns capture and playback. */
  callCommand(command: VoiceCallCommand): Promise<{ ok: boolean }>;
  onCallStatus(callback: (update: VoiceCallStatusUpdate) => void): () => void;
  onCallCommand(callback: (command: VoiceCallCommand) => void): () => void;
}

export function normalizeVoiceConversationSelection(
  value: unknown,
): VoiceConversationSelection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const route = normalizeSpeechModelSelection(value);
  const voice = normalizeSpeechVoiceId((value as Partial<VoiceConversationSelection>).voice);
  const speed = (value as Partial<VoiceConversationSelection>).speed;
  // Check the broad protocol envelope here; Main checks the resolved adapter's
  // narrower range, never a renderer-supplied protocol for an official endpoint.
  if (speed !== undefined && (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.25 || speed > 4))
    return undefined;
  return route && voice ? { ...route, voice, ...(speed !== undefined ? { speed } : {}) } : undefined;
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
    (protocol !== undefined && !SPEECH_PROTOCOLS.includes(protocol)) ||
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
