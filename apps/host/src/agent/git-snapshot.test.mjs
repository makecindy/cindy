/*
 * 测试价值
 * - 可观察结果：Host 任务在真实的临时 Git 仓库里建保存点：派发前的基线与回合结束后的改后快照
 *   都挂在桌面同名的 refs/cindy/savepoints/<任务 id> 上；未派发的回合不留改后快照；用户的分支与
 *   工作区不被改动；标签不发任何模型请求（Host 上辅助模型调用尚未放开，放行表第 7b 行）。
 * - 规则依据：桌面 git-snapshot-host.ts（现经 gitSnapshotHostCore.ts）；register.ts 与
 *   sessionEventDelivery.ts 的 onTurnStart / onTurnAbort / onTurnEnd 调用点。
 * - 最小失败输入：Host 不建保存点（旧装配）；标签走模型调用。
 * - tier：integration（真实 git 子进程与临时仓库，不调模型）。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHostGitSnapshot } from './git-snapshot.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { listShadowSavepoints } from '../../../desktop/src/main/git-snapshot/gitSnapshotService.ts';
import { lifoCleanup } from '../test-support/cleanup.mjs';

// node:test has no default timeout. These tests start subprocesses or use real temporary
// files; an explicit bound turns a stuck child or lock into a failure, not a stalled gate.
const TEST_TIMEOUT_MS = 120_000;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();

function fixtureRepo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-snapshot-repo-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function setup(t, ownerId) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-snapshot-profile-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId });
  const repo = fixtureRepo(t);
  const meta = { workDir: repo, agentKind: 'claude-code' };
  const snapshot = createHostGitSnapshot({ getSessionMeta: async () => meta },
    { getLatestUserMessage: async () => ({ clientId: 'user-1', text: 'change a.txt' }) });
  return { repo, snapshot };
}

test('a Host turn keeps the desktop savepoint chain in the task repository without a model call', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const { repo, snapshot } = setup(t, 'snapshot-owner');
  const head = git(repo, 'rev-parse', 'HEAD');

  await snapshot.onTurnStart('task-1');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  await snapshot.onTurnEnd('task-1');

  assert.equal(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/cindy/savepoints/'), 'refs/cindy/savepoints/task-1');
  const { entries } = await listShadowSavepoints(repo, 'task-1');
  assert.equal(entries.length, 2, 'turn-start baseline and after-edit savepoint');
  // Newest first. The after-edit label is the labeler's deterministic fallback:
  // the Host reports the label one-shot unavailable, so no model request is made.
  assert.deepEqual(entries.map(entry => entry.label), ['改动 a.txt', '本轮开始时的工作区基线']);
  // The user's branch, index and working tree are not touched.
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'status', '--porcelain'), 'M a.txt');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'two\n');
});

test('a Host turn that is not dispatched leaves no after-edit savepoint', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const { repo, snapshot } = setup(t, 'snapshot-owner-abort');
  await snapshot.onTurnStart('task-2');
  snapshot.onTurnAbort('task-2');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');
  await snapshot.onTurnEnd('task-2');
  const { entries } = await listShadowSavepoints(repo, 'task-2');
  assert.equal(entries.length, 1, 'only the turn-start baseline remains');
});
