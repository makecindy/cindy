/**
 * device-link 同机多实例单持有者仲裁(single-owner arbitration)。
 *
 * 问题:多个实例共享同一 userData(同 deviceId)时,relay 服务端对同
 * (userId, deviceId) 是 last-wins 顶号语义 —— 双活实例会无限互踢(4409 循环),
 * 手机端远程连接在实例间漂移("会话壳建在 A、消息发到 B、回传流丢失")。
 *
 * 方案:以共享 SQLite 的单行表 device_link_ownership 为互斥凭据,first-wins:
 *  - 最早认领成功的实例持有连接权(onAcquire → client.start())。
 *  - 其余实例保持被动:不发起 relay 连接,只按心跳节奏轮询持有者心跳。
 *  - 持有者每 heartbeatMs 用 CAS 续期;续期失败(被接管)立即降级(onDemote)。
 *  - 持有者心跳超过 staleMs 未续(卡死 / 崩溃 / 断电)→ 被动实例 CAS 接管。
 *  - 正常退出 / 登出走 stop() 释放行,幸存实例在下一轮 tick 内接管。
 *  - 单纯网络断线**不**让出持有权:同机的其它实例同样连不上,抢过去只会造成
 *    持有权无谓震荡;持有者保留权利,靠 client 自身的重连自愈。
 *
 * 有效性判定只依赖两条硬信号:心跳新鲜度(覆盖卡死 / 死机)与行是否存在
 * (覆盖正常退出 / 登出)。不用 PID 探活(Windows PID 复用不可靠),不做
 * 功能级健康探测(误判成本高于收益)。
 *
 * DB 访问走 DbClient(async):worker 接管后 main 侧 raw _db 会被释放
 * (bootstrap Phase 1.1),getRawDb() 在稳态不可用,因此 store 基于
 * DbClient.queryOne/exec 的异步接口,同时天然兼容 inproc fallback。
 *
 * 分层:本模块是纯 main 侧业务逻辑,store 依赖注入(可用内存实现单测),
 * packages/device-link 保持纯传输层不感知仲裁。
 */

import { randomUUID } from 'node:crypto';

import { createLogger } from '../logger';

const log = createLogger('device-link-ownership');

/** device_link_ownership 单行的读取投影 */
export interface OwnershipRow {
  ownerId: string;
  ownerPid: number;
  heartbeatAt: number;
}

/** 认领者自述(写入行的内容) */
export interface OwnershipIdentity {
  ownerId: string;
  ownerPid: number;
  ownerLabel: string | null;
}

/**
 * 仲裁凭据存取层。所有写操作都是原子 CAS(以 changes 计数判成败),
 * 由 SQLite 单文件写锁保证跨进程互斥。接口 async 以适配 DbClient(worker RPC)。
 */
export interface OwnershipStore {
  read(): Promise<OwnershipRow | null>;
  /** 行不存在时插入(INSERT OR IGNORE);返回是否成功成为持有者 */
  tryInsert(identity: OwnershipIdentity, now: number): Promise<boolean>;
  /** CAS 接管:仅当行仍是 expected 的 (ownerId, heartbeatAt) 时改写为自己 */
  tryTakeover(
    expected: { ownerId: string; heartbeatAt: number },
    identity: OwnershipIdentity,
    now: number,
  ): Promise<boolean>;
  /** 续期:仅当行仍属于 ownerId 时刷新心跳;失败即已被接管 */
  renew(ownerId: string, now: number): Promise<boolean>;
  /** 释放:仅删除仍属于 ownerId 的行(不许误删他人的持有权) */
  release(ownerId: string): Promise<void>;
}

