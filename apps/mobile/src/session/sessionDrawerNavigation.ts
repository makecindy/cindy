import type { useRouter } from 'expo-router';
import { deviceDisplayName } from '@/device-link/deviceName';
import type { RemoteSessionListItem } from './sessionList';
import type { RemoteSession } from './types';

export interface SessionDrawerRouteTarget {
  taskListEntry?: 'sidebar';
  sessionEntry?: 'taskList';
  deviceId: string;
  deviceName: string;
  sessionId: string;
  focusClientId?: string;
  companionSettings?: 'capabilities';
  resourceCollectionId?: string;
  resourceKind?: string;
  resourceId?: string;
  resourceHistorySessionId?: string;
}

export interface SessionRouteParamsNavigation {
  replaceParams(params: SessionDrawerRouteTarget): void;
}

/**
 * 在当前 Session 原生 Screen 内切换任务。
 *
 * `router.replace('/sessions/[sessionId]')` 会派发 NativeStack REPLACE，Android 上既会
 * 创建新的 route key，也会触发原生 Screen 的替换生命周期；宽屏抽屉的真实崩溃/白屏
 * 都发生在这条路径上。SessionScreen 本身已经按 sessionId 做换代与异步结果隔离，因此
 * 这里只替换当前 route 的完整 params：不创建新 Screen，也不会把旧任务的 draft / goal /
 * focus 等一次性参数合并进目标任务。
 */
export function switchDrawerSessionInPlace(
  navigation: SessionRouteParamsNavigation,
  target: SessionDrawerRouteTarget,
  fromTaskList = true,
): void {
  navigation.replaceParams({
    deviceId: target.deviceId,
    deviceName: target.deviceName,
    sessionId: target.sessionId,
    ...(fromTaskList ? { sessionEntry: 'taskList' as const } : {}),
    ...(target.taskListEntry ? { taskListEntry: target.taskListEntry } : {}),
    ...(target.focusClientId ? { focusClientId: target.focusClientId } : {}),
    ...(target.resourceId ? {
      resourceCollectionId: target.resourceCollectionId,
      resourceKind: target.resourceKind,
      resourceId: target.resourceId,
      resourceHistorySessionId: target.resourceHistorySessionId,
      ...(target.companionSettings ? { companionSettings: target.companionSettings } : {}),
    } : {}),
  });
}

/** All task-list presentations resolve canonical hosts and search focus equally.
 * Lookup is injected so this policy does not own subscriptions or a store. */
export function taskListSessionTarget(
  item: RemoteSessionListItem,
  findDevice: (sessionId: string) => string | null | undefined,
): SessionDrawerRouteTarget | null {
  const session = item.session as RemoteSession;
  const deviceId = session.canonicalDeviceId ?? session.deviceLinkDeviceId ?? findDevice(session.id);
  if (!deviceId) return null;
  const focusClientId = 'searchFocusClientId' in item
    ? (item as { searchFocusClientId?: string }).searchFocusClientId : undefined;
  return {
    deviceId,
    deviceName: deviceDisplayName(deviceId, session.deviceLinkDeviceName),
    sessionId: session.id,
    ...(focusClientId ? { focusClientId } : {}),
  };
}

/** A drill-down keeps its source task and hands a portrait right swipe to Back.
 * List selection uses replaceParams instead, clearing this entry mode. */
export function pushSessionDrillDown(
  router: Pick<ReturnType<typeof useRouter>, 'push'>,
  params: SessionDrawerRouteTarget & { focusRequestKey?: string },
): void {
  router.push({
    pathname: '/sessions/[sessionId]',
    params: { ...params, sessionEntry: 'drillDown' },
  }, { dangerouslySingular: () => undefined });
}

/** The stack owns drill-down history, including routes pushed by embedded cards.
 * An in-place list selection explicitly ends that drill-down on this screen. */
export function sessionSwipeReturnsToSource(
  state: { routes: readonly { key: string; name: string; params?: object }[] },
  routeKey: string,
): boolean {
  const index = state.routes.findIndex(route => route.key === routeKey);
  if (index <= 0) return false;
  const params = state.routes[index].params as { sessionEntry?: string } | undefined;
  if (params?.sessionEntry === 'taskList') return false;
  const source = state.routes[index - 1].name;
  return source !== 'index' && source !== 'devices/index' && source !== 'devices/[deviceId]';
}
