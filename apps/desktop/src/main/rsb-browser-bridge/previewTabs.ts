/**
 * PreviewTabIndex — 插件预览标签的可信索引(main 进程)。
 *
 * 目的:让 main 知道「右栏里哪个浏览器标签是哪个插件经 previewSlot 打开的」,
 * 供手机端投屏等能力只面向插件预览标签,而不是任意网页标签。
 *
 * 信任链:
 *   previewSlot 校验通过 → issue() 签发 previewRequestId(CSPRNG,未绑定时 12 小时有效,
 *   绑定 ghostId / sessionId / URL origin)随开页推送下发 → renderer 存进标签状态
 *   → 标签 report(sessionId, tabId, wcId, previewRequestId) → bind() 校验后建立绑定。
 *
 * 规则:
 * - 签发表里的 id 只有一次「首次绑定」机会:无论校验成败,取走即废;同一个 id 不能
 *   再绑到别的标签。
 * - 绑定成功后该标签保留一份 grant(同 tabId + 同 id),使 guest 重建(弹出独立窗口、
 *   LRU 回收后重建)的重新 report 能原样复绑;grant 在换源 / 插件不可用 / 标签
 *   不再存活时作废,作废后同一个 id 无法复活。
 * - 失效:registry release(含 webContents destroyed)、webContentsId 变更(guest 重建)、
 *   插件停用 / 卸载 / 不再声明 preview、插件更新(安装代次变了)。失效即触发 onEnded。
 * - 暂停:同一 webContents 顶层导航离开绑定 origin(典型是预览要求登录、跳到账号站点
 *   再回来)不作废,而是暂停:触发一次 onEnded('origin-changed')(投屏据此结束,不会采集
 *   跨站页面),list / get / current 一律当作不存在,grant 无从签发或使用。同一 webContents
 *   之后导航回**完全相同的绑定 origin** 即恢复;超过 PREVIEW_PAUSE_LIMIT_MS 没回来则作废。
 *   暂停期间所有其他失效条件照旧生效(静默:onEnded 已经发过)。
 * - 暂停(加载失败):同一 webContents 的主文档加载失败(连接被拒 / DNS 失败等,Chromium
 *   错误页)同样当作暂停——插件重启查看器服务、端口换了之后,旧标签只剩一张打不开的
 *   错误页,手机列表不该再出现它。语义与上一条一致:触发一次 onEnded('load-failed')、
 *   查询一律不可见;主文档之后成功加载(服务回来、用户刷新)且仍在绑定 origin 即恢复,
 *   暂停超过 PREVIEW_PAUSE_LIMIT_MS 作废。两种暂停原因可叠加,全部解除才恢复。
 * - 普通网页标签(无 previewRequestId)永远不进索引。
 *
 * 纯逻辑 + 依赖注入(便于单测):Electron 与插件清单的访问由调用方注入。
 */

import { randomBytes } from 'node:crypto';

import { PREVIEW_REQUEST_ID_RE } from '../../shared/rsbBrowserBridge.js';
import type { TabRecord } from './registry.js';

/**
 * previewRequestId 在「首次绑定」之前的有效期。
 *
 * 为什么是小时级而不是秒级:标签不可见时(用户停在别的任务 / 别的页面)渲染进程不会
 * 物化它的 webview,要等用户切回该任务才 report;手机远程使用的主场景恰恰是人不在
 * 电脑前。30 秒会让这类预览永远绑不上。长有效期不放大攻击面:id 只能由宿主 renderer
 * 经 IPC 提交(guest 页面与插件沙箱碰不到),提交时仍要核对 sessionId、guest 当前
 * origin、插件可用性,且取走即废;未绑定条目靠数量上限淘汰最旧,内存有界。
 */
export const PREVIEW_REQUEST_TTL_MS = 12 * 60 * 60 * 1000;
/**
 * 暂停(顶层导航离开绑定 origin)的最长时长。登录 / OAuth 往返通常是分钟级;超过这个
 * 时间没回到绑定 origin 就作废,避免跨站页面后的标签长期悬挂在索引里。
 */
export const PREVIEW_PAUSE_LIMIT_MS = 30 * 60 * 1000;
/** 签发表上限(未绑定条目;spam 已被 previewSlot 限速,这里兜底并淘汰最旧)。 */
const MAX_PENDING_REQUESTS = 64;
/** grant 上限(按最近绑定保留)。无活绑定且不存活的标签由 snapshot 的 pruneTabs 清理。 */
const MAX_GRANTS = 256;

