/**
 * 跨模块回归(#2506):deferred Codex restart × AgentInputCoordinator 的
 * gate-clear → wake → drain 端到端可靠性。
 *
 * Issue 形态:全局 Codex 凭证/运行时变更被延期,已有会话里的后续消息进入
 * 持久化输入队列,但延期重启兑现、报告"唤醒 N 个会话"之后,消息既没落
 * `messages` 也没产生第二次派发 —— 静默滞留。此前 service 与 coordinator
 * 只各自有单元测试,唤醒链路(register 的 onApplied → wakeSession 接线、
 * hasPendingCredentialSwitch 的 isPending 联动)从未被串起来测过;drain 被
 * gate 挡住时也零日志,断点无从定位。
 *
 * 本文件用**真实的两个模块**接线(mock 只到 deps 边界),覆盖:
 *  1. 基线端到端:pending 门挡住 → 重启兑现(关旧 Session)→ wake → 恰好
 *     派发一次、恰好落一条 user message、退出 snapshot;
 *  2. 竞态排列 a:wake 在 ensureQueueRestored 仍在读取期间到达;
 *  3. 竞态排列 b:close cleanup 吞掉已排程的 wake-drain(register 接线的
 *     「先关后唤」顺序是正确性前提,本用例锁住反例的行为);
 *  4. 竞态排列 c:迟到/重复 wake 的恰好一次语义;
 *  5. drain blocked 结果级诊断落日志(gate 枚举 + 脱敏字段;常规 gate 走
 *     debug,仅 queue-restore-failed 保留 info)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentInputCoordinator } from '../agent-input-coordinator.js';
import type {
  AgentInputCoordinatorDeps,
  AgentInputSendResult,
} from '../agent-input-coordinator.js';
import { DeferredCodexRestartService } from '../deferredCodexRestart.js';
import {
  createDeferredRestartAppliedWake,
  createDeferredRestartQueueGate,
} from '../deferredRestartQueueWiring.js';
import type {
  AgentInputProjection,
  AgentInputQueuedMessage,
} from '../../../shared/agentInputQueue.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    createMessage: vi.fn(async (...args: unknown[]) => {
      void args;
      return {};
    }),
    touchUserSendInDb: vi.fn(async () => {}),
    logger,
  };
});

vi.mock('../../localDb/ipc/messages.js', () => ({
  createMessage: mocks.createMessage,
}));

vi.mock('../../localDb/ipc/sessions.js', () => ({
  touchUserSendInDb: mocks.touchUserSendInDb,
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => mocks.logger,
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 24; i += 1) {
    await Promise.resolve();
  }
};

function makeItem(
  clientId: string,
  text: string,
  patch: Partial<AgentInputQueuedMessage> = {},
): AgentInputQueuedMessage {
  return {
    clientId,
    text,
    persistedContent: text,
    model: 'codex/gpt-5.5',
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/repo',
    chatMessage: {
      clientId,
      role: 'user',
      content: text,
      isStreaming: false,
      createdAt: '2026-08-12T00:00:00.000Z',
    },
    createOpts: {
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'codex/gpt-5.5',
      effort: 'medium',
      permissionMode: 'default',
      userPrompt: '',
      makerMemoryEnabled: true,
      displayReasoning: 'summarized',
    },
    ...patch,
  };
}

async function persistQueuedUserMessage(
  sessionId: string,
  sendOpts: Parameters<AgentInputCoordinatorDeps['sendToAgent']>[3],
): Promise<void> {
  const persist = sendOpts.persistUserMessage;
  if (!persist) return;
  (persist as { onPersisting?: () => void }).onPersisting?.();
  await mocks.createMessage(
    sessionId,
    {
      clientId: persist.clientId,
      role: 'user',
      content: persist.content,
      agentMeta: { delivery: persist.delivery, sdkSessionId: persist.sdkSessionId },
    },
    { shouldBroadcast: persist.shouldBroadcast },
  );
  await persist.onPersisted?.();
}

function sendSuccess(source = 'test'): AgentInputSendResult {
  return { kind: 'session-dispatch', source, dispatched: true };
}

/**
 * 真实 coordinator + 真实 DeferredCodexRestartService 的接线 harness。
 * gate 谓词与 onApplied 唤醒**直接复用生产接线工厂**
 * (deferredRestartQueueWiring.ts,register.ts 同款 —— 不再照抄形状自行重
 * 实现,谓词/唤醒逻辑改变时本回归同步失败;register 侧确实经由工厂接线由
 * 下方源码断言锁住);restart 的实现由用例注入(默认模拟 register 的 close
 * cleanup:onSessionClosed)。
 */
