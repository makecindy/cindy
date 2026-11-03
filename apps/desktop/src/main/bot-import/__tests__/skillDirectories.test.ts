import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orderedSkillDirectories } from '../skillDirectories.js';
import { createImportBudget } from '../files.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-skill-directories-test-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

function source(count: number, failAt = -1, nameFor = (index: number) => `${String(index).padStart(6, '0')}-中文-"line\n${'x'.repeat(80)}`) {
  let closed = false; let read = 0;
  const names: string[] = [];
  vi.spyOn(fs, 'opendir').mockImplementation(async () => ({ async *[Symbol.asyncIterator]() {
    try {
      for (let index = count - 1; index >= 0; index--) {
        if (read === failAt) throw Object.assign(new Error('fixture enumeration failure'), { code: 'EIO' });
        const name = nameFor(index);
        names.push(name); read++;
        yield { name, isDirectory: () => index % 2 === 0, isSymbolicLink: () => index % 2 !== 0 };
      }
    } finally { closed = true; }
  } }) as Awaited<ReturnType<typeof fs.opendir>>);
  return { names, get closed() { return closed; }, get read() { return read; } };
}

function trackStaging() {
  const original = fs.mkdtemp.bind(fs); const paths: string[] = [];
  vi.spyOn(fs, 'mkdtemp').mockImplementation(async (...args) => {
    const result = await original(...args);
    paths.push(String(result)); return result;
  });
  return paths;
}

async function expectRemoved(paths: string[]) {
  expect(paths.length).toBeGreaterThan(0);
  for (const directory of paths) await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
}

it('sorts a small real directory without creating temporary files and still charges regular files', async () => {
  await fs.mkdir(path.join(root, 'z-last')); await fs.mkdir(path.join(root, 'a-first'));
  await fs.writeFile(path.join(root, 'ordinary.txt'), 'fixture');
  const staging = trackStaging(); const budget = createImportBudget();
  const reserve = vi.spyOn(budget, 'reserve');
  const entries = [];
  for await (const entry of orderedSkillDirectories(root, budget)) entries.push(entry);
  expect(entries).toEqual([{ name: 'a-first', directory: true }, { name: 'z-last', directory: true }]);
  expect(reserve).toHaveBeenCalledTimes(3);
  expect(staging).toEqual([]);
});

it('spills while enumeration is still in progress and preserves every name/type in native sorted order', async () => {
  const input = source(10_003); const staging = trackStaging();
  const open = fs.open.bind(fs); let writesBeforeEnd = 0; let maxWriteBytes = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'wx') {
      expect(args[2]).toBe(0o600);
      if (input.read < 10_003) writesBeforeEnd++;
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async (...values) => {
        maxWriteBytes = Math.max(maxWriteBytes, Buffer.byteLength(String(values[0])));
        return write(...values);
      });
    }
    return handle;
  });
  const entries = [];
  for await (const entry of orderedSkillDirectories(root, createImportBudget())) entries.push(entry);
  expect(entries.map(entry => entry.name)).toEqual([...input.names].sort((a, b) => a.localeCompare(b)));
  expect(entries.every(entry => entry.directory === (Number(entry.name.slice(0, 6)) % 2 === 0))).toBe(true);
  expect(writesBeforeEnd).toBeGreaterThan(0);
  expect(maxWriteBytes).toBeLessThanOrEqual(64 * 1024);
  expect(input.closed).toBe(true);
  expect(staging).toHaveLength(1);
  await expectRemoved(staging);
});

it('retains native stable precedence for equal collations across separate sort runs', async () => {
  expect('tie-é'.localeCompare('tie-e\u0301')).toBe(0);
  const input = source(10_003, -1, index => index === 10_002 ? 'tie-é' : index === 0 ? 'tie-e\u0301' : `z-${index}`);
  const staging = trackStaging(); const names = [];
  for await (const entry of orderedSkillDirectories(root, createImportBudget())) names.push(entry.name);
  expect(names).toEqual([...input.names].sort((a, b) => a.localeCompare(b)));
  expect(names.slice(0, 2)).toEqual(['tie-é', 'tie-e\u0301']);
  await expectRemoved(staging);
});

it.each(['budget', 'enumeration', 'write', 'merge-read', 'consumer'] as const)('closes and cleans up after %s interrupts a spilled directory', async failure => {
  const input = source(10_000, failure === 'enumeration' ? 4_000 : -1);
  const staging = trackStaging();
  const open = fs.open.bind(fs); const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  let writes = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (failure === 'write' && args[1] === 'wx' && ++writes === 2) throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
    const handle = await open(...args); handles.push(handle);
    if (failure === 'merge-read' && args[1] === 'r') vi.spyOn(handle, 'read').mockRejectedValue(Object.assign(new Error('fixture read failure'), { code: 'EIO' }));
    return handle;
  });
  const collect = async () => {
    for await (const entry of orderedSkillDirectories(root, createImportBudget(failure === 'budget' ? 1024 * 1024 : undefined))) {
      expect(entry.name).toBeTruthy();
      if (failure === 'consumer') break;
    }
  };
  if (failure === 'consumer') await collect();
  else if (failure === 'budget') await expect(collect()).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
  else await expect(collect()).rejects.toMatchObject({ code: failure === 'write' ? 'ENOSPC' : 'EIO' });
  expect(input.closed).toBe(true);
  for (const handle of handles) await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
  await expectRemoved(staging);
});
