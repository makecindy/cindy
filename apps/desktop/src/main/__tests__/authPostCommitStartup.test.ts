import { readFileSync } from 'node:fs';
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { StableOwnerPostCommitCoordinator } from '../stableOwnerPostCommit';
import { createStartupInFlightCall } from '../startupInFlightCall';

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
    const bootstrap = readFileSync(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8');
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
      startupAuthInitialize: createStartupInFlightCall(),
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

/**
 * 测试价值
 * - 生产入口与可观察结果：bootstrap 里真实的 auth:initialize 处理函数 + app ready 末尾的
 *   startupAuthInitialize.start()；renderer 拿到的鉴权结果、鉴权执行了几次、主窗口是否
 *   收到补发的登录广播。
 * - Bug/规则依据：冷启动鉴权等 renderer 才发起，窗口重载 50s 时远程上线跟着晚 50s
 *   （2026-11-02 iMacXD 三轮冷启动实测）。提前发起后：① 已落定的旧结果不能交给晚到的
 *   窗口（之后的迟到广播会丢）；② 提前那次自己的登录广播早于主窗口订阅，TapDB 首次账号
 *   绑定只认这条广播，必须在主窗口首次调用时补发（PR #8913 Codex 审查 P2）。
 * - 现有覆盖缺口：上面的用例都直接调用处理函数，没有「主进程先发起」这条来源。
 * - 最小失败输入：start() 在途时主窗口调用（只执行一次、不补发）；start() 已落定后主窗口
 *   调用（重新执行、补发一次且只一次）；renderer 先到（start() 不再发起）。
 * - tier：unit（node，按源码切片执行，不加载 Electron）。
 */
describe('startup auth:initialize started by main before the renderer mounts', () => {
  function startupHandler() {
    const bootstrap = readFileSync(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8');
    const start = bootstrap.indexOf("ipcMain.handle('auth:initialize',");
    const end = bootstrap.indexOf("ipcMain.handle('auth:get-login-state',", start);
    const compiled = transpileModule(bootstrap.slice(start, end), {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText;
    const results = [{ isAuthenticated: true, round: 1 }, { isAuthenticated: true, round: 2 }];
    const settles: Array<() => void> = [];
    const initialize = vi.fn(() => {
      const result = results[Math.min(initialize.mock.calls.length, results.length) - 1];
      return new Promise((resolve) => settles.push(() => resolve(result)));
    });
    const mainWindow = { webContents: { id: 'main' } };
    const replayAuthStateTo = vi.fn();
    const startupAuthInitialize = createStartupInFlightCall();
    let handler!: (event: unknown) => Promise<unknown>;
    const deps = {
      ipcMain: { handle: (_channel: string, callback: typeof handler) => { handler = callback; } },
      authManager: {
        initialize,
        requestStableOwnerPostCommit: vi.fn(),
        getAuthState: vi.fn(),
        replayAuthStateTo,
      },
      authCredentialRecovery: { request: vi.fn() },
      app: { isPackaged: true },
      isCindyVersionLaunchPending: () => false,
      noteAuthColdStartState: vi.fn(),
      markStartupMilestone: vi.fn(),
      mainWindowRef: mainWindow,
      startupAuthStateReplayed: false,
      startupAuthInitialize,
    };
    new Function(...Object.keys(deps), compiled)(...Object.values(deps));
    const fromMainWindow = () => handler({ sender: mainWindow.webContents });
    return { startupAuthInitialize, fromMainWindow, initialize, settles, results, replayAuthStateTo };
  }

  it('joins the early call while it is still in flight', async () => {
    const run = startupHandler();
    expect(run.startupAuthInitialize.start()).toBe(true);
    const renderer = run.fromMainWindow();
    expect(run.initialize).toHaveBeenCalledTimes(1);
    run.settles[0]();
    await expect(renderer).resolves.toBe(run.results[0]);
    expect(run.startupAuthInitialize.start()).toBe(false);
    // 主窗口在途期间就已订阅，提前那次的登录广播能收到，不补发。
    expect(run.replayAuthStateTo).not.toHaveBeenCalled();
  });

  it('runs again and replays the missed login once when the early call settled first', async () => {
    const run = startupHandler();
    run.startupAuthInitialize.start();
    run.settles[0]();
    // 让提前那次的执行体（含 finally / 埋点）完整落定，再模拟 renderer 晚到。
    await new Promise((resolve) => setImmediate(resolve));
    const renderer = run.fromMainWindow();
    expect(run.initialize).toHaveBeenCalledTimes(2);
    run.settles[1]();
    await expect(renderer).resolves.toBe(run.results[1]);
    expect(run.replayAuthStateTo).toHaveBeenCalledExactlyOnceWith({ id: 'main' });
    // 同一窗口之后再调用（例如 renderer 重载）不重复补发。
    const reload = run.fromMainWindow();
    run.settles[2]();
    await reload;
    expect(run.replayAuthStateTo).toHaveBeenCalledTimes(1);
  });

  it('does not start a second call after the renderer arrived first', async () => {
    const run = startupHandler();
    const renderer = run.fromMainWindow();
    expect(run.startupAuthInitialize.start()).toBe(false);
    run.settles[0]();
    await expect(renderer).resolves.toBe(run.results[0]);
    expect(run.initialize).toHaveBeenCalledTimes(1);
    expect(run.replayAuthStateTo).not.toHaveBeenCalled();
  });
});
