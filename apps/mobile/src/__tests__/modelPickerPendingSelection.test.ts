import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

// Exercise the production wrapper without loading native view dependencies.
function picker() {
  const source = ts.createSourceFile('ModelPickerSheet.tsx', readFileSync(
    resolve(process.cwd(), 'src/session/ModelPickerSheet.tsx'), 'utf8',
  ), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'ModelPickerSheet')!;
  const js = ts.transpileModule(fn.getText(source).replace('export function', 'function'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function('React', 'UnifiedModelPickerSheet', 'LegacyModelPickerSheet',
    `${js}; return ModelPickerSheet;`)(
    { createElement: (type: string, props: unknown) => ({ type, props }) }, 'unified', 'legacy',
  );
}

it('keeps pending Pi selection and capabilities together while preserving Claude runtime separately', () => {
  const currentSelection = {
    agentKind: 'claude-code', activeModelId: 'claude', selectedProviderId: 'claude-account',
    selectedEffort: 'low', selectedFastMode: false,
  };
  const props = {
    agentKind: 'pi', activeModelId: 'pi-model', selectedProviderId: 'pi-account',
    selectedEffort: 'high', selectedFastMode: true, capabilities: { hasFastMode: true },
    unified: { currentSelection },
  };
  const result = picker()(props);
  expect(result.type).toBe('unified');
  expect(result.props).toEqual(props);
  expect(result.props.unified.currentSelection).toBe(currentSelection);
});

it('preserves draft selection and the unsupported-host fallback', () => {
  const props = { agentKind: 'codex', activeModelId: 'model', unified: {} };
  expect(picker()(props)).toEqual({ type: 'unified', props });
  const unsupported = { ...props, providersUnsupported: true };
  expect(picker()(unsupported)).toEqual({ type: 'legacy', props: unsupported });
});
