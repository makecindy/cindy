import { mountPage, subscription } from '../../ui-page/harness';
import { TodaySpendChip } from '../../../src/renderer/components/status/TodaySpendChip';

// 窗口还剩几天零几小时时, 胶囊与悬浮窗必须同串(4天 1小时, 不是 5天)。
const resetOffset = (days?: number) => (days ? days * 86_400 + 3_600 + 12 * 60 : 2 * 86_400);

void mountPage({
  host: (ctx) => ({
    maker: { usage: {
      getClaudeSubscription: async () => ({
        source: 'oauth-endpoint', updatedAt: Date.now(),
        ...(ctx.data.planDisplayName ? { subscriptionType: 'pro', planTier: 'pro', planDisplayName: ctx.data.planDisplayName } : {}),
        fiveHour: { utilization: 25, resetsAt: Date.now() / 1000 + 5 * 3600, severity: 'normal' },
        sevenDay: { utilization: ctx.data.totalUsed, resetsAt: Date.now() / 1000 + resetOffset(ctx.data.resetInDays) },
        scoped: [{ modelDisplayName: 'Fable', utilization: 10, resetsAt: Date.now() / 1000 + resetOffset(ctx.data.resetInDays), severity: 'normal' }],
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
