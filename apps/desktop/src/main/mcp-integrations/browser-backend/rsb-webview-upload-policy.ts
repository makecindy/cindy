import fs from 'node:fs/promises';
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
      const resolved = await fs.realpath(root);
      const stat = await fs.stat(resolved);
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
      resolved = await fs.realpath(candidate);
      stat = await fs.stat(resolved);
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
