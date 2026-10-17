import { readFileSync } from 'node:fs';
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { StableOwnerPostCommitCoordinator } from '../stableOwnerPostCommit';

// Run the production auth entrypoints with the real post-commit coordinator,
// without loading Electron, credentials or another account's files.
const source = readFileSync(new URL('../authManager.ts', import.meta.url), 'utf8');
const parsed = createSourceFile('authManager.ts', source, ScriptTarget.ES2022, true);
function productionFunction(name: string): string {
  const declaration = parsed.statements.find(
    (node) => isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!declaration) throw new Error(`Missing production function: ${name}`);
  return declaration.getText(parsed).replace(/^export /, '');
}

function setup(mode: 'cloud' | 'local' | 'signed-out', passive = false) {
  const state = {
    mode,
    dataOwnerId: mode === 'signed-out' ? null : 'owner',
    canEnterApp: mode !== 'signed-out',
  };
  let stable = true;
  let finish: ((outcome: 'completed') => void) | undefined;
  const task = vi.fn(
    () =>
      new Promise<'completed'>((resolve) => {
        finish = resolve;
      }),
  );
  const coordinator = new StableOwnerPostCommitCoordinator({
    snapshot: () => ({ scopeKey: `${mode}:1`, dataOwnerId: state.dataOwnerId, stable }),
    warn: vi.fn(),
  });
  coordinator.setTask(task);
  const commit = vi.fn(async () => {
    stable = true;
  });
  const deps = {
    stableOwnerPostCommitCoordinator: coordinator,
    isPassiveSharedUserDataInstance: () => passive,
    getActiveAppSession: () => state,
    isOwnerChangeShellPending: () => !stable,
    isGhostSkillProjectionBoundaryStableForOwner: () => stable,
    accessToken: mode === 'cloud' ? 'test-only-token' : null,
    currentUser: mode === 'cloud' ? { id: 'owner' } : null,
    LOCAL_DATA_OWNER_ID: 'owner',
    snapshotAuthState: () => state,
    snapshotLoggedOutAuthState: () => ({ canEnterApp: false }),
    repairStableCloudOwnerDataReservations: vi.fn(async () => true),
    migrateLocalProviderBindingsAfterCloudCommit: vi.fn(async () => {}),
    commitCloudAppSession: vi.fn(),
    withAccountFreeOwnerCommit: commit,
  };
  const compiled = transpileModule(
    [
      productionFunction('requestStableOwnerPostCommit'),
      productionFunction('recoverAccountFreeOwnerAtStartup'),
      productionFunction('initialize'),
      'return { initialize, recoverAccountFreeOwnerAtStartup, requestStableOwnerPostCommit };',
    ].join('\n'),
    { compilerOptions: { target: ScriptTarget.ES2022 } },
  ).outputText;
  const entrypoints = new Function(...Object.keys(deps), compiled)(...Object.values(deps)) as {
    initialize(): Promise<unknown>;
    recoverAccountFreeOwnerAtStartup(mode: string, reason: string): Promise<void>;
    requestStableOwnerPostCommit(reason: string): void;
  };
  return {
    ...entrypoints,
    state,
    task,
    coordinator,
    deps,
    finish: () => finish?.('completed'),
    setStable: (value: boolean) => {
      stable = value;
    },
  };
}

describe('authentication does not wait for optional plugin provisioning', () => {
  it('returns through the real startup IPC while the owner task remains pending', async () => {
    const run = setup('cloud');
    const bootstrap = readFileSync(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8');
    const start = bootstrap.indexOf("ipcMain.handle('auth:initialize',");
    const end = bootstrap.indexOf("ipcMain.handle('auth:get-login-state',", start);
    const compiled = transpileModule(bootstrap.slice(start, end), {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText;
    let initialize!: () => Promise<unknown>;
    const deps = {
      ipcMain: {
        handle: (_channel: string, handler: typeof initialize) => {
          initialize = handler;
        },
      },
      authManager: run,
      authCredentialRecovery: { request: vi.fn() },
      app: { isPackaged: true },
      isCindyVersionLaunchPending: () => false,
      noteAuthColdStartState: vi.fn(),
    };
    new Function(...Object.keys(deps), compiled)(...Object.values(deps));
    try {
      await expect(initialize()).resolves.toBe(run.state);
      expect(run.task).toHaveBeenCalledTimes(1);
      expect(deps.noteAuthColdStartState).toHaveBeenCalledWith(run.state, null);
    } finally {
      run.finish();
    }
  });

  it.each(['cloud', 'local'] as const)(
    'returns the %s session while provisioning is still pending',
    async (mode) => {
      const run = setup(mode);
      try {
        await expect(run.initialize()).resolves.toBe(run.state);
        await expect(run.initialize()).resolves.toBe(run.state);
        expect(run.task).toHaveBeenCalledTimes(1);
        // Explicit completion consumers still wait; only authentication was detached.
        const completed = vi.fn();
        const completion = run.coordinator.ensure('observer').then(completed);
        await Promise.resolve();
        expect(completed).not.toHaveBeenCalled();
        run.finish();
        await completion;
        expect(completed).toHaveBeenCalledWith('completed');
      } finally {
        run.finish();
      }
    },
  );

  it('returns signed-out recovery without waiting for bundled provisioning', async () => {
    const run = setup('signed-out');
    try {
      await run.recoverAccountFreeOwnerAtStartup('signed-out', 'startup');
      await vi.waitFor(() => expect(run.task).toHaveBeenCalledTimes(1));
    } finally {
      run.finish();
    }
  });

  it('keeps a real owner transition fenced', async () => {
    const run = setup('cloud');
    run.setStable(false);
    await expect(run.initialize()).resolves.toEqual({ canEnterApp: false });
    expect(run.task).not.toHaveBeenCalled();
  });

  it('does not provision from a passive shared profile', async () => {
    const run = setup('cloud', true);
    await expect(run.initialize()).resolves.toBe(run.state);
    run.requestStableOwnerPostCommit('ipc-fallback');
    await Promise.resolve();
    expect(run.task).not.toHaveBeenCalled();
  });
});
