import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { buildUserProvider, mergeDiscoveredRuntimeModels, parseModelsListResponse, unifiedModelEntries } from '@cindy/model-providers';
import { UnifiedModelRow } from '../../../src/renderer/components/new-chat/UnifiedModelRow';
import { resolveUnifiedRowConfig } from '../../../src/renderer/components/new-chat/unifiedModelSelection';

const models = mergeDiscoveredRuntimeModels([], parseModelsListResponse({ data: [
  { id: 'one/deepseek-v4.1-flash', display_name: 'DeepSeek V4.1 Flash', owned_by: 'one', magpie_label: 'DeepSeek V4.1 Flash · Supplier A' },
  { id: 'two/deepseek-v4.1-flash', display_name: 'DeepSeek V4.1 Flash', owned_by: 'two', magpie_label: 'DeepSeek V4.1 Flash · Supplier B' },
  { id: 'one/unknown-model', display_name: 'Unknown model', owned_by: 'one', magpie_label: 'Unknown model · Supplier A' },
] })!);
const provider = { ...buildUserProvider({ id: 'magpie-ui', name: 'Magpie', runtimes: { pi: {
  baseUrl: 'http://127.0.0.1:3425/v1', wireProtocol: 'openai-chat', models,
} } }), connected: true };
const entries = unifiedModelEntries({ providers: [provider] });
const ordinaryProviders = ['openai', 'xd'].map(id => ({
  ...buildUserProvider({ id, name: id === 'xd' ? 'Cindy AI' : 'OpenAI', runtimes: { pi: {
    baseUrl: 'http://127.0.0.1:3425/v1', wireProtocol: 'openai-chat',
    models: [{ id: 'gpt-5.5', name: 'GPT-5.5', efforts: ['low'] }],
  } } }), connected: true, subscriptionAccount: { identity: 'account@example.test' },
}));
function Fixture({ variant }: { variant: string }) {
  const [selected, setSelected] = useState('');
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const ordinary = variant === 'non-magpie' || variant === 'accounts';
  const providers = ordinary ? ordinaryProviders : [provider];
  const visibleEntries = ordinary ? unifiedModelEntries({ providers }) : entries;
  return <main className="mx-auto w-full max-w-[520px] p-4">
    <div className="rounded-xl border border-[var(--model-dropdown-border)] bg-[var(--model-dropdown-bg)] p-2" role="listbox" aria-label="Magpie models">
      {visibleEntries.map(entry => {
        const config = resolveUnifiedRowConfig({ entry });
        return <UnifiedModelRow key={`${entry.providerId}/${entry.modelId}`} entry={entry} config={config} providers={providers}
          anchor={{ kind: 'model', providerId: entry.providerId, modelId: entry.modelId }}
          selected={selected === entry.modelId} active={false} isFavoriteRow={favorites.has(entry.modelId)} justFavorited={false}
          interactionDisabled={false} effortLabelOf={(_, effort) => effort}
          {...(variant === 'accounts'
            ? { sourceLabel: providers.find(item => item.id === entry.providerId)!.name }
            : variant !== 'provider' && !ordinary ? { sourceLabel: 'Magpie' } : {})}
          onSelect={() => setSelected(entry.modelId)} onReveal={() => {}} onRevealForKeyboard={() => {}}
          onStar={() => setFavorites(previous => { const next = new Set(previous); next.has(entry.modelId) ? next.delete(entry.modelId) : next.add(entry.modelId); return next; })}/>;
      })}
    </div>
  </main>;
}
void mountPage({ render: ctx => <Fixture variant={ctx.case}/> });
