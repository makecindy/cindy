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

  const { bytes, size } = await window.electronAPI.readModelFileBytes({ filePath: source.absPath });
  options.signal?.throwIfAborted?.();
  if (size > maxBytes) throw new Model3DTooLargeError(size, maxBytes);
  return { blob: new Blob([bytes as BlobPart]), fileName };
}
