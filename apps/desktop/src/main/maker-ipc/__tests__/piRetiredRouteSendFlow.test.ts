import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSendResult } from '@cindy/maker-core';

import {
  clearSessionProvider,
  getSessionProvider,
  setSessionProvider,
} from '../../maker-host/session-provider-store.js';
import { createContextOverflowRollover } from '../contextOverflowRollover.js';
import {
  createMakerSendTransaction,
  type MakerSendTransactionDeps,
  type MakerSendTransactionSession,
} from '../makerSendTransaction.js';
import { createPiRetiredRouteWindowGuard } from '../piRetiredRouteWindowGuard.js';
import type { MakerSessionCreateOpts } from '../sessionRequest.js';
import { applyRuntimeSetModelChange, type RuntimeSetModelMaker } from '../runtimeSetModel.js';

/**
 * PR #4496 / issue #4486 / #4840：本地 Pi 跨来源切换会退役旧 runtime，目标 route 交给
 * 下一次发送懒创建。目录窗口可能与新进程 `get_state` 回报的窗口不同，所以「下一次发送、
 * 消息真正发给模型之前」必须用**新进程实际窗口**重新核验；实际窗口更小且旧历史达到 90%
 * 固定压力线时，沿用 #3601 的缩窗保护（bounded handoff + context_rebuild）；核验/保护
 * 失败则不发送这条消息、不回退旧供应商，并把消息退回队列等用户重试。
 *
 * 本文件驱动真实单元，不做 register.ts 源码字符串断言：
 *  - `applyRuntimeSetModelChange`：`handleSetModel` 实际调用的应用事务（产出 runtimeRetired）；
 *  - `createPiRetiredRouteWindowGuard`：退役 route 的待核验登记与发送前核验；
 *  - `createContextOverflowRollover().prepareModelWindowSwitch`：#3601 的缩窗事务本体；
 *  - `createMakerSendTransaction().sendToAgentAccepted`：真实发送事务（懒创建 → 发送）。
 */

const SESSION_ID = 'pi-retired-route-send';
const OLD_MODEL = 'grok-4.6';
const OLD_PROVIDER = 'xai';
const NEW_MODEL = 'gpt-5.6-sol';
const NEW_PROVIDER = 'openai';
const CATALOG_WINDOW = 200_000;
const OLD_HISTORY_TOKENS = 95_000;

/** 真实 Pi session 比发送事务接口多一个用量快照；测试里按真实形状声明。 */
interface PiSendSession extends MakerSendTransactionSession {
  getUsageSnapshot: () => {
    tokenUsage: Record<string, unknown>;
    contextTokens: number;
    contextWindow: number;
    costUsd: number;
  };
}

afterEach(() => {
  clearSessionProvider(SESSION_ID);
});

/** 退役步骤：与 handleSetModel 调用的是同一个应用事务。 */
async function retireOldPiRuntime(): Promise<void> {
  setSessionProvider(SESSION_ID, OLD_PROVIDER);
  const maker: RuntimeSetModelMaker = {
    getSession: () => ({
      agentKind: 'pi',
      remoteHostId: null,
      model: OLD_MODEL,
      setModel: vi.fn(async () => {}),
    }),
    listActiveSessions: () => [
      { id: SESSION_ID, agentKind: 'pi', remoteHostId: null, isTurnRunning: () => false },
    ],
    closeSession: vi.fn(async () => {}),
  };

  await expect(
    applyRuntimeSetModelChange({
      maker,
      sessionId: SESSION_ID,
      model: NEW_MODEL,
      providerId: NEW_PROVIDER,
      clearPendingCredentialSwitch: vi.fn(),
      wakeSessionInputQueue: vi.fn(),
    }),
  ).resolves.toEqual({ status: 'applied', runtimeRetired: true });
  expect(getSessionProvider(SESSION_ID)).toBe(NEW_PROVIDER);
}

function createLiveSession(actualWindow: number | undefined): PiSendSession {
  return {
    id: SESSION_ID,
    instanceId: 'pi-instance-1',
    agentKind: 'pi',
    workDir: 'D:\\repo',
    remoteHostId: null,
    stablePermissionModeState: { mode: 'ask', generation: 0 },
    stablePlanModeState: { enabled: false, generation: 0 },
    isTurnRunning: vi.fn(() => false),
    getUsageSnapshot: vi.fn(() => ({
      tokenUsage: {},
      contextTokens: 0,
      contextWindow: actualWindow as number,
      costUsd: 0,
    })),
    send: vi.fn(
      async (
        _message: unknown,
        opts?: { onAccepted?: () => Promise<void>; onDispatching?: () => void },
      ): Promise<SessionSendResult> => {
        await opts?.onAccepted?.();
        opts?.onDispatching?.();
        return { accepted: true };
      },
    ),
  };
}

/**
 * 组装「发送前核验」的完整链路：真实 guard + 真实缩窗事务 + 真实发送事务。
 * `routeUsedBySend` 记录消息实际发往的 runtime 是按哪条 route 懒创建的。
 */
