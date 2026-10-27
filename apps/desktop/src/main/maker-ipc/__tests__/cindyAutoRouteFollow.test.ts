import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingAgentSwitchIntent } from '../sessionAgentSwitchHandler.js';

import type { CatalogModel, ProviderSource, ProviderView } from '@cindy/model-providers';

import {
  cindyAutoRouteToFollow,
  followMovedCindyAutoRoutes,
  movedCindyAutoProviderId,
  stagedCindyAutoSwitch,
  type CindyAutoRoute,
  type CindyAutoRouteFollowDeps,
} from '../cindyAutoRouteFollow.js';
import {
  acceptSessionRuntimeMutation,
  clearSessionRuntimeControlState,
  getSessionRuntimeControlSnapshot,
} from '../sessionRuntimeControl.js';

const AUTO = 'auto/group-1';

function model(id: string): CatalogModel {
  return { id, name: id, contextWindow: 200_000, efforts: [], defaultEffort: null };
}

function provider(id: string, source: ProviderSource, modelIds: string[]): ProviderView {
  return {
    id,
    name: id,
    source,
    agents: ['pi'],
    auth: { method: source === 'user' ? 'apiKey' : 'managed' },
    access: source === 'user' ? { kind: 'api' } : { kind: 'managed' },
    routing: { pi: { upstream: `https://${id}.test`, authStrategy: 'api-key-header' } },
    models: { pi: modelIds.map(model) },
    connected: true,
  };
}

const route = (patch: Partial<CindyAutoRoute> = {}): CindyAutoRoute => ({
  agentKind: 'pi',
  model: AUTO,
  providerId: 'org-pool',
  effort: 'high',
  fastMode: false,
  ...patch,
});

/** 管理员把 Auto 的目标从号池模型切到平台模型。 */
const movedToPlatform = [
  provider('xd', 'builtin', ['auto', AUTO]),
  provider('org-pool', 'organization', ['pool-model']),
];

describe('movedCindyAutoProviderId', () => {
  it('Auto 换了 Cindy 来源时给出新来源，引擎与模型不在这里改', () => {
    expect(movedCindyAutoProviderId(movedToPlatform, route())).toBe('xd');
    const movedToPool = [
      provider('xd', 'builtin', ['auto']),
      provider('org-pool', 'organization', [AUTO]),
    ];
    expect(movedCindyAutoProviderId(movedToPool, route({ providerId: 'xd' }))).toBe('org-pool');
  });

  it('Pi 的默认来源（providerId=null）就是 Cindy AI，Auto 挪到号池同样跟随', () => {
    const movedToPool = [
      provider('xd', 'builtin', ['auto']),
      provider('org-pool', 'organization', [AUTO]),
    ];
    expect(movedCindyAutoProviderId(movedToPool, route({ providerId: null }))).toBe('org-pool');
    // 其它引擎的默认来源不一定是 Cindy AI，不推断。
    expect(
      movedCindyAutoProviderId(movedToPool, route({ providerId: null, agentKind: 'codex' })),
    ).toBeNull();
  });

  it('订阅等内置非 Cindy AI 来源上的 auto/... 不跟随', () => {
    const subscription = [
      provider('openai', 'builtin', ['other']),
      provider('xd', 'builtin', [AUTO]),
    ];
    expect(movedCindyAutoProviderId(subscription, route({ providerId: 'openai' }))).toBeNull();
  });

  it('Auto 从两份目录都消失时不登记切换，保留原路由交给既有的来源失效提示', () => {
    const gone = [
      provider('xd', 'builtin', ['auto']),
      provider('org-pool', 'organization', ['pool-model']),
    ];
    expect(movedCindyAutoProviderId(gone, route())).toBeNull();
    expect(movedCindyAutoProviderId(gone, route({ providerId: null }))).toBeNull();
  });

  it('回归：预设 auto 的任务不动', () => {
    expect(
      movedCindyAutoProviderId(movedToPlatform, route({ model: 'auto', providerId: null })),
    ).toBeNull();
    expect(
      movedCindyAutoProviderId(movedToPlatform, route({ model: 'auto', providerId: 'xd' })),
    ).toBeNull();
  });

  it('来源没变、普通模型、用户自己接的供应商都不动', () => {
    expect(movedCindyAutoProviderId(movedToPlatform, route({ providerId: 'xd' }))).toBeNull();
    expect(movedCindyAutoProviderId(movedToPlatform, route({ model: 'pool-model' }))).toBeNull();
    const userOwned = [provider('custom', 'user', ['other']), provider('xd', 'builtin', [AUTO])];
    expect(movedCindyAutoProviderId(userOwned, route({ providerId: 'custom' }))).toBeNull();
  });
});

