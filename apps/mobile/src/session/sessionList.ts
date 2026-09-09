import { i18n } from '@/i18n';
import { mobilePresentationLocalizer } from '@/i18n/presentationLocalizer';
import {
  buildRemoteSessionCardPreview as buildRemoteSessionCardPreviewShared,
  buildRemoteSessionListContext as buildRemoteSessionListContextShared,
  buildRemoteSessionSections as buildRemoteSessionSectionsShared,
  formatRemoteSessionSidebarTime as formatRemoteSessionSidebarTimeShared,
  type RemoteSessionListContext,
  type RemoteSessionListItem,
  type RemoteSessionListOptions,
  type RemoteSessionOverview,
  type RemoteSessionSection,
  type RemoteSessionStatusFilter,
} from '@cindy/maker-shared/session-list';

export * from '@cindy/maker-shared/session-list';

export function buildRemoteSessionSections(
  sessions: Parameters<typeof buildRemoteSessionSectionsShared>[0],
  now = Date.now(),
  options: RemoteSessionListOptions = {},
): RemoteSessionSection[] {
  return buildRemoteSessionSectionsShared(sessions, now, {
    ...options,
    localizer: mobilePresentationLocalizer,
  }).map((section) => ({
    ...section,
    title: section.key === 'pinned'
      ? i18n.t('devices.presentation.sessionList.section.pinned')
      : section.key === 'dialogue'
        ? i18n.t('devices.presentation.sessionList.section.dialogue')
        : section.title,
    data: section.data.map((item) => localizeRemoteSessionListItem(item, now)),
  }));
}

export function remoteSessionFilterLabel(
  value: RemoteSessionStatusFilter,
  overview: RemoteSessionOverview,
  label = remoteSessionFilterBaseLabel(value),
): string {
  const count = value === 'active'
    ? overview.active
    : value === 'waiting'
      ? overview.waiting
      : value === 'automation'
        ? overview.automation
        : value === 'archived'
          ? overview.archived
          : overview.all;
  return i18n.t('devices.presentation.sessionList.filterWithCount', { label, count });
}

export function remoteSessionFilterBaseLabel(value: RemoteSessionStatusFilter): string {
  return i18n.t(`devices.detail.filter.${value}`);
}

export function remoteSessionControlsSummary(
  statusFilter: RemoteSessionStatusFilter,
  overview: RemoteSessionOverview,
): string {
  return i18n.t('devices.presentation.sessionList.controlsSummary', {
    filter: remoteSessionFilterLabel(statusFilter, overview),
    group: i18n.t('devices.detail.group.project'),
  });
}

export function buildRemoteSessionListContext(input: {
  overview: RemoteSessionOverview;
  searchQuery: string;
  sections: readonly RemoteSessionSection[];
  statusFilter: RemoteSessionStatusFilter;
}): RemoteSessionListContext {
  const base = buildRemoteSessionListContextShared(input);
  const searching = input.searchQuery.trim().length > 0;
  const result = base.resultCount > 0
    ? i18n.t(
        searching
          ? 'devices.presentation.sessionList.context.matchingTasks'
          : 'devices.presentation.sessionList.context.tasks',
        { count: base.resultCount },
      )
    : i18n.t(
        searching
          ? 'devices.presentation.sessionList.context.noMatchingTasks'
          : 'devices.presentation.sessionList.context.noResults',
      );
  const rows = base.rowCount > 0 && base.rowCount !== base.resultCount
    ? i18n.t('devices.presentation.sessionList.context.rows', { count: base.rowCount })
    : '';
  return {
    ...base,
    detail: i18n.t('devices.presentation.sessionList.context.detail', {
      result,
      rows,
      filter: remoteSessionFilterLabel(input.statusFilter, input.overview),
      group: i18n.t('devices.detail.group.project'),
    }),
    hint: sessionListHint(input.statusFilter, searching),
    title: searching
      ? i18n.t('devices.presentation.sessionList.context.searchResults')
      : i18n.t(`devices.presentation.sessionList.context.title.${input.statusFilter}`),
  };
}

export function deviceSessionEmptyState(
  statusFilter: RemoteSessionStatusFilter,
  searchQuery: string,
): { title: string; copy: string } {
  const kind = searchQuery.trim()
    ? 'search'
    : statusFilter === 'waiting'
      ? 'waiting'
      : statusFilter === 'automation'
        ? 'automation'
        : statusFilter === 'archived'
          ? 'archived'
          : 'active';
  return {
    title: i18n.t(`devices.presentation.sessionList.empty.${kind}.title`),
    copy: i18n.t(`devices.presentation.sessionList.empty.${kind}.copy`),
  };
}

