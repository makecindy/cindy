/**
 * modelCacheStore.ts
 * ---------------------------------------------------------------------------
 * 只读 cache store —— mirror of videoCacheStore.ts, 但服务 mivo 3D 模型文件
 * (.glb 为主, OBJ/FBX 是后续 convert_3d_model_format 才会产生的另类目)。
 *
 * 写入路径不在这里 —— 文件由 `maker-ipc/mivo.ts` 的 ensureModelFileCached
 * 通过 mivoClient.downloadFileToPath 落盘到
 *   userData/cc-agent/lizi-mivo-models/{fileId}.{ext}
 * 本 store 只做 URL → 绝对路径的安全解析, 给 modelProtocol.ts 用来响应
 * `<model-viewer src="xdt-model://...">` 的 fetch 请求。
 *
 * 与 videoCacheStore 的差异:
 *   - 单 host: `mivo-3d-cache`
 *   - 不暴露 saveXxx —— 不在本模块写文件
 *   - 没有 Range 解析需求 (model-viewer 一次性 fetch 整个 .glb), readFile
 *     就够用; videoCacheStore 留的 streamFile 这里不需要
 */

import { app } from 'electron';
import path from 'node:path';
import fsp from 'node:fs/promises';

const SCHEME = 'xdt-model';

const RESERVED_HOSTS: Record<string, () => string> = {
  'mivo-3d-cache': () =>
    path.join(app.getPath('userData'), 'cc-agent', 'lizi-mivo-models'),
};

const MIME_BY_EXT: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

export function resolveSafe(url: string): { absPath: string; mimeType: string } {
  if (typeof url !== 'string' || !url.startsWith(`${SCHEME}://`)) {
    throw new Error('xdt-model: invalid url');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('xdt-model: malformed url');
  }
  let host: string;
  let filename: string;
  try {
    host = decodeURIComponent(parsed.hostname);
    const pathnameRaw = parsed.pathname.startsWith('/')
      ? parsed.pathname.slice(1)
      : parsed.pathname;
    filename = decodeURIComponent(pathnameRaw);
  } catch {
    throw new Error('xdt-model: malformed url');
  }

  if (
    !host ||
    !filename ||
    host.includes('..') ||
    host.includes('\0') ||
    filename.includes('..') ||
    filename.includes('\0') ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    throw new Error('xdt-model: path out of bounds');
  }

  const reservedDirFn = RESERVED_HOSTS[host];
  if (!reservedDirFn) {
    throw new Error('xdt-model: unknown host');
  }
  const baseDir = path.resolve(reservedDirFn());
  const absPath = path.resolve(baseDir, filename);
  if (!absPath.startsWith(baseDir + path.sep)) {
    throw new Error('xdt-model: path out of bounds');
  }
  const ext = path.extname(filename).toLowerCase();
  const mimeType = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  return { absPath, mimeType };
}

export async function readFile(url: string): Promise<{
  buffer: Buffer;
  mimeType: string;
}> {
  const { absPath, mimeType } = resolveSafe(url);
  const buffer = await fsp.readFile(absPath);
  return { buffer, mimeType };
}

export function getModelsDir(): string {
  return RESERVED_HOSTS['mivo-3d-cache']();
}

/** Build a renderer-loadable xdt-model:// URL for a cached model filename. */
export function buildModelUrl(filename: string): string {
  return `${SCHEME}://mivo-3d-cache/${encodeURIComponent(filename)}`;
}
