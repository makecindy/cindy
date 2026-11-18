import { useState } from 'react';
import type { UnifiedAgentCapability, UnifiedModelEntry } from '@cindy/model-providers';
import { useTranslation } from 'react-i18next';
import { mountPage, subscription } from '../../ui-page/harness';
import { ModelConfigFlyout } from '../../../src/renderer/components/new-chat/ModelConfigFlyout';
import { resolveUnifiedRowConfig } from '../../../src/renderer/components/new-chat/unifiedModelSelection';
import { GoogleSubscriptionUsageChip } from '../../../src/renderer/components/status/GoogleSubscriptionUsageChip';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import type { AntigravityAccountsView } from '../../../src/shared/antigravityAccounts';
import type { Effort } from '../../../src/renderer/lib/userPreferences.types';

function Controls({ flash, fixed }: { flash: boolean; fixed: boolean }) {
  const { t } = useTranslation();
  const [effort, setEffort] = useState<Effort>('medium');
  const id = fixed ? 'gemini-pro-orchestrator-g1-pro' : flash ? 'gemini-3.8-flash' : 'gemini-4-hydrogen';
  const capability: UnifiedAgentCapability = { agent: 'antigravity', wireModelId: id,
    efforts: fixed ? [] : flash ? ['low', 'medium', 'high'] : ['low', 'medium', 'high', 'xhigh'], defaultEffort: fixed ? null : 'medium', defaultEffortSource: 'catalog',
    contextWindow: 0, contextWindowVerified: false, supportsFastMode: false };
  const entry: UnifiedModelEntry = { providerId: 'google-antigravity-subscription', modelId: id,
    displayName: fixed ? 'Orchestrator (Argon)' : flash ? 'Gemini 3.8 Flash' : 'Gemini 4 Hydrogen', candidates: ['antigravity'], nativeAgent: 'antigravity', recommended: 'antigravity', capabilities: { antigravity: capability } };
  const config = resolveUnifiedRowConfig({ entry, memoryEffort: () => effort });
  return <main className="flex h-screen flex-col items-center gap-6 bg-content-area p-4">
    <div className="w-full max-w-[300px] rounded-xl border p-4">
      <ModelConfigFlyout entry={entry} config={config} state="customized" sourceLabel="Google AI Pro · Antigravity"
        price={null} effortLabelOf={(_agent, value) => t(`effortLevels.${value}`)} onEngineChange={() => {}} onEffortChange={setEffort} onFastChange={() => {}}
        onResetToRecommended={() => setEffort('medium')} onAddFavorite={() => {}} onRemoveFavorite={() => {}} />
    </div>
    <output data-testid="selected-thought">{config.effort}</output>
    <GoogleSubscriptionUsageChip context={{ used: 12000, size: 1048576 }} turnTokens={1234} />
  </main>;
}
mountPage({
  host: ({ data }) => ({
    maker: { getModelContextLimit: async () => ({ limit: null, isCustomized: false }), onProvidersChanged: subscription('providersChanged') },
    ...(data.quota && { antigravityAccounts: async (command: unknown, scope: unknown): Promise<AntigravityAccountsView> => {
      if (JSON.stringify(command) !== '{"action":"usage"}' ||
        JSON.stringify(scope) !== '{"dataOwnerId":"fixture-owner","ownerGeneration":1}') {
        throw new Error('Expected the active fixture owner scope');
      }
      return {
        configured: true, connected: true, activeId: 'fixture-google',
        accounts: [{ id: 'fixture-google', identity: 'fixture@example.test' }],
        usage: [{
          limitId: 'gemini', limitName: 'Gemini Models', updatedAt: Date.now(),
          primary: { usedPercent: 25, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
          secondary: { usedPercent: 60, windowMinutes: 10_080, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
        }],
      };
    } }),
  }),
  render: context => {
    if (context.data.quota) setDataOwnerGeneration('fixture-owner', 1);
    return <Controls flash={context.data.flash === true} fixed={context.data.fixed === true} />;
  },
});
