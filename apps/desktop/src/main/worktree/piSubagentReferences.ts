import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { piSubagentRunRoot } from '@cindy/maker-core/pi-subagent-runs';

import { createLogger } from '../logger';

const log = createLogger('worktreePiRefs');

interface DirectorySnapshot {
  stat: Stats;
  entries: string[];
}

function sameFile(before: Stats, after: Stats): boolean {
  return !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function readDirectory(directory: string): Promise<DirectorySnapshot> {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('redirected PI run directory');
  return { stat, entries: (await fs.readdir(directory)).sort() };
}

async function directoryUnchanged(directory: string, before: DirectorySnapshot): Promise<boolean> {
  const after = await readDirectory(directory);
  return sameFile(before.stat, after.stat) && before.entries.length === after.entries.length
    && before.entries.every((entry, index) => entry === after.entries[index]);
}

/**
 * Detached runners can outlive both the parent task and the owning Main process.
 * Keep every durable generation, including terminal or stale ones: its status is
 * not proof that all children stopped, and resume reuses the recorded cwd.
 * This is an on-demand, read-only view; it never controls Pi processes.
 */
export async function readPiSubagentWorktreeReferences(): Promise<ReadonlyMap<string, readonly string[]> | null> {
  try {
    const agentHome = path.join(app.getPath('userData'), 'pi-agent-home');
    const root = path.dirname(piSubagentRunRoot(agentHome, 'worktree-reference-probe'));
    const ancestorStats = new Map<string, Stats>();
    for (const directory of [agentHome, path.dirname(root), root]) {
      let stat: Stats;
      try {
        stat = await fs.lstat(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        for (const [ancestor, before] of ancestorStats) {
          if (!sameFile(before, await fs.lstat(ancestor))) return null;
        }
        return new Map();
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
      ancestorStats.set(directory, stat);
    }
    // Once the root exists, any subsequent ENOENT is a changed view, not absence.
    const rootSnapshot = await readDirectory(root);
    const references = new Map<string, readonly string[]>();
    for (const sessionId of rootSnapshot.entries) {
      const sessionRoot = piSubagentRunRoot(agentHome, sessionId);
      const sessionSnapshot = await readDirectory(sessionRoot);
      const paths = new Set<string>();
      for (const entry of sessionSnapshot.entries) {
        const runDirectory = path.join(sessionRoot, entry);
        const runSnapshot = await readDirectory(runDirectory);
        const configFile = path.join(runDirectory, 'config.json');
        const configStat = await fs.lstat(configFile);
        if (configStat.isSymbolicLink() || !configStat.isFile() || configStat.size > 2 * 1024 * 1024) return null;
        const config: unknown = JSON.parse(await fs.readFile(configFile, 'utf8'));
        if (!sameFile(configStat, await fs.lstat(configFile))) return null;
        if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
        const value = config as Record<string, unknown>;
        if (value.version !== 1 || typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd)
          || !Array.isArray(value.tasks)) return null;
        paths.add(value.cwd);
        for (const task of value.tasks) {
          if (!task || typeof task !== 'object' || Array.isArray(task)) return null;
          const cwd = (task as Record<string, unknown>).cwd;
          if (cwd === undefined) continue;
          if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
          paths.add(cwd);
        }
        if (!(await directoryUnchanged(runDirectory, runSnapshot))) return null;
      }
      if (!(await directoryUnchanged(sessionRoot, sessionSnapshot))) return null;
      if (sessionSnapshot.entries.length) references.set(sessionId, [...paths]);
    }
    if (!(await directoryUnchanged(root, rootSnapshot))) return null;
    for (const [ancestor, before] of ancestorStats) {
      if (!sameFile(before, await fs.lstat(ancestor))) return null;
    }
    return references;
  } catch {
    // Configs can contain user content. Do not log parse errors or their excerpts.
    log.warn('PI Subagent worktree references are unreadable; preserving');
    return null;
  }
}
