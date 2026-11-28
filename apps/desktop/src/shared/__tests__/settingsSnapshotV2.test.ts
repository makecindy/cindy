import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { settingsSnapshotCompatibilityCorpus } from './settingsSnapshotCorpus.js';
import { SETTINGS_READ_CATALOG, SETTINGS_READ_COLLECTION_CATALOG, SETTINGS_READ_COLLECTION_IDS } from '../settingsReadCatalog.js';
import { SETTINGS_SNAPSHOT_V2_FIELD_IDS } from '../settingsSnapshotV2FieldIds.js';
import {
  SETTINGS_SNAPSHOT_COMPATIBILITY_FIXTURE, SETTINGS_SNAPSHOT_MAX_BYTES, settingsSnapshotReportSchema, settingsSnapshotAnyReportSchema,
  SETTINGS_SNAPSHOT_V2_COMPATIBILITY_FIXTURE, SETTINGS_SNAPSHOT_CAPABILITIES, settingsSnapshotCapabilitiesSchema,
  settingsSnapshotReportV2Schema, settingsSnapshotFieldsV2Schema, settingsSnapshotCollectionsV2Schema,
  SETTINGS_SNAPSHOT_V2_MAX_BYTES, SETTINGS_SNAPSHOT_V2_FIXED_MAX_BYTES, SETTINGS_SNAPSHOT_V2_COLLECTIONS_MAX_BYTES,
  SETTINGS_SNAPSHOT_V2_ENVELOPE_MAX_BYTES, SETTINGS_SNAPSHOT_COLLECTION_MAX_BYTES, SETTINGS_SNAPSHOT_COLLECTION_MAX_ITEMS,
  settingsSnapshotMaxBytesForVersion, settingsSnapshotUtf8Bytes, validateSettingsSnapshotBudget,
  boundSettingsSnapshotCollections, createSettingsSnapshotV2UnavailableFields, createSettingsSnapshotV2UnavailableCollections,
  projectSettingsSnapshotPublicReference, type SettingsSnapshotReportV2, type SettingsSnapshotCollectionsV2,
} from '../settingsSnapshot.js';

/** The two members maximal() reads, present on Zod 3 and Zod 4 schemas alike. */
interface MaximalSchema { _def: unknown; safeParse(value: unknown): { success: boolean } }
/** 只在测试内遍历纯 schema，兼容两仓各自的 Zod 3/4；不是生产逃生口。 */
function maximal(schema: MaximalSchema): unknown {
  const def = schema._def as { typeName?: string; type?: string | MaximalSchema; innerType?: MaximalSchema;
    schema?: MaximalSchema; checks?: Array<{ kind?: string; value?: number; _zod?: { def: { check?: string; value?: number; maximum?: number } } }>;
    values?: unknown[]; entries?: Record<string, string>; value?: unknown; options?: MaximalSchema[];
    maxLength?: { value: number }; shape?: Record<string, MaximalSchema> | (() => Record<string, MaximalSchema>); element?: MaximalSchema };
  const kind = def.typeName?.replace('Zod', '').toLowerCase() ?? def.type;
  if (kind === 'effects') return maximal(def.schema!);
  if (kind === 'optional' || kind === 'nullable') return maximal(def.innerType!);
  if (kind === 'boolean') return false;
  if (kind === 'null') return null;
  if (kind === 'literal') return def.value ?? def.values?.[0];
  if (kind === 'enum') return [...(def.values ?? Object.values(def.entries!))].sort((a, b) => String(b).length - String(a).length)[0];
  if (kind === 'string') return 'm'.repeat(96);
  if (kind === 'number') {
    const candidates = [Number.MAX_SAFE_INTEGER, 999_999_999.9999999, 999_999.9999999999, 99.99999999999999, 1.0000000000000002, 0.5000000000000001,
      ...((def.checks ?? []).flatMap(check => check.value === undefined ? check._zod?.def.value === undefined ? [] : [check._zod.def.value] : [check.value])),
      1024, 100, 95, 64, 24, 20, 3, 1, 0];
    return candidates.filter(value => schema.safeParse(value).success).sort((a, b) => String(b).length - String(a).length)[0];
  }
  if (kind === 'array') {
    const max = def.maxLength?.value ?? def.checks?.find(check => check._zod?.def.check === 'max_length')?._zod?.def.maximum;
    if (max === undefined) throw new Error('MAXIMAL_ARRAY_REQUIRES_EXPLICIT_MAX');
    return Array.from({ length: max }, () => maximal(def.element ?? def.type as MaximalSchema));
  }
  if (kind === 'union' || kind === 'discriminatedunion') return def.options!.map(maximal).filter(value => schema.safeParse(value).success)
    .sort((a, b) => settingsSnapshotUtf8Bytes(b) - settingsSnapshotUtf8Bytes(a))[0];
  if (kind === 'object') {
    const shape = typeof def.shape === 'function' ? def.shape() : def.shape!;
    return Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, maximal(value)]));
  }
  throw new Error(`UNHANDLED_MAXIMAL_SCHEMA_${String(kind)}`);
}
function maxReport(): SettingsSnapshotReportV2 {
  const fields = Object.fromEntries(SETTINGS_SNAPSHOT_V2_FIELD_IDS.map(id => [id, { status: 'value', source: 'override', value: maximal(SETTINGS_READ_CATALOG[id].valueSchema) }]));
  const candidates = Object.fromEntries(SETTINGS_READ_COLLECTION_IDS.map(id => [id, { status: 'complete', total: 32, omitted: 0,
    entries: Array.from({ length: 32 }, (_, i) => ({ ...maximal(SETTINGS_READ_COLLECTION_CATALOG[id].entrySchema) as object, ordinal: i + 1 })) }])) as SettingsSnapshotCollectionsV2;
  return settingsSnapshotReportV2Schema.parse({ ...SETTINGS_SNAPSHOT_V2_COMPATIBILITY_FIXTURE,
    baseRevision: Number.MAX_SAFE_INTEGER, capturedAtMs: Number.MAX_SAFE_INTEGER, fields,
    collections: boundSettingsSnapshotCollections(candidates) });
}

