/** 首页项目顺序:对齐桌面侧栏 #3030,但不共用桌面 localStorage / owner 作用域。 */

export type HomeProjectOrder = 'activity' | 'custom';

export function normalizeProjectKey(value: string): string {
  return value.trim();
}

export function normalizeProjectKeyList(values: readonly string[]): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = normalizeProjectKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(key);
  }
  return next;
}

/** 保留 prev 里仍存在的 key,新 key 追加末尾。 */
export function normalizeManualProjectOrder(
  prev: readonly string[],
  activeKeys: readonly string[],
): string[] {
  const active = normalizeProjectKeyList(activeKeys);
  const activeSet = new Set(active);
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of prev) {
    const key = normalizeProjectKey(value);
    if (!key || !activeSet.has(key) || seen.has(key)) continue;
    seen.add(key);
    next.push(key);
  }
  for (const key of active) {
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(key);
  }
  return next;
}

/**
 * 把可见子集的新顺序原位 merge 回完整顺序。
 * 不可见项(其它设备范围等)保位,不能被甩到末尾。
 */
export function mergeVisibleReorder(
  currentFullOrder: readonly string[],
  visibleNewOrder: readonly string[],
): string[] {
  const visibleSet = new Set(visibleNewOrder);
  const queue = [...visibleNewOrder];
  const result: string[] = [];
  for (const id of currentFullOrder) {
    if (visibleSet.has(id)) {
      result.push(queue.length > 0 ? (queue.shift() as string) : id);
    } else {
      result.push(id);
    }
  }
  for (const id of queue) result.push(id);
  return result;
}

/** 第一次切到手动:用切换前的可见视觉序填回全量 baseline 的可见槽位。 */
export function snapshotManualProjectOrder(
  visualVisibleKeys: readonly string[],
  baselineKeys: readonly string[],
): string[] {
  const fullOrder = normalizeManualProjectOrder([], baselineKeys);
  return mergeVisibleReorder(fullOrder, visualVisibleKeys);
}

export function reorderVisibleProjectToIndex(
  currentFullOrder: readonly string[],
  visibleKeys: readonly string[],
  sourceKey: string,
  targetIndex: number,
): string[] | null {
  const visible = normalizeProjectKeyList(visibleKeys);
  const from = visible.indexOf(sourceKey);
  if (from < 0) return null;
  const to = Math.max(0, Math.min(visible.length - 1, Math.round(targetIndex)));
  if (from === to) return null;
  const nextVisible = visible.slice();
  nextVisible.splice(from, 1);
  nextVisible.splice(to, 0, sourceKey);
  const fullOrder = normalizeManualProjectOrder(currentFullOrder, [
    ...currentFullOrder,
    ...visible,
  ]);
  return mergeVisibleReorder(fullOrder, nextVisible);
}

export function moveVisibleProjectOrder(
  currentFullOrder: readonly string[],
  visibleKeys: readonly string[],
  sourceKey: string,
  direction: -1 | 1,
): string[] | null {
  const visible = normalizeProjectKeyList(visibleKeys);
  const index = visible.indexOf(sourceKey);
  if (index < 0) return null;
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= visible.length) return null;
  return reorderVisibleProjectToIndex(currentFullOrder, visible, sourceKey, nextIndex);
}

/**
 * 把源行从可见列表拿掉之后,按 dropIndex 插回去。
 * dropIndex 是剩余行里的插入位(0..remaining.length),由 projectDropIndexFromY 在排除源行后算出。
 */
export function reorderVisibleProjectByDropIndex(
  currentFullOrder: readonly string[],
  visibleKeys: readonly string[],
  sourceKey: string,
  dropIndex: number,
): string[] | null {
  const visible = normalizeProjectKeyList(visibleKeys);
  const from = visible.indexOf(sourceKey);
  if (from < 0) return null;
  const remaining = visible.filter((key) => key !== sourceKey);
  const to = Math.max(0, Math.min(remaining.length, Math.round(dropIndex)));
  const nextVisible = remaining.slice();
  nextVisible.splice(to, 0, sourceKey);
  if (nextVisible.every((key, index) => key === visible[index])) return null;
  const fullOrder = normalizeManualProjectOrder(currentFullOrder, [
    ...currentFullOrder,
    ...visible,
  ]);
  return mergeVisibleReorder(fullOrder, nextVisible);
}

export function projectDropIndexFromY(
  layouts: readonly { height: number; y: number }[],
  y: number,
): number {
  if (layouts.length === 0) return 0;
  for (let i = 0; i < layouts.length; i += 1) {
    if (y < layouts[i].y + layouts[i].height / 2) return i;
  }
  return layouts.length;
}
