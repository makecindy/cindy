/**
 * Cindy 托管的子代理模型覆盖与 Codex 子代理护栏。
 *
 * `null` 表示不指定，agent 必须保留其原生子代理模型选择逻辑。
 *
 * 派发通道按 agent 分两条：
 * - Claude Code：env `CLAUDE_CODE_SUBAGENT_MODEL`，每会话独立 spawn，新会话即生效。
 * - Codex：护栏仍通过 spawn 时 `-c agents.*` 注入；锁定模型、Provider 与 effort 由
 *   本地 Proxy 对已确认的子线程请求强制应用（见 maker-host/codex-subagent-config.ts）。
 *   本地 codex app-server 跨会话共享，变更经 DeferredCodexRestartService 在全部本地
 *   Codex 会话空闲后重启生效；remote 会话不注入。用户指定 Codex 模型后，它与 effort
 *   作为强制路由冻结在本地 Proxy：Codex 创建子线程时继承父模型，不接收 model/effort
 *   override，从而避开 spawn_agent 的目录白名单；真正请求只在已确认的子线程上改写。
 *
 * `*ProviderId` 是标准模型选择面板的「来源」维度（2026-07 用户定稿基准：全软件一个
 * 模型选择面板，处处同行为）。它是纯客户端偏好：派发通道只带模型 id；订阅前缀模型
 * （chatgpt/ / xai/）由 loopback proxy 按 model 前缀 per-request 路由到订阅，其余模型
 * 跟随会话自身路由。providerId 用于选择器按来源选模型与回显真实来源，不改写子代理
 * 请求的凭证路由。
 */
export interface SubagentModelSettings {
  claudeCode: string | null;
  claudeCodeProviderId: string | null;
  codex: string | null;
  codexProviderId: string | null;
  /** null = 锁定路由移除父线程继承的 effort，让目标模型使用默认档。 */
  codexEffort: CodexSubagentEffort | null;
  /** false → 注入 `-c agents.enabled=false`，对旧版多代理(V1)与 Sol/Terra(V2)都硬生效。 */
  codexSubagentsEnabled: boolean;
  /** false → 不注入 Cindy 的 multi-agent mode hint，保留 Codex 原生调度策略。 */
  codexUseCindySubagentPolicy: boolean;
  /** null = 跟随上游默认(V1=6 / V2=3 个子代理)；1..8 → 注入 max_concurrent_threads_per_session=N。 */
  codexMaxConcurrentSubagents: number | null;
  /** true → 注入 `-c agents.max_depth=2`。上游该键仅 V1 生效，V2 忽略（UI hint 已注明）。 */
  codexAllowNestedSubagents: boolean;
}

/**
 * 与 codex-model-discovery.ts 的 CODEX_EFFORTS 透传白名单一致（不含 minimal——codex
 * 运行时不透传 minimal）。某模型实际支持的子集由目录 efforts 决定，渲染层收窄。
 */
export const CODEX_SUBAGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type CodexSubagentEffort = (typeof CODEX_SUBAGENT_EFFORTS)[number];

export function isCodexSubagentEffort(value: unknown): value is CodexSubagentEffort {
  return (
    typeof value === 'string' && (CODEX_SUBAGENT_EFFORTS as readonly string[]).includes(value)
  );
}

/** 并发上限的合法区间。上游在 Ultra 档 + 并发 ≥8 时会警告，故上限取 8。 */
export const CODEX_SUBAGENT_CONCURRENCY_MIN = 1;
export const CODEX_SUBAGENT_CONCURRENCY_MAX = 8;
/** 开启自定义并发时的初始值（= V2 默认的 3 个并发子代理，V1 从 6 收紧）。 */
export const CODEX_SUBAGENT_CONCURRENCY_INITIAL = 3;

export type SubagentModelSettingsPatch = Partial<SubagentModelSettings>;

export interface SubagentModelSettingsState extends SubagentModelSettings {
  isCustomized: boolean;
  customizedKeys: string[];
  defaults: SubagentModelSettings;
}

/**
 * SET/RESET 的返回体。codexRestartDeferred=true 表示变更触及 codex spawn 注入键
 * 且本地 Codex 会话正忙:设置已落盘,重启已登记,待全部本地会话空闲后自动兑现
 * (UI 据此提示「运行中的 Codex 对话将在任务结束后应用」)。
 */
export type SubagentModelSettingsWriteResult = SubagentModelSettingsState & {
  codexRestartDeferred: boolean;
};

export const SUBAGENT_MODEL_SETTINGS_DEFAULTS: SubagentModelSettings = {
  claudeCode: null,
  claudeCodeProviderId: null,
  codex: null,
  codexProviderId: null,
  codexEffort: null,
  codexSubagentsEnabled: true,
  codexUseCindySubagentPolicy: true,
  codexMaxConcurrentSubagents: null,
  codexAllowNestedSubagents: false,
};

/** 设置 UI 的 Claude Code 模型行键组。 */
export const CLAUDE_SUBAGENT_MODEL_KEYS = [
  'claudeCode',
  'claudeCodeProviderId',
] as const satisfies readonly (keyof SubagentModelSettings)[];

/** 设置 UI 的 Codex 模型行键组。 */
export const CODEX_SUBAGENT_MODEL_KEYS = [
  'codex',
  'codexProviderId',
  'codexEffort',
] as const satisfies readonly (keyof SubagentModelSettings)[];

