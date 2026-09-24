import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual sidebar callbacks without mounting its unrelated stores.
const source = ts.createSourceFile('sidebar.tsx', readFileSync(resolve(process.cwd(),
  'src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name: string, bindings: Record<string, unknown>) {
  let expression: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) {
      expression = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!expression) throw new Error('Missing sidebar callback: ' + name);
  const js = ts.transpileModule('const callback = ' + expression.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(bindings), js + '; return callback;')(...Object.values(bindings));
}

function harness(result: unknown, reject = false, sharedTaskId: string | undefined = 'share') {
  const account = reject ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result);
  const runSessionAction = vi.fn();
  const setConfirm = vi.fn();
  const toast = { error: vi.fn(), warning: vi.fn() };
  const session = { id: 'task' };
  const bindings = {
    window: { electronAPI: { sharedTask: { account }, binding: { resolveSession: async () => ({ attached: false }) } } },
    toast, t: (key: string) => key, sharedTaskErrorKey: () => 'sharedTask.retry',
    sessionsById: new Map([['task', session]]), sessionsByIdRef: { current: new Map([['task', session]]) },
    runningSessionIds: new Set(), attachedSessionIdsRef: { current: new Set() },
    isRemoteSessionWriteBlocked: () => false, resolveWorktreeRemovalPreflight: async () => 'clean',
    viewedSessionIdRef: { current: 'other' }, viewedSessionId: 'other',
    resolveSessionRemovalRedirect: vi.fn(), unarchiveSession: vi.fn(),
    runSessionAction, setConfirm, CONFIRM_INITIAL: { open: false },
  };
  const closeOwnedSharedTask = callback('closeOwnedSharedTask', bindings);
  return {
    account, runSessionAction, toast, setConfirm,
    archive: () => callback('handleActionClick', { ...bindings, closeOwnedSharedTask })('task', 'archive', sharedTaskId),
    confirm: (action: string) => callback('handleConfirm', { ...bindings, closeOwnedSharedTask,
      confirm: { sessionId: 'task', action, sharedTaskId },
    })(),
  };
}

describe('sidebar shared-task archive/delete guard', () => {
  it.each(['archive', 'confirmed-archive', 'delete'])('blocks %s on a resolved close failure', async (action) => {
    const h = harness({ closed: [], failed: [{ sharedTaskId: 'share' }] });
    if (action === 'archive') await h.archive();
    else await h.confirm(action === 'delete' ? 'delete' : 'archive');
    expect(h.runSessionAction).not.toHaveBeenCalled();
    expect(h.setConfirm).not.toHaveBeenCalled();
    expect(h.toast.error).toHaveBeenCalledWith('sharedTask.closeFailedToast');
  });
  it.each([undefined, {}, { closed: ['other'], failed: [] }])('fails closed for an invalid or unrelated result %j', async (result) => {
    const h = harness(result);
    await h.archive();
    expect(h.runSessionAction).not.toHaveBeenCalled();
  });
  it('blocks both paths when close rejects', async () => {
    const h = harness(new Error('offline'), true);
    await h.archive(); await h.confirm('delete');
    expect(h.runSessionAction).not.toHaveBeenCalled();
    expect(h.toast.error).toHaveBeenCalledWith('sharedTask.retry');
  });
  it('allows archive and confirmed delete only after the requested share closes', async () => {
    const h = harness({ closed: ['share'], failed: [] });
    await h.archive(); await h.confirm('delete');
    expect(h.account).toHaveBeenCalledWith({ action: 'close', sharedTaskId: 'share' });
    expect(h.runSessionAction.mock.calls.map((call) => call[1])).toEqual(['archive', 'delete']);
    expect(h.toast.error).not.toHaveBeenCalled();
  });
  it('does not close any share for an ordinary task', async () => {
    const h = harness(undefined, false, '');
    await h.archive(); await h.confirm('delete');
    expect(h.account).not.toHaveBeenCalled();
    expect(h.runSessionAction).toHaveBeenCalledTimes(2);
  });
});
