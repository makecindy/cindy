/** Geometry is rebuilt on structural/width changes, and patched for dirty rows.
 * Scrolling only queries the ordered numeric offsets; it never scans row DOM.
 */
export function findViewportRange(tops: readonly number[], bottoms: readonly number[], top: number, bottom: number) {
  let lo = 0, hi = bottoms.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bottoms[mid] < top) lo = mid + 1; else hi = mid;
  }
  const start = lo;
  lo = start; hi = tops.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (tops[mid] <= bottom) lo = mid + 1; else hi = mid;
  }
  return { start, end: lo };
}

export class MessageViewportGeometry {
  rows: HTMLElement[] = [];
  keys: string[] = [];
  tops: number[] = [];
  bottoms: number[] = [];
  origin = 0;
  private sizes: number[] = [];
  private gaps: number[] = [];
  private dirty = new Set<HTMLElement>();
  private structure = true;
  private full = true;
  private width = -1;
  private itemsWidth = -1;
  private itemsHeight = -1;
  private observer: ResizeObserver | null = null;

  get invalid() { return this.full || this.structure || this.dirty.size > 0; }

  observe(observer: ResizeObserver | null) {
    this.observer = observer;
    if (observer) for (const row of this.rows) observer.observe(row);
  }

  resize(row: HTMLElement, height?: number) {
    const index = this.rows.indexOf(row);
    if (index >= 0 && (height == null || Math.abs(height - this.sizes[index]) > 0.01)) this.dirty.add(row);
  }

  mutations(records: MutationRecord[], items: HTMLElement) {
    for (const record of records) {
      if (record.target === items) {
        if (record.type === 'childList') this.structure = true;
        else this.full = true;
        continue;
      }
      let row = record.target instanceof HTMLElement ? record.target : record.target.parentElement;
      while (row && row.parentElement !== items) row = row.parentElement;
      if (row) this.dirty.add(row);
    }
  }

  refresh(root: HTMLElement, items: HTMLElement, remembered: Map<string, number>) {
    if (this.structure) {
      const rows = Array.from(items.children) as HTMLElement[];
      const keys = rows.map(row => row.dataset.renderItemKey ?? '');
      if (keys.length !== this.keys.length || keys.some((key, i) => key !== this.keys[i])) this.full = true;
      const old = new Set(this.rows), next = new Set(rows);
      for (const row of old) if (!next.has(row)) { this.observer?.unobserve(row); this.dirty.delete(row); }
      for (const row of rows) if (!old.has(row)) { this.dirty.add(row); this.observer?.observe(row); }
      this.rows = rows; this.keys = keys; this.structure = false;
    }
    const width = root.clientWidth, itemsWidth = items.clientWidth, itemsHeight = items.clientHeight;
    // A container resize without a row notification may be a stylesheet/font
    // change. Keep the full measurement fallback for this uncommon path.
    this.full ||= this.width !== width || this.itemsWidth !== itemsWidth ||
      (this.itemsHeight !== itemsHeight && this.dirty.size === 0);
    if (!this.full && !this.dirty.size) return;
    const boxes = new Map<number, DOMRect>();
    const box = (index: number) => {
      let result = boxes.get(index);
      if (!result) { result = this.rows[index].getBoundingClientRect(); boxes.set(index, result); }
      return result;
    };
    const changed: number[] = [];
    for (let i = 0; i < this.rows.length; i++) if (this.full || this.dirty.has(this.rows[i])) changed.push(i);
    if (this.full) { this.sizes = []; this.gaps = []; }
    for (const i of changed) {
      box(i);
      // Capture margins/gaps as well as heights. Measuring immediate neighbors
      // prevents a changed row wrapper from invalidating later numeric offsets.
      if (i > 0) box(i - 1);
      if (i + 1 < this.rows.length) box(i + 1);
    }
    for (const [i, rect] of boxes) {
      this.sizes[i] = rect.height;
      if (this.keys[i] && !this.rows[i].hasAttribute('data-message-placeholder')) remembered.set(this.keys[i], rect.height);
    }
    for (const i of changed) {
      this.gaps[i] = i === 0 ? 0 : box(i).top - box(i - 1).bottom;
      if (i + 1 < this.rows.length) this.gaps[i + 1] = box(i + 1).top - box(i).bottom;
    }
    this.origin = this.rows.length ? box(0).top + root.scrollTop - root.getBoundingClientRect().top : 0;
    this.tops = []; this.bottoms = [];
    let offset = 0;
    for (let i = 0; i < this.rows.length; i++) {
      offset += this.gaps[i]; this.tops.push(offset);
      offset += this.sizes[i]; this.bottoms.push(offset);
    }
    this.width = width; this.itemsWidth = itemsWidth; this.itemsHeight = itemsHeight;
    this.full = false; this.dirty.clear();
  }

  range(position: number, height: number, overscan: number) {
    const relative = position - this.origin;
    const { start, end } = findViewportRange(this.tops, this.bottoms, relative - overscan, relative + height + overscan);
    let lower = -Infinity, upper = Infinity;
    const boundary = (value: number) => {
      if (value <= position) lower = Math.max(lower, value);
      if (value >= position) upper = Math.min(upper, value);
    };
    for (const i of [start - 1, start]) if (i >= 0 && i < this.rows.length) boundary(this.origin + this.bottoms[i] + overscan);
    for (const i of [end - 1, end]) if (i >= 0 && i < this.rows.length) boundary(this.origin + this.tops[i] - height - overscan);
    let anchorIndex = findViewportRange(this.tops, this.bottoms, relative, relative + height).start;
    while (anchorIndex < this.rows.length && (this.bottoms[anchorIndex] <= relative || this.sizes[anchorIndex] === 0)) anchorIndex++;
    return { keys: this.keys.slice(start, end).filter(Boolean), lower, upper,
      anchor: anchorIndex < this.keys.length ? { key: this.keys[anchorIndex], offset: this.origin + this.tops[anchorIndex] - position } : null };
  }
}
