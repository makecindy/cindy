import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HeadlessGitHistory } from './git-history.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function git(dir: string, ...args: string[]): string { return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }); }

describe('HeadlessGitHistory', () => {
  it('uses before/after local savepoints so Codex file rewind restores only agent-era edits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-git-')); dirs.push(dir);
    git(dir, 'init'); git(dir, 'config', 'user.name', 'Tester'); git(dir, 'config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n'); git(dir, 'add', 'a.txt'); git(dir, 'commit', '-m', 'base');
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-git-state-')); dirs.push(state);
    const history = new HeadlessGitHistory(path.join(state, 'history.db'));
    const session = { id: 's1', agentKind: 'codex' as const, workDir: dir, title: 'Git', model: 'gpt', createdAt: Date.now(), updatedAt: Date.now() };

    fs.writeFileSync(path.join(dir, 'a.txt'), 'user-start\n');
    await history.beginTurn(session, 'u1');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'agent-finish\n');
    await history.finishTurn('s1');

    await expect(history.preview(session, 'u1', ['u1'])).resolves.toMatchObject({ canRewind: true, filesChanged: ['a.txt'], insertions: 1, deletions: 1 });
    await history.commit(session, 'u1', ['u1']);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('user-start\n');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    history.close();
  });

  it('never snapshots an explicit staged index or an obvious secret file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-git-')); dirs.push(dir);
    git(dir, 'init'); git(dir, 'config', 'user.name', 'Tester'); git(dir, 'config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n'); git(dir, 'add', 'a.txt'); git(dir, 'commit', '-m', 'base');
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-git-state-')); dirs.push(state);
    const history = new HeadlessGitHistory(path.join(state, 'history.db'));
    const session = { id: 's1', agentKind: 'codex' as const, workDir: dir, title: 'Git', model: 'gpt', createdAt: Date.now(), updatedAt: Date.now() };
    fs.writeFileSync(path.join(dir, '.env'), 'token=secret\n');
    await history.beginTurn(session, 'u1');
    expect(git(dir, 'log', '-1', '--format=%s').trim()).toBe('base');
    history.close();
  });
});
