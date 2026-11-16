import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { parseFilename } from '@cindy/maker-core';
import type { BotLearningReceipt } from '@cindy/maker-shared/bot-learning';
import { readTeammateMemories, teammateProjectMemoryDir } from './botProjectMemory.js';
import { BOT_MEMORY_TYPES } from '../../shared/botMemory.js';

/** Host-only feedback: one async baseline at hydration, one scan per tool-using turn's seal.
 * Native files stay the source of truth; no polling, model context or application write tool. */
export async function createProjectMemoryReceipts(workspace: string) {
  async function snapshot() {
    const directory = teammateProjectMemoryDir(workspace);
    for (const dir of [path.dirname(directory), directory]) {
      const stat = await fs.lstat(dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (stat?.isSymbolicLink()) throw new Error('Linked memory directory');
    }
    const records = await readTeammateMemories([directory]);
    const result = new Map<string, { hash: string; title: string }>();
    for (const record of records) {
      const parsed = parseFilename(record.filename);
      // Match the settings page: Pi's automatic compaction digests are not curated saves.
      if (!parsed || !BOT_MEMORY_TYPES.some(type => type === parsed.type)) continue;
      try {
        const { data } = matter(record.content);
        if (typeof data.title !== 'string' || !data.title.trim()
          || typeof data.description !== 'string' || !data.description.trim()
          || data.type !== parsed.type) continue;
        result.set(record.filename, {
          hash: createHash('sha256').update(record.content).digest('hex'), title: data.title,
        });
      } catch { /* Partial/invalid files are not confirmed saves. */ }
    }
    return result;
  }
  let previous = await snapshot().catch(() => null);
  let pending = Promise.resolve<BotLearningReceipt[]>([]);
  return () => {
    pending = pending.then(async () => {
      const next = await snapshot().catch(() => null);
      const receipts: BotLearningReceipt[] = [];
      if (previous && next) for (const [filename, record] of next) {
        if (previous.get(filename)?.hash === record.hash) continue;
        receipts.push({ kind: 'memory', key: filename, title: record.title,
          action: previous.has(filename) ? 'updated' : 'created' });
      }
      previous = next;
      return receipts;
    });
    return pending;
  };
}
