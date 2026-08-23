/**
 * session-runner.test.ts
 * ---------------------------------------------------------------------------
 * hook 会话的 userSendAt 落库时序回归(Slack DM / 频道 @ 共用同一条路径)。
 *
 * 根因(与 IM 修复 53b999601 同型): 新建 hook 会话广播 sessions:created 触发
 * renderer 全量重拉, 那一刻 user 消息还没落库(send 被接受后才写), 若 userSendAt
 * 也为 null, projectGrouping 草稿规则会把会话误判进「未分类」, 且之后没有事件
 * 再触发重归组 —— 会话永远不出现在工作目录分组下。
 *
 * 断言两条不变量:
 *   1. isNew 路径: touchUserSendInDb 必须发生在 sessions:created 广播**之前**
 *      (广播后 renderer 重拉必须能读到非空 userSendAt);
 *   2. 每次 send 被接受(onAccepted)都要 bump userSendAt(复用/接管会话的排序
 *      时间轴与桌面端 sendMessage 口径一致)。
 *
 * mock 方式对齐 touchUserSendBroadcast.test.ts: 捕获数组放 vi.hoisted, 记录
 * 跨模块调用顺序。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent, Effort, PermissionMode, PermissionModeState } from '@cindy/maker-core';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';

const h = vi.hoisted(() => {
  /** 跨模块调用顺序记录: 'touch:<id>' / 'created:<id>' */
  const calls: string[] = [];
  return {
    calls,
    touchUserSendInDb: vi.fn(async (id: string) => {
      calls.push(`touch:${id}`);
    }),
    tapWindowBroadcast: vi.fn((channel: string, payload: { sessionId?: string }) => {
      if (channel === 'local-db:sessions:created') {
        calls.push(`created:${payload.sessionId}`);
      }
    }),
    createMessage: vi.fn(async () => {
      calls.push('createMessage');
    }),
    listMessagesForAgentHandoff: vi.fn(async () => [] as Array<{
      clientId: string;
      role: string;
      content: unknown;
      createdAt: number;
      agentMeta: Record<string, unknown> | null;
    }>),
    beginTurnChangeSetAtDispatch: vi.fn(async (session: { id: string }, anchorClientId: string) => {
      calls.push(`beginChangeSet:${session.id}:${anchorClientId}`);
    }),
    clearPendingTurnChangeSets: vi.fn(),
    setSessionProviderIdInDb: vi.fn(async (id: string, providerId: string) => {
      calls.push(`providerDb:${id}:${providerId}`);
    }),
    setSessionSourceInDb: vi.fn(async (id: string, source: string) => {
      calls.push(`sourceDb:${id}:${source}`);
    }),
    setSessionProvider: vi.fn(),
    hydrateSessionProvider: vi.fn(),
    peekPendingHandoff: vi.fn(async () => null as string | null),
    consumePendingHandoff: vi.fn(),
    listProviders: vi.fn(async (): Promise<unknown[]> => []),
    getModelVisibilityOverride: vi.fn(() => undefined),
    readImDefaultSettings: vi.fn(),
    useActualDefaults: false,
    /** 每个 fake session 的事件监听回调(emit done 用)。 */
    statusCbs: new Map<string, (status: 'active' | 'aborting' | 'closed' | 'error') => void>(),
    eventCbs: new Map<string, (ev: AgentEvent) => void>(),
    /** 每个 fake session 被装上的 interaction listener(交互测试驱动用)。 */
    interactionListeners: new Map<string, (req: unknown) => Promise<unknown>>(),
    headlessDuringSend: [] as boolean[],
    headlessAfterAccepted: [] as boolean[],
    installDesktopInteractionListener: vi.fn(),
    withRehydrateCloseSuppressed: vi.fn(async (_sessionId: string, fn: () => Promise<unknown>) =>
      fn(),
    ),
    /** mocked resolveHookSessionConfig 的返回值(测试内可改写)。 */
    resolvedConfig: {
      agentKind: 'claude-code' as const,
      model: 'test-model',
      effort: undefined as Effort | undefined,
      permissionMode: 'bypassPermissions',
      providerId: null as string | null,
    },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
// 事件终止性判定与过载判定用**真实实现**: runner 现在按 isTerminal / willRetry
// 区分"正在自动重试"与"真失败", 过载文案也直接复用 maker-core 的判定 —— 在这里
// 复制一份桩会让两侧漂移时测试仍然全绿(旧桩把所有 error 都当终止, 恰好会掩盖
// 非终止 error 的处理)。maker-core 零 Electron 依赖, 可直接加载。
vi.mock('@cindy/maker-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/maker-core')>();
  return {
    isAutoReviewUnavailableNotice: actual.isAutoReviewUnavailableNotice,
    isAutoReviewConfirmUndeliveredNotice: actual.isAutoReviewConfirmUndeliveredNotice,
    isTerminalAgentErrorEvent: actual.isTerminalAgentErrorEvent,
    MAIN_OWNED_SEND_CONTEXT: actual.MAIN_OWNED_SEND_CONTEXT,
    parseOverloadError: actual.parseOverloadError,
    parseOverloadRetryProgress: actual.parseOverloadRetryProgress,
    parseTerminalRateLimitRetryProgress: actual.parseTerminalRateLimitRetryProgress,
  };
});
vi.mock('../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: h.tapWindowBroadcast,
}));
vi.mock('../../maker-ipc/register.js', () => ({
  beginTurnChangeSetAtDispatch: h.beginTurnChangeSetAtDispatch,
  prepareUnhealthySessionForSend: vi.fn(async () => undefined),
  wireSessionToIpc: vi.fn(),
  isSessionInTurn: () => false,
  installDesktopInteractionListener: h.installDesktopInteractionListener,
  noteSilentStopUserSend: vi.fn(),
  onSilentStopSettled: vi.fn(() => () => {}),
}));
vi.mock('../../turn-change-set/store.js', () => ({
  clearPendingTurnChangeSets: h.clearPendingTurnChangeSets,
}));
vi.mock('../../maker-host/send-outcome.js', () => ({
  toDesktopSessionDispatchOutcome: () => ({ dispatched: true as const }),
}));
vi.mock('../../messagePersistBroadcaster.js', () => ({
  enqueueDurableWrite: vi.fn(async (_label: string, fn: () => unknown) => fn()),
}));
vi.mock('../../localDb/ipc/messages.js', () => ({
  createMessage: h.createMessage,
  listMessagesForAgentHandoff: h.listMessagesForAgentHandoff,
}));
vi.mock('../../localDb/ipc/sessions.js', () => ({
  getSessionRowSnapshot: vi.fn(async () => null),
  getSessionRowSnapshotStrict: vi.fn(async () => null),
  setSessionProviderIdInDb: h.setSessionProviderIdInDb,
  setSessionSourceInDb: h.setSessionSourceInDb,
  setWorktreePathInDb: vi.fn(async () => undefined),
  touchUserSendInDb: h.touchUserSendInDb,
}));
vi.mock('../../maker-host/session-provider-store.js', () => ({
  setSessionProvider: h.setSessionProvider,
  hydrateSessionProvider: h.hydrateSessionProvider,
}));
vi.mock('../../maker-ipc/agentHandoffPendingSingleton.js', () => ({
  agentHandoffPending: {
    peek: h.peekPendingHandoff,
    consume: h.consumePendingHandoff,
  },
}));
vi.mock('../../imageCacheStore.js', () => ({
  resolveSafe: vi.fn(),
}));
// cindy-media:入站图片写入媒体总仓,mock 记调用。
const cindyMock = vi.hoisted(() => ({
  ingestMedia: vi.fn(async ({ mimeType }: { mimeType: string }) => {
    const ext = mimeType === 'video/mp4' ? '.mp4' : mimeType === 'audio/ogg' ? '.ogg' : '.png';
    return {
      hash: 'a'.repeat(64),
      ext,
      mimeType,
      bytes: 8,
      url: `cindy-media://blobs/${'a'.repeat(64)}${ext}`,
      deduplicated: false,
      refIds: ['ref-1'],
    };
  }),
  supportedMime: vi.fn((mimeType: string) =>
    ['image/png', 'image/jpeg', 'video/mp4', 'audio/ogg'].includes(mimeType),
  ),
  resolveSafe: vi.fn((url: string) => ({
    absPath: `/blobs/${url.slice('cindy-media://blobs/'.length)}`,
    mimeType: 'image/png',
    hash: 'a'.repeat(64),
  })),
}));
vi.mock('../../cindy-media/ingest.js', () => ({
  ingestMedia: cindyMock.ingestMedia,
  supportedMime: cindyMock.supportedMime,
}));
vi.mock('../../cindy-media/blobStore.js', () => ({ resolveSafe: cindyMock.resolveSafe }));
vi.mock('../../worktree/index.js', () => ({
  worktreeStore: { get: () => undefined },
  WorktreeManager: { removeWorktreeForSession: vi.fn(async () => undefined) },
}));
vi.mock('../../im/defaultSettingsStore.js', () => ({
  readImDefaultSettings: h.readImDefaultSettings,
}));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders: h.listProviders }),
}));
vi.mock('../../maker-host/model-visibility-mirror.js', () => ({
  getModelVisibilityOverride: h.getModelVisibilityOverride,
}));
vi.mock('../defaults.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../defaults.js')>();
  return {
    ...actual,
    resolveHookSessionConfig: (
      ...args: Parameters<typeof actual.resolveHookSessionConfig>
    ): ReturnType<typeof actual.resolveHookSessionConfig> =>
      h.useActualDefaults ? actual.resolveHookSessionConfig(...args) : { ...h.resolvedConfig },
  };
});

function makePermissionModeFake() {
  let permissionModeState: PermissionModeState = {
    mode: 'bypassPermissions',
    generation: 0,
  };
  const setPermissionMode = vi.fn(async (mode: PermissionMode) => {
    void mode;
  });
  const setPermissionModeTracked = vi.fn(async (mode: PermissionMode) => {
    await setPermissionMode(mode);
    permissionModeState = { mode, generation: permissionModeState.generation + 1 };
    return { ...permissionModeState };
  });
  const setPermissionModeIfUnchanged = vi.fn(
    async (expected: PermissionModeState, mode: PermissionMode) => {
      if (
        permissionModeState.mode !== expected.mode ||
        permissionModeState.generation !== expected.generation
      ) {
        return false;
      }
      await setPermissionMode(mode);
      permissionModeState = { mode, generation: permissionModeState.generation + 1 };
      return true;
    },
  );
  const acquireTurnLease = vi.fn(() => vi.fn());
  return {
    get permissionModeState() {
      return { ...permissionModeState };
    },
    setPermissionMode,
    setPermissionModeTracked,
    setPermissionModeIfUnchanged,
    acquireTurnLease,
  };
}

/** fake maker: createSession 返回"send 即接受、随后立刻 done"的会话。 */
function makeFakeSession(id: string) {
  const permission = makePermissionModeFake();
  return {
    id,
    workDir: 'D:/repo',
    get permissionModeState() {
      return permission.permissionModeState;
    },
    setPermissionMode: permission.setPermissionMode,
    setPermissionModeTracked: permission.setPermissionModeTracked,
    setPermissionModeIfUnchanged: permission.setPermissionModeIfUnchanged,
    acquireTurnLease: permission.acquireTurnLease,
    onEvent(cb: (ev: { type: string; data: unknown }) => void) {
      h.eventCbs.set(id, cb);
      return () => {
        h.eventCbs.delete(id);
      };
    },
    onStatusChange(cb: (status: 'active' | 'aborting' | 'closed' | 'error') => void) {
      h.statusCbs.set(id, cb);
      return () => {
        h.statusCbs.delete(id);
      };
    },
    setInteractionListener(listener: (req: unknown) => Promise<unknown>) {
      h.interactionListeners.set(id, listener);
    },
    send: vi.fn(
      async (
        _msg: unknown,
        opts: {
          afterTurnReserved?: () => Promise<void> | void;
          beforeProviderStart?: () => Promise<void> | void;
          onAccepted?: () => Promise<void>;
        },
      ): Promise<unknown> => {
        h.headlessDuringSend.push(isHeadlessGhostSetupTurn(id));
        await opts.afterTurnReserved?.();
        await opts.beforeProviderStart?.();
        await opts.onAccepted?.();
        h.headlessAfterAccepted.push(isHeadlessGhostSetupTurn(id));
        // 收口: 模拟 agent 立刻完成本 turn
        queueMicrotask(() => h.eventCbs.get(id)?.({ type: 'done', data: null }));
        return { accepted: true };
      },
    ),
  };
}

const fakeMaker = {
  createSession: vi.fn(async (opts: { id?: string }) => makeFakeSession(opts.id ?? 'sess-x')),
  getSessionMeta: vi.fn(async () => ({
    workDir: 'D:/repo',
    model: 'meta-model',
    sdkSessionId: 'sdk-1',
    agentKind: 'claude-code' as const,
    permissionMode: undefined as 'ask' | 'bypassPermissions' | undefined,
  })),
  getSession: vi.fn(),
  closeSession: vi.fn(async () => undefined),
  getCapabilities: vi.fn(() => ({
    availableModels: [],
    permissionModes: [{ id: 'ask' }, { id: 'bypassPermissions' }],
    turnPermissionPolicy: {
      supported: { supported: true },
      unsupportedPermissionModes: ['bypassPermissions'],
    },
  })),
};

vi.mock('../../maker-host/index.js', () => ({
  getMaker: () => fakeMaker,
  withRehydrateCloseSuppressed: h.withRehydrateCloseSuppressed,
}));

import { createMakerHookSessionRunner, extractToolResultImageUrls } from '../session-runner.js';
import { MAIN_OWNED_SEND_CONTEXT } from '@cindy/maker-core';
import { observeHookTurn } from '../turnObserver.js';
import { buildHookPromptNote, SLACK_HOOK_PROMPT_NOTE } from '../outbound.js';
import { resolveSafe as resolveXdtImage } from '../../imageCacheStore.js';
import { isHeadlessGhostSetupTurn } from '../../mcp-integrations/ghostSetupInteractionSurface.js';

const log = { info: vi.fn(), warn: vi.fn() };

/** 喂给 agent 的文本 = 用户原话 + 渠道说明(教模型用 xdt-file 回传文件)。 */
const HELLO_WITH_NOTE = `hello\n\n${SLACK_HOOK_PROMPT_NOTE}`;

function catalogModel(id: string, name = id): CatalogModel {
  return {
    id,
    name,
    contextWindow: 200_000,
    efforts: ['low', 'high'],
    defaultEffort: 'high',
  };
}

function connectedProvider(
  id: string,
  models: CatalogModel[],
  agentKind: 'claude-code' | 'codex' = 'claude-code',
): ProviderView {
  return {
    id,
    name: id,
    source: 'builtin',
    agents: [agentKind],
    auth: { method: 'managed' },
    routing: {
      [agentKind]: { upstream: 'https://example.test', authStrategy: 'gateway-key' },
    },
    models: { [agentKind]: models },
    connected: true,
  };
}

