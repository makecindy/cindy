import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { WritableDirectoryGrantErrorCode } from '../../shared/writableDirectoryGrantError.js';

const GRANT_TTL_MS = 5 * 60_000;

/** A rejected picker proof is distinct from a task creation/storage failure. */
export class WritableDirectoryPickerGrantError extends Error {
  constructor(readonly code: WritableDirectoryGrantErrorCode, message: string) {
    super(message);
  }
}

type WritableDirectoryPickerGrant = {
  scopeId: string;
  senderId: number;
  lexicalPath: string;
  realPath: string;
  expiresAt: number;
};

const grants = new Map<string, WritableDirectoryPickerGrant>();

function normalizeLexicalPath(value: string): string {
  return path.resolve(value.trim());
}

function grantKey(senderId: number, scopeId: string, lexicalPath: string): string {
  return `${senderId}\0${scopeId}\0${lexicalPath}`;
}

function purgeExpired(now: number): void {
  for (const [key, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(key);
  }
}

/** Record a directory chosen by the trusted Main-owned picker for one local task. */
export async function issueWritableDirectoryPickerGrant(input: {
  scopeId: string;
  senderId: number;
  directory: string;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  purgeExpired(now);
  const lexicalPath = normalizeLexicalPath(input.directory);
  const realPath = await fs.realpath(lexicalPath);
  grants.set(grantKey(input.senderId, input.scopeId, lexicalPath), {
    scopeId: input.scopeId,
    senderId: input.senderId,
    lexicalPath,
    realPath,
    expiresAt: now + GRANT_TTL_MS,
  });
}

/**
 * Record a directory chosen from the recent project list. Its reach matches choosing
 * the same directory as a task working directory, so only a path persisted in that
 * list qualifies; arbitrary renderer paths still require the system picker.
 */
export async function issueWritableDirectoryRecentGrant(input: {
  scopeId: string;
  senderId: number;
  directory: string;
  isRecentProject: (directory: string) => Promise<boolean>;
  now?: number;
}): Promise<void> {
  if (!(await input.isRecentProject(input.directory))) {
    throw new WritableDirectoryPickerGrantError(
      'WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED',
      'Writable directory is not a recent project',
    );
  }
  // 系统选择器只能选目录；这条来源的路径由 Renderer 传入，目录已被换成文件时同样按不可用处理。
  const isDirectory = await fs
    .stat(input.directory)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (!isDirectory) {
    throw new WritableDirectoryPickerGrantError(
      'WRITABLE_DIRECTORY_UNAVAILABLE', 'Writable directory is unavailable',
    );
  }
  try {
    await issueWritableDirectoryPickerGrant(input);
  } catch {
    throw new WritableDirectoryPickerGrantError(
      'WRITABLE_DIRECTORY_UNAVAILABLE', 'Writable directory is unavailable',
    );
  }
}

/**
 * Consume Main picker evidence for every newly added local writable root.
 * Retained/revoked roots need no new picker action. Validation is all-or-nothing,
 * and the real target is checked again so a swapped symlink/junction fails closed.
 */
export async function consumeWritableDirectoryPickerGrants(input: {
  scopeId: string;
  senderId: number;
  requestedDirs: readonly string[];
  previousDirs: readonly string[];
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  purgeExpired(now);
  const previous = new Set(input.previousDirs.map(normalizeLexicalPath));
  const additions = input.requestedDirs
    .map(normalizeLexicalPath)
    .filter((directory) => !previous.has(directory));
  const matched: string[] = [];

  for (const directory of additions) {
    const key = grantKey(input.senderId, input.scopeId, directory);
    const grant = grants.get(key);
    if (!grant) {
      throw new WritableDirectoryPickerGrantError(
        'WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED',
        'Writable directory was not authorized by the system picker',
      );
    }
    const currentRealPath = await fs.realpath(directory).catch(() => null);
    if (currentRealPath === null) {
      throw new WritableDirectoryPickerGrantError(
        'WRITABLE_DIRECTORY_UNAVAILABLE', 'Writable directory is unavailable',
      );
    }
    if (currentRealPath !== grant.realPath) {
      throw new WritableDirectoryPickerGrantError(
        'WRITABLE_DIRECTORY_TARGET_CHANGED', 'Writable directory changed after it was selected',
      );
    }
    matched.push(key);
  }

  for (const key of matched) grants.delete(key);
}

export function clearWritableDirectoryPickerGrantsForTesting(): void {
  grants.clear();
}
