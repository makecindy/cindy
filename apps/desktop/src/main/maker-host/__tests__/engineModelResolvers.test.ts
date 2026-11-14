/*
 * 测试价值
 * - 生产入口与可观察结果：engineModelResolvers.ts 的三个工厂交给引擎的按模型解析结果
 *   （上下文上限、输出上限、压缩阈值、核实窗口、思考档位、Codex 线程窗口）。桌面三个构造点与
 *   Node Host 都改用这三个工厂，结果必须和原来写在构造点里的闭包一致。
 * - 规则依据：原闭包在每次调用时读目录（目录随账号与目录刷新变化），按「本次实际路由」解析
 *   provider，再读用户的模型级覆盖，没有覆盖才用目录默认窗口；Codex 的 resolveModelContextLimit
 *   刻意不回落目录默认值；Pi 用完整目录和不带隐式默认的路由解析。
 * - 最小失败输入：工厂在创建时就把目录读死；Codex 上限回落了目录默认值；Claude 的输出上限、
 *   思考档位按同名但不同路由的模型取值；Pi 没带 provider 时没有落到网关描述。
 * - tier：unit（纯函数，模块边界只 mock 模型级覆盖的存储；不起进程、不读真实 profile）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, type AgentKind, type Catalog } from '@cindy/model-providers';

const state = vi.hoisted(() => ({ limits: new Map<string, number>(), compaction: new Map<string, number>() }));
vi.mock('../model-context-limit-store.js', () => ({
  readModelContextLimit: (agent: string, provider: string, model: string) =>
    state.limits.get(`${agent}:${provider}:${model}`) ?? null,
  resolveModelCompactionPct: (_catalog: unknown, agent: string, provider: string | null, model: string) =>
    (provider ? state.compaction.get(`${agent}:${provider}:${model}`) : undefined) ?? null,
}));

import { createClaudeModelResolvers, createCodexModelResolvers, createPiModelResolvers } from '../engineModelResolvers.js';
import { resolveModelContextProviderId } from '../catalog-to-descriptors.js';

/** Two routes publish the same model id with different capacity, output cap and efforts. */
function catalogFor(agent: AgentKind, contextWindow = 128_000): Catalog {
  const catalog = structuredClone(BUNDLED_CATALOG) as Catalog;
  const second = catalog.providers.find((provider) => provider.id !== 'xd')!.id;
  for (const provider of catalog.providers) {
    const routed = provider.id === 'xd' || provider.id === second;
    provider.models[agent] = routed
      ? [{ id: 'shared-model', name: 'Shared', contextWindow: provider.id === 'xd' ? contextWindow : 272_000,
        contextWindowVerified: true, maxOutput: provider.id === 'xd' ? 32_000 : 64_000,
        efforts: provider.id === 'xd' ? ['low', 'high'] : ['medium'], defaultEffort: null }]
      : [];
    if (routed) provider.routing[agent] = { ...(provider.routing[agent] ?? {}), disabled: false } as never;
  }
  return catalog;
}

const xdOnly = () => 'xd';

beforeEach(() => {
  state.limits.clear();
  state.compaction.clear();
});

describe('Claude resolvers', () => {
  it('use the actual route, prefer the saved model limit, and fall back to the catalog window', () => {
    const catalog = catalogFor('claude-code');
    const resolvers = createClaudeModelResolvers({ getCatalog: () => catalog, resolveContextProviderId: xdOnly });
    expect(resolvers.resolveModelContextLimit(null, 'shared-model')).toBe(128_000);
    state.limits.set('claude-code:xd:shared-model', 100_000);
    expect(resolvers.resolveModelContextLimit(null, 'shared-model')).toBe(100_000);
    expect(resolvers.resolveModelMaxOutputTokens(null, 'shared-model')).toBe(32_000);
    expect(resolvers.resolveModelEfforts(null, 'shared-model')).toEqual(['low', 'high']);
    state.compaction.set('claude-code:xd:shared-model', 70);
    expect(resolvers.resolveModelCompactionPct(null, 'shared-model')).toBe(70);
  });

  it('read the catalog on every call, not when the factory is built', () => {
    let catalog = catalogFor('claude-code', 128_000);
    const resolvers = createClaudeModelResolvers({ getCatalog: () => catalog, resolveContextProviderId: xdOnly });
    expect(resolvers.resolveModelContextLimit(null, 'shared-model')).toBe(128_000);
    catalog = catalogFor('claude-code', 200_000);
    expect(resolvers.resolveModelContextLimit(null, 'shared-model')).toBe(200_000);
  });

  it('return null when the route is unknown', () => {
    const resolvers = createClaudeModelResolvers({ getCatalog: () => catalogFor('claude-code'), resolveContextProviderId: () => null });
    expect(resolvers.resolveModelContextLimit(null, 'shared-model')).toBeNull();
    expect(resolvers.resolveModelEfforts(null, 'shared-model')).toBeNull();
  });
});

describe('Codex resolvers', () => {
  it('never fall back to the catalog window for the CLI limit, but the thread window does', () => {
    const catalog = catalogFor('codex');
    const resolvers = createCodexModelResolvers({
      getCatalog: () => catalog, resolveContextProviderId: xdOnly,
      getCodexHome: () => '/nonexistent/codex-home', getCodexBinaryPath: () => '/nonexistent/codex',
    });
    expect(resolvers.resolveModelContextLimit(null, 'shared-model')).toBeNull();
    expect(resolvers.resolveCodexThreadContextWindow(null, 'shared-model')).toBe(128_000);
    state.limits.set('codex:xd:shared-model', 90_000);
    expect(resolvers.resolveModelContextLimit(null, 'shared-model')).toBe(90_000);
    expect(resolvers.resolveCodexThreadContextWindow(null, 'shared-model')).toBe(90_000);
  });
});

describe('Pi resolvers', () => {
  it('resolve with the plain route resolver: an unnamed provider is the gateway descriptor', () => {
    const catalog = catalogFor('pi');
    const second = catalog.providers.find((provider) => provider.id !== 'xd')!.id;
    const resolvers = createPiModelResolvers({ getCatalog: () => catalog, resolveContextProviderId: resolveModelContextProviderId });
    expect(resolvers.resolveModelContextLimit(null, 'shared-model')).toBe(128_000);
    expect(resolvers.resolveModelContextLimit(second, 'shared-model')).toBe(272_000);
    state.limits.set(`pi:${second}:shared-model`, 50_000);
    expect(resolvers.resolveModelContextLimit(second, 'shared-model')).toBe(50_000);
  });
});
