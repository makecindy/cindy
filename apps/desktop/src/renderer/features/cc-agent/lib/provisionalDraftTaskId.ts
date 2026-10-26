/**
 * 新建页当前未发送任务的 id(无依赖的小登记表)。侧栏分组等纯函数据此把它当成普通任务
 * 放进所选项目，而不是按「从未发送」归到未分类。生命周期由 provisionalDraftTask.ts 管理。
 */

let currentId: string | null = null;
// Retain the last submitted draft's placement until the next draft replaces it.
// A list response can still contain its pre-send row after navigation completes.
// This is only a grouping hint, never an editable-draft identity or a sent receipt.
let projectId: string | null = null;
const listeners = new Set<() => void>();

export function getProvisionalDraftTaskId(): string | null {
  return currentId;
}

export function getProvisionalDraftProjectTaskId(): string | null {
  return projectId;
}

export function setProvisionalDraftTaskId(id: string | null, keepProjectPlacement = false): void {
  const nextProjectId = keepProjectPlacement ? projectId : id;
  if (currentId === id && projectId === nextProjectId) return;
  currentId = id;
  projectId = nextProjectId;
  for (const listener of listeners) listener();
}

export function subscribeProvisionalDraftTaskId(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
