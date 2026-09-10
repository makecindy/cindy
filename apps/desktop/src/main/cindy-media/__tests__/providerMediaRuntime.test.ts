import { describe, expect, it } from 'vitest';
import {
  configureProviderMediaRuntime,
  listProviderMediaModels,
  listReadyProviderMediaModels,
} from '../providerMediaRuntime.js';

const visible = {
  id: 'openai/gpt-image-2.5-sunburst',
  name: 'GPT Image 2.5 Sunburst',
  providerId: 'openai',
  mode: 'image_generation' as const,
  modalities: { input: ['text', 'image'], output: ['image'] },
};

const hidden = {
  id: 'openai/gpt-image-2',
  name: 'GPT Image 2',
  providerId: 'openai',
  mode: 'image_generation' as const,
  modalities: { input: ['text', 'image'], output: ['image'] },
};

describe('provider media runtime display switch', () => {
  it('Art listModels hides display-off models; settings readiness still sees them', () => {
    configureProviderMediaRuntime({
      listModels: () => [visible],
      listExecutableModels: () => [visible, hidden],
      listVideoModels: () => [],
      listExecutableVideoModels: () => [],
      invoke: async () => ({ buffer: Buffer.alloc(0), mimeType: 'image/png' }),
    });
    expect(listProviderMediaModels().map((model) => model.id)).toEqual([visible.id]);
    expect(listReadyProviderMediaModels().map((model) => model.id)).toEqual([
      visible.id,
      hidden.id,
    ]);
  });
});
