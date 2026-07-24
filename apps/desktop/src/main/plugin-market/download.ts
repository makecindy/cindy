import crypto from 'node:crypto';
import fs from 'node:fs';

import { net } from 'electron';

const MAX_PLUGIN_BYTES = 8 * 1024 * 1024;

/** 下载并校验 `.cindy` 原始字节，写入调用方提供的临时路径。 */
export async function downloadVerifiedPlugin(
  url: string,
  expected: { sizeBytes: number; sha256: string },
  targetPath: string,
): Promise<void> {
  if (expected.sizeBytes <= 0 || expected.sizeBytes > MAX_PLUGIN_BYTES) {
    throw new Error(`Plugin 包大小超限: ${expected.sizeBytes}`);
  }
  const response = await net.fetch(url, {
    method: 'GET',
    cache: 'no-store',
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Plugin 下载失败 (${response.status})`);
  if (!response.body) throw new Error('Plugin 下载响应体为空');
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) !== expected.sizeBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new Error('Plugin 下载 Content-Length 与 Release 不一致');
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > expected.sizeBytes || size > MAX_PLUGIN_BYTES) {
      await reader.cancel();
      throw new Error('Plugin 下载字节数超过 Release 声明');
    }
    chunks.push(Buffer.from(value));
  }
  if (size !== expected.sizeBytes) throw new Error('Plugin 下载字节数与 Release 不一致');
  const bytes = Buffer.concat(chunks, size);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected.sha256) throw new Error('Plugin 下载 SHA-256 校验失败');
  await fs.promises.writeFile(targetPath, bytes, { mode: 0o600, flag: 'wx' });
}
