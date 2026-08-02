import fs from 'node:fs';
import path from 'node:path';

import type { WebContents } from 'electron';

interface ArtifactLogger {
  warn(message: string, ...args: unknown[]): void;
}

interface DownloadItemLike {
  getFilename(): string;
  getURL(): string;
  getMimeType(): string;
  getTotalBytes(): number;
  getReceivedBytes(): number;
  setSavePath(filePath: string): void;
  cancel(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
}

interface SessionLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

export interface BrowserArtifact {
  id: string;
  fileName: string;
  path?: string;
  url?: string;
  mimeType?: string;
  bytes?: number;
  state: 'completed' | 'cancelled' | 'interrupted';
  startedAt: string;
  finishedAt: string;
}

interface PendingDownload {
  item: DownloadItemLike;
  done: Promise<BrowserArtifact>;
  filePath?: string;
  knownTotalBytes?: number;
  limitReason?: string;
  reservationReleased?: boolean;
}

interface ArtifactCapture {
  id: string;
  sessionId: string;
  webContents: WebContents;
  directory: string;
  accepting: boolean;
  pending: PendingDownload[];
  usedNames: Set<string>;
  reservedBytes: number;
}

// A click can schedule a download after the event handler returns (for
// example, a page may first fetch a signed URL). Keep this wait bounded while
// allowing normal deferred download starts to be observed.
const DOWNLOAD_GRACE_MS = 2_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_DOWNLOADS_PER_CAPTURE = 8;
const MAX_DOWNLOAD_BYTES_PER_FILE = 32 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES_PER_CAPTURE = 64 * 1024 * 1024;
const MAX_RECENT_ARTIFACTS = 100;
const MAX_RETAINED_ARTIFACT_BYTES = 256 * 1024 * 1024;

let captureSequence = 0;
let artifactSequence = 0;

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || 'session').slice(0, 64);
}

function processArtifactRoot(rootDir: string): string {
  return path.join(rootDir, `process-${process.pid}`);
}

export function artifactSessionRoot(rootDir: string, sessionId: string): string {
  return path.join(processArtifactRoot(rootDir), safeSegment(sessionId));
}

async function reclaimStaleProcessRoots(rootDir: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) return;
    const match = /^process-(\d+)$/.exec(entry.name);
    if (!match) return;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid === process.pid) return;
    try {
      process.kill(pid, 0);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
    }
    await fs.promises.rm(path.join(rootDir, entry.name), { recursive: true, force: true });
  }));
}

function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  let cleaned = base
    // eslint-disable-next-line no-control-regex -- control characters are invalid in filenames
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  if (!cleaned || cleaned === '..') cleaned = 'download';
  if (cleaned.length > 160) cleaned = cleaned.slice(-160);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }
  return cleaned;
}

