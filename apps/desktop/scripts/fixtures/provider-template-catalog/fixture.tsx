import { useState } from 'react';
import { BUNDLED_CATALOG } from '@cindy/model-providers';
import { mountPage, forbid, subscription } from '../../ui-page/harness';
import { ProviderConnectionDialog } from '../../../src/renderer/components/settings/ProviderConnectionDialog';
import { AddProviderWizard } from '../../../src/renderer/components/settings/AddProviderWizard';
import type { DetectedProviderDraft } from '../../../src/shared/providerDetection';
import { cases, presets, deployments } from './cases';
const evidence: { saved?: unknown; handoff?: DetectedProviderDraft; fetches: unknown[] } = { fetches: [] };
Object.assign(window, { templateEvidence: evidence, templateIds: presets.map(p => p.id) });
function Page({ scenario }: { scenario: string }) {
  const item = cases.find(c => c.id === scenario) ?? cases[0];
  const [detected, setDetected] = useState<DetectedProviderDraft>();
  const [draft, setDraft] = useState<DetectedProviderDraft>();
  return item.kind === 'wizard' || detected ? <AddProviderWizard providers={[]}
    entry={item.kind === 'wizard' ? { kind: 'preset', presetId: item.providerId } : undefined}
    detected={detected} onClose={() => undefined} onDone={() => undefined} onOpenCustomForm={() => undefined}
    onReturnCustom={value => { setDraft(value); setDetected(undefined); }} />
    : <ProviderConnectionDialog draft={draft} onDetected={value => { evidence.handoff = value; setDetected(value); }} onClose={() => undefined} onSaved={() => undefined} />;
}
const models = [{ id: 'ui-catalog-probe', name: 'UI catalog probe', discoveredMetadata: { mode: 'chat' as const } }];
mountPage({
  host: ctx => {
    const item = cases.find(c => c.id === ctx.case) ?? cases[0];
    return { maker: {
      listProviderPresets: async () => ({ presets, modelRegistry: BUNDLED_CATALOG.modelRegistry }),
      fetchProviderModels: async (input: unknown) => { evidence.fetches.push(input); return { ok: true, models }; },
      detectProvider: async (input: { cancel?: boolean }) => ({ candidates: !input.cancel && deployments.includes(item.providerId) ? [item.providerId] : [], reason: 'matched', catalog: { ok: true, models } }),
      localModelList: async () => ({ status: { kind: 'absent', appInstalled: false }, models: [], memoryGb: 0 }),
      scanLocalCli: async () => ({ detections: [] }),
      onProviderOAuthProgress: subscription('providerOAuthProgress'),
      createCustomProvider: async (config: unknown) => { evidence.saved = config; return { ok: true }; },
      testProviderConnection: forbid('testProviderConnection'),
    } };
  },
  render: ctx => <Page scenario={ctx.case} />,
});