/** 一个已建立的插件预览标签绑定。 */
export interface PreviewTabBinding {
  readonly tabId: string;
  readonly sessionId: string;
  readonly webContentsId: number;
  readonly ghostId: string;
  /** 插件展示名(主机按已装清单投影,不信自报)。 */
  readonly pluginName: string;
  /** 签发时的 URL origin;标签顶层导航到其他 origin 即暂停,回到该 origin 恢复。 */
  readonly origin: string;
  /** 每次(重)绑定与每次暂停后恢复自增,供消费方区分同一 tab 的不同代际。 */
  readonly generation: number;
  readonly boundAt: number;
}

export type PreviewTabEndReason =
  /** registry release:标签关闭 / LRU 回收 / webContents destroyed。 */
  | 'released'
  /** 同一标签换了 guest(弹出独立窗口等),旧绑定结束。 */
  | 'replaced'
  /** 顶层导航离开绑定 origin:绑定暂停(回到原 origin 可恢复),投屏据此结束。 */
  | 'origin-changed'
  /**
   * 主文档加载失败(Chromium 错误页):绑定暂停,成功加载后恢复。典型是插件重启了
   * 自己的查看器服务,旧端口已无人监听。
   */
  | 'load-failed'
  /** 暂停超过 PREVIEW_PAUSE_LIMIT_MS 仍没解除(只记日志,不触发 onEnded)。 */
  | 'pause-expired'
  /** 插件停用 / 卸载 / 不再声明 preview。 */
  | 'plugin-unavailable'
  /**
   * 插件更新 / 重装(安装代次变了)。旧标签里是旧版本的页面,更新会重启插件自己的
   * 服务,页面背后的服务已停;选它进不去,所以直接从索引移除,新版本开的预览是新标签。
   */
  | 'plugin-updated';

export interface PreviewTabEnded {
  readonly binding: PreviewTabBinding;
  readonly reason: PreviewTabEndReason;
}

export type PreviewTabEndedListener = (event: PreviewTabEnded) => void;

export interface PreviewTabGhostInfo {
  /** 已启用且仍声明 preview 槽。 */
  available: boolean;
  name: string;
  /**
   * 安装代次(版本 + 安装批准快照):插件更新 / 重装后变化。缺省 = 不跟踪(绑定不会
   * 因更新失效)。签发时记下,之后与当前值不同即视为插件已更新。
   */
  revision?: string;
}

export interface PreviewTabIndexDeps {
  /** 按 previewSlot 里的插件实例 id 取当前身份;未安装返回 null。 */
  getGhost(ghostId: string): PreviewTabGhostInfo | null;
  /** guest 当前顶层 URL;webContents 不可解析时 null。 */
  getGuestUrl(webContentsId: number): string | null;
  /** 订阅 guest 的顶层导航提交(did-navigate),返回退订函数。 */
  watchNavigation(webContentsId: number, onNavigate: (url: string) => void): () => void;
  /** guest 主文档当前是不是 Chromium 错误页(连接被拒 / DNS 失败等)。缺省 = 不跟踪。 */
  isGuestDocumentFailed?(webContentsId: number): boolean;
  /**
   * 订阅 guest 主文档的加载结果:failed=true = 主框架加载失败;failed=false = 一次加载
   * 完成且提交的不是错误页。返回退订函数。缺省 = 不跟踪。
   */
  watchLoadHealth?(webContentsId: number, onHealth: (failed: boolean) => void): () => void;
  now?(): number;
  /** 签发 id 的随机源,默认 32 字节 CSPRNG base64url(43 字符)。 */
  randomId?(): string;
  logger?: {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
  };
}

interface PendingRequest {
  ghostId: string;
  ghostRevision?: string;
  sessionId: string;
  origin: string;
  expiresAt: number;
}

interface Grant {
  requestId: string;
  ghostId: string;
  ghostRevision?: string;
  sessionId: string;
  origin: string;
}

interface LiveBinding {
  binding: PreviewTabBinding;
  stopWatching: () => void;
  /** 暂停开始时刻;null = 活动。暂停中的条目对所有查询不可见。 */
  pausedAt: number | null;
  /** 顶层 URL 仍在绑定 origin 内。 */
  originOk: boolean;
  /** 主文档当前是加载失败的错误页。 */
  loadFailed: boolean;
}

function defaultRandomId(): string {
  return randomBytes(32).toString('base64url');
}

/** URL → origin;非 http(s)、解析失败、不透明 origin 返回 null。 */
function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** guest 尚未提交首个导航(attach 早期上报)时的 URL 形态。 */
function isBlankUrl(url: string | null): boolean {
  return url === null || url === '' || url === 'about:blank';
}

