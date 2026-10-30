import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { BotSkillSummary } from './botSkillStore.js';
import { cachedBotSkillRuntime } from './botSkillRuntimeCache.js';
import { iterateBotSkillQuerySummaries } from './botSkillRuntimeSource.js';
import { BOT_SKILL_RUNTIME_INDEX_BYTES, botSkillRuntimeSummary } from './botSkillRuntimeProjection.js';

const SORT_BYTES = 256 * 1024;
const IO_BYTES = 64 * 1024;

// Match the full-list API's stable name sort: active shelf first, then each
// shelf's lexical slug order. The original full metadata remains searchable.
function compare(a: BotSkillSummary, b: BotSkillSummary): number {
  return a.name.localeCompare(b.name) || Number(a.enabled === false) - Number(b.enabled === false)
    || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
}

/** One JSONL record at a time, including metadata larger than the read buffer. */
async function* records(file: string): AsyncGenerator<BotSkillSummary> {
  const handle = await fs.open(file, 'r');
  const buffer = Buffer.alloc(IO_BYTES);
  let parts: Buffer[] = [];
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      let start = 0;
      while (start < bytesRead) {
        const newline = buffer.indexOf(10, start);
        const end = newline < 0 || newline >= bytesRead ? bytesRead : newline;
        const segment = buffer.subarray(start, end);
        if (end === bytesRead) parts.push(Buffer.from(segment));
        else {
          const text = (parts.length ? Buffer.concat([...parts, segment]) : segment).toString('utf8');
          parts = [];
          yield JSON.parse(text) as BotSkillSummary;
        }
        start = end + 1;
      }
    }
    if (parts.length) throw new Error('Incomplete Skill query index');
  } finally { await handle.close(); }
}

/** Batch small rows; a large row is written directly, never buffered with a shelf. */
function bufferedWriter(handle: FileHandle) {
  let pending: string[] = [];
  let bytes = 0;
  const flush = async () => {
    if (pending.length) await handle.writeFile(pending.join(''));
    pending = []; bytes = 0;
  };
  return {
    flush,
    async write(item: BotSkillSummary) {
      const line = JSON.stringify(item) + '\n';
      const size = Buffer.byteLength(line);
      if (bytes + size > IO_BYTES) await flush();
      if (size >= IO_BYTES) await handle.writeFile(line);
      else { pending.push(line); bytes += size; }
    },
  };
}

/** Byte-bounded external sort: at most one chunk or two merge records in memory. */
export async function buildBotSkillQueryIndex(root: string, source: AsyncIterable<BotSkillSummary>): Promise<string> {
  const directory = path.join(root, '.runtime-skills');
  await fs.mkdir(directory, { recursive: true });
  const staging = await fs.mkdtemp(path.join(directory, 'query-'));
  const catalog = path.join(directory, 'query-catalog.jsonl');
  let sequence = 0;
  const nextFile = () => path.join(staging, `${sequence++}.jsonl`);
  try {
    let runs: string[] = [];
    let chunk: BotSkillSummary[] = [];
    let bytes = 0;
    const spill = async () => {
      const file = nextFile();
      const handle = await fs.open(file, 'wx', 0o600);
      try {
        const writer = bufferedWriter(handle);
        chunk.sort(compare);
        for (const item of chunk) await writer.write(item);
        await writer.flush();
      } finally { await handle.close(); }
      runs.push(file); chunk = []; bytes = 0;
    };
    for await (const item of source) {
      const size = Buffer.byteLength(JSON.stringify(item));
      if (chunk.length && bytes + size > SORT_BYTES) await spill();
      chunk.push(item); bytes += size;
      if (bytes >= SORT_BYTES) await spill();
    }
    if (chunk.length || !runs.length) await spill();
    while (runs.length > 1) {
      const merged: string[] = [];
      for (let index = 0; index < runs.length; index += 2) {
        if (index + 1 === runs.length) { merged.push(runs[index]); continue; }
        const output = nextFile();
        const handle = await fs.open(output, 'wx', 0o600);
        const left = records(runs[index]);
        const right = records(runs[index + 1]);
        try {
          const writer = bufferedWriter(handle);
          let a = await left.next(); let b = await right.next();
          while (!a.done || !b.done) {
            if (b.done || (!a.done && compare(a.value, b.value) <= 0)) {
              await writer.write(a.value!); a = await left.next();
            } else { await writer.write(b.value); b = await right.next(); }
          }
          await writer.flush();
        } finally {
          await Promise.all([left.return(undefined), right.return(undefined), handle.close()]);
        }
        await Promise.all([fs.unlink(runs[index]), fs.unlink(runs[index + 1])]);
        merged.push(output);
      }
      runs = merged;
    }
    // Keep a previous complete catalog usable if enumeration or sorting fails.
    await fs.rename(runs[0], catalog);
    return catalog;
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

export async function queryBotSkillIndex(
  root: string, userDataDir: string, botId: string,
  params: { query?: string; offset?: number; limit?: number },
) {
  const catalog = path.join(root, '.runtime-skills/query-catalog.jsonl');
  await cachedBotSkillRuntime(root, async () => ({
    pluginRoot: root, skills: [],
    artifacts: [await buildBotSkillQueryIndex(root, iterateBotSkillQuerySummaries(userDataDir, botId))],
  }), 'query');
  return searchBotSkillQueryIndex(catalog, params);
}

/** Search a stable catalog stream, retaining only the requested bounded page. */
export async function searchBotSkillQueryIndex(catalog: string, params: { query?: string; offset?: number; limit?: number }) {
  const terms = (params.query ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const offset = Math.max(0, Math.floor(params.offset ?? 0));
  const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 20)));
  const skills: ReturnType<typeof botSkillRuntimeSummary>[] = [];
  let total = 0; let bytes = 0; let full = false;
  for await (const item of records(catalog)) {
    if (terms.length) {
      const text = `${item.slug}\n${item.name}\n${item.description}`.toLocaleLowerCase();
      if (!terms.every(term => text.includes(term))) continue;
    }
    if (total++ < offset || full) continue;
    const summary = botSkillRuntimeSummary(item);
    const size = Buffer.byteLength(JSON.stringify(summary));
    if (skills.length && bytes + size > BOT_SKILL_RUNTIME_INDEX_BYTES) { full = true; continue; }
    skills.push(summary); bytes += size;
    if (skills.length >= limit) full = true;
  }
  const next = offset + skills.length;
  return { skills, total, ...(next < total ? { nextOffset: next } : {}) };
}
