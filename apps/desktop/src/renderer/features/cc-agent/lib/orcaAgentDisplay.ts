export type OrcaDisplayAgentKind = 'claude-code' | 'codex' | 'pi';
export type OrcaDisplayVendor = 'cc' | 'codex' | 'pi';

export function normalizeOrcaDisplayAgentKind(agentKind: unknown): OrcaDisplayAgentKind {
  if (agentKind === 'codex') return 'codex';
  if (agentKind === 'pi') return 'pi';
  if (agentKind === 'cc' || agentKind === 'claude-code') return 'claude-code';
  return 'claude-code';
}

export function orcaAgentLabel(agentKind: OrcaDisplayAgentKind): string {
  return agentKind === 'codex' ? 'Codex' : agentKind === 'pi' ? 'Pi' : 'Claude';
}

export function orcaVendorForAgentKind(agentKind: OrcaDisplayAgentKind): OrcaDisplayVendor {
  return agentKind === 'codex' ? 'codex' : agentKind === 'pi' ? 'pi' : 'cc';
}

/**
 * Lead pane label for any session agent. Orca's display kinds cover the three worker
 * engines; a Hermes lead (ROADMAP 3.7) is named as itself instead of falling back to Claude.
 */
export function orcaLeadAgentLabel(agentKind: unknown): string {
  if (agentKind === 'hermes') return 'Hermes';
  return orcaAgentLabel(normalizeOrcaDisplayAgentKind(agentKind));
}
