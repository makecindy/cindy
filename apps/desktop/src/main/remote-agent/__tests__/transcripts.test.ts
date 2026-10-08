/**
 * 托管会话留在本机 Agent 目录里的会话记录：只删除这些本机侧任务(与它们用过的会话 id)对应的
 * 记录，本机用户自己的会话保持不动。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  purgeClaudeHostedSessionArtifacts,
  purgeClaudeHostedTranscripts,
  purgePiHostedSubagentRuns,
} from '../host/transcripts';

let configDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-ra-transcripts-'));
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('purgeClaudeHostedTranscripts', () => {
  it('removes only project directories that belong to the given host sessions', async () => {
    const id = '0123abcd-4567-4abc-a123-0123456789ab';
    const projects = path.join(configDir, 'projects');
    const guestProject = path.join(projects, `-data-remote-agent-workspaces-c1-${id}-fs-workspace-p-p`);
    const ownProject = path.join(projects, '-Users-me-code-app');
    fs.mkdirSync(guestProject, { recursive: true });
    fs.mkdirSync(ownProject, { recursive: true });
    fs.writeFileSync(path.join(guestProject, 'a.jsonl'), '{}');
    fs.writeFileSync(path.join(ownProject, 'b.jsonl'), '{}');

    await purgeClaudeHostedTranscripts([id], configDir);

    expect(fs.existsSync(guestProject)).toBe(false);
    expect(fs.existsSync(path.join(ownProject, 'b.jsonl'))).toBe(true);
  });

  it('does nothing without ids or without a projects directory', async () => {
    await expect(purgeClaudeHostedTranscripts([], configDir)).resolves.toBeUndefined();
    await expect(purgeClaudeHostedTranscripts(['', 'x'], path.join(configDir, 'missing'))).resolves.toBeUndefined();
  });
});

describe('purgeClaudeHostedSessionArtifacts', () => {
  const guestId = 'aaaaaaaa-1111-4222-8333-444444444444';
  const ownId = 'bbbbbbbb-1111-4222-8333-444444444444';

  function seed(id: string) {
    fs.mkdirSync(path.join(configDir, 'file-history', id), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'file-history', id, 'snap@v1'), 'x');
    fs.mkdirSync(path.join(configDir, 'session-env', id), { recursive: true });
    fs.mkdirSync(path.join(configDir, 'todos'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'todos', `${id}-agent-${id}.json`), '[]');
    fs.mkdirSync(path.join(configDir, 'debug'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'debug', `${id}.txt`), 'log');
  }

  it('removes the per-session records of guest sessions only', async () => {
    seed(guestId);
    seed(ownId);
    await purgeClaudeHostedSessionArtifacts([guestId], configDir);
    for (const target of [
      path.join('file-history', guestId),
      path.join('session-env', guestId),
      path.join('todos', `${guestId}-agent-${guestId}.json`),
      path.join('debug', `${guestId}.txt`),
    ]) expect(fs.existsSync(path.join(configDir, target))).toBe(false);
    for (const target of [
      path.join('file-history', ownId, 'snap@v1'),
      path.join('session-env', ownId),
      path.join('todos', `${ownId}-agent-${ownId}.json`),
      path.join('debug', `${ownId}.txt`),
    ]) expect(fs.existsSync(path.join(configDir, target))).toBe(true);
  });

  it('ignores ids that are not Claude session ids', async () => {
    fs.mkdirSync(path.join(configDir, 'file-history', 'keep'), { recursive: true });
    await purgeClaudeHostedSessionArtifacts(['..', 'keep', '/abs/path', ''], configDir);
    expect(fs.existsSync(path.join(configDir, 'file-history', 'keep'))).toBe(true);
  });
});

describe('purgePiHostedSubagentRuns', () => {
  const guestSession = '0123abcd-4567-4abc-a123-0123456789ab';
  const ownSession = 'own-session-id';

  function runRoot(sessionId: string): string {
    return path.join(configDir, 'runtime', 'pi-subagent-runs', sessionId);
  }

  it('stops and removes the run directories of guest tasks only', async () => {
    fs.mkdirSync(path.join(runRoot(guestSession), 'run-1'), { recursive: true });
    fs.mkdirSync(path.join(runRoot(ownSession), 'run-2'), { recursive: true });
    const removeRuns = vi.fn(async (root: string) => {
      fs.rmSync(root, { recursive: true, force: true });
      return true;
    });

    await purgePiHostedSubagentRuns([guestSession, 'no-runs-yet', '../escape'], configDir, removeRuns);

    expect(removeRuns.mock.calls.map(([root]) => root)).toEqual([runRoot(guestSession)]);
    expect(fs.existsSync(runRoot(guestSession))).toBe(false);
    expect(fs.existsSync(runRoot(ownSession))).toBe(true);
  });

  it('reports runs that could not be stopped so the purge is retried', async () => {
    fs.mkdirSync(runRoot(guestSession), { recursive: true });
    await expect(purgePiHostedSubagentRuns([guestSession], configDir, async () => false)).rejects.toThrow(/could not be stopped/);
    expect(fs.existsSync(runRoot(guestSession))).toBe(true);
  });

  it('removes an idle run directory with the real stop-and-remove', async () => {
    fs.mkdirSync(runRoot(guestSession), { recursive: true });
    await purgePiHostedSubagentRuns([guestSession], configDir);
    expect(fs.existsSync(runRoot(guestSession))).toBe(false);
  });
});
