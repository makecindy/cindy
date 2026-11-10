/**
 * 设置 › 个性化 里「查看记忆」子页（Cindy 记忆）的地址。单独成文件：聊天里的保存回执也用它直达，
 * 不该为一个常量把设置页组件拉进聊天的加载路径。
 */
import type { MakerMemoryTaskLocation } from '../../../shared/makerMemoryEntries';

/** `?openPanel=` 的取值。 */
export const MEMORY_ENTRIES_PANEL = 'memory';
/**
 * 打开子页时先选中「这个任务的项目」那一份记忆（可选）：任务的工作目录，SSH 任务另带主机。
 * 哪一份由 main 按工作目录解析；解析不到就落在「关于你」。只在本机应用内的地址里出现。
 */
export const MEMORY_ENTRIES_TASK_PARAM = 'memoryTask';
export const MEMORY_ENTRIES_HOST_PARAM = 'memoryHost';
export const MEMORY_ENTRIES_PARAMS = [MEMORY_ENTRIES_TASK_PARAM, MEMORY_ENTRIES_HOST_PARAM] as const;

export function memoryEntriesRoute(task?: MakerMemoryTaskLocation | null): string {
  const search = new URLSearchParams({ tab: 'personalization', openPanel: MEMORY_ENTRIES_PANEL });
  if (task?.workingDir) {
    search.set(MEMORY_ENTRIES_TASK_PARAM, task.workingDir);
    if (task.remoteHostId) search.set(MEMORY_ENTRIES_HOST_PARAM, task.remoteHostId);
  }
  return `/settings?${search.toString()}`;
}

export function readMemoryEntriesTask(search: URLSearchParams): MakerMemoryTaskLocation | null {
  const workingDir = search.get(MEMORY_ENTRIES_TASK_PARAM);
  return workingDir ? { workingDir, remoteHostId: search.get(MEMORY_ENTRIES_HOST_PARAM) } : null;
}
