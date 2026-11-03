import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { ModelConfigFlyout } from '../../../src/renderer/components/new-chat/ModelConfigFlyout';
import { SpeedIcon } from '../../../src/renderer/components/new-chat/SpeedIcon';
import { BUNDLED_CATALOG, resolveModelMetadata, type Effort, type UnifiedModelEntry } from '@cindy/model-providers';

function Fixture({ variant }: { variant: string }) {
  const modelId = variant === 'sol' ? 'gpt-6.1-sol' : 'gpt-6-astra';
  const metadata = resolveModelMetadata(BUNDLED_CATALOG.modelRegistry, 'openai', modelId, undefined, undefined, 'codex');
  const capability = {
    agent: 'codex' as const, wireModelId: modelId, efforts: metadata.efforts ?? [],
    defaultEffort: metadata.defaultEffort ?? null, defaultEffortSource: 'catalog' as const,
    supportsFastMode: true, supportsUltrafastMode: true,
    contextWindow: metadata.contextWindow ?? 272000, contextWindowVerified: true,
  };
  const entry: UnifiedModelEntry = {
    providerId: 'openai', modelId, displayName: metadata.name ?? modelId,
    candidates: ['codex'], recommended: 'codex', nativeAgent: 'codex', capabilities: { codex: capability },
  };
  const [fast, setFast] = useState<boolean | 'ultrafast'>('ultrafast');
  const [effort, setEffort] = useState<Effort>('high');
  return (
    <main className="mx-auto w-full max-w-[360px] p-4">
      <div className="mb-5 flex items-center gap-2 text-[var(--text-primary)]">
        <SpeedIcon mode={fast} size={20}/><span>{entry.displayName}</span>
      </div>
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
        <ModelConfigFlyout entry={entry}
          config={{engine:'codex', agent:'codex', efforts:capability.efforts, effort, fast,
            fastCapable:true, customized:true, capability, wireModelId:modelId}}
          state="customized" sourceLabel="OpenAI" price={null}
          effortLabelOf={(_, value) => value === 'ultra' ? 'Ultra' : value}
          onEngineChange={()=>{}} onEffortChange={setEffort} onFastChange={setFast}
          onResetToRecommended={()=>{ setFast(false); setEffort(capability.defaultEffort ?? 'medium'); }}
          onAddFavorite={()=>{}} onRemoveFavorite={()=>{}}/>
      </div>
    </main>
  );
}
void mountPage({
  host: { maker: {
    getModelContextLimit: async () => ({limit:272000,isCustomized:false}),
    onProvidersChanged: subscription('providersChanged'),
  } },
  render: ctx => <Fixture variant={ctx.case}/>,
});
