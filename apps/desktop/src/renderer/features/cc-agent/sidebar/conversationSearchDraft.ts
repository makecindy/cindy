/** Window-local draft shared by the inline and collapsed sidebar search.
 * Keep it across view remounts, without storing search text on disk.
 */
let query = '';
let matchAll = false;
const listeners = new Set<() => void>();

export const getSearchDraft = () => query;
export const getSearchMatchAll = () => matchAll;
export function setSearchMatchAll(next: boolean): void {
  if (matchAll === next) return;
  matchAll = next;
  for (const listener of listeners) listener();
}
export function setSearchDraft(next: string): void {
  if (query === next) return;
  query = next;
  for (const listener of listeners) listener();
}
export function subscribeSearchDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
