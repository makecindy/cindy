/**
 * codex-model-backfill —— 为「已登录但无模型」的 Codex 用户主动补拉一次 live 模型。
 *
 * 背景:`ba831a9e` 让 Codex **OAuth 新登录动作**在收口时主动调 `model/list`(不跑 session)
 * 发现模型。但它只覆盖「登录那一下」——存量已登录用户(app 启动即是登录态、从不重新登录)
 * 不触发该收口,只能靠启动时读 `~/.codex/models_cache.json`;而 codex CLI 只在跑过会话后才写
 * 该 cache,于是「已登录 + 从没跑过 codex 会话」的用户 discoveredCodex 恒空,OpenAI 供应商
 * 无任何模型,直到手动跑一次会话。
 *
 * 本模块补上这个缺口:若 Codex 已登录且当前无 codex 模型,fire-and-forget 触发一次和登录
 * 收口同源的 live 拉取(`maker.refreshAgentLocalModels('codex')`),成功即广播 PROVIDER_CHANGED
 * 让设置页刷新。纯函数 + 注入 deps,不碰 maker-core 热路径。
 *
 * **为什么需要 coordinator 而不只是一次性调用**:补拉原先只挂在 maker 首次构造后,而首启那
 * 一刻「本机已有 ChatGPT 凭证」的 owner 绑定往往还没认领完(绑定自愈挂在异步 reconcile 收口),
 * `hasCodexLogin()` 返回 false → 一次性机会被 `skipped-unauthed` 消费掉,此后再无补拉,
 * ChatGPT 订阅的模型清单要等用户打开设置页 / 模型选择器才出现(全新机器首启的实际表现)。
 * coordinator 把「没试过」与「试过没成」分开记账:未授权不消费机会,授权就绪后由 auth 事件
 * 再次驱动;真跑过 app-server 的失败才计入尝试次数并最终封顶,避免无授权抖动导致反复 spawn。
 */

export interface CodexBackfillDeps {
  /** Codex 是否已 OAuth 登录(未登录不拉——没凭证 app-server 也起不来)。 */
  hasCodexLogin(): Promise<boolean>;
  /** 当前 catalog 是否已有 codex 模型(非空则无需补拉,避免重复 spawn app-server)。 */
  hasCodexModels(): boolean;
  /** live 拉取(生产 = maker.refreshAgentLocalModels('codex')),返回是否成功注入。 */
  refreshLive(): Promise<boolean>;
  /** 成功注入后回调(生产 = 广播 PROVIDER_CHANGED 让 renderer refetch)。 */
  onApplied(): void;
  log: { info(msg: string): void; warn(msg: string, meta?: Record<string, unknown>): void };
}

export type CodexBackfillOutcome =
  | 'skipped-unauthed'
  | 'skipped-has-models'
  | 'applied'
  | 'not-applied'
  | 'error'
  /** 真跑过 app-server 但连续失败到封顶,交给用户手动刷新 / 跑一次会话。 */
  | 'skipped-exhausted';

/**
 * 补拉决策:未登录 / 已有模型直接跳过;否则 live 拉取,applied 则广播。任何异常吞掉记日志
 * (启动增强,绝不能因它抛错影响 maker 就绪 / 启动)。
 */
export async function maybeBackfillCodexModels(deps: CodexBackfillDeps): Promise<CodexBackfillOutcome> {
  try {
    if (!(await deps.hasCodexLogin())) return 'skipped-unauthed';
    // 已有模型(启动读磁盘 cache 命中,或其它路径已注入)→ 不重复起 app-server。
    if (deps.hasCodexModels()) return 'skipped-has-models';
    const applied = await deps.refreshLive();
    if (applied) {
      deps.onApplied();
      deps.log.info('startup codex model backfill: live model/list applied');
      return 'applied';
    }
    // live 未 applied(app-server 起不来 / RPC 无结果):不广播,等用户跑一次会话或手动重试。
    deps.log.warn('startup codex model backfill: live model/list not applied');
    return 'not-applied';
  } catch (e) {
    deps.log.warn('startup codex model backfill threw', {
      error: e instanceof Error ? e.message : String(e),
    });
    return 'error';
  }
}

/** 真跑过 app-server 的失败尝试上限;未授权跳过不计入。 */
export const CODEX_MODEL_BACKFILL_MAX_LIVE_ATTEMPTS = 3;

