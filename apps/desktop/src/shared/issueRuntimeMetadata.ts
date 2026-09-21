export type IssueAgentKind = 'claude-code' | 'codex' | 'pi';

export type IssueHarness = 'Claude Code' | 'Codex' | 'Pi';

const ISSUE_HARNESS_BY_AGENT_KIND: Record<IssueAgentKind, IssueHarness> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
};

export const ISSUE_MODEL_ID_MAX = 200;

export function issueHarnessForAgentKind(agentKind: IssueAgentKind): IssueHarness {
  return ISSUE_HARNESS_BY_AGENT_KIND[agentKind];
}

export function parseIssueHarness(value: unknown): IssueHarness | undefined {
  return value === 'Claude Code' || value === 'Codex' || value === 'Pi' ? value : undefined;
}

/** Keep a custom model ID safe for a single Markdown environment line and the confirmation UI. */
export function normalizeIssueModelId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/\s+/g, ' ').slice(0, ISSUE_MODEL_ID_MAX).trim();
  return normalized || undefined;
}
