// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：智能路由页「分配」一栏的 `ProviderAllocationRows`(真实组件)，看列出的行与点按钮后发出的保存命令。
 * - Bug／规则依据：model-groups.md §6.4、provider-groups.md：main 2026-11-25 加入的 OpenAI 订阅与 API key 混合账号组，选法
 *   与其他账号池一样只在智能路由里改(2026-11-26)。此前这一行把它当成「几台电脑」：提示写电脑数，「按顺序／按权重」时
 *   只列出电脑、不列账号，账号的先后与权重在这里改不了。
 * - 现有覆盖缺口：智能路由页的分配行此前没有组件测试。
 * - 最小失败输入：一个混合组(本机 OpenAI + 一个 API key 账号)，选法为「按权重」。
 * - tier：unit(jsdom，假 IPC 与假目录)。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig } from '../../../../shared/providerGroup';

const h = vi.hoisted(() => ({
  groups: {} as Record<string, unknown>,
  save: vi.fn(),
  localPluginEngines: [] as unknown[],
  sharedPluginDevices: [] as Array<{ deviceId: string; name: string }>,
  remotePluginCatalogues: new Map<string, readonly unknown[] | null>(),
  providers: [
    { id: 'openai', name: 'OpenAI', connected: true, agents: [], routing: {}, models: {} },
    { id: 'key-1', name: 'Fixture key', connected: true, agents: [], routing: {}, models: {} },
  ] as Array<Record<string, unknown>>,
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string, args?: { count?: number }) => (args?.count !== undefined ? `${key}:${args.count}` : key), i18n: { language: 'zh-CN' } }),
}));
vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: h.providers }),
}));
vi.mock('@/hooks/usePluginEngines', () => ({
  usePluginEngines: () => h.localPluginEngines,
  useDevicesPluginEngines: () => ({ catalogues: h.remotePluginCatalogues, read: vi.fn() }),
  useRemotePluginEngines: () => [],
}));
vi.mock('@/hooks/useControllableDevices', () => ({
  useSelectableDevices: () => ({ devices: [] }),
}));
vi.mock('@/features/provider-share/useProviderShareAgentDevices', () => ({
  useProviderShareAgentDevices: () => ({
    devices: [],
    pluginEngineDevices: h.sharedPluginDevices,
    loaded: true,
    nameFor: () => null,
    isKnown: () => false,
    isReceived: () => false,
  }),
}));
vi.mock('@/hooks/useModelRouteDevices', () => ({
  useModelRouteDevices: () => ({ devices: [], leadAgentDeviceId: null }),
}));
vi.mock('@/hooks/useDevicesProviders', () => ({
  useDevicesProviders: () => new Map(),
}));
vi.mock('@/features/provider-group/useLocalProviderGroups', () => ({ useLocalProviderGroups: () => h.groups }));
vi.mock('@/features/provider-group/useProviderGroup', () => ({ useProviderGroup: () => ({ view: null, save: h.save }) }));
vi.mock('react-router-dom', () => ({ useInRouterContext: () => false }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }) }));
vi.mock('@/components/new-chat/ModelSelector', () => ({ ProviderMark: () => null, ModelSelector: () => null }));

import { ProviderAllocationRows, SourceRouteDetail, useSourceOptions, WholeProviderAddRow } from '../ModelGroupsAutoRoutes';

afterEach(() => cleanup());

it('lists the accounts of a mixed OpenAI group and reorders them through the account allocation', async () => {
  const config: ProviderGroupConfig = {
    strategy: 'weighted', autoSwitch: true,
    members: [{ key: 'local', kind: 'local', agentDeviceId: null, providerId: 'openai', weight: 1, limit: 4, paused: false }],
    localAccountIds: ['key-1'],
  };
  h.groups = { openai: config };
  const command = vi.fn(async () => config);
  Object.assign(window, { electronAPI: { providerGroup: { command } } });
  render(<ProviderAllocationRows config={{ routes: [] } as never} />);

  const head = document.querySelector('[data-auto-route="computers:openai"]')!;
  expect(head.textContent).toContain('modelGroups.auto.accounts:2');
  expect(head.textContent).not.toContain('modelGroups.auto.computers');
  const rows = [...document.querySelectorAll('[data-auto-route-member]')].map((row) => row.textContent);
  expect(rows).toEqual([expect.stringContaining('OpenAI'), expect.stringContaining('Fixture key')]);

  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'modelGroups.settings.moveDown' })[0]!); });
  expect(command).toHaveBeenCalledWith({
    action: 'account-allocation', providerId: 'openai', expectedConfig: config, edit: { order: ['key-1', 'openai'] },
  });
  // 账号的设置不经整份组配置保存，免得覆盖账号分配里存的先后与权重。
  expect(h.save).not.toHaveBeenCalled();
});