function createFlow(
  actualWindow: number | undefined,
  options: { failProtectionClose?: boolean } = {},
) {
  const routeUsedBySend: Array<{ model?: string; providerId?: string | null }> = [];
  const commitRebuild = vi.fn(async () => undefined);
  const closeSession = vi.fn(async () => {
    if (options.failProtectionClose) throw new Error('close failed');
  });

  const rollover = createContextOverflowRollover({
    hasExternalRecoveryOwner: () => false,
    getSessionRow: vi.fn(async () => ({
      status: 'active',
      source: 'desktop',
      agentKind: 'pi',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: '/tmp/pi-session.jsonl',
      contextTokens: OLD_HISTORY_TOKENS,
      contextWindow: CATALOG_WINDOW,
      model: NEW_MODEL,
      providerId: NEW_PROVIDER,
      workingDir: 'D:\\repo',
    })),
    listMessages: vi.fn(async () => [
      { role: 'user', content: 'keep my context', clientId: 'u1', createdAt: 1 },
      { role: 'assistant', content: 'done', clientId: 'a1', createdAt: 2 },
    ]),
    findLatestUser: vi.fn(async () => null),
    findLatestRebuildMeta: vi.fn(async () => null),
    getLiveSession: vi.fn(() => createLiveSession(actualWindow)),
    rehydrateColdPiRuntimeForWindowVerification: vi.fn(async () => undefined),
    closeSession,
    getAutoCompactThresholdPct: undefined,
    resolveVerifiedWindow: vi.fn(() => CATALOG_WINDOW),
    drainPersistQueue: vi.fn(async () => undefined),
    commitRebuild,
    setPendingHandoff: vi.fn(),
    readPendingHandoffGeneration: vi.fn(() => 3),
    replayUserMessage: vi.fn(async () => ({ accepted: true })),
    onRebuilt: vi.fn(),
    withCloseSuppressed: async <T>(_sessionId: string, fn: () => Promise<T>) => fn(),
    log: { info: vi.fn(), warn: vi.fn() },
  });

  /** 退役后没有 live runtime；发送事务懒创建它（与真实路径一致）。 */
  const state: { liveSession?: PiSendSession } = {};

  const guard = createPiRetiredRouteWindowGuard({
    prepareModelWindowSwitch: (sessionId, target) =>
      rollover.prepareModelWindowSwitch(sessionId, target),
    readLiveContextWindow: () => {
      const window = state.liveSession?.getUsageSnapshot().contextWindow;
      return typeof window === 'number' && Number.isFinite(window) && window > 0
        ? window
        : undefined;
    },
    log: { info: vi.fn(), warn: vi.fn() },
  });

  const flow = {
    get liveSession(): PiSendSession | undefined {
      return state.liveSession;
    },
    routeUsedBySend,
    commitRebuild,
    createDbMessage: vi.fn(async () => {}),
    guard,
    deps: undefined as unknown as MakerSendTransactionDeps,
    /** register.ts 在 apply 报出 runtimeRetired 的同一位置登记待核验。 */
    recordPendingCheck() {
      guard.record(SESSION_ID, {
        model: NEW_MODEL,
        providerId: NEW_PROVIDER,
        catalogTargetWindow: CATALOG_WINDOW,
        previousWindow: CATALOG_WINDOW,
        contextTokensFloor: OLD_HISTORY_TOKENS,
      });
    },
    sendNextMessage() {
      return createMakerSendTransaction(flow.deps).sendToAgentAccepted(
        SESSION_ID,
        'next message',
        {
          id: SESSION_ID,
          agentKind: 'pi',
          workingDir: 'D:\\repo',
          model: NEW_MODEL,
          providerId: NEW_PROVIDER,
        },
        { persistUserMessage: { clientId: 'input-1', content: 'next message' } },
      );
    },
  };

  const deps: MakerSendTransactionDeps = {
    getSession: vi.fn(() => state.liveSession),
    closeSession: vi.fn(async () => {}),
    preflightBotRuntimeResources: vi.fn(async () => {}),
    getSessionMeta: vi.fn(async () => ({ title: 'Pi task' })),
    ensureRemoteReadyForSessionStart: vi.fn(async () => {}),
    checkWorkDirExists: vi.fn(async () => true),
    isOrcaMcpHydrated: vi.fn(() => true),
    buildCreateOptsWithStderr: vi.fn((opts) => opts),
    synthesizeOrcaVendorOptionsFromDb: vi.fn(async () => false),
    readSessionExtraDirsFromDb: vi.fn(async () => []),
    readSessionWorkingDirFromDb: vi.fn(async () => null),
    readWorkingDirectoryRecoveryCreateOpts: vi.fn(
      async (): Promise<MakerSessionCreateOpts> => ({
        agentKind: 'pi',
        workingDir: 'D:\\repo',
        model: NEW_MODEL,
      }),
    ),
    withRehydrateCloseSuppressed: vi.fn(async (_sessionId, fn) => await fn()),
    bootstrapSession: vi.fn(async (opts) => {
      routeUsedBySend.push({ model: opts.model, providerId: opts.providerId });
      const session = createLiveSession(actualWindow);
      state.liveSession = session;
      return {
        session,
        didInjectOrcaInstructions: false,
        didInjectProjectContext: false,
      };
    }),
    markOrcaRoleIfNeeded: vi.fn(async () => {}),
    broadcastSessionCreated: vi.fn(),
    prepareSendUserMessage: vi.fn(async (_sessionId, message) => message),
    createDbMessage: flow.createDbMessage,
    linkPiUserEntry: vi.fn(async () => true),
    previewUserPrompt: vi.fn(),
    dispatchUserPromptPreview: vi.fn(),
    commitUserPromptPreview: vi.fn(),
    rollbackUserPromptPreview: vi.fn(),
    isSessionRunningError: vi.fn(() => false),
    verifyRetiredRouteWindowBeforeSend: async (sessionId) => {
      const verification = await guard.verifyBeforeSend(sessionId);
      if (verification.status === 'failed') {
        throw Object.assign(new Error(verification.message), { code: verification.code });
      }
      return verification.status === 'verified' ? { rebuilt: verification.rebuilt } : undefined;
    },
    log: { info: vi.fn(), warn: vi.fn() },
  };
  flow.deps = deps;
  return flow;
}

