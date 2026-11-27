import { z } from 'zod';
import {
  SETTINGS_READ_CATALOG, SETTINGS_READ_COLLECTION_CATALOG, SETTINGS_READ_COLLECTION_IDS,
  settingsReadReferenceSchema, settingsReadPublicIdentifierSchema,
  type SettingsSnapshotCollectionId,
} from './settingsReadCatalog.js';
import { SETTINGS_SNAPSHOT_V2_FIELD_IDS, type SettingsSnapshotV2FieldId } from './settingsSnapshotV2FieldIds.js';
export { SETTINGS_SNAPSHOT_V2_FIELD_IDS, type SettingsSnapshotV2FieldId } from './settingsSnapshotV2FieldIds.js';
export type { SettingsSnapshotFieldId, SettingsSnapshotCollectionId } from './settingsReadCatalog.js';

/** v1 的 8 KiB 常量和 parser 留在原模块，绝不借 v2 放宽旧报文。 */
export const SETTINGS_SNAPSHOT_V2_SCHEMA_VERSION = 2 as const;
export const SETTINGS_SNAPSHOT_V2_MAX_BYTES = 128 * 1024;
export const SETTINGS_SNAPSHOT_V2_FIXED_MAX_BYTES = 96 * 1024;
export const SETTINGS_SNAPSHOT_V2_COLLECTIONS_MAX_BYTES = 24 * 1024;
export const SETTINGS_SNAPSHOT_V2_ENVELOPE_MAX_BYTES = 8 * 1024;
export const SETTINGS_SNAPSHOT_COLLECTION_MAX_ITEMS = 32;
export const SETTINGS_SNAPSHOT_COLLECTION_MAX_BYTES = 4 * 1024;
export const settingsSnapshotSourceV2Schema = z.enum(['default', 'override', 'unknown']);
export const settingsSnapshotUnavailableStatusSchema = z.enum(['unavailable', 'unreadable', 'unsupported', 'migrationPending', 'private']);
export type SettingsSnapshotUnavailableStatus = z.infer<typeof settingsSnapshotUnavailableStatusSchema>;
export type SettingsSnapshotSourceV2 = z.infer<typeof settingsSnapshotSourceV2Schema>;
export type SettingsSnapshotFieldV2<T> =
  | { status: 'value'; value: T; source: SettingsSnapshotSourceV2 }
  | { status: SettingsSnapshotUnavailableStatus };
export type SettingsSnapshotFieldsV2 = {
  [K in SettingsSnapshotV2FieldId]: SettingsSnapshotFieldV2<z.infer<typeof SETTINGS_READ_CATALOG[K]['valueSchema']>>;
};
export function settingsSnapshotFieldV2Schema<T extends z.core.$ZodType>(value: T) {
  return z.union([
    z.strictObject({ status: z.literal('value'), value, source: settingsSnapshotSourceV2Schema }),
    z.strictObject({ status: settingsSnapshotUnavailableStatusSchema }),
  ]);
}
export const settingsSnapshotFieldsV2Schema: z.ZodType<SettingsSnapshotFieldsV2> = z.strictObject(
  Object.fromEntries(SETTINGS_SNAPSHOT_V2_FIELD_IDS.map(id => [id, settingsSnapshotFieldV2Schema(SETTINGS_READ_CATALOG[id].valueSchema)])),
) as unknown as z.ZodType<SettingsSnapshotFieldsV2>;

