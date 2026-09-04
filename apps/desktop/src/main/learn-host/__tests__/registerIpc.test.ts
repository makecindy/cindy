/**
 * registerIpc.test.ts —— learn:start 的远程 lifecycle fence。
 *
 * device-link 合成 event 的 sender 为空,不能按窗口归属判定 secondary;fence 只在
 * 原始 renderer(经隧道 req)显式带 requireActiveSession 时触发。primary remote
 * task 不带该标记,保持历史语义。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  startLearn: vi.fn(async (_req: unknown) => ({ runId: 'run-1' })),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
  },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../device-link/broadcast-tap.js', () => ({
  tapWindowBroadcast: vi.fn(),
}));

vi.mock('../index.js', () => ({
  getLearnController: () => ({ startLearn: mocks.startLearn }),
}));

import { LEARN_CHANNELS, registerLearnIpc, type LearnIpcLifecycleDeps } from '../registerIpc.js';

function invoke(req: unknown): Promise<unknown> {
  const handler = mocks.handlers.get(LEARN_CHANNELS.START);
  if (!handler) throw new Error('learn:start handler not registered');
  return Promise.resolve(handler({}, req));
}

describe('learn:start remote lifecycle fence', () => {
  type SessionLock = <T>(sessionId: string, task: () => Promise<T>) => Promise<T>;
  const isDeviceLinkInvoke = vi.fn(() => true);
  const withSessionLock = vi.fn<SessionLock>(async (_sessionId, task) => task());
  const assertSessionActive = vi.fn(async (_sessionId: string) => undefined);

  // registerLearnIpc 有模块级幂等 guard,整文件只注册一次;lifecycle deps 是
  // vi.fn,beforeEach clear 后仍可逐用例断言调用次数。
  registerLearnIpc({
    isDeviceLinkInvoke,
    withSessionLock: withSessionLock as unknown as LearnIpcLifecycleDeps['withSessionLock'],
    assertSessionActive,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    isDeviceLinkInvoke.mockReturnValue(true);
  });

  it('fences a device-link learn:start only when requireActiveSession is explicitly requested', async () => {
    await invoke({
      input: '学习 X',
      sourceKind: 'freetext',
      originSessionId: 'rs',
      requireActiveSession: true,
    });

    expect(withSessionLock).toHaveBeenCalledWith('rs', expect.any(Function));
    expect(assertSessionActive).toHaveBeenCalledWith('rs');
    // fence 已在锁内完成;requireActiveSession 是 dispatch-only 标记,必须在 IPC
    // 边界剥离,不能流进 LearnController 的 run 记录 / 证据打包。
    expect(mocks.startLearn).toHaveBeenCalledTimes(1);
    const passedReq = mocks.startLearn.mock.calls[0]![0] as Record<string, unknown>;
    expect(passedReq).not.toHaveProperty('requireActiveSession');
    expect(passedReq).toMatchObject({
      input: '学习 X',
      sourceKind: 'freetext',
      originSessionId: 'rs',
    });
  });

  it('does not fence a primary remote learn:start without requireActiveSession', async () => {
    await invoke({ input: '学习 Y', sourceKind: 'freetext', originSessionId: 'rs' });

    expect(withSessionLock).not.toHaveBeenCalled();
    expect(assertSessionActive).not.toHaveBeenCalled();
    expect(mocks.startLearn).toHaveBeenCalledTimes(1);
  });

  it('does not fence when originSessionId is missing even with the marker', async () => {
    await invoke({ input: 'hub:skill', sourceKind: 'hub', hubSlug: 'skill', requireActiveSession: true });

    expect(withSessionLock).not.toHaveBeenCalled();
    expect(mocks.startLearn).toHaveBeenCalledTimes(1);
  });
});
