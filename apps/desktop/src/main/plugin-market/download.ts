import crypto from 'node:crypto';
import fs from 'node:fs';

import { net } from 'electron';
import { PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES } from '@cindy/plugin-protocol';

import { createIpcError } from '../../shared/ipc-errors.js';

const PLUGIN_DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const PLUGIN_DOWNLOAD_TOTAL_TIMEOUT_MS = 120_000;

/** 下载并校验 `.cindy` 原始字节，写入调用方提供的临时路径。 */
export async function downloadVerifiedPlugin(
  url: string,
  expected: { sizeBytes: number; sha256: string },
  targetPath: string,
): Promise<void> {
  if (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes <= 0) {
    throw createIpcError('GHOST_FILE_INVALID', 'Plugin Release size is invalid');
  }
  if (expected.sizeBytes > PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES) {
    throw createIpcError('GHOST_FILE_INVALID', 'Plugin archive exceeds 128 MiB');
  }
  const controller = new AbortController();
  const totalTimer = setTimeout(() => controller.abort(), PLUGIN_DOWNLOAD_TOTAL_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetIdleTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), PLUGIN_DOWNLOAD_IDLE_TIMEOUT_MS);
  };
  const network = async <T>(operation: Promise<T>): Promise<T> => {
    try {
      return await operation;
    } catch {
      throw createIpcError(
        controller.signal.aborted ? 'GHOST_DOWNLOAD_TIMEOUT' : 'GHOST_DOWNLOAD_FAILED',
        controller.signal.aborted ? 'Plugin download timed out' : 'Plugin download failed',
      );
    }
  };
  resetIdleTimer();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let file: fs.promises.FileHandle | undefined;
  let complete = false;
  try {
    const response = await network(
      net.fetch(url, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      }),
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw createIpcError('GHOST_DOWNLOAD_FAILED', `Plugin download HTTP ${response.status}`);
    }
    if (!response.body)
      throw createIpcError('GHOST_DOWNLOAD_FAILED', 'Plugin response body is empty');
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) !== expected.sizeBytes) {
      await response.body.cancel().catch(() => undefined);
      throw createIpcError('GHOST_FILE_INVALID', 'Plugin 下载 Content-Length 与 Release 不一致');
    }

    reader = response.body.getReader();
    resetIdleTimer();
    file = await fs.promises.open(targetPath, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    let size = 0;
    while (true) {
      if (controller.signal.aborted)
        throw createIpcError('GHOST_DOWNLOAD_TIMEOUT', 'Plugin download timed out');
      const { done, value } = await network(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > expected.sizeBytes) {
        throw createIpcError('GHOST_FILE_INVALID', 'Plugin 下载字节数超过 Release 声明');
      }
      if (value.byteLength > 0) {
        resetIdleTimer();
        hash.update(value);
        await file.writeFile(value);
      }
    }
    if (controller.signal.aborted)
      throw createIpcError('GHOST_DOWNLOAD_TIMEOUT', 'Plugin download timed out');
    if (size !== expected.sizeBytes)
      throw createIpcError('GHOST_FILE_INVALID', 'Plugin 下载字节数与 Release 不一致');
    if (hash.digest('hex') !== expected.sha256)
      throw createIpcError('GHOST_FILE_INVALID', 'Plugin 下载 SHA-256 校验失败');
    await file.close();
    complete = true;
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(timer);
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
    if (file && !complete) {
      await file.close().catch(() => undefined);
      await fs.promises.rm(targetPath, { force: true });
    }
  }
}
