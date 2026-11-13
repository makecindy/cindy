import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import type { BlueBubblesState } from '@cindy/im';
import { blueBubblesStateStorage } from '../storage';

const h = vi.hoisted(() => ({ directory: '' }));
vi.mock('../../ownerScopedStorage', () => ({ ownerScopedImUserDataPath: (...parts: string[]) => path.join(h.directory, ...parts) }));
h.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-imessage-receipts-'));
afterAll(() => fs.rmSync(h.directory, { recursive: true, force: true }));

// Tier 1: real host persistence, representative nonempty history and interrupted append.
// Transport tests use memory storage and cannot detect checkpoint/journal data loss.
it('preserves 11002 existing receipts, new confirmations and uncertain sends across reopen and a torn append', () => {
  const storage = blueBubblesStateStorage('0123456789ab');
  const initial: BlueBubblesState = { version: 1, activatedAt: 1, cursors: { owner: 500 }, inbox: {}, outbox: {} };
  for (let i = 0; i < 11002; i++) initial.inbox[`msg-${i}`] = { receivedAt: i + 1, state: 'accepted' };
  initial.chatActivatedAt = { 'any;-;new@example.test': 12000 };
  storage.write(initial);
  storage.update!({ kind: 'inbox', id: 'new', value: { receivedAt: 12000, state: 'dispatching' } });
  const stop = { receivedAt: 12001, state: 'accepted' as const,
    stop: { chatId: 'owner', sentAt: 12001, before: ['unverified-guid'] } };
  storage.update!({ kind: 'inbox', id: 'stop', value: stop });
  storage.update!({ kind: 'outbox', id: 'outgoing', value: { chatId: 'owner', state: 'unknown' } });
  const file = path.join(h.directory, 'imessage', '0123456789ab.json.journal');
  fs.appendFileSync(file, '{"kind":"inbox"');
  const reopened = blueBubblesStateStorage('0123456789ab');
  const restored = reopened.read()!;
  expect(Object.keys(restored.inbox)).toHaveLength(11004);
  expect(restored.inbox['msg-11001']).toEqual(initial.inbox['msg-11001']);
  expect(restored.inbox.new.state).toBe('dispatching');
  expect(restored.inbox.stop).toEqual(stop);
  expect(restored.outbox.outgoing.state).toBe('unknown');
  expect(restored.cursors).toEqual({ owner: 500 });
  expect(restored.chatActivatedAt).toEqual(initial.chatActivatedAt);
  reopened.update!({ kind: 'inbox', id: 'new', value: { receivedAt: 12000, state: 'accepted' } });
  expect(blueBubblesStateStorage('0123456789ab').read()!.inbox.new.state).toBe('accepted');
});

// Tier 1, #9250 review4503403200: a failed append followed by a successful
// append used to turn a recoverable torn tail into an unreadable complete line.
// Existing restart coverage never continued writing after the partial failure.
it.each([false, true])('recovers from partial ENOSPC before accepting another append (rollback fails: %s)', rollbackFails => {
  const id = rollbackFails ? '0123456789ad' : '0123456789ac';
  const storage = blueBubblesStateStorage(id);
  storage.write({ version: 1, activatedAt: 1, cursors: { owner: 500 }, inbox: {
    previous: { receivedAt: 1, state: 'accepted' },
  }, outbox: {} });
  const journal = path.join(h.directory, 'imessage', `${id}.json.journal`);
  const before = fs.readFileSync(journal, 'utf8');
  const write = fs.writeFileSync;
  const ftruncate = fs.ftruncateSync;
  let appendFd: number | undefined;
  const diskFull = Object.assign(new Error('test disk full'), { code: 'ENOSPC' });
  const append = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((file, data) => {
    if (typeof file === 'number') appendFd = file;
    write(file, Buffer.from(String(data)).subarray(0, 12));
    throw diskFull;
  });
  // Windows O_APPEND lacks FILE_WRITE_DATA, which truncation requires. Model
  // that permission on all platforms, retaining real file I/O for writable fds.
  // CI run42406330220 exposed the otherwise macOS-only passing rollback.
  const truncate = vi.spyOn(fs, 'ftruncateSync').mockImplementation((fd, length) => {
    if (rollbackFails) throw Object.assign(new Error('test rollback failed'), { code: 'EIO' });
    if (fd === appendFd) throw Object.assign(new Error('append handle cannot truncate'), { code: 'EPERM' });
    ftruncate(fd, length);
  });
  const next = { kind: 'inbox' as const, id: 'next', value: { receivedAt: 3, state: 'pending' as const } };
  try {
    expect(() => storage.update!({ kind: 'inbox', id: 'failed', value: { receivedAt: 2, state: 'pending' } })).toThrow(diskFull);
    if (rollbackFails) {
      const broken = fs.readFileSync(journal, 'utf8');
      expect(() => storage.update!(next)).toThrow('BLUEBUBBLES_RECEIPT_JOURNAL_NEEDS_REPAIR');
      expect(fs.readFileSync(journal, 'utf8')).toBe(broken);
      // Explicit reload repairs the torn tail before this instance can append.
      expect(storage.read()!.inbox.failed).toBeUndefined();
    } else {
      expect(fs.readFileSync(journal, 'utf8')).toBe(before);
    }
    storage.update!(next);
    const restored = blueBubblesStateStorage(id).read()!;
    expect(restored.inbox).toEqual({ previous: { receivedAt: 1, state: 'accepted' }, next: next.value });
    expect(restored.cursors).toEqual({ owner: 500 });
  } finally { append.mockRestore(); truncate.mockRestore(); }
});
