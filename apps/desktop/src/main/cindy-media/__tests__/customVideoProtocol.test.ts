import { describe, expect, it } from 'vitest';
import { buildUserProvider } from '@cindy/model-providers';
import { resolveCustomMediaConnection } from '../../cindy-brain/customMediaConnection.js';
import { customVideoGuide, validateCustomVideoBody, videoConnectionRevision } from '../customVideoProtocol.js';
import { parsePreparedMediaInvocationGuide } from '../../../shared/mediaInvocation.js';

const model = { id: 'private-video', name: 'Video', providerId: 'relay', mode: 'video_generation' as const, modalities: { input: ['text', 'image'], output: ['video'] } };

describe('custom xAI Videos protocol', () => {
  it.each(['video.generate', 'video.image_to_video'] as const)('persists and restores %s without a credential', capability => {
    const guide = customVideoGuide(model, capability, '1:opaque-binding');
    expect(parsePreparedMediaInvocationGuide(JSON.parse(JSON.stringify(guide)))).toMatchObject({ ok: true });
    expect(guide.inputSchema.required).toEqual(capability === 'video.generate' ? ['prompt'] : ['prompt', 'image']);
    expect(guide.response.mode).toBe('async');
  });

  it.each(['https://video.example/v1', 'https://router.requesty.ai/v1'])
  ('uses only the explicit video source at %s with its application headers', baseUrl => {
    const provider = buildUserProvider({ id: 'relay', name: 'Relay', runtimes: {
      'claude-code': { baseUrl: 'https://chat.example/v1', models: [{ ...model }] },
      pi: { baseUrl, wireProtocol: 'openai-chat', videoApi: 'xai-videos', models: [{ ...model }] },
    } });
    expect(provider.videoModels?.[0]?.sourceAgent).toBe('pi');
    const options = { getProvider: () => provider, readApiKey: (agent: string) => agent === 'pi' ? 'test-video-key' : 'test-chat-key', isOwnerBoundaryPending: () => false };
    const connection = resolveCustomMediaConnection(options, model.id, 'video');
    expect(connection).toMatchObject({ agent: 'pi', baseUrl, headers: { authorization: 'Bearer test-video-key' } });
    expect(connection?.headers['http-referer']).toBe(baseUrl.includes('requesty.ai') ? 'https://cindy.app' : undefined);
    expect(connection?.headers['x-title']).toBe(baseUrl.includes('requesty.ai') ? 'Cindy' : undefined);
    expect(resolveCustomMediaConnection({ ...options, readApiKey: () => null }, model.id, 'video')).toBeNull();
    provider.routing.pi!.videoApi = undefined;
    expect(resolveCustomMediaConnection(options, model.id, 'video')).toBeNull();
  });

  it('fails closed for duplicate explicit owners and cross-origin model overrides', () => {
    const runtime = { baseUrl: 'https://video.example/v1', videoApi: 'xai-videos' as const, models: [{ ...model }] };
    const provider = buildUserProvider({ id: 'relay', name: 'Relay', runtimes: { codex: runtime, pi: { ...runtime, wireProtocol: 'openai-chat' } } });
    const options = { getProvider: () => provider, readApiKey: () => 'test-key', isOwnerBoundaryPending: () => false };
    expect(provider.videoModels?.[0]?.sourceAgent).toBeUndefined();
    expect(resolveCustomMediaConnection(options, model.id, 'video')).toBeNull();
    provider.videoModels![0]!.sourceAgent = 'pi';
    provider.models.pi![0]!.route = { baseUrl: 'https://other.example/v1', wireProtocol: 'openai-chat' };
    expect(resolveCustomMediaConnection(options, model.id, 'video')).toBeNull();
  });

  it('binds address, credential, source, and headers across restart without storing the key', () => {
    const binding = { agent: 'pi' as const, baseUrl: 'https://video.example/v1', headers: { authorization: 'Bearer test-secret', custom: 'a' } };
    const revision = videoConnectionRevision('relay', model.id, binding);
    expect(revision).not.toContain('test-secret');
    expect(videoConnectionRevision('relay', model.id, JSON.parse(JSON.stringify(binding)))).toBe(revision);
    for (const changed of [
      { ...binding, agent: 'codex' as const },
      { ...binding, baseUrl: 'https://other.example/v1' },
      { ...binding, headers: { ...binding.headers, authorization: 'Bearer different-test-key' } },
      { ...binding, headers: { ...binding.headers, custom: 'b' } },
    ]) expect(videoConnectionRevision('relay', model.id, changed)).not.toBe(revision);
  });

  it.each([{ fps: 30 }, { audio: false }, { duration: 16 }, { duration: 1.5 }, { resolution: '4k' }, { resolution: ['480p'] }, { aspect_ratio: ['16:9'] }, { image: { url: 'https://example.com/p.png' } }])('rejects unsupported generation parameters before payment: %j', extra => {
    expect(() => validateCustomVideoBody({ prompt: 'cat', ...extra }, false)).toThrow();
  });
  it('requires exactly one image and leaves implicit aspect ratio to the upstream', () => {
    const body = { prompt: 'move gently', image: { url: `cindy-media://blobs/${'a'.repeat(64)}.png` } };
    expect(() => validateCustomVideoBody(body, true)).not.toThrow();
    expect(body).not.toHaveProperty('aspect_ratio');
    for (const image of [undefined, [], { url: 'file:///private/file' }, { url: 'data:video/mp4;base64,AA==' }, { url: 'https://example.com/p.png', last_frame: 'other' }]) {
      expect(() => validateCustomVideoBody({ prompt: 'cat', image }, true)).toThrow();
    }
  });
});
