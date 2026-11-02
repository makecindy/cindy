import type { PersonalRuleStatus } from '@cindy/mcps';
/** A local Desktop composer command. The Main process is the only authority for it. */
export type ApprovalRuleCommandRequest = {
  sessionId: string;
  text: string;
};

export type ApprovalRuleCommandResult =
  | { kind: 'status'; statuses: PersonalRuleStatus[] }
  | { kind: 'saved'; revision: number; ruleId: string; ruleIds?: string[]; clientId: string }
  | { kind: 'published'; revision: number; clientId: string }
  | { kind: 'unsupported'; reason: 'syntax' | 'context' | 'command'; clientId?: string }
  | { kind: 'error'; code: string };

/** Reserve only the complete command word; other slash commands retain their route. */
export function isApprovalRuleCommand(text: string): boolean {
  return /^\/approval-rule(?:\s|$)/.test(text);
}
