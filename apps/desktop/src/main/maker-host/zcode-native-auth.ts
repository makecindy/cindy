/**
 * Read-only ZCode Team authentication. The wire and credential format follow
 * zai-org/ZCode @ 3c5b227649371507ddc4eb46ac5133afe6db1cab (Apache-2.0):
 * credentialCipherProvider, accountProviderRequestAuthService and
 * project-access-token-client. Cindy never repairs or rewrites the native store.
 * Unlike the upstream desktop, this adapter never creates a permanent API key.
 */
import { createDecipheriv, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export type ZCodeNativeErrorCode =
  | 'ZCODE_NOT_INSTALLED'
  | 'ZCODE_NODE_MISSING'
  | 'ZCODE_CONFIG_UNAVAILABLE'
  | 'ZCODE_CREDENTIAL_UNAVAILABLE'
  | 'ZCODE_TEAM_SELECTION_REQUIRED'
  | 'ZCODE_TEAM_UNAVAILABLE'
  | 'ZCODE_TEAM_KEY_MISSING'
  | 'ZCODE_AUTH_SCOPE_CHANGED'
  | 'ZCODE_AUTH_REQUEST_FAILED'
  | 'ZCODE_AUTH_RESPONSE_INVALID'
  | 'ZCODE_SESSION_SCOPE_UNAVAILABLE'
  | 'ZCODE_CANCELLED'
  | 'ZCODE_PROTOCOL_UNAVAILABLE'
  | 'ZCODE_MODEL_UNAVAILABLE'
  | 'ZCODE_ENV_UNSUPPORTED';

/** Fixed codes only: errors can cross IPC and must not contain native responses. */
export class ZCodeNativeError extends Error {
  constructor(readonly code: ZCodeNativeErrorCode) {
    super(code);
    this.name = 'ZCodeNativeError';
  }
}

export function zcodeNativeErrorCode(error: unknown): ZCodeNativeErrorCode {
  return error instanceof ZCodeNativeError ? error.code : 'ZCODE_AUTH_REQUEST_FAILED';
}

export interface ZCodeTeamBinding {
  readonly providerId: string;
  readonly family: 'bigmodel' | 'zai';
  readonly scope: string;
  /** Stable across OAuth renewal; only this hash may enter a native-history receipt. */
  readonly identityHash: string;
  /** Host-private lifecycle; not an account identity or a wire credential. */
  readonly generation: number;
}

interface TeamSnapshot {
  family: 'bigmodel' | 'zai';
  providerId: string;
  organizationId: string;
  projectId: string;
  productId: string;
  accountId: string;
  loginToken: string;
  scope: string;
  identityHash: string;
}

export interface ZCodeNativeAuthOptions {
  settingsPath: string;
  credentialsPath: string;
  credentialSecret: string;
  readText?: (path: string) => Promise<string>;
  /** Injected network boundary; production defaults to fetch without redirects. */
  request?: (url: string, init: RequestInit) => Promise<unknown>;
  now?: () => number;
}

interface TokenMaterial {
  token: string;
  apiKeyId: string;
  fingerprint: string;
  expiresAt: number;
  refreshAt: number;
}

interface PendingIssuance {
  controller: AbortController;
  waiters: Set<symbol>;
  settled: boolean;
  promise: Promise<TokenMaterial>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(code: ZCodeNativeErrorCode): never {
  throw new ZCodeNativeError(code);
}

function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) fail('ZCODE_CANCELLED');
}

function successfulData(raw: unknown): unknown {
  const envelope = record(raw);
  if (envelope.success === false || ![0, 200, '0', '200'].includes(envelope.code as number | string)) {
    fail('ZCODE_AUTH_RESPONSE_INVALID');
  }
  return envelope.data;
}

function decrypt(value: unknown, key: Buffer): string {
  if (typeof value !== 'string') return '';
  if (!value.startsWith('enc:v1:')) return value;
  try {
    const parts = value.slice('enc:v1:'.length).split('.');
    if (parts.length !== 3) fail('ZCODE_CREDENTIAL_UNAVAILABLE');
    const [ivText, tagText, cipherText] = parts;
    const iv = Buffer.from(ivText!, 'base64url');
    const tag = Buffer.from(tagText!, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) fail('ZCODE_CREDENTIAL_UNAVAILABLE');
    const decoder = createDecipheriv('aes-256-gcm', key, iv);
    decoder.setAuthTag(tag);
    return Buffer.concat([decoder.update(Buffer.from(cipherText!, 'base64url')), decoder.final()]).toString('utf8');
  } catch {
    return fail('ZCODE_CREDENTIAL_UNAVAILABLE');
  }
}

