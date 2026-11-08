import type { UsageCostRow } from '@cindy/maker-shared/usage-cost-details';
import { mountPage } from '../../ui-page/harness';
import { QuotaHoverCard } from '../../../src/renderer/components/status/QuotaHoverCard';
import { UsageCostDetails } from '../../../src/renderer/components/status/UsageCostDetails';

const estimate = (amount: number) => ({
  amount,
  currency: 'USD' as const,
  approximate: true,
  kind: 'value-estimate' as const,
});
const rows: UsageCostRow[] = [
  { category: 'conversation', model: 'gpt-6.1', billingSource: 'unknown', money: estimate(0.86) },
  {
    category: 'conversation',
    model: 'gpt-6.1',
    providerName: 'OpenAI',
    billingSource: 'subscription',
    money: estimate(3.1),
  },
];
const nowMs = Date.now();

mountPage({
  render: () => (
    <main className="flex h-screen items-start justify-center overflow-auto bg-content-area p-4">
      <QuotaHoverCard
        nowMs={nowMs}
        account={{
          title: 'ChatGPT',
          identity: 'fixture@example.com',
          planLabel: 'Pro',
          windows: [
            {
              key: 'secondary',
              title: 'Weekly',
              showRemaining: true,
              window: { utilization: 100, resetsAt: nowMs / 1000 + 21 * 3600 },
              paceWindowMinutes: 10_080,
            },
          ],
          details: ['33,248.00 credits'],
        }}
      >
        <div className="px-4 py-3">
          <UsageCostDetails rows={rows} />
        </div>
      </QuotaHoverCard>
    </main>
  ),
});
