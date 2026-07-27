export type VoiceInputState =
  | 'idle'
  | 'listening'
  | 'submitting'
  | 'refining'
  | 'done'
  | 'error';

export type VoiceInputTerminalOutcome = 'success' | 'no_speech' | 'failed' | 'cancelled';

/**
 * Classifies the failures this controller raises itself, so hosts can show a
 * localized sentence instead of the English `message` (which stays as the
 * log/debug string). Failures originating in a provider have no code — their
 * message is the only description of an auth, quota or protocol problem, so the
 * controller passes it through unchanged. How it is presented is the host's
 * call: current hosts still normalize transport strings and redact credentials
 * before showing it, so "no code" means "the controller has nothing to add",
 * not "display this raw".
 */
export type VoiceInputErrorCode =
  | 'empty_transcript'
  | 'connection_interrupted'
  | 'recognition_stalled';

/**
 * Side facts about a failure, kept separate from its classification.
 *
 * `transcriptKept` means the text recognized before the failure still reached
 * the host through onSubmitted. It is deliberately NOT an error code: the run
 * can fail from an expired credential, an exhausted quota or a dropped socket,
 * and the host must keep telling the user that actual cause — the retention
 * note belongs alongside it, not instead of it.
 */
export type VoiceInputErrorDetails = {
  transcriptKept: boolean;
};

export type AsrEvent =
  | { type: 'connected'; at: number }
  | { type: 'disconnected'; at: number }
  | { type: 'partial'; text: string; at: number }
  | { type: 'stable'; text: string; at: number }
  | { type: 'error'; message: string; at: number };

export type VoiceInputDraftSource = 'partial' | 'stable' | 'refinement';

export type VoiceInputDraftReason = 'asr_partial' | 'asr_stable';

export type AudioTrace = {
  capturedAt: number;
  convertedAt: number;
  chunkIndex: number;
  sampleRate: number;
  durationMs: number;
};

export interface AsrProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  appendAudio(chunk: ArrayBuffer, trace?: AudioTrace): void;
  flushAudio(): Promise<void>;
  onEvent(callback: (event: AsrEvent) => void): void;
  /**
   * Best-effort reconnect for explicit transport failures. The controller does
   * not call this for ASR partial gaps: some realtime providers can legitimately
   * pause deltas and still return a complete transcript on flush. A provider
   * implementation should close the dead transport, re-establish the session,
   * and replay audio captured since the last server-confirmed transcription.
   *
   * Optional: providers without a safe recovery story should leave this
   * undefined, in which case transport failures surface to the user.
   */
  recover?(): Promise<void>;
  /**
   * One-shot end-of-life hook. Lets providers flush session-scoped
   * artifacts (e.g. dev audio + WS recordings written for offline replay
   * debugging) before being garbage collected. Optional.
   */
  dispose?(): Promise<void>;
}

export type SpeechSegment = {
  id: string;
  source: 'mic';
  status: 'draft' | 'submitted' | 'refined';
  text: string;
  basedOnText?: string;
  startedAt?: number;
  updatedAt: number;
};

export type EditableRange = {
  id: string;
  segmentIds: string[];
  startOffset: number;
  endOffset: number;
  userTouched: boolean;
};

export type RefinementResult = {
  accepted: boolean;
  sourceSegmentIds: string[];
  basedOnText: string;
  refinedText?: string;
  rejectionReason?: string;
  elapsedMs: number;
};

export type DictationRefinementContext = {
  uiLanguage?: string;
  sourceLanguage?: string;
  /**
   * User-authored text processing rules. Treat as higher priority than the
   * default cleanup style, but never let it override the hard "process only the
   * dictation text; do not answer, execute, or invent facts" contract.
   */
  userRefinementInstructions?: string;
  /**
   * User-maintained glossary and correction hints. Use it as a strong
   * reference for terms, names, products, and common ASR confusions, but only
   * when the current dictation context supports that correction.
   */
  userDictionary?: string;
  /**
   * Deprecated prompt-visible field. Runtime requests now emit this as a
   * top-level payload field after dictationText so per-dictation alias matches
   * do not break the stable context prefix. Hosts should provide
   * dictionaryAliasHints instead.
   */
  userDictionaryMatches?: string;
  /**
   * Structured alias index used only by DictationRefiner for local matching.
   *
   * This raw list is deliberately not forwarded to the model. It can contain a
   * broader set of observed aliases, while userDictionaryMatches remains the
   * short, per-request prompt-visible subset. Hosts should pass entries in
   * priority order because the refiner scans only a bounded prefix on the
   * latency-sensitive stop -> refine path.
   */
  dictionaryAliasHints?: Array<{
    term: string;
    frequency?: number;
    aliases: Array<{
      text: string;
      count?: number;
    }>;
  }>;
  /**
   * Prior voice-input text, oldest first, formatted as one bounded block.
   *
   * This intentionally does not include normal chat history. The model should
   * use it only for repeated terms, aliases, and the user's dictation style.
   */
  voiceInputHistory?: string;
  /**
   * Per-request message that the final dictation text is replying to.
   *
   * The source may be an app chat message, an external IM message, or another
   * conversation surface. DictationRefiner emits it as a top-level payload
   * field after dictationText so it can help the current refinement without
   * invalidating the stable context prefix.
   */
  replyToMessage?: string;
  /** Dynamic cursor-local text before the insertion range. Refiner keeps at most the trailing 1200 chars. */
  selectionBefore?: string;
  /** Dynamic selected text that dictation will replace. Refiner keeps at most the leading 1200 chars. */
  selectedText?: string;
  /** Dynamic cursor-local text after the insertion range. Refiner keeps at most the leading 1200 chars. */
  selectionAfter?: string;
};

