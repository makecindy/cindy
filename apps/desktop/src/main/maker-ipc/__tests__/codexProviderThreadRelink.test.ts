import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { DbClient } from '../../localDb/client/DbClient.js';

import {
  decideCodexProviderThreadRelink,
  isXdOpenAiCodexProviderTransition,
  relinkCodexProviderThread,
  commitCodexThreadTransfer,
} from '../codexProviderThreadRelink.js';

const source = {
  sdkSessionId: 'thread-xd',
  workingDir: '/work',
  model: 'codex/gpt-5.6-sol',
  providerId: 'xd',
  effort: 'xhigh',
  fastMode: true,
};

const target = {
  model: 'gpt-5.6-sol',
  providerId: 'openai',
  effort: 'high',
  fastMode: false,
};

describe('isXdOpenAiCodexProviderTransition', () => {
  it('accepts only the two intended credential-family directions', () => {
    expect(isXdOpenAiCodexProviderTransition('xd', 'openai')).toBe(true);
    expect(isXdOpenAiCodexProviderTransition('openai', 'xd')).toBe(true);
    expect(isXdOpenAiCodexProviderTransition('xd', 'xai')).toBe(false);
    expect(isXdOpenAiCodexProviderTransition(null, 'openai')).toBe(false);
    expect(isXdOpenAiCodexProviderTransition('openai', 'openai')).toBe(false);
  });

  it('recognizes implicit XD Codex routes after credential identity resolution', () => {
    const implicitXd = { providerId: null, model: 'codex/gpt-5.6-sol' };
    const subscription = { providerId: 'openai', model: 'gpt-5.6-sol' };

    expect(decideCodexProviderThreadRelink(implicitXd, subscription)).toBe('relink');
    expect(decideCodexProviderThreadRelink(subscription, implicitXd)).toBe('relink');
    expect(
      decideCodexProviderThreadRelink({ providerId: null, model: 'ambiguous-model' }, subscription),
    ).toBe('unresolved');
  });
});

