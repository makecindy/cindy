import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { HeadlessSessionStorage } from './session-storage.js';

const tempDirs: string[] = [];

function makeStorage(): HeadlessSessionStorage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-storage-'));
  tempDirs.push(dir);
  return new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('HeadlessSessionStorage', () => {
  it('persists the maker session metadata required for resume', async () => {
    const storage = makeStorage();
    const created = await storage.create({
      id: 'session-1',
      agentKind: 'codex',
      providerId: 'openai',
      workDir: '/srv/project',
      title: 'Implement host',
      model: 'gpt-5.6',
      workspaceKind: 'project',
      effort: 'high',
      permissionMode: 'ask',
      fastMode: true,
      sdkSessionId: 'thread-1',
    });

    expect(created.createdAt).toBeGreaterThan(0);
    expect(await storage.get('session-1')).toMatchObject({
      agentKind: 'codex',
      providerId: 'openai',
      model: 'gpt-5.6',
      sdkSessionId: 'thread-1',
      fastMode: true,
    });
    storage.close();
  });

  it('clears a stale SDK id atomically', async () => {
    const storage = makeStorage();
    await storage.create({
      id: 'session-1', agentKind: 'claude-code', workDir: '/srv/project',
      title: 'Claude', model: 'claude-sonnet-4-6', sdkSessionId: 'sdk-old',
    });

    await expect(storage.compareAndClearSdkSessionId('session-1', 'sdk-other')).resolves.toBe(false);
    await expect(storage.compareAndClearSdkSessionId('session-1', 'sdk-old')).resolves.toBe(true);
    await expect(storage.get('session-1')).resolves.toMatchObject({ sdkSessionId: undefined });
    storage.close();
  });

  it('keeps a cursor-addressable event history for reattached controllers', async () => {
    const storage = makeStorage();
    await storage.create({
      id: 'session-1', agentKind: 'codex', workDir: '/srv/project', title: 'Codex', model: 'gpt-5.6',
    });
    const first = await storage.appendEvent('session-1', 'user_message', { content: 'hello' });
    await storage.appendEvent('session-1', 'agent_event', { type: 'text', data: 'hi' });

    expect(first.sequence).toBeGreaterThan(0);
    await expect(storage.listEvents('session-1', first.sequence)).resolves.toEqual([
      expect.objectContaining({ type: 'agent_event', data: { type: 'text', data: 'hi' } }),
    ]);
    storage.close();
  });

  it('rebuilds the structured history projection from an older append-only event database', async () => {
    const storage = makeStorage();
    await storage.create({ id: 'session-1', agentKind: 'claude-code', workDir: '/srv/project', title: 'Claude', model: 'claude' });
    await storage.appendEvent('session-1', 'user_message', { content: 'legacy question' });
    await storage.appendEvent('session-1', 'agent_event', {
      type: 'text', data: { text: 'legacy answer', isFinal: true }, agentMeta: { uuid: 'legacy-a' },
    });
    const file = (storage as unknown as { db: Database.Database }).db;
    file.prepare('DELETE FROM headless_history_messages').run();
    storage.close();

    const reopened = new HeadlessSessionStorage(path.join(tempDirs.at(-1)!, 'sessions.db'));
    await expect(reopened.listHistoryMessages('session-1')).resolves.toEqual([
      expect.objectContaining({ role: 'user', content: 'legacy question', clientId: 'headless-event-1' }),
      expect.objectContaining({ role: 'assistant', content: 'legacy answer', agentMeta: { uuid: 'legacy-a' } }),
    ]);
    reopened.close();
  });
});
