/**
 * OpenAI 图像模型发现。
 *
 * ChatGPT `model/list` / models_cache 只含聊天型号。图像成员来自 Platform
 * `GET /v1/models`（优先 Images API key，否则 ChatGPT OAuth bearer）。
 * 混排聊天清单里滤不出图像型号时保留本地目录兜底，不能当成账号空清单清空。
 */

import { categorize, type Provider } from '@cindy/model-providers';

import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../appSessionState.js';
import { createLogger, type Logger } from '../../logger.js';
import { getProviderSecretStore } from '../../secrets/providerSecretStore.js';
import { setDiscoveredProviderMediaModels } from '../active-catalog.js';
import {
  getChatgptBridgeAuth,
  invalidateChatgptBridgeAuth,
} from '../anthropic-responses-bridge-host.js';
import { hasCodexOAuthLoginReadOnly } from '../codex-oauth-readiness.js';
import { outboundFetch } from '../outbound-fetch.js';

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const HTTP_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_MODELS = 500;
const MAX_MODEL_ID_CHARS = 256;
const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

type MediaModel = NonNullable<Provider['imageModels']>[number];

export interface OpenAiMediaDiscoverySnapshot {
  imageModels?: MediaModel[];
}

export type OpenAiMediaCredentialKind = 'api-key' | 'oauth';

export interface OpenAiMediaDiscoveryDeps {
  hasCredential(): boolean;
  getCredential(): Promise<{ kind: OpenAiMediaCredentialKind; token: string } | null>;
  getCredentialGeneration(): number;
  getOwnerScopeKey(): string;
  isOwnerBoundaryPending(): boolean;
  fetchImplementation: typeof fetch;
  applySnapshot(snapshot: OpenAiMediaDiscoverySnapshot | null): void;
  onOAuthRejected?(failure: {
    status: number;
    body: string;
    failedAccessToken: string;
  }): void | Promise<void>;
  log: Pick<Logger, 'info' | 'warn'>;
}

function asModalities(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) return null;
  const out = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 64) return null;
    out.add(entry.toLowerCase());
  }
  return out;
}