function sample() { return structuredClone(SETTINGS_SNAPSHOT_V2_COMPATIBILITY_FIXTURE); }

const corpus = settingsSnapshotCompatibilityCorpus();
const corpusDigest = createHash('sha256').update(JSON.stringify(corpus)).digest('hex');
const maximumBudget = validateSettingsSnapshotBudget(maxReport());
describe(`same-value corpus sha256 ${corpusDigest}`, () => {
  it('pins the exact corpus values in both repositories', () => {
    expect(corpusDigest).toBe('7efb2c76d633a32d3171e980a3253477146fed9a550918c25f9b654c687b3d07');
  });
  it.each(corpus)('$name', test => {
    const parsed = settingsSnapshotAnyReportSchema.safeParse(test.input);
    expect(parsed.success && validateSettingsSnapshotBudget(parsed.data, test.rawBytes).ok).toBe(test.valid);
    if (test.valid && parsed.success) expect(parsed.data).toEqual(test.input);
  });
});
it(`maximum report: ${SETTINGS_SNAPSHOT_V2_FIELD_IDS.length} fixed leaves / ${maximumBudget.fixedBytes} fixed bytes / ${maximumBudget.collectionsBytes} dynamic bytes / ${maximumBudget.bytes} total bytes`, () => {
  expect(maximumBudget.ok).toBe(true);
});

