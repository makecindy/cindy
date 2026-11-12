import type { ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { NavigationCountBadge } from '@/components/sidebar/NavigationCountBadge';
import { TEAMMATE_AVATAR, type TeammateStatus } from '@cindy/maker-shared/teammate-status';

const COLOR: Record<Exclude<TeammateStatus, 'idle'>, string> = {
  awaiting: 'var(--card-status-awaiting)',
  error: 'var(--card-status-error)',
  running: 'var(--warning-accent)',
  done: 'var(--card-status-done)',
  unread: 'var(--card-status-done)',
};

export function TeammateStatusDot({ status, mentioned = false, inline = false, group = false }: {
  status: TeammateStatus; mentioned?: boolean; inline?: boolean; group?: boolean;
}) {
  const { t } = useTranslation();
  if (status === 'idle') return null;
  const label = [t(`bots.avatarStatus.${status}`), ...(mentioned ? [t('bots.groupChat.server.thread.hintMentioned')] : [])].join(' · ');
  const size = inline ? 16 : TEAMMATE_AVATAR.dot + 2 * TEAMMATE_AVATAR.border;
  const coreSize = inline ? 8 : TEAMMATE_AVATAR.dot;
  const groupUnread = group && (status === 'unread' || (status === 'done' && mentioned));
  return <span role="img" aria-label={label} title={label} data-teammate-status={status} data-teammate-mention={mentioned || undefined}
    className={cn('inline-flex shrink-0 items-center justify-center rounded-full',
      !inline && 'absolute -bottom-px -right-px bg-sidebar')}
    style={{ width: size, height: size }}>
    <span aria-hidden className={cn('rounded-full', status === 'running' && 'session-status-breathing')}
      style={{ width: coreSize, height: coreSize, backgroundColor: groupUnread ? 'var(--bot-unread-bg)' : COLOR[status] }} />
  </span>;
}

/** Place in the subtitle flex row (or its grid cell) to align with text without changing row geometry. */
export function TeammateRowStatus({ status, groupUnread, mentioned = false, inline = false }: {
  status: TeammateStatus; groupUnread?: number; mentioned?: boolean; inline?: boolean;
}) {
  const { t } = useTranslation();
  // Running is shown in the subtitle; group unread counts remain independent.
  if (status === 'idle' || (status === 'running' && !groupUnread)) return null;
  const messageState = status === 'done' || status === 'unread';
  const blueCount = messageState && mentioned;
  return <span data-teammate-row-status className={cn('pointer-events-none flex h-4 items-center justify-end', !inline && 'absolute right-2.5')}>
    {groupUnread !== undefined && (status === 'running' || status === 'unread' || blueCount) ? (
      <span data-teammate-unread-count data-teammate-mention={blueCount || undefined}>
        <NavigationCountBadge count={groupUnread} label={[t('sidebar.teammateUnreadCount', { count: groupUnread }), ...(blueCount ? [t('bots.groupChat.server.thread.hintMentioned')] : [])].join(' · ')}
          className={blueCount ? 'bg-[var(--bot-unread-bg)] text-[var(--bot-unread-fg)]' : undefined} />
      </span>
    ) : <TeammateStatusDot status={status} group={groupUnread !== undefined} mentioned={mentioned} inline />}
  </span>;
}

export function TeammateRunningPreview({ children }: { children: ReactNode }) {
  return <span data-teammate-running-preview className="flex min-w-0 flex-1 items-center gap-1 text-12 leading-4 text-[var(--status-bar-accent)]">
    <span aria-hidden className="session-status-breathing inline-flex shrink-0"><Sparkles size={11} /></span>
    <span className="min-w-0 flex-1 truncate">{children}</span>
  </span>;
}
