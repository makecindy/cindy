import { useState } from 'react';
import { mountPage, forbid, subscription } from '../../ui-page/harness';
import { BUNDLED_CATALOG } from '@cindy/model-providers';
import { ProviderConnectionDialog } from '../../../src/renderer/components/settings/ProviderConnectionDialog';
import { AddProviderWizard } from '../../../src/renderer/components/settings/AddProviderWizard';
import type { DetectedProviderDraft } from '../../../src/shared/providerDetection';

const models = ['example-chat', 'example-reasoning', 'example-vision', 'example-fast', 'example-long-context'].map(id => ({ id, name: id, discoveredMetadata: { mode: 'chat' as const } }));
const evidence: { tests: unknown[]; saved?: unknown } = { tests: [] };
Object.assign(window, { providerP1Evidence: evidence });
const disabledDraft: DetectedProviderDraft = {
  agent: 'pi', apiKey: 'fake-ui-key', keys: { pi: 'fake-ui-key' },
  preset: { id: 'review-fixture', name: 'Review fixture', runtimes: { pi: { baseUrl: 'https://fixture.example/v1', wireProtocol: 'openai-chat', models: [] } } },
  config: { id: 'draft', name: 'Selection fixture', runtimes: { pi: { baseUrl: 'https://fixture.example/v1', models: [{ id: 'disabled-model', name: 'disabled-model', defaultEnabled: false }] } } },
  catalog: { ok: true, models: [{ id: 'disabled-model', name: 'disabled-model' }] },
};
function Page({ scenario }: { scenario: string }) {
  const [identified, setIdentified] = useState<DetectedProviderDraft | undefined>(['reenable', 'return-reenable'].includes(scenario) ? disabledDraft : undefined);
  const [draft, setDraft] = useState<DetectedProviderDraft>();
  return identified ? <AddProviderWizard providers={[]} detected={identified}
    onReturnCustom={value => { setDraft(value); setIdentified(undefined); }}
    onClose={() => undefined} onDone={() => undefined} onOpenCustomForm={() => undefined} />
    : <ProviderConnectionDialog draft={draft} onDetected={setIdentified}
      onClose={() => undefined} onSaved={() => undefined} />;
}
mountPage({
  host: ctx => ({ maker: {
    listProviderPresets: async () => ({ presets: [
      ...(BUNDLED_CATALOG.presets ?? []),
      ...(ctx.case === 'loopback-identity' ? [{ id: 'local-custom-brand', name: 'Local custom', runtimes: { pi: { baseUrl: 'https://localhost:1234/v1', models: [] } } }] : []),
      ...(ctx.case === 'ambiguous-official' ? [{ ...BUNDLED_CATALOG.presets!.find(p => p.id === 'deepseek')!, id: 'same-address-plan' }] : []),
    ] }),
    fetchProviderModels: async () => ctx.case === 'failed' ? { ok: false, code: 'AUTH_INVALID' } : { ok: true, models },
    detectProvider: async (input: { cancel?: boolean }) => input.cancel ? { candidates: [] }
      : { candidates: ctx.case === 'relay' ? ['sub2api'] : ctx.case === 'litellm' ? ['litellm'] : [], reason: ['relay', 'litellm'].includes(ctx.case) ? 'matched' : 'insufficient_evidence',
        catalog: ctx.case === 'manual-fetch' ? undefined : ctx.case === 'failed' ? { ok: false, code: 'AUTH_INVALID' } : { ok: true, models } },
    localModelList: async () => ({ status: { kind: 'absent', appInstalled: false }, models: [], memoryGb: 0 }),
    scanLocalCli: async () => ({ detections: [] }),
    onProviderOAuthProgress: subscription('providerOAuthProgress'),
    createCustomProvider: ctx.case.startsWith('cloudflare-') || ['local-noauth', 'reenable', 'return-reenable', 'custom-port'].includes(ctx.case)
      ? async (config: unknown) => { evidence.saved = config; return { ok: true }; }
      : forbid('createCustomProvider'),
    testProviderConnection: ctx.case === 'local-noauth'
      ? async (input: unknown) => { evidence.tests.push(input); return { ok: true, latencyMs: 1 }; }
      : forbid('testProviderConnection'),
  } }),
  render: ctx => <Page scenario={ctx.case} />,
});
