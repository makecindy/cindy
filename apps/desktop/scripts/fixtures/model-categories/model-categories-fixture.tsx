import { useEffect, useState } from 'react';
import { setModelVisibilityOwner, setModelVisibilities } from '../../../src/renderer/state/modelVisibilityPrefs';
import { useTranslation } from 'react-i18next';
import { BUNDLED_CATALOG, type ProviderView } from '@cindy/model-providers';
import { ctx, mountPage, subscription } from '../../ui-page/harness';
import { UnifiedModelList } from '../../../src/renderer/components/settings/UnifiedModelList';

const provider: ProviderView = {
  ...BUNDLED_CATALOG.providers.find(p => p.id === 'xd')!,
  connected: true,
  agents: ['codex'],
  models: { codex: [
    { id: 'demo/ocr', name: 'Document OCR', mode: 'ocr', efforts: [], defaultEffort: null },
    { id: 'demo/edit', name: 'Image Editor', mode: 'image_edit', efforts: [], defaultEffort: null },
    // The two-axis case needs chat models too: their switch is picker visibility, not access.
    ...(ctx.case === 'two-axes' ? [
      { id: 'demo/astra', name: 'Astra', group: 'gpt', contextWindow: 400000, efforts: [], defaultEffort: null },
      { id: 'demo/astra-mini', name: 'Astra Mini', group: 'gpt', contextWindow: 400000, efforts: [], defaultEffort: null },
    ] : []),
  ] },
  evaluationModels: [{ id: 'typesafe/jev-1.14', name: 'Jev', mode: 'evaluation', availability: 'available', modalities: { input: [], output: [] } }, { id: 'demo/rerank', name: 'Reranker', mode: 'rerank', availability: 'available', modalities: { input: [], output: [] } }],
  imageModels: [{ id: 'demo/seedream', name: 'Seedream', mode: 'image_generation' }],
  videoModels: [{ id: 'demo/video-tiers', name: 'Video', mode: 'video_generation' }],
  audioModels: [{ id: 'demo/tts-characters', name: 'Qwen Speech', mode: 'audio_speech' }],
  embeddingModels: [],
  availableMediaModelIds: ['typesafe/jev-1.14', 'demo/rerank', 'demo/seedream', 'demo/video-tiers', 'demo/tts-characters'],
};

function Fixture() {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void setModelVisibilityOwner('categories-fixture', 1, 'cloud').then(() =>
      setModelVisibilities(provider.id, [...provider.availableMediaModelIds!, ...provider.models.codex!.map(model => model.id)]
        .map(modelId => ({ agent: 'codex' as const, modelId })), true),
    ).then(() => ctx.case === 'two-axes'
      ? setModelVisibilities(provider.id, [{ agent: 'codex' as const, modelId: 'demo/astra-mini' }], false)
      : undefined,
    ).then(() => setReady(true));
  }, []);
  return <main className="mx-auto max-w-[760px] p-6">
    <h1 className="mb-5 text-20 font-medium text-[var(--text-primary)]">{t('settings.providers.title')}</h1>
    {ready && <UnifiedModelList provider={provider} />}
  </main>;
}

void mountPage({
  host: () => {
    localStorage.setItem('xdt:modelListCollapsedGroups:v3', JSON.stringify({
      image: false, video: false, tts: false, decision: false, rerank: false, other: false,
    }));
    return { maker: {
      onProvidersChanged: subscription('providersChanged'),
      getModelPricing: async () => null,
      // Function-type models write the access axis; the list keeps its optimistic state.
      setModelDisable: async () => ({ ok: true }),
      syncModelVisibility: async () => undefined,
      claimLegacyModelVisibilityOwner: () => ({ dataOwnerId: 'categories-fixture', ownerGeneration: 1,
        canWriteOwnerScoped: true, claimed: true, claimedByOtherOwner: false, canInitialize: true, profileOrigin: 'new' }),
    } };
  },
  render: () => <Fixture />,
});
