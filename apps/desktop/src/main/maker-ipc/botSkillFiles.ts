/**
 * The files a skill keeps beside its SKILL.md (scripts, templates, references), for cloud
 * companions. Dependency folders, hidden files and key material stay on the computer that has them.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

export interface BotSkillFile {
  /** Relative to the skill folder, `/`-separated on every platform. */
  path: string;
  size: number;
  sha256: string;
  executable?: true;
}
export type LocalBotSkillFile = BotSkillFile & { absolutePath: string };

const SKIPPED_FOLDERS = new Set(['node_modules', '__pycache__', 'venv']);
const SKIPPED_NAMES = /\.(pem|key|p12|pfx)$/i;

function travels(name: string, folder: boolean): boolean {
  if (!name || name.startsWith('.')) return false;
  return folder ? !SKIPPED_FOLDERS.has(name) : !SKIPPED_NAMES.test(name);
}

/** A path from the cloud is written only when this computer's own listing could have produced it. */
export function isSkillFilePath(value: string): boolean {
  // Any spelling of the entry file: restoring one on a case-insensitive disk would overwrite it.
  if (/[\\:\0]/.test(value) || value.toLowerCase() === 'skill.md') return false;
  const parts = value.split('/');
  return parts.every((part, index) => part !== '..' && travels(part, index < parts.length - 1));
}

// Hashing is repeated every upload cycle, so an unchanged file is only hashed once.
const hashes = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

async function fileHash(file: string, size: number, mtimeMs: number): Promise<string> {
  const known = hashes.get(file);
  if (known?.size === size && known.mtimeMs === mtimeMs) return known.sha256;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  const sha256 = hash.digest('hex');
  hashes.set(file, { size, mtimeMs, sha256 });
  return sha256;
}

/** Windows keeps no executable bit, so a script is known by its first line there. */
async function isExecutable(file: string, mode: number): Promise<boolean> {
  if (process.platform !== 'win32') return (mode & 0o111) !== 0;
  const handle = await fs.open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(2), 0, 2, 0);
    return bytesRead === 2 && buffer.toString('latin1') === '#!';
  } finally { await handle.close(); }
}

/** Regular files only, sorted by path: a link is never followed out of the folder. */
export async function listSkillFolderFiles(skillDir: string): Promise<LocalBotSkillFile[]> {
  const files: LocalBotSkillFile[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (travels(entry.name, true)) await walk(absolutePath, relative);
      } else if (entry.isFile() && travels(entry.name, false) && isSkillFilePath(relative)) {
        const stat = await fs.stat(absolutePath);
        files.push({ path: relative, size: stat.size, sha256: await fileHash(absolutePath, stat.size, stat.mtimeMs),
          ...(await isExecutable(absolutePath, stat.mode) ? { executable: true as const } : {}), absolutePath });
      }
    }
  };
  await walk(skillDir, '');
  return files;
}

/** Never write through a link that would lead out of the skill folder. */
async function hasRealParents(skillDir: string, target: string): Promise<boolean> {
  const parts = path.relative(skillDir, path.dirname(target)).split(path.sep).filter(Boolean);
  let current = skillDir;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return true;
    if (!stat.isDirectory()) return false;
  }
  return true;
}

async function removeEmptyFolders(dir: string, root: string): Promise<void> {
  for (let current = dir; current !== root && current.startsWith(root); current = path.dirname(current)) {
    if ((await fs.readdir(current)).length) return;
    await fs.rmdir(current);
  }
}

/**
 * Makes the folder hold `files`. A file `fetch` cannot provide (null: gone for good) keeps any copy
 * already here; so does anything in `keep`. Without `removeOthers` nothing else is touched either,
 * because the list is incomplete. Returns the listed files that did not arrive.
 */
export async function applySkillFolderFiles(skillDir: string, files: BotSkillFile[],
  fetch: (file: BotSkillFile) => Promise<string | null>, options: { removeOthers: boolean; keep?: string[] }): Promise<string[]> {
  const missing: string[] = [];
  const wanted = files.filter(file => isSkillFilePath(file.path));
  const current = new Map((await listSkillFolderFiles(skillDir)).map(file => [file.path, file]));
  if (options.removeOthers) {
    const keep = new Set([...wanted.map(file => file.path), ...(options.keep ?? [])]);
    for (const [relative, file] of current) {
      if (keep.has(relative)) continue;
      await fs.rm(file.absolutePath, { force: true });
      await removeEmptyFolders(path.dirname(file.absolutePath), skillDir);
    }
  }
  for (const file of wanted) {
    const target = path.join(skillDir, ...file.path.split('/'));
    if (current.get(file.path)?.sha256 !== file.sha256) {
      // An empty file is never uploaded, so there is nothing to fetch.
      const source = file.size === 0 ? null : await fetch(file);
      if (source === null && file.size !== 0) { missing.push(file.path); continue; }
      const hash = createHash('sha256');
      if (source !== null) for await (const chunk of createReadStream(source)) hash.update(chunk as Buffer);
      if (hash.digest('hex') !== file.sha256) { missing.push(file.path); continue; }
      // Something here that this list cannot replace counts as not arrived: it must not hold up a move.
      if (!await hasRealParents(skillDir, target)) { missing.push(file.path); continue; }
      const existing = await fs.lstat(target).catch(() => null);
      if (existing?.isDirectory() && !await fs.rmdir(target).then(() => true, () => false)) { missing.push(file.path); continue; }
      await fs.mkdir(path.dirname(target), { recursive: true });
      // A name of its own: the target's name may already be as long as the disk allows. Hidden, so never listed.
      const temporary = path.join(path.dirname(target), `.skill-${randomUUID()}.tmp`);
      try {
        if (source === null) await fs.writeFile(temporary, '');
        else await fs.copyFile(source, temporary);
        await fs.rename(temporary, target);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    }
    if (process.platform !== 'win32') await fs.chmod(target, file.executable ? 0o755 : 0o644);
  }
  return missing;
}