function baseReq(
  overrides: Partial<Parameters<ReturnType<typeof createMakerHookSessionRunner>['run']>[0]>,
) {
  return {
    sessionId: 'sess-new',
    isNew: true,
    workingDir: 'D:/repo/.xdt-worktrees/wt-1',
    agentKind: null,
    model: null,
    effort: null,
    permissionMode: null,
    title: '[Slack·DM] dm:U1:g0',
    prompt: 'hello',
    origin: {
      connectionId: 'slack',
      connectionName: 'XDMaker Slack',
      externalKey: 'slack:dm:U1:g0',
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.calls.length = 0;
  h.eventCbs.clear();
  h.headlessDuringSend.length = 0;
  h.headlessAfterAccepted.length = 0;
  h.listProviders.mockReset();
  h.listProviders.mockResolvedValue([]);
  h.getModelVisibilityOverride.mockReset();
  h.getModelVisibilityOverride.mockReturnValue(undefined);
  h.useActualDefaults = false;
  h.resolvedConfig.permissionMode = 'bypassPermissions';
  h.resolvedConfig.providerId = null;
  h.peekPendingHandoff.mockResolvedValue(null);
  h.listMessagesForAgentHandoff.mockReset();
  h.listMessagesForAgentHandoff.mockResolvedValue([]);
});

describe('hook session 精确接管边界', () => {
  it('inspect 的数据库读取失败向上抛出, 不伪装成不存在', async () => {
    const { getSessionRowSnapshotStrict } = await import('../../localDb/ipc/sessions.js');
    vi.mocked(getSessionRowSnapshotStrict).mockRejectedValueOnce(new Error('database unavailable'));
    const runner = createMakerHookSessionRunner({ log });

    await expect(runner.inspect('session-under-test')).rejects.toThrow('database unavailable');
  });

  it('inspect 的 maker metadata 读取失败向上抛出, 不伪装成不存在', async () => {
    fakeMaker.getSessionMeta.mockRejectedValueOnce(new Error('metadata unavailable'));
    const runner = createMakerHookSessionRunner({ log });

    await expect(runner.inspect('session-under-test')).rejects.toThrow('metadata unavailable');
  });

  it('拒绝接管 SSH 远程会话和内部 worker 会话', async () => {
    const { getSessionRowSnapshot } = await import('../../localDb/ipc/sessions.js');
    vi.mocked(getSessionRowSnapshot)
      .mockResolvedValueOnce({
        status: 'active',
        title: 'Remote',
        userSendAt: 1,
        workingDir: '/repo',
        workspaceKind: 'project',
        providerId: null,
        remoteHostId: 'host-1',
        orcaRole: null,
      })
      .mockResolvedValueOnce({
        status: 'active',
        title: 'Worker',
        userSendAt: 1,
        workingDir: '/repo',
        workspaceKind: 'project',
        providerId: null,
        remoteHostId: null,
        orcaRole: 'worker',
      });
    const runner = createMakerHookSessionRunner({ log });

    await expect(runner.inspect('remote-session')).resolves.toMatchObject({ usable: false });
    await expect(runner.inspect('worker-session')).resolves.toMatchObject({ usable: false });
  });
});

describe('真正要跑的那个 live session 的目录也要过映射', () => {
  it('活实例仍在已撤权的目录 -> 拒绝执行, 消息不进 agent', async () => {
    // maker.createSession 对已在 activeSessions 里的 id 直接返回既有实例, 忽略
    // 传入的 workingDir —— 那个实例的 workDir 可能已被移出映射
    fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) => ({
      ...makeFakeSession(opts.id ?? 'sess-old'),
      workDir: 'D:/unmapped-place',
    }));
    const runner = createMakerHookSessionRunner({ log });

    const outcome = await runner.run(
      baseReq({
        sessionId: 'sess-old',
        isNew: false,
        isDirAuthorized: (dir: string) => dir === 'D:/repo',
      }),
    );

    expect(outcome.status).toBe('error');
    expect(outcome.errorMessage).toContain('已不在工作目录映射里的目录');
    const session = await fakeMaker.createSession.mock.results[0].value;
    expect(session.send).not.toHaveBeenCalled();
  });

  it('新建路径不走这道判定(拦下只会留空会话 + 孤儿 worktree)', async () => {
    const runner = createMakerHookSessionRunner({ log });

    // 新会话的 id 刚生成, activeSessions 里不可能有旧实例, 错配不存在;
    // 而此时 agent 已启动、会话行已插入、预建 worktree 还注册着
    const outcome = await runner.run(baseReq({ isDirAuthorized: () => false }));

    expect(outcome.status).toBe('ok');
  });

  it('活实例的目录仍在映射内 -> 照常执行(映射内的移动不受影响)', async () => {
    const runner = createMakerHookSessionRunner({ log });

    const outcome = await runner.run(
      baseReq({
        sessionId: 'sess-old',
        isNew: false,
        isDirAuthorized: (dir: string) => dir === 'D:/repo',
      }),
    );

    expect(outcome.status).toBe('ok');
  });
});

describe('hook session-runner 的 userSendAt 时序(未分类误判回归)', () => {
  it('isNew: touchUserSendInDb 在 sessions:created 广播之前落库, onAccepted 再 bump 一次', async () => {
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(baseReq({}));

    expect(outcome.status).toBe('ok');
    // 广播前必须已 touch —— renderer 重拉才能读到非空 userSendAt, 不落「未分类」
    const touchIdx = h.calls.indexOf('touch:sess-new');
    const createdIdx = h.calls.indexOf('created:sess-new');
    expect(touchIdx).toBeGreaterThanOrEqual(0);
    expect(createdIdx).toBeGreaterThanOrEqual(0);
    expect(touchIdx).toBeLessThan(createdIdx);
    // onAccepted 后的第二次 bump(更新为实际发送时刻)
    expect(h.touchUserSendInDb).toHaveBeenCalledTimes(2);
    // user 消息仍先于第二次 bump 落库
    expect(h.calls.indexOf('createMessage')).toBeLessThan(h.calls.lastIndexOf('touch:sess-new'));
  });

  it('复用/接管(isNew=false): 不广播 created, 但 onAccepted 仍 bump userSendAt', async () => {
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(baseReq({ sessionId: 'sess-old', isNew: false }));

    expect(outcome.status).toBe('ok');
    expect(h.calls).not.toContain('created:sess-old');
    expect(h.touchUserSendInDb).toHaveBeenCalledTimes(1);
    expect(h.touchUserSendInDb).toHaveBeenCalledWith('sess-old');
  });

  it('provider 接受后才执行回调，回调失败不反转已受理 turn', async () => {
    const onProviderAccepted = vi.fn(async () => {
      h.calls.push('providerAccepted');
      throw new Error('cursor db unavailable');
    });
    const runner = createMakerHookSessionRunner({ log });

    const outcome = await runner.run(baseReq({ onProviderAccepted }));

    expect(outcome.status).toBe('ok');
    expect(onProviderAccepted).toHaveBeenCalledTimes(1);
    expect(h.calls.indexOf('createMessage')).toBeLessThan(h.calls.indexOf('providerAccepted'));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('provider-accepted callback failed for session=sess-new'),
    );
  });

  it('入站图片附件:ingest 进媒体总仓挂 session-attachment 引用,喂 agent 用 blob 绝对路径,落库用 cindy-media url', async () => {
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(
      baseReq({
        attachments: [
          {
            name: '../shot\u0000.png',
            mimeType: 'image/png',
            dataBase64: Buffer.from('png-bytes').toString('base64'),
          },
        ],
      } as Partial<Parameters<ReturnType<typeof createMakerHookSessionRunner>['run']>[0]>),
    );
    expect(outcome.status).toBe('ok');

    // ingest 一次,入站图无草稿期直接挂 session-attachment 引用(含出生信息)
    expect(cindyMock.ingestMedia).toHaveBeenCalledTimes(1);
    const ingestCalls = cindyMock.ingestMedia.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    expect(ingestCalls[0][0]).toMatchObject({
      mimeType: 'image/png',
      refs: [
        {
          refKind: 'session-attachment',
          refId: 'sess-new',
          originSessionId: 'sess-new',
          originKind: 'user',
        },
      ],
    });

    // 喂 agent:image block 用 blob 仓绝对路径
    const session = await fakeMaker.createSession.mock.results[0].value;
    const sendCalls = session.send.mock.calls as unknown as Array<
      [{ content: Array<{ type: string; path?: string }> }]
    >;
    const imgBlock = sendCalls[0][0].content.find((b) => b.type === 'image');
    expect(imgBlock?.path).toBe(`/blobs/${'a'.repeat(64)}.png`);

    // 落库:images 用 cindy-media:// URL(桌面/手机聊天记录据此渲染)
    const createCalls = h.createMessage.mock.calls as unknown as Array<
      [string, { content: { images: Array<{ url: string; originalName: string }> } }]
    >;
    expect(createCalls[0][1].content.images[0].url).toBe(
      `cindy-media://blobs/${'a'.repeat(64)}.png`,
    );
    expect(createCalls[0][1].content.images[0].originalName).toBe('shot_.png');
  });

  it('入站图片 ingest 失败:文本照发并明确告知用户附件未完整处理', async () => {
    cindyMock.ingestMedia.mockRejectedValueOnce(new Error('db not ready'));
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(
      baseReq({
        attachments: [
          {
            name: 'shot.png',
            mimeType: 'image/png',
            dataBase64: Buffer.from('png-bytes').toString('base64'),
          },
        ],
      } as Partial<Parameters<ReturnType<typeof createMakerHookSessionRunner>['run']>[0]>),
    );
    expect(outcome.status).toBe('ok');
    const session = await fakeMaker.createSession.mock.results[0].value;
    // 图被降级丢弃:send 内容回落纯文本(仍带渠道说明后缀)
    expect(session.send.mock.calls[0][0]).toMatchObject({ content: HELLO_WITH_NOTE });
    expect(outcome.finalText).toContain(
      'Incoming attachment processing incomplete: 1 item could not be prepared',
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('hook image ingest failed'));
  });

  it('入站音视频经媒体总仓落盘，不写 feature-specific 附件缓存', async () => {
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(
      baseReq({
        attachments: [
          {
            name: '../clip?.mp4',
            mimeType: 'video/mp4',
            dataBase64: Buffer.from('video').toString('base64'),
          },
          {
            name: 'voice.ogg',
            mimeType: 'audio/ogg',
            dataBase64: Buffer.from('voice').toString('base64'),
          },
        ],
      } as Partial<Parameters<ReturnType<typeof createMakerHookSessionRunner>['run']>[0]>),
    );
    expect(outcome.status).toBe('ok');
    expect(cindyMock.ingestMedia).toHaveBeenCalledTimes(2);

    const session = await fakeMaker.createSession.mock.results[0].value;
    const content = session.send.mock.calls[0][0].content as Array<{
      type: string;
      path?: string;
      mimeType?: string;
    }>;
    expect(content.filter((block) => block.type === 'file')).toEqual([
      expect.objectContaining({ path: `/blobs/${'a'.repeat(64)}.mp4`, mimeType: 'video/mp4' }),
      expect.objectContaining({ path: `/blobs/${'a'.repeat(64)}.ogg`, mimeType: 'audio/ogg' }),
    ]);
    const createCalls = h.createMessage.mock.calls as unknown as Array<
      [string, { content: { files: Array<{ path: string; mimeType: string }> } }]
    >;
    expect(createCalls[0][1].content.files).toEqual([
      expect.objectContaining({
        name: 'clip_.mp4',
        path: `cindy-media://blobs/${'a'.repeat(64)}.mp4`,
        mimeType: 'video/mp4',
      }),
      expect.objectContaining({
        path: `cindy-media://blobs/${'a'.repeat(64)}.ogg`,
        mimeType: 'audio/ogg',
      }),
    ]);
  });

  it('不受支持的媒体格式明确失败，不降级写入 feature-specific 附件缓存', async () => {
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(
      baseReq({
        attachments: [
          {
            name: 'diagram.svg',
            mimeType: 'image/svg+xml',
            dataBase64: Buffer.from('<svg />').toString('base64'),
          },
        ],
      } as Partial<Parameters<ReturnType<typeof createMakerHookSessionRunner>['run']>[0]>),
    );

    expect(outcome.status).toBe('ok');
    expect(cindyMock.ingestMedia).not.toHaveBeenCalled();
    const session = await fakeMaker.createSession.mock.results[0].value;
    expect(session.send.mock.calls[0][0]).toMatchObject({ content: HELLO_WITH_NOTE });
    expect(outcome.finalText).toContain(
      'Incoming attachment processing incomplete: 1 item could not be prepared',
    );
    expect(log.warn).toHaveBeenCalledWith(
      'hook media attachment skipped (unsupported cindy-media MIME image/svg+xml)',
    );
  });

  it('渠道说明与渠道标记:喂 agent 带 xdt-file 说明,落库保持原话,createSession 带 slack-hook 标', async () => {
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(baseReq({}));
    expect(outcome.status).toBe('ok');

    // createSession 带渠道标记(cindy_feishu_bot 据此注入路由提示;
    // 刻意不是 'slack' —— 那是已退役 organic SlackIM 渠道的历史标记)
    expect(fakeMaker.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ vendorOptions: { source: 'slack-hook' } }),
    );

    // 喂 agent:用户原话 + 渠道说明(教模型 xdt-file 回传契约)
    const session = await fakeMaker.createSession.mock.results[0].value;
    expect(session.send.mock.calls[0][0]).toMatchObject({ content: HELLO_WITH_NOTE });

    // 落库的用户消息保持 Slack 原话,不带说明(渲染层展示口径)
    const createCalls = h.createMessage.mock.calls as unknown as Array<
      [string, { content: unknown }]
    >;
    expect(createCalls[0][1].content).toBe('hello');
  });

  it('官方 Telegram 新会话保留 provider 标记并把包命令留给 Desktop 确认', async () => {
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(
      baseReq({
        source: { im: 'telegram', channelName: 'Release topic', userText: 'hello' },
        origin: {
          connectionId: 'slack:account:telegram',
          connectionName: 'Cindy Telegram',
          externalKey: 'telegram:dm:bot:user:g0',
        },
      }),
    );
    expect(outcome.status).toBe('ok');
    expect(fakeMaker.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ vendorOptions: { source: 'telegram' } }),
    );
    const session = await fakeMaker.createSession.mock.results[0].value;
    expect(session.send.mock.calls[0][0]).toMatchObject({
      content: `hello\n\n${buildHookPromptNote('telegram')}`,
    });
    expect(session.send.mock.calls[0][1]?.[MAIN_OWNED_SEND_CONTEXT]).toEqual({
      origin: { kind: 'hook', source: 'telegram' },
      rawChannelText: 'hello',
    });
    expect(h.setSessionSourceInDb).toHaveBeenCalledWith('sess-new', 'telegram');
  });

  it.each([
    ['slack', { kind: 'im', channel: 'slack' }],
    ['telegram', { kind: 'hook', source: 'telegram' }],
    ['x', { kind: 'hook', source: 'x' }],
  ] as const)('线程来源 %s 使用 source.userText 作为确定性命令原文', async (im, expectedOrigin) => {
    const runner = createMakerHookSessionRunner({ log });
    const rawCommand = 'pi install npm:context-mode';
    const decoratedPrompt = [
      '<thread_context>',
      '[@alice] previous discussion',
      '</thread_context>',
      '',
      rawCommand,
    ].join('\n');
    const outcome = await runner.run(baseReq({
      prompt: decoratedPrompt,
      source: { im, userText: rawCommand },
    }));
    expect(outcome.status).toBe('ok');
    const session = await fakeMaker.createSession.mock.results[0].value;
    expect(session.send.mock.calls[0][1]?.[MAIN_OWNED_SEND_CONTEXT]).toEqual({
      origin: expectedOrigin,
      rawChannelText: rawCommand,
    });
    expect(session.send.mock.calls[0][0]).toMatchObject({
      content: `${decoratedPrompt}\n\n${buildHookPromptNote(im)}`,
    });
  });

  it('旧服务端缺少 source.userText 时才回退 prompt', async () => {
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(baseReq({ source: { im: 'x' } }));
    expect(outcome.status).toBe('ok');
    const session = await fakeMaker.createSession.mock.results[0].value;
    expect(session.send.mock.calls[0][1]?.[MAIN_OWNED_SEND_CONTEXT]).toEqual({
      origin: { kind: 'hook', source: 'x' },
      rawChannelText: 'hello',
    });
  });

  it('replacement 读取旧任务历史交接给 Agent，落库仍只保存当前 Slack 原话', async () => {
    h.listMessagesForAgentHandoff.mockResolvedValueOnce([
      {
        clientId: 'old-user',
        role: 'user',
        content: '检查支付回调失败的问题并修复',
        createdAt: 1,
        agentMeta: null,
      },
      {
        clientId: 'old-error',
        role: 'error',
        content: 'Provided authentication token is expired',
        createdAt: 2,
        agentMeta: null,
      },
    ]);
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(
      baseReq({
        replacementOfSessionId: 'sess-old',
        prompt: '再试试',
        source: { im: 'slack', channelName: '#general' },
      }),
    );

    expect(outcome.status).toBe('ok');
    expect(h.listMessagesForAgentHandoff).toHaveBeenCalledWith('sess-old', 400);
    const session = await fakeMaker.createSession.mock.results[0].value;
    const sent = session.send.mock.calls[0][0].content as string;
    expect(sent).toContain('检查支付回调失败的问题并修复');
    expect(sent).toContain('Provided authentication token is expired');
    expect(sent).toContain('再试试');
    expect(sent.indexOf('检查支付回调失败的问题并修复')).toBeLessThan(sent.indexOf('再试试'));
    const createCalls = h.createMessage.mock.calls as unknown as Array<
      [string, { content: unknown }]
    >;
    expect(createCalls[0][1].content).toBe('再试试');
  });

  it('旧任务未落库时用进程内原始 prompt 交接；读库报错也不阻断重试', async () => {
    h.listMessagesForAgentHandoff.mockRejectedValueOnce(new Error('database unavailable'));
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(
      baseReq({
        replacementOfSessionId: 'sess-old',
        replacementPrompt: '生成发布说明并提交 PR',
        prompt: '再试试',
        source: { im: 'slack', channelName: '#general' },
      }),
    );

    expect(outcome.status).toBe('ok');
    const session = await fakeMaker.createSession.mock.results[0].value;
    const sent = session.send.mock.calls[0][0].content as string;
    expect(sent).toContain('生成发布说明并提交 PR');
    expect(sent).toContain('再试试');
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('hook replacement history unavailable; using in-memory dispatch context'),
    );
  });

  it('旧任务没有可读历史或进程内 prompt 时仍按当前 dispatch 正常执行', async () => {
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(
      baseReq({
        replacementOfSessionId: 'sess-old',
        prompt: '再试试',
        source: { im: 'slack', channelName: '#general' },
      }),
    );

    expect(outcome.status).toBe('ok');
    const session = await fakeMaker.createSession.mock.results[0].value;
    expect(session.send.mock.calls[0][0]).toMatchObject({
      content: `再试试\n\n${SLACK_HOOK_PROMPT_NOTE}`,
    });
  });

  it('被 /clear 清除过的旧任务不恢复已丢弃的上下文', async () => {
    h.listMessagesForAgentHandoff.mockResolvedValueOnce([]);
    const { getSessionRowSnapshotStrict } = await import('../../localDb/ipc/sessions.js');
    vi.mocked(getSessionRowSnapshotStrict).mockResolvedValueOnce({
      status: 'active',
    } as never);
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(
      baseReq({
        replacementOfSessionId: 'sess-old',
        replacementPrompt: '原始需求',
        prompt: '再试试',
        source: { im: 'slack', channelName: '#general' },
      }),
    );

    expect(outcome.status).toBe('ok');
    const session = await fakeMaker.createSession.mock.results[0].value;
    const sent = session.send.mock.calls[0][0].content as string;
    expect(sent).not.toContain('原始需求');
    expect(sent).toContain('再试试');
  });

  it('截断历史缺少首条用户消息时补入缓存的 replacementPrompt', async () => {
    h.listMessagesForAgentHandoff.mockResolvedValueOnce([
      {
        clientId: 'mid-assistant',
        role: 'assistant',
        content: '正在处理...',
        createdAt: 100,
        agentMeta: null,
      },
      {
        clientId: 'mid-user',
        role: 'user',
        content: '继续',
        createdAt: 200,
        agentMeta: null,
      },
    ]);
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(
      baseReq({
        replacementOfSessionId: 'sess-old',
        replacementPrompt: '检查支付回调失败的问题并修复',
        prompt: '再试试',
        source: { im: 'slack', channelName: '#general' },
      }),
    );

    expect(outcome.status).toBe('ok');
    const session = await fakeMaker.createSession.mock.results[0].value;
    const sent = session.send.mock.calls[0][0].content as string;
    expect(sent).toContain('检查支付回调失败的问题并修复');
    expect(sent).toContain('继续');
    expect(sent.indexOf('检查支付回调失败的问题并修复')).toBeLessThan(sent.indexOf('继续'));
  });

  it('非 Slack 渠道的 replacement 不注入旧任务历史', async () => {
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(
      baseReq({
        replacementOfSessionId: 'sess-old',
        replacementPrompt: '原始需求',
        prompt: '再试试',
        source: { im: 'telegram', channelName: 'Release topic', userText: '再试试' },
      }),
    );

    expect(outcome.status).toBe('ok');
    expect(h.listMessagesForAgentHandoff).not.toHaveBeenCalledWith('sess-old', 400);
    const session = await fakeMaker.createSession.mock.results[0].value;
    const sent = session.send.mock.calls[0][0].content as string;
    expect(sent).not.toContain('原始需求');
  });

  it('pending handoff 只注入 agent wire 内容, accepted 后消费', async () => {
    h.peekPendingHandoff.mockResolvedValueOnce('HANDOFF');
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(baseReq({}));

    expect(outcome.status).toBe('ok');
    const session = await fakeMaker.createSession.mock.results[0].value;
    expect(session.send.mock.calls[0][0]).toMatchObject({
      content: `HANDOFF\n\n${HELLO_WITH_NOTE}`,
    });
    const createCalls = h.createMessage.mock.calls as unknown as Array<
      [string, { content: unknown }]
    >;
    expect(createCalls[0][1].content).toBe('hello');
    expect(h.consumePendingHandoff).toHaveBeenCalledWith('sess-new');
  });

  it('复用/接管(isNew=false):createSession 不带 vendorOptions,不给可能的桌面会话打 Slack 标', async () => {
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(baseReq({ sessionId: 'sess-old', isNew: false }));
    expect(outcome.status).toBe('ok');

    const createArgs = fakeMaker.createSession.mock.calls[0][0] as Record<string, unknown>;
    expect('vendorOptions' in createArgs).toBe(false);
    // 渠道说明仍逐 turn 生效(不依赖 vendorOptions)
    const session = await fakeMaker.createSession.mock.results[0].value;
    expect(session.send.mock.calls[0][0]).toMatchObject({ content: HELLO_WITH_NOTE });
    expect(h.headlessDuringSend).toEqual([false]);
    expect(h.headlessAfterAccepted).toEqual([true]);
    expect(isHeadlessGhostSetupTurn('sess-old')).toBe(false);
  });

  it('does not leak a headless marker when an accept arrives after send failure cleanup', async () => {
    const session = makeFakeSession('sess-old');
    let lateAccepted: (() => Promise<void>) | undefined;
    session.send.mockImplementationOnce(
      async (_msg: unknown, opts: { onAccepted?: () => Promise<void> }) => {
        lateAccepted = opts.onAccepted;
        throw new Error('send failed before admission');
      },
    );
    fakeMaker.createSession.mockResolvedValueOnce(session);
    const runner = createMakerHookSessionRunner({ log });

    await expect(
      runner.run(baseReq({ sessionId: 'sess-old', isNew: false })),
    ).resolves.toMatchObject({ status: 'error' });
    expect(isHeadlessGhostSetupTurn('sess-old')).toBe(false);

    await lateAccepted?.();
    expect(isHeadlessGhostSetupTurn('sess-old')).toBe(false);
  });

  it('isNew: touchUserSendInDb 失败不阻断建会话与广播(onAccepted 兜底)', async () => {
    h.touchUserSendInDb.mockImplementationOnce(async () => {
      throw new Error('db busy');
    });
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(baseReq({}));

    expect(outcome.status).toBe('ok');
    expect(h.calls).toContain('created:sess-new');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('touchUserSend failed'));
  });
});

