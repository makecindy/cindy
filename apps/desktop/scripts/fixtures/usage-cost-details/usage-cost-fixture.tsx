import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES } from '@/cindy-brain/PluginUiContributions';
import { mountPage, subscription } from '../../ui-page/harness';
import { MessageActionBar } from '../../../src/renderer/components/chat/MessageActionBar';
import type { UsageCostRow } from '@cindy/maker-shared/usage-cost-details';
import type { GenerationTrace } from '@cindy/maker-shared/usage-format';

/** A turn of `requests` model requests: mostly quick answers, a deep think now and then. */
function fixtureTrace(requests: number, shape: 'full' | 'unreported' | 'strokes-only' | 'empty'): GenerationTrace {
  const durationMs = requests * 9_000;
  // A turn too short for a second speed reading has no curve to draw.
  const curve = shape === 'full' || shape === 'unreported';
  // A provider that reports no reasoning split leaves every mark at -1.
  const reported = shape === 'full' || shape === 'strokes-only';
  const speed: GenerationTrace['speed'] = !curve ? [] : Array.from({ length: 40 }, (_, i) => [
    Math.round(((i + 1) / 40) * durationMs),
    Math.round(46 + 22 * Math.sin(i / 3.1) + 12 * Math.sin(i / 1.3)),
  ]);
  // Past 48 requests the host keeps merged marks; the fixture mirrors that shape.
  const merged = Math.max(1, Math.ceil(requests / 48));
  const marks: GenerationTrace['marks'] = [];
  let reportedOutputTokens = 0;
  for (let first = 0; first < requests; first += merged) {
    const count = Math.min(merged, requests - first);
    const deep = [0, 1, 17, 18, 31].includes(marks.length) || (requests <= 3 && marks.length === 1);
    const thinking = deep ? 2_600 + 1_900 * (marks.length % 3) : marks.length % 7 === 3 ? 516 : 0;
    // Each request also writes a few hundred tokens of answer or tool call.
    if (reported) reportedOutputTokens += (thinking + 380 + 90 * (marks.length % 5)) * count;
    marks.push([Math.round(((first + count) / requests) * durationMs), reported ? thinking * count : -1, count]);
  }
  return { durationMs, requests, speed, marks, reportedOutputTokens };
}

const money = (amount: number, estimate = false) => ({
  amount,
  currency: 'USD' as const,
  approximate: estimate,
  kind: estimate ? ('value-estimate' as const) : ('actual-cost' as const),
});
const rows: UsageCostRow[] = [
  {
    category: 'conversation',
    model: 'gpt-6.1',
    providerName: 'ChatGPT',
    billingSource: 'subscription',
    money: money(1.11, true),
  },
  {
    category: 'conversation',
    model: 'gpt-6.1',
    providerName: 'Cindy AI',
    billingSource: 'cindy-ai',
    money: money(0.42),
  },
  {
    category: 'additional',
    model: 'seedance-2.0',
    providerName: 'Cindy AI',
    billingSource: 'cindy-ai',
    money: money(3.2),
  },
  {
    category: 'additional',
    model: 'gpt-image-2',
    providerName: 'Cindy AI',
    billingSource: 'cindy-ai',
    money: money(0.14),
  },
];
mountPage({
  host: (ctx) => ({
    onUsageMessageTurnCost: subscription('turnCost'),
    localDb: {
      messages: {
        estimatedSessionValue: async () => ({
          entries: [],
          totalValueUsd: 1.11,
          ...(ctx.data.legacy ? {} : { costBreakdown: rows }),
        }),
      },
    },
  }),
  render: (ctx) => (
    <main className="h-screen bg-content-area p-5 text-foreground">
      <div className="mx-auto max-w-xl pt-16">
        <p className="mb-4 text-14">Mission Bay · 24 秒横屏样片</p>
        <MessageActionBar pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES}
          align="left"
          hovered
          copyText="Mission Bay"
          sessionId="fixture-cost-session"
          clientId="fixture-reply"
          // No price for the model: the cell falls back to the turn's token count.
          {...(ctx.data.noPrice ? {} : { turnMoney: money(4.87, true), turnCostIsEstimate: true })}
          turnUsageDetails={{
            inputTokens: 1200,
            outputTokens: 500,
            cacheReadTokens: 4000,
            cacheCreateTokens: 0,
            totalTokens: 5700,
            cacheHitRate: 4000 / 5200,
            model: 'gpt-6.1',
            ...(ctx.data.noPrice ? {} : { additionalCosts: [money(3.34)] }),
            ...(typeof ctx.data.traceRequests === 'number'
              ? { trace: fixtureTrace(ctx.data.traceRequests, ctx.data.traceShape ?? 'full') } : {}),
          }}
        />
      </div>
    </main>
  ),
});
