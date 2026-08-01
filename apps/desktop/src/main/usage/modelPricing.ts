/**
 * modelPricing — Desktop 的 provider-scoped 价格投影。
 *
 * XD 模型与价格只来自 model-access-server 的同一次 GET /models 响应。这里不再
 * 直接请求 LiteLLM；模型同步成功时整体替换 XD quote，失败时保留上一份成功快照。
 * Gateway per-token 数值在这里转换为 per-Mtok；新版服务端下发的原生币种优先，
 * 旧版服务端缺失时才回退构建区域。
 */

import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import {
  gatewayLedgerCurrency,
  gatewayPricingCatalog,
  getModelPriceQuote,
  providerReferencePriceQuote,
  registryPricingCatalog,
  subscriptionDirectPriceQuote,
} from '../../shared/modelPriceQuote.js';
import type { ModelAccessGatewayModel } from '../../shared/modelAccess.js';
import { providerSecretStorageKey } from '../../shared/providerSecrets.js';
import {
  gatewayCurrencyForRegion,
  type ModelPriceQuote,
  type ModelPricingCatalog,
  type MoneyCurrency,
} from '../../shared/regionalMoney.js';
import { getCurrentDbClientUserId } from '../localDb/client/current.js';
import { setActiveLedgerCurrency } from './ledgerCurrency.js';
import { createLogger } from '../logger.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { resolveOwnerScopedSecretStorageKey } from '../secrets/providerSecretStore.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import {
  applyModelPriceOverrides,
  mergeStoredModelPriceOverride,
  type ModelPriceOverridesSnapshot,
} from './modelPriceOverrideStore.js';

export type { ModelPriceOverridesSnapshot } from './modelPriceOverrideStore.js';
export { readModelPriceOverridesSnapshot } from './modelPriceOverrideStore.js';

export { getModelPriceQuote } from '../../shared/modelPriceQuote.js';
export type {
  ModelPriceQuote as ModelPrice,
  ModelPricingCatalog as ModelPricingMap,
} from '../../shared/regionalMoney.js';

const log = createLogger('modelPricing');
// v8:账号币种与报价同快照持久化；无报价模型也可能明确声明结算币种。
// v7:币种改为优先使用 Model Access 明确声明，不能复用按 region 猜测的旧 quote。
// v6:所有 Gateway 模型统一按服务端 costDiscount 计费。v5 的 codex/ quote 已
// 硬编码乘过 0.15 且丢弃 costDiscount，不能继续复用。
const DISK_CACHE_VERSION = 8;
const DISK_CACHE_FILE = 'model-pricing.json';

export const MODEL_PRICING_CHANGED_CHANNEL = 'usage:model-pricing-changed';

interface DiskCachePayload {
  version: number;
  scope: string;
  fetchedAt: number;
  pricing: ModelPricingCatalog;
  accountCurrency: MoneyCurrency | null;
}

let cache: ModelPricingCatalog | null = null;
let cacheScope: string | null = null;
let cacheAt = 0;
let modelSyncInflight: Promise<unknown> | null = null;
let gatewayAccountCurrency: MoneyCurrency | null = null;
let gatewayAccountCurrencyScope: string | null = null;
const hydratedScopes = new Set<string>();
const hydrateInflightByScope = new Map<string, Promise<ModelPricingCatalog | null>>();

function resolveGatewayAccountCurrency(
  models: readonly ModelAccessGatewayModel[],
): MoneyCurrency | null {
  if (models.length === 0) return null;
  const currencies = new Set(
    models
      .map((model) => model.currency)
      .filter((currency): currency is MoneyCurrency => currency === 'CNY' || currency === 'USD'),
  );
  if (currencies.size > 1) {
    log.warn('xd gateway models returned mixed currencies; account quota currency unavailable');
    return null;
  }
  return currencies.values().next().value ?? gatewayCurrencyForRegion(CURRENT_CINDY_REGION);
}

