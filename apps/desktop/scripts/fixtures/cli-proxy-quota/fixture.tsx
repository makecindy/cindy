import type { ProviderView } from '@cindy/model-providers';
import { mountPage } from '../../ui-page/harness';
import { CliProxyQuotaSection } from '../../../src/renderer/components/settings/CliProxyQuotaSection';

const provider = {
  id: 'fixture-proxy', source: 'user',
  routing: { pi: { upstream: 'http://127.0.0.1:8317/v1' } },
} as ProviderView;
const resetTime = new Date(Date.now() + 24 * 3600_000).toISOString();
const bucket = (window: string, remainingFraction: number, disabled = false) => ({
  label: window, window, remainingFraction, resetTime, disabled,
});
void mountPage({
  host: { maker: { usage: { getCliProxyQuota: async (_id: string, _key?: string, refresh?: boolean) => ({
    configured: true, observedAt: refresh ? Date.now() : 0,
    accounts: refresh ? [
      { name: 'Account A', disabled: false, unavailable: false, groups: [
        { label: 'Gemini Models', buckets: [bucket('5h', 1), bucket('weekly', 0.9)] },
        { label: 'Claude and GPT models', buckets: [bucket('5h', 1, true), bucket('weekly', 0)] },
      ] },
      { name: 'Account B', disabled: true, unavailable: false, groups: [] },
    ] : [],
  }) } } },
  render: () => <main className="mx-auto w-full max-w-[600px]"><CliProxyQuotaSection provider={provider} /></main>,
});
