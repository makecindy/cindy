/**
 * compaction-storm — codex 上下文压缩不收敛时的终局升级。
 *
 * 背景 (2026-08-04 实测): 会话中途切模型后, codex 上报的 `modelContextWindow`
 * 不随 `thread/settings/update` 更新 —— 整个会话始终按**切换前**那个模型的窗口
 * 判定是否超窗。新模型的窗口更大时, 网关侧请求完全成功 (上游吃得下), 但 codex
 * 本地仍判「超窗」→ 压缩 → 重建后还是同样大小 → 再压缩, 形成无限循环。实测
 * 26 分钟内 9 次压缩, 后 8 次每 31–54 秒一次, 直到用户手动切走 harness 才停。
 *
 * 关键在于**这种状态下压缩不可能收敛**: 每次压完对话历史只剩个位数条消息
 * (实测最少 4 条 / 7481 字符), 膨胀的部分全在 system prompt 与 MCP 工具定义里,
 * 压缩机制根本碰不到那部分。继续压下去只是重复烧同样的 input。
 *
 * 判据刻意**不看窗口值**, 只看压缩自身的效果: 压完之后上下文水位有没有实质下降。
 * 用窗口做判据会在两个方向上都出错 —— 上游报的窗口本身就是陈旧的 (这正是病因),
 * 而 Cindy 已核实的窗口 (capContextWindow) 又是新模型的真实值, 按它算「326K 没超
 * 1M 窗口」根本不会触发, 可 codex 那边照压不误。「压了等于没压」是这个故障唯一
 * 稳定可观测的特征, 也与病因无关地覆盖了其它压不动的情形。
 *
 * retry-escalation.ts 是同一模式的另一个实例 (上游无限重试 → 本地合成终态错误 +
 * 可操作诊断); 两者共用 index.ts 的 onUpstreamIdleTimeout 收口路径。
 */

/** 连续多少次「压了等于没压」判定为风暴。实测每次压缩间隔 31–54s, 3 次约 2 分钟。 */
export const COMPACTION_STORM_MAX_INEFFECTIVE = 3;

/**
 * 压缩后水位相对**同一次压缩之前**那条水位, 至少要降到这个比例才算有效。
 *
 * **比的是同一次压缩的 pre → post, 不是「本次 post 与上一次 post」** (2026-08-05
 * 修正, Codex review): 后者会误杀正常长会话 —— 一个长 autonomous turn 里合法地
 * 压缩很多次, 每次压完都回到相近的 floor (30k / 31k / 29k / 32k), 那是压缩**正常
 * 工作**的样子, 却会被"post 必须比上一个 post 更低"的要求连判无效, 累计几次后中断
 * 一个健康的 turn。post 之间本来就不该被要求单调下降。
 *
 * pre 取「压缩边界前最后一条有效 usage」—— 实测那正是 codex 为生成摘要而发起的
 * 那次调用, 输入即当时的完整历史, 所以 pre→post 的物理意义很干净:
 * **把 pre 那么大的历史压成摘要之后, 总量变成了多少**。
 *
 * 实测两类的分离度 (rollout 019fcd52):
 *   - 正常压缩: pre=241972 → post=30738, 比值 12.7%          → 有效
 *   - 风暴期:   pre=32283 → post=325868, 比值 1009%           → 无效
 *               pre=30544 → post=325922, 比值 1067%           → 无效
 *     (历史已经压到底了 —— pre 只剩 30k, 而 post 仍有 326k, 膨胀全在 system prompt
 *      与工具定义里, 压缩碰不到那部分。这正是"压了等于没压"的本质。)
 * 0.9 把两类分得极开, 不需要精调。
 */
export const COMPACTION_STORM_EFFECTIVE_DROP_RATIO = 0.9;

/**
 * 压缩边界之后, 最多跳过这么多条**非正值** usage 去找真正的压缩后水位。
 *
 * 实测 codex 在每个 contextCompaction 之后紧跟一条 `last.inputTokens = 0` 的
 * usage (压缩完成标记), 15:28 那次连发了两条, 之后才是压缩后第一个正常请求的水位。
 * 把这些 0 当成"压缩后水位"会让判据永远读不到真实的 post —— 熔断彻底失效。
 *
 * 但也不能无界等待: 压缩后若 turn 就此结束、再没有 usage, 标志会一直挂着, 下一个
 * turn 里一条普通 usage 就会被冒名顶替成 post。有界跳过同时满足这两件事。
 */
export const COMPACTION_STORM_MAX_SKIPPED_USAGE = 5;

