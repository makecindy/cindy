import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createRemoteSyncCoordinator } from '@/device-link/remoteSyncTask';
import { runConnectionScopedSessionMetadataRead, waitForIndependentSnapshotReads } from '@/device-link/sessionSnapshotSingleFlight';
import { syncSessionMessageWindow } from '@/session/sessionMessageWindowSync';
import { shouldClearOperationErrorAfterSync } from '@/session/sessionSyncErrorRecovery';
import { hasOlderMessagesAfterReopen, shouldKeepOlderMessagesAffordance } from '@/session/messagePaging';
import { HistoryViewController, isHistoryViewUnavailable, projectHistoryView } from '@cindy/maker-shared/message-window';

// Execute the actual page callbacks, not a duplicate orchestration written for tests.
// This catches a helper becoming disconnected from the screen during integration.
const source = ts.createSourceFile('screen.tsx', readFileSync(
  resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function pageCallback(name: string, bindings: Record<string, unknown>): (...args: any[]) => Promise<void> {
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name
      && node.initializer && ts.isCallExpression(node.initializer)) {
      expression = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!expression) throw new Error(`Missing production callback ${name}`);
  const compiled = ts.transpileModule(`const callback = ${expression.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(bindings), `${compiled}\nreturn callback;`)(...Object.values(bindings));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((done) => setTimeout(done, 0));
const session = { id: 's1', updatedAt: '2026-09-06T00:00:00Z', _count: { messages: 100 } };
const page = { messages: [{ id: 'm1' }], limit: 1, reducedByPayloadTooLarge: false };

function fixture(reopen = false, remoteHistoryAvailable = true) {
  const state = {
    rows: reopen ? [{ id: 'cached', clientId: 'cached' }] : [] as { id: string; clientId?: string }[],
    older: false, loading: false, historyLoading: false,
    syncError: null as string | null, historyError: null as string | null,
    operation: null as { message: string } | null,
    hold: { deviceId: 'd1', error: null } as { deviceId: string; error: string | null } | null,
    synced: null as number | null, readAck: null as string | null,
  };
  const operationErrorRef = { current: state.operation };
  const setError = vi.fn((message: string | null) => {
    state.operation = message === null ? null : { message };
    operationErrorRef.current = state.operation;
  });
  const store = {
    captureSessionMessageAuthority: () => ({ generation: 1 }),
    isSessionMessageAuthorityCurrent: () => true,
    upsertDeviceSession: vi.fn(),
    getMessages: () => state.rows,
    getSessions: () => reopen ? [session] : [],
    captureActiveSessionSnapshotEpoch: () => 0,
    captureInputProjectionAuthorityEpoch: () => 0,
    getPendingInteractions: () => [],
    isSessionMessageWindowSynced: vi.fn(() => false),
    setMessages: vi.fn((_id, rows) => { state.rows = rows; }),
    setLatestMessageWindow: vi.fn((_id, rows) => { state.rows = rows; }),
    markSessionMessagesSynced: vi.fn(),
    setPendingInteractions: vi.fn(), setInputProjectionIfCurrent: vi.fn(),
    setActiveSessionSnapshots: vi.fn(),
    mergeEarlierMessages: vi.fn((_id, rows) => { state.rows = [...rows, ...state.rows]; return true; }),
  };
  const maker = {
    getSession: vi.fn(async () => session),
    listMessages: vi.fn(async () => page),
    input: { getProjection: vi.fn(async () => ({})) },
    getPendingInteractions: vi.fn(async () => []),
    listActiveSessions: vi.fn(async () => []),
  };
  const bindings = {
    mobileDebugLog: vi.fn(),
    remoteHistoryAvailable,
    deviceId: 'd1', deviceName: 'test', sessionId: 's1',
    historyView: { snapshot: { ready: false }, view: { refresh: async (): Promise<void> => undefined, getSnapshot: (): { ready: boolean; error: unknown } => ({ ready: false, error: new Error('[CHANNEL_NOT_ALLOWED] legacy host') }) } },
    remoteSessionStore: store, maker, isHistoryViewUnavailable, shouldBlockSessionSync: () => false,
    readAckEpochRef: { current: 1 }, readAckGateGenRef: { current: 1 },
    sessionSubscriptionIdentityRef: { current: JSON.stringify(['d1', 's1', 1]) },
    createRemoteSyncReopenCoordinator: () => ({ captureVersion: () => 0 }),
    reopenLink: async () => undefined, openLink: async () => undefined,
    subscribe: async () => undefined, sessionsSubscriptionCoordinatorRef: { current: null },
    // Retry delays / transport single-flight are tested separately; preserve callbacks and fences here.
    retryRemoteSyncRead: (_run: unknown, read: () => unknown) => read(),
    runConnectionScopedSessionMetadataRead, waitForIndependentSnapshotReads, syncSessionMessageWindow,
    runSessionProjectionSnapshotSingleFlight: (_scope: unknown, _epoch: unknown, read: () => unknown) => read(),
    runSessionPendingInteractionsSnapshotSingleFlight: (_scope: unknown, _pending: unknown, read: () => unknown) => read(),
    runSessionMessagesSnapshotSingleFlight: (_scope: unknown, _limit: unknown, _fence: unknown, read: () => unknown) => read(),
    listMessagesWithPayloadRetry: (read: (limit: number) => unknown) => read(20),
    withTransientRemoteRetry: (read: () => unknown) => read(),
    REOPEN_MESSAGE_WINDOW_LIMITS: [20],
    getSubscriptionIdentity: (): number | null => null, notificationResponse: null,
    syncedNotificationResponseRef: { current: null },
    shouldKeepOlderMessagesAffordance, hasOlderMessagesAfterReopen,
    messageWindowReconciledRef: { current: false },
    setHasOlderMessages: (value: boolean) => { state.older = value; },
    setLoading: (value: boolean) => { state.loading = value; },
    setSyncError: (value: string | null) => { state.syncError = value; },
    setError, operationErrorRef, shouldClearOperationErrorAfterSync,
    setOutboxTransportHold: (update: (value: typeof state.hold) => typeof state.hold) => { state.hold = update(state.hold); },
    latchOutboxTransportHold: (error: string) => { state.hold = { deviceId: 'd1', error }; },
    setLastSyncedAt: (value: number) => { state.synced = value; },
    setContentSyncedKey: vi.fn(), contentRecoveryKeyRef: { current: null },
    setSessionMetadataSyncedKey: vi.fn(),
    setReadAckSyncedKey: (value: string) => { state.readAck = value; },
    formatRemoteError: (error: Error) => error.message,
    isScheduleDetail: false, loadingEarlier: false, hasOlderMessages: true,
    oldestLoadedMessageCursor: 'before-m1', abandonInFlightBackfill: vi.fn(),
    historyRequestSeqRef: { current: 0 }, historyRequestInFlightRef: { current: null as number | null },
    setLoadingEarlier: (value: boolean) => { state.historyLoading = value; },
    setHistoryError: (value: string | null) => { state.historyError = value; },
  };
  const coordinator = createRemoteSyncCoordinator(pageCallback('syncSession', bindings));
  coordinator.setContext('d1:s1:1');
  return { state, maker, store, bindings, coordinator, setError,
    sync: () => coordinator.request({ reason: 'manual' }),
    earlier: pageCallback('loadEarlierMessages', bindings),
  };
}

describe('production session recovery callbacks', () => {
  it('keeps cached rows offline without fetching metadata, projection, history or earlier pages', async () => {
    const f = fixture(true, false);
    const rows = f.state.rows;
    await f.sync();
    await f.earlier();
    expect(f.state.rows).toBe(rows);
    expect(f.state.loading).toBe(false);
    expect(f.maker.getSession).not.toHaveBeenCalled();
    expect(f.maker.listMessages).not.toHaveBeenCalled();
    expect(f.maker.input.getProjection).not.toHaveBeenCalled();
    expect(f.state.readAck).toBeNull();
  });
  it('reads after ACK when restored history is ready but the captured snapshot is not', async () => {
    const f = fixture(true);
    f.store.isSessionMessageWindowSynced.mockReturnValue(true);
    const read = vi.fn(async () => ({ version: 1 as const, items: [], hasMore: false, nextCursor: null }));
    const view = new HistoryViewController({ page: read,
      details: async () => ({ version: 1 as const, messages: [], hasMore: false, nextCursor: null }), expanded: async () => undefined });
    await view.refresh();
    f.bindings.historyView.view = view;
    f.bindings.getSubscriptionIdentity = () => 7;
    const coordinator = createRemoteSyncCoordinator(pageCallback('syncSession', f.bindings));
    coordinator.setContext('d1:s1:ack');
    await coordinator.request({ reason: 'subscription-acked' });
    expect(read).toHaveBeenCalledTimes(2);
    expect(f.state.synced).not.toBeNull();
  });

  it('waits for a page begun after subscription ACK even when an initial page is pending', async () => {
    const f = fixture();
    const pending = deferred<{ version: 1; items: []; hasMore: false; nextCursor: null }>();
    const read = vi.fn(async () => ({ version: 1 as const, items: [], hasMore: false, nextCursor: null }));
    read.mockImplementationOnce(() => pending.promise);
    const view = new HistoryViewController({ page: read,
      details: async () => ({ version: 1 as const, messages: [], hasMore: false, nextCursor: null }), expanded: async () => undefined });
    const initial = view.refresh();
    f.bindings.historyView.view = view;
    f.bindings.getSubscriptionIdentity = () => 7;
    const coordinator = createRemoteSyncCoordinator(pageCallback('syncSession', f.bindings));
    coordinator.setContext('d1:s1:ack');
    const recovery = coordinator.request({ reason: 'subscription-acked' });
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve({ version: 1, items: [], hasMore: false, nextCursor: null });
    await Promise.all([initial, recovery]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(f.state.synced).not.toBeNull();
  });

  it('commits raw history after a previously ready projection loses Host support', async () => {
    const f = fixture(true);
    const read = vi.fn(async () => ({ version: 1 as const, items: projectHistoryView([
      { id: 'old', clientId: 'old', role: 'user', content: 'old', createdAt: session.updatedAt },
    ], false), hasMore: false, nextCursor: null }));
    const view = new HistoryViewController({ page: read,
      details: async () => ({ version: 1 as const, messages: [], hasMore: false, nextCursor: null }), expanded: async () => undefined });
    await view.refresh();
    f.bindings.historyView.snapshot.ready = true;
    f.bindings.historyView.view = view;
    read.mockRejectedValueOnce(new Error('[CHANNEL_NOT_ALLOWED] downgraded Host'));
    // Call the actual callback again with the new view binding.
    const coordinator = createRemoteSyncCoordinator(pageCallback('syncSession', f.bindings));
    coordinator.setContext('d1:s1:2');
    await coordinator.request({ reason: 'manual' });
    expect(view.getSnapshot().ready).toBe(false);
    expect(f.store.setLatestMessageWindow).toHaveBeenCalled();
    expect(f.state.rows).toEqual(page.messages);
    expect(f.store.markSessionMessagesSynced).toHaveBeenCalled();
  });
  it('accepts a history view without certifying sparse rows as a complete raw window', async () => {
    const f = fixture();
    f.bindings.historyView.view.getSnapshot = () => ({ ready: true, error: null });
    await f.sync();
    expect(f.maker.listMessages).not.toHaveBeenCalled();
    expect(f.store.setMessages).not.toHaveBeenCalled();
    expect(f.store.setLatestMessageWindow).not.toHaveBeenCalled();
    expect(f.store.markSessionMessagesSynced).not.toHaveBeenCalled();
    expect(f.state.synced).not.toBeNull();
  });

  it('routes the visible history retry to pagination rather than full sync', () => {
    const screen = source.getFullText().replace(/\r\n/g, '\n');
    expect(screen).toContain('const bannerError = connectionRecoveryError ?? historyError;');
    expect(screen).toContain('const bannerRetriesHistory = connectionRecoveryError === null && historyError !== null;');
    expect(screen).toContain('requestErrorAutoRecovering={bannerRetriesHistory ? false : undefined}');
    expect(screen).toContain('loading={loading || loadingEarlier}');
    expect(screen).toMatch(/onSync=\{\(\) => bannerRetriesHistory\s+\? void loadEarlierMessages\(\)\s+: void requestSync\(/);
    const errorSources = screen.slice(screen.indexOf('const connectionError ='), screen.indexOf('const bannerError ='));
    expect(errorSources).not.toContain('historyError');
  });

  it.each([false, true])('keeps late history and pagination after projection rejects (reopen=%s)', async (reopen) => {
    const f = fixture(reopen);
    const history = deferred<typeof page>();
    f.maker.listMessages.mockReturnValue(history.promise);
    f.maker.input.getProjection.mockRejectedValue(new Error('[INVOKE_TIMEOUT] projection'));
    const result = f.sync();
    const rejected = expect(result).rejects.toThrow('projection');
    await tick();
    expect(f.state.loading).toBe(true);
    history.resolve(page);
    await rejected;
    expect(f.state.rows).toEqual(page.messages);
    expect(f.state.older).toBe(true);
    expect(f.state.syncError).toContain('projection');
    expect(f.state.readAck).toBeNull();
    expect(f.state.hold).not.toBeNull();
    f.maker.input.getProjection.mockResolvedValue({});
    await f.sync();
    expect(f.state.syncError).toBeNull();
    expect(f.state.hold).toBeNull();
    expect(f.state.readAck).toBe('s1:1');
  });

  it('shows a fetched cold page and its pagination even if metadata fails first', async () => {
    const f = fixture();
    const history = deferred<typeof page>();
    f.maker.listMessages.mockReturnValue(history.promise);
    f.maker.getSession.mockRejectedValue(new Error('[INVOKE_TIMEOUT] metadata'));
    const rejected = expect(f.sync()).rejects.toThrow('metadata');
    await tick();
    history.resolve(page);
    await rejected;
    expect(f.state.rows).toEqual(page.messages);
    expect(f.state.older).toBe(true);
    expect(f.store.markSessionMessagesSynced).not.toHaveBeenCalled();
  });

  it('restores pagination on unchanged reopen without waiting for a failed projection', async () => {
    const f = fixture(true);
    f.store.isSessionMessageWindowSynced.mockReturnValue(true);
    f.maker.input.getProjection.mockRejectedValue(new Error('[INVOKE_TIMEOUT] projection'));
    await expect(f.sync()).rejects.toThrow('projection');
    expect(f.state.older).toBe(true);
    expect(f.maker.listMessages).not.toHaveBeenCalled();
    expect(f.state.rows).toEqual([{ id: 'cached', clientId: 'cached' }]);
    expect(f.state.hold).not.toBeNull();
  });

  it('reports failed history without clearing the read-receipt barrier', async () => {
    const f = fixture();
    const error = new Error('history unavailable');
    f.maker.listMessages.mockRejectedValue(error);
    await expect(f.sync()).rejects.toBe(error);
    expect(f.bindings.mobileDebugLog).toHaveBeenCalledWith('debug', 'recovery', 'detail sync phase',
      expect.objectContaining({ phase: 'history', outcome: 'failed', connection: 1 }));
    expect(f.state.readAck).toBeNull();
    expect(f.state.hold).not.toBeNull();
  });

  it('retains early progressive display while control state is pending', async () => {
    const f = fixture();
    const projection = deferred<object>();
    f.maker.input.getProjection.mockReturnValue(projection.promise);
    const result = f.sync();
    await tick();
    expect(f.state.rows).toEqual(page.messages);
    expect(f.state.older).toBe(true);
    expect(f.state.hold).not.toBeNull();
    expect(f.state.readAck).toBeNull();
    projection.resolve({});
    await result;
    expect(f.state.hold).toBeNull();
  });

  it.each(['clear-old', 'keep-new-identical', 'keep-deterministic'])('clears operation errors by occurrence: %s', async (scenario) => {
    const f = fixture();
    const message = scenario === 'keep-deterministic' ? '[NOT_FOUND] item' : '[INVOKE_TIMEOUT] send';
    f.setError(message);
    const projection = deferred<object>();
    f.maker.input.getProjection.mockReturnValue(projection.promise);
    const result = f.sync();
    await tick();
    expect(f.state.operation?.message).toBe(message);
    if (scenario === 'keep-new-identical') f.setError(message);
    projection.resolve({});
    await result;
    expect(f.state.operation?.message ?? null).toBe(scenario === 'clear-old' ? null : message);
  });

  it('does not commit a late page after coordinator context changes', async () => {
    const f = fixture();
    const history = deferred<typeof page>();
    f.maker.listMessages.mockReturnValue(history.promise);
    const result = f.sync();
    await tick();
    f.coordinator.setContext('d1:s2:1');
    history.resolve(page);
    await result;
    await tick();
    expect(f.state.rows).toEqual([]);
    expect(f.state.readAck).toBeNull();
  });

  it('retries a failed page locally without changing sync/operation errors or the hold', async () => {
    const f = fixture();
    f.state.hold = null;
    f.setError('[NOT_FOUND] unrelated operation');
    f.maker.listMessages.mockRejectedValueOnce(new Error('[INVOKE_TIMEOUT] history'));
    await f.earlier();
    expect(f.state.historyError).toContain('history');
    expect(f.state.operation?.message).toContain('unrelated');
    expect(f.state.syncError).toBeNull();
    expect(f.state.hold).toBeNull();
    const retry = deferred<typeof page>();
    f.maker.listMessages.mockReturnValue(retry.promise);
    const result = f.earlier();
    await f.earlier(); // Same-tick duplicate must not send a second page request.
    expect(f.state.historyLoading).toBe(true);
    expect(f.state.historyError).toContain('history');
    expect(f.maker.listMessages).toHaveBeenCalledTimes(2);
    retry.resolve(page);
    await result;
    expect(f.state.historyError).toBeNull();
    expect(f.state.historyLoading).toBe(false);
    expect(f.maker.getSession).not.toHaveBeenCalled();
    expect(f.maker.input.getProjection).not.toHaveBeenCalled();
    expect(f.maker.listMessages).toHaveBeenLastCalledWith('s1', { limit: 20, before: 'before-m1' });
  });

  it('does not let an old page failure clear a new request loading state', async () => {
    const f = fixture();
    const old = deferred<typeof page>();
    f.maker.listMessages.mockReturnValue(old.promise);
    const result = f.earlier();
    f.bindings.historyRequestSeqRef.current += 1; // The screen invalidates this synchronously on task switch.
    f.bindings.historyRequestInFlightRef.current = null;
    const next = deferred<typeof page>();
    f.maker.listMessages.mockReturnValue(next.promise);
    const newer = f.earlier();
    old.reject(new Error('[INVOKE_TIMEOUT] old page'));
    await result;
    expect(f.state.historyLoading).toBe(true);
    expect(f.state.historyError).toBeNull();
    next.resolve(page);
    await newer;
    expect(f.state.historyLoading).toBe(false);
    expect(f.store.mergeEarlierMessages).toHaveBeenCalledTimes(1);
  });
});

// Run the production push routing tail with real projection generations.
describe('destructive remote history pushes', () => {
  // Delete (including initial-page races) is exercised through the real store in remoteHistoryReentry.test.ts.
  it.each(['clear', 'archive'])('retires old pages on %s without an unrelated activity event', async (operation) => {
    const context = readFileSync(resolve(process.cwd(), 'src/device-link/DeviceLinkContext.tsx'), 'utf8');
    const body = context.slice(context.indexOf('  const historySessionId ='), context.indexOf('/** provider revision')).trim().slice(0, -1);
    const stale = { id: 'old', clientId: 'old', role: 'user', content: 'old', createdAt: '2026-09-08T00:00:00Z' };
    const oldPage = { version: 1 as const, items: projectHistoryView([stale], false), hasMore: false, nextCursor: null };
    let reads = 0;
    const view = new HistoryViewController({
      page: async () => ++reads === 1 ? oldPage
        : { ...oldPage, items: [] },
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    const first = view.refresh();
    await first;
    let raw = [stale];
    const store = {
      applyRemotePush: vi.fn(() => { if (operation !== 'clear') raw = []; }),
      invalidateSessionMessageWindow: vi.fn(() => { raw = []; }),
    };
    const push = { channel: 'local-db:sessions:patched', payload: { sessionId: 's', patch: operation === 'clear'
      ? { clearedAt: '2026-09-08T01:00:00Z' } : { status: 'archived' } } };
    const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const route = new Function('push', 'env', 'findRemoteHistoryView', 'remoteSessionStore', compiled);
    route(push, { src: 'device-a' }, (device: string, session: string) => device === 'device-a' && session === 's' ? view : undefined, store);
    expect(raw).toEqual([]);
    expect(view.getSnapshot().items).toEqual([]);
    expect(view.getSnapshot().details.size).toBe(0);
    await first; await tick();
    expect(view.getSnapshot().items).toEqual([]);
    expect(view.isActive()).toBe(operation !== 'archive');
    if (operation === 'clear') expect(store.invalidateSessionMessageWindow).toHaveBeenCalledWith('s', 'device-a');
    view.setActive(false);
  });
});
