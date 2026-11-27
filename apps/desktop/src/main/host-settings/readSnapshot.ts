import { createHash } from 'node:crypto';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { getSettingsReadContext, assertSettingsReadContext } from './readContext.js';
import { inspectCoreSettingsForSnapshot } from './readers/coreRuntime.js';
import { inspectPreferenceSettingsForSnapshot } from './readers/preferences.js';
import { inspectInteractionSettings } from './readers/interaction.js';
import { inspectDynamicSettingsCollections } from './readers/collections.js';
import { getSettingsPublicIdentifiers } from './publicIdentifiers.js';
import { readKnownWorkspaces } from './readKnownWorkspaces.js';
import { projectSettingsSnapshotV2 } from './snapshotProjectionV2.js';
import type { ReadonlySettingsInspection } from './readTypes.js';

/** 领域失败由各读取器隔离；缺失/重复接线则阻断报告，不能用默认值补齐。 */
export function collectSettingsInspection(readers: readonly (() => ReadonlySettingsInspection)[], assertCurrent: () => void): ReadonlySettingsInspection {
  const combined: ReadonlySettingsInspection = { fields: {}, collections: {} };
  for (const read of readers) {
    assertCurrent();
    const part = read();
    assertCurrent();
    for (const [id, value] of Object.entries(part.fields)) {
      if (Object.hasOwn(combined.fields, id)) throw new Error('DUPLICATE_SETTINGS_FIELD_READER');
      combined.fields[id] = value;
    }
    for (const [id, value] of Object.entries(part.collections ?? {})) {
      if (Object.hasOwn(combined.collections!, id)) throw new Error('DUPLICATE_SETTINGS_COLLECTION_READER');
      combined.collections![id] = value;
    }
  }
  assertCurrent();
  return combined;
}

/** 一次完整读取后才构造公开报告；任何身份/profile变化都会使整次采样作废。 */
export function readSettingsSnapshotV2() {
  const context = getSettingsReadContext();
  if (!context || context.mode === 'signed-out') throw new Error('SETTINGS_OWNER_CHANGED');
  const assertCurrent = () => assertSettingsReadContext(context);
  // 与官方渠道现有本地分区算法一致；只用于本机查找，绝不传进投影或上传。
  const officialAccountFingerprint = context.isAuthenticated
    ? createHash('sha256').update(`${CURRENT_CINDY_REGION}\0${context.dataOwnerId}`).digest('base64url').slice(0, 22) : null;
  const inspection = collectSettingsInspection([
    () => inspectPreferenceSettingsForSnapshot(context.platform),
    inspectCoreSettingsForSnapshot,
    () => inspectInteractionSettings({ ...context, ownerId: context.dataOwnerId, mode: context.mode as 'local' | 'cloud', officialAccountFingerprint }),
    () => inspectDynamicSettingsCollections({ ownerRoot: context.ownerRoot, ownerId: context.dataOwnerId, ownerGeneration: context.generation,
      mode: context.mode as 'local' | 'cloud', ...readKnownWorkspaces() }),
  ], assertCurrent);
  const result = projectSettingsSnapshotV2(inspection, getSettingsPublicIdentifiers());
  assertCurrent();
  return result;
}