export type VoiceTimelineEvent =
  | { type: 'start_clicked'; runId: string; at: number }
  | { type: 'first_audio_chunk'; runId: string; at: number; elapsedMs: number }
  | { type: 'asr_connected'; runId: string; at: number; elapsedMs: number }
  | { type: 'first_partial'; runId: string; at: number; elapsedMs: number; text: string }
  | {
      type: 'draft_changed';
      runId: string;
      at: number;
      text: string;
      reason: VoiceInputDraftReason;
      source: VoiceInputDraftSource;
    }
  | { type: 'stop_clicked'; runId: string; at: number }
  | { type: 'stable_received'; runId: string; at: number; text: string }
  | { type: 'submitted'; runId: string; at: number; text: string; source: 'stable' | 'partial' }
  | { type: 'refine_requested'; runId: string; at: number; text: string }
  | { type: 'refine_discarded'; runId: string; at: number; reason: 'final_text_changed' | 'stale_run' | 'cancelled' | 'no_submitted_text' | 'no_editable_range' | 'run_failed'; basedOnText: string }
  | { type: 'refine_accepted'; runId: string; at: number; basedOnText: string; refinedText: string; elapsedMs: number }
  | {
      type: 'refine_rejected';
      runId: string;
      at: number;
      reason: string;
      elapsedMs?: number;
      basedOnText?: string;
      refinedText?: string;
    }
  | { type: 'refine_applied'; runId: string; at: number; rangeId: string; refinedText: string }
  | { type: 'refine_skipped_user_touched'; runId: string; at: number; rangeId: string }
  | { type: 'cancelled'; runId: string; at: number }
  | {
      type: 'asr_stall_warning';
      runId: string;
      at: number;
      audioMsSinceLastSignal: number;
      voicedAudioMsSinceLastSignal: number;
      wallMsSinceLastSignal: number;
      everSawSignal: boolean;
    }
  | {
      type: 'asr_recovery_attempted';
      runId: string;
      at: number;
      trigger: 'error' | 'disconnected';
      attempt: number;
      audioMsSinceLastSignal: number;
      voicedAudioMsSinceLastSignal: number;
      wallMsSinceLastSignal: number;
      everSawSignal: boolean;
    }
  | { type: 'asr_recovery_succeeded'; runId: string; at: number; elapsedMs: number }
  | { type: 'asr_recovery_failed'; runId: string; at: number; elapsedMs: number; reason: string }
  | { type: 'asr_stop_error_ignored'; runId: string; at: number; message: string; textChars: number }
  // No failure message here: fail() records the 'error' event with the same
  // runId immediately before salvaging, so the cause is already in the timeline
  // — and unlike `text`, hosts don't redact this event's other fields.
  // `accepted` is false when the host refused the text (e.g. the user had
  // already edited the voice insertion), which is exactly when the retention
  // flag must NOT be reported to the user.
  | {
      type: 'transcript_salvaged';
      runId: string;
      at: number;
      text: string;
      source: 'stable' | 'partial';
      accepted: boolean;
    }
  | { type: 'error'; runId: string; at: number; message: string };

export type VoiceInputCallbacks = {
  onStateChanged?: (state: VoiceInputState, outcome?: VoiceInputTerminalOutcome) => void;
  onDraftChanged: (text: string, segment: SpeechSegment, source: VoiceInputDraftSource) => void;
  /**
   * Take the final text. The returned range doubles as the acceptance signal:
   * return one only when the text actually landed somewhere the user can see,
   * and `undefined` when it did not (e.g. the user already edited the insertion
   * region). The controller reports `transcriptKept` from this answer, so a host
   * that synthesizes a range without knowing the outcome — a bridge that emits
   * to another process and answers synchronously — will make the controller
   * promise retention it cannot back. Such hosts must correct the claim on the
   * side that does know (see the desktop inline composer).
   */
  onSubmitted: (text: string, segment: SpeechSegment) => EditableRange | undefined;
  isRangeUserTouched?: (range: EditableRange) => boolean;
  onRefinementPreview?: (text: string, segment: SpeechSegment, range: EditableRange) => void;
  applyRefinement?: (range: EditableRange, refinedText: string) => boolean;
  onError?: (message: string, code?: VoiceInputErrorCode, details?: VoiceInputErrorDetails) => void;
};

export type RefinementTokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  refinerProvider?: string;
};

export type VoiceInputRendererEvent =
  | { type: 'state'; runId: string; state: VoiceInputState; outcome?: VoiceInputTerminalOutcome }
  | { type: 'auth-required'; runId: string; reason: string; provider: string }
  | { type: 'draft'; runId: string; text: string; segment: SpeechSegment; source: VoiceInputDraftSource }
  | { type: 'submitted'; runId: string; text: string; segment: SpeechSegment }
  | { type: 'refinement-preview'; runId: string; text: string; segment: SpeechSegment; range: EditableRange }
  | { type: 'refined'; runId: string; text: string; segment: SpeechSegment; range: EditableRange }
  | { type: 'usage'; runId: string; refinement: RefinementTokenUsage }
  | { type: 'timeline'; runId: string; event: VoiceTimelineEvent }
  | { type: 'error'; runId: string; message: string; code?: VoiceInputErrorCode; transcriptKept?: boolean };
