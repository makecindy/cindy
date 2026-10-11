import { describe, expect, it } from 'vitest';
import {
  configureProviderMediaRuntime,
  listProviderMediaModels,
  listReadyProviderMediaModels,
  resolveProviderMediaModel,
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
  it('merges only real visible video aliases, preserves providers and does not duplicate readiness', () => {
    const video = { ...visible, id: 'xai/grok-imagine-video', providerId: 'xai',
      mode: 'video_generation' as const, modalities: { input: ['text', 'image'], output: ['video'] } };
    const second = { ...video, providerId: 'other-subscription' };
    configureProviderMediaRuntime({ listModels: () => [visible], listVideoModels: () => [video, second],
      invoke: async () => ({ buffer: Buffer.alloc(0), mimeType: 'image/png' }) });
    expect(listProviderMediaModels()).toEqual([visible, video, second]);
    expect(listReadyProviderMediaModels()).toEqual([visible, video, second]);
    expect(resolveProviderMediaModel('xai', video.id, 'video.image_to_video')).toEqual(video);
    expect(resolveProviderMediaModel('other-subscription', video.id, 'video.generate')).toEqual(second);
    expect(resolveProviderMediaModel('xai', video.id, 'image.generate')).toBeNull();
    expect(resolveProviderMediaModel('xai', 'xai/unregistered-video-1.5', 'video.generate')).toBeNull();
  });
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
