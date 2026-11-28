import { mountPage, subscription } from '../../ui-page/harness';
import { ModelGroupsOverview } from '../../../src/renderer/components/settings/ModelGroupsOverview';
import { ModelGroupsSection } from '../../../src/renderer/components/settings/ModelGroupsSection';
import { ConfirmDialogProvider } from '../../../src/renderer/components/ui/confirm-dialog-provider';
import type { ProviderView } from '@cindy/model-providers';
import type { ModelGroupDecision } from '../../../src/shared/modelGroupDecisions';
import type { ModelGroupCandidate, ModelGroupsConfig, ModelGroupSelection } from '../../../src/shared/modelGroups';

const provider = (id: string, name: string, agent: 'codex' | 'claude-code', models: [string, string][], extra: Record<string, unknown> = {}) => ({
  id, name, source: 'builtin', agents: [agent], auth: { method: 'api-key' }, connected: true, routing: { [agent]: {} },
  models: { [agent]: models.map(([modelId, modelName], sortOrder) => ({ id: modelId, name: modelName, group: 'g', sortOrder, contextWindow: 400000, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' })) },
  ...extra,
}) as unknown as ProviderView;

const GPT: [string, string][] = [['gpt-6-astra', 'GPT-6-Astra'], ['gpt-6-sol', 'GPT-6-Sol'], ['gpt-6-luna', 'GPT-6-Luna']];
const CLAUDE: [string, string][] = [['claude-opus', 'Opus 5.5'], ['claude-sonnet', 'Sonnet 5.5']];
const SHARES = ['share:11111111-1111-4111-8111-111111111111', 'share:22222222-2222-4222-8222-222222222222'];
const local = [
  provider('openai', 'OpenAI', 'codex', GPT),
  provider('byok-1', 'OpenAI-Codex', 'codex', GPT, { source: 'organization', logoKind: 'openai-spectrum' }),
];
const shared = () => provider('anthropic', 'Anthropic', 'claude-code', CLAUDE, { remoteInvocationEnabled: true });

const gpt = (providerId: string, model: string): ModelGroupCandidate => ({ agentKind: 'codex', providerId, model });
const claude = (agentDeviceId: string, model: string): ModelGroupCandidate => ({ agentKind: 'cc', providerId: 'anthropic', model, agentDeviceId });
// What the main process hands to the settings page: one route the user arranged by model, two that combine whole
// providers, and what those two expand into for every model.
const config: ModelGroupsConfig = {
  sourceRoutes: [
    { id: 'auto:openai', name: 'OpenAI', strategy: 'expiring', auto: true, sources: [{ providerId: 'openai' }, { providerId: 'byok-1' }] },
    { id: 'auto:anthropic', name: 'Anthropic', strategy: 'expiring', auto: true, sources: SHARES.map((agentDeviceId) => ({ providerId: 'anthropic', agentDeviceId })) },
  ],
  routes: [
    { id: 'mine', name: 'Daily driver', strategy: 'expiring', candidates: [gpt('openai', 'gpt-6-astra'), claude(SHARES[0], 'claude-opus')] },
    ...GPT.map(([model, name]) => ({ id: `src:${model}`, name, strategy: 'expiring' as const, parent: { id: 'auto:openai', name: 'OpenAI' },
      candidates: [gpt('openai', model), gpt('byok-1', model)] })),
    ...CLAUDE.map(([model, name]) => ({ id: `src:${model}`, name, strategy: 'expiring' as const, parent: { id: 'auto:anthropic', name: 'Anthropic' },
      candidates: SHARES.map((agentDeviceId) => claude(agentDeviceId, model)) })),
  ],
};

// Remaining quota per member: the second share is nearly used up.
const USED: Record<string, number> = { openai: 9, 'byok-1': 40, [SHARES[0]]: 53, [SHARES[1]]: 98 };
const reset = Date.now() + 3 * 86_400_000;
const quotaOf = (candidate: ModelGroupCandidate) => ({ usedPercent: USED[candidate.agentDeviceId ?? candidate.providerId], resetAtMs: reset, windowMs: 7 * 86_400_000 });
const at = (minutesAgo: number) => Date.now() - minutesAgo * 60_000;
const decision = (minutesAgo: number, groupId: string, groupName: string, picked: ModelGroupCandidate, modelName: string, sourceName: string, why: ModelGroupDecision['why']): ModelGroupDecision => ({
  at: at(minutesAgo), groupType: 'route', groupId, groupName, outcome: 'routed', ...picked, modelName, sourceName, effort: 'high', why, quota: quotaOf(picked),
});
const decisions: ModelGroupDecision[] = [
  // The latest task went through the combined Anthropic route and landed on the first share.
  decision(12, 'src:claude-sonnet', 'Anthropic', claude(SHARES[0], 'claude-sonnet'), 'Sonnet 5.5', 'Anthropic', 'expiring'),
  decision(95, 'mine', 'Daily driver', gpt('openai', 'gpt-6-astra'), 'GPT-6-Astra', 'OpenAI', 'expiring'),
  decision(60 * 26, 'src:gpt-6-sol', 'OpenAI', gpt('byok-1', 'gpt-6-sol'), 'GPT-6-Sol', 'OpenAI-Codex', 'only'),
  { at: at(60 * 50), groupType: 'route', groupId: 'mine', groupName: 'Daily driver', outcome: 'unavailable' },
];

const calls: { resolved: string[]; opened: string[] } = { resolved: [], opened: [] };
const selectable = { devices: [] };
const shareNames: Record<string, string> = { [SHARES[0]]: 'Shared by Ada', [SHARES[1]]: 'Shared by Lin' };
const catalog = (providers: ProviderView[]) => ({ providers, providerOrder: providers.map((item) => item.id), loading: false, error: null,
  unsupported: false, refetch: async () => {}, ownerGeneration: 1 });
const overviewFixture = {
  calls, selectable, capabilityReads: [] as string[], editDevices: [] as { deviceId: string; name: string }[], shareName: { nameFor: (id: string) => shareNames[id] ?? null },
  local: catalog(local), remote: Object.fromEntries(SHARES.map((id) => [id, catalog([shared()])])), empty: catalog([]),
  old: { ...catalog([]), unsupported: true, error: new Error('provider:list is not supported') },
};
Object.assign(window, { overviewFixture });

const dualRuntime = {
  ...local[0]!,
  agents: ['codex', 'pi'],
  routing: { ...local[0]!.routing, pi: {} },
  models: { ...local[0]!.models, pi: local[0]!.models.codex },
} as ProviderView;
let saved: ModelGroupsConfig = { routes: [config.routes[0]!] };

void mountPage({
  host: (ctx) => ({
    maker: {
      getModelContextLimit: async () => ({ limit: 400000, isCustomized: false }),
      onProvidersChanged: subscription('providersChanged'),
      requestProviderModelsAutoRefresh: async () => undefined,
    },
    modelGroups: {
    get: async () => saved,
    set: async (next: ModelGroupsConfig) => { saved = next; return next; },
    decisions: async () => (ctx.data.empty === true ? [] : decisions),
    resolve: async ({ selection, cachedQuota }: { selection: ModelGroupSelection; cachedQuota?: boolean }) => {
      // The map asks twice: readings on hand first, then the usual read. Only the first round is counted.
      if (cachedQuota) calls.resolved.push(selection.id);
      const route = (ctx.data.harness ? saved : config).routes.find((item) => item.id === selection.id)!;
      return { outcome: 'routed', trace: route.candidates.map((candidate) => ({ ...candidate, modelName: candidate.model, sourceName: candidate.providerId,
        state: 'standby', why: 'expiring', quota: quotaOf(candidate) })) };
    },
  } }),
  render: (ctx) => {
    if (ctx.data.harness) {
      overviewFixture.local = catalog([dualRuntime, local[1]!]);
      overviewFixture.editDevices = [{ deviceId: SHARES[0]!, name: 'Shared by Ada' }];
      return <ConfirmDialogProvider><main className="mx-auto w-full max-w-[920px] p-6"><ModelGroupsSection /></main></ConfirmDialogProvider>;
    }
    return (
    <main className="mx-auto w-full max-w-[920px] p-6">
      <ModelGroupsOverview config={config} onOpenRoute={(id) => calls.opened.push(`route:${id}`)} onOpenSourceRoute={(id) => calls.opened.push(`source:${id}`)} />
    </main>
    );
  },
});
