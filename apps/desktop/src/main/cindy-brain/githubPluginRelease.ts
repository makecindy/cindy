import { PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES } from '@cindy/plugin-protocol';
import { download } from '../downloader/service.js';
import { createDownloadProgressReporter, type DownloadProgressReporter } from '../downloader/progressReporter.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DownloadProgress } from '../../shared/downloadProgress.js';
import { createIpcError } from '../../shared/ipc-errors.js';
import { compareAppUpdateVersions, parseAppUpdateVersion } from '../updateVersionPolicy.js';
import { type GithubPluginRelease, type GithubPluginReleaseCheck, type GithubPluginReleaseResult } from '../../shared/githubPluginRelease.js';

const releaseApi = (repository: string) => 'https://api.github.com/repos/' + repository.split('/').map(encodeURIComponent).join('/') + '/releases';
const MAX_PACKAGE_BYTES = PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES;
const MAX_RELEASE_BYTES = 1024 * 1024;

function githubHeaders(token: string | null, accept: string): Record<string, string> {
  return { ...(token ? { Authorization: 'Bearer ' + token } : {}), Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
}

export function parseGithubPluginReleaseSource(input: unknown): { repository: string; tag?: string } | undefined {
  if (typeof input !== 'string' || input.length > 512) return;
  const match = /^https:\/\/github\.com\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9_.-]{1,100})(?:\/releases(?:\/tag\/(v[a-z0-9.+-]+))?)?\/?$/i.exec(input.trim());
  if (!match || match[2] === '.' || match[2] === '..') return;
  const tag = match[3];
  if (tag && (tag[0] !== 'v' || parseAppUpdateVersion(tag.slice(1)) !== tag.slice(1))) return;
  return { repository: (match[1] + '/' + match[2]).toLowerCase(), ...(tag ? { tag } : {}) };
}

type ReleasePackage = GithubPluginRelease & { pluginId: string };

function readCandidates(raw: unknown, pluginId?: string): ReleasePackage[] {
  if (typeof raw !== 'object' || !raw) return [];
  const release = raw as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (release.draft !== false || typeof release.prerelease !== 'boolean' ||
      typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) return [];
  const version = release.tag_name.slice(1);
  if (release.tag_name !== `v${version}` || parseAppUpdateVersion(version) !== version) return [];
  const candidates: ReleasePackage[] = [];
  const suffix = `-${version}.cindy`;
  for (const asset of release.assets) {
    if (!asset || typeof asset.name !== 'string' || !asset.name.endsWith(suffix) || asset.state !== 'uploaded') continue;
    const id = asset.name.slice(0, -suffix.length);
    if (!/^[a-z0-9-]{1,32}$/.test(id) || (pluginId && pluginId !== id)) continue;
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || !Number.isSafeInteger(asset.size) ||
        asset.size <= 0 || asset.size > MAX_PACKAGE_BYTES ||
        typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) continue;
    candidates.push({ pluginId: id, version, assetId: asset.id, size: asset.size, sha256: asset.digest.slice(7), prerelease: release.prerelease });
    if (pluginId) break;
  }
  return candidates;
}

