/**
 * One shared read per owner. Callers for the same owner join the read already out; a caller for
 * another owner (an account switch while the read is out) starts its own, so a result is never
 * handed to an account it was not read for.
 */
export class OwnedInFlight<T> {
  private current: { owner: string | null; read: Promise<T> } | null = null;

  run(owner: string | null, start: () => Promise<T>): Promise<T> {
    if (this.current && this.current.owner === owner) return this.current.read;
    const entry: { owner: string | null; read: Promise<T> } = {
      owner,
      read: start().finally(() => {
        if (this.current === entry) this.current = null;
      }),
    };
    this.current = entry;
    return entry.read;
  }
}
