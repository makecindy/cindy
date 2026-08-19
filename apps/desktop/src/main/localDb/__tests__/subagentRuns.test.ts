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
        cleared_at INTEGER,
        remote_host_id TEXT
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
        returned_result TEXT,
        returned_result_empty INTEGER,
        returned_result_truncated INTEGER,
        model TEXT,
        reasoning_effort TEXT,
        total_tokens INTEGER,
        tool_uses INTEGER,
        duration_ms INTEGER,
        cost_usd REAL,
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

  it('advertises exact stop only for PI durable background runs', async () => {
    insertMessage('tool-use-durable', 'tool_use', '{}', 'pi-tool-durable', 900);
    const created = await persistSubagentTaskUpdate(
      'session-1',
      observed({
        provider: 'pi',
        taskId: 'pi-tool-durable',
        parentToolUseId: 'pi-tool-durable',
        status: 'running',
        taskType: 'pi_subagent',
        updatedAt: '1970-01-01T00:00:01.000Z',
      }),
      'pi',
    );

    expect(created).not.toBeNull();
    await persistSubagentTaskUpdate(
      'session-1',
      observed({
        provider: 'pi',
        taskId: 'pi-tool-durable',
        parentToolUseId: 'pi-tool-durable',
        status: 'completed',
        taskType: 'pi_subagent',
        summary: 'Actual durable runner result',
        returnedResult: 'Complete durable runner result beyond the card summary',
        returnedResultTruncated: true,
        updatedAt: '1970-01-01T00:00:02.000Z',
      }, {
        kind: 'spawn',
        logicalSubagentId: 'durable-run-native-id',
        providerRunIds: ['durable-run-native-id', 'durable-child-native-id'],
      }),
      'pi',
    );
    // A later terminal enrichment without the full field must not erase it.
    await persistSubagentTaskUpdate(
      'session-1',
      observed({
        provider: 'pi',
        taskId: 'pi-tool-durable',
        parentToolUseId: 'pi-tool-durable',
        status: 'completed',
        taskType: 'pi_subagent',
        summary: 'Later compact summary',
        updatedAt: '1970-01-01T00:00:03.000Z',
      }, { kind: 'terminal' }),
      'pi',
    );
    insertMessage(
      'tool-result-durable',
      'tool_result',
      JSON.stringify('Cindy subagent launched. The agent is working in the background.'),
      'pi-tool-durable',
      2100,
    );

    const detail = await getSubagentRunDetail('session-1', 'pi', created!.runId);
    expect(detail?.returnedResult).toBe(
      'Complete durable runner result beyond the card summary',
    );
    expect(detail?.returnedResultTruncated).toBe(true);
    expect(detail?.providerRunIds).toEqual([
      'durable-run-native-id',
      'durable-child-native-id',
    ]);
    expect(detail?.capabilities).toMatchObject({
      stop: true,
      steer: true,
      resume: true,
      viewFullTranscript: true,
    });
    expect(detail?.activity.map((entry) => entry.kind)).toEqual(['started', 'completed']);
    expect(detail?.activity.at(-1)?.summary).toBe('Later compact summary');
  });

  it('disables durable controls when a PI run is replaced by a diagnostic record', async () => {
    await persistSubagentTaskUpdate('session-1', observed({
      provider: 'pi',
      taskId: 'diagnostic-tool',
      status: 'running',
      taskType: 'pi_subagent',
    }, {
      kind: 'spawn',
      logicalSubagentId: '123e4567-e89b-42d3-a456-426614174099',
      providerRunIds: ['123e4567-e89b-42d3-a456-426614174099'],
    }), 'pi');
    await persistSubagentTaskUpdate('session-1', observed({
      provider: 'pi',
      taskId: 'diagnostic-tool',
      status: 'failed',
      taskType: 'pi_subagent_diagnostic',
      summary: 'Runner stopped unexpectedly',
    }, {
      kind: 'spawn',
      logicalSubagentId: '123e4567-e89b-42d3-a456-426614174099',
      providerRunIds: ['123e4567-e89b-42d3-a456-426614174099'],
    }), 'pi');

    const detail = await getSubagentRunDetail(
      'session-1',
      'pi',
      '123e4567-e89b-42d3-a456-426614174099',
    );
    expect(detail?.status).toBe('failed');
    expect(detail?.capabilities).toMatchObject({
      viewActivity: true,
      viewFullTranscript: false,
      resume: false,
      steer: false,
      stop: false,
    });
  });

  it('restores the row after a transient diagnostic, down to its capabilities', async () => {
    // One unreadable read of an already-finished status.json — a Windows
    // sharing conflict is enough — used to be permanent: the diagnostic wrote
    // `failed` plus the reduced PR1 capability set, and the healthy write that
    // followed was absorbed by the failed state and inherited those reduced
    // capabilities, so the finished result never came back and the transcript
    // and resume affordances stayed gone.
    const generation = '123e4567-e89b-42d3-a456-4266141740f0';
    const spawn = {
      kind: 'spawn' as const,
      logicalSubagentId: generation,
      providerRunIds: [generation],
    };
    await persistSubagentTaskUpdate('session-1', observed({
      provider: 'pi', taskId: 'flaky-tool', status: 'completed', taskType: 'pi_subagent',
      summary: 'the answer',
    }, spawn), 'pi');
    await persistSubagentTaskUpdate('session-1', observed({
      provider: 'pi', taskId: 'flaky-tool', status: 'failed',
      taskType: 'pi_subagent_diagnostic', summary: 'status is unreadable',
    }, spawn), 'pi');

    const broken = await getSubagentRunDetail('session-1', 'pi', generation);
    expect(broken?.status).toBe('failed');

    // The file reads again, and the durable record is the authority.
    await persistSubagentTaskUpdate('session-1', observed({
      provider: 'pi', taskId: 'flaky-tool', status: 'completed', taskType: 'pi_subagent',
      summary: 'the answer',
    }, spawn), 'pi');

    const detail = await getSubagentRunDetail('session-1', 'pi', generation);
    expect(detail?.status).toBe('completed');
    expect(detail?.capabilities).toMatchObject({
      viewActivity: true,
      viewFullTranscript: true,
      resume: true,
    });
  });

  it('reopens a terminal PI durable row for a new resumed native generation', async () => {
    await persistSubagentTaskUpdate('session-1', observed({
      provider: 'pi', taskId: 'resume-tool',
      status: 'completed', taskType: 'pi_subagent', returnedResult: 'first result',
      usage: { totalTokens: 123, toolUses: 4, durationMs: 5000, costUsd: 0.25 },
      updatedAt: '1970-01-01T00:00:05.000Z',
    }, { kind: 'spawn', providerRunIds: ['123e4567-e89b-42d3-a456-426614174000'] }), 'pi');
    await persistSubagentTaskUpdate('session-1', observed({
      provider: 'pi', taskId: 'resume-tool',
      status: 'running', taskType: 'pi_subagent', description: 'continue',
      updatedAt: '1970-01-01T00:00:06.000Z',
    }, { kind: 'spawn', providerRunIds: ['123e4567-e89b-42d3-a456-426614174001'] }), 'pi');

    const detail = await getSubagentRunDetail('session-1', 'pi', 'resume-tool');
    expect(detail).toMatchObject({
      status: 'running',
      providerRunIds: [
        '123e4567-e89b-42d3-a456-426614174000',
        '123e4567-e89b-42d3-a456-426614174001',
      ],
    });
    expect(detail?.returnedResult).toBeUndefined();
    expect(detail?.usage).toBeUndefined();
    expect(detail?.endedAt).toBeUndefined();
    expect(detail?.activity.at(-1)?.kind).toBe('resumed');
  });

  it('keeps the newest generations once providerRunIds passes its cap', async () => {
    // The cap used to truncate the head, so past 64 generations the current run
    // id could never land. Two things broke at once: the transcript reader
    // takes the *last* run-directory id, so the panel pinned itself to an old
    // generation forever; and "is this a resume?" is decided by asking whether
    // an incoming id is missing from the persisted list, so every reconciliation
    // tick re-fired `resumed` — reopening the terminal row and discarding its
    // result each pass.
    const generation = (index: number) =>
      `123e4567-e89b-42d3-a456-4266141${String(index).padStart(5, '0')}`;
    const total = 70;
    for (let index = 0; index < total; index += 1) {
      await persistSubagentTaskUpdate('session-1', observed({
        provider: 'pi', taskId: 'capped-tool',
        status: 'completed', taskType: 'pi_subagent', returnedResult: `result ${index}`,
        updatedAt: `1970-01-01T00:00:${String(10 + index).padStart(2, '0')}.000Z`,
      }, { kind: 'spawn', providerRunIds: [generation(index)] }), 'pi');
    }

    const detail = await getSubagentRunDetail('session-1', 'pi', 'capped-tool');
    const ids = detail?.providerRunIds ?? [];
    expect(ids).toHaveLength(64);
    // Newest survives and stays at the tail: the transcript reader reverse-finds
    // the last run-directory id, so a rolled window must not reorder.
    expect(ids.at(-1)).toBe(generation(total - 1));
    expect(ids[0]).toBe(generation(total - 64));
    // The evicted head is genuinely gone from the array (it stays resolvable
    // through the append-only alias index, which this row does not own).
    expect(ids).not.toContain(generation(0));
    expect(detail?.returnedResult).toBe(`result ${total - 1}`);

    // Re-persisting the current generation is not a resume: no new id, so the
    // terminal row keeps its result and grows no further activity.
    const activityBefore = detail?.activity.length ?? 0;
    await persistSubagentTaskUpdate('session-1', observed({
      provider: 'pi', taskId: 'capped-tool',
      status: 'completed', taskType: 'pi_subagent', returnedResult: `result ${total - 1}`,
      updatedAt: `1970-01-01T00:00:${String(10 + total - 1).padStart(2, '0')}.000Z`,
    }, { kind: 'spawn', providerRunIds: [generation(total - 1)] }), 'pi');
    const settled = await getSubagentRunDetail('session-1', 'pi', 'capped-tool');
    expect(settled?.status).toBe('completed');
    expect(settled?.returnedResult).toBe(`result ${total - 1}`);
    expect(settled?.activity.length).toBe(activityBefore);
  });

  it('projects an immediately failed PI resume as a fresh failed generation', async () => {
    await persistSubagentTaskUpdate('session-1', observed({
      provider: 'pi', taskId: 'resume-failed-tool',
      status: 'completed', taskType: 'pi_subagent', returnedResult: 'stale success',
      summary: 'stale summary',
      usage: { totalTokens: 321, toolUses: 7, durationMs: 8000, costUsd: 0.5 },
      updatedAt: '1970-01-01T00:00:08.000Z',
    }, { kind: 'spawn', providerRunIds: ['123e4567-e89b-42d3-a456-426614174010'] }), 'pi');
    const failedResume = observed({
      provider: 'pi', taskId: 'resume-failed-tool',
      status: 'failed', taskType: 'pi_subagent', summary: 'resume launch failed',
      updatedAt: '1970-01-01T00:00:09.000Z',
    }, { kind: 'spawn', providerRunIds: ['123e4567-e89b-42d3-a456-426614174011'] });

    await persistSubagentTaskUpdate('session-1', failedResume, 'pi');
    await persistSubagentTaskUpdate('session-1', failedResume, 'pi');

    const detail = await getSubagentRunDetail('session-1', 'pi', 'resume-failed-tool');
    expect(detail).toMatchObject({
      status: 'failed',
      summary: 'resume launch failed',
      endedAt: 9000,
      providerRunIds: [
        '123e4567-e89b-42d3-a456-426614174010',
        '123e4567-e89b-42d3-a456-426614174011',
      ],
    });
    expect(detail?.returnedResult).toBeUndefined();
    expect(detail?.usage).toBeUndefined();
    expect(detail?.activity.slice(-2).map((entry) => entry.kind)).toEqual([
      'resumed',
      'failed',
    ]);
  });

  it('keeps the fresh returned result when a resumed PI generation is terminal on its first frame', async () => {
    await persistSubagentTaskUpdate('session-1', observed({
      provider: 'pi', taskId: 'resume-terminal-tool',
      status: 'completed', taskType: 'pi_subagent', returnedResult: 'old result',
      updatedAt: '1970-01-01T00:00:10.000Z',
    }, { kind: 'spawn', providerRunIds: ['123e4567-e89b-42d3-a456-426614174020'] }), 'pi');
    await persistSubagentTaskUpdate('session-1', observed({
      provider: 'pi', taskId: 'resume-terminal-tool',
      status: 'completed', taskType: 'pi_subagent', returnedResult: 'fresh result',
      updatedAt: '1970-01-01T00:00:11.000Z',
    }, { kind: 'spawn', providerRunIds: ['123e4567-e89b-42d3-a456-426614174021'] }), 'pi');

    const detail = await getSubagentRunDetail('session-1', 'pi', 'resume-terminal-tool');
    expect(detail?.returnedResult).toBe('fresh result');
    expect(detail?.activity.slice(-2).map((entry) => entry.kind)).toEqual([
      'resumed',
      'completed',
    ]);
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

  it('does not recreate a rewound durable PI generation during reconciliation', async () => {
    insertMessage('pi-tool-use', 'tool_use', '{}', 'pi-parent-tool', 1000);
    const event = observed({
      provider: 'pi',
      taskId: 'pi-parent-tool',
      parentToolUseId: 'pi-parent-tool',
      taskType: 'pi_subagent',
      status: 'running',
      createdAt: '1970-01-01T00:00:01.000Z',
      updatedAt: '1970-01-01T00:00:02.000Z',
    }, { kind: 'spawn', providerRunIds: ['123e4567-e89b-42d3-a456-426614174008'] });
    const first = await persistSubagentTaskUpdate('session-1', event);
    expect(first).toMatchObject({ created: true });
    rawDb.prepare('UPDATE messages SET rewind_at = 2500 WHERE id = ?').run('pi-tool-use');
    rawDb.prepare('UPDATE subagent_runs SET rewind_at = 2500 WHERE id = ?').run(first!.runId);
    await expect(persistSubagentTaskUpdate('session-1', event)).resolves.toBeNull();
    expect(rawDb.prepare('SELECT id FROM subagent_runs').all()).toHaveLength(1);
  });

  it('does not recreate a diagnostic for a rewound PI parent tool call', async () => {
    insertMessage('pi-diagnostic-tool-use', 'tool_use', '{}', 'pi-diagnostic-parent', 1000);
    rawDb.prepare('UPDATE messages SET rewind_at = 1500 WHERE id = ?').run('pi-diagnostic-tool-use');

    await expect(persistSubagentTaskUpdate('session-1', observed({
      provider: 'pi',
      taskId: 'pi-diagnostic-parent',
      parentToolUseId: 'pi-diagnostic-parent',
      taskType: 'pi_subagent_diagnostic',
      status: 'failed',
      createdAt: '1970-01-01T00:00:01.000Z',
      updatedAt: '1970-01-01T00:00:02.000Z',
    }))).resolves.toBeNull();
    expect(rawDb.prepare('SELECT id FROM subagent_runs').all()).toEqual([]);
  });

  it('does not recreate a durable PI generation that started before clear', async () => {
    rawDb.prepare('UPDATE sessions SET cleared_at = 1500 WHERE id = ?').run('session-1');
    const created = await persistSubagentTaskUpdate('session-1', observed({
      provider: 'pi',
      taskId: 'durable-before-clear',
      taskType: 'pi_subagent',
      status: 'completed',
      createdAt: '1970-01-01T00:00:01.000Z',
      updatedAt: '1970-01-01T00:00:03.000Z',
    }));
    expect(created).toBeNull();
    expect(rawDb.prepare('SELECT id FROM subagent_runs').all()).toEqual([]);
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
          returnedResult: 'PI-only complete result must be ignored',
          usage: { totalTokens: 700, toolUses: 4, durationMs: 1200, costUsd: 9.99 },
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

    const repeatedSpawn = await persistSubagentTaskUpdate(
      'session-1',
      observed(
        {
          provider: 'claude-code',
          taskId: 'parentless-claude-lifecycle',
          taskType: 'local_agent',
          status: 'running',
        },
        { kind: 'spawn', providerRunIds: ['new-claude-native-id'] },
      ),
      'claude-code',
      5000,
    );

    expect(terminal).toMatchObject({ runId: spawned!.runId, created: false });
    expect(lateProgress).toMatchObject({ runId: spawned!.runId, created: false });
    expect(duplicateTerminal).toMatchObject({ runId: spawned!.runId, created: false });
    expect(repeatedSpawn).toMatchObject({ runId: spawned!.runId, created: false });
    expect((await listSubagentRuns('session-1'))?.runs).toHaveLength(1);
    const detail = await getSubagentRunDetail('session-1', 'claude-code', spawned!.runId);
    expect(detail).toMatchObject({
      status: 'completed',
      title: 'Inspect the lifecycle',
      summary: 'Lifecycle captured',
      usage: { totalTokens: 700, toolUses: 4, durationMs: 1200 },
    });
    expect(detail?.usage?.costUsd).toBeUndefined();
    expect(detail?.returnedResult).toBeUndefined();
    expect(
      rawDb.prepare('SELECT cost_usd FROM subagent_runs WHERE id = ?').get(spawned!.runId),
    ).toEqual({ cost_usd: null });
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
