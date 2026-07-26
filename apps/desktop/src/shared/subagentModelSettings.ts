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
 * patch 配对一致性:显式清除某个模型时,同 patch 强制清除对应来源。
 * 来源依附于模型才有语义;不归一会允许写入「claudeCode=null 但 providerId 非空」的
 * 孤儿状态并被 override store 持久化到磁盘(copilot review)。UI 已原子清除,
 * 这里是 IPC 契约边界的兜底。
 */
export function reconcileSubagentModelSettingsPatch(
  patch: SubagentModelSettingsPatch,
): SubagentModelSettingsPatch {
  const next = { ...patch };
  if (next.claudeCode === null) next.claudeCodeProviderId = null;
  if (next.codex === null) next.codexProviderId = null;
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
