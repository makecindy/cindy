import { DeviceLinkError, type PushOwnerStamp } from '@cindy/device-link';

export interface SessionPatch {
  sessionId: string;
  patch: Record<string, unknown>;
}

/** One latest field value per task; never evict another task's deletion/revocation. */
export class SessionPatchStage {
  private readonly pending = new Map<string, SessionPatch>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private disposed = false;

  constructor(
    readonly ownerStamp: PushOwnerStamp | undefined,
    private readonly writable: () => boolean,
    private readonly send: (payload: SessionPatch, isCurrent: () => boolean) => Promise<void>,
    private readonly failed: (error: unknown) => void,
  ) {}

  enqueue(payload: SessionPatch): void {
    if (this.disposed) return;
    const previous = this.pending.get(payload.sessionId);
    this.pending.set(payload.sessionId, {
      sessionId: payload.sessionId,
      patch: { ...previous?.patch, ...payload.patch },
    });
    this.schedule();
  }

  take(sessionId: string): SessionPatch | undefined {
    const item = this.pending.get(sessionId);
    this.pending.delete(sessionId);
    return item;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  private schedule(): void {
    if (this.disposed || this.timer || this.draining || this.pending.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, 250);
  }

  private async drain(): Promise<void> {
    if (this.disposed || this.draining) return;
    this.draining = true;
    try {
      // A large task list must not refill a newly recovered reliable window in one tick.
      for (let count = 0; count < 8 && this.pending.size > 0; count++) {
        if (this.disposed || !this.writable()) break;
        const [key, item] = this.pending.entries().next().value!;
        const isCurrent = () => !this.disposed && this.pending.get(key) === item;
        try {
          await this.send(item, isCurrent);
        } catch (error) {
          if (error instanceof DeviceLinkError
            && ['BACKPRESSURE', 'NOT_CONNECTED', 'LINK_NOT_OPEN'].includes(error.code)) break;
          this.failed(error);
        }
        // A newer patch may have arrived while authorization was awaiting SQLite.
        if (isCurrent()) this.pending.delete(key);
      }
    } finally {
      this.draining = false;
      this.schedule();
    }
  }
}
