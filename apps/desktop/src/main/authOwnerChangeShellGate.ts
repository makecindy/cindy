/**
 * Coordinates login-page initialization with real auth owner transitions.
 * Nested transitions share one settled signal so callers cannot capture an
 * obsolete login epoch while logout or account replacement is still tearing
 * down the previous owner.
 */
export class AuthOwnerChangeShellGate {
  private depth = 0;
  private pending: Promise<void> | null = null;
  private resolvePending: (() => void) | null = null;

  enter(): void {
    if (this.depth === 0) {
      this.pending = new Promise<void>((resolve) => {
        this.resolvePending = resolve;
      });
    }
    this.depth += 1;
  }

  leave(): void {
    if (this.depth === 0) return;
    this.depth -= 1;
    if (this.depth !== 0) return;

    const resolve = this.resolvePending;
    this.pending = null;
    this.resolvePending = null;
    resolve?.();
  }

  isPending(): boolean {
    return this.depth > 0;
  }

  async waitForSettled(): Promise<void> {
    // A second transition can start while a previous wait resumes. Re-read the
    // active promise until there is no owner-change shell left to observe.
    while (this.pending) {
      await this.pending;
    }
  }
}
