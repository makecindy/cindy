import { assertDisjointProjectPaths } from '../projectDirectoryValidation.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { WritableDirectoryGrantErrorCode } from '../../shared/writableDirectoryGrantError.js';

const GRANT_TTL_MS = 5 * 60_000;

/** A rejected picker proof is distinct from a task creation/storage failure. */
export class WritableDirectoryPickerGrantError extends Error {
  constructor(
    readonly code: WritableDirectoryGrantErrorCode,
    message: string,
  ) {
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

function grantKey(senderId: number, scopeId: string, directory: string, project = false): string {
  return JSON.stringify([project, senderId, scopeId, directory]);
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
  useCanonicalPath?: boolean;
  now?: number;
}): Promise<string> {
  const now = input.now ?? Date.now();
  purgeExpired(now);
  const lexicalPath = input.useCanonicalPath
    ? path.resolve(input.directory)
    : normalizeLexicalPath(input.directory);
  const realPath = await fs.realpath(lexicalPath);
  if (input.useCanonicalPath && realPath !== realPath.trim())
    throw new WritableDirectoryPickerGrantError(
      'WRITABLE_DIRECTORY_UNAVAILABLE',
      'Project path cannot end in whitespace',
    );
  grants.set(
    grantKey(
      input.senderId,
      input.scopeId,
      input.useCanonicalPath ? realPath : lexicalPath,
      input.useCanonicalPath,
    ),
    {
      scopeId: input.scopeId,
      senderId: input.senderId,
      lexicalPath,
      realPath,
      expiresAt: now + GRANT_TTL_MS,
    },
  );
  return realPath;
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
      'WRITABLE_DIRECTORY_UNAVAILABLE',
      'Writable directory is unavailable',
    );
  }
  try {
    await issueWritableDirectoryPickerGrant(input);
  } catch {
    throw new WritableDirectoryPickerGrantError(
      'WRITABLE_DIRECTORY_UNAVAILABLE',
      'Writable directory is unavailable',
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
  checkOnly?: boolean;
  projectPaths?: readonly string[];
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  purgeExpired(now);
  const previous = new Set(input.previousDirs.map(normalizeLexicalPath));
  const additions = input.requestedDirs
    .map(normalizeLexicalPath)
    .filter((directory) => !previous.has(directory));
  const matched = new Map<string, WritableDirectoryPickerGrant>();

  for (const directory of additions) {
    const key = grantKey(input.senderId, input.scopeId, directory, !!input.projectPaths);
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
        'WRITABLE_DIRECTORY_UNAVAILABLE',
        'Writable directory is unavailable',
      );
    }
    if (
      currentRealPath !== grant.realPath ||
      (directory !== grant.lexicalPath &&
        (await fs.realpath(grant.lexicalPath).catch(() => null)) !== grant.realPath)
    ) {
      throw new WritableDirectoryPickerGrantError(
        'WRITABLE_DIRECTORY_TARGET_CHANGED',
        'Writable directory changed after it was selected',
      );
    }
    matched.set(key, grant);
  }

  if (input.projectPaths) {
    const selections = [...new Set(input.projectPaths.map(normalizeLexicalPath))].map(
      (directory) => {
        const selected = matched.get(grantKey(input.senderId, input.scopeId, directory, true));
        return selected ? [directory, selected.lexicalPath] : [directory];
      },
    );
    assertDisjointProjectPaths(selections, false);
  }
  for (const [key, grant] of matched) {
    if (grants.get(key) !== grant)
      throw new WritableDirectoryPickerGrantError(
        'WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED',
        'Picker selection has expired',
      );
  }
  if (!input.checkOnly) for (const key of matched.keys()) grants.delete(key);
}

export function clearWritableDirectoryPickerGrantsForTesting(): void {
  grants.clear();
}