export interface CompactionStormDecision {
  /** 达到连续无效次数, 应当熔断。 */
  escalate: boolean;
  /** 当前连续无效压缩次数。 */
  ineffectiveCount: number;
  /** 本次压缩后的上下文水位 (input tokens)。 */
  contextTokens: number;
  /** 同一次压缩之前那条水位, 供诊断与日志。 */
  preCompactionTokens: number;
  /** 首次无效压缩至今的时长, 供诊断消息与日志。 */
  elapsedMs: number;
}

/**
 * 压缩不收敛跟踪器。
 *
 * 时序 (实测 rollout 019fcd52, 每一轮都长这样):
 *   … → usage(压缩前最后一条 = pre) → contextCompaction → usage(0) [× 1~2]
 *     → usage(压缩后第一个正常请求 = post) → …
 * 所以 noteCompaction 只是冻结 pre 并置「找 post」标志, 判定发生在拿到 post 时。
 *
 * **不按 turn 记账**: 实测那 8 次压缩跨了两个 turn, 病因却是会话级的 (窗口失配)。
 * 按 turn 清零会把一次连续风暴拆成两段、双双够不到阈值。清零只发生在两处 —— 一次
 * 有效压缩 (说明压缩机制仍在起作用), 或用户发来新消息 (每条消息各给一次完整的
 * 判定机会, 而不是一朝熔断整个会话再不判定)。
 */
export class CompactionStormTracker {
  /** 最近一条有效 usage —— 下一次压缩的 pre。 */
  private lastUsageTokens: number | null = null;
  /** 正在找 post 时, 冻结下来的这一次压缩的 pre。 */
  private pendingPre: number | null = null;
  private awaitingPost = false;
  private skippedSinceCompaction = 0;
  private ineffectiveCount = 0;
  private firstIneffectiveAt = 0;

  /** 收到 contextCompaction 边界: 冻结 pre, 开始找压缩后的第一条有效水位。 */
  noteCompaction(): void {
    this.pendingPre = this.lastUsageTokens;
    this.awaitingPost = true;
    this.skippedSinceCompaction = 0;
  }

  /**
   * 喂入一条 usage。
   *
   * `contextTokens` 必须传 `tokenUsage.last.inputTokens`, 也就是**本次 API 请求的
   * 完整 prompt token 数** —— 它就是该次请求的绝对上下文水位, 正是判据要比的东西。
   * protocol.ts 把 `last` 描述成「上次 turn 的增量」, 那指的是相对 `total` 累计的
   * 本次增量, 不是"上下文水位的增量"; 两条实测证据 (rollout 019fcd52):
   *   - `total[n] - total[n-1] === last[n]` 精确成立 → total 是 last 的累加;
   *   - `cached[n] ≈ last[n-1]` (28288 vs 28610 / 39552 vs 39722 / 76416 vs 76963)
   *     → 本次 prompt 的前一大段命中上次请求建立的 cache, 这只有在 last 是**完整
   *     prompt 量**时才成立; 若 last 只是"比上次多出来的部分", cached 不可能等于
   *     上一条的完整 input。
   * 传 `total` 会拿到单调累加的天文数字, 判据直接失效 —— 见同名单测。
   *
   * 返回 null 表示这条 usage 不参与判定。
   */
  noteUsage(contextTokens: number, now: number): CompactionStormDecision | null {
    const valid = Number.isFinite(contextTokens) && contextTokens > 0;
    if (!valid) {
      // 压缩完成标记 (0) 与异常值都走这里。**不消费边界** —— 否则实测那条紧跟
      // 压缩的 0 会把真正的 post 挤掉, 熔断永远读不到数据。但要有界, 见常量注释。
      if (this.awaitingPost) {
        this.skippedSinceCompaction += 1;
        if (this.skippedSinceCompaction > COMPACTION_STORM_MAX_SKIPPED_USAGE) {
          this.awaitingPost = false;
          this.pendingPre = null;
        }
      }
      return null;
    }

    if (!this.awaitingPost) {
      // turn 中途的常规 usage: 只更新 pre 候选, 不参与判定。
      this.lastUsageTokens = contextTokens;
      return null;
    }

    // 这是压缩后的第一条有效水位 = post。
    this.awaitingPost = false;
    const pre = this.pendingPre;
    this.pendingPre = null;
    this.lastUsageTokens = contextTokens;
    // 压缩前没有可比的水位 (会话刚起就压缩) —— 只记基线, 不判定。
    if (pre === null || pre <= 0) return null;

    const effective = contextTokens < pre * COMPACTION_STORM_EFFECTIVE_DROP_RATIO;
    if (effective) {
      this.ineffectiveCount = 0;
      this.firstIneffectiveAt = 0;
      return null;
    }

    if (this.ineffectiveCount === 0) this.firstIneffectiveAt = now;
    this.ineffectiveCount += 1;
    return {
      escalate: this.ineffectiveCount >= COMPACTION_STORM_MAX_INEFFECTIVE,
      ineffectiveCount: this.ineffectiveCount,
      contextTokens,
      preCompactionTokens: pre,
      elapsedMs: now - this.firstIneffectiveAt,
    };
  }

