import { expect, it, vi } from 'vitest';
import { extractIpcError } from '../../../shared/ipcError';
import { readCachedImage } from '../readCachedImage';

it.each(['cindy-media://blobs/image.png', 'xdt-image://images/image.png'])(
  'preserves the existing reader routing and bytes for %s',
  async (url) => {
    const expected = { base64: 'aW1hZ2U=', mimeType: 'image/png' };
    const deps = {
      readBlob: vi.fn().mockResolvedValue({ buffer: Buffer.from('image'), mimeType: 'image/png' }),
      readLegacy: vi.fn().mockResolvedValue(expected),
    };
    await expect(readCachedImage({ url }, deps)).resolves.toEqual(expected);
    expect(deps.readBlob).toHaveBeenCalledTimes(url.startsWith('cindy-media:') ? 1 : 0);
    expect(deps.readLegacy).toHaveBeenCalledTimes(url.startsWith('xdt-image:') ? 1 : 0);
  },
);

it.each(['ENOENT', 'EACCES', 'EIO', 'invalid-url'])(
  'classifies %s without leaking filesystem details across IPC',
  async (code) => {
    const read = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('/private/secret/image.png'), { code }));
    for (const url of ['cindy-media://blobs/image.png', 'xdt-image:///private/secret/image.png']) {
      const error = await readCachedImage({ url }, { readBlob: read, readLegacy: read }).catch(
        (e) => e,
      );
      // Electron serializes Error.message, losing custom properties.
      const serialized = new Error(
        `Error invoking remote method 'image-cache:read-base64': Error: ${error.message}`,
      );
      expect(extractIpcError(serialized)?.code).toBe(code === 'ENOENT' ? 'NOT_FOUND' : 'INTERNAL');
      expect(serialized.message).not.toContain('/private/secret');
    }
  },
);

it('rejects missing URL before invoking either store', async () => {
  const read = vi.fn();
  await expect(readCachedImage({ url: '' }, { readBlob: read, readLegacy: read })).rejects.toThrow(
    '[INVALID_PARAMS]',
  );
  expect(read).not.toHaveBeenCalled();
});
