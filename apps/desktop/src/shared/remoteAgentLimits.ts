/** 提供方整台电脑的远程任务额度；包含空闲但尚未释放的运行实例。 */
export interface RemoteAgentLimits {
  perDevice: number;
  total: number;
}

// maxRuns 的旧版解析上限为 1000，保持 wire 兼容。
export const REMOTE_AGENT_LIMIT_MAX = 1000;
export const DEFAULT_REMOTE_AGENT_LIMITS: Readonly<RemoteAgentLimits> = { perDevice: 16, total: 64 };

export function isRemoteAgentLimits(value: unknown): value is RemoteAgentLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as RemoteAgentLimits;
  return Number.isInteger(v.perDevice) && Number.isInteger(v.total)
    && v.perDevice >= 1 && v.perDevice <= v.total && v.total <= REMOTE_AGENT_LIMIT_MAX;
}

/** 仅接收用户编辑过的字段；合并后的大小关系由写入端在锁内校验。 */
export function isRemoteAgentLimitsPatch(value: unknown): value is Partial<RemoteAgentLimits> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([key, limit]) =>
    (key === 'perDevice' || key === 'total')
    && Number.isInteger(limit) && limit >= 1 && limit <= REMOTE_AGENT_LIMIT_MAX);
}

export interface RemoteAgentLimitUsage {
  total: number;
  devices: number;
  largestDevice: number;
}

export interface RemoteAgentLimitsView {
  value: RemoteAgentLimits;
  defaults: RemoteAgentLimits;
  isCustomized: boolean;
  customizedKeys: string[];
  usage: RemoteAgentLimitUsage;
}

/** 继续使用旧版认识的 BUSY 错误码；原因标记经过 IPC / LAZY_CREATE_FAILED 包装后仍可识别。 */
export function remoteAgentLimitErrorKey(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string'
    ? error : (error as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return null;
  const reason = /\[REMOTE_AGENT_BUSY\] \[(DEVICE_LIMIT|TOTAL_LIMIT)\]/.exec(message)?.[1];
  return reason ? `chat.remoteError.REMOTE_AGENT_${reason}`
    : message.includes('[REMOTE_AGENT_BUSY]') ? 'chat.remoteError.REMOTE_AGENT_BUSY' : null;
}
