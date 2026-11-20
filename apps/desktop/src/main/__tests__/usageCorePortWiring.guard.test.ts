/**
 * 用量核心与端口的接线（guard 层）。
 *
 * 3b、3c 把四个用量广播模块和五个回合记录模块搬成不带 Electron 的核心（`*Core.ts`），由 Node Host
 * 与桌面共用。核心从两个端口模块（`usageBroadcastPorts.ts`、`maker-ipc/turnUsagePorts.ts`）取进程相关
 * 的函数；桌面在原路径留一个包装，用原来的 import 绑上这些端口，再 `export *` 核心。下面几条静态契约
 * 保证桌面行为不变：
 *
 * 1. 桌面生产代码只经包装用核心：核心与端口模块只被自己的包装和同组核心导入；包装从端口模块只取
 *    绑定函数。直接导入核心的桌面文件拿到的是没绑端口的模块，用量写库与推送在桌面上悄悄失效。
 * 2. 核心（连同它导入的同组核心）从端口模块取的每个名字，都由它自己的包装绑上，或由这个包装导入的
 *    另一个包装绑上。少绑一处，桌面调到时抛错（turnUsagePorts）或静默拒绝（usageBroadcastPorts）。
 *    例：Pi 包装不再导入回执包装时，回执核心用的 broadcastSessionSpend 等没人绑。
 * 3. 包装为核心导入的每个同组核心，导入那个核心的包装，导入图与搬移前相同。
 * 4. 核心在模块加载时不调用端口：`export * from` 先求值核心，包装的绑定才运行，所以端口只能在
 *    函数体里调用；顶层的调用会在绑定之前调到空端口。顶层只取端口的引用（如 defaultDeps 里的
 *    `enqueue: enqueueDurableWrite`）没有问题：端口模块导出的是固定的转发函数，调用时才查已绑的实现。
 *
 * 测试价值
 * - 生产入口与可观察结果：桌面九个用量模块的导入图与端口绑定；失效时桌面的花费、用量写库或窗口
 *   推送不再发生，或调用时抛 "is not bound"。
 * - 规则依据：放行表一·13 的 3b、3c 裁定（桌面内嵌模式下行为零变化）；架构原则里桌面与 Host 共用
 *   业务主体的端口注入。
 * - 现有覆盖缺口：行为测试各自导入需要的包装，把缺的绑定补上了（例如 sessionEventPipeline 测试自己
 *   导入回执包装，去掉 Pi 包装对它的导入时仍是绿的）；没有测试读桌面全部生产文件的导入。
 * - 最小失败输入：某个桌面生产文件直接导入一个核心；Pi 包装去掉 `import './piUsageReceipts.js'`；
 *   任一包装删掉一处绑定；核心顶层引用一个端口。
 * - tier：guard。只读源码文本的跨文件静态契约，不经生产入口。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const desktopSrc = path.resolve(__dirname, '../..');
const main = path.join(desktopSrc, 'main');

interface Group {
  ports: string;
  bind: string;
  cores: string[];
}

const groups: Group[] = [
  {
    ports: 'usageBroadcastPorts.ts',
    bind: 'bindUsageBroadcastPorts',
    cores: [
      'sessionSpendBroadcasterCore.ts',
      'usageBroadcasterCore.ts',
      'turnCostBroadcasterCore.ts',
      'modelMismatchBroadcasterCore.ts',
    ],
  },
  {
    ports: 'maker-ipc/turnUsagePorts.ts',
    bind: 'bindTurnUsagePorts',
    cores: [
      'maker-ipc/sessionClaudeTurnUsageCore.ts',
      'maker-ipc/sessionCodexTurnUsageCore.ts',
      'maker-ipc/sessionPiTurnUsageCore.ts',
      'maker-ipc/turnUsageContextCore.ts',
      'maker-ipc/piUsageReceiptsCore.ts',
    ],
  },
];

const abs = (rel: string) => path.join(main, rel);
const wrapperOf = (core: string) => core.replace(/Core\.ts$/, '.ts');
const groupOfFile = new Map<string, Group>();
for (const group of groups) {
  groupOfFile.set(abs(group.ports), group);
  for (const core of group.cores) groupOfFile.set(abs(core), group);
}
const coreFiles = new Set(groups.flatMap(group => group.cores.map(abs)));
const portFiles = new Set(groups.map(group => abs(group.ports)));
const wrapperFiles = new Map(groups.flatMap(group => group.cores.map(core => [abs(wrapperOf(core)), group] as const)));

const parsed = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  let source = parsed.get(file);
  if (!source) {
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
    source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    parsed.set(file, source);
  }
  return source;
}

/** The file a relative specifier names, or null for a package or a file that is not TypeScript source. */
function resolve(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), specifier).replace(/\.(?:m?js|tsx?)$/, '');
  for (const ext of ['.ts', '.tsx', '.mts', '/index.ts']) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  return null;
}

