/**
 * Per-(provider instance, runtime, model id) local reference-price patches.
 *
 * The JSON file is an internal persistence detail. Users edit it only through Settings.
 * Records are sparse and keep the remote reference used when they were saved; if that
 * reference later changes, the local patch wins and the UI exposes a conflict/reset state.
 */

import type { AgentKind, ModelRegistry } from '@cindy/model-providers';

import { modelPricingKey, providerReferencePriceQuote } from '../../shared/modelPriceQuote.js';
import type {
  ModelPriceOverrideDesiredQuote,
  ModelPriceOverrideTarget,
  ModelPriceOverrideValues,
  ModelPriceOverrideView,
} from '../../shared/modelPriceOverride.js';
import type {
  ModelPriceQuote,
  ModelPricingCatalog,
  MoneyCurrency,
} from '../../shared/regionalMoney.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { currentLedgerCurrency } from './ledgerCurrency.js';

const log = desktopMakerLogger.child('model-price-overrides');
const STORE_VERSION = 1;
const MAX_ENTRIES = 4096;

interface ComparablePrice {
  currency: MoneyCurrency;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number | null;
  cacheCreatePerMtok: number | null;
  inputTokenPriceBands?: ModelPriceQuote['inputTokenPriceBands'];
}

interface StoredModelPriceOverride extends ModelPriceOverrideTarget {
  values: ModelPriceOverrideValues;
  baseReference: ComparablePrice | null;
  updatedAt: string;
}

interface ModelPriceOverridePrefs {
  version: typeof STORE_VERSION;
  entries: Record<string, StoredModelPriceOverride>;
}

const DEFAULTS: ModelPriceOverridePrefs = { version: STORE_VERSION, entries: {} };

function isAgent(value: unknown): value is AgentKind {
  return value === 'claude-code' || value === 'codex';
}

function isCurrency(value: unknown): value is MoneyCurrency {
  return value === 'USD' || value === 'CNY';
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function overrideKey(target: ModelPriceOverrideTarget): string {
  return JSON.stringify([target.providerId, target.agent, target.modelId]);
}

function normalizeNullablePrice(value: unknown): number | null | undefined {
  return value === null || finiteNonNegative(value) ? value : undefined;
}

function normalizeValues(value: unknown): ModelPriceOverrideValues | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const values: ModelPriceOverrideValues = {};
  if (isCurrency(raw.currency)) values.currency = raw.currency;
  if (finiteNonNegative(raw.inputPerMtok)) values.inputPerMtok = raw.inputPerMtok;
  if (finiteNonNegative(raw.outputPerMtok)) values.outputPerMtok = raw.outputPerMtok;
  const cacheRead = normalizeNullablePrice(raw.cacheReadPerMtok);
  const cacheCreate = normalizeNullablePrice(raw.cacheCreatePerMtok);
  if (cacheRead !== undefined) values.cacheReadPerMtok = cacheRead;
  if (cacheCreate !== undefined) values.cacheCreatePerMtok = cacheCreate;
  return Object.keys(values).length > 0 ? values : null;
}

function normalizeComparable(value: unknown): ComparablePrice | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    !isCurrency(raw.currency) ||
    !finiteNonNegative(raw.inputPerMtok) ||
    !finiteNonNegative(raw.outputPerMtok)
  ) {
    return undefined;
  }
  const inputTokenPriceBands = Array.isArray(raw.inputTokenPriceBands)
    ? raw.inputTokenPriceBands
        .map((value) => normalizeComparableBand(value))
        .filter((value): value is NonNullable<typeof value> => value !== undefined)
    : undefined;
  return {
    currency: raw.currency,
    inputPerMtok: raw.inputPerMtok,
    outputPerMtok: raw.outputPerMtok,
    cacheReadPerMtok: finiteNonNegative(raw.cacheReadPerMtok) ? raw.cacheReadPerMtok : null,
    cacheCreatePerMtok: finiteNonNegative(raw.cacheCreatePerMtok) ? raw.cacheCreatePerMtok : null,
    ...(inputTokenPriceBands?.length ? { inputTokenPriceBands } : {}),
  };
}

