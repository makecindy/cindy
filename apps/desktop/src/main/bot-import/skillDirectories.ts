import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ImportReadBudget } from './files.js';

type Entry = { name: string; directory: boolean };
const SORT_BYTES = 256 * 1024;
const IO_BYTES = 64 * 1024;
const compare = (a: Entry, b: Entry) => a.name.localeCompare(b.name);

async function* records(file: string): AsyncGenerator<Entry> {
  const handle = await fs.open(file, 'r');
  const buffer = Buffer.alloc(IO_BYTES);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      let start = 0; let end: number;
      while ((end = pending.indexOf('\n', start)) >= 0) {
        yield JSON.parse(pending.slice(start, end)) as Entry;
        start = end + 1;
      }
      pending = pending.slice(start);
    }
    if (pending || decoder.end()) throw new Error('Incomplete Skill directory sort');
  } finally { await handle.close(); }
}

function writer(handle: FileHandle) {
  let pending: string[] = []; let bytes = 0;
  const flush = async () => {
    if (pending.length) await handle.writeFile(pending.join(''));
    pending = []; bytes = 0;
  };
  return { flush, async write(entry: Entry) {
    const line = JSON.stringify(entry) + '\n';
    const size = Buffer.byteLength(line);
    if (bytes + size > IO_BYTES) await flush();
    if (size >= IO_BYTES) await handle.writeFile(line);
    else { pending.push(line); bytes += size; }
  } };
}

async function merge(leftFile: string, rightFile: string, output: string): Promise<void> {
  const handle = await fs.open(output, 'wx', 0o600);
  const left = records(leftFile); const right = records(rightFile);
  try {
    const target = writer(handle);
    let a = await left.next(); let b = await right.next();
    while (!a.done || !b.done) {
      // Stable ties retain the original opendir order, matching Array.sort.
      if (b.done || (!a.done && compare(a.value, b.value) <= 0)) {
        await target.write(a.value!); a = await left.next();
      } else { await target.write(b.value); b = await right.next(); }
    }
    await target.flush();
  } finally {
    await Promise.all([left.return(undefined), right.return(undefined), handle.close()]);
  }
  await Promise.all([fs.unlink(leftFile), fs.unlink(rightFile)]);
}

/** Preserve native alphabetical precedence without retaining a directory's Dirents.
 * Large roots use byte-bounded runs and a logarithmic list of merge levels. Only
 * names/types go to a private OS temporary directory, never Skill contents. */
export async function* orderedSkillDirectories(directory: string, budget: ImportReadBudget): AsyncGenerator<Entry> {
  let staging: string | undefined; let sequence = 0;
  let chunk: Entry[] = []; let bytes = 0;
  const levels: Array<string | undefined> = [];
  const nextFile = () => path.join(staging!, `${sequence++}.jsonl`);
  const combine = async (left: string, right: string) => {
    const output = nextFile(); await merge(left, right, output); return output;
  };
  const spill = async () => {
    staging ??= await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-skill-sort-'));
    let file = nextFile();
    const handle = await fs.open(file, 'wx', 0o600);
    try {
      const target = writer(handle);
      chunk.sort(compare);
      for (const entry of chunk) await target.write(entry);
      await target.flush();
    } finally { await handle.close(); }
    chunk = []; bytes = 0;
    // Merge while enumerating; even the list of run filenames stays bounded.
    let level = 0;
    while (levels[level]) {
      file = await combine(levels[level]!, file);
      levels[level++] = undefined;
    }
    levels[level] = file;
  };
  try {
    for await (const entry of await fs.opendir(directory)) {
      const size = 128 + Buffer.byteLength(path.join(directory, entry.name));
      budget.reserve(size);
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (chunk.length && bytes + size > SORT_BYTES) await spill();
      chunk.push({ name: entry.name, directory: entry.isDirectory() }); bytes += size;
      if (bytes >= SORT_BYTES) await spill();
    }
    if (!staging) { yield* chunk.sort(compare); return; }
    if (chunk.length) await spill();
    let file: string | undefined;
    // Higher levels contain earlier entries; preserve their precedence on ties.
    for (let level = levels.length - 1; level >= 0; level--) {
      if (levels[level]) file = file ? await combine(file, levels[level]!) : levels[level];
    }
    if (file) yield* records(file);
  } finally {
    if (staging) await fs.rm(staging, { recursive: true, force: true });
  }
}
