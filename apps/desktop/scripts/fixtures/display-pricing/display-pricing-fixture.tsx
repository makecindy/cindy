import { mountPage, subscription } from '../../ui-page/harness';
import { ModelAdvancedDrawer } from '../../../src/renderer/components/settings/ModelAdvancedDrawer';
import { buildUnionRows } from '../../../src/renderer/components/settings/UnifiedModelList';
import {
  BUNDLED_CATALOG,
  type ProviderView,
  type ModelDisplayPricing,
} from '@cindy/model-providers';

const speech: ModelDisplayPricing = {
  items: [{ label: 'Text input', price: 140, unit: 'character', quantity: 1000000 }],
  summary: { input: [{ price: 140, unit: 'character', quantity: 1000000 }] },
};
const image: ModelDisplayPricing = {
  items: [
    { label: 'Input image', price: 0.02, unit: 'image', quantity: 1 },
    { label: 'Output image', price: 0.3, unit: 'image', quantity: 1 },
  ],
  summary: {
    input: [{ price: 0.02, unit: 'image', quantity: 1 }],
    output: [{ price: 0.3, unit: 'image', quantity: 1 }],
  },
};
const video: ModelDisplayPricing = {
  items: [
    { label: 'Video generation', price: 0.05, tier: '480P', unit: 'second', quantity: 1 },
    { label: 'Video generation', price: 0.1, tier: '720P', unit: 'second', quantity: 1 },
    { label: 'Video generation', price: 0.2, tier: '1080P', unit: 'second', quantity: 1 },
  ],
  notes: ['Billed by generated resolution.'],
  summary: {
    output: [
      {
        price: 0.05,
        maxPrice: 0.2,
        tier: '480P/720P/1080P',
        unit: 'second',
        quantity: 1,
      },
    ],
  },
};
const mixed: ModelDisplayPricing = {
  ...video,
  summary: {
    input: [
      { price: 140, unit: 'character', quantity: 1000000 },
      { price: 0.02, unit: 'image', quantity: 1, tier: 'HD', priceType: 'estimated' },
    ],
    output: video.summary!.output,
    cacheRead: [{ price: 0.5, unit: 'request', quantity: 1234.5 }],
    cacheWrite: [{ price: 1, unit: 'second', quantity: 1 }],
  },
};

void mountPage({
  host: {
    maker: {
      getModelContextLimit: async () => ({ limit: null, isCustomized: false }),
      onProvidersChanged: subscription('providersChanged'),
      getModelPricing: async () => null,
      syncModelVisibility: async () => undefined,
      claimLegacyModelVisibilityOwner: async () => ({
        dataOwnerId: 'pricing-fixture',
        ownerGeneration: 1,
        canWriteOwnerScoped: true,
        canInitialize: true,
      }),
    },
  },
  render: (ctx) => {
    const quote =
      (
        { speech, image, video, mixed, legacy: { items: speech.items } } as Record<
          string,
          ModelDisplayPricing
        >
      )[ctx.case] ?? mixed;
    const provider: ProviderView = {
      ...BUNDLED_CATALOG.providers.find((p) => p.id === 'xd')!,
      connected: true,
      availableMediaModelIds: ['speech', 'image', 'video'],
      models: {},
      agents: [],
      embeddingModels: [],
      audioModels: [
        {
          id: 'speech',
          name: 'Qwen Speech',
          mode: 'audio_speech',
          currency: 'CNY',
          displayPricing: ctx.case === 'legacy' ? quote : speech,
          modalities: { input: ['text'], output: ['audio'] },
        },
      ],
      imageModels: [
        {
          id: 'image',
          name: 'Seedream',
          mode: 'image_generation',
          currency: 'USD',
          displayPricing: image,
          modalities: { input: ['text', 'image'], output: ['image'] },
        },
      ],
      videoModels: [
        {
          id: 'video',
          name: 'Video',
          mode: 'video_generation',
          currency: 'CNY',
          costDiscount: 0.4,
          displayPricing: quote,
          modalities: { input: ['text'], output: ['video'] },
        },
      ],
    };
    const rowId = ['speech', 'legacy'].includes(ctx.case) ? 'speech' : ctx.case === 'image' ? 'image' : 'video';
    return (
      <ModelAdvancedDrawer
        provider={provider}
        row={buildUnionRows(provider).find((row) => row.id === rowId)!}
        open
        onOpenChange={() => {}}
        pricePresentationOf={() => null}
        onDisable={() => {}}
        disabled={false}
        paymentRequired={false}
      />
    );
  },
});
