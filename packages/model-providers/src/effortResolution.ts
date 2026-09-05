/**
 * effortResolution —— 「选中模型 / 切换来源后应落到哪一档 effort」的纯逻辑(跨端共享)。
 *
 * 从 apps/desktop renderer 的 sourceSwitch.ts 原样下沉:桌面 ModelSelector / ChatInput 与
 * 手机版模型选择列表都要用同一套落档优先级,避免两端各写一套后口径发散(手机对齐桌面的
 * 「逻辑完全相同」承诺依赖这里的单一实现)。语义与函数签名保持与桌面历史版本逐字一致。
 *
 * 类型注:参数用 `string` 而非本包的 `Effort` 字面量联合 —— 桌面 renderer 的 Effort 就是
 * `string` 别名(userPreferences.types),catalog 侧才是严格联合;两端都要直接消费本函数,
 * 取二者的公共形状。运行时语义只依赖「候选值 ∈ efforts」的成员判断,与联合收窄无关。
 */

type Effort = string;

/**
 * 解析「选中某模型后应落到哪一档 effort」—— 纯函数,集中 effort 优先级策略。
 *
 * 优先级(高 → 低),每一档都要求候选值仍在 `efforts` 列表里(不同模型 effort 档不同,旧值可能非法):
 *   0. 模型无 effort 档(efforts 为空)→ 'low'(占位,UI 不显示 effort segmented)。
 *   1. preferred:切来源时由 resolveSourceSwitch 带回的落点 hint(目标来源 lastModel 的 effort)。
 *   2. providerEffort:调用方提供的模型预设(桌面端现为 (agent, model) 全局预设;参数名为兼容保留)。
 *   3. rememberedEffort:per-model 记忆(provider 无关,跨来源兜底;手机端无此存储,恒不传)。
 *   4. activeEffort:当前 effort 仍被目标模型支持 → 沿用(切模型时少打扰用户)。
 *   5. 模型默认 defaultEffort(仍需 ∈ efforts;非法/缺失时落 efforts 首档)。
 *
 * 注:之所以用代码而非 prompt 固化这套优先级(规则 9),是为了让「选回来恢复上次选择」可预测、
 * 可单测。本函数只负责「在给定 efforts 下挑哪一档」,模型 efforts 由调用方按 catalog 提供。
 */
export function resolveEffort(args: {
  efforts: readonly Effort[];
  defaultEffort: Effort | null;
  activeEffort: Effort;
  preferred?: Effort;
  providerEffort?: Effort;
  rememberedEffort?: Effort;
}): Effort {
  const { efforts, defaultEffort, activeEffort, preferred, providerEffort, rememberedEffort } = args;
  if (efforts.length === 0) return 'low';
  const ok = (e: Effort | undefined): e is Effort => !!e && efforts.includes(e);
  if (ok(preferred)) return preferred;
  if (ok(providerEffort)) return providerEffort;
  if (ok(rememberedEffort)) return rememberedEffort;
  if (efforts.includes(activeEffort)) return activeEffort;
  // defaultEffort 同样要求 ∈ efforts(catalog 病态数据防御):非法/缺失时落 efforts 首档,
  // efforts.length === 0 已在上方 early return,这里 efforts[0] 必然存在。
  if (ok(defaultEffort ?? undefined)) return defaultEffort as Effort;
  return efforts[0];
}

/**
 * 面板 / 收藏交出来的**显式档** vs 本端再查一遍目录。
 *
 * `resolveEffort` 在 efforts 为空时回落占位 `'low'`。那是「模型不可调档」的 UI 占位,
 * 不能拿来消化一次查找失败:统一选择器已经按目标引擎解析过这一档(收藏副本、行上
 * 显示的 high),本端若因 wire id 形态(Pi `grok-4.6` vs 订阅 `xai/grok-4.6`)查空,
 * 再走 `resolveEffort` 就会把用户点的 high 写成 low。
 *
 * 面板只在 `config.effort` 非空时才把档交出来(不可调档行传空串,进不了 requested),
 * 所以查空时信任 requested 不会给「真的没有档位的模型」塞一个假档。
 *
 * 目录非空且不含 requested → 不硬塞,回落 `resolveEffort`(目标引擎词表里没有这一档,
 * 例如 xhigh 落到只有 high 的模型)。
 */
