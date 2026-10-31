import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { BUNDLED_CATALOG } from '@cindy/model-providers';
import { ProviderConnectionDialog } from '../../../src/renderer/components/settings/ProviderConnectionDialog';
import { AddProviderWizard, type WizardEntry } from '../../../src/renderer/components/settings/AddProviderWizard';

function Page() {
  const [entry, setEntry] = useState<WizardEntry>();
  return <>
    {entry && <AddProviderWizard providers={[]} entry={entry} onClose={() => setEntry(undefined)}
      onEntryUnavailable={() => setEntry(undefined)} onDone={() => setEntry(undefined)} onOpenCustomForm={() => setEntry(undefined)} />}
    <ProviderConnectionDialog providers={[]} suspended={!!entry} onSelectProvider={setEntry} onClose={() => undefined} onSaved={() => undefined} />
  </>;
}
mountPage({
  host: ctx => ({ maker: {
    listProviderPresets: async () => {
      if (ctx.case === 'offline-jump') throw new Error('Fixture catalog unavailable');
      return { presets: BUNDLED_CATALOG.presets ?? [] };
    },
    localModelList: async () => ({ status: { kind: 'absent', appInstalled: false }, models: [], memoryGb: 0 }),
    scanLocalCli: async () => ({ detections: [] }),
    onProviderOAuthProgress: subscription('providerOAuthProgress'),
    localModelStatus: async () => ({ runtime: 'ollama', kind: 'absent', appInstalled: false, canInstallRuntime: true }),
    onLocalModelInstallProgress: subscription('localModelInstallProgress'),
    onLocalModelStatus: subscription('localModelStatus'),
  } }),
  render: () => <Page />,
});
