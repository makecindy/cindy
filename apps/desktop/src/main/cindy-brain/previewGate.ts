/**
 * previewGate.ts — 意识面板「点图看大图」的主机闸口(产物 lightbox 预览)。
 *
 * 面板 webview 是零桥沙箱(docs/dev-rules/plugin-security-and-authoring.md),不给它开任何
 * JS API;预览走**声明式链接拦截**:面板作者把 <img> 包进
 * `<a href="cindy-ghost://<id>/preview/<指纹><后缀>">`,导航被主机的
 * will-navigate 闸(webview-security)拦下、翻译成"在主窗口弹 ImageLightbox"。
 *
 * 安全模型(与 /media/ 供图接待员同一纪律):
 * - 跨边界只有指纹字符串:指纹按 SHA-256 形状严格校验、只当查账钥匙,
 *   不参与任何路径拼接;lightbox 最终加载的 cindy-media:// 地址由主机拼装,
 *   面板给的字符串没有机会变成任意 URL(防注入是结构性的);
 * - 归属查账(ghostCanRead):只能预览自己名下 / 挂自己画廊的产物;
 * - 内容类型以账本 mime 为准(不信 URL 后缀):第一期只放行 image/*;
 * - 焦点闸 + 限速:面板必须正持有焦点(用户在跟它交互)才放行,同一意识
 *   两次预览至少间隔 MIN_INTERVAL——恶意 JS 循环 location.href 刷不起弹窗
 *   (lightbox 一开焦点即离开面板,后续自动触发全被焦点闸拒掉)。
 * - 全部失败路径静默(只记 debug 日志),不给沙箱任何可探测的差异面。
 *
 * 纯逻辑 + 依赖注入(规则 14):不 import Electron,单测直接喂假 deps。
 * 真实组装在 cindy-brain/index.ts(账本/字节仓/webContents)。
 */

import { GHOST_SCHEME } from '../../shared/ghost.js';

/** 面板导航到该路径前缀 = 预览请求(不是真页面,协议 handler 也不会服务它)。 */
export const GHOST_PREVIEW_PATH_PREFIX = '/preview/';

/** 同一意识两次预览的最小间隔(ms)。 */
export const GHOST_PREVIEW_MIN_INTERVAL_MS = 1000;

/** 指纹形状:SHA-256 十六进制,恰 64 位小写(与 blobStore.HASH_RE 同口径)。 */
const HASH_RE = /^[0-9a-f]{64}$/;

/** 图片后缀白名单(账本 mime 才是权威判定,这里是形状预筛)。 */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
/** 视频后缀白名单(视频产物入画廊后,预览闸随渲染链路就绪放行)。 */
const VIDEO_EXTS = new Set(['.mp4', '.webm']);
/** 预览放行的全部媒体后缀(图片 lightbox / 视频播放器各走各的,kind 随结果回传)。 */
const PREVIEW_MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS]);

/**
 * 意识面板一次 will-navigate 的分类:
 * - 'allow'    自己协议同 id 下的普通页面,放行(现状行为);
 * - 'preview'  预览链接,拦下导航并走预览闸;
 * - 'external' https 外部地址,拦下导航并走外链闸(GhostExternalLinkGate:
 *              身份卡声明地址/基座授信主机直开,其它合法地址二次确认);
 * - 'block'    其它一切(非 https 外部地址 / 别的意识 / 畸形 URL),拦下丢弃。
 */
export type GhostPanelNavigation = 'allow' | 'preview' | 'external' | 'block';

export function classifyGhostPanelNavigation(url: string, ghostId: string): GhostPanelNavigation {
  const selfPrefix = `${GHOST_SCHEME}://${ghostId}/`;
  if (!url.startsWith(selfPrefix)) {
    // 分类只认形状(https = 交给外链闸),白名单判定在闸内(身份卡声明比对)。
    return url.startsWith('https://') ? 'external' : 'block';
  }
  return url.slice(selfPrefix.length - 1).startsWith(GHOST_PREVIEW_PATH_PREFIX) ? 'preview' : 'allow';
}

