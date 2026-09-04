/**
 * remoteCmdIpc.test.ts —— desktop-cmd:run 被控端 handler 单测。
 * 覆盖:参数校验(空 cmdLine / 非法类型)、cwd 过 remote-workdir-guard(fail-closed:
 * 不放行即拒绝,不落 spawn)、guard 通过后透传 runShellCommand 结果。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type SessionLock = <T>(sessionId: string, task: () => Promise<T>) => Promise<T>;

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  isAllowed: vi.fn(async () => true),
  isDeviceLinkInvoke: vi.fn(() => false),
  withSessionLock: vi.fn<SessionLock>(
    async <T>(_sessionId: string, task: () => Promise<T>): Promise<T> => task(),
  ),
  assertSessionActive: vi.fn(async (_sessionId: string) => undefined),
  runShellCommand: vi.fn(async (opts: { cmdLine: string; cwd: string }) => ({
    cmdLine: opts.cmdLine,
    cwd: opts.cwd,
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    elapsedMs: 3,
    timedOut: false,
  })),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { fromId: () => undefined },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../device-link/remote-workdir-guard.js', () => ({
  isRemoteWorkingDirAllowed: h.isAllowed,
}));
vi.mock('../builtins.js', () => ({
  runShellCommand: h.runShellCommand,
}));
vi.mock('../../maker-ipc/register.js', () => ({
  withSendToSessionLock: h.withSessionLock,
  assertSessionActiveForManualDispatch: h.assertSessionActive,
}));

import { registerRemoteCmdIpc, DESKTOP_CMD_RUN_CHANNEL } from '../remoteCmdIpc.js';

function invokeHandler(input: unknown): Promise<unknown> {
  const fn = h.handlers.get(DESKTOP_CMD_RUN_CHANNEL);
  if (!fn) throw new Error('handler not registered');
  return Promise.resolve(fn({}, input));
}

beforeEach(() => {
  h.isAllowed.mockClear();
  h.isDeviceLinkInvoke.mockReset();
  h.isDeviceLinkInvoke.mockReturnValue(false);
  h.withSessionLock.mockClear();
  h.assertSessionActive.mockClear();
  h.runShellCommand.mockClear();
  registerRemoteCmdIpc({
    isDeviceLinkInvoke: h.isDeviceLinkInvoke,
    withSessionLock: h.withSessionLock as unknown as SessionLock,
    assertSessionActive: h.assertSessionActive,
  }); // 幂等:重复调用不重复注册
});

describe('desktop-cmd:run handler', () => {
  it('guard 通过 → 在指定 cwd 执行并透传结果', async () => {
    const result = (await invokeHandler({ cmdLine: 'ls -la', cwd: '/known/dir' })) as {
      exitCode: number;
      stdout: string;
    };
    expect(h.isAllowed).toHaveBeenCalledWith('/known/dir');
    expect(h.runShellCommand).toHaveBeenCalledWith({ cmdLine: 'ls -la', cwd: '/known/dir' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
  });

  it('device-link 调用带显式 requireActiveSession 时在 route lock 内复核 active', async () => {
    h.isDeviceLinkInvoke.mockReturnValue(true);
    await invokeHandler({
      sessionId: 's1',
      cmdLine: 'ls',
      cwd: '/known/dir',
      requireActiveSession: true,
    });
    expect(h.withSessionLock).toHaveBeenCalledWith('s1', expect.any(Function));
    expect(h.assertSessionActive).toHaveBeenCalledWith('s1');
  });

  it('device-link 调用缺 requireActiveSession 时直通(primary remote 历史语义),不加锁', async () => {
    h.isDeviceLinkInvoke.mockReturnValue(true);
    await invokeHandler({ sessionId: 's1', cmdLine: 'ls', cwd: '/known/dir' });
    expect(h.withSessionLock).not.toHaveBeenCalled();
    expect(h.assertSessionActive).not.toHaveBeenCalled();
    expect(h.runShellCommand).toHaveBeenCalledWith({ cmdLine: 'ls', cwd: '/known/dir' });
  });

  it('device-link 调用带 requireActiveSession 但缺 sessionId 时 fail closed', async () => {
    h.isDeviceLinkInvoke.mockReturnValue(true);
    await expect(
      invokeHandler({ cmdLine: 'ls', cwd: '/known/dir', requireActiveSession: true }),
    ).rejects.toThrow(/\[INVALID_PARAMS\]/);
    expect(h.runShellCommand).not.toHaveBeenCalled();
  });

  it('guard 拒绝 → INVALID_PARAMS,fail-closed 不落 spawn', async () => {
    h.isAllowed.mockResolvedValueOnce(false);
    await expect(invokeHandler({ cmdLine: 'ls', cwd: '/evil/dir' })).rejects.toThrow(
      /\[INVALID_PARAMS\]/,
    );
    expect(h.runShellCommand).not.toHaveBeenCalled();
  });

  it('空 cmdLine → INVALID_PARAMS(不触 guard 之外的任何执行)', async () => {
    await expect(invokeHandler({ cmdLine: '   ', cwd: '/known/dir' })).rejects.toThrow(
      /\[INVALID_PARAMS\]/,
    );
    expect(h.runShellCommand).not.toHaveBeenCalled();
  });

  it('非法入参形状(缺 cwd)→ INVALID_PARAMS', async () => {
    await expect(invokeHandler({ cmdLine: 'ls' })).rejects.toThrow(/\[INVALID_PARAMS\]/);
    expect(h.runShellCommand).not.toHaveBeenCalled();
  });
});