export class PreviewTabIndex {
  private readonly pending = new Map<string, PendingRequest>();
  /** tabId → grant。 */
  private readonly grants = new Map<string, Grant>();
  /** tabId → 活绑定。 */
  private readonly live = new Map<string, LiveBinding>();
  private readonly endedListeners = new Set<PreviewTabEndedListener>();
  private generationSeq = 0;

  constructor(private readonly deps: PreviewTabIndexDeps) {}

  // ── 签发(previewSlot 调用) ────────────────────────────────────────────────

  /**
   * 为一次已通过守门的桌面预览签发 previewRequestId。url 必须是 http(s)
   * (previewSlot 的白名单已保证);origin 不可得时返回 null,调用方照常开页。
   */
  issue(input: { ghostId: string; sessionId: string; url: string }): string | null {
    const origin = originOf(input.url);
    if (!origin) return null;
    const now = this.now();
    this.purgeExpired(now);
    while (this.pending.size >= MAX_PENDING_REQUESTS) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    const id = (this.deps.randomId ?? defaultRandomId)();
    const ghostRevision = this.deps.getGhost(input.ghostId)?.revision;
    this.pending.set(id, {
      ghostId: input.ghostId,
      ...(ghostRevision !== undefined ? { ghostRevision } : {}),
      sessionId: input.sessionId,
      origin,
      expiresAt: now + PREVIEW_REQUEST_TTL_MS,
    });
    return id;
  }

  // ── 绑定(ipc report 处理里,registry.report 之后调用) ──────────────────────

  /**
   * 处理一次标签 report。previewRequestId 缺失 / 非法 = 普通网页标签:不建立绑定,
   * 但若该 tab 之前绑定过另一个 guest,旧绑定随换 guest 结束。
   */
  bind(record: TabRecord, previewRequestId?: unknown): void {
    const existing = this.live.get(record.tabId);
    const requestId =
      typeof previewRequestId === 'string' && PREVIEW_REQUEST_ID_RE.test(previewRequestId)
        ? previewRequestId
        : undefined;
    if (previewRequestId !== undefined && !requestId) {
      this.rejected(record, 'invalid-request-id');
    }

    if (existing && existing.binding.webContentsId === record.webContentsId) {
      // 同一 guest 的重复 report(did-attach + dom-ready):幂等。
      return;
    }
    if (existing) this.end(record.tabId, 'replaced');
    if (!requestId) return;

    const claimed = this.grantFor(record, requestId);
    if ('reason' in claimed) {
      this.rejected(record, claimed.reason);
      return;
    }
    const grant = claimed.grant;

    const ghost = this.deps.getGhost(grant.ghostId);
    if (!ghost?.available) {
      this.grants.delete(record.tabId);
      this.rejected(record, 'plugin-unavailable');
      return;
    }
    if (this.isStale(grant, ghost)) {
      this.grants.delete(record.tabId);
      this.rejected(record, 'plugin-updated');
      return;
    }
    // guest 已提交过页面时核对真实 origin;空白页(attach 早期上报)放行,
    // 随后的导航提交由 watchNavigation 兜住。
    const currentUrl = this.deps.getGuestUrl(record.webContentsId);
    if (!isBlankUrl(currentUrl) && originOf(currentUrl as string) !== grant.origin) {
      this.grants.delete(record.tabId);
      this.rejected(record, 'origin-mismatch');
      return;
    }

    const binding: PreviewTabBinding = {
      tabId: record.tabId,
      sessionId: record.sessionId,
      webContentsId: record.webContentsId,
      ghostId: grant.ghostId,
      pluginName: ghost.name,
      origin: grant.origin,
      generation: ++this.generationSeq,
      boundAt: this.now(),
    };
    const loadFailed = this.deps.isGuestDocumentFailed?.(record.webContentsId) ?? false;
    const entry: LiveBinding = {
      binding,
      stopWatching: () => undefined,
      // 绑定时主文档已经是错误页(guest 重建后服务已停):直接以暂停态入索引,不通知
      // ——它从未对外可见过。
      pausedAt: loadFailed ? this.now() : null,
      originOk: true,
      loadFailed,
    };
    const stopNavigation = this.deps.watchNavigation(record.webContentsId, (url) =>
      this.onNavigated(entry, url),
    );
    const stopLoadHealth =
      this.deps.watchLoadHealth?.(record.webContentsId, (failed) =>
        this.onLoadHealth(entry, failed),
      ) ?? (() => undefined);
    entry.stopWatching = () => {
      stopNavigation();
      stopLoadHealth();
    };
    this.live.set(record.tabId, entry);
    this.rememberGrant(record.tabId, grant);
  }

