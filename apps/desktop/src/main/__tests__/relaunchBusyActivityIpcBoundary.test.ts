/**
 * 手动重启阻断查询的授权边界。
 *
 * 这个 handler 读的是**全局**会话 / Claude / Ghost / scheduler 活动态。带 preload 的窗口被
 * 导航到不可信内容、WebView、子 frame 都能发 Electron IPC,不校验 sender 就等于把「本机现在
 * 在跑什么」暴露给它们。按 docs/dev-rules/electron-security-and-process-boundaries.md §5,
 * 新增 handler 不得以「旧代码没校验」为由省略 sender 验证 —— 这里把它钉住。
 *
 * 另一条要钉的:**断言必须发生在读取任何跟踪器之前**。先读后拦仍然会碰全局状态(也可能被
 * 时序侧信道观察到),所以拒绝路径下的来源读取次数必须是 0。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  trusted: true,
  reads: 0,
  turnReads: 0,
  selects: 0,
  dbRows: [] as unknown[],
  dbError: null as Error | null,
  dbHang: false,
  removed: [] as string[],
  log: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// 仿 Electron 的真实行为:同一 channel 第二次 handle 直接抛。幂等注册要靠 removeHandler,
// 用一个只会 set 的假 Map 是测不出来的。
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      if (h.handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      }
      h.handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      h.removed.push(channel);
      h.handlers.delete(channel);
    }),
  },
}));
vi.mock('../logger', () => ({
  createLogger: () => h.log,
}));
vi.mock('../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: () => {
    if (!h.trusted) throw new Error('[PERMISSION_DENIED] 此操作只能从 Cindy 主页面发起');
  },
}));
vi.mock('../localDb/client/current', () => ({
  getDbClient: () => {
    if (h.dbError) throw h.dbError;
    const chain = {
      from: () => chain,
      leftJoin: () => chain,
      where: () => (h.dbHang ? new Promise(() => {}) : Promise.resolve(h.dbRows)),
    };
    return { drizzle: { select: () => { h.selects += 1; return chain; } } };
  },
}));

import {
  RELAUNCH_BLOCKING_ACTIVITY_CHANNEL,
  RELAUNCH_BLOCKING_SUMMARY_CHANNEL,
  readRelaunchBackgroundActivity,
  readRelaunchBlockingActivity,
  registerRelaunchBusyActivityIpc,
} from '../relaunchBusyActivityIpc.js';
import { RELAUNCH_TURN_FACTS_BUDGET_MS, readRelaunchTurnFacts } from '../relaunchTurnFacts.js';

/** 每个来源都记一次读取,用来证明拒绝路径下一个都没被碰。 */
function countingSources(busy: boolean) {
  return () => ({
    anySessionInTurn: (): boolean => { h.reads += 1; return busy; },
    listClaudeBackgroundSessions: (): readonly string[] => { h.reads += 1; return []; },
    anyGhostSessionBusy: (): boolean => { h.reads += 1; return false; },
    anyBackgroundBashRunning: (): boolean => { h.reads += 1; return false; },
    anyCindySlotJobRunning: (): boolean => { h.reads += 1; return false; },
    anyPiSubagentRunning: (): boolean => { h.reads += 1; return false; },
    anySchedulerRunRunning: async (): Promise<boolean> => { h.reads += 1; return false; },
  });
}

/** handler 只把 event 交给 sender 断言(已被 mock),不读它的字段。 */
const fakeEvent = {} as never;

beforeEach(() => {
  h.handlers.clear();
  h.trusted = true;
  h.reads = 0;
  h.turnReads = 0;
  h.selects = 0;
  h.dbRows = [];
  h.dbError = null;
  h.dbHang = false;
  h.removed = [];
  h.log.info.mockClear();
});

