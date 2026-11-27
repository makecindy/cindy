import type { NavigationState } from 'expo-router/react-navigation';
import type { SessionDrawerRouteTarget } from './sessionDrawerNavigation';
import type { Href } from 'expo-router';

/** Navigation presentation only. Never part of chat identity or resource authority. */
export type TaskListEntryParams = { taskListEntry?: 'sidebar' };

export function taskListEntryParams(params: unknown): TaskListEntryParams {
  return params && typeof params === 'object' && 'taskListEntry' in params && params.taskListEntry === 'sidebar'
    ? { taskListEntry: 'sidebar' } : {};
}

/** Include the legacy/no-session-link resolver: it is one step of opening a teammate. */
function taskListConversationKind(href: Href): 'session' | 'group' | 'cloud' | 'resolver' | null {
  if (typeof href !== 'object' || !href.params) return null;
  const params = href.params;
  const has = (key: string) => typeof params[key] === 'string' && !!params[key];
  switch (href.pathname) {
    case '/sessions/[sessionId]': return has('sessionId') && has('deviceId') ? 'session' : null;
    case '/companions/groups/[groupId]': return has('groupId') && !params.threadRootId ? 'group' : null;
    case '/companions/cloud/[actorId]': return has('actorId') ? 'cloud' : null;
    case '/resources/[collectionId]/[resourceId]':
      return params.resourceKind === 'bot' && has('collectionId') && has('resourceId') && has('deviceId') ? 'resolver' : null;
    default: return null;
  }
}

export function isTaskListConversation(href: Href): boolean {
  return taskListConversationKind(href) !== null;
}

export function taskListDestination(href: Href, sidebar: boolean): Href {
  if (!sidebar || !isTaskListConversation(href) || typeof href !== 'object') return href;
  return { ...href, params: { ...href.params, taskListEntry: 'sidebar' } } as Href;
}

/** Destination keeps its policy after root `state` settles, before native mounting finishes. */
export function taskListScreenAnimation(params: unknown, preparing = false): 'none' | 'default' {
  return preparing || taskListEntryParams(params).taskListEntry === 'sidebar' ? 'none' : 'default';
}

/** A resolver forwards only presentation, never stale identity or one-shot chat parameters. */
export function inheritTaskListEntry(destination: Href, sourceParams: unknown): Href {
  if (typeof destination !== 'object') return destination;
  return { ...destination, params: { ...destination.params, ...taskListEntryParams(sourceParams) } } as Href;
}

/** Restrict reuse to complete session destinations, preserving resource validation params. */
export function drawerConversationTarget(href: Href): SessionDrawerRouteTarget | null {
  if (typeof href !== 'object' || taskListConversationKind(href) !== 'session') return null;
  const params = href.params as Record<string, unknown> | undefined;
  if (!params || typeof params.sessionId !== 'string' || !params.sessionId
    || typeof params.deviceId !== 'string' || !params.deviceId) return null;
  // Unknown one-shot entry modes must keep their normal navigation semantics.
  const keys = ['sessionId', 'deviceId', 'deviceName', 'focusClientId', 'resourceCollectionId',
    'resourceKind', 'resourceId', 'resourceHistorySessionId', 'companionSettings', 'taskListEntry'];
  if (Object.keys(params).some(key => !keys.includes(key))) return null;
  if (Object.values(params).some(value => value !== undefined && typeof value !== 'string')) return null;
  if (params.taskListEntry !== undefined && params.taskListEntry !== 'sidebar') return null;
  if (params.companionSettings !== undefined && params.companionSettings !== 'capabilities') return null;
  return { ...params, deviceName: typeof params.deviceName === 'string' ? params.deviceName : '' } as SessionDrawerRouteTarget;
}

let drawerRouteSequence = 0;

/** Return to an existing conversation without reordering native screens. Fabric
 * snapshots a screen removed for a move; pushing that same key to the top can
 * leave a frozen screenshot. Preserve the destination's position, replacing its
 * params and dismissing only the routes above it, like an ordinary back action.
 * A task opened above a group gets a new route shell; its message list is already
 * retained separately. This keeps the group alive for the next quick switch.
 * Only Home calls this: message links retain their normal push semantics. */
export function existingDrawerConversationState(state: NavigationState | undefined, href: Href): NavigationState | null {
  if (!state || state.type !== 'stack' || typeof href !== 'object') return null;
  const kind = taskListConversationKind(href);
  if (!kind || kind === 'resolver' || kind === 'session' && !drawerConversationTarget(href)) return null;
  const params = href.params!;
  const name = href.pathname.slice(1);
  const sessionKey = (value: { deviceId?: unknown; sessionId?: unknown }) => JSON.stringify([value.deviceId, value.sessionId]);
  const routes = state.routes.slice(0, state.index + 1);
  // A top-level group/cloud route owns a reusable native shell. Its keyed child
  // resets content and async authority when identity changes. Do not stack a new
  // shell for every peer, or reuse a thread route for a top-level destination.
  const index = routes.findLastIndex(route => route.name === name && (
    kind === 'cloud' || kind === 'group' && !(route.params as { threadRootId?: string })?.threadRootId
      || kind === 'session' && sessionKey(route.params ?? {}) === sessionKey(params)));
  if (index < 0) return null;
  if (kind === 'session' && index < state.index) {
    // Keep the group screen below the new task so returning to it preserves its
    // timeline, draft and scroll. Do not PUSH an existing task key: Fabric would
    // snapshot that screen while moving it. RESET with a fresh key appends a
    // task shell without moving any of the retained screens.
    const routeKey = `${name}-drawer-${Date.now().toString(36)}-${++drawerRouteSequence}`;
    return { ...state, index: routes.length,
      routes: [...routes, { key: routeKey, name, params }] };
  }
  return { ...state, index, routes: [...routes.slice(0, index), { ...routes[index], params }] };
}
