import { describe, expect, it } from 'vitest';

import {
  areProviderRequestUrlsAllowed,
  canSendHydratedApiKey,
  connectionTestCanUseSaved,
  modelFetchCanReuseSavedCredentials,
  providerConnectionTestRequestSignature,
  providerModelFetchRequestSignature,
  restoreHydratedApiKey,
  type SavedProviderProbeBaseline,
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

// 一个纯自定义鉴权头供应商的编辑态基线:headers 为空(密文头 main-only,不回读进表单)。
const headerAuthBaseline: SavedProviderProbeBaseline = {
  baseUrl: 'https://gw.example/v1',
  requestPath: '/responses',
  modelsUrl: 'https://gw.example/v1/models',
  wireProtocol: 'openai-responses',
  authMode: 'none',
  apiKey: '',
  headers: [],
};

describe('modelFetchCanReuseSavedCredentials', () => {
  it('reuses saved credentials only when the request target endpoint is unchanged', () => {
    expect(
      modelFetchCanReuseSavedCredentials(
        { baseUrl: ' https://gw.example/v1 ', modelsUrl: ' https://gw.example/v1/models ' },
        headerAuthBaseline,
        'none',
      ),
    ).toBe(true);
    // baseUrl 改到新主机 → 不复用(否则已存密文头会被并到用户新填的任意主机上,外泄凭证)。
    expect(
      modelFetchCanReuseSavedCredentials(
        { baseUrl: 'https://evil.example/v1', modelsUrl: 'https://gw.example/v1/models' },
        headerAuthBaseline,
        'none',
      ),
    ).toBe(false);
    // modelsUrl 改动同样是新请求目标 → 不复用。
    expect(
      modelFetchCanReuseSavedCredentials(
        { baseUrl: 'https://gw.example/v1', modelsUrl: 'https://other.example/models' },
        headerAuthBaseline,
        'none',
      ),
    ).toBe(false);
    // 鉴权模式变了(none → apiKey)→ 语义不同,不复用。
    expect(
      modelFetchCanReuseSavedCredentials(
        { baseUrl: 'https://gw.example/v1', modelsUrl: 'https://gw.example/v1/models' },
        headerAuthBaseline,
        'apiKey',
      ),
    ).toBe(false);
  });

  it('keeps saved credentials when only the inference request path changes', () => {
    expect(
      modelFetchCanReuseSavedCredentials(
        {
          baseUrl: headerAuthBaseline.baseUrl,
          requestPath: '/tenant/acme/models',
          modelsUrl: headerAuthBaseline.modelsUrl,
        },
        headerAuthBaseline,
        'none',
      ),
    ).toBe(true);
  });
});

describe('canSendHydratedApiKey', () => {
  const apiKeyBaseline: SavedProviderProbeBaseline = {
    ...headerAuthBaseline,
    authMode: 'apiKey',
    apiKey: 'saved-key',
  };
  const requestTarget = {
    baseUrl: apiKeyBaseline.baseUrl,
    requestPath: apiKeyBaseline.requestPath,
    modelsUrl: apiKeyBaseline.modelsUrl,
  };

  it('keeps an untouched hydrated key on the saved base/models endpoint', () => {
    expect(canSendHydratedApiKey(requestTarget, apiKeyBaseline, 'apiKey', 0)).toBe(true);
    expect(
      canSendHydratedApiKey(
        { ...requestTarget, baseUrl: 'https://new.example/v1' },
        apiKeyBaseline,
        'apiKey',
        0,
      ),
    ).toBe(false);
    expect(
      canSendHydratedApiKey(
        { ...requestTarget, modelsUrl: 'https://new.example/models' },
        apiKeyBaseline,
        'apiKey',
        0,
      ),
    ).toBe(false);
  });

  it('allows a key after the user explicitly edits it', () => {
    expect(
      canSendHydratedApiKey(
        { ...requestTarget, baseUrl: 'https://new.example/v1' },
        apiKeyBaseline,
        'apiKey',
        1,
      ),
    ).toBe(true);
  });
  it('allows the hydrated key when only requestPath changes', () => {
    expect(
      canSendHydratedApiKey(
        {
          baseUrl: apiKeyBaseline.baseUrl,
          requestPath: '/tenant/acme/models',
          modelsUrl: apiKeyBaseline.modelsUrl,
        },
        apiKeyBaseline,
        'apiKey',
        0,
      ),
    ).toBe(true);
  });

  it('still blocks a changed model-discovery endpoint until the key is edited', () => {
    expect(
      canSendHydratedApiKey(
        { baseUrl: 'https://new.example/v1', modelsUrl: apiKeyBaseline.modelsUrl },
        apiKeyBaseline,
        'apiKey',
        0,
      ),
    ).toBe(false);
    expect(
      canSendHydratedApiKey(
        { baseUrl: 'https://new.example/v1', modelsUrl: apiKeyBaseline.modelsUrl },
        apiKeyBaseline,
        'apiKey',
        1,
      ),
    ).toBe(true);
  });
});

describe('restoreHydratedApiKey', () => {
  const baseline: SavedProviderProbeBaseline = {
    ...headerAuthBaseline,
    authMode: 'apiKey',
    apiKey: 'saved-key',
  };

  it('restores a cleared hydrated key after returning to the saved endpoint', () => {
    const reverted = {
      baseUrl: baseline.baseUrl,
      modelsUrl: baseline.modelsUrl,
      apiKey: '',
    };
    expect(restoreHydratedApiKey(reverted, baseline, 'apiKey', 0).apiKey).toBe('saved-key');
  });

  it('does not overwrite an explicit key edit or a different endpoint', () => {
    expect(
      restoreHydratedApiKey(
        { baseUrl: baseline.baseUrl, modelsUrl: baseline.modelsUrl, apiKey: '' },
        baseline,
        'apiKey',
        1,
      ).apiKey,
    ).toBe('');
    expect(
      restoreHydratedApiKey(
        { baseUrl: 'https://new.example/v1', modelsUrl: baseline.modelsUrl, apiKey: '' },
        baseline,
        'apiKey',
        0,
      ).apiKey,
    ).toBe('');
  });
});

describe('connectionTestCanUseSaved', () => {
  const connForm = {
    baseUrl: ' https://gw.example/v1 ',
    requestPath: ' /responses ',
    modelsUrl: 'https://gw.example/v1/models',
    apiKey: '',
    headers: [] as ReadonlyArray<{ name: string; value: string }>,
    wireProtocol: 'openai-responses',
    models: [{ id: 'm-1' }],
  };

  it('uses the saved probe when endpoint, protocol, auth mode and credential material are all unchanged', () => {
    expect(connectionTestCanUseSaved(connForm, headerAuthBaseline, 'none')).toBe(true);
  });

  it('falls back to adhoc when endpoint, protocol or auth mode changed', () => {
    expect(
      connectionTestCanUseSaved({ ...connForm, baseUrl: 'https://gw.example/v2' }, headerAuthBaseline, 'none'),
    ).toBe(false);
    expect(
      connectionTestCanUseSaved({ ...connForm, requestPath: '/chat' }, headerAuthBaseline, 'none'),
    ).toBe(false);
    expect(
      connectionTestCanUseSaved({ ...connForm, wireProtocol: 'openai-chat' }, headerAuthBaseline, 'none'),
    ).toBe(false);
    expect(connectionTestCanUseSaved(connForm, headerAuthBaseline, 'apiKey')).toBe(false);
  });

  it('falls back to adhoc when the user changed the api key so the new key is what gets tested', () => {
    const apiKeyBaseline: SavedProviderProbeBaseline = { ...headerAuthBaseline, authMode: 'apiKey', apiKey: 'saved-key' };
    expect(
      connectionTestCanUseSaved({ ...connForm, apiKey: 'saved-key' }, apiKeyBaseline, 'apiKey'),
    ).toBe(true);
    expect(
      connectionTestCanUseSaved({ ...connForm, apiKey: 'new-key' }, apiKeyBaseline, 'apiKey'),
    ).toBe(false);
  });

  it('falls back to adhoc when the user edited a request header (new header material takes precedence)', () => {
    expect(
      connectionTestCanUseSaved(
        { ...connForm, headers: [{ name: 'X-Tenant', value: 'acme' }] },
        headerAuthBaseline,
        'none',
      ),
    ).toBe(false);
    // 编辑态的空白占位行(name 为空)与基线空头视为一致 → 仍走 saved 探测。
    expect(
      connectionTestCanUseSaved(
        { ...connForm, headers: [{ name: '', value: '' }] },
        headerAuthBaseline,
        'none',
      ),
    ).toBe(true);
  });
});
