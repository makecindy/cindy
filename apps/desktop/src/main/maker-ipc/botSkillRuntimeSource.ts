import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BOT_SKILL_MAX_BODY_BYTES, botSkillRootDir, botSkillsDir, readCompatibleBotSkillSource,
  type BotSkillSummary,
} from './botSkillStore.js';
import { createBotSkillFrontmatterReader, isFrontmatterBlock } from './botSkillFrontmatter.js';

// Retain only a preview of any single YAML line, even a multi-MiB scalar.
const LINE_PREVIEW_BYTES = 4096;
const READ_BYTES = 8192;

async function readRuntimeHeader(filePath: string, slug: string, migrate = true, fullMetadata = false): Promise<BotSkillSummary> {
  const handle = await fs.open(filePath, 'r');
  const metadata = createBotSkillFrontmatterReader(fullMetadata ? Infinity : LINE_PREVIEW_BYTES);
  let frontmatterBytes = 0;
  let bodyStartLine = 1;
  let legacy = true;
  const legacyKeys: string[] = [];
  let complete = false;
  let size = 0;
  try {
    size = (await handle.stat()).size;
    const buffer = Buffer.alloc(READ_BYTES);
    let line = Buffer.alloc(0);
    let lineParts: Buffer[] = [];
    let lineBytes = 0;
    let lineNumber = 0;
    let done = false;
    const finishLine = (newline: boolean) => {
      lineNumber++;
      const text = (fullMetadata ? Buffer.concat(lineParts) : line).toString('utf8').replace(/\r$/, '');
      const entire = lineBytes === line.length;
      frontmatterBytes += lineBytes + (newline ? 1 : 0);
      if (lineNumber === 1) {
        if (!entire || text !== '---' || !newline) done = true;
      } else if (entire && text === '---') {
        complete = true;
        bodyStartLine = lineNumber + (newline ? 1 : 0);
        done = true;
      } else {
        const separator = text.indexOf(':');
        const key = text.slice(0, separator).trim();
        if (!entire || /^\s/.test(text) || separator <= 0 || legacyKeys.length >= 3
          || !['name', 'description', 'updatedAt'].includes(key) || isFrontmatterBlock(text.slice(separator + 1))) legacy = false;
        if (legacy) legacyKeys.push(key);
        metadata.line(text, !fullMetadata && !entire);
      }
      line = Buffer.alloc(0);
      lineParts = [];
      lineBytes = 0;
    };
    while (!done) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) {
        if (lineBytes) finishLine(false);
        break;
      }
      let offset = 0;
      while (offset < bytesRead && !done) {
        const found = buffer.indexOf(10, offset);
        const end = found >= 0 && found < bytesRead ? found : bytesRead;
        const segment = buffer.subarray(offset, end);
        lineBytes += segment.length;
        if (fullMetadata) lineParts.push(Buffer.from(segment));
        if (line.length < LINE_PREVIEW_BYTES) line = Buffer.concat([line, segment.subarray(0, LINE_PREVIEW_BYTES - line.length)]);
        if (end < bytesRead) finishLine(true);
        offset = end + 1;
      }
    }
  } finally { await handle.close(); }
  const fields = metadata.finish();
  legacy = complete && legacy && ['name', 'description', 'updatedAt'].every(key => legacyKeys.includes(key));
  // Keep the existing compatibility migration for bounded, historically authored
  // files. Huge hand-written legacy files remain intact and use body discovery.
  if (migrate && legacy && size <= BOT_SKILL_MAX_BODY_BYTES + 16 * 1024) {
    await readCompatibleBotSkillSource(filePath, slug);
    return readRuntimeHeader(filePath, slug, false, fullMetadata);
  }
  return {
    slug,
    name: complete ? (fields.get('displayName') ?? fields.get('name')) || slug : slug,
    description: complete ? fields.get('description') ?? '' : '',
    updatedAt: complete ? fields.get('updatedAt') ?? '' : '',
    dirPath: path.dirname(filePath), filePath,
    frontmatterBytes: complete ? frontmatterBytes : size,
    bodyStartLine: complete ? bodyStartLine : 1,
    ...(legacy ? { requiresDiscovery: true } : {}),
  };
}

async function* iterateHeaders(userDataDir: string, botId: string, enabled: boolean, fullMetadata: boolean): AsyncGenerator<BotSkillSummary> {
  const root = enabled ? botSkillsDir(userDataDir, botId) : path.join(botSkillRootDir(userDataDir, botId), 'disabled-skills');
  let directory;
  try { directory = await fs.opendir(root, { bufferSize: 32 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for await (const entry of directory) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    for (const name of ['SKILL.md', 'skill.md']) {
      const filePath = path.join(root, entry.name, name);
      try {
        if (!(await fs.stat(filePath)).isFile()) continue;
        yield { ...await readRuntimeHeader(filePath, entry.name, true, fullMetadata), ...(enabled ? {} : { enabled: false }) };
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        // Match the full-list API: an unreadable Skill must not suppress its
        // healthy siblings. Its source remains in place for repair/retry.
        break;
      }
    }
  }
}

/** Runtime startup retains only short metadata previews. */
export async function* iterateBotSkillRuntimeSummaries(userDataDir: string, botId: string): AsyncGenerator<BotSkillSummary> {
  yield* iterateHeaders(userDataDir, botId, true, false);
}

/** Query-index construction retains one full header at a time, never Skill bodies. */
export async function* iterateBotSkillQuerySummaries(userDataDir: string, botId: string): AsyncGenerator<BotSkillSummary> {
  yield* iterateHeaders(userDataDir, botId, true, true);
  yield* iterateHeaders(userDataDir, botId, false, true);
}