describe('registerRelaunchBusyActivityIpc', () => {
  it('注册在约定的 channel 上', () => {
    registerRelaunchBusyActivityIpc(countingSources(false));
    expect(h.handlers.has(RELAUNCH_BLOCKING_ACTIVITY_CHANNEL)).toBe(true);
  });

  it('可信 sender:正常返回判定结果', async () => {
    registerRelaunchBusyActivityIpc(countingSources(true));
    const handler = h.handlers.get(RELAUNCH_BLOCKING_ACTIVITY_CHANNEL)!;
    await expect(handler(fakeEvent)).resolves.toBe(true);
    expect(h.reads).toBeGreaterThan(0);
  });

  // splash 首次失败会整段重试注册(bootstrap-electron 那个 catch 明写「下次 splash retry
  // 再尝试」),此时 makerIpcsRegistered 仍是 false。若不幂等,第二次 handle 抛出的异常会
  // 把排在后面的全部 maker IPC 注册一起掀掉,且每次重试都卡在同一行。
  it('重复注册不抛错（splash 重试路径），且 handler 仍然可用', async () => {
    registerRelaunchBusyActivityIpc(countingSources(true));
    expect(() => registerRelaunchBusyActivityIpc(countingSources(true))).not.toThrow();
    expect(h.removed).toContain(RELAUNCH_BLOCKING_ACTIVITY_CHANNEL);

    const handler = h.handlers.get(RELAUNCH_BLOCKING_ACTIVITY_CHANNEL)!;
    await expect(handler(fakeEvent)).resolves.toBe(true);
  });

  it('busy 的手动查询打 INFO', async () => {
    registerRelaunchBusyActivityIpc(countingSources(true));
    const handler = h.handlers.get(RELAUNCH_BLOCKING_ACTIVITY_CHANNEL)!;
    await expect(handler(fakeEvent)).resolves.toBe(true);
    expect(h.log.info).toHaveBeenCalledTimes(1);
    expect(h.log.info.mock.calls[0]?.[0]).toBe('manual relaunch has live activity');
  });

  it('silent:true 的 busy 结果不打 INFO（横幅延后轮询）', async () => {
    registerRelaunchBusyActivityIpc(countingSources(true));
    const handler = h.handlers.get(RELAUNCH_BLOCKING_ACTIVITY_CHANNEL)!;
    await expect(handler(fakeEvent, { silent: true })).resolves.toBe(true);
    expect(h.log.info).not.toHaveBeenCalled();
  });

  it('非 boolean true 的 silent 不当静默', async () => {
    registerRelaunchBusyActivityIpc(countingSources(true));
    const handler = h.handlers.get(RELAUNCH_BLOCKING_ACTIVITY_CHANNEL)!;
    await expect(handler(fakeEvent, { silent: 'true' })).resolves.toBe(true);
    expect(h.log.info).toHaveBeenCalledTimes(1);
  });

  it('不可信 sender(WebView / 子 frame / 未登记窗口):拒绝，且一个来源都不读', async () => {
    h.trusted = false;
    registerRelaunchBusyActivityIpc(countingSources(true));
    const handler = h.handlers.get(RELAUNCH_BLOCKING_ACTIVITY_CHANNEL)!;
    await expect(handler(fakeEvent)).rejects.toThrow('PERMISSION_DENIED');
    // 断言在读取之前 —— 拒绝路径下不该碰到任何全局跟踪器。
    expect(h.reads).toBe(0);
  });
});

describe('readRelaunchBackgroundActivity', () => {
  it('ignores model turns but still reads every background source, scheduler included', async () => {
    let schedulerRead = false;
    registerRelaunchBusyActivityIpc(() => ({
      ...countingSources(true)(),
      anySchedulerRunRunning: async () => { schedulerRead = true; return false; },
    }));
    await expect(readRelaunchBackgroundActivity()).resolves.toMatchObject({ busy: false });
    expect(schedulerRead).toBe(true);
  });

  it('reports background work a restart would stop', async () => {
    registerRelaunchBusyActivityIpc(() => ({
      ...countingSources(false)(),
      anyBackgroundBashRunning: () => true,
    }));
    await expect(readRelaunchBackgroundActivity()).resolves.toMatchObject({
      busy: true,
      reasons: ['background-bash'],
    });
  });
});


/**
 * 测试价值
 * - 生产入口与可观察结果：update-relaunch:blocking-summary 与 blocking-activity handler。
 *   侧栏确认能看到全部活动类别；旧调用方仍拿到布尔，busy:false 不会因为对象而被当成有活动。
 * - Bug／规则依据：issue #5265。reasons 以前只写日志，确认句无法区分伙伴回复和其它活动。
 * - 现有覆盖缺口：原用例只断言布尔 busy，没有摘要、脱敏名字，也没有「对象被当成 true」。
 * - 最小失败输入：session-in-turn 加 background-bash；或布尔通道在全空闲时被改成返回对象。
 * - tier：unit。handler 用注入来源，不碰真实数据库以外的 readRelaunchTurnFacts 假查询。
 */
