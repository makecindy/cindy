import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { TEAMMATE_AVATAR, type TeammateStatus } from '@cindy/maker-shared/teammate-status';

const COLOR: Record<Exclude<TeammateStatus, 'idle'>, string> = {
  awaiting: 'var(--card-status-awaiting)', error: 'var(--card-status-error)',
  running: 'var(--warning-accent)', done: 'var(--card-status-done)', unread: 'var(--card-status-done)',
};

/** Selection never changes status color. Read acknowledgements clear unread in the roster. */
export function TeammateStatusDot({ status, mentioned = false, inline = false }: {
  status: TeammateStatus; mentioned?: boolean; inline?: boolean;
}) {
  const { t } = useTranslation();
  if (status === 'idle') return null;
  const label = [t(`bots.avatarStatus.${status}`), ...(mentioned ? [t('bots.groupChat.server.thread.hintMentioned')] : [])].join(' · ');
  return <span role="img" aria-label={label} title={label} data-teammate-status={status} data-teammate-mention={mentioned || undefined}
    className={cn('inline-flex shrink-0 items-center justify-center rounded-full',
      !inline && 'absolute -bottom-px -right-px bg-sidebar')}
    style={{ width: inline ? 16 : TEAMMATE_AVATAR.dot + 2 * TEAMMATE_AVATAR.border, height: inline ? 16 : TEAMMATE_AVATAR.dot + 2 * TEAMMATE_AVATAR.border }}>
    <span aria-hidden className={cn('rounded-full', status === 'running' && 'session-status-breathing')}
      style={{ width: inline ? 8 : TEAMMATE_AVATAR.dot, height: inline ? 8 : TEAMMATE_AVATAR.dot, backgroundColor: COLOR[status] }} />
  </span>;
}

/** Trailing state overlay preserves the main row geometry and time-column width. */
export function TeammateRowStatus({ status }: { status: TeammateStatus }) {
  // Expanded rows already communicate running through their subtitle.
  if (status === 'idle' || status === 'running') return null;
  return <span data-teammate-row-status className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
    <TeammateStatusDot status={status} inline />
  </span>;
}
