import { describe, it, expect, vi } from 'vitest';
import { HistoryDiskStore, HISTORY_DISK_BUDGET_BYTES, HISTORY_DISK_ITEM_BYTES, historyValueBytes, type HistoryDiskIO } from '../session/historyDiskStore';

function fixture(budget = HISTORY_DISK_BUDGET_BYTES) {
  const files = new Map<string, string>();
  const io: HistoryDiskIO = {
    read: vi.fn(async name => files.get(name) ?? null),
    write: vi.fn(async (name, text) => { files.set(name, text); }),
    remove: vi.fn(async name => { files.delete(name); }),
    files: vi.fn(async () => [...files.keys()]),
  };
  return { files, io, cache: new HistoryDiskStore(io, budget) };
}
const current = () => true;
describe('history disk cache', () => {
  it('bounds nested accounting without copying or visiting the remaining details', () => {
    const late = vi.fn(() => 'must not visit');
    const value = ['x'.repeat(1000), { get content() { return late(); } }];
    expect(historyValueBytes(value, 100)).toBe(Infinity);
    expect(late).not.toHaveBeenCalled();
    const small = { text: '\u0000中😀', values: [null, true, 1] };
    expect(historyValueBytes(small, 10000)).toBeGreaterThan(new TextEncoder().encode(JSON.stringify(small)).length);
  });
  it('rejects a giant string before encoding and does not read oversized legacy bodies', async () => {
    const h = fixture(HISTORY_DISK_BUDGET_BYTES);
    await h.cache.write('big', 'x'.repeat(HISTORY_DISK_ITEM_BYTES + 1), current);
    expect(h.io.write).not.toHaveBeenCalled();
    h.files.set('index.json', JSON.stringify({ old: { file: 'view-old.json', bytes: HISTORY_DISK_ITEM_BYTES + 1, accessed: 1 } }));
    h.files.set('view-old.json', 'large legacy body');
    expect(await new HistoryDiskStore(h.io).read('old', current)).toBeNull();
    expect(h.io.read).not.toHaveBeenCalledWith('view-old.json');
  });
  it('has no total quota and survives a new store without reading every body', async () => {
    expect(HISTORY_DISK_BUDGET_BYTES).toBe(Infinity);
    const h = fixture();
    await h.cache.write('first', 'hello', current);
    await h.cache.write('second', 'world', current);
    vi.mocked(h.io.read).mockClear();
    const restarted = new HistoryDiskStore(h.io);
    expect(await restarted.read('first', current)).toBe('hello');
    expect(h.io.read).toHaveBeenCalledTimes(2); // index and requested body only
  });
  it('retains existing history above the old GiB quota when adding another view', async () => {
    const h = fixture();
    const index: Record<string, unknown> = {};
    for (let i = 0; i < 140; i++) {
      const file = `view-${i}.json`;
      h.files.set(file, 'existing');
      index[String(i)] = { file, bytes: HISTORY_DISK_ITEM_BYTES, accessed: i };
    }
    h.files.set('index.json', JSON.stringify(index));
    await h.cache.write('new', 'new body', current);
    expect(await h.cache.read('0', current)).toBe('existing');
    expect(h.io.remove).not.toHaveBeenCalled();
  });
  it('retains more than eight views and evicts by actual UTF-8 bytes', async () => {
    const h = fixture(30);
    for (let i = 0; i < 10; i++) await h.cache.write(String(i), '中', current);
    expect(await h.cache.read('0', current)).toBe('中');
    await h.cache.write('big', '中'.repeat(10), current);
    expect(await h.cache.read('0', current)).toBeNull();
    expect(await h.cache.read('big', current)).toBe('中'.repeat(10));
  });
  it('does not replace a good snapshot with an oversized write', async () => {
    const h = fixture(5);
    await h.cache.write('s', 'good', current);
    await h.cache.write('s', 'oversized', current);
    expect(await h.cache.read('s', current)).toBe('good');
  });
  it('clears only the selected scope and survives restart', async () => {
    const h = fixture();
    await h.cache.write('a', 'one', current);
    await h.cache.write('b', 'two', current);
    await h.cache.clear(key => key === 'a');
    const restarted = new HistoryDiskStore(h.io);
    expect(await restarted.read('a', current)).toBeNull();
    expect(await restarted.read('b', current)).toBe('two');
  });
  it('revokes an in-flight body write before clear can run', async () => {
    const h = fixture();
    let release!: () => void;
    const original = h.io.write;
    h.io.write = vi.fn(async (name, text) => {
      if (name.startsWith('view-')) await new Promise<void>(done => { release = done; });
      await original(name, text);
    });
    const write = h.cache.write('s', 'secret', current);
    await vi.waitFor(() => expect(release).toBeDefined());
    const clear = h.cache.clear();
    release();
    await Promise.all([write, clear]);
    expect(await h.cache.read('s', current)).toBeNull();
    expect([...h.files.keys()]).toEqual(['index.json']);
  });
  it('does not deliver a late read after its owner changes', async () => {
    const h = fixture();
    await h.cache.write('s', 'old owner', current);
    let active = true;
    const original = h.io.read;
    h.io.read = async name => { const value = await original(name); active = false; return value; };
    expect(await h.cache.read('s', () => active)).toBeNull();
  });
  it('recovers from a corrupt index and removes orphaned bodies', async () => {
    const h = fixture();
    h.files.set('index.json', '{'); h.files.set('view-orphan.json', 'discard');
    expect(await h.cache.read('s', current)).toBeNull();
    expect(h.files.has('view-orphan.json')).toBe(false);
    await h.cache.write('s', 'new', current);
    expect(await h.cache.read('s', current)).toBe('new');
  });
  it('keeps the previous body if committing the new index fails', async () => {
    const h = fixture();
    await h.cache.write('s', 'old', current);
    const original = h.io.write;
    h.io.write = async (name, text) => { if (name === 'index.json') throw Error('disk full'); await original(name, text); };
    await h.cache.write('s', 'new', current);
    h.io.write = original;
    expect(await h.cache.read('s', current)).toBe('old');
  });
  it('retries a failed body deletion without losing its index entry', async () => {
    const h = fixture();
    await h.cache.write('s', 'private', current);
    vi.mocked(h.io.remove).mockRejectedValueOnce(Error('temporarily busy'));
    await expect(h.cache.clear()).rejects.toThrow('temporarily busy');
    await h.cache.clear();
    expect(await new HistoryDiskStore(h.io).read('s', current)).toBeNull();
    expect([...h.files.keys()]).toEqual(['index.json']);
  });
});
