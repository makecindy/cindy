/**
 * 测试价值
 * - 生产入口与可观察结果：`refresh()` 扫描本机常驻、推进归属、写台账，并返回这一轮的清单；
 *   它决定了「哪些系统常驻项会出现在本机常驻清单里」——用户看到的是「只有我让 Cindy 装的
 *   那些」。清单没有别的来源：界面每轮收到的就是这份回执。
 * - Bug／规则依据：清单的立身之本是不混入 v2rayN 这类与本机任务无关的常驻项；
 *   归属只认「任务定义写入时刻 ±5 分钟内、该会话工具调用里出现任务名」。没有定义
 *   时刻的条目（crontab）没有时间窗可查：要把工具调用历史读完才下结论，读到一半、
 *   读失败、切号都不能当成「无关」记下来。
 * - 现有覆盖缺口：process-monitor 的测试只覆盖进程与终止授权，没有计划任务扫描、
 *   归属判定与台账命中的任何覆盖。
 * - 最小失败输入：一条任务名只出现在用户聊天、不在工具调用里的计划任务（必须被排除）；
 *   以及 `\Microsoft\` 下的系统任务（必须拒绝操作）；删除必须先结束运行中的实例
 *   （Unregister 只删定义，不带走进程）。全历史回看还依赖证据读取不漏不重：
 *   同一时刻落库的多行（只按时间翻页会漏行）、读到头之后才落库的行。
 * - tier：unit。扫描全部注入，不触碰真实 PowerShell；证据读取那组用内存 SQLite，
 *   走生产查询入口。
 */

import fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

// 只为台账那条用例卡住一次 rename；其余用例与模块拿到的仍是真实实现。
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), rename: vi.fn(actual.rename) };
});

import type { ToolMessageRow } from '../attribution.js';
import { ATTRIBUTION_WINDOW_MS, pickOwnerSession } from '../attribution.js';
import { createHostDaemonLedger, type HostDaemonLedger, type HostDaemonOwnerRecord } from '../ledger.js';
import {
  buildDeleteScheduledTaskScript,
  parseScheduledTaskScan,
  toRawHostDaemon,
  type RawScheduledTask,
} from '../scheduledTasks.js';
import {
  HostDaemonActionError,
  createHostDaemonsService,
  type HostDaemonsService,
  type HostDaemonsServiceDeps,
} from '../service.js';
import type { HostDaemonsSnapshot } from '../../../shared/hostDaemons.js';
import { combineHostDaemonAdapters, type HostDaemonScan, type RawHostDaemon } from '../target.js';
import {
  TOOL_MESSAGE_PAGE_LIMIT,
  readToolUses,
  readToolUsesFrom,
  type ToolMessagePage,
  type ToolUseCursor,
} from '../toolHistory.js';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current.js';
import * as schema from '../../localDb/schema.js';

function memoryLedger(): HostDaemonLedger & { owners: Map<string, HostDaemonOwnerRecord> } {
  const owners = new Map<string, HostDaemonOwnerRecord>();
  const misses = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  return {
    owners,
    getOwner: (id) => owners.get(id) ?? null,
    setOwner: (id, record) => void owners.set(id, record),
    clearOwner: (id) => void owners.delete(id),
    getMissMtime: (id) => misses.get(id) ?? null,
    setMissMtime: (id, mtimeMs) => void misses.set(id, mtimeMs),
    getFirstSeen: (id) => firstSeen.get(id) ?? null,
    setFirstSeen: (id, mtimeMs) => void firstSeen.set(id, mtimeMs),
    firstSeenIds: () => [...firstSeen.keys()],
    retireFirstSeen: (id) => void firstSeen.delete(id),
    ready: async () => {},
    save: async () => {},
  };
}

/**
 * 测试专用包装：把「Windows 扫描 + 三个动作」包成平台适配器，避免 16 个用例都手写
 * 一遍 target。生产接线见 main/host-daemons/index.ts，不经过这里。
 */
function createTestService(init: {
  scanTasks: () => Promise<RawScheduledTask[]> | RawScheduledTask[];
  readToolUses: HostDaemonsServiceDeps['readToolUses'];
  /** 全历史分页读的替身；默认历史为空。 */
  readToolUsesFrom?: HostDaemonsServiceDeps['readToolUsesFrom'];
  ledger?: HostDaemonLedger;
  stopTask?: (id: string) => Promise<void> | void;
  runTask?: (id: string) => Promise<void> | void;
  deleteTask?: (id: string) => Promise<void> | void;
  platform?: string;
  now?: () => number;
  ownerScopeKey?: () => string;
  isOwnerBoundaryPending?: () => boolean;
}): HostDaemonsService {
  const target =
    init.platform && init.platform !== 'win32'
      ? null
      : {
          scan: async () => scanned((await init.scanTasks()).map(toRawHostDaemon)),
          stop: async (id: string) => void (await init.stopTask?.(id)),
          run: async (id: string) => void (await init.runTask?.(id)),
          remove: async (id: string) => void (await init.deleteTask?.(id)),
        };
  return createHostDaemonsService({
    target,
    readToolUses: init.readToolUses,
    readToolUsesFrom: init.readToolUsesFrom ?? (async () => ({ rows: [], next: null, exhausted: true })),
    ledger: init.ledger ?? memoryLedger(),
    now: init.now,
    ownerScopeKey: init.ownerScopeKey,
    isOwnerBoundaryPending: init.isOwnerBoundaryPending,
  });
}

/**
 * 推进一轮，返回这一轮的清单。归属只在 refresh() 里变化，写台账也只在这条更新路径上
 * （工程约定 §8.2）——所以驱动归属的用例都走它。
 */
async function refreshed(service: HostDaemonsService): Promise<HostDaemonsSnapshot> {
  return (await service.refresh()).snapshot;
}

/** 追溯窗口查询的替身：默认「读全了」。 */
function windowOf(rows: ToolMessageRow[], truncated = false) {
  return { rows, truncated };
}

/** 一次完整的扫描：条目都读到了，没有没读全的来源。 */
function scanned(entries: RawHostDaemon[]): HostDaemonScan {
  return { entries, unread: [] };
}

