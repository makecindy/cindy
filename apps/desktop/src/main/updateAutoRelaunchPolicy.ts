import type { UpdateSystemIdleState } from './updateRelaunchSafety';

export const AUTO_UPDATE_IDLE_THRESHOLD_SECONDS = 10 * 60;
export const AUTO_UPDATE_RESUME_COOLDOWN_MS = 60 * 1000;
export const AUTO_UPDATE_BUSY_QUIET_PERIOD_MS = 60 * 1000;

export type AutoRelaunchBlockReason =
  | 'disabled'
  | 'dev'
  | 'not-ready'
  | 'relaunching'
  | 'busy'
  | 'recent-busy'
  | 'recent-resume'
  | 'user-active'
  | 'screen-state-unknown'
  | 'interactive-auth';

export interface AutoRelaunchReadinessInput {
  enabled: boolean;
  isDev: boolean;
  status: string;
  isRelaunching: boolean;
  hasBusyTasks: boolean;
  idleTimeSeconds: number;
  idleState: UpdateSystemIdleState;
  nowMs: number;
  lastBusyAtMs: number | null;
  lastResumeAtMs: number | null;
  idleThresholdSeconds?: number;
  busyQuietPeriodMs?: number;
  resumeCooldownMs?: number;
  /** Linux pkexec 需要用户在场输入密码，禁止无人值守 / 启动自动安装。 */
  requiresInteractiveAuth?: boolean;
}

export function getAutoRelaunchBlockReason(
  input: AutoRelaunchReadinessInput,
): AutoRelaunchBlockReason | null {
  const idleThresholdSeconds = input.idleThresholdSeconds ?? AUTO_UPDATE_IDLE_THRESHOLD_SECONDS;
  const busyQuietPeriodMs = input.busyQuietPeriodMs ?? AUTO_UPDATE_BUSY_QUIET_PERIOD_MS;
  const resumeCooldownMs = input.resumeCooldownMs ?? AUTO_UPDATE_RESUME_COOLDOWN_MS;

  if (!input.enabled) return 'disabled';
  if (input.requiresInteractiveAuth) return 'interactive-auth';
  if (input.isDev) return 'dev';
  if (input.status !== 'ready') return 'not-ready';
  if (input.isRelaunching) return 'relaunching';
  if (input.hasBusyTasks) return 'busy';
  if (input.lastBusyAtMs !== null && input.nowMs - input.lastBusyAtMs < busyQuietPeriodMs) {
    return 'recent-busy';
  }
  if (
    input.lastResumeAtMs !== null
    && input.nowMs - input.lastResumeAtMs < resumeCooldownMs
  ) {
    return 'recent-resume';
  }
  // A locked session is a valid unattended state. Only an unreadable state
  // fails closed; update-launched macOS windows recover presentation on unlock.
  if (input.idleState === 'unknown') return 'screen-state-unknown';
  if (input.idleState === 'active') return 'user-active';
  if (input.idleTimeSeconds < idleThresholdSeconds) return 'user-active';
  return null;
}
