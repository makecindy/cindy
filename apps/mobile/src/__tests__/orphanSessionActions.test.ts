import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { isExplicitRemoteNotFoundError } from '@/session/newSessionWorktree';
import { pickWriteFields, writeGuardFields } from '@/session/swipeRowRegistry';

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
  const pending = new Promise((_resolve, fail) => { reject = fail; });
  const store = {
    applySessionPatch: vi.fn(), upsertDeviceSession: vi.fn(), requestReseed: vi.fn(),
    getSessions: () => [session],
  };
  const release = vi.fn();
  const isLatest = vi.fn(() => true);
  const bindings = {
    currentSession: session, deviceId: 'rpc', sessionId: session.id,
    resolveSessionWriteDevices: () => ({ rpcDeviceId: 'rpc', shardId: 'shard' }),
    sessionMetaWriteGuard: { begin: () => ({ isLatest }) },
    sessionMetaWriteQueue: { enqueue: () => pending },
    sessionPendingWrites: { track: () => release },
    remoteSessionStore: store, isExplicitRemoteNotFoundError, pickWriteFields, writeGuardFields,
    goBackToHome: vi.fn(), Alert: { alert: vi.fn() }, humanizeRemoteError: String,
    animateListChange: undefined, t: (key: string) => key,
    withNewSessionCreationRemoval: (_sid: string, _device: string, _status: string, remove: () => Promise<unknown>) => remove(),
  };
  return { bindings, reject, store, release, isLatest };
}
const gone = () => new Error('[NOT_FOUND] Session does not exist');
const tick = () => new Promise((done) => setTimeout(done, 0));

describe('orphan task status actions', () => {
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
