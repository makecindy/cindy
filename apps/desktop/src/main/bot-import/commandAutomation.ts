import path from 'node:path';
import { CompanionImportError, object } from './types.js';

/** The native command payload is data, never a prompt or a shell command line. */
export function importedCommand(job: Record<string, unknown>) {
  const payload = object(job.payload);
  if (payload.kind !== 'command') return undefined;
  const invalid = () => { throw new CompanionImportError('SOURCE_AUTOMATION_INVALID'); };
  const argv = payload.argv;
  if (!Array.isArray(argv) || !argv.length || !argv.every(arg => typeof arg === 'string' && !arg.includes('\0')) || !argv[0].trim()) return invalid();
  if (payload.cwd !== undefined && (typeof payload.cwd !== 'string' || !path.isAbsolute(payload.cwd) || payload.cwd.includes('\0'))) return invalid();
  if (payload.input !== undefined && typeof payload.input !== 'string') return invalid();
  if (payload.env !== undefined && (payload.env === null || typeof payload.env !== 'object' || Array.isArray(payload.env)
    || Object.entries(payload.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')))) return invalid();
  const timeout = (value: unknown, fallback?: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) return invalid();
    return value <= 0 ? 2_147_483_647 : Math.min(2_147_483_647, Math.max(1, Math.floor(value * 1000)));
  };
  if (payload.outputMaxBytes !== undefined && (!Number.isSafeInteger(payload.outputMaxBytes) || Number(payload.outputMaxBytes) <= 0)) return invalid();
  return { command: argv[0] as string, args: argv.slice(1) as string[], cwd: payload.cwd as string | undefined,
    input: payload.input as string | undefined, env: object(payload.env) as Record<string, string>,
    timeoutMs: timeout(payload.timeoutSeconds, 600_000)!, noOutputTimeoutMs: timeout(payload.noOutputTimeoutSeconds),
    maxOutputBytes: payload.outputMaxBytes as number | undefined };
}
