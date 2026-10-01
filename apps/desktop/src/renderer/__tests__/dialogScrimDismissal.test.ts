/**
 * DESIGN.md §4 Dialog & Modal「Closing affordance」:模态弹窗点遮罩/窗口外部一律不关闭,
 * 只能用自身按钮或 Esc 关闭。Radix Dialog 默认点外部即关闭,所以每个 `Dialog.Content`
 * 都必须无条件 `preventDefault` 外部指针事件。AlertDialog 本身不响应外部点击,不在此列。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const RENDERER_ROOT = resolve(__dirname, '..');

// 已登记例外:点遮罩先弹二次确认,而不是直接关闭(DESIGN.md「Cindy Make preflight exception」)。
const EXEMPT_FILES = new Set(['components/cindy-make/CindyMakePreflightDialog.tsx']);

const OUTSIDE_HANDLERS = ['onPointerDownOutside', 'onInteractOutside'];

function rendererComponentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return entry.name === '__tests__' ? [] : rendererComponentFiles(path);
      }
      return /\.tsx$/.test(entry.name) && !/\.(?:test|spec)\.tsx$/.test(entry.name) ? [path] : [];
    })
    .sort();
}

// Radix 对 Content 的两个导出名(`Content` 与别名 `DialogContent`)。
const CONTENT_EXPORTS = new Set(['Content', 'DialogContent']);

/** 本文件里指向 Radix Dialog Content 的 JSX 标签:命名空间 `X.Content` 或具名导入(含 as 别名)。 */
function dialogContentTags(sourceFile: ts.SourceFile): (tag: string) => boolean {
  const namespaces = new Set<string>();
  const named = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if ((statement.moduleSpecifier as ts.StringLiteral).text !== '@radix-ui/react-dialog') continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (CONTENT_EXPORTS.has((element.propertyName ?? element.name).text)) {
          named.add(element.name.text);
        }
      }
    }
  }
  return (tag) => {
    const [head, member, ...rest] = tag.split('.');
    if (rest.length) return false;
    return member === undefined
      ? named.has(head)
      : namespaces.has(head) && CONTENT_EXPORTS.has(member);
  };
}

/** `(e) => e.preventDefault()` 或只含这一句的函数体。 */
function alwaysPreventsDefault(attribute: ts.JsxAttribute): boolean {
  const initializer = attribute.initializer;
  if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) return false;
  const fn = initializer.expression;
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  const body = fn.body;
  const expression = ts.isBlock(body)
    ? body.statements.length === 1 && ts.isExpressionStatement(body.statements[0])
      ? body.statements[0].expression
      : undefined
    : body;
  return (
    !!expression &&
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'preventDefault'
  );
}

function unguardedDialogContents(label: string, source: string): string[] {
  if (!source.includes('@radix-ui/react-dialog')) return [];
  const sourceFile = ts.createSourceFile(
    label,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const isDialogContent = dialogContentTags(sourceFile);
  const offenders: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (isDialogContent(node.tagName.getText(sourceFile))) {
        const guarded = node.attributes.properties.some(
          (property) =>
            ts.isJsxAttribute(property) &&
            OUTSIDE_HANDLERS.includes(property.name.getText(sourceFile)) &&
            alwaysPreventsDefault(property),
        );
        if (!guarded) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          offenders.push(`${label}:${line + 1}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return offenders;
}

function rendererLabel(path: string): string {
  return relative(RENDERER_ROOT, path).replaceAll('\\', '/');
}

describe('dialog scrim dismissal', () => {
  it('every Radix Dialog.Content ignores clicks outside the dialog', () => {
    const offenders = rendererComponentFiles(RENDERER_ROOT)
      .filter((path) => !EXEMPT_FILES.has(rendererLabel(path)))
      .flatMap((path) => unguardedDialogContents(rendererLabel(path), readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('still recognizes the exempt preflight dialog as a Dialog.Content user', () => {
    const exempt = resolve(RENDERER_ROOT, 'components/cindy-make/CindyMakePreflightDialog.tsx');
    expect(unguardedDialogContents('exempt', readFileSync(exempt, 'utf8')).length).toBeGreaterThan(
      0,
    );
  });

  it.each([
    ['namespace import', "import * as D from '@radix-ui/react-dialog';", 'D.Content'],
    ['named import', "import { Content } from '@radix-ui/react-dialog';", 'Content'],
    ['aliased import', "import { Content as Panel } from '@radix-ui/react-dialog';", 'Panel'],
    [
      'DialogContent alias',
      "import { DialogContent } from '@radix-ui/react-dialog';",
      'DialogContent',
    ],
  ])('flags an unguarded Content via %s and accepts the guarded one', (_, importLine, tag) => {
    const fixture = (props: string) =>
      `${importLine}\nexport const X = () => <${tag}${props} />;\n`;
    expect(unguardedDialogContents('fixture', fixture(''))).toEqual(['fixture:2']);
    expect(
      unguardedDialogContents(
        'fixture',
        fixture(' onPointerDownOutside={(e) => e.preventDefault()}'),
      ),
    ).toEqual([]);
    expect(
      unguardedDialogContents(
        'fixture',
        fixture(' onPointerDownOutside={(e) => { if (busy) e.preventDefault(); }}'),
      ),
    ).toEqual(['fixture:2']);
  });
});
