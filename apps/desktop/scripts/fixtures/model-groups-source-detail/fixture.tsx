import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { SourceRouteDetail, useSourceOptions } from '../../../src/renderer/components/settings/ModelGroupsAutoRoutes';
import { ConfirmDialogProvider } from '../../../src/renderer/components/ui/confirm-dialog-provider';
import type { ProviderView } from '@cindy/model-providers';
import type { ModelGroupResolveResult, ModelGroupsConfig, ModelGroupSourceRoute } from '../../../src/shared/modelGroups';
import type { SubscriptionPoolView } from '../../../src/shared/subscriptionAccounts';

const provider = (id: string, name: string, models: [string, string][], extra: Record<string, unknown> = {}) => ({
  id, name, source: 'builtin', agents: ['codex'], auth: { method: 'oauth' }, connected: true, routing: { codex: {} },
  models: { codex: models.map(([modelId, modelName], sortOrder) => ({ id: modelId, name: modelName, group: 'gpt', sortOrder, contextWindow: 400000 })) },
  ...extra,
}) as unknown as ProviderView;

const GPT: [string, string][] = [
  ['gpt-6.2-sol', 'GPT-6.2-Sol'],
  ['gpt-6.2-astra', 'GPT-6.2-Astra'],
  ['gpt-6.1-terra', 'GPT-6.1 Terra'],
];

const localProviders = [
  provider('openai', 'OpenAI', GPT, { subscriptionAccountPool: 'openai', subscriptionAccountKeys: ['acct-a', 'acct-b'] }),
  provider('byok-1', 'OpenAI-Codex', GPT, { source: 'organization', logoKind: 'openai-spectrum', auth: { method: 'api-key' } }),
];

const shareProviders = [
  provider('openai', 'OpenAI', GPT, { remoteInvocationEnabled: true }),
];

const catalog = (providers: ProviderView[]) => ({
  providers,
  providerOrder: providers.map((item) => item.id),
  loading: false,
  error: null,
  unsupported: false,
  refetch: async () => {},
  ownerGeneration: 1,
});

Object.assign(window, {
  sourceDetailFixture: {
    local: catalog(localProviders),
    remote: new Map([['share:alex', catalog(shareProviders)]]),
    selectable: { devices: [] },
    shareName: {
      devices: [{ deviceId: 'share:alex', name: 'OpenAI · Alex' }],
      pluginEngineDevices: [],
      loaded: true,
      nameFor: (id: string) => (id === 'share:alex' ? 'Alex' : null),
      isKnown: (id: string) => id === 'share:alex',
      isReceived: (id: string) => id === 'share:alex',
    },
    modelRouteDevices: {
      devices: [{ deviceId: 'share:alex', name: 'OpenAI · Alex' }],
      leadAgentDeviceId: null,
    },
    pluginEngines: [],
    devicesPluginEngines: { catalogues: new Map(), read: async () => {} },
    localGroups: {},
  },
});

function buildInitialConfig(weighted: boolean): ModelGroupsConfig {
  const strategy = weighted ? 'weighted' : 'expiring';
  const route: ModelGroupSourceRoute = {
    id: 'auto:openai',
    name: 'OpenAI',
    strategy,
    auto: true,
    sources: [
      { providerId: 'openai', accountId: 'default', ...(weighted ? { weight: 3 } : {}) },
      { providerId: 'openai', accountId: 'second', ...(weighted ? { off: true } : {}) },
      { providerId: 'byok-1', ...(weighted ? { weight: 2 } : {}) },
      { providerId: 'openai', agentDeviceId: 'share:alex' },
    ],
  };
  return {
    sourceRoutes: [route],
    routes: GPT.map(([model, name]) => ({
      id: `src:${model}`,
      name,
      strategy,
      parent: { id: 'auto:openai', name: 'OpenAI' },
      candidates: route.sources.map((source) => ({
        agentKind: 'codex' as const,
        providerId: source.providerId,
        ...(source.accountId ? { accountId: source.accountId } : {}),
        ...(source.agentDeviceId ? { agentDeviceId: source.agentDeviceId } : {}),
        ...(source.off ? { off: true } : {}),
        ...(source.weight ? { weight: source.weight } : {}),
        model,
      })),
    })),
  };
}

