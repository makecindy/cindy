import { resolveRemoteText } from '@cindy/device-link';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';
import type { LastTeammateIdentity } from './homeViewPreferenceStore';

export function teammateIdentity(hosted: HostedRemoteCollectionItem): LastTeammateIdentity | null {
  return hosted.item.ref.kind === 'bot' ? {
    deviceId: hosted.host.deviceId, collectionId: hosted.item.ref.collectionId,
    resourceKind: 'bot', resourceId: hosted.item.ref.id,
  } : null;
}
export function sameTeammate(a: LastTeammateIdentity | null, b: LastTeammateIdentity | null): boolean {
  return !!a && !!b && a.deviceId === b.deviceId && a.collectionId === b.collectionId
    && a.resourceKind === b.resourceKind && a.resourceId === b.resourceId;
}
/** Never guess the default from a display name or use another teammate when the saved one is gone. */
export function findLastTeammate(last: LastTeammateIdentity | null, items: readonly HostedRemoteCollectionItem[]) {
  return items.find((item) => sameTeammate(last, teammateIdentity(item))) ?? null;
}
export function teammateResourceRoute(hosted: HostedRemoteCollectionItem, locale: string) {
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

/** Reuse the actual home route, including legacy collection entry points. */
export function homeDismissCount(routes: readonly { name: string; params?: unknown }[], mode: string): number | null {
  for (let index = routes.length - 1; index >= 0; index--) {
    const route = routes[index];
    if (route.name === 'devices/index' || route.name === 'index'
      || (mode === 'teammates' && route.name === 'resources/[collectionId]'
        && (route.params as { collectionId?: string } | undefined)?.collectionId === 'teammates')) return routes.length - 1 - index;
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
  return [...unique.values()].sort((a, b) => (b.item.display.timestamp ?? 0) - (a.item.display.timestamp ?? 0));
}
