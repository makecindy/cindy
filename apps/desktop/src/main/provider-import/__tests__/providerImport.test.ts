import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderPreset, ProviderView } from '@cindy/model-providers';

import {
  beginProviderImportConfirm,
  cancelProviderImport,
  clearProviderImportDraftsForTest,
  createProviderImportDraftFromRest,
  finishProviderImportConfirm,
  previewProviderImport,
} from '../providerImport.js';

const SCOPE = { dataOwnerId: 'owner-a', generation: 1 };

function encodePayload(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function importRest(payload: unknown, version = '1'): string {
  return `provider/import?v=${version}&data=${encodePayload(payload)}`;
}

function createDraft(payload: unknown): string {
  const importId = createProviderImportDraftFromRest(importRest(payload));
  expect(importId).toMatch(/^[0-9a-f-]{36}$/);
  return importId!;
}

function customPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'custom',
    name: 'Acme AI',
    auth: { method: 'apiKey', apiKey: 'sk-import-secret' },
    endpoints: [
      {
        protocol: 'openai-chat',
        baseUrl: 'https://api.acme.test/v1',
        models: ['acme-chat'],
        headers: { 'X-Acme-Tenant': 'tenant-secret' },
      },
    ],
    ...overrides,
  };
}

function existingCustomProvider(
  id: string,
  name: string,
  agent: 'claude-code' | 'codex' | 'pi',
  protocol: 'anthropic-messages' | 'openai-responses' | 'openai-chat',
  upstream: string,
): ProviderView {
  return {
    id,
    name,
    source: 'user',
    connected: true,
    agents: [agent],
    auth: { method: 'apiKey' },
    routing: {
      [agent]: {
        wireProtocol: protocol,
        upstream,
        authStrategy: 'api-key-header',
      },
    },
    models: { [agent]: [] },
  } as ProviderView;
}

afterEach(() => {
  clearProviderImportDraftsForTest();
  vi.useRealTimers();
});

