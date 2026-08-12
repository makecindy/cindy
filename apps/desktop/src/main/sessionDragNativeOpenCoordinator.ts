export interface SessionDragNativeOpenIntent<Owner extends object> {
  owner: Owner;
  sessionId: string;
  deviceId: string | null;
}

interface NativeOpenResult {
  sessionId: string;
  deviceId: string | null;
  opened: boolean;
  expiresAt: number;
}

export interface SessionDragNativeOpenCoordinatorOptions {
  now?: () => number;
  resultTtlMs?: number;
}

const DEFAULT_RESULT_TTL_MS = 5_000;

/**
 * Coordinates the macOS mouse-up fast path with Chromium's later dragend.
 *
 * The native path owns the first outside-window classification. Its result is
 * consumed once by the renderer fallback so the same gesture cannot open two
 * windows. Starting another drag invalidates any result left by the previous
 * gesture from that source window.
 */
export class SessionDragNativeOpenCoordinator<Owner extends object> {
  private readonly intents = new Map<number, SessionDragNativeOpenIntent<Owner>>();
  private readonly results = new WeakMap<Owner, NativeOpenResult>();
  private readonly now: () => number;
  private readonly resultTtlMs: number;

  constructor(options: SessionDragNativeOpenCoordinatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.resultTtlMs = options.resultTtlMs ?? DEFAULT_RESULT_TTL_MS;
  }

  begin(token: number, owner: Owner, sessionId: string, deviceId?: string | null): void {
    this.results.delete(owner);
    this.intents.set(token, {
      owner,
      sessionId,
      deviceId: deviceId ?? null,
    });
  }

  stop(token: number): void {
    this.intents.delete(token);
  }

  handleNativeRelease(
    token: number,
    beforeOpen: () => void,
    openIfOutside: (intent: SessionDragNativeOpenIntent<Owner>) => boolean,
  ): boolean | null {
    const intent = this.intents.get(token);
    if (!intent) return null;
    this.intents.delete(token);
    beforeOpen();
    const opened = openIfOutside(intent);
    this.results.set(intent.owner, {
      sessionId: intent.sessionId,
      deviceId: intent.deviceId,
      opened,
      expiresAt: this.now() + this.resultTtlMs,
    });
    return opened;
  }

  consumeNativeResult(owner: Owner, sessionId: string, deviceId?: string | null): boolean | null {
    const result = this.results.get(owner);
    if (!result) return null;
    this.results.delete(owner);
    if (
      result.expiresAt < this.now() ||
      result.sessionId !== sessionId ||
      result.deviceId !== (deviceId ?? null)
    ) {
      return null;
    }
    return result.opened;
  }
}
