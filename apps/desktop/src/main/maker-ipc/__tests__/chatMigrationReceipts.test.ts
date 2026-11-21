import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../../appSessionState.js', () => ({ ownerScopedUserDataPath: (...parts: string[]) => path.join(fixture.root, ...parts) }));
import { chatServerTaskCards, chatServerWorkspaces, type ChatLiveTaskCardRecord } from '../chatServerWorkspaces.js';
import { chatMigrationReceipts } from '../chatMigrationReceipts.js';
afterEach(() => { if (fixture.root) rmSync(fixture.root, { recursive: true, force: true }); });

it('isolates completed imports by account and server and refuses stale owner access', () => {
  fixture.root = mkdtempSync(path.join(tmpdir(), 'cindy-chat-receipt-'));
  const group = '10000000-0000-4000-8000-000000000001';
  const receipt = { roomId: '10000000-0000-4000-8000-000000000002', sequence: 150 };
  let current = true;
  const store = chatMigrationReceipts('https://chat.example.test', 'alice', () => current);
  expect(store.read(group)).toBeNull();
  store.save(group, receipt);
  expect(chatMigrationReceipts('https://chat.example.test', 'alice', () => true).read(group)).toEqual(receipt);
  expect(chatMigrationReceipts('https://chat.example.test', 'bob', () => true).read(group)).toBeNull();
  expect(chatMigrationReceipts('https://other.example.test', 'alice', () => true).read(group)).toBeNull();
  current = false;
  expect(() => store.read(group)).toThrow('OWNER_CHANGED');
  expect(() => store.save(group, receipt)).toThrow('OWNER_CHANGED');
});

it('restores device workspace choices in the same account without sharing them with another owner', () => {
  fixture.root = mkdtempSync(path.join(tmpdir(), 'cindy-chat-workspace-'));
  const room = '10000000-0000-4000-8000-000000000001';
  const value = { projectDir: '/private/project', plans: { plan: { workDir: '/private/project/step', branch: 'work', ownerSessionId: null } } };
  let current = true;
  const store = chatServerWorkspaces('https://chat.example.test', 'alice', () => current);
  store.save(room, value);
  expect(chatServerWorkspaces('https://chat.example.test', 'alice', () => true).read(room)).toEqual(value);
  // Existing nonempty preferences survive adding progress, and a fresh store reads
  // exact sequence strings. This supplies restart/old-format coverage for the group latency fix.
  const upgraded = { ...store.read(room)!, attachmentAfter: { 'lane-owner': '9007199254740993', 'lane-chat': '12' } };
  store.save(room, upgraded);
  expect(chatServerWorkspaces('https://chat.example.test', 'alice', () => true).read(room)).toEqual(upgraded);
  expect(chatServerWorkspaces('https://other.example.test', 'alice', () => true).read(room)).toBeNull();
  expect(chatServerWorkspaces('https://chat.example.test', 'bob', () => true).read(room)).toBeNull();
  current = false;
  expect(() => store.save(room, value)).toThrow('OWNER_CHANGED');
});

// The task card store keeps what it last read while the file is unchanged (a sync pass reads it per
// card); a cached read must still see a file replaced or removed outside this store, never hand out a
// map whose change would leak into the next read, and still refuse a stale owner.
it('reads task cards as the file now is, through the cache of its last read', () => {
  fixture.root = mkdtempSync(path.join(tmpdir(), 'cindy-chat-task-cards-'));
  const card: ChatLiveTaskCardRecord = { roomId: '10000000-0000-4000-8000-000000000001', botId: '10000000-0000-4000-8000-000000000002',
    threadRootId: null, taskId: 'task-1', deviceId: null, title: 'Fix login', requesterName: 'Owner', botName: 'Bot', state: 'idle',
    revision: 1, createdAt: 1, requesterId: null };
  let current = true;
  const store = chatServerTaskCards('https://chat.example.test', 'alice', () => current);
  store.save({ a: card });
  const first = store.read();
  delete first.a;
  expect(store.read()).toEqual({ a: card });
  // The cache holds one file: another account's store in between reads its own cards, never these.
  expect(chatServerTaskCards('https://chat.example.test', 'bob', () => true).read()).toEqual({});
  expect(store.read()).toEqual({ a: card });
  const settings = path.join(fixture.root, 'chat-workspace-settings');
  const file = path.join(settings, readdirSync(settings)[0]!, 'task-cards.json');
  writeFileSync(file, JSON.stringify({ b: { ...card, title: 'Renamed elsewhere' } }));
  expect(store.read()).toEqual({ b: { ...card, title: 'Renamed elsewhere' } });
  rmSync(file);
  expect(store.read()).toEqual({});
  store.save({ a: card });
  store.read();
  current = false;
  expect(() => store.read()).toThrow('OWNER_CHANGED');
});
