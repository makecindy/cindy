import { describe, expect, it, vi } from 'vitest';
import { createIpcError } from '../../../shared/ipc-errors';
import {
  COLD_PI_REHYDRATION_FAILURE_LOG_MESSAGE,
  ColdPiRehydrationError,
  coldPiRehydrationFailureMessage,
  describeCauseForIpc,
  describeColdPiRehydrationFailure,
  redactLocalPaths,
  reportColdPiRehydrationFailure,
  sanitizeColdPiRehydrationReason,
} from '../coldPiRehydrationFailure';

const LOCAL_PATH = '/Users/alice/Projects/secret-client/.worktrees/feature-x';

function errnoError(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe('cold Pi rehydration failure diagnostics (#5508)', () => {
  it('keeps the category and message of typed rehydration errors', () => {
    const error = new ColdPiRehydrationError('working-dir-missing', 'working directory is missing for session s-1');
    expect(describeColdPiRehydrationFailure(error)).toEqual({
      category: 'working-dir-missing',
      reason: 'working directory is missing for session s-1',
      detail: 'working directory is missing for session s-1',
    });
    expect(error.name).toBe('ColdPiRehydrationError');
  });

  it('wraps causes without losing the original error, but never copies the cause message into the IPC detail', () => {
    const cause = errnoError(`spawn pi ENOENT: ${LOCAL_PATH}/.pi/bin/pi\nstderr: provider unreachable`, 'ENOENT');
    const error = new ColdPiRehydrationError('bootstrap-failed', `session s-1 bootstrap failed: ${cause.message}`, { cause });
    expect(error.cause).toBe(cause);
    const failure = describeColdPiRehydrationFailure(error);
    expect(failure.category).toBe('bootstrap-failed');
    // Full reason (main log only) keeps the path and stderr, flattened to one line.
    expect(failure.reason).toContain(LOCAL_PATH);
    expect(failure.reason).not.toContain('\n');
    // IPC detail is name + code only.
    expect(failure.detail).toBe('Error ENOENT');
  });

  it('classifies anything else as unknown while keeping the raw message out of the IPC detail', () => {
    expect(describeColdPiRehydrationFailure(new TypeError('db is closed'))).toEqual({
      category: 'unknown',
      reason: 'db is closed',
      detail: 'TypeError',
    });
    expect(describeColdPiRehydrationFailure('plain string')).toEqual({
      category: 'unknown',
      reason: 'plain string',
      detail: 'non-error string',
    });
    expect(describeColdPiRehydrationFailure(undefined)).toEqual({
      category: 'unknown',
      reason: 'no error detail',
      detail: 'no error detail',
    });
    expect(describeColdPiRehydrationFailure(errnoError(`EACCES: permission denied, stat '${LOCAL_PATH}'`, 'EACCES'))).toEqual({
      category: 'unknown',
      reason: `EACCES: permission denied, stat '${LOCAL_PATH}'`,
      detail: 'Error EACCES',
    });
  });

  it('describes causes for IPC by error name and code only', () => {
    expect(describeCauseForIpc(errnoError(`stat '${LOCAL_PATH}' timed out`, 'WORKDIR_PROBE_TIMEOUT'))).toBe(
      'Error WORKDIR_PROBE_TIMEOUT',
    );
    expect(describeCauseForIpc(new RangeError(LOCAL_PATH))).toBe('RangeError');
    expect(describeCauseForIpc(null)).toBe('no error detail');
    expect(describeCauseForIpc({ message: LOCAL_PATH })).toBe('non-error object');
  });

  it('redacts POSIX, Windows and home-relative paths from any explicit detail', () => {
    expect(redactLocalPaths(`cannot read ${LOCAL_PATH}/settings.json (EACCES)`)).toBe('cannot read <path> (EACCES)');
    expect(redactLocalPaths('cannot read C:\\Users\\alice\\AppData\\Roaming\\Cindy\\x.json')).toBe('cannot read <path>');
    expect(redactLocalPaths('cannot read ~/Library/Caches/Cindy/session.json')).toBe('cannot read <path>');
    // Segments with spaces are only redacted up to the first space; detail never carries raw messages anyway.
    expect(redactLocalPaths('cannot read ~/Library/Application Support/Cindy')).toBe('cannot read <path> Support/Cindy');
    expect(new ColdPiRehydrationError('bootstrap-failed', 'x', { detail: `pi binary at ${LOCAL_PATH}/pi` }).detail).toBe(
      'pi binary at <path>',
    );
    expect(redactLocalPaths('   ')).toBe('no error detail');
  });

  it('bounds and flattens reasons so logs stay single-line', () => {
    const long = `line one\n${'x'.repeat(600)}`;
    const reason = sanitizeColdPiRehydrationReason(new Error(long));
    expect(reason).not.toContain('\n');
    expect(reason.length).toBe(240);
    expect(reason.endsWith('…')).toBe(true);
    expect(redactLocalPaths('y'.repeat(600)).length).toBe(120);
  });

  it('keeps the established message prefix so existing wiring and copy still match', () => {
    const message = coldPiRehydrationFailureMessage({
      category: 'session-row-missing',
      reason: 'session s-1 has no database row',
      detail: 'session s-1 has no database row',
    });
    expect(message).toBe(
      'Pi current runtime could not be verified (session-row-missing: session s-1 has no database row); runtime selection was not changed',
    );
    expect(message.startsWith('Pi current runtime could not be verified')).toBe(true);
  });

  it('reports the full reason to the main log and only the category + safe detail across IPC', () => {
    const warn = vi.fn();
    const throwIpcError = vi.fn((code, message) => {
      throw createIpcError(code, message);
    });
    const cause = errnoError(`EACCES: permission denied, stat '${LOCAL_PATH}'`, 'EACCES');
    const error = new ColdPiRehydrationError(
      'working-dir-probe-failed',
      `working directory probe failed for session s-1: ${cause.message}`,
      { cause },
    );
    const context = {
      sessionId: 's-1',
      fromModel: 'pi-old',
      toModel: 'pi-new',
      currentProviderId: 'anthropic',
      nextProviderId: 'openai',
    };

    expect(() =>
      reportColdPiRehydrationFailure(
        { log: { warn }, throwIpcError, errorCode: 'MODEL_WINDOW_CURRENT_CONTEXT_UNKNOWN' },
        context,
        error,
      ),
    ).toThrowError(
      '[MODEL_WINDOW_CURRENT_CONTEXT_UNKNOWN] Pi current runtime could not be verified (working-dir-probe-failed: Error EACCES); runtime selection was not changed',
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, fields] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe(COLD_PI_REHYDRATION_FAILURE_LOG_MESSAGE);
    expect(fields).toMatchObject({
      ...context,
      category: 'working-dir-probe-failed',
      detail: 'Error EACCES',
    });
    expect(fields.reason).toContain(LOCAL_PATH);

    expect(throwIpcError).toHaveBeenCalledTimes(1);
    const [code, ipcMessage] = throwIpcError.mock.calls[0] as [string, string];
    expect(code).toBe('MODEL_WINDOW_CURRENT_CONTEXT_UNKNOWN');
    expect(ipcMessage).not.toContain(LOCAL_PATH);
    expect(ipcMessage).not.toContain('permission denied');
  });

  it('uses the caller-supplied error code so device-link invokes keep their mapping', () => {
    const throwIpcError = vi.fn((code, message) => {
      throw createIpcError(code, message);
    });
    expect(() =>
      reportColdPiRehydrationFailure(
        { log: { warn: vi.fn() }, throwIpcError, errorCode: 'PRECONDITION_FAILED' },
        { sessionId: 's-2', fromModel: null, toModel: 'pi-new', currentProviderId: null, nextProviderId: null },
        new ColdPiRehydrationError('runtime-not-live', 'rehydrated Pi runtime is not live after bootstrap'),
      ),
    ).toThrowError(
      '[PRECONDITION_FAILED] Pi current runtime could not be verified (runtime-not-live: rehydrated Pi runtime is not live after bootstrap); runtime selection was not changed',
    );
  });
});
