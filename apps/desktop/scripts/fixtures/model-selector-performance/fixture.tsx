import { mountPage, subscription } from '../../ui-page/harness';
import { ModelSelector } from '../../../src/renderer/components/new-chat/ModelSelector';
import type { ProviderView } from '@cindy/model-providers';

function providers(count: number, keyboard = false): ProviderView[] {
  return ['openai', 'anthropic'].map((id, providerIndex) => {
    const agent = providerIndex ? 'claude-code' : 'codex';
    return {
      id, name: providerIndex ? 'Anthropic' : 'OpenAI', source: 'builtin',
      agents: [agent], auth: { method: 'api-key' }, connected: true,
      routing: { [agent]: {} },
      models: { [agent]: Array.from({ length: Math.floor(count / 2) + (providerIndex === 0 ? count % 2 : 0) }, (_, i) => ({
        id: `${id}-model-${i}`, name: keyboard && i === 78 && id === 'openai'
          ? 'GPT Model 78 Coding · 中文目标' : `${id === 'openai' ? 'GPT' : 'Claude'} Model ${i} Coding`,
        group: providerIndex ? 'anthropic' : 'gpt', sortOrder: i,
        contextWindow: 200000, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium',
        supportsFastMode: true,
      })) },
    } as ProviderView;
  });
}

const sources = new Map([20, 79, 200, 600, 2000].map(count => [count, providers(count)]));
const keyboardSources = providers(200, true);
const ready = { status: 'ready' as const, refresh: () => {} };
void mountPage({
  host: { maker: {
    getModelContextLimit: async () => ({ limit: 200000, isCustomized: false }),
    onProvidersChanged: subscription('providersChanged'),
    getCapabilities: async () => ({ hasFastMode: true, availableModels: [],
      effortLevels: ['low', 'medium', 'high'].map(id => ({ id, displayName: id })),
      permissionModes: [{ id: 'default', displayName: 'Default' }],
    }),
  } },
  render: ctx => <main className="flex h-screen items-end justify-end p-8">
    <div data-perf-trigger>
      <ModelSelector modelId={ctx.data.keyboard ? 'openai-model-78' : 'openai-model-0'} currentProviderId="openai" agentKind="codex"
        effort="medium" onModelChange={() => {}} onEffortChange={() => {}}
        useMorphPopover sessionEngineFilter={{ currentAgent: 'codex', onCrossEngineSelect: () => {} }}
        modelGroups={ctx.data.groups === undefined ? undefined : {
          config: { routes: ctx.data.groups ? [{ id: 'mode', name: 'Daily mode', strategy: 'order', candidates: [] }] : [] },
          active: null, onSelect: () => {}, onManage: () => {},
        }}
        providersOverride={ctx.data.keyboard ? keyboardSources : sources.get(Number(ctx.data.count))!} providersOverrideState={ready} />
    </div>
  </main>,
});
