import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import nodeTest from 'node:test';

import { decide, isHumanOnlyReviewPending, watchFromSnapshot } from '../../apps/desktop/resources/system-skills/pr/scripts/pr-heartbeat-gate.mjs';
import { splitHttpResponse, rateLimitRetryAt } from '../../apps/desktop/resources/system-skills/pr/scripts/lib/gh.mjs';
import {
  parseGitHubRemote,
  parsePullRequestUrl,
  resolvePullRequestTarget,
} from '../../apps/desktop/resources/system-skills/pr/scripts/lib/repo-target.mjs';

// The fake `gh` below is a POSIX shell script, which Windows cannot execute.
const test = (name, fn) => nodeTest(name, { skip: process.platform === 'win32' ? 'POSIX-only: fake gh shim / symlink' : false }, fn);

const script = fileURLToPath(new URL('../../apps/desktop/resources/system-skills/pr/scripts/pr-snapshot.mjs', import.meta.url));
const group = (conclusion = 'FAILURE', truncated = false) => ({
  oid: 'group-sha',
  statusCheckRollup: { contexts: {
    totalCount: 1, pageInfo: { hasNextPage: truncated },
    nodes: [{ __typename: 'CheckRun', name: 'arm64-build', status: 'COMPLETED', conclusion }],
  } },
});
const removal = { __typename: 'RemovedFromMergeQueueEvent', id: 'removed', reason: 'failed_checks', beforeCommit: group() };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-snapshot-queue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A POSIX shell `gh`: each snapshot makes several gh calls, and a shell shim answers them
  // without starting a Node process per call. It still rejects writes and checks the query.
  fs.writeFileSync(path.join(root, 'gh'), `#!/bin/sh
d="$QUEUE_FIXTURE_DIR"
for a in "$@"; do
  case "$a" in
    --method|-X|*mutation*) echo "Snapshot must not mutate GitHub" >&2; exit 1 ;;
  esac
done
case "$1" in --version|auth) exit 0 ;; esac
if [ "$1" = pr ] && [ "$2" = view ]; then cat "$d/resp-prview.json"; exit 0; fi
if [ "$1" = api ] && [ "$2" = graphql ]; then
  q=""
  for a in "$@"; do case "$a" in query=*) q="$a" ;; esac; done
  case "$q" in *checkRunCountsByState*) cat "$d/resp-probe.json"; exit 0 ;; esac
  for f in mergeQueueEntry beforeCommit ADDED_TO_MERGE_QUEUE_EVENT headRefOid; do
    case "$q" in *"$f"*) ;; *) echo "Missing query field: $f" >&2; exit 1 ;; esac
  done
  cat "$d/resp-graphql.json"; exit 0
fi
case "$2" in
  */compare/head-sha...group-sha) cat "$d/resp-compare.json"; exit 0 ;;
  */compare/*) echo "Wrong ancestry direction" >&2; exit 1 ;;
esac
if [ "$1" = api ] && [ "$2" = repos/acme/game/pulls/54 ]; then cat "$d/resp-rest.json"; exit 0; fi
echo "Unexpected command: $*" >&2
exit 1
`, { mode: 0o755 });
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  return (overrides = {}, comparison = 'ahead', heads = {}) => {
    const data = { comparison, checkHead: 'head-sha', restHead: 'head-sha', ...heads, pr: {
      state: 'OPEN', headRefOid: 'head-sha', mergeStateStatus: 'CLEAN',
      reviewThreads: { nodes: [] }, mergeQueueEntry: null,
      timelineItems: { nodes: [removal] }, ...overrides,
    } };
    write('resp-prview.json', { headRefOid: data.checkHead, statusCheckRollup: data.rollup ?? [{ __typename: 'CheckRun', name: 'PR check', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    write('resp-graphql.json', { data: { viewer: { login: 'me' }, repository: { pullRequest: data.pr } } });
    write('resp-probe.json', { data: { repository: { pullRequest: data.pr } } });
    write('resp-compare.json', { status: data.comparison });
    write('resp-rest.json', { head: { sha: data.restHead }, mergeable: true, state: 'open', html_url: 'https://github.com/acme/game/pull/54' });
    return JSON.parse(execFileSync(process.execPath, [script, 'https://github.com/acme/game/pull/54', ...(data.args ?? [])], {
      env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`, QUEUE_FIXTURE_DIR: root }, encoding: 'utf8',
    }));
  };
}

test('full snapshot: PR green + merge-group failed/removed wakes gate despite approval blocker', t => {
  const run = fixture(t);
  const healthy = run({ timelineItems: { nodes: [] } });
  assert.equal(healthy.verdict, 'READY');
  const broken = run({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' });
  assert.equal(broken.checksSummary.failed, 0);
  assert.equal(broken.verdict, 'NEEDS_WORK');
  assert.equal(broken.mergeQueue.checksSummary.failingRuns[0].name, 'arm64-build');
  assert.ok(broken.blockers.includes('merge_queue_ci_failing'));
  assert.equal(isHumanOnlyReviewPending(broken), false);
  const decision = decide({ snap: broken, previous: { watch: watchFromSnapshot(healthy, Date.now()) }, now: Date.now() });
  assert.equal(decision.exitCode, 0);
  assert.equal(decision.reason, 'changed');
  assert.match(decision.detail, /events=\[merge-queue\]/);
});

test('full snapshot: compare ancestry prevents stale failures, including batched groups', t => {
  const run = fixture(t);
  for (const status of ['ahead', 'identical']) assert.equal(run({}, status).verdict, 'NEEDS_WORK');
  for (const status of ['behind', 'diverged']) {
    const snap = run({}, status);
    assert.equal(snap.verdict, 'READY');
    assert.equal(snap.mergeQueue.status, 'SUPERSEDED');
  }
  assert.ok(run({}, 'unknown').blockers.includes('merge_queue_unavailable'));
});

test('full snapshot: active queue checks, requeue and incomplete evidence', t => {
  const run = fixture(t);
  const entry = { id: 'new-entry', state: 'AWAITING_CHECKS', headCommit: group('SUCCESS') };
  assert.equal(run({ mergeQueueEntry: entry }).verdict, 'WAITING_CI');
  assert.equal(run({ mergeQueueEntry: { ...entry, headCommit: group() } }).verdict, 'NEEDS_WORK');
  assert.ok(run({ mergeQueueEntry: { ...entry, headCommit: group('SUCCESS', true) } }).blockers.includes('merge_queue_unavailable'));
  assert.equal(run({ mergeQueueEntry: { ...entry, headCommit: null } }).verdict, 'WAITING_CI');
  const unknown = run({ timelineItems: { nodes: [{ __typename: 'AddedToMergeQueueEvent', id: 'added' }] } });
  assert.ok(unknown.blockers.includes('merge_queue_unavailable'));
});

test('full snapshot: terminal status wins over historical failure', t => {
  const run = fixture(t);
  assert.equal(run({ merged: true, closed: true }).verdict, 'MERGED_CLEANUP_READY');
  assert.equal(run({ closed: true, state: 'CLOSED' }).verdict, 'CLOSED_CLEANUP_REVIEW');
});

test('another repo retains its approval gate, even after old queue failure is superseded', t => {
  const run = fixture(t);
  for (const timelineItems of [{ nodes: [] }, { nodes: [removal] }]) {
    const snap = run({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', timelineItems }, 'diverged');
    assert.equal(snap.repo, 'acme/game');
    assert.equal(snap.verdict, 'BLOCKED_HUMAN');
    assert.deepEqual(snap.blockers, ['branch_protection_blocked', 'approval_required']);
  }
});

test('push between REST/checks/GraphQL queries never assigns old green checks to the new head', t => {
  const run = fixture(t);
  for (const heads of [
    { restHead: 'old', checkHead: 'old' },
    { restHead: 'old', checkHead: 'head-sha' },
    { restHead: 'head-sha', checkHead: 'old' },
    { checkHead: null },
  ]) {
    const snap = run({ timelineItems: { nodes: [] } }, 'ahead', heads);
    assert.equal(snap.latestCommitOid, 'head-sha');
    assert.equal(snap.verdict, 'NEEDS_WORK');
    assert.ok(snap.blockers.includes('checks_unavailable'));
    assert.equal(snap.checksSummary.unavailable, true);
    assert.deepEqual(snap.checks, []);
  }
});

test('dequeue cancellations and action requests do not invent a CI failure', t => {
  const run = fixture(t);
  for (const reason of ['manually_removed', 'unknown']) {
    for (const conclusion of ['CANCELLED', 'ACTION_REQUIRED', 'FAILURE']) {
      const snap = run({ timelineItems: { nodes: [{ ...removal, reason, beforeCommit: group(conclusion) }] } });
      assert.deepEqual(snap.mergeQueue.blockers, ['merge_queue_removed']);
    }
  }
  assert.ok(run({ timelineItems: { nodes: [{ ...removal, beforeCommit: group('CANCELLED') }] } }).blockers.includes('merge_queue_ci_failing'));
  const action = run({ mergeQueueEntry: { id: 'q', state: 'AWAITING_CHECKS', headCommit: group('ACTION_REQUIRED') } });
  assert.equal(action.verdict, 'BLOCKED_HUMAN');
  assert.ok(action.blockers.includes('check_action_required'));
  assert.ok(!action.blockers.includes('merge_queue_ci_failing'));
});

// ---------- gh 包装：限流元数据 ----------

nodeTest('gh wrapper requests headers and preserves rate-limit metadata on a fatal response', { skip: process.platform === 'win32' ? 'POSIX-only: fake gh shim / symlink' : false }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-rate-limit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const retryAt = Math.floor(Date.now() / 1000) + 600;
  fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
if (!process.argv.includes('--include')) process.exit(2);
process.stdout.write('HTTP/2.0 403 Forbidden\\nX-RateLimit-Reset: ${retryAt}\\n\\n{}');
process.stderr.write('gh: API rate limit already exceeded');
process.exitCode = 1;
`, { mode: 0o755 });
  const moduleUrl = new URL('../../apps/desktop/resources/system-skills/pr/scripts/lib/gh.mjs', import.meta.url).href;
  for (const call of ["ghJson('test', { includeHeaders: true })", "ghGraphQL('query{}', {}, { includeHeaders: true })"]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { ghJson, ghGraphQL } from ${JSON.stringify(moduleUrl)}; await ${call};`], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`\\[gh-rate-limit\\] retryAt=${retryAt * 1000}`));
  }
});

nodeTest('HTTP metadata is separated from JSON for LF and CRLF responses', () => {
  for (const newline of ['\n', '\r\n']) {
    const response = ['HTTP/2.0 200 OK', 'Content-Type: application/json', 'X-RateLimit-Reset: 123', '', '{"ok":true}'].join(newline);
    const { headers, body } = splitHttpResponse(response);
    assert.deepEqual(JSON.parse(body), { ok: true });
    assert.equal(rateLimitRetryAt(headers, 100_000), 123_000);
  }
  assert.equal(splitHttpResponse('{"ok":true}').body, '{"ok":true}');
});

nodeTest('Retry-After seconds and dates override an earlier reset; invalid values fall back', () => {
  assert.equal(rateLimitRetryAt('Retry-After: 60\nX-RateLimit-Reset: 110', 100_000), 160_000);
  assert.equal(rateLimitRetryAt('Retry-After: Thu, 01 Jan 1970 00:03:00 GMT', 100_000), 180_000);
  assert.equal(rateLimitRetryAt('X-RateLimit-Reset: garbage', 100_000), null);
  assert.equal(rateLimitRetryAt('X-RateLimit-Reset: 90', 100_000), null);
  assert.equal(rateLimitRetryAt('Retry-After: 60\nX-RateLimit-Reset: 3700\nX-RateLimit-Remaining: 4000', 100_000), 160_000);
  assert.equal(rateLimitRetryAt('Retry-After: 60\nX-RateLimit-Reset: 3700', 100_000), 160_000);
  assert.equal(rateLimitRetryAt('Retry-After: 60\nX-RateLimit-Reset: 3700\nX-RateLimit-Remaining: 0', 100_000), 3_700_000);
  assert.equal(rateLimitRetryAt('X-RateLimit-Reset: 3700\nX-RateLimit-Remaining: 4000', 100_000), null);
});

// ---------- 仓库与 PR 目标解析 ----------

nodeTest('parses common GitHub remote forms', () => {
  assert.equal(parseGitHubRemote('git@github.com:acme/widgets-moved.git'), 'acme/widgets-moved');
  assert.equal(parseGitHubRemote('https://github.com/acme/widgets-moved.git'), 'acme/widgets-moved');
  assert.equal(parseGitHubRemote('ssh://git@github.com/acme/widgets-moved.git'), 'acme/widgets-moved');
  assert.equal(parseGitHubRemote('git@gitlab.example.com:group/repo.git'), null);
});

nodeTest('full PR URL supplies repo and number', () => {
  assert.deepEqual(parsePullRequestUrl('https://github.com/acme/widgets/pull/42'), {
    repo: 'acme/widgets',
    number: 42,
  });
  assert.deepEqual(resolvePullRequestTarget('https://github.com/acme/widgets/pull/42/files'), {
    repo: 'acme/widgets',
    owner: 'acme',
    name: 'widgets',
    number: 42,
  });
});

nodeTest('bare number resolves repo from worktree origin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-target-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
    assert.deepEqual(resolvePullRequestTarget('42', { worktree: dir }), {
      repo: 'acme/widgets',
      owner: 'acme',
      name: 'widgets',
      number: 42,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

nodeTest('rejects conflicting URL and explicit repo', () => {
  assert.throws(
    () => resolvePullRequestTarget('https://github.com/acme/widgets/pull/42', { explicitRepo: 'other/repo' }),
    /does not match/,
  );
});

nodeTest('rejects a URL that cannot supply a GitHub repository', () => {
  assert.throws(
    () => resolvePullRequestTarget('https://gitlab.example.com/acme/widgets/pull/42'),
    /Unsupported GitHub PR URL/,
  );
});

test('checks keep only the latest run per name, carry required flags, and the probe stays small', t => {
  const run = fixture(t);
  const ci = (name, conclusion, startedAt) => ({ __typename: 'CheckRun', name, workflowName: 'ci', status: 'COMPLETED', conclusion, startedAt });
  const rollup = [
    ci('verify', 'CANCELLED', '2026-10-17T10:00:00Z'),
    ci('verify', 'SUCCESS', '2026-10-17T10:20:00Z'),
    ci('lint', 'FAILURE', '2026-10-17T10:00:00Z'),
    { __typename: 'CheckRun', name: 'codeql', status: 'IN_PROGRESS', startedAt: '2026-10-17T10:05:00Z' },
  ];
  const contexts = { totalCount: 4, pageInfo: { hasNextPage: false }, nodes: [{ __typename: 'CheckRun', name: 'verify', isRequired: true }] };
  const snap = run({ timelineItems: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts } } }] } }, 'ahead', { rollup });
  assert.equal(snap.viewer, 'me');
  assert.deepEqual(snap.checks.map((c) => [c.name, c.outcome, c.required]), [
    ['verify', 'passed', true], ['lint', 'failed', false], ['codeql', 'pending', false],
  ]);
  assert.equal(snap.checksSummary.failed, 1, 'the re-run replaced the cancelled verify');

  const probe = run({
    isDraft: false, mergeable: 'MERGEABLE', comments: { totalCount: 2, nodes: [{ updatedAt: 'c2' }] },
    reviews: { totalCount: 0, nodes: [] }, reviewThreads: { totalCount: 1 },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { checkRunCountsByState: [{ state: 'SUCCESS', count: 3 }, { state: 'QUEUED', count: 0 }] } } } }] },
  }, 'ahead', { args: ['--probe'] });
  assert.deepEqual(probe, { status: 'OPEN false MERGEABLE head-sha  SUCCESS:3 ', remarks: '2 c2 0  1' });
});
