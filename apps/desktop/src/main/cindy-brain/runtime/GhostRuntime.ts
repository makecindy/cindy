import type { InstalledGhost } from '../../../shared/ghost.js';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity.js';

/**
 * GhostRuntime — 意识运行时状态机(docs/dev-rules/plugin-security-and-authoring.md)。
 *
 * 管"每段意识一个独立沙箱进程"的生命周期:拉起 / 熄灯 / 崩溃收尸 / 熔断。
 * 沙箱怎么造(Electron 隐藏沙箱网页)通过 SandboxHostAdapter 注入——
 * 本类只有纯状态逻辑,单测用假 adapter + 假时钟直接驱动(规范 14)。
 *
 * 状态梯子:
 *   off → starting → running → stopping → off
 *                       └→ crashed(单次崩溃,可再 spawn)
 *                       └→ fused(60s 内 3 崩熔断;onFused 回调让上层转沉睡)
 *
 * 本类只做"被动驱动"(dev 工具 / 上层显式调用);按需拉起与闲置熄灯的
 * 自动策略(面板可见性、宽限 5 分钟)由上层接线,不在本类。
 */

export type GhostRuntimeState = 'off' | 'starting' | 'running' | 'stopping' | 'crashed' | 'fused';

/** 一个已创建沙箱的句柄(adapter 返回;destroy 必须幂等)。 */
export interface SandboxHandle {
  /** 加载意识入口;resolve = 进入 running。 */
  load(): Promise<void>;
  /** 立即销毁沙箱(幂等;销毁引发的 gone 事件不得再回调 onGone)。 */
  destroy(): void;
  /** 仅 dev:强制让沙箱进程崩溃(QA 崩溃隔离用)。 */
  crashForTest(): void;
  /** 订阅"沙箱进程意外死亡"(崩溃 / 被外部杀);destroy 引发的不算。 */
  onGone(cb: (details: { reason: string }) => void): void;
}

export interface SandboxHostAdapter {
  create(ghost: InstalledGhost): SandboxHandle;
}

interface GhostRuntimeOptions {
  adapter: SandboxHostAdapter;
  /** 熔断窗口(ms)与窗口内崩溃次数上限(2026-07-09 定案:60s / 3 次)。 */
  crashWindowMs?: number;
  crashLimit?: number;
  /** 熔断回调:上层据此把意识转沉睡(setEnabled false)并提示用户。 */
  onFused?: (id: string) => void;
  /** 状态变化通知(dev 工具 / 未来 UI 状态点)。 */
  onStateChanged?: (id: string, state: GhostRuntimeState) => void;
  /** 时钟注入(测试用假时钟)。 */
  now?: () => number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

interface RuntimeEntry {
  state: GhostRuntimeState;
  handle: SandboxHandle | null;
  /** 熔断窗口内的崩溃时间戳(旧的滚动淘汰)。 */
  crashTimestamps: number[];
}

export class GhostRuntime {
  private readonly options: Required<Pick<GhostRuntimeOptions, 'crashWindowMs' | 'crashLimit'>> &
    GhostRuntimeOptions;

  private readonly entries = new Map<string, RuntimeEntry>();

  constructor(options: GhostRuntimeOptions) {
    this.options = { crashWindowMs: 60_000, crashLimit: 3, ...options };
  }

  stateOf(id: string): GhostRuntimeState {
    return this.entries.get(id)?.state ?? 'off';
  }

  listStates(): Record<string, GhostRuntimeState> {
    const out: Record<string, GhostRuntimeState> = {};
    for (const [id, entry] of this.entries) out[id] = entry.state;
    return out;
  }

