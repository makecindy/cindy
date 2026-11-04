import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { NavigationCountBadge } from '@/components/sidebar/NavigationCountBadge';
import { TEAMMATE_AVATAR, type TeammateStatus } from '@cindy/maker-shared/teammate-status';

const COLOR: Record<Exclude<TeammateStatus, 'idle'>, string> = {
  awaiting: 'var(--card-status-awaiting)', error: 'var(--card-status-error)',
  running: 'var(--warning-accent)', done: 'var(--card-status-done)', unread: 'var(--card-status-done)',
};

/** Selection never changes status color. Read acknowledgements clear unread in the roster. */
export function TeammateStatusDot({ status, mentioned = false, inline = false, group = false }: {
  status: TeammateStatus; mentioned?: boolean; inline?: boolean; group?: boolean;
}) {
  const { t } = useTranslation();
  const messageState = status === 'done' || status === 'unread';
  if (status === 'idle' || (group && messageState && !mentioned)) return null;
  const label = [t(`bots.avatarStatus.${status}`), ...(mentioned ? [t('bots.groupChat.server.thread.hintMentioned')] : [])].join(' · ');
  return <span role="img" aria-label={label} title={label} data-teammate-status={status} data-teammate-mention={mentioned || undefined}
    className={cn('inline-flex shrink-0 items-center justify-center rounded-full',
      !inline && 'absolute -bottom-px -right-px bg-sidebar')}
    style={{ width: inline ? 16 : TEAMMATE_AVATAR.dot + 2 * TEAMMATE_AVATAR.border, height: inline ? 16 : TEAMMATE_AVATAR.dot + 2 * TEAMMATE_AVATAR.border }}>
    <span aria-hidden className={cn('rounded-full', status === 'running' && 'session-status-breathing')}
      style={{ width: inline ? 8 : TEAMMATE_AVATAR.dot, height: inline ? 8 : TEAMMATE_AVATAR.dot, backgroundColor: group && messageState ? 'var(--bot-unread-bg)' : COLOR[status] }} />
  </span>;
}

/** Trailing state sits below the timestamp, preserving the main row geometry and time-column width. */
export function TeammateRowStatus({ status, groupUnread, mentioned = false }: {
  status: TeammateStatus; groupUnread?: number; mentioned?: boolean;
}) {
  const { t } = useTranslation();
  // Expanded rows already communicate running through their subtitle.
  if (status === 'idle' || status === 'running') return null;
  return <span data-teammate-row-status className="pointer-events-none absolute bottom-2.5 right-2.5 flex h-4 items-center justify-end">
    {groupUnread !== undefined && (status === 'done' || status === 'unread') && !mentioned ? (
      <span data-teammate-unread-count>
        <NavigationCountBadge count={groupUnread} label={t('sidebar.teammateUnreadCount', { count: groupUnread })} />
      </span>
    ) : <TeammateStatusDot status={status} group={groupUnread !== undefined} mentioned={mentioned} inline />}
  </span>;
}