interface Import {
  target: string;
  /** Value names it takes (`import { a, b as c }` gives a and b); `*` for a namespace or `export *`. */
  names: string[];
  /** Local name → imported name. */
  locals: Map<string, string>;
  line: number;
}

/** The runtime imports of a file: static imports and re-exports, and dynamic `import()`. Type-only ones are left out. */
function importsOf(file: string): Import[] {
  const source = parse(file);
  const out: Import[] = [];
  const add = (specifier: ts.Expression, names: string[], locals: Map<string, string>, at: ts.Node) => {
    if (!ts.isStringLiteralLike(specifier)) return;
    const target = resolve(file, specifier.text);
    if (target) out.push({ target, names, locals, line: source.getLineAndCharacterOfPosition(at.getStart(source)).line + 1 });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const names: string[] = [];
      const locals = new Map<string, string>();
      const clause = node.importClause;
      if (clause?.name) { names.push('default'); locals.set(clause.name.text, 'default'); }
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.push('*');
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue;
          const imported = (element.propertyName ?? element.name).text;
          names.push(imported);
          locals.set(element.name.text, imported);
        }
      }
      add(node.moduleSpecifier, names, locals, node);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      const clause = node.exportClause;
      const names = clause && ts.isNamedExports(clause)
        ? clause.elements.filter(element => !element.isTypeOnly).map(element => (element.propertyName ?? element.name).text)
        : ['*'];
      add(node.moduleSpecifier, names, new Map(), node);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
      add(node.arguments[0], ['*'], new Map(), node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/**
 * The desktop production files whose text names a core or a port module. A relative specifier that
 * reaches one of them contains its file name, so the files that do not are left unparsed.
 */
function productionFilesNaming(names: string[], dir = desktopSrc, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '__mocks__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) productionFilesNaming(names, full, out);
    else if (/\.(?:ts|tsx|mts)$/.test(entry.name) && !/\.(?:test|spec|bench)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      const text = fs.readFileSync(full, 'utf8');
      if (names.some(name => text.includes(name))) out.push(full);
    }
  }
  return out;
}

/** For a port module: each exported name → the port keys it delegates to (`ports.key` or `port('key')`). */
function portKeysByExport(portFile: string): Map<string, Set<string>> {
  const source = parse(portFile);
  const out = new Map<string, Set<string>>();
  const keysIn = (node: ts.Node) => {
    const keys = new Set<string>();
    const visit = (child: ts.Node) => {
      if (ts.isPropertyAccessExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'ports') {
        keys.add(child.name.text);
      }
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'port'
        && child.arguments[0] && ts.isStringLiteralLike(child.arguments[0])) {
        keys.add(child.arguments[0].text);
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return keys;
  };
  for (const statement of source.statements) {
    const exported = ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) out.set(statement.name.text, keysIn(statement));
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) out.set(declaration.name.text, keysIn(declaration));
      }
    }
  }
  return out;
}

/** The port keys a wrapper binds: the property names of the object passed to its group's bind function. */
function boundKeys(wrapper: string, bind: string): Set<string> {
  const keys = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === bind) {
      const arg = node.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const property of arg.properties) {
          if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) keys.add(property.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(wrapper));
  return keys;
}

/** Port module → the keys bound once `wrapper` has loaded: its own bindings and those of every wrapper it imports, transitively. */
function boundAfterLoading(wrapper: string, seen = new Set<string>(), out = new Map<string, Set<string>>()): Map<string, Set<string>> {
  if (seen.has(wrapper)) return out;
  seen.add(wrapper);
  const group = wrapperFiles.get(wrapper)!;
  const keys = out.get(abs(group.ports)) ?? new Set<string>();
  for (const key of boundKeys(wrapper, group.bind)) keys.add(key);
  out.set(abs(group.ports), keys);
  for (const imported of importsOf(wrapper)) {
    if (wrapperFiles.has(imported.target)) boundAfterLoading(imported.target, seen, out);
  }
  return out;
}

