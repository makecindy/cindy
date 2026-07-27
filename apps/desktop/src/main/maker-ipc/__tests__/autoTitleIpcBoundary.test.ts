/**
 * `maker:auto-title` 的授权边界与 payload 校验。
 *
 * 该 handler 会改写会话标题、并可能触发一次付费模型调用,属于新增特权入口:
 * 按 docs/dev-rules/electron-security-and-process-boundaries.md §5,执行副作用前
 * 必须做 sender 断言 + 运行期结构/长度/枚举校验(TS 类型不等于运行期校验)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  trusted: true,
  run: vi.fn(async (_request: unknown) => ({ applied: true, done: true })),
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
  regenerateTitleMaterial: vi.fn(),
}));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: vi.fn(),
}));
vi.mock('../../maker-host/title-one-shot.js', () => ({ generateTitleViaProvider: vi.fn() }));
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

const EVENT = {} as Electron.IpcMainInvokeEvent;

function invoke(request: unknown): Promise<unknown> {
  const handler = h.handlers.get('maker:auto-title');
  if (!handler) throw new Error('auto-title handler not registered');
  return Promise.resolve(handler(EVENT, request));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.trusted = true;
  h.run.mockResolvedValue({ applied: true, done: true });
  registerMakerTitleIpc();
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
