import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  classifySnapshot,
  PROTECTED_IDS,
  stableStringify,
} from '../classify.ts';
import { buildShadowLayerFiles } from '../generate.ts';
import {
  assertClassificationCoversSnapshot,
  assertProtectedNotSemantic,
} from '../guards.ts';
import {
  classificationPath,
  findRepoRoot,
  referencePath,
  semanticPath,
} from '../paths.ts';
import { readSnapshot } from '../snapshot.ts';

describe('DS-3 · 分类登记', () => {
  const repoRoot = findRepoRoot();
  const snapshot = readSnapshot(repoRoot);
  const generated = classifySnapshot(snapshot.colors, snapshot.source);
  const onDisk = JSON.parse(readFileSync(classificationPath(repoRoot), 'utf8'));

  it('覆盖冻结快照全部 id，计数等于 fixture.count，四类互斥完备', () => {
    expect(snapshot.colors.length).toBe(snapshot.count);
    assertClassificationCoversSnapshot(generated, snapshot);
    expect(generated.snapshotCount).toBe(snapshot.count);
    const sum = Object.values(generated.categories).reduce((a, b) => a + b, 0);
    expect(sum).toBe(snapshot.count);
  });

  it('两次生成字节一致', () => {
    const first = stableStringify(classifySnapshot(snapshot.colors, snapshot.source));
    const second = stableStringify(classifySnapshot(snapshot.colors, snapshot.source));
    expect(first).toBe(second);
    expect(stableStringify(onDisk)).toBe(first);
  });

  it('磁盘上的影子层与内存生成字节一致', () => {
    const built = buildShadowLayerFiles(repoRoot);
    expect(built.files).toEqual([
      { path: classificationPath(repoRoot), body: stableStringify(generated) },
      { path: referencePath(repoRoot), body: stableStringify(built.layers.reference) },
      { path: semanticPath(repoRoot), body: stableStringify(built.layers.semantic) },
    ]);
    for (const file of built.files) {
      expect(readFileSync(file.path, 'utf8')).toBe(file.body);
    }
  });

  it('加严保护值标记 protected，未进 semantic 映射', () => {
    assertProtectedNotSemantic(generated);
    for (const id of Object.keys(PROTECTED_IDS)) {
      const entry = generated.entries.find((item) => item.id === id);
      expect(entry?.category).toBe('runtime-derived-or-protected');
      expect(entry?.modeledAsSemantic).toBe(false);
      expect(entry?.protected).toBeTruthy();
    }
  });
});
