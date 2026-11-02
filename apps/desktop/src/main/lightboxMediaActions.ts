/**
 * lightboxMediaActions.ts
 * ---------------------------------------------------------------------------
 * 图片 lightbox 的三个媒体动作(main 侧业务体):
 *   - media:open-with-default-app —— 用系统默认应用打开图片
 *   - media:save-as               —— 另存为(本地图复制;http(s)/data: 先取字节)
 *   - media:cache-for-session     —— "发送到对话":把图片复制成目标会话的一份
 *                                    新 xdt-image:// 缓存,renderer 据此构造附件
 *
 * 为什么"发送到对话"必须复制而不是复用原 URL:附件托盘移除附件时会删除其
 * xdt-image:// 缓存文件(useAttachments.cleanupRemovedCachedImage);若直接复用
 * 历史消息的缓存 URL,用户从托盘移除附件会连带删掉历史消息的图。
 *
 * 结构:纯函数(URL 分类 / 文件名推导)+ createLightboxMediaHandlers 的可注入
 * handler body。Electron 依赖(dialog / shell / imageCacheStore / net)全部由
 * bootstrap-electron.ts 注入,单测用内存 fake 直接 invoke handler body。
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { isDangerousAttachmentName } from '../shared/attachmentSafety';

import { isIpcErrorCode } from '../shared/ipc-errors';
import { throwIpcError } from './utils/ipcValidate';

// ---------------------------------------------------------------------------
// 纯函数:媒体源分类
// ---------------------------------------------------------------------------

/** lightbox 图片 src 的来源分类。unsupported 覆盖 cindy-remote-media:// 等无法在本机落地的源。 */
export type LightboxMediaSource =
  | { kind: 'image-cache'; url: string }
  | { kind: 'local-file'; absPath: string }
  | { kind: 'http'; url: string }
  | { kind: 'data'; mimeType: string; base64: string }
  | { kind: 'remote-media'; url: string }
  | { kind: 'unsupported' };

/** `xdt-file://local/?path=<enc>` 的图片扩展名子集(与 localFileProtocol 白名单的图片部分一致)。 */
const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico',
]);

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/x-icon': '.ico',
};

/**
 * 把 lightbox 的图片 src 归类为可执行动作的来源。
 * - `xdt-image://` 交回 handler 用 imageCacheStore.resolveSafe 解析(带安全校验);
 * - `xdt-file://` 在这里解出绝对路径并做与协议 handler 相同的三重校验
 *   (绝对路径、resolve 后无 `..` 逃逸、图片扩展名白名单);
 * - `http(s)://` / `data:image/...;base64,` 标记为需取字节的远程/内联源;
 * - 其余(cindy-remote-media:// / blob: / 相对路径等)一律 unsupported。
 */
export function classifyLightboxMediaUrl(url: string, forSave = false): LightboxMediaSource {
  if (typeof url !== 'string' || url.length === 0) return { kind: 'unsupported' };
  if (forSave && url.startsWith('xdt-video://')) return { kind: 'image-cache', url };
  if (url.startsWith('xdt-image://')) return { kind: 'image-cache', url };
  // cindy-media(媒体总仓 blob)与 xdt-image 同语义:本机缓存文件,可解析绝对
  // 路径;resolveImageCacheUrl 依赖按 scheme 分派到对应 store(bootstrap 接线)。
  if (url.startsWith('cindy-media://')) return { kind: 'image-cache', url };
  if (url.startsWith('xdt-file://')) {
    try {
      const parsed = new URL(url);
      const raw = parsed.searchParams.get('path');
      if (!raw) return { kind: 'unsupported' };
      const isAbsolute = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/');
      if (!isAbsolute) return { kind: 'unsupported' };
      // 与 localFileProtocol 相同的防 `..` 逃逸校验:resolve 与 normalize 必须
      // 一致(win32 分隔符/大小写差异按不敏感比较)。
      const resolved = path.resolve(raw);
      const normalizedInput = path.normalize(raw);
      const eq =
        process.platform === 'win32'
          ? resolved.toLowerCase() === normalizedInput.toLowerCase()
          : resolved === normalizedInput;
      if (!eq) return { kind: 'unsupported' };
      if (
        (!forSave && !IMAGE_EXTS.has(path.extname(resolved).toLowerCase())) ||
        (forSave && isDangerousAttachmentName(resolved))) {
        return { kind: 'unsupported' };
      }
      return { kind: 'local-file', absPath: resolved };
    } catch {
      return { kind: 'unsupported' };
    }
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return { kind: 'http', url };
  }
  if (url.startsWith('cindy-remote-media://')) {
    // 远程会话图:字节经协议管线(OSS 中转/SSH)可达,main 侧动作按需取件。
    return { kind: 'remote-media', url };
  }
  if (url.startsWith('data:')) {
    const match = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i.exec(url);
    if (!match) return { kind: 'unsupported' };
    return { kind: 'data', mimeType: match[1].toLowerCase(), base64: match[2] };
  }
  return { kind: 'unsupported' };
}

