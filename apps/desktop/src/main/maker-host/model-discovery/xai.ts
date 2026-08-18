/** xAI SuperGrok account model discovery and owner-scoped last-known-good snapshot. */

import fsp from 'node:fs/promises';
import path from 'node:path';

import type { Effort } from '@cindy/model-providers';

import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../../appSessionState.js';
import { createLogger, type Logger } from '../../logger.js';
import { setXaiDiscoveredModels, type XaiDiscoveredModel } from '../active-catalog.js';
import { getGrokAccessToken, hasGrokOAuthLogin, peekGrokAccessToken } from '../grok-oauth-login.js';
import { outboundFetch } from '../outbound-fetch.js';
import { invalidateXaiBridgeAuth } from '../xai-auth-invalidation-host.js';
import type {
  XaiBridgeAuthFailure,
  XaiBridgeAuthInvalidationResult,
} from '../xai-bridge-auth-invalidation.js';
import type { AuthoritativeAccountModelSnapshot } from './connection-source.js';
import { getNativeProviderAuthSource } from '../nativeProviderAuthBinding.js';

export const XAI_ACCOUNT_USER_URL = 'https://cli-chat-proxy.grok.com/v1/user?include=subscription';
export const XAI_ACCOUNT_MODELS_URL = 'https://cli-chat-proxy.grok.com/v1/models';
export const XAI_GROK_CLIENT_VERSION = '1.0.3';

const HTTP_TIMEOUT_MS = 15_000;
const MAX_ERROR_BODY_BYTES = 8 * 1024;
const VALID_EFFORTS: ReadonlySet<string> = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
const log = createLogger('model-discovery:xai');
let cacheMutationQueue: Promise<void> = Promise.resolve();
let cacheTempSequence = 0;
let refreshInflight: Promise<boolean> | null = null;
let refreshInflightScope: string | number | null = null;
let refreshInflightToken: string | null = null;

export interface XaiModelDiscoveryDeps {
  fetchImpl: typeof fetch;
  getAccessToken(): Promise<string>;
  peekAccessToken(): string | null;
  hasLogin(): boolean;
  getConnectionSource(): 'explicit-provider-oauth' | null;
  getScopeKey(): string | number;
  cacheFilePath(): string;
  applySnapshot(models: readonly XaiDiscoveredModel[]): void;
  invalidateAuth(failure: XaiBridgeAuthFailure): Promise<XaiBridgeAuthInvalidationResult>;
  log: Pick<Logger, 'info' | 'warn'>;
}

const DEFAULT_DEPS: XaiModelDiscoveryDeps = {
  fetchImpl: outboundFetch,
  getAccessToken: getGrokAccessToken,
  peekAccessToken: peekGrokAccessToken,
  hasLogin: hasGrokOAuthLogin,
  getConnectionSource: () =>
    getNativeProviderAuthSource('xai') === 'explicit-provider-oauth'
      ? 'explicit-provider-oauth'
      : null,
  getScopeKey: activeOwnerScopeKey,
  cacheFilePath: () => ownerScopedUserDataPath('model-discovery', 'xai-models.json'),
  applySnapshot: setXaiDiscoveredModels,
  invalidateAuth: invalidateXaiBridgeAuth,
  log,
};

interface XaiUserIdentity {
  userId: string;
  email?: string;
}

