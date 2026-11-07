import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../../appSessionState.js', () => ({ ownerScopedUserDataPath: (...parts: string[]) => path.join(fixture.root, ...parts) }));
import { chatServerWorkspaces } from '../chatServerWorkspaces.js';
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

it('persists terminal migration failures by account and server', () => {
  fixture.root = mkdtempSync(path.join(tmpdir(), 'cindy-chat-migration-failure-'));
  const group = '10000000-0000-4000-8000-000000000001';
  let current = true;
  const store = chatMigrationReceipts('https://chat.example.test', 'alice', () => current);
  expect(store.readFailure(group)).toBeNull();
  store.saveFailure(group, 'CONVERSATION_ARCHIVED');
  expect(chatMigrationReceipts('https://chat.example.test', 'alice', () => true).readFailure(group))
    .toEqual({ version: 1, code: 'CONVERSATION_ARCHIVED' });
  expect(chatMigrationReceipts('https://chat.example.test', 'bob', () => true).readFailure(group)).toBeNull();
  expect(chatMigrationReceipts('https://other.example.test', 'alice', () => true).readFailure(group)).toBeNull();
  current = false;
  expect(() => store.readFailure(group)).toThrow('OWNER_CHANGED');
  expect(() => store.saveFailure(group, 'CONVERSATION_NOT_FOUND')).toThrow('OWNER_CHANGED');
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
