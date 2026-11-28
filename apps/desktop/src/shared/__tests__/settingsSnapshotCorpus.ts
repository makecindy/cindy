import { SETTINGS_SNAPSHOT_COMPATIBILITY_FIXTURE, SETTINGS_SNAPSHOT_V2_COMPATIBILITY_FIXTURE } from '../settingsSnapshot.js';

/** 两仓逐值相同的边界 corpus；不引用另一仓实现，不从待测 schema 生成合法答案。 */
export interface SettingsSnapshotCorpusCase { name: string; input: unknown; valid: boolean; rawBytes?: number }
const clone = <T>(value: T): T => structuredClone(value);
const v2 = () => clone(SETTINGS_SNAPSHOT_V2_COMPATIBILITY_FIXTURE);
const value = (raw: unknown, source = 'override') => ({ status: 'value', value: raw, source });
const field = (id: string, raw: unknown) => ({ ...v2(), fields: { ...v2().fields, [id]: raw } });
const entry = { ordinal: 1, source: 'override', enabled: true };
const collection = (raw: unknown) => ({ ...v2(), collections: { ...v2().collections, modelVisibility: raw } });

export function settingsSnapshotCompatibilityCorpus(): SettingsSnapshotCorpusCase[] {
  const missing = v2();
  delete (missing.fields as Partial<typeof missing.fields>)['memory.pi'];
  const legacyRange = clone(SETTINGS_SNAPSHOT_COMPATIBILITY_FIXTURE);
  if (legacyRange.domains.databaseWarning.status === 'supported') legacyRange.domains.databaseWarning.fields.thresholdGiB.value = 0.1;
  if (legacyRange.domains.appearance.status === 'supported') legacyRange.domains.appearance.fields.uiFontSize.value = 8.5;
  return [
    { name: 'v1-four-domains', input: clone(SETTINGS_SNAPSHOT_COMPATIBILITY_FIXTURE), valid: true },
    { name: 'v1-legacy-ranges', input: legacyRange, valid: true },
    { name: 'v1-original-body-8192', input: legacyRange, valid: true, rawBytes: 8192 },
    { name: 'v1-original-body-8193', input: legacyRange, valid: false, rawBytes: 8193 },
    { name: 'v1-reject-v2-fields', input: { ...legacyRange, fields: {} }, valid: false },
    { name: 'v2-all-leaves', input: v2(), valid: true },
    { name: 'v2-original-body-131072', input: v2(), valid: true, rawBytes: 131072 },
    { name: 'v2-original-body-131073', input: v2(), valid: false, rawBytes: 131073 },
    { name: 'unknown-version', input: { ...v2(), schemaVersion: 3 }, valid: false },
    { name: 'fractional-capture', input: { ...v2(), capturedAtMs: 0.1 }, valid: false },
    { name: 'unsafe-revision', input: { ...v2(), baseRevision: Number.MAX_SAFE_INTEGER + 1 }, valid: false },
    { name: 'metadata-not-wire', input: { ...v2(), catalog: {} }, valid: false },
    { name: 'fixed-leaf-missing', input: missing, valid: false },
    { name: 'fixed-leaf-unknown', input: field('unknown.privateText', value('private')), valid: false },
    ...(['default', 'override', 'unknown'] as const).map(source => ({ name: `source-${source}`, input: field('memory.pi', value(true, source)), valid: true })),
    ...(['unavailable', 'unreadable', 'unsupported', 'migrationPending', 'private'] as const).map(status => ({ name: `status-${status}`, input: field('memory.pi', { status }), valid: true })),
    { name: 'status-must-not-have-value', input: field('memory.pi', { status: 'unreadable', value: true }), valid: false },
    { name: 'v2-threshold-min', input: field('databaseWarning.thresholdGiB', value(1)), valid: true },
    { name: 'v2-threshold-legacy-min-rejected', input: field('databaseWarning.thresholdGiB', value(0.1)), valid: false },
    { name: 'v2-ui-integer-min', input: field('appearance.uiFontSize', value(12)), valid: true },
    { name: 'v2-ui-fraction-rejected', input: field('appearance.uiFontSize', value(14.5)), valid: false },
    { name: 'v2-code-below-min-rejected', input: field('appearance.codeFontSize', value(9)), valid: false },
    { name: 'configured-projection', input: field('voice.microphoneDeviceIdConfigured', value(true)), valid: true },
    { name: 'device-id-not-wire', input: field('voice.microphoneDeviceIdConfigured', value('device-id-example')), valid: false },
    { name: 'font-name-not-wire', input: field('appearance.uiFontCustomized', value('Private Font')), valid: false },
    { name: 'prompt-not-wire', input: field('personalization.customized', value('private prompt')), valid: false },
    { name: 'public-reference-after-projection', input: field('newTaskDefaults.modelId', value({ configured: true, publicId: 'catalog/model-example' })), valid: true },
    { name: 'private-reference-state-only', input: field('newTaskDefaults.modelId', value({ configured: true })), valid: true },
    { name: 'absent-reference-state-only', input: field('newTaskDefaults.modelId', value({ configured: false })), valid: true },
    { name: 'false-configured-with-id', input: field('newTaskDefaults.modelId', value({ configured: false, publicId: 'model-example' })), valid: false },
    { name: 'secret-looking-public-id', input: field('newTaskDefaults.modelId', value({ configured: true, publicId: 'sk-invalid-fixture' })), valid: false },
    { name: 'url-public-id', input: field('newTaskDefaults.modelId', value({ configured: true, publicId: 'https://invalid.example' })), valid: false },
    { name: 'raw-model-reference', input: field('newTaskDefaults.modelId', value('model-example')), valid: false },
    { name: 'non-ascii-id-rejected', input: field('newTaskDefaults.modelId', value({ configured: true, publicId: '私密型号' })), valid: false },
    { name: 'custom-sound-state-only', input: field('desktop.agentIslandSoundSettings.sounds.start', value({ type: 'custom', configured: true })), valid: true },
    { name: 'custom-sound-path-rejected', input: field('desktop.agentIslandSoundSettings.sounds.start', value({ type: 'custom', configured: true, path: '/private/fixture.wav' })), valid: false },
    { name: 'safe-chord', input: field('shortcuts.open-settings', value([{ code: 'Comma', meta: true, ctrl: false, alt: false, shift: false }])), valid: true },
    { name: 'free-key-text-rejected', input: field('shortcuts.open-settings', value([{ code: 'private text', meta: true, ctrl: false, alt: false, shift: false }])), valid: false },
    { name: 'key-display-fallback-rejected', input: field('shortcuts.open-settings', value([{ code: 'Comma', key: ',', meta: true, ctrl: false, alt: false, shift: false }])), valid: false },
    { name: 'complete-known-collection', input: collection({ status: 'complete', total: 1, omitted: 0, entries: [entry] }), valid: true },
    { name: 'partial-known-collection', input: collection({ status: 'partial', total: 5, omitted: 4, entries: [entry] }), valid: true },
    { name: 'partial-unknown-collection', input: collection({ status: 'partial', total: null, omitted: null, entries: [entry] }), valid: true },
    { name: 'fake-complete-collection', input: collection({ status: 'complete', total: 5, omitted: 4, entries: [entry] }), valid: false },
    { name: 'unknown-not-complete', input: collection({ status: 'complete', total: null, omitted: null, entries: [] }), valid: false },
    { name: 'omitted-count-mismatch', input: collection({ status: 'partial', total: 5, omitted: 0, entries: [entry] }), valid: false },
    { name: 'private-entry-key-rejected', input: collection({ status: 'complete', total: 1, omitted: 0, entries: [{ ...entry, key: 'private-model' }] }), valid: false },
    { name: 'duplicate-ordinal-rejected', input: collection({ status: 'complete', total: 2, omitted: 0, entries: [entry, entry] }), valid: false },
    { name: 'entries-over-32', input: collection({ status: 'complete', total: 33, omitted: 0, entries: Array.from({ length: 33 }, (_, i) => ({ ...entry, ordinal: i + 1 })) }), valid: false },
  ];
}
