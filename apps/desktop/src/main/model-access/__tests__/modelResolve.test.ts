import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/unused' },
}));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: () => 'https://models.example.test',
}));
vi.mock('../../serverApiClient.js', () => ({
  serverApiFetch: vi.fn(),
}));

import {
  createModelResolver,
  invalidateModelResolveApplyState,
  invalidateModelResolveApplySlots,
  isLatestModelResolveResult,
  modelResolveCacheKey,
  modelResolveIdentityScope,
  modelResolveLocalApplyStateForTests,
  modelResolveRealm,
  releaseModelResolveApplyResult,
  resetModelResolveStateForTests,
  type ModelResolveInput,
} from '../modelResolve.js';

const INPUT: ModelResolveInput = {
  providerId: 'acme',
  agent: 'codex',
  wireProtocol: 'openai-responses',
  sourceIdentity: {
    kind: 'provider-runtime',
    upstream: 'https://api.acme.test/openai/v1',
    modelsUrl: 'https://api.acme.test/openai/v1/models?tenant=one&region=us',
  },
  models: [{ id: 'model-a', name: 'Model A' }],
};

const CLAUDE_INPUT: ModelResolveInput = {
  providerId: 'acme',
  agent: 'claude-code',
  sourceIdentity: {
    kind: 'provider-runtime',
    upstream: 'https://api.acme.test/anthropic',
    modelsUrl: 'https://api.acme.test/anthropic/v1/models?tenant=one',
  },
  models: [{ id: 'model-b', name: 'Model B' }],
};

const DEFAULT_BASE_URL = 'https://models.example.test/api';
const DEFAULT_REALM = modelResolveRealm(DEFAULT_BASE_URL)!;
const DEFAULT_USER_DATA_DIR = path.join(os.tmpdir(), 'cindy-model-resolve-test', 'owner-a');
const OTHER_USER_DATA_DIR = path.join(os.tmpdir(), 'cindy-model-resolve-test', 'owner-b');
const DEFAULT_IDENTITY_SCOPE = modelResolveIdentityScope('cloud:owner-a:1', 0);

function storePath(userDataDir: string): string {
  return path.join(userDataDir, 'model-access', 'model-resolve.json');
}

function responseFor(
  inputs: readonly ModelResolveInput[],
  revision = 'r1',
  reverseEntries = false,
) {
  const entries = inputs.map((input) => ({
    providerId: input.providerId,
    agent: input.agent,
    models: input.models.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: 128_000,
      efforts: ['high'],
      defaultEffort: 'high',
    })),
  }));
  return {
    schemaVersion: 2,
    knowledgeRevision: revision,
    entries: reverseEntries ? entries.reverse() : entries,
  };
}

function response(revision = 'r1') {
  return responseFor([INPUT], revision);
}

