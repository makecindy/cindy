import { expect, it, vi } from 'vitest';
import { createImportBudget, deserializeImportSnapshot, readImportFile, readImportTree, reserveSnapshotItems, serializeImportSnapshot, snapshotFingerprint, snapshotFingerprintAsync } from '../files.js';
import { readImportSkillTree } from '../skills.js';
import type { ImportSnapshot } from '../types.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

it('reads an explicit native memory file link without granting traversal of external directories', async ctx => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-file-link-'));
  try {
    const memory = path.join(root, 'memory'), shared = path.join(root, 'shared');
    await fs.mkdir(memory); await fs.mkdir(shared);
    const sharedRoot = await fs.realpath(shared);
    const target = path.join(shared, 'state.json'), link = path.join(memory, 'state.json');
    await fs.writeFile(target, '{"cursor":7}');
    try { await fs.symlink(target, link, 'file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { ctx.skip(); return; } throw error; }
    await expect(readImportFile(memory, link)).rejects.toThrow('SOURCE_LINK_OUTSIDE_FOLDER');
    expect(await readImportTree(memory, undefined, createImportBudget(), undefined, memory, [sharedRoot])).toMatchObject([
      { name: 'state.json', bytes: Buffer.from('{"cursor":7}') },
    ]);
    await expect(readImportFile(memory, link, createImportBudget(1), [sharedRoot])).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
    const credential = path.join(root, 'private-token');
    await fs.writeFile(credential, 'fixture-private-credential');
    await fs.unlink(link); await fs.symlink(credential, link, 'file');
    await expect(readImportFile(memory, link, undefined, [sharedRoot])).rejects.toThrow('SOURCE_LINK_OUTSIDE_FOLDER');
    await fs.unlink(link); await fs.symlink(target, link, 'file');
    const directory = path.join(memory, 'external');
    await fs.symlink(shared, directory, process.platform === 'win32' ? 'junction' : 'dir');
    const errors = vi.fn();
    expect(await readImportTree(memory, undefined, createImportBudget(), errors, memory, [sharedRoot])).toHaveLength(1);
    expect(errors).toHaveBeenCalledWith('external', expect.objectContaining({ code: 'SOURCE_LINK_OUTSIDE_FOLDER' }), 'directory');
    await expect(readImportFile(memory, path.join(directory, 'state.json'), undefined, [sharedRoot])).rejects.toThrow('SOURCE_LINK_OUTSIDE_FOLDER');
    await expect(readImportFile(memory, target, undefined, [sharedRoot])).rejects.toThrow('SOURCE_LINK_OUTSIDE_FOLDER');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('rejects the next file before allocating its buffer when the cumulative budget is exhausted', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-budget-test-'));
  try {
    const file = path.join(root, 'resource');
    await fs.writeFile(file, '1234');
    const budget = createImportBudget(270);
    expect((await readImportFile(root, file, budget)).bytes.toString()).toBe('1234');
    const allocate = vi.spyOn(Buffer, 'alloc');
    try {
      await expect(readImportFile(root, file, budget)).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
      expect(allocate).not.toHaveBeenCalled();
    } finally { allocate.mockRestore(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('hashes binary contents and checkpoints compactly without invoking Buffer.toJSON', () => {
  const snapshot: ImportSnapshot = {
    source: { kind: 'hermes', name: 'Fixture', agentId: 'fixture', root: '/fixture', workspace: '/fixture', configFile: '/fixture/config' },
    fingerprint: 'fixture', items: [
      { view: { id: 'skill', category: 'skills', name: 'skill', selected: true }, files: [{ name: 'data.bin', bytes: Buffer.alloc(256 * 1024, 255), executable: false }] },
      { view: { id: 'script', category: 'connections', name: 'script', selected: true }, asset: { name: 'script.py', bytes: Buffer.from('print(1)') } },
    ],
  };
  const legacy = JSON.stringify(snapshot);
  const stringifyBuffer = vi.spyOn(Buffer.prototype, 'toJSON').mockImplementation(() => { throw new Error('numeric buffer expansion'); });
  try {
    const hash = snapshotFingerprint(snapshot.items);
    const checkpoint = serializeImportSnapshot(snapshot);
    expect(checkpoint.length).toBeLessThan(400_000);
    expect(deserializeImportSnapshot(checkpoint)).toEqual(snapshot);
    expect(deserializeImportSnapshot(legacy)).toEqual(snapshot);
    expect(snapshotFingerprint(deserializeImportSnapshot(checkpoint).items)).toBe(hash);
    snapshot.items[0]!.files![0]!.bytes[0] = 254;
    expect(snapshotFingerprint(snapshot.items)).not.toBe(hash);
    expect(stringifyBuffer).not.toHaveBeenCalled();
  } finally { stringifyBuffer.mockRestore(); }
});

it('reads every resource in a skill with more than 4096 small files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-many-files-'));
  try {
    for (let first = 0; first < 4100; first += 32) await Promise.all(Array.from({ length: Math.min(32, 4100 - first) }, (_, offset) => {
      const index = first + offset;
      return fs.writeFile(path.join(root, `resource-${index}.txt`), `Resource ${index}`);
    }));
    const files = await readImportTree(root, undefined, createImportBudget());
    expect(files).toHaveLength(4100);
    expect(files.find(file => file.name === 'resource-4099.txt')?.bytes.toString()).toBe('Resource 4099');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 180_000);

it('charges metadata for empty files and stops streaming instead of retaining unlimited errors', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-empty-files-'));
  try {
    for (let index = 0; index < 20; index++) await fs.writeFile(path.join(root, `${index}.txt`), '');
    const onError = vi.fn();
    await expect(readImportTree(root, undefined, createImportBudget(1000), onError)).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
    expect(onError).not.toHaveBeenCalled();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('retries a selected subtree inside its original root and still rejects escapes and cycles', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-subtree-'));
  try {
    const memory = path.join(root, 'memory'); const outside = path.join(root, 'outside');
    await fs.mkdir(memory); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'note.md'), 'Outside');
    const link = path.join(memory, 'broken');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(outside, link, linkType);
    const failures: unknown[] = [];
    expect(await readImportTree(memory, undefined, createImportBudget(), (name, error, kind) => failures.push([name, (error as Error).message, kind]))).toEqual([]);
    expect(failures).toEqual([['broken', 'SOURCE_LINK_OUTSIDE_FOLDER', 'directory']]);
    await expect(readImportTree(memory, undefined, createImportBudget(), undefined, link)).rejects.toThrow('SOURCE_LINK_OUTSIDE_FOLDER');
    await fs.rm(link, { recursive: true });
    await fs.symlink(memory, link, linkType);
    await expect(readImportTree(memory, undefined, createImportBudget(), undefined, link)).rejects.toThrow('SOURCE_LINK_CYCLE');
    await fs.rm(link, { recursive: true });
    await fs.mkdir(link); await fs.writeFile(path.join(link, 'note.md'), 'Repaired');
    const files = await readImportTree(memory, undefined, createImportBudget(), undefined, link);
    expect(files.map(file => [file.name, file.bytes.toString()])).toEqual([['broken/note.md', 'Repaired']]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('copies native venv interpreter aliases while keeping unrelated external links rejected', async ctx => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-venv-'));
  try {
    const skill = path.join(root, 'skill'), runtime = path.join(root, 'runtime');
    const binName = `.venv/${process.platform === 'win32' ? 'Scripts' : 'bin'}`;
    const bin = path.join(skill, binName);
    await fs.mkdir(bin, { recursive: true }); await fs.mkdir(runtime);
    await fs.writeFile(path.join(skill, 'SKILL.md'), '# Fixture');
    await fs.writeFile(path.join(skill, '.venv/pyvenv.cfg'), `home = ${runtime}\n`);
    const executable = Buffer.from('7f454c460102030405060708', 'hex');
    await fs.writeFile(path.join(runtime, 'python3.12'), executable, { mode: 0o700 });
    try { await fs.symlink(path.join(runtime, 'python3.12'), path.join(bin, 'python'), 'file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { ctx.skip(); return; } throw error; }
    await fs.symlink('python', path.join(bin, 'python3'), 'file');
    const files = await readImportSkillTree(skill, undefined, createImportBudget());
    for (const name of [`${binName}/python`, `${binName}/python3`]) expect(files.find(file => file.name === name)).toMatchObject({ bytes: executable, interpreterLink: await fs.realpath(path.join(runtime, 'python3.12')) });
    expect(files.find(file => file.name === '.venv/pyvenv.cfg')?.bytes.toString()).toContain(runtime);
    await fs.writeFile(path.join(runtime, 'private.txt'), 'fixture-private-token');
    await fs.symlink(path.join(runtime, 'private.txt'), path.join(skill, 'credentials.txt'), 'file');
    await expect(readImportSkillTree(skill)).rejects.toThrow('SOURCE_LINK_OUTSIDE_FOLDER');
    await fs.unlink(path.join(skill, 'credentials.txt'));
    await fs.writeFile(path.join(runtime, 'python3.12'), 'fixture-private-token');
    await expect(readImportSkillTree(skill)).rejects.toThrow('SOURCE_LINK_OUTSIDE_FOLDER');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it.each(['items', 'files'] as const)('counts a 100,000-entry %s snapshot incrementally and yields without serializing its graph', async kind => {
  const file = { name: 'empty', bytes: Buffer.alloc(0), executable: false };
  const view = { id: 'skill', name: 'Fixture', category: 'skills' as const, selected: true };
  const items = kind === 'items' ? Array.from({ length: 100_000 }, () => ({ view }))
    : [{ view, files: Array.from({ length: 100_000 }, () => file) }];
  const stringify = JSON.stringify;
  const serialize = vi.spyOn(JSON, 'stringify').mockImplementation((value, ...args) => {
    if (value && typeof value === 'object') throw new Error('snapshot graph serialized');
    return stringify(value, ...args);
  });
  let bytes = 0, files = 0, yielded = false;
  const turn = new Promise<void>(resolve => setImmediate(() => { yielded = true; resolve(); }));
  try {
    await reserveSnapshotItems(items, { reserve: size => { bytes += size; }, reserveFile: size => { bytes += size + 256; files++; } });
    expect(bytes).toBeGreaterThan(100_000);
    expect(files).toBe(kind === 'files' ? 100_000 : 0);
    expect(yielded).toBe(true);
    expect(items[0]?.view).toBe(view);
  } finally { serialize.mockRestore(); await turn; }
});

it('preserves exact legacy budget bytes and fingerprints across streamed string/file boundaries', async () => {
  const text = 'x'.repeat(16 * 1024 - 1) + '😀漢\u0000\n"\\' + '\ud800';
  const files = [{ name: 'empty', bytes: Buffer.alloc(0), executable: false },
    { name: 'binary', bytes: Buffer.alloc(128 * 1024, 255), executable: true }];
  const items = [{ view: { id: 'fixture', name: text, category: 'memory' as const, selected: true }, files,
    asset: { name: 'asset', bytes: Buffer.from('fixture') },
    credential: { format: 'fixture', value: {
      when: new Date('2026-09-29T00:00:00Z'), list: [null, false, undefined, 7, Infinity],
      strings: ['', '😀漢\u0000\n"\\\ud800', '\u0000'.repeat(16 * 1024)],
      omitted: undefined, hidden: { toJSON: () => undefined },
    } }, text }];
  const mapped = items.map(item => ({ ...item, files: item.files.map(file => ({ ...file, bytes: null })), asset: { ...item.asset, bytes: null } }));
  const expected = Buffer.byteLength(JSON.stringify(mapped)) + files.reduce((total, file) => total + file.bytes.length + 256, 0) + items[0]!.asset.bytes.length + 256;
  const before = serializeImportSnapshot({ source: {} as never, fingerprint: 'fixture', items });
  await reserveSnapshotItems(items, createImportBudget(expected));
  await expect(reserveSnapshotItems(items, createImportBudget(expected - 1))).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
  expect(await snapshotFingerprintAsync(items)).toBe(snapshotFingerprint(items));
  expect(serializeImportSnapshot({ source: {} as never, fingerprint: 'fixture', items })).toBe(before);
});

it('stops streamed accounting on budget exhaustion and on an owner change', async () => {
  const view = { id: 'fixture', name: 'Fixture', category: 'memory' as const, selected: true };
  const read = vi.fn(() => 'tail should stay unread');
  const tail = { view, get text() { return read(); } };
  const items = [{ view, text: 'x'.repeat(1024 * 1024) }, tail];
  await expect(reserveSnapshotItems(items, createImportBudget(1000))).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
  expect(read).not.toHaveBeenCalled();
  let changed = false;
  const turn = new Promise<void>(resolve => setImmediate(() => { changed = true; resolve(); }));
  await expect(reserveSnapshotItems(items, createImportBudget(), () => {
    if (changed) throw new Error('OWNER_CHANGED');
  })).rejects.toThrow('OWNER_CHANGED');
  expect(read).not.toHaveBeenCalled();
  await turn;
});

it('accounts a near-budget binary snapshot without serializing or copying its buffers', async () => {
  const bytes = Buffer.alloc(16 * 1024 * 1024, 1);
  const items = Array.from({ length: 7 }, (_, index) => ({
    view: { id: `fixture-${index}`, name: 'Fixture', category: 'memory' as const, selected: true },
    asset: { name: `${index}.bin`, bytes },
  }));
  const toJSON = vi.spyOn(Buffer.prototype, 'toJSON').mockImplementation(() => { throw new Error('buffer copied'); });
  try {
    await reserveSnapshotItems(items, createImportBudget());
    expect(items.every(item => item.asset.bytes === bytes)).toBe(true);
    await expect(reserveSnapshotItems([...items, ...items.slice(0, 2)], createImportBudget())).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
    expect(toJSON).not.toHaveBeenCalled();
  } finally { toJSON.mockRestore(); }
});
