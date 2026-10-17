import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildUserProvider, type Provider } from '@cindy/model-providers';
import { createCustomImageChannel, registerCustomImageChannels } from '../customImageChannel.js';
import { pruneDynamicImageChannels } from '../byokImageChannel.js';
import { ImageChannelRegistry } from '../imageChannelRegistry.js';

const MODEL = 'team/gpt-image-2.5-sunburst';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })),
  );
});

function provider(baseUrl = 'https://relay.example.invalid/proxy/v1'): Provider {
  return buildUserProvider({
    id: 'relay',
    name: 'My relay',
    auth: { method: 'apiKey' },
    runtimes: {
      pi: {
        baseUrl,
        wireProtocol: 'openai-chat',
        imageApi: 'openai-images',
        headers: { 'X-Team': 'drawing', 'Content-Type': 'wrong', Authorization: 'wrong-key' },
        models: [
          {
            id: MODEL,
            name: 'My image',
            mode: 'image_generation',
            modalities: { input: ['text', 'image'], output: ['image'] },
          },
        ],
      },
      codex: { baseUrl: 'https://other.example.invalid/v1', models: [] },
    },
  });
}

function harness(initial = provider()) {
  let current: Provider | undefined = initial;
  let owner = 'owner-a:1';
  let pending = false;
  let key: string | null = 'invalid-test-pi-key';
  const readApiKey = vi.fn((agent) => (agent === 'pi' ? key : 'invalid-test-other-key'));
  const fetchImplementation = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), {
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  const beforeDispatch = vi.fn();
  const channel = createCustomImageChannel({
    getProvider: () => current,
    readApiKey,
    getOwnerScopeKey: () => owner,
    isOwnerBoundaryPending: () => pending,
    fetchImplementation,
    beforeDispatch,
  });
  return {
    channel,
    readApiKey,
    fetchImplementation,
    beforeDispatch,
    setProvider: (value: Provider | undefined) => {
      current = value;
    },
    setKey: (value: string | null) => {
      key = value;
    },
    setOwner: (value: string) => {
      owner = value;
    },
    setPending: (value: boolean) => {
      pending = value;
    },
  };
}

