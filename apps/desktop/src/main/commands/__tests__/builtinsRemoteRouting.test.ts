/**
 * builtinsRemoteRouting.test.ts
 * ---------------------------------------------------------------------------
 * desktop 命令按会话归属路由的回归:ctx.deviceId 存在(device-link 远程会话)时,
 * /goal /learn /cmd 的业务体必须经 deps.remoteInvoke 隧道到被控端对应 channel,
 * 且**不**触碰本机 controller;本机会话(无 deviceId)行为与改造前一致。
 * 错误分类:隧道 `[CODE] message` 编码与本机 err.code 收敛到同一套
 * (LEARN_BUSY → learn-busy;CHANNEL_NOT_ALLOWED/NOT_FOUND → remote-unsupported)。
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
}) {
  const registry = new DesktopCommandRegistry();
  const goalController = { setGoal: vi.fn(), clearGoal: vi.fn() };
  const learnController = { startLearn: vi.fn(async () => ({ runId: 'local-run' })) };
  const remoteInvoke = vi.fn(overrides?.remoteInvoke ?? (async () => ({})));
  registerBuiltinDesktopCommands(registry, {
    getGoalController: () => goalController as never,
    getLearnController: () => learnController as never,
    remoteInvoke,
  });
  return { registry, goalController, learnController, remoteInvoke };
}

beforeEach(() => {
  h.webContentsSend.mockClear();
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

describe('/learn 远程路由', () => {
  it('deviceId → 隧道 learn:start(req 原样),runId 回灌 payload', async () => {
    const { registry, learnController, remoteInvoke } = makeHarness({
      remoteInvoke: async () => ({ runId: 'remote-run' }),
    });
    await registry.execute('learn', { sessionId: 'rs', deviceId: 'dev-1', args: '学习 X 工作流' });
    expect(remoteInvoke).toHaveBeenCalledWith('dev-1', 'learn:start', [
      { input: '学习 X 工作流', sourceKind: 'freetext', originSessionId: 'rs' },
    ]);
    expect(learnController.startLearn).not.toHaveBeenCalled();
    expect(sentPayloads().at(-1)).toMatchObject({ command: 'learn', learnRunId: 'remote-run' });
  });

  it('deviceId + hub:<slug> → sourceKind hub 原样隧道', async () => {
    const { remoteInvoke, registry } = makeHarness({
      remoteInvoke: async () => ({ runId: 'r2' }),
    });
    await registry.execute('learn', { sessionId: 'rs', deviceId: 'dev-1', args: 'hub:my-skill 精简点' });
    expect(remoteInvoke).toHaveBeenCalledWith('dev-1', 'learn:start', [
      { input: '精简点', sourceKind: 'hub', hubSlug: 'my-skill', originSessionId: 'rs' },
    ]);
  });

  it('deviceId + hub:<scope>:<slug> → 保留目录作用域', async () => {
    const { remoteInvoke, registry } = makeHarness({
      remoteInvoke: async () => ({ runId: 'r-scope' }),
    });
    await registry.execute('learn', { sessionId: 'rs', deviceId: 'dev-1', args: 'hub:team:my-skill 精简点' });
    expect(remoteInvoke).toHaveBeenCalledWith('dev-1', 'learn:start', [
      {
        input: '精简点',
        sourceKind: 'hub',
        hubSlug: 'my-skill',
        hubCatalogScope: 'team',
        originSessionId: 'rs',
      },
    ]);
  });

  it('隧道 [LEARN_BUSY] 编码 → learn-busy(与本机 err.code 同分类)', async () => {
    const { registry } = makeHarness({
      remoteInvoke: async () => {
        throw new Error('[LEARN_BUSY] another run in progress');
      },
    });
    await registry.execute('learn', { sessionId: 'rs', deviceId: 'dev-1', args: 'x' });
    expect(sentPayloads().at(-1)).toMatchObject({ command: 'learn', error: 'learn-busy' });
  });

  it('本机会话仍走本机 controller.startLearn', async () => {
    const { registry, learnController, remoteInvoke } = makeHarness();
    await registry.execute('learn', { sessionId: 'ls', args: '学习 Y' });
    expect(learnController.startLearn).toHaveBeenCalledWith({
      input: '学习 Y',
      sourceKind: 'freetext',
      originSessionId: 'ls',
    });
    expect(remoteInvoke).not.toHaveBeenCalled();
    expect(sentPayloads().at(-1)).toMatchObject({ command: 'learn', learnRunId: 'local-run' });
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
