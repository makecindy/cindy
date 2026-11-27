import type { TaskListMode } from './useTaskListMode';

export function sidebarModeKey(key: string, mode: TaskListMode): string {
  return mode === 'tasks' ? key : key + '.inbox';
}
