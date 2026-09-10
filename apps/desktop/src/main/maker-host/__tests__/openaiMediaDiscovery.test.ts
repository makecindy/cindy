import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/cindy-openai-media-discovery-test' } }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'owner',
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  getProviderSecretStore: () => ({ get: () => '' }),
}));
vi.mock('../active-catalog.js', () => ({ setDiscoveredProviderMediaModels: vi.fn() }));
vi.mock('../anthropic-responses-bridge-host.js', () => ({
  getChatgptBridgeAuth: vi.fn(),
  invalidateChatgptBridgeAuth: vi.fn(),
}));
vi.mock('../codex-oauth-readiness.js', () => ({ hasCodexOAuthLoginReadOnly: () => false }));
vi.mock('../outbound-fetch.js', () => ({ outboundFetch: vi.fn() }));

import {
  createOpenAiMediaDiscovery,
  mapOpenAiMediaModels,
  type OpenAiMediaCredentialKind,
  type OpenAiMediaDiscoverySnapshot,
} from '../model-discovery/openai-media.js';

function modelsList(ids: string[]): string {
  return JSON.stringify({
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model' })),
  });
}

describe('mapOpenAiMediaModels', () => {
  it('keeps image models from a mixed /v1/models list and prefixes openai/', () => {
    expect(
      mapOpenAiMediaModels({
        data: [
          { id: 'gpt-6-astra' },
          { id: 'gpt-image-2.5-sunburst', display_name: 'GPT Image 2.5 Sunburst' },
          { id: 'gpt-image-2.5-flare' },
          { id: 'dall-e-3' },
          { id: 'sora-2' },
        ],
      }),
    ).toEqual([
      { id: 'openai/gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst' },
      { id: 'openai/gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare' },
      { id: 'openai/dall-e-3', name: 'DALL·E 3' },
    ]);
  });

  it('accepts output_modalities image even when the id is unknown', () => {
    expect(
      mapOpenAiMediaModels({
        models: [
          {
            id: 'future-canvas',
            output_modalities: ['image'],
          },
        ],
      }),
    ).toEqual([{ id: 'openai/future-canvas', name: 'Future Canvas' }]);
  });

  it('drops dated snapshots when the undated alias is present', () => {
    expect(
      mapOpenAiMediaModels({
        data: [
          { id: 'gpt-image-2.5-sunburst' },
          { id: 'gpt-image-2.5-sunburst-2026-09-08' },
        ],
      })?.map((model) => model.id),
    ).toEqual(['openai/gpt-image-2.5-sunburst']);
  });

  it('returns an empty array for a valid chat-only list', () => {
    expect(mapOpenAiMediaModels({ data: [{ id: 'gpt-6-astra' }, { id: 'gpt-5.5' }] })).toEqual([]);
  });

  it('rejects malformed payloads', () => {
    expect(mapOpenAiMediaModels(null)).toBeNull();
    expect(mapOpenAiMediaModels({ data: 'nope' })).toBeNull();
  });
});

