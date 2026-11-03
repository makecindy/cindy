import { resolveRemoteText } from '@cindy/device-link';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';
import type { LastTeammateIdentity } from './homeViewPreferenceStore';
import type { RemoteSession } from './types';

/** Presentation skeleton only; cacheSeeded blocks dispatch until host metadata replaces it. */
export function teammateSessionPreview(hosted: HostedRemoteCollectionItem, userId: string, locale: string): RemoteSession | null {
  const target = hosted.item.links.find(link => link.rel === 'conversation')?.target;
  if (hosted.item.ref.kind !== 'bot' || target?.kind !== 'session' || !target.sessionId) return null;
  return {
    id: target.sessionId, userId, source: 'bot', title: resolveRemoteText(hosted.item.display.title, locale),
    cacheSeeded: true, workingDir: null, workspaceKind: 'dialogue', model: '', effort: '',
    permissionMode: 'ask', fastMode: false, agentKind: 'cc', status: 'active', userSendAt: null,
    createdAt: '', updatedAt: '',
  };
}

export function teammateIdentity(hosted: HostedRemoteCollectionItem): LastTeammateIdentity | null {
  return hosted.item.ref.kind === 'bot' ? {
    deviceId: hosted.host.deviceId, collectionId: hosted.item.ref.collectionId,
    resourceKind: 'bot', resourceId: hosted.item.ref.id,
  } : null;
}
/** `settings` opens the teammate's own settings on that page once its conversation is shown. */
export function teammateResourceRoute(hosted: HostedRemoteCollectionItem, locale: string, settings?: 'capabilities') {
  const conversation = hosted.item.links.find(link => link.rel === 'conversation')?.target;
  // The link is a display/navigation hint only. The destination revalidates the
  // permanent resource before allowing sends, controls or read receipts.
  if (hosted.item.ref.kind === 'bot' && conversation?.kind === 'session') return {
    pathname: '/sessions/[sessionId]' as const,
    params: {
      sessionId: conversation.sessionId,
      deviceId: hosted.host.deviceId, deviceName: hosted.host.deviceName,
      resourceCollectionId: hosted.item.ref.collectionId,
      resourceId: hosted.item.ref.id, resourceKind: hosted.item.ref.kind,
      ...(settings ? { companionSettings: settings } : {}),
    },
  };
  return {
    pathname: '/resources/[collectionId]/[resourceId]' as const,
    params: {
      collectionId: hosted.item.ref.collectionId,
      deviceId: hosted.host.deviceId, deviceName: hosted.host.deviceName,
      resourceId: hosted.item.ref.id, resourceKind: hosted.item.ref.kind,
      title: resolveRemoteText(hosted.item.display.title, locale),
    },
  };
}

/**
 * The read-only cloud view of a companion whose main computer is offline
 * (docs/product-rules/cloud-companions.md §3.1). The row's computer is that main computer.
 */
export function cloudCompanionRoute(hosted: HostedRemoteCollectionItem, actorId: string, locale: string) {
  return {
    pathname: '/companions/cloud/[actorId]' as const,
    params: {
      actorId, botId: hosted.item.ref.id,
      deviceId: hosted.host.deviceId, deviceName: hosted.host.deviceName,
      title: resolveRemoteText(hosted.item.display.title, locale),
    },
  };
}

/**
 * Chat screens of one companion on one computer stacked right under the top route, counted from just below it.
 * The cloud view opened from a chat leaves that chat underneath; once the companion runs elsewhere, back must skip it.
 */
export function staleCompanionChatCount(routes: readonly { name: string; params?: unknown }[], botId: string, deviceId: string): number {
  let count = 0;
  for (let index = routes.length - 2; index >= 0; index--) {
    const route = routes[index]!;
    const params = route.params as { resourceId?: string; deviceId?: string } | undefined;
    if (!['sessions/[sessionId]', 'resources/[collectionId]/[resourceId]'].includes(route.name)
      || params?.resourceId !== botId || params?.deviceId !== deviceId) break;
    count += 1;
  }
  return count;
}

/** Reuse the actual home route; retired collection routes are replaced. */
export function homeDismissCount(routes: readonly { name: string; params?: unknown }[]): number | null {
  for (let index = routes.length - 1; index >= 0; index--) {
    const route = routes[index];
    if (route.name === 'devices/index' || route.name === 'index') return routes.length - 1 - index;
  }
  return null;
}
export function orderedTeammates(items: readonly HostedRemoteCollectionItem[], query: string, locale: string) {
  const needle = query.normalize('NFKC').trim().toLocaleLowerCase(locale);
  const unique = new Map<string, HostedRemoteCollectionItem>();
  for (const row of items) {
    const identity = teammateIdentity(row);
    if (!identity) continue;
    const title = resolveRemoteText(row.item.display.title, locale);
    if (needle && !title.normalize('NFKC').toLocaleLowerCase(locale).includes(needle)) continue;
    unique.set(JSON.stringify(identity), row);
  }
  return [...unique.values()].sort((a, b) => (b.item.display.timestamp ?? 0) - (a.item.display.timestamp ?? 0)
    || a.key.localeCompare(b.key));
}
