import { mountPage, subscription } from '../../ui-page/harness';
import { ModelAdvancedDrawer } from '../../../src/renderer/components/settings/ModelAdvancedDrawer';
import { buildUnionRows } from '../../../src/renderer/components/settings/UnifiedModelList';
import { BUNDLED_CATALOG, type AgentKind, type CatalogModel, type ModelInterfaceSnapshot, type PiModelApi, type ProviderView } from '@cindy/model-providers';

type Api = 'anthropic-messages' | 'openai-responses' | 'openai-completions' | 'google-generative-ai';
const WIRE = { 'anthropic-messages': 'anthropic-messages', 'openai-responses': 'openai-responses', 'openai-completions': 'openai-chat', 'google-generative-ai': 'google-generative-ai' } as const;
const AGENTS = ['claude-code', 'codex', 'pi'] as const;

function snapshot(providerId: string, modelId: string, api: Api, baseUrl: string, preferred: boolean): ModelInterfaceSnapshot {
  return { profileId: `${providerId}-${api}`, providerId, revision: '2026-10-30T00:00:00.000Z', api, wireModelId: modelId,
    route: { baseUrl, wireProtocol: WIRE[api] }, defaults: {}, compatibility: [], preferred };
}

interface Scenario {
  provider: Omit<ProviderView, 'models'>;
  model: Omit<CatalogModel, 'id'> & { id: string };
  /** Omitted for built-in subscriptions: the production resolver derives their real upstream. */
  selected?: Record<AgentKind, PiModelApi>;
  interfaces?: { api: Api; baseUrl: string; defaultFor: AgentKind[] }[];
  enabled: Record<AgentKind, boolean>;
  recommended: AgentKind;
  ids?: Partial<Record<AgentKind, string>>;
}

