export type ShortcutHoldPhase = 'tap' | 'start' | 'end';

export interface ShortcutHoldPhaseControllerOptions {
  holdDelayMs?: number;
  onTrigger: (phase: ShortcutHoldPhase) => void;
}

const DEFAULT_HOLD_DELAY_MS = 450;

/**
 * Turns a native key-down/key-up stream into Cindy's short-tap / push-to-talk phases.
 *
 * Native helpers deliberately stay timing-free. Keeping the threshold here gives
 * macOS and Windows one tested product state machine and makes repeated key-down
 * messages harmless.
 */
export class ShortcutHoldPhaseController {
  private readonly holdDelayMs: number;
  private down = false;
  private holdThresholdReached = false;
  private canceledUntilRelease = false;
  private holdTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: ShortcutHoldPhaseControllerOptions) {
    this.holdDelayMs = options.holdDelayMs ?? DEFAULT_HOLD_DELAY_MS;
  }

  /**
   * @param pressed whether the exact configured chord is currently down
   * @param targetDown whether the target key itself is still physically held.
   *   When the chord is broken by another key (e.g. F16 + Shift), callers pass
   *   `pressed=false` with `targetDown=true` so this press is cancelled instead
   *   of being treated as a tap or a submit.
   */
  setPressed(pressed: boolean, targetDown = pressed): void {
    if (pressed) {
      if (this.canceledUntilRelease || this.down) return;
      this.down = true;
      this.holdThresholdReached = false;
      this.options.onTrigger('start');
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        if (this.down) this.holdThresholdReached = true;
      }, this.holdDelayMs);
      return;
    }

    if (this.down) {
      this.clearHoldTimer();
      this.down = false;
      const shouldTap = !this.holdThresholdReached;
      this.holdThresholdReached = false;
      if (targetDown) {
        this.canceledUntilRelease = true;
        this.options.onTrigger('end');
        return;
      }
      this.canceledUntilRelease = false;
      this.options.onTrigger(shouldTap ? 'tap' : 'end');
      return;
    }

    if (targetDown) {
      this.canceledUntilRelease = true;
      return;
    }
    this.canceledUntilRelease = false;
  }

  releaseIfPressed(): void {
    if (!this.down) {
      this.canceledUntilRelease = false;
      return;
    }
    this.clearHoldTimer();
    this.down = false;
    this.holdThresholdReached = false;
    this.canceledUntilRelease = false;
    this.options.onTrigger('end');
  }

  reset(): void {
    this.clearHoldTimer();
    this.down = false;
    this.holdThresholdReached = false;
    this.canceledUntilRelease = false;
  }

  private clearHoldTimer(): void {
    if (!this.holdTimer) return;
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }
}
