import type { GithubClient } from '@cindy/github-client';
import type { PrChecksSummary } from '@cindy/maker-shared';
import type { PrStatusQuery } from './prStatusService';

interface StateCount {
  state: string;
  count: number;
}
interface RollupNode {
  __typename?: string;
  databaseId?: number | null;
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  checkSuite?: {
    databaseId?: number | null;
    app?: { slug?: string | null } | null;
    workflowRun?: { workflow?: { databaseId?: number | null } | null } | null;
  } | null;
}

/** Stable job identity; null keeps the run ungrouped (raw counts) rather than risk merging jobs. */
function checkRunKey(node: RollupNode): string | null {
  const slug = node.checkSuite?.app?.slug;
  if (!slug || !node.name) return null;
  const workflowRun = node.checkSuite?.workflowRun;
  // Workflow display names are not unique; only the workflow id separates same-named workflows.
  if (workflowRun || slug === 'github-actions') {
    const workflowId = workflowRun?.workflow?.databaseId;
    if (typeof workflowId !== 'number' || !Number.isSafeInteger(workflowId)) return null;
    return [slug, workflowId, node.name].join('\u0000');
  }
  return [slug, '', node.name].join('\u0000');
}
interface RollupCounts {
  totalCount: number;
  checkRunCountsByState: StateCount[] | null;
  statusContextCountsByState: StateCount[] | null;
  nodes?: RollupNode[] | null;
  pageInfo?: { hasNextPage: boolean } | null;
}

/**
 * GitHub's rollup counts every check run on the head, including runs superseded by a newer
 * execution of the same job (e.g. a concurrency-cancelled duplicate workflow run). Like
 * required-check evaluation, for each app/workflow id/name only the newest check suite counts.
 * Same-named runs inside one suite (e.g. matrix jobs with a fixed name) are independent and all
 * count. Without the complete node list the GitHub counts are kept as-is, so a real failure is
 * never hidden.
 */
function withoutSupersededRuns(counts: RollupCounts): RollupCounts {
  const { nodes, checkRunCountsByState } = counts;
  if (!nodes || !checkRunCountsByState) return counts;
  if (counts.pageInfo?.hasNextPage !== false || nodes.length !== counts.totalCount) return counts;
  // key → suite id → runs of that suite and their newest run id.
  const groups = new Map<string, Map<number, { newest: number; runs: RollupNode[] }>>();
  for (const node of nodes) {
    if (node.__typename !== 'CheckRun') continue;
    const id = node.databaseId;
    const suiteId = node.checkSuite?.databaseId;
    const key = checkRunKey(node);
    if (key === null || typeof id !== 'number' || !Number.isSafeInteger(id)) continue;
    if (typeof suiteId !== 'number' || !Number.isSafeInteger(suiteId)) continue;
    const suites = groups.get(key) ?? new Map<number, { newest: number; runs: RollupNode[] }>();
    const suite = suites.get(suiteId) ?? { newest: id, runs: [] };
    suite.newest = Math.max(suite.newest, id);
    suite.runs.push(node);
    suites.set(suiteId, suite);
    groups.set(key, suites);
  }
  const superseded: RollupNode[] = [];
  for (const suites of groups.values()) {
    if (suites.size < 2) continue;
    const current = Math.max(...[...suites.values()].map((suite) => suite.newest));
    for (const suite of suites.values()) if (suite.newest !== current) superseded.push(...suite.runs);
  }
  if (!superseded.length) return counts;
  const runCounts = checkRunCountsByState.map((entry) => ({ ...entry }));
  for (const run of superseded) {
    const state = run.status === 'COMPLETED' ? run.conclusion : run.status;
    const entry = runCounts.find((candidate) => candidate.state === state);
    if (!entry || entry.count < 1) return counts;
    entry.count -= 1;
  }
  return {
    ...counts,
    totalCount: counts.totalCount - superseded.length,
    checkRunCountsByState: runCounts,
  };
}

