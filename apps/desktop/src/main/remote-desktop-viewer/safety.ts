import { createHash } from 'node:crypto';
import {
  ClipboardSync,
  clipboardSyncErrorCode,
  clipboardSyncFailure,
  parseClipboardContent,
  type ClipboardSyncBaseline,
  type LocalClipboardReadCache,
  type RemoteDesktopCapabilities,
  type RemoteDesktopRequest,
} from '@cindy/device-link';
import type { RemoteViewerPreferences, RemoteViewerSafety } from '../../shared/remoteDesktopViewer';

export interface ViewerClipboard {
  version(current: () => boolean): Promise<string>;
  stop?(): void;
  read(current: () => boolean): Promise<string>;
  write(json: string, version: string | undefined, current: () => boolean): Promise<string>;
}

/** The viewer's own clipboard helper failing is not the computer being locked. */
const VIEWER_CLIPBOARD_UNAVAILABLE = 'DESKTOP_VIEWER_CLIPBOARD_UNAVAILABLE';
const RETRY_MS = 1500;
const MAX_BACKOFF_MS = 5000;

export interface ViewerClipboardFailure {
  code: string;
  /** Status key for the viewer window; null keeps whatever is shown. */
  notice: string | null;
  /** Milliseconds until the next attempt; null waits for focus or a copy/paste wakeup. */
  delay: number | null;
  /** Settles by itself (locked computer, a copy mid-read); never grows the backoff. */
  transient: boolean;
}

/** How one sync failure is retried. Only unexplained failures back off, and briefly. */
export function viewerClipboardFailure(error: unknown, failures: number): ViewerClipboardFailure {
  const shared = clipboardSyncFailure(error, failures);
  const code = clipboardSyncErrorCode(error);
  if (shared.delay === null) return { ...shared, transient: false };
  if (code === 'CLIPBOARD_CONFLICT')
    return { code, notice: 'clipboardSyncConflict', delay: RETRY_MS, transient: true };
  // The computer's clipboard is refused while its screen is locked or it is busy.
  // Sync resumes by itself, so the locked state stays silent.
  if (
    code.endsWith('_CHANGED') ||
    [
      'DESKTOP_BUSY',
      'DESKTOP_CLIPBOARD_BUSY',
      'DESKTOP_CLIPBOARD_UNAVAILABLE',
      'DESKTOP_INPUT_BUSY',
    ].includes(code)
  )
    return { code, notice: null, delay: RETRY_MS, transient: true };
  return {
    code,
    notice: 'clipboardSyncFailed',
    delay: Math.min(MAX_BACKOFF_MS, RETRY_MS * 2 ** Math.min(failures, 2)),
    transient: false,
  };
}

