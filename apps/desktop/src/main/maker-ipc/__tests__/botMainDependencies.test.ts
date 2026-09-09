import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const files = ['localDb/ipc/bots.ts', 'maker-ipc/botInvitation.ts'];
function parse(file: string) {
  return ts.createSourceFile(file, readFileSync(resolve(__dirname, '../..', file), 'utf8'),
    ts.ScriptTarget.Latest, true);
}

describe('Bot Main dependency assembly', () => {
  it.each(files)('%s uses no runtime import expressions', (file) => {
    const dynamicImports: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
        dynamicImports.push(node.getText());
      ts.forEachChild(node, visit);
    }
    visit(parse(file));
    expect(dynamicImports).toEqual([]);
  });

  it('injects reverse IPC operations instead of importing the Bot IPC registry from its worker', () => {
    const imports = parse('maker-ipc/botInvitation.ts').statements
      .filter(ts.isImportDeclaration)
      .map((node) => (node.moduleSpecifier as ts.StringLiteral).text);
    expect(imports.some((path) => /localDb\/ipc\/bots(?:\.js)?$/.test(path))).toBe(false);
  });
});
