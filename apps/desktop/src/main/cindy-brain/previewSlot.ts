/**
 * previewSlot.ts — 面板预览槽(preview,2026-07-23)。
 * ---------------------------------------------------------------------------
 * 插件经管子上行 `{type:'preview-request', url, sessionId?}`,请主机在右侧栏
 * **内置浏览器**打开一个预览标签页(部署预览 / 本地 dev server / 控制台等)。
 * 与 previewGate.ts(面板媒体 lightbox 闸)不是一回事:那边是"点图看大图",
 * 这边是"开网页标签"。
 *
 * 安全模型:
 * - 资格审:已装、启用、声明 preview 槽(校验层保证槽与详单严格成对);
 * - URL 守门:ghostPreviewUrlAllowed——只收 https(http 仅 loopback),
 *   不收内嵌凭证,hostname 必须命中身份卡 preview.hosts 白名单。范围装入
 *   确认框逐条展示、装入后钉死,沙箱给的字符串没有机会变成任意跳转,
 *   防钓鱼是结构性的;
 * - 限速:同一插件两次打开最小间隔 GHOST_PREVIEW_OPEN_MIN_INTERVAL_MS
 *   (按尝试记账,spam 顺延窗口)——标签页刷屏刷不起来;
 * - 落地:广播到宿主窗口,renderer 在右侧栏开 web-browser 标签并弹带插件
 *   身份头的提示;sessionId 只做形状校验(右侧栏标签本就是本机用户自己的
 *   UI,不存在"开进别人隐私空间"的面),缺省落台前会话,两者皆无如实拒。
 *
 * 纯逻辑 + 依赖注入(规则 14):广播在 cindy-brain/index.ts 组装时注入。
 */

import {
  GHOST_PREVIEW_OPEN_MIN_INTERVAL_MS,
  ghostPreviewUrlAllowed,
  type GhostPipePreviewResult,
  type InstalledGhost,
} from '../../shared/ghost.js';

/** 推给 renderer 的预览开页载荷(身份三件套由主机按已装清单填,不信自报)。 */
export interface GhostPreviewOpenPush {
  ghostId: string;
  /** 插件展示名(标签身份提示,主机填)。 */
  name: string;
  iconDataUrl?: string;
  /** 目标会话(main 已兜底解析:显式指定或台前会话)。 */
  sessionId: string;
  url: string;
}

export interface PreviewSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  /** 把开页请求推给宿主窗口;false = 一个窗口都不在(HOST_NOT_READY)。 */
  broadcast(payload: GhostPreviewOpenPush): boolean;
  /** 台前会话快照(请求缺省 sessionId 时的落点;非会话页为 null)。 */
  focusedSessionId(): string | null;
  now?(): number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/** sessionId 形状(uuid / cuid 都在此内;真伪 renderer 兜底)。 */
const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

function fail(
  errorCode: Extract<GhostPipePreviewResult, { ok: false }>['errorCode'],
  message: string,
): GhostPipePreviewResult {
  return { ok: false, errorCode, message };
}

/** 面板预览槽:资格审 → URL 白名单守门 → 限速 → 广播开页。 */
export class GhostPreviewSlot {
  /** 意识 id → 上次尝试时刻(按尝试记账;体量 = 已装意识数,无需清理)。 */
  private readonly lastAttemptAt = new Map<string, number>();

  constructor(private readonly deps: PreviewSlotDeps) {}

  handleRequest(
    ghostId: string,
    payload: unknown,
    options: { focusedSessionIdOverride?: string | null } = {},
  ): GhostPipePreviewResult {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.slots.includes('preview')) {
      return fail('PERMISSION_DENIED', '插件未申请面板预览权限(preview 槽),或当前未启用');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return fail('INVALID_REQUEST', 'preview-request 载荷必须是对象');
    }
    const request = payload as Record<string, unknown>;
    if (typeof request.url !== 'string' || request.url.length === 0) {
      return fail('INVALID_REQUEST', 'url 必填且必须是字符串');
    }
    if (request.sessionId !== undefined) {
      if (typeof request.sessionId !== 'string' || !SESSION_ID_RE.test(request.sessionId)) {
        return fail('INVALID_REQUEST', 'sessionId 形状不合法');
      }
    }
    if (!ghostPreviewUrlAllowed(ghost.manifest, request.url)) {
      return fail(
        'URL_NOT_ALLOWED',
        'url 未命中身份卡 preview.hosts 白名单(https,或 http 仅限 localhost;不收内嵌凭证)',
      );
    }

    // 限速按尝试记账:spam 会不断顺延窗口,对真实节奏的预览无感。
    const now = this.deps.now?.() ?? Date.now();
    const last = this.lastAttemptAt.get(ghostId);
    this.lastAttemptAt.set(ghostId, now);
    if (last !== undefined && now - last < GHOST_PREVIEW_OPEN_MIN_INTERVAL_MS) {
      return fail('RATE_LIMITED', '预览打开请求太频繁,稍后再试');
    }

    // 落点会话:显式 sessionId 优先(通常来自 session-context 注入),缺省
    // 落台前会话;两者皆无(用户不在会话页)= 没有可开标签的家,如实拒。
    const sessionId =
      typeof request.sessionId === 'string'
        ? request.sessionId
        : options.focusedSessionIdOverride !== undefined
          ? options.focusedSessionIdOverride
          : this.deps.focusedSessionId();
    if (!sessionId) {
      return fail('HOST_NOT_READY', '当前没有活跃会话可承载预览标签');
    }

    const delivered = this.deps.broadcast({
      ghostId,
      name: ghost.manifest.name,
      ...(ghost.iconDataUrl ? { iconDataUrl: ghost.iconDataUrl } : {}),
      sessionId,
      url: request.url,
    });
    if (!delivered) {
      return fail('HOST_NOT_READY', '当前没有可用的宿主窗口');
    }
    this.deps.log?.info('ghost preview open requested', { ghostId, url: request.url });
    return { ok: true };
  }
}
