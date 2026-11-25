import { mountPage, subscription } from '../../ui-page/harness';
import { ModelSelector } from '../../../src/renderer/components/new-chat/ModelSelector';
import type { ProviderView } from '@cindy/model-providers';

function providers(count: number, remote = false): ProviderView[] {
  return ['openai', 'anthropic'].map((id, providerIndex) => {
    const agent = providerIndex ? 'claude-code' : 'codex';
    return {
      id, name: providerIndex ? 'Anthropic' : 'OpenAI', source: 'builtin',
      agents: [agent], auth: { method: 'api-key' }, connected: true,
      ...(remote ? { remoteInvocationEnabled: true } : {}),
      routing: { [agent]: {} },
      models: { [agent]: Array.from({ length: count / 2 }, (_, i) => ({
        id: `${id}-model-${i}`, name: `${id === 'openai' ? 'GPT' : 'Claude'} Model ${i} Coding`,
        group: providerIndex ? 'anthropic' : 'gpt', sortOrder: i,
        contextWindow: 200000, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium',
        supportsFastMode: true,
      })) },
    } as ProviderView;
  });
}

const sources = new Map([20, 200, 600].map(count => [count, providers(count)]));
const ready = { status: 'ready' as const, refresh: () => {} };
// Another computer that allows remote use of its sources and has its own modes (model-groups.md §6.3).
const studio = (long: boolean) => ({
  deviceId: 'desk-2', name: long ? 'Mac Studio in the design team meeting room' : 'Mac Studio',
  config: { routes: [
    { id: 'daily', name: long ? 'Everyday coding with the cheapest working source first' : 'Daily coding', strategy: 'order' as const, candidates: [] },
    { id: 'review', name: 'Review', strategy: 'order' as const, candidates: [] },
  ] },
});
void mountPage({
  host: { deviceLink: {
    invoke: async (_deviceId: string, channel: string) => {
      if (channel === 'maker:provider:list') return { providers: providers(8, true) };
      throw new Error(`Unexpected device-link channel ${channel}`);
    },
  }, maker: {
    getModelContextLimit: async () => ({ limit: 200000, isCustomized: false }),
    onProvidersChanged: subscription('providersChanged'),
    getCapabilities: async () => ({ hasFastMode: true, availableModels: [],
      effortLevels: ['low', 'medium', 'high'].map(id => ({ id, displayName: id })),
      permissionModes: [{ id: 'default', displayName: 'Default' }],
    }),
  } },
  render: ctx => { const device = ctx.data.device === undefined ? null : studio(ctx.data.device === 'long'); return <main className="flex h-screen items-end justify-end p-8">
    <div data-perf-trigger>
      <ModelSelector modelId="openai-model-0" currentProviderId="openai" agentKind="codex"
        effort="medium" onModelChange={() => {}} onEffortChange={() => {}}
        useMorphPopover sessionEngineFilter={{ currentAgent: 'codex', onCrossEngineSelect: () => {} }}
        {...(device ? { remoteAgent: { devices: [{ deviceId: device.deviceId, name: device.name }], selectedDeviceId: null } } : {})}
        modelGroups={ctx.data.groups === undefined ? undefined : {
          config: { routes: ctx.data.groups ? [{ id: 'mode', name: 'Daily mode', strategy: 'order', candidates: [] }] : [] },
          active: device && ctx.data.selected ? { type: 'route', id: 'daily', deviceId: device.deviceId } : null,
          onSelect: () => {}, onManage: () => {},
          ...(device ? { devices: [device], readDevices: () => {} } : {}),
        }}
        providersOverride={sources.get(Number(ctx.data.count))!} providersOverrideState={ready} />
    </div>
  </main>; },
});
