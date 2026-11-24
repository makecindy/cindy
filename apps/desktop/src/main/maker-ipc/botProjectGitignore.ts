/**
 * The `.gitignore` of a teammate project (botProjectMode.ts): what keeps credentials, environments,
 * worktrees and the memory's derived files out of its versions, and the gate every version and
 * savepoint of the project waits for (snapshotTeammateProject, the repository's first commit, cloud
 * rule arrivals, createShadowSavepoint). Kept free of Electron and database modules: the Git snapshot
 * kernel, shared with the Node host, loads it for teammate projects.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { MEMORY_STORAGE_MIGRATION_RECEIPT } from '@cindy/maker-core';

import { createLogger } from '../logger.js';
import { TEAMMATE_PROJECT_MEMORY_SEGMENTS } from './botProjectMemory.js';

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
const MEMORY_DIR = TEAMMATE_PROJECT_MEMORY_SEGMENTS.join('/');
export const BOT_PROJECT_MEMORY_GITIGNORE = [
  `${MEMORY_DIR}/*`,
  `!${MEMORY_DIR}/*.md`,
  `!${MEMORY_DIR}/${MEMORY_STORAGE_MIGRATION_RECEIPT}`,
  `${MEMORY_DIR}/MEMORY.md`,
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
 * Both lists a teammate project's `.gitignore` needs, in blocks whose order matters: an exception
 * (`!…`) only applies below its pattern, and `MEMORY.md` is ignored again after the `*.md` exception.
 * A block not in effect is appended whole at the end, so its lines keep their order.
 */
const TEAMMATE_PROJECT_IGNORE_BLOCKS: readonly (readonly string[])[] = (() => {
  const blocks: string[][] = [];
  for (const line of BOT_PROJECT_LOCAL_GITIGNORE) {
    if (line.startsWith('!')) blocks[blocks.length - 1]!.push(line);
    else blocks.push([line]);
  }
  return [...blocks, [...BOT_PROJECT_MEMORY_GITIGNORE]];
})();

/**
 * Whether `block` is in effect as written: each line present verbatim (Git reads a leading space as
 * part of the pattern; only a missing carriage return is tolerated) and, as Git applies the last
 * matching line, each line's last occurrence below the previous line's.
 */
function inEffect(current: string, block: readonly string[]): boolean {
  const last = new Map<string, number>();
  current.split(/\r?\n/).forEach((line, index) => last.set(line, index));
  let previous = -1;
  for (const line of block) {
    const at = last.get(line);
    if (at === undefined || at <= previous) return false;
    previous = at;
  }
  return true;
}

/**
 * Appends the blocks a project's `.gitignore` does not have in effect, keeping its own lines as they are; a missing file
 * gets the whole default list. `unavailable` when the `.gitignore` is not a regular file (a folder, or
 * a link, which Git does not read either): it is left alone and its entries are not in effect.
 * Write failures (a read-only file) throw.
 */
async function ensureIgnored(workspace: string): Promise<'changed' | 'unchanged' | 'unavailable'> {
  const file = path.join(workspace, '.gitignore');
  // Exclusive create: an existing entry of any kind, even a dangling link, is never written through.
  if (await writeIfMissing(file, BOT_PROJECT_GITIGNORE)) return 'changed';
  if (!(await fs.lstat(file)).isFile()) return 'unavailable';
  const current = await fs.readFile(file, 'utf8');
  const missing = TEAMMATE_PROJECT_IGNORE_BLOCKS.filter((block) => !inEffect(current, block)).flat();
  if (!missing.length) return 'unchanged';
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const separator = current === '' || current.endsWith('\n') ? '' : newline;
  await fs.writeFile(file, `${current}${separator}${missing.join(newline)}${newline}`, 'utf8');
  return 'changed';
}

/**
 * The one place a teammate project's `.gitignore` is completed: the local entries
 * ({@link BOT_PROJECT_LOCAL_GITIGNORE}) and the memory's derived files
 * ({@link BOT_PROJECT_MEMORY_GITIGNORE}), once, with one receipt for both. Only `.gitignore` changes:
 * files already in the history stay versioned and nothing on disk is removed. No version is recorded
 * here: the teammate's next version includes the change, and a startup snapshot has no size bound.
 * Never throws. `failed` (a read-only file, a folder or a link) keeps the teammate usable and its
 * memory moving, but defers its versions; it is retried on the next start or repository retry.
 */
export async function ensureTeammateProjectIgnored(input: { workspace: string; botId?: string }): Promise<'ready' | 'failed'> {
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
