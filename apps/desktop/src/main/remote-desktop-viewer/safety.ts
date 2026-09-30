import { createHash } from 'node:crypto';
import {
  ClipboardSync,
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

/** One lease's opt-ins. Clipboard payloads stay in Main; callers only receive status. */
export class ViewerSafety {
  private clipboard: ViewerClipboard | undefined;
  private revision = 0;
  private clipboardRevision = 0;
  private pending = false;
  private settled: Promise<void> = Promise.resolve();
  async pause(): Promise<void> {
    this.invalidate();
    await this.settled;
  }
  async pauseClipboard(): Promise<void> {
    this.clipboardRevision++;
    this.clipboard?.stop?.();
    await this.settled;
    // Focus changes must not retry privacy/mute failures or clear their status.
    this.applied.delete('clipboardSync');
    this.retryAt = 0;
  }
  private baseline: ClipboardSyncBaseline = { local: '', remote: '' };
  private localReadCache: LocalClipboardReadCache = {};
  private applied = new Map<string, boolean>();
  private notices = new Map<string, string>();
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
    };
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
    if (this.pending || !options.current()) return this.snapshot();
    this.clipboard = options.clipboard;
    this.pending = true;
    let settle!: () => void;
    this.settled = new Promise((resolve) => {
      settle = resolve;
    });
    const revision = this.revision;
    const clipboardRevision = this.clipboardRevision;
    const valid = () => revision === this.revision && options.current();
    const check = () => {
      if (!valid()) throw new Error('DESKTOP_STOPPED');
    };
    const request = <T>(message: RemoteDesktopRequest) => options.request<T>(message, check);
    const { caps, lease, preferences } = options;
    try {
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
          this.notices.set(
            op,
            op === 'privacyScreen'
              ? 'privacyFailed'
              : op === 'hostMute'
                ? 'hostMuteFailed'
                : 'clipboardSyncFailed',
          );
          // Retry is explicit for safety failures; synchronization follows its existing backoff below.
          if (op === 'clipboardSync') {
            const failure = clipboardSyncFailure(error, this.failures++);
            this.retryAt = failure.delay === null ? Infinity : Date.now() + failure.delay;
            this.notices.set(op, failure.notice);
          } else this.applied.set(op, preferences[op]);
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
      const current = () =>
        valid() && clipboardRevision === this.clipboardRevision && options.clipboardCurrent();
      const clipboardCheck = () => {
        if (!current()) throw new Error('DESKTOP_STOPPED');
      };
      const engine = new ClipboardSync(
        {
          lease,
          current,
          inline: caps.clipboardInline === true,
          request: (message) => options.request(message, clipboardCheck),
          localVersion: () => options.clipboard!.version(current),
          readLocal: () => options.clipboard!.read(current),
          writeLocal: (json, version) => options.clipboard!.write(json, version, current),
          localReadCache: this.localReadCache,
          trace: (stage) => {
            if (!valid()) return;
            if (stage === 'content-skipped')
              this.notices.set('clipboardSync', 'clipboardSyncSkipped');
            else if (['phone-to-computer-complete', 'computer-to-phone-complete'].includes(stage))
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
      try {
        await engine.tick();
        if (valid()) {
          if (
            ['clipboardSyncFailed', 'clipboardSyncPermission'].includes(
              this.notices.get('clipboardSync') ?? '',
            )
          )
            this.notices.delete('clipboardSync');
          this.failures = 0;
        }
      } catch (error) {
        if (!valid()) return this.snapshot();
        const failure = clipboardSyncFailure(error, this.failures++);
        if (failure.code === 'DESKTOP_CLIPBOARD_UNAVAILABLE') this.applied.delete('clipboardSync');
        this.notices.set('clipboardSync', failure.notice);
        this.retryAt = failure.delay === null ? Infinity : Date.now() + failure.delay;
      }
      return this.snapshot();
    } finally {
      this.pending = false;
      settle();
    }
  }
}
