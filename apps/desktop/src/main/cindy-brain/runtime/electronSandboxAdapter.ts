import { BrowserWindow, session, webContents, type CustomScheme } from 'electron';
import fs from 'node:fs/promises';
import * as nodeFs from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from '../../logger.js';
import {
  GHOST_SCHEME,
  type GhostAppContextResult,
  type GhostMediaModelsResult,
  type GhostMediaModelType,
  type InstalledGhost,
} from '../../../shared/ghost.js';
import { getActiveAppSession, type ActiveAppSession } from '../../appSessionState.js';
import { ownerScopedGhostPartition } from '../ghostWebviewPartition.js';
import { GHOST_BOOT_PATH, ghostBootHtml, ghostFileMime, resolveGhostFilePath } from './ghostFiles.js';
import { handleGhostKvRequest, readBoundedBodyText } from './ghostKvEndpoint.js';
import { resolveHashRef as resolveBlobHashRef } from '../../cindy-media/blobStore.js';
import { buildRangedMediaResponse } from '../../cindy-media/rangeResponse.js';
import {
  ghostCanRead as ghostCanReadMedia,
  listGhostGallery as listGhostGalleryFromLedger,
} from '../../cindy-media/ledger.js';
import type { SandboxHandle, SandboxHostAdapter } from './GhostRuntime.js';

/**
 * Electron 沙箱宿主(docs/dev-rules/plugin-security-and-authoring.md):
 * 每段干活中的芯片型意识 = 一个隐藏 BrowserWindow——
 *   sandbox: true(Chromium 系统级沙箱)+ nodeIntegration: false +
 *   contextIsolation: true + 独立内存 session 分区(不落盘、互不可见)。
 *
 * 文件供片走自定义协议 `cindy-ghost://<id>/<相对路径>`:
 *   - handler 注册在**该意识专属的 session 分区**上,且只认自己的 id 为
 *     host——A 意识的分区里根本不存在解析 B 意识文件的通道(结构隔离);
 *   - 路径守卫 / MIME / 启动文档在 ghostFiles.ts(纯函数,已单测);
 *   - `/__boot__` 返回合成启动文档(空白页 + <script src=entry>)。
 *
 * 孤儿进程说明:沙箱是 Chromium 渲染子进程,主进程死亡时由 Chromium
 * 层级联回收,天然无孤儿;"孩子盯父亲 / 开机扫尸体"是给未来独立可执行
 * 进程预留的纪律,方案 A 下由平台白送。
 */

const log = createLogger('brain-runtime');

const SCHEME = GHOST_SCHEME;

/** 汇入 bootstrap 一次性 registerSchemesAsPrivileged 的特权声明。 */
export const cindyGhostSchemePrivilege: CustomScheme = {
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

/**
 * 曾经/现在属于意识沙箱的 webContents id。lifecycle 的全局
 * render-process-gone 守卫据此豁免——沙箱允许死(运行时自己收尸),
 * 不触发"渲染进程死了 = 整个应用关机"的老逻辑。
 * 只增不删:webContents id 在一次 app 运行内全局自增、永不复用,留档
 * 保证 app 级 gone 事件比运行时收尸晚到时依然能识别;每次 spawn 只
 * 增一个数字,量级可忽略。
 */
const ghostWebContentsIds = new Set<number>();

export function isGhostSandboxWebContentsId(id: number): boolean {
  return ghostWebContentsIds.has(id);
}

/** 面板 webview 路径:把 guest webContents 登记为意识沙箱(崩溃豁免)。 */
export function registerGhostWebContents(id: number): void {
  ghostWebContentsIds.add(id);
}

/**
 * 电子脑逻辑页 webContents id → 意识 id 的绑定表(管子验身)。
 * ghost-pipe:* handler 按 event.sender.id 反查意识身份——意识无法自报家门
 * 冒充别人(结构隔离)。只有装了 ghostPreload 的离屏逻辑页在表内;面板
 * webview 不在(它零桥)。
 */
const logicWebContentsToGhost = new Map<number, string>();

export function ghostIdForLogicWebContents(webContentsId: number): string | null {
  return logicWebContentsToGhost.get(webContentsId) ?? null;
}

/**
 * 下行投递:把管子消息发到某意识的电子脑逻辑页('ghost-pipe:message')。
 * false = 逻辑页不在线(未拉起/刚死),由派发器折叠成结构化失败。
 * 绑定表极小(每意识一条),线性反查即可。
 */
export function sendToGhostLogic(ghostId: string, payload: unknown): boolean {
  for (const [wcId, gid] of logicWebContentsToGhost) {
    if (gid !== ghostId) continue;
    const wc = webContents.fromId(wcId);
    if (wc && !wc.isDestroyed()) {
      wc.send('ghost-pipe:message', payload);
      return true;
    }
  }
  return false;
}

// 管子桥 preload 的产物路径(与 main bundle 同目录,forge VitePlugin 出的
// .vite/build/ghostPreload.js;__dirname 在 dev/prod 都指向 .vite/build)。
const GHOST_PRELOAD_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'ghostPreload.js',
);