/**
 * 解析预览链接 → 指纹 + 后缀;形状不合格(hash 非 64 位 hex、后缀不在
 * 媒体白名单、带 query/多级路径)一律 null。
 */
export function parseGhostPreviewUrl(url: string, ghostId: string): { hash: string; ext: string } | null {
  const prefix = `${GHOST_SCHEME}://${ghostId}${GHOST_PREVIEW_PATH_PREFIX}`;
  if (!url.startsWith(prefix)) return null;
  const fileRef = url.slice(prefix.length);
  if (fileRef.includes('/') || fileRef.includes('?') || fileRef.includes('#')) return null;
  const dotIdx = fileRef.lastIndexOf('.');
  if (dotIdx <= 0) return null;
  const hash = fileRef.slice(0, dotIdx);
  const ext = fileRef.slice(dotIdx).toLowerCase();
  if (!HASH_RE.test(hash)) return null;
  if (!PREVIEW_MEDIA_EXTS.has(ext)) return null;
  return { hash, ext };
}

/** /media/ 与 /preview/ 两种形状的通用解析(后缀白名单由调用方按通道给)。 */
function parseGhostMediaRef(
  url: string,
  exts: ReadonlySet<string>,
): { ghostId: string; hash: string; ext: string } | null {
  const prefix = `${GHOST_SCHEME}://`;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  const m = /^([a-z0-9-]{1,32})\/(media|preview)\/([^/?#]+)$/.exec(rest);
  if (!m) return null;
  const fileRef = m[3];
  const dotIdx = fileRef.lastIndexOf('.');
  if (dotIdx <= 0) return null;
  const hash = fileRef.slice(0, dotIdx);
  const ext = fileRef.slice(dotIdx).toLowerCase();
  if (!HASH_RE.test(hash)) return null;
  if (!exts.has(ext)) return null;
  return { ghostId: m[1], hash, ext };
}

/**
 * 解析拖拽引渡地址 → 意识 id + 指纹 + 后缀。
 *
 * 与 parseGhostPreviewUrl 的两点差异:
 * - 收 `/media/` 与 `/preview/` 两种形状——面板作者显式 dragstart 塞的是
 *   /media/ 地址,而直接拖 <a> 链接时浏览器默认带的是 href(/preview/),
 *   两者携带的指纹相同,都认;后缀收图片 + 视频(图片落图片附件,视频落
 *   路径引用的文件附件,见 resolveGhostPanelMedia);
 * - 意识 id 从 URL 里取(拖拽的 drop 事件不带来源 webContents,无法像
 *   will-navigate 那样绑定身份)——安全性由「归属校验绑定该 id + 指纹
 *   内容寻址不可猜 + 附件托盘可见 + 发送需人手」兜住,见拖拽引渡设计讨论。
 */
export function parseGhostMediaHandoverUrl(
  url: string,
): { ghostId: string; hash: string; ext: string } | null {
  return parseGhostMediaRef(url, PREVIEW_MEDIA_EXTS);
}

/**
 * 解析面板右键菜单地址:形状同引渡,但后缀收全部媒体(图片 + 视频)——
 * 右键菜单的动作(复制文件 / 打开所在目录)对视频与图片同样成立,与聊天流
 * 里 ChatVideoView 的右键能力对齐。
 */
export function parseGhostPanelMediaUrl(
  url: string,
): { ghostId: string; hash: string; ext: string } | null {
  return parseGhostMediaRef(url, PREVIEW_MEDIA_EXTS);
}

/** 面板媒体换发的用途:attach = 拖拽引渡落附件;menu = 右键菜单。两者均收图片 + 视频。 */
export type GhostPanelMediaPurpose = 'attach' | 'menu';

/** resolveGhostPanelMedia 的换发结果:图片只回地址(renderer 走会话缓存复制
 *  的图片附件链路);视频附带路径引用元数据(不复制字节——规则 25 不新写
 *  媒体缓存,落成与「从系统拖 .mp4 进聊天」同款的 file 类别路径附件)。 */
export type GhostPanelMediaResolved =
  | { url: string; kind: 'image' }
  | { url: string; kind: 'video'; absPath: string; size: number; name: string; ext: string; mimeType: string };

/**
 * 面板媒体换发闸(拖拽引渡 / 右键菜单共用一条校验链):
 * 形状 → 账本归属(绑定 URL 里声明的意识 id)→ mime(账本为准,不信后缀)。
 * 图片 / 视频都放行:图片回 cindy-media 地址;视频额外解析指纹仓磁盘路径与
 * 体积(路径解析或 stat 失败视同查无,统一 null)。
 * 任一环不过返回 null,调用方统一 NOT_FOUND,不区分原因。
 * 纯逻辑 + 依赖注入(规则 14),真实组装在 cindy-brain/index.ts。
 */
export async function resolveGhostPanelMedia(
  uri: string,
  purpose: GhostPanelMediaPurpose,
  deps: Pick<GhostPreviewGateDeps, 'ghostCanRead' | 'getBlobInfo' | 'blobUrl'> & {
    /** 指纹 + 后缀 → 字节仓磁盘绝对路径(blobStore.resolveHashRef,不合格抛)。 */
    blobAbsPath(hash: string, ext: string): string;
    /** 文件体积(附件托盘/发送链路要 size;文件缺失时 reject)。 */
    statSize(absPath: string): Promise<number>;
  },
): Promise<GhostPanelMediaResolved | null> {
  // 两用途同一形状预筛(图片 + 视频);保留 purpose 是给未来通道分化留位。
  const parsed = purpose === 'menu' ? parseGhostPanelMediaUrl(uri) : parseGhostMediaHandoverUrl(uri);
  if (!parsed) return null;
  if (!(await deps.ghostCanRead(parsed.hash, parsed.ghostId))) return null;
  const info = await deps.getBlobInfo(parsed.hash);
  const kind = !info
    ? null
    : info.mimeType.startsWith('image/')
      ? ('image' as const)
      : info.mimeType.startsWith('video/')
        ? ('video' as const)
        : null;
  if (!info || !kind) return null;
  const url = deps.blobUrl(parsed.hash, info.ext);
  if (kind === 'video') {
    try {
      const absPath = deps.blobAbsPath(parsed.hash, info.ext);
      const size = await deps.statSize(absPath);
      // 附件展示名:意识 id + 指纹前 8 位(全指纹 64 位当文件名太吵)。
      const name = `${parsed.ghostId}-${parsed.hash.slice(0, 8)}${info.ext}`;
      return { url, kind, absPath, size, name, ext: info.ext, mimeType: info.mimeType };
    } catch {
      return null;
    }
  }
  return { url, kind };
}

export interface GhostPreviewGateDeps {
  /** 账本归属:该指纹出生自本意识或挂本意识画廊。 */
  ghostCanRead(hash: string, ghostId: string): Promise<boolean>;
  /** 账本落盘元数据(ext/mime 的权威来源;无账 = null)。 */
  getBlobInfo(hash: string): Promise<{ ext: string; mimeType: string } | null>;
  /** 主机拼装最终 lightbox 地址(blobStore.blobUrl)。 */
  blobUrl(hash: string, ext: string): string;
  /** 时钟注入(限速用;缺省 Date.now)。 */
  now?(): number;
}

export type GhostPreviewOutcome =
  | {
      ok: true;
      src: string;
      /** 媒体类别(账本 mime 判定):宿主窗口按它选 Image/Video lightbox。 */
      kind: 'image' | 'video';
    }
  | {
      ok: false;
      reason: 'bad-url' | 'not-focused' | 'rate-limited' | 'not-owned' | 'not-media';
    };

/** 同一意识两次外链跳转的最小间隔(ms;与预览闸同款限速纪律)。 */
export const GHOST_EXTERNAL_LINK_MIN_INTERVAL_MS = 1000;

export interface GhostExternalLinkGateDeps {
  /**
   * 该意识身份卡里声明过的全部外链地址(network.secrets[].url 等,装包时
   * 已校验仅 https)。有效但无声明返回空数组；查不到或已停用返回 null，
   * 让旧 guest 在授权生命周期结束后 fail closed。
   */
  declaredExternalUrls(ghostId: string): readonly string[] | null;
  /** 时钟注入(限速用;缺省 Date.now)。 */
  now?(): number;
}

export type GhostExternalLinkOutcome =
  | { action: 'direct-open'; url: string }
  | { action: 'confirm'; url: string }
  | {
      action: 'reject';
      reason:
        | 'bad-url'
        | 'not-focused'
        | 'rate-limited'
        | 'confirmation-pending'
        | 'ghost-unavailable';
    };

/**
 * 首版基座固定授信主机。根域与子域必须按 DNS label 边界匹配，不能用裸
 * `endsWith('xd.com')`，否则 evilxd.com 会被误放行。workers.xd.team 只认
 * 精确主机，不自动把其子域纳入信任。
 */
function isTrustedGhostExternalHostname(hostname: string): boolean {
  if (hostname === 'workers.xd.team') return true;
  return (
    hostname === 'xd.com' ||
    hostname.endsWith('.xd.com') ||
    hostname === 'xd.cn' ||
    hostname.endsWith('.xd.cn')
  );
}

/**
 * 外链闸(设置区/面板里的「前往控制台」链接):意识 webview 导航时,主机
 * 拦下导航并在这里过闸。只接受无内嵌凭证的绝对 HTTPS 地址；逐字命中
 * 身份卡既有声明或命中固定授信主机的直接转系统浏览器，其余合法地址交
 * 宿主弹二次确认。安全模型与预览闸同一纪律(廉价检查挡在贵检查前面):
 * - 焦点闸:webview 必须正持有焦点才放行,未聚焦页面不能触发。焦点只
 *   是 activation 前置条件,不是“真实点击”证明；will-navigate 本身无法
 *   区分普通 `<a>` 与聚焦页面里的脚本导航；
 * - 限速:**按尝试记账**(不只按成功),同一意识两次尝试至少间隔 1s——
 *   声明比对要经 GhostManager 实扫磁盘上的身份卡(目录即注册表,无缓存),
 *   限速必须罩住它,持焦点的恶意页用导航垃圾也刷不动主进程 IO;
 *   连续 spam 会不断顺延窗口(闸整体关死),对真实点击无感;
 * - 现有声明地址维持逐字比对兼容语义；授信主机只按 URL 解析器规范化的
 *   hostname + DNS label 边界判断；确认分支只回规范化后的不可变 URL;
 * - 同一意识最多一个确认在途，宿主无论打开、取消或异常都须 release;
 * - 失败静默(调用方只记 debug 日志),不给沙箱可探测的差异面。
 */
export class GhostExternalLinkGate {
  /** 意识 id → 上次尝试时刻(限速账本,按尝试记账;体量 = 已装意识数,无需清理)。 */
  private lastAttemptAt = new Map<string, number>();
  /** 正在等待宿主原生确认框的意识；确认结束时由调用方释放。 */
  private confirmationPending = new Set<string>();

  constructor(private readonly deps: GhostExternalLinkGateDeps) {}

  request(params: {
    ghostId: string;
    url: string;
    /** webview 当前是否持有焦点(guestContents.isFocused)。 */
    isPanelFocused: () => boolean;
  }): GhostExternalLinkOutcome {
    if (!params.isPanelFocused()) return { action: 'reject', reason: 'not-focused' };
    const now = this.deps.now?.() ?? Date.now();
    const last = this.lastAttemptAt.get(params.ghostId);
    this.lastAttemptAt.set(params.ghostId, now);
    if (last !== undefined && now - last < GHOST_EXTERNAL_LINK_MIN_INTERVAL_MS) {
      return { action: 'reject', reason: 'rate-limited' };
    }
    if (this.confirmationPending.has(params.ghostId)) {
      return { action: 'reject', reason: 'confirmation-pending' };
    }
    let parsed: URL;
    try {
      parsed = new URL(params.url);
    } catch {
      return { action: 'reject', reason: 'bad-url' };
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      return { action: 'reject', reason: 'bad-url' };
    }
    const declaredExternalUrls = this.deps.declaredExternalUrls(params.ghostId);
    if (declaredExternalUrls === null) {
      return { action: 'reject', reason: 'ghost-unavailable' };
    }
    // 既有声明继续逐字比对，避免改变存量插件已经依赖的直开语义。
    if (declaredExternalUrls.includes(params.url)) {
      return { action: 'direct-open', url: params.url };
    }
    const normalizedUrl = parsed.href;
    if (isTrustedGhostExternalHostname(parsed.hostname)) {
      return { action: 'direct-open', url: normalizedUrl };
    }
    this.confirmationPending.add(params.ghostId);
    return { action: 'confirm', url: normalizedUrl };
  }

  /** 宿主确认框结束后的 finally 钩；重复释放无副作用。 */
  releaseConfirmation(ghostId: string): void {
    this.confirmationPending.delete(ghostId);
  }

  /** 原生确认返回后复核授权生命周期，防止弹窗期间停用或卸载后仍打开。 */
  isGhostAvailable(ghostId: string): boolean {
    return this.deps.declaredExternalUrls(ghostId) !== null;
  }
}

/**
 * 预览闸:一次导航请求 → 校验链(形状 → 焦点 → 限速 → 归属 → mime)→
 * 主机拼装的 cindy-media:// 地址。任何一环不过即结构化拒绝,调用方只记
 * 日志、绝不回传差异给沙箱。
 */
export class GhostPreviewGate {
  /** 意识 id → 上次放行时刻(限速账本;体量 = 已装意识数,无需清理)。 */
  private lastOpenedAt = new Map<string, number>();

  constructor(private readonly deps: GhostPreviewGateDeps) {}

  async request(params: {
    ghostId: string;
    url: string;
    /** 面板 webview 当前是否持有焦点(guestContents.isFocused)。 */
    isPanelFocused: () => boolean;
  }): Promise<GhostPreviewOutcome> {
    const parsed = parseGhostPreviewUrl(params.url, params.ghostId);
    if (!parsed) return { ok: false, reason: 'bad-url' };
    // 焦点闸:用户不在面板上 = 不是用户点的,拒。lightbox 打开后焦点离开
    // 面板,自动触发的连环预览在这里断链。
    if (!params.isPanelFocused()) return { ok: false, reason: 'not-focused' };
    const now = this.deps.now?.() ?? Date.now();
    const last = this.lastOpenedAt.get(params.ghostId);
    if (last !== undefined && now - last < GHOST_PREVIEW_MIN_INTERVAL_MS) {
      return { ok: false, reason: 'rate-limited' };
    }
    if (!(await this.deps.ghostCanRead(parsed.hash, params.ghostId))) {
      return { ok: false, reason: 'not-owned' };
    }
    // ext/mime 以账本为准(URL 后缀只是预筛):图片/视频各归各的 lightbox
    // (视频渲染链路就绪后放行),其余类型待各自链路就绪再逐类放行。
    const info = await this.deps.getBlobInfo(parsed.hash);
    const kind = !info
      ? null
      : info.mimeType.startsWith('image/')
        ? ('image' as const)
        : info.mimeType.startsWith('video/')
          ? ('video' as const)
          : null;
    if (!info || !kind) return { ok: false, reason: 'not-media' };
    this.lastOpenedAt.set(params.ghostId, now);
    return { ok: true, src: this.deps.blobUrl(parsed.hash, info.ext), kind };
  }
}
