import { subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';

export const MAX_RECENT_TASKS = 5;
export type RecentTaskRoute = {
  pathname: '/sessions/[sessionId]';
  params: { deviceId: string; deviceName: string; sessionId: string };
};
export const recentTaskKey = (params: { deviceId?: unknown; sessionId?: unknown }) =>
  JSON.stringify([params.deviceId ?? '', params.sessionId ?? '']);

let recent: RecentTaskRoute[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
export const subscribeRecentTasks = (listener: () => void) => {
  listeners.add(listener); return () => { listeners.delete(listener); };
};
export const getRecentTasks = () => recent;
export function rememberRecentTask(href: RecentTaskRoute) {
  const { deviceId, deviceName, sessionId } = href.params;
  if (!deviceId || !sessionId) return;
  const key = recentTaskKey(href.params);
  if (recentTaskKey(recent.at(-1)?.params ?? {}) === key && recent.at(-1)?.params.deviceName === deviceName) return;
  recent = [...recent.filter(item => recentTaskKey(item.params) !== key), {
    pathname: '/sessions/[sessionId]' as const, params: { deviceId, deviceName, sessionId },
  }].slice(-MAX_RECENT_TASKS);
  emit();
}

subscribeMobileAuthOwner(() => {
  recent = []; emit();
});
