import { createCipheriv, createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createZCodeNativeAuth } from '../zcode-native-auth.js';
import { createZCodeNativeHost } from '../zcode-host.js';
import type { ZCodeRpcClient, ZCodeRpcClientOptions } from '@cindy/maker-core';

// Test value: the new native Team auth entrypoint must preserve ZCode's selected
// account/project, obtain only a short-lived token, and never mutate its login.
// Existing provider tests do not exercise ZCode's encrypted store or reverse RPC.
// Minimal failures are an encrypted selected login, an unauthorized project, or a
// selection change while a token request is pending. Tier: unit (memory I/O only).
const secret = 'not-a-real-credential-secret';
const settingsPath = '/fixture/setting.json';
const credentialsPath = '/fixture/credentials.json';
const team = { kind: 'team-coding-plan', productId: 'coding-team', organizationId: 'org-test', projectId: 'project-test' };

function encrypted(value: string): string {
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), Buffer.alloc(12, 7));
  const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${Buffer.alloc(12, 7).toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${bytes.toString('base64url')}`;
}

function fixture(family: 'bigmodel' | 'zai' = 'bigmodel') {
  let now = 1_800_000_000_000;
  const settings = { providerFamilyDomain: family, providerFamilyConnectionSelections: { [family]: { ...team } } };
  const credentials: Record<string, string> = {
    [`oauth:${family}:access_token`]: encrypted('invalid-fixture-login'),
    [`oauth:${family}:user_info`]: encrypted(JSON.stringify({ id: 'fixture-account' })),
    zcodejwttoken: encrypted('invalid-fixture-jwt'),
    // An unrelated corrupted entry must not be decrypted, logged or repaired.
    'unrelated-secret': 'enc:v1:broken',
  };
  const readText = vi.fn(async (file: string) => {
    if (file === settingsPath) return JSON.stringify(settings);
    if (file === credentialsPath) return JSON.stringify(credentials);
    throw new Error('unexpected fixture path');
  });
  const request = vi.fn(async (url: string, init: RequestInit): Promise<unknown> => {
    if (url.endsWith('/getCustomerInfo')) return { code: 200, data: { organizations: [{ organizationId: team.organizationId, projects: [{ projectId: team.projectId, projectType: 2 }] }] } };
    if (url.endsWith('/querySubscribeDetail')) return { code: 200, data: { hasSubscription: true, status: 'EFFECTIVE', memberGrantStatus: 'VALID', productId: team.productId } };
    if (url.endsWith('/api_keys')) return { code: 0, data: [{ name: 'zcode-team-api-key', keyType: 2, apiKey: 'fixture-key-id' }] };
    if (url.endsWith('/access_tokens') && init.method === 'POST') return { code: 200, data: { enable: true, accessToken: 'invalid-fixture-project-token', tokenType: 'Bearer', expiresIn: 3600, expiresAt: now / 1000 + 3600 } };
    throw new Error('unexpected fixture request');
  });
  const auth = createZCodeNativeAuth({ settingsPath, credentialsPath, credentialSecret: secret, readText, request, now: () => now });
  return { auth, settings, credentials, request, readText, tick: (ms: number) => { now += ms; }, family };
}

function params(providerId: string, extra: Record<string, unknown> = {}) {
  return { providerId, modelSelection: { providerId, modelId: 'fixture-model' }, accountAccess: { type: 'zhipu-account', accountType: providerId.includes(':zai-') ? 'zai' : 'bigmodel', mode: 'team-coding-plan', entitled: true }, reason: 'before-request', ...extra };
}

describe('ZCode native Team authorization', () => {
  it.each(['bigmodel', 'zai'] as const)('uses the selected %s team and leaves native files read-only', async (family) => {
    const f = fixture(family);
    const binding = await f.auth.capture();
    const result = await f.auth.resolve(binding, params(binding.providerId));
    expect(result).toEqual({ headersApplied: true, requestAuth: { apiKey: 'invalid-fixture-project-token', apiKeyId: 'fixture-key-id', accountScope: binding.scope } });
    const origin = family === 'zai' ? 'https://api.z.ai' : 'https://bigmodel.cn';
    expect(f.request.mock.calls.map(([url]) => new URL(url).origin)).toEqual([origin, origin, origin, origin]);
    expect(f.request.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'GET', 'GET', 'POST']);
    expect(f.request.mock.calls.at(-1)?.[1]).toMatchObject({ headers: { Authorization: 'Bearer invalid-fixture-login' } });
    expect(f.readText.mock.calls.every(([file]) => file === settingsPath || file === credentialsPath)).toBe(true);
    expect(JSON.stringify(binding)).not.toContain('fixture-login');
  });

  it('does not issue a token for a project that is no longer a team membership', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ code: 200, data: { organizations: [] } });
    const binding = await f.auth.capture();
    await expect(f.auth.resolve(binding, params(binding.providerId))).rejects.toMatchObject({ code: 'ZCODE_TEAM_UNAVAILABLE' });
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('does not create a permanent key when the native team key is missing', async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (url, init) => url.endsWith('/api_keys') ? { code: 200, data: [] } : original(url, init));
    const binding = await f.auth.capture();
    await expect(f.auth.resolve(binding, params(binding.providerId))).rejects.toMatchObject({ code: 'ZCODE_TEAM_KEY_MISSING' });
    expect(f.request.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });

  it('rejects expired or unassigned team plans before token issuance', async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (url, init) => url.endsWith('/querySubscribeDetail') ? { code: 200, data: { hasSubscription: true, status: 'EFFECTIVE', memberGrantStatus: 'UNASSIGNED' } } : original(url, init));
    const binding = await f.auth.capture();
    await expect(f.auth.resolve(binding, params(binding.providerId))).rejects.toMatchObject({ code: 'ZCODE_TEAM_UNAVAILABLE' });
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it('accepts valid project entitlement when its catalog product ID differs from the saved selection ID', async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (url, init) => url.endsWith('/querySubscribeDetail')
      ? { code: 200, data: { hasSubscription: true, status: 'EFFECTIVE', memberGrantStatus: 'VALID', productId: 'catalog-product-not-selection-key' } }
      : original(url, init));
    const binding = await f.auth.capture();
    await expect(f.auth.resolve(binding, params(binding.providerId))).resolves.toMatchObject({ headersApplied: true });
    f.settings.providerFamilyConnectionSelections.bigmodel.productId = 'different-native-selection';
    await expect(f.auth.resolve(binding, params(binding.providerId))).rejects.toMatchObject({ code: 'ZCODE_AUTH_SCOPE_CHANGED' });
  });

  it('rejects a foreign provider or scope before reading any remote account data', async () => {
    const f = fixture();
    const binding = await f.auth.capture();
    await expect(f.auth.resolve(binding, params('account:zai-team-coding-plan'))).rejects.toMatchObject({ code: 'ZCODE_AUTH_SCOPE_CHANGED' });
    await expect(f.auth.resolve(binding, params(binding.providerId, { expectedAccountScope: 'other' }))).rejects.toMatchObject({ code: 'ZCODE_AUTH_SCOPE_CHANGED' });
    expect(f.request).not.toHaveBeenCalled();
  });

  it('does not deliver a token after the native account changes during issuance', async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (url.endsWith('/access_tokens')) f.credentials['oauth:bigmodel:access_token'] = encrypted('different-invalid-login');
      return response;
    });
    const binding = await f.auth.capture();
    await expect(f.auth.resolve(binding, params(binding.providerId))).rejects.toMatchObject({ code: 'ZCODE_AUTH_SCOPE_CHANGED' });
  });

  it('uses an in-memory token cache and refreshes only its rejected generation', async () => {
    const f = fixture();
    const binding = await f.auth.capture();
    await f.auth.resolve(binding, params(binding.providerId));
    await f.auth.resolve(binding, params(binding.providerId));
    expect(f.request).toHaveBeenCalledTimes(4);
    await f.auth.resolve(binding, params(binding.providerId, { expectedAccountScope: binding.scope, rejectedProjectTokenFingerprint: 'not-current-fingerprint' }));
    expect(f.request).toHaveBeenCalledTimes(4);
    await f.auth.resolve(binding, params(binding.providerId, { expectedAccountScope: binding.scope, rejectedProjectTokenFingerprint: createHash('sha256').update('invalid-fixture-project-token').digest('hex') }));
    expect(f.request).toHaveBeenCalledTimes(8);
    f.tick(3_500_000);
    await f.auth.resolve(binding, params(binding.providerId));
    expect(f.request).toHaveBeenCalledTimes(12);
  });

  it('sanitizes response and decryption errors without exposing credentials', async () => {
    const f = fixture();
    const binding = await f.auth.capture();
    f.request.mockRejectedValueOnce(new Error('Authorization: Bearer invalid-fixture-login'));
    await expect(f.auth.resolve(binding, params(binding.providerId))).rejects.toMatchObject({ message: 'ZCODE_AUTH_REQUEST_FAILED' });
    f.credentials['oauth:bigmodel:access_token'] = 'enc:v1:bad';
    await expect(f.auth.capture()).rejects.toMatchObject({ message: 'ZCODE_CREDENTIAL_UNAVAILABLE' });
  });

  it('does not release issued material after cancellation or host disposal', async () => {
    for (const stop of ['cancel', 'dispose'] as const) {
      const f = fixture();
      const controller = new AbortController();
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (url, init) => {
        const response = await original(url, init);
        if (url.endsWith('/access_tokens')) {
          if (stop === 'cancel') controller.abort();
          else f.auth.clear();
        }
        return response;
      });
      const binding = await f.auth.capture();
      await expect(f.auth.resolve(binding, params(binding.providerId), controller.signal)).rejects.toMatchObject({
        code: stop === 'cancel' ? 'ZCODE_CANCELLED' : 'ZCODE_AUTH_SCOPE_CHANGED',
      });
    }
  });

  it('keeps a shared issuance alive when only its first waiting session is cancelled', async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    let sharedSignal: AbortSignal | undefined;
    f.request.mockImplementation(async (url, init) => {
      if (!url.endsWith('/getCustomerInfo')) return original(url, init);
      sharedSignal = init.signal!;
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        init.signal!.addEventListener('abort', () => reject(new Error('cancelled fixture request')), { once: true });
        entered();
      });
      return original(url, init);
    });
    const binding = await f.auth.capture();
    const first = new AbortController();
    const firstResult = f.auth.resolve(binding, params(binding.providerId), first.signal).then(() => 'ready', (e) => e.code);
    await started;
    const secondResult = f.auth.resolve(binding, params(binding.providerId)).then(() => 'ready', (e) => e.code);
    // Both calls are waiting on the same deliberately held external request.
    await new Promise<void>((resolve) => setImmediate(resolve));
    first.abort();
    const firstOutcome = await firstResult;
    const sharedWasAborted = sharedSignal!.aborted;
    release();
    expect(firstOutcome).toBe('ZCODE_CANCELLED');
    expect(await secondResult).toBe('ready');
    expect(sharedWasAborted).toBe(false);
    expect(f.request).toHaveBeenCalledTimes(4);
  });

  it('aborts shared issuance when the last waiter leaves or its native authorization is cleared', async () => {
    for (const end of ['last-waiter', 'clear'] as const) {
      const f = fixture();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      let sharedSignal!: AbortSignal;
      f.request.mockImplementation(async (_url, init) => {
        sharedSignal = init.signal!;
        await new Promise<void>((_resolve, reject) => {
          sharedSignal.addEventListener('abort', () => reject(new Error('cancelled fixture request')), { once: true });
          entered();
        });
      });
      const binding = await f.auth.capture();
      const first = new AbortController();
      const second = new AbortController();
      const firstResult = f.auth.resolve(binding, params(binding.providerId), first.signal).catch((e) => e.code);
      await started;
      const secondResult = f.auth.resolve(binding, params(binding.providerId), second.signal).catch((e) => e.code);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (end === 'clear') f.auth.clear();
      else {
        first.abort();
        expect(sharedSignal.aborted).toBe(false);
        second.abort();
      }
      expect(await firstResult).toBe(end === 'clear' ? 'ZCODE_AUTH_SCOPE_CHANGED' : 'ZCODE_CANCELLED');
      expect(await secondResult).toBe(end === 'clear' ? 'ZCODE_AUTH_SCOPE_CHANGED' : 'ZCODE_CANCELLED');
      expect(sharedSignal.aborted).toBe(true);
    }
  });
});

describe('ZCode native host discovery', () => {
  function hostFixture() {
    const f = fixture();
    const requests: Array<{ method: string; params: unknown }> = [];
    const close = vi.fn(async () => {});
    const rpc: Pick<ZCodeRpcClient, 'request' | 'setRequestHandler' | 'close'> = {
      async request<T>(method: string, params: unknown): Promise<T> {
        requests.push({ method, params });
        const value = method === 'session/create' ? {
          session: { sessionId: 'fixture-discovery' },
          settings: { model: { available: [
            { ref: { providerId: 'account:bigmodel-team-coding-plan', modelId: 'native-model' }, label: 'Native model', contextWindow: 123456, maxOutputTokens: 4096, reasoning: { defaultLevel: 'high' } },
            { ref: { providerId: 'account:zai-team-coding-plan', modelId: 'other-model' }, label: 'Other account', contextWindow: 654321 },
          ] } },
        } : {};
        return value as T;
      },
      setRequestHandler() {}, close,
    };
    const createClient = vi.fn<(options: ZCodeRpcClientOptions) => typeof rpc>(() => rpc);
    const readText = vi.fn(async (file: string) => {
      if (file.endsWith('/setting.json')) return JSON.stringify(f.settings);
      if (file.endsWith('/credentials.json')) return JSON.stringify(f.credentials);
      if (file === '/fixture/builtin.json') return JSON.stringify({ schemaVersion: 1, revision: 33, config: { providerConfigRules: { providerRules: [
        { providerId: 'account:bigmodel-team-coding-plan', config: { access: { type: 'zhipu-account' } } },
        { providerId: 'account:zai-team-coding-plan', config: { access: { type: 'zhipu-account' } } },
      ] } } });
      throw new Error('unknown fixture path');
    });
    const prepareDirectory = vi.fn(async () => {});
    const scopeFiles = new Map<string, string>();
    const scopeIo = {
      read: async (file: string) => scopeFiles.get(file) ?? null,
      create: async (file: string, contents: string) => {
        if (scopeFiles.has(file)) return false;
        scopeFiles.set(file, contents);
        return true;
      },
    };
    const createHost = () => createZCodeNativeHost({
      runtimeDataDir: '/fixture/cindy-owner', homeDir: '/fixture/native-home',
      nodePath: '/fixture/node', cliPath: '/fixture/zcode.cjs', builtinConfigPath: '/fixture/builtin.json',
      env: {}, platform: 'linux', credentialSecret: secret,
      fileExists: async () => true, readText, prepareDirectory, request: f.request,
      createClient, sessionScopeFiles: scopeIo,
    });
    const host = createHost();
    return { ...f, host, readText, prepareDirectory, createClient, rpc, requests, close, createHost, scopeFiles, scopeIo };
  }

  it('probes installation without opening credentials, creating sessions or making account requests', async () => {
    const f = hostFixture();
    expect(await f.host.probe()).toEqual({ installed: true, authenticated: false, models: [] });
    expect(f.readText).not.toHaveBeenCalled();
    expect(f.createClient).not.toHaveBeenCalled();
    expect(f.prepareDirectory).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it('discovers native model metadata with a deferred empty session and isolates all history paths', async () => {
    const f = hostFixture();
    const status = await f.host.refresh();
    expect(status.authenticated).toBe(true);
    expect(status.models).toEqual([expect.objectContaining({ displayName: 'Native model', contextWindow: 123456, maxOutputTokens: 4096 })]);
    const options = f.host.getAgentOptions();
    expect(options.resolveModelSelection(status.models[0]!.id)).toEqual({ providerId: 'account:bigmodel-team-coding-plan', modelId: 'native-model', options: { reasoningLevel: 'high' } });
    expect(f.createClient.mock.calls[0]![0].env).toMatchObject({
      ZCODE_DATA_BASE_DIR: '/fixture/cindy-owner',
      ZCODE_STORAGE_DIR: '/fixture/cindy-owner/.zcode',
      ZCODE_SESSION_DB_PATH: '/fixture/cindy-owner/.zcode/cli/db/db.sqlite',
      ZCODE_LOG_DIR: '/fixture/cindy-owner/logs',
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: '/fixture/native-home/.zcode/v2/provider_config.json',
    });
    expect(f.requests.find((entry) => entry.method === 'session/create')?.params).toMatchObject({ persistence: 'deferred', titleGenerationEnabled: false, toolAllowlist: [] });
    expect(f.requests.at(-1)).toEqual({ method: 'session/close', params: { sessionId: 'fixture-discovery', expectedPersistence: 'deferred' } });
    expect(f.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(status)).not.toContain('fixture-login');
    expect(JSON.stringify(f.requests)).not.toContain('fixture-login');
  });

  it('pins each session to its original team even after native selection changes', async () => {
    const f = hostFixture();
    const status = await f.host.refresh();
    const options = f.host.getAgentOptions();
    const hooks = await options.createSessionHooks!({ workingDir: '/fixture/project', model: status.models[0]!.id });
    await hooks.prepareClient!(f.rpc as ZCodeRpcClient);
    f.settings.providerFamilyConnectionSelections.bigmodel.projectId = 'another-project';
    await expect(hooks.resolveProviderRuntimeHeaders!(params('account:bigmodel-team-coding-plan'), new AbortController().signal)).rejects.toMatchObject({ code: 'ZCODE_AUTH_SCOPE_CHANGED' });
    await f.host.dispose();
  });

  it('does not report ready when discovery process cleanup has failed', async () => {
    const f = hostFixture();
    f.close.mockRejectedValueOnce(new Error('fixture close failure'));
    expect(await f.host.refresh()).toMatchObject({ authenticated: false, errorReason: 'ZCODE_PROTOCOL_UNAVAILABLE', models: [] });
    await f.host.dispose();
    expect(f.close).toHaveBeenCalledTimes(2);
  });

  it('rejects old native history after a different team is selected and Cindy is restarted', async () => {
    const f = hostFixture();
    const status = await f.host.refresh();
    const model = status.models[0]!.id;
    const firstHooks = await f.host.getAgentOptions().createSessionHooks!({ workingDir: '/fixture/project', model });
    await firstHooks.onSessionReady!('sess_existing');
    await f.host.dispose();
    f.settings.providerFamilyConnectionSelections.bigmodel.projectId = 'different-project';
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (url, init) => url.endsWith('/getCustomerInfo')
      ? { code: 200, data: { organizations: [{ organizationId: team.organizationId, projects: [{ projectId: 'different-project', projectType: 2 }] }] } }
      : original(url, init));
    const reopened = f.createHost();
    await reopened.refresh();
    // The native model identity is unchanged; only the team behind it changed.
    await expect(reopened.getAgentOptions().createSessionHooks!({ workingDir: '/fixture/project', model, resumeSessionId: 'sess_existing' })).rejects.toMatchObject({ code: 'ZCODE_AUTH_SCOPE_CHANGED' });
    await reopened.dispose();
  });

  it('resumes the same native identity after OAuth renewal without persisting token material', async () => {
    const f = hostFixture();
    const status = await f.host.refresh();
    const model = status.models[0]!.id;
    const firstHooks = await f.host.getAgentOptions().createSessionHooks!({ workingDir: '/fixture/project', model });
    await firstHooks.onSessionReady!('sess_renewable');
    const receipt = [...f.scopeFiles.values()][0]!;
    expect(Object.keys(JSON.parse(receipt)).sort()).toEqual(['identityHash', 'version']);
    expect(JSON.parse(receipt).identityHash).toMatch(/^[a-f0-9]{64}$/);
    for (const value of ['fixture-account', team.organizationId, team.projectId, team.productId, 'fixture-login', 'fixture-jwt']) expect(receipt).not.toContain(value);
    expect([...f.scopeFiles.keys()][0]).toMatch(/^\/fixture\/cindy-owner\/session-scopes\/[a-f0-9]{64}\.json$/);
    await f.host.dispose();
    f.credentials['oauth:bigmodel:access_token'] = encrypted('renewed-invalid-login');
    f.credentials.zcodejwttoken = encrypted('renewed-invalid-jwt');
    const reopened = f.createHost();
    await reopened.refresh();
    const hooks = await reopened.getAgentOptions().createSessionHooks!({ workingDir: '/fixture/project', model, resumeSessionId: 'sess_renewable' });
    await expect(hooks.onSessionReady!('sess_renewable')).resolves.toBeUndefined();
    expect([...f.scopeFiles.values()]).toEqual([receipt]);
    await reopened.dispose();
  });

  it('rejects missing, malformed, or path-like native history receipts before starting the CLI', async () => {
    const f = hostFixture();
    const status = await f.host.refresh();
    const model = status.models[0]!.id;
    const nativeOptions = f.host.getAgentOptions();
    for (const nativeId of ['sess_missing', '../outside']) {
      await expect(nativeOptions.createSessionHooks!({ workingDir: '/fixture/project', model, resumeSessionId: nativeId })).rejects.toMatchObject({ code: 'ZCODE_SESSION_SCOPE_UNAVAILABLE' });
    }
    const hooks = await nativeOptions.createSessionHooks!({ workingDir: '/fixture/project', model });
    await hooks.onSessionReady!('sess_malformed');
    f.scopeFiles.set([...f.scopeFiles.keys()][0]!, '{invalid');
    await expect(nativeOptions.createSessionHooks!({ workingDir: '/fixture/project', model, resumeSessionId: 'sess_malformed' })).rejects.toMatchObject({ code: 'ZCODE_SESSION_SCOPE_UNAVAILABLE' });
    expect(f.createClient).toHaveBeenCalledTimes(1); // discovery only
    await f.host.dispose();
  });
});