describe('provider import URL parsing', () => {
  it.each(['Bad Header', 'Foo:Bar', 'X-\u0000-Key', 'X-中文'])(
    'rejects invalid HTTP header names before creating a draft: %j', (name) => {
      expect(createProviderImportDraftFromRest(importRest(customPayload({
        endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://api.acme.test/v1', headers: { [name]: 'fake-value' } }],
      })))).toBeNull();
    },
  );

  it.each(['\u0000', '\u0001', '\u000b', '\r', '\n', '\u007f', '中文'])(
    'rejects invalid header values through custom headers and every API-key entry: %j', (invalid) => {
      const value = `fake-${invalid}-key`;
      const endpoint = { protocol: 'openai-chat', baseUrl: 'https://api.acme.test/v1' };
      const payloads = [
        customPayload({ endpoints: [{ ...endpoint, headers: { 'X-Test': value } }] }),
        customPayload({ auth: { method: 'apiKey', apiKey: value } }),
        customPayload({ endpoints: [{ ...endpoint, apiKey: value }] }),
        { kind: 'preset', preset: 'demo', apiKey: value },
        { kind: 'builtin', provider: 'gemini', apiKey: value },
        { kind: 'builtin', provider: 'openai-images', apiKey: value },
      ];
      for (const payload of payloads) {
        expect(createProviderImportDraftFromRest(importRest(payload))).toBeNull();
      }
    },
  );

  it('preserves valid header token punctuation, tabs and Latin-1 values', () => {
    createDraft(customPayload({ endpoints: [{
      protocol: 'openai-chat', baseUrl: 'https://api.acme.test/v1',
      headers: { "X-Test!#$%&'*+-.^_`|~": 'fake\tvalue-é', 'X-Empty': '' },
    }] }));
  });

  it.each(['authorization-code', 'device-code'])('rejects OAuth credential spelling variants in %s extra params', (flow) => {
    const keys = ['access_token', 'client_assertion', 'client_secret', 'device_code', 'id_token', 'refresh_token', 'password', 'assertion', 'code', 'token'];
    for (const key of keys) {
      for (const variant of [key, key.toUpperCase(), key.replaceAll('_', '-'), key.replaceAll('_', '.'), key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase())]) {
        const auth = {
          method: 'oauth', flow, tokenUrl: 'https://auth.acme.test/token', clientId: 'public-client', scopes: 'openid',
          ...(flow === 'device-code'
            ? { deviceAuthorizationUrl: 'https://auth.acme.test/device', extraDeviceParams: { [variant]: 'FAKE-CREDENTIAL' } }
            : { authorizeUrl: 'https://auth.acme.test/authorize', extraAuthParams: { [variant]: 'FAKE-CREDENTIAL' } }),
        };
        expect(createProviderImportDraftFromRest(importRest(customPayload({ auth, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://api.acme.test/v1' }] }))), variant).toBeNull();
      }
    }
  });

  it.each(['https://other.test/models', 'http://api.acme.test/models', 'https://api.acme.test:8443/models'])(
    'rejects unsupported cross-origin model discovery %s', (modelsUrl) => {
      expect(createProviderImportDraftFromRest(importRest(customPayload({ endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://api.acme.test/v1', modelsUrl }] })))).toBeNull();
    },
  );

  it('accepts a same-origin model endpoint with a different path and equivalent default port', () => {
    createDraft(customPayload({ endpoints: [{ protocol: 'openai-chat', baseUrl: 'https://api.acme.test/v1', modelsUrl: 'https://api.acme.test:443/catalog/models' }] }));
  });

  it.each(['http://localhost:4000/v1', 'http://127.0.0.1:4000/v1', 'http://[::1]:4000/v1'])(
    'accepts no-auth loopback endpoints: %s', (baseUrl) => {
      const id = createDraft(customPayload({
        auth: { method: 'none' },
        endpoints: [{ protocol: 'openai-chat', baseUrl }],
      }));
      expect(previewProviderImport(id, SCOPE, []).authMethod).toBe('none');
    },
  );

  it.each([
    { baseUrl: 'https://remote.test/v1' },
    { baseUrl: 'http://127.0.0.1:4000/v1', modelsUrl: 'https://remote.test/models' },
  ])('rejects remote no-auth URLs before creating a reviewable draft: %j', (endpoint) => {
    expect(createProviderImportDraftFromRest(importRest(customPayload({
      auth: { method: 'none' },
      endpoints: [{ protocol: 'openai-chat', ...endpoint }],
    })))).toBeNull();
  });

  it('materializes catalog presets using the wizard runtime mapping without freezing model defaults', () => {
    const preset: ProviderPreset = {
      id: 'catalog-demo',
      name: 'Catalog Demo',
      runtimes: {
        codex: {
          baseUrl: 'https://api.acme.test/v1',
          wireProtocol: 'openai-responses',
          requestPath: '/responses',
          supportsImageGeneration: true,
          modelsUrl: 'https://api.acme.test/v1/models',
          headers: { 'X-Tenant': 'catalog-header' },
          models: [{ id: 'm1', name: 'M1', contextWindow: 12345 }],
        },
        pi: {
          baseUrl: 'https://api.acme.test/v1',
          wireProtocol: 'openai-chat',
          piCatalogProviderId: 'acme',
          models: [{ id: 'm1', name: 'M1', piApi: 'openai-completions' }],
        },
      },
    };
    const importId = createDraft({ kind: 'preset', preset: preset.id, apiKey: 'preset-secret' });
    const preview = previewProviderImport(importId, SCOPE, [], undefined, [preset]);
    expect(preview).toMatchObject({
      name: preset.name,
      action: 'create',
      runtimes: [
        { agent: 'codex', hasApiKey: true, modelsUrl: preset.runtimes.codex!.modelsUrl },
        { agent: 'pi', hasApiKey: true },
      ],
    });
    expect(JSON.stringify(preview)).not.toMatch(/preset-secret|catalog-header/);
    const { draft } = beginProviderImportConfirm(importId, SCOPE, []);
    expect(draft).toMatchObject({
      kind: 'custom',
      keys: { codex: 'preset-secret', pi: 'preset-secret' },
      config: {
        runtimes: {
          codex: {
            catalogPresetId: preset.id,
            supportsImageGeneration: true,
            requestPath: '/responses',
            models: [{ id: 'm1', name: 'M1', discoveredMetadata: {} }],
          },
          pi: {
            catalogPresetId: preset.id,
            piCatalogProviderId: 'acme',
            models: [{ piApi: 'openai-completions' }],
          },
        },
      },
    });
    if (draft.kind === 'custom')
      expect(draft.config.runtimes.codex!.models[0]).not.toHaveProperty('contextWindow');
  });

  it('rejects missing and no-auth presets instead of silently importing a key into another connection', () => {
    const importId = createDraft({ kind: 'preset', preset: 'missing', apiKey: 'fixture-key' });
    expect(() => previewProviderImport(importId, SCOPE, [])).toThrow(/unsupported API-key preset/);
    expect(() =>
      previewProviderImport(importId, SCOPE, [], undefined, [
        { id: 'missing', name: 'Local', authMethod: 'none', runtimes: {} },
      ]),
    ).toThrow(/unsupported API-key preset/);
  });

  it('keeps two imports of the same vendor independent, including when the vendor supplies an id', () => {
    const payload = customPayload({ id: 'vendor' });
    const first = previewProviderImport(createDraft(payload), SCOPE, []);
    const second = previewProviderImport(createDraft(payload), SCOPE, []);
    expect(first.providerId).not.toBe(second.providerId);
    expect(first.action).toBe('create');
    expect(second.action).toBe('create');
  });

  it('accepts the compact vendor-facing custom API-key shape', () => {
    const importId = createDraft(customPayload());

    const preview = previewProviderImport(importId, SCOPE, []);
    expect(preview).toMatchObject({
      importId,
      kind: 'custom',
      name: 'Acme AI',
      authMethod: 'apiKey',
      action: 'create',
      providerId: expect.stringMatching(/^acme-ai-[0-9a-f]{8}$/),
    });
    expect(preview.runtimes).toEqual([
      {
        agent: 'codex',
        protocol: 'openai-chat',
        baseUrl: 'https://api.acme.test/v1',
        modelCount: 1,
        willFetchModels: false,
        hasApiKey: true,
        headerNames: ['X-Acme-Tenant'],
      },
      {
        agent: 'pi',
        protocol: 'openai-chat',
        baseUrl: 'https://api.acme.test/v1',
        modelCount: 1,
        willFetchModels: false,
        hasApiKey: true,
        headerNames: ['X-Acme-Tenant'],
      },
    ]);

    // Renderer-facing preview exposes presence/names only, never credential values.
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain('sk-import-secret');
    expect(serialized).not.toContain('tenant-secret');
  });

  it.each([
    ['gemini', 'Google Gemini'],
    ['openai-images', 'OpenAI Images'],
  ])('accepts the built-in API-key slot %s', (provider, name) => {
    const importId = createDraft({ kind: 'builtin', provider, apiKey: 'builtin-secret' });

    expect(previewProviderImport(importId, SCOPE, [])).toEqual({
      importId,
      kind: 'builtin',
      name,
      existingProviderName: name,
      authMethod: 'apiKey',
      action: 'replace-key',
      providerId: provider,
      runtimes: [],
      updateTargets: [],
    });
  });

  it('accepts generic authorization-code OAuth without importing tokens', () => {
    const importId = createDraft({
      kind: 'custom',
      name: 'Acme Subscription',
      auth: {
        method: 'oauth',
        flow: 'authorization-code',
        authorizeUrl: 'https://auth.acme.test/authorize',
        tokenUrl: 'https://auth.acme.test/token',
        clientId: 'public-client',
        scopes: 'openid offline_access',
      },
      endpoints: [
        {
          protocol: 'openai-responses',
          baseUrl: 'https://api.acme.test/v1',
        },
      ],
    });

    expect(previewProviderImport(importId, SCOPE, [])).toMatchObject({
      authMethod: 'oauth',
      oauth: {
        flow: 'authorization-code',
        authorizeHost: 'auth.acme.test',
        tokenHost: 'auth.acme.test',
      },
      runtimes: [{ agent: 'codex', modelCount: 0, willFetchModels: false }],
    });
  });

  it('offers matching connections but creates a new connection unless the user selects one', () => {
    const importId = createDraft(
      customPayload({
        endpoints: [
          {
            protocol: 'openai-chat',
            baseUrl: 'https://api.acme.test/v1/',
            targets: ['codex'],
            models: ['acme-chat'],
          },
        ],
      }),
    );
    const existing = existingCustomProvider(
      'my-local-acme',
      'My Local Acme',
      'codex',
      'openai-chat',
      'https://api.acme.test/v1',
    );

    expect(previewProviderImport(importId, SCOPE, [existing])).toMatchObject({
      action: 'create',
      providerId: expect.stringMatching(/^acme-ai-/),
      updateTargets: [{ id: existing.id, name: existing.name }],
    });
    expect(previewProviderImport(importId, SCOPE, [existing], existing.id)).toMatchObject({
      action: 'update',
      providerId: 'my-local-acme',
      existingProviderName: 'My Local Acme',
    });
  });

  it('does not let an explicit id overwrite a provider with different routing details', () => {
    const importId = createDraft(
      customPayload({
        id: 'existing-provider',
        endpoints: [
          {
            protocol: 'openai-chat',
            baseUrl: 'https://attacker.example.test/v1',
            targets: ['codex'],
            models: ['replacement-model'],
          },
        ],
      }),
    );
    const existing = existingCustomProvider(
      'existing-provider',
      'Existing Provider',
      'codex',
      'openai-chat',
      'https://api.acme.test/v1',
    );

    expect(previewProviderImport(importId, SCOPE, [existing])).toMatchObject({
      action: 'create',
      providerId: expect.stringMatching(/^existing-provider-/),
      updateTargets: [],
    });
    expect(() => previewProviderImport(importId, SCOPE, [existing], existing.id)).toThrow(
      'selected connection is not compatible',
    );
  });

  it('rejects OAuth endpoint URLs carrying query or fragment data', () => {
    expect(
      createProviderImportDraftFromRest(
        importRest({
          kind: 'custom',
          name: 'Bad OAuth URL',
          auth: {
            method: 'oauth',
            authorizeUrl: 'https://auth.acme.test/authorize?client_secret=secret',
            tokenUrl: 'https://auth.acme.test/token',
            clientId: 'public-client',
            scopes: 'openid',
          },
          endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://api.acme.test/v1' }],
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ['wrong path', `providers/import?v=1&data=${encodePayload(customPayload())}`],
    ['missing version', `provider/import?data=${encodePayload(customPayload())}`],
    ['unknown version', importRest(customPayload(), '2')],
    ['duplicate version', `${importRest(customPayload())}&v=1`],
    ['duplicate data', `${importRest(customPayload())}&data=${encodePayload(customPayload())}`],
    ['unknown query field', `${importRest(customPayload())}&source=vendor`],
    ['fragment', `${importRest(customPayload())}#secret`],
    ['invalid base64url', 'provider/import?v=1&data=not+base64'],
  ])('rejects %s', (_label, rest) => {
    expect(createProviderImportDraftFromRest(rest)).toBeNull();
  });

  it.each([
    ['unknown top-level field', customPayload({ surprise: true })],
    [
      'a non-allowlisted built-in provider',
      { kind: 'builtin', provider: 'openai', apiKey: 'secret' },
    ],
    [
      'OAuth token material',
      {
        kind: 'custom',
        name: 'Bad OAuth',
        auth: {
          method: 'oauth',
          authorizeUrl: 'https://auth.acme.test/authorize',
          tokenUrl: 'https://auth.acme.test/token',
          clientId: 'public-client',
          scopes: 'openid',
          accessToken: 'must-not-import',
        },
        endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://api.acme.test/v1' }],
      },
    ],
    [
      'OAuth token material hidden in authorization parameters',
      {
        kind: 'custom',
        name: 'Bad OAuth Params',
        auth: {
          method: 'oauth',
          authorizeUrl: 'https://auth.acme.test/authorize',
          tokenUrl: 'https://auth.acme.test/token',
          clientId: 'public-client',
          scopes: 'openid',
          extraAuthParams: { access_token: 'must-not-import' },
        },
        endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://api.acme.test/v1' }],
      },
    ],
    [
      'OAuth client secret hidden in device parameters',
      {
        kind: 'custom',
        name: 'Bad Device Params',
        auth: {
          method: 'oauth',
          flow: 'device-code',
          deviceAuthorizationUrl: 'https://auth.acme.test/device',
          tokenUrl: 'https://auth.acme.test/token',
          clientId: 'public-client',
          scopes: 'openid',
          extraDeviceParams: { 'client-secret': 'must-not-import' },
        },
        endpoints: [
          {
            protocol: 'openai-responses',
            baseUrl: 'https://api.acme.test/v1',
            targets: ['codex'],
          },
        ],
      },
    ],
    [
      'OAuth on Pi',
      {
        kind: 'custom',
        name: 'Bad Pi OAuth',
        auth: {
          method: 'oauth',
          authorizeUrl: 'https://auth.acme.test/authorize',
          tokenUrl: 'https://auth.acme.test/token',
          clientId: 'public-client',
          scopes: 'openid',
        },
        endpoints: [
          {
            protocol: 'openai-responses',
            baseUrl: 'https://api.acme.test/v1',
            targets: ['pi'],
          },
        ],
      },
    ],
    [
      'cross-origin OAuth model discovery',
      {
        kind: 'custom',
        name: 'Cross Origin Discovery',
        auth: {
          method: 'oauth',
          authorizeUrl: 'https://auth.acme.test/authorize',
          tokenUrl: 'https://auth.acme.test/token',
          clientId: 'public-client',
          scopes: 'openid',
          modelsDiscoveryUrl: 'https://attacker.example/models',
        },
        endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://api.acme.test/v1' }],
      },
    ],
    [
      'ambiguous equal-priority endpoints',
      customPayload({
        endpoints: [
          { protocol: 'openai-chat', baseUrl: 'https://one.acme.test/v1', models: ['one'] },
          { protocol: 'openai-chat', baseUrl: 'https://two.acme.test/v1', models: ['two'] },
        ],
      }),
    ],
    [
      'an endpoint URL with embedded credentials',
      customPayload({
        endpoints: [
          {
            protocol: 'openai-chat',
            baseUrl: 'https://user:password@api.acme.test/v1',
            models: ['acme-chat'],
          },
        ],
      }),
    ],
    [
      'an endpoint URL carrying query or fragment credentials',
      customPayload({
        endpoints: [
          {
            protocol: 'openai-chat',
            baseUrl: 'https://api.acme.test/v1?api_key=secret#fragment',
            models: ['acme-chat'],
          },
        ],
      }),
    ],
  ])('rejects %s', (_label, payload) => {
    expect(createProviderImportDraftFromRest(importRest(payload))).toBeNull();
  });

  it('enforces URL, decoded JSON, endpoint, model, header, and secret bounds', () => {
    expect(
      createProviderImportDraftFromRest(`provider/import?v=1&data=${'a'.repeat(32 * 1024)}`),
    ).toBeNull();
    expect(
      createProviderImportDraftFromRest(
        importRest(customPayload({ padding: 'x'.repeat(24 * 1024) })),
      ),
    ).toBeNull();
    expect(
      createProviderImportDraftFromRest(
        importRest(
          customPayload({
            endpoints: Array.from({ length: 9 }, () => ({
              protocol: 'openai-chat',
              baseUrl: 'https://api.acme.test/v1',
            })),
          }),
        ),
      ),
    ).toBeNull();
    expect(
      createProviderImportDraftFromRest(
        importRest(
          customPayload({
            endpoints: [
              {
                protocol: 'openai-chat',
                baseUrl: 'https://api.acme.test/v1',
                models: Array.from({ length: 257 }, (_, index) => `model-${index}`),
              },
            ],
          }),
        ),
      ),
    ).toBeNull();
    expect(
      createProviderImportDraftFromRest(
        importRest(
          customPayload({
            endpoints: [
              {
                protocol: 'openai-chat',
                baseUrl: 'https://api.acme.test/v1',
                models: ['m'],
                headers: Object.fromEntries(
                  Array.from({ length: 25 }, (_, index) => [`X-${index}`, 'v']),
                ),
              },
            ],
          }),
        ),
      ),
    ).toBeNull();
    expect(
      createProviderImportDraftFromRest(
        importRest(customPayload({ auth: { method: 'apiKey', apiKey: 'k'.repeat(4 * 1024 + 1) } })),
      ),
    ).toBeNull();
  });
});

describe('provider import draft lifecycle', () => {
  it('requires previewing the exact update target and refuses disappeared or changed targets', () => {
    const importId = createDraft(
      customPayload({
        endpoints: [
          { protocol: 'openai-chat', baseUrl: 'https://api.acme.test/v1', targets: ['codex'] },
        ],
      }),
    );
    const first = existingCustomProvider(
      'account-one',
      'One',
      'codex',
      'openai-chat',
      'https://api.acme.test/v1',
    );
    const second = { ...first, id: 'account-two', name: 'Two' };
    const providers = [first, second];
    expect(previewProviderImport(importId, SCOPE, providers).updateTargets).toHaveLength(2);
    expect(() => beginProviderImportConfirm(importId, SCOPE, providers, first.id)).toThrow(
      /provider list changed/,
    );
    previewProviderImport(importId, SCOPE, providers, first.id);
    expect(() => beginProviderImportConfirm(importId, SCOPE, providers, second.id)).toThrow(
      /provider list changed/,
    );
    expect(() => beginProviderImportConfirm(importId, SCOPE, [second], first.id)).toThrow(
      /not compatible/,
    );
    expect(
      beginProviderImportConfirm(importId, SCOPE, providers, first.id).resolution,
    ).toMatchObject({ action: 'update', providerId: first.id });
  });

  it('does not cancel a write already confirmed by the user', () => {
    const importId = createDraft(customPayload());
    previewProviderImport(importId, SCOPE, []);
    beginProviderImportConfirm(importId, SCOPE, []);
    cancelProviderImport(importId);
    expect(() => beginProviderImportConfirm(importId, SCOPE, [])).toThrow(/already running/);
    finishProviderImportConfirm(importId, true);
    expect(() => previewProviderImport(importId, SCOPE, [])).toThrow(/expired/);
  });

  it('requires the same account generation at confirmation time', () => {
    const importId = createDraft(customPayload());
    previewProviderImport(importId, SCOPE, []);

    expect(() =>
      beginProviderImportConfirm(importId, { dataOwnerId: 'owner-b', generation: 2 }, []),
    ).toThrow(/active account changed/);
  });

  it('requires preview before confirm and locks concurrent confirmation', () => {
    const importId = createDraft(customPayload());
    expect(() => beginProviderImportConfirm(importId, SCOPE, [])).toThrow(/preview this import/);

    const preview = previewProviderImport(importId, SCOPE, []);
    expect(beginProviderImportConfirm(importId, SCOPE, [])).toMatchObject({
      resolution: { action: 'create', providerId: preview.providerId },
    });
    expect(() => beginProviderImportConfirm(importId, SCOPE, [])).toThrow(/already running/);
  });

  it('keeps a failed draft retryable and destroys a successful draft', () => {
    const importId = createDraft(customPayload());
    previewProviderImport(importId, SCOPE, []);
    beginProviderImportConfirm(importId, SCOPE, []);
    finishProviderImportConfirm(importId, false);

    expect(() => beginProviderImportConfirm(importId, SCOPE, [])).not.toThrow();
    finishProviderImportConfirm(importId, true);
    expect(() => previewProviderImport(importId, SCOPE, [])).toThrow(/expired or was already used/);
  });

  it('destroys a cancelled draft immediately', () => {
    const importId = createDraft(customPayload());
    cancelProviderImport(importId);

    expect(() => previewProviderImport(importId, SCOPE, [])).toThrow(/expired or was already used/);
  });

  it('expires drafts after ten minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
    const importId = createDraft(customPayload());

    vi.advanceTimersByTime(10 * 60_000);

    expect(() => previewProviderImport(importId, SCOPE, [])).toThrow(/expired or was already used/);
  });

  it('does not switch a new import to update when another matching connection appears', () => {
    const payload = customPayload({
      endpoints: [
        {
          protocol: 'openai-chat',
          baseUrl: 'https://api.acme.test/v1',
          targets: ['codex'],
          models: ['acme-chat'],
        },
      ],
    });
    const importId = createDraft(payload);
    const preview = previewProviderImport(importId, SCOPE, []);
    const appeared = existingCustomProvider(
      'appeared-later',
      'Appeared Later',
      'codex',
      'openai-chat',
      'https://api.acme.test/v1',
    );

    expect(beginProviderImportConfirm(importId, SCOPE, [appeared])).toMatchObject({
      resolution: { action: 'create', providerId: preview.providerId },
    });
  });
});
