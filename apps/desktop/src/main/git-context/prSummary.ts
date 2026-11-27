import type { GithubClient } from '@cindy/github-client';
import type { PrChecksSummary } from '@cindy/maker-shared';
import type { PrRemoteState, PrStatusQuery } from './prStatusService';

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

const PR_REMOTE_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      state
      isDraft
      merged
      mergedAt
      title
      url
      body
      updatedAt
      headRefName
      headRefOid
      baseRefName
      baseRefOid
      mergeable
      mergeStateStatus
      reviewDecision
      author { login avatarUrl url }
      labels(first: 20) { nodes { name color } }
      reviewRequests(first: 20) {
        nodes {
          requestedReviewer {
            __typename
            ... on User { login }
            ... on Team { slug name }
          }
        }
      }
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

interface PrRemoteGraphqlResponse {
  repository: {
    pullRequest: {
      state: 'OPEN' | 'CLOSED' | 'MERGED' | string;
      isDraft?: boolean | null;
      merged?: boolean | null;
      mergedAt?: string | null;
      title?: string | null;
      url?: string | null;
      body?: string | null;
      updatedAt?: string | null;
      headRefName?: string | null;
      headRefOid?: string | null;
      baseRefName?: string | null;
      baseRefOid?: string | null;
      mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | string | null;
      mergeStateStatus?: string | null;
      reviewDecision?: string | null;
      author?: { login?: string | null; avatarUrl?: string | null; url?: string | null } | null;
      labels?: { nodes?: Array<{ name?: string | null; color?: string | null } | null> | null } | null;
      reviewRequests?: {
        nodes?: Array<{
          requestedReviewer?: { __typename?: string; login?: string | null; slug?: string | null; name?: string | null } | null;
        } | null> | null;
      } | null;
      reviewThreads?: { nodes: { isResolved: boolean }[]; pageInfo: { hasNextPage: boolean } } | null;
      commits?: {
        nodes: { commit: { oid: string; statusCheckRollup: { contexts: RollupCounts } | null } }[];
      } | null;
    } | null;
  } | null;
}

function mapGraphqlMergeable(value: string | null | undefined): boolean | null {
  if (value === 'MERGEABLE') return true;
  if (value === 'CONFLICTING') return false;
  return null;
}

/**
 * Single-request GraphQL PR status + summary read (0 REST core quota).
 * Returns null only when GraphQL returned an empty repository/PR shape is converted to 404.
 */
export async function fetchPrRemoteGraphql(
  client: GithubClient,
  q: PrStatusQuery,
): Promise<PrRemoteState> {
  const data = await client.graphql<PrRemoteGraphqlResponse>(PR_REMOTE_QUERY, {
    owner: q.owner,
    repo: q.repo,
    number: q.prNumber,
  });
  const pr = data.repository?.pullRequest;
  if (!pr) {
    throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
  }
  const headSha = pr.headRefOid ?? '';
  const commit = pr.commits?.nodes?.[0]?.commit;
  const checks =
    headSha && commit?.oid === headSha
      ? commit.statusCheckRollup
        ? summarizeChecks(commit.statusCheckRollup.contexts)
        : { total: 0, failed: 0, passed: 0, pending: 0, skipped: 0 }
      : null;
  const threads = pr.reviewThreads;
  const unresolved = !threads || threads.pageInfo.hasNextPage
    ? null
    : threads.nodes.filter((n) => !n.isResolved).length;
  const merged = Boolean(pr.merged || pr.state === 'MERGED');
  const mergeable = mapGraphqlMergeable(pr.mergeable);
  const reviewRequests: Array<{ login: string } | { slug: string; name?: string }> = [];
  for (const node of pr.reviewRequests?.nodes ?? []) {
    const reviewer = node?.requestedReviewer;
    if (!reviewer) continue;
    if (reviewer.login) reviewRequests.push({ login: reviewer.login });
    else if (reviewer.slug) {
      reviewRequests.push({ slug: reviewer.slug, ...(reviewer.name ? { name: reviewer.name } : {}) });
    }
  }
  const labels = (pr.labels?.nodes ?? []).flatMap((label) =>
    label?.name ? [{ name: label.name, ...(label.color ? { color: label.color } : {}) }] : [],
  );
  return {
    metadata: {
      body: pr.body ?? null,
      author: pr.author?.login
        ? {
            login: pr.author.login,
            ...(pr.author.avatarUrl ? { avatar_url: pr.author.avatarUrl } : {}),
            ...(pr.author.url ? { html_url: pr.author.url } : {}),
          }
        : null,
      base_sha: pr.baseRefOid ?? null,
      mergeable,
      merge_state: pr.mergeStateStatus ? pr.mergeStateStatus.toLowerCase() : null,
      updated_at: pr.updatedAt ?? null,
      merged_at: pr.mergedAt ?? null,
      labels,
      review_requests: reviewRequests,
    },
    state: pr.state === 'OPEN' ? 'open' : 'closed',
    draft: Boolean(pr.isDraft),
    merged,
    merged_at: pr.mergedAt ?? null,
    title: pr.title ?? '',
    html_url: pr.url ?? `https://github.com/${q.owner}/${q.repo}/pull/${q.prNumber}`,
    branch: pr.headRefName ?? '',
    head_sha: headSha,
    base_branch: pr.baseRefName ?? '',
    review_decision: pr.reviewDecision ?? null,
    unresolved_count: unresolved,
    checks,
    merge_state: pr.mergeStateStatus ?? null,
  };
}

/**
 * GraphQL-first PR status fetch (1 GraphQL call, 0 REST core calls), falling back to REST
 * `getPullRequest` only when GraphQL is unsupported or unavailable (e.g. legacy fine-grained PAT
 * or exhausted GraphQL bucket while REST remains available). Auth 401 and clean 404 short-circuit.
 */
export async function fetchPrRemoteWithFallback(
  client: GithubClient,
  q: PrStatusQuery,
  log?: { debug?: (msg: string, meta?: unknown) => void },
): Promise<PrRemoteState> {
  try {
    return await fetchPrRemoteGraphql(client, q);
  } catch (err) {
    const status = (err as { status?: unknown })?.status;
    if (status === 401 || status === 404) throw err;
    log?.debug?.('PR GraphQL remote fetch failed, falling back to REST', {
      key: `${q.owner}/${q.repo}#${q.prNumber}`,
      err: String(err),
    });
  }
  const pr = await client.getPullRequest(q.prNumber);
  const metadata = pr as typeof pr & {
    mergeable?: boolean | null;
    mergeable_state?: string;
    updated_at?: string;
    labels?: unknown[];
    requested_reviewers?: unknown[];
  };
  return {
    metadata: {
      body: pr.body,
      author: pr.user,
      base_sha: pr.base.sha ?? null,
      mergeable: metadata.mergeable ?? null,
      merge_state: metadata.mergeable_state ?? null,
      updated_at: metadata.updated_at ?? null,
      merged_at: pr.merged_at ?? null,
      labels: metadata.labels ?? [],
      review_requests: metadata.requested_reviewers ?? [],
    },
    state: pr.state,
    draft: pr.draft,
    merged: pr.merged,
    merged_at: pr.merged_at,
    title: pr.title,
    html_url: pr.html_url,
    branch: pr.head.ref,
    head_sha: pr.head.sha,
    base_branch: pr.base.ref,
    review_decision: null,
    unresolved_count: null,
    checks: null,
    merge_state: null,
  };
}
