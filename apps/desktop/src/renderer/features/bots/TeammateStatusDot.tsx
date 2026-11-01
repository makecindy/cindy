import { AtSign } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TEAMMATE_AVATAR, type TeammateStatus } from '@cindy/maker-shared/teammate-status';

const COLOR: Record<Exclude<TeammateStatus, 'idle'>, string> = {
  awaiting: 'var(--card-status-awaiting)', error: 'var(--card-status-error)',
  running: 'var(--status-bar-accent)', done: 'var(--card-status-done)', unread: 'var(--bot-unread-bg)',
};

/** Collapsed-strip mention point: the same status color, grown just enough to carry the glyph. */
const MENTION_DOT = TEAMMATE_AVATAR.dot + 4;

/**
 * One fixed solid point, including while running. No changing glyph or outer progress ring.
 * `mentioned` (an unread @ of the user) turns the same point into an @ instead of adding a
 * second mark. Awaiting, error and running keep their color; otherwise the @ reads as unread
 * blue, since a completed reply's green would not say "someone is calling you".
 */
export function TeammateStatusDot({ status, mentioned = false }: { status: TeammateStatus; mentioned?: boolean }) {
  const { t } = useTranslation();
  if (status === 'idle') return null;
  const label = t(`bots.avatarStatus.${status}`);
  const size = (mentioned ? MENTION_DOT : TEAMMATE_AVATAR.dot) + 2 * TEAMMATE_AVATAR.border;
  const color = COLOR[mentioned && status === 'done' ? 'unread' : status];
  return <span role="img" aria-label={label} title={label} data-teammate-status={status}
    data-teammate-mention={mentioned || undefined}
    className="absolute -bottom-px -right-px flex items-center justify-center rounded-full border-solid border-sidebar text-[var(--bot-unread-fg)]"
    style={{ width: size, height: size, borderWidth: TEAMMATE_AVATAR.border, backgroundColor: color }}>
    {mentioned ? <AtSign aria-hidden size={MENTION_DOT - 4} strokeWidth={3} /> : null}
  </span>;
}
