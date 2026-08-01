/**
 * turnCostBroadcaster.test.ts
 * ---------------------------------------------------------------------------
 * per-turn 费用挂载(MessageActionBar"本轮消耗")的 main 侧业务体:
 *   - recordTurnCostOnMessage:patch 成功才广播;patch false(行不存在)不广播;
 *     costUsd 非法 / 极小直接跳过(绝不写 $0);patch 抛错只吞不传播。
 *   - recordTurnUsageOnMessage:算不出报价的轮次只落 turnUsageDetails,不碰任何
 *     金额字段与 scheduler 账本(UI 据此退回显示本轮 token)。
 *   - codexUsageToTokens:done.data.usage → computeGatewayTurnCost 入参映射
 *     (reasoning 算 output,与 daily_model_usage 口径一致)。
 *
 * 默认 deps(BrowserWindow / enqueueDurableWrite / patchMessageAgentMeta)走
 * 依赖注入替换,测试不触达 Electron / sqlite。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../localDb/ipc/messages.js', () => ({
  patchMessageAgentMetaWithResult: vi.fn(async (_sessionId: string, _clientId: string, patch: Record<string, unknown>) => ({
    previous: {},
    next: patch,
  })),
  readPriorUserRoundCost: vi.fn(async () => ({ money: null, costUsd: 0, hasEstimatedValue: false })),
}));
vi.mock('../scheduler-host/runCostLedger.js', () => ({
  applyScheduleRunCostMetaChange: vi.fn(async () => undefined),
  recordScheduleRunCostDirect: vi.fn(async () => null),
}));
vi.mock('../messagePersistBroadcaster.js', () => ({
  enqueueDurableWrite: vi.fn((_label: string, fn: () => unknown) => Promise.resolve(fn())),
}));

import {
  recordTurnCostOnMessage,
  recordTurnUsageOnMessage,
  recordSchedulerTurnCost,
  codexUsageToTokens,
  piUsageToTokens,
  type TurnCostDeps,
  type MessageTurnCostPayload,
} from '../turnCostBroadcaster.js';
import {
  buildTurnUsageDetails,
  type TurnUsageDetails,
} from '../../shared/turnUsageDetails.js';
import type { RegionalMoney } from '../../shared/regionalMoney.js';

function usdMoney(
  amount: number,
  kind: RegionalMoney['kind'] = 'actual-cost',
): RegionalMoney {
  return {
    amount,
    currency: 'USD',
    approximate: kind === 'value-estimate',
    kind,
    ...(kind === 'value-estimate'
      ? { estimateReasons: ['subscription-value'] }
      : {}),
  };
}

function cnyMoney(amount: number): RegionalMoney {
  return {
    amount,
    currency: 'CNY',
    approximate: false,
    kind: 'actual-cost',
  };
}

function makeDeps(
  patchResult: boolean | Error = true,
  prior: {
    money: RegionalMoney | null;
    costUsd: number;
    hasEstimatedValue: boolean;
  } | Error = {
    money: null,
    costUsd: 0,
    hasEstimatedValue: false,
  },
  previousAgentMeta: Record<string, unknown> = {},
) {
  const broadcasts: MessageTurnCostPayload[] = [];
  const patchCalls: Array<{ sessionId: string; clientId: string; patch: Record<string, unknown> }> = [];
  const runCostCalls: Array<{
    previous: Record<string, unknown>;
    next: Record<string, unknown>;
  }> = [];
  const deps: TurnCostDeps = {
    patchAgentMeta: vi.fn(async (sessionId, clientId, patch) => {
      patchCalls.push({ sessionId, clientId, patch });
      if (patchResult instanceof Error) throw patchResult;
      return patchResult
        ? { previous: previousAgentMeta, next: { ...previousAgentMeta, ...patch } }
        : null;
    }),
    applyScheduleRunCostChange: vi.fn(async (previous, next) => {
      runCostCalls.push({ previous, next });
    }),
    readPriorUserRoundCost: vi.fn(async () => {
      if (prior instanceof Error) throw prior;
      return prior;
    }),
    enqueue: (_label, fn) => Promise.resolve(fn()),
    broadcast: (payload) => {
      broadcasts.push(payload);
    },
  };
  return { deps, broadcasts, patchCalls, runCostCalls };
}

const ARGS = { sessionId: 's1', clientId: 'm1', money: usdMoney(0.042) };
const DETAILS = buildTurnUsageDetails({
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 4000,
  cacheCreateTokens: 50,
  model: 'claude-sonnet-4-6',
}) as TurnUsageDetails;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordTurnCostOnMessage', () => {
  it('patch 成功 → 写入原始分段与本用户轮累计，并广播同值', async () => {
    const { deps, broadcasts, patchCalls } = makeDeps(true);
    await expect(recordTurnCostOnMessage(ARGS, deps)).resolves.toBe(true);
    expect(patchCalls).toEqual([
      {
        sessionId: 's1',
        clientId: 'm1',
        patch: {
          turnCost: usdMoney(0.042),
          turnCostUsd: 0.042,
          turnCostIsEstimate: false,
          userTurnCost: usdMoney(0.042),
          userTurnCostUsd: 0.042,
          userTurnCostIsEstimate: false,
        },
      },
    ]);
    expect(broadcasts).toEqual([
      {
        sessionId: 's1',
        clientId: 'm1',
        turnMoney: usdMoney(0.042),
        turnCostUsd: 0.042,
        turnCostIsEstimate: false,
        userTurnMoney: usdMoney(0.042),
        userTurnCostUsd: 0.042,
        userTurnCostIsEstimate: false,
      },
    ]);
  });

  it('有 turnUsageDetails 时一并写入 agent_meta 并广播', async () => {
    const { deps, broadcasts, patchCalls } = makeDeps(true);
    await recordTurnCostOnMessage({ ...ARGS, turnUsageDetails: DETAILS }, deps);
    expect(patchCalls[0]?.patch).toEqual({
      turnCost: usdMoney(0.042),
      turnCostUsd: 0.042,
      turnCostIsEstimate: false,
      userTurnCost: usdMoney(0.042),
      userTurnCostUsd: 0.042,
      userTurnCostIsEstimate: false,
      turnUsageDetails: DETAILS,
    });
    expect(broadcasts[0]).toEqual({
      sessionId: 's1',
      clientId: 'm1',
      turnMoney: usdMoney(0.042),
      turnCostUsd: 0.042,
      turnCostIsEstimate: false,
      userTurnMoney: usdMoney(0.042),
      userTurnCostUsd: 0.042,
      userTurnCostIsEstimate: false,
      turnUsageDetails: DETAILS,
    });
  });

  it('价格未知时仍可单独持久化并广播 token/cache 明细', async () => {
    const { deps, broadcasts, patchCalls } = makeDeps(true);
    await expect(recordTurnUsageOnMessage({
      sessionId: 's1',
      clientId: 'm1',
      turnUsageDetails: DETAILS,
    }, deps)).resolves.toBe(true);
    expect(patchCalls[0]?.patch).toEqual({ turnUsageDetails: DETAILS });
    expect(broadcasts[0]).toEqual({
      sessionId: 's1',
      clientId: 'm1',
      turnUsageDetails: DETAILS,
    });
  });

  it('订阅模式 token 价值标记(isEstimate=true)原样透传', async () => {
    const { deps, broadcasts } = makeDeps(true);
    await recordTurnCostOnMessage(
      { ...ARGS, money: usdMoney(0.042, 'value-estimate') },
      deps,
    );
    expect(broadcasts[0]?.turnCostIsEstimate).toBe(true);
    expect(broadcasts[0]?.userTurnCostIsEstimate).toBe(true);
  });

  it('scheduler turn 持久化 runId origin，并同步 run 费用账本', async () => {
    const { deps, patchCalls, runCostCalls } = makeDeps(true);
    const turnOrigin = {
      kind: 'scheduler',
      scheduleId: 'schedule-1',
      scheduleName: 'PR 反馈监控',
      runId: 'run-1',
    } as const;

    await recordTurnCostOnMessage({ ...ARGS, turnOrigin }, deps);

    expect(patchCalls[0]?.patch.origin).toEqual(turnOrigin);
    expect(runCostCalls).toEqual([{
      previous: {},
      next: expect.objectContaining({
        origin: turnOrigin,
        turnCost: usdMoney(0.042),
        turnCostUsd: 0.042,
        turnCostIsEstimate: false,
      }),
    }]);
  });

  it('多段 SDK done 的展示累计完整，但原始分段成本不变', async () => {
    const { deps, broadcasts, patchCalls } = makeDeps(true, {
      money: usdMoney(51.452182),
      costUsd: 51.452182,
      hasEstimatedValue: false,
    });
    await recordTurnCostOnMessage({ ...ARGS, money: usdMoney(0.777042) }, deps);

    expect(patchCalls[0]?.patch).toEqual({
      turnCost: usdMoney(0.777042),
      turnCostUsd: 0.777042,
      turnCostIsEstimate: false,
      userTurnCost: usdMoney(52.229224),
      userTurnCostUsd: 52.229224,
      userTurnCostIsEstimate: false,
    });
    expect(broadcasts[0]).toMatchObject({
      turnCostUsd: 0.777042,
      userTurnCostUsd: 52.229224,
    });
  });

  it('先前任一分段为估算值时，累计展示也标为估算', async () => {
    const { deps, broadcasts } = makeDeps(true, {
      money: usdMoney(1.2, 'value-estimate'),
      costUsd: 1.2,
      hasEstimatedValue: true,
    });
    await recordTurnCostOnMessage(ARGS, deps);
    expect(broadcasts[0]).toMatchObject({
      userTurnCostUsd: 1.242,
      userTurnCostIsEstimate: true,
    });
  });

  it('CNY 只写结构化金额，不伪造 legacy USD 投影', async () => {
    const { deps, broadcasts, patchCalls } = makeDeps(true);
    await recordTurnCostOnMessage(
      { ...ARGS, money: cnyMoney(3) },
      deps,
    );

    expect(patchCalls[0]?.patch).toEqual({
      turnCost: cnyMoney(3),
      turnCostIsEstimate: false,
      userTurnCost: cnyMoney(3),
      userTurnCostIsEstimate: false,
    });
    expect(broadcasts[0]).toEqual({
      sessionId: 's1',
      clientId: 'm1',
      turnMoney: cnyMoney(3),
      turnCostIsEstimate: false,
      userTurnMoney: cnyMoney(3),
      userTurnCostIsEstimate: false,
    });
  });

  it('混币历史估值不污染当前实际金额', async () => {
    const { deps, broadcasts } = makeDeps(true, {
      money: usdMoney(1.2, 'value-estimate'),
      costUsd: 1.2,
      hasEstimatedValue: true,
    });
    await recordTurnCostOnMessage(
      { ...ARGS, money: cnyMoney(3) },
      deps,
    );

    expect(broadcasts[0]).toMatchObject({
      userTurnMoney: cnyMoney(3),
      userTurnCostIsEstimate: false,
    });
  });

  it('patch 返回 false(行不存在,典型 rewind 已删)→ 不广播', async () => {
    const { deps, broadcasts, patchCalls } = makeDeps(false);
    await expect(recordTurnCostOnMessage(ARGS, deps)).resolves.toBe(false);
    expect(patchCalls).toHaveLength(1);
    expect(broadcasts).toHaveLength(0);
  });

  it('金额 ≤ 0 / NaN / Infinity → 跳过(不 patch 不广播)', async () => {
    const { deps, broadcasts, patchCalls } = makeDeps(true);
    for (const bad of [0, -1, NaN, Infinity, 1e-12]) {
      await recordTurnCostOnMessage({
        ...ARGS,
        money: { ...usdMoney(0), amount: bad },
      }, deps);
    }
    expect(patchCalls).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });

  it('sessionId / clientId 缺失 → 跳过', async () => {
    const { deps, patchCalls } = makeDeps(true);
    await recordTurnCostOnMessage({ ...ARGS, sessionId: '' }, deps);
    await recordTurnCostOnMessage({ ...ARGS, clientId: '' }, deps);
    expect(patchCalls).toHaveLength(0);
  });

  it('patch 抛错 → 吞掉不传播、不广播', async () => {
    const { deps, broadcasts } = makeDeps(new Error('db locked'));
    await expect(recordTurnCostOnMessage(ARGS, deps)).resolves.toBe(false);
    expect(broadcasts).toHaveLength(0);
  });

  it('读取累计失败 → 不写入错误的单段展示值，也不广播', async () => {
    const { deps, broadcasts, patchCalls } = makeDeps(true, new Error('db locked'));
    await expect(recordTurnCostOnMessage(ARGS, deps)).resolves.toBe(false);
    expect(patchCalls).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });
});

describe('recordTurnUsageOnMessage', () => {
  const USAGE_ARGS = { sessionId: 's1', clientId: 'm1', turnUsageDetails: DETAILS };

  it('只落 token 明细，不写任何金额字段', async () => {
    const { deps, broadcasts, patchCalls, runCostCalls } = makeDeps(true);
    await expect(recordTurnUsageOnMessage(USAGE_ARGS, deps)).resolves.toBe(true);
    // 账本口径:没有钱就不碰钱。patch 里只能有 turnUsageDetails 一个键。
    expect(patchCalls).toEqual([
      {
        sessionId: 's1',
        clientId: 'm1',
        patch: { turnUsageDetails: DETAILS },
      },
    ]);
    // scheduler 费用账本不参与(它只接受真实计费)。
    expect(runCostCalls).toHaveLength(0);
    expect(broadcasts).toEqual([
      { sessionId: 's1', clientId: 'm1', turnUsageDetails: DETAILS },
    ]);
  });

  it('广播 payload 不带金额字段 —— 消费方据此走 token 回退', async () => {
    const { deps, broadcasts } = makeDeps(true);
    await recordTurnUsageOnMessage(USAGE_ARGS, deps);
    const [payload] = broadcasts;
    expect(payload.turnMoney).toBeUndefined();
    expect(payload.turnCostUsd).toBeUndefined();
    expect(payload.userTurnMoney).toBeUndefined();
    expect(payload.userTurnCostUsd).toBeUndefined();
  });

  it('明细缺省(整轮 0 token)→ 不落库不广播，绝不写空对象', async () => {
    const { deps, broadcasts, patchCalls } = makeDeps(true);
    await expect(
      recordTurnUsageOnMessage({ sessionId: 's1', clientId: 'm1' }, deps),
    ).resolves.toBe(false);
    expect(patchCalls).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });

  it('sessionId / clientId 缺失 → 直接跳过', async () => {
    const { deps, patchCalls } = makeDeps(true);
    await expect(
      recordTurnUsageOnMessage({ sessionId: '', clientId: 'm1', turnUsageDetails: DETAILS }, deps),
    ).resolves.toBe(false);
    await expect(
      recordTurnUsageOnMessage({ sessionId: 's1', clientId: '', turnUsageDetails: DETAILS }, deps),
    ).resolves.toBe(false);
    expect(patchCalls).toHaveLength(0);
  });

  it('patch 返回 null(行已被 rewind 删)→ 不广播', async () => {
    const { deps, broadcasts } = makeDeps(false);
    await expect(recordTurnUsageOnMessage(USAGE_ARGS, deps)).resolves.toBe(false);
    expect(broadcasts).toHaveLength(0);
  });

  it('patch 抛错 → 只吞不传播(调用方 fire-and-forget)', async () => {
    const { deps, broadcasts } = makeDeps(new Error('db locked'));
    await expect(recordTurnUsageOnMessage(USAGE_ARGS, deps)).resolves.toBe(false);
    expect(broadcasts).toHaveLength(0);
  });

  // 一次用户请求可能含多个 SDK segment(自动续跑):前面的有真实费用、最后一个缺报价
  // 走 usage-only 时,若只写明细,收尾消息会退回显示 token,把这一轮已经花掉的钱藏起来。
  it('本轮此前已有费用 → 收尾消息带上用户轮累计,而不是退回 token', async () => {
    const { deps, broadcasts, patchCalls, runCostCalls } = makeDeps(true, {
      money: usdMoney(0.31),
      costUsd: 0.31,
      hasEstimatedValue: false,
    });
    await expect(recordTurnUsageOnMessage(USAGE_ARGS, deps)).resolves.toBe(true);

    expect(patchCalls[0].patch).toEqual({
      turnUsageDetails: DETAILS,
      userTurnCost: usdMoney(0.31),
      userTurnCostUsd: 0.31,
      userTurnCostIsEstimate: false,
    });
    // 当前这个无价 segment 依然不记账:没有 turnCost / turnCostUsd,也不碰 scheduler 账本。
    expect(patchCalls[0].patch).not.toHaveProperty('turnCost');
    expect(patchCalls[0].patch).not.toHaveProperty('turnCostUsd');
    expect(runCostCalls).toHaveLength(0);

    expect(broadcasts[0]).toMatchObject({
      userTurnMoney: usdMoney(0.31),
      userTurnCostUsd: 0.31,
      userTurnCostIsEstimate: false,
      turnUsageDetails: DETAILS,
    });
    expect(broadcasts[0].turnMoney).toBeUndefined();
  });

  it('本轮此前的费用是订阅价值估算 → 估算标记一并带上', async () => {
    const { deps, patchCalls, broadcasts } = makeDeps(true, {
      money: usdMoney(0.2, 'value-estimate'),
      costUsd: 0.2,
      hasEstimatedValue: true,
    });
    await recordTurnUsageOnMessage(USAGE_ARGS, deps);
    expect(patchCalls[0].patch).toMatchObject({ userTurnCostIsEstimate: true });
    expect(broadcasts[0]).toMatchObject({ userTurnCostIsEstimate: true });
  });

  it('本轮此前没有费用 → 只写明细(不写 0 值累计)', async () => {
    const { deps, patchCalls, broadcasts } = makeDeps(true);
    await recordTurnUsageOnMessage(USAGE_ARGS, deps);
    expect(patchCalls[0].patch).toEqual({ turnUsageDetails: DETAILS });
    expect(broadcasts[0].userTurnMoney).toBeUndefined();
  });

  it('CNY 累计不写 userTurnCostUsd 字段', async () => {
    const { deps, patchCalls, broadcasts } = makeDeps(true, {
      money: cnyMoney(2.5),
      costUsd: 0,
      hasEstimatedValue: false,
    });
    await recordTurnUsageOnMessage(USAGE_ARGS, deps);
    expect(patchCalls[0].patch).not.toHaveProperty('userTurnCostUsd');
    expect(broadcasts[0].userTurnCostUsd).toBeUndefined();
    expect(broadcasts[0].userTurnMoney).toEqual(cnyMoney(2.5));
  });

  it('读取往轮累计失败 → 不落库不广播(不猜金额)', async () => {
    const { deps, patchCalls, broadcasts } = makeDeps(true, new Error('db locked'));
    await expect(recordTurnUsageOnMessage(USAGE_ARGS, deps)).resolves.toBe(false);
    expect(patchCalls).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });
});

describe('recordSchedulerTurnCost', () => {
  const schedulerOrigin = {
    kind: 'scheduler',
    scheduleId: 'schedule-1',
    runId: 'run-1',
  } as const;

  it('有 assistant message 且写入成功时保持消息账本为唯一来源', async () => {
    const recordOnMessage = vi.fn(async () => true);
    const recordDirect = vi.fn(async () => 'schedule-1');

    await expect(recordSchedulerTurnCost(
      {
        ...ARGS,
        turnOrigin: schedulerOrigin,
      },
      { recordOnMessage, recordDirect },
    )).resolves.toBeNull();

    expect(recordOnMessage).toHaveBeenCalledOnce();
    expect(recordDirect).not.toHaveBeenCalled();
  });

  it('纯 tool turn 没有 assistant message 时按 runId 直接归因并刷新自动化', async () => {
    const recordOnMessage = vi.fn(async () => true);
    const recordDirect = vi.fn(async () => 'schedule-1');

    await expect(recordSchedulerTurnCost(
      {
        sessionId: 's1',
        money: usdMoney(0.42),
        turnOrigin: schedulerOrigin,
      },
      { recordOnMessage, recordDirect },
    )).resolves.toBe('schedule-1');

    expect(recordOnMessage).not.toHaveBeenCalled();
    expect(recordDirect).toHaveBeenCalledWith({
      runId: 'run-1',
      money: usdMoney(0.42),
    });
  });

  it('assistant message 已被删除时回退到 runId 归因', async () => {
    const recordOnMessage = vi.fn(async () => false);
    const recordDirect = vi.fn(async () => 'schedule-1');

    await expect(recordSchedulerTurnCost(
      {
        ...ARGS,
        turnOrigin: schedulerOrigin,
      },
      { recordOnMessage, recordDirect },
    )).resolves.toBe('schedule-1');

    expect(recordDirect).toHaveBeenCalledOnce();
  });

  it('broadcast failure after message persistence does not trigger scheduler fallback', async () => {
    const { deps } = makeDeps(true);
    deps.broadcast = () => {
      throw new Error('window closed');
    };
    const recordOnMessage: typeof recordTurnCostOnMessage = (args) =>
      recordTurnCostOnMessage(args, deps);
    const recordDirect = vi.fn(async () => 'schedule-1');

    await expect(recordSchedulerTurnCost(
      {
        ...ARGS,
        turnOrigin: schedulerOrigin,
      },
      { recordOnMessage, recordDirect },
    )).resolves.toBeNull();

    expect(recordDirect).not.toHaveBeenCalled();
  });

  it('可靠计价结果为零时仍用 runId 标记为已确认费用', async () => {
    const recordOnMessage = vi.fn(async () => false);
    const recordDirect = vi.fn(async () => 'schedule-1');

    await expect(recordSchedulerTurnCost(
      {
        sessionId: 's1',
        money: usdMoney(0),
        turnOrigin: schedulerOrigin,
      },
      { recordOnMessage, recordDirect },
    )).resolves.toBe('schedule-1');

    expect(recordDirect).toHaveBeenCalledWith({
      runId: 'run-1',
      money: usdMoney(0),
    });
  });
});

describe('codexUsageToTokens', () => {
  it('completion 已含 reasoning,不重复相加;cached 计入 cacheRead', () => {
    expect(
      codexUsageToTokens({
        promptTokens: 1000,
        completionTokens: 200,
        reasoningTokens: 300,
        cachedTokens: 4000,
      }),
    ).toEqual({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 4000, cacheCreateTokens: 0 });
  });

  it('缺失字段按 0 处理', () => {
    expect(codexUsageToTokens({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
  });
});

describe('piUsageToTokens', () => {
  it('maps Pi camelCase usage including cache create', () => {
    expect(piUsageToTokens({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 500,
      cacheCreationTokens: 30,
    })).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 500,
      cacheCreateTokens: 30,
    });
  });
});
