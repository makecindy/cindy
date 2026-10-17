const claimedDrops = new WeakSet<Event>();

/** A nested action owns this drop even if document capture already classified it as sorting. */
export function claimSortableDrop(event: Event): void {
  claimedDrops.add(event);
}

/** Keep the original event until onEnd: stopping propagation does not undo an earlier hover reorder. */
export function isSortableDropClaimed(event: Event | null): boolean {
  return event !== null && claimedDrops.has(event);
}
