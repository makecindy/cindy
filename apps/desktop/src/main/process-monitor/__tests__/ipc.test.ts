import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ipcHandle: vi.fn(),
  ipcRemoveHandler: vi.fn(),
  assertTrustedAppRendererEvent: vi.fn(),
  isTrustedAppRendererWindow: vi.fn().mockReturnValue(true),
  fromWebContents: vi.fn().mockReturnValue({}),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/userData', getAppMetrics: () => [] },
  ipcMain: { handle: mocks.ipcHandle, removeHandler: mocks.ipcRemoveHandler },
  webContents: { getAllWebContents: () => [] },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
}));

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: mocks.assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow: mocks.isTrustedAppRendererWindow,
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

import {
  PROCESS_MONITOR_SAMPLE_CHANNEL,
  PROCESS_MONITOR_SUBSCRIBE_CHANNEL,
  PROCESS_MONITOR_TERMINATE_CHANNEL,
  PROCESS_MONITOR_UNSUBSCRIBE_CHANNEL,
} from '../../../shared/processMonitor.js';
import { buildChildrenByParent, type OsProcessRow } from '../agent-scan.js';
import { _resetProcessMonitorIpcForTests, registerProcessMonitorIpc } from '../ipc.js';

const SELF_PID = 4242;

function osRow(partial: Partial<OsProcessRow> & { pid: number; ppid: number }): OsProcessRow {
  return { cmdLineLower: '', memoryKb: 0, cpuPercent: 0, cpuTimeMs: null, ...partial };
}

function handlerFor(channel: string) {
  const call = mocks.ipcHandle.mock.calls.find(([ch]) => ch === channel);
  expect(call, `handler for ${channel}`).toBeDefined();
  return call![1] as (...args: unknown[]) => unknown;
}

interface FakeWebContents {
  isDestroyed(): boolean;
  send: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
}

function fakeSender(): FakeWebContents {
  return { isDestroyed: () => false, send: vi.fn(), once: vi.fn() };
}

function register(overrides: Parameters<typeof registerProcessMonitorIpc>[0] = {}) {
  registerProcessMonitorIpc({
    sampler: { sample: vi.fn().mockResolvedValue({ capturedAtMs: 1, entries: [] }) },
    scanOsProcesses: vi.fn().mockResolvedValue({ rows: [], childrenByParent: new Map() }),
    classify: () => null,
    resolveCodexProcessRole: () => null,
    killProcessTree: vi.fn().mockReturnValue(true),
    selfPid: SELF_PID,
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  });
}

beforeEach(() => {
  _resetProcessMonitorIpcForTests();
  mocks.ipcHandle.mockClear();
  mocks.assertTrustedAppRendererEvent.mockReset();
  mocks.isTrustedAppRendererWindow.mockReset().mockReturnValue(true);
});

describe('process monitor IPC authorization', () => {
  it('三个 handler 都先过 app-content 高权限断言', async () => {
    register();
    const event = { sender: fakeSender() };
    await handlerFor(PROCESS_MONITOR_SUBSCRIBE_CHANNEL)(event);
    await handlerFor(PROCESS_MONITOR_UNSUBSCRIBE_CHANNEL)(event);
    mocks.assertTrustedAppRendererEvent.mockImplementation(() => {
      throw new Error('[PERMISSION_DENIED] nope');
    });
    await expect(
      handlerFor(PROCESS_MONITOR_TERMINATE_CHANNEL)(event, 1),
    ).rejects.toThrow('PERMISSION_DENIED');
    expect(mocks.assertTrustedAppRendererEvent).toHaveBeenCalledTimes(3);
  });

  it('订阅后立即推送一帧;窗口不再可信时不推', async () => {
    const sample = { capturedAtMs: 7, entries: [] };
    register({ sampler: { sample: vi.fn().mockResolvedValue(sample) } });
    const sender = fakeSender();
    await handlerFor(PROCESS_MONITOR_SUBSCRIBE_CHANNEL)({ sender });
    await vi.waitFor(() => {
      expect(sender.send).toHaveBeenCalledWith(PROCESS_MONITOR_SAMPLE_CHANNEL, sample);
    });

    sender.send.mockClear();
    mocks.isTrustedAppRendererWindow.mockReturnValue(false);
    await handlerFor(PROCESS_MONITOR_SUBSCRIBE_CHANNEL)({ sender });
    // 等一个微任务链走完:采样发生但没有 send。
    await new Promise((r) => setTimeout(r, 0));
    expect(sender.send).not.toHaveBeenCalled();
  });
});