async function* responseChunks(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing release response');
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.byteLength;
      if (size > limit) throw new Error('Release response exceeds size limit');
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readGithubReleases(
  fetch: typeof globalThis.fetch,
  token: string | null,
  repository: string,
  tag?: string,
): Promise<{ status: 'ok'; releases: unknown[] } | { status: 'sign-in' | 'forbidden' | 'not-found' | 'unavailable' }> {
  try {
    const response = await fetch(tag ? releaseApi(repository) + '/tags/' + encodeURIComponent(tag) : releaseApi(repository) + '?per_page=30', {
      headers: githubHeaders(token, 'application/vnd.github+json'),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) return { status: 'sign-in' };
      if (response.status === 404 && !token) return { status: 'sign-in' };
      if (response.status === 404 && tag) return { status: 'not-found' };
      if (response.status === 404 || (response.status === 403 &&
          response.headers.get('x-ratelimit-remaining') !== '0' && !response.headers.has('retry-after'))) {
        return { status: 'forbidden' };
      }
      return { status: 'unavailable' };
    }
    const chunks: Uint8Array[] = [];
    for await (const bytes of responseChunks(response, MAX_RELEASE_BYTES)) chunks.push(bytes);
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (tag) {
      if (typeof data !== 'object' || !data || !('tag_name' in data) || data.tag_name !== tag) return { status: 'unavailable' };
      return { status: 'ok', releases: [data] };
    }
    return Array.isArray(data) ? { status: 'ok', releases: data } : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

async function readGithubReleasesWithFallback(
  fetch: typeof globalThis.fetch,
  token: string | null,
  source: { repository: string; tag?: string },
) {
  const data = await readGithubReleases(fetch, token, source.repository, source.tag);
  // A local credential can be rejected even when the requested release is public.
  if (token && data.status !== 'ok' && data.status !== 'unavailable') {
    const publicData = await readGithubReleases(fetch, null, source.repository, source.tag);
    if (publicData.status === 'ok') return { data: publicData, authenticated: false };
  }
  return { data, authenticated: token !== null };
}

export async function findGithubPluginInstall(
  fetch: typeof globalThis.fetch,
  token: string | null,
  source: { repository: string; tag?: string },
) {
  const { data, authenticated } = await readGithubReleasesWithFallback(fetch, token, source);
  if (data.status !== 'ok') return data;
  const packages = data.releases.flatMap(item => readCandidates(item));
  if (packages.length === 0) return { status: 'empty' } as const;
  if (new Set(packages.map(item => item.pluginId)).size !== 1) return { status: 'ambiguous' } as const;
  const release = packages.reduce((best, item) =>
    compareAppUpdateVersions(item.version, best.version) === 'newer' ? item : best);
  return { status: 'available', release, authenticated } as const;
}

export async function checkGithubPluginRelease(
  fetch: typeof globalThis.fetch,
  token: string | null,
  repository: string,
  pluginId: string,
  currentVersion: string,
): Promise<{ check: GithubPluginReleaseCheck; authenticated: boolean }> {
  if (!parseAppUpdateVersion(currentVersion)) return { check: { status: 'unavailable' }, authenticated: false };
  const { data, authenticated } = await readGithubReleasesWithFallback(fetch, token, { repository });
  if (data.status !== 'ok') return { check: { status: data.status === 'not-found' ? 'empty' : data.status }, authenticated };
  let release: GithubPluginRelease | undefined;
  for (const item of data.releases) {
    const candidate = readCandidates(item, pluginId)[0];
    if (candidate && (!release || compareAppUpdateVersions(candidate.version, release.version) === 'newer')) {
      const { pluginId: _id, ...matchingRelease } = candidate;
      release = matchingRelease;
    }
  }
  if (!release) return { check: { status: 'empty' }, authenticated };
  const status = compareAppUpdateVersions(release.version, currentVersion) === 'newer' ? 'available' : 'current';
  return { check: { status, release }, authenticated };
}

export async function downloadGithubPluginRelease(
  fetch: typeof globalThis.fetch,
  token: string | null,
  repository: string,
  release: GithubPluginRelease & { pluginId?: string },
  destination: string,
  callbacks?: DownloadProgressReporter['callbacks'],
): Promise<void> {
  const version = encodeURIComponent(release.version);
  // Use the public binary URL for anonymous downloads. The authenticated API
  // endpoint is still needed for private release assets.
  const assetUrl = !token && release.pluginId
    ? `https://github.com/${repository}/releases/download/v${version}/${release.pluginId}-${version}.cindy`
    : `${releaseApi(repository)}/assets/${release.assetId}`;
  await download({
    ...callbacks,
    url: assetUrl,
    targetPath: destination,
    sha256: release.sha256,
    expectedSize: release.size,
    maxBytes: MAX_PACKAGE_BYTES,
    resume: false,
    existingTarget: 'error',
    retry: { maxAttempts: 1 },
    timeout: { connectMs: 15_000, idleMs: 30_000, totalMs: 120_000 },
    isUrlAllowed: (candidate) => {
      const url = new URL(candidate);
      return candidate === assetUrl || (url.origin === 'https://release-assets.githubusercontent.com' && !url.username && !url.password);
    },
    request: async (url, init) => {
      const headers = new Headers(init.headers);
      if (token && url === assetUrl) {
        for (const [name, value] of Object.entries(githubHeaders(token, 'application/octet-stream'))) {
          headers.set(name, value);
        }
      }
      return { response: await fetch(url, { ...init, redirect: 'manual', headers }) };
    },
  });
}

export async function installCheckedGithubPluginRelease(input: {
  check: GithubPluginReleaseCheck;
  expectedAssetId: number;
  pending: Set<string>;
  updateKey: string;
  tempRoot: string;
  isCurrentOwner: () => boolean;
  download: (file: string, release: GithubPluginRelease, callbacks: DownloadProgressReporter['callbacks']) => Promise<void>;
  install: (file: string, release: GithubPluginRelease) => Promise<string>;
  emit: (progress: DownloadProgress) => void;
}): Promise<GithubPluginReleaseResult> {
  const { check, expectedAssetId, pending, updateKey, tempRoot, isCurrentOwner } = input;
  if (check.status !== 'available' || check.release.assetId !== expectedAssetId) return check;
  if (pending.has(updateKey)) throw createIpcError('PRECONDITION_FAILED', 'Plugin update is already in progress');
  pending.add(updateKey);
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tempRoot, 'cindy-plugin-update-'));
    if (!isCurrentOwner()) throw createIpcError('PRECONDITION_FAILED', 'Plugin owner changed');
    const file = join(dir, 'release.cindy');
    const reporter = createDownloadProgressReporter({
      total: check.release.size, initialPhase: 'queued', emit: input.emit,
    });
    input.emit(reporter.snapshot());
    try {
      await input.download(file, check.release, reporter.callbacks);
    } catch {
      return { status: 'unavailable' };
    }
    if (!isCurrentOwner()) throw createIpcError('PRECONDITION_FAILED', 'Plugin owner changed');
    reporter.setPhase('installing');
    return { status: 'updated', version: await input.install(file, check.release) };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    pending.delete(updateKey);
  }
}
