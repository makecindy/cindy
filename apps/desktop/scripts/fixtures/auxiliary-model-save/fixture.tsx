import { mountPage } from '../../ui-page/harness';
import { AuxiliaryModelSection } from '../../../src/renderer/components/settings/AuxiliaryModelSection';
import { AUTO_AUXILIARY_MODEL_CHAIN } from '../../../src/shared/auxiliaryModelChain';

const options = AUTO_AUXILIARY_MODEL_CHAIN.map((id, index) => ({
  id, agentKind: 'codex', providerId: 'xd', modelId: id.split(':').slice(3).join(':'),
  modelName: ['GPT-6 Luna', 'Hy3', 'Qwen 3.8 Flash'][index], group: 'Preview', available: true,
  budget: false, subscription: false, label: ['GPT-6 Luna', 'Hy3', 'Qwen 3.8 Flash'][index],
}));
mountPage({
  host: ctx => ({
    maker: {
      auxiliaryModelSettingsGet: async () => ({ models: ctx.case === 'modified' ? [...AUTO_AUXILIARY_MODEL_CHAIN] : [], options }),
      auxiliaryModelRouteHealthGet: async () => [],
      auxiliaryModelHealthGet: async () => ({ status: 'ok' }),
      auxiliaryModelSettingsSet: async () => ctx.case === 'testing' ? new Promise(() => {}) : ({
        ok: false, model: options[ctx.case === 'modified' ? 1 : 0].id, reason: 'http_error', httpStatus: 422,
        upstreamMessage: ctx.case === 'modified' ? 'Long provider detail. '.repeat(15) : 'The requested parameters are not supported by this model.',
      }),
    },
  }),
  render: () => <main className="mx-auto w-full max-w-4xl p-3"><AuxiliaryModelSection /></main>,
});