function uniqueName(base: string, used: Set<string>): string {
  const extension = path.extname(base);
  const stem = base.slice(0, base.length - extension.length);
  let candidate = base;
  for (let index = 2; used.has(candidate.toLowerCase()); index += 1) {
    candidate = `${stem}-${index}${extension}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function sessionFor(wc: WebContents): SessionLike {
  const session = (wc as unknown as { session?: SessionLike }).session;
  if (!session) throw new Error('webContents session is unavailable');
  return session;
}

function boundedTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(MAX_DOWNLOAD_TIMEOUT_MS, Math.floor(value))
    : DEFAULT_DOWNLOAD_TIMEOUT_MS;
}

function displayUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    parsed.username = '';
    parsed.password = '';
    return parsed.href;
  } catch {
    return undefined;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Captures downloads only while an agent-owned browser action is in flight.
 * Each action gets an isolated directory with bounded count and byte quotas.
 * Failed, cancelled, evicted, and disposed files are removed; completed files
 * remain available for later tool steps until the retention budget is reached.
 */
export class RsbWebviewArtifacts {
  private readonly sessionListeners = new Map<SessionLike, (...args: unknown[]) => void>();
  private readonly captures = new Map<WebContents, ArtifactCapture>();
  private readonly recent: BrowserArtifact[] = [];
  private readonly artifactSessions = new Map<string, string>();
  private readonly preparedRoots = new Set<string>();
  private retainedBytes = 0;
  private disposed = false;

  constructor(
    private readonly rootDir: () => string,
    private readonly logger: ArtifactLogger,
    private readonly downloadGraceMs = DOWNLOAD_GRACE_MS,
  ) {}

  async capture<T>(
    wc: WebContents,
    context: { sessionId: string; timeoutMs?: number },
    action: () => Promise<T>,
  ): Promise<{ value: T; downloads: BrowserArtifact[] }> {
    this.assertActive();
    if (this.captures.has(wc)) {
      throw new Error('another download-aware action is already running for this tab');
    }
    const session = sessionFor(wc);
    this.observeSession(session);
    const rootDir = this.rootDir();
    if (!this.preparedRoots.has(rootDir)) {
      await fs.promises.mkdir(rootDir, { recursive: true });
      await reclaimStaleProcessRoots(rootDir);
      this.assertActive();
      this.preparedRoots.add(rootDir);
    }
    const parent = artifactSessionRoot(rootDir, context.sessionId);
    await fs.promises.mkdir(parent, { recursive: true });
    this.assertActive();
    captureSequence += 1;
    const directory = await fs.promises.mkdtemp(
      path.join(parent, `${Date.now().toString(36)}-${captureSequence.toString(36)}-`),
    );
    if (this.disposed) {
      await this.removeDirectory(directory);
      this.assertActive();
    }
    const capture: ArtifactCapture = {
      id: `${Date.now().toString(36)}-${captureSequence.toString(36)}`,
      sessionId: context.sessionId,
      webContents: wc,
      directory,
      accepting: true,
      pending: [],
      usedNames: new Set(),
      reservedBytes: 0,
    };
    this.captures.set(wc, capture);

    let value: T;
    try {
      value = await action();
      await wait(this.downloadGraceMs);
      this.assertActive();
    } catch (err) {
      capture.accepting = false;
      this.captures.delete(wc);
      for (const pending of capture.pending) pending.item.cancel();
      await this.removeDirectory(directory);
      throw err;
    }
    capture.accepting = false;
    this.captures.delete(wc);

    if (capture.pending.length === 0) {
      await this.removeDirectory(directory);
      return { value, downloads: [] };
    }

    const timeoutMs = boundedTimeout(context.timeoutMs);
    const completion = Promise.all(capture.pending.map((entry) => entry.done));
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<BrowserArtifact[]>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        for (const pending of capture.pending) pending.item.cancel();
        reject(new Error(`download did not finish within ${timeoutMs}ms`));
      }, timeoutMs);
    });
    let downloads: BrowserArtifact[];
    try {
      downloads = await Promise.race([completion, timeout]);
      this.assertActive();
    } catch (err) {
      await this.removeDirectory(directory);
      throw err;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    for (const artifact of downloads) {
      if (artifact.state === 'completed' && artifact.path && artifact.bytes === undefined) {
        artifact.bytes = await this.fileSize(artifact.path);
        this.assertActive();
      }
      this.recent.push(artifact);
      this.artifactSessions.set(artifact.id, context.sessionId);
      if (artifact.path && artifact.bytes) this.retainedBytes += artifact.bytes;
    }
    await this.trimRecent();
    if (!downloads.some((artifact) => artifact.state === 'completed')) {
      await this.removeDirectory(directory);
    }
    return { value, downloads };
  }

  diagnostics(sessionId?: string): { activeCaptures: number; recentArtifacts: BrowserArtifact[] } {
    return {
      activeCaptures: [...this.captures.values()]
        .filter((capture) => !sessionId || capture.sessionId === sessionId)
        .length,
      recentArtifacts: this.recent
        .filter((artifact) => !sessionId || this.artifactSessions.get(artifact.id) === sessionId)
        .slice(-20)
        .map((artifact) => ({ ...artifact })),
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [session, listener] of this.sessionListeners) {
      session.removeListener('will-download', listener);
    }
    this.sessionListeners.clear();
    const active = [...this.captures.values()];
    this.captures.clear();
    await Promise.all(active.map(async (capture) => {
      capture.accepting = false;
      for (const pending of capture.pending) pending.item.cancel();
      await this.removeDirectory(capture.directory);
    }));
    const retained = this.recent.splice(0);
    this.artifactSessions.clear();
    this.retainedBytes = 0;
    await Promise.all(retained.map((artifact) => (
      artifact.path ? this.removeArtifactFile(artifact.path) : Promise.resolve()
    )));
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('browser artifact capture is disposed');
  }

  private observeSession(session: SessionLike): void {
    if (this.sessionListeners.has(session)) return;
    const listener = (...args: unknown[]) => {
      const item = args[1] as DownloadItemLike | undefined;
      const wc = args[2] as WebContents | undefined;
      if (!item || !wc) return;
      const capture = this.captures.get(wc);
      if (!capture?.accepting) return;
      this.trackDownload(capture, item);
    };
    session.on('will-download', listener);
    this.sessionListeners.set(session, listener);
  }

  private trackDownload(capture: ArtifactCapture, item: DownloadItemLike): void {
    artifactSequence += 1;
    const id = `artifact-${Date.now().toString(36)}-${artifactSequence.toString(36)}`;
    const fileName = uniqueName(safeFileName(item.getFilename()), capture.usedNames);
    const filePath = path.join(capture.directory, fileName);
    const startedAt = new Date().toISOString();
    const totalBytes = this.positiveBytes(item.getTotalBytes());
    let finishDownload: (artifact: BrowserArtifact) => void = () => undefined;
    const done = new Promise<BrowserArtifact>((resolve) => {
      finishDownload = resolve;
    });
    const pending: PendingDownload = {
      item,
      ...(totalBytes ? { knownTotalBytes: totalBytes } : {}),
      done,
    };
    item.once('done', (_event: unknown, rawState: unknown) => {
      const receivedBytes = this.positiveBytes(item.getReceivedBytes());
      const observedBytes = Math.max(totalBytes ?? 0, receivedBytes ?? 0);
      const exceededFileQuota = observedBytes > MAX_DOWNLOAD_BYTES_PER_FILE;
      const exceededCaptureQuota = this.receivedBytes(capture) > MAX_DOWNLOAD_BYTES_PER_CAPTURE;
      const state = pending.limitReason || exceededFileQuota || exceededCaptureQuota
        ? 'cancelled'
        : rawState === 'completed'
          ? 'completed'
          : rawState === 'cancelled'
            ? 'cancelled'
            : 'interrupted';
      if (state !== 'completed') this.releaseReservation(capture, pending);
      if (state !== 'completed' && pending.filePath) {
        try {
          fs.rmSync(pending.filePath, { force: true });
        } catch (err) {
          this.logger.warn('failed to remove incomplete browser artifact', {
            artifactId: id,
            err,
          });
        }
      }
      const url = displayUrl(item.getURL());
      finishDownload({
        id,
        fileName,
        ...(state === 'completed' && pending.filePath ? { path: pending.filePath } : {}),
        ...(url ? { url } : {}),
        ...(item.getMimeType() ? { mimeType: item.getMimeType() } : {}),
        ...(observedBytes > 0 ? { bytes: observedBytes } : {}),
        state,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    });

    const quotaReason = this.quotaReason(capture, totalBytes);
    if (quotaReason) {
      this.cancelForQuota(pending, quotaReason);
      if (capture.pending.length < MAX_DOWNLOADS_PER_CAPTURE) {
        capture.pending.push(pending);
      }
      return;
    }

    capture.pending.push(pending);
    if (totalBytes) capture.reservedBytes += totalBytes;
    pending.filePath = filePath;
    item.setSavePath(filePath);
    item.on('updated', () => {
      if (pending.limitReason) return;
      const receivedBytes = this.positiveBytes(item.getReceivedBytes());
      if (
        (receivedBytes && receivedBytes > MAX_DOWNLOAD_BYTES_PER_FILE)
        || this.receivedBytes(capture) > MAX_DOWNLOAD_BYTES_PER_CAPTURE
      ) {
        this.cancelForQuota(
          pending,
          receivedBytes && receivedBytes > MAX_DOWNLOAD_BYTES_PER_FILE
            ? 'single download exceeds the size limit'
            : 'capture exceeds the total download limit',
        );
      }
    });
  }

  private quotaReason(capture: ArtifactCapture, totalBytes: number | undefined): string | undefined {
    if (capture.pending.length >= MAX_DOWNLOADS_PER_CAPTURE) {
      return 'capture exceeds the download count limit';
    }
    if (totalBytes && totalBytes > MAX_DOWNLOAD_BYTES_PER_FILE) {
      return 'single download exceeds the size limit';
    }
    if (
      totalBytes
      && capture.reservedBytes + totalBytes > MAX_DOWNLOAD_BYTES_PER_CAPTURE
    ) {
      return 'capture exceeds the total download limit';
    }
    return undefined;
  }

  private cancelForQuota(pending: PendingDownload, reason: string): void {
    pending.limitReason = reason;
    this.logger.warn('browser download cancelled by quota', {
      reason,
      fileName: pending.item.getFilename(),
    });
    pending.item.cancel();
  }

  private receivedBytes(capture: ArtifactCapture): number {
    return capture.reservedBytes + capture.pending.reduce((sum, pending) => {
      if (pending.limitReason) return sum;
      const received = this.positiveBytes(pending.item.getReceivedBytes()) ?? 0;
      if (pending.knownTotalBytes) {
        return sum + Math.max(0, received - pending.knownTotalBytes);
      }
      return sum + received;
    }, 0);
  }

  private releaseReservation(capture: ArtifactCapture, pending: PendingDownload): void {
    if (!pending.knownTotalBytes || pending.reservationReleased) return;
    pending.reservationReleased = true;
    capture.reservedBytes = Math.max(0, capture.reservedBytes - pending.knownTotalBytes);
  }

  private positiveBytes(value: number): number | undefined {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  private async fileSize(filePath: string): Promise<number | undefined> {
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.isFile() ? stat.size : undefined;
    } catch {
      return undefined;
    }
  }

  private async trimRecent(): Promise<void> {
    const evicted: BrowserArtifact[] = [];
    while (
      this.recent.length > MAX_RECENT_ARTIFACTS
      || this.retainedBytes > MAX_RETAINED_ARTIFACT_BYTES
    ) {
      const artifact = this.recent.shift();
      if (!artifact) break;
      evicted.push(artifact);
      this.artifactSessions.delete(artifact.id);
      if (artifact.path && artifact.bytes) this.retainedBytes -= artifact.bytes;
    }
    await Promise.all(evicted.map((artifact) => (
      artifact.path ? this.removeArtifactFile(artifact.path) : Promise.resolve()
    )));
  }

  private async removeArtifactFile(filePath: string): Promise<void> {
    try {
      await fs.promises.rm(filePath, { force: true });
    } catch (err) {
      this.logger.warn('failed to remove retained browser artifact', {
        filePath,
        err,
      });
      return;
    }
    try {
      await fs.promises.rmdir(path.dirname(filePath));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
        this.logger.warn('failed to remove empty browser artifact directory', { err });
      }
      return;
    }
    try {
      // Capture directories live below a session directory. Reclaim that
      // parent too once the last retained file for the session is gone.
      await fs.promises.rmdir(path.dirname(path.dirname(filePath)));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
        this.logger.warn('failed to remove empty browser artifact session directory', { err });
      }
    }
  }

  private async removeDirectory(directory: string): Promise<void> {
    try {
      await fs.promises.rm(directory, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn('failed to clean browser artifact directory', { err });
    }
  }
}
