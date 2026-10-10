export type OrcaDisplayAgentKind = 'claude-code' | 'codex' | 'pi' | 'cursor';
export type OrcaDisplayVendor = 'cc' | 'codex' | 'pi' | 'cursor';

export function normalizeOrcaDisplayAgentKind(agentKind: unknown): OrcaDisplayAgentKind {
  if (agentKind === 'codex') return 'codex';
  if (agentKind === 'cursor') return 'cursor';
  if (agentKind === 'pi') return 'pi';
  if (agentKind === 'cc' || agentKind === 'claude-code') return 'claude-code';
  return 'claude-code';
}

export function orcaAgentLabel(agentKind: OrcaDisplayAgentKind): string {
  return agentKind === 'codex' ? 'Codex' : agentKind === 'cursor' ? 'Cursor' : agentKind === 'pi' ? 'Pi' : 'Claude';
}

export function orcaVendorForAgentKind(agentKind: OrcaDisplayAgentKind): OrcaDisplayVendor {
  return agentKind === 'codex' ? 'codex' : agentKind === 'cursor' ? 'cursor' : agentKind === 'pi' ? 'pi' : 'cc';
}
