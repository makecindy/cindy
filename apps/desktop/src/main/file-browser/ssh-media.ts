/**
 * ssh-media.ts — SSH 远端会话的聊天媒体取回与服务(cindy-remote-media:// 的 ssh 分支)。
 * ---------------------------------------------------------------------------
 * renderer 把 SSH 会话里 workdir 内的 `xdt-file://?path=` / `xdt-audio://?path=`
 * 媒体 URL 改写成携带 `{k:'ssh',id,wd}` token 的 cindy-remote-media://(见
 * shared/remoteMediaUrl.ts)。本模块负责控制端 main 侧的服务:
 *
 *   1. 从原始 URL 解出绝对路径 → 换算 workdir 相对 POSIX 路径(workdir 外拒绝
 *      —— file-service 的 assertInsideWorkdir 铁律,双保险这里先挡);
 *   2. `stat` 拿 size/mtime → `fetchRemoteFileToCache` 分片拉到本地磁盘缓存
 *      (与侧边栏文件浏览器共享 `ssh:{hostId}|{workdir}` 缓存桶:同一文件两个
 *      入口只拉一次;LRU 4GB、identity 含 size/mtime 天然失效);
 *   3. 从缓存文件流式服务,支持 HTTP Range(206)—— SSH 会话的 <video> seek
 *      靠磁盘 range,不整读进内存(与 device 分支的 OSS range 流对位)。
 *
 * 与 device 分支(OSS 中转 + 内存缓存)的差异是刻意的:SSH 字节走 file-service
 * 直连、不经任何服务器,落盘缓存跨重启复用;两条管线各用各的缓存,互不迁就。
 *
 * 依赖注入:request(file-service RPC)与 fetchToCache 可注入,单测不触 SSH /
 * electron;生产默认走 RemoteFileBrowserManager 单例(getRemoteFileBrowser)。
 */

