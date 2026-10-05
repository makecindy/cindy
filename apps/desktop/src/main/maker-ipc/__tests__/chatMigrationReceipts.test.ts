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

it('restores device workspace choices in the same account without sharing them with another owner', () => {
  fixture.root = mkdtempSync(path.join(tmpdir(), 'cindy-chat-workspace-'));
  const room = '10000000-0000-4000-8000-000000000001';
  const value = { projectDir: '/private/project', plans: { plan: { workDir: '/private/project/step', branch: 'work', ownerSessionId: null } } };
  let current = true;
  const store = chatServerWorkspaces('https://chat.example.test', 'alice', () => current);
  store.save(room, value);
  expect(chatServerWorkspaces('https://chat.example.test', 'alice', () => true).read(room)).toEqual(value);
  expect(chatServerWorkspaces('https://chat.example.test', 'bob', () => true).read(room)).toBeNull();
  current = false;
  expect(() => store.save(room, value)).toThrow('OWNER_CHANGED');
});
