import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadRemoteMediaAsDataUri,
  withDownloadedRemoteMediaFile,
} from '@/session/remoteMediaDiskCacheExpo';

const io = vi.hoisted(() => ({
  size: 5,
  copying: new Set<string>(),
  copied: new Set<string>(),
  download: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///app/cache' },
  Directory: class {
    uri: string;
    constructor(parent: string, name: string) { this.uri = `${parent}/${name}`; }
    create() {}
  },
  File: class {
    uri: string;
    constructor(parent: { uri: string } | string, name?: string) {
      this.uri = typeof parent === 'string' ? parent : `${parent.uri}/${name}`;
    }
    // expo-file-system's File.copy is asynchronous; the destination is empty until it settles.
    async copy(target: { uri: string }) {
      io.copying.add(target.uri);
      await new Promise((done) => setTimeout(done, 0));
      io.copying.delete(target.uri);
      io.copied.add(target.uri);
    }
    get size() { return io.copying.has(this.uri) ? 0 : io.size; }
    async base64() { return 'aGVsbG8='; }
    delete() { io.remove(this.uri); }
    static downloadFileAsync = io.download;
  },
}));

beforeEach(() => {
  io.size = 5;
  io.copying.clear();
  io.copied.clear();
  io.remove.mockClear();
  io.download.mockReset().mockImplementation(async (_url, target) => target);
});

describe('bounded temporary media downloads', () => {
  it('keeps the file until the asynchronous consumer finishes, then removes it', async () => {
    let finish!: (value: string) => void;
    const read = vi.fn(() => new Promise<string>((done) => { finish = done; }));
    const result = withDownloadedRemoteMediaFile('https://example.com/image', 'image/png', 8, read);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(io.remove).not.toHaveBeenCalled();
    finish('dimensions and embedded bytes');
    expect(await result).toBe('dimensions and embedded bytes');
    expect(io.remove).toHaveBeenCalledExactlyOnceWith(io.download.mock.calls[0]![1].uri);
  });

  it.each([0, 9])('removes a %s-byte download without exposing it to the consumer', async (size) => {
    io.size = size;
    const read = vi.fn();
    expect(await withDownloadedRemoteMediaFile('https://example.com/image', 'image/png', 8, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(io.remove).toHaveBeenCalledOnce();
  });

  it.each(['download', 'read'])('removes partial files after a %s failure', async (failure) => {
    const read = vi.fn(async () => { throw new Error('read failed'); });
    if (failure === 'download') io.download.mockRejectedValueOnce(new Error('interrupted'));
    expect(await withDownloadedRemoteMediaFile('https://example.com/image', 'image/png', 8, read)).toBeNull();
    expect(io.remove).toHaveBeenCalledOnce();
  });

  it('waits for a direct-transfer copy before sizing or reading the file', async () => {
    const read = vi.fn(async (file: { uri: string }) => (io.copied.has(file.uri) ? 'copied' : 'missing'));
    expect(await withDownloadedRemoteMediaFile('file:///peer/staged', 'image/png', 8, read)).toBe('copied');
    expect(read).toHaveBeenCalledOnce();
    expect(io.download).not.toHaveBeenCalled();
  });

  it('preserves the existing inline-resource download contract', async () => {
    expect(await downloadRemoteMediaAsDataUri('https://example.com/image', 'image/png', 8))
      .toBe('data:image/png;base64,aGVsbG8=');
    expect(io.remove).toHaveBeenCalledOnce();
  });
});
