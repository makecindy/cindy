/**
 * Cindy 托管的 Subagent 设置。
 *
 * 派发通道按 agent 分两条：
 * - Claude Code：env `CLAUDE_CODE_SUBAGENT_MODEL`，每会话独立 spawn，新会话即生效。
 * - Codex：默认完全保留 Codex 原生的 Subagent 调配；只有用户显式开启「智能调配」时，
 *   Cindy 才扩展可供 spawn_agent 选择的模型目录，并按每个子线程实际请求的模型路由。
 *   本地 codex app-server 跨会话共享，变更经 DeferredCodexRestartService 在全部本地
 *   Codex 会话空闲后重启生效；remote 会话不注入。
 *
 * `claudeCodeProviderId` 是 Claude Code 标准模型选择面板的来源维度。
 *
 * 旧版 Codex 固定模型、固定来源、固定 effort 与护栏字段不再属于有效设置协议。读取旧
 * 文件时会忽略并迁移掉这些键，避免已经废弃的配置继续暗中改变 Codex 原生行为。
 */
export interface SubagentModelSettings {
  claudeCode: string | null;
  claudeCodeProviderId: string | null;
  /** false = Codex 原生 Sol/Terra 调配；true = Cindy 扩展可用模型并按实际选择路由。 */
  codexSmartSubagentRouting: boolean;
}

/** Codex Subagent 卡片可展示的 reasoning effort。 */
export const CODEX_SUBAGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

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
  codexSmartSubagentRouting: false,
};

/** 设置 UI 的 Claude Code 模型行键组。 */
export const CLAUDE_SUBAGENT_MODEL_KEYS = [
  'claudeCode',
  'claudeCodeProviderId',
] as const satisfies readonly (keyof SubagentModelSettings)[];

/** 设置 UI 的 Codex 模型行键组。 */
export const CODEX_SUBAGENT_MODEL_KEYS = [
  'codexSmartSubagentRouting',
] as const satisfies readonly (keyof SubagentModelSettings)[];

/** 设置 UI 的「Subagent 模型」卡片全部键组。 */
export const SUBAGENT_MODEL_CARD_KEYS = [
  ...CLAUDE_SUBAGENT_MODEL_KEYS,
  ...CODEX_SUBAGENT_MODEL_KEYS,
] as const satisfies readonly (keyof SubagentModelSettings)[];

/**
 * 影响 Codex spawn 智能目录注入的键。claude* 走 env 通道，不在此列表内。
 */
export const CODEX_SPAWN_AFFECTING_KEYS = [
  'codexSmartSubagentRouting',
] as const satisfies readonly (keyof SubagentModelSettings)[];

/** 两份设置在 codex spawn 注入维度上是否有差异（决定是否需要重启 codex app-server）。 */
export function codexSpawnConfigChanged(
  a: SubagentModelSettings,
  b: SubagentModelSettings,
): boolean {
  return CODEX_SPAWN_AFFECTING_KEYS.some((key) => a[key] !== b[key]);
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
 */
export function reconcileSubagentModelSettingsPatch(
  patch: SubagentModelSettingsPatch,
  current: SubagentModelSettings,
): SubagentModelSettingsPatch {
  const next = { ...patch };
  const clearOrphan = () => {
    const modelKey = 'claudeCode' as const;
    const providerKey = 'claudeCodeProviderId' as const;
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
  clearOrphan();
  return next;
}

/** IPC 边界的严格校验；空字符串与 null 都表示“不指定”。providerId 字段共用本校验。 */
export function isValidSubagentModelIdInput(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  return trimmed.length <= MAX_SUBAGENT_MODEL_ID_LENGTH && !containsControlCharacter(trimmed);
}