// 2026-11-26(dash 建议做减法)：选法选择框主推「自动」「按顺序」，轮流、按权重、余量最多、用完再换收在「更多选法」下面，
// 功能不删；同一个供应商的账号与电脑之间价格相同，不列「最省钱」。
it('features Automatic and In order and keeps the other strategies under More options', async () => {
  h.groups = { openai: {
    strategy: 'expiring', autoSwitch: true,
    members: [{ key: 'local', kind: 'local', agentDeviceId: null, providerId: 'openai', weight: 1, limit: 4, paused: false }],
    localAccountIds: ['key-1'],
  } };
  Object.assign(window, { electronAPI: { providerGroup: { command: vi.fn() } } });
  // jsdom 没有 scrollIntoView：下拉列表打开时会滚到选中项。
  Element.prototype.scrollIntoView ??= () => undefined;
  render(<ProviderAllocationRows config={{ routes: [] } as never} />);
  fireEvent.click(screen.getByRole('combobox', { name: 'modelGroups.auto.pickFor' }));
  const options = (await screen.findAllByRole('option')).map((option) => option.textContent);
  expect(options).toEqual([
    'modelGroups.strategy.expiring.title', 'modelGroups.strategy.order.title',
    'modelGroups.strategy.rotate.title', 'modelGroups.strategy.weighted.title',
    'modelGroups.strategy.drain.title', 'modelGroups.strategy.headroom.title',
  ]);
  expect(screen.getByText('modelGroups.settings.moreStrategies')).toBeTruthy();
});

// 2026-11-27(用户反馈：智能路由「添加整个供应商」无法加入本机与分享的 Antigravity ACP 插件引擎)：
// 验证 useSourceOptions + WholeProviderAddRow 列出本机与分享的 ACP 引擎，选中后回调带出 acp-plugin: 与 share: 位置。
it('lists local and shared ACP plugin engines in WholeProviderAddRow and emits their source on select', async () => {
  const localAgy = {
    key: 'antigravity:agy', providerId: 'acp-plugin:antigravity:agy', ghostId: 'antigravity', harnessId: 'agy',
    name: 'Antigravity', availability: { state: 'available' },
    models: [{ id: 'gemini-4-neon', displayName: 'Gemini 4 Neon' }],
    permissionModes: [], defaultPermissionMode: 'ask',
  };
  const sharedAgy = {
    ...localAgy,
    remoteUse: { supported: true, enabled: true, shareSupported: true },
  };
  h.localPluginEngines = [localAgy];
  h.sharedPluginDevices = [{ deviceId: 'share:dash-agy', name: '来自 dash 的分享' }];
  h.remotePluginCatalogues = new Map([['share:dash-agy', [sharedAgy]]]);
  Element.prototype.scrollIntoView ??= () => undefined;
  const onAdd = vi.fn();
  function Harness() {
    const options = useSourceOptions();
    return <WholeProviderAddRow options={options} taken={[]} onAdd={onAdd} />;
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('combobox', { name: 'modelGroups.sources.addWhole' }));
  const optionLabels = (await screen.findAllByRole('option')).map((option) => option.textContent);
  expect(optionLabels).toContain('Antigravity');
  expect(optionLabels).toContain('Antigravity · 来自 dash 的分享');
  fireEvent.click(screen.getByRole('option', { name: 'Antigravity · 来自 dash 的分享' }));
  expect(onAdd).toHaveBeenCalledWith({ providerId: 'acp-plugin:antigravity:agy', agentDeviceId: 'share:dash-agy' });
  h.localPluginEngines = [];
  h.sharedPluginDevices = [];
  h.remotePluginCatalogues = new Map();
});