function displayName(id: string): string {
  const bare = id.replace(/^openai\//, '');
  if (/^gpt-image-/i.test(bare)) {
    const rest = bare.slice('gpt-image-'.length);
    return `GPT Image ${rest
      .split('-')
      .filter(Boolean)
      .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
      .join(' ')}`;
  }
  if (/^dall-e-/i.test(bare)) {
    return `DALL·E ${bare.slice('dall-e-'.length)}`;
  }
  return bare
    .split('-')
    .filter(Boolean)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function isImageModel(id: string, item: Record<string, unknown>): boolean {
  const architecture = item.architecture as { output_modalities?: unknown } | undefined;
  const outputs = asModalities(
    item.output_modalities ?? item.outputModalities ?? architecture?.output_modalities,
  );
  if (outputs?.has('video') && !outputs.has('image')) return false;
  if (outputs?.has('image')) return true;
  return categorize(id) === 'image';
}

function itemId(item: unknown): string | null {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const rec = item as { id?: unknown; slug?: unknown };
  if (typeof rec.id === 'string') return rec.id;
  if (typeof rec.slug === 'string') return rec.slug;
  return null;
}

function itemName(item: unknown, id: string): string {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return displayName(id);
  const rec = item as { display_name?: unknown; name?: unknown };
  if (typeof rec.display_name === 'string' && rec.display_name.trim()) return rec.display_name;
  if (typeof rec.name === 'string' && rec.name.trim()) return rec.name;
  return displayName(id);
}

/** Official /v1/models payload → Cindy OpenAI image catalog entries. */
export function mapOpenAiMediaModels(raw: unknown): MediaModel[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const list = (raw as { data?: unknown; models?: unknown }).data
    ?? (raw as { models?: unknown }).models;
  if (!Array.isArray(list) || list.length > MAX_MODELS) return null;
  const seen = new Set<string>();
  const out: MediaModel[] = [];
  for (const entry of list) {
    const rawId = itemId(entry);
    if (
      !rawId ||
      rawId.length > MAX_MODEL_ID_CHARS ||
      /[\u0000-\u001f\u007f]/.test(rawId)
    ) {
      continue;
    }
    const rec = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : {};
    if (!isImageModel(rawId, rec)) continue;
    const id = rawId.startsWith('openai/') ? rawId : `openai/${rawId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: itemName(entry, rawId) });
  }
  const undated = new Set(
    out
      .map((model) => model.id.replace(/^openai\//, ''))
      .filter((id) => !DATED_SNAPSHOT.test(id)),
  );
  return out.filter((model) => {
    const bare = model.id.replace(/^openai\//, '');
    const base = bare.replace(DATED_SNAPSHOT, '');
    return !DATED_SNAPSHOT.test(bare) || !undated.has(base);
  });
}

async function readBoundedResponseText(
  response: Response,
  assertStillCurrent: () => void,
): Promise<string> {
  assertStillCurrent();
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    assertStillCurrent();
    throw new Error('OpenAI 图像模型列表响应过大');
  }
  if (!response.body) {
    assertStillCurrent();
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      assertStillCurrent();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new Error('OpenAI 图像模型列表响应过大');
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  assertStillCurrent();
  return Buffer.concat(chunks, total).toString('utf8');
}

export function createOpenAiMediaDiscovery(deps: OpenAiMediaDiscoveryDeps): {
  refresh(): Promise<boolean>;
  clear(): void;
} {
  const staleDiscovery = Symbol('stale OpenAI media discovery');
  let generation = 0;
  let appliedScopeKey: string | null = null;
  let inflight: {
    generation: number;
    ownerScopeKey: string;
    credentialGeneration: number;
    promise: Promise<boolean>;
  } | null = null;

  function syncScope(): string {
    const next = deps.getOwnerScopeKey();
    if (appliedScopeKey !== null && next !== appliedScopeKey) {
      generation += 1;
      inflight = null;
      deps.applySnapshot(null);
    }
    appliedScopeKey = next;
    return next;
  }

  function canApply(
    expectedGeneration: number,
    expectedScope: string,
    expectedCredentialGeneration: number,
  ): boolean {
    return (
      generation === expectedGeneration &&
      deps.getOwnerScopeKey() === expectedScope &&
      deps.getCredentialGeneration() === expectedCredentialGeneration &&
      !deps.isOwnerBoundaryPending() &&
      deps.hasCredential()
    );
  }

  function assertCurrent(
    expectedGeneration: number,
    expectedScope: string,
    expectedCredentialGeneration: number,
  ): void {
    if (!canApply(expectedGeneration, expectedScope, expectedCredentialGeneration)) {
      throw staleDiscovery;
    }
  }

  function refresh(): Promise<boolean> {
    const ownerScopeKey = syncScope();
    if (deps.isOwnerBoundaryPending() || !deps.hasCredential()) return Promise.resolve(false);
    const expectedGeneration = generation;
    const expectedCredentialGeneration = deps.getCredentialGeneration();
    if (
      inflight?.generation === expectedGeneration &&
      inflight.ownerScopeKey === ownerScopeKey &&
      inflight.credentialGeneration === expectedCredentialGeneration
    ) {
      return inflight.promise;
    }
    const flight = (async () => {
      try {
        const credential = await deps.getCredential();
        assertCurrent(expectedGeneration, ownerScopeKey, expectedCredentialGeneration);
        if (!credential) return false;
        const assertStillCurrent = (): void =>
          assertCurrent(expectedGeneration, ownerScopeKey, expectedCredentialGeneration);
        let token = credential.token;
        let kind = credential.kind;
        const signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          assertStillCurrent();
          const response = await deps.fetchImplementation(OPENAI_MODELS_URL, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            redirect: 'error',
            signal,
          });
          assertStillCurrent();
          const text = await readBoundedResponseText(response, assertStillCurrent);
          if (response.ok) {
            let payload: unknown;
            try {
              payload = JSON.parse(text) as unknown;
            } catch {
              throw new Error('OpenAI 图像模型列表返回了无效 JSON');
            }
            const imageModels = mapOpenAiMediaModels(payload);
            if (!imageModels) throw new Error('OpenAI 图像模型列表结构无效');
            // ChatGPT OAuth 的 /v1/models 经常只有聊天型号。空图像结果不能覆盖本地目录。
            if (imageModels.length === 0) {
              if (kind === 'api-key') {
                assertStillCurrent();
                deps.applySnapshot({ imageModels });
                deps.log.info('OpenAI media models refreshed', { imageModels: 0, kind });
                return true;
              }
              deps.log.info(
                'OpenAI media discovery found no image models on the chat-capable list; keeping catalog fallback',
                { kind },
              );
              return false;
            }
            assertStillCurrent();
            deps.applySnapshot({ imageModels });
            deps.log.info('OpenAI media models refreshed', {
              imageModels: imageModels.length,
              kind,
            });
            return true;
          }
          const recovery =
            attempt === 0 &&
            kind === 'oauth' &&
            (response.status === 401 || response.status === 403) &&
            deps.onOAuthRejected
              ? await Promise.resolve(
                  deps.onOAuthRejected({
                    status: response.status,
                    body: text.slice(0, 8 * 1024),
                    failedAccessToken: token,
                  }),
                )
                  .then(() => true)
                  .catch(() => false)
              : false;
          assertStillCurrent();
          if (recovery) {
            const next = await deps.getCredential();
            assertStillCurrent();
            if (next?.kind === 'oauth' && next.token !== token) {
              token = next.token;
              kind = next.kind;
              continue;
            }
          }
          throw new Error(`OpenAI 图像模型发现失败(HTTP ${response.status})`);
        }
        throw new Error('OpenAI 图像模型发现失败:认证恢复重试耗尽');
      } catch (error) {
        if (error === staleDiscovery) return false;
        deps.log.warn('OpenAI media model discovery failed; keeping current catalog fallback', {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    })().finally(() => {
      if (inflight?.promise === flight) inflight = null;
    });
    inflight = {
      generation: expectedGeneration,
      ownerScopeKey,
      credentialGeneration: expectedCredentialGeneration,
      promise: flight,
    };
    return flight;
  }

  function clear(): void {
    generation += 1;
    appliedScopeKey = deps.getOwnerScopeKey();
    inflight = null;
    deps.applySnapshot(null);
  }

  return { refresh, clear };
}

function imagesApiKey(): string {
  return getProviderSecretStore().get('openai-images')?.trim() ?? '';
}

const log = createLogger('model-discovery:openai-media');
let credentialGeneration = 0;

const discovery = createOpenAiMediaDiscovery({
  hasCredential: () => Boolean(imagesApiKey()) || hasCodexOAuthLoginReadOnly(),
  getCredential: async () => {
    const key = imagesApiKey();
    if (key) return { kind: 'api-key', token: key };
    if (!hasCodexOAuthLoginReadOnly()) return null;
    const auth = await getChatgptBridgeAuth();
    return { kind: 'oauth', token: auth.accessToken };
  },
  getCredentialGeneration: () => credentialGeneration,
  getOwnerScopeKey: () => activeOwnerScopeKey(),
  isOwnerBoundaryPending: () => isAppSessionBoundaryPending(),
  fetchImplementation: ((url, init) => outboundFetch(url as string, init)) as typeof fetch,
  applySnapshot: (snapshot) => setDiscoveredProviderMediaModels('openai', snapshot),
  onOAuthRejected: async (failure) => {
    await invalidateChatgptBridgeAuth(failure);
  },
  log,
});

export const refreshOpenAiMediaModels = (): Promise<boolean> => discovery.refresh();
export const clearOpenAiMediaModels = (): void => {
  credentialGeneration += 1;
  discovery.clear();
};