  /** registry.release 之后调用:该 tab 的活绑定结束,grant 保留以便 guest 重建后复绑。 */
  onRegistryRelease(record: TabRecord): void {
    const entry = this.live.get(record.tabId);
    if (!entry || entry.binding.webContentsId !== record.webContentsId) return;
    this.end(record.tabId, 'released');
  }

  /** 插件清单变化(安装 / 卸载 / 启停 / 换版)后调用:不可用插件的绑定与 grant 作废。 */
  reconcileGhosts(): void {
    this.expirePaused();
    for (const [tabId, grant] of [...this.grants]) {
      const ghost = this.deps.getGhost(grant.ghostId);
      const reason: PreviewTabEndReason | null = !ghost?.available
        ? 'plugin-unavailable'
        : this.isStale(grant, ghost)
          ? 'plugin-updated'
          : null;
      if (reason) {
        this.grants.delete(tabId);
        if (this.live.has(tabId)) this.end(tabId, reason);
      }
    }
    for (const [tabId, entry] of [...this.live]) {
      if (!this.deps.getGhost(entry.binding.ghostId)?.available) {
        this.grants.delete(tabId);
        this.end(tabId, 'plugin-unavailable');
      }
    }
  }

  /**
   * snapshot 对账之后调用:清掉「当前没有活绑定、也不在该 renderer 存活集合里」的
   * grant。活绑定不动——snapshot 只代表发起它的那个 renderer,别的窗口(独立侧栏)
   * 的标签不在其中,活绑定的收口只走 registry release / 导航 / 插件状态。
   */
  pruneTabs(liveTabIds: readonly string[]): void {
    this.expirePaused();
    const alive = new Set(liveTabIds);
    for (const tabId of [...this.grants.keys()]) {
      if (alive.has(tabId) || this.live.has(tabId)) continue;
      this.grants.delete(tabId);
    }
  }

  // ── 查询(T4 使用) ─────────────────────────────────────────────────────────

  /** 当前所有预览标签绑定;sessionId 给定时只返回该任务的。按绑定时间升序。 */
  list(sessionId?: string): PreviewTabBinding[] {
    this.reconcileGhosts();
    return [...this.live.values()]
      .filter((entry) => entry.pausedAt === null)
      .map((entry) => entry.binding)
      .filter((binding) => sessionId === undefined || binding.sessionId === sessionId)
      .sort((a, b) => a.boundAt - b.boundAt || a.generation - b.generation);
  }

  get(tabId: string): PreviewTabBinding | null {
    this.reconcileGhosts();
    const entry = this.live.get(tabId);
    return entry && entry.pausedAt === null ? entry.binding : null;
  }

  /**
   * 该 tab 的绑定是否仍是这个 guest。T4 在每次采集 / 注入前用它核对来源没变;
   * tabId 复用、guest 重建、换源后返回 null。
   */
  current(tabId: string, webContentsId: number): PreviewTabBinding | null {
    const binding = this.get(tabId);
    return binding && binding.webContentsId === webContentsId ? binding : null;
  }

  onEnded(listener: PreviewTabEndedListener): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * guest 顶层导航提交。离开绑定 origin → 暂停(grant 与导航监听保留);暂停中回到
   * 完全相同的绑定 origin → 恢复(若没有其他暂停原因)。
   */
  private onNavigated(entry: LiveBinding, url: string): void {
    if (this.live.get(entry.binding.tabId) !== entry) return;
    entry.originOk = originOf(url) === entry.binding.origin;
    this.settle(entry);
  }

  /** guest 主文档加载结果:失败 → 暂停;成功提交且回到绑定 origin → 恢复。 */
  private onLoadHealth(entry: LiveBinding, failed: boolean): void {
    if (this.live.get(entry.binding.tabId) !== entry) return;
    entry.loadFailed = failed;
    this.settle(entry);
  }