describe('进度快照(turn.progress 链路)', () => {
  type ManualContinuation = {
    id: number;
    state: 'awaiting' | 'active' | 'cancelled';
    cancel?: () => void;
  };

  /** 不自动 done 的 fake session: 测试手动驱动事件流。 */
  function makeManualSession(id: string, continuation?: ManualContinuation) {
    const permission = makePermissionModeFake();
    const continuationListeners = new Set<(
      continuationId: number,
      state: 'awaiting' | 'active' | 'cancelled',
    ) => void>();
    if (continuation) {
      continuation.cancel = () => {
        continuation.state = 'cancelled';
        for (const listener of [...continuationListeners]) {
          listener(continuation.id, 'cancelled');
        }
      };
    }
    return {
      ...permission,
      get permissionModeState() {
        return permission.permissionModeState;
      },
      id,
      workDir: 'D:/repo',
      onEvent(
        cb: (ev: {
          type: string;
          data: unknown;
          source?: string;
          agentMeta?: Record<string, unknown>;
        }) => void,
      ) {
        h.eventCbs.set(id, cb);
        return () => {
          h.eventCbs.delete(id);
        };
      },
      onStatusChange(cb: (status: 'active' | 'aborting' | 'closed' | 'error') => void) {
        h.statusCbs.set(id, cb);
        return () => {
          h.statusCbs.delete(id);
        };
      },
      beginTurnContinuationWait: (continuationId?: number) => {
        if (!continuation || continuationId !== continuation.id) return null;
        return continuation.state;
      },
      onTurnContinuationChange: (listener: (
        continuationId: number,
        state: 'awaiting' | 'active' | 'cancelled',
      ) => void) => {
        continuationListeners.add(listener);
        return () => continuationListeners.delete(listener);
      },
      setInteractionListener(listener: (req: unknown) => Promise<unknown>) {
        h.interactionListeners.set(id, listener);
      },
      send: vi.fn(
        async (
          _msg: unknown,
          opts: {
            afterTurnReserved?: () => Promise<void> | void;
            beforeProviderStart?: () => Promise<void> | void;
            onAccepted?: () => Promise<void>;
          },
        ) => {
          await opts.afterTurnReserved?.();
          await opts.beforeProviderStart?.();
          await opts.onAccepted?.();
          return {};
        },
      ),
    };
  }

  async function flush(times = 30): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve();
  }

  it('完成态复用桌面分组: 动作前的短旁白折叠，只保留动作后的正式答复', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({}));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      // 消息 1 流式 + 完成(codex translator: 每条 agent_message completed
      // 都发 isFinal=true 携带该条全文)
      cb({ type: 'text', data: { text: '我正在追溯, 稍等。', isFinal: false } });
      cb({ type: 'text', data: { text: '我正在追溯, 稍等。', isFinal: true } });
      // 思考 + 工具
      cb({ type: 'thinking', data: { stage: 'final', blockId: 't1', text: '检查提交记录' } });
      // 消息 2(最终答案)流式 + 完成
      cb({ type: 'text', data: { text: '查到了: 是 PR #527 引入的。', isFinal: false } });
      cb({ type: 'text', data: { text: '查到了: 是 PR #527 引入的。', isFinal: true } });
      cb({ type: 'done', data: null });

      const outcome = await p;
      expect(outcome.status).toBe('ok');
      expect(outcome.finalText).toBe('查到了: 是 PR #527 引入的。');
      expect(outcome.finalText).not.toContain('我正在追溯');
    } finally {
      vi.useRealTimers();
    }
  });

  it('完成态复用桌面分组: 较早的交付正文即使后面还有收尾动作也保持展开', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({}));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;
      const delivery = '# 调查结论\n\n- 根因已确认\n- 影响范围明确\n- 修复方案可实施';

      cb({ type: 'text', data: { text: delivery, isFinal: true } });
      cb({ type: 'tool_use', data: { toolName: 'Bash', toolUseId: 'u1', input: {} } });
      cb({ type: 'text', data: { text: '已完成收尾。', isFinal: true } });
      cb({ type: 'done', data: null });

      const outcome = await p;
      expect(outcome.finalText).toBe(`${delivery}\n\n已完成收尾。`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('thinking 不切断同一条 assistant 流，前后 delta 在 done 时保持完整', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-thinking'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const pending = runner.run(baseReq({}));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      cb({ type: 'text', data: { text: '完整答案的前半，', isFinal: false } });
      cb({
        type: 'thinking',
        data: { stage: 'start', blockId: 'think-1', startedAt: Date.now() },
      });
      cb({
        type: 'thinking',
        data: { stage: 'delta', blockId: 'think-1', text: '检查一下' },
      });
      cb({
        type: 'thinking',
        data: { stage: 'final', blockId: 'think-1', text: '检查一下', durationMs: 12 },
      });
      cb({ type: 'text', data: { text: '以及后半。', isFinal: false } });
      cb({ type: 'done', data: null });

      await expect(pending).resolves.toMatchObject({
        status: 'ok',
        finalText: '完整答案的前半，以及后半。',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('running 的任务卡不阻塞 done；只有 provider 明确的 continuation 才等待下一 turn', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const immediate = runner.run(baseReq({}));
      await flush();
      let cb = h.eventCbs.get('sess-new')!;

      cb({
        type: 'agent_task_update',
        data: { provider: 'codex', taskId: 'card-1', status: 'running' },
      });
      cb({ type: 'text', source: 'codex', data: { text: '完成。', isFinal: true } });
      cb({ type: 'done', data: null });
      await expect(immediate).resolves.toMatchObject({ status: 'ok', finalText: '完成。' });

      const continuation: ManualContinuation = { id: 7, state: 'awaiting' };
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-y', continuation),
      );
      const waiting = runner.run(baseReq({ sessionId: 'sess-y' }));
      await flush();
      cb = h.eventCbs.get('sess-y')!;
      let settled = false;
      void waiting.then(() => {
        settled = true;
      });

      cb({ type: 'text', data: { text: '等待后台结果。', isFinal: true } });
      cb({ type: 'done', data: null, turnContinuationId: continuation.id });
      await flush();
      expect(settled).toBe(false);

      continuation.state = 'active';
      cb({ type: 'text', data: { text: '最终结论。', isFinal: true } });
      cb({ type: 'done', data: null });
      await expect(waiting).resolves.toMatchObject({ status: 'ok' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('continuation task stopped after done 收到 provider cancellation 后立即收口', async () => {
    vi.useFakeTimers();
    try {
      const continuation: ManualContinuation = { id: 9, state: 'awaiting' };
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-stop', continuation),
      );
      const runner = createMakerHookSessionRunner({ log });
      const pending = runner.run(baseReq({}));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;
      cb({ type: 'text', data: { text: '等待后台任务。', isFinal: true } });
      cb({ type: 'done', data: null, turnContinuationId: continuation.id });
      await flush();

      let settled = false;
      void pending.then(() => { settled = true; });
      expect(settled).toBe(false);
      continuation.cancel?.();

      await expect(pending).resolves.toMatchObject({
        status: 'ok',
        finalText: '等待后台任务。',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('host 消费父 done 前 continuation 已 active，仍等待第二个 done', async () => {
    vi.useFakeTimers();
    try {
      const continuation: ManualContinuation = { id: 11, state: 'active' };
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-active', continuation),
      );
      const runner = createMakerHookSessionRunner({ log });
      const pending = runner.run(baseReq({}));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;
      let settled = false;
      void pending.then(() => { settled = true; });

      cb({ type: 'text', data: { text: '父 turn 已结束。', isFinal: true } });
      cb({ type: 'done', data: null, turnContinuationId: continuation.id });
      await flush();
      expect(settled).toBe(false);

      cb({ type: 'text', data: { text: '自动续 turn 的最终结果。', isFinal: true } });
      cb({ type: 'done', data: null });
      await expect(pending).resolves.toMatchObject({ status: 'ok' });
      const outcome = await pending;
      expect(outcome.finalText).toContain('自动续 turn 的最终结果。');
    } finally {
      vi.useRealTimers();
    }
  });

  it('没有 continuation claim ID 的 done 一律收口，不采样 live task 状态', async () => {
    vi.useFakeTimers();
    try {
      const unrelatedClaim: ManualContinuation = { id: 12, state: 'awaiting' };
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-unclaimed', unrelatedClaim),
      );
      const runner = createMakerHookSessionRunner({ log });
      const pending = runner.run(baseReq({}));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      cb({ type: 'text', data: { text: '这个 done 没有续跑边界。', isFinal: true } });
      cb({ type: 'done', data: null });
      await expect(pending).resolves.toMatchObject({
        status: 'ok',
        finalText: '这个 done 没有续跑边界。',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('status.isRunning=false 只是展示状态，不能替代 done 提前收口', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({}));
      let settled = false;
      void p.then(() => {
        settled = true;
      });
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      cb({ type: 'text', data: { text: '最终答复。', isFinal: true } });
      cb({ type: 'status', data: { status: 'Done', isRunning: false } });
      await flush();
      expect(settled).toBe(false);

      cb({ type: 'done', data: null });
      await expect(p).resolves.toMatchObject({ status: 'ok', finalText: '最终答复。' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('续尾补推(claude result 兜底): isFinal 只含缺失尾段时与已流增量原样接上', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({}));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      // 消息 1 正常定稿。
      cb({ type: 'text', data: { text: '旁白说明。', isFinal: true } });
      // 消息 2 流到一半被截断, translator 用 result 兜底只补 UI 缺的尾段
      // (fallbackTail): 该 isFinal 不含已流出的前缀。
      cb({ type: 'text', data: { text: '最终答案是 4', isFinal: false } });
      cb({ type: 'text', data: { text: '2。', isFinal: true } });
      cb({ type: 'done', data: null });

      const outcome = await p;
      // 前缀不丢、正文中间不插段落分隔。
      expect(outcome.finalText).toContain('最终答案是 42。');
      expect(outcome.finalText).toContain('旁白说明。');
      expect(outcome.finalText).not.toContain('4\n\n2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('claude 同一条消息的相邻文本块按原文连拼, 不同消息之间空行分隔', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({}));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      // 消息 m1 含两个相邻文本块(translator 逐块发 isFinal, 同 uuid)。
      cb({
        type: 'text',
        data: { text: '前半', isFinal: true },
        source: 'claude-code',
        agentMeta: { uuid: 'm1' },
      });
      cb({
        type: 'text',
        data: { text: '后半。', isFinal: true },
        source: 'claude-code',
        agentMeta: { uuid: 'm1' },
      });
      // 消息 m2 是另一条 assistant 消息。
      cb({
        type: 'text',
        data: { text: '第二条。', isFinal: true },
        source: 'claude-code',
        agentMeta: { uuid: 'm2' },
      });
      cb({ type: 'done', data: null });

      const outcome = await p;
      expect(outcome.finalText).toBe('前半后半。\n\n第二条。');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Claude 同 uuid 跨 tool 边界不得回写旧 assistant 消息', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({}));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      cb({
        type: 'text',
        source: 'claude-code',
        agentMeta: { uuid: 'same-message' },
        data: { text: '先说一句。', isFinal: true },
      });
      cb({ type: 'tool_use', data: { toolName: 'Read', toolUseId: 'read-1', input: {} } });
      cb({
        type: 'text',
        source: 'claude-code',
        agentMeta: { uuid: 'same-message' },
        data: { text: '最终结论。', isFinal: true },
      });
      cb({ type: 'done', data: null });

      const outcome = await p;
      expect(outcome.finalText).toBe('最终结论。');
      expect(outcome.finalText).not.toContain('先说一句');
    } finally {
      vi.useRealTimers();
    }
  });

  it('delta-only assistant 在 tool 前先封存，tool 后的 canonical 文本不覆盖它', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({}));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      cb({ type: 'text', data: { text: '过程旁白。', isFinal: false } });
      cb({ type: 'tool_use', data: { toolName: 'Read', toolUseId: 'read-1', input: {} } });
      cb({ type: 'text', source: 'codex', data: { text: '最终结论。', isFinal: true } });
      cb({ type: 'done', data: null });

      const outcome = await p;
      expect(outcome.finalText).toBe('最终结论。');
      expect(outcome.finalText).not.toContain('过程旁白');
    } finally {
      vi.useRealTimers();
    }
  });

  it('X: 只发送一条回帖, 正文仍按桌面规则折叠短过程旁白', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({ source: { im: 'x' } }));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      // agent 的常态: 先说一句要去看看 -> 干活 -> 给结论。
      cb({ type: 'text', data: { text: '我先看看这个链接。', isFinal: true } });
      cb({ type: 'tool_use', data: { toolName: 'WebFetch', toolUseId: 'u1', input: {} } });
      cb({
        type: 'text',
        data: {
          text: '结论: 该库已停止维护。\uE200cite\uE202turn17search1\uE202turn17search2\uE201',
          isFinal: true,
        },
      });
      cb({ type: 'done', data: null });

      const outcome = await p;
      expect(outcome.status).toBe('ok');
      // X 只有一条公开回帖, 但正文仍走桌面版完成态规则: 短过程旁白折叠,
      // 正式结论保留。
      expect(outcome.finalText).toBe('结论: 该库已停止维护。');
      expect(outcome.finalText).not.toContain('我先看看');
      expect(outcome.finalText).not.toContain('\uE200');
    } finally {
      vi.useRealTimers();
    }
  });

  it('X: 一条回帖仍保留标题/长正文等桌面版正式内容', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({ source: { im: 'x' } }));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;
      const report = `# 交付报告\n\n${'这部分是需要保留的正式分析内容。'.repeat(80)}`;

      cb({ type: 'text', data: { text: '我先核对一下。', isFinal: true } });
      cb({ type: 'tool_use', data: { toolName: 'Read', toolUseId: 'read-report', input: {} } });
      cb({ type: 'text', data: { text: report, isFinal: true } });
      cb({ type: 'text', data: { text: '已完成。', isFinal: true } });
      cb({ type: 'done', data: null });

      const outcome = await p;
      expect(outcome.status).toBe('ok');
      // X 仍只有一条公开消息; 这里断言的是那条消息的正文内容, 而不是消息数量。
      expect(outcome.finalText).toContain('# 交付报告');
      expect(outcome.finalText).toContain('这部分是需要保留的正式分析内容。');
      expect(outcome.finalText).toContain('已完成。');
      expect(outcome.finalText).not.toContain('我先核对一下。');
    } finally {
      vi.useRealTimers();
    }
  });

  it('X: 最后一条收口时仍在流(无 isFinal)也纳入同一条正式正文', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({ source: { im: 'x' } }));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      cb({ type: 'text', data: { text: '先查一下提交记录。', isFinal: true } });
      // 最后一条只流增量、没等到 isFinal 就 done —— done 会把尾巴封成
      // assistant message, 再由桌面规则决定它和前一段是否属于正式正文。
      cb({ type: 'text', data: { text: '答案是 42。', isFinal: false } });
      cb({ type: 'done', data: null });

      const outcome = await p;
      expect(outcome.finalText).toBe('先查一下提交记录。\n\n答案是 42。');
    } finally {
      vi.useRealTimers();
    }
  });

  it('X: envelope 缺 uuid 时按 requestId 认消息边界, 多 block 消息不被截半句', async () => {
    // uuid 是 envelope 顶层的**可选**字段, 确实会缺。缺了又没有回退的话, 一条含
    // 多个 text block 的消息会被拆成多条"消息", 正文投影就可能从中间截半句。
    // requestId 是 Anthropic 的 message id,
    // 同一条消息的各 block 共享、不同消息不同, 正好是这里要的语义。
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({ source: { im: 'x' } }));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      // 前一条消息(过程叙述), 另一个 message id。
      cb({
        type: 'text',
        data: { text: '我先看看。', isFinal: true },
        source: 'claude-code',
        agentMeta: { requestId: 'msg_a' },
      });
      // 结论这一条含两个 text block, 只有 requestId 可用。
      cb({
        type: 'text',
        data: { text: '结论: 分成两块说。', isFinal: true },
        source: 'claude-code',
        agentMeta: { requestId: 'msg_b' },
      });
      cb({
        type: 'text',
        data: { text: '第二块也属于同一条。', isFinal: true },
        source: 'claude-code',
        agentMeta: { requestId: 'msg_b' },
      });
      cb({ type: 'done', data: null });

      const outcome = await p;
      // 同一条消息的两个 block 必须都在。前一条没有动作边界,按桌面规则也是
      // 正文消息,因此不会凭空套用「只取最后一条」的 X 特殊启发式。
      expect(outcome.finalText).toBe('我先看看。\n\n结论: 分成两块说。第二块也属于同一条。');
    } finally {
      vi.useRealTimers();
    }
  });

  it('X: claude 的 fallbackTail 自成一段, 短旁白不被粘进公开正文', async () => {
    // fallbackTail 刻意不带 agentMeta, hook 层拿不到它属于哪条消息。translator
    // 点名覆盖的场景是「前面 call 推过旁白、最后一次 call 的最终回复被截断」——
    // 即尾段是**新的一条**。并入上一条会破坏消息边界, 让旁白影响正文折叠。
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({ source: { im: 'x' } }));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      // 旁白已定稿(带 agentMeta), 随后终答只经 result 的 fallbackTail 补回。
      cb({
        type: 'text',
        data: { text: '我先去看看。', isFinal: true },
        source: 'claude-code',
        agentMeta: { uuid: 'm1' },
      });
      cb({ type: 'text', data: { text: '结论: 已修复。', isFinal: true }, source: 'claude-code' });
      cb({ type: 'done', data: null });

      const outcome = await p;
      expect(outcome.finalText).toBe('我先去看看。\n\n结论: 已修复。');
    } finally {
      vi.useRealTimers();
    }
  });

  it('X: 正文按桌面规则投影, 但附件引用仍按整轮扫描(工作过程里的图不能丢)', async () => {
    // agent 的常态是"中间那条贴图 -> 最后一条只写结论"。正文范围和引用扫描范围
    // 绑在一起的话, 被折叠的工作过程里的图会静默丢掉(PR #1272 review 指出)。
    // 这里让 resolveSafe 抛错 -> 收集失败计数 -> 正文追加"附件未送达"警告:
    // 这条警告本身就是"引用确实被扫到了"的证据。修复前它压根不会出现。
    vi.useFakeTimers();
    try {
      vi.mocked(resolveXdtImage).mockImplementation(() => {
        throw new Error('cache miss');
      });
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({ source: { im: 'x' } }));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      cb({ type: 'text', data: { text: '图在这里 ![图](xdt-image://chart.png)', isFinal: true } });
      cb({ type: 'text', data: { text: '结论: 趋势向上。', isFinal: true } });
      cb({ type: 'done', data: null });

      const outcome = await p;
      expect(outcome.status).toBe('ok');
      // 公开正文按桌面规则保留可见正文; 引用扫描仍覆盖整轮, 所以中间图片会
      // 被转换为可读标签, 并在收集失败时追加警告。
      expect(outcome.finalText).toContain('结论: 趋势向上。');
      expect(outcome.finalText).toContain('图在这里');
      expect(outcome.finalText).toContain('🖼️ _图_');
      expect(outcome.finalText).toContain('Attachment delivery incomplete');
    } finally {
      vi.mocked(resolveXdtImage).mockReset();
      vi.useRealTimers();
    }
  });

  it('X: 正式正文为空时回退整轮正文, 不发空回帖', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({ source: { im: 'x' } }));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      cb({ type: 'text', data: { text: '结论: 已修复。', isFinal: true } });
      cb({ type: 'text', data: { text: '   ', isFinal: true } });
      cb({ type: 'done', data: null });

      const outcome = await p;
      // 公开回帖宁可带上整轮内容, 也不能因为正文投影为空就发成空。
      expect(outcome.finalText).toContain('结论: 已修复。');
    } finally {
      vi.useRealTimers();
    }
  });

  it('claude 续尾与已流增量重复前缀时不误判为全文(ha→haha 不丢后半段)', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({}));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      // 流式增量 "ha" 后流被截断, result 兜底补的尾段恰好也是 "ha"
      // (全文 "haha")。fallbackTail 契约: 不带 agentMeta。
      cb({ type: 'text', data: { text: 'ha', isFinal: false }, source: 'claude-code' });
      cb({ type: 'text', data: { text: 'ha', isFinal: true }, source: 'claude-code' });
      cb({ type: 'done', data: null });

      const outcome = await p;
      expect(outcome.finalText).toBe('haha');
    } finally {
      vi.useRealTimers();
    }
  });

  it('未定稿流式尾巴保留首行缩进与换行(markdown 代码块不被 trim 破坏)', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({}));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      cb({ type: 'text', data: { text: '    indented code\nline2', isFinal: false } });
      cb({ type: 'done', data: null });

      const outcome = await p;
      expect(outcome.finalText).toContain('    indented code\nline2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Telegram 群 lane: 进度带过程时间线(时间线在上正文在下), 无正文时也有时间线', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const emitted: string[] = [];
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(
        baseReq({
          source: { im: 'telegram', userText: 'hi' },
          onProgress: (text: string) => emitted.push(text),
        }),
      );
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      // 只有工具活动、还没有正文时也要发时间线(DM 与群同款)。
      cb({
        type: 'tool_use',
        data: { toolUseId: 'read-1', toolName: 'Read', input: { file_path: '/repo/a.ts' } },
      });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(emitted.length).toBeGreaterThan(0);
      expect(emitted.at(-1)).toContain('▸');

      cb({ type: 'text', data: { text: '结论是 42。', isFinal: false } });
      await vi.advanceTimersByTimeAsync(1_500);
      const last = emitted.at(-1)!;
      expect(last).toContain('结论是 42。');
      // 合成规则与 Slack 过程卡同款: 时间线在上, 正文在下。
      expect(last.indexOf('▸')).toBeLessThan(last.indexOf('结论是 42。'));

      cb({ type: 'done', data: null });
      await p;
    } finally {
      vi.useRealTimers();
    }
  });

  it('Telegram 群轮次沿用用户配置的权限档, 不再隐式降档、不挂强确认策略', async () => {
    // 「完全访问就是完全访问」(Chris 2026-08-03): 此前群轮次会把新会话强制建成
    // 'ask'、给复用会话每轮临时切档, 并挂破坏性操作强确认 —— 用户在设置里选的
    // 完全访问在群里静默失效。官方 bot 的群聊定位是引导用户装自己的个人 bot,
    // 不承担「群里多人共用一个 bot」的权限模型(那套在个人 bot 里另有设计)。
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(
      baseReq({
        source: { im: 'telegram', userText: 'hi' },
        laneKind: 'group',
        permissionMode: 'bypassPermissions',
      }),
    );

    expect(outcome.status).toBe('ok');
    // 新会话按用户配置建, 不被替换成 'ask'
    expect(fakeMaker.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'bypassPermissions' }),
    );
    const session = await fakeMaker.createSession.mock.results[0].value;
    // 不再挂 turnPermissionPolicy(它在 bypass 档下会被 maker fail-closed 拒绝,
    // 正是当初必须降档的原因)
    const sendOptions = session.send.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sendOptions.turnPermissionPolicy).toBeUndefined();
    // afterTurnReserved 仍在, 但只用来取 turn lease(见另一条用例) —— 权限档一律不碰
    expect(session.setPermissionMode).not.toHaveBeenCalled();
    expect(session.setPermissionModeTracked).not.toHaveBeenCalled();
  });

  it('Telegram 群轮次仍取 turn lease, 且到 observer 收口(含后台任务)才释放', async () => {
    // lease 与权限档是两件事: 上一版把它跟临时降档一起删了, 于是「前台 done →
    // 后台任务续跑」的空窗里 Desktop 轮次会被放进来共享 session 事件流 / origin /
    // 交互路由(codex review #1490)。这里锁住「取了、且不早放」。
    fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
      makeManualSession(opts.id ?? 'sess-x'),
    );
    const runner = createMakerHookSessionRunner({ log });
    const p = runner.run(baseReq({ source: { im: 'telegram', userText: 'hi' }, laneKind: 'group' }));
    await flush();

    const session = await fakeMaker.createSession.mock.results[0].value;
    const release = session.acquireTurnLease.mock.results[0]?.value as ReturnType<typeof vi.fn>;
    expect(session.acquireTurnLease).toHaveBeenCalledTimes(1);
    // turn 还在跑 —— 不许提前释放
    expect(release).not.toHaveBeenCalled();

    h.eventCbs.get('sess-new')!({ type: 'done', data: null });
    await p;
    expect(release).toHaveBeenCalled();
  });

  it('Telegram DM 轮次不取 turn lease(独占只为群的后台续跑窗口)', async () => {
    fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
      makeManualSession(opts.id ?? 'sess-x'),
    );
    const runner = createMakerHookSessionRunner({ log });
    const p = runner.run(baseReq({ source: { im: 'telegram', userText: 'hi' }, laneKind: 'dm' }));
    await flush();
    const session = await fakeMaker.createSession.mock.results[0].value;
    expect(session.acquireTurnLease).not.toHaveBeenCalled();
    h.eventCbs.get('sess-new')!({ type: 'done', data: null });
    await p;
  });

  it('Telegram 群复用会话不再临时切换权限档', async () => {
    const session = makeFakeSession('sess-old');
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(
      baseReq({
        isNew: false,
        sessionId: 'sess-old',
        laneKind: 'group',
        source: { im: 'telegram', userText: 'hi' },
      }),
    );

    expect(outcome.status).toBe('ok');
    expect(session.setPermissionMode).not.toHaveBeenCalled();
    expect(session.setPermissionModeTracked).not.toHaveBeenCalled();
  });

  it('thinking/tool_use/text 驱动友好快照,运行中只保留最后一段文字;done 后停止', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const emitted: string[] = [];
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({ onProgress: (t: string) => emitted.push(t) }));
      await flush(); // 走到 send 完成、事件监听已挂

      const cb = h.eventCbs.get('sess-new')!;
      expect(cb).toBeTypeOf('function');

      // 第一步工具调用 -> 首帧快照(节流窗口内立即发射)
      cb({
        type: 'tool_use',
        data: { toolUseId: 'test-1', toolName: 'Bash', input: { command: 'pnpm test' } },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toContain('工作中 · 1 项');
      expect(emitted[0]).toContain('运行测试');
      expect(emitted[0]).not.toContain('Bash pnpm test');

      // 节流窗口内的密集事件合并成一帧:思考 + 第二步 + 正文 delta。
      cb({
        type: 'thinking',
        data: { stage: 'final', blockId: 'thinking-1', text: '**检查实现**' },
      });
      cb({
        type: 'tool_use',
        data: { toolUseId: 'read-1', toolName: 'Read', input: { file_path: 'D:/repo/a.ts' } },
      });
      cb({ type: 'text', data: { text: '结论是……', isFinal: false } });
      expect(emitted).toHaveLength(1); // 还没到 1.5s, 不发
      await vi.advanceTimersByTimeAsync(1500);
      expect(emitted).toHaveLength(2);
      expect(emitted[1]).toContain('工作中 · 3 项');
      expect(emitted[1]).toContain('✦ 检查实现');
      expect(emitted[1]).toContain('读取 a.ts');
      expect(emitted[1]).toContain('结论是……');
      expect(emitted[1]).not.toContain('正在书写回复');

      // 曾输出过程文字不应让后来的工具被误标成已完成;文字也不能被裁掉。
      cb({
        type: 'tool_use',
        data: { toolUseId: 'grep-1', toolName: 'Grep', input: { pattern: 'onProgress' } },
      });
      await vi.advanceTimersByTimeAsync(1500);
      expect(emitted).toHaveLength(3);
      expect(emitted[2]).toContain('> ▸ 搜索 onProgress');
      expect(emitted[2]).toContain('结论是……');

      // 新 assistant 消息出现后，之前那段不再在运行中快照里重复铺开。
      cb({ type: 'text', data: { text: '结论是……', isFinal: true } });
      cb({ type: 'text', data: { text: '最终结果。', isFinal: false } });
      await vi.advanceTimersByTimeAsync(1500);
      expect(emitted).toHaveLength(4);
      expect(emitted[3]).toContain('最终结果。');
      expect(emitted[3]).not.toContain('结论是……');

      // 收口: done 之后即使时间继续流逝也不再发射
      cb({ type: 'done', data: null });
      await vi.advanceTimersByTimeAsync(20_000);
      const outcome = await p;
      expect(outcome.status).toBe('ok');
      // 两条 assistant 之间没有新的真实动作，桌面端把它们视为同一个连续正式
      // 答复；运行中只显示后一条，完成态则一次性替换为完整正式答复。
      expect(outcome.finalText).toBe('结论是……\n\n最终结果。');
      expect(emitted).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('官方 Telegram 运行中累计多段正文，done 立即冲刷节流窗里的最后答案', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const emitted: string[] = [];
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(
        baseReq({
          source: { im: 'telegram', userText: 'hi' },
          onProgress: (text: string) => emitted.push(text),
        }),
      );
      await flush();

      const cb = h.eventCbs.get('sess-new')!;
      cb({ type: 'text', data: { text: '先说第一段。', isFinal: true }, source: 'codex' });
      await vi.advanceTimersByTimeAsync(0);
      expect(emitted.at(-1)).toContain('先说第一段。');

      // 对齐 Hermes 的事件流思路：thinking / tool 先作为结构化事件
      // 进入共享 presenter，Telegram whole 模式再投影过程区与累计正文。
      cb({
        type: 'thinking',
        data: { stage: 'final', blockId: 'check-final', text: '核对收口链路' },
      });
      cb({
        type: 'tool_use',
        data: {
          toolUseId: 'read-final',
          toolName: 'Read',
          input: { file_path: '/repo/final.ts' },
        },
      });

      // 第二段还在 1.5s trailing 窗口内就结束。旧逻辑 teardown 会清 timer，
      // 导致这段正文从未进入 turn.progress；Telegram 路径必须立刻发累计快照。
      cb({ type: 'text', data: { text: '最后答案。', isFinal: true }, source: 'codex' });
      cb({ type: 'done', data: null });
      const outcome = await p;

      expect(outcome.status).toBe('ok');
      // 工具前的短旁白只属于运行过程：进度快照要保留，正式终稿
      // 仍按桌面消息流规则折叠它，不把过程旁白混进答案。
      expect(outcome.finalText).toBe('最后答案。');
      expect(emitted.at(-1)).toContain('先说第一段。\n\n最后答案。');
      expect(emitted.at(-1)).toContain('工作中 · 2 项');
      expect(emitted.at(-1)).toContain('核对收口链路');
      expect(emitted.at(-1)).toContain('读取 final.ts');
      const countAfterDone = emitted.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(emitted).toHaveLength(countAfterDone);
    } finally {
      vi.useRealTimers();
    }
  });

  it('未注入 onProgress 时零开销路径: 正常收口无异常', async () => {
    fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
      makeManualSession(opts.id ?? 'sess-x'),
    );
    const runner = createMakerHookSessionRunner({ log });
    const p = runner.run(baseReq({}));
    await new Promise((r) => setTimeout(r, 0));
    const cb = h.eventCbs.get('sess-new')!;
    cb({ type: 'tool_use', data: { toolName: 'Bash', input: { command: 'ls' } } });
    cb({ type: 'done', data: null });
    const outcome = await p;
    expect(outcome.status).toBe('ok');
  });
});

