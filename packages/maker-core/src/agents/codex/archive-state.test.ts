import { describe, expect, it, vi } from 'vitest';
import { syncCodexArchiveState } from './archive-state.js';

describe('native archive projection', () => {
  it.each(['/', '\\'])('uses the closest storage bucket beneath a same-named ancestor (%s)', async separator => {
    let archived = false;
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/archive') archived = true;
      if (method === 'thread/unarchive') archived = false;
      return { thread: { id: 'thread', path: ['root', 'archived_sessions', 'codex',
        archived ? 'archived_sessions' : 'sessions', '2026', '09', 'history.jsonl'].join(separator) } };
    });
    const invoke = request as Parameters<typeof syncCodexArchiveState>[0];
    await syncCodexArchiveState(invoke, 'thread', false, () => {});
    expect(request).toHaveBeenCalledTimes(1);
    await syncCodexArchiveState(invoke, 'thread', true, () => {});
    expect(request).toHaveBeenCalledWith('thread/archive', { threadId: 'thread' });
    await syncCodexArchiveState(invoke, 'thread', false, () => {});
    expect(request).toHaveBeenCalledWith('thread/unarchive', { threadId: 'thread' });
  });

  it.each(['/', '\\'])('archives and restores through native APIs with %s paths', async separator => {
    let archived = false;
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/archive') archived = true;
      if (method === 'thread/unarchive') archived = false;
      return { thread: { id: 'thread', path: ['root', archived ? 'archived_sessions' : 'sessions', 'history.jsonl'].join(separator) } };
    });
    const invoke = request as Parameters<typeof syncCodexArchiveState>[0];
    const archivedPath = await syncCodexArchiveState(invoke, 'thread', true, () => {});
    expect(archivedPath).toContain('archived_sessions');
    await syncCodexArchiveState(invoke, 'thread', true, () => {});
    expect(request.mock.calls.filter(([method]) => method === 'thread/archive')).toHaveLength(1);
    expect(await syncCodexArchiveState(invoke, 'thread', false, () => {})).not.toContain('archived_sessions');
    expect(request.mock.calls.filter(([method]) => method === 'thread/unarchive')).toHaveLength(1);
    expect(request).toHaveBeenCalledWith('thread/read', { threadId: 'thread', includeTurns: false });
  });

  it('rejects stale ownership before any native mutation', async () => {
    const request = vi.fn(async () => ({ thread: { id: 't', path: '/sessions/history.jsonl' } }));
    await expect(syncCodexArchiveState(request as Parameters<typeof syncCodexArchiveState>[0], 't', true,
      () => { throw new Error('owner changed'); })).rejects.toThrow('owner changed');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not archive a running native thread', async () => {
    const request = vi.fn(async () => ({ thread: { id: 't', path: '/sessions/history.jsonl', status: { type: 'active' } } }));
    await expect(syncCodexArchiveState(request as Parameters<typeof syncCodexArchiveState>[0], 't', true, () => {}))
      .rejects.toThrow('busy');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not claim success when native storage did not change', async () => {
    const request = vi.fn(async () => ({ thread: { id: 't', path: '/sessions/history.jsonl' } }));
    await expect(syncCodexArchiveState(request as Parameters<typeof syncCodexArchiveState>[0], 't', true, () => {}))
      .rejects.toThrow('did not converge');
  });
});
