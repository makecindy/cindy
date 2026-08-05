/**
 * ghostSessionActivity.ts — 意识后台活动 → 会话运行呼吸信号(卡片交互 v2 配套)。
 * ---------------------------------------------------------------------------
 * 背景:card-action(交互卡按钮点击)是 fire-and-forget 的后台干活,不经过
 * LLM turn,makerChatStore 的 isRunning 永远不亮——用户完全看不出"意识还在
 * 干活/干完了"。本跟踪器补上这条信号:
 *
 *   开始 = card-action 派发成功(dispatcher 接线,主机侧确定性动作);
 *   保持 = 该卡位后续 card-update(state:'working' 或未声明)刷新 TTL;
 *   结束 = card-update 声明 state:'done',或 TTL 静默超时兜底(意识不配合 /
 *          崩了也不会永远呼吸)。
 *
 * 以"卡位 key(spawnCallId / callId)"为最小单位、按 sessionId 引用计数:
 * 同会话多个动作并发时,最后一个结束才熄呼吸。0↔1 转变才 broadcast,
 * renderer 侧(ghostSessionActivityStore)按会话 OR 进侧栏呼吸判断。
 *
 * 依赖全注入(规则 14):broadcast / 时钟 / 定时器可替换,单测零 Electron。
 */

export interface GhostSessionActivityDeps {
  /** 会话忙闲变化广播(0↔1 转变才调;busy=true 亮呼吸,false 熄)。 */
  broadcast(sessionId: string, busy: boolean): void;
  /** 定时器注入(TTL 兜底;缺省 setTimeout/clearTimeout)。 */
  scheduleTimeout?(fn: () => void, ms: number): unknown;
  cancelTimeout?(handle: unknown): void;
  log?: {
    debug(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * 静默 TTL:key 自上次活动(派发/供片)起超过此时长没有新 card-update 就视为
 * 结束(兜底熄呼吸)。取值要覆盖 mivo 单窗轮询(105s)+ 图片下载 + 余量;
 * 意识按协议发 state:'working' 过程卡会不断续期,长任务不受此限。
 */
export const GHOST_SESSION_ACTIVITY_TTL_MS = 180_000;

interface ActivityEntry {
  sessionId: string;
  timer: unknown;
}

/** 意识后台活动跟踪器(单例装配见 cindy-brain/index.ts)。 */
export class GhostSessionActivityTracker {
  private readonly entries = new Map<string, ActivityEntry>();
  private readonly sessionKeys = new Map<string, Set<string>>();

  constructor(private readonly deps: GhostSessionActivityDeps) {}

  private schedule(fn: () => void, ms: number): unknown {
    return this.deps.scheduleTimeout ? this.deps.scheduleTimeout(fn, ms) : setTimeout(fn, ms);
  }

  private cancel(handle: unknown): void {
    if (this.deps.cancelTimeout) this.deps.cancelTimeout(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  /** 某会话当前是否有在途的意识后台活动。 */
  isSessionBusy(sessionId: string): boolean {
    return (this.sessionKeys.get(sessionId)?.size ?? 0) > 0;
  }

  /**
   * 活动开始(card-action 派发成功时调;key = 衍生卡位 spawnCallId,兜底原
   * callId)。同 key 重复 begin 只续 TTL,不重复计数。
   */
  begin(key: string, sessionId: string): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.cancel(existing.timer);
      existing.timer = this.armTtl(key);
      return;
    }
    this.entries.set(key, { sessionId, timer: this.armTtl(key) });
    let keys = this.sessionKeys.get(sessionId);
    if (!keys) {
      keys = new Set();
      this.sessionKeys.set(sessionId, keys);
    }
    keys.add(key);
    if (keys.size === 1) {
      this.deps.log?.debug('ghost session activity: busy', { sessionId, key });
      this.deps.broadcast(sessionId, true);
    }
  }

  /**
   * 该卡位收到一版被接受的 card-update(cardService.onActivity 接线,仅重开态):
   * - state 'done' → 本次活动结束;
   * - state 'working' → 续 TTL;没跟踪过则补开(TTL 已过期 / 重启后仍在干活);
   * - 未声明(null)→ 只给已跟踪的 key 续 TTL(不凭空点亮,避免误报)。
   */
  noteCardUpdate(key: string, sessionId: string | null, state: 'working' | 'done' | null): void {
    if (state === 'done') {
      this.end(key);
      return;
    }
    const existing = this.entries.get(key);
    if (existing) {
      this.cancel(existing.timer);
      existing.timer = this.armTtl(key);
      return;
    }
    if (state === 'working' && sessionId) this.begin(key, sessionId);
  }

  /** 活动结束(done 声明 / TTL 超时):引用计数归零才熄该会话的呼吸。 */
  end(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.cancel(entry.timer);
    this.entries.delete(key);
    const keys = this.sessionKeys.get(entry.sessionId);
    if (keys) {
      keys.delete(key);
      if (keys.size === 0) {
        this.sessionKeys.delete(entry.sessionId);
        this.deps.log?.debug('ghost session activity: idle', { sessionId: entry.sessionId, key });
        this.deps.broadcast(entry.sessionId, false);
      }
    }
  }

  private armTtl(key: string): unknown {
    return this.schedule(() => {
      this.deps.log?.warn('ghost session activity: ttl expired', { key });
      this.end(key);
    }, GHOST_SESSION_ACTIVITY_TTL_MS);
  }
}
