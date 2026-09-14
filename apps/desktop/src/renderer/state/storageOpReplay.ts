/**
 * storageOpReplay —— `modelFavorites` 与 `modelEnginePrefs` 两个 localStorage store 的
 * **跨 renderer 并发一致性**小工具。刻意只服务这两个文件,不做成通用存储框架:它依赖
 * 「写操作能表达成可重放且幂等的 op」这一前提,而那是那两个 store 自己的设计约束。
 *
 * 要解决的问题(2026-08-17 review H1 / K1 / K2):
 *   两个 store 都是**整表写回**。「写前重读 localStorage」只能修「另一窗口先写完、事件还没
 *   到」那一路;两个 renderer 若**都在对方写回之前**读了同一份旧快照,后写者仍然整表覆盖
 *   先写者 —— 新增丢失、编辑丢失,删除与编辑交错时已删的条目还会复活。localStorage 没有
 *   CAS,同进程 JS 单线程,但**跨 renderer 进程**的 getItem / setItem 可以任意交错,所以
 *   「重读 → 应用 → 整表写」这三步在跨窗口视角下不是原子的。
 *
 *   上一轮的做法是「同步乐观写 + 提交后在 Web Lock 里重放**自己这一个 op**」。它挡不住两类
 *   真实交错:
 *     · K1 —— 重放回调执行前用户登出 / 切号,回调里「当前 storageKey ≠ 捕获的 key」就整个
 *       放弃,旧分区的并发丢写永远没人再合并;
 *     · K2 —— 另一窗口在**申请锁之前**就用旧基底 persist 了(顺序:B 读旧基底 → A 同步写 +
 *       锁内重放完成 → B 才 persist 并申请锁),B 的重放只看到自己刚覆盖出来的状态,A 的 op
 *       无从恢复。一次性重放没有任何机会发现这种「迟到覆盖」。
 *
 * 机制 —— **同步乐观写 + 每 key 会话 op-log + 事件驱动的持续调和**:
 *   1. **同步乐观写保留**(不能放弃:热更 relaunch 走 `app.exit()` 强退,纯异步写会丢掉最近
 *      一次改动)。它可能制造的脏覆盖交给下面的闭环矫正;
 *   2. 每次 commit 把 op 追加进**当时那个 storage key** 的会话 op-log(模块级 Map,进程内存);
 *   3. `reconcile(key)` 在 `navigator.locks` 的 `lock(key)` 内跑:按 **key 本身**读原始
 *      localStorage → 依序重放该 key 的**整条 op-log** → 有差异才 setItem。**不管当前 active
 *      owner 是谁**(K1 修复点):调和按捕获的 key 自洽运行,登出 / 切号后旧分区的 log 继续有效;
 *      仅当 key 恰好是当前 active 分区时才顺带刷新缓存 / 通知(config.persist / config.adopt
 *      由 store 侧按 key 自行判断);
 *   4. 触发时机两处:a) 每次 commit 后;b) **storage 事件** —— 两个 store 的监听器都从「只认
 *      当前 active key」放宽为「凡是 op-log 里有记录的 key 都认」。这是 K2 的收敛闭环:任何
 *      迟到脏写抹掉本窗的 op,都会以 storage 事件的形式到达本窗,本窗随即在锁内把自己的
 *      op-log 重新施加到最新状态上 —— 被抹的 op 被重新断言,删除也是 op、同样重新断言;
 *      无差异即不写,调和自然终止;
 *   5. 同一 key 的调和**合并调度**:在途一个即可,结束后若期间又来过事件再跑一轮。调和自己的
 *      setItem 会触发别窗的 storage 事件,但别窗无差异就不写,不会形成写风暴。
 *
 * op 必须**只依赖 op 自身 + 目标状态**(不能捕获提交时的快照)且**幂等**(add 按身份去重 /
 * update 未命中 no-op / remove 幂等 / seed 有门 / set-clear 同值短路),否则「同步写 + 若干次
 * 重放」会做出第二份效果。`apply` 无变化时**必须返回入参对象本身** —— 这里靠引用判等决定
 * 「要不要落盘」和「这个 op 这一轮是不是真的断言了什么」。
 *
 * ── 为什么 op 会退休(终止性 + 「本窗别跟用户较劲」)────────────────────────────
 * 「有差异就重新断言」单独成立会**活锁**:窗口 A 的 log 里有 `add X`、窗口 B 的 log 里有
 * `remove X`(用户就是先在 A 里收藏、再到 B 里删掉的),两边各自收到对方的写入事件后会无限
 * 互相翻转。localStorage 没有版本号 / CAS,本窗**拿不到**「对方那笔写是不是比我新」的因果
 * 信息 —— 「别窗用旧基底把我的写抹了」和「别窗的用户明确改掉了我写的那一条」在本地是同一
 * 幅画面。唯一可用的判据是**时间**:前者是并发交错,别窗那笔写早就在路上,毫秒级就落地;
 * 后者要等别窗收到事件、重绘、用户看见再动手,量级是秒。所以退休条件是两条保守上界:
 *   · `OP_TTL_MS` —— op 只在录入后的这段「并发窗口」内参与调和。窗口之外的相反写入按用户的
 *     新动作对待,不再去覆盖它(否则本窗就是在跟用户较劲)。
 *   · `MAX_ASSERTIONS` —— 一个 op **真的改变了状态**(被重新断言)几次之后出局。健康的 K2
 *     修复只需要 1 次;需要第 4 次,说明对面在持续反向断言 —— 那是活锁,不是丢写。
 * 两条都用尽后 op 出局,状态由最后一次写入定,与改动前的「最后写者胜」一致。
 *
 * 并发窗口**之内**的相反动作(A 刚收藏、B 立刻删掉)只能靠一条约定收口,不能靠因果:
 * **删除类 op 活得更久**(`config.tombstone`,TTL 与断言次数都翻倍)。方向刻意不对称 ——
 * 「已删条目复活」是用户不会去复查的静默错误(H1 的原始 review 就点了这条),而「删早了」
 * 用户当场看得见、再收藏一次即可。所以冲突时让删除胜出。
 *
 * ── 残余边界(理论下界,已知取舍)────────────────────────────────────────────
 *   · **op-log 在内存里**:本窗在「别窗迟到脏写落盘之后、收到对应 storage 事件之前」整个进程
 *     退出,则该 op 再无人断言,可能永久丢失。localStorage 无 CAS,在不引入磁盘 op 日志的前提
 *     下这是理论下界;窗口极窄 —— 需要「两窗交错 + 脏写已落盘 + 事件未到 + 进程退出」三件事
 *     同时发生,量级是毫秒。
 *   · 超出 TTL / 断言次数上界之后的冲突不再合并(见上一节),回到「最后写者胜」。
 *   · `MAX_OPS_PER_KEY` 满了按 FIFO 丢最老的:一次会话里对同一分区做上百次写才会碰到,丢掉的
 *     是最早那些(它们的并发窗口早就过去了),留下的是最近的 —— 与 TTL 同向的取舍。
 *
 * 退化路径:`navigator.locks` 不存在(旧环境 / 单测的 node env)时**跳过调和**,行为退回
 * 「重读基底 + 整表写回」,不劣化、不抛错。与 analytics/tapdbClient 里 Web Locks 的既有取舍
 * 一致(受控 Electron Chromium 提供该 API,缺失时走退化路径而不是阻断主流程)。
 *
 * 锁名 = 该 store 的 **storage key**(含 dataOwnerId 分区后缀):不同账号分区各排各的队,
 * 互不阻塞;同一分区的所有 renderer 排同一条队。
 */

