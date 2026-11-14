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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ToolMessageRow } from '../attribution.js';
import { pickOwnerSession } from '../attribution.js';
import { createHostDaemonLedger, type HostDaemonLedger, type HostDaemonOwnerRecord } from '../ledger.js';
import { parseScheduledTaskScan, type RawScheduledTask } from '../scheduledTasks.js';
import { HostDaemonActionError, createHostDaemonsService } from '../service.js';

function memoryLedger(): HostDaemonLedger & { owners: Map<string, HostDaemonOwnerRecord> } {
  const owners = new Map<string, HostDaemonOwnerRecord>();
  const misses = new Map<string, number>();
  return {
    owners,
    getOwner: (id) => owners.get(id) ?? null,
    setOwner: (id, record) => void owners.set(id, record),
    clearOwner: (id) => void owners.delete(id),
    getMissMtime: (id) => misses.get(id) ?? null,
    setMissMtime: (id, mtimeMs) => void misses.set(id, mtimeMs),
    save: () => {},
  };
}

/** 追溯窗口查询的替身：默认「读全了」。 */
function windowOf(rows: ToolMessageRow[], truncated = false) {
  return { rows, truncated };
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

  // 大小写折叠必须走 JS（Unicode）：SQLite 的 lower() 只处理 ASCII，若在 SQL 里
  // 预筛选，任务名里的非 ASCII 大写字母会被错杀，命中的行读不到、任务被判无归属。
  it('folds non-ASCII case in both haystack and needle', () => {
    expect(
      pickOwnerSession(
        [{ sessionId: 's1', title: '备份', content: 'schtasks /create /tn équipebackup' }],
        ['ÉquipeBackup'],
      ),
    ).toEqual({ sessionId: 's1', title: '备份', hitCount: 1 });
  });

  it('ignores needles too short to be evidence', () => {
    expect(pickOwnerSession(rows, ['pm'])).toBeNull();
  });
});