/** 一行工具调用：只有命令文本参与归属，会话标题只是给人看的。 */
function toolUse(sessionId: string, content: string): ToolMessageRow {
  return { sessionId, title: `任务 ${sessionId}`, content };
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

  it('ends the running instance before unregistering the task', () => {
    const script = buildDeleteScheduledTaskScript('\\airlink-autopm');

    // 顺序反了或漏掉停止，都会留下「页面说删了、进程还在跑」的残留。
    expect(script).toMatch(/Stop-ScheduledTask [^\n]+\n {2}Unregister-ScheduledTask /);
    expect(buildDeleteScheduledTaskScript('\\Microsoft\\Windows\\Defrag')).toBeNull();
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

  // 保存必须排队：两次并发保存各自整文件替换，先发出的旧快照若在最后一次改名，
  // 会把后一次保存刚写进去的记录覆盖掉。
  it('serializes saves so an older snapshot cannot overwrite a newer record', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-daemons-ledger-'));
    const file = path.join(dir, 'host-daemons.v1.json');
    const record = (id: string): HostDaemonOwnerRecord => ({
      sessionId: `session-${id}`,
      title: id,
      atMs: 1,
      definitionMtimeMs: 1,
      command: '',
    });
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const inRename = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(fsPromises.rename).mockImplementationOnce(async (from, to) => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      fs.renameSync(from, to);
    });
    try {
      const ledger = createHostDaemonLedger(file);
      await ledger.ready();
      ledger.setOwner('a', record('a'));
      const first = ledger.save();
      await inRename;
      ledger.setOwner('b', record('b'));
      const second = ledger.save();
      // 第一次还卡在最后一步改名：第二次保存此时不能已经开始写盘，否则新记录可能先被旧快照盖掉。
      expect(vi.mocked(fsPromises.mkdir)).toHaveBeenCalledTimes(1);
      release();
      await Promise.all([first, second]);

      expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).owners)).toEqual(['a', 'b']);
      expect(fs.readdirSync(dir)).toEqual(['host-daemons.v1.json']);
    } finally {
      vi.mocked(fsPromises.rename).mockRestore();
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
    const service = createTestService({
      scanTasks: async () => [task()],
      readToolUses: async () => windowOf([], truncated),
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      // 远超 5 分钟窗口：否则「窗口内重算」会掩盖负缓存
      now: () => 1_800_000_000_000,
    });

    // 读不全 = 还没结论：条目算「核对中」，不能在页脚说它「不是 Cindy 创建的」。
    expect(await refreshed(service)).toMatchObject({ unrelatedCount: 0, pendingCount: 1 });
    expect(ledger.getMissMtime('\\airlink-autopm')).toBeNull();
  });

  it('uses the whole window when it was read completely', async () => {
    const ledger = memoryLedger();
    const service = createTestService({
      scanTasks: async () => [task()],
      readToolUses: async () => windowOf([], false),
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      now: () => 1_800_000_000_000,
    });

    await refreshed(service);
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
    const service = createTestService({
      scanTasks: async () => scanned,
      readToolUses: async () => windowOf(dbRows),
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      now: () => 1_800_000_000_000,
    });

    const first = await refreshed(service);
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
    const second = await refreshed(service);
    expect(second.entries.map((entry) => entry.name)).toEqual(['airlink-autopm']);

    // 停止是可逆的一半：立即运行沿用同一条归属复核，并真的下发到系统。
    const ran: string[] = [];
    const runnable = createTestService({
      scanTasks: async () => scanned,
      readToolUses: async () => windowOf([]),
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
    const service = createTestService({
      scanTasks: async () => [task({ id: '\\v2rayNAutoRun', name: 'v2rayNAutoRun' })],
      readToolUses: async () => windowOf([]),
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
      readToolUses: async () => {
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

    expect((await refreshed(createTestService(deps))).entries).toEqual([]);
    rows = [{ sessionId: 's1', title: '建任务', content: 'schtasks /create /tn fresh' }];
    clockMs = createdMs + 3 * 60_000;
    expect((await refreshed(createTestService(deps))).entries.map((entry) => entry.name)).toEqual([
      'fresh',
    ]);
    expect(queries).toBe(2);

    // 已归属的条目不再查询（稳态零成本）。
    clockMs = createdMs + 30 * 60_000;
    expect((await refreshed(createTestService(deps))).entries.map((entry) => entry.name)).toEqual([
      'fresh',
    ]);
    expect(queries).toBe(2);
  });

  // 窗口还开着的未命中必须排下一轮：没人续排，窗口关闭后那次决定性的重读就不会发生，
  // 条目会一直停在「核对中」。
  it('schedules the decisive re-read for a miss whose window is still open', async () => {
    const createdMs = 1_800_000_000_000;
    let clockMs = createdMs + 60_000;
    let queries = 0;
    const ledger = memoryLedger();
    const service = createTestService({
      scanTasks: async () => [task({ id: '\\later', name: 'later', definitionMtimeMs: createdMs })],
      readToolUses: async () => {
        queries += 1;
        return windowOf([]);
      },
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32' as const,
      now: () => clockMs,
    });

    const first = await service.refresh();
    expect(first.snapshot.pendingCount).toBe(1);
    expect(first.retryAfterMs).toBeGreaterThan(0);
    expect(queries).toBe(1);
    expect(ledger.getMissMtime('\\later')).toBeNull();

    clockMs = createdMs + 10 * 60_000;
    expect(await service.refresh()).toMatchObject({
      retryAfterMs: null,
      snapshot: { pendingCount: 0 },
    });
    expect(queries).toBe(2);
    expect(ledger.getMissMtime('\\later')).toBe(createdMs);
  });

  it('stops re-querying an unattributed task once its window closed', async () => {
    const createdMs = 1_800_000_000_000;
    let queries = 0;
    const service = createTestService({
      scanTasks: async () => [task({ id: '\never', name: 'never', definitionMtimeMs: createdMs })],
      readToolUses: async () => {
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

    expect((await refreshed(service)).unrelatedCount).toBe(1);
    expect((await refreshed(service)).unrelatedCount).toBe(1);
    expect(queries).toBe(1);
  });

  it('reads the window once more after it closed, before recording the miss', async () => {
    // 窗口开着时的「没命中」只是暂时的（证据可能还没落库）。窗口关闭后要先重读一次，
    // 读到的才算数：两次轮询之间落库的证据，不能被上一轮的没命中盖过去。
    const createdMs = 1_800_000_000_000;
    let clockMs = createdMs + 60_000;
    let rows: ToolMessageRow[] = [];
    let queries = 0;
    const ledger = memoryLedger();
    const service = createTestService({
      scanTasks: async () => [task({ id: '\\fresh', name: 'fresh', definitionMtimeMs: createdMs })],
      readToolUses: async () => {
        queries += 1;
        return windowOf(rows);
      },
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      now: () => clockMs,
    });

    expect((await refreshed(service)).entries).toEqual([]);
    expect(ledger.getMissMtime('\\fresh')).toBeNull();
    expect(queries).toBe(1);

    clockMs = createdMs + ATTRIBUTION_WINDOW_MS + 1;
    rows = [{ sessionId: 's1', title: '建任务', content: 'schtasks /create /tn fresh' }];
    expect((await refreshed(service)).entries.map((entry) => entry.name)).toEqual(['fresh']);
    expect(queries).toBe(2);
  });

  // 同名同路径的任务被删掉、由别的程序重建时，台账里的旧记录不能继续授权。
  it('revokes ownership when the task definition changed', async () => {
    const ledger = memoryLedger();
    const replaced = task({ definitionMtimeMs: 1_793_000_000_001, exec: 'C:\\other\\new.exe', args: '' });
    const service = createTestService({
      scanTasks: async () => [replaced],
      readToolUses: async () => windowOf([]),
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

    const snapshot = await refreshed(service);
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.unrelatedCount).toBe(1);
    expect(ledger.owners.has(replaced.id)).toBe(false);
    await expect(service.remove(replaced.id)).rejects.toMatchObject({ code: 'NOT_OWNED' });
  });

  // 查询失败 ≠ 查无此人：不能留下负缓存，否则一次数据库抖动就让这条任务永远隐身。
  it('does not cache a miss when the attribution query fails', async () => {
    const ledger = memoryLedger();
    let fail = true;
    const service = createTestService({
      scanTasks: async () => [task({ definitionMtimeMs: 1_793_028_922_179 })],
      readToolUses: async () => {
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

    // 查询失败 = 还没结论：条目算「核对中」，不能在页脚说它「不是 Cindy 创建的」。
    expect(await refreshed(service)).toMatchObject({ unrelatedCount: 0, pendingCount: 1 });
    expect(ledger.getMissMtime('\\airlink-autopm')).toBeNull();

    fail = false;
    expect((await refreshed(service)).entries.map((entry) => entry.name)).toEqual(['airlink-autopm']);
  });

  it('drops the ledger record after a successful delete', async () => {
    const ledger = memoryLedger();
    const deleted: string[] = [];
    const service = createTestService({
      scanTasks: async () => [task()],
      readToolUses: async () =>
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

    await refreshed(service);
    expect(ledger.owners.has('\\airlink-autopm')).toBe(true);
    await service.remove('\\airlink-autopm');
    expect(deleted).toEqual(['\\airlink-autopm']);
    expect(ledger.owners.has('\\airlink-autopm')).toBe(false);
  });

  it('falls back to an unsupported snapshot off Windows', async () => {
    const service = createTestService({
      scanTasks: async () => {
        throw new Error('must not scan off Windows');
      },
      readToolUses: async () => windowOf([]),
      ledger: memoryLedger(),
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'darwin',
    });

    await expect(refreshed(service)).resolves.toMatchObject({ supported: false, entries: [] });
  });

  it('drops the traced owner when the account switched mid-query', async () => {
    // 归属记录带会话标题：切号瞬间读到的消息可能已属于另一个账号，结果不能落盘。
    let scope = 'account-a';
    const ledger = memoryLedger();
    const service = createTestService({
      scanTasks: async () => [task()],
      readToolUses: async () => {
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

    const snapshot = await refreshed(service);
    expect(snapshot.entries).toEqual([]);
    expect(ledger.owners.has('\\airlink-autopm')).toBe(false);
    // 作废 ≠ 查无此人：不得写 miss 负缓存，否则窗口过去后这条任务永远隐身。
    expect(ledger.getMissMtime('\\airlink-autopm')).toBeNull();
  });

  it('drops the whole snapshot when the account switched during the scan', async () => {
    let scope = 'account-a';
    const service = createTestService({
      scanTasks: async () => {
        scope = 'account-b';
        return [task()];
      },
      readToolUses: async () =>
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

    const snapshot = await refreshed(service);
    expect(snapshot.entries).toEqual([]);
  });

  // 只把返回的清单清零不够：本次扫描已经写进台账的旧账号标题会在下一次扫描时
  // 当作「已归属」直接返回给新账号。
  it('does not persist attribution traced while the account changed', async () => {
    let scope = 'account-a';
    const ledger = memoryLedger();
    const service = createTestService({
      scanTasks: async () => {
        scope = 'account-b';
        return [task()];
      },
      readToolUses: async () =>
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

    await refreshed(service);
    expect(ledger.owners.size).toBe(0);

    // 切到新账号再扫一次（这次查不到归属），旧账号的标题绝不能冒出来。
    scope = 'account-c';
    const afterSwitch = await refreshed(service);
    expect(afterSwitch.entries).toEqual([]);
  });

  // 账号边界进行中（拆运行时/换库）时，读到的消息可能属于旧账号、写的台账可能
  // 属于新账号：这一段时间里的任何归属结论与台账写入都必须作废。
  it('treats an in-progress account boundary as a scope change', async () => {
    let pending = false;
    const ledger = memoryLedger();
    const service = createTestService({
      scanTasks: async () => {
        pending = true;
        return [task()];
      },
      readToolUses: async () =>
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

    const snapshot = await refreshed(service);
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
    const readToolUses = vi.fn(async () => {
      // 查询期间 owner 被提交，边界仍未结束。
      scope = 'account-b';
      return windowOf([
        { sessionId: 'session-a', title: '账号A的标题', content: 'schtasks /create /tn airlink-autopm' },
      ]);
    });
    const service = createTestService({
      scanTasks: async () => [task()],
      readToolUses,
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      now: () => 1_800_000_000_000,
      ownerScopeKey: () => scope,
      isOwnerBoundaryPending: () => pending,
    });

    const snapshot = await refreshed(service);
    expect(snapshot.entries).toEqual([]);
    expect(ledger.owners.size).toBe(0);
  });

  // 边界进行中连库都不读：那一刻数据库可能正被换掉，读到的行属于哪个账号无法确定。
  it('refuses to read tool history while the account boundary is in progress', async () => {
    const readToolUses = vi.fn(async () => windowOf([]));
    const ledger = memoryLedger();
    const service = createTestService({
      scanTasks: async () => [task()],
      readToolUses,
      ledger,
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      now: () => 1_800_000_000_000,
      ownerScopeKey: () => 'account-a',
      isOwnerBoundaryPending: () => true,
    });

    const snapshot = await refreshed(service);
    expect(snapshot.entries).toEqual([]);
    expect(readToolUses).not.toHaveBeenCalled();
    expect(ledger.owners.size).toBe(0);
    await expect(service.run('\\airlink-autopm')).rejects.toMatchObject({ code: 'NOT_OWNED' });
  });

  // 边界是瞬态的：这一轮作废，但必须排下一轮，否则边界过去之后没人再推进。
  it('keeps the refresh loop alive across an account boundary', async () => {
    const service = createTestService({
      scanTasks: async () => [task()],
      readToolUses: async () => windowOf([]),
      ledger: memoryLedger(),
      stopTask: async () => {},
      runTask: async () => {},
      deleteTask: async () => {},
      platform: 'win32',
      now: () => 1_800_000_000_000,
      ownerScopeKey: () => 'account-a',
      isOwnerBoundaryPending: () => true,
    });

    const result = await service.refresh();
    expect(result.snapshot.pendingCount).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  // 切号发生在两条任务之间：第一条已经算出归属、只在内存里等着提交，也绝不能
  // 写进任何账号的台账（提交是整轮一次性的）。
  it('commits nothing when the account switches between two tasks', async () => {
    let scope = 'account-a';
    let reads = 0;
    const ledger = memoryLedger();
    const setOwner = vi.spyOn(ledger, 'setOwner');
    const service = createTestService({
      scanTasks: async () => [
        task({ id: '\\first', name: 'first-task' }),
        task({ id: '\\second', name: 'second-task' }),
      ],
      readToolUses: async () => {
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

    const snapshot = await refreshed(service);
    expect(snapshot.entries).toEqual([]);
    expect(setOwner).not.toHaveBeenCalled();
    expect(ledger.owners.size).toBe(0);
  });

  it('refuses to act on a task when the account changed after the rescan', async () => {
    let scope = 'account-a';
    const ledger = memoryLedger();
    const stopTask = vi.fn(async () => {});
    const service = createTestService({
      scanTasks: async () => {
        scope = 'account-b';
        return [task()];
      },
      readToolUses: async () => windowOf([]),
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

describe('没有定义时刻的条目：读完工具调用历史才下结论', () => {
  const T0 = 1_800_000_000_000;
  const COMMAND = '*/5 * * * * /usr/local/bin/backup.sh';
  /** 证据只有一种形态：会话执行过的命令里出现这一行。 */
  const EVIDENCE = toolUse('session-a', `(crontab -l; echo '${COMMAND}') | crontab -`);
  /** 读满一页的历史行：没有任何证据，只用来把历史撑长。 */
  const filler = Array.from({ length: TOOL_MESSAGE_PAGE_LIMIT }, () =>
    toolUse('session-x', 'ls'),
  );

  function cronEntry(overrides: Partial<RawHostDaemon> = {}): RawHostDaemon {
    return {
      id: 'cron-entry:4f2a',
      name: 'backup.sh',
      kind: 'cron-entry',
      state: 'unknown',
      command: '/usr/local/bin/backup.sh',
      trigger: 'schedule',
      attributionNeedles: [COMMAND],
      definitionMtimeMs: null,
      lastRunAtMs: null,
      stoppable: false,
      ...overrides,
    };
  }

  function sweepService(init: {
    daemons?: () => RawHostDaemon[];
    readToolUses?: HostDaemonsServiceDeps['readToolUses'];
    readToolUsesFrom: HostDaemonsServiceDeps['readToolUsesFrom'];
    now?: () => number;
    ownerScopeKey?: () => string;
    unread?: () => boolean;
  }) {
    const ledger = memoryLedger();
    const service = createHostDaemonsService({
      target: {
        scan: async () =>
          init.unread?.()
            ? { entries: [], unread: ['cron-entry:'] }
            : scanned(init.daemons?.() ?? [cronEntry()]),
        stop: async () => {},
        run: async () => {},
        remove: async () => {},
      },
      readToolUses: init.readToolUses ?? (async () => windowOf([])),
      readToolUsesFrom: init.readToolUsesFrom,
      ledger,
      now: init.now,
      ownerScopeKey: init.ownerScopeKey,
    });
    return { service, ledger };
  }

  /**
   * 分页历史的替身，页的语义与真实读取层一致：读满一页 = 后面可能还有行；不足一页
   * = 读到头；空页没有「最后一行」，`next` 为 null。游标是页序号，`calls` 记下每次
   * 从哪里读起。
   */
  function history(pages: ToolMessageRow[][]) {
    const calls: Array<ToolUseCursor | null> = [];
    const read = vi.fn(async (after: ToolUseCursor | null): Promise<ToolMessagePage> => {
      calls.push(after);
      const index = after ? Number(after.id) + 1 : 0;
      const rows = pages[index] ?? [];
      const last = rows.at(-1);
      return {
        rows,
        next: last ? { createdAt: index, id: String(index) } : null,
        exhausted: rows.length < TOOL_MESSAGE_PAGE_LIMIT,
      };
    });
    return { read, calls };
  }

  it('attributes a crontab entry whose creating session ran long before the panel opened', async () => {
    const { service } = sweepService({
      readToolUsesFrom: async () => ({ rows: [EVIDENCE], next: { createdAt: 0, id: '0' }, exhausted: true }),
    });

    const list = await refreshed(service);

    expect(list.entries.map((entry) => entry.ownerSessionId)).toEqual(['session-a']);
    expect(list.unrelatedCount).toBe(0);
    expect(list.pendingCount).toBe(0);
  });

  it('keeps an entry without evidence pending until its window closes, then counts it unrelated', async () => {
    let nowMs = T0;
    const { read } = history([]);
    const { service, ledger } = sweepService({ readToolUsesFrom: read, now: () => nowMs });

    const first = await service.refresh();
    expect(first).toMatchObject({ retryAfterMs: 30_000 });
    expect(first.snapshot).toMatchObject({ entries: [], unrelatedCount: 0, pendingCount: 1 });
    expect(ledger.getMissMtime('cron-entry:4f2a')).toBeNull();

    nowMs = T0 + ATTRIBUTION_WINDOW_MS;
    const second = await refreshed(service);
    expect(second).toMatchObject({ entries: [], unrelatedCount: 1, pendingCount: 0 });
    expect(ledger.getMissMtime('cron-entry:4f2a')).toBe(T0);
  });

  it('picks up evidence that lands after the history was read to the end', async () => {
    // 会话的工具调用行比第一次扫描晚落库：先读到头，证据之后才出现。
    const pages: ToolMessageRow[][] = [filler];
    const { read, calls } = history(pages);
    const { service } = sweepService({ readToolUsesFrom: read, now: () => T0 });
    expect((await refreshed(service)).pendingCount).toBe(1);
    const readsBefore = calls.length;

    // 还没有新行时再拉一次：读到的是空页，位置必须留在最后一行上。
    expect((await refreshed(service)).pendingCount).toBe(1);
    expect(calls).toHaveLength(readsBefore + 1);
    expect(calls[readsBefore]).toEqual({ createdAt: 0, id: '0' });

    pages.push([EVIDENCE]);
    const third = await refreshed(service);

    expect(third.entries.map((entry) => entry.ownerSessionId)).toEqual(['session-a']);
    // 读到头之后从停下的位置接着读：不把整段历史重读一遍（命中翻倍、冷盘时每次都很慢）。
    expect(calls).toHaveLength(readsBefore + 2);
    expect(calls[readsBefore + 1]).toEqual({ createdAt: 0, id: '0' });
  });

  it('reads once more before recording a miss, even when the wait has already run out', async () => {
    // 读到头之后、等待期结束之前落库的证据：下一次轮询恰好过了等待期时，不能拿上一轮的
    // 「没命中」直接记成无关 —— 那是长期结论，刷新也不会再查，条目从此被藏起来。
    const pages: ToolMessageRow[][] = [[toolUse('session-x', 'ls')]];
    const { read, calls } = history(pages);
    let nowMs = T0;
    const { service, ledger } = sweepService({ readToolUsesFrom: read, now: () => nowMs });
    expect((await refreshed(service)).pendingCount).toBe(1);

    pages.push([EVIDENCE]);
    nowMs = T0 + ATTRIBUTION_WINDOW_MS + 1;
    const list = await refreshed(service);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ createdAt: 0, id: '0' });
    expect(list).toMatchObject({ unrelatedCount: 0, pendingCount: 0 });
    expect(list.entries.map((entry) => entry.ownerSessionId)).toEqual(['session-a']);
    expect(ledger.getMissMtime('cron-entry:4f2a')).toBeNull();
  });

  it('a lane that was not read this pass draws no conclusion', async () => {
    // 两条条目先后出现，各占一条通道。时间窗关闭后的那一轮，前一条通道读到一大段新行、
    // 用完了预算，后一条通道这一轮根本没读：它上一轮的「读到头」不能拿来下结论。
    const other = cronEntry({
      id: 'cron-entry:9c1d',
      name: 'sync.sh',
      command: '/usr/local/bin/sync.sh',
      attributionNeedles: ['/usr/local/bin/sync.sh'],
    });
    let more = false;
    const pages: ToolMessageRow[][] = [filler, filler.slice(0, -1)];
    const { read } = history(pages);
    let nowMs = T0;
    const { service, ledger } = sweepService({
      // 「读清单」也会扫描一次，所以第二条条目的出现不能按扫描次数数。
      daemons: () => (more ? [cronEntry(), other] : [cronEntry()]),
      readToolUsesFrom: async (after) => {
        // 冷盘：每页都读得很慢，一次 list 最多读两页。
        nowMs += 1_001;
        return read(after);
      },
      now: () => nowMs,
    });

    expect((await refreshed(service)).pendingCount).toBe(1);
    more = true;
    expect((await refreshed(service)).pendingCount).toBe(2);
    // 第 3 轮结束时两条通道都读到了头，只是时间窗还开着，所以都没有结论。
    expect((await refreshed(service)).pendingCount).toBe(2);

    // 等待期过后，历史里多出一大段谁都没读过的行。
    pages.push(filler, filler);
    nowMs = T0 + ATTRIBUTION_WINDOW_MS + 10_000;
    const list = await refreshed(service);

    expect(list).toMatchObject({ entries: [], unrelatedCount: 0, pendingCount: 2 });
    expect(ledger.getMissMtime('cron-entry:4f2a')).toBeNull();
    expect(ledger.getMissMtime('cron-entry:9c1d')).toBeNull();
  });

  it('still reads history when the scan itself took longer than the read budget', async () => {
    // 一次扫描要一秒多、冷盘时更久：预算若从 list 一开始算，轮到回看时早已用完，一页
    // 都读不了，界面却被告知「有进展、马上再来」，待核对的条目永远挂着。
    let clock = T0;
    const { read, calls } = history([[EVIDENCE]]);
    const { service } = sweepService({
      daemons: () => {
        clock += 60_000;
        return [cronEntry()];
      },
      readToolUsesFrom: read,
      now: () => clock,
    });

    const list = await refreshed(service);

    expect(calls.length).toBeGreaterThan(0);
    expect(list.entries.map((entry) => entry.ownerSessionId)).toEqual(['session-a']);
  });

  it('reads on from where the previous list stopped instead of starting over', async () => {
    // 一次 list 最多读 300 页，证据在第 301 页。每轮都从头读的话，每轮都停在同一处。
    const pages = [...Array.from({ length: 300 }, () => filler), [EVIDENCE]];
    const { read, calls } = history(pages);
    const { service } = sweepService({ readToolUsesFrom: read, now: () => T0 });

    expect((await refreshed(service)).pendingCount).toBe(1);
    expect(calls).toHaveLength(300);

    const second = await refreshed(service);
    expect(second.entries.map((entry) => entry.ownerSessionId)).toEqual(['session-a']);
    expect(calls[300]).toEqual({ createdAt: 299, id: '299' });
  });

  it('decides the owner only after the whole history was read, not on the first hit', async () => {
    // 会话 a 在最早一页命中 1 次，会话 b 在后面的页里命中 2 次。读到一页有命中就下
    // 结论的话，归属会给 a，而且记了账之后不会再改。
    const pages: ToolMessageRow[][] = [
      [EVIDENCE, ...filler.slice(1)],
      filler,
      [
        ...filler.slice(0, -3),
        toolUse('session-b', `crontab -l | grep -F '${COMMAND}'`),
        toolUse('session-b', `(crontab -l; echo '${COMMAND}') | crontab -`),
      ],
    ];
    const { read, calls } = history(pages);
    // 冷盘：每页都读得很慢，一次 list 读完一页预算就没了。
    let clock = T0;
    const { service, ledger } = sweepService({
      readToolUsesFrom: async (after) => {
        clock += 60_000;
        return read(after);
      },
      now: () => clock,
    });

    const first = await refreshed(service);
    expect(calls).toHaveLength(1);
    expect(first).toMatchObject({ entries: [], pendingCount: 1 });
    expect(ledger.getOwner('cron-entry:4f2a')).toBeNull();

    const second = await refreshed(service);
    expect(second).toMatchObject({ entries: [], pendingCount: 1 });
    expect(ledger.getOwner('cron-entry:4f2a')).toBeNull();

    const third = await refreshed(service);
    expect(calls).toHaveLength(3);
    expect(third.entries.map((entry) => entry.ownerSessionId)).toEqual(['session-b']);
    expect(ledger.getOwner('cron-entry:4f2a')).toMatchObject({ sessionId: 'session-b' });
  });

  it('keeps an entry pending after its window closed while the history is still unread', async () => {
    // 冷盘大库：一次 list 读不完（单次有页数上限，现为 300）。时间窗关了也不能就地记
    // 「无关」——证据可能在还没读到的页里，记了 miss 就是永久停在「无关」。
    const pages: ToolMessageRow[][] = Array.from({ length: 601 }, () => filler);
    pages.push([EVIDENCE]);
    let clock = T0;
    const { read } = history(pages);
    const { service, ledger } = sweepService({ readToolUsesFrom: read, now: () => clock });

    expect(await refreshed(service)).toMatchObject({ unrelatedCount: 0, pendingCount: 1 });

    clock = T0 + ATTRIBUTION_WINDOW_MS;
    expect(await refreshed(service)).toMatchObject({ unrelatedCount: 0, pendingCount: 1 });
    expect(ledger.getMissMtime('cron-entry:4f2a')).toBeNull();

    const third = await refreshed(service);
    expect(third.entries.map((entry) => entry.ownerSessionId)).toEqual(['session-a']);
  });

  it('records nothing when the history cannot be read, and attributes once it can', async () => {
    const { read } = history([[EVIDENCE]]);
    read.mockRejectedValueOnce(new Error('database is busy'));
    // 时间窗已经关上：此刻挡在「无关」结论前面的只有「历史没读成」这一条。
    const { service, ledger } = sweepService({
      readToolUsesFrom: read,
      now: () => T0 + ATTRIBUTION_WINDOW_MS,
    });

    const first = await service.refresh();
    expect(first).toMatchObject({ retryAfterMs: 15_000 });
    expect(first.snapshot).toMatchObject({ entries: [], unrelatedCount: 0, pendingCount: 1 });
    expect(ledger.getMissMtime('cron-entry:4f2a')).toBeNull();

    const second = await refreshed(service);
    expect(second.entries.map((entry) => entry.ownerSessionId)).toEqual(['session-a']);
  });

  it('keeps the read progress of entries in a source that could not be scanned this round', async () => {
    // 来源时好时坏的机器：这一轮读不了，条目没被扫到。这不算「已删除」，已读过的页
    // 也不能作废，否则历史永远读不完、条目永远挂在核对中。
    const pages: ToolMessageRow[][] = [filler, filler, [...filler.slice(0, -2), EVIDENCE]];
    const { read, calls } = history(pages);
    let clock = T0;
    let unread = false;
    const { service, ledger } = sweepService({
      unread: () => unread,
      readToolUsesFrom: async (after) => {
        // 冷盘：每页都读得很慢，一轮只读得到一页。
        clock += 60_000;
        return read(after);
      },
      now: () => clock,
    });

    await refreshed(service);
    await refreshed(service);
    expect(calls).toHaveLength(2);
    expect(ledger.getOwner('cron-entry:4f2a')).toBeNull();

    unread = true;
    // 没读到不算没事可做：来源恢复后要自己回到清单，所以仍然排下一轮。
    expect(await service.refresh()).toMatchObject({
      retryAfterMs: 15_000,
      snapshot: { entries: [], pendingCount: 0, incomplete: true },
    });

    unread = false;
    expect((await refreshed(service)).entries.map((entry) => entry.ownerSessionId)).toEqual([
      'session-a',
    ]);
    // 三页历史对应三次读取：读不全的那一轮之后没有从最早一页重读。
    expect(calls.map((after) => after?.id ?? null)).toEqual([null, '0', '1']);
  });

  it('drops the pass when the account changes while the history is being read', async () => {
    let scope = 'account-a';
    let reads = 0;
    const { read } = history([[EVIDENCE]]);
    const { service, ledger } = sweepService({
      readToolUsesFrom: async (after) => {
        reads += 1;
        // 新账号的历史里没有这一条的证据。
        if (reads >= 2) return { rows: [], next: null, exhausted: true };
        const page = await read(after);
        scope = 'account-b';
        return page;
      },
      now: () => T0,
      ownerScopeKey: () => scope,
    });

    const first = await refreshed(service);
    expect(first).toMatchObject({ supported: true, entries: [], pendingCount: 1 });
    expect(ledger.owners.size).toBe(0);

    // 旧账号读到的那一页不能变成新账号的归属结论。
    const second = await refreshed(service);
    expect(second).toMatchObject({ entries: [], pendingCount: 1 });
    expect(ledger.owners.size).toBe(0);
  });

  it('returns no entries when the account changes while the history is being read', async () => {
    let scope = 'account-a';
    const TASK = 'Cindy-7671-probe';
    const { read } = history([filler]);
    const { service, ledger } = sweepService({
      daemons: () => [
        {
          id: 'scheduled-task:1',
          name: TASK,
          kind: 'scheduled-task',
          state: 'ready',
          trigger: 'logon',
          attributionNeedles: [TASK],
          definitionMtimeMs: T0 - 60_000,
          lastRunAtMs: null,
          stoppable: true,
          command: `schtasks /create /tn ${TASK}`,
        },
        cronEntry(),
      ],
      readToolUses: async () => windowOf([toolUse('session-a', `schtasks /create /tn ${TASK}`)]),
      readToolUsesFrom: async (after) => {
        // 计划任务已在本轮归属；读到回看的第一页时账号切换。
        scope = 'account-b';
        return read(after);
      },
      now: () => T0,
      ownerScopeKey: () => scope,
    });

    const list = await refreshed(service);

    // 旧账号的任务标题不能跟着「已归属」的条目回到界面；新账号下两条都还没有结论。
    expect(list).toMatchObject({ supported: true, entries: [], pendingCount: 2 });
    expect(ledger.owners.size).toBe(0);
  });

  it('never feeds the same page of history to two overlapping lists', async () => {
    const { read, calls } = history([filler, [EVIDENCE]]);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstReadStarted = () => {};
    const started = new Promise<void>((resolve) => {
      firstReadStarted = resolve;
    });
    const { service } = sweepService({
      readToolUsesFrom: async (after) => {
        if (calls.length === 0) {
          firstReadStarted();
          await gate;
        }
        return read(after);
      },
      now: () => T0,
    });

    // 第一次 list 停在读第一页的途中，第二次 list 进来。
    const first = refreshed(service);
    await started;
    const second = refreshed(service);
    release();
    const [firstList, secondList] = await Promise.all([first, second]);

    expect(firstList.entries.map((entry) => entry.ownerSessionId)).toEqual(['session-a']);
    expect(secondList.entries.map((entry) => entry.ownerSessionId)).toEqual(['session-a']);
    expect(calls.filter((after) => after === null)).toHaveLength(1);
  });

  it('keeps the progress and anchor of a pass that failed midway', async () => {
    let nowMs = T0;
    let reads = 0;
    const { read, calls } = history([filler, [EVIDENCE]]);
    const { service, ledger } = sweepService({
      readToolUsesFrom: async (after) => {
        reads += 1;
        if (reads === 2) throw new Error('database is busy');
        return read(after);
      },
      now: () => nowMs,
    });

    expect((await refreshed(service)).pendingCount).toBe(1);
    expect(ledger.getFirstSeen('cron-entry:4f2a')).toBe(T0);

    nowMs = T0 + 1;
    const second = await refreshed(service);
    expect(second.entries.map((entry) => entry.ownerSessionId)).toEqual(['session-a']);
    // 第二轮从第一轮停下的位置接着读；锚点换了值才会让进度作废、从头再来。
    expect(calls).toEqual([null, { createdAt: 0, id: '0' }]);
  });

  it('starts a newly seen entry from the oldest page without resetting the others', async () => {
    const pages = [...Array.from({ length: 300 }, () => filler), [EVIDENCE]];
    const { read, calls } = history(pages);
    let daemons = [cronEntry()];
    const { service } = sweepService({
      daemons: () => daemons,
      readToolUsesFrom: read,
      now: () => T0,
    });
    expect((await refreshed(service)).pendingCount).toBe(1);

    daemons = [
      cronEntry(),
      cronEntry({
        id: 'cron-entry:9c31',
        name: 'sync.sh',
        command: '/usr/local/bin/sync.sh',
        attributionNeedles: ['0 3 * * * /usr/local/bin/sync.sh'],
      }),
    ];
    const second = await refreshed(service);

    expect(second.entries.map((entry) => entry.ownerSessionId)).toEqual(['session-a']);
    expect(second.pendingCount).toBe(1);
    expect(calls.slice(300, 302)).toEqual([{ createdAt: 299, id: '299' }, null]);
  });
});

describe('归属证据读取（内存库，走生产查询入口）', () => {
  // 规则依据：「查无归属」是长期结论，前提是历史确实读完了。分页游标漏一行或重读
  // 一行、把命令输出或远端会话当证据，都会直接变成错误的归属或错误的「无关」。
  // 最小失败输入：同一时刻落库的多行（只按时间翻页会漏）；读到头之后才落库的行。
  function installDb() {
    const raw = new Database(':memory:');
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, remote_host_id TEXT);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE session_imports (session_id TEXT PRIMARY KEY, imported_at INTEGER NOT NULL);
    `);
    setCurrentDbClient({ drizzle: drizzle(raw, { schema }) } as unknown as DbClient, 'owner');
    return {
      raw,
      session: (id: string, remoteHostId: string | null = null) =>
        raw.prepare('INSERT INTO sessions (id, title, remote_host_id) VALUES (?, ?, ?)').run(id, `任务 ${id}`, remoteHostId),
      message: (row: { id: string; sessionId: string; role: string; content: string; createdAt: number }) =>
        raw
          .prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(row.id, row.sessionId, row.role, row.content, row.createdAt),
      importSession: (sessionId: string, importedAt: number) =>
        raw.prepare('INSERT INTO session_imports (session_id, imported_at) VALUES (?, ?)').run(sessionId, importedAt),
    };
  }

  const contents = (rows: ToolMessageRow[]) => rows.map((row) => row.content);
  /** crontab 里的原始行：带引号，存进消息库的 JSON 后引号会变成转义形态。 */
  const QUOTED_LINE = '*/5 * * * * /usr/bin/python3 -c "print(\\"ok\\")"';

  /** 会话当时交给 bash 的命令：整行原样写在 `input.command` 里（真实存储形态）。 */
  function storedToolUse(id: string, command: string) {
    return JSON.stringify({ toolUseId: `call_${id}`, toolName: 'bash', input: { command } });
  }

  it('比对的是解码后实际交给工具的命令：带引号、反斜杠的条目不会被判成「无关」', async () => {
    const db = installDb();
    try {
      db.session('s1');
      db.message({
        id: 't1',
        sessionId: 's1', role: 'tool_use', createdAt: 1000,
        content: storedToolUse('t1', `(crontab -l; echo '${QUOTED_LINE}') | crontab -`),
      });

      const page = await readToolUsesFrom(null);

      expect(contents(page.rows)).toEqual([`(crontab -l; echo '${QUOTED_LINE}') | crontab -`]);
      expect(pickOwnerSession(page.rows, [QUOTED_LINE])?.sessionId).toBe('s1');
      // 存储原文里引号是转义形态：拿原始行直接去比对，永远对不上。
      expect(storedToolUse('t1', QUOTED_LINE).includes(QUOTED_LINE)).toBe(false);
    } finally {
      clearCurrentDbClient();
      db.raw.close();
    }
  });

  it('从库里的转义存储一直到清单：带引号的 crontab 条目能归属，不会被记成无关', async () => {
    const db = installDb();
    try {
      db.session('s1');
      db.message({
        id: 't1',
        sessionId: 's1', role: 'tool_use', createdAt: 1000,
        content: storedToolUse('t1', `(crontab -l; echo '${QUOTED_LINE}') | crontab -`),
      });
      const daemon: RawHostDaemon = {
        id: 'cron-entry:quoted',
        name: 'python3 -c',
        kind: 'cron-entry',
        state: 'unknown',
        command: '/usr/bin/python3 -c "print(\\"ok\\")"',
        trigger: 'schedule',
        attributionNeedles: [QUOTED_LINE],
        definitionMtimeMs: null,
        lastRunAtMs: null,
        stoppable: false,
      };
      const ledger = memoryLedger();
      const service = createHostDaemonsService({
        target: {
          scan: async () => scanned([daemon]),
          stop: async () => {},
          run: async () => {},
          remove: async () => {},
        },
        readToolUses,
        readToolUsesFrom,
        ledger,
        now: () => 2000,
      });

      const list = await refreshed(service);

      expect(list).toMatchObject({
        entries: [{ id: 'cron-entry:quoted', ownerSessionId: 's1' }],
        unrelatedCount: 0,
        pendingCount: 0,
      });
      expect(ledger.getMissMtime('cron-entry:quoted')).toBeNull();
    } finally {
      clearCurrentDbClient();
      db.raw.close();
    }
  });

  it('同一时刻落库的多行按游标逐页读完，不漏不重；读到头后晚落库的行从游标接着读到', async () => {
    const db = installDb();
    try {
      db.session('s1');
      for (let i = 0; i < 5; i += 1) {
        db.message({ id: `m${i}`, sessionId: 's1', role: 'tool_use', content: `cmd ${i}`, createdAt: 1000 });
      }

      const seen: string[] = [];
      let after: ToolUseCursor | null = null;
      let lastPage: ToolMessagePage | undefined;
      for (let page = 0; page < 10 && lastPage?.exhausted !== true; page += 1) {
        lastPage = await readToolUsesFrom(after, 2);
        seen.push(...contents(lastPage.rows));
        after = lastPage.next;
      }
      expect(lastPage?.exhausted).toBe(true);
      expect(seen).toEqual(['cmd 0', 'cmd 1', 'cmd 2', 'cmd 3', 'cmd 4']);

      db.message({ id: 'm5', sessionId: 's1', role: 'tool_use', content: 'cmd 5', createdAt: 1000 });
      const next = await readToolUsesFrom(after, 2);
      expect(contents(next.rows)).toEqual(['cmd 5']);
      expect(next.exhausted).toBe(true);
    } finally {
      clearCurrentDbClient();
      db.raw.close();
    }
  });

  it('只把 tool_use 当证据：命令输出与用户消息里出现的同名条目不算', async () => {
    const db = installDb();
    try {
      const NAME = 'Cindy-Backup';
      db.session('s1');
      db.message({ id: 'u1', sessionId: 's1', role: 'user', content: `帮我把 ${NAME} 加进 crontab`, createdAt: 1000 });
      db.message({ id: 't1', sessionId: 's1', role: 'tool_use', content: '{"command":"crontab -l"}', createdAt: 1001 });
      db.message({ id: 'r1', sessionId: 's1', role: 'tool_result', content: `* * * * * ${NAME} run`, createdAt: 1002 });

      const window = await readToolUses(0, 2000);
      expect(contents(window.rows)).toEqual(['crontab -l']);
      expect(window.truncated).toBe(false);
      const page = await readToolUsesFrom(null);
      expect(contents(page.rows)).toEqual(['crontab -l']);
      expect(page.exhausted).toBe(true);
    } finally {
      clearCurrentDbClient();
      db.raw.close();
    }
  });

  it('不把远端会话的工具调用、以及导入会话在导入时刻之前的消息当本机证据', async () => {
    const db = installDb();
    try {
      db.session('local');
      db.session('remote', 'host-b');
      db.session('imported');
      db.importSession('imported', 2000);
      db.message({ id: 'm1', sessionId: 'local', role: 'tool_use', content: 'echo local', createdAt: 1000 });
      db.message({ id: 'm2', sessionId: 'remote', role: 'tool_use', content: 'echo remote', createdAt: 1001 });
      db.message({ id: 'm3', sessionId: 'imported', role: 'tool_use', content: 'echo imported-old', createdAt: 1002 });
      db.message({ id: 'm4', sessionId: 'imported', role: 'tool_use', content: 'echo imported-new', createdAt: 3000 });

      const window = await readToolUses(0, 4000);
      expect(contents(window.rows)).toEqual(['echo local', 'echo imported-new']);
      const page = await readToolUsesFrom(null);
      expect(contents(page.rows)).toEqual(['echo local', 'echo imported-new']);
    } finally {
      clearCurrentDbClient();
      db.raw.close();
    }
  });

  it('时间窗读取只返回窗内的行，超过上限时如实报截断', async () => {
    const db = installDb();
    try {
      db.session('s1');
      [1000, 1100, 1200, 1300, 5000].forEach((createdAt, i) =>
        db.message({ id: `m${i}`, sessionId: 's1', role: 'tool_use', content: `cmd ${createdAt}`, createdAt }),
      );

      const truncated = await readToolUses(900, 1400, 3);
      expect(contents(truncated.rows)).toEqual(['cmd 1000', 'cmd 1100', 'cmd 1200']);
      expect(truncated.truncated).toBe(true);
      const complete = await readToolUses(900, 1400, 5);
      expect(contents(complete.rows)).toEqual(['cmd 1000', 'cmd 1100', 'cmd 1200', 'cmd 1300']);
      expect(complete.truncated).toBe(false);
    } finally {
      clearCurrentDbClient();
      db.raw.close();
    }
  });
});

describe('扫描不完整时不下结论；清单只来自一轮更新', () => {
  const T0 = 1_800_000_000_000;
  const COMMAND = '*/5 * * * * /usr/local/bin/backup.sh';
  const ID = 'cron-entry:4f2a';
  const EVIDENCE = toolUse('session-a', `(crontab -l; echo '${COMMAND}') | crontab -`);

  function cronEntry(overrides: Partial<RawHostDaemon> = {}): RawHostDaemon {
    return {
      id: ID,
      name: 'backup.sh',
      kind: 'cron-entry',
      state: 'unknown',
      command: '/usr/local/bin/backup.sh',
      trigger: 'schedule',
      attributionNeedles: [COMMAND],
      definitionMtimeMs: null,
      lastRunAtMs: null,
      stoppable: false,
      ...overrides,
    };
  }

  /** 历史替身：页不足一页 = 读到头；`reads` 记下读取次数。 */
  function historyOf(pages: ToolMessageRow[][]) {
    const reads: Array<ToolUseCursor | null> = [];
    const read = vi.fn(async (after: ToolUseCursor | null): Promise<ToolMessagePage> => {
      reads.push(after);
      const index = after ? Number(after.id) + 1 : 0;
      const rows = pages[index] ?? [];
      const last = rows.at(-1);
      return {
        rows,
        next: last ? { createdAt: index, id: String(index) } : null,
        exhausted: rows.length < TOOL_MESSAGE_PAGE_LIMIT,
      };
    });
    return { read, reads };
  }

  function serviceOf(init: {
    scan: () => Promise<HostDaemonScan>;
    pages: ToolMessageRow[][];
    now?: () => number;
  }) {
    const ledger = memoryLedger();
    const { read, reads } = historyOf(init.pages);
    const service = createHostDaemonsService({
      target: { scan: init.scan, stop: async () => {}, run: async () => {}, remove: async () => {} },
      readToolUses: async () => windowOf([]),
      readToolUsesFrom: read,
      ledger,
      now: init.now,
    });
    return { service, ledger, reads };
  }

  it('crontab 读失败时保留条目的记录，读恢复后仍按原归属列出', async () => {
    // 评审场景（crontab.ts）：`crontab -l` 失败一次，条目没被扫到。把「没扫到」当成
    // 「已删除」去清首次扫到时刻的话，读恢复后锚点变了，旧归属对不上；原会话已删、
    // 证据找不回，仍在运行的常驻项就永久退出清单。
    let readable = true;
    let nowMs = T0;
    const pages: ToolMessageRow[][] = [[EVIDENCE]];
    const { service, ledger } = serviceOf({
      scan: async () => (readable ? scanned([cronEntry()]) : { entries: [], unread: ['cron-entry:'] }),
      pages,
      now: () => nowMs,
    });
    expect((await refreshed(service)).entries.map((entry) => entry.ownerSessionId)).toEqual(['session-a']);

    // 原会话已删除：历史里再也没有证据。
    pages.length = 0;
    readable = false;
    nowMs += 60_000;
    expect(await refreshed(service)).toMatchObject({ entries: [], incomplete: true });
    expect(ledger.getFirstSeen(ID)).toBe(T0);
    expect(ledger.getOwner(ID)?.sessionId).toBe('session-a');

    nowMs += 60_000;
    readable = true;
    const recovered = await refreshed(service);
    expect(recovered.entries.map((entry) => entry.ownerSessionId)).toEqual(['session-a']);
    expect(recovered.incomplete).toBe(false);
  });

  it('完整扫描确认条目已删除时才结束它这一代', async () => {
    let present = true;
    const { service, ledger } = serviceOf({
      scan: async () => scanned(present ? [cronEntry()] : []),
      pages: [[EVIDENCE]],
      now: () => T0,
    });
    await service.refresh();
    expect(ledger.getFirstSeen(ID)).toBe(T0);

    present = false;
    await service.refresh();
    expect(ledger.getFirstSeen(ID)).toBeNull();
  });

  it('更新回执之外没有会写台账或读历史的接口：清单只来自一轮更新（规范 §8.2 的验收）', async () => {
    let nowMs = T0;
    const other = cronEntry({ id: 'cron-entry:9c31', command: '/usr/local/bin/report.sh', attributionNeedles: ['0 9 * * 1 /usr/local/bin/report.sh'] });
    const { service, ledger, reads } = serviceOf({
      scan: async () => scanned([cronEntry(), other]),
      pages: [[EVIDENCE]],
      now: () => nowMs,
    });
    // 种下两种状态：一条已归属，一条没证据、时间窗还开着。
    const seeded = await refreshed(service);
    expect(seeded).toMatchObject({ pendingCount: 1 });

    const writes: string[] = [];
    for (const name of ['setOwner', 'clearOwner', 'setMissMtime', 'setFirstSeen', 'retireFirstSeen', 'save'] as const) {
      const original = ledger[name] as (...args: never[]) => unknown;
      (ledger as unknown as Record<string, unknown>)[name] = (...args: never[]) => {
        writes.push(name);
        return original(...args);
      };
    }
    const readsBefore = reads.length;
    // 剩下唯一会动常驻项的接口是动作。对一条没有归属的条目，动作必须被拒绝，
    // 且拒绝它的过程既不写台账、也不读历史。
    nowMs += ATTRIBUTION_WINDOW_MS + 1;
    await expect(service.stop('cron-entry:9c31')).rejects.toBeInstanceOf(HostDaemonActionError);
    expect(writes).toEqual([]);
    expect(reads).toHaveLength(readsBefore);

    // 把「没证据」落成记录只发生在下一轮更新里。
    expect(await refreshed(service)).toMatchObject({ unrelatedCount: 1, pendingCount: 0 });
    expect(writes).toContain('setMissMtime');
  });

  it('一个来源读不了时，别的来源照常列出并如实标记清单不完整', async () => {
    const unit = cronEntry({
      id: 'systemd-unit:backup.timer',
      name: 'backup.timer',
      kind: 'systemd-unit',
      trigger: 'schedule',
      attributionNeedles: ['backup.timer'],
      definitionMtimeMs: T0,
      stoppable: true,
    });
    const target = combineHostDaemonAdapters([
      { idPrefix: 'systemd-unit:', scan: async () => [unit], stop: async () => {}, run: async () => {}, remove: async () => {} },
      {
        idPrefix: 'cron-entry:',
        scan: async () => {
          throw new Error('crontab -l failed (1): Permission denied');
        },
        stop: async () => {},
        run: async () => {},
        remove: async () => {},
      },
    ]);
    const ledger = memoryLedger();
    ledger.setOwner(unit.id, {
      sessionId: 'session-b',
      title: null,
      atMs: T0,
      definitionMtimeMs: T0,
      command: unit.command,
    });
    const service = createHostDaemonsService({
      target,
      ledger,
      readToolUses: async () => windowOf([]),
      readToolUsesFrom: async () => ({ rows: [], next: null, exhausted: true }),
      now: () => T0,
    });

    expect(await refreshed(service)).toMatchObject({
      entries: [expect.objectContaining({ id: 'systemd-unit:backup.timer', ownerSessionId: 'session-b' })],
      incomplete: true,
    });
  });
});
