import { mountPage, subscription, forbid } from '../../ui-page/harness';
import { ContextCapacityRing } from '../../../src/renderer/components/status/ContextCapacityRing';

mountPage({
  route: '/cc-agent/fixture-session',
  host: (ctx) => ({
    maker: {
      getSessionContextWindowBounds: async () =>
        ctx.data.unknown
          ? null
          : {
              providerId: 'xd',
              defaultWindow: 272_000,
              maxWindow: 1_050_000,
              modelLimit: null,
              budget: null,
              budgetCustomized: false,
              defaultEffectiveWindow: 272_000,
              maxEffectiveWindow: 1_050_000,
            },
      getModelContextLimit: async () => ({
        limit: null,
        isCustomized: false,
        codexContext: {
          contextWindow: 272_000,
          usableContextWindow: 258_400,
          autoCompactTokenLimit: 244_800,
          pendingApply: false,
        },
      }),
      onProvidersChanged: subscription('providersChanged'),
      usage: {
        getModelPricing: async () => ({
          xd: {
            'fixture-model': {
              providerId: 'xd',
              modelId: 'fixture-model',
              currency: 'USD',
              source: 'gateway',
              approximate: false,
              inputPerMtok: 10,
              outputPerMtok: 30,
              inputTokenPriceBands: [
                { minInputTokens: 0, maxInputTokens: 512_000, inputPerMtok: 10 },
                { minInputTokens: 512_000, inputPerMtok: 20 },
              ],
            },
          },
        }),
        getReferenceModelPricing: async () => null,
        onModelPricingChanged: subscription('pricingChanged'),
        onReferenceModelPricingChanged: subscription('referencePricingChanged'),
      },
    },
  }),
  render: (ctx) => (
    <div className="flex h-screen items-end justify-end bg-content-area p-6">
      <div className="flex items-center gap-3" data-testid="context-footer">
        <ContextCapacityRing
          sessionId="fixture-session"
          showWindowBudget={!ctx.data.companion}
          contextUsageKnown={ctx.data.snapshotKnown !== false}
          deviceId={ctx.data.remote ? 'fixture-host' : undefined}
          providerId="xd"
          model={ctx.data.unknown ? 'unknown' : 'fixture-model'}
          vendorKey={ctx.data.codex ? 'codex' : 'cc'}
          contextTokens={ctx.data.snapshotKnown === false ? 0 : ctx.data.high ? 250_240 : 32_640}
          sdkContextWindow={ctx.data.snapshotKnown === false ? 0 : 272_000}
          disabled={ctx.data.readOnly === true}
          onCompact={!ctx.data.codex && !ctx.data.readOnly && ctx.data.snapshotKnown !== false ? forbid('compact') : undefined}
        />
      </div>
    </div>
  ),
});
