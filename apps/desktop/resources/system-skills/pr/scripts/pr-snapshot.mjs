#!/usr/bin/env node
// Stable read-only GitHub PR snapshot for PR heartbeat tasks.
//
// Keep heartbeat prompts from hand-writing mixed gh/GraphQL field lists. This
// script centralizes the API shape and uses execFile-based gh wrappers so shell
// quoting cannot corrupt long GraphQL queries.

import { ensureAuth, ensureBinary, ghGraphQL, ghJson } from './lib/gh.mjs';
import { execFile } from 'node:child_process';
import { resolvePullRequestTarget } from './lib/repo-target.mjs';
import { classifyMergeQueue } from './lib/merge-queue.mjs';

const PASS_CONCLUSIONS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
const FAIL_CONCLUSIONS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STALE', 'STARTUP_FAILURE']);
const ACTION_REQUIRED_CONCLUSIONS = new Set(['ACTION_REQUIRED']);
const PENDING_STATES = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'REQUESTED', 'WAITING', 'EXPECTED']);
const VERDICT_EXIT_CODES = {
  READY: 0,
  MERGED_CLEANUP_READY: 0,
  WAITING_CI: 10,
  NEEDS_WORK: 20,
  BLOCKED_HUMAN: 30,
  NOT_READY: 40,
  CLOSED_CLEANUP_REVIEW: 40,
};

function usage() {
  process.stderr.write(`Usage: node scripts/pr-snapshot.mjs <pr-number-or-url> [--repo owner/name] [--strict-exit]\n`);
}

function parseArgs(argv) {
  let repo = null;
  let prArg = null;
  let strictExit = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--repo') {
      repo = argv[++i];
      continue;
    }
    if (arg === '--strict-exit') {
      strictExit = true;
      continue;
    }
    if (!prArg) {
      prArg = arg;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }
  return {
    ...resolvePullRequestTarget(prArg, { explicitRepo: repo }),
    strictExit,
  };
}

function lastCommit(prView) {
  const commits = Array.isArray(prView.commits) ? prView.commits : [];
  return commits.length ? commits[commits.length - 1] : null;
}

function isCheckPending(c) {
  if (!c) return false;
  if (c.type === 'CheckRun') return c.status && c.status !== 'COMPLETED';
  if (c.type === 'StatusContext') return PENDING_STATES.has(c.status);
  return PENDING_STATES.has(c.status);
}

function isCheckActionRequired(c) {
  return ACTION_REQUIRED_CONCLUSIONS.has(c?.conclusion);
}

function isCheckFailure(c) {
  if (!c) return false;
  if (c.type === 'StatusContext') return FAIL_CONCLUSIONS.has(c.status);
  if (!c.conclusion) return false;
  return !PASS_CONCLUSIONS.has(c.conclusion) && !isCheckActionRequired(c);
}

function summarizeChecks(checks, unavailable, truncated, totalCount) {
  const pendingRuns = checks.filter(isCheckPending);
  const failingRuns = checks.filter(isCheckFailure);
  const actionRequiredRuns = checks.filter(isCheckActionRequired);
  return {
    total: checks.length,
    totalCount,
    pending: pendingRuns.length,
    failed: failingRuns.length,
    actionRequired: actionRequiredRuns.length,
    unavailable,
    truncated,
    pendingRuns,
    failingRuns,
    actionRequiredRuns,
  };
}

function addBlocker(blockers, condition, name) {
  if (condition) blockers.push(name);
}