describe('relaunch blocking summary', () => {
  function sources(overrides: Record<string, unknown> = {}) {
    return () => ({
      anySessionInTurn: (): boolean => false,
      listClaudeBackgroundSessions: (): readonly string[] => [],
      anyGhostSessionBusy: (): boolean => false,
      anyBackgroundBashRunning: (): boolean => false,
      anyCindySlotJobRunning: (): boolean => false,
      anyPiSubagentRunning: (): boolean => false,
      anySchedulerRunRunning: async (): Promise<boolean> => false,
      ...overrides,
    });
  }

  it('keeps the boolean channel a real boolean when nothing is running', async () => {
    registerRelaunchBusyActivityIpc(sources(), {
      describeTurns: async () => {
        h.turnReads += 1;
        return { companions: [{ name: 'Cindy' }], conversation: false };
      },
    });
    const handler = h.handlers.get(RELAUNCH_BLOCKING_ACTIVITY_CHANNEL)!;
    await expect(handler(fakeEvent)).resolves.toBe(false);
    expect(h.turnReads).toBe(0);
    const internal = await readRelaunchBlockingActivity();
    expect(internal).toEqual({ busy: false, reasons: [] });
  });

  it('lists every readable category and a visible teammate name, not the first hit only', async () => {
    registerRelaunchBusyActivityIpc(sources({
      anySessionInTurn: () => true,
      anyBackgroundBashRunning: () => true,
      anyCindySlotJobRunning: () => true,
      anyPiSubagentRunning: () => true,
      listClaudeBackgroundSessions: () => ['claude-session'],
      anyGhostSessionBusy: () => false,
    }), {
      describeTurns: async () => {
        h.turnReads += 1;
        return {
          companions: [{ name: 'Cindy' }, { name: 'Mika' }],
          conversation: true,
        };
      },
    });
    const handler = h.handlers.get(RELAUNCH_BLOCKING_SUMMARY_CHANNEL)!;
    const result = await handler(fakeEvent);
    expect(result).toEqual({
      busy: true,
      categories: [
        'companion',
        'conversation',
        'background-command',
        'generation',
        'subtask',
      ],
      companionNames: ['Cindy', 'Mika'],
    });
    expect(h.turnReads).toBe(1);
    expect(JSON.stringify(result)).not.toContain('claude-session');
    expect(JSON.stringify(h.log.info.mock.calls)).not.toContain('Cindy');
  });


  it('does not call an unspecified plugin action a generation', async () => {
    registerRelaunchBusyActivityIpc(sources({
      anyGhostSessionBusy: () => true,
      anyBackgroundBashRunning: () => true,
    }));
    const handler = h.handlers.get(RELAUNCH_BLOCKING_SUMMARY_CHANNEL)!;
    await expect(handler(fakeEvent)).resolves.toEqual({
      busy: true,
      categories: [],
      companionNames: [],
    });
    const booleanHandler = h.handlers.get(RELAUNCH_BLOCKING_ACTIVITY_CHANNEL)!;
    await expect(booleanHandler(fakeEvent)).resolves.toBe(true);
  });

  it('drops teammate names once listing them would hide the restart choice', async () => {
    registerRelaunchBusyActivityIpc(sources({ anySessionInTurn: () => true }), {
      describeTurns: async () => ({
        companions: [{ name: 'Ada' }, { name: 'Bea' }, { name: 'Cleo' }, { name: 'Dora' }],
        conversation: false,
      }),
    });
    const handler = h.handlers.get(RELAUNCH_BLOCKING_SUMMARY_CHANNEL)!;
    await expect(handler(fakeEvent)).resolves.toEqual({
      busy: true,
      categories: ['companion'],
      companionNames: [],
    });
  });

  it('reports a scheduled run when that is the activity', async () => {
    registerRelaunchBusyActivityIpc(sources({
      anySchedulerRunRunning: async () => true,
    }), {
      describeTurns: async () => {
        h.turnReads += 1;
        return { companions: [{ name: 'Cindy' }], conversation: true };
      },
    });
    const handler = h.handlers.get(RELAUNCH_BLOCKING_SUMMARY_CHANNEL)!;
    await expect(handler(fakeEvent)).resolves.toEqual({
      busy: true,
      categories: ['scheduled-task'],
      companionNames: [],
    });
    expect(h.turnReads).toBe(0);
  });

  it('drops unsafe names and keeps only the teammate category', async () => {
    registerRelaunchBusyActivityIpc(sources({ anySessionInTurn: () => true }), {
      describeTurns: async () => ({
        companions: [{ name: '3c4c962a-1111-4111-8111-111111111111' }, { name: 'Cindy' }],
        conversation: false,
      }),
    });
    const handler = h.handlers.get(RELAUNCH_BLOCKING_SUMMARY_CHANNEL)!;
    await expect(handler(fakeEvent)).resolves.toEqual({
      busy: true,
      categories: ['companion'],
      companionNames: [],
    });
  });

  it('keeps the generic summary when any source cannot be classified', async () => {
    registerRelaunchBusyActivityIpc(sources({
      anySessionInTurn: () => { throw new Error('probe down'); },
      anyBackgroundBashRunning: () => true,
    }));
    const handler = h.handlers.get(RELAUNCH_BLOCKING_SUMMARY_CHANNEL)!;
    await expect(handler(fakeEvent)).resolves.toEqual({
      busy: true,
      categories: [],
      companionNames: [],
    });
    const booleanHandler = h.handlers.get(RELAUNCH_BLOCKING_ACTIVITY_CHANNEL)!;
    await expect(booleanHandler(fakeEvent)).resolves.toBe(true);
  });

  it('does not read activity or teammate facts for an untrusted sender', async () => {
    h.trusted = false;
    registerRelaunchBusyActivityIpc(sources({ anySessionInTurn: () => { h.reads += 1; return true; } }), {
      describeTurns: async () => {
        h.turnReads += 1;
        return { companions: [], conversation: true };
      },
    });
    const handler = h.handlers.get(RELAUNCH_BLOCKING_SUMMARY_CHANNEL)!;
    await expect(handler(fakeEvent)).rejects.toThrow('PERMISSION_DENIED');
    expect(h.reads).toBe(0);
    expect(h.turnReads).toBe(0);
  });
});