describe('OpenAI media discovery lifecycle', () => {
  function harness(
    fetchImplementation: typeof fetch,
    onOAuthRejectedImplementation?: () => Promise<void> | void,
  ) {
    const owner = { value: 'owner-a', pending: false, connected: true };
    const auth = {
      kind: 'oauth' as OpenAiMediaCredentialKind,
      token: 'oauth-token',
      credentialGeneration: 0,
    };
    const applied: Array<OpenAiMediaDiscoverySnapshot | null> = [];
    const onOAuthRejected = vi.fn(async () => {
      await onOAuthRejectedImplementation?.();
    });
    const discovery = createOpenAiMediaDiscovery({
      hasCredential: () => owner.connected,
      getCredential: async () =>
        owner.connected ? { kind: auth.kind, token: auth.token } : null,
      getCredentialGeneration: () => auth.credentialGeneration,
      getOwnerScopeKey: () => owner.value,
      isOwnerBoundaryPending: () => owner.pending,
      fetchImplementation,
      applySnapshot: (snapshot) => applied.push(snapshot),
      onOAuthRejected,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    return { discovery, owner, auth, applied, onOAuthRejected };
  }

  it('applies GPT Image 2.5 members discovered from /v1/models', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(modelsList(['gpt-6-astra', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    const h = harness(fetchMock);

    await expect(h.discovery.refresh()).resolves.toBe(true);
    expect(h.applied).toEqual([
      {
        imageModels: [
          { id: 'openai/gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst' },
          { id: 'openai/gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare' },
        ],
      },
    ]);
  });

  it('does not clear the bundled fallback when ChatGPT OAuth lists only chat models', async () => {
    const fetchMock = vi.fn(
      async () => new Response(modelsList(['gpt-6-astra', 'gpt-5.5']), { status: 200 }),
    ) as unknown as typeof fetch;
    const h = harness(fetchMock);

    await expect(h.discovery.refresh()).resolves.toBe(false);
    expect(h.applied).toEqual([]);
  });

  it('treats an Images API key empty list as an authoritative snapshot', async () => {
    const fetchMock = vi.fn(
      async () => new Response(modelsList(['gpt-6-astra']), { status: 200 }),
    ) as unknown as typeof fetch;
    const h = harness(fetchMock);
    h.auth.kind = 'api-key';
    h.auth.token = 'sk-image';

    await expect(h.discovery.refresh()).resolves.toBe(true);
    expect(h.applied).toEqual([{ imageModels: [] }]);
  });

  it('forwards OAuth 401 without applying a snapshot', async () => {
    const fetchMock = vi.fn(
      async () => new Response('expired', { status: 401 }),
    ) as unknown as typeof fetch;
    const h = harness(fetchMock);

    await expect(h.discovery.refresh()).resolves.toBe(false);
    expect(h.onOAuthRejected).toHaveBeenCalledWith({
      status: 401,
      body: 'expired',
      failedAccessToken: 'oauth-token',
    });
    expect(h.applied).toEqual([]);
  });

  it('does not treat Images API key 401 as ChatGPT logout', async () => {
    const fetchMock = vi.fn(
      async () => new Response('bad key', { status: 401 }),
    ) as unknown as typeof fetch;
    const h = harness(fetchMock);
    h.auth.kind = 'api-key';
    h.auth.token = 'sk-image';

    await expect(h.discovery.refresh()).resolves.toBe(false);
    expect(h.onOAuthRejected).not.toHaveBeenCalled();
    expect(h.applied).toEqual([]);
  });

  it('waits for async OAuth invalidation before retrying with the new token', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization === 'Bearer oauth-token') {
        return new Response('expired', { status: 401 });
      }
      return new Response(modelsList(['gpt-image-2.5-sunburst']), { status: 200 });
    }) as unknown as typeof fetch;
    const h = harness(fetchMock, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      h.auth.token = 'refreshed-token';
    });

    await expect(h.discovery.refresh()).resolves.toBe(true);
    expect(h.applied).toEqual([
      {
        imageModels: [{ id: 'openai/gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst' }],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries once with a refreshed OAuth token', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization === 'Bearer oauth-token') {
        return new Response('expired', { status: 401 });
      }
      return new Response(modelsList(['gpt-image-2.5-sunburst']), { status: 200 });
    }) as unknown as typeof fetch;
    const h = harness(fetchMock, async () => {
      h.auth.token = 'refreshed-token';
    });

    await expect(h.discovery.refresh()).resolves.toBe(true);
    expect(h.applied).toEqual([
      {
        imageModels: [{ id: 'openai/gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst' }],
      },
    ]);
  });

  it('clears on auth boundary and discards the old account late result', async () => {
    let resolveList!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveList = resolve;
    });
    const fetchMock = vi.fn(() => pending) as unknown as typeof fetch;
    const h = harness(fetchMock);

    const refresh = h.discovery.refresh();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    h.owner.value = 'owner-b';
    h.discovery.clear();
    resolveList(new Response(modelsList(['gpt-image-2.5-sunburst']), { status: 200 }));

    await expect(refresh).resolves.toBe(false);
    expect(h.applied).toEqual([null]);
  });
});
