import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { encodeEnvironment, decodeEnvironment } from './environmentJson.js';
import { visitSnapshotJson } from './snapshotJson.js';
import { CompanionImportError, type ImportFile, type ImportItem, type ImportSnapshot } from './types.js';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ITEM_BYTES = 128 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;

/** Shared by every read contributing to one snapshot, before allocating bytes. */
export function createImportBudget(limit = MAX_SNAPSHOT_BYTES) {
  let remaining = limit;
  const reserve = (size: number) => {
    if (!Number.isSafeInteger(size) || size < 0 || size > remaining) throw new CompanionImportError('SOURCE_SNAPSHOT_TOO_LARGE');
    remaining -= size;
  };
  return { reserve, reserveFile(size: number) {
    // Even empty files retain a Buffer, metadata and checkpoint representation.
    reserve(size + 256);
  } };
}
export type ImportReadBudget = ReturnType<typeof createImportBudget>;

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Hash raw file bytes without Buffer.toJSON expanding them to numeric arrays. */
export function snapshotFingerprint(items: ImportItem[]): string {
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  return fingerprint(mapItemBytes(items, digest));
}

export async function snapshotFingerprintAsync(items: ImportItem[]): Promise<string> {
  const hash = createHash('sha256');
  // Batch punctuation and short metadata into bounded hash updates. The visitor
  // still accounts for every fragment and yields at its normal byte boundary.
  let chunk = '';
  await visitSnapshotJson(items, bytes => createHash('sha256').update(bytes).digest('hex'), text => {
    chunk += text;
    if (chunk.length >= 16 * 1024) { hash.update(chunk); chunk = ''; }
  });
  if (chunk) hash.update(chunk);
  return hash.digest('hex');
}

function mapItemBytes(items: ImportItem[], encode: (bytes: Buffer) => unknown) {
  return items.map(item => ({ ...item,
    ...(item.files ? { files: item.files.map(file => ({ ...file, bytes: encode(file.bytes) })) } : {}),
    ...(item.asset ? { asset: { ...item.asset, bytes: encode(item.asset.bytes) } } : {}),
  }));
}

export async function reserveSnapshotItems(items: ImportItem[], budget: ImportReadBudget, assertOwner: () => void = () => {}): Promise<void> {
  await visitSnapshotJson(items, bytes => { budget.reserveFile(bytes.length); return null; },
    text => budget.reserve(Buffer.byteLength(text)), assertOwner);
}

/** Checkpoints use compact binary encoding; old numeric-array checkpoints still resume. */
export function serializeImportSnapshot(snapshot: ImportSnapshot): string {
  return JSON.stringify({ ...snapshot, items: mapItemBytes(snapshot.items,
    bytes => ({ type: 'Buffer', encoding: 'base64', data: bytes.toString('base64') })) });
}
/** Runtime checkpoint conversion yields between resources and moves large JSON
 * work off Main. Synchronous helpers remain for small fixtures/legacy callers. */
