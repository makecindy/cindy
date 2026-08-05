import type { TFunction } from 'i18next';

const STATUS_KEYS = new Map<string, string>([
  ['thinking', 'ccAgent.agentStatus.thinking'],
  ['generating', 'ccAgent.agentStatus.generating'],
  ['editing files', 'ccAgent.agentStatus.editingFiles'],
  ['searching web', 'ccAgent.agentStatus.searchingWeb'],
  ['generating image', 'ccAgent.agentStatus.generatingImage'],
  ['compacting', 'ccAgent.agentStatus.compacting'],
  ['spawning agent', 'ccAgent.agentStatus.spawningAgent'],
  ['done', 'ccAgent.agentStatus.done'],
  ['just wait', 'ccAgent.agentStatus.waiting'],
  ['working', 'ccAgent.agentStatus.working'],
  ['running', 'ccAgent.agentStatus.running'],
]);

const TURN_START_NAME_PATTERNS = [
  /^Nice day, (.+)!$/i,
  /^Hey (.+), here we go$/i,
  /^(.+), sit tight$/i,
  /^Crafting for (.+?)(?:\.{3}|…)$/i,
  /^(.+), on it$/i,
  /^Brewing magic for (.+?)(?:\.{3}|…)$/i,
  /^Take a breath, (.+)$/i,
  /^Let's go, (.+)!$/i,
  /^(.+), leave it to me$/i,
  /^Working on it, (.+)$/i,
];

function normalizeStaticStatus(status: string): string {
  return status
    .trim()
    .replace(/(?:\.{3}|…)$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Localizes Cindy-owned Agent status chrome while preserving vendor/tool names
 * and arbitrary status text verbatim. Raw terminal stdout/stderr never passes
 * through this helper.
 */
export function localizeAgentStatus(status: string, t: TFunction): string {
  const staticKey = STATUS_KEYS.get(normalizeStaticStatus(status));
  if (staticKey) return t(staticKey);

  const trimmedStatus = status.trim();
  const issueTip = trimmedStatus.match(/^(.+),试试 \/issue 给我们提反馈或建议$/);
  if (issueTip) {
    return t('ccAgent.agentStatus.issueTip', { name: issueTip[1] });
  }

  for (const pattern of TURN_START_NAME_PATTERNS) {
    const match = trimmedStatus.match(pattern);
    if (match) {
      return t('ccAgent.agentStatus.turnStart', { name: match[1], status: trimmedStatus });
    }
  }

  const runningTool = trimmedStatus.match(/^(.+?) running(?:\.{3}|…)$/i);
  if (runningTool) {
    return t('ccAgent.agentStatus.runningTool', { tool: runningTool[1] });
  }

  return status;
}
