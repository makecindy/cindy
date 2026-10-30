import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState';
import { getCurrentDbClientSnapshot } from '../localDb/client/current';
import { mediaRefs, sessions } from '../localDb/schema';
import { parseBlobUrl, resolveSafe } from './blobStore';
import type { LedgerDb } from './ledger';
import { sniffMediaMime } from './sniffMediaMime';
import {
  GHOST_MODEL_IMAGE_BUDGET_BYTES,
  GHOST_MODEL_IMAGE_MAX_BYTES,
} from '../cindy-brain/ghostModelImages';
import { prepareInlineImagePreview } from '../mcp-integrations/inlineImageCompressor';

type InspectionContext = { sessionId: string; isCurrent: () => boolean };
type Preview = { url: string; image_index: number };
type ModelImage = { data: string; mimeType: string };
type InspectionResult =
  | {
      ok: true;
      previews: Preview[];
      modelImages: ModelImage[];
    }
  | { ok: false; errorCode: string; message: string };

/** Task state and reference ownership must be observed in the same DB query. */
async function readSessionMedia(db: LedgerDb, sessionId: string, hashes: string[]) {
  return db
    .select({ hash: mediaRefs.hash, status: sessions.status, clearedAt: sessions.clearedAt })
    .from(sessions)
    .innerJoin(mediaRefs, eq(mediaRefs.refId, sessions.id))
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(mediaRefs.refKind, 'session-attachment'),
        inArray(mediaRefs.hash, hashes),
      ),
    );
}