function createRestartHarness() {
  let running = false;
  let busyOtherSession = false;
  const projections: AgentInputProjection[] = [];
  let loadQueueSnapshot: ((sessionId: string) => Promise<AgentInputQueuedMessage[]>) | null = null;

  const sendToAgent = vi.fn<AgentInputCoordinatorDeps['sendToAgent']>(
    async (sessionId, _message, _createOpts, sendOpts) => {
      await persistQueuedUserMessage(sessionId, sendOpts);
      running = true;
      return sendSuccess();
    },
  );
  const persistQueueSnapshot =
    vi.fn<NonNullable<AgentInputCoordinatorDeps['persistQueueSnapshot']>>();

  // eslint-disable-next-line prefer-const
  let coordinator: AgentInputCoordinator;

  const service = new DeferredCodexRestartService({
    restart: async () => {
      await restartImpl();
    },
    hasBusyLocalCodexSession: () => busyOtherSession,
    listLocalCodexSessionIds: () => [SID],
    onApplied: createDeferredRestartAppliedWake({
      wakeSession: (sessionId, reason) => coordinator.wakeSession(sessionId, reason),
    }),
    retryDelayMs: 60_000,
    logger: { info: vi.fn(), warn: vi.fn() },
  });

  const SID = 'codex-deferred-restart-session';
  // 默认 restart 实现 = register 的 close cleanup 时序:关闭本地 Codex live
  // Session(coordinator.onSessionClosed)并复位 turn 活性。
  let restartImpl: () => Promise<void> = async () => {
    coordinator.onSessionClosed(SID);
    running = false;
  };

  coordinator = new AgentInputCoordinator({
    sendToAgent,
    steerToAgent: vi.fn(async () => {}),
    abortSession: vi.fn(async () => {}),
    isTurnRunning: () => running,
    getTurnGeneration: () => 0,
    hasPendingInteraction: () => false,
    getAgentKind: () => 'codex',
    getSdkSessionId: vi.fn(async () => 'sdk-session'),
    hasAssistantProgressAfter: () => Promise.resolve(false),
    hasPendingCredentialSwitch: createDeferredRestartQueueGate({
      hasPendingCredentialSwitchEntry: () => false,
      isDeferredRestartPending: () => service.isPending(),
      listActiveSessions: () => [{ id: SID, agentKind: 'codex', remoteHostId: null }],
    }),
    emitProjection: (projection) => {
      projections.push(projection);
    },
    persistQueueSnapshot,
    loadQueueSnapshot: (sessionId) =>
      loadQueueSnapshot ? loadQueueSnapshot(sessionId) : Promise.resolve([]),
    getPersistedClientIds: () => Promise.resolve(new Set()),
  });

  return {
    SID,
    coordinator,
    service,
    sendToAgent,
    persistQueueSnapshot,
    projections,
    setRunning(value: boolean) {
      running = value;
    },
    setBusyOtherSession(value: boolean) {
      busyOtherSession = value;
    },
    setRestartImpl(fn: () => Promise<void>) {
      restartImpl = fn;
    },
    setLoadQueueSnapshot(fn: ((sessionId: string) => Promise<AgentInputQueuedMessage[]>) | null) {
      loadQueueSnapshot = fn;
    },
  };
}

function latestProjection(projections: AgentInputProjection[]): AgentInputProjection {
  const latest = projections.at(-1);
  if (!latest) throw new Error('no projection emitted');
  return latest;
}

function latestSnapshotClientIds(
  persistQueueSnapshot: ReturnType<typeof createRestartHarness>['persistQueueSnapshot'],
): string[] {
  const latest = persistQueueSnapshot.mock.calls.at(-1);
  if (!latest) return [];
  return (latest[1] as AgentInputQueuedMessage[]).map((item) => item.clientId);
}

