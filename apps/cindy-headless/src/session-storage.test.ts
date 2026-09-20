import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteSessionStorage } from './session-storage.js';

describe('SqliteSessionStorage', () => {
  it('persists session metadata and clears the expected SDK id atomically', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-headless-session-'));
    const file = path.join(dir, 'sessions.sqlite');
    const first = new SqliteSessionStorage(file);
    await first.create({ id: 'session-1', agentKind: 'codex', workDir: dir, title: 'test', model: 'gpt-test', sdkSessionId: 'sdk-1' });
    first.close();

    const reopened = new SqliteSessionStorage(file);
    expect((await reopened.get('session-1'))?.sdkSessionId).toBe('sdk-1');
    expect(await reopened.compareAndClearSdkSessionId('session-1', 'wrong')).toBe(false);
    expect(await reopened.compareAndClearSdkSessionId('session-1', 'sdk-1')).toBe(true);
    expect(await reopened.compareAndClearSdkSessionId('session-1', 'sdk-1')).toBe(false);
    expect((await reopened.get('session-1'))?.sdkSessionId).toBeUndefined();
    reopened.close();
  });
});