/**
 * op 参与调和的「并发窗口」。取值取舍见文件头「为什么 op 会退休」:别窗的迟到脏写是毫秒级
 * 就落地的(它那笔 setItem 早在路上),2s 足够宽;而另一个窗口的用户要看见本窗的改动再动手,
 * 至少要一个事件往返 + 人的反应时间,基本落在窗口之外。
 */
const OP_TTL_MS = 2_000;

/** 一个 op 最多真的改变状态(被重新断言)这么多次,之后出局。见文件头。 */
const MAX_ASSERTIONS = 3;

/** 删除类 op 的寿命倍数(见文件头:并发窗口内相反动作让删除胜出)。 */
const TOMBSTONE_LIFETIME_FACTOR = 3;

/** 每个 key 的会话 op-log 容量上限;满了按 FIFO 丢最老的(见文件头残余边界)。 */
const MAX_OPS_PER_KEY = 100;

interface LoggedOp<Op> {
  op: Op;
  /** 录入时刻(`Date.now()`),用于 TTL 退休。 */
  recordedAt: number;
  /** 这个 op **真的改变了状态**的次数(引用判等口径),用于活锁上界。 */
  assertions: number;
}

export interface StorageReconcilerConfig<S, Op> {
  /**
   * 按 **key 本身**读原始 localStorage 并归一化(不读缓存、不写缓存)。key 可能不是当前
   * active 分区(登出 / 切号后旧分区仍要调和)。
   */
  read: (key: string) => S;
  /** 施加一个 op;**无实际变化时必须返回入参对象本身**。 */
  apply: (state: S, op: Op) => S;
  /** 有差异 → 落盘到该 key;key 恰是 active 分区时由 store 侧顺带刷新缓存并通知。 */
  persist: (key: string, state: S) => void;
  /** 无差异 → 把这份权威状态收进缓存(仅当 key 是 active 分区;store 侧自行判断)。 */
  adopt: (key: string, state: S) => void;
  /**
   * 新 op 与已有 log 的归并(可选,默认直接追加)。目的是让整条 log 的重放保持幂等 ——
   * 例:同一条收藏的 `add` + 后续 `update` 必须折成一个「最终配置的 add」,否则重放会在
   * 已经是新配置的状态上再插一条旧配置的副本。返回的数组里**沿用原 op 对象**的条目会保留
   * 它的录入时刻与断言计数,新对象则按新录入处理。
   */
  compact?: ((log: readonly Op[], op: Op) => readonly Op[]) | undefined;
  /**
   * 这个 op 是不是**删除类**(收藏的 remove / override 的 clear)。删除类 op 的 TTL 与断言
   * 次数上界都乘以 `TOMBSTONE_LIFETIME_FACTOR` —— 并发窗口内两窗做相反动作时让删除胜出
   * (理由见文件头)。不给则一律按普通 op 处理。
   */
  tombstone?: ((op: Op) => boolean) | undefined;
}