function normalizeComparableBand(
  value: unknown,
): NonNullable<ModelPriceQuote['inputTokenPriceBands']>[number] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    !finiteNonNegative(raw.minInputTokens) ||
    (raw.maxInputTokens !== undefined &&
      (!finiteNonNegative(raw.maxInputTokens) || raw.maxInputTokens <= raw.minInputTokens))
  ) {
    return undefined;
  }
  const band: NonNullable<ModelPriceQuote['inputTokenPriceBands']>[number] = {
    minInputTokens: raw.minInputTokens,
    ...(raw.maxInputTokens !== undefined ? { maxInputTokens: raw.maxInputTokens as number } : {}),
  };
  for (const field of [
    'inputPerMtok',
    'outputPerMtok',
    'cacheReadPerMtok',
    'cacheCreatePerMtok',
  ] as const) {
    if (finiteNonNegative(raw[field])) band[field] = raw[field];
  }
  return band;
}

function normalize(raw: unknown): ModelPriceOverridePrefs {
  const entries: Record<string, StoredModelPriceOverride> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: STORE_VERSION, entries: {} };
  }
  const source = (raw as { entries?: unknown }).entries;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { version: STORE_VERSION, entries: {} };
  }
  let count = 0;
  for (const value of Object.values(source as Record<string, unknown>)) {
    if (count >= MAX_ENTRIES) break;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const values = normalizeValues(record.values);
    const baseReference = normalizeComparable(record.baseReference);
    if (
      typeof record.providerId !== 'string' ||
      !record.providerId ||
      record.providerId.length > 256 ||
      !isAgent(record.agent) ||
      typeof record.modelId !== 'string' ||
      !record.modelId ||
      record.modelId.length > 256 ||
      !values ||
      baseReference === undefined ||
      typeof record.updatedAt !== 'string'
    ) {
      continue;
    }
    const normalized: StoredModelPriceOverride = {
      providerId: record.providerId,
      agent: record.agent,
      modelId: record.modelId,
      values,
      baseReference,
      updatedAt: record.updatedAt,
    };
    entries[overrideKey(normalized)] = normalized;
    count += 1;
  }
  return { version: STORE_VERSION, entries };
}