import { createReadStream, promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { createLogger } from '../logger.js';
import { parseRangeHeader } from '../localFileProtocol.js';
import { extractMediaPathQuery } from '../../shared/remoteMediaUrl.js';
import { fetchRemoteFileToCache, type FetchExecutor, type FetchProgressFn } from './remote-file-cache.js';
import { getRemoteFileBrowser } from './remote-deps.js';

const log = createLogger('file-browser/ssh-media');

/** file-service RPC 请求形态(RemoteFileBrowserManager.request 的窄化投影)。 */
export type SshFsRequest = <T>(
  hostId: string,
  method: 'stat' | 'readFileChunk',
  params: Record<string, unknown>,
) => Promise<T>;

/** 可注入依赖(单测替换;生产用默认值)。 */
export interface SshMediaDeps {
  request: SshFsRequest;
  fetchToCache: typeof fetchRemoteFileToCache;
}

/** SSH 媒体取回的本地缓存结果；供协议响应与 device-link 上传共用。 */
export type MaterializedSshRemoteMedia =
  | {
      ok: true;
      cachePath: string;
      size: number;
      mime: string;
      relPath: string;
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 415 | 502;
      message: string;
    };

function defaultDeps(): SshMediaDeps {
  return {
    request: <T>(hostId: string, method: 'stat' | 'readFileChunk', params: Record<string, unknown>) =>
      getRemoteFileBrowser().request(hostId, method, params as never) as Promise<T>,
    fetchToCache: fetchRemoteFileToCache,
  };
}

/** file-service 单片上限(与 fetchRemoteBigFile 的 SSH 分支同值)。 */
const CHUNK_LENGTH = 1024 * 1024;

/**
 * SSH 分片取回执行体:readFileChunk 循环写 destPath。从 fetchRemoteBigFile 的
 * SSH 分支抽出成共享实现——大文件浏览器取回与聊天媒体取回必须是同一条管线
 * (同缓存、同容错语义),不许各自漂移。
 */
export function makeSshChunkExecutor(
  request: SshFsRequest,
  hostId: string,
  workdir: string,
  relPath: string,
): FetchExecutor {
  return async (destPath, progress) => {
    const handle = await fsPromises.open(destPath, 'w');
    try {
      let offset = 0;
      for (;;) {
        const chunk = await request<{ dataBase64: string; eof: boolean; size: number; mtimeMs: number }>(
          hostId,
          'readFileChunk',
          { workdir, relPath, offset, length: CHUNK_LENGTH },
        );
        const buf = Buffer.from(chunk.dataBase64, 'base64');
        if (buf.length > 0) {
          await handle.write(buf, 0, buf.length, offset);
          offset += buf.length;
        }
        progress(Math.min(offset, chunk.size), chunk.size, 'download');
        if (chunk.eof) break;
        if (buf.length === 0) throw new Error('empty chunk before eof');
      }
    } finally {
      await handle.close();
    }
  };
}

// 绝对路径 → workdir 相对 POSIX 路径:实现已抽到 shared/workdirPath(renderer
// 的目录 chip 定位也要用),这里保留 re-export 维持既有引用面。
import { toWorkdirRelPosix } from '../../shared/workdirPath.js';
export { toWorkdirRelPosix };

/**
 * 媒体扩展名 → MIME。与 localFileProtocol 的白名单同族并补音频(xdt-audio://
 * 会被改写进本管线);名单外一律 415 —— 本协议只服务渲染层媒体,不做任意
 * 二进制下载通道(文件打开走 chat-file:fetch,另一条 IPC)。
 */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.drawio': 'application/xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  // HTML 预览的同目录资源(review P1):手机端 htmlLocalResources 接受这些扩展名并把它们
  // 内联成 data: URI,本表若不同步,SSH 会话下最常见的 `<link href="assets/style.css">`
  // 会直接 415 —— 本地会话有样式、SSH 会话必然缺样式。
  // 只放宽「类型」,不放宽「范围」:路径仍由上面的 toWorkdirRelPosix 约束在 SSH 工作目录内。
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.opus': 'audio/ogg',
};

/** createReadStream → fetch Response 可用的 web ReadableStream。 */
function streamBody(filePath: string, opts?: { start: number; end: number }): ReadableStream {
  return Readable.toWeb(createReadStream(filePath, opts)) as unknown as ReadableStream;
}

