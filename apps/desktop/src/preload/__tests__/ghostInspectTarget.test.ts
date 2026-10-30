import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function inspectBridge(invoke: ReturnType<typeof vi.fn>) {
  const source = fs.readFileSync(new URL('../preload.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('preload.ts', source, ts.ScriptTarget.Latest, true);
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(ast) === 'inspect' &&
      node.initializer.getText(ast).includes('ghosts:inspect')
    )
      initializer = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!initializer) throw new Error('Ghost inspect bridge missing');
  const compiled = ts.transpileModule('const inspect = ' + initializer.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function('ipcRenderer', compiled + ';return inspect;')({ invoke }) as (
    path: string,
    target?: { expectedInstalledInstanceId: string; expectedInstalledApproval: string },
  ) => Promise<unknown>;
}

describe('Ghost inspect receiver bridge', () => {
  it('preserves a legacy one-argument call', async () => {
    const invoke = vi.fn();
    await inspectBridge(invoke)('/tmp/plugin.cindy');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('ghosts:inspect', '/tmp/plugin.cindy');
  });

  it('forwards the exact instance and receipt token, not a privilege flag', async () => {
    const invoke = vi.fn();
    const target = {
      expectedInstalledInstanceId: '_ns__xd__helper',
      expectedInstalledApproval: 'approved:receipt',
    };
    await inspectBridge(invoke)('/tmp/plugin.cindy', target);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('ghosts:inspect', '/tmp/plugin.cindy', target);
  });
});
