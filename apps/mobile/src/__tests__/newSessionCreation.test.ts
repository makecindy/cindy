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
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';

// expo-crypto 是原生模块(createUuid 的 CSPRNG 兜底;node 环境有 crypto.randomUUID
// 不会走到),node 下 import 副作用不可控,mock 掉。
vi.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => new Uint8Array(n).fill(7),
}));
import {
  dismissNewSessionCreation,
  getNewSessionCreationTask,
  retryNewSessionCreation,
  shouldBlockSessionSync,
  startNewSessionCreation,
  type NewSessionCreationParams,
} from '@/session/newSessionCreation';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { sessionFromCreateResult, type NewSessionDraft } from '@/session/newSession';

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

interface MakerMock {
  createSession: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  listMessages: ReturnType<typeof vi.fn>;
  setPlanMode: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
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
    confirmUnauthenticated: () => Promise.resolve(false),
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
  beforeEach(() => {
    remoteSessionStore.clear();
    // 清残留 task(上个用例失败态)。
    for (const id of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 's12']) dismissNewSessionCreation(id);
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
});
