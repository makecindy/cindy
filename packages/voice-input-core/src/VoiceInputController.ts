import type {
  AsrEvent,
  AsrProvider,
  AudioTrace,
  EditableRange,
  RefinementResult,
  SpeechSegment,
  VoiceInputCallbacks,
  VoiceInputErrorCode,
  VoiceInputDraftReason,
  VoiceInputDraftSource,
  VoiceInputState,
  VoiceInputTerminalOutcome,
} from './types';
import { VoiceTimelineLogger } from './VoiceTimelineLogger';

type DictationRefiner = {
  refine(input: {
    text: string;
    runId: string;
    segmentIds: string[];
    onPartial?: (text: string) => void;
  }): Promise<RefinementResult>;
};

type PendingRefinement = {
  text: string;
  segmentIds: string[];
  startedAt: number;
  latestPreview?: string;
  onPreview?: (text: string) => void;
  promise: Promise<{ result?: RefinementResult; error?: unknown }>;
};

type VoiceInputControllerOptions = {
  asr: AsrProvider;
  refiner?: DictationRefiner;
  logger: VoiceTimelineLogger;
  callbacks: VoiceInputCallbacks;
  stableWaitMs?: number;
};

type CryptoWithUuid = {
  randomUUID?: () => string;
};

// ASR stall watchdog thresholds. This is diagnostic only: OpenAI realtime can
// legitimately pause partial deltas for 10+ seconds after a long pause, then
// still return a complete transcript on stop. Treating that partial gap as a
// recover trigger caused us to close a healthy session mid-dictation and lose
// words around the reconnect boundary.
//
// The audio-side gate counts ONLY voiced chunks (RMS above threshold), not
// raw audio duration. Counting raw duration meant a silent thinking pause
// looked identical to a real stall: any 6+ seconds of mic-open silence
// triggered false alarms. Voiced gating makes the warning meaningful while
// keeping it non-destructive; network recovery is only driven by explicit
// transport error/disconnected events.
const ASR_STALL_WARN_AFTER_WALL_MS = 4_000;
const ASR_STALL_WARN_AFTER_VOICED_MS = 2_000;
const ASR_STALL_CHECK_INTERVAL_MS = 1_000;
// Retry a few explicit transport failures (not partial gaps) so transient
// gateway/WebSocket interruptions do not abort an otherwise healthy dictation.
// Providers still own replay/merge safety; after the cap, surface the failure.
const ASR_NETWORK_RECOVERY_MAX_ATTEMPTS = 3;
// PCM16 RMS above this counts as "the user is talking right now". 300 is
// well above quiet-room background (~30) and typing/AC noise (~50-150)
// while being below normal speech (~800+) by enough margin to catch soft
// speakers. Hardcoded for now; a per-mic adaptive baseline would be the
// next refinement if false positives ever bite.
const ASR_VOICED_RMS_THRESHOLD = 300;
const EMPTY_TRANSCRIPT_ERROR = 'Voice input detected speech but returned no transcript. Please try again.';

/**
 * VoiceInputController owns click-to-dictate state.
 *
 * It deliberately treats ASR partials as the fast draft lane, Stop as the
 * commit boundary, and refinement as an optional downstream lane. Audio capture
 * stays outside this class so Electron renderer can own getUserMedia while
 * Electron main owns provider sessions and keys.
 */
