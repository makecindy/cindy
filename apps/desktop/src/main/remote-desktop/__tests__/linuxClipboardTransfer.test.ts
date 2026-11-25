import { beforeEach, expect, it, vi } from 'vitest';
import type { RemoteClipboardContent } from '@cindy/device-link';
const h = vi.hoisted(() => ({
  content: {} as RemoteClipboardContent,
  x11: false,
  write: vi.fn(),
  version: vi.fn(),
}));
vi.mock('../linuxX11Clipboard', () => ({ managedX11Clipboard: () => h.x11 }));
vi.mock('electron', () => ({
  clipboard: {},
  nativeImage: { createEmpty: () => ({ isEmpty: () => true }) },
}));
vi.mock('../inputHost', () => ({
  readDesktopSelection: async () => '',
  readDesktopClipboardVersion: h.version,
}));
vi.mock('../linuxClipboardNative', () => ({
  supportsLinuxClipboard: () => true,
  readLinuxClipboardSnapshot: async () => ({
    formats: ['text/plain', 'text/html'],
    content: h.content,
  }),
  writeLinuxClipboard: h.write,
}));
import { transferDesktopClipboardContent } from '../clipboard';
beforeEach(() => {
  h.x11 = false;
  h.content = { text: 'hello', html: '<b>hello</b>' };
  h.version.mockReset().mockResolvedValue('version');
  h.write.mockReset().mockImplementation(async (value) => {
    h.content = value;
  });
});
it('copies portable alternatives without consulting Electron clipboard', async () => {
  expect(
    await transferDesktopClipboardContent('copy', undefined, () => true, vi.fn(), { sync: true }),
  ).toEqual(h.content);
});
it('writes all formats and returns the verified generation without typing during sync', async () => {
  const input = vi.fn();
  const content = { text: 'updated', html: '<b>updated</b>', rtf: '{\\rtf1 updated}' };
  expect(
    await transferDesktopClipboardContent('paste', content, () => true, input, { sync: true }),
  ).toEqual({ version: 'version' });
  expect(h.write).toHaveBeenCalledWith(content, expect.any(Function));
  expect(input).not.toHaveBeenCalled();
});
it('does not inject paste after revocation while native writing completes', async () => {
  let current = true;
  h.write.mockImplementation(async (value) => {
    h.content = value;
    current = false;
  });
  const input = vi.fn();
  await expect(
    transferDesktopClipboardContent('paste', { text: 'hello' }, () => current, input),
  ).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
  expect(input).toHaveBeenCalledExactlyOnceWith([{ kind: 'release' }]);
});

it('uses the X11 paste shortcut for terminals and browsers, but never while syncing', async () => {
  h.x11 = true;
  const input = vi.fn();
  await transferDesktopClipboardContent('paste', { text: '中文 😀' }, () => true, input);
  expect(input.mock.calls.at(-1)?.[0]).toEqual([
    { kind: 'release' },
    { kind: 'key', code: 'ShiftLeft', down: true },
    { kind: 'key', code: 'Insert', down: true },
    { kind: 'key', code: 'Insert', down: false },
    { kind: 'key', code: 'ShiftLeft', down: false },
  ]);
  input.mockClear();
  await transferDesktopClipboardContent('paste', { text: '同步' }, () => true, input, { sync: true });
  expect(input).not.toHaveBeenCalled();
});
