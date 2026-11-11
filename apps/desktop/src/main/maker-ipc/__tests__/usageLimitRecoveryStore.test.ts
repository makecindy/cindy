// Standard tier: real atomic files, restart and competing consumers. No user profile is touched.
import fs, { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUsageLimitRecoveryStore, type SavedUsageLimitWait } from '../usageLimitRecoveryStore.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cindy-usage-wait-')); dirs.push(root);
  let owner = 'a';
  const create = () => createUsageLimitRecoveryStore({
    filePath: () => join(root, `${owner}.json`), scopeKey: () => owner,
    log: { info() {}, warn() {} },
  });
  const record: SavedUsageLimitWait = {
    id: 'wait-1', sessionId: 'session-1', resumeAt: 9_000_000, attempts: 1, savedAt: 1_000,
    route: 'route', kind: 'active-turn', error: 'weekly limit',
    item: { clientId: 'input-1', text: 'work', persistedContent: 'work', model: 'model',
      effort: 'medium', permissionMode: 'default', workingDir: '/test',
      chatMessage: { role: 'user', content: 'work', clientId: 'input-1' },
      createOpts: { agentKind: 'claude-code', model: 'model', workingDir: '/test' } },
  };
  return { create, record, filePath: () => join(root, `${owner}.json`), setOwner: (next: string) => { owner = next; } };
}

describe('durable quota waiting', () => {
  // #9346 cold INPUT_STOP must not confirm absence from tolerant read defaults.
  // Unit: malformed or inaccessible existing ledgers remain intact and reject
  // strict cancellation discovery; ordinary startup retains its empty fallback.
  it('distinguishes missing and unreadable quota ledgers without overwriting them', async () => {
    const h = fixture(), store = h.create();
    expect(store.readAllStrict()).toEqual([]);
    await store.save(h.record);
    writeFileSync(h.filePath(), '{unreadable');
    expect(h.create().readAll()).toEqual([]);
    expect(() => store.readAllStrict()).toThrow('unavailable');
    expect(readFileSync(h.filePath(), 'utf8')).toBe('{unreadable');
    writeFileSync(h.filePath(), JSON.stringify({ waits: { [h.record.sessionId]: h.record } }));
    expect(store.readAllStrict()).toEqual([h.record]);
  });

  it('does not trust a cached readable quota ledger after an access failure', async () => {
    const h = fixture(), store = h.create();
    await store.save(h.record);
    expect(store.readAll()).toEqual([h.record]);
    const stat = vi.spyOn(fs, 'statSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('access unavailable'), { code: 'EACCES' });
    });
    try { expect(() => store.readAllStrict()).toThrow('unavailable'); }
    finally { stat.mockRestore(); }
    expect(h.create().readAllStrict()).toEqual([h.record]);
  });
  it('restores deadline/input after restart and only one instance can take it', async () => {
    const h = fixture();
    await h.create().save(h.record);
    const restarted = h.create();
    expect(restarted.readAll()).toEqual([h.record]);
    const results = await Promise.all([restarted.take('session-1', 'wait-1'), h.create().take('session-1', 'wait-1')]);
    expect(results.sort()).toEqual([false, true]);
    expect(h.create().readAll()).toEqual([]);
  });

  it('persists cancellation without deleting a newer wait or crossing accounts', async () => {
    const h = fixture(); const store = h.create();
    await store.save(h.record);
    await store.save({ ...h.record, id: 'wait-2' });
    // A stale save that waited for the file lock cannot overwrite the current generation.
    expect(await store.save(h.record, () => false)).toBe(false);
    expect(await store.take('session-1', 'wait-1')).toBe(false);
    h.setOwner('b');
    expect(store.readAll()).toEqual([]);
    expect(await store.take('session-1', 'wait-2')).toBe(false);
    h.setOwner('a');
    expect(store.readAll()[0].id).toBe('wait-2');
    expect(await store.take('session-1', 'wait-2')).toBe(true);
    expect(h.create().readAll()).toEqual([]);
  });
});