function deriveVerdict({ pr, ghView, checksSummary, reviewThreads, truncated, mergeQueue }) {
  const needsWorkBlockers = [];
  const waitingBlockers = [];
  const humanBlockers = [];
  const mergeStateStatus = pr.mergeStateStatus || ghView.mergeable_state || null;
  const reviewDecision = pr.reviewDecision || null;
  const mergeable = ghView.mergeable ?? null;

  if (pr.merged || ghView.merged) {
    return { verdict: 'MERGED_CLEANUP_READY', blockers: [] };
  }
  if (pr.closed || pr.state === 'CLOSED' || ghView.state === 'closed') {
    return { verdict: 'CLOSED_CLEANUP_REVIEW', blockers: [] };
  }
  if (pr.isDraft || mergeStateStatus === 'DRAFT') {
    return { verdict: 'NOT_READY', blockers: ['draft'] };
  }

  addBlocker(needsWorkBlockers, checksSummary.unavailable, 'checks_unavailable');
  addBlocker(needsWorkBlockers, truncated, 'snapshot_truncated');
  addBlocker(needsWorkBlockers, checksSummary.failed > 0, 'ci_failing');
  addBlocker(needsWorkBlockers, reviewThreads.unresolvedCount > 0, 'unresolved_review_threads');
  addBlocker(needsWorkBlockers, mergeStateStatus === 'BEHIND', 'branch_behind_base');
  addBlocker(needsWorkBlockers, mergeStateStatus === 'DIRTY' || mergeable === false, 'merge_conflict');
  addBlocker(needsWorkBlockers, mergeStateStatus === 'UNSTABLE', 'merge_state_unstable');
  for (const blocker of mergeQueue.blockers) {
    if (blocker === 'check_action_required') humanBlockers.push(blocker);
    else (blocker === 'merge_queue_pending' ? waitingBlockers : needsWorkBlockers).push(blocker);
  }

  addBlocker(waitingBlockers, checksSummary.pending > 0, 'pending_checks');
  addBlocker(waitingBlockers, mergeable === null || mergeStateStatus === 'UNKNOWN', 'mergeability_pending');

  addBlocker(humanBlockers, checksSummary.actionRequired > 0, 'check_action_required');
  addBlocker(humanBlockers, mergeStateStatus === 'BLOCKED' || mergeStateStatus === 'HAS_HOOKS', 'branch_protection_blocked');
  addBlocker(humanBlockers, reviewDecision === 'REVIEW_REQUIRED', 'approval_required');
  addBlocker(humanBlockers, reviewDecision === 'CHANGES_REQUESTED', 'changes_requested_waiting_re_review');

  const blockers = [...needsWorkBlockers, ...waitingBlockers, ...humanBlockers];
  if (waitingBlockers.length > 0 && needsWorkBlockers.length === 0) {
    return { verdict: 'WAITING_CI', blockers };
  }
  if (needsWorkBlockers.length > 0) {
    return { verdict: 'NEEDS_WORK', blockers };
  }
  if (humanBlockers.length > 0) {
    return { verdict: 'BLOCKED_HUMAN', blockers };
  }

  return { verdict: 'READY', blockers };
}

function ghPrViewJson(number, repo) {
  return new Promise((resolve, reject) => {
    execFile('gh', [
      'pr',
      'view',
      String(number),
      '--repo',
      repo,
      '--json',
      'statusCheckRollup,commits,headRefOid',
    ], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(JSON.parse(stdout));
      }
    });
  });
}

function normalizeCheckRun(x) {
  if (!x || typeof x !== 'object') return null;
  return {
    type: x.__typename || null,
    name: x.name || x.context || null,
    status: x.status || x.state || null,
    conclusion: x.conclusion || null,
    detailsUrl: x.detailsUrl || x.targetUrl || null,
    startedAt: x.startedAt || x.createdAt || null,
    completedAt: x.completedAt || null,
    workflowName: x.workflowName || null,
  };
}

function normalizeComment(c) {
  return {
    id: c.id || null,
    databaseId: c.databaseId || null,
    author: c.author?.login || null,
    body: c.body || '',
    createdAt: c.createdAt || null,
    updatedAt: c.updatedAt || null,
    url: c.url || null,
  };
}

function normalizeThread(t) {
  const comments = t.comments?.nodes || [];
  return {
    id: t.id,
    isResolved: Boolean(t.isResolved),
    isOutdated: Boolean(t.isOutdated),
    path: t.path || null,
    line: t.line ?? null,
    originalLine: t.originalLine ?? null,
    comments: comments.map(normalizeComment),
  };
}

function normalizeReview(r) {
  return {
    id: r.id || null,
    author: r.author?.login || null,
    state: r.state || null,
    body: r.body || '',
    submittedAt: r.submittedAt || null,
    url: r.url || null,
    // review 针对的 commit;与 latestCommitOid 对比可判「该 reviewer 是否已审最新
    // HEAD」(回合制等齐判据)、并用不同 oid 个数近似 review 轮数(pr 技能
    // references/review-convergence.md §5)。gate 指纹只取 id:state:submittedAt,
    // 不受此字段影响。
    commitOid: r.commit?.oid || null,
  };
}

function normalizeTopComment(c) {
  return {
    id: c.id || null,
    author: c.author?.login || null,
    body: c.body || '',
    createdAt: c.createdAt || null,
    updatedAt: c.updatedAt || null,
    url: c.url || null,
  };
}

