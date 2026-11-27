import { ProviderShareLinkDialog } from '../../../src/renderer/features/provider-share/ProviderShareLinkDialog';
import { ToastContainer } from '../../../src/renderer/components/ui/toast/ToastContainer';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { mountPage, subscription, forbid } from '../../ui-page/harness';

setDataOwnerGeneration('fixture-owner', 1);
mountPage({
  route: '/settings',
  host: {
    providerShare: { command: async () => ({
      link: 'https://example.invalid/provider-share/join#fixture-not-a-real-token',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }) },
    selfHostedRelay: {
      command: async () => ({ state: { mode: 'official' } }),
      onChanged: subscription('relayChanged'),
    },
    copyTextToClipboard: forbid('copyTextToClipboard'),
    localDb: {
      sessions: { create: async () => ({ id: 'fixture-private-task' }) },
      messages: { create: async () => { throw new Error('Synthetic save failure'); } },
    },
  },
  render: () => <>
    <ProviderShareLinkDialog providerId="fixture-provider" providerLabel="Example provider" onClose={() => {}} />
    <ToastContainer />
  </>,
});
