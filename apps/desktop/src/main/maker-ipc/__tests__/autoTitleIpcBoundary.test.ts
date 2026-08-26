/**
 * `maker:auto-title` 的授权边界与 payload 校验。
 *
 * 该 handler 会改写会话标题、并可能触发一次付费模型调用,属于新增特权入口:
 * 按 docs/dev-rules/electron-security-and-process-boundaries.md §5,执行副作用前
 * 必须做 sender 断言 + 运行期结构/长度/枚举校验(TS 类型不等于运行期校验)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TitleOneShotResult } from '../../maker-host/title-one-shot.js';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  trusted: true,
  run: vi.fn(async (_request: unknown) => {
    void _request;
    return { applied: true, done: true };
  }),
  regenerateMaterial: vi.fn(
    async (
      _sessionId: string,
      _limit: number,
      _latestTurnIsInFlight: boolean | (() => boolean),
    ) => {
      void _sessionId;
      void _limit;
      void _latestTurnIsInFlight;
      return {
        opening: { text: '原始需求', createdAt: 1, rowid: 1 },
        recent: [{ role: 'user' as const, text: '原始需求', createdAt: 1, rowid: 1 }],
      };
    },
  ),
  generateTitle: vi.fn(async (_request: unknown) => {
    void _request;
    return '任务标题';
  }),
  generateTitleResult: vi.fn(async (_request: unknown): Promise<TitleOneShotResult> => {
    void _request;
    return { status: 'ok', title: '任务标题' };
  }),
  drainPersistQueue: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: vi.fn() }));
vi.mock('../../localDb/latestMessageText.js', () => ({
  latestMessage: vi.fn(),
  latestMessageText: vi.fn(),
  regenerateTitleMaterial: h.regenerateMaterial,
}));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: vi.fn(),
}));
vi.mock('../../maker-host/title-one-shot.js', () => ({
  generateTitleViaProvider: h.generateTitle,
  generateTitleViaProviderResult: h.generateTitleResult,
}));
vi.mock('../../utility-model/auxiliary-model-settings-store.js', () => ({
  readAuxiliaryModelSelection: vi.fn(() => null),
}));
vi.mock('../../messagePersistBroadcaster.js', () => ({
  drainPersistQueue: h.drainPersistQueue,
}));
vi.mock('../sessionAutoTitle.js', () => ({ runSessionAutoTitle: h.run }));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: () => {
    if (!h.trusted) {
      const err = new Error('[PERMISSION_DENIED] 此操作只能从 Cindy 主页面发起');
      throw err;
    }
  },
}));

import { registerMakerTitleIpc } from '../title.js';
import { getDbClient } from '../../localDb/client/current.js';
import { runDeviceLinkInvokeContext } from '../../device-link/invoke-context.js';

const EVENT = {} as Electron.IpcMainInvokeEvent;

function invoke(request: unknown): Promise<unknown> {
  const handler = h.handlers.get('maker:auto-title');
  if (!handler) throw new Error('auto-title handler not registered');
  return Promise.resolve(handler(EVENT, request));
}

function invokeGenerate(request: unknown): Promise<unknown> {
  const handler = h.handlers.get('maker:generate-title');
  if (!handler) throw new Error('generate-title handler not registered');
  return Promise.resolve(handler(EVENT, request));
}

function invokeRegenerateRequest(request: unknown): Promise<unknown> {
  const handler = h.handlers.get('maker:regenerate-title');
  if (!handler) throw new Error('regenerate-title handler not registered');
  return Promise.resolve(handler(EVENT, request));
}

function invokeRegenerate(sessionId: string): Promise<unknown> {
  return invokeRegenerateRequest({ sessionId });
}

function invokeFromDeviceLink(
  channel: string,
  invokeHandler: () => Promise<unknown>,
): Promise<unknown> {
  return runDeviceLinkInvokeContext({ controllerDeviceId: 'controller-1', channel }, invokeHandler);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.trusted = true;
  h.run.mockResolvedValue({ applied: true, done: true });
  h.regenerateMaterial.mockClear();
  h.generateTitle.mockClear();
  h.generateTitleResult.mockReset();
  h.generateTitleResult.mockResolvedValue({ status: 'ok', title: '任务标题' });
  h.drainPersistQueue.mockReset();
  h.drainPersistQueue.mockResolvedValue(undefined);
  vi.mocked(getDbClient).mockReturnValue({
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ agentKind: 'codex' }],
          }),
        }),
      }),
    },
  } as unknown as ReturnType<typeof getDbClient>);
  registerMakerTitleIpc();
});

describe('maker:regenerate-title — 当前 turn 状态', () => {
  it('status idle 后仍捕获 pending completion，并在 drain 期间 terminal 到达时继续过滤未封存 Assistant', async () => {
    h.handlers.clear();
    let pendingCompletion = true;
    let resolveDrain!: () => void;
    h.drainPersistQueue.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDrain = () => {
            pendingCompletion = false;
            resolve();
          };
        }),
    );
    const isSessionTurnPendingCompletion = vi.fn(() => pendingCompletion);
    registerMakerTitleIpc({ isSessionTurnPendingCompletion });

    const result = invokeRegenerate('s-running');
    await vi.waitFor(() => expect(h.drainPersistQueue).toHaveBeenCalledOnce());
    expect(h.regenerateMaterial).not.toHaveBeenCalled();
    resolveDrain();
    await expect(result).resolves.toEqual({ title: '任务标题' });

    expect(isSessionTurnPendingCompletion).toHaveBeenCalledTimes(1);
    expect(isSessionTurnPendingCompletion).toHaveBeenCalledWith('s-running');
    expect(h.regenerateMaterial).toHaveBeenCalledWith(
      's-running',
      expect.any(Number),
      expect.any(Function),
    );
  });

  it('terminal 已到时先等待 pending seal 落库，再按 completed 状态读取素材', async () => {
    h.handlers.clear();
    let resolveDrain!: () => void;
    h.drainPersistQueue.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDrain = resolve;
        }),
    );
    const isSessionTurnPendingCompletion = vi.fn(() => false);
    registerMakerTitleIpc({ isSessionTurnPendingCompletion });

    const result = invokeRegenerate('s-completed');
    await vi.waitFor(() => expect(h.drainPersistQueue).toHaveBeenCalledOnce());
    expect(h.regenerateMaterial).not.toHaveBeenCalled();
    resolveDrain();
    await expect(result).resolves.toEqual({ title: '任务标题' });

    expect(isSessionTurnPendingCompletion).toHaveBeenCalledTimes(2);
    expect(h.regenerateMaterial).toHaveBeenCalledWith(
      's-completed',
      expect.any(Number),
      expect.any(Function),
    );
  });

  it('drain 期间新 turn 启动时以后置快照过滤新一轮未封存 Assistant', async () => {
    h.handlers.clear();
    let pendingCompletion = false;
    let resolveDrain!: () => void;
    h.drainPersistQueue.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDrain = () => {
            pendingCompletion = true;
            resolve();
          };
        }),
    );
    const isSessionTurnPendingCompletion = vi.fn(() => pendingCompletion);
    registerMakerTitleIpc({ isSessionTurnPendingCompletion });

    const result = invokeRegenerate('s-new-turn');
    await vi.waitFor(() => expect(h.drainPersistQueue).toHaveBeenCalledOnce());
    expect(h.regenerateMaterial).not.toHaveBeenCalled();
    resolveDrain();
    await expect(result).resolves.toEqual({ title: '任务标题' });

    expect(isSessionTurnPendingCompletion).toHaveBeenCalledTimes(2);
    expect(h.regenerateMaterial).toHaveBeenCalledWith(
      's-new-turn',
      expect.any(Number),
      expect.any(Function),
    );
  });

  it('drain 后到素材快照前新 turn 启动时，动态状态读取仍会过滤施工播报', async () => {
    h.handlers.clear();
    let pendingCompletion = false;
    const isSessionTurnPendingCompletion = vi.fn(() => pendingCompletion);
    h.regenerateMaterial.mockImplementationOnce(async (_sessionId, _limit, signal) => {
      pendingCompletion = true;
      expect(typeof signal).toBe('function');
      expect((signal as () => boolean)()).toBe(true);
      return {
        opening: { text: '原始需求', createdAt: 1, rowid: 1 },
        recent: [{ role: 'user' as const, text: '原始需求', createdAt: 1, rowid: 1 }],
      };
    });
    registerMakerTitleIpc({ isSessionTurnPendingCompletion });

    await expect(invokeRegenerate('s-snapshot-race')).resolves.toEqual({ title: '任务标题' });

    expect(isSessionTurnPendingCompletion).toHaveBeenCalledTimes(3);
    expect(h.regenerateMaterial).toHaveBeenCalledWith(
      's-snapshot-race',
      expect.any(Number),
      expect.any(Function),
    );
  });
});

describe('maker title IPC — 本机 / device-link 来源边界', () => {
  it('非受信本机 Renderer 调用 generate / regenerate 均被拒且没有副作用', async () => {
    h.trusted = false;

    await expect(
      invokeGenerate({ message: '排查远程标题', agentKind: 'codex', sessionId: 's1' }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(invokeRegenerate('s1')).rejects.toThrow(/PERMISSION_DENIED/);

    expect(h.generateTitle).not.toHaveBeenCalled();
    expect(h.generateTitleResult).not.toHaveBeenCalled();
    expect(h.drainPersistQueue).not.toHaveBeenCalled();
  });

  it('device-link 可信上下文允许合成 event 调用 generate / regenerate', async () => {
    h.trusted = false;

    await expect(
      invokeFromDeviceLink('maker:generate-title', () =>
        invokeGenerate({ message: '排查远程标题', agentKind: 'codex', sessionId: 's1' }),
      ),
    ).resolves.toEqual({ title: '任务标题' });
    await expect(
      invokeFromDeviceLink('maker:regenerate-title', () => invokeRegenerate('s1')),
    ).resolves.toEqual({ title: '任务标题' });

    expect(h.generateTitle).toHaveBeenCalledOnce();
    expect(h.generateTitleResult).toHaveBeenCalledOnce();
    expect(h.drainPersistQueue).toHaveBeenCalledOnce();
  });

  it('软删除任务按 NOT_FOUND 处理且不调用标题模型', async () => {
    vi.mocked(getDbClient).mockReturnValue({
      drizzle: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [{ agentKind: 'codex', status: 'deleted' }],
            }),
          }),
        }),
      },
    } as unknown as ReturnType<typeof getDbClient>);

    await expect(invokeRegenerate('deleted')).rejects.toThrow(/\[NOT_FOUND\]/);
    expect(h.generateTitleResult).not.toHaveBeenCalled();
  });

  it.each([
    ['unsupported-provider', 'TITLE_PROVIDER_UNSUPPORTED'],
    ['failed', 'INTERNAL'],
  ] as const)('regenerate %s 在本机与 device-link 上都透传 %s', async (status, code) => {
    h.generateTitleResult.mockResolvedValue({ status });

    await expect(invokeRegenerate('s1')).rejects.toThrow(new RegExp(`\\[${code}\\]`));

    h.trusted = false;
    await expect(
      invokeFromDeviceLink('maker:regenerate-title', () => invokeRegenerate('s1')),
    ).rejects.toThrow(new RegExp(`\\[${code}\\]`));
  });

  it('auto-title 不因 device-link 上下文放宽本机专属 sender 边界', async () => {
    h.trusted = false;

    await expect(
      invokeFromDeviceLink('maker:auto-title', () =>
        invoke({ sessionId: 's1', text: '排查远程标题', agentKind: 'codex' }),
      ),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    expect(h.run).not.toHaveBeenCalled();
  });
});

describe('maker title IPC — payload 运行期校验', () => {
  it.each([
    ['非对象', null],
    ['数组', []],
    ['message 非字符串', { message: 1, agentKind: 'codex' }],
    ['agentKind 非枚举值', { message: 'x', agentKind: 'gpt' }],
    ['sessionId 空串', { message: 'x', agentKind: 'codex', sessionId: '' }],
    ['sessionId 超长', { message: 'x', agentKind: 'codex', sessionId: 'a'.repeat(200) }],
  ])('generate-title: %s → INVALID_PARAMS 且不调用模型', async (_label, payload) => {
    await expect(invokeGenerate(payload)).rejects.toThrow(/INVALID_PARAMS/);
    expect(h.generateTitle).not.toHaveBeenCalled();
  });

  it.each([
    ['非对象', null],
    ['数组', []],
    ['缺 sessionId', {}],
    ['sessionId 非字符串', { sessionId: 1 }],
    ['sessionId 空串', { sessionId: '' }],
    ['sessionId 超长', { sessionId: 'a'.repeat(200) }],
  ])('regenerate-title: %s → INVALID_PARAMS 且不读取素材', async (_label, payload) => {
    await expect(invokeRegenerateRequest(payload)).rejects.toThrow(/INVALID_PARAMS/);
    expect(h.drainPersistQueue).not.toHaveBeenCalled();
    expect(h.regenerateMaterial).not.toHaveBeenCalled();
    expect(h.generateTitleResult).not.toHaveBeenCalled();
  });

  it('generate-title 截断超长正文，保留正常的空消息回落语义', async () => {
    await invokeGenerate({ message: 'x'.repeat(9000), agentKind: 'claude-code' });
    const forwarded = h.generateTitle.mock.calls[0]?.[0] as { prompt?: string } | undefined;
    expect(forwarded?.prompt).toContain('x'.repeat(200));

    h.generateTitle.mockClear();
    await expect(invokeGenerate({ message: '', agentKind: 'codex' })).resolves.toEqual({
      title: null,
    });
    expect(h.generateTitle).not.toHaveBeenCalled();
  });
});

describe('maker:auto-title — sender 断言', () => {
  it('非受信来源(子 frame / WebView)被拒,且不执行任何副作用', async () => {
    h.trusted = false;

    await expect(
      invoke({ sessionId: 's1', text: '帮我排查登录失败', agentKind: 'codex' }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('受信来源正常执行', async () => {
    await expect(
      invoke({ sessionId: 's1', text: '帮我排查登录失败', agentKind: 'codex' }),
    ).resolves.toEqual({ applied: true, done: true });
    expect(h.run).toHaveBeenCalledWith({
      sessionId: 's1',
      text: '帮我排查登录失败',
      agentKind: 'codex',
    });
  });
});

describe('maker:auto-title — payload 运行期校验', () => {
  it.each([
    ['非对象', null],
    ['数组', []],
    ['缺 sessionId', { text: 'x', agentKind: 'codex' }],
    ['sessionId 非字符串', { sessionId: 1, text: 'x', agentKind: 'codex' }],
    ['sessionId 空串', { sessionId: '', text: 'x', agentKind: 'codex' }],
    ['sessionId 超长', { sessionId: 'a'.repeat(200), text: 'x', agentKind: 'codex' }],
    ['text 非字符串', { sessionId: 's1', text: { a: 1 }, agentKind: 'codex' }],
    ['agentKind 非枚举值', { sessionId: 's1', text: 'x', agentKind: 'gpt' }],
    ['isUserText 非布尔', { sessionId: 's1', text: 'x', agentKind: 'codex', isUserText: 'no' }],
  ])('%s → INVALID_PARAMS 且不执行副作用', async (_label, payload) => {
    await expect(invoke(payload)).rejects.toThrow(/INVALID_PARAMS/);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('超长正文被截断而不是拒绝(超长输入是正常的,标题只要开头一段)', async () => {
    await invoke({ sessionId: 's1', text: 'x'.repeat(9000), agentKind: 'claude-code' });

    const forwarded = h.run.mock.calls[0][0] as { text: string };
    expect(forwarded.text).toHaveLength(2000);
  });

  it('isUserText 缺省时不注入该字段(保持 main 侧默认语义)', async () => {
    await invoke({ sessionId: 's1', text: 'x', agentKind: 'codex' });
    expect(h.run.mock.calls[0][0]).not.toHaveProperty('isUserText');

    h.run.mockClear();
    await invoke({ sessionId: 's1', text: 'x', agentKind: 'codex', isUserText: false });
    expect(h.run.mock.calls[0][0]).toMatchObject({ isUserText: false });
  });
});
