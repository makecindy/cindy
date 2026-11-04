import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Catalog } from '@cindy/model-providers';

let mockModelLimit: number | null = null;

vi.mock('../model-context-limit-store.js', () => ({
  readModelContextLimit: () => mockModelLimit,
  readModelContextLimits: () => ({}),
  writeModelContextLimit: vi.fn(),
  isModelContextLimitCustomized: () => mockModelLimit !== null,
}));
// 预算文件必须落临时目录：这些用例会真写预算，绝不能碰真实 userData。
const budgetState = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../appSessionState.js', async () => {
  const nodePath = await import('node:path');
  return {
    ownerScopedUserDataPath: (...parts: string[]): string => nodePath.join(budgetState.dir, ...parts),
    // 预算 store 的 owner 隔离读它；测试里固定成同一个 key 即可。
    activeOwnerScopeKey: (): string => 'test-owner',
    getActiveAppSession: () => ({ dataOwnerId: 'test-owner', generation: 1 }),
    dataOwnerStorageKey: (ownerId: string): string => ownerId,
  };
});

vi.mock('../catalog-to-descriptors.js', async () => {
  const shared = await import('../../../shared/sessionContextWindow.js');
  return {
    resolveModelContextProviderId: () => 'xd',
    resolveVerifiedContextWindow: shared.resolveVerifiedContextWindow,
  };
});

import { resolveConfiguredContextWindow, contextWindowBudgetChangesEffectiveWindow, resolveDesktopModelContextProviderId, resolveSessionContextWindowBounds, applySessionContextWindowBudgetToCreateOpts } from '../model-context-settings';
import { writeSessionContextWindowBudget } from '../session-context-budget-store';

/** 目录里 1M 物理上限、默认工作窗口 200K 的路由（服务端压低过默认值）。 */
const catalog: Pick<Catalog, 'providers'> = {
  providers: [
    {
      id: 'xd',
      routing: { 'claude-code': {} },
      models: {
        'claude-code': [
          {
            id: 'long-window-model',
            name: 'Long Window Model',
            contextWindow: 200_000,
            contextWindowMax: 1_000_000,
            contextWindowVerified: true,
          },
        ],
      },
    },
  ],
} as unknown as Pick<Catalog, 'providers'>;

/** 自定义连接未声明窗口的真实形态：未核实 + 只有兜底默认 contextWindow。 */
const undeclaredCatalog: Pick<Catalog, 'providers'> = {
  providers: [
    {
      id: 'xd',
      routing: { 'claude-code': {} },
      models: {
        'claude-code': [
          {
            id: 'undeclared-model',
            name: 'Undeclared Model',
            contextWindow: 200_000,
            contextWindowVerified: false,
          },
        ],
      },
    },
  ],
} as unknown as Pick<Catalog, 'providers'>;

function resolve(sessionBudget?: number | null): number | null {
  return resolveConfiguredContextWindow(
    catalog,
    'claude-code',
    'xd',
    'long-window-model',
    sessionBudget,
  );
}

beforeEach(() => {
  mockModelLimit = null;
  if (!budgetState.dir) {
    budgetState.dir = mkdtempSync(path.join(os.tmpdir(), 'ctx-budget-opts-'));
  }
});

describe('resolveConfiguredContextWindow with a session budget', () => {
  it('follows the catalog default when nothing is customized', () => {
    expect(resolve()).toBe(200_000);
    expect(resolve(null)).toBe(200_000);
  });

  it('lets the task budget tighten below the catalog default', () => {
    expect(resolve(100_000)).toBe(100_000);
  });

  it('lets the task budget raise the working window up to the catalog max', () => {
    expect(resolve(1_000_000)).toBe(1_000_000);
    expect(resolve(750_000)).toBe(750_000);
  });

  it('never lets the task budget exceed the catalog physical max', () => {
    expect(resolve(4_000_000)).toBe(1_000_000);
  });

  it('keeps the tighter model-level cap when it is below the task budget', () => {
    mockModelLimit = 300_000;
    expect(resolve(1_000_000)).toBe(300_000);
    // 任务预算仍可在这条上限内继续收紧。
    expect(resolve(150_000)).toBe(150_000);
  });

  it('falls back to the model-level cap when the task follows the default', () => {
    mockModelLimit = 300_000;
    expect(resolve(null)).toBe(300_000);
  });
});