describe('readRelaunchTurnFacts', () => {
  it('classifies a visible teammate and a normal chat without returning the session id', async () => {
    h.dbRows = [
      { id: 'bot-session', source: 'bot', displayName: 'Cindy', botStatus: 'active', hiddenAt: null },
      { id: 'task-session', source: 'desktop', displayName: null, botStatus: null, hiddenAt: null },
    ];
    await expect(readRelaunchTurnFacts(['bot-session', 'task-session'])).resolves.toEqual({
      companions: [{ name: 'Cindy' }],
      conversation: true,
    });
    expect(h.selects).toBe(1);
  });

  it('falls back when the teammate name query exceeds its short budget', async () => {
    vi.useFakeTimers();
    h.dbHang = true;
    try {
      const pending = readRelaunchTurnFacts(['bot-session']);
      await vi.advanceTimersByTimeAsync(RELAUNCH_TURN_FACTS_BUDGET_MS);
      await expect(pending).resolves.toBeNull();
      expect(h.selects).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call a delegated background task a teammate reply', async () => {
    h.dbRows = [
      {
        id: 'delegated',
        source: 'desktop',
        displayName: 'Cindy',
        botStatus: 'active',
        hiddenAt: null,
        linkRole: 'delegation',
      },
    ];
    await expect(readRelaunchTurnFacts(['delegated'])).resolves.toEqual({
      companions: [],
      conversation: true,
    });
    h.dbRows = [
      {
        id: 'delegated-bot',
        source: 'bot',
        displayName: 'Cindy',
        botStatus: 'active',
        hiddenAt: null,
        linkRole: 'delegation',
      },
    ];
    await expect(readRelaunchTurnFacts(['delegated-bot'])).resolves.toEqual({
      companions: [],
      conversation: true,
    });
  });

  it('keeps a canonical welcome as a visible teammate reply', async () => {
    h.dbRows = [
      {
        id: 'welcome',
        source: 'bot',
        displayName: 'Cindy',
        botStatus: 'active',
        hiddenAt: null,
        linkRole: 'canonical',
      },
    ];
    await expect(readRelaunchTurnFacts(['welcome'])).resolves.toEqual({
      companions: [{ name: 'Cindy' }],
      conversation: false,
    });
  });

  it('does not expose a hidden teammate name', async () => {
    h.dbRows = [
      { id: 'bot-session', source: 'bot', displayName: 'Cindy', botStatus: 'active', hiddenAt: 1 },
    ];
    await expect(readRelaunchTurnFacts(['bot-session'])).resolves.toEqual({
      companions: [{ name: null }],
      conversation: false,
    });
  });

  it('returns null when the row lookup fails or a requested turn is missing', async () => {
    h.dbError = new Error('db down');
    await expect(readRelaunchTurnFacts(['bot-session'])).resolves.toBeNull();
    expect(h.selects).toBe(0);
    h.dbError = null;
    h.dbRows = [];
    await expect(readRelaunchTurnFacts(['missing-session'])).resolves.toBeNull();
  });

  it('does not query once there are too many turns to classify safely', async () => {
    const ids = Array.from({ length: 33 }, (_, index) => 'session-' + index);
    await expect(readRelaunchTurnFacts(ids)).resolves.toBeNull();
    expect(h.selects).toBe(0);
  });
});
