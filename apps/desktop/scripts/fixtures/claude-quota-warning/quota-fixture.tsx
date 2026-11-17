import { mountPage, subscription } from '../../ui-page/harness';
import { TodaySpendChip } from '../../../src/renderer/components/status/TodaySpendChip';

void mountPage({
  host: (ctx) => ({
    maker: { usage: {
      getClaudeSubscription: async () => ({
        source: 'oauth-endpoint', updatedAt: Date.now(),
        fiveHour: { utilization: 25, resetsAt: Date.now() / 1000 + 5 * 3600, severity: 'normal' },
        sevenDay: { utilization: ctx.data.totalUsed, resetsAt: Date.now() / 1000 + 2 * 86400 },
        scoped: [{ modelDisplayName: 'Fable', utilization: 10, resetsAt: Date.now() / 1000 + 2 * 86400, severity: 'normal' }],
        rateLimitStatus: ctx.data.rejected ? 'rejected' : 'allowed',
      }),
      onClaudeSubscriptionChanged: subscription('quota'),
    } },
    openExternal: async () => {},
  }),
  render: () => (
    <main className="flex h-screen min-w-0 items-start justify-end bg-content-area p-4">
      <TodaySpendChip vendorKey="cc" providerId="anthropic" modelId="claude-fable-5-2" sessionId="fixture" />
    </main>
  ),
});
