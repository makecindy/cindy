/**
 * Away guard (Settings → App behavior → Keep working while away, macOS, default off).
 *
 * While it is on, this Mac never idle-sleeps its display into the lock screen, so an
 * Agent can start or keep working at any time, including tasks sent from a phone
 * later. Once the owner has been away for the chosen time (the system's own
 * display-sleep time by default), every display gets a black cover and Agents keep
 * working behind it. Physical input at this Mac turns into the real system lock (the
 * native helper does this itself), so the owner unlocks with Touch ID or password.
 * Turning the setting off, a new display, or the masks failing also end in the real
 * lock. Remote desktop sessions do not end the cover: the remote viewer captures
 * through it, and a session alone does not prove anyone protects this screen.
 * Nothing here ever unlocks the screen.
 *
 * Fail-safe direction: whenever the guard cannot prove masks are up (missing
 * permission, mask failure, unknown input state), it releases the display
 * assertion so macOS sleeps and locks exactly as it would without Cindy.
 */

export interface AwayGuardDeps {
  enabled(): boolean;
  screenLocked(): boolean;
  /**
   * Milliseconds since the owner's last keyboard/pointer input. Infinity when the
   * newest input was the Agent's own; null when the system cannot tell.
   */
  msSinceOwnerInput(): number | null;
  /** Owner absence after which the cover goes up. */
  awayAfterMs(): number;
  keepDisplayAwake(awake: boolean): void;
  /** Rejects when masks or the native input guard cannot start. */
  showMasks(): Promise<void>;
  /**
   * Locks the screen, then removes the masks. Rejects when the lock is not confirmed;
   * the masks then stay up until the system locks by itself.
   */
  lockAndHideMasks(): Promise<void>;
  /** Removes the masks without locking (already locked, or a preview ran out). */
  hideMasks(): void;
  now(): number;
  log(event: string, detail?: Record<string, unknown>): void;
}

/** After masks fail to start, fall back to the system lock instead of retrying every tick. */
export const AWAY_GUARD_RETRY_MS = 60_000;
/**
 * Settings → "Try it": cover now; if nobody touches the Mac, simply uncover when this
 * runs out. The owner was at this unlocked Mac a moment ago, so ending without a lock
 * leaves it exactly as it was.
 */
export const AWAY_GUARD_PREVIEW_MS = 2 * 60_000;

/**
 * This user's console session from `ioreg -n Root -d1`: locked when its screen is
 * locked or another user has the console. Null when the session is not listed.
 */
export function consoleSessionLocked(ioreg: string, uid: number | undefined): boolean | null {
  if (uid === undefined) return null;
  const user = new RegExp(`"kCGSSessionUserIDKey"=${uid}(?![0-9])`);
  const session = ioreg.match(/\{[^{}]*\}/g)?.find((entry) => user.test(entry));
  if (!session) return null;
  return session.includes('"CGSSessionScreenIsLocked"=Yes') || !session.includes('"kCGSSessionOnConsoleKey"=Yes');
}

type MaskState = 'none' | 'showing' | 'shown' | 'ending';

export class AwayGuardController {
  private mask: MaskState = 'none';
  private ownerInputAt: number;
  private retryAt = 0;
  private previewUntil = 0;
  private displayAddedWhileShowing = false;
  private ticking = false;

  constructor(private readonly deps: AwayGuardDeps) {
    this.ownerInputAt = deps.now();
  }

  get masked(): boolean {
    return this.mask !== 'none';
  }

