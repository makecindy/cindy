import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion.js';
import type { ReadonlySettingsInspection } from '../readTypes.js';

const mocks = vi.hoisted(() => ({
  context: vi.fn(), assert: vi.fn(), preferences: vi.fn(), core: vi.fn(), interaction: vi.fn(),
  collections: vi.fn(), publicIds: vi.fn(), project: vi.fn(), workspaces: vi.fn(),
}));
vi.mock('../readContext.js', () => ({ getSettingsReadContext: mocks.context, assertSettingsReadContext: mocks.assert }));
vi.mock('../readers/preferences.js', () => ({ inspectPreferenceSettingsForSnapshot: mocks.preferences }));
vi.mock('../readers/coreRuntime.js', () => ({ inspectCoreSettingsForSnapshot: mocks.core }));
vi.mock('../readers/interaction.js', () => ({ inspectInteractionSettings: mocks.interaction }));
vi.mock('../readers/collections.js', () => ({ inspectDynamicSettingsCollections: mocks.collections }));
vi.mock('../publicIdentifiers.js', () => ({ getSettingsPublicIdentifiers: mocks.publicIds }));
vi.mock('../snapshotProjectionV2.js', () => ({ projectSettingsSnapshotV2: mocks.project }));
vi.mock('../readKnownWorkspaces.js', () => ({ readKnownWorkspaces: mocks.workspaces }));
import { collectSettingsInspection, readSettingsSnapshotV2 } from '../readSnapshot.js';

function context() {
  const root = path.join(os.tmpdir(), 'nonexistent-settings-context-fixture');
  return { mode: 'cloud' as const, dataOwnerId: 'fixture-owner', generation: 9,
    ownerRoot: path.join(root, 'owners', 'fixture-owner'), userDataPath: root,
    isAuthenticated: true, membershipKind: 'org' as const, platform: 'linux' as const, arch: 'x64' as const };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockReturnValue(context());
  mocks.preferences.mockReturnValue({ fields: { preference: { status: 'private' } } });
  mocks.core.mockReturnValue({ fields: { core: { status: 'unsupported' } }, collections: { coreCollection: { status: 'unavailable' } } });
  mocks.interaction.mockReturnValue({ fields: { interaction: { status: 'unreadable' } } });
  mocks.collections.mockReturnValue({ fields: {}, collections: { dynamic: { status: 'migrationPending' } } });
  mocks.workspaces.mockReturnValue({ knownWorkspaces: [path.join(os.tmpdir(), 'fixture-workspace')], knownWorkspacesComplete: false });
  mocks.publicIds.mockReturnValue({ models: new Set(), providers: new Set() });
  mocks.project.mockReturnValue({ fields: {}, collections: {} });
});

describe('生产全量采样接线与身份边界', () => {
  it('只将同次真实读取结果传给公开投影，内部身份不混进报告', () => {
    const result = readSettingsSnapshotV2();
    const captured = mocks.context.mock.results[0]!.value;
    expect(mocks.preferences).toHaveBeenCalledWith('linux');
    expect(mocks.interaction).toHaveBeenCalledWith({ ...captured, ownerId: 'fixture-owner',
      officialAccountFingerprint: createHash('sha256').update(`${CURRENT_CINDY_REGION}\0fixture-owner`).digest('base64url').slice(0, 22) });
    expect(mocks.collections).toHaveBeenCalledWith({ ownerRoot: captured.ownerRoot, ownerId: 'fixture-owner',
      ownerGeneration: 9, mode: 'cloud', ...mocks.workspaces.mock.results[0]!.value });
    expect(mocks.project).toHaveBeenCalledWith({
      fields: { preference: { status: 'private' }, core: { status: 'unsupported' }, interaction: { status: 'unreadable' } },
      collections: { coreCollection: { status: 'unavailable' }, dynamic: { status: 'migrationPending' } },
    }, mocks.publicIds.mock.results[0]!.value);
    expect(result).toBe(mocks.project.mock.results[0]!.value);
    expect(mocks.assert.mock.calls.length).toBeGreaterThanOrEqual(9);
    for (const [value] of mocks.assert.mock.calls) expect(value).toBe(captured);
    expect(JSON.stringify(result)).not.toContain('fixture-owner');
  });
  it.each([null, { ...context(), mode: 'signed-out' }])('无稳定归属时不读取任何设置', captured => {
    mocks.context.mockReturnValue(captured);
    expect(() => readSettingsSnapshotV2()).toThrow('SETTINGS_OWNER_CHANGED');
    for (const reader of [mocks.preferences, mocks.core, mocks.interaction, mocks.collections, mocks.workspaces, mocks.project]) {
      expect(reader).not.toHaveBeenCalled();
    }
  });
  it('非认证本机模式不构造官方渠道分区身份', () => {
    mocks.context.mockReturnValue({ ...context(), mode: 'local', isAuthenticated: false });
    readSettingsSnapshotV2();
    expect(mocks.interaction).toHaveBeenCalledWith(expect.objectContaining({ mode: 'local', officialAccountFingerprint: null }));
  });
  it('采样中归属变化立即丢弃，不继续拼接下一领域', () => {
    mocks.preferences.mockImplementation(() => {
      mocks.assert.mockImplementation(() => { throw new Error('SETTINGS_OWNER_CHANGED'); });
      return { fields: { preference: { status: 'private' } } };
    });
    expect(() => readSettingsSnapshotV2()).toThrow('SETTINGS_OWNER_CHANGED');
    expect(mocks.core).not.toHaveBeenCalled(); expect(mocks.project).not.toHaveBeenCalled();
  });
  it('最终投影后再变身份也不能返回旧结果', () => {
    mocks.project.mockImplementation(() => {
      mocks.assert.mockImplementation(() => { throw new Error('SETTINGS_OWNER_CHANGED'); });
      return { fields: {}, collections: {} };
    });
    expect(() => readSettingsSnapshotV2()).toThrow('SETTINGS_OWNER_CHANGED');
  });
  it('重复固定字段与集合的接线均失败，不能后写覆盖', () => {
    const a: ReadonlySettingsInspection = { fields: { same: { status: 'private' } } };
    expect(() => collectSettingsInspection([() => a, () => a], () => {})).toThrow('DUPLICATE_SETTINGS_FIELD_READER');
    const b: ReadonlySettingsInspection = { fields: {}, collections: { same: { status: 'unavailable' } } };
    expect(() => collectSettingsInspection([() => b, () => b], () => {})).toThrow('DUPLICATE_SETTINGS_COLLECTION_READER');
  });
});
