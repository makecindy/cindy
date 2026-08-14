/**
 * xAI 图片／视频模型发现。
 *
 * xAI 为两类媒体分别提供类型化模型端点；这里只依据 modalities 接纳当前通用
 * 执行通道能完整兑现的型号，不依据型号名字做正则白名单。成功快照决定账号态存在性，
 * 失败保留同账号上次成功结果；登出／换号则先清快照并让旧请求失效。
 */

import type { Provider } from '@cindy/model-providers';

import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../appSessionState.js';
import { createLogger, type Logger } from '../../logger.js';
import { setDiscoveredProviderMediaModels } from '../active-catalog.js';
import {
  getGrokAccessToken,
  getGrokOAuthCredentialGeneration,
  hasGrokOAuthLogin,
} from '../grok-oauth-login.js';
import { outboundFetch } from '../outbound-fetch.js';
import { invalidateXaiBridgeAuth } from '../xai-auth-invalidation-host.js';
import type { XaiBridgeAuthInvalidationResult } from '../xai-bridge-auth-invalidation.js';

const XAI_API_BASE = 'https://api.x.ai/v1';
const HTTP_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_MODELS_PER_KIND = 200;
const MAX_MODEL_ID_CHARS = 256;

type MediaModel = NonNullable<Provider['imageModels']>[number];

export interface XaiMediaDiscoverySnapshot {
  imageModels?: MediaModel[];
  videoModels?: MediaModel[];
}

interface XaiMediaDiscoveryDeps {
  hasOAuthLogin(): boolean;
  getAccessToken(): Promise<string>;
  getCredentialGeneration(): number;
  getOwnerScopeKey(): string;
  isOwnerBoundaryPending(): boolean;
  fetchImplementation: typeof fetch;
  applySnapshot(snapshot: XaiMediaDiscoverySnapshot | null): void;
  onAuthRejected?(failure: {
    status: number;
    body: string;
    failedAccessToken: string;
  }): Promise<XaiBridgeAuthInvalidationResult>;
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
  return id
    .split('-')
    .filter(Boolean)
    .map((part) => (part.length > 0 ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part))
    .join(' ');
}

/**
 * 官方 models[] 条目 → Cindy 媒体目录条目。requiredInputs 是当前执行适配器承诺
 * 的完整调用面；缺一项就保守隐藏，避免“能选但下单必失败”。
 */
