import type { AsrEvent, AsrProvider, AudioTrace } from '@cindy/voice-input-core';

import { createLogger } from '../logger.js';
import {
  markVoiceInputProviderFailure,
  markVoiceInputProviderSuccess,
} from './VoiceInputProviderHealth.js';
import type { VoiceInputProviderKind } from './voiceInputAsrConfig.js';

const log = createLogger('voice-input:asr-fallback');

// appendAudio() arriving before any candidate finished start() is buffered and
// replayed once a provider connects. The IPC audio path only pumps after
// controller.start() resolves, so this buffer is a safety net for in-process
// callers; the cap only guards against a pathological caller, at 100ms chunks
// it covers well over a minute of audio.
const MAX_PENDING_AUDIO_CHUNKS = 1_024;
/**
 * After this grace period an unresolved candidate is considered slow enough
 * to justify starting the next candidate.  This is deliberately a staggered
 * hedge rather than Promise.any(all providers): only one additional upstream
 * session is opened at a time and every losing session is explicitly closed.
 */
const DEFAULT_HEDGE_DELAY_MS = 1_500;

export type FallbackAsrCandidate = {
  kind: VoiceInputProviderKind;
  /** Lazily constructs the underlying provider; only called when this candidate is attempted. */
  create: () => Promise<AsrProvider>;
};

export type FallbackAsrProviderOptions = {
  /** Delay between launching unresolved candidates. Defaults to 1.5s; null disables hedging. */
  hedgeDelayMs?: number | null;
};

type CandidateAttemptResult = {
  index: number;
  status: 'success' | 'failed' | 'cancelled';
  phase?: 'create' | 'start';
  error?: unknown;
};

type CandidateAttempt = {
  index: number;
  provider: AsrProvider | null;
  started: boolean;
  cancelled: boolean;
  cleanupPromise: Promise<void> | null;
  /**
   * Providers emit `connected` from inside start(), before this wrapper has
   * committed them as active. Hold that event so the controller's
   * `asr_connected` timeline entry is replayed once the candidate wins instead
   * of being dropped by the active-only forwarding filter.
   */
  connectedEvent: AsrEvent | null;
  promise: Promise<CandidateAttemptResult>;
};

/**
 * Connect-phase fallback wrapper around the configured ASR provider chain.
 *
 * `start()` walks the candidates in priority order: the first provider whose
 * `start()` resolves becomes the active provider for the whole dictation
 * session. Failed candidates are put into the sticky-failover cooldown (see
 * VoiceInputProviderHealth) so the next dictation skips ahead of them.
 *
 * Deliberately NOT covered (per design): mid-session hot switching. Once a
 * provider is active, a mid-stream transport failure follows the existing
 * single-provider `recover()` path; switching providers mid-dictation would
 * lose already-streamed audio and create transcript seams.
 */
export class FallbackAsrProvider implements AsrProvider {
  private readonly candidates: FallbackAsrCandidate[];
  private readonly hedgeDelayMs: number | null;
  private active: AsrProvider | null = null;
  private activeKind: VoiceInputProviderKind | null = null;
  private readonly eventCallbacks: Array<(event: AsrEvent) => void> = [];
  private readonly pendingAudio: Array<{ chunk: ArrayBuffer; trace?: AudioTrace }> = [];
  private pendingAudioOverflowWarned = false;
  private disposed = false;
  private stopping = false;
  private readonly attempts = new Map<number, CandidateAttempt>();

  /**
   * Assigned in start() only when the committed provider itself supports
   * recovery. VoiceInputController feature-detects `typeof recover ===
   * 'function'`, so unconditionally exposing a method here would make the
   * controller attempt (and log) recovery on providers that cannot recover.
   */
  recover?: () => Promise<void>;

  constructor(candidates: FallbackAsrCandidate[], options: FallbackAsrProviderOptions = {}) {
    if (candidates.length === 0) {
      throw new Error('FallbackAsrProvider requires at least one ASR provider candidate.');
    }
    this.candidates = candidates;
    this.hedgeDelayMs = options.hedgeDelayMs === null
      ? null
      : Math.max(0, options.hedgeDelayMs ?? DEFAULT_HEDGE_DELAY_MS);
  }

  /** Provider kind that actually connected; null until start() succeeds. */
  get activeProviderKind(): VoiceInputProviderKind | null {
    return this.activeKind;
  }

