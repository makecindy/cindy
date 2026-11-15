/**
 * 远程模型连接池(控制端，这台电脑对每台运行 Agent 的电脑一个)。
 *
 * 对方电脑按「发起设备」限制同时开着的远程任务数(`caps.maxRuns`)，开着的 Agent 进程才占名额，
 * 对话记录不占。本机任务闲着时 Agent 进程仍开着，名额紧张时就由这里让出：只断开那台电脑上的 Agent
 * (`close`)，对话记录与本机部分(执行器、本机 Cindy 工具、Codex 执行环境)都留着，下次要它干活时
 * 带原来的会话 id 连回来。
 *
 * 只在名额紧张时让：
 *  - 本机在这台电脑上开着的连接数到了水位线(maxRuns 的 80%，向上取整)：按最久没活动的顺序让，直到降到
 *    水位线以下。上限很小(1～4)时水位线就等于上限，「快满」等同「已满」，不提前让，只走下面两条按需的；
 *  - 打开前已满：先让一个再打开；
 *  - 对方以名额已满拒绝打开：让一个再重试一次。
 * 只有「不忙」且闲置满对方电脑声明的闲置收回时长(`caps.idleReclaimMinutes`，由对方主人设置)的连接才有资格让；
 * 没有就不动，由对方的上限做最终裁决。对方没声明(旧版)或设为 0 时一个都不让(满了直接报错)。闲置满这个时长的
 * 任务对方本来也会自己收回(本机按 idleReclaimed 处理成已让出)，这里只是名额紧张时不必等它那一轮巡检。
 * 不排队等名额。对方整机合计上限(TOTAL_LIMIT)本机看不到别的设备的占用，只能靠被拒后处理。
 */
export const REMOTE_AGENT_POOL_WATERMARK_RATIO = 0.8;
/** 在水位线之上的连接会随时间变得有资格，定期再看一次。 */
export const REMOTE_AGENT_POOL_CHECK_MS = 60_000;
/** 让出时 close 没送到：隔这么久再原样发一次。 */
export const REMOTE_AGENT_POOL_CLOSE_RETRY_MS = 2_000;
/**
 * close 没送到时本机按仍占着名额计数的最长时间。对方在任务超过 REMOTE_AGENT_HOST_IDLE_MS(3 分钟)没被
 * 读取后，要到下一次回收检查(每 5 秒)才结束它；本机停止拉取前已在途的 poll(最长挂起 10 秒)还可能稍后
 * 刷新对方的读取时间。占位覆盖这些最坏延迟并留余量：宁可多占一会儿，也不比对方更早认为名额已空。
 */
export const REMOTE_AGENT_POOL_CLOSE_HOLD_MS = 3 * 60_000 + 30_000;

export interface PooledRemoteConnection {
  /** 占着对方的名额(正在连、连着或正在断开)。 */
  occupiesSlot(): boolean;
  /** 不忙：没有在跑的回合、没有未完成的请求，对方进程里也没有后台工作。 */
  isIdle(): boolean;
  /** 最后一次活动的时间(毫秒)。 */
  lastActivityAt(): number;
  /** 断开对方电脑上的 Agent(仍然不忙时才断)；返回是否让出了名额。 */
  release(): Promise<boolean>;
}

/**
 * 对方以名额已满拒绝打开(`REMOTE_AGENT_BUSY` 的单设备 / 整机上限；旧版对方只有一句
 * `too many tasks are running from this computer`)。暂存数据过多(`too much staged data`)也是
 * `REMOTE_AGENT_BUSY`，但与名额无关，不算。
 */
export function isRemoteRunLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!message.includes('REMOTE_AGENT_BUSY')) return false;
  return /\[(?:DEVICE|TOTAL)_LIMIT\]/.test(message) || message.includes('too many tasks are running from this computer');
}

export interface RemoteConnectionPoolOptions {
  /**
   * 闲置满多少分钟才有资格让出名额；0 = 不让。每次判断时读取。缺省用对方电脑最近一次在 caps 里声明的
   * 闲置收回时长(noteIdleReclaimMinutes)。
   */
  idleMinutes?(): number;
  /** 主动让出前读取提供方的当前设置；读取失败时不沿用缓存关闭进程。 */
  readCaps?(): Promise<{ maxRuns: number; idleReclaimMinutes?: number }>;
  now?: () => number;
  checkMs?: number;
  closeRetryMs?: number;
  closeHoldMs?: number;
  log?: { info(message: string, meta?: Record<string, unknown>): void; warn(message: string, meta?: Record<string, unknown>): void };
}

