import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ files: new Map<string, string>(), failMove: false, failWrite: false }));
vi.mock('expo-file-system', () => {
  class Directory {
    uri: string;
    constructor(parent: string, name: string) { this.uri = `${parent}/${name}`; }
    create() {}
  }
  class File {
    uri: string;
    constructor(parent: Directory | string, name?: string) {
      this.uri = name ? `${typeof parent === 'string' ? parent : parent.uri}/${name}` : String(parent);
    }
    get exists() { return state.files.has(this.uri); }
    text() { return Promise.resolve(state.files.get(this.uri)); }
    delete() { state.files.delete(this.uri); }
    moveSync(destination: File) {
      if (state.failMove) throw new Error('move failed');
      state.files.set(destination.uri, state.files.get(this.uri)!);
      state.files.delete(this.uri);
      // Expo mutates the source object after a move.
      this.uri = destination.uri;
    }
  }
  return { Directory, File, Paths: { cache: 'file:///cache' } };
});
vi.mock('expo-file-system/legacy', () => ({
  writeAsStringAsync: async (uri: string, text: string) => {
    state.files.set(uri, text);
    if (state.failWrite) throw new Error('write failed');
  },
}));
import { createHistoryDiskIO } from '../session/historyDiskStoreExpo';

beforeEach(() => { state.files.clear(); state.failMove = false; state.failWrite = false; });
describe('Expo history disk IO', () => {
  it('keeps committed snapshots and the index after moving the staging file', async () => {
    const io = createHistoryDiskIO();
    await io.write('view-a.json', 'first');
    await io.write('view-a.json', 'updated');
    await io.write('index.json', '{}');
    expect(await io.read('view-a.json')).toBe('updated');
    expect(await io.read('index.json')).toBe('{}');
    expect(state.files.size).toBe(2);
    expect([...state.files.keys()].some(key => key.endsWith('.tmp'))).toBe(false);
  });
  it.each(['failMove', 'failWrite'] as const)('cleans staging files after %s without deleting the previous snapshot', async failure => {
    const io = createHistoryDiskIO();
    await io.write('view-a.json', 'original');
    state[failure] = true;
    await expect(io.write('view-a.json', 'replacement')).rejects.toThrow();
    expect(await io.read('view-a.json')).toBe('original');
    expect(state.files.size).toBe(1);
  });
});
