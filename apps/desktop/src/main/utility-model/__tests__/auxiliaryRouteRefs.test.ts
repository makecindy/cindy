/**
 * 测试价值
 * - 生产入口与可观察结果：getEffectiveAuxiliaryModelChain(起标题、摘要、推荐指令等所有辅助请求读的那条链)——
 *   一格选了智能路由时链里出现哪些具体模型、什么顺序；buildAuxiliaryRouteOptions(设置里那几格的候选)列出哪些路由、能不能选。
 * - 规则依据：2026-11-26 用户裁决「辅助模型也要能用路由」(shared/auxiliaryModelChain.ts 的 AUXILIARY_ROUTE_REF_PREFIX)。
 * - 现有覆盖缺口：resolveAuxiliaryModelChain.test.ts 只覆盖具体模型；路由引用的展开、顺序、已删除的路由都没有测试。
 * - 最小失败输入：路由引用原样留在链里(发请求时认不出，整格失效)；时段例外改走的路由没被采用；解析失败后每次读链都重新选路；停用的或别的电脑上的成员被列进本机一次性请求；
 *   路由此刻会选的那个没排到最前；路由删掉后链里还留着它、或界面上显示成一串 id。
 * - tier：unit，配置与解析器都是注入的假实现，不读文件、不启动 Electron。
 * - 实测耗时：单独运行约 1 秒（pnpm exec vitest run src/main/utility-model/__tests__/auxiliaryRouteRefs.test.ts）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuxiliaryModelOption } from '../../../shared/auxiliaryModelSettings.js';
import type { ModelGroupsConfig, ModelGroupResolveResult } from '../../../shared/modelGroups.js';

const h = vi.hoisted(() => ({
  models: [] as string[],
  config: { routes: [] } as ModelGroupsConfig,
  resolve: vi.fn(),
}));

vi.mock('../auxiliary-model-settings-store.js', () => ({
  readAuxiliaryModelSettings: () => ({ models: h.models }),
  isAuxiliaryModelCustomized: () => h.models.length > 0,
}));
vi.mock('../../model-groups/store.js', () => ({ readModelGroupsConfig: () => h.config, readModelGroupsConfigForSelected: () => h.config }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'owner' }));
vi.mock('../../model-groups/startBridge.js', () => ({ getModelGroupStartBridge: () => ({ resolve: h.resolve }) }));

import { encodeCatalogModelPin } from '../../../shared/catalogModelPin.js';
import { buildAuxiliaryRouteOptions } from '../auxiliaryRouteRefs.js';
import { getEffectiveAuxiliaryModelChain } from '../resolveAuxiliaryModelChain.js';

const pin = (providerId: string, model: string, agentKind: 'codex' | 'claude-code' = 'codex') => encodeCatalogModelPin({ providerId, agentKind, model });

const MERGED = {
  id: 'src:auto:openai:luna', name: 'GPT-6 Luna', strategy: 'expiring' as const,
  parent: { id: 'auto:openai', name: 'OpenAI' },
  candidates: [
    { agentKind: 'codex' as const, providerId: 'openai', model: 'gpt-6-luna' },
    { agentKind: 'codex' as const, providerId: 'byok-1', model: 'byok-codex/gpt-6-luna' },
    { agentKind: 'codex' as const, providerId: 'openai', model: 'gpt-6-luna', agentDeviceId: 'share:dash' },
    { agentKind: 'codex' as const, providerId: 'byok-2', model: 'gpt-6-luna', off: true },
  ],
};
const MINE = {
  id: 'r1', name: '省钱', strategy: 'order' as const,
  candidates: [{ agentKind: 'cc' as const, providerId: 'anthropic', model: 'haiku' }],
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('auxiliary models that point at a smart route', () => {
  beforeEach(() => {
    h.config = { routes: [MERGED, MINE] };
    h.resolve.mockReset();
    h.resolve.mockResolvedValue({ outcome: 'unavailable', groupName: '', trace: [] } satisfies ModelGroupResolveResult);
  });

  it('expands a route into its enabled local members, the route’s current pick first', async () => {
    h.models = ['route:src:auto:openai:luna', pin('xd', 'tencent/hy3')];
    // 第一次读链时还没算出路由会选谁：按路由里的先后。
    expect(getEffectiveAuxiliaryModelChain()).toEqual({
      source: 'custom',
      refs: [pin('openai', 'gpt-6-luna'), pin('byok-1', 'byok-codex/gpt-6-luna'), pin('xd', 'tencent/hy3')],
    });
    await flush();
    expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({
      selection: { type: 'route', id: 'src:auto:openai:luna' }, dryRun: true, location: { agentDeviceId: null },
    }));

    // 算出来路由此刻会用第二个成员：它排到最前，其余照旧兜底。
    h.resolve.mockResolvedValue({
      outcome: 'routed', groupName: 'OpenAI', modelName: 'GPT-6 Luna', sourceName: 'OpenAI-Codex', why: 'only', trace: [],
      route: { agentKind: 'codex', providerId: 'byok-1', model: 'byok-codex/gpt-6-luna' },
    } as unknown as ModelGroupResolveResult);
    h.config = { routes: [{ ...MERGED, id: 'src:auto:openai:luna2' }, MINE] };
    h.models = ['route:src:auto:openai:luna2'];
    getEffectiveAuxiliaryModelChain();
    await flush();
    await flush();
    expect(getEffectiveAuxiliaryModelChain().refs).toEqual([pin('byok-1', 'byok-codex/gpt-6-luna'), pin('openai', 'gpt-6-luna')]);
  });

  // 2026-11-26 Greptile：时段例外此刻把这条路由改走另一条时，辅助请求也要用那一条的成员(与新任务选路同一个判断)。
  it('follows a time-of-day exception to the route it currently uses', () => {
    h.config = { routes: [MERGED, { ...MINE, id: 'r-hours', exceptions: [{ when: { type: 'hours', from: 0, to: 24 }, use: { type: 'route', routeId: MERGED.id } }] }] };
    h.models = ['route:r-hours'];
    expect(getEffectiveAuxiliaryModelChain().refs).toEqual([pin('openai', 'gpt-6-luna'), pin('byok-1', 'byok-codex/gpt-6-luna')]);
  });

  // 2026-11-26 Greptile：解析失败或选不出本机来源时也等满刷新间隔，不随每次读链重新跑一遍选路。
  it('waits out the refresh interval after a failed or unavailable resolve', async () => {
    h.config = { routes: [{ ...MERGED, id: 'src:auto:openai:luna3' }, MINE] };
    h.models = ['route:src:auto:openai:luna3'];
    h.resolve.mockRejectedValueOnce(new Error('catalog unavailable'));
    getEffectiveAuxiliaryModelChain();
    await flush();
    getEffectiveAuxiliaryModelChain();
    getEffectiveAuxiliaryModelChain();
    await flush();
    expect(h.resolve).toHaveBeenCalledTimes(1);
  });

  it('drops a deleted route from the chain and offers it as an unavailable, nameless entry', () => {
    h.models = ['route:gone', pin('xd', 'tencent/hy3')];
    expect(getEffectiveAuxiliaryModelChain().refs).toEqual([pin('xd', 'tencent/hy3')]);

    const usable = new Map<string, AuxiliaryModelOption>([
      [pin('openai', 'gpt-6-luna'), { id: pin('openai', 'gpt-6-luna'), modelName: 'GPT-6 Luna', subscription: true } as AuxiliaryModelOption],
    ]);
    const options = buildAuxiliaryRouteOptions(usable, h.models);
    expect(options.map((option) => [option.id, option.providerId, option.available, option.route])).toEqual([
      ['route:src:auto:openai:luna', 'sroute:auto:openai', true, { kind: 'merged', name: 'OpenAI', members: 2 }],
      // 成员(Claude 的 haiku)此刻用不了：列着，但不能选。
      ['route:r1', 'sroute:mine', false, { kind: 'route', name: '省钱', members: 1 }],
      ['route:gone', 'sroute:mine', false, { kind: 'route', name: '', members: 0 }],
    ]);
    expect(options[0]).toMatchObject({ modelName: 'GPT-6 Luna', subscription: true, modelId: 'gpt-6-luna' });
  });

  // 2026-11-26 排查：每一格都是已删除的路由时链是空的，标题、摘要一个模型都没有；按没设置处理、用默认的链。
  it('uses the default chain when every slot is a route that is gone', () => {
    h.models = ['route:gone'];
    const chain = getEffectiveAuxiliaryModelChain();
    expect(chain.source).not.toBe('custom');
    expect(chain.refs.length).toBeGreaterThan(0);
  });

  // 生产入口与可观察结果：getEffectiveAuxiliaryModelChain + buildAuxiliaryRouteOptions 对含 acp 候选的模型组的处理。
  // 规则依据：2026-11-27 模型组允许 acp 插件引擎，但辅助模型一次性请求直连 HTTP、不拉起 ACP 进程，必须过滤 acp 候选。
  // 覆盖缺口：此前 ModelGroupAgentKind 不含 'acp'，没有用例验证含插件引擎候选的路由不会污染辅助模型链。
  // 最小失败输入与 tier：unit，包含 acp 与内置 codex 混合候选的路由 + 仅含 acp 候选的路由。
  it('filters plugin engine (acp) candidates out of auxiliary chains and route options', () => {
    const mixed = {
      id: 'r-mixed-acp',
      name: '混合路由',
      strategy: 'order' as const,
      candidates: [
        { agentKind: 'acp' as const, providerId: 'acp-plugin:dsh:dsh', model: 'deepseek-v4' },
        { agentKind: 'codex' as const, providerId: 'openai', model: 'gpt-6-luna' },
      ],
    };
    const acpOnly = {
      id: 'r-acp-only',
      name: '仅插件',
      strategy: 'order' as const,
      candidates: [
        { agentKind: 'acp' as const, providerId: 'acp-plugin:dsh:dsh', model: 'deepseek-v4' },
      ],
    };
    h.config = { routes: [mixed, acpOnly] };
    h.models = ['route:r-mixed-acp', 'route:r-acp-only'];
    expect(getEffectiveAuxiliaryModelChain().refs).toEqual([pin('openai', 'gpt-6-luna')]);

    const usable = new Map<string, AuxiliaryModelOption>([
      [pin('openai', 'gpt-6-luna'), { id: pin('openai', 'gpt-6-luna'), modelName: 'GPT-6 Luna', subscription: true } as AuxiliaryModelOption],
    ]);
    const options = buildAuxiliaryRouteOptions(usable, h.models);
    expect(options.find((o) => o.id === 'route:r-mixed-acp')).toMatchObject({
      available: true,
      route: { kind: 'route', name: '混合路由', members: 1 },
    });
    expect(options.find((o) => o.id === 'route:r-acp-only')).toMatchObject({
      available: false,
      route: { kind: 'route', name: '仅插件', members: 0 },
    });
  });
});
