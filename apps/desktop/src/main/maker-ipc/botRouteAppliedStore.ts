import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Which teammate model configuration was last applied to each of its tasks. A task keeps
 * its own model until that configuration changes, across restarts too; without this record
 * every restart would put the teammate's model back over a choice made in the task.
 */
const FILE = 'bot-route-applied.v1.json';
const MAX_ENTRIES = 5_000;

export function createBotRouteAppliedStore(root: () => string) {
  let loaded: { root: string; entries: Map<string, string> } | null = null;
  let writing = Promise.resolve();

  const load = async (): Promise<Map<string, string>> => {
    const dir = root();
    if (loaded?.root === dir) return loaded.entries;
    const entries = new Map<string, string>();
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, FILE), 'utf8')) as unknown;
      const sessions = raw && typeof raw === 'object' ? (raw as { sessions?: unknown }).sessions : null;
      if (sessions && typeof sessions === 'object' && !Array.isArray(sessions)) {
        for (const [id, key] of Object.entries(sessions)) if (typeof key === 'string') entries.set(id, key);
      }
    } catch {
      // Missing or damaged: every task re-applies its teammate's configuration once.
    }
    loaded = { root: dir, entries };
    return entries;
  };

  return {
    async get(sessionId: string): Promise<string | undefined> {
      return (await load()).get(sessionId);
    },
    async set(sessionId: string, key: string): Promise<void> {
      const dir = root();
      const entries = await load();
      if (entries.get(sessionId) === key) return;
      entries.delete(sessionId);
      entries.set(sessionId, key);
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
      const snapshot = JSON.stringify({ version: 1, sessions: Object.fromEntries(entries) });
      writing = writing.catch(() => {}).then(async () => {
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, FILE);
        const temp = `${file}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temp, snapshot, { mode: 0o600 });
          await fs.rename(temp, file);
        } finally {
          await fs.rm(temp, { force: true });
        }
      });
      await writing;
    },
  };
}