/**
 * 面板唤醒电子脑的回调(index.ts 注入,避免 adapter 反向依赖 runtime 单例)。
 * "确实有活才开门":电子脑按需拉起,面板菜单等自发
 * 交互是合法的"有活"——面板零桥,唤醒只能走它自己的协议通道(/wake)。
 */
let ghostWakeHandler: ((ghostId: string) => Promise<{ state: string }>) | null = null;

export function setGhostWakeHandler(
  handler: (ghostId: string) => Promise<{ state: string }>,
): void {
  ghostWakeHandler = handler;
}

/**
 * 宿主公开上下文提供器(index.ts 注入)。电子脑走 cindy.request,设置页/面板
 * 没有 preload 桥,走同源只读 `/app-context`;两路必须返回同一份构建身份。
 */
let ghostAppContextProvider: (() => GhostAppContextResult) | null = null;

export function setGhostAppContextProvider(provider: () => GhostAppContextResult): void {
  ghostAppContextProvider = provider;
}

/**
 * 插件配置页的只读媒体模型目录提供器。面板没有 preload 桥，因此与
 * `/app-context` 一样走自己的同源协议端点；实际目录与授权判定由 Host 注入。
 */
let ghostMediaModelsProvider:
  | ((ghostId: string, type: GhostMediaModelType) => Promise<GhostMediaModelsResult>)
  | null = null;

export function setGhostMediaModelsProvider(
  provider: (ghostId: string, type: GhostMediaModelType) => Promise<GhostMediaModelsResult>,
): void {
  ghostMediaModelsProvider = provider;
}

/**
 * 意识自定义参数 KV 存储(index.ts 注入,同 ghostWakeHandler 模式避免
 * adapter 反向依赖)。注入的是带"在装态守卫"的包装层——卸下后分区里
 * 残留的 fetch 不能复活写出新文件。
 */
let ghostKvStore: {
  read(ghostId: string): Record<string, unknown>;
  write(ghostId: string, value: Record<string, unknown>): void;
} | null = null;

export function setGhostKvStore(store: {
  read(ghostId: string): Record<string, unknown>;
  write(ghostId: string, value: Record<string, unknown>): void;
}): void {
  ghostKvStore = store;
}

/**
 * /secrets 只写通道 handler(index.ts 注入:闭包里带当前在装清单查询与
 * 保险库,adapter 不反向依赖)。分派与校验在 ghostSecretsEndpoint 纯函数层。
 */
type GhostSecretsProtocolHandler = (args: {
  ghostId: string;
  method: string;
  pathname: string;
  readBodyText: () => Promise<string>;
}) => Promise<{ status: number; body?: string }>;

let ghostSecretsHandler: GhostSecretsProtocolHandler | null = null;

