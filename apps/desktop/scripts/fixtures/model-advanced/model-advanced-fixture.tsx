import { mountPage, subscription } from '../../ui-page/harness';
import { ModelAdvancedDrawer } from '../../../src/renderer/components/settings/ModelAdvancedDrawer';
import { buildUnionRows } from '../../../src/renderer/components/settings/UnifiedModelList';
import { BUNDLED_CATALOG, resolveModelMetadata, type CatalogModel, type ProviderView } from '@cindy/model-providers';
import type { ModelPriceOverrideDesiredQuote, ModelPriceOverrideTarget, ModelPriceOverrideView } from '../../../src/shared/modelPriceOverride';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';


const referenceQuote = { providerId: 'openai', modelId: 'gpt-6.1-sol', currency: 'USD' as const,
  source: 'provider-reference' as const, approximate: false,
  inputPerMtok: 2, outputPerMtok: 10, cacheReadPerMtok: 0.1, cacheCreatePerMtok: 2.5 };
let pricingControls = false;
const settlePriceMutation = subscription('settlePriceMutation');
const waitForPriceSettlement = () => pricingControls ? new Promise<void>(resolve => {
  const off = settlePriceMutation(() => { off(); resolve(); });
}) : Promise.resolve();
const priceOverrides = new Map<string, ModelPriceOverrideDesiredQuote>();
const priceKey = (target: ModelPriceOverrideTarget) => `${target.agent}:${target.modelId}`;
const priceView = (target: ModelPriceOverrideTarget): ModelPriceOverrideView => {
  const override = priceOverrides.get(priceKey(target)) ?? null;
  const reference = { ...referenceQuote, modelId: target.modelId };
  return { target, editable: true, reference, override,
    effective: override ? { ...reference, ...override,
      cacheReadPerMtok: override.cacheReadPerMtok ?? undefined,
      cacheCreatePerMtok: override.cacheCreatePerMtok ?? undefined } : reference,
    conflict: false, registryUpdatedAt: '2026-10-31', allowedCurrencies: pricingControls ? ['USD', 'CNY'] : ['USD'] };
};

let imageInput: boolean | null = null;
let finishOldImageSave: (() => void) | null = null;
const authChanges = subscription('authChanged');
let compactionPct: number | null = null;
const contextView = () => ({ limit: 272000, isCustomized: false,
  compaction: { pct: compactionPct ?? 90, isCustomized: compactionPct !== null },
  codexContext: { contextWindow: 272000, usableContextWindow: 258400,
    autoCompactTokenLimit: Math.floor(272000 * (compactionPct ?? 90) / 100),
    modelMaxContextWindow: 1050000, source: 'config', fallbackModel: false },
});

void mountPage({
  host: ctx => {
    pricingControls = ctx.case.startsWith('pricing-controls');
    if (ctx.case === 'owner-repair') setDataOwnerGeneration('fixture-owner', 1);
    return {
      onAuthStateChange: (listener: (state: unknown) => void) => authChanges(state => {
        // Reproduce AuthContext publishing its accepted fence before hook recovery.
        setDataOwnerGeneration('fixture-owner', 2);
        listener(state);
        queueMicrotask(() => finishOldImageSave?.());
      }),
      maker: {
    getModelPriceOverride: async (target: ModelPriceOverrideTarget) => priceView(target),
    setModelPriceOverride: async (target: ModelPriceOverrideTarget, quote: ModelPriceOverrideDesiredQuote) => {
      await waitForPriceSettlement();
      priceOverrides.set(priceKey(target), quote);
      return priceView(target);
    },
    resetModelPriceOverride: async (target: ModelPriceOverrideTarget) => {
      await waitForPriceSettlement();
      priceOverrides.delete(priceKey(target));
      return priceView(target);
    },
    getModelImageInputOverride: async () => ({
      value: imageInput ?? (ctx.case === 'image-inherited' ? true : null),
      mixed: ctx.case === 'image-inherited' && imageInput === null,
    }),
    setModelImageInputOverride: async (_target: unknown, value: boolean | null) => {
      imageInput = value;
      if (ctx.case === 'owner-repair' && value === false) {
        return new Promise<{ value: boolean; mixed: boolean }>(resolve => {
          finishOldImageSave = () => resolve({ value: true, mixed: false });
        });
      }
      return { value, mixed: false };
    },
    getModelContextLimit: async () => contextView(),
    setModelCompaction: async (_target: unknown, pct: number | null) => {
      compactionPct = pct;
      return contextView();
    },
    onProvidersChanged: subscription('providersChanged'),
    } };
  },
  render: ctx => {
    const id = (ctx.case === 'sol' || ctx.case.startsWith('pricing')) ? 'gpt-6.1-sol' : ctx.case === 'legacy-sol' ? 'gpt-6-sol' : 'gpt-6-astra';
    const models = Object.fromEntries((['codex', 'claude-code', 'pi'] as const).map(agent => {
      const meta = resolveModelMetadata(BUNDLED_CATALOG.modelRegistry, 'openai', id, undefined, undefined, agent);
      const model: CatalogModel = {
        id: ctx.case === 'image-unknown' ? 'private-undeclared-model' : agent === 'claude-code' ? `chatgpt/${id}` : id,
        name:meta.name ?? id, group:'gpt', nativeApi:'openai-responses',
        contextWindow:meta.contextWindow ?? 272000, contextWindowMax:1050000, maxOutput:128000,
        efforts:meta.efforts ?? [], defaultEffort:meta.defaultEffort ?? 'medium',
        supportsImageInput:ctx.case === 'image-unknown' ? undefined
          : ctx.case === 'image-unsupported' || (ctx.case === 'image-mixed' && agent === 'claude-code') ? false : true,
        ...(ctx.case === 'image-inherited' ? { imageInputDefault: { supportsImageInput: agent !== 'codex' } } : {}),
        supportsFastMode:true,
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