const deepseekInterfaces = [
  { api: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic', defaultFor: ['claude-code'] },
  { api: 'openai-responses', baseUrl: 'https://api.deepseek.com', defaultFor: ['codex'] },
  { api: 'openai-completions', baseUrl: 'https://api.deepseek.com', defaultFor: ['pi'] },
] as const;
const v4Pro = { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', group: 'deepseek', contextWindow: 1048576, contextWindowMax: 1048576, maxOutput: 384000,
  efforts: ['high', 'max'], defaultEffort: 'high', supportsImageInput: false } as const;
const xd = BUNDLED_CATALOG.providers.find(p => p.id === 'xd')!;
const gatewayInterfaces = [
  { api: 'anthropic-messages', baseUrl: 'https://gateway.invalid', defaultFor: ['claude-code'] },
  { api: 'openai-responses', baseUrl: 'https://gateway.invalid/v1', defaultFor: ['codex'] },
  { api: 'openai-completions', baseUrl: 'https://gateway.invalid/v1', defaultFor: ['pi'] },
] as { api: Api; baseUrl: string; defaultFor: AgentKind[] }[];
const gateway = { ...xd, name: 'Cindy AI', connected: true, agents: [...AGENTS] } as Omit<ProviderView, 'models'>;

const scenarios: Record<string, Scenario> = {
  deepseek: {
    provider: { id: 'cprov-deepseek', name: 'DeepSeek', source: 'user', agents: [...AGENTS], auth: { method: 'apiKey' },
      access: { kind: 'api' }, connected: true,
      routing: { 'claude-code': { upstream: 'https://api.deepseek.com/anthropic', wireProtocol: 'anthropic-messages', authStrategy: 'api-key' },
        codex: { upstream: 'https://api.deepseek.com', wireProtocol: 'openai-responses', authStrategy: 'api-key' },
        pi: { upstream: 'https://api.deepseek.com', wireProtocol: 'openai-chat', authStrategy: 'api-key' } } } as Omit<ProviderView, 'models'>,
    model: { ...v4Pro, efforts: [...v4Pro.efforts], catalogPresetId: 'deepseek', nativeApis: ['anthropic-messages', 'openai-responses', 'openai-completions'] },
    selected: { 'claude-code': 'anthropic-messages', codex: 'openai-responses', pi: 'openai-completions' },
    interfaces: deepseekInterfaces.map(item => ({ ...item, defaultFor: [...item.defaultFor] })),
    enabled: { 'claude-code': true, codex: true, pi: true },
    recommended: 'pi',
  },
  'cindy-deepseek': {
    provider: gateway,
    model: { ...v4Pro, efforts: [...v4Pro.efforts], id: 'deepseek/deepseek-v4-pro', nativeApis: ['anthropic-messages', 'openai-responses', 'openai-completions'] },
    interfaces: gatewayInterfaces,
    selected: { 'claude-code': 'anthropic-messages', codex: 'openai-responses', pi: 'openai-completions' },
    enabled: { 'claude-code': true, codex: true, pi: true },
    recommended: 'pi',
  },
  'cindy-gemini': {
    provider: gateway,
    model: { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', group: 'gemini', contextWindow: 1048576, contextWindowMax: 1048576,
      maxOutput: 65536, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', supportsImageInput: true,
      nativeApis: ['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai'] },
    interfaces: [...gatewayInterfaces.map(item => ({ ...item, defaultFor: item.defaultFor.filter(agent => agent !== 'pi') })),
      { api: 'google-generative-ai', baseUrl: 'https://gateway.invalid/v1beta', defaultFor: ['pi'] }],
    selected: { 'claude-code': 'anthropic-messages', codex: 'openai-responses', pi: 'google-generative-ai' },
    enabled: { 'claude-code': true, codex: true, pi: true },
    recommended: 'pi',
  },
  chatgpt: {
    provider: { ...BUNDLED_CATALOG.providers.find(p => p.id === 'openai')!, connected: true, agents: ['codex', 'claude-code', 'pi'] },
    model: { id: 'gpt-6-astra', name: 'GPT-6 Astra', group: 'gpt', nativeApi: 'openai-responses', contextWindow: 272000, contextWindowMax: 1050000,
      maxOutput: 128000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', supportsImageInput: true, supportsFastMode: true },
    enabled: { 'claude-code': false, codex: true, pi: true },
    recommended: 'codex',
    ids: { 'claude-code': 'chatgpt/gpt-6-astra', pi: 'chatgpt/gpt-6-astra' },
  },
};

void mountPage({
  host: () => ({ maker: {
    getModelImageInputOverride: async () => ({ value: null, mixed: false }),
    setModelImageInputOverride: async (_target: unknown, value: boolean | null) => ({ value, mixed: false }),
    getModelContextLimit: async () => ({ limit: null, isCustomized: false, compaction: { pct: 90, isCustomized: false } }),
    setModelCompaction: async () => ({ limit: null, isCustomized: false, compaction: { pct: 90, isCustomized: false } }),
    onProvidersChanged: subscription('providersChanged'),
  } }),
  render: ctx => {
    const scenario = scenarios[ctx.case === 'default' ? 'deepseek' : ctx.case === 'narrow' ? 'chatgpt' : ctx.case]!;
    const models = Object.fromEntries(scenario.provider.agents.map(agent => {
      const api = scenario.selected?.[agent];
      const available = scenario.interfaces?.map(item => snapshot(scenario.provider.id, scenario.model.id, item.api, item.baseUrl, item.defaultFor.includes(agent)));
      const selected = available?.find(item => item.api === api);
      const model: CatalogModel = {
        ...scenario.model,
        id: scenario.ids?.[agent] ?? scenario.model.id,
        ...(api ? { api, ...(agent === 'pi' ? { piApi: api } : {}) } : {}),
        ...(selected ? { selectedInterface: selected, availableInterfaces: available, route: selected.route }
          : api ? { route: { baseUrl: 'https://gateway.invalid', wireProtocol: WIRE[api as Api] } } : {}),
        defaultEnabled: scenario.enabled[agent],
        ...(agent === scenario.recommended ? { recommendedAgent: agent } : {}),
      } as CatalogModel;
      return [agent, [model]];
    }));
    const provider = { ...scenario.provider, models } as ProviderView;
    return <ModelAdvancedDrawer provider={provider} row={buildUnionRows(provider)[0]}
      open onOpenChange={() => {}} pricePresentationOf={() => null} onDisable={() => {}}
      disabled={false} paymentRequired={false} />;
  },
});
