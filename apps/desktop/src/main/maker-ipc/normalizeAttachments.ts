/**
 * normalizeAttachments — desktop ↔ maker-core 边界的附件归一化层。
 *
 * maker-core 的契约是「每个 image/file block 都给一个真实的 fs path」。
 * Renderer 那边因为 UI / 缓存 / 截图各种来源, 一个 attachment 可能是:
 *   - xdt-image://{sessionId}/{filename}  (主路径,缓存命中)
 *   - 内存 base64                          (F6 fallback,cache 写盘失败)
 *   - clipboard://paste-{ts}              (截图粘贴时的占位 path,UI chip ID 用)
 *   - 普通绝对 fs path                     (拖拽本地文件/媒体)
 *
 * 这一层把上面所有花活归一成绝对 fs path:
 *   - xdt-image:// → 经 imageCacheStore.resolveSafe 反查到 userData 下的绝对路径
 *   - F6 base64    → 写一个 OS temp 文件, 用临时 path
 *   - clipboard:// → 跳过 (能走到这里说明既没 url 也没 base64, 真的没东西)
 *   - 绝对 path    → 原样透传
 *
 * 临时文件按 sessionId 分目录, 在 session close 时整目录删除。
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import * as imageCacheStore from '../imageCacheStore.js';
import * as cindyMediaBlobStore from '../cindy-media/blobStore.js';
import * as cindyMediaLedger from '../cindy-media/ledger.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import { createLogger } from '../logger.js';
import { isAttachmentOssRef, parseAttachmentOssRef } from '../../shared/attachmentOssRef.js';
import type { AttachmentIntegrity, AttachmentOssRef } from '../../shared/attachmentOssRef.js';
import { downloadToFile, removeRemote } from '../device-link/mediaTransfer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isDangerousAttachmentName } from '../../shared/attachmentSafety.js';

const log = createLogger('maker-ipc/normalize');

const TEMP_DIRS_BY_SESSION = new Map<string, string>();

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

function tempDirFor(sessionId: string): string {
  return path.join(app.getPath('temp'), 'cindy-attachments', sessionId);
}

/** 在 session 临时目录下分配一个唯一文件路径(建目录,不写内容)。 */
async function ensureTempPath(sessionId: string, mimeType: string | undefined): Promise<string> {
  const dir = tempDirFor(sessionId);
  await fs.mkdir(dir, { recursive: true });
  TEMP_DIRS_BY_SESSION.set(sessionId, dir);
  const ext = (mimeType && EXT_BY_MIME[mimeType]) ?? '.bin';
  return path.join(dir, `${randomUUID()}${ext}`);
}

async function writeTempFile(
  sessionId: string,
  bytes: Buffer,
  mimeType: string | undefined,
): Promise<string> {
  const file = await ensureTempPath(sessionId, mimeType);
  await fs.writeFile(file, bytes);
  return file;
}

async function materializeBase64(
  sessionId: string,
  base64: string,
  mimeType: string | undefined,
): Promise<string> {
  return writeTempFile(sessionId, Buffer.from(base64, 'base64'), mimeType);
}

type RawBlock = { type: string; [k: string]: unknown };
type AttachmentBlock = {
  type: 'image' | 'file';
  path?: string;
  base64?: string;
  mimeType?: string;
};
type UserMessageShape = string | { type: 'user'; content: string | RawBlock[] };

/** 旧引用没有完整性声明；新引用由共享 parser 保证 size/sha256 同时合法。 */
function integrityForRef(ref: AttachmentOssRef): AttachmentIntegrity | undefined {
  return ref.size === undefined ? undefined : { size: ref.size, sha256: ref.sha256! };
}

function isIntegrityMismatch(error: unknown): boolean {
  return error instanceof Error && error.name === 'AttachmentIntegrityError';
}