// 2026-11-27 回归：供应商路由被隐藏(hidden)或本机成员被取消参与(source.off)后，
// 该本机供应商的账号/电脑分配行应恢复在「分配」栏显示，不能继续被当成合并成员隐藏。
it('restores local allocation row when source route is hidden or member is turned off', () => {
  h.groups = { openai: {
    strategy: 'expiring', autoSwitch: true,
    members: [{ key: 'local', kind: 'local', agentDeviceId: null, providerId: 'openai', weight: 1, limit: 4, paused: false }],
    localAccountIds: ['key-1'],
  } };
  const merged = render(<ProviderAllocationRows config={{
    routes: [],
    sourceRoutes: [{ id: 'auto:openai', name: 'OpenAI', strategy: 'expiring', sources: [{ providerId: 'openai' }] }],
  } as never} />);
  expect(document.querySelector('[data-auto-route="computers:openai"]')).toBeNull();
  merged.unmount();

  const turnedOff = render(<ProviderAllocationRows config={{
    routes: [],
    sourceRoutes: [{ id: 'auto:openai', name: 'OpenAI', strategy: 'expiring', sources: [{ providerId: 'openai', off: true }] }],
  } as never} />);
  expect(document.querySelector('[data-auto-route="computers:openai"]')).toBeTruthy();
  turnedOff.unmount();

  render(<ProviderAllocationRows config={{
    routes: [],
    sourceRoutes: [{ id: 'auto:openai', name: 'OpenAI', strategy: 'expiring', hidden: true, sources: [{ providerId: 'openai' }] }],
  } as never} />);
  expect(document.querySelector('[data-auto-route="computers:openai"]')).toBeTruthy();
});

