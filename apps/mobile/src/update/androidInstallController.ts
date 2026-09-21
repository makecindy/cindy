/** One installer shared by startup, Settings and the forced-update gate. No React/native imports. */
export interface AndroidInstallTarget { installUrl: string; version: string }
export type AndroidInstallPhase = 'idle' | 'permission-required' | 'permission' | 'permission-denied' | 'downloading' | 'installing' | 'ready' | 'error';
export interface AndroidInstallState {
  phase: AndroidInstallPhase;
  target: AndroidInstallTarget | null;
  progress: number | null;
}
export interface AndroidInstallIO {
  supported(): boolean;
  hasPermission(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  download(url: string, signal: AbortSignal, progress: (value: number | null) => void): Promise<string>;
  install(uri: string, version: string, signal: AbortSignal): Promise<void>;
  remove(uri: string): Promise<void>;
  openBrowser(url: string): Promise<void>;
}
const IDLE: AndroidInstallState = { phase: 'idle', target: null, progress: null };

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
  // Files passed to Android must survive dialog dismissal and installation cancellation.
  private handedToInstaller = false;
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
  start(target: AndroidInstallTarget): boolean {
    try {
      if (!this.io.supported() || !isDirectApkUrl(target.installUrl)) return false;
    } catch { return false; }
    if (this.state.phase !== 'idle' || this.operation) return true;
    this.update({ phase: 'permission', target, progress: null });
    void this.run();
    return true;
  }
  retry = (): void => {
    if (!this.operation && this.state.target) {
      const grant = this.state.phase === 'permission-required' || this.state.phase === 'permission-denied';
      void this.run(grant);
    }
  };

  private async run(grant = false): Promise<void> {
    const target = this.state.target;
    if (!target || this.operation) return;
    const operation = new AbortController();
    this.operation = operation;
    const current = () => !operation.signal.aborted;
    try {
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
      if (!this.file) {
        this.update({ phase: 'downloading', target, progress: null });
        const file = await this.io.download(target.installUrl, operation.signal, (progress) => {
          if (current()) this.update({ phase: 'downloading', target, progress });
        });
        if (!current()) { await this.io.remove(file).catch(() => undefined); return; }
        this.file = file;
        this.handedToInstaller = false;
      }
      this.update({ phase: 'installing', target, progress: 1 });
      this.handedToInstaller = true;
      await this.io.install(this.file, target.version, operation.signal);
      if (current()) this.update({ phase: 'ready', target, progress: 1 });
      // Launching Android's installer is not proof that the update was installed.
    } catch {
      if (current()) {
        // A rejected handoff (invalid APK, missing installer, revoked permission) owns no file.
        const failedFile = this.file;
        this.file = null;
        this.handedToInstaller = false;
        if (failedFile) await this.io.remove(failedFile).catch(() => undefined);
        if (current()) this.update({ phase: 'error', target, progress: null });
      }
    } finally {
      if (this.operation === operation) this.operation = null;
    }
  }

  close = (): void => {
    this.operation?.abort();
    this.operation = null;
    const file = this.file;
    this.file = null;
    if (file && !this.handedToInstaller) void this.io.remove(file).catch(() => undefined);
    this.handedToInstaller = false;
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
