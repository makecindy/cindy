/**
 * Electron-agnostic fence tracking in-flight device management mutations
 * (`PATCH` / `DELETE /api/device-link/devices/:id`) and per-device legacy
 * custom-name backfills.
 *
 * Background backfills capture the generation before reading the hybrid
 * directory and abort if a local rename/delete starts before the backfill
 * sends; explicit mutations also await any backfill already in flight for
 * the same device so the user's write is guaranteed to land last.
 */
let mutationSequence = 0;
const activeMutations = new Map<string, number>();
const inflightBackfills = new Map<string, Promise<void>>();

export function deviceDirectoryMutationGeneration(): number {
  return mutationSequence;
}

export function hasActiveDeviceDirectoryMutation(deviceId: string): boolean {
  return (activeMutations.get(deviceId) ?? 0) > 0;
}

export function beginDeviceDirectoryMutation(deviceId: string): () => void {
  mutationSequence += 1;
  activeMutations.set(deviceId, (activeMutations.get(deviceId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Advance on completion too so directory reads started *during* a dual-write
    // cannot backfill a torn V1/V2 snapshot after the mutation finishes.
    mutationSequence += 1;
    const count = (activeMutations.get(deviceId) ?? 1) - 1;
    if (count <= 0) activeMutations.delete(deviceId);
    else activeMutations.set(deviceId, count);
  };
}

export function trackDeviceDirectoryBackfill(deviceId: string, request: Promise<unknown>): void {
  const previous = inflightBackfills.get(deviceId);
  const settled = request.then(() => undefined, () => undefined);
  const chained = previous ? previous.then(() => settled, () => settled) : settled;
  inflightBackfills.set(deviceId, chained);
  void chained.finally(() => {
    if (inflightBackfills.get(deviceId) === chained) inflightBackfills.delete(deviceId);
  });
}

export async function waitForDeviceDirectoryBackfill(deviceId: string): Promise<void> {
  const pending = inflightBackfills.get(deviceId);
  if (pending) await pending;
}