describe('Pi retired route → next send verification', () => {
  it('正常跨来源：退役后下一条消息发往新来源，核验通过且不做重建', async () => {
    await retireOldPiRuntime();
    const flow = createFlow(CATALOG_WINDOW);
    flow.recordPendingCheck();

    await expect(flow.sendNextMessage()).resolves.toMatchObject({ accepted: true });

    // 消息实际发往按新 route 懒创建的 runtime，且真的调用了 send。
    expect(flow.routeUsedBySend).toEqual([{ model: NEW_MODEL, providerId: NEW_PROVIDER }]);
    expect(flow.liveSession?.send).toHaveBeenCalledTimes(1);
    expect(getSessionProvider(SESSION_ID)).toBe(NEW_PROVIDER);
    expect(flow.commitRebuild).not.toHaveBeenCalled();
    // 核验成功后标记清除，不再重复核验。
    expect(flow.guard.has(SESSION_ID)).toBe(false);
  });

  it('目录 200K / 实际 100K / 旧历史 95K：发送前按实际窗口完成 #3601 缩窗保护', async () => {
    await retireOldPiRuntime();
    const flow = createFlow(100_000);
    flow.recordPendingCheck();

    await expect(flow.sendNextMessage()).resolves.toMatchObject({ accepted: true });

    // 90% 固定压力线按**实际窗口**重判：95K / 100K = 95% → 先换干净原生窗口。
    expect(flow.commitRebuild).toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(String),
      expect.objectContaining({ reason: 'model-window-switch', sourceModel: NEW_MODEL }),
    );
    // 重建关掉了刚懒创建的 runtime：这条消息必须由重建后的新进程承接，而不是旧对象。
    expect(flow.routeUsedBySend).toEqual([
      { model: NEW_MODEL, providerId: NEW_PROVIDER },
      { model: NEW_MODEL, providerId: NEW_PROVIDER },
    ]);
    expect(flow.liveSession?.send).toHaveBeenCalledTimes(1);
    expect(flow.guard.has(SESSION_ID)).toBe(false);
  });

  it('核验失败（新进程没回报窗口）：这条消息不发送、不落库、标记保留', async () => {
    await retireOldPiRuntime();
    const flow = createFlow(undefined);
    flow.recordPendingCheck();

    await expect(flow.sendNextMessage()).rejects.toThrow(/这条消息没有发送/);

    expect(flow.liveSession?.send).not.toHaveBeenCalled();
    expect(flow.createDbMessage).not.toHaveBeenCalled();
    expect(flow.commitRebuild).not.toHaveBeenCalled();
    expect(flow.guard.has(SESSION_ID)).toBe(true);
    // 不静默改发旧供应商：route store 仍是用户选的新来源。
    expect(getSessionProvider(SESSION_ID)).toBe(NEW_PROVIDER);
  });

  it('保护失败（缩窗事务关闭旧 runtime 抛错）：这条消息不发送，也不回退旧供应商', async () => {
    await retireOldPiRuntime();
    const flow = createFlow(100_000, { failProtectionClose: true });
    flow.recordPendingCheck();

    await expect(flow.sendNextMessage()).rejects.toThrow(/这条消息没有发送/);

    expect(flow.liveSession?.send).not.toHaveBeenCalled();
    expect(flow.guard.has(SESSION_ID)).toBe(true);
    expect(getSessionProvider(SESSION_ID)).toBe(NEW_PROVIDER);
  });
});
