import { mountPage, subscription } from '../../ui-page/harness';
import { MessageActionBar } from '../../../src/renderer/components/chat/MessageActionBar';
import type { UsageCostRow } from '@cindy/maker-shared/usage-cost-details';

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
  render: () => (
    <main className="h-screen bg-content-area p-5 text-foreground">
      <div className="mx-auto max-w-xl pt-16">
        <p className="mb-4 text-14">Mission Bay · 24 秒横屏样片</p>
        <MessageActionBar
          align="left"
          hovered
          copyText="Mission Bay"
          sessionId="fixture-cost-session"
          clientId="fixture-reply"
          turnMoney={money(4.87, true)}
          turnCostIsEstimate
          turnUsageDetails={{
            inputTokens: 1200,
            outputTokens: 500,
            cacheReadTokens: 4000,
            cacheCreateTokens: 0,
            totalTokens: 5700,
            cacheHitRate: 4000 / 5200,
            model: 'gpt-6.1',
            additionalCosts: [money(3.34)],
          }}
        />
      </div>
    </main>
  ),
});
