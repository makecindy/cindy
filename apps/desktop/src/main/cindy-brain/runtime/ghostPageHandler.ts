import fs from 'node:fs/promises';
import { GHOST_SCHEME, ghostPanelLoopbackEmbedAllowed, type InstalledGhost, type GhostAppContextResult, type GhostAgentModelsResult, type GhostMediaModelsResult, type GhostMediaModelType } from '../../../shared/ghost.js';
import type { PluginModelPickerResult } from '../../../shared/pluginModelPicker.js';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity.js';
import { GHOST_BOOT_PATH, GHOST_MAIL_SDK_PATH, ghostBootHtml, ghostFileMime, resolveGhostFilePath } from './ghostFiles.js';
import mailComposeRuntimeSource from './mailComposeRuntime.js?raw';
import { handleGhostKvRequest, readBoundedBodyText } from './ghostKvEndpoint.js';

export const GHOST_HTML_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' data: blob:";
const GHOST_LOOPBACK_FRAME_CSP = "frame-src 'self' http://127.0.0.1:* http://localhost:*";
export interface GhostKvProtocolStore {
  read(ghostId: string): Record<string, unknown>;
  write(ghostId: string, value: Record<string, unknown>): void;
  captureTarget(ghostId: string): unknown;
  isTargetCurrent(ghostId: string, expectedTarget: unknown): boolean;
}
export type GhostPageEndpoint = (args: {
  ghostId: string; method: string; pathname: string;
  readBodyText: () => Promise<string>; isCurrent: () => boolean;
  confirmConnection?: (label: string, host: string) => Promise<boolean>;
}) => Promise<{ status: number; body?: string }>;
export interface GhostPagePorts {
  ghost: InstalledGhost;
  /** Opaque, per-plugin origin assigned by the platform, never chosen by the page. */
  origin?: string;
  isCurrent: () => boolean;
  ghostKvStore: GhostKvProtocolStore | null;
  ghostWakeHandler: ((ghostId: string) => Promise<{ state: string }>) | null;
  ghostAppContextProvider: (() => GhostAppContextResult) | null;
  ghostModelPickerProvider: ((id: string, options: unknown, current: () => boolean, signal: AbortSignal) => Promise<PluginModelPickerResult>) | null;
  ghostAgentModelsProvider: ((id: string, device?: string) => Promise<GhostAgentModelsResult>) | null;
  ghostMediaModelsProvider: ((id: string, type: GhostMediaModelType) => Promise<GhostMediaModelsResult>) | null;
  ghostModelsHandler: GhostPageEndpoint | null;
  ghostSecretsHandler: GhostPageEndpoint | null;
  ghostOauthHandler: GhostPageEndpoint | null;
  ghostConnectionsHandler: GhostPageEndpoint | null;
  serveGhostMedia: (id: string, file: string, range: string | null) => Promise<Response>;
  serveGhostLibraryFile: (id: string, file: string, range: string | null) => Promise<Response>;
  serveGhostGallery: (id: string, origin: string) => Promise<Response>;
  log: { error(message: string, details?: Record<string, unknown>): void; warn(message: string, details?: Record<string, unknown>): void };
}

/** Shared page endpoints; Electron and the headless browser differ only in
 * transport. All providers retain the same receipt/owner checks and limits. */
