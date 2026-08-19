import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbClient } from '../client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current.js';
import * as schema from '../schema.js';
import {
  getSubagentRunDetail,
  listVisibleSubagentObservationIdentities,
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
    const detail = await getSubagentRunDetail('session-1', 'pi', created!.runId);
    expect(detail?.activity.map((entry) => entry.kind)).toEqual(['started', 'completed']);
    expect(detail?.returnedResult).toBe('Durable result returned to the parent');
    expect(detail?.capabilities).toMatchObject({
      viewActivity: true,
      viewReturnedResult: true,
      viewFullTranscript: false,
      resume: false,
      steer: false,
    });
    expect((await getSubagentRunDetail('session-1', 'pi', 'parent-tool-1'))?.id).toBe(
      created!.runId,
    );
    expect((await getSubagentRunDetail('session-1', 'pi', 'pi-session-1'))?.id).toBe(
      created!.runId,
    );
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
    expect(
      (await getSubagentRunDetail('session-1', 'claude-code', 'shared-native-id'))?.id,
    ).toBe(claude!.runId);
    expect((await getSubagentRunDetail('session-1', 'codex', 'shared-native-id'))?.id).toBe(
      codex!.runId,
    );
    expect(await getSubagentRunDetail('session-1', 'codex', claude!.runId)).toBeNull();
  });

  it('uses the terminal Codex summary instead of a spawn receipt as the returned result', async () => {
    insertMessage('codex-tool-use', 'tool_use', '{}', 'codex-spawn', 900);
    const spawned = await persistSubagentTaskUpdate(
      'session-1',
      observed(
        {
          provider: 'codex',
          taskId: 'codex-spawn',
          parentToolUseId: 'codex-spawn',
          status: 'running',
          title: 'Audit auth',
          summary: 'Audit agent started',
          updatedAt: '1970-01-01T00:00:01.000Z',
        },
        { providerRunIds: ['codex-thread-1'] },
      ),
    );
    await persistSubagentTaskUpdate(
      'session-1',
      {
        provider: 'codex',
        taskId: 'codex-spawn',
        parentToolUseId: 'codex-spawn',
        status: 'completed',
        title: 'spawnAgent',
        summary: 'The audit found no upstream conflict.',
        updatedAt: '1970-01-01T00:00:02.000Z',
      },
      'codex',
    );
    expect(await getSubagentRunDetail('session-1', 'codex', spawned!.runId)).toMatchObject({
      status: 'running',
      title: 'Audit auth',
      summary: 'The audit found no upstream conflict.',
    });
    expect(
      (await getSubagentRunDetail('session-1', 'codex', spawned!.runId))?.returnedResult,
    ).toBeUndefined();
    await persistSubagentTaskUpdate(
      'session-1',
      observed(
        {
          provider: 'codex',
          taskId: 'codex-spawn',
          parentToolUseId: 'codex-spawn',
          status: 'completed',
          updatedAt: '1970-01-01T00:00:02.100Z',
        },
        { kind: 'terminal' },
      ),
    );
    insertMessage(
      'codex-spawn-receipt',
      'tool_result',
      JSON.stringify('started: codex-thread-1'),
      'codex-spawn',
      1100,
    );

    expect(
      (await getSubagentRunDetail('session-1', 'codex', spawned!.runId))?.returnedResult,
    ).toBe('The audit found no upstream conflict.');
  });

  it('uses the terminal Claude summary instead of an async launch receipt', async () => {
    insertMessage('claude-tool-use', 'tool_use', '{}', 'claude-agent', 900);
    const spawned = await persistSubagentTaskUpdate(
      'session-1',
      observed({
        provider: 'claude-code',
        taskId: 'claude-child',
        parentToolUseId: 'claude-agent',
        status: 'running',
        title: 'Audit persistence',
        updatedAt: '1970-01-01T00:00:01.000Z',
      }),
    );
    await persistSubagentTaskUpdate(
      'session-1',
      observed(
        {
          provider: 'claude-code',
          taskId: 'claude-child',
          parentToolUseId: 'claude-agent',
          status: 'completed',
          summary: 'The durable audit completed successfully.',
          updatedAt: '1970-01-01T00:00:02.000Z',
        },
        { kind: 'terminal' },
      ),
    );
    insertMessage(
      'claude-launch-receipt',
      'tool_result',
      JSON.stringify([
        'Async agent launched successfully.',
        "agentId: claude-child (internal ID - do not mention to user. Use SendMessage with to: 'claude-child' to continue this agent.)",
        'The agent is working in the background. You will be notified automatically when it completes.',
        'Briefly tell the user what you launched and end your response.',
      ].join('\n')),
      'claude-agent',
      1100,
    );

    expect(
      (await getSubagentRunDetail('session-1', 'claude-code', spawned!.runId))?.returnedResult,
    ).toBe('The durable audit completed successfully.');
  });

  it('creates a completed-only Codex spawn before later progress and terminal updates', async () => {
    // The translator reconstructs this parent tool boundary before emitting
    // the completed-only task update.
    insertMessage(
      'completed-only-tool-use',
      'tool_use',
      '{}',
      'completed-only-spawn',
      900,
    );
    const completedOnly = await persistSubagentTaskUpdate(
      'session-1',
      observed(
        {
          provider: 'codex',
          taskId: 'completed-only-spawn',
          parentToolUseId: 'completed-only-spawn',
          status: 'completed',
          title: 'spawnAgent',
          summary: 'Initial completed snapshot',
          updatedAt: '1970-01-01T00:00:01.000Z',
        },
        { providerRunIds: ['completed-only-child'] },
      ),
    );

    expect(completedOnly).toMatchObject({ created: true, firstForSession: true });
    expect(await getSubagentRunDetail('session-1', 'codex', completedOnly!.runId)).toMatchObject({
      status: 'completed',
      summary: 'Initial completed snapshot',
      providerRunIds: ['completed-only-child'],
    });

    const progressed = await persistSubagentTaskUpdate(
      'session-1',
      observed(
        {
          provider: 'codex',
          taskId: 'completed-only-spawn',
          status: 'running',
          usage: { totalTokens: 42 },
          updatedAt: '1970-01-01T00:00:02.000Z',
        },
        { kind: 'progress', providerRunIds: ['completed-only-child'] },
      ),
    );
    const terminal = await persistSubagentTaskUpdate(
      'session-1',
      observed(
        {
          provider: 'codex',
          taskId: 'completed-only-spawn',
          status: 'completed',
          summary: 'Final descendant summary',
          updatedAt: '1970-01-01T00:00:03.000Z',
        },
        { kind: 'terminal', providerRunIds: ['completed-only-child'] },
      ),
    );

    expect(progressed).toMatchObject({ runId: completedOnly!.runId, created: false });
    expect(terminal).toMatchObject({ runId: completedOnly!.runId, created: false });
    expect(await getSubagentRunDetail('session-1', 'codex', completedOnly!.runId)).toMatchObject({
      status: 'completed',
      summary: 'Final descendant summary',
      usage: { totalTokens: 42 },
      providerRunIds: ['completed-only-child'],
    });
  });

  it('persists a synchronous completed Claude Agent result as its first observation', async () => {
    insertMessage(
      'claude-sync-tool-use',
      'tool_use',
      '{}',
      'toolu_sync_agent',
      900,
    );

    const orphanTerminal = await persistSubagentTaskUpdate(
      'session-1',
      observed(
        {
          provider: 'claude-code',
          taskId: 'orphan-terminal',
          status: 'completed',
        },
        { kind: 'terminal' },
      ),
      'claude-code',
    );
    expect(orphanTerminal).toBeNull();

    const created = await persistSubagentTaskUpdate(
      'session-1',
      observed(
        {
          provider: 'claude-code',
          taskId: 'agent-sync',
          parentToolUseId: 'toolu_sync_agent',
          status: 'completed',
          model: 'vendor-a/model-sol',
          usage: { totalTokens: 22_113, toolUses: 0, durationMs: 4_949 },
          updatedAt: '1970-01-01T00:00:01.000Z',
        },
        { kind: 'spawn' },
      ),
      'claude-code',
    );

    expect(created).toMatchObject({ created: true, firstForSession: true });
    expect(await getSubagentRunDetail('session-1', 'claude-code', created!.runId)).toMatchObject({
      logicalAgentId: 'agent-sync',
      parentToolUseId: 'toolu_sync_agent',
      status: 'completed',
      model: 'vendor-a/model-sol',
      usage: { totalTokens: 22_113, toolUses: 0, durationMs: 4_949 },
    });
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
    expect(
      await getSubagentRunDetail('session-1', 'claude-code', reusedParent!.runId),
    ).toBeNull();

    insertMessage('tool-use-after-clear', 'tool_use', '{}', 'parent-tool-2', 2200);
    expect((await listSubagentRuns('session-1'))?.runs.map((run) => run.id)).toContain(
      reusedParent!.runId,
    );
    expect(
      (await getSubagentRunDetail('session-1', 'claude-code', reusedParent!.runId))
        ?.returnedResult,
    ).toBeUndefined();
    insertMessage(
      'tool-result-after-clear',
      'tool_result',
      'new result',
      'parent-tool-2',
      2300,
    );
    expect(
      (await getSubagentRunDetail('session-1', 'claude-code', reusedParent!.runId))
        ?.returnedResult,
    ).toBe('new result');

    expect(
      rawDb.prepare('SELECT id FROM subagent_runs WHERE id = ?').get(created!.runId),
    ).toBeTruthy();
  });

  it('keeps a parentless event observed before clear hidden when its write runs later', async () => {
    rawDb.prepare('UPDATE sessions SET cleared_at = 1500 WHERE id = ?').run('session-1');

    const created = await persistSubagentTaskUpdate(
      'session-1',
      observed({
        provider: 'claude-code',
        taskId: 'parentless-before-clear',
        status: 'running',
      }),
      'claude-code',
      1000,
    );

    expect(created).toMatchObject({ created: true });
    expect(
      rawDb.prepare('SELECT started_at FROM subagent_runs WHERE id = ?').get(created!.runId),
    ).toEqual({ started_at: 1000 });
    expect((await listSubagentRuns('session-1'))?.runs).toEqual([]);
  });

  it('keeps a parentless Claude run terminal across duplicate and late lifecycle updates', async () => {
    const spawned = await persistSubagentTaskUpdate(
      'session-1',
      observed(
        {
          provider: 'claude-code',
          taskId: 'parentless-claude-lifecycle',
          taskType: 'local_agent',
          status: 'running',
          title: 'Inspect the lifecycle',
        },
        { kind: 'spawn' },
      ),
      'claude-code',
      1000,
    );
    const terminal = await persistSubagentTaskUpdate(
      'session-1',
      observed(
        {
          provider: 'claude-code',
          taskId: 'parentless-claude-lifecycle',
          status: 'completed',
          summary: 'Lifecycle captured',
          usage: { totalTokens: 700, toolUses: 4, durationMs: 1200 },
        },
        { kind: 'terminal' },
      ),
      'claude-code',
      2000,
    );
    const lateProgress = await persistSubagentTaskUpdate(
      'session-1',
      observed(
        {
          provider: 'claude-code',
          taskId: 'parentless-claude-lifecycle',
          status: 'running',
          summary: 'Late progress must not reopen the run',
        },
        { kind: 'progress' },
      ),
      'claude-code',
      3000,
    );
    const duplicateTerminal = await persistSubagentTaskUpdate(
      'session-1',
      observed(
        {
          provider: 'claude-code',
          taskId: 'parentless-claude-lifecycle',
          status: 'completed',
          summary: 'Lifecycle captured',
          usage: { totalTokens: 700, toolUses: 4, durationMs: 1200 },
        },
        { kind: 'terminal' },
      ),
      'claude-code',
      4000,
    );

    expect(terminal).toMatchObject({ runId: spawned!.runId, created: false });
    expect(lateProgress).toMatchObject({ runId: spawned!.runId, created: false });
    expect(duplicateTerminal).toMatchObject({ runId: spawned!.runId, created: false });
    expect((await listSubagentRuns('session-1'))?.runs).toHaveLength(1);
    expect(
      await getSubagentRunDetail('session-1', 'claude-code', spawned!.runId),
    ).toMatchObject({
      status: 'completed',
      title: 'Inspect the lifecycle',
      summary: 'Lifecycle captured',
      usage: { totalTokens: 700, toolUses: 4, durationMs: 1200 },
    });
  });

  it('returns every visible provider identity needed to prime a Rewind generation', async () => {
    insertMessage('tool-use-rewind-identity', 'tool_use', '{}', 'parent-tool', 900);
    const visible = await persistSubagentTaskUpdate(
      'session-1',
      {
        provider: 'codex',
        taskId: 'logical-task',
        parentToolUseId: 'parent-tool',
        status: 'running',
        subagentObservation: {
          kind: 'spawn',
          logicalSubagentId: 'logical-task',
          parentToolUseId: 'parent-tool',
          identityAliases: ['card-alias'],
          providerRunIds: ['native-thread'],
        },
      },
      'codex',
      1000,
    );
    await persistSubagentTaskUpdate(
      'session-1',
      observed({ provider: 'pi', taskId: 'rewound-task', status: 'running' }),
      'pi',
      1100,
    );
    rawDb
      .prepare('UPDATE subagent_runs SET rewind_at = 1200 WHERE logical_agent_id = ?')
      .run('rewound-task');

    expect(await listVisibleSubagentObservationIdentities('session-1')).toEqual([
      {
        provider: 'codex',
        identities: expect.arrayContaining([
          'logical-task',
          'parent-tool',
          'card-alias',
          'native-thread',
        ]),
      },
    ]);
    expect(visible).toBeTruthy();
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
        summary: 'wait completed',
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

    const run = await getSubagentRunDetail('session-1', 'codex', spawned!.runId);
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

  it('filters rewound or missing parents before applying the page limit', async () => {
    const visible = await persistSubagentTaskUpdate('session-1', observed({
      provider: 'pi',
      taskId: 'visible-older-run',
      status: 'completed',
      updatedAt: '1970-01-01T00:00:01.000Z',
    }));
    for (let index = 0; index < 50; index += 1) {
      await persistSubagentTaskUpdate('session-1', observed({
        provider: 'claude-code',
        taskId: `hidden-run-${index}`,
        parentToolUseId: `missing-parent-${index}`,
        status: 'completed',
        updatedAt: new Date(2_000 + index).toISOString(),
      }));
    }

    const first = await listSubagentRuns('session-1');
    expect(first?.runs.map((run) => run.id)).toEqual([visible!.runId]);
    expect(first?.nextCursor).toBeUndefined();
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
