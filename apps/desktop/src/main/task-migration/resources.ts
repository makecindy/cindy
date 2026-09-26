import fs from 'node:fs/promises';
import os from 'node:os';
import v8 from 'node:v8';
import { constants } from 'node:buffer';

/** JSZip keeps input, inflated content and JS strings alive together. Reserve headroom. */
export function memoryBudget(): number {
  const heap = v8.getHeapStatistics();
  return Math.max(
    0,
    Math.floor(
      Math.min(
        os.freemem(),
        process.availableMemory(),
        heap.heap_size_limit - heap.used_heap_size,
        constants.MAX_LENGTH,
      ) / 4,
    ),
  );
}
export function assertMemoryCapacity(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > memoryBudget())
    throw new Error('MIGRATION_NO_MEMORY');
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