describe('followMovedCindyAutoRoutes', () => {
  function deps(overrides: Partial<CindyAutoRouteFollowDeps> = {}) {
    const stage = vi.fn(async () => {});
    const withSessionLock = vi.fn(async (_sessionId: string, run: () => Promise<void>) => run());
    const base: CindyAutoRouteFollowDeps = {
      listCandidates: async () => [
        { sessionId: 'moved', ...route() },
        { sessionId: 'unchanged', ...route({ providerId: 'xd' }) },
        { sessionId: 'plain', ...route({ model: 'pool-model' }) },
      ],
      listProviders: async () => movedToPlatform,
      withSessionLock,
      readRoute: async (sessionId) =>
        sessionId === 'moved'
          ? route({ effort: 'medium', fastMode: true })
          : route({ providerId: 'xd' }),
      stage,
      assertCurrent: () => {},
    };
    return { stage, withSessionLock, deps: { ...base, ...overrides } };
  }

  it('只为 Auto 被挪走的任务登记下一条消息前的切换：只换供应商，保留引擎、模型与档位', async () => {
    const { stage, withSessionLock, deps: input } = deps();
    await expect(followMovedCindyAutoRoutes(input)).resolves.toBe(1);
    expect(withSessionLock).toHaveBeenCalledTimes(1);
    expect(stage).toHaveBeenCalledWith(
      'moved',
      {
        agentKind: 'pi',
        model: AUTO,
        providerId: 'xd',
        effort: 'medium',
        fastMode: true,
      },
      expect.objectContaining({
        fromProviderId: expect.any(String),
        targetProviderId: expect.any(String),
      }),
    );
  });

  it('加锁后重读：已有登记的切换或运行时改道（readRoute 返回 null）时不覆盖', async () => {
    const { stage, deps: input } = deps({ readRoute: async () => null });
    await expect(followMovedCindyAutoRoutes(input)).resolves.toBe(0);
    expect(stage).not.toHaveBeenCalled();
  });

  it('本地数据库还没就绪（启动早期）时直接跳过：不读任务、不报错、不记日志', async () => {
    const listCandidates = vi.fn(async () => {
      throw new Error('DbClient not ready');
    });
    const logger = { info: vi.fn() };
    const { stage, deps: input } = deps({ isReady: () => false, listCandidates, logger });
    await expect(followMovedCindyAutoRoutes(input)).resolves.toBe(0);
    expect(listCandidates).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('数据库就绪后照常跟随', async () => {
    const { stage, deps: input } = deps({ isReady: () => true });
    await expect(followMovedCindyAutoRoutes(input)).resolves.toBe(1);
    expect(stage).toHaveBeenCalledTimes(1);
  });

  it('没有候选任务时不读供应商目录', async () => {
    const listProviders = vi.fn(async () => movedToPlatform);
    const { deps: input } = deps({ listCandidates: async () => [], listProviders });
    await expect(followMovedCindyAutoRoutes(input)).resolves.toBe(0);
    expect(listProviders).not.toHaveBeenCalled();
  });

  it('单个任务登记失败只记日志，其余任务继续', async () => {
    const logger = { info: vi.fn() };
    const stage = vi.fn(async (sessionId: string) => {
      if (sessionId === 'first') throw new Error('window check failed');
    });
    const { deps: input } = deps({
      listCandidates: async () => [
        { sessionId: 'first', ...route() },
        { sessionId: 'second', ...route() },
      ],
      readRoute: async () => route(),
      stage,
      logger,
    });
    await expect(followMovedCindyAutoRoutes(input)).resolves.toBe(1);
    expect(stage).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      'Cindy Auto provider follow failed; task keeps its route',
      expect.objectContaining({ sessionId: 'first' }),
    );
  });

  it('账号切换后整批停止，不再改动下一个账号的任务', async () => {
    let current = true;
    const stage = vi.fn(async () => {
      current = false;
    });
    const { deps: input } = deps({
      listCandidates: async () => [
        { sessionId: 'first', ...route() },
        { sessionId: 'second', ...route() },
      ],
      readRoute: async () => route(),
      stage,
      assertCurrent: () => {
        if (!current) throw new Error('owner changed');
      },
    });
    await expect(followMovedCindyAutoRoutes(input)).rejects.toThrow('owner changed');
    expect(stage).toHaveBeenCalledTimes(1);
  });
});

describe('Auto 没有推理档位时的跨来源跟随', () => {
  // Auto 不带档位，任务库里 effort 存的是空串；登记切换只接受合法档位或 null。
  const movedToPool = [
    provider('xd', 'builtin', ['auto']),
    provider('org-pool', 'organization', [AUTO]),
  ];

  function follow(providers: ProviderView[], current: CindyAutoRoute) {
    const stage = vi.fn(async () => {});
    return {
      stage,
      run: () =>
        followMovedCindyAutoRoutes({
          listCandidates: async () => [{ sessionId: 'task', ...current }],
          listProviders: async () => providers,
          withSessionLock: async (_sessionId, run) => run(),
          readRoute: async () => current,
          stage,
          assertCurrent: () => {},
        }),
    };
  }

  it('号池 → 平台：按无档位（null）登记，不把空串交给登记切换', async () => {
    const { stage, run } = follow(movedToPlatform, route({ providerId: 'org-pool', effort: '' }));
    await expect(run()).resolves.toBe(1);
    expect(stage).toHaveBeenCalledWith(
      'task',
      {
        agentKind: 'pi',
        model: AUTO,
        providerId: 'xd',
        effort: null,
        fastMode: false,
      },
      expect.objectContaining({
        fromProviderId: expect.any(String),
        targetProviderId: expect.any(String),
      }),
    );
  });

  it('平台 → 号池：同样按无档位（null）登记', async () => {
    const { stage, run } = follow(movedToPool, route({ providerId: 'xd', effort: '' }));
    await expect(run()).resolves.toBe(1);
    expect(stage).toHaveBeenCalledWith(
      'task',
      {
        agentKind: 'pi',
        model: AUTO,
        providerId: 'org-pool',
        effort: null,
        fastMode: false,
      },
      expect.objectContaining({
        fromProviderId: expect.any(String),
        targetProviderId: expect.any(String),
      }),
    );
  });

  it('负向：用户自己接的供应商上的 auto/... 不跟随，即使 Cindy 来源也有同名 Auto', async () => {
    const providers = [provider('custom', 'user', ['other']), provider('xd', 'builtin', [AUTO])];
    const { stage, run } = follow(providers, route({ providerId: 'custom', effort: '' }));
    await expect(run()).resolves.toBe(0);
    expect(stage).not.toHaveBeenCalled();
  });
});

describe('号池 → 平台：目录刷新按旧路由重新加载过的进行中任务', () => {
  // 9333 上 706b7b9b 等任务的真实形态：任务库 effort 为空串；号池来源是 byok-<UUID>。
  const TASK = '706b7b9b-ded3-4326-8c81-9bbf5a45857a';
  const REAL_AUTO = 'auto/d00e8b7f-fb6f-4045-922f-310da7b839fc';
  const POOL = 'byok-f83a176f-8e24-494c-8e88-290584b05a76';
  const dbRow = {
    agentKind: 'pi',
    model: REAL_AUTO,
    providerId: POOL,
    effort: '',
    fastMode: false,
  } as const;
  const poolRoute = { ...dbRow, effort: null };
  /** Cindy AI 已列出 Auto，号池目录也已刷新、不再列它。 */
  const afterBothRefreshed = [
    provider('xd', 'builtin', ['auto', REAL_AUTO, 'z-ai/glm-5.3-flash']),
    provider(POOL, 'organization', [`${POOL}/e2e-model`]),
  ];

  afterEach(() => clearSessionRuntimeControlState(TASK));

  function runtimeState(hasPendingSelection = false) {
    const control = getSessionRuntimeControlSnapshot(TASK);
    return { effective: control.effectiveOverride ?? dbRow, control, hasPendingSelection };
  }

  /** 先刷新的 Cindy AI 触发上下文刷新：号池目录还是旧的，按号池路由重新加载（立即生效）。 */
  function reloadWithStalePool() {
    acceptSessionRuntimeMutation({
      sessionId: TASK,
      source: 'agent',
      deferred: false,
      profile: poolRoute,
    });
  }

  it('重新加载写上的运行时覆盖就是当前路由，照常拿来跟随', () => {
    reloadWithStalePool();
    expect(cindyAutoRouteToFollow(runtimeState())).toEqual(poolRoute);
  });

  it('号池刷新后再跑跟随：登记下一条消息切到 Cindy AI', async () => {
    reloadWithStalePool();
    const stage = vi.fn(async () => {});
    await expect(
      followMovedCindyAutoRoutes({
        listCandidates: async () => [{ sessionId: TASK, ...dbRow }],
        listProviders: async () => afterBothRefreshed,
        withSessionLock: async (_sessionId, run) => run(),
        readRoute: async () => cindyAutoRouteToFollow(runtimeState()),
        stage,
        assertCurrent: () => {},
      }),
    ).resolves.toBe(1);
    expect(stage).toHaveBeenCalledWith(
      TASK,
      { ...poolRoute, providerId: 'xd' },
      expect.objectContaining({
        fromProviderId: expect.any(String),
        targetProviderId: expect.any(String),
      }),
    );
  });

  it('负向：故障切换中的任务不跟随', () => {
    acceptSessionRuntimeMutation({
      sessionId: TASK,
      source: 'fallback',
      deferred: false,
      previousProfile: poolRoute,
      profile: { ...poolRoute, model: 'z-ai/glm-5.3-flash', providerId: 'xd' },
    });
    expect(cindyAutoRouteToFollow(runtimeState())).toBeNull();
  });

  it('负向：已有登记的切换不覆盖', () => {
    reloadWithStalePool();
    expect(cindyAutoRouteToFollow(runtimeState(true))).toBeNull();
  });
});

describe('已登记的 Auto 换来源，在 Auto 又挪动后撤销或改写', () => {
  // 9333 上 a91bc630 的真实形态：任务库仍是号池（effort 空串），跟随登记过「下一条切到 Cindy AI」，
  // 之后管理员又把 Auto 挪回号池。
  const TASK = 'a91bc630-93d5-4685-9bef-7f3980b9e49e';
  const REAL_AUTO = 'auto/d00e8b7f-fb6f-4045-922f-310da7b839fc';
  const POOL = 'byok-f83a176f-8e24-494c-8e88-290584b05a76';
  const OTHER_POOL = 'byok-0b4c9d2e-1f3a-4c5b-8d6e-7f8091a2b3c4';
  const current: CindyAutoRoute = {
    agentKind: 'pi',
    model: REAL_AUTO,
    providerId: POOL,
    effort: '',
    fastMode: false,
  };
  const stagedToPlatform = {
    configStaged: true,
    sameAgentSelection: true,
    targetAgentKind: 'pi' as const,
    model: REAL_AUTO,
    providerId: 'xd',
    fastMode: false,
  };

  function follow(
    providers: ProviderView[],
    intent: typeof stagedToPlatform | undefined,
    currentRoute = current,
  ) {
    const stage = vi.fn(async () => {});
    const cancelStagedSwitch = vi.fn(async () => {});
    const readStagedSwitch = async () => stagedCindyAutoSwitch(intent, currentRoute);
    return {
      stage,
      cancelStagedSwitch,
      run: () =>
        followMovedCindyAutoRoutes({
          listCandidates: async () => [{ sessionId: TASK, ...currentRoute }],
          listProviders: async () => providers,
          withSessionLock: async (_sessionId, run) => run(),
          // 已有登记时加锁重读一律不给路由（与真实 readRoute 一致）。
          readRoute: async () => (intent ? null : currentRoute),
          readStagedSwitch,
          cancelStagedSwitch,
          stage,
          assertCurrent: () => {},
        }),
    };
  }

  it('Auto 挪回当前所在的号池：撤销「切到 Cindy AI」的登记，不再登记新切换', async () => {
    const backInPool = [
      provider('xd', 'builtin', ['auto', 'z-ai/glm-5.3-flash']),
      provider(POOL, 'organization', [REAL_AUTO, `${POOL}/e2e-model`]),
    ];
    const { stage, cancelStagedSwitch, run } = follow(backInPool, stagedToPlatform);
    await run();
    expect(cancelStagedSwitch).toHaveBeenCalledWith(TASK);
    expect(stage).not.toHaveBeenCalled();
  });

  it('登记的目标已没有这个 Auto、它去了另一个号池：改登记到那里', async () => {
    const movedToOtherPool = [
      provider('xd', 'builtin', ['auto']),
      provider(POOL, 'organization', [`${POOL}/e2e-model`]),
      provider(OTHER_POOL, 'organization', [REAL_AUTO]),
    ];
    const { stage, cancelStagedSwitch, run } = follow(movedToOtherPool, stagedToPlatform);
    await run();
    expect(stage).toHaveBeenCalledWith(
      TASK,
      { ...current, providerId: OTHER_POOL, effort: null },
      expect.objectContaining({
        fromProviderId: expect.any(String),
        targetProviderId: expect.any(String),
      }),
    );
    expect(cancelStagedSwitch).not.toHaveBeenCalled();
  });

  it('哪里都没有这个 Auto 了：撤销登记，交给既有的来源失效处理', async () => {
    const gone = [
      provider('xd', 'builtin', ['auto']),
      provider(POOL, 'organization', [`${POOL}/e2e-model`]),
    ];
    const { stage, cancelStagedSwitch, run } = follow(gone, stagedToPlatform);
    await run();
    expect(cancelStagedSwitch).toHaveBeenCalledWith(TASK);
    expect(stage).not.toHaveBeenCalled();
  });

  it('登记的目标仍有这个 Auto：保持不动', async () => {
    const stillOnPlatform = [
      provider('xd', 'builtin', ['auto', REAL_AUTO]),
      provider(POOL, 'organization', [`${POOL}/e2e-model`]),
    ];
    const { stage, cancelStagedSwitch, run } = follow(stillOnPlatform, stagedToPlatform);
    await run();
    expect(cancelStagedSwitch).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
  });

  // PR #6355 Codex P1：配置登记也可能切向用户来源；现有撤销/改登记只覆盖 Cindy 两端。
  // unit：走实际跟随入口，不能撤销或覆盖待生效的凭证/计费来源。
  it.each([
    { from: POOL, target: 'custom', availableAt: OTHER_POOL },
    { from: POOL, target: 'custom', availableAt: POOL },
    { from: 'custom', target: 'xd', availableAt: 'custom' },
  ])(
    '保留非 Cindy 两端的配置登记：$from → $target（Auto 在 $availableAt）',
    async ({ from, target, availableAt }) => {
      const providers = [
        provider('xd', 'builtin', availableAt === 'xd' ? [REAL_AUTO] : ['auto']),
        provider(POOL, 'organization', availableAt === POOL ? [REAL_AUTO] : []),
        provider(OTHER_POOL, 'organization', availableAt === OTHER_POOL ? [REAL_AUTO] : []),
        provider('custom', 'user', availableAt === 'custom' ? [REAL_AUTO] : []),
      ];
      const { stage, cancelStagedSwitch, run } = follow(
        providers,
        { ...stagedToPlatform, providerId: target },
        { ...current, providerId: from },
      );
      expect(await run()).toBe(0);
      expect(stage).not.toHaveBeenCalled();
      expect(cancelStagedSwitch).not.toHaveBeenCalled();
    },
  );

  // 本轮内存标记不能扩大跟随范围；原负向矩阵没有携带新标记，也未走完整跟随入口。
  // unit：即使遗留了标记，用户选择/跨引擎/跨电脑/非 Auto 意图的结果都保持不变。
  it('带来源标记的其他切换意图仍不撤销或改登记', async () => {
    for (const patch of [
      { configStaged: undefined },
      { sameAgentSelection: undefined },
      { targetAgentKind: 'claude-code' as const },
      { targetAgentDeviceId: 'device-2' },
      { model: 'auto/other-group' },
      { model: 'z-ai/glm-5.3-flash' },
    ]) {
      const intent = {
        ...stagedToPlatform,
        cindyAutoRelocation: { fromProviderId: POOL, targetProviderId: 'xd' },
        ...patch,
      };
      const before = structuredClone(intent);
      const stage = vi.fn(async () => {});
      const cancel = vi.fn(async () => {});
      await followMovedCindyAutoRoutes({
        listCandidates: async () => [{ sessionId: TASK, ...current }],
        listProviders: async () => [
          provider(POOL, 'organization', []),
          provider('xd', 'builtin', [REAL_AUTO]),
        ],
        withSessionLock: async (_id, run) => run(),
        readRoute: async () => null,
        readStagedSwitch: async () => stagedCindyAutoSwitch(intent, current),
        cancelStagedSwitch: cancel,
        stage,
        assertCurrent: () => {},
      });
      expect(stage).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(intent).toEqual(before);
    }
  });

  it('负向：只认系统登记、同引擎、同一个 Auto、只换来源的登记', () => {
    expect(stagedCindyAutoSwitch(stagedToPlatform, current)).toEqual({
      current,
      targetProviderId: 'xd',
    });
    // 用户自己点选的不动。
    expect(
      stagedCindyAutoSwitch({ ...stagedToPlatform, configStaged: undefined }, current),
    ).toBeNull();
    expect(
      stagedCindyAutoSwitch({ ...stagedToPlatform, sameAgentSelection: undefined }, current),
    ).toBeNull();
    expect(
      stagedCindyAutoSwitch({ ...stagedToPlatform, targetAgentKind: 'claude-code' }, current),
    ).toBeNull();
    expect(
      stagedCindyAutoSwitch({ ...stagedToPlatform, model: 'auto/other-group' }, current),
    ).toBeNull();
    expect(
      stagedCindyAutoSwitch({ ...stagedToPlatform, targetAgentDeviceId: 'device-2' }, current),
    ).toBeNull();
    const plain = { ...current, model: 'z-ai/glm-5.3-flash' };
    expect(
      stagedCindyAutoSwitch({ ...stagedToPlatform, model: 'z-ai/glm-5.3-flash' }, plain),
    ).toBeNull();
    expect(stagedCindyAutoSwitch(undefined, current)).toBeNull();
  });
});

// PR #6355 Greptile P1：目录删除了登记目标后仍须撤销/改登记；原用例只移除模型，不移除来源。
// unit：实际跟随入口登记一次，换目录再跟随；身份元数据存进同一份 pending intent。
describe('Auto 登记后来源从目录消失', () => {
  it.each([
    { from: 'xd', target: 'old-pool', available: 'xd', expected: 'cancel' },
    { from: 'xd', target: 'old-pool', available: 'new-pool', expected: 'new-pool' },
    { from: 'xd', target: 'old-pool', available: null, expected: 'cancel' },
    { from: 'old-pool', target: 'xd', available: 'new-pool', expected: 'new-pool' },
  ])(
    '$from → $target 登记后删除号池，Auto 在 $available 时 $expected',
    async ({ from, target, available, expected }) => {
      const current = route({ providerId: from });
      let providers = [
        provider('xd', 'builtin', target === 'xd' ? [AUTO] : []),
        provider('old-pool', 'organization', target === 'old-pool' ? [AUTO] : []),
      ];
      let intent: PendingAgentSwitchIntent | undefined;
      const stage = vi.fn(
        async (
          _id: string,
          next: CindyAutoRoute,
          identity?: { fromProviderId: string; targetProviderId: string },
        ) => {
          intent = {
            configStaged: true,
            sameAgentSelection: true,
            targetAgentKind: next.agentKind,
            model: next.model,
            providerId: next.providerId,
            cindyAutoRelocation: identity,
          } as PendingAgentSwitchIntent;
        },
      );
      const cancel = vi.fn(async () => {
        intent = undefined;
      });
      const deps: CindyAutoRouteFollowDeps = {
        listCandidates: async () => [{ sessionId: 'task', ...current }],
        listProviders: async () => providers,
        withSessionLock: async (_id, run) => run(),
        readRoute: async () => (intent ? null : current),
        readStagedSwitch: async () => stagedCindyAutoSwitch(intent, current),
        cancelStagedSwitch: cancel,
        stage,
        assertCurrent: () => {},
      };
      expect(await followMovedCindyAutoRoutes(deps)).toBe(1);
      expect(intent?.providerId).toBe(target);
      providers = [
        provider('xd', 'builtin', available === 'xd' ? [AUTO] : []),
        provider('new-pool', 'organization', available === 'new-pool' ? [AUTO] : []),
        provider('custom', 'user', [AUTO]),
      ];
      stage.mockClear();
      await followMovedCindyAutoRoutes(deps);
      if (expected === 'cancel') {
        expect(cancel).toHaveBeenCalledOnce();
        expect(intent).toBeUndefined();
      } else {
        expect(stage).toHaveBeenCalledOnce();
        expect(intent?.providerId).toBe(expected);
        expect(cancel).not.toHaveBeenCalled();
      }
    },
  );
});