  /**
   * 拉起沙箱。幂等:starting/running 直接返回当前态;fused 拒绝(须先 resetFuse,
   * 即用户重新唤醒);stopping 拒绝(等熄灯完成)。
   */
  async spawn(ghost: InstalledGhost): Promise<{ ok: true; state: GhostRuntimeState } | { ok: false; reason: string }> {
    const id = installedGhostStoragePart(ghost);
    const entry = this.getEntry(id);
    if (entry.state === 'starting' || entry.state === 'running') return { ok: true, state: entry.state };
    if (entry.state === 'fused') return { ok: false, reason: '已熔断(反复崩溃),重新唤醒后可再试' };
    if (entry.state === 'stopping') return { ok: false, reason: '正在熄灯,稍后再试' };

    this.setState(id, entry, 'starting');
    // 沙箱创建本身也可能同步 throw(如 app 未 ready、窗口创建失败):同样按
    // 一次崩溃记账并返回结构化失败,绝不让 state 卡死在 starting(review P0)。
    let handle: SandboxHandle;
    try {
      handle = this.options.adapter.create(ghost);
    } catch (err) {
      this.options.log?.warn('ghost sandbox create failed', { id, error: err instanceof Error ? err.message : String(err) });
      this.recordCrash(id, entry);
      return { ok: false, reason: '沙箱创建失败' };
    }
    entry.handle = handle;
    handle.onGone((details) => this.handleGone(id, details.reason));
    try {
      await handle.load();
    } catch (err) {
      // 入口都加载不出来按一次崩溃记账(坏 entry 反复 spawn 同样会熔断)。
      this.options.log?.warn('ghost sandbox load failed', { id, error: err instanceof Error ? err.message : String(err) });
      handle.destroy();
      // stop() 打断在途 load 后可能已挂上新 handle:只清理属于本次的引用,
      // 不误伤新 spawn(review P2 守卫)。
      if (entry.handle === handle) {
        entry.handle = null;
        this.recordCrash(id, entry);
      }
      return { ok: false, reason: '入口加载失败' };
    }
    // load 期间可能已被 stop/crash 改道;只有仍处 starting 才转 running。
    // (经 stateOf 重读:setState 走方法赋值,TS 的字面量收窄跟不上。)
    if (this.stateOf(id) === 'starting') this.setState(id, entry, 'running');
    return { ok: true, state: this.stateOf(id) };
  }

  /** 熄灯(沉睡 / 抽离 / 闲置超时 / 退出前逐个关)。幂等。 */
  stop(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || !entry.handle || entry.state === 'off') return;
    this.setState(id, entry, 'stopping');
    // 当前直接销毁:沙箱页面没有需要善后的状态(先礼后兵的
    // "礼"——shutdown 通知 + 宽限——等管子协议丰满后在此插入)。
    entry.handle.destroy();
    entry.handle = null;
    this.setState(id, entry, 'off');
  }

  /** 仅 dev:强崩沙箱进程,QA 崩溃隔离链路。 */
  crashForTest(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry?.handle || entry.state !== 'running') return false;
    entry.handle.crashForTest();
    return true;
  }

  /** 用户重新唤醒(setEnabled true)时清熔断记账,给意识新生。 */
  resetFuse(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.crashTimestamps = [];
    if (entry.state === 'fused' || entry.state === 'crashed') this.setState(id, entry, 'off');
  }

  /** 主机退出 / 模块收尾:销毁全部沙箱。 */
  destroyAll(): void {
    for (const [id, entry] of this.entries) {
      if (entry.handle) {
        entry.handle.destroy();
        entry.handle = null;
      }
      if (entry.state !== 'fused') this.setState(id, entry, 'off');
    }
  }

  private getEntry(id: string): RuntimeEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { state: 'off', handle: null, crashTimestamps: [] };
      this.entries.set(id, entry);
    }
    return entry;
  }

  /** 沙箱进程意外死亡:收尸 + 熔断记账。 */
  private handleGone(id: string, reason: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    // stop()/destroyAll() 已把 handle 摘掉的迟到事件,忽略。
    if (!entry.handle) return;
    this.options.log?.warn('ghost sandbox gone', { id, reason });
    entry.handle.destroy();
    entry.handle = null;
    this.recordCrash(id, entry);
  }

  private recordCrash(id: string, entry: RuntimeEntry): void {
    const now = (this.options.now ?? Date.now)();
    entry.crashTimestamps = entry.crashTimestamps.filter((t) => now - t < this.options.crashWindowMs);
    entry.crashTimestamps.push(now);
    if (entry.crashTimestamps.length >= this.options.crashLimit) {
      this.setState(id, entry, 'fused');
      this.options.log?.warn('ghost fused after repeated crashes', { id, crashes: entry.crashTimestamps.length });
      this.options.onFused?.(id);
    } else {
      this.setState(id, entry, 'crashed');
    }
  }

  private setState(id: string, entry: RuntimeEntry, state: GhostRuntimeState): void {
    if (entry.state === state) return;
    entry.state = state;
    this.options.onStateChanged?.(id, state);
  }
}
