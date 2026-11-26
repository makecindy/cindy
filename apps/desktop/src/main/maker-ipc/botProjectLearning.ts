import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { parseFilename } from '@cindy/maker-core';
import type { BotLearningReceipt } from '@cindy/maker-shared/bot-learning';
import { readTeammateMemories, teammateProjectMemoryDir } from './botProjectMemory.js';

function titleForMemoryFile(filename: string, raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (filename === 'MEMORY.md') return 'Core Memory';
  let body = trimmed;
  if (/^---\r?\n/.test(trimmed)) {
    try {
      const parsed = matter(trimmed);
      if (typeof parsed.data?.title === 'string' && parsed.data.title.trim()) {
        return parsed.data.title.trim().slice(0, 100);
      }
      body = parsed.content.trim();
    } catch {
      body = trimmed;
    }
  }
  const heading = /^#\s+(.+?)\s*$/m.exec(body)?.[1]?.trim();
  if (heading) return heading.slice(0, 100);
  return filename.replace(/\.md$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 100) || filename;
}

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
      if (parsed?.type === 'digest') continue;
      const title = titleForMemoryFile(record.filename, record.content);
      if (!title) continue;
      result.set(record.filename, {
        hash: createHash('sha256').update(record.content).digest('hex'),
        title,
      });
    }
    return result;
  }
  const resolvedPath = (file: string) => {
    const resolved = path.resolve(workspace, file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  let previous = await snapshot().catch(() => null);
  let pending = Promise.resolve<BotLearningReceipt[]>([]);
  return (writtenPaths: readonly string[]) => {
    const confirmed = new Set(writtenPaths.map(resolvedPath));
    pending = pending.then(async () => {
      const next = await snapshot().catch(() => null);
      const receipts: BotLearningReceipt[] = [];
      if (previous && next) for (const [filename, record] of next) {
        if (!confirmed.has(resolvedPath(path.join(teammateProjectMemoryDir(workspace), filename)))
          || previous.get(filename)?.hash === record.hash) continue;
        receipts.push({ kind: 'memory', key: filename, title: record.title,
          action: previous.has(filename) ? 'updated' : 'created' });
      }
      previous = next;
      return receipts;
    });
    return pending;
  };
}