function currentKeyCacheIdentity(): string {
  try {
    const physicalKey = resolveOwnerScopedSecretStorageKey(providerSecretStorageKey('xd'));
    if (!physicalKey) return 'key=missing';
    const file = path.join(app.getPath('userData'), 'safe-storage', `${physicalKey}.enc`);
    const stat = statSync(file, { bigint: true });
    return `key=${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return 'key=missing';
  }
}

function currentScope(userId?: string): string {
  return [
    'v1',
    `region=${CURRENT_CINDY_REGION}`,
    `base=${getClientEndpoint('modelAccessApiBaseUrl').trim()}`,
    `user=${userId ?? getCurrentDbClientUserId() ?? 'anonymous'}`,
    currentKeyCacheIdentity(),
  ].join('|');
}

function diskCachePath(): string {
  return path.join(app.getPath('userData'), 'cache', DISK_CACHE_FILE);
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateInputTokenPriceBands(
  value: unknown,
): ModelPriceQuote['inputTokenPriceBands'] {
  if (!Array.isArray(value)) return undefined;
  const bands: NonNullable<ModelPriceQuote['inputTokenPriceBands']> = [];
  for (const raw of value.slice(0, 32)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const band = raw as Record<string, unknown>;
    if (
      !isNonNegativeFinite(band.minInputTokens) ||
      (band.maxInputTokens !== undefined &&
        (!isNonNegativeFinite(band.maxInputTokens) ||
          band.maxInputTokens <= band.minInputTokens))
    ) {
      continue;
    }
    const next: NonNullable<ModelPriceQuote['inputTokenPriceBands']>[number] = {
      minInputTokens: band.minInputTokens,
      ...(band.maxInputTokens !== undefined
        ? { maxInputTokens: band.maxInputTokens as number }
        : {}),
    };
    let hasPrice = false;
    for (const field of [
      'inputPerMtok',
      'outputPerMtok',
      'cacheReadPerMtok',
      'cacheCreatePerMtok',
    ] as const) {
      if (isNonNegativeFinite(band[field])) {
        next[field] = band[field];
        hasPrice = true;
      }
    }
    if (hasPrice) bands.push(next);
  }
  return bands.length > 0 ? bands : undefined;
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
  const inputTokenPriceBands = validateInputTokenPriceBands(quote.inputTokenPriceBands);
  if (inputTokenPriceBands) {
    next.inputTokenPriceBands = inputTokenPriceBands;
  }
  if (
    typeof quote.costDiscount === 'number' &&
    Number.isFinite(quote.costDiscount) &&
    quote.costDiscount > 0 &&
    quote.costDiscount <= 1
  ) {
    next.costDiscount = quote.costDiscount;
  }
  return next;
}

function validateCatalog(value: unknown): ModelPricingCatalog | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const catalog = value as Record<string, unknown>;
  if (Object.keys(catalog).length === 0) return {};
  const xdValue = catalog.xd;
  if (!xdValue || typeof xdValue !== 'object' || Array.isArray(xdValue)) return null;
  const xd: Record<string, ModelPriceQuote> = {};
  const entries = Object.entries(xdValue);
  for (const [rawModelId, rawQuote] of entries) {
    const modelId = rawModelId.trim();
    if (!modelId) continue;
    const quote = validateQuote(rawQuote, 'xd', modelId);
    if (quote) xd[modelId] = quote;
  }
  if (Object.keys(xd).length > 0) return { xd };
  return entries.length === 0 ? {} : null;
}

async function writeDiskCache(
  scope: string,
  pricing: ModelPricingCatalog,
  accountCurrency: MoneyCurrency | null,
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
      accountCurrency,
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
      const raw = JSON.parse(
        await fs.readFile(diskCachePath(), 'utf8'),
      ) as Partial<DiskCachePayload>;
      if (
        raw.version !== DISK_CACHE_VERSION ||
        raw.scope !== scope ||
        !Number.isFinite(raw.fetchedAt) ||
        Number(raw.fetchedAt) <= 0 ||
        (raw.accountCurrency !== null &&
          raw.accountCurrency !== 'CNY' &&
          raw.accountCurrency !== 'USD')
      ) {
        return null;
      }
      const pricing = validateCatalog(raw.pricing);
      if (!pricing) return null;
      if (currentScope() !== scope) return null;
      cache = pricing;
      cacheScope = scope;
      cacheAt = Number(raw.fetchedAt);
      // 账本币种必须在这里恢复,而不是只在 getGatewayAccountCurrency 里:那个函数只服务
      // 可选的账号配额查询,而计费热路径(register.ts 的 turn 记账、prewarm)走的是
      // getModelPricing / getModelPricingForModel。冷启动只命中磁盘缓存(/models 尚未
      // 完成或失败)时若不在此同步,currentLedgerCurrency() 会回落构建默认币种,把该账号
      // 用缓存报价算出的金额当异币种丢弃 —— 等于这一段时间完全不计费。
      gatewayAccountCurrency = raw.accountCurrency;
      gatewayAccountCurrencyScope = scope;
      setActiveLedgerCurrency(raw.accountCurrency);
      log.debug(`hydrated model pricing cache: ${Object.keys(pricing.xd ?? {}).length} XD quotes`);
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

function effectivePricingCatalog(gatewayPricing: ModelPricingCatalog | null): ModelPricingCatalog {
  const registry = getActiveCatalog().modelRegistry;
  const reference = registryPricingCatalog(registry);
  return applyModelPriceOverrides(
    {
      ...reference,
      ...(gatewayPricing?.xd ? { xd: gatewayPricing.xd } : {}),
    },
    registry,
  );
}

export function broadcastEffectiveModelPricing(): void {
  const scope = currentScope();
  broadcastPricing(effectivePricingCatalog(cacheScope === scope ? cache : null));
}

/**
 * 与模型同步同快照更新 XD quote。models 非空但没有标准 input/output 价格时，
 * 价格投影会被清空，不复活旧模型价格。
 */
export function replaceGatewayModelPricing(
  models: readonly ModelAccessGatewayModel[],
  authenticatedUserId?: string,
): ModelPricingCatalog {
  // /models can finish a few milliseconds before localDb takeover has exposed
  // its user through getCurrentDbClientUserId(). The model-access caller
  // therefore passes the authenticated user captured when the request starts,
  // so a valid startup snapshot is never persisted under `anonymous`.
  const scope = currentScope(authenticatedUserId);
  const pricing = gatewayPricingCatalog(models, CURRENT_CINDY_REGION);
  cache = pricing;
  cacheScope = scope;
  cacheAt = Date.now();
  gatewayAccountCurrency = resolveGatewayAccountCurrency(models);
  gatewayAccountCurrencyScope = scope;
  // 账本写入层据此判断"这一笔是不是本账号的结算币种"。目录为空(登出 / clear)或混合
  // 币种时 resolveGatewayAccountCurrency 返回 null，账本随之回落构建默认值。
  setActiveLedgerCurrency(gatewayAccountCurrency);
  hydratedScopes.add(scope);
  void writeDiskCache(scope, pricing, gatewayAccountCurrency, cacheAt);
  broadcastPricing(effectivePricingCatalog(pricing));
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
  const gatewayPricing = cacheScope === scope ? cache : await hydrateFromDisk(scope);
  return effectivePricingCatalog(gatewayPricing);
}

/**
 * 记账热路径等待 inflight 同步的上限:/models 请求本身不设超时,黑洞网络下
 * 不能让记账写入无限期挂起(app 等待期间退出会丢整轮账)。超时后直接用当前
 * 已落地的投影计价；Gateway quote 缺失时不记录金额，避免把 SDK 的 USD 字段
 * 当成当前区域的 Gateway 价格。
 */
const PRICING_SYNC_WAIT_MS = 3_000;

async function waitForModelPricingSync(): Promise<void> {
  if (!modelSyncInflight) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      modelSyncInflight.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PRICING_SYNC_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Model Access 账号用量与模型目录属于同一个 Gateway 租户，因而共用目录声明的
 * 原生币种。混合币种或尚无当前账号目录时返回 null，调用方不再根据组织名称猜测。
 */
export async function getGatewayAccountCurrency(
  authenticatedUserId?: string,
): Promise<MoneyCurrency | null> {
  await waitForModelPricingSync();
  const scope = currentScope(authenticatedUserId);
  if (gatewayAccountCurrencyScope === scope) return gatewayAccountCurrency;
  // 本轮 /models 没跑成时，磁盘缓存里的报价同样能定出币种。hydrateFromDisk 内部会在
  // 落盘缓存生效的同时把币种写回缓存与账本事实源（那里才是所有取价路径的共同入口），
  // 所以这里只需触发一次 hydrate 再读结果。
  await getModelPricing();
  if (gatewayAccountCurrencyScope === scope) return gatewayAccountCurrency;
  return cacheScope === scope ? gatewayLedgerCurrency(cache) : null;
}

/**
 * 计费热路径等待模型同步已经落下的本地投影，不再自己联网。providerId 是必需的，
 * 同模型从 XD/OpenAI/订阅来源进入时不会串价。
 */
export async function getModelPricingForModel(
  providerId: string | null | undefined,
  modelId: string,
): Promise<ModelPricingCatalog | null> {
  await waitForModelPricingSync();
  const pricing = await getModelPricing();
  void getModelPriceQuote(pricing, providerId, modelId);
  return pricing;
}

/**
 * Codex 订阅轮的估算价,按显式来源 provider 取该 provider 的 registry 参考价
 * (含用户价格覆盖)。openai 之外的订阅来源(如内置 anthropic 的 Claude.ai 订阅)
 * 也走各自的日期定价路由,不能一律套 OpenAI 价表。
 */
export function getCodexProviderSubscriptionValuePrice(
  providerId: string,
  modelId: string,
  pricing: ModelPricingCatalog | null | undefined,
  at?: string | Date,
  overrides?: ModelPriceOverridesSnapshot,
): ModelPriceQuote | undefined {
  const effective = getModelPriceQuote(pricing, providerId, modelId, 'codex');
  if (effective?.source === 'user-override') {
    if (at === undefined) return effective;
    // 目录里烘焙的 user-override 是按当前日期合并的;历史窗口跨过参考价生效边界时,
    // 未覆盖字段必须按 at 时点的参考价重新合并,不能直接回用当前合并结果。
    return (
      mergeStoredModelPriceOverride(
        { providerId, agent: 'codex', modelId: effective.modelId },
        providerReferencePriceQuote(
          providerId,
          effective.modelId,
          getActiveCatalog().modelRegistry,
          { agent: 'codex', at },
        ),
        overrides,
      ) ?? effective
    );
  }
  const reference = providerReferencePriceQuote(
    providerId,
    modelId,
    getActiveCatalog().modelRegistry,
    { agent: 'codex', at },
  );
  return reference ?? (at === undefined ? effective : undefined);
}

export function getCodexSubscriptionValuePrice(
  modelId: string,
  pricing: ModelPricingCatalog | null | undefined,
  at?: string | Date,
  overrides?: ModelPriceOverridesSnapshot,
): ModelPriceQuote | undefined {
  return getCodexProviderSubscriptionValuePrice('openai', modelId, pricing, at, overrides);
}

export function getClaudeSubscriptionValuePrice(
  modelId: string,
  pricing: ModelPricingCatalog | null | undefined,
  at?: string | Date,
  overrides?: ModelPriceOverridesSnapshot,
): ModelPriceQuote | undefined {
  const effective = getModelPriceQuote(pricing, 'anthropic', modelId, 'claude-code');
  if (effective?.source === 'user-override') {
    if (at === undefined) return effective;
    // 同 getCodexSubscriptionValuePrice:历史估值按 at 时点参考价重新合并稀疏覆盖。
    return (
      mergeStoredModelPriceOverride(
        { providerId: 'anthropic', agent: 'claude-code', modelId: effective.modelId },
        providerReferencePriceQuote(
          'anthropic',
          effective.modelId,
          getActiveCatalog().modelRegistry,
          { agent: 'claude-code', at },
        ),
        overrides,
      ) ?? effective
    );
  }
  const reference = providerReferencePriceQuote(
    'anthropic',
    modelId,
    getActiveCatalog().modelRegistry,
    { agent: 'claude-code', at },
  );
  return reference ?? (at === undefined ? effective : undefined);
}

export function getSubscriptionDirectValuePrice(
  modelId: string,
  agent?: 'claude-code' | 'codex',
  pricing?: ModelPricingCatalog | null,
  at?: string | Date,
  overrides?: ModelPriceOverridesSnapshot,
): ModelPriceQuote | undefined {
  const registry = getActiveCatalog().modelRegistry;
  const fallback = subscriptionDirectPriceQuote(
    modelId,
    registry,
    agent,
    at,
  );
  const routingQuote = fallback ?? subscriptionDirectPriceQuote(modelId, registry, agent);
  if (!routingQuote) return undefined;
  const effective = getModelPriceQuote(pricing, routingQuote.providerId, modelId, agent);
  const quote =
    effective?.source === 'user-override'
      ? at === undefined || agent === undefined
        ? effective
        : // 同上:历史窗口内的订阅直连估值也要按 at 时点参考价重新合并稀疏覆盖。
          (mergeStoredModelPriceOverride(
            { providerId: effective.providerId, agent, modelId: effective.modelId },
            providerReferencePriceQuote(effective.providerId, effective.modelId, registry, {
              agent,
              at,
            }),
            overrides,
          ) ?? effective)
      : fallback;
  if (!quote) return undefined;
  return {
    ...quote,
    modelId,
    source:
      quote.source === 'provider-reference' ? 'subscription-reference' : quote.source,
  };
}

/** 启动只读磁盘快照；真正的新价格仍由 /models 同步整体替换。 */
export async function prewarmModelPricing(): Promise<void> {
  try {
    await getModelPricing();
  } catch (err) {
    log.debug('prewarm model pricing failed:', err instanceof Error ? err.message : String(err));
  }
}

export function __resetModelPricingCacheForTesting(): void {
  cache = null;
  cacheScope = null;
  cacheAt = 0;
  modelSyncInflight = null;
  gatewayAccountCurrency = null;
  gatewayAccountCurrencyScope = null;
  hydratedScopes.clear();
  hydrateInflightByScope.clear();
}
