export type OrcaDisplayAgentKind = 'claude-code' | 'codex' | 'pi' | 'zcode';
export type OrcaDisplayVendor = 'cc' | 'codex' | 'pi' | 'zcode';

export function normalizeOrcaDisplayAgentKind(agentKind: unknown): OrcaDisplayAgentKind {
  if (agentKind === 'codex') return 'codex';
  if (agentKind === 'pi') return 'pi';
  if (agentKind === 'zcode') return 'zcode';
  if (agentKind === 'cc' || agentKind === 'claude-code') return 'claude-code';
  return 'claude-code';
}

export function orcaAgentLabel(agentKind: OrcaDisplayAgentKind): string {
  return agentKind === 'codex' ? 'Codex' : agentKind === 'pi' ? 'Pi' : agentKind === 'zcode' ? 'ZCode' : 'Claude';
}

export function orcaVendorForAgentKind(agentKind: OrcaDisplayAgentKind): OrcaDisplayVendor {
  return agentKind === 'codex' ? 'codex' : agentKind === 'pi' ? 'pi' : agentKind === 'zcode' ? 'zcode' : 'cc';
}
