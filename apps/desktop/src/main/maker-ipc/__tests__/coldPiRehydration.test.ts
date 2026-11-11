import { describe, expect, it, vi } from 'vitest';
import { createIpcError } from '../../../shared/ipc-errors';
import {
  classifyColdPiRehydrationOutcome,
  createColdPiRehydrationForWindowVerification,
  type ColdPiRehydrationDeps,
} from '../coldPiRehydration';
import {
  ColdPiRehydrationError,
  reportColdPiRehydrationFailure,
} from '../coldPiRehydrationFailure';

const LOCAL_PATH = '/Users/alice/Projects/secret-client/.worktrees/feature-x';

interface Row {
  agentKind: string;
  remoteHostId: string | null;
  sdkSessionId: string | null;
  workingDir: string | null;
  model: string;
}

interface Opts {
  id: string;
  agentKind: string;
  workingDir?: string;
  remoteHostId?: string | null;
  resumeSessionId?: string;
  extraDirs?: string[];
}

function errnoError(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

const piRow: Row = {
  agentKind: 'pi',
  remoteHostId: null,
  sdkSessionId: 'native-1',
  workingDir: LOCAL_PATH,
  model: 'pi-old',
};

function harness(overrides: Partial<ColdPiRehydrationDeps<Row, Opts>> = {}) {
  const deps: ColdPiRehydrationDeps<Row, Opts> = {
    hasLiveSession: vi.fn(() => false),
    loadSessionRow: vi.fn(async () => piRow),
    buildCreateOpts: vi.fn((sessionId, row) => ({
      id: sessionId,
      agentKind: 'pi',
      workingDir: row.workingDir,
      remoteHostId: null,
      resumeSessionId: row.sdkSessionId,
    })),
    checkWorkDirExists: vi.fn(async () => true),
    prepareCreateOpts: vi.fn(async (_sessionId, opts) => {
      opts.extraDirs = ['/tmp/extra'];
    }),
    bootstrapSession: vi.fn(async () => ({ session: {} })),
    ...overrides,
  };
  return { deps, rehydrate: createColdPiRehydrationForWindowVerification(deps) };
}

async function failure(run: Promise<unknown>): Promise<ColdPiRehydrationError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(ColdPiRehydrationError);
    return error as ColdPiRehydrationError;
  }
  throw new Error('expected the rehydration to fail');
}

