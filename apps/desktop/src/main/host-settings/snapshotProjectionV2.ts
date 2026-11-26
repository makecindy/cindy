import { z } from 'zod';
import { parseAuxiliaryModelRef } from '../../shared/auxiliaryModelChain.js';
import {
  SETTINGS_READ_CATALOG, SETTINGS_READ_COLLECTION_CATALOG, SETTINGS_READ_COLLECTION_IDS,
  type SettingsSnapshotFieldId, type SettingsSnapshotCollectionId,
} from '../../shared/settingsReadCatalog.js';
import {
  boundSettingsSnapshotCollections, createSettingsSnapshotV2UnavailableCollections, SETTINGS_SNAPSHOT_V2_FIELD_IDS,
  projectSettingsSnapshotPublicReference, settingsSnapshotFieldsV2Schema,
  type SettingsSnapshotCollectionsV2, type SettingsSnapshotReportV2,
} from '../../shared/settingsSnapshotV2.js';
import type { ReadonlySettingsInspection, ReadonlySettingSource, ReadonlySettingUnavailableStatus } from './readTypes.js';

/** 只能由随包公开目录构造；活动目录、用户连接和组织发现不构成公开性证据。 */
export interface SettingsPublicIdentifiers {
  models: ReadonlySet<string>;
  providers: ReadonlySet<string>;
}
export const NO_PUBLIC_SETTINGS_IDENTIFIERS: SettingsPublicIdentifiers = { models: new Set(), providers: new Set() };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_SETTING_STRUCTURE');
  return value as Record<string, unknown>;
}
function reference(value: unknown, ids: ReadonlySet<string>) {
  if (value !== null && typeof value !== 'string') throw new Error('INVALID_SETTING_REFERENCE');
  return projectSettingsSnapshotPublicReference(value, ids);
}
function auxiliaryRoute(value: unknown, ids: SettingsPublicIdentifiers) {
  if (typeof value !== 'string') throw new Error('INVALID_SETTING_ROUTE');
  const parsed = parseAuxiliaryModelRef(value);
  if (!parsed) throw new Error('INVALID_SETTING_ROUTE');
  // 轻量来源的实际型号可能由专用配置解析；只读报告不为解析它而读取凭据。
  if (parsed.kind === 'profile') return { model: { configured: true }, provider: { configured: true } };
  return { model: reference(parsed.route.model, ids.models), provider: reference(parsed.route.providerId, ids.providers) };
}
function projectFieldValue(id: SettingsSnapshotFieldId, value: unknown, ids: SettingsPublicIdentifiers): unknown {
  const definition = SETTINGS_READ_CATALOG[id];
  if (definition.privacy === 'publicReference') {
    return reference(value, id.endsWith('providerId') || id.endsWith('ProviderId') ? ids.providers : ids.models);
  }
  if (id === 'auxiliaryModel.models' || id === 'voice.refinerChain') {
    if (!Array.isArray(value)) throw new Error('INVALID_SETTING_CHAIN');
    return value.map(item => auxiliaryRoute(item, ids));
  }
  if (id === 'botModelChain.modelChain') {
    if (!Array.isArray(value)) throw new Error('INVALID_SETTING_CHAIN');
    return value.map(item => {
      const route = object(item);
      return { harness: route.harness === 'claude' ? 'claude-code' : route.harness,
        model: reference(route.model, ids.models), provider: reference(route.providerId, ids.providers),
        effort: route.effort === '' ? null : route.effort, fastMode: route.fastMode === 'ultrafast' ? true : route.fastMode };
    });
  }
  if ((id === 'visionBridge.primary' || id === 'visionBridge.fallback') && value !== null) {
    const route = object(value);
    return { model: reference(route.modelId, ids.models), provider: reference(route.providerId, ids.providers) };
  }
  // 其它结构由真实领域 reader 逐叶去敏；此处严格 schema 再次拒绝额外字段。
  return value;
}
function collectionSource(values: ReadonlySettingSource[]): ReadonlySettingSource {
  return values.length && values.every(value => value === values[0]) ? values[0] : 'unknown';
}
function projectCollection(id: SettingsSnapshotCollectionId, input: ReadonlySettingsInspection, ids: SettingsPublicIdentifiers) {
  const state = input.collections?.[id];
  if (!state) throw new Error('MISSING_SETTINGS_COLLECTION_READER');
  if (state.status !== 'value') return { status: state.status, total: null, omitted: null, entries: [] };
  let failureStatus: ReadonlySettingUnavailableStatus = 'unreadable';
  try {
    const schema = SETTINGS_READ_COLLECTION_CATALOG[id].entrySchema;
    const entries = state.entries.map((entry, index) => {
      const next: Record<string, unknown> = { ordinal: index + 1 };
      const sources: ReadonlySettingSource[] = [];
      // 只从契约声明的叶子取值；不读取或发送私有key、路径、标题或entry原对象。
      for (const key of Object.keys(schema.shape)) {
        if (key === 'ordinal' || key === 'source') continue;
        const field = entry.fields[key];
        if (!field) continue;
        if (field.status !== 'value') { failureStatus = field.status; throw new Error('UNREADABLE_COLLECTION_ENTRY'); }
        sources.push(field.source);
        next[key] = id === 'visionBridgeTargets' && key === 'model'
          ? reference(field.value, ids.models) : field.value;
      }
      next.source = collectionSource(sources);
      return z.parse(schema, next);
    });
    if (state.total !== null && (!Number.isSafeInteger(state.total) || state.total < entries.length)) throw new Error('INVALID_COLLECTION_TOTAL');
    if (state.complete && state.total !== entries.length) throw new Error('INVALID_COLLECTION_COMPLETENESS');
    // 已知范围之外尚有未读工作区时，总量不能用当前明细数冒充全量。
    const total = !state.complete && state.total === entries.length ? null : state.total;
    return { status: state.complete ? 'complete' as const : 'partial' as const,
      total, omitted: total === null ? null : total - entries.length, entries };
  } catch {
    return { status: failureStatus, total: null, omitted: null, entries: [] };
  }
}

/** v2 的每个固定字段必须有真实读取器；新版本地字段不能改变已协商的旧版 wire。 */
export function projectSettingsSnapshotV2(
  input: ReadonlySettingsInspection, ids: SettingsPublicIdentifiers = NO_PUBLIC_SETTINGS_IDENTIFIERS,
): Pick<SettingsSnapshotReportV2, 'fields' | 'collections'> {
  const fields: Record<string, unknown> = {};
  for (const id of SETTINGS_SNAPSHOT_V2_FIELD_IDS) {
    const state = input.fields[id];
    if (!state) throw new Error('MISSING_SETTINGS_FIELD_READER');
    if (state.status !== 'value') { fields[id] = { status: state.status }; continue; }
    try {
      const value = z.parse(SETTINGS_READ_CATALOG[id].valueSchema, projectFieldValue(id, state.value, ids));
      fields[id] = { status: 'value', source: state.source, value };
    } catch { fields[id] = { status: 'unreadable' }; }
  }
  const collections = createSettingsSnapshotV2UnavailableCollections();
  for (const id of SETTINGS_READ_COLLECTION_IDS) {
    Object.assign(collections[id], projectCollection(id, input, ids));
  }
  return { fields: settingsSnapshotFieldsV2Schema.parse(fields),
    collections: boundSettingsSnapshotCollections(collections as SettingsSnapshotCollectionsV2) };
}
