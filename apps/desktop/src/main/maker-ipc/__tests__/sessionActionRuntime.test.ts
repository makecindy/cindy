import { describe, expect, it, vi } from 'vitest';
import { createSessionActionRuntime } from '../sessionActionRuntime.js';

// Real history preparation entry: cold rewind/export/compact formerly required a
// user turn (or silently did nothing). Existing tree tests only scanned source.
// Unit tier, minimal input: a durable active row and no in-memory session.
function harness(overrides = {}) {
  const row = { status: 'active', agentKind: 'cc', sdkSessionId: 'native-1',
    providerId: null, remoteHostId: 'ssh-1', ...overrides };
  let live: typeof row | undefined;
  let owner = 1;
  const resume = vi.fn(async (_id: string, stored: typeof row, assertCurrent: () => void) => {
    assertCurrent();
    live = stored;
    return stored;
  });
  const load = vi.fn(async () => row as typeof row | undefined);
  const close = vi.fn(async () => { live = undefined; });
  return { row, resume, load, close, changeOwner: () => { owner++; },
    prepare: createSessionActionRuntime({ getLive: () => live, load,
      ownerGeneration: () => owner, resume, close,
      holdsPendingRewind: (stored) => stored.agentKind === 'cc' }) };
}

describe('history action runtime preparation', () => {
  it.each(['cc', 'codex', 'pi'])('restores %s exactly once under concurrent requests', async (agentKind) => {
    const h = harness({ agentKind });
    const results = await Promise.all([h.prepare('s', 'rewind'), h.prepare('s', 'rewind')]);
    expect(results).toEqual([h.row, h.row]);
    expect(h.resume).toHaveBeenCalledTimes(1);
    expect(h.resume.mock.calls[0]?.[1]).toMatchObject({ sdkSessionId: 'native-1', providerId: null, remoteHostId: 'ssh-1' });
  });
  it.each(['archived', 'deleted'])('does not reactivate %s history', async (status) => {
    const h = harness({ status });
    await expect(h.prepare('s', 'rewind')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(h.resume).not.toHaveBeenCalled();
  });
  it('keeps detached Claude rewind DB-only but refuses an empty Pi history', async () => {
    const h = harness({ sdkSessionId: null });
    await expect(h.prepare('s', 'rewind')).resolves.toBeNull();
    expect(h.resume).not.toHaveBeenCalled();
    await expect(harness({ agentKind: 'pi', sdkSessionId: null }).prepare('p', 'pi-history'))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
  it('restores Pi for tree/export/compact and leaves unsupported engines alone', async () => {
    const pi = harness({ agentKind: 'pi' });
    await expect(pi.prepare('p', 'pi-history')).resolves.toEqual(pi.row);
    const cc = harness();
    await expect(cc.prepare('s', 'pi-history')).resolves.toBeNull();
    expect(cc.resume).not.toHaveBeenCalled();
  });
  it.each(['pi', 'codex'])('restores %s before manual compaction', async (agentKind) => {
    const h = harness({ agentKind });
    await expect(h.prepare('s', 'compact')).resolves.toEqual(h.row);
  });
  it('preserves lookup and native restoration errors without a fresh-session fallback', async () => {
    const h = harness();
    h.load.mockRejectedValueOnce(new Error('db offline'));
    await expect(h.prepare('s', 'rewind')).rejects.toThrow('db offline');
    expect(h.resume).not.toHaveBeenCalled();
    h.resume.mockRejectedValueOnce(new Error('native missing'));
    await expect(h.prepare('s', 'rewind')).rejects.toThrow('native missing');
    expect(h.resume).toHaveBeenCalledTimes(1);
  });
  it('does not start a task in a different account after an asynchronous lookup', async () => {
    const h = harness();
    h.load.mockImplementationOnce(async () => { h.changeOwner(); return h.row; });
    await expect(h.prepare('s', 'rewind')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(h.resume).not.toHaveBeenCalled();
  });
  it('reports a missing task distinctly', async () => {
    const h = harness(); h.load.mockResolvedValueOnce(undefined);
    await expect(h.prepare('s', 'rewind')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  // The personal prompt / memory switch live only in the renderer, so a runtime
  // restored for history must not be reused by the next send.
  it('closes only the runtime it restored, once, when the action is done', async () => {
    const h = harness();
    await h.prepare('s', 'rewind');
    await h.prepare.release('s');
    await h.prepare.release('s');
    expect(h.close).toHaveBeenCalledTimes(1);
    const live = harness();
    await live.prepare('s', 'pi-history');
    await live.prepare.release('s');
    expect(live.close).not.toHaveBeenCalled();
  });
  it('keeps a Claude runtime after a committed rewind so its pending native rewind survives', async () => {
    const claude = harness({ agentKind: 'cc' });
    await claude.prepare('s', 'rewind');
    await claude.prepare.release('s', { rewindCommitted: true });
    expect(claude.close).not.toHaveBeenCalled();
    const failed = harness({ agentKind: 'cc' });
    await failed.prepare('s', 'rewind');
    await failed.prepare.release('s', { rewindCommitted: false });
    expect(failed.close).toHaveBeenCalledTimes(1);
    const codex = harness({ agentKind: 'codex' });
    await codex.prepare('s', 'rewind');
    await codex.prepare.release('s', { rewindCommitted: true });
    expect(codex.close).toHaveBeenCalledTimes(1);
  });
  it.each(['rewind', 'compact'] as const)('refuses %s for a task whose Agent runs on another computer', async (action) => {
    const h = harness({ agentKind: 'codex', remoteHostId: null, agentDeviceId: 'device-2' });
    await expect(h.prepare('s', action)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(h.resume).not.toHaveBeenCalled();
  });
});
