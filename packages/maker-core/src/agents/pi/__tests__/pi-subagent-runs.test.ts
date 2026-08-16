import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  controlPiSubagentRuns,
  hasActivePiSubagentRunsSync,
  listPiSubagentRunDiagnostics,
  listPiSubagentRuns,
  piSubagentRunRoot,
  requestStopAllPiSubagentRunsSync,
  readPiSubagentTranscriptPage,
  stopAndRemovePiSubagentRuns,
  syncPiSubagentPermissions,
  type PiSubagentRunStatus,
} from '../pi-subagent-runs.js';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-pi-subagent-runs-'));
  roots.push(root);
  return root;
}

function status(runId: string, overrides: Partial<PiSubagentRunStatus> = {}): PiSubagentRunStatus {
  return {
    version: 1,
    runId,
    taskId: 'tool-1',
    parentSessionId: 'session-1',
    runnerInstanceId: 'runner-1',
    runnerPid: process.pid,
    state: 'running',
    startedAt: 10,
    updatedAt: 20,
    tasks: [{
      childId: `${runId}-1`,
      sessionId: `${runId}-1`,
      agent: 'scout',
      status: 'running',
    }],
    ...overrides,
  };
}

async function writeStatus(root: string, value: PiSubagentRunStatus): Promise<void> {
  const dir = path.join(root, value.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'status.json'), `${JSON.stringify(value)}\n`);
}

