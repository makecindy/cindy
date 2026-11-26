import { deriveGhostSessionContext, type InstalledGhost } from '../../shared/ghost.js';
import type { ChangeCheck, ChangeCheckState } from './changeChecksSlot.js';

type Read = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Compatibility with existing read-only tool contracts. No source package update,
 * credential sharing, write command, caller-supplied tool name or arbitrary arguments.
 * Tool output stays inside Main; the requesting plugin receives only a tri-state.
 */
export function legacyChangeCheckSource(ghost: InstalledGhost): 'mail' | 'calendar' | null {
  if (!ghost.enabled || ghost.approval?.state !== 'approved' || ghost.namespace !== null)
    return null;
  const prefix =
    ghost.manifest.id === 'google-gmail'
      ? 'gmail'
      : ghost.manifest.id === 'google-calendar'
        ? 'google_calendar'
        : null;
  if (
    !prefix ||
    ![`${prefix}_accounts`, `${prefix}_run`].every((name) =>
      ghost.manifest.tools?.some((tool) => tool.name === name),
    )
  )
    return null;
  return prefix === 'gmail' ? 'mail' : 'calendar';
}

export async function probeExistingGoogleTools(
  source: 'mail' | 'calendar',
  check: ChangeCheck,
  read: Read,
): Promise<ChangeCheckState> {
  const prefix = source === 'mail' ? 'gmail' : 'google_calendar';
  const accounts = async () => {
    const reply = object(await read(`${prefix}_accounts`, {}));
    const result = reply?.ok === true ? object(reply.result) : null;
    if (!Array.isArray(result?.accounts) || !result.accounts.length || result.accounts.length > 8)
      throw new Error('ACCOUNTS_UNKNOWN');
    return result.accounts
      .map((raw) => {
        const value = object(raw);
        if (typeof value?.id !== 'string' || !value.id || value.status !== 'connected')
          throw new Error('ACCOUNT_UNAVAILABLE');
        return value.id;
      })
      .sort();
  };
  try {
    const before = await accounts();
    let calls = 0;
    const query = async (args: Record<string, unknown>) => {
      if (++calls > 12) throw new Error('CHECK_BUDGET');
      const reply = object(
        await read(`${prefix}_run`, {
          ...args,
          session_context: deriveGhostSessionContext(null, null, null),
        }),
      );
      const data = reply?.ok === true ? object(reply.result) : null;
      if (!data || data.truncated || data.saved_to || data.error || data.errors || data.warnings)
        throw new Error('CHECK_INCOMPLETE');
      return data;
    };
    // Each account asks for at most one index entry. No body/attachment flags, file
    // access, card publication window, model invocation or mutation are granted.
    for (const account of before) {
      if (source === 'calendar') {
        const calendars = await query({ account, command: ['calendars'], options: { max: 10 } });
        if (
          !Array.isArray(calendars.calendars) ||
          typeof calendars.nextPageToken !== 'string' ||
          calendars.nextPageToken
        )
          return 'unknown';
        for (const row of calendars.calendars) {
          const calendar = object(row);
          if (typeof calendar?.id !== 'string' || !calendar.id) return 'unknown';
          const events = await query({
            account,
            command: ['events'],
            arguments: [calendar.id],
            options: {
              from: check.from,
              to: check.to,
              max: 1,
              fields: 'items(id),nextPageToken',
            },
          });
          if (!Array.isArray(events.events) || typeof events.nextPageToken !== 'string')
            return 'unknown';
          if (events.events.length || events.nextPageToken) return 'changed';
        }
        continue;
      }
      const data = await query({
        account,
        command: ['messages', 'search'],
        arguments: [
          // The host cannot assume the consumer applies category or draft filters.
          `after:${Math.floor(Date.parse(check.from) / 1000) - 1} before:${Math.ceil(Date.parse(check.to) / 1000)}`,
        ],
        options: { max: 1 },
      });
      if (!Array.isArray(data.messages) || typeof data.nextPageToken !== 'string') return 'unknown';
      if (data.messages.length || data.nextPageToken) return 'changed';
    }
    return JSON.stringify(await accounts()) === JSON.stringify(before) ? 'unchanged' : 'unknown';
  } catch {
    return 'unknown';
  }
}
