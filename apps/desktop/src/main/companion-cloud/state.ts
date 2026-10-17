/**
 * Owner-scoped sync bookkeeping for one account + Chat Server endpoint: room ids,
 * mirror cursors and uploaded preference hashes. Never authoritative data; losing
 * it only costs a re-check against the server.
 */
import { z } from 'zod';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import type { CompanionLog } from './types.js';

const pref = z.object({
  hash: z.string(),
  revision: z.number().int().nonnegative(),
  /**
   * This device had exactly this value locally (uploaded it, or applied it while taking over).
   * Only such keys may be tombstoned by the uploader or deleted locally by a cloud tombstone;
   * keys that merely exist on the server never are.
   */
  local: z.boolean().optional(),
});
const bot = z.object({
  actorId: z.string(),
  roomId: z.string().optional(),
  /** Last canonical message handed to the room, ordered by (createdAt, id). */
  mirror: z.object({
    sessionId: z.string(), createdAt: z.number(), id: z.string(),
    /** Recently imported local message ids, so the trailing re-scan does not re-send them. */
    recent: z.array(z.string()).optional(),
  }).optional(),
  /**
   * Older history of the Session (before the mirror cursor) uploaded so far, so the room holds the
   * whole conversation, not only what happened since mirroring began. Rows strictly after it, up to
   * the mirror cursor, are still to go; `done` once it reached the cursor.
   */
  backfill: z.object({ sessionId: z.string(), createdAt: z.number(), id: z.string(), done: z.boolean().optional() }).optional(),
  prefs: z.record(z.string(), pref).default({}),
  /** Revisions were read back from the server once (after a fresh or lost state file). */
  prefsSeeded: z.boolean().optional(),
  /** This computer gave the companion away; never re-register it as home here. */
  demoted: z.boolean().optional(),
  /** Cloud history was added while the canonical Session was busy; rebuild at the next idle point. */
  pendingRebuild: z.boolean().optional(),
  /** The never-synced local copy was backed up before a take-over; retries do not back it up again. */
  backedUp: z.boolean().optional(),
  /** Deleted here while this computer was the home; disable the cloud actor until it succeeds. */
  retirePending: z.boolean().optional(),
});
const file = z.object({ version: z.literal(1), bots: z.record(z.string(), bot) });

export type CompanionBotState = z.infer<typeof bot>;

export interface CompanionCloudStateIo {
  read: (filePath: string) => string | null;
  write: (filePath: string, contents: string) => void;
}

const defaultIo: CompanionCloudStateIo = { read: readAtomicFileSync, write: atomicWriteFileSync };

export function createCompanionCloudState(options: {
  filePath: string;
  current?: () => boolean;
  log?: CompanionLog;
  io?: CompanionCloudStateIo;
}) {
  const io = options.io ?? defaultIo;
  let data: z.infer<typeof file> | undefined;
  const load = () => {
    if (data) return data;
    try {
      const raw = io.read(options.filePath);
      data = raw ? file.parse(JSON.parse(raw)) : { version: 1, bots: {} };
    } catch (error) {
      // A damaged bookkeeping file must never stop chat; start over and re-check.
      options.log?.warn('Companion sync state unreadable; starting empty', { error: error instanceof Error ? error.name : 'UNKNOWN' });
      data = { version: 1, bots: {} };
    }
    return data;
  };
  return {
    bot: (botId: string): CompanionBotState | null => load().bots[botId] ?? null,
    isDemoted: (botId: string) => load().bots[botId]?.demoted === true,
    demotedBotIds: (): string[] => Object.entries(load().bots).flatMap(([botId, entry]) => entry.demoted ? [botId] : []),
    botForRoom: (roomId: string): string | null =>
      Object.entries(load().bots).find(([, entry]) => entry.roomId === roomId)?.[0] ?? null,
    /**
     * Mutate one companion's entry and persist atomically. The new state applies in this run even
     * when the disk write fails (e.g. a full disk): a demotion must never wait on it. Every update
     * writes the whole file, so the next one retries the lost write.
     */
    update(botId: string, actorId: string, mutate: (entry: CompanionBotState) => void): CompanionBotState {
      if (options.current && !options.current()) throw new Error('OWNER_CHANGED');
      const state = load();
      const previous = state.bots[botId];
      // A different actor for the same local id is a different cloud companion.
      const entry: CompanionBotState = previous && previous.actorId === actorId
        ? structuredClone(previous) : { actorId, prefs: {} };
      mutate(entry);
      const next = { ...state, bots: { ...state.bots, [botId]: bot.parse(entry) } };
      data = next;
      try {
        io.write(options.filePath, JSON.stringify(next));
      } catch (error) {
        options.log?.warn('Companion sync state not saved; will retry', { code: (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN' });
      }
      return next.bots[botId]!;
    },
  };
}

export type CompanionCloudState = ReturnType<typeof createCompanionCloudState>;