export interface StorageReconciler<Op> {
  /** 把一次提交的 op 记进该 key 的会话 log(不触发调和)。 */
  record: (key: string, op: Op) => void;
  /** 调度一次该 key 的调和(在途则合并成「结束后再跑一轮」);log 为空或锁不可用时 no-op。 */
  schedule: (key: string) => void;
  /** 该 key 是否还有有效 op —— storage 监听器用它判断「这个 key 我认不认」。 */
  hasOps: (key: string) => boolean;
  /** 当前还有有效 op 的所有 key(`storage.clear()` 事件要对它们逐个调和)。 */
  loggedKeys: () => string[];
  /** 测试用 —— 清空全部 op-log 与在途调度。 */
  __resetForTest: () => void;
}

function lockManager(): LockManager | undefined {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  return locks && typeof locks.request === 'function' ? locks : undefined;
}

export function createStorageReconciler<S, Op>(
  config: StorageReconcilerConfig<S, Op>,
): StorageReconciler<Op> {
  /** 每个 storage key 一条会话 op-log(模块级 = 每个 renderer 一份)。 */
  const logs = new Map<string, Array<LoggedOp<Op>>>();
  /** 该 key 的调和正在锁里跑。 */
  const inflight = new Set<string>();
  /** 在途期间又来了触发 → 结束后补跑一轮(合并成一次,不排队堆积)。 */
  const rerun = new Set<string>();

  /** 该 op 的寿命倍数(删除类更长,见文件头)。 */
  function lifetimeFactor(op: Op): number {
    return config.tombstone?.(op) === true ? TOMBSTONE_LIFETIME_FACTOR : 1;
  }

  /** 丢掉过期 / 断言次数用尽的 op;返回该 key 现存的 log。 */
  function prune(key: string): Array<LoggedOp<Op>> {
    const log = logs.get(key);
    if (!log) return [];
    const now = Date.now();
    const alive = log.filter((entry) => {
      const factor = lifetimeFactor(entry.op);
      return (
        now - entry.recordedAt < OP_TTL_MS * factor
        && entry.assertions < MAX_ASSERTIONS * factor
      );
    });
    if (alive.length === log.length) return log;
    if (alive.length === 0) {
      logs.delete(key);
      return [];
    }
    logs.set(key, alive);
    return alive;
  }

  function record(key: string, op: Op): void {
    const log = prune(key);
    const plain = log.map((entry) => entry.op);
    const compacted = config.compact ? config.compact(plain, op) : [...plain, op];
    // 归并后沿用原 op 对象的条目保留原有录入时刻 / 断言计数;被换成新对象的(如 update 折进
    // add)按「刚录入」重新计时 —— 用户刚做过的那一下理应重新获得完整的调和有效期。
    const existing = new Map<Op, LoggedOp<Op>>();
    for (const entry of log) existing.set(entry.op, entry);
    const now = Date.now();
    let next = compacted.map(
      (o) => existing.get(o) ?? { op: o, recordedAt: now, assertions: 0 },
    );
    if (next.length > MAX_OPS_PER_KEY) next = next.slice(next.length - MAX_OPS_PER_KEY);
    if (next.length === 0) logs.delete(key);
    else logs.set(key, next);
  }

  /**
   * 锁内的一次调和:按 key 读原始状态 → 重放整条 op-log → 有差异才写。
   * 全程**不看当前 active owner**(K1):调和按捕获的 key 自洽运行。
   */
  function reconcileNow(key: string): void {
    const log = prune(key);
    if (log.length === 0) return;
    let state: S;
    try {
      state = config.read(key);
    } catch {
      // 读不出来(storage 被禁 / 解析炸)→ 这一轮什么都不做,留给下一次事件。
      return;
    }
    const base = state;
    for (const entry of log) {
      let next: S;
      try {
        next = config.apply(state, entry.op);
      } catch {
        continue;
      }
      if (next === state) continue;
      // 这个 op 在这一轮真的断言了点什么 —— 计入活锁上界(见文件头)。
      entry.assertions += 1;
      state = next;
    }
    if (state !== base) config.persist(key, state);
    else config.adopt(key, state);
    // 断言次数刚用尽的 op 立刻出局,别等下一次事件。
    prune(key);
  }

  function schedule(key: string): void {
    if (prune(key).length === 0) return;
    if (inflight.has(key)) {
      rerun.add(key);
      return;
    }
    const locks = lockManager();
    // 锁不可用 → 跳过调和(退化路径,见文件头)。
    if (!locks) return;
    inflight.add(key);
    const finish = (): void => {
      inflight.delete(key);
      if (rerun.delete(key)) schedule(key);
    };
    let request: Promise<unknown>;
    try {
      request = Promise.resolve(
        locks.request(key, () => {
          try {
            reconcileNow(key);
          } catch {
            // 调和失败 = 保持同步写的结果,不该把用户当次操作变成一个报错。
          }
        }),
      );
    } catch {
      // navigator.locks 存在但调用即抛(受限上下文):按不可用处理。
      inflight.delete(key);
      return;
    }
    void request.then(finish, finish);
  }

  return {
    record,
    schedule,
    hasOps: (key) => prune(key).length > 0,
    loggedKeys: () => [...logs.keys()].filter((key) => prune(key).length > 0),
    __resetForTest: () => {
      logs.clear();
      inflight.clear();
      rerun.clear();
    },
  };
}
