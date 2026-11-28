import { mountPage, subscription, forbid } from '../../ui-page/harness';
import { PluginEngineUsageChip } from '../../../src/renderer/components/status/PluginEngineUsageChip';
import { ContextCapacityRing } from '../../../src/renderer/components/status/ContextCapacityRing';

mountPage({
  route: '/cc-agent/fixture-session',
  host: (ctx) => ({
    deviceLink: {
      invoke: async (device: string, channel: string, [key, task]: [string, { sessionId?: string }?]) => {
        if (device !== 'quota-host' || channel !== 'maker:get-plugin-engine-usage' || key !== 'example:acp') return null;
        return { updatedAt: Date.now(), windows: [{
          label: 'Gemini', remainingPercent: task?.sessionId === 'fixture-session' ? 98 : 66,
        }] };
      },
    },
    maker: {
      getPluginEngineUsage: async () => {
        const updatedAt = Date.now();
        if (ctx.data.usage === 'balance') return { updatedAt, balances: [{ currency: 'CNY', amount: '0.00' }] };
        if (ctx.data.usage === 'quotas') return { updatedAt, windows: [
          { label: 'Gemini · 5h', remainingPercent: 82, resetsAt: updatedAt + 3_600_000 },
          { label: 'Claude/GPT · weekly', remainingPercent: 0, resetsAt: updatedAt + 6 * 86_400_000 },
          { label: 'Archive · weekly', remainingPercent: 91, resetsAt: updatedAt - 60_000 },
        ] };
        return null;
      },
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
        {Boolean(ctx.data.usage) && <PluginEngineUsageChip engineKey="example:acp"
          name={ctx.data.usage === 'balance' ? 'DeepSeek Harness' : 'Antigravity'}
          deviceId={ctx.data.usage === 'remote' ? 'quota-host' : null} sessionId="fixture-session" running={false} />}
        <ContextCapacityRing
          reportedOnly={Boolean(ctx.data.usage)}
          sessionId="fixture-session"
          providerId="xd"
          model={ctx.data.unknown ? 'unknown' : 'fixture-model'}
          vendorKey={ctx.data.codex ? 'codex' : 'cc'}
          contextTokens={ctx.data.high ? 250_240 : 32_640}
          sdkContextWindow={ctx.data.usage === 'missing' ? 0 : 272_000}
          disabled={ctx.data.readOnly === true}
          onCompact={!ctx.data.usage && !ctx.data.codex && !ctx.data.readOnly ? forbid('compact') : undefined}
        />
      </div>
    </div>
  ),
});
