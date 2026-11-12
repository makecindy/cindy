import { readFileSync } from 'node:fs';
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { StableOwnerPostCommitCoordinator } from '../stableOwnerPostCommit';
import * as hostTools from '../mcp-integrations/hostToolCaller.js';
import type { StableOwnerPostCommitTask } from '../stableOwnerPostCommit';

// Run the production auth entrypoints with the real post-commit coordinator,
// without loading Electron, credentials or another account's files.
const source = readFileSync(new URL('../authManager.ts', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8');
const stableTaskStart = bootstrap.indexOf('authManager.setStableOwnerPostCommitTask(');
const stableTaskCode = transpileModule(bootstrap.slice(stableTaskStart, bootstrap.indexOf('\n});', stableTaskStart) + 4), {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;
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
    authRefreshOverride: null,
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
      `let authStateEpoch = 0;
       let settledLoginCommitCount = 0;
       ${productionFunction('initialize')}`,
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
  // Unit, #9801: the real stable-owner callback must recover the public provider
  // factory after a same-owner generation bump. Existing startup tests did not
  // call Host tools; one live provider previously remained HOST_NOT_READY.
  it.each([
    { liveMaker: true, pending: false, ownerId: 'owner', ready: true },
    { liveMaker: false, pending: false, ownerId: 'owner', ready: false },
    { liveMaker: true, pending: true, ownerId: 'owner', ready: false },
    { liveMaker: true, pending: false, ownerId: 'other-owner', ready: false },
  ])('rebinds only live same-owner Host providers after commit: %j', async scenario => {
    const original = { kind: 'plugin' as const, pluginId: 'dashboard', dataOwnerId: 'owner', ownerGeneration: 1 };
    const recovered = { ...original, dataOwnerId: scenario.ownerId, ownerGeneration: 2 };
    const result = { content: [{ type: 'text' as const, text: 'history' }] };
    const runtime = { describe: () => ({ name: 'list_sessions', category: 'history' }),
      call: vi.fn(async () => result), close: vi.fn(async () => {}) };
    hostTools.setHostToolProviders([{ name: 'cindy_helper', toClaudeSdkConfig: () => null, toHostTools: () => runtime }], original);
    let task!: StableOwnerPostCommitTask;
    const deps = {
      authManager: { setStableOwnerPostCommitTask: (callback: StableOwnerPostCommitTask) => { task = callback; } },
      isAppSessionBoundaryPending: () => scenario.pending,
      activeOwnerScopeKey: () => 'recovered-scope', getActiveAppSession: () => ({ dataOwnerId: scenario.ownerId }),
      getActiveDataOwnerPushStamp: () => recovered, getMakerIfReady: () => scenario.liveMaker ? {} : null,
      refreshHostToolProviderOwner: hostTools.refreshHostToolProviderOwner,
      builtinPostCommitStep: { run: async () => 'deferred' },
    };
    try {
      new Function(...Object.keys(deps), stableTaskCode)(...Object.values(deps));
      await task({ reason: 'same-owner-projection-recovery', scopeKey: 'recovered-scope', dataOwnerId: scenario.ownerId });
      hostTools.refreshHostToolProviderOwner(original);
      const current = hostTools.createHostToolRuntime('cindy_helper', recovered);
      expect(current !== null).toBe(scenario.ready);
      if (current) {
        expect(await current.call('list_sessions')).toEqual(result);
        expect(hostTools.createHostToolRuntime('cindy_helper', original)).toBeNull();
      } else expect(runtime.call).not.toHaveBeenCalled();
    } finally { hostTools.setHostToolProviders([], original); }
  });

  it.each([false, true])('settles the startup boundary push even with notify=false (teardown fails: %s)', async (fails) => {
    // The main window sees the pending push while its initialize IPC is in flight.
    // Its auth service deliberately ignores the later IPC result, so Main must
    // close that push boundary on both success and rollback.
    let mode = 'signed-out';
    let pending = false;
    const projections: Array<{ mode: string; pending: boolean }> = [];
    const deps = {
      LOCAL_DATA_OWNER_ID: 'local-v1',
      getActiveAppSession: () => ({ mode, dataOwnerId: null }),
      isPassiveSharedUserDataInstance: () => false,
      withGhostSkillProjectionOwnerCommit: async (hooks: {
        prepareTransition: (value: { ownerChanged: boolean }) => Promise<void>;
        prepareCommit: () => Promise<void>;
        commit: () => void;
      }) => {
        await hooks.prepareTransition({ ownerChanged: true });
        await hooks.prepareCommit();
        hooks.commit();
      },
      notifyRendererAuthBoundaryPending: () => projections.push({ mode: 'signed-out', pending: true }),
      enterOwnerChangeShellPending: () => { pending = true; },
      leaveOwnerChangeShellPending: () => { pending = false; },
      beginAppSessionBoundary: () => () => {},
      authSessionTeardown: async () => { if (fails) throw new Error('teardown unavailable'); },
      clearAuth: vi.fn(),
      commitActiveAppSession: (nextMode: string) => { mode = nextMode; },
      notifyRenderer: () => projections.push({ mode, pending }),
      notifyAuthListeners: vi.fn(),
      requestStableOwnerPostCommit: vi.fn(),
    };
    const compiled = transpileModule(
      `${productionFunction('withAccountFreeOwnerCommit')}\nreturn withAccountFreeOwnerCommit;`,
      { compilerOptions: { target: ScriptTarget.ES2022 } },
    ).outputText;
    const commit = new Function(...Object.keys(deps), compiled)(...Object.values(deps));
    const completion = commit({ reason: 'cold-start-local-recovery', nextMode: 'local', notify: false });
    if (fails) await expect(completion).rejects.toThrow('teardown unavailable');
    else await completion;
    expect(projections).toEqual([
      { mode: 'signed-out', pending: true },
      { mode: fails ? 'signed-out' : 'local', pending: false },
    ]);
    expect(deps.notifyAuthListeners).not.toHaveBeenCalled();
  });

  it('returns through the real startup IPC while the owner task remains pending', async () => {
    const run = setup('cloud');
    const start = bootstrap.indexOf("ipcMain.handle('auth:initialize',");
    const end = bootstrap.indexOf("ipcMain.handle('auth:get-login-state',", start);
    const compiled = transpileModule(bootstrap.slice(start, end), {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText;
    let initialize!: () => Promise<unknown>;
    const deps = {
      hostClientMode: false,
    authRefreshOverride: null,
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
