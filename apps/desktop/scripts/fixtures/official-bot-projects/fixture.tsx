// 「项目与模型」区块(所有官方机器人共用一份)经真实设置页渲染的各种状态。
import { BUNDLED_CATALOG, type ProviderView } from '@cindy/model-providers';

import { HookConnectionsSection } from '../../../src/renderer/components/settings/HookConnectionsSection';
import { ImPluginEntrancesCard } from '../../../src/renderer/components/settings/ImPluginEntrances';
import type { InstalledGhost } from '../../../src/shared/ghost';
import { SettingsSearchNavigationContext } from '../../../src/renderer/components/settings/SettingsSearchNavigation';
import { getDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import {
  beginProvidersRefresh,
  commitProvidersSnapshot,
} from '../../../src/renderer/lib/providersSnapshotStore';
import type {
  HookPrefsPatch,
  HookWorkspacePrefs,
  HookWorkspaceProviderSourceEntry,
  ProviderHookView,
  SlackHookView,
} from '../../../src/shared/hookControlIpc';
import { IM_DEFAULT_SETTINGS } from '../../../src/shared/imDefaultSettings';
import { mountPage, subscription } from '../../ui-page/harness';

const codexModels = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', contextWindow: 200000, group: 'gpt', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
  { id: 'gpt-6.1-terra', name: 'GPT-6.1-Terra', contextWindow: 200000, group: 'gpt', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
];
const provider: ProviderView = {
  ...BUNDLED_CATALOG.providers.find((p) => p.id === 'openai')!,
  connected: true,
  agents: ['codex'],
  access: { kind: 'subscription' },
  models: { codex: codexModels },
};

const layoutProviders = [
  {
    id: 'deepseek-demo', name: 'DeepSeek API', source: 'user', connected: true,
    agents: ['pi'], auth: { method: 'apiKey' }, routing: { pi: {} }, logoKind: 'deepseek',
    models: { pi: [
      { id: 'DeepSeek V4.1 Flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'DeepSeek V4.1 Pro', name: 'DeepSeek V4.1 Pro' },
    ].map(model => ({ ...model, contextWindow: 1000000, efforts: ['low', 'medium', 'high'], defaultEffort: 'high' })) },
  },
  { ...provider, name: 'OpenAI', models: { codex: [
    ...codexModels,
    { ...codexModels[0], id: 'gpt-6.2-astra', name: 'GPT-6.2 Astra Extended Context', supportsFastMode: true },
  ] } },
  {
    id: 'xd', name: 'Cindy AI · 个人', source: 'builtin', connected: true,
    agents: ['pi'], auth: { method: 'apiKey' }, routing: { pi: {} }, logoKind: 'cindy',
    models: { pi: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'minimax-m3.1-flash', name: 'MiniMax M3.1 Flash' },
      { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
    ].map(model => ({ ...model, contextWindow: 1000000, efforts: ['low', 'medium', 'high'], defaultEffort: 'high', cost: { input: 1.2, output: 4.8 } })) },
  },
] as ProviderView[];

const disabledLane: ProviderHookView = {
  enabled: false,
  url: '',
  status: 'disabled',
  lastError: null,
  available: false,
  capabilityPending: false,
  defaultWorkspace: null,
  binding: null,
};

function lane(provider: 'telegram' | 'x' | 'feishu', defaultWorkspace: string | null): ProviderHookView {
  return {
    ...disabledLane,
    enabled: true,
    url: 'ws://127.0.0.1:8794',
    status: 'connected',
    available: true,
    defaultWorkspace,
    binding: {
      provider,
      state: 'confirmed',
      attemptId: null,
      bindingId: `${provider}-binding`,
      principalId: 'user-1',
      principalName: provider === 'x' ? '@orbit_garden' : '示例用户',
      scopeId: 'bot-1',
      scopeName: 'Cindy',
      connectUrl: null,
      bindCode: null,
      expiresAt: null,
      reason: null,
      remediationUrl: null,
      actions: ['revoke'],
    },
  };
}

const PROJECTS: Record<string, string> = {
  'orbit-garden': '/Users/demo/Code/orbit-garden',
  '官网与文档': '/Users/demo/Code/site-docs',
  'design-system': '/Users/demo/Code/design-system',
  '数据看板': '/Users/demo/Work/data-board',
};

const MANY_PROJECTS: Record<string, string> = Object.fromEntries([
  ...Object.entries(PROJECTS),
  ['这是一个名字特别特别长的项目用来看截断效果是否正常', '/Users/demo/Code/a/very/deeply/nested/folder/structure/that/keeps/going/and/going/long-project'],
  ['Marketing landing pages 2026 Q4', '/Users/demo/Work/marketing/landing-pages-2026-q4'],
  ['infra/terraform', '/Users/demo/Code/infra/terraform'],
  ['mobile-app', '/Users/demo/Code/mobile-app'],
  ['playtest-reports', '/Users/demo/Documents/playtest-reports'],
  ['客服知识库', '/Users/demo/Work/support-kb'],
]);

const PREFS: HookWorkspacePrefs[] = [
  { workspace: 'orbit-garden', agentKind: 'codex', model: 'gpt-6.1-terra', effort: 'medium', permissionMode: 'ask' },
  { workspace: '官网与文档', agentKind: 'codex', model: 'gpt-6.1-sol', effort: 'high', permissionMode: 'auto' },
  { workspace: '数据看板', agentKind: null, model: null, effort: null, permissionMode: 'ask' },
];

interface Scenario {
  slack?: boolean;
  telegram?: boolean;
  feishu?: boolean;
  x?: boolean;
  projects?: Record<string, string>;
  defaultProject?: string | null;
  prefs?: HookWorkspacePrefs[];
  loadFails?: boolean;
  expand?: 'slack' | 'telegram' | 'feishu' | 'x';
  /** An enabled IM entrance plugin (manifest imEntrance) is installed. */
  plugin?: boolean;
}

// Only the fields the IM bots page reads; the plugin itself is not loaded.
const IM_PLUGIN = {
  enabled: true,
  dir: '/fixture/brain/cindy-wechat-groups',
  manifest: { schemaVersion: 3, id: 'cindy-wechat-groups', name: '微信群里的 Cindy', version: '0.2.14', entry: 'main.js',
    imEntrance: true, agent: { tasks: true, targets: true } },
} as unknown as InstalledGhost;

const SCENARIOS: Record<string, Scenario> = {
  'all-bots': { slack: true, telegram: true, feishu: true, x: true, projects: PROJECTS, defaultProject: 'orbit-garden', prefs: PREFS },
  'default-chat': { telegram: true, feishu: true, projects: PROJECTS, defaultProject: null, prefs: PREFS },
  'slack-only': { slack: true, projects: PROJECTS, prefs: PREFS },
  'no-projects': { telegram: true, projects: {}, defaultProject: null },
  'none-enabled': { projects: PROJECTS },
  'many-projects': { slack: true, telegram: true, feishu: true, projects: MANY_PROJECTS, defaultProject: '官网与文档', prefs: PREFS },
  'load-failed': { telegram: true, feishu: true, projects: PROJECTS, defaultProject: 'orbit-garden', loadFails: true },
  'card-expanded': { telegram: true, feishu: true, projects: PROJECTS, defaultProject: 'orbit-garden', prefs: PREFS, expand: 'telegram' },
  'plugin-only': { projects: PROJECTS, prefs: PREFS, plugin: true },
};

function hookView(scenario: Scenario, defaultProject: string | null): SlackHookView {
  return {
    enabled: scenario.slack === true,
    lifecycleAnnouncement: false,
    url: 'wss://im.example.test',
    workspaces: scenario.projects ?? {},
    status: scenario.slack ? 'connected' : 'disabled',
    lastError: null,
    binding: scenario.slack
      ? {
          state: 'confirmed',
          slackUserId: 'U1',
          slackUserName: 'demo',
          message: null,
          authorizeUrl: null,
          reason: null,
          installUrl: null,
          teamName: 'Orbit Studio',
        }
      : null,
    bindings: [],
    pendingBind: null,
    serverMultiTeam: false,
    telegram: scenario.telegram ? lane('telegram', defaultProject) : { ...disabledLane, url: 'ws://127.0.0.1:8794' },
    x: scenario.x ? lane('x', defaultProject) : { ...disabledLane, url: 'ws://127.0.0.1:8794' },
    feishu: scenario.feishu ? lane('feishu', defaultProject) : { ...disabledLane, url: 'ws://127.0.0.1:8794' },
  } as SlackHookView;
}

void mountPage({
  host: (ctx) => {
    const layout = ctx.case.startsWith('model-layout');
    const scenario = layout ? SCENARIOS['no-projects']! : SCENARIOS[String(ctx.data.kind)] ?? SCENARIOS['all-bots']!;
    const providers = layout ? layoutProviders : [provider];
    const owner = getDataOwnerGeneration();
    commitProvidersSnapshot(beginProvidersRefresh(), {
      dataOwnerId: owner.dataOwnerId,
      ownerGeneration: owner.generation,
      providers,
      providerOrder: providers.map(provider => provider.id),
    });
    let defaultProject = scenario.defaultProject ?? null;
    let prefs: HookWorkspacePrefs[] = structuredClone(scenario.prefs ?? []);
    let sources: HookWorkspaceProviderSourceEntry[] = [];
    const imDefaults = {
      ...IM_DEFAULT_SETTINGS,
      agentKind: layout ? 'pi' : 'codex',
      agents: {
        ...IM_DEFAULT_SETTINGS.agents,
        codex: { providerId: 'openai', model: 'gpt-6.1-sol', effort: 'high' },
        ...(layout ? { pi: { providerId: 'deepseek-demo', model: 'DeepSeek V4.1 Flash', effort: 'high' } } : {}),
      },
      defaults: IM_DEFAULT_SETTINGS,
      isCustomized: false,
      customizedKeys: [],
    };
    return {
      ghosts: {
        listSync: () => ({ ghosts: scenario.plugin ? [IM_PLUGIN] : [] }),
        onChanged: subscription('ghosts'),
      },
      hookControl: {
        get: async () => ({ hook: hookView(scenario, defaultProject) }),
        onStatusChanged: subscription('hook-status'),
        setProviderDefaultWorkspace: async (_provider: string, alias: string | null) => {
          defaultProject = alias;
          return { hook: hookView(scenario, defaultProject) };
        },
        getSharedProjectPrefs: async () => {
          if (scenario.loadFails) throw new Error('fixture: prefs unavailable');
          return { prefs: { prefs } };
        },
        setSharedProjectPrefs: async (workspace: string, patch: HookPrefsPatch) => {
          const current = prefs.find((row) => row.workspace === workspace) ?? {
            workspace, agentKind: null, model: null, effort: null, permissionMode: null,
          };
          prefs = [...prefs.filter((row) => row.workspace !== workspace), { ...current, ...patch }];
          return { prefs: { prefs } };
        },
        onSharedProjectPrefsChanged: subscription('hook-shared-prefs'),
        getWorkspaceProviderSources: async () => ({ entries: sources }),
        setWorkspaceProviderSource: async (entry: HookWorkspaceProviderSourceEntry & { providerId: string | null }) => {
          sources = sources.filter((row) => row.workspace !== entry.workspace);
          if (entry.providerId !== null) sources = [...sources, entry as HookWorkspaceProviderSourceEntry];
          return { entries: sources };
        },
        onWorkspaceProviderSourcesChanged: subscription('hook-sources'),
      },
      deviceLink: {
        listDevices: async () => ({ devices: [] }),
        onPresenceChanged: subscription('presence'),
        onStatusChanged: subscription('device-status'),
        onControlTargetChanged: subscription('controlTarget'),
      },
      maker: {
        ...(layout ? { usage: {
          getReferenceModelPricing: async () => Object.fromEntries(layoutProviders.filter(provider => provider.id !== 'xd').map(provider => [provider.id,
            Object.fromEntries(Object.values(provider.models).flat().map(model => [model.id, { providerId: provider.id, modelId: model.id, currency: 'USD', source: provider.id === 'openai' ? 'subscription-reference' : 'provider-reference', approximate: true, inputPerMtok: 3, outputPerMtok: 12 }]))])),
          getModelPricing: async () => ({ xd: Object.fromEntries(Object.values(layoutProviders[2]!.models).flat().map(model => [model.id, { providerId: 'xd', modelId: model.id, currency: 'USD', source: 'gateway', approximate: false, inputPerMtok: 3, outputPerMtok: 12 }])) }),
          onModelPricingChanged: subscription('gateway-pricing'),
          onReferenceModelPricingChanged: subscription('reference-pricing'),
        } } : {}),
        imDefaultSettingsGet: async () => imDefaults,
        listAvailableAgents: async () => ['claude-code', 'codex', 'pi'],
        getCapabilities: async () => ({
          hasFastMode: false,
          availableModels: (layout ? layoutProviders.flatMap(provider => Object.values(provider.models).flat()) : codexModels).map((m) => ({ ...m, displayName: m.name })),
          effortLevels: layout ? ['low', 'medium', 'high'].map(id => ({ id, displayName: id })) : [],
          permissionModes: ['ask', 'auto', 'bypassPermissions'].map((id) => ({ id, displayName: id })),
          turnPermissionPolicy: { supported: { supported: true }, unsupportedPermissionModes: [] },
        }),
        onProvidersChanged: subscription('providers'),
      },
    };
  },
  render: (ctx) => {
    const layout = ctx.case.startsWith('model-layout');
    const scenario = SCENARIOS[String(ctx.data.kind)] ?? SCENARIOS['all-bots']!;
    const section = scenario.plugin ? (
      <div className="flex flex-col gap-6">
        <ImPluginEntrancesCard plugins={[IM_PLUGIN]} />
        <HookConnectionsSection />
      </div>
    ) : <HookConnectionsSection />;
    return (
      <div className={layout ? 'mx-auto min-h-screen max-w-[720px] bg-[var(--surface)] px-6 py-5 pb-[800px] text-[var(--text-primary)]' : 'min-h-screen bg-[var(--surface)] p-4 text-[var(--text-primary)]'}>
        {scenario.expand ? (
          <SettingsSearchNavigationContext.Provider
            value={{
              entry: {
                id: `imBot.cindy.${scenario.expand}`,
                tab: 'im-bot',
                targetId: `cindy-im-${scenario.expand}`,
                titleKey: 'settings.tina.prefs.providerTelegram',
                sectionKey: 'settings.imBot.groups.cindy',
              },
              activation: 1,
            }}
          >
            {section}
          </SettingsSearchNavigationContext.Provider>
        ) : (
          section
        )}
      </div>
    );
  },
  // The plugin card opens the plugin page through the router.
  route: '/settings',
});
