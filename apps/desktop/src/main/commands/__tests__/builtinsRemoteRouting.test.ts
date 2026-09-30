/**
 * builtinsRemoteRouting.test.ts
 * ---------------------------------------------------------------------------
 * desktop 命令按会话归属路由的回归:ctx.deviceId 存在(device-link 远程会话)时,
 * /goal /learn /cmd 的业务体必须经 deps.remoteInvoke 隧道到被控端对应 channel,
 * 且**不**触碰本机 controller;本机会话(无 deviceId)行为与改造前一致。
 * 错误分类:隧道 `[CODE] message` 编码与本机 err.code 收敛到同一套。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  webContentsSend: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: h.webContentsSend } }],
  },
  // sendDesktopCommandToSender:无 senderWebContentsId → 回退广播(测试统一走广播捕获)
  webContents: { fromId: () => undefined },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { DesktopCommandRegistry } from '../registry.js';
import { registerBuiltinDesktopCommands } from '../builtins.js';

type Payload = Record<string, unknown>;

/** 取广播出去的 DESKTOP_COMMAND_TRIGGERED payload(每条 send 的第二个参数)。 */
function sentPayloads(): Payload[] {
  return h.webContentsSend.mock.calls.map((c) => c[1] as Payload);
}

function makeHarness(overrides?: {
  remoteInvoke?: (deviceId: string, channel: string, args: unknown[]) => Promise<unknown>;
  isLearnEnabled?: () => boolean;
}) {
  const registry = new DesktopCommandRegistry();
  const goalController = { setGoal: vi.fn(), clearGoal: vi.fn() };
  const learnController = { startLearn: vi.fn(async () => ({ runId: 'local-run' })) };
  const remoteInvoke = vi.fn(overrides?.remoteInvoke ?? (async () => ({})));
  registerBuiltinDesktopCommands(registry, {
    getGoalController: () => goalController as never,
    getLearnController: () => learnController as never,
    isLearnEnabled: overrides?.isLearnEnabled ?? (() => true),
    remoteInvoke,
  });
  return { registry, goalController, learnController, remoteInvoke };
}

beforeEach(() => {
  h.webContentsSend.mockClear();
});

describe('/cindy-make composer entry', () => {
  it('appears in the built-in catalog under the final command name', () => {
    const { registry } = makeHarness();
    expect(registry.list()).toContainEqual({
      kind: 'desktop',
      name: 'cindy-make',
      description: expect.stringContaining('/cindy-make'),
    });
    expect(registry.list().some((command) => command.name === 'cindy-maker')).toBe(false);
    expect(registry.list().some((command) => command.name === 'learn')).toBe(true);
  });

  it.each([undefined, 'remote-device'])(
    'rejects unbound IPC without broadcasting or routing (%s)',
    async (deviceId) => {
      const { registry, remoteInvoke } = makeHarness();
      await expect(registry.execute('cindy-make', { sessionId: 'source', deviceId })).rejects.toThrow(
        '[INVALID_PARAMS]',
      );
      expect(h.webContentsSend).not.toHaveBeenCalled();
      expect(remoteInvoke).not.toHaveBeenCalled();
    },
  );
});

describe('/learn SSH fallback', () => {
  it('routes to the local Learn host for an SSH-backed session', async () => {
    const { registry, learnController, remoteInvoke } = makeHarness();
    await registry.execute('learn', { sessionId: 'ssh-session', args: '学习部署流程' });
    expect(learnController.startLearn).toHaveBeenCalledWith({
      input: '学习部署流程',
      sourceKind: 'freetext',
      originSessionId: 'ssh-session',
    });
    expect(remoteInvoke).not.toHaveBeenCalled();
    expect(sentPayloads().at(-1)).toMatchObject({ command: 'learn', learnRunId: 'local-run' });
  });

  it('follows the Learn Skill activation preference', async () => {
    const { registry } = makeHarness({ isLearnEnabled: () => false });
    expect(registry.list().some((command) => command.name === 'learn')).toBe(false);
    await expect(registry.execute('learn', { sessionId: 'ssh-session' })).rejects.toThrow(
      'unknown command "/learn"',
    );
  });

  it('keeps the remote fallback when only the controlling host disabled Learn', async () => {
    const { registry, learnController, remoteInvoke } = makeHarness({
      isLearnEnabled: () => false,
      remoteInvoke: async () => ({ runId: 'remote-run' }),
    });

    expect(registry.list({ deviceId: 'dev-1' })).toContainEqual(
      expect.objectContaining({ name: 'learn' }),
    );
    await registry.execute('learn', {
      sessionId: 'remote-session',
      deviceId: 'dev-1',
      args: '学习远程流程',
    });

    expect(remoteInvoke).toHaveBeenCalledWith('dev-1', 'learn:start', [{
      input: '学习远程流程',
      sourceKind: 'freetext',
      originSessionId: 'remote-session',
    }]);
    expect(learnController.startLearn).not.toHaveBeenCalled();
  });
});

