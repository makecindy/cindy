import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual sidebar callbacks without mounting its unrelated stores.
const source = ts.createSourceFile('sidebar.tsx', readFileSync(resolve(process.cwd(),
  'src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name: string, bindings: Record<string, unknown>, callbackSource = source) {
  let expression: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(callbackSource) === name && node.initializer && ts.isCallExpression(node.initializer)) {
      expression = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(callbackSource);
  if (!expression) throw new Error('Missing sidebar callback: ' + name);
  const js = ts.transpileModule('const callback = ' + expression.getText(callbackSource), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(bindings), js + '; return callback;')(...Object.values(bindings));
}

function harness(result: unknown, reject = false, sharedTaskId: string | undefined = 'share') {
  const account = reject ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result);
  const runSessionAction = vi.fn();
  const setConfirm = vi.fn();
  const toast = { error: vi.fn(), warning: vi.fn() };
  const session = { id: 'task', deviceLinkDeviceId: 'device-1' };
  const archiveBlockedByRunning = vi.fn(() => false);
  const preflight = vi.fn(async () => 'clean');
  const confirmDialog = vi.fn(async () => true);
  const bindings = {
    window: { electronAPI: { sharedTask: { account }, binding: { resolveSession: async () => ({ attached: false }) } } },
    toast, t: (key: string) => key, sharedTaskErrorKey: () => 'sharedTask.retry',
    sessionsById: new Map([['task', session]]), sessionsByIdRef: { current: new Map([['task', session]]) },
    runningSessionIds: new Set(), attachedSessionIdsRef: { current: new Set() },
    loadActiveBoundScheduleNames: async () => new Map(),
    isRemoteSessionWriteBlocked: () => false, resolveWorktreeRemovalPreflight: preflight,
    archiveBlockedByRunning, confirmDialog, archiveConfirmDescription: () => 'description',
    viewedSessionIdRef: { current: 'other' }, viewedSessionId: 'other',
    resolveSessionRemovalRedirect: vi.fn(), unarchiveSession: vi.fn(),
    runSessionAction: async (id: string, action: string, options: { prepareArchive?: (isCurrent: () => boolean) => Promise<boolean> }) => {
      if (options.prepareArchive && !(await options.prepareArchive(() => true))) return;
      const { prepareArchive: _, ...confirmedOptions } = options;
      runSessionAction(id, action, confirmedOptions);
    }, setConfirm, CONFIRM_INITIAL: { open: false },
  };
  const closeOwnedSharedTask = callback('closeOwnedSharedTask', bindings);
  return {
    account, runSessionAction, toast, setConfirm, archiveBlockedByRunning, preflight, confirmDialog,
    archive: () => callback('handleActionClick', { ...bindings, closeOwnedSharedTask })('task', 'archive', sharedTaskId),
    confirm: (action: string) => callback('handleConfirm', { ...bindings, closeOwnedSharedTask,
      confirm: { sessionId: 'task', action, sharedTaskId },
    })(),
  };
}

describe('sidebar shared-task archive/delete guard', () => {
  it.each(['clean', 'dirty', 'unknown'])('preserves sharing when a task starts during %s preflight or confirmation', async (preflight) => {
    const h = harness({ closed: ['share'] });
    const pending = deferred<string>();
    h.preflight.mockReturnValueOnce(pending.promise);
    const archive = h.archive();
    await vi.waitFor(() => expect(h.preflight).toHaveBeenCalled());
    if (preflight === 'clean') h.archiveBlockedByRunning.mockReturnValue(true);
    else h.confirmDialog.mockImplementationOnce(async () => {
      h.archiveBlockedByRunning.mockReturnValue(true);
      return true;
    });
    pending.resolve(preflight);
    await archive;
    if (preflight !== 'clean') {
      expect(h.confirmDialog).toHaveBeenCalledOnce();
    }
    expect(h.archiveBlockedByRunning).toHaveBeenLastCalledWith('task', 'device-1');
    expect(h.account).not.toHaveBeenCalled();
    expect(h.runSessionAction).not.toHaveBeenCalled();
  });
  it('keeps confirmed deletion independent from the archive running guard', async () => {
    const h = harness({ closed: ['share'] });
    h.archiveBlockedByRunning.mockReturnValue(true);
    await h.confirm('delete');
    expect(h.archiveBlockedByRunning).not.toHaveBeenCalled();
    expect(h.account).toHaveBeenCalledOnce();
    expect(h.runSessionAction).toHaveBeenCalledWith('task', 'delete', expect.anything());
  });
  it.each(['archive', 'confirmed-archive', 'delete'])('blocks %s on a resolved close failure', async (action) => {
    const h = harness({ closed: [], failed: [{ sharedTaskId: 'share' }] });
    if (action === 'delete') await h.confirm('delete');
    else {
      if (action === 'confirmed-archive') h.preflight.mockResolvedValueOnce('dirty');
      await h.archive();
    }
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('archive preserves the current task until preflight and confirmation finish', () => {
  // Unit regression, PR #6863 r4353787032: existing cases checked selection
  // and final state but missed the visible row while confirmation was pending.
  // Execute each production handler with a held decision; dirty/unknown and
  // schedule-bound inputs must stay hidden until cancel or a confirmed write.
  const entrypoints = [
    { name: 'sidebar', file: 'CCAgentSidebarUpper.tsx', handler: 'handleActionClick' },
    { name: 'header', file: 'SessionContentHeader.tsx', handler: 'handleArchive' },
    { name: 'hardware shortcut', file: 'lib/sessionHardwareTaskActions.ts', handler: 'archive' },
  ];

  function archiveHarness(entry: typeof entrypoints[number], scheduleNames: string[] = []) {
    const entrySource = ts.createSourceFile(entry.file, readFileSync(resolve(process.cwd(),
      'src/renderer/features/cc-agent', entry.file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const preflight = deferred<'clean' | 'dirty' | 'unknown'>();
    const decision = deferred<boolean>();
    const session = { id: 'task', deviceLinkDeviceId: 'device-1' };
    let selectedTask: string | null = 'task';
    let rowVisible = true;
    // Both the previous optimistic entry and the actual archive change selection.
    const leaveTask = () => { selectedTask = null; rowVisible = false; };
    const beginRemoteArchive = vi.fn(leaveTask);
    const runSessionAction = vi.fn((..._args: unknown[]) => leaveTask());
    const setConfirm = vi.fn();
    const confirmDialog = vi.fn(() => decision.promise);
    const archiveConfirmDescription = vi.fn(() => 'description');
    const resolvePreflight = vi.fn(() => preflight.promise);
    const attachment = vi.fn(async () => ({ attached: false }));
    const schedules = vi.fn(async () =>
      new Map(scheduleNames.length > 0 ? [['task', scheduleNames]] : []));
    const bindings = {
      window: { electronAPI: { binding: { resolveSession: attachment } } },
      toast: { error: vi.fn(), warning: vi.fn() }, t: (key: string) => key,
      sessionsById: new Map([['task', session]]), sessionsByIdRef: { current: new Map([['task', session]]) },
      runningSessionIds: new Set(), attachedSessionIdsRef: { current: new Set() },
      isRemoteSessionWriteBlocked: () => false, remoteWritesBlocked: false,
      resolveWorktreeRemovalPreflight: resolvePreflight,
      loadActiveBoundScheduleNames: schedules,
      archiveConfirmDescription,
      viewedSessionIdRef: { current: 'task' }, viewedSessionId: 'task',
      resolveSessionRemovalRedirect: vi.fn(), unarchiveSession: vi.fn(),
      runSessionAction: async (id: string, action: string, options: { prepareArchive?: (isCurrent: () => boolean) => Promise<boolean> }) => {
        rowVisible = false;
        if (options.prepareArchive && !(await options.prepareArchive(() => true))) {
          rowVisible = true;
          return;
        }
        const { prepareArchive: _, ...confirmedOptions } = options;
        runSessionAction(id, action, confirmedOptions);
      }, setConfirm, CONFIRM_INITIAL: { open: false },
      beginRemoteArchive, cancelRemoteArchive: vi.fn(),
      closeOwnedSharedTask: async () => true,
      archiveBlockedByRunning: () => false,
      confirm: { sessionId: 'task', action: 'archive' },
      session, sessionId: session.id, deviceLinkDeviceId: session.deviceLinkDeviceId,
      confirmDialog,
    };
    return {
      preflight, resolvePreflight, decision, runSessionAction, beginRemoteArchive, confirmDialog, archiveConfirmDescription,
      attachment, schedules,
      selected: () => selectedTask, visible: () => rowVisible,
      archive: () => callback(entry.handler, bindings, entrySource)('task', 'archive'),
      finish: async (confirmed: boolean) => { decision.resolve(confirmed); },
    };
  }

  // Unit: replaces the stale sidebar source-order assertions (CI #6863).
  // Holding both earlier checks makes a prematurely sampled clean worktree
  // observable; existing confirmation cases start after those checks settled.
  it('sidebar samples the worktree after attachment and schedule lookup settle', async () => {
    const h = archiveHarness(entrypoints[0]!);
    const attachment = deferred<{ attached: boolean }>();
    const schedules = deferred<Map<string, string[]>>();
    h.attachment.mockReturnValueOnce(attachment.promise);
    h.schedules.mockReturnValueOnce(schedules.promise);
    const pending = h.archive();
    expect(h.attachment).toHaveBeenCalled();
    expect(h.resolvePreflight).not.toHaveBeenCalled();
    attachment.resolve({ attached: false });
    await vi.waitFor(() => expect(h.schedules).toHaveBeenCalled());
    expect(h.resolvePreflight).not.toHaveBeenCalled();
    schedules.resolve(new Map());
    await vi.waitFor(() => expect(h.resolvePreflight).toHaveBeenCalled());
    h.preflight.resolve('clean');
    await pending;
    expect(h.confirmDialog).not.toHaveBeenCalled();
    expect(h.runSessionAction).toHaveBeenCalledWith('task', 'archive', { activeSessionId: 'task' });
  });

  for (const entry of entrypoints) {
    it.each(['clean', 'dirty', 'unknown'] as const)(entry.name + ' keeps selection during %s preflight and cancellation', async (preflight) => {
      const h = archiveHarness(entry);
      const pending = h.archive();
      // Allow the attachment check to settle while worktree preflight is still pending.
      await vi.waitFor(() => {
        expect(h.resolvePreflight).toHaveBeenCalledWith('task', 'device-1');
        expect(h.selected()).toBe('task');
        expect(h.visible()).toBe(false);
        expect(h.beginRemoteArchive).not.toHaveBeenCalled();
        expect(h.runSessionAction).not.toHaveBeenCalled();
      });
      h.preflight.resolve(preflight);
      if (preflight !== 'clean') {
        await vi.waitFor(() => {
          expect(h.confirmDialog).toHaveBeenCalled();
        });
        expect(h.archiveConfirmDescription).toHaveBeenCalledWith(expect.anything(),
          expect.objectContaining({ dirtyWorktree: preflight === 'dirty' }));
        expect(h.selected()).toBe('task');
        expect(h.visible()).toBe(false);
        expect(h.runSessionAction).not.toHaveBeenCalled();
        await h.finish(false);
      }
      await pending;
      expect(h.beginRemoteArchive).not.toHaveBeenCalled();
      if (preflight === 'clean') {
        expect(h.runSessionAction).toHaveBeenCalledWith('task', 'archive', { activeSessionId: 'task' });
        expect(h.selected()).toBeNull();
      } else {
        expect(h.runSessionAction).not.toHaveBeenCalled();
        expect(h.selected()).toBe('task');
        expect(h.visible()).toBe(true);
      }
    });

    it.each(['dirty', 'unknown'] as const)(entry.name + ' archives only after confirming %s', async (preflight) => {
      const h = archiveHarness(entry);
      const pending = h.archive();
      h.preflight.resolve(preflight);
      await vi.waitFor(() => {
        expect(h.confirmDialog).toHaveBeenCalled();
      });
      expect(h.selected()).toBe('task');
      expect(h.visible()).toBe(false);
      expect(h.runSessionAction).not.toHaveBeenCalled();
      await h.finish(true);
      await pending;
      expect(h.runSessionAction).toHaveBeenCalledTimes(1);
      expect(h.runSessionAction).toHaveBeenCalledWith('task', 'archive', expect.objectContaining({ activeSessionId: 'task' }));
      expect(h.selected()).toBeNull();
      expect(h.visible()).toBe(false);
    });

    it(entry.name + ' confirms a clean archive when the task has an active automation', async () => {
      const h = archiveHarness(entry, ['Daily report']);
      const pending = h.archive();
      h.preflight.resolve('clean');
      await vi.waitFor(() => {
        expect(h.confirmDialog).toHaveBeenCalled();
      });
      expect(h.archiveConfirmDescription).toHaveBeenCalledWith(expect.anything(),
        expect.objectContaining({ scheduleNames: ['Daily report'] }));
      expect(h.visible()).toBe(false);
      expect(h.runSessionAction).not.toHaveBeenCalled();
      await h.finish(false);
      await pending;
      expect(h.runSessionAction).not.toHaveBeenCalled();
      expect(h.selected()).toBe('task');
    });
  }
});