const THREAD_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
      state
      closed
      merged
      isDraft
      mergedAt
      closedAt
      updatedAt
      reviewDecision
      mergeStateStatus
      headRefName
      headRefOid
      baseRefName
      mergeQueueEntry {
        id state
        headCommit { ...QueueCommit }
      }
      timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        nodes {
          __typename
          ... on AddedToMergeQueueEvent { id createdAt }
          ... on RemovedFromMergeQueueEvent {
            id createdAt reason
            beforeCommit { ...QueueCommit }
          }
        }
      }
      reviewThreads(first: 100) {
        totalCount
        pageInfo { hasNextPage }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 20) {
            nodes {
              id
              databaseId
              author { login }
              body
              createdAt
              updatedAt
              url
            }
          }
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                totalCount
                pageInfo { hasNextPage }
              }
            }
          }
        }
      }
      reviews(last: 50) {
        nodes {
          id
          author { login }
          state
          body
          submittedAt
          url
          commit { oid }
        }
      }
      comments(last: 50) {
        nodes {
          id
          author { login }
          body
          createdAt
          updatedAt
          url
        }
      }
    }
  }
}
fragment QueueCommit on Commit {
  oid
  statusCheckRollup {
    contexts(first: 100) {
      totalCount
      pageInfo { hasNextPage }
      nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl startedAt completedAt }
        ... on StatusContext { context state targetUrl createdAt }
      }
    }
  }
}
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureBinary();
  await ensureAuth();

  const prView = await ghJson(
    `repos/${args.repo}/pulls/${args.number}`, { includeHeaders: true }
  );
  const ghView = prView;

  let checkRollup = [];
  let checksUnavailable = false;
  let checksError = null;
  let checksHeadOid = null;
  try {
    const stdoutShape = await ghPrViewJson(args.number, args.repo);
    checksHeadOid = stdoutShape.headRefOid || null;
    checkRollup = Array.isArray(stdoutShape.statusCheckRollup)
      ? stdoutShape.statusCheckRollup.map(normalizeCheckRun).filter(Boolean)
      : [];
    if (Array.isArray(stdoutShape.commits) && stdoutShape.commits.length) {
      prView.__ghCommits = stdoutShape.commits;
    }
  } catch (e) {
    checksUnavailable = true;
    checksError = String(e.stderr || e.message || e).slice(0, 1000);
    checkRollup = [];
  }

  const gql = await ghGraphQL(THREAD_QUERY, {
    owner: args.owner,
    name: args.name,
    number: args.number,
  }, { includeHeaders: true });
  if (gql.errors?.length) throw new Error('Incomplete GraphQL snapshot: ' + gql.errors.map(e => e.message).join('; '));
  const pr = gql.data?.repository?.pullRequest;
  if (!pr) throw new Error(`Pull request not found: ${args.repo}#${args.number}`);
  // All head-scoped evidence must refer to the same commit. A push between
  // requests invalidates old checks/mergeability; do not present them as green
  // evidence for the newer GraphQL head. The next normal heartbeat can retry.
  if (!pr.headRefOid || checksHeadOid !== pr.headRefOid || ghView.head?.sha !== pr.headRefOid) {
    checksUnavailable = true;
    checksError = checksError || 'PR head changed between snapshot requests or check head is unavailable';
    checkRollup = [];
    ghView.mergeable = null;
    ghView.mergeable_state = null;
  }

  const entry = pr.mergeQueueEntry;
  const event = pr.timelineItems?.nodes?.at(-1) ?? null;
  const terminal = pr.merged || pr.closed;
  let containsHead = null;
  if (!terminal && !entry && event?.__typename === 'RemovedFromMergeQueueEvent' && event.beforeCommit?.oid && pr.headRefOid) {
    // beforeCommit is the synthetic merge-group commit, NOT the PR head.
    // Ancestry also covers batched groups where this PR is not a direct parent.
    const comparison = await ghJson(`repos/${args.repo}/compare/${pr.headRefOid}...${event.beforeCommit.oid}`, { includeHeaders: true });
    if (['ahead', 'identical', 'behind', 'diverged'].includes(comparison.status)) {
      containsHead = ['ahead', 'identical'].includes(comparison.status);
    }
  }
  const queueContexts = (entry ? entry.headCommit : event?.beforeCommit)?.statusCheckRollup?.contexts;
  const queueRuns = (queueContexts?.nodes ?? []).map(normalizeCheckRun).filter(Boolean);
  const mergeQueue = classifyMergeQueue({
    entry, event, containsHead, terminal,
    checks: summarizeChecks(queueRuns, false, Boolean(queueContexts?.pageInfo?.hasNextPage), queueContexts?.totalCount ?? queueRuns.length),
  });

  const threads = (pr.reviewThreads?.nodes || []).map(normalizeThread);
  const activeUnresolvedThreads = threads.filter(t => !t.isResolved && !t.isOutdated);
  const outdatedUnresolvedThreads = threads.filter(t => !t.isResolved && t.isOutdated);
  const rawUnresolvedThreads = threads.filter(t => !t.isResolved);
  const commits = Array.isArray(prView.__ghCommits) ? prView.__ghCommits : [];
  const latestCommit = lastCommit(commits);
  const reviewThreadsTruncated = Boolean(pr.reviewThreads?.pageInfo?.hasNextPage);
  const checkContexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts || null;
  const checksTruncated = Boolean(checkContexts?.pageInfo?.hasNextPage);
  const checksSummary = summarizeChecks(
    checkRollup,
    checksUnavailable,
    checksTruncated,
    checkContexts?.totalCount ?? checkRollup.length
  );
  const reviewThreads = {
    totalCount: pr.reviewThreads?.totalCount ?? threads.length,
    fetchedCount: threads.length,
    unresolvedCount: activeUnresolvedThreads.length,
    activeUnresolvedCount: activeUnresolvedThreads.length,
    outdatedUnresolvedCount: outdatedUnresolvedThreads.length,
    rawUnresolvedCount: rawUnresolvedThreads.length,
    truncated: reviewThreadsTruncated,
    nodes: threads,
  };
  const truncated = reviewThreadsTruncated || checksTruncated;
  const gate = deriveVerdict({ pr, ghView, checksSummary, reviewThreads, truncated, mergeQueue });
  const strictExitCode = VERDICT_EXIT_CODES[gate.verdict] ?? 50;

  const out = {
    fetchedAt: new Date().toISOString(),
    repo: args.repo,
    number: args.number,
    url: ghView.html_url,
    title: ghView.title,
    state: pr.state,
    closed: Boolean(pr.closed),
    merged: Boolean(pr.merged),
    isDraft: Boolean(pr.isDraft),
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    updatedAt: pr.updatedAt,
    reviewDecision: pr.reviewDecision,
    mergeStateStatus: pr.mergeStateStatus,
    mergeable: ghView.mergeable ?? null,
    mergeableState: ghView.mergeable_state ?? null,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    // REST /pulls 会把 base.sha 解析成 base 分支**当前** HEAD。gate 仅在 CI 红时
    // 条件性把它纳入指纹，让「失败其实来自旧 main、main 修好后该重跑」能被唤醒；
    // 健康 PR 不受 main 的日常推进影响。
    baseCommitOid: ghView.base?.sha || null,
    latestCommitOid: pr.headRefOid || latestCommit?.oid || ghView.head?.sha || null,
    // diff 规模(REST /pulls 自带):供 gate 的「范围膨胀」机判用。刻意不进 gate 指纹
    // (指纹按字段显式挑选),base 移动等噪声不会因此制造无谓唤起。
    additions: Number.isFinite(ghView.additions) ? ghView.additions : null,
    deletions: Number.isFinite(ghView.deletions) ? ghView.deletions : null,
    changedFiles: Number.isFinite(ghView.changed_files) ? ghView.changed_files : null,
    verdict: gate.verdict,
    blockers: gate.blockers,
    gate: {
      verdict: gate.verdict,
      strictExitCode,
      truncated,
      reviewThreadsTruncated,
      checksTruncated,
    },
    checks: checkRollup,
    mergeQueue,
    checksSummary: {
      total: checksSummary.total,
      totalCount: checksSummary.totalCount,
      pending: checksSummary.pending,
      failed: checksSummary.failed,
      actionRequired: checksSummary.actionRequired,
      unavailable: checksSummary.unavailable,
      error: checksError,
      truncated: checksSummary.truncated,
      pendingRuns: checksSummary.pendingRuns,
      failingRuns: checksSummary.failingRuns,
      actionRequiredRuns: checksSummary.actionRequiredRuns,
    },
    reviewThreads,
    reviews: (pr.reviews?.nodes || []).map(normalizeReview),
    comments: (pr.comments?.nodes || []).map(normalizeTopComment),
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (args.strictExit) process.exit(strictExitCode);
}

main().catch(e => {
  process.stderr.write(`[pr-snapshot] ${e.message}\n`);
  process.exit(2);
});