export async function normalizeUserMessage(
  sessionId: string,
  msg: UserMessageShape,
): Promise<UserMessageShape> {
  if (typeof msg === 'string') return msg;
  if (typeof msg.content === 'string') return msg;

  const out: RawBlock[] = [];
  for (const raw of msg.content) {
    if (raw.type !== 'image' && raw.type !== 'file') {
      out.push(raw);
      continue;
    }

    const block = { ...raw } as AttachmentBlock & { type: 'image' | 'file' };

    // 0) device-link 出方向 OSS 引用(控制端发来的附件)→ presign-get 下载物化到临时文件,
    //    用后删 OSS。新引用下载/校验失败 → 整条不发；旧引用保留历史的单附件降级语义。
    if (typeof block.path === 'string' && isAttachmentOssRef(block.path)) {
      const ref = parseAttachmentOssRef(block.path);
      if (!ref) {
        log.warn('malformed oss attach ref, rejecting message');
        throwIpcError('DEVICE_LINK_MEDIA_TRANSFER_FAILED', '附件引用无效,请重新上传。');
      }
      try {
        // 流式下载到临时文件(不整 buffer 进内存,大附件也安全)。
        const dest = await ensureTempPath(sessionId, ref.mimeType ?? block.mimeType);
        const integrity = integrityForRef(ref);
        await downloadToFile(ref.ossKey, dest, integrity);
        block.path = dest;
        if (!block.mimeType && ref.mimeType) block.mimeType = ref.mimeType;
        void removeRemote(ref.ossKey); // 用后删(best-effort,不阻塞 turn)
      } catch (e) {
        log.warn('oss attach download failed', { error: String(e) });
        if (isIntegrityMismatch(e)) void removeRemote(ref.ossKey);
        // 新客户端声明了完整性时，任何下载/校验失败都必须阻止消息进入 agent；
        // 旧引用继续保留历史降级语义，避免升级接收端破坏旧发送端行为。
        if (ref.size !== undefined) {
          throwIpcError(
            'DEVICE_LINK_MEDIA_TRANSFER_FAILED',
            e instanceof Error ? e.message : String(e),
          );
        }
        continue;
      }
      delete block.base64;
      out.push(block as unknown as RawBlock);
      continue;
    }

    // 1) F6 fallback: 内存 base64 → 临时文件
    if (block.base64) {
      try {
        block.path = await materializeBase64(sessionId, block.base64, block.mimeType);
      } catch (e) {
        log.warn('materializeBase64 failed, dropping attachment', { error: String(e) });
        continue;
      }
      delete block.base64;
    }

    // 2) xdt-image:// → 缓存内绝对路径
    if (typeof block.path === 'string' && block.path.startsWith('xdt-image://')) {
      try {
        const { absPath, mimeType } = imageCacheStore.resolveSafe(block.path);
        block.path = absPath;
        if (!block.mimeType && mimeType !== 'application/octet-stream') {
          block.mimeType = mimeType;
        }
      } catch (e) {
        log.warn('xdt-image resolve failed, dropping attachment', {
          url: block.path,
          error: String(e),
        });
        continue;
      }
    }

    // 2') cindy-media:// 媒体总仓 blob(统一地址,规则 25)→ 字节仓内绝对路径;
    //     mime 由扩展名白名单定死,resolveSafe 自带指纹校验与仓内前缀双保险。
    if (typeof block.path === 'string' && block.path.startsWith('cindy-media://')) {
      try {
        const { absPath, mimeType } = cindyMediaBlobStore.resolveSafe(block.path);
        block.path = absPath;
        if (!block.mimeType) block.mimeType = mimeType;
      } catch (e) {
        log.warn('cindy-media resolve failed, dropping attachment', {
          url: block.path,
          error: String(e),
        });
        continue;
      }
    }

    // 3) clipboard:// 占位 path —— 没有 base64 兜底就是真没东西, 不发出去
    if (typeof block.path === 'string' && block.path.startsWith('clipboard://')) {
      log.warn('attachment carried clipboard:// placeholder with no real source, dropping');
      continue;
    }

    if (typeof block.path !== 'string' || block.path.length === 0) {
      log.warn('attachment has no usable path after normalization, dropping');
      continue;
    }

    out.push(block as unknown as RawBlock);
  }

  return { type: 'user', content: out };
}

// ───────────────────────────────────────────────────────────────────────────
// device-link 出方向:被控端入队消息的 OSS 引用一次性物化(files[] + persistedContent 共用下载)
// ───────────────────────────────────────────────────────────────────────────

type SerializedFileLike = { url?: unknown; path?: unknown; base64?: unknown; mimeType?: unknown };

/** 该字段是 device-link 出方向附件 OSS 引用串。 */
function isOssRefField(v: unknown): v is string {
  return typeof v === 'string' && isAttachmentOssRef(v);
}

