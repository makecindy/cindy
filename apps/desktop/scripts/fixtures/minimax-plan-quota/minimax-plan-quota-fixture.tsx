import type { ProviderView } from '@cindy/model-providers';
import { mountPage, subscription } from '../../ui-page/harness';
import { ProviderAccountUsageModule } from '../../../src/renderer/components/settings/ProviderAccountUsageModule';
import { TodaySpendChip } from '../../../src/renderer/components/status/TodaySpendChip';
import { parseMiniMaxPlanUsage } from '../../../src/shared/minimaxPlanUsage';

const provider = {
  id: 'minimax-fixture', name: 'MiniMax', source: 'user', connected: true,
  auth: { method: 'apiKey' }, access: { kind: 'api' },
  routing: {
    'claude-code': { upstream: 'https://api.kimi.com/coding' },
    codex: { upstream: 'https://api.minimaxi.com/v1' },
  },
} as ProviderView;

void mountPage({
  host: ctx => ({
    maker: {
      onProvidersChanged: subscription('providers'),
      fetchProviderAccountUsage: async () => ctx.data.error
        ? { status: 'unavailable', error: 'auth' }
        : { status: 'ready', stale: ctx.data.stale === true, snapshot: parseMiniMaxPlanUsage({
          base_resp: { status_code: 0 },
          model_remains: [{ model_name: 'general',
            current_interval_total_count: 0, current_interval_usage_count: 0,
            current_interval_remaining_percent: 80, current_weekly_remaining_percent: 55,
            ...(ctx.data.boosted ? { current_weekly_remaining_percent: 90, weekly_boost_permille: 1500 } : {}),
            end_time: Date.now() + 2 * 3600_000, weekly_end_time: Date.now() + 4 * 86400_000,
          }],
        }, Date.now()) },
    },
    openExternal: async () => {},
  }),
  render: () => (
    <main className="flex h-screen min-w-0 flex-col gap-8 overflow-auto bg-content-area p-4">
      <ProviderAccountUsageModule provider={provider} />
      <div data-testid="minimax-task-chip" className="flex min-w-0 justify-end">
        <TodaySpendChip vendorKey="codex" providerId="minimax-fixture" />
      </div>
    </main>
  ),
});
