/**
 * modelPricing — Desktop 的 provider-scoped 价格投影。
 *
 * XD 模型与价格只来自 model-access-server 的同一次 GET /models 响应。这里不再
 * 直接请求 LiteLLM；模型同步成功时整体替换 XD quote，失败时保留上一份成功快照。
 * Gateway per-token 数值在这里转换为 per-Mtok，币种只由构建区域决定。
 */

import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import {
  gatewayPricingCatalog,
  getModelPriceQuote,
  subscriptionDirectPriceQuote,
} from '../../shared/modelPriceQuote.js';
import type { ModelAccessGatewayModel } from '../../shared/modelAccess.js';
import { providerSecretStorageKey } from '../../shared/providerSecrets.js';
import {
  type ModelPriceQuote,
  type ModelPricingCatalog,
} from '../../shared/regionalMoney.js';
import { getCurrentDbClientUserId } from '../localDb/client/current.js';
import { createLogger } from '../logger.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { resolveOwnerScopedSecretStorageKey } from '../secrets/providerSecretStore.js';
import { getCodexBudgetEffectiveCostMultiplier } from './turnCostCalculator.js';

export { getCodexBudgetEffectiveCostMultiplier } from './turnCostCalculator.js';
export { getModelPriceQuote } from '../../shared/modelPriceQuote.js';
export type {
  ModelPriceQuote as ModelPrice,
  ModelPricingCatalog as ModelPricingMap,
} from '../../shared/regionalMoney.js';

const log = createLogger('modelPricing');
const DISK_CACHE_VERSION = 3;
const DISK_CACHE_FILE = 'model-pricing.json';

export const MODEL_PRICING_CHANGED_CHANNEL = 'usage:model-pricing-changed';

interface DiskCachePayload {
  version: number;
  scope: string;
  fetchedAt: number;
  pricing: ModelPricingCatalog;
}

let cache: ModelPricingCatalog | null = null;
let cacheScope: string | null = null;
let cacheAt = 0;
let modelSyncInflight: Promise<unknown> | null = null;
const hydratedScopes = new Set<string>();
const hydrateInflightByScope = new Map<
  string,
  Promise<ModelPricingCatalog | null>
>();