function drainBlockedLogs(): Array<Record<string, unknown>> {
  // 常规 gate 的阻塞诊断走 debug(正常排队每次 drain 都进这里,info 会刷爆
  // packaged 日志);只有 queue-restore-failed 保留 info 常驻观测。
  return mocks.logger.debug.mock.calls
    .filter(([message]) => message === 'drain blocked')
    .map(([, meta]) => meta as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deferred Codex restart × input queue drain (#2506)', () => {
  it('端到端:pending 门挡住的后续消息在重启兑现后恰好派发一次并落库', async () => {
    const h = createRestartHarness();
    await h.coordinator.ensureQueueRestored(h.SID);
    mocks.logger.debug.mockClear();

    // 另一会话忙 → 重启延期挂起;本会话上一轮已完成(running=false)。
    h.setBusyOtherSession(true);
    h.service.schedule('memory-change');
    expect(h.service.isPending()).toBe(true);

    // 用户在已有会话发后续消息:进入队列 + 写入 snapshot,但不落 messages、不派发。
    h.coordinator.enqueue(h.SID, makeItem('m-1', 'follow-up after restart gate'));
    await flush();
    expect(h.sendToAgent).not.toHaveBeenCalled();
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(latestSnapshotClientIds(h.persistQueueSnapshot)).toEqual(['m-1']);
    // 诊断:被 pending 门挡住的 drain 必须留痕(此前零日志 → 静默滞留)。
    expect(
      drainBlockedLogs().some((meta) => meta.gate === 'credential-switch-gate'),
    ).toBe(true);

    // 挡路会话结束 → 延期重启兑现:关旧 Session → 清 pending 门 → onApplied 唤醒。
    h.setBusyOtherSession(false);
    h.service.onSessionSettled();
    await flush();

    expect(h.service.isPending()).toBe(false);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({
      type: 'user',
      content: 'follow-up after restart gate',
    });
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    // 派发 + 落库后退出 snapshot,队列清空。
    expect(latestSnapshotClientIds(h.persistQueueSnapshot)).toEqual([]);
    expect(latestProjection(h.projections).pendingQueue).toEqual([]);
  });

  it('竞态 a:wake 在队列恢复读取期间到达 → 被 gate 挡下并留痕;安静恢复进入暂停态同样可诊断', async () => {
    const h = createRestartHarness();
    const restore = deferred<AgentInputQueuedMessage[]>();
    h.setLoadQueueSnapshot(() => restore.promise);

    // 恢复读取挂起中,wake 恰好到达(如延期重启在 app 启动恢复窗口内兑现)。
    const restoring = h.coordinator.ensureQueueRestored(h.SID);
    h.coordinator.wakeSession(h.SID, 'deferred-codex-restart-applied');
    await flush();
    expect(h.sendToAgent).not.toHaveBeenCalled();
    expect(
      drainBlockedLogs().some((meta) => meta.gate === 'queue-restore-in-progress'),
    ).toBe(true);

    // 恢复完成:会话安静(无 turn 活性)→ 既有语义是 queuePausedByRestore 暂停,
    // 等用户显式输入解锁 —— 崩溃快照里的旧 prompt 不能被自动化路径悄悄放跑。
    restore.resolve([makeItem('m-restored', 'prompt from crash snapshot')]);
    await restoring;
    await flush();
    expect(h.sendToAgent).not.toHaveBeenCalled();

    // 迟到的二次 wake 不越过暂停态,且必须留下 gate 诊断而不是静默无痕。
    mocks.logger.debug.mockClear();
    h.coordinator.wakeSession(h.SID, 'deferred-codex-restart-applied');
    await flush();
    expect(h.sendToAgent).not.toHaveBeenCalled();
    expect(
      drainBlockedLogs().some((meta) => meta.gate === 'queue-paused-by-restore'),
    ).toBe(true);

    // 用户显式输入(INPUT_ENQUEUE 携带 resumeRestorePausedQueue)解除暂停:
    // 恢复的队首立即派发,新输入按序在队等它的 turn 收口(常规队列行为,
    // 已有既有覆盖)—— 这是暂停态的既定解锁路径。
    h.coordinator.enqueue(h.SID, makeItem('m-user', 'user follow-up'), {
      resumeRestorePausedQueue: true,
    });
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({
      type: 'user',
      content: 'prompt from crash snapshot',
    });
    expect(
      latestProjection(h.projections).pendingQueue.map((item) => item.clientId),
    ).toEqual(['m-user']);
  });

  it('竞态 b:close cleanup 吞掉已排程的 wake-drain → 必须由后续 wake 补救(锁住「先关后唤」时序前提)', async () => {
    const h = createRestartHarness();
    await h.coordinator.ensureQueueRestored(h.SID);

    h.setBusyOtherSession(true);
    h.service.schedule('memory-change');
    h.coordinator.enqueue(h.SID, makeItem('m-1', 'queued before close race'));
    await flush();
    expect(h.sendToAgent).not.toHaveBeenCalled();

    // 门已清除(重启已兑现),但 wake 的 microtask 尚未执行时 close cleanup 到达:
    // cancelScheduledDrain 会作废这次 wake —— 单靠这一次 wake 消息就永久滞留。
    h.setBusyOtherSession(false);
    h.service.clear();
    h.coordinator.wakeSession(h.SID, 'deferred-codex-restart-applied');
    h.coordinator.onSessionClosed(h.SID);
    await flush();
    expect(h.sendToAgent).not.toHaveBeenCalled();

    // register 接线的正确性前提正在于此:onApplied 严格发生在 restart(全部
    // close)之后,wake 不会落进 close 窗口。补一次 close 之后的 wake 即派发。
    h.coordinator.wakeSession(h.SID, 'deferred-codex-restart-applied');
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
  });

  it('竞态 c:迟到与重复 wake 保持恰好一次派发;清空后的迟到 wake 是 no-op', async () => {
    const h = createRestartHarness();
    await h.coordinator.ensureQueueRestored(h.SID);

    h.setBusyOtherSession(true);
    h.service.schedule('memory-change');
    h.coordinator.enqueue(h.SID, makeItem('m-1', 'exactly once'));
    await flush();

    // 重启兑现 → wake;紧跟两次冗余 wake(如另一来源的 superseded 唤醒)。
    h.setBusyOtherSession(false);
    h.service.onSessionSettled();
    await flush();
    h.coordinator.wakeSession(h.SID, 'deferred-codex-restart-superseded');
    h.coordinator.wakeSession(h.SID, 'deferred-codex-restart-applied');
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);

    // 用户清空队列后才到达的迟到 wake:无派发、无落库、无崩溃。
    const h2 = createRestartHarness();
    await h2.coordinator.ensureQueueRestored(h2.SID);
    h2.service.schedule('memory-change');
    h2.coordinator.enqueue(h2.SID, makeItem('m-2', 'cleared before wake'));
    await flush();
    h2.coordinator.remove(h2.SID, 'm-2');
    h2.service.clear();
    h2.coordinator.wakeSession(h2.SID, 'deferred-codex-restart-applied');
    await flush();
    expect(h2.sendToAgent).not.toHaveBeenCalled();
  });
});

