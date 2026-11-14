import { describe, expect, it, vi } from 'vitest';
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
  it('passes the requested capability to image and video source discovery', () => {
    const listModels = vi.fn(() => [visible]);
    const listVideoModels = vi.fn(() => []);
    configureProviderMediaRuntime({ listModels, listVideoModels,
      invoke: async () => ({ buffer: Buffer.alloc(0), mimeType: 'image/png' }) });
    expect(resolveProviderMediaModel(visible.providerId, visible.id, 'image.edit')).toEqual(visible);
    expect(listModels).toHaveBeenCalledExactlyOnceWith(['image.edit']);
    expect(listVideoModels).toHaveBeenCalledExactlyOnceWith(['image.edit']);
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
  it('Core discovers only video protocols it can execute, and distinguishes text-only from image input', () => {
    const video = { ...visible, id: 'private-video', mode: 'video_generation' as const, videoProtocol: 'xai-videos' as const, modalities: { input: ['text'], output: ['video'] } };
    const legacy = { ...video, id: 'legacy-video', videoProtocol: undefined };
    configureProviderMediaRuntime({ listModels: () => [visible], listVideoModels: () => [video, legacy], invoke: async () => ({ buffer: Buffer.alloc(0), mimeType: 'image/png' }) });
    expect(listProviderMediaModels().map(model => model.id)).toEqual([visible.id, video.id]);
    expect(resolveProviderMediaModel(video.providerId, video.id, 'video.generate')).toEqual(video);
    expect(resolveProviderMediaModel(video.providerId, video.id, 'video.image_to_video')).toBeNull();
  });

});
