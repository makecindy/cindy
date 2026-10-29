/** Serializes lifecycle operations for one window without blocking other windows. */
export class VoiceInputOperationQueue {
  private readonly tails = new Map<number, Promise<void>>();

  run<T>(webContentsId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(webContentsId) ?? Promise.resolve();
    const result = previous.then(operation);
    // A rejected operation must release the next waiter as well.
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(webContentsId, tail);
    void tail.then(() => {
      if (this.tails.get(webContentsId) === tail) this.tails.delete(webContentsId);
    });
    return result;
  }
}