export type SettingsSnapshotCollectionEntry<K extends SettingsSnapshotCollectionId> = z.infer<typeof SETTINGS_READ_COLLECTION_CATALOG[K]['entrySchema']>;
export type SettingsSnapshotCollectionV2<K extends SettingsSnapshotCollectionId> = {
  status: 'complete' | 'partial' | SettingsSnapshotUnavailableStatus;
  total: number | null;
  omitted: number | null;
  entries: SettingsSnapshotCollectionEntry<K>[];
};
export type SettingsSnapshotCollectionsV2 = { [K in SettingsSnapshotCollectionId]: SettingsSnapshotCollectionV2<K> };
const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
function collectionSchema(entrySchema: z.core.$ZodType) {
  return z.strictObject({
    status: z.enum(['complete', 'partial', 'unavailable', 'unreadable', 'unsupported', 'migrationPending', 'private']),
    total: safeCount.nullable(), omitted: safeCount.nullable(),
    entries: z.array(entrySchema as z.core.$ZodType<{ ordinal: number }>).max(SETTINGS_SNAPSHOT_COLLECTION_MAX_ITEMS),
  }).superRefine((value, ctx) => {
    const fail = () => ctx.addIssue({ code: 'custom', message: 'INVALID_COLLECTION_COMPLETENESS' });
    if (value.status !== 'complete' && value.status !== 'partial') {
      if (value.total !== null || value.omitted !== null || value.entries.length !== 0) fail();
    } else if (value.total === null) {
      if (value.status !== 'partial' || value.omitted !== null) fail();
    } else {
      const omitted = value.total - value.entries.length;
      if (omitted < 0 || value.omitted !== omitted || (value.status === 'complete') !== (omitted === 0)) fail();
    }
    let previous = 0;
    for (const entry of value.entries) {
      if (entry.ordinal <= previous || (value.total !== null && entry.ordinal > value.total)) fail();
      previous = entry.ordinal;
    }
    if (settingsSnapshotUtf8Bytes(value) > SETTINGS_SNAPSHOT_COLLECTION_MAX_BYTES) {
      ctx.addIssue({ code: 'custom', message: 'COLLECTION_BUDGET_EXCEEDED' });
    }
  });
}
export const settingsSnapshotCollectionsV2Schema: z.ZodType<SettingsSnapshotCollectionsV2> = z.strictObject(
  Object.fromEntries(SETTINGS_READ_COLLECTION_IDS.map(id => [id, collectionSchema(SETTINGS_READ_COLLECTION_CATALOG[id].entrySchema)])),
) as unknown as z.ZodType<SettingsSnapshotCollectionsV2>;
const reportV2Shape = z.strictObject({
  schemaVersion: z.literal(SETTINGS_SNAPSHOT_V2_SCHEMA_VERSION), reportId: z.string().uuid(),
  baseRevision: safeCount, capturedAtMs: safeCount,
  fields: settingsSnapshotFieldsV2Schema, collections: settingsSnapshotCollectionsV2Schema,
});
export type SettingsSnapshotReportV2 = z.infer<typeof reportV2Shape>;
export const settingsSnapshotReportV2Schema = reportV2Shape.superRefine((value, ctx) => {
  if (!validateSettingsSnapshotBudget(value).ok) ctx.addIssue({ code: 'custom', message: 'SNAPSHOT_BUDGET_EXCEEDED' });
});

/** JSON 的实际 UTF-8 长度，不能拿 JS 字符数、字段数或格式化后的大小代替。 */
export function settingsSnapshotUtf8Bytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : new TextEncoder().encode(json).byteLength;
}
export function settingsSnapshotMaxBytesForVersion(version: 1 | 2): number {
  if (version === 1) return 8 * 1024;
  if (version === 2) return SETTINGS_SNAPSHOT_V2_MAX_BYTES;
  throw new Error('UNSUPPORTED_SETTINGS_SNAPSHOT_VERSION');
}
export type SettingsSnapshotBudgetViolation = 'report' | 'raw' | 'fixed' | 'collections' | 'envelope' | 'collection';
export interface SettingsSnapshotBudgetResult {
  ok: boolean; version: 1 | 2; bytes: number; fixedBytes: number; collectionsBytes: number; envelopeBytes: number;
  violations: SettingsSnapshotBudgetViolation[];
}
/** 只负责预算。调用方先走 strict parser；rawBytes 是未经 JSON 规整的原始 HTTP body 大小。 */
export function validateSettingsSnapshotBudget(
  report: { schemaVersion: 1 } | SettingsSnapshotReportV2, rawBytes?: number,
): SettingsSnapshotBudgetResult {
  const bytes = settingsSnapshotUtf8Bytes(report);
  const fixedBytes = report.schemaVersion === 2 ? settingsSnapshotUtf8Bytes(report.fields) : 0;
  const collectionsBytes = report.schemaVersion === 2 ? settingsSnapshotUtf8Bytes(report.collections) : 0;
  const envelopeBytes = bytes - fixedBytes - collectionsBytes;
  const maxBytes = settingsSnapshotMaxBytesForVersion(report.schemaVersion);
  const violations: SettingsSnapshotBudgetViolation[] = [];
  if (bytes > maxBytes) violations.push('report');
  if (rawBytes !== undefined && (!Number.isSafeInteger(rawBytes) || rawBytes < 0 || rawBytes > maxBytes)) violations.push('raw');
  if (report.schemaVersion === 2) {
    if (fixedBytes > SETTINGS_SNAPSHOT_V2_FIXED_MAX_BYTES) violations.push('fixed');
    if (collectionsBytes > SETTINGS_SNAPSHOT_V2_COLLECTIONS_MAX_BYTES) violations.push('collections');
    if (envelopeBytes > SETTINGS_SNAPSHOT_V2_ENVELOPE_MAX_BYTES) violations.push('envelope');
    if (Object.values(report.collections).some(value => value.entries.length > SETTINGS_SNAPSHOT_COLLECTION_MAX_ITEMS
      || settingsSnapshotUtf8Bytes(value) > SETTINGS_SNAPSHOT_COLLECTION_MAX_BYTES)) violations.push('collection');
  }
  return { ok: violations.length === 0, version: report.schemaVersion, bytes, fixedBytes, collectionsBytes, envelopeBytes, violations };
}

