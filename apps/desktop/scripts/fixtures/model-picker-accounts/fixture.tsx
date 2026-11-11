import { beginProvidersRefresh, commitProvidersSnapshot } from '../../../src/renderer/lib/providersSnapshotStore';
import { getDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { ModelSelector } from '../../../src/renderer/components/new-chat/ModelSelector';
import type { ProviderView } from '@cindy/model-providers';
import { mountPage, subscription } from '../../ui-page/harness';
import {
  ModelSourceDetails,
  ModelSourceUsageProvider,
} from '../../../src/renderer/components/new-chat/ModelSourceDetails';
import { ModelPoolQuotaSummary } from '../../../src/renderer/components/new-chat/ModelPoolQuota';
import { UnifiedModelRail } from '../../../src/renderer/components/new-chat/UnifiedModelRail';
import { SessionSubscriptionAccountProvider } from '../../../src/renderer/components/new-chat/SessionSubscriptionAccount';

const providers = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    source: 'builtin',
    connected: true,
    auth: { method: 'oauth', native: 'claude' },
    agents: ['claude-code'],
    routing: { 'claude-code': {} },
    models: { 'claude-code': ['Opus', 'Sonnet', 'Haiku'].map((name, i) => ({
      id: `claude-${name.toLowerCase()}`, name, group: 'anthropic', sortOrder: i,
      contextWindow: 200000, efforts: ['low', 'medium', 'high'], defaultEffort: 'high',
    })) },
    access: { kind: 'subscription', product: 'Claude' },
  },
] as unknown as ProviderView[];

const owner = getDataOwnerGeneration();
const snapshot = {dataOwnerId:owner.dataOwnerId,ownerGeneration:owner.generation,providers,providerOrder:['anthropic']};
commitProvidersSnapshot(beginProvidersRefresh(), snapshot);

void mountPage({
  host: (ctx) => ({
    maker: {
      listProviders: async () => snapshot,
      requestProviderModelsAutoRefresh: async () => undefined,
      listAvailableAgents: async () => ['claude-code'],
      getModelContextLimit: async () => ({ limit: 200000, isCustomized: false }),
      onProvidersChanged: subscription('providersChanged'),
      getCapabilities: async () => ({ hasFastMode: false, availableModels: [],
        effortLevels: ['low','medium','high'].map(id => ({id,displayName:id})),
        permissionModes: [{id:'default',displayName:'Default'}],
      }),
    },
    subscriptionAccounts: {
      onChanged: subscription('subscriptionAccounts'),
      sessionAccount: async () => ({
        providerId: 'anthropic',
        state: 'bound',
        account: {
          isDefault: false, number: 2, identity: 'second@example.test',
          paused: false, status: 'ready', plan: 'pro',
          usage: { claude: { sevenDay: { utilization: 20, resetsAt: Date.now() / 1000 + 2 * 86400 } } },
        },
      }),
      command: async () => ({
        providerId: 'anthropic',
        configured: true,
        strategy: 'round-robin',
        ...(ctx.case === 'bound' ? { boundAccountId: 'default' } : {}),
        ...(ctx.case === 'session-bound' ? { boundAccountId: null } : {}),
        accounts: [
          {
            id: 'default',
            identity: 'first@example.test',
            paused: !['ambiguous', 'session-bound', 'reset-soon', 'reset-urgent', 'unknown', 'full-panel', 'full-panel-warning', 'quota-pool', 'quota-partial'].includes(ctx.case),
            status: 'ready',
            running: 0,
            limit: 4,
            plan: 'max',
            usage: {
              claude: { ...(ctx.case.startsWith('quota-') ? { fiveHour: { utilization: 100, resetsAt: Date.now() / 1000 + 45 * 60 } } : {}), sevenDay: { utilization: ctx.case === 'unknown' ? NaN : 66, resetsAt: Date.now() / 1000 + 3 * 86400 } },
            },
          },
          {
            id: 'second',
            identity: 'second@example.test',
            paused: false,
            status: 'ready',
            running: 0,
            limit: 4,
            plan: 'pro',
            usage: {
              claude: { ...(ctx.case.startsWith('quota-') ? { fiveHour: { utilization: ctx.case === 'quota-low' ? 92 : ctx.case === 'quota-partial' ? 20 : 100, resetsAt: Date.now() / 1000 + 32 * 60 } } : {}), sevenDay: { utilization: 20, resetsAt: Date.now() / 1000 + (ctx.case === 'reset-urgent' || ctx.case === 'full-panel' ? 5 * 3600 : ctx.case === 'reset-soon' || ctx.case === 'unknown' || ctx.case === 'full-panel-warning' ? 12 * 3600 : 2 * 86400) } },
            },
          },
        ],
      }),
    },
  }),
  render: (ctx) => {
    if (ctx.case.startsWith('full-panel')) return (
      <main className="flex h-screen items-end justify-end p-4">
        <div data-full-picker-trigger>
          <ModelSelector modelId="claude-opus" currentProviderId="anthropic" agentKind="claude-code"
            effort="high" onModelChange={() => {}} onEffortChange={() => {}}
            useMorphPopover sessionEngineFilter={{currentAgent:'claude-code',onCrossEngineSelect:()=>{}}}
            onNavigateToProviders={()=>{}}/>
        </div>
      </main>
    );
    const scope = { deviceId: null, ...(['bound', 'session-bound'].includes(ctx.case) ? { taskId: 'existing-task' } : {}) };
    return (
      <div className="p-4">
        <SessionSubscriptionAccountProvider
          providerId={ctx.case === 'session-bound' ? 'anthropic' : null}
          deviceId={null} sessionId="existing-task" nativeSessionId="native-task"
        >
        <ModelSourceUsageProvider providers={providers} scope={scope}>
          <div className="flex rounded-[var(--radius-lg)] border border-[var(--model-dropdown-border)] bg-[var(--model-dropdown-bg)] p-2">
            <UnifiedModelRail
              providers={providers}
              items={[{ kind: 'provider', providerId: 'anthropic' }]}
              active={{ kind: 'provider', providerId: 'anthropic' }}
              providerLabel={() => 'Anthropic'}
              onSelect={() => {}}
              providerUsage={scope}
            />
            <div className="min-w-0 flex-1 p-3">
              <div className="mb-3 flex flex-wrap items-center gap-2 text-12 text-[var(--text-secondary)]">
                <span>Anthropic</span><ModelPoolQuotaSummary providerId="anthropic"/>
              </div>
              <div className="text-14 text-[var(--text-primary)]">Claude Sonnet</div>
              <ModelSourceDetails
                providerId="anthropic"
                label="Anthropic"
                modelId="claude-sonnet"
                accountIdentity="first@example.test"
              />
            </div>
          </div>
        </ModelSourceUsageProvider>
        </SessionSubscriptionAccountProvider>
      </div>
    );
  },
});
