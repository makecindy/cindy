import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { ModelSelector } from '../../../src/renderer/components/new-chat/ModelSelector';
import type { ProviderView } from '@cindy/model-providers';
import type { ModelGroupsConfig, ModelGroupSelection } from '../../../src/shared/modelGroups';

const EFFORTS = ['low', 'medium', 'high'];
const provider = (id: string, name: string, modelIds: string[], extra: Record<string, unknown> = {}) => ({
  id, name, source: 'builtin', agents: ['codex'], auth: { method: 'api-key' }, connected: true, routing: { codex: {} },
  models: { codex: modelIds.map((modelId, sortOrder) => ({
    id: modelId, name: modelId.split('/').pop()!.toUpperCase(), group: 'gpt', sortOrder, contextWindow: 400000,
    efforts: EFFORTS, defaultEffort: 'medium', supportsFastMode: true,
  })) },
  ...extra,
}) as unknown as ProviderView;

// A subscription, an organization connection of the same brand, and an unrelated gateway.
const local = [
  provider('xd', 'Cindy AI', ['gpt-5.5'], { logoKind: 'xd' }),
  provider('openai', 'OpenAI', ['gpt-6-luna', 'gpt-5.5']),
  provider('byok-1', 'OpenAI-Codex', ['byok-codex/gpt-6-luna'], { source: 'organization', logoKind: 'openai-spectrum' }),
];
// What the main process hands to pickers: the provider route and the route it expands into per model.
const config = (hidden: boolean): ModelGroupsConfig => ({
  sourceRoutes: [{ id: 'auto:openai', name: 'OpenAI', strategy: 'expiring', auto: true, ...(hidden ? { hidden: true as const } : {}),
    sources: [{ providerId: 'openai' }, { providerId: 'byok-1' }] }],
  routes: hidden ? [] : [
    { id: 'src:luna', name: 'GPT-6-LUNA', strategy: 'expiring', parent: { id: 'auto:openai', name: 'OpenAI' }, candidates: [
      { agentKind: 'codex', providerId: 'openai', model: 'gpt-6-luna' },
      { agentKind: 'codex', providerId: 'byok-1', model: 'byok-codex/gpt-6-luna' },
    ] },
    { id: 'src:55', name: 'GPT-5.5', strategy: 'expiring', parent: { id: 'auto:openai', name: 'OpenAI' }, candidates: [
      { agentKind: 'codex', providerId: 'openai', model: 'gpt-5.5' },
    ] },
  ],
});

// Two people share a provider of one brand: every member of the merged entry lives somewhere else.
const SHARES = ['share:11111111-1111-4111-8111-111111111111', 'share:22222222-2222-4222-8222-222222222222'];
const shared = () => ({ ...provider('anthropic', 'Anthropic', ['claude-opus', 'claude-sonnet']), agents: ['claude-code'],
  routing: { 'claude-code': {} }, models: { 'claude-code': provider('anthropic', 'Anthropic', ['claude-opus', 'claude-sonnet']).models!.codex },
  remoteInvocationEnabled: true }) as unknown as ProviderView;
const sharedConfig: ModelGroupsConfig = {
  sourceRoutes: [{ id: 'auto:anthropic', name: 'Anthropic', strategy: 'expiring', auto: true,
    sources: SHARES.map((agentDeviceId) => ({ providerId: 'anthropic', agentDeviceId })) }],
  routes: [['src:opus', 'claude-opus'], ['src:sonnet', 'claude-sonnet']].map(([id, model]) => ({
    id, name: model.toUpperCase(), strategy: 'expiring' as const, parent: { id: 'auto:anthropic', name: 'Anthropic' },
    candidates: SHARES.map((agentDeviceId) => ({ agentKind: 'cc' as const, providerId: 'anthropic', model, agentDeviceId })),
  })),
};

const calls: { unified: unknown[]; attached: ModelGroupSelection[]; cleared: number; attachedInSameClick: boolean[] } =
  { unified: [], attached: [], cleared: 0, attachedInSameClick: [] };
let choosing = false;
const catalog = (providers: ProviderView[]) => ({ providers, providerOrder: providers.map(item => item.id), loading: false, error: null,
  unsupported: false, refetch: async () => {}, ownerGeneration: 1 });
Object.assign(window, { sourceRoutesFixture: {
  calls,
  remote: Object.fromEntries(SHARES.map((id) => [id, catalog([shared()])])),
  local: { providers: local, providerOrder: local.map(item => item.id), loading: false, error: null, unsupported: false,
    refetch: async () => {}, ownerGeneration: 1 },
  empty: { providers: [], providerOrder: [], loading: false, error: null, unsupported: false, refetch: async () => {}, ownerGeneration: 1 },
} });

// Stands in for the new-task draft: it keeps the chosen model, effort and Fast, and separately which route decides the member.
function Draft({ hidden, sharedMembers }: { hidden: boolean; sharedMembers: boolean }) {
  const [draft, setDraft] = useState({ providerId: 'xd', modelId: 'gpt-5.5', effort: 'medium', route: null as ModelGroupSelection | null,
    agentDeviceId: null as string | null });
  return (
    <div data-source-routes-trigger>
      <ModelSelector modelId={draft.modelId} currentProviderId={draft.providerId} agentKind={draft.agentDeviceId ? 'claude-code' : 'codex'}
        effort={draft.effort as never} onModelChange={() => {}} onEffortChange={() => {}} useMorphPopover
        // As the composer does: the engines registered where the draft's Agent runs. A share only offers Claude Code.
        {...(draft.agentDeviceId ? { unifiedAgents: ['claude-code' as const] } : {})}
        remoteAgent={sharedMembers ? { devices: SHARES.map((deviceId, index) => ({ deviceId, name: `Anthropic · ${index + 1}` })),
          selectedDeviceId: draft.agentDeviceId } : undefined}
        onUnifiedSelect={(selection) => {
          calls.unified.push({ providerId: selection.providerId, modelId: selection.modelId, effort: selection.effort ?? null,
            ...(selection.agentDevice ? { agentDeviceId: selection.agentDevice.deviceId } : {}) });
          // The draft drops a route whenever an ordinary model is chosen, as the real draft does.
          calls.cleared += draft.route ? 1 : 0;
          choosing = true;
          queueMicrotask(() => { choosing = false; });
          setDraft({ providerId: selection.providerId ?? '', modelId: selection.modelId, effort: selection.effort ?? draft.effort, route: null,
            agentDeviceId: selection.agentDevice?.deviceId ?? null });
        }}
        modelGroups={{
          config: sharedMembers ? sharedConfig : config(hidden), active: draft.route,
          onSelect: (route) => setDraft((current) => ({ ...current, route })),
          onAttach: (route) => {
            calls.attached.push(route);
            calls.attachedInSameClick.push(choosing);
            setDraft((current) => ({ ...current, route }));
          },
        }} />
    </div>
  );
}

void mountPage({
  host: { maker: {
    getModelContextLimit: async () => ({ limit: 400000, isCustomized: false }),
    onProvidersChanged: subscription('providersChanged'),
    getCapabilities: async () => ({ hasFastMode: true, availableModels: [],
      effortLevels: EFFORTS.map(id => ({ id, displayName: id })), permissionModes: [{ id: 'default', displayName: 'Default' }] }),
  } },
  render: ctx => <main className="flex h-screen items-end justify-end p-6"><Draft hidden={ctx.data.hidden === true} sharedMembers={ctx.data.shared === true} /></main>,
});
