/**
 * GhostGrantConfirmBridge —— ghost_call 过户 workdir 外文件的「用户确认」桥。
 *
 * 背景:意识触碰用户文件的通道(attachments / dir / save_dir)原本把可达面
 * 钳制在「进过聊天流的图」与「会话 workdir 内」;两层策略升级后(2026-07-14
 * 与 Lizi 定案):workdir 内自动放行,workdir 外改为**弹确认卡**——把「拖图
 * 进聊天」这个授权动作换成「点一下允许」,决定权在用户的点击上,被注入的
 * 模型只能发起请求、点不了按钮。
 *
 * 实现完全对齐 IssueConfirmBridge 的成熟模式:main 侧发起,broadcast 一个
 * kind='ghost_grant_confirm' 的 interaction 到 renderer(复用
 * MAKER_PUSH.INTERACTION_REQUEST / MAKER_INVOKE.RESOLVE_INTERACTION 通道),
 * pending promise 挂起直到用户允许/拒绝、超时或会话清理。不进
 * pendingInteractionResolvers(那套 map 服务 agent 发起的闭合 union;feishu
 * /ctr 接管会整体搬走,对未知 kind 直接 deny)——确认卡只在 desktop 出现,
 * 超时即兜底拒绝。
 *
 * 本模块保持 electron-free(broadcast 由 register.ts 注入),单测直接 new。
 */

import { randomUUID } from 'node:crypto';

import { MAKER_PUSH } from '../maker-ipc/channels';

/**
 * 过户通道:attachments = 媒体文件进总仓;dir = 上行读票据;save_dir = 下行
 * 写票据;fs_write = fs 槽写 workdir 文件(会话 permission 为逐条确认档时,
 * 意识每次写入前弹卡;同目录本会话批一次,记忆在 fsSlot);workspace =
 * workspace 槽在会话 workdir 外的目录下创建/复用会话入口(2026-07-25,
 * 不过户字节,只授权"以此目录为工作区建会话")。
 */
export type GhostGrantLane = 'attachments' | 'dir' | 'save_dir' | 'fs_write' | 'workspace';

/** 确认卡上逐条展示的过户对象(路径/大小让用户看清自己在授权什么)。 */
export interface GhostGrantFileItem {
  /** 展示名(basename)。 */
  name: string;
  /** 完整绝对路径(用户须看到真实位置才叫知情授权)。 */
  absPath: string;
  /** 文件字节数;目录条目为收集后的总字节数。 */
  size: number;
  mimeType?: string;
  /** 图片的内嵌缩略预览(dataURL;非图片/超阈值缺省)。 */
  previewDataUrl?: string;
  isDirectory?: boolean;
  /** 目录条目:收集到的文件数。 */
  fileCount?: number;
}

export interface GhostGrantConfirmPayload {
  ghostId: string;
  /** 意识显示名(确认卡标题用;查不到时回落 id)。 */
  ghostName: string;
  lane: GhostGrantLane;
  items: GhostGrantFileItem[];
}

export type GhostGrantConfirmDecision =
  | {
      confirmed: true;
      /**
       * attachments 通道的「目录级授权」勾选:用户允许的同时把 items 所在
       * 目录(精确父目录,不递归)记入会话级记忆,后续该目录下的媒体文件
       * 对该意识本会话内免弹。默认 false。
       */
      allowDirs?: boolean;
    }
  | { confirmed: false; reason: 'cancelled' | 'timeout' | 'session_closed' | 'session_aborted' };