function currentKeyCacheIdentity(): string {
  try {
    const physicalKey = resolveOwnerScopedSecretStorageKey(
      providerSecretStorageKey('xd'),
    );
    if (!physicalKey) return 'key=missing';
    const file = path.join(
      app.getPath('userData'),
      'safe-storage',
      `${physicalKey}.enc`,
    );
    const stat = statSync(file, { bigint: true });
    return `key=${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return 'key=missing';
  }
}

function currentScope(): string {
  return [
    'v1',
    `region=${CURRENT_CINDY_REGION}`,
    `base=${getClientEndpoint('modelAccessApiBaseUrl').trim()}`,
    `user=${getCurrentDbClientUserId() ?? 'anonymous'}`,
    currentKeyCacheIdentity(),
  ].join('|');
}

function diskCachePath(): string {
  return path.join(app.getPath('userData'), 'cache', DISK_CACHE_FILE);
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateQuote(
  value: unknown,
  providerId: string,
  modelId: string,
): ModelPriceQuote | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const quote = value as Partial<ModelPriceQuote>;
  if (
    quote.providerId !== providerId ||
    quote.modelId !== modelId ||
    (quote.currency !== 'CNY' && quote.currency !== 'USD') ||
    quote.source !== 'gateway' ||
    quote.approximate !== false ||
    !isNonNegativeFinite(quote.inputPerMtok) ||
    !isNonNegativeFinite(quote.outputPerMtok)
  ) {
    return undefined;
  }
  const next: ModelPriceQuote = {
    providerId,
    modelId,
    currency: quote.currency,
    source: 'gateway',
    approximate: false,
    inputPerMtok: quote.inputPerMtok,
    outputPerMtok: quote.outputPerMtok,
  };
  if (isNonNegativeFinite(quote.cacheReadPerMtok)) {
    next.cacheReadPerMtok = quote.cacheReadPerMtok;
  }
  if (isNonNegativeFinite(quote.cacheCreatePerMtok)) {
    next.cacheCreatePerMtok = quote.cacheCreatePerMtok;
  }
  return next;
}

function validateCatalog(value: unknown): ModelPricingCatalog | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const xdValue = (value as Record<string, unknown>).xd;
  if (!xdValue || typeof xdValue !== 'object' || Array.isArray(xdValue)) return null;
  const xd: Record<string, ModelPriceQuote> = {};
  for (const [rawModelId, rawQuote] of Object.entries(xdValue)) {
    const modelId = rawModelId.trim();
    if (!modelId) continue;
    const quote = validateQuote(rawQuote, 'xd', modelId);
    if (quote) xd[modelId] = quote;
  }
  return Object.keys(xd).length > 0 ? { xd } : null;
}

async function writeDiskCache(
  scope: string,
  pricing: ModelPricingCatalog,
  fetchedAt: number,
): Promise<void> {
  try {
    const file = diskCachePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const payload: DiskCachePayload = {
      version: DISK_CACHE_VERSION,
      scope,
      fetchedAt,
      pricing,
    };
    await fs.writeFile(file, JSON.stringify(payload), 'utf8');
    hydratedScopes.add(scope);
  } catch (err) {
    log.debug(
      'write model pricing cache failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function hydrateFromDisk(scope: string): Promise<ModelPricingCatalog | null> {
  if (hydratedScopes.has(scope)) return cacheScope === scope ? cache : null;
  const existing = hydrateInflightByScope.get(scope);
  if (existing) return existing;
  const hydrateInflight = (async () => {
    try {
      const raw = JSON.parse(await fs.readFile(diskCachePath(), 'utf8')) as Partial<DiskCachePayload>;
      if (
        raw.version !== DISK_CACHE_VERSION ||
        raw.scope !== scope ||
        !Number.isFinite(raw.fetchedAt) ||
        Number(raw.fetchedAt) <= 0
      ) {
        return null;
      }
      const pricing = validateCatalog(raw.pricing);
      if (!pricing) return null;
      if (currentScope() !== scope) return null;
      cache = pricing;
      cacheScope = scope;
      cacheAt = Number(raw.fetchedAt);
      log.debug(
        `hydrated model pricing cache: ${Object.keys(pricing.xd ?? {}).length} XD quotes`,
      );
      return pricing;
    } catch (err) {
      const code =
        typeof err === 'object' && err && 'code' in err
          ? String((err as { code?: unknown }).code)
          : '';
      if (code !== 'ENOENT') {
        log.debug(
          'hydrate model pricing cache failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
      return null;
    } finally {
      hydratedScopes.add(scope);
      hydrateInflightByScope.delete(scope);
    }
  })();
  hydrateInflightByScope.set(scope, hydrateInflight);
  return hydrateInflight;
}

function broadcastPricing(pricing: ModelPricingCatalog | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(MODEL_PRICING_CHANGED_CHANNEL, pricing);
    }
  }
}

/**
 * 与模型同步同快照更新 XD quote。models 非空但没有标准 input/output 价格时，
 * 价格投影会被清空，不复活旧模型价格。
 */
export function replaceGatewayModelPricing(
  models: readonly ModelAccessGatewayModel[],
): ModelPricingCatalog | null {
  const scope = currentScope();
  const next = gatewayPricingCatalog(models, CURRENT_CINDY_REGION);
  const pricing = Object.keys(next.xd ?? {}).length > 0 ? next : null;
  cache = pricing;
  cacheScope = scope;
  cacheAt = Date.now();
  hydratedScopes.add(scope);
  void writeDiskCache(scope, next, cacheAt);
  broadcastPricing(pricing);
  return pricing;
}

export function clearGatewayModelPricing(): void {
  replaceGatewayModelPricing([]);
}

export function trackGatewayModelPricingSync(sync: Promise<unknown>): void {
  modelSyncInflight = sync;
  void sync.then(
    () => {
      if (modelSyncInflight === sync) modelSyncInflight = null;
    },
    () => {
      if (modelSyncInflight === sync) modelSyncInflight = null;
    },
  );
}

export function isModelPricingRefreshInFlight(): boolean {
  return modelSyncInflight !== null;
}

export async function getModelPricing(): Promise<ModelPricingCatalog | null> {
  const scope = currentScope();
  if (cacheScope === scope) return cache;
  return hydrateFromDisk(scope);
}

/**
 * 计费热路径等待模型同步已经落下的本地投影，不再自己联网。providerId 是必需的，
 * 同模型从 XD/OpenAI/订阅来源进入时不会串价。
 */
export async function getModelPricingForModel(
  providerId: string | null | undefined,
  modelId: string,
): Promise<ModelPricingCatalog | null> {
  if (modelSyncInflight) await modelSyncInflight;
  const pricing = await getModelPricing();
  void getModelPriceQuote(pricing, providerId, modelId);
  return pricing;
}

export function getCodexSubscriptionValuePrice(
  modelId: string,
  pricing: ModelPricingCatalog | null | undefined,
): ModelPriceQuote | undefined {
  return getModelPriceQuote(pricing, 'openai', modelId);
}

export function getSubscriptionDirectValuePrice(
  modelId: string,
): ModelPriceQuote | undefined {
  return subscriptionDirectPriceQuote(modelId);
}

/** 启动只读磁盘快照；真正的新价格仍由 /models 同步整体替换。 */
export async function prewarmModelPricing(): Promise<void> {
  try {
    await getModelPricing();
  } catch (err) {
    log.debug(
      'prewarm model pricing failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function __resetModelPricingCacheForTesting(): void {
  cache = null;
  cacheScope = null;
  cacheAt = 0;
  modelSyncInflight = null;
  hydratedScopes.clear();
  hydrateInflightByScope.clear();
}
