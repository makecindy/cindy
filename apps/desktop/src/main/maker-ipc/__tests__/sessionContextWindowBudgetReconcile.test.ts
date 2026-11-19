/**
 * The context window budget reconcile, applier and replay (sessionContextWindowBudgetReconcile.ts,
 * moved verbatim out of register.ts; the desktop and the Node Host bind the same factory).
 * - Rule: a budget is recorded as applied only once a rebuild reached the live runtime; an intent stays
 *   until it is applied, already applied, or the runtime is gone; a budget merged into a pending route
 *   switch keeps its intent; the send boundary replays only an owed intent.
 * - Moved here from makerEventHotPathOrdering.test.ts, which ran the same cases on a slice of
 *   register.ts's text; they now run the factory itself. Each case keeps its assertions.
 * - Tier: unit; the database read, the route store, the catalog and the runtime rebuild are faked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  applyRuntimeSetModelChange: vi.fn(),
}));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [{ agentKind: 'cc', model: 'grok-4.6', providerId: 'xd' }] }) }),
      }),
    },
  }),
}));
vi.mock('../../maker-host/session-provider-store.js', () => ({ getSessionProvider: () => 'xd' }));
vi.mock('../../maker-host/active-catalog.js', () => ({ getActiveCatalog: () => ({}) }));
vi.mock('../runtimeSetModel.js', () => ({ applyRuntimeSetModelChange: h.applyRuntimeSetModelChange }));

import { createSessionContextWindowBudgetReconcile, type SessionContextWindowBudgetReconcilePorts } from '../sessionContextWindowBudgetReconcile.js';
import { appliedContextWindowBudgets as applied, pendingSessionContextWindowBudgetReconciles as pending } from '../sessionContextWindowBudgetState.js';

afterEach(() => {
  applied.clear();
  pending.clear();
  h.applyRuntimeSetModelChange.mockReset();
});

const reconcileWith = (overrides: Partial<SessionContextWindowBudgetReconcilePorts>) => createSessionContextWindowBudgetReconcile({
  getMakerIfReady: () => ({ getSession: () => ({ model: 'grok-4.6' }) }) as never,
  readStoredSessionContextWindowBudget: async () => 300_000,
  contextWindowBudgetChangesEffectiveWindow: () => true,
  getPendingCredentialSwitchTarget: () => undefined,
  registerPendingCredentialSwitchForSession: vi.fn(async () => {}),
  runtimeMutationDeps: () => ({}) as never,
  log: { debug: vi.fn(), info: vi.fn() },
  ...overrides,
});

describe('session context window budget reconciler', () => {
  it.each([
    ['applied', true],
    ['deferred', false],
  ] as const)('records the applied budget only after %s reaches the live session', async (status, recorded) => {
    // 回合中登记的重建会返回 deferred（只挂了 pending）。这时若就记 dedup，之后的同值
    // 对账全被挡掉；而 pending 又可能被「重选当前模型」清掉（SET_MODEL 成功路径会
    // agentSwitchPending.clear），预算就永久不生效（Greptile P1，2026-10-24）。
    h.applyRuntimeSetModelChange.mockImplementation(async () => ({ status }));
    const { sessionContextWindowBudgetApplier } = reconcileWith({});

    await sessionContextWindowBudgetApplier('task-1', { previous: null, next: 300_000 });
    expect(h.applyRuntimeSetModelChange).toHaveBeenCalledOnce();
    if (recorded) expect(applied.get('task-1')).toBe(300_000);
    else expect(applied.has('task-1')).toBe(false);
    // 意图集合才是重放的唯一开关：deferred 留下，applied 清掉。
    if (recorded) expect(pending.has('task-1')).toBe(false);
    else expect(pending.has('task-1')).toBe(true);
  });

  it('keeps a pending rebuild intent when a later save collapses to the same window', async () => {
    // 实例 300K、模型级上限 500K：回合中先存 500K（有效窗口 300K→500K），再存 600K
    // （两个保存值都收敛到 500K，判为「没变」）。此时**不能**清意图：实例还是 300K，
    // 一旦 pending 被取消就永久不生效（Greptile P1，2026-10-24）。
    const { sessionContextWindowBudgetApplier: applier } = reconcileWith({
      readStoredSessionContextWindowBudget: async () => 600_000,
      // 第一次：300K→500K 变了；第二次：500K→500K 没变。
      contextWindowBudgetChangesEffectiveWindow: vi.fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false),
      getPendingCredentialSwitchTarget: () => ({ model: 'grok-4.6', providerId: 'xd' }),
    });

    await applier('task-1', { previous: null, next: 600_000 });
    expect(pending.has('task-1')).toBe(true);
    await applier('task-1', { previous: 500_000, next: 600_000 });
    expect(pending.has('task-1')).toBe(true);
    expect(applied.has('task-1')).toBe(false);
  });

  it('keeps the budget intent when it merges into an already pending route switch', async () => {
    // 已有待处理的模型/来源切换时，改预算只补 forceSessionRebuild 后返回。用户随后重选
    // 当前模型 → SET_MODEL 清掉那条 pending → 没人再应用预算（Greptile P1，2026-10-24）。
    const registerPendingCredentialSwitchForSession = vi.fn(async () => {});
    const { sessionContextWindowBudgetApplier: applier } = reconcileWith({
      getPendingCredentialSwitchTarget: () => ({ model: 'grok-4.6', providerId: 'xd' }),
      registerPendingCredentialSwitchForSession,
    });

    await applier('task-1', { previous: null, next: 300_000 });
    // 合并不重建：不记 dedup，但意图必须留下，等发送边界重放。
    expect(registerPendingCredentialSwitchForSession).toHaveBeenCalledOnce();
    expect(applied.has('task-1')).toBe(false);
    expect(pending.has('task-1')).toBe(true);
  });

  it.each([
    ['no boundary replay without a pending intent', false, 0],
    ['replays at the send boundary when an intent is pending', true, 1],
  ] as const)('replay gate: %s', async (_label, intentPending, expectedReconciles) => {
    // 任务启动时 create opts 已带上偏好预算（applySessionContextWindowBudgetToCreateOpts），
    // 此时 dedup 还没有条目 —— 若按「dedup 缺失」重放，首条直发会把刚配置好的实例再关一次
    // （Greptile P2，2026-10-24）。执行真实的 replay 函数，而不是断言源码文本。
    if (intentPending) pending.add('task-1');
    h.applyRuntimeSetModelChange.mockImplementation(async () => ({ status: 'applied' as const }));
    const { replayPendingSessionContextWindowBudgetUnderLock: replay } = reconcileWith({});

    const before = vi.fn();
    await replay('task-1', before);
    expect(h.applyRuntimeSetModelChange).toHaveBeenCalledTimes(expectedReconciles);
    expect(before).toHaveBeenCalledTimes(expectedReconciles);
  });
});