export interface GhostGrantConfirmBridgeDeps {
  broadcast: (channel: string, payload: unknown) => void;
  /** 确认超时,默认 10 分钟(对齐 permission prompt / issue 确认卡)。测试注小值。 */
  timeoutMs?: number;
  logger?: { warn: (...args: unknown[]) => void };
  /** 同 IssueConfirmBridgeDeps.onDesktopOnlyConfirmPending(#926):IM 侧「去桌面确认」提示。 */
  onDesktopOnlyConfirmPending?: (sessionId: string) => void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

interface PendingGrantEntry {
  sessionId: string;
  resolve: (decision: GhostGrantConfirmDecision) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class GhostGrantConfirmBridge {
  private readonly pending = new Map<string, PendingGrantEntry>();

  constructor(private readonly deps: GhostGrantConfirmBridgeDeps) {}

  /** 向 renderer 派发确认卡片,挂起直到用户响应/超时/会话清理。 */
  request(sessionId: string, payload: GhostGrantConfirmPayload): Promise<GhostGrantConfirmDecision> {
    const requestId = randomUUID();
    return new Promise<GhostGrantConfirmDecision>((resolve) => {
      const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timeoutId = setTimeout(() => {
        this.settle(requestId, { confirmed: false, reason: 'timeout' }, 'timeout');
      }, timeoutMs);
      this.pending.set(requestId, { sessionId, resolve, timeoutId });
      this.deps.broadcast(MAKER_PUSH.INTERACTION_REQUEST, {
        sessionId,
        request: { kind: 'ghost_grant_confirm', requestId, ...payload },
      });
      try {
        this.deps.onDesktopOnlyConfirmPending?.(sessionId);
      } catch (err) {
        // 旁路提示绝不反噬确认流程:回调同步抛错会在 Promise executor 里把
        // request() 直接 reject(review 反馈)——吞错只 warn。
        this.deps.logger?.warn('onDesktopOnlyConfirmPending threw (ignored)', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  /**
   * renderer 经 RESOLVE_INTERACTION 回包。返回是否命中本桥的 pending
   * (false = requestId 不属于本桥,调用方继续走其它桥/resolver)。
   */
  resolve(requestId: string, rawDecision: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    let decision = parseDecision(rawDecision);
    if (!decision) {
      // shape 非法按取消兜底,避免 ghost_call 永久挂起。
      this.deps.logger?.warn('ghost-grant-confirm: invalid decision shape, fallback to cancelled', {
        requestId,
      });
      decision = { confirmed: false, reason: 'cancelled' };
    }
    this.settlePending(requestId, entry, decision);
    // 同会话多窗口时确认卡 broadcast 给了所有窗口;响应窗口发 IPC 前已自清
    // state,其余窗口靠这条 DISMISSED 收卡(按 requestId 匹配,no-op 安全)。
    this.deps.broadcast(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: entry.sessionId,
      requestId,
      reason: 'resolved',
      resolvedAs: decision.confirmed ? 'allow' : 'deny',
    });
    return true;
  }

  /** 会话关闭/中止时清掉该会话所有 pending,并让 renderer 收卡。 */
  cleanupForSession(sessionId: string, reason: 'session_closed' | 'session_aborted'): void {
    for (const [requestId, entry] of Array.from(this.pending.entries())) {
      if (entry.sessionId !== sessionId) continue;
      this.settle(requestId, { confirmed: false, reason }, reason);
    }
  }

  /** 内部统一收口:resolve + 清 pending + 广播 DISMISSED 让 renderer 关卡片。 */
  private settle(
    requestId: string,
    decision: GhostGrantConfirmDecision & { confirmed: false },
    dismissReason: string,
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.settlePending(requestId, entry, decision);
    this.deps.broadcast(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: entry.sessionId,
      requestId,
      reason: dismissReason,
      resolvedAs: 'deny',
    });
  }

  private settlePending(
    requestId: string,
    entry: PendingGrantEntry,
    decision: GhostGrantConfirmDecision,
  ): void {
    this.pending.delete(requestId);
    clearTimeout(entry.timeoutId);
    entry.resolve(decision);
  }
}

function parseDecision(raw: unknown): GhostGrantConfirmDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.confirmed === true) return { confirmed: true, allowDirs: obj.allowDirs === true };
  if (obj.confirmed === false) return { confirmed: false, reason: 'cancelled' };
  return null;
}

let bridgeSingleton: GhostGrantConfirmBridge | null = null;

/**
 * 初始化单例(register.ts 装配期调用,注入 broadcast)。ghost.ts 经
 * getGhostGrantConfirmBridge 消费;未初始化(极早期/单测环境)时返回 null,
 * 调用方按「确认通道未就绪」拒绝,不抛。
 */
export function initGhostGrantConfirmBridge(deps: GhostGrantConfirmBridgeDeps): GhostGrantConfirmBridge {
  bridgeSingleton = new GhostGrantConfirmBridge(deps);
  return bridgeSingleton;
}

export function getGhostGrantConfirmBridge(): GhostGrantConfirmBridge | null {
  return bridgeSingleton;
}
