export type OrcaDisplayAgentKind = 'claude-code' | 'codex' | 'pi' | 'acp';
export type OrcaDisplayVendor = 'cc' | 'codex' | 'pi' | 'acp';

export function normalizeOrcaDisplayAgentKind(agentKind: unknown): OrcaDisplayAgentKind {
  if (agentKind === 'codex') return 'codex';
  if (agentKind === 'pi') return 'pi';
  if (agentKind === 'acp') return 'acp';
  if (agentKind === 'cc' || agentKind === 'claude-code') return 'claude-code';
  return 'claude-code';
}

export function orcaAgentLabel(agentKind: OrcaDisplayAgentKind, pluginEngineName?: string): string {
  if (agentKind === 'codex') return 'Codex';
  if (agentKind === 'pi') return 'Pi';
  if (agentKind === 'acp') return pluginEngineName?.trim() || 'Plugin';
  return 'Claude';
}

export function orcaVendorForAgentKind(agentKind: OrcaDisplayAgentKind): OrcaDisplayVendor {
  if (agentKind === 'codex') return 'codex';
  if (agentKind === 'pi') return 'pi';
  if (agentKind === 'acp') return 'acp';
  return 'cc';
}
