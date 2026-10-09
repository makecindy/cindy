import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function loadResolvePanelMedia(invoke: ReturnType<typeof vi.fn>, filename = 'preload.ts', method = 'resolvePanelMedia') {
  const source = fs.readFileSync(new URL('../' + filename, import.meta.url), 'utf8');
  const ast = ts.createSourceFile('preload.ts', source, ts.ScriptTarget.Latest, true);
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'ghosts' && ts.isObjectLiteralExpression(node.initializer)) {
      const property = node.initializer.properties.find((candidate) =>
        ts.isPropertyAssignment(candidate) && candidate.name.getText(ast) === method);
      if (property && ts.isPropertyAssignment(property)) initializer = property.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!initializer) throw new Error(method + ' bridge not found');
  const compiled = ts.transpileModule('const resolvePanelMedia = ' + initializer.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function('ipcRenderer', 'mutationErrorForGhostPanel', compiled + '\nreturn resolvePanelMedia;')({ invoke }, () => null) as
    (...args: unknown[]) => Promise<unknown>;
}

describe('Ghost panel media IPC bridge', () => {
  it('declares the optional instance in the renderer API contract', () => {
    const source = fs.readFileSync(new URL('../../renderer/vite-env.d.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('vite-env.d.ts', source, ts.ScriptTarget.Latest, true);
    let signature: ts.FunctionTypeNode | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isPropertySignature(node) && node.name.getText(ast) === 'resolvePanelMedia'
        && node.type && ts.isFunctionTypeNode(node.type)) {
        signature = node.type;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(signature).toBeDefined();
    expect(signature?.parameters).toHaveLength(4);
    const instance = signature?.parameters[2];
    expect(instance?.name.getText(ast)).toBe('instanceId');
    expect(instance?.questionToken).toBeDefined();
    expect(instance?.type?.kind).toBe(ts.SyntaxKind.StringKeyword);
    const sourceToken = signature?.parameters[3];
    expect(sourceToken?.name.getText(ast)).toBe('sourceToken');
    expect(sourceToken?.questionToken).toBeDefined();
    expect(sourceToken?.type?.kind).toBe(ts.SyntaxKind.StringKeyword);
  });

});

describe.each(['preload.ts', 'ghostPanelWindowPreload.ts', 'sidebarWindowPreload.ts'])('%s media bridge', (filename) => {
  it('forwards the confirmed install approval while preserving calls without it', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const setEnabled = loadResolvePanelMedia(invoke, filename, 'setEnabled');
    for (const approval of [undefined, 'approved:00000000-0000-4000-8000-000000000001']) {
      await setEnabled('helper', false, approval);
      expect(invoke).toHaveBeenLastCalledWith('ghosts:set-enabled', 'helper', false, approval);
    }
  });
  it('retains the legacy argument layout', async () => {
    const result = { url: 'cindy-media://blobs/image.png' };
    const invoke = vi.fn().mockResolvedValue(result);
    expect(await loadResolvePanelMedia(invoke, filename)('cindy-ghost://helper/media/image.png')).toBe(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'ghosts:resolve-panel-media', 'cindy-ghost://helper/media/image.png', undefined,
    );
  });

  it.each(['menu', 'attach'] as const)('forwards the physical instance for %s', async (purpose) => {
    const invoke = vi.fn().mockResolvedValue({});
    await loadResolvePanelMedia(invoke, filename)('cindy-ghost://helper/media/image.png', purpose, '_ns__acme__helper');
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'ghosts:resolve-panel-media', 'cindy-ghost://helper/media/image.png', purpose, '_ns__acme__helper',
    );
  });

  it('forwards the opaque drag source without declaring an instance', async () => {
    const invoke = vi.fn().mockResolvedValue({});
    await loadResolvePanelMedia(invoke, filename)('cindy-ghost://helper/preview/image.png', 'attach', undefined, 'opaque-source');
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'ghosts:resolve-panel-media', 'cindy-ghost://helper/preview/image.png', 'attach', undefined, 'opaque-source',
    );
  });
});
