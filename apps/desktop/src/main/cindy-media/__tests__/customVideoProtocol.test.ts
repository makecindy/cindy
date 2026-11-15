import { describe, expect, it } from 'vitest';
import { buildUserProvider } from '@cindy/model-providers';
import { resolveCustomMediaConnection } from '../../cindy-brain/customMediaConnection.js';
import { validateCustomVideoBody, videoConnectionRevision } from '../customVideoProtocol.js';
import { parsePreparedMediaInvocationGuide } from '../../../shared/mediaInvocation.js';

const model = { id: 'private-video', name: 'Video', providerId: 'relay', mode: 'video_generation' as const, modalities: { input: ['text', 'image'], output: ['video'] } };

describe('custom xAI Videos protocol', () => {
  // /v1/videos 回归：标准图片输入在付费边界不得被当作未知字段；原测试只有 MiniMax content。
  // unit，最小输入为 prompt + 一条受管图片引用；仍拒绝非图片、超量、混合格式和文生视频引用。
  it('validates relay input_reference as one or two images without MiniMax content', () => {
    const ref = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    for (const input_reference of [ref, [ref, 'https://images.example/last.png']]) {
      expect(() => validateCustomVideoBody({ prompt: 'move', input_reference }, true, 'openai-videos')).not.toThrow();
    }
    for (const input_reference of [[], [ref, ref, ref], 'file:///private/file', 'data:video/mp4;base64,AA==']) {
      expect(() => validateCustomVideoBody({ prompt: 'move', input_reference }, true, 'openai-videos')).toThrow();
    }
    expect(() => validateCustomVideoBody({ prompt: 'move', input_reference: ref, content: [] }, true, 'openai-videos')).toThrow();
    expect(() => validateCustomVideoBody({ prompt: 'move', input_reference: ref }, false, 'openai-videos')).toThrow();
  });

  it.each([
    ['minimax-videos', 'https://video.example/v1', 'https://video.example'],
    ['minimax-videos', 'https://video.example/prefix/v1', 'https://video.example/prefix'],
    ['openai-videos', 'https://video.example/v1', 'https://video.example/v1'],
  ] as const)('resolves the declared %s connection without borrowing the chat route', (videoApi, baseUrl, expected) => {
    const provider = buildUserProvider({ id: 'relay', name: 'Relay', runtimes: {
      pi: { baseUrl, wireProtocol: 'openai-chat', videoApi, models: [{ ...model }] },
    } });
    expect(resolveCustomMediaConnection({ getProvider: () => provider, readApiKey: () => 'test-key',
      isOwnerBoundaryPending: () => false }, model.id, 'video')).toMatchObject({ baseUrl: expected, videoApi });
  });

  it('changing the explicit video API invalidates the connection while old xAI digests remain compatible', () => {
    const binding = { agent: 'pi' as const, baseUrl: 'https://video.example/v1', headers: { authorization: 'Bearer test-key' } };
    const original = videoConnectionRevision('relay', model.id, binding);
    expect(videoConnectionRevision('relay', model.id, { ...binding, videoApi: 'xai-videos' })).toBe(original);
    expect(videoConnectionRevision('relay', model.id, { ...binding, videoApi: 'openai-videos' })).not.toBe(original);
  });

  it('restores a legacy paid task and its original connection digest without a credential', () => {
    const legacySnapshot = {
      schemaVersion: 1, guideId: 'cindy-provider-xai-video-v1', revision: '1:opaque-binding',
      modelId: model.id, connection: { providerId: 'relay' }, capability: 'video.generate',
      request: { method: 'POST', path: '/videos/generations', bodyModelPath: ['model'], timeoutMs: 120_000, maxRequestBytes: 70 * 1024 * 1024, maxResponseBytes: 1024 * 1024 },
      response: { mode: 'async', taskIdPath: ['request_id'], poll: {
        method: 'GET', path: '/videos/{taskId}', statusPath: ['status'],
        successValues: ['done'], failureValues: ['failed', 'expired'],
        recommendedIntervalMs: 5_000, timeoutMs: 30_000, maxResponseBytes: 1024 * 1024,
        media: [{ path: ['video', 'url'], encoding: 'url', kind: 'video', allowedUrlHosts: ['vidgen.x.ai'] }],
      } },
      instructions: '轮询原任务', exampleBody: { prompt: 'cat' }, inputSchema: { type: 'object' },
      officialDocs: 'https://docs.x.ai/developers/model-capabilities/video/generation',
    };
    expect(parsePreparedMediaInvocationGuide(JSON.parse(JSON.stringify(legacySnapshot)))).toMatchObject({
      ok: true, value: {
        revision: '1:opaque-binding',
        binding: { providerId: 'relay', executor: 'provider-video', connectionRevision: '1:opaque-binding' },
      },
    });
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
