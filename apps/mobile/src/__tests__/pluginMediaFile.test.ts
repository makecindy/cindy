import { describe, expect, it, vi } from 'vitest';
const disk = vi.hoisted(() => ({ chunks: [] as Uint8Array[], closes: 0, removed: [] as string[] }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (size: number) => new Uint8Array(size).fill(3) }));
vi.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  Directory: class {
    uri: string; exists = false;
    constructor(...parts: string[]) { this.uri = parts.join('/'); }
    create() { this.exists = true; }
    delete() { this.exists = false; disk.removed.push(this.uri); }
  },
  File: class {
    uri: string;
    constructor(directory: { uri: string }, name: string) { this.uri = `${directory.uri}/${name}`; }
    create() {}
    open() { return { writeBytes: (bytes: Uint8Array) => disk.chunks.push(bytes), close: () => { disk.closes++; } }; }
  },
}));
import { readPluginMediaFile } from '../plugins/pluginMediaFile';
describe('native plugin media file ownership', () => {
  it('writes ordered chunks, validates content type and cleans its own cache after close or cancellation', async () => {
    const path = '/media/' + 'a'.repeat(64) + '.png', abort = new AbortController();
    const read = vi.fn(async (_path, offset: number) => ({ status: 200, mime: 'image/png', base64: offset === 0 ? 'YWJj' : 'ZA==', ...(offset === 0 ? { nextOffset: 3 } : {}) }));
    const file = await readPluginMediaFile(path, 'image', read, abort.signal);
    expect(read.mock.calls).toEqual([[path, 0], [path, 3]]);
    expect(Buffer.concat(disk.chunks).toString()).toBe('abcd');
    expect(disk.closes).toBe(1); expect(disk.removed).toHaveLength(0);
    file.close(); expect(disk.removed).toHaveLength(1);
    await expect(readPluginMediaFile(path, 'video', read, abort.signal)).rejects.toThrow('PLUGIN_MEDIA_INVALID');
    expect(disk.closes).toBe(2); expect(disk.removed).toHaveLength(2);
    const late = vi.fn(async () => { abort.abort(); return { status: 200, mime: 'image/png', base64: 'YWJj' }; });
    await expect(readPluginMediaFile(path, 'image', late, abort.signal)).rejects.toThrow('PLUGIN_MEDIA_CLOSED');
    expect(disk.removed).toHaveLength(3); expect(disk.chunks).toHaveLength(2);
  });
});