/** Stable failures deliberately contain no host paths or image decoder diagnostics. */
class InspectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Read one immutable managed file, bounded even if replaced or grown mid-read. */
async function readMedia(url: string, limit: number, hash: string): Promise<Buffer> {
  const { absPath } = resolveSafe(url);
  const file = await fs.open(
    absPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit) {
      throw new InspectionError(
        'MEDIA_PREVIEW_TOO_LARGE',
        '媒体不是普通文件或超过预览读取上限；原始成果不受影响，可用 resolve_local_path 获取路径后自行分析。',
      );
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const part = await file.read(bytes, length, bytes.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    const buffer = bytes.subarray(0, length);
    if (length !== stat.size || createHash('sha256').update(buffer).digest('hex') !== hash) {
      throw new InspectionError('MEDIA_SOURCE_CHANGED', '媒体字节与受管地址不一致，未返回预览。');
    }
    return buffer;
  } finally {
    await file.close();
  }
}

/** Current-task image inspection; never exports a path, creates a copy or generates media. */
export async function inspectMedia(
  request: { url: string },
  context: InspectionContext,
  budget = GHOST_MODEL_IMAGE_BUDGET_BYTES,
): Promise<InspectionResult> {
  try {
    const parsed = parseBlobUrl(request.url);
    if (!parsed)
      throw new InspectionError('INVALID_INPUT', '请使用当前任务的 cindy-media:// 图片地址。');
    const snapshot = getCurrentDbClientSnapshot();
    const owner = activeOwnerScopeKey();
    if (!snapshot) throw new InspectionError('PERMISSION_DENIED', '当前任务归属不可用。');
    const assertCurrent = () => {
      if (
        !context.isCurrent() ||
        isAppSessionBoundaryPending() ||
        owner !== activeOwnerScopeKey() ||
        getCurrentDbClientSnapshot() !== snapshot
      ) {
        throw new InspectionError('PERMISSION_DENIED', '当前任务或账号已变化，未返回预览。');
      }
    };
    assertCurrent();
    const db = snapshot.client.drizzle;
    const session = async () => (await readSessionMedia(db, context.sessionId, [parsed.hash]))[0];
    const initial = await session();
    const assertAuthorized = async () => {
      assertCurrent();
      const current = await session();
      if (
        !initial ||
        !current ||
        current.status === 'deleted' ||
        current.clearedAt !== initial.clearedAt
      ) {
        throw new InspectionError(
          'MEDIA_NOT_IN_TASK',
          '该媒体不在当前任务的附件或成果中。请先把已有媒体附到当前任务。',
        );
      }
      assertCurrent();
    };
    await assertAuthorized();
    const declaredMime = resolveSafe(request.url).mimeType;
    if (!declaredMime.startsWith('image/')) {
      throw new InspectionError(
        'MEDIA_TYPE_UNSUPPORTED',
        'inspect 只返回图片预览。视频请用 resolve_local_path 获取本机路径，再自行选择查看或分析方式。',
      );
    }
    const buffer = await readMedia(request.url, GHOST_MODEL_IMAGE_MAX_BYTES, parsed.hash);
    await assertAuthorized();
    const mime = sniffMediaMime(buffer, declaredMime);
    if (!mime?.startsWith('image/'))
      throw new InspectionError('MEDIA_TYPE_UNSUPPORTED', '媒体内容不是受支持的图片。');
    const preview = await prepareInlineImagePreview(buffer, mime, { targetBytes: budget });
    if (!preview)
      throw new InspectionError(
        'MEDIA_PREVIEW_UNAVAILABLE',
        '图片超过预览像素上限、无法解码或压缩到预览大小；原始成果不受影响，可用 resolve_local_path 获取路径后自行分析。',
      );
    await assertAuthorized();
    return {
      ok: true,
      previews: [{ url: request.url, image_index: 0 }],
      modelImages: [{ data: preview.buffer.toString('base64'), mimeType: preview.mime }],
    };
  } catch (error) {
    const known = error instanceof InspectionError;
    return {
      ok: false,
      errorCode: known ? error.code : 'MEDIA_PREVIEW_UNAVAILABLE',
      message: known ? error.message : '媒体暂时无法读取或解码，未返回预览；原始成果不受影响。',
    };
  }
}

/** Preview failures must never turn a paid, successfully stored result into a failure. */
export async function previewGeneratedImages(
  result: Record<string, unknown>,
  context: InspectionContext,
): Promise<Record<string, unknown>> {
  if (result.ok === false || !Array.isArray(result.xdt_image_urls) || !result.xdt_image_urls.length)
    return result;
  const unavailable = () => ({
    ...result,
    preview_errors: [
      {
        errorCode: 'MEDIA_PREVIEW_UNAVAILABLE',
        message: '预览不可用或任务已变化，原始生成结果已保留；不要重新生成。',
      },
    ],
  });
  try {
    const snapshot = getCurrentDbClientSnapshot();
    const owner = activeOwnerScopeKey();
    if (!snapshot) return unavailable();
    const current = () =>
      context.isCurrent() &&
      !isAppSessionBoundaryPending() &&
      owner === activeOwnerScopeKey() &&
      snapshot === getCurrentDbClientSnapshot();
    const readSession = async () =>
      (
        await snapshot.client.drizzle
          .select({ status: sessions.status, clearedAt: sessions.clearedAt })
          .from(sessions)
          .where(eq(sessions.id, context.sessionId))
          .limit(1)
      )[0];
    const initial = await readSession();
    if (!initial || initial.status === 'deleted' || !current()) return unavailable();
    const urls = result.xdt_image_urls.filter((url): url is string => typeof url === 'string');
    const modelImages: ModelImage[] = [];
    const previews: Preview[] = [];
    const errors: unknown[] = [];
    for (const url of urls.slice(0, 2)) {
      const inspected = await inspectMedia(
        { url },
        { ...context, isCurrent: current },
        Math.floor(GHOST_MODEL_IMAGE_BUDGET_BYTES / Math.min(urls.length, 2)),
      );
      if (inspected.ok) {
        previews.push(
          ...inspected.previews.map((p) => ({
            ...p,
            image_index: p.image_index + modelImages.length,
          })),
        );
        modelImages.push(...inspected.modelImages);
      } else errors.push({ url, errorCode: inspected.errorCode, message: inspected.message });
    }
    // Each inspection checks its scope; don't return earlier pixels after a later scope change.
    const hashes = [...new Set(previews.map((preview) => parseBlobUrl(preview.url)!.hash))];
    const final = hashes.length
      ? await readSessionMedia(snapshot.client.drizzle, context.sessionId, hashes)
      : [];
    if (
      !current() ||
      new Set(final.map((row) => row.hash)).size !== hashes.length ||
      final.some((row) => row.status === 'deleted' || row.clearedAt !== initial.clearedAt)
    )
      return unavailable();
    return {
      ...result,
      modelImages,
      previews,
      ...(errors.length ? { preview_errors: errors } : {}),
      ...(urls.length > 2
        ? {
            previews_omitted: urls.slice(2),
            preview_hint: '其余图片可用 inspect 按原地址检查，无需重新生成。',
          }
        : {}),
    };
  } catch {
    return unavailable();
  }
}
