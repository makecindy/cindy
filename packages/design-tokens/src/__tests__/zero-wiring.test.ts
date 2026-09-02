import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  containsRuntimeImportOfDesignTokens,
  findRuntimeImportsOfDesignTokens,
  relativeSpecifierHitsDesignTokens,
  stripCommentsAndDataStrings,
} from '../guards.ts';
import { findRepoRoot } from '../paths.ts';

describe('DS-3 · 零接线守卫', () => {
  const repoRoot = findRepoRoot();

  it('不被 desktop / mobile / 任何运行时 package import', () => {
    expect(findRuntimeImportsOfDesignTokens(repoRoot)).toEqual([]);
  }, 60_000); // 全仓扫描（数千文件 × 剥除层复核），Windows CI 慢盘需余量

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

  it('自证伪：兄弟 workspace 的相对路径直读必须被命中（review P1 补洞）', () => {
    // 旧实现只有 `packages/design-tokens/…` 字面量正则；兄弟包
    // packages/foo/src/a.ts 写 `../../design-tokens/src/…` 时说明符不含
    // `packages/` 段，漏检。现在按被扫描文件位置 resolve 相对说明符判定。
    const cases: Array<[string, string, string]> = [
      [
        '兄弟包 src 下两级上行',
        "import { x } from '../../design-tokens/src/snapshot.ts';",
        'packages/foo/src/a.ts',
      ],
      [
        '兄弟包包根一级上行',
        "import { x } from '../design-tokens/src/snapshot.ts';",
        'packages/foo/index.ts',
      ],
      [
        'apps 侧四层上行',
        "import { x } from '../../../../packages/design-tokens/src/snapshot.ts';",
        'apps/desktop/src/renderer/a.tsx',
      ],
      [
        'require 相对路径',
        "const dt = require('../../design-tokens/src/snapshot.ts');",
        'packages/foo/src/a.ts',
      ],
      [
        '动态 import 相对路径',
        "const layer = await import('../../design-tokens/src/snapshot.ts');",
        'packages/foo/src/a.ts',
      ],
      [
        'export-from 相对路径',
        "export { x } from '../../design-tokens/src/snapshot.ts';",
        'packages/foo/src/a.ts',
      ],
      [
        '副作用 import 相对路径（review P2 补洞）',
        "import '../../design-tokens/src/generate.ts';",
        'packages/foo/src/a.ts',
      ],
      [
        '副作用 import 相对路径换行',
        "import\n  '../../design-tokens/src/generate.ts';",
        'packages/foo/src/a.ts',
      ],
    ];
    for (const [name, source, fileRel] of cases) {
      expect(relativeSpecifierHitsDesignTokens(source, fileRel), name).toBe(true);
    }
  });

  it('自证伪：指向其它包的相对 import 不误报', () => {
    // 注：design-tokens 包自身目录被 findRuntimeImportsOfDesignTokens 整体
    // 跳过，这里用兄弟包互相引用的形态验证不误报。
    const legal: Array<[string, string, string]> = [
      [
        '兄弟包指向另一个兄弟',
        "import { x } from '../maker-shared/src/util.ts';",
        'packages/foo/src/a.ts',
      ],
      [
        '兄弟包 src 内部相对导入',
        "import { y } from './classify.ts';",
        'packages/foo/src/a.ts',
      ],
      [
        'apps 内部相对导入',
        "import { z } from '../themes/colors';",
        'apps/desktop/src/renderer/a.tsx',
      ],
      [
        '普通字符串不是说明符',
        "const hint = '../../design-tokens/src/snapshot.ts';",
        'packages/foo/src/a.ts',
      ],
      [
        '成员调用 foo.import 不是 import 语句',
        "foo.import('../../design-tokens/src/snapshot.ts');",
        'packages/foo/src/a.ts',
      ],
      [
        '成员调用 foo.require 不是 require',
        "foo.require('../../design-tokens/src/snapshot.ts');",
        'packages/foo/src/a.ts',
      ],
    ];
    for (const [name, source, fileRel] of legal) {
      expect(relativeSpecifierHitsDesignTokens(source, fileRel), name).toBe(false);
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

  it('自证伪：注释 / 错误消息里的完整 import 语句不误报（review P1 补洞）', () => {
    // 旧实现把源码全文直接喂给正则，注释掉的完整 import 语句（语法齐全、
    // 只是语境是注释）会被当真实接线，无运行时接线的改动被 CI 阻断。
    const legal = [
      "// import '@cindy/design-tokens';",
      "/* import '@cindy/design-tokens' */",
      "/**\n * import '@cindy/design-tokens'\n */",
      "// const l = await import('@cindy/design-tokens');",
      "// import { x } from '@cindy/design-tokens';",
      "const s = \"import '@cindy/design-tokens';\";",
      "throw new Error(\"do not import '@cindy/design-tokens' here\");",
      "// import '../../design-tokens/src/snapshot.ts';",
    ];
    for (const source of legal) {
      expect(containsRuntimeImportOfDesignTokens(source), source).toBe(false);
      expect(
        relativeSpecifierHitsDesignTokens(source, 'packages/foo/src/a.ts'),
        source,
      ).toBe(false);
    }
  });

  it('自证伪：注释剥除后真实 import 语句仍然命中', () => {
    // 剥除层不能反向吞掉真实接线：代码区（非注释非字符串）的 import 全形态
    // 必须照常命中。
    const illegal = [
      "import '@cindy/design-tokens';",
      "import { x } from '@cindy/design-tokens';",
      "const l = await import('@cindy/design-tokens');",
      "const x = require('@cindy/design-tokens');",
      "// 前面有注释没关系\nimport { x } from '@cindy/design-tokens';",
      "const note = 'a data string';\nimport { x } from '@cindy/design-tokens';",
    ];
    for (const source of illegal) {
      expect(containsRuntimeImportOfDesignTokens(source), source).toBe(true);
    }
  });

  it('自证伪：stripCommentsAndDataStrings 保留说明符、剥除数据内容', () => {
    expect(stripCommentsAndDataStrings("import { x } from '../../a.ts';")).toBe(
      "import { x } from '../../a.ts';",
    );
    expect(stripCommentsAndDataStrings("const s = 'some data';")).toBe(
      "const s = '         ';",
    );
    expect(stripCommentsAndDataStrings("// a comment")).toBe("            ");
    expect(
      stripCommentsAndDataStrings("const s = 'x'; import { y } from './b';"),
    ).toBe("const s = ' '; import { y } from './b';");
  });

  it('自证伪：说明符前带注释的合法导入必须被命中（review P2 补洞）', () => {
    // 旧的两段式先在原始文本上预扫：`import(/* c */ '…')` 的注释隔断了
    // 关键字→引号衔接，预扫零命中提前返回，剥除层反而执行不到——漏放。
    // 现在剥除在前（注释→空白替换恢复衔接）。相对说明符走 rel 通道，
    // 包 id 说明符走 id 通道，各按各的管辖断言。
    const relativeCases: Array<[string, string]> = [
      [
        '动态 import 带注释（相对路径）',
        "const l = await import(/* webpackChunkName: 'tokens' */ '../../design-tokens/src/snapshot.ts');",
      ],
      [
        'require 带注释（相对路径）',
        "const x = require(/* chunk */ '../../design-tokens/src/snapshot.ts');",
      ],
      [
        '副作用 import 关键字后带注释（相对路径）',
        "import /* c */ '../../design-tokens/src/generate.ts';",
      ],
    ];
    for (const [name, source] of relativeCases) {
      expect(
        relativeSpecifierHitsDesignTokens(source, 'packages/foo/src/a.ts'),
        name,
      ).toBe(true);
    }
    const idCases: Array<[string, string]> = [
      [
        '包 id 动态 import 带注释',
        "const l = await import(/* x */ '@cindy/design-tokens');",
      ],
      [
        '包 id 静态 import 带注释',
        "import { x } /* load tokens */ from '@cindy/design-tokens';",
      ],
      [
        '包 id require 带注释',
        "const x = require(/* tokens */ '@cindy/design-tokens');",
      ],
    ];
    for (const [name, source] of idCases) {
      expect(containsRuntimeImportOfDesignTokens(source), name).toBe(true);
    }
  });
});