describe('cold Pi rehydration for window verification (#5508)', () => {
  it('does nothing when the runtime is already live', async () => {
    const { deps, rehydrate } = harness({ hasLiveSession: vi.fn(() => true) });
    await expect(rehydrate('s-1')).resolves.toBeUndefined();
    expect(deps.loadSessionRow).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('bootstraps the persisted Pi session with the prepared create options', async () => {
    const { deps, rehydrate } = harness();
    await rehydrate('s-1');
    expect(deps.checkWorkDirExists).toHaveBeenCalledWith('s-1', LOCAL_PATH, 'pi', null);
    expect(deps.bootstrapSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's-1', resumeSessionId: 'native-1', extraDirs: ['/tmp/extra'] }),
    );
  });

  it.each([
    ['session-row-missing', { loadSessionRow: vi.fn(async () => undefined) }],
    ['not-local-pi', { loadSessionRow: vi.fn(async () => ({ ...piRow, agentKind: 'codex' })) }],
    ['not-local-pi', { loadSessionRow: vi.fn(async () => ({ ...piRow, remoteHostId: 'host-1' })) }],
    ['native-session-missing', { loadSessionRow: vi.fn(async () => ({ ...piRow, sdkSessionId: null })) }],
    ['working-dir-missing', { loadSessionRow: vi.fn(async () => ({ ...piRow, workingDir: null })) }],
    ['working-dir-missing', { checkWorkDirExists: vi.fn(async () => false) }],
  ] as const)('fails closed with category %s', async (category, overrides) => {
    const { deps, rehydrate } = harness(overrides as Partial<ColdPiRehydrationDeps<Row, Opts>>);
    const error = await failure(rehydrate('s-1'));
    expect(error.category).toBe(category);
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('classifies a working-directory probe timeout instead of reporting unknown', async () => {
    const probeError = errnoError(`workdir probe timed out for ${LOCAL_PATH}`, 'WORKDIR_PROBE_TIMEOUT');
    const { deps, rehydrate } = harness({ checkWorkDirExists: vi.fn(async () => { throw probeError; }) });
    const error = await failure(rehydrate('s-1'));
    expect(error.category).toBe('working-dir-probe-failed');
    expect(error.cause).toBe(probeError);
    expect(error.message).toContain(LOCAL_PATH);
    expect(error.detail).toBe('Error WORKDIR_PROBE_TIMEOUT');
    expect(deps.prepareCreateOpts).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('classifies a permission or I/O probe failure the same way', async () => {
    const probeError = errnoError(`EACCES: permission denied, stat '${LOCAL_PATH}'`, 'EACCES');
    const { rehydrate } = harness({ checkWorkDirExists: vi.fn(async () => { throw probeError; }) });
    const error = await failure(rehydrate('s-1'));
    expect(error.category).toBe('working-dir-probe-failed');
    expect(error.detail).toBe('Error EACCES');
  });

  it('classifies session lookup and option preparation failures', async () => {
    const dbError = new TypeError('database is closed');
    const lookup = await failure(harness({ loadSessionRow: vi.fn(async () => { throw dbError; }) }).rehydrate('s-1'));
    expect(lookup.category).toBe('session-lookup-failed');
    expect(lookup.cause).toBe(dbError);
    expect(lookup.detail).toBe('TypeError');

    const optionsError = errnoError(`ENOENT: no such file, open '${LOCAL_PATH}/.orca.json'`, 'ENOENT');
    const options = await failure(
      harness({ prepareCreateOpts: vi.fn(async () => { throw optionsError; }) }).rehydrate('s-1'),
    );
    expect(options.category).toBe('session-options-failed');
    expect(options.detail).toBe('Error ENOENT');
  });

  it('keeps the bootstrap cause and its original message for the log', async () => {
    const bootstrapError = new Error(`pi exited with code 1\nstderr: cannot open ${LOCAL_PATH}/.pi/session`);
    const { rehydrate } = harness({ bootstrapSession: vi.fn(async () => { throw bootstrapError; }) });
    const error = await failure(rehydrate('s-1'));
    expect(error.category).toBe('bootstrap-failed');
    expect(error.cause).toBe(bootstrapError);
    expect(error.message).toContain('pi exited with code 1');
    expect(error.detail).toBe('Error');
  });

  it('end to end: a probe failure reaches the main log with its path but crosses IPC without it', async () => {
    const probeError = errnoError(`EACCES: permission denied, stat '${LOCAL_PATH}'`, 'EACCES');
    const { rehydrate } = harness({ checkWorkDirExists: vi.fn(async () => { throw probeError; }) });
    const warn = vi.fn();
    const throwIpcError = vi.fn((code, message) => {
      throw createIpcError(code, message);
    });

    let thrown: unknown;
    try {
      await rehydrate('s-1');
    } catch (error) {
      try {
        reportColdPiRehydrationFailure(
          { log: { warn }, throwIpcError, errorCode: 'MODEL_WINDOW_CURRENT_CONTEXT_UNKNOWN' },
          { sessionId: 's-1', fromModel: 'pi-old', toModel: 'pi-new', currentProviderId: null, nextProviderId: null },
          error,
        );
      } catch (ipcError) {
        thrown = ipcError;
      }
    }

    expect(thrown).toBeInstanceOf(Error);
    const ipcMessage = (thrown as Error).message;
    expect(ipcMessage).toBe(
      '[MODEL_WINDOW_CURRENT_CONTEXT_UNKNOWN] Pi current runtime could not be verified (working-dir-probe-failed: Error EACCES); runtime selection was not changed',
    );
    expect(ipcMessage).not.toContain(LOCAL_PATH);
    expect((thrown as { code?: string }).code).toBe('MODEL_WINDOW_CURRENT_CONTEXT_UNKNOWN');

    const [, fields] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields.category).toBe('working-dir-probe-failed');
    expect(fields.reason).toContain(LOCAL_PATH);
    expect(fields.detail).toBe('Error EACCES');
  });
});

describe('classifyColdPiRehydrationOutcome', () => {
  it('降级继续：恢复失败且没有活会话（存量路由死掉，切模不能被拒绝）', () => {
    expect(
      classifyColdPiRehydrationOutcome({ rehydrationFailed: true, liveAfterBootstrap: false }),
    ).toBe('degraded');
  });

  it('保留 fail-closed：bootstrap 声称成功却没有活会话，且没有降级过', () => {
    expect(
      classifyColdPiRehydrationOutcome({ rehydrationFailed: false, liveAfterBootstrap: false }),
    ).toBe('fail-closed');
  });

  it('有活会话就核实：恢复成功（或竞态中别处已拉起）时拿 live 读数刷新窗口', () => {
    expect(
      classifyColdPiRehydrationOutcome({ rehydrationFailed: false, liveAfterBootstrap: true }),
    ).toBe('verified');
    expect(
      classifyColdPiRehydrationOutcome({ rehydrationFailed: true, liveAfterBootstrap: true }),
    ).toBe('verified');
  });
});