/** 可物化的本地图片扩展(与 imageCacheStore 的图片 MIME 支持面对齐)。 */
const LOCAL_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/**
 * persistedContent images[].url 是「被控端本机绝对路径」形态的图片引用。
 * 来源:手机文件浏览器「发送到会话」选中被控端 fs 上的图片文件——手机写侧只有
 * fs 路径可用(不经 OSS 上传),而桌面 renderer 的 coerceImageRef 只认
 * `xdt-image://`,不在这里物化的话,这类图片在桌面和手机的聊天记录里都不渲染
 * 缩略图(agent 能收到图,纯回显丢失,2026-07 排查发现)。
 */
function isLocalImagePathField(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    !isAttachmentOssRef(v) &&
    path.isAbsolute(v) &&
    LOCAL_IMAGE_EXTS.has(path.extname(v).toLowerCase())
  );
}

/** persistedContent images[].url 需要物化:OSS 引用,或被控端本机绝对路径图片。 */
function needsImageMaterialize(v: unknown): v is string {
  return isOssRefField(v) || isLocalImagePathField(v);
}

/** persistedContent JSON 串里是否含需物化引用(images[].url / files[].path)。解析失败 → 视作无。 */
function persistedContentNeedsMaterialize(json: string): boolean {
  try {
    const p = JSON.parse(json) as { images?: unknown; files?: unknown };
    const imgs = Array.isArray(p?.images) ? p.images : [];
    const fls = Array.isArray(p?.files) ? p.files : [];
    return (
      imgs.some((im) =>
        needsImageMaterialize(
          im && typeof im === 'object' ? (im as { url?: unknown }).url : undefined,
        ),
      ) ||
      fls.some((fl) =>
        isOssRefField(fl && typeof fl === 'object' ? (fl as { path?: unknown }).path : undefined),
      )
    );
  } catch {
    return false;
  }
}

/** 物化结果:被控端 image cache 里的 `xdt-image://` url(渲染用)+ 其绝对路径(file chip / agent 用)。 */
type MaterializedRef = { url: string; absPath: string };
type MaterializedCleanup = () => void | Promise<void>;

/**
 * 用 materialize(OSS 引用串 → image cache 物化结果)改写 persistedContent JSON 串。
 * 字段不对称:images 的引用在 `url`(写 `xdt-image://`,被控端据此渲染缩略图)、files 的在 `path`(写绝对路径)。
 */
async function materializePersistedContent(
  json: string,
  materialize: (refStr: string, mimeHint?: string) => Promise<MaterializedRef | null>,
): Promise<string> {
  let parsed: { text?: unknown; images?: unknown; files?: unknown };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    return json;
  }
  if (!parsed || typeof parsed !== 'object') return json;
  let changed = false;
  if (Array.isArray(parsed.images)) {
    const out: unknown[] = [];
    for (const im of parsed.images) {
      const url = im && typeof im === 'object' ? (im as { url?: unknown }).url : undefined;
      const mime =
        im && typeof im === 'object' ? (im as { mimeType?: unknown }).mimeType : undefined;
      if (needsImageMaterialize(url)) {
        const m = await materialize(url, typeof mime === 'string' ? mime : undefined);
        if (m) {
          changed = true;
          out.push({ ...(im as object), url: m.url }); // 图片引用 → xdt-image://(可渲染、持久)
          continue;
        }
      }
      out.push(im);
    }
    parsed.images = out;
  }
  if (Array.isArray(parsed.files)) {
    const out: unknown[] = [];
    for (const fl of parsed.files) {
      const p = fl && typeof fl === 'object' ? (fl as { path?: unknown }).path : undefined;
      if (isOssRefField(p)) {
        const m = await materialize(p);
        if (m) {
          changed = true;
          out.push({ ...(fl as object), path: m.absPath }); // 文件引用 → cache 内绝对路径(持久)
          continue;
        }
      }
      out.push(fl);
    }
    parsed.files = out;
  }
  return changed ? JSON.stringify(parsed) : json;
}

/**
 * device-link 出方向:被控端收到远程入队消息(maker:input:enqueue / steer)时,把 item 里所有 OSS 引用
 * (`files[]` 的 url/path + `persistedContent` 的 images[].url / files[].path)**一次性**物化成本地临时
 * 文件——每个 OSS 对象只下载一次(files[] 与 persistedContent 共用同一引用串 → 共用下载),物化完统一删 OSS。
 * 这样喂 agent 的 files[] 与落库的 persistedContent 都指向本地路径,被控端 reload 历史不再裂图。
 *
 * 无 OSS 引用(本机会话)→ 原样返回,零额外 IO。旧引用物化失败维持历史降级；新引用失败直接阻止入队。
 * OSS 删除放在 files[] + persistedContent 都物化之后,避免删早了另一副身取不到。
 */
