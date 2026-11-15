import { mountPage, subscription } from '../../ui-page/harness';
import { TodaySpendChip } from '../../../src/renderer/components/status/TodaySpendChip';

void mountPage({
  host: (ctx) => ({
    maker: { usage: {
      getAccount: async () => ({
        spend: 3, maxBudget: 30, currency: 'USD', fetchedAt: Date.now(),
        todaySpend: ctx.data.todaySpend,
        ...(ctx.data.dailyLimitEnabled === undefined ? {} : { dailyLimitEnabled: ctx.data.dailyLimitEnabled }),
      }),
      onClaudeAccountChanged: subscription('quota'),
    } },
  }),
  render: () => (
    <main className="flex h-full items-end justify-end p-8">
      <TodaySpendChip vendorKey="cc" providerId="xd" />
    </main>
  ),
});
