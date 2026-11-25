/**
 * Electron-agnostic fence tracking in-flight device management mutations
 * (`PATCH` / `DELETE /api/device-link/devices/:id`).
 *
 * Background legacy-to-Agent-Net custom-name backfills capture the generation
 * before reading the hybrid directory and abort if any local rename/delete
 * starts before the backfill executes — preventing a stale read from
 * resurrecting a custom name that the user just cleared or changed.
 */
let mutationSequence = 0;
const activeMutations = new Map<string, number>();

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
    const count = (activeMutations.get(deviceId) ?? 1) - 1;
    if (count <= 0) activeMutations.delete(deviceId);
    else activeMutations.set(deviceId, count);
  };
}