  /** Every display is covered and the helper is already consuming physical input. */
  get inputShielded(): boolean {
    return this.mask === 'shown';
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.evaluate();
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Settings → "Try it": cover the displays now, without waiting for work or absence,
   * so the owner can check the lock and unlock path. Physical input locks as with a
   * real cover; running out uncovers without a lock.
   */
  async preview(): Promise<void> {
    if (this.mask !== 'none' || this.deps.screenLocked()) return;
    this.beginShowing();
    try {
      await this.deps.showMasks();
    } catch (error) {
      if ((this.mask as MaskState) === 'showing') this.mask = 'none';
      throw error;
    }
    if (!(await this.finishShowing())) return;
    this.previewUntil = this.deps.now() + AWAY_GUARD_PREVIEW_MS;
    this.deps.keepDisplayAwake(true);
    this.deps.log('preview shown');
  }

  /** The masks or the helper went away on their own (input lock, window loss). */
  masksEnded(): void {
    this.previewUntil = 0;
    if (this.mask === 'none') return;
    this.mask = 'none';
    // Whoever touched this Mac counts as present: never re-cover right away.
    this.ownerInputAt = this.deps.now();
    this.deps.log('masks ended');
  }

  /** A display was added while covered: it is not masked, so lock. */
  async displaysChanged(): Promise<void> {
    // Masks are built for the displays seen when showing began; recheck once they are up.
    if (this.mask === 'showing') this.displayAddedWhileShowing = true;
    if (this.mask !== 'shown') return;
    await this.end(true, 'display added');
  }

  private beginShowing(): void {
    this.mask = 'showing';
    this.displayAddedWhileShowing = false;
  }

  /** True when the masks are up and still cover every display. */
  private async finishShowing(): Promise<boolean> {
    if (this.mask !== 'showing') return false;
    this.mask = 'shown';
    if (!this.displayAddedWhileShowing) return true;
    await this.end(true, 'display added while covering');
    return false;
  }

  private async evaluate(): Promise<void> {
    const { deps } = this;
    // A preview is still putting its masks up; let it finish first.
    if (this.mask === 'showing') return;
    const now = deps.now();
    if (deps.screenLocked()) {
      // The owner unlocking starts a fresh absence period.
      this.ownerInputAt = now;
      this.previewUntil = 0;
      return this.standDown(false, 'locked');
    }
    if (this.previewUntil) {
      if (this.mask === 'shown' && now < this.previewUntil) return deps.keepDisplayAwake(true);
      this.previewUntil = 0;
      if (this.mask === 'shown') return this.end(false, 'preview ended');
    }
    if (!deps.enabled()) return this.standDown(true, 'disabled');
    if (this.mask !== 'none') {
      deps.keepDisplayAwake(this.mask !== 'ending');
      return;
    }
    const since = deps.msSinceOwnerInput();
    if (since === null) {
      deps.keepDisplayAwake(false);
      return;
    }
    if (Number.isFinite(since)) this.ownerInputAt = Math.max(this.ownerInputAt, now - since);
    if (now < this.retryAt) {
      deps.keepDisplayAwake(false);
      return;
    }
    deps.keepDisplayAwake(true);
    if (now - this.ownerInputAt < deps.awayAfterMs()) return;
    this.beginShowing();
    try {
      await deps.showMasks();
      if (await this.finishShowing()) deps.log('masks shown');
    } catch (error) {
      if ((this.mask as MaskState) === 'showing') this.mask = 'none';
      this.retryAt = now + AWAY_GUARD_RETRY_MS;
      deps.keepDisplayAwake(false);
      deps.log('masks unavailable', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async standDown(lock: boolean, reason: string): Promise<void> {
    if (this.mask === 'shown' || this.mask === 'showing') {
      if (lock) {
        await this.end(true, reason);
      } else {
        this.mask = 'none';
        this.deps.hideMasks();
        this.deps.log('masks released', { reason });
      }
    }
    if (this.mask === 'none') this.deps.keepDisplayAwake(false);
  }

  private async end(lock: boolean, reason: string): Promise<void> {
    this.mask = 'ending';
    this.previewUntil = 0;
    try {
      if (lock) await this.deps.lockAndHideMasks();
      else this.deps.hideMasks();
    } catch (error) {
      // The masks stay up; with the display released macOS sleeps and locks by itself.
      this.deps.log('lock not confirmed', { reason, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.mask = 'none';
      this.ownerInputAt = this.deps.now();
      this.deps.keepDisplayAwake(false);
      this.deps.log('masks ended', { reason, locked: lock });
    }
  }
}