  async start(): Promise<void> {
    if (this.active) return;
    if (this.disposed) throw new Error('Voice input ASR fallback disposed during start.');
    let lastError: unknown = null;
    const failures: Array<{
      kind: VoiceInputProviderKind;
      phase: 'create' | 'start';
      message: string;
      error: unknown;
    }> = [];
    let nextIndex = 0;
    let nextLaunchAt = Date.now();
    const launch = (index: number): void => {
      const attempt = this.startCandidate(index);
      this.attempts.set(index, attempt);
      nextIndex = Math.max(nextIndex, index + 1);
      // The delay is relative to this launch, not to the original primary.
      // Explicit failures call launch() immediately, so the following hedge
      // should still get a fresh grace period rather than inheriting a stale
      // timer and drifting farther out with every failed candidate.
      nextLaunchAt = this.hedgeDelayMs === null
        ? Number.POSITIVE_INFINITY
        : Date.now() + this.hedgeDelayMs;
    };

    launch(nextIndex);
    while (!this.active && !this.disposed) {
      const pending = [...this.attempts.values()];
      const waitMs = this.hedgeDelayMs !== null && nextIndex < this.candidates.length
        ? Math.max(0, nextLaunchAt - Date.now())
        : null;
      let timerHandle: ReturnType<typeof setTimeout> | undefined;
      const timer = waitMs === null
        ? new Promise<'timer'>(() => undefined)
        : new Promise<'timer'>((resolve) => {
          timerHandle = setTimeout(() => resolve('timer'), waitMs);
        });
      let result: CandidateAttemptResult | 'timer';
      try {
        result = await Promise.race([
          ...pending.map((attempt) => attempt.promise),
          timer,
        ]);
      } finally {
        if (timerHandle !== undefined) clearTimeout(timerHandle);
      }
      if (result === 'timer') {
        // A timer from a previous race may still fire after an explicit
        // candidate failure launched the next attempt. Ignore that stale tick
        // and wait for the current deadline instead of opening a third socket
        // earlier than the configured hedge interval.
        if (this.hedgeDelayMs !== null && Date.now() >= nextLaunchAt && !this.active && !this.disposed && nextIndex < this.candidates.length) {
          launch(nextIndex);
        }
        continue;
      }
      this.attempts.delete(result.index);
      if (result.status === 'failed') {
        lastError = result.error;
        const candidate = this.candidates[result.index];
        failures.push(this.handleCandidateFailure(
          candidate.kind,
          result.index,
          result.phase ?? 'start',
          result.error,
        ));
        // An explicit failure should not wait for the hedge timer. Start the
        // next candidate immediately while retaining the timer for the one
        // after it.
        if (!this.active && !this.disposed && this.attempts.size === 0 && nextIndex < this.candidates.length) {
          launch(nextIndex);
        }
      }
      // A successful attempt commits active before resolving its result.
      if (this.active) break;
      if (this.attempts.size === 0 && nextIndex >= this.candidates.length) break;
    }
    if (this.disposed) throw new Error('Voice input ASR fallback disposed during start.');
    if (this.active) return;
    // Aggregate every candidate's failure instead of surfacing only the last
    // one: a chain-wide outage (e.g. issue #220, gateway missing all ASR
    // passthrough routes) is undiagnosable from a single tail error. Keep the
    // original error object when only one candidate exists so callers see its
    // exact type/stack (e.g. missing-credential messages).
    if (failures.length <= 1) {
      throw lastError instanceof Error
        ? lastError
        : new Error('All voice input ASR providers failed to start.');
    }
    const details = failures
      .map((failure) => `[${failure.kind} ${failure.phase}] ${failure.message}`)
      .join('; ');
    // AggregateError keeps every original error object (stack, cause, e.g.
    // ECONNREFUSED / TLS details) reachable via `.errors` for logging and
    // telemetry, while `.message` stays the human-readable summary above.
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `All ${failures.length} voice input ASR providers failed to start: ${details}`,
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const attempt of this.attempts.values()) attempt.cancelled = true;
    const providers = [...this.attempts.values()]
      .filter((attempt) => attempt.provider !== null);
    await Promise.all([
      this.active?.stop(),
      ...providers.map((attempt) => this.cleanupAttempt(attempt)),
    ]);
    this.stopping = false;
  }

  appendAudio(chunk: ArrayBuffer, trace?: AudioTrace): void {
    if (this.active) {
      this.active.appendAudio(chunk, trace);
      return;
    }
    if (this.pendingAudio.length >= MAX_PENDING_AUDIO_CHUNKS) {
      if (!this.pendingAudioOverflowWarned) {
        this.pendingAudioOverflowWarned = true;
        log.warn('pending audio buffer overflow before ASR connect, dropping oldest chunks');
      }
      this.pendingAudio.shift();
    }
    this.pendingAudio.push({ chunk, trace });
  }

  async flushAudio(): Promise<void> {
    if (!this.active) return;
    await this.active.flushAudio();
  }

  onEvent(callback: (event: AsrEvent) => void): void {
    this.eventCallbacks.push(callback);
  }

  private async recoverActiveProvider(
    provider: AsrProvider,
    kind: VoiceInputProviderKind,
  ): Promise<void> {
    try {
      await provider.recover!();
    } catch (error) {
      // Recovery exhausted mid-session: the run ends as today, but the sticky
      // cooldown makes the NEXT dictation start from the following candidate.
      markVoiceInputProviderFailure(
        'asr',
        kind,
        `recover failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const attempt of this.attempts.values()) attempt.cancelled = true;
    const attempts = [...this.attempts.values()];
    await Promise.all([
      this.active
        ? this.active.dispose?.()
        : undefined,
      ...attempts
        .filter((attempt) => attempt.provider !== null && attempt.provider !== this.active)
        .map((attempt) => this.cleanupAttempt(attempt)),
    ]);
  }

  private startCandidate(index: number): CandidateAttempt {
    const candidate = this.candidates[index];
    const attempt: CandidateAttempt = {
      index,
      provider: null,
      started: false,
      cancelled: false,
      cleanupPromise: null,
      connectedEvent: null,
      promise: Promise.resolve({ index, status: 'cancelled' as const }),
    };
    attempt.promise = (async (): Promise<CandidateAttemptResult> => {
      let provider: AsrProvider;
      try {
        provider = await candidate.create();
      } catch (error) {
        if (attempt.cancelled || this.disposed || this.active) return { index, status: 'cancelled' };
        return {
          index,
          status: 'failed',
          phase: 'create',
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
      attempt.provider = provider;
      if (attempt.cancelled || this.disposed || this.active || this.stopping) {
        await this.cleanupAttempt(attempt);
        return { index, status: 'cancelled' };
      }
      provider.onEvent((event) => {
        if (this.active === provider) {
          for (const callback of this.eventCallbacks) callback(event);
          return;
        }
        if (event.type === 'connected' && !attempt.connectedEvent) {
          attempt.connectedEvent = event;
        }
      });
      try {
        attempt.started = true;
        // Each provider owns its connection deadline (measured from the socket
        // dial, after credential/proxy lookup). A wrapper-level cap that starts
        // earlier can reject a slow-but-valid connection; the staggered hedge
        // above is the only mechanism for advancing past a slow candidate.
        await provider.start();
      } catch (error) {
        if (attempt.cancelled || this.disposed || this.active) {
          await this.cleanupAttempt(attempt);
          return { index, status: 'cancelled' };
        }
        // Closing a failed socket must not hold up the next candidate. The
        // cleanup path is idempotent and consumes its own errors, so it can
        // finish in parallel with the fallback connection.
        void this.cleanupAttempt(attempt);
        return {
          index,
          status: 'failed',
          phase: 'start',
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
      if (attempt.cancelled || this.disposed || this.active || this.stopping) {
        await this.cleanupAttempt(attempt);
        return { index, status: 'cancelled' };
      }
      this.active = provider;
      this.activeKind = candidate.kind;
      this.recover = provider.recover
        ? () => this.recoverActiveProvider(provider, candidate.kind)
        : undefined;
      markVoiceInputProviderSuccess('asr', candidate.kind);
      if (attempt.connectedEvent) {
        const connected = attempt.connectedEvent;
        attempt.connectedEvent = null;
        for (const callback of this.eventCallbacks) callback(connected);
      }
      if (index > 0) {
        log.info('asr fallback succeeded', {
          provider: candidate.kind,
          attempt: index + 1,
          skipped: this.candidates.slice(0, index).map((skipped) => skipped.kind),
        });
      }
      this.flushPendingAudio(provider);
      // Cancel every still-pending loser as soon as a winner is committed.
      for (const other of this.attempts.values()) {
        if (other.index === index) continue;
        other.cancelled = true;
        if (other.provider) {
          void this.cleanupAttempt(other);
        }
        this.attempts.delete(other.index);
      }
      return { index, status: 'success' };
    })();
    return attempt;
  }

  private cleanupAttempt(attempt: CandidateAttempt): Promise<void> {
    if (!attempt.provider) return Promise.resolve();
    if (!attempt.cleanupPromise) {
      attempt.cleanupPromise = this.disposeCandidate(
        attempt.provider,
        this.candidates[attempt.index].kind,
        attempt.started,
      );
    }
    return attempt.cleanupPromise;
  }

  private async disposeCandidate(provider: AsrProvider, kind: VoiceInputProviderKind, started = true): Promise<void> {
    if (started) await provider.stop().catch(() => undefined);
    await provider.dispose?.().catch((disposeError: unknown) => {
      log.debug('failed ASR candidate dispose error ignored', {
        provider: kind,
        error: disposeError instanceof Error ? disposeError.message : String(disposeError),
      });
    });
  }

  private handleCandidateFailure(
    kind: VoiceInputProviderKind,
    index: number,
    phase: 'create' | 'start',
    error: unknown,
  ): { kind: VoiceInputProviderKind; phase: 'create' | 'start'; message: string; error: unknown } {
    const message = error instanceof Error ? error.message : String(error);
    markVoiceInputProviderFailure('asr', kind, `${phase} failed: ${message}`);
    log.warn('asr fallback candidate failed, trying next', {
      provider: kind,
      attempt: index + 1,
      totalCandidates: this.candidates.length,
      phase,
      error: message,
    });
    return { kind, phase, message, error };
  }

  private flushPendingAudio(provider: AsrProvider): void {
    for (const { chunk, trace } of this.pendingAudio) {
      provider.appendAudio(chunk, trace);
    }
    this.pendingAudio.length = 0;
  }
}
