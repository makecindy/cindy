/**
 * PreviewTabIndex — 插件预览标签的可信索引(main 进程)。
 *
 * 目的:让 main 知道「右栏里哪个浏览器标签是哪个插件经 previewSlot 打开的」,
 * 供手机端投屏等能力只面向插件预览标签,而不是任意网页标签。
 *
 * 信任链:
 *   previewSlot 校验通过 → issue() 签发 previewRequestId(CSPRNG,30 秒有效,
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
 *   顶层导航到不同 origin、插件停用 / 卸载 / 不再声明 preview。失效即触发 onEnded。
 * - 普通网页标签(无 previewRequestId)永远不进索引。
 *
 * 纯逻辑 + 依赖注入(便于单测):Electron 与插件清单的访问由调用方注入。
 */

import { randomBytes } from 'node:crypto';

import { PREVIEW_REQUEST_ID_RE } from '../../shared/rsbBrowserBridge.js';
import type { TabRecord } from './registry.js';

/** previewRequestId 有效期:从签发到首次绑定。 */
export const PREVIEW_REQUEST_TTL_MS = 30_000;
/** 签发表上限(防止插件在 30 秒内刷出无限条目;spam 已被 previewSlot 限速,这里兜底)。 */
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
  /** 签发时的 URL origin;标签顶层导航到其他 origin 即失效。 */
  readonly origin: string;
  /** 每次(重)绑定自增,供消费方区分同一 tab 的不同 guest 代际。 */
  readonly generation: number;
  readonly boundAt: number;
}

export type PreviewTabEndReason =
  /** registry release:标签关闭 / LRU 回收 / webContents destroyed。 */
  | 'released'
  /** 同一标签换了 guest(弹出独立窗口等),旧绑定结束。 */
  | 'replaced'
  /** 顶层导航到不同 origin。 */
  | 'origin-changed'
  /** 插件停用 / 卸载 / 不再声明 preview。 */
  | 'plugin-unavailable';

export interface PreviewTabEnded {
  readonly binding: PreviewTabBinding;
  readonly reason: PreviewTabEndReason;
}

export type PreviewTabEndedListener = (event: PreviewTabEnded) => void;

export interface PreviewTabGhostInfo {
  /** 已启用且仍声明 preview 槽。 */
  available: boolean;
  name: string;
}

export interface PreviewTabIndexDeps {
  /** 按 previewSlot 里的插件实例 id 取当前身份;未安装返回 null。 */
  getGhost(ghostId: string): PreviewTabGhostInfo | null;
  /** guest 当前顶层 URL;webContents 不可解析时 null。 */
  getGuestUrl(webContentsId: number): string | null;
  /** 订阅 guest 的顶层导航提交(did-navigate),返回退订函数。 */
  watchNavigation(webContentsId: number, onNavigate: (url: string) => void): () => void;
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
  sessionId: string;
  origin: string;
  expiresAt: number;
}

interface Grant {
  requestId: string;
  ghostId: string;
  sessionId: string;
  origin: string;
}

interface LiveBinding {
  binding: PreviewTabBinding;
  stopWatching: () => void;
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
    this.pending.set(id, {
      ghostId: input.ghostId,
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

    if (existing && existing.binding.webContentsId === record.webContentsId) {
      // 同一 guest 的重复 report(did-attach + dom-ready):幂等。
      return;
    }
    if (existing) this.end(record.tabId, 'replaced');
    if (!requestId) return;

    const grant = this.grantFor(record, requestId);
    if (!grant) return;

    const ghost = this.deps.getGhost(grant.ghostId);
    if (!ghost?.available) {
      this.grants.delete(record.tabId);
      return;
    }
    // guest 已提交过页面时核对真实 origin;空白页(attach 早期上报)放行,
    // 随后的导航提交由 watchNavigation 兜住。
    const currentUrl = this.deps.getGuestUrl(record.webContentsId);
    if (!isBlankUrl(currentUrl) && originOf(currentUrl as string) !== grant.origin) {
      this.grants.delete(record.tabId);
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
    const stopWatching = this.deps.watchNavigation(record.webContentsId, (url) => {
      if (originOf(url) === binding.origin) return;
      this.grants.delete(binding.tabId);
      if (this.live.get(binding.tabId)?.binding === binding) this.end(binding.tabId, 'origin-changed');
    });
    this.live.set(record.tabId, { binding, stopWatching });
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
    for (const [tabId, grant] of [...this.grants]) {
      if (!this.deps.getGhost(grant.ghostId)?.available) {
        this.grants.delete(tabId);
        if (this.live.has(tabId)) this.end(tabId, 'plugin-unavailable');
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
      .map((entry) => entry.binding)
      .filter((binding) => sessionId === undefined || binding.sessionId === sessionId)
      .sort((a, b) => a.boundAt - b.boundAt || a.generation - b.generation);
  }

  get(tabId: string): PreviewTabBinding | null {
    this.reconcileGhosts();
    return this.live.get(tabId)?.binding ?? null;
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

  private purgeExpired(now: number): void {
    for (const [id, request] of this.pending) {
      if (request.expiresAt <= now) this.pending.delete(id);
    }
  }

  /**
   * 取得这次 report 可用的 grant:复绑走本 tab 已有 grant(id 必须一致);首次绑定
   * 从签发表取走 id(无论成败都作废)并核对 session。
   */
  private grantFor(record: TabRecord, requestId: string): Grant | null {
    const existing = this.grants.get(record.tabId);
    if (existing) {
      return existing.requestId === requestId && existing.sessionId === record.sessionId
        ? existing
        : null;
    }
    const now = this.now();
    this.purgeExpired(now);
    const request = this.pending.get(requestId);
    if (!request) return null;
    this.pending.delete(requestId);
    if (request.sessionId !== record.sessionId) return null;
    return {
      requestId,
      ghostId: request.ghostId,
      sessionId: request.sessionId,
      origin: request.origin,
    };
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
    for (const listener of [...this.endedListeners]) {
      try {
        listener({ binding: entry.binding, reason });
      } catch (err) {
        this.deps.logger?.warn('preview tab ended listener threw (ignored)', err);
      }
    }
  }
}