export function buildRemoteSessionCardPreview(
  item: RemoteSessionListItem,
  options: { running?: boolean } = {},
): string | null {
  return buildRemoteSessionCardPreviewShared(item, {
    ...options,
    localizer: mobilePresentationLocalizer,
  });
}

export function formatRemoteSessionSidebarTime(iso: string | undefined, now = Date.now()): string {
  return formatRemoteSessionSidebarTimeShared(iso, now, mobilePresentationLocalizer);
}

export function localizeRemoteSessionListItem(
  item: RemoteSessionListItem,
  now = Date.now(),
): RemoteSessionListItem {
  const collaboration = collaborationLabel(item.session.orcaRole);
  const agent = item.session.agentKind === 'codex'
    ? 'Codex'
    : item.session.agentKind === 'pi'
      ? 'Pi'
      : 'Claude Code';
  const localizedItems = item.automationGroup?.items.map((member) => localizeRemoteSessionListItem(member, now));
  const localizedChildren = localizedItems?.map((member) => ({
    sessionId: member.session.id,
    title: member.title,
    subtitle: member.subtitle,
    detail: member.detail,
    pendingInteractionCount: member.pendingInteractionCount,
    running: !!member.scheduleInfo?.running,
    unreadCount: member.scheduleInfo?.unreadCount ?? 0,
  }));
  const isGroup = !!item.automationGroup;
  const sessionCount = item.automationGroup?.sessionCount ?? 1;
  const subtitle = isGroup
    ? [
        i18n.t('devices.presentation.sessionList.automation'),
        i18n.t('devices.presentation.sessionList.sessionCount', { count: sessionCount }),
        item.worktreeLabel,
        agent,
        item.session.model,
      ]
    : [
        collaboration,
        item.worktreeLabel,
        agent,
        item.session.model,
        isDialogue(item.session) ? i18n.t('devices.list.a11y.dialogue') : null,
      ];
  const detail = [
    ...(isGroup
      ? [i18n.t('devices.presentation.sessionList.sessionCount', { count: sessionCount })]
      : [sessionStatusLabel(item.session.status)]),
    relativeActivity(item.lastActivityAt, now),
    item.scheduleInfo?.running ? i18n.t('devices.presentation.sessionList.preview.automationRunning') : null,
    item.scheduleInfo && item.scheduleInfo.unreadCount > 0
      ? i18n.t('devices.detail.badge.unread', { count: item.scheduleInfo.unreadCount })
      : null,
    item.pendingInteractionCount > 0
      ? i18n.t('devices.detail.badge.waiting', { count: item.pendingInteractionCount })
      : null,
    !isGroup && typeof item.session._count?.messages === 'number'
      ? i18n.t('devices.presentation.sessionList.messageCount', { count: item.session._count.messages })
      : null,
  ].filter(Boolean).join(' · ');
  return {
    ...item,
    subtitle: subtitle.filter(Boolean).join(' · '),
    detail,
    automationGroup: item.automationGroup
      ? {
          ...item.automationGroup,
          items: localizedItems ?? [],
          children: localizedChildren ?? [],
        }
      : undefined,
  };
}

function sessionStatusLabel(status: string): string {
  if (status === 'active') return i18n.t('devices.detail.filter.active');
  if (status === 'archived') return i18n.t('devices.presentation.sessionList.status.archived');
  return i18n.t('devices.presentation.sessionList.status.deleted');
}

function collaborationLabel(role: string | null | undefined): string | null {
  if (role === 'lead') return i18n.t('session.presentation.collaboration.labelLead');
  if (role === 'worker') return i18n.t('session.presentation.collaboration.labelWorker');
  return role?.trim()
    ? i18n.t('session.presentation.collaboration.labelRole', { role: role.trim() })
    : null;
}

function isDialogue(session: RemoteSessionListItem['session']): boolean {
  return session.workspaceKind === 'dialogue' || !session.workingDir;
}

function relativeActivity(iso: string, now: number): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return i18n.t('devices.presentation.sessionList.time.unknown');
  const diffMinutes = Math.max(0, Math.floor((now - ts) / 60_000));
  if (diffMinutes < 1) return i18n.t('devices.presentation.sessionList.time.justNow');
  if (diffMinutes < 60) return i18n.t('devices.presentation.sessionList.time.minutesAgo', { count: diffMinutes });
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return i18n.t('devices.presentation.sessionList.time.hoursAgo', { count: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return i18n.t('devices.presentation.sessionList.time.daysAgo', { count: diffDays });
  return new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language).format(new Date(ts));
}

function sessionListHint(statusFilter: RemoteSessionStatusFilter, searching: boolean): string {
  if (searching) return i18n.t('devices.presentation.sessionList.context.hint.search');
  return i18n.t(`devices.presentation.sessionList.context.hint.${statusFilter}`);
}