export interface OwnershipArbiterOptions {
  /**
   * 取当前可用的 store;localDb / DbClient 未就绪(登录初期 / 登出关库竞态)
   * 返回 null 或 throw,该轮 tick 跳过,靠快速重试 / 下一轮自愈。
   */
  getStore: () => OwnershipStore | null;
  /** 实例描述(诊断字段);ownerId 由仲裁器生成并在每次 start() 轮换,不在此传入 */
  instance: { ownerPid: number; ownerLabel: string | null };
  /** 测试注入 ownerId 生成器,默认 randomUUID */
  newOwnerId?: () => string;
  /** 成为持有者(首次认领或接管成功)→ 宿主启动 relay 连接 */
  onAcquire: () => void;
  /** 失去持有权(续期 CAS 失败,行被他人接管)→ 宿主停止 relay 连接 */
  onDemote: () => void;
  /** 持有者续期间隔,默认 5s */
  heartbeatMs?: number;
  /** 心跳超过该时长未续视为持有者失效,默认 15s(须 > 2×heartbeatMs 留余量) */
  staleMs?: number;
  /**
   * store 不可用(DbClient 未就绪 / 表未迁移)时的快速重试间隔,默认 500ms。
   * 冷启动时 auth-authenticated 与 DbClient takeover 的到达顺序不固定,若只靠
   * heartbeatMs 节奏重试,首连最多被推迟一整拍(~5s);快速重试把这个窗口收敛到亚秒级。
   */
  storeRetryMs?: number;
  /**
   * 单次 store RPC 的超时,默认 = heartbeatMs。DbClient 传输层自身超时(30s)
   * 远大于 staleMs(15s):不设本地超时的话,一次挂起的 renew 会占住 tick 循环
   * 直到同伴接管后本实例还在线。超时只中止本轮判定(晚到的 CAS 结果由
   * reclaimed-own-row 分支自愈),持有者的安全兜底靠独立降级检查。
   */
  opTimeoutMs?: number;
  /** 测试注入时钟 */
  now?: () => number;
}

export const DEFAULT_HEARTBEAT_MS = 5_000;
export const DEFAULT_STALE_MS = 15_000;
export const DEFAULT_STORE_RETRY_MS = 500;

/** store RPC 超时的哨兵值(raceOpTimeout 返回) */
const OP_TIMEOUT = Symbol('op-timeout');

/**
 * 单持有者仲裁器。生命周期由宿主驱动:
 *  - start():登录后调用,开始参与仲裁(幂等)。
 *  - stop():登出 / 退出时调用,若持有则释放并回调 onDemote。
 * 内部单一定时器按 heartbeatMs 节奏 tick,持有者与被动实例共用同一节奏
 * (被动轮询更密没有收益,staleMs 才是接管延迟的主导项)。
 * tick 为 async(store 是 worker RPC):有 in-flight 防重入,慢 RPC 不会堆积。
 */
export class DeviceLinkOwnershipArbiter {
  private readonly opts: Required<
    Pick<OwnershipArbiterOptions, 'heartbeatMs' | 'staleMs' | 'storeRetryMs' | 'opTimeoutMs'>
  > &
    OwnershipArbiterOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * 当前生命周期的认领身份。每次 start() 轮换 ownerId:上一段生命周期
   * fire-and-forget 的 release 若在本段重新认领后才落盘,DELETE 按旧 ownerId
   * 匹配不到新行,不会误删刚认领的持有权。
   */
  private identity: OwnershipIdentity;
  /** start() 递增;in-flight tick 恢复后 epoch 不匹配视为已取消 */
  private epoch = 0;
  /** store 不可用时的一次性快速重试(见 storeRetryMs);store 恢复或 stop 时清除 */
  private storeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private owner = false;
  /** stop() 后置位:拦截 in-flight tick 在 await 之后继续改状态。初始未停(tick 只由 start() 的定时器或测试驱动)。 */
  private stopped = false;
  /** async tick 防重入:上一轮 RPC 未返回时跳过本轮 */
  private ticking = false;
  /** 当前 in-flight tick 的完成信号(stop() 需等它,才能收齐取消认领的补释放) */
  private inFlightTick: Promise<void> | null = null;
  /** 取消认领的补释放 promise 集合:stop() 返回值必须涵盖(见 stop 注释) */
  private pendingCancelReleases: Promise<void>[] = [];
  /**
   * 最近一次续期成功(或 promote)的时间。持有者若持续无法续期(store 不可用 /
   * renew 抛错)超过 staleMs - heartbeatMs,必须在同伴按 staleMs 判行过期**之前**
   * 自我降级停 client —— 否则同伴接管后本实例 client 还活着,4409 互踢卷土重来。
   */
  private lastRenewOkAt = 0;
  /** 已记录过日志的外部持有者,变化才再记(避免被动态每 5s 刷一行) */
  private loggedForeignOwnerId: string | null = null;

