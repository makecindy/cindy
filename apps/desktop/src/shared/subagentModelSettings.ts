/**
 * Cindy 托管的子代理模型覆盖。
 *
 * `null` 表示不指定，agent 必须保留其原生子代理模型选择逻辑。
 * Codex 字段先保留在稳定契约中；当前 Codex 二进制尚不能在完整上下文 fork 下安全覆盖模型。
 *
 * `*ProviderId` 是标准模型选择面板的「来源」维度（2026-07 用户定稿基准：全软件一个
 * 模型选择面板，处处同行为）。它是纯客户端偏好：派发通道（CLAUDE_CODE_SUBAGENT_MODEL）
 * 只带模型 id；订阅前缀模型（chatgpt/ / xai/）由 loopback proxy 按 model 前缀
 * per-request 路由到订阅，其余模型跟随会话自身路由。providerId 用于选择器按来源选
 * 模型与回显真实来源，不改写子代理请求的凭证路由。
 */
export interface SubagentModelSettings {
  claudeCode: string | null;
  claudeCodeProviderId: string | null;
  codex: string | null;
  codexProviderId: string | null;
}

export type SubagentModelSettingsPatch = Partial<SubagentModelSettings>;

export interface SubagentModelSettingsState extends SubagentModelSettings {
  isCustomized: boolean;
  customizedKeys: string[];
  defaults: SubagentModelSettings;
}

export const SUBAGENT_MODEL_SETTINGS_DEFAULTS: SubagentModelSettings = {
  claudeCode: null,
  claudeCodeProviderId: null,
  codex: null,
  codexProviderId: null,
};

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
