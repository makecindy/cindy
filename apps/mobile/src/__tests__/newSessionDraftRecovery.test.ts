import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { DEFAULT_NEW_SESSION_DRAFT } from '../session/newSession';

// Exercise the actual screen callback without loading native UI modules.
const source = ts.createSourceFile('new.tsx', readFileSync(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function fixture() {
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'restoreCreationDraft') expression = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!expression) throw new Error('Missing draft recovery callback');
  const state = { draft: { ...DEFAULT_NEW_SESSION_DRAFT }, selection: { start: 0, end: 0 }, plan: false, files: [] as unknown[] };
  const bindings = {
    useCallback: (fn: unknown) => fn,
    userTouchedWorkspaceRef: { current: false }, userTouchedRuntimeRef: { current: false },
    appliedPermissionMemoryRef: { current: false }, runtimeActionSeqRef: { current: 10 },
    firstMessageRef: { current: '' }, firstMessageSelectionRef: { current: state.selection },
    attachmentsRef: { current: state.files }, prePlanPermissionModeRef: { current: null as string | null },
    setFirstMessageSelection: (value: typeof state.selection) => { state.selection = value; },
    setAttachments: (value: unknown[]) => { state.files = value; },
    setPlanModeDraftOn: (value: boolean) => { state.plan = value; },
    setDraft: vi.fn((value: typeof state.draft) => { state.draft = value; }),
  };
  const compiled = ts.transpileModule(`const apply = ${expression.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const apply = new Function(...Object.keys(bindings), `${compiled}\nreturn apply;`)(...Object.values(bindings));
  return { ...bindings, state, apply };
}

it.each([true, false])('restores Plan=%s and makes recovered text immediately available to composer actions', (enabled) => {
  const f = fixture();
  const draft = { ...DEFAULT_NEW_SESSION_DRAFT, firstMessage: 'Recovered message', model: 'saved-model', permissionMode: 'ask' };
  const files = [{ id: 'saved-file' }];
  f.apply(draft, files, { enabled, restorePermissionMode: 'ask' });
  // Slash/mention/voice actions read these refs before another text-change event.
  const caret = f.firstMessageSelectionRef.current.end;
  const edited = f.firstMessageRef.current.slice(0, caret) + ' appended' + f.firstMessageRef.current.slice(caret);
  expect(edited).toBe('Recovered message appended');
  expect(f.state.selection).toEqual({ start: draft.firstMessage.length, end: draft.firstMessage.length });
  expect(f.state.plan).toBe(enabled);
  expect(f.prePlanPermissionModeRef.current).toBe('ask');
  expect(f.state.draft).toEqual(draft);
  expect(f.attachmentsRef.current).toBe(files);
  expect(f.state.files).toBe(files);
  expect(f.userTouchedWorkspaceRef.current && f.userTouchedRuntimeRef.current && f.appliedPermissionMemoryRef.current).toBe(true);
  // A previously captured runtime preference continuation is now stale.
  expect(f.runtimeActionSeqRef.current).not.toBe(10);
});

it('uses the same text recovery without inventing a Plan snapshot for legacy stashes', () => {
  const f = fixture();
  f.state.plan = true;
  f.apply({ ...DEFAULT_NEW_SESSION_DRAFT, firstMessage: 'legacy draft' }, []);
  expect(f.firstMessageRef.current).toBe('legacy draft');
  expect(f.state.plan).toBe(true);
});
