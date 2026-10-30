/**
 * cindyMediaProtocol.ts — `cindy-media://` 媒体总仓统一取件协议。
 * ---------------------------------------------------------------------------
 * 服务字节仓里的 blob:`cindy-media://blobs/<指纹>.<ext>` → 主窗口 <img>/<video>
 * 等按后缀渲染。老协议(xdt-image/-video/-model)永久保留只读服务老地址,
 * 新写入一律出本协议的地址。
 *
 * 两步注册(与 imageProtocol 同模式,原因见 bootstrap-electron.ts 注释):
 *   1. cindyMediaSchemePrivilege —— 由 bootstrap 收集进唯一一次
 *      registerSchemesAsPrivileged(app.whenReady() 之前);
 *   2. registerCindyMediaProtocolHandler() —— app.whenReady() 之后接 handler。
 *
 * Range/206 分片:<video> 元素靠 Range 做分片
 * 加载与 seek,组装逻辑在 rangeResponse.ts(xdt-video 手动 206 同模式,
 * privilege 保持 stream:false);图片请求不带 Range 头,行为不变。
 */

import { protocol, type CustomScheme } from 'electron';

import * as blobStore from './blobStore';
import * as ledger from './ledger';
import { buildRangedFileResponse, buildRangedMediaResponse } from './rangeResponse';
import { createLogger } from '../logger';

const log = createLogger('cindyMediaProtocol');

const SCHEME = 'cindy-media';

/** 特权条目(bootstrap 单点注册;supportFetchAPI 供未来 model-viewer fetch)。 */
export const cindyMediaSchemePrivilege: CustomScheme = {
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    bypassCSP: false,
    stream: false,
    corsEnabled: false,
  },
};

export function registerCindyMediaProtocolHandler(): void {
  protocol.handle(SCHEME, async (request) => {
    try {
      if (blobStore.parseClientWallpaperUrl(request.url)?.ext === '.mp4') {
        return await buildRangedFileResponse({
          ...(await blobStore.openClientWallpaperVideo(request.url)),
          rangeHeader: request.headers.get('range'),
          cacheControl: 'public, max-age=31536000, immutable',
          signal: request.signal,
        });
      }
      const { buffer, mimeType } = blobStore.parseClientWallpaperUrl(request.url)
        ? await blobStore.readClientWallpaperFile(request.url)
        : await blobStore.readFile(request.url);
      // 惰性刷 lastAccess(cache LRU 依据);解析成功才有合法 hash。
      const parsed = blobStore.parseBlobUrl(request.url);
      if (parsed) void ledger.touchBlob(parsed.hash);
      // 内容寻址:同地址内容永不变化,可长缓存(immutable 免重复 IO)。
      return buildRangedMediaResponse({
        buffer,
        mimeType,
        rangeHeader: request.headers.get('range'),
        cacheControl: 'public, max-age=31536000, immutable',
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const msg = (err as Error)?.message ?? '';
      if (msg.includes('cindy-media:')) {
        return new Response(null, { status: 403 });
      }
      if (code === 'ENOENT') {
        return new Response(null, { status: 404 });
      }
      log.error('[cindy-media] handler error:', err);
      return new Response(null, { status: 500 });
    }
  });
}