async function readControls(root: string, runId: string): Promise<Array<Record<string, unknown>>> {
  const dir = path.join(root, runId, 'controls');
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json'));
  return Promise.all(files.map(async (file) => JSON.parse(
    await readFile(path.join(dir, file), 'utf8'),
  ) as Record<string, unknown>));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PI durable subagent run store', () => {
  it('derives a contained parent-session root and rejects traversal ids', () => {
    expect(piSubagentRunRoot('/agent-home', 'session-1')).toBe(
      path.join('/agent-home', 'runtime', 'pi-subagent-runs', 'session-1'),
    );
    expect(() => piSubagentRunRoot('/agent-home', '../escape')).toThrow(/unsafe/);
    expect(() => piSubagentRunRoot('/agent-home', 'a\\b')).toThrow(/unsafe/);
  });

  it('reports UUID-contained corrupt runs without trusting disk PIDs', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174099';
    const dir = path.join(root, runId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'status.json'), '{not-json');
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({
      taskId: 'opaque-task', parentSessionId: 'session-1', title: 'Recover this task',
      runnerPid: 12345,
    }));

    await expect(listPiSubagentRunDiagnostics(root)).resolves.toEqual([
      expect.objectContaining({
        runId,
        taskId: 'opaque-task',
        parentSessionId: 'session-1',
        title: 'Recover this task',
        message: expect.stringContaining('not resumed or signaled'),
      }),
    ]);
  });

  it('lists only validated UUID-contained status records', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174000';
    await writeStatus(root, status(runId));
    await mkdir(path.join(root, '..-escape'), { recursive: true });
    await writeFile(path.join(root, '..-escape', 'status.json'), '{}');

    await expect(listPiSubagentRuns(root)).resolves.toEqual([
      expect.objectContaining({ runId, taskId: 'tool-1', state: 'running' }),
    ]);
  });

  it('projects a dead runner with an expired heartbeat as a stale diagnostic', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174011';
    await writeStatus(root, status(runId, {
      runnerPid: 2_147_483_647,
      startedAt: Date.now() - 60_000,
      updatedAt: Date.now() - 30_000,
    }));

    await expect(listPiSubagentRuns(root)).resolves.toEqual([]);
    await expect(listPiSubagentRunDiagnostics(root)).resolves.toEqual([
      expect.objectContaining({
        kind: 'stale',
        runId,
        taskId: 'tool-1',
        message: expect.stringContaining('stopped unexpectedly'),
      }),
    ]);
    await expect(stopAndRemovePiSubagentRuns(root, 100)).resolves.toBe(true);
  });

  it('treats an abandoned launch-pending status without a runner pid as stale', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174013';
    await writeStatus(root, status(runId, {
      runnerInstanceId: `launch-pending-${runId}`,
      runnerPid: undefined,
      state: 'queued',
      startedAt: Date.now() - 60_000,
      updatedAt: Date.now() - 30_000,
    }));

    await expect(listPiSubagentRuns(root)).resolves.toEqual([]);
    await expect(listPiSubagentRunDiagnostics(root)).resolves.toEqual([
      expect.objectContaining({ kind: 'stale', runId }),
    ]);
  });

  it('detects and synchronously requests stop for active runners on force exit', async () => {
    const agentHome = await makeRoot();
    const root = piSubagentRunRoot(agentHome, 'session-1');
    const runId = '123e4567-e89b-42d3-a456-426614174005';
    await writeStatus(root, status(runId));

    expect(hasActivePiSubagentRunsSync(agentHome)).toBe(true);
    expect(requestStopAllPiSubagentRunsSync(agentHome)).toBe(1);
    const control = JSON.parse(await readFile(path.join(root, runId, 'control.json'), 'utf8')) as {
      action: string;
    };
    expect(control.action).toBe('stop');
  });

  it('hot-syncs permission snapshots into every active durable run', async () => {
    const root = await makeRoot();
    const activeId = '123e4567-e89b-42d3-a456-426614174006';
    const terminalId = '123e4567-e89b-42d3-a456-426614174007';
    await writeStatus(root, status(activeId));
    await writeStatus(root, status(terminalId, { state: 'completed' }));
    await expect(syncPiSubagentPermissions(root, { mode: 'ask', readOnlyRoots: [] })).resolves.toBe(1);
    await expect(readFile(path.join(root, activeId, 'permission.json'), 'utf8')).resolves.toContain('"mode":"ask"');
    await expect(readFile(path.join(root, terminalId, 'permission.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves corrupt run directories untouched instead of guessing their lifecycle', async () => {
    const root = await makeRoot();
    const corruptId = '123e4567-e89b-42d3-a456-426614174008';
    await mkdir(path.join(root, corruptId), { recursive: true });
    await writeFile(path.join(root, corruptId, 'status.json'), '{broken');

    await expect(syncPiSubagentPermissions(root, { mode: 'ask', readOnlyRoots: [] })).resolves.toBe(0);
    await expect(readFile(path.join(root, corruptId, 'permission.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes control inside the discovered run directory without treating taskId as a path', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174001';
    const traversalLookingTaskId = '../../../../tmp/not-a-path';
    await writeStatus(root, status(runId, { taskId: traversalLookingTaskId }));

    await expect(controlPiSubagentRuns(root, traversalLookingTaskId, 'stop')).resolves.toBe(0);
    const [control] = await readControls(root, runId);
    expect(control).toMatchObject({ action: 'stop' });
    expect(control?.seq).toEqual(expect.any(Number));
    await expect(readFile(path.join(root, 'control.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not write controls for terminal or unknown tasks', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174002';
    await writeStatus(root, status(runId, { state: 'completed' }));

    await expect(controlPiSubagentRuns(root, 'tool-1', 'stop')).resolves.toBe(0);
    await expect(controlPiSubagentRuns(root, 'missing', 'stop')).resolves.toBe(0);
    await expect(readdir(path.join(root, runId, 'controls'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not report success for an unknown or already-ended child target', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174012';
    const running = status(runId, {
      tasks: [
        {
          childId: `${runId}-done`,
          sessionId: `${runId}-done`,
          agent: 'scout',
          status: 'completed',
        },
        {
          childId: `${runId}-active`,
          sessionId: `${runId}-active`,
          agent: 'reviewer',
          status: 'running',
        },
      ],
    });
    await writeStatus(root, running);

    await expect(controlPiSubagentRuns(root, runId, 'steer', {
      childId: `${runId}-done`,
      message: 'too late',
    })).resolves.toBe(0);
    await expect(controlPiSubagentRuns(root, runId, 'stop', {
      childId: 'missing-child',
    })).resolves.toBe(0);
    await expect(controlPiSubagentRuns(root, runId, 'steer', {
      childId: `${runId}-active`,
      message: 'valid direction',
    })).resolves.toBe(0);
    const controls = await readControls(root, runId);
    expect(controls).toEqual([
      expect.objectContaining({
        action: 'steer',
        childId: `${runId}-active`,
        message: 'valid direction',
      }),
    ]);
  });

  it('pages normalized transcript entries from a UUID-contained run', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174004';
    await writeStatus(root, status(runId));
    const transcript = [
      { type: 'cindy.subagent.child_event', at: 100, childId: 'child-1', event: {
        type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      } },
      { type: 'cindy.subagent.child_event', at: 110, childId: 'child-1', event: {
        type: 'tool_execution_start', toolName: 'read', args: { path: '/tmp/a' },
      } },
      { type: 'cindy.subagent.control', at: 120, control: { action: 'steer', message: 'check b too' } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    await writeFile(path.join(root, runId, 'transcript.jsonl'), transcript);

    const first = await readPiSubagentTranscriptPage(root, runId, { limit: 2 });
    expect(first).toMatchObject({
      supported: true,
      entries: [
        expect.objectContaining({ role: 'subagent', content: 'first answer', occurredAt: 100 }),
        expect.objectContaining({ role: 'tool', toolName: 'read', occurredAt: 110 }),
      ],
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await readPiSubagentTranscriptPage(root, runId, { cursor: first.nextCursor });
    expect(second).toEqual({
      supported: true,
      entries: [expect.objectContaining({ role: 'parent', content: '[steer] check b too' })],
    });
    await expect(readPiSubagentTranscriptPage(root, '../escape')).resolves.toEqual({
      supported: false,
      entries: [],
    });
  });

  it('requires a message and preserves concurrent control requests without overwriting', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174003';
    await writeStatus(root, status(runId));

    await expect(controlPiSubagentRuns(root, 'tool-1', 'steer')).rejects.toThrow(/non-empty message/);
    await expect(Promise.all([
      controlPiSubagentRuns(root, 'tool-1', 'steer', { message: 'change direction' }),
      controlPiSubagentRuns(root, runId, 'follow_up', { message: 'also run tests' }),
    ])).resolves.toEqual([0, 0]);
    const controls = await readControls(root, runId);
    expect(controls).toHaveLength(2);
    expect(controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'steer', message: 'change direction' }),
      expect.objectContaining({ action: 'follow_up', message: 'also run tests' }),
    ]));
    expect(new Set(controls.map((control) => control.requestId)).size).toBe(2);
  });

  it.skipIf(process.platform === 'win32')('refuses a control mailbox redirected through a symlink', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174014';
    const outside = await makeRoot();
    await writeStatus(root, status(runId));
    await symlink(outside, path.join(root, runId, 'controls'), 'dir');

    await expect(controlPiSubagentRuns(root, runId, 'stop')).rejects.toThrow(/control directory is unavailable/);
    await expect(readdir(outside)).resolves.toEqual([]);
  });
});