// 2026-11-28 用户裁决：路由选项里不出现再次合并的嵌套自动来源（无两层自动）。
// 本机多账号池直接拆平为 1、2、3、4 各自独立的开关行；「试一下」直接列出每个扁平账号与配额；
// 手动「添加来源」下拉也直接列出拆平后的单个账号，不列出被包裹的整池。
it('renders flattened local accounts as individual toggleable sources with flat preview and no nested auto rows', async () => {
  const prevProviders = h.providers;
  h.groups = {
    openai: {
      strategy: 'expiring',
      autoSwitch: true,
      members: [{ key: 'local', kind: 'local', agentDeviceId: null, providerId: 'openai', weight: 1, limit: 4, paused: false }],
    },
  };
  h.providers = [
    {
      id: 'openai', name: 'OpenAI', connected: true, subscriptionAccountPool: 'openai',
      subscriptionAccountKeys: ['a', 'b'], agents: ['codex'], routing: { codex: {} },
      models: { codex: [{ id: 'gpt-6.2', name: 'GPT-6.2' }] },
    },
    {
      id: 'byok-1', name: 'OpenAI-Codex', connected: true, agents: ['codex'], routing: { codex: {} },
      models: { codex: [{ id: 'gpt-6.2', name: 'GPT-6.2' }] },
    },
    // The old connection name is no longer an independent account or addable source.
    { id: 'old-openai', name: 'Old OpenAI alias', connected: true, subscriptionPoolAlias: true, subscriptionPoolTarget: 'openai',
      subscriptionAccountPool: 'openai', agents: ['codex'], routing: {}, models: {} },
  ];
  const readPool = vi.fn(async () => ({
    provider: 'openai',
    providerId: 'openai',
    strategy: 'expiring',
    accounts: [
      { id: 'default', identity: 'first@example.com', status: 'ready', running: 0, weight: 1, limit: 4, paused: false },
      { id: 'second', identity: 'second@example.com', status: 'ready', running: 0, weight: 1, limit: 4, paused: false },
    ],
  }));
  const resolveMock = vi.fn(async () => ({
    outcome: 'routed',
    groupName: 'OpenAI',
    route: { agentKind: 'codex', providerId: 'openai', accountId: 'default', model: 'gpt-6.2' },
    modelName: 'GPT-6.2',
    sourceName: 'OpenAI · first@example.com',
    why: 'expiring',
    quota: { usedPercent: 18, resetAtMs: Date.now() + 7_200_000, windowMs: 18_000_000 },
    trace: [
      {
        agentKind: 'codex', providerId: 'openai', accountId: 'default', model: 'gpt-6.2',
        modelName: 'GPT-6.2', sourceName: 'OpenAI · first@example.com', state: 'picked', why: 'expiring',
        quota: { usedPercent: 18, resetAtMs: Date.now() + 7_200_000, windowMs: 18_000_000 },
      },
      {
        agentKind: 'codex', providerId: 'openai', accountId: 'second', model: 'gpt-6.2',
        modelName: 'GPT-6.2', sourceName: 'OpenAI · second@example.com', state: 'standby', why: 'standby',
        quota: { usedPercent: 55, resetAtMs: Date.now() + 14_400_000, windowMs: 18_000_000 },
      },
      {
        agentKind: 'codex', providerId: 'byok-1', model: 'gpt-6.2',
        modelName: 'GPT-6.2', sourceName: 'OpenAI-Codex', state: 'standby', why: 'standby',
        quota: null,
      },
    ],
  }));
  const save = vi.fn(async (change: (latest: Record<string, unknown>) => Record<string, unknown>) => {
    change({
      routes: [],
      sourceRoutes: [{
        id: 'auto:openai', name: 'OpenAI', strategy: 'expiring', auto: true,
        sources: [
          { providerId: 'openai', accountId: 'default' },
          { providerId: 'openai', accountId: 'second' },
          { providerId: 'byok-1' },
        ],
      }],
    });
    return true;
  });
  Object.assign(window, {
    electronAPI: {
      subscriptionAccounts: { command: readPool, onChanged: () => () => undefined },
      modelGroups: { resolve: resolveMock },
    },
  });
  try {
    const expandedRoute = {
      id: 'src:openai-gpt',
      name: 'GPT-6.2',
      strategy: 'expiring' as const,
      parent: { id: 'auto:openai', name: 'OpenAI' },
      candidates: [
        { agentKind: 'codex' as const, providerId: 'openai', accountId: 'default', model: 'gpt-6.2' },
        { agentKind: 'codex' as const, providerId: 'openai', accountId: 'second', model: 'gpt-6.2' },
        { agentKind: 'codex' as const, providerId: 'byok-1', model: 'gpt-6.2' },
      ],
    };
    const onAdd = vi.fn();
    function Harness() {
      const options = useSourceOptions();
      return (
        <>
          <SourceRouteDetail
            route={{
              id: 'auto:openai', name: 'OpenAI', strategy: 'expiring', auto: true,
              sources: [
                { providerId: 'openai', accountId: 'default' },
                { providerId: 'openai', accountId: 'second' },
                { providerId: 'byok-1' },
              ],
            }}
            config={{ routes: [expandedRoute] } as never}
            options={options}
            save={save as never}
            onBack={vi.fn()}
          />
          <WholeProviderAddRow options={options} taken={[]} onAdd={onAdd} />
        </>
      );
    }
    render(<Harness />);
    await screen.findByText('OpenAI · first@example.com');
    await screen.findByText('OpenAI · second@example.com');
    // 无任何嵌套账号/电脑分配行（绝不出现两层自动）。
    expect(document.querySelector('[data-auto-route^="accounts:"]')).toBeNull();
    expect(document.querySelector('[data-auto-route^="computers:"]')).toBeNull();
    expect(screen.queryByText(/modelGroups\.auto\.accounts/)).toBeNull();
    // 三个扁平来源各自一行，依次编号 1、2、3。
    const rows = [0, 1, 2].map((i) => document.querySelector(`[data-source-route-member="${i}"]`)?.textContent ?? '');
    expect(rows[0]).toContain('OpenAI · first@example.com');
    expect(rows[1]).toContain('OpenAI · second@example.com');
    expect(rows[2]).toContain('OpenAI-Codex');

    // 点击「试一下」：直接列出每个扁平账号与 BYOK，没有被包裹的 auto。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'modelGroups.settings.try.run' }));
    });
    const preview = await screen.findByTestId('model-group-preview');
    expect(preview.textContent).toContain('GPT-6.2 · OpenAI · first@example.com');
    expect(preview.textContent).toContain('GPT-6.2 · OpenAI · second@example.com');
    expect(preview.textContent).toContain('GPT-6.2 · OpenAI-Codex');

    // 手动「添加来源」下拉只列单账号，不列整池。
    fireEvent.click(screen.getByRole('combobox', { name: 'modelGroups.sources.addWhole' }));
    expect(screen.queryByRole('option', { name: /Old OpenAI alias/ })).toBeNull();
    expect(readPool).not.toHaveBeenCalledWith(expect.objectContaining({ providerId: 'old-openai' }));
    fireEvent.click(screen.getByRole('option', { name: 'OpenAI · second@example.com' }));
    expect(onAdd).toHaveBeenCalledWith({ providerId: 'openai', accountId: 'second' });
  } finally {
    h.providers = prevProviders;
    h.groups = {};
  }
});