export class VoiceInputController {
  private readonly asr: AsrProvider;
  private readonly refiner?: DictationRefiner;
  private readonly logger: VoiceTimelineLogger;
  private readonly callbacks: VoiceInputCallbacks;
  private readonly stableWaitMs: number;
  private state: VoiceInputState = 'idle';
  private runId = '';
  private startedAt = 0;
  private latestPartial = '';
  private latestStable = '';
  // The most recent transcript regardless of lane, plus which lane produced it.
  // Salvage cannot prefer `latestStable`: every provider emits both lanes as the
  // full aggregate transcript, so a partial arriving after a stable (the next
  // utterance already in progress) is strictly more complete. Preferring the
  // stable lane would drop that tail — exactly the loss this salvage exists to
  // prevent. stop() keeps its own stable-first ordering: there the flush is what
  // produces the authoritative final stable.
  private latestTranscript = '';
  private latestTranscriptSource: 'partial' | 'stable' = 'partial';
  private firstPartialSeen = false;
  private firstAudioChunkSeen = false;
  // Run-level speech activity separates an intentional silent stop from an
  // ASR/provider failure that returned no transcript. This is deliberately
  // independent from the stall watchdog's rolling window counters.
  private speechActivitySeen = false;
  private pendingStableResolvers: Array<(text: string | undefined) => void> = [];
  // Set by cancel(); read by the in-flight refine() to short-circuit before
  // emitting more timeline events, calling applyRefinement, or clobbering the
  // 'done' state that cancel() already set. Cleared on each new start().
  private currentRunCancelled = false;
  // Stall watchdog state. lastAsrSignalAt is performance.now() of the most
  // recent partial/stable; voicedAudioMsSinceLastSignal accumulates only
  // trace.durationMs of chunks whose RMS clears the voiced threshold (so
  // silent thinking pauses don't tick toward the warning). audioMsSinceLastSignal
  // is kept as a diagnostic — useful in stall_warning logs to compare voiced
  // vs total audio when judging whether thresholds are tuned right.
  // stallWarned guards against repeated warn-level timeline events for the
  // same stall window — reset on every fresh ASR signal.
  private lastAsrSignalAt = 0;
  private audioMsSinceLastSignal = 0;
  private voicedAudioMsSinceLastSignal = 0;
  private stallWarned = false;
  private stallCheckTimer?: ReturnType<typeof setInterval>;
  private networkRecoveryInFlight = false;
  private networkRecoveryAttempts = 0;
  // Whether this run ever received a partial/stable. Used in the stall warning
  // event so the next reproduction immediately tells us "session never produced
  // anything" vs "stopped after producing some text".
  private everSawAsrSignal = false;
  // Whether this run already handed text to the host via onSubmitted. Guards the
  // failure-path salvage against double insertion: a recovery that rejects after
  // stop() already submitted would otherwise insert the same transcript twice.
  private transcriptEmitted = false;
  // Set when onSubmitted threw. A callback that throws part-way has already run
  // an unknown share of its side effects (mobile publishes the draft, then calls
  // an injected history recorder that can throw), so retrying it through salvage
  // would run those effects a second time. One attempt per run is the contract.
  private submitCallbackThrew = false;

  constructor(options: VoiceInputControllerOptions) {
    this.asr = options.asr;
    this.refiner = options.refiner;
    this.logger = options.logger;
    this.callbacks = options.callbacks;
    this.stableWaitMs = options.stableWaitMs ?? 500;

    this.asr.onEvent((event) => this.handleAsrEvent(event));
  }

  get id(): string {
    return this.runId;
  }

  get currentState(): VoiceInputState {
    return this.state;
  }

