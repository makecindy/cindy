import { describe, expect, it } from 'vitest';
import { buildUserProvider } from '@cindy/model-providers';
import { resolveCustomMediaConnection } from '../../cindy-brain/customMediaConnection.js';
import { customVideoGuide, minimaxVideoGuide, openaiVideoGuide, validateCustomVideoBody, validateMinimaxVideoBody, validateOpenaiVideoBody, videoConnectionRevision } from '../customVideoProtocol.js';
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

  // MiniMax V2 paths are /v2/... at the API root; keeping the chat route's /v1 would send /v1/v2/...
  // The relay /v1/videos API stays under /v1.
  it.each([
    ['minimax-videos', 'https://api.tu-zi.com/v1', 'https://api.tu-zi.com'],
    ['minimax-videos', 'https://api.minimax.io', 'https://api.minimax.io'],
    ['minimax-videos', 'https://gw.example/minimax/v1', 'https://gw.example/minimax'],
    ['openai-videos', 'https://api.tu-zi.com/v1', 'https://api.tu-zi.com/v1'],
  ] as const)('roots the %s connection for %s at %s', (videoApi, baseUrl, expected) => {
    const provider = buildUserProvider({ id: 'relay', name: 'Relay', runtimes: {
      pi: { baseUrl, wireProtocol: 'openai-chat', videoApi, models: [{ ...model }] },
    } });
    const options = { getProvider: () => provider, readApiKey: () => 'test-video-key', isOwnerBoundaryPending: () => false };
    expect(resolveCustomMediaConnection(options, model.id, 'video')).toMatchObject({ agent: 'pi', baseUrl: expected, videoApi });
  });

  it.each(['video.generate', 'video.image_to_video'] as const)('persists the MiniMax %s guide without a credential', capability => {
    const guide = minimaxVideoGuide(model, capability, '1:opaque-binding');
    expect(parsePreparedMediaInvocationGuide(JSON.parse(JSON.stringify(guide)))).toMatchObject({ ok: true });
    expect(guide.request.path).toBe('/v2/video_generation');
  });

  const text = { type: 'text', text: 'cat' };
  const frame = (role?: string) => ({ type: 'image_url', image_url: { url: `cindy-media://blobs/${'a'.repeat(64)}.png` }, ...(role ? { role } : {}) });
  const t2v = { content: [text], resolution: '768P', duration: 6, ratio: '16:9' };
  const i2v = { content: [text, frame()], resolution: '2K', duration: 4 };
  it.each([
    ['unknown field', { ...t2v, seed: 1 }, false],
    ['missing resolution', { ...t2v, resolution: undefined }, false],
    ['duration below 4', { ...t2v, duration: 3 }, false],
    ['missing text-to-video ratio', { ...t2v, ratio: undefined }, false],
    ['adaptive text-to-video ratio', { ...t2v, ratio: 'adaptive' }, false],
    ['two prompts', { ...t2v, content: [text, text] }, false],
    ['image in text-to-video', { ...t2v, content: [text, frame()] }, false],
    ['no frame', { ...i2v, content: [text] }, true],
    ['reference image', { ...i2v, content: [text, frame('reference_image')] }, true],
    ['two first frames', { ...i2v, content: [text, frame(), frame('first_frame')] }, true],
    ['local file reference', { ...i2v, content: [text, { type: 'image_url', image_url: { url: 'file:///private/file' } }] }, true],
  ] as const)('rejects a MiniMax body with %s before payment', (_name, body, image) => {
    expect(() => validateMinimaxVideoBody(JSON.parse(JSON.stringify(body)), image)).toThrow();
  });
  it('accepts MiniMax text-to-video and first plus last frame bodies', () => {
    expect(() => validateMinimaxVideoBody(t2v, false)).not.toThrow();
    expect(() => validateMinimaxVideoBody({ ...i2v, content: [text, frame('first_frame'), frame('last_frame')], ratio: 'adaptive' }, true)).not.toThrow();
  });

  // Relay /v1/videos (tu-zi style). Result hosts trust only the configured relay; an IP relay asks for every download.
  it.each([
    ['https://api.tu-zi.com/v1', ['api.tu-zi.com']],
    ['http://127.0.0.1:3000/v1', ['example.invalid']],
  ])('persists the relay /v1/videos guide for %s', (baseUrl, hosts) => {
    for (const capability of ['video.generate', 'video.image_to_video'] as const) {
      const guide = openaiVideoGuide(model, capability, '1:opaque-binding', baseUrl);
      expect(parsePreparedMediaInvocationGuide(JSON.parse(JSON.stringify(guide)))).toMatchObject({ ok: true });
      expect(guide.response.mode === 'async' && guide.response.poll.media.map(item => item.allowedUrlHosts)).toEqual([hosts, hosts]);
    }
  });

  // The body tu-zi documents for MiniMax-H3 on /v1/videos (model is injected by Cindy).
  const tuzi = { content: [{ text: '一个男孩在海边打篮球', type: 'text' }], duration: 5, ratio: '16:9', resolution: '768P', prompt: '一个男孩在海边打篮球', seconds: '8', size: '1280x720', watermark: false };
  it.each([
    ['unknown field', { ...tuzi, input_reference: 'https://example.com/a.png' }, false],
    ['missing prompt', { ...tuzi, prompt: '' }, false],
    ['numeric seconds', { ...tuzi, seconds: 8 }, false],
    ['adaptive text-to-video ratio', { ...tuzi, ratio: 'adaptive' }, false],
    ['string watermark', { ...tuzi, watermark: 'no' }, false],
    ['image in text-to-video content', { ...tuzi, content: [text, frame()] }, false],
    ['image-to-video without frames', { prompt: 'cat' }, true],
    ['reference image', { prompt: 'cat', content: [text, frame('reference_image')] }, true],
  ] as const)('rejects a relay /v1/videos body with %s before payment', (_name, body, image) => {
    expect(() => validateOpenaiVideoBody(JSON.parse(JSON.stringify(body)), image)).toThrow();
  });
  it('accepts the tu-zi text-to-video body, a minimal prompt, and first-frame image-to-video', () => {
    expect(() => validateOpenaiVideoBody(tuzi, false)).not.toThrow();
    expect(() => validateOpenaiVideoBody({ prompt: 'cat' }, false)).not.toThrow();
    expect(() => validateOpenaiVideoBody({ prompt: 'cat', content: [text, frame('first_frame')], ratio: 'adaptive' }, true)).not.toThrow();
  });
});