class XaiDiscoveryHttpError extends Error {
  constructor(
    readonly stage: 'user' | 'models',
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`xAI account model discovery ${stage} request failed (${status})`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function positiveIntegerField(
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

function effort(value: unknown): Effort | undefined {
  return typeof value === 'string' && VALID_EFFORTS.has(value) ? (value as Effort) : undefined;
}

function parseReasoningEfforts(raw: unknown): { efforts?: Effort[]; declaredDefault?: Effort } {
  if (!Array.isArray(raw)) return {};
  const efforts: Effort[] = [];
  let declaredDefault: Effort | undefined;
  for (const item of raw) {
    const value = effort(typeof item === 'string' ? item : isRecord(item) ? item.value : undefined);
    if (!value || efforts.includes(value)) continue;
    efforts.push(value);
    if (isRecord(item) && item.default === true) declaredDefault = value;
  }
  return { efforts, declaredDefault };
}

function canonicalModelId(raw: string): string {
  return raw.startsWith('xai/') ? raw : `xai/${raw}`;
}

/** Parse membership without guessing missing capability fields. */
export function parseXaiAccountModels(payload: unknown): XaiDiscoveredModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('xAI account model discovery returned an invalid models payload');
  }
  const seen = new Set<string>();
  const models: XaiDiscoveredModel[] = [];
  for (const value of payload.data) {
    if (!isRecord(value)) continue;
    const meta = isRecord(value._meta) ? value._meta : {};
    if (value.hidden === true || meta.hidden === true) continue;
    const rawId =
      stringField(value, 'model', 'modelId', 'id') ?? stringField(meta, 'model', 'modelId');
    if (!rawId) continue;
    const id = canonicalModelId(rawId);
    if (seen.has(id)) continue;
    seen.add(id);
    const contextWindow =
      positiveIntegerField(value, 'contextWindow', 'context_window') ??
      positiveIntegerField(meta, 'contextWindow', 'totalContextTokens');
    const maxOutput = positiveIntegerField(value, 'maxCompletionTokens', 'max_completion_tokens');
    const parsedEfforts = parseReasoningEfforts(
      value.reasoningEfforts ?? value.reasoning_efforts ?? meta.reasoningEfforts,
    );
    const declaredDefault =
      parsedEfforts.declaredDefault ??
      effort(value.reasoningEffort ?? value.reasoning_effort ?? meta.reasoningEffort);
    let efforts = parsedEfforts.efforts;
    if (value.supportsReasoningEffort === false || value.supports_reasoning_effort === false) {
      efforts = [];
    } else if (efforts === undefined && declaredDefault) {
      efforts = [declaredDefault];
    } else if (efforts && declaredDefault && !efforts.includes(declaredDefault)) {
      efforts = [...efforts, declaredDefault];
    }
    const name = stringField(value, 'name');
    const description = stringField(value, 'description');
    models.push({
      id,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      ...(contextWindow !== undefined ? { contextWindow, contextWindowVerified: true } : {}),
      ...(maxOutput !== undefined ? { maxOutput } : {}),
      ...(efforts !== undefined ? { efforts } : {}),
      ...(declaredDefault !== undefined ? { defaultEffort: declaredDefault } : {}),
    });
  }
  return models;
}

function parseCachedModels(payload: unknown): XaiDiscoveredModel[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.models)) return null;
  const out: XaiDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const value of payload.models) {
    if (!isRecord(value) || typeof value.id !== 'string') return null;
    const id = canonicalModelId(value.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const efforts =
      value.efforts === undefined ? undefined : parseReasoningEfforts(value.efforts).efforts;
    const defaultEffort = effort(value.defaultEffort);
    if (value.efforts !== undefined && efforts === undefined) return null;
    out.push({
      id,
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
      ...(positiveIntegerField(value, 'contextWindow') !== undefined
        ? {
            contextWindow: positiveIntegerField(value, 'contextWindow'),
            ...(value.contextWindowVerified === true ? { contextWindowVerified: true } : {}),
          }
        : {}),
      ...(positiveIntegerField(value, 'maxOutput') !== undefined
        ? { maxOutput: positiveIntegerField(value, 'maxOutput') }
        : {}),
      ...(efforts !== undefined ? { efforts } : {}),
      ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    });
  }
  return out;
}

function enqueueCacheMutation(
  task: () => Promise<void>,
  deps: XaiModelDiscoveryDeps,
): Promise<void> {
  cacheMutationQueue = cacheMutationQueue.then(task).catch((error) => {
    deps.log.warn('xAI models cache mutation failed', { error: String(error) });
  });
  return cacheMutationQueue;
}

