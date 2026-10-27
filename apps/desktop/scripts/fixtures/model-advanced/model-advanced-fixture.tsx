import { mountPage, subscription } from '../../ui-page/harness';
import { ModelAdvancedDrawer } from '../../../src/renderer/components/settings/ModelAdvancedDrawer';
import { buildUnionRows } from '../../../src/renderer/components/settings/UnifiedModelList';
import { BUNDLED_CATALOG, resolveModelMetadata, type CatalogModel, type ProviderView } from '@cindy/model-providers';

let compactionPct: number | null = null;
const contextView = () => ({ limit: 272000, isCustomized: false,
  compaction: { pct: compactionPct ?? 90, isCustomized: compactionPct !== null },
  codexContext: { contextWindow: 272000, usableContextWindow: 258400,
    autoCompactTokenLimit: Math.floor(272000 * (compactionPct ?? 90) / 100),
    modelMaxContextWindow: 1050000, source: 'config', fallbackModel: false },
});

void mountPage({
  host: { maker: {
    getModelContextLimit: async () => contextView(),
    setModelCompaction: async (_target: unknown, pct: number | null) => {
      compactionPct = pct;
      return contextView();
    },
    onProvidersChanged: subscription('providersChanged'),
  } },
  render: ctx => {
    const id = ctx.case === 'sol' ? 'gpt-6.1-sol' : ctx.case === 'legacy-sol' ? 'gpt-6-sol' : 'gpt-6-astra';
    const models = Object.fromEntries((['codex', 'claude-code', 'pi'] as const).map(agent => {
      const meta = resolveModelMetadata(BUNDLED_CATALOG.modelRegistry, 'openai', id, undefined, undefined, agent);
      const model: CatalogModel = {
        id: agent === 'claude-code' ? `chatgpt/${id}` : id,
        name:meta.name ?? id, group:'gpt', nativeApi:'openai-responses',
        contextWindow:meta.contextWindow ?? 272000, contextWindowMax:1050000, maxOutput:128000,
        efforts:meta.efforts ?? [], defaultEffort:meta.defaultEffort ?? 'medium',
        supportsImageInput:true, supportsFastMode:true,
        supportsUltrafastMode:agent === 'codex' && ctx.case !== 'unavailable' && ctx.case !== 'legacy-sol',
      };
      return [agent, [model]];
    }));
    const provider: ProviderView = {
      ...BUNDLED_CATALOG.providers.find(p=>p.id==='openai')!,
      connected:true, agents:['codex','claude-code','pi'], models,
    };
    return <ModelAdvancedDrawer provider={provider} row={buildUnionRows(provider)[0]}
      open onOpenChange={()=>{}} pricePresentationOf={()=>null} onDisable={()=>{}}
      disabled={false} paymentRequired={false}/>;
  },
});
