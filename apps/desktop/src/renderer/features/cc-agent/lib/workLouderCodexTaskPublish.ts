import {
  WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
  WORKLOUDER_CODEX_TASK_OPTION_LIMIT,
  type WorkLouderCodexPublishedTask,
} from '../../../../shared/workLouderCodex';
import type { Session } from '@/lib/ccAgent.types';

export type WorkLouderCodexPublishSession = Pick<
  Session,
  'id' | 'title' | 'pinnedAt' | 'userSendAt' | 'status' | 'deviceLinkDeviceId'
>;

/**
 * Build the keyboard's task rows without letting a large local catalog starve
 * the remote tasks that share the same MACHINE_ALL scope.
 */
export function buildWorkLouderCodexPublishedTasks(
  sessionsWithRemote: readonly WorkLouderCodexPublishSession[],
  visibleSessionsWithRemote: readonly WorkLouderCodexPublishSession[],
  renderedIds: readonly string[],
): WorkLouderCodexPublishedTask[] {
  const sidebarOrder = new Map(renderedIds.map((id, index) => [id, index] as const));
  const catalogSessions = sessionsWithRemote.filter((session) => session.status === 'active');
  const catalogSessionIds = new Set(catalogSessions.map((session) => session.id));
  const visibleProjection = visibleSessionsWithRemote
    .filter((session) => !catalogSessionIds.has(session.id))
    .slice(0, WORKLOUDER_CODEX_AGENT_SLOT_COUNT);
  const remainingCatalogSlots = Math.max(
    0,
    WORKLOUDER_CODEX_TASK_OPTION_LIMIT - visibleProjection.length,
  );
  const remoteCatalogSessions = catalogSessions.filter((session) =>
    Boolean(session.deviceLinkDeviceId),
  );
  const localCatalogSessions = catalogSessions.filter(
    (session) => !session.deviceLinkDeviceId,
  );
  // The board has six Agent slots. Reserve those slots for remote rows so a
  // large local catalog cannot consume the whole IPC allowance first.
  const remoteQuota = Math.min(
    remoteCatalogSessions.length,
    WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
  );
  const localQuota = Math.max(0, remainingCatalogSlots - remoteQuota);
  const publishedCatalog = [
    ...localCatalogSessions.slice(0, localQuota),
    ...remoteCatalogSessions.slice(0, remoteQuota),
  ];

  return [...visibleProjection, ...publishedCatalog].map((session) => {
    const pinnedAtMs = session.pinnedAt ? Date.parse(session.pinnedAt) : Number.NaN;
    const userSendAtMs = session.userSendAt ? Date.parse(session.userSendAt) : Number.NaN;
    const order = sidebarOrder.get(session.id);
    const isActiveCatalog = session.status === 'active';
    return {
      id: session.id,
      title: session.title ?? null,
      pinnedAt: Number.isFinite(pinnedAtMs) ? pinnedAtMs : null,
      userSendAt: Number.isFinite(userSendAtMs) ? userSendAtMs : null,
      ...(order === undefined ? {} : { sidebarOrder: order }),
      ...(isActiveCatalog ? {} : { catalogEligible: false }),
    };
  });
}
