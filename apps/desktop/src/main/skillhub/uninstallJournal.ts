import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile';
import type { StoredInstall } from './registry/types';
import type { SkillActivationSnapshot } from './activationPreferences';
import { isSkillMutationToken } from './sharedMutationLease';

/** A durable operation receipt, never a Renderer-provided path or authorization. */
export interface UninstallCleanup {
  version: 1;
  token: string;
  ownerId: string;
  phase: 'prepared' | 'removed' | 'completed';
  lockNames: string[];
  skillName: string;
  resolved: string;
  sourceIdentity: string;
  operationPath: string;
  operationIdentity: string;
  linkOnly: boolean;
  registryMatch: { skillName: string; installPath: string; entry: StoredInstall } | null;
  links: Array<{ path: string; value: string; identity: string }>;
  activation: SkillActivationSnapshot | null;
  undoIgnore: boolean;
  cloudUserId: string | null;
}

export function fileIdentity(file: string, follow = false): string | null {
  try {
    const stat = follow ? fs.statSync(file) : fs.lstatSync(file);
    return JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs, stat.isSymbolicLink()]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function journalDir(): string {
  return path.join(app.getPath('userData'), 'skillhub', 'uninstall-cleanups');
}

function journalPath(token: string): string {
  if (!isSkillMutationToken(token)) throw new Error('Invalid uninstall receipt');
  return path.join(journalDir(), `${token}.json`);
}

export function writeUninstallCleanup(cleanup: UninstallCleanup): void {
  atomicWriteFileSync(journalPath(cleanup.token), JSON.stringify(cleanup));
}

export function readUninstallCleanup(token: string): UninstallCleanup | null {
  const raw = readAtomicFileSync(journalPath(token));
  if (raw === null) return null;
  const value = JSON.parse(raw) as UninstallCleanup;
  if (value.version !== 1 || value.token !== token || typeof value.ownerId !== 'string'
    || !['prepared', 'removed', 'completed'].includes(value.phase)
    || !Array.isArray(value.lockNames) || !value.lockNames.length || value.lockNames.some((name) => typeof name !== 'string')
    || ![value.resolved, value.operationPath, ...value.links.map((link) => link.path),
      ...(value.registryMatch ? [value.registryMatch.installPath] : [])].every((file) => typeof file === 'string' && path.isAbsolute(file))
    || typeof value.sourceIdentity !== 'string' || typeof value.operationIdentity !== 'string') {
    throw new Error('Invalid uninstall journal');
  }
  return value;
}

export function listUninstallCleanups(): UninstallCleanup[] {
  let files: string[];
  try { files = fs.readdirSync(journalDir()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return [...new Set(files.filter((file) => /\.json(?:\.bak)?$/.test(file))
    .map((file) => file.replace(/\.json(?:\.bak)?$/, '')))]
    .flatMap((token) => { const record = readUninstallCleanup(token); return record ? [record] : []; });
}

export function deleteUninstallCleanup(token: string): void {
  // Delete the backup first: a failed final unlink must not resurrect an older phase.
  for (const file of [`${journalPath(token)}.bak`, journalPath(token)]) {
    try { fs.unlinkSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
