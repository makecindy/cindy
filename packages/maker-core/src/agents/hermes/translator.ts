/**
 * Translator: hermes-mgr `query/event` payloads → normalized maker-core
 * shapes for the future HermesAgent (M2b).
 *
 * Hermes emits its own stream-json vocabulary (system/init, text, tool_use,
 * tool_result, result); hermes-mgr adds synthesized lifecycle events
 * (type 'hermes-mgr'). This module is pure and dependency-free so it can be
 * unit-tested without a Hermes process and reused by the agent, the session
 * store, and usage metering. Unrecognized events normalize to `unknown`
 * instead of throwing — forward compatibility is a hard requirement here
 * because Hermes evolves its event set independently of this repo.
 */

export type NormalizedHermesTokens = {
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
};

export type NormalizedHermesEvent =
  | { kind: 'session-bound'; hermesSessionId: string }
  | { kind: 'resume-reset'; previousHermesSessionId?: string }
  /**
   * `system/init` — the route the CLI actually launched with. It carries the
   * model id the turn ran on, which is the only per-turn model fact Hermes
   * reports (the Cindy-side session model is a sentinel or an override, and
   * the home default can change between turns). The session id on init is
   * deliberately not carried here: the daemon owns the binding and emits it
   * as a `session-bound` event.
   */
  | { kind: 'session-init'; model?: string }
  | { kind: 'assistant-delta'; text: string }
  | { kind: 'tool-use'; toolCallId?: string; name: string; input?: Record<string, unknown> }
  | {
      kind: 'tool-result';
      toolCallId?: string;
      name: string;
      output: string;
      durationMs?: number;
      isError: boolean;
    }
  | {
      kind: 'turn-complete';
      hermesSessionId?: string;
      exitCode: number;
      text: string;
      tokens: NormalizedHermesTokens;
      durationMs?: number;
      error?: string;
      replayGap?: boolean;
    }
  | { kind: 'unknown'; event: unknown };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeTokens(raw: unknown): NormalizedHermesTokens {
  const t = asRecord(raw) ?? {};
  return {
    input: asFiniteNumber(t.input) ?? 0,
    output: asFiniteNumber(t.output) ?? 0,
    total: asFiniteNumber(t.total) ?? 0,
    cacheRead: asFiniteNumber(t.cache_read) ?? 0,
    cacheWrite: asFiniteNumber(t.cache_write) ?? 0,
  };
}

/** Map one verbatim hermes-mgr event payload to its normalized form. */
export function normalizeHermesEvent(event: unknown): NormalizedHermesEvent {
  const evt = asRecord(event);
  if (!evt) return { kind: 'unknown', event };

  // Daemon-synthesized lifecycle event (see hermes-manager.ts).
  if (evt.type === 'hermes-mgr' && evt.subtype === 'session-bound') {
    const hermesSessionId = asNonEmptyString(evt.hermesSessionId);
    if (!hermesSessionId) return { kind: 'unknown', event };
    return { kind: 'session-bound', hermesSessionId };
  }
  // The stored resume id no longer exists in the Hermes home; the daemon
  // already replayed the turn against a fresh session.
  if (evt.type === 'hermes-mgr' && evt.subtype === 'resume-reset') {
    const previousHermesSessionId = asNonEmptyString(evt.previousHermesSessionId);
    return {
      kind: 'resume-reset',
      ...(previousHermesSessionId ? { previousHermesSessionId } : {}),
    };
  }

  switch (evt.type) {
    case 'system': {
      // system/init reports the route the CLI launched with. The daemon owns
      // the session-id binding and emits it as a hermes-mgr/session-bound
      // event, so init is normalized for the model it carries.
      if (evt.subtype !== 'init') return { kind: 'unknown', event };
      const model = asNonEmptyString(evt.model);
      return {
        kind: 'session-init',
        ...(model ? { model } : {}),
      };
    }
    case 'text': {
      // Empty-string deltas are the turn-end sentinel in Hermes's protocol
      // and carry no content; drop them rather than emitting empty deltas.
      const text = asString(evt.text);
      if (!text) return { kind: 'unknown', event };
      return { kind: 'assistant-delta', text };
    }
    case 'tool_use': {
      const name = asNonEmptyString(evt.name);
      if (!name) return { kind: 'unknown', event };
      const toolCallId = asNonEmptyString(evt.tool_call_id);
      const input = asRecord(evt.input) ?? undefined;
      return {
        kind: 'tool-use',
        name,
        ...(toolCallId ? { toolCallId } : {}),
        ...(input ? { input } : {}),
      };
    }
    case 'tool_result': {
      const name = asNonEmptyString(evt.name);
      if (!name) return { kind: 'unknown', event };
      const toolCallId = asNonEmptyString(evt.tool_call_id);
      const durationMs = asFiniteNumber(evt.duration_ms);
      return {
        kind: 'tool-result',
        name,
        output: asString(evt.output) ?? '',
        ...(toolCallId ? { toolCallId } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        isError: evt.is_error === true,
      };
    }
    case 'result': {
      const exitCode = asFiniteNumber(evt.exit_code) ?? 0;
      return {
        kind: 'turn-complete',
        ...(asNonEmptyString(evt.session_id) ? { hermesSessionId: asNonEmptyString(evt.session_id) } : {}),
        exitCode,
        text: asString(evt.text) ?? '',
        tokens: normalizeTokens(evt.tokens),
        ...(asFiniteNumber(evt.duration_ms) !== undefined
          ? { durationMs: asFiniteNumber(evt.duration_ms) }
          : {}),
        ...(asNonEmptyString(evt.error) ? { error: asNonEmptyString(evt.error) } : {}),
        ...(evt.replay_gap === true ? { replayGap: true } : {}),
      };
    }
    default:
      return { kind: 'unknown', event };
  }
}

/** Split a daemon stderr "session_id: <id>" trailer, when present. */
export function parseSessionIdFromStderr(stderrTail: string): string | undefined {
  const match = stderrTail.match(/^\s*session_id:\s*(\S+)\s*$/m);
  return match?.[1];
}
