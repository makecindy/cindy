import { describe, expect, it } from 'vitest';
import {
  diffGhostPermissionItems,
  ghostDeclaresHiddenTasks,
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

describe('background tasks declaration (agent.hiddenTasks)', () => {
  it('requires tasks and lists a distinct permission right after agent:tasks', () => {
    const result = validateGhostManifest({ ...base, agent: { tasks: true, hiddenTasks: true } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.agent).toEqual({ tasks: true, hiddenTasks: true });
    expect(ghostDeclaresHiddenTasks(result.manifest)).toBe(true);
    const keys = ghostPermissionItems(result.manifest).map(item => item.key);
    expect(keys.indexOf('agent:hidden-tasks')).toBe(keys.indexOf('agent:tasks') + 1);
    expect(ghostPermissionItems(result.manifest).find(item => item.key === 'agent:hidden-tasks'))
      .toMatchObject({ kind: 'agent', labelKey: 'agentHiddenTasks', detailKey: 'agentHiddenTasksDetail' });
  });
  it.each([
    { hiddenTasks: true },
    { errand: true, hiddenTasks: true },
    { tasks: false, hiddenTasks: true },
    { tasks: true, hiddenTasks: 'yes' },
  ])('rejects %j for new packages', (agent) => {
    expect(validateGhostManifest({ ...base, agent }).ok).toBe(false);
  });
  it('treats hiddenTasks:false as the default visible behavior', () => {
    const result = validateGhostManifest({ ...base, agent: { tasks: true, hiddenTasks: false } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.agent).toEqual({ tasks: true });
    expect(ghostPermissionItems(result.manifest).some(item => item.key === 'agent:hidden-tasks')).toBe(false);
  });
  it('counts adding the declaration as an added permission on update', () => {
    const prev = validateGhostManifest({ ...base, agent: { tasks: true } });
    const next = validateGhostManifest({ ...base, agent: { tasks: true, hiddenTasks: true } });
    expect(prev.ok && next.ok).toBe(true);
    if (!prev.ok || !next.ok) return;
    expect(diffGhostPermissionItems(prev.manifest, next.manifest).added.map(item => item.key)).toEqual(['agent:hidden-tasks']);
  });
  it.each([
    { tasks: true, hiddenTasks: 'yes' },
    { hiddenTasks: true, errand: true },
  ])('retains historical installed value %j without granting background tasks', (agent) => {
    const result = validateInstalledGhostManifest({ ...base, agent });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ghostDeclaresHiddenTasks(result.manifest)).toBe(false);
    expect(ghostPermissionItems(result.manifest).some(item => item.key === 'agent:hidden-tasks')).toBe(false);
  });
  it('survives the installed snapshot round trip', () => {
    const result = validateInstalledGhostManifest({ ...base, agent: { tasks: true, hiddenTasks: true } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ghostDeclaresHiddenTasks(result.manifest)).toBe(true);
    const again = validateNormalizedGhostManifest(ghostManifestToAuthorFormat(result.manifest));
    expect(again.ok && again.manifest).toEqual(result.manifest);
  });
});

// A pre-existing tasks grant must not silently acquire cross-task/companion access.
it('requires independent target permission and preserves inert historical declarations', () => {
  const previous = validateGhostManifest({ ...base, agent: { tasks: true } });
  const next = validateGhostManifest({ ...base, agent: { tasks: true, targets: true } });
  if (!previous.ok || !next.ok) throw new Error('invalid fixture');
  expect(diffGhostPermissionItems(previous.manifest, next.manifest).added.map(item => item.key)).toEqual(['agent:targets']);
  for (const agent of [{ targets: true }, { tasks: true, targets: 'yes' }]) {
    expect(validateGhostManifest({ ...base, agent }).ok).toBe(false);
    const installed = validateInstalledGhostManifest({ ...base, agent });
    if (!installed.ok) throw new Error('historical plugin disabled');
    expect(installed.manifest.agent).toEqual(agent);
    expect(ghostPermissionItems(installed.manifest).some(item => item.key === 'agent:targets')).toBe(false);
    const again = validateNormalizedGhostManifest(ghostManifestToAuthorFormat(installed.manifest));
    expect(again.ok && again.manifest).toEqual(installed.manifest);
  }
});

// unit: old installed unknown fields stay inert and do not disable existing plugins.
it('requires separate delegation permission and preserves old installed declarations', () => {
  const previous = validateGhostManifest({ ...base, agent: { tasks: true, targets: true } });
  const next = validateGhostManifest({ ...base, agent: { tasks: true, targets: true, delegation: true } });
  if (!previous.ok || !next.ok) throw new Error('invalid fixture');
  expect(diffGhostPermissionItems(previous.manifest, next.manifest).added.map(item => item.key)).toEqual(['agent:delegation']);
  for (const agent of [{ delegation: true }, { tasks: true, delegation: true }, { tasks: true, targets: true, delegation: 'yes' }]) {
    expect(validateGhostManifest({ ...base, agent }).ok).toBe(false);
    const installed = validateInstalledGhostManifest({ ...base, agent });
    if (!installed.ok) throw new Error('historical plugin disabled');
    expect(installed.manifest.agent).toEqual(agent);
    expect(ghostPermissionItems(installed.manifest).some(item => item.key === 'agent:delegation')).toBe(false);
  }
});
