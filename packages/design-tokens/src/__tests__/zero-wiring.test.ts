import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { findRuntimeImportsOfDesignTokens } from '../guards.ts';
import { findRepoRoot } from '../paths.ts';

describe('DS-3 · 零接线守卫', () => {
  const repoRoot = findRepoRoot();

  it('不被 desktop / mobile / 任何运行时 package import', () => {
    expect(findRuntimeImportsOfDesignTokens(repoRoot)).toEqual([]);
  });

  it('本包 package.json 不被任何 workspace 声明为依赖，且不装 token 工具', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      name: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.name).toBe('@cindy/design-tokens');
    expect(pkg.dependencies ?? {}).toEqual({});
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    expect(Object.keys(deps).sort()).toEqual(['@types/node', 'typescript', 'vitest']);
    expect(Object.keys(deps).some((name) => /terrazzo|style-dictionary/i.test(name))).toBe(
      false,
    );
  });
});
