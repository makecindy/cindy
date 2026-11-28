import { describe, expect, it } from 'vitest';
import { SETTINGS_READ_FIELD_IDS, SETTINGS_READ_COLLECTION_IDS } from '../../../shared/settingsReadCatalog.js';
import { settingsSnapshotReportV2Schema, SETTINGS_SNAPSHOT_V2_COMPATIBILITY_FIXTURE, SETTINGS_SNAPSHOT_V2_FIELD_IDS } from '../../../shared/settingsSnapshotV2.js';
import { encodeCatalogModelPin } from '../../../shared/catalogModelPin.js';
import { projectSettingsSnapshotV2 } from '../snapshotProjectionV2.js';
import { inspectedValue, type ReadonlySettingsInspection } from '../readTypes.js';

function input(): ReadonlySettingsInspection {
  return { fields: Object.fromEntries(SETTINGS_READ_FIELD_IDS.map(id => [id, { status: 'unsupported' } as const])),
    collections: Object.fromEntries(SETTINGS_READ_COLLECTION_IDS.map(id => [id, { status: 'unavailable' } as const])) };
}
const ids = { models: new Set(['public-model', 'vendor/public-model']), providers: new Set(['public-provider']) };
const value = (v: unknown) => inspectedValue(v, 'override');

describe('全字段公开投影', () => {
  it('每个固定叶子与动态类别都必须接读取器，不能以默认值掩盖遗漏', () => {
    const complete = input();
    expect(Object.keys(projectSettingsSnapshotV2(complete).fields)).toEqual([...SETTINGS_SNAPSHOT_V2_FIELD_IDS]);
    delete complete.fields['desktop.theme'];
    expect(() => projectSettingsSnapshotV2(complete)).toThrow('MISSING_SETTINGS_FIELD_READER');
    const missingCollection = input(); delete missingCollection.collections!.modelPrices;
    expect(() => projectSettingsSnapshotV2(missingCollection)).toThrow('MISSING_SETTINGS_COLLECTION_READER');
  });
  it('新版原生字段不改变旧版报告，仍保留兼容 Git 开关的真实值', () => {
    const raw = input();
    raw.fields['gitSafety.mode'] = value('existing-git');
    raw.fields['gitSafety.autoSnapshotEnabled'] = value(true);
    raw.fields['gitSafety.autoInitProjectGit'] = value(false);
    raw.fields['voice.composerLongPressEnabled'] = value(true);
    const out = projectSettingsSnapshotV2(raw);
    expect(out.fields['gitSafety.autoSnapshotEnabled']).toEqual({ status: 'value', source: 'override', value: true });
    for (const id of ['gitSafety.mode', 'gitSafety.autoInitProjectGit', 'voice.composerLongPressEnabled']) expect(Object.hasOwn(out.fields, id)).toBe(false);
    expect(settingsSnapshotReportV2Schema.safeParse({ ...SETTINGS_SNAPSHOT_V2_COMPATIBILITY_FIXTURE, ...out }).success).toBe(true);
  });
  it('只公开受信目录精确证明的ID，语法合法不等于公开', () => {
    const raw = input();
    raw.fields['newTaskDefaults.modelId'] = value('private-project-model');
    raw.fields['newTaskDefaults.providerId'] = value('public-provider');
    raw.fields['subagentModel.claudeCode'] = value('public-model');
    raw.fields['subagentModel.claudeCodeProviderId'] = value('https://private.example.invalid');
    raw.fields['im.global.agents.codex.model'] = value('vendor/public-model');
    const out = projectSettingsSnapshotV2(raw, ids);
    expect(out.fields['newTaskDefaults.modelId']).toEqual({ status: 'value', source: 'override', value: { configured: true } });
    expect(out.fields['newTaskDefaults.providerId']).toMatchObject({ value: { configured: true, publicId: 'public-provider' } });
    expect(out.fields['subagentModel.claudeCode']).toMatchObject({ value: { configured: true, publicId: 'public-model' } });
    expect(out.fields['subagentModel.claudeCodeProviderId']).toMatchObject({ value: { configured: true } });
    expect(out.fields['im.global.agents.codex.model']).toMatchObject({ value: { configured: true, publicId: 'vendor/public-model' } });
    expect(JSON.stringify(out)).not.toContain('private-project-model'); expect(JSON.stringify(out)).not.toContain('private.example.invalid');
  });
  it.each([null, ''])('空model引用%j明确未配置，不能变成推荐型号', model => {
    const raw = input(); raw.fields['newTaskDefaults.modelId'] = value(model);
    expect(projectSettingsSnapshotV2(raw, ids).fields['newTaskDefaults.modelId']).toMatchObject({ value: { configured: false } });
  });
  it('仅语法前缀相似、包含公共名或规范化后相似的引用不通过证明', () => {
    for (const model of ['public-model-more', ' public-model', 'public-model[1m]', 'PRIVATE/public-model']) {
      const raw = input(); raw.fields['newTaskDefaults.modelId'] = value(model);
      expect(projectSettingsSnapshotV2(raw, ids).fields['newTaskDefaults.modelId']).toMatchObject({ value: { configured: true } });
      expect(JSON.stringify(projectSettingsSnapshotV2(raw, ids))).not.toContain(model);
    }
  });
  it('有序辅助链、伙伴链与视觉桥逐路去敏，不上传配置副本', () => {
    const raw = input();
    raw.fields['auxiliaryModel.models'] = value([encodeCatalogModelPin({ agentKind: 'codex', providerId: 'public-provider', model: 'public-model' })]);
    raw.fields['voice.refinerChain'] = raw.fields['auxiliaryModel.models'];
    raw.fields['botModelChain.modelChain'] = value([{ harness: 'claude', model: 'private-model', providerId: 'private-provider', effort: '', fastMode: false, token: 'invalid-test-secret' }]);
    raw.fields['visionBridge.primary'] = value({ modelId: 'public-model', providerId: 'public-provider', path: '/private/test-path' });
    const out = projectSettingsSnapshotV2(raw, ids);
    expect(out.fields['auxiliaryModel.models']).toMatchObject({ value: [{ model: { publicId: 'public-model' }, provider: { publicId: 'public-provider' } }] });
    expect(out.fields['voice.refinerChain']).toEqual(out.fields['auxiliaryModel.models']);
    expect(out.fields['botModelChain.modelChain']).toMatchObject({ value: [{ harness: 'claude-code', model: { configured: true }, provider: { configured: true }, effort: null, fastMode: false }] });
    expect(out.fields['visionBridge.primary']).toMatchObject({ value: { model: { publicId: 'public-model' } } });
    expect(JSON.stringify(out)).not.toMatch(/invalid-test-secret|private-provider|private-model|private\/test-path/);
  });
  it('坏字段只使自身不可读，不覆盖真实false或正常领域', () => {
    const raw = input(); raw.fields['desktop.notificationsEnabled'] = value(false);
    raw.fields['appearance.uiFontSize'] = value(14.5);
    raw.fields['databaseWarning.thresholdGiB'] = value(0.1);
    raw.fields['desktop.agentIslandSoundSettings.sounds.start'] = value({ type: 'custom', configured: true, path: '/private/audio' });
    const out = projectSettingsSnapshotV2(raw);
    expect(out.fields['desktop.notificationsEnabled']).toEqual({ status: 'value', source: 'override', value: false });
    for (const id of ['appearance.uiFontSize', 'databaseWarning.thresholdGiB', 'desktop.agentIslandSoundSettings.sounds.start'] as const) expect(out.fields[id]).toEqual({ status: 'unreadable' });
    expect(JSON.stringify(out)).not.toContain('/private/audio');
  });
  it.each(['migrationPending', 'unreadable', 'unsupported', 'unavailable', 'private'] as const)('保留%s而不回默认', status => {
    const raw = input(); raw.fields['desktop.theme'] = { status };
    expect(projectSettingsSnapshotV2(raw).fields['desktop.theme']).toEqual({ status });
  });
  it('原始集合key不读取也不发送，保留顺序与省略数量', () => {
    const raw = input();
    const entries = Array.from({ length: 40 }, (_, index) => ({ key: `PRIVATE-${index}`, fields: { enabled: value(index % 2 === 0) } }));
    Object.defineProperty(entries[0], 'key', { get() { throw new Error('不得读取私密key'); } });
    raw.collections!.modelVisibility = { status: 'value', entries, total: 40, complete: true };
    const out = projectSettingsSnapshotV2(raw);
    expect(out.collections.modelVisibility).toMatchObject({ status: 'partial', total: 40, omitted: 8 });
    expect(out.collections.modelVisibility.entries).toHaveLength(32);
    expect(out.collections.modelVisibility.entries[0]).toEqual({ ordinal: 1, source: 'override', enabled: true });
    expect(JSON.stringify(out)).not.toContain('PRIVATE-');
  });
  it('未知工作区总量始终partial，不因当前列表为空标complete', () => {
    const raw = input(); raw.collections!.builtinToolOverrides = { status: 'value', entries: [], total: null, complete: false };
    expect(projectSettingsSnapshotV2(raw).collections.builtinToolOverrides).toEqual({ status: 'partial', entries: [], total: null, omitted: null });
  });
  it('集合私密状态和坏完整性各自失败关闭', () => {
    const raw = input();
    raw.collections!.modelFavorites = { status: 'value', total: 1, complete: true, entries: [{ key: 'private-id', fields: { agent: value('codex'), effort: { status: 'private' }, fast: value(false) } }] };
    raw.collections!.modelPrices = { status: 'value', total: 2, complete: true, entries: [] };
    const out = projectSettingsSnapshotV2(raw);
    expect(out.collections.modelFavorites.status).toBe('private'); expect(out.collections.modelPrices.status).toBe('unreadable');
  });
  it('最终结果严格兼容wire并完全不复制输入扩展字段', () => {
    const raw = input(); Object.assign(raw, { ownerId: 'PRIVATE', rawSettings: { token: 'PRIVATE' } });
    raw.fields['private.unsupported'] = value('PRIVATE');
    raw.collections!.privateCollection = { status: 'value', entries: [], total: 0, complete: true };
    const out = projectSettingsSnapshotV2(raw);
    expect(settingsSnapshotReportV2Schema.safeParse({ ...SETTINGS_SNAPSHOT_V2_COMPATIBILITY_FIXTURE, ...out }).success).toBe(true);
    expect(JSON.stringify(out)).not.toContain('PRIVATE'); expect(out.fields).not.toHaveProperty('private.unsupported');
  });
});
