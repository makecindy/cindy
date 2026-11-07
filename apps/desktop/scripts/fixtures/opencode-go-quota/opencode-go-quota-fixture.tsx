import type { ProviderView } from '@cindy/model-providers';
import { mountPage, subscription } from '../../ui-page/harness';
import { ProviderAccountUsageModule } from '../../../src/renderer/components/settings/ProviderAccountUsageModule';
import { TodaySpendChip } from '../../../src/renderer/components/status/TodaySpendChip';

const provider = {
  id: 'opencode-go', name: 'OpenCode Go', source: 'user', connected: true,
  auth: { method: 'apiKey' }, access: { kind: 'api' },
  routing: { codex: { upstream: 'https://opencode.ai/zen/go/v1' } },
} as ProviderView;

void mountPage({
  host: (ctx) => ({
    maker: {
      onProvidersChanged: subscription('providers'),
      fetchProviderAccountUsage: async () => ctx.data.error
        ? { status: 'unavailable', error: 'auth' }
        : { status: 'ready', stale: ctx.data.stale === true, snapshot: {
          kind: 'opencode-go-quota', fetchedAt: Date.now(), windows: [
            { id: 'rolling', usedPercent: 30, limited: false, resetsAt: Date.now() + 2 * 3600_000 },
            { id: 'weekly', usedPercent: 45, limited: false, resetsAt: Date.now() + 4 * 86400_000 },
            { id: 'monthly', usedPercent: 10, limited: false, resetsAt: Date.now() + 20 * 86400_000 },
          ],
        } },
    },
    openExternal: async () => {},
  }),
  render: () => (
    <main className="flex h-screen min-w-0 flex-col gap-8 overflow-auto bg-content-area p-4">
      <ProviderAccountUsageModule provider={provider} />
      <div data-testid="opencode-go-task-chip" className="flex min-w-0 justify-end">
        <TodaySpendChip vendorKey="codex" providerId="opencode-go" />
      </div>
    </main>
  ),
});
