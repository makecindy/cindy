import { describe, expect, it } from 'vitest';
import {
  ghostManifestToLegacyV2DigestFormat,
  ghostPermissionItems,
  validateGhostManifest,
  validateNormalizedGhostManifest,
  validateInstalledGhostManifest,
  ghostManifestToAuthorFormat,
} from '../ghost.js';

const base = {
  schemaVersion: 3,
  minCindyVersion: '0.1.0',
  id: 'task-test',
  name: 'Tasks',
  version: '1.0.0',
  entry: 'main.js',
};
describe('plugin tasks permission compatibility', () => {
  it('adds a distinct permission without changing old errand permissions', () => {
    const old = validateGhostManifest({ ...base, agent: { errand: true } });
    const next = validateGhostManifest({ ...base, agent: { errand: true, tasks: true } });
    expect(old.ok && next.ok).toBe(true);
    if (!old.ok || !next.ok) return;
    const before = ghostPermissionItems(old.manifest);
    const after = ghostPermissionItems(next.manifest);
    expect(after.filter((item) => item.key !== 'agent:tasks')).toEqual(before);
    expect(after.some((item) => item.key === 'agent:tasks')).toBe(true);
  });
  it('rejects a non-boolean declaration', () => {
    expect(validateGhostManifest({ ...base, agent: { tasks: 'yes' } }).ok).toBe(false);
  });
  it('keeps the released V2 digest projection frozen', () => {
    const source = { schemaVersion: 2, slots: ['agent'], agent: { errand: true, tasks: true } };
    const projected = ghostManifestToLegacyV2DigestFormat(source, source) as typeof source;
    expect(projected.agent).toEqual({ errand: true });
  });
});

it.each(['future', { future: true }, ['future'], null, false])('retains historical tasks %j without granting it', (tasks) => {
  const raw = { ...base, agent: { tasks } };
  const result = validateInstalledGhostManifest(raw);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.manifest.agent).toEqual({ tasks });
  expect(ghostPermissionItems(result.manifest).some(item => item.key === 'agent:tasks')).toBe(false);
  const again = validateNormalizedGhostManifest(ghostManifestToAuthorFormat(result.manifest));
  expect(again.ok && again.manifest).toEqual(result.manifest);
  expect(validateGhostManifest(raw).ok).toBe(false);
});
