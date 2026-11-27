import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { MakerMemoryManager } from './manager.js';
import { MAKER_MEMORY_RULES } from './system-prompt.js';
import { CORE_MEMORY_INDEX_MAX_BYTES } from './types.js';

const LEGACY_EMPTY_INDEX_MARKER = '_(empty — no memories saved yet for this workdir)_';

/** Read a teammate project's compact always-loaded MEMORY.md without opening SQLite or following symlinks. */
export async function readProjectCoreMemoryIndex(
  projectDirectory: string,
  maxBytes = CORE_MEMORY_INDEX_MAX_BYTES,
): Promise<string> {
  const indexPath = path.join(projectDirectory, 'MEMORY.md');
  try {
    const stat = await fs.lstat(indexPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return '';
    const raw = (await fs.readFile(indexPath, 'utf8')).trim();
    if (!raw || raw.includes(LEGACY_EMPTY_INDEX_MARKER)) return '';
    if (Buffer.byteLength(raw, 'utf8') <= maxBytes) return raw;
    const lines = raw.split('\n');
    const kept: string[] = [];
    let used = 0;
    const footer = `\n\n_(truncated to ${maxBytes} bytes — read ${path.join(projectDirectory, 'MEMORY.md')} for the full entry)_`;
    const budget = Math.max(256, maxBytes - Buffer.byteLength(footer, 'utf8'));
    for (const line of lines) {
      const next = (kept.length ? 1 : 0) + Buffer.byteLength(line, 'utf8');
      if (used + next > budget) break;
      kept.push(line);
      used += next;
    }
    if (kept.length === 0) {
      let acc = '';
      for (const ch of raw) {
        if (Buffer.byteLength(acc + ch, 'utf8') > budget) break;
        acc += ch;
      }
      return `${acc.trimEnd()}${footer}`;
    }
    return `${kept.join('\n').trimEnd()}${footer}`;
  } catch {
    return '';
  }
}

/** The same contract for all engines, including a provider running on another computer. */
export async function loadMemoryContext(input: {
  manager?: MakerMemoryManager;
  scopeKey: string;
  hosted?: boolean;
  snapshot?: string;
  projectDirectory?: string;
}): Promise<{ rules: string; index: string; projectDirectory?: string }> {
  const projectDirectory = input.projectDirectory
    ?? (input.hosted ? undefined : input.manager?.getProjectMemoryDirectory?.(input.scopeKey));
  if (projectDirectory) {
    const index = input.hosted
      ? (input.snapshot ?? '')
      : await readProjectCoreMemoryIndex(projectDirectory);
    return {
      // Minimal location + two-layer taste contract: MEMORY.md is the compact always-loaded core
      // entry; detailed notes are freeform Markdown files beside it.
      rules:
        `Durable memory lives in ${JSON.stringify(projectDirectory)} as plain Markdown files (use native file tools). ` +
        `Keep MEMORY.md concise (under ~2 KB) for always-loaded key preferences, hard corrections, and brief topic pointers; ` +
        `put detailed notes in separate .md files beside it. Save only durable cross-session facts or rules (no logs or transient progress), ` +
        `and check existing files to update before creating new ones.`,
      index,
      projectDirectory,
    };
  }
  const store = input.hosted ? undefined : await input.manager?.getStore(input.scopeKey);
  return {
    rules: input.scopeKey.startsWith('bot:') ? '' : MAKER_MEMORY_RULES,
    index: input.snapshot ?? (store ? await store.getIndex() : ''),
  };
}