function isCurrent(deps: XaiModelDiscoveryDeps, scopeKey: string | number, token: string): boolean {
  return deps.getScopeKey() === scopeKey && deps.hasLogin() && deps.peekAccessToken() === token;
}

async function persistSnapshot(
  deps: XaiModelDiscoveryDeps,
  scopeKey: string | number,
  token: string,
  models: readonly XaiDiscoveredModel[],
): Promise<void> {
  const payload = JSON.stringify({ fetchedAt: new Date().toISOString(), models }, null, 2);
  await enqueueCacheMutation(async () => {
    if (!isCurrent(deps, scopeKey, token)) return;
    const file = deps.cacheFilePath();
    const temp = `${file}.${process.pid}.${(cacheTempSequence += 1)}.tmp`;
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(temp, payload, 'utf-8');
      if (!isCurrent(deps, scopeKey, token)) return;
      await fsp.rename(temp, file);
    } finally {
      await fsp.rm(temp, { force: true }).catch(() => undefined);
    }
  }, deps);
}

export async function loadXaiModelsFromDiskCache(
  injected: Partial<XaiModelDiscoveryDeps> = {},
): Promise<boolean> {
  const deps = { ...DEFAULT_DEPS, ...injected };
  if (!deps.hasLogin() || deps.getConnectionSource() !== 'explicit-provider-oauth') return false;
  const scopeKey = deps.getScopeKey();
  const token = deps.peekAccessToken();
  if (!token) return false;
  try {
    const parsed = parseCachedModels(JSON.parse(await fsp.readFile(deps.cacheFilePath(), 'utf-8')));
    if (parsed === null || !isCurrent(deps, scopeKey, token)) return false;
    deps.applySnapshot(parsed);
    return true;
  } catch {
    return false;
  }
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  return text.slice(0, MAX_ERROR_BODY_BYTES);
}

async function fetchJson(
  deps: XaiModelDiscoveryDeps,
  stage: 'user' | 'models',
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await deps.fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new Error(`xAI account model discovery ${stage} request failed`);
  }
  if (!response.ok)
    throw new XaiDiscoveryHttpError(stage, response.status, await readErrorBody(response));
  try {
    return await response.json();
  } catch {
    throw new Error(`xAI account model discovery ${stage} returned invalid JSON`);
  }
}

/** SuperGrok cli-chat-proxy 共用请求头。用量查询与模型发现走同一套。 */
export function buildXaiCliProxyHeaders(
  accessToken: string,
  extras?: { userId?: string },
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-grok-client-version': XAI_GROK_CLIENT_VERSION,
    'x-grok-client-mode': 'interactive',
    ...(extras?.userId ? { 'x-userid': extras.userId } : {}),
  };
}

function baseHeaders(accessToken: string): Record<string, string> {
  return buildXaiCliProxyHeaders(accessToken);
}

function parseUserIdentity(payload: unknown): XaiUserIdentity {
  if (!isRecord(payload))
    throw new Error('xAI account model discovery returned an invalid user payload');
  const userId = stringField(payload, 'userId');
  if (!userId) throw new Error('xAI account model discovery user payload omitted userId');
  const email = stringField(payload, 'email');
  return { userId, ...(email ? { email } : {}) };
}

async function discoverOnce(
  deps: XaiModelDiscoveryDeps,
  scopeKey: string | number,
  token: string,
): Promise<XaiDiscoveredModel[] | null> {
  const identity = parseUserIdentity(
    await fetchJson(deps, 'user', XAI_ACCOUNT_USER_URL, baseHeaders(token)),
  );
  if (!isCurrent(deps, scopeKey, token)) return null;
  const models = await fetchJson(deps, 'models', XAI_ACCOUNT_MODELS_URL, {
    ...baseHeaders(token),
    'x-userid': identity.userId,
    ...(identity.email ? { 'x-email': identity.email } : {}),
  });
  if (!isCurrent(deps, scopeKey, token)) return null;
  return parseXaiAccountModels(models);
}

