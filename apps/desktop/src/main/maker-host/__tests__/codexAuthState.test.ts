import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildCodexLoginTerminationPlan,
  codexLoginArgs,
  requireCodexOAuthLoginState,
  resolveCodexLoginCleanupPreflight,
  resolveCodexLoginExitState,
  terminateCodexLoginProcess,
} from '../codex-auth-state.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('codexLoginArgs', () => {
  it('uses the official browser flow by default', () => {
    expect(codexLoginArgs()).toEqual(['login']);
    expect(codexLoginArgs('browser')).toEqual(['login']);
  });

  it('uses the official device authorization flow when requested', () => {
    expect(codexLoginArgs('device-code')).toEqual(['login', '--device-auth']);
  });
});

describe('requireCodexOAuthLoginState', () => {
  it('accepts an authenticated OAuth state unchanged', () => {
    const state = {
      authenticated: true,
      authSource: 'oauth' as const,
      identity: 'dev@example.test',
    };
    expect(requireCodexOAuthLoginState(state)).toBe(state);
  });

  it('rejects gateway fallback even when the global Codex gate is authenticated', () => {
    expect(
      requireCodexOAuthLoginState({
        authenticated: true,
        authSource: 'api-key',
        identity: 'API Key · Cindy AI',
      }),
    ).toEqual({ authenticated: false, errorReason: 'no_oauth' });
  });

  it('preserves a concrete OAuth read failure reason', () => {
    expect(
      requireCodexOAuthLoginState({ authenticated: false, errorReason: 'auth_parse_failed' }),
    ).toEqual({ authenticated: false, errorReason: 'auth_parse_failed' });
  });
});

describe('resolveCodexLoginExitState', () => {
  it('makes cancellation and timeout stable instead of leaking process exit text', () => {
    expect(
      resolveCodexLoginExitState({
        cancelled: true,
        timedOut: false,
        exitCode: 1,
        stderr: 'process terminated',
      }),
    ).toEqual({ authenticated: false, errorReason: 'login_cancelled' });
    expect(
      resolveCodexLoginExitState({
        cancelled: false,
        timedOut: true,
        exitCode: null,
        stderr: '',
      }),
    ).toEqual({ authenticated: false, errorReason: 'login_timeout' });
  });

  it('lets a zero exit proceed to OAuth credential validation', () => {
    expect(
      resolveCodexLoginExitState({
        cancelled: false,
        timedOut: false,
        exitCode: 0,
        stderr: '',
      }),
    ).toBeNull();
  });

  it('lets a zero exit validate the committed token before a raced cancel or timeout wins', () => {
    expect(
      resolveCodexLoginExitState({
        cancelled: true,
        timedOut: false,
        exitCode: 0,
        stderr: 'terminated',
      }),
    ).toBeNull();
    expect(
      resolveCodexLoginExitState({
        cancelled: false,
        timedOut: true,
        exitCode: 0,
        stderr: '',
      }),
    ).toBeNull();
  });
});

describe('resolveCodexLoginCleanupPreflight', () => {
  it('re-checks cancellation after async cleanup before the caller can advance to spawn', async () => {
    let releaseCleanup!: (ready: boolean) => void;
    const cleanup = new Promise<boolean>((resolve) => {
      releaseCleanup = resolve;
    });
    let cancelled = false;
    const result = resolveCodexLoginCleanupPreflight(
      () => cleanup,
      () => cancelled,
    );

    cancelled = true;
    releaseCleanup(true);

    await expect(result).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
  });

  it('reports cleanup failure when no cancellation raced the await', async () => {
    await expect(
      resolveCodexLoginCleanupPreflight(
        async () => false,
        () => false,
      ),
    ).resolves.toEqual({ authenticated: false, errorReason: 'auth_cleanup_failed' });
  });
});

describe('buildCodexLoginTerminationPlan', () => {
  it('uses the tracked ChildProcess handle on Windows', () => {
    expect(buildCodexLoginTerminationPlan('win32')).toEqual({
      kind: 'windows-handle',
      signal: 'SIGKILL',
    });
  });

  it('uses immediate process-group KILL on POSIX', () => {
    const expected = { kind: 'posix-group', signal: 'SIGKILL' };
    expect(buildCodexLoginTerminationPlan('darwin')).toEqual(expected);
    expect(buildCodexLoginTerminationPlan('linux')).toEqual(expected);
  });

  it('kills the live Windows root through its identity-bound ChildProcess handle', () => {
    const pidKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const fakeProc = {
      pid: 42,
      exitCode: null,
      signalCode: null,
      kill: vi.fn().mockReturnValue(true),
    } as unknown as ChildProcess;

    terminateCodexLoginProcess(fakeProc, 'win32');

    expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fakeProc.kill).toHaveBeenCalledTimes(1);
    expect(pidKill).not.toHaveBeenCalled();
  });

  it('kills the live POSIX process group without leaving a delayed PID-reuse window', () => {
    const groupKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const fakeProc = {
      pid: 42,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    terminateCodexLoginProcess(fakeProc, 'darwin');
    expect(groupKill).toHaveBeenCalledWith(-42, 'SIGKILL');
    expect(groupKill).toHaveBeenCalledTimes(1);
    expect(fakeProc.kill).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'win32'] as const)('does not signal after the tracked root has exited on %s', (platform) => {
    const groupKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const fakeProc = {
      pid: 42,
      exitCode: 0,
      signalCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    terminateCodexLoginProcess(fakeProc, platform);

    expect(groupKill).not.toHaveBeenCalled();
    expect(fakeProc.kill).not.toHaveBeenCalled();
  });
});
