// Codex's response timing trace line, the RUST_LOG filter that turns it on, and keeping that
// filter out of the commands Codex runs. Unit tier through the module's public functions.
// - Parse: the line format is undocumented and its fields are null in some Codex releases
//   (openai/codex#56481); a misread line must fall back to the client's own measurement.
// - Command environment: Codex passes its environment to the commands it runs (verified with
//   0.166.0: `echo $RUST_LOG` printed the filter). Replacing the user's exclusion list would
//   expose variables they keep from commands, so it is extended, never replaced unread.
import { describe, expect, it } from 'vitest';

import {
  codexCommandRustLogExclusion,
  parseCodexResponseTiming,
  withResponseTimingLogFilter,
} from './response-timing.js';

const ESC = '\u001b';
const field = (name: string, value: string): string => `${ESC}[3m${name}${ESC}[0m${ESC}[2m=${ESC}[0m${value}`;

/** A trace line as Codex 0.166.0 writes it (colours included), ids replaced. */
function timingLine(metrics: Record<string, unknown>, warmup = false): string {
  const payload = JSON.stringify({ type: 'responsesapi.websocket_timing', timing_metrics: metrics });
  return [
    `${ESC}[2m2026-11-22T09:01:24.836523Z${ESC}[0m ${ESC}[35mTRACE${ESC}[0m`,
    `${ESC}[2mcodex_api::responses_websocket_timing${ESC}[0m${ESC}[2m:${ESC}[0m responses websocket timing`,
    field('model', '"gpt-6.2-sol"'),
    field('session_id', '"thread-1"'),
    field('thread_id', '"thread-1"'),
    field('turn_id', '"turn-1"'),
    field('previous_response_id', '"resp_0000"'),
    field('warmup', String(warmup)),
    field('payload', JSON.stringify(payload)),
  ].join(' ');
}

const recordedMetrics = {
  timing_scope: 'logical_turn',
  response_id: 'resp_0001',
  num_sampled_tokens_total: 174,
  critical_path: { scope: 'response', coverage: 'complete', engine_iapi_total_ms: 1561.0, sampling_and_stream_total_ms: 894.0 },
};

describe('parseCodexResponseTiming', () => {
  it('reads the turn, the running sampled total and the sampling time of one response', () => {
    expect(parseCodexResponseTiming(timingLine(recordedMetrics))).toEqual({
      threadId: 'thread-1',
      turnId: 'turn-1',
      responseId: 'resp_0001',
      sampledTokensTotal: 174,
      samplingMs: 894,
    });
  });

  it.each([
    ['the warm-up request', timingLine({ ...recordedMetrics, num_sampled_tokens_total: 0 }, true)],
    ['a release that leaves the sampling time null', timingLine({
      ...recordedMetrics,
      critical_path: { ...recordedMetrics.critical_path, sampling_and_stream_total_ms: null },
    })],
    ['a response that sampled nothing', timingLine({ ...recordedMetrics, num_sampled_tokens_total: 0 })],
    ['a payload cut off mid-line', timingLine(recordedMetrics).slice(0, -40)],
    ['any other stderr line', 'ERROR codex_core::client: stream disconnected'],
  ])('ignores %s', (_name, line) => {
    expect(parseCodexResponseTiming(line)).toBeUndefined();
  });
});

describe('withResponseTimingLogFilter', () => {
  it('keeps what Codex already writes and adds only the timing target', () => {
    // Codex writes nothing below error to stderr by default.
    expect(withResponseTimingLogFilter(undefined)).toBe('error,codex_api::responses_websocket_timing=trace');
    expect(withResponseTimingLogFilter('codex_core=debug')).toBe('codex_core=debug,codex_api::responses_websocket_timing=trace');
  });
});

describe('codexCommandRustLogExclusion', () => {
  it('adds RUST_LOG to the exclusions the user already has, or to none', () => {
    expect(codexCommandRustLogExclusion({ exclude: null, set: null })).toEqual({ 'shell_environment_policy.exclude': ['RUST_LOG'] });
    expect(codexCommandRustLogExclusion({ exclude: ['AWS_*', 'MY_SECRET'] }))
      .toEqual({ 'shell_environment_policy.exclude': ['AWS_*', 'MY_SECRET', 'RUST_LOG'] });
    expect(codexCommandRustLogExclusion({ exclude: ['RUST_LOG'] })).toEqual({});
  });

  it('changes nothing when the existing list cannot be read', () => {
    expect(codexCommandRustLogExclusion({ exclude: 'AWS_*' })).toBeUndefined();
    expect(codexCommandRustLogExclusion({ exclude: [1] })).toBeUndefined();
    expect(codexCommandRustLogExclusion('inherit')).toBeUndefined();
  });
});
