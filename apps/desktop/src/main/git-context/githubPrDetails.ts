import type { GithubDetailKind } from '@cindy/maker-shared';
import type { PrStatusQuery } from './prStatusService';
import type { GithubReadTransport } from './githubReadTransport';

export type GithubFact = Record<string, unknown>;
export interface GithubDetails {
  items: GithubFact[];
  partial: boolean;
  observed_at: number;
  errors: string[];
}
export type Connection = {
  nodes: GithubFact[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};
const PAGE = 'pageInfo { hasNextPage endCursor }';
const COMMENT = 'id databaseId body createdAt updatedAt url author { login }';
const CHECK =
  '__typename ... on CheckRun { id databaseId name status conclusion startedAt completedAt detailsUrl checkSuite { id workflowRun { workflow { name } } } } ... on StatusContext { id context state targetUrl createdAt }';
const FIELDS = {
  comments: COMMENT,
  reviews: `${COMMENT} state submittedAt commit { oid }`,
  threads: `id isResolved isOutdated path line startLine diffSide resolvedBy { login } comments(first:100) { nodes { ${COMMENT} diffHunk originalCommit { oid } pullRequestReview { id } } ${PAGE} }`,
};

/** One normal observation reads all four connections; pagination remains explicit. */
export async function readGithubFirstPages(
  transport: GithubReadTransport,
  scope: string,
  token: string,
  pr: PrStatusQuery,
  head: string,
  refresh = false,
) {
  const data = (await transport.read(scope, token, '/graphql', {
    body: {
      query: `query($owner:String!,$repo:String!,$number:Int!,$head:String!) { repository(owner:$owner,name:$repo) {
      pullRequest(number:$number) {
        threads:reviewThreads(first:100) { nodes { ${FIELDS.threads} } ${PAGE} }
        comments(first:100) { nodes { ${FIELDS.comments} } ${PAGE} }
        reviews(first:100) { nodes { ${FIELDS.reviews} } ${PAGE} }
      }
      object(expression:$head) { ... on Commit { statusCheckRollup { contexts(first:100) { nodes { ${CHECK} } ${PAGE} } } } }
    } }`,
      variables: { owner: pr.owner, repo: pr.repo, number: pr.prNumber, head },
    },
    refresh,
  })) as {
    data?: {
      repository?: {
        pullRequest?: Record<string, Connection>;
        object?: { statusCheckRollup?: { contexts: Connection } };
      };
    };
    errors?: unknown[];
  };
  const repo = data.data?.repository;
  if (data.errors?.length || !repo?.pullRequest || !repo.object)
    throw new Error('GITHUB_OBSERVATION_INCOMPLETE');
  return {
    observedAt: transport.observedAt(data),
    pages: {
      ...repo.pullRequest,
      checks: repo.object.statusCheckRollup?.contexts ?? {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
}

/** Fully follows outer and nested connections; hitting the bounded budget is explicit. */
export async function readGithubDetails(params: {
  transport: GithubReadTransport;
  scope: string;
  token: string;
  pr: PrStatusQuery;
  kind: GithubDetailKind;
  head: string;
  base: string;
  refresh?: boolean;
  seed?: Connection;
  seedObservedAt?: number;
}): Promise<GithubDetails> {
  const { transport, scope, token, pr, kind, head, base, refresh } = params;
  let observed_at = params.seedObservedAt ?? Number.POSITIVE_INFINITY;
  const items: GithubFact[] = [];
  const errors: string[] = [];
  const variables = { owner: pr.owner, repo: pr.repo, number: pr.prNumber };
  const graphql = async (query: string, vars: Record<string, unknown>) => {
    const response = (await transport.read(scope, token, '/graphql', {
      body: { query, variables: vars },
      refresh,
    })) as { data?: Record<string, unknown>; errors?: unknown[] };
    observed_at = Math.min(observed_at, transport.observedAt(response));
    if (response.errors?.length || !response.data) throw new Error('GITHUB_GRAPHQL_UNAVAILABLE');
    return response.data;
  };
  let budget = 100;
  const collect = async (
    load: (after: string | null) => Promise<Connection>,
    output: GithubFact[],
  ) => {
    let after: string | null = null;
    do {
      if (--budget < 0) {
        errors.push('PAGE_LIMIT_REACHED');
        return;
      }
      const connection: Connection =
        !after && output === items && params.seed ? params.seed : await load(after);
      output.push(...structuredClone(connection.nodes.filter(Boolean)));
      if (!connection.pageInfo.hasNextPage) return;
      const next: string | null = connection.pageInfo.endCursor;
      if (!next || next === after) throw new Error('INVALID_GITHUB_CURSOR');
      after = next;
    } while (after);
  };
  try {
    if (kind === 'rules') {
      for (let page = 1; page <= 100; page++) {
        const batch = (await transport.read(
          scope,
          token,
          `/repos/${pr.owner}/${pr.repo}/rules/branches/${encodeURIComponent(base)}?per_page=100&page=${page}`,
          { ttl: 300_000, refresh },
        )) as GithubFact[];
        if (!Array.isArray(batch)) throw new Error('INVALID_GITHUB_RESPONSE');
        observed_at = Math.min(observed_at, transport.observedAt(batch));
        items.push(...structuredClone(batch));
        if (batch.length < 100) break;
        if (page === 100) errors.push('PAGE_LIMIT_REACHED');
      }
    } else if (kind === 'checks') {
      if (!head) throw new Error('HEAD_UNKNOWN');
      await collect(async (after) => {
        const data = await graphql(
          `query($owner:String!,$repo:String!,$head:String!,$after:String) {
          repository(owner:$owner,name:$repo) { object(expression:$head) { ... on Commit {
            statusCheckRollup { contexts(first:100,after:$after) { nodes { ${CHECK} } ${PAGE} } }
          } } }
        }`,
          { owner: pr.owner, repo: pr.repo, head, after },
        );
        const commit = (
          data.repository as { object?: { statusCheckRollup?: { contexts: Connection } } }
        )?.object;
        if (!commit) throw new Error('HEAD_UNKNOWN');
        return (
          commit.statusCheckRollup?.contexts ?? {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          }
        );
      }, items);
      for (const item of items) item.head_sha = head;
    } else {
      const field = kind === 'threads' ? 'reviewThreads' : kind;
      await collect(async (after) => {
        const data = await graphql(
          `query($owner:String!,$repo:String!,$number:Int!,$after:String) {
          repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
            ${field}(first:100,after:$after) { nodes { ${FIELDS[kind]} } ${PAGE} }
          } }
        }`,
          { ...variables, after },
        );
        const repository = data.repository as { pullRequest?: Record<string, Connection> } | null;
        if (!repository?.pullRequest?.[field]) throw new Error('GITHUB_PR_NOT_FOUND');
        return repository.pullRequest[field];
      }, items);
      if (kind === 'threads') {
        for (const thread of items) {
          const comments = thread.comments as Connection;
          if (!comments.pageInfo.hasNextPage) continue;
          const firstCursor = comments.pageInfo.endCursor;
          await collect(async (after) => {
            const data = await graphql(
              `query($id:ID!,$after:String) {
              node(id:$id) { ... on PullRequestReviewThread { comments(first:100,after:$after) {
                nodes { ${COMMENT} diffHunk originalCommit { oid } pullRequestReview { id } } ${PAGE}
              } } }
            }`,
              { id: thread.id, after: after ?? firstCursor },
            );
            return (data.node as { comments: Connection }).comments;
          }, comments.nodes);
          thread.comments = comments.nodes;
        }
        for (const thread of items)
          if (!Array.isArray(thread.comments))
            thread.comments = (thread.comments as Connection).nodes;
      }
    }
  } catch (error) {
    errors.push(
      error instanceof Error && /^[A-Z_0-9]+$/.test(error.message)
        ? error.message
        : 'GITHUB_DETAILS_UNAVAILABLE',
    );
  }
  return {
    items,
    partial: errors.length > 0,
    errors,
    observed_at: Number.isFinite(observed_at) ? observed_at : Date.now(),
  };
}
