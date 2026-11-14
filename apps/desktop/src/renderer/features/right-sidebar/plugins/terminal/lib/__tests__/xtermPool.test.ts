// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../index';
import { _resetStore, closeTab, ensureHydrated, patchTabState, importTabSnapshot, getTabSnapshot, getSingleTabSnapshot, importReturnedTabState, getBucket } from '../../../../store';
import { finishClosing, markClosing, registerClosing } from '../../../../lib/tabClosingSignal';
import { markAllPtyDetached, markPtyDetached } from '../xtermEntries';
import { openTerminalExternalLink, getXterm, getXtermExit, setXtermExit, onXtermExit, restartXterm, attachXterm, releaseXtermConnection, detachXterm, getOrCreateXterm, suspendExitedXterm, disposeXterm, __resetPoolForTesting } from '../xtermPool';

const { warn } = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn, error: vi.fn() }),
}));

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ getSessionDeviceId: vi.fn() }));

it('marks a real xterm entry registered after closing begins and clears it after rollback', () => {
  markClosing('late-terminal');
  try {
    const entry = getOrCreateXterm('late-terminal');
    expect(entry.closing).toBe(true);
    // PR8881 / unit: the real pool must notify only after all pending closes
    // roll back. The former boolean-only check missed stranded preparation.
    const resumed = vi.fn(() => { expect(entry.closing).toBe(false); });
    entry.closeCancelledListeners.add(resumed);
    markClosing('late-terminal');
    finishClosing('late-terminal');
    expect(resumed).not.toHaveBeenCalled();
    finishClosing('late-terminal');
    expect(entry.closing).toBe(false);
    expect(resumed).toHaveBeenCalledOnce();
    markClosing('late-terminal');
    disposeXterm('late-terminal');
    finishClosing('late-terminal');
    expect(resumed).toHaveBeenCalledOnce();
    expect(entry.closeCancelledListeners.size).toBe(0);
  } finally {
    finishClosing('late-terminal');
    disposeXterm('late-terminal');
  }
});

// PR8881 merge / unit: window migration must invalidate the real pool's attachment
// without losing close rollback or SSH context. Existing pool tests only cover
// close registration; two attached tabs distinguish single-tab and whole-host moves.
it('detaches the canonical pooled entries while retaining close and SSH state', () => {
  const first = getOrCreateXterm('moving-terminal');
  const second = getOrCreateXterm('remaining-terminal');
  const resume = vi.fn();
  const remoteContext = { sessionId: 'remote-session', deviceId: 'remote-device' };
  const remoteDraft = { contextKey: 'remote-context', submitted: true };
  try {
    first.ptyAttached = second.ptyAttached = true;
    first.remoteContext = remoteContext;
    first.remoteDraft = remoteDraft;
    first.closeCancelledListeners.add(resume);
    markClosing('moving-terminal');

    markPtyDetached('moving-terminal');
    expect(first.ptyAttached).toBe(false);
    expect(second.ptyAttached).toBe(true);
    expect(getOrCreateXterm('moving-terminal')).toBe(first);
    expect(first.closing).toBe(true);
    expect(first.remoteContext).toBe(remoteContext);
    expect(first.remoteDraft).toBe(remoteDraft);
    expect(resume).not.toHaveBeenCalled();

    first.ptyAttached = true;
    markAllPtyDetached();
    expect(first.ptyAttached).toBe(false);
    expect(second.ptyAttached).toBe(false);
    finishClosing('moving-terminal');
    expect(resume).toHaveBeenCalledOnce();
  } finally {
    finishClosing('moving-terminal');
    disposeXterm('moving-terminal');
    disposeXterm('remaining-terminal');
  }
});