  /** 用户发来新消息 / session 复位时清零。 */
  reset(): void {
    this.lastUsageTokens = null;
    this.pendingPre = null;
    this.awaitingPost = false;
    this.skippedSinceCompaction = 0;
    this.ineffectiveCount = 0;
    this.firstIneffectiveAt = 0;
  }
}

/**
 * 熔断的稳定 reason key —— **按有没有切模型证据分成两个**。
 *
 * renderer 侧 `ERROR_REASON_I18N_KEYS[reason]` 的本地化文案会**完全覆盖**下面合成的
 * message (`displayError = errorReasonI18nKey ? t(key) : error`), 所以 reason 决定了
 * 用户实际看到的那句话。只用一个 reason 时, 那条文案要么无条件断言「通常由切模型
 * 引起、请切回原模型」—— 对没切过模型 (或 A→B→A 已经切回去) 的用户就是没有证据的
 * 误导, 而且"切回原模型"根本无从执行; 要么退回不痛不痒的通用话术, 又浪费了我们确实
 * 掌握的切换证据。拆成两个 reason 让本地化文案跟证据走。
 *
 * 默认那个 (`…NOT_CONVERGING`) 刻意留给**通用**语义: 万一以后有人漏了映射或走了
 * 没预料到的路径, 落到不猜原因的文案是安全的, 落到断言切模型的文案是有害的。
 */
export const COMPACTION_STORM_REASON = 'codex_compaction_not_converging';
export const COMPACTION_STORM_REASON_MODEL_SWITCH =
  'codex_compaction_not_converging_model_switch';

export interface CompactionStormTerminalError {
  /** 稳定 reason key, 供 renderer 映射本地化文案。 */
  reason: string;
  /** 英文兜底 message, 给非 renderer 消费方 (IM / orca / 日志)。 */
  message: string;
}

/**
 * 合成熔断的终态错误 —— **reason 与 message 一起产出**。
 *
 * 两者必须同源: 它们描述的是同一件事的两种呈现 (本地化 UI 与英文兜底), 分开算就会
 * 出现"reason 说因为切模型、message 说不知道原因"这种自相矛盾, 而且因为 renderer
 * 用 reason 覆盖 message, 分叉后错的那一半恰好是用户唯一看得到的那半。
 *
 * 带上 `switchedModel` 时点名切模型 —— 那是实测唯一已知的触发路径, 也是用户唯一
 * 能自己动手解决的 (切回去 / 新开任务)。拿不到切换记录时只陈述观测到的现象, 不猜
 * 原因: 报错指错方向比不指方向更浪费用户时间。
 */
export function buildCompactionStormTerminalError(opts: {
  ineffectiveCount: number;
  contextTokens: number;
  elapsedMs: number;
  switchedModel?: { from: string; to: string } | null;
}): CompactionStormTerminalError {
  const elapsedS = Math.round(opts.elapsedMs / 1000);
  const head =
    `Codex kept compacting the context without making progress — ` +
    `${opts.ineffectiveCount} compactions over ${elapsedS}s, each leaving about ` +
    `${opts.contextTokens} input tokens behind, so compaction cannot recover this turn. ` +
    `It was interrupted automatically to stop the loop.`;
  if (opts.switchedModel) {
    return {
      reason: COMPACTION_STORM_REASON_MODEL_SWITCH,
      message:
        `${head}\nThis session switched model from "${opts.switchedModel.from}" to ` +
        `"${opts.switchedModel.to}" mid-conversation, and Codex keeps evaluating the ` +
        `context limit against the previous model's window. Switch back to ` +
        `"${opts.switchedModel.from}" to continue here, or start a new task with ` +
        `"${opts.switchedModel.to}".`,
    };
  }
  return {
    reason: COMPACTION_STORM_REASON,
    message:
      `${head}\nThe bulk of the context is the system prompt and tool definitions, ` +
      `which compaction cannot shrink. Start a new task to continue.`,
  };
}
