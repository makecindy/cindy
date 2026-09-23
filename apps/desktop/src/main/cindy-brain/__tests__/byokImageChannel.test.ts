import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import { isOrganizationManagedProvider, type Provider } from '@cindy/model-providers';

import { createByokImageChannel, pruneDynamicImageChannels, registerByokImageChannels } from '../byokImageChannel.js';
import { ImageChannelRegistry, type ImageChannel } from '../imageChannelRegistry.js';

const PROVIDER_ID = 'byok-a';
const MODEL = 'byok-a/gpt-image-2';
const ORIGIN = 'https://gateway.example.invalid';

const okImageResponse = () =>
  new Response(JSON.stringify({ created: 1, data: [{ b64_json: 'aGk=' }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

function fetchMock() {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
    okImageResponse(),
  );
}

function orgProvider(
  imageModels?: Array<{
    id: string;
    name: string;
    modalities?: { input: string[]; output: string[] };
  }>,
) {
  return {
    id: PROVIDER_ID,
    name: 'Enterprise Draw',
    source: 'organization' as const,
    ...(imageModels ? { imageModels } : {}),
  };
}

function stubChannel(ready = true, supportsEdit = true): ImageChannel {
  return {
    ready: () => ready,
    supportsEdit,
    generateImage: vi.fn(async () => ({ data: [{ b64_json: 'aGk=' }] })),
    editImage: vi.fn(async () => ({ data: [{ b64_json: 'aGk=' }] })),
  };
}

describe('registerByokImageChannels', () => {
  it('registers an organization provider with imageModels and follows the live key', () => {
    const registry = new ImageChannelRegistry();
    const registered = new Set<string>();
    let key: string | null = 'member-key';
    registerByokImageChannels(
      registry,
      [orgProvider([{ id: MODEL, name: 'GPT Image 2' }])],
      registered,
      (provider) =>
        createByokImageChannel({
          brandLabel: provider.name,
          getApiKey: () => key,
          getBaseUrl: () => ORIGIN,
          getSupportsEdit: () => true,
        }),
    );
    expect(registered.has(PROVIDER_ID)).toBe(true);
    expect(registry.isProviderReady(PROVIDER_ID)).toBe(true);
    key = null;
    expect(registry.isProviderReady(PROVIDER_ID)).toBe(false);
  });

  it('skips chat-only organization providers, personal providers, and built-in image sources', () => {
    const registry = new ImageChannelRegistry();
    const registered = new Set<string>();
    registerByokImageChannels(
      registry,
      [
        orgProvider(),
        {
          id: 'mine',
          name: 'Personal',
          source: 'user',
          imageModels: [{ id: 'mine/gpt-image-2', name: 'Mine' }],
        },
        {
          id: 'openai',
          name: 'OpenAI',
          source: 'builtin',
          imageModels: [{ id: 'openai/gpt-image-2', name: 'GPT Image 2' }],
        },
        {
          id: 'xd',
          name: 'Cindy',
          source: 'builtin',
          imageModels: [{ id: 'gpt-image-2', name: 'GPT Image 2' }],
        },
      ],
      registered,
      () => stubChannel(),
    );
    expect(registered.size).toBe(0);
    expect(registry.isProviderReady(PROVIDER_ID)).toBe(false);
    expect(registry.isProviderReady('openai')).toBe(false);
    expect(registry.isProviderReady('xd')).toBe(false);
  });

  it('registers later if a chat-only provider grows imageModels, without duplicating', () => {
    const registry = new ImageChannelRegistry();
    const registered = new Set<string>();
    const createChannel = vi.fn(() => stubChannel());
    registerByokImageChannels(registry, [orgProvider()], registered, createChannel);
    expect(createChannel).not.toHaveBeenCalled();
    const withImages = orgProvider([{ id: MODEL, name: 'GPT Image 2' }]);
    registerByokImageChannels(registry, [withImages], registered, createChannel);
    registerByokImageChannels(registry, [withImages], registered, createChannel);
    expect(createChannel).toHaveBeenCalledTimes(1);
    expect(registry.isProviderReady(PROVIDER_ID)).toBe(true);
  });
});

describe('createByokImageChannel', () => {
  it('does not dispatch through a captured channel after its member key is revoked', async () => {
    const doFetch = fetchMock();
    let key: string | null = 'invalid-test-member-key';
    const channel = createByokImageChannel({
      getApiKey: () => key,
      getBaseUrl: () => ORIGIN,
      getSupportsEdit: () => true,
      fetchImplementation: doFetch as unknown as typeof fetch,
    });
    expect(channel.ready()).toBe(true);
    key = null;
    expect(channel.ready()).toBe(false);
    await expect(channel.generateImage({ model: MODEL, prompt: 'test' })).rejects.toThrow(/凭证未就绪/);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('posts the catalog alias to the live inference origin with the member key', async () => {
    const doFetch = fetchMock();
    let origin = ORIGIN;
    const channel = createByokImageChannel({
      brandLabel: 'Enterprise Draw',
      getApiKey: () => 'member-key',
      getBaseUrl: () => origin,
      getSupportsEdit: () => true,
      fetchImplementation: doFetch as unknown as typeof fetch,
    });
    expect(channel.imageProtocol).toBe('openai');
    await channel.generateImage({ model: MODEL, prompt: '一只猫', aspectRatio: '3:2' });
    expect(doFetch).toHaveBeenCalledTimes(1);
    const [url, init] = doFetch.mock.calls[0] ?? [];
    expect(url).toBe(`${ORIGIN}/v1/images/generations`);
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer member-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: MODEL,
      prompt: '一只猫',
      size: '1536x1024',
    });

    origin = 'https://gateway-rotated.example.invalid';
    await channel.generateImage({
      model: MODEL,
      prompt: '一只猫',
      size: '1024x1536',
      quality: 'high',
    });
    expect(doFetch.mock.calls[1]?.[0]).toBe(
      'https://gateway-rotated.example.invalid/v1/images/generations',
    );
    expect(JSON.parse(String(doFetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      size: '1024x1536',
      quality: 'high',
    });
  });

  it('rejects edit when the provider is generate-only and does not send a request', async () => {
    const doFetch = fetchMock();
    const channel = createByokImageChannel({
      getApiKey: () => 'member-key',
      getBaseUrl: () => ORIGIN,
      getSupportsEdit: () => false,
      fetchImplementation: doFetch as unknown as typeof fetch,
    });
    expect(channel.supportsEdit).toBe(false);
    await expect(
      channel.editImage({ model: MODEL, prompt: '改图', imagePaths: ['/tmp/x.png'] }),
    ).rejects.toThrow(/不支持改图/);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('is not ready without a member key or inference origin', () => {
    expect(
      createByokImageChannel({
        getApiKey: () => null,
        getBaseUrl: () => ORIGIN,
        getSupportsEdit: () => true,
      }).ready(),
    ).toBe(false);
    expect(
      createByokImageChannel({
        getApiKey: () => 'member-key',
        getBaseUrl: () => null,
        getSupportsEdit: () => true,
      }).ready(),
    ).toBe(false);
  });
});

describe('dynamic image channel lifecycle', () => {
  const enterprise: Provider = {
    ...orgProvider([{ id: MODEL, name: 'Enterprise image' }]),
    auth: { method: 'managed' }, agents: [], routing: {}, models: {},
  };
  const personal: Provider = {
    id: PROVIDER_ID, name: 'Personal Codex', source: 'user',
    auth: { method: 'oauth', native: 'codex' }, agents: ['codex'],
    routing: {}, models: {}, imageModels: [{ id: 'personal-image', name: 'Personal image' }],
  };

  function harness() {
    const registry = new ImageChannelRegistry();
    const registeredCodex = new Set<string>();
    const registeredByok = new Set<string>();
    const createEnterprise = vi.fn(() => stubChannel());
    const createPersonal = vi.fn(() => stubChannel());
    // Match the host order: remove both stale kinds before adding either kind.
    const refresh = (providers: Provider[]) => {
      pruneDynamicImageChannels(registry, providers, registeredCodex, registeredByok);
      for (const provider of providers) {
        if (isOrganizationManagedProvider(provider) || provider.auth.native !== 'codex' || registeredCodex.has(provider.id)) continue;
        registry.register(provider.id, createPersonal());
        registeredCodex.add(provider.id);
      }
      registerByokImageChannels(registry, providers, registeredByok, createEnterprise);
    };
    return { registry, registeredCodex, registeredByok, createEnterprise, createPersonal, refresh };
  }

  it.each(['enterprise-first', 'personal-first'] as const)('switches the same ID in both directions (%s)', (order) => {
    const h = harness();
    const sequence = order === 'enterprise-first'
      ? [enterprise, personal, enterprise]
      : [personal, enterprise, personal];
    for (const provider of sequence) {
      h.refresh([provider]);
      const managed = isOrganizationManagedProvider(provider);
      const factory = managed ? h.createEnterprise : h.createPersonal;
      expect(h.registry.resolve(PROVIDER_ID)).toBe(factory.mock.results.at(-1)?.value);
      expect(h.registeredByok.has(PROVIDER_ID)).toBe(managed);
      expect(h.registeredCodex.has(PROVIDER_ID)).toBe(!managed);
    }
    expect(h.createEnterprise.mock.calls.length + h.createPersonal.mock.calls.length).toBe(3);
  });

  it('removes image execution for chat-only providers and restores it when images return', () => {
    const h = harness();
    h.refresh([enterprise]);
    const previous = h.registry.resolve(PROVIDER_ID);
    h.refresh([{ ...enterprise, imageModels: [] }]);
    expect(h.registry.isProviderReady(PROVIDER_ID)).toBe(false);
    expect(h.registry.isProviderEditReady(PROVIDER_ID)).toBe(false);
    expect(h.registeredByok.has(PROVIDER_ID)).toBe(false);
    h.refresh([enterprise]);
    expect(h.registry.resolve(PROVIDER_ID)).not.toBe(previous);
    expect(h.createEnterprise).toHaveBeenCalledTimes(2);
  });

  it.each([enterprise, personal])('removes the $source channel on logout without disturbing static channels', (provider) => {
    const h = harness();
    const statics = new Map(['xd', 'openai', 'gemini', 'xai'].map((id) => [id, stubChannel()]));
    for (const [id, channel] of statics) h.registry.register(id, channel);
    h.refresh([provider]);
    h.refresh([]);
    expect(h.registeredByok.size).toBe(0);
    expect(h.registeredCodex.size).toBe(0);
    expect(h.registry.isProviderReady(PROVIDER_ID)).toBe(false);
    expect(() => h.registry.resolve(PROVIDER_ID)).toThrow(/没有可用的执行通道/);
    for (const [id, channel] of statics) expect(h.registry.resolve(id)).toBe(channel);
  });

  it.each([enterprise, personal])('keeps unchanged $source channels registered only once', (provider) => {
    const h = harness();
    h.refresh([provider]);
    const channel = h.registry.resolve(PROVIDER_ID);
    h.refresh([provider]);
    expect(h.registry.resolve(PROVIDER_ID)).toBe(channel);
    expect(h.createEnterprise.mock.calls.length + h.createPersonal.mock.calls.length).toBe(1);
    expect(() => h.registry.register(PROVIDER_ID, stubChannel())).toThrow(/already registered/);
  });
});

describe('Art BYOK image channel host wiring', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function getImageChannelRegistry()');
  const end = source.indexOf('\nfunction resolveImageChannelForModel', start);
  const body = source.slice(start, end);

  it('registers a live BYOK channel without reusing xd/openai/gemini/xai', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain('registerByokImageChannels');
    expect(body).toContain("readByokCredential(providerId, 'image')");
    expect(body).toContain('readByokInferenceBase(providerId)');
    expect(body).toContain("registry.register('xd'");
    expect(body).toContain("registry.register('openai'");
    expect(body).toMatch(/registry\.register\(\s*'gemini'/);
    expect(body).toMatch(/registry\.register\(\s*'xai'/);
    expect(body).not.toContain('stripByok');
    expect(body).not.toContain("startsWith('byok-') ? id.slice");
  });

  it('keeps dynamic BYOK registration on singleton refreshes', () => {
    expect(body).toContain('registeredByokImageAccounts');
    expect(body).toMatch(
      /imageChannelRegistrySingleton = registry;[\s\S]*registerByokImageChannels/,
    );
  });

  it('prunes stale accounts before either dynamic registration loop runs', () => {
    const prune = body.indexOf('pruneDynamicImageChannels(');
    expect(prune).toBeGreaterThan(body.indexOf('imageChannelRegistrySingleton = registry;'));
    expect(prune).toBeLessThan(body.indexOf('imageChannelRegistrySingleton.register(providerId'));
    expect(prune).toBeLessThan(body.indexOf('registerByokImageChannels('));
  });
});