/** 发现流程只拿到 max_context_window 的真实形态：未核实 + 声明了物理上限。 */
const unverifiedCatalog: Pick<Catalog, 'providers'> = {
  providers: [
    {
      id: 'xd',
      routing: { 'claude-code': {} },
      models: {
        'claude-code': [
          {
            id: 'discovered-model',
            name: 'Discovered Model',
            contextWindow: 100_000,
            contextWindowMax: 400_000,
            contextWindowVerified: false,
          },
        ],
      },
    },
  ],
} as unknown as Pick<Catalog, 'providers'>;

describe('resolveConfiguredContextWindow on an unverified route', () => {
  it('still clamps the session budget by the declared physical max', () => {
    // 未核实路由没有 verified 收敛，但不能因此让任务预算越过目录声明的上限。
    expect(
      resolveConfiguredContextWindow(unverifiedCatalog, 'claude-code', 'xd', 'discovered-model', 10_000_000),
    ).toBe(400_000);
  });

  it('keeps a session budget below the declared max untouched', () => {
    expect(
      resolveConfiguredContextWindow(unverifiedCatalog, 'claude-code', 'xd', 'discovered-model', 200_000),
    ).toBe(200_000);
  });

  it('preserves the model-level cap as the explicit escape hatch', () => {
    // 模型级上限刻意不夹目录上限：路由把窗口配错时用户要能强行解开（见 store 头注）。
    mockModelLimit = 1_000_000;
    expect(
      resolveConfiguredContextWindow(unverifiedCatalog, 'claude-code', 'xd', 'discovered-model', null),
    ).toBe(1_000_000);
  });
});

describe('contextWindowBudgetChangesEffectiveWindow', () => {
  const changes = (previous: number | null, next: number | null): boolean =>
    contextWindowBudgetChangesEffectiveWindow({
      catalog, agent: 'claude-code', providerId: 'xd', modelId: 'long-window-model', previous, next,
    });

  it('reports a change when the task tightens or raises the window', () => {
    expect(changes(null, 100_000)).toBe(true);
    expect(changes(100_000, 750_000)).toBe(true);
  });

  it('reports no change when the effective window is unchanged', () => {
    expect(changes(null, null)).toBe(false);
    // 选回目录默认值（= 清除预算）与「本来就是默认」等价。
    expect(changes(null, 200_000)).toBe(false);
    expect(changes(200_000, null)).toBe(false);
  });

  it('reports no change when a tighter model-level cap absorbs both values', () => {
    mockModelLimit = 300_000;
    expect(changes(500_000, 1_000_000)).toBe(false);
    expect(changes(500_000, 250_000)).toBe(true);
  });
});