/** One lease's opt-ins. Clipboard payloads stay in Main; callers only receive status. */
export class ViewerSafety {
  private clipboard: ViewerClipboard | undefined;
  private revision = 0;
  private inflight: Promise<RemoteViewerSafety> | null = null;
  private settled: Promise<void> = Promise.resolve();
  async pause(): Promise<void> {
    this.invalidate();
    await this.settled;
  }
  /** Resolves once in-flight work has settled, so a caller can run a fresh tick. */
  idle(): Promise<void> {
    return this.settled;
  }
  /** User returned or copied/pasted: permissions may have changed in Settings. */
  wake(): void {
    this.retryAt = 0;
    this.failures = 0;
  }
  private baseline: ClipboardSyncBaseline = { local: '', remote: '' };
  private localReadCache: LocalClipboardReadCache = {};
  private applied = new Map<string, boolean>();
  private notices = new Map<string, string>();
  private clipboardNoticeVersion = 0;
  private retryAt = 0;
  private failures = 0;
  private privacyActive = false;
  invalidate(resetBaseline = false): void {
    this.revision++;
    this.clipboard?.stop?.();
    this.applied.clear();
    this.notices.clear();
    this.privacyActive = false;
    this.retryAt = 0;
    this.failures = 0;
    if (resetBaseline) {
      this.baseline = { local: '', remote: '' };
      this.localReadCache = {};
    }
  }
  snapshot(): RemoteViewerSafety {
    return {
      privacyActive: this.privacyActive,
      notice:
        this.notices.get('privacyScreen') ??
        this.notices.get('hostMute') ??
        this.notices.get('clipboardSync') ??
        null,
      clipboardProgress: null,
      clipboardNoticeVersion: this.clipboardNoticeVersion,
    };
  }
  private clearClipboardErrorNotice(): void {
    if (
      ['clipboardSyncFailed', 'clipboardSyncPermission'].includes(
        this.notices.get('clipboardSync') ?? '',
      )
    )
      this.notices.delete('clipboardSync');
  }
  private recordClipboardFailure(error: unknown): void {
    const failure = viewerClipboardFailure(error, this.failures);
    if (!failure.transient) this.failures++;
    // Only the computer refusing sync needs it re-enabled; a local helper failure does not.
    if (failure.code === 'DESKTOP_CLIPBOARD_UNAVAILABLE') {
      this.applied.delete('clipboardSync');
      this.clearClipboardErrorNotice();
    }
    if (failure.notice) this.notices.set('clipboardSync', failure.notice);
    this.retryAt = failure.delay === null ? Infinity : Date.now() + failure.delay;
  }
  async tick(options: {
    lease: string;
    caps: RemoteDesktopCapabilities;
    preferences: RemoteViewerPreferences;
    current(): boolean;
    clipboardCurrent(): boolean;
    clipboard?: ViewerClipboard;
    request<T>(request: RemoteDesktopRequest, check: () => void): Promise<T>;
  }): Promise<RemoteViewerSafety> {
    // One pass at a time, and a caller that finds one in flight shares its
    // result. Two wakeups that waited on the same idle() race for the fresh
    // pass; the loser must not settle on a stale snapshot and open the paste
    // gate before that pass has pushed the clipboard.
    if (this.inflight) return this.inflight;
    if (!options.current()) return this.snapshot();
    this.clipboard = options.clipboard;
    let settle!: () => void;
    this.settled = new Promise((resolve) => {
      settle = resolve;
    });
    this.inflight = this.pass(options).finally(() => {
      this.inflight = null;
      settle();
    });
    return this.inflight;
  }
  private async pass(options: {
    lease: string;
    caps: RemoteDesktopCapabilities;
    preferences: RemoteViewerPreferences;
    current(): boolean;
    clipboardCurrent(): boolean;
    clipboard?: ViewerClipboard;
    request<T>(request: RemoteDesktopRequest, check: () => void): Promise<T>;
  }): Promise<RemoteViewerSafety> {
    const revision = this.revision;
    const valid = () => revision === this.revision && options.current();
    const check = () => {
      if (!valid()) throw new Error('DESKTOP_STOPPED');
    };
    const request = <T>(message: RemoteDesktopRequest) => options.request<T>(message, check);
    const { caps, lease, preferences } = options;
    for (const op of ['privacyScreen', 'hostMute', 'clipboardSync'] as const) {
      if (op === 'clipboardSync' && Date.now() < this.retryAt) continue;
      if (!caps[op] || this.applied.get(op) === preferences[op]) continue;
      try {
        check();
        const result = await request<{ enabled?: boolean }>({
          op,
          lease,
          enabled: preferences[op],
          ...(op === 'privacyScreen' ? { lockOnExit: preferences.lockOnExit } : {}),
        });
        check();
        this.applied.set(op, preferences[op]);
        if (op === 'privacyScreen') this.privacyActive = result.enabled === true;
        this.notices.delete(op);
      } catch (error) {
        if (!valid()) return this.snapshot();
        // Retry is explicit for safety failures; synchronization follows its own schedule.
        if (op === 'clipboardSync') this.recordClipboardFailure(error);
        else {
          this.notices.set(op, op === 'privacyScreen' ? 'privacyFailed' : 'hostMuteFailed');
          this.applied.set(op, preferences[op]);
        }
      }
    }
    if (
      !preferences.clipboardSync ||
      !caps.clipboardSync ||
      !options.clipboard ||
      this.applied.get('clipboardSync') !== true ||
      Date.now() < this.retryAt ||
      !options.clipboardCurrent()
    )
      return this.snapshot();
    const current = () => valid() && options.clipboardCurrent();
    const clipboardCheck = () => {
      if (!current()) throw new Error('DESKTOP_STOPPED');
    };
    const local = <T>(work: Promise<T>) =>
      work.catch((error: unknown) => {
        throw error instanceof Error && error.message === 'DESKTOP_CLIPBOARD_UNAVAILABLE'
          ? new Error(VIEWER_CLIPBOARD_UNAVAILABLE)
          : error;
      });
    const engine = new ClipboardSync(
      {
        lease,
        current,
        inline: caps.clipboardInline === true,
        request: (message) => options.request(message, clipboardCheck),
        localVersion: () => local(options.clipboard!.version(current)),
        readLocal: () => local(options.clipboard!.read(current)),
        writeLocal: (json, version) => local(options.clipboard!.write(json, version, current)),
        localReadCache: this.localReadCache,
        trace: (stage, code) => {
          if (!valid()) return;
          if (stage === 'content-skipped') {
            this.notices.set(
              'clipboardSync',
              code === 'CLIPBOARD_TOO_LONG' ? 'clipboardSyncTooLarge' : 'clipboardSyncSkipped',
            );
          } else if (
            [
              'phone-to-computer-complete',
              'computer-to-phone-complete',
              'unchanged-content',
              'content-empty',
            ].includes(stage)
          )
            this.notices.delete('clipboardSync');
        },
        digest: (json) => {
          const c = parseClipboardContent(json);
          return createHash('sha256')
            .update(JSON.stringify([c.text, c.html, c.rtf, c.url, c.png]))
            .digest('hex');
        },
      },
      this.baseline,
    );
    // Authority changes stop pending reads. Their late results must not count
    // as sync failures for the next control session.
    const { local: previousLocal, remote: previousRemote } = this.baseline;
    try {
      await engine.tick();
      if (current()) {
        this.clearClipboardErrorNotice();
        this.failures = 0;
      }
    } catch (error) {
      if (!current()) return this.snapshot();
      this.recordClipboardFailure(error);
    }
    // Count accepted snapshots once, after skipped-content can become a conflict.
    // Idle polls, backoff and rejected/stale reads must not replay the old toast.
    if (
      current() &&
      (this.baseline.local !== previousLocal || this.baseline.remote !== previousRemote) &&
      ['clipboardSyncSkipped', 'clipboardSyncTooLarge', 'clipboardSyncConflict'].includes(
        this.notices.get('clipboardSync') ?? '',
      )
    )
      this.clipboardNoticeVersion++;
    return this.snapshot();
  }
}