function SourceDetailDemo({ weighted }: { weighted: boolean }) {
  const [config, setConfig] = useState<ModelGroupsConfig>(() => buildInitialConfig(weighted));
  const options = useSourceOptions();
  const route = config.sourceRoutes?.[0] ?? buildInitialConfig(weighted).sourceRoutes![0];
  return (
    <ConfirmDialogProvider>
      <main className="mx-auto w-full max-w-[780px] p-6">
        <SourceRouteDetail
          route={route}
          config={config}
          options={options}
          save={async (change) => {
            setConfig((current) => change(current));
            return true;
          }}
          onBack={() => undefined}
        />
      </main>
    </ConfirmDialogProvider>
  );
}

void mountPage({
  host: (ctx) => {
    const weighted = ctx.data.mode === 'weighted';
    const now = Date.parse('2026-11-28T10:00:00Z');
    const pool: SubscriptionPoolView = {
      provider: 'openai',
      providerId: 'openai',
      strategy: 'expiring',
      accounts: [
        { id: 'default', identity: 'account-a@example.com', status: 'ready', running: 0, weight: 1, limit: 4, paused: false },
        { id: 'second', identity: 'account-b@example.com', status: 'ready', running: 0, weight: 1, limit: 4, paused: false },
      ],
    };
    const resolveResult = (): ModelGroupResolveResult => ({
      outcome: 'routed',
      groupName: 'OpenAI',
      route: { agentKind: 'codex', providerId: 'openai', accountId: 'default', model: 'gpt-6.2-sol' },
      modelName: 'GPT-6.2-Sol',
      sourceName: 'OpenAI · account-a@example.com',
      why: weighted ? 'weighted' : 'expiring',
      quota: { usedPercent: 18, resetAtMs: now + 2 * 3_600_000, windowMs: 5 * 3_600_000 },
      trace: [
        {
          agentKind: 'codex', providerId: 'openai', accountId: 'default', model: 'gpt-6.2-sol',
          modelName: 'GPT-6.2-Sol', sourceName: 'OpenAI · account-a@example.com',
          state: 'picked', why: weighted ? 'weighted' : 'expiring',
          quota: { usedPercent: 18, resetAtMs: now + 2 * 3_600_000, windowMs: 5 * 3_600_000 },
        },
        {
          agentKind: 'codex', providerId: 'openai', accountId: 'second', model: 'gpt-6.2-sol',
          modelName: 'GPT-6.2-Sol', sourceName: 'OpenAI · account-b@example.com',
          state: weighted ? 'skipped' : 'standby', why: weighted ? 'off' : 'standby',
          quota: { usedPercent: 52, resetAtMs: now + 4 * 3_600_000, windowMs: 5 * 3_600_000 },
        },
        {
          agentKind: 'codex', providerId: 'byok-1', model: 'gpt-6.2-sol',
          modelName: 'GPT-6.2-Sol', sourceName: 'OpenAI-Codex',
          state: 'standby', why: 'standby', quota: null,
        },
        {
          agentKind: 'codex', providerId: 'openai', agentDeviceId: 'share:alex', model: 'gpt-6.2-sol',
          modelName: 'GPT-6.2-Sol', sourceName: 'OpenAI',
          state: 'standby', why: 'standby',
          quota: { usedPercent: 10, resetAtMs: now + 4 * 3_600_000, windowMs: 5 * 3_600_000 },
        },
      ],
    });
    return {
      subscriptionAccounts: {
        command: async () => pool,
        onChanged: () => () => undefined,
      },
      modelGroups: {
        resolve: async () => resolveResult(),
      },
    };
  },
  render: (ctx) => <SourceDetailDemo weighted={ctx.data.mode === 'weighted'} />,
});
