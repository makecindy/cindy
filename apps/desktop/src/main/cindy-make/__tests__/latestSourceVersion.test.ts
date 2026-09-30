import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MakeSourceStatus } from '../../../shared/cindyMakeDoctor.js';
import { createLatestSourceVersionReader, sourceChannel } from '../latestSourceVersion.js';

const local = 'a'.repeat(40);
const remote = 'b'.repeat(40);
const source: MakeSourceStatus = {
  status: 'ready',
  path: 'managed-source',
  mainCommit: local,
  mainRemoteCommit: 'c'.repeat(40),
  mainAhead: 50,
  mainBehind: 60,
};
const json = (value: unknown) => new Response(JSON.stringify(value));
const release = (tag_name: string, prerelease = false, draft = false) => ({
  tag_name,
  prerelease,
  draft,
});
const comparison = { base_commit: { sha: local }, ahead_by: 7, behind_by: 2 };

afterEach(() => vi.useRealTimers());

describe('latest Cindy source version', () => {
  it('uses the managed source channel even when the running Dev app is packaged', () => {
    expect(sourceChannel({ channel: 'dev', ref: 'main' }, 'release')).toBe('dev');
    expect(sourceChannel({ channel: undefined, ref: 'main' }, 'release')).toBe('dev');
    expect(sourceChannel({ channel: 'release', ref: 'v1.2.3' }, 'dev')).toBe('release');
  });

  it('queries live main and reports the local main difference in the correct direction', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ sha: remote }))
      .mockResolvedValueOnce(json(comparison));
    const result = await createLatestSourceVersionReader(fetch)(source, 'dev');
    expect(result.latestVersion).toEqual({
      status: 'ready',
      channel: 'dev',
      ref: 'main',
      commit: remote,
      ahead: 2,
      behind: 7,
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/makecindy/cindy/commits/main',
      `https://api.github.com/repos/makecindy/cindy/compare/${local}...${remote}?per_page=1`,
    ]);
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(result.mainRemoteCommit).toBe(source.mainRemoteCommit);
  });

  it('resolves the newest beta release tag, skipping stable, other prereleases and drafts', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json([
          release('v2.0.0'),
          release('v2.1.0-rc', true),
          release('v2.1.0-beta', true, true),
          release('v2.0.0-beta.2', true),
          release('v1.9.0-beta', true),
        ]),
      )
      .mockResolvedValueOnce(json({ sha: remote }))
      .mockResolvedValueOnce(json(comparison));
    const result = await createLatestSourceVersionReader(fetch)(source, 'beta');
    expect(result.latestVersion).toMatchObject({
      status: 'ready',
      ref: 'v2.0.0-beta.2',
      commit: remote,
      channel: 'beta',
    });
    expect(fetch.mock.calls[1][0]).toBe(
      'https://api.github.com/repos/makecindy/cindy/commits/v2.0.0-beta.2',
    );
  });

  it('uses the latest stable release and resolves its tag, not target_commitish', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ ...release('v2.0.0'), target_commitish: 'main' }))
      .mockResolvedValueOnce(json({ sha: local }));
    const result = await createLatestSourceVersionReader(fetch)(source, 'release');
    expect(result.latestVersion).toEqual({
      status: 'ready',
      channel: 'release',
      ref: 'v2.0.0',
      commit: local,
      ahead: 0,
      behind: 0,
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/makecindy/cindy/releases/latest',
      'https://api.github.com/repos/makecindy/cindy/commits/v2.0.0',
    ]);
  });

  it('checks another beta page without switching channels', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(Array.from({ length: 100 }, () => release('v2.0.0'))))
      .mockResolvedValueOnce(json([release('v1.9.0-beta', true)]))
      .mockResolvedValueOnce(json({ sha: local }));
    const result = await createLatestSourceVersionReader(fetch)(source, 'beta');
    expect(result.latestVersion).toMatchObject({ ref: 'v1.9.0-beta' });
    expect(fetch.mock.calls[1][0]).toContain('page=2');
  });

  it.each(['beta', 'release'] as const)(
    'never substitutes another channel for %s',
    async (channel) => {
      const fetch = vi
        .fn()
        .mockResolvedValue(
          json(channel === 'beta' ? [release('v2.0.0')] : release('v2.0.0-beta', true)),
        );
      expect((await createLatestSourceVersionReader(fetch)(source, channel)).latestVersion).toEqual(
        { status: 'unavailable', channel },
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    new Response('', { status: 404 }),
    json({ ...comparison, base_commit: { sha: remote } }),
    json({ ...comparison, ahead_by: -1 }),
  ])('keeps the latest hash when comparison is unavailable or invalid', async (response) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ sha: remote }))
      .mockResolvedValueOnce(response);
    expect((await createLatestSourceVersionReader(fetch)(source, 'dev')).latestVersion).toEqual({
      status: 'ready',
      channel: 'dev',
      ref: 'main',
      commit: remote,
    });
  });

  it('does not substitute cached origin/main or the personal commit for missing local main', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ sha: remote }));
    const result = await createLatestSourceVersionReader(fetch)(
      { ...source, mainCommit: undefined, commit: local },
      'dev',
    );
    expect(result.latestVersion).toEqual({
      status: 'ready',
      channel: 'dev',
      ref: 'main',
      commit: remote,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([new Response('', { status: 429 }), json({ sha: 'main' })])(
    'reports failed or invalid lookups without using stale refs',
    async (response) => {
      const fetch = vi.fn().mockResolvedValue(response);
      expect((await createLatestSourceVersionReader(fetch)(source, 'dev')).latestVersion).toEqual({
        status: 'unavailable',
        channel: 'dev',
      });
    },
  );

  it('settles a stalled fetch after the time limit', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    const result = createLatestSourceVersionReader(fetch)(source, 'dev');
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await result).latestVersion).toEqual({ status: 'unavailable', channel: 'dev' });
  });

  it('retries a failed lookup when Settings reopens', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(json({ sha: local }));
    const read = createLatestSourceVersionReader(fetch);
    expect((await read(source, 'dev')).latestVersion?.status).toBe('unavailable');
    expect((await read(source, 'dev')).latestVersion?.status).toBe('ready');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares in-flight lookups, expires cached results, and recomputes for a changed main', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (url: string) =>
      json(url.includes('/compare/') ? comparison : { sha: local }),
    );
    const read = createLatestSourceVersionReader(fetch);
    await Promise.all([read(source, 'dev'), read(source, 'dev')]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_001);
    await read(source, 'dev');
    expect(fetch).toHaveBeenCalledTimes(2);
    await read({ ...source, mainCommit: remote }, 'dev');
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each(['preparing', 'missing', 'failed'] as const)(
    'does not hold up %s source state with a remote query',
    async (status) => {
      const fetch = vi.fn();
      const input = { ...source, status };
      expect(await createLatestSourceVersionReader(fetch)(input, 'dev')).toBe(input);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
