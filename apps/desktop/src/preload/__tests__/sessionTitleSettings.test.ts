import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../preload.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('preload.ts', source, ts.ScriptTarget.Latest, true);
const methodNames = [
  'getSessionTitleSettings',
  'setSessionTitleSettings',
  'resetSessionTitleSettings',
  'retitleRecentSessions',
] as const;

function createBridge(ipcRenderer: { invoke: ReturnType<typeof vi.fn> }) {
  const methods: ts.PropertyAssignment[] = [];
  const collect = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      methodNames.some((name) => name === node.name.getText(parsed))
    ) {
      methods.push(node);
    }
    ts.forEachChild(node, collect);
  };
  collect(parsed);
  expect(methods).toHaveLength(methodNames.length);
  const compiled = ts.transpileModule(
    'const bridge = { ' + methods.map((method) => method.getText(parsed)).join(',') + ' };',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  return new Function('ipcRenderer', compiled + '\nreturn bridge;')(ipcRenderer) as Pick<
    Window['electronAPI']['maker'],
    (typeof methodNames)[number]
  >;
}

describe('session title settings preload bridge', () => {
  it('exposes the API names used by the settings component and invokes their IPC channels', async () => {
    const settings = { style: 'goal-summary', language: 'zh-TW' } as const;
    const ipcRenderer = { invoke: vi.fn(async () => settings) };
    const bridge = createBridge(ipcRenderer);

    await bridge.getSessionTitleSettings();
    await bridge.setSessionTitleSettings(settings);
    await bridge.resetSessionTitleSettings();
    await bridge.retitleRecentSessions(7);

    expect(ipcRenderer.invoke.mock.calls).toEqual([
      ['maker:session-title-settings:get'],
      ['maker:session-title-settings:set', settings],
      ['maker:session-title-settings:reset'],
      ['maker:retitle-recent-sessions', 7],
    ]);
  });
});
