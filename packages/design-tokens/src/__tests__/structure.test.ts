import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildLayers } from '../build-layers.ts';
import type { DtcgFile } from '../dtcg.ts';
import {
  validateAliasDirection,
  validateDtcgSyntax,
  validateDualModes,
  validateStructure,
} from '../guards.ts';
import { componentPath, findRepoRoot, referencePath, semanticPath } from '../paths.ts';
import { readSnapshot, snapshotById } from '../snapshot.ts';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function readFixture(name: string): DtcgFile {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as DtcgFile;
}

describe('DS-3 · 结构守卫', () => {
  const repoRoot = findRepoRoot();
  const layers = buildLayers(snapshotById(readSnapshot(repoRoot)));

  it('正式影子层 DTCG 语法合法、alias 单向、双模式齐全', () => {
    expect(validateStructure(layers)).toEqual([]);
    expect(JSON.parse(readFileSync(referencePath(repoRoot), 'utf8'))).toEqual(
      layers.reference,
    );
    expect(JSON.parse(readFileSync(semanticPath(repoRoot), 'utf8'))).toEqual(
      layers.semantic,
    );
    expect(JSON.parse(readFileSync(componentPath(repoRoot), 'utf8'))).toEqual(
      layers.component,
    );
  });

  it('错误 fixture：非法 DTCG 语法被命中', () => {
    const issues = validateDtcgSyntax(readFixture('invalid-syntax.json'), 'invalid-syntax');
    expect(issues.some((issue) => issue.code === 'invalid-syntax')).toBe(true);
  });

  it('错误 fixture：缺少 dark 模式被命中', () => {
    const issues = validateDualModes(readFixture('missing-dark-mode.json'));
    expect(issues.some((issue) => issue.code === 'missing-mode')).toBe(true);
  });

  it('错误 fixture：reference 反向 alias 被命中', () => {
    const issues = validateAliasDirection({
      reference: readFixture('alias-from-reference.json'),
      semantic: layers.semantic,
      component: layers.component,
    });
    expect(issues.some((issue) => issue.code === 'alias-direction')).toBe(true);
  });

  it('错误 fixture：component 写字面量被命中', () => {
    const issues = validateAliasDirection({
      reference: layers.reference,
      semantic: layers.semantic,
      component: readFixture('component-literal.json'),
    });
    expect(issues.some((issue) => issue.code === 'alias-direction')).toBe(true);
  });
});
