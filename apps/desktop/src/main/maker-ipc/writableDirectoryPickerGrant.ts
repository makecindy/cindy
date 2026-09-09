import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const GRANT_TTL_MS = 5 * 60_000;

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
      throw new Error('Writable directory was not authorized by the system picker');
    }
    const currentRealPath = await fs.realpath(directory).catch(() => null);
    if (currentRealPath === null || currentRealPath !== grant.realPath) {
      throw new Error('Writable directory changed after it was selected');
    }
    matched.push(key);
  }

  for (const key of matched) grants.delete(key);
}

export function clearWritableDirectoryPickerGrantsForTesting(): void {
  grants.clear();
}
