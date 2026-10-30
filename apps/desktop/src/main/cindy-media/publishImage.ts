import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { authorizedSessionPathStillBound, type SessionPathAuthorization } from '@cindy/mcps';
import { classifyLocalAttachmentPath } from '../cindy-brain/ghostLocalPathGrant.js';
import { mimeForExt } from './blobStore.js';
import { ingestMedia } from './ingest.js';
import { hasRef } from './ledger.js';
import { sniffMediaMime } from './sniffMediaMime.js';
import { captureMediaRefCompensationScope } from './refCompensationJournal.js';
import { getDbClient } from '../localDb/client/current.js';
import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';

const MAX_IMAGE_BYTES = 48 * 1024 * 1024;
// Serialize only the check-and-pin for one owner/task/blob; do not share results
// because each caller must retain its own permission and cancellation checks.
const referenceLocks = new Map<string, Promise<void>>();

async function withReferenceLock<T>(key: string, perform: () => Promise<T>): Promise<T> {
  const previous = referenceLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  referenceLocks.set(key, next);
  try {
    await previous;
    return await perform();
  } finally {
    release();
    if (referenceLocks.get(key) === next) referenceLocks.delete(key);
  }
}

/** Import into this Host's store; never manufacture a reference to another profile's blob. */
export async function publishImage(
  sourcePath: string,
  context: { sessionId: string; workingDir: string; remoteHostId?: string },
  deps: {
    isCurrent: () => boolean;
    authorize: (absPath: string) => Promise<SessionPathAuthorization>;
  },
): Promise<Record<string, unknown>> {
  if (context.remoteHostId) return { ok: false, errorCode: 'REMOTE_SOURCE_REQUIRED', message: 'SSH 图片请先通过已授权的远端文件工具取回，不能读取控制端同名路径。' };
  if (!deps.isCurrent()) return { ok: false, errorCode: 'PERMISSION_DENIED', message: '当前任务实例已失效。' };
  const owner = getActiveAppSession();
  const db = getDbClient().drizzle;
  const compensation = captureMediaRefCompensationScope();
  const source = classifyLocalAttachmentPath(path.resolve(context.workingDir, sourcePath), context.workingDir, { mimeForExt });
  if (source.kind === 'not-local') return { ok: false, errorCode: 'MEDIA_SOURCE_MISSING', message: '图片源文件不存在或不是普通文件。请提供实际生成的文件。' };
  if (source.kind === 'unsupported-type' || !source.mimeType.startsWith('image/')) return { ok: false, errorCode: 'INVALID_INPUT', message: '只支持图片文件。' };
  if (source.size > MAX_IMAGE_BYTES) return { ok: false, errorCode: 'MEDIA_TOO_LARGE', message: '图片超过 48 MB，请先缩小图片。' };
  const grant = source.kind === 'outside-workdir' ? await deps.authorize(source.absPath) : { allowed: true as const };
  if (!grant.allowed) return { ok: false, errorCode: 'PERMISSION_DENIED', message: grant.reason };
  const isCurrent = () => {
    const active = getActiveAppSession();
    return deps.isCurrent() && grant.isCurrent?.() !== false && !isAppSessionBoundaryPending()
      && active.dataOwnerId === owner.dataOwnerId && active.generation === owner.generation;
  };
  if (!isCurrent() || !await authorizedSessionPathStillBound(context.workingDir, source.absPath)) {
    return { ok: false, errorCode: 'PERMISSION_DENIED', message: '图片路径或任务权限已变化，请重试。' };
  }
  let buffer: Buffer;
  try {
    const file = await fs.open(source.absPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return { ok: false, errorCode: 'MEDIA_TOO_LARGE', message: '图片文件类型或大小已变化，请重新选择。' };
      // Read at most the observed size plus one byte: a growing file cannot cause an unbounded allocation.
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const bound = await fs.stat(source.absPath);
      if (length !== stat.size || bound.dev !== stat.dev || bound.ino !== stat.ino) {
        return { ok: false, errorCode: 'MEDIA_SOURCE_CHANGED', message: '读取期间图片文件发生变化，请重试。' };
      }
      buffer = bytes.subarray(0, length);
    } finally {
      await file.close();
    }
  } catch (error) {
    return { ok: false, errorCode: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MEDIA_SOURCE_MISSING' : 'MEDIA_READ_FAILED', message: '无法读取图片源文件，请检查文件是否仍存在且可读。' };
  }
  if (!isCurrent() || !await authorizedSessionPathStillBound(context.workingDir, source.absPath)) {
    return { ok: false, errorCode: 'PERMISSION_DENIED', message: '图片路径或任务权限已变化，请重试。' };
  }
  const mimeType = sniffMediaMime(buffer);
  if (!mimeType?.startsWith('image/')) return { ok: false, errorCode: 'INVALID_IMAGE', message: '文件内容不是受支持的图片。' };
  const assertCurrent = () => { if (!isCurrent()) throw new Error('Media import scope changed'); };
  try {
    const hash = createHash('sha256').update(buffer).digest('hex');
    const reference = { refKind: 'session-attachment' as const, refId: context.sessionId };
    const key = JSON.stringify([owner.dataOwnerId, owner.generation, context.sessionId, hash]);
    const image = await withReferenceLock(key, async () => {
      assertCurrent();
      const exists = await hasRef({ hash, ...reference }, db);
      assertCurrent();
      return ingestMedia({ buffer, mimeType, isCache: false,
        refs: exists ? [] : [{ ...reference, originSessionId: context.sessionId, originKind: 'tool' }],
        assertStillValid: assertCurrent, refCompensationScope: compensation,
      }, db);
    });
    assertCurrent();
    return { ok: true, xdt_image_urls: [image.url], url: image.url, filename: `${image.hash}${image.ext}`,
      message: '已导入当前 Host 并登记任务引用。请在回复中使用返回的受管地址嵌入图片。此结果不代表远端设备已完成下载。' };
  } catch {
    return { ok: false, errorCode: 'MEDIA_PUBLISH_FAILED', message: '图片未完成入库或任务归属登记，请检查当前任务后重试。' };
  }
}