export interface CodexModelBackfillCoordinator {
  /**
   * 评估并(必要时)执行一次补拉。并发调用复用同一次在途拉取——补拉会 spawn
   * codex app-server,几个 auth 事件同时到达时绝不能各起一个。
   */
  request(): Promise<CodexBackfillOutcome>;
  /**
   * 作废当前这一代:清失败计数,并让**已在途**的那次拉取不再写回目录。
   * **只在 auth 边界真的变了时调**(登录 / 登出 / 换账号 / 凭证失效):新边界下
   * 「上个账号试过几次都不成」这个结论不再适用,上个账号的拉取结果更不能落地。
   */
  reset(): void;
}

/**
 * 把一次性的补拉包成可按事件重试的收口。
 *
 * 记两件事:
 *   - `liveAttempts`:真起过(或试图起过)app-server 的失败次数,封顶后停手,避免反复 spawn;
 *   - `generation`:auth 边界的代号,`reset()` 递增。在途拉取回来时若代号已变,**不广播、
 *     不计额度**。
 *
 * **代号管的不是目录写入**(容易误读,PR #1076 review 三轮都绕着这点):目录写入发生在
 * `refreshLive()` 内部 —— agent 的 `onCodexLocalModelsListed` 回调,在 promise resolve
 * **之前**就跑完了,本模块没有任何介入点。挡住跨边界写入的判据在 maker-core:CodexAgent 把
 * model/list 结果交给宿主前会校验 `this.hosts.get(key) !== host`,所以只要 auth 边界收口
 * **退役了旧 host**,迟到响应就压根不会调回调。四条收口路径(登出 / 登录 / 凭证失效 /
 * auth 模式切换)现在都退役 host,这条不变量由那一处判据统一保证 —— 不要在写入侧再加第二层
 * 闸门,那既是重复判据,也挡不住真正的问题(试过,见 review 第二、三轮)。
 *
 * 这里的代号只管两件**本模块自己**的事:广播(`onApplied` —— 不为一次已被 host 校验挡掉的
 * 写入白广播一轮)与失败额度的归属(旧边界的失败不该扣新边界的重试次数)。
 *
 * 刻意**不缓存「已经拉到了」**:清单在场与否每次都现查 catalog(`hasCodexModels`),因为它
 * 随时会被 auth 边界收口清空(登出、cache miss 回退),缓存成终态会让清空之后再也拉不回来。
 * `skipped-unauthed` 不计入失败 —— 它意味着「还没资格试」,不该消费任何重试额度,这正是首启
 * 那次被白白跳过的原因。
 */
export function createCodexModelBackfillCoordinator(
  deps: CodexBackfillDeps,
  maxLiveAttempts = CODEX_MODEL_BACKFILL_MAX_LIVE_ATTEMPTS,
): CodexModelBackfillCoordinator {
  let liveAttempts = 0;
  let inflight: Promise<CodexBackfillOutcome> | null = null;
  let generation = 0;

  return {
    request(): Promise<CodexBackfillOutcome> {
      if (liveAttempts >= maxLiveAttempts) return Promise.resolve('skipped-exhausted');
      if (inflight) return inflight;
      const startedAt = generation;
      // onApplied 在 deps 里包一层代号校验:广播必须与「结果是否该落地」同一个判据,
      // 否则会出现「目录没更新但 renderer 收到了 PROVIDER_CHANGED」这种半落地状态。
      const flight = maybeBackfillCodexModels({
        ...deps,
        onApplied: () => {
          if (generation !== startedAt) {
            deps.log.warn('codex model backfill result dropped: auth boundary changed mid-flight');
            return;
          }
          deps.onApplied();
        },
      })
        .then((outcome) => {
          // 换代后的结果不再计入这一代的失败额度:新边界要有完整的重试机会。
          if (generation !== startedAt) return outcome;
          // not-applied / error 都真起过(或试图起过)app-server,计入封顶;
          // applied / has-models 是成功路径;skipped-unauthed 根本没试。
          if (outcome === 'not-applied' || outcome === 'error') liveAttempts += 1;
          return outcome;
        })
        .finally(() => {
          if (inflight === flight) inflight = null;
        });
      inflight = flight;
      return flight;
    },
    reset(): void {
      liveAttempts = 0;
      // 递增代号即作废在途那次的写回权;inflight 置 null 只是让下一次 request 能立刻起新的。
      generation += 1;
      inflight = null;
    },
  };
}
