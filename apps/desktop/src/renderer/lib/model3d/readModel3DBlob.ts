/**
 * readModel3DBlob — 把一个 3D 模型来源读成 `Blob`，供查看器与缩略图共用。
 * ---------------------------------------------------------------------------
 * 两条来源通道的字节读取方式不同，且都不能让 Renderer 直接 `fetch` 本地文件：
 *   - `blob`：媒体总仓里的 GLB（`cindy-media://blobs/<hash>.glb`）。协议允许 `fetch`，
 *     先看 Content-Length 再读，超限直接拒绝，不把巨大文件读进内存。
 *   - `local`：用户磁盘上的模型文件。CSP 的 connect-src 刻意不含 `xdt-file:`，
 *     必须经主进程 `readModelFileBytes`（路径策略 + 模型扩展名 + 128MB 上限）取字节。
 */

import { getModel3DFormat } from '@cindy/maker-shared/model3d';

/** 查看器可读的最大模型字节数，与主进程 `READ_MODEL_BYTES_CAP` 对齐。 */
export const MODEL3D_VIEW_MAX_BYTES = 128 * 1024 * 1024;

/** 缩略图的模型字节上限：Three 加载器在主线程同步解析，过大的文件会卡界面。 */
export const MODEL3D_THUMBNAIL_MAX_BYTES = 32 * 1024 * 1024;

export type Model3DSource =
  | {
      /** 媒体总仓 GLB：`cindy-media://blobs/<sha256>.glb`。 */
      kind: 'blob';
      url: string;
    }
  | {
      /** 用户磁盘上的模型文件绝对路径。 */
      kind: 'local';
      absPath: string;
    };

/** 主进程 `readModelFileBytes` 超过上限时的拒绝文案（见 main/fileReadBytes.ts）。 */
const MAIN_SIZE_LIMIT_MESSAGE = 'file exceeds the preview size limit';

export class Model3DTooLargeError extends Error {
  readonly size: number | null;
  readonly limit: number;
  constructor(size: number | null, limit: number) {
    super('3D model exceeds the size limit');
    this.name = 'Model3DTooLargeError';
    this.size = size;
    this.limit = limit;
  }
}

export interface ReadModel3DOptions {
  signal?: AbortSignal;
  /** 允许读取的最大字节数 @default MODEL3D_VIEW_MAX_BYTES */
  maxBytes?: number;
}

export interface ModelBlob {
  blob: Blob;
  /** 带扩展名的文件名：库按它选择加载器，Blob 本身不携带格式。 */
  fileName: string;
}

/** 来源对应的文件名（含扩展名）。 */
export function model3DFileName(source: Model3DSource): string {
  if (source.kind === 'local') {
    return source.absPath.split(/[\\/]/).pop() || 'model';
  }
  try {
    const last = new URL(source.url).pathname.split('/').pop() ?? '';
    return decodeURIComponent(last) || 'model.glb';
  } catch {
    return source.url.split('/').pop() || 'model.glb';
  }
}