describe('上游过载自动重试期间的渠道进度(零产出窗口)', () => {
  function makeManualSession(id: string) {
    return {
      ...makePermissionModeFake(),
      id,
      workDir: 'D:/repo',
      onEvent(cb: (ev: { type: string; data: unknown }) => void) {
        h.eventCbs.set(id, cb);
        return () => {
          h.eventCbs.delete(id);
        };
      },
      onStatusChange(cb: (status: 'active' | 'aborting' | 'closed' | 'error') => void) {
        h.statusCbs.set(id, cb);
        return () => {
          h.statusCbs.delete(id);
        };
      },
      setInteractionListener(listener: (req: unknown) => Promise<unknown>) {
        h.interactionListeners.set(id, listener);
      },
      send: vi.fn(
        async (
          _msg: unknown,
          opts: {
            beforeProviderStart?: () => Promise<void> | void;
            onAccepted?: () => Promise<void>;
          },
        ) => {
          await opts.beforeProviderStart?.();
          await opts.onAccepted?.();
          return {};
        },
      ),
    };
  }

  async function flush(times = 30): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve();
  }

  /**
   * 本 describe 的核心回归: 过载重投只在**零产出**时发生, 那时过程区与正文都是
   * 空的。若非终止 error 不进过程区, 整个退避窗口(~22-38s)一帧 turn.progress 都
   * 发不出去 —— 渠道那条占位消息一个字不变, 用户只能判断为"卡死"。
   */
  it('非终止过载 error 发出带进度的快照帧, turn 不收口', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const emitted: string[] = [];
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({ onProgress: (t: string) => emitted.push(t) }));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      cb({
        type: 'error',
        data: {
          message: 'Selected model is at capacity. Please try a different model. (auto-retry 1/4)',
          isTerminal: false,
          willRetry: true,
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toContain('⏳ 模型服务繁忙，正在自动重试（1/4）…');
      // 零工作项时不报"0 项", 但耗时仍在走(用户能看出还在动)。
      expect(emitted[0]).toContain('⚙️ 工作中 · 0s');
      expect(emitted[0]).not.toContain('项 ·');

      // 次数推进 -> 新一帧; 内容没变的 ticker 帧不重复发。
      cb({
        type: 'error',
        data: {
          message: 'Selected model is at capacity. Please try a different model. (auto-retry 2/4)',
          isTerminal: false,
          willRetry: true,
        },
      });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(emitted).toHaveLength(2);
      expect(emitted[1]).toContain('（2/4）');

      // 重投成功: 真实进展到达 -> 状态行消失, 不在时间线里冒充一项工作。
      cb({
        type: 'tool_use',
        data: { toolUseId: 'read-1', toolName: 'Read', input: { file_path: 'D:/repo/a.ts' } },
      });
      await vi.advanceTimersByTimeAsync(1_500);
      const afterRecovery = emitted.at(-1)!;
      expect(afterRecovery).toContain('工作中 · 1 项');
      expect(afterRecovery).toContain('读取 a.ts');
      expect(afterRecovery).not.toContain('自动重试');

      cb({ type: 'text', data: { text: '好了。', isFinal: true } });
      cb({ type: 'done', data: null });
      const outcome = await p;
      expect(outcome.status).toBe('ok');
      expect(outcome.finalText).toBe('好了。');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Telegram DM 与群同一套过程区: 工具时间线在上正文在下', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const emitted: string[] = [];
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(
        baseReq({
          source: { im: 'telegram', userText: 'hello' },
          onProgress: (t: string) => emitted.push(t),
        }),
      );
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      // 零产出的过载重试: 与群同款的“工作中 + 状态行”, 不再是裸文本一行。
      cb({
        type: 'error',
        data: { message: 'model is at capacity (auto-retry 1/4)', isTerminal: false },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toContain('⚙️ 工作中');
      expect(emitted[0]).toContain('⏳ 模型服务繁忙，正在自动重试（1/4）…');

      // 工具调用在 DM 也可见(本次统一的核心): 旧行为这里什么都不发。
      cb({
        type: 'tool_use',
        data: { toolUseId: 'read-1', toolName: 'Read', input: { file_path: 'D:/repo/a.ts' } },
      });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(emitted.at(-1)).toContain('读取 a.ts');
      expect(emitted.at(-1)).toContain('工作中 · 1 项');

      // 有正文后仍保留过程区: 时间线在上, 正文在下(与群 lane 逐字同口径)。
      cb({ type: 'text', data: { text: '结论。', isFinal: false } });
      await vi.advanceTimersByTimeAsync(1_500);
      const last = emitted.at(-1)!;
      expect(last).toContain('读取 a.ts');
      expect(last).toContain('结论。');
      expect(last.indexOf('读取 a.ts')).toBeLessThan(last.indexOf('结论。'));

      cb({ type: 'done', data: null });
      await p;
    } finally {
      vi.useRealTimers();
    }
  });

  it('非过载的非终止 error 保持静默(不发帧, 不收口)', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeManualSession(opts.id ?? 'sess-x'),
      );
      const emitted: string[] = [];
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(baseReq({ onProgress: (t: string) => emitted.push(t) }));
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      cb({
        type: 'error',
        data: { message: 'stream disconnected (Reconnecting 1/3)', isTerminal: false },
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(emitted).toEqual([]);

      cb({ type: 'done', data: null });
      const outcome = await p;
      expect(outcome.status).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('重试耗尽的终态过载错误换成可操作说明(桌面端重试不回流, 必须说清)', async () => {
    fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
      makeManualSession(opts.id ?? 'sess-x'),
    );
    const runner = createMakerHookSessionRunner({ log });
    const p = runner.run(baseReq({}));
    await new Promise((r) => setTimeout(r, 0));
    const cb = h.eventCbs.get('sess-new')!;
    cb({
      type: 'error',
      data: {
        message: 'Selected model is at capacity. Please try a different model.',
        isTerminal: true,
      },
    });
    const outcome = await p;
    expect(outcome.status).toBe('error');
    expect(outcome.errorMessage).toContain('模型服务繁忙');
    expect(outcome.errorMessage).toContain('在这里重发这条消息');
    // 上游原文不外发到渠道, 只留在本地日志里。
    expect(outcome.errorMessage).not.toContain('Selected model is at capacity');
  });

  it('非过载的终态错误仍原样上报(不误改其它失败的诊断信息)', async () => {
    fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
      makeManualSession(opts.id ?? 'sess-x'),
    );
    const runner = createMakerHookSessionRunner({ log });
    const p = runner.run(baseReq({}));
    await new Promise((r) => setTimeout(r, 0));
    const cb = h.eventCbs.get('sess-new')!;
    cb({ type: 'error', data: { message: 'process exited with code 1', isTerminal: true } });
    const outcome = await p;
    expect(outcome.status).toBe('error');
    expect(outcome.errorMessage).toBe('process exited with code 1');
  });
});

describe('交互卡链路(interaction listener 覆盖)', () => {
  /** 带 setInteractionListener 的 fake session(不自动 done)。 */
  function makeInteractiveSession(id: string) {
    return {
      ...makePermissionModeFake(),
      id,
      workDir: 'D:/repo',
      onEvent(
        cb: (ev: {
          type: string;
          data: unknown;
          source?: string;
          agentMeta?: Record<string, unknown>;
        }) => void,
      ) {
        h.eventCbs.set(id, cb);
        return () => {
          h.eventCbs.delete(id);
        };
      },
      onStatusChange(cb: (status: 'active' | 'aborting' | 'closed' | 'error') => void) {
        h.statusCbs.set(id, cb);
        return () => {
          h.statusCbs.delete(id);
        };
      },
      setInteractionListener(listener: (req: unknown) => Promise<unknown>) {
        h.interactionListeners.set(id, listener);
      },
      send: vi.fn(
        async (
          _msg: unknown,
          opts: {
            beforeProviderStart?: () => Promise<void> | void;
            onAccepted?: () => Promise<void>;
          },
        ) => {
          await opts.beforeProviderStart?.();
          await opts.onAccepted?.();
          return {};
        },
      ),
    };
  }

  it('等授权期间过程区挂一行状态, 决策回流后摘掉', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeInteractiveSession(opts.id ?? 'sess-x'),
      );
      const emitted: string[] = [];
      const cards: Array<{ interactionId: string }> = [];
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(
        baseReq({
          onProgress: (t: string) => emitted.push(t),
          onInteraction: (card: { interactionId: string }) => void cards.push(card),
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      const listener = h.interactionListeners.get('sess-new')!;
      const decisionPromise = listener({
        kind: 'ask_user_question',
        requestId: 'int-notice',
        questions: [{ question: '继续吗?', options: [{ label: '继续' }] }],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(cards).toHaveLength(1);
      // 卡片发出的同时过程区出现状态行: 挂起期间没有任何 agent 事件, 渠道那条消息会
      // 彻底静止, 而卡片可能根本不在这个会话里(群里的授权卡改投宿主私聊)。
      // 它只改已经在发的那条快照, 不新增任何渠道消息。
      // **文案按交互类型分**: 这是问答, 说"等待授权"就把它说成了权限请求。
      expect(emitted.at(-1)).toContain('等待回答');
      expect(emitted.at(-1)).not.toContain('等待授权');

      const { resolveHookInteraction } = await import('../interactions.js');
      expect(resolveHookInteraction('int-notice', 'ask:0')).toBe(true);
      await decisionPromise;
      // 授权通过、agent 继续干活: 后续快照不得再带那行状态(否则它会一直挂在过程区
      // 顶上, 与 review #844 里"重试提示留在终稿正上方"是同一个坑)。
      h.eventCbs.get('sess-new')!({
        type: 'tool_use',
        data: { toolUseId: 'after-1', toolName: 'Read', input: { file_path: '/tmp/a.ts' } },
      });
      await vi.advanceTimersByTimeAsync(1500);
      expect(emitted.at(-1)).toContain('读取 a.ts');
      expect(emitted.at(-1)).not.toContain('等待授权');

      h.eventCbs.get('sess-new')!({ type: 'done', data: null });
      await p;
    } finally {
      vi.useRealTimers();
    }
  });

  it('过程区状态行按交互类型分: 授权/问答/计划审阅各自措辞', async () => {
    vi.useFakeTimers();
    try {
      for (const [request, expected] of [
        [
          {
            kind: 'permission' as const,
            requestId: 'int-perm',
            toolName: 'file_change',
            input: {},
          },
          '等待授权',
        ],
        [
          {
            kind: 'plan_review' as const,
            requestId: 'int-plan',
            plan: '第一步…',
          },
          '等待审阅',
        ],
      ] as const) {
        fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
          makeInteractiveSession(opts.id ?? 'sess-x'),
        );
        const emitted: string[] = [];
        const runner = createMakerHookSessionRunner({ log });
        const p = runner.run(
          baseReq({
            onProgress: (t: string) => emitted.push(t),
            onInteraction: () => {},
          }),
        );
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
        const listener = h.interactionListeners.get('sess-new')!;
        void listener(request as never);
        await vi.advanceTimersByTimeAsync(0);
        expect(emitted.at(-1)).toContain(expected);
        h.eventCbs.get('sess-new')!({ type: 'done', data: null });
        await p.catch(() => undefined);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('待决交互期间的正常进展事件不得抹掉等待提示', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeInteractiveSession(opts.id ?? 'sess-x'),
      );
      const emitted: string[] = [];
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(
        baseReq({
          onProgress: (t: string) => emitted.push(t),
          onInteraction: () => {},
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      const listener = h.interactionListeners.get('sess-new')!;
      const pending = listener({
        kind: 'permission',
        requestId: 'int-progress',
        toolName: 'file_change',
        input: {},
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(emitted.at(-1)).toContain('等待授权');

      // 挂起期间 agent 的其它子任务照样吐事件。这些走的是 clearNotice ——
      // 若等待提示与瞬态 notice 共用一个字段, 每一条都会把它抹掉, 于是剩下的
      // 授权最长要等 30 分钟而过程区一个字都不提。
      const emit = h.eventCbs.get('sess-new')!;
      emit({ type: 'thinking', data: { blockId: 'b1', text: '再查一处引用' } });
      await vi.advanceTimersByTimeAsync(1500);
      expect(emitted.at(-1)).toContain('等待授权');

      emit({
        type: 'tool_use',
        data: { toolUseId: 'bg-1', toolName: 'Read', input: { file_path: '/tmp/bg.ts' } },
      });
      await vi.advanceTimersByTimeAsync(1500);
      expect(emitted.at(-1)).toContain('读取 bg.ts');
      expect(emitted.at(-1)).toContain('等待授权');

      emit({ type: 'text', data: { text: '我先读了这个文件' } });
      await vi.advanceTimersByTimeAsync(1500);
      expect(emitted.at(-1)).toContain('等待授权');

      // 收口后才摘掉
      const { resolveHookInteraction } = await import('../interactions.js');
      expect(resolveHookInteraction('int-progress', 'perm:allow')).toBe(true);
      await pending;
      emit({
        type: 'tool_use',
        data: { toolUseId: 'bg-2', toolName: 'Read', input: { file_path: '/tmp/after.ts' } },
      });
      await vi.advanceTimersByTimeAsync(1500);
      expect(emitted.at(-1)).toContain('读取 after.ts');
      expect(emitted.at(-1)).not.toContain('等待授权');

      emit({ type: 'done', data: null });
      await p;
    } finally {
      vi.useRealTimers();
    }
  });

  it('并发交互: 其中一个收口不摘掉状态行, 最后一个结束才摘', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeInteractiveSession(opts.id ?? 'sess-x'),
      );
      const emitted: string[] = [];
      const runner = createMakerHookSessionRunner({ log });
      const p = runner.run(
        baseReq({
          onProgress: (t: string) => emitted.push(t),
          onInteraction: () => {},
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // agent 并行发起两个交互: 各自独立挂起, 共用过程区那一行状态。**两者措辞不同**,
      // 这样"回落到仍在等的那条"表现为文字变化 —— 用 tool_use 逼快照反而不行:
      // 真实进展本身就会作废状态行(clearNotice), 那条断言对两种实现都成立。
      const listener = h.interactionListeners.get('sess-new')!;
      const first = listener({
        kind: 'permission',
        requestId: 'int-par-1',
        toolName: 'file_change',
        input: {},
      });
      const second = listener({
        kind: 'ask_user_question',
        requestId: 'int-par-2',
        questions: [{ question: '继续吗?', options: [{ label: '继续' }] }],
      });
      await vi.advanceTimersByTimeAsync(0);
      // 挂起时新卡片覆盖状态行 —— 最新那条(问答)在上。
      expect(emitted.at(-1)).toContain('等待回答');

      const { resolveHookInteraction } = await import('../interactions.js');
      expect(resolveHookInteraction('int-par-2', 'ask:0')).toBe(true);
      await second;
      await vi.advanceTimersByTimeAsync(1500);
      // 权限请求还在等 —— 状态行必须回落到它, 不能整行摘掉: 摘了群里的进度消息又变回
      // 静止, 而剩下那个交互最长要等 30 分钟。
      expect(emitted.at(-1)).toContain('等待授权');

      expect(resolveHookInteraction('int-par-1', 'perm:allow')).toBe(true);
      await first;
      h.eventCbs.get('sess-new')!({
        type: 'tool_use',
        data: { toolUseId: 'after-par', toolName: 'Read', input: { file_path: '/tmp/b.ts' } },
      });
      await vi.advanceTimersByTimeAsync(1500);
      expect(emitted.at(-1)).toContain('读取 b.ts');
      expect(emitted.at(-1)).not.toContain('等待');

      h.eventCbs.get('sess-new')!({ type: 'done', data: null });
      await p;
    } finally {
      vi.useRealTimers();
    }
  });

  it('并发交互的 notice 回退不是新消息边界，不折叠期间的 assistant 正文', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
        makeInteractiveSession(opts.id ?? 'sess-x'),
      );
      const runner = createMakerHookSessionRunner({ log });
      const pendingRun = runner.run(
        baseReq({
          onProgress: () => {},
          onInteraction: () => {},
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      const listener = h.interactionListeners.get('sess-new')!;
      const first = listener({
        kind: 'permission',
        requestId: 'int-boundary-1',
        toolName: 'file_change',
        input: {},
      });
      const second = listener({
        kind: 'ask_user_question',
        requestId: 'int-boundary-2',
        questions: [{ question: '继续吗?', options: [{ label: '继续' }] }],
      });
      await vi.advanceTimersByTimeAsync(0);

      const emit = h.eventCbs.get('sess-new')!;
      emit({ type: 'text', data: { text: '并行分支 A 已给出结果。', isFinal: true } });

      const { resolveHookInteraction } = await import('../interactions.js');
      expect(resolveHookInteraction('int-boundary-2', 'ask:0')).toBe(true);
      await second;
      // 这里只是状态行从「等待回答」回退到仍在等待的「等待授权」，不是新交互。
      emit({ type: 'text', data: { text: '并行分支 B 继续补充。', isFinal: true } });

      expect(resolveHookInteraction('int-boundary-1', 'perm:allow')).toBe(true);
      await first;
      emit({ type: 'done', data: null });

      const outcome = await pendingRun;
      expect(outcome.finalText).toBe(
        '并行分支 A 已给出结果。\n\n并行分支 B 继续补充。',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('ask 请求 -> 中央 Router 发卡 -> 按钮决策回流 resolve; 收口后释放 route', async () => {
    fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
      makeInteractiveSession(opts.id ?? 'sess-x'),
    );
    const cards: Array<{ interactionId: string; title: string; buttons: Array<{ id: string }> }> =
      [];
    const cancels: Array<{ interactionId: string; reason: string }> = [];
    const runner = createMakerHookSessionRunner({ log });
    const p = runner.run(
      baseReq({
        onInteraction: (card: {
          interactionId: string;
          title: string;
          buttons: Array<{ id: string }>;
        }) => void cards.push(card),
        onInteractionCancel: (interactionId: string, reason: string) =>
          void cancels.push({ interactionId, reason }),
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    // Session listener 始终由中央 Router 持有。
    const listener = h.interactionListeners.get('sess-new')!;
    expect(listener).toBeTypeOf('function');

    // 模型发起提问 -> 卡片经 onInteraction 发出
    const decisionPromise = listener({
      kind: 'ask_user_question',
      requestId: 'int-9',
      questions: [{ question: '继续重构吗?', options: [{ label: '继续' }, { label: '先停' }] }],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(cards).toHaveLength(1);
    expect(cards[0].interactionId).toBe('int-9');
    expect(cards[0].buttons.map((b) => b.id)).toEqual(['ask:0', 'ask:1']);

    // Slack 按钮回流(dispatcher 会调 resolveHookInteraction)
    const { resolveHookInteraction } = await import('../interactions.js');
    expect(resolveHookInteraction('int-9', 'ask:1')).toBe(true);
    await expect(decisionPromise).resolves.toEqual({
      kind: 'ask_user_question',
      answers: { '继续重构吗?': '先停' },
    });

    // 正常收口: 无未决交互, 不发 cancel；无需覆盖/归还 listener。
    h.eventCbs.get('sess-new')!({ type: 'done', data: null });
    const outcome = await p;
    expect(outcome.status).toBe('ok');
    expect(cancels).toHaveLength(0);
    expect(h.installDesktopInteractionListener).not.toHaveBeenCalled();
  });

  it('permission 请求出三按钮卡, 按钮回流 resolve(允许一次)', async () => {
    fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
      makeInteractiveSession(opts.id ?? 'sess-x'),
    );
    const cards: Array<{ interactionId: string; kind: string; buttons: Array<{ id: string }> }> =
      [];
    const runner = createMakerHookSessionRunner({ log });
    const p = runner.run(
      baseReq({
        onInteraction: (card: {
          interactionId: string;
          kind: string;
          buttons: Array<{ id: string }>;
        }) => void cards.push(card),
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const listener = h.interactionListeners.get('sess-new')!;
    const decisionPromise = listener({
      kind: 'permission',
      requestId: 'int-p',
      toolName: 'Bash',
      input: { command: 'rm -rf dist' },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe('permission');
    expect(cards[0].buttons.map((b) => b.id)).toEqual(['perm:allow', 'perm:always', 'perm:deny']);

    const { resolveHookInteraction } = await import('../interactions.js');
    expect(resolveHookInteraction('int-p', 'perm:allow')).toBe(true);
    await expect(decisionPromise).resolves.toEqual({ kind: 'permission', behavior: 'allow' });

    h.eventCbs.get('sess-new')!({ type: 'done', data: null });
    await p;
  });

  it('permission 未决时 turn 收口: 按默认拒绝收口并发 cancel', async () => {
    fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
      makeInteractiveSession(opts.id ?? 'sess-x'),
    );
    const cancels: Array<{ interactionId: string; reason: string }> = [];
    const runner = createMakerHookSessionRunner({ log });
    const p = runner.run(
      baseReq({
        onInteraction: () => undefined,
        onInteractionCancel: (interactionId: string, reason: string) =>
          void cancels.push({ interactionId, reason }),
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const listener = h.interactionListeners.get('sess-new')!;
    const decisionPromise = listener({
      kind: 'permission',
      requestId: 'int-pd',
      toolName: 'Bash',
      input: {},
    });
    h.eventCbs.get('sess-new')!({ type: 'done', data: null });
    await p;
    await expect(decisionPromise).resolves.toEqual({
      kind: 'permission',
      behavior: 'deny',
      reason: 'hook_interaction_timeout',
    });
    expect(cancels).toEqual([{ interactionId: 'int-pd', reason: '任务已结束, 此交互已失效' }]);
  });

  it('turn 收口时未决交互按默认自决并发 cancel(改写 server 卡片)', async () => {
    fakeMaker.createSession.mockImplementationOnce(async (opts: { id?: string }) =>
      makeInteractiveSession(opts.id ?? 'sess-x'),
    );
    const cancels: Array<{ interactionId: string; reason: string }> = [];
    const runner = createMakerHookSessionRunner({ log });
    const p = runner.run(
      baseReq({
        onInteraction: () => undefined,
        onInteractionCancel: (interactionId: string, reason: string) =>
          void cancels.push({ interactionId, reason }),
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const listener = h.interactionListeners.get('sess-new')!;
    const decisionPromise = listener({
      kind: 'ask_user_question',
      requestId: 'int-z',
      questions: [{ question: 'q?', options: [{ label: 'a' }] }],
    });

    // 交互还挂着, turn 先收口(如模型侧被 abort): 未决交互按默认收口
    h.eventCbs.get('sess-new')!({ type: 'done', data: null });
    const outcome = await p;
    expect(outcome.status).toBe('ok');
    await expect(decisionPromise).resolves.toEqual({ kind: 'ask_user_question', answers: {} });
    expect(cancels).toEqual([{ interactionId: 'int-z', reason: '任务已结束, 此交互已失效' }]);
  });
});

describe('permissionMode 落 createSession', () => {
  it('新建: 用 defaults 合成的权限档建会话', async () => {
    h.resolvedConfig.permissionMode = 'ask';
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(baseReq({}));
    expect(outcome.status).toBe('ok');
    expect(fakeMaker.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'ask' }),
    );
  });

  it('复用/接管: session meta 的权限档权威, options 不覆盖', async () => {
    fakeMaker.getSessionMeta.mockImplementationOnce(async () => ({
      workDir: 'D:/repo',
      model: 'meta-model',
      sdkSessionId: 'sdk-1',
      agentKind: 'claude-code' as const,
      permissionMode: 'ask' as const,
    }));
    const runner = createMakerHookSessionRunner({ log });
    // options 带 bypass 也不覆盖 meta 的 ask
    const outcome = await runner.run(
      baseReq({ sessionId: 'sess-old', isNew: false, permissionMode: 'bypassPermissions' }),
    );
    expect(outcome.status).toBe('ok');
    expect(fakeMaker.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'ask' }),
    );
  });

  it('chat 伪目录新建: workspaceKind=dialogue 透传给 createSession', async () => {
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(baseReq({ workspaceKind: 'dialogue' as const }));
    expect(outcome.status).toBe('ok');
    expect(fakeMaker.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceKind: 'dialogue' }),
    );
    // 普通目录新建不带该字段
    const outcome2 = await runner.run(baseReq({ sessionId: 'sess-new-2' }));
    expect(outcome2.status).toBe('ok');
    const lastCall = fakeMaker.createSession.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect('workspaceKind' in lastCall).toBe(false);
  });

  it('复用/接管: meta 未记录权限档时按历史默认 bypass', async () => {
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(baseReq({ sessionId: 'sess-old', isNew: false }));
    expect(outcome.status).toBe('ok');
    expect(fakeMaker.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'bypassPermissions' }),
    );
  });
});

describe('providerId(来源/供应商)贯通 —— issue #854 回归', () => {
  it('新建: 草稿默认来源经校验后传 createSession + 注入运行时 store + 广播前落库', async () => {
    h.resolvedConfig.providerId = 'xd';
    h.listProviders.mockResolvedValueOnce([connectedProvider('xd', [catalogModel('test-model')])]);
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(baseReq({}));

    expect(outcome.status).toBe('ok');
    expect(fakeMaker.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'xd' }),
    );
    expect(h.setSessionProvider).toHaveBeenCalledWith('sess-new', 'xd');
    // 落库必须在 sessions:created 广播之前 —— renderer 重拉才能读到非空来源
    const providerDbIdx = h.calls.indexOf('providerDb:sess-new:xd');
    const createdIdx = h.calls.indexOf('created:sess-new');
    expect(providerDbIdx).toBeGreaterThanOrEqual(0);
    expect(providerDbIdx).toBeLessThan(createdIdx);
  });

  it('新建: 草稿来源失效时回落到实际提供该模型的已连接来源', async () => {
    h.resolvedConfig.providerId = 'gone-provider';
    h.listProviders.mockResolvedValueOnce([connectedProvider('xd', [catalogModel('test-model')])]);
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(baseReq({}));

    expect(outcome.status).toBe('ok');
    expect(fakeMaker.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'xd' }),
    );
    expect(h.setSessionProvider).toHaveBeenCalledWith('sess-new', 'xd');
    expect(h.setSessionProviderIdInDb).toHaveBeenCalledWith('sess-new', 'xd');
  });

  it('新建: 默认仍是不可用 Opus 时,从唯一已连接 OpenAI 来源选可用模型并落具体 providerId', async () => {
    h.useActualDefaults = true;
    h.readImDefaultSettings.mockReturnValue({
      agentKind: 'claude-code',
      agents: {
        'claude-code': { providerId: null, model: 'claude-opus-4-8', effort: 'high' },
        codex: { providerId: null, model: 'gpt-5.6', effort: 'high' },
      },
    });
    h.listProviders.mockResolvedValueOnce([
      connectedProvider('openai', [catalogModel('chatgpt/gpt-5.6-sol', 'GPT-5.6')]),
    ]);
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(baseReq({}));

    expect(outcome.status).toBe('ok');
    expect(fakeMaker.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'claude-code',
        model: 'chatgpt/gpt-5.6-sol',
        providerId: 'openai',
      }),
    );
    expect(h.setSessionProvider).toHaveBeenCalledWith('sess-new', 'openai');
    expect(h.setSessionProviderIdInDb).toHaveBeenCalledWith('sess-new', 'openai');
    expect(h.listProviders).toHaveBeenCalledTimes(1);
  });

  it('官方 Telegram 新会话读取 global 默认设置，不与个人 Bot 的 telegram scope 混用', async () => {
    h.useActualDefaults = true;
    h.readImDefaultSettings.mockReturnValue({
      agentKind: 'claude-code',
      agents: {
        'claude-code': { providerId: null, model: 'test-model', effort: 'high' },
        codex: { providerId: null, model: 'gpt-5.6', effort: 'high' },
      },
    });
    h.listProviders.mockResolvedValueOnce([connectedProvider('xd', [catalogModel('test-model')])]);
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(
      baseReq({ source: { im: 'telegram', userText: 'hello' } }),
    );

    expect(outcome.status).toBe('ok');
    expect(h.readImDefaultSettings).toHaveBeenCalledWith(undefined);
  });

  it('新建: 当前无任何已连接来源时保持无 providerId(no-break)', async () => {
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(baseReq({}));

    expect(outcome.status).toBe('ok');
    const opts = fakeMaker.createSession.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect('providerId' in opts).toBe(false);
    expect(h.setSessionProvider).not.toHaveBeenCalled();
    expect(h.setSessionProviderIdInDb).not.toHaveBeenCalled();
  });

  it('复用/接管: sessions.provider_id 权威 -> 传 createSession + hydrate(不显式 set、不重复落库)', async () => {
    const { getSessionRowSnapshot } = await import('../../localDb/ipc/sessions.js');
    vi.mocked(getSessionRowSnapshot).mockResolvedValueOnce({
      status: 'active',
      title: null,
      userSendAt: 1,
      workingDir: 'D:/repo',
      workspaceKind: 'project',
      providerId: 'xd',
    });
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(baseReq({ sessionId: 'sess-old', isNew: false }));

    expect(outcome.status).toBe('ok');
    // 冷 resume 时 createSession 必须带上来源 —— agent 首轮凭证形态据此判断
    expect(fakeMaker.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'xd' }),
    );
    // hydrate 语义: 仅内存无条目时写, 不盖运行中会话刚切的值
    expect(h.hydrateSessionProvider).toHaveBeenCalledWith('sess-old', 'xd');
    expect(h.setSessionProvider).not.toHaveBeenCalled();
    // 行里本来就有, 不重复写库
    expect(h.setSessionProviderIdInDb).not.toHaveBeenCalled();
    // 复用路径不读供应商目录
    expect(h.listProviders).not.toHaveBeenCalled();
  });

  it('复用/接管: 旧会话 provider_id=NULL 时不传 providerId、hydrate(null)、不落库(no-break)', async () => {
    const { getSessionRowSnapshot } = await import('../../localDb/ipc/sessions.js');
    vi.mocked(getSessionRowSnapshot).mockResolvedValueOnce({
      status: 'active',
      title: null,
      userSendAt: 1,
      workingDir: 'D:/repo',
      workspaceKind: 'project',
      providerId: null,
    });
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(baseReq({ sessionId: 'sess-old', isNew: false }));

    expect(outcome.status).toBe('ok');
    // providerId=null 时 createSession 不带该字段(走默认路由)
    const opts = fakeMaker.createSession.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect('providerId' in opts).toBe(false);
    // hydrate 仍被调用(以 null 写入 store, 防后续误 hydrate 覆盖)
    expect(h.hydrateSessionProvider).toHaveBeenCalledWith('sess-old', null);
    // 不走显式 set(新建路径专属)
    expect(h.setSessionProvider).not.toHaveBeenCalled();
    // 不落库(行本来就是 null, 无需补写)
    expect(h.setSessionProviderIdInDb).not.toHaveBeenCalled();
    // 复用路径不读供应商目录
    expect(h.listProviders).not.toHaveBeenCalled();
  });
});

describe('extractToolResultImageUrls 的兜底账本回落(xdt_media_produced)', () => {
  const IMG = `cindy-media://blobs/${'d'.repeat(64)}.png`;
  const MP3 = `cindy-media://blobs/${'e'.repeat(64)}.mp3`;

  it('意识未声明媒体字段时,从 xdt_media_produced 接走图片(过滤非图)', () => {
    const text = JSON.stringify({ ok: true, xdt_media_produced: [IMG, MP3] });
    expect(extractToolResultImageUrls(text)).toEqual([IMG]);
  });

  it('声明字段与账本并存时合并去重', () => {
    const text = JSON.stringify({ ok: true, xdt_image_urls: [IMG], xdt_media_produced: [IMG] });
    expect(extractToolResultImageUrls(text)).toEqual([IMG]);
  });

  it('_xdt_render_image:false 哨兵优先,全部不外发', () => {
    const text = JSON.stringify({ ok: true, xdt_media_produced: [IMG], _xdt_render_image: false });
    expect(extractToolResultImageUrls(text)).toEqual([]);
  });
});

describe('watchContinuation: 观察桌面端续跑并回流', () => {
  /** 不自动 done 的 fake session(测试手动驱动事件流)。 */
  function makeManualSession(id: string) {
    return {
      ...makePermissionModeFake(),
      id,
      workDir: 'D:/repo',
      onEvent(cb: (ev: { type: string; data: unknown }) => void) {
        h.eventCbs.set(id, cb);
        return () => {
          h.eventCbs.delete(id);
        };
      },
      onStatusChange(cb: (status: 'active' | 'aborting' | 'closed' | 'error') => void) {
        h.statusCbs.set(id, cb);
        return () => {
          h.statusCbs.delete(id);
        };
      },
    };
  }

  function watchReq(overrides?: Partial<Record<string, unknown>>) {
    const events: string[] = [];
    const ends: Array<{ status: string; finalText: string; errorMessage: string | null }> = [];
    const req = {
      sessionId: 'sess-live',
      workingDir: 'D:/repo',
      onClaim: () => events.push('claim'),
      onProgress: (text: string) => events.push(`progress:${text}`),
      onEnd: (o: { status: string; finalText: string; errorMessage: string | null }) => {
        events.push(`end:${o.status}`);
        ends.push(o);
      },
      onAbandon: () => events.push('abandon'),
      ...overrides,
    };
    return { req, events, ends };
  }

  async function flush(times = 30): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve();
  }

  it('终态回调抛错时仍拆监听并 settle finished', async () => {
    const session = makeManualSession('sess-terminal-callback');
    const observer = observeHookTurn(session as never, {
      onTurnTerminal: () => {
        throw new Error('restore failed');
      },
      onSilentStopSettled: () => () => {},
      log,
    });

    h.eventCbs.get('sess-terminal-callback')!({ type: 'done', data: null });

    await expect(observer.finished).resolves.toBeUndefined();
    expect(h.eventCbs.has('sess-terminal-callback')).toBe(false);
    expect(h.statusCbs.has('sess-terminal-callback')).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      '[hook-runner] onTurnTerminal failed: restore failed',
    );
  });

  it('交互边界会把交互前短旁白折叠，不与交互后的最终答复连成一段', async () => {
    const session = makeManualSession('sess-interaction-boundary');
    const observer = observeHookTurn(session as never, {
      onSilentStopSettled: () => () => {},
      log,
    });
    const cb = h.eventCbs.get('sess-interaction-boundary')!;
    cb({ type: 'text', data: { text: '我先确认一下。', isFinal: true } });
    observer.markInteractionBoundary();
    observer.setNotice('等待你的确认');
    cb({ type: 'text', data: { text: '确认后结论。', isFinal: true } });
    cb({ type: 'done', data: null });

    await expect(observer.finished).resolves.toBeUndefined();
    expect(observer.finalText()).toBe('确认后结论。');
  });

  it('会话不在进程里 -> 立刻 onAbandon(dispatcher 会把记账还回去), 撤销函数不炸', () => {
    // 本调用发生在 vendor dispatch **之前**, live session 正常必然已就绪, 所以这是
    // 兜底而非常规路径。放弃是安全方向, 且 dispatcher 收到 onAbandon 会还记账 ——
    // 不需要在这里等任何窗口(等待发生在"意图 -> dispatch"那一段, 由 dispatch 信号收口)。
    fakeMaker.getSession.mockReturnValue(undefined);
    const runner = createMakerHookSessionRunner({ log });
    const { req, events } = watchReq();
    const cancel = runner.watchContinuation!(req as never);
    expect(events).toEqual(['abandon']);
    expect(() => cancel()).not.toThrow();
  });

  it('live session 跑在已撤销的目录里 -> 不观察(记账里的目录不算权威)', () => {
    // 记账存的是失败那一轮的**持久化**目录, 而 live 实例可能仍跑在搬迁前的旧目录。
    // 旧目录被移出映射、新目录仍在时, 只查记账就会放行 —— 续跑的输出与文件会从一个
    // 已撤销的目录回流到渠道。run() 早已有这道校验(PR #733), 续跑路径必须同款。
    fakeMaker.getSession.mockReturnValueOnce(makeManualSession('sess-live'));
    const runner = createMakerHookSessionRunner({ log });
    const { req, events } = watchReq();
    const cancel = runner.watchContinuation!({
      ...(req as Record<string, unknown>),
      isDirAuthorized: (dir: string) => dir !== 'D:/repo',
    } as never);
    expect(events).toEqual(['abandon']);
    expect(() => cancel()).not.toThrow();
  });

  it('挂上即认领; 收口带最终正文', async () => {
    // 归属已由 clientId 在 dispatch 前确认(见 uiContinuationSignal), 所以不必再等
    // 首个事件来判断"这一轮是不是目标轮" —— 那套等待恰恰是误认的来源。
    fakeMaker.getSession.mockReturnValueOnce(makeManualSession('sess-live'));
    const runner = createMakerHookSessionRunner({ log });
    const { req, events, ends } = watchReq();
    runner.watchContinuation!(req as never);
    expect(events).toEqual(['claim']);

    const cb = h.eventCbs.get('sess-live')!;
    cb({ type: 'text', data: { text: '接着干', isFinal: false } });
    cb({ type: 'text', data: { text: '完成了。', isFinal: true } });
    cb({ type: 'done', data: null });
    await flush();
    expect(events.at(-1)).toBe('end:ok');
    // isFinal 是**逐条**消息的完成信号, 不是整个 turn 的终稿 —— 它把该条追加进
    // 已定稿段, 不整体替换累积文本。这里没带 source, 走保守的前缀启发式:
    // 终稿不以已流增量开头 -> 接在后面(而不是把「接着干」丢掉)。
    expect(ends[0]?.finalText).toBe('接着干完成了。');
    expect(ends[0]?.errorMessage).toBeNull();
  });

  it('续跑轮同样吃到多消息累积语义: 两条 claude 消息都在, 不只剩最后一条', async () => {
    // run() 与 watchContinuation 共用 observeHookTurn, 所以 2026-07-28 那个
    // 「先回一句 → 思考 → 终答 只剩最后一条」的修订对续跑轮自动生效。抽取若
    // 退回旧的"isFinal 整体替换", 这个用例会立刻红 —— 它就是防漂移的锁。
    fakeMaker.getSession.mockReturnValueOnce(makeManualSession('sess-live'));
    const runner = createMakerHookSessionRunner({ log });
    const { req, ends } = watchReq();
    runner.watchContinuation!(req as never);

    const cb = h.eventCbs.get('sess-live')!;
    cb({
      type: 'text',
      source: 'claude-code',
      agentMeta: { uuid: 'm1' },
      data: { text: '先回一句。', isFinal: true },
    });
    cb({
      type: 'text',
      source: 'claude-code',
      agentMeta: { uuid: 'm2' },
      data: { text: '这是终答。', isFinal: true },
    });
    cb({ type: 'done', data: null });
    await flush();
    // 不同消息(uuid 不同)之间空行分隔; 两条都保留
    expect(ends[0]?.finalText).toBe('先回一句。\n\n这是终答。');
  });

  it('Pi message_end 全文替换流式尾部，不重复拼接多文本块', async () => {
    fakeMaker.getSession.mockReturnValueOnce(makeManualSession('sess-live'));
    const runner = createMakerHookSessionRunner({ log });
    const { req, ends } = watchReq();
    runner.watchContinuation!(req as never);

    const cb = h.eventCbs.get('sess-live')!;
    cb({ type: 'text', source: 'pi', data: { text: '第一段', isFinal: false } });
    cb({ type: 'text', source: 'pi', data: { text: '第二段', isFinal: false } });
    cb({
      type: 'text',
      source: 'pi',
      data: { text: '第一段\n\n第二段', isFinal: true },
    });
    cb({ type: 'done', data: null });
    await flush();

    expect(ends[0]?.finalText).toBe('第一段\n\n第二段');
  });

  it('续跑轮自己失败 -> onEnd(error) 带错误信息', async () => {
    fakeMaker.getSession.mockReturnValueOnce(makeManualSession('sess-live'));
    const runner = createMakerHookSessionRunner({ log });
    const { req, events, ends } = watchReq();
    runner.watchContinuation!(req as never);
    const cb = h.eventCbs.get('sess-live')!;
    cb({ type: 'error', data: { message: '又崩了', isTerminal: true } });
    await flush();
    expect(events).toEqual(['claim', 'end:error']);
    expect(ends[0]?.errorMessage).toBe('又崩了');
    expect(ends[0]?.finalText).toBe('');
  });

  it('认领之后被撤销 -> 必须收口(否则渠道消息停在假的进行中)', async () => {
    fakeMaker.getSession.mockReturnValueOnce(makeManualSession('sess-live'));
    const runner = createMakerHookSessionRunner({ log });
    const { req, events, ends } = watchReq();
    const cancel = runner.watchContinuation!(req as never);
    h.eventCbs.get('sess-live')!({ type: 'text', data: { text: 'x', isFinal: false } });
    expect(events).toEqual(['claim']);

    cancel();
    await flush();
    expect(events.at(-1)).toBe('end:error');
    expect(ends[0]?.errorMessage).toContain('cancelled');
    // 幂等: 再撤一次不重复收口
    cancel();
    await flush();
    expect(events.filter((e) => e.startsWith('end:'))).toHaveLength(1);
  });

  it('被撤销 -> 以 error 收口(渠道消息已改成进行中, 不能就这么撂下)', async () => {
    // 认领现在是立即的, 所以撤销必然发生在认领之后: 渠道那条消息已经被改成"进行中",
    // 静默退场会把它永久留在假的进行中 —— 必须发一条终态帧收口。
    fakeMaker.getSession.mockReturnValueOnce(makeManualSession('sess-live'));
    const runner = createMakerHookSessionRunner({ log });
    const { req, events, ends } = watchReq();
    const cancel = runner.watchContinuation!(req as never);
    expect(events).toEqual(['claim']);
    cancel();
    await flush();
    expect(events).toEqual(['claim', 'end:error']);
    expect(ends[0]?.errorMessage).toBe('hook continuation cancelled');
  });

  it('长 turn 不被误杀: 几分钟不出事件也不该收口', async () => {
    // 曾经有过一条 2 分钟"空转"超时, 但它从不在有事件时清除 —— 任何跑过 2 分钟的
    // 正常续跑都会被强制判成 error 并把那条错误写进渠道。现在 hook 侧不设任何
    // 时长/静默上限, 兜底交给 maker-core Session 的 turn stall 看门狗。
    vi.useFakeTimers();
    try {
      fakeMaker.getSession.mockReturnValueOnce(makeManualSession('sess-live'));
      const runner = createMakerHookSessionRunner({ log });
      const { req, events } = watchReq();
      runner.watchContinuation!(req as never);
      expect(events).toEqual(['claim']);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(events).toEqual(['claim']);
      expect(h.eventCbs.has('sess-live')).toBe(true);

      // 正常收口照样成立。
      h.eventCbs.get('sess-live')!({ type: 'done', data: null });
      await vi.advanceTimersByTimeAsync(1);
      expect(events.at(-1)).toBe('end:ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('持续有事件就一直等下去: 远超旧的 1 小时总时长上限也不收口', async () => {
    // 用户诉求(2026-08-01): 只要 agent 在持续工作、持续输出, 就不要砍。旧实现
    // 是总时长硬超时, 一个跑了一小时且仍在出结果的任务会被拦腰截断, 用户什么
    // 都拿不到 —— 而那恰恰是最值得等的那类任务。
    vi.useFakeTimers();
    try {
      fakeMaker.getSession.mockReturnValueOnce(makeManualSession('sess-live'));
      const runner = createMakerHookSessionRunner({ log });
      const { req, events } = watchReq();
      runner.watchContinuation!(req as never);

      // 每 5 分钟来一个事件, 连续 2 小时 —— 远超旧的 1 小时总时长上限。
      for (let i = 0; i < 24; i++) {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        h.eventCbs.get('sess-live')!({
          type: 'text',
          data: { text: `第 ${i} 段`, isFinal: false },
        });
      }
      // 两小时里没有任何收口 —— 期间的 progress 照常发。
      expect(events.filter((e) => e.startsWith('end'))).toEqual([]);
      expect(h.eventCbs.has('sess-live')).toBe(true);

      h.eventCbs.get('sess-live')!({ type: 'done', data: null });
      await vi.advanceTimersByTimeAsync(1);
      expect(events.at(-1)).toBe('end:ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('彻底静默不由 hook 侧自行收口: 兜底交给 maker-core 的 turn stall 看门狗', async () => {
    // hook 侧刻意没有自己的静默定时器(PR #1272 review): maker-core 的看门狗会
    // 排除"等用户回应交互"和"后台任务在跑"这两种合法静默、按分片扣掉合盖睡眠、
    // 触发时真的 abort 这一轮。在这里另起一个裸 setTimeout 只会更早、更笨地开火,
    // 而且只 reject 观察者、不 abort 底层 turn —— 渠道报错了 agent 还在跑。
    vi.useFakeTimers();
    try {
      fakeMaker.getSession.mockReturnValueOnce(makeManualSession('sess-live'));
      const runner = createMakerHookSessionRunner({ log });
      const { req, events } = watchReq();
      runner.watchContinuation!(req as never);

      await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
      expect(events).toEqual(['claim']);
      expect(h.eventCbs.has('sess-live')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('会话直接死掉(无终态事件)也收口: 状态判据兜住事件流兜不住的那条路', async () => {
    // SDK handle 的事件迭代器抛错 / 自然结束时, maker-core 只 setStatus('error' /
    // 'closed') 并**主动清掉** stall 看门狗, 不 fan out 任何终态事件 —— 而看门狗
    // 本身也只在 status 仍是 'active' 时开火。少了状态订阅, observer 永远不 settle:
    // 渠道请求结束不了、同 session 后续消息持续排队、finalizeInteractions 也跑不到
    // (PR #1272 review 指出)。判据是**状态**不是时间, 所以不会误杀合法静默。
    fakeMaker.getSession.mockReturnValueOnce(makeManualSession('sess-live'));
    const runner = createMakerHookSessionRunner({ log });
    const { req, events, ends } = watchReq();
    runner.watchContinuation!(req as never);
    expect(events).toEqual(['claim']);

    h.statusCbs.get('sess-live')!('closed');
    await flush();
    expect(events.at(-1)).toBe('end:error');
    expect(ends[0]?.errorMessage).toContain('without a terminal event');
    expect(h.eventCbs.has('sess-live')).toBe(false);
  });

  it('中途的非终态状态不收口: aborting / active 只是过程', async () => {
    // abort 往返期间会短暂进 aborting 再回 active(见 maker-core Session.abort),
    // 那不是会话死亡。只认 closed / error, 否则一次用户 Stop 的往返就会误收口。
    fakeMaker.getSession.mockReturnValueOnce(makeManualSession('sess-live'));
    const runner = createMakerHookSessionRunner({ log });
    const { req, events } = watchReq();
    runner.watchContinuation!(req as never);

    h.statusCbs.get('sess-live')!('aborting');
    h.statusCbs.get('sess-live')!('active');
    await flush();
    expect(events).toEqual(['claim']);

    h.eventCbs.get('sess-live')!({ type: 'done', data: null });
    await flush();
    expect(events.at(-1)).toBe('end:ok');
  });

  it('stall 看门狗的终态 error 到达时收口: 槽位得以释放', async () => {
    // 这才是那条"不依赖服务端连接的本地出口": maker-core 的看门狗零事件到期后
    // fan out 终态 error, 观察器对终态 error 本来就收口, execute() 于是能走到
    // running.delete() —— 与控制连接是否还在无关。
    fakeMaker.getSession.mockReturnValueOnce(makeManualSession('sess-live'));
    const runner = createMakerHookSessionRunner({ log });
    const { req, events, ends } = watchReq();
    runner.watchContinuation!(req as never);
    expect(events).toEqual(['claim']);

    h.eventCbs.get('sess-live')!({
      type: 'error',
      data: {
        message: 'This turn produced no activity at all for 45 minutes',
        isTerminal: true,
        reason: 'turn_no_event_timeout',
      },
    });
    await flush();
    expect(events.at(-1)).toBe('end:error');
    expect(ends[0]?.errorMessage).toContain('no activity');
    expect(h.eventCbs.has('sess-live')).toBe(false);
  });
});

describe('hook turn change-set anchor', () => {
  it('uses the durable accepted user message client id', async () => {
    const runner = createMakerHookSessionRunner({ log });
    const outcome = await runner.run(baseReq({}));

    expect(outcome.status).toBe('ok');
    const [, message] = h.createMessage.mock.calls[0] as unknown as [
      string,
      { clientId: string },
    ];
    expect(h.beginTurnChangeSetAtDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sess-new' }),
      message.clientId,
    );
    expect(h.calls.indexOf('createMessage')).toBeLessThan(
      h.calls.indexOf(`beginChangeSet:sess-new:${message.clientId}`),
    );
  });
});
