/**
 * Serializes remote-host hydration from source read through runtime cleanup
 * and pool replacement. Keeping the whole transaction ordered prevents an
 * older refresh with slower endpoint invalidation from overwriting a newer
 * SSH config/profile snapshot.
 */
export class RemoteHostHydrationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation);
    // A failed refresh is returned to its caller, but must not poison future
    // refreshes. The tail itself therefore always settles successfully.
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }
}
