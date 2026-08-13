import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

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
  it('accepts the compact vendor-facing custom API-key shape', () => {
    const importId = createDraft(customPayload());

    const preview = previewProviderImport(importId, SCOPE, []);
    expect(preview).toMatchObject({
      importId,
      kind: 'custom',
      name: 'Acme AI',
      authMethod: 'apiKey',
      action: 'create',
      providerId: 'acme-ai',
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

  it('accepts the only built-in API-key slot on the explicit allowlist', () => {
    const importId = createDraft({ kind: 'builtin', provider: 'gemini', apiKey: 'gemini-secret' });

    expect(previewProviderImport(importId, SCOPE, [])).toEqual({
      importId,
      kind: 'builtin',
      name: 'Google Gemini',
      authMethod: 'apiKey',
      action: 'replace-key',
      providerId: 'gemini',
      runtimes: [],
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

  it('recognizes an existing custom provider by its normalized runtime endpoint', () => {
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

    expect(() => previewProviderImport(importId, SCOPE, [existing])).toThrow(
      'does not match the existing provider endpoints',
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

    previewProviderImport(importId, SCOPE, []);
    expect(beginProviderImportConfirm(importId, SCOPE, [])).toMatchObject({
      resolution: { action: 'create', providerId: 'acme-ai' },
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

  it('forces a fresh preview when the matching provider set changes', () => {
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
    previewProviderImport(importId, SCOPE, []);
    const appeared = existingCustomProvider(
      'appeared-later',
      'Appeared Later',
      'codex',
      'openai-chat',
      'https://api.acme.test/v1',
    );

    expect(() => beginProviderImportConfirm(importId, SCOPE, [appeared])).toThrow(
      /provider list changed/,
    );
  });
});
