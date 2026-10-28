/**
 * 测试价值
 * - 生产入口与可观察结果：`createHostDaemonsService().list()` 决定了「哪些系统常驻项
 *   会出现在本机常驻清单里」——用户看到的是「只有我让 Cindy 装的那些」。
 * - Bug／规则依据：清单的立身之本是不混入 v2rayN 这类与本机任务无关的常驻项；
 *   归属只认「任务定义写入时刻 ±5 分钟内、该会话工具调用里出现任务名」。
 * - 现有覆盖缺口：process-monitor 的测试只覆盖进程与终止授权，没有计划任务扫描、
 *   归属判定与台账命中的任何覆盖。
 * - 最小失败输入：一条任务名只出现在用户聊天、不在工具调用里的计划任务（必须被排除）；
 *   以及 `\Microsoft\` 下的系统任务（必须拒绝操作）。
 * - tier：unit。扫描与数据库全部注入，不触碰真实 PowerShell / SQLite。
 */

import { describe, expect, it } from 'vitest';

import type { ToolMessageRow } from '../attribution.js';
import { pickOwnerSession } from '../attribution.js';
import type { HostDaemonLedger, HostDaemonOwnerRecord } from '../ledger.js';
import { parseScheduledTaskScan, type RawScheduledTask } from '../scheduledTasks.js';
import { HostDaemonActionError, createHostDaemonsService } from '../service.js';

function memoryLedger(): HostDaemonLedger & { owners: Map<string, HostDaemonOwnerRecord> } {
  const owners = new Map<string, HostDaemonOwnerRecord>();
  const misses = new Map<string, number>();
  return {
    owners,
    getOwner: (id) => owners.get(id) ?? null,
    setOwner: (id, record) => void owners.set(id, record),
    getMissMtime: (id) => misses.get(id) ?? null,
    setMissMtime: (id, mtimeMs) => void misses.set(id, mtimeMs),
    save: () => {},
  };
}

function task(overrides: Partial<RawScheduledTask> = {}): RawScheduledTask {
  return {
    id: '\\airlink-autopm',
    name: 'airlink-autopm',
    state: 'Running',
    exec: 'C:\\py\\pythonw.exe',
    args: 'C:\\Users\\me\\airlink\\autopm.py',
    triggers: 'MSFT_TaskLogonTrigger',
    lastRunAtMs: 1_793_031_312_000,
    definitionMtimeMs: 1_793_028_922_179,
    ...overrides,
  };
}

describe('parseScheduledTaskScan', () => {
  it('drops unparseable lines instead of losing the whole list', () => {
    const stdout = [
      '{"id":"\\\\airlink-autopm","name":"airlink-autopm","state":"Running","exec":"py.exe","args":"a.py","triggers":"MSFT_TaskLogonTrigger","last":1793031312000,"mtime":1793028922179}',
      'WARNING: something on stderr-ish stdout',
      '{"id":"missing-name"}',
      '{"id":"\\\\noMtime","name":"noMtime","state":"Ready","exec":"x.exe","args":"","triggers":"","last":0,"mtime":0}',
    ].join('\n');

    expect(parseScheduledTaskScan(stdout)).toEqual([
      {
        id: '\\airlink-autopm',
        name: 'airlink-autopm',
        state: 'Running',
        exec: 'py.exe',
        args: 'a.py',
        triggers: 'MSFT_TaskLogonTrigger',
        lastRunAtMs: 1_793_031_312_000,
        definitionMtimeMs: 1_793_028_922_179,
      },
      {
        id: '\\noMtime',
        name: 'noMtime',
        state: 'Ready',
        exec: 'x.exe',
        args: '',
        triggers: '',
        lastRunAtMs: null,
        definitionMtimeMs: null,
      },
    ]);
  });
});

describe('pickOwnerSession', () => {
  const rows: ToolMessageRow[] = [
    { sessionId: 'chat-only', title: '聊过 v2rayN', content: '用户: 我装了 v2rayN' },
    { sessionId: 'agent-a', title: '空气质量联动', content: 'Run{"cmd":"schtasks /create /tn airlink-autopm"}' },
    { sessionId: 'agent-a', title: '空气质量联动', content: '{"output":"SUCCESS: airlink-autopm"}' },
    { sessionId: 'agent-b', title: '另一个任务', content: '{"cmd":"schtasks /query /tn airlink-autopm"}' },
  ];

  it('picks the session that actually issued the command most often', () => {
    expect(pickOwnerSession(rows, ['airlink-autopm'])).toEqual({
      sessionId: 'agent-a',
      title: '空气质量联动',
      hitCount: 2,
    });
  });

  it('ignores needles too short to be evidence', () => {
    expect(pickOwnerSession(rows, ['pm'])).toBeNull();
  });
});

describe('hostDaemons service', () => {
  it('lists only Cindy-owned tasks and remembers an owner after the session is gone', async () => {
    const ledger = memoryLedger();
    const traceRows: ToolMessageRow[] = [
      { sessionId: 'session-1', title: '空气质量联动', content: 'schtasks /create /tn airlink-autopm' },
    ];
    const scanned = [
      task(),
      task({ id: '\\v2rayNAutoRun', name: 'v2rayNAutoRun', exec: 'v2rayN.exe', args: '' }),
    ];
    let dbRows = traceRows;
    const service = createHostDaemonsService({
      scanTasks: async () => scanned,
      readToolMessages: async () => dbRows,
      ledger,
      stopTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      now: () => 1_800_000_000_000,
    });

    const first = await service.list();
    expect(first.entries.map((entry) => entry.name)).toEqual(['airlink-autopm']);
    expect(first.entries[0]).toMatchObject({
      ownerSessionId: 'session-1',
      ownerTitle: '空气质量联动',
      trigger: 'logon',
      state: 'running',
      command: 'C:\\py\\pythonw.exe C:\\Users\\me\\airlink\\autopm.py',
    });
    expect(first.unrelatedCount).toBe(1);

    // 会话连同消息被删掉之后，台账仍然让这条常驻项可见（本功能的核心承诺）。
    dbRows = [];
    const second = await service.list();
    expect(second.entries.map((entry) => entry.name)).toEqual(['airlink-autopm']);
  });

  it('refuses to stop or delete a task it did not attribute', async () => {
    const service = createHostDaemonsService({
      scanTasks: async () => [task({ id: '\\v2rayNAutoRun', name: 'v2rayNAutoRun' })],
      readToolMessages: async () => [],
      ledger: memoryLedger(),
      stopTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
    });

    await expect(service.stop('\\v2rayNAutoRun')).rejects.toBeInstanceOf(HostDaemonActionError);
    await expect(service.remove('\\Microsoft\\Windows\\Defrag')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('falls back to an unsupported snapshot off Windows', async () => {
    const service = createHostDaemonsService({
      scanTasks: async () => {
        throw new Error('must not scan off Windows');
      },
      readToolMessages: async () => [],
      ledger: memoryLedger(),
      stopTask: async () => {},
      deleteTask: async () => {},
      platform: 'darwin',
    });

    await expect(service.list()).resolves.toMatchObject({ supported: false, entries: [] });
  });
});