describe('host daemon ledger', () => {
  // 两个账号都还没有台账文件时，空台账必须是各自的新对象：共用一份就会让后登录
  // 的账号读到前一个账号写入的会话标题与 id（账号目录隔离挡不住这条内存路径）。
  it('does not share in-memory records between accounts with no ledger file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-daemons-ledger-'));
    try {
      const accountA = createHostDaemonLedger(path.join(dir, 'a', 'host-daemons.v1.json'));
      const accountB = createHostDaemonLedger(path.join(dir, 'b', 'host-daemons.v1.json'));

      accountA.setOwner('\\airlink-autopm', {
        sessionId: 'session-a',
        title: '账号A的标题',
        atMs: 1_800_000_000_000,
        definitionMtimeMs: 1_793_028_922_179,
        command: 'C:\\py\\pythonw.exe autopm.py',
      });

      expect(accountA.getOwner('\\airlink-autopm')?.title).toBe('账号A的标题');
      expect(accountB.getOwner('\\airlink-autopm')).toBeNull();
      accountA.save();
      expect(accountB.getOwner('\\airlink-autopm')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('attribution window query', () => {
  // 截断后没命中不能当「查无此人」：忙时创建任务的调用可能排在窗口第 300 行之后，
  // 窗口一关就写进长期负缓存，用户建的任务从此不再出现在清单里。
  it('does not cache a miss when the window was only partially read', async () => {
    const ledger = memoryLedger();
    const truncated = true;
    const service = createHostDaemonsService({
      scanTasks: async () => [task()],
      readToolMessages: async () => windowOf([], truncated),
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      // 远超 5 分钟窗口：否则「窗口内重算」会掩盖负缓存
      now: () => 1_800_000_000_000,
    });

    expect((await service.list()).unrelatedCount).toBe(1);
    expect(ledger.getMissMtime('\\airlink-autopm')).toBeNull();
  });

  it('uses the whole window when it was read completely', async () => {
    const ledger = memoryLedger();
    const service = createHostDaemonsService({
      scanTasks: async () => [task()],
      readToolMessages: async () => windowOf([], false),
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      now: () => 1_800_000_000_000,
    });

    await service.list();
    expect(ledger.getMissMtime('\\airlink-autopm')).toBe(1_793_028_922_179);
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
      readToolMessages: async () => windowOf(dbRows),
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
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

    // 停止是可逆的一半：立即运行沿用同一条归属复核，并真的下发到系统。
    const ran: string[] = [];
    const runnable = createHostDaemonsService({
      scanTasks: async () => scanned,
      readToolMessages: async () => windowOf([]),
      ledger,
      stopTask: async () => {},
      runTask: async (id) => void ran.push(id),
      deleteTask: async () => {},
      platform: 'win32',
      now: () => 1_800_000_000_000,
    });
    await runnable.run('\\airlink-autopm');
    expect(ran).toEqual(['\\airlink-autopm']);
  });

  it('refuses to stop or delete a task it did not attribute', async () => {
    const service = createHostDaemonsService({
      scanTasks: async () => [task({ id: '\\v2rayNAutoRun', name: 'v2rayNAutoRun' })],
      readToolMessages: async () => windowOf([]),
      ledger: memoryLedger(),
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
    });

    await expect(service.stop('\\v2rayNAutoRun')).rejects.toBeInstanceOf(HostDaemonActionError);
    await expect(service.run('\\v2rayNAutoRun')).rejects.toBeInstanceOf(HostDaemonActionError);
    await expect(service.remove('\\Microsoft\\Windows\\Defrag')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(service.run('\\Microsoft\\Windows\\Defrag')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  // 用户先打开面板、再回到会话：第一次扫描时工具调用行还没落库，miss 不能让这条任务
  // 永远停在「无关」里；时间窗（mtime +5min）过后才相信 miss，避免反复扫全库。
  it('re-traces a missed task while its attribution window is still open', async () => {
    const createdMs = 1_800_000_000_000;
    let clockMs = createdMs + 60_000;
    let rows: ToolMessageRow[] = [];
    let queries = 0;
    const deps = {
      scanTasks: async () => [task({ id: '\fresh', name: 'fresh', definitionMtimeMs: createdMs })],
      readToolMessages: async () => {
        queries += 1;
        return windowOf(rows);
      },
      ledger: memoryLedger(),
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32' as const,
      now: () => clockMs,
    };

    expect((await createHostDaemonsService(deps).list()).entries).toEqual([]);
    rows = [{ sessionId: 's1', title: '建任务', content: 'schtasks /create /tn fresh' }];
    clockMs = createdMs + 3 * 60_000;
    expect((await createHostDaemonsService(deps).list()).entries.map((entry) => entry.name)).toEqual([
      'fresh',
    ]);
    expect(queries).toBe(2);

    // 已归属的条目不再查询（稳态零成本）。
    clockMs = createdMs + 30 * 60_000;
    expect((await createHostDaemonsService(deps).list()).entries.map((entry) => entry.name)).toEqual([
      'fresh',
    ]);
    expect(queries).toBe(2);
  });

  it('stops re-querying an unattributed task once its window closed', async () => {
    const createdMs = 1_800_000_000_000;
    let queries = 0;
    const service = createHostDaemonsService({
      scanTasks: async () => [task({ id: '\never', name: 'never', definitionMtimeMs: createdMs })],
      readToolMessages: async () => {
        queries += 1;
        return windowOf([]);
      },
      ledger: memoryLedger(),
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      now: () => createdMs + 30 * 60_000,
    });

    expect((await service.list()).unrelatedCount).toBe(1);
    expect((await service.list()).unrelatedCount).toBe(1);
    expect(queries).toBe(1);
  });

  // 同名同路径的任务被删掉、由别的程序重建时，台账里的旧记录不能继续授权。
  it('revokes ownership when the task definition changed', async () => {
    const ledger = memoryLedger();
    const replaced = task({ definitionMtimeMs: 1_793_000_000_001, exec: 'C:\\other\\new.exe', args: '' });
    const service = createHostDaemonsService({
      scanTasks: async () => [replaced],
      readToolMessages: async () => windowOf([]),
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      now: () => 1_800_000_000_000,
    });
    ledger.setOwner(replaced.id, {
      sessionId: 'old-session',
      title: '以前建过同名任务',
      atMs: 1_700_000_000_000,
      definitionMtimeMs: 1_600_000_000_000,
      command: 'C:\\py\\pythonw.exe C:\\Users\\me\\airlink\\autopm.py',
    });

    const snapshot = await service.list();
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.unrelatedCount).toBe(1);
    expect(ledger.owners.has(replaced.id)).toBe(false);
    await expect(service.remove(replaced.id)).rejects.toMatchObject({ code: 'NOT_OWNED' });
  });

  // 查询失败 ≠ 查无此人：不能留下负缓存，否则一次数据库抖动就让这条任务永远隐身。
  it('does not cache a miss when the attribution query fails', async () => {
    const ledger = memoryLedger();
    let fail = true;
    const service = createHostDaemonsService({
      scanTasks: async () => [task({ definitionMtimeMs: 1_793_028_922_179 })],
      readToolMessages: async () => {
        if (fail) throw new Error('database is locked');
        return {
          rows: [{ sessionId: 's1', title: '空气质量联动', content: 'schtasks /create /tn airlink-autopm' }],
          truncated: false,
        };
      },
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      // 远超 5 分钟窗口：否则「窗口内重算」会掩盖负缓存
      now: () => 1_800_000_000_000,
    });

    expect((await service.list()).unrelatedCount).toBe(1);
    expect(ledger.getMissMtime('\\airlink-autopm')).toBeNull();

    fail = false;
    expect((await service.list()).entries.map((entry) => entry.name)).toEqual(['airlink-autopm']);
  });

  it('drops the ledger record after a successful delete', async () => {
    const ledger = memoryLedger();
    const deleted: string[] = [];
    const service = createHostDaemonsService({
      scanTasks: async () => [task()],
      readToolMessages: async () =>
        windowOf([
          { sessionId: 's1', title: '空气质量联动', content: 'schtasks /create /tn airlink-autopm' },
        ]),
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async (id) => void deleted.push(id),
      platform: 'win32',
      now: () => 1_800_000_000_000,
    });

    await service.list();
    expect(ledger.owners.has('\\airlink-autopm')).toBe(true);
    await service.remove('\\airlink-autopm');
    expect(deleted).toEqual(['\\airlink-autopm']);
    expect(ledger.owners.has('\\airlink-autopm')).toBe(false);
  });

  it('falls back to an unsupported snapshot off Windows', async () => {
    const service = createHostDaemonsService({
      scanTasks: async () => {
        throw new Error('must not scan off Windows');
      },
      readToolMessages: async () => windowOf([]),
      ledger: memoryLedger(),
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'darwin',
    });

    await expect(service.list()).resolves.toMatchObject({ supported: false, entries: [] });
  });

  it('drops the traced owner when the account switched mid-query', async () => {
    // 归属记录带会话标题：切号瞬间读到的消息可能已属于另一个账号，结果不能落盘。
    let scope = 'account-a';
    const ledger = memoryLedger();
    const service = createHostDaemonsService({
      scanTasks: async () => [task()],
      readToolMessages: async () => {
        scope = 'account-b';
        return windowOf([
          { sessionId: 'session-a', title: '账号A的标题', content: 'schtasks /create /tn airlink-autopm' },
        ]);
      },
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      now: () => 1_800_000_000_000,
      ownerScopeKey: () => scope,
    });

    const snapshot = await service.list();
    expect(snapshot.entries).toEqual([]);
    expect(ledger.owners.has('\\airlink-autopm')).toBe(false);
    // 作废 ≠ 查无此人：不得写 miss 负缓存，否则窗口过去后这条任务永远隐身。
    expect(ledger.getMissMtime('\\airlink-autopm')).toBeNull();
  });

  it('drops the whole snapshot when the account switched during the scan', async () => {
    let scope = 'account-a';
    const service = createHostDaemonsService({
      scanTasks: async () => {
        scope = 'account-b';
        return [task()];
      },
      readToolMessages: async () =>
        windowOf([
          { sessionId: 'session-a', title: '账号A的标题', content: 'schtasks /create /tn airlink-autopm' },
        ]),
      ledger: memoryLedger(),
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      now: () => 1_800_000_000_000,
      ownerScopeKey: () => scope,
    });

    const snapshot = await service.list();
    expect(snapshot.entries).toEqual([]);
  });

  // 只把返回的清单清零不够：本次扫描已经写进台账的旧账号标题会在下一次扫描时
  // 当作「已归属」直接返回给新账号。
  it('does not persist attribution traced while the account changed', async () => {
    let scope = 'account-a';
    const ledger = memoryLedger();
    const service = createHostDaemonsService({
      scanTasks: async () => {
        scope = 'account-b';
        return [task()];
      },
      readToolMessages: async () =>
        windowOf([
          { sessionId: 'session-a', title: '账号A的标题', content: 'schtasks /create /tn airlink-autopm' },
        ]),
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      now: () => 1_800_000_000_000,
      ownerScopeKey: () => scope,
    });

    await service.list();
    expect(ledger.owners.size).toBe(0);

    // 切到新账号再扫一次（这次查不到归属），旧账号的标题绝不能冒出来。
    scope = 'account-c';
    const afterSwitch = await service.list();
    expect(afterSwitch.entries).toEqual([]);
  });

  // 账号边界进行中（拆运行时/换库）时，读到的消息可能属于旧账号、写的台账可能
  // 属于新账号：这一段时间里的任何归属结论与台账写入都必须作废。
  it('treats an in-progress account boundary as a scope change', async () => {
    let pending = false;
    const ledger = memoryLedger();
    const service = createHostDaemonsService({
      scanTasks: async () => {
        pending = true;
        return [task()];
      },
      readToolMessages: async () =>
        windowOf([
          { sessionId: 'session-a', title: '账号A的标题', content: 'schtasks /create /tn airlink-autopm' },
        ]),
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      now: () => 1_800_000_000_000,
      ownerScopeKey: () => 'account-a',
      isOwnerBoundaryPending: () => pending,
    });

    const snapshot = await service.list();
    expect(snapshot.entries).toEqual([]);
    expect(ledger.owners.size).toBe(0);
    expect(ledger.getMissMtime('\\airlink-autopm')).toBeNull();
  });

  // 边界期间 owner 提交会换掉真实的账号 key：不能用固定哨兵把它折叠掉，
  // 否则「开始在边界里、结束还在边界里、中间换了账号」会被判成没变。
  it('detects an owner commit that happens entirely inside a boundary', async () => {
    let scope = 'account-a';
    // 请求一开始就落在边界里，结束时边界仍未结束 —— 只有真实 key 能暴露中间那次提交。
    const pending = true;
    const ledger = memoryLedger();
    const readToolMessages = vi.fn(async () => {
      // 查询期间 owner 被提交，边界仍未结束。
      scope = 'account-b';
      return windowOf([
        { sessionId: 'session-a', title: '账号A的标题', content: 'schtasks /create /tn airlink-autopm' },
      ]);
    });
    const service = createHostDaemonsService({
      scanTasks: async () => [task()],
      readToolMessages,
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      now: () => 1_800_000_000_000,
      ownerScopeKey: () => scope,
      isOwnerBoundaryPending: () => pending,
    });

    const snapshot = await service.list();
    expect(snapshot.entries).toEqual([]);
    expect(ledger.owners.size).toBe(0);
  });

  // 边界进行中连库都不读：那一刻数据库可能正被换掉，读到的行属于哪个账号无法确定。
  it('refuses to read tool history while the account boundary is in progress', async () => {
    const readToolMessages = vi.fn(async () => windowOf([]));
    const ledger = memoryLedger();
    const service = createHostDaemonsService({
      scanTasks: async () => [task()],
      readToolMessages,
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      now: () => 1_800_000_000_000,
      ownerScopeKey: () => 'account-a',
      isOwnerBoundaryPending: () => true,
    });

    const snapshot = await service.list();
    expect(snapshot.entries).toEqual([]);
    expect(readToolMessages).not.toHaveBeenCalled();
    expect(ledger.owners.size).toBe(0);
    await expect(service.run('\\airlink-autopm')).rejects.toMatchObject({ code: 'NOT_OWNED' });
  });

  // 切号发生在两条任务之间：第一条已经算出归属、只在内存里等着提交，也绝不能
  // 写进任何账号的台账（提交是整轮一次性的）。
  it('commits nothing when the account switches between two tasks', async () => {
    let scope = 'account-a';
    let reads = 0;
    const ledger = memoryLedger();
    const setOwner = vi.spyOn(ledger, 'setOwner');
    const service = createHostDaemonsService({
      scanTasks: async () => [
        task({ id: '\\first', name: 'first-task' }),
        task({ id: '\\second', name: 'second-task' }),
      ],
      readToolMessages: async () => {
        reads += 1;
        // 第一条任务照常归属；第二条任务的查询期间切号。
        if (reads === 2) scope = 'account-b';
        return windowOf([
          { sessionId: 'session-a', title: '账号A的标题', content: 'schtasks /create /tn first-task' },
        ]);
      },
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      now: () => 1_800_000_000_000,
      ownerScopeKey: () => scope,
    });

    const snapshot = await service.list();
    expect(snapshot.entries).toEqual([]);
    expect(setOwner).not.toHaveBeenCalled();
    expect(ledger.owners.size).toBe(0);
  });

  it('refuses to act on a task when the account changed after the rescan', async () => {
    let scope = 'account-a';
    const ledger = memoryLedger();
    const stopTask = vi.fn(async () => {});
    const service = createHostDaemonsService({
      scanTasks: async () => {
        scope = 'account-b';
        return [task()];
      },
      readToolMessages: async () => windowOf([]),
      ledger,
      stopTask,
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      now: () => 1_800_000_000_000,
      ownerScopeKey: () => scope,
    });
    ledger.owners.set('\\airlink-autopm', {
      sessionId: 'session-a',
      title: '账号A的标题',
      atMs: 1_800_000_000_000,
      definitionMtimeMs: 1_793_028_922_179,
      command: 'C:\\py\\pythonw.exe C:\\Users\\me\\airlink\\autopm.py',
    });

    await expect(service.stop('\\airlink-autopm')).rejects.toBeInstanceOf(HostDaemonActionError);
    expect(stopTask).not.toHaveBeenCalled();
  });
});