async function defaultRequest(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: 'error' });
  if (!response.ok) fail('ZCODE_AUTH_REQUEST_FAILED');
  // No response body, status text, URL or fetch error is allowed in an exception.
  return response.json();
}

export function createZCodeNativeAuth(options: ZCodeNativeAuthOptions) {
  const readText = options.readText ?? ((file: string) => readFile(file, 'utf8'));
  const request = options.request ?? defaultRequest;
  const now = options.now ?? Date.now;
  const cipherKey = createHash('sha256').update(options.credentialSecret).digest();
  let currentScope: string | undefined;
  let generation = 0;
  let material: TokenMaterial | undefined;
  let pending: PendingIssuance | undefined;

  function clear(): void {
    generation += 1;
    currentScope = undefined;
    material = undefined;
    const previous = pending;
    pending = undefined;
    previous?.controller.abort();
  }

  async function snapshot(): Promise<TeamSnapshot> {
    let settings: Record<string, unknown>;
    let credentials: Record<string, unknown>;
    try {
      const [settingsJson, credentialsJson] = await Promise.all([
        readText(options.settingsPath), readText(options.credentialsPath),
      ]);
      settings = record(JSON.parse(settingsJson));
      credentials = record(JSON.parse(credentialsJson));
    } catch {
      clear();
      return fail('ZCODE_CONFIG_UNAVAILABLE');
    }
    try {
      const family = settings.providerFamilyDomain;
      if (family !== 'bigmodel' && family !== 'zai') fail('ZCODE_TEAM_SELECTION_REQUIRED');
      const selection = record(record(settings.providerFamilyConnectionSelections)[family]);
      if (selection.kind !== 'team-coding-plan') fail('ZCODE_TEAM_SELECTION_REQUIRED');
      const organizationId = text(selection.organizationId);
      const projectId = text(selection.projectId);
      const productId = text(selection.productId);
      if (!organizationId || !projectId || !productId) fail('ZCODE_TEAM_SELECTION_REQUIRED');
      // Read only the selected account's three fields. Unrelated store entries
      // may be corrupt, belong to other providers or hold refresh credentials.
      const loginToken = decrypt(credentials[`oauth:${family}:access_token`], cipherKey).trim();
      const jwt = decrypt(credentials.zcodejwttoken, cipherKey).trim();
      const profileJson = decrypt(credentials[`oauth:${family}:user_info`], cipherKey);
      let profile: Record<string, unknown>;
      try { profile = record(JSON.parse(profileJson)); } catch { return fail('ZCODE_CREDENTIAL_UNAVAILABLE'); }
      const accountId = text(profile.id);
      if (!accountId || !loginToken || (family === 'bigmodel' && loginToken === jwt)) {
        fail('ZCODE_CREDENTIAL_UNAVAILABLE');
      }
      const scope = createHash('sha256').update(JSON.stringify([
        family, accountId, 'team-coding-plan', [organizationId, projectId, productId], loginToken, jwt,
      ])).digest('hex');
      const identityHash = createHash('sha256').update(JSON.stringify([
        family, accountId, 'team-coding-plan', organizationId, projectId, productId,
      ])).digest('hex');
      if (scope !== currentScope) {
        clear();
        currentScope = scope;
      }
      return { family, providerId: `account:${family}-team-coding-plan`, organizationId, projectId, productId, accountId, loginToken, scope, identityHash };
    } catch (error) {
      clear();
      throw new ZCodeNativeError(zcodeNativeErrorCode(error));
    }
  }

  async function capture(): Promise<ZCodeTeamBinding> {
    const value = await snapshot();
    return Object.freeze({ providerId: value.providerId, family: value.family, scope: value.scope, identityHash: value.identityHash, generation });
  }

  async function assertCurrent(binding: ZCodeTeamBinding, signal?: AbortSignal): Promise<TeamSnapshot> {
    checkSignal(signal);
    const value = await snapshot();
    checkSignal(signal);
    if (value.scope !== binding.scope || value.providerId !== binding.providerId || generation !== binding.generation) {
      fail('ZCODE_AUTH_SCOPE_CHANGED');
    }
    return value;
  }

  async function issue(binding: ZCodeTeamBinding, signal?: AbortSignal): Promise<TokenMaterial> {
    const value = await assertCurrent(binding, signal);
    // Business origins are fixed to official production services. Never accept
    // a URL, auth header, organization or project supplied by the child process.
    const origin = value.family === 'zai' ? 'https://api.z.ai' : 'https://bigmodel.cn';
    const scopedRequest = async (suffix: string, init: RequestInit): Promise<unknown> => {
      await assertCurrent(binding, signal);
      const timeout = AbortSignal.timeout(15_000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let raw: unknown;
      try { raw = await request(`${origin}${suffix}`, { ...init, signal: combined, redirect: 'error' }); }
      catch { checkSignal(signal); return fail('ZCODE_AUTH_REQUEST_FAILED'); }
      await assertCurrent(binding, signal);
      return raw;
    };
    const basicHeaders = { Authorization: value.loginToken, 'Content-Type': 'application/json' };
    const customer = record(successfulData(await scopedRequest('/api/biz/customer/getCustomerInfo', { method: 'GET', headers: basicHeaders })));
    if (!Array.isArray(customer.organizations)) fail('ZCODE_AUTH_RESPONSE_INVALID');
    const authorized = customer.organizations.some((entry) => {
      const org = record(entry);
      return text(org.organizationId) === value.organizationId && Array.isArray(org.projects) && org.projects.some((entry) => {
        const project = record(entry);
        return text(project.projectId) === value.projectId && String(project.projectType) === '2';
      });
    });
    if (!authorized) fail('ZCODE_TEAM_UNAVAILABLE');
    const teamHeaders = { ...basicHeaders, 'bigmodel-organization': value.organizationId, 'bigmodel-project': value.projectId };
    const subscription = record(successfulData(await scopedRequest('/api/biz/team/subscribe/product/querySubscribeDetail', {
      method: 'GET', headers: { ...teamHeaders, Authorization: value.family === 'zai' ? `Bearer ${value.loginToken}` : value.loginToken },
    })));
    if (subscription.hasSubscription !== true || subscription.status !== 'EFFECTIVE' || subscription.memberGrantStatus !== 'VALID') {
      fail('ZCODE_TEAM_UNAVAILABLE');
    }
    // Upstream authorizes this response by organization/project and grant
    // status. Its catalog product ID is not the native selection key. The
    // original local selection still remains part of our frozen account scope.
    const keyPath = `/api/biz/v1/organization/${encodeURIComponent(value.organizationId)}/projects/${encodeURIComponent(value.projectId)}/api_keys`;
    const keys = successfulData(await scopedRequest(keyPath, { method: 'GET', headers: teamHeaders }));
    if (!Array.isArray(keys)) fail('ZCODE_AUTH_RESPONSE_INVALID');
    const key = keys.map(record).find((entry) => entry.name === 'zcode-team-api-key' && entry.keyType === 2 && text(entry.apiKey));
    if (!key) fail('ZCODE_TEAM_KEY_MISSING');
    const apiKeyId = text(key.apiKey);
    const startedAt = now();
    const token = record(successfulData(await scopedRequest(`${keyPath}/${encodeURIComponent(apiKeyId)}/access_tokens`, {
      method: 'POST', headers: { ...basicHeaders, Authorization: `Bearer ${value.loginToken}` },
      body: JSON.stringify({ clientType: 'zcode' }),
    })));
    if (token.enable !== undefined && typeof token.enable !== 'boolean') fail('ZCODE_AUTH_RESPONSE_INVALID');
    if (token.enable === false) fail('ZCODE_TEAM_UNAVAILABLE');
    const accessToken = text(token.accessToken);
    if (!accessToken || token.tokenType !== 'Bearer' || typeof token.expiresIn !== 'number' || typeof token.expiresAt !== 'number' || !Number.isFinite(token.expiresIn) || !Number.isFinite(token.expiresAt) || token.expiresIn <= 0) {
      fail('ZCODE_AUTH_RESPONSE_INVALID');
    }
    const expiresAt = Math.min(token.expiresAt * 1000, startedAt + token.expiresIn * 1000);
    if (expiresAt <= now()) fail('ZCODE_AUTH_RESPONSE_INVALID');
    await assertCurrent(binding, signal);
    return { token: accessToken, apiKeyId, fingerprint: createHash('sha256').update(accessToken).digest('hex'), expiresAt, refreshAt: expiresAt - 120_000 };
  }

  async function getMaterial(binding: ZCodeTeamBinding, rejectedFingerprint?: string, signal?: AbortSignal): Promise<TokenMaterial> {
    await assertCurrent(binding, signal);
    if (rejectedFingerprint && material?.fingerprint === rejectedFingerprint) material = undefined;
    if (material && now() < material.refreshAt && now() < material.expiresAt) return material;
    if (!pending) {
      const controller = new AbortController();
      const run: PendingIssuance = {
        controller, waiters: new Set(), settled: false,
        // Start in a microtask so the first waiter is registered before I/O.
        promise: Promise.resolve().then(() => issue(binding, controller.signal)).then((result) => {
          checkSignal(controller.signal);
          if (generation !== binding.generation || currentScope !== binding.scope) fail('ZCODE_AUTH_SCOPE_CHANGED');
          material = result;
          return result;
        }).finally(() => {
          run.settled = true;
          if (pending === run) pending = undefined;
        }),
      };
      pending = run;
      // Cancellation can remove every consumer before the shared I/O settles.
      void run.promise.catch(() => undefined);
    }
    const run = pending;
    try {
      const result = await new Promise<TokenMaterial>((resolve, reject) => {
        const waiter = Symbol();
        run.waiters.add(waiter);
        let waiting = true;
        const finish = (deliver: () => void) => {
          if (!waiting) return;
          waiting = false;
          signal?.removeEventListener('abort', cancel);
          run.waiters.delete(waiter);
          deliver();
          if (!run.settled && run.waiters.size === 0) {
            if (pending === run) pending = undefined;
            run.controller.abort();
          }
        };
        const cancel = () => finish(() => reject(new ZCodeNativeError('ZCODE_CANCELLED')));
        signal?.addEventListener('abort', cancel, { once: true });
        run.promise.then((value) => finish(() => resolve(value)), (cause) => finish(() => reject(cause)));
        if (signal?.aborted) cancel();
      });
      await assertCurrent(binding, signal);
      return result;
    } catch (cause) {
      checkSignal(signal);
      if (generation !== binding.generation || currentScope !== binding.scope) fail('ZCODE_AUTH_SCOPE_CHANGED');
      throw cause;
    }
  }

  async function check(binding: ZCodeTeamBinding, signal?: AbortSignal): Promise<void> {
    try { await getMaterial(binding, undefined, signal); }
    catch (error) { throw new ZCodeNativeError(zcodeNativeErrorCode(error)); }
  }

  async function resolve(binding: ZCodeTeamBinding, raw: Record<string, unknown>, signal?: AbortSignal) {
    try {
      const access = record(raw.accountAccess);
      const model = record(raw.modelSelection);
      if (raw.providerId !== binding.providerId || model.providerId !== binding.providerId || access.type !== 'zhipu-account' || access.accountType !== binding.family || access.mode !== 'team-coding-plan' || access.entitled !== true) {
        fail('ZCODE_AUTH_SCOPE_CHANGED');
      }
      if ((raw.expectedAccountScope !== undefined && raw.expectedAccountScope !== binding.scope) || (raw.rejectedProjectTokenFingerprint && !raw.expectedAccountScope)) {
        fail('ZCODE_AUTH_SCOPE_CHANGED');
      }
      const token = await getMaterial(binding, text(raw.rejectedProjectTokenFingerprint) || undefined, signal);
      return { headersApplied: true as const, requestAuth: { apiKey: token.token, apiKeyId: token.apiKeyId, accountScope: binding.scope } };
    } catch (error) {
      throw new ZCodeNativeError(zcodeNativeErrorCode(error));
    }
  }

  return { capture, assertCurrent, check, resolve, clear };
}