describe('resolveSessionContextWindowBounds', () => {
  it('returns the route bounds the controlled device would apply', () => {
    mockModelLimit = 800_000;
    expect(
      resolveSessionContextWindowBounds({
        catalog, agent: 'claude-code', providerId: 'xd', modelId: 'long-window-model',
      }),
    ).toEqual({
      providerId: 'xd',
      defaultWindow: 200_000,
      maxWindow: 1_000_000,
      modelLimit: 800_000,
      budget: null,
      budgetCustomized: false,
      // 默认档（清掉任务预算）= min(模型级上限 800K, 物理上限 1M)；已核实路由由 main 夹一次。
      defaultEffectiveWindow: 800_000,
      // 物理上限 = contextWindowMax（1M）。
      maxEffectiveWindow: 1_000_000,
      effectiveWindowsReported: true,
    });
  });

  it('carries the task budget when the caller supplies one', () => {
    // 任务档位与边界同源返回（偏好文件里的条目）：调用方不给时默认「未自定义」。
    expect(
      resolveSessionContextWindowBounds({
        catalog, agent: 'claude-code', providerId: 'xd', modelId: 'long-window-model',
        budget: 262_144, budgetCustomized: true,
      }),
    ).toEqual({
      providerId: 'xd',
      defaultWindow: 200_000,
      maxWindow: 1_000_000,
      modelLimit: null,
      budget: 262_144,
      budgetCustomized: true,
      // 默认档刻意不带这条预算：它是「勾选模型默认（写 null）之后」的运行窗口。
      defaultEffectiveWindow: 200_000,
      maxEffectiveWindow: 1_000_000,
      effectiveWindowsReported: true,
    });
  });

  it('resolves the implicit route source the same way the runtime does', () => {
    // 控制端解析不了的跨 provider 同 id，被控端能解析：它按运行期同一套「隐式来源」口径选中
    // 真正生效的那条路由，而不是退回扁平表猜。
    const ambiguous: Pick<Catalog, 'providers'> = {
      providers: [
        ...catalog.providers,
        {
          id: 'xd-mirror',
          routing: { 'claude-code': {} },
          models: {
            'claude-code': [
              { id: 'long-window-model', name: 'Mirror', contextWindow: 400_000, contextWindowVerified: true },
            ],
          },
        },
      ],
    } as unknown as Pick<Catalog, 'providers'>;
    const bounds = resolveSessionContextWindowBounds({
      catalog: ambiguous, agent: 'claude-code', providerId: null, modelId: 'long-window-model',
    });
    expect(bounds.providerId).toBe(
      resolveDesktopModelContextProviderId(ambiguous, 'claude-code', null, 'long-window-model'),
    );
    expect(bounds.defaultWindow).toBe(200_000);
    expect(bounds.maxWindow).toBe(1_000_000);
  });

  it('reports unknown bounds for a model that is not in the catalog at all', () => {
    // 目录里没有这个 id：来源会解析成默认网关（隐式路由），但路由窗口解不出 →
    // 两个窗口值都为 null，调用方（控制端）据此退回「只允许收紧」。
    const bounds = resolveSessionContextWindowBounds({
      catalog, agent: 'claude-code', providerId: null, modelId: 'not-in-catalog',
    });
    expect(bounds.defaultWindow).toBeNull();
    expect(bounds.maxWindow).toBeNull();
    expect(bounds.modelLimit).toBeNull();
  });

  it('does not pass an unverified fallback context window off as a physical max', () => {
    // 用户实测报障（2026-09-22）：自定义连接未声明窗口 → 目录 contextWindow 只是 200K 兜底，
    // 用户把模型级上限设成 1M。此时 main 的生效默认窗口就是 1M（未核实路由刻意不按目录夹），
    // 若把 200K 当 maxWindow 下发，chip 的档位基准会被钉在 200K，「模型默认 1M」显示成 500%。
    mockModelLimit = 1_000_000;
    const bounds = resolveSessionContextWindowBounds({
      catalog: undeclaredCatalog, agent: 'claude-code', providerId: 'xd', modelId: 'undeclared-model',
    });
    expect(bounds).toEqual({
      providerId: 'xd',
      // 兜底默认仍在（它是「跟随默认」在没有模型级上限时的运行窗口）。
      defaultWindow: 200_000,
      // 但它不是上限：未核实 + 未声明 → null（声明了 max_contextWindow 才算数）。
      maxWindow: null,
      modelLimit: 1_000_000,
      budget: null,
      budgetCustomized: false,
      defaultEffectiveWindow: 1_000_000,
      // 未核实路由没有「物理上限」这道夹（预算就是工作上限）。
      maxEffectiveWindow: null,
      effectiveWindowsReported: true,
    });
  });
});

describe('applySessionContextWindowBudgetToCreateOpts', () => {
  afterEach(() => {
    if (budgetState.dir) {
      rmSync(budgetState.dir, { recursive: true, force: true });
      budgetState.dir = '';
    }
  });

  const optsFor = (over: Record<string, unknown> = {}) => ({
    agentKind: 'claude-code' as const,
    providerId: 'xd',
    model: 'long-window-model',
    ...over,
  }) as {
    contextWindowBudget?: number | null;
    agentKind: 'claude-code';
    providerId?: string | null;
    model?: string | null;
  };

  it('读已存档位并按目录上限收敛后写进创建参数', async () => {
    // worker 唤醒 / 进程重启后的恢复路径靠这一步把预算带回引擎：缺了它，Pi 的
    // compaction.reserveTokens 会写成无预算值、阈值退回满窗（2026-09-30 实测）。
    writeSessionContextWindowBudget('sess-1', 500_000);
    const opts = optsFor();
    await applySessionContextWindowBudgetToCreateOpts('sess-1', opts, catalog);
    expect(opts.contextWindowBudget).toBe(500_000);
  });

  it('调用方显式带值时按同一口径收敛（压到目录物理上限内）', async () => {
    const opts = optsFor({ contextWindowBudget: 4_000_000 });
    await applySessionContextWindowBudgetToCreateOpts('sess-1', opts, catalog);
    expect(opts.contextWindowBudget).toBe(1_000_000);
  });

  it('未自定义时不留字段（引擎回退默认，旧行为零变化）', async () => {
    const opts = optsFor();
    await applySessionContextWindowBudgetToCreateOpts('sess-never-set', opts, catalog);
    expect('contextWindowBudget' in opts).toBe(false);
  });

  it('路由未定型（无 model）时不透传未收敛的值', async () => {
    writeSessionContextWindowBudget('sess-2', 500_000);
    const opts = optsFor({ model: undefined });
    await applySessionContextWindowBudgetToCreateOpts('sess-2', opts, catalog);
    expect('contextWindowBudget' in opts).toBe(false);
  });
});