describe('settings snapshot v2 strict wire', () => {
  it.each(['gitSafety.mode', 'gitSafety.autoInitProjectGit', 'voice.composerLongPressEnabled'] as const)('keeps native-only addition %s outside the negotiated v2 wire', id => {
    expect(SETTINGS_READ_CATALOG[id]).toBeDefined();
    expect(Object.keys(sample().fields)).toHaveLength(453);
    expect(Object.hasOwn(sample().fields, id)).toBe(false);
    expect(settingsSnapshotFieldsV2Schema.safeParse({ ...sample().fields, [id]: { status: 'unsupported' } }).success).toBe(false);
  });
  it('keeps v1 fixture, ranges and 8 KiB contract intact', () => {
    expect(SETTINGS_SNAPSHOT_MAX_BYTES).toBe(8192);
    expect(settingsSnapshotReportSchema.parse(SETTINGS_SNAPSHOT_COMPATIBILITY_FIXTURE)).toEqual(SETTINGS_SNAPSHOT_COMPATIBILITY_FIXTURE);
    const legacy = structuredClone(SETTINGS_SNAPSHOT_COMPATIBILITY_FIXTURE);
    if (legacy.domains.databaseWarning.status === 'supported') legacy.domains.databaseWarning.fields.thresholdGiB.value = 0.1;
    if (legacy.domains.appearance.status === 'supported') legacy.domains.appearance.fields.uiFontSize.value = 8.5;
    expect(settingsSnapshotReportSchema.safeParse(legacy).success).toBe(true);
    expect(settingsSnapshotReportSchema.safeParse(sample()).success).toBe(false);
    expect(validateSettingsSnapshotBudget(legacy, 8192).ok).toBe(true);
    expect(validateSettingsSnapshotBudget(legacy, 8193).violations).toContain('raw');
  });
  it('parses complete v2 fixture and exact capabilities; rejects mixed or guessed negotiation', () => {
    expect(settingsSnapshotAnyReportSchema.parse(sample())).toEqual(sample());
    expect(settingsSnapshotCapabilitiesSchema.parse(SETTINGS_SNAPSHOT_CAPABILITIES)).toEqual(SETTINGS_SNAPSHOT_CAPABILITIES);
    expect(settingsSnapshotCapabilitiesSchema.safeParse({ schemaVersion: 1, supportedVersions: [1], limits: { v1: { maxBytes: 8192 } } }).success).toBe(true);
    for (const wrong of [[2], [1, 1], [1, 2, 3]]) expect(settingsSnapshotCapabilitiesSchema.safeParse({ ...SETTINGS_SNAPSHOT_CAPABILITIES, supportedVersions: wrong }).success).toBe(false);
    expect(settingsSnapshotCapabilitiesSchema.safeParse({ ...SETTINGS_SNAPSHOT_CAPABILITIES, limits: { ...SETTINGS_SNAPSHOT_CAPABILITIES.limits, v1: { maxBytes: 131072 } } }).success).toBe(false);
  });
  it('rejects missing or unknown fixed leaves and metadata at every boundary', () => {
    const report = sample();
    delete (report.fields as Partial<typeof report.fields>)['memory.pi'];
    expect(settingsSnapshotReportV2Schema.safeParse(report).success).toBe(false);
    expect(settingsSnapshotReportV2Schema.safeParse({ ...sample(), label: 'not wire' }).success).toBe(false);
    expect(settingsSnapshotFieldsV2Schema.safeParse({ ...sample().fields, rogue: { status: 'private' } }).success).toBe(false);
    expect(settingsSnapshotFieldsV2Schema.safeParse({ ...sample().fields, 'memory.pi': { status: 'private', value: 'secret' } }).success).toBe(false);
    expect(settingsSnapshotFieldsV2Schema.safeParse({ ...sample().fields, 'memory.pi': { status: 'value', value: true, source: 'inferred' } }).success).toBe(false);
    expect(settingsSnapshotCollectionsV2Schema.safeParse({ ...sample().collections, arbitrary: { status: 'unavailable', total: null, omitted: null, entries: [] } }).success).toBe(false);
  });
  it('requires actual public membership evidence, not a matching identifier regex', () => {
    expect(projectSettingsSnapshotPublicReference('plausible-custom-model', new Set())).toEqual({ configured: true });
    expect(projectSettingsSnapshotPublicReference('public-model', new Set(['public-model']))).toEqual({ configured: true, publicId: 'public-model' });
    expect(projectSettingsSnapshotPublicReference('https://private.example', new Set(['https://private.example']))).toEqual({ configured: true });
    expect(projectSettingsSnapshotPublicReference('sk-invalid-fixture', new Set(['sk-invalid-fixture']))).toEqual({ configured: true });
    expect(projectSettingsSnapshotPublicReference(null, new Set())).toEqual({ configured: false });
  });
  it.each([
    ['databaseWarning.thresholdGiB', 0.1], ['appearance.uiFontSize', 13.5], ['appearance.codeFontSize', 9],
    ['appearance.zoomFactor', 3.1], ['compaction.piAutoCompactPct', 96], ['memory.pi', 'true'],
    ['newTaskDefaults.modelId', 'plausible-custom-model'], ['personalization.customized', 'prompt text'],
    ['desktop.themeFamilyIdConfigured', 'private theme'], ['shortcuts.open-settings', [{ code: 'free text', meta: true, ctrl: false, alt: false, shift: false }]],
  ])('rejects field-specific invalid values for %s', (id, value) => {
    expect(settingsSnapshotFieldsV2Schema.safeParse({ ...sample().fields, [id]: { status: 'value', value, source: 'override' } }).success).toBe(false);
  });
  it('does not expose paths, prompts, font names, custom action ids or arbitrary entry keys', () => {
    for (const [id, value] of [
      ['appearance.uiFontCustomized', 'Personal Font'], ['voice.refinementInstructionsConfigured', 'private prompt'],
      ['worklouder.codex-micro.layout.slots.ACT06.action', { type: 'command', commandId: 'arbitrary' }],
      ['worklouder.codex-micro.layout.slots.ACT06.action', { type: 'task', configured: true, sessionId: 'private' }],
      ['desktop.agentIslandSoundSettings.sounds.start', { type: 'custom', configured: true, path: '/private/sound' }],
    ]) expect(settingsSnapshotFieldsV2Schema.safeParse({ ...sample().fields, [id as string]: { status: 'value', value, source: 'override' } }).success).toBe(false);
  });
});

