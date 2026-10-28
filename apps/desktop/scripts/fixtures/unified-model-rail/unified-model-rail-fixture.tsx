import { mountPage, subscription } from '../../ui-page/harness';
import { ModelSelectorContent } from '../../../src/renderer/components/new-chat/ModelSelector';
import { recordRecentModel } from '../../../src/renderer/state/recentModels';
import { addModelFavorite } from '../../../src/renderer/state/modelFavorites';
import type { ProviderView, UnifiedModelEntry } from '@cindy/model-providers';

// 与 unifiedModelPanelRendering.test.tsx 同一套供应商夹具:归一化行 gpt-5.6 在 codex 上
// 是 root 条目、在 cc 上是 `chatgpt/` bridge 壳;Opus 5 在 anthropic 上只有 cc。
const providers = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    source: 'builtin',
    agents: ['claude-code'],
    auth: { method: 'oauth' },
    routing: { 'claude-code': {} },
    connected: true,
    models: {
      'claude-code': [
        {
          id: 'claude-opus-5',
          name: 'Opus 5',
          group: 'anthropic',
          sortOrder: 1,
          contextWindow: 200000,
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
        },
      ],
    },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    source: 'builtin',
    agents: ['claude-code', 'codex'],
    auth: { method: 'oauth' },
    routing: { 'claude-code': {}, codex: {} },
    connected: true,
    models: {
      codex: [
        {
          id: 'gpt-5.6',
          name: 'GPT-5.6',
          group: 'gpt',
          sortOrder: 3,
          contextWindow: 400000,
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
          // 承载「最近」里 fast:'ultrafast' 的条目:Fast 与 Ultrafast 都要显式声明,
          // 否则解析(unifiedModelSelection)会把速度折成 false,后缀消失。
          supportsFastMode: true,
          supportsUltrafastMode: true,
        },
      ],
      'claude-code': [
        {
          id: 'chatgpt/gpt-5.6',
          name: 'GPT-5.6',
          group: 'gpt',
          sortOrder: 3,
          contextWindow: 400000,
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
          // 承载「最近」里 fast:true 的条目。
          supportsFastMode: true,
        },
      ],
    },
  },
] as unknown as ProviderView[];

// 「最近」与 ★ 在组件挂载前落库:这些正是 PR 语义所在的三态 Fast 载体
// (`true` / `'ultrafast'` 必须原样保留,不能都折成 true)。
recordRecentModel({ providerId: 'openai', modelId: 'gpt-5.6', agent: 'codex', effort: 'high', fast: 'ultrafast' }, Date.now() - 60_000);
recordRecentModel({ providerId: 'openai', modelId: 'gpt-5.6', agent: 'cc', effort: 'medium', fast: true }, Date.now() - 30_000);
recordRecentModel({ providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'cc', effort: 'high' }, Date.now() - 10_000);
addModelFavorite({ providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'cc', effort: 'high' });

function Fixture() {
  return (
    <main className="mx-auto w-full max-w-[720px] p-4">
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-3">
        <ModelSelectorContent
          providersOverride={providers}
          providersOverrideState={{ status: 'ready', refresh: () => {} }}
          modelId="claude-opus-5"
          effort="medium"
          currentProviderId="anthropic"
          onModelChange={() => {}}
          onEffortChange={() => {}}
          onFastModeChange={() => {}}
          recordRecentUsage
        />
      </div>
    </main>
  );
}

void mountPage({
  host: { maker: {
    getModelContextLimit: async () => ({ limit: 272000, isCustomized: false }),
    onProvidersChanged: subscription('providersChanged'),
    // agent 级 Fast 能力:useAgentCapabilities → electronAPI.maker.getCapabilities;
    // 缺了它 unifiedAgentFastCapable 恒 false,行速度同样会被折掉。
    getCapabilities: async () => ({
      hasFastMode: true,
      availableModels: [],
      effortLevels: [
        { id: 'low', displayName: 'Low' },
        { id: 'medium', displayName: 'Medium' },
        { id: 'high', displayName: 'High' },
      ],
      permissionModes: [{ id: 'default', displayName: 'Default' }],
    }),
  } },
  render: () => <Fixture />,
});