  async start(): Promise<string> {
    if (this.state !== 'idle' && this.state !== 'done' && this.state !== 'error') return this.runId;

    this.runId = createVoiceInputId();
    this.startedAt = performance.now();
    this.latestPartial = '';
    this.latestStable = '';
    this.latestTranscript = '';
    this.latestTranscriptSource = 'partial';
    this.firstPartialSeen = false;
    this.firstAudioChunkSeen = false;
    this.speechActivitySeen = false;
    this.currentRunCancelled = false;
    this.lastAsrSignalAt = performance.now();
    this.audioMsSinceLastSignal = 0;
    this.voicedAudioMsSinceLastSignal = 0;
    this.stallWarned = false;
    this.networkRecoveryAttempts = 0;
    this.networkRecoveryInFlight = false;
    this.everSawAsrSignal = false;
    this.transcriptEmitted = false;
    this.submitCallbackThrew = false;
    this.startStallWatchdog();
    this.setState('listening');
    this.logger.record({ type: 'start_clicked', runId: this.runId, at: Date.now() });

    try {
      await this.asr.start();
      return this.runId;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  appendAudio(chunk: ArrayBuffer, trace?: AudioTrace): void {
    if (this.state !== 'listening') return;
    if (!this.firstAudioChunkSeen) {
      this.firstAudioChunkSeen = true;
      this.logger.record({
        type: 'first_audio_chunk',
        runId: this.runId,
        at: Date.now(),
        elapsedMs: performance.now() - this.startedAt,
      });
    }
    const voiced = isChunkVoiced(chunk);
    if (voiced) this.speechActivitySeen = true;
    if (typeof trace?.durationMs === 'number') {
      this.audioMsSinceLastSignal += trace.durationMs;
      if (voiced) {
        this.voicedAudioMsSinceLastSignal += trace.durationMs;
      }
    }
    this.asr.appendAudio(chunk, trace);
  }

  async stop(): Promise<void> {
    if (this.state !== 'listening') return;
    const runId = this.runId;
    this.stopStallWatchdog();
    this.setState('submitting');
    this.logger.record({ type: 'stop_clicked', runId, at: Date.now() });
    const optimisticRefinement = this.startOptimisticRefinement(runId);

    try {
      await this.asr.flushAudio();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      await this.asr.stop();
      return;
    }

    const stable = await this.waitForStable(this.stableWaitMs);
    const text = normalizeSubmittedText(stable || this.latestStable || this.latestPartial);
    const source = stable || this.latestStable ? 'stable' : 'partial';

    await this.asr.stop();

    // Deliberately placed after the LAST provider await in this method, so it
    // covers a failure landing during any of them. Providers hide such failures
    // from this path: both flushAudio() and stop() await an in-flight recover()
    // but swallow its rejection, so those awaits resolve normally on a run that
    // fail() has already finished (salvaging the transcript and setting the
    // terminal state). Continuing would submit the same transcript twice and
    // overwrite 'error' with 'refining'/'done', hiding the failure entirely.
    // transcriptEmitted is checked too: it is the direct invariant ("this run has
    // already given the host its text"), so it holds even if a future failure
    // path leaves the state alone.
    if (this.leftSubmittingState() || this.transcriptEmitted) {
      // cancel() also lands here (it moves the run to 'done'); logging that as
      // a failure would misread the timeline for an intentional abort.
      this.discardRefinement(runId, optimisticRefinement, this.currentRunCancelled ? 'cancelled' : 'run_failed');
      return;
    }

    if (!text) {
      this.discardRefinement(runId, optimisticRefinement, 'no_submitted_text');
      if (this.speechActivitySeen) {
        this.fail(EMPTY_TRANSCRIPT_ERROR, 'empty_transcript');
      } else {
        this.setState('done', 'no_speech');
      }
      return;
    }

    const segment: SpeechSegment = {
      id: optimisticRefinement?.text === text ? optimisticRefinement.segmentIds[0] : createVoiceInputId(),
      source: 'mic',
      status: 'submitted',
      text,
      updatedAt: Date.now(),
    };
    let range: EditableRange | undefined;
    try {
      range = this.callbacks.onSubmitted(text, segment);
    } catch (error) {
      // salvageTranscript() already treats a throwing host as a real scenario
      // (destroyed window, torn-down editor); this path has to survive it too.
      // Letting the exception escape would reject stop() before any terminal
      // state is set, stranding the run in 'submitting' — after which start()
      // refuses to begin a new one and dictation is dead until reload.
      this.submitCallbackThrew = true;
      this.discardRefinement(runId, optimisticRefinement, 'run_failed');
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    // Same acceptance convention as salvageTranscript(): the returned range is
    // the host's "I took the text" signal, and a host may refuse (mobile stops
    // writing into the voice insertion once the user has edited it). Marking it
    // emitted regardless would let a later failure claim transcriptKept for
    // text that never landed.
    this.transcriptEmitted = Boolean(range);
    this.logger.record({ type: 'submitted', runId, at: Date.now(), text, source });

    if (this.refiner && range) {
      let refinement: PendingRefinement;
      if (optimisticRefinement?.text === text) {
        refinement = optimisticRefinement;
      } else {
        this.discardRefinement(runId, optimisticRefinement, 'final_text_changed');
        refinement = this.startRefinementRequest(runId, text, [segment.id]);
      }
      this.setState('refining');
      void this.finishRefinement(runId, segment, range, refinement);
    } else {
      this.discardRefinement(runId, optimisticRefinement, 'no_editable_range');
      this.setState('done');
    }
  }

  /**
   * True when something moved this run out of the state stop() set on entry —
   * fail() from a rejected recovery, or cancel(). Deliberately a method: inside
   * stop(), the `state !== 'listening'` guard narrows this.state for the whole
   * body, so an inline comparison against 'submitting' is a type error.
   */
  private leftSubmittingState(): boolean {
    return this.state !== 'submitting';
  }

  async cancel(): Promise<void> {
    if (!this.runId) return;
    const runId = this.runId;
    this.currentRunCancelled = true;
    this.stopStallWatchdog();
    this.pendingStableResolvers.splice(0).forEach((resolve) => resolve(undefined));
    this.logger.record({ type: 'cancelled', runId, at: Date.now() });
    // Enter the terminal state before closing the provider. Several realtime
    // transports emit a final `disconnected` while their socket is intentionally
    // closed; if we remain in `listening`, that normal teardown is indistinguishable
    // from a network drop and surfaces a false "connection interrupted" error.
    this.setState('done', 'cancelled');
    await this.asr.stop();
  }

  private handleAsrEvent(event: AsrEvent): void {
    if (!this.runId) return;

    switch (event.type) {
      case 'connected':
        this.logger.record({
          type: 'asr_connected',
          runId: this.runId,
          at: Date.now(),
          elapsedMs: performance.now() - this.startedAt,
        });
        break;
      case 'partial':
        if (this.state !== 'listening' && this.state !== 'submitting') return;
        this.latestPartial = event.text;
        this.latestTranscript = event.text;
        this.latestTranscriptSource = 'partial';
        this.resetStallCounters();
        if (this.state !== 'listening') return;
        if (!this.firstPartialSeen) {
          this.firstPartialSeen = true;
          this.logger.record({
            type: 'first_partial',
            runId: this.runId,
            at: Date.now(),
            elapsedMs: performance.now() - this.startedAt,
            text: event.text,
          });
        }
        this.publishDraft(event.text, 'partial');
        break;
      case 'stable':
        if (this.state !== 'listening' && this.state !== 'submitting') return;
        this.latestStable = event.text;
        this.latestTranscript = event.text;
        this.latestTranscriptSource = 'stable';
        this.resetStallCounters();
        this.logger.record({
          type: 'stable_received',
          runId: this.runId,
          at: Date.now(),
          text: event.text,
        });
        if (this.state === 'listening') {
          this.publishDraft(event.text, 'stable');
        }
        this.pendingStableResolvers.splice(0).forEach((resolve) => resolve(event.text));
        break;
      case 'error':
        if (this.currentRunCancelled) break;
        if (this.state === 'submitting' || this.state === 'refining') {
          const text = normalizeSubmittedText(this.latestStable || this.latestPartial);
          if (text) {
            this.logger.record({
              type: 'asr_stop_error_ignored',
              runId: this.runId,
              at: Date.now(),
              message: event.message,
              textChars: text.length,
            });
            break;
          }
        }
        // Try recover before failing: keepalive timeouts and transient
        // network errors arrive here as `error`. Partial stalls are only
        // diagnostic; this self-heal path is reserved for transport failures.
        if (this.state === 'listening' && this.tryRecover('error')) break;
        this.fail(event.message);
        break;
      case 'disconnected':
        if (this.currentRunCancelled) break;
        // Same as 'error' above. Without this hook, a keepalive-driven
        // socket terminate would emit `disconnected` and bypass recover
        // entirely, producing the exact failure mode the resilience pass
        // was supposed to prevent.
        if (this.state === 'listening' && this.tryRecover('disconnected')) break;
        if (this.state === 'listening') {
          this.fail(
            'Voice input connection was interrupted. Please try again.',
            'connection_interrupted',
          );
        }
        break;
    }
  }

  // Returns true if recover was kicked off (caller should NOT call fail()).
  // Returns false if recover is unavailable or already in flight from a
  // concurrent trigger; in the in-flight case the existing recovery will
  // either succeed and continue, or fail in its own catch handler.
  private tryRecover(trigger: 'error' | 'disconnected'): boolean {
    if (typeof this.asr.recover !== 'function') return false;
    if (this.networkRecoveryInFlight) return true;
    if (this.networkRecoveryAttempts >= ASR_NETWORK_RECOVERY_MAX_ATTEMPTS) return false;
    this.attemptNetworkRecovery(
      trigger,
      this.audioMsSinceLastSignal,
      this.voicedAudioMsSinceLastSignal,
      performance.now() - this.lastAsrSignalAt,
    );
    return true;
  }

  private publishDraft(text: string, source: VoiceInputDraftSource): void {
    const normalized = text.trim();
    if (!normalized) return;
    const reason: VoiceInputDraftReason = source === 'stable' ? 'asr_stable' : 'asr_partial';
    const segment: SpeechSegment = {
      id: `draft-${this.runId}`,
      source: 'mic',
      status: 'draft',
      text: normalized,
      updatedAt: Date.now(),
    };
    this.callbacks.onDraftChanged(normalized, segment, source);
    this.logger.record({
      type: 'draft_changed',
      runId: this.runId,
      at: Date.now(),
      text: normalized,
      reason,
      source,
    });
  }

  private waitForStable(timeoutMs: number): Promise<string | undefined> {
    if (this.latestStable) return Promise.resolve(this.latestStable);
    return new Promise((resolve) => {
      const resolver = (text: string | undefined): void => {
        clearTimeout(timer);
        this.pendingStableResolvers = this.pendingStableResolvers.filter((item) => item !== resolver);
        resolve(text);
      };
      const timer = setTimeout(() => {
        this.pendingStableResolvers = this.pendingStableResolvers.filter((item) => item !== resolver);
        resolve(undefined);
      }, timeoutMs);
      this.pendingStableResolvers.push(resolver);
    });
  }

  private startOptimisticRefinement(runId: string): PendingRefinement | undefined {
    if (!this.refiner) return undefined;
    const text = normalizeSubmittedText(this.latestStable || this.latestPartial);
    if (!text) return undefined;
    // Stop-time ASR finalization can take close to a second. Start refinement
    // against the visible draft immediately, but only apply it if the final
    // ASR text matches. If the provider corrects or extends the text, we
    // discard this request and refine the final transcript instead.
    return this.startRefinementRequest(runId, text, [createVoiceInputId()]);
  }

  private startRefinementRequest(runId: string, text: string, segmentIds: string[]): PendingRefinement {
    if (!this.refiner) throw new Error('Dictation refiner is not configured.');
    const refineStartedAt = performance.now();
    this.logger.record({ type: 'refine_requested', runId, at: Date.now(), text });

    const request: PendingRefinement = {
      text,
      segmentIds,
      startedAt: refineStartedAt,
      promise: Promise.resolve({}),
    };
    request.promise = this.refiner.refine({
      text,
      runId,
      segmentIds,
      onPartial: (partial) => {
        request.latestPreview = partial;
        request.onPreview?.(partial);
      },
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    return request;
  }

  private async finishRefinement(
    runId: string,
    segment: SpeechSegment,
    range: EditableRange,
    request: PendingRefinement,
  ): Promise<void> {
    this.attachRefinementPreview(runId, segment, range, request);
    const { result, error } = await request.promise;
    if (runId !== this.runId) {
      this.discardRefinement(runId, request, 'stale_run');
      return;
    }
    if (this.currentRunCancelled) {
      this.discardRefinement(runId, request, 'cancelled');
      return;
    }
    // A failure can land while refinement is in flight (a recovery rejecting
    // after stop() already submitted). Every exit below writes a terminal state,
    // so continuing would overwrite 'error' with 'done' and erase the failure
    // the user was just told about — along with applying refined text to a run
    // whose host already reported it as failed.
    if (this.state === 'error') {
      this.discardRefinement(runId, request, 'run_failed');
      return;
    }

    if (error) {
      this.logger.record({
        type: 'refine_rejected',
        runId,
        at: Date.now(),
        reason: error instanceof Error ? error.message : String(error),
        elapsedMs: performance.now() - request.startedAt,
      });
      this.setState('done');
      return;
    }

    if (!result?.accepted || !result.refinedText) {
      this.logger.record({
        type: 'refine_rejected',
        runId,
        at: Date.now(),
        reason: result?.rejectionReason ?? 'unknown',
        elapsedMs: result?.elapsedMs,
        basedOnText: result?.basedOnText,
        refinedText: result?.refinedText,
      });
      this.setState('done');
      return;
    }

    this.logger.record({
      type: 'refine_accepted',
      runId,
      at: Date.now(),
      basedOnText: result.basedOnText,
      refinedText: result.refinedText,
      elapsedMs: result.elapsedMs,
    });

    if (this.callbacks.isRangeUserTouched?.(range) ?? range.userTouched) {
      this.logger.record({ type: 'refine_skipped_user_touched', runId, at: Date.now(), rangeId: range.id });
      this.setState('done');
      return;
    }

    const applied = this.callbacks.applyRefinement?.(range, result.refinedText) ?? false;
    if (applied) {
      this.logger.record({
        type: 'refine_applied',
        runId,
        at: Date.now(),
        rangeId: range.id,
        refinedText: result.refinedText,
      });
    }
    this.setState('done');
  }

  private attachRefinementPreview(
    runId: string,
    segment: SpeechSegment,
    range: EditableRange,
    request: PendingRefinement,
  ): void {
    const emitPreview = (text: string): void => {
      const normalized = text.replace(/\r\n?/g, '\n').trim();
      if (!normalized || normalized === request.text) return;
      // Same reason as finishRefinement's check: once the run has failed, its
      // host is showing an error — streaming refinement previews into it would
      // rewrite text the user was just told the session stopped producing.
      if (runId !== this.runId || this.currentRunCancelled || this.state === 'error') return;
      if (this.callbacks.isRangeUserTouched?.(range) ?? range.userTouched) return;
      this.callbacks.onRefinementPreview?.(normalized, {
        ...segment,
        status: 'draft',
        basedOnText: request.text,
        text: normalized,
        updatedAt: Date.now(),
      }, range);
    };
    request.onPreview = emitPreview;
    if (request.latestPreview) emitPreview(request.latestPreview);
  }

  private discardRefinement(
    runId: string,
    request: PendingRefinement | undefined,
    reason: 'final_text_changed' | 'stale_run' | 'cancelled' | 'no_submitted_text' | 'no_editable_range' | 'run_failed',
  ): void {
    if (!request) return;
    this.logger.record({
      type: 'refine_discarded',
      runId,
      at: Date.now(),
      reason,
      basedOnText: request.text,
    });
  }

  private setState(state: VoiceInputState, outcome?: VoiceInputTerminalOutcome): void {
    this.state = state;
    const terminalOutcome = outcome
      ?? (state === 'error' ? 'failed' : state === 'done' ? 'success' : undefined);
    this.callbacks.onStateChanged?.(state, terminalOutcome);
  }

  private fail(message: string, code?: VoiceInputErrorCode): void {
    // Idempotent: a recover() race can plausibly produce two fail() calls in
    // the same tick (one from a stale 'disconnected' event, one from
    // recovery_failed). Without this guard the renderer toasts both, which
    // shows the user a confusing second error after they already saw the first.
    if (this.state === 'error' || this.state === 'done') return;
    if (this.runId) {
      this.logger.record({ type: 'error', runId: this.runId, at: Date.now(), message });
    }
    this.stopStallWatchdog();
    this.pendingStableResolvers.splice(0).forEach((resolve) => resolve(undefined));
    // Salvage before the terminal state: hosts tear the draft down when they see
    // 'error', so the submitted text has to reach them first.
    this.salvageTranscript();
    this.setState('error', 'failed');
    // Retention travels as a detail, never as the code: `message` may be the
    // only thing telling the user their credential expired or their quota ran
    // out. transcriptEmitted covers both salvage and a stop() that submitted
    // before the failure landed (a recovery rejecting during refinement).
    this.callbacks.onError?.(message, code, { transcriptKept: this.transcriptEmitted });
  }

  /**
   * Hand already-recognized text to the host before entering the error state.
   *
   * A socket that dies mid-dictation used to discard everything the user had
   * said so far: partials only ever existed as a host-side draft, and fail()
   * never offered them to onSubmitted. The transcript is worth more than the
   * dead session, so commit it raw — refinement needs the same network that
   * just failed — and let the host report the failure with transcriptKept set.
   *
   * The host's returned range is the acceptance signal. A host can legitimately
   * refuse: mobile stops writing into the voice insertion once the user has
   * edited it, so the text never lands. Claiming retention there would tell the
   * user their words were kept when the tail was actually dropped.
   */
  private salvageTranscript(): boolean {
    if (this.transcriptEmitted || this.submitCallbackThrew) return false;
    const text = normalizeSubmittedText(this.latestTranscript);
    if (!text) return false;
    const segment: SpeechSegment = {
      id: createVoiceInputId(),
      source: 'mic',
      status: 'submitted',
      text,
      updatedAt: Date.now(),
    };
    let accepted = false;
    try {
      accepted = Boolean(this.callbacks.onSubmitted(text, segment));
    } catch {
      // A host that cannot take the text (destroyed window, torn-down editor)
      // must not also swallow the error report the user is waiting for.
      accepted = false;
    }
    this.logger.record({
      type: 'transcript_salvaged',
      runId: this.runId,
      at: Date.now(),
      text,
      source: this.latestTranscriptSource,
      accepted,
    });
    if (!accepted) return false;
    this.transcriptEmitted = true;
    return true;
  }

  private resetStallCounters(): void {
    this.lastAsrSignalAt = performance.now();
    this.audioMsSinceLastSignal = 0;
    this.voicedAudioMsSinceLastSignal = 0;
    this.stallWarned = false;
    this.everSawAsrSignal = true;
  }

  private startStallWatchdog(): void {
    this.stopStallWatchdog();
    this.stallCheckTimer = setInterval(() => this.checkAsrStall(), ASR_STALL_CHECK_INTERVAL_MS);
  }

  private stopStallWatchdog(): void {
    if (this.stallCheckTimer === undefined) return;
    clearInterval(this.stallCheckTimer);
    this.stallCheckTimer = undefined;
  }

  private checkAsrStall(): void {
    if (this.state !== 'listening') {
      this.stopStallWatchdog();
      return;
    }
    if (this.networkRecoveryInFlight) return;

    const wallMs = performance.now() - this.lastAsrSignalAt;
    const audioMs = this.audioMsSinceLastSignal;
    const voicedMs = this.voicedAudioMsSinceLastSignal;

    if (
      !this.stallWarned &&
      voicedMs >= ASR_STALL_WARN_AFTER_VOICED_MS &&
      wallMs >= ASR_STALL_WARN_AFTER_WALL_MS
    ) {
      this.stallWarned = true;
      this.logger.record({
        type: 'asr_stall_warning',
        runId: this.runId,
        at: Date.now(),
        audioMsSinceLastSignal: Math.round(audioMs),
        voicedAudioMsSinceLastSignal: Math.round(voicedMs),
        wallMsSinceLastSignal: Math.round(wallMs),
        everSawSignal: this.everSawAsrSignal,
      });
    }
  }

  private attemptNetworkRecovery(
    trigger: 'error' | 'disconnected',
    audioMs: number,
    voicedMs: number,
    wallMs: number,
  ): void {
    if (!this.asr.recover) return;
    const runId = this.runId;
    this.networkRecoveryInFlight = true;
    this.networkRecoveryAttempts += 1;
    const startedAt = performance.now();
    this.logger.record({
      type: 'asr_recovery_attempted',
      runId,
      at: Date.now(),
      trigger,
      attempt: this.networkRecoveryAttempts,
      audioMsSinceLastSignal: Math.round(audioMs),
      voicedAudioMsSinceLastSignal: Math.round(voicedMs),
      wallMsSinceLastSignal: Math.round(wallMs),
      everSawSignal: this.everSawAsrSignal,
    });
    void this.asr
      .recover()
      .then(() => {
        if (runId !== this.runId) return;
        // Reset stall counters so the next watchdog window starts fresh.
        this.lastAsrSignalAt = performance.now();
        this.audioMsSinceLastSignal = 0;
        this.voicedAudioMsSinceLastSignal = 0;
        this.stallWarned = false;
        this.logger.record({
          type: 'asr_recovery_succeeded',
          runId,
          at: Date.now(),
          elapsedMs: performance.now() - startedAt,
        });
      })
      .catch((error: unknown) => {
        if (runId !== this.runId) return;
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.record({
          type: 'asr_recovery_failed',
          runId,
          at: Date.now(),
          elapsedMs: performance.now() - startedAt,
          reason,
        });
        this.stopStallWatchdog();
        this.fail('Voice input stopped receiving recognition. Please try again.', 'recognition_stalled');
      })
      .finally(() => {
        if (runId !== this.runId) return;
        this.networkRecoveryInFlight = false;
      });
  }
}

function normalizeSubmittedText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * True when the chunk's PCM16 RMS is loud enough to plausibly contain speech.
 * Used by the stall watchdog to distinguish "user is silent" from "user is
 * speaking but server is quiet": only voiced chunks count toward the warning
 * threshold, so a 30-second thinking pause never creates noisy diagnostics.
 *
 * Pure silence in a quiet room is RMS ~10-30; typing/AC/fan noise ~50-150;
 * normal speech ~800+. The threshold (300) sits in the gap between background
 * noise and soft speech — well below typical voice levels but high enough to
 * reject room hum.
 */
function isChunkVoiced(chunk: ArrayBuffer): boolean {
  if (chunk.byteLength < 2) return false;
  const sampleCount = Math.floor(chunk.byteLength / 2);
  if (sampleCount === 0) return false;
  const samples = new Int16Array(chunk, 0, sampleCount);
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const s = samples[i];
    sumSquares += s * s;
  }
  const rms = Math.sqrt(sumSquares / sampleCount);
  return rms >= ASR_VOICED_RMS_THRESHOLD;
}

function createVoiceInputId(): string {
  const cryptoLike = (globalThis as { crypto?: CryptoWithUuid }).crypto;
  if (typeof cryptoLike?.randomUUID === 'function') {
    return cryptoLike.randomUUID();
  }
  return `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
