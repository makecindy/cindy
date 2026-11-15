import { useState } from 'react';
import { mountPage, subscription, forbid } from '../../ui-page/harness';
import { ProviderImportDialog, ProviderImportBatchDialog, ProviderImportFileButton } from '../../../src/renderer/components/settings/ProviderImportDialog';

function FileImport() {
  const [id, setId] = useState<string | string[] | null>(null);
  return <main className="p-4">
    <div className="w-[208px]">
      <ProviderImportFileButton onImported={setId} />
    </div>
    {Array.isArray(id) ? <ProviderImportBatchDialog importIds={id} onClose={() => setId(null)} onDone={() => setId(null)} />
      : id && <ProviderImportDialog importId={id} onClose={() => setId(null)} onDone={() => setId(null)} />}
  </main>;
}

void mountPage({
  host: ctx => {
    let failedOnce = false;
    return {
    maker: {
      importProviderFile: async () => ctx.case === 'batch' ? ['a', 'b', 'oauth'] : 'fixture-file-draft',
      previewProviderImport: async (id: string) => ({
        importId: id, kind: 'custom', name: ctx.case === 'batch' ? `Example ${id}` : 'Example model catalog',
        authMethod: id === 'oauth' ? 'oauth' : 'apiKey', action: 'create', providerId: `example-${id}`, updateTargets: [],
        runtimes: [{ agent: 'pi', protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1',
          modelCount: 257, willFetchModels: false, hasApiKey: true, headerNames: ['X-Tenant'] }],
      }),
      confirmProviderImport: ctx.case !== 'batch' ? forbid('confirmProviderImport') : async (id: string) => {
        if (id === 'b' && !failedOnce) { failedOnce = true; throw new Error('Simulated save failure'); }
        return { ok: true, providerId: `example-${id}`, authMethod: 'apiKey' };
      },
      cancelProviderImport: async () => ({ ok: true }),
      onProviderOAuthProgress: subscription('providerOAuthProgress'),
    },
  }; },
  render: () => <FileImport />,
});
