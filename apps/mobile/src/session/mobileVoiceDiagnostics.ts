import type { VoiceTimelineEvent } from '@cindy/voice-input-core';
import { mobileDebugLog, type MobileDebugLevel } from '@/debug/mobileDebugLog';

/**
 * Voice-input diagnostics for the phone-local Debug log (Settings → 调试), and
 * the Metro console in development builds.
 *
 * Privacy boundary: dictated text is user content and is never recorded, not
 * even in development. Events carry types, timings, reason codes, provider ids
 * and character counts only — enough to follow a run from tap to refinement
 * without knowing what was said.
 */
export type MobileVoiceDiagnosticFields = Record<
  string,
  string | number | boolean | undefined | readonly string[]
>;

export function logMobileVoice(
  level: MobileDebugLevel,
  message: string,
  fields: MobileVoiceDiagnosticFields = {},
): void {
  mobileDebugLog(level, 'voice', message, fields);
  if (!__DEV__) return;
  const log = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  log('[mobile-voice]', message, fields);
}

// Refiner rejection reasons are codes. Anything else is an error message.
const REFINE_REJECTION_CODES = new Set([
  'empty_input',
  'empty_output',
  'no_change',
  'diverged_too_far',
  'unknown',
]);

function rejectionReason(reason: string): string {
  return REFINE_REJECTION_CODES.has(reason) ? reason : classifyMobileVoiceFailure(reason);
}

const FAILURE_PATTERNS: Array<[RegExp, string]> = [
  [/不可优化|次数已用完/, 'refine_quota_exhausted'],
  [/rate.?limit|too many|频繁|\b429\b/i, 'rate_limited'],
  [/timed? ?out|timeout|超时/i, 'timeout'],
  [/json|parse|unexpected token|malformed/i, 'parse_error'],
  [/permission|denied|权限/i, 'permission'],
  [/stopped|cancel/i, 'cancelled'],
  [/network|socket|connect|closed|连接|中断/i, 'connection'],
];

/**
 * A fixed failure code for logs. Never returns the message itself: error text
 * can quote a provider response (a malformed refinement embeds the model's
 * output), which may contain dictated words. Structured API errors keep their
 * server code and HTTP status, which are enums, not content.
 */
