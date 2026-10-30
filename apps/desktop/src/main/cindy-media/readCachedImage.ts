import { requireString, throwIpcError } from '../utils/ipcValidate';

interface CachedImage {
  base64: string;
  mimeType: string;
}

/** Business body of the existing image-cache:read-base64 IPC. */
export async function readCachedImage(
  params: { url: string },
  deps: {
    readBlob: (url: string) => Promise<{ buffer: Buffer; mimeType: string }>;
    readLegacy: (url: string) => Promise<CachedImage>;
  },
): Promise<CachedImage> {
  const url = requireString(params?.url, 'url');
  try {
    if (url.startsWith('cindy-media://')) {
      const { buffer, mimeType } = await deps.readBlob(url);
      return { base64: buffer.toString('base64'), mimeType };
    }
    return await deps.readLegacy(url);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throwIpcError('NOT_FOUND', 'Image file not found');
    }
    throwIpcError('INTERNAL', 'Image could not be read');
  }
}