export function mapXaiMediaModels(
  raw: unknown,
  outputModality: 'image' | 'video',
  requiredInputs: readonly ('text' | 'image')[],
): MediaModel[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const models = (raw as { models?: unknown }).models;
  if (!Array.isArray(models) || models.length > MAX_MODELS_PER_KIND) return [];
  const seen = new Set<string>();
  const out: MediaModel[] = [];
  for (const entry of models) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as {
      id?: unknown;
      input_modalities?: unknown;
      output_modalities?: unknown;
      inputModalities?: unknown;
      outputModalities?: unknown;
    };
    if (
      typeof item.id !== 'string' ||
      item.id.length === 0 ||
      item.id.length > MAX_MODEL_ID_CHARS ||
      /[\u0000-\u001f\u007f]/.test(item.id)
    ) {
      continue;
    }
    const inputs = asModalities(item.input_modalities ?? item.inputModalities);
    const outputs = asModalities(item.output_modalities ?? item.outputModalities);
    if (
      !inputs ||
      !outputs?.has(outputModality) ||
      requiredInputs.some((input) => !inputs.has(input))
    ) {
      continue;
    }
    const id = item.id.startsWith('xai/') ? item.id : `xai/${item.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: displayName(item.id.replace(/^xai\//, '')) || item.id });
  }
  return out;
}

async function readBoundedResponseText(
  response: Response,
  kind: '图片' | '视频',
  assertStillCurrent: () => void,
): Promise<string> {
  assertStillCurrent();
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    assertStillCurrent();
    throw new Error(`xAI ${kind}模型列表响应过大`);
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
        throw new Error(`xAI ${kind}模型列表响应过大`);
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

function parsePayload(text: string, kind: '图片' | '视频'): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`xAI ${kind}模型列表返回了无效 JSON`);
  }
}

function hasValidModelsArray(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const models = (value as { models?: unknown }).models;
  return Array.isArray(models) && models.length <= MAX_MODELS_PER_KIND;
}

export function createXaiMediaDiscovery(deps: XaiMediaDiscoveryDeps): {
  refresh(): Promise<boolean>;
  clear(): void;
} {
  const staleDiscovery = Symbol('stale xAI media discovery');
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
      deps.hasOAuthLogin()
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

  async function fetchList(
    path: '/image-generation-models' | '/video-generation-models',
    label: '图片' | '视频',
    initialToken: string,
    signal: AbortSignal,
    assertStillCurrent: () => void,
  ): Promise<unknown> {
    let token = initialToken;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assertStillCurrent();
      const response = await deps.fetchImplementation(`${XAI_API_BASE}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'error',
        signal,
      });
      assertStillCurrent();
      const text = await readBoundedResponseText(response, label, assertStillCurrent);
      if (response.ok) return parsePayload(text, label);

      const recovery =
        attempt === 0 && (response.status === 401 || response.status === 403) && deps.onAuthRejected
          ? await deps
              .onAuthRejected({
                status: response.status,
                body: text.slice(0, 8 * 1024),
                failedAccessToken: token,
              })
              .catch(() => undefined)
          : undefined;
      assertStillCurrent();
      if (recovery === 'refreshed' || recovery === 'superseded') {
        token = await deps.getAccessToken();
        assertStillCurrent();
        continue;
      }
      throw new Error(`xAI ${label}模型发现失败(HTTP ${response.status})`);
    }
    throw new Error(`xAI ${label}模型发现失败:认证恢复重试耗尽`);
  }

  function refresh(): Promise<boolean> {
    const ownerScopeKey = syncScope();
    if (deps.isOwnerBoundaryPending() || !deps.hasOAuthLogin()) return Promise.resolve(false);
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
        const token = await deps.getAccessToken();
        assertCurrent(expectedGeneration, ownerScopeKey, expectedCredentialGeneration);
        const assertStillCurrent = (): void =>
          assertCurrent(expectedGeneration, ownerScopeKey, expectedCredentialGeneration);
        const signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
        const [imageResult, videoResult] = await Promise.allSettled([
          fetchList('/image-generation-models', '图片', token, signal, assertStillCurrent),
          fetchList('/video-generation-models', '视频', token, signal, assertStillCurrent),
        ]);
        assertStillCurrent();
        // 当前 xAI 图片通道同时承担生成与编辑，视频通道同时承担文生与单图生；
        // 所以动态条目必须覆盖各自完整输入面。以后若目录支持 per-model 能力，
        // 可在这里放宽为按条目声明，而不是靠名称猜测。
        const snapshot: XaiMediaDiscoverySnapshot = {};
        const failures: string[] = [];
        if (imageResult.status === 'fulfilled') {
          if (hasValidModelsArray(imageResult.value)) {
            snapshot.imageModels = mapXaiMediaModels(imageResult.value, 'image', ['text', 'image']);
          } else {
            failures.push('xAI 图片模型列表结构无效');
          }
        } else {
          failures.push(
            imageResult.reason instanceof Error
              ? imageResult.reason.message
              : String(imageResult.reason),
          );
        }
        if (videoResult.status === 'fulfilled') {
          if (hasValidModelsArray(videoResult.value)) {
            snapshot.videoModels = mapXaiMediaModels(videoResult.value, 'video', ['text', 'image']);
          } else {
            failures.push('xAI 视频模型列表结构无效');
          }
        } else {
          failures.push(
            videoResult.reason instanceof Error
              ? videoResult.reason.message
              : String(videoResult.reason),
          );
        }
        if (!snapshot.imageModels && !snapshot.videoModels) {
          throw new Error(failures.join('; ') || 'xAI 媒体模型响应不可用');
        }
        assertStillCurrent();
        deps.applySnapshot(snapshot);
        if (failures.length > 0) {
          deps.log.warn(
            'xAI media discovery partially succeeded; preserving previous failed kind',
            {
              failures,
            },
          );
        }
        deps.log.info('xAI media models refreshed', {
          imageModels: snapshot.imageModels?.length,
          videoModels: snapshot.videoModels?.length,
        });
        return true;
      } catch (error) {
        if (error === staleDiscovery) return false;
        deps.log.warn('xAI media model discovery failed; keeping current catalog fallback', {
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

const log = createLogger('model-discovery:xai-media');
const discovery = createXaiMediaDiscovery({
  hasOAuthLogin: () => hasGrokOAuthLogin(),
  getAccessToken: () => getGrokAccessToken(),
  getCredentialGeneration: () => getGrokOAuthCredentialGeneration(),
  getOwnerScopeKey: () => activeOwnerScopeKey(),
  isOwnerBoundaryPending: () => isAppSessionBoundaryPending(),
  fetchImplementation: ((url, init) => outboundFetch(url as string, init)) as typeof fetch,
  applySnapshot: (snapshot) => setDiscoveredProviderMediaModels('xai', snapshot),
  onAuthRejected: (failure) => invalidateXaiBridgeAuth(failure),
  log,
});

export const refreshXaiMediaModels = (): Promise<boolean> => discovery.refresh();
export const clearXaiMediaModels = (): void => discovery.clear();