export function classifyMobileVoiceFailure(error: unknown): string {
  if (error && typeof error === 'object') {
    const { code, status } = error as { code?: unknown; status?: unknown };
    if (
      typeof code === 'string' &&
      /^[A-Z][A-Z0-9_]{1,40}$/.test(code) &&
      typeof status === 'number'
    ) {
      return `api_${code.toLowerCase()}_${status}`;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  const status = /\bstatus (\d{3})\b/i.exec(message)?.[1];
  if (status) return `http_${status}`;
  return FAILURE_PATTERNS.find(([pattern]) => pattern.test(message))?.[1] ?? 'other';
}

export function shortRunId(runId: string): string {
  return runId.slice(-8);
}

const chars = (text: string | undefined): number | undefined =>
  text === undefined ? undefined : text.length;

type RunTrace = {
  startAt: number;
  events: Map<string, number>;
  partialDrafts: number;
  refinementDrafts: number;
  refineRequests: number;
};

/**
 * Projects controller timeline events into text-free diagnostics and emits a
 * per-run latency summary at submit and at the refinement outcome (mirrors
 * desktop's "latency summary" / "refinement latency summary").
 */
export function createMobileVoiceTimelineRecorder(context: {
  provider: string;
}): (event: VoiceTimelineEvent) => void {
  const runs = new Map<string, RunTrace>();
  const traceFor = (event: VoiceTimelineEvent): RunTrace => {
    let trace = runs.get(event.runId);
    if (!trace) {
      trace = {
        startAt: event.at,
        events: new Map(),
        partialDrafts: 0,
        refinementDrafts: 0,
        refineRequests: 0,
      };
      runs.set(event.runId, trace);
      // A session is created per recording; keep only the latest few runs.
      if (runs.size > 4) runs.delete(runs.keys().next().value as string);
    }
    if (!trace.events.has(event.type)) trace.events.set(event.type, event.at);
    return trace;
  };
  const since = (trace: RunTrace, type: string): number | undefined => {
    const at = trace.events.get(type);
    return at === undefined ? undefined : at - trace.startAt;
  };

  return (event) => {
    const trace = traceFor(event);
    // Ids are UUIDs or, without crypto.randomUUID (React Native), a fixed
    // "voice-" prefix plus time and random parts: the tail is what differs.
    const runId = shortRunId(event.runId);
    switch (event.type) {
      case 'draft_changed':
        // Every ASR partial lands here; count instead of logging each one.
        if (event.source === 'refinement') {
          trace.refinementDrafts += 1;
          logMobileVoice('debug', 'pause refinement shown', { runId, chars: chars(event.text) });
        } else {
          trace.partialDrafts += 1;
        }
        return;
      case 'first_partial':
        logMobileVoice('debug', 'first partial', {
          runId,
          elapsedMs: Math.round(event.elapsedMs),
          chars: chars(event.text),
        });
        return;
      case 'first_audio_chunk':
      case 'asr_connected':
        logMobileVoice('debug', event.type.replace(/_/g, ' '), {
          runId,
          elapsedMs: Math.round(event.elapsedMs),
        });
        return;
      case 'start_clicked':
      case 'stop_clicked':
      case 'cancelled':
        logMobileVoice('debug', event.type.replace(/_/g, ' '), {
          runId,
          elapsedMs: since(trace, event.type),
        });
        return;
      case 'stable_received':
        logMobileVoice('debug', 'stable received', {
          runId,
          elapsedMs: event.at - trace.startAt,
          chars: chars(event.text),
        });
        return;
      case 'submitted':
        logMobileVoice('info', 'latency summary', {
          runId,
          provider: context.provider,
          submitSource: event.source,
          chars: chars(event.text),
          firstAudioChunkMs: since(trace, 'first_audio_chunk'),
          asrConnectedMs: since(trace, 'asr_connected'),
          firstPartialMs: since(trace, 'first_partial'),
          stopMs: since(trace, 'stop_clicked'),
          submittedMs: event.at - trace.startAt,
          stopToSubmitMs: trace.events.has('stop_clicked')
            ? event.at - trace.events.get('stop_clicked')!
            : undefined,
          partialDrafts: trace.partialDrafts,
          pauseRefinementDrafts: trace.refinementDrafts,
        });
        return;
      case 'refine_requested':
        trace.refineRequests += 1;
        logMobileVoice('debug', 'refine requested', {
          runId,
          chars: chars(event.text),
          request: trace.refineRequests,
          duringRecording: !trace.events.has('stop_clicked'),
        });
        return;
      case 'speculative_refine_skipped':
        logMobileVoice('info', 'speculative refinement skipped', {
          runId,
          stage: event.stage,
          reason: event.reason,
          requestLimit: event.requestLimit,
          requestsStarted: event.requestsStarted,
        });
        return;
      case 'refine_discarded':
        logMobileVoice('debug', 'refine discarded', {
          runId,
          reason: event.reason,
          chars: chars(event.basedOnText),
        });
        return;
      case 'refine_accepted':
      case 'refine_rejected': {
        const accepted = event.type === 'refine_accepted';
        const stopAt = trace.events.get('stop_clicked');
        // "no_change" means the dictation was already clean — a normal outcome.
        const expected =
          accepted || (event.type === 'refine_rejected' && event.reason === 'no_change');
        logMobileVoice(expected ? 'info' : 'warn', 'refinement latency summary', {
          runId,
          outcome: accepted ? 'accepted' : 'rejected',
          reason: accepted ? undefined : rejectionReason(event.reason),
          elapsedMs: event.elapsedMs === undefined ? undefined : Math.round(event.elapsedMs),
          stopToRefinedMs: stopAt === undefined ? undefined : event.at - stopAt,
          refineRequests: trace.refineRequests,
          basedOnChars: chars(event.basedOnText),
          refinedChars: chars(event.refinedText),
        });
        return;
      }
      case 'refine_applied':
        logMobileVoice('debug', 'refine applied', { runId, chars: chars(event.refinedText) });
        return;
      case 'refine_skipped_user_touched':
        logMobileVoice('info', 'refine skipped: user edited the text', { runId });
        return;
      case 'asr_stall_warning':
      case 'asr_recovery_attempted':
        logMobileVoice('warn', event.type.replace(/_/g, ' '), {
          runId,
          ...('trigger' in event ? { trigger: event.trigger, attempt: event.attempt } : {}),
          audioMsSinceLastSignal: Math.round(event.audioMsSinceLastSignal),
          voicedAudioMsSinceLastSignal: Math.round(event.voicedAudioMsSinceLastSignal),
          wallMsSinceLastSignal: Math.round(event.wallMsSinceLastSignal),
          everSawSignal: event.everSawSignal,
        });
        return;
      case 'asr_recovery_succeeded':
        logMobileVoice('info', 'asr recovery succeeded', {
          runId,
          elapsedMs: Math.round(event.elapsedMs),
        });
        return;
      case 'asr_recovery_failed':
        logMobileVoice('warn', 'asr recovery failed', {
          runId,
          elapsedMs: Math.round(event.elapsedMs),
          reason: classifyMobileVoiceFailure(event.reason),
        });
        return;
      case 'asr_stop_error_ignored':
        logMobileVoice('warn', 'asr error after stop ignored', {
          runId,
          reason: classifyMobileVoiceFailure(event.message),
          textChars: event.textChars,
        });
        return;
      case 'transcript_salvaged':
        logMobileVoice('warn', 'transcript salvaged', {
          runId,
          chars: chars(event.text),
          source: event.source,
          accepted: event.accepted,
        });
        return;
      case 'error':
        logMobileVoice('error', 'run failed', {
          runId,
          reason: classifyMobileVoiceFailure(event.message),
        });
        return;
    }
  };
}