/** 仅用于初始化一次采样；聚合器必须逐项以实际读取结果覆盖，不代表读取已完成。 */
export function createSettingsSnapshotV2UnavailableFields(status: SettingsSnapshotUnavailableStatus = 'unavailable'): SettingsSnapshotFieldsV2 {
  return Object.fromEntries(SETTINGS_SNAPSHOT_V2_FIELD_IDS.map(id => [id, { status }])) as SettingsSnapshotFieldsV2;
}
export function createSettingsSnapshotV2UnavailableCollections(status: SettingsSnapshotUnavailableStatus = 'unavailable'): SettingsSnapshotCollectionsV2 {
  return Object.fromEntries(SETTINGS_READ_COLLECTION_IDS.map(id => [id, { status, total: null, omitted: null, entries: [] }])) as unknown as SettingsSnapshotCollectionsV2;
}

/** 公共目录证据由调用者注入，不发起网络、读取凭据、归一化或哈希私密标识。 */
export function projectSettingsSnapshotPublicReference(raw: string | null, publicIds: ReadonlySet<string>): z.infer<typeof settingsReadReferenceSchema> {
  if (raw === null || raw.length === 0) return { configured: false };
  return publicIds.has(raw) && settingsReadPublicIdentifierSchema.safeParse(raw).success
    ? { configured: true, publicId: raw } : { configured: true };
}

/**
 * 所有摘要先保留，再按目录序轮转分配明细。只裁动态条目，不截字符串、不动固定字段。
 * 输入必须已是逐条安全投影；本函数绝不吞掉非法条目或把未知总量伪装成完整。
 */
export function boundSettingsSnapshotCollections(input: SettingsSnapshotCollectionsV2): SettingsSnapshotCollectionsV2 {
  const output = createSettingsSnapshotV2UnavailableCollections();
  for (const id of SETTINGS_READ_COLLECTION_IDS) {
    const collection = input[id];
    if (!collection) throw new Error('MISSING_SETTINGS_COLLECTION');
    for (const entry of collection.entries) z.parse(SETTINGS_READ_COLLECTION_CATALOG[id].entrySchema, entry);
    if (collection.status !== 'complete' && collection.status !== 'partial') {
      collectionSchema(SETTINGS_READ_COLLECTION_CATALOG[id].entrySchema).parse(collection);
      Object.assign(output[id], collection, { entries: [] });
    } else {
      if (collection.total === null) {
        if (collection.status !== 'partial' || collection.omitted !== null) throw new Error('INVALID_COLLECTION_TOTAL');
      } else {
        if (!Number.isSafeInteger(collection.total) || collection.total < collection.entries.length
          || collection.omitted !== collection.total - collection.entries.length
          || (collection.status === 'complete') !== (collection.omitted === 0)) throw new Error('INVALID_COLLECTION_TOTAL');
      }
      let previous = 0;
      for (const entry of collection.entries) {
        if (entry.ordinal <= previous || (collection.total !== null && entry.ordinal > collection.total)) throw new Error('INVALID_COLLECTION_ORDINAL');
        previous = entry.ordinal;
      }
      Object.assign(output[id], { status: collection.total === 0 ? 'complete' : 'partial',
        total: collection.total, omitted: collection.total, entries: [] });
    }
  }
  if (settingsSnapshotUtf8Bytes(output) > SETTINGS_SNAPSHOT_V2_COLLECTIONS_MAX_BYTES) throw new Error('COLLECTION_SUMMARIES_TOO_LARGE');
  for (let index = 0; index < SETTINGS_SNAPSHOT_COLLECTION_MAX_ITEMS; index += 1) {
    for (const id of SETTINGS_READ_COLLECTION_IDS) {
      const original = input[id];
      const target = output[id];
      if (original.status !== 'complete' && original.status !== 'partial') continue;
      // 被某轮容量阻断的集合不跳过中间项，保持原持久顺序。
      if (target.entries.length !== index || original.entries.length <= index) continue;
      const candidate = { ...target, entries: [...target.entries, original.entries[index]],
        omitted: target.total === null ? null : target.total - index - 1,
        status: target.total === index + 1 ? 'complete' as const : 'partial' as const };
      if (settingsSnapshotUtf8Bytes(candidate) > SETTINGS_SNAPSHOT_COLLECTION_MAX_BYTES) continue;
      if (settingsSnapshotUtf8Bytes({ ...output, [id]: candidate }) > SETTINGS_SNAPSHOT_V2_COLLECTIONS_MAX_BYTES) continue;
      Object.assign(target, candidate);
    }
  }
  return settingsSnapshotCollectionsV2Schema.parse(output);
}