export function resolveRequestedEffort(args: {
  requested?: Effort;
  efforts: readonly Effort[];
  defaultEffort: Effort | null;
  activeEffort: Effort;
  preferred?: Effort;
  providerEffort?: Effort;
  rememberedEffort?: Effort;
}): Effort {
  const { requested, efforts, ...rest } = args;
  if (requested && (efforts.length === 0 || efforts.includes(requested))) {
    return requested;
  }
  return resolveEffort({ efforts, ...rest });
}

/**
 * 点选时交给 SET_MODEL 的原子快照。
 *
 * `resolveEffort` 在无档模型上会给 UI 占位 `'low'`。那一档不能写进运行时:
 * 目录 `efforts` 为空的模型运行时语义是 `effort: null`,塞 low 会让胶囊显示
 * thinking low/high,实际模型却没有思考档。Fast 同样:不支持就必须是 false,
 * 不能把上一模型的插队状态带到新模型上。
 */
export function composeAtomicModelSelection(args: {
  efforts: readonly Effort[];
  effort: Effort;
  fastSupported: boolean;
  requestedFast: boolean;
}): { effort: Effort | null; fastMode: boolean } {
  return {
    effort: args.efforts.length === 0 ? null : args.effort,
    fastMode: args.fastSupported && args.requestedFast,
  };
}

/**
 * 意图期内改选模型/来源时,面板交出来的档 vs 旧意图档。
 *
 * ModelSelector 对无思考档的行传空串(`rowEffortOf ?? ''`)。空串是「目标明确没有可调档」,
 * 不能当成 falsy 再回落到旧意图的 high —— 否则会把目标不支持的档登记进意图、下次发送应用。
 * 调用方没给新档(`undefined`)时才继承旧意图。
 */
export function resolveIntentReselectEffort(
  selectedEffort: string | undefined,
  intentEffort?: string,
): string | undefined {
  if (typeof selectedEffort === 'string') {
    return selectedEffort || undefined;
  }
  return intentEffort || undefined;
}

/**
 * 「同模型只切来源」时落档。与 resolveEffort 的关键区别是没有 activeEffort 沿用档:
 * 有显式模型预设就按目标来源支持范围恢复;没有预设则回落模型默认,避免把当前会话 live 值
 * 意外写成全局默认。
 *
 * 优先级(高 → 低,每档都要求仍在 efforts 内):
 *   1. preferred:来源切换 hint(resolveSourceSwitch 带回的目标来源记忆档);当前 picker 行点击
 *      不传,保留以兼容未来带 hint 的调用方。
 *   2. providerEffort:调用方提供的模型预设(桌面端跨来源共享,再由 efforts 校验是否合法)。
 *   3. 模型默认 defaultEffort。
 *   4. efforts 首档。
 *   5. fallbackEffort:efforts 为空等极端兜底(通常 = 当前 activeEffort,该模型无 effort 档、UI 不显示)。
 */
export function resolveProviderSwitchEffort(args: {
  efforts: readonly Effort[];
  defaultEffort: Effort | null;
  providerEffort?: Effort;
  preferred?: Effort;
  fallbackEffort: Effort;
}): Effort {
  const { efforts, defaultEffort, providerEffort, preferred, fallbackEffort } = args;
  if (efforts.length === 0) return fallbackEffort;
  const ok = (e: Effort | undefined): e is Effort => !!e && efforts.includes(e);
  if (ok(preferred)) return preferred;
  if (ok(providerEffort)) return providerEffort;
  if (ok(defaultEffort ?? undefined)) return defaultEffort as Effort;
  return efforts[0];
}

/**
 * effort 全档位的**单一来源**(序即强弱序,低 → 高)。types.ts 的 `Effort` 字面量联合与此
 * 逐项对应,由下方类型级断言在包内锁死双向一致(改任一边不改另一边 → 编译失败)。
 * 历史上这份枚举在 imDefaultSettings / title-one-shot(EFFORT_RANK)/ active-catalog
 * (VALID_EFFORTS)等处有 6 份字面量副本,P2-P4 分期改为从这里派生。
 */
export const EFFORT_VALUES = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

// 类型级双向锁: EFFORT_VALUES ⊆ types.Effort 且 types.Effort ⊆ EFFORT_VALUES。
// (本文件的运行时 Effort 故意是 string 别名 —— 见文件头;锁只针对目录侧联合。)
type CatalogEffort = import('./types.js').Effort;
type _EffortValuesCoverUnion = CatalogEffort extends (typeof EFFORT_VALUES)[number]
  ? true
  : ['EFFORT_VALUES 缺少 types.Effort 的档位', CatalogEffort];