describe('standalone custom OpenAI Images', () => {
  it('keeps URL-capable custom sources in Core but out of the legacy image channel', () => {
    const h = harness();
    const registry = new ImageChannelRegistry();
    registry.register('relay', h.channel);
    registry.register('existing', { ready: () => true, generateImage: vi.fn(), editImage: vi.fn() });
    expect(registry.isProviderLegacyReady('relay', MODEL)).toBe(false);
    expect(registry.isProviderLegacyReady('existing', MODEL)).toBe(true);
    expect(registry.isProviderReady('relay', MODEL)).toBe(true);
    expect(h.fetchImplementation).not.toHaveBeenCalled();
  });

  it.each(['claude-code', 'codex'] as const)('binds duplicate model IDs to the explicitly enabled Images connection, not %s', async (agent) => {
    const source = buildUserProvider({
      id: 'relay', name: 'Relay', auth: { method: 'apiKey' },
      runtimes: {
        [agent]: { baseUrl: 'https://chat.example.invalid/v1', models: [{ id: MODEL, name: 'Chat copy', mode: 'image_generation' }] },
        pi: { baseUrl: 'https://images.example.invalid/v1', imageApi: 'openai-images', models: [{ id: MODEL, name: 'Image', mode: 'image_generation' }] },
      },
    });
    const h = harness(source);
    expect(source.imageModels?.[0]?.sourceAgent).toBe('pi');
    expect(h.channel.isModelReady?.(MODEL)).toBe(true);
    await h.channel.generateImage({ model: MODEL, prompt: 'red circle' });
    expect(h.fetchImplementation.mock.calls[0]?.[0]).toBe('https://images.example.invalid/v1/images/generations');
    expect(h.readApiKey).not.toHaveBeenCalledWith(agent);
  });

  it('does not choose credentials when multiple Images connections declare the same model', () => {
    const source = buildUserProvider({
      id: 'relay', name: 'Relay', auth: { method: 'apiKey' },
      runtimes: Object.fromEntries(['pi', 'codex'].map(agent => [agent, {
        baseUrl: `https://${agent}.example.invalid/v1`, imageApi: 'openai-images',
        models: [{ id: MODEL, name: 'Image', mode: 'image_generation' }],
      }])),
    });
    const h = harness(source);
    expect(h.channel.isModelReady?.(MODEL)).toBe(false);
    expect(h.readApiKey).not.toHaveBeenCalled();
  });

  it('bounds custom response bytes before JSON parsing', async () => {
    const h = harness();
    const cancel = vi.fn();
    h.fetchImplementation.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)); },
      cancel,
    })));
    await expect(h.channel.generateImage({ model: MODEL, prompt: 'circle' })).rejects.toThrow(/response.*limit/i);
    expect(cancel).toHaveBeenCalledOnce();
    expect(h.fetchImplementation).toHaveBeenCalledOnce();
  });

  it.each([
    ['https://relay.example.invalid', 'https://relay.example.invalid/v1/images/generations'],
    ['https://relay.example.invalid/v1/', 'https://relay.example.invalid/v1/images/generations'],
    ['http://127.0.0.1:8080/sub2api/v1', 'http://127.0.0.1:8080/sub2api/v1/images/generations'],
  ])('uses the configured endpoint %s, model and source runtime key', async (baseUrl, target) => {
    const h = harness(provider(baseUrl));
    expect(h.channel.ready()).toBe(true);
    await h.channel.generateImage({
      model: MODEL,
      prompt: 'red circle',
      size: '1024x1024',
      quality: 'high',
    });
    const [url, init] = h.fetchImplementation.mock.calls[0]!;
    expect(url).toBe(target);
    expect(init?.headers).toEqual({
      'x-team': 'drawing',
      authorization: 'Bearer invalid-test-pi-key',
      'Content-Type': 'application/json',
    });
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: MODEL,
      prompt: 'red circle',
      size: '1024x1024',
      quality: 'high',
    });
    expect(h.readApiKey).not.toHaveBeenCalledWith('codex');
    expect(h.beforeDispatch).toHaveBeenCalledWith(MODEL);
  });

  it('sends edits as multipart to the same source, retaining size, quality and reference bytes', async () => {
    const h = harness();
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-custom-images-'));
    folders.push(folder);
    const imagePath = path.join(folder, 'reference.png');
    await fs.writeFile(imagePath, PNG);
    await h.channel.editImage({
      model: MODEL,
      prompt: 'blue circle',
      imagePaths: [imagePath],
      aspectRatio: '3:2',
      quality: 'max',
    });
    const [url, init] = h.fetchImplementation.mock.calls[0]!;
    expect(url).toBe('https://relay.example.invalid/proxy/v1/images/edits');
    expect(init?.headers).not.toHaveProperty('Content-Type');
    const form = init?.body as FormData;
    expect(form.get('model')).toBe(MODEL);
    expect(form.get('size')).toBe('1536x1024');
    expect(form.get('quality')).toBe('max');
    expect(Buffer.from(await (form.get('image[]') as Blob).arrayBuffer())).toEqual(PNG);
  });

  it('does not infer an Images API from chat compatibility or a model name', () => {
    const source = provider();
    delete source.routing.pi!.imageApi;
    const h = harness(source);
    expect(h.channel.ready()).toBe(false);
  });

  it('does not borrow another runtime when the model owner has no key or API declaration', async () => {
    const h = harness();
    h.setKey(null);
    expect(h.channel.ready()).toBe(false);
    await expect(h.channel.generateImage({ model: MODEL, prompt: 'circle' })).rejects.toThrow(
      /未就绪/,
    );
    expect(h.fetchImplementation).not.toHaveBeenCalled();
    expect(h.readApiKey).not.toHaveBeenCalledWith('codex');
  });

  it('filters unsupported models within a ready provider and rejects their dispatch', async () => {
    const source = provider();
    source.imageModels!.push({ id: 'other-image', name: 'Other', sourceAgent: 'codex' });
    const h = harness(source);
    const registry = new ImageChannelRegistry();
    registry.register(source.id, h.channel);
    expect(registry.isProviderReady(source.id)).toBe(true);
    expect(registry.isProviderReady(source.id, MODEL)).toBe(true);
    expect(registry.isProviderReady(source.id, 'other-image')).toBe(false);
    expect(registry.isProviderEditReady(source.id, 'other-image')).toBe(false);
    expect(() => registry.resolve(source.id, 'other-image')).toThrow(/未就绪/);
    await expect(
      h.channel.generateImage({ model: 'other-image', prompt: 'circle' }),
    ).rejects.toThrow(/未就绪/);
  });

  it('uses updated configuration on the next call and releases revoked or removed connections', async () => {
    const h = harness();
    await h.channel.generateImage({ model: MODEL, prompt: 'circle' });
    h.setProvider(provider('https://changed.example.invalid/v1'));
    h.setKey('invalid-test-rotated-key');
    await h.channel.generateImage({ model: MODEL, prompt: 'circle' });
    expect(h.fetchImplementation.mock.calls[1]?.[0]).toBe(
      'https://changed.example.invalid/v1/images/generations',
    );
    expect(h.fetchImplementation.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer invalid-test-rotated-key',
    });
    h.setProvider(undefined);
    expect(h.channel.ready()).toBe(false);
    await expect(h.channel.generateImage({ model: MODEL, prompt: 'circle' })).rejects.toThrow(
      /未就绪/,
    );
    expect(h.fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('rejects a changed endpoint/key in the await before paid dispatch', async () => {
    const h = harness();
    const request = h.channel.generateImage({ model: MODEL, prompt: 'circle' });
    h.setKey('invalid-test-replaced-key');
    await expect(request).rejects.toThrow(/配置已变化/);
    expect(h.fetchImplementation).not.toHaveBeenCalled();
  });

  it('rejects results after an owner switch and hides sources during the boundary', async () => {
    const h = harness();
    h.fetchImplementation.mockImplementation(async () => {
      h.setOwner('owner-b:2');
      return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
    });
    await expect(h.channel.generateImage({ model: MODEL, prompt: 'circle' })).rejects.toThrow(
      /账号已切换/,
    );
    h.setPending(true);
    expect(h.channel.ready()).toBe(false);
  });

  it('supports explicitly unauthenticated loopback services without leaking chat auth headers', async () => {
    const source = provider('http://127.0.0.1:8080/v1');
    source.auth = { method: 'none' };
    source.routing.pi!.authStrategy = 'none';
    const h = harness(source);
    await h.channel.generateImage({ model: MODEL, prompt: 'circle' });
    expect(h.readApiKey).not.toHaveBeenCalled();
    expect(h.fetchImplementation.mock.calls[0]?.[1]?.headers).toEqual({
      'x-team': 'drawing',
      'Content-Type': 'application/json',
    });
    source.routing.pi!.upstream = 'https://remote.example.invalid/v1';
    expect(h.channel.ready()).toBe(false);
  });

  it('never switches sources or retries an upstream rejection', async () => {
    const h = harness();
    h.fetchImplementation.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: 'model access denied', code: 'permission_denied' },
        }),
        { status: 403 },
      ),
    );
    await expect(h.channel.generateImage({ model: MODEL, prompt: 'circle' })).rejects.toThrow(
      /HTTP 403/,
    );
    expect(h.fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('prunes a custom channel before a reused ID becomes a native subscription', () => {
    const source = provider();
    const h = harness(source);
    const registry = new ImageChannelRegistry();
    const registered = new Set<string>();
    registerCustomImageChannels(registry, [source], registered, () => h.channel);
    registerCustomImageChannels(registry, [source], registered, () => {
      throw new Error('duplicate');
    });
    expect(registry.resolve(source.id, MODEL)).toBe(h.channel);
    const native = { ...source, auth: { method: 'oauth' as const, native: 'codex' as const } };
    pruneDynamicImageChannels(registry, [native], new Set(), new Set(), registered);
    expect(registry.hasProvider(source.id)).toBe(false);
    expect(registered.size).toBe(0);
    registerCustomImageChannels(registry, [native], registered, () => h.channel);
    expect(registry.hasProvider(source.id)).toBe(false);
  });
});
