import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE_COUNT = 20;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

const BLOCKED_FILE_NAMES = new Set([
  '.env',
  '.npmrc',
  '.netrc',
  '.pypirc',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
]);

function isInside(parent: string, child: string): boolean {
  const fold = (value: string) =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  const relative = path.relative(fold(parent), fold(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isBlockedFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  const sensitiveDirectory = filePath
    .split(/[\\/]+/)
    .some((segment) => ['.git', '.ssh'].includes(segment.toLowerCase()));
  return BLOCKED_FILE_NAMES.has(name)
    || name.startsWith('.env.')
    || name.endsWith('.key')
    || sensitiveDirectory;
}

/**
 * Resolves upload candidates to their filesystem identity and confines every
 * file to a host-provided root. Realpath checks prevent a workdir symlink or
 * junction from granting access to a file outside that workdir.
 */
export async function resolveUploadFiles(
  candidates: unknown,
  allowedRoots: string[],
): Promise<string[]> {
  return resolveUploadFilesSync(candidates, allowedRoots);
}

/** Recipes consume the descriptor that was checked, never reopen its path.
 * The second path check also rejects an ancestor replaced during open. */
export function openRecipeInputFileSync(candidate: string, allowedRoots: string[]): number {
  const resolved = resolveUploadFilesSync([candidate], allowedRoots)[0];
  const expected = fs.lstatSync(resolved, { bigint: true });
  if (!expected.isFile() || expected.ino === 0n) throw new Error('recipe input identity is unavailable');
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const current = resolveUploadFilesSync([candidate], allowedRoots)[0];
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino
      || current !== resolved || opened.size > BigInt(MAX_FILE_BYTES)) {
      throw new Error('recipe input changed during open');
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function readRecipeInputFileSync(candidate: string, allowedRoots: string[]): Buffer {
  const descriptor = openRecipeInputFileSync(candidate, allowedRoots);
  try {
    // Bound reads to this descriptor's checked size, including short reads.
    const size = fs.fstatSync(descriptor, { bigint: true }).size;
    if (size > BigInt(MAX_FILE_BYTES)) throw new Error('recipe input exceeds the byte limit');
    const bytes = Buffer.alloc(Number(size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    return bytes.subarray(0, offset);
  } finally { fs.closeSync(descriptor); }
}

/** Desktop grants reads and metadata, but no path-based local export. */
export function createRecipeFileBroker(inputRoots: string[], sessionRoots: string[], temporaryRoot?: string) {
  return {
    read: (file: string) => readRecipeInputFileSync(file, inputRoots),
    open: (file: string) => openRecipeInputFileSync(file, inputRoots),
    directory: sessionRoots[0],
    temporaryRoot,
  };
}

/** Synchronous adapters share exactly the same file policy as native uploads. */
export function resolveUploadFilesSync(candidates: unknown, allowedRoots: string[]): string[] {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('paths must contain at least one file');
  }
  if (candidates.length > MAX_FILE_COUNT) {
    throw new Error(`paths accepts at most ${MAX_FILE_COUNT} files`);
  }

  const roots: string[] = [];
  for (const root of allowedRoots) {
    if (!path.isAbsolute(root)) continue;
    try {
      const resolved = fs.realpathSync(root);
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) roots.push(resolved);
    } catch {
      // A missing optional root grants nothing.
    }
  }
  if (roots.length === 0) {
    throw new Error('upload is unavailable without a local session directory');
  }

  const files: string[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
      throw new Error('every upload path must be an absolute local file path');
    }
    let resolved: string;
    let stat;
    try {
      resolved = fs.realpathSync(candidate);
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`upload file does not exist: ${path.basename(candidate) || 'unnamed'}`);
    }
    if (!stat.isFile()) {
      throw new Error(`upload path is not a regular file: ${path.basename(resolved)}`);
    }
    if (!roots.some((root) => isInside(root, resolved))) {
      throw new Error('upload files must stay inside the current session directory');
    }
    if (isBlockedFile(resolved)) {
      throw new Error(`upload blocked for sensitive file: ${path.basename(resolved)}`);
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`upload file exceeds ${MAX_FILE_BYTES} bytes: ${path.basename(resolved)}`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`upload batch exceeds ${MAX_TOTAL_BYTES} bytes`);
    }
    files.push(resolved);
  }
  return files;
}
