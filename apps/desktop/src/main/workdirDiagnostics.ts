import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { getSystemErrorMap } from 'node:util';

const diagnosticKey = randomBytes(32);
const errorCodes = new Set([
  ...[...getSystemErrorMap().values()].map(([code]) => code),
  'WORKDIR_PROBE_TIMEOUT',
  'WORKDIR_PROBE_UNAVAILABLE',
]);

export interface WorkdirDiagnosticLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

function diagnosticId(kind: 'directory' | 'session', value: string): string {
  return createHmac('sha256', diagnosticKey).update(kind).update('\0').update(value).digest('hex').slice(0, 16);
}

export function workdirDiagnosticId(dir: string): string {
  return diagnosticId('directory', path.resolve(dir));
}

export function workdirDiagnosticContext(sessionId: string, dir: string) {
  return { sessionRef: diagnosticId('session', sessionId), directoryRef: workdirDiagnosticId(dir) };
}

export function workdirDiagnosticErrorCode(error: unknown): string {
  try {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return typeof code === 'string' && errorCodes.has(code) ? code : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}
