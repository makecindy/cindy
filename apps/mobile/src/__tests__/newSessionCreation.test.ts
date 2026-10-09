/**
 * 新建会话乐观管线(newSessionCreation)状态机测试:
 *  - start 同步段:合成会话行(pendingLocalCreation)+ 乐观排队气泡即时入 store;
 *  - createSession 收到预生成 id;瞬态失败 probe-before-retry(回执丢失不重复建会话);
 *    确定性失败不盲重、直接 create-failed;
 *  - enqueue 失败的分辨:队列 / 消息含 clientId → 按成功收敛;确认未应用 →
 *    enqueue-failed(乐观气泡摘除,草稿留给会话页回填);
 *  - retry(同 id 幂等)与 dismiss(返回编辑)收口。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { isDurableOutboxHandedOff, isDurableOutboxSettled, type DurableOutboxRecord } from '@/session/durableOutbox';
import { buildOutboxItem, outboxItemAttachments } from '@/session/sessionOutbox';

const recoveryStorage = vi.hoisted(() => new Map<string, string>());
const persistCancelledDraft = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/session/mobileDurableOutbox', () => ({ persistCancelledCreationDraft: persistCancelledDraft }));
const recoveryAsyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(async (key: string) => recoveryStorage.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => {
    recoveryStorage.set(key, value);
  }),
  removeItem: vi.fn(async (key: string) => {
    recoveryStorage.delete(key);
  }),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: recoveryAsyncStorage,
}));

// expo-crypto 是原生模块(createUuid 的 CSPRNG 兜底;node 环境有 crypto.randomUUID
// 不会走到),node 下 import 副作用不可控,mock 掉。
vi.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => new Uint8Array(n).fill(7),
}));
import {
  dismissNewSessionCreation,
  dismissRecoveredPrecreatedSession,
  drainStashedNewSessionDraft,
  getNewSessionCreationTask,
  prepareNewSessionCreationForEdit,
  retryNewSessionCreation,
  shouldBlockSessionSync,
  stashNewSessionDraftForEdit,
  startNewSessionCreation,
  type NewSessionCreationParams,
} from '@/session/newSessionCreation';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { takeOrcaStartFailure } from '@/session/orcaTeam';
import { sessionFromCreateResult, type NewSessionDraft } from '@/session/newSession';
import {
  __testing as recoveryTesting,
  listPendingPrecreatedWorktrees,
  registerPendingPrecreatedWorktree,
} from '@/session/precreatedWorktreeRecovery';

const DRAFT: NewSessionDraft = {
  agentKind: 'claude-code',
  workspaceKind: 'project',
  workingDir: '/repo',
  model: 'claude-sonnet-4-6',
  providerId: null,
  effort: 'medium',
  permissionMode: 'auto',
  fastMode: false,
  firstMessage: 'hello world',
};

// Execute the bridge's actual refresh callback with the real session store.
// This includes hydration, cancellation cleanup and message-work lease release.
const bridgeSource = ts.createSourceFile('MobileOutboxBridge.tsx', readFileSync(resolve(
  process.cwd(), 'src/session/MobileOutboxBridge.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let refreshSource = '';
let reconciliationSource = '';
function findRefresh(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(bridgeSource) === 'refreshLeases') {
    refreshSource = node.initializer!.getText(bridgeSource);
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(bridgeSource) === 'needsReconciliation') {
    reconciliationSource = node.initializer!.getText(bridgeSource);
  }
  ts.forEachChild(node, findRefresh);
}
findRefresh(bridgeSource);
if (!refreshSource) throw new Error('Missing outbox lease refresh callback');
function outboxLeaseHarness(initial: DurableOutboxRecord[]) {
  let records = initial;
  const visible = new Set<string>();
  const leases = new Map<string, ReturnType<typeof remoteSessionStore.acquireSessionMessageWork>>();
  const bindings = { isCurrent: () => true, mobileDurableOutbox: { getSnapshot: () => records },
    isDurableOutboxHandedOff, isDurableOutboxSettled, remoteSessionStore, sessionFromCreateResult, outboxItemAttachments,
    findRemoteHistoryView: (_deviceId: string, sessionId: string) => ({ isActive: () => visible.has(sessionId) }),
    dismissRecoveredPrecreatedSession, leases,
    leaseKey: (record: DurableOutboxRecord) => JSON.stringify([record.deviceId, record.item.sessionId]) };
  const compiled = ts.transpileModule(`function create(bindings) {
    const { ${Object.keys(bindings).join(', ')} } = bindings;
    const needsReconciliation = ${reconciliationSource};
    return ${refreshSource};
  }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const create = new Function(`${compiled}; return create;`)() as (values: typeof bindings) => () => void;
  return { refresh: create(bindings), leases, visible, setRecords: (next: DurableOutboxRecord[]) => { records = next; } };
}
function recoveryOutboxRecord(sessionId: string): DurableOutboxRecord {
  return { version: 1, accountId: 'owner-a', deviceId: 'dev-1', createdAt: 1, state: 'failed', uploads: [],
    creation: { draft: DRAFT, deviceName: 'PC', planModeArm: false, restorePermissionMode: null },
    item: buildOutboxItem({ clientId: `message-${sessionId}`, sessionId, text: DRAFT.firstMessage,
      quotesEncoded: false, agentReferences: [], pastedTextRanges: [], slashCommandRanges: [],
      permissionModeAtSend: DRAFT.permissionMode, readyAttachments: [], readyPreviews: [], claimedUploads: [] }) };
}

interface MakerMock {
  createSession: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  listMessages: ReturnType<typeof vi.fn>;
  setPlanMode: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  worktree: {
    discardPrecreated: ReturnType<typeof vi.fn>;
    cancelPrecreated?: ReturnType<typeof vi.fn>;
  };
  input: {
    enqueue: ReturnType<typeof vi.fn>;
    getProjection: ReturnType<typeof vi.fn>;
  };
}

function makeMaker(overrides: Partial<MakerMock> = {}): MakerMock {
  return {
    createSession: vi.fn(async (opts: { id?: string }) => ({ sessionId: opts.id })),
    getSession: vi.fn(async () => {
      throw new Error('NOT_FOUND');
    }),
    listMessages: vi.fn(async () => []),
    setPlanMode: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    worktree: {
      discardPrecreated: vi.fn(async () => ({ discarded: true })),
    },
    ...overrides,
    input: {
      enqueue: vi.fn(async () => ({ sessionId: 's', pendingQueue: [] })),
      getProjection: vi.fn(async () => ({ sessionId: 's', pendingQueue: [] })),
      ...(overrides.input ?? {}),
    },
  };
}

function makeParams(sessionId: string, maker: MakerMock, patch: Partial<NewSessionCreationParams> = {}): NewSessionCreationParams {
  return {
    sessionId,
    deviceId: 'dev-1',
    deviceName: 'Mac',
    draft: DRAFT,
    attachments: [],
    planModeArm: false,
    legacyPlanRestore: null,
    confirmUnauthenticated: () => Promise.resolve({ unauthenticated: false, fresh: null }),
    authGateHint: '请先在电脑端完成登录。',
    onUnauthenticated: () => undefined,
    transport: {
      maker: maker as unknown as MobileMakerTransport,
      openLink: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => undefined),
    },
    // 退避 / enqueue 分辨轮询的 sleep 注入为立即返回,测试不真等。
    sleep: async () => undefined,
    ...patch,
  };
}

async function flushPipeline(): Promise<void> {
  // 管线全程无真实网络且 sleep 已注入为立即返回,靠让出事件循环多个宏任务收敛
  //(enqueue 分辨轮询最多 4 轮 × 每轮 2 个远程查询)。setImmediate 不受
  // Windows 约 15ms 的 setTimeout(0) 粒度影响；8 轮覆盖管线所有异步边界。
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('newSessionCreation pipeline', () => {
  beforeEach(async () => {
    persistCancelledDraft.mockReset();
    await recoveryTesting.drainMutations();
    recoveryStorage.clear();
    recoveryTesting.resetVolatileLedgers();
    remoteSessionStore.clear();
    drainStashedNewSessionDraft();
    // 清残留 task(上个用例失败态)。
    for (const id of [
      's1',
      's2',
      's3',
      's4',
      's5',
      's6',
      's7',
      's8',
      's9',
      's10',
      's11',
      's12',
      's13',
      's14',
      's15',
      's16',
      's17',
      's18',
      's19',
      's20',
      's21',
      's22',
      's23',
    ]) dismissNewSessionCreation(id);
  });

  it('start 同步段即入 store:合成行带 pendingLocalCreation,首条消息以排队气泡上屏', () => {
    const maker = makeMaker({
      // 挂起 createSession,锁定同步段状态。
      createSession: vi.fn(() => new Promise(() => undefined)),
    });
    startNewSessionCreation(makeParams('s1', maker));
    const row = remoteSessionStore.getSessions().find((s) => s.id === 's1');
    expect(row?.pendingLocalCreation).toBe(true);
    expect(row?.workingDir).toBe('/repo');
    expect(row?.title).toBe('hello world');
    const projection = remoteSessionStore.getInputProjection('s1');
    expect(projection.pendingQueue).toHaveLength(1);
    expect(projection.pendingQueue[0]?.text).toBe('hello world');
    expect(projection.pendingQueue[0]?.clientId).toBe(getNewSessionCreationTask('s1')?.firstMessageClientId);
    expect(shouldBlockSessionSync('s1')).toBe(true);
  });

  it('成功链路:createSession 收到预生成 id、enqueue 用同 clientId,task 移除、守卫解除、禁发标清除', async () => {
    const maker = makeMaker();
    startNewSessionCreation(makeParams('s2', maker));
    const clientId = getNewSessionCreationTask('s2')?.firstMessageClientId;
    await flushPipeline();
    expect(maker.createSession).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }));
    expect(maker.input.enqueue).toHaveBeenCalledWith(
      's2',
      expect.objectContaining({ clientId }),
      expect.anything(),
    );
    expect(getNewSessionCreationTask('s2')).toBeNull();
    expect(shouldBlockSessionSync('s2')).toBe(false);
    // fresh getSession 失败(makeMaker 默认抛 NOT_FOUND)时权威覆盖没发生,管线
    // 收口前必须主动清 pendingLocalCreation 禁发标(codex P2)。
    expect(remoteSessionStore.getSessions().find((s) => s.id === 's2')?.pendingLocalCreation).toBe(false);
    // 入队成功只解禁,标题预览要等到权威标题离开哨兵才让位。
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [
      sessionFromCreateResult({ sessionId: 's2' }, { ...DRAFT, firstMessage: '' }),
    ]);
    expect(remoteSessionStore.getSessions().find((s) => s.id === 's2')?.title).toBe('hello world');
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [
      { ...sessionFromCreateResult({ sessionId: 's2' }, DRAFT), title: '登录失败排查' },
    ]);
    expect(remoteSessionStore.getSessions().find((s) => s.id === 's2')?.title).toBe('登录失败排查');
  });

  it('首条消息 enqueue 前应用手机控制端准备的可信引用快照', async () => {
    const maker = makeMaker();
    remoteSessionStore.upsertDeviceSession(
      'dev-source',
      'Source Mac',
      sessionFromCreateResult({ sessionId: 'source' }, DRAFT),
    );
    const prepareQueuedMessage = vi.fn(async (item) => ({
      ...item,
      trustedSessionReferenceContexts: [{
        sessionId: 'source',
        source: 'device-link' as const,
        deviceId: 'dev-source',
        messages: [{ role: 'user' as const, content: 'trusted source' }],
        range: 'recent' as const,
        messageCount: 1,
        truncated: false,
      }],
    }));
    startNewSessionCreation(makeParams('s12', maker, {
      draft: { ...DRAFT, firstMessage: 'review cindy://session/source' },
      transport: {
        maker: maker as unknown as MobileMakerTransport,
        openLink: vi.fn(async () => undefined),
        subscribe: vi.fn(async () => undefined),
        prepareQueuedMessage,
      },
    }));

    expect(remoteSessionStore.getInputProjection('s12').pendingQueue[0]?.sessionRefs)
      .toEqual([{ sessionId: 'source', deviceId: 'dev-source' }]);
    remoteSessionStore.setDeviceSessions('dev-source', 'Source Mac', []);

    await flushPipeline();

    expect(prepareQueuedMessage).toHaveBeenCalledTimes(1);
    expect(prepareQueuedMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionRefs: [{ sessionId: 'source', deviceId: 'dev-source' }],
    }));
    expect(maker.input.enqueue).toHaveBeenCalledWith(
      's12',
      expect.objectContaining({
        sessionRefs: [{ sessionId: 'source', deviceId: 'dev-source' }],
        trustedSessionReferenceContexts: [expect.objectContaining({
          sessionId: 'source',
          deviceId: 'dev-source',
        })],
      }),
      expect.anything(),
    );
  });

  it('权威 getSession 落地后、enqueue 落定前禁发标保持(弱网窗口不提前解禁,防抢发插队)', async () => {
    const maker = makeMaker({
      getSession: vi.fn(async () => ({ id: 's10', status: 'active' })),
    });
    // enqueue 永久挂起:锁定「getSession 已成功、首条消息还没入队」的窗口。
    maker.input.enqueue.mockImplementation(() => new Promise(() => undefined));
    startNewSessionCreation(makeParams('s10', maker));
    await flushPipeline();
    expect(remoteSessionStore.getSessions().find((s) => s.id === 's10')?.pendingLocalCreation).toBe(true);
    expect(getNewSessionCreationTask('s10')?.status).toBe('running');
  });

  it('dialogue 会话 getSession 失败时,queued.createOpts.workingDir 用 createSession 返回的分配目录兜底', async () => {
    const maker = makeMaker({
      createSession: vi.fn(async (opts: { id?: string }) => ({ sessionId: opts.id, workDir: '/allocated/dialogue-dir' })),
      // getSession 恒失败:走 synthesizeSession fallback(dialogue 草稿 workingDir 为空)。
    });
    startNewSessionCreation(makeParams('s11', maker, {
      draft: { ...DRAFT, workspaceKind: 'dialogue', workingDir: '' },
    }));
    await flushPipeline();
    expect(maker.input.enqueue).toHaveBeenCalledWith(
      's11',
      expect.objectContaining({
        workingDir: '/allocated/dialogue-dir',
        createOpts: expect.objectContaining({ workingDir: '/allocated/dialogue-dir' }),
      }),
      expect.anything(),
    );
    expect(getNewSessionCreationTask('s11')).toBeNull();
  });

  it('started 写盘后二次重验修正草稿 + getSession 失败 → 乐观行回写修正版(codex P1)', async () => {
    // 首次 auth 刷新 fail-open(fresh:null → 管线内 draftPatch 保持 null),但
    // started 写盘后二次重验拿到 fresh 并修正 (model, providerId);getSession
    // 失败走合成 fallback——若乐观行回写只认 draftPatch,此处会跳过,UI/后续
    // 发送仍用已删除来源;排队 lazy-create 材料与乐观行同源,必须一并修正。
    let authCalls = 0;
    const maker = makeMaker();
    startNewSessionCreation(makeParams('s21', maker, {
      draft: {
        ...DRAFT,
        workingDir: '/repo/.cindy-worktrees/auto-one',
        providerId: 'provider-a',
        model: 'model-a',
      },
      precreatedWorktree: {
        path: '/repo/.cindy-worktrees/auto-one',
        recoveryKey: 'recovery-key-1234567890',
        originalWorkingDir: '/repo',
      },
      precreatedWorktreeAccountId: 'owner-a',
      confirmUnauthenticated: async () => {
        authCalls += 1;
        return authCalls === 1
          ? { unauthenticated: false, fresh: null }
          : { unauthenticated: false, fresh: { providers: [] } };
      },
      revalidateDraftAfterAuth: async () => ({ providerId: 'provider-b', model: 'model-b' }),
    }));
    await flushPipeline();
    expect(authCalls).toBe(2);
    // 乐观行回写修正版(不修则 UI 显示 provider-a)
    const row = remoteSessionStore.getSessions().find((s) => s.id === 's21');
    expect(row?.providerId).toBe('provider-b');
    expect(row?.model).toBe('model-b');
    // 排队 lazy-create 材料与乐观行同源
    expect(maker.input.enqueue).toHaveBeenCalledWith(
      's21',
      expect.objectContaining({
        createOpts: expect.objectContaining({ providerId: 'provider-b', model: 'model-b' }),
      }),
      expect.anything(),
    );
  });

  it('started 写盘后二次鉴权中止:账本降回 precreated,任务可返回编辑(codex P2)', async () => {
    // 首次鉴权通过、precreated 账本写成 session-create-started 后,二次鉴权发现
    // 来源全断开——createSession 尚未调用,必须先把账本降回 precreated 再失败:
    // 否则 precreatedWorktreeSessionCreateStarted=true 会让 retry 拒绝重试、
    // prepareForEdit 拒绝返回编辑、recovery 不回收未认领的 started 记录,
    // 用户被困失败页且 worktree 无法自动回收(codex review P2 补强)。
    const precreated = {
      sessionId: 's22',
      deviceId: 'dev-1',
      path: '/repo/.cindy-worktrees/auto-two',
      recoveryKey: 'recovery-key-2222222222',
      originalWorkingDir: '/repo',
    };
    let authCalls = 0;
    const maker = makeMaker();
    startNewSessionCreation(makeParams('s22', maker, {
      draft: { ...DRAFT, workingDir: precreated.path },
      precreatedWorktree: precreated,
      precreatedWorktreeAccountId: 'owner-a',
      // 第 1 次 = 管线内鉴权(persist 之前):通过,fresh fail-open;
      // 第 2 次 = started 写盘后二次鉴权(persist 之后):来源全断开 → 中止,
      // 但 createSession 尚未调用,必须先降级账本。
      confirmUnauthenticated: async () => {
        authCalls += 1;
        return authCalls === 1
          ? { unauthenticated: false, fresh: null }
          : { unauthenticated: true, fresh: null };
      },
      // 二次鉴权分支的开关:revalidateDraftAfterAuth 非空才执行 started 写盘后重验
      revalidateDraftAfterAuth: async () => null,
    }));
    await flushPipeline();
    expect(getNewSessionCreationTask('s22')?.status).toBe('create-failed');
    expect(maker.createSession).not.toHaveBeenCalled();
    // 账本降回 precreated(recovery 可回收未认领 worktree)
    const pending = await listPendingPrecreatedWorktrees('owner-a');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      sessionId: 's22',
      deviceId: 'dev-1',
      path: precreated.path,
      recoveryKey: 'recovery-key-2222222222',
      phase: 'precreated',
    });
    // 任务可返回编辑(不再 retain-only 拒绝)——prepare 会 discard + forget
    const prepared = await prepareNewSessionCreationForEdit('s22');
    expect(prepared).not.toBeNull();
    expect(maker.worktree.discardPrecreated).toHaveBeenCalled();
    await expect(listPendingPrecreatedWorktrees('owner-a')).resolves.toEqual([]);
  });

  it('started 二次鉴权中止 + 账本降级写盘失败:任务不锁死,可返回编辑(codex P1)', async () => {
    // 降级(写回 precreated)罕见失败时,resolveStartedDowngradeOrCommit 走 commit
    // 分支(restoreStarted 把账本写回 started)——第 60 轮无条件抛错会保留
    // sessionCreateStarted=true → retry 拒绝/prepareForEdit 报 cleanup pending/
    // recovery 不回收 = 永久锁死(codex review P1)。修复后两种结果都复位任务。
    const rec = await import('@/session/precreatedWorktreeRecovery');
    const original = rec.registerPendingPrecreatedWorktree;
    let precreatedWrites = 0;
    const spy = vi.spyOn(rec, 'registerPendingPrecreatedWorktree')
      .mockImplementation(async (accountId, record) => {
        if (record.phase === 'precreated') {
          precreatedWrites += 1;
          // 首次降级写盘失败(commit 分支),中止前重试一次持久降级成功——重试
          // 必须真正走 original 写盘,否则调用方以为成功但账本未变。
          if (precreatedWrites <= 1) return false;
          return original(accountId, record);
        }
        return original(accountId, record);
      });
    try {
      const precreated = {
        sessionId: 's23',
        deviceId: 'dev-1',
        path: '/repo/.cindy-worktrees/auto-three',
        recoveryKey: 'recovery-key-3333333333',
        originalWorkingDir: '/repo',
      };
      let authCalls = 0;
      const maker = makeMaker();
      startNewSessionCreation(makeParams('s23', maker, {
        draft: { ...DRAFT, workingDir: precreated.path },
        precreatedWorktree: precreated,
        precreatedWorktreeAccountId: 'owner-a',
        confirmUnauthenticated: async () => {
          authCalls += 1;
          return authCalls === 1
            ? { unauthenticated: false, fresh: null }
            : { unauthenticated: true, fresh: null };
        },
        revalidateDraftAfterAuth: async () => null,
      }));
      await flushPipeline();
      expect(getNewSessionCreationTask('s23')?.status).toBe('create-failed');
      expect(maker.createSession).not.toHaveBeenCalled();
      // 降级失败 → 中止前重试一次持久降级成功 → 账本回 precreated(recovery 可
      // 回收未认领 worktree),且任务可返回编辑(codex review P2)
      const pending = await listPendingPrecreatedWorktrees('owner-a');
      expect(pending[0]?.phase).toBe('precreated');
      expect(precreatedWrites).toBeGreaterThanOrEqual(2);
      const prepared = await prepareNewSessionCreationForEdit('s23');
      expect(prepared).not.toBeNull();
      expect(maker.worktree.discardPrecreated).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('createSession 返回的 id 与预生成 id 不一致 → 确定性 create-failed,不把首条消息发进错误会话', async () => {
    const maker = makeMaker({
      createSession: vi.fn(async () => ({ sessionId: 'mock-created-123' })),
    });
    startNewSessionCreation(makeParams('s8', maker));
    await flushPipeline();
    expect(getNewSessionCreationTask('s8')?.status).toBe('create-failed');
    expect(maker.input.enqueue).not.toHaveBeenCalled();
    // 确定性失败不盲重:createSession 只调一次。
    expect(maker.createSession).toHaveBeenCalledTimes(1);
  });

  it('createSession 瞬态失败 → probe 命中 getSession(回执丢失)→ 不重复建会话,继续走 enqueue', async () => {
    const maker = makeMaker({
      createSession: vi.fn(async () => {
        throw new Error('INVOKE_TIMEOUT');
      }),
      // probe 命中:会话其实已在被控端建成。
      getSession: vi.fn(async () => ({ id: 's3' })),
    });
    startNewSessionCreation(makeParams('s3', maker));
    await flushPipeline();
    // 首次失败后 probe 即命中,不应再有第二次 createSession。
    expect(maker.createSession).toHaveBeenCalledTimes(1);
    expect(maker.input.enqueue).toHaveBeenCalledTimes(1);
    expect(getNewSessionCreationTask('s3')).toBeNull();
  });

  it('最后一次 createSession 瞬态超时但会话已建成 → 终局 probe 命中,按已创建收敛(codex P2)', async () => {
    // createSession 恒瞬态超时;getSession 前两次 probe(attempt 1/2 前)仍 NOT_FOUND,
    // 终局 probe(第 3 次)命中——不得误判 create-failed。
    let getSessionCalls = 0;
    const maker = makeMaker({
      createSession: vi.fn(async () => {
        throw new Error('INVOKE_TIMEOUT');
      }),
      getSession: vi.fn(async () => {
        getSessionCalls += 1;
        if (getSessionCalls >= 3) return { id: 's9' };
        throw new Error('NOT_FOUND');
      }),
    });
    startNewSessionCreation(makeParams('s9', maker));
    await flushPipeline();
    expect(maker.createSession).toHaveBeenCalledTimes(3);
    expect(maker.input.enqueue).toHaveBeenCalledTimes(1);
    expect(getNewSessionCreationTask('s9')).toBeNull();
  });

  it('createSession 确定性失败 → 不重试,create-failed(重试面),守卫仍挡同步', async () => {
    const maker = makeMaker({
      createSession: vi.fn(async () => {
        throw new Error('CHANNEL_NOT_ALLOWED: maker:create-session');
      }),
    });
    startNewSessionCreation(makeParams('s4', maker));
    await flushPipeline();
    expect(maker.createSession).toHaveBeenCalledTimes(1);
    const task = getNewSessionCreationTask('s4');
    expect(task?.status).toBe('create-failed');
    expect(shouldBlockSessionSync('s4')).toBe(true);
    // 重试(同 id 幂等):这次放行。
    maker.createSession.mockImplementation(async (opts: { id?: string }) => ({ sessionId: opts.id }));
    retryNewSessionCreation('s4');
    await flushPipeline();
    expect(getNewSessionCreationTask('s4')).toBeNull();
  });

  it('enqueue 失败且确认未应用 → enqueue-failed:乐观气泡摘除、草稿留在 task 供回填', async () => {
    const maker = makeMaker();
    maker.input.enqueue.mockImplementation(async () => {
      throw new Error('INVOKE_TIMEOUT');
    });
    startNewSessionCreation(makeParams('s5', maker));
    await flushPipeline();
    const task = getNewSessionCreationTask('s5');
    expect(task?.status).toBe('enqueue-failed');
    expect(task?.draft.firstMessage).toBe('hello world');
    expect(remoteSessionStore.getInputProjection('s5').pendingQueue).toHaveLength(0);
    // 会话已建成:同步不再被挡(会话页可正常拉权威数据)。
    expect(shouldBlockSessionSync('s5')).toBe(false);
    // 禁发标同步清除:用户要用 composer 重发回填草稿,不能被 pendingLocalCreation
    // 卡到 load 成功才解禁(codex P2)。
    expect(remoteSessionStore.getSessions().find((s) => s.id === 's5')?.pendingLocalCreation).toBe(false);
    expect(remoteSessionStore.getSessions().find((s) => s.id === 's5')?.title).toBe('New Maker');
  });

  it('enqueue 回执丢失但队列里已有该 clientId → 按成功收敛,不打扰用户', async () => {
    const maker = makeMaker();
    maker.input.enqueue.mockImplementation(async () => {
      throw new Error('INVOKE_TIMEOUT');
    });
    startNewSessionCreation(makeParams('s6', maker));
    const clientId = getNewSessionCreationTask('s6')?.firstMessageClientId;
    maker.input.getProjection.mockImplementation(async () => ({
      sessionId: 's6',
      pendingQueue: [{ clientId, text: 'hello world' }],
    }));
    await flushPipeline();
    expect(getNewSessionCreationTask('s6')).toBeNull();
  });

  it('enqueue 回执丢失、消息瞬间进 activeTurn(首查两路皆空)→ 轮询等到消息落库,不误判 enqueue-failed(codex P1)', async () => {
    const maker = makeMaker();
    maker.input.enqueue.mockImplementation(async () => {
      throw new Error('INVOKE_TIMEOUT');
    });
    // 首轮分辨:队列空 + 消息列表空(drain 窗口);第二轮起消息 row 已落库回流。
    let listCalls = 0;
    startNewSessionCreation(makeParams('s7', maker));
    const clientId = getNewSessionCreationTask('s7')?.firstMessageClientId;
    maker.listMessages.mockImplementation(async () => {
      listCalls += 1;
      return listCalls >= 2 ? [{ clientId }] : [];
    });
    await flushPipeline();
    // 第一轮 false 不足以判死(需连续两次确认),第二轮观测到已应用 → 成功收敛。
    expect(getNewSessionCreationTask('s7')).toBeNull();
    expect(remoteSessionStore.getInputProjection('s7')).toBeDefined();
  });

  it('dismiss removeSyntheticRow:合成行从列表隐藏、气泡清空(返回编辑路径)', () => {
    const maker = makeMaker({
      createSession: vi.fn(() => new Promise(() => undefined)),
    });
    startNewSessionCreation(makeParams('s1', maker));
    dismissNewSessionCreation('s1', { removeSyntheticRow: true });
    expect(getNewSessionCreationTask('s1')).toBeNull();
    // store 对 status:'deleted' 的 patch 是直接把行移出 shard(首页不再可见)。
    expect(remoteSessionStore.getSessions().find((s) => s.id === 's1')).toBeUndefined();
    expect(remoteSessionStore.getInputProjection('s1').pendingQueue).toHaveLength(0);
  });

  it('create-failed 返回编辑前回收预创建 worktree，并把原项目目录放回草稿', async () => {
    const maker = makeMaker({
      createSession: vi.fn(async () => {
        throw new Error('INVALID_PARAMS: cannot create session');
      }),
    });
    const params = makeParams('s13', maker, {
      draft: {
        ...DRAFT,
        workingDir: '/repo/.cindy-worktrees/auto-one',
      },
      precreatedWorktree: {
        path: '/repo/.cindy-worktrees/auto-one',
        recoveryKey: 'recovery-key-1234567890',
        originalWorkingDir: '/repo',
      },
    });
    startNewSessionCreation(params);
    await flushPipeline();

    const failed = getNewSessionCreationTask('s13');
    expect(failed?.status).toBe('create-failed');

    const prepared = await prepareNewSessionCreationForEdit('s13');
    expect(prepared).not.toBeNull();
    expect(params.transport.openLink).toHaveBeenCalledWith('dev-1');
    expect(maker.worktree.discardPrecreated).toHaveBeenCalledWith({
      sessionId: 's13',
      recoveryKey: 'recovery-key-1234567890',
    });

    stashNewSessionDraftForEdit(prepared!);
    expect(drainStashedNewSessionDraft()?.draft.workingDir).toBe('/repo');
  });

  it('带回创建期间后续消息时仍恢复预创建 worktree 的原项目目录', async () => {
    const task = {
      ...makeParams('s13-override', makeMaker(), {
        draft: {
          ...DRAFT,
          workingDir: '/repo/.cindy-worktrees/auto-override',
        },
        precreatedWorktree: {
          path: '/repo/.cindy-worktrees/auto-override',
          recoveryKey: 'recovery-key-override-123456',
          originalWorkingDir: '/repo',
        },
      }),
      status: 'create-failed' as const,
      startedAt: 0,
      phase: 'creating' as const,
      error: 'create failed',
      firstMessageClientId: 'client-override',
    };

    stashNewSessionDraftForEdit(task, {
      draft: {
        ...task.draft,
        firstMessage: 'hello world\n\nfollow up',
      },
    });

    expect(drainStashedNewSessionDraft()?.draft).toMatchObject({
      workingDir: '/repo',
      firstMessage: 'hello world\n\nfollow up',
    });
  });

  it('create-failed cleanup preserves the task when the new channel fails', async () => {
    const maker = makeMaker({
      createSession: vi.fn(async () => {
        throw new Error('INVALID_PARAMS: cannot create session');
      }),
      worktree: {
        discardPrecreated: vi.fn(async () => {
          throw Object.assign(new Error('registered path mismatch'), {
            code: 'PERMISSION_DENIED',
          });
        }),
      },
    });
    startNewSessionCreation(makeParams('s14', maker, {
      draft: {
        ...DRAFT,
        workingDir: '/repo/.cindy-worktrees/auto-two',
      },
      precreatedWorktree: {
        path: '/repo/.cindy-worktrees/auto-two',
        recoveryKey: 'recovery-key-1234567890',
        originalWorkingDir: '/repo',
      },
    }));
    await flushPipeline();

    await expect(
      prepareNewSessionCreationForEdit('s14'),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(getNewSessionCreationTask('s14')?.status).toBe('create-failed');
  });

  it('old desktop without discard-precreated keeps the cleanup obligation fail-closed', async () => {
    const maker = makeMaker({
      createSession: vi.fn(async () => {
        throw new Error('INVALID_PARAMS: cannot create session');
      }),
      worktree: {
        discardPrecreated: vi.fn(async () => {
          throw Object.assign(new Error('channel not allowed remotely'), {
            code: 'CHANNEL_NOT_ALLOWED',
          });
        }),
      },
    });
    startNewSessionCreation(makeParams('s15', maker, {
      draft: {
        ...DRAFT,
        workingDir: '/repo/.cindy-worktrees/auto-three',
      },
      precreatedWorktree: {
        path: '/repo/.cindy-worktrees/auto-three',
        recoveryKey: 'recovery-key-1234567890',
        originalWorkingDir: '/repo',
      },
    }));
    await flushPipeline();

    await expect(
      prepareNewSessionCreationForEdit('s15'),
    ).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED' });
    expect(maker.worktree.discardPrecreated).toHaveBeenCalledTimes(1);
    expect(getNewSessionCreationTask('s15')?.status).toBe('create-failed');
  });

  it('回收发现会话已认领时重新对账真实会话，不把用户困在 create-failed', async () => {
    const worktreePath = '/repo/.cindy-worktrees/auto-four';
    const claimedSession = sessionFromCreateResult(
      { sessionId: 's16', workDir: worktreePath },
      DRAFT,
    );
    const maker = makeMaker({
      createSession: vi.fn(async () => {
        throw new Error('INVALID_PARAMS: create response lost');
      }),
      getSession: vi.fn(async () => claimedSession),
      worktree: {
        discardPrecreated: vi.fn(async () => {
          throw Object.assign(new Error('session already owns worktree'), {
            code: 'PRECONDITION_FAILED',
          });
        }),
      },
    });
    startNewSessionCreation(makeParams('s16', maker, {
      draft: { ...DRAFT, workingDir: worktreePath },
      precreatedWorktree: {
        path: worktreePath,
        recoveryKey: 'recovery-key-1234567890',
        originalWorkingDir: '/repo',
      },
    }));
    await flushPipeline();
    expect(getNewSessionCreationTask('s16')?.status).toBe('create-failed');

    await expect(prepareNewSessionCreationForEdit('s16')).resolves.toBeNull();
    expect(getNewSessionCreationTask('s16')?.status).toBe('enqueue-failed');
    expect(remoteSessionStore.getSessions().find((s) => s.id === 's16')).toMatchObject({
      id: 's16',
      workingDir: worktreePath,
      pendingLocalCreation: false,
    });
    expect(remoteSessionStore.getInputProjection('s16').pendingQueue).toHaveLength(0);
  });

  it('managed create 的 wrong-id + malformed ownership probe 持久进入 retain-only，禁止重试或返回编辑删除', async () => {
    const createdAt = Date.now();
    const precreated = {
      sessionId: 's18',
      deviceId: 'dev-1',
      path: '/repo/.cindy-worktrees/auto-unsafe',
      recoveryKey: 'recovery-key-unsafe-123456',
      createdAt,
      phase: 'precreated' as const,
    };
    await registerPendingPrecreatedWorktree('owner-a', precreated);
    const maker = makeMaker({
      createSession: vi.fn(async () => ({ sessionId: 'wrong-session-id' })),
      getSession: vi.fn(async () => null),
    });
    startNewSessionCreation(makeParams('s18', maker, {
      draft: { ...DRAFT, workingDir: precreated.path },
      precreatedWorktree: {
        path: precreated.path,
        recoveryKey: precreated.recoveryKey,
        originalWorkingDir: '/repo',
        createdAt,
      },
      precreatedWorktreeAccountId: 'owner-a',
    }));
    await flushPipeline();

    expect(getNewSessionCreationTask('s18')).toMatchObject({
      status: 'create-failed',
    });
    expect(maker.createSession).toHaveBeenCalledTimes(1);
    expect(maker.input.enqueue).not.toHaveBeenCalled();
    retryNewSessionCreation('s18');
    await flushPipeline();
    expect(maker.createSession).toHaveBeenCalledTimes(1);
    await expect(prepareNewSessionCreationForEdit('s18')).rejects.toThrow(
      'worktree',
    );
    expect(maker.worktree.discardPrecreated).not.toHaveBeenCalled();
    await expect(listPendingPrecreatedWorktrees('owner-a')).resolves.toEqual([{
      ...precreated,
      phase: 'session-create-started',
    }]);
  });

  it('returns the original draft after an uncertain create is cancelled by the host', async () => {
    const record = { sessionId: 'cancel-me', deviceId: 'dev-1', path: '/repo/.cindy-worktrees/orphan', recoveryKey: 'recovery-cancel-key', createdAt: Date.now(), phase: 'precreated' as const };
    await registerPendingPrecreatedWorktree('owner-a', record);
    const maker = makeMaker({
      createSession: vi.fn(async () => { throw new Error('INVOKE_TIMEOUT'); }),
      worktree: { discardPrecreated: vi.fn(), cancelPrecreated: vi.fn(async () => ({ discarded: true })) },
    });
    startNewSessionCreation(makeParams(record.sessionId, maker, {
      draft: { ...DRAFT, workingDir: record.path },
      precreatedWorktree: { path: record.path, recoveryKey: record.recoveryKey, originalWorkingDir: '/repo', createdAt: record.createdAt },
      precreatedWorktreeAccountId: 'owner-a',
    }));
    await flushPipeline();
    const task = await prepareNewSessionCreationForEdit(record.sessionId);
    expect(task?.draft.firstMessage).toBe(DRAFT.firstMessage);
    expect(task?.precreatedWorktree?.originalWorkingDir).toBe('/repo');
    expect(maker.worktree.cancelPrecreated).toHaveBeenCalledWith({ sessionId: record.sessionId, recoveryKey: record.recoveryKey });
    expect(maker.worktree.discardPrecreated).not.toHaveBeenCalled();
    expect(persistCancelledDraft).toHaveBeenCalledWith({ sessionId: record.sessionId, deviceId: record.deviceId, originalWorkingDir: '/repo' });
    expect(await listPendingPrecreatedWorktrees('owner-a')).toEqual([]);
  });

  it('retry reconciles a late exact-id success without another create', async () => {
    const maker = makeMaker({ createSession: vi.fn(async () => { throw new Error('INVOKE_TIMEOUT'); }) });
    startNewSessionCreation(makeParams('late-success', maker, {
      precreatedWorktree: { path: '/repo/worktree', recoveryKey: 'late-recovery-key', originalWorkingDir: '/repo' },
      precreatedWorktreeAccountId: 'owner-a',
    }));
    await flushPipeline();
    expect(getNewSessionCreationTask('late-success')?.status).toBe('create-failed');
    maker.getSession.mockResolvedValue(sessionFromCreateResult({ sessionId: 'late-success', workDir: '/repo/worktree' }, DRAFT));
    retryNewSessionCreation('late-success');
    await flushPipeline();
    expect(maker.createSession).toHaveBeenCalledTimes(1);
    expect(maker.input.enqueue).toHaveBeenCalledTimes(1);
    expect(getNewSessionCreationTask('late-success')).toBeNull();
  });

  it('keeps the edit recovery obligation when persisting the cancelled draft fails', async () => {
    const record = { sessionId: 'cancel-save-fails', deviceId: 'dev-1', path: '/repo/.cindy-worktrees/orphan',
      recoveryKey: 'recovery-cancel-save-key', createdAt: Date.now(), phase: 'precreated' as const };
    await registerPendingPrecreatedWorktree('owner-a', record);
    const maker = makeMaker({ createSession: vi.fn(async () => { throw new Error('INVOKE_TIMEOUT'); }),
      worktree: { discardPrecreated: vi.fn(), cancelPrecreated: vi.fn(async () => ({ discarded: true })) } });
    startNewSessionCreation(makeParams(record.sessionId, maker, {
      draft: { ...DRAFT, workingDir: record.path }, precreatedWorktreeAccountId: 'owner-a',
      precreatedWorktree: { path: record.path, recoveryKey: record.recoveryKey, originalWorkingDir: '/repo', createdAt: record.createdAt },
    }));
    await flushPipeline();
    persistCancelledDraft.mockRejectedValueOnce(new Error('disk full'));
    await expect(prepareNewSessionCreationForEdit(record.sessionId)).rejects.toThrow('disk full');
    expect(await listPendingPrecreatedWorktrees('owner-a')).toHaveLength(1);
    expect(getNewSessionCreationTask(record.sessionId)?.status).toBe('create-failed');
    await prepareNewSessionCreationForEdit(record.sessionId);
    expect(await listPendingPrecreatedWorktrees('owner-a')).toEqual([]);
    dismissNewSessionCreation(record.sessionId);
  });

  it.each([true, false, undefined])('removes the host-confirmed cancelled row on the matching device (pendingLocalCreation=%s)', (pendingLocalCreation) => {
    const row = { ...sessionFromCreateResult({ sessionId: 'orphan' }, DRAFT), pendingLocalCreation };
    remoteSessionStore.upsertDeviceSession('dev-1', 'PC', row);
    dismissRecoveredPrecreatedSession({ sessionId: 'orphan', deviceId: 'other-device' });
    expect(remoteSessionStore.getSessions()).toHaveLength(1);
    dismissRecoveredPrecreatedSession({ sessionId: 'orphan', deviceId: 'dev-1' });
    expect(remoteSessionStore.getSessions()).toHaveLength(0);
  });

  it('does not dismiss a row still owned by a live creation pipeline', async () => {
    const maker = makeMaker({ createSession: vi.fn(async () => { throw new Error('failed startup'); }) });
    startNewSessionCreation(makeParams('s1', maker));
    dismissRecoveredPrecreatedSession({ sessionId: 's1', deviceId: 'dev-1' });
    expect(remoteSessionStore.getSessions().find((row) => row.id === 's1')).toBeDefined();
    expect(getNewSessionCreationTask('s1')).not.toBeNull();
    await flushPipeline();
    dismissNewSessionCreation('s1');
  });

  it('releases hidden accepted message windows and resumes handoff on reentry', () => {
    const accepted = { ...recoveryOutboxRecord('accepted'), state: 'host-owned' as const, retrySafe: true };
    const sending = recoveryOutboxRecord('sending');
    const bridge = outboxLeaseHarness([accepted, sending]);
    bridge.refresh();
    expect(bridge.leases.size).toBe(1);
    bridge.visible.add('accepted');
    bridge.refresh();
    expect(bridge.leases.size).toBe(2);
    const release = vi.spyOn(bridge.leases.get(JSON.stringify(['dev-1', 'accepted']))!, 'release');
    bridge.visible.clear();
    bridge.refresh();
    expect(release).toHaveBeenCalledOnce();
    // An explicit cancel still needs remote reconciliation while the task is hidden.
    bridge.setRecords([{ ...accepted, cancelRequested: true }]);
    bridge.refresh();
    expect(bridge.leases.has(JSON.stringify(['dev-1', 'accepted']))).toBe(true);
    bridge.setRecords([]); bridge.refresh();
  });

  it('removes a cold-hydrated cancelled row and releases only its lease without resurrecting it', () => {
    const orphan = recoveryOutboxRecord('cold-orphan');
    const other = recoveryOutboxRecord('other-draft');
    const bridge = outboxLeaseHarness([orphan, other]);
    bridge.refresh();
    expect(remoteSessionStore.getSessions().find((row) => row.id === 'cold-orphan')?.pendingLocalCreation).toBeUndefined();
    expect(bridge.leases.size).toBe(2);
    const releaseOrphan = vi.spyOn(bridge.leases.get(JSON.stringify(['dev-1', 'cold-orphan']))!, 'release');
    const releaseOther = vi.spyOn(bridge.leases.get(JSON.stringify(['dev-1', 'other-draft']))!, 'release');
    const cancelled = { ...orphan, suspended: true, creation: { ...orphan.creation!, cancelled: true as const } };
    bridge.setRecords([cancelled, other]);
    bridge.refresh();
    expect(remoteSessionStore.getSessions().map((row) => row.id)).toEqual(['other-draft']);
    expect(releaseOrphan).toHaveBeenCalledOnce();
    expect(releaseOther).not.toHaveBeenCalled();
    bridge.refresh();
    expect(remoteSessionStore.getSessions().map((row) => row.id)).toEqual(['other-draft']);
    expect(cancelled.item.text).toBe(DRAFT.firstMessage);
    expect(cancelled.creation.cancelled).toBe(true);
    bridge.setRecords([]);
    bridge.refresh();
  });

  it('does not materialize an already cancelled draft on cold startup', () => {
    const orphan = recoveryOutboxRecord('cancelled-before-restart');
    const bridge = outboxLeaseHarness([{ ...orphan, creation: { ...orphan.creation!, cancelled: true } }]);
    bridge.refresh();
    bridge.refresh();
    expect(remoteSessionStore.getSessions()).toEqual([]);
    expect(bridge.leases.size).toBe(0);
  });

  it.each([
    ['null', null],
    ['empty object', {}],
    ['wrong id', { id: 'another-session' }],
  ])('managed create 丢 ACK 后 probe %s 仍 retain-only，不重建、不入队、不回收', async (_label, probeResult) => {
    const createdAt = Date.now();
    const precreated = {
      sessionId: 's20',
      deviceId: 'dev-1',
      path: '/repo/.cindy-worktrees/auto-unknown',
      recoveryKey: 'recovery-key-unknown-123456',
      createdAt,
      phase: 'precreated' as const,
    };
    await registerPendingPrecreatedWorktree('owner-a', precreated);
    const maker = makeMaker({
      createSession: vi.fn(async () => {
        throw new Error('INVOKE_TIMEOUT');
      }),
      getSession: vi.fn(async () => probeResult),
    });
    startNewSessionCreation(makeParams('s20', maker, {
      draft: { ...DRAFT, workingDir: precreated.path },
      precreatedWorktree: {
        path: precreated.path,
        recoveryKey: precreated.recoveryKey,
        originalWorkingDir: '/repo',
        createdAt,
      },
      precreatedWorktreeAccountId: 'owner-a',
    }));
    await flushPipeline();

    expect(getNewSessionCreationTask('s20')?.status).toBe('create-failed');
    expect(maker.createSession).toHaveBeenCalledTimes(1);
    expect(maker.getSession).toHaveBeenCalledTimes(1);
    expect(maker.input.enqueue).not.toHaveBeenCalled();
    retryNewSessionCreation('s20');
    await flushPipeline();
    expect(maker.createSession).toHaveBeenCalledTimes(1);
    expect(maker.getSession).toHaveBeenCalledTimes(2);
    await expect(prepareNewSessionCreationForEdit('s20')).rejects.toThrow('worktree');
    expect(maker.worktree.discardPrecreated).not.toHaveBeenCalled();
    await expect(listPendingPrecreatedWorktrees('owner-a')).resolves.toEqual([{
      ...precreated,
      phase: 'session-create-started',
    }]);
  });

  it.each([
    ['null', null],
    ['empty object', {}],
    ['negative ACK', { discarded: false }],
    ['invalid branchDeleted', { discarded: true, branchDeleted: 'yes' }],
  ])('返回编辑只接受完整 discard ACK：%s 回包保留 task 与账本', async (_label, discardAck) => {
    const createdAt = Date.now();
    const maker = makeMaker({
      worktree: {
        discardPrecreated: vi.fn(async () => discardAck),
      },
    });
    startNewSessionCreation(makeParams('s19', maker, {
      draft: { ...DRAFT, workingDir: '/repo/.cindy-worktrees/auto-ack' },
      precreatedWorktree: {
        path: '/repo/.cindy-worktrees/auto-ack',
        recoveryKey: 'recovery-key-ack-123456',
        originalWorkingDir: '/repo',
        createdAt,
      },
      precreatedWorktreeAccountId: 'owner-a',
      confirmUnauthenticated: async () => ({ unauthenticated: true, fresh: null }),
    }));
    await flushPipeline();
    await expect(prepareNewSessionCreationForEdit('s19')).rejects.toThrow();
    expect(getNewSessionCreationTask('s19')?.status).toBe('create-failed');
    expect(maker.worktree.discardPrecreated).toHaveBeenCalledWith({
      sessionId: 's19',
      recoveryKey: 'recovery-key-ack-123456',
    });
  });

  it('账号在 create retry 等待期间切换时停止旧任务并保留旧账号 recovery ledger', async () => {
    const record = {
      sessionId: 's17',
      deviceId: 'dev-1',
      path: '/repo/.cindy-worktrees/auto-owner-a',
      recoveryKey: 'recovery-key-owner-a-123456',
      createdAt: Date.now(),
      phase: 'precreated' as const,
    };
    await expect(
      registerPendingPrecreatedWorktree('owner-a', record),
    ).resolves.toBe(true);

    let currentOwner = 'owner-a';
    const maker = makeMaker({
      createSession: vi.fn(async () => {
        throw new Error('INVOKE_TIMEOUT');
      }),
      getSession: vi.fn(async () => {
        currentOwner = 'owner-b';
        throw new Error('NOT_FOUND');
      }),
    });

    startNewSessionCreation(makeParams('s17', maker, {
      draft: { ...DRAFT, workingDir: record.path },
      precreatedWorktree: {
        path: record.path,
        recoveryKey: record.recoveryKey,
        originalWorkingDir: '/repo',
        createdAt: record.createdAt,
      },
      precreatedWorktreeAccountId: 'owner-a',
      isCurrentOwner: () => currentOwner === 'owner-a',
    }));
    await flushPipeline();

    expect(maker.createSession).toHaveBeenCalledTimes(1);
    expect(maker.getSession).toHaveBeenCalledTimes(1);
    expect(maker.input.enqueue).not.toHaveBeenCalled();
    expect(getNewSessionCreationTask('s17')).toBeNull();
    expect(remoteSessionStore.getSessions().find((session) => session.id === 's17')).toBeUndefined();
    await expect(listPendingPrecreatedWorktrees('owner-a')).resolves.toEqual([{
      ...record,
      phase: 'session-create-started',
    }]);
  });
  it('hands the persisted first message to the outbox without issuing a competing enqueue', async () => {
    const maker = makeMaker();
    const params = makeParams('durable-first', maker, { firstMessageClientId: 'persisted-first-id', planModeArm: true });
    const handoff = vi.fn(async () => undefined);
    params.transport.handoffFirstMessage = handoff;
    startNewSessionCreation(params);
    await flushPipeline();
    expect(handoff).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'persisted-first-id', text: DRAFT.firstMessage }));
    expect(maker.input.enqueue).not.toHaveBeenCalled();
    expect(maker.setPlanMode).not.toHaveBeenCalled();
    expect(getNewSessionCreationTask('durable-first')).toBeNull();
    expect(remoteSessionStore.getSessions().find((session) => session.id === 'durable-first')?.pendingLocalCreation).toBe(false);
  });
  it('keeps the creation task recoverable when saving the first-message handoff fails', async () => {
    const maker = makeMaker(); const params = makeParams('durable-first-failed', maker, { firstMessageClientId: 'saved-id' });
    params.transport.handoffFirstMessage = async () => { throw new Error('disk full'); };
    startNewSessionCreation(params); await flushPipeline();
    expect(maker.input.enqueue).not.toHaveBeenCalled();
    expect(getNewSessionCreationTask('durable-first-failed')).toMatchObject({ status: 'enqueue-failed', firstMessageClientId: 'saved-id' });
  });

  describe('collaboration on create', () => {
    const orcaEnable = { workerAgent: 'codex' as const, role: 'developer', label: 'developer', workerPermissionMode: 'auto' as const };
    function withOrca(maker: MakerMock, enable: ReturnType<typeof vi.fn>) {
      return Object.assign(maker, {
        getCapabilities: vi.fn(async () => ({ supportsOrcaWorkerPermissionMode: true })),
        orca: { enable, listWorkers: vi.fn(async () => []) },
      });
    }

    it('brings the collaboration draft back with the draft when a failed create returns to editing', async () => {
      const maker = withOrca(makeMaker({
        createSession: vi.fn(async () => { throw new Error('INVALID_PARAMS: cannot create session'); }),
      }), vi.fn());
      const collabDraft = {
        role: 'reviewer', agent: 'codex' as const, model: null, permissionMode: 'auto' as const, initialTask: 'check tests',
      };
      startNewSessionCreation(makeParams('orca-edit', maker, { orcaEnable, collabDraft }));
      await flushPipeline();
      expect(getNewSessionCreationTask('orca-edit')?.status).toBe('create-failed');
      const prepared = await prepareNewSessionCreationForEdit('orca-edit');
      stashNewSessionDraftForEdit(prepared!);
      expect(drainStashedNewSessionDraft()?.collabDraft).toEqual(collabDraft);
    });

    it('starts collaboration after createSession and before the first message is queued', async () => {
      const enable = vi.fn(async () => ({ workerSessionId: 'worker-1' }));
      const maker = withOrca(makeMaker(), enable);
      startNewSessionCreation(makeParams('orca-ok', maker, { orcaEnable }));
      await flushPipeline();
      expect(enable).toHaveBeenCalledWith('orca-ok', orcaEnable);
      expect(enable.mock.invocationCallOrder[0]).toBeGreaterThan(maker.createSession.mock.invocationCallOrder[0]!);
      expect(enable.mock.invocationCallOrder[0]).toBeLessThan(maker.input.enqueue.mock.invocationCallOrder[0]!);
      expect(remoteSessionStore.getSessions().find((session) => session.id === 'orca-ok')?.orcaRole).toBe('lead');
      expect(takeOrcaStartFailure('orca-ok')).toBeNull();
    });

    it('continues as a single task and hands the reason to the session page when collaboration fails', async () => {
      const enable = vi.fn(async () => { throw new Error('[PRECONDITION_FAILED] disabled'); });
      const maker = withOrca(makeMaker(), enable);
      startNewSessionCreation(makeParams('orca-fail', maker, { orcaEnable }));
      await flushPipeline();
      expect(maker.input.enqueue).toHaveBeenCalledTimes(1);
      expect(getNewSessionCreationTask('orca-fail')).toBeNull();
      expect(takeOrcaStartFailure('orca-fail')).toBeTruthy();
    });

    it('does not start collaboration twice when the authoritative row is already a Lead', async () => {
      const enable = vi.fn(async () => ({}));
      const maker = withOrca(makeMaker({
        getSession: vi.fn(async () => ({ ...sessionFromCreateResult({ sessionId: 'orca-lead' }, DRAFT), orcaRole: 'lead' })),
      }), enable);
      startNewSessionCreation(makeParams('orca-lead', maker, { orcaEnable }));
      await flushPipeline();
      expect(enable).not.toHaveBeenCalled();
      expect(maker.input.enqueue).toHaveBeenCalledTimes(1);
    });
  });
});