describe('register.ts 真实接线经由共享工厂(源码断言,#2506)', () => {
  // harness 复用了生产接线工厂,这里锁住「register 确实也经由同一工厂接线」:
  // 谁把 register 改回手写谓词/手写唤醒循环,这两条会失败,提示同步回归覆盖。
  const registerSource = readFileSync(
    fileURLToPath(new URL('../register.ts', import.meta.url)),
    'utf8',
  );

  it('coordinator 的 hasPendingCredentialSwitch 经由 createDeferredRestartQueueGate', () => {
    expect(registerSource).toMatch(
      /hasPendingCredentialSwitch:\s*createDeferredRestartQueueGate\(\{/,
    );
    // 三个 dep 都在同一接线块里:凭证切换登记表、重启 pending、活跃会话来源。
    const gateBlock = registerSource.slice(
      registerSource.indexOf('hasPendingCredentialSwitch: createDeferredRestartQueueGate'),
    );
    const gateHead = gateBlock.slice(0, 600);
    expect(gateHead).toContain('pendingCredentialSwitchHolder?.has(sessionId) === true');
    expect(gateHead).toContain('deferredCodexRestartHolder?.isPending() === true');
    expect(gateHead).toContain('maker.listActiveSessions()');
  });

  it('DeferredCodexRestartService 的 onApplied 经由 createDeferredRestartAppliedWake', () => {
    expect(registerSource).toMatch(/onApplied:\s*createDeferredRestartAppliedWake\(\{/);
    const wakeBlock = registerSource.slice(
      registerSource.indexOf('onApplied: createDeferredRestartAppliedWake'),
    );
    expect(wakeBlock.slice(0, 300)).toContain('inputCoordinator.wakeSession(sessionId, reason)');
  });
});