export const SETTINGS_SNAPSHOT_CAPABILITIES = {
  schemaVersion: 1 as const, supportedVersions: [1, 2] as [1, 2],
  limits: {
    v1: { maxBytes: 8192 as const },
    v2: { maxBytes: SETTINGS_SNAPSHOT_V2_MAX_BYTES, fixedBytes: SETTINGS_SNAPSHOT_V2_FIXED_MAX_BYTES,
      collectionsBytes: SETTINGS_SNAPSHOT_V2_COLLECTIONS_MAX_BYTES, envelopeBytes: SETTINGS_SNAPSHOT_V2_ENVELOPE_MAX_BYTES,
      collectionMaxBytes: SETTINGS_SNAPSHOT_COLLECTION_MAX_BYTES, collectionMaxEntries: SETTINGS_SNAPSHOT_COLLECTION_MAX_ITEMS },
  },
};
const capabilityV1Limit = z.strictObject({ maxBytes: z.literal(8192) });
const capabilityV2Limit = z.strictObject({
  maxBytes: z.literal(SETTINGS_SNAPSHOT_V2_MAX_BYTES), fixedBytes: z.literal(SETTINGS_SNAPSHOT_V2_FIXED_MAX_BYTES),
  collectionsBytes: z.literal(SETTINGS_SNAPSHOT_V2_COLLECTIONS_MAX_BYTES), envelopeBytes: z.literal(SETTINGS_SNAPSHOT_V2_ENVELOPE_MAX_BYTES),
  collectionMaxBytes: z.literal(SETTINGS_SNAPSHOT_COLLECTION_MAX_BYTES), collectionMaxEntries: z.literal(SETTINGS_SNAPSHOT_COLLECTION_MAX_ITEMS),
});
export const settingsSnapshotCapabilitiesSchema = z.union([
  z.strictObject({ schemaVersion: z.literal(1), supportedVersions: z.tuple([z.literal(1), z.literal(2)]),
    limits: z.strictObject({ v1: capabilityV1Limit, v2: capabilityV2Limit }) }),
  z.strictObject({ schemaVersion: z.literal(1), supportedVersions: z.tuple([z.literal(1)]),
    limits: z.strictObject({ v1: capabilityV1Limit }) }),
]);

/** 两仓共同的非秘密 fixture，状态值也有完整叶子，不冒充实际 Host 已读取报告。 */
export const SETTINGS_SNAPSHOT_V2_COMPATIBILITY_FIXTURE: SettingsSnapshotReportV2 = {
  schemaVersion: 2, reportId: '00000000-0000-4000-8000-000000000002', baseRevision: 0, capturedAtMs: 1_800_000_000_000,
  fields: { ...createSettingsSnapshotV2UnavailableFields('unsupported'),
    'databaseWarning.thresholdGiB': { status: 'value', value: 1, source: 'default' },
    'appearance.uiFontSize': { status: 'value', value: 14, source: 'override' },
    'personalization.customized': { status: 'value', value: true, source: 'unknown' },
  },
  collections: createSettingsSnapshotV2UnavailableCollections(),
};