/** The cores a core runs with: itself and the cores it imports, transitively. */
function coresLoadedWith(core: string, out = new Set<string>()): Set<string> {
  if (out.has(core)) return out;
  out.add(core);
  for (const imported of importsOf(core)) {
    if (coreFiles.has(imported.target)) coresLoadedWith(imported.target, out);
  }
  return out;
}

const rel = (file: string) => path.relative(desktopSrc, file).split(path.sep).join('/');

/** Whether `id` is called where it stands: `id()`, `new id()`, `id\`\``, or a member of it is called (`id.m()`). */
function isCalled(id: ts.Identifier): boolean {
  const callee = (node: ts.Node) => (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) && node.parent.expression === node
    || ts.isTaggedTemplateExpression(node.parent) && node.parent.tag === node;
  if (callee(id)) return true;
  const member = id.parent;
  return (ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) && member.expression === id && callee(member);
}

describe('usage cores and their ports on the desktop', () => {
  it('only the wrappers and the sibling cores import a core or a port module; wrappers take only the bind function', () => {
    const violations: string[] = [];
    const names = [...groupOfFile.keys()].map(file => path.basename(file, '.ts'));
    for (const file of productionFilesNaming(names)) {
      for (const imported of importsOf(file)) {
        const group = groupOfFile.get(imported.target);
        if (!group) continue;
        const sibling = groupOfFile.get(file) === group && coreFiles.has(file);
        const ownWrapper = coreFiles.has(imported.target) && file === abs(wrapperOf(path.relative(main, imported.target)));
        const wrapperBind = portFiles.has(imported.target) && wrapperFiles.get(file) === group
          && imported.names.length === 1 && imported.names[0] === group.bind;
        if (!sibling && !ownWrapper && !wrapperBind) {
          violations.push(`${rel(file)}:${imported.line} imports ${rel(imported.target)} (${imported.names.join(', ') || 'side effect'})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('every port a core uses, with the cores it imports, is bound by its wrapper or a wrapper that wrapper imports', () => {
    const unbound: string[] = [];
    for (const group of groups) {
      for (const core of group.cores) {
        const bound = boundAfterLoading(abs(wrapperOf(core)));
        for (const loaded of coresLoadedWith(abs(core))) {
          for (const imported of importsOf(loaded)) {
            if (!portFiles.has(imported.target)) continue;
            const keysByExport = portKeysByExport(imported.target);
            for (const name of imported.names) {
              const keys = keysByExport.get(name);
              if (!keys) { unbound.push(`${rel(loaded)} imports ${name}, which ${rel(imported.target)} does not export as a port`); continue; }
              for (const key of keys) {
                if (!bound.get(imported.target)?.has(key)) {
                  unbound.push(`${wrapperOf(core)} loads ${rel(loaded)}, which uses ${key} from ${rel(imported.target)}; nothing it loads binds it`);
                }
              }
            }
          }
        }
      }
    }
    expect(unbound).toEqual([]);
  });

  it('a wrapper imports the wrapper of each sibling core its core imports', () => {
    const missing: string[] = [];
    for (const group of groups) {
      for (const core of group.cores) {
        const wrapperImports = new Set(importsOf(abs(wrapperOf(core))).map(imported => imported.target));
        for (const imported of importsOf(abs(core))) {
          if (!coreFiles.has(imported.target)) continue;
          const siblingWrapper = abs(wrapperOf(path.relative(main, imported.target)));
          if (!wrapperImports.has(siblingWrapper)) missing.push(`${wrapperOf(core)} does not import ${rel(siblingWrapper)}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('no core calls a port while its module loads', () => {
    const atLoad: string[] = [];
    for (const group of groups) {
      for (const core of group.cores) {
        const source = parse(abs(core));
        const portLocals = new Set<string>();
        for (const imported of importsOf(abs(core))) {
          if (portFiles.has(imported.target)) for (const local of imported.locals.keys()) portLocals.add(local);
        }
        const visit = (node: ts.Node, deferred: boolean) => {
          if (ts.isImportDeclaration(node) || ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
          const runsLater = deferred || ts.isFunctionLike(node);
          if (!runsLater && ts.isIdentifier(node) && portLocals.has(node.text) && isCalled(node)) {
            atLoad.push(`${core}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${node.text}`);
          }
          ts.forEachChild(node, child => visit(child, runsLater));
        };
        visit(source, false);
      }
    }
    expect(atLoad).toEqual([]);
  });
});
