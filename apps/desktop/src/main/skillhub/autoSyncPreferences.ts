/**
 * skillhub/autoSyncPreferences.ts — local opt-out state for product auto-sync.
 *
 * Registry records what is installed on disk. This file records user intent:
 * when a user uninstalls an auto-sync candidate, keep future auto-sync runs
 * quiet until the user manually installs that skill again.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';
import { createLogger } from '../logger';

const log = createLogger('skillhub:autoSyncPreferences');
const STORE_VERSION = 1;
let mutationQueue: Promise<void> = Promise.resolve();

interface IgnoredSkill {
  name: string;
  userId: string;
  ignoredAt: number;
}

interface AutoSyncCandidateSkill {
  name: string;
  userId: string;
  updatedAt: number;
}

interface PreferenceStore {
  schemaVersion: 1;
  ignoredSkills: IgnoredSkill[];
  autoSyncCandidates: AutoSyncCandidateSkill[];
  /** Offline removals affect shared device files until an explicit manual install. */
  pendingOfflineUninstalls: string[];
}

interface ReadStoreResult {
  store: PreferenceStore;
  resetFromError: boolean;
}

function preferencesPath(): string {
  return path.join(app.getPath('userData'), 'skillhub', 'auto-sync-preferences.json');
}

function normalizeSkillName(name: string): string {
  return name.trim();
}

function emptyStore(): PreferenceStore {
  return { schemaVersion: STORE_VERSION, ignoredSkills: [], autoSyncCandidates: [], pendingOfflineUninstalls: [] };
}

function parseStore(value: unknown): PreferenceStore {
  if (!value || typeof value !== 'object') {
    return emptyStore();
  }
  const rawIgnored = (value as { ignoredSkills?: unknown }).ignoredSkills;
  const byName = new Map<string, IgnoredSkill>();
  if (Array.isArray(rawIgnored)) {
    for (const raw of rawIgnored) {
      if (!raw || typeof raw !== 'object') continue;
      const obj = raw as { name?: unknown; ignoredAt?: unknown };
      if (typeof obj.name !== 'string') continue;
      const userId = typeof (raw as { userId?: unknown }).userId === 'string'
        ? (raw as { userId: string }).userId
        : '';
      if (!userId) continue;
      const name = normalizeSkillName(obj.name);
      if (!name) continue;
      byName.set(`${userId}\0${name}`, {
        name,
        userId,
        ignoredAt: typeof obj.ignoredAt === 'number' && Number.isFinite(obj.ignoredAt) ? obj.ignoredAt : 0,
      });
    }
  }

  const rawCandidates = (value as { autoSyncCandidates?: unknown }).autoSyncCandidates;
  const byCandidate = new Map<string, AutoSyncCandidateSkill>();
  if (Array.isArray(rawCandidates)) {
    for (const raw of rawCandidates) {
      if (!raw || typeof raw !== 'object') continue;
      const obj = raw as { name?: unknown; updatedAt?: unknown };
      if (typeof obj.name !== 'string') continue;
      const userId = typeof (raw as { userId?: unknown }).userId === 'string'
        ? (raw as { userId: string }).userId
        : '';
      if (!userId) continue;
      const name = normalizeSkillName(obj.name);
      if (!name) continue;
      byCandidate.set(`${userId}\0${name}`, {
        name,
        userId,
        updatedAt: typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) ? obj.updatedAt : 0,
      });
    }
  }
  const pending = (value as { pendingOfflineUninstalls?: unknown }).pendingOfflineUninstalls;
  return {
    pendingOfflineUninstalls: Array.isArray(pending)
      ? [...new Set(pending.filter((name): name is string => typeof name === 'string').map(normalizeSkillName).filter(Boolean))]
      : [],
    schemaVersion: STORE_VERSION,
    ignoredSkills: Array.from(byName.values()),
    autoSyncCandidates: Array.from(byCandidate.values()),
  };
}

