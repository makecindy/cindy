import type { ProviderView } from '@cindy/model-providers';
import { mountPage, subscription } from '../../ui-page/harness';
import { ProviderAccountUsageModule } from '../../../src/renderer/components/settings/ProviderAccountUsageModule';
import { TodaySpendChip } from '../../../src/renderer/components/status/TodaySpendChip';

const provider = {
  id: 'kimi-coding', name: 'Kimi Code', connected: true,
  auth: { method: 'oauth', oauth: { tokenUrl: 'https://auth.kimi.com/api/oauth/token' } },
  routing: { pi: { upstream: 'https://api.kimi.com/coding/v1' } },
} as ProviderView;

void mountPage({
  host: (ctx) => ({
    maker: {
      onProvidersChanged: subscription('providers'),
      fetchProviderAccountUsage: async () => ctx.data.error
        ? { status: 'unavailable', error: 'auth' }
        : { status: 'ready', stale: ctx.data.stale === true, snapshot: {
          kind: 'kimi-coding-quota', fetchedAt: Date.now(), windows: ctx.data.empty ? [] : [
            ...(!ctx.data.monthly ? [{ id: 'limit_5h', usedPercent: 23, resetsAt: Date.now() + 2 * 3600_000 }] : []),
            ...(ctx.data.legacy ? [{ id: 'limit_7d', usedPercent: 42, resetsAt: Date.now() + 4 * 86400_000 }] : []),
            ...(ctx.data.monthly ? [{ id: 'limit_month_total', usedPercent: 65, resetsAt: Date.now() + 4 * 86400_000 }, { id: 'limit_month_code', usedPercent: 80, resetsAt: Date.now() + 4 * 86400_000 }] : []),
          ],
        } },
    },
    openExternal: async () => {},
  }),
  render: () => (
    <main className="flex h-screen min-w-0 flex-col gap-8 overflow-auto bg-content-area p-4">
      <ProviderAccountUsageModule provider={provider} />
      <div data-testid="kimi-task-chip" className="flex min-w-0 justify-end">
        <TodaySpendChip vendorKey="pi" providerId="kimi-coding" />
      </div>
    </main>
  ),
});
