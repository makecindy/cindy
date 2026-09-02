import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  classifyColor,
  classifySnapshot,
  PROTECTED_IDS,
  stableStringify,
  type ClassificationCategory,
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

  it('独立 oracle：分类类别必须与快照值实际形态语义一致，不能只看 id 后缀', () => {
    // 独立于被测实现复刻分类语义口径（刻意不复用 classify.ts 的
    // classifyValue / isLiteralKind，改用自己的正则判定，分类规则变更时
    // 必须与本测试同步更新）：
    //   protected 条目 → runtime-derived-or-protected（只看登记表）；
    //   -hsl 后缀且双模式都是 hsl-triplet → hsl-triplet；
    //   双 alias → alias；双字面量 → literal；其余一律 runtime-derived。
    const TRIPLET_VALUE_RE = /^-?\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%$/;
    const ALIAS_VALUE_RE = /^(?:hsl\()?var\(--[a-z0-9-]+\)\)?$/;
    const HEX_VALUE_RE = /^#([0-9a-fA-F]{3,8})$/;
    const RGB_VALUE_RE = /^rgba?\(/;
    const HSL_FN_VALUE_RE = /^hsla?\(/;

    const isAlias = (value: string | null) =>
      value != null && ALIAS_VALUE_RE.test(value.trim());
    const isTriplet = (value: string | null) =>
      value != null && TRIPLET_VALUE_RE.test(value.trim());
    const isLiteral = (value: string | null) => {
      if (value == null) return false;
      const text = value.trim();
      return (
        HEX_VALUE_RE.test(text) ||
        RGB_VALUE_RE.test(text) ||
        HSL_FN_VALUE_RE.test(text) ||
        text === 'transparent' ||
        isTriplet(value)
      );
    };

    const expected = new Map<string, ClassificationCategory>();
    for (const color of snapshot.colors) {
      let category: ClassificationCategory;
      if (color.id in PROTECTED_IDS) {
        category = 'runtime-derived-or-protected';
      } else if (
        color.id.endsWith('-hsl') &&
        isTriplet(color.light) &&
        isTriplet(color.dark)
      ) {
        category = 'hsl-triplet';
      } else if (isAlias(color.light) && isAlias(color.dark)) {
        category = 'alias';
      } else if (isLiteral(color.light) && isLiteral(color.dark)) {
        category = 'literal';
      } else {
        category = 'runtime-derived-or-protected';
      }
      expected.set(color.id, category);
    }
    for (const entry of generated.entries) {
      expect(
        entry.category,
        `id=${entry.id} category=${entry.category} 与独立判定 ${expected.get(entry.id)} 不一致`,
      ).toBe(expected.get(entry.id));
    }
  });

  it('反证：-hsl 后缀但值非 triplet 的合成条目不许被分进 hsl-triplet', () => {
    // 旧实现只看 -hsl 后缀就归 hsl-triplet；现在必须按双模式实际值判定。
    const hslSuffixedButLiteral = classifyColor({
      id: 'something-hsl',
      light: '#000000',
      dark: '#ffffff',
    });
    expect(hslSuffixedButLiteral.category).toBe('literal');
    const hslSuffixedButAlias = classifyColor({
      id: 'something-hsl',
      light: 'var(--surface)',
      dark: 'var(--surface)',
    });
    expect(hslSuffixedButAlias.category).toBe('alias');
    const hslSuffixedButSingleMode = classifyColor({
      id: 'something-hsl',
      light: '60 12.5% 97%',
      dark: '#ffffff',
    });
    expect(hslSuffixedButSingleMode.category).toBe('literal');
    // 真实快照中全部 -hsl id 确实双模式都是 triplet（登记与现状一致）
    const realHslIds = snapshot.colors.filter((color) => color.id.endsWith('-hsl'));
    expect(realHslIds.length).toBeGreaterThan(0);
    for (const color of realHslIds) {
      expect(color.light).toMatch(/^-?\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%$/);
      expect(color.dark).toMatch(/^-?\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%$/);
    }
  });
});
