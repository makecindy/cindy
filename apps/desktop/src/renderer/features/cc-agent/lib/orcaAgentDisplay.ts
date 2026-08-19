export type OrcaDisplayAgentKind = 'claude-code' | 'codex' | 'pi' | 'kimi-code';
export type OrcaDisplayVendor = 'cc' | 'codex' | 'pi' | 'kimi';

export function normalizeOrcaDisplayAgentKind(agentKind: unknown): OrcaDisplayAgentKind {
  if (agentKind === 'codex') return 'codex';
  if (agentKind === 'pi') return 'pi';
  if (agentKind === 'kimi' || agentKind === 'kimi-code') return 'kimi-code';
  if (agentKind === 'cc' || agentKind === 'claude-code') return 'claude-code';
  return 'claude-code';
}

export function orcaAgentLabel(agentKind: OrcaDisplayAgentKind): string {
  return agentKind === 'codex' ? 'Codex' : agentKind === 'pi' ? 'Pi' : agentKind === 'kimi-code' ? 'Kimi' : 'Claude';
}

export function orcaVendorForAgentKind(agentKind: OrcaDisplayAgentKind): OrcaDisplayVendor {
  return agentKind === 'codex' ? 'codex' : agentKind === 'pi' ? 'pi' : agentKind === 'kimi-code' ? 'kimi' : 'cc';
}
