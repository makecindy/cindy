/**
 * modelPricing — Cindy AI Gateway 的 XD 实际报价投影。
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
import { gatewayLedgerCurrency, gatewayPricingCatalog } from '../../shared/modelPriceQuote.js';
import type { ModelAccessGatewayModel } from '../../shared/modelAccess.js';
import { providerSecretStorageKey } from '../../shared/providerSecrets.js';
import {
  type ModelPriceQuote,
  type ModelPricingCatalog,
  type MoneyCurrency,
} from '../../shared/regionalMoney.js';
import { getCurrentDbClientUserId } from '../localDb/client/current.js';
import {
  hydrateAccountCurrency,
  noteActiveAccount,
  rememberAccountCurrency,
} from './accountCurrencyStore.js';
import { currentLedgerCurrency, setActiveLedgerCurrency } from './ledgerCurrency.js';
import { createLogger } from '../logger.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { resolveOwnerScopedSecretStorageKey } from '../secrets/providerSecretStore.js';

export { getModelPriceQuote } from '../../shared/modelPriceQuote.js';
export type {
  ModelPriceQuote as ModelPrice,
  ModelPricingCatalog as ModelPricingMap,
} from '../../shared/regionalMoney.js';

const log = createLogger('modelPricing');
// v9:币种回落不再按构建区域猜，且猜出来的报价会带 currencyInferred。v8 快照里那些
//    按区域兜底写入的 accountCurrency 与 quote 没有这个标记，复用它们会让「猜的币种」
//    重新冒充精确报价 —— 离线或 /models 失败时正好绕过本次修复，必须整份作废重取。
// v8:账号币种与报价同快照持久化；无报价模型也可能明确声明结算币种。
// v7:币种改为优先使用 Model Access 明确声明，不能复用按 region 猜测的旧 quote。
// v6:所有 Gateway 模型统一按服务端 costDiscount 计费。v5 的 codex/ quote 已
// 硬编码乘过 0.15 且丢弃 costDiscount，不能继续复用。
const DISK_CACHE_VERSION = 9;
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
/** 上一次观察到的**生效**账本币种(含回退结果),只用于把切换打进日志。 */
let activeLedgerCurrencySnapshot: MoneyCurrency | null = null;
const hydratedScopes = new Set<string>();
const hydrateInflightByScope = new Map<string, Promise<ModelPricingCatalog | null>>();