describe('settings snapshot v2 byte budgets and completeness', () => {
  it('measures UTF-8 rather than UTF-16 length and keeps exact version budgets', () => {
    expect(settingsSnapshotUtf8Bytes('中')).toBe(5);
    expect(settingsSnapshotUtf8Bytes('😀')).toBe(6);
    expect(settingsSnapshotMaxBytesForVersion(1)).toBe(8192);
    expect(settingsSnapshotMaxBytesForVersion(2)).toBe(131072);
    expect(() => settingsSnapshotMaxBytesForVersion(3 as 2)).toThrow();
    expect(validateSettingsSnapshotBudget(sample(), 131072).ok).toBe(true);
    expect(validateSettingsSnapshotBudget(sample(), 131073).violations).toContain('raw');
  });
  it('fits the complete maximum-shape report without dropping a fixed leaf', () => {
    const report = maxReport();
    const budget = validateSettingsSnapshotBudget(report);
    expect(budget.ok).toBe(true);
    expect(Object.keys(report.fields).sort()).toEqual([...SETTINGS_SNAPSHOT_V2_FIELD_IDS].sort());
    expect(Object.values(report.fields).every(field => field.status === 'value')).toBe(true);
    expect(budget.fixedBytes).toBeLessThanOrEqual(SETTINGS_SNAPSHOT_V2_FIXED_MAX_BYTES);
    // 每个数字最多再预留 32 bytes；浮点十进制长度变化不能破坏固定预算证明。
    const numericMargin = JSON.stringify(report.fields).match(/: ?-?\d/g)?.length ?? 0;
    expect(budget.fixedBytes + numericMargin * 32).toBeLessThanOrEqual(SETTINGS_SNAPSHOT_V2_FIXED_MAX_BYTES);
    expect(budget.collectionsBytes).toBeLessThanOrEqual(SETTINGS_SNAPSHOT_V2_COLLECTIONS_MAX_BYTES);
    expect(budget.envelopeBytes).toBeLessThanOrEqual(SETTINGS_SNAPSHOT_V2_ENVELOPE_MAX_BYTES);
    expect(budget.bytes).toBeLessThanOrEqual(SETTINGS_SNAPSHOT_V2_MAX_BYTES);
    for (const collection of Object.values(report.collections)) {
      expect(collection.entries.length).toBeLessThanOrEqual(32);
      expect(settingsSnapshotUtf8Bytes(collection)).toBeLessThanOrEqual(4096);
      expect(collection.total).toBe(32);
      expect(collection.omitted).toBe(32 - collection.entries.length);
      expect(collection.status).toBe(collection.omitted ? 'partial' : 'complete');
    }
    // 摘要和预算是确定性的；日志不打印设置值。
    expect(createHash('sha256').update(JSON.stringify(maxReport())).digest('hex')).toBe(createHash('sha256').update(JSON.stringify(report)).digest('hex'));
  });
  it('preserves every summary and deterministically bounds large dynamic lists', () => {
    const original = createSettingsSnapshotV2UnavailableCollections();
    original.modelVisibility = { status: 'complete', total: 200, omitted: 0, entries: Array.from({ length: 200 }, (_, i) => ({ ordinal: i + 1, source: 'override', enabled: true })) };
    const result = boundSettingsSnapshotCollections(original);
    expect(result.modelVisibility.entries).toHaveLength(SETTINGS_SNAPSHOT_COLLECTION_MAX_ITEMS);
    expect(result.modelVisibility).toMatchObject({ status: 'partial', total: 200, omitted: 168 });
    expect(settingsSnapshotUtf8Bytes(result.modelVisibility)).toBeLessThanOrEqual(SETTINGS_SNAPSHOT_COLLECTION_MAX_BYTES);
    expect(Object.keys(result)).toEqual(SETTINGS_READ_COLLECTION_IDS);
    expect(boundSettingsSnapshotCollections(original)).toEqual(result);
    expect(original.modelVisibility.entries).toHaveLength(200);
  });
  it('keeps unknown totals unknown, rejects falsely complete, duplicate, or private detail rows', () => {
    const collections = createSettingsSnapshotV2UnavailableCollections();
    collections.modelVisibility = { status: 'partial', total: null, omitted: null, entries: [{ ordinal: 1, source: 'unknown', enabled: true }] };
    expect(settingsSnapshotCollectionsV2Schema.safeParse(collections).success).toBe(true);
    expect(boundSettingsSnapshotCollections(collections).modelVisibility).toEqual(collections.modelVisibility);
    for (const patch of [
      { status: 'complete' }, { total: 5, omitted: 0 }, { total: 0, omitted: 0 },
      { entries: [collections.modelVisibility.entries[0], collections.modelVisibility.entries[0]] },
      { entries: [{ ...collections.modelVisibility.entries[0], modelId: 'private' }] },
    ]) expect(settingsSnapshotCollectionsV2Schema.safeParse({ ...collections, modelVisibility: { ...collections.modelVisibility, ...patch } }).success).toBe(false);
  });
  it('enforces each 4 KiB collection and the independent 24 KiB dynamic total', () => {
    const all = createSettingsSnapshotV2UnavailableCollections();
    for (const id of SETTINGS_READ_COLLECTION_IDS) {
      const single = createSettingsSnapshotV2UnavailableCollections();
      Object.assign(single[id], { status: 'complete', total: 32, omitted: 0,
        entries: Array.from({ length: 32 }, (_, i) => ({ ...maximal(SETTINGS_READ_COLLECTION_CATALOG[id].entrySchema) as object, ordinal: i + 1 })) });
      Object.assign(all[id], boundSettingsSnapshotCollections(single)[id]);
    }
    expect(Object.values(all).every(collection => settingsSnapshotUtf8Bytes(collection) <= 4096)).toBe(true);
    const oversized = { ...sample(), collections: all };
    expect(validateSettingsSnapshotBudget(oversized).violations).toContain('collections');
    expect(settingsSnapshotReportV2Schema.safeParse(oversized).success).toBe(false);
    const prices = Array.from({ length: 32 }, (_, i) => ({ ...maximal(SETTINGS_READ_COLLECTION_CATALOG.modelPrices.entrySchema) as object, ordinal: i + 1 }));
    expect(settingsSnapshotCollectionsV2Schema.safeParse({ ...sample().collections, modelPrices: { status: 'complete', total: 32, omitted: 0, entries: prices } }).success).toBe(false);
  });
  it('does not repair a dishonest completeness summary or invalid tail during allocation', () => {
    const collections = createSettingsSnapshotV2UnavailableCollections();
    collections.modelVisibility = { status: 'partial', total: 1, omitted: 0, entries: [{ ordinal: 1, source: 'override', enabled: true }] };
    expect(() => boundSettingsSnapshotCollections(collections)).toThrow('INVALID_COLLECTION_TOTAL');
    collections.modelVisibility = { status: 'complete', total: 33, omitted: 0, entries: Array.from({ length: 33 }, (_, i) => ({ ordinal: i + 1, source: 'override', enabled: true })) };
    collections.modelVisibility.entries[32]!.ordinal = 1;
    expect(() => boundSettingsSnapshotCollections(collections)).toThrow('INVALID_COLLECTION_ORDINAL');
  });
  it('never serializes catalog metadata in a report', () => {
    const report = maxReport();
    for (const privateKey of ['valueSchema', 'sourcePath', 'control', 'reader', 'labelKey', 'platforms']) expect(JSON.stringify(report)).not.toContain(`"${privateKey}"`);
    expect(Object.keys(createSettingsSnapshotV2UnavailableFields())).toHaveLength(SETTINGS_SNAPSHOT_V2_FIELD_IDS.length);
  });
});
