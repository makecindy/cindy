export type OrcaDisplayAgentKind = 'claude-code' | 'codex';
export type OrcaDisplayVendor = 'cc' | 'codex';

export function normalizeOrcaDisplayAgentKind(agentKind: unknown): OrcaDisplayAgentKind {
  if (agentKind === 'codex') return 'codex';
  if (agentKind === 'cc' || agentKind === 'claude-code') return 'claude-code';
  return 'claude-code';
}

export function orcaAgentLabel(agentKind: OrcaDisplayAgentKind): string {
  return agentKind === 'codex' ? 'Codex' : 'Claude';
}

export function orcaVendorForAgentKind(agentKind: OrcaDisplayAgentKind): OrcaDisplayVendor {
  return agentKind === 'codex' ? 'codex' : 'cc';
}
