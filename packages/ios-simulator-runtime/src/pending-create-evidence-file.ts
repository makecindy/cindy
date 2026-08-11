import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const EVIDENCE_VERSION = 1;

/**
 * Create-side view of the interrupted-create breadcrumb. `createExact` arms it
 * before `simctl create` can commit a device, so a crash between the create and
 * the ownership write still leaves proof that this profile may hold a hidden
 * create marker.
 */
export interface IOSSimulatorPendingCreateEvidence {
  /** Arms the breadcrumb and returns the generation that armed it. */
  arm(): number;
  /**
   * Retires the breadcrumb, but only when no later create armed it. Callers may
   * only invoke this from a path that proves their own marker no longer exists.
   */
  clearIfUnchanged(generation: number): void;
}

/**
 * Recovery-side view. A profile with no persisted ownership and no armed
 * evidence provably has nothing to sweep, so the Host can skip the
 * CoreSimulator probe entirely instead of running `simctl` on every startup.
 */
export interface IOSSimulatorPendingCreateEvidenceStore
  extends IOSSimulatorPendingCreateEvidence {
  isArmed(): boolean;
  /**
   * Monotonic arm counter. A sweep captures it before it starts and passes it
   * back to `clearIfUnchanged`, so a create issued while the sweep was running
   * never has its evidence retired by that sweep.
   */
  generation(): number;
}

export interface IOSSimulatorPendingCreateEvidenceFileOptions {
  /** Best-effort persistence seam: failures are reported, never thrown. */
  onError?: (error: unknown) => void;
}

/**
 * Presence-only marker file kept beside the profile ownership registry. Only
 * existence is authoritative; the JSON body is human-facing debug context and
 * is never parsed back.
 *
 * Concurrency: every mutation happens under the profile ownership writer lease
 * (creates require the persisted actor, sweeps run inside recovery), so no
 * cross-process locking of its own is required.
 */
export class IOSSimulatorPendingCreateEvidenceFile
  implements IOSSimulatorPendingCreateEvidenceStore
{
  readonly #filePath: string;
  readonly #onError: ((error: unknown) => void) | null;
  #generation = 0;

  constructor(
    filePath: string,
    options: IOSSimulatorPendingCreateEvidenceFileOptions = {},
  ) {
    this.#filePath = filePath;
    this.#onError = options.onError ?? null;
  }

  get filePath(): string {
    return this.#filePath;
  }

  arm(): number {
    this.#generation += 1;
    try {
      mkdirSync(path.dirname(this.#filePath), { recursive: true });
      writeFileSync(
        this.#filePath,
        JSON.stringify({
          version: EVIDENCE_VERSION,
          armedAt: new Date().toISOString(),
        }),
        { encoding: "utf8", mode: 0o600 },
      );
    } catch (error) {
      // A missing breadcrumb only defers marker cleanup to the next simulator
      // use. Failing the create the user actually asked for would be worse.
      this.#onError?.(error);
    }
    return this.#generation;
  }

  isArmed(): boolean {
    return existsSync(this.#filePath);
  }

  generation(): number {
    return this.#generation;
  }

  clearIfUnchanged(generation: number): void {
    if (generation !== this.#generation) return;
    try {
      rmSync(this.#filePath, { force: true });
    } catch (error) {
      // Keeping stale evidence only costs one extra sweep on the next startup.
      this.#onError?.(error);
    }
  }
}
