/**
 * thumbnails — 3D 模型缩略图服务（渲染进程 WebGL）。
 * ---------------------------------------------------------------------------
 * 用 `mivo-model-viewer` 的 `createThumbnailRenderer` 在渲染进程生成缩略图：整个服务
 * 共用一个 WebGL 上下文，任务串行，空闲 30 秒后自动释放上下文。
 *
 * 缓存与去重：
 *   - 同一个来源的并发请求共享同一个 Promise；成功结果缓存为 data URL（不会像
 *     object URL 那样在淘汰时被 revoke 而让已显示的卡片变成裂图），按 LRU 保留最近
 *     `CACHE_LIMIT` 张。
 *   - 本地文件的缓存键带上修改时间与大小，文件被改写后自动重新生成。
 *   - 失败结果短暂缓存（`FAILURE_TTL_MS`），避免列表重绘时反复读取、反复失败。
 * 缩略图只存在内存里，应用重启后重新生成；不写入媒体总仓。
 */

import {
  MODEL3D_THUMBNAIL_MAX_BYTES,
  type Model3DSource,
  model3DFileName,
  readModel3DBlob,
} from './readModel3DBlob';
import { loadModelViewerSdk } from './modelViewerSdk';

// 卡片是 1:1 方块,缩略图也按正方形渲染:非正方形图被 object-contain 塞进方块会缩成一条,
// 模型在卡片里就只占一小块。
export const THUMBNAIL_WIDTH = 512;
export const THUMBNAIL_HEIGHT = 512;
// 取景留白系数:模型在方形缩略图里占画面约 60%–70%(立方体 1.25 时约 65%)。机位用库的默认值 `angled`
// (3/4 斜视角),正对镜头的规则形体会退化成一块平面。
export const THUMBNAIL_PADDING = 1.25;

const CACHE_LIMIT = 48;
const FAILURE_TTL_MS = 30_000;

interface CacheEntry {
  promise: Promise<string>;
  failedAt: number | null;
}

const cache = new Map<string, CacheEntry>();
let rendererPromise: Promise<import('mivo-model-viewer').ThumbnailRenderer> | null = null;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to encode thumbnail'));
    reader.readAsDataURL(blob);
  });
}

async function getRenderer() {
  if (!rendererPromise) {
    rendererPromise = loadModelViewerSdk()
      .then((sdk) =>
        sdk.createThumbnailRenderer({
          idleMs: 30_000,
          width: THUMBNAIL_WIDTH,
          height: THUMBNAIL_HEIGHT,
        }),
      )
      .catch((error: unknown) => {
        rendererPromise = null;
        throw error;
      });
  }
  return rendererPromise;
}

/** 本地文件的缓存键需要修改时间与大小；拿不到时退化为仅路径（仍可用，只是不感知改写）。 */
async function cacheKeyFor(source: Model3DSource): Promise<string> {
  if (source.kind === 'blob') return `blob:${source.url}`;
  try {
    const stat = await window.electronAPI.fsBrowse.statPath(source.absPath);
    if (stat.kind === 'file') {
      if (typeof stat.sizeBytes === 'number' && stat.sizeBytes > MODEL3D_THUMBNAIL_MAX_BYTES) {
        // 先于读取就拒绝：不把过大的文件读进内存
        throw Object.assign(new Error('3D model is too large for a thumbnail'), {
          name: 'Model3DTooLargeError',
        });
      }
      return `local:${source.absPath}:${stat.mtimeMs ?? 0}:${stat.sizeBytes ?? 0}`;
    }
  } catch (error) {
    if ((error as Error)?.name === 'Model3DTooLargeError') throw error;
  }
  return `local:${source.absPath}`;
}

async function generate(source: Model3DSource): Promise<string> {
  const { blob, fileName } = await readModel3DBlob(source, { maxBytes: MODEL3D_THUMBNAIL_MAX_BYTES });
  const renderer = await getRenderer();
  const image = await renderer.render({
    model: blob,
    fileName: fileName || model3DFileName(source),
    width: THUMBNAIL_WIDTH,
    height: THUMBNAIL_HEIGHT,
    padding: THUMBNAIL_PADDING,
    format: 'png',
  });
  return blobToDataUrl(image.blob);
}

function touch(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * 取一个模型的缩略图（data URL）。失败时 reject；调用方按失败展示占位即可。
 */
export async function getModel3DThumbnail(source: Model3DSource): Promise<string> {
  const key = await cacheKeyFor(source);
  const existing = cache.get(key);
  if (existing) {
    const stillFailing = existing.failedAt !== null && Date.now() - existing.failedAt < FAILURE_TTL_MS;
    if (existing.failedAt === null || stillFailing) {
      touch(key, existing);
      return existing.promise;
    }
    cache.delete(key);
  }
  const entry: CacheEntry = { promise: generate(source), failedAt: null };
  entry.promise.catch(() => {
    entry.failedAt = Date.now();
  });
  touch(key, entry);
  return entry.promise;
}

/** 释放 WebGL 上下文并清空缓存（账号切换、测试隔离）。 */
export function resetModel3DThumbnails(): void {
  cache.clear();
  const pending = rendererPromise;
  rendererPromise = null;
  void pending?.then((renderer) => renderer.dispose()).catch(() => undefined);
}
