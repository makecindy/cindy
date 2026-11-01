import type { GithubClient } from '@cindy/github-client';
import type { PrChecksSummary } from '@cindy/maker-shared';
import type { PrStatusQuery } from './prStatusService';

/** GitHub's rollup already selects current checks/status contexts, including reruns. */
interface StateCount {
  state: string;
  count: number;
}
interface RollupCounts {
  totalCount: number;
  checkRunCountsByState: StateCount[] | null;
  statusContextCountsByState: StateCount[] | null;
}

export function summarizeChecks(counts: RollupCounts): PrChecksSummary | null {
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
      reviewDecision
      reviewThreads(first: 100) { nodes { isResolved } pageInfo { hasNextPage } }
      commits(last: 1) { nodes { commit { oid statusCheckRollup {
        contexts { totalCount checkRunCountsByState { state count } statusContextCountsByState { state count } }
      } } } }
    }
  }
}`;

interface SummaryResponse {
  repository: {
    pullRequest: {
      headRefOid: string;
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
  reviewDecision?: string | null;
  unresolved: number | null;
  checks: PrChecksSummary | null;
}> {
  const data = await client.graphql<SummaryResponse>(SUMMARY_QUERY, {
    owner: q.owner,
    repo: q.repo,
    number: q.prNumber,
  });
  const pr = data.repository?.pullRequest;
  if (!pr) return { headOid: null, unresolved: null, checks: null };
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
  return { headOid: pr.headRefOid, unresolved, checks, reviewDecision: pr.reviewDecision ?? null };
}
