import { describe, expect, it } from 'vitest';

import {
  areProviderRequestUrlsAllowed,
  providerConnectionTestRequestSignature,
  providerModelFetchRequestSignature,
} from '../providerModelFetch';

const fields = {
  baseUrl: ' https://api.example/v1 ',
  requestPath: ' /responses ',
  modelsUrl: ' /models ',
  apiKey: ' secret-a ',
  headers: [
    { name: 'Authorization', value: 'Bearer stale' },
    { name: 'X-Tenant', value: 'acme' },
  ],
};

describe('providerModelFetchRequestSignature', () => {
  it('invalidates an in-flight result when the auth mode changes', () => {
    expect(providerModelFetchRequestSignature(fields, 'apiKey')).not.toBe(
      providerModelFetchRequestSignature(fields, 'oauth'),
    );
    expect(providerModelFetchRequestSignature(fields, 'oauth')).not.toBe(
      providerModelFetchRequestSignature(fields, 'none'),
    );
  });

  it('tracks only the API key that is effective for the selected auth mode', () => {
    const changed = { ...fields, apiKey: 'secret-b' };
    expect(providerModelFetchRequestSignature(fields, 'apiKey')).not.toBe(
      providerModelFetchRequestSignature(changed, 'apiKey'),
    );
    expect(providerModelFetchRequestSignature(fields, 'oauth')).toBe(
      providerModelFetchRequestSignature(changed, 'oauth'),
    );
  });

  it('uses credential-stripped headers when credentials are not supplied from the form', () => {
    const changedCredential = {
      ...fields,
      headers: [
        { name: 'Authorization', value: 'Bearer changed' },
        { name: 'X-Tenant', value: 'acme' },
      ],
    };
    const changedEffectiveHeader = {
      ...fields,
      headers: [
        { name: 'Authorization', value: 'Bearer stale' },
        { name: 'X-Tenant', value: 'other' },
      ],
    };
    for (const authMode of ['oauth', 'none'] as const) {
      expect(providerModelFetchRequestSignature(fields, authMode)).toBe(
        providerModelFetchRequestSignature(changedCredential, authMode),
      );
      expect(providerModelFetchRequestSignature(fields, authMode)).not.toBe(
        providerModelFetchRequestSignature(changedEffectiveHeader, authMode),
      );
    }
  });
});

describe('providerConnectionTestRequestSignature', () => {
  const connectionFields = {
    ...fields,
    wireProtocol: 'openai-responses',
    models: [{ id: ' model-a ' }, { id: 'model-b' }],
  };

  it('invalidates a probe when request path, protocol, model, or auth changes', () => {
    const original = providerConnectionTestRequestSignature(connectionFields, 'apiKey');
    expect(
      providerConnectionTestRequestSignature(
        { ...connectionFields, requestPath: '/chat/completions' },
        'apiKey',
      ),
    ).not.toBe(original);
    expect(
      providerConnectionTestRequestSignature(
        { ...connectionFields, wireProtocol: 'openai-chat' },
        'apiKey',
      ),
    ).not.toBe(original);
    expect(
      providerConnectionTestRequestSignature(
        { ...connectionFields, models: [{ id: 'model-c' }] },
        'apiKey',
      ),
    ).not.toBe(original);
    expect(providerConnectionTestRequestSignature(connectionFields, 'none')).not.toBe(original);
  });
});

describe('areProviderRequestUrlsAllowed', () => {
  it('keeps unsaved no-auth probes and model discovery on loopback', () => {
    expect(
      areProviderRequestUrlsAllowed(
        'none',
        'http://127.0.0.1:4000/v1',
        'http://localhost:4000/v1/models',
      ),
    ).toBe(true);
    expect(areProviderRequestUrlsAllowed('none', 'https://proxy.example/v1')).toBe(false);
    expect(
      areProviderRequestUrlsAllowed(
        'none',
        'http://localhost:4000/v1',
        'https://models.example/v1/models',
      ),
    ).toBe(false);
  });

  it('does not apply the loopback restriction to authenticated requests', () => {
    expect(areProviderRequestUrlsAllowed('apiKey', 'https://api.example/v1')).toBe(true);
    expect(areProviderRequestUrlsAllowed('oauth', 'https://api.example/v1')).toBe(true);
  });
});