  constructor(options: OwnershipArbiterOptions) {
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    const storeRetryMs = options.storeRetryMs ?? DEFAULT_STORE_RETRY_MS;
    const opTimeoutMs = options.opTimeoutMs ?? heartbeatMs;
    if (staleMs <= heartbeatMs * 2) {
      // 心跳两拍以内就判失效会把 GC 停顿 / IO 抖动误判成死亡,直接拒绝错误配置
      throw new Error(`staleMs (${staleMs}) must be > 2 * heartbeatMs (${heartbeatMs})`);
    }
    this.opts = { ...options, heartbeatMs, staleMs, storeRetryMs, opTimeoutMs };
    this.identity = this.buildIdentity();
  }

  private buildIdentity(): OwnershipIdentity {
    return {
      ownerId: (this.opts.newOwnerId ?? randomUUID)(),
      ownerPid: this.opts.instance.ownerPid,
      ownerLabel: this.opts.instance.ownerLabel,
    };
  }

  isOwner(): boolean {
    return this.owner;
  }

  start(): void {
    if (this.timer) return;
    this.identity = this.buildIdentity(); // 轮换 ownerId,见字段注释
    this.epoch++;
    this.stopped = false;
    // 先建定时器再首 tick:首 tick 遇到 store 未就绪时,scheduleStoreRetry 以
    // this.timer 判断"已启动",顺序反了会漏掉冷启动的快速重试。
    this.timer = setInterval(() => {
      // 独立降级检查:不依赖 tick 推进(挂起的 RPC 会让 ticking 停留 true),
      // 用新鲜时钟保证持有者在同伴按 staleMs 判过期之前必然停 client。
      this.maybeSelfDemoteForRenewFailure((this.opts.now ?? Date.now)());
      void this.tick();
    }, this.opts.heartbeatMs);
    this.timer.unref?.();
    void this.tick();
  }

