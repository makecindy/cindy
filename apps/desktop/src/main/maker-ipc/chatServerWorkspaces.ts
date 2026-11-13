/**
 * What this computer keeps for a chat server's groups: project choices and prepared workspaces, the
 * task cards it posted, and each group's Cindy task. Device-local; never shared chat state.
 */
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
const workspace = z.object({ workDir: z.string(), branch: z.string().nullable(), ownerSessionId: z.string().nullable() });
// autoContinue: 分工 started here (startedHere, the latest 50) go on to the next step by themselves (bot-group-chat.md §7.4).
const record = z.object({ projectDir: z.string().nullable(), plans: z.record(z.string(), workspace), autoContinue: z.boolean().optional(),
  startedHere: z.array(z.string()).max(50).optional(),
  // Successful attachment progress belongs to the exact authorization/Thread Session.
  // Optional for existing files; sequence strings must remain precise beyond Number.MAX_SAFE_INTEGER.
  attachmentAfter: z.record(z.string(), z.string().regex(/^\d+$/)).optional() });
export function chatServerWorkspaces(endpoint: string, actorId: string, current: () => boolean) {
  const root = ownerScopedUserDataPath('chat-workspace-settings', createHash('sha256').update(`${endpoint}\n${actorId}`).digest('hex'));
  const file = (room: string) => path.join(root, `${z.string().uuid().parse(room)}.json`);
  const check = () => { if (!current()) throw new Error('OWNER_CHANGED'); };
  return {
    read(room: string): z.infer<typeof record> | null {
      check(); const raw = readAtomicFileSync(file(room));
      return raw ? record.parse(JSON.parse(raw)) : null;
    },
    save(room: string, value: z.infer<typeof record>) {
      check(); mkdirSync(root, { recursive: true, mode: 0o700 });
      atomicWriteFileSync(file(room), JSON.stringify(record.parse(value)));
    },
  };
}

const quote = z.object({ messageId: z.string().uuid(), authorName: z.string(), authorKind: z.enum(['user', 'bot']), excerpt: z.string(),
  attachmentCount: z.number().int().nonnegative(), attachmentName: z.string().nullable(), sequence: z.number().int().positive().nullable() });
const liveTaskCard = z.object({
  /** Where the card is: the group, the teammate it was posted as, and the Thread it was posted in (null: the main group). */
  roomId: z.string().uuid(), botId: z.string().uuid(), threadRootId: z.string().uuid().nullable(),
  /** The card as last posted. `summary` is the line after its state. */
  taskId: z.string(), deviceId: z.string().nullable(), title: z.string(), requesterName: z.string(), botName: z.string(),
  state: z.enum(['running', 'waiting', 'idle', 'failed']), prUrl: z.string().optional(), summary: z.string().optional(),
  /** The posted message's server revision; the next edit expects it. */
  revision: z.number().int().positive(), createdAt: z.number(),
  /** The request the task came from, quoted by its main-group results; absent when it could not be read. */
  quote: quote.optional(),
  /** Who asked, named by the results; null when they are no longer in the group. */
  requesterId: z.string().uuid().nullable(),
  /** The first line of the latest turn's reply: the card's `summary` once the task is not running. */
  lastLine: z.string().optional(),
  /** The task's latest turn ends, newest last: a turn end seen again posts nothing again. */
  turns: z.array(z.string()).optional(),
  /**
   * Messages a turn end left for the group, oldest first, until the group has them: the `reply` in
   * the card's Thread and the short `result` in the main group. Each keeps its own operation, so a
   * retry is the same message.
   */
  outbox: z.array(z.object({ op: z.string(), kind: z.enum(['reply', 'result']), text: z.string(),
    attempts: z.number().int().nonnegative().optional(), retryAt: z.number().optional() })).optional(),
  /** The task that opened this card's task: its answers to word the task sends back go to the group. */
  openerTaskId: z.string().optional(),
  /** Answers already handed to the outbox, so the same turn end seen again posts nothing again. */
  answers: z.array(z.string()).optional(),
  /**
   * The newest message of the card's Thread the task has been told about: other members' words are
   * not delivered to the task, its owner's next words from the Thread carry what came after this.
   */
  threadSeenSeq: z.string().regex(/^\d+$/).optional(),
  /** Until when an edit of the card waits after the server refused one (a rate limit's own wait). */
  editRetryAt: z.number().optional(),
});
export type ChatLiveTaskCardRecord = z.infer<typeof liveTaskCard>;
/**
 * Task cards this computer posted (bot-group-chat.md §10), by message ID: it keeps each card and the
 * group in step with the card's task (`groupTaskCards.ts`). Local only; the card itself is in the group.
 */
export function chatServerTaskCards(endpoint: string, actorId: string, current: () => boolean) {
  const file = ownerScopedUserDataPath('chat-workspace-settings', createHash('sha256').update(`${endpoint}\n${actorId}`).digest('hex'), 'task-cards.json');
  const check = () => { if (!current()) throw new Error('OWNER_CHANGED'); };
  return {
    read(): Record<string, ChatLiveTaskCardRecord> {
      check(); const raw = readAtomicFileSync(file);
      if (!raw) return {};
      const parsed = z.record(z.string(), liveTaskCard).safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : {};
    },
    save(value: Record<string, ChatLiveTaskCardRecord>) {
      check(); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      atomicWriteFileSync(file, JSON.stringify(value));
    },
  };
}

const assistantSession = z.object({
  /** The group's ordinary task on this computer, and the project folder it was opened in (null: under 「对话」). */
  sessionId: z.string().min(1), projectDir: z.string().nullable(),
  /**
   * The group's newest message already delivered into the task, per conversation (`main` or a
   * Thread's root ID): the next request carries only what came after it. Sequences stay strings.
   */
  deliveredSeq: z.record(z.string(), z.string().regex(/^\d+$/)).optional(),
});
export type ChatAssistantSessionRecord = z.infer<typeof assistantSession>;
/**
 * The group's Cindy on this computer (bot-group-chat.md「群里的 Cindy」): one ordinary visible task
 * per conversation: room ID for the main group (including legacy records), room ID + Thread root
 * for a Thread. Local only; another computer of the same account keeps its own.
 */
export function chatServerAssistantSessions(endpoint: string, actorId: string, current: () => boolean) {
  const file = ownerScopedUserDataPath('chat-workspace-settings', createHash('sha256').update(`${endpoint}\n${actorId}`).digest('hex'), 'group-cindy-sessions.json');
  const check = () => { if (!current()) throw new Error('OWNER_CHANGED'); };
  return {
    read(): Record<string, ChatAssistantSessionRecord> {
      check(); const raw = readAtomicFileSync(file);
      if (!raw) return {};
      const parsed = z.record(z.string(), assistantSession).safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : {};
    },
    save(value: Record<string, ChatAssistantSessionRecord>) {
      check(); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      atomicWriteFileSync(file, JSON.stringify(value));
    },
  };
}
