import { beforeEach, expect, it, vi } from 'vitest';
import { ClipboardSync, type RemoteDesktopRequest } from '@cindy/device-link';
const h = vi.hoisted(() => ({ text: 'text', read: vi.fn() }));
vi.mock('../linuxClipboardNative', () => ({
  readLinuxClipboardSnapshot: async () => {
    h.read();
    if (h.text.length > 512000) throw new Error('CLIPBOARD_TOO_LONG');
    return { formats: ['text/plain'], content: { text: h.text } };
  },
}));
import { linuxClipboardVersion } from '../linuxClipboard';
beforeEach(() => {
  h.text = 'text';
  h.read.mockClear();
});
it('changes the opaque generation when clipboard contents change', async () => {
  const before = await linuxClipboardVersion();
  expect(await linuxClipboardVersion()).toBe(before);
  expect(before).toMatch(/^\d{1,128}$/);
  h.text = 'different';
  expect(await linuxClipboardVersion()).not.toBe(before);
});
it('feeds the existing cross-device sync engine in both directions without changing its wire contract', async () => {
  let local = JSON.stringify({ text: 'controller baseline' });
  let counter = 1;
  const writeLocal = vi.fn(async (json: string, version: string) => {
    expect(version).toBe(String(counter));
    local = json;
    return String(++counter);
  });
  const writes: string[] = [];
  const request = async <T>(message: RemoteDesktopRequest): Promise<T> => {
    if (message.op === 'clipboardVersion') return { version: await linuxClipboardVersion() } as T;
    if (message.op !== 'clipboardContent') throw new Error('unexpected operation');
    expect(message.sync).toBe(true);
    expect(message.version).toBe(await linuxClipboardVersion());
    if (message.action === 'copy') {
      const data = JSON.stringify({ text: h.text });
      return { length: data.length, data } as T;
    }
    if (message.action !== 'paste') throw new Error('unexpected clipboard action');
    h.text = JSON.parse(message.data).text;
    writes.push(h.text);
    return { version: await linuxClipboardVersion() } as T;
  };
  const sync = new ClipboardSync({
    lease: 'test-lease',
    current: () => true,
    inline: true,
    digest: (json) => json,
    request,
    localVersion: async () => String(counter),
    readLocal: async () => local,
    writeLocal,
  });
  await sync.tick();
  expect(writeLocal).not.toHaveBeenCalled();
  expect(writes).toEqual([]);
  h.text = 'Linux → controller 中文 😀';
  await sync.tick();
  expect(JSON.parse(local).text).toBe(h.text);
  expect(writeLocal).toHaveBeenCalledOnce();
  local = JSON.stringify({ text: 'controller → Linux 中文 👩‍💻' });
  counter++;
  await sync.tick();
  expect(writes).toEqual(['controller → Linux 中文 👩‍💻']);
  await sync.tick();
  expect(writes).toHaveLength(1);
  expect(writeLocal).toHaveBeenCalledOnce();
});
it('bounds content and returns no sampled text in an error', async () => {
  h.text = 'private'.repeat(100000);
  await expect(linuxClipboardVersion()).rejects.toThrow('CLIPBOARD_TOO_LONG');
});
