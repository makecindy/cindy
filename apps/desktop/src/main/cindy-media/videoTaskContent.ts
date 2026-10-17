import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { outboundFetch } from '../maker-host/outbound-fetch.js';
import { MediaDownloadError } from './mediaDownload.js';
import type { ProviderVideoConnection } from './providerMediaRuntime.js';

const DISK_RESERVE_BYTES = 256n * 1024n * 1024n;

async function availableDownloadBytes(directory: string): Promise<bigint> {
  try {
    const space = await fs.statfs(directory, { bigint: true });
    return space.bavail * space.bsize - DISK_RESERVE_BYTES;
  } catch {
    throw new MediaDownloadError('MEDIA_DOWNLOAD_UNAVAILABLE', '无法确认视频临时文件的可用磁盘空间，生成结果已保留');
  }
}

/** A private task resource, never an arbitrary URL authorized to receive an API key. */
export function isVideoTaskContentRef(raw: string, taskId: string, baseUrl: string): boolean {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(taskId)) return false;
  const relative = `/videos/${taskId}/content`;
  const base = baseUrl.replace(/\/+$/, '');
  return raw === relative || raw === relative.slice(1) ||
    raw === `${new URL(base).pathname}${relative}` || raw === `${base}${relative}`;
}

/** Read only the original task's fixed content endpoint, with no redirect or credential handoff. */
export async function fetchVideoTaskContent(
  connection: ProviderVideoConnection,
  taskId: string,
  signal?: AbortSignal,
): Promise<{ filePath: string; headerMime: string | null; dispose(): Promise<void> }> {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(taskId)) throw new MediaDownloadError('MEDIA_RESULT_INVALID', '视频任务 ID 无效');
  const url = `${connection.baseUrl.replace(/\/+$/, '')}/videos/${taskId}/content`;
  const started = Date.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    connection.assertCurrent();
    signal?.throwIfAborted();
    const remaining = 120_000 - (Date.now() - started);
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remaining);
    timeout.unref?.();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), 30_000); idle.unref?.(); };
    let response: Response | undefined;
    let tempDir: string | undefined;
    let success = false;
    resetIdle();
    try {
      response = await outboundFetch(url, {
        method: 'GET', headers: { ...connection.headers, Accept: 'video/*' }, redirect: 'manual',
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      });
      connection.assertCurrent();
      // No credential, location, or approval is inherited by a redirect target.
      if (response.status >= 300 && response.status < 400) throw new MediaDownloadError('MEDIA_DOWNLOAD_UNAVAILABLE', '原视频任务的内容接口发生重定向，已停止读取');
      if (!response.ok) throw new MediaDownloadError(response.status >= 500 || [408, 425, 429].includes(response.status) ? 'MEDIA_DOWNLOAD_FAILED' : 'MEDIA_DOWNLOAD_UNAVAILABLE', `原视频任务的内容接口返回 HTTP ${response.status}，生成结果已保留`);
      if (!response.body) throw new MediaDownloadError('MEDIA_RESULT_INVALID', '视频内容为空');
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-media-video-task-'));
      // Bound actual streamed bytes by disk capacity, preserving room for the
      // managed-store copy. Do not restore the old in-memory media size limit.
      const maxBytes = (await availableDownloadBytes(tempDir)) / 2n;
      let writtenBytes = 0n;
      const filePath = path.join(tempDir, 'result');
      const file = await fs.open(filePath, 'wx', 0o600);
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          connection.assertCurrent();
          signal?.throwIfAborted();
          resetIdle();
          const chunkBytes = BigInt(value.byteLength);
          const nextBytes = writtenBytes + chunkBytes;
          if (nextBytes > maxBytes || nextBytes + chunkBytes > await availableDownloadBytes(tempDir)) {
            throw new MediaDownloadError('MEDIA_DOWNLOAD_UNAVAILABLE', '视频下载所需空间超过可用磁盘预算，生成结果已保留；请清理空间后读取原任务，不要重新生成');
          }
          await file.writeFile(value);
          writtenBytes = nextBytes;
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); await file.close(); }
      connection.assertCurrent();
      signal?.throwIfAborted();
      const completedDir = tempDir;
      success = true;
      return {
        filePath,
        headerMime: response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? null,
        dispose: () => fs.rm(completedDir, { recursive: true, force: true }).catch(() => undefined),
      };
    } catch (error) {
      connection.assertCurrent();
      signal?.throwIfAborted();
      if (error instanceof MediaDownloadError && error.code !== 'MEDIA_DOWNLOAD_FAILED') throw error;
      if (attempt >= 2) throw new MediaDownloadError('MEDIA_DOWNLOAD_FAILED', '原视频任务的内容读取失败，生成结果已保留；不要重新生成');
    } finally {
      clearTimeout(timeout); clearTimeout(idle);
      await response?.body?.cancel().catch(() => undefined);
      if (tempDir && !success) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  throw new MediaDownloadError('MEDIA_DOWNLOAD_FAILED', '原视频任务的内容读取超时，生成结果已保留');
}