describe('terminate ownership validation', () => {
  const ownedRows = [
    osRow({ pid: 900, ppid: SELF_PID, cmdLineLower: 'claude-marker main' }),
    osRow({ pid: 901, ppid: 900, cmdLineLower: 'bash child' }),
    osRow({ pid: 950, ppid: 1, cmdLineLower: 'claude-marker orphan' }),
    osRow({ pid: 960, ppid: SELF_PID, cmdLineLower: 'not-an-agent' }),
  ];
  const classify = (cmd: string) => (cmd.includes('claude-marker') ? ('claude' as const) : null);

  function registerWithRows(killProcessTree = vi.fn().mockReturnValue(true)) {
    register({
      scanOsProcesses: vi.fn().mockResolvedValue({
        rows: ownedRows,
        childrenByParent: buildChildrenByParent(ownedRows),
      }),
      classify,
      killProcessTree,
    });
    return killProcessTree;
  }

  it('杀掉归属校验通过的 agent 根进程,连同子树', async () => {
    const kill = registerWithRows();
    const result = await handlerFor(PROCESS_MONITOR_TERMINATE_CHANNEL)(
      { sender: fakeSender() },
      900,
    );
    expect(result).toEqual({ pid: 900, kind: 'claude' });
    expect(kill).toHaveBeenCalledWith(900, expect.any(Map));
    const map = kill.mock.calls[0][1] as Map<number, number[]>;
    expect(map.get(900)).toEqual([901]);
  });

  it.each([
    ['ppid 不是本进程(别家实例的 agent)', 950],
    ['本进程子进程但没有 agent marker', 960],
    ['进程根本不存在', 12345],
  ])('拒绝:%s', async (_desc, pid) => {
    const kill = registerWithRows();
    await expect(
      handlerFor(PROCESS_MONITOR_TERMINATE_CHANNEL)({ sender: fakeSender() }, pid),
    ).rejects.toThrow('NOT_FOUND');
    expect(kill).not.toHaveBeenCalled();
  });

  it.each([
    ['负数', -1],
    ['非整数', 1.5],
    ['字符串', '900'],
    ['自身 pid', SELF_PID],
  ])('拒绝非法参数:%s', async (_desc, raw) => {
    const kill = registerWithRows();
    await expect(
      handlerFor(PROCESS_MONITOR_TERMINATE_CHANNEL)({ sender: fakeSender() }, raw),
    ).rejects.toThrow('INVALID_PARAMS');
    expect(kill).not.toHaveBeenCalled();
  });

  it('杀树失败返回 INTERNAL', async () => {
    registerWithRows(vi.fn().mockReturnValue(false));
    await expect(
      handlerFor(PROCESS_MONITOR_TERMINATE_CHANNEL)({ sender: fakeSender() }, 900),
    ).rejects.toThrow('INTERNAL');
  });

  it('归属扫描失败时包装为 IPC INTERNAL 且不泄露原始错误', async () => {
    const kill = vi.fn().mockReturnValue(true);
    const log = { info: vi.fn(), warn: vi.fn() };
    register({
      scanOsProcesses: vi.fn().mockRejectedValue(new Error('private powershell details')),
      classify,
      killProcessTree: kill,
      log,
    });
    await expect(
      handlerFor(PROCESS_MONITOR_TERMINATE_CHANNEL)({ sender: fakeSender() }, 900),
    ).rejects.toThrow('INTERNAL');
    expect(kill).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'process monitor ownership scan failed',
      expect.objectContaining({ error: 'private powershell details' }),
    );
  });

  it.each([
    ['控制面服务', 'control-plane-service' as const],
    ['角色未知', null],
  ])('Codex %s 即使归属校验通过也不可终止', async (_description, role) => {
    const rows = [
      osRow({ pid: 970, ppid: SELF_PID, cmdLineLower: 'codex-marker service' }),
    ];
    const kill = vi.fn().mockReturnValue(true);
    register({
      scanOsProcesses: vi.fn().mockResolvedValue({
        rows,
        childrenByParent: buildChildrenByParent(rows),
      }),
      classify: () => 'codex',
      resolveCodexProcessRole: () => role,
      killProcessTree: kill,
    });
    await expect(
      handlerFor(PROCESS_MONITOR_TERMINATE_CHANNEL)({ sender: fakeSender() }, 970),
    ).rejects.toThrow('NOT_FOUND');
    expect(kill).not.toHaveBeenCalled();
  });
});
