import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbClient } from '../client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current.js';
import * as schema from '../schema.js';
import {
  getSubagentRunDetail,
  listSubagentRuns,
  persistSubagentTaskUpdate,
} from '../subagentRuns.js';

describe('durable Subagent runs', () => {
  let rawDb: Database.Database;
  let client: DbClient;

  beforeEach(() => {
    rawDb = new Database(':memory:');
    rawDb.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active',
        cleared_at INTEGER
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_use_id TEXT,
        created_at INTEGER NOT NULL,
        rewind_at INTEGER
      );
      CREATE TABLE subagent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        logical_agent_id TEXT NOT NULL,
        parent_tool_use_id TEXT,
        aliases TEXT NOT NULL DEFAULT '[]',
        provider_run_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'running',
        title TEXT,
        description TEXT,
        summary TEXT,
        model TEXT,
        reasoning_effort TEXT,
        total_tokens INTEGER,
        tool_uses INTEGER,
        duration_ms INTEGER,
        capabilities TEXT NOT NULL DEFAULT '{}',
        activity TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ended_at INTEGER,
        rewind_at INTEGER,
        deleted_at INTEGER
      );
      CREATE INDEX subagent_runs_logical_idx
        ON subagent_runs (session_id, provider, logical_agent_id);
      CREATE INDEX subagent_runs_session_idx
        ON subagent_runs (session_id, rewind_at, deleted_at, started_at);
      CREATE INDEX subagent_runs_parent_tool_use_idx
        ON subagent_runs (session_id, parent_tool_use_id);
      CREATE TABLE subagent_run_aliases (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        alias TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES subagent_runs(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, alias)
      );
      CREATE INDEX subagent_run_aliases_lookup_idx
        ON subagent_run_aliases (session_id, provider, alias, created_at);
    `);
    const db = drizzle(rawDb, { schema });
    client = {
      query: async <T = unknown>(sql: string, params: unknown[] = []) =>
        rawDb.prepare(sql).all(...params) as T[],
      queryOne: async <T = unknown>(sql: string, params: unknown[] = []) =>
        rawDb.prepare(sql).get(...params) as T | undefined,
      exec: async (sql, params = []) => rawDb.prepare(sql).run(...params),
      tx: async () => {
        throw new Error('tx is not used by this test');
      },
      drizzle: db,
      vecAvailable: false,
      dispose: async () => {},
    };
    setCurrentDbClient(client, 'subagent-test');
    rawDb.prepare('INSERT INTO sessions (id) VALUES (?)').run('session-1');
  });

  afterEach(() => {
    clearCurrentDbClient(client);
    rawDb.close();
  });

  it('survives reload, merges aliases, and returns the result sent to the parent', async () => {
    insertMessage('tool-use-1', 'tool_use', '{}', 'parent-tool-1', 900);

    const created = await persistSubagentTaskUpdate(
      'session-1',
      observed({
        provider: 'pi',
        taskId: 'pi-child-1',
        parentToolUseId: 'parent-tool-1',
        status: 'running',
        title: 'Research plugins',
        description: 'Survey durable Subagent patterns',
        model: 'anthropic/claude-opus-5',
        updatedAt: '1970-01-01T00:00:01.000Z',
      }, { providerRunIds: ['pi-session-1'] }),
      'pi',
    );
    expect(created).toMatchObject({ created: true, firstForSession: true });

    const merged = await persistSubagentTaskUpdate(
      'session-1',
      observed({
        provider: 'pi',
        taskId: 'parent-tool-1',
        parentToolUseId: 'parent-tool-1',
        status: 'completed',
        summary: 'Found the reusable lifecycle contract',
        usage: { totalTokens: 1234, toolUses: 7, durationMs: 8000 },
        updatedAt: '1970-01-01T00:00:02.000Z',
      }, { kind: 'terminal', logicalSubagentId: 'pi-child-1' }),
      'pi',
    );
    expect(merged).toEqual({
      runId: created!.runId,
      created: false,
      firstForSession: false,
    });
    insertMessage(
      'tool-result-1',
      'tool_result',
      JSON.stringify('Durable result returned to the parent'),
      'parent-tool-1',
      2100,
    );

    // Read through the DB API only: there is no renderer/live-map state to help.
    const listed = (await listSubagentRuns('session-1'))?.runs;
    expect(listed).toHaveLength(1);
    expect(listed?.[0]).toMatchObject({
      id: created!.runId,
      provider: 'pi',
      logicalAgentId: 'pi-child-1',
      parentToolUseId: 'parent-tool-1',
      providerRunIds: ['pi-session-1'],
      status: 'completed',
      title: 'Research plugins',
      summary: 'Found the reusable lifecycle contract',
      usage: { totalTokens: 1234, toolUses: 7, durationMs: 8000 },
    });
    const detail = await getSubagentRunDetail('session-1', created!.runId);
    expect(detail?.activity.map((entry) => entry.kind)).toEqual(['started', 'completed']);
    expect(detail?.returnedResult).toBe('Durable result returned to the parent');
    expect(detail?.capabilities).toMatchObject({
      viewActivity: true,
      viewReturnedResult: true,
      viewFullTranscript: false,
      resume: false,
      steer: false,
    });
    expect((await getSubagentRunDetail('session-1', 'parent-tool-1'))?.id).toBe(created!.runId);
    expect((await getSubagentRunDetail('session-1', 'pi-session-1'))?.id).toBe(created!.runId);
  });

  it('keeps equal native aliases from different harnesses as separate Cindy runs', async () => {
    const claude = await persistSubagentTaskUpdate('session-1', observed({
      provider: 'claude-code',
      taskId: 'shared-native-id',
      status: 'running',
      updatedAt: '1970-01-01T00:00:01.000Z',
    }));
    const codex = await persistSubagentTaskUpdate('session-1', observed({
      provider: 'codex',
      taskId: 'shared-native-id',
      status: 'running',
      updatedAt: '1970-01-01T00:00:02.000Z',
    }));

    expect(claude).toMatchObject({ created: true, firstForSession: true });
    expect(codex).toMatchObject({ created: true, firstForSession: false });
    expect(codex?.runId).not.toBe(claude?.runId);
    expect((await listSubagentRuns('session-1'))?.runs.map((run) => run.provider)).toEqual([
      'codex',
      'claude-code',
    ]);
  });

  it('honors message rewind and clear boundaries without deleting audit rows', async () => {
    insertMessage('tool-use-2', 'tool_use', '{}', 'parent-tool-2', 900);
    insertMessage('tool-result-before-clear', 'tool_result', 'old result', 'parent-tool-2', 950);
    const created = await persistSubagentTaskUpdate('session-1', observed({
      provider: 'claude-code',
      taskId: 'claude-child-1',
      parentToolUseId: 'parent-tool-2',
      status: 'running',
      updatedAt: '1970-01-01T00:00:01.000Z',
    }));
    expect((await listSubagentRuns('session-1'))?.runs).toHaveLength(1);

    rawDb.prepare('UPDATE messages SET rewind_at = 1100 WHERE id = ?').run('tool-use-2');
    expect((await listSubagentRuns('session-1'))?.runs).toEqual([]);
    rawDb.prepare('UPDATE messages SET rewind_at = NULL WHERE id = ?').run('tool-use-2');
    rawDb.prepare('UPDATE sessions SET cleared_at = 1500 WHERE id = ?').run('session-1');
    expect((await listSubagentRuns('session-1'))?.runs).toEqual([]);

    const afterClear = await persistSubagentTaskUpdate('session-1', observed({
      provider: 'claude-code',
      taskId: 'claude-child-after-clear',
      status: 'running',
      updatedAt: '1970-01-01T00:00:02.000Z',
    }));
    expect(afterClear).toMatchObject({ created: true, firstForSession: true });

    const reusedParent = await persistSubagentTaskUpdate('session-1', observed({
      provider: 'claude-code',
      taskId: 'claude-child-reused-parent',
      parentToolUseId: 'parent-tool-2',
      status: 'completed',
      updatedAt: '1970-01-01T00:00:02.100Z',
    }));
    // A pre-clear tool row with the same provider id must not make the new run
    // visible or expose the old returned result.
    expect((await listSubagentRuns('session-1'))?.runs.map((run) => run.id)).toEqual([
      afterClear!.runId,
    ]);
    expect(await getSubagentRunDetail('session-1', reusedParent!.runId)).toBeNull();

    insertMessage('tool-use-after-clear', 'tool_use', '{}', 'parent-tool-2', 2200);
    expect((await listSubagentRuns('session-1'))?.runs.map((run) => run.id)).toContain(
      reusedParent!.runId,
    );
    expect(
      (await getSubagentRunDetail('session-1', reusedParent!.runId))?.returnedResult,
    ).toBeUndefined();
    insertMessage(
      'tool-result-after-clear',
      'tool_result',
      'new result',
      'parent-tool-2',
      2300,
    );
    expect(
      (await getSubagentRunDetail('session-1', reusedParent!.runId))?.returnedResult,
    ).toBe('new result');

    expect(
      rawDb.prepare('SELECT id FROM subagent_runs WHERE id = ?').get(created!.runId),
    ).toBeTruthy();
  });

  it('excludes background Bash and Workflow aggregation from the Subagent workspace', async () => {
    expect(
      await persistSubagentTaskUpdate('session-1', observed({
        provider: 'claude-code',
        taskId: 'bash-1',
        taskType: 'local_bash',
        status: 'running',
      })),
    ).toBeNull();
    expect(
      await persistSubagentTaskUpdate('session-1', observed({
        provider: 'claude-code',
        taskId: 'workflow-1',
        taskType: 'local_workflow',
        status: 'running',
      })),
    ).toBeNull();
    expect((await listSubagentRuns('session-1'))?.runs).toEqual([]);
  });

  it('ignores unmarked Codex control calls and never joins runs by their receivers', async () => {
    const spawned = await persistSubagentTaskUpdate(
      'session-1',
      observed(
        {
          provider: 'codex',
          taskId: 'spawn-card-1',
          status: 'running',
          title: 'Audit auth',
        },
        { providerRunIds: ['child-a', 'child-b'] },
      ),
    );

    expect(
      await persistSubagentTaskUpdate('session-1', {
        provider: 'codex',
        taskId: 'wait-call-1',
        status: 'completed',
        title: 'wait',
        receiverThreadIds: ['child-a', 'child-b'],
      }),
    ).toBeNull();
    expect(
      await persistSubagentTaskUpdate(
        'session-1',
        observed(
          {
            provider: 'codex',
            taskId: 'send-call-1',
            status: 'running',
            receiverThreadIds: ['child-a'],
          },
          {
            kind: 'progress',
            logicalSubagentId: 'send-call-1',
            providerRunIds: ['child-a'],
          },
        ),
      ),
    ).toBeNull();

    const run = await getSubagentRunDetail('session-1', spawned!.runId);
    expect(run).toMatchObject({
      logicalAgentId: 'spawn-card-1',
      title: 'Audit auth',
      status: 'running',
      providerRunIds: ['child-a', 'child-b'],
    });
    expect((await listSubagentRuns('session-1'))?.runs).toHaveLength(1);
  });

  it('paginates newest-first without making older runs unreachable', async () => {
    for (let index = 0; index < 55; index += 1) {
      await persistSubagentTaskUpdate('session-1', observed({
        provider: 'pi',
        taskId: `pi-child-${index}`,
        status: 'completed',
        updatedAt: new Date(1_000 + index).toISOString(),
      }));
    }

    const first = await listSubagentRuns('session-1');
    expect(first?.runs).toHaveLength(50);
    expect(first?.runs[0].logicalAgentId).toBe('pi-child-54');
    expect(first?.nextCursor).toBeTruthy();
    const second = await listSubagentRuns('session-1', { cursor: first?.nextCursor });
    expect(second?.runs).toHaveLength(5);
    expect(second?.runs.at(-1)?.logicalAgentId).toBe('pi-child-0');
    expect(second?.nextCursor).toBeUndefined();
  });

  function insertMessage(
    id: string,
    role: 'tool_use' | 'tool_result',
    content: string,
    toolUseId: string,
    createdAt: number,
  ): void {
    rawDb
      .prepare(
        'INSERT INTO messages (id, client_id, session_id, role, content, tool_use_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, id, 'session-1', role, content, toolUseId, createdAt);
  }

  function observed(
    data: Record<string, unknown>,
    options: {
      kind?: 'spawn' | 'progress' | 'terminal';
      logicalSubagentId?: string;
      parentToolUseId?: string;
      providerRunIds?: string[];
    } = {},
  ): Record<string, unknown> {
    const logicalSubagentId =
      options.logicalSubagentId ?? (typeof data.taskId === 'string' ? data.taskId : 'subagent');
    const parentToolUseId =
      options.parentToolUseId ??
      (typeof data.parentToolUseId === 'string' ? data.parentToolUseId : undefined);
    return {
      ...data,
      subagentObservation: {
        kind: options.kind ?? 'spawn',
        logicalSubagentId,
        ...(parentToolUseId ? { parentToolUseId } : {}),
        ...(options.providerRunIds ? { providerRunIds: options.providerRunIds } : {}),
      },
    };
  }
});
