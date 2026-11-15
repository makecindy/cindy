/**
 * 供应商「运行于」(同账号借用已登录的供应商)：同一个供应商在几台自己的电脑上都能用时，只按一处运行，
 * 设置页与模型列表都只显示一项。
 *
 * 默认：这台电脑能用就在本机；用不了时用一台在线、已开放这个供应商的电脑。用户在供应商页改选后，
 * 主进程按供应商记下 `runLocation`(deviceId 或 'local')；改选的电脑此刻不在可用名单里时按默认处理，
 * 不让一台离线的电脑把整项供应商藏起来。
 */
export const RUN_LOCATION_LOCAL = 'local';

/** 同账号另一台电脑，提供了这个供应商且对本机开放。 */
export interface RunLocationCandidate {
  deviceId: string;
  name: string;
}

export interface RunLocationProvider {
  connected?: boolean;
  suspended?: boolean;
  runLocation?: string;
}

/** 本机或某台电脑的 deviceId。 */
export function effectiveRunLocation(provider: RunLocationProvider, candidates: readonly RunLocationCandidate[]): string {
  const pinned = provider.runLocation;
  if (pinned === RUN_LOCATION_LOCAL) return RUN_LOCATION_LOCAL;
  if (pinned && candidates.some((candidate) => candidate.deviceId === pinned)) return pinned;
  if (provider.connected && !provider.suspended) return RUN_LOCATION_LOCAL;
  return candidates[0]?.deviceId ?? RUN_LOCATION_LOCAL;
}

/** 这台电脑的供应商是因为本机用不了才借用另一台(而不是用户特意改选)。 */
export function isBorrowingByDefault(provider: RunLocationProvider, candidates: readonly RunLocationCandidate[]): boolean {
  return !(provider.connected && !provider.suspended)
    && provider.runLocation !== RUN_LOCATION_LOCAL
    && effectiveRunLocation(provider, candidates) !== RUN_LOCATION_LOCAL;
}
