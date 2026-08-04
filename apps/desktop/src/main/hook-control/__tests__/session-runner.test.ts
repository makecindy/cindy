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
import type { Effort } from '@cindy/maker-core';
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
    eventCbs: new Map<
      string,
      (ev: {
        type: string;
        data: unknown;
        source?: string;
        agentMeta?: Record<string, unknown>;
      }) => void
    >(),
    /** 每个 fake session 被装上的 interaction listener(交互测试驱动用)。 */
    interactionListeners: new Map<string, (req: unknown) => Promise<unknown>>(),
    headlessDuringSend: [] as boolean[],
    headlessAfterAccepted: [] as boolean[],
    installDesktopInteractionListener: vi.fn(),
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
    isTerminalAgentErrorEvent: actual.isTerminalAgentErrorEvent,
    parseOverloadError: actual.parseOverloadError,
    parseOverloadRetryProgress: actual.parseOverloadRetryProgress,
  };
});
vi.mock('../../device-link/broadcast-tap.js', () => ({
  tapWindowBroadcast: h.tapWindowBroadcast,
}));
vi.mock('../../maker-ipc/register.js', () => ({
  wireSessionToIpc: vi.fn(),
  isSessionInTurn: () => false,
  installDesktopInteractionListener: h.installDesktopInteractionListener,
  noteSilentStopUserSend: vi.fn(),
  onSilentStopSettled: vi.fn(() => () => {}),
}));
vi.mock('../../maker-host/send-outcome.js', () => ({
  toDesktopSessionDispatchOutcome: () => ({ dispatched: true as const }),
}));
vi.mock('../../localDb/ipc/messages.js', () => ({
  createMessage: h.createMessage,
}));
vi.mock('../../localDb/ipc/sessions.js', () => ({
  getSessionRowSnapshot: vi.fn(async () => null),
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

/** fake maker: createSession 返回"send 即接受、随后立刻 done"的会话。 */
function makeFakeSession(id: string) {
  return {
    id,
    workDir: 'D:/repo',
    onEvent(cb: (ev: { type: string; data: unknown }) => void) {
      h.eventCbs.set(id, cb);
      return () => {
        h.eventCbs.delete(id);
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
      ): Promise<unknown> => {
        h.headlessDuringSend.push(isHeadlessGhostSetupTurn(id));
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
  getCapabilities: vi.fn(() => ({ availableModels: [], permissionModes: [] })),
};

vi.mock('../../maker-host/index.js', () => ({
  getMaker: () => fakeMaker,
}));

import { createMakerHookSessionRunner, extractToolResultImageUrls } from '../session-runner.js';
import { buildHookPromptNote, SLACK_HOOK_PROMPT_NOTE } from '../outbound.js';
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
});

describe('hook session 精确接管边界', () => {
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

  it('Telegram 新会话使用 provider-aware 标记、提示和持久化来源', async () => {
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
    expect(h.setSessionSourceInDb).toHaveBeenCalledWith('sess-new', 'telegram');
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
  /** 不自动 done 的 fake session: 测试手动驱动事件流。 */
  function makeManualSession(id: string) {
    return {
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

  it('多消息 turn: isFinal 逐条追加不整体替换, 先答一句再思考再终答两段都保留', async () => {
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
      // 两段都在, 且以定稿顺序拼接 —— 整体替换语义会丢掉其中一段。
      expect(outcome.finalText).toContain('我正在追溯');
      expect(outcome.finalText).toContain('PR #527');
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
          laneKind: 'group',
          onProgress: (text: string) => emitted.push(text),
        }),
      );
      await flush();
      const cb = h.eventCbs.get('sess-new')!;

      // 与 DM(answer-only)不同: 群 lane 只有工具活动、还没有正文时,
      // 也要发时间线, 群成员能看到"正在干什么"。
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

  it('thinking/tool_use/text 驱动友好快照,过程文字持续保留;done 后停止', async () => {
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

      // 收口: done 之后即使时间继续流逝也不再发射
      cb({ type: 'done', data: null });
      await vi.advanceTimersByTimeAsync(20_000);
      const outcome = await p;
      expect(outcome.status).toBe('ok');
      expect(outcome.finalText).toBe('结论是……');
      expect(emitted).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Telegram draft 只流式输出正文，不把会重排的 thinking/tool timeline 塞进 Rich Message', async () => {
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
          onProgress: (text: string) => emitted.push(text),
        }),
      );
      await flush();

      const cb = h.eventCbs.get('sess-new')!;
      cb({
        type: 'tool_use',
        data: { toolUseId: 'read-1', toolName: 'Read', input: { file_path: '/repo/a.ts' } },
      });
      cb({ type: 'thinking', data: { stage: 'final', blockId: 't-1', text: '检查实现' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(emitted).toEqual([]);

      cb({ type: 'text', data: { text: '**结论**', isFinal: false } });
      await vi.advanceTimersByTimeAsync(0);
      expect(emitted).toEqual(['**结论**']);

      // Later activity-only ticks must not resend or rewrite the same draft.
      cb({
        type: 'tool_use',
        data: { toolUseId: 'test-1', toolName: 'Bash', input: { command: 'pnpm test' } },
      });
      await vi.advanceTimersByTimeAsync(6_500);
      expect(emitted).toEqual(['**结论**']);

      cb({ type: 'text', data: { text: '已完成。', isFinal: false } });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(emitted).toEqual(['**结论**', '**结论**已完成。']);

      cb({ type: 'done', data: null });
      await p;
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
      id,
      workDir: 'D:/repo',
      onEvent(cb: (ev: { type: string; data: unknown }) => void) {
        h.eventCbs.set(id, cb);
        return () => {
          h.eventCbs.delete(id);
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

  it('Telegram 草稿在零正文时也给出重试提示, 有正文后只发正文', async () => {
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

      cb({
        type: 'error',
        data: { message: 'model is at capacity (auto-retry 1/4)', isTerminal: false },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(emitted).toEqual(['模型服务繁忙，正在自动重试（1/4）…']);

      cb({ type: 'text', data: { text: '结论。', isFinal: false } });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(emitted.at(-1)).toBe('结论。');

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
      id,
      workDir: 'D:/repo',
      onEvent(cb: (ev: { type: string; data: unknown }) => void) {
        h.eventCbs.set(id, cb);
        return () => {
          h.eventCbs.delete(id);
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

  it('长 turn 不被误杀: 几分钟不出事件也不该收口(兜底只有硬超时)', async () => {
    // 曾经有过一条 2 分钟"空转"超时, 但它从不在有事件时清除 —— 任何跑过 2 分钟的
    // 正常续跑都会被强制判成 error 并把那条错误写进渠道。现在兜底与 run() 一致,
    // 只保留 1 小时硬超时: 认领之后这一轮已经在跑, 长 turn 几分钟不出事件很正常
    // (或只出被本观察器忽略的账号级事件)。
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

  it('彻底静默的一轮由硬超时收口, 摘掉监听', async () => {
    vi.useFakeTimers();
    try {
      fakeMaker.getSession.mockReturnValueOnce(makeManualSession('sess-live'));
      const runner = createMakerHookSessionRunner({ log });
      const { req, events, ends } = watchReq();
      runner.watchContinuation!(req as never);

      await vi.advanceTimersByTimeAsync(60 * 60_000 + 1);
      expect(events).toEqual(['claim', 'end:error']);
      expect(ends[0]?.errorMessage).toContain('hard timeout');
      expect(h.eventCbs.has('sess-live')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
