/**
 * 任务级工作上下文预算（session context window budget）—— 跨 main / renderer 的共享契约。
 *
 * 语义：用户在**单个任务**上显式选择的上下文窗口（tokens，分母），与全局的
 * 「自动压缩阈值百分比」（分子/触发点，`compaction-settings-store`）正交：
 *   - 预算决定「这个任务最多用多大窗口」，分档计费模型据此落在不同价带；
 *   - 百分比决定「在窗口的哪一点压缩」。
 *
 * 约束（与 `model-context-limit-store` 同一口径）：
 *   - 预算可以低于模型路由默认（更省），也可以在目录声明的物理上限内提高；
 *   - **绝不越过目录声明的 `contextWindowMax`**，也不越过用户在同一路由上设过的
 *     模型级「上下文上限」（两者取更紧者，见 `maker-host/model-context-settings.ts`）；
 *   - NULL / undefined = 未自定义，跟随模型路由默认（老任务零影响）。
 *
 * 本模块只做取值合法性收敛与档位推导，不读取目录、不读 DB。
 */

/** 低于这个数压缩会在第一条消息就触发，等于让任务不可用 —— 视为误输入。 */
export const MIN_CONTEXT_WINDOW_BUDGET = 1_000;
/** 只挡量级荒谬的值；物理上限由目录与模型级上限负责，不在这里拦。 */
export const MAX_CONTEXT_WINDOW_BUDGET = 100_000_000;

/** 把任意输入收敛成合法预算；非法（负值 / NaN / 过小 / 非数字）返回 null = 跟随默认。 */
export function normalizeContextWindowBudget(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < MIN_CONTEXT_WINDOW_BUDGET) return null;
  return Math.min(MAX_CONTEXT_WINDOW_BUDGET, rounded);
}

/**
 * 比例档的可见下限：占模型上限 25%/50%/100% 的档位低于它就不值得再调小
 * （256K 级窗口只给「模型默认」一档，512K 级只给「默认 + 50%」）。
 *
 * 取 200K 而不是 256K：1M 级窗口的 25% 是 250K、980K 级的是 246~248K，
 * 阈值卡在 250K/256K 会让「≈1M」这一带出现有的模型有 25% 档、有的没有；
 * 200K 让 800K 以上的窗口行为一致，同时仍把 512K/256K 级挡在门外。
 */
export const MIN_PERCENT_TIER_TOKENS = 200_000;

/**
 * 比例档的百分比（以**有效上限**为基准，不是以默认窗口为基准）。
 * 100% 档只在「有效上限 > 默认窗口」时才有意义（否则它就是默认档）。
 */
const TIER_PERCENTS: readonly number[] = [25, 50, 100];

/** 档位最多三项（默认档 + 最多两个比例档）：超出时优先保留**大比例**。 */
const MAX_PERCENT_TIERS = 2;

export interface ContextWindowBudgetOption {
  /** 选择该档后任务使用的工作窗口（tokens）；比例档是**精确**的百分比值，不取整到网格。 */
  tokens: number;
  /**
   * `default` = 模型路由默认（选中时上报 null = 跟随目录，不要快照当前值）；
   * `percent` = 占**模型有效上限** 25% / 50% / 100% 的档；
   * `current` = 已存值不在档位集合里时补的“当前档”（单选组需要匹配项）。
   */
  kind: 'default' | 'percent' | 'current';
}

export interface BuildContextWindowBudgetOptionsInput {
  /** 目录里该路由的默认工作窗口（`CatalogModel.contextWindow`）。 */
  defaultWindow: number | null | undefined;
  /** 目录里该路由的物理上限（`CatalogModel.contextWindowMax`）。未知时传 undefined。 */
  maxWindow?: number | null;
  /** 用户在同一路由上设过的模型级上限；设置后它可能比物理上限更紧。 */
  modelLimit?: number | null;
}

/**
 * 档位的**基准**（百分比分母）= `min(目录物理上限, 模型级上限)`；
 * 两者都缺省时退回目录默认窗口（只可能更保守，不会凭空造出高过默认值的选择）。
 * 返回 null = 连默认窗口都拿不到（调用方不要渲染档位表）。
 */
export function resolveContextWindowBudgetBase(
  input: BuildContextWindowBudgetOptionsInput,
): number | null {
  const positive = (value: number | null | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  const ceilings = [positive(input.maxWindow), positive(input.modelLimit)]
    .filter((value): value is number => value !== null);
  const ceiling = ceilings.length > 0 ? Math.min(...ceilings) : null;
  return ceiling ?? positive(input.defaultWindow);
}

/**
 * 档位占基准的百分比（四舍五入到整数，`1000000 → 100`）：展示层用它给**每一行**（含「模型默认」
 * 与旧值补的「当前档」）算出同一个位置上的百分比，行的形态才统一（不再「默认档绝对值在前、
 * 比例档百分比在前」）。基准未知（null/0/非法）返回 null = 该行只显示绝对值。
 */
export function contextWindowBudgetTierPercent(
  tokens: number,
  base: number | null | undefined,
): number | null {
  if (typeof base !== 'number' || !Number.isFinite(base) || base <= 0) return null;
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  return Math.round((tokens / base) * 100);
}

/**
 * 生成可选档位：**模型默认档 + 占有效上限 25%/50%/100% 的比例档**（最多三档）。
 *
 * - 基准 = `min(目录物理上限, 模型级上限)`；两者都缺省时退回目录默认窗口
 *   （此时比例档至多是默认窗口的份额，不会造出「高过默认值」的选择）。
 * - 比例档值 = `round(基准 × 百分比)`：**精确换算、不贴到 K 网格**；值低于
 *   `MIN_PERCENT_TIER_TOKENS` 或与默认档重合的不出现。
 * - 档数上限 3：比例档超过两个时优先保留大比例（100% → 50% → 25%）。
 * - 结果按 tokens 升序；等于路由默认的档标为 `default`，选中它应上报 null。
 */
export function buildContextWindowBudgetOptions(
  input: BuildContextWindowBudgetOptionsInput,
): ContextWindowBudgetOption[] {
  const positive = (value: number | null | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  const defaultWindow = positive(input.defaultWindow);
  if (defaultWindow === null && positive(input.maxWindow) === null && positive(input.modelLimit) === null) {
    return [];
  }

  const base = resolveContextWindowBudgetBase(input);
  if (base === null) return [];

  const percentTiers: ContextWindowBudgetOption[] = [];
  for (const percent of TIER_PERCENTS) {
    const tokens = Math.round((base * percent) / 100);
    if (tokens < MIN_PERCENT_TIER_TOKENS) continue;
    if (tokens > base) continue;
    // 与默认档重合时不单列（默认档更强：选中它 = 跟随目录）。
    if (defaultWindow !== null && tokens === defaultWindow) continue;
    percentTiers.push({ tokens, kind: 'percent' });
  }
  // 档数上限：优先保留大比例（100% → 50% → 25%）。
  const picked = percentTiers.slice(-MAX_PERCENT_TIERS);

  const options = new Map<number, ContextWindowBudgetOption>();
  for (const option of picked) options.set(option.tokens, option);
  if (defaultWindow !== null) options.set(defaultWindow, { tokens: defaultWindow, kind: 'default' });

  return [...options.values()].sort((a, b) => a.tokens - b.tokens);
}
