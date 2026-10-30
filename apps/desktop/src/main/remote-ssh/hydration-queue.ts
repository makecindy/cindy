/** Serializes SSH config reads, writes, runtime invalidation, and hydration. */
export class RemoteHostHydrationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation);
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }
}
