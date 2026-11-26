import { useState } from 'react';
import { BUNDLED_CATALOG } from '@cindy/model-providers';
import { mountPage, forbid, subscription } from '../../ui-page/harness';
import { ProviderConnectionDialog } from '../../../src/renderer/components/settings/ProviderConnectionDialog';
import { AddProviderWizard } from '../../../src/renderer/components/settings/AddProviderWizard';
import { getToastSnapshot } from '../../../src/renderer/lib/toast';
import type { DetectedProviderDraft } from '../../../src/shared/providerDetection';
import { cases, presets, deployments, retainedPreset } from './cases';
const evidence: { saved?: unknown; tested?: unknown; resolveProbe?: () => void; handoff?: DetectedProviderDraft; fetches: unknown[] } = { fetches: [] };
Object.assign(window, { templateEvidence: evidence, templateIds: presets.map(p => p.id), templateToasts: getToastSnapshot });
function Page({ scenario }: { scenario: string }) {
  const item = cases.find(c => c.id === scenario) ?? cases[0];
  const [detected, setDetected] = useState<DetectedProviderDraft>();
  const [draft, setDraft] = useState<DetectedProviderDraft>();
  if (scenario === 'official-model-plugins') return <AddProviderWizard providers={[]}
    showOfficialModelPlugins onClose={() => undefined}
    onDone={() => undefined} onOpenCustomForm={() => undefined} />;
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
    const engine = { name: 'Antigravity', ghostId: 'cindy-antigravity-acp', pluginId: 'official-engine',
      sourceType: 'server', scope: 'public', publisherKind: 'official', releaseId: 'official-release' };
    return { ...(ctx.case === 'official-model-plugins' ? { ghosts: { listSync: () => ({ ghosts: [] }), onChanged: () => () => {} }, pluginMarket: {
      detail: async () => ({ ...engine, installState: 'not-installed', manifest: { harnesses: [{ protocol: 'acp' }] } }),
      officialModelPlugins: async () => ({ items: [engine], officialIds: [engine.pluginId], totalOfficial: 1, nextCursor: null }),
      cancelOfficialModelPlugins: async () => {},
    } } : {}), maker: {
      listProviderPresets: async () => ({ presets: ctx.case === 'wizard-deepseek-retained' ? [retainedPreset] : presets, modelRegistry: BUNDLED_CATALOG.modelRegistry }),
      fetchProviderModels: async (input: unknown) => { evidence.fetches.push(input); return ctx.case === 'wizard-deepseek-retained' ? { ok: false } : { ok: true, models }; },
      detectProvider: async (input: { cancel?: boolean }) => ({ candidates: !input.cancel && deployments.includes(item.providerId) ? [item.providerId] : [], reason: 'matched', catalog: { ok: true, models } }),
      localModelList: async () => ({ status: { kind: 'absent', appInstalled: false }, models: [], memoryGb: 0 }),
      scanLocalCli: async () => ({ detections: [] }),
      onProviderOAuthProgress: subscription('providerOAuthProgress'),
      createCustomProvider: async (config: unknown) => { evidence.saved = config; return { ok: true }; },
      testProviderConnection: item.providerId === 'command-code' ? async (input: unknown) => {
        evidence.tested = input;
        await new Promise<void>(resolve => { evidence.resolveProbe = resolve; });
        return { ok: false, code: 'AUTH_INVALID' };
      } : forbid('testProviderConnection'),
    } };
  },
  render: ctx => <Page scenario={ctx.case} />,
});