describe('openTerminalExternalLink', () => {
  afterEach(() => {
    __resetPoolForTesting();
    _resetStore();
    vi.clearAllMocks();
  });

  async function closingFixture(snapshot: boolean) {
    const id = 'close-outcome';
    const sessionId = 'close-session';
    const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const setActive = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      terminal: { dispose }, localDb: { rightSidebarTabs: {
        list: vi.fn().mockResolvedValue({ tabs: [{ id, kind: 'terminal', state: {} }], activeTabId: id, persistable: true }),
        close, setActive,
      } },
    } });
    await ensureHydrated(sessionId);
    const entry = getOrCreateXterm(id);
    entry.remoteDraft = { contextKey: 'context', connection: { host: 'edited-host' }, submitted: false };
    entry.ptyAttached = true;
    if (snapshot) await suspendExitedXterm(id);
    return { id, sessionId, dispose, close, setActive, retained: getXterm(id)! };
  }

  // PRRT_kwDOTgdRUs62sDlx / unit: actual store + plugin + pool, unlike hook-only
  // tests. Native release followed by SQLITE_BUSY used to erase editing intent.
  it.each([false, true])('retains drafts until database close commits (snapshot=%s)', async snapshot => {
    const id = 'close-draft';
    const sessionId = 'close-session';
    let settle!: () => void;
    let reject!: (error: Error) => void;
    const close = vi.fn(() => new Promise<void>((yes, no) => { settle = yes; reject = no; }));
    const dispose = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      terminal: { dispose }, localDb: { rightSidebarTabs: {
        list: vi.fn().mockResolvedValue({ tabs: [{ id, kind: 'terminal', state: {} }], activeTabId: id, persistable: true }),
        close, setActive: vi.fn().mockResolvedValue(undefined),
      } },
    } });
    await ensureHydrated(sessionId);
    const entry = getOrCreateXterm(id);
    const draft = { contextKey: 'context', connection: { host: 'edited-host', user: 'alice', port: 2222 }, submitted: false };
    entry.remoteDraft = draft;
    entry.ptyAttached = true;
    if (snapshot) await suspendExitedXterm(id);
    const retained = getXterm(id)!;
    const resumed = vi.fn();
    retained.closeCancelledListeners.add(resumed);
    const failed = closeTab(sessionId, id);
    const failure = expect(failed).rejects.toThrow('SQLITE_BUSY');
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    // Settle before asserting so the red regression leaves no pending mutation.
    const duringClose = getXterm(id);
    reject(new Error('SQLITE_BUSY'));
    await failure;
    expect(duringClose).toBe(retained);
    expect(getXterm(id)?.remoteDraft).toEqual(draft);
    expect(getXterm(id)?.ptyAttached).toBe(false);
    expect(getXterm(id)?.closing).toBe(false);
    expect(getBucket(sessionId).tabs.map(tab => tab.id)).toEqual([id]);
    resumed.mockClear();
    const committed = closeTab(sessionId, id);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    expect(getXterm(id)?.closing).toBe(true);
    expect(getXterm(id)?.remoteDraft).toEqual(draft);
    settle();
    await committed;
    expect(getXterm(id)).toBeUndefined();
    expect(getBucket(sessionId).tabs).toEqual([]);
    expect(resumed).not.toHaveBeenCalled();
    expect(getOrCreateXterm(id).remoteDraft).toBeUndefined();
  });

  // Same failure family: native veto must preserve both storage forms; row
  // absence and active-write failure are already committed, never rollback.
  it.each([false, true])('keeps drafts and attachment when native disposal vetoes (snapshot=%s)', async snapshot => {
    const { id, sessionId, dispose, close, retained } = await closingFixture(snapshot);
    dispose.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
    await closeTab(sessionId, id);
    expect(close).not.toHaveBeenCalled();
    expect(getBucket(sessionId).tabs.map(tab => tab.id)).toEqual([id]);
    expect(getXterm(id)).toBe(retained);
    expect(retained.remoteDraft?.submitted).toBe(false);
    expect(retained.ptyAttached).toBe(true);
    expect(retained.closing).toBe(false);
  });

  it.each([
    [false, 'missing'], [true, 'missing'], [false, 'active-failed'], [true, 'active-failed'],
  ] as const)('commits final cleanup for snapshot=%s, outcome=%s', async (snapshot, outcome) => {
    const { id, sessionId, close, setActive, retained } = await closingFixture(snapshot);
    if (outcome === 'missing') close.mockRejectedValueOnce(new Error('[NOT_FOUND] missing row'));
    else setActive.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    const resumed = vi.fn();
    retained.closeCancelledListeners.add(resumed);
    await closeTab(sessionId, id);
    expect(getBucket(sessionId).tabs).toEqual([]);
    expect(getXterm(id)).toBeUndefined();
    expect(resumed).not.toHaveBeenCalled();
  });

  it('never rolls back a committed row when renderer cleanup throws', async () => {
    const { id, sessionId } = await closingFixture(false);
    registerClosing(id, () => undefined, () => { throw new Error('renderer cleanup failed'); });
    await closeTab(sessionId, id);
    expect(getBucket(sessionId).tabs).toEqual([]);
    expect(warn).toHaveBeenCalledWith('committed tab cleanup failed', expect.objectContaining({ tabId: id }));
  });

  it('invalidates the restored canonical snapshot after native disposal completes', async () => {
    const { id, sessionId, dispose, close, retained } = await closingFixture(true);
    let release!: () => void;
    dispose.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    close.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    const closing = closeTab(sessionId, id);
    const failed = expect(closing).rejects.toThrow('SQLITE_BUSY');
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    const restored = getOrCreateXterm(id);
    await restored.restored;
    expect(restored).not.toBe(retained);
    release();
    await failed;
    expect(getXterm(id)).toBe(restored);
    expect(restored.ptyAttached).toBe(false);
    expect(restored.remoteDraft?.connection?.host).toBe('edited-host');
    expect(restored.closing).toBe(false);
  });

  it('ignores late native success on a replacement entry after the original was removed', async () => {
    const { id, sessionId, dispose, close } = await closingFixture(false);
    let release!: () => void;
    dispose.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    close.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    const closing = closeTab(sessionId, id);
    const failed = expect(closing).rejects.toThrow('SQLITE_BUSY');
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    disposeXterm(id);
    const replacement = getOrCreateXterm(id);
    replacement.ptyAttached = true;
    replacement.remoteDraft = { contextKey: 'new-lifetime', submitted: false };
    release();
    await failed;
    expect(getXterm(id)).toBe(replacement);
    expect(replacement.ptyAttached).toBe(true);
    expect(replacement.remoteDraft.contextKey).toBe('new-lifetime');
  });

  it('does not resurrect drafts when another native close rejects after committed removal', async () => {
    const { id, sessionId, dispose, retained } = await closingFixture(true);
    let reject!: (error: Error) => void;
    dispose.mockImplementationOnce(() => new Promise<void>((_yes, no) => { reject = no; }));
    const late = closeTab(sessionId, id);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    const resumed = vi.fn();
    retained.closeCancelledListeners.add(resumed);
    await closeTab(sessionId, id);
    expect(getXterm(id)).toBeUndefined();
    reject(new Error('PERMISSION_DENIED'));
    await late;
    expect(getXterm(id)).toBeUndefined();
    expect(getBucket(sessionId).tabs).toEqual([]);
    expect(resumed).not.toHaveBeenCalled();
  });

  it.each(['rollback-first', 'commit-first'] as const)('settles concurrent closes without reviving committed drafts (%s)', async order => {
    const { id, sessionId, dispose, close, retained } = await closingFixture(false);
    const releases: Array<() => void> = [];
    dispose.mockImplementation(() => new Promise<void>(resolve => { releases.push(resolve); }));
    if (order === 'rollback-first') close.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    const resumed = vi.fn();
    retained.closeCancelledListeners.add(resumed);
    const first = closeTab(sessionId, id);
    const firstResult = first.catch(error => error);
    const second = closeTab(sessionId, id);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(2));
    releases[0]();
    await firstResult;
    if (order === 'rollback-first') {
      expect(getXterm(id)?.remoteDraft?.submitted).toBe(false);
      expect(getXterm(id)?.closing).toBe(true);
    } else expect(getXterm(id)).toBeUndefined();
    expect(resumed).not.toHaveBeenCalled();
    releases[1]();
    await second;
    expect(getBucket(sessionId).tabs).toEqual([]);
    expect(getXterm(id)).toBeUndefined();
    expect(resumed).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(order === 'rollback-first' ? 2 : 1);
  });

  // PR8881 PRRT_kwDOTgdRUs62ATV_ / unit: production window handoff and pool
  // restoration, missing from same-renderer detach tests. A disposed connection
  // with an unsubmitted draft must remain editable after popup/whole-host moves.
  it.each([{ submitted: false, persistable: false }, { submitted: true, persistable: false }, { submitted: false, persistable: true }])('hands SSH editing intent across windows ($submitted, persisted=$persistable)', async ({ submitted, persistable }) => {
    const id = 'ssh-handoff';
    const sessionId = 'handoff-session';
    const state = { created: true, title: 'SSH' };
    const upsert = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { rightSidebarTabs: {
      list: vi.fn().mockResolvedValue({ tabs: [{ id, kind: 'terminal', state }], activeTabId: id, persistable }), upsert,
    } } } });
    await ensureHydrated(sessionId);
    const origin = getOrCreateXterm(id);
    const draft = { contextKey: 'context', connection: { host: 'new-host', user: 'alice', port: 2222, hostRef: 'opaque-reference' }, submitted };
    origin.remoteDraft = draft;
    const handoff = structuredClone(getTabSnapshot(sessionId)!);
    // A fresh renderer has no pooled entry; importing must restore it before mount.
    __resetPoolForTesting();
    _resetStore();
    importTabSnapshot(handoff);
    await ensureHydrated(sessionId);
    const destination = getOrCreateXterm(id);
    await destination.restored;
    expect(destination.remoteDraft).toEqual(draft);
    expect(getBucket(sessionId).tabs[0].state).toEqual(state);
    expect(handoff.persistable).toBe(persistable);
    await patchTabState(sessionId, id, () => state);
    expect(upsert).toHaveBeenCalledTimes(persistable ? 1 : 0);
    if (persistable) expect(JSON.stringify(upsert.mock.calls)).not.toContain('terminalDraft');
    destination.remoteDraft = { ...draft, submitted: false, connection: { host: 'edited-in-popup' } };
    const returned = structuredClone(getSingleTabSnapshot(sessionId, id)!);
    // A return must replace the retained origin draft, not prefer that stale pool.
    destination.remoteDraft = draft;
    importReturnedTabState(returned);
    expect(destination.remoteDraft?.connection?.host).toBe('edited-in-popup');
    // Later assignments carry an old whole bucket but only own their incoming IDs.
    importTabSnapshot(handoff, { onlyTabIds: new Set(['another-tab']) });
    expect(destination.remoteDraft?.connection?.host).toBe('edited-in-popup');
    destination.remoteDraft = undefined;
    const completed = structuredClone(getTabSnapshot(sessionId)!);
    destination.remoteDraft = draft;
    importTabSnapshot(completed);
    expect(destination.remoteDraft).toBeUndefined();
    importReturnedTabState(returned);
    disposeXterm(id);
    expect(getOrCreateXterm(id).remoteDraft).toBeUndefined();
  });

  // PR8881 merge / unit: real snapshot eviction was absent from SSH component
  // mocks. Preserve close identity/drafts, reject old entry listeners, then restore
  // a failed transition's exit before closing a tab that has only a snapshot.
  it('retains SSH metadata across snapshot restore and failed restart without reviving old close listeners', async () => {
    const id = 'ssh-snapshot';
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { terminal: {
      restart: vi.fn().mockRejectedValue(new Error('restart failed')),
    } } });
    const original = getOrCreateXterm(id);
    original.remoteContext = { sessionId: 'remote-session', deviceId: 'remote-device' };
    original.remoteDraft = { contextKey: 'draft-key', connection: { host: 'old-host' }, submitted: false };
    original.ptyAttached = true;
    const oldResume = vi.fn();
    original.closeCancelledListeners.add(oldResume);
    const exit = { code: 255, signal: null };
    setXtermExit(id, exit);
    expect(await suspendExitedXterm(id)).toBe(true);
    expect(getXterm(id)?.remoteContext).toEqual(original.remoteContext);
    expect(getXterm(id)?.remoteDraft).toEqual(original.remoteDraft);
    markClosing(id);
    const restored = getOrCreateXterm(id);
    await restored.restored;
    expect(restored).not.toBe(original);
    expect(restored.closing).toBe(true);
    const resume = vi.fn();
    restored.closeCancelledListeners.add(resume);
    finishClosing(id);
    expect(resume).toHaveBeenCalledOnce();
    expect(oldResume).not.toHaveBeenCalled();
    expect(restored.remoteContext).toEqual(original.remoteContext);
    expect(restored.remoteDraft).toEqual(original.remoteDraft);
    await expect(restartXterm({ id, cwd: '/', remote: restored.remoteContext })).rejects.toThrow('restart failed');
    expect(restored.pendingTransitions).toBe(0);
    expect(getXtermExit(id)).toEqual(exit);
    expect(await suspendExitedXterm(id)).toBe(true);
    markClosing(id);
    disposeXterm(id);
    finishClosing(id);
    expect(getXterm(id)).toBeUndefined();
    expect(getOrCreateXterm(id).remoteDraft).toBeUndefined();
    expect(getXterm(id)?.remoteContext).toBeUndefined();
  });

  // PR8881 merge / unit: an exit during pending edit must not evict its original
  // entry before success commits intent or failure restores the old connection.
  // Both outcomes use the real pool and drain xterm output before serialization.
  it.each(['success', 'failure'] as const)('settles an unmounted SSH edit before snapshotting (%s)', async outcome => {
    const id = 'ssh-edit';
    let exit!: (event: { id: string; exit: { code: number; signal: null } }) => void;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { terminal: {
      dispose: () => new Promise<void>((yes, no) => { resolve = yes; reject = no; }),
      onData: () => vi.fn(),
      onExit: (listener: typeof exit) => { exit = listener; return vi.fn(); },
    } } });
    const entry = getOrCreateXterm(id);
    entry.remoteContext = { sessionId: 'remote-session' };
    entry.remoteDraft = { contextKey: 'key', connection: { host: 'old-host' }, submitted: true };
    const committed = vi.fn(() => { entry.remoteDraft = { contextKey: 'key', submitted: false }; });
    setXtermExit(id, { code: 0, signal: null });
    const pending = releaseXtermConnection(id, committed);
    detachXterm(id);
    const queuedOldExit = exit;
    exit({ id, exit: { code: 255, signal: null } });
    expect(entry.pendingTransitions).toBe(1);
    expect(await suspendExitedXterm(id)).toBe(false);
    expect(getXterm(id)).toBe(entry);
    if (outcome === 'success') { resolve(); await pending; }
    else { reject(new Error('release failed')); await expect(pending).rejects.toThrow('release failed'); }
    expect(entry.pendingTransitions).toBe(0);
    await vi.waitFor(() => expect(getXterm(id)).not.toBe(entry));
    expect(committed).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
    expect(getXterm(id)?.remoteDraft).toEqual(outcome === 'success'
      ? { contextKey: 'key', submitted: false }
      : { contextKey: 'key', connection: { host: 'old-host' }, submitted: true });
    const restored = getOrCreateXterm(id);
    await restored.restored;
    queuedOldExit({ id, exit: { code: 9, signal: null } });
    expect(getXtermExit(id)).toEqual({ code: 255, signal: null });
  });

  // Unit: #9815 discussion_r4528556652. Native restart removes the old PTY
  // before spawning; a failed spawn must permit a later explicit retry to create it.
  it('recreates a missing PTY on retry after destructive restart failure, retaining output', async () => {
    const params = { id: 'missing', cwd: '/workspace', cols: 100, rows: 30 };
    const result = { shellId: 'zsh' as const, shellDisplayName: 'zsh', pid: 42 };
    const restart = vi.fn()
      .mockRejectedValueOnce(new Error('[TERMINAL_SPAWN_FAILED] restart failed: unavailable cwd'))
      .mockRejectedValueOnce(new Error('[TERMINAL_NOT_FOUND] pty session not found: missing'));
    const create = vi.fn().mockResolvedValue(result);
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { terminal: { restart, create } } });
    const entry = getOrCreateXterm(params.id);
    entry.ptyAttached = true;
    entry.terminal.write('retained before failed restart 中文');
    setXtermExit(params.id, { code: 0, signal: null });
    await expect(restartXterm(params)).rejects.toThrow('TERMINAL_SPAWN_FAILED');
    expect(entry.ptyAttached).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(await restartXterm(params)).toEqual(result);
    expect(create).toHaveBeenCalledExactlyOnceWith(params);
    expect(entry.ptyAttached).toBe(true);
    expect(getXtermExit(params.id)).toBeNull();
    await new Promise<void>(done => entry.terminal.write('', done));
    expect(entry.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('retained before failed restart 中文');
  });

  it('does not recreate a missing PTY after its tab was closed during restart', async () => {
    const params = { id: 'closed-restart', cwd: '/workspace' };
    let reject!: (error: Error) => void;
    const create = vi.fn();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { terminal: {
      restart: () => new Promise((_yes, no) => { reject = no; }), create,
    } } });
    getOrCreateXterm(params.id);
    const pending = restartXterm(params);
    disposeXterm(params.id);
    reject(new Error('[TERMINAL_NOT_FOUND] pty session not found: closed-restart'));
    await expect(pending).rejects.toThrow('TERMINAL_NOT_FOUND');
    expect(create).not.toHaveBeenCalled();
    expect(getXtermExit(params.id)).toBeNull();
  });

  // Unit: #9815 discussion_r4528102349. The old exit must not release a
  // restarted shell whose IPC reply is still pending after the tab unmounts.
  it.each([
    ['restart', 'success'], ['restart', 'failure'],
    ['attach', 'success'], ['attach', 'failure'],
  ] as const)('retains detached events while %s is pending (%s)', async (operation, outcome) => {
    let data!: (event: unknown) => void;
    let exit!: (event: unknown) => void;
    let resolve!: (value: { shellId: 'zsh'; shellDisplayName: string; pid: number }) => void;
    let reject!: (reason: Error) => void;
    const pending = new Promise<{ shellId: 'zsh'; shellDisplayName: string; pid: number }>((yes, no) => { resolve = yes; reject = no; });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { terminal: {
      restart: vi.fn(() => pending),
      create: vi.fn(() => pending),
      onData: (listener: typeof data) => { data = listener; return vi.fn(); },
      onExit: (listener: typeof exit) => { exit = listener; return vi.fn(); },
    } } });
    const entry = getOrCreateXterm('restarting');
    const disposed = vi.spyOn(entry.terminal, 'dispose');
    const oldExit = { code: 0, signal: null };
    setXtermExit('restarting', oldExit);
    const restarted = operation === 'restart' ? restartXterm({ id: 'restarting', cwd: '/workspace' }) : attachXterm({ id: 'restarting', cwd: '/workspace' });
    detachXterm('restarting');
    expect(disposed).not.toHaveBeenCalled();
    // A replacement body subscribes while the old native request is pending.
    const notifyReplacement = vi.fn();
    const offReplacement = onXtermExit('restarting', notifyReplacement);
    if (outcome === 'success') {
      data({ id: 'restarting', chunk: 'output before restart reply 中文\r\n' });
      exit({ id: 'restarting', exit: { code: 7, signal: null } });
      resolve({ shellId: 'zsh', shellDisplayName: 'zsh', pid: 42 });
      await restarted;
      expect(getXtermExit('restarting')).toEqual({ code: 7, signal: null });
      expect(notifyReplacement).toHaveBeenCalledWith({ code: 7, signal: null });
    } else {
      reject(new Error('spawn failed'));
      await expect(restarted).rejects.toThrow('spawn failed');
      expect(getXtermExit('restarting')).toEqual(oldExit);
      expect(notifyReplacement).toHaveBeenCalledWith(oldExit);
    }
    offReplacement();
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce());
    const restored = getOrCreateXterm('restarting');
    await new Promise<void>(done => restored.terminal.write('', done));
    if (outcome === 'success') expect(restored.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('output before restart reply 中文');
  });

  // Unit: exited tabs previously retained the full xterm buffer. Exercise the
  // real parser and serializer, including pending writes and ANSI restoration.
  it('releases an exited view after draining output and restores its colored history', async () => {
    const before = getOrCreateXterm('history');
    before.terminal.resize(80, 24);
    before.ptyAttached = true;
    before.terminal.write('\u001b[32mRetained output 中文😀\u001b[0m\r\nlast line');
    expect(await suspendExitedXterm('history')).toBe(true);
    const restored = getOrCreateXterm('history');
    await new Promise<void>(resolve => restored.terminal.write('', resolve));
    expect(restored.terminal).not.toBe(before.terminal);
    expect(restored.ptyAttached).toBe(true);
    expect(restored.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('Retained output 中文😀');
    expect(restored.terminal.buffer.active.getLine(0)?.getCell(0)?.getFgColor()).toBe(2);
    expect(restored.terminal.buffer.active.getLine(1)?.translateToString(true)).toBe('last line');
    await suspendExitedXterm('history');
    disposeXterm('history');
    const cleared = getOrCreateXterm('history');
    expect(cleared.terminal.buffer.active.getLine(0)?.translateToString(true)).not.toContain('Retained');
  });

  it('cancels pending suspension when the tab is opened again', async () => {
    const entry = getOrCreateXterm('race');
    const pending = suspendExitedXterm('race');
    expect(getOrCreateXterm('race')).toBe(entry);
    expect(await pending).toBe(false);
    expect(getOrCreateXterm('race')).toBe(entry);
  });

  // Unit: switching tasks unmounts TabBody; the old component-only subscriptions
  // lost final output/exit. Send the smallest native data + exit after detaching.
  it('captures output and exit while unmounted, releases the view, then restores history', async () => {
    let data!: (event: unknown) => void;
    let exit!: (event: unknown) => void;
    const offData = vi.fn();
    const offExit = vi.fn();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { terminal: {
      onData: (listener: typeof data) => { data = listener; return offData; },
      onExit: (listener: typeof exit) => { exit = listener; return offExit; },
    } } });
    const entry = getOrCreateXterm('background');
    const disposed = vi.spyOn(entry.terminal, 'dispose');
    detachXterm('background');
    data({ id: 'background', chunk: 'last background output 中文\r\n' });
    exit({ id: 'background', exit: { code: 7, signal: null } });
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce());
    const restored = getOrCreateXterm('background');
    await new Promise<void>(resolve => restored.terminal.write('', resolve));
    expect(restored).not.toBe(entry);
    expect(restored.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('last background output 中文');
    expect(getXtermExit('background')).toEqual({ code: 7, signal: null });
    expect(offData).toHaveBeenCalledOnce();
    expect(offExit).toHaveBeenCalledOnce();
    disposeXterm('background');
    expect(getXtermExit('background')).toBeNull();
  });

  it('settles a pending suspension when a tab is closed', async () => {
    getOrCreateXterm('closing');
    const pending = suspendExitedXterm('closing');
    disposeXterm('closing');
    expect(await pending).toBe(false);
    expect(getOrCreateXterm('closing').terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('');
  });

  it('routes detected URLs through the host external-link bridge', async () => {
    const openExternal = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { openExternal },
    });

    const event = new MouseEvent('click');
    const url = 'https://git.example.com/project/-/merge_requests/42';

    openTerminalExternalLink(event, url);

    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith(url);
    await vi.waitFor(() => expect(warn).not.toHaveBeenCalled());
  });

  it('logs when the host rejects or cannot open the URL', async () => {
    const openExternal = vi.fn().mockResolvedValue({ success: false });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { openExternal },
    });

    openTerminalExternalLink(new MouseEvent('click'), 'https://example.com/rejected');

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('terminal link open rejected or failed');
    });
  });

  it('logs when the external-link IPC call fails', async () => {
    const openExternal = vi.fn().mockRejectedValue(new Error('IPC unavailable'));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { openExternal },
    });

    openTerminalExternalLink(new MouseEvent('click'), 'https://example.com/ipc-error');

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('terminal link open IPC failed');
    });
  });
});