export async function serializeImportSnapshotAsync(snapshot: ImportSnapshot, assertOwner: () => void): Promise<string> {
  const items: unknown[] = [];
  const encode = (bytes: Buffer) => ({ type: 'Buffer', encoding: 'base64', data: bytes.toString('base64') });
  for (const item of snapshot.items) {
    assertOwner();
    const files: unknown[] = [];
    for (const file of item.files ?? []) {
      assertOwner(); files.push({ ...file, bytes: encode(file.bytes) });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    items.push({ ...item, ...(item.files ? { files } : {}), ...(item.asset ? { asset: { ...item.asset, bytes: encode(item.asset.bytes) } } : {}) });
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return (await encodeEnvironment({ ...snapshot, items }, assertOwner)).text;
}
export async function deserializeImportSnapshotAsync(text: string, assertOwner: () => void): Promise<ImportSnapshot> {
  const snapshot = await decodeEnvironment<ImportSnapshot>(text, assertOwner);
  const bytes = (value: unknown): Buffer => {
    const record = value as { type?: string; encoding?: string; data?: unknown };
    if (record?.type === 'Buffer' && Array.isArray(record.data)) return Buffer.from(record.data);
    if (record?.type === 'Buffer' && record.encoding === 'base64' && typeof record.data === 'string') return Buffer.from(record.data, 'base64');
    throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID');
  };
  for (const item of snapshot.items) {
    assertOwner();
    if (item.files) for (const file of item.files) {
      assertOwner(); file.bytes = bytes(file.bytes);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (item.asset) item.asset.bytes = bytes(item.asset.bytes);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assertOwner(); return snapshot;
}
export function deserializeImportSnapshot(text: string): ImportSnapshot {
  return JSON.parse(text, (_key, value: unknown) => {
    const record = value as { type?: string; encoding?: string; data?: unknown } | null;
    if (record?.type === 'Buffer') {
      if (Array.isArray(record.data)) return Buffer.from(record.data);
      if (record.encoding === 'base64' && typeof record.data === 'string') return Buffer.from(record.data, 'base64');
    }
    return value;
  }) as ImportSnapshot;
}

export function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Refuse symlink escapes and special files before reading any bytes. */
export async function readImportFile(root: string, file: string, budget?: ImportReadBudget, sharedDocumentRoots: readonly string[] = []): Promise<ImportFile> {
  const realRoot = await fs.realpath(root);
  const realFile = await fs.realpath(file);
  if (!inside(realRoot, realFile)) {
    // Native entries may explicitly link a shared document or interpreter.
    // Trust only declared vaults / exact interpreter targets, never an arbitrary
    // external file/directory or a path supplied by IPC.
    if (!sharedDocumentRoots.some(directory => inside(directory, realFile)) || !inside(path.resolve(root), path.resolve(file))
      || !inside(realRoot, await fs.realpath(path.dirname(file)))
      || !(await fs.lstat(file)).isSymbolicLink()) throw new CompanionImportError('SOURCE_LINK_OUTSIDE_FOLDER');
  }
  const handle = await fs.open(realFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new CompanionImportError('SOURCE_NOT_REGULAR_FILE');
    if (stat.size > MAX_FILE_BYTES) throw new CompanionImportError('SOURCE_FILE_TOO_LARGE');
    budget?.reserveFile(stat.size);
    budget?.reserve(Buffer.byteLength(path.relative(root, file)));
    // A bounded read also handles files growing after fstat.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_FILE_BYTES + 1));
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > stat.size) throw new CompanionImportError('SOURCE_CHANGED');
    return { name: path.relative(root, file).split(path.sep).join('/'), bytes: bytes.subarray(0, size), executable: (stat.mode & 0o111) !== 0 };
  } finally { await handle.close(); }
}

export async function optionalText(root: string, file: string, budget?: ImportReadBudget): Promise<string | undefined> {
  try { return (await readImportFile(root, file, budget)).bytes.toString('utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Only traverses the selected skill/document subtree; never copies a whole Agent home. */
export async function readImportTree(root: string, include: (name: string) => boolean = () => true, budget?: ImportReadBudget, onError?: (name: string, error: unknown, kind: 'file' | 'directory' | 'unknown') => void, directory = root, sharedDocumentRoots: readonly string[] = []): Promise<ImportFile[]> {
  const result: ImportFile[] = [];
  const visited = new Set<string>();
  let size = 0;
  const realRoot = await fs.realpath(root);
  async function visit(dir: string) {
    const real = await fs.realpath(dir);
    if (!inside(realRoot, real)) throw new CompanionImportError('SOURCE_LINK_OUTSIDE_FOLDER');
    if (visited.has(real)) throw new CompanionImportError('SOURCE_LINK_CYCLE');
    visited.add(real);
    try {
      budget?.reserve(128 + Buffer.byteLength(path.relative(root, dir)));
      // Stream directory entries too: empty files and rejected links must not
      // allocate an unbounded readdir array or an unbounded list of errors.
      for await (const entry of await fs.opendir(dir)) {
        if (entry.name === '.git' || entry.name === '__pycache__' || entry.name === '.DS_Store') continue;
        const file = path.join(dir, entry.name);
        const name = path.relative(root, file).split(path.sep).join('/');
        budget?.reserve(128 + Buffer.byteLength(name));
        let kind: 'file' | 'directory' | 'unknown' = entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'unknown' : 'file';
        try {
          const target = entry.isSymbolicLink() ? await fs.stat(file) : entry;
          kind = target.isDirectory() ? 'directory' : 'file';
          if (target.isDirectory()) await visit(file);
          else if (include(name)) {
            const item = await readImportFile(root, file, budget, sharedDocumentRoots);
            size += item.bytes.length;
            if (size > MAX_ITEM_BYTES) throw new CompanionImportError('SOURCE_ITEM_TOO_LARGE');
            result.push(item);
          }
        } catch (error) {
          if (!onError || error instanceof CompanionImportError && error.code === 'SOURCE_SNAPSHOT_TOO_LARGE') throw error;
          onError(name, error, kind);
        }
      }
    } finally { visited.delete(real); }
  }
  if (!inside(path.resolve(root), path.resolve(directory))) throw new CompanionImportError('SOURCE_LINK_OUTSIDE_FOLDER');
  await visit(directory);
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function writeImportFiles(root: string, files: readonly ImportFile[]): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = path.resolve(root, file.name);
    if (!inside(root, target) || target === root) throw new CompanionImportError('INVALID_TARGET');
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    // The importer validates these exact native interpreter targets; preserve
    // their location so dynamic libraries and pyvenv.cfg still resolve normally.
    if (file.interpreterLink) {
      if (!/(?:^|\/)(?:\.venv|venv)\/(?:bin|Scripts)\/python(?:[23](?:\.\d+)?)?(?:\.exe)?$/.test(file.name) || !path.isAbsolute(file.interpreterLink)) throw new CompanionImportError('INVALID_TARGET');
      await fs.symlink(file.interpreterLink, target, 'file');
      continue;
    }
    // Imports write into newly allocated directories; never follow a pre-existing entry.
    const handle = await fs.open(target, 'wx', file.executable ? 0o700 : 0o600);
    try { await handle.writeFile(file.bytes); } finally { await handle.close(); }
  }
}
