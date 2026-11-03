import fs from 'node:fs/promises';
import os from 'node:os';
import v8 from 'node:v8';
import { constants } from 'node:buffer';

/** Each input to {@link memoryBudget}, for logs explaining a `MIGRATION_NO_MEMORY`. */
export function memoryBudgetDetail() {
  const heap = v8.getHeapStatistics();
  const inputs = {
    freeMemory: os.freemem(),
    availableMemory: process.availableMemory(),
    heapRemaining: heap.heap_size_limit - heap.used_heap_size,
    maxBufferLength: constants.MAX_LENGTH,
  };
  return { ...inputs, budget: Math.max(0, Math.floor(Math.min(...Object.values(inputs)) / 4)) };
}

/** JSZip keeps input, inflated content and JS strings alive together. Reserve headroom. */
export function memoryBudget(): number {
  return memoryBudgetDetail().budget;
}

/** Work that does not fit the budget; the numbers explain the failure in logs and the UI. */
export class MigrationSizeError extends Error {
  constructor(
    readonly code: string,
    readonly neededBytes: number,
    readonly limitBytes: number,
  ) {
    super(`${code}: needs ${neededBytes} bytes, limit ${limitBytes} bytes`);
  }
}

export function assertMemoryCapacity(bytes: number): void {
  const budget = memoryBudget();
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget)
    throw new MigrationSizeError('MIGRATION_NO_MEMORY', bytes, budget);
}

/** Combine simultaneous allocations on the same filesystem, including separate mount paths. */
export async function assertDiskCapacity(
  allocations: Array<{ path: string; bytes: number }>,
): Promise<void> {
  const volumes = new Map<string, { free: bigint; required: bigint }>();
  for (const allocation of allocations) {
    if (!Number.isSafeInteger(allocation.bytes) || allocation.bytes < 0)
      throw new Error('MIGRATION_INVALID_MANIFEST');
    const [stat, space] = await Promise.all([
      fs.stat(allocation.path, { bigint: true }),
      fs.statfs(allocation.path, { bigint: true }),
    ]);
    const free = space.bavail * space.bsize;
    const previous = volumes.get(String(stat.dev));
    volumes.set(String(stat.dev), {
      free: previous && previous.free < free ? previous.free : free,
      required: (previous?.required ?? 0n) + BigInt(allocation.bytes),
    });
  }
  for (const { free, required } of volumes.values()) {
    // Relative reserve accounts for filesystem overhead and concurrent writes; no size ceiling.
    if (required + required / 10n > free) throw new Error('MIGRATION_NO_SPACE');
  }
}