/** 按 ext 推 mimeType,未知回退 image/png。 */
export function mimeTypeForExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'image/png';
}

/** 按 mimeType 推 ext,未知回退 .png。 */
export function extForMimeType(mimeType: string): string {
  return EXT_BY_MIME[mimeType.toLowerCase()] ?? '.png';
}

/**
 * 另存为对话框的建议文件名。
 * - 本地源:取源文件 basename;
 * - http 源:取 URL pathname 的末段(带图片扩展名才可信,否则回退时间戳名);
 * - data 源:时间戳名 + mime 推导扩展名。
 * `now` 由调用方传入,保持纯函数可测。
 */
export function suggestSaveFileName(
  source: LightboxMediaSource,
  resolvedAbsPath: string | null,
  now: number,
): string {
  if ((source.kind === 'image-cache' || source.kind === 'local-file') && resolvedAbsPath) {
    return path.basename(resolvedAbsPath);
  }
  if (source.kind === 'http') {
    try {
      const pathname = new URL(source.url).pathname;
      const base = decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? '');
      if (base && IMAGE_EXTS.has(path.extname(base).toLowerCase())) return base;
    } catch {
      // fall through to timestamp name
    }
    return `image-${now}.png`;
  }
  if (source.kind === 'data') {
    return `image-${now}${extForMimeType(source.mimeType)}`;
  }
  return `image-${now}.png`;
}

// ---------------------------------------------------------------------------
// Handler bodies(依赖注入,可单测)
// ---------------------------------------------------------------------------

/** 远程图片下载上限:防御性限制,超过按错误处理(lightbox 里都是可渲染图片,100MB 足够)。 */
export const REMOTE_IMAGE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * data:image base64 载荷解码,解码**前**按估算大小限流(长度 × 3/4,忽略
 * padding 误差)。markdown 渲染允许 data: 图源,模型可产出任意大的 data:
 * URL——不设防会让 Buffer.from 一次性分配远超 http/remote 100MB 防线的内存
 * (review P2)。
 */
export function decodeDataImageOrThrow(base64: string): Buffer {
  if ((base64.length * 3) / 4 > REMOTE_IMAGE_MAX_BYTES) {
    throwIpcError('INVALID_PARAMS', '图片过大');
  }
  return Buffer.from(base64, 'base64');
}

/**
 * 会话图片缓存(imageCacheStore)inferExt 保留的扩展名/mime 子集——其余会被
 * 写成 `.bin` + application/octet-stream,产生的 xdt-image URL 无法预览/发送
 * (review P1)。"发送到对话"入缓存前必须校验;renderer 侧能力判定
 * (ImageLightbox.mediaActionCapabilities)维护同一子集,先行隐藏按钮,
 * 这里是防御兜底。
 */
export const CACHEABLE_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const CACHEABLE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * 按文件头魔数嗅探图片 mime(仅缓存店支持的四种)。http 响应缺失 / 谎报
 * Content-Type 时的兜底——不能默认 image/png:字节是 JPEG 却写成 .png 缓存
 * 文件会造成扩展名 / MIME 与内容不符(review P2)。识别不出返回 null。
 */
