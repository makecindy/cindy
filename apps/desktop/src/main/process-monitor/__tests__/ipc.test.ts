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
  return {
    state: 'S',
    cmdLineLower: '',
    memoryKb: 0,
    cpuPercent: 0,
    cpuTimeMs: null,
    startIdentity: `start:${partial.pid}`,
    ...partial,
  };
}

function terminateRequest(pid: number, processInstanceId = `start:${pid}`) {
  return { pid, processInstanceId };
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
  removeListener: ReturnType<typeof vi.fn>;
}

function fakeSender(): FakeWebContents {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  };
}

function register(overrides: Parameters<typeof registerProcessMonitorIpc>[0] = {}) {
  registerProcessMonitorIpc({
    sampler: { sample: vi.fn().mockResolvedValue({ capturedAtMs: 1, entries: [] }) },
    scanOsProcessesSync: vi.fn().mockReturnValue({ rows: [], childrenByParent: new Map() }),
    classify: () => null,
    resolveAgentProcessRegistration: (pid) => ({
      kind: 'claude',
      role: 'task-host',
      instanceId: `start:${pid}`,
    }),
    killProcessTree: vi.fn().mockReturnValue(true),
    signalProcess: vi.fn(),
    platform: 'linux',
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
    expect(() => handlerFor(PROCESS_MONITOR_TERMINATE_CHANNEL)(event, terminateRequest(1))).toThrow(
      'PERMISSION_DENIED',
    );
    expect(mocks.assertTrustedAppRendererEvent).toHaveBeenCalledTimes(3);
  });

  it('订阅后立即推送一帧;窗口不再可信时不推', async () => {
    const sample = { capturedAtMs: 7, entries: [] };
    const sampleNow = vi.fn().mockResolvedValue(sample);
    register({ sampler: { sample: sampleNow } });
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

    // 失信 sender 已从订阅集合移除；恢复可信后会重新登记 destroyed 监听。
    mocks.isTrustedAppRendererWindow.mockReturnValue(true);
    await handlerFor(PROCESS_MONITOR_SUBSCRIBE_CHANNEL)({ sender });
    await vi.waitFor(() => expect(sender.once).toHaveBeenCalledTimes(2));
    expect(sender.removeListener).toHaveBeenCalledTimes(1);
  });

  it('反复切换面板时清理旧 destroyed 监听器', async () => {
    register();
    const sender = fakeSender();
    const subscribe = handlerFor(PROCESS_MONITOR_SUBSCRIBE_CHANNEL);
    const unsubscribe = handlerFor(PROCESS_MONITOR_UNSUBSCRIBE_CHANNEL);

    await subscribe({ sender });
    await unsubscribe({ sender });
    await subscribe({ sender });
    await unsubscribe({ sender });

    expect(sender.once).toHaveBeenCalledTimes(2);
    expect(sender.removeListener).toHaveBeenCalledTimes(2);
    expect(sender.removeListener).toHaveBeenNthCalledWith(1, 'destroyed', expect.any(Function));
    expect(sender.removeListener).toHaveBeenNthCalledWith(2, 'destroyed', expect.any(Function));
  });
});

