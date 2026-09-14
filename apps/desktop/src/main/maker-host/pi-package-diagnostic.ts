import type { PiManagedPackageMutationFailureCode, PiPackageCommandDiagnostic } from '@cindy/maker-core';
import { redact } from '../log-upload/redact.js';

// Only errors minted here carry process evidence. Arbitrary Error properties
// (including cause, argv and stderr) must never cross a public boundary.
const diagnostics = new WeakMap<object, PiPackageCommandDiagnostic>();

export function piPackageCommandDiagnostic(error: unknown): PiPackageCommandDiagnostic | undefined {
  return typeof error === 'object' && error !== null ? diagnostics.get(error) : undefined;
}

/** Classify locally after the existing redaction pass; publish allowlisted facts only. */
export function createPiPackageCommandError(
  message: string,
  evidence: Pick<PiPackageCommandDiagnostic, 'phase' | 'outcome' | 'exitCode' | 'signal' | 'command'>,
): Error {
  const safe = redact(message);
  const categories: Array<[RegExp, PiPackageCommandDiagnostic['reason'], PiPackageCommandDiagnostic['recovery']]> = [
    [/\bE401\b|\bE403\b|authentication failed|returned error: (?:401|403)|could not read Username|permission denied \(publickey\)/i, 'authentication', 'check-credentials'],
    [/\bEACCES\b|\bEPERM\b|permission denied/i, 'permission', 'check-permissions'],
    [/\bETARGET\b|no matching version|version[^\n]*not found/i, 'version-not-found', 'check-version'],
    [/\bE404\b|package[^\n]*not found|repository[^\n]*not found|404 not found/i, 'package-not-found', 'check-source'],
    [/\bENOTFOUND\b|\bEAI_AGAIN\b|\bECONNREFUSED\b|\bETIMEDOUT\b|network|fetch failed|could not resolve host|unable to access/i, 'network', 'check-network'],
    [/\bENOSPC\b|no space left/i, 'disk-full', 'free-disk-space'],
    [/\bENOENT\b|not installed in Cindy/i,
      evidence.phase === 'prepare' ? 'missing-executable' : 'missing-file',
      evidence.phase === 'prepare' ? 'check-runtime' : 'check-source'],
    [/\bELIFECYCLE\b|gyp ERR!|build failed/i, 'build-failed', 'check-build-dependencies'],
    [/state is unavailable/i, 'state-unavailable', 'refresh-package-state'],
  ];
  const match = categories.find(([pattern]) => pattern.test(safe));
  const nativeCode = safe.match(/\b(E401|E403|EACCES|EPERM|ETARGET|E404|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENOSPC|ENOENT|ELIFECYCLE)\b/)?.[1] as PiPackageCommandDiagnostic['nativeCode'];
  const diagnostic: PiPackageCommandDiagnostic = {
    ...(nativeCode ? { nativeCode } : {}),
    ...(evidence.command ? { command: evidence.command } : {}),
    phase: evidence.phase,
    outcome: evidence.outcome,
    ...(evidence.exitCode !== undefined ? { exitCode: evidence.exitCode } : {}),
    ...(evidence.signal ? { signal: evidence.signal } : {}),
    reason: match?.[1] ?? 'unknown',
    recovery: evidence.outcome === 'failed' ? match?.[2] ?? 'inspect-state-before-retry' : 'inspect-state-before-retry',
  };
  // Retain the existing Main-local message for compatibility. Public callers use
  // the WeakMap projection, not this text; redact is defense in depth, not proof
  // that arbitrary third-party output is safe to publish.
  const error = new Error(safe);
  diagnostics.set(error, Object.freeze(diagnostic));
  return error;
}

export function piPackageMutationFailureCategory(
  error: unknown,
): PiManagedPackageMutationFailureCode {
  const diagnostic = piPackageCommandDiagnostic(error);
  if (diagnostic && diagnostic.outcome !== 'failed') return 'native-command-failed';
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes('state is unavailable')) return 'state-unavailable';
  if (/\betarget\b|no matching version|version[^\n]*not found/.test(message)) {
    return 'version-not-found';
  }
  if (/\be404\b|package[^\n]*not found|repository[^\n]*not found|404 not found/.test(message)) {
    return 'package-not-found';
  }
  if (/\benotfound\b|\beai_again\b|\beconnrefused\b|\betimedout\b|network|fetch failed|could not resolve host|unable to access/.test(message)) {
    return 'source-unavailable';
  }
  return 'native-command-failed';
}
