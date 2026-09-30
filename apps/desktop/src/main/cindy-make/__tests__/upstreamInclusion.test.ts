import { describe, expect, it, vi } from 'vitest';
import type { MakeRuntimeVersion, MakeUpstreamItem } from '../../../shared/cindyMakeDoctor';
import { filterUpstreamCandidates, type UpstreamRuntimeDeps } from '../upstreamInclusion';

const runtimeCommit = 'a'.repeat(40);
const prCommit = 'b'.repeat(40);
const headCommit = 'c'.repeat(40);
const runtime: MakeRuntimeVersion = {
  channel: 'release',
  version: '1.2.3',
  commit: runtimeCommit,
  confidence: 'exact',
};
const candidate = (number = 1): MakeUpstreamItem => ({
  number,
  title: 'Related feature',
  kind: 'pr',
  state: 'open',
  htmlUrl: 'https://github.com/makecindy/cindy/pull/' + number,
});
const detail = (number = 1, merged = true) => ({
  number,
  html_url: candidate(number).htmlUrl,
  merged,
  state: merged ? 'closed' : 'open',
  base: { repo: { full_name: 'makecindy/cindy' } },
  head: { sha: headCommit },
  merge_commit_sha: prCommit,
});
const comparison = (status: 'ahead' | 'behind' | 'diverged') => ({
  status,
  base_commit: { sha: prCommit },
  merge_base_commit: { sha: status === 'ahead' ? prCommit : runtimeCommit },
  ahead_by: status === 'behind' ? 0 : 1,
  behind_by: status === 'ahead' ? 0 : 1,
  total_commits: 1,
  commits: [{ commit: { message: 'Next commit' } }],
});
const run = (
  read: (url: string) => Promise<Record<string, unknown>>,
  deps: UpstreamRuntimeDeps = { runtime },
  items = [candidate()],
  signal = new AbortController().signal,
) => filterUpstreamCandidates(items, read, signal, deps);

describe('upstream PR inclusion', () => {
  it.each(['release', 'beta', 'dev'] as const)(
    'filters merged PRs by the actual %s commit, not release/merge dates',
    async (channel) => {
      const read = vi.fn(async (url: string) =>
        url.includes('/pulls/') ? detail() : comparison('ahead'),
      );
      const result = await run(read, { runtime: { ...runtime, channel } });
      expect(result.items).toEqual([]);
      expect(result.excludedIncluded).toBe(1);
      expect(read).toHaveBeenCalledWith(
        'https://api.github.com/repos/makecindy/cindy/compare/' + prCommit + '...' + runtimeCommit,
      );
      expect(read.mock.calls.some(([url]) => /releases|tags|main/.test(url))).toBe(false);
    },
  );
  it('keeps merged PRs that are newer than the running build, regardless of publication', async () => {
    const result = await run(async (url) =>
      url.includes('/pulls/') ? detail() : comparison('behind'),
    );
    expect(result.items).toMatchObject([{ state: 'merged', inclusion: 'notIncluded' }]);
  });
  it('uses the PR head, not GitHub test-merge commit, to exclude a running unmerged Dev branch', async () => {
    const read = vi.fn(async () => detail(1, false));
    const result = await run(read, { runtime: { ...runtime, channel: 'dev', commit: headCommit } });
    expect(result.excludedIncluded).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('retains a draft PR and compares its actual head', async () => {
    const containsCommit = vi.fn(async () => 'notIncluded' as const);
    const result = await run(async () => ({ ...detail(1, false), draft: true }), {
      runtime,
      containsCommit,
    });
    expect(result.items).toMatchObject([{ draft: true, state: 'open', inclusion: 'notIncluded' }]);
    expect(containsCommit).toHaveBeenCalledWith(headCommit, expect.any(AbortSignal));
  });
  it('drops closed-unmerged PRs but does not drop candidates on malformed detail', async () => {
    expect((await run(async () => ({ ...detail(), merged: false }))).items).toEqual([]);
    expect(
      (await run(async () => ({ ...detail(), base: { repo: { full_name: 'elsewhere/repo' } } })))
        .items,
    ).toMatchObject([{ inclusion: 'unknown' }]);
  });
  it.each(['diverged', 'missing', 'limited', 'reverted', 'bad-base', 'invalid-count'])(
    'retains uncertain %s ancestry instead of filtering it out',
    async (reason) => {
      const read = async (url: string) => {
        if (url.includes('/pulls/')) return detail();
        if (reason === 'missing') throw new Error('not found');
        const value = comparison(reason === 'diverged' ? 'diverged' : 'ahead');
        if (reason === 'limited') value.total_commits = 300;
        if (reason === 'reverted')
          value.commits[0].commit.message = 'Revert\nThis reverts commit ' + prCommit;
        if (reason === 'bad-base') value.base_commit.sha = headCommit;
        if (reason === 'invalid-count') value.behind_by = 1;
        return value;
      };
      expect((await run(read)).items).toMatchObject([{ inclusion: 'unknown' }]);
    },
  );
  it.each([
    undefined,
    { ...runtime, confidence: 'unknown' as const },
    { ...runtime, commit: 'main' },
  ])('keeps candidates without querying ancestry for uncertain identity: %j', async (identity) => {
    const read = vi.fn(async () => detail());
    const result = await run(read, { runtime: identity });
    expect(result.items).toMatchObject([{ inclusion: 'unknown' }]);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('invalidates all filtering if Dev changes during the query', async () => {
    const isCurrent = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await run(async () => detail(), {
      runtime,
      isCurrent,
      containsCommit: async () => 'included',
    });
    expect(result.items).toMatchObject([{ inclusion: 'unknown' }]);
    expect(result.runtime?.confidence).toBe('unknown');
    expect(result.excludedIncluded).toBe(0);
  });
  it('refills results after exclusion and bounds lookups, with a partial-search indicator', async () => {
    const items = Array.from({ length: 30 }, (_, index) => candidate(index + 1));
    const read = vi.fn(async (url: string) => ({
      ...detail(Number(url.split('/').at(-1))),
      merge_commit_sha: runtimeCommit,
    }));
    const result = await run(read, { runtime }, items);
    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(true);
    expect(result.excludedIncluded).toBe(20);
    expect(read).toHaveBeenCalledTimes(20);
  });
  it('continues past included matches and caches repeated ancestry comparisons', async () => {
    const read = vi.fn(async (url: string) => {
      const number = Number(url.split('/').at(-1));
      if (url.includes('/pulls/'))
        return { ...detail(number), merge_commit_sha: number <= 6 ? runtimeCommit : prCommit };
      return comparison('behind');
    });
    const result = await run(
      read,
      { runtime },
      Array.from({ length: 15 }, (_, index) => candidate(index + 1)),
    );
    expect(result.items.map((item) => item.number)).toEqual([7, 8, 9, 10, 11]);
    expect(result.excludedIncluded).toBe(6);
    expect(result.hasMore).toBe(true);
    expect(read.mock.calls.filter(([url]) => url.includes('/compare/'))).toHaveLength(1);
  });
  it('aborts an inclusion callback that ignores cancellation', async () => {
    const controller = new AbortController();
    const entered = vi.fn();
    const pending = run(
      async () => detail(),
      {
        runtime,
        containsCommit: async () => {
          entered();
          return new Promise(() => {});
        },
      },
      [candidate()],
      controller.signal,
    );
    const rejected = expect(pending).rejects.toBeTruthy();
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    controller.abort();
    await rejected;
  });
});
