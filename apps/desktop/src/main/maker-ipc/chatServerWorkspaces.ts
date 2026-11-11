/** Device-local project choices and prepared workspaces; never shared chat state. */
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

const liveTaskCard = z.object({
  roomId: z.string().uuid(), botId: z.string().uuid(), threadRootId: z.string().uuid().nullable(),
  taskId: z.string(), deviceId: z.string().nullable(), title: z.string(), requesterName: z.string(), botName: z.string(),
  // Early builds of this card recorded `finished` for the same state.
  state: z.preprocess(value => value === 'finished' ? 'idle' : value, z.enum(['running', 'waiting', 'idle', 'failed'])), prUrl: z.string().optional(),
  /** The line the card shows after its state, and the one it shows once the task is not running. */
  summary: z.string().optional(), lastLine: z.string().optional(),
  /** The task's latest turn ends, newest last: a turn end seen again posts nothing again. */
  turns: z.array(z.string()).optional(),
  /**
   * Messages a turn end left for the group, oldest first, until the group has them: the reply in
   * the card's Thread, the short result in the main group (`quote`: it quotes this card). Each
   * keeps its own operation, so a retry is the same message.
   */
  outbox: z.array(z.object({ op: z.string(), text: z.string(), threadRootId: z.string().uuid().nullable(),
    quote: z.boolean().optional(), attempts: z.number().int().nonnegative().optional(), retryAt: z.number().optional() })).optional(),
  /** The posted message's server revision; the next edit expects it. */
  revision: z.number().int().positive(), createdAt: z.number(),
});
export type ChatLiveTaskCardRecord = z.infer<typeof liveTaskCard>;
/**
 * Task cards this computer posted for its teammates (bot-group-chat.md §10), by message ID: this
 * computer keeps each card in step with its task. Local only; the card itself is in the group.
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

/** `owner/name` of a GitHub remote URL (HTTPS, SSH or scp form), or null for any other remote. */
export function githubRepositoryOfRemote(url: string): string | null {
  const match = /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i
    .exec(url.trim());
  return match ? match[1]! : null;
}

/**
 * Registered project folders that are checkouts of `repo` (their `origin`), main checkouts only:
 * a linked worktree (`.git` is a file) or a folder inside another match is the same project.
 */
export async function findRepositoryFolders(dirs: readonly string[], repo: string, read: {
  origin(dir: string): Promise<string | null>;
  isMainCheckout(dir: string): Promise<boolean>;
}): Promise<string[]> {
  const wanted = repo.toLowerCase();
  const matches: string[] = [];
  for (let start = 0; start < dirs.length; start += 8) {
    const batch = dirs.slice(start, start + 8);
    const found = await Promise.all(batch.map(async dir => {
      const origin = await read.origin(dir).catch(() => null);
      return origin && githubRepositoryOfRemote(origin)?.toLowerCase() === wanted && await read.isMainCheckout(dir).catch(() => false) ? dir : null;
    }));
    for (const dir of found) if (dir) matches.push(path.resolve(dir));
  }
  const unique = [...new Set(matches)];
  return unique.filter(dir => !unique.some(other => other !== dir && dir.startsWith(other + path.sep)));
}