export class RemoteConnectionPool {
  private readonly members = new Set<PooledRemoteConnection>();
  /**
   * 让出时 close 没送到、对方可能还占着名额的旧 run → 结束占位、再发一次 close。占位独立于任务存在：
   * 任务关闭或归档(注销)后照样占着，直到再发成功或过了对方的回收期。
   */
  private readonly held = new Map<PooledRemoteConnection, { end: () => void; retryClose: () => Promise<unknown> }>();
  private maxRuns: number | null = null;
  /** 对方最近一次声明的闲置收回时长(分钟)；旧版对方不声明，按 0。 */
  private idleReclaimMinutes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 让出名额一次只做一个，避免几条路径同时挑中不同的连接、多让。 */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: RemoteConnectionPoolOptions) {
    this.now = options.now ?? Date.now;
  }

  /** 登记一个连接；返回注销函数。 */
  add(member: PooledRemoteConnection): () => void {
    this.members.add(member);
    if (!this.timer) {
      this.timer = setInterval(() => void this.trim(), this.options.checkMs ?? REMOTE_AGENT_POOL_CHECK_MS);
      (this.timer as { unref?: () => void }).unref?.();
    }
    return () => {
      this.members.delete(member);
      if (this.members.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  /** 对方最近一次报的单设备上限(每次打开前 caps 拿到)。 */
  noteMaxRuns(maxRuns: number): void {
    if (Number.isInteger(maxRuns) && maxRuns >= 1) this.maxRuns = maxRuns;
  }

  /** 对方最近一次声明的闲置收回时长(每次打开前 caps 拿到；没声明 = 旧版，不让)。 */
  noteIdleReclaimMinutes(minutes: number | undefined): void {
    this.idleReclaimMinutes = Number.isInteger(minutes) && minutes! > 0 ? minutes! : 0;
  }

  get size(): number {
    return this.members.size;
  }

  /**
   * 本机在这台电脑上占着的名额数。`except` 只排除它正要开的那个位置：它让出时 close 没送到、对方可能还没
   * 结束的旧 run 照样算(对方要到新进程启动时才替换同一任务的旧实例，打开时的名额检查会算上它)。
   */
  occupied(except?: PooledRemoteConnection): number {
    // 占位中的旧 run 都算，包括任务已注销的。
    let count = this.held.size;
    for (const member of this.members) if (member !== except && member.occupiesSlot()) count += 1;
    return count;
  }

  /**
   * 让出时 close 没送到(链路抖动等)：对方的进程可能还占着名额。在本机计数里继续占位，隔一会儿用
   * `retryClose` 原样再发一次 close；再发成功(对方不认识这个任务也算)或到了对方自行回收的时间后不再占位。
   * 占位期间水位线与打开前的判断都算上它，会去让别的有资格的连接，而不是直接打开撞上限。
   */
  holdAfterFailedClose(member: PooledRemoteConnection, retryClose: () => Promise<unknown>): void {
    this.held.get(member)?.end();
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(retry);
      clearTimeout(expire);
      if (this.held.get(member) === record) this.held.delete(member);
    };
    const record = { end, retryClose };
    const retry = setTimeout(() => {
      retryClose().then(end, (error) => {
        this.options.log?.warn('remote agent pool: closing a released connection failed again', { error: String(error) });
      });
    }, this.options.closeRetryMs ?? REMOTE_AGENT_POOL_CLOSE_RETRY_MS);
    const expire = setTimeout(end, this.options.closeHoldMs ?? REMOTE_AGENT_POOL_CLOSE_HOLD_MS);
    (retry as { unref?: () => void }).unref?.();
    (expire as { unref?: () => void }).unref?.();
    this.held.set(member, record);
  }

  /** 立刻再发一次 close 关掉这个连接 close 没送到的旧 run；关掉了(对方不认识也算)就不再占位。 */
  private async closeHeld(member: PooledRemoteConnection): Promise<boolean> {
    const record = this.held.get(member);
    if (!record) return false;
    try {
      await record.retryClose();
    } catch (error) {
      this.options.log?.warn('remote agent pool: closing a released connection failed again', { error: String(error) });
      return false;
    }
    record.end();
    return true;
  }

  /** 提前让出名额的水位线；上限太小(水位线不低于上限)时没有。 */
  watermark(): number | null {
    if (this.maxRuns === null) return null;
    const watermark = Math.ceil(this.maxRuns * REMOTE_AGENT_POOL_WATERMARK_RATIO);
    return watermark < this.maxRuns ? watermark : null;
  }

  /** 有资格让出名额：不忙，且闲置满设置时长(0 = 都没有资格)。 */
  private isEligible(member: PooledRemoteConnection): boolean {
    const minutes = this.options.idleMinutes?.() ?? this.idleReclaimMinutes;
    if (!Number.isFinite(minutes) || minutes <= 0) return false;
    return member.occupiesSlot() && member.isIdle() && this.now() - member.lastActivityAt() >= minutes * 60_000;
  }

  /** 有资格让出名额的连接，最久没活动的在前。 */
  eligible(except?: PooledRemoteConnection): PooledRemoteConnection[] {
    return [...this.members]
      .filter((member) => member !== except && this.isEligible(member))
      .sort((a, b) => a.lastActivityAt() - b.lastActivityAt());
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async refreshPolicy(): Promise<boolean> {
    if (!this.options.readCaps) return true;
    try {
      const caps = await this.options.readCaps();
      this.noteMaxRuns(caps.maxRuns);
      this.noteIdleReclaimMinutes(caps.idleReclaimMinutes);
      return true;
    } catch (error) {
      this.options.log?.warn('remote agent pool: current reclaim policy unavailable; skipping release', { error: String(error) });
      return false;
    }
  }

  /** 按顺序试着让一个(候选在等待期间可能变忙，release 会放弃)。 */
  private async releaseNext(except?: PooledRemoteConnection): Promise<boolean> {
    for (const member of this.eligible(except)) {
      // 前一个候选让的时候这个可能刚有了活动。
      if (!this.isEligible(member)) continue;
      try {
        if (await member.release()) return true;
      } catch (error) {
        this.options.log?.warn('remote agent pool: release failed', { error: String(error) });
      }
    }
    return false;
  }

  /** 到水位线就按最久没活动让，直到降到水位线以下或没有有资格的。 */
  trim(): Promise<void> {
    return this.serial(async () => {
      for (;;) {
        const watermark = this.watermark();
        if (watermark === null || this.occupied() < watermark) return;
        if (!await this.refreshPolicy()) return;
        const currentWatermark = this.watermark();
        if (currentWatermark === null || this.occupied() < currentWatermark) return;
        if (!await this.releaseNext()) return;
        this.options.log?.info('remote agent pool: released an idle connection', { occupied: this.occupied(), maxRuns: this.maxRuns });
      }
    });
  }

  /**
   * 打开前(`self` 是正要打开的那个，已登记为占名额)：已满就先同步让一个；再在后台按水位线整理。
   * 没有有资格的也照常打开，对方才是最终裁判(本机计数可能不准：多实例、对方刚改了上限)。
   */
  async beforeOpen(self: PooledRemoteConnection): Promise<void> {
    await this.serial(async () => {
      // 自己让出时没关掉的旧 run：先关掉它再看名额。
      await this.closeHeld(self);
      if (this.maxRuns === null || this.occupied(self) < this.maxRuns) return;
      if (!await this.refreshPolicy() || this.maxRuns === null || this.occupied(self) < this.maxRuns) return;
      if (await this.releaseNext(self)) {
        this.options.log?.info('remote agent pool: made room before opening', { maxRuns: this.maxRuns });
      }
    });
    void this.trim();
  }

  /** 对方以名额已满拒绝了打开：先试着关掉自己没关掉的旧 run，否则让一个；腾出了就由调用方重试一次。 */
  releaseForRetry(self: PooledRemoteConnection): Promise<boolean> {
    return this.serial(async () => {
      const released = await this.closeHeld(self) || (await this.refreshPolicy() && await this.releaseNext(self));
      this.options.log?.info('remote agent pool: open rejected for capacity', { released, maxRuns: this.maxRuns });
      return released;
    });
  }
}