function harness(
  options: {
    baseUrl?: string;
    getBaseUrl?: () => string;
    ownerScopeKey?: string;
    getOwnerScopeKey?: () => string;
    userDataDir?: string;
    getUserDataDir?: () => string;
    disk?: string | null;
    fetch?: (request: unknown) => Promise<unknown>;
    disabled?: boolean;
  } = {},
) {
  const initialUserDataDir = options.userDataDir ?? DEFAULT_USER_DATA_DIR;
  const ownerScopeResolver =
    options.getOwnerScopeKey ?? (() => options.ownerScopeKey ?? 'cloud:owner-a:1');
  const userDataDirResolver = options.getUserDataDir ?? (() => initialUserDataDir);
  const files = new Map<string, string>();
  if (options.disk !== undefined && options.disk !== null) {
    files.set(storePath(initialUserDataDir), options.disk);
  }
  const calls = {
    fetch: vi.fn(options.fetch ?? (async () => response())),
    readFile: vi.fn(async (filePath: string) => {
      const contents = files.get(filePath);
      if (contents === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return contents;
    }),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (filePath: string, text: string) => {
      files.set(filePath, text);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const contents = files.get(from);
      if (contents === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      files.set(to, contents);
      files.delete(from);
    }),
    remove: vi.fn(async (filePath: string) => {
      files.delete(filePath);
    }),
    getBaseUrl: vi.fn(options.getBaseUrl ?? (() => options.baseUrl ?? DEFAULT_BASE_URL)),
    getOwnerScopeKey: vi.fn(ownerScopeResolver),
    getUserDataDir: vi.fn(userDataDirResolver),
    disabled: vi.fn(() => options.disabled === true),
  };
  return {
    resolve: createModelResolver(calls),
    calls,
    disk: (userDataDir = userDataDirResolver()) => files.get(storePath(userDataDir)) ?? null,
  };
}

afterEach(() => {
  resetModelResolveStateForTests();
});

describe('model resolve client', () => {
  it('keys the cache by effective wire, exact source identity, and complete request facts', () => {
    const sourceIdentity = INPUT.sourceIdentity;
    if (sourceIdentity.kind !== 'provider-runtime') {
      throw new Error('provider-runtime fixture expected');
    }
    expect(modelResolveCacheKey(INPUT)).toBe(modelResolveCacheKey({ ...INPUT }));
    expect(modelResolveCacheKey({ ...INPUT, wireProtocol: undefined })).toBe(
      modelResolveCacheKey(INPUT),
    );
    expect(modelResolveCacheKey({ ...INPUT, localApplyScope: 'form-a' })).toBe(
      modelResolveCacheKey({ ...INPUT, localApplyScope: 'form-b' }),
    );
    expect(modelResolveCacheKey(INPUT)).not.toBe(
      modelResolveCacheKey({ ...INPUT, agent: 'claude-code' }),
    );
    expect(modelResolveCacheKey(INPUT)).not.toBe(
      modelResolveCacheKey({ ...INPUT, wireProtocol: 'openai-chat' }),
    );
    expect(modelResolveCacheKey(INPUT)).not.toBe(
      modelResolveCacheKey({
        ...INPUT,
        sourceIdentity: {
          ...sourceIdentity,
          requestPath: '/chat/completions',
        },
      }),
    );
    expect(modelResolveCacheKey(INPUT)).not.toBe(
      modelResolveCacheKey({
        ...INPUT,
        sourceIdentity: {
          kind: 'provider-runtime',
          upstream: 'https://api.acme.test/openai/v1',
          modelsUrl: 'https://api.acme.test/openai/v1/models?region=us&tenant=one',
        },
      }),
    );
    const tokenized = modelResolveCacheKey({
      ...INPUT,
      sourceIdentity: {
        kind: 'provider-runtime',
        upstream: 'https://api.acme.test/openai/v1',
        modelsUrl: 'https://api.acme.test/openai/v1/models?tenant=one&api_key=secret',
      },
    });
    expect(tokenized).not.toBe(modelResolveCacheKey(INPUT));
    expect(tokenized).not.toContain('secret');
    expect(modelResolveCacheKey(INPUT)).not.toBe(
      modelResolveCacheKey({ ...INPUT, models: [{ id: 'model-a', name: 'Renamed' }] }),
    );
    expect(modelResolveCacheKey(INPUT)).not.toBe(
      modelResolveCacheKey({
        ...INPUT,
        models: [
          { id: 'model-a', name: 'Model A', providerReported: { contextWindow: 1_000_000 } },
        ],
      }),
    );
    expect(
      modelResolveCacheKey({
        ...INPUT,
        models: [
          {
            id: 'model-a',
            name: 'Model A',
            providerReported: {
              capabilities: { reasoning: true, toolCall: false },
              modalities: { input: ['text', 'image'], output: ['text'] },
            },
          },
        ],
      }),
    ).toBe(
      modelResolveCacheKey({
        ...INPUT,
        models: [
          {
            id: 'model-a',
            name: 'Model A',
            providerReported: {
              modalities: { output: ['text'], input: ['text', 'image'] },
              capabilities: { toolCall: false, reasoning: true },
            },
          },
        ],
      }),
    );
  });

  it('hashes the complete resolve endpoint realm without persisting query credentials', () => {
    const realm = modelResolveRealm('https://Models.Example.test:8443/path?api_key=secret');
    expect(realm).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(realm).not.toContain('secret');
    expect(modelResolveRealm('http://models.example.test/path')).not.toBe(
      modelResolveRealm('https://models.example.test/path'),
    );
    expect(modelResolveRealm('https://models.example.test/tenant-a')).not.toBe(
      modelResolveRealm('https://models.example.test/tenant-b'),
    );
    expect(modelResolveRealm('https://models.example.test/path?token=a')).not.toBe(
      modelResolveRealm('https://models.example.test/path?token=b'),
    );
    expect(modelResolveRealm('not a URL')).toBeNull();
    expect(DEFAULT_IDENTITY_SCOPE).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(DEFAULT_IDENTITY_SCOPE).not.toContain('owner-a');
  });

  it('invalidates the fingerprint for every provider-reported protocol field', () => {
    const baseline = modelResolveCacheKey(INPUT);
    const variants: Array<NonNullable<ModelResolveInput['models'][number]['providerReported']>> = [
      { contextWindow: 1_000_000 },
      { maxOutput: 128_000 },
      { modalities: { input: ['text', 'image'], output: ['text'] } },
      { capabilities: { reasoning: true, toolCall: true, attachment: true, temperature: false } },
      { mode: 'chat' },
      { type: 'responses' },
    ];
    for (const providerReported of variants) {
      expect(
        modelResolveCacheKey({
          ...INPUT,
          models: [{ id: 'model-a', name: 'Model A', providerReported }],
        }),
      ).not.toBe(baseline);
    }
  });

  it('sends the same projected facts used by the fingerprint and an explicit effective wire', async () => {
    const h = harness({
      fetch: async (request) => {
        expect(request).toEqual({
          schemaVersion: 2,
          entries: [
            {
              providerId: 'acme',
              agent: 'codex',
              wireProtocol: 'openai-responses',
              models: [{ id: 'model-a', name: 'Model A' }],
            },
          ],
        });
        return response();
      },
    });
    await expect(h.resolve({ ...INPUT, wireProtocol: undefined })).resolves.toMatchObject({
      knowledgeRevision: 'r1',
    });
  });

  it('strictly validates the response and degrades to null', async () => {
    const h = harness({ fetch: async () => ({ ...response(), schemaVersion: 1 }) });
    await expect(h.resolve(INPUT)).resolves.toBeNull();
    expect(h.calls.writeFile).not.toHaveBeenCalled();
  });

  it('uses matching last-known-good when a refresh response is structurally invalid', async () => {
    const key = modelResolveCacheKey(INPUT);
    const disk = JSON.stringify({
      version: 3,
      entries: [{
        key,
        realm: DEFAULT_REALM,
        identityScope: DEFAULT_IDENTITY_SCOPE,
        knowledgeRevision: 'r1',
        response: response(),
      }],
    });
    const h = harness({ disk, fetch: async () => ({ ...response('broken'), schemaVersion: 1 }) });
    await expect(h.resolve(INPUT)).resolves.toMatchObject({ knowledgeRevision: 'r1' });
    expect(h.calls.writeFile).not.toHaveBeenCalled();
  });

  it('single-flights identical requests and persists last-known-good atomically', async () => {
    let release!: (value: unknown) => void;
    const h = harness({
      fetch: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const first = h.resolve(INPUT);
    const second = h.resolve(INPUT);
    await vi.waitFor(() => expect(h.calls.fetch).toHaveBeenCalledOnce());
    release(response());
    const resolved = await Promise.all([first, second]);
    expect(resolved).toEqual([
      expect.objectContaining({ knowledgeRevision: 'r1' }),
      expect.objectContaining({ knowledgeRevision: 'r1' }),
    ]);
    expect(resolved.every((result) => result && isLatestModelResolveResult(result))).toBe(true);
    expect(h.calls.writeFile).toHaveBeenCalledOnce();
    expect(h.calls.rename).toHaveBeenCalledOnce();
    expect(h.disk()).toContain('"knowledgeRevision":"r1"');
  });

  it('uses matching-realm last-known-good only when refresh fails', async () => {
    const key = modelResolveCacheKey(INPUT);
    const disk = JSON.stringify({
      version: 3,
      entries: [{
        key,
        realm: DEFAULT_REALM,
        identityScope: DEFAULT_IDENTITY_SCOPE,
        knowledgeRevision: 'r1',
        response: response(),
      }],
    });
    const matching = harness({
      disk,
      fetch: async () => {
        throw new Error('offline');
      },
    });
    await expect(matching.resolve(INPUT)).resolves.toMatchObject({ knowledgeRevision: 'r1' });

    resetModelResolveStateForTests();
    const mismatched = harness({
      disk,
      baseUrl: 'https://other.example.test',
      fetch: async () => {
        throw new Error('offline');
      },
    });
    await expect(mismatched.resolve(INPUT)).resolves.toBeNull();
  });

  it('keeps a network-failure last-known-good in memory for the current fingerprint', async () => {
    const key = modelResolveCacheKey(INPUT);
    const disk = JSON.stringify({
      version: 3,
      entries: [{
        key,
        realm: DEFAULT_REALM,
        identityScope: DEFAULT_IDENTITY_SCOPE,
        knowledgeRevision: 'r1',
        response: response(),
      }],
    });
    const h = harness({
      disk,
      fetch: async () => {
        throw new Error('offline');
      },
    });
    await expect(h.resolve(INPUT)).resolves.toMatchObject({ knowledgeRevision: 'r1' });
    await expect(h.resolve(INPUT)).resolves.toMatchObject({ knowledgeRevision: 'r1' });
    expect(h.calls.fetch).toHaveBeenCalledOnce();
  });

  it('drops a response when the model-access realm changes during the request', async () => {
    let baseUrl = DEFAULT_BASE_URL;
    const h = harness({
      getBaseUrl: () => baseUrl,
      fetch: async () => {
        baseUrl = 'https://other.example.test/api';
        return response();
      },
    });
    await expect(h.resolve(INPUT)).resolves.toBeNull();
    expect(h.calls.writeFile).not.toHaveBeenCalled();
  });

  it.each([1, 2])(
    'does not reuse a v%s cache from before the current fingerprint/identity contract',
    async (version) => {
      const disk = JSON.stringify({
        version,
        entries: [
          {
            key: modelResolveCacheKey(INPUT),
            realm: DEFAULT_REALM,
            knowledgeRevision: 'r1',
            response: response(),
          },
        ],
      });
      const h = harness({
        disk,
        fetch: async () => {
          throw new Error('offline');
        },
      });
      await expect(h.resolve(INPUT)).resolves.toBeNull();
    },
  );

  it('resolves multiple agent entries in one request and persists compact per-entry envelopes', async () => {
    const h = harness({
      fetch: async (request) => {
        expect(request).toMatchObject({
          schemaVersion: 2,
          entries: [
            { providerId: 'acme', agent: 'codex', wireProtocol: 'openai-responses' },
            { providerId: 'acme', agent: 'claude-code', wireProtocol: 'anthropic-messages' },
          ],
        });
        return responseFor([INPUT, CLAUDE_INPUT], 'r2', true);
      },
    });

    const resolved = await h.resolve.resolveEntries([INPUT, CLAUDE_INPUT]);
    expect(resolved.map((result) => result?.entry.agent)).toEqual(['codex', 'claude-code']);
    expect(resolved.map((result) => result?.entry.models[0]?.id)).toEqual(['model-a', 'model-b']);
    expect(h.calls.fetch).toHaveBeenCalledOnce();
    expect(h.calls.writeFile).toHaveBeenCalledOnce();

    const persisted = JSON.parse(h.disk()!) as {
      version: number;
      entries: Array<{ response: { entries: unknown[] } }>;
    };
    expect(persisted.version).toBe(3);
    expect(persisted.entries).toHaveLength(2);
    expect(persisted.entries.every((entry) => entry.response.entries.length === 1)).toBe(true);
  });

  it('replaces an older fingerprint in the same provider-agent cache slot', async () => {
    const changed: ModelResolveInput = {
      ...INPUT,
      sourceIdentity: {
        kind: 'provider-runtime',
        upstream: 'https://api.acme.test/openai/v1',
        modelsUrl: 'https://api.acme.test/openai/v1/models?tenant=two',
      },
    };
    const h = harness();
    await expect(h.resolve(INPUT)).resolves.toMatchObject({ knowledgeRevision: 'r1' });
    h.calls.fetch.mockImplementation(async () => responseFor([changed], 'r2'));
    await expect(h.resolve(changed)).resolves.toMatchObject({ knowledgeRevision: 'r2' });

    const persisted = JSON.parse(h.disk()!) as {
      entries: Array<{ slot: string; knowledgeRevision: string }>;
    };
    expect(persisted.entries).toHaveLength(1);
    expect(persisted.entries[0]).toMatchObject({
      slot: 'acme\u0000codex',
      knowledgeRevision: 'r2',
    });

    h.calls.fetch.mockImplementation(async () => responseFor([INPUT], 'r3'));
    await expect(h.resolve(INPUT)).resolves.toMatchObject({ knowledgeRevision: 'r3' });
    expect(h.calls.fetch).toHaveBeenCalledTimes(3);
  });

  it('allows only the latest differing fingerprint to be applied or persisted', async () => {
    const changed: ModelResolveInput = {
      ...INPUT,
      sourceIdentity: { kind: 'native', id: 'new-source' },
    };
    const releases: Array<(value: unknown) => void> = [];
    const h = harness({
      fetch: () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    });
    const older = h.resolve(INPUT);
    await vi.waitFor(() => expect(h.calls.fetch).toHaveBeenCalledTimes(1));
    const newer = h.resolve(changed);
    await vi.waitFor(() => expect(h.calls.fetch).toHaveBeenCalledTimes(2));
    releases[1]!(responseFor([changed], 'r2'));
    releases[0]!(response('r1'));

    const [olderResult, newerResult] = await Promise.all([older, newer]);
    expect(olderResult && isLatestModelResolveResult(olderResult)).toBe(false);
    expect(newerResult && isLatestModelResolveResult(newerResult)).toBe(true);
    const persisted = JSON.parse(h.disk()!) as {
      entries: Array<{ knowledgeRevision: string }>;
    };
    expect(persisted.entries).toEqual([expect.objectContaining({ knowledgeRevision: 'r2' })]);
  });

  it('keeps concurrent unsaved-form apply scopes independent while the wire identity stays fixed', async () => {
    const formA: ModelResolveInput = {
      ...INPUT,
      providerId: 'unsaved/form',
      localApplyScope: 'request-a',
      sourceIdentity: { kind: 'native', id: 'unsaved-form-a' },
    };
    const formB: ModelResolveInput = {
      ...INPUT,
      providerId: 'unsaved/form',
      localApplyScope: 'request-b',
      sourceIdentity: { kind: 'native', id: 'unsaved-form-b' },
    };
    const releases: Array<(value: unknown) => void> = [];
    const h = harness({
      fetch: (request) => {
        expect(request).not.toHaveProperty('entries.0.localApplyScope');
        return new Promise((resolve) => releases.push(resolve));
      },
    });

    const pendingA = h.resolve(formA);
    await vi.waitFor(() => expect(h.calls.fetch).toHaveBeenCalledTimes(1));
    const pendingB = h.resolve(formB);
    await vi.waitFor(() => expect(h.calls.fetch).toHaveBeenCalledTimes(2));
    expect(h.calls.fetch.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ entries: [expect.objectContaining({ providerId: 'unsaved/form' })] }),
      expect.objectContaining({ entries: [expect.objectContaining({ providerId: 'unsaved/form' })] }),
    ]);

    releases[1]!(responseFor([formB], 'r2'));
    releases[0]!(responseFor([formA], 'r1'));
    const [resolvedA, resolvedB] = await Promise.all([pendingA, pendingB]);
    expect(resolvedA && isLatestModelResolveResult(resolvedA)).toBe(true);
    expect(resolvedB && isLatestModelResolveResult(resolvedB)).toBe(true);
    const persisted = JSON.parse(h.disk()!) as {
      entries: Array<{ knowledgeRevision: string }>;
    };
    expect(persisted.entries).toEqual([expect.objectContaining({ knowledgeRevision: 'r2' })]);
  });

  it('deduplicates one resolve flight across independent local apply scopes', async () => {
    const formA: ModelResolveInput = {
      ...INPUT,
      providerId: 'unsaved/form',
      localApplyScope: 'request-a',
    };
    const formB: ModelResolveInput = { ...formA, localApplyScope: 'request-b' };
    let release!: (value: unknown) => void;
    const h = harness({
      fetch: () => new Promise((resolve) => {
        release = resolve;
      }),
    });

    const pendingA = h.resolve(formA);
    await vi.waitFor(() => expect(h.calls.fetch).toHaveBeenCalledOnce());
    const pendingB = h.resolve(formB);
    await Promise.resolve();
    expect(h.calls.fetch).toHaveBeenCalledOnce();

    release(responseFor([formA], 'r1'));
    const [resolvedA, resolvedB] = await Promise.all([pendingA, pendingB]);
    expect(resolvedA && isLatestModelResolveResult(resolvedA)).toBe(true);
    expect(resolvedB && isLatestModelResolveResult(resolvedB)).toBe(true);
  });

  it('keeps latest-wins semantics within one local apply scope', async () => {
    const olderInput: ModelResolveInput = { ...INPUT, localApplyScope: 'same-form' };
    const newerInput: ModelResolveInput = {
      ...olderInput,
      sourceIdentity: { kind: 'native', id: 'same-form-new-source' },
    };
    const releases: Array<(value: unknown) => void> = [];
    const h = harness({
      fetch: () => new Promise((resolve) => releases.push(resolve)),
    });

    const older = h.resolve(olderInput);
    await vi.waitFor(() => expect(h.calls.fetch).toHaveBeenCalledTimes(1));
    const newer = h.resolve(newerInput);
    await vi.waitFor(() => expect(h.calls.fetch).toHaveBeenCalledTimes(2));
    releases[1]!(responseFor([newerInput], 'r2'));
    releases[0]!(responseFor([olderInput], 'r1'));

    const [olderResult, newerResult] = await Promise.all([older, newer]);
    expect(olderResult && isLatestModelResolveResult(olderResult)).toBe(false);
    expect(newerResult && isLatestModelResolveResult(newerResult)).toBe(true);
  });

  it('invalidates local child apply slots with their canonical provider runtime slot', async () => {
    const localInput: ModelResolveInput = { ...INPUT, localApplyScope: 'unsaved-request' };
    let release!: (value: unknown) => void;
    const h = harness({
      fetch: () => new Promise((resolve) => {
        release = resolve;
      }),
    });

    const pending = h.resolve(localInput);
    await vi.waitFor(() => expect(h.calls.fetch).toHaveBeenCalledOnce());
    invalidateModelResolveApplySlots([localInput]);
    release(responseFor([localInput], 'r1'));

    const stale = await pending;
    expect(stale && isLatestModelResolveResult(stale)).toBe(false);
    expect(h.disk()).toBeNull();
  });

  it('releases a one-shot local apply slot without invalidating the canonical cache slot', async () => {
    const localInput: ModelResolveInput = { ...INPUT, localApplyScope: 'one-shot-request' };
    const h = harness();
    const local = await h.resolve(localInput);
    expect(local && isLatestModelResolveResult(local)).toBe(true);

    if (!local) throw new Error('local resolve result expected');
    releaseModelResolveApplyResult(local);
    expect(isLatestModelResolveResult(local)).toBe(false);
    await expect(h.resolve(INPUT)).resolves.toMatchObject({ knowledgeRevision: 'r1' });
    expect(h.calls.fetch).toHaveBeenCalledOnce();
  });

  it('automatically releases local apply slots when resolve returns null', async () => {
    const h = harness({ fetch: async () => { throw new Error('offline'); } });
    for (let index = 0; index < 5; index += 1) {
      await expect(
        h.resolve({ ...INPUT, localApplyScope: `failed-request-${index}` }),
      ).resolves.toBeNull();
      expect(modelResolveLocalApplyStateForTests()).toEqual({
        trackedSlots: 0,
        applyTokens: 0,
        cacheKeys: 0,
      });
    }
  });

  it('automatically releases local apply slots when owner identity changes in flight', async () => {
    let ownerScope = 'cloud:owner-a:1';
    let release!: (value: unknown) => void;
    const h = harness({
      getOwnerScopeKey: () => ownerScope,
      fetch: () => new Promise((resolve) => {
        release = resolve;
      }),
    });
    const localInput: ModelResolveInput = { ...INPUT, localApplyScope: 'identity-race' };
    const pending = h.resolve(localInput);
    await vi.waitFor(() => expect(h.calls.fetch).toHaveBeenCalledOnce());

    ownerScope = 'cloud:owner-b:2';
    release(responseFor([localInput], 'r1'));

    await expect(pending).resolves.toBeNull();
    expect(modelResolveLocalApplyStateForTests()).toEqual({
      trackedSlots: 0,
      applyTokens: 0,
      cacheKeys: 0,
    });
  });

  it('rejects a late result after its provider runtime slot is invalidated', async () => {
    let release!: (value: unknown) => void;
    const h = harness({
      fetch: () => new Promise((resolve) => {
        release = resolve;
      }),
    });
    const pending = h.resolve(INPUT);
    await vi.waitFor(() => expect(h.calls.fetch).toHaveBeenCalledOnce());

    invalidateModelResolveApplySlots([INPUT]);
    release(response('r1'));

    const stale = await pending;
    expect(stale).not.toBeNull();
    expect(stale && isLatestModelResolveResult(stale)).toBe(false);
    expect(h.disk()).toBeNull();
  });

  it('does not reuse or persist an old-account in-flight result after invalidation', async () => {
    let ownerScope = 'cloud:owner-a:1';
    let userDataDir = DEFAULT_USER_DATA_DIR;
    const releases: Array<(value: unknown) => void> = [];
    const h = harness({
      userDataDir: DEFAULT_USER_DATA_DIR,
      getOwnerScopeKey: () => ownerScope,
      getUserDataDir: () => userDataDir,
      fetch: () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    });
    const previous = h.resolve(INPUT);
    await vi.waitFor(() => expect(h.calls.fetch).toHaveBeenCalledTimes(1));

    ownerScope = 'cloud:owner-b:2';
    userDataDir = OTHER_USER_DATA_DIR;
    invalidateModelResolveApplyState();
    const current = h.resolve(INPUT);
    await vi.waitFor(() => expect(h.calls.fetch).toHaveBeenCalledTimes(2));
    releases[1]!(response('r2'));
    releases[0]!(response('r1'));

    const [previousResult, currentResult] = await Promise.all([previous, current]);
    expect(previousResult).toBeNull();
    expect(currentResult && isLatestModelResolveResult(currentResult)).toBe(true);
    expect(h.disk(DEFAULT_USER_DATA_DIR)).toBeNull();
    const persisted = JSON.parse(h.disk(OTHER_USER_DATA_DIR)!) as {
      entries: Array<{ knowledgeRevision: string }>;
    };
    expect(persisted.entries).toEqual([expect.objectContaining({ knowledgeRevision: 'r2' })]);
  });

  it('isolates same-fingerprint memory and durable last-known-good by data owner', async () => {
    let ownerScope = 'cloud:owner-a:1';
    let userDataDir = DEFAULT_USER_DATA_DIR;
    const h = harness({
      userDataDir: DEFAULT_USER_DATA_DIR,
      getOwnerScopeKey: () => ownerScope,
      getUserDataDir: () => userDataDir,
    });
    await expect(h.resolve(INPUT)).resolves.toMatchObject({ knowledgeRevision: 'r1' });
    expect(h.disk(DEFAULT_USER_DATA_DIR)).toContain('"knowledgeRevision":"r1"');

    ownerScope = 'cloud:owner-b:2';
    userDataDir = OTHER_USER_DATA_DIR;
    invalidateModelResolveApplyState();
    h.calls.fetch.mockRejectedValue(new Error('new account offline'));

    await expect(h.resolve(INPUT)).resolves.toBeNull();
    expect(h.calls.fetch).toHaveBeenCalledTimes(2);
    expect(h.disk(DEFAULT_USER_DATA_DIR)).toContain('"knowledgeRevision":"r1"');
    expect(h.disk(OTHER_USER_DATA_DIR)).toBeNull();
  });

  it('invalidates durable last-known-good at a same-owner auth boundary', async () => {
    const h = harness();
    await expect(h.resolve(INPUT)).resolves.toMatchObject({ knowledgeRevision: 'r1' });
    expect(h.disk()).toContain('"knowledgeRevision":"r1"');

    invalidateModelResolveApplyState();
    h.calls.fetch.mockRejectedValue(new Error('new auth generation offline'));

    await expect(h.resolve(INPUT)).resolves.toBeNull();
    expect(h.calls.fetch).toHaveBeenCalledTimes(2);
  });

  it('drops an A response after A→B→A even when the physical owner path matches again', async () => {
    let ownerScope = 'cloud:owner-a:1';
    let userDataDir = DEFAULT_USER_DATA_DIR;
    const releases: Array<(value: unknown) => void> = [];
    const h = harness({
      userDataDir: DEFAULT_USER_DATA_DIR,
      getOwnerScopeKey: () => ownerScope,
      getUserDataDir: () => userDataDir,
      fetch: () => new Promise((resolve) => { releases.push(resolve); }),
    });
    const staleA = h.resolve(INPUT);
    await vi.waitFor(() => expect(h.calls.fetch).toHaveBeenCalledTimes(1));

    ownerScope = 'cloud:owner-b:2';
    userDataDir = OTHER_USER_DATA_DIR;
    invalidateModelResolveApplyState();
    ownerScope = 'cloud:owner-a:3';
    userDataDir = DEFAULT_USER_DATA_DIR;
    invalidateModelResolveApplyState();

    const currentA = h.resolve(INPUT);
    await vi.waitFor(() => expect(h.calls.fetch).toHaveBeenCalledTimes(2));
    releases[1]!(response('r3'));
    releases[0]!(response('r1'));

    await expect(staleA).resolves.toBeNull();
    await expect(currentA).resolves.toMatchObject({ knowledgeRevision: 'r3' });
    expect(h.disk(DEFAULT_USER_DATA_DIR)).toContain('"knowledgeRevision":"r3"');
  });

  it('sends only cache misses when a batch mixes a memory hit with a new entry', async () => {
    const h = harness();
    await expect(h.resolve(INPUT)).resolves.toMatchObject({ knowledgeRevision: 'r1' });
    h.calls.fetch.mockImplementation(async () => responseFor([CLAUDE_INPUT], 'r2'));

    const resolved = await h.resolve.resolveEntries([INPUT, CLAUDE_INPUT]);
    expect(resolved.map((result) => result?.knowledgeRevision)).toEqual(['r1', 'r2']);
    expect(h.calls.fetch).toHaveBeenCalledTimes(2);
    expect(h.calls.fetch.mock.calls[1]?.[0]).toMatchObject({
      entries: [{ providerId: 'acme', agent: 'claude-code' }],
    });
  });

  it('accepts valid batch entries independently when another response entry is missing', async () => {
    const h = harness({ fetch: async () => responseFor([INPUT], 'r2') });
    const resolved = await h.resolve.resolveEntries([INPUT, CLAUDE_INPUT]);
    expect(resolved[0]).toMatchObject({ knowledgeRevision: 'r2' });
    expect(resolved[1]).toBeNull();
    const persisted = JSON.parse(h.disk()!) as { entries: unknown[] };
    expect(persisted.entries).toHaveLength(1);
  });

  it('deduplicates identical entries while preserving input alignment', async () => {
    const h = harness();
    const resolved = await h.resolve.resolveEntries([INPUT, { ...INPUT }]);
    expect(resolved).toHaveLength(2);
    expect(resolved[0]).toEqual(resolved[1]);
    expect(h.calls.fetch).toHaveBeenCalledOnce();
    expect(h.calls.fetch.mock.calls[0]?.[0]).toMatchObject({ entries: [{ agent: 'codex' }] });
  });

  it('rejects ambiguous duplicate provider-agent entries before endpoint or disk access', async () => {
    const h = harness();
    const conflicting: ModelResolveInput = { ...INPUT, wireProtocol: 'openai-chat' };
    await expect(h.resolve.resolveEntries([INPUT, conflicting])).resolves.toEqual([null, null]);
    expect(h.calls.getBaseUrl).not.toHaveBeenCalled();
    expect(h.calls.getUserDataDir).not.toHaveBeenCalled();
    expect(h.calls.fetch).not.toHaveBeenCalled();
  });

  it('rejects an explicitly empty wire before endpoint or disk access', async () => {
    const h = harness();
    await expect(h.resolve({ ...INPUT, wireProtocol: '  ' })).resolves.toBeNull();
    expect(h.calls.getBaseUrl).not.toHaveBeenCalled();
    expect(h.calls.readFile).not.toHaveBeenCalled();
    expect(h.calls.fetch).not.toHaveBeenCalled();
  });

  it('disabled flag performs no endpoint, disk, network, or write side effects', async () => {
    const h = harness({ disabled: true });
    await expect(h.resolve(INPUT)).resolves.toBeNull();
    expect(h.calls.getBaseUrl).not.toHaveBeenCalled();
    expect(h.calls.getUserDataDir).not.toHaveBeenCalled();
    expect(h.calls.readFile).not.toHaveBeenCalled();
    expect(h.calls.fetch).not.toHaveBeenCalled();
    expect(h.calls.writeFile).not.toHaveBeenCalled();
  });
});
