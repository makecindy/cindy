import { mountPage, subscription, ctx } from '../../ui-page/harness';
import { ModelSelector } from '../../../src/renderer/components/new-chat/ModelSelector';
import type { ProviderView } from '@cindy/model-providers';

const provider = (id: string, name: string, model = 'gpt-6-astra'): ProviderView => ({
  id, name, source: 'builtin', agents: ['codex'], auth: { method: 'oauth' },
  connected: true, routing: { codex: {} }, subscriptionAccountKeys: ['fixture-account'],
  models: { codex: [{ id: model, name: model === 'viewer-only' ? 'VIEWER ONLY MODEL' : 'GPT-6-Astra',
    contextWindow: 200000, efforts: ['high'], defaultEffort: 'high', defaultEnabled: true }] },
} as ProviderView);
const target = [provider('openai', 'OpenAI · alex@example.com'), provider('openai-old', 'OpenAI · alex@example.com')];
// Another own computer offering the same source the task computer already lists.
const otherComputer = ctx.case.startsWith('remote-other-');
if (ctx.case === 'remote-single' || otherComputer) target.pop();
const rogOffer = { ...provider('openai', 'OpenAI · alex@example.com'), remoteInvocationEnabled: true } as ProviderView;
if (ctx.case === 'remote-other-distinct') rogOffer.subscriptionAccountKeys = ['another-fixture-account'];
if (ctx.case === 'remote-distinct') target[1].subscriptionAccountKeys = ['another-fixture-account'];
if (ctx.case === 'remote-extra-model') target[1].models.codex!.push({ ...target[1].models.codex![0], id: 'extra-model', name: 'Extra model' });
const local = ctx.case === 'local' ? target : [provider('viewer', 'MBP ONLY', 'viewer-only')];
// ChatInput omits remoteAgent when the host offers no alternative run locations.
const deviceOnly = ctx.case === 'remote-device-only';
const snapshot = (providers: ProviderView[]) => ({ providers, providerOrder: providers.map(p => p.id), loading: false,
  error: null, unsupported: false, refetch: async () => {}, ownerGeneration: 1 });
Object.assign(window, { selectorRepro: { local: snapshot(local), target: snapshot(target), empty: snapshot([]),
  others: otherComputer ? { rog: { providers: [rogOffer], loading: false, error: null } } : {} } });
void mountPage({
  host: { maker: {
    getModelContextLimit: async () => ({ limit: 200000, isCustomized: false }),
    onProvidersChanged: subscription('providersChanged'),
    getCapabilities: async () => ({ hasFastMode: false, availableModels: [], effortLevels: [{ id: 'high', displayName: 'High' }], permissionModes: [] }),
  } },
  render: () => <main className="flex h-screen items-end justify-end p-8">
    <div data-repro-trigger><ModelSelector modelId="gpt-6-astra" currentProviderId={ctx.case === 'remote-current' ? 'openai-old' : 'openai'} agentKind="codex"
      effort="high" onModelChange={() => {}} onEffortChange={() => {}} actualRoute useMorphPopover
      sessionEngineFilter={{ currentAgent: 'codex', onCrossEngineSelect: () => {} }}
      deviceId={deviceOnly ? 'studio' : undefined}
      remoteAgent={deviceOnly ? undefined : { devices: otherComputer ? [{ deviceId: 'rog', name: 'ROG' }] : [], selectedDeviceId: null, ...(ctx.case !== 'local' ? { homeDeviceId: 'studio', homeDeviceName: 'Mac Studio', catalogHostDeviceId: 'studio' } : {}) }}
      />
    </div>
  </main>,
});
