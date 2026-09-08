import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadRemoteMediaAsDataUri,
  withDownloadedRemoteMediaFile,
} from '@/session/remoteMediaDiskCacheExpo';

const io = vi.hoisted(() => ({
  size: 5,
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
    constructor(parent: { uri: string }, name: string) { this.uri = `${parent.uri}/${name}`; }
    get size() { return io.size; }
    async base64() { return 'aGVsbG8='; }
    delete() { io.remove(this.uri); }
    static downloadFileAsync = io.download;
  },
}));

beforeEach(() => {
  io.size = 5;
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

  it('preserves the existing inline-resource download contract', async () => {
    expect(await downloadRemoteMediaAsDataUri('https://example.com/image', 'image/png', 8))
      .toBe('data:image/png;base64,aGVsbG8=');
    expect(io.remove).toHaveBeenCalledOnce();
  });
});