describe('/goal 远程路由', () => {
  it('deviceId + objective → 隧道 maker:goal:set,不触本机 controller', async () => {
    const { registry, goalController, remoteInvoke } = makeHarness();
    await registry.execute('goal', { sessionId: 'rs', deviceId: 'dev-1', args: '目标 X' });
    expect(remoteInvoke).toHaveBeenCalledWith('dev-1', 'maker:goal:set', [
      { sessionId: 'rs', objective: '目标 X' },
    ]);
    expect(goalController.setGoal).not.toHaveBeenCalled();
    expect(sentPayloads().at(-1)).toMatchObject({ command: 'goal', goalAction: 'set' });
  });

  it('deviceId + clear → 隧道 maker:goal:clear', async () => {
    const { registry, goalController, remoteInvoke } = makeHarness();
    await registry.execute('goal', { sessionId: 'rs', deviceId: 'dev-1', args: 'clear' });
    expect(remoteInvoke).toHaveBeenCalledWith('dev-1', 'maker:goal:clear', ['rs']);
    expect(goalController.clearGoal).not.toHaveBeenCalled();
    expect(sentPayloads().at(-1)).toMatchObject({ command: 'goal', goalAction: 'cleared' });
  });

  it('本机会话(无 deviceId)仍走本机 controller', async () => {
    const { registry, goalController, remoteInvoke } = makeHarness();
    await registry.execute('goal', { sessionId: 'ls', args: '目标 Y' });
    expect(goalController.setGoal).toHaveBeenCalledWith({ sessionId: 'ls', objective: '目标 Y' });
    expect(remoteInvoke).not.toHaveBeenCalled();
  });

  it('被控端版本过旧(CHANNEL_NOT_ALLOWED)→ remote-unsupported', async () => {
    const { registry } = makeHarness({
      remoteInvoke: async () => {
        throw new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel not allowed');
      },
    });
    await registry.execute('goal', { sessionId: 'rs', deviceId: 'dev-1', args: '目标 X' });
    expect(sentPayloads().at(-1)).toMatchObject({ command: 'goal', error: 'remote-unsupported' });
  });
});

describe('/cmd 远程路由', () => {
  it('deviceId → 隧道 desktop-cmd:run,结果回灌 /cmd 卡', async () => {
    const remoteResult = {
      cmdLine: 'ls',
      cwd: '/remote/dir',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      elapsedMs: 5,
      timedOut: false,
    };
    const { registry, remoteInvoke } = makeHarness({ remoteInvoke: async () => remoteResult });
    await registry.execute('cmd', {
      sessionId: 'rs',
      deviceId: 'dev-1',
      workingDir: '/remote/dir',
      args: 'ls',
    });
    expect(remoteInvoke).toHaveBeenCalledWith('dev-1', 'desktop-cmd:run', [
      { cmdLine: 'ls', cwd: '/remote/dir' },
    ]);
    expect(sentPayloads().at(-1)).toMatchObject({ command: 'cmd', result: remoteResult });
  });

  it('隧道失败 → 结果卡带 spawnError(不 throw、不静默)', async () => {
    const { registry } = makeHarness({
      remoteInvoke: async () => {
        throw new Error('[DEVICE_LINK_DEVICE_OFFLINE] device offline');
      },
    });
    await registry.execute('cmd', {
      sessionId: 'rs',
      deviceId: 'dev-1',
      workingDir: '/remote/dir',
      args: 'ls',
    });
    const last = sentPayloads().at(-1) as { result?: { exitCode: number; spawnError?: string } };
    expect(last?.result?.exitCode).toBe(-1);
    expect(last?.result?.spawnError).toContain('DEVICE_LINK_DEVICE_OFFLINE');
  });
});