async function materializeQueuedOssAttachmentsInternal(
  sessionId: string,
  item: unknown,
  deferCleanup: boolean,
): Promise<{
  item: unknown;
  cleanupAfterAcceptance?: () => void;
  cleanupBeforeAcceptance?: () => Promise<void>;
}> {
  if (!item || typeof item !== 'object') return { item };
  const it = item as { files?: unknown; persistedContent?: unknown };
  const files = Array.isArray(it.files) ? it.files : null;
  const pcStr = typeof it.persistedContent === 'string' ? it.persistedContent : null;

  const filesHaveOss =
    files?.some(
      (f) =>
        !!f &&
        typeof f === 'object' &&
        (isOssRefField((f as SerializedFileLike).url) ||
          isOssRefField((f as SerializedFileLike).path)),
    ) ?? false;
  if (!filesHaveOss && !(pcStr && persistedContentNeedsMaterialize(pcStr))) return { item }; // 无需物化 → 原样

  const byRef = new Map<string, MaterializedRef>(); // 引用串 → 物化结果(同串只下载/拷贝+入库一次)
  const ossKeys = new Set<string>();
  let cleanedUp = false;
  const cleanupOss = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const key of ossKeys) void removeRemote(key);
  };
  const localCleanupCallbacks: MaterializedCleanup[] = [];
  let localCleanedUp = false;
  const cleanupLocalMaterializations = async (): Promise<void> => {
    if (localCleanedUp) return;
    localCleanedUp = true;
    for (const cleanup of localCleanupCallbacks) {
      try {
        await cleanup();
      } catch (e) {
        log.warn('local OSS materialization cleanup failed', { error: String(e) });
      }
    }
  };
  const cleanupBeforeAcceptance = async (): Promise<void> => {
    // Keep the remote OSS object retryable until the direct send is accepted.
    // Only the local materialization belongs to this rejection cleanup path.
    await cleanupLocalMaterializations();
  };
  // 可入总仓的媒体(图片等白名单 mime)→ ingest 进 cindy-media 并直接挂
  // session-attachment 引用(入队消息没有草稿期,等价老 lifecycle committed);
  // 媒体附件统一走总仓 ingest(规则 25)。
  const ingestIntoBlobStore = async (
    sourcePath: string,
    mimeType: string,
  ): Promise<MaterializedRef> => {
    const buffer = await fs.readFile(sourcePath);
    const written = await ingestMedia({
      buffer,
      mimeType,
      refs: [
        {
          refKind: 'session-attachment',
          refId: sessionId,
          originSessionId: sessionId,
          originKind: 'user',
        },
      ],
    });
    const refId = written.refIds[0];
    if (refId) {
      localCleanupCallbacks.push(async () => {
        await cindyMediaLedger.removeRefById(refId);
        const removed = await cindyMediaLedger.deleteZeroRefBlobRecord(written.hash, Date.now() + 1);
        if (removed) await cindyMediaBlobStore.deleteBlobFile(written.hash, written.ext);
      });
    }
    return { url: written.url, absPath: cindyMediaBlobStore.resolveSafe(written.url).absPath };
  };
  // 物化:被控端本机绝对路径图片(手机文件浏览器发送)读字节入总仓;OSS 引用走
  // 流式下载 → 临时文件 → 媒体 mime 入总仓 / 非媒体(pdf/doc/.bin 等)拷进老
  // image cache(规则 25 边界:非媒体不进字节仓,该落地面待 xdt-file 决策后迁)。
  // 失败 → null(保留原引用,降级)。
  const materialize = async (
    refStr: string,
    mimeHint?: string,
  ): Promise<MaterializedRef | null> => {
    const cached = byRef.get(refStr);
    if (cached) return cached;
    if (isLocalImagePathField(refStr)) {
      try {
        const ext = path.extname(refStr).toLowerCase();
        const mimeType = cindyMediaBlobStore.mimeForExt(ext);
        if (!mimeType) throw new Error(`unsupported image ext: ${ext}`);
        const entry = await ingestIntoBlobStore(refStr, mimeType);
        byRef.set(refStr, entry);
        return entry;
      } catch (e) {
        log.warn('materialize local image path failed, leaving ref', { error: String(e) });
        return null;
      }
    }
    const ref = parseAttachmentOssRef(refStr);
    if (!ref) {
      throwIpcError('DEVICE_LINK_MEDIA_TRANSFER_FAILED', '附件引用无效,请重新上传。');
    }
    let tmp: string | null = null;
    try {
      tmp = await ensureTempPath(sessionId, ref.mimeType ?? mimeHint);
      await downloadToFile(ref.ossKey, tmp, integrityForRef(ref));
      const mime = ref.mimeType ?? mimeHint;
      let entry: MaterializedRef;
      // 只收图片进总仓:ingestIntoBlobStore 是整读内存(readFile + sha256),
      // 手机传的大视频/音频若走这条会让 main 进程内存翻倍(review P1);
      // 等 blobStore 流式入口落地再放开非图片媒体,现阶段维持老文件级拷贝。
      if (
        mime &&
        mime.startsWith('image/') &&
        cindyMediaBlobStore.supportedMime(mime) &&
        !isDangerousAttachmentName(ref.originalName ?? '')
      ) {
        entry = await ingestIntoBlobStore(tmp, mime);
      } else {
        // 非媒体附件维持历史兼容路径落地;规则 25 明确非媒体不进字节仓。
        const originalName =
          ref.originalName && ref.originalName.length > 0 ? ref.originalName : path.basename(tmp);
        const { url } = await imageCacheStore.copyFromPath({
          sessionId,
          sourcePath: tmp,
          originalName,
          lifecycle: 'committed',
        });
        localCleanupCallbacks.push(() => imageCacheStore.removeFile(url));
        entry = { url, absPath: imageCacheStore.resolveSafe(url).absPath };
      }
      byRef.set(refStr, entry);
      ossKeys.add(ref.ossKey);
      return entry;
    } catch (e) {
      log.warn('materialize queued oss attachment failed, leaving ref', { error: String(e) });
      if (isIntegrityMismatch(e)) void removeRemote(ref.ossKey);
      if (ref.size !== undefined) {
        throwIpcError(
          'DEVICE_LINK_MEDIA_TRANSFER_FAILED',
          e instanceof Error ? e.message : String(e),
        );
      }
      return null;
    } finally {
      if (tmp) await fs.rm(tmp, { force: true }).catch(() => {}); // 持久副本已入仓/入缓存,临时件删掉
    }
  };

  // files[]:顺序处理(让 byRef 去重对同一引用生效)。喂 agent 走托管 url(cindy-media:// 或老 xdt-image://,normalizeUserMessage 解析)。
  try {
    let nextFiles: unknown = it.files;
    if (files) {
      const out: unknown[] = [];
      for (const f of files) {
        if (!f || typeof f !== 'object') {
          out.push(f);
          continue;
        }
        const sf = f as SerializedFileLike;
        const refStr = isOssRefField(sf.url) ? sf.url : isOssRefField(sf.path) ? sf.path : null;
        if (!refStr) {
          out.push(f);
          continue;
        }
        const m = await materialize(
          refStr,
          typeof sf.mimeType === 'string' ? sf.mimeType : undefined,
        );
        out.push(m ? { ...(f as object), url: m.url, path: m.absPath, base64: undefined } : f);
      }
      nextFiles = out;
    }

    const nextPc: unknown = pcStr
      ? await materializePersistedContent(pcStr, materialize)
      : it.persistedContent;

    // files[] 与 persistedContent 都物化完才删 OSS(每个 key 删一次,best-effort 不阻塞)。
    const materializedItem = {
      ...(it as object),
      ...(files ? { files: nextFiles } : {}),
      persistedContent: nextPc,
    };
    return {
      item: materializedItem,
      ...(deferCleanup && (ossKeys.size > 0 || localCleanupCallbacks.length > 0)
        ? {
            cleanupAfterAcceptance: cleanupOss,
            cleanupBeforeAcceptance,
          }
        : {}),
    };
  } catch (err) {
    await cleanupBeforeAcceptance();
    throw err;
  } finally {
    if (!deferCleanup) cleanupOss();
  }
}

