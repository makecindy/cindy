import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);

export function createGhostProductionCallbacks<Result>(options: {
  functions?: string[];
  variables?: string[];
  callbacks?: Record<string, readonly [callee: string, channel?: string]>;
  initialize?: string;
  transformCallback?: (source: string) => string;
}): (deps: Record<string, unknown>) => Result {
  const { functions = [], variables = [], callbacks = {} } = options;
  const names = [...functions, ...variables, ...Object.keys(callbacks)];
  if (new Set(names).size !== names.length) throw new Error('Duplicate production export names');
  const declarations = new Map<string, string>();
  const record = (name: string, declaration: string) => {
    if (declarations.has(name)) throw new Error('Duplicate production declaration: ' + name);
    declarations.set(name, declaration);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && functions.includes(node.name.text)) {
      record(node.name.text, node.getText(ast).replace(/^export /, ''));
    }
    if (ts.isVariableDeclaration(node) && variables.includes(node.name.getText(ast))) {
      record(node.name.getText(ast), 'const ' + node.getText(ast) + ';');
    }
    if (ts.isCallExpression(node)) {
      for (const [name, [callee, channel]] of Object.entries(callbacks)) {
        if (node.expression.getText(ast) !== callee) continue;
        const firstArgument = node.arguments[0];
        if (channel !== undefined && (!firstArgument || !ts.isStringLiteral(firstArgument) ||
            firstArgument.text !== channel)) continue;
        const callback = node.arguments[channel === undefined ? 0 : 1];
        if (!callback) throw new Error('Production callback missing: ' + name);
        const text = callback.getText(ast);
        record(name, 'const ' + name + ' = ' + (options.transformCallback?.(text) ?? text) + ';');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const missing = names.filter((name) => !declarations.has(name));
  if (missing.length) throw new Error('Production declarations missing: ' + missing.join(', '));
  const compiled = ts.transpileModule(
    (options.initialize ?? '') + '\n' + [...declarations.values()].join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  return (deps) => new Function(
    'deps', 'const {' + Object.keys(deps).join(',') + '} = deps;' + compiled +
      ';return {' + names.join(',') + '};',
  )(deps) as Result;
}
