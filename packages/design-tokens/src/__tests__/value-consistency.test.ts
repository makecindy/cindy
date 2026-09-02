import { describe, expect, it } from 'vitest';

import { buildLayers, resolvedSemanticValues } from '../build-layers.ts';
import { SEMANTIC_ROLES } from '../semantic-roles.ts';
import { assertSemanticMatchesSnapshot, snapshotMismatch } from '../guards.ts';
import { findRepoRoot } from '../paths.ts';
import { readSnapshot, snapshotById } from '../snapshot.ts';

describe('DS-3 · 逐值一致守卫', () => {
  const snapshot = readSnapshot(findRepoRoot());
  const layers = buildLayers(snapshotById(snapshot));

  it('每个 semantic 角色 light/dark 等于 DS-2b 冻结快照对应 id', () => {
    assertSemanticMatchesSnapshot(layers, snapshot);
    const resolved = resolvedSemanticValues(layers);
    expect(resolved.size).toBe(SEMANTIC_ROLES.length);
    for (const role of SEMANTIC_ROLES) {
      const frozen = snapshot.colors.find((entry) => entry.id === role.id);
      expect(frozen, snapshotMismatch(`快照缺少 ${role.id}`)).toBeTruthy();
      expect(resolved.get(role.id)).toEqual({
        light: frozen?.light,
        dark: frozen?.dark,
      });
    }
  });

  it('自证伪：模拟改一个 semantic 值后守卫必然红', () => {
    const mutated = structuredClone(layers);
    const firstRef = Object.keys(mutated.reference).find((key) => !key.startsWith('$'));
    expect(firstRef).toBeTruthy();
    const leaf = mutated.reference[firstRef!] as { $value: string };
    leaf.$value = '#not-the-frozen-snapshot-value';
    expect(() => assertSemanticMatchesSnapshot(mutated, snapshot)).toThrow(
      /与 DS-2b 冻结快照不一致/,
    );
  });
});
