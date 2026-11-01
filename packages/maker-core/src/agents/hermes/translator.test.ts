import { describe, expect, it } from 'vitest';

import { normalizeHermesEvent, parseSessionIdFromStderr } from './translator.js';

describe('normalizeHermesEvent', () => {
  it('normalizes the daemon session-bound lifecycle event', () => {
    expect(
      normalizeHermesEvent({ type: 'hermes-mgr', subtype: 'session-bound', hermesSessionId: 'h-1' }),
    ).toEqual({ kind: 'session-bound', hermesSessionId: 'h-1' });
  });

  it('normalizes the daemon resume-reset lifecycle event', () => {
    expect(
      normalizeHermesEvent({
        type: 'hermes-mgr',
        subtype: 'resume-reset',
        previousHermesSessionId: 'local-gone',
      }),
    ).toEqual({ kind: 'resume-reset', previousHermesSessionId: 'local-gone' });
    expect(normalizeHermesEvent({ type: 'hermes-mgr', subtype: 'resume-reset' }))
      .toEqual({ kind: 'resume-reset' });
  });

  it('normalizes the CLI init event into the model the run used', () => {
    expect(
      normalizeHermesEvent({
        type: 'system',
        subtype: 'init',
        model: 'deepseek-flash',
        session_id: '',
      }),
    ).toEqual({ kind: 'session-init', model: 'deepseek-flash' });
    // The init's session_id is the daemon's business, not the agent's.
    expect(
      normalizeHermesEvent({ type: 'system', subtype: 'init', model: 'deepseek-flash', session_id: 'h-1' }),
    ).toEqual({ kind: 'session-init', model: 'deepseek-flash' });
    expect(normalizeHermesEvent({ type: 'system', subtype: 'init' })).toEqual({
      kind: 'session-init',
    });
  });

  it('leaves other system events unknown', () => {
    expect(normalizeHermesEvent({ type: 'system', subtype: 'something-new' })).toMatchObject({
      kind: 'unknown',
    });
  });

  it('normalizes text deltas and drops the empty sentinel', () => {
    expect(normalizeHermesEvent({ type: 'text', text: 'Hello ' })).toEqual({
      kind: 'assistant-delta',
      text: 'Hello ',
    });
    expect(normalizeHermesEvent({ type: 'text', text: '' })).toEqual({
      kind: 'unknown',
      event: { type: 'text', text: '' },
    });
  });

  it('normalizes tool_use with optional fields', () => {
    expect(
      normalizeHermesEvent({ type: 'tool_use', name: 'terminal', tool_call_id: 't1', input: { cmd: 'ls' } }),
    ).toEqual({ kind: 'tool-use', name: 'terminal', toolCallId: 't1', input: { cmd: 'ls' } });
    expect(normalizeHermesEvent({ type: 'tool_use', name: 'read' })).toEqual({
      kind: 'tool-use',
      name: 'read',
    });
  });

  it('normalizes tool_result with error flag and duration', () => {
    expect(
      normalizeHermesEvent({
        type: 'tool_result',
        name: 'terminal',
        tool_call_id: 't1',
        output: 'file.txt',
        duration_ms: 4,
        is_error: false,
      }),
    ).toEqual({
      kind: 'tool-result',
      name: 'terminal',
      toolCallId: 't1',
      output: 'file.txt',
      durationMs: 4,
      isError: false,
    });
    expect(
      normalizeHermesEvent({ type: 'tool_result', name: 'terminal', output: 'nope', is_error: true }),
    ).toEqual({
      kind: 'tool-result',
      name: 'terminal',
      output: 'nope',
      isError: true,
    });
  });

  it('normalizes the terminal result with token normalization', () => {
    expect(
      normalizeHermesEvent({
        type: 'result',
        session_id: 'h-1',
        exit_code: 0,
        text: 'done',
        tokens: { input: 10, output: 5, total: 15 },
        duration_ms: 42,
      }),
    ).toEqual({
      kind: 'turn-complete',
      hermesSessionId: 'h-1',
      exitCode: 0,
      text: 'done',
      tokens: { input: 10, output: 5, total: 15, cacheRead: 0, cacheWrite: 0 },
      durationMs: 42,
    });
  });

  it('keeps result errors and replay gaps', () => {
    const normalized = normalizeHermesEvent({
      type: 'result',
      exit_code: 1,
      text: '',
      tokens: {},
      error: 'provider down',
      replay_gap: true,
    });
    expect(normalized).toMatchObject({
      kind: 'turn-complete',
      exitCode: 1,
      error: 'provider down',
      replayGap: true,
    });
  });

  it('never throws: junk in, unknown out', () => {
    expect(normalizeHermesEvent(null)).toMatchObject({ kind: 'unknown' });
    expect(normalizeHermesEvent('text')).toMatchObject({ kind: 'unknown' });
    expect(normalizeHermesEvent([])).toMatchObject({ kind: 'unknown' });
    expect(normalizeHermesEvent({ type: 'brand-new-future-event', data: 1 })).toMatchObject({
      kind: 'unknown',
    });
    expect(normalizeHermesEvent({ type: 'tool_use' })).toMatchObject({ kind: 'unknown' }); // no name
  });
});

describe('parseSessionIdFromStderr', () => {
  it('extracts the session trailer line', () => {
    expect(parseSessionIdFromStderr('noise\nsession_id: h-abc\n')).toBe('h-abc');
  });

  it('returns undefined when absent', () => {
    expect(parseSessionIdFromStderr('no trailer here')).toBeUndefined();
  });
});