/**
 * 目录**显式声明**的结算币种；没声明就返回 null，由 ledgerCurrency 的回退链接手。
 *
 * 这里曾经在没声明时回落 `gatewayCurrencyForRegion(CURRENT_CINDY_REGION)`。那是把
 * 「服务端这次没告诉我」翻译成了「那按发行区域算」，而报价数值仍是服务端给的原口径 ——
 * 一旦某次 /models 漏发 currency，整份目录的 USD 数值就会被盖上 CNY 戳。实测这让同一
 * 账号的账本币种在一天内翻转多次，并连带把当天已累计的花费覆盖掉。
 */
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
  const declared = currencies.values().next().value ?? null;
  if (!declared) {
    log.warn(
      `xd gateway models declared no currency (${models.length} models); ` +
        'keeping last known ledger currency instead of guessing by region',
    );
  }
  return declared;
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
  if (quote.priority && typeof quote.priority === 'object') {
    const priority: NonNullable<ModelPriceQuote['priority']> = {};
    for (const field of [
      'inputPerMtok',
      'outputPerMtok',
      'cacheReadPerMtok',
      'cacheCreatePerMtok',
    ] as const) {
      if (isNonNegativeFinite(quote.priority[field])) priority[field] = quote.priority[field];
    }
    const bands = validateInputTokenPriceBands(quote.priority.inputTokenPriceBands);
    if (bands) priority.inputTokenPriceBands = bands;
    if (Object.keys(priority).length > 0) next.priority = priority;
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
  // 必须跨磁盘往返保留:丢了它,重启后用同一份缓存算出的金额会重新冒充精确账单。
  if (quote.currencyInferred === true) {
    next.currencyInferred = true;
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
      // getGatewayModelPricing / getGatewayModelPricingForModel。冷启动只命中磁盘缓存(/models 尚未
      // 完成或失败)时若不在此同步,currentLedgerCurrency() 会回落构建默认币种,把该账号
      // 用缓存报价算出的金额当异币种丢弃 —— 等于这一段时间完全不计费。
      gatewayAccountCurrency = raw.accountCurrency;
      gatewayAccountCurrencyScope = scope;
      setActiveLedgerCurrency(raw.accountCurrency);
      activeLedgerCurrencySnapshot = currentLedgerCurrency();
      rememberAccountCurrency(getCurrentDbClientUserId(), raw.accountCurrency);
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
  // 账号边界判定必须先于下面的 setActiveLedgerCurrency：切号后新账号的目录若没声明
  // 币种，回退链不能继续沿用上一个账号的结算币种。
  noteActiveAccount(authenticatedUserId ?? getCurrentDbClientUserId());
  gatewayAccountCurrency = resolveGatewayAccountCurrency(models);
  gatewayAccountCurrencyScope = scope;
  // 账本写入层据此判断"这一笔是不是本账号的结算币种"。目录为空(登出 / clear)或混合
  // 币种时返回 null，账本回退到「上次已知 → USD」，绝不按区域猜。
  //
  // 顺序要紧：先落 active，下面的 XD 报价投影兜底才能读到本次刚确认的币种；本次没确认时
  // currentLedgerCurrency() 给出的也是上次已知值，而不是区域默认值。
  setActiveLedgerCurrency(gatewayAccountCurrency);
  const previousLedgerCurrency = activeLedgerCurrencySnapshot;
  activeLedgerCurrencySnapshot = currentLedgerCurrency();
  if (previousLedgerCurrency && previousLedgerCurrency !== activeLedgerCurrencySnapshot) {
    // 账本币种切换会改变后续每一笔的记账口径，也是历史上账本被覆盖的触发点。
    // 它必须在默认日志级别可见 —— 此前只有 debug，10 次翻转在日志里一个字都没留下。
    log.warn(
      `ledger currency changed: ${previousLedgerCurrency} -> ${activeLedgerCurrencySnapshot}` +
        `${gatewayAccountCurrency ? '' : ' (gateway declared none; using last known)'}`,
    );
  }
  rememberAccountCurrency(
    authenticatedUserId ?? getCurrentDbClientUserId(),
    gatewayAccountCurrency,
  );
  const pricing = gatewayPricingCatalog(models, activeLedgerCurrencySnapshot);
  cache = pricing;
  cacheScope = scope;
  cacheAt = Date.now();
  hydratedScopes.add(scope);
  void writeDiskCache(scope, pricing, gatewayAccountCurrency, cacheAt);
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

export async function getGatewayModelPricing(): Promise<ModelPricingCatalog | null> {
  const scope = currentScope();
  return cacheScope === scope ? cache : await hydrateFromDisk(scope);
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
  await getGatewayModelPricing();
  if (gatewayAccountCurrencyScope === scope) return gatewayAccountCurrency;
  return cacheScope === scope ? gatewayLedgerCurrency(cache) : null;
}

/** 计费热路径只等待 `/models` 写入 XD 报价，不读取 Catalog。 */
export async function getGatewayModelPricingForModel(): Promise<ModelPricingCatalog | null> {
  await waitForModelPricingSync();
  return await getGatewayModelPricing();
}

/**
 * 启动只读磁盘快照；真正的新价格仍由 /models 同步整体替换。
 *
 * 先恢复账号币种再读报价快照：币种的持久化不跟报价缓存共享 scope(见
 * accountCurrencyStore)，凭证轮换或端点变化让报价快照作废时，币种仍然取得回来 ——
 * 这样 /models 回来之前的那几轮记账不会落到兜底币种上。
 */
export async function prewarmModelPricing(): Promise<void> {
  try {
    await hydrateAccountCurrency();
  } catch (err) {
    log.debug(
      'hydrate account currency failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
  try {
    await getGatewayModelPricing();
  } catch (err) {
    log.debug('prewarm model pricing failed:', err instanceof Error ? err.message : String(err));
  }
  activeLedgerCurrencySnapshot = currentLedgerCurrency();
}

export function __resetModelPricingCacheForTesting(): void {
  cache = null;
  cacheScope = null;
  cacheAt = 0;
  modelSyncInflight = null;
  gatewayAccountCurrency = null;
  gatewayAccountCurrencyScope = null;
  activeLedgerCurrencySnapshot = null;
  hydratedScopes.clear();
  hydrateInflightByScope.clear();
}