const store = createOverrideSettingsFile<ModelPriceOverridePrefs>({
  filePath: () => ownerScopedUserDataPath('model-price-overrides.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'model-price-overrides',
});

function comparable(quote: ModelPriceQuote | undefined): ComparablePrice | null {
  if (!quote) return null;
  return {
    currency: quote.currency,
    inputPerMtok: quote.inputPerMtok,
    outputPerMtok: quote.outputPerMtok,
    cacheReadPerMtok: quote.cacheReadPerMtok ?? null,
    cacheCreatePerMtok: quote.cacheCreatePerMtok ?? null,
    ...(quote.inputTokenPriceBands ? { inputTokenPriceBands: quote.inputTokenPriceBands } : {}),
  };
}

function sameComparable(a: ComparablePrice | null, b: ComparablePrice | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sparseValues(
  desired: ModelPriceOverrideDesiredQuote,
  reference: ComparablePrice | null,
): ModelPriceOverrideValues {
  if (!reference) return { ...desired };
  const values: ModelPriceOverrideValues = {};
  const currencyChanged = desired.currency !== reference.currency;
  if (currencyChanged) values.currency = desired.currency;
  // Currency changes cannot reuse any numeric value from the reference quote: doing so would
  // relabel (for example) USD long-context bands as CNY without an exchange conversion. Persist
  // the complete user-entered quote so mergedQuote rewrites every inherited band in the new unit.
  if (currencyChanged) {
    values.inputPerMtok = desired.inputPerMtok;
    values.outputPerMtok = desired.outputPerMtok;
    values.cacheReadPerMtok = desired.cacheReadPerMtok ?? null;
    values.cacheCreatePerMtok = desired.cacheCreatePerMtok ?? null;
    return values;
  }
  if (desired.inputPerMtok !== reference.inputPerMtok) {
    values.inputPerMtok = desired.inputPerMtok;
  }
  if (desired.outputPerMtok !== reference.outputPerMtok) {
    values.outputPerMtok = desired.outputPerMtok;
  }
  if ((desired.cacheReadPerMtok ?? null) !== reference.cacheReadPerMtok) {
    values.cacheReadPerMtok = desired.cacheReadPerMtok ?? null;
  }
  if ((desired.cacheCreatePerMtok ?? null) !== reference.cacheCreatePerMtok) {
    values.cacheCreatePerMtok = desired.cacheCreatePerMtok ?? null;
  }
  return values;
}

function mergedQuote(
  target: ModelPriceOverrideTarget,
  reference: ModelPriceQuote | undefined,
  values: ModelPriceOverrideValues | undefined,
  baseReference?: ComparablePrice | null,
): ModelPriceQuote | undefined {
  if (!values) return reference;
  const savedBaseQuote = baseReference
    ? {
        providerId: target.providerId,
        modelId: target.modelId,
        source: reference?.source ?? ('provider-reference' as const),
        approximate: reference?.approximate ?? true,
        currency: baseReference.currency,
        inputPerMtok: baseReference.inputPerMtok,
        outputPerMtok: baseReference.outputPerMtok,
        ...(baseReference.cacheReadPerMtok !== null
          ? { cacheReadPerMtok: baseReference.cacheReadPerMtok }
          : {}),
        ...(baseReference.cacheCreatePerMtok !== null
          ? { cacheCreatePerMtok: baseReference.cacheCreatePerMtok }
          : {}),
        ...(baseReference.inputTokenPriceBands
          ? { inputTokenPriceBands: baseReference.inputTokenPriceBands }
          : {}),
      }
    : undefined;
  // A same-currency update can drop the long-context bands the patch was saved
  // against (typical of a fidelity downgrade to a band-less fallback catalog).
  // Discarding the bands would flatten long-context estimates, but freezing the
  // whole saved snapshot would also stop un-overridden base prices from following
  // the remote. Split the difference: base prices keep following the new
  // reference, while each saved band keeps its relative multiplier and is
  // re-anchored onto the new baselines.
  const reAnchorBandValue = (
    bandValue: number | undefined,
    savedBaseValue: number | undefined,
    referenceValue: number | undefined,
  ): number | undefined => {
    if (bandValue === undefined) return undefined;
    return savedBaseValue !== undefined && savedBaseValue > 0 && referenceValue !== undefined
      ? (bandValue / savedBaseValue) * referenceValue
      : bandValue;
  };
  const bandPreservingReference =
    savedBaseQuote?.inputTokenPriceBands !== undefined &&
    reference &&
    values.currency === undefined &&
    savedBaseQuote.currency === reference.currency &&
    reference.inputTokenPriceBands === undefined
      ? {
          ...reference,
          inputTokenPriceBands: savedBaseQuote.inputTokenPriceBands.map((band) => ({
            ...band,
            inputPerMtok: reAnchorBandValue(
              band.inputPerMtok,
              savedBaseQuote.inputPerMtok,
              reference.inputPerMtok,
            ),
            outputPerMtok: reAnchorBandValue(
              band.outputPerMtok,
              savedBaseQuote.outputPerMtok,
              reference.outputPerMtok,
            ),
            cacheReadPerMtok: reAnchorBandValue(
              band.cacheReadPerMtok,
              savedBaseQuote.cacheReadPerMtok,
              reference.cacheReadPerMtok,
            ),
            cacheCreatePerMtok: reAnchorBandValue(
              band.cacheCreatePerMtok,
              savedBaseQuote.cacheCreatePerMtok,
              reference.cacheCreatePerMtok,
            ),
          })),
        }
      : undefined;
  // A sparse numeric patch was entered in the saved base currency. If the remote
  // route later changes currency or loses its reference price, merging it into the
  // new/empty quote would silently relabel or discard the user's number. Keep using
  // the saved reference as the merge base until the user accepts/reset the conflict.
  const mergeReference =
    bandPreservingReference ??
    (savedBaseQuote &&
    (!reference ||
      (values.currency === undefined && savedBaseQuote.currency !== reference.currency))
      ? savedBaseQuote
      : reference);
  const currency = values.currency ?? mergeReference?.currency;
  const inputPerMtok = values.inputPerMtok ?? mergeReference?.inputPerMtok;
  const outputPerMtok = values.outputPerMtok ?? mergeReference?.outputPerMtok;
  if (!currency || inputPerMtok === undefined || outputPerMtok === undefined) return undefined;
  const cacheReadPerMtok =
    values.cacheReadPerMtok === null
      ? undefined
      : (values.cacheReadPerMtok ?? mergeReference?.cacheReadPerMtok);
  const cacheCreatePerMtok =
    values.cacheCreatePerMtok === null
      ? undefined
      : (values.cacheCreatePerMtok ?? mergeReference?.cacheCreatePerMtok);
  const projectBandValue = (
    bandValue: number | undefined,
    referenceValue: number | undefined,
    overrideValue: number,
  ): number | undefined => {
    if (bandValue === undefined) return undefined;
    // A base-price edit does not erase the provider's long-context pricing curve. Preserve each
    // inherited tier's relative multiplier for both same-currency edits and currency switches;
    // otherwise editing the baseline would flatten every tier to the same price.
    return referenceValue !== undefined && referenceValue > 0
      ? (bandValue / referenceValue) * overrideValue
      : overrideValue;
  };
  const inputTokenPriceBands = mergeReference?.inputTokenPriceBands?.map((band) => {
    const merged = { ...band };
    if (values.inputPerMtok !== undefined) {
      merged.inputPerMtok = projectBandValue(
        band.inputPerMtok,
        mergeReference.inputPerMtok,
        values.inputPerMtok,
      );
    }
    if (values.outputPerMtok !== undefined) {
      merged.outputPerMtok = projectBandValue(
        band.outputPerMtok,
        mergeReference.outputPerMtok,
        values.outputPerMtok,
      );
    }
    if (values.cacheReadPerMtok === null) delete merged.cacheReadPerMtok;
    else if (values.cacheReadPerMtok !== undefined) {
      merged.cacheReadPerMtok = projectBandValue(
        band.cacheReadPerMtok,
        mergeReference.cacheReadPerMtok,
        values.cacheReadPerMtok,
      );
    }
    if (values.cacheCreatePerMtok === null) delete merged.cacheCreatePerMtok;
    else if (values.cacheCreatePerMtok !== undefined) {
      merged.cacheCreatePerMtok = projectBandValue(
        band.cacheCreatePerMtok,
        mergeReference.cacheCreatePerMtok,
        values.cacheCreatePerMtok,
      );
    }
    return merged;
  });
  return {
    providerId: target.providerId,
    modelId: target.modelId,
    currency,
    source: 'user-override',
    approximate: true,
    inputPerMtok,
    outputPerMtok,
    ...(inputTokenPriceBands ? { inputTokenPriceBands } : {}),
    ...(cacheReadPerMtok !== undefined ? { cacheReadPerMtok } : {}),
    ...(cacheCreatePerMtok !== undefined ? { cacheCreatePerMtok } : {}),
  };
}

function currencyCanProjectToLedger(
  currency: MoneyCurrency,
  ledgerCurrency: MoneyCurrency,
): boolean {
  return currency === ledgerCurrency || (currency === 'USD' && ledgerCurrency === 'CNY');
}

function allowedCurrenciesForLedger(ledgerCurrency: MoneyCurrency): MoneyCurrency[] {
  return ledgerCurrency === 'USD' ? ['USD'] : ['USD', 'CNY'];
}

function readEntries(): Record<string, StoredModelPriceOverride> {
  store.invalidateIfChanged();
  return store.read().entries;
}

export function readModelPriceOverrideView(
  target: ModelPriceOverrideTarget,
  registry: ModelRegistry | null | undefined,
  ledgerCurrency: MoneyCurrency = currentLedgerCurrency(),
): ModelPriceOverrideView {
  const remoteReference = providerReferencePriceQuote(target.providerId, target.modelId, registry, {
    agent: target.agent,
  });
  const reference =
    remoteReference && currencyCanProjectToLedger(remoteReference.currency, ledgerCurrency)
      ? remoteReference
      : undefined;
  const record = readEntries()[overrideKey(target)];
  const merged = mergedQuote(target, reference, record?.values, record?.baseReference);
  return {
    target,
    editable: target.providerId !== 'xd',
    reference: reference ?? null,
    effective:
      merged && currencyCanProjectToLedger(merged.currency, ledgerCurrency)
        ? merged
        : (reference ?? null),
    override: record?.values ?? null,
    conflict: Boolean(record && !sameComparable(record.baseReference, comparable(remoteReference))),
    registryUpdatedAt: registry?.updatedAt ?? null,
    allowedCurrencies: allowedCurrenciesForLedger(ledgerCurrency),
  };
}

export function setModelPriceOverride(
  target: ModelPriceOverrideTarget,
  desired: ModelPriceOverrideDesiredQuote,
  registry: ModelRegistry | null | undefined,
): void {
  if (target.providerId === 'xd') {
    throw new Error('Cindy AI Gateway pricing cannot be overridden');
  }
  const reference = providerReferencePriceQuote(target.providerId, target.modelId, registry, {
    agent: target.agent,
  });
  const baseReference = comparable(reference);
  const values = sparseValues(desired, baseReference);
  const entries = { ...readEntries() };
  const key = overrideKey(target);
  if (Object.keys(values).length === 0) {
    if (key in entries) {
      delete entries[key];
      store.writePatch({ entries });
    }
    return;
  }
  if (!(key in entries) && Object.keys(entries).length >= MAX_ENTRIES) {
    throw new Error('model price override limit reached');
  }
  entries[key] = {
    ...target,
    values,
    baseReference,
    updatedAt: new Date().toISOString(),
  };
  store.writePatch({ entries });
}

export function clearModelPriceOverride(target: ModelPriceOverrideTarget): void {
  const entries = { ...readEntries() };
  const key = overrideKey(target);
  if (!(key in entries)) return;
  delete entries[key];
  store.writePatch({ entries });
}

/**
 * Custom-provider deletion cleanup. The caller serializes this with provider config mutations;
 * the returned closure restores only this provider's removed records while preserving unrelated
 * override writes.
 */
export function stageProviderModelPriceOverridesClear(providerId: string): () => boolean {
  const entries = readEntries();
  const removed = Object.fromEntries(
    Object.entries(entries).filter(([, record]) => record.providerId === providerId),
  );
  if (Object.keys(removed).length === 0) return () => true;
  store.writePatch({
    entries: Object.fromEntries(
      Object.entries(entries).filter(([, record]) => record.providerId !== providerId),
    ),
  });
  return () => {
    try {
      store.writePatch({ entries: { ...readEntries(), ...removed } });
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * 覆盖记录的一次性快照。历史用量聚合按 model-day 逐行取价,每行都走
 * `readEntries()` 会重复 stat 覆盖文件(Windows/慢盘上数百上千次同步磁盘访问);
 * 聚合开始时读一次快照、贯穿整轮复用。
 */
export type ModelPriceOverridesSnapshot = Readonly<Record<string, StoredModelPriceOverride>>;

export function readModelPriceOverridesSnapshot(): ModelPriceOverridesSnapshot {
  return readEntries();
}

/**
 * 把持久化的稀疏覆盖合并到调用方给定的参考价上（典型:按历史日期 `at` 解析出的
 * 参考价）。目录里烘焙的 user-override 报价是按当前日期合并的,历史估值不能直接
 * 回用——未覆盖字段必须跟随查询时点的参考价。无该目标的覆盖记录时返回 undefined。
 * 批量取价的调用方应传入同一份 `entries` 快照,避免逐行重读覆盖文件。
 */
export function mergeStoredModelPriceOverride(
  target: ModelPriceOverrideTarget,
  reference: ModelPriceQuote | undefined,
  entries: ModelPriceOverridesSnapshot = readEntries(),
): ModelPriceQuote | undefined {
  const record = entries[overrideKey(target)];
  if (!record) return undefined;
  return mergedQuote(record, reference, record.values, record.baseReference);
}

export function applyModelPriceOverrides(
  pricing: ModelPricingCatalog,
  registry: ModelRegistry | null | undefined,
  ledgerCurrency: MoneyCurrency = currentLedgerCurrency(),
): ModelPricingCatalog {
  const next: ModelPricingCatalog = Object.fromEntries(
    Object.entries(pricing).map(([providerId, quotes]) => [
      providerId,
      Object.fromEntries(
        Object.entries(quotes).filter(
          ([, quote]) =>
            quote.source === 'gateway' ||
            currencyCanProjectToLedger(quote.currency, ledgerCurrency),
        ),
      ),
    ]),
  );
  for (const record of Object.values(readEntries())) {
    if (record.providerId === 'xd') continue;
    const reference = providerReferencePriceQuote(record.providerId, record.modelId, registry, {
      agent: record.agent,
    });
    const quote = mergedQuote(record, reference, record.values, record.baseReference);
    if (!quote || !currencyCanProjectToLedger(quote.currency, ledgerCurrency)) continue;
    (next[record.providerId] ??= {})[modelPricingKey(record.modelId, record.agent)] = quote;
  }
  return next;
}

export const __testing = {
  normalize,
  overrideKey,
  sparseValues,
  sameComparable,
  mergedQuote,
  currencyCanProjectToLedger,
};
