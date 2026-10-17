import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import { botProfileDir } from './botProfileFolder.js';

/** Per-task responsibility, independent of project discovery, judgments and Todo.
 * Releases override creation evidence; nothing is inferred from conversation text.
 */
export type TaskResponsibilities = Record<string, { responsible: boolean; updatedAt: string }>;
const MAX_RECORDS = 10_000;
const MAX_BYTES = 4 * 1024 * 1024;

function filePath(root: string, botId: string): string {
  return path.join(botProfileDir(root, botId), 'task-responsibility.v1.json');
}

export async function readTaskResponsibilities(root: string, botId: string): Promise<TaskResponsibilities> {
  try {
    const file = filePath(root, botId);
    if ((await fs.stat(file)).size > MAX_BYTES) throw new Error('Task responsibility store too large');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (raw?.version !== 1 || !raw.tasks || typeof raw.tasks !== 'object' || Array.isArray(raw.tasks)) {
      throw new Error('Invalid task responsibility store');
    }
    const entries = Object.entries(raw.tasks);
    if (entries.length > MAX_RECORDS || entries.some(([id, value]) => {
      const entry = value as TaskResponsibilities[string] | null;
      return !id || id.length > 256 || !entry || typeof entry.responsible !== 'boolean'
        || typeof entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(entry.updatedAt));
    })) throw new Error('Invalid task responsibility record');
    return Object.fromEntries(entries) as TaskResponsibilities;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error; // A damaged release must never resurrect creation evidence.
  }
}

export function responsibleSessionIds(createdIds: Iterable<string>, records: TaskResponsibilities): string[] {
  const ids = new Set(createdIds);
  for (const [id, entry] of Object.entries(records)) {
    if (entry.responsible) ids.add(id);
    else ids.delete(id);
  }
  return [...ids].sort();
}

/** Atomic, cross-process update; preserve tombstones and reject capacity overflow. */
export async function setTaskResponsibility(
  root: string, botId: string, sessionId: string, responsible: boolean, assertCurrent: () => void,
): Promise<void> {
  if (!sessionId || sessionId.length > 256 || typeof responsible !== 'boolean') throw new Error('Invalid task responsibility');
  const file = filePath(root, botId);
  assertCurrent();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await withCrossProcessLock(file + '.lock', { label: 'bot-task-responsibility' }, async (lock) => {
    if (!lock.held) throw new Error('Task responsibility store busy');
    assertCurrent();
    const tasks = await readTaskResponsibilities(root, botId);
    if (!Object.hasOwn(tasks, sessionId) && Object.keys(tasks).length >= MAX_RECORDS) throw new Error('Task responsibility store full');
    const next = { ...tasks, [sessionId]: { responsible, updatedAt: new Date().toISOString() } };
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temp, JSON.stringify({ version: 1, tasks: next }) + '\n', { encoding: 'utf8', mode: 0o600 });
      assertCurrent();
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
    assertCurrent();
  });
}

export interface TaskResponsibilityScope {
  botId: string;
  directories: string[];
  /** Every task this Bot is responsible for: its own background tasks plus the ones it took over. */
  sessionIds: string[];
  /** Only the background tasks this Bot started itself (delegation children). */
  delegatedSessionIds: string[];
}

/** Fail closed for a damaged companion, without removing other companions' marks. */
export async function collectTaskResponsibilityScopes(
  botIds: readonly string[],
  readScope: (botId: string) => Promise<{ sessionIds: string[]; delegatedSessionIds?: string[] }>,
): Promise<TaskResponsibilityScope[]> {
  const scopes = await Promise.all(botIds.map(async (botId): Promise<TaskResponsibilityScope> => {
    try {
      const scope = await readScope(botId);
      return { botId, directories: [], sessionIds: scope.sessionIds, delegatedSessionIds: scope.delegatedSessionIds ?? [] };
    } catch {
      // Do not fall back to creation evidence: a damaged file may contain releases.
      return { botId, directories: [], sessionIds: [], delegatedSessionIds: [] };
    }
  }));
  // A Bot that released its only background task is still that task's origin: keep the scope
  // for the owner chip even when nothing is followed any more.
  return scopes.filter((scope) => scope.sessionIds.length > 0 || scope.delegatedSessionIds.length > 0);
}
