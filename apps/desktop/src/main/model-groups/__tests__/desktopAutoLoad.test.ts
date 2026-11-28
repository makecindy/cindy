/**
 * 测试价值
 * - 生产入口与结果：Desktop 的 resolver.resolve 预览应挑空闲来源，并说明「其他来源正在运行任务」。
 * - 回归依据：PR #13648 移除展示优先级端口时误删并发计数接线。
 * - 现有缺口：picker 与 resolver 单测直接注入负载，覆盖不到桌面装配。
 * - 拆平回归：同供应商下首个订阅账号正在运行、另一个闲置，夹有按量账号。预览与正式解析都选空闲订阅账号。
 * - 最小输入：两个同分候选，首个来源有一个运行中的任务。tier: unit，替换宿主边界，无数据库或网络。
 */
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import type { ModelGroupRoute } from '../../../shared/modelGroups.js';
import type { LocalSubscriptionAccountSource } from '../../subscription-accounts/runtime.js';
import { clearSessionProvider, setSessionProvider } from '../../maker-host/session-provider-store.js';
import { desktopModelGroupRuntime, resolver } from '../desktopResolver.js';

const sources = ['first-source', 'second-source'] as const;
const route: ModelGroupRoute = {
  id: 'load-test',
  name: 'Auto',
  strategy: 'expiring',
  candidates: sources.map(providerId => ({ agentKind: 'codex', providerId, model: 'gpt-6' })),
};

const host = vi.hoisted(() => ({
  activities: vi.fn<() => { sessionId: string; phase: string }[]>().mockReturnValue([]),
  route: null as ModelGroupRoute | null,
  accounts: [] as LocalSubscriptionAccountSource[],
}));

vi.mock('../../agent-island/service.js', () => ({
  getAgentIslandService: () => ({ getSessionActivitySnapshots: host.activities }),
}));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'load-test-owner' }));
vi.mock('../../device-link/index.js', () => ({}));
vi.mock('../../goal-host/index.js', () => ({}));
vi.mock('../../i18n.desktop.js', () => ({ t: (key: string) => key }));
vi.mock('../../localDb/sessionDispatchSnapshot.js', () => ({}));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({
    listProviders: async () => [...sources, 'openai'].map(id => ({
      id, name: id, source: 'user', connected: true, agents: ['codex'], routing: { codex: { enabled: true } },
      models: { codex: [{ id: 'gpt-6', name: 'GPT-6' }] },
    }) as unknown as ProviderView),
  }),
}));
vi.mock('../../maker-ipc/pluginEnginesIpc.js', () => ({ listPluginEngineViews: () => [], onPluginEnginesChanged: () => {} }));
vi.mock('../../maker-ipc/workerAgentLocations.js', () => ({
  readWorkerAgentLocations: async () => ({ locations: [] }),
}));
vi.mock('../../maker-host/remote-provider-access-store.js', () => ({}));
vi.mock('../../provider-group/runtime.js', () => ({}));
vi.mock('../../provider-group/store.js', () => ({ readProviderGroup: () => null }));
vi.mock('../../quota-overview/service.js', () => ({
  getQuotaOverviewService: () => ({ lease: () => {}, latest: () => null, fresh: async () => null }),
}));
vi.mock('../../scheduler-host/billingHolds.js', () => ({}));
vi.mock('../../subscription-accounts/runtime.js', () => ({
  listSubscriptionPoolSources: () => host.accounts,
  onSubscriptionAccountsChanged: () => {},
}));
vi.mock('../../usage/modelPricing.js', () => ({}));
vi.mock('../../usage/referenceModelPricing.js', () => ({}));
vi.mock('../../remote-agent/controller/deviceCatalog.js', () => ({}));
vi.mock('../../usage/ledgerCurrency.js', () => ({}));
vi.mock('../autoUsageProfile.js', async importOriginal => ({
  ...await importOriginal<typeof import('../autoUsageProfile.js')>(),
  readLocalAutoUsageSamples: async () => [],
}));
vi.mock('../store.js', () => ({
  readModelGroupsConfigForSelected: () => ({ routes: [host.route ?? route] }),
  setModelGroupSourceCatalog: () => {},
}));

vi.mock('../../cindy-brain/ghostModelPicker.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../cindy-brain/ghostModelPicker.js')>(),
  getPluginModelPickerAgents: () => ['codex'],
  isPluginRouteHarnessInstalled: async () => true,
}));

afterEach(() => {
  clearSessionProvider('busy-task');
  host.route = null;
  host.accounts = [];
  host.activities.mockReset().mockReturnValue([]);
  desktopModelGroupRuntime.dispose();
});

it('previews an idle source over an equally eligible source running a task', async () => {
  setSessionProvider('busy-task', sources[0]);
  host.activities.mockReturnValue([{ sessionId: 'busy-task', phase: 'running' }]);
  const request = { selection: { type: 'route', id: route.id }, dryRun: true } as const;

  expect(await resolver.resolve(request)).toMatchObject({
    outcome: 'routed', route: { providerId: sources[1] }, why: 'lessBusy',
  });
  expect(host.activities).toHaveBeenCalledTimes(1);

  host.activities.mockReturnValue([{ sessionId: 'busy-task', phase: 'completed' }]);
  expect(await resolver.resolve(request)).toMatchObject({
    outcome: 'routed', route: { providerId: sources[0] }, why: 'order',
  });
});

it('keeps flattened accounts independent and keeps a merged API key in reserve', async () => {
  host.accounts = [
    { id: 'paid', label: 'API Key', paused: false, usable: true, running: 0, apiConnectionId: 'test-api' },
    { id: 'default', label: 'First subscription', paused: false, usable: true, running: 1 },
    { id: 'second', label: 'Second subscription', paused: false, usable: true, running: 0 },
  ];
  host.route = {
    ...route,
    id: 'flat-load-test',
    parent: { id: 'source-route', name: 'OpenAI' },
    candidates: host.accounts.map(({ id: accountId }) => ({
      agentKind: 'codex', providerId: 'openai', accountId, model: 'gpt-6',
    })),
  };
  const selection = { type: 'route', id: host.route.id } as const;

  const preview = await resolver.resolve({ selection, dryRun: true });
  expect(preview).toMatchObject({
    outcome: 'routed', route: { providerId: 'openai', accountId: 'second' }, why: 'lessBusy',
  });
  expect(preview.trace[0]).toMatchObject({ accountId: 'paid', state: 'standby', why: 'paygReserve' });
  expect(await resolver.resolve({ selection })).toMatchObject({ route: { accountId: 'second' } });

  host.accounts[1].running = 0;
  expect(await resolver.resolve({ selection, dryRun: true })).toMatchObject({ route: { accountId: 'default' } });
});