export function setGhostSecretsHandler(handler: GhostSecretsProtocolHandler): void {
  ghostSecretsHandler = handler;
}

/**
 * /oauth 通道 handler(index.ts 注入,同 /secrets 模式):source:'oauth'
 * 凭证的设置页通道——client 凭证只写入库、连接/断开/默认账号。分派与
 * 校验在 ghostOauthEndpoint 纯函数层。
 */
type GhostOauthProtocolHandler = (args: {
  ghostId: string;
  method: string;
  pathname: string;
  readBodyText: () => Promise<string>;
}) => Promise<{ status: number; body?: string }>;

let ghostOauthHandler: GhostOauthProtocolHandler | null = null;

export function setGhostOauthHandler(handler: GhostOauthProtocolHandler): void {
  ghostOauthHandler = handler;
}

/**
 * /connections 通道 handler(index.ts 注入,同 /secrets 模式):
 * network.connections 多连接的设置页通道——地址 + token 成对入库(新地址
 * 过主机受信确认弹窗)、回查状态、删除、设默认。分派与校验在
 * ghostConnectionsEndpoint 纯函数层。
 */
type GhostConnectionsProtocolHandler = (args: {
  ghostId: string;
  method: string;
  pathname: string;
  readBodyText: () => Promise<string>;
}) => Promise<{ status: number; body?: string }>;

let ghostConnectionsHandler: GhostConnectionsProtocolHandler | null = null;

export function setGhostConnectionsHandler(handler: GhostConnectionsProtocolHandler): void {
  ghostConnectionsHandler = handler;
}

/** 该分区是否已挂过协议 handler(session 分区随 app 生命周期,挂一次即可)。 */
const partitionRegistered = new Set<string>();
const partitionGhost = new Map<string, { dir: string; entry: string }>();
type GhostProtocolOwnerIdentity = Pick<ActiveAppSession, 'mode' | 'dataOwnerId'>;
const partitionOwner = new Map<string, GhostProtocolOwnerIdentity>();

function ghostProtocolOwnerSnapshot(owner: ActiveAppSession): GhostProtocolOwnerIdentity {
  return { mode: owner.mode, dataOwnerId: owner.dataOwnerId };
}

function isSameGhostProtocolOwner(
  left: GhostProtocolOwnerIdentity,
  right: GhostProtocolOwnerIdentity,
): boolean {
  return left.mode === right.mode && left.dataOwnerId === right.dataOwnerId;
}

function isGhostProtocolOwnerActive(owner: GhostProtocolOwnerIdentity): boolean {
  return isSameGhostProtocolOwner(owner, getActiveAppSession());
}

/**
 * 确保某意识分区上的 cindy-ghost:// 协议 handler 就位(幂等)。
 * 两个调用方:离屏沙箱窗口(create)与面板 webview 附加闸(webview-security
 * 放行前调用——handler 必须先于 webview 首次加载挂好)。
 */
export function ensureGhostProtocolRegistered(
  ghost: InstalledGhost,
  owner: ActiveAppSession = getActiveAppSession(),
): void {
  const partition = ownerScopedGhostPartition(ghost.manifest.id, owner);
  if (!partition) throw new Error('ghost protocol requires an active data owner');
  registerGhostProtocol(partition, ghost, ghostProtocolOwnerSnapshot(owner));
}

/**
 * 意识页面(html 响应)统一佩戴的 CSP:脚本/样式/资源只许同源(= 自己的
 * 安装目录),img/media 额外放行 data:/blob:(生成图等内存产物使用)。
 * 与分区级断网(onBeforeRequest)构成双保险。
 */
const GHOST_HTML_CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:";

