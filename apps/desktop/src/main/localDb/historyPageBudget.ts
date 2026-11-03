/** Soft budget for complete history records, before the tool's small envelope.
 * A single oversized record always makes progress and remains readable in full.
 * Never slice content: callers advance their native cursor at the last kept row.
 */
export class HistoryPageBudget {
  private bytes = 2; // array brackets
  private count = 0;

  get full(): boolean { return this.bytes >= 64 * 1024; }

  tryAdd(item: unknown): boolean {
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + (this.count ? 1 : 0);
    if (this.count > 0 && this.bytes + size > 64 * 1024) return false;
    this.bytes += size;
    this.count++;
    return true;
  }
}

export function historyPageWithinBudget<T>(items: T[]): T[] {
  const budget = new HistoryPageBudget();
  let count = 0;
  for (const item of items) {
    if (!budget.tryAdd(item)) break;
    count++;
  }
  return count === items.length ? items : items.slice(0, count);
}
