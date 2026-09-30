import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ByokProvidersResponse } from '@cindy/model-providers';
const state = vi.hoisted(() => ({
  reader: null as null | ((id: string, agent: string) => string | null),
  endpointReader: null as null | ((id: string) => string | null),
  managedProviderReader: null as null | ((id: string) => boolean),
  publish: vi.fn(),
  fetch: vi.fn(),
  gate: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../../maker-host/active-catalog.js', () => ({ setManagedProviders: state.publish }));
vi.mock('../../maker-host/provider-route.js', () => ({
  beginProviderRouteMutation: state.gate,
}));
vi.mock('../byokCredentials.js', () => ({
  setByokCredentialReader: (reader: NonNullable<typeof state.reader>) => {
    state.reader = reader;
  },
  setByokEndpointReader: (reader: NonNullable<typeof state.endpointReader>) => {
    state.endpointReader = reader;
  },
  setByokManagedProviderReader: (reader: NonNullable<typeof state.managedProviderReader>) => {
    state.managedProviderReader = reader;
  },
}));
vi.mock('../../serverApiClient.js', () => ({ serverApiFetch: state.fetch }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ debug: state.debug, warn: vi.fn() }) }));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: () => 'https://api.example.invalid',
}));
import { createByokRuntime } from '../byokRuntime.js';
import { getByokPricing, setByokPricing } from '../byokPricing.js';
const provider = {
  id: 'byok-a',
  name: 'Enterprise',
  connectionRevision: 1,
  models: [
    {
      id: 'byok/a/chat',
      name: 'Chat',
      agents: ['pi'],
      mode: 'chat',
      currency: 'CNY',
      contextWindow: 128000,
      efforts: ['low', 'high'],
      defaultEffort: 'low',
      perAgent: { pi: { wireProtocol: 'openai-completions', defaultEffort: 'high' } },
    },
  ],
};
const directory = {
  schemaVersion: 1,
  organizationId: 'org-a',
  revision: '1',
  providers: [provider],
};
const credentials = {
  schemaVersion: 1,
  organizationId: 'org-a',
  credentials: [
    {
      providerId: 'byok-a',
      connectionRevision: 1,
      status: 'ready',
      endpoint: 'https://gateway.example.invalid/v1',
      apiKey: 'invalid-test-key',
    },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  setByokPricing({});
  state.gate.mockImplementation(() => Object.assign(vi.fn(), { commit: vi.fn() }));
});
describe('BYOK Main runtime', () => {
  it('labels both sync requests and logs success without credentials', async () => {
    const runtime = createByokRuntime();
    runtime.setOwner({ scope: 'a:cn:1', organizationId: 'org-a' });
    state.fetch.mockResolvedValueOnce(directory).mockResolvedValueOnce(credentials);
    await runtime.sync();
    for (const [index, endpoint] of ['providers', 'credentials'].entries()) {
      const path = `/api/model-access/byok/${endpoint}`;
      expect(state.fetch).toHaveBeenNthCalledWith(index + 1, `${path}?schemaVersion=1`, expect.objectContaining({
        logLabel: path,
        redactErrorDetails: true,
        allowedRedactedErrorCodes: expect.arrayContaining(['ORG_AI_GATEWAY_ERROR', 'BYOK_UNAVAILABLE']),
      }));
      expect(state.debug).toHaveBeenCalledWith('byok.sync.request_succeeded', `path=${path}`, expect.stringMatching(/^elapsedMs=\d+$/));
    }
    expect(runtime.getStatus().state).toBe('ready');
    const logged = JSON.stringify(state.debug.mock.calls);
    expect(logged).not.toContain('invalid-test-key');
    expect(logged).not.toContain('org-a');
    expect(logged).not.toContain('gateway.example.invalid');
  });
  it.each([
    'https://gateway.example.invalid',
    'https://gateway.example.invalid/v1',
    'https://gateway.example.invalid/v1/',
  ])('normalizes the three SDK paths from %s', async (endpoint) => {
    const runtime = createByokRuntime();
    runtime.setOwner({ scope: 'a:cn:1', organizationId: 'org-a' });
    const next = structuredClone(directory);
    Object.assign(next.providers[0].models[0], {
      nativeApi: 'openai-completions',
      agents: ['pi', 'codex', 'claude-code'],
      perAgent: {
        pi: { wireProtocol: 'openai-completions' },
        codex: { wireProtocol: 'openai-responses' },
        'claude-code': { wireProtocol: 'anthropic-messages' },
      },
    });
    const connection = structuredClone(credentials);
    connection.credentials[0].endpoint = endpoint;
    state.fetch.mockResolvedValueOnce(next).mockResolvedValueOnce(connection);
    await runtime.sync();
    const projected = state.publish.mock.lastCall?.[0][0];
    expect(projected.routing['claude-code'].upstream).toBe('https://gateway.example.invalid');
    expect(projected.routing.codex.upstream).toBe('https://gateway.example.invalid/v1');
    expect(projected.models.pi[0].nativeApi).toBe('openai-completions');
  });
  it('only offers Pi reasoning levels which its runtime can execute', async () => {
    const runtime = createByokRuntime();
    runtime.setOwner({ scope: 'a:cn:1', organizationId: 'org-a' });
    const next = structuredClone(directory);
    Object.assign(next.providers[0].models[0], {
      efforts: ['high', 'ultra'],
      defaultEffort: 'ultra',
    });
    Object.assign(next.providers[0].models[0].perAgent.pi, { defaultEffort: 'ultra' });
    state.fetch.mockResolvedValueOnce(next).mockResolvedValueOnce(credentials);
    await runtime.sync();
    expect(state.publish.mock.lastCall?.[0][0].models.pi[0]).toMatchObject({
      efforts: ['high'],
      defaultEffort: null,
    });
  });
  it('publishes no secrets, reuses the route shape and clears keys on owner change', async () => {
    const notify = vi.fn();
    const runtime = createByokRuntime(notify);
    runtime.setOwner({ scope: 'a:cn:1', organizationId: 'org-a' });
    state.fetch.mockResolvedValueOnce(directory).mockResolvedValueOnce(credentials);
    await runtime.sync();
    expect(state.reader?.('byok-a', 'pi')).toBe('invalid-test-key');
    expect(state.reader?.('byok-other', 'pi')).toBeNull();
    const catalog = state.publish.mock.lastCall?.[0];
    expect(JSON.stringify(catalog)).not.toContain('invalid-test-key');
    expect(catalog[0]).toMatchObject({
      source: 'organization',
      auth: { method: 'managed' },
      models: {
        pi: [
          {
            id: 'byok/a/chat',
            defaultEffort: 'high',
            contextWindow: 128000,
            piApi: 'openai-completions',
          },
        ],
      },
    });
    runtime.setOwner(null);
    expect(state.reader?.('byok-a', 'pi')).toBeNull();
    expect(state.managedProviderReader?.('byok-a')).toBe(false);
    expect(state.publish.mock.lastCall?.[0]).toEqual([]);
    expect(getByokPricing()).toEqual({});
    expect(notify).toHaveBeenCalledTimes(3);
  });
  it('does not advance credentials when publishing the matching catalog fails', async () => {
    const runtime = createByokRuntime();
    runtime.setOwner({ scope: 'a:cn:1', organizationId: 'org-a' });
    state.fetch.mockResolvedValueOnce(directory).mockResolvedValueOnce(credentials);
    state.publish.mockImplementationOnce(() => {
      throw new Error('publish failed');
    });
    await runtime.sync();
    expect(state.reader?.('byok-a', 'pi')).toBeNull();
    expect(runtime.getStatus().state).toBe('failed');
    expect(getByokPricing()).toEqual({ 'byok-a': {} });
    const gate = state.gate.mock.results[0]?.value;
    expect(gate).toHaveBeenCalled();
    expect(gate.commit).toHaveBeenCalled();
  });
  it('keeps a pending Provider visible without usable routes or credentials', async () => {
    const runtime = createByokRuntime();
    runtime.setOwner({ scope: 'a:cn:1', organizationId: 'org-a' });
    state.fetch.mockResolvedValueOnce(directory).mockResolvedValueOnce({
      ...credentials,
      credentials: [{ providerId: 'byok-a', connectionRevision: 1, status: 'pending' }],
    });
    await runtime.sync();
    expect(state.publish.mock.lastCall?.[0]).toEqual([
      expect.objectContaining({
        id: 'byok-a',
        name: 'Enterprise',
        agents: [],
        models: {},
        routing: {},
        source: 'organization',
      }),
    ]);
    expect(state.reader?.('byok-a', 'pi')).toBeNull();
    expect(state.managedProviderReader?.('byok-a')).toBe(true);
    expect(runtime.getStatus().providers).toEqual([{ providerId: 'byok-a', state: 'pending' }]);
    state.fetch.mockResolvedValueOnce(directory).mockResolvedValueOnce(credentials);
    await runtime.sync();
    expect(state.publish.mock.lastCall?.[0]).toHaveLength(1);
    expect(state.publish.mock.lastCall?.[0][0].agents).toContain('pi');
    expect(state.reader?.('byok-a', 'pi')).toBe('invalid-test-key');
  });

  it('does not restore the old enterprise key if logout catalog notification fails', async () => {
    const runtime = createByokRuntime();
    runtime.setOwner({ scope: 'a:cn:1', organizationId: 'org-a' });
    state.fetch.mockResolvedValueOnce(directory).mockResolvedValueOnce(credentials);
    await runtime.sync();
    state.publish.mockImplementationOnce(() => {
      throw new Error('renderer unavailable');
    });
    expect(() => runtime.setOwner(null)).not.toThrow();
    expect(state.reader?.('byok-a', 'pi')).toBeNull();
    expect(getByokPricing()).toEqual({});
    expect(runtime.getStatus()).toEqual({ state: 'idle', providers: [] });
    expect(state.gate.mock.results.at(-1)?.value.commit).toHaveBeenCalled();
  });

  it('never rolls a revoked key back after a catalog notification failure', async () => {
    const runtime = createByokRuntime();
    runtime.setOwner({ scope: 'a:cn:1', organizationId: 'org-a' });
    state.fetch.mockResolvedValueOnce(directory).mockResolvedValueOnce(credentials);
    await runtime.sync();
    state.fetch.mockResolvedValueOnce(directory).mockResolvedValueOnce({
      ...credentials,
      credentials: [
        { providerId: 'byok-a', connectionRevision: 1, status: 'error', code: 'REVOKED' },
      ],
    });
    state.publish.mockImplementationOnce(() => {
      throw new Error('renderer unavailable');
    });
    await runtime.sync();
    expect(state.reader?.('byok-a', 'pi')).toBeNull();
    expect(runtime.getStatus().state).toBe('failed');
    expect(runtime.getStatus().providers[0].state).toBe('unavailable');
  });

  it('exposes the member key and endpoint to Art for image-only enterprise providers', async () => {
    const runtime = createByokRuntime();
    runtime.setOwner({ scope: 'a:cn:1', organizationId: 'org-a' });
    const next = {
      schemaVersion: 1,
      organizationId: 'org-a',
      revision: '1',
      providers: [
        {
          id: 'byok-a',
          name: 'Enterprise',
          connectionRevision: 1,
          models: [
            {
              nativeApi: 'openai-images',
              id: 'byok-a/gpt-image-2',
              name: 'GPT Image 2',
              currency: 'CNY',
              mode: 'image_generation',
              agents: [],
              perAgent: {},
              modalities: { input: ['text', 'image'], output: ['image'] },
            },
          ],
        },
      ],
    };
    state.fetch.mockResolvedValueOnce(next).mockResolvedValueOnce(credentials);
    await runtime.sync();
    expect(state.reader?.('byok-a', 'image')).toBe('invalid-test-key');
    expect(state.reader?.('byok-a', 'pi')).toBeNull();
    expect(state.endpointReader?.('byok-a')).toBe('https://gateway.example.invalid/v1');
    expect(state.publish.mock.lastCall?.[0][0]).toMatchObject({
      agents: [],
      imageModels: [expect.objectContaining({ id: 'byok-a/gpt-image-2' })],
    });
    runtime.setOwner(null);
    expect(state.reader?.('byok-a', 'image')).toBeNull();
    expect(state.endpointReader?.('byok-a')).toBeNull();
  });

  it('keeps the shared member key available to both chat engines and Art', async () => {
    const runtime = createByokRuntime();
    runtime.setOwner({ scope: 'a:cn:1', organizationId: 'org-a' });
    const next = {
      ...directory,
      providers: [
        {
          ...directory.providers[0],
          models: [
            directory.providers[0].models[0],
            {
              nativeApi: 'openai-images',
              id: 'byok-a/gpt-image-2',
              name: 'GPT Image 2',
              currency: 'CNY',
              mode: 'image_generation',
              agents: [],
              perAgent: {},
              modalities: { input: ['text', 'image'], output: ['image'] },
            },
          ],
        },
      ],
    };
    state.fetch.mockResolvedValueOnce(next).mockResolvedValueOnce(credentials);
    await runtime.sync();
    expect(state.reader?.('byok-a', 'pi')).toBe('invalid-test-key');
    expect(state.reader?.('byok-a', 'image')).toBe('invalid-test-key');
    expect(state.reader?.('byok-a', 'codex')).toBeNull();
  });

  it('does not advertise an image key for chat-only enterprise providers', async () => {
    const runtime = createByokRuntime();
    runtime.setOwner({ scope: 'a:cn:1', organizationId: 'org-a' });
    state.fetch.mockResolvedValueOnce(directory).mockResolvedValueOnce(credentials);
    await runtime.sync();
    expect(state.reader?.('byok-a', 'pi')).toBe('invalid-test-key');
    expect(state.reader?.('byok-a', 'image')).toBeNull();
    expect(state.endpointReader?.('byok-a')).toBe('https://gateway.example.invalid/v1');
  });

  it.each(['add-pi', 'pi-protocol', 'remove-pi', 'add-claude', 'add-image'] as const)(
    'publishes %s changes under the lock without expiring the Codex snapshot', async (change) => {
      const reloadCodex = vi.fn();
      const runtime = createByokRuntime(undefined, undefined, reloadCodex);
      runtime.setOwner({ scope: 'a:cn:1', organizationId: 'org-a' });
      const initial: ByokProvidersResponse = {
        schemaVersion: 1, organizationId: 'org-a', revision: '1',
        providers: [{
          id: 'byok-a', name: 'Enterprise', connectionRevision: 1,
          imageBinding: {
            enabled: true, modelId: 'gpt-image-2', wireModel: 'gpt-image-2',
            litellmModel: 'byok-a/gpt-image-2', supportsEdit: true,
          },
          models: [{
            id: 'byok-a/chat', name: 'Chat', contextWindow: 128000,
            agents: ['codex', 'pi'], perAgent: {
              codex: { wireProtocol: 'openai-responses' },
              pi: { wireProtocol: 'openai-completions' },
            },
          }],
        }],
      };
      state.fetch.mockResolvedValueOnce(initial).mockResolvedValueOnce(credentials);
      await runtime.sync();
      expect(reloadCodex).toHaveBeenCalledOnce();
      state.gate.mockClear();
      reloadCodex.mockClear();

      const next = structuredClone(initial);
      next.revision = '2';
      const model = next.providers[0].models[0];
      if (change === 'add-pi') {
        next.providers[0].models.push({
          id: 'byok-a/pi-only', name: 'Pi', contextWindow: 128000,
          agents: ['pi'], perAgent: { pi: { wireProtocol: 'openai-completions' } },
        });
      } else if (change === 'pi-protocol') {
        model.perAgent.pi!.wireProtocol = 'anthropic-messages';
      } else if (change === 'remove-pi') {
        model.agents = ['codex'];
        delete model.perAgent.pi;
      } else if (change === 'add-claude') {
        model.agents!.push('claude-code');
        model.perAgent['claude-code'] = { wireProtocol: 'anthropic-messages' };
      } else {
        next.providers[0].models.push({
          id: 'byok-a/image', name: 'Image', mode: 'image_generation', agents: [], perAgent: {},
        });
      }
      state.fetch.mockResolvedValueOnce(next).mockResolvedValueOnce(credentials);
      await runtime.sync();
      expect(runtime.getStatus().state).toBe('ready');
      expect(state.gate).toHaveBeenCalledOnce();
      const lock = state.gate.mock.results[0].value;
      expect(lock).toHaveBeenCalledOnce();
      expect(lock.commit).not.toHaveBeenCalled();
      expect(reloadCodex).not.toHaveBeenCalled();
      const published = state.publish.mock.lastCall![0][0];
      if (change === 'add-pi') expect(published.models.pi).toHaveLength(2);
      if (change === 'pi-protocol') expect(published.models.pi[0].piApi).toBe('anthropic-messages');
      if (change === 'remove-pi') expect(state.reader?.('byok-a', 'pi')).toBeNull();
      if (change === 'add-claude') expect(published.models['claude-code']).toHaveLength(1);
      if (change === 'add-image') expect(published.imageModels).toHaveLength(1);

      // The same unchanged Codex snapshot must still expire when the shared key rotates.
      state.gate.mockClear();
      const rotated = structuredClone(credentials);
      rotated.credentials[0].apiKey = 'invalid-rotated-test-key';
      state.fetch.mockResolvedValueOnce(next).mockResolvedValueOnce(rotated);
      await runtime.sync();
      expect(state.gate.mock.results[0].value.commit).toHaveBeenCalledOnce();
      expect(reloadCodex).toHaveBeenCalledOnce();
    },
  );

  it('reloads Codex only when an applied enterprise image route or key changes', async () => {
    const reloadCodex = vi.fn();
    const runtime = createByokRuntime(undefined, undefined, reloadCodex);
    runtime.setOwner({ scope: 'a:cn:1', organizationId: 'org-a' });
    const codexDirectory = structuredClone(directory);
    Object.assign(codexDirectory.providers[0].models[0], {
      agents: ['codex'],
      perAgent: { codex: { wireProtocol: 'openai-responses' } },
    });
    state.fetch.mockResolvedValueOnce(codexDirectory).mockResolvedValueOnce(credentials);
    await runtime.sync();
    expect(reloadCodex).not.toHaveBeenCalled();

    const imageDirectory = structuredClone(codexDirectory);
    imageDirectory.revision = '2';
    Object.assign(imageDirectory.providers[0], {
      imageBinding: {
        enabled: true,
        modelId: 'gpt-image-2',
        wireModel: 'gpt-image-2',
        litellmModel: 'byok-a/gpt-image-2',
        supportsEdit: true,
      },
    });
    state.fetch.mockResolvedValueOnce(imageDirectory).mockResolvedValueOnce(credentials);
    await runtime.sync();
    expect(reloadCodex).toHaveBeenCalledOnce();

    state.fetch.mockResolvedValueOnce(imageDirectory).mockResolvedValueOnce(credentials);
    await runtime.sync();
    expect(reloadCodex).toHaveBeenCalledOnce();

    const metadataOnly = structuredClone(imageDirectory);
    metadataOnly.revision = '3';
    metadataOnly.providers[0].name = 'Renamed enterprise connection';
    Object.assign(metadataOnly.providers[0].models[0], { inputCostPerToken: 0.123 });
    const gatesBeforeMetadata = state.gate.mock.calls.length;
    state.fetch.mockResolvedValueOnce(metadataOnly).mockResolvedValueOnce(credentials);
    await runtime.sync();
    expect(reloadCodex).toHaveBeenCalledOnce();
    expect(state.gate).toHaveBeenCalledTimes(gatesBeforeMetadata);

    const rotated = structuredClone(credentials);
    rotated.credentials[0].apiKey = 'rotated-test-key';
    state.fetch.mockResolvedValueOnce(metadataOnly).mockResolvedValueOnce(rotated);
    await runtime.sync();
    expect(reloadCodex).toHaveBeenCalledTimes(2);

    const moved = structuredClone(rotated);
    moved.credentials[0].endpoint = 'https://replacement.example.invalid/v1';
    state.fetch.mockResolvedValueOnce(metadataOnly).mockResolvedValueOnce(moved);
    await runtime.sync();
    expect(state.gate.mock.results.at(-1)?.value.commit).toHaveBeenCalledOnce();
    expect(reloadCodex).toHaveBeenCalledTimes(3);

    const codexModelAdded = structuredClone(metadataOnly);
    codexModelAdded.revision = '4';
    codexModelAdded.providers[0].models.push({
      ...codexModelAdded.providers[0].models[0], id: 'byok-a/another-codex-model',
    });
    state.fetch.mockResolvedValueOnce(codexModelAdded).mockResolvedValueOnce(moved);
    await runtime.sync();
    expect(state.gate.mock.results.at(-1)?.value.commit).toHaveBeenCalledOnce();
    expect(reloadCodex).toHaveBeenCalledTimes(4);

    runtime.setOwner(null);
    expect(state.gate.mock.results.at(-1)?.value.commit).toHaveBeenCalledOnce();
    expect(reloadCodex).toHaveBeenCalledTimes(5);
  });
});
