import { describe, expect, it, vi } from 'vitest';
import {
  configureProviderMediaRuntime,
  listProviderMediaModels,
  listReadyProviderMediaModels,
  resolveProviderMediaModel,
  resolveProviderVideoConnection,
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
  // Unit, #4577490768: the public port must retain the selected owner; Core's
  // lifecycle harness substitutes this port, so it cannot catch a dropped argument.
  it('passes a selected video runtime to the configured connection resolver', async () => {
    const connection = { baseUrl: 'https://pi.example.invalid/v1', headers: {}, revision: 'pi-1', assertCurrent: vi.fn() };
    const resolveVideoConnection = vi.fn((_provider: string, _model: string, agent?: string) => agent === 'pi' ? connection : null);
    configureProviderMediaRuntime({ listModels: () => [], resolveVideoConnection,
      invoke: async () => ({ buffer: Buffer.alloc(0), mimeType: 'video/mp4' }) });
    expect(await resolveProviderVideoConnection('relay', 'video-model', 'pi')).toBe(connection);
    expect(resolveVideoConnection).toHaveBeenCalledExactlyOnceWith('relay', 'video-model', 'pi');
  });

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
