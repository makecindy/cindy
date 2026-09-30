import { PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES } from '@cindy/plugin-protocol';
import { download, DownloadError } from '../downloader/index.js';
import { createIpcError } from '../../shared/ipc-errors.js';

/** Plugin policy only; transport, timeouts, byte limits and hashing are shared. */
export async function downloadVerifiedPlugin(
  url: string,
  expected: { sizeBytes: number; sha256: string },
  targetPath: string,
): Promise<void> {
  if (
    !Number.isSafeInteger(expected.sizeBytes) ||
    expected.sizeBytes <= 0 ||
    expected.sizeBytes > PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES ||
    !/^[a-f0-9]{64}$/i.test(expected.sha256)
  ) {
    throw createIpcError('GHOST_FILE_INVALID', 'Plugin Release size or SHA-256 is invalid');
  }
  try {
    await download({
      url,
      targetPath,
      sha256: expected.sha256,
      expectedSize: expected.sizeBytes,
      maxBytes: PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES,
      redirect: 'error',
      resume: false,
      existingTarget: 'error',
      retry: { maxAttempts: 1 },
      timeout: { connectMs: 60_000, idleMs: 60_000, totalMs: 120_000 },
    });
  } catch (error) {
    if (error instanceof DownloadError) {
      if (error.code === 'EXISTS')
        throw Object.assign(new Error('Download target already exists'), { code: 'EEXIST' });
      if (error.code === 'TIMEOUT')
        throw createIpcError('GHOST_DOWNLOAD_TIMEOUT', 'Plugin download timed out');
      if (error.code === 'SIZE')
        throw createIpcError(
          'GHOST_FILE_INVALID',
          'Plugin 下载字节数或 Content-Length 与 Release 不一致，可能超过声明大小',
        );
      if (error.code === 'CHECKSUM')
        throw createIpcError('GHOST_FILE_INVALID', 'Plugin 下载 SHA-256 校验失败');
    }
    throw createIpcError('GHOST_DOWNLOAD_FAILED', 'Plugin download failed');
  }
}
