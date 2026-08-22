import {
  BufferedAsrProvider,
  DictationRefiner,
  VoiceInputController,
  VoiceTimelineLogger,
  type AsrProvider,
  type AudioTrace,
  type DictationRefinementContext,
  type EditableRange,
  type RefinementResult,
  type VoiceInputErrorCode,
  type VoiceInputDraftSource,
  type VoiceInputState,
  type VoiceTimelineEvent,
} from '@cindy/voice-input-core';
import { i18n } from '@/i18n';
import type { StoredMobileVoiceCredential } from '@/session/mobileVoiceCredentialStore';
import { redactMobileVoiceCredentialText } from '@/session/mobileVoiceCredentialRedaction';
import { createMobileAsrProvider } from '@/session/mobileRealtimeAsrProvider';
import { CINDY_MANAGED_REFINER_PROVIDER } from '@/session/mobileCindyVoiceSession';
import {
  appendVoiceTranscriptDraftWithRange,
  buildMobileVoiceRefinementContext,
  buildStaleAnchorRefinementContext,
  makeMobileRefinerPromptCacheKey,
  MobileLiteLlmTextModelClient,
  mobileVoiceErrorCodeMessage,
  mobileVoiceTranscriptKeptError,
  type MobileVoiceCaretAnchor,
  type MobileVoiceDraftInsertion,
} from '@/session/mobileVoiceInput';
import { startMobileRealtimeAudio } from '@/session/mobileRealtimeAudio';
import { readCachedMobileVoiceDictionary } from '@/session/mobileVoiceDictionaryCache';

type StartRealtimeAudio = (options: {
  sampleRate: number;
  onChunk: (chunk: { pcm16: ArrayBuffer; trace: AudioTrace }) => void;
  onError?: (error: Error) => void;
}) => Promise<() => Promise<void>>;

type MobileDictationRefiner = {
  refine(input: {
    text: string;
    runId: string;
    segmentIds: string[];
    onPartial?: (text: string) => void;
  }): Promise<RefinementResult>;
};

export type MobileVoiceControllerSession = {
  start(): Promise<void>;
  stop(): Promise<string>;
  cancel(): Promise<void>;
  currentDraft(): string;
  /** 本次录音最后一次落点的文本区间末尾（plain-text 偏移）；插入已失效时为 null。 */
  currentInsertionEnd(): number | null;
};

type MobileVoiceControllerOptions = {
  credential: StoredMobileVoiceCredential;
  initialDraft: string;
  refinementContext?: DictationRefinementContext;
  localVoiceInputHistory?: readonly string[];
  asr?: AsrProvider;
  refiner?: MobileDictationRefiner | null;
  connectionProvider?: (provider: string) => Promise<{
    websocketUrl: string;
    authorizationToken: string;
  }>;
  refinerTargetProvider?: (provider: string, options?: { refreshAccessToken?: boolean }) => Promise<{
    url: string;
    authorization: string;
  }>;
  /** 托管润色 prompt cache 预热(voice-server refine-warmup);ASR 就绪后 fire-and-forget。 */
  warmRefiner?: (input: {
    system: string;
    user: unknown;
    promptCacheKey: string;
  }) => Promise<void>;
  startAudio?: StartRealtimeAudio;
  readCurrentDraft?: () => string;
  /** 录音开始时输入框的光标/选区(plain-text 偏移)。为空则沿用旧的末尾追加行为。 */
  readCaret?: () => MobileVoiceCaretAnchor | null;
  /** 光标捕获时的草稿快照(由 onSelectionChange 同时存)。用于检测「光标位置对应旧草稿」竞态。 */
  readCaretDraft?: () => string | null;
  onDraftChanged: (draft: string) => void;
  onStateChanged?: (state: VoiceInputState) => void;
  onError?: (message: string) => void;
  onReadyForStartCue?: () => void;
  onReadyForEndCue?: () => void;
  recordHistory?: (text: string) => string | null | void | Promise<string | null | void>;
  updateHistoryEntry?: (entryId: string, text: string) => void | Promise<void>;
  onRefinementApplied?: (input: {
    draft: string;
    rawTranscriptText: string;
    refinedText: string;
    start: number;
    end: number;
  }) => void;
  onTimelineEvent?: (event: VoiceTimelineEvent) => void;
};