  /**
   * 按 originOk / loadFailed 对齐暂停态。
   *
   * 恢复时换一个新 generation(因此 ref 也变):暂停前基于旧 generation 的投屏会话、
   * 一次性 grant 都不会借「回到原 origin / 服务重启」复活,手机重新列表后看到的是一个
   * 新来源;暂停期间发生过什么,旧来源并不知情。
   */
  private settle(entry: LiveBinding): void {
    const { tabId } = entry.binding;
    if (entry.pausedAt !== null && this.now() - entry.pausedAt >= PREVIEW_PAUSE_LIMIT_MS) {
      this.grants.delete(tabId);
      this.end(tabId, 'pause-expired');
      return;
    }
    const shouldPause = !entry.originOk || entry.loadFailed;
    if (shouldPause) {
      if (entry.pausedAt !== null) return;
      entry.pausedAt = this.now();
      this.deps.logger?.info('preview tab binding paused', {
        tabId,
        ghostId: entry.binding.ghostId,
        reason: entry.originOk ? 'load-failed' : 'origin-changed',
      });
      this.notifyEnded(entry.binding, entry.originOk ? 'load-failed' : 'origin-changed');
      return;
    }
    if (entry.pausedAt === null) return;
    // 恢复前再核对一次插件仍可用(暂停期间的清单变化不一定经过 reconcile)。
    if (!this.deps.getGhost(entry.binding.ghostId)?.available) {
      this.grants.delete(tabId);
      this.end(tabId, 'plugin-unavailable');
      return;
    }
    entry.binding = { ...entry.binding, generation: ++this.generationSeq };
    entry.pausedAt = null;
    this.deps.logger?.info('preview tab binding resumed', {
      tabId,
      ghostId: entry.binding.ghostId,
    });
  }

  /** 签发时记了安装代次、而插件当前代次不同 = 插件更新过。 */
  private isStale(grant: Grant, ghost: PreviewTabGhostInfo): boolean {
    return (
      grant.ghostRevision !== undefined &&
      ghost.revision !== undefined &&
      grant.ghostRevision !== ghost.revision
    );
  }

  /** 作废暂停超过上限的条目(惰性检查:无定时器,每次查询 / 对账 / 导航时核对)。 */
  private expirePaused(): void {
    const now = this.now();
    for (const [tabId, entry] of [...this.live]) {
      if (entry.pausedAt !== null && now - entry.pausedAt >= PREVIEW_PAUSE_LIMIT_MS) {
        this.grants.delete(tabId);
        this.end(tabId, 'pause-expired');
      }
    }
  }

  private purgeExpired(now: number): void {
    for (const [id, request] of this.pending) {
      if (request.expiresAt <= now) this.pending.delete(id);
    }
  }

  /**
   * 取得这次 report 可用的 grant:复绑走本 tab 已有 grant(id 必须一致);首次绑定
   * 从签发表取走 id(无论成败都作废)并核对 session。
   */
  private grantFor(record: TabRecord, requestId: string): { grant: Grant } | { reason: string } {
    const existing = this.grants.get(record.tabId);
    if (existing) {
      return existing.requestId === requestId && existing.sessionId === record.sessionId
        ? { grant: existing }
        : { reason: 'grant-mismatch' };
    }
    const now = this.now();
    this.purgeExpired(now);
    const request = this.pending.get(requestId);
    if (!request) return { reason: 'unknown-or-expired-request' };
    this.pending.delete(requestId);
    if (request.sessionId !== record.sessionId) return { reason: 'session-mismatch' };
    return {
      grant: {
        requestId,
        ghostId: request.ghostId,
        ...(request.ghostRevision !== undefined ? { ghostRevision: request.ghostRevision } : {}),
        sessionId: request.sessionId,
        origin: request.origin,
      },
    };
  }

  /** 绑定被拒:只记标签与原因码,不记 previewRequestId 等凭据值。 */
  private rejected(record: TabRecord, reason: string): void {
    this.deps.logger?.warn('preview tab bind rejected', {
      tabId: record.tabId,
      sessionId: record.sessionId,
      reason,
    });
  }

  private rememberGrant(tabId: string, grant: Grant): void {
    this.grants.delete(tabId);
    this.grants.set(tabId, grant);
    while (this.grants.size > MAX_GRANTS) {
      const oldest = this.grants.keys().next().value;
      if (oldest === undefined) break;
      this.grants.delete(oldest);
      if (this.live.has(oldest)) this.end(oldest, 'released');
    }
  }

  private end(tabId: string, reason: PreviewTabEndReason): void {
    const entry = this.live.get(tabId);
    if (!entry) return;
    this.live.delete(tabId);
    try {
      entry.stopWatching();
    } catch {
      // guest 已销毁时退订失败无害。
    }
    this.deps.logger?.info('preview tab binding ended', {
      tabId,
      ghostId: entry.binding.ghostId,
      reason,
    });
    // 暂停时已经发过 onEnded;暂停中的后续作废静默,不重复通知。
    if (entry.pausedAt === null) this.notifyEnded(entry.binding, reason);
  }

  private notifyEnded(binding: PreviewTabBinding, reason: PreviewTabEndReason): void {
    for (const listener of [...this.endedListeners]) {
      try {
        listener({ binding, reason });
      } catch (err) {
        this.deps.logger?.warn('preview tab ended listener threw (ignored)', err);
      }
    }
  }
}
