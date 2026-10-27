import { useTranslation } from 'react-i18next';
import { BUNDLED_CATALOG, type ProviderView } from '@cindy/model-providers';
import { mountPage, subscription } from '../../ui-page/harness';
import { UnifiedModelList } from '../../../src/renderer/components/settings/UnifiedModelList';

const provider: ProviderView = {
  ...BUNDLED_CATALOG.providers.find(p => p.id === 'xd')!,
  connected: true,
  agents: ['codex'],
  models: { codex: [
    { id: 'typesafe/jev', name: 'Jev', mode: 'evaluation', efforts: [], defaultEffort: null },
    { id: 'demo/ocr', name: 'Document OCR', mode: 'ocr', efforts: [], defaultEffort: null },
    { id: 'demo/edit', name: 'Image Editor', mode: 'image_edit', efforts: [], defaultEffort: null },
  ] },
  imageModels: [{ id: 'demo/seedream', name: 'Seedream', mode: 'image_generation' }],
  videoModels: [{ id: 'demo/video-tiers', name: 'Video', mode: 'video_generation' }],
  audioModels: [{ id: 'demo/tts-characters', name: 'Qwen Speech', mode: 'audio_speech' }],
  embeddingModels: [],
  availableMediaModelIds: ['demo/seedream', 'demo/video-tiers', 'demo/tts-characters'],
};

function Fixture() {
  const { t } = useTranslation();
  return <main className="mx-auto max-w-[760px] p-6">
    <h1 className="mb-5 text-20 font-medium text-[var(--text-primary)]">{t('settings.providers.title')}</h1>
    <UnifiedModelList provider={provider} />
  </main>;
}

void mountPage({
  host: () => {
    localStorage.setItem('xdt:modelListCollapsedGroups:v3', JSON.stringify({
      image: false, video: false, tts: false, decision: false, other: false,
    }));
    return { maker: {
      onProvidersChanged: subscription('providersChanged'),
      getModelPricing: async () => null,
      syncModelVisibility: async () => undefined,
      claimLegacyModelVisibilityOwner: async () => ({ dataOwnerId: 'categories-fixture', ownerGeneration: 1,
        canWriteOwnerScoped: true, canInitialize: true }),
    } };
  },
  render: () => <Fixture />,
});