async function readStoreResult(options: { resetOnError?: boolean } = {}): Promise<ReadStoreResult> {
  const filePath = preferencesPath();
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return { store: parseStore(JSON.parse(raw) as unknown), resetFromError: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { store: emptyStore(), resetFromError: false };
    }
    log.warn('read auto-sync preferences failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (options.resetOnError) {
      return { store: emptyStore(), resetFromError: true };
    }
    throw err;
  }
}

async function readStore(options: { resetOnError?: boolean } = {}): Promise<PreferenceStore> {
  return (await readStoreResult(options)).store;
}

async function writeStore(store: PreferenceStore): Promise<void> {
  const filePath = preferencesPath();
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

function enqueueMutation(task: () => Promise<void>): Promise<void> {
  const next = mutationQueue.then(task, task);
  mutationQueue = next.catch(() => undefined);
  return next;
}

export async function listIgnoredAutoSyncSkills(userId?: string): Promise<Set<string>> {
  const { store, resetFromError } = await readStoreResult({ resetOnError: true });
  if (resetFromError) {
    await writeStore(store);
  }
  return new Set([...store.pendingOfflineUninstalls, ...store.ignoredSkills
    .filter((skill) => skill.userId === userId)
    .map((skill) => skill.name)]);
}

export async function ignoreAutoSyncSkill(name: string, userId?: string): Promise<void> {
  const normalized = normalizeSkillName(name);
  if (!normalized) return;
  await enqueueMutation(async () => {
    const { store } = await readStoreResult({ resetOnError: true });
    if (!userId) {
      await writeStore({ ...store, pendingOfflineUninstalls: [...new Set([...store.pendingOfflineUninstalls, normalized])] });
      return;
    }
    const ignoredAt = Math.floor(Date.now() / 1000);
    const next = store.ignoredSkills.filter((skill) => !(skill.name === normalized && skill.userId === userId));
    next.push({ name: normalized, userId, ignoredAt });
    await writeStore({ ...store, schemaVersion: STORE_VERSION, ignoredSkills: next });
  });
}

export async function clearIgnoredAutoSyncSkill(name: string, userId?: string): Promise<void> {
  const normalized = normalizeSkillName(name);
  if (!normalized) return;
  await enqueueMutation(async () => {
    const { store, resetFromError } = await readStoreResult({ resetOnError: true });
    const next = store.ignoredSkills.filter((skill) => !(skill.name === normalized && skill.userId === userId));
    const pending = store.pendingOfflineUninstalls.filter((name) => name !== normalized);
    if (!resetFromError && next.length === store.ignoredSkills.length && pending.length === store.pendingOfflineUninstalls.length) return;
    await writeStore({ ...store, schemaVersion: STORE_VERSION, ignoredSkills: next, pendingOfflineUninstalls: pending });
  });
}

export async function recordAutoSyncCandidateSkills(
  userId: string,
  names: string[],
  options: { replace?: boolean } = {},
): Promise<void> {
  if (!userId) return;
  const normalizedNames = Array.from(new Set(names.map(normalizeSkillName).filter(Boolean)));
  await enqueueMutation(async () => {
    const { store } = await readStoreResult({ resetOnError: true });
    const updatedAt = Math.floor(Date.now() / 1000);
    const normalizedNameSet = new Set(normalizedNames);
    const replace = options.replace === true;
    const next = store.autoSyncCandidates.filter((skill) => {
      if (skill.userId !== userId) return true;
      if (replace) return false;
      return !normalizedNameSet.has(skill.name);
    });
    for (const name of normalizedNames) {
      next.push({ name, userId, updatedAt });
    }
    await writeStore({ ...store, schemaVersion: STORE_VERSION, autoSyncCandidates: next });
  });
}

export async function isKnownAutoSyncCandidateSkill(name: string, userId?: string): Promise<boolean> {
  const normalized = normalizeSkillName(name);
  if (!normalized) return false;
  const store = await readStore();
  return store.autoSyncCandidates.some((skill) => (!userId || skill.userId === userId) && skill.name === normalized);
}
