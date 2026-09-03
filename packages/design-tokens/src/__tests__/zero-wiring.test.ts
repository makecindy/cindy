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
      // 注：`.` 前缀的成员调用（foo.import / foo.require / module.require）
      // 自 2320ce02 轮起**有意命中**——module.require 是 Node 真实加载 API，
      // 自定义成员调用宁误报不漏放（见 module.require 用例的说明）。
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

  it('自证伪：超长注释不挤掉导入语境（review P1 补洞）', () => {
    // 旧实现用固定 64 字符 tail 窗口判语境：>64 字符的块注释被剥成空白后
    // 把 import( 挤出窗口，说明符被当数据字符串清空——两个通道都漏放。
    // 现在状态机维护「无空白压缩的最近输出」，注释不推进语境，任意长度
    // 注释都不影响判定。
    const c100 = 'x'.repeat(100);
    const c300 = '很长的注释内容。'.repeat(30);
    expect(
      containsRuntimeImportOfDesignTokens(
        `import(/* ${c100} */ '@cindy/design-tokens')`,
      ),
    ).toBe(true);
    expect(
      relativeSpecifierHitsDesignTokens(
        `const l = await import(/* ${c300} */ '../../design-tokens/src/snapshot.ts');`,
        'packages/foo/src/a.ts',
      ),
    ).toBe(true);
  });

  it('自证伪：module.require 是真实加载入口，必须被命中（review P1 补洞）', () => {
    // 旧实现的 `(?<![\w$.])` 把 `module.require('…')` 当成员调用排除，但
    // 它是 Node 真实模块加载 API——.cjs 等源码可借它在零接线阶段消费影子
    // 包。现在后顾只排除标识符连写（myImport），`.` 前缀放行；foo.import(
    // 这类自定义成员调用同被命中（宁误报不漏放，守卫拦截的是真接线）。
    expect(
      containsRuntimeImportOfDesignTokens(
        "const x = module.require('@cindy/design-tokens');",
      ),
    ).toBe(true);
    expect(
      relativeSpecifierHitsDesignTokens(
        "const x = module.require('../../design-tokens/src/snapshot.ts');",
        'packages/foo/src/a.cjs',
      ),
    ).toBe(true);
    // 标识符连写仍然排除（myImport 不是 require）。
    expect(
      relativeSpecifierHitsDesignTokens(
        "myImport '../../design-tokens/src/snapshot.ts';",
        'packages/foo/src/a.cjs',
      ),
    ).toBe(false);
  });

  it('自证伪：模板字面量形式的说明符必须被命中（review P1 补洞）', () => {
    // `import(\`../../design-tokens/src/snapshot.ts\`)` 这类无插值模板字面量
    // 是有效运行时加载形态，旧提取正则只认单双引号——漏放。带 `${…}` 插值
    // 的模板同样命中：路径在运行期拼装恰是零接线阶段不该出现的动态消费。
    const relCases: Array<[string, string]> = [
      ['import(无插值模板，相对路径)', 'import(`../../design-tokens/src/snapshot.ts`)'],
      ['动态 import 模板（相对路径）', 'const l = await import(`../../design-tokens/src/snapshot.ts`);'],
      ['require.resolve 模板（相对路径）', 'require.resolve(`../../design-tokens/src/snapshot.ts`)'],
      ['import(插值模板，相对路径)', 'import(`../../design-tokens/src/${name}.ts`)'],
    ];
    for (const [name, source] of relCases) {
      expect(
        relativeSpecifierHitsDesignTokens(source, 'packages/foo/src/a.ts'),
        name,
      ).toBe(true);
    }
    const idCases: Array<[string, string]> = [
      ['import(无插值模板，包 id)', 'import(`@cindy/design-tokens`)'],
      ['require(无插值模板，包 id)', 'require(`@cindy/design-tokens/src/snapshot.ts`)'],
      ['from 模板（包 id）', 'import { x } from `@cindy/design-tokens`;'],
      ['副作用 import 模板（包 id）', 'import `@cindy/design-tokens`;'],
    ];
    for (const [name, source] of idCases) {
      expect(containsRuntimeImportOfDesignTokens(source), name).toBe(true);
    }
    // 数据语境的普通模板（非说明符位置）不误报——剥离层已剥内容。
    expect(
      containsRuntimeImportOfDesignTokens(
        'const t = `plain template mentioning @cindy/design-tokens`;',
      ),
    ).toBe(false);
  });

  it('自证伪：new URL(import.meta.url) 直接文件读取必须被命中（review P1 补洞）', () => {
    // `readFileSync(new URL('../../design-tokens/src/semantic/color.json',
    // import.meta.url))` 直接消费影子层文件——旧实现的剥离层把 new URL 的
    // 第一参数当普通数据清空、说明符语境也没有 new URL——漏放。现在
    // `new URL('…'` 是第七种说明符语境（按调用文件位置 resolve 相对路径）。
    const relCases: Array<[string, string]> = [
      [
        'readFileSync(new URL(相对路径))',
        "readFileSync(new URL('../../design-tokens/src/semantic/color.json', import.meta.url), 'utf8')",
      ],
      [
        'new URL 模板形态',
        'readFileSync(new URL(`../../design-tokens/src/semantic/color.json`, import.meta.url), \'utf8\')',
      ],
    ];
    for (const [name, source] of relCases) {
      expect(
        relativeSpecifierHitsDesignTokens(source, 'packages/foo/src/a.ts'),
        name,
      ).toBe(true);
    }
    // 仓内既有 110 处 new URL(import.meta.url) 用法（读兄弟 tsx / css /
    // worker 等）都不指向 design-tokens，必须零误报。
    const nonHits: Array<[string, string]> = [
      ['既有用法：读兄弟 tsx', "readFileSync(new URL('../CCAgentSessionView.tsx', import.meta.url), 'utf8')"],
      ['既有用法：读 css', "fileURLToPath(new URL('../../../styles/globals.css', import.meta.url))"],
      ['既有用法：worker', "new Worker(new URL('../../../../../lib/highlight.worker.ts', import.meta.url), { type: 'module' })"],
    ];
    for (const [name, source] of nonHits) {
      expect(
        relativeSpecifierHitsDesignTokens(source, 'apps/desktop/src/renderer/features/x/a.test.ts'),
        name,
      ).toBe(false);
    }
    // 数据字符串里的 new URL 不误报。
    expect(
      containsRuntimeImportOfDesignTokens(
        'const s = "new URL(\'../../design-tokens/src/x\', import.meta.url)";',
      ),
    ).toBe(false);
  });

  it('自证伪：fs API 裸相对路径直读必须被命中（review P2 补洞）', () => {
    // `readFileSync('../../design-tokens/src/semantic/color.json')` 是最直接的
    // 文件消费方式——旧实现两个通道都漏（说明符语境只有 import/require/
    // resolve/new URL）。第一方代码既有 fs 读取全部走 resolve(__dirname…)
    // / new URL(…) 包装（54 处实测），裸相对形态为零——纳入扫描零误报。
    const hitCases: Array<[string, string]> = [
      ['readFileSync 裸相对路径', "readFileSync('../../design-tokens/src/semantic/color.json', 'utf8')"],
      ['readFile 异步形态', "readFile('../../design-tokens/src/snapshot.ts', cb)"],
      ['existsSync', "existsSync('../../design-tokens/src/semantic/color.json')"],
      ['readFileSync 模板形态', "readFileSync(`../../design-tokens/src/semantic/color.json`, 'utf8')"],
      ['fs.readFileSync 成员链', "fs.readFileSync('../../design-tokens/src/semantic/color.json', 'utf8')"],
    ];
    for (const [name, source] of hitCases) {
      expect(
        relativeSpecifierHitsDesignTokens(source, 'packages/foo/src/a.ts'),
        name,
      ).toBe(true);
    }
    // 绝对路径与裸文件名（cwd 相对）不命中：resolve 后不落进 design-tokens。
    const nonHits: Array<[string, string]> = [
      ['绝对路径', "readFileSync('/tmp/whatever.md', 'utf8')"],
      ['裸文件名', "readFileSync('package.json', 'utf8')"],
    ];
    for (const [name, source] of nonHits) {
      expect(
        relativeSpecifierHitsDesignTokens(source, 'packages/foo/src/a.ts'),
        name,
      ).toBe(false);
    }
  });

  it('自证伪：路径构造器包装形态必须被命中（review P2 补洞）', () => {
    // `readFileSync(resolve(__dirname, '../../design-tokens/…'))` 是仓内既有
    // fs 读取的主流写法——旧实现只认 fs API 第一参数直接以引号开始，包装
    // 形态两通道都漏。现在 resolve/join 调用内的静态字符串片段按调用文件
    // 位置 resolve（__dirname ≈ 文件所在目录）。
    const hitCases: Array<[string, string]> = [
      ['resolve(__dirname, rel)', "readFileSync(resolve(__dirname, '../../design-tokens/src/semantic/color.json'), 'utf8')"],
      ['join(__dirname, rel)', "readFileSync(join(__dirname, '../../design-tokens/src/snapshot.ts'), 'utf8')"],
      ['resolve(变量基座, rel)', "readFileSync(resolve(here, '../../design-tokens/src/x.json'))"],
      [
        '分段 join（review P2 补洞：重建全部静态参数）',
        "readFileSync(join(__dirname, '..', '..', 'design-tokens/src/semantic/color.json'))",
      ],
      [
        '多段 resolve（每段一个目录）',
        "readFileSync(resolve(__dirname, '..', '..', 'design-tokens', 'src', 'semantic', 'color.json'))",
      ],
      [
        '分段 join 模板段',
        "readFileSync(join(here, '..', '..', `design-tokens/src/x.json`))",
      ],
    ];
    for (const [name, source] of hitCases) {
      expect(
        relativeSpecifierHitsDesignTokens(source, 'packages/foo/src/a.ts'),
        name,
      ).toBe(true);
    }
    // 既有 resolve/join 用法（读兄弟 tsx / 组件 / 变量基座）不指向
    // design-tokens，必须零误报；Array.join 的分隔符字符串不以 `.` 开头，
    // 天然过滤。
    const nonHits: Array<[string, string]> = [
      ['既有用法：resolve 读兄弟 tsx', "readFileSync(resolve(__dirname, '../CCAgentSessionView.tsx'), 'utf8')"],
      ['既有用法：join 读组件', "readFileSync(join(here, '../../PublishDialog.tsx'), 'utf8')"],
      ['既有用法：resolve 变量基座', "readFileSync(resolve(skillhubDir, '../../router.tsx'), 'utf8')"],
      ['Array.join 分隔符', "arr.join('、')"],
    ];
    for (const [name, source] of nonHits) {
      expect(
        relativeSpecifierHitsDesignTokens(source, 'packages/foo/src/a.ts'),
        name,
      ).toBe(false);
    }
  });

  it('自证伪：Windows 反斜杠说明符必须被命中（review P2 补洞）', () => {
    // Windows CJS 允许 require('..\\..\\design-tokens\\src\\x')（源码字符串里
    // `\\` 是转义的单反斜杠）——旧实现直接交给 path.posix，反斜杠不被识别
    // 为分隔符，resolve 结果不落进 design-tokens——漏放。现在说明符统一
    // 反斜杠归一为 / 再 resolve。
    const hitCases: Array<[string, string]> = [
      ['require 反斜杠', "require('..\\\\..\\\\design-tokens\\\\src\\\\snapshot.ts')"],
      ['readFileSync 反斜杠', "readFileSync('..\\\\..\\\\design-tokens\\\\src\\\\semantic\\\\color.json', 'utf8')"],
    ];
    for (const [name, source] of hitCases) {
      expect(
        relativeSpecifierHitsDesignTokens(source, 'packages/foo/src/a.ts'),
        name,
      ).toBe(true);
    }
  });

  it('自证伪：import.meta.glob 是构建期加载入口，必须被命中（review P2 补洞）', () => {
    // Vite 的 import.meta.glob 在构建期把匹配文件打进产品——仓内
    // packages/lizi-mcps/src/browser/recipe-loader.ts 有实际用例。相对
    // glob 模式按文件位置 resolve（glob 元字符 ** /* 不影响前缀段判定）。
    expect(
      relativeSpecifierHitsDesignTokens(
        "import.meta.glob('../../design-tokens/src/**/*.json')",
        'packages/foo/src/a.ts',
      ),
    ).toBe(true);
    expect(
      relativeSpecifierHitsDesignTokens(
        'const mods = import.meta.glob(`../../design-tokens/src/**`)',
        'packages/foo/src/a.ts',
      ),
    ).toBe(true);
    // 既有用法（glob 不指向 design-tokens）不误报。
    expect(
      relativeSpecifierHitsDesignTokens(
        "import.meta.glob('../recipes/*.json')",
        'packages/foo/src/a.ts',
      ),
    ).toBe(false);
  });

  it('自证伪：语境残留不产生误报（review P2 补洞）', () => {
    // SPECIFIER_PREFIX_RE 的 \bfrom / \bimport 分支曾无 $ 锚定：源码先出现
    // 正常导入、再写 `const hint = 'packages/design-tokens/src/x'` 时，残留
    // 语境里的 import 字样让数据字符串被剥除层错误保留，裸路径模式随后
    // 误报接线、阻断 required unit workspace。$ 锚定保证只匹配紧邻当前
    // 开引号的调用语境。
    const falsePositiveCases = [
      "import x from './x'; const hint = 'packages/design-tokens/src/x';",
      "import x from './x'; log('packages/design-tokens/src/x')",
      "const a = 'x'; const hint = 'packages/design-tokens/src/x';",
    ];
    for (const source of falsePositiveCases) {
      expect(containsRuntimeImportOfDesignTokens(source), source).toBe(false);
    }
  });

  it('自证伪：fs/promises.open 句柄入口与 .mts/.cts 扫描必须被命中（review P2 补洞）', async () => {
    // node:fs/promises 的异步 open 返回 FileHandle 再 readFile——路径参数
    // 同样消费影子层；open 不在 fs API 列表时该形态漏放。window.open 的
    // URL 参数不以 `.` 开头，天然过滤（仓内实测零误报）。
    expect(
      relativeSpecifierHitsDesignTokens(
        "const file = await open('../../design-tokens/src/semantic/color.json'); await file.readFile();",
        'packages/foo/src/a.ts',
      ),
    ).toBe(true);
    expect(
      relativeSpecifierHitsDesignTokens(
        "const h = await open(`../../design-tokens/src/x.json`, 'r');",
        'packages/foo/src/a.ts',
      ),
    ).toBe(true);
    expect(
      relativeSpecifierHitsDesignTokens(
        "window.open('https://example.com/path');",
        'packages/foo/src/a.ts',
      ),
    ).toBe(false);

    // .mts/.cts 是有效 Node/TS 模块扩展（仓内 scripts/ 与 tools/ 已使用），
    // 扫描器不认它们时文件在读取内容前被跳过。用临时目录里的 .mts 消费者
    // 直接验证扫描器行为。
    const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    const tmpRoot = mkdtempSync(joinPath(tmpdir(), 'dt-zero-wiring-'));
    try {
      // 扫描器固定访问 apps/desktop、apps/mobile、packages 三个根——空目录
      // 也要建齐，readdirSync 不容忍缺失。
      for (const root of ['apps/desktop', 'apps/mobile', 'packages/foo/src']) {
        mkdirSync(joinPath(tmpRoot, root), { recursive: true });
      }
      const pkgDir = joinPath(tmpRoot, 'packages', 'foo', 'src');
      writeFileSync(
        joinPath(pkgDir, 'consumer.mts'),
        "import { x } from '../../design-tokens/src/snapshot.ts';\n",
      );
      writeFileSync(
        joinPath(pkgDir, 'consumer.cjs'),
        "const x = require('../../design-tokens/src/snapshot.ts');\n",
      );
      const hits = findRuntimeImportsOfDesignTokens(tmpRoot);
      expect(hits).toContain('packages/foo/src/consumer.mts');
      expect(hits).toContain('packages/foo/src/consumer.cjs');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('自证伪：require.resolve 是运行期加载入口，必须被命中（review P2 补洞）', () => {
    // `readFileSync(require.resolve('../../design-tokens/…'))` 是消费影子层的
    // 真实路径：旧实现的剥离层把 require.resolve 的参数当普通数据字符串
    // 清空，两个通道都漏放。现在 require.resolve 与 import.meta.resolve
    // 同列说明符语境（含 module.require.resolve 成员链与带空格形态）。
    const relCases: Array<[string, string]> = [
      [
        'readFileSync(require.resolve(相对路径))',
        "readFileSync(require.resolve('../../design-tokens/src/semantic/color.json'), 'utf8')",
      ],
      [
        '裸 require.resolve(相对路径)',
        "const p = require.resolve('../../design-tokens/src/snapshot.ts');",
      ],
      [
        'module.require.resolve(相对路径)',
        "const p = module.require.resolve('../../design-tokens/src/snapshot.ts');",
      ],
    ];
    for (const [name, source] of relCases) {
      expect(
        relativeSpecifierHitsDesignTokens(source, 'packages/foo/src/a.ts'),
        name,
      ).toBe(true);
    }
    const idCases: Array<[string, string]> = [
      [
        'readFileSync(require.resolve(包 id))',
        "readFileSync(require.resolve('@cindy/design-tokens/semantic/color.json'), 'utf8')",
      ],
      [
        '裸 require.resolve(包 id)',
        "const p = require.resolve('@cindy/design-tokens');",
      ],
    ];
    for (const [name, source] of idCases) {
      expect(containsRuntimeImportOfDesignTokens(source), name).toBe(true);
    }
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