/** 来源的格式（小写扩展名）；不是 3D 模型返回 null。 */
export function model3DSourceFormat(source: Model3DSource): string | null {
  return getModel3DFormat(model3DFileName(source));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function mimeTypeForResource(uri: string, declared?: unknown): string {
  if (typeof declared === 'string' && declared) return declared;
  const ext = uri.split(/[?#]/, 1)[0].split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    case 'ktx2':
      return 'image/ktx2';
    default:
      return 'application/octet-stream';
  }
}

function localGltfResourceUri(uri: string): string | null {
  const raw = uri.split(/[?#]/, 1)[0];
  if (!raw || /^(?:data|blob|https?|file):/i.test(raw) || raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) {
    return null;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * A Blob has no directory for GLTFLoader to resolve external resources from.
 * Inline relative buffers/textures after they have been read through the
 * dedicated, directory-confined main-process IPC.
 */
async function inlineLocalGltfResources(
  source: Extract<Model3DSource, { kind: 'local' }>,
  fileName: string,
  bytes: Uint8Array,
  maxBytes: number,
): Promise<Uint8Array> {
  if (getModel3DFormat(fileName) !== 'gltf') return bytes;
  let document: {
    buffers?: Array<{ uri?: unknown }>;
    images?: Array<{ uri?: unknown; mimeType?: unknown }>;
  };
  try {
    document = JSON.parse(new TextDecoder().decode(bytes)) as typeof document;
  } catch {
    return bytes;
  }

  const references: Array<{ target: { uri?: unknown; mimeType?: unknown }; uri: string }> = [];
  for (const target of [...(document.buffers ?? []), ...(document.images ?? [])]) {
    if (typeof target.uri !== 'string') continue;
    const uri = localGltfResourceUri(target.uri);
    if (uri) references.push({ target, uri });
  }
  if (references.length === 0) return bytes;

  const resources = new Map<string, string>();
  let totalBytes = bytes.byteLength;
  for (const { target, uri } of references) {
    let dataUri = resources.get(uri);
    if (!dataUri) {
      const resource = await window.electronAPI.readModelFileResourceBytes({
        modelPath: source.absPath,
        relativePath: uri,
      });
      totalBytes += resource.size;
      if (totalBytes > maxBytes) throw new Model3DTooLargeError(totalBytes, maxBytes);
      dataUri = `data:${mimeTypeForResource(uri, target.mimeType)};base64,${bytesToBase64(resource.bytes)}`;
      resources.set(uri, dataUri);
    }
    target.uri = dataUri;
  }

  const inlined = new TextEncoder().encode(JSON.stringify(document));
  if (inlined.byteLength > maxBytes) throw new Model3DTooLargeError(inlined.byteLength, maxBytes);
  return inlined;
}

export async function readModel3DBlob(
  source: Model3DSource,
  options: ReadModel3DOptions = {},
): Promise<ModelBlob> {
  const maxBytes = options.maxBytes ?? MODEL3D_VIEW_MAX_BYTES;
  options.signal?.throwIfAborted?.();
  const fileName = model3DFileName(source);

  if (source.kind === 'blob') {
    const res = await fetch(source.url, { signal: options.signal });
    if (!res.ok) throw new Error(`Failed to read 3D model (${res.status})`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Model3DTooLargeError(declared, maxBytes);
    }
    const blob = await res.blob();
    if (blob.size > maxBytes) throw new Model3DTooLargeError(blob.size, maxBytes);
    return { blob, fileName };
  }

  // 先 stat 再读：主进程对超过 128 MiB 的文件直接拒绝（PRECONDITION_FAILED），不先看大小的话
  // 用户只会看到「加载失败」，分不清是文件坏了还是太大。stat 失败不影响后面的读取。
  const statSize = await window.electronAPI.fsBrowse
    .statPath(source.absPath)
    .then((stat) => (stat.kind === 'file' && typeof stat.sizeBytes === 'number' ? stat.sizeBytes : null))
    .catch(() => null);
  options.signal?.throwIfAborted?.();
  if (statSize !== null && statSize > maxBytes) throw new Model3DTooLargeError(statSize, maxBytes);

  let read: { bytes: Uint8Array; size: number };
  try {
    read = await window.electronAPI.readModelFileBytes({ filePath: source.absPath });
  } catch (error) {
    // stat 之后文件才长大 / stat 不可用时，主进程的超限拒绝同样转成可区分的错误
    if (error instanceof Error && error.message.includes(MAIN_SIZE_LIMIT_MESSAGE)) {
      throw new Model3DTooLargeError(null, maxBytes);
    }
    throw error;
  }
  options.signal?.throwIfAborted?.();
  if (read.size > maxBytes) throw new Model3DTooLargeError(read.size, maxBytes);
  const bytes = await inlineLocalGltfResources(source, fileName, read.bytes, maxBytes);
  options.signal?.throwIfAborted?.();
  return { blob: new Blob([bytes as BlobPart]), fileName };
}