export function summarizeChecks(rollup: RollupCounts): PrChecksSummary | null {
  const counts = withoutSupersededRuns(rollup);
  if (!counts.checkRunCountsByState || !counts.statusContextCountsByState) return null;
  const result: PrChecksSummary = {
    total: counts.totalCount,
    failed: 0,
    passed: 0,
    pending: 0,
    skipped: 0,
  };
  for (const { state, count } of [
    ...counts.checkRunCountsByState,
    ...counts.statusContextCountsByState,
  ]) {
    if (!Number.isSafeInteger(count) || count < 0) return null;
    if (state === 'SUCCESS') result.passed += count;
    else if (['NEUTRAL', 'SKIPPED'].includes(state)) result.skipped += count;
    else if (
      [
        'ERROR',
        'FAILURE',
        'CANCELLED',
        'TIMED_OUT',
        'ACTION_REQUIRED',
        'STARTUP_FAILURE',
        'STALE',
      ].includes(state)
    )
      result.failed += count;
    else if (['EXPECTED', 'PENDING', 'QUEUED', 'WAITING', 'IN_PROGRESS'].includes(state))
      result.pending += count;
    else if (count > 0) return null;
  }
  return result.failed + result.passed + result.pending + result.skipped === result.total
    ? result
    : null;
}

const SUMMARY_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      mergeStateStatus
      reviewDecision
      reviewThreads(first: 100) { nodes { isResolved } pageInfo { hasNextPage } }
      commits(last: 1) { nodes { commit { oid statusCheckRollup {
        contexts(first: 100) {
          totalCount checkRunCountsByState { state count } statusContextCountsByState { state count }
          nodes { __typename ... on CheckRun { databaseId name status conclusion
            checkSuite { databaseId app { slug } workflowRun { workflow { databaseId } } } } }
          pageInfo { hasNextPage }
        }
      } } } }
    }
  }
}`;

interface SummaryResponse {
  repository: {
    pullRequest: {
      headRefOid: string;
      mergeStateStatus?: string | null;
      reviewDecision?: string | null;
      reviewThreads: { nodes: { isResolved: boolean }[]; pageInfo: { hasNextPage: boolean } };
      commits?: {
        nodes: { commit: { oid: string; statusCheckRollup: { contexts: RollupCounts } | null } }[];
      };
    } | null;
  } | null;
}

/** Only thread resolution bits and aggregate counts; never comments or Actions logs. */
export async function fetchPrSummary(
  client: GithubClient,
  q: PrStatusQuery,
): Promise<{
  headOid: string | null;
  unresolved: number | null;
  checks: PrChecksSummary | null;
  mergeState: string | null;
  reviewDecision: string | null;
}> {
  const data = await client.graphql<SummaryResponse>(SUMMARY_QUERY, {
    owner: q.owner,
    repo: q.repo,
    number: q.prNumber,
  });
  const pr = data.repository?.pullRequest;
  if (!pr) return { headOid: null, unresolved: null, checks: null, mergeState: null, reviewDecision: null };
  const commit = pr.commits?.nodes[0]?.commit;
  const checks =
    commit?.oid === pr.headRefOid
      ? commit.statusCheckRollup
        ? summarizeChecks(commit.statusCheckRollup.contexts)
        : { total: 0, failed: 0, passed: 0, pending: 0, skipped: 0 }
      : null;
  // Keep the existing one-request/100-thread boundary. A truncated count is unknown,
  // never a misleading lower number (including zero).
  const unresolved = pr.reviewThreads.pageInfo.hasNextPage
    ? null
    : pr.reviewThreads.nodes.filter((n) => !n.isResolved).length;
  return {
    headOid: pr.headRefOid,
    unresolved,
    checks,
    mergeState: pr.mergeStateStatus ?? null,
    reviewDecision: pr.reviewDecision ?? null,
  };
}
