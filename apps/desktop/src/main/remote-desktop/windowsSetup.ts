import type {
  WindowsDesktopSetupPhase,
  WindowsDesktopSetupState,
} from '../../shared/remoteDesktop';

/** Main owns setup across settings mounts. Reopening a page observes the same
 * operation; another click never starts a second compiler or UAC prompt. */
export class WindowsDesktopSetup {
  private state: WindowsDesktopSetupState = {
    revision: 0,
    phase: null,
    error: null,
    failedEnabled: null,
    startedAt: null,
  };
  private pending: { enabled: boolean; promise: Promise<void> } | null = null;
  private generation = 0;
  constructor(
    private readonly deps: {
      configure(
        enabled: boolean,
        progress: (phase: WindowsDesktopSetupPhase) => void,
      ): Promise<void>;
      stopDesktop(): void;
      now?: () => number;
    },
  ) {}
  read(): WindowsDesktopSetupState {
    return { ...this.state };
  }
  run(enabled: boolean): Promise<void> {
    if (this.pending) {
      return this.pending.enabled === enabled
        ? this.pending.promise
        : Promise.reject(new Error('DESKTOP_SETUP_BUSY'));
    }
    this.state = {
      revision: this.state.revision + 1,
      phase: enabled ? 'preparing' : 'removing',
      error: null,
      failedEnabled: null,
      startedAt: (this.deps.now ?? Date.now)(),
    };
    const generation = ++this.generation;
    const progress = (phase: WindowsDesktopSetupPhase) => {
      if (this.pending && this.generation === generation)
        this.state = { ...this.state, revision: this.state.revision + 1, phase };
    };
    const promise = Promise.resolve()
      .then(async () => {
        this.deps.stopDesktop();
        await this.deps.configure(enabled, progress);
      })
      .catch((error: unknown) => {
        this.state = {
          ...this.state,
          revision: this.state.revision + 1,
          error:
            error instanceof Error && error.message === 'DESKTOP_NATIVE_BUILD_FAILED'
              ? 'prepare'
              : 'setup',
          failedEnabled: enabled,
        };
        throw error;
      })
      .finally(() => {
        this.state = { ...this.state, revision: this.state.revision + 1, phase: null };
        this.pending = null;
      });
    this.pending = { enabled, promise };
    return promise;
  }
}
