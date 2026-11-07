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
  storage.write(initial);
  storage.update!({ kind: 'inbox', id: 'new', value: { receivedAt: 12000, state: 'dispatching' } });
  storage.update!({ kind: 'outbox', id: 'outgoing', value: { chatId: 'owner', state: 'unknown' } });
  const file = path.join(h.directory, 'imessage', '0123456789ab.json.journal');
  fs.appendFileSync(file, '{"kind":"inbox"');
  const reopened = blueBubblesStateStorage('0123456789ab');
  const restored = reopened.read()!;
  expect(Object.keys(restored.inbox)).toHaveLength(11003);
  expect(restored.inbox['msg-11001']).toEqual(initial.inbox['msg-11001']);
  expect(restored.inbox.new.state).toBe('dispatching');
  expect(restored.outbox.outgoing.state).toBe('unknown');
  expect(restored.cursors).toEqual({ owner: 500 });
  reopened.update!({ kind: 'inbox', id: 'new', value: { receivedAt: 12000, state: 'accepted' } });
  expect(blueBubblesStateStorage('0123456789ab').read()!.inbox.new.state).toBe('accepted');
});