/** 从本地缓存副本按 Range 语义组装 Response(三态与 localFileProtocol 对齐)。 */
export function serveCachedFile(
  cachePath: string,
  size: number,
  mime: string,
  rangeHeader: string | null,
): Response {
  const range = parseRangeHeader(rangeHeader, size);
  if (range?.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Type': mime,
        'Content-Range': `bytes */${size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      },
    });
  }
  if (range) {
    return new Response(streamBody(cachePath, { start: range.start, end: range.end }), {
      status: 206,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      },
    });
  }
  return new Response(size === 0 ? null : streamBody(cachePath), {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    },
  });
}

const noopProgress: FetchProgressFn = () => undefined;

/**
 * 把 SSH 会话工作目录内的媒体取回到本地磁盘缓存。
 * 失败语义与 device 分支对齐:上游(SSH / file-service)失败 → 502,renderer
 * 媒体占位 + 可重试;路径不合法(workdir 外 / 无路径语义 / 扩展名不在媒体
 * 名单)→ 4xx,不重试。
 */
export async function materializeSshRemoteMedia(
  origin: { remoteHostId: string; workdir: string },
  origUrl: string,
  deps: SshMediaDeps = defaultDeps(),
  /**
   * 取件方带来的额外约束(HTML 资源透传专用;省略 = 只受既有 workdir 限界约束)。
   *
   * 两项都必须在**拉取之前**判:本函数 stat 完就会把整份文件分片拉进 Desktop 磁盘缓存,
   * 拉完再判等于 SSH 流量与磁盘已经花掉(review P2)。
   *
   * `baseDir` 在 SSH 分支只能做**词法**包含判定 —— 远端路径的 realpath 要多一次 RPC,而
   * file-service 现在没有暴露 realpath;这条限制与既有 SSH 媒体边界(toWorkdirRelPosix
   * 也是词法的、侧边栏文件浏览器共用)同级,不是本次新引入的缺口。
   */
  limits?: { baseDir?: string; maxBytes?: number },
): Promise<MaterializedSshRemoteMedia> {
  const abs = extractMediaPathQuery(origUrl);
  if (!abs) return { ok: false, status: 400, message: '媒体 URL 缺少路径语义' };
  const relPath = toWorkdirRelPosix(origin.workdir, abs);
  if (!relPath) return { ok: false, status: 403, message: '媒体路径不在 SSH 会话工作目录内' };

  const baseDir = limits?.baseDir;
  if (baseDir) {
    // baseDir == workdir 本身是合法的(HTML 就在工作目录根),但 toWorkdirRelPosix 对
    // 「workdir 自身」按约定回 null(它服务的是"目录内的某个文件"),所以这里先单独判等,
    // 判等成立就不再额外收窄 —— 既有的 workdir 限界已经等价。
    const normWorkdir = origin.workdir.replace(/\/+$/, '');
    const normBaseDir = baseDir.replace(/\/+$/, '');
    if (normBaseDir !== normWorkdir) {
      const baseRel = toWorkdirRelPosix(origin.workdir, normBaseDir);
      // 基目录自己必须也在 workdir 内,否则这条约束无从谈起。
      if (baseRel === null) {
        return { ok: false, status: 403, message: '资源基目录不在 SSH 会话工作目录内' };
      }
      // 按**路径段**比,不是字符串前缀:`out2/a.png` 以 `out` 开头但不在 `out/` 内。
      if (!relPath.startsWith(`${baseRel}/`)) {
        return { ok: false, status: 403, message: '资源不在允许的基目录内' };
      }
    }
  }

  const ext = path.posix.extname(relPath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return { ok: false, status: 415, message: '该扩展名不是允许的媒体类型' };

  try {
    const stat = await deps.request<{ type: 'file' | 'directory'; size: number; mtimeMs: number }>(
      origin.remoteHostId,
      'stat',
      { workdir: origin.workdir, relPath },
    );
    if (stat.type !== 'file') return { ok: false, status: 404, message: 'SSH 媒体文件不存在' };
    const maxBytes = limits?.maxBytes;
    if (maxBytes !== undefined && stat.size > maxBytes) {
      return {
        ok: false,
        status: 403,
        message: `资源超出取件大小上限(${stat.size} > ${maxBytes} 字节)`,
      };
    }

    const cachePath = await deps.fetchToCache(
      {
        transport: 'ssh',
        endpointId: origin.remoteHostId,
        workdir: origin.workdir,
        relPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      },
      makeSshChunkExecutor(deps.request, origin.remoteHostId, origin.workdir, relPath),
      noopProgress,
    );
    return { ok: true, cachePath, size: stat.size, mime, relPath };
  } catch (err) {
    log.warn('ssh remote media fetch failed', { relPath, error: String(err) });
    return { ok: false, status: 502, message: 'SSH 远程媒体取回失败' };
  }
}

/** 处理一个 ssh 来源的 cindy-remote-media 请求。 */
export async function serveSshRemoteMedia(
  origin: { remoteHostId: string; workdir: string },
  origUrl: string,
  rangeHeader: string | null,
  deps: SshMediaDeps = defaultDeps(),
): Promise<Response> {
  const materialized = await materializeSshRemoteMedia(origin, origUrl, deps);
  if (!materialized.ok) return new Response(null, { status: materialized.status });
  return serveCachedFile(materialized.cachePath, materialized.size, materialized.mime, rangeHeader);
}
