export interface AgentIslandNotificationPolicyConfig {
  notifyOrcaWorkerSessions: boolean;
}

export function shouldNotifyAgentIslandForSession(
  config: AgentIslandNotificationPolicyConfig,
  isOrcaWorkerSession: boolean,
): boolean {
  return config.notifyOrcaWorkerSessions || !isOrcaWorkerSession;
}
