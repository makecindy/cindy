import type { WorkLouderCodexTaskCatalogInput } from './taskSlots.js';

type TaskCatalogListener = () => void;

let publishedRows: WorkLouderCodexTaskCatalogInput[] | null = null;
let publishedScope: string | null = null;
const listeners = new Set<TaskCatalogListener>();

/** Store the renderer's local+remote sidebar projection under its owner scope. */
export function publishRendererTaskCatalog(
  rows: readonly WorkLouderCodexTaskCatalogInput[],
  scope: string | null,
): void {
  if (!scope) return;
  publishedRows = rows.map((row) => ({ ...row }));
  publishedScope = scope;
  for (const listener of listeners) listener();
}

/** Read only a projection belonging to the current owner. */
export function readRendererTaskCatalog(scope: string | null): readonly WorkLouderCodexTaskCatalogInput[] | null {
  if (!scope || publishedScope !== scope) {
    publishedRows = null;
    publishedScope = null;
    return null;
  }
  return publishedRows;
}

/** Drop the projection at the device runtime boundary. */
export function clearRendererTaskCatalog(): void {
  publishedRows = null;
  publishedScope = null;
  for (const listener of listeners) listener();
}

/** Let other input-device adapters refresh when the renderer publishes tasks. */
export function subscribeRendererTaskCatalog(listener: TaskCatalogListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