type _EffortValuesNoExtra = (typeof EFFORT_VALUES)[number] extends CatalogEffort
  ? true
  : ['EFFORT_VALUES 含 types.Effort 没有的档位'];
const _effortEnumLock: [_EffortValuesCoverUnion, _EffortValuesNoExtra] = [true, true];
void _effortEnumLock;

const EFFORT_ORDER: readonly Effort[] = EFFORT_VALUES;

/** effort 强弱序名次(低 → 高);未知档排在最高之上(保守不上调)。 */
export function effortRank(e: Effort): number {
  const i = EFFORT_ORDER.indexOf(e);
  return i === -1 ? EFFORT_ORDER.length : i;
}

/** 取一组 effort 里的最低档;空 → null。(title-one-shot 的 EFFORT_RANK/lowestEffort 收口。) */
export function lowestEffort(efforts: readonly Effort[]): Effort | null {
  if (!efforts.length) return null;
  // 线性取最小(严格小于:平级保留先出现者,与原 copy+稳定 sort 语义一致,省 O(n log n)+拷贝)。
  let best = efforts[0];
  for (const e of efforts) {
    if (effortRank(e) < effortRank(best)) best = e;
  }
  return best;
}

/**
 * 把请求的 effort clamp 到某模型「实际声明支持」的档位 —— 供**未门控入口**(定时任务
 * fire、跨 agent worker 创建等)在发到运行时前做安全 reconcile,避免把模型不支持的档
 * (如 gpt-5.5 + max/ultra)透给上游被拒(issue #456)。
 *
 * 口径与交互式 UI 一致:**模型已声明支持的档原样保留**(不降级 —— 保 issue #352「不静默
 * 降级用户在支持模型上的显式选择」);只有不受支持时才 clamp 到最高兼容档。
 *
 * 规则:
 *   - `effort` 为空(null/undefined/空串)→ 原样返回(调用方语义:留空 = 不改)。
 *   - `efforts` 空/缺失 → 原样返回(模型未声明 effort 门控,不动它,no-break)。
 *   - `effort ∈ efforts` → 原样(支持则不动)。
 *   - 否则 clamp 到「rank ≤ 请求档 的最高受支持档」。
 *   - 请求档低于全部受支持档 → 最低受支持档(floor;绝不上调,见下方注释)。
 */
export function clampEffortToSupported(
  effort: Effort | null | undefined,
  efforts: readonly Effort[] | undefined,
): Effort | null | undefined {
  // falsy(null / undefined / 空串)一律透传:空串不在 EFFORT_ORDER 内,若不在此拦下会被
  // 当成"未知档"(rank 最高)clamp 到模型最高受支持档 —— 与"留空 = 不改"的语义相反(#456 review)。
  if (!effort) return effort;
  if (!efforts || efforts.length === 0) return effort;
  if (efforts.includes(effort)) return effort;

  const wantRank = effortRank(effort);
  // 受支持档里挑「rank ≤ 请求档」的最高档(clamp down 到最高兼容档)。
  let best: Effort | undefined;
  let bestRank = -1;
  for (const e of efforts) {
    const r = effortRank(e);
    if (r <= wantRank && r > bestRank) {
      best = e;
      bestRank = r;
    }
  }
  if (best !== undefined) return best;

  // 请求档低于全部受支持档(如 minimal 落在只支持 low+ 的模型)→ clamp 到最低受支持档(floor)。
  // 绝不上调到模型默认:请求档比 floor 还低时上调 = 违背用户"尽量便宜"的意图,且会把存量
  // 定时任务里存的 minimal 静默升成 default(通常 high)—— codex 旧行为是 minimal→low,
  // reconcile 不该反而把它升级(#456 review)。
  let lowest: Effort = efforts[0];
  for (const e of efforts) {
    if (effortRank(e) < effortRank(lowest)) lowest = e;
  }
  return lowest;
}