export function sniffImageMime(buffer: Buffer): string | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6 && buffer.toString('ascii', 0, 4) === 'GIF8') {
    return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * 流式读取 response body 并累计限流:一旦累计字节超过 maxBytes 立即抛错,
 * 不等整个响应 buffer 完(review P1:无/谎报 Content-Length 的响应会在
 * arrayBuffer() 阶段吃满内存,main 进程 OOM 会带崩整个 app)。调用方负责
 * 在抛错后 abort 底层请求。
 */
export async function collectStreamWithLimit(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error('图片过大,无法下载');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export interface LightboxMediaDeps {
  /** bootstrap-electron 的路径白名单校验。 */
  isPathAllowed(absPath: string): boolean;
  realpath(absPath: string): Promise<string>;
  /** imageCacheStore.resolveSafe:xdt-image:// URL → 缓存文件绝对路径(含安全校验,失败抛错)。 */
  resolveImageCacheUrl(url: string): { absPath: string; mimeType: string };
  /** imageCacheStore.copyFromPath(lifecycle 由调用处指定)。 */
  cacheImageFromPath(params: {
    sessionId: string;
    sourcePath: string;
    originalName: string;
    lifecycle: 'draft';
  }): Promise<{ url: string; filename: string }>;
  /** imageCacheStore.writeBuffer。 */
  cacheImageFromBuffer(params: {
    sessionId: string;
    buffer: Uint8Array;
    mimeType: string;
    suggestedName?: string;
    lifecycle: 'draft';
  }): Promise<{ url: string; filename: string }>;
  /** dialog.showSaveDialog(挂到聚焦窗口)。 */
  showSaveDialog(opts: {
    defaultPath: string }): Promise<{ canceled: boolean; filePath?: string }>;
  /** shell.openPath:成功返回 '',失败返回错误串。 */
  openPath(absPath: string): Promise<string>;
  /** fs.promises.readFile:readImageBytes 的 local-file 分支读字节。 */
  readFile(absPath: string): Promise<Buffer>;
  /** 下载远程图片字节(net.fetch 包装,带超时与大小上限)。 */
  fetchRemoteImage(url: string): Promise<{ buffer: Buffer; mimeType?: string }>;
  /** 取远程会话媒体字节(cindy-remote-media://,复用协议取件管线)。 */
  fetchRemoteMediaImage(url: string): Promise<{ buffer: Buffer; mimeType: string }>;
  /** 临时目录(远程图"用默认应用打开"落临时文件)。 */
  getTempDir(): string;
  fileExists(absPath: string): boolean;
  statSize(absPath: string): Promise<number>;
  copyFile(src: string, dest: string): Promise<void>;
  writeFile(dest: string, data: Buffer): Promise<void>;
  getDownloadsDir(): string;
  now(): number;
}

export interface CacheForSessionResult {
  url: string;
  name: string;
  ext: string;
  mimeType: string;
  size: number;
}

export interface LightboxMediaHandlers {
  openWithDefaultApp(params: { url: string }): Promise<void>;
  saveAs(params: { url: string }): Promise<{ canceled: boolean; savedPath?: string }>;
  cacheForSession(params: {
    url: string;
    sessionId: string }): Promise<CacheForSessionResult>;
  /** renderer 字节层(标注烧录/位图复制)对 http / remote-media 源的取字节入口。 */
  readImageBytes(params: { url: string }): Promise<{ base64: string; mimeType: string }>;
}

/**
 * catch 块首行防御:已带**已知 IpcErrorCode** 的错误(throwIpcError 产物)
 * 原样上抛,不得被外层 catch 重包成 INTERNAL——否则 renderer 拿到错误的
 * code,且 `[INVALID_PARAMS]` 字面前缀会随 message 直接暴露给用户。
 * 必须校验 code 在枚举内而不是"任意 string code":Node fs 错误(ENOSPC /
 * ENOENT 等)同样带 string code,裸抛会破坏编码契约(review P2),它们应
 * 继续落进 INTERNAL 包装。
 */
function rethrowIfIpcError(err: unknown): void {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    isIpcErrorCode((err as { code?: unknown }).code)
  ) {
    throw err;
  }
}

/** 把 xdt-image:// / xdt-file:// 源解析成经过白名单校验、确认存在的本地绝对路径。 */
function resolveLocalSourceOrThrow(
  source: LightboxMediaSource,
  deps: LightboxMediaDeps,
): string {
  let absPath: string;
  if (source.kind === 'image-cache') {
    try {
      absPath = deps.resolveImageCacheUrl(source.url).absPath;
    } catch (err) {
      throwIpcError('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
    }
  } else if (source.kind === 'local-file') {
    absPath = source.absPath;
  } else {
    throwIpcError('INVALID_PARAMS', 'not a local media source');
  }
  if (!deps.isPathAllowed(absPath)) {
    throwIpcError('PERMISSION_DENIED', '不允许访问该路径');
  }
  if (!deps.fileExists(absPath)) {
    throwIpcError('NOT_FOUND', '文件不存在');
  }
  return absPath;
}

/** http / remote-media 源统一取字节(mime 缺失或不可信时交由调用方嗅探)。 */
async function fetchRemoteBytes(
  source: Extract<LightboxMediaSource, { kind: 'http' | 'remote-media' }>,
  deps: LightboxMediaDeps,
): Promise<{ buffer: Buffer; mimeType?: string }> {
  return source.kind === 'http'
    ? deps.fetchRemoteImage(source.url)
    : deps.fetchRemoteMediaImage(source.url);
}

export function createLightboxMediaHandlers(deps: LightboxMediaDeps): LightboxMediaHandlers {
  return {
    // 用系统默认应用打开。本地源直接打开;远程会话图取字节落临时文件后打开
    // (文件实体在被控端,本机没有可直接打开的路径)。http 源 renderer 提供的
    // 是"在浏览器打开",不走这里。
    async openWithDefaultApp(params) {
      const source = classifyLightboxMediaUrl(params?.url ?? '');
      if (source.kind === 'remote-media') {
        try {
          const { buffer, mimeType } = await deps.fetchRemoteMediaImage(source.url);
          const sniffed = sniffImageMime(buffer) ?? mimeType;
          // 文件名按 URL 哈希稳定:同一张图重复打开覆盖同一文件,临时目录
          // 增长以"打开过的不同图数量"为界,而非随点击次数无限累积(review
          // P2)。不能写完立即 unlink——外部应用还要读;目录级清扫由 host
          // 注入的 getTempDir 落到专用子目录 + 退出时删除兜底。
          const urlHash = createHash('sha256').update(source.url).digest('hex').slice(0, 16);
          const tmpPath = path.join(
            deps.getTempDir(),
            `xdt-remote-image-${urlHash}${extForMimeType(sniffed)}`,
          );
          await deps.writeFile(tmpPath, buffer);
          const errMsg = await deps.openPath(tmpPath);
          if (errMsg) throwIpcError('INTERNAL', errMsg);
        } catch (err) {
          rethrowIfIpcError(err);
          throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
        }
        return;
      }
      const absPath = resolveLocalSourceOrThrow(source, deps);
      const errMsg = await deps.openPath(absPath);
      if (errMsg) throwIpcError('INTERNAL', errMsg);
    },

    // renderer 字节层入口:标注烧录 / 位图复制需要把 http / remote-media 的
    // 字节送进 canvas(renderer 对这两类源既无本地路径、也过不了协议 CORS);
    // local-file 也走这里——附件读取 IPC 有 30MB 硬上限,lightbox 能经流式
    // 协议显示的大图会在字节动作上"能看却操作失败"(review P2),本 IPC 与
    // 远程取图共用 100MB 上限。
    async readImageBytes(params) {
      const source = classifyLightboxMediaUrl(params?.url ?? '');
      if (source.kind === 'local-file') {
        const absPath = resolveLocalSourceOrThrow(source, deps);
        // fs 错误(TOCTOU 下的 ENOENT / EACCES 等)不能裸抛出 IPC(规则 13:
        // Electron 序列化丢 code 字段,renderer 解不出),与下方远程分支同样
        // 包 try 统一 INTERNAL。
        try {
          if ((await deps.statSize(absPath)) > REMOTE_IMAGE_MAX_BYTES) {
            throwIpcError('INVALID_PARAMS', '图片过大');
          }
          const buffer = await deps.readFile(absPath);
          const mime =
            MIME_BY_EXT[path.extname(absPath).toLowerCase()] ?? sniffImageMime(buffer);
          if (!mime) {
            throwIpcError('INVALID_PARAMS', '目标不是可识别的图片');
          }
          return { base64: buffer.toString('base64'), mimeType: mime };
        } catch (err) {
          rethrowIfIpcError(err);
          throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
        }
      }
      if (source.kind !== 'http' && source.kind !== 'remote-media') {
        throwIpcError(
          'INVALID_PARAMS',
          'readImageBytes 仅面向 local-file / http / remote-media 源',
        );
      }
      try {
        const { buffer, mimeType } = await fetchRemoteBytes(source, deps);
        const resolvedMime =
          mimeType && CACHEABLE_IMAGE_MIMES.has(mimeType)
            ? mimeType
            : (sniffImageMime(buffer) ?? mimeType);
        if (!resolvedMime || !resolvedMime.startsWith('image/')) {
          throwIpcError('INVALID_PARAMS', '目标不是可识别的图片');
        }
        return { base64: buffer.toString('base64'), mimeType: resolvedMime };
      } catch (err) {
        rethrowIfIpcError(err);
        throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
      }
    },

    // 另存为。先弹保存对话框(只需要建议文件名),确认后才取字节/复制,
    // 用户取消不浪费下载。
    async saveAs(params) {
      // Save supports files; image decoding / annotation keep their image-only classifier.
      const source = classifyLightboxMediaUrl(params?.url ?? '', true);
      if (source.kind === 'unsupported') {
        throwIpcError('INVALID_PARAMS', 'unsupported media source');
      }

      let localAbsPath: string | null = null;
      if (source.kind === 'image-cache' || source.kind === 'local-file') {
        localAbsPath = resolveLocalSourceOrThrow(source, deps);
        try {
          localAbsPath = await deps.realpath(localAbsPath);
          if (!deps.isPathAllowed(localAbsPath) || isDangerousAttachmentName(localAbsPath))
            throwIpcError('PERMISSION_DENIED', '不允许访问该路径');
        } catch (err) {
          rethrowIfIpcError(err);
          throwIpcError('NOT_FOUND', '文件不存在');
        }
      }

      // remote-media 先取字节:正在 lightbox 显示的图协议缓存大概率命中(快),
      // 且文件名扩展要从实际 mime 推(remote url 无路径语义)。
      let remoteBytes: { buffer: Buffer; mimeType?: string } | null = null;
      let suggested: string;
      if (source.kind === 'remote-media') {
        try {
          remoteBytes = await deps.fetchRemoteMediaImage(source.url);
        } catch (err) {
          rethrowIfIpcError(err);
          throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
        }
        const mime = sniffImageMime(remoteBytes.buffer) ?? remoteBytes.mimeType ?? 'application/octet-stream';
        const mediaExt: Record<string, string> = {
          'video/mp4': '.mp4',
          'video/quicktime': '.mov',
          'video/webm': '.webm',
          'audio/mpeg': '.mp3',
          'audio/mp4': '.m4a',
          'audio/wav': '.wav',
          'audio/ogg': '.ogg',
          'application/pdf': '.pdf',
          'model/gltf-binary': '.glb',
        };
        suggested = `${mime.startsWith('image/') ? 'image' : 'media'}-${deps.now()}${mediaExt[mime] ?? (mime.startsWith('image/') ? extForMimeType(mime) : '.bin')}`;
      } else {
        suggested = suggestSaveFileName(source, localAbsPath, deps.now());
        if (source.kind === 'http') {
          try {
            const base = decodeURIComponent(new URL(source.url).pathname.split('/').pop() ?? '');
            if (base && !/[\\/\x00-\x1f]/.test(base) && !isDangerousAttachmentName(base))
              suggested = base;
          } catch {
            /* retain the safe fallback */
          }
        }
      }

      const { canceled, filePath } = await deps.showSaveDialog({
        defaultPath: path.join(deps.getDownloadsDir(), suggested),
      });
      if (canceled || !filePath) return { canceled: true };

      try {
        if (localAbsPath) {
          await deps.copyFile(localAbsPath, filePath);
        } else if (remoteBytes) {
          await deps.writeFile(filePath, remoteBytes.buffer);
        } else if (source.kind === 'http') {
          const { buffer } = await deps.fetchRemoteImage(source.url);
          await deps.writeFile(filePath, buffer);
        } else if (source.kind === 'data') {
          await deps.writeFile(filePath, decodeDataImageOrThrow(source.base64));
        }
      } catch (err) {
        rethrowIfIpcError(err);
        throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
      }
      return { canceled: false, savedPath: filePath };
    },

    // "发送到对话":为目标会话复制一份新的 xdt-image:// 缓存(lifecycle: draft,
    // 与拖拽/粘贴入托盘一致),返回 renderer 构造 AttachedFile 所需的元数据。
    async cacheForSession(params) {
      const sessionId = params?.sessionId;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throwIpcError('INVALID_PARAMS', 'sessionId required');
      }
      const source = classifyLightboxMediaUrl(params?.url ?? '');
      if (source.kind === 'unsupported') {
        throwIpcError('INVALID_PARAMS', 'unsupported media source');
      }

      if (source.kind === 'image-cache' || source.kind === 'local-file') {
        // resolveLocalSourceOrThrow 抛的是编码好的 IpcError,留在 try 外原样上抛。
        const absPath = resolveLocalSourceOrThrow(source, deps);
        const name = path.basename(absPath);
        const ext = path.extname(absPath).toLowerCase();
        // svg/bmp/ico 等虽可预览,但入会话缓存会被写成 .bin 破坏元数据。
        if (!CACHEABLE_IMAGE_EXTS.has(ext)) {
          throwIpcError('INVALID_PARAMS', '该图片格式暂不支持发送到对话');
        }
        try {
          const [cached, size] = await Promise.all([
            deps.cacheImageFromPath({
              sessionId,
              sourcePath: absPath,
              originalName: name,
              lifecycle: 'draft',
            }),
            deps.statSize(absPath),
          ]);
          return { url: cached.url, name, ext, mimeType: mimeTypeForExt(ext), size };
        } catch (err) {
          rethrowIfIpcError(err);
          throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
        }
      }

      try {
        const bytes =
          source.kind === 'http' || source.kind === 'remote-media'
            ? await fetchRemoteBytes(source, deps)
            : { buffer: decodeDataImageOrThrow(source.base64), mimeType: source.mimeType };
        // mime 判定:data: 源用声明值;http 源优先可信的响应 header,缺失 /
        // 不在支持集时按字节魔数嗅探,绝不默认 png(review P2)。仍识别不出
        // 或不在缓存店支持集(如 svg)→ 拒绝,避免入缓存变 .bin / 扩展名与
        // 字节不符。
        const mimeType =
          source.kind === 'data'
            ? source.mimeType
            : bytes.mimeType && CACHEABLE_IMAGE_MIMES.has(bytes.mimeType)
              ? bytes.mimeType
              : sniffImageMime(bytes.buffer);
        if (!mimeType || !CACHEABLE_IMAGE_MIMES.has(mimeType)) {
          throwIpcError('INVALID_PARAMS', '该图片格式暂不支持发送到对话');
        }
        const ext = extForMimeType(mimeType);
        const name = suggestSaveFileName(source, null, deps.now());
        const cached = await deps.cacheImageFromBuffer({
          sessionId,
          buffer: bytes.buffer,
          mimeType,
          suggestedName: name,
          lifecycle: 'draft',
        });
        return { url: cached.url, name, ext, mimeType, size: bytes.buffer.byteLength };
      } catch (err) {
        rethrowIfIpcError(err);
        throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
      }
    },
  };
}
