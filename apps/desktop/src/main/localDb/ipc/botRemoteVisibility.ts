/** Hidden and archived companions are recoverable through the local Desktop only. */
export function isBotVisibleRemotely(profile: { hiddenAt: number | null; status: string }): boolean {
  return !profile.hiddenAt && profile.status !== 'archived';
}

/** Host-owned SQL scope, applied before history ranking, limits and pagination. */
export function remoteVisibleSessionSql(alias: 'sessions' | 's'): string {
  return `(${alias}.source <> 'bot' OR EXISTS (
    SELECT 1 FROM bot_session_links AS remote_link
    JOIN bot_profiles AS remote_bot ON remote_bot.id = remote_link.bot_id
    WHERE remote_link.session_id = ${alias}.id
      AND (remote_bot.hidden_at IS NULL OR remote_bot.hidden_at = 0)
      AND remote_bot.status IS NOT NULL AND remote_bot.status <> ''
      AND remote_bot.status <> 'archived'
  ))`;
}