/**
 * 跨引擎词表的「就近档」翻译 —— Orca lead → worker 语义(与 clampEffortToSupported 是
 * **两种并立的正当语义**,不是二选一):
 *
 *   - `clampEffortToSupported`(上方): **绝不上调**。用于「用户显式存过的档必须只降不升」的
 *     场景(定时任务省钱意图,issue #456)。
 *   - `nearestSupportedEffort`(本函数): **双向就近**。用于「把一个引擎的 effort 意图翻译到
 *     另一个引擎的词表」——GPT 的 xhigh ≈ Claude 的 max,lead 用 Claude(max)开 GPT worker 时
 *     落 xhigh 是翻译,不是降级;反向 xhigh→max 是**上调**,在这个语义里同样正确。
 *
 * 行为与 orcaWorkerCreationService.normalizeResolvedEffort 的非显式分支逐字节一致
 * (minimal→low、ultra→max→xhigh、max→xhigh、xhigh→max;命不中级联映射 → null,由调用方
 * 决定回落模型默认还是报错)。历史上这套级联只存在于 orca 一处且与 clamp 的方向"冲突",
 * 收口成有名字有测试的标准函数后,冲突变成两个可显式选择的语义。
 */
export function nearestSupportedEffort(
  effort: Effort,
  efforts: readonly Effort[],
): Effort | null {
  if (efforts.includes(effort)) return effort;
  if (effort === 'minimal' && efforts.includes('low')) return 'low';
  if (effort === 'ultra' && efforts.includes('max')) return 'max';
  // ultra 但模型无 max(只到 xhigh)时,级联到 xhigh,别掉回默认档丢掉最高兼容档。
  if (effort === 'ultra' && efforts.includes('xhigh')) return 'xhigh';
  if (effort === 'max' && efforts.includes('xhigh')) return 'xhigh';
  if (effort === 'xhigh' && efforts.includes('max')) return 'max';
  return null;
}

/**
 * 无人值守派发场景(IM 新会话 / hook 建会话 / mobile 草稿 reconcile)的「请求档 → 实际落档」
 * 统一回落链(2026-07 对抗审查两轮修正后的定稿)。
 *
 * 模型**有** effort 档时,链是唯一的一份(方向与 IM defaultSessionSettings.resolveEffort
 * 逐分支对齐 —— 初版曾把 override 排在 requested 之前,会让运营表压过用户显式选择;
 * override 是 requested 非法时的回落,不是覆盖):
 *
 *   1. 显式请求档 ∈ 支持档 → 用它(用户/协议显式意图最高);
 *   2. per-model override(如 IM_DEFAULT_EFFORT_OVERRIDES)∈ 支持档 → 用它;
 *   3. 模型默认档 ∈ 支持档 → 用它;
 *   4. 支持档首项。
 *
 * 模型**未知或无档**时,三份历史实现的行为是三种,且都是各自 wire 契约的一部分,
 * **不能拉平**,故显式参数化(`noEffortsBehavior`,默认最保守的 'fallback-only'):
 *   - 'fallback-only'    → 恒 noEffortFallback(hook defaults.ts: 无档就不传,显式档也不传
 *                          —— 模型不支持,传了会被上游拒);
 *   - 'requested-first'  → requested(truthy)|| noEffortFallback(IM resolveEffort 的
 *                          `requested || 'high'`: 目录暂缺时别丢用户选择);
 *   - 'override-first'   → override(truthy)|| noEffortFallback(IM getImDefaultEffortFor:
 *                          该场景 requested 恒空,元数据缺失时运营 override 仍生效)。
 */
export function reconcileInvocationEffort<TFallback extends Effort | null | undefined>(args: {
  requested: Effort | null | undefined;
  model: { efforts: readonly Effort[]; defaultEffort: Effort | null } | undefined;
  overrides?: Readonly<Partial<Record<string, Effort>>>;
  modelId?: string;
  noEffortFallback: TFallback;
  noEffortsBehavior?: 'fallback-only' | 'requested-first' | 'override-first';
}): Effort | TFallback {
  const { requested, model, overrides, modelId, noEffortFallback } = args;
  // Object.hasOwn: model id 可能来自用户可输入的自定义供应商('constructor' 等原型键
  // 会从 Object.prototype 取到函数)。原 IM 实现同病,标准化时一并修。
  const override =
    modelId !== undefined && overrides !== undefined && Object.hasOwn(overrides, modelId)
      ? overrides[modelId]
      : undefined;
  if (!model || model.efforts.length === 0) {
    const behavior = args.noEffortsBehavior ?? 'fallback-only';
    if (behavior === 'requested-first' && requested) return requested;
    if (behavior === 'override-first' && override) return override;
    return noEffortFallback;
  }
  const ok = (e: Effort | null | undefined): e is Effort => !!e && model.efforts.includes(e);
  if (ok(requested)) return requested;
  if (ok(override)) return override;
  if (ok(model.defaultEffort)) return model.defaultEffort;
  return model.efforts[0];
}