export async function materializeQueuedOssAttachments(
  sessionId: string,
  item: unknown,
): Promise<unknown> {
  return (await materializeQueuedOssAttachmentsInternal(sessionId, item, false)).item;
}

/**
 * Direct maker:send carries attachment references in two parallel shapes:
 * the user-message blocks consumed by the agent and
 * sendOpts.persistUserMessage.content stored in the local transcript.
 *
 * Reuse the queued materializer through a temporary files[] projection so both
 * shapes share one download per OSS reference. Cleanup is returned to the
 * caller and must run only after maker:send reports accepted=true, so a
 * pre-accept rejection can retry the original OSS references.
 */
export async function materializeDirectSendOssAttachments(
  sessionId: string,
  message: unknown,
  sendOpts: unknown,
): Promise<{
  message: unknown;
  sendOpts: unknown;
  cleanupAfterAcceptance?: () => void;
  cleanupBeforeAcceptance?: () => Promise<void>;
}> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { message, sendOpts };
  }
  const msg = message as { type?: unknown; content?: unknown };
  if (msg.type !== 'user' || !Array.isArray(msg.content)) {
    return { message, sendOpts };
  }

  const attachmentIndexes: number[] = [];
  const projectedFiles: Array<Record<string, unknown>> = [];
  for (let index = 0; index < msg.content.length; index += 1) {
    const raw = msg.content[index];
    if (
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      (((raw as { type?: unknown }).type === 'image') ||
        (raw as { type?: unknown }).type === 'file')
    ) {
      attachmentIndexes.push(index);
      const block = raw as Record<string, unknown>;
      projectedFiles.push({
        ...block,
        ...(typeof block.path === 'string' ? { url: block.path } : {}),
      });
    }
  }

  const persist =
    sendOpts && typeof sendOpts === 'object' && !Array.isArray(sendOpts)
      ? (sendOpts as { persistUserMessage?: unknown }).persistUserMessage
      : undefined;
  const persistedContent =
    persist && typeof persist === 'object' && !Array.isArray(persist)
      ? (persist as { content?: unknown }).content
      : undefined;
  const hasProjectedOss = projectedFiles.some(
    (file) => isOssRefField(file.url) || isOssRefField(file.path),
  );
  const persistedNeedsMaterialize =
    typeof persistedContent === 'string' && persistedContentNeedsMaterialize(persistedContent);
  if (!hasProjectedOss && !persistedNeedsMaterialize) {
    return { message, sendOpts };
  }

  const materialized = await materializeQueuedOssAttachmentsInternal(
    sessionId,
    {
      files: projectedFiles,
      ...(typeof persistedContent === 'string' ? { persistedContent } : {}),
    },
    true,
  );
  const projected = materialized.item as { files?: unknown; persistedContent?: unknown };
  const materializedFiles = Array.isArray(projected.files) ? projected.files : projectedFiles;
  const nextContent = [...msg.content];
  for (let index = 0; index < attachmentIndexes.length; index += 1) {
    const original = msg.content[attachmentIndexes[index]];
    const materialized = materializedFiles[index];
    if (!original || typeof original !== 'object' || !materialized || typeof materialized !== 'object') {
      continue;
    }
    const originalPath = (original as { path?: unknown }).path;
    const pathValue = (materialized as { path?: unknown }).path;
    if (
      isOssRefField(originalPath) &&
      typeof pathValue === 'string' &&
      pathValue !== originalPath
    ) {
      nextContent[attachmentIndexes[index]] = {
        ...(original as object),
        path: pathValue,
        base64: undefined,
      };
    }
  }

  let nextSendOpts = sendOpts;
  if (
    typeof projected.persistedContent === 'string' &&
    projected.persistedContent !== persistedContent &&
    sendOpts &&
    typeof sendOpts === 'object' &&
    !Array.isArray(sendOpts) &&
    persist &&
    typeof persist === 'object' &&
    !Array.isArray(persist)
  ) {
    nextSendOpts = {
      ...(sendOpts as object),
      persistUserMessage: {
        ...(persist as object),
        content: projected.persistedContent,
      },
    };
  }

  return {
    message: { ...msg, content: nextContent },
    sendOpts: nextSendOpts,
    ...(materialized.cleanupAfterAcceptance
      ? { cleanupAfterAcceptance: materialized.cleanupAfterAcceptance }
      : {}),
    ...(materialized.cleanupBeforeAcceptance
      ? { cleanupBeforeAcceptance: materialized.cleanupBeforeAcceptance }
      : {}),
  };
}

export async function cleanupSessionTempAttachments(sessionId: string): Promise<void> {
  const dir = TEMP_DIRS_BY_SESSION.get(sessionId);
  if (!dir) return;
  TEMP_DIRS_BY_SESSION.delete(sessionId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (e) {
    log.warn('cleanup temp attachments failed', { sessionId, error: String(e) });
  }
}