  /**
   * 停止参与仲裁;若当前持有则释放行(fire-and-forget:release 是 RPC,登出 /
   * 退出路径不宜阻塞;丢失时退化为等 staleMs 过期)并触发 onDemote(宿主据此停 client)。
   */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearStoreRetry();
    let released: Promise<void> = Promise.resolve();
    {
      // 无条件按当前 ownerId 释放(而非仅持有时):CAS 可能已落盘但本地尚未
      // promote(op 超时 / in-flight tick),owner 标志为 false 行却已是我们的。
      // DELETE WHERE owner_id = self 天然幂等,行不属于我们时是 no-op;且与
      // 在途 CAS 走同一 DbClient 传输队列(FIFO),晚到的认领会先于本条落盘。
      const store = this.safeGetStore();
      if (store) {
        released = store.release(this.identity.ownerId).catch((err) => {
          // 退出路径上 DbClient 可能已 dispose;释放失败退化为等心跳过期,不阻断退出
          log.warn('ownership release failed (fallback to stale expiry)', err);
        });
      } else if (this.owner) {
        log.warn('ownership release skipped: store unavailable (fallback to stale expiry)');
      }
    }
    if (this.owner) this.demote('stopped');
    // 返回 release 完成信号:登出路径需要在 dispose DbClient 前确保 DELETE 已落盘
    // (fire-and-forget 会跟 DbClient dispose 竞速);退出等尽力而为路径可不 await。
    // 必须先等 in-flight tick 收尾:它可能已经 CAS 认领成功但尚未返回,取消后的
    // 补释放(releaseCanceledClaim)要等它执行完才会出现在 pendingCancelReleases。
    const inFlight = this.inFlightTick ?? Promise.resolve();
    const cancelTail = inFlight
      .catch(() => undefined)
      .then(() => Promise.all(this.pendingCancelReleases))
      .then(() => undefined);
    return Promise.all([released, cancelTail]).then(() => undefined);
  }

  /** 单轮仲裁。异常一律吞掉留给下一轮,绝不让 DB 抖动打断定时器。 */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    const store = this.safeGetStore();
    if (!store) {
      if (this.owner) {
        // 持有者拿不到 store(DbClient 崩溃 / 长时间不可用):不能一直揣着 relay
        // 连接不放 —— 同伴会在 staleMs 后按过期接管,若本实例 client 还活着就
        // 回到 4409 互踢。超过自我降级期限(< staleMs)先停 client 保安全。
        this.maybeSelfDemoteForRenewFailure((this.opts.now ?? Date.now)());
      } else {
        // DB 未就绪:排一次快速重试,把冷启动首连延迟从一整拍收敛到亚秒级
        this.scheduleStoreRetry();
      }
      return;
    }
    this.clearStoreRetry();

    this.ticking = true;
    const run = this.runTick(store);
    this.inFlightTick = run;
    try {
      await run;
    } finally {
      if (this.inFlightTick === run) this.inFlightTick = null;
    }
  }

  private async runTick(store: OwnershipStore): Promise<void> {
    // 捕获本轮的身份与 epoch:await 期间可能发生 stop()+start()(身份已轮换),
    // 恢复后必须用捕获值判断取消并释放,不能用 this.identity(可能已是新身份)。
    const id = this.identity;
    const epoch = this.epoch;
    const canceled = (): boolean => this.stopped || this.epoch !== epoch;
    const now = (this.opts.now ?? Date.now)();
    try {
      if (this.owner) {
        const renewed = await this.raceOpTimeout(store.renew(id.ownerId, now));
        if (canceled()) return; // await 期间被 stop:行由 stop() 的 release 收口
        if (renewed === OP_TIMEOUT) {
          // 传输层挂起(其自身超时 30s > staleMs):中止本轮,安全性由定时器里的
          // 独立降级检查兜底(距上次续期成功超限即停 client)
          log.warn('ownership renew timed out locally, aborting round');
          return;
        }
        if (!renewed) {
          // 行被他人接管(如睡眠唤醒期间心跳过期被抢):安静让位,绝不抢回
          log.warn('ownership lost (heartbeat superseded), demoting');
          this.demote('superseded');
          return;
        }
        this.lastRenewOkAt = now;
        return;
      }

      const row = await this.raceOpTimeout(store.read());
      if (canceled()) return;
      if (row === OP_TIMEOUT) {
        log.warn('ownership read timed out locally, aborting round');
        return;
      }
      if (!row) {
        const insertPromise = store.tryInsert(id, now);
        const inserted = await this.raceOpTimeout(insertPromise);
        if (inserted === OP_TIMEOUT) {
          // CAS 可能晚落盘:活着则下一轮 read 走 reclaimed-own-row 自愈;
          // 若在那之前 stop,晚到的成功认领必须有人补释放,否则行滞留到 staleMs
          this.trackLateClaim(insertPromise, store, id.ownerId);
          log.warn('ownership tryInsert timed out locally, aborting round');
          return;
        }
        if (inserted) {
          // 认领窗口内被 stop:此时 this.owner 仍为 false,stop() 不会释放这条
          // 刚写入的行;不补释放的话它会以新鲜心跳滞留,幸存实例只能等 staleMs
          // 过期,抵消 onBeforeLogout 争取的秒级接管。
          if (canceled()) {
            this.releaseCanceledClaim(store, id.ownerId);
            return;
          }
          this.promote('claimed-empty');
        }
        return;
      }
      if (row.ownerId === id.ownerId) {
        // 自己的行但本地状态是被动(本 start 周期内 promote 前的重入窗口):续上并恢复持有
        const reclaimed = await this.raceOpTimeout(store.renew(id.ownerId, now));
        if (reclaimed === OP_TIMEOUT) {
          log.warn('ownership reclaim renew timed out locally, aborting round');
          return;
        }
        if (reclaimed) {
          if (canceled()) {
            this.releaseCanceledClaim(store, id.ownerId);
            return;
          }
          this.promote('reclaimed-own-row');
        }
        return;
      }
      if (this.loggedForeignOwnerId !== row.ownerId) {
        this.loggedForeignOwnerId = row.ownerId;
        log.info(
          `device-link owned by another instance (pid=${row.ownerPid}), standing by — this instance will not connect to relay`,
        );
      }
      if (now - row.heartbeatAt > this.opts.staleMs) {
        // 持有者失效(卡死 / 崩溃 / 断电);CAS 保证多个被动实例只有一个接管成功
        const takeoverPromise = store.tryTakeover(
          { ownerId: row.ownerId, heartbeatAt: row.heartbeatAt },
          id,
          now,
        );
        const takenRaw = await this.raceOpTimeout(takeoverPromise);
        if (takenRaw === OP_TIMEOUT) {
          // 晚落盘的接管:活着由下一轮 reclaimed-own-row 自愈;stop 前需登记补释放
          this.trackLateClaim(takeoverPromise, store, id.ownerId);
          log.warn('ownership takeover timed out locally, aborting round');
          return;
        }
        const taken = takenRaw;
        if (canceled()) {
          if (taken) this.releaseCanceledClaim(store, id.ownerId);
          return;
        }
        if (taken) this.promote(`takeover-stale(prev pid=${row.ownerPid})`);
        return;
      }
      // 持有者心跳新鲜 → 保持被动,不抢
    } catch (err) {
      log.warn('ownership tick failed (will retry next tick)', err);
      // 持有者续期持续抛错(如 DbClient worker 崩溃):与 store 不可用同栏,
      // 超过自我降级期限先停 client,避免同伴按 staleMs 接管后回到互踢。
      // 用新鲜时钟 —— 本轮的 now 是 await 之前捕获的,RPC 拖延后已经过时。
      this.maybeSelfDemoteForRenewFailure((this.opts.now ?? Date.now)());
    } finally {
      this.ticking = false;
    }
  }

  /**
   * 持有者续期失败链的自我降级期限:staleMs - heartbeatMs,严格早于同伴判定
   * 行过期的 staleMs(构造器保证 staleMs > 2×heartbeatMs,余量 ≥ 一拍),
   * 确保同伴接管上线时本实例 client 已停,不产生双连接互踢。
   */
  private maybeSelfDemoteForRenewFailure(now: number): void {
    if (!this.owner) return;
    if (now - this.lastRenewOkAt <= this.opts.staleMs - this.opts.heartbeatMs) return;
    log.warn(
      'ownership renew unreachable beyond safety margin, self-demoting before peers treat row as stale',
    );
    this.demote('renew-unreachable');
  }

  /** 认领窗口内被 stop()/重启:刚写成功的行立刻补一次释放,避免遗留新鲜心跳的孤儿行 */
  private releaseCanceledClaim(store: OwnershipStore, ownerId: string): void {
    // 记入 pendingCancelReleases:stop() 的返回值必须涵盖这条 DELETE,否则登出 /
    // 退出路径可能在它落盘前就 dispose DbClient,新鲜行滞留到 staleMs 才被接管
    const released = store.release(ownerId).catch((err) => {
      log.warn('ownership release of canceled claim failed (fallback to stale expiry)', err);
    });
    this.pendingCancelReleases.push(released);
  }

  /**
   * store RPC 加本地超时:超时返回 OP_TIMEOUT 哨兵,本轮判定中止。
   * 晚到的结果无需善后 —— Promise.race 已订阅原 promise(rejection 不会变成
   * unhandled),晚落盘的 CAS 由下一轮 reclaimed-own-row 分支自愈。
   */
  private raceOpTimeout<T>(p: Promise<T>): Promise<T | typeof OP_TIMEOUT> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof OP_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(OP_TIMEOUT), this.opts.opTimeoutMs);
      timer.unref?.();
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * 登记一条本地超时后仍在途的 CAS 认领:settle 后若实例已停止 / 身份已轮换,
   * 晚到的成功认领要补释放(否则行以本轮 ownerId 滞留到 staleMs);实例仍活着且
   * 身份未变则不动,留给下一轮 reclaimed-own-row 正常接管。整条链记入
   * pendingCancelReleases,stop() 的返回值会等它 settle。
   */
  private trackLateClaim(claim: Promise<boolean>, store: OwnershipStore, ownerId: string): void {
    const settled = claim
      .then((ok) => {
        if (!ok) return undefined;
        if (this.stopped || this.identity.ownerId !== ownerId) {
          return store.release(ownerId).catch((err) => {
            log.warn('late claim release failed (fallback to stale expiry)', err);
          });
        }
        return undefined;
      })
      .catch(() => undefined)
      .then(() => undefined);
    this.pendingCancelReleases.push(settled);
  }

  private safeGetStore(): OwnershipStore | null {
    try {
      return this.opts.getStore();
    } catch {
      return null;
    }
  }

  private scheduleStoreRetry(): void {
    if (this.storeRetryTimer || !this.timer) return; // 已排队 / 未 start
    this.storeRetryTimer = setTimeout(() => {
      this.storeRetryTimer = null;
      void this.tick();
    }, this.opts.storeRetryMs);
    this.storeRetryTimer.unref?.();
  }

  private clearStoreRetry(): void {
    if (this.storeRetryTimer) {
      clearTimeout(this.storeRetryTimer);
      this.storeRetryTimer = null;
    }
  }

  private promote(reason: string): void {
    this.owner = true;
    this.lastRenewOkAt = (this.opts.now ?? Date.now)();
    log.info(`became device-link owner (${reason})`);
    try {
      this.opts.onAcquire();
    } catch (err) {
      log.error('onAcquire callback failed', err);
    }
  }

  private demote(reason: string): void {
    this.owner = false;
    log.info(`no longer device-link owner (${reason})`);
    try {
      this.opts.onDemote();
    } catch (err) {
      log.error('onDemote callback failed', err);
    }
  }
}

