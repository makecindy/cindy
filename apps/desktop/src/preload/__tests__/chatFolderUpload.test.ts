/**
 * Unit security regression for PR #6551: exercise the actual preload bridge.
 * Existing Main tests cannot prove that an arbitrary renderer path is rejected.
 * Minimal input is a native File capability or a fabricated path-only object;
 * Electron's native resolver is injected, with no filesystem or process I/O.
 */
import { expect, it, vi } from 'vitest';
import { createChatFolderUpload, type ChatFolderUploadInput } from '../chatFolderUpload';

it.each(['path-only', 'synthetic-file', 'resolver-error'])(
  'rejects %s without invoking Main',
  async (kind) => {
    const upload = vi.fn();
    const getPath = vi.fn(() => {
      if (kind !== 'synthetic-file') throw new TypeError('Not a native File');
      return '';
    });
    const bridge = createChatFolderUpload(getPath, upload);
    expect(
      await bridge({
        deviceId: 'target',
        requestId: 'request',
        sourcePath: '/private/credentials',
        ...(kind === 'path-only' ? {} : { file: { name: 'fabricated' } }),
      } as unknown as ChatFolderUploadInput),
    ).toEqual({ ok: false, code: 'TRANSFER_FAILED' });
    expect(upload).not.toHaveBeenCalled();
  },
);

it('uses only the native File path, ignoring a supplied path and other fields', async () => {
  const nativeFile = { name: 'dropped-folder' } as File;
  const upload = vi.fn().mockResolvedValue({ ok: true, path: 'staged.bin', size: 100 });
  const bridge = createChatFolderUpload((file) => {
    expect(file).toBe(nativeFile);
    return 'native-folder';
  }, upload);
  expect(
    await bridge({
      file: nativeFile,
      sourcePath: 'forged-folder',
      extra: 'untrusted',
      deviceId: 'target',
      requestId: 'request',
    } as ChatFolderUploadInput),
  ).toEqual({ ok: true, path: 'staged.bin', size: 100 });
  expect(upload).toHaveBeenCalledExactlyOnceWith({
    deviceId: 'target',
    requestId: 'request',
    sourcePath: 'native-folder',
  });
});