const PARTIAL_DRAFT_PUBLISH_INTERVAL_MS = 80;

/**
 * Mobile adapter around shared VoiceInputController.
 *
 * It mirrors the desktop voice-input model: realtime ASR drives visible draft
 * text, stop submits the ASR text, and streaming refinement replaces that same
 * composer range. The UI supplies rendering and touch gestures; this adapter
 * owns only the controller/draft projection boundary.
 */
export function createMobileVoiceControllerSession(
  options: MobileVoiceControllerOptions,
): MobileVoiceControllerSession {
  const startAudio = options.startAudio ?? ((input) => startMobileRealtimeAudio(input));
  // BufferedAsrProvider makes the concurrent start (ASR connect ‖ mic capture)
  // safe for ANY provider: audio appended while the connect handshake is still
  // in flight is buffered and replayed in order once it settles, and a run
  // abandoned mid-handshake tears the just-opened socket down instead of
  // leaking it. Without it, the default fallback provider silently drops every
  // chunk appended before its inner provider is chosen.
  const asr = new BufferedAsrProvider(options.asr ?? createMobileAsrProvider(options.credential, {
    connectionProvider: options.connectionProvider,
  }));
  // 锚点作废(录音开始后、首个 ASR 结果返回前草稿被编辑)时,实际落点回退到文末
  // 追加;这里把同样的回退同步给 refiner:润色语境切到文末,避免拿旧光标语境改写。
  let refinementSelectionOverride: DictationRefinementContext | null = null;
  const refiner = options.refiner === undefined
    ? createMobileRefiner(options.credential, {
      refinementContext: options.refinementContext,
      localVoiceInputHistory: options.localVoiceInputHistory,
      refinerTargetProvider: options.refinerTargetProvider,
      readDynamicSelectionContext: () => refinementSelectionOverride,
    })
    : options.refiner ?? undefined;
  // 托管 prompt cache 预热:发一个与真实润色共享 prompt 前缀(dictationText 为空)
  // 的请求到 voice-server warmup 端点。fire-and-forget——听写主流程绝不等待或
  // 因预热失败而失败;promptCacheKey 派生必须与真实润色请求逐字节一致。
  const warmManagedRefinerPromptCache = (): void => {
    if (!options.warmRefiner || !(refiner instanceof DictationRefiner)) return;
    try {
      const request = refiner.buildWarmupRequest();
      const promptCacheKey = makeMobileRefinerPromptCacheKey({
        model: CINDY_MANAGED_REFINER_PROVIDER,
        schemaName: 'dictation_refinement',
        promptVersion: request.promptVersion,
        system: request.system,
        scope: mobileRefinerPromptCacheScope(options.credential),
      });
      void options.warmRefiner({
        system: request.system,
        user: { schemaName: 'dictation_refinement', input: request.user },
        promptCacheKey,
      }).catch((error) => {
        console.warn(
          '[mobile-voice] refiner warmup failed (non-fatal):',
          error instanceof Error ? error.message : String(error),
        );
      });
    } catch (error) {
      console.warn(
        '[mobile-voice] refiner warmup skipped:',
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const baseDraft = options.initialDraft;
  let latestDraft = baseDraft;
  let lastPublishedDraft = baseDraft;
  let pendingDraftToPublish: string | null = null;
  let draftPublishThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  let stopAudio: (() => Promise<void>) | null = null;
  let state: VoiceInputState = 'idle';
  let controllerError: Error | null = null;
  // Run lifecycle as an explicit phase machine instead of a set of overlapping
  // boolean flags. Legal transitions:
  //   idle → running                     (start())
  //   running → stopping                 (stop())
  //   running | stopping → cancelled     (cancel())
  //   running | stopping → failed        (mic failure, or ASR connect failure)
  //   stopping → idle                    (stop() completed successfully)
  //   any → running                      (a fresh start() begins a new run)
  // Every teardown-ish question is answered from the phase, so the answers can
  // never disagree with each other the way independent flags could:
  //   - captureTornDown(): should onChunk drop mic audio? (post-stop straggler
  //     chunks must never be buffered/flushed — a stop() that waits for a slow
  //     handshake would otherwise transcribe speech after the user stopped)
  //   - phase === 'failed': did the run die (mic or connect failure)?
  //   - phase === 'cancelled': was the run abandoned on purpose (not an error)?
  let runPhase: 'idle' | 'running' | 'stopping' | 'cancelled' | 'failed' = 'idle';
  // Read through a function where control flow awaits in between: callbacks
  // (handleAudioFailure / cancel) mutate runPhase across awaits, which TS's
  // narrowing of the `let` cannot see.
  const currentRunPhase = (): typeof runPhase => runPhase;
  const captureTornDown = (): boolean => runPhase === 'stopping' || runPhase === 'cancelled' || runPhase === 'failed';
  // Whether the mic has delivered its first PCM chunk this run. The shared
  // controller sets 'listening' synchronously at start, but the AVAudioSession /
  // AVAudioEngine take ~150-200ms to warm up before real audio flows; we hold the
  // 'listening' state from the UI until capture is actually live (see start()).
  // Orthogonal to runPhase: it describes the mic, not the run lifecycle.
  let captureLive = false;
  let listeningPendingCaptureLive = false;
  // The ASR connect runs concurrently with capture (see start()), so its failure
  // can surface while a stop()/mic-failure races it. Track the settled outcome at
  // session scope so both start() and an early stop() observe the same errors.
  // Audio buffered during the handshake lives inside BufferedAsrProvider, not here.
  let asrStartPromise: Promise<void> | null = null;
  let asrStartError: unknown = null;
  let audioFailureError: Error | null = null;
  let voiceInsertion: MobileVoiceDraftInsertion | null = null;
  let voiceInsertionSegmentIds: string[] = [];
  let voiceInsertionTouched = false;
  let caretAnchor: MobileVoiceCaretAnchor | null = null;
  // 锚定光标时同步快照的草稿文本；首次落点前草稿若已变化，锚点即失效。
  let caretAnchorDraft: string | null = null;
  let historyEntryId: string | null = null;
  let historyEntryPromise: Promise<string | null | void> | null = null;
  let pendingHistoryUpdateText: string | null = null;
  let submittedTextForLearning: string | null = null;
  const doneWaiters: Array<() => void> = [];

  const readCurrentDraft = (): string => {
    const visibleDraft = options.readCurrentDraft?.() ?? latestDraft;
    if (
      visibleDraft === lastPublishedDraft
      && (pendingDraftToPublish !== null || draftPublishThrottleTimer !== null)
    ) {
      return latestDraft;
    }
    return visibleDraft;
  };

  const publishDraftNow = (draft: string): void => {
    pendingDraftToPublish = null;
    if (lastPublishedDraft === draft) return;
    lastPublishedDraft = draft;
    options.onDraftChanged(draft);
  };

  const publishPendingDraftNow = (): void => {
    const pending = pendingDraftToPublish;
    if (pending === null) return;
    if (voiceInsertion && !isInsertionIntact(readCurrentDraft(), voiceInsertion)) {
      voiceInsertionTouched = true;
      pendingDraftToPublish = null;
      return;
    }
    publishDraftNow(pending);
  };

  const cancelPendingDraftPublish = (): void => {
    if (draftPublishThrottleTimer) {
      clearTimeout(draftPublishThrottleTimer);
      draftPublishThrottleTimer = null;
    }
    pendingDraftToPublish = null;
  };

  const notifyReadyForStartCue = (): void => {
    try {
      options.onReadyForStartCue?.();
    } catch {
      // Optional feedback only.
    }
  };

  const notifyReadyForEndCue = (): void => {
    try {
      options.onReadyForEndCue?.();
    } catch {
      // Optional feedback only.
    }
  };

  // Called on the first PCM chunk of a run. Surfaces the 'listening' state that
  // was deferred at start until the mic is actually capturing, so the UI's
  // "listening" cue matches real audio flow rather than the ~150-200ms-earlier
  // moment the audio session began warming up.
  const markCaptureLive = (): void => {
    if (captureLive) return;
    captureLive = true;
    if (listeningPendingCaptureLive && state === 'listening') {
      listeningPendingCaptureLive = false;
      options.onStateChanged?.('listening');
    }
  };

  const publishDraftChange = (draft: string, mode: 'deferred' | 'immediate'): void => {
    if (mode === 'immediate') {
      cancelPendingDraftPublish();
      publishDraftNow(draft);
      return;
    }
    if (!draftPublishThrottleTimer) {
      publishDraftNow(draft);
      draftPublishThrottleTimer = setTimeout(() => {
        draftPublishThrottleTimer = null;
        publishPendingDraftNow();
      }, PARTIAL_DRAFT_PUBLISH_INTERVAL_MS);
      return;
    }
    pendingDraftToPublish = draft;
  };

  // Synchronously detect whether the caret anchor is still valid (draft hasn't
  // changed since capture). When stale, invalidates the refinement context so
  // the refiner uses the current draft's end-of-text context instead of the
  // old caret context. Called from both publishText() and stop().
  const reconcileStaleAnchor = (currentDraft: string): void => {
    // A draft difference is expected once this controller has published its
    // own ASR insertion. Preserve the original selection context while that
    // insertion is still intact; only edits inside the insertion invalidate it.
    if (voiceInsertion && isInsertionIntact(currentDraft, voiceInsertion)) return;
    if (caretAnchor !== null && caretAnchorDraft !== currentDraft) {
      refinementSelectionOverride = buildStaleAnchorRefinementContext(currentDraft);
      caretAnchor = null;
      caretAnchorDraft = null;
    }
  };

  const publishText = (
    text: string,
    segmentIds: string[],
    mode: 'deferred' | 'immediate',
  ): EditableRange | undefined => {
    const normalized = text.trim();
    if (!normalized) return undefined;

    const currentDraft = readCurrentDraft();
    latestDraft = currentDraft;

    if (voiceInsertion) {
      if (!isInsertionIntact(currentDraft, voiceInsertion)) {
        voiceInsertionTouched = true;
        return undefined;
      }
      const nextDraft = replaceInsertionText(currentDraft, voiceInsertion, normalized);
      voiceInsertion = {
        start: voiceInsertion.start,
        end: voiceInsertion.start + normalized.length,
        text: normalized,
      };
      voiceInsertionSegmentIds = segmentIds;
      latestDraft = nextDraft;
      publishDraftChange(nextDraft, mode);
      return buildEditableRange(voiceInsertion, segmentIds, voiceInsertionTouched);
    }

    // 录音开始后、首个 ASR 结果返回前用户可能继续编辑草稿：一旦草稿与锚定时
    // 快照不一致，偏移就不再有意义，作废锚点回退到安全的末尾追加。
    const anchorIsFresh = caretAnchor !== null && caretAnchorDraft === currentDraft;
    if (caretAnchor !== null && !anchorIsFresh) {
      reconcileStaleAnchor(currentDraft);
    }
    const result = appendVoiceTranscriptDraftWithRange(currentDraft, normalized, anchorIsFresh ? caretAnchor : null);
    if (!result.insertion) return undefined;
    voiceInsertion = result.insertion;
    voiceInsertionSegmentIds = segmentIds;
    latestDraft = result.draft;
    publishDraftChange(latestDraft, mode);
    return buildEditableRange(result.insertion, segmentIds, false);
  };

  const controller = new VoiceInputController({
    asr,
    refiner,
    logger: new VoiceTimelineLogger(options.onTimelineEvent),
    callbacks: {
      onStateChanged(nextState) {
        if (runPhase === 'failed' && nextState === 'done') {
          // The teardown after a mic failure drives the shared controller to
          // 'done'; the UI already saw 'error' — don't overwrite it.
          doneWaiters.splice(0).forEach((resolve) => resolve());
          return;
        }
        state = nextState;
        if (nextState === 'listening' && !captureLive) {
          // Hold 'listening' from the UI until the mic delivers its first PCM
          // (surfaced by markCaptureLive). Showing it during the ~150-200ms audio
          // warm-up makes users speak into a mic that isn't recording yet.
          listeningPendingCaptureLive = true;
          return;
        }
        options.onStateChanged?.(nextState);
        if (nextState === 'done' || nextState === 'error') {
          doneWaiters.splice(0).forEach((resolve) => resolve());
        }
      },
      onDraftChanged(text, segment, source: VoiceInputDraftSource) {
        publishText(text, [segment.id], source === 'partial' ? 'deferred' : 'immediate');
      },
      onSubmitted(text, segment) {
        const range = publishText(text, [segment.id], 'immediate');
        if (range) {
          submittedTextForLearning = text;
          recordSubmittedHistory(text);
        }
        return range;
      },
      onRefinementPreview(text, _segment, range) {
        publishText(text, range.segmentIds, 'immediate');
      },
      applyRefinement(range, refinedText) {
        const applied = publishText(refinedText, range.segmentIds, 'immediate') !== undefined;
        if (applied) {
          updateSubmittedHistory(refinedText);
          if (voiceInsertion && submittedTextForLearning) {
            options.onRefinementApplied?.({
              draft: latestDraft,
              rawTranscriptText: submittedTextForLearning,
              refinedText,
              start: voiceInsertion.start,
              end: voiceInsertion.end,
            });
          }
        }
        return applied;
      },
      isRangeUserTouched(range) {
        if (range.userTouched || voiceInsertionTouched) return true;
        if (!voiceInsertion) return false;
        const sameRange = range.startOffset === voiceInsertion.start
          && range.segmentIds.every((id, index) => voiceInsertionSegmentIds[index] === id);
        return sameRange && !isInsertionIntact(readCurrentDraft(), voiceInsertion);
      },
      onError(message, code: VoiceInputErrorCode | undefined, details) {
        // 有 code 的是 controller 自己分类的失败(message 是英文调试串),按 code 取
        // 本地化文案;没有 code 的来自 provider,那条 message 才是唯一的失败描述。
        const cause = code
          ? mobileVoiceErrorCodeMessage(code)
          : redactMobileVoiceCredentialText(message, options.credential);
        const localizedMessage = details?.transcriptKept
          ? mobileVoiceTranscriptKeptError(cause)
          : cause;
        controllerError = new Error(localizedMessage);
        options.onError?.(localizedMessage);
      },
    },
  });

  return {
    async start() {
      submittedTextForLearning = null;
      captureLive = false;
      listeningPendingCaptureLive = false;
      // A fresh start() begins a new run from ANY previous phase — in particular
      // 'failed': a mic interruption must not poison the next recording on the
      // same session, so the failure record is cleared here too.
      runPhase = 'running';
      asrStartError = null;
      audioFailureError = null;
      controllerError = null;
      // 录音开始的瞬间锚定输入框光标/选区;后续增量识别都锁在这个区间上,
      // 听写中途用户移动光标也不应让落点漂移。同时快照光标捕获时的草稿，
      // 用于检测「光标位置对应旧草稿」竞态（程序化更新草稿后、onSelectionChange
      // 刷新前用户按麦克风，旧偏移会配对新草稿）。
      caretAnchor = options.readCaret?.() ?? null;
      // 优先用 readCaretDraft（onSelectionChange 同时存的草稿快照），
      // 回退到 readCurrentDraft——后者在竞态场景下会返回新草稿，导致光标
      // 被误判为新鲜。
      const draftAtCaretCapture = options.readCaretDraft?.();
      caretAnchorDraft = caretAnchor ? (draftAtCaretCapture ?? readCurrentDraft()) : null;
      refinementSelectionOverride = null;
      // Connect the ASR socket and open the mic CONCURRENTLY instead of serially.
      // The shared controller sets 'listening' synchronously, so the mic goes live
      // immediately instead of waiting for the ~2.4s WebSocket connect + session
      // handshake (the previous serial ordering awaited connect BEFORE opening the
      // mic). Audio captured during the handshake is buffered and replayed by
      // BufferedAsrProvider once the connect settles, so nothing is lost.
      asrStartPromise = controller.start().then(() => undefined, (error: unknown) => {
        asrStartError = error;
      });
      try {
        stopAudio = await startAudio({
          sampleRate: options.credential.asr.pcmSampleRate ?? 16_000,
          onChunk: (chunk) => {
            // Drop audio emitted after the run began tearing down capture, so an
            // early stop that waits for the in-flight handshake can't buffer and
            // later flush post-stop speech/noise.
            if (captureTornDown()) return;
            markCaptureLive();
            controller.appendAudio(chunk.pcm16, chunk.trace);
          },
          onError: (error) => {
            void handleAudioFailure(error);
          },
        });
      } catch (error) {
        runPhase = 'failed';
        // Surface the mic failure immediately — do NOT wait for the in-flight
        // ASR handshake (a slow/hung connect would otherwise pin the startup
        // and delay the error). controller.cancel() tears the handshake down
        // without blocking on it (BufferedAsrProvider.stop() is non-blocking
        // for an in-flight connect), and asrStartPromise carries its own
        // .catch so the late settle can never become an unhandled rejection.
        await controller.cancel().catch(() => undefined);
        throw redactMobileVoiceError(error, options.credential);
      }
      if (captureTornDown() && stopAudio) {
        // cancel() (or a mic failure) landed while native capture was still
        // opening: its teardown saw stopAudio === null and could not close the
        // capture, so close the just-opened handle here — otherwise the mic and
        // its event subscriptions stay live even though the run is abandoned.
        const stop = stopAudio;
        stopAudio = null;
        await stop().catch(() => undefined);
      }
      // Wait for the ASR connection to settle before declaring the start
      // successful, so a failed handshake still surfaces as a startup error (and
      // the optional start cue is only played once both capture and ASR are up).
      await asrStartPromise;
      if (asrStartError) {
        runPhase = 'failed';
        if (stopAudio) {
          const stop = stopAudio;
          stopAudio = null;
          await stop().catch(() => undefined);
        }
        await controller.cancel().catch(() => undefined);
        throw redactMobileVoiceError(asrStartError, options.credential);
      }
      if (currentRunPhase() === 'failed') {
        // The mic failed while the ASR handshake was still settling.
        // handleAudioFailure already surfaced the error and cancelled the
        // controller; don't report a successful start (the caller would otherwise
        // treat the run as active and could append audio to a cancelled session).
        throw redactMobileVoiceError(
          audioFailureError ?? new Error('Realtime voice capture was interrupted during startup.'),
          options.credential,
        );
      }
      if (currentRunPhase() === 'cancelled') {
        // The user cancelled while the handshake was still settling; the ASR
        // wrapper already tears the just-opened provider down. This is not an
        // error, so return quietly without announcing a successful start.
        return;
      }
      // ASR 会话已建立(refine session 同步就绪),此刻预热润色 prompt cache,
      // 让缓存赶在用户停止说话前热起来。
      warmManagedRefinerPromptCache();
      notifyReadyForStartCue();
    },
    async stop() {
      // Stop native capture FIRST — before awaiting the in-flight ASR handshake.
      // Capture runs concurrently with connect, so waiting for the handshake first
      // would keep the mic live for the whole remaining WebSocket connect; audio the
      // user produces after releasing stop would keep flowing into the buffer and be
      // flushed once ASR settles, transcribing post-stop speech/noise. Entering
      // 'stopping' also makes onChunk drop any straggler chunk from the teardown.
      // Pre-stop audio buffered inside BufferedAsrProvider is still replayed once
      // the connect settles, so short utterances are not lost.
      if (runPhase === 'running') runPhase = 'stopping';
      if (stopAudio) {
        const stop = stopAudio;
        stopAudio = null;
        await stop().catch(() => undefined);
      }
      // Then wait for the ASR handshake to settle (it runs concurrently with
      // capture) so the failure checks below observe its final outcome. The
      // pre-stop audio replay + flush ordering is handled by BufferedAsrProvider.
      if (asrStartPromise) await asrStartPromise.catch(() => undefined);
      if (asrStartError || audioFailureError) {
        // The run is dead — either the ASR handshake failed during an early stop,
        // or the mic failed while the handshake was still settling. Surface it
        // instead of returning a "successful" empty draft the caller shows as
        // done, and don't submit against an already-cancelled controller.
        runPhase = 'failed';
        await controller.cancel().catch(() => undefined);
        throw redactMobileVoiceError(
          asrStartError ?? audioFailureError ?? new Error('Realtime voice capture was interrupted during startup.'),
          options.credential,
        );
      }
      notifyReadyForEndCue();
      // P1 fix: reconcile anchor before optimistic refinement. If the user
      // edited the draft before the first ASR result and then called stop(),
      // publishText() was never called, so the stale-anchor fallback never ran.
      // Without this, the refiner would receive the old caret context instead
      // of the current draft's end-of-text fallback context.
      reconcileStaleAnchor(readCurrentDraft());
      await controller.stop();
      if (state === 'error' || controllerError) {
        runPhase = 'failed';
        throw controllerError ?? new Error(i18n.t('composer.voice.incomplete'));
      }
      if (state === 'submitting' || state === 'refining') await waitForDone(doneWaiters);
      if (runPhase === 'stopping') runPhase = 'idle';
      return latestDraft;
    },
    async cancel() {
      cancelPendingDraftPublish();
      // 'cancelled' makes onChunk drop straggler capture, and tells a start()
      // that is still awaiting the handshake to return quietly. The ASR-side
      // teardown (discard buffered audio, close a socket that only finishes
      // opening later) is handled by BufferedAsrProvider when controller.cancel()
      // reaches its stop().
      runPhase = 'cancelled';
      if (stopAudio) {
        const stop = stopAudio;
        stopAudio = null;
        await stop();
      }
      await controller.cancel();
    },
    currentDraft() {
      return readCurrentDraft();
    },
    currentInsertionEnd() {
      if (!voiceInsertion || !isInsertionIntact(readCurrentDraft(), voiceInsertion)) return null;
      return voiceInsertion.end;
    },
  };

  async function handleAudioFailure(error: Error): Promise<void> {
    // Only a live run can fail: ignore repeated failures, and ignore mic errors
    // surfacing after the run was already cancelled (teardown noise).
    if (runPhase !== 'running' && runPhase !== 'stopping') return;
    runPhase = 'failed';
    audioFailureError = error;
    cancelPendingDraftPublish();
    state = 'error';
    options.onStateChanged?.('error');
    options.onError?.(redactMobileVoiceCredentialText(error, options.credential));
    const stop = stopAudio;
    stopAudio = null;
    try {
      await stop?.();
    } finally {
      await controller.cancel().catch(() => undefined);
    }
  }

  function recordSubmittedHistory(text: string): void {
    if (!options.recordHistory) return;
    // 下面的 .catch 只兜得住异步拒绝;同步抛会顺着 onSubmitted 冒出 controller,
    // 被当成「宿主没接住这段文本」——文字其实已经写进草稿了,而 controller 还会
    // 据此认定本次听写失败。历史记录是附带能力,不该有这个权力。
    let recording: ReturnType<NonNullable<MobileVoiceControllerOptions['recordHistory']>>;
    try {
      recording = options.recordHistory(text);
    } catch (error) {
      console.warn(
        '[mobile-voice] record history failed (non-fatal):',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    historyEntryPromise = Promise.resolve(recording)
      .then((entryId) => {
        if (typeof entryId === 'string' && entryId.trim()) {
          historyEntryId = entryId.trim();
          if (pendingHistoryUpdateText) {
            updateHistoryEntryNow(historyEntryId, pendingHistoryUpdateText);
            pendingHistoryUpdateText = null;
          }
          return historyEntryId;
        }
        return null;
      })
      .catch(() => null);
  }

  function updateSubmittedHistory(text: string): void {
    if (!options.updateHistoryEntry) return;
    pendingHistoryUpdateText = text;
    if (historyEntryId) {
      updateHistoryEntryNow(historyEntryId, text);
      pendingHistoryUpdateText = null;
    }
    void historyEntryPromise;
  }

  function updateHistoryEntryNow(entryId: string, text: string): void {
    if (!options.updateHistoryEntry) return;
    void Promise.resolve(options.updateHistoryEntry(entryId, text)).catch(() => undefined);
  }
}

function buildEditableRange(
  insertion: MobileVoiceDraftInsertion,
  segmentIds: string[],
  userTouched: boolean,
): EditableRange {
  return {
    id: `mobile-voice-range-${segmentIds.join('-')}`,
    segmentIds,
    startOffset: insertion.start,
    endOffset: insertion.end,
    userTouched,
  };
}

function isInsertionIntact(draft: string, insertion: MobileVoiceDraftInsertion): boolean {
  return insertion.start >= 0
    && insertion.end >= insertion.start
    && insertion.end <= draft.length
    && draft.slice(insertion.start, insertion.end) === insertion.text;
}

function replaceInsertionText(
  draft: string,
  insertion: MobileVoiceDraftInsertion,
  text: string,
): string {
  return `${draft.slice(0, insertion.start)}${text}${draft.slice(insertion.end)}`;
}

function redactMobileVoiceError(error: unknown, credential: StoredMobileVoiceCredential): Error {
  const message = redactMobileVoiceCredentialText(
    error instanceof Error ? error.message : String(error),
    credential,
  );
  const redacted = new Error(message);
  if (error instanceof Error) redacted.name = error.name;
  return redacted;
}

function mobileRefinerPromptCacheScope(credential: StoredMobileVoiceCredential): string {
  return `mobile-voice:${credential.hostDeviceId}`;
}

function createMobileRefiner(
  credential: StoredMobileVoiceCredential,
  options: {
    refinementContext?: DictationRefinementContext;
    localVoiceInputHistory?: readonly string[];
    refinerTargetProvider?: (provider: string, options?: { refreshAccessToken?: boolean }) => Promise<{
      url: string;
      authorization: string;
    }>;
    /** 锚点作废后动态注入的润色选区上下文(优先级高于静态 refinementContext)。 */
    readDynamicSelectionContext?: () => DictationRefinementContext | null;
  },
): DictationRefiner | undefined {
  if (credential.settings?.refinementEnabled === false) return undefined;
  const refinerTargetProvider = options.refinerTargetProvider;
  if (!refinerTargetProvider) {
    throw new Error(i18n.t('composer.voice.missingRefinerTargetProvider'));
  }
  // 托管单请求:模型选择与 failover 在 voice-server(provider/model 都传 'auto',
  // 服务端按自己配置的模型链覆盖),客户端不再做多 provider fallback。
  return new DictationRefiner({
    client: new MobileLiteLlmTextModelClient({
      requestTargetProvider: (requestOptions) =>
        refinerTargetProvider(CINDY_MANAGED_REFINER_PROVIDER, requestOptions),
    }),
    model: CINDY_MANAGED_REFINER_PROVIDER,
    promptCacheScope: mobileRefinerPromptCacheScope(credential),
    contextProvider: () => {
      const context = buildMobileVoiceRefinementContext(credential, {
        refinementContext: options.refinementContext,
        localVoiceInputHistory: options.localVoiceInputHistory,
        // 词典来自被控桌面的只读快照缓存(拉取在开麦时异步触发)。桌面离线或还没
        // 拉到时是空数组 —— 润色照常进行,只是少了术语提示。
        dictionaryEntries: readCachedMobileVoiceDictionary(credential.hostDeviceId),
      });
      const dynamicSelection = options.readDynamicSelectionContext?.();
      return dynamicSelection ? { ...context, ...dynamicSelection } : context;
    },
  });
}

function waitForDone(waiters: Array<() => void>): Promise<void> {
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}
