import type { MakeSourceLatestVersion, MakeSourceStatus } from '../../shared/cindyMakeDoctor.js';
import { untilAborted } from './doctor.js';

const API = 'https://api.github.com/repos/makecindy/cindy';
export type Channel = MakeSourceLatestVersion['channel'];
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The managed checkout records the official line a personal version came
 * from. A packaged Dev build still has app.isPackaged set, so the Electron
 * packaging state cannot choose the source update channel reliably.
 */
export function sourceChannel(
  source: Pick<MakeSourceStatus, 'channel' | 'ref'>,
  fallback: Channel,
): Channel {
  return source.channel ?? (source.ref === 'main' ? 'dev' : fallback);
}
const isCommit = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Read-only public version lookup, shared across Settings windows for one minute. */
export function createLatestSourceVersionReader(fetch: Fetch) {
  const cache = new Map<
    Channel,
    {
      mainCommit?: string;
      expires: number;
      promise: Promise<MakeSourceLatestVersion>;
    }
  >();

  async function query(channel: Channel, mainCommit?: string): Promise<MakeSourceLatestVersion> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const read = async (endpoint: string): Promise<unknown> => {
      const response = await untilAborted(
        fetch(`${API}/${endpoint}`, {
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
          headers: { accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        }),
        controller.signal,
      );
      if (!response.ok) throw new Error('Version lookup failed');
      return untilAborted(response.json(), controller.signal);
    };
    const releaseTag = (value: unknown): string | undefined => {
      const release = record(value);
      if (release.draft !== false || release.prerelease !== (channel === 'beta')) return;
      const tag = release.tag_name;
      const pattern =
        channel === 'beta' ? /^v\d+\.\d+\.\d+-beta(?:\.[0-9A-Za-z.-]+)?$/ : /^v\d+\.\d+\.\d+$/;
      return typeof tag === 'string' && pattern.test(tag) ? tag : undefined;
    };
    try {
      let ref: string | undefined = channel === 'dev' ? 'main' : undefined;
      if (channel === 'release') ref = releaseTag(await read('releases/latest'));
      if (channel === 'beta') {
        // GitHub's latest endpoint excludes prereleases. Never fall back to stable.
        for (let page = 1; page <= 3 && !ref; page++) {
          const releases = await read(`releases?per_page=100&page=${page}`);
          if (!Array.isArray(releases)) break;
          ref = releases.map(releaseTag).find((tag) => tag !== undefined);
          if (releases.length < 100) break;
        }
      }
      if (!ref) return { status: 'unavailable', channel };
      // Resolve the tag to its commit, not target_commitish (which can be "main").
      const commit = record(await read(`commits/${encodeURIComponent(ref)}`)).sha;
      if (!isCommit(commit)) return { status: 'unavailable', channel };
      const latest: MakeSourceLatestVersion = { status: 'ready', channel, ref, commit };
      if (isCommit(mainCommit)) {
        if (mainCommit === commit) return { ...latest, ahead: 0, behind: 0 };
        try {
          const comparison = record(await read(`compare/${mainCommit}...${commit}?per_page=1`));
          const { ahead_by: behind, behind_by: ahead } = comparison;
          if (
            record(comparison.base_commit).sha === mainCommit &&
            typeof ahead === 'number' &&
            Number.isSafeInteger(ahead) &&
            ahead >= 0 &&
            typeof behind === 'number' &&
            Number.isSafeInteger(behind) &&
            behind >= 0
          ) {
            latest.ahead = ahead;
            latest.behind = behind;
          }
        } catch {
          // A local-only commit cannot be compared on GitHub; keep the verified latest hash.
        }
      }
      return latest;
    } catch {
      return { status: 'unavailable', channel };
    } finally {
      clearTimeout(timeout);
    }
  }

  return async (source: MakeSourceStatus, channel: Channel): Promise<MakeSourceStatus> => {
    if (source.status !== 'ready') return source;
    let cached = cache.get(channel);
    if (!cached || cached.mainCommit !== source.mainCommit || cached.expires <= Date.now()) {
      cached = {
        mainCommit: source.mainCommit,
        expires: Date.now() + 60_000,
        promise: query(channel, source.mainCommit),
      };
      cache.set(channel, cached);
    }
    const latestVersion = await cached.promise;
    if (latestVersion.status === 'unavailable' && cache.get(channel) === cached)
      cache.delete(channel);
    return { ...source, latestVersion };
  };
}
