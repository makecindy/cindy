export interface AgentIslandNotificationPolicyConfig {
  notifyOrcaWorkerSessions: boolean;
}

export function shouldNotifyAgentIslandForSession(
  config: AgentIslandNotificationPolicyConfig,
  isOrcaWorkerSession: boolean,
): boolean {
  return config.notifyOrcaWorkerSessions || !isOrcaWorkerSession;
}

export function shouldClearAgentIslandSessionForOrcaWorker(
  config: AgentIslandNotificationPolicyConfig,
): boolean {
  return !config.notifyOrcaWorkerSessions;
}
