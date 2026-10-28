import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { isExplicitRemoteNotFoundError } from '@/session/newSessionWorktree';
import { createLatestWriteGuard, pickWriteFields, retryPatchWhileLatest, writeGuardFields } from '@/session/swipeRowRegistry';
import { createDisclosureController, commitRegisteredLevel, detachDisclosureScope, runDisclosure } from '@/session/listDisclosureController';

// Execute the production callbacks without mounting the entire native screen.
function callback(file: string, name: string, bindings: Record<string, unknown>) {
  const source = ts.createSourceFile(file, readFileSync(resolve(process.cwd(), file), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name
      && node.initializer && ts.isCallExpression(node.initializer)) {
      expression = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!expression) throw new Error(`Missing production callback ${name}`);
  const compiled = ts.transpileModule(`const fn = ${expression.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(bindings), `${compiled}; return fn;`)(...Object.values(bindings));
}

const session = { id: 's1', status: 'active', deviceLinkDeviceId: 'shard', deviceLinkDeviceName: 'PC' };
function fixture() {
  let reject!: (error: Error) => void;
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done, fail) => { resolve = done; reject = fail; });
  const store = {
    applySessionPatch: vi.fn(), upsertDeviceSession: vi.fn(), requestReseed: vi.fn(),
    beginSessionListRemovalPreview: vi.fn(() => vi.fn()),
    getSessions: () => [session],
  };
  const release = vi.fn();
  const isLatest = vi.fn(() => true);
  const bindings = {
    currentSession: session, deviceId: 'rpc', sessionId: session.id, preferredRpcDeviceId: 'rpc',
    resolveSessionWriteDevices: () => ({ rpcDeviceId: 'rpc', shardId: 'shard' }),
    sessionMetaWriteGuard: { begin: () => ({ isLatest }) },
    sessionMetaWriteQueue: { enqueue: vi.fn(() => pending) },
    sessionPendingWrites: { track: () => release, consumeMaskedPush: () => false },
    remoteSessionStore: store, isExplicitRemoteNotFoundError, pickWriteFields, writeGuardFields,
    goBackToHome: vi.fn(), Alert: { alert: vi.fn() }, humanizeRemoteError: String,
    animateListChange: undefined, t: (key: string) => key,
    withNewSessionCreationRemoval: (_sid: string, _device: string, _status: string, remove: () => Promise<unknown>) => remove(),
  };
  Object.assign(bindings, {
    patchSessionFromList: callback('src/session/useSessionListActions.ts', 'patchSession', bindings),
    sessionSubscriptionIdentity: 'page', sessionSubscriptionIdentityRef: { current: 'page' },
  });
  return { bindings, resolve, reject, store, release, isLatest };
}
const gone = () => new Error('[NOT_FOUND] Session does not exist');
const tick = () => new Promise((done) => setTimeout(done, 0));

describe('orphan task status actions', () => {
  // Unit, PR #6863 r4353910575: the detail menu used to perform confirmation
  // outside the list transaction. Existing list tests missed that entrypoint.
  // Holding its decision must hide the list, retain detail, and navigate only
  // after confirmation; cancellation, a newer status, or leaving the page must
  // release the preview without writing or restoring an old metadata snapshot.
  it.each(['confirm', 'cancel', 'superseded', 'left-page', 'fail'] as const)(
    'detail archive shares the list transaction during %s', async (outcome) => {
      const f = fixture();
      const identityRef = { current: 'page' as string | null };
      const patchSessionFromList = callback('src/session/useSessionListActions.ts', 'patchSession', f.bindings);
      const patchDetail = callback('app/sessions/[sessionId].tsx', 'patchSessionMeta', {
        ...f.bindings, patchSessionFromList,
        sessionSubscriptionIdentity: 'page', sessionSubscriptionIdentityRef: identityRef,
      });
      let decide!: (ok: boolean) => void;
      const decision = new Promise<boolean>(resolve => { decide = resolve; });
      const request = patchDetail({ status: 'archived' }, () => decision);
      expect(f.store.beginSessionListRemovalPreview).toHaveBeenCalledWith('s1');
      expect(f.store.applySessionPatch).not.toHaveBeenCalled();
      expect(f.bindings.goBackToHome).not.toHaveBeenCalled();
      if (outcome === 'superseded') f.isLatest.mockReturnValue(false);
      if (outcome === 'left-page') identityRef.current = null;
      decide(outcome !== 'cancel');
      if (outcome === 'confirm' || outcome === 'fail') {
        await vi.waitFor(() => expect(f.bindings.sessionMetaWriteQueue.enqueue).toHaveBeenCalledOnce());
        expect(f.bindings.goBackToHome).toHaveBeenCalledOnce();
        if (outcome === 'fail') f.reject(new Error('offline'));
        else f.resolve({ ...session, status: 'archived' });
      }
      await request;
      expect(f.store.beginSessionListRemovalPreview.mock.results[0].value).toHaveBeenCalledOnce();
      if (outcome === 'fail') {
        expect(f.store.upsertDeviceSession).toHaveBeenCalledWith('shard', 'PC', session);
        expect(f.bindings.Alert.alert).toHaveBeenCalled();
      } else {
        expect(f.store.upsertDeviceSession).not.toHaveBeenCalled();
        expect(f.bindings.Alert.alert).not.toHaveBeenCalled();
      }
      if (!['confirm', 'fail'].includes(outcome)) {
        expect(f.bindings.sessionMetaWriteQueue.enqueue).not.toHaveBeenCalled();
        expect(f.bindings.goBackToHome).not.toHaveBeenCalled();
      }
    },
  );

  // Unit regression: archive must leave the list while its remote schedule
  // lookup is pending, without committing before confirmation. Existing cases
  // exercised only the RPC result, not the pre-write wait/cancel boundary.
  it.each(['cancel', 'superseded', 'fail'] as const)('optimistic archive handles preflight %s', async (outcome) => {
    const f = fixture();
    let finish!: (confirmed: boolean) => void;
    let fail!: (error: Error) => void;
    const preparation = new Promise<boolean>((resolve, reject) => { finish = resolve; fail = reject; });
    const patch = callback('src/session/useSessionListActions.ts', 'patchSession', f.bindings);
    const request = patch(session, { status: 'archived' }, () => preparation);
    expect(f.store.beginSessionListRemovalPreview).toHaveBeenCalledWith('s1');
    expect(f.store.applySessionPatch).not.toHaveBeenCalled();
    expect(f.bindings.sessionMetaWriteQueue.enqueue).not.toHaveBeenCalled();
    if (outcome === 'superseded') f.isLatest.mockReturnValue(false);
    if (outcome === 'fail') {
      fail(new Error('preflight failed'));
      await expect(request).rejects.toThrow('preflight failed');
    } else {
      finish(outcome !== 'cancel');
      await request;
    }
    expect(f.bindings.sessionMetaWriteQueue.enqueue).not.toHaveBeenCalled();
    expect(f.store.upsertDeviceSession).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalled();
    expect(f.store.beginSessionListRemovalPreview.mock.results[0].value).toHaveBeenCalledOnce();
  });

  // PR #6863 review r4353650369: the real field guard used to invalidate a
  // pending title/pin write before archive confirmation. Existing fixtures only
  // mocked isLatest, so they could not observe the lost retry eligibility.
  it.each(['title', 'pinnedAt', 'status'] as const)('cancelled archive preserves a pending %s write', async (field) => {
    const f = fixture();
    const guard = createLatestWriteGuard();
    const prior = guard.begin(session.id, [field]);
    let finish!: (confirmed: boolean) => void;
    const preparation = new Promise<boolean>(resolve => { finish = resolve; });
    const patch = callback('src/session/useSessionListActions.ts', 'patchSession', {
      ...f.bindings, sessionMetaWriteGuard: guard,
    });
    const request = patch(session, { status: 'archived' }, () => preparation);
    expect(prior.isLatest()).toBe(true);
    finish(false);
    await request;
    const send = vi.fn(async () => ({ [field]: 'saved' }));
    expect(await retryPatchWhileLatest(prior.isLatest, send)).toEqual({ [field]: 'saved' });
    expect(send).toHaveBeenCalledOnce();
    expect(f.store.upsertDeviceSession).not.toHaveBeenCalled();
  });

  it('a later status write prevents delayed archive confirmation from committing', async () => {
    const f = fixture();
    const guard = createLatestWriteGuard();
    let finish!: (confirmed: boolean) => void;
    const preparation = new Promise<boolean>(resolve => { finish = resolve; });
    const patch = callback('src/session/useSessionListActions.ts', 'patchSession', {
      ...f.bindings, sessionMetaWriteGuard: guard,
    });
    const request = patch(session, { status: 'archived' }, () => preparation);
    guard.begin(session.id, ['status']);
    finish(true);
    await request;
    expect(f.bindings.sessionMetaWriteQueue.enqueue).not.toHaveBeenCalled();
    expect(f.store.applySessionPatch).not.toHaveBeenCalled();
    expect(f.store.beginSessionListRemovalPreview.mock.results[0].value).toHaveBeenCalledOnce();
  });

  it('confirmed archive supersedes old writes and rolls back to metadata saved during preflight', async () => {
    const f = fixture();
    const guard = createLatestWriteGuard();
    const prior = guard.begin(session.id, ['title']);
    const updatedRow = { ...session, title: 'Saved during preflight' };
    f.store.getSessions = () => [updatedRow];
    const patch = callback('src/session/useSessionListActions.ts', 'patchSession', {
      ...f.bindings, sessionMetaWriteGuard: guard,
    });
    const request = patch(session, { status: 'archived' }, async () => true);
    await tick();
    expect(prior.isLatest()).toBe(false);
    expect(f.store.applySessionPatch).toHaveBeenCalledWith('shard', 's1', { status: 'archived' });
    f.reject(new Error('network unavailable'));
    await expect(request).rejects.toThrow('network unavailable');
    expect(f.store.upsertDeviceSession).toHaveBeenCalledWith('shard', 'PC', updatedRow);
  });

  // Production list transitions may defer their callback until a layout effect.
  // A fast confirmation must not leave an unpaired hidden-row preview behind.
  it('pairs a cancelled preview with its release when list animation defers the mutation', async () => {
    const f = fixture();
    const controller = createDisclosureController();
    controller.setLevel = vi.fn();
    const prepare = vi.fn(async () => false);
    const patch = callback('src/session/useSessionListActions.ts', 'patchSession', {
      ...f.bindings, animateListChange: (apply: () => void) => runDisclosure(controller, apply, 1, true),
    });
    const request = patch(session, { status: 'archived' }, prepare);
    expect(prepare).not.toHaveBeenCalled();
    commitRegisteredLevel(controller, 1);
    await request;
    expect(f.store.beginSessionListRemovalPreview.mock.results[0].value).toHaveBeenCalledOnce();
    expect(f.store.applySessionPatch).not.toHaveBeenCalled();
    detachDisclosureScope(controller);
  });
  it.each(['archived', 'deleted', 'active'])('list status %s retires the mirror without rollback', async (status) => {
    const f = fixture();
    const patch = callback('src/session/useSessionListActions.ts', 'patchSession', f.bindings);
    const request = patch(session, { status });
    f.reject(gone());
    await request;
    expect(f.store.applySessionPatch).toHaveBeenLastCalledWith('shard', 's1', { status: 'deleted' });
    expect(f.store.upsertDeviceSession).not.toHaveBeenCalled();
    expect(f.store.requestReseed).toHaveBeenCalledWith('shard');
    expect(f.release).toHaveBeenCalled();
  });

  it('keeps ordinary failures on the rollback path', async () => {
    const f = fixture();
    const patch = callback('src/session/useSessionListActions.ts', 'patchSession', f.bindings);
    const request = patch(session, { status: 'archived' });
    f.reject(new Error('network unavailable'));
    await expect(request).rejects.toThrow('network unavailable');
    expect(f.store.upsertDeviceSession).toHaveBeenCalledWith('shard', 'PC', session);
  });

  it('does not let an obsolete list write retire a newer task state', async () => {
    const f = fixture();
    const patch = callback('src/session/useSessionListActions.ts', 'patchSession', f.bindings);
    const request = patch(session, { status: 'archived' });
    f.isLatest.mockReturnValue(false);
    f.reject(gone());
    await expect(request).rejects.toThrow('NOT_FOUND');
    expect(f.store.applySessionPatch).toHaveBeenCalledTimes(1);
  });

  it.each(['archived', 'deleted'])('late %s detail response does not navigate away from the next page', async (status) => {
    const f = fixture();
    const patch = callback('app/sessions/[sessionId].tsx', 'patchSessionMeta', f.bindings);
    patch({ status });
    await tick();
    expect(f.bindings.goBackToHome).toHaveBeenCalledTimes(1);
    // The user may already have opened a different task by the time the RPC fails.
    f.reject(gone());
    await tick();
    expect(f.bindings.goBackToHome).toHaveBeenCalledTimes(1);
    expect(f.store.upsertDeviceSession).not.toHaveBeenCalled();
    expect(f.bindings.Alert.alert).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalled();
  });

  it('bulk status changes omit confirmed orphans from the failed selection', async () => {
    const f = fixture();
    const selected = vi.fn();
    const notice = vi.fn();
    const bulk = callback('app/devices/[deviceId].tsx', 'executeBulkAction', {
      ...f.bindings, bulkActionPending: null, setBulkActionPending: vi.fn(),
      setBulkNotice: notice, setBulkConfirmAction: vi.fn(), setSelectedSessionIds: selected,
      setSelectionRequested: vi.fn(), mobileSessionBulkPatch: () => ({ status: 'archived' }),
      maker: { patchSessionMeta: vi.fn(async () => { throw gone(); }) }, loadSessions: vi.fn(),
    });
    await bulk('archive', [session]);
    expect(f.store.applySessionPatch).toHaveBeenLastCalledWith('shard', 's1', { status: 'deleted' });
    expect(f.store.upsertDeviceSession).not.toHaveBeenCalled();
    expect(selected).toHaveBeenCalledExactlyOnceWith([]);
    expect(notice).toHaveBeenCalledExactlyOnceWith(null);
  });
});
