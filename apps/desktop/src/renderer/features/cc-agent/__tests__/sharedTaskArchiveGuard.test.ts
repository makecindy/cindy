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
    confirmRemoteArchiveRef: { current: null }, beginRemoteArchive: vi.fn(), cancelRemoteArchive: vi.fn(),
    replaceConfirmRemoteArchive: vi.fn(),
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

describe('sidebar remote archive hides the row before the worktree preflight', () => {
  function remoteHarness(preflight: 'clean' | 'dirty' | 'unknown') {
    const token = { deviceId: 'device-1', sessionId: 'task', status: 'archived' };
    const order: string[] = [];
    const runSessionAction = vi.fn();
    const setConfirm = vi.fn();
    const beginRemoteArchive = vi.fn(() => { order.push('begin'); return token; });
    const cancelRemoteArchive = vi.fn();
    const confirmRemoteArchiveRef = { current: null as unknown };
    const replaceConfirmRemoteArchive = callback('replaceConfirmRemoteArchive', {
      confirmRemoteArchiveRef, cancelRemoteArchive,
    });
    const session = { id: 'task', deviceLinkDeviceId: 'device-1' };
    const bindings = {
      window: { electronAPI: { sharedTask: { account: vi.fn() }, binding: { resolveSession: async () => ({ attached: false }) } } },
      toast: { error: vi.fn(), warning: vi.fn() }, t: (key: string) => key, sharedTaskErrorKey: () => 'sharedTask.retry',
      sessionsById: new Map([['task', session]]), sessionsByIdRef: { current: new Map([['task', session]]) },
      runningSessionIds: new Set(), attachedSessionIdsRef: { current: new Set() },
      isRemoteSessionWriteBlocked: () => false,
      resolveWorktreeRemovalPreflight: async () => { order.push('preflight'); return preflight; },
      viewedSessionIdRef: { current: 'task' }, viewedSessionId: 'task',
      resolveSessionRemovalRedirect: vi.fn(), unarchiveSession: vi.fn(),
      runSessionAction, setConfirm, CONFIRM_INITIAL: { open: false },
      confirmRemoteArchiveRef, beginRemoteArchive, cancelRemoteArchive, replaceConfirmRemoteArchive,
      closeOwnedSharedTask: async () => true,
      confirm: { sessionId: 'task', action: 'archive' },
    };
    return {
      token, order, runSessionAction, setConfirm, beginRemoteArchive, cancelRemoteArchive, confirmRemoteArchiveRef,
      archive: () => callback('handleActionClick', bindings)('task', 'archive'),
      confirm: () => callback('handleConfirm', bindings)(),
      cancel: () => callback('handleCancelConfirm', bindings)(),
    };
  }

  it('reuses the same overlay for a clean preflight', async () => {
    const h = remoteHarness('clean');
    await h.archive();
    expect(h.order).toEqual(['begin', 'preflight']);
    expect(h.beginRemoteArchive).toHaveBeenCalledWith('task', 'device-1', 'task');
    expect(h.runSessionAction).toHaveBeenCalledWith('task', 'archive', {
      activeSessionId: 'task',
      remoteArchiveToken: h.token,
    });
    expect(h.cancelRemoteArchive).not.toHaveBeenCalled();
  });

  it.each(['dirty', 'unknown'] as const)('restores the row when a %s preflight is cancelled', async (preflight) => {
    const h = remoteHarness(preflight);
    await h.archive();
    expect(h.order).toEqual(['begin', 'preflight']);
    expect(h.setConfirm).toHaveBeenCalledWith(expect.objectContaining({ open: true, action: 'archive' }));
    expect(h.confirmRemoteArchiveRef.current).toBe(h.token);
    expect(h.runSessionAction).not.toHaveBeenCalled();

    h.cancel();
    expect(h.cancelRemoteArchive).toHaveBeenCalledWith(h.token);
    expect(h.confirmRemoteArchiveRef.current).toBeNull();
  });

  it('claims the hidden row on confirm so the dialog closing does not roll it back', async () => {
    const h = remoteHarness('dirty');
    await h.archive();
    const confirmed = h.confirm();
    // Radix 在确认按钮 onClick 之后同步触发 onOpenChange(false) → handleCancelConfirm。
    h.cancel();
    await confirmed;
    expect(h.cancelRemoteArchive).not.toHaveBeenCalled();
    expect(h.beginRemoteArchive).toHaveBeenCalledTimes(1);
    expect(h.runSessionAction).toHaveBeenCalledWith('task', 'archive', expect.objectContaining({
      remoteArchiveToken: h.token,
    }));
  });

  it('restores an earlier hidden row when a later confirm dialog replaces it', async () => {
    const h = remoteHarness('dirty');
    await h.archive();
    const later = { ...h.token, sessionId: 'later' };
    h.beginRemoteArchive.mockImplementationOnce(() => later);
    await h.archive();
    // 第一次的确认框已被顶替,它隐藏的行没有入口可取消 —— 先回到列表。
    expect(h.cancelRemoteArchive).toHaveBeenCalledTimes(1);
    expect(h.cancelRemoteArchive).toHaveBeenCalledWith(h.token);
    expect(h.confirmRemoteArchiveRef.current).toBe(later);

    h.cancel();
    expect(h.cancelRemoteArchive).toHaveBeenLastCalledWith(later);
  });
});
