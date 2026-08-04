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
 * 压缩后水位相对**上一次压缩后**水位至少要降到这个比例才算有效。
 *
 * 实测正常压缩 241972 → 30738 (降到 12.7%); 风暴期间连续 8 次压缩后的水位是
 * 326503 / 325868 / 325922 / 327909 / 326767 / 326827 / 326952 / 327383 —— 彼此
 * 相差不到 0.5%, 甚至还会涨。0.9 把这两类分得很开, 不需要精调。
 */
export const COMPACTION_STORM_EFFECTIVE_DROP_RATIO = 0.9;

export interface CompactionStormDecision {
  /** 达到连续无效次数, 应当熔断。 */
  escalate: boolean;
  /** 当前连续无效压缩次数。 */
  ineffectiveCount: number;
  /** 本次压缩后的上下文水位 (input tokens)。 */
  contextTokens: number;
  /** 首次无效压缩至今的时长, 供诊断消息与日志。 */
  elapsedMs: number;
}

/**
 * 压缩不收敛跟踪器。
 *
 * 时序: codex 先投 `contextCompaction` item (completed), 随后下一次请求的
 * `thread/tokenUsage/updated` 才报出压缩后的水位 —— 所以 noteCompaction 只置
 * 「等下一条 usage」的标志, 真正的判定发生在 noteUsage。
 *
 * **不按 turn 记账**: 实测那 8 次压缩跨了两个 turn, 病因却是会话级的 (窗口失配)。
 * 按 turn 清零会把一次连续风暴拆成两段、双双够不到阈值。清零只发生在两处 —— 一次
 * 有效压缩 (说明压缩机制仍在起作用), 或用户发来新消息 (每条消息各给一次完整的
 * 判定机会, 而不是一朝熔断整个会话再不判定)。
 */
export class CompactionStormTracker {
  private awaitingUsage = false;
  private lastPostCompactionTokens: number | null = null;
  private ineffectiveCount = 0;
  private firstIneffectiveAt = 0;

  /** 收到 contextCompaction 边界: 下一条 usage 就是压缩后的水位。 */
  noteCompaction(): void {
    this.awaitingUsage = true;
  }

  /**
   * 喂入一条 usage。只有紧跟压缩边界的那一条参与判定, 其余直接忽略 —— turn 中途
   * 的 usage 反映的是压缩后又累积上去的内容, 拿它比较会把正常增长误判成"没压动"。
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
    if (!this.awaitingUsage) return null;
    // **先消费 flag 再校验取值**: 压缩边界后的第一条 usage 无论有没有可用数字都
    // 已经"用掉"了这次机会。留着 flag 会让紧随其后的普通 usage(turn 中途累积上去
    // 的水位)被当成压缩后水位, 既可能凭空熔断, 也可能把真正的压后水位挤掉而漏判。
    this.awaitingUsage = false;
    if (!Number.isFinite(contextTokens) || contextTokens <= 0) return null;

    const previous = this.lastPostCompactionTokens;
    this.lastPostCompactionTokens = contextTokens;
    // 第一次压缩没有可比对象 —— 只记基线, 不判定。
    if (previous === null) return null;

    const effective = contextTokens < previous * COMPACTION_STORM_EFFECTIVE_DROP_RATIO;
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
      elapsedMs: now - this.firstIneffectiveAt,
    };
  }

  /** 用户发来新消息 / session 复位时清零。 */
  reset(): void {
    this.awaitingUsage = false;
    this.lastPostCompactionTokens = null;
    this.ineffectiveCount = 0;
    this.firstIneffectiveAt = 0;
  }
}

/**
 * 合成给用户的终态错误消息 (非 renderer 消费方的英文兜底; renderer 侧走
 * ERROR_REASON_I18N_KEYS 的本地化文案)。
 *
 * 带上 `switchedModel` 时点名切模型 —— 那是实测唯一已知的触发路径, 也是用户唯一
 * 能自己动手解决的 (切回去 / 新开任务)。拿不到切换记录时只陈述观测到的现象, 不猜
 * 原因: 报错指错方向比不指方向更浪费用户时间。
 */
export function buildCompactionStormMessage(opts: {
  ineffectiveCount: number;
  contextTokens: number;
  elapsedMs: number;
  switchedModel?: { from: string; to: string } | null;
}): string {
  const elapsedS = Math.round(opts.elapsedMs / 1000);
  const head =
    `Codex kept compacting the context without making progress — ` +
    `${opts.ineffectiveCount} compactions over ${elapsedS}s, each leaving about ` +
    `${opts.contextTokens} input tokens behind, so compaction cannot recover this turn. ` +
    `It was interrupted automatically to stop the loop.`;
  if (opts.switchedModel) {
    return (
      `${head}\nThis session switched model from "${opts.switchedModel.from}" to ` +
      `"${opts.switchedModel.to}" mid-conversation, and Codex keeps evaluating the ` +
      `context limit against the previous model's window. Switch back to ` +
      `"${opts.switchedModel.from}" to continue here, or start a new task with ` +
      `"${opts.switchedModel.to}".`
    );
  }
  return (
    `${head}\nThe bulk of the context is the system prompt and tool definitions, ` +
    `which compaction cannot shrink. Start a new task to continue.`
  );
}
