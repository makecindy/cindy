/**
 * The `.gitignore` of a teammate project (botProjectMode.ts): what keeps credentials, environments,
 * worktrees and the memory's derived files out of its versions, and the gate every version and
 * savepoint of the project waits for (snapshotTeammateProject, the repository's first commit, cloud
 * rule arrivals, createShadowSavepoint). Kept free of Electron and database modules: the Git snapshot
 * kernel, shared with the Node host, imports it.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createLogger } from '../logger.js';

const log = createLogger('maker-ipc:bot-project-gitignore');

/**
 * Written once the teammate project's `.gitignore` has both lists, beside the project
 * (`bots/<teammate>/`), so an entry the owner removes afterwards stays removed.
 */
export const TEAMMATE_GITIGNORE_RECEIPT_FILE = 'project-gitignore.json';

/**
 * Whether the teammate project at `workspace` has its `.gitignore` entries. Until it does, Cindy
 * records no version or savepoint of the project: an untracked credential would enter the history
 * before the rule could keep it out (maintainer review, 2026-11-24).
 */
export async function isTeammateProjectIgnoreReady(workspace: string): Promise<boolean> {
  return fs.lstat(path.join(path.dirname(workspace), TEAMMATE_GITIGNORE_RECEIPT_FILE)).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

async function writeIfMissing(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * The memory records are the teammate's own work and are versioned; what the memory store derives
 * beside them (the rebuilt MEMORY.md index, search database, folder metadata, temp files) is not.
 * The store's copy receipt is versioned too: a `git clean` must not make it copy the old records
 * again over later deletions.
 */
/** The memory folder, relative to the teammate's project (botProjectMemory.ts re-exports it). */
export const TEAMMATE_PROJECT_MEMORY_SEGMENTS = ['.cindy', 'memory'] as const;
/**
 * The memory store's copy receipt, `MEMORY_STORAGE_MIGRATION_RECEIPT` in @cindy/maker-core, spelled
 * out so this module needs no package that the snapshot kernel's tests replace (botProjectMode.test.ts
 * checks they match).
 */
const MEMORY_STORE_RECEIPT = '.cindy-memory-migration-v1.json';
const MEMORY_DIR = TEAMMATE_PROJECT_MEMORY_SEGMENTS.join('/');
export const BOT_PROJECT_MEMORY_GITIGNORE = [
  `${MEMORY_DIR}/*`,
  `!${MEMORY_DIR}/*.md`,
  `!${MEMORY_DIR}/${MEMORY_STORE_RECEIPT}`,
];

/**
 * A teammate puts whatever its work needs in its project: a skill's `.env` or token file, Python
 * environments, worktrees of the repositories it works on. Versions are for its own work, so these
 * stay out of Git (and out of every automatic snapshot's file count). Env templates stay versioned;
 * their exceptions follow `.env.*`, which they must, also when appended to an existing file.
 */
export const BOT_PROJECT_LOCAL_GITIGNORE = [
  '.env', '.env.*', '!.env.example', '!.env.sample', '!.env.template',
  'token.json', 'credentials.json', 'client_secret*.json', '*.pem', '*.p12', '*.pfx',
  '.venv/', 'venv/', '__pycache__/', '.cindy-worktrees/', '.xdt-worktrees/',
];

export const BOT_PROJECT_GITIGNORE = [
  'node_modules/', 'tmp/', '.DS_Store', '*.log',
  '*.zip', '*.tar', '*.tar.gz', '*.tgz', '*.dmg', '*.iso',
  '*.db', '*.sqlite', '*.sqlite3', '*-wal', '*-shm', 'pg_wal/',
  ...BOT_PROJECT_LOCAL_GITIGNORE,
  ...BOT_PROJECT_MEMORY_GITIGNORE,
  '',
].join('\n');

/**
 * Both lists in their order, as one block. A rule only counts when nothing below it matches the same
 * file the other way (Git applies the last matching line: ` token.json` is another pattern, an
 * exception above `.env.*` is overridden, a later `!*.json` lets `token.json` back in). So the first
 * completion puts the whole block at the end of the file, after the owner's rules (maintainer review,
 * 2026-11-24); a file that already ends with it, like every new project's, is left as it is.
 */
const TEAMMATE_PROJECT_IGNORE_BLOCK: readonly string[] = [...BOT_PROJECT_LOCAL_GITIGNORE, ...BOT_PROJECT_MEMORY_GITIGNORE];
const BLOCK_COMMENT = '# Cindy: keep credentials, environments, worktrees and memory caches out of versions';

function endsWithBlock(current: string): boolean {
  const lines = current.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const tail = lines.slice(-TEAMMATE_PROJECT_IGNORE_BLOCK.length);
  return tail.length === TEAMMATE_PROJECT_IGNORE_BLOCK.length && tail.every((line, index) => line === TEAMMATE_PROJECT_IGNORE_BLOCK[index]);
}

/**
 * Puts the block at the end of a project's `.gitignore` unless it already ends with it, keeping the
 * owner's lines as they are; a missing file gets the whole default list. `unavailable` when the
 * `.gitignore` is not a regular file (a folder, or a link, which Git does not read either): it is
 * left alone and its entries are not in effect. Write failures (a read-only file) throw.
 */
async function ensureIgnored(workspace: string): Promise<'changed' | 'unchanged' | 'unavailable'> {
  const file = path.join(workspace, '.gitignore');
  // Exclusive create: an existing entry of any kind, even a dangling link, is never written through.
  if (await writeIfMissing(file, BOT_PROJECT_GITIGNORE)) return 'changed';
  if (!(await fs.lstat(file)).isFile()) return 'unavailable';
  const current = await fs.readFile(file, 'utf8');
  if (endsWithBlock(current)) return 'unchanged';
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const separator = current === '' ? '' : current.endsWith('\n') ? newline : `${newline}${newline}`;
  // Append only: the owner's text is never rewritten, so nothing can read it half-written or lose it,
  // even if another process completes the same project; its mode stays as it is.
  await fs.appendFile(file, `${separator}${[BLOCK_COMMENT, ...TEAMMATE_PROJECT_IGNORE_BLOCK].join(newline)}${newline}`, 'utf8');
  return 'changed';
}

/** In-flight completions by project folder. */
const completing = new Map<string, Promise<'ready' | 'failed'>>();

/**
 * The one place a teammate project's `.gitignore` is completed: the local entries
 * ({@link BOT_PROJECT_LOCAL_GITIGNORE}) and the memory's derived files
 * ({@link BOT_PROJECT_MEMORY_GITIGNORE}), once, with one receipt for both. Only `.gitignore` changes:
 * files already in the history stay versioned and nothing on disk is removed. No version is recorded
 * here: the teammate's next version includes the change, and a startup snapshot has no size bound.
 * Never throws. `failed` (a read-only file, a folder or a link) keeps the teammate usable and its
 * memory moving, but defers its versions; it is retried on the next start or repository retry.
 * Callers on the same project share one attempt: the startup upgrade and a task's savepoint can ask
 * at once, and two in-place rewrites could read each other's truncated file (Codex review, 2026-11-24).
 */
export function ensureTeammateProjectIgnored(input: { workspace: string; botId?: string }): Promise<'ready' | 'failed'> {
  const key = path.resolve(input.workspace);
  const pending = completing.get(key);
  if (pending) return pending;
  const attempt = completeTeammateProjectIgnore(input).finally(() => {
    if (completing.get(key) === attempt) completing.delete(key);
  });
  completing.set(key, attempt);
  return attempt;
}


async function completeTeammateProjectIgnore(input: { workspace: string; botId?: string }): Promise<'ready' | 'failed'> {
  try {
    if (await isTeammateProjectIgnoreReady(input.workspace)) return 'ready';
    const result = await ensureIgnored(input.workspace);
    // Left alone, but its entries are not in effect: no receipt, so versions keep waiting.
    if (result === 'unavailable') throw new Error('.gitignore is not a regular file');
    await fs.writeFile(path.join(path.dirname(input.workspace), TEAMMATE_GITIGNORE_RECEIPT_FILE),
      `${JSON.stringify({ version: 1, at: new Date().toISOString(), changed: result === 'changed' }, null, 2)}\n`, 'utf8');
    if (result === 'changed') log.info('teammate project .gitignore completed', { botId: input.botId });
    return 'ready';
  } catch (error) {
    log.warn('teammate project .gitignore update failed; its versions wait until it is completed', { botId: input.botId, error: String(error) });
    return 'failed';
  }
}
