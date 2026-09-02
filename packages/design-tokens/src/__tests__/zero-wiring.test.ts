import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  containsRuntimeImportOfDesignTokens,
  findRuntimeImportsOfDesignTokens,
} from '../guards.ts';
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

  it('自证伪：每一种非法接线形态都必须被探测器命中', () => {
    // 预测红集 = 除旧三形态（from / require / src 路径）外，本清单全部为新形态。
    // 逐个点名，避免 .some(...) 弱断言互相掩盖。
    const illegal: Array<[string, string]> = [
      ['静态具名 import', "import { surface } from '@cindy/design-tokens';"],
      ['静态默认 import（双引号）', 'import surface from "@cindy/design-tokens";'],
      ['命名空间 import', "import * as dt from '@cindy/design-tokens';"],
      ['type-only import', "import type { surface } from '@cindy/design-tokens';"],
      ['副作用 import', "import '@cindy/design-tokens';"],
      ['动态 import()', "const layer = await import('@cindy/design-tokens');"],
      ['动态 import() 跨行', "const layer = await import(\n  '@cindy/design-tokens'\n);"],
      ['TS import-equals', "import dt = require('@cindy/design-tokens');"],
      ['CJS require', "const dt = require('@cindy/design-tokens');"],
      ['require 子路径', "const pkg = require('@cindy/design-tokens/package.json');"],
      ['import.meta.resolve', "const url = import.meta.resolve('@cindy/design-tokens');"],
      ['re-export', "export { surface } from '@cindy/design-tokens';"],
      ['相对路径直读包内源码', "import { x } from '../../../packages/design-tokens/src/snapshot.ts';"],
    ];
    for (const [name, source] of illegal) {
      expect(containsRuntimeImportOfDesignTokens(source), name).toBe(true);
    }
  });

  it('自证伪：非导入语境（注释 / 普通字符串）不误报', () => {
    const legal = [
      '// TODO(DS-8): wire "@cindy/design-tokens" here when consumers open up.',
      "const moduleId = '@cindy/design-tokens';",
      "console.log('migrating @cindy/design-tokens later');",
    ];
    for (const source of legal) {
      expect(containsRuntimeImportOfDesignTokens(source)).toBe(false);
    }
  });
});