async function runRefresh(
  deps: XaiModelDiscoveryDeps,
  onAccessTokenResolved?: (token: string) => void,
): Promise<boolean> {
  const connectionSource = deps.getConnectionSource();
  if (connectionSource !== 'explicit-provider-oauth') return false;
  const scopeKey = deps.getScopeKey();
  let token = await deps.getAccessToken();
  onAccessTokenResolved?.(token);
  if (!isCurrent(deps, scopeKey, token)) return false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const models = await discoverOnce(deps, scopeKey, token);
      if (models === null || !isCurrent(deps, scopeKey, token)) return false;
      const snapshot: AuthoritativeAccountModelSnapshot<XaiDiscoveredModel> = {
        source: connectionSource,
        authoritative: true,
        models,
      };
      deps.applySnapshot(snapshot.models);
      await persistSnapshot(deps, scopeKey, token, models);
      deps.log.info('xAI account model discovery applied', { modelCount: models.length });
      return true;
    } catch (error) {
      if (!(error instanceof XaiDiscoveryHttpError) || attempt > 0) {
        deps.log.warn('xAI account model discovery failed; keeping current/LKG snapshot', {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      if (error.status !== 401 && error.status !== 403) return false;
      const outcome = await deps.invalidateAuth({
        status: error.status,
        body: error.responseBody,
        failedAccessToken: token,
      });
      if (outcome !== 'refreshed' && outcome !== 'superseded') return false;
      if (deps.getScopeKey() !== scopeKey || !deps.hasLogin()) return false;
      token = await deps.getAccessToken();
      if (!isCurrent(deps, scopeKey, token)) return false;
    }
  }
  return false;
}

export async function refreshXaiModelsFromHttp(
  injected: Partial<XaiModelDiscoveryDeps> = {},
): Promise<boolean> {
  const deps = { ...DEFAULT_DEPS, ...injected };
  const scopeKey = deps.getScopeKey();
  // The owner scope remains stable across an xAI account switch. Only reuse a
  // flight when it belongs to the same currently-bound access token; otherwise
  // the new account must start its own discovery immediately. The old flight
  // is still guarded by isCurrent and cannot apply or persist its late result.
  const currentToken = deps.peekAccessToken();
  if (
    refreshInflight &&
    currentToken &&
    refreshInflightScope === scopeKey &&
    refreshInflightToken === currentToken
  ) {
    return refreshInflight;
  }
  let flight!: Promise<boolean>;
  flight = runRefresh(deps, (resolvedToken) => {
    // getAccessToken may rotate an expired token before the first network request.
    // Re-key the active flight to that resolved token so a concurrent startup/
    // readiness refresh joins it instead of duplicating the same account discovery.
    // A real account switch still has a different current token and starts a new flight.
    if (refreshInflight === flight) refreshInflightToken = resolvedToken;
  }).finally(() => {
    if (refreshInflight === flight) {
      refreshInflight = null;
      refreshInflightScope = null;
      refreshInflightToken = null;
    }
  });
  refreshInflight = flight;
  refreshInflightScope = scopeKey;
  refreshInflightToken = currentToken;
  return flight;
}

/** Clear process membership on logout/account switch, but retain the owner's disk LKG. */
export function clearXaiDiscoveredModels(): void {
  setXaiDiscoveredModels(null);
}

/** Explicit re-login may replace the SuperGrok account under the same Cindy owner. */
export async function discardXaiModelsDiskCache(
  injected: Partial<XaiModelDiscoveryDeps> = {},
): Promise<void> {
  const deps = { ...DEFAULT_DEPS, ...injected };
  const scopeKey = deps.getScopeKey();
  const file = deps.cacheFilePath();
  await enqueueCacheMutation(async () => {
    if (deps.getScopeKey() !== scopeKey) return;
    await fsp.rm(file, { force: true });
  }, deps);
}

export function waitForXaiDiscoveryIdleForTest(): Promise<void> {
  return cacheMutationQueue;
}

export function resetXaiDiscoveryForTest(): void {
  refreshInflight = null;
  refreshInflightScope = null;
  refreshInflightToken = null;
  cacheMutationQueue = Promise.resolve();
}
