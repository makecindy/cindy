/**
 * Shim: openclaw/plugin-sdk/logging-core.
 *
 * Upstream's logger is wired into the OpenClaw logging/config monolith (tslog +
 * 54 config types). The browser core only calls a small surface
 * (`createSubsystemLogger(name).child(sub).{trace,debug,info,warn,error}`), so
 * we provide a minimal console-backed logger with the same shape. The host can
 * replace the sink via `setBrowserRuntimeLogSink` so logs flow into Cindy's
 * unified logger instead of console.
 *
 * redactSensitiveText / redactToolPayloadText reuse the conservative local
 * redactor (see _local/redact).
 */
import { sanitizeNaming, sanitizeNamingString } from './sanitize-naming.js';

export { redactSensitiveText, redactToolPayloadText } from './_local/redact.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface SubsystemLogger {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  child(sub: string): SubsystemLogger;
}

export type LogSink = (level: LogLevel, scope: string, args: unknown[]) => void;

const defaultSink: LogSink = (level, scope, args) => {
  // Quiet by default; only warn/error reach console unless host wires a sink.
  if (level === 'warn' || level === 'error' || level === 'fatal') {
    // eslint-disable-next-line no-console
    (console[level === 'fatal' ? 'error' : level] as (...a: unknown[]) => void)(
      `[browser:${scope}]`,
      ...args,
    );
  }
};

let activeSink: LogSink = defaultSink;

/** Host hook: route browser-runtime logs into the app's unified logger. */
export function setBrowserRuntimeLogSink(sink: LogSink | null): void {
  activeSink = sink ?? defaultSink;
}

function makeLogger(scope: string): SubsystemLogger {
  // Strip the vendored runtime's third-party product identifiers from every log
  // line at this single chokepoint so they never reach the host's log files.
  const at =
    (level: LogLevel) =>
    (...args: unknown[]) =>
      activeSink(level, sanitizeNamingString(scope), args.map((a) => sanitizeNaming(a)));
  return {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (sub: string) => makeLogger(`${scope}/${sub}`),
  };
}

/** Create a named subsystem logger (shape-compatible with upstream). */
export function createSubsystemLogger(name: string): SubsystemLogger {
  return makeLogger(name);
}
