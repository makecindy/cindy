/**
 * Coordinates account-bound Ghost filesystem mutations with session teardown.
 *
 * A mutation lease keeps the active owner stable until all package and host
 * data cleanup has completed. Session teardown waits for the leases before it
 * clears the Ghost root cache and commits a new owner.
 */
export class GhostMutationCoordinator {
  private active = 0;
  private drainPromise: Promise<void> | null = null;
  private resolveDrain: (() => void) | null = null;

  acquire(): () => void {
    if (this.active === 0) {
      this.drainPromise = new Promise<void>((resolve) => {
        this.resolveDrain = resolve;
      });
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      if (this.active === 0) {
        this.resolveDrain?.();
        this.resolveDrain = null;
        this.drainPromise = null;
      }
    };
  }

  async waitForIdle(): Promise<void> {
    while (this.active > 0) {
      await this.drainPromise;
    }
  }
}
