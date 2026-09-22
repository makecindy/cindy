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
