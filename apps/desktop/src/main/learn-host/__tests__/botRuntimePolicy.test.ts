import { describe, expect, it } from 'vitest';
import { botRuntimeSnapshotIncludesSkill } from '../botRuntimePolicy.js';

describe('botRuntimeSnapshotIncludesSkill', () => {
  const path = 'C:/cindy/skills/learn/SKILL.md';
  const snapshot = (skillResources: unknown) => JSON.stringify({ skillResources });

  it('requires the exact selected command and source path', () => {
    expect(botRuntimeSnapshotIncludesSkill(snapshot([
      { name: 'skill:learn', path },
    ]), 'skill:learn', path)).toBe(true);
    expect(botRuntimeSnapshotIncludesSkill(snapshot([
      { name: 'skill:learn', path: 'C:/other/learn/SKILL.md' },
    ]), 'skill:learn', path)).toBe(false);
    expect(botRuntimeSnapshotIncludesSkill(snapshot([
      { name: 'skill:release', path },
    ]), 'skill:learn', path)).toBe(false);
  });

  it('fails closed for empty, missing, or malformed resolved policy', () => {
    expect(botRuntimeSnapshotIncludesSkill(snapshot([]), 'skill:learn', path)).toBe(false);
    expect(botRuntimeSnapshotIncludesSkill(snapshot(undefined), 'skill:learn', path)).toBe(false);
    expect(botRuntimeSnapshotIncludesSkill('{', 'skill:learn', path)).toBe(false);
  });
});