function registerGhostProtocol(
  partition: string,
  ghost: InstalledGhost,
  owner: GhostProtocolOwnerIdentity,
): void {
  const registeredOwner = partitionOwner.get(partition);
  if (registeredOwner && !isSameGhostProtocolOwner(registeredOwner, owner)) {
    throw new Error('ghost protocol partition already belongs to a different data owner');
  }
  partitionGhost.set(partition, {
    dir: ghost.dir,
    entry: ghost.manifest.entry,
  });
  if (partitionRegistered.has(partition)) return;
  // 注意:登记发生在全部挂载成功之后(函数末尾)——session.fromPartition 在
  // app ready 前会 throw,若先登记后挂载,失败分区会被永久标记"已注册"而
  // 实际无 handler,面板与电子脑一起哑火(review P0 的中毒模式)。
  const ses = session.fromPartition(partition);
  const ghostId = ghost.manifest.id;
  // 每个 owner 都会得到新的内存 session；权限与下载必须显式拒绝，不能
  // 因为分区是新建的就依赖 Electron 默认行为。
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
  // 分区级断网(docs/dev-rules/plugin-security-and-authoring.md 的"网络永远不直连"):本分区发出的一切
  // 请求,只放行自己协议同 id 下的资源;http(s) / ws / 其它协议一律掐断。
  // 进程沙箱不管网络,这里才是"零网络"承诺的真正闸门;外部数据未来走
  // 主机代发(管子服务),不走这里。devtools 前端跑在自己的进程,不受影响。
  const selfPrefix = `${SCHEME}://${ghostId}/`;
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(selfPrefix) });
  });
  ses.protocol.handle(SCHEME, async (request) => {
    try {
      // owner B 提交后，owner A 的旧 guest 仍可能短暂存活并新发请求。
      // 在 URL 路由、body 读取和任何 provider 调用前拒绝旧 Session；已经
      // 进入 handler 的请求不在这里取消或排空。
      if (!isGhostProtocolOwnerActive(owner)) {
        return new Response(null, {
          status: 403,
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      const url = new URL(request.url);
      // 分区专属通道只认自己的 id,其它 host 一律 403(结构隔离的最后一道断言)。
      if (url.host !== ghostId) return new Response(null, { status: 403 });
      // ── 意识面板供图接待员─────────────────────────────────────────
      // /media/<指纹>.<ext>:面板取自家产物。指纹只当查账钥匙(不拼路径),
      // 账本验归属(出生自本意识或挂本意识画廊),通过才从字节仓读——
      // 查无此账与不属于你统一 404,不给沙箱探测面。
      if (url.pathname.startsWith('/media/')) {
        return serveGhostMedia(ghostId, url.pathname.slice('/media/'.length), request.headers.get('range'));
      }
      // /library/<相对路径>:面板只读投影本意识的持久作品库文件(图片/视频/
      // 导出物)。解析器由 cindy-brain/index 注入(binding 根 + vault 路径纪律,
      // 与电子脑 read 同源校验);内容可变,Cache-Control 走 no-cache(与
      // 内容寻址的 /media 长缓存不同)。失败统一折叠 404。
      if (url.pathname.startsWith('/library/')) {
        return serveGhostLibraryFile(ghostId, decodeURIComponent(url.pathname.slice('/library/'.length)), request.headers.get('range'));
      }
      // /gallery:本意识画廊清单(重启回放)。分区专属通道天然只答自己的账;
      // 内容只有指纹地址与备注字符串,零文件字节。
      if (url.pathname === '/gallery') {
        return serveGhostGallery(ghostId);
      }
      // /wake:面板叫醒自己的电子脑(§4"确实有活才开门"的面板侧入口)。
      // spawn 幂等(已在跑立即返回);沉睡/熔断由注入的 handler 拒绝。
      // 分区专属通道天然只能叫醒自己,不构成跨意识或驱动主机的能力面;
      // 只回状态字符串,不回任何细节。
      if (url.pathname === '/wake') {
        if (!ghostWakeHandler) return new Response(null, { status: 503 });
        const wake = await ghostWakeHandler(ghostId);
        return new Response(JSON.stringify(wake), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' },
        });
      }
      // /app-context:设置页/面板读取宿主公开构建上下文。只读、零用户数据,
      // 与电子脑 cindy.request({kind:'app-context'}) 同返回契约。
      if (url.pathname === '/app-context') {
        if (request.method !== 'GET') return new Response(null, { status: 405 });
        if (!ghostAppContextProvider) return new Response(null, { status: 503 });
        return new Response(JSON.stringify(ghostAppContextProvider()), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
        });
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
        if (!ghostMediaModelsProvider) return new Response(null, { status: 503 });
        const result = await ghostMediaModelsProvider(ghostId, type);
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
        if (!ghostKvStore) return new Response(null, { status: 503 });
        const out = await handleGhostKvRequest({
          method: request.method,
          // 有界读取(readBoundedBodyText):content-length 预检 + 流式限额,
          // 不受信 body 永不全量进主进程内存——沙箱允许死,主机不能被 OOM。
          readBodyText: () => readBoundedBodyText(request),
          store: ghostKvStore,
          ghostId,
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
      // /secrets:input:'ghost' 凭证的只写入库通道(FORGE_GUIDE §4.7)。
      // 明文单向进保险库,无任何读回动作;分区专属通道天然只碰自己的账。
      if (url.pathname === '/secrets' || url.pathname.startsWith('/secrets/')) {
        if (!ghostSecretsHandler) return new Response(null, { status: 503 });
        const out = await ghostSecretsHandler({
          ghostId,
          method: request.method,
          pathname: url.pathname,
          readBodyText: () => readBoundedBodyText(request),
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
        if (!ghostOauthHandler) return new Response(null, { status: 503 });
        const out = await ghostOauthHandler({
          ghostId,
          method: request.method,
          pathname: url.pathname,
          readBodyText: () => readBoundedBodyText(request),
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
        if (!ghostConnectionsHandler) return new Response(null, { status: 503 });
        const out = await ghostConnectionsHandler({
          ghostId,
          method: request.method,
          pathname: url.pathname,
          readBodyText: () => readBoundedBodyText(request),
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
      if (url.pathname === GHOST_BOOT_PATH || url.pathname === '/') {
        const entry = partitionGhost.get(partition)?.entry;
        if (!entry) return new Response(null, { status: 404 });
        return new Response(ghostBootHtml(entry), {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': GHOST_HTML_CSP,
            'Cache-Control': 'no-cache',
          },
        });
      }
      const installDir = partitionGhost.get(partition)?.dir;
      if (!installDir) return new Response(null, { status: 404 });
      const filePath = resolveGhostFilePath(installDir, url.pathname);
      if (!filePath) return new Response(null, { status: 403 });
      const data = await fs.readFile(filePath);
      const mime = ghostFileMime(filePath);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'Content-Type': mime,
          ...(mime.startsWith('text/html') ? { 'Content-Security-Policy': GHOST_HTML_CSP } : {}),
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'EISDIR') return new Response(null, { status: 404 });
      log.error('cindy-ghost protocol error', { error: err instanceof Error ? err.message : String(err) });
      return new Response(null, { status: 500 });
    }
  });
  partitionOwner.set(partition, owner);
  partitionRegistered.add(partition); // 全部挂载成功,才算注册完成
}

/**
 * 供图接待员主体:`<指纹>.<ext>` → 账本归属校验 → 字节仓读文件。
 * 全部失败路径折叠成 404(不区分"不存在/格式错/不属于你",无探测面);
 * 只有真 IO 错误回 500。
 */
async function serveGhostMedia(
  ghostId: string,
  fileRef: string,
  rangeHeader: string | null,
): Promise<Response> {
  const dotIdx = fileRef.lastIndexOf('.');
  if (dotIdx <= 0) return new Response(null, { status: 404 });
  const hash = fileRef.slice(0, dotIdx);
  const ext = fileRef.slice(dotIdx).toLowerCase();
  let resolved: { absPath: string; mimeType: string };
  try {
    resolved = resolveBlobHashRef(hash, ext);
  } catch {
    return new Response(null, { status: 404 });
  }
  if (!(await ghostCanReadMedia(hash, ghostId))) return new Response(null, { status: 404 });
  try {
    const data = await fs.readFile(resolved.absPath);
    // Range/206:面板 <video> 靠分片与 seek;图片无 Range 头走 200 不变。
    // 内容寻址:同地址内容永不变,面板画廊可长缓存。
    return buildRangedMediaResponse({
      buffer: data,
      mimeType: resolved.mimeType,
      rangeHeader,
      cacheControl: 'public, max-age=31536000, immutable',
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'EISDIR') return new Response(null, { status: 404 });
    log.error('ghost media serve error', { error: err instanceof Error ? err.message : String(err) });
    return new Response(null, { status: 500 });
  }
}

/**
 * library 文件供给器(由 cindy-brain/index 注入,防 runtime ↔ index 循环依赖):
 * ghostId + 相对路径 → 已校验文件的绝对路径;null = 折叠 404。注入前 /library/
 * 路由一律 404(fail closed,不假装空库)。
 */
export type GhostLibraryFileResolver = (ghostId: string, relPath: string) => Promise<string | null>;
let ghostLibraryFileResolver: GhostLibraryFileResolver | null = null;
export function setGhostLibraryFileResolver(resolver: GhostLibraryFileResolver | null): void {
  ghostLibraryFileResolver = resolver;
}

/**
 * library 只读投影:注入解析器校验路径与归属后**流式**回字节。Range 用
 * createReadStream(多 GB 视频不整文件读进内存,review:面板路由整文件
 * 物化);仅支持单段 bytes=a-b / bytes=a-(多段与非法头按不支持处理,回
 * 200 全量或 416)。与 /media 不同:library 文件内容可变,不缓存。
 */
async function serveGhostLibraryFile(ghostId: string, relPath: string, rangeHeader: string | null): Promise<Response> {
  if (!ghostLibraryFileResolver) return new Response(null, { status: 404 });
  const absPath = await ghostLibraryFileResolver(ghostId, relPath);
  if (!absPath) return new Response(null, { status: 404 });
  const mimeType = mediaTypeForLibraryPath(relPath);
  const headers: Record<string, string> = {
    'Content-Type': mimeType,
    'Cache-Control': 'no-cache',
    'Accept-Ranges': 'bytes',
  };
  try {
    const st = await fs.stat(absPath);
    if (!st.isFile()) return new Response(null, { status: 404 });
    const total = st.size;
    if (rangeHeader !== null && rangeHeader !== undefined && rangeHeader !== '') {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      // 非单段(多段/后缀拼接/非法)按不支持处理:满足 prefix 的回 416,
      // 完全非法的忽略 Range 回 200(浏览器对 416 会自行回退重拉)。
      if (match && (match[1] !== '' || match[2] !== '')) {
        let start = match[1] === '' ? 0 : Number(match[1]);
        let end = match[2] === '' ? total - 1 : Number(match[2]);
        if (match[1] === '' && match[2] !== '') {
          // suffix 形式:最后 N 字节
          start = Math.max(0, total - Number(match[2]));
          end = total - 1;
        }
        if (start > end || end >= total) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
        }
        end = Math.min(end, total - 1);
        const stream = nodeFs.createReadStream(absPath, { start, end });
        return new Response(Readable.toWeb(stream) as ReadableStream, {
          status: 206,
          headers: {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': String(end - start + 1),
          },
        });
      }
    }
    const stream = nodeFs.createReadStream(absPath);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: { ...headers, 'Content-Length': String(total) },
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'EISDIR') return new Response(null, { status: 404 });
    log.error('ghost library serve error', { ghostId, error: err instanceof Error ? err.message : String(err) });
    return new Response(null, { status: 500 });
  }
}

/** library 投影的 MIME 按扩展名粗判(面板展示用;嗅探不做,宿主只供已存文件)。 */
function mediaTypeForLibraryPath(relPath: string): string {
  const ext = relPath.slice(relPath.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mov': return 'video/quicktime';
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.ogg': return 'audio/ogg';
    case '.m4a': return 'audio/mp4';
    case '.pdf': return 'application/pdf';
    case '.json': return 'application/json; charset=utf-8';
    case '.txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

/** 画廊清单响应:[{src, caption}](新的在前;账本不可用时回空数组不报错)。 */
async function serveGhostGallery(ghostId: string): Promise<Response> {
  let items: Awaited<ReturnType<typeof listGhostGalleryFromLedger>> = [];
  try {
    items = await listGhostGalleryFromLedger(ghostId);
  } catch (err) {
    // 账本未就绪(登录早期等):回空墙,面板照常渲染空态,不给沙箱报错面。
    log.warn('ghost gallery list unavailable', { ghostId, error: err instanceof Error ? err.message : String(err) });
  }
  const payload = items.map((it) => ({
    src: `${SCHEME}://${ghostId}/media/${it.hash}${it.ext}`,
    caption: it.label ?? '',
  }));
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

class ElectronSandboxHandle implements SandboxHandle {
  private win: BrowserWindow | null;
  private goneCb: ((details: { reason: string }) => void) | null = null;
  private destroyed = false;

  constructor(private readonly ghost: InstalledGhost) {
    const activeOwner = getActiveAppSession();
    const partition = ownerScopedGhostPartition(ghost.manifest.id, activeOwner);
    if (!partition) throw new Error('ghost sandbox requires an active data owner');
    registerGhostProtocol(partition, ghost, ghostProtocolOwnerSnapshot(activeOwner));
    this.win = new BrowserWindow({
      show: false,
      // 逻辑页是恒隐藏的离屏工作台;可见面板由独立 webview 嵌入布局。
      width: 480,
      height: 320,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition,
        // 管子桥(脑机接口)只接在电子脑逻辑页上;面板 webview 零桥
        // (docs/dev-rules/plugin-security-and-authoring.md 的结构保证)。preload 在 sandbox
        // + contextIsolation 下只能经 contextBridge 暴露极小白名单面。
        preload: GHOST_PRELOAD_PATH,
        webSecurity: true,
        devTools: !ghostSandboxDevToolsDisabled,
      },
    });
    ghostWebContentsIds.add(this.win.webContents.id);
    logicWebContentsToGhost.set(this.win.webContents.id, ghost.manifest.id);
    this.win.webContents.on('render-process-gone', (_event, details) => {
      if (this.destroyed) return;
      // 延迟一拍再收尸:不在 Chromium 事件分发中途销毁窗口(重入风险)。
      setImmediate(() => {
        if (this.destroyed) return;
        this.goneCb?.({ reason: details.reason });
      });
    });
  }

  async load(): Promise<void> {
    if (!this.win) throw new Error('sandbox already destroyed');
    await this.win.loadURL(`${SCHEME}://${this.ghost.manifest.id}${GHOST_BOOT_PATH}`);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const win = this.win;
    this.win = null;
    if (win) {
      logicWebContentsToGhost.delete(win.webContents.id);
      if (!win.isDestroyed()) win.destroy();
    }
  }

  crashForTest(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.forcefullyCrashRenderer();
  }

  onGone(cb: (details: { reason: string }) => void): void {
    this.goneCb = cb;
  }
}

// packaged 版关掉沙箱页 devTools;dev 保留便于排查示例意识。
let ghostSandboxDevToolsDisabled = false;
export function setGhostSandboxDevToolsDisabled(disabled: boolean): void {
  ghostSandboxDevToolsDisabled = disabled;
}

export const electronSandboxAdapter: SandboxHostAdapter = {
  create(ghost: InstalledGhost): SandboxHandle {
    log.info('spawn ghost sandbox', { id: ghost.manifest.id });
    return new ElectronSandboxHandle(ghost);
  },
};