export function createGhostPageHandler(ports: GhostPagePorts) {
  const { ghost, isCurrent: isRegistrationCurrent, log } = ports;
  const origin = ports.origin ?? `${GHOST_SCHEME}://${ghost.manifest.id}`;
  const binding = { dir: ghost.dir, entry: ghost.manifest.entry, storagePart: installedGhostStoragePart(ghost) };
  const htmlCsp = ghostPanelLoopbackEmbedAllowed(ghost.manifest) ? `${GHOST_HTML_CSP}; ${GHOST_LOOPBACK_FRAME_CSP}` : GHOST_HTML_CSP;
  const handleRequest = async (request: Request): Promise<Response> => {
    try {
      // owner B 提交后，owner A 的旧 guest 仍可能短暂存活并新发请求。
      // 在 URL 路由、body 读取和任何 provider 调用前拒绝旧 Session。
      if (!isRegistrationCurrent()) {
        return new Response(null, {
          status: 403,
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      const storagePart = binding.storagePart;
      const url = new URL(request.url);
      // 分区专属通道只认自己的 id,其它 host 一律 403(结构隔离的最后一道断言)。
      if (`${url.protocol}//${url.host}` !== origin) return new Response(null, { status: 403 });
      // ── 意识面板供图接待员─────────────────────────────────────────
      // /media/<指纹>.<ext>:面板取自家产物。指纹只当查账钥匙(不拼路径),
      // 账本验归属(出生自本意识或挂本意识画廊),通过才从字节仓读——
      // 查无此账与不属于你统一 404,不给沙箱探测面。
      if (url.pathname.startsWith('/media/')) {
        return ports.serveGhostMedia(storagePart, url.pathname.slice('/media/'.length), request.headers.get('range'));
      }
      // /library/<相对路径>:面板只读投影本意识的持久作品库文件(图片/视频/
      // 导出物)。解析器由 cindy-brain/index 注入(binding 根 + vault 路径纪律,
      // 与电子脑 read 同源校验);内容可变,Cache-Control 走 no-cache(与
      // 内容寻址的 /media 长缓存不同)。失败统一折叠 404。
      if (url.pathname.startsWith('/library/')) {
        return ports.serveGhostLibraryFile(storagePart, decodeURIComponent(url.pathname.slice('/library/'.length)), request.headers.get('range'));
      }
      // /gallery:本意识画廊清单(重启回放)。分区专属通道天然只答自己的账;
      // 内容只有指纹地址与备注字符串,零文件字节。
      if (url.pathname === '/gallery') {
        return ports.serveGhostGallery(storagePart, origin);
      }
      // /wake:面板叫醒自己的电子脑(§4"确实有活才开门"的面板侧入口)。
      // spawn 幂等(已在跑立即返回);沉睡/熔断由注入的 handler 拒绝。
      // 分区专属通道天然只能叫醒自己,不构成跨意识或驱动主机的能力面;
      // 只回状态字符串,不回任何细节。
      if (url.pathname === '/wake') {
        if (!ports.ghostWakeHandler) return new Response(null, { status: 503 });
        const wake = await ports.ghostWakeHandler(storagePart);
        return new Response(JSON.stringify(wake), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' },
        });
      }
      // /app-context:设置页/面板读取宿主公开构建上下文。只读、零用户数据,
      // 与电子脑 cindy.request({kind:'app-context'}) 同返回契约。
      if (url.pathname === '/app-context') {
        if (request.method !== 'GET') return new Response(null, { status: 405 });
        if (!ports.ghostAppContextProvider) return new Response(null, { status: 503 });
        return new Response(JSON.stringify(ports.ghostAppContextProvider()), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
        });
      }
      if (url.pathname === '/model-picker') {
        const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
        if (request.method !== 'POST') return new Response(null, { status: 405, headers });
        if (url.search) return new Response(null, { status: 400, headers });
        if (!ports.ghostModelPickerProvider) return new Response(null, { status: 503, headers });
        let options: unknown;
        try {
          const body = await readBoundedBodyText(request);
          if (body.length > 4096) return new Response(null, { status: 400, headers });
          options = JSON.parse(body || '{}');
        } catch { return new Response(null, { status: 400, headers }); }
        // Page authors cannot choose a different phone or impersonate a logic request.
        if (!options || typeof options !== 'object' || Array.isArray(options) ||
            Object.keys(options).some(key => !['initial', 'allowRemote'].includes(key))) return new Response(null, { status: 400, headers });
        const result = await ports.ghostModelPickerProvider(storagePart, options, isRegistrationCurrent, request.signal);
        if (!isRegistrationCurrent()) return new Response(null, { status: 403, headers });
        return new Response(JSON.stringify(result), { status: 200, headers });
      }
      if (url.pathname === '/agent-models') {
        const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
        if (request.method !== 'GET') return new Response(null, { status: 405, headers });
        const keys = [...url.searchParams.keys()];
        const ids = url.searchParams.getAll('agent_device_id');
        let agentDeviceId: string | undefined;
        if (keys.length > 0) {
          if (keys.length !== 1 || keys[0] !== 'agent_device_id' || ids.length !== 1) {
            return new Response(null, { status: 400, headers });
          }
          const id = ids[0];
          if (!id || id.length > 128) return new Response(null, { status: 400, headers });
          agentDeviceId = id;
        }
        if (!ports.ghostAgentModelsProvider) return new Response(null, { status: 503, headers });
        try {
          const result = agentDeviceId === undefined
            ? await ports.ghostAgentModelsProvider(storagePart)
            : await ports.ghostAgentModelsProvider(storagePart, agentDeviceId);
          if (!isRegistrationCurrent()) return new Response(null, { status: 403, headers });
          return new Response(JSON.stringify(result), {
            status: result.ok ? 200 : result.errorCode === 'PERMISSION_DENIED' ? 403 : 503,
            headers,
          });
        } catch {
          if (!isRegistrationCurrent()) return new Response(null, { status: 403, headers });
          return new Response(
            JSON.stringify({ ok: false, errorCode: 'NOT_AVAILABLE', message: 'Model catalog unavailable' }),
            { status: 503, headers },
          );
        }
      }
      // /media-models?type=image|video:插件自己的设置页 / 面板读取当前客户端可执行
      // 模型及 Gateway modalities。兼容判定由 Host provider 完成；端点仍不发起生成，
      // 也不返回凭证、endpoint、Guide 或内部判定细节。
      if (url.pathname === '/media-models') {
        if (request.method !== 'GET') return new Response(null, { status: 405 });
        const keys = [...url.searchParams.keys()];
        const types = url.searchParams.getAll('type');
        if (keys.length !== 1 || keys[0] !== 'type' || types.length !== 1) {
          return new Response(null, { status: 400 });
        }
        const type = types[0];
        if (type !== 'image' && type !== 'video') {
          return new Response(null, { status: 400 });
        }
        if (!ports.ghostMediaModelsProvider) return new Response(null, { status: 503 });
        const result = await ports.ghostMediaModelsProvider(storagePart, type);
        return new Response(JSON.stringify(result), {
          status: result.ok ? 200 : result.errorCode === 'PERMISSION_DENIED' ? 403 : 503,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        });
      }
      // /kv:意识自定义参数存取(FORGE_GUIDE §4.8)。设置页/面板/电子脑
      // 同源共用;分区专属通道天然只碰自己的账。分派与校验在纯函数层
      // (ghostKvEndpoint,已单测),这里只做 Response 包装。
      if (url.pathname === '/kv') {
        if (!ports.ghostKvStore) return new Response(null, { status: 503 });
        const store = ports.ghostKvStore;
        const out = await handleGhostKvRequest({
          method: request.method,
          // 有界读取(readBoundedBodyText):content-length 预检 + 流式限额,
          // 不受信 body 永不全量进主进程内存——沙箱允许死,主机不能被 OOM。
          readBodyText: () => readBoundedBodyText(request),
          store,
          ghostId: storagePart,
          isCurrent: isRegistrationCurrent,
          log,
        });
        return new Response(out.body ?? null, {
          status: out.status,
          headers: {
            ...(out.body !== undefined
              ? { 'Content-Type': 'application/json; charset=utf-8' }
              : {}),
            'Cache-Control': 'no-cache',
          },
        });
      }
      if (url.pathname === '/models') {
        if (!ports.ghostModelsHandler) return new Response(null, { status: 503 });
        const out = await ports.ghostModelsHandler({
          ghostId: storagePart,
          method: request.method,
          pathname: url.pathname,
          readBodyText: () => readBoundedBodyText(request),
          isCurrent: isRegistrationCurrent,
        });
        return new Response(out.body ?? null, {
          status: out.status,
          headers: {
            ...(out.body !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
            'Cache-Control': 'no-cache',
          },
        });
      }
      // /secrets:input:'ghost' 凭证的只写入库通道(FORGE_GUIDE §4.7)。
      // 明文单向进保险库,无任何读回动作;分区专属通道天然只碰自己的账。
      if (url.pathname === '/secrets' || url.pathname.startsWith('/secrets/')) {
        if (!ports.ghostSecretsHandler) return new Response(null, { status: 503 });
        const out = await ports.ghostSecretsHandler({
          ghostId: storagePart,
          method: request.method,
          pathname: url.pathname,
          readBodyText: () => readBoundedBodyText(request),
          isCurrent: isRegistrationCurrent,
        });
        return new Response(out.body ?? null, {
          status: out.status,
          headers: {
            ...(out.body !== undefined
              ? { 'Content-Type': 'application/json; charset=utf-8' }
              : {}),
            'Cache-Control': 'no-cache',
          },
        });
      }
      // /oauth:source:'oauth' 凭证的设置页通道(FORGE_GUIDE §4.7)。client
      // 凭证只写入库,连接/断开/默认账号由主机代办;授权令牌无任何读回
      // 动作;分区专属通道天然只碰自己的账。
      if (url.pathname === '/oauth' || url.pathname.startsWith('/oauth/')) {
        if (!ports.ghostOauthHandler) return new Response(null, { status: 503 });
        const out = await ports.ghostOauthHandler({
          ghostId: storagePart,
          method: request.method,
          pathname: url.pathname,
          readBodyText: () => readBoundedBodyText(request),
          isCurrent: isRegistrationCurrent,
        });
        return new Response(out.body ?? null, {
          status: out.status,
          headers: {
            ...(out.body !== undefined
              ? { 'Content-Type': 'application/json; charset=utf-8' }
              : {}),
            'Cache-Control': 'no-cache',
          },
        });
      }
      // /connections:network.connections 多连接的设置页通道(FORGE_GUIDE
      // §4.7)。地址与 token 只写入库(新地址过主机受信确认),GET 只回状态
      // 与尾 4 位指纹;分区专属通道天然只碰自己的账。
      if (url.pathname === '/connections' || url.pathname.startsWith('/connections/')) {
        if (!ports.ghostConnectionsHandler) return new Response(null, { status: 503 });
        const out = await ports.ghostConnectionsHandler({
          ghostId: storagePart,
          method: request.method,
          pathname: url.pathname,
          readBodyText: () => readBoundedBodyText(request),
          isCurrent: isRegistrationCurrent,
        });
        return new Response(out.body ?? null, {
          status: out.status,
          headers: {
            ...(out.body !== undefined
              ? { 'Content-Type': 'application/json; charset=utf-8' }
              : {}),
            'Cache-Control': 'no-cache',
          },
        });
      }
      if (url.pathname === GHOST_MAIL_SDK_PATH) {
        return new Response(mailComposeRuntimeSource, { status: 200, headers: {
          'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache',
        } });
      }
      if (url.pathname === GHOST_BOOT_PATH || url.pathname === '/') {
        const entry = binding.entry;
        if (!entry) return new Response(null, { status: 404 });
        return new Response(ghostBootHtml(entry), {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': htmlCsp,
            'Cache-Control': 'no-cache',
          },
        });
      }
      const installDir = binding.dir;
      if (!installDir) return new Response(null, { status: 404 });
      const filePath = resolveGhostFilePath(installDir, url.pathname);
      if (!filePath) return new Response(null, { status: 403 });
      const data = await fs.readFile(filePath);
      const mime = ghostFileMime(filePath);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'Content-Type': mime,
          ...(mime.startsWith('text/html') ? { 'Content-Security-Policy': htmlCsp } : {}),
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'EISDIR') return new Response(null, { status: 404 });
      log.error('cindy-ghost protocol error', { error: err instanceof Error ? err.message : String(err) });
      return new Response(null, { status: 500 });
    }
  };
  return async (request: Request): Promise<Response> => {
    const response = await handleRequest(request);
    if (isRegistrationCurrent()) return response;
    await response.body?.cancel().catch(() => undefined);
    return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  };
}