describe('Codex writer transfer SQLite commit', () => {
  it.each(['unchanged', 'sdk', 'model', 'provider', 'archived', 'revision'])('preserves task identity and rejects stale %s snapshots', async (change) => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, agent_kind TEXT, remote_host_id TEXT, sdk_session_id TEXT, model TEXT, provider_id TEXT, effort TEXT, fast_mode INTEGER, updated_at INTEGER);
      INSERT INTO sessions VALUES ('S', 'active', 'codex', NULL, 'old', 'model', 'openai', 'high', 0, 1);
      INSERT INTO sessions VALUES ('U', 'active', 'codex', NULL, 'unrelated', 'model', 'openai', 'high', 0, 1);
      CREATE TABLE messages (session_id TEXT, content TEXT);
      INSERT INTO messages VALUES ('S', 'retained history');`);
    const db = { drizzle: drizzle(sqlite) } as unknown as Pick<DbClient, 'drizzle'>;
    const snapshot = { id: 'S', sdkSessionId: 'old', model: 'model', providerId: 'openai', effort: 'high' as const, fastMode: false, updatedAt: 1 };
    try {
      const updates: Record<string, string> = {
        sdk: "sdk_session_id = 'newer'", model: "model = 'newer'", provider: "provider_id = 'newer'",
        archived: "status = 'archived'", revision: 'updated_at = 2',
      };
      if (updates[change]) sqlite.exec(`UPDATE sessions SET ${updates[change]} WHERE id = 'S'`);
      const before = sqlite.prepare('SELECT * FROM sessions ORDER BY id').all();
      expect(await commitCodexThreadTransfer(db, snapshot, { sdkSessionId: 'child', model: 'target', providerId: 'cprov-fixture', fastMode: true })).toBe(change === 'unchanged');
      const after = sqlite.prepare('SELECT * FROM sessions ORDER BY id').all();
      expect(after[1]).toEqual(before[1]);
      if (change !== 'unchanged') expect(after).toEqual(before);
      else expect(after[0]).toMatchObject({ id: 'S', sdk_session_id: 'child', model: 'target', provider_id: 'cprov-fixture', effort: 'high', fast_mode: 1 });
      expect(sqlite.prepare('SELECT * FROM messages').all()).toEqual([{ session_id: 'S', content: 'retained history' }]);
    } finally { sqlite.close(); }
  });
});

describe('relinkCodexProviderThread', () => {
  it('keeps the native thread when closing the source has already released its writer', async () => {
    const fork = vi.fn();
    const commit = vi.fn(async () => true);
    const result = await relinkCodexProviderThread({
      readSource: async () => source,
      needsFork: async () => false,
      fork, commit,
    }, { sessionId: 'released', target });
    expect(fork).not.toHaveBeenCalled();
    expect(result?.newSdkSessionId).toBe(source.sdkSessionId);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ newSdkSessionId: source.sdkSessionId, target }));
  });

  it.each([
    {
      name: 'implicit XD to OpenAI',
      source: { ...source, providerId: null, model: 'codex/gpt-5.6-sol' },
      target,
    },
    {
      name: 'OpenAI to implicit XD fixed-effort model',
      source: {
        ...source,
        sdkSessionId: 'thread-openai',
        providerId: 'openai',
        model: 'gpt-5.6-sol',
      },
      target: {
        model: 'codex/gpt-5.6-sol',
        providerId: null,
        effort: null,
        fastMode: true,
      },
    },
  ])('forks and CAS-commits the complete route for $name', async ({ source, target }) => {
    const cleanup = vi.fn(async () => {});
    const fork = vi.fn(async () => ({ newSdkSessionId: 'thread-replacement', cleanup }));
    const commit = vi.fn(async () => true);

    expect(decideCodexProviderThreadRelink(source, target)).toBe('relink');
    await expect(
      relinkCodexProviderThread(
        { readSource: vi.fn(async () => source), fork, commit },
        { sessionId: 'session-implicit-provider', target },
      ),
    ).resolves.toEqual({
      previousSdkSessionId: source.sdkSessionId,
      newSdkSessionId: 'thread-replacement',
    });

    expect(fork).toHaveBeenCalledWith({
      sourceSdkSessionId: source.sdkSessionId,
      sourceModel: source.model,
      sourceProviderId: source.providerId,
      workingDir: source.workingDir,
    });
    expect(commit).toHaveBeenCalledWith({
      sessionId: 'session-implicit-provider',
      source,
      newSdkSessionId: 'thread-replacement',
      target,
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('forks with source credentials and CAS-commits the full target route', async () => {
    const fork = vi.fn(async () => ({ newSdkSessionId: 'thread-openai' }));
    const commit = vi.fn(async () => true);

    await expect(
      relinkCodexProviderThread(
        { readSource: vi.fn(async () => source), fork, commit },
        { sessionId: 'session-1', target },
      ),
    ).resolves.toEqual({
      previousSdkSessionId: 'thread-xd',
      newSdkSessionId: 'thread-openai',
    });

    expect(fork).toHaveBeenCalledWith({
      sourceSdkSessionId: 'thread-xd',
      sourceModel: 'codex/gpt-5.6-sol',
      sourceProviderId: 'xd',
      workingDir: '/work',
    });
    expect(commit).toHaveBeenCalledWith({
      sessionId: 'session-1',
      source,
      newSdkSessionId: 'thread-openai',
      target,
    });
  });

  it('does not fork when the task has no persisted native thread', async () => {
    const fork = vi.fn();
    const commit = vi.fn();
    await expect(
      relinkCodexProviderThread(
        { readSource: vi.fn(async () => ({ ...source, sdkSessionId: null })), fork, commit },
        { sessionId: 'session-1', target },
      ),
    ).resolves.toBeNull();
    expect(fork).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('fails closed when the source tuple is superseded before CAS commit', async () => {
    const cleanup = vi.fn(async () => {});
    await expect(
      relinkCodexProviderThread(
        {
          readSource: vi.fn(async () => source),
          fork: vi.fn(async () => ({ newSdkSessionId: 'thread-openai', cleanup })),
          commit: vi.fn(async () => false),
        },
        { sessionId: 'session-1', target },
      ),
    ).rejects.toThrow(/superseded/);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('preserves the database error when replacement cleanup also fails', async () => {
    const databaseError = new Error('route CAS failed');
    const cleanup = vi.fn(async () => {
      throw new Error('replacement cleanup failed');
    });
    await expect(
      relinkCodexProviderThread(
        {
          readSource: vi.fn(async () => source),
          fork: vi.fn(async () => ({ newSdkSessionId: 'thread-openai', cleanup })),
          commit: vi.fn(async () => {
            throw databaseError;
          }),
        },
        { sessionId: 'session-1', target },
      ),
    ).rejects.toBe(databaseError);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
