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

function githubHeaders(token: string, accept: string) {
  return { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
}

function readCandidate(raw: unknown, pluginId: string): GithubPluginRelease | undefined {
  if (typeof raw !== 'object' || !raw) return;
  const release = raw as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (release.draft !== false || typeof release.prerelease !== 'boolean' ||
      typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) return;
  const version = release.tag_name.slice(1);
  if (release.tag_name !== `v${version}` || parseAppUpdateVersion(version) !== version) return;
  for (const asset of release.assets) {
    if (!asset || asset.name !== `${pluginId}-${version}.cindy` || asset.state !== 'uploaded') continue;
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || !Number.isSafeInteger(asset.size) ||
        asset.size <= 0 || asset.size > MAX_PACKAGE_BYTES ||
        typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) continue;
    return { version, assetId: asset.id, size: asset.size, sha256: asset.digest.slice(7), prerelease: release.prerelease };
  }
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

export async function checkGithubPluginRelease(
  fetch: typeof globalThis.fetch,
  token: string | null,
  repository: string,
  pluginId: string,
  currentVersion: string,
): Promise<GithubPluginReleaseCheck> {
  if (!token) return { status: 'sign-in' };
  try {
    const response = await fetch(`${releaseApi(repository)}?per_page=30`, {
      headers: githubHeaders(token, 'application/vnd.github+json'),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) return { status: 'sign-in' };
      if (response.status === 404 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') !== '0')) {
        return { status: 'forbidden' };
      }
      return { status: 'unavailable' };
    }
    const chunks: Uint8Array[] = [];
    for await (const bytes of responseChunks(response, MAX_RELEASE_BYTES)) chunks.push(bytes);
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(data) || !parseAppUpdateVersion(currentVersion)) return { status: 'unavailable' };
    let release: GithubPluginRelease | undefined;
    for (const item of data) {
      const candidate = readCandidate(item, pluginId);
      if (candidate && (!release || compareAppUpdateVersions(candidate.version, release.version) === 'newer')) {
        release = candidate;
      }
    }
    if (!release) return { status: 'empty' };
    return { status: compareAppUpdateVersions(release.version, currentVersion) === 'newer' ? 'available' : 'current', release };
  } catch {
    return { status: 'unavailable' };
  }
}

export async function downloadGithubPluginRelease(
  fetch: typeof globalThis.fetch,
  token: string,
  repository: string,
  release: GithubPluginRelease,
  destination: string,
  callbacks?: DownloadProgressReporter['callbacks'],
): Promise<void> {
  const assetUrl = `${releaseApi(repository)}/assets/${release.assetId}`;
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
      if (url === assetUrl) {
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