describe('terminate ownership validation', () => {
  const ownedRows = [
    osRow({ pid: 900, ppid: SELF_PID, cmdLineLower: 'claude-marker main' }),
    osRow({ pid: 901, ppid: 900, cmdLineLower: 'bash child' }),
    osRow({ pid: 902, ppid: 901, cmdLineLower: 'node tool child' }),
    osRow({ pid: 950, ppid: 1, cmdLineLower: 'claude-marker orphan' }),
    osRow({ pid: 960, ppid: SELF_PID, cmdLineLower: 'not-an-agent' }),
  ];
  const classify = (cmd: string) => (cmd.includes('claude-marker') ? ('claude' as const) : null);

  function registerWithRows(
    killProcessTree = vi.fn().mockReturnValue(true),
    signalProcess = vi.fn(),
  ) {
    let scanCount = 0;
    register({
      scanOsProcessesSync: vi.fn(() => {
        scanCount += 1;
        const rows =
          scanCount === 1
            ? ownedRows
            : ownedRows.map((candidate) => ({ ...candidate, state: 'T' }));
        return { rows, childrenByParent: buildChildrenByParent(rows) };
      }),
      classify,
      killProcessTree,
      signalProcess,
    });
    return killProcessTree;
  }

  it('POSIX 暂停根后逐层冻结并终止多级后代', () => {
    const signal = vi.fn();
    const kill = registerWithRows(undefined, signal);
    const result = handlerFor(PROCESS_MONITOR_TERMINATE_CHANNEL)(
      { sender: fakeSender() },
      terminateRequest(900),
    );
    expect(result).toEqual({ pid: 900, kind: 'claude' });
    expect(kill).not.toHaveBeenCalled();
    expect(signal.mock.calls).toEqual([
      [900, 'SIGSTOP'],
      [901, 'SIGSTOP'],
      [902, 'SIGSTOP'],
      [902, 'SIGKILL'],
      [901, 'SIGKILL'],
      [900, 'SIGKILL'],
    ]);
  });

  it('Windows 仍由 taskkill /T 展开树，只扫描和校验一次', () => {
    const snapshot = {
      rows: ownedRows,
      childrenByParent: buildChildrenByParent(ownedRows),
    };
    const scan = vi.fn().mockReturnValue(snapshot);
    const kill = vi.fn().mockReturnValue(true);
    register({
      platform: 'win32',
      scanOsProcessesSync: scan,
      classify,
      killProcessTree: kill,
    });

    expect(
      handlerFor(PROCESS_MONITOR_TERMINATE_CHANNEL)(
        { sender: fakeSender() },
        terminateRequest(900),
      ),
    ).toEqual({ pid: 900, kind: 'claude' });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(900, new Map());
  });

  it.each([
    [
      '出生身份改变',
      osRow({
        pid: 900,
        ppid: SELF_PID,
        cmdLineLower: 'claude-marker main',
        startIdentity: 'start:new',
      }),
      false,
    ],
    ['父进程改变', osRow({ pid: 900, ppid: 1, cmdLineLower: 'claude-marker main' }), true],
    ['marker 消失', osRow({ pid: 900, ppid: SELF_PID, cmdLineLower: 'replacement process' }), true],
  ])('POSIX 暂停后复核发现根进程%s时拒绝终止', (_description, recheckedRoot, shouldResume) => {
    const first = { rows: ownedRows, childrenByParent: buildChildrenByParent(ownedRows) };
    const secondRows = [recheckedRoot, ...ownedRows.filter((row) => row.pid !== 900)];
    const second = { rows: secondRows, childrenByParent: buildChildrenByParent(secondRows) };
    const scan = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const kill = vi.fn().mockReturnValue(true);
    const signal = vi.fn();
    register({ scanOsProcessesSync: scan, classify, killProcessTree: kill, signalProcess: signal });

    expect(() =>
      handlerFor(PROCESS_MONITOR_TERMINATE_CHANNEL)(
        { sender: fakeSender() },
        terminateRequest(900),
      ),
    ).toThrow('NOT_FOUND');
    expect(kill).not.toHaveBeenCalled();
    expect(signal.mock.calls).toEqual(
      shouldResume
        ? [
            [900, 'SIGSTOP'],
            [900, 'SIGCONT'],
          ]
        : [[900, 'SIGSTOP']],
    );
  });

  it('POSIX 暂停后的扫描失败时恢复根进程并返回 INTERNAL', () => {
    const snapshot = { rows: ownedRows, childrenByParent: buildChildrenByParent(ownedRows) };
    const scan = vi
      .fn()
      .mockReturnValueOnce(snapshot)
      .mockImplementationOnce(() => {
        throw new Error('second ps failed');
      });
    const kill = vi.fn().mockReturnValue(true);
    const signal = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn() };
    register({
      scanOsProcessesSync: scan,
      classify,
      killProcessTree: kill,
      signalProcess: signal,
      log,
    });

    expect(() =>
      handlerFor(PROCESS_MONITOR_TERMINATE_CHANNEL)(
        { sender: fakeSender() },
        terminateRequest(900),
      ),
    ).toThrow('INTERNAL');
    expect(kill).not.toHaveBeenCalled();
    expect(signal.mock.calls).toEqual([
      [900, 'SIGSTOP'],
      [900, 'SIGCONT'],
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      'process monitor POSIX tree termination failed',
      expect.objectContaining({ error: 'second ps failed' }),
    );
  });

  it.each([
    ['ppid 不是本进程(别家实例的 agent)', 950],
    ['本进程子进程但没有 agent marker', 960],
    ['进程根本不存在', 12345],
  ])('拒绝:%s', async (_desc, pid) => {
    const kill = registerWithRows();
    expect(() =>
      handlerFor(PROCESS_MONITOR_TERMINATE_CHANNEL)(
        { sender: fakeSender() },
        terminateRequest(pid),
      ),
    ).toThrow('NOT_FOUND');
    expect(kill).not.toHaveBeenCalled();
  });

  it.each([
    ['负数', terminateRequest(-1)],
    ['非整数', terminateRequest(1.5)],
    ['字符串 pid', { pid: '900', processInstanceId: 'start:900' }],
    ['缺少出生身份', { pid: 900 }],
    ['空出生身份', { pid: 900, processInstanceId: '' }],
    ['旧版裸 pid', 900],
    ['自身 pid', terminateRequest(SELF_PID)],
  ])('拒绝非法参数:%s', async (_desc, raw) => {
    const kill = registerWithRows();
    expect(() =>
      handlerFor(PROCESS_MONITOR_TERMINATE_CHANNEL)({ sender: fakeSender() }, raw),
    ).toThrow('INVALID_PARAMS');
    expect(kill).not.toHaveBeenCalled();
  });

  it('Windows taskkill 失败返回 INTERNAL', async () => {
    const snapshot = { rows: ownedRows, childrenByParent: buildChildrenByParent(ownedRows) };
    register({
      platform: 'win32',
      scanOsProcessesSync: vi.fn().mockReturnValue(snapshot),
      classify,
      killProcessTree: vi.fn().mockReturnValue(false),
    });
    expect(() =>
      handlerFor(PROCESS_MONITOR_TERMINATE_CHANNEL)(
        { sender: fakeSender() },
        terminateRequest(900),
      ),
    ).toThrow('INTERNAL');
  });

  it('归属扫描失败时包装为 IPC INTERNAL 且不泄露原始错误', async () => {
    const kill = vi.fn().mockReturnValue(true);
    const log = { info: vi.fn(), warn: vi.fn() };
    register({
      scanOsProcessesSync: vi.fn().mockImplementation(() => {
        throw new Error('private powershell details');
      }),
      classify,
      killProcessTree: kill,
      log,
    });
    expect(() =>
      handlerFor(PROCESS_MONITOR_TERMINATE_CHANNEL)(
        { sender: fakeSender() },
        terminateRequest(900),
      ),
    ).toThrow('INTERNAL');
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
    const rows = [osRow({ pid: 970, ppid: SELF_PID, cmdLineLower: 'codex-marker service' })];
    const kill = vi.fn().mockReturnValue(true);
    register({
      scanOsProcessesSync: vi.fn().mockReturnValue({
        rows,
        childrenByParent: buildChildrenByParent(rows),
      }),
      classify: () => 'codex',
      resolveAgentProcessRegistration: () =>
        role ? { kind: 'codex', role, instanceId: 'start:970' } : null,
      killProcessTree: kill,
    });
    expect(() =>
      handlerFor(PROCESS_MONITOR_TERMINATE_CHANNEL)(
        { sender: fakeSender() },
        terminateRequest(970),
      ),
    ).toThrow('NOT_FOUND');
    expect(kill).not.toHaveBeenCalled();
  });

  it('同秒复用 pid 时按 spawn generation 拒绝旧终止授权', async () => {
    const reusedRows = [
      osRow({
        pid: 900,
        ppid: SELF_PID,
        cmdLineLower: 'claude-marker replacement',
        // POSIX lstart 只有秒级；故意与旧进程保持相同，证明它不再承担授权身份。
        startIdentity: 'same-second-lstart',
      }),
    ];
    const kill = vi.fn().mockReturnValue(true);
    register({
      scanOsProcessesSync: vi.fn().mockReturnValue({
        rows: reusedRows,
        childrenByParent: buildChildrenByParent(reusedRows),
      }),
      classify,
      resolveAgentProcessRegistration: () => ({
        kind: 'claude',
        role: 'task-host',
        instanceId: 'spawn:new',
      }),
      killProcessTree: kill,
    });

    expect(() =>
      handlerFor(PROCESS_MONITOR_TERMINATE_CHANNEL)(
        { sender: fakeSender() },
        terminateRequest(900, 'spawn:old'),
      ),
    ).toThrow('NOT_FOUND');
    expect(kill).not.toHaveBeenCalled();
  });
});
