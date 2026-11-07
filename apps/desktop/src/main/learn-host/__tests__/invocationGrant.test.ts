import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentSkillCommand } from '@cindy/maker-core';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  consumeLearnInvocationGrant,
  canGrantUnqualifiedClaudeLearnInvocation,
  createLearnInvocationGrantConsumer,
  parseDirectLearnInvocation,
} from '../invocationGrant.js';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current.js';
import * as schema from '../../localDb/schema.js';
import { createCindyLearnInvocationCapture } from '../captureInvocation.js';

let activeDb: { sqlite: Database.Database; client: DbClient } | null = null;

function createInvocationDb(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE bot_session_links (session_id TEXT PRIMARY KEY);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cleared_at INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      agent_meta TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
  `);
  const client = {
    drizzle: drizzle(sqlite, { schema }),
    exec: async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).run(...params),
  } as unknown as DbClient;
  setCurrentDbClient(client, 'learn-invocation-test');
  activeDb = { sqlite, client };
  return sqlite;
}

afterEach(() => {
  if (!activeDb) return;
  clearCurrentDbClient(activeDb.client);
  activeDb.sqlite.close();
  activeDb = null;
});

describe('Learn invocation grant', () => {
  // #7381/#8549 (unit): real capture must produce a grant for Pi's
  // /cindy:learn -> skill:learn mapping. Send tests injected a ready grant,
  // so they could not catch the bare namespaced command losing authorization.
  it('captures the trusted Pi runtime Skill for the namespaced Learn invocation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-invocation-capture-'));
    try {
      const skillFile = path.join(root, 'SKILL.md');
      await fs.writeFile(skillFile, '---\nname: learn\n---\nLearn.\n');
      const session = {
        id: 'session-1', instanceId: 'instance-1', agentKind: 'pi' as const,
        workDir: root, remoteHostId: null,
      };
      const builtInSkill: AgentSkillCommand = {
        kind: 'agent-skill', name: 'learn', source: 'user',
        path: skillFile, runtimeCommandName: 'skill:learn',
      };
      let skills = [builtInSkill];
      let enabled = true;
      let currentSession = session;
      const listSkills = vi.fn(async () => ({ skills }));
      const capture = createCindyLearnInvocationCapture({
        getSession: () => currentSession,
        builtInSkillDescriptors: () => [{ name: 'learn', absolutePath: root, nativeClaudePath: root }],
        isSkillEnabled: () => enabled,
        canGrantUnqualifiedClaudeInvocation: async () => true,
        listSkills,
      });
      await expect(capture(session, '/cindy:learn', '/cindy:learn')).resolves.toEqual({
        version: 1,
        sessionInstanceId: session.instanceId,
        resolvedSkillPath: await fs.realpath(skillFile),
      });

      // Neither the spelling nor a discovery-provided builtIn flag proves trust.
      for (const candidates of [
        [{ ...builtInSkill, builtIn: true, path: path.join(root, 'custom', 'SKILL.md') }],
        [builtInSkill, { ...builtInSkill }],
        [{ ...builtInSkill, runtimeCommandName: 'cindy:learn' }],
      ]) {
        skills = candidates;
        await expect(capture(session, '/cindy:learn', '/cindy:learn')).resolves.toBeNull();
      }
      skills = [builtInSkill];
      enabled = false;
      await expect(capture(session, '/cindy:learn', '/cindy:learn')).resolves.toBeNull();
      enabled = true;
      await expect(capture(session, '/cindy:learn other', '/cindy:learn')).resolves.toBeNull();
      listSkills.mockImplementationOnce(async () => {
        currentSession = { ...session, instanceId: 'replaced-instance' };
        return { skills };
      });
      await expect(capture(session, '/cindy:learn', '/cindy:learn')).resolves.toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not attest a Bot-owned /learn alias using the global skill catalog', async () => {
    const sqlite = createInvocationDb();
    sqlite.prepare('INSERT INTO bot_session_links(session_id) VALUES (?)').run('bot-session');
    await expect(canGrantUnqualifiedClaudeLearnInvocation('bot-session')).resolves.toBe(false);
    await expect(canGrantUnqualifiedClaudeLearnInvocation('ordinary-session')).resolves.toBe(true);
  });

  const grant = (sessionInstanceId = 'instance-1') => ({
    version: 1 as const,
    sessionInstanceId,
    resolvedSkillPath: '/cindy/system-skills/v10/learn/SKILL.md',
  });
  const createPersistentConsumer = (
    readLatest: () => Promise<{
      messageId: string;
      text: string;
      grant?: ReturnType<typeof grant> | null;
    }>,
    consumed = new Set<string>(),
    sessionInstanceId = 'instance-1',
  ) => {
    const consume = createLearnInvocationGrantConsumer(
      async () => {
        const latest = await readLatest();
        return {
          ...latest,
          grant: latest.grant === undefined ? grant(sessionInstanceId) : latest.grant,
        };
      },
      async (sessionId, messageId) => {
        const key = `${sessionId}\0${messageId}`;
        if (consumed.has(key)) return false;
        consumed.add(key);
        return true;
      },
    );
    return (request: Parameters<typeof consume>[0]) => consume(request, sessionInstanceId);
  };

  it.each([
    ['/learn', { input: '', sourceKind: 'session' }],
    ['/Learn', { input: '', sourceKind: 'session' }],
    ['/cindy:learn', { input: '', sourceKind: 'session' }],
    ['/cindy:learn release flow', { input: 'release flow', sourceKind: 'freetext' }],
    ['/learn release flow', { input: 'release flow', sourceKind: 'freetext' }],
    ['/LEARN Preserve Release Case', { input: 'Preserve Release Case', sourceKind: 'freetext' }],
    [
      '/skill:learn hub:team:release-notes keep checks',
      {
        input: 'keep checks',
        sourceKind: 'hub',
        hubSlug: 'release-notes',
        hubCatalogScope: 'team',
      },
    ],
    [
      '/SKILL:LEARN hub:market:release-notes keep checks',
      {
        input: 'keep checks',
        sourceKind: 'hub',
        hubSlug: 'release-notes',
        hubCatalogScope: 'market',
      },
    ],
  ])('parses direct Learn invocation %s', (text, expected) => {
    expect(parseDirectLearnInvocation(text)).toEqual(expected);
  });

  it.each([
    '/learner',
    '/other:learn',
    '/cindy:learner',
    '/learning release flow',
    '/skill:learner release flow',
    'please inspect /Learn docs',
  ])('rejects text that is not a direct Learn invocation: %s', (text) => {
    expect(parseDirectLearnInvocation(text)).toBeNull();
  });

  it('rejects ordinary messages and mismatched tool arguments without consuming the grant', async () => {
    const readLatest = vi.fn(async () => ({
      messageId: 'message-1',
      text: '/learn hub:market:release-notes keep   checks',
    }));
    const consume = createPersistentConsumer(readLatest);

    await expect(consume({
      callerSessionId: 'session-1',
      input: 'different request',
      sourceKind: 'freetext',
    })).resolves.toMatchObject({ ok: false, errorCode: 'USER_REQUEST_REQUIRED' });
    await expect(consume({
      callerSessionId: 'session-1',
      input: 'keep checks',
      sourceKind: 'hub',
      hubSlug: 'release-notes',
      hubCatalogScope: 'market',
    })).resolves.toEqual({ ok: true });

    readLatest.mockResolvedValue({ messageId: 'message-2', text: 'please inspect /learn docs' });
    await expect(consume({
      callerSessionId: 'session-1',
      input: '',
      sourceKind: 'session',
    })).resolves.toMatchObject({ ok: false, errorCode: 'USER_REQUEST_REQUIRED' });
  });

  it('consumes each persisted user invocation only once', async () => {
    const consume = createPersistentConsumer(async () => ({
      messageId: 'message-1',
      text: '/Learn release flow',
    }));
    const request = {
      callerSessionId: 'session-1',
      input: 'release flow',
      sourceKind: 'freetext' as const,
    };

    await expect(consume(request)).resolves.toEqual({ ok: true });
    await expect(consume(request)).resolves.toMatchObject({
      ok: false,
      errorCode: 'USER_REQUEST_REQUIRED',
    });
  });

  it('rejects invocations without a main-attested dispatch snapshot', async () => {
    const consume = createPersistentConsumer(async () => ({
      messageId: 'message-1',
      text: '/learn release flow',
      grant: null,
    }));

    await expect(consume({
      callerSessionId: 'session-1',
      input: 'release flow',
      sourceKind: 'freetext',
    })).resolves.toMatchObject({ ok: false, errorCode: 'USER_REQUEST_REQUIRED' });
  });

  it('binds a dispatch snapshot to the exact in-memory Session instance', async () => {
    const consume = createPersistentConsumer(async () => ({
      messageId: 'message-1',
      text: '/learn release flow',
      grant: grant('old-instance'),
    }));

    await expect(consume({
      callerSessionId: 'session-1',
      input: 'release flow',
      sourceKind: 'freetext',
    })).resolves.toMatchObject({ ok: false, errorCode: 'USER_REQUEST_REQUIRED' });
  });

  it('rejects a persisted invocation after the consumer is recreated', async () => {
    const consumed = new Set<string>();
    const readLatest = async () => ({
      messageId: 'message-1',
      text: '/learn release flow',
    });
    const request = {
      callerSessionId: 'session-1',
      input: 'release flow',
      sourceKind: 'freetext' as const,
    };

    await expect(createPersistentConsumer(readLatest, consumed)(request)).resolves.toEqual({
      ok: true,
    });
    await expect(createPersistentConsumer(readLatest, consumed)(request)).resolves.toMatchObject({
      ok: false,
      errorCode: 'USER_REQUEST_REQUIRED',
    });
  });

  it('keeps the original Learn grant current across newer same-turn steer rows', async () => {
    const sqlite = createInvocationDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('session-1');
    const insert = sqlite.prepare(`
      INSERT INTO messages (
        id, client_id, session_id, role, content, agent_meta, created_at, rewind_at
      ) VALUES (?, ?, 'session-1', 'user', ?, ?, 1000, NULL)
    `);
    insert.run(
      'learn-turn',
      'learn-turn-client',
      JSON.stringify({ text: '/learn release flow' }),
      JSON.stringify({ delivery: 'turn', cindyLearnInvocation: grant() }),
    );
    insert.run(
      'same-turn-steer',
      'same-turn-steer-client',
      JSON.stringify({ text: 'also preserve rollback steps' }),
      JSON.stringify({ delivery: 'steer' }),
    );

    await expect(consumeLearnInvocationGrant({
      callerSessionId: 'session-1',
      input: 'release flow',
      sourceKind: 'freetext',
    }, 'instance-1')).resolves.toEqual({ ok: true });
    expect(JSON.parse(sqlite.prepare(
      'SELECT agent_meta FROM messages WHERE id = ?',
    ).pluck().get('learn-turn') as string)).toMatchObject({
      cindyLearnInvocationConsumed: 1,
    });
  });

  it('does not let an old Learn grant cross a later ordinary turn', async () => {
    const sqlite = createInvocationDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('session-1');
    const insert = sqlite.prepare(`
      INSERT INTO messages (
        id, client_id, session_id, role, content, agent_meta, created_at, rewind_at
      ) VALUES (?, ?, 'session-1', 'user', ?, ?, ?, NULL)
    `);
    insert.run(
      'learn-turn',
      'learn-turn-client',
      JSON.stringify({ text: '/learn release flow' }),
      JSON.stringify({ delivery: 'turn', cindyLearnInvocation: grant() }),
      1000,
    );
    insert.run(
      'later-turn',
      'later-turn-client',
      JSON.stringify({ text: 'new task' }),
      JSON.stringify({ delivery: 'turn' }),
      1001,
    );

    await expect(consumeLearnInvocationGrant({
      callerSessionId: 'session-1',
      input: 'release flow',
      sourceKind: 'freetext',
    }, 'instance-1')).resolves.toMatchObject({
      ok: false,
      errorCode: 'USER_REQUEST_REQUIRED',
    });
  });
});