/** 设置 UI 的「Subagent 模型」卡片全部键组。 */
export const SUBAGENT_MODEL_CARD_KEYS = [
  ...CLAUDE_SUBAGENT_MODEL_KEYS,
  ...CODEX_SUBAGENT_MODEL_KEYS,
] as const satisfies readonly (keyof SubagentModelSettings)[];

/** 设置 UI 的「Codex 子代理护栏」卡片键组。 */
export const SUBAGENT_GUARDRAIL_KEYS = [
  'codexSubagentsEnabled',
  'codexUseCindySubagentPolicy',
  'codexMaxConcurrentSubagents',
  'codexAllowNestedSubagents',
] as const satisfies readonly (keyof SubagentModelSettings)[];

/**
 * 影响 Codex spawn `-c` 护栏或锁定 Subagent Proxy 路由的键。claude* 走 env 通道，
 * 不在此列表内；Codex 模型、Provider 或 effort 变化都需要重启共享的 app-server。
 */
export const CODEX_SPAWN_AFFECTING_KEYS = [
  'codex',
  'codexProviderId',
  'codexEffort',
  'codexSubagentsEnabled',
  'codexUseCindySubagentPolicy',
  'codexMaxConcurrentSubagents',
  'codexAllowNestedSubagents',
] as const satisfies readonly (keyof SubagentModelSettings)[];

/** 两份设置在 codex spawn 注入维度上是否有差异（决定是否需要重启 codex app-server）。 */
export function codexSpawnConfigChanged(
  a: SubagentModelSettings,
  b: SubagentModelSettings,
): boolean {
  return CODEX_SPAWN_AFFECTING_KEYS.some((key) => a[key] !== b[key]);
}

/** 磁盘读取的宽松归一化：round + clamp 到 [MIN, MAX]，非有限数回退「跟随上游默认」。 */
export function normalizeCodexSubagentConcurrency(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < CODEX_SUBAGENT_CONCURRENCY_MIN) return CODEX_SUBAGENT_CONCURRENCY_MIN;
  if (rounded > CODEX_SUBAGENT_CONCURRENCY_MAX) return CODEX_SUBAGENT_CONCURRENCY_MAX;
  return rounded;
}

/** IPC 边界的严格校验：null 或 [MIN, MAX] 内整数。clamp 事实源在 main store，这里不救。 */
export function isValidCodexSubagentConcurrencyInput(value: unknown): value is number | null {
  if (value === null) return true;
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= CODEX_SUBAGENT_CONCURRENCY_MIN &&
    value <= CODEX_SUBAGENT_CONCURRENCY_MAX
  );
}

export const MAX_SUBAGENT_MODEL_ID_LENGTH = 256;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

/** 磁盘读取的宽松归一化：非法值回退为“不指定”。providerId 与 model id 同约束，共用本函数。 */
export function normalizeSubagentModelId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SUBAGENT_MODEL_ID_LENGTH) return null;
  if (containsControlCharacter(trimmed)) return null;
  return trimmed;
}

/**
 * patch 配对一致性:按「patch 合并当前存储」后的有效模型判定 —— 有效模型为 null
 * (不指定)时,对应来源强制清为 null。来源依附于模型才有语义;不归一会允许两类
 * 孤儿写入被 override store 持久化到磁盘:同 patch 清模型但漏清来源(copilot
 * review),以及模型本就未指定时的 provider-only patch(codex review,会造成
 * 「显示不指定却 isCustomized=true」)。UI 已原子写,这里是 IPC 契约边界的兜底。
 *
 * codexEffort 有意不参与配对清理：没有指定模型时，它仍可作为上游原生隐藏配置单独
 * 注入；指定模型时则随冻结路由由 Proxy 强制应用。UI 侧选「不指定」会原子清
 * {codex, codexProviderId, codexEffort} 三键，不产生意外孤儿。护栏四键互相独立。
 */
export function reconcileSubagentModelSettingsPatch(
  patch: SubagentModelSettingsPatch,
  current: SubagentModelSettings,
): SubagentModelSettingsPatch {
  const next = { ...patch };
  const clearOrphan = (
    modelKey: 'claudeCode' | 'codex',
    providerKey: 'claudeCodeProviderId' | 'codexProviderId',
  ) => {
    const effectiveModel = next[modelKey] !== undefined ? next[modelKey] : current[modelKey];
    if (effectiveModel !== null) return;
    const effectiveProvider =
      next[providerKey] !== undefined ? next[providerKey] : current[providerKey];
    // 只在确有孤儿要清(有效来源非 null)或 patch 本就动了该 key 时写入,
    // 避免给无关 patch 添 key。
    if (effectiveProvider !== null || next[providerKey] !== undefined) {
      next[providerKey] = null;
    }
  };
  clearOrphan('claudeCode', 'claudeCodeProviderId');
  clearOrphan('codex', 'codexProviderId');
  return next;
}

/** IPC 边界的严格校验；空字符串与 null 都表示“不指定”。providerId 字段共用本校验。 */
export function isValidSubagentModelIdInput(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  return (
    trimmed.length <= MAX_SUBAGENT_MODEL_ID_LENGTH &&
    !containsControlCharacter(trimmed)
  );
}
