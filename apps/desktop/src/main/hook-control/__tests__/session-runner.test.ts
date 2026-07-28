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
    eventCbs: new Map<string, (ev: { type: string; data: unknown }) => void>(),
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
vi.mock('@cindy/maker-core', () => ({
  isTerminalAgentErrorEvent: (ev: { type: string }) => ev.type === 'error',
}));
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
    onEvent(cb: (ev: { type: string; data: unknown }) => void) {
      h.eventCbs.set(id, cb);
      return () => {
        h.eventCbs.delete(id);
      };
    },
    send: vi.fn(
      async (_msg: unknown, opts: { onAccepted?: () => Promise<void> }): Promise<unknown> => {
        h.headlessDuringSend.push(isHeadlessGhostSetupTurn(id));
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
      onEvent(cb: (ev: { type: string; data: unknown }) => void) {
        h.eventCbs.set(id, cb);
        return () => {
          h.eventCbs.delete(id);
        };
      },
      send: vi.fn(async (_msg: unknown, opts: { onAccepted?: () => Promise<void> }) => {
        await opts.onAccepted?.();
        return {};
      }),
    };
  }

  async function flush(times = 30): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve();
  }

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

describe('交互卡链路(interaction listener 覆盖)', () => {
  /** 带 setInteractionListener 的 fake session(不自动 done)。 */
  function makeInteractiveSession(id: string) {
    return {
      id,
      onEvent(cb: (ev: { type: string; data: unknown }) => void) {
        h.eventCbs.set(id, cb);
        return () => {
          h.eventCbs.delete(id);
        };
      },
      setInteractionListener(listener: (req: unknown) => Promise<unknown>) {
        h.interactionListeners.set(id, listener);
      },
      send: vi.fn(async (_msg: unknown, opts: { onAccepted?: () => Promise<void> }) => {
        await opts.onAccepted?.();
        return {};
      }),
    };
  }

  it('ask 请求 -> 发卡回调 -> 按钮决策回流 resolve; 收口后归还桌面 listener', async () => {
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

    // hook listener 已覆盖桌面版
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

    // 正常收口: 无未决交互, 不发 cancel, 桌面 listener 归还
    h.eventCbs.get('sess-new')!({ type: 'done', data: null });
    const outcome = await p;
    expect(outcome.status).toBe('ok');
    expect(cancels).toHaveLength(0);
    expect(h.installDesktopInteractionListener).toHaveBeenCalledTimes(1);
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
