import { assertSafeBaseUrl, fetchWithSafeRedirect } from '@cindy/gitlab-client';
import { isPrHost, sessionPrUrl, type PrChecksSummary } from '@cindy/maker-shared';
import type { PrRemoteState, PrStatusQuery } from './prStatusService';

export const GITLAB_MR_QUERY = `query MrStatus($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      state draft title webUrl sourceBranch diffHeadSha conflicts
      resolvableDiscussionsCount resolvedDiscussionsCount
      headPipeline { status jobs(retried: false, first: 100) { count nodes { status allowFailure } pageInfo { hasNextPage } } }
    }
  }
}`;

type MergeRequest = {
  state: string;
  draft: boolean;
  conflicts?: boolean | null;
  title: string;
  sourceBranch: string;
  diffHeadSha: string;
  resolvableDiscussionsCount: number | null;
  resolvedDiscussionsCount: number | null;
  headPipeline: null | {
    status: string;
    jobs: {
      count: number;
      nodes: Array<{ status: string; allowFailure?: boolean }>;
      pageInfo: { hasNextPage: boolean };
    };
  };
};

export function gitlabChecks(mr: MergeRequest): PrChecksSummary | null {
  const pipeline = mr.headPipeline;
  if (!mr.diffHeadSha) return null;
  if (pipeline === null) return { total: 0, failed: 0, passed: 0, pending: 0, skipped: 0 };
  if (!pipeline) return null;
  const jobs = pipeline.jobs;
  if (
    !jobs ||
    jobs.pageInfo?.hasNextPage !== false ||
    !Array.isArray(jobs.nodes) ||
    jobs.count !== jobs.nodes.length
  )
    return null;
  const counts: PrChecksSummary = {
    total: jobs.count,
    failed: 0,
    pending: 0,
    passed: 0,
    skipped: 0,
  };
  for (const job of jobs.nodes) {
    const status = job?.status?.toUpperCase();
    if (status === 'SUCCESS') counts.passed++;
    else if (status === 'SKIPPED' || (status === 'MANUAL' && job.allowFailure === true))
      counts.skipped++;
    else if (status === 'FAILED' || status === 'CANCELED') counts.failed++;
    else if (
      [
        'CREATED',
        'WAITING_FOR_RESOURCE',
        'PREPARING',
        'PENDING',
        'RUNNING',
        'MANUAL',
        'SCHEDULED',
      ].includes(status)
    )
      counts.pending++;
    else return null;
  }
  return counts;
}

export async function fetchGitlabMr(
  token: string,
  q: PrStatusQuery,
  fetchImpl: typeof fetch,
): Promise<PrRemoteState> {
  if (q.provider !== 'gitlab' || !isPrHost(q.host)) throw new Error('INVALID_GITLAB_IDENTITY');
  const origin = `https://${q.host.toLowerCase()}`;
  assertSafeBaseUrl(origin);
  const response = await fetchWithSafeRedirect(
    `${origin}/api/graphql`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: GITLAB_MR_QUERY,
        variables: { path: `${q.owner}/${q.repo}`, iid: String(q.prNumber) },
      }),
      signal: AbortSignal.timeout(15_000),
    },
    undefined,
    async (input, init) => {
      // Enforce exact HTTPS origin on every hop, including same-host downgrades.
      const target = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (target.origin !== origin) throw new Error('INVALID_GITLAB_ORIGIN');
      return fetchImpl(input, init);
    },
  );
  // Never propagate server bodies or headers into errors/logs.
  if (!response.ok)
    throw Object.assign(new Error('GITLAB_QUERY_FAILED'), { status: response.status });
  const payload = (await response.json()) as {
    data?: { project?: { mergeRequest?: MergeRequest } };
    errors?: unknown[];
  };
  if (payload.errors?.length) throw new Error('GITLAB_QUERY_FAILED');
  const mr = payload.data?.project?.mergeRequest;
  if (!mr) throw Object.assign(new Error('GITLAB_MR_NOT_FOUND'), { status: 404 });
  if (!['opened', 'closed', 'merged', 'locked'].includes(mr.state))
    throw new Error('GITLAB_STATE_UNKNOWN');
  const total = mr.resolvableDiscussionsCount;
  const resolved = mr.resolvedDiscussionsCount;
  return {
    state: mr.state === 'opened' ? 'open' : 'closed',
    merged: mr.state === 'merged',
    draft: mr.draft,
    conflicts: typeof mr.conflicts === 'boolean' ? mr.conflicts : null,
    title: mr.title,
    html_url: sessionPrUrl(q),
    branch: mr.sourceBranch,
    head_sha: mr.diffHeadSha,
    unresolved_count:
      Number.isSafeInteger(total) &&
      Number.isSafeInteger(resolved) &&
      total! >= resolved! &&
      resolved! >= 0
        ? total! - resolved!
        : null,
    checks: gitlabChecks(mr),
  };
}
