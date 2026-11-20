import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { inside, MAX_FILE_BYTES, readImportFile, type ImportReadBudget } from './files.js';
import { CompanionImportError } from './types.js';

export const SKILL_RESOURCE_CHUNK_BYTES = 32 * 1024;
export type SkillEncoding = 'utf8' | 'utf16le' | 'utf16be' | 'binary';
export interface SkillStreamFile { name: string; handle: FileHandle; executable: boolean; interpreterLink?: string }

/** Preserve the native interpreter exception, without granting adjacent files. */
export async function readImportSkillInterpreters(root: string, budget?: ImportReadBudget): Promise<string[]> {
  const interpreters: string[] = [];
  for (const folder of ['.venv', 'venv']) {
    let config: string;
    try { config = (await readImportFile(root, path.join(root, folder, 'pyvenv.cfg'), budget)).bytes.toString('utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const home = /^home\s*=\s*(.+)$/m.exec(config)?.[1]?.trim();
    if (!home || !path.isAbsolute(home)) continue;
    const realHome = await fs.realpath(home).catch(() => undefined);
    if (!realHome) continue;
    const bin = path.join(root, folder, process.platform === 'win32' ? 'Scripts' : 'bin');
    let entries: Awaited<ReturnType<typeof fs.opendir>>;
    try { entries = await fs.opendir(bin); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for await (const entry of entries) {
      budget?.reserve(128 + Buffer.byteLength(path.join(bin, entry.name)));
      if (!entry.isSymbolicLink() || !/^python(?:[23](?:\.\d+)?)?(?:\.exe)?$/.test(entry.name)) continue;
      const real = await fs.realpath(path.join(bin, entry.name));
      if (path.dirname(real) !== realHome || !/^python(?:[23](?:\.\d+)?)?(?:\.exe)?$/.test(path.basename(real))) continue;
      const handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || process.platform !== 'win32' && !(stat.mode & 0o111)) continue;
        const header = Buffer.alloc(4);
        if ((await handle.read(header, 0, 4, 0)).bytesRead !== 4) continue;
        if (['7f454c46', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(header.toString('hex')) || header.subarray(0, 2).toString() === 'MZ') interpreters.push(real);
      } finally { await handle.close(); }
    }
  }
  return interpreters;
}

/** Iteration owns each descriptor until the consumer advances. No file list or
 * resource bytes accumulate; links keep the existing canonical subtree policy. */
export async function* streamImportSkillFiles(root: string, assertOwner: () => void = () => {}): AsyncGenerator<SkillStreamFile> {
  const realRoot = await fs.realpath(root);
  const interpreters = await readImportSkillInterpreters(root);
  const visited = new Set<string>();
  async function* visit(directory: string): AsyncGenerator<SkillStreamFile> {
    assertOwner();
    const realDirectory = await fs.realpath(directory);
    if (!inside(realRoot, realDirectory)) throw new CompanionImportError('SOURCE_LINK_OUTSIDE_FOLDER');
    if (visited.has(realDirectory)) throw new CompanionImportError('SOURCE_LINK_CYCLE');
    visited.add(realDirectory);
    try {
      for await (const entry of await fs.opendir(directory)) {
        assertOwner();
        if (['.git', '__pycache__', '.DS_Store'].includes(entry.name)) continue;
        const file = path.join(directory, entry.name);
        const stat = await fs.stat(file);
        if (stat.isDirectory()) { yield* visit(file); continue; }
        if (!stat.isFile()) throw new CompanionImportError('SOURCE_NOT_REGULAR_FILE');
        const real = await fs.realpath(file);
        const name = path.relative(root, file).split(path.sep).join('/');
        const interpreterLink = entry.isSymbolicLink() && interpreters.includes(real)
          && /^(?:\.venv|venv)\/(?:bin|Scripts)\/python(?:[23](?:\.\d+)?)?(?:\.exe)?$/.test(name) ? real : undefined;
        if (!inside(realRoot, real) && !interpreterLink) throw new CompanionImportError('SOURCE_LINK_OUTSIDE_FOLDER');
        const handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const opened = await handle.stat();
          if (!opened.isFile()) throw new CompanionImportError('SOURCE_NOT_REGULAR_FILE');
          yield { name, handle, executable: (opened.mode & 0o111) !== 0, ...(interpreterLink ? { interpreterLink } : {}) };
        } finally { await handle.close(); }
      }
    } finally { visited.delete(realDirectory); }
  }
  yield* visit(root);
}

export async function* skillFileChunks(handle: FileHandle, assertOwner: () => void = () => {}): AsyncGenerator<Buffer> {
  const buffer = Buffer.alloc(SKILL_RESOURCE_CHUNK_BYTES);
  for (let position = 0; ;) {
    assertOwner();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) return;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

/** Classify the entire file before projecting it; a binary tail must not turn
 * a previously emitted text prefix into an incorrectly rewritten binary. */
export async function inspectSkillFile(handle: FileHandle, assertOwner: () => void) {
  const before = await handle.stat(), hash = createHash('sha256');
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let valid = true, nul = false, length = 0;
  let encoding: SkillEncoding = 'utf8';
  for await (const bytes of skillFileChunks(handle, assertOwner)) {
    if (!length && bytes.length >= 2) {
      if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf16le';
      if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf16be';
    }
    hash.update(bytes); length += bytes.length; nul ||= bytes.includes(0);
    if (valid) try { utf8.decode(bytes, { stream: true }); } catch { valid = false; }
  }
  if (valid) try { utf8.decode(); } catch { valid = false; }
  if (encoding === 'utf8' ? !valid || nul : length % 2 !== 0) encoding = 'binary';
  const after = await handle.stat();
  if (before.size !== length || after.size !== length || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new CompanionImportError('SOURCE_CHANGED');
  return { size: length, hash: hash.digest('hex'), encoding, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs };
}

/** Preview retains only the header. Resource/body size is not a catalog limit;
 * parsing an unbounded YAML header still needs a separate metadata bound. */
export async function readImportSkillManifest(root: string): Promise<string> {
  const file = path.join(root, 'SKILL.md'), real = await fs.realpath(file);
  if (!inside(await fs.realpath(root), real)) throw new CompanionImportError('SOURCE_LINK_OUTSIDE_FOLDER');
  const handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new CompanionImportError('SOURCE_NOT_REGULAR_FILE');
    const decoder = new StringDecoder('utf8');
    const parts: string[] = [];
    let tail = '', size = 0, bodyOnly = false;
    for await (const bytes of skillFileChunks(handle)) {
      const text = decoder.write(bytes);
      if (bodyOnly) { if (text.trim()) return '# Skill'; continue; }
      if (!parts.length && !/^---\r?\n/.test(text)) {
        if (text.trim()) return '# Skill';
        bodyOnly = true; continue;
      }
      // Scan each chunk once, retaining only delimiter overlap. Re-scanning an
      // ever-growing YAML prefix made a 16 MiB rejection quadratic.
      const scanned = tail + text;
      const end = /\r?\n---\r?\n/.exec(scanned);
      const part = end ? text.slice(0, end.index + end[0].length - tail.length) : text;
      size += Buffer.byteLength(part);
      if (size > MAX_FILE_BYTES) throw new CompanionImportError('SOURCE_FILE_TOO_LARGE');
      parts.push(part);
      if (end) return parts.join('');
      tail = scanned.slice(-6);
    }
    const rest = decoder.end();
    if (size + Buffer.byteLength(rest) > MAX_FILE_BYTES) throw new CompanionImportError('SOURCE_FILE_TOO_LARGE');
    return parts.join('') + rest;
  } finally { await handle.close(); }
}

/** Scan dependency identifiers, retaining only matches rather than entire source
 * scripts. This preserves automation selection for Skills with large resources. */
export async function scanImportSkillReferences(root: string, names: readonly string[], envNames: ReadonlySet<string>): Promise<string> {
  const remaining = new Set(names.filter(Boolean)), found = new Set<string>();
  const patterns = new Map([...remaining].map(name => [name, new RegExp(`${envNames.has(name) ? '\\b' : ''}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${envNames.has(name) ? '\\b' : ''}`, 'g')]));
  const overlap = names.reduce((max, name) => Math.max(max, name.length + 2), 2);
  if (!remaining.size) return '';
  for await (const file of streamImportSkillFiles(root)) {
    if (!/\.(md|py|js|mjs|sh|ts|json|yaml|yml|toml)$/i.test(file.name)) continue;
    const decoder = new StringDecoder('utf8');
    let tail = '', dropped = false;
    for await (const bytes of skillFileChunks(file.handle)) {
      const text = tail + decoder.write(bytes);
      for (const name of remaining) {
        const pattern = patterns.get(name)!; pattern.lastIndex = dropped ? 1 : 0;
        const match = pattern.exec(text);
        if (match && match.index + match[0].length < text.length) { found.add(name); remaining.delete(name); }
      }
      dropped = text.length > overlap || dropped;
      tail = text.slice(-overlap);
    }
    const text = tail + decoder.end();
    for (const name of remaining) { const pattern = patterns.get(name)!; pattern.lastIndex = dropped ? 1 : 0; if (pattern.test(text)) { found.add(name); remaining.delete(name); } }
    if (!remaining.size) break;
  }
  return [...found].join('\n');
}