// ─── DbClient store 实现 ──────────────────────────────────────────────────────

/**
 * store 需要的最小 DB 访问面(DbClient 的结构子集):worker 接管后 main 侧
 * raw _db 已释放,必须走 DbClient 的 async RPC;inproc fallback 模式下
 * DbClient 内部仍用 main 侧连接,两种模式同一接口。
 */
export interface OwnershipDbAccess {
  queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined>;
  exec(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

/**
 * 基于 DbClient 的 store。全部走原子单语句,依赖 SQLite 单文件写锁做跨进程
 * 互斥;不开显式事务(单语句已原子)。语句编译缓存由 worker 端负责,这里
 * 无 per-store 状态,但调用方仍应按 DbClient 实例缓存复用,避免每 tick 建对象。
 */
export function createDbClientOwnershipStore(db: OwnershipDbAccess): OwnershipStore {
  return {
    async read(): Promise<OwnershipRow | null> {
      const row = await db.queryOne<{ owner_id: string; owner_pid: number; heartbeat_at: number }>(
        'SELECT owner_id, owner_pid, heartbeat_at FROM device_link_ownership WHERE id = 1',
      );
      if (!row) return null;
      return { ownerId: row.owner_id, ownerPid: row.owner_pid, heartbeatAt: row.heartbeat_at };
    },
    async tryInsert(identity, now): Promise<boolean> {
      const r = await db.exec(
        'INSERT INTO device_link_ownership (id, owner_id, owner_pid, owner_label, heartbeat_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
        [identity.ownerId, identity.ownerPid, identity.ownerLabel, now],
      );
      return r.changes > 0;
    },
    async tryTakeover(expected, identity, now): Promise<boolean> {
      const r = await db.exec(
        'UPDATE device_link_ownership SET owner_id = ?, owner_pid = ?, owner_label = ?, heartbeat_at = ? WHERE id = 1 AND owner_id = ? AND heartbeat_at = ?',
        [
          identity.ownerId,
          identity.ownerPid,
          identity.ownerLabel,
          now,
          expected.ownerId,
          expected.heartbeatAt,
        ],
      );
      return r.changes > 0;
    },
    async renew(ownerId, now): Promise<boolean> {
      const r = await db.exec(
        'UPDATE device_link_ownership SET heartbeat_at = ? WHERE id = 1 AND owner_id = ?',
        [now, ownerId],
      );
      return r.changes > 0;
    },
    async release(ownerId): Promise<void> {
      await db.exec('DELETE FROM device_link_ownership WHERE id = 1 AND owner_id = ?', [ownerId]);
    },
  };
}
