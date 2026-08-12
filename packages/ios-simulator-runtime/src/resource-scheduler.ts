import os from "node:os";

import { createNodeIOSSimulatorCommandRunner } from "./command-runner.js";
import { IOSSimulatorInstanceError } from "./instance-errors.js";
import type { IOSSimulatorCommandRunner } from "./types.js";

export interface IOSSimulatorMemorySnapshot {
  source: "macos-memory-pressure" | "node-os";
  freePercentage: number | null;
  freeBytes: number;
  totalBytes: number;
}

export type IOSSimulatorMemoryProbe = () =>
  IOSSimulatorMemorySnapshot | Promise<IOSSimulatorMemorySnapshot>;

export interface IOSSimulatorResourceSchedulerOptions {
  softLimit?: number;
  hardLimit?: number;
  memoryProbe?: IOSSimulatorMemoryProbe;
  /** Legacy deterministic seam retained for tests and non-macOS hosts. */
  freeMemoryBytes?: () => number;
}

export interface IOSSimulatorResourceSchedulerSnapshot {
  runningCount: number;
  softLimit: number;
  hardLimit: number;
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const CRITICAL_FREE_PERCENTAGE = 10;
const EXPANDED_INSTANCE_FREE_PERCENTAGE = 20;
const FIRST_INSTANCE_FALLBACK_BYTES = 512 * MIB;
const SECOND_INSTANCE_FALLBACK_BYTES = 1.5 * GIB;
const EXPANDED_INSTANCE_FALLBACK_BYTES = 2.5 * GIB;
const MEMORY_PRESSURE_PATH = "/usr/bin/memory_pressure";

/** Parse the stable summary emitted by `/usr/bin/memory_pressure -Q`. */
export function parseMacOSMemoryPressureFreePercentage(
  output: string,
): number | null {
  const match = output.match(
    /System-wide memory free percentage:\s*([0-9]+(?:\.[0-9]+)?)%/i,
  );
  if (!match) return null;
  const percentage = Number(match[1]);
  return Number.isFinite(percentage) && percentage >= 0 && percentage <= 100
    ? percentage
    : null;
}

/**
 * Read reclaimable-memory pressure on macOS without a shell. Node's
 * `os.freemem()` reports only immediately free pages there and excludes much
 * of the purgeable/file-backed memory that the OS can reclaim for a simulator.
 */
export async function collectIOSSimulatorMemorySnapshot(
  options: {
    platform?: NodeJS.Platform;
    commandRunner?: IOSSimulatorCommandRunner;
    freeMemoryBytes?: () => number;
    totalMemoryBytes?: () => number;
  } = {},
): Promise<IOSSimulatorMemorySnapshot> {
  const freeMemoryBytes = options.freeMemoryBytes ?? (() => os.freemem());
  const totalMemoryBytes = options.totalMemoryBytes ?? (() => os.totalmem());
  const fallback = (): IOSSimulatorMemorySnapshot => ({
    source: "node-os",
    freePercentage: null,
    freeBytes: freeMemoryBytes(),
    totalBytes: totalMemoryBytes(),
  });
  if ((options.platform ?? process.platform) !== "darwin") return fallback();

  const runner = options.commandRunner ?? createNodeIOSSimulatorCommandRunner();
  const result = await runner.run(MEMORY_PRESSURE_PATH, ["-Q"], {
    timeoutMs: 5_000,
    maxBufferBytes: 32 * 1024,
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
  });
  if (result.exitCode !== 0) return fallback();
  const freePercentage = parseMacOSMemoryPressureFreePercentage(
    `${result.stdout}\n${result.stderr}`,
  );
  if (freePercentage === null) return fallback();
  return {
    source: "macos-memory-pressure",
    freePercentage,
    freeBytes: freeMemoryBytes(),
    totalBytes: totalMemoryBytes(),
  };
}

/** Global admission gate with serialized boot/start and pressure-aware headroom. */
export class IOSSimulatorResourceScheduler {
  readonly #softLimit: number;
  readonly #hardLimit: number;
  readonly #memoryProbe: IOSSimulatorMemoryProbe;
  readonly #running = new Set<string>();
  #startTail: Promise<void> = Promise.resolve();

  constructor(options: IOSSimulatorResourceSchedulerOptions = {}) {
    this.#softLimit = options.softLimit ?? 2;
    this.#hardLimit = options.hardLimit ?? 4;
    this.#memoryProbe =
      options.memoryProbe ??
      (options.freeMemoryBytes
        ? () => ({
            source: "node-os" as const,
            freePercentage: null,
            freeBytes: options.freeMemoryBytes?.() ?? 0,
            totalBytes: os.totalmem(),
          })
        : () => collectIOSSimulatorMemorySnapshot());
    if (
      this.#softLimit <= 0 ||
      this.#hardLimit < this.#softLimit ||
      this.#hardLimit > 4
    ) {
      throw new IOSSimulatorInstanceError(
        "INVALID_ARGUMENT",
        "Simulator resource limits must satisfy 0 < soft <= hard <= 4.",
      );
    }
  }

  runningCount(): number {
    return this.#running.size;
  }

  snapshot(): IOSSimulatorResourceSchedulerSnapshot {
    return {
      runningCount: this.#running.size,
      softLimit: this.#softLimit,
      hardLimit: this.#hardLimit,
    };
  }

  markStopped(instanceId: string): void {
    this.#running.delete(instanceId);
  }

  /** Restore observed CoreSimulator occupancy without re-running start admission. */
  restoreRunning(instanceId: string): void {
    this.#running.add(instanceId);
  }

  runStart<T>(
    instanceId: string,
    task: (commitRunning: () => void) => Promise<T>,
  ): Promise<T> {
    const previous = this.#startTail;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#startTail = previous.catch(() => undefined).then(() => gate);
    return previous
      .catch(() => undefined)
      .then(async () => {
        try {
          if (!this.#running.has(instanceId)) await this.#assertAdmission();
          const commitRunning = () => this.#running.add(instanceId);
          const result = await task(commitRunning);
          this.#running.add(instanceId);
          return result;
        } finally {
          release();
        }
      });
  }

  async #assertAdmission(): Promise<void> {
    if (this.#running.size >= this.#hardLimit) {
      throw new IOSSimulatorInstanceError(
        "RESOURCE_LIMIT_REACHED",
        "This Mac is already running the maximum of four Cindy simulator instances.",
        true,
      );
    }

    const memory = await this.#memoryProbe();
    if (memory.freePercentage !== null) {
      const requiredPercentage =
        this.#running.size >= this.#softLimit
          ? EXPANDED_INSTANCE_FREE_PERCENTAGE
          : CRITICAL_FREE_PERCENTAGE;
      if (memory.freePercentage >= requiredPercentage) return;
      throw new IOSSimulatorInstanceError(
        "MEMORY_PRESSURE",
        this.#running.size >= this.#softLimit
          ? "Starting beyond the two-instance soft limit requires lower system memory pressure."
          : "System memory pressure is too high to start another simulator safely.",
        true,
      );
    }

    const fallbackRequiredBytes =
      this.#running.size === 0
        ? FIRST_INSTANCE_FALLBACK_BYTES
        : this.#running.size < this.#softLimit
          ? SECOND_INSTANCE_FALLBACK_BYTES
          : EXPANDED_INSTANCE_FALLBACK_BYTES;
    if (memory.freeBytes < fallbackRequiredBytes) {
      throw new IOSSimulatorInstanceError(
        "MEMORY_PRESSURE",
        "System memory pressure could not be measured and immediately free memory is too low to start another simulator safely.",
        true,
      );
    }
  }
}
