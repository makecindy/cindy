import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { app } from 'electron';
import { createDownloader, type DownloadOptions, type DownloadResult } from '../downloader/index.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import { getBaseUrl, getPlatformKey } from '../manifestService.js';
import { createLogger } from '../logger.js';
import type { VendorAsset } from './manifest.js';
import type { VendorKey } from './types.js';

const log = createLogger('agent-binaries/download-cache');
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const inFlight = new Map<string, { identity: string; task: Promise<boolean> }>();
let backgroundDownload: ((opts: DownloadOptions) => Promise<DownloadResult>) | undefined;

function rootFor(vendor: VendorKey): string {
  return path.join(app.getPath('userData'), 'agent-binary-downloads', vendor);
}

function identity(asset: VendorAsset): string {
  return JSON.stringify({ source: getBaseUrl(), platform: getPlatformKey(), ...asset, sha256: asset.sha256.toLowerCase() });
}

function directoryFor(vendor: VendorKey, asset: VendorAsset): string | undefined {
  if (!/^[a-f0-9]{64}$/i.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0) return;
  return path.join(rootFor(vendor), asset.sha256.toLowerCase());
}

/** Metadata is only a hint; consumers hash the archive again before using it. */
export function hasPreparedBinaryDownload(vendor: VendorKey, asset: VendorAsset): boolean {
  const directory = directoryFor(vendor, asset);
  if (!directory) return false;
  try {
    return fs.readFileSync(path.join(directory, 'ready.json'), 'utf8') === identity(asset)
      && fs.statSync(path.join(directory, 'archive')).size === asset.size;
  } catch { return false; }
}

/** Only our hash-named cache children are eligible; live installs are elsewhere. */
function trim(root: string, keep?: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    if (entry.name === keep && Date.now() - fs.statSync(directory).mtimeMs <= MAX_AGE_MS) continue;
    try { fs.rmSync(directory, { recursive: true, force: true }); }
    catch { log.warn('Could not remove an obsolete binary download; will retry later'); }
  }
}

/**
 * An independent, single-slot queue keeps these optional transfers out of the
 * application's update queue. Same-target callers share a task, including About.
 */
export function prefetchBinaryDownload(vendor: VendorKey, asset: VendorAsset, signal?: AbortSignal): Promise<boolean> {
  const directory = directoryFor(vendor, asset);
  if (!directory) return Promise.resolve(false);
  const expectedIdentity = identity(asset);
  const key = rootFor(vendor);
  const previous = inFlight.get(key);
  if (previous?.identity === expectedIdentity) return previous.task;
  // Serialize different candidates too; the next caller rechecks the cache.
  const task = (async () => {
    if (previous) await previous.task;
    signal?.throwIfAborted();
    fs.mkdirSync(key, { recursive: true });
    return withCrossProcessLock(path.join(key, 'download.lock'), { label: 'agent-binary-download', waitMs: 0 }, async status => {
      if (!status.held) return false;
      trim(key, asset.sha256.toLowerCase());
      fs.mkdirSync(directory, { recursive: true });
      // No .verified marker or live-path mutation: this archive cannot be selected
      // as an installed runtime by either this process or an older Cindy version.
      backgroundDownload ??= createDownloader();
      await backgroundDownload({
        url: `${getBaseUrl()}/${asset.file}`,
        targetPath: path.join(directory, 'archive'),
        sha256: asset.sha256.toLowerCase(),
        expectedSize: asset.size,
        signal,
        timeout: { totalMs: 180_000 },
        retry: { maxAttempts: 3 },
      });
      signal?.throwIfAborted();
      // A channel/endpoint change cannot publish the old source under a new identity.
      if (identity(asset) !== expectedIdentity) return false;
      fs.writeFileSync(path.join(directory, 'ready.json'), expectedIdentity);
      const now = new Date();
      fs.utimesSync(directory, now, now);
      return true;
    }, signal);
  })().catch(() => {
    log.warn('Background binary download did not finish; the installed runtime is unchanged');
    return false;
  });
  inFlight.set(key, { identity: expectedIdentity, task });
  void task.finally(() => { if (inFlight.get(key)?.task === task) inFlight.delete(key); });
  return task;
}

/** Copy a verified cache hit into the existing installer, without network IO. */
export async function copyPreparedBinaryDownload(
  vendor: VendorKey, asset: VendorAsset, destination: string, signal?: AbortSignal,
): Promise<boolean> {
  if (!hasPreparedBinaryDownload(vendor, asset)) return false;
  const root = rootFor(vendor);
  const directory = directoryFor(vendor, asset)!;
  return withCrossProcessLock(path.join(root, 'download.lock'), { label: 'agent-binary-download', waitMs: 0 }, async status => {
    if (!status.held || !hasPreparedBinaryDownload(vendor, asset)) return false;
    const archive = path.join(directory, 'archive');
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(archive)) {
      signal?.throwIfAborted();
      hash.update(chunk);
    }
    if (hash.digest('hex') !== asset.sha256.toLowerCase()) {
      fs.rmSync(directory, { recursive: true, force: true });
      return false;
    }
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.copyFile(archive, destination);
    // The installer now owns its copy and removes it after extraction, as before.
    fs.rmSync(directory, { recursive: true, force: true });
    return true;
  }, signal);
}

/** Clean abandoned candidates even when the currently installed version is newer. */
export async function clearPreparedBinaryDownloads(vendor: VendorKey): Promise<void> {
  const root = rootFor(vendor);
  if (!fs.existsSync(root)) return;
  await withCrossProcessLock(path.join(root, 'download.lock'), { label: 'agent-binary-download', waitMs: 0 }, async status => {
    if (status.held) trim(root);
  });
}
