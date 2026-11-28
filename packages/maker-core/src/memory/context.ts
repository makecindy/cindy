import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { USER_INDEX_HEADING, type MakerMemoryManager } from './manager.js';
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

/**
 * 项目记忆放在项目文件夹里的任务 (伙伴的项目) 另有账号级记忆时, 接在定位说明后面的一段:
 * 那一份不在项目文件夹里, 要经 cindy_memory 读写。
 */
const ACCOUNT_MEMORY_IN_PROJECT_FOLDER_RULES = [
  '',
  '',
  'Separately, the user has an account-level memory (scope `user`): what holds for them in every project — preferences, working habits, facts about their accounts and devices. Its index is under the `# Memory Index — user` heading later in this prompt, a snapshot taken when this conversation started. It is not in the project folder: read and write it through the `cindy_memory` MCP server (`call_tool` with `memory_read` / `memory_search` / `memory_write`), always passing `scope: "user"`. Save there only what holds in every project, and check the index for an existing entry first; everything about this project stays in the project memory files.',
].join('\n');

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
    // An explicit shared-conversation snapshot already enforces the account visibility policy.
    // Only the owning machine reads MEMORY.md; the provider receives the combined snapshot.
    const core = input.hosted ? '' : await readProjectCoreMemoryIndex(projectDirectory);
    const account = input.snapshot !== undefined
      ? (input.snapshot.startsWith(USER_INDEX_HEADING) ? input.snapshot : '')
      : (input.hosted ? '' : await input.manager?.getPromptIndex?.(input.scopeKey).catch(() => '') ?? '');
    const index = input.hosted ? (input.snapshot ?? '') : [account.trimEnd(), core].filter(Boolean).join('\n\n');
    return {
      // Minimal location + two-layer taste contract: MEMORY.md is the compact always-loaded core
      // entry; detailed notes are freeform Markdown files beside it.
      rules:
        `Durable memory lives in ${JSON.stringify(projectDirectory)} as plain Markdown files (use native file tools). ` +
        `Keep MEMORY.md concise (under ~2 KB) for always-loaded key preferences, hard corrections, and brief topic pointers; ` +
        `put detailed notes in separate .md files beside it. Save only durable cross-session facts or rules (no logs or transient progress), ` +
        `and check existing files to update before creating new ones.` +
        (account ? ACCOUNT_MEMORY_IN_PROJECT_FOLDER_RULES : ''),
      index,
      projectDirectory,
    };
  }
  return {
    rules: input.scopeKey.startsWith('bot:') ? '' : MAKER_MEMORY_RULES,
    // 账号级在前、项目在后的两份索引 (伙伴等只有一份的作用域照旧是那一份), 见 getPromptIndex。
    index: input.snapshot ?? (input.hosted ? '' : await input.manager?.getPromptIndex(input.scopeKey) ?? ''),
  };
}
