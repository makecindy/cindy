/** One installer shared by startup, Settings and the forced-update gate. No React/native imports. */
export interface AndroidInstallTarget { installUrl: string; version: string; releaseNotes?: string }
/** offer: an update was discovered and waits for the user's go-ahead (permission already granted). */
export type AndroidInstallPhase = 'idle' | 'offer' | 'permission-required' | 'permission' | 'permission-denied' | 'downloading' | 'installing' | 'ready' | 'error';
export interface AndroidInstallStartOptions {
  /** Discovery prompts wait for an explicit tap; the forced gate's button already is that tap. */
  confirm?: boolean;
  /** Download silently on Wi-Fi, then offer installation. */
  automatic?: boolean;
}
export interface AndroidInstallState {
  phase: AndroidInstallPhase;
  target: AndroidInstallTarget | null;
  progress: number | null;
  silent?: boolean;
}
export interface AndroidInstallIO {
  supported(): boolean;
  hasPermission(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  download(url: string, signal: AbortSignal, progress: (value: number | null) => void, version: string, wifiOnly?: boolean): Promise<string>;
  waitForForeground(signal: AbortSignal): Promise<void>;
  install(uri: string, version: string, signal: AbortSignal): Promise<void>;
  remove(uri: string): Promise<void>;
  openBrowser(url: string): Promise<void>;
}
const IDLE: AndroidInstallState = { phase: 'idle', target: null, progress: null };

/** The button label and its effect share one rule: Cancel stops this operation;
 * Later suppresses subsequent automatic offers for the target. */
export function androidUpdateDismissAction(phase: AndroidInstallPhase): 'later' | 'cancel' {
  return phase === 'downloading' || phase === 'installing' ? 'cancel' : 'later';
}

export function isDirectApkUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && /\.apk$/i.test(url.pathname);
  } catch { return false; }
}

export class AndroidInstallController {
  private state = IDLE;
  private listeners = new Set<() => void>();
  private operation: AbortController | null = null;
  private file: string | null = null;
  private awaitingConfirm = false;
  private dismissedAutomaticTarget: string | null = null;
  constructor(private io: AndroidInstallIO) {}
  getSnapshot = (): AndroidInstallState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(state: AndroidInstallState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  /** false means an old native build or a web landing page: keep the original browser path. */
  start(target: AndroidInstallTarget, options: AndroidInstallStartOptions = {}): boolean {
    try {
      if (!this.io.supported() || !isDirectApkUrl(target.installUrl)) return false;
    } catch { return false; }
    const key = JSON.stringify([target.installUrl, target.version]);
    if (options.automatic && this.dismissedAutomaticTarget === key) return true;
    if (this.state.phase !== 'idle' || this.operation) {
      const same = this.state.target?.version === target.version && this.state.target?.installUrl === target.installUrl;
      // Explicit actions can take over a silent transfer; discovery can replace an
      // obsolete silent target, but must not interrupt a user's installation.
      if (same && options.automatic) return true;
      if (!this.state.silent && !(this.state.phase === 'ready' && !same && !this.operation)) return true;
      this.cancel();
    }
    this.awaitingConfirm = options.confirm === true;
    this.update({ phase: 'permission', target, progress: null, silent: options.automatic === true });
    void this.run(false, options.automatic === true);
    return true;
  }
  /** The sheet's primary action: confirm the offer, grant permission, install, or retry. */
  retry = (): void => {
    if (!this.operation && this.state.target) {
      const grant = this.state.phase === 'permission-required' || this.state.phase === 'permission-denied';
      // Tapping the primary action of the first card is the confirmation.
      this.awaitingConfirm = false;
      void this.run(grant);
    }
  };

  private async run(grant = false, automatic = false): Promise<void> {
    const target = this.state.target;
    if (!target || this.operation) return;
    const operation = new AbortController();
    this.operation = operation;
    const current = () => !operation.signal.aborted;
    try {
      if (automatic) {
        this.update({ phase: 'downloading', target, progress: null, silent: true });
        const file = await this.io.download(target.installUrl, operation.signal, () => {}, target.version, true);
        if (!current()) return; // Completed files remain reusable in the target cache.
        this.file = file;
        await this.io.waitForForeground(operation.signal);
        if (current()) this.update({ phase: 'ready', target, progress: 1 });
        return;
      }
      this.update({ phase: 'permission', target, progress: null });
      let allowed = await this.io.hasPermission();
      if (!current()) return;
      if (!allowed && !grant) {
        this.update({ phase: 'permission-required', target, progress: null });
        return;
      }
      if (!allowed) allowed = await this.io.requestPermission();
      if (!current()) return;
      if (!allowed) {
        this.update({ phase: 'permission-denied', target, progress: null });
        return;
      }
      if (this.awaitingConfirm) {
        this.update({ phase: 'offer', target, progress: null });
        return;
      }
      if (!this.file) {
        this.update({ phase: 'downloading', target, progress: null });
        const file = await this.io.download(target.installUrl, operation.signal, (progress) => {
          if (current()) this.update({ phase: 'downloading', target, progress });
        }, target.version);
        if (!current()) return;
        this.file = file;
      }
      this.update({ phase: 'installing', target, progress: 1 });
      await this.io.install(this.file, target.version, operation.signal);
      if (current()) this.update({ phase: 'ready', target, progress: 1 });
      // Launching Android's installer is not proof that the update was installed.
    } catch {
      if (current()) {
        if (automatic) {
          this.file = null;
          this.update(IDLE); // Automatic failures stay quiet; a later check can retry.
          return;
        }
        // A rejected handoff (invalid APK, missing installer, revoked permission) owns no file.
        const failedFile = this.file;
        this.file = null;
        if (failedFile) await this.io.remove(failedFile).catch(() => undefined);
        if (current()) this.update({ phase: 'error', target, progress: null });
      }
    } finally {
      if (this.operation === operation) this.operation = null;
    }
  }

  close = (): void => {
    if (!this.state.silent && this.state.target && androidUpdateDismissAction(this.state.phase) === 'later') {
      this.dismissedAutomaticTarget = JSON.stringify([this.state.target.installUrl, this.state.target.version]);
    }
    this.cancel();
  };

  /** Channel-owner cleanup is cancellation, not the user's Later choice. */
  cancel = (): void => {
    this.operation?.abort();
    this.operation = null;
    this.file = null;
    // Keep completed APKs for later installation; discovering a different target
    // removes obsolete files through the same serialized download queue.
    this.awaitingConfirm = false;
    this.update(IDLE);
  };

  browser = async (): Promise<void> => {
    const target = this.state.target;
    if (!target || this.operation) return;
    const operation = new AbortController();
    this.operation = operation;
    try {
      await this.io.openBrowser(target.installUrl);
      if (!operation.signal.aborted) this.close();
    } catch {
      if (!operation.signal.aborted) this.update({ phase: 'error', target, progress: null });
    } finally {
      if (this.operation === operation) this.operation = null;
    }
  };
}
